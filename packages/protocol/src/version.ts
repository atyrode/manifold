/** Bumped only on breaking wire changes; server rejects mismatched joins (close 4409). */
export const PROTOCOL_VERSION = 15;

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
 * v5 -> v6: session-channel scene frames became Yjs document updates. The
 * machine wire is byte-identical, so existing agents stay accepted.
 * v6 -> v7: session-channel roster states gained required `connIds` so viewers
 * can retire a closed tab's cursor. The machine wire is byte-identical, so
 * existing agents stay accepted.
 * v7 -> v8: session-channel cursor frames dropped the never-rendered `tool`
 * field. The machine wire is byte-identical, so existing agents stay accepted.
 * v8 -> v9: session-channel SessionInfo.padId became nullable and session_event
 * gained "parked". The machine wire is byte-identical, so existing agents stay
 * accepted.
 * v9 -> v10: session-channel SessionInfo gained a nullable name and session_event
 * gained "renamed". The machine wire is byte-identical, so existing agents stay
 * accepted.
 * v10 -> v11: pads gained layout/transient and tiled containers store a layout
 * tree; scene elements gained portal; the session `join` frame gained an OPTIONAL
 * `spectator` flag so a portal widget's preview socket can watch a room without
 * occupying it (absent ≡ occupant, the pre-flag semantics); `terminal_open` gained
 * an OPTIONAL `placement: "tile"` (absent ≡ the opener authors a canvas element)
 * and `terminal_opened` an OPTIONAL `ref` echoing it, so a view can birth a
 * terminal the server places as a tile; SessionInfo and PadSessionSummary DROPPED
 * `elementId`, because a session holds many placements at once (canvas mirrors,
 * tile leaves) and consumers read placement from the doc's elements and layout
 * tree instead. The machine wire is byte-identical, so existing agents stay
 * accepted.
 * v11 -> v12: session-channel frames became MULTIPLEXED — every channel-level frame
 * carries a `ch` routing id, `join`/`leave` are per-channel ops on one socket, and
 * per-channel epoch/resume hints ride each channel's own join, so one tab holds exactly
 * one TCP connection no matter how many rooms it renders. ping/pong stay
 * connection-level. The machine wire is byte-identical, so existing agents stay
 * accepted.
 * v12 -> v13: session-channel only. Tile placement destinations gained an OPTIONAL
 * `between` flag (absent ≡ split-the-target, the pre-bump semantics) so a seam-band
 * drop can mean "wedge between both neighbors" on the wire; gesture `carry` payloads
 * gained an OPTIONAL `aim` so collaborators can re-derive a producer's live split
 * preview. The machine wire is byte-identical, so existing agents stay accepted.
 * v13 -> v14: session/HTTP only — connection-level plugins frame, presence
 * view/spotlight, panel tile surface, plugins:manage cap, action/resolve doors,
 * and gesture `carry` payloads gained a REQUIRED `item`: a carry now names the
 * item its surface addresses, so a collaborator paints legality from the frame
 * instead of re-resolving an address against its own index poll.
 * Machine wire byte-identical, so existing agents stay accepted.
 * v14 -> v15: session/HTTP only — the plugin behavioral contract. Manifests gained
 * OPTIONAL `dependencies`/`after` (absent ≡ no relationships and no ordering constraint,
 * the v14 semantics), `dataVersion` (absent ≡ unversioned: nothing migrates, nothing
 * refuses), `dormant` (absent ≡ the engine's named ghost, which is what v14 already drew),
 * `purges` (an audit-visible declaration bound to no verb) and per-element `placement`
 * traits (absent ≡ canvas-item/inline, exactly today's contributed element); roster rows
 * gained `lifecycle`, `refusal` and `changedBy`/`changedAt` (all absent ≡ a plugin nobody
 * has toggled and nothing refuses) and their `source` widened from the literal "builtin"
 * to "builtin" | "plugin", which every v14 value still satisfies. Published actions gained
 * `scope` ∈ {workspace, pad}, DEFAULTED to `workspace`, which is the v14 rule verbatim: a
 * pad-scoped token is refused every action that does not declare itself confined to one
 * container. All of it rides `GET /api/plugins`, `GET /api/protocol` and the
 * connection-level `plugins` frame. The machine wire is byte-identical — an agent never
 * sees a manifest — so existing agents stay accepted.
 */
export const MACHINE_PROTOCOL_COMPAT_VERSIONS: ReadonlySet<number> = new Set([
  2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
]);

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
