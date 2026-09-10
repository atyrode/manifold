import { expect, test } from "bun:test";
import { closeSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTCPServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ServiceBinding,
  ServiceCall,
  ServicePolicy,
  ServiceOperationPolicy,
  ServiceCredentialReference,
} from "@manifold/protocol";
import { createJobServiceRunner, heldServiceCredentialResolver } from "../src/job-services.ts";
import { HeldDirectory } from "../src/job-files.ts";
import { JobResources } from "../src/job-resources.ts";
import { connectWorkloadLoopback } from "../src/job-listener-proof.ts";

const binding: ServiceBinding = { serviceId: "inventory", revision: "r1", operationIds: ["read"] };
const call: ServiceCall = {
  type: "service",
  requestId: "request-1",
  serviceId: "inventory",
  operationId: "read",
  input: {},
};
function policy(origin: string): ServicePolicy {
  return {
    serviceId: "inventory",
    revision: "r1",
    origin,
    allowLoopbackHttp: true,
    maxConcurrent: 1,
    operations: {
      read: {
        method: "GET",
        path: "/items",
        input: {},
        query: {},
        body: [],
        timeoutMs: 1000,
        maxRequestBytes: 4096,
        maxResponseBytes: 4096,
        maxResultBytes: 4096,
        response: {
          kind: "projected-json",
          fields: [
            ["items", "*", "id"],
            ["items", "*", "enabled"],
          ],
          maxArrayItems: 8,
        },
      },
    },
  };
}
const allow = async () => true;

test("real service reads reconstruct only declared metadata across arrays", async () => {
  const observed: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      observed.push(request.headers.get("authorization") ?? "missing");
      return Response.json({
        secret: "hidden-root",
        items: [
          { id: "a", enabled: true, credential: { token: "hidden-member" } },
          { id: "b", enabled: false, token: "hidden" },
        ],
      });
    },
  });
  const spec = policy(server.url.origin);
  spec.credential = { ref: "owner-key", header: "Authorization", prefix: "Bearer " };
  const runner = createJobServiceRunner({
    policies: [spec],
    resolveCredential: async () => "test-only-upstream-key",
  });
  try {
    expect(await runner.call(call, binding, allow)).toEqual({
      type: "service_result",
      requestId: call.requestId,
      ok: true,
      result: {
        items: [
          { id: "a", enabled: true },
          { id: "b", enabled: false },
        ],
      },
    });
    expect(observed).toEqual(["Bearer test-only-upstream-key"]);
  } finally {
    runner.close();
    await server.stop(true);
  }
});

function instancePolicy(origin: string): ServicePolicy {
  const spec = policy(origin);
  delete spec.origin;
  delete spec.allowLoopbackHttp;
  spec.runtime = {
    scope: "instance",
    pluginId: "fixture",
    operationId: "serve",
    installationRevision: "r1",
    artifactSha256: "a".repeat(64),
    resourceBindingDigest: "b".repeat(64),
    input: {},
  };
  return spec;
}

async function runtimeUpstream(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing runtime port");
  return {
    server,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await stopped;
    },
  };
}

