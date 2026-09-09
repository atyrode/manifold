import { fstatSync, readSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  SERVICE_FRAME_BYTES,
  ServiceBindingSchema,
  ServiceCallSchema,
  ServicePolicySchema,
  servicePolicyCredentialRefs,
  type ServiceBinding,
  type ServiceCall,
  type ServiceInput,
  type ServiceOperationPolicy,
  type ServicePolicy,
  type ServiceRefusal,
  type ServiceReply,
} from "@manifold/protocol";

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
  ): Promise<ServiceReply>;
  /** Abort active requests; descriptors supplied by the owner remain borrowed. */
  close(): void;
}
class ServiceFailure extends Error {
  constructor(readonly refusal: ServiceRefusal) {
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
  origin: string,
): { url: URL; body?: string } {
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
  const url = new URL(path, origin);
  if (url.origin !== origin || url.pathname !== path)
    throw new ServiceFailure("service_input_invalid");
  for (const [target, source] of Object.entries(operation.query)) {
    const value = input[source];
    if (value !== undefined) url.searchParams.set(target, String(value));
  }
  // Empty credential leaves bound caller-controlled bytes without reading a source.
  const body = requestBody(operation, input, url);
  return body === undefined ? { url } : { url, body };
}

function requestBody(
  operation: ServiceOperationPolicy,
  input: ServiceInput,
  url: URL,
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
  if (
    Buffer.byteLength(url.pathname + url.search) + Buffer.byteLength(body ?? "") >
    operation.maxRequestBytes
  )
    throw new ServiceFailure("service_input_invalid");
  return body;
}

async function transport(
  url: URL,
  operation: ServiceOperationPolicy,
  body: string | undefined,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted();
  let response: IncomingMessage | undefined;
  try {
    const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: operation.method,
        agent: false,
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
    // No redirects, error bodies, headers, compression or automatic decompression cross the boundary.
    if (
      (response.statusCode ?? 0) < 200 ||
      (response.statusCode ?? 0) >= 300 ||
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
    return Buffer.concat(chunks, size);
  } finally {
    response?.destroy();
  }
}

type Projection = { leaf: boolean; children: Map<string, Projection> };
function projectionTree(fields: string[][]): Projection {
  const root: Projection = { leaf: false, children: new Map() };
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
  return root;
}
function project(
  value: unknown,
  node: Projection,
  maxArrayItems: number,
  budget: { nodes: number },
): unknown {
  if (--budget.nodes < 0) throw new ServiceFailure("service_response_limit");
  if (node.leaf) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return value;
    throw new ServiceFailure("service_response_invalid");
  }
  const wildcard = node.children.get("*");
  if (wildcard) {
    if (!Array.isArray(value)) throw new ServiceFailure("service_response_invalid");
    if (value.length > maxArrayItems) throw new ServiceFailure("service_response_limit");
    return value.map((item) => project(item, wildcard, maxArrayItems, budget));
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ServiceFailure("service_response_invalid");
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, child] of node.children) {
    if (Object.hasOwn(value, key))
      result[key] = project(Reflect.get(value, key), child, maxArrayItems, budget);
  }
  return result;
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
 * Policies are validated and copied once; exact revision bindings and current authorization
 * are checked for every request. This object is transport, not an authority store. */
export function createJobServiceRunner(options: {
  policies: readonly ServicePolicy[];
  resolveCredential?: ResolveServiceCredential;
}): JobServiceRunner {
  const policies = new Map<
    string,
    { policy: ServicePolicy; active: number; projections: Map<string, Projection> }
  >();
  if (options.policies.length > 64) throw new Error("service_policy_invalid");
  for (const raw of options.policies) {
    const parsed = ServicePolicySchema.safeParse(raw);
    if (!parsed.success || policies.has(parsed.data.serviceId))
      throw new Error("service_policy_invalid");
    const policy = parsed.data;
    const projections = new Map<string, Projection>();
    for (const [id, operation] of Object.entries(policy.operations)) {
      if (!("kind" in operation) && operation.response.kind === "projected-json")
        projections.set(id, projectionTree(operation.response.fields));
    }
    policies.set(policy.serviceId, { policy, active: 0, projections });
  }
  const resolveCredential = options.resolveCredential;
  const active = new Set<AbortController>();
  let closed = false;
  return {
    close() {
      closed = true;
      for (const controller of active) controller.abort();
    },
    async call(raw, rawBinding, authorize, callerSignal) {
      const parsed = ServiceCallSchema.safeParse(raw);
      // Invalid envelopes cannot echo arbitrary request IDs (or attacker-injected material).
      const requestId = parsed.success ? parsed.data.requestId : "invalid";
      const refusal = (code: ServiceRefusal): ServiceReply => ({
        type: "service_result",
        requestId,
        ok: false,
        refusal: code,
      });
      if (!parsed.success) return refusal("service_invalid_request");
      if (closed) return refusal("service_closed");
      if (callerSignal?.aborted) return refusal("service_cancelled");
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
      if (!operation || "kind" in operation || !entry.policy.origin)
        return refusal("service_operation_unknown");
      if (entry.active >= entry.policy.maxConcurrent) return refusal("service_busy");
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, operation.timeoutMs);
      const abort = () => controller.abort();
      callerSignal?.addEventListener("abort", abort, { once: true });
      active.add(controller);
      entry.active++;
      const credentials = new Map<string, string>();
      try {
        const prepared = prepareRequest(operation, request.input, entry.policy.origin);
        const authority = Object.freeze({
          serviceId: request.serviceId,
          revision: entry.policy.revision,
          operationId: request.operationId,
          input: Object.freeze(request.input),
        });
        try {
          if (
            (await abortable(authorize(authority, controller.signal), controller.signal)) !== true
          )
            throw new Error("denied");
        } catch {
          throw new ServiceFailure("service_unauthorized");
        }
        controller.signal.throwIfAborted();
        const headers: Record<string, string> = {
          ...operation.requestHeaders,
          "accept-encoding": "identity",
          accept:
            operation.response.kind === "bytes" ? "application/octet-stream" : "application/json",
        };
        if (prepared.body !== undefined) headers["content-type"] = "application/json";
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
        const body = credentials.size
          ? requestBody(operation, request.input, prepared.url, credentials)
          : prepared.body;
        controller.signal.throwIfAborted();
        // Source reads may await rotation. Recheck live authority/availability before I/O.
        if (credentials.size) {
          try {
            if (
              (await abortable(authorize(authority, controller.signal), controller.signal)) !== true
            )
              throw new Error("denied");
          } catch {
            throw new ServiceFailure("service_unauthorized");
          }
        }
        const bytes = await transport(prepared.url, operation, body, headers, controller.signal);
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
          result =
            operation.response.kind === "projected-json"
              ? project(
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
        controller.signal.throwIfAborted();
        // Result is JSON from bounded parsing/projection, never upstream headers or exception text.
        const reply = {
          type: "service_result" as const,
          requestId,
          ok: true as const,
          result: result as Extract<ServiceReply, { ok: true }>["result"],
        };
        if (Buffer.byteLength(JSON.stringify(reply)) + 1 > SERVICE_FRAME_BYTES)
          throw new ServiceFailure("service_response_limit");
        return reply;
      } catch (error) {
        if (controller.signal.aborted)
          return refusal(
            closed ? "service_closed" : timedOut ? "service_timeout" : "service_cancelled",
          );
        return refusal(
          error instanceof ServiceFailure ? error.refusal : "service_upstream_refused",
        );
      } finally {
        credentials.clear();
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", abort);
        active.delete(controller);
        entry.active--;
      }
    },
  };
}
