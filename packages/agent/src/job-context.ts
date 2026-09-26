import { randomUUID } from "node:crypto";
import { closeSync } from "node:fs";
import type { Socket } from "node:net";
import { privateSocketPair } from "./job-files.ts";
import {
  AGENT_TOOL_CHUNK_CHARS,
  AGENT_TOOL_MAX_CALLS,
  AGENT_TOOL_MAX_REPLY_BYTES,
  WorkerAgentRunCallSchema,
  WorkerAgentRunCancelSchema,
  JobCommandSchema,
  JobRequestSchema,
  ServiceCallSchema,
  ServiceReplySchema,
  ServiceReadySchema,
  ServiceReadyResultSchema,
  WorkerProgressSchema,
  type ServiceCall,
  type ServiceReply,
  type ServiceReadyRefusal,
  type JobCommand,
  type JobEvent,
  type WorkerProgress,
} from "@manifold/protocol";
import { FrameReader } from "./ipc-framing.ts";

const MAX_CONTEXT_BYTES = 256 * 1024;
export interface BoundInvocation {
  readonly parentJobId: string;
  readonly invocationId: string;
  readonly origin: "worker" | "owner";
  childJobId: string | null;
  readonly operationId: string;
  readonly input: Record<string, string | number | boolean>;
  readonly outputs: Extract<JobEvent, { type: "invocation" }>["outputs"];
  refused: boolean;
}

/** Private socketpair: identity comes from the owning process, never a supplied parent id. */
export class JobContext {
  readonly childFd: number;
  readonly invocations = new Map<string, BoundInvocation>();
  private readonly socket: Socket;
  private readonly reader = new FrameReader(128 * 1024);
  private childOpen = true;
  private closed = false;
  private chain = Promise.resolve();
  private readonly serviceController = new AbortController();
  private readonly serviceRequests = new Set<string>();
  private serviceReadyRequested = false;
  private activityReported = false;
  private readonly agentRequests = new Map<
    string,
    { controller: AbortController; done: boolean }
  >();
  private agentClosed = false;

  private pendingBytes = 0;
  constructor(
    readonly parentJobId: string,
    private readonly callbacks: {
      invoke(event: Extract<JobEvent, { type: "invocation" }>): void;
      command(command: JobCommand): Promise<void>;
      service?(request: ServiceCall, signal: AbortSignal): Promise<ServiceReply>;
      serviceReady?(port: number): Promise<void>;
      progress?(frame: WorkerProgress): void;
      agentRun?(requestId: string, payload: unknown, signal: AbortSignal): Promise<unknown>;
      activity?: () => void;
      failure(reason: string): void;
    },
  ) {
    const pair = privateSocketPair();
    this.childFd = pair.childFd;
    this.socket = pair.socket;
    this.socket.on("data", (bytes: Buffer) => {
      try {
        for (const line of this.reader.push(bytes)) {
          if (this.closed) return;
          const raw: unknown = JSON.parse(line);
          // A stage jumps the chain and is not retained. Every other frame is a request whose
          // reply must keep its order, so `receive` runs them one at a time — and the longest
          // of those is a service call, which in the brokered lane IS the model call. Queued
          // behind it, the one line that says `at the model` would arrive after the thing it
          // announces, be stamped with the wrong time, and a run that reports often would
          // push `pendingBytes` past the ceiling and have its channel failed underneath it.
          if (raw !== null && typeof raw === "object" && Reflect.get(raw, "type") === "progress") {
            this.callbacks.progress?.(WorkerProgressSchema.parse(raw));
            continue;
          }
          if (raw !== null && typeof raw === "object") {
            const type = Reflect.get(raw, "type");
            if (type === "agent_run_cancel") {
              const cancel = WorkerAgentRunCancelSchema.parse(raw);
              const pending = this.agentRequests.get(cancel.requestId);
              if (!pending) throw new Error("agent_request_unknown");
              if (!pending.done) pending.controller.abort();
              continue;
            }
            if (type === "agent_run") {
              const request = WorkerAgentRunCallSchema.parse(raw);
              if (
                this.agentRequests.has(request.requestId) ||
                this.agentRequests.size >= AGENT_TOOL_MAX_CALLS
              )
                throw new Error("agent_request_replayed_or_exhausted");
              this.agentRequests.set(request.requestId, {
                controller: new AbortController(),
                done: false,
              });
            }
          }
          const size = Buffer.byteLength(line);
          this.pendingBytes += size;
          if (this.pendingBytes > MAX_CONTEXT_BYTES) throw new Error("context_input_limit");
          this.chain = this.chain
            .then(() => this.receive(raw))
            .then(() => this.reportActivity())
            .catch(() => this.fail("context_protocol_error"))
            .finally(() => {
              this.pendingBytes -= size;
            });
        }
      } catch {
        this.fail("context_protocol_error");
      }
    });
    this.socket.on("error", (error: NodeJS.ErrnoException) => {
      const peerClosed = error.code === "ECONNRESET" || error.code === "EPIPE";
      this.fail(peerClosed ? "context_closed" : "context_io_error");
    });
    this.socket.on("end", () => {
      if (!this.closed) this.fail("context_closed");
    });
    this.socket.on("close", () => {
      if (!this.closed) this.fail("context_closed");
    });
  }