test("instance reads and invokes use only proved connections and disclose only safe projection leaves", async () => {
  const bearer = "native-sealed-bearer".repeat(2);
  const lifetime = new AbortController();
  const provedPorts = new Set<number>();
  const sockets: Socket[] = [];
  let connections = 0;
  let echo = false;
  const items = [{ id: "a", enabled: true }];
  const server = await runtimeUpstream(async (request, response) => {
    if (
      !provedPorts.has(request.socket.remotePort!) ||
      request.headers.authorization !== `Bearer ${bearer}`
    ) {
      response.writeHead(403).end();
      return;
    }
    if (request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      const input = JSON.parse(body);
      items.push({ id: input.id, enabled: true });
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        credential: { token: bearer },
        items: items.map((item) => ({
          ...item,
          id: echo ? bearer : item.id,
          privateSnapshot: { token: bearer },
        })),
      }),
    );
  });
  server.server.on("connection", () => connections++);
  const spec = instancePolicy(server.url);
  spec.operations.invoke = {
    ...(spec.operations.read as ServiceOperationPolicy),
    method: "POST",
    input: { id: { type: "string", required: true, maxBytes: 32 } },
    body: [{ path: ["id"], value: { input: "id" } }],
  };
  const runner = createJobServiceRunner({
    policies: [spec],
    resolveRuntime: async (_policy, signal) => {
      const socket = await connectWorkloadLoopback(server.port, () => true, signal);
      sockets.push(socket);
      provedPorts.add(socket.localPort!);
      return { url: server.url, bearer, signal: lifetime.signal, socket };
    },
  });
  try {
    expect(await runner.call(call, binding, allow)).toEqual({
      type: "service_result",
      requestId: call.requestId,
      ok: true,
      result: { items: [{ id: "a", enabled: true }] },
    });
    expect(
      await runner.call(
        { ...call, operationId: "invoke", input: { id: "b" } },
        { ...binding, operationIds: ["read", "invoke"] },
        allow,
      ),
    ).toMatchObject({
      ok: true,
      result: {
        items: [
          { id: "a", enabled: true },
          { id: "b", enabled: true },
        ],
      },
    });
    echo = true;
    expect(await runner.call(call, binding, allow)).toEqual({
      type: "service_result",
      requestId: call.requestId,
      ok: false,
      refusal: "service_response_invalid",
    });
    expect(connections).toBe(3);
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);
  } finally {
    lifetime.abort();
    runner.close();
    await server.close();
  }
});

test("instance transport never redials when its proved socket dies before HTTP handoff", async () => {
  let requestBytes = 0;
  let connections = 0;
  let proved: Socket | undefined;
  const peers = new Set<Socket>();
  const lifetime = new AbortController();
  const accepted = Promise.withResolvers<void>();
  const server = createTCPServer((socket) => {
    connections++;
    peers.add(socket);
    socket.on("data", (chunk) => {
      requestBytes += chunk.length;
    });
    socket.once("close", () => peers.delete(socket));
    accepted.resolve();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing runtime port");
  const url = `http://127.0.0.1:${address.port}`;
  const runner = createJobServiceRunner({
    policies: [instancePolicy(url)],
    resolveRuntime: async (_policy, signal) => {
      proved = await connectWorkloadLoopback(address.port, () => true, signal);
      await accepted.promise;
      return { url, bearer: "x".repeat(32), signal: lifetime.signal, socket: proved };
    },
  });
  try {
    expect(
      await runner.call(call, binding, async () => {
        proved?.destroy();
        return true;
      }),
    ).toMatchObject({ ok: false, refusal: "service_unavailable" });
    expect(connections).toBe(1);
    expect(requestBytes).toBe(0);
    expect(proved?.destroyed).toBe(true);
  } finally {
    lifetime.abort();
    runner.close();
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("instance resolution and response waits cannot retain revoked authority", async () => {
  let granted = false;
  let requests = 0;
  let resolutions = 0;
  let revokeAt: "resolution" | "response" = "resolution";
  const sockets: Socket[] = [];
  const lifetime = new AbortController();
  const server = await runtimeUpstream((_request, response) => {
    requests++;
    granted = false;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"items":[{"id":"private-after-revocation","enabled":true}]}');
  });
  const runner = createJobServiceRunner({
    policies: [instancePolicy(server.url)],
    resolveRuntime: async (_policy, signal) => {
      resolutions++;
      const socket = await connectWorkloadLoopback(server.port, () => true, signal);
      sockets.push(socket);
      if (revokeAt === "resolution") granted = false;
      return { url: server.url, bearer: "x".repeat(32), signal: lifetime.signal, socket };
    },
  });
  const authorize = async () => granted;
  const denied = {
    type: "service_result",
    requestId: call.requestId,
    ok: false,
    refusal: "service_unauthorized",
  } as const;
  try {
    expect(await runner.call(call, binding, authorize)).toEqual(denied);
    expect(resolutions).toBe(0);
    granted = true;
    expect(await runner.call(call, binding, authorize)).toEqual(denied);
    expect(requests).toBe(0);
    revokeAt = "response";
    granted = true;
    expect(await runner.call(call, binding, authorize)).toEqual(denied);
    expect(requests).toBe(1);
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);
  } finally {
    lifetime.abort();
    runner.close();
    await server.close();
  }
});

test("instance sockets returned after cancellation are closed without upstream effects", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const resolved = Promise.withResolvers<Socket>();
  const controller = new AbortController();
  const lifetime = new AbortController();
  let requests = 0;
  const server = await runtimeUpstream((_request, response) => {
    requests++;
    response.end();
  });
  const runner = createJobServiceRunner({
    policies: [instancePolicy(server.url)],
    resolveRuntime: async () => {
      // Deliberately ignore request cancellation to exercise late-result ownership.
      const socket = await connectWorkloadLoopback(server.port, () => true, lifetime.signal);
      entered.resolve();
      await release.promise;
      resolved.resolve(socket);
      return { url: server.url, bearer: "x".repeat(32), signal: controller.signal, socket };
    },
  });
  try {
    const reply = runner.call(call, binding, allow, controller.signal);
    await entered.promise;
    controller.abort();
    expect(await reply).toMatchObject({ ok: false, refusal: "service_cancelled" });
    release.resolve();
    const socket = await resolved.promise;
    // Run after the resolver's settlement handler, without relying on a wall-clock delay.
    await Promise.resolve();
    expect(socket.destroyed).toBe(true);
    expect(requests).toBe(0);
  } finally {
    lifetime.abort();
    release.resolve();
    runner.close();
    await server.close();
  }
});

test("native revocation prevents upstream access, including revocation during credential resolution", async () => {
  let upstream = 0;
  let resolved = 0;
  let granted = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      upstream++;
      return Response.json({ items: [] });
    },
  });
  const spec = policy(server.url.origin);
  spec.credential = { ref: "owner-key", header: "Authorization", prefix: "Bearer " };
  const runner = createJobServiceRunner({
    policies: [spec],
    resolveCredential: async () => {
      resolved++;
      granted = false;
      return "test-only-key";
    },
  });
  try {
    const denied = await runner.call(call, binding, async () => granted);
    expect(denied).toMatchObject({ ok: false, refusal: "service_unauthorized" });
    expect(resolved).toBe(0);
    granted = true;
    expect(await runner.call(call, binding, async () => granted)).toMatchObject({
      ok: false,
      refusal: "service_unauthorized",
    });
    expect(upstream).toBe(0);
    expect(resolved).toBe(1);
  } finally {
    runner.close();
    await server.stop(true);
  }
});

