import { describe, expect, test } from "bun:test";
import {
  ContainerResponseSchema,
  IndexResponseSchema,
  ContainersResponseSchema,
  type ActionOutcome,
  type Cap,
  type Container,
  type IndexEntry,
} from "@manifold/protocol";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { silentLogger } from "../src/log.ts";
import { OUTSIDE_SCOPE_REFUSAL, type PluginHost } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore } from "./helpers.ts";

/**
 * THE WORKSPACE INDEX'S DOORS. Nine of them replaced four bespoke route families, and the
 * cases below are the ladder each one now answers through — rung by rung, in the order the
 * dispatcher evaluates them, because that order is the contract a client learned.
 *
 * Two things beyond the ladder are pinned here because they are the semantics a route
 * carried in its body and a plugin now owes explicitly:
 *
 *   - the SCOPE obligation. `read`, `listContainers`, `readContainer` and `renameContainer`
 *     are declared `scope: "container"` because the routes they replace were reachable by a
 *     container-scoped token, and conversion must never narrow who may call a door (ADR 0013
 *     §15). The rung proves the caller's caps hold for its OWN container; only the handler
 *     can prove the container NAMED in the arguments is that one, so every case that could
 *     reach past a scope is here.
 *   - the store's own guards, expressed as refusals rather than as HTTP codes: a folder
 *     delete moves children UP instead of cascading, a move into a folder's own descendant
 *     is refused, and retiring a container goes through the placement executor so nothing is
 *     left pointing at it.
 */

const OWNER_KEY = "d".repeat(64);

interface IndexFixture {
  readonly runtime: FakeRuntime;
  readonly store: ServerStore;
  readonly auth: AuthService;
  readonly owner: AuthContext;
  readonly host: PluginHost;
}

function fixture(): IndexFixture {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const auth = new AuthService(store, OWNER_KEY, runtime);
  const owner = auth.authenticate(OWNER_KEY);
  const rooms = new RoomManager(store, runtime, clock, silentLogger);
  const broker = new TerminalBroker(
    store,
    auth,
    rooms,
    runtime,
    clock,
    silentLogger,
    () => "http://localhost:7777",
  );
  rooms.setTerminalProvider((containerId) => broker.listForContainer(containerId));
  rooms.setPendingOpenProvider((containerId) => broker.hasPendingOpenForContainer(containerId));
  const host = testPluginHost(store, auth, rooms, broker, runtime);
  return { runtime, store, auth, owner, host };
}

/** A minted token, so authority is exercised through real attenuation. */
function context(base: IndexFixture, caps: readonly Cap[], containerId?: string): AuthContext {
  const grant = base.auth.mintToken(
    {
      principal: { name: "guest", kind: "human" },
      caps: [...caps],
      ...(containerId === undefined ? {} : { containerId }),
    },
    base.owner,
  );
  return base.auth.authenticate(grant.token);
}

function denial(outcome: ActionOutcome): { rule: string; message: string } {
  if (outcome.ok) throw new Error("expected a denial");
  return outcome.denial;
}

function result(outcome: ActionOutcome): unknown {
  if (!outcome.ok) throw new Error(`unexpected denial: ${outcome.denial.message}`);
  return outcome.result;
}

async function createContainer(
  base: IndexFixture,
  name: string,
  discipline?: "canvas" | "composition",
): Promise<Container> {
  const outcome = await base.host.dispatch(base.owner, "core.index.createContainer", {
    name,
    ...(discipline === undefined ? {} : { discipline }),
  });
  return ContainerResponseSchema.parse(result(outcome)).container;
}

async function createFolder(
  base: IndexFixture,
  name: string,
  parentId: string | null = null,
): Promise<Extract<IndexEntry, { kind: "folder" }>> {
  const outcome = await base.host.dispatch(base.owner, "core.index.createFolder", {
    name,
    parentId,
  });
  const items = IndexResponseSchema.parse(result(outcome)).items;
  const folder = items.findLast((item) => item.kind === "folder" && item.name === name);
  if (folder?.kind !== "folder") throw new Error(`folder ${name} missing from the answer`);
  return folder;
}

async function tree(base: IndexFixture, caller = base.owner): Promise<readonly IndexEntry[]> {
  return IndexResponseSchema.parse(result(await base.host.dispatch(caller, "core.index.read", {})))
    .items;
}

