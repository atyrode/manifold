import { describe, expect, test } from "bun:test";
import type { Pad } from "@manifold/protocol";
import { AuthService, ServiceError } from "../src/auth.ts";
import { sha256Hex } from "../src/stores.ts";
import type { ServerStore } from "../src/stores.ts";
import { FakeRuntime, testStore } from "./helpers.ts";

interface TokenDumpRow {
  id: string;
  hash: string;
  principal_id: string;
  caps: string;
  pad_id: string | null;
  created_at: number;
  revoked_at: number | null;
}

interface CountRow {
  count: number;
}

function tableCount(store: ServerStore, table: "events" | "tokens"): number {
  return store.db.query<CountRow, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count;
}

function authFixture() {
  const runtime = new FakeRuntime();
  const store = testStore();
  const ownerKey = "a".repeat(64);
  const auth = new AuthService(store, ownerKey, runtime);
  const root = auth.authenticate(ownerKey);
  const pad: Pad = { id: runtime.newId(), name: "auth pad", createdAt: runtime.now() };
  store.createPad(pad);
  return { runtime, store, auth, root, pad };
}

function expectForbidden(action: () => unknown): void {
  try {
    action();
    throw new Error("expected forbidden rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceError);
    if (error instanceof ServiceError) expect(error.code).toBe("forbidden");
  }
}

describe("AuthService attenuation", () => {
  test("delegated minters cannot widen caps or mint wildcard", () => {
    const fixture = authFixture();
    const delegatedGrant = fixture.auth.mintToken(
      {
        principal: { name: "delegate", kind: "agent" },
        caps: ["tokens:mint", "scene:write"],
        padId: fixture.pad.id,
      },
      fixture.root,
    );
    const delegated = fixture.auth.authenticate(delegatedGrant.token);

    const child = fixture.auth.mintToken(
      {
        principal: { name: "child", kind: "agent" },
        caps: ["scene:write"],
      },
      delegated,
    );
    expect(child.caps).toEqual(["scene:write"]);
    expect(child.padId).toBe(fixture.pad.id);

    expectForbidden(() =>
      fixture.auth.mintToken(
        { principal: { name: "wider", kind: "agent" }, caps: ["terminal:write"] },
        delegated,
      ),
    );
    expectForbidden(() =>
      fixture.auth.mintToken(
        { principal: { name: "root-child", kind: "human" }, caps: ["*"] },
        delegated,
      ),
    );
    expectForbidden(() =>
      fixture.auth.mintToken(
        {
          principal: { name: "scoped-root", kind: "human" },
          caps: ["*"],
          padId: fixture.pad.id,
        },
        fixture.root,
      ),
    );
    fixture.store.close();
  });

  test("machine enrollment requires machines:mint rather than scene or terminal caps", () => {
    const fixture = authFixture();
    const ordinaryGrant = fixture.auth.mintToken(
      {
        principal: { name: "ordinary", kind: "agent" },
        caps: ["scene:write", "terminal:write"],
      },
      fixture.root,
    );
    const ordinary = fixture.auth.authenticate(ordinaryGrant.token);
    expectForbidden(() => fixture.auth.enrollMachine("denied", ordinary));

    const machineMinterGrant = fixture.auth.mintToken(
      {
        principal: { name: "enroller", kind: "human" },
        caps: ["machines:mint"],
      },
      fixture.root,
    );
    const machineMinter = fixture.auth.authenticate(machineMinterGrant.token);
    const enrolled = fixture.auth.enrollMachine("allowed", machineMinter);
    expect(enrolled.machine.name).toBe("allowed");
    expect(enrolled.machineToken).not.toBe("");
    fixture.store.close();
  });
});

describe("AuthService transaction boundaries", () => {
  test("persistToken rolls back its token when audit event insertion fails", () => {
    const fixture = authFixture();
    const tokensBefore = tableCount(fixture.store, "tokens");
    const eventsBefore = tableCount(fixture.store, "events");
    fixture.store.db.exec(`
      CREATE TEMP TRIGGER fail_token_event BEFORE INSERT ON events
      WHEN NEW.type = 'token_minted'
      BEGIN
        SELECT RAISE(ABORT, 'injected event conflict');
      END;
    `);

    expect(() =>
      fixture.auth.mintToken(
        { principalId: fixture.root.principal.id, caps: ["pads:read"] },
        fixture.root,
      ),
    ).toThrow("injected event conflict");
    expect(tableCount(fixture.store, "tokens")).toBe(tokensBefore);
    expect(tableCount(fixture.store, "events")).toBe(eventsBefore);
    fixture.store.close();
  });

  test("persistMachine rolls back its token and event when machine insertion fails", () => {
    const fixture = authFixture();
    const tokensBefore = tableCount(fixture.store, "tokens");
    const eventsBefore = tableCount(fixture.store, "events");
    fixture.store.db.exec(`
      CREATE TEMP TRIGGER fail_machine_insert BEFORE INSERT ON machines
      BEGIN
        SELECT RAISE(ABORT, 'injected machine conflict');
      END;
    `);

    expect(() => fixture.auth.enrollLocalMachine("conflicting")).toThrow(
      "injected machine conflict",
    );
    expect(tableCount(fixture.store, "tokens")).toBe(tokensBefore);
    expect(tableCount(fixture.store, "events")).toBe(eventsBefore);
    fixture.store.close();
  });

  test("rotateMachineToken rolls back revocation and mint when machine update fails", () => {
    const fixture = authFixture();
    const enrollment = fixture.auth.enrollLocalMachine("rotating");
    const tokensBefore = tableCount(fixture.store, "tokens");
    const eventsBefore = tableCount(fixture.store, "events");
    fixture.store.db.exec(`
      CREATE TEMP TRIGGER fail_machine_update BEFORE UPDATE ON machines
      BEGIN
        SELECT RAISE(ABORT, 'injected machine conflict');
      END;
    `);

    expect(() => fixture.auth.rotateMachineToken(enrollment.machine)).toThrow(
      "injected machine conflict",
    );
    expect(tableCount(fixture.store, "tokens")).toBe(tokensBefore);
    expect(tableCount(fixture.store, "events")).toBe(eventsBefore);
    expect(fixture.store.getToken(enrollment.machine.tokenId)?.revokedAt).toBeNull();
    expect(fixture.store.getMachine(enrollment.machine.id)?.tokenId).toBe(
      enrollment.machine.tokenId,
    );
    fixture.store.close();
  });
});

describe("Token secret persistence", () => {
  test("stores only SHA-256 hashes and never the returned raw bearer", () => {
    const fixture = authFixture();
    const grant = fixture.auth.mintToken(
      {
        principal: { name: "hash-check", kind: "human" },
        caps: ["pads:read"],
      },
      fixture.root,
    );
    const rows = fixture.store.db
      .query<TokenDumpRow, []>(
        "SELECT id, hash, principal_id, caps, pad_id, created_at, revoked_at FROM tokens",
      )
      .all();
    const row = rows.find((candidate) => candidate.hash === sha256Hex(grant.token));
    expect(row?.hash).toBe(sha256Hex(grant.token));
    expect(JSON.stringify(rows)).not.toContain(grant.token);
    fixture.store.close();
  });
});

describe("AuthService principal ownership", () => {
  test("a scoped minter cannot revoke a principal it did not create, while root can", () => {
    const fixture = authFixture();
    const delegatedGrant = fixture.auth.mintToken(
      {
        principal: { name: "scoped minter", kind: "agent" },
        caps: ["tokens:mint", "scene:write"],
        padId: fixture.pad.id,
      },
      fixture.root,
    );
    const delegated = fixture.auth.authenticate(delegatedGrant.token);
    const unrelated = fixture.auth.mintToken(
      {
        principal: { name: "unrelated", kind: "human" },
        caps: ["pads:read"],
      },
      fixture.root,
    );

    expectForbidden(() => fixture.auth.revokePrincipal(unrelated.principal.id, delegated));
    expect(fixture.auth.authenticate(unrelated.token).principal.id).toBe(unrelated.principal.id);
    expect(fixture.auth.revokePrincipal(unrelated.principal.id, fixture.root)).toBe(1);
    expect(() => fixture.auth.authenticate(unrelated.token)).toThrow(ServiceError);
    fixture.store.close();
  });

  test("a delegated minter cannot bind a token to the owner principal", () => {
    const fixture = authFixture();
    const delegatedGrant = fixture.auth.mintToken(
      {
        principal: { name: "delegate", kind: "agent" },
        caps: ["tokens:mint", "scene:write"],
        padId: fixture.pad.id,
      },
      fixture.root,
    );
    const delegated = fixture.auth.authenticate(delegatedGrant.token);

    expectForbidden(() =>
      fixture.auth.mintToken(
        {
          principalId: fixture.root.principal.id,
          caps: ["scene:write"],
        },
        delegated,
      ),
    );
    fixture.store.close();
  });

  test("scoped revocation affects only the actor-created principal's scoped tokens", () => {
    const fixture = authFixture();
    const delegatedGrant = fixture.auth.mintToken(
      {
        principal: { name: "delegate", kind: "agent" },
        caps: ["tokens:mint", "scene:write"],
        padId: fixture.pad.id,
      },
      fixture.root,
    );
    const delegated = fixture.auth.authenticate(delegatedGrant.token);
    const child = fixture.auth.mintToken(
      {
        principal: { name: "child", kind: "agent" },
        caps: ["scene:write"],
      },
      delegated,
    );
    const unscoped = fixture.auth.mintToken(
      {
        principalId: child.principal.id,
        caps: ["pads:read"],
      },
      fixture.root,
    );

    expect(fixture.auth.revokePrincipal(child.principal.id, delegated)).toBe(1);
    expect(() => fixture.auth.authenticate(child.token)).toThrow(ServiceError);
    expect(fixture.auth.authenticate(unscoped.token).principal.id).toBe(child.principal.id);
    fixture.store.close();
  });
});
