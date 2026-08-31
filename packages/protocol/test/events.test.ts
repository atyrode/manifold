import { describe, expect, test } from "bun:test";
import {
  CLIENT_CONNECTION_BODIES,
  CLIENT_MESSAGE_TYPES,
  CONNECTION_BODIES,
  CONNECTION_LEVEL_MESSAGE_TYPES,
  ClientMessageSchema,
  EVENT_KIND_PATTERN,
  EventKindSchema,
  EventPayloadSchema,
  MAX_ELEMENT_PAYLOAD_KEYS,
  MAX_EVENT_KIND_LENGTH,
  MAX_STROKE_POINT_VALUES,
  MAX_SUBSCRIBE_TOPICS,
  MAX_TEXT_LENGTH,
  ManifoldRefSchema,
  PluginManifestSchema,
  SERVER_MESSAGE_TYPES,
  ServerMessageSchema,
  buildProtocolJsonSchema,
  eventVocabulary,
  formatManifoldUri,
  parseManifoldUri,
  type ManifoldRef,
  type ServerEvent,
} from "@manifold/protocol";

/** One of every address form, so a claim about topics is a claim about ALL of them. */
const TOPICS: readonly ManifoldRef[] = [
  { kind: "terminal", terminalId: "t1" },
  { kind: "container", containerId: "c1" },
  { kind: "element", containerId: "c1", elementId: "e1" },
  { kind: "tile", containerId: "c1", tileId: "root" },
  { kind: "principal", principalId: "p1" },
  { kind: "plugin", pluginId: "core.index" },
  { kind: "action", actionName: "core.index.create" },
];

const eventFrame = (over: Record<string, unknown> = {}) => ({
  type: "event" as const,
  topic: { kind: "container" as const, containerId: "c1" },
  kind: "container_created",
  at: 1_700_000_000_000,
  actor: "p1",
  payload: {},
  ...over,
});

describe("the event kind vocabulary", () => {
  test("kinds are snake_case, which is the spelling the durable history already uses", () => {
    /*
      Not a style preference: these exact strings are what the `events` table stores today
      (`terminal_opened` at the broker, `principal_joined` in the room, `token_minted` at the
      identity door), and `terminal_event.kind` spells its closed set the same way. A wire kind
      that differed from the stored kind of the same event by one punctuation mark would be two
      words for one concept, which is the §Lexicon failure the cut exists to prevent.
    */
    for (const kind of [
      "terminal_opened",
      "terminal_exited",
      "principal_joined",
      "token_minted",
      "machine_online",
      "created",
    ]) {
      expect(EventKindSchema.safeParse(kind).success).toBe(true);
    }
  });

  test("a kind that is not one snake_case word run is REFUSED, not normalized", () => {
    // A parser that lowercased or hyphen-swapped would mint a second spelling for one kind and
    // hand a subscriber a name no emitter ever declared.
    for (const kind of [
      "terminalExited", // the manifest's local-name spelling, deliberately not admitted
      "terminal-exited",
      "Terminal_exited",
      "terminal__exited",
      "terminal_",
      "_terminal",
      "terminal exited",
      "core.terminals.exited", // a kind is never qualified by its owner: the topic says whose
      "",
    ]) {
      expect(EventKindSchema.safeParse(kind).success).toBe(false);
    }
  });

  test("a kind is bounded, so a log line can never be handed an unbounded blob as a word", () => {
    const longest = `a${"_b".repeat((MAX_EVENT_KIND_LENGTH - 1) / 2)}`;
    expect(longest.length).toBeLessThanOrEqual(MAX_EVENT_KIND_LENGTH);
    expect(EventKindSchema.safeParse(longest).success).toBe(true);
    expect(EventKindSchema.safeParse("a".repeat(MAX_EVENT_KIND_LENGTH + 1)).success).toBe(false);
    // The published pattern and the enforcing schema are the same regex, not two statements.
    expect(EVENT_KIND_PATTERN.test("terminal_exited")).toBe(true);
    expect(eventVocabulary()["kindPattern"]).toBe(EVENT_KIND_PATTERN.source);
  });

  test("a manifest declares kinds in the SAME spelling the wire carries", () => {
    const manifest = {
      id: "core.terminals",
      version: "0.1.0",
      title: "Terminals",
      description: "",
      capabilities: [],
      contributes: { events: [{ id: "terminal_exited", title: "Terminal exited" }] },
    };
    const parsed = PluginManifestSchema.parse(manifest);
    expect(parsed.contributes.events[0]?.id).toBe("terminal_exited");
    expect(EventKindSchema.safeParse(parsed.contributes.events[0]?.id).success).toBe(true);
    // The narrowing is the point: a manifest cannot declare a kind the wire would refuse.
    expect(
      PluginManifestSchema.safeParse({
        ...manifest,
        contributes: { events: [{ id: "terminalExited", title: "Terminal exited" }] },
      }).success,
    ).toBe(false);
  });
});

