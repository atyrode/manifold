import { fstatSync, readSync } from "node:fs";
import { Agent, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import {
  canonicalJobJson,
  JsonProjectionError,
  SERVICE_FRAME_BYTES,
  ServiceBindingSchema,
  ServiceCallSchema,
  ServicePolicySchema,
  compileJsonProjection,
  projectJson,
  servicePolicyCredentialRefs,
  quoteDirectService,
  directServiceUsage,
  directServiceCallCost,
  type ServiceDirectAccounting,
  type ServiceCharge,
  type NativeServiceReply,
  type ServiceModelPrice,
  type JsonProjection,
  type ServiceBinding,
  type ServiceCall,
  type ServiceInput,
  type ServiceOperationPolicy,
  type ServicePolicy,
  type ServiceRefusal,
  type ServiceReply,
} from "@manifold/protocol";
import type { JobServiceEndpoint } from "./job-inputs.ts";

/** The owner captures job identity, lineage and current native authority in this closure.
 * Returning true must include the native write-ahead trace before any upstream effect.
 * Honor signal; never retain an authorization decision for a later request. */
export type AuthorizeServiceCall = (
  request: Readonly<{
    serviceId: string;
    revision: string;
    operationId: string;
    input: Readonly<ServiceInput>;
  }>,
  signal: AbortSignal,
) => Promise<boolean>;
/** Trusted owner callback only. Reference names are not paths and never come from child input. */
export type ResolveServiceCredential = (ref: string, signal: AbortSignal) => Promise<string>;
export interface JobServiceRunner {
  call(
    request: ServiceCall,
    binding: ServiceBinding,
    authorize: AuthorizeServiceCall,
    signal?: AbortSignal,
    /** Trusted direct native command only, never copied from worker IPC. */
    accounting?: ServiceDirectAccounting,
  ): Promise<NativeServiceReply>;
  /** Replace the configured policies and return the service ids whose policy changed or was
   * removed. Their active requests are aborted; a policy byte-identical in the new set keeps its
   * active requests, which finish under the policy they were admitted with, and its concurrency. */
  configure(policies: readonly ServicePolicy[]): ReadonlySet<string>;
  /** Abort active requests; descriptors supplied by the owner remain borrowed. */
  close(): void;
}
/**
 * A refusal that knows which fact refused. Exported because the owner's own service paths raise
 * it and the proxy must carry it through instead of reporting every resolver rejection as one
 * unreachable runtime (#708).
 *
 * `detail` is for the HOST's record only — a child job's state, a parent's state — and is never
 * written to a caller's response: the refusal word is already the most a sandboxed caller may
 * learn about the machine serving it.
 */
export class ServiceFailure extends Error {
  constructor(
    readonly refusal: ServiceRefusal,
    readonly detail?: Readonly<Record<string, string>>,
  ) {
    super(refusal);
  }
}

/** Borrow only descriptors safely opened by HeldDirectory.openFile under an owner-private
 * directory. Positional bounded reads never reopen a pathname or consume the owner's offset.
 * The owner keeps descriptors open for the lifetime of this resolver, and owns closing them. */
export function heldServiceCredentialResolver(
  descriptors: ReadonlyMap<string, number>,
): ResolveServiceCredential {
  const held = new Map(descriptors);
  return async (ref, signal) => {
    signal.throwIfAborted();
    const fd = held.get(ref);
    if (fd === undefined) throw new ServiceFailure("service_credential_unavailable");
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      (before.mode & 0o077n) !== 0n ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > 16384n
    )
      throw new ServiceFailure("service_credential_unavailable");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      const after = fstatSync(fd, { bigint: true });
      if (
        offset !== Number(before.size) ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        before.mode !== after.mode ||
        before.nlink !== after.nlink
      )
        throw new ServiceFailure("service_credential_unavailable");
      // A single terminal line ending is file framing, not part of an HTTP credential.
      return new TextDecoder("utf-8", { fatal: true })
        .decode(bytes.subarray(0, offset))
        .replace(/\r?\n$/, "");
    } finally {
      bytes.fill(0);
    }
  };
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const abort = () => reject(new ServiceFailure("service_cancelled"));
  if (signal.aborted) {
    // Consume late callback rejection without leaving an unhandled promise.
    void pending.catch(() => {});
    abort();
    return promise;
  }
  signal.addEventListener("abort", abort, { once: true });
  pending.then(resolve, reject);
  // Cleanup follows the bounded wait, even if a trusted callback ignores cancellation.
  void promise.then(
    () => signal.removeEventListener("abort", abort),
    () => signal.removeEventListener("abort", abort),
  );
  return promise;
}

