import { describe, expect, test } from "bun:test";
import { formatManifoldUri, type ServicePolicy } from "@manifold/protocol";
import { AuthService, type AuthorityRequirement } from "../src/auth.ts";
import { InstanceServiceStore, type ConfigureInstanceServiceArgs } from "../src/instance-service-store.ts";
import { FakeRuntime, testStore } from "./helpers.ts";

function fixture() {
  const store = testStore();
  const runtime = new FakeRuntime();
  const auth = new AuthService(store, "owner-key", runtime);
  const root = auth.authenticate("owner-key");
  const local = auth.enrollLocalMachine("not-master").machine;
  const other = auth.enrollLocalMachine("master").machine;
  store.setMeta("native_local_machine_id", local.id);
  const registry = new InstanceServiceStore(store, auth, runtime);
  const policy: ServicePolicy = {
    serviceId: "sample.broker", revision: "policy-1", maxConcurrent: 1,
    runtime: {
      scope: "instance", pluginId: "sample", operationId: "sample.serve",
      installationRevision: "install-1", artifactSha256: "a".repeat(64),
      resourceBindingDigest: "b".repeat(64), input: { value: { literal: "serve" } },
    },
    operations: {
      inspect: {
        kind: "http-proxy", method: "GET", path: "/", request: { kind: "none" },
        response: { kind: "stream", disclosure: "full", contentTypes: ["application/json"], headers: [] },
        timeoutMs: 1000, maxRequestBytes: 1024, maxResponseBytes: 4096,
      },
    },
  };
  const requirements = (machineId = local.id): AuthorityRequirement[] => [
    { cap: "operations:invoke", ref: { kind: "operation", machineId, operationId: "sample.serve" } },
    { cap: "locations:read", ref: { kind: "location", machineId, locationId: "sample.state" } },
    { cap: "locations:write", ref: { kind: "location", machineId, locationId: "sample.state" } },
    { cap: "services:invoke", ref: { kind: "service", machineId, serviceId: "sample.upstream", operationId: "send" } },
  ];
  const args: ConfigureInstanceServiceArgs = { serviceId: policy.serviceId, expectedRevision: null, policy, enabled: true };
  const configure = (input = args, actor = root) => registry.configure(
    actor, input, "engine.services", "trace", requirements(input.machineId ?? registry.get(input.serviceId)?.machineId ?? local.id),
  );
  const counts = () => store.db.query<{ tokens: number; grants: number; principals: number; events: number }, []>(
    "SELECT (SELECT COUNT(*) FROM tokens) AS tokens, (SELECT COUNT(*) FROM grants) AS grants, (SELECT COUNT(*) FROM principals) AS principals, (SELECT COUNT(*) FROM events) AS events",
  ).get();
  return { store, runtime, auth, root, local, other, registry, policy, args, requirements, configure, counts };
}

