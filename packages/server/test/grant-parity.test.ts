import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CAPS, MANIFOLD_ROOT_URI, formatManifoldUri, type Cap } from "@manifold/protocol";
import { AuthService, ServiceError, type AuthContext } from "../src/auth.ts";
import { openDatabase } from "../src/db.ts";
import { ServerStore, sha256Hex } from "../src/stores.ts";
import { FakeRuntime } from "./helpers.ts";

/**
 * THE PARITY MATRIX — the inviolable contract of the permission waterfall (#77, ADR 0011).
 *
 * Every credential that existed before migration 13 must answer EVERY authority question after
 * it identically. Not "similarly", and not "for the cases we thought of": identically, over the
 * whole domain of `AuthService.allows`, which is (credential × capability × node). This file is
 * where that is PROVEN rather than asserted, and it proves it the only way a rewrite of an
 * evaluator can be proven — by keeping the old evaluator around as an ORACLE and diffing.
 *
 * `flatAllows` below is the pre-migration body of `allows`, verbatim. It is deliberately a
 * duplicate of deleted code rather than an import: an oracle that shared an implementation with
 * its subject would agree with it by construction and prove nothing. It is frozen. If a future
 * change means to move an answer, it changes this oracle in the same commit and says so — which
 * is exactly the review conversation a silent behavioural drift would skip.
 *
 * Two halves, because there are two ways a credential comes to hold a grant row:
 *   MIGRATED — rows materialized by migration 13 out of a schema-12 database, which is the
 *     contract for every token an operator already holds.
 *   MINTED — rows written by `persistToken` on a fresh database, which is the contract for every
 *     token issued from now on. Both must land on the same answers, or an upgrade and a re-mint
 *     would produce two workspaces that disagree about the same token.
 */

/** Every capability the seam can be asked about: `allows` excludes the wildcard by signature. */
const ASKABLE: readonly Exclude<Cap, "*">[] = CAPS.filter(
  (cap): cap is Exclude<Cap, "*"> => cap !== "*",
);

const CONTAINER_A = "container-a";
const CONTAINER_B = "container-b";
/** A container id no row carries: `allows` never resolved the tree, and must still not. */
const CONTAINER_MISSING = "container-gone";
const GUEST_ORIGIN = "https://guest.example";

/**
 * The nodes every credential is interrogated at, as the `containerId` argument actually arrives.
 * `undefined` is the shape `auth.ts`'s own mint checks and `event-hub`'s workspace read use;
 * the three ids are "my own container", "somebody else's", and "one that does not exist".
 */
const NODES: readonly (string | undefined)[] = [
  undefined,
  CONTAINER_A,
  CONTAINER_B,
  CONTAINER_MISSING,
];

/**
 * THE ORACLE: `AuthService.allows` as it stood before ADR 0011 landed, character for character.
 *
 * Note what it does NOT do, because the waterfall must not either: it never resolves a container,
 * so a question about a container that does not exist is answered by the credential alone; and it
 * skips the scope check entirely when no container is named, which is why a container-scoped
 * agent has always been able to answer "may I mint" with yes.
 */
function flatAllows(
  caps: readonly Cap[],
  containerScope: string | null,
  cap: Exclude<Cap, "*">,
  containerId?: string,
): boolean {
  if (!(caps.includes("*") || caps.includes(cap))) return false;
  if (containerId !== undefined && containerScope !== null && containerScope !== containerId) {
    return false;
  }
  return true;
}

/** One credential in the matrix: its secret, and the flat authority it was issued with. */
interface Credential {
  readonly name: string;
  readonly secret: string;
  readonly caps: readonly Cap[];
  readonly containerScope: string | null;
}

