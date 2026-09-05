import { z } from "zod";
import { MAX_SESSION_BASE64_CHARS } from "./elements.ts";

/**
 * Machine channel (`/ws/machine`): the manifold-agent daemon dials OUT to the server and
 * multiplexes all its terminals over one socket. JSON frames; `data` fields base64.
 *
 * Sequencing contract: the agent assigns each terminal a strictly monotonic byte-sequence
 * counter AT EMISSION, and produces `snapshot` frames from the same ordered pipeline —
 * an output emitted before a snapshot always has seq ≤ the snapshot's seq. This is what
 * makes the server's gap-free attach handoff possible.
 */

const base64 = z.base64().max(MAX_SESSION_BASE64_CHARS);
const terminalId = z.string().min(1);
const geometry = {
  cols: z.number().int().positive().max(1000),
  rows: z.number().int().positive().max(1000),
};

/** Bounds for a caller-supplied PTY argv: enough for any launch line, never a payload channel. */
export const MAX_TERMINAL_ARGV_ITEMS = 64;
export const MAX_TERMINAL_ARG_CHARS = 4096;

/**
 * The PROGRAM a PTY execs in place of the machine's shell: `argv[0]` with `argv.slice(1)`,
 * under the same PTY, the same lifecycle (snapshot, resize, exit) and the same injected
 * environment. A non-empty `argv[0]` is a property of the TYPE, not a runtime check. The one
 * schema for both wires — `terminal_open.program` on the session channel is carried to
 * `create.program` here byte for byte, so a plugin and the agent are measured against the same
 * shape (issue #192). Absent ≡ the agent resolves its shell, exactly the pre-v22 semantics.
 */
export const TerminalProgramSchema = z.strictObject({
  argv: z
    .tuple([z.string().min(1).max(MAX_TERMINAL_ARG_CHARS)], z.string().max(MAX_TERMINAL_ARG_CHARS))
    .refine((argv) => argv.length <= MAX_TERMINAL_ARGV_ITEMS, {
      message: `at most ${MAX_TERMINAL_ARGV_ITEMS} argv items`,
    }),
});
export type TerminalProgram = z.infer<typeof TerminalProgramSchema>;

export const AdvertisedTerminalSchema = z.strictObject({
  terminalId,
  ...geometry,
  alive: z.boolean(),
  /** Highest output seq emitted so far (survives server restarts with the agent). */
  seq: z.number().int().nonnegative(),
  /**
   * Exit code of a PTY that exited while the machine channel was down (only meaningful
   * with `alive: false`). Optional and additive: pre-v4 agents never send it, and the
   * server treats absence as `null` (unknown/signal) — the pre-v4 semantics exactly.
   */
  exitCode: z.number().int().nullable().optional(),
});
export type AdvertisedTerminal = z.infer<typeof AdvertisedTerminalSchema>;

