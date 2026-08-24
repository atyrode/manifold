import { homedir } from "node:os";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { AdvertisedSession } from "@manifold/protocol";

/**
 * One live PTY plus everything the machine channel needs to describe it: a strictly
 * monotonic output sequence, a bounded ring buffer of recent bytes, and a headless xterm
 * "mirror" that lets us serialize a gap-free snapshot on demand. The agent owns a
 * `PtySession` per terminal and multiplexes them all over a single server socket.
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
 * per session at construction, so the failure surfaces as a `create_error`.
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

/** Construction inputs for a {@link PtySession}. */
export interface PtySessionOptions {
  readonly sessionId: string;
  readonly cols: number;
  readonly rows: number;
  /** Working directory; defaults to the user's home directory. */
  readonly cwd?: string;
  /** Extra environment for the shell; merged over `process.env` (TERM is always forced). */
  readonly env?: Record<string, string>;
  /** Invoked for every output chunk, in emission order, with its assigned seq. */
  readonly onOutput: (output: PtyOutput) => void;
  /** Ring cap in bytes; defaults to {@link DEFAULT_RING_CAP_BYTES}. Tests pass a tiny cap. */
  readonly ringCapBytes?: number;
  /**
   * Shell argv. Defaults to {@link resolveShellCommand} (`$SHELL` → `bash` → `sh` on PATH).
   * A DI seam so PTY tests pin a deterministic shell instead of inheriting the ambient one.
   */
  readonly command?: readonly string[];
}

export class PtySession {
  /** Opaque session id, assigned by the server. */
  readonly sessionId: string;

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

  /** Resolves once the PTY has exited, with the process exit code (null if signalled). */
  readonly exited: Promise<PtyExit>;

  constructor(opts: PtySessionOptions) {
    // Resolve the shell FIRST: a missing shell throws PtyError before any resource is
    // allocated, so the agent can surface it as create_error with nothing to clean up.
    const command = opts.command ?? resolveShellCommand();
    this.sessionId = opts.sessionId;
    this.colsValue = opts.cols;
    this.rowsValue = opts.rows;
    this.onOutput = opts.onOutput;
    this.ring = new OutputRing(opts.ringCapBytes ?? DEFAULT_RING_CAP_BYTES);

    // Headless mirror: parses the same byte stream the PTY produces so snapshots reflect the
    // rendered terminal state (screen + scrollback), independent of the server connection.
    this.mirror = new HeadlessTerminal({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: MIRROR_SCROLLBACK_LINES,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.mirror.loadAddon(this.serializer);

    this.proc = Bun.spawn([...command], {
      cwd: opts.cwd ?? homedir(),
      env: { ...process.env, ...opts.env, TERM: "xterm-256color" },
      terminal: {
        cols: opts.cols,
        rows: opts.rows,
        data: (_pty, chunk) => this.ingest(chunk),
      },
    });

    const pty = this.proc.terminal;
    if (pty === undefined) {
      this.proc.kill("SIGKILL");
      throw new PtyError(`no PTY attached for session ${opts.sessionId}`);
    }
    this.pty = pty;
    this.exited = this.trackExit();
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
    // (exited.exitCode) is nullable, so we surface the true code and null for signals.
    return { exitCode: this.proc.exitCode };
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

  /**
   * Serializes the mirror at the current seq watermark. Because xterm parses writes
   * asynchronously, we FIRST capture `seq`, THEN drain the parser with a zero-length write
   * whose callback fires only after every write for outputs ≤ `seq` is parsed. Writes for
   * later outputs are enqueued after this marker and excluded, so the serialized data renders
   * EXACTLY outputs `1..seq`. This preserves the contract's ordering guarantee (no output
   * with seq > snapshot.seq leaks into the data) while also guaranteeing byte completeness (a
   * naive synchronous serialize would omit un-parsed tail bytes yet still claim them in
   * `seq`, which the server would then discard — a gap).
   */
  snapshot(): Promise<PtySnapshot> {
    const seq = this.currentSeq;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.mirror.write("", resolve);
    return promise.then(() => ({ seq, data: this.serializer.serialize() }));
  }

  /** Releases PTY and mirror resources. Called by the owner after the session is dropped. */
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
  toAdvertised(): AdvertisedSession {
    return {
      sessionId: this.sessionId,
      cols: this.colsValue,
      rows: this.rowsValue,
      alive: this.aliveFlag,
      seq: this.currentSeq,
    };
  }
}
