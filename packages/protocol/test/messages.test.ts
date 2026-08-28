import { describe, expect, test } from "bun:test";
import {
  AgentMessageSchema,
  ClientMessageSchema,
  MAX_GESTURE_POINT_VALUES,
  MintTokenRequestSchema,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  SceneElementSchema,
  buildProtocolJsonSchema,
  hasCap,
} from "@manifold/protocol";

const element = (id: string) => ({
  id,
  type: "terminal" as const,
  sessionId: `session-${id}`,
  x: 0,
  y: 0,
  width: 720,
  height: 480,
  zIndex: 0,
});

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

  test("doc updates require bounded base64 payloads", () => {
    expect(
      ClientMessageSchema.safeParse({ type: "doc_update", update: btoa("yjs update") }).success,
    ).toBe(true);
    expect(
      ClientMessageSchema.safeParse({ type: "doc_update", update: "not base64!!" }).success,
    ).toBe(false);
    expect(
      ClientMessageSchema.safeParse({ type: "doc_update", update: "a".repeat(700_004) }).success,
    ).toBe(false);
  });

  test("gesture frames are bounded and server identity is stamped", () => {
    const gesture = {
      type: "gesture" as const,
      kind: "draw" as const,
      phase: "active" as const,
      elementId: "stroke-1",
      x: 12,
      y: 34,
      points: [0, 0, 12, 34],
    };
    expect(ClientMessageSchema.safeParse(gesture).success).toBe(true);
    expect(
      ClientMessageSchema.safeParse({
        ...gesture,
        points: Array.from({ length: MAX_GESTURE_POINT_VALUES + 1 }, () => 0),
      }).success,
    ).toBe(false);
    expect(
      ServerMessageSchema.safeParse({
        ...gesture,
        principalId: "principal-1",
        connId: "conn-1",
      }).success,
    ).toBe(true);
    expect(ServerMessageSchema.safeParse({ ...gesture, connId: "spoof" }).success).toBe(false);
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
      doc: btoa("document"),
      self: { id: "pr1", kind: "human", name: "alex", color: "#aabb00" },
      selfConnId: "conn-1",
      selfCaps: ["*"],
      roster: [],
      sessions: [],
    };
    expect(ServerMessageSchema.safeParse({ type: "init", ...state }).success).toBe(true);
    expect(ServerMessageSchema.safeParse({ type: "resync", ...state }).success).toBe(true);
    const missingConnId = { ...state } as Record<string, unknown>;
    delete missingConnId["selfConnId"];
    const missingCaps = { ...state } as Record<string, unknown>;
    delete missingCaps["selfCaps"];
    expect(ServerMessageSchema.safeParse({ type: "init", ...missingCaps }).success).toBe(false);
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

  test("scene records validate terminal, collaborative text, and freedraw variants", () => {
    expect(SceneElementSchema.parse(element("terminal-1"))).toEqual(element("terminal-1"));
    expect(
      SceneElementSchema.safeParse({
        id: "text-1",
        type: "text",
        text: "hello",
        x: 0,
        y: 0,
        width: 240,
        height: 48,
        zIndex: 1,
        fontSize: 20,
        color: "#f8f9fa",
      }).success,
    ).toBe(true);
    expect(
      SceneElementSchema.safeParse({
        id: "draw-1",
        type: "draw",
        points: [0, 0, 10, 10],
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        zIndex: 2,
        strokeWidth: 3,
        color: "#12abEF",
      }).success,
    ).toBe(true);
    expect(SceneElementSchema.safeParse({ ...element("bad"), strokeColor: "#fff" }).success).toBe(
      false,
    );
    expect(SceneElementSchema.safeParse({ ...element("drawing"), type: "rectangle" }).success).toBe(
      false,
    );
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