test("only bound exact revisions and declared operations reach authority", async () => {
  let authorized = 0;
  const runner = createJobServiceRunner({ policies: [policy("https://example.invalid")] });
  const authorize = async () => {
    authorized++;
    return true;
  };
  try {
    expect(await runner.call(call, { ...binding, revision: "r2" }, authorize)).toMatchObject({
      refusal: "service_binding_mismatch",
    });
    expect(await runner.call({ ...call, operationId: "remove" }, binding, authorize)).toMatchObject(
      { refusal: "service_binding_mismatch" },
    );
    expect(
      await runner.call(
        { ...call, operationId: "remove" },
        { ...binding, operationIds: ["remove"] },
        authorize,
      ),
    ).toMatchObject({ refusal: "service_operation_unknown" });
    expect(await runner.call({ ...call, serviceId: "other" }, binding, authorize)).toMatchObject({
      refusal: "service_unavailable",
    });
    expect(authorized).toBe(0);
  } finally {
    runner.close();
  }
});

test("path arguments cannot traverse or escape, while query/body scalars are mapped without forwarding", async () => {
  const observed: { method: string; path: string; body: unknown }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      observed.push({
        method: request.method,
        path: url.pathname + url.search,
        body: await request.json(),
      });
      return Response.json({ items: [] });
    },
  });
  const spec = policy(server.url.origin);
  Object.assign(spec.operations.read!, {
    method: "POST",
    path: "/items/{id}",
    input: {
      id: { type: "string", required: true, maxBytes: 128 },
      query: { type: "string", required: true, maxBytes: 128 },
      count: { type: "number", required: true, min: 0, max: 10, integer: true },
    },
    query: { q: "query" },
    body: [
      { path: ["amount"], value: { input: "count" } },
      { path: ["messages", 0, "role"], value: { literal: "user" } },
      { path: ["messages", 0, "content"], value: { input: "query" } },
      { path: ["stream"], value: { literal: false } },
    ],
  });
  const runner = createJobServiceRunner({ policies: [spec] });
  try {
    for (const id of [
      "..",
      ".",
      "../other",
      "%2e%2e",
      "%252f",
      "a/b",
      "a\\b",
      "x?admin=1",
      "x#fragment",
      "",
    ]) {
      expect(
        await runner.call({ ...call, input: { id, query: "a&b", count: 2 } }, binding, allow),
      ).toMatchObject({ refusal: "service_input_invalid" });
    }
    expect(observed).toEqual([]);
    expect(
      await runner.call(
        { ...call, input: { id: "a_1.~", query: "a&b", count: 2 } },
        binding,
        allow,
      ),
    ).toMatchObject({ ok: true });
    expect(observed).toEqual([
      {
        method: "POST",
        path: "/items/a_1.~?q=a%26b",
        body: { amount: 2, messages: [{ role: "user", content: "a&b" }], stream: false },
      },
    ]);
    expect(
      await runner.call({ ...call, input: { id: "a", query: "q", count: 11 } }, binding, allow),
    ).toMatchObject({ refusal: "service_input_invalid" });
    expect(
      await runner.call(
        { ...call, input: { id: "a", query: "q", count: 2, url: "https://other.invalid" } },
        binding,
        allow,
      ),
    ).toMatchObject({ refusal: "service_input_invalid" });
  } finally {
    runner.close();
    await server.stop(true);
  }
});

