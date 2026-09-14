import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService } from "../src/auth.ts";
import { openDatabase } from "../src/db.ts";
import { ServerStore, sha256Hex } from "../src/stores.ts";

const revision = sha256Hex("current migration policy");
const priorRevision = sha256Hex("previous migration policy");
const now = 1_000_000;
const expiry = now + 180_000;

/** A real v36 shape, not a current schema relabelled as an older version. */
function seedV36(path: string): void {
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec(`
CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
INSERT INTO meta VALUES ('schema_version','36'),('agent-runs:declarations-after-event-id','42');
CREATE TABLE principals(id TEXT PRIMARY KEY,kind TEXT,name TEXT,color TEXT,created_at INTEGER,origin TEXT);
CREATE TABLE tokens(id TEXT PRIMARY KEY,hash TEXT UNIQUE,principal_id TEXT,caps TEXT,
  container_id TEXT,created_at INTEGER,revoked_at INTEGER,minted_by TEXT,grant_id TEXT,expires_at INTEGER);
CREATE TABLE grants(id TEXT PRIMARY KEY,principal_kind TEXT,principal_id TEXT,node TEXT,caps TEXT,
  effect TEXT,reach TEXT,created_by TEXT,created_at INTEGER);
CREATE TABLE machine_job_revisions(kind TEXT NOT NULL,identity TEXT NOT NULL,revision INTEGER NOT NULL,
  digest TEXT NOT NULL,PRIMARY KEY(kind,identity));
CREATE TRIGGER job_token_update AFTER UPDATE ON tokens BEGIN
  INSERT INTO machine_job_revisions VALUES ('credential',NEW.id,1,'')
    ON CONFLICT(kind,identity) DO UPDATE SET revision=revision+1,digest='';
END;
CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,container_id TEXT,ts INTEGER,
  principal_id TEXT,type TEXT,payload TEXT,door TEXT,authority TEXT,targets TEXT,outcome TEXT,session TEXT);
CREATE TABLE agent_runs(
  id TEXT PRIMARY KEY,principal_id TEXT NOT NULL UNIQUE,root_run_id TEXT NOT NULL,parent_run_id TEXT,
  authorized_by_principal_id TEXT NOT NULL,
  authorization_path TEXT NOT NULL CHECK(authorization_path IN ('owner_key','principal')),
  authorizer_token_id TEXT,authorizer_grant_id TEXT,authorizer_caps TEXT NOT NULL,
  authorizer_container_scope TEXT,authorizer_expires_at INTEGER,purpose TEXT NOT NULL,task_ref TEXT,
  target TEXT NOT NULL,reach TEXT NOT NULL CHECK(reach IN ('node','subtree')),caps TEXT NOT NULL,
  created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,renewals INTEGER NOT NULL,
  max_depth INTEGER NOT NULL,max_descendants INTEGER NOT NULL,depth INTEGER NOT NULL,
  cleanup_owner_principal_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending_policy','active','policy_stale','completed','failed',
    'cancelled','abandoned','expired','revoked','cleanup_failed')),
  policy_revision TEXT NOT NULL,acknowledged_policy_revision TEXT,
  cleanup_revoked_credentials INTEGER NOT NULL DEFAULT 0,cleanup_revoked_grants INTEGER NOT NULL DEFAULT 0,
  finished_at INTEGER,cleanup_failure TEXT
);
CREATE INDEX agent_runs_root_depth ON agent_runs(root_run_id,depth,id);
CREATE INDEX agent_runs_parent ON agent_runs(parent_run_id,id);
CREATE TABLE agent_run_policy_snapshots(run_id TEXT NOT NULL,revision TEXT NOT NULL,
  bundles TEXT NOT NULL,issued_at INTEGER NOT NULL,acknowledged_at INTEGER,PRIMARY KEY(run_id,revision));
CREATE TABLE machine_jobs(job_id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,plugin_id TEXT NOT NULL,
  digest TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL,permit TEXT,result TEXT,
  created_at INTEGER NOT NULL,audit_origin TEXT,decision_id TEXT,cancel_reason TEXT,
  event_seq INTEGER NOT NULL DEFAULT 0,owner_closed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE job_schedule_occurrences(job_id TEXT PRIMARY KEY,request TEXT,nominal INTEGER,state TEXT);
CREATE TABLE terminals(id TEXT PRIMARY KEY,machine_id TEXT,container_id TEXT,created_by TEXT,
  status TEXT,exit_code INTEGER,created_at INTEGER);
INSERT INTO principals VALUES ('sponsor','human','Sponsor','#112233',1,NULL),
  ('agent-a','agent','Worker','#112233',2,NULL),('agent-b','agent','Child','#223344',3,NULL),
  ('agent-c','agent','Worker','#334455',4,NULL),('agent-d','agent','Worker-2','#445566',5,NULL);
`);
    const insertRun = db.query(`INSERT INTO agent_runs(
      id,principal_id,root_run_id,parent_run_id,authorized_by_principal_id,authorization_path,
      authorizer_token_id,authorizer_grant_id,authorizer_caps,authorizer_container_scope,authorizer_expires_at,
      purpose,task_ref,target,reach,caps,created_at,expires_at,renewals,max_depth,max_descendants,depth,
      cleanup_owner_principal_id,state,policy_revision,acknowledged_policy_revision,
      cleanup_revoked_credentials,cleanup_revoked_grants,finished_at,cleanup_failure
    ) VALUES (?,?,?,?,?,'principal',?,?,?,NULL,?,'Inspect safely','external-task',
      'manifold://container/room','subtree',?, ?,?,1,3,9,?,'sponsor',?,?,?,2,1,?,?)`);
    const caps = JSON.stringify(["containers:read"]);
    for (const [id, principal, parent, sponsor, token, grant, state, depth] of [
      ["root", "agent-a", null, "sponsor", "sponsor-token", "sponsor-grant", "active", 0],
      ["child", "agent-b", "root", "agent-a", "root-token", "root-grant", "completed", 1],
      ["peer", "agent-c", null, "sponsor", "sponsor-token", "sponsor-grant", "revoked", 0],
      ["named", "agent-d", null, "sponsor", "sponsor-token", "sponsor-grant", "pending_policy", 0],
    ] as const) {
      insertRun.run(
        id,
        principal,
        parent === null ? id : "root",
        parent,
        sponsor,
        token,
        grant,
        caps,
        expiry + 60_000,
        caps,
        now,
        expiry,
        depth,
        state,
        revision,
        state === "pending_policy" ? null : revision,
        state === "completed" ? now + 20_000 : null,
        state === "completed" ? "cleanup receipt retained" : null,
      );
      db.query("INSERT INTO agent_run_policy_snapshots VALUES (?,?,?,?,?)").run(
        id,
        revision,
        JSON.stringify([
          { id: "operator", source: "operator", digest: revision, body: "Inspect safely." },
        ]),
        now,
        state === "pending_policy" ? null : now + 1,
      );
    }
    db.query("INSERT INTO agent_run_policy_snapshots VALUES (?,?,?,?,?)").run(
      "root",
      priorRevision,
      JSON.stringify([
        { id: "operator", source: "operator", digest: priorRevision, body: "Prior policy." },
      ]),
      now - 10,
      now - 9,
    );
    for (const [id, principal, minter, revoked, grant] of [
      ["sponsor-token", "sponsor", "sponsor", null, "sponsor-grant"],
      ["root-old", "agent-a", "sponsor", now - 1, null],
      ["root-token", "agent-a", "sponsor", null, "root-grant"],
      ["child-token", "agent-b", "agent-a", now + 20_000, null],
    ] as const) {
      db.query("INSERT INTO tokens VALUES (?,?,?,?,?,?,?,?,?,?)").run(
        id,
        sha256Hex(id),
        principal,
        caps,
        null,
        now - 100,
        revoked,
        minter,
        grant,
        expiry,
      );
      if (grant !== null)
        db.query("INSERT INTO grants VALUES (?,?,?,?,?,?,?,?,?)").run(
          grant,
          "principal",
          principal,
          "manifold://container/room",
          caps,
          "allow",
          "subtree",
          minter,
          now - 100,
        );
    }
    for (const [id, principal, declaration, session] of [
      [42, "agent-a", "untrusted old claim", "root-connection"],
      [43, "agent-b", "trusted child claim", "child-connection"],
      [44, "sponsor", "unrelated claim", null],
    ] as const)
      db.query(
        "INSERT INTO events VALUES (?,NULL,?,?,'trace',?,'core.containers.list','containers:read','[]','ok',?)",
      ).run(
        id,
        now,
        principal,
        JSON.stringify({ agentDeclaration: declaration, privateDetail: "omitted" }),
        session,
      );
    const request = JSON.stringify({
      machineId: "machine",
      pluginId: "core.terminals",
      operationId: "run",
      installationRevision: "install",
      artifactSha256: sha256Hex("artifact"),
      traceId: "40",
      credential: { principalId: "agent-a", tokenId: "already-pruned-token" },
      terminal: { terminalId: "legacy-terminal" },
    });
    db.query(
      `INSERT INTO machine_jobs(job_id,machine_id,plugin_id,digest,request,state,created_at)
      VALUES ('legacy-job','machine','core.terminals','digest',?,'finished',?)`,
    ).run(request, now);
    db.query("INSERT INTO job_schedule_occurrences VALUES ('legacy-occurrence',?,?,'queued')").run(
      request,
      now,
    );
    db.query(
      "INSERT INTO terminals VALUES ('legacy-terminal','machine','room','agent-a','exited',0,?)",
    ).run(now);
  } finally {
    db.close();
  }
}

