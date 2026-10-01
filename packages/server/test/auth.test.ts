import { describe, expect, test } from "bun:test";
import {
  CreateRunCredentialResultSchema,
  type Cap,
  type Container,
  type Principal,
} from "@manifold/protocol";
import { AuthService, ServiceError } from "../src/auth.ts";
import { sha256Hex } from "../src/stores.ts";
import type { ServerStore } from "../src/stores.ts";
import { FakeRuntime, testStore } from "./helpers.ts";

interface TokenDumpRow {
  id: string;
  hash: string;
  principal_id: string;
  caps: string;
  container_id: string | null;
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
  const container: Container = {
    id: runtime.newId(),
    name: "auth container",
    createdAt: runtime.now(),
    discipline: "canvas",
  };
  store.createContainer(container);
  return { runtime, store, auth, root, container };
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
        principal: { name: "delegate", kind: "human" },
        caps: ["tokens:mint", "scenes:write"],
        containerId: fixture.container.id,
      },
      fixture.root,
    );
    const delegated = fixture.auth.authenticate(delegatedGrant.token);

    const child = fixture.auth.mintToken(
      {
        principal: { name: "child", kind: "human" },
        caps: ["scenes:write"],
      },
      delegated,
    );
    expect(child.caps).toEqual(["scenes:write"]);
    expect(child.containerId).toBe(fixture.container.id);

    expectForbidden(() =>
      fixture.auth.mintToken(
        { principal: { name: "wider", kind: "human" }, caps: ["terminals:write"] },
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
          containerId: fixture.container.id,
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
        principal: { name: "ordinary", kind: "human" },
        caps: ["scenes:write", "terminals:write"],
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
        { principalId: fixture.root.principal.id, caps: ["containers:read"] },
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
        caps: ["containers:read"],
      },
      fixture.root,
    );
    const rows = fixture.store.db
      .query<TokenDumpRow, []>(
        "SELECT id, hash, principal_id, caps, container_id, created_at, revoked_at FROM tokens",
      )
      .all();
    const row = rows.find((candidate) => candidate.hash === sha256Hex(grant.token));
    expect(row?.hash).toBe(sha256Hex(grant.token));
    expect(JSON.stringify(rows)).not.toContain(grant.token);
    fixture.store.close();
  });
});

