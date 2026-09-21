import { z } from "zod";

export const SERVICE_FRAME_BYTES = 128 * 1024;
const name = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .refine((value) => !["__proto__", "constructor", "prototype", ".", ".."].includes(value));
const scalar = z.union([z.string().max(65536), z.number().finite(), z.boolean()]);
const encodedBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;
export const ServiceInputSchema = z
  .record(name, scalar)
  .refine((value) => Object.keys(value).length <= 64 && encodedBytes(value) <= 65536);
/** Child data names an alias and operation only. Identity and binding come from its owner. */
export const ServiceCallSchema = z.strictObject({
  type: z.literal("service"),
  requestId: name,
  serviceId: name,
  operationId: name,
  input: ServiceInputSchema,
});
/**
 * Every way a service call can be refused, and the only words any layer reports.
 *
 * One `service_unavailable` used to answer at nine sites across the proxy and the owner — no
 * resolver, a resolver that rejected, an endpoint that failed its loopback proof, a socket that
 * died, a policy that is not a runtime policy, a parent that is gone, cancelled or not started,
 * a child that never started, a host resource that is absent, an owner that is draining — and
 * nothing was recorded on either side, so a workload and the operator watching it both saw one
 * undifferentiated fact (#708). Each of those is now its own word.
 */
export const ServiceRefusalSchema = z.enum([
  "service_invalid_request",
  "service_unavailable",
  "service_operation_unknown",
  "service_binding_mismatch",
  "service_input_invalid",
  "service_busy",
  "service_unauthorized",
  "service_cancelled",
  "service_timeout",
  "service_closed",
  "service_credential_unavailable",
  "service_upstream_refused",
  "service_response_invalid",
  "service_response_limit",
  "service_ceiling_exceeded",
  "service_price_unknown",
  "service_machine_mismatch",
  "service_owner_unavailable",
  "service_owner_draining",
  "service_origin_absent",
  "service_policy_not_runtime",
  "service_policy_not_remote",
  "service_policy_changed",
  "service_parent_has_no_context",
  "service_parent_cancelled",
  "service_parent_not_started",
  "service_parent_services_closed",
  "service_runtime_unsupported",
  "service_runtime_unreachable",
  "service_runtime_invalid",
  "service_runtime_disconnected",
  "service_runtime_resources_absent",
  "service_runtime_child_absent",
  "service_runtime_child_not_started",
  "service_runtime_endpoint_closed",
  "service_remote_refused",
  "service_tunnel_closed",
  "service_tunnel_duplicate",
  "service_tunnel_limit",
  "service_runtime_limit",
  "service_runtime_input_missing",
  "service_start_timeout",
]);
/**
 * What a SANDBOXED workload is told, which is not always what was recorded.
 *
 * A refusal that names the owner's own topology — which child job never started, which host
 * resource is absent, that the owner is draining, how many tunnels it holds — would let an
 * isolate enumerate the machine it runs on by making calls and reading answers. It learns the
 * fate of ITS call: not authorized, invalid, busy, cancelled, timed out, over a ceiling, or the
 * service could not be served. The precise fact goes to the owner's log and to the hub's
 * service trace, where the operator reads it. Same asymmetry as an existence check asked after
 * the authority walk so it cannot answer questions the caller was not entitled to ask.
 */
const GUEST_REFUSALS = new Set<ServiceRefusal>([
  "service_invalid_request",
  "service_unavailable",
  "service_operation_unknown",
  "service_binding_mismatch",
  "service_input_invalid",
  "service_busy",
  "service_unauthorized",
  "service_cancelled",
  "service_timeout",
  "service_closed",
  "service_upstream_refused",
  "service_response_invalid",
  "service_response_limit",
  "service_ceiling_exceeded",
  "service_price_unknown",
  "service_credential_unavailable",
]);
export function guestServiceRefusal(refusal: ServiceRefusal): ServiceRefusal {
  return GUEST_REFUSALS.has(refusal) ? refusal : "service_unavailable";
}
export const ServiceReplySchema = z
  .discriminatedUnion("ok", [
    z.strictObject({
      type: z.literal("service_result"),
      requestId: name,
      ok: z.literal(true),
      result: z.json(),
    }),
    z.strictObject({
      type: z.literal("service_result"),
      requestId: name,
      ok: z.literal(false),
      refusal: ServiceRefusalSchema,
    }),
  ])
  .refine((value) => encodedBytes(value) + 1 <= SERVICE_FRAME_BYTES);