describe("migration 37: durable agents", () => {
  test("preserves run, sponsor, policy, credential and native history while allowing repeated runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-durable-agents-"));
    const path = join(dir, "manifold.db");
    try {
      seedV36(path);
      const original = new Database(path, { strict: true });
      const beforeRuns = original
        .query<Record<string, unknown>, []>("SELECT * FROM agent_runs ORDER BY id")
        .all();
      const beforeSnapshots = original
        .query("SELECT * FROM agent_run_policy_snapshots ORDER BY run_id,revision")
        .all();
      const beforeTokens = original
        .query<Record<string, unknown>, []>("SELECT * FROM tokens ORDER BY id")
        .all();
      const beforeEvents = original
        .query<Record<string, unknown>, []>("SELECT * FROM events ORDER BY id")
        .all();
      original.close();
      const db = openDatabase(path);
      const store = new ServerStore(db);
      try {
        expect(existsSync(`${path}.pre-v37.bak`)).toBe(true);
        expect(store.listAgents().map((agent) => [agent.agentId, agent.name])).toEqual([
          ["agent-a", "Worker"],
          ["agent-b", "Child"],
          ["agent-c", "Worker-3"],
          ["agent-d", "Worker-2"],
        ]);
        const agent = store.getAgent("agent-a")!;
        expect(agent).toMatchObject({
          principalId: "agent-a",
          sponsorPrincipalId: "sponsor",
          harness: "external",
          grant: {
            caps: ["containers:read"],
            targets: ["manifold://container/room"],
            reach: "subtree",
            maxRunLifetimeMs: 180_000,
            expiresAt: expiry,
            delegation: { maxDepth: 3, maxDescendants: 9 },
          },
          authorizationPath: "principal",
          authorizationCredential: {
            tokenId: "sponsor-token",
            grantId: "sponsor-grant",
            expiresAt: expiry + 60_000,
          },
          policyRevisionAcknowledged: revision,
        });
        expect(store.getAgent("agent-b")?.sponsorPrincipalId).toBe("agent-a");
        expect(store.getAgent("agent-c")?.status).toBe("enabled");
        expect(store.getAgentRun("peer")?.state).toBe("revoked");
        expect(
          db
            .query("SELECT * FROM agent_runs ORDER BY id")
            .all()
            .map((row) => {
              const legacy = row as Record<string, unknown>;
              delete legacy.agent_id;
              delete legacy.session_harness;
              delete legacy.session_id;
              delete legacy.session_machine_id;
              delete legacy.model;
              delete legacy.activity;
              return legacy;
            }),
        ).toEqual(beforeRuns);
        expect(
          db.query("SELECT * FROM agent_run_policy_snapshots ORDER BY run_id,revision").all(),
        ).toEqual(beforeSnapshots);
        expect(
          db
            .query("SELECT * FROM tokens ORDER BY id")
            .all()
            .map((row) => {
              const legacy = row as Record<string, unknown>;
              delete legacy.run_id;
              delete legacy.runner_agent_id;
              return legacy;
            }),
        ).toEqual(beforeTokens);
        expect(
          db
            .query("SELECT * FROM events ORDER BY id")
            .all()
            .map((row) => {
              const legacy = row as Record<string, unknown>;
              delete legacy.run_id;
              delete legacy.credential_id;
              return legacy;
            }),
        ).toEqual(beforeEvents);
        expect(store.getMeta("agent-runs:declarations-after-event-id")).toBe("42");
        expect(store.getAgentRunByToken("root-old")?.id).toBe("root");
        expect(store.getAgentRunByToken("child-token")?.id).toBe("child");
        expect(store.getAgentRunByToken("sponsor-token")).toBeNull();
        const facts = store.agentRunInspectionFacts("root", { runId: "root", limit: 20 }, now, []);
        expect(facts.traces.map((trace) => trace.traceId)).toEqual(["42"]);
        expect(facts.traces[0]?.agentDeclaration).toBeUndefined();
        expect(facts.jobs.map((job) => job.jobId)).toEqual(["legacy-occurrence", "legacy-job"]);
        expect(facts.terminals.map((terminal) => terminal.terminalId)).toEqual(["legacy-terminal"]);
        expect(
          store.agentRunInspectionFacts("child", { runId: "child", limit: 20 }, now, []).traces[0]
            ?.agentDeclaration,
        ).toBe("trusted child claim");
        const root = store.getAgentRun("root")!;
        for (const id of ["next-run", "concurrent-run"])
          store.createAgentRun(
            {
              ...root,
              id,
              rootRunId: id,
              session: { harness: "external", sessionId: id, machineId: "machine" },
              model: { provider: "test-provider", model: "test-model" },
              activity: "blocked",
            },
            {
              runId: id,
              revision,
              bundles: store.getAgentPolicySnapshot("root", revision)!.bundles,
              issuedAt: now,
            },
          );
        expect(store.listAgentRuns("agent-a").map((run) => run.id)).toEqual([
          "root",
          "next-run",
          "concurrent-run",
        ]);
        expect(store.getAgentRun("next-run")).toMatchObject({
          agentId: "agent-a",
          principalId: "agent-a",
          session: { harness: "external", sessionId: "next-run", machineId: "machine" },
          model: { provider: "test-provider", model: "test-model" },
          activity: "blocked",
        });
        expect(
          store.agentRunInspectionFacts("next-run", { runId: "next-run", limit: 20 }, now, []),
        ).toMatchObject({ traces: [], credentials: [], jobs: [], terminals: [] });
        const token = store.getToken("root-token")!;
        for (const id of ["next-token", "concurrent-token", "runner-token"])
          store.createToken({
            ...token,
            id,
            hash: sha256Hex(id),
            grantId: null,
          });
        store.bindAgentRunCredential("next-run", "next-token");
        store.bindAgentRunCredential("concurrent-run", "concurrent-token");
        store.bindAgentRunnerCredential("agent-a", "runner-token");
        expect(() => store.bindAgentRunCredential("next-run", "runner-token")).toThrow();
        expect(() => store.bindAgentRunCredential("child", "concurrent-token")).toThrow();
        const traceId = store.appendTrace({
          ts: now + 1,
          actor: "agent-a",
          authority: "containers:read",
          door: "core.containers.list",
          containerId: null,
          payload: {},
          session: "next-connection",
          targets: [],
          outcome: "ok",
          runId: "next-run",
          credentialId: "next-token",
        });
        expect(
          store
            .agentRunInspectionFacts("next-run", { runId: "next-run", limit: 20 }, now, [])
            .traces.map((trace) => trace.traceId),
        ).toEqual([String(traceId)]);
        expect(
          store.agentRunInspectionFacts(
            "concurrent-run",
            {
              runId: "concurrent-run",
              traceId: String(traceId),
              limit: 20,
            },
            now,
            [],
          ).requestedTrace,
        ).toBe("unavailable");
        expect(store.revokeTokensByAgentRun("next-run", now + 2)).toEqual({ tokens: 1, grants: 0 });
        expect(store.getToken("next-token")?.revokedAt).toBe(now + 2);
        expect(store.getToken("concurrent-token")?.revokedAt).toBeNull();
        expect(store.getToken("runner-token")?.revokedAt).toBeNull();
        expect(store.getToken("root-token")?.revokedAt).toBeNull();
        expect(store.getAgentByRunnerToken("runner-token")?.agentId).toBe("agent-a");
        expect(store.getAgentRunByToken("runner-token")).toBeNull();
        const launchedRequest = JSON.stringify({
          machineId: "machine",
          pluginId: "core.terminals",
          operationId: "run",
          installationRevision: "install",
          artifactSha256: sha256Hex("artifact"),
          traceId: "42",
          credential: { principalId: "agent-a", tokenId: "root-token" },
          terminal: { terminalId: "next-terminal", runId: "next-run" },
        });
        db.query(
          `INSERT INTO machine_jobs(job_id,machine_id,plugin_id,digest,request,state,created_at)
          VALUES ('next-job','machine','core.terminals','next-digest',?,'finished',?)`,
        ).run(launchedRequest, now + 1);
        db.query(
          `INSERT INTO terminals(id,machine_id,container_id,created_by,status,exit_code,created_at)
          VALUES ('next-terminal','machine','room','agent-a','exited',0,?)`,
        ).run(now + 1);
        const launched = store.agentRunInspectionFacts(
          "next-run",
          { runId: "next-run", limit: 20 },
          now,
          [],
        );
        expect(launched.jobs.map((job) => [job.jobId, job.origin])).toEqual([
          ["next-job", "retained"],
        ]);
        expect(
          launched.terminals.map((terminal) => [terminal.terminalId, terminal.traceId]),
        ).toEqual([["next-terminal", "42"]]);
        const sponsorFacts = store.agentRunInspectionFacts(
          "root",
          { runId: "root", limit: 20 },
          now,
          [],
        );
        expect(sponsorFacts.jobs.map((job) => job.jobId)).toEqual([
          "legacy-occurrence",
          "legacy-job",
        ]);
        expect(sponsorFacts.terminals.map((terminal) => terminal.terminalId)).toEqual([
          "legacy-terminal",
        ]);
        for (const outcome of [null, "failed", "refused"] as const)
          store.appendTrace({
            ts: now + 1,
            actor: "agent-a",
            authority: "containers:read",
            door: "core.containers.list",
            containerId: null,
            payload: {},
            session: null,
            targets: [],
            outcome,
            runId: "concurrent-run",
            credentialId: "concurrent-token",
          });
        expect(store.runTraceCounts("concurrent-run")).toEqual({ actionCount: 3, refusalCount: 1 });
        expect(store.runTraceCounts("next-run")).toEqual({ actionCount: 1, refusalCount: 0 });
        expect(store.runTraceCounts("missing-run")).toEqual({ actionCount: 0, refusalCount: 0 });
        expect(store.acknowledgeAgentPolicy("named", revision, now + 10)).toBe(true);
        expect(store.getAgent("agent-d")?.policyRevisionAcknowledged).toBe(revision);
        const descendant = store.getAgentRun("child")!;
        store.createAgentRun(
          {
            ...descendant,
            id: "independent-descendant",
            rootRunId: "independent-descendant",
            parentRunId: null,
            depth: 0,
          },
          {
            runId: "independent-descendant",
            revision,
            bundles: store.getAgentPolicySnapshot("child", revision)!.bundles,
            issuedAt: now,
          },
        );
        expect(
          [...store.agentRunInspectionCandidates("sponsor", false)].map((run) => run.id),
        ).toContain("independent-descendant");
        expect([...store.agentRunInspectionCandidates("unrelated-principal", false)]).toEqual([]);
        store.updateAgent({ ...store.getAgent("agent-a")!, sponsorPrincipalId: "agent-b" });
        expect(
          [...store.agentRunInspectionCandidates("agent-a", false)].filter(
            (run) => run.id === "independent-descendant",
          ),
        ).toHaveLength(1);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a migrated child retains ordinary authority through its renewed parent without rewriting attribution", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-durable-agents-renewed-parent-"));
    const path = join(dir, "manifold.db");
    const parentCaps = ["containers:read", "agents:delegate"];
    const originalExpiry = now + 90_000;
    const renewedAt = now + 1_000;
    try {
      seedV36(path);
      const fixture = new Database(path, { strict: true });
      try {
        // Renewal in v36 replaced the parent's token and grant, not the child's historical
        // authorizer. Keep the pre-cutover schema and the child's still-live credential.
        fixture
          .query("UPDATE tokens SET caps=? WHERE principal_id IN ('sponsor','agent-a')")
          .run(JSON.stringify(parentCaps));
        fixture
          .query("UPDATE grants SET caps=? WHERE principal_id IN ('sponsor','agent-a')")
          .run(JSON.stringify(parentCaps));
        fixture
          .query("UPDATE agent_runs SET caps=?,authorizer_caps=? WHERE id='root'")
          .run(JSON.stringify(parentCaps), JSON.stringify(parentCaps));
        fixture
          .query(
            `UPDATE agent_runs SET state='active',cleanup_revoked_credentials=0,
          cleanup_revoked_grants=0,finished_at=NULL,cleanup_failure=NULL WHERE id IN ('root','child')`,
          )
          .run();
        fixture.query("UPDATE agent_runs SET authorizer_expires_at=? WHERE id='root'").run(expiry);
        fixture
          .query(
            `UPDATE agent_runs SET authorizer_caps=?,authorizer_container_scope='room',
          authorizer_expires_at=?,expires_at=?,renewals=0 WHERE id='child'`,
          )
          .run(JSON.stringify(parentCaps), originalExpiry, originalExpiry);
        fixture
          .query(
            `UPDATE tokens SET revoked_at=NULL,grant_id='child-grant',container_id='room',
          created_at=?,expires_at=? WHERE id='child-token'`,
          )
          .run(now, originalExpiry);
        fixture
          .query(
            `INSERT INTO grants SELECT 'child-grant','principal','agent-b',node,?,effect,reach,
          'agent-a',? FROM grants WHERE id='root-grant'`,
          )
          .run(JSON.stringify(["containers:read"]), now);
        fixture
          .query(
            `INSERT INTO grants SELECT 'root-renewed-grant',principal_kind,principal_id,node,caps,
          effect,reach,created_by,? FROM grants WHERE id='root-grant'`,
          )
          .run(renewedAt);
        fixture
          .query(
            `INSERT INTO tokens SELECT 'root-renewed',?,principal_id,caps,'room',?,NULL,minted_by,
          'root-renewed-grant',expires_at FROM tokens WHERE id='root-token'`,
          )
          .run(sha256Hex("root-renewed"), renewedAt);
        fixture
          .query(
            `UPDATE tokens SET revoked_at=?,grant_id=NULL,container_id='room',expires_at=?
          WHERE id='root-token'`,
          )
          .run(renewedAt, originalExpiry);
        fixture.exec("DELETE FROM grants WHERE id='root-grant'");
      } finally {
        fixture.close();
      }
      const store = new ServerStore(openDatabase(path));
      try {
        let nextId = 0;
        const auth = new AuthService(store, "e".repeat(64), {
          newId: () => `migration-${++nextId}`,
          now: () => renewedAt + 1,
        });
        const parent = auth.authenticate("root-renewed");
        const child = auth.authenticate("child-token");
        for (const actor of [parent, child]) {
          const policy = auth.agentPolicyChallenge(actor);
          auth.acknowledgeAgentPolicy(
            {
              revision: policy.revision,
              acknowledgements: policy.required.map(({ id, digest }) => ({ id, digest })),
            },
            actor,
          );
        }
        expect(() => auth.authenticate("root-token")).toThrow("revoked");
        expect(auth.allows(parent, "containers:read", "room")).toBe(true);
        expect(auth.allows(child, "containers:read", "room")).toBe(true);
        const historicalCredential = {
          tokenId: "root-token",
          grantId: "root-grant",
          caps: parentCaps,
          containerScope: "room",
          expiresAt: originalExpiry,
        };
        expect(store.getAgent("agent-b")).toMatchObject({
          sponsorPrincipalId: "agent-a",
          authorizationCredential: historicalCredential,
        });
        expect(store.getAgentRun("child")).toMatchObject({
          parentRunId: "root",
          authorizedByPrincipalId: "agent-a",
          authorizationCredential: historicalCredential,
        });
        store.revokeTokensByAgentRun("root", renewedAt + 2);
        expect(auth.allows(child, "containers:read", "room")).toBe(false);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reopening migration 37 retains runs and history without repeating principal backfill", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-durable-agents-reopen-"));
    const path = join(dir, "manifold.db");
    try {
      seedV36(path);
      let store = new ServerStore(openDatabase(path));
      try {
        const root = store.getAgentRun("root")!;
        store.createAgentRun(
          {
            ...root,
            id: "later-run",
            rootRunId: "later-run",
            session: { harness: "external", sessionId: "later-session", machineId: "machine" },
          },
          {
            runId: "later-run",
            revision,
            bundles: store.getAgentPolicySnapshot("root", revision)!.bundles,
            issuedAt: now + 1,
          },
        );
        store.createToken({
          ...store.getToken("root-token")!,
          id: "later-runner",
          hash: sha256Hex("later-runner"),
          grantId: null,
        });
        store.bindAgentRunnerCredential("agent-a", "later-runner");
        const agents = store.listAgents();
        const runs = agents.flatMap((agent) => store.listAgentRuns(agent.agentId));
        const history = store.agentRunInspectionFacts(
          "root",
          { runId: "root", limit: 20 },
          now,
          [],
        );
        store.close();
        store = new ServerStore(openDatabase(path));
        expect(store.listAgents()).toEqual(agents);
        expect(agents.flatMap((agent) => store.listAgentRuns(agent.agentId))).toEqual(runs);
        expect(store.getAgentByRunnerToken("later-runner")?.agentId).toBe("agent-a");
        expect(store.getAgentRunByToken("later-runner")).toBeNull();
        expect(
          store.agentRunInspectionFacts("root", { runId: "root", limit: 20 }, now, []),
        ).toEqual(history);
        expect(store.getAgentPolicySnapshot("root", priorRevision)?.acknowledgedAt).toBe(now - 9);
        expect(store.getAgentPolicySnapshot("later-run", revision)?.issuedAt).toBe(now + 1);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects partial typed SessionRef inserts after migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-durable-agents-session-binding-"));
    const path = join(dir, "manifold.db");
    try {
      seedV36(path);
      const db = openDatabase(path);
      try {
        const insert = db.query(`INSERT INTO agent_runs(
          id,principal_id,root_run_id,authorized_by_principal_id,authorization_path,authorizer_caps,
          purpose,target,reach,caps,created_at,expires_at,renewals,max_depth,max_descendants,depth,
          cleanup_owner_principal_id,state,policy_revision,agent_id,activity,
          session_harness,session_id,session_machine_id
        ) SELECT 'partial-session',principal_id,root_run_id,authorized_by_principal_id,
          authorization_path,authorizer_caps,purpose,target,reach,caps,created_at,expires_at,
          renewals,max_depth,max_descendants,depth,cleanup_owner_principal_id,state,policy_revision,
          agent_id,activity,?,?,? FROM agent_runs WHERE id='root'`);
        for (const binding of [
          ["external", null, null],
          [null, "session", null],
          [null, null, "machine"],
          ["external", "session", null],
          ["external", null, "machine"],
          [null, "session", "machine"],
        ] as const) {
          expect(() => insert.run(...binding)).toThrow("CHECK constraint failed");
        }
        expect(db.query("SELECT id FROM agent_runs WHERE id='partial-session'").get()).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rolls back a lossy backfill before removing principal uniqueness", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-durable-agents-rollback-"));
    const path = join(dir, "manifold.db");
    try {
      seedV36(path);
      const fixture = new Database(path, { strict: true });
      fixture.exec(`CREATE TRIGGER lose_snapshot AFTER UPDATE ON tokens WHEN NEW.id='root-old'
        BEGIN DELETE FROM agent_run_policy_snapshots WHERE run_id='child'; END;`);
      fixture.close();
      expect(() => openDatabase(path)).toThrow("backfill row count mismatch");
      const restored = new Database(path, { strict: true });
      try {
        expect(
          restored
            .query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema_version'")
            .get()?.value,
        ).toBe("36");
        expect(
          restored.query("SELECT * FROM agent_run_policy_snapshots WHERE run_id='child'").all(),
        ).toHaveLength(1);
        expect(
          restored.query("SELECT name FROM sqlite_master WHERE name='agents'").get(),
        ).toBeNull();
        expect(() =>
          restored.exec(
            "INSERT INTO agent_runs SELECT 'duplicate',principal_id,root_run_id,parent_run_id,authorized_by_principal_id,authorization_path,authorizer_token_id,authorizer_grant_id,authorizer_caps,authorizer_container_scope,authorizer_expires_at,purpose,task_ref,target,reach,caps,created_at,expires_at,renewals,max_depth,max_descendants,depth,cleanup_owner_principal_id,state,policy_revision,acknowledged_policy_revision,cleanup_revoked_credentials,cleanup_revoked_grants,finished_at,cleanup_failure FROM agent_runs WHERE id='root'",
          ),
        ).toThrow("UNIQUE constraint failed");
      } finally {
        restored.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
