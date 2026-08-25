/** Bumped only on breaking wire changes; server rejects mismatched joins (close 4409). */
export const PROTOCOL_VERSION = 3;

/**
 * Machine-channel acceptance set. Agents are long-lived (they hold PTYs and
 * survive server deploys), so the machine channel accepts every protocol
 * version whose agent-facing wire (AgentMessage/ServerToAgentMessage) and
 * adoption semantics are identical to the current one. Session (browser)
 * joins stay strictly current — the server always serves the matching SPA.
 *
 * Discipline (AGENTS.md invariant 10): a bump that does NOT touch the agent
 * wire ADDS the new version here; a bump that DOES touch it RESETS the set to
 * only the new version and requires a coordinated fleet restart.
 *
 * v2 -> v3: session-channel only (init/resync gained selfCaps); agent wire
 * verified identical, so v2 agents stay accepted.
 */
export const MACHINE_PROTOCOL_COMPAT_VERSIONS: ReadonlySet<number> = new Set([2, 3]);

/**
 * Machine-channel liveness cadence (CONTRACTS.md): the server pings on this
 * interval and closes (4008) when a ping is still unanswered as the next one
 * fires, bounding server-side offline detection at two intervals. The agent
 * closes and re-dials when it hears NOTHING for AGENT_LIVENESS_TIMEOUT_MS —
 * a healthy but idle connection still carries pings, so silence longer than
 * two intervals plus grace means the transport is a phantom (dead TCP with no
 * RST, e.g. a proxy swallowed the close). Both halves share these constants
 * so the deadline math stays coherent.
 */
export const MACHINE_PING_INTERVAL_MS = 30_000;
export const AGENT_LIVENESS_TIMEOUT_MS = MACHINE_PING_INTERVAL_MS * 2 + 15_000;
