import { homedir } from "node:os";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { MAX_SESSION_BASE64_CHARS, type AdvertisedTerminal } from "@manifold/protocol";

/**
 * One live PTY plus everything the machine channel needs to describe it: a strictly
 * monotonic output sequence, a bounded ring buffer of recent bytes, and a headless xterm
 * "mirror" that lets us serialize a gap-free snapshot on demand. The agent owns a
 * `PtyTerminal` per terminal and multiplexes them all over a single server socket.
 *
 * The sequence + snapshot ordering here is the foundation of the server's no-gap attach
 * handoff (CONTRACTS.md §attach): every output byte carries a seq assigned AT EMISSION, and
 * a snapshot reports the seq watermark whose cumulative bytes it renders EXACTLY — so the
 * server can forward `outputs(S+1…)` after `snapshot(S)` with neither a gap nor a duplicate.
 */

/** Default ring cap: buffers output produced while the server socket is down (CONTRACTS.md). */
export const DEFAULT_RING_CAP_BYTES = 2 * 1024 * 1024;

/**
 * Mirror scrollback in lines. A snapshot can only render what the mirror still retains, so
 * this bounds how much history a freshly attaching viewer receives — matching real-terminal
 * behavior (current screen + finite scrollback, never infinite history).
 */
const MIRROR_SCROLLBACK_LINES = 5000;

/**
 * Snapshot data is UTF-8 → base64 on the machine channel, so its ceiling is the wire's
 * ceiling less a margin — and both halves of that sentence are now constants rather than
 * two numbers that agreed by hand. `MAX_SESSION_BASE64_CHARS` is the protocol's own bound
 * on any base64 field; the margin below it is headroom for the JSON framing a snapshot
 * frame wraps its payload in, which keeps the whole frame comfortably under the 1 MiB
 * machine-frame limit rather than exactly at the field limit.
 */
const SNAPSHOT_FRAMING_MARGIN_CHARS = 100_000;
export const MAX_SNAPSHOT_BASE64_CHARS = MAX_SESSION_BASE64_CHARS - SNAPSHOT_FRAMING_MARGIN_CHARS;
const MAX_SNAPSHOT_UTF8_BYTES = (MAX_SNAPSHOT_BASE64_CHARS / 4) * 3;
const TRUNCATED_SNAPSHOT_PREFIX = "\u001bc[older terminal rows omitted]\r\n";

/** One emitted output chunk: its emission seq and a private copy of the bytes. */
export interface PtyOutput {
  readonly seq: number;
  readonly bytes: Uint8Array;
}

/** A serialized mirror plus the seq watermark whose bytes it renders exactly. */
export interface PtySnapshot {
  readonly seq: number;
  readonly data: string;
}

/** Result of a PTY exiting: the process exit code, or `null` when terminated by signal. */
export interface PtyExit {
  readonly exitCode: number | null;
}

/** One retained output chunk inside {@link OutputRing}. */
export interface RingChunk {
  readonly seq: number;
  readonly bytes: Uint8Array;
}

/**
 * Byte-capped FIFO of recent output chunks. Whole chunks are evicted oldest-first once the
 * cap is exceeded; the newest chunk is never evicted (a single chunk larger than the cap is
 * retained alone rather than dropped), so the ring always reflects the most recent output.
 * v0 uses it only to bound memory while disconnected — attaches heal via the mirror snapshot,
 * not ring replay — but the seq bookkeeping is here for a future replay-from-seq path.
 */
export class OutputRing {
  private readonly chunks: RingChunk[] = [];
  private byteTotal = 0;

  /** @param capBytes maximum retained bytes before oldest-chunk eviction kicks in. */
  constructor(private readonly capBytes: number) {}

  /** Appends a chunk and evicts oldest whole chunks until at or under the cap. */
  push(seq: number, bytes: Uint8Array): void {
    this.chunks.push({ seq, bytes });
    this.byteTotal += bytes.byteLength;
    while (this.byteTotal > this.capBytes && this.chunks.length > 1) {
      const evicted = this.chunks.shift();
      if (evicted !== undefined) this.byteTotal -= evicted.bytes.byteLength;
    }
  }

  /** Total retained bytes across all chunks. */
  get bytes(): number {
    return this.byteTotal;
  }

  /** Number of retained chunks. */
  get length(): number {
    return this.chunks.length;
  }

