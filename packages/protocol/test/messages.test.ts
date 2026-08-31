import { describe, expect, test } from "bun:test";
import {
  AgentMessageSchema,
  ClientMessageSchema,
  ClientMessageBodySchema,
  CreateContainerRequestSchema,
  MACHINE_PROTOCOL_COMPAT_VERSIONS,
  MAX_GESTURE_POINT_VALUES,
  MintTokenRequestSchema,
  PROTOCOL_VERSION,
  ContainerSchema,
  ROOT_TILE_ID,
  ServerMessageSchema,
  SceneElementSchema,
  TerminalsResponseSchema,
  TileLayoutSchema,
  TileSchema,
  TileRefSchema,
  buildProtocolJsonSchema,
  hasCap,
  validateTileLayout,
  type Tile,
  type TileRef,
} from "@manifold/protocol";

/**
 * The canvas reference every fixture below reuses. A canvas never holds a terminal: it
 * holds a portal onto the composition the terminal lives in.
 */
const element = (id: string) => ({
  id,
  type: "portal" as const,
  containerId: `solo-${id}`,
  x: 0,
  y: 0,
  width: 720,
  height: 480,
  zIndex: 0,
});
describe("session channel schemas", () => {
  test("join round-trips as a channel frame, and its body without routing", () => {
    const body = {
      type: "join" as const,
      containerId: "p1",
      token: "t",
      protocolVersion: PROTOCOL_VERSION,
    };
    const frame = { ...body, ch: "c1" };
    expect(ClientMessageSchema.parse(frame)).toEqual(frame);
    expect(ClientMessageBodySchema.parse(body)).toEqual(body);
    // Routing is not optional on the wire: an untagged channel frame has no room.
    expect(ClientMessageSchema.safeParse(body).success).toBe(false);
  });

  test("channel ids are tokens, so a tagged frame never needs JSON escaping", () => {
    const join = {
      type: "join" as const,
      containerId: "p1",
      token: "t",
      protocolVersion: PROTOCOL_VERSION,
    };
    for (const ch of ["c1", "C-7_x", "a".repeat(64)]) {
      expect(ClientMessageSchema.safeParse({ ...join, ch }).success).toBe(true);
    }
    for (const ch of ["", 'c"1', "container/1", "a".repeat(65), "c 1"]) {
      expect(ClientMessageSchema.safeParse({ ...join, ch }).success).toBe(false);
    }
  });

  test("leave frees one channel; ping/pong stay connection-level", () => {
    expect(ClientMessageSchema.parse({ type: "leave", ch: "c2" })).toEqual({
      type: "leave",
      ch: "c2",
    });
    expect(ClientMessageSchema.safeParse({ type: "leave" }).success).toBe(false);
    // Liveness belongs to the socket: a channel id on ping/pong would be a lie.
    expect(ClientMessageSchema.parse({ type: "ping" })).toEqual({ type: "ping" });
    expect(ServerMessageSchema.parse({ type: "pong" })).toEqual({ type: "pong" });
    expect(ClientMessageSchema.safeParse({ type: "ping", ch: "c1" }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ type: "pong", ch: "c1" }).success).toBe(false);
  });

  test("channel_closed carries the close vocabulary a socket close used to carry", () => {
    const frame = {
      type: "channel_closed" as const,
      ch: "c3",
      code: 4404,
      reason: "container deleted",
    };
    expect(ServerMessageSchema.parse(frame)).toEqual(frame);
    expect(ServerMessageSchema.safeParse({ ...frame, code: 0 }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ type: "channel_closed", ch: "c3" }).success).toBe(false);
  });

  test("every channel-level frame type round-trips through body and wire unions", () => {
    const bodies = [
      { type: "resync_request" as const },
      { type: "terminal_attach" as const, terminalId: "s1" },
      { type: "terminal_detach" as const, terminalId: "s1" },
      { type: "terminal_resize" as const, terminalId: "s1", cols: 80, rows: 24 },
      { type: "terminal_take" as const, terminalId: "s1" },
      { type: "terminal_kill" as const, terminalId: "s1" },
      { type: "terminal_open" as const, elementId: "el1", cols: 80, rows: 24 },
    ];
    for (const body of bodies) {
      expect(ClientMessageBodySchema.parse(body)).toEqual(body);
      expect(ClientMessageSchema.parse({ ...body, ch: "c9" })).toEqual({ ...body, ch: "c9" });
      expect(ClientMessageSchema.safeParse(body).success).toBe(false);
    }
  });

  test("terminal_event carries the parked kind", () => {
    const msg = {
      type: "terminal_event" as const,
      ch: "c1",
      terminalId: "s1",
      kind: "parked" as const,
    };
    expect(ServerMessageSchema.parse(msg)).toEqual(msg);
    expect(
      ServerMessageSchema.safeParse({
        type: "terminal_event",
        ch: "c1",
        terminalId: "s1",
        kind: "vanished",
      }).success,
    ).toBe(false);
  });

  test("terminal_event carries the renamed kind and its new label", () => {
    const msg = {
      type: "terminal_event" as const,
      ch: "c1",
      terminalId: "s1",
      kind: "renamed" as const,
      name: "build",
    };
    expect(ServerMessageSchema.parse(msg)).toEqual(msg);
    // A rename with no label is nonsense on the wire, but the field is optional so
    // every other kind stays parseable; the SDK treats absence as "cleared".
    expect(
      ServerMessageSchema.safeParse({
        type: "terminal_event",
        ch: "c1",
        terminalId: "s1",
        kind: "renamed",
      }).success,
    ).toBe(true);
    expect(
      ServerMessageSchema.safeParse({
        type: "terminal_event",
        ch: "c1",
        terminalId: "s1",
        kind: "renamed",
        name: "",
      }).success,
    ).toBe(false);
  });

  test("doc updates require bounded base64 payloads", () => {
    expect(
      ClientMessageSchema.safeParse({ type: "doc_update", ch: "c1", update: btoa("yjs update") })
        .success,
    ).toBe(true);
    expect(
      ClientMessageSchema.safeParse({ type: "doc_update", ch: "c1", update: "not base64!!" })
        .success,
    ).toBe(false);
    expect(
      ClientMessageSchema.safeParse({ type: "doc_update", ch: "c1", update: "a".repeat(700_004) })
        .success,
    ).toBe(false);
  });

  test("gesture frames are bounded and server identity is stamped", () => {
    const gesture = {
      type: "gesture" as const,
      ch: "c1",
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
    expect(ClientMessageSchema.safeParse({ type: "mystery", ch: "c1" }).success).toBe(false);
  });

  test("terminal_input requires base64 payload", () => {
    const bad = { type: "terminal_input", ch: "c1", terminalId: "s", data: "not base64!!" };
    expect(ClientMessageSchema.safeParse(bad).success).toBe(false);
    const good = { type: "terminal_input", ch: "c1", terminalId: "s", data: btoa("ls -la\n") };
    expect(ClientMessageSchema.safeParse(good).success).toBe(true);
  });

  test("init/resync require the server-assigned connection id", () => {
    const state = {
      ch: "c1",
      protocolVersion: PROTOCOL_VERSION,
      epoch: "e1",
      rev: 7,
      doc: btoa("document"),
      self: { id: "pr1", kind: "human", name: "alex", color: "#aabb00" },
      selfConnId: "conn-1",
      selfCaps: ["*"],
      attendance: [],
      terminals: [],
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
        ch: "c1",
        principalId: "pr1",
        connId: "conn-1",
        x: 12,
        y: 34,
      }).success,
    ).toBe(true);
    expect(
      ServerMessageSchema.safeParse({
        type: "presence",
        ch: "c1",
        principalId: "pr1",
        connId: "conn-1",
        payload: { status: "active" },
      }).success,
    ).toBe(true);
    expect(
      ServerMessageSchema.safeParse({
        type: "cursor",
        ch: "c1",
        principalId: "pr1",
        x: 12,
        y: 34,
      }).success,
    ).toBe(false);
    expect(
      ServerMessageSchema.safeParse({
        type: "presence",
        ch: "c1",
        principalId: "pr1",
        payload: {},
      }).success,
    ).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: "cursor", ch: "c1", x: 12, y: 34 }).success).toBe(
      true,
    );
    expect(ClientMessageSchema.safeParse({ type: "presence", ch: "c1", payload: {} }).success).toBe(
      true,
    );
    expect(
      ClientMessageSchema.safeParse({ type: "cursor", ch: "c1", connId: "spoof", x: 12, y: 34 })
        .success,
    ).toBe(false);
  });

  test("scene records validate portal, collaborative text, and freedraw variants", () => {
    expect(SceneElementSchema.parse(element("portal-1"))).toEqual(element("portal-1"));
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
      containerId: "c-1",
      x: 8,
      y: 16,
      width: 720,
      height: 480,
      zIndex: 3,
    };
    expect(SceneElementSchema.parse(portal)).toEqual(portal);
    // The discriminant owns the payload shape: a portal carries a container, never a terminal.
    expect(SceneElementSchema.safeParse({ ...portal, containerId: "" }).success).toBe(false);
    expect(SceneElementSchema.safeParse({ ...portal, terminalId: "s1" }).success).toBe(false);
  });

  test("the retired terminal element kind is refused on the wire", () => {
    // A canvas never holds a terminal. The element that used to carry one now carries the
    // id of the composition the terminal lives in, so the old kind has to fail to PARSE —
    // a doc still emitting it is a bug in the writer, not a variant to tolerate.
    const terminalElement = {
      id: "terminal-1",
      type: "terminal",
      terminalId: "terminal-1",
      x: 0,
      y: 0,
      width: 720,
      height: 480,
      zIndex: 0,
    };
    expect(SceneElementSchema.safeParse(terminalElement).success).toBe(false);
    // Nor does dropping the terminal id rescue it: `terminal` is not a discriminant value.
    expect(
      SceneElementSchema.safeParse({ ...terminalElement, terminalId: undefined }).success,
    ).toBe(false);
  });
});

