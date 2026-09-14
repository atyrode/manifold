import type { Database } from "bun:sqlite";
import { AGENT_RUN_MAX_LIFETIME_MS } from "@manifold/protocol";

interface LegacyAgent {
  principal_id: string;
  name: string;
  authorized_by_principal_id: string;
}

/** Runs inside the numbered migration's transaction, after its recoverable backup. */
export function migrateToDurableAgents(db: Database): void {
  const counts = db
    .query<
      {
        runs: number;
        snapshots: number;
        tokens: number;
        events: number;
        jobs: number;
        occurrences: number;
        terminals: number;
      },
      []
    >(
      `SELECT
    (SELECT COUNT(*) FROM agent_runs) AS runs,
    (SELECT COUNT(*) FROM agent_run_policy_snapshots) AS snapshots,
    (SELECT COUNT(*) FROM tokens) AS tokens,
    (SELECT COUNT(*) FROM events) AS events,
    (SELECT COUNT(*) FROM machine_jobs) AS jobs,
    (SELECT COUNT(*) FROM job_schedule_occurrences) AS occurrences,
    (SELECT COUNT(*) FROM terminals) AS terminals`,
    )
    .get()!;
  const invalidLineage = db
    .query<{ invalid: number }, []>(
      `SELECT COUNT(*) AS invalid
    FROM agent_runs r LEFT JOIN principals p ON p.id=r.principal_id
    LEFT JOIN agent_runs root ON root.id=r.root_run_id
    LEFT JOIN agent_runs parent ON parent.id=r.parent_run_id
    WHERE p.id IS NULL OR p.kind<>'agent' OR root.id IS NULL
      OR root.parent_run_id IS NOT NULL OR root.depth<>0
      OR (r.parent_run_id IS NULL AND (r.root_run_id<>r.id OR r.depth<>0))
      OR (r.parent_run_id IS NOT NULL AND (parent.id IS NULL
        OR parent.root_run_id<>r.root_run_id OR parent.depth+1<>r.depth
        OR parent.principal_id<>r.authorized_by_principal_id))
      OR NOT EXISTS(SELECT 1 FROM agent_run_policy_snapshots s
        WHERE s.run_id=r.id AND s.revision=r.policy_revision)`,
    )
    .get()!;
  if (invalidLineage.invalid !== 0) throw new Error("durable agent migration: invalid run lineage");

  db.exec(`
CREATE TABLE agents(
  agent_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL UNIQUE,
  sponsor_principal_id TEXT NOT NULL,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  harness TEXT NOT NULL,
  grant_json TEXT NOT NULL,
  context_json TEXT NOT NULL,
  policy_revision_acknowledged TEXT,
  status TEXT NOT NULL CHECK(status IN ('enabled','disabled','retired')),
  authorization_path TEXT NOT NULL CHECK(authorization_path IN ('owner_key','principal')),
  authorization_credential TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(sponsor_principal_id,name)
);
CREATE TABLE agent_runs_v37(
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  root_run_id TEXT NOT NULL,
  parent_run_id TEXT,
  authorized_by_principal_id TEXT NOT NULL,
  authorization_path TEXT NOT NULL CHECK(authorization_path IN ('owner_key','principal')),
  authorizer_token_id TEXT,
  authorizer_grant_id TEXT,
  authorizer_caps TEXT NOT NULL,
  authorizer_container_scope TEXT,
  authorizer_expires_at INTEGER,
  purpose TEXT NOT NULL,
  task_ref TEXT,
  target TEXT NOT NULL,
  reach TEXT NOT NULL CHECK(reach IN ('node','subtree')),
  caps TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  renewals INTEGER NOT NULL,
  max_depth INTEGER NOT NULL,
  max_descendants INTEGER NOT NULL,
  depth INTEGER NOT NULL,
  cleanup_owner_principal_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN (
    'pending_policy','active','policy_stale','completed','failed','cancelled','abandoned',
    'expired','revoked','cleanup_failed'
  )),
  policy_revision TEXT NOT NULL,
  acknowledged_policy_revision TEXT,
  cleanup_revoked_credentials INTEGER NOT NULL DEFAULT 0,
  cleanup_revoked_grants INTEGER NOT NULL DEFAULT 0,
  finished_at INTEGER,
  cleanup_failure TEXT,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  session_harness TEXT,
  session_id TEXT,
  session_machine_id TEXT,
  model TEXT,
  activity TEXT NOT NULL CHECK(activity IN ('working','blocked','done','idle','unknown')),
  CHECK(
    (session_harness IS NULL AND session_id IS NULL AND session_machine_id IS NULL) OR
    (session_harness IS NOT NULL AND session_id IS NOT NULL AND session_machine_id IS NOT NULL)
  )
);
ALTER TABLE tokens ADD COLUMN runner_agent_id TEXT REFERENCES agents(agent_id);
ALTER TABLE tokens ADD COLUMN run_id TEXT;
ALTER TABLE events ADD COLUMN run_id TEXT;
ALTER TABLE events ADD COLUMN credential_id TEXT;
-- Native history can outlive its trace or token. Correlate legacy rows ONCE, while
-- principal_id is still one-to-one; never use principal-wide fallback after cutover.
ALTER TABLE machine_jobs ADD COLUMN run_id TEXT;
ALTER TABLE job_schedule_occurrences ADD COLUMN run_id TEXT;
ALTER TABLE terminals ADD COLUMN run_id TEXT;
`);
  const rows = db
    .query<LegacyAgent, []>(
      `SELECT r.principal_id,p.name,r.authorized_by_principal_id
    FROM agent_runs r JOIN principals p ON p.id=r.principal_id ORDER BY r.principal_id`,
    )
    .all();
  const reserved = new Set(
    rows.map((row) => JSON.stringify([row.authorized_by_principal_id, row.name])),
  );
  const assigned = new Set<string>();
  // Historical run outcomes never represented an Agent lifecycle decision.
  const insertAgent = db.query(`INSERT INTO agents(
    agent_id,principal_id,sponsor_principal_id,name,purpose,harness,grant_json,context_json,
    policy_revision_acknowledged,status,authorization_path,authorization_credential,created_at,updated_at
  ) SELECT principal_id,principal_id,authorized_by_principal_id,?,purpose,'external',
    json_object('caps',json(caps),'targets',json_array(target),'reach',reach,
      'maxRunLifetimeMs',MIN(?,expires_at-created_at),
      'delegation',json_object('maxDepth',max_depth,'maxDescendants',max_descendants),
      'expiresAt',expires_at),
    '{"profile":{}}',acknowledged_policy_revision,
    'enabled',authorization_path,
    CASE WHEN authorizer_expires_at IS NULL THEN
      json_object('tokenId',authorizer_token_id,'grantId',authorizer_grant_id,
        'caps',json(authorizer_caps),'containerScope',authorizer_container_scope)
    ELSE json_object('tokenId',authorizer_token_id,'grantId',authorizer_grant_id,
      'caps',json(authorizer_caps),'containerScope',authorizer_container_scope,
      'expiresAt',authorizer_expires_at) END,created_at,COALESCE(finished_at,created_at)
    FROM agent_runs WHERE principal_id=?`);
  for (const row of rows) {
    let name = row.name;
    let key = JSON.stringify([row.authorized_by_principal_id, name]);
    if (assigned.has(key)) {
      let ordinal = 2;
      do {
        const suffix = `-${ordinal++}`;
        name = `${row.name.slice(0, 64 - suffix.length)}${suffix}`;
        key = JSON.stringify([row.authorized_by_principal_id, name]);
      } while (reserved.has(key) || assigned.has(key));
    }
    assigned.add(key);
    insertAgent.run(name, AGENT_RUN_MAX_LIFETIME_MS, row.principal_id);
  }
  // The old column order is retained verbatim; only the new typed binding follows it.
  db.exec(`
INSERT INTO agent_runs_v37 SELECT r.*,r.principal_id,NULL,NULL,NULL,NULL,'unknown' FROM agent_runs r;
UPDATE tokens SET run_id=(SELECT id FROM agent_runs r WHERE r.principal_id=tokens.principal_id)
  WHERE principal_id IN (SELECT principal_id FROM agent_runs);
UPDATE events SET run_id=(SELECT id FROM agent_runs r WHERE r.principal_id=events.principal_id);
UPDATE machine_jobs SET run_id=(SELECT id FROM agent_runs r
  WHERE r.principal_id=json_extract(machine_jobs.request,'$.credential.principalId'));
UPDATE job_schedule_occurrences SET run_id=(SELECT id FROM agent_runs r
  WHERE r.principal_id=json_extract(job_schedule_occurrences.request,'$.credential.principalId'));
UPDATE terminals SET run_id=(SELECT id FROM agent_runs r WHERE r.principal_id=terminals.created_by);
`);
  const migratedCounts = db
    .query<typeof counts & { agents: number }, []>(
      `SELECT
    (SELECT COUNT(*) FROM agents) AS agents,
    (SELECT COUNT(*) FROM agent_runs_v37) AS runs,
    (SELECT COUNT(*) FROM agent_run_policy_snapshots) AS snapshots,
    (SELECT COUNT(*) FROM tokens) AS tokens,
    (SELECT COUNT(*) FROM events) AS events,
    (SELECT COUNT(*) FROM machine_jobs) AS jobs,
    (SELECT COUNT(*) FROM job_schedule_occurrences) AS occurrences,
    (SELECT COUNT(*) FROM terminals) AS terminals`,
    )
    .get()!;
  if (
    migratedCounts.agents !== counts.runs ||
    (Object.keys(counts) as Array<keyof typeof counts>).some(
      (key) => counts[key] !== migratedCounts[key],
    )
  ) {
    throw new Error("durable agent migration: backfill row count mismatch");
  }
  // Compare every old run column, not just IDs: sponsor credentials, tree edges and
  // cleanup counters must survive the rebuild unchanged before UNIQUE is removed.
  const columns = db
    .query<{ name: string }, []>("PRAGMA table_info(agent_runs)")
    .all()
    .map(({ name }) => `"${name.replaceAll('"', '""')}"`)
    .join(",");
  const changedRuns = db
    .query<{ invalid: number }, []>(
      `SELECT COUNT(*) AS invalid FROM (
    SELECT ${columns} FROM agent_runs EXCEPT SELECT ${columns} FROM agent_runs_v37
  )`,
    )
    .get()!;
  const invalidBackfill = db
    .query<{ invalid: number }, []>(
      `SELECT
    (SELECT COUNT(*) FROM agent_runs_v37 r LEFT JOIN agents a ON a.agent_id=r.agent_id
      WHERE a.agent_id IS NULL OR a.principal_id<>r.principal_id
        OR a.sponsor_principal_id<>r.authorized_by_principal_id
        OR a.authorization_path<>r.authorization_path
        OR json_extract(a.authorization_credential,'$.tokenId') IS NOT r.authorizer_token_id
        OR json_extract(a.authorization_credential,'$.grantId') IS NOT r.authorizer_grant_id
        OR json_extract(a.authorization_credential,'$.caps')<>json(r.authorizer_caps)
        OR json_extract(a.authorization_credential,'$.containerScope') IS NOT r.authorizer_container_scope
        OR json_extract(a.authorization_credential,'$.expiresAt') IS NOT r.authorizer_expires_at
        OR json_extract(a.grant_json,'$.caps')<>json(r.caps)
        OR json_extract(a.grant_json,'$.targets')<>json_array(r.target)
        OR json_extract(a.grant_json,'$.reach')<>r.reach
        OR json_extract(a.grant_json,'$.maxRunLifetimeMs')<>MIN(${AGENT_RUN_MAX_LIFETIME_MS},r.expires_at-r.created_at)
        OR json_extract(a.grant_json,'$.delegation.maxDepth')<>r.max_depth
        OR json_extract(a.grant_json,'$.delegation.maxDescendants')<>r.max_descendants
        OR json_extract(a.grant_json,'$.expiresAt')<>r.expires_at)
    + (SELECT COUNT(*) FROM tokens t WHERE t.run_id IS NOT
        (SELECT id FROM agent_runs r WHERE r.principal_id=t.principal_id))
    + (SELECT COUNT(*) FROM events e WHERE e.run_id IS NOT
        (SELECT id FROM agent_runs r WHERE r.principal_id=e.principal_id))
    + (SELECT COUNT(*) FROM machine_jobs j WHERE j.run_id IS NOT
        (SELECT id FROM agent_runs r WHERE r.principal_id=json_extract(j.request,'$.credential.principalId')))
    + (SELECT COUNT(*) FROM job_schedule_occurrences o WHERE o.run_id IS NOT
        (SELECT id FROM agent_runs r WHERE r.principal_id=json_extract(o.request,'$.credential.principalId')))
    + (SELECT COUNT(*) FROM terminals t WHERE t.run_id IS NOT
        (SELECT id FROM agent_runs r WHERE r.principal_id=t.created_by)) AS invalid`,
    )
    .get()!;
  if (changedRuns.invalid !== 0 || invalidBackfill.invalid !== 0) {
    throw new Error("durable agent migration: backfill lineage mismatch");
  }
  db.exec(`
DROP TABLE agent_runs;
ALTER TABLE agent_runs_v37 RENAME TO agent_runs;
CREATE INDEX agent_runs_root_depth ON agent_runs(root_run_id,depth,id);
CREATE INDEX agent_runs_parent ON agent_runs(parent_run_id,id);
CREATE INDEX agent_runs_agent ON agent_runs(agent_id,created_at,id);
CREATE INDEX agent_runs_principal ON agent_runs(principal_id,id);
CREATE INDEX tokens_runner_agent ON tokens(runner_agent_id,id);
CREATE INDEX tokens_agent_run ON tokens(run_id,created_at,id);
CREATE INDEX events_agent_run ON events(run_id,id DESC);
CREATE INDEX machine_jobs_agent_run ON machine_jobs(run_id);
CREATE INDEX job_schedule_occurrences_agent_run ON job_schedule_occurrences(run_id);
CREATE INDEX terminals_agent_run ON terminals(run_id);
INSERT OR REPLACE INTO meta(key,value) VALUES ('schema_version','37');
`);
}
