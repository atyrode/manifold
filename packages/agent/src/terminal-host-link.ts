import {
  TERMINAL_HOST_EVENT_TYPES,
  TerminalHostEventSchema,
  type TerminalHostCommand,
  type TerminalHostEvent,
} from "@manifold/protocol";
import { FrameReader, FrameTooLargeError, FrameWriter } from "./ipc-framing.ts";

/**
 * The transport's end of the terminal host seam. A {@link TerminalHostLink} is one open
 * connection; the {@link TerminalHostDialer} that makes one is the DI seam the {@link Agent}
 * takes — `unixTerminalHostDialer` in production, an in-memory pair around a real
 * `TerminalHost` in tests — so the machine state machine never knows a socket exists.
 */

/** How a link reports to its owner. `onClose` fires exactly once, after which nothing else does. */
export interface TerminalHostLinkHandlers {
  onEvent(event: TerminalHostEvent): void;
  onClose(detail: string): void;
}

export interface TerminalHostLink {
  /** Queues one command; the link closes itself if the host stops reading. */
  send(command: TerminalHostCommand): void;
  close(): void;
}

/** Resolves once connected, rejects (with the socket error) when the host is unreachable. */
export type TerminalHostDialer = (handlers: TerminalHostLinkHandlers) => Promise<TerminalHostLink>;

/** Frame classification outcome, the same three-way policy the hub wire uses. */
export type ClassifiedHostFrame =
  | { readonly kind: "event"; readonly event: TerminalHostEvent }
  | { readonly kind: "unknown_type"; readonly frameType: string }
  | { readonly kind: "malformed"; readonly detail: string };

const KNOWN_EVENT_TYPES: Record<string, true> = Object.fromEntries(
  TERMINAL_HOST_EVENT_TYPES.map((type): [string, true] => [type, true]),
);

/** Unknown `type` → ignore (an older transport on a newer host); malformed known → error. */
export function classifyHostFrame(raw: unknown): ClassifiedHostFrame {
  if (raw === null || typeof raw !== "object" || typeof Reflect.get(raw, "type") !== "string") {
    return { kind: "malformed", detail: "missing type discriminator" };
  }
  const frameType = Reflect.get(raw, "type") as string;
  if (KNOWN_EVENT_TYPES[frameType] !== true) return { kind: "unknown_type", frameType };
  const parsed = TerminalHostEventSchema.safeParse(raw);
  if (!parsed.success) return { kind: "malformed", detail: `invalid ${frameType} frame` };
  return { kind: "event", event: parsed.data };
}

interface LinkState {
  readonly reader: FrameReader;
  closed: boolean;
  closeDetail: string | null;
}

/** Dials the host's Unix socket; every link it makes parses with the shared bounds. */
export function unixTerminalHostDialer(socketPath: string): TerminalHostDialer {
  return async (handlers) => {
    const state: LinkState = { reader: new FrameReader(), closed: false, closeDetail: null };
    let writer: FrameWriter | null = null;
    const finish = (detail: string): void => {
      if (state.closed) return;
      state.closed = true;
      handlers.onClose(detail);
    };
    const socket = await Bun.connect<LinkState>({
      unix: socketPath,
      data: state,
      socket: {
        open() {},
        data(sock, chunk) {
          if (state.closed) return;
          let lines: string[];
          try {
            lines = state.reader.push(chunk);
          } catch (error) {
            if (!(error instanceof FrameTooLargeError)) throw error;
            state.closeDetail = "frame_too_large";
            sock.end();
            return;
          }
          for (const line of lines) {
            if (state.closed || state.closeDetail !== null) return;
            let raw: unknown;
            try {
              raw = JSON.parse(line);
            } catch {
              state.closeDetail = "malformed_frame";
              sock.end();
              return;
            }
            const classified = classifyHostFrame(raw);
            switch (classified.kind) {
              case "event":
                handlers.onEvent(classified.event);
                break;
              case "unknown_type":
                break;
              case "malformed":
                state.closeDetail = `malformed_frame: ${classified.detail}`;
                sock.end();
                return;
            }
          }
        },
        drain() {
          writer?.flush();
        },
        close() {
          finish(state.closeDetail ?? "closed");
        },
        error(_sock, error) {
          finish(state.closeDetail ?? `socket_error: ${error.message}`);
        },
        connectError() {},
      },
    });
    writer = new FrameWriter(socket, () => {
      state.closeDetail = "queue_exceeded";
      socket.end();
    });
    return {
      send(command) {
        if (state.closed) return;
        writer?.send(command);
      },
      close() {
        if (state.closed) return;
        state.closeDetail ??= "closed_by_transport";
        socket.end();
      },
    };
  };
}