describe("AuthService issuer-owned credential administration", () => {
  test("a scoped minter cannot revoke a principal for which it issued no credential", () => {
    const fixture = authFixture();
    const delegatedGrant = fixture.auth.mintToken(
      {
        principal: { name: "scoped minter", kind: "human" },
        caps: ["tokens:mint", "scenes:write"],
        containerId: fixture.container.id,
      },
      fixture.root,
    );
    const delegated = fixture.auth.authenticate(delegatedGrant.token);
    const unrelated = fixture.auth.mintToken(
      {
        principal: { name: "unrelated", kind: "human" },
        caps: ["containers:read"],
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
        principal: { name: "delegate", kind: "human" },
        caps: ["tokens:mint", "scenes:write"],
        containerId: fixture.container.id,
      },
      fixture.root,
    );
    const delegated = fixture.auth.authenticate(delegatedGrant.token);

    expectForbidden(() =>
      fixture.auth.mintToken(
        {
          principalId: fixture.root.principal.id,
          caps: ["scenes:write"],
        },
        delegated,
      ),
    );
    fixture.store.close();
  });

  test("scoped issuer withdrawal leaves same-scope and unscoped foreign credentials intact", () => {
    const fixture = authFixture();
    const delegatedGrant = fixture.auth.mintToken(
      {
        principal: { name: "delegate", kind: "human" },
        caps: ["tokens:mint", "scenes:write"],
        containerId: fixture.container.id,
      },
      fixture.root,
    );
    const delegated = fixture.auth.authenticate(delegatedGrant.token);
    const child = fixture.auth.mintToken(
      {
        principal: { name: "child", kind: "human" },
        caps: ["scenes:write"],
      },
      delegated,
    );
    const foreignScoped = fixture.auth.mintToken(
      {
        principalId: child.principal.id,
        caps: ["scenes:write"],
        containerId: fixture.container.id,
      },
      fixture.root,
    );
    const foreignUnscoped = fixture.auth.mintToken(
      {
        principalId: child.principal.id,
        caps: ["containers:read"],
      },
      fixture.root,
    );
    const foreignGrantIds = [foreignScoped, foreignUnscoped].map(
      ({ token }) => fixture.store.getTokenByHash(sha256Hex(token))?.grantId,
    );

    expect(fixture.auth.revokePrincipal(child.principal.id, delegated)).toBe(1);
    expect(() => fixture.auth.authenticate(child.token)).toThrow(ServiceError);
    for (const foreign of [foreignScoped, foreignUnscoped]) {
      expect(fixture.auth.authenticate(foreign.token).principal.id).toBe(child.principal.id);
    }
    for (const grantId of foreignGrantIds) {
      expect(typeof grantId).toBe("string");
      if (typeof grantId !== "string") throw new Error("foreign credential has no grant");
      expect(fixture.store.getGrant(grantId)).not.toBeNull();
    }
    expectForbidden(() =>
      fixture.auth.mintToken(
        { principalId: child.principal.id, caps: ["scenes:write"] },
        delegated,
      ),
    );
    fixture.store.close();
  });
  test("unscoped issuer withdrawal is provenance-bound while self withdrawal is not", () => {
    const fixture = authFixture();
    const issuerGrant = fixture.auth.mintToken(
      {
        principal: { name: "issuer", kind: "human" },
        caps: ["tokens:mint", "containers:read"],
      },
      fixture.root,
    );
    const issuer = fixture.auth.authenticate(issuerGrant.token);
    const child = fixture.auth.mintToken(
      {
        principal: { name: "child", kind: "human" },
        caps: ["containers:read"],
      },
      issuer,
    );
    const foreign = fixture.auth.mintToken(
      { principalId: child.principal.id, caps: ["containers:read"] },
      fixture.root,
    );

    expect(fixture.auth.revokePrincipal(child.principal.id, issuer)).toBe(1);
    expect(() => fixture.auth.authenticate(child.token)).toThrow(ServiceError);
    expect(fixture.auth.authenticate(foreign.token).principal.id).toBe(child.principal.id);

    const otherIssuerCredential = fixture.auth.mintToken(
      {
        principalId: issuer.principal.id,
        caps: ["tokens:mint", "containers:read"],
      },
      fixture.root,
    );
    expect(fixture.auth.revokePrincipal(issuer.principal.id, issuer)).toBe(2);
    expect(() => fixture.auth.authenticate(issuerGrant.token)).toThrow(ServiceError);
    expect(() => fixture.auth.authenticate(otherIssuerCredential.token)).toThrow(ServiceError);
    fixture.store.close();
  });

  test("a foreign live credential cannot revive an expired issuer edge", () => {
    const fixture = authFixture();
    const issuerGrant = fixture.auth.mintToken(
      {
        principal: { name: "issuer", kind: "human" },
        caps: ["tokens:mint", "scenes:write"],
      },
      fixture.root,
    );
    const issuer = fixture.auth.authenticate(issuerGrant.token);
    const child = fixture.auth.mintToken(
      {
        principal: { name: "child", kind: "human" },
        caps: ["scenes:write"],
      },
      issuer,
    );

    fixture.runtime.time = child.expiresAt! + 1;
    const renewedIssuer = fixture.auth.mintToken(
      {
        principalId: issuer.principal.id,
        caps: ["tokens:mint", "scenes:write"],
      },
      fixture.root,
    );
    const foreign = fixture.auth.mintToken(
      { principalId: child.principal.id, caps: ["containers:read"] },
      fixture.root,
    );
    const currentIssuer = fixture.auth.authenticate(renewedIssuer.token);

    expectForbidden(() =>
      fixture.auth.mintToken(
        { principalId: child.principal.id, caps: ["scenes:write"] },
        currentIssuer,
      ),
    );
    expect(fixture.auth.authenticate(foreign.token).principal.id).toBe(child.principal.id);
    fixture.store.close();
  });
});

const RECIPIENT_ORIGIN = "https://guest.example";
const RECIPIENT_GUEST: Principal = {
  id: "guest-local",
  kind: "human",
  name: "guest",
  color: "#3355cc",
};

function recipientFixture(caps: Cap[] = ["containers:read", "scenes:write"]) {
  const fix = authFixture();
  const minted = fix.auth.mintShare(
    {
      node: { kind: "container", containerId: fix.container.id },
      caps,
      origin: RECIPIENT_ORIGIN,
    },
    fix.root,
  );
  const share = fix.auth.authenticateShare(minted.token);
  return { ...fix, share, minted };
}