test("redirects, error bodies, malformed bodies and object-valued metadata leaves fail closed", async () => {
  let mode = "redirect";
  let redirected = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/leak") redirected++;
      if (mode === "redirect")
        return new Response("hidden-error", { status: 302, headers: { location: "/leak" } });
      if (mode === "error") return new Response("hidden-error", { status: 403 });
      if (mode === "malformed")
        return new Response('{"hidden-error":', {
          headers: { "content-type": "application/json" },
        });
      if (mode === "object") return Response.json({ items: [{ id: { token: "hidden-error" } }] });
      if (mode === "oversized") return Response.json({ hidden: "x".repeat(8192) });
      return Response.json({ items: Array.from({ length: 9 }, () => ({ id: "a" })) });
    },
  });
  const runner = createJobServiceRunner({ policies: [policy(server.url.origin)] });
  try {
    for (const value of ["redirect", "error", "malformed", "object", "oversized", "array-limit"]) {
      mode = value;
      const reply = await runner.call(call, binding, allow);
      expect(reply.ok).toBe(false);
      expect(JSON.stringify(reply)).not.toContain("hidden-error");
    }
    expect(redirected).toBe(0);
  } finally {
    runner.close();
    await server.stop(true);
  }
});

test("explicit full JSON and bytes disclosure still refuse upstream credential echoes", async () => {
  const secret = "test-only-key";
  let bytes = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return bytes ? new Response(secret) : Response.json({ value: secret });
    },
  });
  try {
    for (const kind of ["json", "bytes"] as const) {
      bytes = kind === "bytes";
      const spec = policy(server.url.origin);
      spec.operations.read!.response = { kind, disclosure: "full" };
      spec.credential = { ref: "key", header: "Authorization", prefix: "Bearer " };
      const runner = createJobServiceRunner({
        policies: [spec],
        resolveCredential: async () => secret,
      });
      try {
        expect(await runner.call(call, binding, allow)).toMatchObject({
          ok: false,
          refusal: "service_response_invalid",
        });
      } finally {
        runner.close();
      }
    }
  } finally {
    await server.stop(true);
  }
});

test("authorization concurrency is bounded, cancellation releases capacity, and close aborts waiters", async () => {
  const entered = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<boolean>();
  const runner = createJobServiceRunner({ policies: [policy("https://example.invalid")] });
  const controller = new AbortController();
  try {
    const first = runner.call(
      call,
      binding,
      async () => {
        entered.resolve();
        return pending.promise;
      },
      controller.signal,
    );
    await entered.promise;
    expect(await runner.call(call, binding, allow)).toMatchObject({ refusal: "service_busy" });
    controller.abort();
    expect(await first).toMatchObject({ refusal: "service_cancelled" });
    const nextEntered = Promise.withResolvers<void>();
    const next = runner.call(call, binding, async () => {
      nextEntered.resolve();
      return pending.promise;
    });
    await nextEntered.promise;
    runner.close();
    expect(await next).toMatchObject({ refusal: "service_closed" });
    expect(await runner.call(call, binding, allow)).toMatchObject({ refusal: "service_closed" });
  } finally {
    pending.resolve(false);
    runner.close();
  }
});