/** Native resource binding, never interpreted as a second grant or policy store. */
export const ServiceBindingSchema = z.strictObject({
  serviceId: name,
  revision: name,
  operationIds: z
    .array(name)
    .min(1)
    .max(64)
    .refine((ids) => new Set(ids).size === ids.length),
});
const inputField = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("string"),
    required: z.boolean(),
    maxBytes: z.number().int().positive().max(65536),
    enum: z.array(z.string().max(65536)).min(1).max(64).optional(),
  }),
  z
    .strictObject({
      type: z.literal("number"),
      required: z.boolean(),
      min: z.number().finite(),
      max: z.number().finite(),
      integer: z.boolean(),
    })
    .refine((field) => field.min <= field.max),
  z.strictObject({ type: z.literal("boolean"), required: z.boolean() }),
]);
const mapping = z.record(name, name).refine((value) => Object.keys(value).length <= 64);
const projectionPath = z
  .array(z.union([name, z.literal("*")]))
  .min(1)
  .max(16);
export const JsonProjectionSchema = z.strictObject({
  kind: z.literal("projected-json"),
  /** Paths select primitive leaves, not entire objects. '*' traverses arrays only. */
  fields: z.array(projectionPath).min(1).max(64),
  maxArrayItems: z.number().int().positive().max(4096),
});
export const ServiceResponsePolicySchema = z.discriminatedUnion("kind", [
  JsonProjectionSchema,
  // These modes authorize disclosure of the entire successful body, not just metadata.
  z.strictObject({ kind: z.literal("json"), disclosure: z.literal("full") }),
  z.strictObject({ kind: z.literal("bytes"), disclosure: z.literal("full") }),
]);

/** One bounded projection implementation for service and action-result consumers. */
export class JsonProjectionError extends Error {
  constructor(readonly code: "invalid" | "limit") {
    super(`json_projection_${code}`);
    this.name = "JsonProjectionError";
  }
}

