import { describe, expect, test } from "bun:test";
import { SessionClient } from "@manifold/sdk";
import { createRoomPipeRegistry, panelSessionHandle } from "./room-pipes.ts";

/**
 * THE CONTRACT A PANEL'S TERMINAL VERBS KEEP (issue #196): a mutation never goes out on the
 * host's watching client — the server would refuse a spectator's — but on the occupant pipe
 * of the room that owns it, and no such pipe is a refusal that names what is missing.
 */

/** The host's watching client, disconnected so misplaced durable writes enter its outbox. */
function watching(containerId: string): SessionClient {
  return new SessionClient({ url: "ws://test/ws/session", containerId, token: "tok" });
}

describe("panel session handle", () => {
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
    const first = watching("c1");
    const second = watching("c1");
    const releaseFirst = pipes.register("c1", first);
    const releaseSecond = pipes.register("c1", second);

    releaseFirst();
    expect(pipes.pipeOf("c1")).toBe(second);
    releaseSecond();
    expect(() => pipes.pipeOf("c1")).toThrow("no occupant view of container c1 is mounted");
  });
});