test("timeouts include authority waits and callback exception text is never reflected", async () => {
  const spec = policy("https://example.invalid");
  spec.operations.read!.timeoutMs = 10;
  const pending = Promise.withResolvers<boolean>();
  const runner = createJobServiceRunner({ policies: [spec] });
  try {
    expect(await runner.call(call, binding, () => pending.promise)).toMatchObject({
      refusal: "service_timeout",
    });
    expect(
      await runner.call(call, binding, async () => {
        throw new Error("private-callback-material");
      }),
    ).toEqual({
      type: "service_result",
      requestId: call.requestId,
      ok: false,
      refusal: "service_unauthorized",
    });
  } finally {
    pending.resolve(false);
    runner.close();
  }
});

test("held credential reads remain positional, bounded and owner-private without closing borrowed descriptors", async () => {
  const path = mkdtempSync(join(tmpdir(), "service-credential-"));
  writeFileSync(join(path, "key"), "test-only-key\n", { mode: 0o600 });
  const directory = HeldDirectory.openAbsolute(path, { private: true });
  const fd = directory.openFile("key");
  const resolver = heldServiceCredentialResolver(new Map([["key", fd]]));
  const signal = new AbortController().signal;
  try {
    expect(await resolver("key", signal)).toBe("test-only-key");
    expect(await resolver("key", signal)).toBe("test-only-key");
    await expect(resolver("../key", signal)).rejects.toThrow("service_credential_unavailable");
    chmodSync(join(path, "key"), 0o644);
    await expect(resolver("key", signal)).rejects.toThrow("service_credential_unavailable");
    chmodSync(join(path, "key"), 0o600);
    writeFileSync(join(path, "key"), "x".repeat(16385));
    await expect(resolver("key", signal)).rejects.toThrow("service_credential_unavailable");
    writeFileSync(join(path, "key"), "test-only-key");
    rmSync(join(path, "key"));
    await expect(resolver("key", signal)).rejects.toThrow("service_credential_unavailable");
  } finally {
    closeSync(fd);
    directory.close();
    rmSync(path, { recursive: true, force: true });
  }
});

test("cancellation tears down an active HTTP body and releases service capacity", async () => {
  const entered = Promise.withResolvers<void>();
  let stalled = true;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      if (!stalled) return Response.json({ items: [] });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"items":['));
            entered.resolve();
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const runner = createJobServiceRunner({ policies: [policy(server.url.origin)] });
  const controller = new AbortController();
  try {
    const response = runner.call(call, binding, allow, controller.signal);
    await entered.promise;
    controller.abort();
    expect(await response).toMatchObject({ refusal: "service_cancelled" });
    stalled = false;
    expect(await runner.call(call, binding, allow)).toMatchObject({
      ok: true,
      result: { items: [] },
    });
  } finally {
    runner.close();
    await server.stop(true);
  }
});

test("explicit full disclosure returns JSON or encoded bytes, still enforcing the result budget", async () => {
  let bytes = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return bytes
        ? new Response(new Uint8Array([0, 255, 42]))
        : Response.json({ value: { allowed: true } });
    },
  });
  try {
    for (const kind of ["json", "bytes"] as const) {
      bytes = kind === "bytes";
      const spec = policy(server.url.origin);
      spec.operations.read!.response = { kind, disclosure: "full" };
      const runner = createJobServiceRunner({ policies: [spec] });
      try {
        expect(await runner.call(call, binding, allow)).toMatchObject({
          ok: true,
          result: bytes ? { encoding: "base64", data: "AP8q" } : { value: { allowed: true } },
        });
      } finally {
        runner.close();
      }
      if (!("kind" in spec.operations.read!)) spec.operations.read!.maxResultBytes = 1;
      const limited = createJobServiceRunner({ policies: [spec] });
      try {
        expect(await limited.call(call, binding, allow)).toMatchObject({
          refusal: "service_response_limit",
        });
      } finally {
        limited.close();
      }
    }
  } finally {
    await server.stop(true);
  }
});

