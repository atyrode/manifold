import { expect, test } from "bun:test";
import {
  ServiceCallSchema,
  ServiceInvokeArgsSchema,
  ServiceReadArgsSchema,
  ServiceReplySchema,
  NativeServiceReplySchema,
  ServiceChargeSchema,
  ServiceAccountingReceiptSchema,
  ServicePolicySchema,
  type ServiceOperationPolicy,
  type ServicePolicy,
} from "../src/services.ts";
import {
  InstanceServiceInvokeArgsSchema,
  InstanceServiceReadArgsSchema,
} from "../src/instance-services.ts";
import {
  JobCommandSchema,
  JobEventSchema,
  jobOwnerSupports,
  servicePolicyProtocolRefusal,
} from "../src/jobs.ts";
import {
  quoteDirectService,
  directServiceUsage,
  readServiceUsage,
  serviceCallCost,
} from "../src/service-metering.ts";
import { PROTOCOL_VERSION } from "../src/version.ts";

function operation(): ServiceOperationPolicy {
  return {
    method: "POST",
    invocable: true,
    path: "/complete",
    meter: { kind: "openai-usage", modelId: "fixed-model" },
    input: { prompt: { type: "string", required: true, maxBytes: 512 } },
    query: {},
    body: [
      { path: ["model"], value: { literal: "fixed-model" } },
      { path: ["messages", 0, "role"], value: { literal: "user" } },
      { path: ["messages", 0, "content"], value: { input: "prompt" } },
    ],
    timeoutMs: 1000,
    maxRequestBytes: 2048,
    maxResponseBytes: 4096,
    maxResultBytes: 1024,
    response: { kind: "projected-json", fields: [["answer"]], maxArrayItems: 1 },
  };
}
function policy(op = operation()): ServicePolicy {
  return ServicePolicySchema.parse({
    serviceId: "inference",
    revision: "r1",
    origin: "https://example.invalid",
    allowLoopbackHttp: false,
    maxConcurrent: 2,
    directCostCeilingMicros: 100_000,
    prices: {
      models: {
        "fixed-model": {
          inputPerMillion: 1001,
          cachedInputPerMillion: 2001,
          outputPerMillion: 3001,
          contextTokens: 100,
        },
      },
    },
    operations: { complete: op },
  });
}

test("direct quotes ceil a worst-case exact installed model price, never bytes or default prices", () => {
  expect(quoteDirectService(policy(), "complete")).toEqual({
    ok: true,
    modelId: "fixed-model",
    reservedMicros: 1,
  });
  const spec = policy();
  spec.prices!.default = spec.prices!.models["fixed-model"]!;
  delete spec.prices!.models["fixed-model"];
  expect(quoteDirectService(spec, "complete")).toEqual({
    ok: false,
    refusal: "service_price_unknown",
  });
  spec.prices!.models["fixed-model"] = { inputPerMillion: 1, outputPerMillion: 1 };
  expect(quoteDirectService(spec, "complete")).toEqual({
    ok: false,
    refusal: "service_accounting_bound_unknown",
  });
  spec.prices!.models["fixed-model"] = {
    inputPerMillion: 0,
    outputPerMillion: 0,
    contextTokens: 100,
  };
  expect(quoteDirectService(spec, "complete")).toEqual({
    ok: true,
    modelId: "fixed-model",
    reservedMicros: 0,
  });
  delete spec.directCostCeilingMicros;
  expect(quoteDirectService(spec, "complete")).toEqual({
    ok: false,
    refusal: "service_accounting_bound_unknown",
  });
});

test("overflowing quotes refuse instead of saturating a promised bound", () => {
  const spec = policy();
  spec.prices!.models["fixed-model"] = {
    inputPerMillion: 1_000_000_000_000,
    outputPerMillion: 1_000_000_000_000,
    contextTokens: Number.MAX_SAFE_INTEGER,
  };
  expect(quoteDirectService(spec, "complete")).toEqual({
    ok: false,
    refusal: "service_ceiling_exceeded",
  });
  for (const contextTokens of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    spec.prices!.models["fixed-model"]!.contextTokens = contextTokens;
    expect(ServicePolicySchema.safeParse(spec).success).toBe(false);
  }
});

