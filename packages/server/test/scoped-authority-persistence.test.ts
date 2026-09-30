import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthorityScope, Cap, Grant } from "@manifold/protocol";
import { AuthService } from "../src/auth.ts";
import { openDatabase } from "../src/db.ts";
import {
  ServerStore,
  sha256Hex,
  type AgentRecord,
  type AgentRunRecord,
  type TokenRecord,
} from "../src/stores.ts";
import { AUTHORITY_V37_FIXTURE_SQL } from "./authority-migration-fixtures.ts";
import { FakeRuntime } from "./helpers.ts";

const root = "manifold://";
const machineA = "manifold://machine/a";
const machineB = "manifold://machine/b";
const home = "manifold://container/home";
const expiry = 900_000;
const revision = sha256Hex("durable scoped policy");
const scope: AuthorityScope = [
  { target: home, reach: "subtree", caps: ["containers:read"] },
  { target: machineA, reach: "node", caps: ["machines:shell"] },
];

function grant(id: string, node: string, caps: Grant["caps"], principalId = "human"): Grant {
  return {
    id,
    principal: { kind: "principal", id: principalId },
    node,
    caps,
    effect: "allow",
    reach: "subtree",
    createdBy: "owner",
    createdAt: 10,
  };
}

function token(id: string, grantId: string | null, caps: Cap[] = ["machines:shell"]): TokenRecord {
  return {
    id,
    hash: sha256Hex(id),
    principalId: "human",
    mintedBy: "owner",
    caps,
    containerId: null,
    createdAt: 20,
    revokedAt: null,
    grantId,
    expiresAt: expiry,
  };
}

function agent(id: string): AgentRecord {
  return {
    agentId: id,
    principalId: `${id}-principal`,
    sponsorPrincipalId: "human",
    name: id,
    purpose: "Retain correlated authority",
    harness: "external",
    grant: {
      caps: ["containers:read", "machines:shell"],
      targets: [home],
      reach: "subtree",
      authorityScope: scope,
      maxRunLifetimeMs: 120_000,
      delegation: { maxDepth: 2, maxDescendants: 4 },
      expiresAt: expiry,
    },
    context: { profile: null },
    status: "enabled",
    authorizationPath: "principal",
    authorizationCredential: {
      tokenId: "sponsor",
      grantId: "sponsor-grant",
      caps: ["containers:read", "machines:shell"],
      containerScope: null,
      authorityScope: scope,
      expiresAt: expiry,
    },
    createdAt: 30,
    updatedAt: 40,
  };
}

function run(id: string, agentId = "agent"): AgentRunRecord {
  return {
    id,
    principalId: `${agentId}-principal`,
    agentId,
    session: null,
    activity: "blocked",
    rootRunId: id,
    parentRunId: null,
    authorizedByPrincipalId: "human",
    authorizationPath: "principal",
    authorizationCredential: agent(agentId).authorizationCredential,
    purpose: "Retain correlated authority",
    taskRef: "retained-task",
    target: home,
    reach: "subtree",
    caps: ["containers:read", "machines:shell"],
    authorityScope: scope,
    createdAt: 50,
    expiresAt: expiry,
    renewals: 2,
    maxDepth: 2,
    maxDescendants: 4,
    depth: 0,
    cleanupOwnerPrincipalId: "human",
    state: "active",
    policyRevision: revision,
    acknowledgedPolicyRevision: revision,
    cleanupRevokedCredentials: 0,
    cleanupRevokedGrants: 0,
  };
}

function policy(runId: string) {
  return { runId, revision, bundles: [], issuedAt: 50, acknowledgedAt: 51 };
}

function addHuman(store: ServerStore): void {
  store.createPrincipal({ id: "human", kind: "human", name: "Operator", color: "#112233" }, 1);
}

