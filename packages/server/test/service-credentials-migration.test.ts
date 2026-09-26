import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrincipalCredentialsSchema } from "@manifold/protocol";
import { openDatabase } from "../src/db.ts";
import { ServerStore, sha256Hex } from "../src/stores.ts";

/** The v37 authority and terminal tables needed by later migrations. */
function seedV37(path: string): void {
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec(`
CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
INSERT INTO meta VALUES ('schema_version','37');
CREATE TABLE principals(id TEXT PRIMARY KEY,kind TEXT,name TEXT,color TEXT,created_at INTEGER,origin TEXT);
CREATE TABLE tokens(id TEXT PRIMARY KEY,hash TEXT UNIQUE,principal_id TEXT,caps TEXT,
  container_id TEXT,created_at INTEGER,revoked_at INTEGER,minted_by TEXT,grant_id TEXT,
  expires_at INTEGER,run_id TEXT,runner_agent_id TEXT);
CREATE TABLE grants(id TEXT PRIMARY KEY,principal_kind TEXT,principal_id TEXT,node TEXT,caps TEXT,
  effect TEXT,reach TEXT,created_by TEXT,created_at INTEGER);
CREATE TABLE native_instance_services(
  service_id TEXT PRIMARY KEY,revision TEXT NOT NULL,machine_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,configuration TEXT NOT NULL,credential TEXT,job_id TEXT,
  configured_by TEXT NOT NULL,configured_at INTEGER NOT NULL);
CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,container_id TEXT,ts INTEGER,
  principal_id TEXT,type TEXT,payload TEXT,door TEXT,authority TEXT,targets TEXT,outcome TEXT,
  session TEXT,run_id TEXT,credential_id TEXT);
CREATE TABLE machine_job_revisions(kind TEXT NOT NULL,identity TEXT NOT NULL,revision INTEGER NOT NULL,
  digest TEXT NOT NULL,PRIMARY KEY(kind,identity));
CREATE TABLE terminals(id TEXT PRIMARY KEY,machine_id TEXT,container_id TEXT,run_id TEXT);
CREATE TABLE machine_jobs(job_id TEXT PRIMARY KEY,machine_id TEXT,created_at INTEGER,request TEXT);
CREATE TABLE agent_runs(id TEXT PRIMARY KEY);
CREATE TRIGGER job_token_update AFTER UPDATE ON tokens BEGIN
  INSERT INTO machine_job_revisions VALUES ('credential',NEW.id,1,'')
    ON CONFLICT(kind,identity) DO UPDATE SET revision=revision+1,digest='';
END;
INSERT INTO principals VALUES
  ('current','agent','Broker','#112233',1,NULL),
  ('replaced','agent','Old broker','#223344',2,NULL),
  ('disabled','agent','Disabled service','#334455',3,NULL),
  ('unrelated','agent','vendor.broker','#445566',4,NULL),
  ('human','human','Operator','#556677',5,NULL);
`);
    for (const id of ["current", "replaced", "disabled", "unrelated", "human"]) {
      db.query(
        "INSERT INTO tokens VALUES (?,?,?,'[\"containers:read\"]',NULL,10,?,'human',?,5000,NULL,NULL)",
      ).run(
        `${id}-token`,
        sha256Hex(`migration-only-${id}`),
        id,
        id === "replaced" ? 500 : null,
        `${id}-grant`,
      );
      db.query(
        "INSERT INTO grants VALUES (?,'principal',?,'manifold://','[\"containers:read\"]','allow','subtree','human',10)",
      ).run(`${id}-grant`, id);
      db.query("INSERT INTO machine_job_revisions VALUES ('credential',?,7,'retained')").run(
        `${id}-token`,
      );
    }
    for (const [id, serviceId, enabled] of [
      ["current", "vendor.broker", true],
      ["disabled", "vendor.disabled", false],
    ] as const) {
      db.query(
        "INSERT INTO native_instance_services VALUES (?,'policy-revision','machine-new','vendor.plugin',?, ?,NULL,'human',10)",
      ).run(
        serviceId,
        JSON.stringify({ enabled, policy: {}, traceId: "configure" }),
        JSON.stringify({
          principalId: id,
          tokenId: `${id}-token`,
          grantId: `${id}-grant`,
          caps: ["containers:read"],
          containerScope: null,
        }),
      );
    }
    const event = db.query(
      "INSERT INTO events(container_id,ts,principal_id,type,payload) VALUES (NULL,10,'human',?,?)",
    );
    event.run(
      "token_minted",
      JSON.stringify({
        subjectPrincipalId: "replaced",
        serviceId: "vendor.broker",
        machineId: "machine-old",
        tokenId: "replaced-token",
      }),
    );
    // Complete service-shaped attribution must still never reclassify a human.
    event.run(
      "token_minted",
      JSON.stringify({
        subjectPrincipalId: "human",
        serviceId: "vendor.human",
        machineId: "machine-old",
      }),
    );
    for (const payload of [
      { subjectPrincipalId: "unrelated", serviceId: "vendor.broker" },
      { subjectPrincipalId: "unrelated", serviceId: "vendor.broker", machineId: "" },
      { subjectPrincipalId: "unrelated", serviceId: 42, machineId: "machine-old" },
    ])
      event.run("token_minted", JSON.stringify(payload));
    event.run(
      "trace",
      JSON.stringify({
        subjectPrincipalId: "unrelated",
        serviceId: "vendor.broker",
        machineId: "machine-old",
      }),
    );
    event.run("token_minted", "{malformed historical payload");
  } finally {
    db.close();
  }
}