describe("the event payload", () => {
  test("it is the ELEMENT payload's discipline, one statement for both planes", () => {
    expect(
      EventPayloadSchema.safeParse({ terminalId: "t1", exitCode: 0, clean: true }).success,
    ).toBe(true);
    expect(EventPayloadSchema.safeParse({ points: [1, 2, 3] }).success).toBe(true);
    // Depth ONE: an object graph inside a notification is a second document plane.
    expect(EventPayloadSchema.safeParse({ nested: { a: 1 } }).success).toBe(false);
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: MAX_ELEMENT_PAYLOAD_KEYS + 1 }, (_unused, index) => [
        `k${String(index)}`,
        index,
      ]),
    );
    expect(EventPayloadSchema.safeParse(tooManyKeys).success).toBe(false);
    expect(EventPayloadSchema.safeParse({ text: "x".repeat(MAX_TEXT_LENGTH + 1) }).success).toBe(
      false,
    );
    expect(
      EventPayloadSchema.safeParse({ run: Array(MAX_STROKE_POINT_VALUES + 1).fill(0) }).success,
    ).toBe(false);
  });

  test("the refusal names the EVENT plane, so a reader learns which payload broke the bound", () => {
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: MAX_ELEMENT_PAYLOAD_KEYS + 1 }, (_unused, index) => [
        `k${String(index)}`,
        index,
      ]),
    );
    const refused = EventPayloadSchema.safeParse(tooManyKeys);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toContain("event payload carries");
  });
});

describe("the subscription frames", () => {
  test("subscribe and unsubscribe are CONNECTION-level: they parse with no channel at all", () => {
    for (const type of ["subscribe", "unsubscribe"] as const) {
      const frame = { type, topics: [...TOPICS] };
      expect(ClientMessageSchema.parse(frame)).toEqual(frame);
      expect(CLIENT_CONNECTION_BODIES[type].safeParse(frame).success).toBe(true);
      // A topic is a NODE, not a room: tagging a subscription with a channel would tie its
      // lifetime to a membership that has nothing to do with it.
      expect(ClientMessageSchema.safeParse({ ...frame, ch: "c1" }).success).toBe(false);
    }
  });

  test("a topic is a structured ref, so no address string can be typed onto the wire", () => {
    /*
      This is the runtime-joined-namespace law held by CONSTRUCTION rather than by a check
      (REGISTRY.md §Runtime-joined namespaces): the frame has nowhere to put a hand-written
      `manifold://…`, so there is no joined string namespace to police. `formatManifoldUri`
      stays the one joiner, used by each side to key its own index.
    */
    expect(
      ClientMessageSchema.safeParse({ type: "subscribe", topics: ["manifold://container/c1"] })
        .success,
    ).toBe(false);
    expect(
      ClientMessageSchema.safeParse({ type: "subscribe", topics: [{ kind: "room", roomId: "r1" }] })
        .success,
    ).toBe(false);
  });

  test("topics per frame are bounded, and an empty subscribe says nothing", () => {
    const topic = { kind: "container" as const, containerId: "c1" };
    expect(ClientMessageSchema.safeParse({ type: "subscribe", topics: [] }).success).toBe(false);
    expect(
      ClientMessageSchema.safeParse({
        type: "subscribe",
        topics: Array.from({ length: MAX_SUBSCRIBE_TOPICS }, () => topic),
      }).success,
    ).toBe(true);
    // Over the bound is a MALFORMED frame, which the grammar already answers with 4002 —
    // no new refusal vocabulary for a client that confused a subscription for a query.
    expect(
      ClientMessageSchema.safeParse({
        type: "subscribe",
        topics: Array.from({ length: MAX_SUBSCRIBE_TOPICS + 1 }, () => topic),
      }).success,
    ).toBe(false);
  });
});