describe("host-administered share recipients", () => {
  test("a pending proposal issues no credential, and omission uses only the approved subset", () => {
    const fix = recipientFixture();
    try {
      const before = tableCount(fix.store, "tokens");
      expect(() => fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST)).toThrow(
        "recipient_unapproved",
      );
      expect(tableCount(fix.store, "tokens")).toBe(before);
      expect(fix.store.shareTicketPrincipals(fix.share.id)).toEqual([]);
      expect(fix.auth.listShareRecipients(fix.share.id, fix.root)).toEqual([
        {
          shareId: fix.share.id,
          origin: RECIPIENT_ORIGIN,
          guestPrincipal: RECIPIENT_GUEST,
          requestedCaps: ["containers:read", "scenes:write"],
          caps: [],
          requestedAt: fix.runtime.now(),
          approvedAt: null,
          approvedBy: null,
          removedAt: null,
        },
      ]);
      fix.runtime.time += 1;
      const approved = fix.auth.approveShareRecipient(
        {
          shareId: fix.share.id,
          guestPrincipalId: RECIPIENT_GUEST.id,
          caps: ["containers:read"],
        },
        fix.root,
      );
      expect(approved.approvedBy).toBe(fix.root.principal.id);
      expect(approved.approvedAt).toBe(fix.runtime.now());
      const ticket = fix.auth.mintShareTicket(
        {
          ...fix.share,
          origin: "https://forged.example",
          caps: ["tokens:mint"],
        },
        RECIPIENT_GUEST,
      );
      expect(ticket.principal.id).not.toBe(RECIPIENT_GUEST.id);
      expect(ticket.principal.origin).toBe(RECIPIENT_ORIGIN);
      expect(ticket.caps).toEqual(["containers:read"]);
      const actor = fix.auth.authenticate(ticket.token);
      expect(fix.auth.allows(actor, "containers:read", fix.container.id)).toBe(true);
      expect(fix.auth.allows(actor, "scenes:write", fix.container.id)).toBe(false);
      expect(() => fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST, ["scenes:write"])).toThrow(
        "recipient_caps_refused",
      );
      expect(fix.auth.listShareRecipients(fix.share.id, fix.root)[0]?.requestedCaps).toEqual([
        "scenes:write",
      ]);
      expect(() => fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST, ["tokens:mint"])).toThrow(
        "recipient_caps_refused",
      );
      expect(fix.auth.listShareRecipients(fix.share.id, fix.root)[0]?.caps).toEqual([
        "containers:read",
      ]);
    } finally {
      fix.store.close();
    }
  });

  test("approval stays within the proposal, share ceiling, current mint caps and issuer scope", () => {
    const fix = authFixture();
    try {
      const issued = fix.auth.mintToken(
        {
          principal: { name: "share issuer", kind: "human" },
          caps: ["tokens:mint", "containers:read", "scenes:write"],
          containerId: fix.container.id,
        },
        fix.root,
      );
      const issuer = fix.auth.authenticate(issued.token);
      const minted = fix.auth.mintShare(
        {
          node: { kind: "container", containerId: fix.container.id },
          origin: RECIPIENT_ORIGIN,
          caps: ["containers:read", "scenes:write"],
        },
        issuer,
      );
      const share = fix.auth.authenticateShare(minted.token);
      expect(() => fix.auth.mintShareTicket(share, RECIPIENT_GUEST, ["containers:read"])).toThrow(
        "recipient_unapproved",
      );
      const input = {
        shareId: share.id,
        guestPrincipalId: RECIPIENT_GUEST.id,
        caps: ["scenes:write"] as Cap[],
      };
      expectForbidden(() => fix.auth.approveShareRecipient(input, fix.root));
      expect(() => fix.auth.mintShareTicket(share, RECIPIENT_GUEST)).toThrow(
        "recipient_unapproved",
      );
      const narrower = fix.auth.authenticate(
        fix.auth.mintToken(
          {
            principalId: issuer.principal.id,
            caps: ["tokens:mint", "containers:read"],
            containerId: fix.container.id,
          },
          fix.root,
        ).token,
      );
      expectForbidden(() => fix.auth.approveShareRecipient(input, narrower));
      const foreign = fix.auth.authenticate(
        fix.auth.mintToken(
          {
            principal: { name: "foreign minter", kind: "human" },
            caps: ["tokens:mint", "containers:read", "scenes:write"],
          },
          fix.root,
        ).token,
      );
      expectForbidden(() => fix.auth.approveShareRecipient(input, foreign));
      expectForbidden(() => fix.auth.listShareRecipients(share.id, foreign));
      expectForbidden(() =>
        fix.auth.removeShareRecipient(
          {
            shareId: share.id,
            guestPrincipalId: RECIPIENT_GUEST.id,
          },
          foreign,
        ),
      );
      const elsewhere = "other-container";
      fix.store.createContainer({
        id: elsewhere,
        name: "elsewhere",
        discipline: "canvas",
        createdAt: fix.runtime.now(),
      });
      const otherScope = fix.auth.authenticate(
        fix.auth.mintToken(
          {
            principalId: issuer.principal.id,
            caps: ["tokens:mint", "scenes:write"],
            containerId: elsewhere,
          },
          fix.root,
        ).token,
      );
      expectForbidden(() => fix.auth.approveShareRecipient(input, otherScope));
      expectForbidden(() => fix.auth.listShareRecipients(share.id, otherScope));
      const approved = fix.auth.approveShareRecipient(input, issuer);
      expect(approved.approvedBy).toBe(issuer.principal.id);
      fix.auth.revokePrincipal(issuer.principal.id, fix.root);
      expectForbidden(() => fix.auth.approveShareRecipient(input, issuer));
    } finally {
      fix.store.close();
    }
  });

  test("narrowing retires all relationship tickets and hot authority, not sibling credentials", () => {
    const fix = recipientFixture();
    try {
      const request = {
        shareId: fix.share.id,
        guestPrincipalId: RECIPIENT_GUEST.id,
        caps: ["containers:read", "scenes:write"] as Cap[],
      };
      expect(() => fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST)).toThrow(
        "recipient_unapproved",
      );
      fix.auth.approveShareRecipient(request, fix.root);
      const first = fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST);
      const second = fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST);
      expect(second.principal.id).toBe(first.principal.id);
      const hot = fix.auth.authenticate(first.token);
      expect(fix.auth.allows(hot, "scenes:write", fix.container.id)).toBe(true);
      const unrelated = fix.auth.mintToken(
        {
          principalId: first.principal.id,
          caps: ["containers:read"],
          containerId: fix.container.id,
        },
        fix.root,
      );
      const otherGuest = { ...RECIPIENT_GUEST, id: "other-guest" };
      expect(() => fix.auth.mintShareTicket(fix.share, otherGuest)).toThrow("recipient_unapproved");
      fix.auth.approveShareRecipient({ ...request, guestPrincipalId: otherGuest.id }, fix.root);
      const sibling = fix.auth.mintShareTicket(fix.share, otherGuest);
      const otherShare = fix.auth.mintShare(
        {
          node: { kind: "container", containerId: fix.container.id },
          origin: RECIPIENT_ORIGIN,
          caps: ["containers:read"],
        },
        fix.root,
      );
      const otherRecord = fix.auth.authenticateShare(otherShare.token);
      expect(() => fix.auth.mintShareTicket(otherRecord, RECIPIENT_GUEST)).toThrow(
        "recipient_unapproved",
      );
      fix.auth.approveShareRecipient(
        { ...request, shareId: otherRecord.id, caps: ["containers:read"] },
        fix.root,
      );
      const otherTicket = fix.auth.mintShareTicket(otherRecord, RECIPIENT_GUEST);
      const fenced: string[] = [];
      fix.auth.onRevoked((id) => {
        fenced.push(id);
        expect(fix.store.getShareRecipient(fix.share.id, RECIPIENT_GUEST.id)?.caps).toEqual([
          "containers:read",
        ]);
        expect(() => fix.auth.authenticate(first.token)).toThrow("revoked");
      });
      fix.runtime.time += 1;
      fix.auth.approveShareRecipient({ ...request, caps: ["containers:read"] }, fix.root);
      expect(fenced).toEqual([first.principal.id]);
      expect(() => fix.auth.authenticate(second.token)).toThrow("revoked");
      expect(fix.auth.restoreCredential(fix.auth.credentialReference(hot))).toBeNull();
      expect(fix.auth.allows(hot, "scenes:write", fix.container.id)).toBe(false);
      for (const ticket of [first, second]) {
        expect(fix.store.getTokenByHash(sha256Hex(ticket.token))?.grantId).toBeNull();
      }
      for (const ticket of [sibling, otherTicket, unrelated]) {
        expect(fix.auth.authenticate(ticket.token).principal.id).toBe(ticket.principal.id);
      }
      const next = fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST);
      expect(next.principal.id).toBe(first.principal.id);
      expect(next.caps).toEqual(["containers:read"]);
      expect(() => fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST, request.caps)).toThrow(
        "recipient_caps_refused",
      );
    } finally {
      fix.store.close();
    }
  });

  test("removal preserves precise provenance and permits explicit reapproval without resurrection", () => {
    const fix = recipientFixture();
    try {
      const input = { shareId: fix.share.id, guestPrincipalId: RECIPIENT_GUEST.id };
      expect(() => fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST)).toThrow(
        "recipient_unapproved",
      );
      const approved = fix.auth.approveShareRecipient(
        { ...input, caps: ["containers:read"] },
        fix.root,
      );
      const ticket = fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST);
      fix.runtime.time += 1;
      const removed = fix.auth.removeShareRecipient(input, fix.root);
      expect(removed).toEqual({
        ...approved,
        requestedCaps: ["containers:read"],
        removedAt: fix.runtime.now(),
      });
      expect(fix.auth.resumableShareTicketPrincipals(fix.share.id)).toEqual([]);
      expect(() => fix.auth.authenticate(ticket.token)).toThrow("revoked");
      expect(() => fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST)).toThrow(
        "recipient_unapproved",
      );
      expect(fix.auth.listShareRecipients(fix.share.id, fix.root)[0]).toMatchObject({
        approvedBy: approved.approvedBy,
        approvedAt: approved.approvedAt,
        removedAt: removed.removedAt,
        caps: ["containers:read"],
      });
      expect(fix.store.db.query("SELECT removed_by FROM share_recipients").get()).toEqual({
        removed_by: fix.root.principal.id,
      });
      expect(fix.auth.removeShareRecipient(input, fix.root).removedAt).toBe(removed.removedAt);
      fix.runtime.time += 1;
      fix.auth.approveShareRecipient({ ...input, caps: ["containers:read"] }, fix.root);
      const reissued = fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST);
      expect(reissued.principal.id).toBe(ticket.principal.id);
      expect(fix.auth.authenticate(reissued.token).principal.id).toBe(ticket.principal.id);
      expect(() => fix.auth.authenticate(ticket.token)).toThrow("revoked");
      expect(fix.auth.revokeShare(fix.share.id, fix.root)).toBe(1);
      expect(() =>
        fix.auth.mintShareTicket({ ...fix.share, revokedAt: null }, RECIPIENT_GUEST),
      ).toThrow("revoked");
      expect(() =>
        fix.auth.approveShareRecipient({ ...input, caps: ["containers:read"] }, fix.root),
      ).toThrow("revoked");
    } finally {
      fix.store.close();
    }
  });

  test("an outer rollback preserves approval, bearer authority and deferred socket fences", () => {
    const fix = recipientFixture();
    try {
      const input = { shareId: fix.share.id, guestPrincipalId: RECIPIENT_GUEST.id };
      expect(() => fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST)).toThrow(
        "recipient_unapproved",
      );
      const approval = fix.auth.approveShareRecipient(
        { ...input, caps: ["containers:read", "scenes:write"] },
        fix.root,
      );
      const ticket = fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST);
      const fenced: string[] = [];
      fix.auth.onRevoked((id) => fenced.push(id));
      expect(() =>
        fix.store.transaction(() => {
          fix.auth.approveShareRecipient({ ...input, caps: ["containers:read"] }, fix.root);
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(fenced).toEqual([]);
      expect(fix.auth.listShareRecipients(fix.share.id, fix.root)[0]?.caps).toEqual(approval.caps);
      const context = fix.auth.authenticate(ticket.token);
      expect(fix.auth.allows(context, "scenes:write", fix.container.id)).toBe(true);
      expect(fix.auth.resumableShareTicketPrincipals(fix.share.id)).toEqual([ticket.principal.id]);
    } finally {
      fix.store.close();
    }
  });

  test("share ceilings stay credential-local while standalone origin grants remain administered authority", () => {
    const fix = recipientFixture();
    try {
      const input = { shareId: fix.share.id, guestPrincipalId: RECIPIENT_GUEST.id };
      expect(() => fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST)).toThrow(
        "recipient_unapproved",
      );
      fix.auth.approveShareRecipient({ ...input, caps: ["containers:read"] }, fix.root);
      const ticket = fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST);
      const recipient = fix.auth.authenticate(ticket.token);
      fix.auth.mintShare(
        {
          node: { kind: "container", containerId: fix.container.id },
          caps: ["scenes:write"],
          origin: RECIPIENT_ORIGIN,
        },
        fix.root,
      );
      const independent = fix.auth.mintToken(
        {
          principalId: ticket.principal.id,
          caps: ["containers:read"],
          containerId: fix.container.id,
        },
        fix.root,
      );
      const independentActor = fix.auth.authenticate(independent.token);
      expect(fix.auth.allows(recipient, "scenes:write", fix.container.id)).toBe(false);
      expect(fix.auth.allows(independentActor, "scenes:write", fix.container.id)).toBe(false);
      const administered = fix.auth.grant(
        {
          principal: { kind: "instance", origin: RECIPIENT_ORIGIN },
          node: `manifold://container/${fix.container.id}`,
          caps: ["scenes:write"],
          effect: "allow",
          reach: "subtree",
        },
        fix.root,
      );
      expect(fix.auth.allows(recipient, "containers:read", fix.container.id)).toBe(true);
      expect(fix.auth.allows(recipient, "scenes:write", fix.container.id)).toBe(false);
      expect(fix.auth.allows(independentActor, "scenes:write", fix.container.id)).toBe(true);
      fix.auth.revokeGrant(administered.id, fix.root);
      expect(fix.auth.allows(independentActor, "scenes:write", fix.container.id)).toBe(false);
    } finally {
      fix.store.close();
    }
  });

  test("share-owned grants have one withdrawal door and missing ceilings refuse approval and resume", () => {
    const fix = recipientFixture();
    try {
      const input = { shareId: fix.share.id, guestPrincipalId: RECIPIENT_GUEST.id };
      expect(() => fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST)).toThrow(
        "recipient_unapproved",
      );
      fix.auth.approveShareRecipient({ ...input, caps: ["containers:read"] }, fix.root);
      const ticket = fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST);
      if (fix.share.grantId === null) throw new Error("share has no ceiling");
      expectForbidden(() => fix.auth.revokeGrant(fix.share.grantId!, fix.root));
      expect(
        fix.auth.allows(fix.auth.authenticate(ticket.token), "containers:read", fix.container.id),
      ).toBe(true);
      fix.store.deleteGrant(fix.share.grantId);
      expectForbidden(() => fix.auth.authenticateShare(fix.minted.token));
      expectForbidden(() => fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST));
      expectForbidden(() =>
        fix.auth.approveShareRecipient({ ...input, caps: ["containers:read"] }, fix.root),
      );
      expect(fix.auth.resumableShareTicketPrincipals(fix.share.id)).toEqual([]);
    } finally {
      fix.store.close();
    }
  });

  test("suspended minting cannot escape recipient removal through an independent principal allow", async () => {
    const fix = recipientFixture(["tokens:mint", "containers:read"]);
    try {
      const input = { shareId: fix.share.id, guestPrincipalId: RECIPIENT_GUEST.id };
      expect(() => fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST)).toThrow(
        "recipient_unapproved",
      );
      fix.auth.approveShareRecipient(
        { ...input, caps: ["tokens:mint", "containers:read"] },
        fix.root,
      );
      const ticket = fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST);
      const captured = fix.auth.authenticate(ticket.token);
      fix.auth.grant(
        {
          principal: { kind: "principal", id: captured.principal.id },
          node: `manifold://container/${fix.container.id}`,
          caps: ["tokens:mint", "containers:read"],
          effect: "allow",
          reach: "subtree",
        },
        fix.root,
      );
      const unrelated = fix.auth.mintToken(
        {
          principalId: captured.principal.id,
          caps: ["tokens:mint", "containers:read"],
          containerId: fix.container.id,
        },
        fix.root,
      );
      const gate = Promise.withResolvers<void>();
      const resumed = gate.promise.then(() => {
        expectForbidden(() =>
          fix.auth.mintToken(
            { principal: { name: "escaped", kind: "human" }, caps: ["containers:read"] },
            captured,
          ),
        );
        expectForbidden(() =>
          fix.auth.mintShare(
            {
              node: { kind: "container", containerId: fix.container.id },
              caps: ["containers:read"],
              origin: "https://escaped.example",
            },
            captured,
          ),
        );
      });
      expect(fix.auth.allows(captured, "tokens:mint", fix.container.id)).toBe(true);
      fix.auth.removeShareRecipient(input, fix.root);
      gate.resolve();
      await resumed;
      expect(fix.auth.allows(captured, "tokens:mint", fix.container.id)).toBe(false);
      const independentActor = fix.auth.authenticate(unrelated.token);
      const child = fix.auth.mintToken(
        { principal: { name: "independent child", kind: "human" }, caps: ["containers:read"] },
        independentActor,
      );
      expect(
        fix.auth.allows(fix.auth.authenticate(child.token), "containers:read", fix.container.id),
      ).toBe(true);
    } finally {
      fix.store.close();
    }
  });
});

