import { afterEach, describe, expect, test } from "bun:test";
import {
  formatManifoldUri,
  type OwnedReferenceDeclaration,
  type PluginOwnedRef,
  type ReferencePreparation,
  type ReferenceProbeRequest,
  type ReferenceTerminalReceipt,
} from "@manifold/protocol";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { openDatabase } from "../src/db.ts";
import { ReferenceService, ReferenceRefused, type ReferenceOwner } from "../src/reference-service.ts";
import { ServerStore } from "../src/stores.ts";

const declaration: OwnedReferenceDeclaration = {
  kind: "file",
  resolveAction: "resolve",
  readCapability: "vendor.vault:read",
  createCapability: "vendor.vault:create",
  deleteCapability: "vendor.vault:delete",
  creatorCaps: ["vendor.vault:read", "vendor.vault:delete", "vendor.vault:share"],
  sharing: {
    grantorCapability: "vendor.vault:share",
    prerequisites: ["vendor.vault:read", "vendor.vault:share"],
    grantableCaps: ["vendor.vault:read"],
  },
};
const stores: ServerStore[] = [];
const services: ReferenceService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const store of stores.splice(0)) store.close();
});

function fixture() {
  const store = new ServerStore(openDatabase(":memory:"));
  stores.push(store);
  let next = 0;
  const runtime = { time: 100, now() { return this.time; }, newId: () => `reference-${++next}` };
  const auth = new AuthService(store, "a".repeat(64), runtime);
  const root = auth.authenticate("a".repeat(64));
  store.claimReferenceKinds("vendor.vault", ["file"]);
  const ready = new Map<string, { preparationId: string; readyDigest: string | null; expiresAt: number }>();
  const reclaimed: ReferenceTerminalReceipt[] = [];
  const state = {
    enabled: true,
    reclaimFails: false,
    capacity: true,
    measuredCapacity: true,
    busy: false,
    probe: null as ((input: ReferenceProbeRequest) => Promise<void>) | null,
  };
  const owner: ReferenceOwner = {
    pluginId: "vendor.vault", declaration, generation: {}, generationDigest: "build-a",
    probe: async (input) => {
      const { preparationId } = input;
      await state.probe?.(input);
      return ready.get(preparationId) ?? null;
    },
    probeWhenIdle: async (input) => {
      if (state.busy) throw new Error("owner busy");
      return owner.probe(input);
    },
    reclaim: async (receipts) => {
      if (state.reclaimFails) throw new Error("private storage busy");
      for (const receipt of receipts) {
        reclaimed.push(receipt);
        ready.delete(receipt.preparationId);
      }
    },
  };
  const cleanupFailures: string[] = [];
  const makeService = () => new ReferenceService(store, auth, runtime,
    () => state.enabled ? owner : null,
    (additionalBytes) => {
      if (!state.capacity || (additionalBytes === 0 && !state.measuredCapacity))
        throw new ReferenceRefused("backup_capacity");
    },
    (pluginId) => cleanupFailures.push(pluginId));
  let service = makeService();
  services.push(service);
  service.restart();
  const replaceService = () => {
    service.close();
    service = makeService();
    services.push(service);
    service.restart();
  };
  const context = (actor: AuthContext = root) => service.context({
    pluginId: "vendor.vault", actor, traceId: 42,
    check: () => { if (!state.enabled) throw new ReferenceRefused(); },
    checkReceipt: () => { if (!state.enabled) throw new ReferenceRefused(); },
    checkReadable: () => { if (!state.enabled) throw new ReferenceRefused(); },
  });
  const grantCreate = (actor = root) => auth.grant({
    principal: { kind: "principal", id: actor.principal.id },
    node: "manifold://plugin/vendor.vault", caps: [declaration.createCapability],
    effect: "allow", reach: "node",
  }, root);
  const prepare = async (actor = root): Promise<ReferencePreparation> => {
    const preparation = await context(actor).prepare({
      kind: "file", requestId: runtime.newId(), bindingDigest: "1".repeat(64),
    });
    ready.set(preparation.preparationId, { preparationId: preparation.preparationId, readyDigest: "2".repeat(64), expiresAt: preparation.expiresAt });
    return preparation;
  };
  const publish = async (actor = root) => {
    const preparation = await prepare(actor);
    await context(actor).publish({ preparationId: preparation.preparationId, readyDigest: "2".repeat(64) });
    return preparation;
  };
  const principal = () => {
    const token = auth.mintToken({ principal: { kind: "human", name: "reader" }, caps: ["containers:read"] }, root);
    return auth.authenticate(token.token);
  };
  const stateOf = (ref: PluginOwnedRef) => store.db.query<{ state: string }, [string]>(
    "SELECT state FROM reference_publications WHERE node=?",
  ).get(formatManifoldUri(ref))?.state;
  return { store, runtime, auth, root, ready, reclaimed, state, owner, service, cleanupFailures,
    context, grantCreate, prepare, publish, principal, stateOf, replaceService };
}
test("preparation admission is per-principal and workspace bounded, and absolute expiry only aborts", async () => {
  const f = fixture();
  f.grantCreate();
  const first = await f.prepare();
  await f.prepare();
  await expect(f.prepare()).rejects.toThrow("reference_capacity");
  const other = f.principal();
  f.grantCreate(other);
  await f.prepare(other);
  await f.prepare(other);
  const third = f.principal();
  f.grantCreate(third);
  await expect(f.prepare(third)).rejects.toThrow("reference_capacity");
  f.runtime.time = first.expiresAt;
  await expect(f.context().publish({ preparationId: first.preparationId, readyDigest: "2".repeat(64) }))
    .rejects.toThrow("reference_unavailable");
  await f.service.reconcile();
  expect(f.store.db.query("SELECT DISTINCT state FROM reference_publications").all()).toEqual([{ state: "aborted" }]);
  expect(f.ready.size).toBe(0);
  const later = await f.prepare(third);
  expect(f.stateOf(later.ref)).toBe("prepared");
});

