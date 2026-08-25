import { describe, expect, test } from "bun:test";
import {
  AgentMessageSchema,
  ClientMessageSchema,
  MAX_ELEMENTS_PER_UPDATE,
  MintTokenRequestSchema,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  TerminalCustomDataSchema,
  buildProtocolJsonSchema,
  hasCap,
} from "@manifold/protocol";

const element = (id: string) => ({ id, version: 1, versionNonce: 2, isDeleted: false });

describe("session channel schemas", () => {
  test("join round-trips", () => {
    const msg = {
      type: "join" as const,
      padId: "p1",
      token: "t",
      protocolVersion: PROTOCOL_VERSION,
    };
    expect(ClientMessageSchema.parse(msg)).toEqual(msg);
  });

  test("scene_update requires the epoch fence", () => {
    const noEpoch = {
      type: "scene_update",
      updateId: "u1",
      baseRev: 0,
      elements: [element("a")],
    };
    expect(ClientMessageSchema.safeParse(noEpoch).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ ...noEpoch, epoch: "e1" }).success).toBe(true);
  });

  test("unknown Excalidraw element properties pass through opaquely", () => {
    const msg = ClientMessageSchema.parse({
      type: "scene_update",
      updateId: "u1",
      epoch: "e1",
      baseRev: 3,
      elements: [{ ...element("a"), strokeColor: "#fff", points: [[0, 1]] }],
    });
    if (msg.type !== "scene_update") throw new Error("unreachable");
    expect(msg.elements[0]).toMatchObject({ strokeColor: "#fff" });
  });

  test("oversized batches are rejected", () => {
    const elements = Array.from({ length: MAX_ELEMENTS_PER_UPDATE + 1 }, (_, i) =>
      element(`e${i}`),
    );
    const res = ClientMessageSchema.safeParse({
      type: "scene_update",
      updateId: "u",
      epoch: "e1",
      baseRev: 0,
      elements,
    });
    expect(res.success).toBe(false);
  });

  test("unknown message types are rejected (caller logs and ignores)", () => {
    expect(ClientMessageSchema.safeParse({ type: "mystery" }).success).toBe(false);
  });

  test("terminal_input requires base64 payload", () => {
    const bad = { type: "terminal_input", sessionId: "s", data: "not base64!!" };
    expect(ClientMessageSchema.safeParse(bad).success).toBe(false);
    const good = { type: "terminal_input", sessionId: "s", data: btoa("ls -la\n") };
    expect(ClientMessageSchema.safeParse(good).success).toBe(true);
  });

  test("init/resync require the server-assigned connection id", () => {
    const state = {
      protocolVersion: PROTOCOL_VERSION,
      epoch: "e1",
      rev: 7,
      elements: [element("a")],
      self: { id: "pr1", kind: "human", name: "alex", color: "#aabb00" },
      selfConnId: "conn-1",
      roster: [],
      sessions: [],
    };
    expect(ServerMessageSchema.safeParse({ type: "init", ...state }).success).toBe(true);
    expect(ServerMessageSchema.safeParse({ type: "resync", ...state }).success).toBe(true);
    const missingConnId = { ...state } as Record<string, unknown>;
    delete missingConnId["selfConnId"];
    expect(ServerMessageSchema.safeParse({ type: "init", ...missingConnId }).success).toBe(false);
  });

  test("server cursor and presence require connId while client frames omit it", () => {
    expect(
      ServerMessageSchema.safeParse({
        type: "cursor",
        principalId: "pr1",
        connId: "conn-1",
        x: 12,
        y: 34,
      }).success,
    ).toBe(true);
    expect(
      ServerMessageSchema.safeParse({
        type: "presence",
        principalId: "pr1",
        connId: "conn-1",
        payload: { status: "active" },
      }).success,
    ).toBe(true);
    expect(
      ServerMessageSchema.safeParse({ type: "cursor", principalId: "pr1", x: 12, y: 34 }).success,
    ).toBe(false);
    expect(
      ServerMessageSchema.safeParse({
        type: "presence",
        principalId: "pr1",
        payload: {},
      }).success,
    ).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: "cursor", x: 12, y: 34 }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: "presence", payload: {} }).success).toBe(true);
    expect(
      ClientMessageSchema.safeParse({ type: "cursor", connId: "spoof", x: 12, y: 34 }).success,
    ).toBe(false);
  });

  test("terminal customData carries the fork-gate flags and stays loose", () => {
    const parsed = TerminalCustomDataSchema.parse({
      kind: "terminal",
      sessionId: "s1",
      showHyperlinkIcon: false,
      fullInteractionTarget: true,
      showShapeActions: false,
      futureKey: "still passes",
    });
    expect(parsed.sessionId).toBe("s1");
    // The web layer rides these into the fork's re-derived per-element gates
    // (link affordance off, whole-element click-to-activate, style panel
    // suppressed). A stricter schema would strip (object) or reject
    // (strictObject) them and revert to stock.
    expect(parsed.showHyperlinkIcon).toBe(false);
    expect(parsed.fullInteractionTarget).toBe(true);
    expect(parsed.showShapeActions).toBe(false);
    expect((parsed as Record<string, unknown>)["futureKey"]).toBe("still passes");
  });
});

describe("machine channel schemas", () => {
  test("hello advertises surviving sessions with seq watermarks", () => {
    const msg = AgentMessageSchema.parse({
      type: "hello",
      token: "mt",
      name: "devbox",
      agentVersion: "0.1.0",
      protocolVersion: PROTOCOL_VERSION,
      sessions: [{ sessionId: "s1", cols: 80, rows: 24, alive: true, seq: 4213 }],
    });
    if (msg.type !== "hello") throw new Error("unreachable");
    expect(msg.sessions[0]?.seq).toBe(4213);
  });

  test("output seq must be positive", () => {
    const bad = { type: "output", sessionId: "s", seq: 0, data: btoa("x") };
    expect(AgentMessageSchema.safeParse(bad).success).toBe(false);
  });
});

describe("capabilities", () => {
  test("wildcard grants everything; scoped caps only themselves", () => {
    expect(hasCap(["*"], "terminal:write")).toBe(true);
    expect(hasCap(["scene:write"], "scene:write")).toBe(true);
    expect(hasCap(["scene:write"], "terminal:write")).toBe(false);
  });
});

describe("http schemas", () => {
  test("mint requires exactly one of principalId | principal", () => {
    expect(
      MintTokenRequestSchema.safeParse({ caps: ["scene:write"], principalId: "p" }).success,
    ).toBe(true);
    expect(
      MintTokenRequestSchema.safeParse({
        caps: ["scene:write"],
        principalId: "p",
        principal: { name: "x", kind: "agent" },
      }).success,
    ).toBe(false);
    expect(MintTokenRequestSchema.safeParse({ caps: ["scene:write"] }).success).toBe(false);
  });
});

describe("json schema export", () => {
  test("builds without throwing and names the protocol version", () => {
    const schema = buildProtocolJsonSchema();
    expect(schema["protocolVersion"]).toBe(PROTOCOL_VERSION);
    expect(schema["session"]).toBeDefined();
    expect(schema["machine"]).toBeDefined();
  });
});
