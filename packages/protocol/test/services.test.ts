import { expect, test } from "bun:test";
import { ServiceCallSchema, ServicePolicySchema, ServiceReplySchema, type ServicePolicy } from "../src/services.ts";

function policy(): ServicePolicy {
  return {
    serviceId: "inventory", revision: "r1", origin: "https://example.invalid", allowLoopbackHttp: false,
    maxConcurrent: 1,
    operations: { read: {
      method: "GET", path: "/items", input: {}, query: {}, body: [], timeoutMs: 1000,
      maxRequestBytes: 4096, maxResponseBytes: 4096, maxResultBytes: 4096,
      response: { kind: "projected-json", fields: [["items", "*", "id"]], maxArrayItems: 16 },
    } },
  };
}

test("child service wire rejects injected authority, transport controls and multibyte input overflow", () => {
  const request = { type: "service", requestId: "r1", serviceId: "inventory", operationId: "read", input: {} };
  expect(ServiceCallSchema.safeParse(request).success).toBe(true);
  for (const field of ["jobId", "principalId", "revision", "url", "headers", "credential", "method"]) {
    expect(ServiceCallSchema.safeParse({ ...request, [field]: "injected" }).success).toBe(false);
  }
  expect(ServiceCallSchema.safeParse({ ...request, input: { text: "界".repeat(22000) } }).success).toBe(false);
  expect(ServiceCallSchema.safeParse({ ...request, input: { data: { token: "hidden" } } }).success).toBe(false);
  expect(ServiceCallSchema.safeParse({ ...request, input: { count: Infinity } }).success).toBe(false);
  expect(ServiceReplySchema.safeParse({ type: "service_result", requestId: "r1", ok: false, refusal: "raw upstream exception" }).success).toBe(false);
  expect(ServiceReplySchema.safeParse({ type: "service_result", requestId: "r1", ok: true, result: "界".repeat(45000) }).success).toBe(false);
});

test("trusted transport refuses ambiguous origins and never upgrades public HTTP into authority", () => {
  for (const origin of ["http://example.invalid", "http://localhost", "http://127.0.0.2", "https://user:secret@example.invalid", "https://example.invalid/path", "https://example.invalid?query=1", "https://example.invalid#fragment", "https://example.invalid/", "file:///tmp/socket"]) {
    expect(ServicePolicySchema.safeParse({ ...policy(), origin, allowLoopbackHttp: true }).success).toBe(false);
  }
  expect(ServicePolicySchema.safeParse({ ...policy(), origin: "http://127.0.0.1:1234" }).success).toBe(false);
  for (const origin of ["http://127.0.0.1:1234", "http://[::1]:1234", "https://example.invalid"]) {
    expect(ServicePolicySchema.safeParse({ ...policy(), origin, allowLoopbackHttp: true }).success).toBe(true);
  }
});

test("only canonical paths, complete typed mappings and nonoverlapping projection leaves are admitted", () => {
  for (const path of ["//other.invalid", "/a/../b", "/a/%2e%2e", "/a\\b", "/a?token=secret", "/a#fragment", "/a/", "/{unknown}"]) {
    const spec = policy();
    spec.operations.read!.path = path;
    expect(ServicePolicySchema.safeParse(spec).success).toBe(false);
  }
  for (const fields of [ [["items"], ["items", "*", "id"]], [["items", "*", "id"], ["items", "length"]], [["id"], ["id"]], [["constructor"]] ]) {
    const spec = policy();
    spec.operations.read!.response = { kind: "projected-json", fields, maxArrayItems: 16 };
    expect(ServicePolicySchema.safeParse(spec).success).toBe(false);
  }
  const spec = policy();
  spec.operations.read!.query = { q: "undeclared" };
  expect(ServicePolicySchema.safeParse(spec).success).toBe(false);
});

test("body mappings cannot collide, change object/array shape or smuggle prototype fields", () => {
  for (const paths of [ [["x"], ["x", "y"]], [["x", 0], ["x", "name"]], [["constructor", "prototype"]], [["x"], ["x"]] ]) {
    const spec = policy();
    spec.operations.read!.method = "POST";
    spec.operations.read!.body = paths.map((path) => ({ path, value: { literal: "fixed" } }));
    expect(ServicePolicySchema.safeParse(spec).success).toBe(false);
  }
});

test("full responses require explicit disclosure and credentials are only opaque owner references", () => {
  const spec = policy();
  for (const header of ["Host", "Connection", "Content-Length", "Transfer-Encoding", "Cookie", "Proxy-Authorization", "Accept-Encoding"]) {
    expect(ServicePolicySchema.safeParse({ ...spec, credential: { ref: "key", header, prefix: "Bearer " } }).success).toBe(false);
  }
  expect(ServicePolicySchema.safeParse({ ...spec, credential: { ref: "key", header: "Authorization", prefix: "Bearer ", value: "raw" } }).success).toBe(false);
  expect(ServicePolicySchema.safeParse({ ...spec, credential: { ref: "/tmp/key", header: "Authorization", prefix: "Bearer " } }).success).toBe(false);
  expect(ServicePolicySchema.safeParse({ ...spec, operations: { read: { ...spec.operations.read!, response: { kind: "json" } } } }).success).toBe(false);
});