export const AgentMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("hello"),
    token: z.string().min(1),
    name: z.string().min(1).max(64),
    agentVersion: z.string(),
    protocolVersion: z.number().int().positive(),
    /** PTYs that survived a server restart; the new server re-adopts them. */
    terminals: z.array(AdvertisedTerminalSchema),
    /**
     * OPTIONAL and v24+: the identity of the PROCESS that owns this agent's PTYs (issue
     * #278). A terminal host mints one per process and keeps it for its whole life, so two
     * hellos naming the same id are two transports in front of ONE set of live PTYs, and a
     * hello naming a different id is a different owner — whatever token it holds. The server
     * admits a same-token newcomer on this identity (or on an intact inventory) and never on
     * token possession alone, and it sends `drain` only to an agent that named one. Absent
     * reproduces the pre-v24 semantics exactly: the agent is its own owner and its PTYs die
     * with it.
     */
    terminalHostId: z.string().min(1).optional(),
  }),
  z.strictObject({ type: z.literal("created"), terminalId }),
  z.strictObject({ type: z.literal("create_error"), terminalId, message: z.string() }),
  z.strictObject({
    type: z.literal("output"),
    terminalId,
    seq: z.number().int().positive(),
    data: base64,
  }),
  z.strictObject({
    type: z.literal("snapshot"),
    terminalId,
    seq: z.number().int().nonnegative(),
    data: base64,
  }),
  z.strictObject({
    type: z.literal("exited"),
    terminalId,
    exitCode: z.number().int().nullable(),
  }),
  z.strictObject({ type: z.literal("pong") }),
  /**
   * The owner's acknowledgement of ONE `drain` request, echoing its `requestId`. It is the
   * only frame that says what the owner holds RIGHT NOW: `terminalIds` is every live PTY
   * after the owner has applied the admission state it was told, ordered behind every
   * `create` the server sent before the request — so an id missing here was never created,
   * and an id present here is the operator's to account for before replacing the owner.
   */
  z.strictObject({
    type: z.literal("drain_status"),
    requestId: z.string().min(1),
    terminalHostId: z.string().min(1),
    draining: z.boolean(),
    terminalIds: z.array(terminalId),
  }),
]);
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const ServerToAgentMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("welcome"),
    machineId: z.string().min(1),
    /** Server boot identity; fences stale sockets after reconnects. */
    serverEpoch: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("create"),
    terminalId,
    ...geometry,
    cwd: z.string().optional(),
    /**
     * Injected into the PTY: the opener's own `env` (if any) UNDER the four fixed keys
     * MANIFOLD_URL / MANIFOLD_CONTAINER / MANIFOLD_ELEMENT / MANIFOLD_TOKEN, which the server
     * writes last so they always win.
     */
    env: z.record(z.string(), z.string()),
    /**
     * OPTIONAL and v22+: the program the PTY execs instead of the shell. The server never sends
     * it to an agent whose hello named a protocol older than the field, because a pre-v22
     * agent parses `create` strictly and would treat the key as a malformed frame — so an old
     * agent's wire is byte-identical and the version was ADDED to the compat set.
     */
    program: TerminalProgramSchema.optional(),
  }),
  z.strictObject({ type: z.literal("input"), terminalId, data: base64 }),
  z.strictObject({ type: z.literal("resize"), terminalId, ...geometry }),
  z.strictObject({ type: z.literal("kill"), terminalId }),
  z.strictObject({ type: z.literal("snapshot_request"), terminalId }),
  z.strictObject({ type: z.literal("ping") }),
  /**
   * v24+, and sent ONLY to an agent whose hello named a `terminalHostId`: a pre-v24 agent
   * parses server frames strictly and would drop the socket on an unknown type, so a legacy
   * agent's wire stays byte-identical and the version is ADDED to the compat set. Sets the
   * owner's admission latch — `draining: true` refuses every later `create` until a
   * `draining: false` arrives — and is answered by exactly one `drain_status` per request.
   * The server also sends one on every capable hello, carrying its persisted state, so the
   * owner's latch converges to the hub's across transport and hub restarts.
   */
  z.strictObject({
    type: z.literal("drain"),
    requestId: z.string().min(1),
    draining: z.boolean(),
  }),
]);
export type ServerToAgentMessage = z.infer<typeof ServerToAgentMessageSchema>;

// ---------------------------------------------------------------------------- type inventories

/**
 * Literal inventories mirroring session.ts: frame classifiers use these so unknown types
 * are forward-compat ignored while malformed KNOWN types are protocol errors. Compile-time
 * exhaustive in both directions (satisfies blocks extras, Exclude blocks omissions).
 */
export const AGENT_MESSAGE_TYPES = [
  "hello",
  "created",
  "create_error",
  "output",
  "snapshot",
  "exited",
  "pong",
  "drain_status",
] as const satisfies readonly AgentMessage["type"][];

export const SERVER_TO_AGENT_MESSAGE_TYPES = [
  "welcome",
  "create",
  "input",
  "resize",
  "kill",
  "snapshot_request",
  "ping",
  "drain",
] as const satisfies readonly ServerToAgentMessage["type"][];

type MissingAgentType = Exclude<AgentMessage["type"], (typeof AGENT_MESSAGE_TYPES)[number]>;
type MissingServerToAgentType = Exclude<
  ServerToAgentMessage["type"],
  (typeof SERVER_TO_AGENT_MESSAGE_TYPES)[number]
>;
const agentInventoryComplete: MissingAgentType extends never ? true : never = true;
const serverToAgentInventoryComplete: MissingServerToAgentType extends never ? true : never = true;
void agentInventoryComplete;
void serverToAgentInventoryComplete;
