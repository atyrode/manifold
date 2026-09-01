/**
 * The operational log vocabulary: every `evt` name manifold's JSONL stream may carry.
 *
 * This lives in the protocol package rather than beside either logger because the vocabulary
 * has two producers in two packages — `packages/server/src/log.ts` and
 * `packages/agent/src/agent.ts` — and `@manifold/protocol` is the only thing both import
 * (the agent's whole dependency list is protocol plus xterm). `runtime.ts` is the same shape
 * for the same reason: a contract the server and the agent must agree on, owned by neither.
 *
 * ONE list, not one per half. The name is what a reader greps for, and an operator reading a
 * server log and an agent log is reading one vocabulary; two lists would be two doors onto the
 * concept "an evt name" and would let the same word mean two things in two halves with nothing
 * to notice it (invariant 14). The cost is admitted: a server file can spell an agent-only
 * name and typecheck. That is a question about which half OWNS a name, and the answer to it is
 * the grouping below plus review — not a second type.
 *
 * The union is closed on purpose. `Logger.info/warn/error` and `AgentLogRecord.evt` take
 * `LogEvent`, so a typo at a producer is a compile error. What the compiler cannot see is the
 * CONSUMER half: `packages/testkit/e2e/*.test.ts` matches these names inside raw stdout strings
 * (`line.includes('"evt":"exited"')`) and no type reaches inside a string literal. S14 in
 * `scripts/verify-axioms.ts` closes that gap in both directions — every producer literal and
 * every stdout-grep literal must be a member here, and every member must have a live producer,
 * so a name nobody emits is a stale row and fails like any other stale registry row.
 *
 * Adding a name is a one-line append. Renaming one is a rename here plus the sweep S14 forces,
 * in the same commit — the same asymmetry §Lexicon and §Change control apply to words.
 */
export const LOG_EVENTS = [
  // Server: engine doors and process lifecycle.
  "action",
  "http_request_failed",
  "shutdown_failed",

  // Server: the plugin host's own bookkeeping (ADR 0013 §2, §6, §11).
  "plugin_lifecycle",
  "plugin_migration",
  "plugin_purge",

  // Server: supervision of the co-located agent daemon.
  "local_agent_reused",
  "local_agent_spawn_locked",
  "local_agent_spawned",

  // Server: machine transport — enrolment, version negotiation, supersession, liveness.
  "machine_hello_timeout",
  "machine_liveness_timeout",
  "machine_malformed_frame",
  "machine_rejected",
  "machine_superseded",
  "machine_supersession_damped",
  "machine_unknown_frame",
  "machine_version_rejected",

  // Server: instance transport (ADR 0014) — the host half of a dial, and the guest half.
  // Named `instance_*` for the inbound gateway and `dial_*` for the outbound service,
  // because an operator debugging a partnership is always asking about one END of it, and
  // one prefix for both would make "who refused whom" a matter of reading the fields.
  "dial_opened",
  "dial_status",
  "dial_unanswered",
  "instance_dialed",
  "instance_hello_timeout",
  "instance_liveness_timeout",
  "instance_malformed_frame",
  "instance_rejected",
  "instance_superseded",
  "instance_ticket_issued",
  "instance_ticket_refused",
  "instance_unknown_frame",
  "instance_version_rejected",

  // Server: session transport — channel multiplexing and connection-level frames.
  "session_channel_limit",
  "session_malformed_frame",
  "session_subscribe_forbidden",
  "session_subscription_limit",
  "session_unknown_channel",
  "session_unknown_frame",

  // Server: the event plane (ADR 0012). An emission whose kind its emitter never declared is
  // refused rather than fanned out, and the refusal is LOUD: a silent drop would make the
  // declared vocabulary unfalsifiable at runtime, which is the whole reason it is declared.
  "event_undeclared",

  // Server: the document plane — load, repair, size limits, snapshot flushes.
  "scene_doc_load_skipped",
  "scene_doc_over_limit",
  "scene_doc_save_failed",
  "scene_element_repaired",
  "scene_state_exceeds_transport",
  "snapshot_final_flush_failed",
  "snapshot_shutdown_flush_failed",

  // Server: the PTY broker's attach state machine.
  "terminal_create_failed",
  "terminal_create_timeout",
  "terminal_home_failed",
  "terminal_snapshot_timeout",

  // Agent: process lifecycle. `shutdown_failed` is shared with the server half above — one
  // concept ("the shutdown promise rejected"), so one name; the stream it arrives on says which
  // process it describes.
  "starting",
  "signal",
  "shutdown",
  "forced_shutdown",

  // Agent: dialling the server, and the socket's health.
  "dialing",
  "hello",
  "welcome",
  "disconnected",
  "reconnect_scheduled",
  "liveness_timeout",
  "socket_backpressure",
  "protocol_version_rejected",

  // Agent: inbound frame classification.
  "malformed_frame",
  "ignored_unknown_frame",

  // Agent: PTY ownership. `created`, `create_error` and `exited` are spelled to match the
  // machine-frame `type` they accompany, so a log line and the wire frame it reports read the
  // same — which is why `create_error` keeps the `_error` suffix the rest of the tree spells
  // `_failed`.
  "created",
  "create_error",
  "exited",
  "snapshot",
  "snapshot_abandoned",
] as const;

/** One name from the operational log vocabulary; the `evt` field of every JSONL record. */
export type LogEvent = (typeof LOG_EVENTS)[number];
