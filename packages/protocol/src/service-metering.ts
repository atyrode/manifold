import type {
  ServiceModelPrice,
  ServiceOperationPolicy,
  ServicePolicy,
  ServiceRefusal,
  ServiceDirectQuote,
} from "./services.ts";

export type ServiceMeterKind = NonNullable<ServiceOperationPolicy["meter"]>["kind"];
export type ServiceMeteredUsage = {
  model: string | undefined;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** A failed terminal still carries the turn's bill. */
  failedStatus?: number;
};
const UNREADABLE_USAGE = 502;
function object(value: unknown, strict = false): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && (!strict || !Array.isArray(value))
    ? (value as Record<string, unknown>)
    : undefined;
}
function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
export function serviceModelName(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
}
/** Provider usage only, before any consumer projection. Strict direct accounting rejects
 * malformed optional buckets rather than inheriting the legacy proxy's normalization. */
export function readServiceUsage(
  kind: ServiceMeterKind,
  value: unknown,
  strict = false,
): ServiceMeteredUsage | undefined {
  const body = object(value, strict);
  if (!body) return undefined;
  if (kind === "openai-usage" || kind === "json-usage") {
    const nested = kind === "openai-usage" ? object(body.response, strict) : undefined;
    const usage = object(body.usage ?? nested?.usage, strict);
    if (!usage) return undefined;
    const inputTokens = tokenCount(
      kind === "json-usage" ? usage.input_tokens : (usage.prompt_tokens ?? usage.input_tokens),
    );
    const outputTokens = tokenCount(
      kind === "json-usage"
        ? usage.output_tokens
        : (usage.completion_tokens ?? usage.output_tokens),
    );
    if (inputTokens === undefined || outputTokens === undefined) return undefined;
    const detail = usage.prompt_tokens_details ?? usage.input_tokens_details;
    const cached = tokenCount(object(detail, strict)?.cached_tokens);
    const model = serviceModelName(body.model) ?? serviceModelName(nested?.model);
    if (
      strict &&
      (!model ||
        (body.model !== undefined && body.model !== model) ||
        (nested?.model !== undefined && nested.model !== model) ||
        (usage.prompt_tokens !== undefined &&
          usage.input_tokens !== undefined &&
          usage.prompt_tokens !== usage.input_tokens) ||
        (usage.completion_tokens !== undefined &&
          usage.output_tokens !== undefined &&
          usage.completion_tokens !== usage.output_tokens) ||
        (detail !== undefined &&
          (!object(detail, true) ||
            (object(detail, true)?.cached_tokens !== undefined && cached === undefined))) ||
        (cached !== undefined && cached > inputTokens))
    )
      return undefined;
    const failed =
      strict &&
      (body.status === "failed" ||
        body.status === "cancelled" ||
        body.error != null ||
        nested?.status === "failed" ||
        nested?.status === "cancelled" ||
        nested?.error != null);
    return {
      model,
      inputTokens,
      outputTokens,
      cachedInputTokens: Math.min(cached ?? 0, inputTokens),
      ...(failed ? { failedStatus: UNREADABLE_USAGE } : {}),
    };
  }
  if (kind !== "pi-native-usage") {
    const unsupported: never = kind;
    throw new Error(`Unsupported service meter: ${unsupported}`);
  }
  const answer = object(body.message, strict);
  const failed = !answer ? object(body.error, strict) : undefined;
  const usage = object(body.usage ?? answer?.usage ?? failed?.usage, strict);
  if (!usage) return undefined;
  const input = tokenCount(usage.input);
  const output = tokenCount(usage.output);
  if (input === undefined || output === undefined) return undefined;
  const cached = tokenCount(usage.cacheRead) ?? 0;
  const written = tokenCount(usage.cacheWrite) ?? 0;
  const inputTokens = input + cached + written;
  if (
    strict &&
    (!Number.isSafeInteger(inputTokens) ||
      (usage.cacheRead !== undefined && tokenCount(usage.cacheRead) === undefined) ||
      (usage.cacheWrite !== undefined && tokenCount(usage.cacheWrite) === undefined) ||
      (body.type !== undefined && body.type !== "done" && body.type !== "error") ||
      (body.type === "done" && !answer) ||
      (body.type === "error" && !failed))
  )
    return undefined;
  const stated = failed?.errorStatus;
  const failedStatus =
    typeof stated === "number" && Number.isInteger(stated) && stated >= 400 && stated <= 599
      ? stated
      : UNREADABLE_USAGE;
  // This wire does not report a model. The fixed installed request supplies it; direct callers
  // separately reject a contradictory model if an upstream nevertheless includes one.
  return {
    model: undefined,
    inputTokens,
    outputTokens: output,
    cachedInputTokens: cached,
    ...(failed ? { failedStatus } : {}),
  };
}
export function serviceModelPrice(
  policy: ServicePolicy,
  model: string,
): ServiceModelPrice | undefined {
  const prices = policy.prices;
  if (!prices) return undefined;
  return Object.hasOwn(prices.models, model) ? prices.models[model] : prices.default;
}
function costNumerator(price: ServiceModelPrice, usage: ServiceMeteredUsage): bigint {
  const cached = BigInt(usage.cachedInputTokens);
  const fresh = BigInt(usage.inputTokens) - cached;
  return (
    fresh * BigInt(price.inputPerMillion) +
    cached * BigInt(price.cachedInputPerMillion ?? price.inputPerMillion) +
    BigInt(usage.outputTokens) * BigInt(price.outputPerMillion)
  );
}
/** Existing proxy arithmetic: nearest integer micro-dollar, unknown price zero, saturating. */
export function serviceCallCost(
  price: ServiceModelPrice | undefined,
  usage: ServiceMeteredUsage,
): number {
  if (!price) return 0;
  const micros = (costNumerator(price, usage) + 500000n) / 1000000n;
  return micros > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(micros);
}