test("bounded mapping refuses dynamic models, streaming, batches, tools, routing and unsupported shapes", () => {
  const unsupported: ServiceOperationPolicy[] = [];
  const dynamic = operation();
  dynamic.input.model = { type: "string", required: true, maxBytes: 64 };
  dynamic.body[0] = { path: ["model"], value: { input: "model" } };
  unsupported.push(dynamic);
  for (const [path, literal] of [
    [["stream"], true],
    [["n"], 2],
    [["batch", 0], "prompt"],
    [["models", 0], "another-model"],
    [["tools", 0, "type"], "web_search"],
  ] as const) {
    const op = operation();
    op.body.push({ path: [...path], value: { literal } });
    unsupported.push(op);
  }
  const routed = operation();
  routed.path = "/{prompt}";
  unsupported.push(routed);
  const query = operation();
  query.query = { model: "prompt" };
  unsupported.push(query);
  const mixed = operation();
  mixed.body.push({ path: ["input"], value: { input: "prompt" } });
  unsupported.push(mixed);
  for (const op of unsupported)
    expect(quoteDirectService(policy(op), "complete")).toEqual({
      ok: false,
      refusal: "service_accounting_unsupported",
    });
  const fixed = operation();
  fixed.body.push(
    { path: ["stream"], value: { literal: false } },
    { path: ["n"], value: { literal: 1 } },
  );
  expect(quoteDirectService(policy(fixed), "complete").ok).toBe(true);
  fixed.body = [fixed.body[0]!, { path: ["input"], value: { input: "prompt" } }];
  expect(quoteDirectService(policy(fixed), "complete").ok).toBe(true);
});

test("direct evidence uses raw matching bounded usage while proxy arithmetic retains its established rounding", () => {
  const op = operation();
  const price = {
    inputPerMillion: 1_000_000,
    outputPerMillion: 2_000_000,
    cachedInputPerMillion: 500_000,
    contextTokens: 100,
  };
  const raw = {
    model: "fixed-model",
    usage: {
      prompt_tokens: 20,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 10 },
    },
  };
  const usage = directServiceUsage(op, price, raw)!;
  expect(serviceCallCost(price, usage)).toBe(25);
  for (const value of [
    { ...raw, model: "other" },
    { usage: raw.usage },
    { ...raw, usage: { ...raw.usage, completion_tokens: 101 } },
    { ...raw, usage: { ...raw.usage, prompt_tokens: -1 } },
    { ...raw, usage: { ...raw.usage, prompt_tokens_details: { cached_tokens: 21 } } },
    { ...raw, usage: { ...raw.usage, prompt_tokens_details: { cached_tokens: "10" } } },
  ])
    expect(directServiceUsage(op, price, value)).toBeUndefined();
  const legacy = readServiceUsage("openai-usage", {
    ...raw,
    usage: { ...raw.usage, prompt_tokens_details: { cached_tokens: 999 } },
  })!;
  expect(legacy.cachedInputTokens).toBe(20);
  expect(serviceCallCost({ inputPerMillion: 25_000, outputPerMillion: 0 }, legacy)).toBe(1);
  expect(serviceCallCost(undefined, legacy)).toBe(0);
});

test("pi native fixed user turns account physical cache writes and charged failures, not partial frames", () => {
  const op = operation();
  op.meter = { kind: "pi-native-usage", modelId: "fixed-model" };
  op.body = [
    { path: ["modelId"], value: { literal: "fixed-model" } },
    { path: ["context", "messages", 0, "role"], value: { literal: "user" } },
    { path: ["context", "messages", 0, "content"], value: { input: "prompt" } },
    { path: ["context", "messages", 0, "timestamp"], value: { literal: 0 } },
  ];
  expect(quoteDirectService(policy(op), "complete").ok).toBe(true);
  const price = {
    inputPerMillion: 1_000_000,
    outputPerMillion: 2_000_000,
    cachedInputPerMillion: 500_000,
    contextTokens: 100,
  };
  const raw = {
    type: "error",
    error: { errorStatus: 429, usage: { input: 10, output: 4, cacheRead: 6, cacheWrite: 2 } },
  };
  const usage = directServiceUsage(op, price, raw)!;
  expect(usage).toEqual({
    model: undefined,
    inputTokens: 18,
    outputTokens: 4,
    cachedInputTokens: 6,
    failedStatus: 429,
  });
  expect(serviceCallCost(price, usage)).toBe(23);
  expect(directServiceUsage(op, price, { ...raw, type: "text_delta" })).toBeUndefined();
  expect(directServiceUsage(op, price, { ...raw, modelId: "other" })).toBeUndefined();
  expect(
    directServiceUsage(op, price, {
      usage: { input: Number.MAX_SAFE_INTEGER, output: 0, cacheWrite: 1 },
    }),
  ).toBeUndefined();
});

