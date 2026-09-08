import { expect, test } from "bun:test";
import { ServiceCallSchema, ServicePolicySchema, ServiceProxyOperationPolicySchema, ServiceReplySchema, type ServicePolicy, type ServiceProxyOperationPolicy } from "../src/services.ts";

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

function proxyOperation(): ServiceProxyOperationPolicy {
  return {
    kind: "http-proxy", method: "GET", path: "/inventory", request: { kind: "none" },
    response: { kind: "stream", disclosure: "full", contentTypes: ["application/json"], headers: ["etag"] },
    timeoutMs: 1000, maxRequestBytes: 4096, maxResponseBytes: 4096,
  };
}

test("proxy header policies admit application data but never transport, routing or credential controls", () => {
  const operation = proxyOperation();
  expect(ServiceProxyOperationPolicySchema.safeParse({ ...operation, requestHeaders: {
    "x-inventory-version": { kind: "literal", value: "inventory-v2" },
    "x-inventory-region": { kind: "forward", maxBytes: 4, required: true, enum: ["west", "east"] },
    "if-none-match": { kind: "forward", maxBytes: 128, required: false },
  } }).success).toBe(true);
  for (const header of [
    "Authorization", "authorization", "authentication-info", "www-authenticate", "cookie", "set-cookie",
    "host", "connection", "keep-alive", "content-length", "content-type", "content-encoding",
    "transfer-encoding", "te", "trailer", "upgrade", "expect", "accept", "accept-encoding",
    "origin", "referer", "via", "forwarded", "forwarded-for", "max-forwards", "http2-settings",
    "proxy-authorization", "proxy-custom", "sec-fetch-site", "x-forwarded-host", "x-real-ip",
    "x-upstream-url", "x-original-url", "x-original-host", "x-rewrite-url", "x-http-method-override",
    "access-control-request-method", "__proto__", "constructor", "prototype", "bad name", "bad\r\nname", "bad\n",
  ]) {
    for (const field of [{ kind: "literal", value: "fixed" }, { kind: "forward", maxBytes: 8, required: false }]) {
      expect(ServiceProxyOperationPolicySchema.safeParse({ ...operation, requestHeaders: { [header]: field } }).success).toBe(false);
    }
  }
  expect(ServiceProxyOperationPolicySchema.safeParse({ ...operation, requestHeaders: ["if-none-match"] }).success).toBe(false);
  for (const field of [{ kind: "literal", value: "fixed" }, { kind: "forward", maxBytes: 8, required: false }]) {
    expect(ServicePolicySchema.safeParse({
      ...policy(), credential: { ref: "key", header: "X-Inventory-Key", prefix: "" },
      operations: { read: { ...operation, requestHeaders: { "x-inventory-key": field } } },
    }).success).toBe(false);
  }
});

test("proxy header policies bound safe values, distinct enums, header count and aggregate wire bytes", () => {
  const operation = proxyOperation();
  const invalidFields = [
    { kind: "literal", value: "x\r\ninjected: yes" },
    { kind: "literal", value: "bad\tvalue" },
    { kind: "literal", value: "caf\xe9" },
    { kind: "literal", value: " ambiguous " },
    { kind: "literal", value: "x".repeat(4097) },
    { kind: "forward", maxBytes: 0, required: false },
    { kind: "forward", maxBytes: 4097, required: false },
    { kind: "forward", maxBytes: 8 },
    { kind: "forward", maxBytes: 8, required: false, enum: [] },
    { kind: "forward", maxBytes: 8, required: false, enum: ["same", "same"] },
    { kind: "forward", maxBytes: 8, required: false, enum: ["bad\nvalue"] },
    { kind: "forward", maxBytes: 3, required: false, enum: ["west"] },
    { kind: "forward", maxBytes: 8, required: false, enum: Array.from({ length: 65 }, (_, i) => String(i)) },
  ];
  for (const field of invalidFields)
    expect(ServiceProxyOperationPolicySchema.safeParse({ ...operation, requestHeaders: { "x-inventory": field } }).success).toBe(false);
  const tooMany = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`x-${i}`, { kind: "literal", value: "" }]));
  expect(ServiceProxyOperationPolicySchema.safeParse({ ...operation, requestHeaders: tooMany }).success).toBe(false);
  for (const maxBytes of [4089, 4090]) {
    expect(ServiceProxyOperationPolicySchema.safeParse({ ...operation, requestHeaders: {
      "x-a": { kind: "forward", maxBytes, required: false },
      "x-b": { kind: "literal", value: "x".repeat(maxBytes) },
    } }).success).toBe(maxBytes === 4089);
  }
});