test("owner idle expiry frees preparations before admitting a replacement credential", async () => {
  const f = fixture();
  const creator = f.principal();
  f.grantCreate(creator);
  const first = await f.prepare(creator);
  const second = await f.prepare(creator);
  for (const preparation of [first, second]) {
    f.ready.set(preparation.preparationId, {
      preparationId: preparation.preparationId, readyDigest: null, expiresAt: 160,
    });
  }
  f.runtime.time = 160;
  const replacement = f.auth.authenticate(f.auth.mintToken({
    principalId: creator.principal.id, caps: ["containers:read"],
  }, f.root).token);
  const next = await f.prepare(replacement);
  expect(f.stateOf(next.ref)).toBe("prepared");
  for (const preparation of [first, second]) {
    expect(f.stateOf(preparation.ref)).toBe("aborted");
    expect(f.auth.allowsRef(f.root, declaration.readCapability, preparation.ref)).toBe(false);
  }
  expect(f.reclaimed.map((receipt) => receipt.ref)).toEqual([first.ref, second.ref]);
});

test("a deadline that passes during its probe cannot retire a possibly refreshed preparation", async () => {
  const f = fixture();
  f.grantCreate();
  const first = await f.prepare();
  f.ready.set(first.preparationId, {
    preparationId: first.preparationId, readyDigest: null, expiresAt: 160,
  });
  f.runtime.time = 155;
  f.state.probe = async () => { f.runtime.time = 165; };
  const second = await f.prepare();
  expect(f.stateOf(first.ref)).toBe("prepared");
  expect(f.stateOf(second.ref)).toBe("prepared");
  expect(f.reclaimed).toEqual([]);
});

test("an owner publication deadline fences a suspended probe but not a committed receipt", async () => {
  const f = fixture();
  f.grantCreate();
  const preparation = await f.prepare();
  f.state.probe = async () => { f.runtime.time = 200; };
  await expect(f.context().publish({
    preparationId: preparation.preparationId, readyDigest: "2".repeat(64), expiresAt: 200,
  })).rejects.toThrow("reference_unavailable");
  expect(f.stateOf(preparation.ref)).toBe("prepared");
  expect(f.auth.allowsRef(f.root, declaration.readCapability, preparation.ref)).toBe(false);
  f.state.probe = null;
  const published = await f.context().publish({
    preparationId: preparation.preparationId, readyDigest: "2".repeat(64), expiresAt: 201,
  });
  expect(published).toEqual({
    ref: preparation.ref, preparationId: preparation.preparationId, readyDigest: "2".repeat(64),
  });
  f.runtime.time = 202;
  expect(await f.context().publish({
    preparationId: preparation.preparationId, readyDigest: "2".repeat(64), expiresAt: 201,
  })).toEqual(published);
  expect(await f.service.requirePublished(f.root, preparation.ref)).toEqual(published);
  const creatorGrant = f.store.db.query<{ id: string }, [string]>(
    "SELECT id FROM grants WHERE node=?",
  ).get(formatManifoldUri(preparation.ref))!;
  f.auth.revokeGrant(creatorGrant.id, f.root);
  await expect(f.context().publish({
    preparationId: preparation.preparationId, readyDigest: "2".repeat(64), expiresAt: 201,
  })).rejects.toThrow("reference_unavailable");
});