test("ticket-derived ordinary, terminal and child-share credentials retire with their source approval", () => {
  const caps = ["tokens:mint", "containers:read", "scenes:write"] satisfies Cap[];
  const fix = recipientFixture(caps);
  try {
    const input = { shareId: fix.share.id, guestPrincipalId: RECIPIENT_GUEST.id };
    expect(() => fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST)).toThrow(
      "recipient_unapproved",
    );
    fix.auth.approveShareRecipient({ ...input, caps }, fix.root);
    const ticket = fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST);
    const actor = fix.auth.authenticate(ticket.token);
    expectForbidden(() =>
      fix.auth.grant(
        {
          principal: { kind: "principal", id: actor.principal.id },
          node: "manifold://",
          caps: ["*"],
          effect: "allow",
          reach: "subtree",
        },
        actor,
      ),
    );
    const independentGrant = fix.auth.grant(
      {
        principal: { kind: "principal", id: actor.principal.id },
        node: `manifold://container/${fix.container.id}`,
        caps: ["containers:read"],
        effect: "allow",
        reach: "subtree",
      },
      fix.root,
    );
    expectForbidden(() => fix.auth.revokeGrant(independentGrant.id, actor));
    const child = fix.auth.mintToken(
      {
        principal: { name: "derived", kind: "human" },
        caps,
      },
      actor,
    );
    const childActor = fix.auth.authenticate(child.token);
    const grandchild = fix.auth.mintToken(
      {
        principal: { name: "derived again", kind: "human" },
        caps: ["scenes:write"],
      },
      childActor,
    );
    const unrelated = fix.auth.mintToken(
      {
        principalId: child.principal.id,
        caps: ["containers:read"],
        containerId: fix.container.id,
      },
      fix.root,
    );
    expect(() =>
      fix.auth.mintTerminalLifecycleToken("missing-source", fix.container.id, actor.principal.id),
    ).toThrow("share_recipient_source_required");
    expect(() =>
      fix.auth.mintTerminalLifecycleToken(
        "wrong-source",
        fix.container.id,
        actor.principal.id,
        childActor.tokenId,
      ),
    ).toThrow("share_recipient_source_refused");
    const terminal = fix.auth.mintTerminalLifecycleToken(
      "derived-terminal",
      fix.container.id,
      childActor.principal.id,
      childActor.tokenId,
    );
    expect(() =>
      fix.auth.mintTerminalLifecycleToken(
        "wrong-container",
        "elsewhere",
        childActor.principal.id,
        childActor.tokenId,
      ),
    ).toThrow("cannot widen container scope");
    expect(terminal.caps).toEqual(["containers:read", "scenes:write"]);
    const delegated = fix.auth.mintShare(
      {
        node: { kind: "container", containerId: fix.container.id },
        caps: ["containers:read", "scenes:write"],
        origin: "https://next-guest.example",
      },
      childActor,
    );
    const delegatedRecord = fix.auth.authenticateShare(delegated.token);
    if (delegatedRecord.grantId === null) throw new Error("delegated share has no ceiling grant");
    expectForbidden(() => fix.auth.revokeGrant(delegatedRecord.grantId!, childActor));
    const nextGuest = { ...RECIPIENT_GUEST, id: "next-local" };
    expect(() => fix.auth.mintShareTicket(delegatedRecord, nextGuest)).toThrow(
      "recipient_unapproved",
    );
    fix.auth.approveShareRecipient(
      {
        shareId: delegatedRecord.id,
        guestPrincipalId: nextGuest.id,
        caps: ["containers:read", "scenes:write"],
      },
      fix.root,
    );
    const delegatedTicket = fix.auth.mintShareTicket(delegatedRecord, nextGuest);
    const unrelatedShare = fix.auth.mintShare(
      {
        node: { kind: "container", containerId: fix.container.id },
        caps: ["containers:read"],
        origin: "https://unrelated-guest.example",
      },
      fix.root,
    );
    fix.auth.approveShareRecipient({ ...input, caps: ["containers:read"] }, fix.root);
    for (const issued of [ticket, child, grandchild, terminal, delegatedTicket]) {
      expect(() => fix.auth.authenticate(issued.token)).toThrow("revoked");
      expect(fix.store.getTokenByHash(sha256Hex(issued.token))?.grantId).toBeNull();
    }
    expect(() => fix.auth.authenticateShare(delegated.token)).toThrow("revoked");
    expect(fix.store.getShare(delegatedRecord.id)?.grantId).toBeNull();
    expect(fix.auth.authenticate(unrelated.token).principal.id).toBe(child.principal.id);
    expect(fix.auth.authenticateShare(unrelatedShare.token).revokedAt).toBeNull();
    expect(fix.store.getGrant(independentGrant.id)).toMatchObject({
      principal: { kind: "principal", id: actor.principal.id },
      caps: ["containers:read"],
    });
    expectForbidden(() =>
      fix.auth.mintToken(
        {
          principal: { name: "after withdrawal", kind: "human" },
          caps: ["containers:read"],
        },
        actor,
      ),
    );
    expect(() =>
      fix.auth.mintTerminalLifecycleToken(
        "retired-source",
        fix.container.id,
        actor.principal.id,
        actor.tokenId,
      ),
    ).toThrow("share_recipient_source_refused");
    expect(() => fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST, caps)).toThrow(
      "recipient_caps_refused",
    );
    fix.auth.approveShareRecipient({ ...input, caps }, fix.root);
    const fresh = fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST);
    const freshChild = fix.auth.mintToken(
      {
        principal: { name: "fresh derived", kind: "human" },
        caps: ["containers:read"],
      },
      fix.auth.authenticate(fresh.token),
    );
    fix.auth.removeShareRecipient(input, fix.root);
    expect(() => fix.auth.authenticate(freshChild.token)).toThrow("revoked");
    expect(fix.auth.authenticate(unrelated.token).principal.id).toBe(child.principal.id);
    expect(() => fix.auth.authenticateShare(delegated.token)).toThrow("revoked");
  } finally {
    fix.store.close();
  }
});

