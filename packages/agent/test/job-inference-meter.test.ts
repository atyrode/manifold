import { expect, test } from "bun:test";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  JobEventSchema,
  type ServiceBinding,
  type ServicePolicy,
  type ServiceProxyOperationPolicy,
} from "@manifold/protocol";
import {
  createJobServiceProxy,
  type JobInferenceCallReport,
  type JobInferenceCeilingReport,
  type JobInferenceLimits,
  type JobInferenceMetering,
  type JobInferenceUsage,
  type JobServiceProxy,
} from "../src/job-service-proxy.ts";

const secret = "zz-provider-key";
const binding: ServiceBinding = {
  serviceId: "atyrode.babel.inference",
  revision: "1",
  operationIds: ["chat", "responses", "embed"],
};
const priced: NonNullable<ServicePolicy["prices"]> = {
  models: { "m-1": { inputPerMillion: 3000000, outputPerMillion: 15000000 } },
};
const chat: ServiceProxyOperationPolicy = {
  kind: "http-proxy",
  method: "POST",
  path: "/v1/chat/completions",
  request: { kind: "json", disclosure: "full" },
  response: {
    kind: "stream",
    disclosure: "full",
    contentTypes: ["application/json", "text/event-stream"],
    headers: [],
  },
  meter: { kind: "openai-usage" },
  timeoutMs: 5000,
  maxRequestBytes: 65536,
  maxResponseBytes: 65536,
};
const { meter: metered, ...unmetered } = chat;
void metered;
function policy(origin: string, prices = priced): ServicePolicy {
  return {
    serviceId: binding.serviceId,
    revision: binding.revision,
    origin,
    allowLoopbackHttp: true,
    maxConcurrent: 4,
    credential: { ref: "owner-key", header: "Authorization", prefix: "Bearer " },
    prices,
    operations: {
      chat,
      responses: { ...chat, path: "/v1/responses" },
      embed: { ...unmetered, path: "/v1/embeddings" },
    },
  };
}
async function upstream(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    body: string,
  ) => void | Promise<void>,
) {
  let calls = 0;
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    calls++;
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString();
      bodies.push(body);
      await handler(request, response, body);
    })().catch(() => response.destroy());
  });
  const ready = Promise.withResolvers<void>();
  server.once("error", ready.reject);
  server.listen(0, "127.0.0.1", ready.resolve);
  await ready.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing loopback address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    bodies,
    get calls() {
      return calls;
    },
    async close() {
      const stopped = Promise.withResolvers<void>();
      server.close(() => stopped.resolve());
      server.closeAllConnections();
      await stopped.promise;
    },
  };
}
/** Flushed one piece at a time so the meter's framing meets split and joined chunks. */
async function writeFlushed(response: ServerResponse, piece: string): Promise<void> {
  const written = Promise.withResolvers<void>();
  response.write(piece, () => written.resolve());
  await written.promise;
}
async function send(
  proxy: JobServiceProxy,
  options: { path?: string; body?: string } = {},
): Promise<{ status: number; body: string }> {
  const result = Promise.withResolvers<{ status: number; body: string }>();
  const request = httpRequest(
    proxy.url,
    {
      path: options.path ?? "/v1/chat/completions",
      method: "POST",
      agent: false,
      headers: { "content-type": "application/json", authorization: `Bearer ${proxy.bearer}` },
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
  request.end(options.body ?? '{"model":"m-1"}');
  return result.promise;
}
/** The owner's half of the contract: the totals are the job's, updated from every call. */
function ledger(limits?: JobInferenceLimits) {
  const usage: JobInferenceUsage = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costMicros: 0,
  };
  const calls: JobInferenceCallReport[] = [];
  const ceilings: JobInferenceCeilingReport[] = [];
  let tail = Promise.resolve();
  let valid = true;
  const metering: JobInferenceMetering = {
    limits,
    usage: () => usage,
    async enter() {
      const turn = Promise.withResolvers<void>();
      const previous = tail;
      tail = turn.promise;
      await previous;
      return turn.resolve;
    },
    valid: () => valid,
    onInvalidUsage() {
      valid = false;
    },
    onInferenceCall(call) {
      calls.push(call);
      usage.calls++;
      usage.inputTokens += call.inputTokens;
      usage.outputTokens += call.outputTokens;
      usage.cachedInputTokens += call.cachedInputTokens;
      usage.costMicros += call.costMicros;
    },
    onInferenceCeiling(refusal) {
      ceilings.push(refusal);
    },
  };
  return { usage, calls, ceilings, metering };
}
async function proxyFor(
  origin: string,
  metering: JobInferenceMetering,
  prices = priced,
): Promise<JobServiceProxy> {
  return createJobServiceProxy({
    policies: [policy(origin, prices)],
    bindings: [binding],
    resolveCredential: async () => secret,
    authorize: async () => true,
    inference: metering,
  });
}

test("a chat completion is metered and priced from the provider's own usage, byte for byte", async () => {
  const answer = JSON.stringify({
    id: "chatcmpl-1",
    model: "m-1",
    choices: [{ message: { content: "hello" } }],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 500,
      prompt_tokens_details: { cached_tokens: 400 },
    },
  });
  const source = await upstream((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(answer);
  });
  const owner = ledger();
  const proxy = await proxyFor(source.origin, owner.metering);
  try {
    const asked = '{"model":"m-1","messages":[{"role":"user","content":"hi"}]}';
    const response = await send(proxy, { body: asked });
    expect(response.status).toBe(200);
    expect(response.body).toBe(answer);
    expect(source.bodies).toEqual([asked]);
    expect(owner.calls).toHaveLength(1);
    expect(owner.calls[0]).toMatchObject({
      serviceId: binding.serviceId,
      operationId: "chat",
      model: "m-1",
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 400,
      // 1000 input at $3/M with no cached price, 500 output at $15/M.
      costMicros: 10500,
      status: 200,
    });
    // What the owner sends: its job facts and the proxy's report, admitted as one event.
    expect(
      JobEventSchema.safeParse({
        type: "inference_call",
        jobId: "job-1",
        requestDigest: "b".repeat(64),
        ownerId: "owner-1",
        ownerGeneration: 3,
        ...owner.calls[0],
      }).success,
    ).toBe(true);
    expect(owner.usage).toEqual({
      calls: 1,
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 400,
      costMicros: 10500,
    });
    expect(owner.ceilings).toEqual([]);
  } finally {
    await proxy.close();
    await source.close();
  }
});