describe("owned-reference publication and ordinary grants", () => {
  test("wildcard is not create authority; only exact committed readiness publishes privately", async () => {
    const f = fixture();
    await expect(f.prepare()).rejects.toThrow("reference_unavailable");
    f.grantCreate();
    const preparation = await f.prepare();
    await expect(f.service.requirePublished(f.root, preparation.ref)).rejects.toThrow("reference_unavailable");
    expect(f.auth.allowsRef(f.root, declaration.readCapability, preparation.ref)).toBe(false);
    f.ready.set(preparation.preparationId, { preparationId: "another-preparation", readyDigest: "2".repeat(64), expiresAt: preparation.expiresAt });
    await expect(f.context().publish({ preparationId: preparation.preparationId, readyDigest: "2".repeat(64) })).rejects.toThrow("reference_unavailable");
    expect(f.stateOf(preparation.ref)).toBe("prepared");
    f.ready.set(preparation.preparationId, { preparationId: preparation.preparationId, readyDigest: "2".repeat(64), expiresAt: preparation.expiresAt });
    await f.context().publish({ preparationId: preparation.preparationId, readyDigest: "2".repeat(64) });
    expect(f.auth.allowsRef(f.root, declaration.readCapability, preparation.ref)).toBe(true);
    await expect(f.service.requirePublished(f.principal(), preparation.ref)).rejects.toThrow("reference_unavailable");
    expect(f.store.db.query("SELECT role,principal_id FROM reference_grant_provenance").all()).toEqual([
      { role: "creator", principal_id: f.root.principal.id },
    ]);
  });

  test("publication, creator grant, provenance and audit roll back together", async () => {
    const f = fixture();
    f.grantCreate();
    const preparation = await f.prepare();
    f.store.db.exec(`CREATE TEMP TRIGGER reject_reference_audit BEFORE INSERT ON events
      WHEN NEW.type='grant_created' BEGIN SELECT RAISE(ABORT,'audit refused'); END`);
    await expect(f.context().publish({ preparationId: preparation.preparationId, readyDigest: "2".repeat(64) })).rejects.toThrow("audit refused");
    expect(f.stateOf(preparation.ref)).toBe("prepared");
    expect(f.store.db.query("SELECT grant_id FROM reference_grant_provenance").all()).toEqual([]);
    expect(f.auth.allowsRef(f.root, declaration.readCapability, preparation.ref)).toBe(false);
    f.store.db.exec("DROP TRIGGER reject_reference_audit");
    await f.context().publish({ preparationId: preparation.preparationId, readyDigest: "2".repeat(64) });
    expect(f.stateOf(preparation.ref)).toBe("published");
  });

  test("same-principal new credentials cannot complete another credential's preparation", async () => {
    const f = fixture();
    const creator = f.principal();
    f.grantCreate(creator);
    const preparation = await f.prepare(creator);
    const replacement = f.auth.authenticate(f.auth.mintToken({ principalId: creator.principal.id,
      caps: ["containers:read"] }, f.root).token);
    expect(f.auth.credentialBinding(replacement)).not.toBe(f.auth.credentialBinding(creator));
    await expect(f.context(replacement).publish({ preparationId: preparation.preparationId, readyDigest: "2".repeat(64) })).rejects.toThrow("reference_unavailable");
    await expect(f.context(replacement).abort({ preparationId: preparation.preparationId })).rejects.toThrow("reference_unavailable");
    await f.context(creator).publish({ preparationId: preparation.preparationId, readyDigest: "2".repeat(64) });
    expect(f.stateOf(preparation.ref)).toBe("published");
  });

  test("revocation or credential expiry while the private probe awaits prevents publication", async () => {
    for (const change of ["revoke", "expire"] as const) {
      const f = fixture();
      const actor = { ...f.principal(), expiresAt: f.runtime.now() + 10 };
      const create = f.grantCreate(actor);
      const preparation = await f.prepare(actor);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      f.state.probe = async () => { entered.resolve(); await release.promise; };
      const pending = f.context(actor).publish({ preparationId: preparation.preparationId, readyDigest: "2".repeat(64) });
      await entered.promise;
      if (change === "revoke") f.auth.revokeGrant(create.id, f.root);
      else f.runtime.time += 10;
      release.resolve();
      await expect(pending).rejects.toThrow("reference_unavailable");
      expect(f.stateOf(preparation.ref)).toBe("prepared");
      expect(f.store.db.query("SELECT grant_id FROM reference_grant_provenance").all()).toEqual([]);
    }
  });

  test("scope is carried in credential binding and cannot adopt an independent root child", async () => {
    const f = fixture();
    const actor = f.principal();
    f.grantCreate(actor);
    f.store.createContainer({ id: "home", name: "home", discipline: "canvas", createdAt: f.runtime.now() });
    const confined = f.auth.authenticate(f.auth.mintToken({ principalId: actor.principal.id,
      caps: ["containers:read"], containerId: "home" }, f.root).token);
    expect(f.auth.credentialBinding(confined)).not.toBe(f.auth.credentialBinding(actor));
    await expect(f.prepare(confined)).rejects.toThrow("reference_unavailable");
    expect(f.auth.containsReferenceTarget(confined, { kind: "file", fileId: "unborn" })).toBe(false);
    const carried = { ...actor, caps: [], containerGrants: [] };
    expect(f.auth.credentialBinding(carried)).not.toBe(f.auth.credentialBinding(actor));
  });

  test("named shares retry once; revocation cannot touch creator, administrator or another reference rows", async () => {
    const f = fixture();
    f.grantCreate();
    const a = await f.publish();
    const b = await f.publish();
    const recipient = f.principal();
    const args = { ref: a.ref, principalId: recipient.principal.id,
      caps: [declaration.readCapability], previousGrantId: null };
    const share = await f.context().grant(args);
    expect(await f.context().grant(args)).toEqual(share);
    const foreign = await f.context().grant({ ...args, ref: b.ref });
    const admin = f.auth.grant({ principal: { kind: "principal", id: recipient.principal.id },
      node: formatManifoldUri(a.ref), caps: [declaration.readCapability], effect: "allow", reach: "node" }, f.root);
    const creator = f.store.db.query<{ grant_id: string }, [string]>(
      "SELECT grant_id FROM reference_grant_provenance WHERE role='creator' AND publication_id=(SELECT publication_id FROM reference_publications WHERE node=?)",
    ).get(formatManifoldUri(a.ref))!;
    for (const grantId of [foreign.grantId, admin.id, creator.grant_id, "unrelated-or-missing"]) {
      await expect(f.context().revoke({ ref: a.ref, grantId })).rejects.toThrow("reference_conflict");
    }
    expect(await f.context().audience({ ref: a.ref })).toEqual({ shares: [share], next: null });
    expect(await f.context().revoke({ ref: a.ref, grantId: share.grantId })).toEqual({ changed: true,
      principalReadAllowed: true, credentialAccess: "not_evaluated" });
    expect(f.store.getGrant(admin.id)?.id).toBe(admin.id);
    expect(f.store.getGrant(creator.grant_id)?.id).toBe(creator.grant_id);
    expect(f.store.getGrant(foreign.grantId)?.id).toBe(foreign.grantId);
    await f.service.requirePublished(recipient, a.ref);
    f.auth.revokeGrant(admin.id, f.root);
    await expect(f.service.requirePublished(recipient, a.ref)).rejects.toThrow("reference_unavailable");
    await f.service.requirePublished(recipient, b.ref);
  });

  test("post-await share revocation denies read without revealing readiness and delete wins a pending share", async () => {
    const f = fixture();
    f.grantCreate();
    const published = await f.publish();
    const recipient = f.principal();
    const share = await f.context().grant({ ref: published.ref, principalId: recipient.principal.id,
      caps: [declaration.readCapability], previousGrantId: null });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.state.probe = async () => { entered.resolve(); await release.promise; };
    const read = f.service.requirePublished(recipient, published.ref);
    await entered.promise;
    f.auth.revokeGrant(share.grantId, f.root);
    release.resolve();
    await expect(read).rejects.toThrow("reference_unavailable");
    expect(f.stateOf(published.ref)).toBe("published");
    const enteredAgain = Promise.withResolvers<void>();
    const releaseAgain = Promise.withResolvers<void>();
    f.state.probe = async () => { enteredAgain.resolve(); await releaseAgain.promise; };
    const pendingShare = f.context().grant({ ref: published.ref, principalId: recipient.principal.id,
      caps: [declaration.readCapability], previousGrantId: share.grantId });
    await enteredAgain.promise;
    f.service.purge("vendor.vault", f.root.principal.id, 99);
    releaseAgain.resolve();
    await expect(pendingShare).rejects.toThrow("reference_unavailable");
    expect(f.stateOf(published.ref)).toBe("deleted");
  });

  test("restart aborts orphan readiness and never heals a revoked creator after a lost publication ACK", async () => {
    const f = fixture();
    f.grantCreate();
    const published = await f.publish();
    const orphan = await f.prepare();
    const creator = f.store.db.query<{ grant_id: string }, []>("SELECT grant_id FROM reference_grant_provenance WHERE role='creator'").get()!;
    f.auth.revokeGrant(creator.grant_id, f.root);
    f.service.restart();
    await f.service.reconcile();
    expect(f.stateOf(orphan.ref)).toBe("aborted");
    expect(f.ready.has(orphan.preparationId)).toBe(false);
    expect(f.ready.has(published.preparationId)).toBe(true);
    expect(f.stateOf(published.ref)).toBe("published");
    expect(f.store.getGrant(creator.grant_id)).toBeNull();
    await expect(f.context().publish({ preparationId: published.preparationId, readyDigest: "2".repeat(64) })).rejects.toThrow("reference_unavailable");
    const later = await f.prepare();
    expect(later.ref).not.toEqual(orphan.ref);
    expect(later.ref).not.toEqual(published.ref);
  });

  test("missing and mismatched published identities quarantine, never enter provisional reclamation", async () => {
    for (const missing of [true, false]) {
      const f = fixture();
      f.grantCreate();
      const published = await f.publish();
      if (missing) f.ready.delete(published.preparationId);
      else f.ready.set(published.preparationId, { preparationId: published.preparationId, readyDigest: "3".repeat(64), expiresAt: published.expiresAt });
      await expect(f.service.requirePublished(f.root, published.ref)).rejects.toThrow("reference_unavailable");
      expect(f.stateOf(published.ref)).toBe("quarantined");
      await f.service.reconcile();
      expect(f.reclaimed).toEqual([]);
      expect(f.store.db.query("SELECT role FROM reference_grant_provenance").all()).toEqual([{ role: "creator" }]);
    }
  });

  test("delete stays committed when cleanup fails; unrelated grants cannot resurrect retained bytes", async () => {
    const f = fixture();
    f.grantCreate();
    const published = await f.publish();
    const recipient = f.principal();
    const admin = f.auth.grant({ principal: { kind: "principal", id: recipient.principal.id },
      node: formatManifoldUri(published.ref), caps: [declaration.readCapability], effect: "allow", reach: "node" }, f.root);
    f.state.reclaimFails = true;
    expect(await f.context().unpublish({ ref: published.ref })).toEqual({ ref: published.ref,
      preparationId: published.preparationId, state: "deleted" });
    expect(f.ready.has(published.preparationId)).toBe(true);
    expect(f.cleanupFailures).toEqual(["vendor.vault"]);
    expect(f.store.getGrant(admin.id)?.id).toBe(admin.id);
    await expect(f.service.requirePublished(recipient, published.ref)).rejects.toThrow("reference_unavailable");
    f.state.reclaimFails = false;
    f.service.restart();
    await f.service.reconcile();
    expect(f.ready.has(published.preparationId)).toBe(false);
    expect(f.store.referenceKindOwners().get("file")).toBe("vendor.vault");
    expect(() => f.store.claimReferenceKinds("vendor.squatter", ["file"])).toThrow("reference_kind_conflict");
  });

  test("aggregate admission failure refuses new rows but never prevents revocation or deletion", async () => {
    const f = fixture();
    f.grantCreate();
    const published = await f.publish();
    const recipient = f.principal();
    const share = await f.context().grant({ ref: published.ref, principalId: recipient.principal.id,
      caps: [declaration.readCapability], previousGrantId: null });
    f.state.capacity = false;
    await expect(f.prepare()).rejects.toThrow("backup_capacity");
    const other = f.principal();
    await expect(f.context().grant({ ref: published.ref, principalId: other.principal.id,
      caps: [declaration.readCapability], previousGrantId: null })).rejects.toThrow("backup_capacity");
    expect((await f.context().revoke({ ref: published.ref, grantId: share.grantId })).changed).toBe(true);
    expect((await f.context().unpublish({ ref: published.ref })).state).toBe("deleted");
  });

  test("measured post-write capacity refusal rolls back visibility, rows and postcommit fences", async () => {
    const f = fixture();
    f.grantCreate();
    const prepared = await f.prepare();
    f.state.measuredCapacity = false;
    let changes = 0;
    f.auth.onAuthorityChanged(() => { changes += 1; });
    await expect(f.context().publish({ preparationId: prepared.preparationId, readyDigest: "2".repeat(64) }))
      .rejects.toThrow("backup_capacity");
    expect(f.stateOf(prepared.ref)).toBe("prepared");
    expect(changes).toBe(0);
    expect(f.store.db.query("SELECT grant_id FROM reference_grant_provenance").all()).toEqual([]);
    f.state.measuredCapacity = true;
    await f.context().publish({ preparationId: prepared.preparationId, readyDigest: "2".repeat(64) });
    const recipient = f.principal();
    const before = changes;
    f.state.measuredCapacity = false;
    await expect(f.context().grant({ ref: prepared.ref, principalId: recipient.principal.id,
      caps: [declaration.readCapability], previousGrantId: null })).rejects.toThrow("backup_capacity");
    expect(changes).toBe(before);
    expect(f.auth.allowsRef(recipient, declaration.readCapability, prepared.ref)).toBe(false);
    expect((await f.context().audience({ ref: prepared.ref })).shares).toEqual([]);
  });

  test("grant authority fences and audit attribution wait for the outer commit and vanish on rollback", async () => {
    const f = fixture();
    f.grantCreate();
    const published = await f.publish();
    const row = f.store.db.query<{ publication_id: string; policy_digest: string; node: string }, [string]>(
      "SELECT publication_id,policy_digest,node FROM reference_publications WHERE node=?",
    ).get(formatManifoldUri(published.ref))!;
    const recipient = f.principal();
    let changes = 0;
    f.auth.onAuthorityChanged(() => { changes += 1; });
    const insert = () => f.auth.createReferenceGrant({ publicationId: row.publication_id,
      policyDigest: row.policy_digest, role: "share", principalId: recipient.principal.id,
      node: row.node, caps: [declaration.readCapability], previousGrantId: null }, f.root, 73);
    expect(() => f.store.transaction(() => { insert(); expect(changes).toBe(0); throw new Error("rollback"); })).toThrow("rollback");
    expect(changes).toBe(0);
    expect(f.auth.allowsRef(recipient, declaration.readCapability, published.ref)).toBe(false);
    f.store.transaction(() => { insert(); expect(changes).toBe(0); });
    expect(changes).toBe(1);
    expect(f.auth.allowsRef(recipient, declaration.readCapability, published.ref)).toBe(true);
    const event = f.store.db.query<{ payload: string }, []>(
      "SELECT payload FROM events WHERE type='grant_created' ORDER BY id DESC LIMIT 1",
    ).get()!;
    expect(JSON.parse(event.payload).parentTrace).toBe(73);
  });
});