test("registered runner, renewed Run and child Run credentials retain exact recipient provenance", async () => {
  const fix = recipientFixture(["tokens:mint", "agents:delegate", "containers:read"]);
  try {
    const input = { shareId: fix.share.id, guestPrincipalId: RECIPIENT_GUEST.id };
    expect(() => fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST)).toThrow(
      "recipient_unapproved",
    );
    fix.auth.approveShareRecipient({ ...input, caps: [...fix.share.caps] }, fix.root);
    const ticket = fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST);
    const sponsor = fix.auth.authenticate(ticket.token);
    const registered = await fix.auth.registerAgent(
      {
        name: "guest-sponsored",
        purpose: "Exercise recipient-derived Run withdrawal",
        harness: "external",
        context: { profile: {} },
        grant: {
          caps: ["agents:delegate", "containers:read"],
          targets: [`manifold://container/${fix.container.id}`],
          reach: "subtree",
          maxRunLifetimeMs: 180_000,
          expiresAt: fix.runtime.now() + 600_000,
          delegation: { maxDepth: 3, maxDescendants: 9 },
        },
      },
      sponsor,
    );
    if (registered.credential === undefined) throw new Error("registration produced no runner");
    const runner = fix.auth.authenticate(registered.credential.token);
    const created = CreateRunCredentialResultSchema.parse(
      fix.auth.createRun(
        {
          agentId: registered.agent.agentId,
          lifetimeMs: 60_000,
          caps: ["agents:delegate", "containers:read"],
        },
        runner,
      ),
    );
    const runActor = fix.auth.authenticate(created.credential.token);
    const challenge = fix.auth.agentPolicyChallenge(runActor);
    fix.auth.acknowledgeAgentPolicy(
      {
        revision: challenge.revision,
        acknowledgements: challenge.required.map(({ id, digest }) => ({ id, digest })),
      },
      runActor,
    );
    const renewed = fix.auth.renewAgentRun(
      { runId: created.run.id, lifetimeMs: 120_000 },
      runActor,
    );
    const renewedActor = fix.auth.authenticate(renewed.credential.token);
    const child = CreateRunCredentialResultSchema.parse(
      fix.auth.createChildRun(
        {
          runId: created.run.id,
          lifetimeMs: 60_000,
          caps: ["containers:read"],
        },
        renewedActor,
      ),
    );
    fix.auth.removeShareRecipient(input, fix.root);
    for (const raw of [
      registered.credential.token,
      renewed.credential.token,
      child.credential.token,
    ]) {
      expect(() => fix.auth.authenticate(raw)).toThrow("revoked");
      expect(fix.store.getTokenByHash(sha256Hex(raw))?.grantId).toBeNull();
    }
    expect(fix.store.getAgentRun(created.run.id)?.state).toBe("revoked");
    expect(fix.store.getAgentRun(child.run.id)?.state).toBe("revoked");
    expect(fix.auth.restoreCredential(fix.auth.credentialReference(renewedActor))).toBeNull();
    expectForbidden(() => fix.auth.createRun({ agentId: registered.agent.agentId }, runner));
    expectForbidden(() =>
      fix.auth.renewAgentRun(
        {
          runId: created.run.id,
          lifetimeMs: 180_000,
        },
        renewedActor,
      ),
    );
  } finally {
    fix.store.close();
  }
});