function bodyPolicy(origin: string): ServicePolicy {
  const spec = policy(origin);
  spec.credential = { ref: "header-source", header: "Authorization", prefix: "Bearer " };
  spec.operations.enroll = {
    ...(spec.operations.read as ServiceOperationPolicy),
    method: "POST",
    path: "/credential",
    invocable: true,
    body: [
      { path: ["credential", "type"], value: { literal: "api_key" } },
      { path: ["credential", "key"], value: { credentialRef: "body-source" } },
      { path: ["copy"], value: { credentialRef: "body-source" } },
    ],
  };
  return spec;
}
const bodyBinding: ServiceBinding = { ...binding, operationIds: ["enroll"] };
const bodyCall: ServiceCall = { ...call, operationId: "enroll" };

test("static body sources are resolved once after authority and never enter caller input or projected results", async () => {
  const sources = new Map([
    ["header-source", "header-private"],
    ["body-source", 'body-"private\\key'],
  ]);
  const observed: unknown[] = [];
  const resolved: string[] = [];
  let echo = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      observed.push({
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      return Response.json({
        items: [{ id: echo ? sources.get("body-source") : "account", enabled: true }],
        key: sources.get("body-source"),
      });
    },
  });
  const runner = createJobServiceRunner({
    policies: [bodyPolicy(server.url.origin)],
    resolveCredential: async (ref) => {
      resolved.push(ref);
      return sources.get(ref)!;
    },
  });
  let authorized = 0;
  try {
    const authorize = async (request: { input: unknown }) => {
      expect(request.input).toEqual({});
      authorized++;
      if (authorized === 1) expect(resolved).toEqual([]);
      return true;
    };
    expect(await runner.call(bodyCall, bodyBinding, authorize)).toMatchObject({
      ok: true,
      result: { items: [{ id: "account", enabled: true }] },
    });
    expect(resolved).toEqual(["header-source", "body-source"]);
    expect(observed).toEqual([
      {
        authorization: "Bearer header-private",
        body: {
          credential: { type: "api_key", key: sources.get("body-source") },
          copy: sources.get("body-source"),
        },
      },
    ]);
    echo = true;
    const reply = await runner.call(bodyCall, bodyBinding, allow);
    expect(reply).toMatchObject({ ok: false, refusal: "service_response_invalid" });
    expect(JSON.stringify(reply)).not.toContain("private");
  } finally {
    runner.close();
    await server.stop(true);
  }
});

test("invalid caller input cannot authorize or resolve body sources and unresolved sources never reach upstream", async () => {
  let upstream = 0;
  let resolved = 0;
  let authorized = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      upstream++;
      return Response.json({ items: [] });
    },
  });
  const spec = bodyPolicy(server.url.origin);
  delete spec.credential;
  const runner = createJobServiceRunner({
    policies: [spec],
    resolveCredential: async () => {
      resolved++;
      throw new Error("private-resolver-diagnostic");
    },
  });
  try {
    const authorize = async () => {
      authorized++;
      return true;
    };
    expect(
      await runner.call(
        { ...bodyCall, input: { credentialRef: "caller-selected" } },
        bodyBinding,
        authorize,
      ),
    ).toMatchObject({ refusal: "service_input_invalid" });
    expect(authorized).toBe(0);
    expect(resolved).toBe(0);
    const reply = await runner.call(bodyCall, bodyBinding, authorize);
    expect(reply).toEqual({
      type: "service_result",
      requestId: call.requestId,
      ok: false,
      refusal: "service_credential_unavailable",
    });
    expect(JSON.stringify(reply)).not.toContain("private");
    expect(upstream).toBe(0);
  } finally {
    runner.close();
    await server.stop(true);
  }
});

test("revocation during body source resolution prevents transport", async () => {
  let granted = true;
  let upstream = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      upstream++;
      return Response.json({ items: [] });
    },
  });
  const spec = bodyPolicy(server.url.origin);
  delete spec.credential;
  const runner = createJobServiceRunner({
    policies: [spec],
    resolveCredential: async () => {
      granted = false;
      return "private-body-source";
    },
  });
  try {
    expect(await runner.call(bodyCall, bodyBinding, async () => granted)).toMatchObject({
      refusal: "service_unauthorized",
    });
    expect(upstream).toBe(0);
  } finally {
    runner.close();
    await server.stop(true);
  }
});