test("a retired share is not a current audience grant and a lost ACK cannot restore it", async () => {
  const f = fixture();
  f.grantCreate();
  const publication = await f.publish();
  const recipient = f.principal();
  const request = {
    ref: publication.ref, principalId: recipient.principal.id,
    caps: [declaration.readCapability],
    previousGrantId: null,
  };
  const share = await f.context().grant(request);
  f.auth.revokeGrant(share.grantId, f.root);
  expect(f.auth.allowsRef(recipient, declaration.readCapability, publication.ref)).toBe(false);
  expect(await f.context().audience({ ref: publication.ref }))
    .toEqual({ shares: [{ ...share, active: false }], next: null });
  await expect(f.context().grant(request)).rejects.toThrow("reference_conflict");
  expect(f.auth.allowsRef(recipient, declaration.readCapability, publication.ref)).toBe(false);
});

test("deliberate re-sharing replaces only the reviewed retired decision and fences older retries", async () => {
  const f = fixture();
  f.grantCreate();
  const publication = await f.publish();
  const recipient = f.principal();
  f.store.db.exec("PRAGMA foreign_keys=ON");
  const initial = {
    ref: publication.ref, principalId: recipient.principal.id,
    caps: [declaration.readCapability], previousGrantId: null,
  };
  const first = await f.context().grant(initial);
  await f.context().revoke({ ref: publication.ref, grantId: first.grantId });
  expect(f.auth.allowsRef(recipient, declaration.readCapability, publication.ref)).toBe(false);
  const replacement = { ...initial, previousGrantId: first.grantId };
  const [second, replay] = await Promise.all([
    f.context().grant(replacement), f.context().grant(replacement),
  ]);
  expect(replay).toEqual(second);
  expect(second.grantId).not.toBe(first.grantId);
  expect(f.auth.allowsRef(recipient, declaration.readCapability, publication.ref)).toBe(true);
  expect(await f.context().revoke({ ref: publication.ref, grantId: first.grantId }))
    .toEqual({ changed: false, principalReadAllowed: true, credentialAccess: "not_evaluated" });
  await expect(f.context().grant(initial)).rejects.toThrow("reference_conflict");
  expect(await f.context().audience({ ref: publication.ref }))
    .toEqual({ shares: [second], next: null });
  f.auth.revokeGrant(second.grantId, f.root);
  await expect(f.context().grant(replacement)).rejects.toThrow("reference_conflict");
  const third = await f.context().grant({ ...initial, previousGrantId: second.grantId });
  await expect(f.context().grant(initial)).rejects.toThrow("reference_conflict");
  await expect(f.context().grant(replacement)).rejects.toThrow("reference_conflict");
  expect(await f.context().audience({ ref: publication.ref }))
    .toEqual({ shares: [third], next: null });
  expect(f.store.getGrant(first.grantId)).toBeNull();
  expect(f.store.getGrant(second.grantId)).toBeNull();
  expect(f.auth.allowsRef(recipient, declaration.readCapability, publication.ref)).toBe(true);
  await expect(f.context().revoke({ ref: publication.ref, grantId: first.grantId }))
    .rejects.toThrow("reference_conflict");
  expect(f.store.getGrant(third.grantId)?.id).toBe(third.grantId);
});

