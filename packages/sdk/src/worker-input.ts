import type { Readable } from "node:stream";
import {
  WORKER_FRAME_BYTES,
  type ServiceReadyRefusal,
  type ServiceRefusal,
} from "@manifold/protocol";

export type WorkerErrorCode =
  | ServiceRefusal
  | ServiceReadyRefusal
  | "worker_invalid_fd"
  | "worker_protocol_error"
  | "worker_frame_limit"
  | "worker_busy"
  | "worker_disconnected"
  | "worker_closed"
  | "worker_cancelled"
  | "worker_input_invalid"
  | "worker_input_closed";

/** Only named refusals cross the application boundary; never raw transport/payload errors. */
export class WorkerError extends Error {
  override readonly name = "WorkerError";
  constructor(readonly code: WorkerErrorCode) {
    super(code);
  }
}

export interface JsonFrameReaderOptions<T> {
  parse(value: unknown): T;
  /** Synchronous delivery; this reader does not queue application work. */
  receive(frame: T): void;
  /** Includes the terminating newline; may only lower the native frame limit. */
  maxFrameBytes?: number;
}

/** Strict UTF-8 NDJSON with one bounded partial frame, including fragmented characters. */
export class JsonFrameReader<T> {
  readonly #buffer: Buffer;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #length = 0;
  #closed = false;

  constructor(private readonly options: JsonFrameReaderOptions<T>) {
    const limit = options.maxFrameBytes ?? WORKER_FRAME_BYTES;
    if (!Number.isSafeInteger(limit) || limit < 2 || limit > WORKER_FRAME_BYTES)
      throw new WorkerError("worker_frame_limit");
    this.#buffer = Buffer.alloc(limit - 1);
  }

  push(chunk: Uint8Array): void {
    if (this.#closed) throw new WorkerError("worker_closed");
    let offset = 0;
    try {
      while (offset < chunk.length && !this.#closed) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const count = end - offset;
        if (this.#length + count > this.#buffer.length) throw new WorkerError("worker_frame_limit");
        this.#buffer.set(chunk.subarray(offset, end), this.#length);
        this.#length += count;
        if (newline < 0) return;
        let value: T;
        try {
          const json: unknown = JSON.parse(
            this.#decoder.decode(this.#buffer.subarray(0, this.#length)),
          );
          value = this.options.parse(json);
        } catch {
          throw new WorkerError("worker_input_invalid");
        } finally {
          this.#buffer.fill(0, 0, this.#length);
          this.#length = 0;
        }
        this.options.receive(value);
        offset = newline + 1;
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** EOF is legal only between frames, never a way to accept a truncated JSON value. */
  end(): void {
    const partial = this.#length !== 0;
    this.close();
    if (partial) throw new WorkerError("worker_input_invalid");
  }

  close(): void {
    this.#buffer.fill(0, 0, this.#length);
    this.#length = 0;
    this.#closed = true;
  }
}

export interface WorkerInputOptions<T> extends JsonFrameReaderOptions<T> {
  input?: Readable;
  signal?: AbortSignal;
  /** Exactly once on EOF, cancellation, or invalid input; not on explicit detach. */
  onClose(error: WorkerError): void;
}

/** Attach bounded typed application control frames to stdin (or an explicitly supplied stream).
 * Domain parsing and prompt/callback authority remain with the application. */
export function attachWorkerInput<T>(options: WorkerInputOptions<T>): () => void {
  const input = options.input ?? process.stdin;
  const reader = new JsonFrameReader(options);
  let detached = false;
  const detach = (): void => {
    if (detached) return;
    detached = true;
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("close", onEnd);
    input.off("error", onError);
    options.signal?.removeEventListener("abort", onAbort);
    input.pause();
    reader.close();
  };
  const finish = (code: WorkerErrorCode): void => {
    if (detached) return;
    detach();
    options.onClose(new WorkerError(code));
  };
  const onData = (chunk: unknown): void => {
    if (!(chunk instanceof Uint8Array)) return finish("worker_input_invalid");
    try {
      reader.push(chunk);
    } catch (error) {
      finish(error instanceof WorkerError ? error.code : "worker_input_invalid");
    }
  };
  const onEnd = (): void => {
    try {
      reader.end();
    } catch {
      return finish("worker_input_invalid");
    }
    finish("worker_input_closed");
  };
  const onError = (): void => finish("worker_disconnected");
  const onAbort = (): void => finish("worker_cancelled");
  input.on("data", onData);
  input.on("end", onEnd);
  input.on("close", onEnd);
  input.on("error", onError);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  else if (input.readableEnded || input.destroyed) onEnd();
  return detach;
}
