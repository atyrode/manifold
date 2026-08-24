import { describe, expect, test } from "bun:test";
import type { Pad } from "@manifold/protocol";
import { AuthService, ServiceError } from "../src/auth.ts";
import { sha256Hex } from "../src/stores.ts";
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
