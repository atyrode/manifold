import { describe, expect, test } from "bun:test";
import {
  AgentMessageSchema,
  ClientMessageSchema,
  ClientMessageBodySchema,
  CreateContainerRequestSchema,
  MACHINE_PROTOCOL_COMPAT_VERSIONS,
  MAX_DOC_UPDATE_BYTES,
  MAX_ELEMENT_PAYLOAD_KEYS,
  MAX_GESTURE_POINT_VALUES,
  MAX_SESSION_BASE64_CHARS,
  MintTokenRequestSchema,
  PROTOCOL_VERSION,
  PresencePayloadSchema,
  ContainerSchema,
  ROOT_TILE_ID,
  ServerMessageSchema,
  ServerToAgentMessageSchema,
  SceneElementSchema,
  TerminalsResponseSchema,
  MAX_STROKE_POINT_VALUES,
  MAX_TEXT_LENGTH,
  TileLayoutSchema,
  TileSchema,
  TileRefSchema,
  buildProtocolJsonSchema,
  elementPayload,
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
    // Liveness belongs to the socket: a channel id on ping/pong would be a lie. The SERVER
    // asks and the client answers, the orientation every dialed pipe uses.
    expect(ServerMessageSchema.parse({ type: "ping" })).toEqual({ type: "ping" });
    expect(ClientMessageSchema.parse({ type: "pong" })).toEqual({ type: "pong" });
    expect(ServerMessageSchema.safeParse({ type: "ping", ch: "c1" }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: "pong", ch: "c1" }).success).toBe(false);
    // The retired direction is gone, not merely unused: a v18 client's keepalive is refused.
    expect(ClientMessageSchema.safeParse({ type: "ping" }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ type: "pong" }).success).toBe(false);
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

  test("the vantage carries WHICH arrangement is live, and absence still means the root", () => {
    /*
      Arrange mode is scoped: the workspace arranges its panels, and a panel that declared an
      inner arrangement arranges its own parts. Which one is live is published for exactly the
      reason the mode itself is — a collaborator watching panes stop answering the pointer is
      owed the whole sentence, not half of it.
    */
    const scoped = PresencePayloadSchema.parse({
      vantage: { arranging: true, arrangeScope: "core.shell.sidebar" },
    });
    expect(scoped.vantage).toEqual({ arranging: true, arrangeScope: "core.shell.sidebar" });

    // ABSENT PARSES ABSENT. A frame written before the field existed says "arranging, at the
    // root", which is precisely what it meant then — the additive-optional rule, pinned.
    const rootByOmission = PresencePayloadSchema.parse({ vantage: { arranging: true } });
    expect(rootByOmission.vantage).toEqual({ arranging: true });
    expect(rootByOmission.vantage?.arrangeScope).toBeUndefined();

    // And `null` CLEARS it, which is how every nullable facet of a partial update returns to
    // its default: zooming back out to the workspace is one frame, not a re-send of the mode.
    expect(
      PresencePayloadSchema.parse({ vantage: { arranging: true, arrangeScope: null } }).vantage
        ?.arrangeScope,
    ).toBeNull();

    // It is a panel REF, bounded exactly as a `panel` tile leaf's is: the same string, so the
    // scope resolves against the assembly rather than against a second address space.
    expect(PresencePayloadSchema.safeParse({ vantage: { arrangeScope: "" } }).success).toBe(false);
    expect(
      PresencePayloadSchema.safeParse({ vantage: { arrangeScope: "x".repeat(97) } }).success,
    ).toBe(false);
  });

  test("the envelope validates geometry and carries a payload it does not interpret", () => {
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
    // GEOMETRY is still the envelope's, and still strict: it is what every renderer, every
    // placement rule and every fingerprint reads without knowing what the record means.
    expect(SceneElementSchema.safeParse({ ...element("bad"), width: 0 }).success).toBe(false);
    expect(SceneElementSchema.safeParse({ ...element("bad"), zIndex: 1.5 }).success).toBe(false);
    expect(SceneElementSchema.safeParse({ ...element("bad"), id: "" }).success).toBe(false);
    expect(SceneElementSchema.safeParse({ ...element("bad"), type: "" }).success).toBe(false);
  });

  test("a stranger element type round-trips, payload and all", () => {
    /*
      THE property the envelope exists for (ADR 0013 §16). The old schema was a closed
      discriminated union, so a `type` it did not list was refused outright — which meant a
      canvas could not hold a record whose owning plugin was merely absent from this build. That
      is the outcome §4 forbids for panels and sections, arriving through the document plane.
      Now the record survives, keeps its payload byte for byte, and paints a placeholder.
    */
    const stranger = {
      id: "acme-1",
      type: "acme.gantt",
      lanes: ["design", "build"],
      collapsed: false,
      rowHeight: 24,
      note: null,
      x: 12,
      y: 34,
      width: 400,
      height: 200,
      zIndex: 5,
    };
    expect(SceneElementSchema.parse(stranger)).toEqual(stranger);
    expect(elementPayload(SceneElementSchema.parse(stranger))).toEqual({
      lanes: ["design", "build"],
      collapsed: false,
      rowHeight: 24,
      note: null,
    });
  });

  test("the payload is BOUNDED, so loosening the schema opened a vocabulary and not a blob channel", () => {
    const base = element("bounded");
    // Depth one only: an object graph inside a record would be a second document plane.
    expect(SceneElementSchema.safeParse({ ...base, nested: { a: 1 } }).success).toBe(false);
    expect(SceneElementSchema.safeParse({ ...base, deep: [[1]] }).success).toBe(false);
    // The ceilings are the UNION of the ceilings the retired union members carried, so nothing
    // that validated before the envelope stops validating now.
    expect(
      SceneElementSchema.safeParse({ ...base, prose: "x".repeat(MAX_TEXT_LENGTH) }).success,
    ).toBe(true);
    expect(
      SceneElementSchema.safeParse({ ...base, prose: "x".repeat(MAX_TEXT_LENGTH + 1) }).success,
    ).toBe(false);
    expect(
      SceneElementSchema.safeParse({
        ...base,
        run: Array.from({ length: MAX_STROKE_POINT_VALUES }, () => 0),
      }).success,
    ).toBe(true);
    expect(
      SceneElementSchema.safeParse({
        ...base,
        run: Array.from({ length: MAX_STROKE_POINT_VALUES + 1 }, () => 0),
      }).success,
    ).toBe(false);
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: MAX_ELEMENT_PAYLOAD_KEYS + 1 }, (_unused, index) => [
        `k${String(index)}`,
        index,
      ]),
    );
    expect(SceneElementSchema.safeParse({ ...base, ...tooManyKeys }).success).toBe(false);
  });

  test("the retired terminal kind is now CARRIED rather than refused, and migration 9 is what removes it", () => {
    /*
      A deliberate reversal, recorded because it reverses a shipped assertion. The old union
      refused `type: "terminal"` on the wire; the envelope carries it as any other kind its
      owner is absent for. That is the better failure: schema 9 already rewrote every such
      record into a `portal` onto the terminal's home composition, so a document still holding
      one is a document the migration did not reach — and a record the reader silently DELETES
      because this build does not know its type is exactly the invisible absence A1 forbids. It
      survives, and it paints the engine's named placeholder where somebody can see it.
    */
    const retired = {
      id: "terminal-1",
      type: "terminal",
      terminalId: "terminal-1",
      x: 0,
      y: 0,
      width: 720,
      height: 480,
      zIndex: 0,
    };
    expect(SceneElementSchema.parse(retired)).toEqual(retired);
    // What still refuses it is OWNERSHIP: no plugin contributes `terminal`, so no renderer
    // claims it, and the canvas mounts the engine's placeholder rather than a terminal.
    expect(elementPayload(SceneElementSchema.parse(retired))).toEqual({
      terminalId: "terminal-1",
    });
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

describe("the base64 wire cap", () => {
  /*
    The cap used to be the literal 700_000 written out at five sites — four schemas and one
    pool guard — and nothing anywhere related it to the payload it exists to admit. These two
    tests are that missing relation: the first says the bound is big enough, the second says
    there is only one of it.
  */
  test("admits the largest legal doc update, base64-encoded", () => {
    // base64 spends four characters per three bytes, padding the final group.
    const encoded = Math.ceil(MAX_DOC_UPDATE_BYTES / 3) * 4;
    expect(MAX_SESSION_BASE64_CHARS).toBeGreaterThanOrEqual(encoded);
  });

  test("bounds every base64 field on both wires at exactly that number", () => {
    // "A" is a legal base64 alphabet character and the length is a multiple of four, so the
    // string is a well-formed encoding: only the length bound can reject it.
    const atCap = "A".repeat(MAX_SESSION_BASE64_CHARS);
    const overCap = "A".repeat(MAX_SESSION_BASE64_CHARS + 4);
    const frames: readonly (readonly [string, (payload: string) => boolean])[] = [
      [
        "client doc_update",
        (data) => ClientMessageBodySchema.safeParse({ type: "doc_update", update: data }).success,
      ],
      [
        "client terminal_input",
        (data) =>
          ClientMessageBodySchema.safeParse({ type: "terminal_input", terminalId: "t", data })
            .success,
      ],
      [
        "server doc_update",
        (data) =>
          ServerMessageSchema.safeParse({ ch: "c1", type: "doc_update", update: data, by: "p" })
            .success,
      ],
      [
        "server terminal_output",
        (data) =>
          ServerMessageSchema.safeParse({
            ch: "c1",
            type: "terminal_output",
            terminalId: "t",
            seq: 1,
            data,
          }).success,
      ],
      [
        "agent output",
        (data) =>
          AgentMessageSchema.safeParse({ type: "output", terminalId: "t", seq: 1, data }).success,
      ],
      [
        "agent snapshot",
        (data) =>
          AgentMessageSchema.safeParse({ type: "snapshot", terminalId: "t", seq: 0, data }).success,
      ],
      [
        "server-to-agent input",
        (data) =>
          ServerToAgentMessageSchema.safeParse({ type: "input", terminalId: "t", data }).success,
      ],
    ];
    for (const [name, accepts] of frames) {
      expect(accepts(atCap), name).toBe(true);
      expect(accepts(overCap), name).toBe(false);
    }
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

  test("a section arrangement is legal on a panel leaf, once per section", () => {
    const panel = (id: string, sections?: readonly string[]): Tile => ({
      ...leaf(id, { kind: "panel", panelId: "core.shell.sidebar" }),
      ...(sections === undefined ? {} : { sections: [...sections] }),
    });

    expect(TileSchema.parse(panel("t1", ["a", "b"]))).toEqual(panel("t1", ["a", "b"]));
    expect(validateTileLayout({ root: panel(ROOT_TILE_ID, ["index", "machines"]) })).toBe(true);
    // Absent is the DEFAULT — manifest order — and stays a legal tree.
    expect(validateTileLayout({ root: panel(ROOT_TILE_ID) })).toBe(true);
    // An empty arrangement is the same state as none, and the writer omits the field; a
    // client that stores it anyway is describing manifest order, which is legal and inert.
    expect(validateTileLayout({ root: panel(ROOT_TILE_ID, []) })).toBe(true);

    // A duplicated id makes "the order" ambiguous, which is the one thing an order may not be.
    expect(validateTileLayout({ root: panel(ROOT_TILE_ID, ["index", "index"]) })).toBe(false);
    // Sections describe what a PANEL hosts: meaningless on a terminal leaf, a vacant leaf
    // or a split, and refused there rather than silently carried.
    expect(
      validateTileLayout({ root: { ...leaf(ROOT_TILE_ID, terminal("s1")), sections: ["index"] } }),
    ).toBe(false);
    expect(validateTileLayout({ root: { ...leaf(ROOT_TILE_ID), sections: ["index"] } })).toBe(
      false,
    );
    expect(
      validateTileLayout({
        root: { ...split(ROOT_TILE_ID, ["t1", "t2"]), sections: ["index"] },
        t1: leaf("t1"),
        t2: leaf("t2"),
      }),
    ).toBe(false);
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

  test("every wire and every vocabulary a stranger's agent needs is a SECTION of one document", () => {
    /*
      A3's onboarding surface, enumerated. `GET /api/protocol` is the one document an integrator
      reads before it has read any source, so a domain that publishes nothing here is a domain a
      stranger has to guess at — and the assertion is the whole key set rather than a spot check
      because that is the only form a MISSING section fails.

      The three wires (session, machine, instance) plus the five vocabularies: placement's
      algebra, the plugin contract, the event plane, the authority model and the credential
      vocabulary (ADR 0019). `actions` and `plugins` are absent on purpose — they are the LIVE
      assembly, handed in by a server that composed one.
    */
    expect(Object.keys(buildProtocolJsonSchema()).sort()).toEqual([
      "eventContract",
      "grantContract",
      "identity",
      "instance",
      "machine",
      "placement",
      "pluginContract",
      "protocolVersion",
      "session",
    ]);
  });
});

describe("machine-channel compatibility (AGENTS.md invariant 10)", () => {
  test("v20 ADDS to the acceptance set, because the agent wire still did not move", () => {
    /*
      The verdict a bump owes. v15 -> v16 was the lexicon cut and RESET the set: it renamed
      the MACHINE wire — `sessionId` became `terminalId` on every agent frame,
      `hello.sessions` became `hello.terminals` — so a v15 agent could neither be understood
      nor understand this server, and the upgrade was a coordinated fleet restart.

      v16 -> v17 (the event plane), v17 -> v18 (cross-instance sharing), v18 -> v19 (the
      session channel's liveness pair, reoriented so the SERVER pings and the browser
      answers) and v19 -> v20 (credential expiry and the credential list, whose one exemption
      is precisely the machine token) are all the other case. Every one of them leaves
      `AgentMessage` and `ServerToAgentMessage` gaining, losing and renaming nothing; an agent
      never sees a principal, a session frame or a browser's throttled timers, and no
      credential an enrolled spoke holds changed meaning at v20. So the invariant's first
      clause applies verbatim — a bump that leaves the agent wire identical ADDS — and a v16
      agent keeps its terminals across this deploy instead of being locked out by a version
      check for a change it cannot see.

      Both halves are asserted: the running version must be accepted (or every agent is
      refused), and every version since the last reset must STILL be accepted (or this is a
      reset wearing an additive bump's clothes, and somebody owes the fleet a restart).
    */
    expect(MACHINE_PROTOCOL_COMPAT_VERSIONS.has(PROTOCOL_VERSION)).toBe(true);
    expect(MACHINE_PROTOCOL_COMPAT_VERSIONS.has(PROTOCOL_VERSION - 1)).toBe(true);
    expect([...MACHINE_PROTOCOL_COMPAT_VERSIONS]).toEqual([
      PROTOCOL_VERSION - 4,
      PROTOCOL_VERSION - 3,
      PROTOCOL_VERSION - 2,
      PROTOCOL_VERSION - 1,
      PROTOCOL_VERSION,
    ]);
  });
});
