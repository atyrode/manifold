import { expect, test } from "bun:test";
import { PROTOCOL_VERSION, type ServerMessage } from "@manifold/protocol";
import {
  createPad,
  mintToken,
  rawSessionSocket,
  startServer,
  waitFor,
  type AdversarialSessionSocket,
  type TestServer,
} from "../src/index.ts";
import { e2eFailure, sceneElement, stopProcesses } from "./helpers.ts";

type InitMessage = Extract<ServerMessage, { type: "init" }>;

async function joinRaw(
  socket: AdversarialSessionSocket,
  padId: string,
  token: string,
): Promise<InitMessage> {
  socket.sendRaw(JSON.stringify({ type: "join", padId, token, protocolVersion: PROTOCOL_VERSION }));
  const message = await waitFor(
    () => socket.frames.find((frame) => frame.type === "init"),
    5_000,
    20,
  );
  if (message.type !== "init") throw new Error("raw join returned a non-init frame");
  return message;
}

async function closeSockets(sockets: readonly AdversarialSessionSocket[]): Promise<void> {
  const results = await Promise.allSettled(sockets.map((socket) => socket.close()));
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

test("raw adversarial frames prove join ordering and frame-classification policy", async () => {
  const servers: TestServer[] = [];
  const sockets: AdversarialSessionSocket[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const pad = await createPad(server, "adversarial");
    const grant = await mintToken(server, {
      principal: { kind: "human", name: "Adversary", color: "#b84a4a" },
      caps: ["pads:read", "scene:write"],
      padId: pad.id,
    });

    const wrongFirst = await rawSessionSocket(server);
    sockets.push(wrongFirst);
    wrongFirst.sendRaw(JSON.stringify({ type: "ping" }));
    const wrongFirstClose = await waitFor(() => wrongFirst.closeInfo, 5_000, 20);
    expect(wrongFirst.closeInfo).toEqual(wrongFirstClose);

    const epochMismatch = await rawSessionSocket(server);
    sockets.push(epochMismatch);
    const epochInit = await joinRaw(epochMismatch, pad.id, grant.token);
    expect(epochInit.rev).toBe(0);
    epochMismatch.sendRaw(
      JSON.stringify({
        type: "scene_update",
        updateId: "wrong-epoch",
        epoch: "WRONG",
        baseRev: 0,
        elements: [sceneElement("el-wrong-epoch")],
      }),
    );
    await waitFor(
      () =>
        epochMismatch.frames.some(
          (frame) => frame.type === "error" && frame.code === "epoch_mismatch",
        ) && epochMismatch.frames.some((frame) => frame.type === "resync"),
      5_000,
      20,
    );
    expect(
      epochMismatch.frames.some(
        (frame) => frame.type === "error" && frame.code === "epoch_mismatch",
      ),
    ).toBe(true);
    expect(epochMismatch.frames.some((frame) => frame.type === "resync")).toBe(true);

    const malformedKnown = await rawSessionSocket(server);
    sockets.push(malformedKnown);
    const malformedInit = await joinRaw(malformedKnown, pad.id, grant.token);
    malformedKnown.sendRaw(
      JSON.stringify({
        type: "scene_update",
        updateId: "malformed-elements",
        epoch: malformedInit.epoch,
        baseRev: malformedInit.rev,
        elements: "nope",
      }),
    );
    const malformedClose = await waitFor(() => malformedKnown.closeInfo, 5_000, 20);
    expect(malformedKnown.closeInfo).toEqual(malformedClose);

    const unknownType = await rawSessionSocket(server);
    sockets.push(unknownType);
    await joinRaw(unknownType, pad.id, grant.token);
    unknownType.sendRaw(JSON.stringify({ type: "zorp" }));
    unknownType.sendRaw(JSON.stringify({ type: "ping" }));
    await waitFor(() => unknownType.frames.some((frame) => frame.type === "pong"), 5_000, 20);
    expect(unknownType.readyState).toBe(WebSocket.OPEN);

    const oversized = await rawSessionSocket(server);
    sockets.push(oversized);
    const oversizedInit = await joinRaw(oversized, pad.id, grant.token);
    const frameStart = oversized.frames.length;
    oversized.sendRaw(
      JSON.stringify({
        type: "scene_update",
        updateId: "oversized-batch",
        epoch: oversizedInit.epoch,
        baseRev: oversizedInit.rev,
        elements: Array.from({ length: 129 }, (_, index) => sceneElement(`el-big-${index}`)),
      }),
    );
    // The scene limit says "rejected" while the known-malformed policy says policy-close.
    // The target explicitly permits either an `invalid` error or that close, but never acceptance.
    const oversizedOutcome = await waitFor(
      () => {
        const invalid = oversized.frames
          .slice(frameStart)
          .find((frame) => frame.type === "error" && frame.code === "invalid");
        if (invalid !== undefined) return "invalid" as const;
        if (oversized.closeInfo !== null) return "closed" as const;
        return false;
      },
      5_000,
      20,
    );
    expect(["invalid", "closed"]).toContain(oversizedOutcome);
    expect(
      oversized.frames.some(
        (frame) =>
          frame.type === "scene_applied" &&
          frame.elements.some((element) => element.id.startsWith("el-big-")),
      ),
    ).toBe(false);
  } catch (error) {
    throw e2eFailure(error, servers);
  } finally {
    await closeSockets(sockets);
    await stopProcesses(servers);
  }
}, 30_000);
