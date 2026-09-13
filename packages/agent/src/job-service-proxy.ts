import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  Agent,
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { Socket } from "node:net";
import { Transform, type Duplex, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  ServiceBindingSchema,
  ServicePolicySchema,
  type JobEvent,
  type JobRequest,
  type JobResult,
  type ServiceBinding,
  type ServiceInput,
  type ServicePolicy,
} from "@manifold/protocol";
import type { AuthorizeServiceCall, ResolveServiceCredential } from "./job-services.ts";

type ProxyOperation = Extract<ServicePolicy["operations"][string], { kind: "http-proxy" }>;
type ModelPrice = NonNullable<ServicePolicy["prices"]>["models"][string];
/** Totals and ceilings as the protocol states them; the proxy owns neither, it reads both. */
export type JobInferenceUsage = NonNullable<NonNullable<JobResult["usage"]>["inference"]>;
export type JobInferenceLimits = NonNullable<JobRequest["limits"]["inference"]>;
/** What the proxy read of one call: the owner adds the job's identity and sends the event. */
export type JobInferenceCallReport = Omit<
  Extract<JobEvent, { type: "inference_call" }>,
  "type" | "jobId" | "requestDigest" | "ownerId" | "ownerGeneration"
>;
export type JobInferenceCeilingReport = Omit<
  Extract<JobEvent, { type: "inference_ceiling" }>,
  "type" | "jobId" | "requestDigest" | "ownerId" | "ownerGeneration"
>;
/** A ceiling belongs to the job, not to one proxy: the totals live in the owner's job record,
 * so a proxy rebuilt inside a job's life still sees everything that job has already spent. */
