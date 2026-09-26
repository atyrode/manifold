import { randomUUID } from "node:crypto";
import { fstatSync } from "node:fs";
import { connect, type Socket } from "node:net";
import {
  AGENT_TOOL_CHUNK_CHARS,
  AGENT_TOOL_MAX_CALLS,
  AGENT_TOOL_MAX_REPLY_BYTES,
  AgentToolRequestSchema,
  AgentToolReplySchema,
  WorkerAgentRunCallSchema,
  WorkerAgentRunResultSchema,
  type AgentToolRequest,
  type AgentToolReply,
  WORKER_CONTEXT_FD_ENV,
  WORKER_FRAME_BYTES,
  WORKER_MAX_PENDING,
  WORKER_QUEUE_BYTES,
  ServiceCallSchema,
  ServiceReplySchema,
  ServiceReadySchema,
  ServiceReadyResultSchema,
  WorkerContextSchema,
  WorkerProgressSchema,
  type ServiceCall,
  type WorkerLocation,
  type WorkerProgress,
} from "@manifold/protocol";
import { JsonFrameReader, WorkerError, type WorkerErrorCode } from "./worker-input.ts";

export { JsonFrameReader, WorkerError, attachWorkerInput } from "./worker-input.ts";
export type {
  JsonFrameReaderOptions,
  WorkerErrorCode,
  WorkerInputOptions,
} from "./worker-input.ts";
export type {
  AgentToolRequest,
  AgentToolReply,
  WorkerLocation,
  WorkerProgress,
} from "@manifold/protocol";

export interface WorkerContextOptions {
  /** Defaults to MANIFOLD_JOB_CONTEXT_FD. Ownership transfers on successful adoption. */
  fd?: number | string;
  signal?: AbortSignal;
}

/**
 * How many bytes of unflushed stages the socket may hold, independent of the reply queue.
 *
 * Its own number because the two have opposite failure modes: a full reply queue ends the
 * context, while a stage that does not fit is dropped. Deliberately small — the owner keeps
 * only the newest line per window, so anything queued behind a few hundred bytes is already
 * destined to be discarded.
 */
const PROGRESS_QUEUE_BYTES = 8 * 1024;

export interface WorkerContext {
  /** Owner-resolved locations, available only after the strict initial context frame. */
  readonly ready: Promise<readonly WorkerLocation[]>;
  /** Aborts on owner disconnect, protocol failure, explicit close, or caller cancellation. */
  readonly signal: AbortSignal;
  /** Returns only the owner's authorized projection, never an upstream transport response. */
  callService(request: Pick<ServiceCall, "serviceId" | "operationId" | "input">): Promise<unknown>;
  /** Uses only this native job's host-bound Run. Never selects identity or retries an effect. */
  callAgent(request: AgentToolRequest, options?: { signal?: AbortSignal }): Promise<AgentToolReply>;
  /** Resolves only after the owner accepts this child's runtime-service readiness. One attempt. */
  announceServiceReady(port: number): Promise<void>;
  /**
   * Says where this workload is. Fire and forget: the owner answers nothing, coalesces to at
   * most one event every five seconds per job, and the newest line always wins — so reporting
   * often is cheap and reporting a stale phase is the only mistake available.
   *
   * Throws `worker_progress_invalid` for a stage that is not 1–64 characters of lowercase
   * `[a-z0-9 ._-]` without a leading or trailing space, a `message` over 256 characters or
   * carrying a control character, or a `fraction` outside 0..1 — validated HERE so a bad
   * stage costs a caught error rather than the run. A workload that writes the same frame
   * to `MANIFOLD_JOB_CONTEXT_FD` by hand gets no such grace: the owner fails that channel
   * with `context_protocol_error` and cancels the job. A valid stage is never fatal; one
   * that does not fit the outbound budget is silently dropped.
   */
  reportProgress(progress: Omit<WorkerProgress, "type">): void;
  close(): void;
}

interface PendingRequest {
  kind: "service" | "service_ready" | "agent_run";
  frame: Buffer;
  sent: boolean;
  resolve(value: unknown): void;
  reject(error: WorkerError): void;
  agent?: {
    request: AgentToolRequest;
    seq: number;
    bytes: number;
    parts: string[];
    cleanup(): void;
  };
}