/**
 * The credential matrix, spanning every distinct authority SHAPE the schema can hold. Each row
 * exists because it exercises something the others cannot:
 *
 *   owner        — authenticates outside the token system, so it has no row to reference
 *   root         — a bootstrapped `*` token: a wildcard that IS stored as a row
 *   workspace    — an ordinary unscoped delegate
 *   scoped       — container-scoped, the case whose grant lives below the root
 *   ticket       — a share ticket: container-scoped AND carrying a foreign origin
 *   machine      — caps `[]`, which materializes to NO row at all
 *   narrow       — a second, narrower token for the SAME principal as `root`
 */
const OWNER_KEY = "a".repeat(64);

const SEEDED: readonly Credential[] = [
  { name: "owner", secret: OWNER_KEY, caps: ["*"], containerScope: null },
  { name: "root", secret: "b".repeat(64), caps: ["*"], containerScope: null },
  {
    name: "workspace",
    secret: "c".repeat(64),
    caps: ["containers:read", "containers:write", "scenes:write", "tokens:mint"],
    containerScope: null,
  },
  {
    name: "scoped",
    secret: "d".repeat(64),
    caps: ["containers:read", "scenes:write", "terminals:write", "tokens:mint"],
    containerScope: CONTAINER_A,
  },
  {
    name: "ticket",
    secret: "e".repeat(64),
    caps: ["containers:read", "scenes:write"],
    containerScope: CONTAINER_A,
  },
  { name: "machine", secret: "f".repeat(64), caps: [], containerScope: null },
  {
    name: "narrow",
    secret: "1".repeat(64),
    caps: ["containers:read"],
    containerScope: null,
  },
];

const REVOKED_SECRET = "2".repeat(64);

/**
 * Every cell of the matrix, keyed so a failure names the exact credential, capability and node
 * that moved. One object rather than an assertion per cell: `toEqual` on the whole matrix reports
 * every divergence at once, which is what makes a real regression readable instead of a
 * bisect-by-first-failure.
 */
function askMatrix(
  auth: AuthService,
  contexts: ReadonlyMap<string, AuthContext>,
): Record<string, boolean> {
  const answers: Record<string, boolean> = {};
  for (const [name, context] of contexts) {
    for (const cap of ASKABLE) {
      for (const node of NODES) {
        answers[`${name} | ${cap} | ${node ?? "(no node)"}`] = auth.allows(context, cap, node);
      }
    }
  }
  return answers;
}

/** The same cells, answered by the frozen oracle from the credential's issued authority. */
function expectedMatrix(credentials: readonly Credential[]): Record<string, boolean> {
  const answers: Record<string, boolean> = {};
  for (const credential of credentials) {
    for (const cap of ASKABLE) {
      for (const node of NODES) {
        answers[`${credential.name} | ${cap} | ${node ?? "(no node)"}`] = flatAllows(
          credential.caps,
          credential.containerScope,
          cap,
          node,
        );
      }
    }
  }
  return answers;
}

/**
 * A schema-12 database on disk, holding one of every authority shape migration 13 must
 * materialize. Include the persisted tables later migrations touch, since opening this
 * schema-12 file upgrades through the current version before exercising authority parity.
 *
 * The two tokens sharing `p-root` are the sharp case, and they are here deliberately. Under a
 * model where a principal's rows reached all of its credentials, `narrow` would inherit `root`'s
 * wildcard and quietly regain everything its minter withheld. The evaluator's token-reference
 * rule is what refuses that, and this fixture is what would catch its removal.
 */
