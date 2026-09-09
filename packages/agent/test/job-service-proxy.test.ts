import { expect, test } from "bun:test";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { finished } from "node:stream/promises";
import type { Socket } from "node:net";
import type {
  ServiceBinding,
  ServicePolicy,
  ServiceProxyOperationPolicy,
} from "@manifold/protocol";
import { createJobServiceProxy, type JobServiceProxy } from "../src/job-service-proxy.ts";
import { createJobServiceRunner } from "../src/job-services.ts";
import { connectWorkloadLoopback } from "../src/job-listener-proof.ts";

const binding: ServiceBinding = {
  serviceId: "gateway",
  revision: "r1",
  operationIds: ["generate"],
};
function policy(
  origin: string,
  operation: Partial<ServiceProxyOperationPolicy> = {},
): ServicePolicy {
  return {
    serviceId: "gateway",
    revision: "r1",
    origin,
    allowLoopbackHttp: true,
    maxConcurrent: 1,
    credential: { ref: "owner-key", header: "Authorization", prefix: "Bearer " },
    operations: {
      generate: {
        kind: "http-proxy",
        method: "POST",
        path: "/v1/generate",
        request: { kind: "json", disclosure: "full" },
        response: {
          kind: "stream",
          disclosure: "full",
          contentTypes: ["application/json", "text/event-stream"],
          headers: ["retry-after", "x-request-id"],
        },
        timeoutMs: 2000,
        maxRequestBytes: 4096,
        maxResponseBytes: 4096,
        ...operation,
      },
    },
  };
}
async function upstream(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
) {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => response.destroy());
  });
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
async function send(
  proxy: JobServiceProxy,
  options: {
    path?: string;
    method?: string;
    bearer?: string | null;
    headers?: Record<string, string | string[]>;
    body?: string;
  } = {},
) {
  const result = Promise.withResolvers<{ status: number; body: string }>();
  const request = httpRequest(
    proxy.url,
    {
      path: options.path ?? "/v1/generate",
      method: options.method ?? "POST",
      agent: false,
      headers: {
        "content-type": "application/json",
        ...(options.bearer === null
          ? {}
          : { authorization: `Bearer ${options.bearer ?? proxy.bearer}` }),
        ...options.headers,
      },
    },
    (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("error", result.reject);
      response.once("end", () =>
        result.resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }),
      );
    },
  );
  request.once("error", result.reject);
  request.end(options.body ?? "{}");
  return result.promise;
}
const secret = "zz-owner-secret";