function siblingIds(items: readonly IndexEntry[], parentId: string | null): string[] {
  return items
    .filter((item) => item.parentId === parentId)
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((item) => (item.kind === "container" ? item.container.id : item.id));
}

describe("the ladder every core.index door answers", () => {
  test("rung 1: a name the assembly does not know is unknown_action", async () => {
    const base = fixture();

    expect(denial(await base.host.dispatch(base.owner, "core.index.rename", {}))).toEqual({
      rule: "unknown_action",
      message: 'unknown action "core.index.rename"',
    });
  });

  test("rung 2: disabling the index closes its reads and its writes, never its removals", async () => {
    const base = fixture();
    const container = await createContainer(base, "doomed");
    const folder = await createFolder(base, "doomed folder");
    expect(await base.host.setEnabled("core.index", false, base.owner.principal.id)).toEqual({
      ok: true,
    });

    for (const [name, args] of [
      ["core.index.read", {}],
      ["core.index.listContainers", {}],
      ["core.index.readContainer", { containerId: container.id }],
      ["core.index.createContainer", { name: "nope" }],
      ["core.index.renameContainer", { containerId: container.id, name: "nope" }],
      ["core.index.createFolder", { name: "nope", parentId: null }],
      ["core.index.renameFolder", { folderId: folder.id, name: "nope" }],
      [
        "core.index.moveEntry",
        { item: { kind: "container", id: container.id }, parentId: null, index: 0 },
      ],
    ] as const) {
      expect(denial(await base.host.dispatch(base.owner, name, args))).toEqual({
        rule: "plugin_disabled",
        message: 'plugin "core.index" is disabled',
      });
    }

    // D12: creation and administration die, CLEANUP survives. An administrator turning the
    // index off must never leave a container or a folder nobody is able to remove.
    expect(
      await base.host.dispatch(base.owner, "core.index.deleteFolder", { folderId: folder.id }),
    ).toMatchObject({ ok: true });
    expect(
      await base.host.dispatch(base.owner, "core.index.deleteContainer", {
        containerId: container.id,
      }),
    ).toEqual({ ok: true, result: {} });
    expect(base.store.getContainer(container.id)).toBeNull();
  });

  test("rung 3: organizing the index is workspace-grade, reading it is not", async () => {
    const base = fixture();
    const container = await createContainer(base, "scoped");
    const folder = await createFolder(base, "shelf");
    const scoped = context(base, ["containers:read", "containers:write"], container.id);

    for (const [name, args] of [
      ["core.index.createContainer", { name: "nope" }],
      ["core.index.createFolder", { name: "nope", parentId: null }],
      ["core.index.renameFolder", { folderId: folder.id, name: "nope" }],
      ["core.index.deleteFolder", { folderId: folder.id }],
      [
        "core.index.moveEntry",
        { item: { kind: "container", id: container.id }, parentId: null, index: 0 },
      ],
      ["core.index.deleteContainer", { containerId: container.id }],
    ] as const) {
      expect(denial(await base.host.dispatch(scoped, name, args))).toEqual({
        rule: "forbidden",
        message: "scoped tokens cannot invoke workspace actions",
      });
    }

    // The reads and the rename fall through the scope rung, exactly as their routes let a
    // scoped token through — and answer only what that token's container is.
    expect(await tree(base, scoped)).toEqual([
      { kind: "container", container, parentId: null, sortOrder: 0 },
    ]);
    expect(
      ContainersResponseSchema.parse(
        result(await base.host.dispatch(scoped, "core.index.listContainers", {})),
      ),
    ).toEqual({ containers: [container] });
    expect(
      ContainerResponseSchema.parse(
        result(
          await base.host.dispatch(scoped, "core.index.readContainer", {
            containerId: container.id,
          }),
        ),
      ).container,
    ).toEqual(container);
  });

  test("rung 3, the handler's half: a scope can never reach past its own container", async () => {
    const base = fixture();
    const mine = await createContainer(base, "mine");
    const yours = await createContainer(base, "yours");
    const scoped = context(base, ["containers:read", "containers:write"], mine.id);

    // ONE wording for the concept, engine-owned: a client switches on the class and never
    // learns the id of a container it may not reach.
    expect(
      denial(
        await base.host.dispatch(scoped, "core.index.readContainer", { containerId: yours.id }),
      ),
    ).toEqual({ rule: "refused", message: OUTSIDE_SCOPE_REFUSAL });
    expect(
      denial(
        await base.host.dispatch(scoped, "core.index.renameContainer", {
          containerId: yours.id,
          name: "x",
        }),
      ),
    ).toEqual({ rule: "refused", message: OUTSIDE_SCOPE_REFUSAL });
    // Its own container it may still rename: that is what `PATCH /api/containers/:id`
    // authorized.
    expect(
      ContainerResponseSchema.parse(
        result(
          await base.host.dispatch(scoped, "core.index.renameContainer", {
            containerId: mine.id,
            name: "ours",
          }),
        ),
      ).container,
    ).toEqual({ ...mine, name: "ours" });
    expect(base.store.getContainer(yours.id)?.name).toBe("yours");
  });

  test("rung 4: every door names the cap it needs, and retiring a container needs root", async () => {
    const base = fixture();
    const container = await createContainer(base, "capped");
    const reader = context(base, ["containers:read"]);

    for (const [name, args] of [
      ["core.index.createContainer", { name: "nope" }],
      ["core.index.renameContainer", { containerId: container.id, name: "nope" }],
      ["core.index.createFolder", { name: "nope", parentId: null }],
      [
        "core.index.moveEntry",
        { item: { kind: "container", id: container.id }, parentId: null, index: 0 },
      ],
    ] as const) {
      expect(denial(await base.host.dispatch(reader, name, args))).toEqual({
        rule: "forbidden",
        message: "containers:write capability required",
      });
    }

    // `requireRoot` moved into the ladder as a declared `*`: deleting a container destroys
    // every principal's work inside it, and no cap short of root stands in for that.
    const writer = context(base, ["containers:read", "containers:write"]);
    expect(
      denial(
        await base.host.dispatch(writer, "core.index.deleteContainer", {
          containerId: container.id,
        }),
      ),
    ).toEqual({ rule: "forbidden", message: "* capability required" });
    expect(base.store.getContainer(container.id)).not.toBeNull();
  });

  test("rung 5: a payload that fails the published schema is invalid_args", async () => {
    const base = fixture();

    expect(
      denial(await base.host.dispatch(base.owner, "core.index.createContainer", { name: "" })).rule,
    ).toBe("invalid_args");
    expect(
      denial(
        await base.host.dispatch(base.owner, "core.index.createContainer", {
          name: "ok",
          nope: 1,
        }),
      ).rule,
    ).toBe("invalid_args");
    expect(
      denial(
        await base.host.dispatch(base.owner, "core.index.moveEntry", {
          item: { kind: "container" },
        }),
      ).rule,
    ).toBe("invalid_args");
  });

  test("rung 6: a row that is not there refuses with the sentence its route used", async () => {
    const base = fixture();

    expect(
      denial(
        await base.host.dispatch(base.owner, "core.index.renameContainer", {
          containerId: "gone",
          name: "x",
        }),
      ),
    ).toEqual({ rule: "refused", message: "container not found" });
    expect(
      denial(
        await base.host.dispatch(base.owner, "core.index.readContainer", { containerId: "gone" }),
      ),
    ).toEqual({
      rule: "refused",
      message: "container not found",
    });
    expect(
      denial(
        await base.host.dispatch(base.owner, "core.index.deleteContainer", {
          containerId: "gone",
        }),
      ),
    ).toEqual({ rule: "refused", message: "container not found" });
    expect(
      denial(
        await base.host.dispatch(base.owner, "core.index.renameFolder", {
          folderId: "gone",
          name: "x",
        }),
      ),
    ).toEqual({ rule: "refused", message: "container folder not found" });
    expect(
      denial(await base.host.dispatch(base.owner, "core.index.deleteFolder", { folderId: "gone" })),
    ).toEqual({ rule: "refused", message: "container folder not found" });
    expect(
      denial(
        await base.host.dispatch(base.owner, "core.index.createFolder", {
          name: "orphan",
          parentId: "gone",
        }),
      ),
    ).toEqual({ rule: "refused", message: "parent folder changed while creating a folder" });
    expect(
      denial(
        await base.host.dispatch(base.owner, "core.index.moveEntry", {
          item: { kind: "container", id: "gone" },
          parentId: null,
          index: 0,
        }),
      ),
    ).toEqual({ rule: "refused", message: "sidebar tree changed while moving an item" });
  });
});

