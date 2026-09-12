import { defineAction } from "@manifold/plugin";
import { ManifoldRefSchema, formatManifoldUri, type ActionOutcome } from "@manifold/protocol";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { silentLogger } from "../src/log.ts";
import type { PluginHost, ServerPluginDef } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore, testTileTrees } from "./helpers.ts";

/**
 * MACHINE-SCOPED GRANTS AND PLUGIN-DECLARED CAPABILITIES (ADR 0035, #506).
 *
 * Two halves of one sentence — "this principal may archive sessions ON THIS MACHINE" — and
 * neither half was sayable before: the waterfall's only reachable node argument was a
 * container, and `CAPS` was a closed enum with no word for archiving anything.
 *
 * What is defended here is the pair, at both ends of the ladder. The EVALUATOR cases pin the
 * machine node's place in the containment walk and the rule that decides a plugin capability's
 * contest — including the one that is easiest to get wrong and most expensive to get wrong,
 * that `*` does NOT expand into a plugin's namespace. The DOOR case proves the same authority
 * through the real assembly and the real dispatch ladder, because a capability the evaluator
 * answers and no door can ask would be a feature nobody can reach (ADR 0011 §8).
 */

const OWNER_KEY = "a".repeat(64);
const ARCHIVE = "example.fleet:archive";
const OTHER_CAP = "example.other:archive";

/** A plugin whose authority is per machine: the shape #506 exists for. */
const FLEET: readonly ServerPluginDef[] = [
  {
    manifest: {
      id: "example.fleet",
      version: "1.0.0",
      title: "Fleet fixture",
      description: "Declares a capability of its own and asks for it at a machine.",
      capabilities: [ARCHIVE],
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
    },
    actions: [
      defineAction({
        name: "archive",
        title: "Archive one machine's sessions",
        caps: [ARCHIVE],
        /*
          The requirement is what makes the machine node REACHABLE: `allows` asks at a
          container or at the credential's anchor, so a row at `manifold://machine/<id>` is
          only ever seen by a question that names the node, and a declared requirement is the
          door that names it.
        */
        requirements: [{ cap: ARCHIVE, target: ["machine"] }],
        input: z.strictObject({ machine: ManifoldRefSchema }),
        result: z.strictObject({ machineId: z.string() }),
      }),
    ],
    handlers: {
      archive: async (_ctx, args) => {
        const parsed = z.strictObject({ machine: ManifoldRefSchema }).parse(args);
        return { machineId: "machineId" in parsed.machine ? parsed.machine.machineId : "" };
      },
    },
  },
];

interface Fixture {
  readonly store: ServerStore;
  readonly auth: AuthService;
  readonly owner: AuthContext;
  readonly host: PluginHost;
  /** Two enrolled machines, because "this one and not that one" is the whole claim. */
  readonly here: string;
  readonly there: string;
}

async function fixture(): Promise<Fixture> {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const auth = new AuthService(store, OWNER_KEY, runtime);
  const owner = auth.authenticate(OWNER_KEY);
  const rooms = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
  const broker = new TerminalBroker(
    store,
    auth,
    rooms,
    runtime,
    clock,
    silentLogger,
    () => "http://localhost:7777",
    testTileTrees,
  );
  rooms.setTerminalProvider((containerId) => broker.listForContainer(containerId));
  rooms.setPendingOpenProvider((containerId) => broker.hasPendingOpenForContainer(containerId));
  return {
    store,
    auth,
    owner,
    host: await testPluginHost(store, auth, rooms, broker, runtime, { settingsPlugins: FLEET }),
    here: auth.enrollMachine("here", owner).machine.id,
    there: auth.enrollMachine("there", owner).machine.id,
  };
}

const machineUri = (machineId: string): string => formatManifoldUri({ kind: "machine", machineId });

