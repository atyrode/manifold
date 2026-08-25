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

| Process | Entry                             | Env (defaults)                                                                                                                                                                                                                                                          |
| ------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| server  | `bun packages/server/src/main.ts` | `MANIFOLD_PORT` (7777), `MANIFOLD_DATA_DIR` (./data), `MANIFOLD_OWNER_KEY` (generated → `<data>/owner.key`), `MANIFOLD_PUBLIC_URL` (http://localhost:PORT), `MANIFOLD_WEB_DIST` (packages/web/dist), `MANIFOLD_SPAWN_AGENT` ("1": auto-spawn local agent, "0" in tests) |
| agent   | `bun packages/agent/src/main.ts`  | `MANIFOLD_SERVER_URL` (required), `MANIFOLD_MACHINE_TOKEN` (required), `MANIFOLD_MACHINE_NAME` (hostname)                                                                                                                                                               |
| web dev | `bun run --cwd packages/web dev`  | vite :5173, proxies `/api` + `/ws` → :7777                                                                                                                                                                                                                              |

Server startup log MUST include a single line `manifold ready url=<pre-authed URL>` where the
URL embeds the owner key as `#key=<hex>` (fragment, never query — fragments don't hit logs).
Auto-spawned local agent: server mints a machine token (raw copy kept at
`<data>/agent.token`, mode 600, for respawns — DB stores only the hash), spawns
`bun packages/agent/src/main.ts` **detached** (survives server exit), and writes
`<data>/agent.pid`. If `agent.pid` is alive on boot, do not spawn a second one.

Web URL scheme: the app lives at `/` (pad list) and `/p/<padId>` (pad view). The server
SPA-fallbacks every non-`/api`, non-`/ws`, non-`/healthz` GET to `index.html`. The URL
fragment is reserved for `#key=<owner-key>` bootstrap and is stripped by the client after
storing it.

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

| Method+Path             | Auth cap              | Req → Res                                                                                                                                        |
| ----------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET /healthz            | none                  | → `{ ok, version, protocolVersion }`                                                                                                             |
| GET /api/protocol       | none                  | → generated JSON-Schema of all wire messages                                                                                                     |
| GET /api/pads           | pads:read             | → `{ pads: Pad[] }`                                                                                                                              |
| POST /api/pads          | pads:write            | `{ name }` → `{ pad }`                                                                                                                           |
| GET /api/pads/:id       | pads:read             | → `{ pad }`                                                                                                                                      |
| DELETE /api/pads/:id    | `*`                   | → `{ ok }`                                                                                                                                       |
| POST /api/principals    | `*` (owner bootstrap) | `{ name, color?, kind? }` → `{ principal, token }` (token caps `["*"]` for humans)                                                               |
| POST /api/tokens        | tokens:mint           | `{ principal: {kind,name,color?} \| principalId, caps, padId? }` → `{ token, principal }`                                                        |
| POST /api/tokens/revoke | tokens:mint           | `{ principalId }` → `{ ok }`                                                                                                                     |
| POST /api/machines      | machines:mint         | `{ name }` → `{ machine: {id, name}, machineToken }` — raw token returned exactly once; DB stores the hash. Agents authenticate `hello` with it. |
| GET /api/machines       | pads:read             | → `{ machines: [{id,name,online}] }`                                                                                                             |
| GET /api/introspect     | `*`                   | → live rooms/sessions/machines/principals snapshot                                                                                               |

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

Handshake: first client frame MUST be `join { padId, token, lastRev? }`. Server replies
`init { epoch, rev, elements, roster, presences, sessions, self }` or closes:
4401 bad token · 4403 revoked/forbidden · 4404 unknown pad · 4409 protocol version mismatch.

### Scene sync (consistency model — NOT naive LWW)

- Server holds the canonical scene per pad room. `epoch` identifies a scene lineage
  (changes only on restore/reset); `rev` increments once per accepted update batch.
- Client sends `scene_update { updateId, baseRev, elements[] }` (≤128 elements, full
  changed records, ≤1MB frame). Applies optimistically on its own canvas first.
- Server reconciles each element with `@manifold/protocol` `reconcileElement`:
  accept iff `version > cur.version || (version === cur.version && versionNonce < cur.versionNonce)`.
  Deleted elements (`isDeleted: true`) are **retained tombstones**: kept in canonical state
  and snapshots so any stale pre-delete copy always loses LWW (undo-of-delete with a higher
  version legitimately resurrects — permanence is a storage rule, not an acceptance rule).
- **Epoch fence / compaction rule**: `scene_update` carries the client's `epoch` (learned
  from init/resync); a mismatch is rejected with `error { code:"epoch_mismatch" }` plus a
  fresh `resync`. Compacting tombstones is legal ONLY as an epoch bump: new epoch id,
  tombstones dropped, forced `resync` to all connected sockets — so no writer (connected or
  returning) can submit state built on pre-compaction history. v0 never auto-compacts; the
  fence and tests exist so it can, safely, later. Restore-from-snapshot uses the same bump.
- Server broadcasts `scene_applied { rev, elements, by }` with ONLY the accepted records
  (including to the sender) and acks the sender `scene_ack { updateId, rev, accepted }`.
- Clients apply `scene_applied` through the same `reconcileElement` — both sides run the
  identical module. Ordering for render: sort by (`index` ?? "", `id`); the server stores
  `index` opaquely and never rewrites it.
- Client detects a rev gap (received rev > lastRev+1) or epoch change → sends
  `resync_request {}` → server replies with a fresh `init`-shaped `resync`. `join` carries
  `protocolVersion`; mismatches close 4409.

### Presence (ephemeral, never persisted)

- `presence { payload }` where payload is a partial of
  `{ cursor: {x,y,tool} | null, selection: string[], viewport: {x,y,zoom}, focus: {elementId} | null, status: "active"|"idle"|"working"|"waiting"|"needs_attention"|"done" }`.
  Server stamps principal identity server-side (no spoofing) and relays to the room.
- `cursor { x, y, tool }` is its own high-rate message: client throttles ≥30ms; server may
  drop under backpressure (latest-wins). All other presence fields send on change only;
  viewport ≤1Hz.
- Roster: `init.roster` lists connected principals; server broadcasts
  `roster { joined?, left? }` deltas. Presence for a principal dies with its last socket.
- Multiple sockets per principal are legal (tabs); roster entries are per principal with
  a connection count.

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
  The OPENING client then writes `customData.sessionId` onto the element via a normal
  `scene_update` (the server never mutates the scene).
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
- `output { sessionId, seq, data }` streams to all LIVE viewers; `session_event
{ kind:"exited", exitCode }` on PTY exit; sessions with dead PTYs stay listed (status
  `exited`) until the pad's elements stop referencing them.
- Session ids are opaque; scene elements store only `customData.sessionId` +
  `customData.kind === "terminal"`.

## WS /ws/machine — machine channel (JSON; `data` fields base64)

Handshake: agent sends `hello { token, name, agentVersion, sessions }` where `sessions`
advertises surviving PTYs `{ sessionId, cols, rows, alive, seq }` (server-restart
adoption). Server replies `welcome { machineId, epoch }` or closes 4401.

Server→agent: `create { sessionId, cols, rows, cwd?, env }`, `input { sessionId, data }`,
`resize`, `kill`, `snapshot_request { sessionId }`.
Agent→server: `created { sessionId }` | `create_error { sessionId, message }`,
`output { sessionId, seq, data }` (seq: monotonic per session, assigned at emission),
`snapshot { sessionId, seq, data }`, `exited { sessionId, exitCode }`.

Reconnect: agent redials with jittered backoff (cap 15s), re-`hello`s with surviving
sessions; a new server epoch re-adopts them. Stale sockets are fenced: the server drops a
machine's previous socket when a new `hello` for the same machine token arrives.
PTY output while disconnected goes to the agent's per-session ring buffer (default 2MiB);
the headless mirror keeps render state, so post-reconnect attaches snapshot correctly.

## Persistence (SQLite, WAL; server-only)

```
pads(id TEXT PK, name TEXT, created_at INTEGER)
snapshots(pad_id TEXT, epoch TEXT, rev INTEGER, ts INTEGER, hash TEXT, blob TEXT,
          PRIMARY KEY (pad_id, epoch, rev))          -- keep newest 30 per pad
events(id INTEGER PK AUTOINCREMENT, pad_id TEXT, ts INTEGER, principal_id TEXT,
       type TEXT, payload TEXT)                       -- lifecycle/caps/join-leave ONLY
principals(id TEXT PK, kind TEXT, name TEXT, color TEXT, created_at INTEGER)
tokens(id TEXT PK, hash TEXT UNIQUE, principal_id TEXT, caps TEXT, pad_id TEXT,
       created_at INTEGER, revoked_at INTEGER)        -- store token HASH, never raw
machines(id TEXT PK, name TEXT, token_id TEXT, last_seen INTEGER)
sessions(id TEXT PK, machine_id TEXT, pad_id TEXT, element_id TEXT, created_by TEXT,
         status TEXT, exit_code INTEGER, created_at INTEGER)
meta(key TEXT PK, value TEXT)                         -- schema_version etc.
```

Snapshot cadence: 1.5s after last change, 10s max under sustained edits, and on graceful
shutdown. Terminal bytes NEVER touch SQLite. Presence NEVER touches SQLite.

## Testability (agent-facing)

- **Debug seam** (`packages/web/src/debug-seam.ts`): when `localStorage["manifold:debug"]
=== "1"`, `PadView` installs `window.__manifold` — READ-ONLY snapshot functions
  (`scene()`, `canvas()`, `pending()`, `rev()`, `epoch()`, `viewport()`) exposing the
  Excalidraw↔SDK projection boundary to automation. No mutation surface, no secrets.
  Consumers: `scripts/verify-convergence.ts`, `scripts/verify-public.ts`. The seam exists
  because this boundary shipped two divergence bugs no wire-level test could see; keep it
  read-only and keep it working.
- **Convergence invariant** (guarded by `bun run verify:convergence`, part of `gate`):
  after quiescence, `A.canvas ≡ A.sdkScene ≡ canonical ≡ B.sdkScene ≡ B.canvas` compared
  by version stamp AND geometry, with per-round effect assertions (a no-op gesture is a
  FAILURE, not a pass). Any change to scene sync — protocol reconcile, SDK scene handling,
  server rooms, or the web projection — must keep this gate green.
- **Ownership rule**: never hand Excalidraw an object owned by `client.scene` (it mutates
  painted elements in place); clone at the paint boundary. Top-level clone — the LWW
  fields (`version`, `versionNonce`) are always top-level — matching upstream Excalidraw
  collab, whose `restoreElements` is likewise a per-element spread before `updateScene`
  (excalidraw v0.18.1, `excalidraw-app/collab/Collab.tsx` `_reconcileElements`).

## Logging & introspection

JSONL to stdout: `{ ts, level: "info"|"warn"|"error", evt, ...fields }`. Never log tokens,
owner keys, or terminal data. `/api/introspect` exposes live state for agent-operators.

## Hard rules

1. Clean room: no code, schemas, CSS, or config copied from pad.ws — concepts only.
2. `@manifold/protocol` is the only place wire types exist. No inline message types.
3. Every message handler validates with the zod schema before acting; unknown message
   types are logged and ignored (forward compatibility), malformed frames of KNOWN types
   close the socket (server: policy close; client: 4002 + reconnect into a fresh init).
4. No package imports another package's internals — only workspace package roots.
5. Determinism in tests: server/agent take `RuntimeDeps { newId, now }` from
   `@manifold/protocol` (default random/wall-clock); testkit injects seeded/fake
   implementations. Port 0 (random) in tests.
