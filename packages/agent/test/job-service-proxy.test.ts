import { expect, test } from "bun:test";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { ServiceBinding, ServicePolicy } from "@manifold/protocol";
import { createJobServiceProxy, type JobServiceProxy } from "../src/job-service-proxy.ts";
import { createJobServiceRunner } from "../src/job-services.ts";

const binding: ServiceBinding = { serviceId: "gateway", revision: "r1", operationIds: ["generate"] };
function policy(origin: string): ServicePolicy {
  return {
    serviceId: "gateway", revision: "r1", origin, allowLoopbackHttp: true, maxConcurrent: 1,
    credential: { ref: "owner-key", header: "Authorization", prefix: "Bearer " },
    operations: { generate: {
      kind: "http-proxy", method: "POST", path: "/v1/generate", request: { kind: "json", disclosure: "full" },
      response: { kind: "stream", disclosure: "full", contentTypes: ["application/json", "text/event-stream"], headers: ["retry-after", "x-request-id"] },
      timeoutMs: 2000, maxRequestBytes: 4096, maxResponseBytes: 4096,
    } },
  };
}
async function upstream(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer((request, response) => { void Promise.resolve(handler(request, response)).catch(() => response.destroy()); });
  const ready = Promise.withResolvers<void>();
  server.once("error", ready.reject);
  server.listen(0, "127.0.0.1", ready.resolve);
  await ready.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing loopback address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      const stopped = Promise.withResolvers<void>();
      server.close(() => stopped.resolve());
      server.closeAllConnections();
      await stopped.promise;
    },
  };
}
async function send(proxy: JobServiceProxy, options: { path?: string; method?: string; bearer?: string | null; headers?: Record<string, string>; body?: string } = {}) {
  const result = Promise.withResolvers<{ status: number; body: string }>();
  const request = httpRequest(proxy.url, {
    path: options.path ?? "/v1/generate", method: options.method ?? "POST", agent: false,
    headers: { "content-type": "application/json", ...(options.bearer === null ? {} : { authorization: `Bearer ${options.bearer ?? proxy.bearer}` }), ...options.headers },
  }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.once("error", result.reject);
    response.once("end", () => result.resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
  });
  request.once("error", result.reject);
  request.end(options.body ?? "{}");
  return result.promise;
}
const secret = "zz-owner-secret";

test("fixed route streams before completion with owner-only credentials and no forwarded authority headers", async () => {
  const release = Promise.withResolvers<void>();
  const observed = Promise.withResolvers<{ authorization?: string; target?: string | string[]; body: string }>();
  const server = await upstream(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    observed.resolve({ authorization: request.headers.authorization, target: request.headers["x-upstream-url"], body: Buffer.concat(chunks).toString() });
    response.writeHead(200, { "content-type": "text/event-stream", "set-cookie": "owner=private", authorization: `Bearer ${secret}`, "x-request-id": secret });
    response.write("data: 123\n\n");
    await release.promise;
    response.end("data: 456\n\n");
  });
  const spec = policy(server.origin);
  const proxy = await createJobServiceProxy({ policies: [spec], bindings: [binding], resolveCredential: async () => secret, authorize: async () => true });
  try {
    expect(new URL(proxy.url).hostname).toBe("127.0.0.1");
    expect(proxy.bearer).not.toBe(secret);
    // Mutating owner input after construction cannot change the captured route or origin.
    spec.origin = "https://other.invalid";
    spec.operations.generate!.path = "/other";
    const response = await fetch(`${proxy.url}/v1/generate`, { method: "POST", headers: { authorization: `Bearer ${proxy.bearer}`, "content-type": "application/json", "x-upstream-url": "https://other.invalid" }, body: '{"stream":true}' });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: 123\n\n");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("authorization")).toBeNull();
    expect(response.headers.get("x-request-id")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await observed.promise).toEqual({ authorization: `Bearer ${secret}`, target: undefined, body: '{"stream":true}' });
    release.resolve();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: 456\n\n");
    expect((await reader.read()).done).toBe(true);
  } finally { release.resolve(); await proxy.close(); await server.close(); }
});

