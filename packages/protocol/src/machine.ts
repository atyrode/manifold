import { z } from "zod";

/**
 * Machine channel (`/ws/machine`): the manifold-agent daemon dials OUT to the server and
 * multiplexes all its terminals over one socket. JSON frames; `data` fields base64.
 *
 * Sequencing contract: the agent assigns each terminal a strictly monotonic byte-sequence
 * counter AT EMISSION, and produces `snapshot` frames from the same ordered pipeline —
 * an output emitted before a snapshot always has seq ≤ the snapshot's seq. This is what
 * makes the server's gap-free attach handoff possible.
 */

const base64 = z.base64().max(700_000);
const terminalId = z.string().min(1);
const geometry = {
  cols: z.number().int().positive().max(1000),
  rows: z.number().int().positive().max(1000),
};

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
     * Injected into the PTY: MANIFOLD_URL / MANIFOLD_CONTAINER / MANIFOLD_ELEMENT /
     * MANIFOLD_TOKEN.
     */
    env: z.record(z.string(), z.string()),
  }),
  z.strictObject({ type: z.literal("input"), terminalId, data: base64 }),
  z.strictObject({ type: z.literal("resize"), terminalId, ...geometry }),
  z.strictObject({ type: z.literal("kill"), terminalId }),
  z.strictObject({ type: z.literal("snapshot_request"), terminalId }),
  z.strictObject({ type: z.literal("ping") }),
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
] as const satisfies readonly AgentMessage["type"][];

export const SERVER_TO_AGENT_MESSAGE_TYPES = [
  "welcome",
  "create",
  "input",
  "resize",
  "kill",
  "snapshot_request",
  "ping",
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