/** Bounded direct settlement must not release a positive fractional charge as free exposure. */
export function directServiceCallCost(
  price: ServiceModelPrice,
  usage: ServiceMeteredUsage,
): number {
  const micros = (costNumerator(price, usage) + 999999n) / 1000000n;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("service_cost_overflow");
  return Number(micros);
}

/** json-usage is an installed wire contract, not an inference about arbitrary JSON:
 * exactly one model selected by root `model`, and aggregate usage for the entire request.
 * These transport/fan-out controls cannot be smuggled through its generic data mapping. */
const unsupportedJsonControls: Readonly<Record<string, true>> = {
  model: true,
  modelId: true,
  modelIds: true,
  models: true,
  model_id: true,
  model_ids: true,
  stream: true,
  streaming: true,
  stream_options: true,
  n: true,
  batch: true,
  batches: true,
  requests: true,
  best_of: true,
  num_completions: true,
  num_return_sequences: true,
  tools: true,
  tool_choice: true,
  parallel_tool_calls: true,
  url: true,
  uri: true,
  endpoint: true,
  route: true,
  path: true,
  method: true,
  headers: true,
  provider: true,
  providers: true,
};
/** All structure is installed. OpenAI/Pi admit text-turn shapes; json-usage admits scalar
 * leaves in provider-defined data shapes under its explicit whole-request bound contract. */
function boundedMapping(operation: ServiceOperationPolicy, contextTokens: number): boolean {
  const meter = operation.meter;
  if (
    !meter ||
    operation.method !== "POST" ||
    operation.invocable !== true ||
    operation.response.kind !== "projected-json" ||
    operation.path.includes("{") ||
    Object.keys(operation.query).length !== 0
  )
    return false;
  const modelKey = meter.kind === "pi-native-usage" ? "modelId" : "model";
  let fixedModel = false;
  let responsesInput = false;
  const messages = new Map<number, Set<string>>();
  const stringValue = (source: ServiceOperationPolicy["body"][number]["value"]) =>
    "literal" in source
      ? typeof source.literal === "string"
      : "input" in source &&
        operation.input[source.input]?.type === "string" &&
        operation.input[source.input]?.required === true;
  for (const field of operation.body) {
    const path = field.path;
    const source = field.value;
    if (path.length === 1 && path[0] === modelKey) {
      if (!("literal" in source) || source.literal !== meter.modelId) return false;
      fixedModel = true;
      continue;
    }
    if (path.length === 1 && path[0] === "stream") {
      if (!("literal" in source) || source.literal !== false) return false;
      continue;
    }
    if (meter.kind !== "pi-native-usage" && path.length === 1 && path[0] === "n") {
      if (!("literal" in source) || source.literal !== 1) return false;
      continue;
    }
    if (meter.kind === "json-usage") {
      if (Object.hasOwn(unsupportedJsonControls, path[0]!) || "credentialRef" in source)
        return false;
      continue;
    }
    if (meter.kind === "openai-usage" && path.length === 1 && path[0] === "input") {
      if (!stringValue(source)) return false;
      responsesInput = true;
      continue;
    }
    if (
      meter.kind === "pi-native-usage" &&
      path.length === 2 &&
      path[0] === "context" &&
      path[1] === "systemPrompt"
    ) {
      if (!stringValue(source)) return false;
      continue;
    }
    const messagePath =
      meter.kind === "openai-usage" ? path : path[0] === "context" ? path.slice(1) : [];
    if (
      messagePath.length === 3 &&
      messagePath[0] === "messages" &&
      typeof messagePath[1] === "number"
    ) {
      const key = messagePath[2];
      if (key === "role") {
        if (
          !("literal" in source) ||
          (meter.kind === "pi-native-usage"
            ? source.literal !== "user"
            : !["system", "developer", "user", "assistant"].includes(String(source.literal)))
        )
          return false;
      } else if (key === "content") {
        if (!stringValue(source)) return false;
      } else if (key === "timestamp" && meter.kind === "pi-native-usage") {
        if (!("literal" in source) || tokenCount(source.literal) === undefined) return false;
      } else return false;
      const fields = messages.get(messagePath[1]) ?? new Set<string>();
      fields.add(key);
      messages.set(messagePath[1], fields);
      continue;
    }
    const parameter =
      meter.kind === "openai-usage" && path.length === 1
        ? path[0]
        : meter.kind === "pi-native-usage" && path.length === 2 && path[0] === "options"
          ? path[1]
          : undefined;
    if (
      typeof parameter !== "string" ||
      ![
        "temperature",
        "top_p",
        "max_tokens",
        "max_completion_tokens",
        "max_output_tokens",
        "maxTokens",
      ].includes(parameter)
    )
      return false;
    if (meter.kind === "pi-native-usage" && !["temperature", "maxTokens"].includes(parameter))
      return false;
    if (meter.kind === "openai-usage" && parameter === "maxTokens") return false;
    const value = "literal" in source ? source.literal : undefined;
    const input = "input" in source ? operation.input[source.input] : undefined;
    const tokenLimit = parameter.startsWith("max");
    if (input) {
      if (
        input.type !== "number" ||
        !input.required ||
        (tokenLimit && (!input.integer || input.min < 1 || input.max > contextTokens))
      )
        return false;
    } else if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (tokenLimit && (!Number.isSafeInteger(value) || value < 1 || value > contextTokens))
    )
      return false;
  }
  if (meter.kind === "json-usage") return fixedModel;
  if (!fixedModel || (responsesInput && messages.size > 0)) return false;
  if (responsesInput) return true;
  if (messages.size === 0) return false;
  for (let i = 0; i < messages.size; i++) {
    const fields = messages.get(i);
    if (!fields?.has("role") || !fields.has("content")) return false;
  }
  return true;
}
export type DirectServiceQuote =
  ({ ok: true } & ServiceDirectQuote) | { ok: false; refusal: ServiceRefusal };