test.each(["live", "lost"] as const)(
  "runtime proxy uses only its exact proved %s connection without redialing",
  async (state) => {
    let connections = 0;
    let applicationBytes = 0;
    let peer: Socket | undefined;
    let proved: Socket | undefined;
    let provedPort: number | undefined;
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const bytes of request) body += bytes.toString();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        port: request.socket.remotePort,
        authorized: request.headers.authorization === `Bearer ${"x".repeat(32)}`,
        body,
      }));
    });
    server.on("connection", (socket) => {
      connections++;
      peer = socket;
      socket.on("data", (bytes: Buffer) => { applicationBytes += bytes.length; });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing runtime port");
    const lifetime = new AbortController();
    const { origin: _origin, allowLoopbackHttp: _loopback, credential: _credential, ...spec } =
      policy(`http://127.0.0.1:${address.port}`);
    const proxy = await createJobServiceProxy({
      policies: [{
        ...spec,
        runtime: {
          pluginId: "fixture", operationId: "serve", installationRevision: "r1",
          artifactSha256: "a".repeat(64), resourceBindingDigest: "b".repeat(64), input: {},
        },
      }],
      bindings: [binding],
      authorize: async () => {
        // Revoke the actual connection after ownership proof but before HTTP handoff.
        if (state === "lost") proved?.destroy();
        return true;
      },
      resolveRuntime: async (_policy, signal) => {
        proved = await connectWorkloadLoopback(address.port, (socket) =>
          peer?.remoteAddress === socket.localAddress &&
          peer?.remotePort === socket.localPort &&
          peer?.localAddress === socket.remoteAddress &&
          peer?.localPort === socket.remotePort,
        signal);
        provedPort = proved.localPort;
        return {
          url: `http://127.0.0.1:${address.port}`,
          bearer: "x".repeat(32), signal: lifetime.signal, socket: proved,
        };
      },
    });
    try {
      const result = await send(proxy, { body: '{"probe":true}' });
      if (state === "live") {
        expect(result.status).toBe(200);
        expect(JSON.parse(result.body)).toEqual({
          port: provedPort, authorized: true, body: '{"probe":true}',
        });
      } else {
        expect(result.status).toBe(503);
        expect(applicationBytes).toBe(0);
      }
      expect(connections).toBe(1);
    } finally {
      lifetime.abort();
      await proxy.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test("fixed route streams before completion with owner-only credentials and no forwarded authority headers", async () => {
  const release = Promise.withResolvers<void>();
  const observed = Promise.withResolvers<{
    authorization: string | undefined;
    target: string | string[] | undefined;
    body: string;
  }>();
  const server = await upstream(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    observed.resolve({
      authorization: request.headers.authorization,
      target: request.headers["x-upstream-url"],
      body: Buffer.concat(chunks).toString(),
    });
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "set-cookie": "owner=private",
      authorization: `Bearer ${secret}`,
      "x-request-id": secret,
    });
    response.write("data: 123\n\n");
    await release.promise;
    response.end("data: 456\n\n");
  });
  const spec = policy(server.origin);
  const proxy = await createJobServiceProxy({
    policies: [spec],
    bindings: [binding],
    resolveCredential: async () => secret,
    authorize: async () => true,
  });
  try {
    expect(new URL(proxy.url).hostname).toBe("127.0.0.1");
    expect(proxy.bearer).not.toBe(secret);
    // Mutating owner input after construction cannot change the captured route or origin.
    spec.origin = "https://other.invalid";
    spec.operations.generate!.path = "/other";
    const response = await fetch(`${proxy.url}/v1/generate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${proxy.bearer}`,
        "content-type": "application/json",
        "x-upstream-url": "https://other.invalid",
      },
      body: '{"stream":true}',
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: 123\n\n");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("authorization")).toBeNull();
    expect(response.headers.get("x-request-id")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await observed.promise).toEqual({
      authorization: `Bearer ${secret}`,
      target: undefined,
      body: '{"stream":true}',
    });
    release.resolve();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: 456\n\n");
    expect((await reader.read()).done).toBe(true);
  } finally {
    release.resolve();
    await proxy.close();
    await server.close();
  }
});

