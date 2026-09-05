import { z } from "zod";
import {
  AdvertisedTerminalSchema,
  AgentMessageSchema,
  ServerToAgentMessageSchema,
  type AgentMessage,
  type ServerToAgentMessage,
} from "./machine.ts";

/**
 * Terminal host IPC (issue #278): the local, non-WebSocket channel between the two halves of
 * a machine — the TERMINAL HOST (`manifold-agent --terminal-host`), which owns every PTY, its
 * ring, its mirror and its output sequence, and the TRANSPORT (`manifold-agent`), which owns
 * the machine token and the hub connection and nothing else. A transport restart, crash or
 * failed replacement touches no PTY because the PTYs are not in that process.
 *
 * The channel is newline-delimited JSON over a private Unix-domain socket named by
 * `MANIFOLD_TERMINAL_HOST_SOCKET`; one frame per line, no line above
 * `MAX_TERMINAL_HOST_FRAME_BYTES`. It is deliberately NOT a second WebSocket client
 * (AGENTS.md invariant 3) and carries no persistence: the host keeps terminal state in memory
 * exactly as the single-process agent did.
 *
 * The terminal frames are the MACHINE frames, reused member for member: a `create` the hub
 * sends is the `create` the host receives, a `snapshot` the host emits is the `snapshot` the hub
 * receives. Only the frames that describe the seam itself — attaching, the read-only status
 * report, and the seam's own errors — are defined here.
 */

/** Environment variable naming the host's Unix socket; both halves require it. */
export const TERMINAL_HOST_SOCKET_ENV = "MANIFOLD_TERMINAL_HOST_SOCKET";

/**
 * The version of THIS seam, independent of `PROTOCOL_VERSION` (the hub wire). A fleet pin
 * reads it from the exact published tag it installs: `0` (absent — the pre-#278 single-process
 * agent) keeps the legacy unit protected as a session owner; `1` and above enables the
 * separately supervised host plus a replaceable transport. Bumped only when a host and a
 * transport of different builds can no longer share a socket.
 */
export const TERMINAL_HOST_PROTOCOL_VERSION = 1;

/**
 * One frame's ceiling on the IPC socket. A machine frame never exceeds the session frame
 * ceiling (1 MiB, the hub's limit), and the machine frames are the largest thing this channel
 * carries, so the same number bounds the IPC parser and a line that grows past it is a
 * protocol error rather than an allocation.
 */
export const MAX_TERMINAL_HOST_FRAME_BYTES = 1_048_576;

/**
 * Maximum bytes either side will hold for a peer that is not reading. Mirrors the agent's
 * hub-socket rule: beyond this the peer is sick, the connection is closed, and the survivor
 * heals by re-attaching — ring + mirror on the host make that lossless (snapshot semantics).
 */
export const MAX_TERMINAL_HOST_QUEUE_BYTES = 8 * 1_048_576;

const TERMINAL_HOST_ID = z.string().min(1);

/** The machine command members the host executes; `welcome` and `ping` are the transport's. */
export const TERMINAL_HOST_MACHINE_COMMAND_TYPES = [
  "create",
  "input",
  "resize",
  "kill",
  "snapshot_request",
  "drain",
] as const satisfies readonly ServerToAgentMessage["type"][];

/** The machine event members the host produces; `hello` and `pong` are the transport's. */
export const TERMINAL_HOST_MACHINE_EVENT_TYPES = [
  "created",
  "create_error",
  "output",
  "snapshot",
  "exited",
  "drain_status",
] as const satisfies readonly AgentMessage["type"][];

type MachineCommandType = (typeof TERMINAL_HOST_MACHINE_COMMAND_TYPES)[number];
type MachineEventType = (typeof TERMINAL_HOST_MACHINE_EVENT_TYPES)[number];

type MemberOf<Options extends readonly unknown[], Type extends string> = Extract<
  Options[number],
  { readonly shape: { readonly type: { readonly value: Type } } }
>;

/** Picks named members out of a machine union so the IPC union reuses them by identity. */
function membersOf<Options extends readonly z.ZodObject[], Type extends string>(
  options: Options,
  types: readonly Type[],
): MemberOf<Options, Type>[] {
  const wanted = new Set<string>(types);
  const picked: MemberOf<Options, Type>[] = [];
  for (const option of options) {
    const literal: unknown = option.shape.type;
    if (!(literal instanceof z.ZodLiteral)) continue;
    const value: unknown = literal.value;
    if (typeof value === "string" && wanted.has(value)) {
      picked.push(option as MemberOf<Options, Type>);
    }
  }
  if (picked.length !== types.length) {
    throw new Error(`terminal host IPC: machine union is missing ${types.join(", ")}`);
  }
  return picked;
}

// ---------------------------------------------------------------------------- transport → host

/**
 * Claims the single transport seat. The host answers `attached` — or `attach_refused` while
 * another transport holds the seat, in which case the connection stays open as an observer:
 * it may still ask for status, it may not mutate, and it must never treat the refusal as a
 * reason to kill anything.
 */
export const TerminalHostAttachSchema = z.strictObject({ type: z.literal("attach") });

/** Asks for the read-only report any connection may have, attached or not. */
export const TerminalHostStatusRequestSchema = z.strictObject({
  type: z.literal("status_request"),
});

/**
 * The one non-destructive way to stop a host: maintenance asks, and the host exits ONLY when
 * admission is latched closed AND it retains no terminal — checked in the same synchronous
 * step that would otherwise admit a `create`, so nothing slips between the check and the
 * exit. Anything else is `shutdown_refused` by name; there is no force flag on this seam.
 */
export const TerminalHostShutdownRequestSchema = z.strictObject({
  type: z.literal("shutdown_request"),
});