function prepareRequest(
  operation: ServiceOperationPolicy,
  input: ServiceInput,
): { path: string; body?: string } {
  if (Object.keys(input).some((key) => !Object.hasOwn(operation.input, key)))
    throw new ServiceFailure("service_input_invalid");
  for (const [key, field] of Object.entries(operation.input)) {
    const value = input[key];
    if (value === undefined) {
      if (field.required) throw new ServiceFailure("service_input_invalid");
      continue;
    }
    if (
      (field.type === "string" &&
        (typeof value !== "string" ||
          Buffer.byteLength(value) > field.maxBytes ||
          (field.enum && !field.enum.includes(value)))) ||
      (field.type === "number" &&
        (typeof value !== "number" ||
          value < field.min ||
          value > field.max ||
          (field.integer && !Number.isSafeInteger(value)))) ||
      (field.type === "boolean" && typeof value !== "boolean")
    )
      throw new ServiceFailure("service_input_invalid");
  }
  const path = operation.path
    .split("/")
    .map((part) => {
      if (!part.startsWith("{")) return part;
      const value = input[part.slice(1, -1)];
      // Exact RFC3986 unreserved segment only. Never encode/decode an arbitrary path.
      if (
        typeof value !== "string" ||
        !/^[A-Za-z0-9_~.-]+$/.test(value) ||
        value === "." ||
        value === ".."
      )
        throw new ServiceFailure("service_input_invalid");
      return value;
    })
    .join("/");
  const query = new URLSearchParams();
  for (const [target, source] of Object.entries(operation.query)) {
    const value = input[source];
    if (value !== undefined) query.set(target, String(value));
  }
  // Empty credential leaves bound caller-controlled bytes without reading a source.
  const target = query.size ? `${path}?${query}` : path;
  const body = requestBody(operation, input, target);
  return body === undefined ? { path: target } : { path: target, body };
}

function requestBody(
  operation: ServiceOperationPolicy,
  input: ServiceInput,
  target: string,
  credentials?: ReadonlyMap<string, string>,
): string | undefined {
  const bodyFields: Record<string, unknown> = Object.create(null);
  for (const field of operation.body) {
    const value =
      "input" in field.value
        ? input[field.value.input]
        : "literal" in field.value
          ? field.value.literal
          : credentials === undefined
            ? ""
            : credentials.get(field.value.credentialRef);
    if ("credentialRef" in field.value && value === undefined)
      throw new ServiceFailure("service_credential_unavailable");
    if (value === undefined) continue;
    let node: object = bodyFields;
    for (let i = 0; i < field.path.length - 1; i++) {
      const key = field.path[i]!;
      let child: unknown = Reflect.get(node, key);
      if (child === undefined) {
        child = typeof field.path[i + 1] === "number" ? [] : Object.create(null);
        Reflect.set(node, key, child);
      }
      if (child === null || typeof child !== "object")
        throw new ServiceFailure("service_input_invalid");
      node = child;
    }
    Reflect.set(node, field.path[field.path.length - 1]!, value);
  }
  const body = operation.body.length ? JSON.stringify(bodyFields) : undefined;
  if (Buffer.byteLength(target) + Buffer.byteLength(body ?? "") > operation.maxRequestBytes)
    throw new ServiceFailure("service_input_invalid");
  return body;
}

