import { describe, expect, test } from "bun:test";
import {
  AgentMessageSchema,
  BindTerminalRequestSchema,
  ClientMessageSchema,
  CreatePadRequestSchema,
  MAX_GESTURE_POINT_VALUES,
  MintTokenRequestSchema,
  MoveTerminalPoolRequestSchema,
  PROTOCOL_VERSION,
  PadSchema,
  ParkTerminalRequestSchema,
  ROOT_TILE_ID,
  RenameTerminalRequestSchema,
  ServerMessageSchema,
  SceneElementSchema,
  TerminalPoolResponseSchema,
  TileLayoutSchema,
  TileNodeSchema,
  TileSurfaceSchema,
  buildProtocolJsonSchema,
  hasCap,
  validateTileLayout,
  type TileNode,
  type TileSurface,
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

  test("session_event carries the parked kind", () => {
    const msg = { type: "session_event" as const, sessionId: "s1", kind: "parked" as const };
    expect(ServerMessageSchema.parse(msg)).toEqual(msg);
    expect(
      ServerMessageSchema.safeParse({ type: "session_event", sessionId: "s1", kind: "vanished" })
        .success,
    ).toBe(false);
  });

  test("session_event carries the renamed kind and its new label", () => {
    const msg = {
      type: "session_event" as const,
      sessionId: "s1",
      kind: "renamed" as const,
      name: "build",
    };
    expect(ServerMessageSchema.parse(msg)).toEqual(msg);
    // A rename with no label is nonsense on the wire, but the field is optional so
    // every other kind stays parseable; the SDK treats absence as "cleared".
    expect(
      ServerMessageSchema.safeParse({ type: "session_event", sessionId: "s1", kind: "renamed" })
        .success,
    ).toBe(true);
    expect(
      ServerMessageSchema.safeParse({
        type: "session_event",
        sessionId: "s1",
        kind: "renamed",
        name: "",
      }).success,
    ).toBe(false);
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

  test("scene records validate the portal container variant", () => {
    const portal = {
      id: "portal-1",
      type: "portal" as const,
      containerId: "view-1",
      x: 8,
      y: 16,
      width: 720,
      height: 480,
      zIndex: 3,
    };
    expect(SceneElementSchema.parse(portal)).toEqual(portal);
    // A portal is not a terminal: the discriminant owns the payload shape.
    expect(SceneElementSchema.safeParse({ ...portal, containerId: "" }).success).toBe(false);
    expect(SceneElementSchema.safeParse({ ...portal, sessionId: "s1" }).success).toBe(false);
    expect(SceneElementSchema.safeParse({ ...element("portal-2"), type: "portal" }).success).toBe(
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

  test("terminal pool and park/bind shapes round-trip", () => {
    const entry = {
      id: "s1",
      machineId: "m1",
      name: null,
      createdAt: 1,
      status: "running" as const,
      exitCode: null,
      sortOrder: 0,
    };
    expect(TerminalPoolResponseSchema.parse({ terminals: [entry] }).terminals[0]).toEqual(entry);
    expect(
      TerminalPoolResponseSchema.parse({ terminals: [{ ...entry, name: "build", sortOrder: 3 }] })
        .terminals[0],
    ).toEqual({ ...entry, name: "build", sortOrder: 3 });
    expect(
      TerminalPoolResponseSchema.safeParse({ terminals: [{ ...entry, sortOrder: 1.5 }] }).success,
    ).toBe(false);
    expect(ParkTerminalRequestSchema.safeParse({ elementId: "e1" }).success).toBe(true);
    expect(ParkTerminalRequestSchema.safeParse({}).success).toBe(false);
    expect(BindTerminalRequestSchema.safeParse({ padId: "p1" }).success).toBe(true);
    expect(BindTerminalRequestSchema.safeParse({ padId: "p1", x: 10, y: -4 }).success).toBe(true);
    expect(BindTerminalRequestSchema.safeParse({ padId: "p1", x: "10" }).success).toBe(false);
  });

  test("terminal rename and pool move shapes round-trip", () => {
    expect(RenameTerminalRequestSchema.parse({ name: "build" })).toEqual({ name: "build" });
    expect(RenameTerminalRequestSchema.safeParse({ name: "" }).success).toBe(false);
    expect(RenameTerminalRequestSchema.safeParse({ name: "x".repeat(121) }).success).toBe(false);
    expect(RenameTerminalRequestSchema.safeParse({}).success).toBe(false);
    expect(MoveTerminalPoolRequestSchema.parse({ sessionId: "s1", index: 0 })).toEqual({
      sessionId: "s1",
      index: 0,
    });
    expect(MoveTerminalPoolRequestSchema.safeParse({ sessionId: "s1", index: -1 }).success).toBe(
      false,
    );
    expect(MoveTerminalPoolRequestSchema.safeParse({ sessionId: "s1", index: 1.5 }).success).toBe(
      false,
    );
    expect(MoveTerminalPoolRequestSchema.safeParse({ index: 0 }).success).toBe(false);
  });

  test("pads carry a container discipline and a bubble flag", () => {
    const pad = {
      id: "p1",
      name: "Pad",
      createdAt: 5,
      layout: "canvas" as const,
      transient: false,
    };
    expect(PadSchema.parse(pad)).toEqual(pad);
    expect(PadSchema.parse({ ...pad, layout: "tiled", transient: true })).toEqual({
      ...pad,
      layout: "tiled",
      transient: true,
    });
    // Both fields are required on the wire: a pad without a discipline is unrenderable.
    expect(PadSchema.safeParse({ id: "p1", name: "Pad", createdAt: 5 }).success).toBe(false);
    expect(PadSchema.safeParse({ ...pad, layout: "grid" }).success).toBe(false);
    expect(PadSchema.safeParse({ ...pad, transient: 0 }).success).toBe(false);
  });

  test("pad creation takes an optional discipline and never a bubble flag", () => {
    expect(CreatePadRequestSchema.parse({ name: "Pad" })).toEqual({ name: "Pad" });
    expect(CreatePadRequestSchema.parse({ name: "View", layout: "tiled" })).toEqual({
      name: "View",
      layout: "tiled",
    });
    expect(CreatePadRequestSchema.safeParse({ name: "Pad", layout: "grid" }).success).toBe(false);
    expect(CreatePadRequestSchema.safeParse({ name: "Pad", transient: true }).success).toBe(false);
  });
});

describe("tile layout schemas", () => {
  const leaf = (id: string, surface: TileSurface | null = null): TileNode => ({
    id,
    dir: null,
    ratios: [],
    children: [],
    surface,
  });
  const split = (id: string, children: readonly string[]): TileNode => ({
    id,
    dir: "row",
    ratios: children.map(() => 1 / children.length),
    children: [...children],
    surface: null,
  });
  const terminal = (sessionId: string): TileSurface => ({ kind: "terminal", sessionId });

  test("surfaces discriminate terminals from embedded canvases", () => {
    expect(TileSurfaceSchema.parse(terminal("s1"))).toEqual({ kind: "terminal", sessionId: "s1" });
    expect(TileSurfaceSchema.parse({ kind: "pad", padId: "p1" })).toEqual({
      kind: "pad",
      padId: "p1",
    });
    expect(TileSurfaceSchema.safeParse({ kind: "pad", padId: "" }).success).toBe(false);
    expect(TileSurfaceSchema.safeParse({ kind: "browser", url: "https://x" }).success).toBe(false);
    expect(
      TileSurfaceSchema.safeParse({ kind: "terminal", sessionId: "s1", padId: "p1" }).success,
    ).toBe(false);
  });

  test("nodes accept both shapes and reject malformed geometry", () => {
    expect(TileNodeSchema.parse(leaf(ROOT_TILE_ID))).toEqual(leaf(ROOT_TILE_ID));
    expect(TileNodeSchema.parse(split("s", ["a", "b"]))).toEqual(split("s", ["a", "b"]));
    expect(TileNodeSchema.safeParse({ ...leaf("t1"), dir: "diagonal" }).success).toBe(false);
    expect(TileNodeSchema.safeParse({ ...split("s", ["a", "b"]), ratios: [0, 1] }).success).toBe(
      false,
    );
    expect(TileNodeSchema.safeParse({ ...leaf("t1"), extra: 1 }).success).toBe(false);
    expect(TileNodeSchema.safeParse({ ...leaf("t1"), id: "" }).success).toBe(false);
    expect(TileLayoutSchema.parse({ root: leaf(ROOT_TILE_ID) })).toEqual({
      root: leaf(ROOT_TILE_ID),
    });
    expect(TileLayoutSchema.safeParse({ "": leaf("t1") }).success).toBe(false);
  });

  test("validate accepts a well-formed tree", () => {
    expect(validateTileLayout({ root: leaf(ROOT_TILE_ID) })).toBe(true);
    expect(
      validateTileLayout({
        root: split(ROOT_TILE_ID, ["t1", "t2"]),
        t1: leaf("t1", terminal("s1")),
        t2: leaf("t2", { kind: "pad", padId: "p1" }),
      }),
    ).toBe(true);
    // Unreachable garbage is inert: rejecting it would strand a live room.
    expect(validateTileLayout({ root: leaf(ROOT_TILE_ID), orphan: leaf("orphan") })).toBe(true);
    // A one-child split still renders; the ops collapse it on the next write.
    expect(
      validateTileLayout({ root: split(ROOT_TILE_ID, ["t1"]), t1: leaf("t1", terminal("s1")) }),
    ).toBe(true);
  });

  test("validate rejects every structural break", () => {
    expect(validateTileLayout({ t1: leaf("t1") })).toBe(false);
    expect(validateTileLayout({ root: split(ROOT_TILE_ID, ["t1", "gone"]), t1: leaf("t1") })).toBe(
      false,
    );
    // Reachable twice: one shared child under two parents.
    expect(
      validateTileLayout({
        root: split(ROOT_TILE_ID, ["s1", "s2"]),
        s1: split("s1", ["t1"]),
        s2: split("s2", ["t1"]),
        t1: leaf("t1", terminal("s1")),
      }),
    ).toBe(false);
    // A cycle back to the root is reachable twice as well.
    expect(
      validateTileLayout({
        root: split(ROOT_TILE_ID, ["s1"]),
        s1: split("s1", [ROOT_TILE_ID]),
      }),
    ).toBe(false);
    expect(
      validateTileLayout({
        root: { ...split(ROOT_TILE_ID, ["t1", "t2"]), ratios: [1] },
        t1: leaf("t1"),
        t2: leaf("t2"),
      }),
    ).toBe(false);
    // Surfaces live on leaves; splits carry structure only.
    expect(
      validateTileLayout({
        root: { ...split(ROOT_TILE_ID, ["t1"]), surface: terminal("s1") },
        t1: leaf("t1"),
      }),
    ).toBe(false);
    expect(validateTileLayout({ root: { ...leaf(ROOT_TILE_ID), children: ["t1"] } })).toBe(false);
    // Key and node id must agree, or lookups and writes disagree.
    expect(validateTileLayout({ root: leaf("other") })).toBe(false);
  });

  test("validate rejects a container tiling itself", () => {
    const layout = {
      root: split(ROOT_TILE_ID, ["t1", "t2"]),
      t1: leaf("t1", { kind: "pad" as const, padId: "view-1" }),
      t2: leaf("t2", terminal("s1")),
    };
    expect(validateTileLayout(layout, "view-1")).toBe(false);
    expect(validateTileLayout(layout, "view-2")).toBe(true);
    expect(validateTileLayout(layout)).toBe(true);
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
