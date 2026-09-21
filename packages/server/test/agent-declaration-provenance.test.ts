import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRunInspectionSchema,
  InspectRunRequestSchema,
  type InspectRunRequest,
} from "@manifold/protocol";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { openDatabase } from "../src/db.ts";
import { silentLogger } from "../src/log.ts";
import { RoomManager } from "../src/room.ts";
import { ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testTileTrees } from "./helpers.ts";
import { createExternalRun } from "./agent-fixtures.ts";

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
  const created = createExternalRun(f, {
    name: "provenance reader",
    purpose: "Inspect the approved workspace",
    target: "manifold://",
    reach: "subtree",
    caps: ["containers:read"],
    lifetimeMs: 60_000,
  });
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

function inspect(f: Fixture, runId: string, extra: Partial<InspectRunRequest> = {}) {
  return AgentRunInspectionSchema.parse(
    f.auth.inspectRun(InspectRunRequestSchema.parse({ runId, ...extra }), f.owner),
  );
}

function restorePreCutoverSchema(f: Fixture): void {
  // Replay the real v35 upgrade, not a current schema with an old label.
  // This fixture has one run per Agent, so restoring legacy principal uniqueness is safe.
  f.store.transaction(() => {
    f.store.db.exec(`
      DELETE FROM grants WHERE id IN (SELECT grant_id FROM tokens WHERE runner_agent_id IS NOT NULL);
      DELETE FROM tokens WHERE runner_agent_id IS NOT NULL;
      DROP INDEX tokens_runner_agent;
      DROP INDEX tokens_agent_run;
      DROP INDEX events_agent_run;
      DROP INDEX machine_jobs_agent_run;
      DROP INDEX job_schedule_occurrences_agent_run;
      DROP INDEX terminals_agent_run;
      CREATE TABLE agent_runs_v35(
        id TEXT PRIMARY KEY,principal_id TEXT NOT NULL UNIQUE,root_run_id TEXT NOT NULL,parent_run_id TEXT,
        authorized_by_principal_id TEXT NOT NULL,
        authorization_path TEXT NOT NULL CHECK(authorization_path IN ('owner_key','principal')),
        authorizer_token_id TEXT,authorizer_grant_id TEXT,authorizer_caps TEXT NOT NULL,
        authorizer_container_scope TEXT,authorizer_expires_at INTEGER,purpose TEXT NOT NULL,task_ref TEXT,
        target TEXT NOT NULL,reach TEXT NOT NULL CHECK(reach IN ('node','subtree')),caps TEXT NOT NULL,
        created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,renewals INTEGER NOT NULL,
        max_depth INTEGER NOT NULL,max_descendants INTEGER NOT NULL,depth INTEGER NOT NULL,
        cleanup_owner_principal_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN (
          'pending_policy','active','policy_stale','completed','failed','cancelled','abandoned',
          'expired','revoked','cleanup_failed'
        )),
        policy_revision TEXT NOT NULL,acknowledged_policy_revision TEXT,
        cleanup_revoked_credentials INTEGER NOT NULL DEFAULT 0,
        cleanup_revoked_grants INTEGER NOT NULL DEFAULT 0,finished_at INTEGER,cleanup_failure TEXT
      );
      INSERT INTO agent_runs_v35 SELECT
        id,principal_id,root_run_id,parent_run_id,authorized_by_principal_id,
        authorization_path,authorizer_token_id,authorizer_grant_id,authorizer_caps,
        authorizer_container_scope,authorizer_expires_at,purpose,task_ref,target,reach,caps,
        created_at,expires_at,renewals,max_depth,max_descendants,depth,
        cleanup_owner_principal_id,state,policy_revision,acknowledged_policy_revision,
        cleanup_revoked_credentials,cleanup_revoked_grants,finished_at,cleanup_failure
      FROM agent_runs;
      DROP TABLE agent_runs;
      ALTER TABLE agent_runs_v35 RENAME TO agent_runs;
      CREATE INDEX agent_runs_root_depth ON agent_runs(root_run_id,depth,id);
      CREATE INDEX agent_runs_parent ON agent_runs(parent_run_id,id);
      ALTER TABLE tokens DROP COLUMN runner_agent_id;
      ALTER TABLE tokens DROP COLUMN run_id;
      ALTER TABLE events DROP COLUMN run_id;
      ALTER TABLE events DROP COLUMN credential_id;
      ALTER TABLE machine_jobs DROP COLUMN run_id;
      ALTER TABLE job_schedule_occurrences DROP COLUMN run_id;
      ALTER TABLE terminals DROP COLUMN run_id;
      ALTER TABLE terminals DROP COLUMN cwd;
      ALTER TABLE terminals DROP COLUMN launch_recipe;
      ALTER TABLE terminals DROP COLUMN created_by_run_id;
      ALTER TABLE terminals DROP COLUMN session;
      DROP TABLE agents;
      DROP TABLE principal_access_pauses;
    `);
    f.store.setMeta("schema_version", "35");
    f.store.db.query("DELETE FROM meta WHERE key=?").run(CUTOVER);
  });
}

function seedTrace(
  f: Fixture,
  actor: AuthContext,
  claim: string,
  id: string | null = null,
): string {
  // Historical/imported fixture bytes, not a replacement for the dispatcher. Return
  // decimal text so the precision tests do not round through lastInsertRowid.
  const row = f.store.db
    .query<{ id: string }, [string | null, number, string, string, string]>(
      `INSERT INTO events(id,ts,principal_id,run_id,type,payload,door,authority,targets,outcome,session)
     VALUES(CAST(? AS INTEGER),?,?,?,'trace',?,'core.index.list','containers:read','[]','forbidden',NULL)
     RETURNING CAST(id AS TEXT) AS id`,
    )
    .get(
      id,
      f.runtime.now(),
      actor.principal.id,
      actor.agentRunId!,
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
      const forged = seedTrace(f, run.actor, "Forged approval from legacy arguments", "90");
      // The retained maximum must protect the boundary even if the sequence was lowered.
      f.store.db.exec("UPDATE sqlite_sequence SET seq=2 WHERE name='events'");
      restorePreCutoverSchema(f);
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
      const outcome = await host.dispatch(actor, "core.machines.list", {}, null, {
        agentJustification: "  Read\nonly the approved workspace.  ",
      });
      expect(outcome).toMatchObject({ ok: true });
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
      const old = seedTrace(f, run.actor, "Untrusted retained claim", "9007199254740993");
      const pruned = seedTrace(f, run.actor, "Untrusted pruned claim", "9007199254740995");
      f.store.db.query("DELETE FROM events WHERE id=?").run(pruned);
      restorePreCutoverSchema(f);
      f.store.close();
      f = fixture(path, f.runtime);
      expect(f.store.getMeta(CUTOVER)).toBe(pruned);
      const first = seedTrace(f, run.actor, "First post-cutover claim");
      const second = seedTrace(f, run.actor, "Second post-cutover claim");
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
      const last = seedTrace(
        f,
        run.actor,
        "Untrusted final historical claim",
        "9223372036854775807",
      );
      restorePreCutoverSchema(f);
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
          runId: run.created.run.id,
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
        const traceId = seedTrace(f, run.actor, "Current declared claim");
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
        const later = seedTrace(f, run.actor, "Later declared claim");
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
