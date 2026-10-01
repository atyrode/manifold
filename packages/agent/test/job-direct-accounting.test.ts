import { expect, test } from "bun:test";
import {
  NativeServiceReplySchema,
  quoteDirectService,
  type ServiceCall,
  type ServiceDirectAccounting,
  type ServiceOperationPolicy,
  type ServicePolicy,
} from "@manifold/protocol";
import { createJobServiceRunner } from "../src/job-services.ts";

function policy(origin: string): ServicePolicy {
  return {
    serviceId: "inference",
    revision: "r1",
    origin,
    allowLoopbackHttp: true,
    maxConcurrent: 2,
    directCostCeilingMicros: 1000,
    prices: {
      models: {
        "fixed-model": {
          inputPerMillion: 1_000_000,
          outputPerMillion: 2_000_000,
          cachedInputPerMillion: 500_000,
          contextTokens: 100,
        },
      },
    },
    operations: {
      complete: {
        method: "POST",
        invocable: true,
        path: "/complete",
        meter: { kind: "openai-usage", modelId: "fixed-model" },
        input: { prompt: { type: "string", required: true, maxBytes: 128 } },
        query: {},
        body: [
          { path: ["model"], value: { literal: "fixed-model" } },
          { path: ["messages", 0, "role"], value: { literal: "user" } },
          { path: ["messages", 0, "content"], value: { input: "prompt" } },
          { path: ["stream"], value: { literal: false } },
        ],
        timeoutMs: 5000,
        maxRequestBytes: 1024,
        maxResponseBytes: 4096,
        maxResultBytes: 1024,
        response: { kind: "projected-json", fields: [["answer"]], maxArrayItems: 1 },
      },
    },
  };
}
const call: ServiceCall = {
  type: "service",
  requestId: "request-1",
  serviceId: "inference",
  operationId: "complete",
  input: { prompt: "private input" },
};
const binding = { serviceId: "inference", revision: "r1", operationIds: ["complete"] };
const accounting: ServiceDirectAccounting = {
  callId: "call-1",
  maxCostMicros: 300,
  reservedMicros: 300,
};
const usage = {
  prompt_tokens: 20,
  completion_tokens: 5,
  prompt_tokens_details: { cached_tokens: 10 },
};
const answer = { model: "fixed-model", answer: "public answer", usage, private: "not disclosed" };

test("a fractional positive direct charge cannot settle as free exposure", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.json({
        model: "fixed-model",
        answer: "visible",
        usage: { input_tokens: 1, output_tokens: 0 },
      });
    },
  });
  const spec = policy(server.url.origin);
  spec.prices!.models["fixed-model"] = {
    inputPerMillion: 100_000,
    outputPerMillion: 0,
    contextTokens: 10,
  };
  const runner = createJobServiceRunner({ policies: [spec] });
  try {
    expect(quoteDirectService(spec, "complete")).toEqual({
      ok: true,
      modelId: "fixed-model",
      reservedMicros: 1,
    });
    expect(
      await runner.call(call, binding, async () => true, undefined, {
        callId: "fractional",
        maxCostMicros: 1,
        reservedMicros: 1,
      }),
    ).toMatchObject({
      ok: true,
      charge: { status: "known", costMicros: 1 },
    });
  } finally {
    runner.close();
    await server.stop(true);
  }
});