test("publication awaits its private acknowledgement but revoked read never recreates creator rights", async () => {
  const f = fixture();
  f.grantCreate();
  const preparation = await f.prepare();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.state.probe = async (input) => {
    if (input.publication !== "published") return;
    entered.resolve();
    await release.promise;
  };
  const publishing = f.context().publish({ preparationId: preparation.preparationId, readyDigest: "2".repeat(64) });
  await entered.promise;
  expect(f.stateOf(preparation.ref)).toBe("published");
  const creator = f.store.db.query<{ grant_id: string }, []>(
    "SELECT grant_id FROM reference_grant_provenance WHERE role='creator'",
  ).get()!;
  f.auth.revokeGrant(creator.grant_id, f.root);
  release.resolve();
  await expect(publishing).rejects.toThrow("reference_unavailable");
  expect(f.stateOf(preparation.ref)).toBe("published");
  expect(f.store.db.query("SELECT cleanup_pending FROM reference_publications").all())
    .toEqual([{ cleanup_pending: 0 }]);
  expect(f.store.getGrant(creator.grant_id)).toBeNull();
});

// These integration regressions exercise self-arming host timers across service replacement;
// the fixture's logical clock advances reference authority, not setTimeout maintenance wakeups.
test("a lost owner acknowledgement stays durable and recovers live without its original reader", async () => {
  const f = fixture();
  f.grantCreate();
  f.state.probe = async (input) => {
    if (input.publication === "published") throw new Error("guest exited after commit");
  };
  const publication = await f.publish();
  expect(f.stateOf(publication.ref)).toBe("published");
  expect(f.store.db.query("SELECT cleanup_pending FROM reference_publications").all())
    .toEqual([{ cleanup_pending: 1 }]);
  const creator = f.store.db.query<{ grant_id: string }, []>(
    "SELECT grant_id FROM reference_grant_provenance WHERE role='creator'",
  ).get()!;
  f.auth.revokeGrant(creator.grant_id, f.root);
  f.replaceService();
  f.state.probe = null;
  const deadline = Date.now() + 3_000;
  while (f.store.db.query<{ cleanup_pending: number }, []>(
    "SELECT cleanup_pending FROM reference_publications",
  ).get()!.cleanup_pending !== 0) {
    if (Date.now() > deadline) throw new Error("publication acknowledgement remained pending");
    await Bun.sleep(10);
  }
  expect(f.stateOf(publication.ref)).toBe("published");
  expect(f.ready.has(publication.preparationId)).toBe(true);
  expect(f.store.getGrant(creator.grant_id)).toBeNull();
  await expect(f.context().publish({ preparationId: publication.preparationId, readyDigest: "2".repeat(64) }))
    .rejects.toThrow("reference_unavailable");
});

