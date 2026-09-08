import { z } from "zod";

export const SERVICE_FRAME_BYTES = 128 * 1024;
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .refine((value) => !["__proto__", "constructor", "prototype", ".", ".."].includes(value));
const scalar = z.union([z.string().max(65536), z.number().finite(), z.boolean()]);
const encodedBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
export const ServiceInputSchema = z.record(name, scalar).refine(
  (value) => Object.keys(value).length <= 64 && encodedBytes(value) <= 65536,
);
/** Child data names an alias and operation only. Identity and binding come from its owner. */
export const ServiceCallSchema = z.strictObject({
  type: z.literal("service"),
  requestId: name,
  serviceId: name,
  operationId: name,
  input: ServiceInputSchema,
});
export const ServiceRefusalSchema = z.enum([
  "service_invalid_request", "service_unavailable", "service_operation_unknown",
  "service_binding_mismatch", "service_input_invalid", "service_busy",
  "service_unauthorized", "service_cancelled", "service_timeout", "service_closed",
  "service_credential_unavailable", "service_upstream_refused", "service_response_invalid",
  "service_response_limit",
]);
export const ServiceReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({ type: z.literal("service_result"), requestId: name, ok: z.literal(true), result: z.json() }),
  z.strictObject({ type: z.literal("service_result"), requestId: name, ok: z.literal(false), refusal: ServiceRefusalSchema }),
]).refine((value) => encodedBytes(value) + 1 <= SERVICE_FRAME_BYTES);

/** Native resource binding, never interpreted as a second grant or policy store. */
export const ServiceBindingSchema = z.strictObject({
  serviceId: name,
  revision: name,
  operationIds: z.array(name).min(1).max(64).refine((ids) => new Set(ids).size === ids.length),
});
const inputField = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("string"), required: z.boolean(), maxBytes: z.number().int().positive().max(65536), enum: z.array(z.string().max(65536)).min(1).max(64).optional() }),
  z.strictObject({ type: z.literal("number"), required: z.boolean(), min: z.number().finite(), max: z.number().finite(), integer: z.boolean() }).refine((field) => field.min <= field.max),
  z.strictObject({ type: z.literal("boolean"), required: z.boolean() }),
]);
const mapping = z.record(name, name).refine((value) => Object.keys(value).length <= 64);
const projectionPath = z.array(z.union([name, z.literal("*")])).min(1).max(16);
export const ServiceResponsePolicySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("projected-json"),
    /** Paths select primitive leaves, not entire objects. '*' traverses arrays only. */
    fields: z.array(projectionPath).min(1).max(64),
    maxArrayItems: z.number().int().positive().max(4096),
  }),
  // These modes authorize disclosure of the entire successful body, not just metadata.
  z.strictObject({ kind: z.literal("json"), disclosure: z.literal("full") }),
  z.strictObject({ kind: z.literal("bytes"), disclosure: z.literal("full") }),
]);
export const ServiceOperationPolicySchema = z.strictObject({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().max(4096).refine((path) => path === "/" || (
    path.startsWith("/") && path.slice(1).split("/").every((part) =>
      /^(?:[A-Za-z0-9_~.-]+|\{[A-Za-z0-9][A-Za-z0-9._-]{0,127}\})$/.test(part) && part !== "." && part !== ".."
    )
  )),
  input: z.record(name, inputField).refine((value) => Object.keys(value).length <= 64),
  /** Destination query field -> declared input field. No implicit forwarding. */
  query: mapping,
  /** Fixed JSON shape, including arrays. Only leaf scalars can come from child input. */
  body: z.array(z.strictObject({
    path: z.array(z.union([name, z.number().int().nonnegative().max(63)])).min(1).max(16)
      .refine((path) => typeof path[0] === "string"),
    value: z.union([z.strictObject({ input: name }), z.strictObject({ literal: scalar.nullable() })]),
  })).max(64),
  timeoutMs: z.number().int().positive().max(300000),
  maxRequestBytes: z.number().int().positive().max(65536),
  maxResponseBytes: z.number().int().positive().max(4 * 1024 * 1024),
  maxResultBytes: z.number().int().positive().max(96 * 1024),
  response: ServiceResponsePolicySchema,
}).superRefine((operation, ctx) => {
  const fail = () => ctx.addIssue({ code: "custom", message: "Invalid service input mapping" });
  if (operation.method === "GET" && operation.body.length) fail();
  const used = new Set<string>();
  const bodyInputs = operation.body.flatMap((field) => "input" in field.value ? [field.value.input] : []);
  for (const source of [...Object.values(operation.query), ...bodyInputs]) {
    if (!Object.hasOwn(operation.input, source)) fail();
    used.add(source);
  }
  for (const part of operation.path.split("/")) {
    if (!part.startsWith("{")) continue;
    const source = part.slice(1, -1);
    const field = operation.input[source];
    if (!Object.hasOwn(operation.input, source) || !field?.required || field.type !== "string") fail();
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

const deniedProxyHeaders: Readonly<Record<string, true>> = {
  constructor: true, prototype: true, authorization: true, "authentication-info": true,
  "www-authenticate": true, cookie: true, "set-cookie": true, host: true, connection: true,
  "keep-alive": true, "transfer-encoding": true, te: true, trailer: true, upgrade: true, expect: true,
  accept: true, origin: true, referer: true, via: true, forwarded: true, "max-forwards": true,
  "http2-settings": true, "alt-used": true, destination: true, "x-real-ip": true, "x-forwarded": true,
};
const proxyHeaderName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).refine((value) =>
  value === value.trim() && !Object.hasOwn(deniedProxyHeaders, value) &&
  !/^(?:content-|accept-|proxy-|sec-|forwarded-|x-forwarded-|x-http-method|access-control-|x-upstream-|x-original-|x-rewrite-|x-envoy-)/.test(value)
);
const proxyHeaderValue = z.string().max(4096).regex(/^[\x20-\x7e]*$/)
  .refine((value) => value === value.trim());
const proxyHeaderMapping = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("literal"), value: proxyHeaderValue }),
  z.strictObject({
    kind: z.literal("forward"),
    maxBytes: z.number().int().positive().max(4096),
    required: z.boolean(),
    enum: z.array(proxyHeaderValue).min(1).max(64)
      .refine((values) => new Set(values).size === values.length).optional(),
  }).refine((field) => !field.enum || field.enum.every((value) => value.length <= field.maxBytes)),
]);
const proxyRequestHeaders = z.record(proxyHeaderName, proxyHeaderMapping).refine((headers) => {
  const entries = Object.entries(headers);
  return entries.length <= 16 && entries.reduce((bytes, [name, field]) =>
    bytes + name.length + 4 + (field.kind === "literal" ? field.value.length : field.maxBytes), 0) <= 8192;
});