function seedPreV13(path: string): void {
  const db = new Database(path, { create: true, strict: true });
  db.exec(`
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE plugin_kv(plugin_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)) WITHOUT ROWID;
CREATE TABLE principals(id TEXT PRIMARY KEY, kind TEXT, name TEXT, color TEXT,
  created_at INTEGER, origin TEXT);
CREATE TABLE containers(id TEXT PRIMARY KEY, name TEXT, created_at INTEGER, sort_order INTEGER,
  folder_id TEXT, discipline TEXT NOT NULL DEFAULT 'canvas');
CREATE TABLE tokens(id TEXT PRIMARY KEY, hash TEXT UNIQUE, principal_id TEXT, caps TEXT,
  container_id TEXT, created_at INTEGER, revoked_at INTEGER, minted_by TEXT);
CREATE TABLE machines(id TEXT PRIMARY KEY, name TEXT, token_id TEXT, last_seen INTEGER);
CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, container_id TEXT, ts INTEGER,
  principal_id TEXT, type TEXT, payload TEXT);
CREATE TABLE shares(id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, container_id TEXT NOT NULL,
  caps TEXT NOT NULL, origin TEXT NOT NULL, minted_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  revoked_at INTEGER);
CREATE TABLE share_tickets(share_id TEXT NOT NULL, guest_principal_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (share_id, guest_principal_id)) WITHOUT ROWID;
CREATE TABLE scene_docs(container_id TEXT NOT NULL, epoch TEXT NOT NULL, rev INTEGER NOT NULL,
  ts INTEGER NOT NULL, hash TEXT NOT NULL, doc BLOB NOT NULL,
  PRIMARY KEY (container_id, epoch, rev));
INSERT INTO meta(key, value) VALUES ('schema_version', '12');
INSERT INTO meta(key, value) VALUES ('owner_principal_id', 'p-owner');

INSERT INTO principals(id, kind, name, color, created_at, origin) VALUES
  ('p-owner', 'human', 'owner', '#2563eb', 1, NULL),
  ('p-root', 'human', 'ana', '#16a34a', 2, NULL),
  ('p-agent', 'agent', 'builder', '#9333ea', 3, NULL),
  ('p-ticket', 'human', 'remote', '#ea580c', 4, '${GUEST_ORIGIN}');

INSERT INTO containers(id, name, created_at, sort_order, folder_id, discipline) VALUES
  ('${CONTAINER_A}', 'A', 10, 1, NULL, 'canvas'),
  ('${CONTAINER_B}', 'B', 11, 2, NULL, 'canvas');

INSERT INTO tokens(id, hash, principal_id, caps, container_id, created_at, revoked_at, minted_by)
VALUES
  ('t-root', '${sha256Hex("b".repeat(64))}', 'p-root', '["*"]', NULL, 20, NULL, 'p-owner'),
  ('t-workspace', '${sha256Hex("c".repeat(64))}', 'p-root',
    '["containers:read","containers:write","scenes:write","tokens:mint"]', NULL, 21, NULL,
    'p-owner'),
  ('t-scoped', '${sha256Hex("d".repeat(64))}', 'p-agent',
    '["containers:read","scenes:write","terminals:write","tokens:mint"]', '${CONTAINER_A}', 22,
    NULL, 'p-root'),
  ('t-ticket', '${sha256Hex("e".repeat(64))}', 'p-ticket',
    '["containers:read","scenes:write"]', '${CONTAINER_A}', 23, NULL, 'p-root'),
  ('t-machine', '${sha256Hex("f".repeat(64))}', 'p-agent', '[]', NULL, 24, NULL, 'p-owner'),
  ('t-narrow', '${sha256Hex("1".repeat(64))}', 'p-root', '["containers:read"]', NULL, 25, NULL,
    'p-owner'),
  ('t-revoked', '${sha256Hex(REVOKED_SECRET)}', 'p-root', '["*"]', NULL, 26, 999, 'p-owner');

INSERT INTO shares(id, hash, container_id, caps, origin, minted_by, created_at, revoked_at)
VALUES
  ('s-live', 'h-live', '${CONTAINER_A}', '["containers:read","scenes:write"]', '${GUEST_ORIGIN}',
    'p-root', 30, NULL),
  ('s-dead', 'h-dead', '${CONTAINER_B}', '["containers:write"]', '${GUEST_ORIGIN}', 'p-root', 31,
    900);
INSERT INTO share_tickets(share_id, guest_principal_id, principal_id, created_at)
VALUES ('s-live', 'guest-1', 'p-ticket', 32);
`);
  db.close();
}