describe("machine channel schemas", () => {
  test("hello advertises surviving terminals with seq watermarks", () => {
    const msg = AgentMessageSchema.parse({
      type: "hello",
      token: "mt",
      name: "devbox",
      agentVersion: "0.1.0",
      protocolVersion: PROTOCOL_VERSION,
      terminals: [{ terminalId: "s1", cols: 80, rows: 24, alive: true, seq: 4213 }],
    });
    if (msg.type !== "hello") throw new Error("unreachable");
    expect(msg.terminals[0]?.seq).toBe(4213);
  });

  test("output seq must be positive", () => {
    const bad = { type: "output", terminalId: "s", seq: 0, data: btoa("x") };
    expect(AgentMessageSchema.safeParse(bad).success).toBe(false);
  });
});

describe("capabilities", () => {
  test("wildcard grants everything; scoped caps only themselves", () => {
    expect(hasCap(["*"], "terminals:write")).toBe(true);
    expect(hasCap(["scenes:write"], "scenes:write")).toBe(true);
    expect(hasCap(["scenes:write"], "terminals:write")).toBe(false);
  });
});

describe("http schemas", () => {
  test("mint requires exactly one of principalId | principal", () => {
    expect(
      MintTokenRequestSchema.safeParse({ caps: ["scenes:write"], principalId: "p" }).success,
    ).toBe(true);
    expect(
      MintTokenRequestSchema.safeParse({
        caps: ["scenes:write"],
        principalId: "p",
        principal: { name: "x", kind: "agent" },
      }).success,
    ).toBe(false);
    expect(MintTokenRequestSchema.safeParse({ caps: ["scenes:write"] }).success).toBe(false);
  });

  test("the terminal index round-trips a row that names where the terminal lives", () => {
    const entry = {
      id: "s1",
      machineId: "m1",
      name: null,
      createdAt: 1,
      status: "running" as const,
      exitCode: null,
      homeId: "solo-1",
      unplaced: true,
    };
    expect(TerminalsResponseSchema.parse({ terminals: [entry] }).terminals[0]).toEqual(entry);
    expect(
      TerminalsResponseSchema.parse({
        terminals: [{ ...entry, name: "build", unplaced: false }],
      }).terminals[0],
    ).toEqual({ ...entry, name: "build", unplaced: false });
  });

  test("a terminal row without a home, or without a placement answer, is not a terminal", () => {
    const entry = {
      id: "s1",
      machineId: "m1",
      name: null,
      createdAt: 1,
      status: "running" as const,
      exitCode: null,
      homeId: "solo-1",
      unplaced: true,
    };
    // Every terminal lives in a composition, so a row that cannot say which one is not a
    // row with a missing field — it describes something the model has no place for.
    const homeless: Record<string, unknown> = { ...entry };
    delete homeless["homeId"];
    expect(TerminalsResponseSchema.safeParse({ terminals: [homeless] }).success).toBe(false);
    expect(
      TerminalsResponseSchema.safeParse({ terminals: [{ ...entry, homeId: "" }] }).success,
    ).toBe(false);
    // `unplaced` is derived, never stored, and the endpoint lists EVERY terminal — so the
    // flag is what tells top-level rows from placed ones and cannot be left out.
    const unanswered: Record<string, unknown> = { ...entry };
    delete unanswered["unplaced"];
    expect(TerminalsResponseSchema.safeParse({ terminals: [unanswered] }).success).toBe(false);
    // The pool's durable ordering retired with the pool: index order is the index tree's.
    expect(
      TerminalsResponseSchema.safeParse({ terminals: [{ ...entry, sortOrder: 0 }] }).success,
    ).toBe(false);
  });

  test("containers carry a discipline and nothing about bubbles", () => {
    const container = {
      id: "p1",
      name: "Notes",
      createdAt: 5,
      discipline: "canvas" as const,
    };
    expect(ContainerSchema.parse(container)).toEqual(container);
    expect(ContainerSchema.parse({ ...container, discipline: "composition" })).toEqual({
      ...container,
      discipline: "composition",
    });
    // The discipline is required on the wire: a container without one is unrenderable.
    expect(ContainerSchema.safeParse({ id: "p1", name: "Notes", createdAt: 5 }).success).toBe(
      false,
    );
    expect(ContainerSchema.safeParse({ ...container, discipline: "grid" }).success).toBe(false);
    // Transience is gone with the bubbles: every composition is durable, so a row still
    // carrying the flag is stale state and must fail to parse rather than be ignored.
    expect(ContainerSchema.safeParse({ ...container, transient: false }).success).toBe(false);
    expect(ContainerSchema.safeParse({ ...container, transient: true }).success).toBe(false);
  });

  test("container creation takes an optional discipline and never a bubble flag", () => {
    expect(CreateContainerRequestSchema.parse({ name: "Notes" })).toEqual({ name: "Notes" });
    expect(CreateContainerRequestSchema.parse({ name: "Desk", discipline: "composition" })).toEqual(
      {
        name: "Desk",
        discipline: "composition",
      },
    );
    expect(
      CreateContainerRequestSchema.safeParse({ name: "Notes", discipline: "grid" }).success,
    ).toBe(false);
    expect(CreateContainerRequestSchema.safeParse({ name: "Notes", transient: true }).success).toBe(
      false,
    );
  });
});