/** Opens the native ABI, not a caller-selected network endpoint. No React dependency. */
export function openWorkerContext(options: WorkerContextOptions = {}): WorkerContext {
  if (options.signal?.aborted) throw new WorkerError("worker_cancelled");
  const raw = options.fd ?? process.env[WORKER_CONTEXT_FD_ENV];
  let socket: Socket;
  try {
    if (typeof raw !== "number" && (typeof raw !== "string" || !/^[0-9]{1,10}$/.test(raw)))
      throw new WorkerError("worker_invalid_fd");
    const fd = Number(raw);
    if (!Number.isSafeInteger(fd) || fd < 3 || fd > 0x7fffffff || !fstatSync(fd).isSocket())
      throw new WorkerError("worker_invalid_fd");
    // Bun adopts inherited sockets through connect({fd}), not new Socket({fd}).
    // node:net's declarations do not yet include this Bun overload.
    const connectFd = connect as unknown as (options: { fd: number }) => Socket;
    socket = connectFd({ fd });
  } catch {
    throw new WorkerError("worker_invalid_fd");
  }
  return new NativeWorkerContext(socket, options.signal);
}

class NativeWorkerContext implements WorkerContext {
  readonly #controller = new AbortController();
  readonly signal = this.#controller.signal;
  readonly #ready = Promise.withResolvers<readonly WorkerLocation[]>();
  readonly ready = this.#ready.promise;
  readonly #reader: JsonFrameReader<unknown>;
  readonly #pending = new Map<string, PendingRequest>();
  #pendingBytes = 0;
  #queuedBytes = 0;
  #receivedContext = false;
  #announced = false;
  #progressBytes = 0;
  #failure: WorkerError | undefined;
  #agentCalls = 0;
  #agentReplyBytes = 0;
  readonly #cancelledAgentReplies = new Map<string, { seq: number; bytes: number }>();