describe("the index's own semantics, carried over intact", () => {
  test("the tree a scoped token reads includes the folders its container hangs under", async () => {
    const base = fixture();
    const outer = await createFolder(base, "outer");
    const inner = await createFolder(base, "inner", outer.id);
    const container = await createContainer(base, "buried");
    const other = await createContainer(base, "not yours");
    expect(
      result(
        await base.host.dispatch(base.owner, "core.index.moveEntry", {
          item: { kind: "container", id: container.id },
          parentId: inner.id,
          index: 0,
        }),
      ),
    ).toBeDefined();

    const scoped = context(base, ["containers:read"], container.id);
    const visible = await tree(base, scoped);

    // The ancestor chain, and nothing else: a row whose parent is invisible is a row the
    // sidebar cannot place, which is why the folders come along and the sibling does not.
    expect(
      visible.map((item) => (item.kind === "container" ? item.container.id : item.id)).sort(),
    ).toEqual([inner.id, outer.id, container.id].sort());
    expect(
      visible.some((item) => item.kind === "container" && item.container.id === other.id),
    ).toBe(false);
  });

  test("deleting a folder moves its children up into its place instead of cascading", async () => {
    const base = fixture();
    const alpha = await createContainer(base, "alpha");
    const shelf = await createFolder(base, "shelf");
    const nested = await createFolder(base, "nested", shelf.id);
    const gamma = await createContainer(base, "gamma");
    for (const [item, parentId, index] of [
      [{ kind: "folder", id: shelf.id }, null, 1],
      [{ kind: "container", id: gamma.id }, shelf.id, 0],
    ] as const) {
      result(
        await base.host.dispatch(base.owner, "core.index.moveEntry", { item, parentId, index }),
      );
    }

    const after = IndexResponseSchema.parse(
      result(
        await base.host.dispatch(base.owner, "core.index.deleteFolder", { folderId: shelf.id }),
      ),
    ).items;

    expect(siblingIds(after, null)).toEqual([alpha.id, gamma.id, nested.id]);
    expect(after.some((item) => item.kind === "folder" && item.id === shelf.id)).toBe(false);
  });

  test("a folder cannot be moved inside itself or into its own descendant", async () => {
    const base = fixture();
    const outer = await createFolder(base, "outer");
    const inner = await createFolder(base, "inner", outer.id);

    for (const parentId of [outer.id, inner.id]) {
      expect(
        denial(
          await base.host.dispatch(base.owner, "core.index.moveEntry", {
            item: { kind: "folder", id: outer.id },
            parentId,
            index: 0,
          }),
        ),
      ).toEqual({ rule: "refused", message: "sidebar tree changed while moving an item" });
    }
    // The tree the cycle would have broken is untouched.
    expect(siblingIds(await tree(base), outer.id)).toEqual([inner.id]);
  });

  test("retiring a container goes through placement, so nothing is left pointing at it", async () => {
    const base = fixture();
    const canvas = await createContainer(base, "canvas");
    const doomed = await createContainer(base, "doomed", "composition");

    expect(
      await base.host.dispatch(base.owner, "core.index.deleteContainer", {
        containerId: doomed.id,
      }),
    ).toEqual({ ok: true, result: {} });

    expect(base.store.getContainer(doomed.id)).toBeNull();
    expect(base.store.listContainers().map((container) => container.id)).toEqual([canvas.id]);
    expect(base.store.listTerminals().filter((row) => row.containerId === doomed.id)).toEqual([]);
  });

  test("every mutation answers the whole new index, so one round trip redraws the sidebar", async () => {
    const base = fixture();
    const container = await createContainer(base, "one");
    const folder = await createFolder(base, "shelf");

    const moved = IndexResponseSchema.parse(
      result(
        await base.host.dispatch(base.owner, "core.index.moveEntry", {
          item: { kind: "container", id: container.id },
          parentId: folder.id,
          index: 0,
        }),
      ),
    ).items;
    const renamed = IndexResponseSchema.parse(
      result(
        await base.host.dispatch(base.owner, "core.index.renameFolder", {
          folderId: folder.id,
          name: "renamed shelf",
        }),
      ),
    ).items;

    expect(siblingIds(moved, folder.id)).toEqual([container.id]);
    expect(renamed.find((item) => item.kind === "folder")?.kind).toBe("folder");
    // The answer and a fresh read agree: the mutation's payload IS the index.
    expect(await tree(base)).toEqual(renamed);
  });
});