export type JsonProjection = {
  leaf: boolean;
  text?: true;
  children: Map<string, JsonProjection>;
};
export function compileJsonProjection(
  fields: readonly (readonly string[])[],
  textFields?: readonly (readonly string[])[],
): JsonProjection {
  const root: JsonProjection = { leaf: false, children: new Map() };
  for (const path of fields) {
    let node = root;
    for (const part of path) {
      let child = node.children.get(part);
      if (!child) {
        child = { leaf: false, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.leaf = true;
  }
  if (textFields !== undefined) {
    if (!JsonProjectionSchema.shape.fields.safeParse(textFields).success)
      throw new JsonProjectionError("invalid");
    for (const path of textFields) {
      let node = root;
      for (const part of path) {
        // A parent leaf or array wildcard would make this exact path unreachable.
        if (node.leaf || (part !== "*" && node.children.has("*")))
          throw new JsonProjectionError("invalid");
        const child = node.children.get(part);
        if (!child) throw new JsonProjectionError("invalid");
        node = child;
      }
      if (!node.leaf || node.children.size !== 0) throw new JsonProjectionError("invalid");
      node.text = true;
    }
  }
  return root;
}
export function projectJson(
  value: unknown,
  node: JsonProjection,
  maxArrayItems: number,
  budget: { nodes: number } = { nodes: 65536 },
): unknown {
  if (--budget.nodes < 0) throw new JsonProjectionError("limit");
  if (node.leaf) {
    if (node.text && value !== null && typeof value !== "string")
      throw new JsonProjectionError("invalid");
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return value;
    throw new JsonProjectionError("invalid");
  }
  const wildcard = node.children.get("*");
  if (wildcard) {
    if (!Array.isArray(value)) throw new JsonProjectionError("invalid");
    if (value.length > maxArrayItems) throw new JsonProjectionError("limit");
    return value.map((item) => projectJson(item, wildcard, maxArrayItems, budget));
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new JsonProjectionError("invalid");
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, child] of node.children) {
    if (Object.hasOwn(value, key))
      result[key] = projectJson(Reflect.get(value, key), child, maxArrayItems, budget);
  }
  return result;
}
const deniedProxyHeaders: Readonly<Record<string, boolean>> = {
  constructor: true,
  prototype: true,
  authorization: true,
  "authentication-info": true,
  "www-authenticate": true,
  cookie: true,
  "set-cookie": true,
  host: true,
  connection: true,
  "keep-alive": true,
  "transfer-encoding": true,
  te: true,
  trailer: true,
  upgrade: true,
  expect: true,
  accept: true,
  origin: true,
  referer: true,
  via: true,
  forwarded: true,
  "max-forwards": true,
  "http2-settings": true,
  "alt-used": true,
  destination: true,
  "x-real-ip": true,
  "x-forwarded": true,
};
const proxyHeaderName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
  .refine(
    (value) =>
      value === value.trim() &&
      !Object.hasOwn(deniedProxyHeaders, value) &&
      !/^(?:content-|accept-|proxy-|sec-|forwarded-|x-forwarded-|x-http-method|access-control-|x-upstream-|x-original-|x-rewrite-|x-envoy-)/.test(
        value,
      ),
  );
// Zod records omit __proto__ during parsing; reject forbidden own keys before that projection.
const proxyHeaderObject = z
  .unknown()
  .refine(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.getOwnPropertyNames(value).every((key) => proxyHeaderName.safeParse(key).success),
  );
const proxyHeaderValue = z
  .string()
  .max(4096)
  .regex(/^[\x20-\x7e]*$/)
  .refine((value) => value === value.trim());
export const ServiceOperationPolicySchema = z
  .strictObject({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    requestHeaders: proxyHeaderObject
      .pipe(z.record(proxyHeaderName, proxyHeaderValue))
      .refine(
        (headers) =>
          Object.keys(headers).length <= 16 &&
          Object.entries(headers).reduce(
            (bytes, [name, value]) => bytes + name.length + value.length + 4,
            0,
          ) <= 8192,
      )
      .optional(),
    readable: z.boolean().optional(),
    /** Absent means denied; only bounded, projected responses may be directly invoked. */
    invocable: z.boolean().optional(),
    path: z
      .string()
      .max(4096)
      .refine(
        (path) =>
          path === "/" ||
          (path.startsWith("/") &&
            path
              .slice(1)
              .split("/")
              .every(
                (part) =>
                  /^(?:[A-Za-z0-9_~.-]+|\{[A-Za-z0-9][A-Za-z0-9._-]{0,127}\})$/.test(part) &&
                  part !== "." &&
                  part !== "..",
              )),
      ),
    input: z.record(name, inputField).refine((value) => Object.keys(value).length <= 64),
    /** Destination query field -> declared input field. No implicit forwarding. */
    query: mapping,
    /** Fixed JSON leaves from caller input, literals, or installer-selected owner-held credentials. */
    body: z
      .array(
        z.strictObject({
          path: z
            .array(z.union([name, z.number().int().nonnegative().max(63)]))
            .min(1)
            .max(16)
            .refine((path) => typeof path[0] === "string"),
          value: z.union([
            z.strictObject({ input: name }),
            z.strictObject({ literal: scalar.nullable() }),
            z.strictObject({ credentialRef: name }),
          ]),
        }),
      )
      .max(64),
    timeoutMs: z.number().int().positive().max(300000),
    maxRequestBytes: z.number().int().positive().max(65536),
    maxResponseBytes: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024),
    maxResultBytes: z
      .number()
      .int()
      .positive()
      .max(96 * 1024),
    response: ServiceResponsePolicySchema,
  })
  .superRefine((operation, ctx) => {
    const fail = () => ctx.addIssue({ code: "custom", message: "Invalid service input mapping" });
    if (operation.method === "GET" && operation.body.length) fail();
    if (
      operation.readable &&
      (operation.method !== "GET" || operation.response.kind !== "projected-json")
    )
      fail();
    if (operation.invocable && operation.response.kind !== "projected-json") fail();
    const used = new Set<string>();
    const bodyInputs = operation.body.flatMap((field) =>
      "input" in field.value ? [field.value.input] : [],
    );
    for (const source of [...Object.values(operation.query), ...bodyInputs]) {
      if (!Object.hasOwn(operation.input, source)) fail();
      used.add(source);
    }
    for (const part of operation.path.split("/")) {
      if (!part.startsWith("{")) continue;
      const source = part.slice(1, -1);
      const field = operation.input[source];
      if (!Object.hasOwn(operation.input, source) || !field?.required || field.type !== "string")
        fail();
      used.add(source);
    }
    if (Object.keys(operation.input).some((key) => !used.has(key))) fail();
    for (let i = 0; i < operation.body.length; i++) {
      for (let j = i + 1; j < operation.body.length; j++) {
        const a = operation.body[i]!.path;
        const b = operation.body[j]!.path;
        const common = Math.min(a.length, b.length);
        let k = 0;
        while (k < common && a[k] === b[k]) k++;
        if (k === common || typeof a[k] !== typeof b[k]) fail();
      }
    }
    if (operation.response.kind === "projected-json") {
      const paths = operation.response.fields;
      for (let i = 0; i < paths.length; i++) {
        for (let j = i + 1; j < paths.length; j++) {
          const a = paths[i]!;
          const b = paths[j]!;
          const common = Math.min(a.length, b.length);
          let k = 0;
          while (k < common && a[k] === b[k]) k++;
          // Reject duplicate/prefix leaves and ambiguous object/array shapes.
          if (k === common || a[k] === "*" || b[k] === "*") fail();
        }
      }
    }
  });

const proxyHeaderMapping = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("literal"), value: proxyHeaderValue }),
  z
    .strictObject({
      kind: z.literal("forward"),
      maxBytes: z.number().int().positive().max(4096),
      required: z.boolean(),
      enum: z
        .array(proxyHeaderValue)
        .min(1)
        .max(64)
        .refine((values) => new Set(values).size === values.length)
        .optional(),
    })
    .refine((field) => !field.enum || field.enum.every((value) => value.length <= field.maxBytes)),
]);
const proxyRequestHeaders = proxyHeaderObject
  .pipe(z.record(proxyHeaderName, proxyHeaderMapping))
  .refine((headers) => {
    const entries = Object.entries(headers);
    return (
      entries.length <= 16 &&
      entries.reduce(
        (bytes, [name, field]) =>
          bytes +
          name.length +
          4 +
          (field.kind === "literal" ? field.value.length : field.maxBytes),
        0,
      ) <= 8192
    );
  });