/** Quote exact reviewed pricing, never default prices or caller estimates. contextTokens
 * bounds the whole input and any charged output; zero-priced JSON output needs no money bound. */
export function quoteDirectService(policy: ServicePolicy, operationId: string): DirectServiceQuote {
  const operation = Object.hasOwn(policy.operations, operationId)
    ? policy.operations[operationId]
    : undefined;
  if (!operation) return { ok: false, refusal: "service_operation_unknown" };
  if (
    "kind" in operation ||
    !operation.meter ||
    policy.remote ||
    (policy.runtime && policy.runtime.scope !== "instance")
  )
    return { ok: false, refusal: "service_accounting_unsupported" };
  const modelId = operation.meter.modelId;
  const price =
    policy.prices && Object.hasOwn(policy.prices.models, modelId)
      ? policy.prices.models[modelId]
      : undefined;
  if (!price) return { ok: false, refusal: "service_price_unknown" };
  if (price.contextTokens === undefined || policy.directCostCeilingMicros === undefined)
    return { ok: false, refusal: "service_accounting_bound_unknown" };
  if (!boundedMapping(operation, price.contextTokens))
    return { ok: false, refusal: "service_accounting_unsupported" };
  const numerator = costNumerator(price, {
    model: modelId,
    inputTokens: price.contextTokens,
    outputTokens: price.contextTokens,
    cachedInputTokens:
      (price.cachedInputPerMillion ?? price.inputPerMillion) > price.inputPerMillion
        ? price.contextTokens
        : 0,
  });
  const micros = (numerator + 999999n) / 1000000n;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER))
    return { ok: false, refusal: "service_ceiling_exceeded" };
  return { ok: true, modelId, reservedMicros: Number(micros) };
}
/** Strict direct evidence is tied to the installed model and its hard context contract. */
export function directServiceUsage(
  operation: ServiceOperationPolicy,
  price: ServiceModelPrice,
  value: unknown,
): ServiceMeteredUsage | undefined {
  const meter = operation.meter;
  if (!meter || price.contextTokens === undefined) return undefined;
  const usage = readServiceUsage(meter.kind, value, true);
  if (
    !usage ||
    usage.inputTokens > price.contextTokens ||
    (usage.outputTokens > price.contextTokens &&
      (meter.kind !== "json-usage" || price.outputPerMillion !== 0)) ||
    (usage.model !== undefined && usage.model !== meter.modelId)
  )
    return undefined;
  if (meter.kind === "pi-native-usage") {
    const body = object(value);
    for (const node of [body, object(body?.message), object(body?.error)]) {
      if (
        node &&
        ((node.model !== undefined && node.model !== meter.modelId) ||
          (node.modelId !== undefined && node.modelId !== meter.modelId))
      )
        return undefined;
    }
  }
  return usage;
}