  constructor(
    private readonly socket: Socket,
    private readonly parentSignal: AbortSignal | undefined,
  ) {
    // The lifetime may end before the application starts awaiting context readiness.
    void this.ready.catch(() => undefined);
    this.#reader = new JsonFrameReader({
      parse: (value) => value,
      receive: (value) => this.#receive(value),
    });
    socket.on("data", this.#data);
    socket.on("error", this.#disconnect);
    socket.on("end", this.#disconnect);
    socket.on("close", this.#disconnect);
    parentSignal?.addEventListener("abort", this.#cancel, { once: true });
    if (parentSignal?.aborted) this.#cancel();
  }

  async callService(
    request: Pick<ServiceCall, "serviceId" | "operationId" | "input">,
  ): Promise<unknown> {
    if (this.#failure) throw this.#failure;
    // Check before validation/serialization so saturation cannot accumulate waiting closures.
    if (this.#pending.size >= WORKER_MAX_PENDING) throw new WorkerError("worker_busy");
    let call: ServiceCall;
    try {
      call = ServiceCallSchema.parse({ ...request, type: "service", requestId: randomUUID() });
    } catch {
      throw new WorkerError("service_input_invalid");
    }
    return this.#request(call.requestId, "service", call);
  }

  async callAgent(
    request: AgentToolRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentToolReply> {
    if (options.signal?.aborted || this.#failure)
      return {
        type: "refused",
        code: this.#failure ? "authority_unavailable" : "cancelled",
        traceId: null,
      };
    if (this.#pending.size >= WORKER_MAX_PENDING)
      return { type: "refused", code: "saturated", traceId: null };
    if (this.#agentCalls >= AGENT_TOOL_MAX_CALLS)
      return { type: "refused", code: "limit_exceeded", traceId: null };
    const parsed = AgentToolRequestSchema.safeParse(request);
    if (!parsed.success) return { type: "refused", code: "malformed_request", traceId: null };
    const requestId = randomUUID();
    const call = WorkerAgentRunCallSchema.safeParse({
      type: "agent_run",
      requestId,
      payload: parsed.data,
    });
    if (!call.success) return { type: "refused", code: "malformed_request", traceId: null };
    const frame = Buffer.from(`${JSON.stringify(call.data)}\n`);
    if (this.#pendingBytes + frame.length > WORKER_QUEUE_BYTES)
      return { type: "refused", code: "saturated", traceId: null };
    const reply = Promise.withResolvers<AgentToolReply>();
    const abort = () => {
      const pending = this.#pending.get(requestId);
      if (!pending) return;
      this.#pending.delete(requestId);
      this.#pendingBytes -= pending.frame.length;
      this.#agentReplyBytes -= pending.agent!.bytes;
      pending.agent!.parts = [];
      pending.agent!.cleanup();
      if (pending.sent) {
        this.#cancelledAgentReplies.set(requestId, {
          seq: pending.agent!.seq,
          bytes: pending.agent!.bytes,
        });
        // Cancellation has no reply of its own; the interrupted call retains correlation.
        const cancel = Buffer.from(`${JSON.stringify({ type: "agent_run_cancel", requestId })}\n`);
        if (this.#queuedBytes + cancel.length > WORKER_QUEUE_BYTES) this.#finish("worker_busy");
        else {
          this.#queuedBytes += cancel.length;
          try {
            this.socket.write(cancel, (error) => {
              this.#queuedBytes -= cancel.length;
              if (error) this.#finish("worker_disconnected");
            });
          } catch {
            this.#queuedBytes -= cancel.length;
            this.#finish("worker_disconnected");
          }
        }
        reply.resolve({ type: "unknown", reason: "cancelled", traceId: null });
      } else {
        pending.frame.fill(0);
        reply.resolve({ type: "refused", code: "cancelled", traceId: null });
      }
    };
    const pending: PendingRequest = {
      kind: "agent_run",
      frame,
      sent: false,
      resolve: (value) => reply.resolve(value as AgentToolReply),
      reject: reply.reject,
      agent: {
        request: parsed.data,
        seq: 0,
        bytes: 0,
        parts: [],
        cleanup: () => options.signal?.removeEventListener("abort", abort),
      },
    };
    this.#agentCalls++;
    this.#pending.set(requestId, pending);
    this.#pendingBytes += frame.length;
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    else if (this.#receivedContext) this.#send(pending);
    return reply.promise;
  }

  async announceServiceReady(port: number): Promise<void> {
    if (this.#failure) throw this.#failure;
    if (this.#announced) throw new WorkerError("service_ready_duplicate");
    const request = ServiceReadySchema.safeParse({
      type: "service_ready",
      requestId: randomUUID(),
      port,
    });
    if (!request.success) throw new WorkerError("service_invalid_request");
    this.#announced = true;
    await this.#request(request.data.requestId, "service_ready", request.data);
  }

  reportProgress(progress: Omit<WorkerProgress, "type">): void {
    if (this.#failure) return;
    const frame = WorkerProgressSchema.safeParse({ ...progress, type: "progress" });
    if (!frame.success) throw new WorkerError("worker_progress_invalid");
    const bytes = Buffer.from(`${JSON.stringify(frame.data)}\n`);
    // Stages get their own budget, never the reply queue's. `#send` finishes the whole
    // context when that queue is full, so bytes a disposable stage put on the wire must not
    // be able to reject a call the application is awaiting — and a stage that does not fit
    // is simply dropped, which is what coalescing does to it upstream anyway.
    if (this.#progressBytes + bytes.length > PROGRESS_QUEUE_BYTES) return;
    this.#progressBytes += bytes.length;
    try {
      this.socket.write(bytes, (error) => {
        this.#progressBytes -= bytes.length;
        if (error) this.#finish("worker_disconnected");
      });
    } catch {
      this.#progressBytes -= bytes.length;
      this.#finish("worker_disconnected");
    }
  }

  #request(requestId: string, kind: PendingRequest["kind"], value: unknown): Promise<unknown> {
    if (this.#pending.size >= WORKER_MAX_PENDING)
      return Promise.reject(new WorkerError("worker_busy"));
    const frame = Buffer.from(`${JSON.stringify(value)}\n`);
    if (frame.length > WORKER_FRAME_BYTES) {
      frame.fill(0);
      return Promise.reject(new WorkerError("worker_frame_limit"));
    }
    if (this.#pendingBytes + frame.length > WORKER_QUEUE_BYTES) {
      frame.fill(0);
      return Promise.reject(new WorkerError("worker_busy"));
    }
    const reply = Promise.withResolvers<unknown>();
    const pending: PendingRequest = {
      kind,
      frame,
      sent: false,
      resolve: reply.resolve,
      reject: reply.reject,
    };
    this.#pending.set(requestId, pending);
    this.#pendingBytes += frame.length;
    if (this.#receivedContext) this.#send(pending);
    return reply.promise;
  }

  #send(pending: PendingRequest): void {
    if (this.#failure) return;
    if (this.#queuedBytes + pending.frame.length > WORKER_QUEUE_BYTES) {
      this.#finish("worker_busy");
      return;
    }
    pending.sent = true;
    this.#queuedBytes += pending.frame.length;
    try {
      this.socket.write(pending.frame, (error) => {
        this.#queuedBytes -= pending.frame.length;
        // Never clear a buffer while the socket still holds an incomplete write.
        pending.frame.fill(0);
        if (error) this.#finish("worker_disconnected");
      });
    } catch {
      this.#queuedBytes -= pending.frame.length;
      pending.frame.fill(0);
      this.#finish("worker_disconnected");
    }
  }

  #receive(raw: unknown): void {
    if (this.#failure) return;
    if (!this.#receivedContext) {
      const context = WorkerContextSchema.parse(raw);
      this.#receivedContext = true;
      this.#ready.resolve(
        Object.freeze(context.locations.map((location) => Object.freeze(location))),
      );
      for (const pending of this.#pending.values()) this.#send(pending);
      return;
    }
    if (
      typeof raw === "object" &&
      raw !== null &&
      Reflect.get(raw, "type") === "agent_run_result"
    ) {
      const chunk = WorkerAgentRunResultSchema.parse(raw);
      const pending = this.#pending.get(chunk.requestId);
      const cancelled = this.#cancelledAgentReplies.get(chunk.requestId);
      const state = pending?.agent ?? cancelled;
      if (
        !state ||
        (pending && (!pending.sent || pending.kind !== "agent_run")) ||
        chunk.seq !== state.seq
      )
        throw new WorkerError("worker_protocol_error");
      if (
        chunk.data.length === 0 ||
        chunk.seq >= Math.ceil(AGENT_TOOL_MAX_REPLY_BYTES / (AGENT_TOOL_CHUNK_CHARS - 1))
      )
        throw new WorkerError("worker_frame_limit");
      const bytes = Buffer.byteLength(chunk.data);
      state.bytes += bytes;
      state.seq++;
      if (state.bytes > AGENT_TOOL_MAX_REPLY_BYTES) throw new WorkerError("worker_frame_limit");
      if (cancelled) {
        if (chunk.end) this.#cancelledAgentReplies.delete(chunk.requestId);
        return;
      }
      this.#agentReplyBytes += bytes;
      if (this.#agentReplyBytes > AGENT_TOOL_MAX_REPLY_BYTES)
        throw new WorkerError("worker_frame_limit");
      const agent = pending!.agent!;
      agent.parts.push(chunk.data);
      if (!chunk.end) return;
      const reply = AgentToolReplySchema.parse(JSON.parse(agent.parts.join("")));
      if (
        reply.type !== "refused" &&
        reply.type !== "unknown" &&
        (agent.request.type === "describe"
          ? reply.type !== "description"
          : agent.request.type === "policy"
            ? reply.type !== "policy"
            : reply.type !== "result" ||
              (agent.request.type === "invoke" && reply.door !== agent.request.door) ||
              (agent.request.type === "ack" && reply.door !== "core.access.acknowledgeAgentPolicy"))
      )
        throw new WorkerError("worker_protocol_error");
      this.#pending.delete(chunk.requestId);
      this.#pendingBytes -= pending!.frame.length;
      this.#agentReplyBytes -= agent.bytes;
      agent.cleanup();
      pending!.resolve(reply);
      return;
    }
    const readiness =
      typeof raw === "object" &&
      raw !== null &&
      Reflect.get(raw, "type") === "service_ready_result";
    const reply = readiness ? ServiceReadyResultSchema.parse(raw) : ServiceReplySchema.parse(raw);
    const pending = this.#pending.get(reply.requestId);
    if (!pending || !pending.sent || pending.kind !== (readiness ? "service_ready" : "service"))
      throw new WorkerError("worker_protocol_error");
    this.#pending.delete(reply.requestId);
    this.#pendingBytes -= pending.frame.length;
    if (!reply.ok) pending.reject(new WorkerError(reply.refusal));
    else pending.resolve("result" in reply ? reply.result : undefined);
  }

  readonly #data = (chunk: Buffer): void => {
    try {
      this.#reader.push(chunk);
    } catch (error) {
      this.#finish(
        error instanceof WorkerError && error.code === "worker_frame_limit"
          ? "worker_frame_limit"
          : "worker_protocol_error",
      );
    }
  };
  readonly #disconnect = (): void => this.#finish("worker_disconnected");
  readonly #cancel = (): void => this.#finish("worker_cancelled");

  close(): void {
    this.#finish("worker_closed");
  }

  #finish(code: WorkerErrorCode): void {
    if (this.#failure) return;
    const error = new WorkerError(code);
    this.#failure = error;
    this.parentSignal?.removeEventListener("abort", this.#cancel);
    this.socket.off("data", this.#data);
    this.#reader.close();
    this.#ready.reject(error);
    for (const pending of this.#pending.values()) {
      if (!pending.sent) pending.frame.fill(0);
      if (pending.agent) {
        pending.agent.cleanup();
        pending.resolve(
          pending.sent
            ? {
                type: "unknown",
                reason:
                  code === "worker_protocol_error" || code === "worker_frame_limit"
                    ? "protocol_error"
                    : code === "worker_cancelled"
                      ? "cancelled"
                      : "disconnected",
                traceId: null,
              }
            : {
                type: "refused",
                code: code === "worker_cancelled" ? "cancelled" : "authority_unavailable",
                traceId: null,
              },
        );
      } else pending.reject(error);
    }
    this.#pending.clear();
    this.#pendingBytes = 0;
    this.#cancelledAgentReplies.clear();
    this.#agentReplyBytes = 0;
    this.socket.destroy();
    this.#controller.abort(error);
  }
}
