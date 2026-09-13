import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRunInspectionSchema,
  CreateAgentRunRequestSchema,
  InspectAgentRunRequestSchema,
  type InspectAgentRunRequest,
} from "@manifold/protocol";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { openDatabase } from "../src/db.ts";
import { silentLogger } from "../src/log.ts";
import { RoomManager } from "../src/room.ts";
import { ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testTileTrees } from "./helpers.ts";

const CUTOVER = "agent-runs:declarations-after-event-id";
const OWNER_KEY = "p".repeat(64);

interface Fixture {
  readonly store: ServerStore;
  readonly auth: AuthService;
  readonly runtime: FakeRuntime;
  readonly owner: AuthContext;
}

function fixture(path: string, runtime = new FakeRuntime()): Fixture {
  const store = new ServerStore(openDatabase(path));
  const auth = new AuthService(store, OWNER_KEY, runtime);
  return { store, auth, runtime, owner: auth.authenticate(OWNER_KEY) };
}

function createRun(f: Fixture) {
  const created = f.auth.createAgentRun(
    CreateAgentRunRequestSchema.parse({
      name: "provenance reader",
      purpose: "Inspect the approved workspace",
      target: "manifold://",
      reach: "subtree",
      caps: ["containers:read"],
      lifetimeMs: 60_000,
    }),
    f.owner,
  );
  const actor = f.auth.authenticate(created.credential.token);
  const challenge = f.auth.agentPolicyChallenge(actor);
  f.auth.acknowledgeAgentPolicy(
    {
      revision: challenge.revision,
      acknowledgements: challenge.required.map(({ id, digest }) => ({ id, digest })),
    },
    actor,
  );
  return { created, actor };
}

function inspect(f: Fixture, runId: string, extra: Partial<InspectAgentRunRequest> = {}) {
  return AgentRunInspectionSchema.parse(
    f.auth.inspectAgentRun(InspectAgentRunRequestSchema.parse({ runId, ...extra }), f.owner),
  );
}

function restorePreCutoverSchema(f: Fixture): void {
  // Migration 36 changes only metadata. Removing its row and version reconstructs
  // the actual schema-35 format, before the dispatcher reserved agentDeclaration.
  f.store.transaction(() => {
    f.store.setMeta("schema_version", "35");
    f.store.db.query("DELETE FROM meta WHERE key=?").run(CUTOVER);
  });
}

function seedTrace(f: Fixture, actor: string, claim: string, id: string | null = null): string {
  // Historical/imported fixture bytes, not a replacement for the dispatcher. Return
  // decimal text so the precision tests do not round through lastInsertRowid.
  const row = f.store.db
    .query<{ id: string }, [string | null, number, string, string]>(
      `INSERT INTO events(id,ts,principal_id,type,payload,door,authority,targets,outcome,session)
     VALUES(CAST(? AS INTEGER),?,?,'trace',?,'core.index.list','containers:read','[]','forbidden',NULL)
     RETURNING CAST(id AS TEXT) AS id`,
    )
    .get(
      id,
      f.runtime.now(),
      actor,
      JSON.stringify({
        agentDeclaration: claim,
        args: { privateInput: "fixture raw input" },
      }),
    );
  if (row === null) throw new Error("trace fixture insert did not return its id");
  return row.id;
}