async function transport(
  url: URL,
  operation: ServiceOperationPolicy,
  body: string | undefined,
  headers: Record<string, string>,
  signal: AbortSignal,
  socket?: Socket,
  accounting = false,
): Promise<{ bytes: Buffer; status: number }> {
  signal.throwIfAborted();
  let response: IncomingMessage | undefined;
  let runtimeAgent: Agent | undefined;
  try {
    if (socket) {
      if (socket.destroyed) throw new ServiceFailure("service_unavailable");
      runtimeAgent = new Agent({ keepAlive: false, maxSockets: 1 });
      let claimed = false;
      // Same single-use handoff as the native proxy: never fall back to Agent's dialer.
      runtimeAgent.createConnection = (_options, callback) => {
        if (claimed || socket.destroyed) {
          callback?.(new ServiceFailure("service_unavailable"), socket);
          return undefined;
        }
        claimed = true;
        return socket;
      };
    }
    const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: operation.method,
        agent: runtimeAgent ?? false,
        signal,
        maxHeaderSize: 16384,
        headers,
        ...(url.protocol === "https:" ? { rejectUnauthorized: true } : {}),
      },
      resolve,
    );
    req.once("error", reject);
    req.end(body);
    response = await promise;
    const status = response.statusCode ?? 0;
    // Bounded accounting may read a charged failure, but never forwards its body. Legacy
    // calls keep rejecting error bodies before reading them; redirects remain forbidden.
    if (
      status < 200 ||
      (status >= 300 && (status < 400 || !accounting)) ||
      (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")
    )
      throw new ServiceFailure("service_upstream_refused");
    const length = response.headers["content-length"];
    if (
      length !== undefined &&
      (!/^\d+$/.test(length) || Number(length) > operation.maxResponseBytes)
    )
      throw new ServiceFailure("service_response_limit");
    if (
      operation.response.kind !== "bytes" &&
      !/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i.test(
        response.headers["content-type"] ?? "",
      )
    )
      throw new ServiceFailure("service_response_invalid");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      signal.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > operation.maxResponseBytes) throw new ServiceFailure("service_response_limit");
      chunks.push(bytes);
    }
    return { bytes: Buffer.concat(chunks, size), status };
  } finally {
    response?.destroy();
    runtimeAgent?.destroy();
  }
}

function inspectJson(value: unknown, credentials: ReadonlyMap<string, string>): void {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const entry = stack.pop()!;
    if (++nodes > 65536 || entry.depth > 32) throw new ServiceFailure("service_response_limit");
    const item = entry.value;
    if (typeof item === "string") {
      for (const secret of credentials.values())
        if (item.includes(secret)) throw new ServiceFailure("service_response_invalid");
    } else if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new ServiceFailure("service_response_invalid");
    } else if (item !== null && typeof item === "object") {
      const entries = Object.entries(item);
      if (entries.length + stack.length > 65536) throw new ServiceFailure("service_response_limit");
      for (const [key, child] of entries) {
        for (const secret of credentials.values())
          if (key.includes(secret)) throw new ServiceFailure("service_response_invalid");
        stack.push({ value: child, depth: entry.depth + 1 });
      }
    }
  }
}

/** One runner per native owner: concurrency is shared across that owner's jobs, not per call.
 * Policies are validated and copied once per configuration; exact revision bindings and current
 * authorization are checked for every request. This object is transport, not an authority store. */
