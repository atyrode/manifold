import { describe, expect, test } from "bun:test";
import {
  PadResponseSchema,
  PadTreeResponseSchema,
  PadsResponseSchema,
  type ActionOutcome,
  type Cap,
  type Pad,
  type PadTreeItem,
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
 *   - the SCOPE obligation. `tree`, `list`, `pad` and `renamePad` are declared `scope: "pad"`
 *     because the routes they replace were reachable by a pad-scoped token, and conversion
 *     must never narrow who may call a door (ADR 0013 §15). The rung proves the caller's caps
 *     hold for its OWN container; only the handler can prove the container NAMED in the
 *     arguments is that one, so every case that could reach past a scope is here.
 *   - the store's own guards, surfaced as refusals rather than as HTTP codes: a folder
 *     delete moves children UP instead of cascading, a move into a folder's own descendant
 *     is refused, and retiring a container goes through the placement executor so nothing is
 *     left pointing at it.
 */

const OWNER_KEY = "d".repeat(64);

interface ViewsFixture {
  readonly runtime: FakeRuntime;
  readonly store: ServerStore;
  readonly auth: AuthService;
  readonly owner: AuthContext;
  readonly host: PluginHost;
}

function fixture(): ViewsFixture {
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
  rooms.setSessionProvider((padId) => broker.listForPad(padId));
  rooms.setPendingOpenProvider((padId) => broker.hasPendingOpenForPad(padId));
  const host = testPluginHost(store, auth, rooms, broker, runtime);
  return { runtime, store, auth, owner, host };
}

/** A minted token, so authority is exercised through real attenuation. */
function context(base: ViewsFixture, caps: readonly Cap[], padId?: string): AuthContext {
  const grant = base.auth.mintToken(
    {
      principal: { name: "guest", kind: "human" },
      caps: [...caps],
      ...(padId === undefined ? {} : { padId }),
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

async function createPad(
  base: ViewsFixture,
  name: string,
  layout?: "canvas" | "tiled",
): Promise<Pad> {
  const outcome = await base.host.dispatch(base.owner, "core.views.createPad", {
    name,
    ...(layout === undefined ? {} : { layout }),
  });
  return PadResponseSchema.parse(result(outcome)).pad;
}

async function createFolder(
  base: ViewsFixture,
  name: string,
  parentId: string | null = null,
): Promise<Extract<PadTreeItem, { kind: "folder" }>> {
  const outcome = await base.host.dispatch(base.owner, "core.views.createFolder", {
    name,
    parentId,
  });
  const items = PadTreeResponseSchema.parse(result(outcome)).items;
  const folder = items.findLast((item) => item.kind === "folder" && item.name === name);
  if (folder?.kind !== "folder") throw new Error(`folder ${name} missing from the answer`);
  return folder;
}

async function tree(base: ViewsFixture, caller = base.owner): Promise<readonly PadTreeItem[]> {
  return PadTreeResponseSchema.parse(
    result(await base.host.dispatch(caller, "core.views.tree", {})),
  ).items;
}

function siblingIds(items: readonly PadTreeItem[], parentId: string | null): string[] {
  return items
    .filter((item) => item.parentId === parentId)
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((item) => (item.kind === "pad" ? item.pad.id : item.id));
}

describe("the ladder every core.views door answers", () => {
  test("rung 1: a name the composition does not know is unknown_action", async () => {
    const base = fixture();

    expect(denial(await base.host.dispatch(base.owner, "core.views.rename", {}))).toEqual({
      rule: "unknown_action",
      message: 'unknown action "core.views.rename"',
    });
  });

  test("rung 2: disabling the index closes its reads and its writes, never its removals", async () => {
    const base = fixture();
    const pad = await createPad(base, "doomed");
    const folder = await createFolder(base, "doomed folder");
    expect(await base.host.setEnabled("core.views", false, base.owner.principal.id)).toEqual({
      ok: true,
    });

    for (const [name, args] of [
      ["core.views.tree", {}],
      ["core.views.list", {}],
      ["core.views.pad", { padId: pad.id }],
      ["core.views.createPad", { name: "nope" }],
      ["core.views.renamePad", { padId: pad.id, name: "nope" }],
      ["core.views.createFolder", { name: "nope", parentId: null }],
      ["core.views.renameFolder", { folderId: folder.id, name: "nope" }],
      ["core.views.move", { item: { kind: "pad", id: pad.id }, parentId: null, index: 0 }],
    ] as const) {
      expect(denial(await base.host.dispatch(base.owner, name, args))).toEqual({
        rule: "plugin_disabled",
        message: 'plugin "core.views" is disabled',
      });
    }

    // D12: creation and administration die, CLEANUP survives. An administrator turning the
    // index off must never leave a container or a folder nobody is able to remove.
    expect(
      await base.host.dispatch(base.owner, "core.views.deleteFolder", { folderId: folder.id }),
    ).toMatchObject({ ok: true });
    expect(await base.host.dispatch(base.owner, "core.views.deletePad", { padId: pad.id })).toEqual(
      { ok: true, result: {} },
    );
    expect(base.store.getPad(pad.id)).toBeNull();
  });

  test("rung 3: organizing the index is workspace-grade, reading it is not", async () => {
    const base = fixture();
    const pad = await createPad(base, "scoped");
    const folder = await createFolder(base, "shelf");
    const scoped = context(base, ["pads:read", "pads:write"], pad.id);

    for (const [name, args] of [
      ["core.views.createPad", { name: "nope" }],
      ["core.views.createFolder", { name: "nope", parentId: null }],
      ["core.views.renameFolder", { folderId: folder.id, name: "nope" }],
      ["core.views.deleteFolder", { folderId: folder.id }],
      ["core.views.move", { item: { kind: "pad", id: pad.id }, parentId: null, index: 0 }],
      ["core.views.deletePad", { padId: pad.id }],
    ] as const) {
      expect(denial(await base.host.dispatch(scoped, name, args))).toEqual({
        rule: "forbidden",
        message: "scoped tokens cannot invoke workspace actions",
      });
    }

    // The reads and the rename fall through the scope rung, exactly as their routes let a
    // scoped token through — and answer only what that token's container is.
    expect(await tree(base, scoped)).toEqual([{ kind: "pad", pad, parentId: null, sortOrder: 0 }]);
    expect(
      PadsResponseSchema.parse(result(await base.host.dispatch(scoped, "core.views.list", {}))),
    ).toEqual({ pads: [pad] });
    expect(
      PadResponseSchema.parse(
        result(await base.host.dispatch(scoped, "core.views.pad", { padId: pad.id })),
      ).pad,
    ).toEqual(pad);
  });

  test("rung 3, the handler's half: a scope can never reach past its own container", async () => {
    const base = fixture();
    const mine = await createPad(base, "mine");
    const yours = await createPad(base, "yours");
    const scoped = context(base, ["pads:read", "pads:write"], mine.id);

    // ONE wording for the concept, engine-owned: a client switches on the class and never
    // learns the id of a container it may not reach.
    expect(denial(await base.host.dispatch(scoped, "core.views.pad", { padId: yours.id }))).toEqual(
      { rule: "refused", message: OUTSIDE_SCOPE_REFUSAL },
    );
    expect(
      denial(
        await base.host.dispatch(scoped, "core.views.renamePad", { padId: yours.id, name: "x" }),
      ),
    ).toEqual({ rule: "refused", message: OUTSIDE_SCOPE_REFUSAL });
    // Its own container it may still rename: that is what `PATCH /api/pads/:id` authorized.
    expect(
      PadResponseSchema.parse(
        result(
          await base.host.dispatch(scoped, "core.views.renamePad", {
            padId: mine.id,
            name: "ours",
          }),
        ),
      ).pad,
    ).toEqual({ ...mine, name: "ours" });
    expect(base.store.getPad(yours.id)?.name).toBe("yours");
  });

  test("rung 4: every door names the cap it needs, and retiring a container needs root", async () => {
    const base = fixture();
    const pad = await createPad(base, "capped");
    const reader = context(base, ["pads:read"]);

    for (const [name, args] of [
      ["core.views.createPad", { name: "nope" }],
      ["core.views.renamePad", { padId: pad.id, name: "nope" }],
      ["core.views.createFolder", { name: "nope", parentId: null }],
      ["core.views.move", { item: { kind: "pad", id: pad.id }, parentId: null, index: 0 }],
    ] as const) {
      expect(denial(await base.host.dispatch(reader, name, args))).toEqual({
        rule: "forbidden",
        message: "pads:write capability required",
      });
    }

    // `requireRoot` moved into the ladder as a declared `*`: deleting a container destroys
    // every principal's work inside it, and no cap short of root stands in for that.
    const writer = context(base, ["pads:read", "pads:write"]);
    expect(
      denial(await base.host.dispatch(writer, "core.views.deletePad", { padId: pad.id })),
    ).toEqual({ rule: "forbidden", message: "* capability required" });
    expect(base.store.getPad(pad.id)).not.toBeNull();
  });

  test("rung 5: a payload that fails the published schema is invalid_args", async () => {
    const base = fixture();

    expect(
      denial(await base.host.dispatch(base.owner, "core.views.createPad", { name: "" })).rule,
    ).toBe("invalid_args");
    expect(
      denial(await base.host.dispatch(base.owner, "core.views.createPad", { name: "ok", nope: 1 }))
        .rule,
    ).toBe("invalid_args");
    expect(
      denial(await base.host.dispatch(base.owner, "core.views.move", { item: { kind: "pad" } }))
        .rule,
    ).toBe("invalid_args");
  });

  test("rung 6: a row that is not there refuses with the sentence its route used", async () => {
    const base = fixture();

    expect(
      denial(
        await base.host.dispatch(base.owner, "core.views.renamePad", { padId: "gone", name: "x" }),
      ),
    ).toEqual({ rule: "refused", message: "pad not found" });
    expect(
      denial(await base.host.dispatch(base.owner, "core.views.pad", { padId: "gone" })),
    ).toEqual({
      rule: "refused",
      message: "pad not found",
    });
    expect(
      denial(await base.host.dispatch(base.owner, "core.views.deletePad", { padId: "gone" })),
    ).toEqual({ rule: "refused", message: "pad not found" });
    expect(
      denial(
        await base.host.dispatch(base.owner, "core.views.renameFolder", {
          folderId: "gone",
          name: "x",
        }),
      ),
    ).toEqual({ rule: "refused", message: "pad folder not found" });
    expect(
      denial(await base.host.dispatch(base.owner, "core.views.deleteFolder", { folderId: "gone" })),
    ).toEqual({ rule: "refused", message: "pad folder not found" });
    expect(
      denial(
        await base.host.dispatch(base.owner, "core.views.createFolder", {
          name: "orphan",
          parentId: "gone",
        }),
      ),
    ).toEqual({ rule: "refused", message: "parent folder changed while creating a folder" });
    expect(
      denial(
        await base.host.dispatch(base.owner, "core.views.move", {
          item: { kind: "pad", id: "gone" },
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
    const pad = await createPad(base, "buried");
    const other = await createPad(base, "not yours");
    expect(
      result(
        await base.host.dispatch(base.owner, "core.views.move", {
          item: { kind: "pad", id: pad.id },
          parentId: inner.id,
          index: 0,
        }),
      ),
    ).toBeDefined();

    const scoped = context(base, ["pads:read"], pad.id);
    const visible = await tree(base, scoped);

    // The ancestor chain, and nothing else: a row whose parent is invisible is a row the
    // sidebar cannot place, which is why the folders come along and the sibling does not.
    expect(visible.map((item) => (item.kind === "pad" ? item.pad.id : item.id)).sort()).toEqual(
      [inner.id, outer.id, pad.id].sort(),
    );
    expect(visible.some((item) => item.kind === "pad" && item.pad.id === other.id)).toBe(false);
  });

  test("deleting a folder moves its children up into its place instead of cascading", async () => {
    const base = fixture();
    const alpha = await createPad(base, "alpha");
    const shelf = await createFolder(base, "shelf");
    const nested = await createFolder(base, "nested", shelf.id);
    const gamma = await createPad(base, "gamma");
    for (const [item, parentId, index] of [
      [{ kind: "folder", id: shelf.id }, null, 1],
      [{ kind: "pad", id: gamma.id }, shelf.id, 0],
    ] as const) {
      result(await base.host.dispatch(base.owner, "core.views.move", { item, parentId, index }));
    }

    const after = PadTreeResponseSchema.parse(
      result(
        await base.host.dispatch(base.owner, "core.views.deleteFolder", { folderId: shelf.id }),
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
          await base.host.dispatch(base.owner, "core.views.move", {
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
    const canvas = await createPad(base, "canvas");
    const doomed = await createPad(base, "doomed", "tiled");

    expect(
      await base.host.dispatch(base.owner, "core.views.deletePad", { padId: doomed.id }),
    ).toEqual({ ok: true, result: {} });

    expect(base.store.getPad(doomed.id)).toBeNull();
    expect(base.store.listPads().map((pad) => pad.id)).toEqual([canvas.id]);
    expect(base.store.listSessions().filter((row) => row.padId === doomed.id)).toEqual([]);
  });

  test("every mutation answers the whole new index, so one round trip redraws the sidebar", async () => {
    const base = fixture();
    const pad = await createPad(base, "one");
    const folder = await createFolder(base, "shelf");

    const moved = PadTreeResponseSchema.parse(
      result(
        await base.host.dispatch(base.owner, "core.views.move", {
          item: { kind: "pad", id: pad.id },
          parentId: folder.id,
          index: 0,
        }),
      ),
    ).items;
    const renamed = PadTreeResponseSchema.parse(
      result(
        await base.host.dispatch(base.owner, "core.views.renameFolder", {
          folderId: folder.id,
          name: "renamed shelf",
        }),
      ),
    ).items;

    expect(siblingIds(moved, folder.id)).toEqual([pad.id]);
    expect(renamed.find((item) => item.kind === "folder")?.kind).toBe("folder");
    // The answer and a fresh read agree: the mutation's payload IS the index.
    expect(await tree(base)).toEqual(renamed);
  });
});