test("busy owner recovery retains truthful pending state and retries without replaying publication", async () => {
  const f = fixture();
  f.grantCreate();
  f.state.probe = async (input) => {
    if (input.publication === "published") throw new Error("acknowledgement lost");
  };
  const publication = await f.publish();
  f.state.probe = null;
  f.state.busy = true;
  const failures = f.cleanupFailures.length;
  const deadline = Date.now() + 3_000;
  while (f.cleanupFailures.length === failures) {
    if (Date.now() > deadline) throw new Error("busy owner did not produce a bounded pending outcome");
    await Bun.sleep(10);
  }
  expect(f.stateOf(publication.ref)).toBe("published");
  expect(f.store.db.query("SELECT cleanup_pending FROM reference_publications").all())
    .toEqual([{ cleanup_pending: 1 }]);
  f.state.busy = false;
  const recovered = Date.now() + 3_000;
  while (f.store.db.query<{ cleanup_pending: number }, []>(
    "SELECT cleanup_pending FROM reference_publications",
  ).get()!.cleanup_pending !== 0) {
    if (Date.now() > recovered) throw new Error("idle owner did not recover");
    await Bun.sleep(10);
  }
  expect(f.store.db.query("SELECT role FROM reference_grant_provenance").all()).toEqual([{ role: "creator" }]);
  expect(f.stateOf(publication.ref)).toBe("published");
});

