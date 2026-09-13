import {
  IsolateChildFrameSchema,
  ISOLATE_MAX_FRAME_BYTES,
  PLUGIN_BUNDLE_SERVER_FILE,
  type IsolateChildFrame,
  type IsolateHostEnvelope,
  type IsolateHostFrame,
} from "@manifold/protocol";
import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";

import type { Logger } from "../log.ts";
import { IsolateLoadError } from "./contract.ts";

/** Bun accepts an inherited socketpair fd here; Node's ambient overload omits that form. */
const connectDescriptor = connect as unknown as (options: { readonly fd: number }) => Socket;

/**
 * THE WIRE END of one isolate: a child process, the bounded JSON frames it speaks over a
 * dedicated socket, and its two output pipes. This module knows nothing about dispatches,
 * budgets or states — it spawns, bounds raw frames before parsing, validates every inbound
 * message against `IsolateChildFrameSchema`, forwards what parses, reports what does not, and
 * says when the process is gone. The supervisor is the only caller.
 */

/** One line of the child's own output as the log keeps it; longer is truncated with a mark. */
const OUTPUT_LINE_MAX_CHARS = 2048;
/** How many lines one child may put in the server's log before the rest is drained silently. */
const OUTPUT_LINES_MAX = 256;

/** How the supervisor hears from a child; every event names the child it came from. */
export interface IsolateChildEvents {
  frame(child: IsolateChild, frame: IsolateChildFrame): void;
  /**
   * A message that is not a child frame. `id` is the string the sender put under `id`, if
   * any, so the supervisor can fail the request the child was presumably answering.
   */
  malformed(child: IsolateChild, detail: string, id: string | null): void;
  /** The process is gone; `code` is null when a signal ended it. */
  exit(child: IsolateChild, code: number | null, signal: string | null): void;
}

/**
 * Where Bun keeps a standalone executable's own sources (`bun build --compile`). A server
 * running from there is the runtime plus ONE embedded entry, and re-running its
 * `process.execPath` boots a second server rather than a plugin.
 */
const STANDALONE_ROOT = "/$bunfs/";

/**
 * The interpreter a child runs under: the server's own when the server IS bun (source
 * tree, the hub image), otherwise a `bun` on PATH — or null, and the load says so by name
 * rather than spawning a hub inside a hub. The nix-packaged server is the compiled case.
 */
function isolateInterpreter(): string | null {
  if (!Bun.main.startsWith(STANDALONE_ROOT)) return process.execPath;
  return Bun.which("bun");
}

/**
 * The environment a child gets: the interpreter must be findable, a home directory keeps
 * Bun's own cache out of `/`, and the plugin learns its id. NOTHING of the server's own
 * environment — its data directory, its owner key, its listen address — crosses (docs/CONTRACTS.md §Data and credential boundaries): a stranger's process is told exactly what it needs to run and nothing it could leak.
 */
function childEnvironment(pluginId: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    MANIFOLD_PLUGIN_ID: pluginId,
    MANIFOLD_PLUGIN_PIPE_FD: "3",
  };
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  return env;
}

/** Splits a byte stream into lines for `onLine`, flushing an unterminated run at the cap. */
async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let carry = "";
  for await (const chunk of stream) {
    carry += decoder.decode(chunk, { stream: true });
    let newline = carry.indexOf("\n");
    while (newline !== -1) {
      onLine(carry.slice(0, newline));
      carry = carry.slice(newline + 1);
      newline = carry.indexOf("\n");
    }
    if (carry.length > OUTPUT_LINE_MAX_CHARS) {
      onLine(carry);
      carry = "";
    }
  }
  carry += decoder.decode();
  if (carry.length > 0) onLine(carry);
}

/** Splits a byte stream into bounded frame lines before any JSON representation is allocated. */
async function pumpFrames(
  stream: AsyncIterable<Uint8Array>,
  onLine: (line: string) => void,
  onBroken: (detail: string) => void,
): Promise<void> {
  let parts: Uint8Array[] = [];
  let bytes = 0;
  const append = (part: Uint8Array): boolean => {
    if (bytes + part.byteLength > ISOLATE_MAX_FRAME_BYTES) {
      onBroken(`frame exceeds ${String(ISOLATE_MAX_FRAME_BYTES)} bytes`);
      return false;
    }
    if (part.byteLength > 0) {
      parts.push(part);
      bytes += part.byteLength;
    }
    return true;
  };
  for await (const chunk of stream) {
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      if (!append(chunk.subarray(start, index))) return;
      onLine(Buffer.concat(parts, bytes).toString("utf8"));
      parts = [];
      bytes = 0;
      start = index + 1;
    }
    if (!append(chunk.subarray(start))) return;
  }
  if (bytes > 0) onBroken("unterminated frame");
}

/** The sender's `id`, when a message that failed the schema still carried a string one. */
function correlationOf(message: unknown): string | null {
  if (message === null || typeof message !== "object") return null;
  const id = Reflect.get(message, "id");
  return typeof id === "string" ? id : null;
}

export class IsolateChild {
  private readonly process: Bun.Subprocess<"ignore", "pipe", "pipe">;
  private readonly protocol: Socket;
  private outputLines = 0;
  private readonly unacknowledged: { readonly receipt: string; readonly bytes: number }[] = [];
  private unacknowledgedBytes = 0;
  /** Resolves when the process has exited AND both output pipes are drained. */
  readonly closed: Promise<void>;