describe("InstanceServiceStore", () => {
  test("default placement uses authenticated native identity, never machine display names", () => {
    const f = fixture();
    try {
      expect(f.registry.defaultOwnerId()).toBe(f.local.id);
      const first = f.configure().current;
      expect(first.machineId).toBe(f.local.id);
      const moved = f.configure({ ...f.args, expectedRevision: first.revision, machineId: f.other.id }).current;
      f.store.setMeta("native_local_machine_id", f.local.id);
      const retained = f.configure({ ...f.args, expectedRevision: moved.revision, policy: { ...f.policy, revision: "policy-2" } }).current;
      expect(retained.machineId).toBe(f.other.id);
      f.auth.revokeMachine(f.local.id, f.root);
      expect(f.registry.defaultOwnerId()).toBeNull();
      f.store.setMeta("native_local_machine_id", "missing-identity");
      expect(f.registry.defaultOwnerId()).toBeNull();
      expect(() => f.configure({ ...f.args, serviceId: "sample.another", policy: { ...f.policy, serviceId: "sample.another" } })).toThrow();
    } finally { f.store.close(); }
  });

  test("CAS precedes all writes, unchanged input is inert, and revisions resist ABA", () => {
    const f = fixture();
    try {
      const first = f.configure().current;
      const before = f.counts();
      expect(() => f.configure()).toThrow();
      expect(f.counts()).toEqual(before);
      const unchanged = f.configure({ ...f.args, expectedRevision: first.revision }).current;
      expect(unchanged).toEqual(first);
      expect(f.counts()).toEqual(before);
      expect(f.registry.setJob(first.serviceId, first.revision, "old-job")).toBe(true);
      const second = f.configure({ ...f.args, expectedRevision: first.revision, enabled: false });
      expect(second.previous?.jobId).toBe("old-job");
      expect(second.current.jobId).toBeNull();
      const third = f.configure({ ...f.args, expectedRevision: second.current.revision }).current;
      expect(third.revision).not.toBe(first.revision);
      expect(f.registry.setJob(first.serviceId, first.revision, "late-job")).toBe(false);
      expect(f.registry.get(first.serviceId)?.jobId).toBeNull();
      const after = f.counts();
      expect(() => f.configure({ ...f.args, expectedRevision: first.revision })).toThrow();
      expect(f.counts()).toEqual(after);
    } finally { f.store.close(); }
  });

  test("native credentials authorize only derived operation, location and service nodes", () => {
    const f = fixture();
    try {
      const credential = f.configure().current.credential!;
      const context = f.auth.restoreCredential(credential)!;
      expect(context.isRoot).toBe(false);
      expect(context.tokenId).not.toBeNull();
      expect(context.grantId).not.toBeNull();
      for (const { cap, ref } of f.requirements()) expect(f.auth.allowsRef(context, cap, ref)).toBe(true);
      for (const { cap, ref } of f.requirements(f.other.id)) expect(f.auth.allowsRef(context, cap, ref)).toBe(false);
      expect(f.auth.allowsRef(context, "operations:invoke", { kind: "operation", machineId: f.local.id, operationId: "sample.other" })).toBe(false);
      expect(f.auth.allowsRef(context, "locations:write", { kind: "location", machineId: f.local.id, locationId: "sample.other" })).toBe(false);
      expect(f.auth.allowsRef(context, "services:invoke", { kind: "service", machineId: f.local.id, serviceId: "sample.upstream", operationId: "other" })).toBe(false);
      expect(f.auth.allowsRef(context, "services:configure", { kind: "machine", machineId: f.local.id })).toBe(false);
      expect(f.auth.allows(context, "tokens:mint")).toBe(false);
      const location = f.requirements()[1]!;
      const grant = f.auth.listGrants({}, f.root).find((row) =>
        row.principal.kind === "principal" && row.principal.id === credential.principalId && row.node === formatManifoldUri(location.ref),
      )!;
      f.auth.revokeGrant(grant.id, f.root);
      expect(f.auth.allowsRef(context, location.cap, location.ref)).toBe(false);
      const operation = f.requirements()[0]!;
      expect(f.auth.allowsRef(context, operation.cap, operation.ref)).toBe(true);
      f.auth.revokePrincipal(credential.principalId, f.root);
      expect(f.auth.restoreCredential(credential)).toBeNull();
      const withdrawn = f.configure({
        ...f.args, expectedRevision: f.registry.get(f.args.serviceId)!.revision, enabled: false,
      });
      expect(withdrawn.current.enabled).toBe(false);
    } finally { f.store.close(); }
  });

  test("service lifetime survives browser revocation and restart; replacement and disable revoke", () => {
    const f = fixture();
    try {
      const browser = f.auth.bootstrapPrincipal({ name: "operator", kind: "human" }, f.root);
      const browserContext = f.auth.authenticate(browser.token);
      const first = f.configure(f.args, browserContext).current;
      f.auth.revokePrincipal(browser.principal.id, f.root);
      f.runtime.time += 30 * 24 * 60 * 60 * 1000;
      const restarted = new AuthService(f.store, "owner-key", f.runtime);
      const context = restarted.restoreCredential(first.credential!)!;
      const operation = f.requirements()[0]!;
      expect(restarted.allowsRef(context, operation.cap, operation.ref)).toBe(true);
      const before = f.counts();
      expect(() => f.configure({ ...f.args, expectedRevision: first.revision, enabled: false }, browserContext)).toThrow();
      expect(f.counts()).toEqual(before);
      const second = f.configure({ ...f.args, expectedRevision: first.revision, policy: { ...f.policy, revision: "policy-2" } });
      expect(second.previous).toEqual(first);
      expect(restarted.restoreCredential(first.credential!)).toBeNull();
      const disabled = f.configure({ ...f.args, expectedRevision: second.current.revision, enabled: false });
      expect(disabled.current.credential).toBeNull();
      expect(restarted.restoreCredential(second.current.credential!)).toBeNull();
    } finally { f.store.close(); }
  });

  test("failed replacement rolls back credentials and does not announce revocation", () => {
    const f = fixture();
    try {
      const first = f.configure().current;
      const before = f.counts();
      const revoked: string[] = [];
      const authorityChanges: number[] = [];
      f.auth.onRevoked((principalId) => revoked.push(principalId));
      f.auth.onAuthorityChanged(() => authorityChanges.push(1));
      f.store.db.exec(`CREATE TEMP TRIGGER reject_service_update BEFORE UPDATE ON native_instance_services
        BEGIN SELECT RAISE(ABORT, 'injected configuration failure'); END;`);
      expect(() => f.configure({ ...f.args, expectedRevision: first.revision, policy: { ...f.policy, revision: "policy-2" } })).toThrow("injected configuration failure");
      expect(f.registry.get(first.serviceId)).toEqual(first);
      expect(f.counts()).toEqual(before);
      expect(revoked).toEqual([]);
      expect(authorityChanges).toEqual([]);
      const current = f.auth.restoreCredential(first.credential!)!;
      const operation = f.requirements()[0]!;
      expect(f.auth.allowsRef(current, operation.cap, operation.ref)).toBe(true);
    } finally { f.store.close(); }
  });

  test("registration refuses nonroot, denied owner authority and mismatched runtime namespace", () => {
    const f = fixture();
    try {
      const minter = f.auth.mintToken({ principal: { kind: "human", name: "nonroot" }, caps: ["services:configure"] }, f.root);
      const before = f.counts();
      expect(() => f.configure(f.args, f.auth.authenticate(minter.token))).toThrow();
      expect(() => f.configure({ ...f.args, policy: { ...f.policy, runtime: { ...f.policy.runtime!, pluginId: "other" } } })).toThrow();
      expect(f.counts()).toEqual(before);
      const browser = f.auth.bootstrapPrincipal({ kind: "human", name: "operator" }, f.root);
      const actor = f.auth.authenticate(browser.token);
      f.auth.grant({ principal: { kind: "principal", id: actor.principal.id }, node: formatManifoldUri({ kind: "machine", machineId: f.local.id }), caps: ["services:configure"], effect: "deny", reach: "node" }, f.root);
      const denied = f.counts();
      expect(() => f.configure(f.args, actor)).toThrow();
      expect(f.counts()).toEqual(denied);
    } finally { f.store.close(); }
  });
});