test("an old revoke suspended across deliberate re-sharing reports the replacement without revoking it", async () => {
  const f = fixture();
  f.grantCreate();
  const publication = await f.publish();
  const recipient = f.principal();
  const request = {
    ref: publication.ref, principalId: recipient.principal.id,
    caps: [declaration.readCapability], previousGrantId: null,
  };
  const first = await f.context().grant(request);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.state.probe = async () => { entered.resolve(); await release.promise; };
  const revoking = f.context().revoke({ ref: publication.ref, grantId: first.grantId });
  await entered.promise;
  f.state.probe = null;
  f.auth.revokeGrant(first.grantId, f.root);
  const second = await f.context().grant({ ...request, previousGrantId: first.grantId });
  release.resolve();
  expect(await revoking).toEqual({
    changed: false, principalReadAllowed: true, credentialAccess: "not_evaluated",
  });
  expect(f.store.getGrant(second.grantId)?.id).toBe(second.grantId);
  expect(f.auth.allowsRef(recipient, declaration.readCapability, publication.ref)).toBe(true);
  await expect(f.context().grant(request)).rejects.toThrow("reference_conflict");
});

test("pending acknowledgement batches advance past persistent failures instead of starving later files", async () => {
  const f = fixture();
  f.grantCreate();
  f.state.probe = async (input) => {
    if (input.publication === "published") throw new Error("owner acknowledgement unavailable");
  };
  const publications = [];
  for (let index = 0; index < 6; index += 1) publications.push(await f.publish());
  const stuck = new Set(f.store.db.query<{ preparation_id: string }, []>(
    "SELECT preparation_id FROM reference_publications ORDER BY publication_id LIMIT 4",
  ).all().map((row) => row.preparation_id));
  f.state.probe = async (input) => {
    if (stuck.has(input.preparationId)) throw new Error("persistent private refusal");
  };
  // Real host wakeups prove the durable cursor rotates rather than replaying the first batch.
  const deadline = Date.now() + 4_000;
  while (f.store.db.query<{ pending: number }, []>(
    "SELECT sum(cleanup_pending) AS pending FROM reference_publications",
  ).get()!.pending !== 4) {
    if (Date.now() > deadline) throw new Error("later publication acknowledgements were starved");
    await Bun.sleep(10);
  }
  for (const publication of publications) {
    expect(f.stateOf(publication.ref)).toBe("published");
    expect(f.auth.allowsRef(f.root, declaration.readCapability, publication.ref)).toBe(true);
  }
  expect(f.store.db.query<{ count: number }, []>(
    "SELECT count(*) AS count FROM reference_grant_provenance WHERE role='creator'",
  ).get()!.count).toBe(6);
});

