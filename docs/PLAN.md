# manifold — plan

manifold is the successor to pad.ws (the proof of concept). It distills that project to its
core — an infinite canvas with terminals in it, multiplayer with strong presence — and
rebuilds it agent-native, from scratch. No code is carried over; only lessons.

## Axioms

| #   | Axiom                                             | Consequence                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | manifold is the space, not the brain              | No agent runtime/orchestration/prompt tooling inside. Agents (pi, Claude Code, Codex, …) run in terminals; manifold gives them eyes (read scene, subscribe events) and hands (mutate scene, drive terminals). Bring your own brain + compute. |
| A2  | Agents are principals; the human is root of trust | One identity model for humans and agents across presence, ownership, terminals. Uniform identity ≠ uniform authority: capability-scoped revocable tokens; freeze is a first-class verb.                                                       |
| A3  | The protocol is the product                       | One typed contract (`@manifold/protocol`). Browser, SDK, CLI, MCP are adapters. If the protocol can't exercise a feature, the feature isn't done.                                                                                             |
| A4  | Presence is the supervision surface               | Roster with agent states, cursors, selections, terminal focus, attribution. Watching includes intervening.                                                                                                                                    |
| A5  | The repo is an agent habitat                      | One-command deterministic gates, zero-service tests, SDK-as-test-harness, machine-legible runtime. North star: manifold is developed inside manifold.                                                                                         |
| A6  | Localhost-first, boring, small                    | One server + one agent daemon. SQLite. Exact-pinned, countable deps. Latest tech is a candidate, not a mandate.                                                                                                                               |

## Architecture

See `docs/CONTRACTS.md` for the authoritative topology, protocol semantics, and
persistence schema. Summary:

- **server**: one Bun process — HTTP + static + `/ws/session` (rooms) + `/ws/machine`
  (agents) + SQLite (WAL). One canonical Yjs scene document per room; invalid element
  projections are repaired server-side and full documents are snapshotted on a debounce.
- **agent**: separate long-lived daemon holding PTYs (`Bun.Terminal`), dialing OUT to the
  server; sessions survive server restarts; headless xterm mirror gives gap-free attach
  snapshots.
- **web**: React 19 + React Flow 12 + xterm 6; terminal, text, and freehand elements render
  as native canvas nodes with live remote gesture previews and roster-backed presence.
- **sync**: Yjs document updates travel over the authenticated session channel; cursors,
  gestures, selections, and viewports stay on the first-party ephemeral presence transport.

## v0 scope (current build)

In: multiple pads with URLs; infinite React Flow canvas with terminal, text, and freehand
elements; native drag, resize, pan, zoom, selection, and undo; Yjs multiplayer convergence;
presence (roster, cursors, selections, viewport, status, terminal focus); terminals on the
local machine via the bundled agent; multi-viewer terminals with controller lease;
owner-key bootstrap; scoped agent tokens + env injection
(`MANIFOLD_URL/PAD/ELEMENT/TOKEN`); revocation; document snapshots + crash recovery;
introspection endpoint; unit + e2e gates.

Deferred (seams named): remote-machine onboarding UX (protocol already supports it), padctl
CLI + MCP adapter (thin layers over the SDK), follow-mode camera, freeze button in roster UI
(revoke works via API), version-history UI (snapshot ring exists), web/iframe embeds, image
file sync, tmux-beneath-agent, multi-node rooms (RoomHost seam), TLS/domain hardening.

Explicit non-goals: accounts/SSO, ACL/sharing flows, editor embeds, analytics, E2E
encryption (conflicts with server-side scene validation — deliberate), provisioning compute
(bring your own, permanently).

## Consistency model (summary)

Durable elements live in a Yjs document: primitive fields merge independently, text uses
`Y.Text`, removals are CRDT map deletions, and (`zIndex`, `id`) determines paint order.
Clients apply local transactions optimistically; the server relays canonical document
updates and repairs schema-invalid element projections. Ephemeral gesture frames make
remote movement visible before the durable transaction commits.

## Risks & mitigations

1. `Bun.Terminal` regressions — pinned bun 1.3.13, validated by `docs/spikes/s2-pty`;
   fallback: agent package on Node + node-pty (protocol unchanged).
2. Many-node page cost — React Flow visibility culling plus bounded xterm lifecycle;
   soak test before calling large terminal workspaces done.
3. External-fact drift — decisions in `docs/decisions/` are dated; re-verify on upgrade.

## Lineage (what pad.ws taught)

Proven concepts carried as design (never code): terminal identity in native scene records;
off-viewport lifecycle; bounded collaborative updates with per-socket backpressure;
debounced durable flush; scoped revocable agent tokens; multi-attach shared sessions. Pain
not repeated: whole-record LWW conflicts; third-party renderer drift; five-service dev loop;
Redis as inter-process glue; 4-hop iframe terminal path; cosmetic presence; owner-scoped
(not principal-scoped) agent credentials.

## Governed product execution

Operator direction, 2026-09-07: Manifold, Babel and Code advance together.
Babel's fleet operations and live interface wait for the common engine capabilities
they need; a terminal launcher, polling loop or compatibility control path is not
their replacement.

The implementation thread joins #156 (typed machine jobs), #235 (machine halves),
#236 (resource consent and enforcement) and #169 (plugin-owned continuous streams).
Manifold owns authenticated dispatch, scoped authority, execution identity,
supervision, bounded results and stream delivery. Product plugins own their
operations, evidence and postconditions. The design must establish real machine-side
confinement and preserve requester, authorizer and executor attribution across
interruption and recovery; a permission card or successful process exit is not proof.

This direction authorizes the common non-privileged capabilities Babel needs and
normal PR/integrated-preview delivery. Privileged activation, production promotion,
release, fleet installation and expanded machine grants remain separate operator
actions. Contracts, implementation, verification and consumer cutover must be
delivered together before claiming the integration complete.

The #375 continuation targets current main's policy-scoped contract.
Its recovered blanket protocol-26 machine reset was not warranted: `hello.jobOwner`
is optional and `job_command`/`job_event` are new gated variants, so the
[machine add/reset rule](CONTRACTS.md#ws-wsmachine--machine-channel-json-data-fields-base64)
retains compatible terminal agents and adds 26. Governed job traffic remains 26-only,
including owner advertisement; the existing terminal-program guard remains.
The instance wire independently resets to 26 because its closed capability/reference
vocabularies expand; ordinary session clients remain exact-version. This current
normative contract takes precedence over the blanket cutover proposed in immutable
[ADR 0031](decisions/0031-governed-plugin-runtime.md), whose historical text is not rewritten.
It does not authorize a fleet restart, newer-agent installation before its hub, or
production rollout, and does not establish full Code/Babel delivery.

Local source verification on dev-01 (2026-09-07) exercises real hub/agent/owner
processes in a disposable delegated Linux unit: denial, queued revocation,
transport replacement, duplicate identity, bounded sealed output, descendant
cancellation and restart recovery. The required `verify:jobs` CI step provides
that fixture; it is not a live-hub installation. A separate SDK-only smoke ran
1,200 isolated-producer frames over 60 seconds, including reconnect, explicit
gaps and denial, with no frame payloads in the durable event plane.

The operator clarified on 2026-09-07 that preview delivery is expected, not held:
integrated preview follows `main`, and PR previews follow their heads. The prior
broad deployment hold recorded here was an agent interpretation error. Production
promotion, release and fleet installation remain separate authorizations.
At the local-source checkpoint above, browser acceptance had not yet been exercised;
the SDK smoke is not browser evidence. Source implementation is not full release qualification.
