import { chmodSync, mkdirSync, statSync, unlinkSync, type Stats } from "node:fs";
import { dirname } from "node:path";
import type { TerminalHostEvent } from "@manifold/protocol";
import { FrameReader, FrameTooLargeError, FrameWriter } from "./ipc-framing.ts";
import type { AgentLogSink } from "./log.ts";
import type { TerminalHost, TerminalHostSession } from "./terminal-host.ts";

/**
 * The Unix-socket end of a {@link TerminalHost}: one listener on a private path, one
 * {@link TerminalHostSession} per accepted connection, newline-delimited JSON both ways with
 * the bounds `ipc-framing.ts` enforces. Bun's `Bun.listen` is the whole transport — no HTTP,
 * no WebSocket, no second machine-channel client (AGENTS.md invariant 3).
 */

/** Thrown when the socket cannot be served safely; main.ts exits by name rather than guess. */
export class TerminalHostSocketError extends Error {
  override readonly name = "TerminalHostSocketError";
}

interface ConnectionState {
  readonly reader: FrameReader;
  writer: FrameWriter | null;
  session: TerminalHostSession | null;
  closing: boolean;
}

/** A running listener; `stop` closes every connection and removes the socket file. */
export interface TerminalHostListener {
  readonly path: string;
  stop(): void;
}

function errorCode(error: unknown): string | undefined {
  const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" ? code : undefined;
}

/**
 * Refuses a directory anyone else could reach: the socket is the only authority on this
 * seam (whoever can connect can drain, and can ask the host to stop), so the directory must
 * be ours and mode 0700. A missing directory is created that way.
 */
function ensurePrivateDirectory(path: string): void {
  const dir = dirname(path);
  let info: Stats;
  try {
    info = statSync(dir);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    // Ours from birth: created 0700 regardless of umask. An existing directory is never
    // re-moded — a wrong mode there is someone's decision to report, not to overwrite.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    info = statSync(dir);
  }
  if (!info.isDirectory()) {
    throw new TerminalHostSocketError(`terminal host socket directory is not a directory: ${dir}`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && info.uid !== uid) {
    throw new TerminalHostSocketError(`terminal host socket directory is not owned by us: ${dir}`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new TerminalHostSocketError(
      `terminal host socket directory must be private (mode 0700): ${dir}`,
    );
  }
}

/**
 * A live host on this path is a hard refusal — the incident was two owners of one machine —
 * and only a socket nobody answers is removed. Bun reports every failed Unix connect as
 * ENOENT, so the file's own type decides: a socket nobody accepts on is stale, anything that
 * is not a socket is somebody else's file and is refused by name rather than unlinked.
 */
async function reclaimStaleSocket(path: string): Promise<"none" | "stale"> {
  let info: Stats;
  try {
    info = statSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "none";
    throw error;
  }
  if (!info.isSocket()) {
    throw new TerminalHostSocketError(`terminal host socket path is not a socket: ${path}`);
  }
  let socket: Bun.Socket<undefined> | null = null;
  try {
    socket = await Bun.connect({
      unix: path,
      socket: { data() {}, open() {}, close() {}, error() {}, connectError() {} },
    });
  } catch {
    unlinkSync(path);
    return "stale";
  }
  socket.end();
  throw new TerminalHostSocketError(`another terminal host is already listening at ${path}`);
}

/** Serves `host` on the Unix socket `path`, refusing an unsafe directory or a live sibling. */
export async function listenTerminalHost(
  host: TerminalHost,
  path: string,
  sink: AgentLogSink,
): Promise<TerminalHostListener> {
  ensurePrivateDirectory(path);
  const reclaimed = await reclaimStaleSocket(path);
  if (reclaimed === "stale") {
    sink({ ts: Date.now(), level: "warn", evt: "terminal_host_socket_reclaimed", path });
  }

  const server = Bun.listen<ConnectionState>({
    unix: path,
    socket: {
      open(socket) {
        const state: ConnectionState = {
          reader: new FrameReader(),
          writer: null,
          session: null,
          closing: false,
        };
        socket.data = state;
        state.writer = new FrameWriter(socket, (queuedBytes) => {
          sink({ ts: Date.now(), level: "warn", evt: "terminal_host_backpressure", queuedBytes });
          cut(socket, "queue_exceeded");
        });
        state.session = host.open({
          write: (event: TerminalHostEvent) => state.writer?.send(event) ?? false,
          close: () => {
            if (state.closing) return;
            state.closing = true;
            socket.end();
          },
        });
      },
      data(socket, chunk) {
        const state = socket.data;
        if (state.session === null || state.closing) return;
        let lines: string[];
        try {
          lines = state.reader.push(chunk);
        } catch (error) {
          if (!(error instanceof FrameTooLargeError)) throw error;
          cut(socket, "frame_too_large");
          return;
        }
        for (const line of lines) {
          if (state.closing) return;
          let raw: unknown;
          try {
            raw = JSON.parse(line);
          } catch {
            cut(socket, "malformed_frame", "invalid JSON");
            return;
          }
          state.session.deliver(raw);
        }
      },
      drain(socket) {
        socket.data.writer?.flush();
      },
      close(socket) {
        const state = socket.data;
        state.closing = true;
        state.session?.detach();
        state.session = null;
      },
      error(socket, error) {
        sink({
          ts: Date.now(),
          level: "warn",
          evt: "terminal_host_socket_error",
          message: error.message,
        });
        socket.data.closing = true;
        socket.data.session?.detach();
        socket.data.session = null;
      },
    },
  });

  function cut(
    socket: Bun.Socket<ConnectionState>,
    code: "frame_too_large" | "malformed_frame" | "queue_exceeded",
    detail?: string,
  ): void {
    const state = socket.data;
    if (state.closing) return;
    state.closing = true;
    sink({
      ts: Date.now(),
      level: "warn",
      evt: "terminal_host_refused_frame",
      code,
      ...(detail !== undefined ? { detail } : {}),
    });
    // Best effort: the refusal frame goes out only if the peer is still readable.
    state.writer?.send({ type: "error", code, ...(detail !== undefined ? { detail } : {}) });
    state.session?.detach();
    state.session = null;
    socket.end();
  }

  chmodSync(path, 0o600);
  sink({ ts: Date.now(), level: "info", evt: "terminal_host_listening", path });
  return {
    path,
    stop() {
      server.stop(true);
      try {
        unlinkSync(path);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    },
  };
}