interface GrantDump {
  id: string;
  principal_kind: string;
  principal_id: string | null;
  node: string;
  caps: string;
  effect: string;
  reach: string;
}

describe("migration 13: flat caps become grant rows", () => {
  test("every seeded credential answers every authority question identically", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-grant-parity-"));
    const path = join(dir, "manifold.db");
    try {
      seedPreV13(path);
      const store = new ServerStore(openDatabase(path));
      const auth = new AuthService(store, OWNER_KEY, new FakeRuntime());

      const contexts = new Map<string, AuthContext>();
      for (const credential of SEEDED) {
        contexts.set(credential.name, auth.authenticate(credential.secret));
      }

      // THE CONTRACT, in one comparison.
      expect(askMatrix(auth, contexts)).toEqual(expectedMatrix(SEEDED));

      /*
        A matrix of all-false would satisfy the comparison above and prove nothing, so the
        fixture's own discriminating power is asserted too: it has to contain both answers, and
        it has to contain the two that matter most — a wildcard reaching a container it was never
        told about, and a scoped credential refused at somebody else's.
      */
      const observed = askMatrix(auth, contexts);
      expect(Object.values(observed).some((answer) => answer)).toBe(true);
      expect(Object.values(observed).some((answer) => !answer)).toBe(true);
      expect(observed[`root | plugins:manage | ${CONTAINER_MISSING}`]).toBe(true);
      expect(observed[`scoped | scenes:write | ${CONTAINER_B}`]).toBe(false);
      expect(observed[`scoped | tokens:mint | (no node)`]).toBe(true);

      /*
        THE ATTENUATION CASE. `narrow` and `root` are the same principal; `root` holds `*`. A
        model where a principal's rows reached all of its credentials would hand `narrow` the
        wildcard, which is both a parity break and authority a minter deliberately withheld.
      */
      const narrow = contexts.get("narrow");
      if (narrow === undefined) throw new Error("missing narrow credential");
      expect(auth.allows(narrow, "containers:read")).toBe(true);
      expect(auth.allows(narrow, "scenes:write")).toBe(false);
      expect(auth.allows(narrow, "plugins:manage", CONTAINER_A)).toBe(false);

      // Revocation is still refused durably, and still by the same code.
      expect(() => auth.authenticate(REVOKED_SECRET)).toThrow(ServiceError);

      /*
        THE OWNER IS UNDENIABLE. `grant` refuses a deny row that names the owner, so the only way
        to aim one at it is a CLASS row — which is admitted, because "any human here is
        read-only" is a sentence ADR 0011 exists to make sayable. It bites every other human and
        slides off the owner, at the root and at depth alike, which is what keeps administration
        from locking out its own administrator.
      */
      const owner = contexts.get("owner");
      const workspace = contexts.get("workspace");
      if (owner === undefined || workspace === undefined) throw new Error("missing credential");
      auth.grant(
        {
          principal: { kind: "any-human" },
          node: formatManifoldUri({ kind: "container", containerId: CONTAINER_A }),
          caps: ["containers:write"],
          effect: "deny",
          reach: "subtree",
        },
        owner,
      );
      expect(auth.allows(owner, "containers:write", CONTAINER_A)).toBe(true);
      expect(auth.allows(workspace, "containers:write", CONTAINER_A)).toBe(false);
      expect(auth.allows(workspace, "containers:write", CONTAINER_B)).toBe(true);
      expect(() =>
        auth.grant(
          {
            principal: { kind: "principal", id: owner.principal.id },
            node: MANIFOLD_ROOT_URI,
            caps: ["*"],
            effect: "deny",
            reach: "subtree",
          },
          owner,
        ),
      ).toThrow(ServiceError);

      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("materializes one row per LIVE credential, at the node its scope names", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-grant-rows-"));
    const path = join(dir, "manifold.db");
    try {
      seedPreV13(path);
      const db = openDatabase(path);
      const rows = db
        .query<GrantDump, []>(
          `SELECT id, principal_kind, principal_id, node, caps, effect, reach
           FROM grants ORDER BY id`,
        )
        .all();

      /*
        Six tokens carry caps and 13 materializes six rows; `t-machine` carries `[]` and becomes
        none, because a grant granting nothing answers no question. One LIVE share becomes an
        instance row at its container; the revoked share becomes nothing, which is the same rule
        `revokeShare` applies going forward. Then 16 runs on the same replay and applies that
        rule to TOKENS: `t-revoked`'s row is retired (issue #140), because a row only its dead
        credential could reach is authority nobody holds — so the replay lands on five token rows,
        and the revoked token's `caps` on its own row is the account of what it was issued.
      */
      expect(rows.map((row) => row.id)).toEqual([
        "grant-share-s-live",
        "grant-token-t-narrow",
        "grant-token-t-root",
        "grant-token-t-scoped",
        "grant-token-t-ticket",
        "grant-token-t-workspace",
      ]);
      expect(rows.every((row) => row.effect === "allow" && row.reach === "subtree")).toBe(true);

      const byId = new Map(rows.map((row) => [row.id, row]));
      const containerA = formatManifoldUri({ kind: "container", containerId: CONTAINER_A });
      expect(byId.get("grant-token-t-root")?.node).toBe(MANIFOLD_ROOT_URI);
      expect(byId.get("grant-token-t-root")?.principal_kind).toBe("principal");
      expect(byId.get("grant-token-t-root")?.principal_id).toBe("p-root");
      expect(byId.get("grant-token-t-scoped")?.node).toBe(containerA);
      expect(byId.get("grant-token-t-scoped")?.caps).toBe(
        '["containers:read","scenes:write","terminals:write","tokens:mint"]',
      );

      /*
        THE SHARE, as ADR 0011 reads one: a subtree grant at the shared node addressed to the
        guest INSTANCE. That is what lets a ticket principal inherit the share's authority through
        its origin instead of the host minting a row per guest.
      */
      const share = byId.get("grant-share-s-live");
      expect(share?.principal_kind).toBe("instance");
      expect(share?.principal_id).toBe(GUEST_ORIGIN);
      expect(share?.node).toBe(containerA);

      // Every LIVE credential that has authority references the row carrying it; the revoked
      // one lost its reference with its row rather than keeping a dangling edge.
      const references = db
        .query<{ id: string; grant_id: string | null }, []>(
          "SELECT id, grant_id FROM tokens ORDER BY id",
        )
        .all();
      expect(Object.fromEntries(references.map((row) => [row.id, row.grant_id]))).toEqual({
        "t-machine": null,
        "t-narrow": "grant-token-t-narrow",
        "t-revoked": null,
        "t-root": "grant-token-t-root",
        "t-scoped": "grant-token-t-scoped",
        "t-ticket": "grant-token-t-ticket",
        "t-workspace": "grant-token-t-workspace",
      });
      expect(
        db.query<{ caps: string }, []>("SELECT caps FROM tokens WHERE id = 't-revoked'").get()
          ?.caps,
      ).toBe('["*"]');
      // Rows went one way in 13 and again in 16, so each left its image beside the database.
      expect(existsSync(`${path}.pre-v13.bak`)).toBeTrue();
      expect(existsSync(`${path}.pre-v16.bak`)).toBeTrue();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("minted credentials answer the same questions as migrated ones", () => {
  test("the whole matrix, on a database that never held a flat-only token", () => {
    const store = new ServerStore(openDatabase(":memory:"));
    const runtime = new FakeRuntime();
    const auth = new AuthService(store, OWNER_KEY, runtime);
    const root = auth.authenticate(OWNER_KEY);
    for (const id of [CONTAINER_A, CONTAINER_B]) {
      store.createContainer({ id, name: id, createdAt: runtime.now(), discipline: "canvas" });
    }

    /*
      MINTED, not seeded — the same authority shapes issued through the real ladder, so the
      comparison catches a `persistToken` that wrote a row the migration would not have written.

      A MACHINE token is not in this matrix, and its absence is the property rather than a gap: a
      machine secret is not a principal bearer, so it never reaches `allows` at all. It is
      asserted below as what it is. The caps-`[]` authority SHAPE — a credential that
      materializes to no grant row — is exercised by the migrated half, where such a token sits
      on a principal row and can therefore be interrogated.
    */
    const minted: Credential[] = [
      { name: "owner", secret: OWNER_KEY, caps: ["*"], containerScope: null },
    ];
    const contexts = new Map<string, AuthContext>([["owner", root]]);

    const wildcard = auth.bootstrapPrincipal({ name: "ana", kind: "human" }, root);
    minted.push({ name: "root", secret: wildcard.token, caps: ["*"], containerScope: null });

    const workspaceCaps: Cap[] = [
      "containers:read",
      "containers:write",
      "scenes:write",
      "tokens:mint",
    ];
    const workspace = auth.mintToken(
      { principal: { name: "delegate", kind: "human" }, caps: workspaceCaps },
      root,
    );
    minted.push({
      name: "workspace",
      secret: workspace.token,
      caps: workspaceCaps,
      containerScope: null,
    });

    const scopedCaps: Cap[] = ["containers:read", "scenes:write", "terminals:write", "tokens:mint"];
    const scoped = auth.mintToken(
      {
        principal: { name: "builder", kind: "agent" },
        caps: scopedCaps,
        containerId: CONTAINER_A,
      },
      root,
    );
    minted.push({
      name: "scoped",
      secret: scoped.token,
      caps: scopedCaps,
      containerScope: CONTAINER_A,
    });

    /*
      A REAL share ticket, through the real two-step: mint the share, then walk through it as a
      foreign principal. The ticket's authority must land exactly where the flat rule put it, and
      the share's own instance row must not move it — the ticket already holds those caps at that
      node, so the union of the two rows is the ticket's own cap set and nothing more.
    */
    const shareCaps: Cap[] = ["containers:read", "scenes:write"];
    const share = auth.mintShare(
      {
        node: { kind: "container", containerId: CONTAINER_A },
        caps: shareCaps,
        origin: GUEST_ORIGIN,
      },
      root,
    );
    const ticket = auth.mintShareTicket(auth.authenticateShare(share.token), {
      id: "guest-1",
      kind: "human",
      name: "remote",
      color: "#ea580c",
      origin: GUEST_ORIGIN,
    });
    minted.push({
      name: "ticket",
      secret: ticket.token,
      caps: shareCaps,
      containerScope: CONTAINER_A,
    });

    /*
      The one credential that is deliberately outside the matrix, and the reason: a machine
      secret authenticates as a MACHINE and is refused as a principal bearer, exactly as it was
      before grant rows existed. `persistToken` writes no row for it, so there is nothing here
      the waterfall could have changed.
    */
    const machine = auth.enrollLocalMachine("local");
    expect(auth.authenticateMachine(machine.machineToken).name).toBe("local");
    expect(() => auth.authenticate(machine.machineToken)).toThrow(ServiceError);

    for (const credential of minted) {
      if (credential.name === "owner") continue;
      contexts.set(credential.name, auth.authenticate(credential.secret));
    }

    expect(askMatrix(auth, contexts)).toEqual(expectedMatrix(minted));

    /*
      The ticket is confined by its NODE and not by its origin: the share's instance row sits at
      CONTAINER_A, so a guest principal reaches nothing at CONTAINER_B even though the row names
      its whole instance.
    */
    const ticketContext = contexts.get("ticket");
    if (ticketContext === undefined) throw new Error("missing ticket credential");
    expect(auth.allows(ticketContext, "containers:read", CONTAINER_A)).toBe(true);
    expect(auth.allows(ticketContext, "containers:read", CONTAINER_B)).toBe(false);

    /*
      Cutting the pipe retires the row, so the shared node's authority goes with it — and the
      ticket, whose own token row is revoked by the same call, is refused before any walk.
    */
    const sharedNode = formatManifoldUri({ kind: "container", containerId: CONTAINER_A });
    auth.revokeShare(share.share.id, root);
    expect(store.listGrants({ node: sharedNode }).map((row) => row.principal.kind)).not.toContain(
      "instance",
    );

    store.close();
  });
});

/**
 * PRECEDENCE BELOW THE SEAM. The matrix above proves the waterfall answers the flat model's
 * questions identically; these prove the answers the flat model could not express at all, which
 * is the other half of ADR 0011 and is unreachable through `allows` because that seam only ever
 * builds a root or a container node. `effectiveCaps` is the surface a grant door names an element
 * through, so it is the surface these ask.
 */
describe("the waterfall's own precedence", () => {
  const ELEMENT = `manifold://container/${CONTAINER_A}/element/el-1`;

  function evaluatorFixture() {
    const store = new ServerStore(openDatabase(":memory:"));
    const runtime = new FakeRuntime();
    const auth = new AuthService(store, OWNER_KEY, runtime);
    const root = auth.authenticate(OWNER_KEY);
    for (const id of [CONTAINER_A, CONTAINER_B]) {
      store.createContainer({ id, name: id, createdAt: runtime.now(), discipline: "canvas" });
    }
    const grant = auth.mintToken(
      {
        principal: { name: "ana", kind: "human" },
        caps: ["containers:read", "containers:write", "scenes:write"],
      },
      root,
    );
    return { store, auth, root, subject: auth.authenticate(grant.token) };
  }

  test("machine grants stay on that root child and resolve allow/deny with the same waterfall", () => {
    const where = evaluatorFixture();
    const node = "manifold://machine/m1";
    const principal = { kind: "principal" as const, id: where.subject.principal.id };
    expect(where.auth.effectiveCaps(where.subject, node).has("machines:mint")).toBe(false);
    where.auth.grant(
      { principal, node, caps: ["machines:mint"], effect: "allow", reach: "subtree" },
      where.root,
    );
    expect(where.auth.effectiveCaps(where.subject, node).has("machines:mint")).toBe(true);
    expect(
      where.auth.effectiveCaps(where.subject, "manifold://machine/m2").has("machines:mint"),
    ).toBe(false);
    expect(where.auth.effectiveCaps(where.subject, "manifold://").has("machines:mint")).toBe(false);
    where.auth.grant(
      { principal, node, caps: ["machines:mint"], effect: "deny", reach: "node" },
      where.root,
    );
    expect(where.auth.effectiveCaps(where.subject, node).has("machines:mint")).toBe(false);
    expect(where.auth.effectiveCaps(where.subject, node).has("containers:read")).toBe(true);
    where.store.close();
  });

  test("a deny at depth bites one capability through a shallower allow and leaves the rest", () => {
    const where = evaluatorFixture();
    expect(where.auth.effectiveCaps(where.subject, ELEMENT).has("scenes:write")).toBe(true);

    where.auth.grant(
      {
        principal: { kind: "principal", id: where.subject.principal.id },
        node: ELEMENT,
        caps: ["scenes:write"],
        effect: "deny",
        reach: "node",
      },
      where.root,
    );

    // Denied exactly where it was written, and exactly for what it named.
    const atElement = where.auth.effectiveCaps(where.subject, ELEMENT);
    expect(atElement.has("scenes:write")).toBe(false);
    expect(atElement.has("containers:read")).toBe(true);
    // And nowhere else: the container the element lives in is untouched.
    expect(where.auth.allows(where.subject, "scenes:write", CONTAINER_A)).toBe(true);
    where.store.close();
  });

  test("reach node applies at its exact node only, so it does not flow to what it holds", () => {
    const where = evaluatorFixture();
    where.auth.grant(
      {
        principal: { kind: "principal", id: where.subject.principal.id },
        node: formatManifoldUri({ kind: "container", containerId: CONTAINER_A }),
        caps: ["containers:write"],
        effect: "deny",
        reach: "node",
      },
      where.root,
    );
    expect(where.auth.allows(where.subject, "containers:write", CONTAINER_A)).toBe(false);
    // The element is DEEPER than the denied node, and a node-reach row does not descend.
    expect(where.auth.effectiveCaps(where.subject, ELEMENT).has("containers:write")).toBe(true);
    where.store.close();
  });

  test("a named allow outranks a class deny at the same node: specificity above effect", () => {
    const where = evaluatorFixture();
    const node = formatManifoldUri({ kind: "container", containerId: CONTAINER_A });
    where.auth.grant(
      {
        principal: { kind: "any-human" },
        node,
        caps: ["scenes:write"],
        effect: "deny",
        reach: "subtree",
      },
      where.root,
    );
    expect(where.auth.allows(where.subject, "scenes:write", CONTAINER_A)).toBe(false);

    /*
      "Everyone here is read-only except Ana" — the sentence ADR 0011 orders rule 2 above rule 3
      to make sayable. The named row is not deeper and does not deny; it wins on specificity
      alone, which is the one ordering in the precedence relation with no second-best reading.
    */
    where.auth.grant(
      {
        principal: { kind: "principal", id: where.subject.principal.id },
        node,
        caps: ["scenes:write"],
        effect: "allow",
        reach: "subtree",
      },
      where.root,
    );
    expect(where.auth.allows(where.subject, "scenes:write", CONTAINER_A)).toBe(true);
    where.store.close();
  });

  test("an administered allow widens a live credential, with no re-authentication", () => {
    const where = evaluatorFixture();
    // Not in the token's caps, so not in its own row either.
    expect(where.auth.allows(where.subject, "terminals:spawn", CONTAINER_A)).toBe(false);
    where.auth.grant(
      {
        principal: { kind: "any-human" },
        node: formatManifoldUri({ kind: "container", containerId: CONTAINER_A }),
        caps: ["terminals:spawn"],
        effect: "allow",
        reach: "subtree",
      },
      where.root,
    );
    // The SAME AuthContext, whose verdicts were already memoized above: the epoch discarded them.
    expect(where.auth.allows(where.subject, "terminals:spawn", CONTAINER_A)).toBe(true);
    expect(where.auth.allows(where.subject, "terminals:spawn", CONTAINER_B)).toBe(false);
    where.store.close();
  });

  test("an instance row sits out a local principal's walk, and a class row reads its kind", () => {
    const where = evaluatorFixture();
    const node = formatManifoldUri({ kind: "container", containerId: CONTAINER_A });
    where.auth.grant(
      {
        principal: { kind: "instance", origin: GUEST_ORIGIN },
        node,
        caps: ["machines:mint"],
        effect: "allow",
        reach: "subtree",
      },
      where.root,
    );
    where.auth.grant(
      {
        principal: { kind: "any-agent" },
        node,
        caps: ["plugins:manage"],
        effect: "allow",
        reach: "subtree",
      },
      where.root,
    );
    /*
      The subject is a LOCAL HUMAN: it has no origin, so ADR 0011's federation form stays inert
      for it, and it is not an agent, so the class row addressed to agents never names it.
    */
    expect(where.auth.allows(where.subject, "machines:mint", CONTAINER_A)).toBe(false);
    expect(where.auth.allows(where.subject, "plugins:manage", CONTAINER_A)).toBe(false);
    where.store.close();
  });
});