  private async receive(raw: unknown): Promise<void> {
    if (this.closed) return;
    if (raw === null || typeof raw !== "object") throw new Error("invalid_context_message");
    if (Reflect.get(raw, "type") === "agent_run") {
      const request = WorkerAgentRunCallSchema.parse(raw);
      const pending = this.agentRequests.get(request.requestId)!;
      const signal = pending.controller.signal;
      let reply: unknown;
      if (signal.aborted || this.agentClosed)
        reply = { type: "refused", code: "cancelled", traceId: null };
      else if (!this.callbacks.agentRun)
        reply = { type: "refused", code: "binding_unavailable", traceId: null };
      else {
        const cancelled = Promise.withResolvers<unknown>();
        const abort = () =>
          cancelled.resolve({ type: "unknown", reason: "cancelled", traceId: null });
        signal.addEventListener("abort", abort, { once: true });
        try {
          reply = await Promise.race([
            this.callbacks.agentRun(request.requestId, request.payload, signal),
            cancelled.promise,
          ]);
        } catch {
          reply = { type: "unknown", reason: "interrupted", traceId: null };
        } finally {
          signal.removeEventListener("abort", abort);
        }
      }
      pending.done = true;
      await this.sendAgentReply(request.requestId, reply);
      return;
    }
    if (Reflect.get(raw, "type") === "service_ready") {
      const request = ServiceReadySchema.parse(raw);
      let refusal: ServiceReadyRefusal | null = null;
      if (this.serviceReadyRequested) refusal = "service_ready_duplicate";
      else {
        this.serviceReadyRequested = true;
        if (this.serviceController.signal.aborted) refusal = "service_closed";
        else if (!this.callbacks.serviceReady) refusal = "service_unavailable";
        else {
          try {
            await this.callbacks.serviceReady(request.port);
          } catch {
            refusal = "service_unavailable";
          }
          if (this.serviceController.signal.aborted) refusal = "service_closed";
        }
      }
      this.send(
        ServiceReadyResultSchema.parse(
          refusal === null
            ? { type: "service_ready_result", requestId: request.requestId, ok: true }
            : { type: "service_ready_result", requestId: request.requestId, ok: false, refusal },
        ),
      );
      return;
    }
    if (Reflect.get(raw, "type") === "service") {
      const request = ServiceCallSchema.parse(raw);
      if (this.serviceRequests.has(request.requestId) || this.serviceRequests.size >= 4096)
        throw new Error("service_request_replayed_or_exhausted");
      this.serviceRequests.add(request.requestId);
      const reply = this.callbacks.service
        ? await this.callbacks.service(request, this.serviceController.signal)
        : {
            type: "service_result" as const,
            requestId: request.requestId,
            ok: false as const,
            refusal: "service_unavailable" as const,
          };
      this.send(ServiceReplySchema.parse(reply));
      return;
    }
    if (Reflect.get(raw, "type") === "invoke") {
      if (
        Object.keys(raw).some((key) => !["type", "operationId", "input", "outputs"].includes(key))
      )
        throw new Error("invalid_invocation_fields");
      const operationId = Reflect.get(raw, "operationId");
      if (
        typeof operationId !== "string" ||
        !operationId.length ||
        operationId.length > 128 ||
        this.invocations.size >= 64
      )
        throw new Error("invocation_limit");
      const input = JobRequestSchema.shape.input.parse(Reflect.get(raw, "input"));
      const outputs = JobRequestSchema.shape.outputs.parse(Reflect.get(raw, "outputs"));
      const invocationId = randomUUID();
      this.invocations.set(invocationId, {
        parentJobId: this.parentJobId,
        invocationId,
        origin: "worker",
        childJobId: null,
        operationId,
        input,
        outputs,
        refused: false,
      });
      this.send({ type: "invoking", invocationId });
      this.callbacks.invoke({
        type: "invocation",
        parentJobId: this.parentJobId,
        invocationId,
        operationId,
        input,
        outputs,
      });
      return;
    }
    const command = JobCommandSchema.parse(raw);
    if (!["input", "cancel", "status"].includes(command.type) || !("jobId" in command))
      throw new Error("context_command_forbidden");
    if (
      ![...this.invocations.values()].some((invocation) => invocation.childJobId === command.jobId)
    ) {
      if (command.type !== "input") throw new Error("context_child_mismatch");
      this.send({
        type: "input_result",
        jobId: command.jobId,
        requestId: command.requestId,
        seq: command.seq,
        accepted: false,
        reason: "context_child_mismatch",
        nextInputSeq: null,
        stdinClosed: true,
      });
      return;
    }
    if (command.type === "input") {
      try {
        await this.callbacks.command(command);
      } catch {
        this.send({
          type: "input_result",
          jobId: command.jobId,
          requestId: command.requestId,
          seq: command.seq,
          accepted: false,
          reason: "job_input_delivery_unknown",
          nextInputSeq: null,
          stdinClosed: true,
        });
      }
    } else await this.callbacks.command(command);
  }

