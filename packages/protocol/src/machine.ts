import { z } from "zod";

/**
 * Machine channel (`/ws/machine`): the manifold-agent daemon dials OUT to the server and
 * multiplexes all its PTY sessions over one socket. JSON frames; `data` fields base64.
 *
 * Sequencing contract: the agent assigns each session a strictly monotonic byte-sequence
 * counter AT EMISSION, and produces `snapshot` frames from the same ordered pipeline —
 * an output emitted before a snapshot always has seq ≤ the snapshot's seq. This is what
 * makes the server's gap-free attach handoff possible.
 */

const base64 = z.base64().max(700_000);
const sessionId = z.string().min(1);
const geometry = {
  cols: z.number().int().positive().max(1000),
  rows: z.number().int().positive().max(1000),
};

export const AdvertisedSessionSchema = z.strictObject({
  sessionId,
  ...geometry,
  alive: z.boolean(),
  /** Highest output seq emitted so far (survives server restarts with the agent). */
  seq: z.number().int().nonnegative(),
});
export type AdvertisedSession = z.infer<typeof AdvertisedSessionSchema>;

export const AgentMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("hello"),
    token: z.string().min(1),
    name: z.string().min(1).max(64),
    agentVersion: z.string(),
    protocolVersion: z.number().int().positive(),
    /** PTYs that survived a server restart; the new server re-adopts them. */
    sessions: z.array(AdvertisedSessionSchema),
  }),
  z.strictObject({ type: z.literal("created"), sessionId }),
  z.strictObject({ type: z.literal("create_error"), sessionId, message: z.string() }),
  z.strictObject({
    type: z.literal("output"),
    sessionId,
    seq: z.number().int().positive(),
    data: base64,
  }),
  z.strictObject({
    type: z.literal("snapshot"),
    sessionId,
    seq: z.number().int().nonnegative(),
    data: base64,
  }),
  z.strictObject({
    type: z.literal("exited"),
    sessionId,
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
    sessionId,
    ...geometry,
    cwd: z.string().optional(),
    /** Injected into the PTY: MANIFOLD_URL / MANIFOLD_PAD / MANIFOLD_ELEMENT / MANIFOLD_TOKEN. */
    env: z.record(z.string(), z.string()),
  }),
  z.strictObject({ type: z.literal("input"), sessionId, data: base64 }),
  z.strictObject({ type: z.literal("resize"), sessionId, ...geometry }),
  z.strictObject({ type: z.literal("kill"), sessionId }),
  z.strictObject({ type: z.literal("snapshot_request"), sessionId }),
  z.strictObject({ type: z.literal("ping") }),
]);
export type ServerToAgentMessage = z.infer<typeof ServerToAgentMessageSchema>;