test("cached input is charged at the cached price when the policy states one", async () => {
  const source = await upstream((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        model: "m-1",
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 500,
          prompt_tokens_details: { cached_tokens: 400 },
        },
      }),
    );
  });
  const owner = ledger();
  const proxy = await proxyFor(source.origin, owner.metering, {
    models: {
      "m-1": {
        inputPerMillion: 3000000,
        outputPerMillion: 15000000,
        cachedInputPerMillion: 300000,
      },
    },
  });
  try {
    expect((await send(proxy)).status).toBe(200);
    // 600 fresh at $3/M, 400 cached at $0.30/M, 500 output at $15/M.
    expect(owner.calls[0]?.costMicros).toBe(9420);
  } finally {
    await proxy.close();
    await source.close();
  }
});

test("a streamed chat completion is made to report usage, and every frame reaches the caller unchanged", async () => {
  const frames = [
    'data: {"model":"m-1","choices":[{"delta":{"content":"he"}}],"usage":null}\n\n',
    'data: {"model":"m-1","choices":[{"delta":{"content":"llo"}}],"usage":null}\n\n',
    'data: {"model":"m-1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\n',
    "data: [DONE]\n\n",
  ];
  const source = await upstream(async (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const frame of frames) {
      // Split every frame across two writes: a usage frame that arrives in pieces is
      // the ordinary case, not the exception.
      await writeFlushed(response, frame.slice(0, 12));
      await writeFlushed(response, frame.slice(12));
    }
    response.end();
  });
  const owner = ledger();
  const proxy = await proxyFor(source.origin, owner.metering);
  try {
    const asked =
      '{"model":"m-1","messages":[{"role":"user","content":"hi"}],"stream":true,"stream_options":{"include_usage":false}}';
    const response = await send(proxy, { body: asked });
    expect(response.status).toBe(200);
    expect(response.body).toBe(frames.join(""));
    expect(JSON.parse(source.bodies[0]!)).toEqual({
      model: "m-1",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(owner.calls).toHaveLength(1);
    expect(owner.calls[0]).toMatchObject({
      model: "m-1",
      inputTokens: 10,
      outputTokens: 20,
      cachedInputTokens: 0,
      costMicros: 330,
      status: 200,
    });
  } finally {
    await proxy.close();
    await source.close();
  }
});

test("the responses API is metered under its own spelling, whole or streamed", async () => {
  const completed = `event: response.completed\ndata: ${JSON.stringify({
    type: "response.completed",
    response: {
      model: "m-1",
      usage: { input_tokens: 40, output_tokens: 8, input_tokens_details: { cached_tokens: 10 } },
    },
  })}\n\n`;
  const source = await upstream(async (_request, response, body) => {
    if (JSON.parse(body).stream === true) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      await writeFlushed(response, 'data: {"type":"response.output_text.delta","delta":"hi"}\n\n');
      response.end(completed);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        model: "m-1",
        usage: { input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 50 } },
      }),
    );
  });
  const owner = ledger();
  const proxy = await proxyFor(source.origin, owner.metering);
  try {
    expect((await send(proxy, { path: "/v1/responses" })).status).toBe(200);
    // A responses body carries no `messages` and takes no `stream_options`: it is forwarded
    // byte for byte, and its usage arrives in `response.completed` regardless.
    const asked = '{"model":"m-1","input":"hi","stream":true}';
    const streamed = await send(proxy, { path: "/v1/responses", body: asked });
    expect(source.bodies[1]).toBe(asked);
    expect(streamed.status).toBe(200);
    expect(streamed.body).toContain(completed);
    expect(
      owner.calls.map((call) => [call.operationId, call.inputTokens, call.outputTokens]),
    ).toEqual([
      ["responses", 100, 7],
      ["responses", 40, 8],
    ]);
    expect(owner.usage).toEqual({
      calls: 2,
      inputTokens: 140,
      outputTokens: 15,
      cachedInputTokens: 60,
      costMicros: 405 + 240,
    });
  } finally {
    await proxy.close();
    await source.close();
  }
});