/** Opaque application bytes are data, never transport controls. The trusted installer
 * opts into full request/response disclosure for approved routes and bounded parameters;
 * no caller origin, undeclared query/header, redirect or content negotiation is forwarded. */
export const ServiceProxyOperationPolicySchema = z.strictObject({
  kind: z.literal("http-proxy"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().max(4096).refine((path) => path === "/" || (
    path.startsWith("/") && path.slice(1).split("/").every((part) =>
      /^(?:[A-Za-z0-9_~.-]+|\{[A-Za-z0-9][A-Za-z0-9._-]{0,127}\})$/.test(part) && part !== "." && part !== ".."
    )
  )),
  /** Whole-segment parameters only; decoded values never select transport controls. */
  pathParameters: z.record(name, z.strictObject({
    format: z.enum(["component", "positive-integer"]),
    maxBytes: z.number().int().positive().max(4096),
  })).refine((value) => Object.keys(value).length <= 64).optional(),
  /** Only these scalar fields may appear in the caller query. */
  query: z.record(name, inputField).refine((value) => Object.keys(value).length <= 64).optional(),
  /** Installer-fixed nonsecret values or explicitly bounded caller data, never transport controls. */
  requestHeaders: proxyRequestHeaders.optional(),
  request: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("none") }),
    z.strictObject({ kind: z.literal("json"), disclosure: z.literal("full") }),
  ]),
  response: z.strictObject({
    kind: z.literal("stream"),
    disclosure: z.literal("full"),
    contentTypes: z.array(z.enum(["application/json", "text/event-stream", "text/plain"])).min(1).max(3),
    headers: z.array(z.enum(["retry-after", "x-request-id", "request-id", "etag"])).max(4),
  }),
  timeoutMs: z.number().int().positive().max(300000),
  maxRequestBytes: z.number().int().positive().max(16 * 1024 * 1024),
  maxResponseBytes: z.number().int().positive().max(256 * 1024 * 1024),
}).refine((operation) => operation.method !== "GET" || operation.request.kind === "none")
  .superRefine((operation, ctx) => {
    const parameters = operation.path.split("/").filter((part) => part.startsWith("{")).map((part) => part.slice(1, -1));
    const declared = Object.keys(operation.pathParameters ?? {});
    const query = Object.keys(operation.query ?? {});
    if (new Set(parameters).size !== parameters.length ||
      parameters.some((key) => !Object.hasOwn(operation.pathParameters ?? {}, key)) ||
      declared.some((key) => !parameters.includes(key) || query.includes(key)) ||
      declared.length + query.length > 64)
      ctx.addIssue({ code: "custom", message: "Invalid proxy parameter mapping" });
  });