test("accounting separates public invoke requests, native reservations and public receipts from worker IPC", () => {
  const args = {
    machineId: "machine",
    serviceId: "inference",
    revision: "r1",
    policySha256: "a".repeat(64),
    operationId: "complete",
    input: { prompt: "hello" },
  };
  const accounting = { callId: "call-1", maxCostMicros: 100 };
  expect(ServiceInvokeArgsSchema.safeParse({ ...args, accounting }).success).toBe(true);
  expect(
    ServiceInvokeArgsSchema.safeParse({ ...args, accounting: { ...accounting, reservedMicros: 1 } })
      .success,
  ).toBe(false);
  expect(ServiceReadArgsSchema.safeParse({ ...args, accounting }).success).toBe(false);
  expect(
    ServiceCallSchema.safeParse({
      type: "service",
      requestId: "request-1",
      serviceId: args.serviceId,
      operationId: args.operationId,
      input: args.input,
      accounting,
    }).success,
  ).toBe(false);
  const instance = {
    serviceId: args.serviceId,
    expectedRevision: args.revision,
    operationId: args.operationId,
    input: args.input,
    accounting,
  };
  expect(InstanceServiceInvokeArgsSchema.safeParse(instance).success).toBe(true);
  expect(InstanceServiceReadArgsSchema.safeParse(instance).success).toBe(false);
  const command = {
    ...args,
    type: "service_invoke",
    requestId: "request-1",
    accounting: { ...accounting, reservedMicros: 1 },
  };
  expect(JobCommandSchema.safeParse(command).success).toBe(true);
  expect(
    JobCommandSchema.safeParse({
      ...command,
      accounting: { ...command.accounting, receiptOnly: true },
    }).success,
  ).toBe(false);
  const reply = {
    type: "service_result",
    requestId: "request-1",
    ok: false,
    refusal: "service_timeout",
    charge: { callId: "call-1", reservedMicros: 1, status: "unknown", costMicros: null },
  };
  expect(NativeServiceReplySchema.safeParse(reply).success).toBe(true);
  expect(
    JobEventSchema.safeParse({ type: "service_invoke_result", requestId: "request-1", reply })
      .success,
  ).toBe(true);
  expect(ServiceReplySchema.safeParse(reply).success).toBe(false);
  expect(ServiceChargeSchema.safeParse({ ...reply.charge, costMicros: 0 }).success).toBe(false);
  expect(ServiceChargeSchema.safeParse({ ...reply.charge, status: "known" }).success).toBe(false);
  const receipt = {
    callId: "call-1",
    requestId: "request-1",
    revision: "r1",
    policySha256: args.policySha256,
    operationId: "complete",
    modelId: "fixed-model",
    reservedMicros: 1,
    state: "unresolved",
    chargedMicros: null,
  };
  expect(ServiceAccountingReceiptSchema.safeParse(receipt).success).toBe(true);
  expect(ServiceAccountingReceiptSchema.safeParse({ ...receipt, chargedMicros: 0 }).success).toBe(
    false,
  );
  expect(
    ServiceAccountingReceiptSchema.safeParse({ ...receipt, state: "settled", chargedMicros: 2 })
      .success,
  ).toBe(false);
});