  bind(invocationId: string, childJobId: string): void {
    const invocation = this.invocations.get(invocationId);
    if (!invocation || invocation.childJobId !== null || invocation.refused)
      throw new Error("invocation_replayed");
    invocation.childJobId = childJobId;
    if (invocation.origin === "worker")
      this.send({ type: "child", invocationId, jobId: childJobId });
  }
  reply(invocationId: string, jobId: string | null, reason: string | null): void {
    const invocation = this.invocations.get(invocationId);
    if (!invocation) throw new Error("unknown_invocation");
    if (reason !== null) invocation.refused = true;
    if (invocation.origin === "owner") return;
    this.send({
      type: "invocation_reply",
      parentJobId: this.parentJobId,
      invocationId,
      jobId,
      reason,
    });
  }
  send(event: unknown): void {
    if (this.closed) return;
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
    if (
      bytes.length > 128 * 1024 ||
      this.socket.writableLength + bytes.length > MAX_CONTEXT_BYTES
    ) {
      this.fail("context_output_limit");
      return;
    }
    this.socket.write(bytes);
  }
  private async sendAgentReply(requestId: string, reply: unknown): Promise<void> {
    const serialized = JSON.stringify(reply);
    if (
      typeof serialized !== "string" ||
      Buffer.byteLength(serialized) > AGENT_TOOL_MAX_REPLY_BYTES
    )
      throw new Error("agent_reply_limit");
    let seq = 0;
    for (let offset = 0; offset < serialized.length && !this.closed;) {
      let end = Math.min(offset + AGENT_TOOL_CHUNK_CHARS, serialized.length);
      // Keep UTF-16 pairs together so byte accounting agrees with the serialized reply.
      const last = serialized.charCodeAt(end - 1);
      if (end < serialized.length && last >= 0xd800 && last <= 0xdbff) end--;
      const bytes = Buffer.from(
        `${JSON.stringify({
          type: "agent_run_result",
          requestId,
          seq: seq++,
          end: end === serialized.length,
          data: serialized.slice(offset, end),
        })}\n`,
      );
      if (
        bytes.length > 128 * 1024 ||
        this.socket.writableLength + bytes.length > MAX_CONTEXT_BYTES
      )
        throw new Error("context_output_limit");
      // A write callback means this chunk has actually flushed, not merely joined a JS queue.
      const flushed = Promise.withResolvers<void>();
      const closed = () => flushed.reject(new Error("context_closed"));
      this.socket.once("close", closed);
      try {
        this.socket.write(bytes, (error) => {
          if (error) flushed.reject(error);
          else flushed.resolve();
        });
        await flushed.promise;
      } finally {
        this.socket.off("close", closed);
      }
      offset = end;
    }
  }
  abortAgentRuns(): void {
    this.agentClosed = true;
    for (const pending of this.agentRequests.values())
      if (!pending.done) pending.controller.abort();
  }
  releaseChildFd(): void {
    if (this.childOpen) {
      this.childOpen = false;
      closeSync(this.childFd);
    }
  }
  abortServices(): void {
    this.serviceController.abort();
    this.abortAgentRuns();
  }
  closeAfterWrites(): void {
    if (this.closed) return;
    this.closed = true;
    this.abortServices();
    this.releaseChildFd();
    this.socket.end();
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.abortServices();
      this.releaseChildFd();
    }
    this.socket.destroy();
  }
  private reportActivity(): void {
    if (this.activityReported) return;
    this.activityReported = true;
    this.callbacks.activity?.();
  }
  private fail(reason: string): void {
    if (this.closed) return;
    this.close();
    this.callbacks.failure(reason);
  }
}
