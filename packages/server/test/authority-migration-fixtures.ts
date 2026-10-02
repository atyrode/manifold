import type { Database } from "bun:sqlite";

/** Released v37 authority tables; later migrations add their own columns. */
export const AUTHORITY_V37_FIXTURE_SQL = `
CREATE TABLE principals(id TEXT PRIMARY KEY,kind TEXT,name TEXT,color TEXT,created_at INTEGER,origin TEXT);
CREATE TABLE tokens(id TEXT PRIMARY KEY,hash TEXT UNIQUE,principal_id TEXT,caps TEXT,
  container_id TEXT,created_at INTEGER,revoked_at INTEGER,minted_by TEXT,grant_id TEXT,
  expires_at INTEGER,runner_agent_id TEXT,run_id TEXT);
CREATE TABLE grants(id TEXT PRIMARY KEY,principal_kind TEXT,principal_id TEXT,node TEXT,caps TEXT,
  effect TEXT,reach TEXT,created_by TEXT,created_at INTEGER);
CREATE TABLE shares(id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,container_id TEXT NOT NULL,
  caps TEXT NOT NULL,origin TEXT NOT NULL,minted_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,revoked_at INTEGER,grant_id TEXT);
CREATE TABLE share_tickets(share_id TEXT NOT NULL,guest_principal_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,created_at INTEGER NOT NULL,
  PRIMARY KEY(share_id,guest_principal_id)) WITHOUT ROWID;
CREATE TABLE agents(
  agent_id TEXT PRIMARY KEY,principal_id TEXT NOT NULL UNIQUE,sponsor_principal_id TEXT NOT NULL,
  name TEXT NOT NULL,purpose TEXT NOT NULL,harness TEXT NOT NULL,grant_json TEXT NOT NULL,
  context_json TEXT NOT NULL,policy_revision_acknowledged TEXT,
  status TEXT NOT NULL CHECK(status IN ('enabled','disabled','retired')),
  authorization_path TEXT NOT NULL CHECK(authorization_path IN ('owner_key','principal')),
  authorization_credential TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
  UNIQUE(sponsor_principal_id,name));
CREATE TABLE agent_runs(
  id TEXT PRIMARY KEY,principal_id TEXT NOT NULL,root_run_id TEXT NOT NULL,parent_run_id TEXT,
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
  finished_at INTEGER,cleanup_failure TEXT,agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  session_harness TEXT,session_id TEXT,session_machine_id TEXT,model TEXT,
  activity TEXT NOT NULL CHECK(activity IN ('working','blocked','done','idle','unknown')),
  CHECK((session_harness IS NULL AND session_id IS NULL AND session_machine_id IS NULL) OR
    (session_harness IS NOT NULL AND session_id IS NOT NULL AND session_machine_id IS NOT NULL)));
`;

/** Remove exactly scoped-authority additions before reconstructing an older schema. */
export function removeScopedAuthority(db: Database): void {
  db.exec(`
DROP TRIGGER token_grants_delete_grant;
DROP TRIGGER token_grants_delete_token;
DROP TABLE token_grants;
ALTER TABLE tokens DROP COLUMN authority_scope;
ALTER TABLE agent_runs DROP COLUMN authority_scope;
ALTER TABLE agent_runs DROP COLUMN authorizer_authority_scope;
`);
}