test("cancellation and deadlines include body source reads even when a resolver ignores the signal", async () => {
  for (const mode of ["cancel", "timeout"] as const) {
    const entered = Promise.withResolvers<AbortSignal>();
    const pending = Promise.withResolvers<string>();
    const spec = bodyPolicy("https://example.invalid");
    delete spec.credential;
    spec.operations.enroll!.timeoutMs = mode === "timeout" ? 20 : 1000;
    const runner = createJobServiceRunner({
      policies: [spec],
      resolveCredential: (_ref, signal) => {
        entered.resolve(signal);
        return pending.promise;
      },
    });
    const controller = new AbortController();
    try {
      const reply = runner.call(bodyCall, bodyBinding, allow, controller.signal);
      const sourceSignal = await entered.promise;
      if (mode === "cancel") controller.abort();
      expect(await reply).toMatchObject({
        refusal: mode === "cancel" ? "service_cancelled" : "service_timeout",
      });
      expect(sourceSignal.aborted).toBe(true);
    } finally {
      pending.resolve("private-late-source");
      runner.close();
    }
  }
});

test("body sources and escaped aggregate request bytes are bounded before upstream transport", async () => {
  let upstream = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      upstream++;
      return Response.json({ items: [] });
    },
  });
  try {
    for (const source of ["", "bad\nsource", "x".repeat(16385)]) {
      const spec = bodyPolicy(server.url.origin);
      delete spec.credential;
      const runner = createJobServiceRunner({
        policies: [spec],
        resolveCredential: async () => source,
      });
      try {
        expect(await runner.call(bodyCall, bodyBinding, allow)).toMatchObject({
          refusal: "service_credential_unavailable",
        });
      } finally {
        runner.close();
      }
    }
    const secret = '"'.repeat(32);
    const spec = bodyPolicy(server.url.origin);
    delete spec.credential;
    const bytes = Buffer.byteLength(
      "/credential" +
        JSON.stringify({
          credential: { type: "api_key", key: secret },
          copy: secret,
        }),
    );
    for (const limit of [bytes - 1, bytes]) {
      spec.operations.enroll!.maxRequestBytes = limit;
      const runner = createJobServiceRunner({
        policies: [spec],
        resolveCredential: async () => secret,
      });
      try {
        expect(await runner.call(bodyCall, bodyBinding, allow)).toMatchObject(
          limit === bytes ? { ok: true } : { refusal: "service_input_invalid" },
        );
      } finally {
        runner.close();
      }
    }
    expect(upstream).toBe(1);
  } finally {
    await server.stop(true);
  }
});

test("owner resource reconciliation degrades only operations using unavailable or wrong-origin body sources", () => {
  const spec = bodyPolicy("https://example.invalid");
  let references: ServiceCredentialReference[] = [
    { ref: "header-source", origins: [spec.origin!], available: true },
    { ref: "body-source", origins: [spec.origin!], available: true },
  ];
  const resources = new JobResources({
    anchors: {},
    runtimeTools: {},
    services: [spec],
    credentialReferences: () => references,
  });
  const fingerprint = resources.snapshot().services[spec.serviceId];
  expect(resources.snapshot().serviceDefinitions[spec.serviceId]!.operationIds).toEqual([
    "enroll",
    "read",
  ]);
  for (const source of [
    undefined,
    { ref: "body-source", origins: [spec.origin!], available: false },
    { ref: "body-source", origins: ["https://other.invalid"], available: true },
  ]) {
    references = [references[0]!, ...(source ? [source] : [])];
    resources.refresh({ tools: [], anchors: [], services: [spec.serviceId] });
    expect(resources.snapshot().services[spec.serviceId]).toBe(fingerprint);
    expect(resources.snapshot().serviceDefinitions[spec.serviceId]!.operationIds).toEqual(["read"]);
  }
  references.push({ ref: "body-source", origins: [spec.origin!], available: true });
  resources.refresh({ tools: [], anchors: [], services: [spec.serviceId] });
  expect(resources.snapshot().serviceDefinitions[spec.serviceId]!.operationIds).toEqual([
    "enroll",
    "read",
  ]);
  references[0]!.available = false;
  resources.refresh({ tools: [], anchors: [], services: [spec.serviceId] });
  expect(resources.snapshot().services[spec.serviceId]).toBeUndefined();
});
