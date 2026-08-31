import { z } from "zod";
import { MAX_GESTURE_POINT_VALUES } from "./elements.ts";
import { CapSchema } from "./capabilities.ts";
import {
  CarrySchema,
  GestureKindSchema,
  PresencePayloadSchema,
  PresenceStateSchema,
} from "./presence.ts";
import { PluginRosterSchema } from "./plugin.ts";
import { PrincipalSchema } from "./principal.ts";

/**
 * Session channel (`/ws/session`): browsers, SDKs, tools. JSON text frames.
 *
 * FRAME GRAMMAR (v14) — one socket per tab, many rooms. Every frame is either
 * connection-level or channel-level:
 *
 *   connection-level   client → server  {"type":"ping"}
 *                      server → client  {"type":"pong"}
 *                      server → client  {"type":"plugins","roster":[…]}
 *   channel-level      both ways        {"ch":"<channelId>", "type":"…", …}
 *
 * A CHANNEL is one client-chosen handle onto one room. `ch` is opaque to the server,
 * unique per connection, and deliberately NOT a pad id: two channels on one socket may
 * address the SAME pad with different roles (an occupant view and a widget's watching
 * preview), so a pad-keyed channel would be an id pun that collides. `join` binds a
 * fresh `ch` to a pad, `leave` frees it, and every other channel frame routes by it.
 * Liveness is a property of the socket, not of a room, so ping/pong carry no `ch`; neither
 * does the plugin roster, which describes the whole workspace rather than any one room (see
 * CONNECTION_BODIES).
 *
 * Handshake: the FIRST client frame on a connection MUST be `join` (ten-second
 * deadline, re-armed whenever the last channel leaves); the server answers `init` on
 * that channel. Per-channel epoch/rev resume hints ride each channel's own `join`, so a
 * reconnect redials ONE socket and rejoins every channel on it.
 *
 * REFUSAL SCOPE (CONTRACTS-ready). A refusal closes the whole SOCKET when it invalidates
 * the credential or the framing itself: 4401 bad token · 4403 forbidden/revoked · 4409
 * protocol mismatch · 4002 malformed frame, non-join first frame, duplicate `ch`, or an
 * idle connection holding no channels. It closes ONE CHANNEL — a `channel_closed` frame,
 * socket untouched — when it concerns one room: 4404 unknown or deleted pad · 4429
 * channel cap reached · 1009 that room's state exceeding the transport ceiling · 1013
 * that channel's outbound queue overflowing. Killing a whole tab because one widget
 * pointed at a deleted pad is precisely the blast radius multiplexing exists to remove.
 */

const base64 = z.base64().max(700_000); // ~512KiB decoded per terminal frame

/**
 * Channel ids are tokens, never arbitrary strings: both halves splice one into a frame
 * prefix (`{"ch":"c7",` + body) to tag a shared serialization for many peers, so an id
 * needing JSON escaping would be a correctness hole rather than a slow path.
 */
export const CHANNEL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const ChannelIdSchema = z.string().regex(CHANNEL_ID_PATTERN);

/**
 * Server-side bound on channels per connection. A tab holds one channel per room it
 * renders (canvas + one per portal widget or tile), so the cap is generous for real
 * scenes while keeping a single socket's fan-out finite. Per-channel outbound queues are
 * unchanged by multiplexing, so this cap reproduces exactly the worst-case app-side
 * buffering that the same rooms held on separate sockets before v12.
 */
export const MAX_SESSION_CHANNELS_PER_CONNECTION = 64;

/** Channel-scoped close code for a connection that asked for one channel too many. */
export const CHANNEL_LIMIT_CLOSE_CODE = 4429;

/**
 * A live PTY session as the wire describes it. Placement is deliberately ABSENT: a
 * session can be referenced from several places at once (portals on many canvases), so any
 * single `elementId` here would be a lie. Consumers read placement from live state — the
 * scene doc's elements and the container's layout tree.
 */