test("accepted old owners retain ordinary service use but cannot parse or promise new monetary policies", () => {
  expect(jobOwnerSupports(43, "directServiceAccounting")).toBe(false);
  expect(jobOwnerSupports(44, "directServiceAccounting")).toBe(true);
  expect(jobOwnerSupports(45, "directServiceAccounting")).toBe(false);
  const spec = policy();
  expect(servicePolicyProtocolRefusal(43, PROTOCOL_VERSION, spec)).toBe(
    "service_accounting_protocol_unsupported",
  );
  expect(servicePolicyProtocolRefusal(44, PROTOCOL_VERSION, spec)).toBeNull();
  expect(servicePolicyProtocolRefusal(44, 51, spec)).toBe(
    "service_accounting_protocol_unsupported",
  );
  expect(servicePolicyProtocolRefusal(44, undefined, spec)).toBe(
    "service_accounting_protocol_unsupported",
  );
  expect(servicePolicyProtocolRefusal(44, PROTOCOL_VERSION + 1, spec)).toBe(
    "service_accounting_protocol_unsupported",
  );
  delete spec.directCostCeilingMicros;
  expect(servicePolicyProtocolRefusal(43, PROTOCOL_VERSION, spec)).toBe(
    "service_accounting_protocol_unsupported",
  );
  delete (spec.operations.complete as ServiceOperationPolicy).meter;
  expect(servicePolicyProtocolRefusal(43, PROTOCOL_VERSION, spec)).toBe(
    "service_accounting_protocol_unsupported",
  );
  delete spec.prices!.models["fixed-model"]!.contextTokens;
  expect(servicePolicyProtocolRefusal(43, 51, spec)).toBeNull();
});

test("generic JSON usage bounds one installed model across provider-defined request data", () => {
  const op = operation();
  op.meter = { kind: "json-usage", modelId: "fixed-model" };
  op.input = {
    state: { type: "string", required: true, maxBytes: 512 },
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
  const spec = policy(op);
  const price = { inputPerMillion: 2_000_000, outputPerMillion: 0, contextTokens: 100 };
  spec.prices!.models["fixed-model"] = price;
  expect(quoteDirectService(spec, "complete")).toEqual({
    ok: true,
    modelId: "fixed-model",
    reservedMicros: 200,
  });
  const raw = {
    model: "fixed-model",
    answers: { quality: { score: 0.8 } },
    usage: { input_tokens: 17, output_tokens: 1000 },
  };
  const measured = directServiceUsage(op, price, raw)!;
  expect(serviceCallCost(price, measured)).toBe(34);
  // The explicit zero output price needs no invented output-token maximum.
  expect(directServiceUsage(op, { ...price, outputPerMillion: 1 }, raw)).toBeUndefined();
  expect(
    directServiceUsage(op, price, { ...raw, usage: { input_tokens: 101, output_tokens: 0 } }),
  ).toBeUndefined();
  expect(directServiceUsage(op, price, { ...raw, model: "another-model" })).toBeUndefined();
  expect(directServiceUsage(op, price, { response: raw })).toBeUndefined();
  expect(
    directServiceUsage(op, price, { ...raw, usage: { prompt_tokens: 17, completion_tokens: 1 } }),
  ).toBeUndefined();
  for (const kind of ["openai-usage", "pi-native-usage"] as const) {
    const strictMode = { ...op, meter: { kind, modelId: "fixed-model" } };
    expect(
      quoteDirectService({ ...spec, operations: { complete: strictMode } }, "complete"),
    ).toEqual({
      ok: false,
      refusal: "service_accounting_unsupported",
    });
  }
  for (const [path, literal] of [
    [["stream"], true],
    [["n"], 2],
    [["models", 0], "another-model"],
    [["requests", 0, "state"], "batch member"],
    [["batch", 0], "batch member"],
    [["url"], "https://another.invalid"],
    [["modelId"], "another-model"],
  ] as const) {
    const unsupported = { ...op, body: [...op.body, { path: [...path], value: { literal } }] };
    expect(quoteDirectService(policy(unsupported), "complete")).toEqual({
      ok: false,
      refusal: "service_accounting_unsupported",
    });
  }
  const dynamic = {
    ...op,
    body: [{ path: ["model"], value: { input: "state" } }, ...op.body.slice(1)],
  };
  expect(quoteDirectService(policy(dynamic), "complete")).toEqual({
    ok: false,
    refusal: "service_accounting_unsupported",
  });
});
