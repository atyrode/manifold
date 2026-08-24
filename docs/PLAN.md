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
  (agents) + SQLite (WAL). Canonical scene per room; server-side reconciliation with
  per-element version/versionNonce rules and permanent tombstones; debounced snapshots.
- **agent**: separate long-lived daemon holding PTYs (`Bun.Terminal`), dialing OUT to the
  server; sessions survive server restarts; headless xterm mirror gives gap-free attach
  snapshots.
- **web**: React 19 + upstream `@excalidraw/excalidraw` 0.18.1 (pinned, never forked
  in-place; fork-fresh-from-upstream is the documented escape hatch) + xterm 6 terminals
  rendered as embeddable elements; presence rendered from the roster.
- **sync**: server-canonical relay (join → init → scene_update/scene_applied → resync),
  first-party presence envelope (no CRDT runtime), high-rate cursor channel separate from
  reliable scene channel.

## v0 scope (current build)

In: multiple pads with URLs; draw + full Excalidraw editing; multiplayer convergence;
presence (roster, cursors, selection, status, terminal focus); terminals on the local
machine via the bundled agent; multi-viewer terminals with controller lease; owner-key
bootstrap; scoped agent tokens + env injection (`MANIFOLD_URL/PAD/ELEMENT/TOKEN`);
revocation; snapshots + crash recovery; introspection endpoint; unit + e2e gates.

Deferred (seams named): remote-machine onboarding UX (protocol already supports it), padctl
CLI + MCP adapter (thin layers over the SDK), follow-mode camera, freeze button in roster UI
(revoke works via API), version-history UI (snapshot ring exists), web/iframe embeds, image
file sync, tmux-beneath-agent, multi-node rooms (RoomHost seam), TLS/domain hardening.

Explicit non-goals: accounts/SSO, ACL/sharing flows, editor embeds, analytics, E2E
encryption (conflicts with server-side reconciliation — deliberate), provisioning compute
(bring your own, permanently).

## Consistency model (summary)

Element-granularity last-writer-wins with Excalidraw semantics: accept iff
`version > current.version`, tie-break `versionNonce < current.versionNonce`; deletions are
permanent tombstones; fractional `index` stored opaquely, ordering client-side; same
reconcile module runs on client (optimistic) and server (canonical). Known accepted
weakness: concurrent edits to different properties of the same element — one side wins.

## Risks & mitigations

1. `Bun.Terminal` regressions — pinned bun 1.3.13, validated by `docs/spikes/s2-pty`;
   fallback: agent package on Node + node-pty (protocol unchanged).
2. Excalidraw customization walls (toolbar/context menus/custom shapes are not slot-
   replaceable in 0.18.1) — baseline fits published slots; escape hatch: fresh upstream fork.
3. Many-xterm page cost — DOM renderer default, dispose offscreen, capped scrollback;
   soak test before calling terminals done.
4. External-fact drift — decisions in `docs/decisions/` are dated; re-verify on upgrade.

## Lineage (what pad.ws taught)

Proven concepts carried as design (never code): terminal identity inside scene elements'
`customData`; embed dispatch + off-viewport lifecycle; bounded patches with per-socket
backpressure; version/versionNonce/tombstone reconciliation; debounced durable flush;
scoped revocable agent tokens; multi-attach shared sessions. Pain not repeated: forked
Excalidraw drift; five-service dev loop; Redis as inter-process glue; 4-hop iframe terminal
path; cosmetic presence; owner-scoped (not principal-scoped) agent credentials.
