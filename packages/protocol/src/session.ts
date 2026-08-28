import { z } from "zod";
import { MAX_GESTURE_POINT_VALUES } from "./elements.ts";
import { CapSchema } from "./capabilities.ts";
import { PresencePayloadSchema, PresenceStateSchema } from "./presence.ts";
import { PrincipalSchema } from "./principal.ts";

/**
 * Session channel (`/ws/session`): browsers, SDKs, tools. JSON text frames.
 * Handshake: the first client frame MUST be `join`; the server answers `init` or closes
 * (4401 bad token · 4403 forbidden/revoked · 4404 unknown pad · 4409 protocol mismatch).
 */

const base64 = z.base64().max(700_000); // ~512KiB decoded per terminal frame

export const SessionInfoSchema = z.strictObject({
  id: z.string().min(1),
  padId: z.string().min(1),
  elementId: z.string().min(1),
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
  kind: z.enum(["move", "resize", "draw"]),
  phase: z.enum(["active", "end"]),
  elementId: z.string().min(1).max(128),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive().optional(),
  height: z.number().finite().positive().optional(),
  points: z.array(z.number().finite()).max(MAX_GESTURE_POINT_VALUES).optional(),
};
export const GestureSchema = z.strictObject(GestureFields);
export type Gesture = z.infer<typeof GestureSchema>;

// ---------------------------------------------------------------------------- client → server

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("join"),
    padId: z.string().min(1),
    token: z.string().min(1),
    protocolVersion: z.number().int().positive(),
    /** Resume hints; a mismatch simply yields a full init. */
    lastEpoch: z.string().optional(),
    lastRev: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({ type: z.literal("doc_update"), update: z.base64().max(700_000) }),
  z.strictObject({ type: z.literal("gesture"), ...GestureFields }),
  z.strictObject({ type: z.literal("presence"), payload: PresencePayloadSchema }),
  z.strictObject({
    type: z.literal("cursor"),
    x: z.number().finite(),
    y: z.number().finite(),
    tool: z.enum(["pointer", "laser"]).optional(),
  }),
  z.strictObject({ type: z.literal("resync_request") }),
  z.strictObject({
    type: z.literal("terminal_open"),
    elementId: z.string().min(1),
    ...terminalGeometry,
    cwd: z.string().optional(),
    machineId: z.string().optional(),
  }),
  z.strictObject({ type: z.literal("terminal_attach"), sessionId: z.string().min(1) }),
  z.strictObject({ type: z.literal("terminal_detach"), sessionId: z.string().min(1) }),
  z.strictObject({
    type: z.literal("terminal_input"),
    sessionId: z.string().min(1),
    data: base64,
  }),
  z.strictObject({
    type: z.literal("terminal_resize"),
    sessionId: z.string().min(1),
    ...terminalGeometry,
  }),
  z.strictObject({ type: z.literal("terminal_take"), sessionId: z.string().min(1) }),
  z.strictObject({ type: z.literal("terminal_kill"), sessionId: z.string().min(1) }),
  z.strictObject({ type: z.literal("ping") }),
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
  /** Server-assigned identity for this socket; changes on every connection. */
  selfConnId: z.string().min(1),
  roster: z.array(PresenceStateSchema),
  sessions: z.array(SessionInfoSchema),
};

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("init"), ...stateFields }),
  z.strictObject({ type: z.literal("resync"), ...stateFields }),
  z.strictObject({
    type: z.literal("doc_update"),
    update: z.base64().max(700_000),
    by: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("gesture"),
    principalId: z.string().min(1),
    connId: z.string().min(1),
    ...GestureFields,
  }),
  z.strictObject({
    type: z.literal("roster"),
    joined: PresenceStateSchema.optional(),
    left: z.strictObject({ principalId: z.string().min(1) }).optional(),
  }),
  z.strictObject({
    type: z.literal("presence"),
    principalId: z.string().min(1),
    connId: z.string().min(1),
    payload: PresencePayloadSchema,
  }),
  z.strictObject({
    type: z.literal("cursor"),
    principalId: z.string().min(1),
    connId: z.string().min(1),
    x: z.number().finite(),
    y: z.number().finite(),
    tool: z.enum(["pointer", "laser"]).optional(),
  }),
  z.strictObject({
    type: z.literal("terminal_opened"),
    elementId: z.string().min(1),
    session: SessionInfoSchema,
  }),
  z.strictObject({
    type: z.literal("terminal_snapshot"),
    sessionId: z.string().min(1),
    /** Byte-sequence watermark: outputs with seq > this follow with no gap. */
    seq: z.number().int().nonnegative(),
    data: base64,
  }),
  z.strictObject({
    type: z.literal("terminal_output"),
    sessionId: z.string().min(1),
    seq: z.number().int().positive(),
    data: base64,
  }),
  z.strictObject({
    type: z.literal("session_event"),
    sessionId: z.string().min(1),
    kind: z.enum(["opened", "exited", "controller_changed", "resized"]),
    exitCode: z.number().int().nullable().optional(),
    controllerId: z.string().nullable().optional(),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional(),
  }),
  z.strictObject({
    type: z.literal("saved"),
    rev: z.number().int().nonnegative(),
    at: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("error"),
    code: ErrorCodeSchema,
    message: z.string().optional(),
    /** Correlates to updateId / sessionId when applicable. */
    ref: z.string().optional(),
  }),
  z.strictObject({ type: z.literal("pong") }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerGesture = Extract<ServerMessage, { type: "gesture" }>;

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
  "pong",
] as const satisfies readonly ServerMessage["type"][];

export const CLIENT_MESSAGE_TYPES = [
  "join",
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

type MissingServerType = Exclude<ServerMessage["type"], (typeof SERVER_MESSAGE_TYPES)[number]>;
type MissingClientType = Exclude<ClientMessage["type"], (typeof CLIENT_MESSAGE_TYPES)[number]>;
const serverInventoryComplete: MissingServerType extends never ? true : never = true;
const clientInventoryComplete: MissingClientType extends never ? true : never = true;
void serverInventoryComplete;
void clientInventoryComplete;