test("owner meters raw usage before projection, including charged HTTP failure and rejected projection", async () => {
  const observed: unknown[] = [];
  let status = 200;
  let body: unknown = answer;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      observed.push(await request.json());
      return Response.json(body, { status });
    },
  });
  const spec = policy(server.url.origin);
  spec.credential = { ref: "fixture-key", header: "Authorization", prefix: "Bearer " };
  const runner = createJobServiceRunner({
    policies: [spec],
    resolveCredential: async () => "synthetic-provider-key",
  });
  let authorizations = 0;
  const allow = async () => {
    authorizations++;
    return true;
  };
  try {
    expect(quoteDirectService(spec, "complete")).toEqual({
      ok: true,
      modelId: "fixed-model",
      reservedMicros: 300,
    });
    const result = await runner.call(call, binding, allow, undefined, accounting);
    expect(NativeServiceReplySchema.parse(result)).toEqual({
      type: "service_result",
      requestId: "request-1",
      ok: true,
      result: { answer: "public answer" },
      charge: { callId: "call-1", reservedMicros: 300, status: "known", costMicros: 25 },
    });
    expect(observed).toEqual([
      {
        model: "fixed-model",
        messages: [{ role: "user", content: "private input" }],
        stream: false,
      },
    ]);
    // Source rotation rechecks authority; this must not become a second reservation or call.
    expect(authorizations).toBe(2);
    status = 402;
    expect(await runner.call(call, binding, allow, undefined, accounting)).toEqual({
      type: "service_result",
      requestId: "request-1",
      ok: false,
      refusal: "service_upstream_refused",
      charge: { callId: "call-1", reservedMicros: 300, status: "known", costMicros: 25 },
    });
    status = 200;
    body = { ...answer, status: "failed", error: { code: "charged-failure" } };
    expect(await runner.call(call, binding, allow, undefined, accounting)).toMatchObject({
      ok: false,
      refusal: "service_upstream_refused",
      charge: { status: "known", costMicros: 25 },
    });
    body = { ...answer, answer: { secret: "not a scalar projection" } };
    expect(await runner.call(call, binding, allow, undefined, accounting)).toMatchObject({
      ok: false,
      refusal: "service_response_invalid",
      charge: { status: "known", costMicros: 25 },
    });
  } finally {
    runner.close();
    await server.stop(true);
  }
});

test("quote, lowered ceiling, trusted reservation and shape refusals precede authorization and upstream", async () => {
  let requests = 0;
  let authorizations = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return Response.json(answer);
    },
  });
  const cases: {
    change?(spec: ServicePolicy): void;
    context?: ServiceDirectAccounting;
    refusal: string;
  }[] = [
    {
      change(spec) {
        delete spec.prices;
      },
      refusal: "service_price_unknown",
    },
    {
      change(spec) {
        delete spec.prices!.models["fixed-model"]!.contextTokens;
      },
      refusal: "service_accounting_bound_unknown",
    },
    {
      change(spec) {
        (spec.operations.complete as ServiceOperationPolicy).body[0] = {
          path: ["model"],
          value: { input: "prompt" },
        };
      },
      refusal: "service_accounting_unsupported",
    },
    {
      change(spec) {
        (spec.operations.complete as ServiceOperationPolicy).body[3] = {
          path: ["stream"],
          value: { literal: true },
        };
      },
      refusal: "service_accounting_unsupported",
    },
    {
      change(spec) {
        (spec.operations.complete as ServiceOperationPolicy).body.push({
          path: ["n"],
          value: { literal: 2 },
        });
      },
      refusal: "service_accounting_unsupported",
    },
    { context: { ...accounting, maxCostMicros: 299 }, refusal: "service_ceiling_exceeded" },
    { context: { ...accounting, reservedMicros: 299 }, refusal: "service_accounting_mismatch" },
  ];
  try {
    for (const entry of cases) {
      const spec = policy(server.url.origin);
      entry.change?.(spec);
      const runner = createJobServiceRunner({ policies: [spec] });
      try {
        expect(
          await runner.call(
            call,
            binding,
            async () => {
              authorizations++;
              return true;
            },
            undefined,
            entry.context ?? accounting,
          ),
        ).toMatchObject({
          ok: false,
          refusal: entry.refusal,
          charge: { status: "not_dispatched", costMicros: 0 },
        });
      } finally {
        runner.close();
      }
    }
    expect(authorizations).toBe(0);
    expect(requests).toBe(0);
    const runner = createJobServiceRunner({ policies: [policy(server.url.origin)] });
    try {
      expect(
        await runner.call(call, binding, async () => false, undefined, accounting),
      ).toMatchObject({
        ok: false,
        refusal: "service_unauthorized",
        charge: { status: "not_dispatched", costMicros: 0 },
      });
      expect(requests).toBe(0);
      const credentialPolicy = policy(server.url.origin);
      credentialPolicy.credential = {
        ref: "absent-key",
        header: "Authorization",
        prefix: "Bearer ",
      };
      runner.configure([credentialPolicy]);
      expect(
        await runner.call(call, binding, async () => true, undefined, accounting),
      ).toMatchObject({
        ok: false,
        refusal: "service_credential_unavailable",
        charge: { status: "not_dispatched", costMicros: 0 },
      });
      expect(requests).toBe(0);
    } finally {
      runner.close();
    }
  } finally {
    await server.stop(true);
  }
});

