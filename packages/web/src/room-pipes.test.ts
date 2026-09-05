import { describe, expect, test } from "bun:test";
import type { RoomPipe } from "@manifold/plugin/hooks";
import type { TerminalInfo } from "@manifold/protocol";
import { SessionClient } from "@manifold/sdk";
import { createRoomPipeRegistry, panelSessionHandle } from "./room-pipes.ts";

/**
 * THE CONTRACT A PANEL'S TERMINAL VERBS KEEP (issue #196): a mutation never goes out on the
 * host's watching client — the server would refuse a spectator's — but on the occupant pipe
 * of the room that owns it, and no such pipe is a refusal that names what is missing.
 */

function terminal(id: string, containerId: string): TerminalInfo {
  return {
    id,
    containerId,
    name: null,
    machineId: "m1",
    status: "running",
    exitCode: null,
    cols: 80,
    rows: 24,
    controllerId: "p1",
    createdBy: "p1",
  };
}

/** An occupant pipe that records what rides it and answers an open with a record of its own. */
function recordingPipe(
  containerId: string,
  holds: readonly string[],
): RoomPipe & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    terminals: new Map(holds.map((id) => [id, terminal(id, containerId)])),
    openTerminal: (opts) => {
      calls.push(`open:${opts.elementId}`);
      return Promise.resolve(terminal(`t-${opts.elementId}`, containerId));
    },
    sendTerminalInput: (id, data) => calls.push(`input:${id}:${String(data)}`),
    resizeTerminal: (id, cols, rows) => calls.push(`resize:${id}:${String(cols)}x${String(rows)}`),
    takeTerminal: (id) => calls.push(`take:${id}`),
    killTerminal: (id) => calls.push(`kill:${id}`),
  };
}

/** The host's watching client: never connected, so anything sent on it lands in its outbox. */
function watching(containerId: string): SessionClient {
  return new SessionClient({ url: "ws://test/ws/session", containerId, token: "tok" });
}

describe("panel session handle", () => {
  test("a mutation rides the occupant pipe of the room that owns it, never the watching client", async () => {
    const pipes = createRoomPipeRegistry();
    const routed = recordingPipe("c1", ["t1"]);
    const embedded = recordingPipe("c2", ["t2"]);
    pipes.register("c1", routed);
    pipes.register("c2", embedded);
    const watch = watching("c1");
    const handle = panelSessionHandle(watch, pipes, "c1");

    const born = await handle.openTerminal({
      elementId: "e1",
      cols: 80,
      rows: 24,
      placement: "tile",
    });
    handle.sendTerminalInput("t2", "ls\n");
    handle.resizeTerminal("t1", 100, 30);

    expect(born.containerId).toBe("c1");
    expect(routed.calls).toEqual(["open:e1", "resize:t1:100x30"]);
    expect(embedded.calls).toEqual(["input:t2:ls\n"]);
    expect(watch.outboxSize()).toBe(0);
  });

  test("no occupant view is a refusal that names the container or the terminal, not a frame", async () => {
    const pipes = createRoomPipeRegistry();
    const watch = watching("c1");

    await expect(
      panelSessionHandle(watch, pipes, "c1").openTerminal({ elementId: "e1", cols: 80, rows: 24 }),
    ).rejects.toThrow("no occupant view of container c1 is mounted");
    await expect(
      panelSessionHandle(watch, pipes, null).openTerminal({ elementId: "e1", cols: 80, rows: 24 }),
    ).rejects.toThrow("no container is open");
    expect(() => panelSessionHandle(watch, pipes, "c1").sendTerminalInput("t9", "x")).toThrow(
      "no occupant view holds terminal t9",
    );
    expect(watch.outboxSize()).toBe(0);
  });

  test("a release forgets only the pipe it published, so a remount's newer pipe survives the old cleanup", () => {
    const pipes = createRoomPipeRegistry();
    const first = recordingPipe("c1", []);
    const second = recordingPipe("c1", []);
    const releaseFirst = pipes.register("c1", first);
    const releaseSecond = pipes.register("c1", second);

    releaseFirst();
    expect(pipes.pipeOf("c1")).toBe(second);
    releaseSecond();
    expect(() => pipes.pipeOf("c1")).toThrow("no occupant view of container c1 is mounted");
  });
});
