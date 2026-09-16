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
 * to notice it (docs/CONTRACTS.md §One authoritative implementation). The cost is admitted: a server file can spell an agent-only
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
  "plugin_database_recovery",
  "plugin_purge",

  // Server: the install doors (ADR 0016 §8 stage 2) — a bundle admitted, or removed. A stored
  // bundle refused at boot is a `plugin_lifecycle` line: it is why the row cannot serve.
  "plugin_installed",
  "plugin_uninstalled",

  // Server: the unpacked directory (ADR 0025 §4, #257) — files written through the authoring
  // door, a rebuild that could not become a row (a build error, an assembly refusal), and the
  // workspace's developer-mode switch moving. Never a file's contents (docs/CONTRACTS.md §Data and credential boundaries).
  "plugin_authored",
  "plugin_authored_build_failed",
  "developer_mode_changed",

  // Server: the isolation runner (ADR 0016 §6) — one child process per installed plugin.
  "isolate_spawned",
  "isolate_exited",
  "isolate_crashed",
  "isolate_evicted",
  "isolate_call_failed",
  "isolate_protocol_backpressure",
  "isolate_output",
  // Server: supervision of the co-located agent daemon.
  "local_agent_reused",
  "local_agent_spawn_locked",
  "local_agent_spawned",
  "local_agent_prepared",

  // Server: machine transport — enrolment, version negotiation, supersession, liveness,
  // (#278) admission: a claimant refused for unproven continuity, (#405) an already-claimed
  // reported name, and the drain round trip, plus (#529) the repository round trip: an answer
  // nobody waited for, and one that never came.
  "machine_admission_refused",
  "machine_drain_status",
  "machine_drain_timeout",
  "machine_forgotten",
  "machine_hello_timeout",
  "machine_job_refusal",
  "machine_liveness_timeout",
  "machine_malformed_frame",
  "machine_name_conflict",
  "machine_rejected",
  "machine_repository_timeout",
  "machine_repository_unmatched",
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
  "instance_outbound_overflow",
  "instance_rejected",
  "instance_superseded",
  "instance_ticket_issued",
  "instance_ticket_refused",
  "instance_unknown_frame",
  "instance_version_rejected",

  // Server: session transport — channel multiplexing and connection-level frames.
  "session_open",
  "session_closed",
  "session_channel_join",
  "session_channel_init",
  "session_channel_refused",
  "session_channel_closed",
  "session_channel_released",
  "session_channel_limit",
  "session_liveness_timeout",
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

  // Agent: the one question this process answers itself (#529) — what repository a folder is.
  "repository_probe_failed",

  // Agent: PTY ownership. `created`, `create_error` and `exited` are spelled to match the
  // machine-frame `type` they accompany, so a log line and the wire frame it reports read the
  // same — which is why `create_error` keeps the `_error` suffix the rest of the tree spells
  // `_failed`.
  "created",
  "create_error",
  "exited",
  "terminal_empty_unproven",
  "snapshot",
  "snapshot_abandoned",

  // Terminal host (issue #278): the PTY owner's own seam — serving its socket, the single
  // transport seat, the admission latch, and the maintenance stop it refuses by name.
  "terminal_host_listening",
  "terminal_host_socket_reclaimed",
  "terminal_host_socket_error",
  "terminal_host_start_failed",
  "terminal_host_backpressure",
  "terminal_host_refused_frame",
  "terminal_host_shutdown_refused",
  "terminal_host_shutdown_accepted",
  "transport_attached",
  "transport_detached",
  "transport_refused",
  "drain",

  // Transport (issue #278): taking and losing the seat on the terminal host.
  "terminal_host_dialing",
  "terminal_host_attached",
  "terminal_host_refused",
  "terminal_host_unreachable",
  "terminal_host_lost",

  // Server: supervision of the co-located terminal host (the local machine's PTY owner).
  "local_terminal_host_reused",
  "local_terminal_host_spawned",

  // Native job owner (issue #703): the two refusals this process decides alone. Every
  // admission branch and every preparation fault previously reached a reader only as one
  // `start_not_admitted` record inside the owner's private journal, on its own host's disk.
  "start_admission_refused",
  "start_preparation_failed",
  // A runtime service the workload asked for and this owner would not start (issue #708).
  "service_start_refused",
  // A full owner journal segment was checkpointed and archived (issue #848), including the
  // one-time conversion of a pre-segmentation journal at startup.
  "journal_segment_sealed",

  // A service CALL this process declined to serve (issue #746). Distinct from the start above:
  // a start is refused before any child job exists, while this is one authorized invocation
  // against a service the hub already reports `ready`. The hub is told through `service_refused`
  // so an operator reads it beside the authorization; this record is the same fact on the host
  // that decided it, and carries the precise branch a sandboxed caller is never told.
  "service_call_refused",
  // An operator anchor this owner declined to hold at startup (issue #839): absent, not a
  // read-only mount, or overlapping protected storage. Only operations that read it refuse.
  "operator_anchor_unavailable",
] as const;

/** One name from the operational log vocabulary; the `evt` field of every JSONL record. */
export type LogEvent = (typeof LOG_EVENTS)[number];

/**
 * THE GENERIC REDACTION RULE, by field name.
 *
 * Server and agent logs, plus the server trace ledger, are durable records and therefore use
 * this single policy. Secret-like names remove bearer material and terminal-content names
 * remove workload bytes. A typed sensitive body must project its explicit safe facts before
 * this generic boundary rather than teaching this matcher an action vocabulary.
 *
 * Matching by name is deliberate. It can drop an innocent field with a sensitive-looking
 * name, but cannot detect secrets embedded in arbitrary free-form strings.
 */
const SECRET_FIELD =
  /(token|key|authorization|bearer|secret|password|passwd|credential|passphrase)/i;
const TERMINAL_FIELD = /^(data|env|payload|terminalData)$/i;

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === "object") return redactObject(value);
  return value;
}

function redactObject(fields: object): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (SECRET_FIELD.test(name) || TERMINAL_FIELD.test(name)) continue;
    safe[name] = redactValue(value);
  }
  return safe;
}

/** Returns a recursively sanitized copy, removing secret and terminal-content fields by name. */
export function redactFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return redactObject(fields);
}