export const SessionInfoSchema = z.strictObject({
  id: z.string().min(1),
  /**
   * The composition this session LIVES IN — never a canvas, and never null. A terminal is
   * `homed: "eager"`: its composition is born with it and outlives every reference to it,
   * so "unbound" is not a state a session can be in. It is also the room this session's
   * frames travel through, which is why a canvas showing the terminal through a portal
   * joins that room rather than streaming the terminal over its own.
   */
  padId: z.string().min(1),
  /** Operator-assigned display name; null means the client renders its default label. */
  name: z.string().min(1).max(120).nullable(),
  machineId: z.string().min(1),
  status: z.enum(["running", "exited"]),
  exitCode: z.number().int().nullable(),
  cols: z.number().int().positive().max(1000),
  rows: z.number().int().positive().max(1000),
  controllerId: z.string().nullable(),
  createdBy: z.string().min(1),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const ErrorCodeSchema = z.enum([
  "unauthorized",
  "forbidden",
  "not_found",
  "invalid",
  "conflict",
  "no_machine",
  "not_controller",
  "epoch_mismatch",
  "rate_limited",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

const terminalGeometry = {
  cols: z.number().int().positive().max(1000),
  rows: z.number().int().positive().max(1000),
};
export const GestureFields = {
  kind: GestureKindSchema,
  phase: z.enum(["active", "end"]),
  elementId: z.string().min(1).max(128),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive().optional(),
  height: z.number().finite().positive().optional(),
  points: z.array(z.number().finite()).max(MAX_GESTURE_POINT_VALUES).optional(),
  /**
   * Set on `carry` frames only: the item in flight, so a viewer can render what is
   * being moved without resolving ids it may have no room for. Geometry above then
   * says WHERE that item's representation currently is.
   */
  carry: CarrySchema.optional(),
};
export const GestureSchema = z.strictObject(GestureFields);
export type Gesture = z.infer<typeof GestureSchema>;

/**
 * Adds the routing field to one frame body. Each variant is channelized by an explicit
 * call so the discriminated unions below stay fully inferred — a body union and a wire
 * union built from the SAME shapes, never two hand-maintained copies.
 */
function channelized<T extends z.ZodObject>(
  body: T,
): z.ZodObject<T["shape"] & { ch: typeof ChannelIdSchema }> {
  return body.extend({ ch: ChannelIdSchema });
}

// ---------------------------------------------------------------------------- client → server

const CLIENT_BODIES = {
  join: z.strictObject({
    type: z.literal("join"),
    padId: z.string().min(1),
    token: z.string().min(1),
    protocolVersion: z.number().int().positive(),
    /**
     * A spectator watches without occupying: a portal widget's live preview joins a real
     * room channel, and counting it as an occupant would both fake an avatar and pin a
     * bubble open forever. Spectators receive state and terminal output but may never
     * write, and they appear in neither the roster nor `/api/pad-presence`. Absent ≡
     * occupant. A role change is a `leave`+`join` on the same socket, never TCP churn.
     */
    spectator: z.boolean().optional(),
    /** Resume hints for THIS channel; a mismatch simply yields a full init. */
    lastEpoch: z.string().optional(),
    lastRev: z.number().int().nonnegative().optional(),
  }),
  /**
   * Frees one channel: the room loses this peer (roster, presence, terminal viewers)
   * while every other channel on the socket keeps streaming. A client that is closing
   * its LAST channel closes the socket instead — the close already means "leave
   * everything", so a redundant frame would be pure ceremony.
   */
  leave: z.strictObject({ type: z.literal("leave") }),
  doc_update: z.strictObject({
    type: z.literal("doc_update"),
    update: z.base64().max(700_000),
  }),
  gesture: z.strictObject({ type: z.literal("gesture"), ...GestureFields }),
  presence: z.strictObject({ type: z.literal("presence"), payload: PresencePayloadSchema }),
  cursor: z.strictObject({
    type: z.literal("cursor"),
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  resync_request: z.strictObject({ type: z.literal("resync_request") }),
  terminal_open: z.strictObject({
    type: z.literal("terminal_open"),
    /**
     * Correlation token, and under the default element placement also the id of the
     * canvas element the opener authors once the PTY lands. A tiled opener authors
     * nothing, so there this is a pure ref, echoed back as `terminal_opened.ref`.
     */
    elementId: z.string().min(1),
    ...terminalGeometry,
    cwd: z.string().optional(),
    machineId: z.string().optional(),
    /**
     * `"tile"` hands placement to the container: a view has no canvas to author into,
     * so the server writes the tile leaf itself and answers with that tile id as the
     * placement `elementId`. Absent ≡ the opener places a canvas element, so every
     * pre-flag client keeps its exact semantics.
     */
    placement: z.literal("tile").optional(),
  }),
  terminal_attach: z.strictObject({
    type: z.literal("terminal_attach"),
    sessionId: z.string().min(1),
  }),
  terminal_detach: z.strictObject({
    type: z.literal("terminal_detach"),
    sessionId: z.string().min(1),
  }),
  terminal_input: z.strictObject({
    type: z.literal("terminal_input"),
    sessionId: z.string().min(1),
    data: base64,
  }),
  terminal_resize: z.strictObject({
    type: z.literal("terminal_resize"),
    sessionId: z.string().min(1),
    ...terminalGeometry,
  }),
  terminal_take: z.strictObject({ type: z.literal("terminal_take"), sessionId: z.string().min(1) }),
  terminal_kill: z.strictObject({ type: z.literal("terminal_kill"), sessionId: z.string().min(1) }),
} as const;

/** Connection-level: liveness belongs to the socket, so it carries no channel. */
const ClientPingSchema = z.strictObject({ type: z.literal("ping") });

/**
 * One frame's payload, independent of routing. The server constructs and validates
 * bodies (a broadcast serializes ONE body and tags it per peer), and an SDK channel
 * handle hands bodies to its subscribers — the channel is implicit in the handle.
 */
export const ClientMessageBodySchema = z.discriminatedUnion("type", [
  CLIENT_BODIES.join,
  CLIENT_BODIES.leave,
  CLIENT_BODIES.doc_update,
  CLIENT_BODIES.gesture,
  CLIENT_BODIES.presence,
  CLIENT_BODIES.cursor,
  CLIENT_BODIES.resync_request,
  CLIENT_BODIES.terminal_open,
  CLIENT_BODIES.terminal_attach,
  CLIENT_BODIES.terminal_detach,
  CLIENT_BODIES.terminal_input,
  CLIENT_BODIES.terminal_resize,
  CLIENT_BODIES.terminal_take,
  CLIENT_BODIES.terminal_kill,
  ClientPingSchema,
]);
export type ClientMessageBody = z.infer<typeof ClientMessageBodySchema>;

/** The wire frame: a body plus its routing field, exactly as it appears on the socket. */
export const ClientMessageSchema = z.discriminatedUnion("type", [
  channelized(CLIENT_BODIES.join),
  channelized(CLIENT_BODIES.leave),
  channelized(CLIENT_BODIES.doc_update),
  channelized(CLIENT_BODIES.gesture),
  channelized(CLIENT_BODIES.presence),
  channelized(CLIENT_BODIES.cursor),
  channelized(CLIENT_BODIES.resync_request),
  channelized(CLIENT_BODIES.terminal_open),
  channelized(CLIENT_BODIES.terminal_attach),
  channelized(CLIENT_BODIES.terminal_detach),
  channelized(CLIENT_BODIES.terminal_input),
  channelized(CLIENT_BODIES.terminal_resize),
  channelized(CLIENT_BODIES.terminal_take),
  channelized(CLIENT_BODIES.terminal_kill),
  ClientPingSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---------------------------------------------------------------------------- server → client

/** Full-state payload shared by `init` and `resync`. */
const stateFields = {
  protocolVersion: z.number().int().positive(),
  epoch: z.string().min(1),
  rev: z.number().int().nonnegative(),
  doc: z.base64(),
  self: PrincipalSchema,
  /** The joining principal's granted capabilities; drives client-side affordances. */
  selfCaps: z.array(CapSchema).min(1),
  /**
   * Server-assigned identity for this CHANNEL; changes on every join. Two channels of
   * one tab are two room memberships, exactly as two sockets were before v12, so the
   * roster, cursor echo-suppression, and presence keying are untouched.
   */
  selfConnId: z.string().min(1),
  roster: z.array(PresenceStateSchema),
  sessions: z.array(SessionInfoSchema),
};

const SERVER_BODIES = {
  init: z.strictObject({ type: z.literal("init"), ...stateFields }),
  resync: z.strictObject({ type: z.literal("resync"), ...stateFields }),
  doc_update: z.strictObject({
    type: z.literal("doc_update"),
    update: z.base64().max(700_000),
    by: z.string().min(1),
  }),
  gesture: z.strictObject({
    type: z.literal("gesture"),
    principalId: z.string().min(1),
    connId: z.string().min(1),
    ...GestureFields,
  }),
  roster: z.strictObject({
    type: z.literal("roster"),
    joined: PresenceStateSchema.optional(),
    left: z.strictObject({ principalId: z.string().min(1) }).optional(),
  }),
  presence: z.strictObject({
    type: z.literal("presence"),
    principalId: z.string().min(1),
    connId: z.string().min(1),
    payload: PresencePayloadSchema,
  }),
  cursor: z.strictObject({
    type: z.literal("cursor"),
    principalId: z.string().min(1),
    connId: z.string().min(1),
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  terminal_opened: z.strictObject({
    type: z.literal("terminal_opened"),
    /** The placement: a canvas element id, or the tile id of a server-authored leaf. */
    elementId: z.string().min(1),
    session: SessionInfoSchema,
    /**
     * Echoes `terminal_open.elementId` when the SERVER authored the placement, so the
     * opener can correlate a reply whose `elementId` it never chose. Sent ONLY to an
     * opener that asked for `placement: "tile"`: peers strict-parse this union, so an
     * unsolicited extra key would break their socket.
     */
    ref: z.string().min(1).optional(),
  }),
  terminal_snapshot: z.strictObject({
    type: z.literal("terminal_snapshot"),
    sessionId: z.string().min(1),
    /** Byte-sequence watermark: outputs with seq > this follow with no gap. */
    seq: z.number().int().nonnegative(),
    data: base64,
  }),
  terminal_output: z.strictObject({
    type: z.literal("terminal_output"),
    sessionId: z.string().min(1),
    seq: z.number().int().positive(),
    data: base64,
  }),
  session_event: z.strictObject({
    type: z.literal("session_event"),
    sessionId: z.string().min(1),
    kind: z.enum(["opened", "exited", "controller_changed", "resized", "parked", "renamed"]),
    exitCode: z.number().int().nullable().optional(),
    controllerId: z.string().nullable().optional(),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional(),
    name: z.string().min(1).max(120).optional(),
  }),
  saved: z.strictObject({
    type: z.literal("saved"),
    rev: z.number().int().nonnegative(),
    at: z.number().int().nonnegative(),
  }),
  error: z.strictObject({
    type: z.literal("error"),
    code: ErrorCodeSchema,
    message: z.string().optional(),
    /** Correlates to updateId / sessionId when applicable. */
    ref: z.string().optional(),
  }),
  /**
   * This channel is over, the socket is not. It carries the same close-code vocabulary a
   * socket close would (4404 pad gone, 4429 channel cap, 1009/1013 transport bounds), so
   * a client reports and heals a dead room exactly as it did when a room WAS a socket.
   */
  channel_closed: z.strictObject({
    type: z.literal("channel_closed"),
    code: z.number().int().positive(),
    reason: z.string(),
  }),
} as const;

/** Connection-level: the answer to a socket-level keepalive. */
const ServerPongSchema = z.strictObject({ type: z.literal("pong") });

/**
 * CONNECTION-LEVEL server frames: they address the SOCKET, not a channel, so they carry no
 * `ch` at all. Until v14 the only such frames were the liveness pair, whose bodies are a
 * bare type; this is the first category with a payload, and it exists because plugin
 * REGISTRATION is workspace-global — the roster is not a property of any room, so tagging
 * it with one room's channel would be an id pun and fanning it out per channel would send
 * one fact N times.
 *
 * A roster frame is delivered on socket open (before any `join`) and again on every change,
 * which is what lets a client rebuild its composition live instead of reloading.
 *
 * Kept as a keyed table so routing can look a frame's parser up by type. `pong` stays a
 * bare literal beside it rather than joining the table: it has no body to parse.
 */
export const CONNECTION_BODIES = {
  plugins: z.strictObject({ type: z.literal("plugins"), roster: PluginRosterSchema }),
} as const;

export const ServerMessageBodySchema = z.discriminatedUnion("type", [
  SERVER_BODIES.init,
  SERVER_BODIES.resync,
  SERVER_BODIES.doc_update,
  SERVER_BODIES.gesture,
  SERVER_BODIES.roster,
  SERVER_BODIES.presence,
  SERVER_BODIES.cursor,
  SERVER_BODIES.terminal_opened,
  SERVER_BODIES.terminal_snapshot,
  SERVER_BODIES.terminal_output,
  SERVER_BODIES.session_event,
  SERVER_BODIES.saved,
  SERVER_BODIES.error,
  SERVER_BODIES.channel_closed,
  ServerPongSchema,
  CONNECTION_BODIES.plugins,
]);
export type ServerMessageBody = z.infer<typeof ServerMessageBodySchema>;

export const ServerMessageSchema = z.discriminatedUnion("type", [
  channelized(SERVER_BODIES.init),
  channelized(SERVER_BODIES.resync),
  channelized(SERVER_BODIES.doc_update),
  channelized(SERVER_BODIES.gesture),
  channelized(SERVER_BODIES.roster),
  channelized(SERVER_BODIES.presence),
  channelized(SERVER_BODIES.cursor),
  channelized(SERVER_BODIES.terminal_opened),
  channelized(SERVER_BODIES.terminal_snapshot),
  channelized(SERVER_BODIES.terminal_output),
  channelized(SERVER_BODIES.session_event),
  channelized(SERVER_BODIES.saved),
  channelized(SERVER_BODIES.error),
  channelized(SERVER_BODIES.channel_closed),
  ServerPongSchema,
  // Connection-level: identical in both unions, because a frame with no `ch` IS its body.
  CONNECTION_BODIES.plugins,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/**
 * Gesture frames as CONSUMERS see them: channel-agnostic. A wire frame satisfies this
 * type structurally (its `ch` is one extra key), so remote-gesture projection code is
 * written once against the body and works for any channel.
 */
export type ServerGesture = Extract<ServerMessageBody, { type: "gesture" }>;

// ---------------------------------------------------------------------------- type inventories

/**
 * Public literal inventories for frame classification (unknown-type = forward-compat
 * ignore vs malformed-known-type = protocol error). Kept as plain constants so no
 * consumer ever reaches into zod internals; exhaustiveness is enforced at compile time
 * in both directions.
 */
export const SERVER_MESSAGE_TYPES = [
  "init",
  "resync",
  "doc_update",
  "gesture",
  "roster",
  "presence",
  "cursor",
  "terminal_opened",
  "terminal_snapshot",
  "terminal_output",
  "session_event",
  "saved",
  "error",
  "channel_closed",
  "pong",
  "plugins",
] as const satisfies readonly ServerMessage["type"][];

export const CLIENT_MESSAGE_TYPES = [
  "join",
  "leave",
  "doc_update",
  "gesture",
  "presence",
  "cursor",
  "resync_request",
  "terminal_open",
  "terminal_attach",
  "terminal_detach",
  "terminal_input",
  "terminal_resize",
  "terminal_take",
  "terminal_kill",
  "ping",
] as const satisfies readonly ClientMessage["type"][];

/**
 * Frames that carry no `ch`: the socket's own liveness pair, plus the server frames that
 * describe the CONNECTION's world rather than a room's (the plugin roster). Routing reads
 * this to tell a connection-level frame from a channel-level one without a second
 * discriminator, and a channel handle is never handed one of these.
 */
export const CONNECTION_LEVEL_MESSAGE_TYPES = ["ping", "pong", "plugins"] as const;

type MissingServerType = Exclude<ServerMessage["type"], (typeof SERVER_MESSAGE_TYPES)[number]>;
type MissingClientType = Exclude<ClientMessage["type"], (typeof CLIENT_MESSAGE_TYPES)[number]>;
/** Every payload-carrying connection frame must be classified as one, and be a real frame. */
type UnclassifiedConnectionType = Exclude<
  keyof typeof CONNECTION_BODIES,
  (typeof CONNECTION_LEVEL_MESSAGE_TYPES)[number]
>;
type UnwiredConnectionType = Exclude<keyof typeof CONNECTION_BODIES, ServerMessage["type"]>;
const serverInventoryComplete: MissingServerType extends never ? true : never = true;
const clientInventoryComplete: MissingClientType extends never ? true : never = true;
const connectionInventoryComplete: [UnclassifiedConnectionType, UnwiredConnectionType] extends [
  never,
  never,
]
  ? true
  : never = true;
void serverInventoryComplete;
void clientInventoryComplete;
void connectionInventoryComplete;

/** Body and wire unions must stay the same frame set: only routing separates them. */
type BodyWithoutFrame = Exclude<ServerMessageBody["type"], ServerMessage["type"]>;
type FrameWithoutBody = Exclude<ServerMessage["type"], ServerMessageBody["type"]>;
type ClientBodyWithoutFrame = Exclude<ClientMessageBody["type"], ClientMessage["type"]>;
type ClientFrameWithoutBody = Exclude<ClientMessage["type"], ClientMessageBody["type"]>;
const unionsAligned: [
  BodyWithoutFrame,
  FrameWithoutBody,
  ClientBodyWithoutFrame,
  ClientFrameWithoutBody,
] extends [never, never, never, never]
  ? true
  : never = true;
void unionsAligned;