describe("tile layout schemas", () => {
  const leaf = (id: string, ref: TileRef | null = null): Tile => ({
    id,
    dir: null,
    ratios: [],
    children: [],
    ref,
  });
  const split = (id: string, children: readonly string[]): Tile => ({
    id,
    dir: "row",
    ratios: children.map(() => 1 / children.length),
    children: [...children],
    ref: null,
  });
  const terminal = (terminalId: string): TileRef => ({ kind: "terminal", terminalId });

  test("refs discriminate terminals from embedded canvases", () => {
    expect(TileRefSchema.parse(terminal("s1"))).toEqual({ kind: "terminal", terminalId: "s1" });
    expect(TileRefSchema.parse({ kind: "container", containerId: "p1" })).toEqual({
      kind: "container",
      containerId: "p1",
    });
    expect(TileRefSchema.safeParse({ kind: "container", containerId: "" }).success).toBe(false);
    expect(TileRefSchema.safeParse({ kind: "browser", url: "https://x" }).success).toBe(false);
    expect(
      TileRefSchema.safeParse({ kind: "terminal", terminalId: "s1", containerId: "p1" }).success,
    ).toBe(false);
  });

  test("nodes accept both shapes and reject malformed geometry", () => {
    expect(TileSchema.parse(leaf(ROOT_TILE_ID))).toEqual(leaf(ROOT_TILE_ID));
    expect(TileSchema.parse(split("s", ["a", "b"]))).toEqual(split("s", ["a", "b"]));
    expect(TileSchema.safeParse({ ...leaf("t1"), dir: "diagonal" }).success).toBe(false);
    expect(TileSchema.safeParse({ ...split("s", ["a", "b"]), ratios: [0, 1] }).success).toBe(false);
    expect(TileSchema.safeParse({ ...leaf("t1"), extra: 1 }).success).toBe(false);
    expect(TileSchema.safeParse({ ...leaf("t1"), id: "" }).success).toBe(false);
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
        t2: leaf("t2", { kind: "container", containerId: "p1" }),
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
    // Refs live on leaves; splits carry structure only.
    expect(
      validateTileLayout({
        root: { ...split(ROOT_TILE_ID, ["t1"]), ref: terminal("s1") },
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
      t1: leaf("t1", { kind: "container" as const, containerId: "c-1" }),
      t2: leaf("t2", terminal("s1")),
    };
    expect(validateTileLayout(layout, "c-1")).toBe(false);
    expect(validateTileLayout(layout, "c-2")).toBe(true);
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

describe("machine-channel compatibility (AGENTS.md invariant 10)", () => {
  test("v16 RESETS the acceptance set, because the agent wire itself moved", () => {
    /*
      The verdict a bump owes: v15 -> v16 is the lexicon cut, and it renamed the MACHINE
      wire — `sessionId` became `terminalId` on every agent frame, `hello.sessions` became
      `hello.terminals`, and the injected PTY environment carries `MANIFOLD_CONTAINER`. A
      v15 agent can neither be understood nor understand this server, so the set is reset
      to `{16}` and the upgrade is a coordinated fleet restart. Every earlier bump left the
      agent wire byte-identical (or additive-optional) and therefore ADDED; this one is the
      first that could not.
    */
    expect(MACHINE_PROTOCOL_COMPAT_VERSIONS.has(PROTOCOL_VERSION)).toBe(true);
    expect([...MACHINE_PROTOCOL_COMPAT_VERSIONS]).toEqual([PROTOCOL_VERSION]);
  });
});