test("capability, exact method/path, query, traversal, origin and request bounds reject before native authority or upstream", async () => {
  let hits = 0;
  let authorized = 0;
  const server = await upstream((_request, response) => { hits++; response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); });
  const proxy = await createJobServiceProxy({ policies: [policy(server.origin)], bindings: [binding], resolveCredential: async () => secret, authorize: async () => { authorized++; return true; } });
  try {
    expect((await send(proxy, { bearer: null })).status).toBe(401);
    expect((await send(proxy, { bearer: "incorrect" })).status).toBe(401);
    for (const path of ["/other", "/v1/generate?url=https://other.invalid", "/v1/../v1/generate", "/v1/%67enerate", "http://other.invalid/v1/generate", "//v1/generate"])
      expect((await send(proxy, { path })).status).toBe(404);
    expect((await send(proxy, { method: "GET" })).status).toBe(404);
    expect((await send(proxy, { headers: { origin: "https://other.invalid" } })).status).toBe(400);
    expect((await send(proxy, { headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await send(proxy, { headers: { "content-length": "5000" }, body: "x".repeat(5000) })).status).toBe(413);
    expect(authorized).toBe(0);
    expect(hits).toBe(0);
  } finally { await proxy.close(); await server.close(); }
});

test("stale or ambiguous bindings fail startup, and normal request/reply cannot invoke proxy operations", async () => {
  const spec = policy("https://example.invalid");
  await expect(createJobServiceProxy({ policies: [spec], bindings: [{ ...binding, revision: "r2" }], authorize: async () => true })).rejects.toThrow("service_binding_mismatch");
  await expect(createJobServiceProxy({ policies: [spec], bindings: [{ ...binding, operationIds: ["unknown"] }], authorize: async () => true })).rejects.toThrow("service_binding_mismatch");
  const duplicate = { ...spec, serviceId: "duplicate" };
  await expect(createJobServiceProxy({ policies: [spec, duplicate], bindings: [binding, { ...binding, serviceId: "duplicate" }], authorize: async () => true })).rejects.toThrow("service_policy_invalid");
  const runner = createJobServiceRunner({ policies: [spec] });
  try {
    const reply = await runner.call({ type: "service", requestId: "r", serviceId: binding.serviceId, operationId: "generate", input: {} }, binding, async () => { throw new Error("must not authorize"); });
    expect(reply).toMatchObject({ ok: false, refusal: "service_operation_unknown" });
  } finally { runner.close(); }
});

test("every call checks current authority and rechecks revocation after credential resolution", async () => {
  let hits = 0;
  let granted = false;
  let resolved = 0;
  const server = await upstream((_request, response) => { hits++; response.end(); });
  const proxy = await createJobServiceProxy({ policies: [policy(server.origin)], bindings: [binding], authorize: async (authority) => {
    expect(authority).toEqual({ serviceId: "gateway", revision: "r1", operationId: "generate", input: {} });
    return granted;
  }, resolveCredential: async () => { resolved++; granted = false; return secret; } });
  try {
    expect((await send(proxy)).status).toBe(403);
    expect(resolved).toBe(0);
    granted = true;
    expect((await send(proxy)).status).toBe(403);
    expect(resolved).toBe(1);
    expect(hits).toBe(0);
  } finally { await proxy.close(); await server.close(); }
});

test("full-disclosure application errors preserve status/body but redirects and unsafe encodings never cross", async () => {
  let mode = "error";
  let hits = 0;
  const server = await upstream(async (request, response) => {
    for await (const _chunk of request) { /* drain application body */ }
    hits++;
    if (mode === "redirect") { response.writeHead(307, { location: "/escape", "content-type": "application/json" }); response.end("private redirect"); }
    else if (mode === "encoding") { response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" }); response.end("private compression"); }
    else if (mode === "mime") { response.writeHead(200, { "content-type": "text/html" }); response.end("private markup"); }
    else { response.writeHead(429, { "content-type": "application/json", "retry-after": "2", connection: "x-request-id", "x-request-id": "hop-only", "set-cookie": "session=private" }); response.end('{"error":"quota"}'); }
  });
  const proxy = await createJobServiceProxy({ policies: [policy(server.origin)], bindings: [binding], authorize: async () => true, resolveCredential: async () => secret });
  try {
    const response = await fetch(`${proxy.url}/v1/generate`, { method: "POST", headers: { authorization: `Bearer ${proxy.bearer}`, "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(429);
    expect(await response.text()).toBe('{"error":"quota"}');
    expect(response.headers.get("retry-after")).toBe("2");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-request-id")).toBeNull();
    for (mode of ["redirect", "encoding", "mime"]) {
      const result = await send(proxy);
      expect(result.status).toBe(502);
      expect(result.body).not.toContain("private");
    }
    expect(hits).toBe(4);
  } finally { await proxy.close(); await server.close(); }
});

test("split source credential echoes terminate streaming without disclosing the held suffix", async () => {
  for (const echoed of [secret, secret.split("").map((character) => `\\u00${character.charCodeAt(0).toString(16)}`).join("")]) {
    const release = Promise.withResolvers<void>();
    const midpoint = Math.floor(echoed.length / 2);
    const server = await upstream(async (request, response) => {
      for await (const _chunk of request) { /* drain */ }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`OK:${echoed.slice(0, midpoint)}`);
      await release.promise;
      response.end(echoed.slice(midpoint));
    });
    const proxy = await createJobServiceProxy({ policies: [policy(server.origin)], bindings: [binding], authorize: async () => true, resolveCredential: async () => secret });
    try {
      const response = await fetch(`${proxy.url}/v1/generate`, { method: "POST", headers: { authorization: `Bearer ${proxy.bearer}`, "content-type": "application/json" }, body: "{}" });
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("OK:");
      release.resolve();
      await expect(reader.read()).rejects.toThrow();
    } finally { release.resolve(); await proxy.close(); await server.close(); }
  }
});

test("concurrency is bounded while authorization waits and owner cancellation releases ignored callbacks", async () => {
  const entered = Promise.withResolvers<void>();
  const permission = Promise.withResolvers<boolean>();
  const abort = new AbortController();
  let hits = 0;
  const server = await upstream((_request, response) => { hits++; response.end(); });
  const proxy = await createJobServiceProxy({ policies: [policy(server.origin)], bindings: [binding], signal: abort.signal, authorize: async () => { entered.resolve(); return permission.promise; } });
  try {
    const pending = send(proxy).then(() => "response", () => "disconnected");
    await entered.promise;
    expect((await send(proxy)).status).toBe(429);
    abort.abort();
    await pending;
    await proxy.close();
    await expect(send(proxy)).rejects.toThrow();
    expect(hits).toBe(0);
  } finally { permission.resolve(true); await proxy.close(); await server.close(); }
});

test("deadline bounds a resolver that ignores cancellation without exposing raw errors", async () => {
  const spec = policy("https://example.invalid");
  spec.operations.generate!.timeoutMs = 20;
  const credential = Promise.withResolvers<string>();
  const proxy = await createJobServiceProxy({ policies: [spec], bindings: [binding], authorize: async () => true, resolveCredential: async () => credential.promise });
  try {
    const response = await send(proxy);
    expect(response).toEqual({ status: 503, body: '{"error":"service_timeout"}' });
  } finally { credential.reject(new Error(`private ${secret}`)); await proxy.close(); }
});

test("client disconnect and explicit close cancel active upstream streams", async () => {
  for (const action of ["disconnect", "close"] as const) {
    const cancelled = Promise.withResolvers<void>();
    const server = await upstream(async (request, response) => {
      for await (const _chunk of request) { /* drain */ }
      response.once("close", cancelled.resolve);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: 123\n\n");
    });
    const proxy = await createJobServiceProxy({ policies: [policy(server.origin)], bindings: [binding], authorize: async () => true, resolveCredential: async () => secret });
    try {
      const response = await fetch(`${proxy.url}/v1/generate`, { method: "POST", headers: { authorization: `Bearer ${proxy.bearer}`, "content-type": "application/json" }, body: "{}" });
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: 123\n\n");
      if (action === "disconnect") await reader.cancel();
      else { await proxy.close(); await expect(reader.read()).rejects.toThrow(); }
      await cancelled.promise;
    } finally { await proxy.close(); await server.close(); }
  }
});

test("declared response byte limit terminates an unbounded chunked stream", async () => {
  const release = Promise.withResolvers<void>();
  const server = await upstream(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: 123\n\n");
    await release.promise;
    response.end("x".repeat(5000));
  });
  const proxy = await createJobServiceProxy({ policies: [policy(server.origin)], bindings: [binding], authorize: async () => true, resolveCredential: async () => secret });
  try {
    const response = await fetch(`${proxy.url}/v1/generate`, { method: "POST", headers: { authorization: `Bearer ${proxy.bearer}`, "content-type": "application/json" }, body: "{}" });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: 123\n\n");
    release.resolve();
    await expect(reader.read()).rejects.toThrow();
  } finally { release.resolve(); await proxy.close(); await server.close(); }
});