describe("durable correlated authority", () => {
  test("preserves correlated and explicitly empty token, Agent, Run and sponsor ceilings across restart and renewal", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-scoped-records-"));
    const path = join(dir, "state.sqlite");
    let store = new ServerStore(openDatabase(path));
    try {
      const scopedToken = { ...token("scoped", null, ["containers:read", "machines:shell"]), containerId: "home", authorityScope: scope };
      const emptyToken = { ...token("empty", null, []), authorityScope: [] };
      const legacyToken = token("legacy", null, ["containers:read"]);
      store.createToken(scopedToken);
      store.createToken(emptyToken);
      store.createToken(legacyToken);
      const scopedAgent = agent("agent");
      const emptyAgent: AgentRecord = {
        ...agent("empty-agent"),
        grant: { ...scopedAgent.grant, caps: [], authorityScope: [] },
        authorizationCredential: { ...scopedAgent.authorizationCredential, caps: [], authorityScope: [] },
      };
      store.createAgent(scopedAgent);
      store.createAgent(emptyAgent);
      const scopedRun = run("run");
      const emptyRun: AgentRunRecord = {
        ...run("empty-run", emptyAgent.agentId),
        caps: [],
        authorityScope: [],
        authorizationCredential: emptyAgent.authorizationCredential,
      };
      store.createAgentRun(scopedRun, policy(scopedRun.id));
      store.createAgentRun(emptyRun, policy(emptyRun.id));
      const nativeRun = run("native-scope");
      const nativeSession = { harness: "external", sessionId: "native-session", machineId: "a" };
      const nativeCredential = {
        principalId: "human",
        tokenId: "sponsor",
        grantId: "sponsor-grant",
        caps: ["machines:shell"] as Cap[],
        containerScope: null,
        authorityScope: scope,
        containerGrants: [{ containerId: "home", caps: ["containers:read"] as const }],
      };
      store.createAgentRun(nativeRun, policy(nativeRun.id));
      store.bindAgentRunJob(nativeRun.id, "native-job", nativeSession, nativeCredential);
      store.close();
      store = new ServerStore(openDatabase(path));
      expect(store.getTokenByHash(scopedToken.hash)).toEqual(scopedToken);
      expect(store.getToken(emptyToken.id)).toEqual(emptyToken);
      expect(store.getToken(legacyToken.id)).toEqual(legacyToken);
      expect(store.getAgent(scopedAgent.agentId)).toEqual(scopedAgent);
      expect(store.getAgent(emptyAgent.agentId)).toEqual(emptyAgent);
      expect(store.getAgentRun(scopedRun.id)).toEqual(scopedRun);
      expect(store.getAgentRun(emptyRun.id)).toEqual(emptyRun);
      expect(store.getAgentRun(nativeRun.id)).toEqual({
        ...nativeRun, session: nativeSession, nativeJob: { jobId: "native-job", credential: nativeCredential },
      });
      const sponsor = { ...scopedRun.authorizationCredential, authorityScope: [] };
      expect(store.renewAgentRun(scopedRun.id, expiry + 60_000, sponsor)).toBe(true);
      store.close();
      store = new ServerStore(openDatabase(path));
      expect(store.getAgentRun(scopedRun.id)).toEqual({
        ...scopedRun,
        expiresAt: expiry + 60_000,
        renewals: scopedRun.renewals + 1,
        authorizationCredential: sponsor,
      });
      expect(store.getAgentRun(scopedRun.id)?.authorityScope).toEqual(scope);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("binds every row to its exact token and revokes all owned rows without borrowing a sibling credential", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-scoped-memberships-"));
    const path = join(dir, "state.sqlite");
    let store = new ServerStore(openDatabase(path));
    try {
      addHuman(store);
      store.createGrant(grant("left-machine", machineA, ["machines:shell"]));
      store.createGrant(grant("left-container", home, ["containers:read"]));
      store.createGrant(grant("right-machine", machineB, ["machines:shell"]));
      const ceiling: AuthorityScope = [{ target: root, reach: "subtree", caps: ["machines:shell", "containers:read"] }];
      store.createToken({ ...token("left", "left-machine", ["machines:shell", "containers:read"]), authorityScope: ceiling });
      store.bindTokenGrant("left", "left-container");
      store.bindTokenGrant("left", "left-container");
      store.createToken({ ...token("right", "right-machine"), authorityScope: ceiling });
      store.close();
      store = new ServerStore(openDatabase(path));
      expect(store.getToken("left")?.grantId).toBe("left-machine");
      expect(store.tokenOwnsGrant("left", "left-container")).toBe(true);
      expect(store.tokenOwnsGrant("right", "left-container")).toBe(false);
      expect(store.getGrant("left-container")?.tokenBound).toBe(true);
      const auth = new AuthService(store, "f".repeat(64), new FakeRuntime());
      const left = auth.authenticate("left");
      const right = auth.authenticate("right");
      expect(auth.allowsNode(left, "machines:shell", machineA)).toBe(true);
      expect(auth.allowsNode(left, "machines:shell", machineB)).toBe(false);
      expect(auth.allowsNode(left, "containers:read", home)).toBe(true);
      expect(auth.allowsNode(right, "machines:shell", machineB)).toBe(true);
      expect(auth.allowsNode(right, "machines:shell", machineA)).toBe(false);
      expect(auth.allowsNode(right, "containers:read", home)).toBe(false);
      expect(store.revokeToken("left", 100)).toEqual({ tokens: 1, grants: 2 });
      expect(store.revokeToken("left", 101)).toEqual({ tokens: 0, grants: 0 });
      expect(store.getGrant("left-machine")).toBeNull();
      expect(store.getGrant("left-container")).toBeNull();
      expect(store.tokenOwnsGrant("left", "left-container")).toBe(false);
      expect(store.getToken("left")).toMatchObject({ revokedAt: 100, grantId: null, authorityScope: ceiling });
      expect(store.getGrant("right-machine")).toMatchObject({ tokenBound: true });
      store.close();
      store = new ServerStore(openDatabase(path));
      const restartedAuth = new AuthService(store, "f".repeat(64), new FakeRuntime());
      expect(() => restartedAuth.authenticate("left")).toThrow();
      expect(restartedAuth.allowsNode(restartedAuth.authenticate("right"), "machines:shell", machineB)).toBe(true);
      expect(store.tokenOwnsGrant("left", "left-machine")).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rolls back the complete multirow revoke on failure and preserves another live membership", () => {
    const store = new ServerStore(openDatabase(":memory:"));
    try {
      store.createGrant(grant("shared", root, ["machines:shell"]));
      store.createGrant(grant("private", machineA, ["machines:shell"]));
      store.createToken(token("left", "shared"));
      store.bindTokenGrant("left", "private");
      store.createToken(token("right", "shared"));
      store.db.exec(`CREATE TRIGGER fail_private_revoke BEFORE DELETE ON grants
        WHEN OLD.id='private' BEGIN SELECT RAISE(ABORT,'refuse revoke'); END;`);
      expect(() => store.revokeToken("left", 100)).toThrow("refuse revoke");
      expect(store.getToken("left")?.revokedAt).toBeNull();
      expect(store.tokenOwnsGrant("left", "private")).toBe(true);
      expect(store.tokenOwnsGrant("left", "shared")).toBe(true);
      expect(store.getGrant("private")).not.toBeNull();
      store.db.exec("DROP TRIGGER fail_private_revoke");
      expect(store.revokeToken("left", 100)).toEqual({ tokens: 1, grants: 1 });
      expect(store.tokenOwnsGrant("left", "shared")).toBe(false);
      expect(store.tokenOwnsGrant("right", "shared")).toBe(true);
      expect(store.getGrant("shared")).toMatchObject({ tokenBound: true });
      expect(store.revokeTokensByPrincipal("human", 101)).toEqual({ tokens: 1, grants: 1 });
      expect(store.getGrant("shared")).toBeNull();
      expect(store.tokenOwnsGrant("right", "shared")).toBe(false);
    } finally {
      store.close();
    }
  });
});

/** A genuine v48 authority image: no current columns are relabelled as old ones. */
function seedV48(path: string): void {
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec(`
CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
INSERT INTO meta VALUES ('schema_version','48');
${AUTHORITY_V37_FIXTURE_SQL}
ALTER TABLE agent_runs ADD COLUMN tools_json TEXT;
ALTER TABLE agent_runs ADD COLUMN launch_target_json TEXT;
ALTER TABLE agent_runs ADD COLUMN native_job_id TEXT;
ALTER TABLE agent_runs ADD COLUMN native_credential_json TEXT;
ALTER TABLE agent_runs ADD COLUMN native_call_ids_json TEXT NOT NULL DEFAULT '[]';
CREATE TABLE agent_run_policy_snapshots(run_id TEXT NOT NULL,revision TEXT NOT NULL,bundles TEXT NOT NULL,
  issued_at INTEGER NOT NULL,acknowledged_at INTEGER,PRIMARY KEY(run_id,revision));
CREATE TABLE machine_jobs(job_id TEXT PRIMARY KEY,machine_id TEXT,request TEXT,digest TEXT,
  state TEXT,permit TEXT,result TEXT,created_at INTEGER,container_grants TEXT);
CREATE TABLE machine_job_revisions(kind TEXT,identity TEXT,revision INTEGER,digest TEXT,PRIMARY KEY(kind,identity));
CREATE TRIGGER job_grant_update AFTER UPDATE ON grants BEGIN
  INSERT INTO machine_job_revisions VALUES ('grant',NEW.id,1,'')
    ON CONFLICT(kind,identity) DO UPDATE SET revision=revision+1,digest='';
END;
CREATE TRIGGER job_token_update AFTER UPDATE ON tokens BEGIN
  INSERT INTO machine_job_revisions VALUES ('credential',NEW.id,1,'')
    ON CONFLICT(kind,identity) DO UPDATE SET revision=revision+1,digest='';
END;
`);
    const spawn = JSON.stringify(["terminals:spawn"]);
    for (const [id, kind] of [
      ["human", "human"], ["denied", "human"], ["node-denied", "human"], ["worker", "agent"],
    ] as const)
      db.query("INSERT INTO principals VALUES (?,?,?,'#112233',1,NULL)").run(id, kind, id);
    for (const [id, node, reach, effect, principal] of [
      ["sponsor-grant", root, "subtree", "allow", "human"],
      ["global-deny", root, "subtree", "deny", "denied"],
      ["denied-allow", root, "subtree", "allow", "denied"],
      ["node-denied-allow", root, "subtree", "allow", "node-denied"],
      ["node-denied-deny", root, "node", "deny", "node-denied"],
      ["confined-grant", home, "subtree", "allow", "human"],
      ["root-node", root, "node", "allow", "human"],
      ["machine-only", machineA, "subtree", "allow", "human"],
      ["operation-only", `${machineA}/operation/core.terminals%2Frun`, "node", "allow", "human"],
      ["global-run-grant", root, "subtree", "allow", "worker"],
      ["container-run-grant", root, "subtree", "allow", "worker"],
      ["native-run-grant", root, "subtree", "allow", "worker"],
      ["anchored-grant", root, "subtree", "allow", "human"],
      ["wildcard-grant", root, "subtree", "allow", "human"],
      ["revoked-grant", root, "subtree", "allow", "human"],
    ] as const) {
      db.query("INSERT INTO grants VALUES (?,'principal',?,?,?,?,?,'issuer',7)").run(
        id, principal, node, id === "wildcard-grant" ? '["*"]' : spawn, effect, reach,
      );
    }
    for (const [id, grantId, containerId, runId, principalId, caps] of [
      ["sponsor", "sponsor-grant", null, null, "human", spawn],
      ["denied-token", "denied-allow", null, null, "denied", spawn],
      ["node-denied-token", "node-denied-allow", null, null, "node-denied", spawn],
      ["confined-token", "confined-grant", "home", null, "human", spawn],
      ["node-token", "root-node", null, null, "human", spawn],
      ["machine-token", "machine-only", null, null, "human", spawn],
      ["operation-token", "operation-only", null, null, "human", spawn],
      ["global-run-token", "global-run-grant", null, "global-run", "worker", spawn],
      ["container-run-token", "container-run-grant", null, "container-run", "worker", spawn],
      ["native-run-token", "native-run-grant", null, "native-run", "worker", spawn],
      ["anchored-token", "anchored-grant", "home", null, "human", spawn],
      ["wildcard-token", "wildcard-grant", null, null, "human", '["*"]'],
      ["revoked-token", "revoked-grant", null, null, "human", spawn],
    ] as const) {
      db.query(`INSERT INTO tokens(id,hash,principal_id,caps,container_id,created_at,revoked_at,
        minted_by,grant_id,expires_at,run_id) VALUES (?,?,?,?,?,11,NULL,'issuer',?,?,?)`).run(
        id, sha256Hex(id), principalId, caps, containerId, grantId, expiry, runId,
      );
    }
    db.exec("UPDATE tokens SET revoked_at=31 WHERE id='revoked-token'");
    const sponsor = { tokenId: "sponsor", grantId: "sponsor-grant", caps: ["terminals:spawn"], containerScope: null, expiresAt: expiry };
    for (const [id, target, reach] of [
      ["global-agent", root, "subtree"],
      ["container-agent", home, "subtree"],
      ["node-agent", root, "node"],
      ["machine-agent", machineA, "subtree"],
    ] as const) {
      db.query("INSERT INTO agents VALUES (?,?,'human',?,'retain legacy authority','external',?,'{\"profile\":null}',?,'disabled','principal',?,13,17)").run(
        id, `${id}-principal`, id,
        JSON.stringify({ caps: ["terminals:spawn"], targets: [target], reach, maxRunLifetimeMs: 120_000,
          delegation: { maxDepth: 2, maxDescendants: 4 }, expiresAt: expiry }),
        revision, JSON.stringify(sponsor),
      );
    }
    for (const [id, target, nativeJobId] of [
      ["global-run", root, null],
      ["container-run", home, null],
      ["native-run", root, "native-job"],
    ] as const) {
      db.query(`INSERT INTO agent_runs(id,principal_id,root_run_id,authorized_by_principal_id,
        authorization_path,authorizer_token_id,authorizer_grant_id,authorizer_caps,authorizer_expires_at,
        purpose,target,reach,caps,created_at,expires_at,renewals,max_depth,max_descendants,depth,
        cleanup_owner_principal_id,state,policy_revision,acknowledged_policy_revision,
        cleanup_revoked_credentials,cleanup_revoked_grants,finished_at,cleanup_failure,agent_id,activity,
        native_job_id,native_credential_json)
        VALUES (?,'worker',?,'human','principal','sponsor','sponsor-grant',?,?,'retain legacy authority',
          ?,'subtree',?,19,?,3,2,4,0,'human','completed',?,?,2,1,29,'retained receipt','global-agent','done',?,?)`).run(
        id, id, spawn, expiry, target, spawn, expiry, revision, revision, nativeJobId,
        nativeJobId === null ? null : JSON.stringify({ principalId: "human", ...sponsor }),
      );
      db.query("INSERT INTO agent_run_policy_snapshots VALUES (?,?, '[]',19,20)").run(id, revision);
    }
    const nativeRequest = '{"credential":{"principalId":"human","tokenId":"sponsor","grantId":"sponsor-grant","caps":["terminals:spawn"],"containerScope":null},"terminal":{"terminalId":"kept"}}';
    db.query("INSERT INTO machine_jobs VALUES (?,'a',?,'signed-digest','finished','signed-permit','retained-result',23,?)").run("native-job", nativeRequest, null);
    const carriedRequest = '{"credential":{"principalId":"human","tokenId":"sponsor","grantId":"sponsor-grant","caps":[],"containerScope":null},"terminal":{"terminalId":"kept"}}';
    db.query("INSERT INTO machine_jobs VALUES (?,'a',?,'carried-digest','queued',NULL,NULL,24,?)").run(
      "carried-job", carriedRequest, JSON.stringify([{ containerId: "home", caps: ["terminals:spawn"] }]),
    );
  } finally {
    db.close();
  }
}

function rows(db: Database, table: string): Record<string, unknown>[] {
  return db.query<Record<string, unknown>, []>(`SELECT * FROM ${table} ORDER BY 1`).all();
}

describe("migration 49: durable account-shell compatibility", () => {
  test("extends only old global subtree spawn grants and faithfully associated unconfined ceilings once", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-shell-migration-"));
    const path = join(dir, "state.sqlite");
    seedV48(path);
    let db = new Database(path, { strict: true });
    try {
      const beforeGrants = rows(db, "grants");
      const beforeTokens = rows(db, "tokens");
      const beforeAgents = rows(db, "agents");
      const beforeRuns = rows(db, "agent_runs");
      const signedJobs = rows(db, "machine_jobs");
      const policies = rows(db, "agent_run_policy_snapshots");
      db.close();
      db = openDatabase(path);
      const store = new ServerStore(db);
      expect(store.getMeta("schema_version")).toBe("49");
      expect(existsSync(`${path}.pre-v49.bak`)).toBe(true);
      const backup = new Database(`${path}.pre-v49.bak`, { readonly: true });
      try {
        expect(rows(backup, "grants")).toEqual(beforeGrants);
        expect(rows(backup, "tokens")).toEqual(beforeTokens);
      } finally {
        backup.close();
      }
      const upgraded = (raw: unknown): string => JSON.stringify([...JSON.parse(String(raw)), "machines:shell"]);
      expect(rows(db, "grants")).toEqual(beforeGrants.map((row) => ({
        ...row,
        caps: row.node === root && row.reach === "subtree" && row.id !== "wildcard-grant"
          ? upgraded(row.caps) : row.caps,
      })));
      const translatedTokens: Readonly<Record<string, true>> = {
        sponsor: true, "global-run-token": true, "revoked-token": true,
      };
      expect(rows(db, "tokens")).toEqual(beforeTokens.map((row) => ({
        ...row,
        caps: translatedTokens[String(row.id)] === true ? upgraded(row.caps) : row.caps,
        authority_scope: null,
      })));
      expect(rows(db, "agents")).toEqual(beforeAgents.map((row) => {
        if (row.agent_id !== "global-agent") return row;
        const storedGrant = JSON.parse(String(row.grant_json));
        const sponsor = JSON.parse(String(row.authorization_credential));
        return { ...row,
          grant_json: JSON.stringify({ ...storedGrant, caps: [...storedGrant.caps, "machines:shell"] }),
          authorization_credential: JSON.stringify({ ...sponsor, caps: [...sponsor.caps, "machines:shell"] }),
        };
      }));
      expect(rows(db, "agent_runs")).toEqual(beforeRuns.map((row) => ({
        ...row,
        caps: row.id === "global-run" ? upgraded(row.caps) : row.caps,
        authorizer_caps: row.id === "global-run" ? upgraded(row.authorizer_caps) : row.authorizer_caps,
        authority_scope: null,
        authorizer_authority_scope: null,
      })));
      expect(store.getGrant("global-deny")).toMatchObject({ effect: "deny", caps: ["terminals:spawn", "machines:shell"], createdBy: "issuer", createdAt: 7 });
      expect(store.getAgent("global-agent")?.grant.caps).toEqual(["terminals:spawn", "machines:shell"]);
      expect(store.getAgentRun("global-run")?.authorizationCredential.caps).toEqual(["terminals:spawn", "machines:shell"]);
      for (const oldToken of beforeTokens) {
        expect(store.tokenOwnsGrant(String(oldToken.id), String(oldToken.grant_id))).toBe(true);
        expect(store.getToken(String(oldToken.id))?.grantId).toBe(oldToken.grant_id);
      }
      expect(rows(db, "machine_jobs")).toEqual(signedJobs);
      expect(rows(db, "agent_run_policy_snapshots")).toEqual(policies);
      const migrated = Object.fromEntries(["grants", "tokens", "agents", "agent_runs", "token_grants", "machine_job_revisions"].map((table) => [table, rows(db, table)]));
      store.createGrant(grant("new-spawn", root, ["terminals:spawn"]));
      store.createToken(token("new-token", "new-spawn", ["terminals:spawn"]));
      db.close();
      db = openDatabase(path);
      const restarted = new ServerStore(db);
      expect(restarted.getGrant("new-spawn")?.caps).toEqual(["terminals:spawn"]);
      expect(restarted.getToken("new-token")?.caps).toEqual(["terminals:spawn"]);
      for (const [table, expected] of Object.entries(migrated)) {
        expect(rows(db, table).filter((row) => row.id !== "new-spawn" && row.id !== "new-token"
          && row.token_id !== "new-token")).toEqual(expected);
      }
      expect(rows(db, "machine_jobs")).toEqual(signedJobs);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rolls back membership, ceiling and grant translation together on migration failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-shell-migration-rollback-"));
    const path = join(dir, "state.sqlite");
    seedV48(path);
    let db = new Database(path, { strict: true });
    try {
      const beforeGrants = rows(db, "grants");
      const beforeTokens = rows(db, "tokens");
      db.exec(`CREATE TRIGGER fail_shell_migration BEFORE UPDATE ON agents
        BEGIN SELECT RAISE(ABORT,'retained schema'); END;`);
      db.close();
      expect(() => openDatabase(path)).toThrow("retained schema");
      db = new Database(path, { strict: true });
      expect(rows(db, "grants")).toEqual(beforeGrants);
      expect(rows(db, "tokens")).toEqual(beforeTokens);
      expect(db.query("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: "48" });
      expect(db.query("SELECT name FROM sqlite_master WHERE name='token_grants'").get()).toBeNull();
      db.exec("DROP TRIGGER fail_shell_migration");
      db.close();
      db = openDatabase(path);
      expect(new ServerStore(db).getToken("sponsor")?.caps).toEqual(["terminals:spawn", "machines:shell"]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