describe("migration 38: native service credentials", () => {
  test("reclassifies current and historical services without changing unrelated principals, credentials or hashes", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-service-credentials-"));
    const path = join(dir, "manifold.db");
    let db: Database | undefined;
    try {
      seedV37(path);
      db = new Database(path, { strict: true });
      const beforePrincipals = db
        .query<{ id: string; kind: string }, []>("SELECT * FROM principals ORDER BY id")
        .all();
      const beforeTokens = db.query("SELECT * FROM tokens ORDER BY id").all();
      const beforeGrants = db.query("SELECT * FROM grants ORDER BY id").all();
      const beforeServices = db
        .query("SELECT * FROM native_instance_services ORDER BY service_id")
        .all();
      const beforeEvents = db.query("SELECT * FROM events ORDER BY id").all();
      const beforeRevisions = db
        .query("SELECT * FROM machine_job_revisions ORDER BY identity")
        .all();
      db.close();
      db = openDatabase(path);
      const store = new ServerStore(db);
      const serviceIds: Record<string, true> = { current: true, replaced: true, disabled: true };
      expect(db.query("SELECT * FROM principals ORDER BY id").all()).toEqual(
        beforePrincipals.map((row) => ({
          ...row,
          kind: serviceIds[row.id] ? "service" : row.kind,
        })),
      );
      expect(store.listPrincipals().map(({ id, kind }) => [id, kind])).toEqual([
        ["current", "service"],
        ["replaced", "service"],
        ["disabled", "service"],
        ["unrelated", "agent"],
        ["human", "human"],
      ]);
      expect(db.query("SELECT * FROM tokens ORDER BY id").all()).toEqual(beforeTokens);
      expect(db.query("SELECT * FROM grants ORDER BY id").all()).toEqual(beforeGrants);
      expect(db.query("SELECT * FROM native_instance_services ORDER BY service_id").all()).toEqual(
        beforeServices,
      );
      expect(db.query("SELECT * FROM events ORDER BY id").all()).toEqual(beforeEvents);
      expect(db.query("SELECT * FROM machine_job_revisions ORDER BY identity").all()).toEqual(
        beforeRevisions,
      );
      db.close();
      db = openDatabase(path);
      expect(new ServerStore(db).getPrincipal("replaced")?.kind).toBe("service");
      expect(db.query("SELECT * FROM tokens ORDER BY id").all()).toEqual(beforeTokens);
      expect(db.query("SELECT * FROM machine_job_revisions ORDER BY identity").all()).toEqual(
        beforeRevisions,
      );
    } finally {
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retains original service attribution after replacement and projects no credential secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-service-attribution-"));
    const path = join(dir, "manifold.db");
    let db: Database | undefined;
    try {
      seedV37(path);
      db = openDatabase(path);
      const store = new ServerStore(db);
      expect(store.getNativeServiceIdentity("current")).toEqual({
        serviceId: "vendor.broker",
        machineId: "machine-new",
      });
      expect(store.getNativeServiceIdentity("replaced")).toEqual({
        serviceId: "vendor.broker",
        machineId: "machine-old",
      });
      expect(store.getNativeServiceIdentity("unrelated")).toBeNull();
      expect(store.getNativeServiceIdentity("missing")).toBeNull();
      const historical = store
        .listPrincipalsWithCreation()
        .find(({ principal }) => principal.id === "replaced")!;
      expect(
        PrincipalCredentialsSchema.parse({
          ...historical,
          sessions: [],
          ...store.getNativeServiceIdentity("replaced"),
        }),
      ).toEqual({
        principal: { id: "replaced", kind: "service", name: "Old broker", color: "#223344" },
        createdAt: 2,
        sessions: [],
        serviceId: "vendor.broker",
        machineId: "machine-old",
      });
      // Uninstall clears the live record; retained original mint attribution is still useful.
      db.query("DELETE FROM native_instance_services WHERE service_id='vendor.broker'").run();
      expect(store.getNativeServiceIdentity("current")).toBeNull();
      expect(store.getNativeServiceIdentity("replaced")).toEqual({
        serviceId: "vendor.broker",
        machineId: "machine-old",
      });
    } finally {
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("service authority excludes human and agent class grants while retaining named grants", () => {
    const db = openDatabase(":memory:");
    try {
      const store = new ServerStore(db);
      for (const [id, principal] of [
        ["humans", { kind: "any-human" }],
        ["agents", { kind: "any-agent" }],
        ["native", { kind: "principal", id: "service" }],
      ] as const)
        store.createGrant({
          id,
          principal,
          node: "manifold://",
          caps: ["containers:read"],
          effect: "allow",
          reach: "subtree",
          createdBy: "operator",
          createdAt: 1,
        });
      const identity = { name: "Identity", color: "#112233" };
      expect(
        store
          .grantsFor({ ...identity, id: "service", kind: "service" }, ["manifold://"])
          .map(({ id }) => id),
      ).toEqual(["native"]);
      expect(
        store
          .grantsFor({ ...identity, id: "human", kind: "human" }, ["manifold://"])
          .map(({ id }) => id),
      ).toEqual(["humans"]);
      expect(
        store
          .grantsFor({ ...identity, id: "agent", kind: "agent" }, ["manifold://"])
          .map(({ id }) => id),
      ).toEqual(["agents"]);
    } finally {
      db.close();
    }
  });
});