test.each(["create grant", "dispatch", "owner availability"] as const)(
  "a committed publication does not return through a stale %s after owner acknowledgement",
  async (withdrawal) => {
    const f = fixture();
    const creation = f.grantCreate();
    const preparation = await f.prepare();
    let active = true;
    const ctx = f.service.context({
      pluginId: "vendor.vault", actor: f.root, traceId: 42,
      check: () => { if (!active) throw new ReferenceRefused(); },
      checkReceipt: () => { throw new ReferenceRefused(); },
      checkReadable: () => { throw new ReferenceRefused(); },
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.state.probe = async (input) => {
      if (input.publication !== "published") return;
      entered.resolve();
      await release.promise;
    };
    const pending = ctx.publish({ preparationId: preparation.preparationId, readyDigest: "2".repeat(64) });
    await entered.promise;
    if (withdrawal === "create grant") f.auth.revokeGrant(creation.id, f.root);
    else if (withdrawal === "dispatch") active = false;
    else f.state.enabled = false;
    release.resolve();
    await expect(pending).rejects.toThrow("reference_unavailable");
    expect(f.stateOf(preparation.ref)).toBe("published");
    expect(f.store.db.query("SELECT role FROM reference_grant_provenance").all()).toEqual([{ role: "creator" }]);
  },
);
