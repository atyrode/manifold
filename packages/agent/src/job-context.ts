import { randomUUID } from "node:crypto";
import { closeSync } from "node:fs";
import type { Socket } from "node:net";
import { privateSocketPair } from "./job-files.ts";
import {
  JobCommandSchema,
  JobRequestSchema,
  ServiceCallSchema,
  ServiceReplySchema,
  type ServiceCall,
  type ServiceReply,
  type JobCommand,
  type JobEvent,
} from "@manifold/protocol";
import { FrameReader } from "./ipc-framing.ts";

const MAX_CONTEXT_BYTES = 256 * 1024;
export interface BoundInvocation {
  readonly parentJobId: string;
  readonly invocationId: string;
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

  private pendingBytes = 0;
  constructor(
    readonly parentJobId: string,
    private readonly callbacks: {
      invoke(event: Extract<JobEvent, { type: "invocation" }>): void;
      command(command: JobCommand): Promise<void>;
      service?(request: ServiceCall, signal: AbortSignal): Promise<ServiceReply>;
      failure(reason: string): void;
    },
  ) {
    const pair = privateSocketPair();
    this.childFd = pair.childFd;
    this.socket = pair.socket;
    this.socket.on("data", (bytes: Buffer) => {
      try {
        for (const line of this.reader.push(bytes)) {
          const raw: unknown = JSON.parse(line);
          const size = Buffer.byteLength(line);
          this.pendingBytes += size;
          if (this.pendingBytes > MAX_CONTEXT_BYTES) throw new Error("context_input_limit");
          this.chain = this.chain
            .then(() => this.receive(raw))
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
    if (this.closed || raw === null || typeof raw !== "object")
      throw new Error("invalid_context_message");
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
        type: "input_result", jobId: command.jobId, requestId: command.requestId,
        seq: command.seq, accepted: false, reason: "context_child_mismatch",
        nextInputSeq: null, stdinClosed: true,
      });
      return;
    }
    if (command.type === "input") {
      try {
        await this.callbacks.command(command);
      } catch {
        this.send({
          type: "input_result", jobId: command.jobId, requestId: command.requestId,
          seq: command.seq, accepted: false, reason: "job_input_delivery_unknown",
          nextInputSeq: null, stdinClosed: true,
        });
      }
    } else await this.callbacks.command(command);
  }

  bind(invocationId: string, childJobId: string): void {
    const invocation = this.invocations.get(invocationId);
    if (!invocation || invocation.childJobId !== null || invocation.refused)
      throw new Error("invocation_replayed");
    invocation.childJobId = childJobId;
    this.send({ type: "child", invocationId, jobId: childJobId });
  }
  reply(invocationId: string, jobId: string | null, reason: string | null): void {
    const invocation = this.invocations.get(invocationId);
    if (!invocation) throw new Error("unknown_invocation");
    if (reason !== null) invocation.refused = true;
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
  releaseChildFd(): void {
    if (this.childOpen) {
      this.childOpen = false;
      closeSync(this.childFd);
    }
  }
  abortServices(): void {
    this.serviceController.abort();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abortServices();
    this.releaseChildFd();
    this.socket.destroy();
  }
  private fail(reason: string): void {
    this.close();
    this.callbacks.failure(reason);
  }
}