/** Micro-dollars per million tokens: $3.00 is 3_000_000. Cached input defaults to the input price. */
export const ServiceModelPriceSchema = z.strictObject({
  inputPerMillion: z.number().int().nonnegative().max(1_000_000_000_000),
  outputPerMillion: z.number().int().nonnegative().max(1_000_000_000_000),
  cachedInputPerMillion: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
});
export type ServiceModelPrice = z.infer<typeof ServiceModelPriceSchema>;

/** Opaque application bytes are data, never transport controls. The trusted installer
 * opts into full request/response disclosure for approved routes and bounded parameters;
 * no caller origin, undeclared query/header, redirect or content negotiation is forwarded. */
export const ServiceProxyOperationPolicySchema = z
  .strictObject({
    kind: z.literal("http-proxy"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z
      .string()
      .max(4096)
      .refine(
        (path) =>
          path === "/" ||
          (path.startsWith("/") &&
            path
              .slice(1)
              .split("/")
              .every(
                (part) =>
                  /^(?:[A-Za-z0-9_~.-]+|\{[A-Za-z0-9][A-Za-z0-9._-]{0,127}\})$/.test(part) &&
                  part !== "." &&
                  part !== "..",
              )),
      ),
    /** Whole-segment parameters only; decoded values never select transport controls. */
    pathParameters: z
      .record(
        name,
        z.strictObject({
          format: z.enum(["component", "positive-integer"]),
          maxBytes: z.number().int().positive().max(4096),
        }),
      )
      .refine((value) => Object.keys(value).length <= 64)
      .optional(),
    /** Only these scalar fields may appear in the caller query. */
    query: z
      .record(name, inputField)
      .refine((value) => Object.keys(value).length <= 64)
      .optional(),
    /** Installer-fixed nonsecret values or explicitly bounded caller data, never transport controls. */
    requestHeaders: proxyRequestHeaders.optional(),
    request: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("none") }),
      z.strictObject({ kind: z.literal("json"), disclosure: z.literal("full") }),
    ]),
    response: z.strictObject({
      kind: z.literal("stream"),
      disclosure: z.literal("full"),
      contentTypes: z
        .array(z.enum(["application/json", "text/event-stream", "text/plain"]))
        .min(1)
        .max(3),
      headers: z.array(z.enum(["retry-after", "x-request-id", "request-id", "etag"])).max(4),
    }),
    timeoutMs: z.number().int().positive().max(300000),
    maxRequestBytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
    maxResponseBytes: z
      .number()
      .int()
      .positive()
      .max(256 * 1024 * 1024),
    /**
     * A metered operation's proxy reads the provider's own `usage` object (and the model the call
     * names) from a JSON response or the final usage frame of an SSE stream, and nothing else of
     * the body. `openai-usage` reads the OpenAI spellings, and a streaming request is amended with
     * `stream_options.include_usage` so that frame exists. `pi-native-usage` reads pi-ai's own
     * wire - `modelId` and `context.messages` on the request, and
     * `usage.input`/`.output`/`.cacheRead`/`.cacheWrite` on the terminal frame. It amends nothing,
     * because every terminal frame states the turn's usage. A response the meter cannot read is
     * `service_response_invalid`, never a free call.
     */
    meter: z.strictObject({ kind: z.enum(["openai-usage", "pi-native-usage"]) }).optional(),
  })
  .refine((operation) => operation.method !== "GET" || operation.request.kind === "none")
  .superRefine((operation, ctx) => {
    if (operation.meter !== undefined && operation.request.kind !== "json")
      ctx.addIssue({
        code: "custom",
        message: "A metered proxy operation requires a JSON request",
      });
    const parameters = operation.path
      .split("/")
      .filter((part) => part.startsWith("{"))
      .map((part) => part.slice(1, -1));
    const declared = Object.keys(operation.pathParameters ?? {});
    const query = Object.keys(operation.query ?? {});
    if (
      new Set(parameters).size !== parameters.length ||
      parameters.some((key) => !Object.hasOwn(operation.pathParameters ?? {}, key)) ||
      declared.some((key) => !parameters.includes(key) || query.includes(key)) ||
      declared.length + query.length > 64
    )
      ctx.addIssue({ code: "custom", message: "Invalid proxy parameter mapping" });
  });