  private constructor(
    readonly pluginId: string,
    process: Bun.Subprocess<"ignore", "pipe", "pipe">,
    protocolFd: number,
    private readonly logger: Logger,
    events: IsolateChildEvents,
  ) {
    this.process = process;
    this.protocol = connectDescriptor({ fd: protocolFd });
    const protocol = pumpFrames(
      this.protocol,
      (line) => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          events.malformed(this, "invalid JSON frame", null);
          this.kill();
          return;
        }
        const parsed = IsolateChildFrameSchema.safeParse(message);
        if (parsed.success) {
          events.frame(this, parsed.data);
          return;
        }
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ");
        events.malformed(this, detail, correlationOf(message));
      },
      (detail) => {
        events.malformed(this, detail, null);
        this.kill();
      },
    )
      .catch((error: unknown) => {
        if (this.process.exitCode === null && this.process.signalCode === null) {
          events.malformed(this, `frame channel failed: ${String(error)}`, null);
          this.kill();
        }
      })
      .finally(() => {
        this.protocol.destroy();
      });
    const pumps = Promise.all([
      protocol,
      pumpLines(process.stdout, (line) => this.output("stdout", line)),
      pumpLines(process.stderr, (line) => this.output("stderr", line)),
    ]);
    this.closed = process.exited.then(async () => {
      await pumps;
      events.exit(this, process.exitCode, process.signalCode);
    });
  }

  /**
   * THE LOADER, whole: the bundle is self-contained (the kit's `pack` inlines the guest
   * runtime), so the child is a bun — the server's own where the server is one — running
   * `server.js` from the extracted bundle directory with a small heap and the minimal
   * environment above. A dedicated bidirectional socket carries bounded newline-delimited
   * JSON; stdout and stderr remain plugin logs.
   */
  static spawn(
    pluginId: string,
    dir: string,
    logger: Logger,
    events: IsolateChildEvents,
  ): IsolateChild {
    const interpreter = isolateInterpreter();
    if (interpreter === null) {
      throw new IsolateLoadError("no bun on PATH to run isolates under this compiled server");
    }
    const spawned = Bun.spawn([interpreter, "--smol", `${dir}/${PLUGIN_BUNDLE_SERVER_FILE}`], {
      stdio: ["ignore", "pipe", "pipe", "socket-fd"],
      cwd: dir,
      env: childEnvironment(pluginId),
      maxBuffer: ISOLATE_MAX_FRAME_BYTES,
    });
    const protocolFd = spawned.stdio[3];
    if (protocolFd === null || protocolFd === undefined) {
      spawned.kill();
      throw new IsolateLoadError("isolate frame pipe was not created");
    }
    return new IsolateChild(pluginId, spawned, protocolFd, logger, events);
  }

  get pid(): number {
    return this.process.pid;
  }

  /**
   * Enqueues one bounded host frame. A random receipt remains charged until the child proves
   * that it consumed the envelope, so neither socket buffering nor a peer that merely writes
   * requests can hide an unread, unbounded reply backlog.
   */
  send(frame: IsolateHostFrame): boolean {
    if (
      this.protocol.destroyed ||
      this.process.exitCode !== null ||
      this.process.signalCode !== null
    )
      return false;
    const receipt = randomUUID();
    let payload: string;
    try {
      const envelope: IsolateHostEnvelope = { receipt, frame };
      payload = JSON.stringify(envelope);
    } catch {
      return false;
    }
    const frameBytes = Buffer.byteLength(payload);
    const chargedBytes = frameBytes + 1;
    if (
      frameBytes > ISOLATE_MAX_FRAME_BYTES ||
      this.unacknowledged.length >= 256 ||
      this.unacknowledgedBytes + chargedBytes > ISOLATE_MAX_FRAME_BYTES * 2
    ) {
      this.logger.warn("isolate_protocol_backpressure", {
        plugin: this.pluginId,
        unacknowledgedFrames: this.unacknowledged.length,
        unacknowledgedBytes: this.unacknowledgedBytes,
      });
      this.kill();
      return false;
    }
    this.unacknowledged.push({ receipt, bytes: chargedBytes });
    this.unacknowledgedBytes += chargedBytes;
    try {
      this.protocol.write(`${payload}\n`, (error) => {
        if (error) this.kill();
      });
      return true;
    } catch {
      const retained = this.unacknowledged.pop();
      if (retained?.receipt === receipt) this.unacknowledgedBytes -= retained.bytes;
      this.kill();
      return false;
    }
  }

  /** Accepts only the unpredictable, FIFO receipt at the head of the unread-frame ledger. */
  received(receipt: string): boolean {
    const expected = this.unacknowledged[0];
    if (expected?.receipt !== receipt) return false;
    this.unacknowledged.shift();
    this.unacknowledgedBytes -= expected.bytes;
    return true;
  }

  kill(): void {
    this.process.kill("SIGKILL");
  }

  /**
   * The child's own prints, line by line into the server's log — stderr at warn because a
   * guest writing there is usually reporting a fault, stdout at info — under a cap, so a
   * plugin in a print loop costs the log a page and not a disk. Past the cap the pipe is
   * still drained, so the child never blocks on a full pipe the server stopped reading.
   */
  private output(stream: "stdout" | "stderr", line: string): void {
    if (this.outputLines >= OUTPUT_LINES_MAX) return;
    this.outputLines += 1;
    const text =
      line.length > OUTPUT_LINE_MAX_CHARS ? `${line.slice(0, OUTPUT_LINE_MAX_CHARS)}…` : line;
    const capped = this.outputLines === OUTPUT_LINES_MAX;
    const fields = { plugin: this.pluginId, stream, line: text, ...(capped ? { capped } : {}) };
    if (stream === "stderr") this.logger.warn("isolate_output", fields);
    else this.logger.info("isolate_output", fields);
  }
}