export const ServiceRuntimeSchema = z.strictObject({
  pluginId: name,
  operationId: name,
  installationRevision: name,
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  resourceBindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  input: z.record(name, z.union([
    z.strictObject({ input: name }),
    z.strictObject({ literal: scalar }),
  ])).refine((value) => Object.keys(value).length <= 64),
});
export type ServiceRuntime = z.infer<typeof ServiceRuntimeSchema>;

/** Owner-installed policy. No raw credential values or caller-selected transport controls. */
export const ServicePolicySchema = z.strictObject({
  serviceId: name,
  revision: name,
  origin: z.url().max(4096).optional(),
  allowLoopbackHttp: z.boolean().optional(),
  runtime: ServiceRuntimeSchema.optional(),
  credential: z.strictObject({
    ref: name,
    header: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).refine((value) =>
      !["host", "connection", "content-length", "transfer-encoding", "content-type", "accept", "accept-encoding", "cookie", "proxy-authorization", "trailer", "te", "upgrade", "expect"].includes(value.toLowerCase()) &&
      !value.toLowerCase().startsWith("proxy-") && !value.toLowerCase().startsWith("sec-")
    ),
    prefix: z.enum(["", "Bearer ", "Basic "]),
  }).optional(),
  maxConcurrent: z.number().int().positive().max(64),
  operations: z.record(name, z.union([ServiceOperationPolicySchema, ServiceProxyOperationPolicySchema])).refine(
    (value) => Object.keys(value).length > 0 && Object.keys(value).length <= 64,
  ),
}).refine((policy) => {
  if (policy.runtime) return policy.origin === undefined && policy.credential === undefined &&
    policy.allowLoopbackHttp === undefined &&
    Object.values(policy.operations).every((operation) => "kind" in operation && operation.kind === "http-proxy");
  if (policy.origin === undefined || policy.allowLoopbackHttp === undefined) return false;
  const url = new URL(policy.origin);
  if (url.username || url.password || url.hash || url.search || policy.origin !== url.origin) return false;
  return url.protocol === "https:" || (
    policy.allowLoopbackHttp && url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "[::1]")
  );
}).refine((policy) => !policy.credential || Object.values(policy.operations).every((operation) =>
  !("kind" in operation) || !Object.hasOwn(operation.requestHeaders ?? {}, policy.credential!.header.toLowerCase())
), { message: "Proxy request header collides with the source credential" })
  .refine((policy) => encodedBytes(policy) <= 128 * 1024, {
  message: "Service policy exceeds the native configuration bound",
});

export type ServiceInput = z.infer<typeof ServiceInputSchema>;
export type ServiceCall = z.infer<typeof ServiceCallSchema>;
export type ServiceReply = z.infer<typeof ServiceReplySchema>;
export type ServiceRefusal = z.infer<typeof ServiceRefusalSchema>;
export type ServiceBinding = z.infer<typeof ServiceBindingSchema>;
export type ServiceResponsePolicy = z.infer<typeof ServiceResponsePolicySchema>;
export type ServiceOperationPolicy = z.infer<typeof ServiceOperationPolicySchema>;
export type ServicePolicy = z.infer<typeof ServicePolicySchema>;
export type ServiceProxyOperationPolicy = z.infer<typeof ServiceProxyOperationPolicySchema>;