export const ServiceRuntimeSchema = z.strictObject({
  scope: z.enum(["job", "instance"]).optional(),
  pluginId: name,
  operationId: name,
  installationRevision: name,
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  resourceBindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  input: z
    .record(name, z.union([z.strictObject({ input: name }), z.strictObject({ literal: scalar })]))
    .refine((value) => Object.keys(value).length <= 64),
});
export type ServiceRuntime = z.infer<typeof ServiceRuntimeSchema>;

/** Owner-installed policy. No raw credential values or caller-selected transport controls. */
export const ServicePolicySchema = z
  .strictObject({
    serviceId: name,
    revision: name,
    origin: z.url().max(4096).optional(),
    allowLoopbackHttp: z.boolean().optional(),
    runtime: ServiceRuntimeSchema.optional(),
    remote: z
      .strictObject({
        machineId: name,
        serviceId: name,
        revision: name,
        policySha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .optional(),
    credential: z
      .strictObject({
        ref: name,
        header: z
          .string()
          .regex(/^[A-Za-z0-9-]{1,64}$/)
          .refine(
            (value) =>
              ![
                "host",
                "connection",
                "content-length",
                "transfer-encoding",
                "content-type",
                "accept",
                "accept-encoding",
                "cookie",
                "proxy-authorization",
                "trailer",
                "te",
                "upgrade",
                "expect",
              ].includes(value.toLowerCase()) &&
              !value.toLowerCase().startsWith("proxy-") &&
              !value.toLowerCase().startsWith("sec-"),
          ),
        prefix: z.enum(["", "Bearer ", "Basic "]),
      })
      .optional(),
    maxConcurrent: z.number().int().positive().max(64),
    operations: z
      .record(name, z.union([ServiceOperationPolicySchema, ServiceProxyOperationPolicySchema]))
      .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 64),
    /**
     * Integer micro-dollars per million tokens, keyed by the model id a metered call names;
     * `default` prices any model the map does not. Policy content, so pinned by `revision` and
     * consented like the rest of it: a price change is a new revision.
     */
    prices: z
      .strictObject({
        default: ServiceModelPriceSchema.optional(),
        models: z
          .record(z.string().min(1).max(256), ServiceModelPriceSchema)
          .refine((value) => Object.keys(value).length <= 256),
      })
      .optional(),
  })
  .refine((policy) => {
    if (policy.runtime || policy.remote)
      return (
        !(policy.runtime && policy.remote) &&
        policy.origin === undefined &&
        policy.credential === undefined &&
        policy.allowLoopbackHttp === undefined &&
        Object.values(policy.operations).every(
          (operation) =>
            "kind" in operation ||
            (policy.runtime?.scope === "instance" &&
              operation.body.every((field) => !("credentialRef" in field.value))),
        ) &&
        (policy.runtime?.scope !== "instance" ||
          Object.values(policy.runtime.input).every((source) => "literal" in source))
      );
    if (policy.origin === undefined || policy.allowLoopbackHttp === undefined) return false;
    const url = new URL(policy.origin);
    if (url.username || url.password || url.hash || url.search || policy.origin !== url.origin)
      return false;
    return (
      url.protocol === "https:" ||
      (policy.allowLoopbackHttp &&
        url.protocol === "http:" &&
        (url.hostname === "127.0.0.1" || url.hostname === "[::1]"))
    );
  })
  .refine(
    (policy) =>
      !policy.credential ||
      Object.values(policy.operations).every(
        (operation) =>
          !Object.hasOwn(operation.requestHeaders ?? {}, policy.credential!.header.toLowerCase()),
      ),
    { message: "Service request header collides with the source credential" },
  )
  .refine((policy) => encodedBytes(policy) <= 128 * 1024, {
    message: "Service policy exceeds the native configuration bound",
  });

/** Native bootstrap advertises references and allowed origins, never source paths or values. */
export const ServiceCredentialReferenceSchema = z.strictObject({
  ref: name,
  origins: z
    .array(
      z
        .url()
        .max(4096)
        .refine((value) => {
          const url = new URL(value);
          return (
            value === url.origin &&
            (url.protocol === "https:" ||
              (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))
          );
        }),
    )
    .min(1)
    .max(32),
  available: z.boolean(),
});
export const ServiceConfigurationSchema = z
  .strictObject({
    revision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    policies: z.array(ServicePolicySchema).max(64),
  })
  .refine(
    (value) =>
      (value.revision !== null || value.policies.length === 0) &&
      new Set(value.policies.map((policy) => policy.serviceId)).size === value.policies.length &&
      encodedBytes(value) <= 512 * 1024,
  );
export const ServiceRuntimeCandidateSchema = z.strictObject({
  runtime: ServiceRuntimeSchema.omit({ input: true }),
  ready: z.boolean(),
  reason: z.string().max(256).nullable(),
});
export const ServiceConfigurationReadSchema = z.strictObject({
  configuration: ServiceConfigurationSchema,
  connected: z.boolean(),
  credentialReferences: z.array(ServiceCredentialReferenceSchema),
  runtimeCandidates: z.array(ServiceRuntimeCandidateSchema),
});
export type ServiceRuntimeCandidate = z.infer<typeof ServiceRuntimeCandidateSchema>;
export type ServiceConfigurationRead = z.infer<typeof ServiceConfigurationReadSchema>;
export const ServiceReadArgsSchema = z.strictObject({
  machineId: name,
  serviceId: name,
  revision: name,
  policySha256: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: name,
  input: ServiceInputSchema,
});
/** Separate entry point and authority despite the same exact policy-bound input shape. */
export const ServiceInvokeArgsSchema = z.strictObject({ ...ServiceReadArgsSchema.shape });
export const ServiceAuthoritySubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("job"), jobId: name }),
  z.strictObject({ kind: z.literal("read"), requestId: name }),
  z.strictObject({ kind: z.literal("invoke"), requestId: name }),
  z.strictObject({ kind: z.literal("tunnel"), channelId: name }),
]);
export type ServiceConfiguration = z.infer<typeof ServiceConfigurationSchema>;
export type ServiceCredentialReference = z.infer<typeof ServiceCredentialReferenceSchema>;
export type ServiceReadArgs = z.infer<typeof ServiceReadArgsSchema>;
export type ServiceInvokeArgs = z.infer<typeof ServiceInvokeArgsSchema>;
export type ServiceAuthoritySubject = z.infer<typeof ServiceAuthoritySubjectSchema>;