test("the call that reaches the calls ceiling is refused before the provider is dialed", async () => {
  const source = await upstream((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"model":"m-1","usage":{"prompt_tokens":2,"completion_tokens":3}}');
  });
  const owner = ledger({ calls: 1 });
  const proxy = await proxyFor(source.origin, owner.metering);
  try {
    expect((await send(proxy)).status).toBe(200);
    const refused = await send(proxy);
    expect(refused.status).toBe(429);
    expect(JSON.parse(refused.body)).toEqual({
      error: { code: "service_ceiling_exceeded", ceiling: "calls" },
    });
    expect(source.calls).toBe(1);
    expect(owner.calls).toHaveLength(1);
    expect(owner.ceilings).toEqual([
      {
        serviceId: binding.serviceId,
        operationId: "chat",
        ceiling: "calls",
        reached: {
          calls: 1,
          inputTokens: 2,
          outputTokens: 3,
          cachedInputTokens: 0,
          costMicros: 51,
        },
      },
    ]);
  } finally {
    await proxy.close();
    await source.close();
  }
});

test("concurrent calls share one ceiling snapshot and only one reaches the provider", async () => {
  const firstAtProvider = Promise.withResolvers<void>();
  const releaseProvider = Promise.withResolvers<void>();
  const source = await upstream(async (_request, response) => {
    firstAtProvider.resolve();
    await releaseProvider.promise;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"model":"m-1","usage":{"prompt_tokens":2,"completion_tokens":3}}');
  });
  const owner = ledger({ calls: 1 });
  const originalEnter = owner.metering.enter.bind(owner.metering);
  const secondAtGate = Promise.withResolvers<void>();
  let entries = 0;
  owner.metering.enter = async () => {
    entries += 1;
    if (entries === 2) secondAtGate.resolve();
    return originalEnter();
  };
  const proxy = await proxyFor(source.origin, owner.metering);
  try {
    const first = send(proxy);
    await firstAtProvider.promise;
    const second = send(proxy);
    await secondAtGate.promise;
    releaseProvider.resolve();
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 429]);
    expect(source.calls).toBe(1);
    expect(owner.calls).toHaveLength(1);
    expect(owner.ceilings).toHaveLength(1);
  } finally {
    releaseProvider.resolve();
    await proxy.close();
    await source.close();
  }
});