test("recipient withdrawal wins an Agent profile admission race before any runner can be issued", async () => {
  const fix = recipientFixture(["agents:delegate", "containers:read"]);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const input = { shareId: fix.share.id, guestPrincipalId: RECIPIENT_GUEST.id };
    expect(() => fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST)).toThrow(
      "recipient_unapproved",
    );
    fix.auth.approveShareRecipient({ ...input, caps: [...fix.share.caps] }, fix.root);
    const ticket = fix.auth.mintShareTicket(fix.share, RECIPIENT_GUEST);
    const sponsor = fix.auth.authenticate(ticket.token);
    fix.auth.setAgentProfileValidator(async () => {
      entered.resolve();
      await release.promise;
    });
    const registering = fix.auth.registerAgent(
      {
        name: "racing-guest",
        purpose: "Exercise point-of-use recipient revocation",
        harness: "external",
        context: { profile: {} },
        grant: {
          caps: ["containers:read"],
          targets: [`manifold://container/${fix.container.id}`],
          reach: "subtree",
          maxRunLifetimeMs: 60_000,
          expiresAt: fix.runtime.now() + 60_000,
          delegation: { maxDepth: 0, maxDescendants: 0 },
        },
      },
      sponsor,
    );
    await entered.promise;
    fix.auth.removeShareRecipient(input, fix.root);
    release.resolve();
    await expect(registering).rejects.toThrow("agent_unavailable");
    expect(fix.store.listAgents()).toEqual([]);
  } finally {
    release.resolve();
    fix.store.close();
  }
});
