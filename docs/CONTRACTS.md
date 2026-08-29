# Cross-package contracts

This file is the integration authority for manifold's packages. Any change here requires
updating `@manifold/protocol` first, then every consumer, in the same change.
Wire message shapes live in `packages/protocol/src` (zod schemas are the source of truth;
this document explains semantics the schemas cannot).

## Topology

```
browser (web) ──┐
agent SDK ──────┼── WS /ws/session ──► manifold server ── SQLite (data/manifold.db)
padctl/tests ───┘                            ▲
                                             │ WS /ws/machine (outbound from machine)
                              manifold-agent daemon ── Bun.Terminal PTYs
```

- **server** (`packages/server`, entry `src/main.ts`): one Bun process. Serves web dist,
  HTTP API, both WebSocket endpoints, owns rooms + SQLite.
- **agent** (`packages/agent`, entry `src/main.ts`): separate long-lived process on any
  machine. Owns PTYs. Dials the server. Survives server restarts.
- **web** (`packages/web`): Vite/React client over `/ws/session` via `@manifold/sdk`.
- **sdk** (`packages/sdk`): typed protocol client. The ONLY WebSocket state machine in the
  repo — web, tests, and tools all use it. No parallel implementations.
- **testkit** (`packages/testkit`): spawn-real-processes helpers + e2e suites.

## Runtime contracts