export interface JobInferenceMetering {
  /** The job request's `limits.inference`; undefined leaves every metered call unbounded. */
  limits: JobInferenceLimits | undefined;
  usage(): JobInferenceUsage;
  onInferenceCall(call: JobInferenceCallReport): void;
  onInferenceCeiling(refusal: JobInferenceCeilingReport): void;
}
export interface JobServiceProxy {
  /** Exact owner-loopback address. The owner alone materializes any guest forwarding. */
  readonly url: string;
  /** Fresh job capability, never an upstream credential. Deliver only to this job. */
  readonly bearer: string;
  /** Idempotently abort requests and close every listener connection. Borrows credentials. */
  close(): Promise<void>;
}
export interface JobServiceProxyOptions {
  policies: readonly ServicePolicy[];
  bindings: readonly ServiceBinding[];
  resolveCredential?: ResolveServiceCredential;
  /** Captures exact job identity and current authority with validated path/query scalars,
   * never the opaque application body. Includes native write-ahead trace. */
  authorize: AuthorizeServiceCall;
  signal?: AbortSignal;
  /** Active requests lose authority on owner-seat/configuration revocation; listeners remain reusable. */
  authoritySignal?: () => AbortSignal;
  /** Returns a fresh ownership-proved connection, not permission to dial a cached URL.
   * The resolver must destroy pending/returned sockets when signal aborts. */
  resolveRuntime?: (
    policy: ServicePolicy,
    signal: AbortSignal,
  ) => Promise<{ url: string; bearer: string; signal: AbortSignal; socket: Duplex }>;
  /** Present only for a job whose bound operations may be metered; absent leaves every
   * operation unmetered, whatever its policy declares. */
  inference?: JobInferenceMetering;
}
class ProxyFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** Named cause of a refusal the caller must act on: which ceiling, which unpriced model. */
    readonly detail?: Readonly<Record<string, string>>,
  ) {
    super(code);
  }
}
function boundedWait<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const abort = () => reject(new ProxyFailure(503, "service_cancelled"));
  if (signal.aborted) {
    void pending.catch(() => {});
    abort();
    return promise;
  }
  signal.addEventListener("abort", abort, { once: true });
  pending.then(resolve, reject);
  void promise.then(
    () => signal.removeEventListener("abort", abort),
    () => signal.removeEventListener("abort", abort),
  );
  return promise;
}
const JSON_ESCAPES: Readonly<Record<string, string>> = {
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
const EMPTY_BYTES = Buffer.alloc(0);
function normalizedEcho(value: string): string {
  return value.replace(
    /\\u00([0-9a-f]{2})|\\(["\\/bfnrt])/gi,
    (_all, hex: string | undefined, escaped: string) =>
      hex ? String.fromCharCode(Number.parseInt(hex, 16)) : (JSON_ESCAPES[escaped] ?? escaped),
  );
}
function containsCredentialEcho(value: string, patterns: readonly string[]): boolean {
  if (patterns.some((pattern) => value.includes(pattern))) return true;
  if (!value.includes("\\")) return false;
  const normalized = normalizedEcho(value);
  return patterns.some((pattern) => normalized.includes(pattern));
}
/** Withhold the longest possible encoded credential suffix before releasing bytes.
 * The window is bounded by credential length, not response length; handles split chunks. */
class BoundedBody extends Transform {
  private count = 0;
  private tail: Buffer = EMPTY_BYTES;
  private readonly keep: number;
  private readonly patterns: string[];
  private readonly starts = new Uint8Array(256);
  constructor(
    private readonly limit: number,
    secret?: string,
  ) {
    super({ highWaterMark: 16384 });
    this.patterns = secret
      ? [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")]
      : [];
    this.keep = this.patterns.length
      ? Math.max(...this.patterns.map((pattern) => pattern.length)) * 6
      : 0;
    this.starts[92] = 1;
    for (const pattern of this.patterns) this.starts[pattern.charCodeAt(0)] = 1;
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.count += chunk.length;
    if (this.count > this.limit) {
      done(new ProxyFailure(502, "service_response_limit"));
      return;
    }
    const bytes = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
    if (this.patterns.length && containsCredentialEcho(bytes.toString("latin1"), this.patterns)) {
      done(new ProxyFailure(502, "service_response_invalid"));
      return;
    }
    let released = bytes.length;
    // Release immediately unless a suffix could start an echo (including JSON escapes).
    // No full-body aggregation, even for long-lived event streams.
    if (this.keep) {
      for (let i = Math.max(0, bytes.length - this.keep); i < bytes.length; i++) {
        if (this.starts[bytes[i]!] === 1) {
          released = i;
          break;
        }
      }
    }
    if (released) this.push(bytes.subarray(0, released));
    this.tail = released === bytes.length ? EMPTY_BYTES : Buffer.from(bytes.subarray(released));
    done();
  }
  override _flush(done: TransformCallback): void {
    this.push(this.tail);
    this.tail = EMPTY_BYTES;
    done();
  }
}
function fail(response: ServerResponse, error: unknown): void {
  if (response.destroyed) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const failure =
    error instanceof ProxyFailure ? error : new ProxyFailure(502, "service_upstream_refused");
  // Never serialize an SDK, socket, credential resolver or authorization exception.
  response.writeHead(failure.status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    connection: "close",
  });
  response.end(
    JSON.stringify({
      error: failure.detail ? { code: failure.code, ...failure.detail } : failure.code,
    }),
  );
}
function contentType(value: string | undefined): string | undefined {
  return value
    ?.match(
      /^(application\/json|text\/event-stream|text\/plain)(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i,
    )?.[1]
    ?.toLowerCase();
}

/** One SSE frame is the most a stream is ever held for, and a JSON body no more than the
 * response limit the policy already states. */
const METER_FRAME_BYTES = 4194304;
const DATA_FIELD = Buffer.from("data:");
type MeteredUsage = {
  model: string | undefined;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};
function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function modelName(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
}
/** The provider's own numbers under either OpenAI spelling: chat completions report
 * `prompt_tokens`/`completion_tokens`, the responses API `input_tokens`/`output_tokens` and
 * wraps a streamed completion in `response`. Nothing but `usage` and `model` is read. */
function readUsage(value: unknown): MeteredUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const body = value as Record<string, unknown>;
  const nested =
    typeof body.response === "object" && body.response !== null
      ? (body.response as Record<string, unknown>)
      : undefined;
  const reported = body.usage ?? nested?.usage;
  if (typeof reported !== "object" || reported === null) return undefined;
  const usage = reported as Record<string, unknown>;
  const inputTokens = tokenCount(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = tokenCount(usage.completion_tokens ?? usage.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const detail = usage.prompt_tokens_details ?? usage.input_tokens_details;
  const cached =
    typeof detail === "object" && detail !== null
      ? tokenCount((detail as Record<string, unknown>).cached_tokens)
      : undefined;
  return {
    model: modelName(body.model) ?? modelName(nested?.model),
    inputTokens,
    outputTokens,
    cachedInputTokens: Math.min(cached ?? 0, inputTokens),
  };
}
/** Relays every byte the instant it arrives and keeps only what a usage read needs: an event
 * stream's current frame, or a JSON body already bounded by `maxResponseBytes`. A 2xx whose
 * usage it cannot read ends the caller's stream: an unreadable frame is not a free call. */
class UsageMeter extends Transform {
  usage: MeteredUsage | undefined;
  private buffer: Buffer = EMPTY_BYTES;
  private whole: Buffer[] = [];
  private wholeBytes = 0;
  private frame: string[] = [];
  private frameBytes = 0;
  private skipping = false;
  private overflowed = false;
  constructor(
    private readonly stream: boolean,
    private readonly limit: number,
    private readonly required: boolean,
  ) {
    super({ highWaterMark: 16384 });
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.push(chunk);
    if (this.stream) this.frames(chunk);
    else if (!this.overflowed) {
      this.wholeBytes += chunk.length;
      if (this.wholeBytes > this.limit) {
        this.overflowed = true;
        this.whole = [];
      } else this.whole.push(chunk);
    }
    done();
  }
  override _flush(done: TransformCallback): void {
    if (this.stream) {
      if (this.buffer.length) this.line(this.buffer);
      this.endFrame();
    } else if (this.whole.length) {
      try {
        this.usage = readUsage(JSON.parse(Buffer.concat(this.whole).toString("utf8")));
      } catch {
        this.usage = undefined;
      }
    }
    this.buffer = EMPTY_BYTES;
    this.whole = [];
    done(this.required && !this.usage ? new ProxyFailure(502, "service_response_invalid") : null);
  }
  private frames(chunk: Buffer): void {
    let bytes = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let start = 0;
    for (let index = bytes.indexOf(10, start); index >= 0; index = bytes.indexOf(10, start)) {
      this.line(bytes.subarray(start, index));
      start = index + 1;
    }
    bytes = start ? Buffer.from(bytes.subarray(start)) : bytes;
    if (bytes.length > METER_FRAME_BYTES) {
      this.skipping = true;
      bytes = EMPTY_BYTES;
    }
    this.buffer = bytes;
  }
  private line(raw: Buffer): void {
    const end = raw.length && raw[raw.length - 1] === 13 ? raw.length - 1 : raw.length;
    if (end === 0) {
      this.endFrame();
      return;
    }
    if (this.skipping || !raw.subarray(0, DATA_FIELD.length).equals(DATA_FIELD)) return;
    const from = raw[DATA_FIELD.length] === 32 ? DATA_FIELD.length + 1 : DATA_FIELD.length;
    this.frameBytes += end - from;
    if (this.frameBytes > METER_FRAME_BYTES) {
      this.skipping = true;
      this.frame = [];
      return;
    }
    this.frame.push(raw.subarray(from, end).toString("utf8"));
  }
  private endFrame(): void {
    const lines = this.frame;
    const skipped = this.skipping;
    this.frame = [];
    this.frameBytes = 0;
    this.skipping = false;
    if (skipped || !lines.length) return;
    const payload = lines.join("\n");
    if (payload === "[DONE]") return;
    try {
      this.usage = readUsage(JSON.parse(payload)) ?? this.usage;
    } catch {
      /* A frame that is not JSON carries no usage; the last one that does is the answer. */
    }
  }
}
async function readRequestBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let count = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    count += chunk.length;
    if (count > limit) throw new ProxyFailure(413, "service_input_invalid");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
/** A metered call names its model in the request, and a streamed chat completion is made to
 * ask for the usage frame: a ceiling evaded by setting `stream` is not a ceiling. Only the
 * chat shape needs it - a responses request streams its usage in `response.completed`, and
 * takes no `stream_options` - so every other body is forwarded byte for byte. */
function meteredRequest(body: Buffer): { model: string; forward: Buffer } {
  const invalid = () => new ProxyFailure(400, "service_input_invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw invalid();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid();
  const call = parsed as Record<string, unknown>;
  const model = modelName(call.model);
  if (model === undefined) throw invalid();
  if (call.stream !== true || !Array.isArray(call.messages)) return { model, forward: body };
  const declared = call.stream_options;
  if (declared !== undefined && (typeof declared !== "object" || declared === null))
    throw invalid();
  const options = { ...(declared as Record<string, unknown> | undefined), include_usage: true };
  return {
    model,
    forward: Buffer.from(JSON.stringify({ ...call, stream_options: options }), "utf8"),
  };
}
function priceOf(policy: ServicePolicy, model: string): ModelPrice | undefined {
  const prices = policy.prices;
  if (!prices) return undefined;
  return Object.hasOwn(prices.models, model) ? prices.models[model] : prices.default;
}
/** Integer micro-dollars rounded to the nearest, in exact arithmetic: tokens times a
 * per-million price leaves the safe-integer range long before either factor does. */
function callCost(price: ModelPrice | undefined, usage: MeteredUsage): number {
  if (!price) return 0;
  const cached = BigInt(usage.cachedInputTokens);
  const fresh = BigInt(usage.inputTokens) - cached;
  const total =
    fresh * BigInt(price.inputPerMillion) +
    cached * BigInt(price.cachedInputPerMillion ?? price.inputPerMillion) +
    BigInt(usage.outputTokens) * BigInt(price.outputPerMillion);
  const micros = (total + 500000n) / 1000000n;
  return micros > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(micros);
}
/** At the ceiling, not past it: the call that would reach `calls` is the one refused. */
function reachedCeiling(
  usage: JobInferenceUsage,
  limits: JobInferenceLimits | undefined,
): JobInferenceCeilingReport["ceiling"] | undefined {
  if (!limits) return undefined;
  if (limits.calls !== undefined && usage.calls >= limits.calls) return "calls";
  if (limits.inputTokens !== undefined && usage.inputTokens >= limits.inputTokens)
    return "inputTokens";
  if (limits.outputTokens !== undefined && usage.outputTokens >= limits.outputTokens)
    return "outputTokens";
  if (limits.costMicros !== undefined && usage.costMicros >= limits.costMicros) return "costMicros";
  return undefined;
}

type PathParameter = NonNullable<ProxyOperation["pathParameters"]>[string];
type RouteSegment = string | { name: string; field: PathParameter };
type ProxyRoute = {
  entry: { policy: ServicePolicy; active: number };
  operation: ProxyOperation;
  operationId: string;
  segments: RouteSegment[];
};

function pathValue(raw: string, field: PathParameter): string | number | undefined {
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  // One canonical encoding only; no encoded aliases, separators, percent nesting or dot segments.
  if (
    encodeURIComponent(value) !== raw ||
    !/^[A-Za-z0-9_~.@:+-]+$/.test(value) ||
    value === "." ||
    value === ".." ||
    Buffer.byteLength(value) > field.maxBytes
  )
    return undefined;
  if (field.format === "component") return value;
  if (!/^[1-9][0-9]*$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function routesOverlap(a: ProxyRoute, b: ProxyRoute): boolean {
  return (
    a.operation.method === b.operation.method &&
    a.segments.length === b.segments.length &&
    a.segments.every((left, index) => {
      const right = b.segments[index]!;
      if (typeof left === "string")
        return typeof right === "string"
          ? left === right
          : pathValue(left, right.field) !== undefined;
      return typeof right === "string" ? pathValue(right, left.field) !== undefined : true;
    })
  );
}

function matchPath(route: ProxyRoute, segments: string[]): ServiceInput | undefined {
  if (route.segments.length !== segments.length) return undefined;
  const input: ServiceInput = Object.create(null);
  for (let index = 0; index < segments.length; index++) {
    const part = route.segments[index]!;
    const raw = segments[index]!;
    if (typeof part === "string") {
      if (part !== raw) return undefined;
    } else {
      const value = pathValue(raw, part.field);
      if (value === undefined) return undefined;
      input[part.name] = value;
    }
  }
  return input;
}

function validatedQuery(
  operation: ProxyOperation,
  raw: string | undefined,
  input: ServiceInput,
): string {
  if (raw !== undefined && !operation.query)
    throw new ProxyFailure(404, "service_operation_unknown");
  const invalid = () => new ProxyFailure(400, "service_input_invalid");
  const seen = new Set<string>();
  if (raw !== undefined) {
    for (const pair of raw.split("&")) {
      const equals = pair.indexOf("=");
      if (equals < 1) throw invalid();
      const key = pair.slice(0, equals);
      if (!Object.hasOwn(operation.query ?? {}, key) || seen.has(key)) throw invalid();
      seen.add(key);
      let value: string;
      try {
        value = decodeURIComponent(pair.slice(equals + 1).replace(/\+/g, " "));
      } catch {
        throw invalid();
      }
      for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code < 0x20 || code === 0x7f) throw invalid();
      }
      const field = operation.query![key]!;
      if (field.type === "string") {
        if (
          Buffer.byteLength(value) > field.maxBytes ||
          (field.enum && !field.enum.includes(value))
        )
          throw invalid();
        input[key] = value;
      } else if (field.type === "boolean") {
        if (value !== "true" && value !== "false") throw invalid();
        input[key] = value === "true";
      } else {
        if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value)) throw invalid();
        const number = Number(value);
        if (
          !Number.isFinite(number) ||
          number < field.min ||
          number > field.max ||
          (field.integer && !Number.isSafeInteger(number))
        )
          throw invalid();
        input[key] = number;
      }
    }
  }
  const query = new URLSearchParams();
  for (const [key, field] of Object.entries(operation.query ?? {})) {
    if (!seen.has(key)) {
      if (field.required) throw invalid();
    } else query.set(key, String(input[key]));
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

function validatedHeaders(
  operation: ProxyOperation,
  request: IncomingMessage,
  credentialHeader?: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  // Node coalesces some duplicates and discards others; inspect the wire fields first.
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!.toLowerCase();
    const value = request.rawHeaders[index + 1]!;
    if (seen.has(name) || /[^\x20-\x7e]/.test(value))
      throw new ProxyFailure(400, "service_invalid_request");
    seen.add(name);
  }
  const connection = (request.headers.connection ?? "")
    .toLowerCase()
    .split(",")
    .map((part) => part.trim());
  if (
    connection.some((name) => name !== "" && name !== "close" && name !== "keep-alive") ||
    (credentialHeader && credentialHeader !== "authorization" && seen.has(credentialHeader))
  )
    throw new ProxyFailure(400, "service_invalid_request");
  for (const [name, field] of Object.entries(operation.requestHeaders ?? {})) {
    const value = request.headers[name];
    if (value !== undefined && typeof value !== "string")
      throw new ProxyFailure(400, "service_invalid_request");
    if (field.kind === "literal") {
      if (value !== undefined && value !== field.value)
        throw new ProxyFailure(400, "service_input_invalid");
      headers[name] = field.value;
    } else if (value === undefined) {
      if (field.required) throw new ProxyFailure(400, "service_input_invalid");
    } else {
      if (value.length > field.maxBytes || (field.enum && !field.enum.includes(value)))
        throw new ProxyFailure(400, "service_input_invalid");
      headers[name] = value;
    }
  }
  return headers;
}

/** One immutable trusted policy/binding snapshot and one independently random capability
 * per job. No worker-selected policy, credentials, origin, route templates or redirects. */
export async function createJobServiceProxy(
  options: JobServiceProxyOptions,
): Promise<JobServiceProxy> {
  const { authorize, resolveCredential, signal } = options;
  signal?.throwIfAborted();
  const policies = new Map<string, { policy: ServicePolicy; active: number }>();
  const routes: ProxyRoute[] = [];
  if (options.policies.length > 64 || options.bindings.length > 64)
    throw new Error("service_policy_invalid");
  for (const raw of options.policies) {
    const parsed = ServicePolicySchema.safeParse(raw);
    if (!parsed.success || policies.has(parsed.data.serviceId))
      throw new Error("service_policy_invalid");
    policies.set(parsed.data.serviceId, { policy: parsed.data, active: 0 });
  }
  const bound = new Set<string>();
  for (const raw of options.bindings) {
    const parsed = ServiceBindingSchema.safeParse(raw);
    if (!parsed.success) throw new Error("service_binding_mismatch");
    const binding = parsed.data;
    const entry = policies.get(binding.serviceId);
    if (!entry || bound.has(binding.serviceId) || binding.revision !== entry.policy.revision)
      throw new Error("service_binding_mismatch");
    bound.add(binding.serviceId);
    for (const operationId of binding.operationIds) {
      const operation = Object.hasOwn(entry.policy.operations, operationId)
        ? entry.policy.operations[operationId]
        : undefined;
      if (!operation) throw new Error("service_binding_mismatch");
      if (!("kind" in operation)) continue;
      // A meter reads the model from the request it forwards; a route without a JSON request
      // cannot be metered, and an unmeterable metered route is a policy the owner must fix.
      if (operation.meter && operation.request.kind !== "json")
        throw new Error("service_policy_invalid");
      const route: ProxyRoute = {
        entry,
        operation,
        operationId,
        segments: operation.path
          .split("/")
          .map((part) =>
            part.startsWith("{")
              ? { name: part.slice(1, -1), field: operation.pathParameters![part.slice(1, -1)]! }
              : part,
          ),
      };
      if (routes.some((existing) => routesOverlap(existing, route)))
        throw new Error("service_policy_invalid");
      routes.push(route);
    }
  }
  if (!routes.length) throw new Error("service_unavailable");
  const bearer = randomBytes(32).toString("base64url");
  const capability = Buffer.from(`Bearer ${bearer}`);
  const active = new Set<AbortController>();
  let closed = false;
  let host = "";
  let closing: Promise<void> | undefined;
  const server = createServer(
    { maxHeaderSize: 16384, requestTimeout: 300000, headersTimeout: 10000, keepAliveTimeout: 1000 },
    (request, response) => {
      void handle(request, response).catch((error: unknown) => fail(response, error));
    },
  );
  server.maxConnections = 128;
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("checkContinue", (_request, response) =>
    fail(response, new ProxyFailure(400, "service_invalid_request")),
  );
  server.on("checkExpectation", (_request, response) =>
    fail(response, new ProxyFailure(400, "service_invalid_request")),
  );

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (closed || supplied.length !== capability.length || !timingSafeEqual(supplied, capability))
      throw new ProxyFailure(401, "service_unauthorized");
    // Inspect raw origin-form before URL parsing can normalize traversal or encoded aliases.
    if (
      request.headers.host !== host ||
      request.headers.origin !== undefined ||
      request.headers["content-encoding"] !== undefined
    )
      throw new ProxyFailure(400, "service_invalid_request");
    const target = request.url ?? "";
    if (
      !target.startsWith("/") ||
      target.startsWith("//") ||
      target.includes("#") ||
      Buffer.byteLength(target) > 8192
    )
      throw new ProxyFailure(404, "service_operation_unknown");
    const queryStart = target.indexOf("?");
    const path = queryStart < 0 ? target : target.slice(0, queryStart);
    const segments = path.split("/");
    let route: ProxyRoute | undefined;
    let input: ServiceInput | undefined;
    for (const candidate of routes) {
      if (candidate.operation.method !== request.method) continue;
      const matched = matchPath(candidate, segments);
      if (matched) {
        route = candidate;
        input = matched;
        break;
      }
    }
    if (!route || !input) throw new ProxyFailure(404, "service_operation_unknown");
    const { entry, operation, operationId } = route;
    const query = validatedQuery(
      operation,
      queryStart < 0 ? undefined : target.slice(queryStart + 1),
      input,
    );
    const requestHeaders = validatedHeaders(
      operation,
      request,
      entry.policy.credential?.header.toLowerCase(),
    );
    const length = request.headers["content-length"];
    if (
      length !== undefined &&
      (!/^\d+$/.test(length) || Number(length) > operation.maxRequestBytes)
    )
      throw new ProxyFailure(413, "service_input_invalid");
    if (operation.request.kind === "none") {
      if (
        (length !== undefined && Number(length) !== 0) ||
        request.headers["transfer-encoding"] !== undefined
      )
        throw new ProxyFailure(400, "service_input_invalid");
    } else if (contentType(request.headers["content-type"]) !== "application/json") {
      throw new ProxyFailure(415, "service_input_invalid");
    }
    if (entry.active >= entry.policy.maxConcurrent) throw new ProxyFailure(429, "service_busy");
    const controller = new AbortController();
    active.add(controller);
    entry.active++;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, operation.timeoutMs);
    const disconnect = () => {
      if (!response.writableFinished) controller.abort();
    };
    const abandoned = () => controller.abort();
    const authoritySignal = options.authoritySignal?.();
    authoritySignal?.addEventListener("abort", abandoned, { once: true });
    if (authoritySignal?.aborted) controller.abort();
    let runtimeSignal: AbortSignal | undefined;
    request.once("aborted", abandoned);
    response.once("close", disconnect);
    let upstream: IncomingMessage | undefined;
    let secret: string | undefined;
    let runtimeSocket: Duplex | undefined;
    let runtimeAgent: Agent | undefined;
    const metering = operation.meter ? options.inference : undefined;
    let meter: UsageMeter | undefined;
    let requestModel = "";
    let meteredStatus = 0;
    let startedAt = 0;
    try {
      const authority = Object.freeze({
        serviceId: entry.policy.serviceId,
        revision: entry.policy.revision,
        operationId,
        input: Object.freeze(input),
      });
      const check = async () => {
        try {
          if (
            (await boundedWait(authorize(authority, controller.signal), controller.signal)) !== true
          )
            throw new Error("denied");
        } catch {
          throw new ProxyFailure(403, "service_unauthorized");
        }
        controller.signal.throwIfAborted();
      };
      await check();
      let forward: Buffer | undefined;
      if (metering) {
        // The body is read here, before anything is forwarded: the model decides the price,
        // and a call the job may no longer make must not reach the provider at all.
        const parsed = meteredRequest(
          await boundedWait(readRequestBody(request, operation.maxRequestBytes), controller.signal),
        );
        requestModel = parsed.model;
        forward = parsed.forward;
        const reached = { ...metering.usage() };
        const ceiling = reachedCeiling(reached, metering.limits);
        if (ceiling) {
          metering.onInferenceCeiling({
            serviceId: entry.policy.serviceId,
            operationId,
            ceiling,
            reached,
          });
          throw new ProxyFailure(429, "service_ceiling_exceeded", { ceiling });
        }
        // A ceiling in money is meaningless without a price, and refusing is the answer
        // the operator can act on.
        if (metering.limits?.costMicros !== undefined && !priceOf(entry.policy, requestModel))
          throw new ProxyFailure(422, "service_price_unknown", { model: requestModel });
      }
      const headers: Record<string, string> = {
        ...requestHeaders,
        "accept-encoding": "identity",
        accept: operation.response.contentTypes.join(", "),
      };
      if (operation.request.kind === "json") headers["content-type"] = "application/json";
      if (forward) headers["content-length"] = String(forward.length);
      let origin = entry.policy.origin;
      if (entry.policy.runtime || entry.policy.remote) {
        if (!options.resolveRuntime) throw new ProxyFailure(503, "service_unavailable");
        let runtime: Awaited<ReturnType<NonNullable<JobServiceProxyOptions["resolveRuntime"]>>>;
        try {
          runtime = await boundedWait(
            options.resolveRuntime(entry.policy, controller.signal),
            controller.signal,
          );
        } catch {
          throw new ProxyFailure(503, "service_unavailable");
        }
        runtimeSocket = runtime.socket;
        if (
          !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(runtime.url) ||
          Number(new URL(runtime.url).port) > 65535 ||
          !/^[A-Za-z0-9_-]{32,128}$/.test(runtime.bearer) ||
          !runtimeSocket ||
          runtimeSocket.destroyed ||
          !runtimeSocket.readable ||
          !runtimeSocket.writable ||
          (!entry.policy.remote &&
            (!(runtimeSocket instanceof Socket) ||
              runtimeSocket.connecting ||
              runtimeSocket.remoteAddress !== "127.0.0.1" ||
              runtimeSocket.remotePort !== Number(new URL(runtime.url).port)))
        )
          throw new ProxyFailure(503, "service_unavailable");
        origin = runtime.url;
        secret = runtime.bearer;
        runtimeSignal = runtime.signal;
        runtimeSignal.addEventListener("abort", abandoned, { once: true });
        if (runtimeSignal.aborted) controller.abort();
        headers.authorization = `Bearer ${secret}`;
        await check();
      }
      const credential = entry.policy.credential;
      if (credential) {
        try {
          if (!resolveCredential) throw new Error("missing");
          secret = await boundedWait(
            resolveCredential(credential.ref, controller.signal),
            controller.signal,
          );
          if (typeof secret !== "string" || !/^[\x21-\x7e]{1,16384}$/.test(secret))
            throw new Error("invalid");
          headers[credential.header.toLowerCase()] = credential.prefix + secret;
        } catch {
          throw new ProxyFailure(503, "service_credential_unavailable");
        }
        await check();
      }
      controller.signal.throwIfAborted();
      if (!origin) throw new ProxyFailure(503, "service_unavailable");
      const url = new URL(path + query, origin);
      if (url.origin !== origin || url.pathname !== path)
        throw new ProxyFailure(400, "service_input_invalid");
      const received = Promise.withResolvers<IncomingMessage>();
      if (entry.policy.runtime || entry.policy.remote) {
        const socket = runtimeSocket;
        if (!socket || socket.destroyed) throw new ProxyFailure(503, "service_unavailable");
        runtimeAgent = new Agent({ keepAlive: false, maxSockets: 1 });
        let claimed = false;
        // Never delegate to Agent's dialer, including when this socket dies during
        // handoff. Each request gets one connection and cannot recreate or reuse it.
        runtimeAgent.createConnection = (_options, callback) => {
          if (claimed || socket.destroyed) {
            callback?.(new ProxyFailure(503, "service_unavailable"), socket);
            return undefined;
          }
          claimed = true;
          return socket;
        };
      }
      startedAt = Date.now();
      const outgoing = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: operation.method,
          headers,
          signal: controller.signal,
          agent: runtimeAgent ?? false,
          maxHeaderSize: 16384,
          ...(url.protocol === "https:" ? { rejectUnauthorized: true } : {}),
        },
        received.resolve,
      );
      outgoing.once("error", received.reject);
      // Upload and download are concurrent; each stream's backpressure bounds buffering.
      // A metered request is already in hand, amended and measured, so it is simply sent.
      const upload = forward
        ? Promise.resolve(void outgoing.end(forward))
        : pipeline(request, new BoundedBody(operation.maxRequestBytes), outgoing, {
            signal: controller.signal,
          });
      void upload.catch(() => controller.abort());
      upstream = await received.promise;
      const status = upstream.statusCode ?? 0;
      if (metering && status >= 100 && status <= 599) meteredStatus = status;
      const notModified =
        status === 304 &&
        operation.method === "GET" &&
        requestHeaders["if-none-match"] !== undefined;
      if (
        status < 200 ||
        (status >= 300 && status < 400 && !notModified) ||
        status > 599 ||
        (upstream.headers["content-encoding"] &&
          upstream.headers["content-encoding"] !== "identity")
      )
        throw new ProxyFailure(502, "service_upstream_refused");
      const responseLength = upstream.headers["content-length"];
      if (
        responseLength !== undefined &&
        (!/^\d+$/.test(responseLength) || Number(responseLength) > operation.maxResponseBytes)
      )
        throw new ProxyFailure(502, "service_response_limit");
      const mime = contentType(upstream.headers["content-type"]);
      const hopHeaders = new Set(
        (upstream.headers.connection ?? "")
          .toLowerCase()
          .split(",")
          .map((part) => part.trim()),
      );
      if (hopHeaders.has("content-type")) throw new ProxyFailure(502, "service_response_invalid");
      if (
        status !== 204 &&
        !notModified &&
        (!mime ||
          !operation.response.contentTypes.includes(
            mime as ProxyOperation["response"]["contentTypes"][number],
          ))
      )
        throw new ProxyFailure(502, "service_response_invalid");
      const safeHeaders: Record<string, string> = { "cache-control": "no-store" };
      if (mime) safeHeaders["content-type"] = `${mime}; charset=utf-8`;
      const credentialPatterns = secret
        ? [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")]
        : [];
      for (const name of operation.response.headers) {
        const value = upstream.headers[name];
        if (
          typeof value === "string" &&
          value.length <= 1024 &&
          /^[\x20-\x7e]*$/.test(value) &&
          !hopHeaders.has(name) &&
          (!credential || name !== credential.header.toLowerCase()) &&
          !containsCredentialEcho(value, credentialPatterns)
        )
          safeHeaders[name] = value;
      }
      response.writeHead(status, safeHeaders);
      // Headers may precede data; secret-bearing or oversized tails terminate, never expose error text.
      response.flushHeaders();
      const bounded = new BoundedBody(operation.maxResponseBytes, secret);
      if (metering)
        meter = new UsageMeter(
          mime === "text/event-stream",
          operation.maxResponseBytes,
          status >= 200 && status < 300,
        );
      await (meter
        ? pipeline(upstream, bounded, meter, response, { signal: controller.signal })
        : pipeline(upstream, bounded, response, { signal: controller.signal }));
      await upload;
    } catch (error) {
      fail(
        response,
        controller.signal.aborted
          ? new ProxyFailure(503, timedOut ? "service_timeout" : "service_cancelled")
          : error,
      );
    } finally {
      controller.abort();
      upstream?.destroy();
      runtimeAgent?.destroy();
      runtimeSocket?.destroy();
      secret = undefined;
      clearTimeout(timer);
      request.removeListener("aborted", abandoned);
      response.removeListener("close", disconnect);
      authoritySignal?.removeEventListener("abort", abandoned);
      runtimeSignal?.removeEventListener("abort", abandoned);
      active.delete(controller);
      entry.active--;
      // Reported last: a call that reached the provider is spent whatever became of its bytes.
      if (metering && meteredStatus) {
        const counted = meteredStatus >= 200 && meteredStatus < 300 ? meter?.usage : undefined;
        const model = counted?.model ?? requestModel;
        metering.onInferenceCall({
          serviceId: entry.policy.serviceId,
          operationId,
          model,
          inputTokens: counted?.inputTokens ?? 0,
          outputTokens: counted?.outputTokens ?? 0,
          cachedInputTokens: counted?.cachedInputTokens ?? 0,
          costMicros: counted ? callCost(priceOf(entry.policy, model), counted) : 0,
          elapsedMs: Date.now() - startedAt,
          status: meteredStatus,
        });
      }
    }
  }
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    signal?.removeEventListener("abort", abort);
    for (const controller of active) controller.abort();
    const stopped = Promise.withResolvers<void>();
    closing = stopped.promise;
    server.close(() => stopped.resolve());
    server.closeAllConnections();
    return closing;
  };
  const abort = () => {
    void close();
  };
  const listening = Promise.withResolvers<void>();
  const listenError = () => listening.reject(new Error("service_unavailable"));
  server.once("error", listenError);
  server.listen(0, "127.0.0.1", () => {
    server.removeListener("error", listenError);
    listening.resolve();
  });
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") {
    await close();
    throw new Error("service_unavailable");
  }
  host = `127.0.0.1:${address.port}`;
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) {
    await close();
    throw new Error("service_cancelled");
  }
  return Object.freeze({ url: `http://${host}`, bearer, close });
}