/** An ordinary unscoped delegate: everything below is authority it did NOT get at the mint. */
function delegate(target: Fixture, caps: readonly ["containers:read"] = ["containers:read"]) {
  const grant = target.auth.mintToken(
    { principal: { name: "agent", kind: "agent" }, caps: [...caps] },
    target.owner,
  );
  return target.auth.authenticate(grant.token);
}

function refusal(outcome: ActionOutcome): string {
  if (outcome.ok) throw new Error("expected a refusal");
  return outcome.denial.message;
}

describe("a grant scoped to one machine", () => {
  test("a subtree row at a machine reaches everything the fleet addresses beneath it", async () => {
    const target = await fixture();
    const agent = delegate(target);

    target.auth.grant(
      {
        principal: { kind: "principal", id: agent.principal.id },
        node: machineUri(target.here),
        caps: ["jobs:read"],
        effect: "allow",
        reach: "subtree",
      },
      target.owner,
    );

    // The machine, and the operation/job/output nodes addressed THROUGH it.
    expect(
      target.auth.allowsRef(agent, "jobs:read", { kind: "machine", machineId: target.here }),
    ).toBe(true);
    expect(
      target.auth.allowsRef(agent, "jobs:read", {
        kind: "job",
        machineId: target.here,
        operationId: "scan",
        jobId: "j-1",
      }),
    ).toBe(true);
    // The other machine, and the workspace above both, are untouched.
    expect(
      target.auth.allowsRef(agent, "jobs:read", { kind: "machine", machineId: target.there }),
    ).toBe(false);
    expect(target.auth.allows(agent, "jobs:read")).toBe(false);
    target.store.close();
  });

  test("reach: node stops at the machine and does not descend to its operations", async () => {
    const target = await fixture();
    const agent = delegate(target);

    target.auth.grant(
      {
        principal: { kind: "principal", id: agent.principal.id },
        node: machineUri(target.here),
        caps: ["jobs:read"],
        effect: "allow",
        reach: "node",
      },
      target.owner,
    );

    expect(
      target.auth.allowsRef(agent, "jobs:read", { kind: "machine", machineId: target.here }),
    ).toBe(true);
    expect(
      target.auth.allowsRef(agent, "jobs:read", {
        kind: "operation",
        machineId: target.here,
        operationId: "scan",
      }),
    ).toBe(false);
    target.store.close();
  });

  test("a deny at one machine bites through a root wildcard and leaves the fleet alone", async () => {
    const target = await fixture();
    const root = target.auth.authenticate(
      target.auth.mintToken(
        { principal: { name: "ana", kind: "human" }, caps: ["*"] },
        target.owner,
      ).token,
    );

    target.auth.grant(
      {
        principal: { kind: "principal", id: root.principal.id },
        node: machineUri(target.here),
        caps: ["machines:run"],
        effect: "deny",
        reach: "subtree",
      },
      target.owner,
    );

    expect(
      target.auth.allowsRef(root, "machines:run", { kind: "machine", machineId: target.here }),
    ).toBe(false);
    expect(
      target.auth.allowsRef(root, "machines:run", { kind: "machine", machineId: target.there }),
    ).toBe(true);
    // One capability, at one machine: everything else the wildcard carried is still there.
    expect(
      target.auth.allowsRef(root, "jobs:read", { kind: "machine", machineId: target.here }),
    ).toBe(true);
    target.store.close();
  });

  test("a machine id that needs escaping is stored canonically and still found by the walk", async () => {
    const target = await fixture();
    const agent = delegate(target);
    // Server-minted ids are uuids; an id holding a separator is the case a SQL-built node URI
    // would agree with for every other id and disagree with silently for this one.
    const awkward = "box/one%two";

    const row = target.auth.grant(
      {
        principal: { kind: "principal", id: agent.principal.id },
        node: `manifold://machine/${encodeURIComponent(awkward)}`,
        caps: [ARCHIVE],
        effect: "allow",
        reach: "subtree",
      },
      target.owner,
    );

    expect(row.node).toBe(machineUri(awkward));
    expect(target.auth.allowsRef(agent, ARCHIVE, { kind: "machine", machineId: awkward })).toBe(
      true,
    );
    expect(
      target.auth.listGrants({ node: machineUri(awkward) }, target.owner).map((grant) => grant.id),
    ).toEqual([row.id]);
    target.store.close();
  });

  test("a container-scoped credential is refused at a machine, row or no row", async () => {
    const target = await fixture();
    const container = { id: "c-1" };
    target.store.createContainer({
      ...container,
      name: "Room",
      createdAt: 1,
      discipline: "canvas",
    });
    const scoped = target.auth.authenticate(
      target.auth.mintToken(
        {
          principal: { name: "viewer", kind: "human" },
          caps: ["containers:read"],
          containerId: container.id,
        },
        target.owner,
      ).token,
    );

    target.auth.grant(
      {
        principal: { kind: "principal", id: scoped.principal.id },
        node: machineUri(target.here),
        caps: [ARCHIVE],
        effect: "allow",
        reach: "subtree",
      },
      target.owner,
    );

    // The immutable container ceiling: a machine is not inside the container this credential
    // is scoped to, so no administered row can reach past the scope its mint chose.
    expect(
      target.auth.allowsRef(scoped, ARCHIVE, { kind: "machine", machineId: target.here }),
    ).toBe(false);
    target.store.close();
  });
});