export type ServiceInput = z.infer<typeof ServiceInputSchema>;
export type ServiceCall = z.infer<typeof ServiceCallSchema>;
export type ServiceReply = z.infer<typeof ServiceReplySchema>;
export type ServiceRefusal = z.infer<typeof ServiceRefusalSchema>;
export type ServiceBinding = z.infer<typeof ServiceBindingSchema>;
export type ServiceResponsePolicy = z.infer<typeof ServiceResponsePolicySchema>;
export type ServiceOperationPolicy = z.infer<typeof ServiceOperationPolicySchema>;
export type ServicePolicy = z.infer<typeof ServicePolicySchema>;
export type ServiceProxyOperationPolicy = z.infer<typeof ServiceProxyOperationPolicySchema>;

/** Native peers bind channels to proved owners; frames carry no authority of their own. */
export const ServiceTunnelFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("data"),
    channelId: name,
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    data: z.base64().min(4).max(21848),
  }),
  z.strictObject({
    type: z.literal("ack"),
    channelId: name,
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({
    type: z.literal("end"),
    channelId: name,
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({ type: z.literal("close"), channelId: name }),
]);
export type ServiceTunnelFrame = z.infer<typeof ServiceTunnelFrameSchema>;

/** Deduplicated owner-held sources for the selected operations plus the common header.
 * Omit operationIds for the whole policy; pass [] to inspect only the common header. */
export function servicePolicyCredentialRefs(
  policy: ServicePolicy,
  operationIds: readonly string[] = Object.keys(policy.operations),
): string[] {
  const refs = new Set<string>();
  if (policy.credential) refs.add(policy.credential.ref);
  for (const id of operationIds) {
    const operation = Object.hasOwn(policy.operations, id) ? policy.operations[id] : undefined;
    if (!operation || "kind" in operation) continue;
    for (const field of operation.body)
      if ("credentialRef" in field.value) refs.add(field.value.credentialRef);
  }
  return [...refs];
}