test("explicit installed zero pricing yields known zero only after readable usage", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.json(answer);
    },
  });
  const spec = policy(server.url.origin);
  spec.directCostCeilingMicros = 0;
  spec.prices!.models["fixed-model"] = {
    inputPerMillion: 0,
    outputPerMillion: 0,
    contextTokens: 100,
  };
  const runner = createJobServiceRunner({ policies: [spec] });
  try {
    expect(
      await runner.call(call, binding, async () => true, undefined, {
        callId: "free",
        maxCostMicros: 0,
        reservedMicros: 0,
      }),
    ).toMatchObject({ ok: true, charge: { status: "known", costMicros: 0 } });
  } finally {
    runner.close();
    await server.stop(true);
  }
});

test("unreadable, mismatched, out-of-context and missing failure usage remain unknown, never free", async () => {
  let response = Response.json(answer);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return response;
    },
  });
  const runner = createJobServiceRunner({ policies: [policy(server.url.origin)] });
  const responses = [
    Response.json({ answer: "missing usage" }),
    Response.json({ ...answer, model: "unreviewed-model" }),
    Response.json({ ...answer, usage: { ...usage, prompt_tokens: 101 } }),
    Response.json({ ...answer, usage: { ...usage, completion_tokens: 101 } }),
    Response.json({ ...answer, usage: { ...usage, prompt_tokens_details: { cached_tokens: 21 } } }),
    Response.json({ error: "failed without a bill" }, { status: 503 }),
    new Response('{"usage":', { headers: { "content-type": "application/json" } }),
    new Response(`data: ${JSON.stringify(answer)}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    }),
  ];
  try {
    for (response of responses) {
      const result = await runner.call(call, binding, async () => true, undefined, accounting);
      expect(result.ok).toBe(false);
      expect(result.charge).toEqual({
        callId: "call-1",
        reservedMicros: 300,
        status: "unknown",
        costMicros: null,
      });
    }
  } finally {
    runner.close();
    await server.stop(true);
  }
});

test("native pi terminal failures retain fresh, cache-read, cache-write and output charges", async () => {
  const observed: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      observed.push(await request.json());
      return Response.json({
        type: "error",
        error: { errorStatus: 429, usage: { input: 10, output: 4, cacheRead: 6, cacheWrite: 2 } },
      });
    },
  });
  const spec = policy(server.url.origin);
  const op = spec.operations.complete as ServiceOperationPolicy;
  op.meter = { kind: "pi-native-usage", modelId: "fixed-model" };
  op.body = [
    { path: ["modelId"], value: { literal: "fixed-model" } },
    { path: ["context", "messages", 0, "role"], value: { literal: "user" } },
    { path: ["context", "messages", 0, "content"], value: { input: "prompt" } },
    { path: ["context", "messages", 0, "timestamp"], value: { literal: 0 } },
  ];
  const runner = createJobServiceRunner({ policies: [spec] });
  try {
    expect(await runner.call(call, binding, async () => true, undefined, accounting)).toMatchObject(
      {
        ok: false,
        refusal: "service_upstream_refused",
        charge: { status: "known", costMicros: 23 },
      },
    );
    expect(observed).toEqual([
      {
        modelId: "fixed-model",
        context: { messages: [{ role: "user", content: "private input", timestamp: 0 }] },
      },
    ]);
  } finally {
    runner.close();
    await server.stop(true);
  }
});

test("cancelled, timed-out and owner-authority-lost requests preserve unknown exposure", async () => {
  let entered = Promise.withResolvers<void>();
  let release = Promise.withResolvers<Response>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      entered.resolve();
      return release.promise;
    },
  });
  try {
    for (const mode of ["cancel", "timeout", "owner-lost"] as const) {
      entered = Promise.withResolvers<void>();
      release = Promise.withResolvers<Response>();
      const spec = policy(server.url.origin);
      if (mode === "timeout") (spec.operations.complete as ServiceOperationPolicy).timeoutMs = 100;
      const runner = createJobServiceRunner({ policies: [spec] });
      const cancelled = new AbortController();
      try {
        const pending = runner.call(call, binding, async () => true, cancelled.signal, accounting);
        await entered.promise;
        if (mode === "cancel") cancelled.abort();
        if (mode === "owner-lost") runner.close();
        expect(await pending).toMatchObject({
          ok: false,
          refusal:
            mode === "timeout"
              ? "service_timeout"
              : mode === "owner-lost"
                ? "service_closed"
                : "service_cancelled",
          charge: { status: "unknown", costMicros: null },
        });
      } finally {
        release.resolve(Response.json(answer));
        runner.close();
      }
    }
  } finally {
    await server.stop(true);
  }
});

test("worker envelopes cannot opt into accounting and ordinary direct calls keep their result shape", async () => {
  let requests = 0;
  let authorizations = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return Response.json(answer);
    },
  });
  const runner = createJobServiceRunner({ policies: [policy(server.url.origin)] });
  const allow = async () => {
    authorizations++;
    return true;
  };
  try {
    const forged = { ...call, accounting };
    expect(await runner.call(forged, binding, allow)).toEqual({
      type: "service_result",
      requestId: "invalid",
      ok: false,
      refusal: "service_invalid_request",
    });
    expect(authorizations).toBe(0);
    expect(requests).toBe(0);
    expect(await runner.call(call, binding, allow)).toEqual({
      type: "service_result",
      requestId: "request-1",
      ok: true,
      result: { answer: "public answer" },
    });
    expect(requests).toBe(1);
  } finally {
    runner.close();
    await server.stop(true);
  }
});

test("generic fixed-model JSON calls meter whole-request usage before projecting typed answers", async () => {
  const observed: unknown[] = [];
  let raw = {
    model: "fixed-model",
    answers: { quality: { score: 0.8, private: "hidden" } },
    usage: { input_tokens: 17, output_tokens: 1000 },
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      observed.push(await request.json());
      return Response.json(raw);
    },
  });
  const spec = policy(server.url.origin);
  spec.prices!.models["fixed-model"] = {
    inputPerMillion: 2_000_000,
    outputPerMillion: 0,
    contextTokens: 100,
  };
  const op = spec.operations.complete as ServiceOperationPolicy;
  op.meter = { kind: "json-usage", modelId: "fixed-model" };
  op.input = {
    state: { type: "string", required: true, maxBytes: 128 },
    question: { type: "string", required: true, maxBytes: 128 },
  };
  op.body = [
    { path: ["model"], value: { literal: "fixed-model" } },
    { path: ["state"], value: { input: "state" } },
    { path: ["questions", "quality", "type"], value: { literal: "score" } },
    { path: ["questions", "quality", "instructions"], value: { input: "question" } },
    { path: ["questions", "quality", "criteria", 0], value: { literal: "low" } },
    { path: ["questions", "quality", "criteria", 1], value: { literal: "high" } },
  ];
  op.response = {
    kind: "projected-json",
    fields: [["answers", "quality", "score"]],
    maxArrayItems: 1,
  };
  const request = { ...call, input: { state: "private state", question: "Assess quality" } };
  const context = { ...accounting, maxCostMicros: 200, reservedMicros: 200 };
  const runner = createJobServiceRunner({ policies: [spec] });
  let authorizations = 0;
  const allow = async () => {
    authorizations++;
    return true;
  };
  try {
    expect(await runner.call(request, binding, allow, undefined, context)).toEqual({
      type: "service_result",
      requestId: "request-1",
      ok: true,
      result: { answers: { quality: { score: 0.8 } } },
      charge: { callId: "call-1", reservedMicros: 200, status: "known", costMicros: 34 },
    });
    expect(observed).toEqual([
      {
        model: "fixed-model",
        state: "private state",
        questions: {
          quality: { type: "score", instructions: "Assess quality", criteria: ["low", "high"] },
        },
      },
    ]);
    for (const [path, literal] of [
      [["stream"], true],
      [["n"], 2],
      [["models", 0], "another-model"],
      [["batch", 0], "member"],
      [["endpoint"], "https://another.invalid"],
    ] as const) {
      const rejected = structuredClone(spec);
      (rejected.operations.complete as ServiceOperationPolicy).body.push({
        path: [...path],
        value: { literal },
      });
      runner.configure([rejected]);
      expect(await runner.call(request, binding, allow, undefined, context)).toMatchObject({
        ok: false,
        refusal: "service_accounting_unsupported",
        charge: { status: "not_dispatched", costMicros: 0 },
      });
    }
    expect(authorizations).toBe(1);
    expect(observed).toHaveLength(1);
    runner.configure([spec]);
    raw = { ...raw, usage: { input_tokens: 101, output_tokens: 0 } };
    expect(await runner.call(request, binding, allow, undefined, context)).toMatchObject({
      ok: false,
      refusal: "service_accounting_violation",
      charge: { status: "unknown", costMicros: null },
    });
  } finally {
    runner.close();
    await server.stop(true);
  }
});