describe("the event frame", () => {
  test("it addresses the SOCKET and carries topic, kind, stamp, actor and payload", () => {
    const frame = eventFrame();
    expect(ServerMessageSchema.parse(frame)).toEqual(frame);
    expect(CONNECTION_BODIES.event.safeParse(frame).success).toBe(true);
    expect(ServerMessageSchema.safeParse({ ...frame, ch: "c1" }).success).toBe(false);
  });

  test("every address form is a legal topic, so no node is unsubscribable", () => {
    for (const topic of TOPICS) {
      expect(ServerMessageSchema.safeParse(eventFrame({ topic })).success).toBe(true);
    }
  });

  test("actor is stated, never implied: null is the engine acting with no principal", () => {
    expect(ServerMessageSchema.safeParse(eventFrame({ actor: null })).success).toBe(true);
    expect(ServerMessageSchema.safeParse(eventFrame({ actor: "" })).success).toBe(false);
    // Absent is not null. A subscriber suppressing the echo of its own mutation reads a
    // value; an optional field would make "nobody did it" and "nobody said" the same frame.
    const { actor: _dropped, ...withoutActor } = eventFrame();
    expect(ServerMessageSchema.safeParse(withoutActor).success).toBe(false);
  });

  test("payload is required and may be empty, so no consumer pays for an undefined branch", () => {
    const { payload: _dropped, ...withoutPayload } = eventFrame();
    expect(ServerMessageSchema.safeParse(withoutPayload).success).toBe(false);
    expect(ServerMessageSchema.safeParse(eventFrame({ payload: { exitCode: 0 } })).success).toBe(
      true,
    );
    expect(ServerMessageSchema.safeParse(eventFrame({ payload: { deep: { a: 1 } } })).success).toBe(
      false,
    );
  });

  test("the frame refuses what the vocabulary refuses: no free-typed kinds, no unstamped events", () => {
    expect(ServerMessageSchema.safeParse(eventFrame({ kind: "containerCreated" })).success).toBe(
      false,
    );
    expect(ServerMessageSchema.safeParse(eventFrame({ at: -1 })).success).toBe(false);
    expect(ServerMessageSchema.safeParse(eventFrame({ at: 1.5 })).success).toBe(false);
    // No offsets, no acknowledgements, no correlation: strict objects make them unsayable.
    expect(ServerMessageSchema.safeParse(eventFrame({ offset: 7 })).success).toBe(false);
    expect(ServerMessageSchema.safeParse(eventFrame({ replyTo: "x" })).success).toBe(false);
  });

  test("the body type is what a consumer holds, exactly as ServerGesture is", () => {
    const parsed = ServerMessageSchema.parse(eventFrame());
    // A compile-time claim as much as a runtime one: the body type has no `ch`, so a
    // subscriber written against it works on any socket.
    const body: ServerEvent = parsed as ServerEvent;
    expect(body.kind).toBe("container_created");
    expect(formatManifoldUri(body.topic)).toBe("manifold://container/c1");
  });
});

describe("topics are the addressing algebra, not a second grammar", () => {
  test("every topic is bijective with the URI a human pastes", () => {
    /*
      The property the plane rests on (ADR 0012 §2): the struct the frame carries and the
      `manifold://` string a link, a log line or a deep link carries are the SAME address. A
      subscriber may key its index by the URI and still be talking about the frame's topic.
    */
    for (const topic of TOPICS) {
      const uri = formatManifoldUri(topic);
      expect(uri.startsWith("manifold://")).toBe(true);
      expect(parseManifoldUri(uri)).toEqual(topic);
      expect(ManifoldRefSchema.parse(topic)).toEqual(topic);
      const frame = ServerMessageSchema.parse(eventFrame({ topic }));
      expect(frame).toMatchObject({ topic });
    }
  });

  test("an id needing escapes survives the round trip, so no topic can be forged by punctuation", () => {
    const topic: ManifoldRef = { kind: "container", containerId: "a/b?c#d" };
    const uri = formatManifoldUri(topic);
    expect(uri).toBe("manifold://container/a%2Fb%3Fc%23d");
    expect(parseManifoldUri(uri)).toEqual(topic);
    expect(ServerMessageSchema.safeParse(eventFrame({ topic })).success).toBe(true);
  });
});

describe("the event plane is published and classified", () => {
  test("the inventories classify all three frames, in both directions", () => {
    for (const type of ["subscribe", "unsubscribe", "event"]) {
      expect(CONNECTION_LEVEL_MESSAGE_TYPES as readonly string[]).toContain(type);
    }
    for (const type of Object.keys(CLIENT_CONNECTION_BODIES)) {
      expect(CLIENT_MESSAGE_TYPES as readonly string[]).toContain(type);
      expect(CONNECTION_LEVEL_MESSAGE_TYPES as readonly string[]).toContain(type);
    }
    expect(SERVER_MESSAGE_TYPES as readonly string[]).toContain("event");
  });

  test("GET /api/protocol publishes the vocabulary a stranger's agent needs", () => {
    const contract = buildProtocolJsonSchema()["eventContract"] as Record<string, unknown>;
    expect(contract["kindPattern"]).toBe(EVENT_KIND_PATTERN.source);
    expect(contract["maxKindLength"]).toBe(MAX_EVENT_KIND_LENGTH);
    expect(contract["maxTopicsPerFrame"]).toBe(MAX_SUBSCRIBE_TOPICS);
    // The topic is published as the ADDRESS grammar itself, so nobody reading this document
    // invents a string convention for it.
    expect(contract["topic"]).toMatchObject({ oneOf: expect.any(Array) });
    expect(contract["payload"]).toBeDefined();
  });
});
