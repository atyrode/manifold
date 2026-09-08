import { basename, dirname } from "node:path";
import {
  JobCommandSchema,
  JobEventSchema,
  JobOwnerSchema,
  MAX_JOB_INSTALL_FRAME_BYTES,
  type JobCommand,
  type JobEvent,
  type JobOwner,
} from "@manifold/protocol";
import { FrameReader, FrameWriter } from "./ipc-framing.ts";
import { HeldDirectory, safeComponent } from "./job-files.ts";
import { reclaimStaleSocket } from "./terminal-host-listener.ts";
import type { MachineJobOwner } from "./job-owner.ts";

const MAX_FRAME = MAX_JOB_INSTALL_FRAME_BYTES;
const MAX_QUEUE = 2 * MAX_JOB_INSTALL_FRAME_BYTES;
export interface JobOwnerLink {
  readonly identity: JobOwner;
  send(command: JobCommand): void;
  close(): void;
}
export type JobOwnerDialer = (handlers: {
  onEvent(event: JobEvent): void;
  onClose(): void;
}) => Promise<JobOwnerLink>;
interface OwnerConnection {
  reader: FrameReader;
  writer: FrameWriter;
  detach: () => void;
  pending: number;
  closed: boolean;
}

/** One private seat, held socket directory, reused bounded framing and stale-listener safety. */
export async function listenJobOwner(
  owner: MachineJobOwner,
  socketPath: string,
): Promise<{ stop(): void }> {
  const directory = HeldDirectory.openAbsolute(dirname(socketPath), { private: true });
  const name = basename(socketPath);
  safeComponent(name);
  const path = `${directory.procPath}/${name}`;
  await reclaimStaleSocket(path);
  const connections = new Set<Bun.Socket<OwnerConnection>>();
  const server = Bun.listen<OwnerConnection>({
    unix: path,
    socket: {
      open(socket) {
        const state: OwnerConnection = {
          reader: new FrameReader(MAX_FRAME),
          writer: new FrameWriter(socket, () => socket.end(), MAX_QUEUE),
          detach: () => {},
          pending: 0,
          closed: false,
        };
        socket.data = state;
        connections.add(socket);
        try {
          state.detach = owner.attach((event) => {
            if (state.closed) return false;
            if (!state.writer.send({ type: "identity", owner: owner.identity })) return false;
            return state.writer.send({ type: "event", event });
          });
          state.writer.send({ type: "identity", owner: owner.identity });
        } catch {
          socket.end();
        }
      },
      data(socket, bytes) {
        const state = socket.data;
        if (state.closed) return;
        try {
          for (const line of state.reader.push(bytes)) {
            const command = JobCommandSchema.parse(JSON.parse(line));
            const count = Buffer.byteLength(line);
            state.pending += count;
            if (state.pending > MAX_QUEUE) throw new Error("owner_command_queue_limit");
            void owner
              .execute(command)
              .catch(() => socket.end())
              .finally(() => {
                state.pending -= count;
              });
          }
        } catch {
          socket.end();
        }
      },
      drain(socket) {
        socket.data.writer.flush();
      },
      close(socket) {
        socket.data.closed = true;
        socket.data.detach();
        connections.delete(socket);
      },
      error(socket) {
        socket.end();
      },
    },
  });
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      for (const socket of connections) socket.end();
      server.stop(true);
      directory.unlink(name);
      directory.close();
    },
  };
}

export function unixJobOwnerDialer(socketPath: string): JobOwnerDialer {
  return async (handlers) => {
    const connected = Promise.withResolvers<JobOwnerLink>();
    const reader = new FrameReader(MAX_FRAME);
    let writer: FrameWriter | null = null;
    let identity: JobOwner | null = null;
    let closed = false;
    let socket: Bun.Socket<undefined>;
    const deadline = setTimeout(() => {
      connected.reject(new Error("job_owner_handshake_timeout"));
      socket?.end();
    }, 10_000);
    const finish = (): void => {
      if (closed) return;
      closed = true;
      clearTimeout(deadline);
      connected.reject(new Error("job_owner_disconnected"));
      // A refused/failed handshake never acquired the seat; only its dial promise fails.
      if (identity) handlers.onClose();
    };
    try {
      socket = await Bun.connect({
        unix: socketPath,
        socket: {
          open() {},
          data(sock, bytes) {
            if (closed) return;
            try {
              for (const line of reader.push(bytes)) {
                const raw: unknown = JSON.parse(line);
                if (raw === null || typeof raw !== "object") throw new Error("invalid_owner_frame");
                if (Reflect.get(raw, "type") === "identity") {
                  identity = JobOwnerSchema.parse(Reflect.get(raw, "owner"));
                  clearTimeout(deadline);
                  connected.resolve({
                    get identity() {
                      if (!identity) throw new Error("owner_identity_missing");
                      return identity;
                    },
                    send(command) {
                      if (!closed) writer?.send(command);
                    },
                    close() {
                      sock.end();
                    },
                  });
                } else if (Reflect.get(raw, "type") === "event" && identity)
                  handlers.onEvent(JobEventSchema.parse(Reflect.get(raw, "event")));
                else throw new Error("invalid_owner_frame");
              }
            } catch {
              sock.end();
            }
          },
          drain() {
            writer?.flush();
          },
          close: finish,
          error: finish,
          connectError() {},
        },
      });
      writer = new FrameWriter(socket, () => socket.end(), MAX_QUEUE);
    } catch (error) {
      clearTimeout(deadline);
      throw error;
    }
    return connected.promise;
  };
}