test("capability, exact method/path, query, traversal, origin and request bounds reject before native authority or upstream", async () => {
  let hits = 0;
  let authorized = 0;
  const server = await upstream((_request, response) => {
    hits++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const proxy = await createJobServiceProxy({
    policies: [policy(server.origin)],
    bindings: [binding],
    resolveCredential: async () => secret,
    authorize: async () => {
      authorized++;
      return true;
    },
  });
  try {
    expect((await send(proxy, { bearer: null })).status).toBe(401);
    expect((await send(proxy, { bearer: "incorrect" })).status).toBe(401);
    for (const path of [
      "/other",
      "/v1/generate?url=https://other.invalid",
      "/v1/../v1/generate",
      "/v1/%67enerate",
      "http://other.invalid/v1/generate",
      "//v1/generate",
    ])
      expect((await send(proxy, { path })).status).toBe(404);
    expect((await send(proxy, { method: "GET" })).status).toBe(404);
    expect((await send(proxy, { headers: { origin: "https://other.invalid" } })).status).toBe(400);
    expect((await send(proxy, { headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect(
      (await send(proxy, { headers: { "content-length": "5000" }, body: "x".repeat(5000) })).status,
    ).toBe(413);
    expect(authorized).toBe(0);
    expect(hits).toBe(0);
  } finally {
    await proxy.close();
    await server.close();
  }
});

test("stale or ambiguous bindings fail startup, and normal request/reply cannot invoke proxy operations", async () => {
  const spec = policy("https://example.invalid");
  await expect(
    createJobServiceProxy({
      policies: [spec],
      bindings: [{ ...binding, revision: "r2" }],
      authorize: async () => true,
    }),
  ).rejects.toThrow("service_binding_mismatch");
  await expect(
    createJobServiceProxy({
      policies: [spec],
      bindings: [{ ...binding, operationIds: ["unknown"] }],
      authorize: async () => true,
    }),
  ).rejects.toThrow("service_binding_mismatch");
  const duplicate = { ...spec, serviceId: "duplicate" };
  await expect(
    createJobServiceProxy({
      policies: [spec, duplicate],
      bindings: [binding, { ...binding, serviceId: "duplicate" }],
      authorize: async () => true,
    }),
  ).rejects.toThrow("service_policy_invalid");
  const runner = createJobServiceRunner({ policies: [spec] });
  try {
    const reply = await runner.call(
      {
        type: "service",
        requestId: "r",
        serviceId: binding.serviceId,
        operationId: "generate",
        input: {},
      },
      binding,
      async () => {
        throw new Error("must not authorize");
      },
    );
    expect(reply).toMatchObject({ ok: false, refusal: "service_operation_unknown" });
  } finally {
    runner.close();
  }
});

test("every call checks current authority and rechecks revocation after credential resolution", async () => {
  let hits = 0;
  let granted = false;
  let resolved = 0;
  const server = await upstream((_request, response) => {
    hits++;
    response.end();
  });
  const proxy = await createJobServiceProxy({
    policies: [policy(server.origin)],
    bindings: [binding],
    authorize: async (authority) => {
      expect(authority).toEqual({
        serviceId: "gateway",
        revision: "r1",
        operationId: "generate",
        input: {},
      });
      return granted;
    },
    resolveCredential: async () => {
      resolved++;
      granted = false;
      return secret;
    },
  });
  try {
    expect((await send(proxy)).status).toBe(403);
    expect(resolved).toBe(0);
    granted = true;
    expect((await send(proxy)).status).toBe(403);
    expect(resolved).toBe(1);
    expect(hits).toBe(0);
  } finally {
    await proxy.close();
    await server.close();
  }
});

test("full-disclosure application errors preserve status/body but redirects and unsafe encodings never cross", async () => {
  let mode = "error";
  let hits = 0;
  const server = await upstream(async (request, response) => {
    await finished(request.resume());
    hits++;
    if (mode === "redirect") {
      response.writeHead(307, { location: "/escape", "content-type": "application/json" });
      response.end("private redirect");
    } else if (mode === "encoding") {
      response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      response.end("private compression");
    } else if (mode === "mime") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("private markup");
    } else {
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "2",
        connection: "x-request-id",
        "x-request-id": "hop-only",
        "set-cookie": "session=private",
      });
      response.end('{"error":"quota"}');
    }
  });
  const proxy = await createJobServiceProxy({
    policies: [policy(server.origin)],
    bindings: [binding],
    authorize: async () => true,
    resolveCredential: async () => secret,
  });
  try {
    const response = await fetch(`${proxy.url}/v1/generate`, {
      method: "POST",
      headers: { authorization: `Bearer ${proxy.bearer}`, "content-type": "application/json" },
      body: "{}",
    });
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
  } finally {
    await proxy.close();
    await server.close();
  }
});

test("split source credential echoes terminate streaming without disclosing the held suffix", async () => {
  for (const echoed of [
    secret,
    secret
      .split("")
      .map((character) => `\\u00${character.charCodeAt(0).toString(16)}`)
      .join(""),
  ]) {
    const release = Promise.withResolvers<void>();
    const midpoint = Math.floor(echoed.length / 2);
    const server = await upstream(async (request, response) => {
      await finished(request.resume());
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`OK:${echoed.slice(0, midpoint)}`);
      await release.promise;
      response.end(echoed.slice(midpoint));
    });
    const proxy = await createJobServiceProxy({
      policies: [policy(server.origin)],
      bindings: [binding],
      authorize: async () => true,
      resolveCredential: async () => secret,
    });
    try {
      const response = await fetch(`${proxy.url}/v1/generate`, {
        method: "POST",
        headers: { authorization: `Bearer ${proxy.bearer}`, "content-type": "application/json" },
        body: "{}",
      });
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("OK:");
      release.resolve();
      await expect(reader.read()).rejects.toThrow();
    } finally {
      release.resolve();
      await proxy.close();
      await server.close();
    }
  }
});

test("concurrency is bounded while authorization waits and owner cancellation releases ignored callbacks", async () => {
  const entered = Promise.withResolvers<void>();
  const permission = Promise.withResolvers<boolean>();
  const abort = new AbortController();
  let hits = 0;
  const server = await upstream((_request, response) => {
    hits++;
    response.end();
  });
  const proxy = await createJobServiceProxy({
    policies: [policy(server.origin)],
    bindings: [binding],
    signal: abort.signal,
    authorize: async () => {
      entered.resolve();
      return permission.promise;
    },
  });
  try {
    const pending = send(proxy).then(
      () => "response",
      () => "disconnected",
    );
    await entered.promise;
    expect((await send(proxy)).status).toBe(429);
    abort.abort();
    await pending;
    await proxy.close();
    await expect(send(proxy)).rejects.toThrow();
    expect(hits).toBe(0);
  } finally {
    permission.resolve(true);
    await proxy.close();
    await server.close();
  }
});

test("deadline bounds a resolver that ignores cancellation without exposing raw errors", async () => {
  const spec = policy("https://example.invalid");
  spec.operations.generate!.timeoutMs = 20;
  const credential = Promise.withResolvers<string>();
  const proxy = await createJobServiceProxy({
    policies: [spec],
    bindings: [binding],
    authorize: async () => true,
    resolveCredential: async () => credential.promise,
  });
  try {
    const response = await send(proxy);
    expect(response).toEqual({ status: 503, body: '{"error":"service_timeout"}' });
  } finally {
    credential.reject(new Error(`private ${secret}`));
    await proxy.close();
  }
});

test("client disconnect and explicit close cancel active upstream streams", async () => {
  for (const action of ["disconnect", "close"] as const) {
    const cancelled = Promise.withResolvers<void>();
    const server = await upstream(async (request, response) => {
      await finished(request.resume());
      response.once("close", cancelled.resolve);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: 123\n\n");
    });
    const proxy = await createJobServiceProxy({
      policies: [policy(server.origin)],
      bindings: [binding],
      authorize: async () => true,
      resolveCredential: async () => secret,
    });
    try {
      const response = await fetch(`${proxy.url}/v1/generate`, {
        method: "POST",
        headers: { authorization: `Bearer ${proxy.bearer}`, "content-type": "application/json" },
        body: "{}",
      });
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: 123\n\n");
      if (action === "disconnect") await reader.cancel();
      else {
        await proxy.close();
        await expect(reader.read()).rejects.toThrow();
      }
      await cancelled.promise;
    } finally {
      await proxy.close();
      await server.close();
    }
  }
});

test("declared response byte limit terminates an unbounded chunked stream", async () => {
  const release = Promise.withResolvers<void>();
  const server = await upstream(async (request, response) => {
    await finished(request.resume());
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: 123\n\n");
    await release.promise;
    response.end("x".repeat(5000));
  });
  const proxy = await createJobServiceProxy({
    policies: [policy(server.origin)],
    bindings: [binding],
    authorize: async () => true,
    resolveCredential: async () => secret,
  });
  try {
    const response = await fetch(`${proxy.url}/v1/generate`, {
      method: "POST",
      headers: { authorization: `Bearer ${proxy.bearer}`, "content-type": "application/json" },
      body: "{}",
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: 123\n\n");
    release.resolve();
    await expect(reader.read()).rejects.toThrow();
  } finally {
    release.resolve();
    await proxy.close();
    await server.close();
  }
});

test("declared SDK paths and scalar queries are canonical and authorize only validated parameters", async () => {
  const requests: { url: string | undefined; authorization: string | undefined; body: string }[] =
    [];
  const authorities: unknown[] = [];
  const server = await upstream(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString(),
    });
    response.writeHead(202, { "content-type": "application/json" });
    response.end('{"accepted":true}');
  });
  const spec = policy(server.origin, {
    path: "/v1/credential/{id}/block",
    pathParameters: { id: { format: "positive-integer", maxBytes: 4 } },
    query: {
      wait: { type: "number", required: true, min: 0, max: 30000, integer: true },
      provider: { type: "string", required: false, maxBytes: 16, enum: ["openai", "azure ai"] },
      active: { type: "boolean", required: false },
    },
  });
  const proxy = await createJobServiceProxy({
    policies: [spec],
    bindings: [binding],
    resolveCredential: async () => secret,
    authorize: async (authority) => {
      authorities.push(authority);
      return true;
    },
  });
  try {
    expect(
      await send(proxy, {
        path: "/v1/credential/42/block?active=false&provider=azure%20ai&wait=3e4",
        body: '{"private":"application-data"}',
      }),
    ).toEqual({ status: 202, body: '{"accepted":true}' });
    expect(requests).toEqual([
      {
        url: "/v1/credential/42/block?wait=30000&provider=azure+ai&active=false",
        authorization: `Bearer ${secret}`,
        body: '{"private":"application-data"}',
      },
    ]);
    expect(authorities).toEqual(
      Array.from({ length: 2 }, () => ({
        serviceId: "gateway",
        revision: "r1",
        operationId: "generate",
        input: { id: 42, wait: 30000, provider: "azure ai", active: false },
      })),
    );
    expect(await send(proxy, { path: "/v1/credential/7/block?wait=0" })).toMatchObject({
      status: 202,
    });
    expect(requests[1]!.url).toBe("/v1/credential/7/block?wait=0");
  } finally {
    await proxy.close();
    await server.close();
  }
});

test("path traversal, aliases and invalid query scalars cannot reach authority or credentials", async () => {
  let authorized = 0;
  let resolved = 0;
  const proxy = await createJobServiceProxy({
    policies: [
      policy("https://example.invalid", {
        path: "/v1/credential/{id}/block",
        pathParameters: { id: { format: "positive-integer", maxBytes: 4 } },
        query: {
          wait: { type: "number", required: true, min: 0, max: 30000, integer: true },
          provider: { type: "string", required: false, maxBytes: 6, enum: ["openai"] },
          active: { type: "boolean", required: false },
        },
      }),
    ],
    bindings: [binding],
    authorize: async () => {
      authorized++;
      return true;
    },
    resolveCredential: async () => {
      resolved++;
      return secret;
    },
  });
  try {
    for (const id of [
      "0",
      "-1",
      "01",
      "1.0",
      "10000",
      "%31",
      ".",
      "..",
      "%2E%2E",
      "1%2F2",
      "1%5C2",
      "%252F",
      "%",
      "1;2",
    ]) {
      expect((await send(proxy, { path: `/v1/credential/${id}/block?wait=0` })).status).toBe(404);
    }
    for (const query of [
      "",
      "?wait=0&wait=1",
      "?%77ait=0",
      "?wait=%",
      "?wait=%C0%AF",
      "?wait=30001",
      "?wait=-1",
      "?wait=0.5",
      "?wait=NaN",
      "?wait=Infinity",
      "?wait=01",
      "?wait=+1",
      "?wait=0&provider=anthropic",
      "?wait=0&provider=%00",
      "?wait=0&active=1",
      "?wait=0&url=https://other.invalid",
      "?wait=0&",
      "?wait",
    ])
      expect((await send(proxy, { path: `/v1/credential/1/block${query}` })).status).toBe(400);
    expect(
      (await send(proxy, { path: "/v1/credential/1/block?wait=0", bearer: null })).status,
    ).toBe(401);
    expect(authorized).toBe(0);
    expect(resolved).toBe(0);
  } finally {
    await proxy.close();
  }
});

test("component parameters accept one safe encoding and reject separator and dot aliases", async () => {
  const seen: unknown[] = [];
  const proxy = await createJobServiceProxy({
    policies: [
      policy("https://example.invalid", {
        path: "/v1/provider/{provider}",
        pathParameters: { provider: { format: "component", maxBytes: 20 } },
      }),
    ],
    bindings: [binding],
    authorize: async ({ input }) => {
      seen.push(input);
      return false;
    },
  });
  try {
    expect((await send(proxy, { path: "/v1/provider/openai%3Awork" })).status).toBe(403);
    expect(seen).toEqual([{ provider: "openai:work" }]);
    for (const component of [
      "openai:work",
      "openai%3awork",
      "%6Fpenai",
      ".",
      "%2E",
      "..",
      "%2e%2e",
      "a%2Fb",
      "a%5Cb",
      "%252f",
      "a".repeat(21),
      "a%00b",
    ])
      expect((await send(proxy, { path: `/v1/provider/${component}` })).status).toBe(404);
    expect(seen).toEqual([{ provider: "openai:work" }]);
  } finally {
    await proxy.close();
  }
});

test("overlapping static and parameter routes fail construction in either order", async () => {
  const make = (path: string, pathParameters?: ServiceProxyOperationPolicy["pathParameters"]) =>
    policy("https://example.invalid", { path, pathParameters });
  const cases = [
    [make("/v1/{id}", { id: { format: "positive-integer", maxBytes: 4 } }), make("/v1/12")],
    [
      make("/v1/{id}", { id: { format: "positive-integer", maxBytes: 4 } }),
      make("/v1/{key}", { key: { format: "component", maxBytes: 4 } }),
    ],
    [
      make("/{a}/x", { a: { format: "component", maxBytes: 4 } }),
      make("/v1/{b}", { b: { format: "component", maxBytes: 4 } }),
    ],
  ];
  for (const pair of cases) {
    const specs = [pair[0]!, { ...pair[1]!, serviceId: "other" }];
    const bindings = [binding, { ...binding, serviceId: "other" }];
    for (const order of [bindings, [...bindings].reverse()])
      await expect(
        createJobServiceProxy({ policies: specs, bindings: order, authorize: async () => true }),
      ).rejects.toThrow("service_policy_invalid");
  }
  for (const spec of [
    make("/v1/{id}"),
    make("/v1/fixed", { id: { format: "component", maxBytes: 4 } }),
    make("/v1/{id}/{id}", { id: { format: "component", maxBytes: 4 } }),
    policy("https://example.invalid", {
      path: "/v1/{id}",
      pathParameters: { id: { format: "positive-integer", maxBytes: 4 } },
      query: { id: { type: "boolean", required: false } },
    }),
  ])
    await expect(
      createJobServiceProxy({ policies: [spec], bindings: [binding], authorize: async () => true }),
    ).rejects.toThrow("service_policy_invalid");
  // A numeric parameter cannot swallow the useful fixed snapshot route.
  const proxy = await createJobServiceProxy({
    policies: [
      make("/v1/{id}", { id: { format: "positive-integer", maxBytes: 4 } }),
      { ...make("/v1/snapshot"), serviceId: "other" },
    ],
    bindings: [binding, { ...binding, serviceId: "other" }],
    authorize: async () => false,
  });
  try {
    expect((await send(proxy, { path: "/v1/123" })).status).toBe(403);
    expect((await send(proxy, { path: "/v1/snapshot" })).status).toBe(403);
  } finally {
    await proxy.close();
  }
});

test("parameterized requests recheck current authority without opaque body authority bypass", async () => {
  let allowed = true;
  let resolved = 0;
  const seen: unknown[] = [];
  const proxy = await createJobServiceProxy({
    policies: [
      policy("https://example.invalid", {
        path: "/v1/credential/{id}/disable",
        pathParameters: { id: { format: "positive-integer", maxBytes: 4 } },
      }),
    ],
    bindings: [binding],
    authorize: async (authority) => {
      seen.push(authority.input);
      return allowed && authority.input.id === 42;
    },
    resolveCredential: async () => {
      resolved++;
      allowed = false;
      return secret;
    },
  });
  try {
    expect(
      (await send(proxy, { path: "/v1/credential/7/disable", body: '{"id":42}' })).status,
    ).toBe(403);
    expect(resolved).toBe(0);
    expect(
      (await send(proxy, { path: "/v1/credential/42/disable", body: '{"id":7,"secret":"opaque"}' }))
        .status,
    ).toBe(403);
    expect(seen).toEqual([{ id: 7 }, { id: 42 }, { id: 42 }]);
    expect(resolved).toBe(1);
  } finally {
    await proxy.close();
  }
});

test("declarative application headers enforce literals and bounded caller values before authority or upstream I/O", async () => {
  let authorized = 0;
  let resolved = 0;
  const observed: unknown[] = [];
  const server = await upstream(async (request, response) => {
    await finished(request.resume());
    observed.push({
      version: request.headers["x-inventory-version"],
      region: request.headers["x-inventory-region"],
      cursor: request.headers["x-inventory-cursor"],
      extra: request.headers["x-extra"],
      authorization: request.headers.authorization,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const proxy = await createJobServiceProxy({
    policies: [
      policy(server.origin, {
        requestHeaders: {
          "x-inventory-version": { kind: "literal", value: "inventory-v2" },
          "x-inventory-region": {
            kind: "forward",
            maxBytes: 4,
            required: true,
            enum: ["west", "east"],
          },
          "x-inventory-cursor": { kind: "forward", maxBytes: 8, required: false },
        },
      }),
    ],
    bindings: [binding],
    authorize: async () => {
      authorized++;
      return true;
    },
    resolveCredential: async () => {
      resolved++;
      return secret;
    },
  });
  try {
    const invalid: Record<string, string | string[]>[] = [
      {},
      { "x-inventory-region": "north" },
      { "x-inventory-region": "west", "x-inventory-version": "inventory-v3" },
      { "x-inventory-region": "west", "x-inventory-cursor": "123456789" },
      { "x-inventory-region": "west", "x-inventory-cursor": "bad\tvalue" },
      { "x-inventory-region": "west", "x-inventory-cursor": "caf\xe9" },
      { "x-inventory-region": ["west", "west"] },
      { "x-inventory-region": ["west", "east"] },
      { "x-inventory-region": "west", "x-inventory-version": ["inventory-v2", "inventory-v2"] },
      { "x-inventory-region": "west", connection: "keep-alive, X-Inventory-Region" },
      { "x-inventory-region": "west", connection: "x-inventory-version" },
      { "x-inventory-region": "west", connection: "authorization" },
      {
        "x-inventory-region": "west",
        authorization: [`Bearer ${proxy.bearer}`, `Bearer ${proxy.bearer}`],
      },
    ];
    for (const headers of invalid) expect((await send(proxy, { headers })).status).toBe(400);
    expect(authorized).toBe(0);
    expect(resolved).toBe(0);
    expect(observed).toEqual([]);
    expect(
      (await send(proxy, { headers: { "x-inventory-region": "west", "x-extra": "discard" } }))
        .status,
    ).toBe(200);
    expect(
      (
        await send(proxy, {
          headers: {
            "x-inventory-region": "east",
            "x-inventory-version": "inventory-v2",
            "x-inventory-cursor": "12345678",
          },
        })
      ).status,
    ).toBe(200);
    expect(observed).toEqual([
      {
        version: "inventory-v2",
        region: "west",
        cursor: undefined,
        extra: undefined,
        authorization: `Bearer ${secret}`,
      },
      {
        version: "inventory-v2",
        region: "east",
        cursor: "12345678",
        extra: undefined,
        authorization: `Bearer ${secret}`,
      },
    ]);
  } finally {
    await proxy.close();
    await server.close();
  }
});

test("source credential headers cannot collide with policy data or be injected by the caller", async () => {
  let hits = 0;
  let authorized = 0;
  const server = await upstream((_request, response) => {
    hits++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const spec = policy(server.origin);
  spec.credential = { ref: "owner-key", header: "X-Inventory-Key", prefix: "" };
  const operation = spec.operations.generate!;
  if (!("kind" in operation)) throw new Error("Expected proxy policy");
  try {
    for (const field of [
      { kind: "literal" as const, value: "injected" },
      { kind: "forward" as const, maxBytes: 32, required: false },
    ]) {
      const collision = {
        ...spec,
        operations: {
          generate: {
            ...operation,
            requestHeaders: { "x-inventory-key": field },
          },
        },
      };
      await expect(
        createJobServiceProxy({
          policies: [collision],
          bindings: [binding],
          authorize: async () => {
            authorized++;
            return true;
          },
        }),
      ).rejects.toThrow("service_policy_invalid");
    }
    const proxy = await createJobServiceProxy({
      policies: [spec],
      bindings: [binding],
      resolveCredential: async () => secret,
      authorize: async () => {
        authorized++;
        return true;
      },
    });
    try {
      expect((await send(proxy, { headers: { "x-inventory-key": "injected" } })).status).toBe(400);
      expect((await send(proxy, { headers: { connection: "x-inventory-key" } })).status).toBe(400);
      expect(authorized).toBe(0);
      expect(hits).toBe(0);
    } finally {
      await proxy.close();
    }
  } finally {
    await server.close();
  }
});

test("conditional HTTP forwards opaque validators and preserves only safe bodyless 304 metadata", async () => {
  let status = 304;
  let etag = 'W/"inventory-revision-a7"';
  const observed: unknown[] = [];
  const server = await upstream((request, response) => {
    observed.push({
      validator: request.headers["if-none-match"],
      extra: request.headers["last-event-id"],
    });
    response.writeHead(status, {
      etag,
      location: "https://other.invalid",
      "set-cookie": "private",
      authorization: secret,
    });
    response.end();
  });
  const proxy = await createJobServiceProxy({
    policies: [
      policy(server.origin, {
        method: "GET",
        path: "/v1/snapshot",
        request: { kind: "none" },
        requestHeaders: { "if-none-match": { kind: "forward", maxBytes: 128, required: false } },
        response: {
          kind: "stream",
          disclosure: "full",
          contentTypes: ["application/json"],
          headers: ["etag"],
        },
      }),
    ],
    bindings: [binding],
    authorize: async () => true,
    resolveCredential: async () => secret,
  });
  try {
    const headers = {
      authorization: `Bearer ${proxy.bearer}`,
      "if-none-match": 'W/"inventory-revision-a6", "opaque"',
      "last-event-id": "discard",
    };
    const response = await fetch(`${proxy.url}/v1/snapshot`, { headers });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("etag")).toBe(etag);
    for (const name of ["location", "set-cookie", "authorization", "access-control-allow-origin"])
      expect(response.headers.get(name)).toBeNull();
    expect(
      (
        await send(proxy, {
          path: "/v1/snapshot",
          method: "GET",
          body: "",
          headers: { "if-none-match": "*" },
        })
      ).status,
    ).toBe(304);
    expect(observed).toEqual([
      { validator: 'W/"inventory-revision-a6", "opaque"', extra: undefined },
      { validator: "*", extra: undefined },
    ]);
    for (const invalid of [
      { "if-none-match": ['"one"', '"two"'] },
      { "if-none-match": "x".repeat(129) },
      { "if-none-match": '"one"', connection: "if-none-match" },
    ])
      expect(
        (await send(proxy, { path: "/v1/snapshot", method: "GET", body: "", headers: invalid }))
          .status,
      ).toBe(400);
    expect(observed).toHaveLength(2);
    etag = secret;
    expect((await fetch(`${proxy.url}/v1/snapshot`, { headers })).headers.get("etag")).toBeNull();
    status = 302;
    expect((await fetch(`${proxy.url}/v1/snapshot`, { headers })).status).toBe(502);
    status = 304;
    expect((await send(proxy, { path: "/v1/snapshot", method: "GET", body: "" })).status).toBe(502);
  } finally {
    await proxy.close();
    await server.close();
  }
});