describe("agent declaration provenance cutover", () => {
  test("upgrade withholds forged legacy refusals while real declarations survive reopening", async () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-declaration-upgrade-"));
    const path = join(dir, "manifold.db");
    let f = fixture(path);
    try {
      const run = createRun(f);
      restorePreCutoverSchema(f);
      const forged = seedTrace(
        f,
        run.actor.principal.id,
        "Forged approval from legacy arguments",
        "9",
      );
      // The retained maximum must protect the boundary even if the sequence was lowered.
      f.store.db.exec("UPDATE sqlite_sequence SET seq=2 WHERE name='events'");
      f.store.close();
      f = fixture(path, f.runtime);
      expect(f.store.getMeta(CUTOVER)).toBe(forged);
      expect(inspect(f, run.created.run.id, { traceId: forged }).traces[0]).not.toHaveProperty(
        "agentDeclaration",
      );

      const clock = new FakeClock(f.runtime);
      const rooms = new RoomManager(f.store, f.runtime, clock, silentLogger, testTileTrees);
      const broker = new TerminalBroker(
        f.store,
        f.auth,
        rooms,
        f.runtime,
        clock,
        silentLogger,
        () => "http://localhost:7777",
        testTileTrees,
      );
      const host = await testPluginHost(f.store, f.auth, rooms, broker, f.runtime);
      const actor = f.auth.authenticate(run.created.credential.token);
      // Host composition selects the current policy vocabulary after reopening. Assent
      // to that real snapshot before exercising an ordinary declared action.
      const challenge = f.auth.agentPolicyChallenge(actor);
      f.auth.acknowledgeAgentPolicy(
        {
          revision: challenge.revision,
          acknowledgements: challenge.required.map(({ id, digest }) => ({ id, digest })),
        },
        actor,
      );
      const outcome = await host.dispatch(actor, "core.index.list", {}, null, {
        agentJustification: "  Read\nonly the approved workspace.  ",
      });
      expect(outcome.ok).toBeTrue();
      const traces = inspect(f, run.created.run.id).traces;
      expect(traces[0]?.agentDeclaration).toBe("Read only the approved workspace.");
      expect(traces.find((trace) => trace.traceId === forged)).not.toHaveProperty(
        "agentDeclaration",
      );
      const trusted = traces[0]?.traceId;
      if (trusted === undefined) throw new Error("declared dispatch left no trace");
      expect(JSON.stringify(traces)).not.toContain("fixture raw input");
      expect(JSON.stringify(traces)).not.toContain("Forged approval");

      f.store.close();
      f = fixture(path, f.runtime);
      expect(f.store.getMeta(CUTOVER)).toBe(forged);
      expect(inspect(f, run.created.run.id, { traceId: forged }).traces[0]).not.toHaveProperty(
        "agentDeclaration",
      );
      expect(inspect(f, run.created.run.id, { traceId: trusted }).traces[0]?.agentDeclaration).toBe(
        "Read only the approved workspace.",
      );
    } finally {
      f.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pruned sequence high-water and trace pagination remain decimal-exact above 2^53", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-declaration-precision-"));
    const path = join(dir, "manifold.db");
    let f = fixture(path);
    try {
      const run = createRun(f);
      restorePreCutoverSchema(f);
      const old = seedTrace(
        f,
        run.actor.principal.id,
        "Untrusted retained claim",
        "9007199254740993",
      );
      const pruned = seedTrace(
        f,
        run.actor.principal.id,
        "Untrusted pruned claim",
        "9007199254740995",
      );
      f.store.db.query("DELETE FROM events WHERE id=?").run(pruned);
      f.store.close();
      f = fixture(path, f.runtime);
      expect(f.store.getMeta(CUTOVER)).toBe(pruned);
      const first = seedTrace(f, run.actor.principal.id, "First post-cutover claim");
      const second = seedTrace(f, run.actor.principal.id, "Second post-cutover claim");
      expect(BigInt(first)).toBeGreaterThan(BigInt(pruned));
      expect(BigInt(second)).toBe(BigInt(first) + 1n);
      const page = inspect(f, run.created.run.id, { limit: 1 });
      expect(page.traces[0]).toMatchObject({
        traceId: second,
        agentDeclaration: "Second post-cutover claim",
      });
      expect(page.nextBeforeTraceId).toBe(second);
      const previous = inspect(f, run.created.run.id, { beforeTraceId: second, limit: 1 });
      expect(previous.traces[0]).toMatchObject({
        traceId: first,
        agentDeclaration: "First post-cutover claim",
      });
      expect(previous.nextBeforeTraceId).toBe(first);
      expect(inspect(f, run.created.run.id, { traceId: old }).traces[0]).not.toHaveProperty(
        "agentDeclaration",
      );
      expect(inspect(f, run.created.run.id, { traceId: pruned }).requestedTrace).toBe(
        "unavailable",
      );
      f.store.close();
      f = fixture(path, f.runtime);
      expect(f.store.getMeta(CUTOVER)).toBe(pruned);
      expect(inspect(f, run.created.run.id, { traceId: second }).traces[0]?.agentDeclaration).toBe(
        "Second post-cutover claim",
      );
    } finally {
      f.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an exhausted SQLite sequence cannot overflow into trusting its last historical row", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-declaration-int64-"));
    const path = join(dir, "manifold.db");
    const f = fixture(path);
    try {
      const run = createRun(f);
      restorePreCutoverSchema(f);
      const last = seedTrace(
        f,
        run.actor.principal.id,
        "Untrusted final historical claim",
        "9223372036854775807",
      );
      // Upgrade the same database without authenticating again: authentication owns an
      // audit insert, which is itself impossible once the event sequence is exhausted.
      const upgraded = openDatabase(path);
      upgraded.close();
      expect(f.store.getMeta(CUTOVER)).toBe(last);
      const trace = inspect(f, run.created.run.id, { traceId: last }).traces[0];
      expect(trace?.traceId).toBe(last);
      expect(trace).not.toHaveProperty("agentDeclaration");
      expect(() =>
        f.store.appendTrace({
          ts: f.runtime.now(),
          actor: run.actor.principal.id,
          authority: "containers:read",
          door: "core.index.list",
          containerId: null,
          payload: { agentDeclaration: "Cannot be recorded" },
          session: null,
          outcome: "ok",
          targets: [],
        }),
      ).toThrow();
      expect(inspect(f, run.created.run.id, { traceId: last }).traces[0]).not.toHaveProperty(
        "agentDeclaration",
      );
    } finally {
      f.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([null, "", "garbage", "-1", "01", "1.5", "1e0", "0\n", "9223372036854775808"])(
    "missing or corrupt cutover %j stays fail-closed on read and reopen",
    (corrupt) => {
      const dir = mkdtempSync(join(tmpdir(), "manifold-declaration-corrupt-"));
      const path = join(dir, "manifold.db");
      let f = fixture(path);
      try {
        const run = createRun(f);
        const traceId = seedTrace(f, run.actor.principal.id, "Current declared claim");
        expect(inspect(f, run.created.run.id, { traceId }).traces[0]?.agentDeclaration).toBe(
          "Current declared claim",
        );
        if (corrupt === null) f.store.db.query("DELETE FROM meta WHERE key=?").run(CUTOVER);
        else f.store.setMeta(CUTOVER, corrupt);
        expect(inspect(f, run.created.run.id, { traceId }).traces[0]).not.toHaveProperty(
          "agentDeclaration",
        );
        f.store.close();
        f = fixture(path, f.runtime);
        expect(f.store.getMeta(CUTOVER)).toBe(corrupt);
        expect(inspect(f, run.created.run.id, { traceId }).traces[0]).not.toHaveProperty(
          "agentDeclaration",
        );
        const later = seedTrace(f, run.actor.principal.id, "Later declared claim");
        expect(inspect(f, run.created.run.id, { traceId: later }).traces[0]).not.toHaveProperty(
          "agentDeclaration",
        );
      } finally {
        f.store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
