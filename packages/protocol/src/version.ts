/** Bumped only on breaking wire changes; server rejects mismatched joins (close 4409). */
export const PROTOCOL_VERSION = 5;

/**
 * Machine-channel acceptance set. Agents are long-lived (they hold PTYs and
 * survive server deploys), so the machine channel accepts every protocol
 * version whose agent-facing wire (AgentMessage/ServerToAgentMessage) and
 * adoption semantics are identical to the current one. Session (browser)
 * joins stay strictly current — the server always serves the matching SPA.
 *
 * Discipline (AGENTS.md invariant 10): a bump that leaves the agent wire
 * identical ADDS the new version here. A bump whose agent-wire change is
 * strictly additive-optional (every pre-bump frame still parses, and the
 * server's default for the absent field reproduces pre-bump semantics) also
 * ADDS — forcing a fleet restart for a change that locks nobody out would be
 * the exact failure the invariant guards against. Any other agent-wire change
 * RESETS the set to only the new version and requires a coordinated fleet
 * restart (server + spokes together).
 *
 * v2 -> v3: session-channel only (init/resync gained selfCaps); agent wire
 * verified identical, so v2 agents stay accepted.
 * v3 -> v4: agent wire gained OPTIONAL `exitCode` on advertised sessions
 * (hello). Absence ≡ the old `null` adoption semantics, so v2/v3 agents stay
 * accepted; they merely keep reporting disconnect-window exits as null.
 * v4 -> v5: session-channel scene records became strict native terminal
 * records. The machine wire is identical, so v2/v3/v4 agents stay accepted.
 */
export const MACHINE_PROTOCOL_COMPAT_VERSIONS: ReadonlySet<number> = new Set([2, 3, 4, 5]);

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
