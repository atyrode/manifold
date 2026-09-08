import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ServiceBindingSchema, ServicePolicySchema, type ServiceBinding, type ServicePolicy } from "@manifold/protocol";
import type { AuthorizeServiceCall, ResolveServiceCredential } from "./job-services.ts";

type ProxyOperation = Extract<ServicePolicy["operations"][string], { kind: "http-proxy" }>;
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
  /** Captures exact job identity and current authority; input is empty because the
   * opaque application body cannot select authority. Includes native write-ahead trace. */
  authorize: AuthorizeServiceCall;
  signal?: AbortSignal;
}
class ProxyFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
function boundedWait<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const abort = () => reject(new ProxyFailure(503, "service_cancelled"));
  if (signal.aborted) { void pending.catch(() => {}); abort(); return promise; }
  signal.addEventListener("abort", abort, { once: true });
  pending.then(resolve, reject);
  void promise.then(
    () => signal.removeEventListener("abort", abort),
    () => signal.removeEventListener("abort", abort),
  );
  return promise;
}
const JSON_ESCAPES: Readonly<Record<string, string>> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const EMPTY_BYTES = Buffer.alloc(0);
function normalizedEcho(value: string): string {
  return value.replace(/\\u00([0-9a-f]{2})|\\(["\\/bfnrt])/gi, (_all, hex: string | undefined, escaped: string) =>
    hex ? String.fromCharCode(Number.parseInt(hex, 16)) : (JSON_ESCAPES[escaped] ?? escaped));
}
/** Withhold the longest possible encoded credential suffix before releasing bytes.
 * The window is bounded by credential length, not response length; handles split chunks. */
class BoundedBody extends Transform {
  private count = 0;
  private tail: Buffer = EMPTY_BYTES;
  private readonly keep: number;
  private readonly patterns: string[];
  private readonly starts = new Uint8Array(256);
  constructor(private readonly limit: number, secret?: string) {
    super({ highWaterMark: 16384 });
    this.patterns = secret ? [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")] : [];
    this.keep = this.patterns.length ? Math.max(...this.patterns.map((pattern) => pattern.length)) * 6 : 0;
    this.starts[92] = 1;
    for (const pattern of this.patterns) this.starts[pattern.charCodeAt(0)] = 1;
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.count += chunk.length;
    if (this.count > this.limit) { done(new ProxyFailure(502, "service_response_limit")); return; }
    const bytes = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
    if (this.patterns.length) {
      const text = normalizedEcho(bytes.toString("latin1"));
      if (this.patterns.some((pattern) => text.includes(pattern))) {
        done(new ProxyFailure(502, "service_response_invalid")); return;
      }
    }
    let released = bytes.length;
    // Release immediately unless a suffix could start an echo (including JSON escapes).
    // No full-body aggregation, even for long-lived event streams.
    if (this.keep) {
      for (let i = Math.max(0, bytes.length - this.keep); i < bytes.length; i++) {
        if (this.starts[bytes[i]!] === 1) { released = i; break; }
      }
    }
    if (released) this.push(bytes.subarray(0, released));
    this.tail = released === bytes.length ? EMPTY_BYTES : Buffer.from(bytes.subarray(released));
    done();
  }
  override _flush(done: TransformCallback): void { this.push(this.tail); this.tail = EMPTY_BYTES; done(); }
}
function fail(response: ServerResponse, error: unknown): void {
  if (response.destroyed) return;
  if (response.headersSent) { response.destroy(); return; }
  const failure = error instanceof ProxyFailure ? error : new ProxyFailure(502, "service_upstream_refused");
  // Never serialize an SDK, socket, credential resolver or authorization exception.
  response.writeHead(failure.status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
  response.end(JSON.stringify({ error: failure.code }));
}
function contentType(value: string | undefined): string | undefined {
  return value?.match(/^(application\/json|text\/event-stream|text\/plain)(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i)?.[1]?.toLowerCase();
}

/** One immutable trusted policy/binding snapshot and one independently random capability
 * per job. No worker-selected policy, credentials, origin, route templates or redirects. */
export async function createJobServiceProxy(options: JobServiceProxyOptions): Promise<JobServiceProxy> {
  const { authorize, resolveCredential, signal } = options;
  signal?.throwIfAborted();
  const policies = new Map<string, { policy: ServicePolicy; active: number }>();
  const routes = new Map<string, { entry: { policy: ServicePolicy; active: number }; operation: ProxyOperation; operationId: string }>();
  if (options.policies.length > 64 || options.bindings.length > 64) throw new Error("service_policy_invalid");
  for (const raw of options.policies) {
    const parsed = ServicePolicySchema.safeParse(raw);
    if (!parsed.success || policies.has(parsed.data.serviceId)) throw new Error("service_policy_invalid");
    policies.set(parsed.data.serviceId, { policy: parsed.data, active: 0 });
  }
  const bound = new Set<string>();
  for (const raw of options.bindings) {
    const parsed = ServiceBindingSchema.safeParse(raw);
    if (!parsed.success) throw new Error("service_binding_mismatch");
    const binding = parsed.data;
    const entry = policies.get(binding.serviceId);
    if (!entry || bound.has(binding.serviceId) || binding.revision !== entry.policy.revision) throw new Error("service_binding_mismatch");
    bound.add(binding.serviceId);
    for (const operationId of binding.operationIds) {
      const operation = Object.hasOwn(entry.policy.operations, operationId) ? entry.policy.operations[operationId] : undefined;
      if (!operation) throw new Error("service_binding_mismatch");
      if (!("kind" in operation)) continue;
      const key = `${operation.method} ${operation.path}`;
      if (routes.has(key)) throw new Error("service_policy_invalid");
      routes.set(key, { entry, operation, operationId });
    }
  }
  if (!routes.size) throw new Error("service_unavailable");
  const bearer = randomBytes(32).toString("base64url");
  const capability = Buffer.from(`Bearer ${bearer}`);
  const active = new Set<AbortController>();
  let closed = false;
  let host = "";
  let closing: Promise<void> | undefined;
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 300000, headersTimeout: 10000, keepAliveTimeout: 1000 }, (request, response) => {
    void handle(request, response).catch((error: unknown) => fail(response, error));
  });
  server.maxConnections = 128;
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("checkContinue", (_request, response) => fail(response, new ProxyFailure(400, "service_invalid_request")));
  server.on("checkExpectation", (_request, response) => fail(response, new ProxyFailure(400, "service_invalid_request")));

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (closed || supplied.length !== capability.length || !timingSafeEqual(supplied, capability))
      throw new ProxyFailure(401, "service_unauthorized");
    // Exact raw origin-form target: no normalization, decoding, query, absolute URL or CORS.
    if (request.headers.host !== host || request.headers.origin !== undefined || request.headers["content-encoding"] !== undefined)
      throw new ProxyFailure(400, "service_invalid_request");
    const route = routes.get(`${request.method} ${request.url}`);
    if (!route) throw new ProxyFailure(404, "service_operation_unknown");
    const { entry, operation, operationId } = route;
    const length = request.headers["content-length"];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > operation.maxRequestBytes))
      throw new ProxyFailure(413, "service_input_invalid");
    if (operation.request.kind === "none") {
      if ((length !== undefined && Number(length) !== 0) || request.headers["transfer-encoding"] !== undefined)
        throw new ProxyFailure(400, "service_input_invalid");
    } else if (contentType(request.headers["content-type"]) !== "application/json") {
      throw new ProxyFailure(415, "service_input_invalid");
    }
    if (entry.active >= entry.policy.maxConcurrent) throw new ProxyFailure(429, "service_busy");
    const controller = new AbortController();
    active.add(controller);
    entry.active++;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, operation.timeoutMs);
    const disconnect = () => { if (!response.writableFinished) controller.abort(); };
    const abandoned = () => controller.abort();
    request.once("aborted", abandoned);
    response.once("close", disconnect);
    let upstream: IncomingMessage | undefined;
    let secret: string | undefined;
    try {
      const authority = Object.freeze({ serviceId: entry.policy.serviceId, revision: entry.policy.revision, operationId, input: Object.freeze({}) });
      const check = async () => {
        try {
          if (await boundedWait(authorize(authority, controller.signal), controller.signal) !== true) throw new Error("denied");
        } catch { throw new ProxyFailure(403, "service_unauthorized"); }
        controller.signal.throwIfAborted();
      };
      await check();
      const headers: Record<string, string> = { "accept-encoding": "identity", accept: operation.response.contentTypes.join(", ") };
      if (operation.request.kind === "json") headers["content-type"] = "application/json";
      const credential = entry.policy.credential;
      if (credential) {
        try {
          if (!resolveCredential) throw new Error("missing");
          secret = await boundedWait(resolveCredential(credential.ref, controller.signal), controller.signal);
          if (typeof secret !== "string" || !/^[\x21-\x7e]{1,16384}$/.test(secret)) throw new Error("invalid");
          headers[credential.header.toLowerCase()] = credential.prefix + secret;
        } catch { throw new ProxyFailure(503, "service_credential_unavailable"); }
        await check();
      }
      controller.signal.throwIfAborted();
      const url = new URL(operation.path, entry.policy.origin);
      const received = Promise.withResolvers<IncomingMessage>();
      const outgoing = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: operation.method, headers, signal: controller.signal, agent: false, maxHeaderSize: 16384,
        ...(url.protocol === "https:" ? { rejectUnauthorized: true } : {}),
      }, received.resolve);
      outgoing.once("error", received.reject);
      // Upload and download are concurrent; each stream's backpressure bounds buffering.
      const upload = pipeline(request, new BoundedBody(operation.maxRequestBytes), outgoing, { signal: controller.signal });
      void upload.catch(() => controller.abort());
      upstream = await received.promise;
      const status = upstream.statusCode ?? 0;
      if (status < 200 || (status >= 300 && status < 400) || status > 599 ||
        (upstream.headers["content-encoding"] && upstream.headers["content-encoding"] !== "identity"))
        throw new ProxyFailure(502, "service_upstream_refused");
      const responseLength = upstream.headers["content-length"];
      if (responseLength !== undefined && (!/^\d+$/.test(responseLength) || Number(responseLength) > operation.maxResponseBytes))
        throw new ProxyFailure(502, "service_response_limit");
      const mime = contentType(upstream.headers["content-type"]);
      const hopHeaders = new Set((upstream.headers.connection ?? "").toLowerCase().split(",").map((part) => part.trim()));
      if (hopHeaders.has("content-type")) throw new ProxyFailure(502, "service_response_invalid");
      if (status !== 204 && (!mime || !operation.response.contentTypes.includes(mime as ProxyOperation["response"]["contentTypes"][number])))
        throw new ProxyFailure(502, "service_response_invalid");
      const safeHeaders: Record<string, string> = { "cache-control": "no-store" };
      if (mime) safeHeaders["content-type"] = `${mime}; charset=utf-8`;
      for (const name of operation.response.headers) {
        const value = upstream.headers[name];
        if (typeof value === "string" && value.length <= 1024 && /^[\x20-\x7e]*$/.test(value) && !hopHeaders.has(name) &&
          (!credential || name !== credential.header.toLowerCase()) &&
          (!secret || ![secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")].some((pattern) => normalizedEcho(value).includes(pattern)))) safeHeaders[name] = value;
      }
      response.writeHead(status, safeHeaders);
      // Headers may precede data; secret-bearing or oversized tails terminate, never expose error text.
      response.flushHeaders();
      await pipeline(upstream, new BoundedBody(operation.maxResponseBytes, secret), response, { signal: controller.signal });
      await upload;
    } catch (error) {
      fail(response, controller.signal.aborted ? new ProxyFailure(503, timedOut ? "service_timeout" : "service_cancelled") : error);
    } finally {
      controller.abort();
      upstream?.destroy();
      secret = undefined;
      clearTimeout(timer);
      request.removeListener("aborted", abandoned);
      response.removeListener("close", disconnect);
      active.delete(controller);
      entry.active--;
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
  const abort = () => { void close(); };
  const listening = Promise.withResolvers<void>();
  const listenError = () => listening.reject(new Error("service_unavailable"));
  server.once("error", listenError);
  server.listen(0, "127.0.0.1", () => { server.removeListener("error", listenError); listening.resolve(); });
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") { await close(); throw new Error("service_unavailable"); }
  host = `127.0.0.1:${address.port}`;
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) { await close(); throw new Error("service_cancelled"); }
  return Object.freeze({ url: `http://${host}`, bearer, close });
}