test("the call that crosses a cost ceiling completes in full, and it is the last one", async () => {
  const answer = '{"model":"m-1","usage":{"prompt_tokens":1000,"completion_tokens":1000}}';
  const source = await upstream((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(answer);
  });
  const owner = ledger({ costMicros: 5000 });
  const proxy = await proxyFor(source.origin, owner.metering);
  try {
    const crossing = await send(proxy);
    expect(crossing.status).toBe(200);
    expect(crossing.body).toBe(answer);
    expect(owner.usage.costMicros).toBe(18000);
    const refused = await send(proxy);
    expect(refused.status).toBe(429);
    expect(JSON.parse(refused.body).error.ceiling).toBe("costMicros");
    expect(source.calls).toBe(1);
    expect(owner.ceilings).toHaveLength(1);
  } finally {
    await proxy.close();
    await source.close();
  }
});

test("an unpriced model is refused under a cost ceiling and costs nothing without one", async () => {
  const source = await upstream((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"model":"m-9","usage":{"prompt_tokens":11,"completion_tokens":22}}');
  });
  const bounded = ledger({ costMicros: 1000 });
  const guarded = await proxyFor(source.origin, bounded.metering);
  const open = ledger({ calls: 4 });
  const proxy = await proxyFor(source.origin, open.metering);
  try {
    const refused = await send(guarded, { body: '{"model":"m-9"}' });
    expect(refused.status).toBe(422);
    expect(JSON.parse(refused.body)).toEqual({
      error: { code: "service_price_unknown", model: "m-9" },
    });
    expect(source.calls).toBe(0);
    expect(bounded.calls).toEqual([]);
    expect(bounded.ceilings).toEqual([]);
    const allowed = await send(proxy, { body: '{"model":"m-9"}' });
    expect(allowed.status).toBe(200);
    expect(open.calls[0]).toMatchObject({ model: "m-9", inputTokens: 11, costMicros: 0 });
  } finally {
    await guarded.close();
    await proxy.close();
    await source.close();
  }
});

test("a 2xx whose usage cannot be read ends the caller's stream and is still a call", async () => {
  const source = await upstream((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"model":"m-1","choices":[]}');
  });
  const owner = ledger();
  const proxy = await proxyFor(source.origin, owner.metering);
  try {
    const truncated = await send(proxy).catch((error: unknown) => error);
    expect(truncated).toBeInstanceOf(Error);
    expect(owner.calls).toHaveLength(1);
    expect(owner.calls[0]).toMatchObject({
      model: "m-1",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costMicros: 0,
      status: 200,
    });
    const refused = await send(proxy);
    expect(refused.status).toBe(502);
    expect(JSON.parse(refused.body)).toEqual({ error: "service_response_invalid" });
    expect(source.calls).toBe(1);
    expect(owner.calls).toHaveLength(1);
  } finally {
    await proxy.close();
    await source.close();
  }
});

test("an upstream refusal counts as a call with no tokens", async () => {
  const source = await upstream((_request, response) => {
    response.writeHead(429, { "content-type": "application/json" });
    response.end('{"error":{"message":"slow down"}}');
  });
  const owner = ledger();
  const proxy = await proxyFor(source.origin, owner.metering);
  try {
    const response = await send(proxy);
    expect(response.status).toBe(429);
    expect(JSON.parse(response.body).error.message).toBe("slow down");
    expect(owner.calls[0]).toMatchObject({
      model: "m-1",
      inputTokens: 0,
      costMicros: 0,
      status: 429,
    });
    expect(owner.usage.calls).toBe(1);
  } finally {
    await proxy.close();
    await source.close();
  }
});

test("an operation without a meter is forwarded untouched and reports nothing", async () => {
  const source = await upstream((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"data":[]}');
  });
  const owner = ledger({ calls: 1 });
  const proxy = await proxyFor(source.origin, owner.metering);
  try {
    const asked = '{"input":"no model here","stream":true}';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await send(proxy, { path: "/v1/embeddings", body: asked });
      expect(response.status).toBe(200);
      expect(response.body).toBe('{"data":[]}');
    }
    expect(source.bodies).toEqual([asked, asked]);
    expect(owner.calls).toEqual([]);
    expect(owner.ceilings).toEqual([]);
  } finally {
    await proxy.close();
    await source.close();
  }
});