describe("a plugin's own capability", () => {
  test("the wildcard does not expand into a plugin's namespace, and a row does", async () => {
    const target = await fixture();
    const root = target.auth.authenticate(
      target.auth.mintToken(
        { principal: { name: "ana", kind: "human" }, caps: ["*"] },
        target.owner,
      ).token,
    );
    const here = { kind: "machine", machineId: target.here } as const;

    // Root, and the owner key itself, hold every ENGINE capability everywhere and no plugin's
    // own capability anywhere: a namespaced name exists to say something `CAPS` cannot, so
    // holding it by accident would make the declaring plugin's gate meaningless.
    expect(target.auth.allowsRef(root, "machines:run", here)).toBe(true);
    expect(target.auth.allowsRef(root, ARCHIVE, here)).toBe(false);
    expect(target.auth.allowsRef(target.owner, ARCHIVE, here)).toBe(false);
    expect([...target.auth.effectiveCaps(root, machineUri(target.here))]).not.toContain(ARCHIVE);

    target.auth.grant(
      {
        principal: { kind: "principal", id: root.principal.id },
        node: machineUri(target.here),
        caps: [ARCHIVE],
        effect: "allow",
        reach: "subtree",
      },
      target.owner,
    );

    expect(target.auth.allowsRef(root, ARCHIVE, here)).toBe(true);
    expect([...target.auth.effectiveCaps(root, machineUri(target.here))]).toContain(ARCHIVE);
    // Another plugin's namespace is another capability entirely, granted to nobody here.
    expect(target.auth.allowsRef(root, OTHER_CAP, here)).toBe(false);
    target.store.close();
  });

  test("precedence decides a plugin capability exactly as it decides the engine's", async () => {
    const target = await fixture();
    const agent = delegate(target);
    const here = { kind: "machine", machineId: target.here } as const;

    target.auth.grant(
      {
        principal: { kind: "principal", id: agent.principal.id },
        node: "manifold://",
        caps: [ARCHIVE, "jobs:read"],
        effect: "allow",
        reach: "subtree",
      },
      target.owner,
    );
    target.auth.grant(
      {
        principal: { kind: "principal", id: agent.principal.id },
        node: machineUri(target.here),
        caps: [ARCHIVE],
        effect: "deny",
        reach: "subtree",
      },
      target.owner,
    );

    // Deeper beats shallower, per capability: the deny takes the plugin's capability at this
    // machine and nothing else — not the engine cap beside it, not the same cap elsewhere.
    expect(target.auth.allowsRef(agent, ARCHIVE, here)).toBe(false);
    expect(target.auth.allowsRef(agent, "jobs:read", here)).toBe(true);
    expect(
      target.auth.allowsRef(agent, ARCHIVE, { kind: "machine", machineId: target.there }),
    ).toBe(true);
    target.store.close();
  });

  test("a row survives the vocabulary: a grant may name a capability no plugin declared", async () => {
    const target = await fixture();
    const agent = delegate(target);

    /*
      A grant is written by a PRINCIPAL, not by a plugin, so the row's vocabulary is not
      checked against the roster: authority administered before an install, or left behind
      after an uninstall, must neither be refused at the write nor vanish from the table. What
      makes such a row inert is the door — an action nobody declared cannot be dispatched.
    */
    const row = target.auth.grant(
      {
        principal: { kind: "principal", id: agent.principal.id },
        node: machineUri(target.here),
        caps: [OTHER_CAP],
        effect: "allow",
        reach: "subtree",
      },
      target.owner,
    );
    expect(row.caps).toEqual([OTHER_CAP]);
    expect(
      target.auth.allowsRef(agent, OTHER_CAP, { kind: "machine", machineId: target.here }),
    ).toBe(true);

    // The form is still a form: a bare word is in nobody's namespace and is refused.
    expect(() =>
      target.auth.grant(
        {
          principal: { kind: "principal", id: agent.principal.id },
          node: machineUri(target.here),
          caps: ["archive"],
          effect: "allow",
          reach: "subtree",
        } as never,
        target.owner,
      ),
    ).toThrow();
    target.store.close();
  });

  test("a grant scoped to one machine opens the plugin's door for that machine alone", async () => {
    const target = await fixture();
    const agent = delegate(target);
    const door = "example.fleet.archive";

    // Rung 4 at the target: the door is offered to everybody and answers from the rows.
    expect(
      refusal(
        await target.host.dispatch(agent, door, {
          machine: { kind: "machine", machineId: target.here },
        }),
      ),
    ).toBe(`${ARCHIVE} capability required at target`);
    // Root is not an exception, which is the wildcard rule arriving at the door.
    expect(
      refusal(
        await target.host.dispatch(target.owner, door, {
          machine: { kind: "machine", machineId: target.here },
        }),
      ),
    ).toBe(`${ARCHIVE} capability required at target`);

    target.auth.grant(
      {
        principal: { kind: "principal", id: agent.principal.id },
        node: machineUri(target.here),
        caps: [ARCHIVE],
        effect: "allow",
        reach: "subtree",
      },
      target.owner,
    );

    expect(
      await target.host.dispatch(agent, door, {
        machine: { kind: "machine", machineId: target.here },
      }),
    ).toEqual({ ok: true, result: { machineId: target.here } });
    // The same credential, the same door, the other machine: the row is the whole difference.
    expect(
      refusal(
        await target.host.dispatch(agent, door, {
          machine: { kind: "machine", machineId: target.there },
        }),
      ),
    ).toBe(`${ARCHIVE} capability required at target`);
    target.store.close();
  });

  test("the roster publishes the declaration, so a reader learns the capability exists", async () => {
    const target = await fixture();

    const row = target.host.roster().find((entry) => entry.manifest.id === "example.fleet");
    expect(row?.manifest.capabilities).toEqual([ARCHIVE]);
    expect(row?.actions[0]).toMatchObject({
      name: "example.fleet.archive",
      caps: [ARCHIVE],
      requirements: [{ cap: ARCHIVE, target: ["machine"] }],
    });
    target.store.close();
  });

  test("the mint refuses what a credential cannot carry", async () => {
    const target = await fixture();

    /*
      A plugin capability is held by a row at a node, never minted into a credential (ADR
      0035): the flat cap array is the engine's vocabulary, which is what lets a plugin's
      authority over one machine be administered without re-minting anybody's token. The mint
      parses its request, so the refusal names the field rather than the door.
    */
    expect(() =>
      target.auth.mintToken(
        { principal: { name: "agent", kind: "agent" }, caps: [ARCHIVE] } as never,
        target.owner,
      ),
    ).toThrow(/caps/);
    target.store.close();
  });
});