  /** Seq of the oldest retained chunk, or undefined when empty (advances as eviction occurs). */
  get oldestSeq(): number | undefined {
    return this.chunks[0]?.seq;
  }

  /** Seq of the newest retained chunk, or undefined when empty. */
  get newestSeq(): number | undefined {
    return this.chunks.at(-1)?.seq;
  }
}

/** Thrown when a PTY cannot be established (e.g. the OS attached no terminal). */
export class PtyError extends Error {
  override readonly name = "PtyError";
}

/**
 * Resolves the shell argv for a PTY. Order: `$SHELL` (if set and non-empty) → `bash` on
 * PATH → `sh` on PATH → throw {@link PtyError}. The literal `/bin/bash` fallback is
 * deliberately NOT used: it is absent on NixOS (and other distros), so an agent spawned
 * without `SHELL` (e.g. by the testkit) must discover a real shell via PATH. Resolved once
 * per terminal at construction, so the failure refs as a `create_error`.
 */
export function resolveShellCommand(): readonly string[] {
  const fromEnv = process.env.SHELL;
  const shell =
    fromEnv !== undefined && fromEnv !== "" ? fromEnv : (Bun.which("bash") ?? Bun.which("sh"));
  if (shell === null) {
    throw new PtyError("no shell found: set SHELL or install bash/sh on PATH");
  }
  return [shell];
}

/**
 * Names a spawn that never produced a process. Bun reports a missing or unrunnable `argv[0]`
 * as an errno error naming the syscall; an opener that asked for a program deserves the
 * program's name back as the `create_error` reason, never a garbled shell and never
 * `posix_spawn`. Anything else is rethrown untouched.
 */
function spawnFailure(error: unknown, argv0: string): unknown {
  const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  if (code === "ENOENT") return new PtyError(`program not found: ${argv0}`);
  if (code === "EACCES") return new PtyError(`program not executable: ${argv0}`);
  return error;
}

/**
 * Builds a PTY environment without inheriting daemon credentials. Every MANIFOLD_* value in
 * the agent process is excluded so future agent-only credentials are safe by default; the
 * server's fixed, terminal-scoped MANIFOLD_URL/CONTAINER/ELEMENT/TOKEN values are then added back.
 */
function buildPtyEnvironment(
  injected: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const child = new Map<string, string>();
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("MANIFOLD_")) child.set(name, value);
  }
  if (injected !== undefined) {
    for (const [name, value] of Object.entries(injected)) child.set(name, value);
  }
  child.set("TERM", "xterm-256color");
  return Object.fromEntries(child);
}

/** Construction inputs for a {@link PtyTerminal}. */
export interface PtyTerminalOptions {
  readonly terminalId: string;
  readonly cols: number;
  readonly rows: number;
  /** Working directory; defaults to the user's home directory. */
  readonly cwd?: string;
  /** Extra environment for the shell; merged over a credential-free process environment. */
  readonly env?: Record<string, string>;
  /** Invoked for every output chunk, in emission order, with its assigned seq. */
  readonly onOutput: (output: PtyOutput) => void;
  /** Ring cap in bytes; defaults to {@link DEFAULT_RING_CAP_BYTES}. Tests pass a tiny cap. */
  readonly ringCapBytes?: number;
  /**
   * The argv to exec: an opener's `create.program` (issue #192), or the pinned shell a PTY
   * test names. Defaults to {@link resolveShellCommand} (`$SHELL` → `bash` → `sh` on PATH).
   * A missing or unrunnable `argv[0]` throws {@link PtyError} naming the program.
   */
  readonly command?: readonly string[];
  /** Mirror factory seam used to verify construction cleanup without patching xterm globals. */
  readonly createMirror?: (
    options: ConstructorParameters<typeof HeadlessTerminal>[0],
  ) => HeadlessTerminal;
}

export class PtyTerminal {
  /** Opaque terminal id, assigned by the server. */
  readonly terminalId: string;

  private readonly proc: Bun.Subprocess;
  private readonly pty: Bun.Terminal;
  private readonly mirror: HeadlessTerminal;
  private readonly serializer: SerializeAddon;
  private readonly ring: OutputRing;
  private readonly onOutput: (output: PtyOutput) => void;

  /** Highest output seq emitted so far; assigned AT EMISSION and strictly monotonic. */
  private currentSeq = 0;
  private colsValue: number;
  private rowsValue: number;
  private aliveFlag = true;
  private disposed = false;
  private exitCodeValue: number | null | undefined;

