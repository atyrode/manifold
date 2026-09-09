import { randomUUID } from "node:crypto";
import { fstatSync } from "node:fs";
import { connect, type Socket } from "node:net";
import {
  WORKER_CONTEXT_FD_ENV,
  WORKER_FRAME_BYTES,
  WORKER_MAX_PENDING,
  WORKER_QUEUE_BYTES,
  ServiceCallSchema,
  ServiceReplySchema,
  ServiceReadySchema,
  ServiceReadyResultSchema,
  WorkerContextSchema,
  type ServiceCall,
  type WorkerLocation,
} from "@manifold/protocol";
import { JsonFrameReader, WorkerError, type WorkerErrorCode } from "./worker-input.ts";

export { JsonFrameReader, WorkerError, attachWorkerInput } from "./worker-input.ts";
export type {
  JsonFrameReaderOptions,
  WorkerErrorCode,
  WorkerInputOptions,
} from "./worker-input.ts";
export type { WorkerLocation } from "@manifold/protocol";

export interface WorkerContextOptions {
  /** Defaults to MANIFOLD_JOB_CONTEXT_FD. Ownership transfers on successful adoption. */
  fd?: number | string;
  signal?: AbortSignal;
}

export interface WorkerContext {
  /** Owner-resolved locations, available only after the strict initial context frame. */
  readonly ready: Promise<readonly WorkerLocation[]>;
  /** Aborts on owner disconnect, protocol failure, explicit close, or caller cancellation. */
  readonly signal: AbortSignal;
  /** Returns only the owner's authorized projection, never an upstream transport response. */
  callService(request: Pick<ServiceCall, "serviceId" | "operationId" | "input">): Promise<unknown>;
  /** Resolves only after the owner accepts this child's runtime-service readiness. One attempt. */
  announceServiceReady(port: number): Promise<void>;
  close(): void;
}

interface PendingRequest {
  kind: "service" | "service_ready";
  frame: Buffer;
  sent: boolean;
  resolve(value: unknown): void;
  reject(error: WorkerError): void;
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
  #failure: WorkerError | undefined;

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
      pending.reject(error);
    }
    this.#pending.clear();
    this.#pendingBytes = 0;
    this.socket.destroy();
    this.#controller.abort(error);
  }
}