export function createJobServiceRunner(options: {
  policies: readonly ServicePolicy[];
  resolveCredential?: ResolveServiceCredential;
  /** Resolve only within admitted authority. Transfer one fresh, already-proved socket;
   * signal covers producer/owner/configuration revocation, not merely process exit.
   * The resolver must also close pending connections when the request signal aborts. */
  resolveRuntime?: (
    policy: ServicePolicy,
    signal: AbortSignal,
  ) => Promise<JobServiceEndpoint & { signal: AbortSignal; socket: Socket }>;
}): JobServiceRunner {
  interface Entry {
    policy: ServicePolicy;
    canonical: string;
    active: Set<AbortController>;
    projections: Map<string, JsonProjection>;
  }
  // Every policy is checked before any replaces the current set, so a refused configuration
  // leaves the admitted one, and its requests, as they were.
  const admit = (raw: readonly ServicePolicy[], current: ReadonlyMap<string, Entry>) => {
    if (raw.length > 64) throw new Error("service_policy_invalid");
    const next = new Map<string, Entry>();
    for (const item of raw) {
      const parsed = ServicePolicySchema.safeParse(item);
      if (!parsed.success || next.has(parsed.data.serviceId))
        throw new Error("service_policy_invalid");
      const policy = parsed.data;
      const canonical = canonicalJobJson(policy);
      const kept = current.get(policy.serviceId);
      if (kept?.canonical === canonical) {
        next.set(policy.serviceId, kept);
        continue;
      }
      const projections = new Map<string, JsonProjection>();
      for (const [id, operation] of Object.entries(policy.operations)) {
        if (!("kind" in operation) && operation.response.kind === "projected-json")
          projections.set(id, compileJsonProjection(operation.response.fields));
      }
      next.set(policy.serviceId, { policy, canonical, active: new Set(), projections });
    }
    return next;
  };
  let policies = admit(options.policies, new Map());
  const resolveCredential = options.resolveCredential;
  let closed = false;
  return {
    configure(raw) {
      const next = admit(raw, policies);
      const revoked = new Set<string>();
      const previous = policies;
      policies = next;
      for (const [serviceId, entry] of previous) {
        if (next.get(serviceId) === entry) continue;
        revoked.add(serviceId);
        for (const controller of entry.active) controller.abort();
      }
      return revoked;
    },
    close() {
      closed = true;
      for (const entry of policies.values())
        for (const controller of entry.active) controller.abort();
    },
    async call(raw, rawBinding, authorize, callerSignal, accounting) {
      const parsed = ServiceCallSchema.safeParse(raw);
      // Invalid envelopes cannot echo arbitrary request IDs (or attacker-injected material).
      const requestId = parsed.success ? parsed.data.requestId : "invalid";
      let charge: ServiceCharge | undefined = accounting && {
        callId: accounting.callId,
        reservedMicros: accounting.reservedMicros,
        status: "not_dispatched",
        costMicros: 0,
      };
      const refusal = (code: ServiceRefusal): NativeServiceReply => ({
        type: "service_result",
        requestId,
        ok: false,
        refusal: code,
        ...(charge ? { charge } : {}),
      });
      if (!parsed.success) return refusal("service_invalid_request");
      if (closed) return refusal("service_closed");
      if (callerSignal?.aborted) {
        if (charge) charge = { ...charge, status: "unknown", costMicros: null };
        return refusal("service_cancelled");
      }
      const request = parsed.data;
      const entry = policies.get(request.serviceId);
      if (!entry) return refusal("service_unavailable");
      const binding = ServiceBindingSchema.safeParse(rawBinding);
      if (
        !binding.success ||
        binding.data.serviceId !== request.serviceId ||
        binding.data.revision !== entry.policy.revision ||
        !binding.data.operationIds.includes(request.operationId)
      )
        return refusal("service_binding_mismatch");
      const operation = Object.hasOwn(entry.policy.operations, request.operationId)
        ? entry.policy.operations[request.operationId]
        : undefined;
      const instanceRuntime = entry.policy.runtime?.scope === "instance";
      if (
        !operation ||
        "kind" in operation ||
        (!entry.policy.origin && !instanceRuntime) ||
        (instanceRuntime && operation.response.kind !== "projected-json")
      )
        return refusal("service_operation_unknown");
      if (entry.active.size >= entry.policy.maxConcurrent) return refusal("service_busy");
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, operation.timeoutMs);
      const abort = () => controller.abort();
      callerSignal?.addEventListener("abort", abort, { once: true });
      entry.active.add(controller);
      const credentials = new Map<string, string>();
      let runtimeSocket: Socket | undefined;
      let runtimeSignal: AbortSignal | undefined;
      const destroyRuntime = () => runtimeSocket?.destroy();
      controller.signal.addEventListener("abort", destroyRuntime, { once: true });
      try {
        let price: ServiceModelPrice | undefined;
        if (accounting) {
          const quote = quoteDirectService(entry.policy, request.operationId);
          if (!quote.ok) throw new ServiceFailure(quote.refusal);
          if (quote.reservedMicros !== accounting.reservedMicros)
            throw new ServiceFailure("service_accounting_mismatch");
          if (
            quote.reservedMicros > accounting.maxCostMicros ||
            quote.reservedMicros > entry.policy.directCostCeilingMicros!
          )
            throw new ServiceFailure("service_ceiling_exceeded");
          price = entry.policy.prices!.models[quote.modelId]!;
        }
        const prepared = prepareRequest(operation, request.input);
        const authority = Object.freeze({
          serviceId: request.serviceId,
          revision: entry.policy.revision,
          operationId: request.operationId,
          input: Object.freeze(request.input),
        });
        // Only an answer of `false` is a denial; an authorization nobody decided keeps the word
        // that says why (#841).
        const check = async () => {
          let allowed: boolean;
          try {
            allowed = await abortable(authorize(authority, controller.signal), controller.signal);
          } catch (error) {
            throw error instanceof ServiceFailure
              ? error
              : new ServiceFailure("service_unavailable");
          }
          if (allowed !== true) throw new ServiceFailure("service_unauthorized");
          controller.signal.throwIfAborted();
        };
        await check();
        const headers: Record<string, string> = {
          ...operation.requestHeaders,
          "accept-encoding": "identity",
          accept:
            operation.response.kind === "bytes" ? "application/octet-stream" : "application/json",
        };
        if (prepared.body !== undefined) headers["content-type"] = "application/json";
        let origin = entry.policy.origin;
        if (instanceRuntime) {
          if (!options.resolveRuntime) throw new ServiceFailure("service_unavailable");
          const pending = options
            .resolveRuntime(entry.policy, controller.signal)
            .then((runtime) => {
              // A resolver can finish after the bounded wait has already been cancelled.
              if (controller.signal.aborted) {
                runtime.socket.destroy();
                throw new ServiceFailure("service_cancelled");
              }
              runtimeSocket = runtime.socket;
              return runtime;
            });
          const runtime = await abortable(pending, controller.signal);
          if (
            !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(runtime.url) ||
            Number(new URL(runtime.url).port) > 65535 ||
            !/^[A-Za-z0-9_-]{32,128}$/.test(runtime.bearer) ||
            !runtimeSocket ||
            runtimeSocket.destroyed ||
            runtimeSocket.connecting ||
            !runtimeSocket.readable ||
            !runtimeSocket.writable ||
            runtimeSocket.remoteAddress !== "127.0.0.1" ||
            runtimeSocket.remotePort !== Number(new URL(runtime.url).port)
          )
            throw new ServiceFailure("service_unavailable");
          origin = runtime.url;
          credentials.set("runtime", runtime.bearer);
          runtimeSignal = runtime.signal;
          runtimeSignal.addEventListener("abort", abort, { once: true });
          if (runtimeSignal.aborted) controller.abort();
          headers.authorization = `Bearer ${runtime.bearer}`;
        }
        for (const ref of servicePolicyCredentialRefs(entry.policy, [request.operationId])) {
          controller.signal.throwIfAborted();
          try {
            if (!resolveCredential) throw new Error("missing");
            const secret = await abortable(
              resolveCredential(ref, controller.signal),
              controller.signal,
            );
            if (typeof secret !== "string" || !/^[\x21-\x7e]{1,16384}$/.test(secret))
              throw new Error("invalid");
            credentials.set(ref, secret);
          } catch {
            throw new ServiceFailure("service_credential_unavailable");
          }
        }
        const credential = entry.policy.credential;
        if (credential)
          headers[credential.header.toLowerCase()] =
            credential.prefix + credentials.get(credential.ref)!;
        const body =
          credentials.size && !instanceRuntime
            ? requestBody(operation, request.input, prepared.path, credentials)
            : prepared.body;
        controller.signal.throwIfAborted();
        // Source reads may await rotation. Recheck live authority/availability before I/O.
        if (credentials.size) await check();
        controller.signal.throwIfAborted();
        if (!origin) throw new ServiceFailure("service_unavailable");
        const url = new URL(prepared.path, origin);
        if (url.origin !== origin || url.pathname + url.search !== prepared.path)
          throw new ServiceFailure("service_input_invalid");
        if (charge) charge = { ...charge, status: "unknown", costMicros: null };
        const { bytes, status } = await transport(
          url,
          operation,
          body,
          headers,
          controller.signal,
          runtimeSocket,
          accounting !== undefined,
        );
        let result: unknown;
        if (operation.response.kind === "bytes") {
          for (const secret of credentials.values())
            if (bytes.includes(Buffer.from(secret)))
              throw new ServiceFailure("service_response_invalid");
          result = { encoding: "base64", data: bytes.toString("base64") };
        } else {
          let json: unknown;
          try {
            json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          } catch {
            throw new ServiceFailure("service_response_invalid");
          }
          if (charge && price) {
            const usage = directServiceUsage(operation, price, json);
            if (!usage) throw new ServiceFailure("service_accounting_violation");
            const costMicros = directServiceCallCost(price, usage);
            if (costMicros > charge.reservedMicros)
              throw new ServiceFailure("service_accounting_violation");
            charge = { ...charge, status: "known", costMicros };
            if (status >= 400 || usage.failedStatus !== undefined)
              throw new ServiceFailure("service_upstream_refused");
          }
          result =
            operation.response.kind === "projected-json"
              ? projectJson(
                  json,
                  entry.projections.get(request.operationId)!,
                  operation.response.maxArrayItems,
                  { nodes: 65536 },
                )
              : json;
          inspectJson(result, credentials);
        }
        const serialized = JSON.stringify(result);
        if (Buffer.byteLength(serialized) > operation.maxResultBytes)
          throw new ServiceFailure("service_response_limit");
        if (instanceRuntime) await check();
        controller.signal.throwIfAborted();
        // Result is JSON from bounded parsing/projection, never upstream headers or exception text.
        const reply = {
          type: "service_result" as const,
          requestId,
          ok: true as const,
          result: result as Extract<ServiceReply, { ok: true }>["result"],
          ...(charge ? { charge } : {}),
        };
        if (Buffer.byteLength(JSON.stringify(reply)) + 1 > SERVICE_FRAME_BYTES)
          throw new ServiceFailure("service_response_limit");
        return reply;
      } catch (error) {
        if (controller.signal.aborted) {
          if (charge?.status === "not_dispatched")
            charge = { ...charge, status: "unknown", costMicros: null };
          // A request whose policy a reconfiguration replaced was closed by it, not cancelled.
          return refusal(
            closed || policies.get(request.serviceId) !== entry
              ? "service_closed"
              : timedOut
                ? "service_timeout"
                : "service_cancelled",
          );
        }
        return refusal(
          error instanceof JsonProjectionError
            ? error.code === "limit"
              ? "service_response_limit"
              : "service_response_invalid"
            : error instanceof ServiceFailure
              ? error.refusal
              : "service_upstream_refused",
        );
      } finally {
        runtimeSignal?.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", destroyRuntime);
        runtimeSocket?.destroy();
        credentials.clear();
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", abort);
        entry.active.delete(controller);
      }
    },
  };
}