  /** Resolves once the PTY has exited, with the process exit code (null if signalled). */
  readonly exited: Promise<PtyExit>;

  constructor(opts: PtyTerminalOptions) {
    // Resolve the shell FIRST: a missing shell throws PtyError before any resource is
    // allocated, so the agent can ref it as create_error with nothing to clean up.
    const command = opts.command ?? resolveShellCommand();
    this.terminalId = opts.terminalId;
    this.colsValue = opts.cols;
    this.rowsValue = opts.rows;
    this.onOutput = opts.onOutput;
    this.ring = new OutputRing(opts.ringCapBytes ?? DEFAULT_RING_CAP_BYTES);

    // Headless mirror: parses the same byte stream the PTY produces so snapshots reflect the
    // rendered terminal state (screen + scrollback), independent of the server connection.
    this.mirror = (opts.createMirror ?? ((options) => new HeadlessTerminal(options)))({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: MIRROR_SCROLLBACK_LINES,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.mirror.loadAddon(this.serializer);

    let proc: Bun.Subprocess | undefined;
    try {
      proc = Bun.spawn([...command], {
        cwd: opts.cwd ?? homedir(),
        env: buildPtyEnvironment(opts.env),
        terminal: {
          cols: opts.cols,
          rows: opts.rows,
          data: (_pty, chunk) => this.ingest(chunk),
        },
      });

      const pty = proc.terminal;
      if (pty === undefined) {
        throw new PtyError(`no PTY attached for terminal ${opts.terminalId}`);
      }
      this.proc = proc;
      this.pty = pty;
      this.exited = this.trackExit();
    } catch (error) {
      proc?.kill("SIGKILL");
      const pty = proc?.terminal;
      if (pty !== undefined && !pty.closed) pty.close();
      this.mirror.dispose();
      throw spawnFailure(error, command[0] ?? "");
    }
  }

  /**
   * PTY data callback. Copies the chunk (Bun reuses the backing buffer across callbacks),
   * assigns the next seq, then — in the order the no-gap invariant depends on — records it in
   * the ring, feeds the mirror, and hands it to the emit callback.
   */
  private ingest(chunk: Uint8Array): void {
    const bytes = new Uint8Array(chunk);
    this.currentSeq += 1;
    const seq = this.currentSeq;
    this.ring.push(seq, bytes);
    this.mirror.write(bytes);
    this.onOutput({ seq, bytes });
  }

  private async trackExit(): Promise<PtyExit> {
    await this.proc.exited;
    this.aliveFlag = false;
    // `exitCode` is null for signal deaths (signalCode is set instead); the wire schema
    // (exited.exitCode) is nullable, so we ref the true code and null for signals.
    this.exitCodeValue = this.proc.exitCode;
    return { exitCode: this.exitCodeValue };
  }

  /** Writes caller bytes (decoded terminal input) straight to the PTY. */
  write(data: string | Uint8Array): void {
    this.pty.write(data);
  }

  /** Resizes both the PTY and its mirror so serialized geometry tracks the live terminal. */
  resize(cols: number, rows: number): void {
    this.colsValue = cols;
    this.rowsValue = rows;
    this.pty.resize(cols, rows);
    this.mirror.resize(cols, rows);
  }

  /**
   * Terminates the PTY and resolves once it has exited. `proc.kill()` sends SIGTERM, which
   * interactive shells ignore — so we also close the PTY master, delivering SIGHUP, which
   * they honor (verified on this machine). Callers await {@link exited} via the return value.
   */
  kill(): Promise<PtyExit> {
    this.proc.kill();
    if (!this.pty.closed) this.pty.close();
    return this.exited;
  }

  /** Escalates a terminal that survived graceful shutdown; SIGKILL cannot be trapped. */
  forceKill(): void {
    this.proc.kill("SIGKILL");
    if (!this.pty.closed) this.pty.close();
  }

  /**
   * Serializes as much newest scrollback as fits the wire budget. SerializeAddon's
   * `scrollback` option always includes the current screen and selects history from the
   * bottom, so dropping older rows does not disturb live output after the captured watermark.
   *
   * Candidate history grows geometrically: successful serializations stay under the cap and
   * the first rejected allocation is normally at most twice that size, avoiding the former
   * multi-MiB serialization of all 5000 retained lines.
   */
  private serializeBoundedSnapshot(): string {
    let data = this.serializer.serialize({ scrollback: 0 });
    if (Buffer.byteLength(data, "utf8") > MAX_SNAPSHOT_UTF8_BYTES) {
      return this.truncateSerializedSnapshot(data);
    }

    const availableScrollback = Math.max(0, this.mirror.buffer.normal.length - this.rowsValue);
    let includedScrollback = 0;
    let nextScrollback = 1;
    while (includedScrollback < availableScrollback) {
      const candidateScrollback = Math.min(availableScrollback, nextScrollback);
      const candidate = this.serializer.serialize({ scrollback: candidateScrollback });
      if (Buffer.byteLength(candidate, "utf8") > MAX_SNAPSHOT_UTF8_BYTES) break;
      data = candidate;
      includedScrollback = candidateScrollback;
      nextScrollback *= 2;
    }
    return data;
  }

  /**
   * Pathological current screens can exceed the cap even with zero scrollback. Retain the
   * newest complete serialized rows after a terminal reset; if one wrapped row alone consumes
   * the budget, send only the explicit omission marker rather than cutting UTF-8 or an ANSI
   * control sequence and corrupting the viewer's subsequent live stream.
   */
  private truncateSerializedSnapshot(data: string): string {
    const encoded = Buffer.from(data, "utf8");
    const suffixBudget =
      MAX_SNAPSHOT_UTF8_BYTES - Buffer.byteLength(TRUNCATED_SNAPSHOT_PREFIX, "utf8");
    const firstEligibleByte = encoded.byteLength - suffixBudget;
    const rowBoundary = encoded.indexOf(0x0a, firstEligibleByte);
    if (rowBoundary === -1) return TRUNCATED_SNAPSHOT_PREFIX;
    return TRUNCATED_SNAPSHOT_PREFIX + encoded.subarray(rowBoundary + 1).toString("utf8");
  }

  /**
   * Serializes the mirror at the current seq watermark. Because xterm parses writes
   * asynchronously, we FIRST capture `seq`, THEN drain the parser with a zero-length write
   * whose callback fires only after every write for outputs ≤ `seq` is parsed. Serialization
   * MUST happen synchronously inside that callback: xterm may continue parsing already-queued
   * outputs before a promise continuation runs, which would leak seq > S bytes into
   * snapshot(S). The bounded serializer may omit old scrollback, but it cannot observe a
   * post-marker output.
   */
  snapshot(): Promise<PtySnapshot> {
    const seq = this.currentSeq;
    const { promise, resolve, reject } = Promise.withResolvers<PtySnapshot>();
    // Avoid touching xterm at all when a request races with an already-completed exit.
    if (this.disposed) {
      reject(new PtyError(`snapshot abandoned for disposed terminal ${this.terminalId}`));
      return promise;
    }
    this.mirror.write("", () => {
      // dispose() can run while this marker waits behind xterm's asynchronous write queue.
      // Serializing a disposed mirror both corrupts the claimed snapshot and makes xterm warn
      // on stderr, so reject before invoking any addon API.
      if (this.disposed) {
        reject(new PtyError(`snapshot abandoned for disposed terminal ${this.terminalId}`));
        return;
      }
      try {
        resolve({ seq, data: this.serializeBoundedSnapshot() });
      } catch (error) {
        reject(error);
      }
    });
    return promise;
  }

  /** Releases PTY and mirror resources. Called by the owner after the terminal is dropped. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.pty.closed) this.pty.close();
    this.mirror.dispose();
  }

  /** Whether the PTY is still running. */
  get alive(): boolean {
    return this.aliveFlag;
  }

  /** Highest emitted output seq (the watermark advertised on reconnect). */
  get seq(): number {
    return this.currentSeq;
  }

  /** Retained ring bytes (test/introspection hook). */
  get ringBytes(): number {
    return this.ring.bytes;
  }

  /** Retained ring chunk count (test/introspection hook). */
  get ringChunkCount(): number {
    return this.ring.length;
  }

  /** Oldest retained ring seq, or undefined when empty (test/introspection hook). */
  get oldestRingSeq(): number | undefined {
    return this.ring.oldestSeq;
  }

  /** Machine-channel advertisement for `hello` (server-restart adoption). */
  toAdvertised(): AdvertisedTerminal {
    return {
      terminalId: this.terminalId,
      cols: this.colsValue,
      rows: this.rowsValue,
      alive: this.aliveFlag,
      seq: this.currentSeq,
      ...(!this.aliveFlag ? { exitCode: this.exitCodeValue ?? null } : {}),
    };
  }
}