| Process | Entry                             | Env (defaults)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| server  | `bun packages/server/src/main.ts` | `MANIFOLD_PORT` (7777), `MANIFOLD_BIND` (127.0.0.1), `MANIFOLD_DATA_DIR` (./data), `MANIFOLD_OWNER_KEY` (generated → `<data>/owner.key`), `MANIFOLD_PUBLIC_URL` (http://localhost:PORT), `MANIFOLD_WEB_DIST` (packages/web/dist), `MANIFOLD_SPAWN_AGENT` ("1": auto-spawn local agent, "0" in tests), `MANIFOLD_MACHINE_NAME` ("local": name the auto-spawned agent enrolls under), `MANIFOLD_ANNOUNCE_KEY` ("0"; "1" embeds `#key=` in the boot announce — dev/test only) |
| agent   | `bun packages/agent/src/main.ts`  | `MANIFOLD_SERVER_URL` (required), exactly one of `MANIFOLD_MACHINE_TOKEN` or `MANIFOLD_MACHINE_TOKEN_FILE` (file mode 0600; contents trimmed; the file form keeps the token out of unit files and process environment listings), `MANIFOLD_MACHINE_NAME` (hostname)                                                                                                                                                                                                        |
| web dev | `bun run --cwd packages/web dev`  | vite :5173, proxies `/api` + `/ws` → :7777                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Server startup log MUST include a single line `manifold ready url=<URL>`. With
`MANIFOLD_ANNOUNCE_KEY=1` (dev/test opt-in: `dev:server`, testkit) the URL embeds the owner
key as `#key=<hex>` (fragment, never query — fragments don't hit request logs). The default
omits the fragment so the owner key never enters log streams (AGENTS invariant 6);
operators read the key from `<data>/owner.key` instead.
Auto-spawned local agent: server mints a machine token (raw copy kept at
`<data>/agent.token`, mode 600, for respawns — DB stores only the hash), spawns
`bun packages/agent/src/main.ts` **detached** (survives server exit), and writes
`<data>/agent.pid`. If `agent.pid` is alive on boot, do not spawn a second one.

Web URL scheme: `/` is the authenticated pad-browser entry point. It replaces itself with
the last pad used by that principal on this device, falling back to the first visible pad;
`/p/<padId>` remains the canonical deep link. Both routes render one persistent browser
shell with a collapsible, resizable pad sidebar and the active canvas—there is no separate
pad-list surface. The sidebar is the owner-visible workspace index: machines are first-class,
pads may be reordered or grouped into collapsible folders, and optional live session rows nest
beneath their pads. Folder membership and pad order are durable server state; collapsed
sections, session-tree visibility, and sidebar width are device-local presentation state. The
server SPA-fallbacks every non-`/api`, non-`/ws`, non-`/healthz` GET to `index.html`. The URL
fragment is reserved for `#key=<owner-key>` bootstrap and is stripped by the client after
storing it.

Canvas resize affordances differ by element on purpose. A terminal is a window: its frame
border is a grab zone under the select tool, so hovering it shows the OS resize cursor and
a drag resizes with no selection step, and the controls carry no paint of their own. Text
and freehand keep the classic contract — no handles until the element is selected, then a
bounding box — and a stroke's box carries an SVG `viewBox`, so resizing scales the ink
instead of growing an empty frame around it. React Flow measures painted nodes itself and
the resizer reads `measured` for its starting size: a re-projection MUST carry that
measurement across (`carryMeasurements`), or a resize begun in that window starts from zero
and produces negative geometry that the commit path then rejects.

## Identity, tokens, capabilities

- `Principal { id, kind: "human" | "agent", name, color }`. Stable; stored in SQLite.
- Every socket/request acts as exactly one principal via bearer token.
- **Owner key** = hex-64 secret; acts as a token with cap `*`. Generated on first boot.
- Caps (v0): `*`, `pads:read`, `pads:write`, `scene:write`, `terminal:spawn`,
  `terminal:write`, `tokens:mint`. Reads of scene/presence come with `pads:read`.
  `terminal:write` covers input+resize+kill+take on sessions in scope.
- Token scope: optional `padId` restricts everything to one pad.
- Revocation: durable; server closes live sockets of revoked tokens with code 4403 and
  message `revoked`.

## HTTP API (JSON; `Authorization: Bearer <token-or-owner-key>`)

| Method+Path                 | Auth cap              | Req → Res                                                                                                                                        |
| --------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET /healthz                | none                  | → `{ ok, version, protocolVersion }`                                                                                                             |
| GET /api/protocol           | none                  | → generated JSON-Schema of all wire messages                                                                                                     |
| GET /api/pads               | pads:read             | → `{ pads: Pad[] }`                                                                                                                              |
| GET /api/pad-presence       | pads:read             | → `{ pads: [{padId, principals}] }` for currently connected principals; scoped tokens see only their pad                                         |
| POST /api/pads              | pads:write            | `{ name }` → `{ pad }`                                                                                                                           |
| GET /api/pads/:id           | pads:read             | → `{ pad }`                                                                                                                                      |
| PATCH /api/pads/:id         | pads:write            | `{ name }` → `{ pad }`                                                                                                                           |
| DELETE /api/pads/:id        | `*`                   | → `{ ok }`                                                                                                                                       |
| GET /api/pad-tree           | pads:read             | → `{ items: PadTreeItem[] }`; scoped tokens receive only their pad and its ancestor folders                                                      |
| PUT /api/pad-tree           | pads:write            | `{ item: {kind:"pad",id} \| {kind:"folder",id}, parentId: string \| null, index }` → `{ items: PadTreeItem[] }`                                  |
| POST /api/pad-folders       | pads:write            | `{ name, parentId? }` (default `null`) → `{ items: PadTreeItem[] }`                                                                              |
| PATCH /api/pad-folders/:id  | pads:write            | `{ name }` → `{ items: PadTreeItem[] }`                                                                                                          |
| DELETE /api/pad-folders/:id | pads:write            | → `{ items: PadTreeItem[] }`                                                                                                                     |
| GET /api/pad-sessions       | pads:read             | → `{ sessions: [{id,padId,machineId,elementId,createdAt,status,exitCode}] }`; scoped tokens see only their pad                                   |
| POST /api/principals        | `*` (owner bootstrap) | `{ name, color?, kind? }` → `{ principal, token }` (token caps `["*"]` for humans)                                                               |
| POST /api/tokens            | tokens:mint           | `{ principal: {kind,name,color?} \| principalId, caps, padId? }` → `{ token, principal }`                                                        |
| POST /api/tokens/revoke     | tokens:mint           | `{ principalId }` → `{ ok }`                                                                                                                     |
| POST /api/machines          | machines:mint         | `{ name }` → `{ machine: {id, name}, machineToken }` — raw token returned exactly once; DB stores the hash. Agents authenticate `hello` with it. |
| GET /api/machines           | pads:read             | → `{ machines: [{id,name,online}] }`                                                                                                             |
| GET /api/introspect         | `*`                   | → live rooms/sessions/machines/principals snapshot                                                                                               |

`PadTreeItem` is either `{ kind:"pad", pad:{ id, name, createdAt }, parentId:
string|null, sortOrder: nonnegative integer }` or `{ kind:"folder", id, name, createdAt,
parentId: string|null, sortOrder: nonnegative integer }`. A pad-tree move's `item` is exactly
`{ kind:"pad", id }` or `{ kind:"folder", id }`, and `index` is a nonnegative integer.
All pad-tree organization mutations (`PUT /api/pad-tree` and folder create/rename/delete)
reject pad-scoped tokens even when they have `pads:write`.

Delegation is attenuation-only: a minted token's caps MUST be a subset of the minter's
caps (root's `*` covers everything); minting `*` itself requires `isRoot`. Violations are
`forbidden`. This kills privilege escalation through `tokens:mint` chains.

`*` in the auth column means the wildcard capability itself (root/owner) — scoped tokens
can never satisfy it. The server computes an `AuthContext { principal, caps, padScope,
isRoot }` ONCE at the auth boundary (`isRoot` ⇔ caps contain `*`); root-only routes check
`isRoot`, scoped routes use `hasCap()` — never a wildcard sentinel comparison inline.
Machine enrollment requires `machines:mint`; ordinary `scene:write`/`terminal:write`
tokens must be rejected (covered by e2e: owner succeeds, `machines:mint` token succeeds,
delegated scene/terminal token is denied).
Errors: non-2xx with `{ error: { code, message } }`. Codes: `unauthorized`, `forbidden`,
`not_found`, `invalid`, `conflict`.

## WS /ws/session — session channel (JSON text frames)

Handshake: first client frame MUST be
`join { padId, token, protocolVersion, lastEpoch?, lastRev? }`. Server replies
`init { protocolVersion, epoch, rev, doc, roster, sessions, self, selfCaps,
selfConnId }` or closes:
4401 bad token · 4403 revoked/forbidden · 4404 unknown pad · 4409 protocol version mismatch.
`doc` is the base64-encoded full Yjs state update for the room. `selfCaps` mirrors the
joining principal's granted caps so clients can gate UI affordances (for example, the
sessions janitor's kill buttons) without a separate introspection round-trip. Presence is
carried by `roster`, whose entries are `PresenceState`; there is no separate `presences`
field.

### Scene sync (Yjs CRDT)

- Each room holds one canonical `Y.Doc`. Its `elements` map contains strict terminal, text,
  and draw records from `@manifold/protocol`; a removed element is absent rather than
  retained as a tombstone. Rendering order is (`zIndex`, `id`). `@manifold/scene` owns the
  Yjs representation and is the only production module that imports Yjs directly.
- The SDK applies edits optimistically with `client.transact(tx => ...)`. Field patches are
  independent CRDT writes, text content is a nested `Y.Text`, and one local undo manager
  tracks local create/patch/text/remove transactions. Consumers project the SDK's
  read-only `client.elements` map instead of mutating document-owned objects.
- A client sends `doc_update { update }`, where `update` is a base64 Yjs update capped at
  512 KiB decoded. Updates are idempotent and commutative; disconnected clients may queue
  document updates and merge them after reconnect.
- **Accept-then-repair:** the server applies a structurally valid, rate-limited update to
  the canonical document first. It then validates every changed element projection; an
  invalid element map is removed in a server-origin repair transaction. Yjs updates cannot
  be selectively rejected after application, so peers may observe the accepted update
  followed by its repair. A room also bounds full document and transport sizes.
- Every Yjs transaction update increments `rev` and broadcasts
  `doc_update { update, by }`, including to the sender; a repair is a separate server
  update. `rev` is a persistence/diagnostic watermark, not a sequencing requirement.
  `saved { rev, at }` identifies the latest durable room snapshot.
- `init` and `resync` carry a full Yjs state update. Within one `epoch`, the SDK merges that
  state with its document and re-sends local state when needed. An epoch change is a hard
  lineage fence: the SDK drops queued old-lineage document updates, replaces its `Y.Doc`,
  and emits `scene_reset` so held nested types are discarded. `resync_request {}` asks for
  the current full state; convergence does not depend on detecting contiguous revisions.

### Presence (ephemeral, never persisted)

- `presence { payload }` where payload is a partial of
  `{ cursor: {x,y,tool} | null, selection: string[], viewport: {x,y,zoom}, focus: {elementId} | null, status: "active"|"idle"|"working"|"waiting"|"needs_attention"|"done" }`.
  Server stamps principal identity server-side (no spoofing) and relays to the room.
- `cursor { x, y, tool }` is its own high-rate message: client throttles ≥30ms; server may
  drop under backpressure (latest-wins). `gesture { kind, phase, elementId, x, y, width?,
height?, points? }` carries ephemeral move, resize, and freehand previews at the same
  cadence; the server stamps `principalId`/`connId`, relays it, and never persists it.
  `phase:"end"` hands rendering back to the durable Yjs element. All other presence fields
  send on change only; viewport ≤1Hz.
- Roster: `init.roster` lists connected principals; server broadcasts
  `roster { joined?, left? }` deltas. Presence for a principal dies with its last socket.
- Multiple sockets per principal are legal (tabs); roster entries are per principal with
  a connection count and the exact live `connIds`. Cursor and gesture frames are stamped
  per-connection, so viewers retire a closed tab's cursor from `connIds` — pruning by
  principal alone strands ghost cursors while sibling tabs remain — and disambiguate
  sibling-tab cursor labels ("name (2)") from the same shared order.

### Terminals over the session channel

- `terminal_open { elementId, cols, rows, cwd?, machineId? }` → server targets `machineId`
  when given (error `no_machine` if it is unknown or offline); without it the server
  falls back to the sole online machine (error `no_machine` when zero or several are
  online — clients with a picker, like the web menu, pass `machineId` explicitly), mints
  a **session-scoped agent
  token** (caps `[pads:read, scene:write, terminal:spawn, terminal:write]`, padId-scoped),
  asks the agent to create the PTY with env `MANIFOLD_URL`, `MANIFOLD_PAD`,
  `MANIFOLD_ELEMENT`, `MANIFOLD_TOKEN` injected, then replies
  `terminal_opened { elementId, session }` and broadcasts `session_event { kind:"opened" }`.
  The OPENING client then writes the returned `session.id` into the element's top-level
  `sessionId` through `client.transact` (the server never mutates the element for it).
- **Attach state machine (no-gap invariant).** On `terminal_attach { sessionId }`:
  1. server registers the viewer as PENDING and starts queueing that session's live
     `output` frames for it (nothing is sent yet);
  2. server sends the agent `snapshot_request`;
  3. agent serializes its headless mirror at its current byte-sequence `S` (same ordered
     pipeline as output emission — an output emitted before the snapshot has seq ≤ S);
  4. server sends the viewer `terminal_snapshot { sessionId, seq: S, data }`, flushes
     queued outputs with `seq > S` in order, discards `seq ≤ S`, then marks the viewer LIVE.
     Viewer byte stream ≡ snapshot(S) + outputs(S+1…). e2e MUST assert mid-stream attach
     contiguity (counter test), repeated ≥10×.
- **Snapshot geometry.** A viewer MUST construct xterm at the advertised session
  `cols`/`rows` and replay the serialized snapshot before fitting to its canvas element.
  Serialized cursor movement is geometry-dependent; fitting first can corrupt wrapping after
  a pad switch or reload. After replay, the viewer fits once rendering settles and the
  controller reports the resulting geometry through `terminal_resize`.
- **Client-side view pairing.** The viewer registry above is **connection-scoped**
  (one `Viewer` per socket). A client presenting several views of one session (cloned
  terminal elements are mirrors) sends `terminal_attach` on EVERY view-attach: the
  server replaces the connection's viewer and re-emits snapshot(S′)+outputs(S′+1…),
  which is a late view's only path to existing screen state (frames broadcast to all
  local views; each re-renders from the fresh snapshot). `terminal_detach` is
  refcounted and fires only on the 1→0 transition — a raw detach from one view
  starves every other view on that connection. The SDK owns this (plus re-attach after
  reconnect, since the registry dies with the socket); components just pair
  attach/detach per view. Guarded by SDK contract tests.
- `terminal_input { sessionId, data }` (data base64) — accepted only from the current
  **controller**; others receive `error { code:"not_controller" }`.
- Controller lease: opener starts as controller; `terminal_take { sessionId }` transfers
  it to any principal with `terminal:write` (event `session_event { kind:"controller_changed",
controllerId }`). Controller-only: input, `terminal_resize` (broadcast as
  `session_event { kind:"resized", cols, rows }` so every viewer refits), `terminal_kill`.
- Kill authorization: the current **controller**, OR any holder of the wildcard
  capability (`*`), may send `terminal_kill` for a running session; other principals
  receive `error { code:"forbidden" }`. Exited + unreferenced sessions are
  garbage-collected server-side on the next init/resync of their pad; exited + parked
  sessions are pruned when the pool is listed.
- **Terminal pool (parked terminals).** A session's pad binding is dynamic:
  `SessionInfo.padId` is nullable, and `null` means the terminal is parked in the
  workspace pool — no canvas element anywhere, unreachable over `/ws/session` (the
  per-session pad gate rejects it), listed and mutated only over HTTP:
  `GET /api/terminals` (pool listing; prunes exited parked rows first),
  `POST /api/terminals/:id/park { elementId }` (removes that canvas element; unbinds
  the session only when it was the last element referencing it — otherwise it is copy
  removal and the session stays bound), `POST /api/terminals/:id/bind { padId, x?, y? }`
  (rebinds and **server-authors** the terminal element in the destination pad's doc),
  and `DELETE /api/terminals/:id` (kill). All reject pad-scoped tokens like the
  pad-tree mutations; reads need `pads:read`, mutations `pads:write`. Park broadcasts
  `session_event { kind:"parked" }` to the old room (clients drop the session); bind
  broadcasts `terminal_opened { elementId, session }` to the new room. Park/bind doc
  mutations transact under `SERVER_PLACE_ORIGIN`, which client undo managers never
  track — parking is deliberately not undoable. This narrowly amends "the server never
  mutates the element": it still holds for `terminal_open`, where the opening client
  writes `sessionId`; park/bind are the two server-authored exceptions. The
  session-scoped agent token stays scoped to the ORIGINAL pad after a rebind (env is
  baked at spawn); the PTY data path is machine-channel and unaffected.
- `output { sessionId, seq, data }` streams to all LIVE viewers; `session_event
{ kind:"exited", exitCode }` on PTY exit; sessions with dead PTYs stay listed (status
  `exited`) until the pad's elements stop referencing them.
- Session ids are opaque; terminal elements store their `sessionId` directly. Text and draw
  elements never reference terminal sessions.

## WS /ws/machine — machine channel (JSON; `data` fields base64)

Handshake: agent sends `hello { token, name, agentVersion, protocolVersion, sessions }`
where `sessions` advertises retained PTYs
`{ sessionId, cols, rows, alive, seq, exitCode? }` (server-restart adoption). An
`alive:false` advertisement reports a real `exitCode` when the PTY exited while
disconnected; absence is equivalent to `null`. Such exited sessions are retained through
the next `hello`, then forgotten when `welcome` acknowledges it (or when `kill` arrives).
Server replies `welcome { machineId, serverEpoch }` or closes: 4401 unauthorized,
4403 revoked, 4409 version. Version acceptance is the
`MACHINE_PROTOCOL_COMPAT_VERSIONS` set `{2,3,4}` (protocol/version.ts), NOT strict equality:
agents are long-lived and survive server deploys, so every compatible agent version stays
accepted (session/browser joins remain strictly current). An unchanged agent wire adds the
new version to the set; a strictly additive-optional change also adds it when every old
frame still parses and the absent-field default reproduces pre-bump semantics. Any other
agent-wire change resets the set to the new version and requires a coordinated fleet
restart. Every
rejection path emits a structured server log (`machine_version_rejected`,
`machine_rejected`, …) — silent closes are how a whole fleet goes dark undiagnosed.

Server→agent: `create { sessionId, cols, rows, cwd?, env }`, `input { sessionId, data }`,
`resize`, `kill`, `snapshot_request { sessionId }`, `ping`.
Agent→server: `created { sessionId }` | `create_error { sessionId, message }`,
`output { sessionId, seq, data }` (seq: monotonic per session, assigned at emission),
`snapshot { sessionId, seq, data }`, `exited { sessionId, exitCode }`, `pong`.

Liveness, server half: after `welcome` the server sends `ping` every
`MACHINE_PING_INTERVAL_MS` (30s); a ping still unanswered when the next fires closes the
socket (4008 `liveness timeout`), so a frozen or partitioned agent (laptop sleep, dropped
network) is marked offline within two intervals — TCP alone would keep it "online"
indefinitely. Agent half: a healthy connection carries those pings even when idle, so the
agent closes and re-dials after `AGENT_LIVENESS_TIMEOUT_MS` (75s) of total silence —
catching phantom transports (dead TCP with no RST, e.g. a proxy swallowing the close
mid-reload). The agent also logs every disconnect's close code/reason.

Reconnect: agent redials with jittered backoff (cap 15s), re-`hello`s with retained
sessions; a new server epoch re-adopts them. On successful re-adoption of a running
session, the server transitions every existing viewer back to PENDING and uses the normal
attach machinery to request a fresh snapshot. This heals output dropped during the
disconnect window, including ring-buffer overflow. Stale sockets are fenced: the server
drops a machine's previous socket when a new `hello` for the same machine token arrives.
PTY output while disconnected goes to the agent's per-session ring buffer (default 2MiB);
the headless mirror keeps render state, so post-reconnect attaches snapshot correctly.
If WebSocket `bufferedAmount` exceeds the 8MiB hard cap, the agent logs the structured
backpressure event, closes the socket, and re-dials through this same ring/mirror and
re-adoption path rather than allowing unbounded process memory growth.

The agent daemon owns its PTYs. Agent↔server disconnects preserve them for re-adoption, but
an agent process restart kills every PTY it owns; PTYs do not survive the daemon. Node
upgrades and redeploys therefore MUST be operator-timed or idle-gated, never automatic on
deploy.

## Persistence (SQLite, WAL; server-only)

```
pads(id TEXT PK, name TEXT, created_at INTEGER)
scene_docs(pad_id TEXT, epoch TEXT, rev INTEGER, ts INTEGER, hash TEXT, doc BLOB,
           PRIMARY KEY (pad_id, epoch, rev))          -- keep newest 30 valid docs per pad
events(id INTEGER PK AUTOINCREMENT, pad_id TEXT, ts INTEGER, principal_id TEXT,
       type TEXT, payload TEXT)                       -- lifecycle/caps/join-leave ONLY
principals(id TEXT PK, kind TEXT, name TEXT, color TEXT, created_at INTEGER)
tokens(id TEXT PK, hash TEXT UNIQUE, principal_id TEXT, caps TEXT, pad_id TEXT,
       created_at INTEGER, revoked_at INTEGER)        -- store token HASH, never raw
machines(id TEXT PK, name TEXT UNIQUE, token_id TEXT, last_seen INTEGER)
sessions(id TEXT PK, machine_id TEXT, pad_id TEXT, element_id TEXT, created_by TEXT,
         status TEXT, exit_code INTEGER, created_at INTEGER)
meta(key TEXT PK, value TEXT)                         -- schema_version etc.
```

The server snapshots a full encoded Yjs document 1.5s after the last change, at least every
10s under sustained edits, on room eviction, and on graceful shutdown. Loading scans the
newest retained documents and skips corrupt entries. Terminal bytes, presence, cursor
frames, and gesture frames NEVER touch SQLite.

## Testability (agent-facing)

- **Debug seam** (`packages/web/src/debug-seam.ts`): when `localStorage["manifold:debug"]
=== "1"`, the active pad renderer installs `window.__manifold` — READ-ONLY snapshot
  functions (`scene()`, `canvas()`, `outbox()`, `gestures()`, `rev()`, `epoch()`,
  `viewport()`) exposing the browser-canvas↔SDK projection boundary to automation. No
  mutation surface, no secrets. Consumers: `scripts/verify-convergence.ts`,
  `scripts/verify-public.ts`. The seam exists because this boundary shipped two divergence
  bugs no wire-level test could see; keep it read-only across renderer changes.
- **Convergence invariant** (guarded by `bun run verify:convergence`, part of `gate`):
  after quiescence, `A.canvas ≡ A.sdkScene ≡ canonical ≡ B.sdkScene ≡ B.canvas` compared
  by element type, geometry, z-index, and type-specific content, with per-round effect
  assertions (a no-op gesture is a FAILURE, not a pass). The same gate proves live remote
  drag and stroke previews before pointer release, collaborative `Y.Text`, and undo.
- **Ownership rule**: never mutate or hand a mutating renderer an object owned by
  `client.elements` or `client.doc`. Project renderer-owned objects at the paint boundary
  and publish edits through `client.transact`.

## Logging & introspection

JSONL to stdout: `{ ts, level: "info"|"warn"|"error", evt, ...fields }`. Never log tokens,
owner keys, or terminal data. `/api/introspect` exposes live state for agent-operators.

## Hard rules

1. Clean room: no code, schemas, CSS, or config copied from pad.ws — concepts only.
2. `@manifold/protocol` is the only place wire types exist. No inline message types.
3. Every message handler validates with the zod schema before acting, except that the SDK
   MAY structurally validate inbound `terminal_output`/`terminal_snapshot` (type tag,
   nonempty `sessionId`, nonnegative integer `seq`, and string `data` bounded to 700,000
   characters) instead of rerunning zod's base64-alphabet check. The SDK MAY likewise skip
   full zod parsing for the SDK-constructed outbound `cursor` and `terminal_input` hot
   paths. The server still performs full schema validation at the untrusted boundary, and
   every other frame keeps full schema validation on both sides. Unknown message types are
   logged and ignored (forward compatibility); malformed frames of KNOWN types close the
   socket (server: policy close; client: 4002 + reconnect into a fresh init).
4. No package imports another package's internals — only workspace package roots.
5. Determinism in tests: server/agent take `RuntimeDeps { newId, now }` from
   `@manifold/protocol` (default random/wall-clock); testkit injects seeded/fake
   implementations. Port 0 (random) in tests.