export const TerminalHostCommandSchema = z.discriminatedUnion("type", [
  TerminalHostAttachSchema,
  TerminalHostStatusRequestSchema,
  TerminalHostShutdownRequestSchema,
  ...membersOf(ServerToAgentMessageSchema.options, TERMINAL_HOST_MACHINE_COMMAND_TYPES),
]);
export type TerminalHostCommand =
  | z.infer<typeof TerminalHostAttachSchema>
  | z.infer<typeof TerminalHostStatusRequestSchema>
  | z.infer<typeof TerminalHostShutdownRequestSchema>
  | Extract<ServerToAgentMessage, { type: MachineCommandType }>;

// ---------------------------------------------------------------------------- host → transport

/**
 * The host's report: its in-memory identity (stable for the life of the host PROCESS, so a
 * hub can tell "same PTYs, new transport" from "new host, empty inventory"), the code it is
 * RUNNING (`build`, `pid` — a retained host may be older than the binary now installed, and
 * maintenance must see that drift rather than assume it), whether admission is latched
 * closed, whether a transport currently holds the seat, and every terminal the host retains —
 * live ones and exits nobody has acknowledged yet — in `hello` form.
 */
export const TerminalHostStatusSchema = z.strictObject({
  type: z.literal("status"),
  terminalHostId: TERMINAL_HOST_ID,
  terminalHostProtocolVersion: z.number().int().positive(),
  build: z.string(),
  pid: z.number().int().positive(),
  draining: z.boolean(),
  transportAttached: z.boolean(),
  terminals: z.array(AdvertisedTerminalSchema),
});
export type TerminalHostStatus = z.infer<typeof TerminalHostStatusSchema>;

/** The seat is now this connection's; carries the same report so the first hello needs no round trip. */
export const TerminalHostAttachedSchema = z.strictObject({
  type: z.literal("attached"),
  terminalHostId: TERMINAL_HOST_ID,
  draining: z.boolean(),
  terminals: z.array(AdvertisedTerminalSchema),
});

export const TERMINAL_HOST_SHUTDOWN_REFUSALS = ["not_draining", "terminals_retained"] as const;
export const TerminalHostShutdownRefusedSchema = z.strictObject({
  type: z.literal("shutdown_refused"),
  reason: z.enum(TERMINAL_HOST_SHUTDOWN_REFUSALS),
  /** Terminals the host still retains (live or unacknowledged exits) when that is the reason. */
  terminalIds: z.array(z.string().min(1)),
});

/** The host accepted the request; it exits once this frame is written. */
export const TerminalHostShuttingDownSchema = z.strictObject({
  type: z.literal("shutting_down"),
  terminalHostId: TERMINAL_HOST_ID,
});

export const TERMINAL_HOST_ATTACH_REFUSALS = ["transport_attached"] as const;
export const TerminalHostAttachRefusedSchema = z.strictObject({
  type: z.literal("attach_refused"),
  reason: z.enum(TERMINAL_HOST_ATTACH_REFUSALS),
});

/**
 * The seam's own refusals, sent once before the host closes the offending connection. A
 * mutation from a connection that does not hold the seat is `not_attached`; the rest are the
 * framing rules every peer is measured against.
 */
export const TERMINAL_HOST_ERRORS = [
  "not_attached",
  "malformed_frame",
  "frame_too_large",
  "queue_exceeded",
] as const;
export const TerminalHostErrorSchema = z.strictObject({
  type: z.literal("error"),
  code: z.enum(TERMINAL_HOST_ERRORS),
  detail: z.string().optional(),
});
export type TerminalHostErrorCode = (typeof TERMINAL_HOST_ERRORS)[number];

export const TerminalHostEventSchema = z.discriminatedUnion("type", [
  TerminalHostStatusSchema,
  TerminalHostAttachedSchema,
  TerminalHostAttachRefusedSchema,
  TerminalHostShutdownRefusedSchema,
  TerminalHostShuttingDownSchema,
  TerminalHostErrorSchema,
  ...membersOf(AgentMessageSchema.options, TERMINAL_HOST_MACHINE_EVENT_TYPES),
]);
export type TerminalHostEvent =
  | TerminalHostStatus
  | z.infer<typeof TerminalHostAttachedSchema>
  | z.infer<typeof TerminalHostAttachRefusedSchema>
  | z.infer<typeof TerminalHostShutdownRefusedSchema>
  | z.infer<typeof TerminalHostShuttingDownSchema>
  | z.infer<typeof TerminalHostErrorSchema>
  | Extract<AgentMessage, { type: MachineEventType }>;

// ---------------------------------------------------------------------------- type inventories

export const TERMINAL_HOST_COMMAND_TYPES = [
  "attach",
  "status_request",
  "shutdown_request",
  ...TERMINAL_HOST_MACHINE_COMMAND_TYPES,
] as const satisfies readonly TerminalHostCommand["type"][];

export const TERMINAL_HOST_EVENT_TYPES = [
  "status",
  "attached",
  "attach_refused",
  "shutdown_refused",
  "shutting_down",
  "error",
  ...TERMINAL_HOST_MACHINE_EVENT_TYPES,
] as const satisfies readonly TerminalHostEvent["type"][];

type MissingCommandType = Exclude<
  TerminalHostCommand["type"],
  (typeof TERMINAL_HOST_COMMAND_TYPES)[number]
>;
type MissingEventType = Exclude<
  TerminalHostEvent["type"],
  (typeof TERMINAL_HOST_EVENT_TYPES)[number]
>;
const commandInventoryComplete: MissingCommandType extends never ? true : never = true;
const eventInventoryComplete: MissingEventType extends never ? true : never = true;
void commandInventoryComplete;
void eventInventoryComplete;
