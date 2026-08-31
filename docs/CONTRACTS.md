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
  repo — web, tests, and tools all use it. No parallel implementations. It pools ONE socket
  per (WebSocket factory, url, token) and a `SessionClient` is a channel handle on it, so a
  tab holds one connection no matter how many rooms it renders; the pool owns dialing,
  keepalive, reconnect-with-rejoin-every-channel, and demultiplexing.
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

Web URL scheme: `/` is the authenticated browser entry point. It replaces itself with the
last pad used by that principal on this device, falling back to the first visible pad;
`/p/<padId>` remains the canonical deep link, and it renders the canvas or the tiled
renderer according to that container's `layout`. Both routes render one persistent browser
shell with a collapsible, resizable sidebar and the active container—there is no separate
pad-list surface. The sidebar is the owner-visible workspace index, and it is ONE index:
canvases, compositions, and the terminals that live in them are rows of the same tree
(titled "Views"), with folders over all three, because a pad and a composition are lenses on
one object and a row's glyph carries the difference. A solo composition wears its terminal's
name, mark and actions — a composition of one IS the item it holds — and renaming that row
renames the TERMINAL. The sidebar is itself a plugin panel (`core.shell.sidebar`) and its
sections are manifest contributions — each plugin declares
`sections: [{ id, title, order }]` — so the stack's ORDER is workspace vocabulary rather
than device memory. Folder membership and tree order are durable server state; sidebar WIDTH
is the workspace layout's root ratio (`core.layout.set`), collapse is presence
(`view.sidebarCollapsed`, with a device-local mirror for first paint), and session-tree
visibility plus folder expansion stay device-local (`AXIOMS.md` §Device-local register). The
server SPA-fallbacks every non-`/api`, non-`/ws`, non-`/healthz` GET to `index.html`. The URL
fragment is reserved for `#key=<owner-key>` bootstrap and is stripped by the client after
storing it.

Canvas resize affordances differ by element on purpose. A canvas widget is a window: a
portal's frame border is a grab zone under the select tool (the same 8px edges and 14px
corners a terminal's frame carried), so hovering it shows the OS resize cursor and a drag
resizes with no selection step, and the controls carry no paint of their own — a mono portal
reads as the terminal it holds, down to using the terminal's size floor instead of the
widget's. Text and freehand keep the classic contract — no handles until the element is
selected, then a
bounding box — and a stroke's box carries an SVG `viewBox`, so resizing scales the ink
instead of growing an empty frame around it. React Flow measures painted nodes itself and
the resizer reads `measured` for its starting size: a re-projection MUST carry that
measurement across (`carryMeasurements`), or a resize begun in that window starts from zero
and produces negative geometry that the commit path then rejects.

## Identity, tokens, capabilities

- `Principal { id, kind: "human" | "agent", name, color }`. Stable; stored in SQLite.
- Every request, and every CHANNEL on a session socket, acts as exactly one principal via
  bearer token; a connection carries one credential's channels, because the SDK pools by
  token.
- **Owner key** = hex-64 secret; acts as a token with cap `*`. Generated on first boot.
- Caps: `*`, `pads:read`, `pads:write`, `scene:write`, `terminal:spawn`, `terminal:write`,
  `tokens:mint`, `machines:mint`, `plugins:manage`. Reads of scene/presence come with
  `pads:read`. `terminal:write` covers input+resize+kill+take on sessions in scope.
  `plugins:manage` authorizes plugin administration only (`core.plugins.setEnabled`).
- Token scope: optional `padId` restricts everything to one pad.
- Revocation: durable; server closes live sockets of revoked tokens with code 4403 and
  message `revoked`.

### Authority (planned)

Today's model is flat and stays flat this wave: a token carries a `Cap[]` plus an optional
`padScope`, and `AuthContext.allows(cap, padId)` answers every authority question. That is
deliberately the DEGENERATE case of the ratified design in
`docs/decisions/0011-permission-waterfall.md`, where authority is a waterfall of grants on
the node tree — `{ principal | class, node: "manifold://…", caps, effect, reach }` evaluated
root→node, deeper beating shallower, `deny` beating `allow` at equal specificity. Today's cap
array is a synthesized root grant; today's `padScope` is a subtree grant at
`manifold://pad/<id>`; a share will be a minted token bound to a subtree grant.
`packages/server/src/auth.ts` is the tagged evaluator seam (`AXIOMS.md` floor registry): the
evaluator replaces ONE call surface and the action door's declared-capability intersection
sits unchanged on top of it.

Principals reserve a future `origin` notion — which instance a principal belongs to — for
cross-instance sharing. Wave 1 writes no such field, and the SDK's channel pool is
conceptually keyed by `(origin, padId)` with origin fixed to this instance, so wave 3 supplies
real origins without re-keying anything (`AXIOMS.md` §Roadmap).

## HTTP API (JSON; `Authorization: Bearer <token-or-owner-key>`)

| Method+Path                        | Auth cap              | Req → Res                                                                                                                                      |
| ---------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| GET /healthz                       | none                  | → `{ ok, version, protocolVersion, build? }` (`build` is the git SHA baked at build time)                                                      |
| GET /api/protocol                  | none                  | → generated JSON-Schema of all wire messages, plus the published placement vocabulary and the plugin/action vocabulary                         |
| GET /api/pads                      | pads:read             | → `{ pads: Pad[] }`, `Pad { id, name, createdAt, layout }`                                                                                     |
| GET /api/pad-presence              | pads:read             | → `{ pads: [{padId, principals}] }` for currently connected OCCUPANTS; scoped tokens see only their pad                                        |
| POST /api/pads                     | pads:write            | `{ name, layout? }` → `{ pad }` (`layout` defaults `"canvas"`)                                                                                 |
| GET /api/pads/:id                  | pads:read             | → `{ pad }`                                                                                                                                    |
| PATCH /api/pads/:id                | pads:write            | `{ name }` → `{ pad }`                                                                                                                         |
| DELETE /api/pads/:id               | `*`                   | → `{ ok }`; sweeps every reference to the container, then every PTY homed in it                                                                |
| DELETE /api/pads/:id/tiles/:tileId | pads:write            | → `{ ok }`; removes ONE leaf (not a placement). A terminal's last leaf reaps the terminal; an emptied composition retires                      |
| POST /api/place                    | pads:write            | `PlaceRequest` → `PlaceResponse`, or 409 `placement_denied` carrying the rule that refused. THE placement door                                 |
| POST /api/actions/:name            | per action (declared) | action args → 200 `ActionOutcome`: `{ok:true,result}` or `{ok:false,denial:{rule,message}}`. Refusals are DATA, never non-2xx. THE action door |
| GET /api/plugins                   | any token             | → `PluginRoster` (manifests, `enabled`, `source`, action summaries). Pad-scoped tokens included: the roster is vocabulary                      |
| GET /api/layout                    | any token             | → `{ layout }` — the CALLER's workspace `TileLayout`, or `DEFAULT_WORKSPACE_LAYOUT` when unset. Self-scoped by construction                    |
| GET /api/resolve?uri=              | pads:read             | → `ResolveResponse { uri, ref, exists, title }`; an unparseable or non-`manifold://` uri is 400 `invalid`                                      |
| GET /api/containers                | pads:read             | → `{ containers: ContainerCensus[] }` — what every container holds and points at; the index's whole input                                      |
| GET /api/terminals                 | pads:read             | → `{ terminals: [{id,machineId,name,createdAt,status,exitCode,homeId,unplaced}] }` — every terminal, `unplaced` derived                        |
| GET /api/pad-tree                  | pads:read             | → `{ items: PadTreeItem[] }`; scoped tokens receive only their pad and its ancestor folders                                                    |
| PUT /api/pad-tree                  | pads:write            | `{ item: {kind:"pad",id} \| {kind:"folder",id}, parentId: string \| null, index }` → `{ items: PadTreeItem[] }`                                |
| POST /api/pad-folders              | pads:write            | `{ name, parentId? }` (default `null`) → `{ items: PadTreeItem[] }`                                                                            |
| PATCH /api/pad-folders/:id         | pads:write            | `{ name }` → `{ items: PadTreeItem[] }`                                                                                                        |
| DELETE /api/pad-folders/:id        | pads:write            | → `{ items: PadTreeItem[] }`                                                                                                                   |
| GET /api/pad-sessions              | pads:read             | → `{ sessions: [{id,padId,machineId,createdAt,status,exitCode}] }`, `padId` = the home; scoped tokens see only their pad                       |
| POST /api/principals               | `*` (owner bootstrap) | `{ name, color?, kind? }` → `{ principal, token }` (token caps `["*"]` for humans)                                                             |
| POST /api/tokens                   | tokens:mint           | `{ principal: {kind,name,color?} \| principalId, caps, padId? }` → `{ token, principal }`                                                      |
| POST /api/tokens/revoke            | tokens:mint           | `{ principalId }` → `{ ok }`                                                                                                                   |
| POST /api/machines                 | machines:mint         | `{ name, rotateToken? }` → `{ machine: {id, name}, machineToken? }` — idempotent by name; raw token returned exactly once, DB stores the hash  |
| GET /api/machines                  | pads:read             | → `{ machines: [{id,name,online}] }`                                                                                                           |
| GET /api/introspect                | `*`                   | → live rooms/sessions/machines/principals snapshot                                                                                             |

`PadTreeItem` is either `{ kind:"pad", pad:{ id, name, createdAt }, parentId:
string|null, sortOrder: nonnegative integer }` or `{ kind:"folder", id, name, createdAt,
parentId: string|null, sortOrder: nonnegative integer }`. A pad-tree move's `item` is exactly
`{ kind:"pad", id }` or `{ kind:"folder", id }`, and `index` is a nonnegative integer.
Every WORKSPACE-WIDE door rejects pad-scoped tokens even when they hold the cap: pad-tree
organization (`PUT /api/pad-tree` and folder create/rename/delete), the terminal index, the
container census, `POST /api/place`, leaf removal, and — this wave — every action
(`POST /api/actions/:name` refuses `padScope !== null` with denial `forbidden`, message
"scoped tokens cannot invoke workspace actions"). A placement moves items between containers,
so a token scoped to one container can never authorize it; finer per-node scoping arrives with
the permission waterfall (§Authority (planned)). `GET /api/plugins` and `GET /api/layout` are
the two exceptions by construction: the roster is global vocabulary, and a layout read is
self-scoped.

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
`not_found`, `invalid`, `conflict`, `internal`. A refused PLACEMENT is its own 409 shape
(`placement_denied`, below) because it carries the rule that refused as data.

## Containers, placement, and the index

A View and a Pad are ONE container object, told apart by `layout`. Everything that lands in
one goes through a single door — `POST /api/place` — and its legality is DATA in
`packages/protocol/src/placement.ts`, published to agents and mods through
`GET /api/protocol`. The verb routes it replaced (bind, park, add-tile, compose, extract,
expand, pin) are DELETED, not deprecated: expand had nothing left to create once every
terminal already lived in a composition, and pin had nothing left to claim once no container
dissolved under anybody.

**Vocabulary.** Item kinds declare the capability GROUPS they belong to, container kinds
declare the groups they accept, and the only imperative rules are three enumerated guards.
Every nesting rule is therefore DERIVED from the tables rather than branched on in an
executor — "compositions never nest" IS the absence of `tileable` from the `view`
declaration — and every refusal names the declaration that refused it.

| Item kind    | Groups                                                   | Guards                   | Homing   |
| ------------ | -------------------------------------------------------- | ------------------------ | -------- |
| `terminal`   | tileable, unplaceable, canvas-item-as-portal             | —                        | eager    |
| `canvas-pad` | tileable, embeddable, unplaceable, canvas-item-as-portal | no-self-embed            | inline   |
| `view`       | mergeable, unplaceable, canvas-item-as-portal            | no-self-embed, solo-only | inline   |
| `text`       | tileable, canvas-item                                    | —                        | on-claim |
| `draw`       | canvas-item                                              | —                        | inline   |
| `tile`       | extractable                                              | —                        | inline   |
| `panel`      | tileable                                                 | —                        | none     |

Containers: `canvas` accepts canvas-item, canvas-item-as-portal, extractable; `view` accepts
tileable, mergeable; `unplaced` accepts unplaceable — "nowhere" is listed as a destination so
that releasing an item is a named op the algebra can refuse, not a request that quietly does
nothing. Both real containers carry the `discipline-match` guard. Destination forms name the
container kind that admits them and the discipline it requires: `canvas`→canvas,
`tile`→tiled view, `compose`→a view born on a CANVAS, `unplaced`→neither.

**Homing** is how an item acquires the composition it LIVES in, and it is a property of the
KIND, never of a gesture: `eager` — the server births the home with the item, so a terminal
has one before its first byte of output and "where does this live" never has two answers;
`on-claim` — the item is born inline in whatever document created it (CRDT-instant, no round
trip) and its home row materialises inside the first placement op that needs one; `inline` —
the item needs no home, which covers canvas furniture and containers, a container BEING a
home.

**Wire shapes.** `PlaceRequest { surface, destination }`:

- `surface` — `{kind:"terminal", sessionId}` and `{kind:"pad", padId}` name an ITEM by
  identity; `{kind:"tile", containerId, tileId}` and `{kind:"element", padId, elementId}`
  name one existing PLACEMENT of one, which is how a single mirror of a multi-placed session
  becomes addressable. These are ADDRESSING forms, deliberately not `TileSurface`'s STORAGE
  forms: a note has no identity outside the document holding it, so it is addressed as an
  `element` and stored as a leaf's `text` surface, and the executor translates.
- `destination` — four forms: `{kind:"canvas", padId, x, y}`;
  `{kind:"tile", padId, targetTileId, edge}`, where a null target fills the first empty leaf
  else splits the root and a null edge fills an empty target else splits it;
  `{kind:"compose", padId, targetElementId, edge}`; and `{kind:"unplaced"}`, which carries no
  position, because what used to be a pool with a durable order is now the top level of the
  one index.
- `PlaceResponse` is tagged by the op that ran: `portal` / `extract` / `move_element` →
  `{ elementId }`, `add_tile` → `{ tileId }`, `compose` → `{ viewId, tileId }`, `unplace` →
  `{ removed }`. Zero removed is a legal, meaningful answer — the item was already unplaced —
  and that is the difference between "already so" and the silent no-op the algebra refuses to
  have.
- A refusal is DATA: HTTP 409 with
  `{ error: { code:"placement_denied", message, denial: { rule, surface, container } } }`.
  Rules are `not_accepted` (group containment failed), `self_embed`, `discipline`,
  `not_solo`, `unknown_surface`, `unknown_container`. Clients render the RULE; nobody parses
  the message. Operational impossibilities (a vanished session, a tree that rejects a write)
  travel as ordinary `not_found` / `conflict`, because they are not statements about what
  composes.

`resolvePlacement` is PURE and answers from a `PlacementLookup` the caller already holds, so
the server runs it against its rows and live docs and the browser against its props and its
own docs: legality cannot drift between a drag preview and the write that follows it. The
executor then resolves the surface's CURRENT location from identity, never from the request,
so a caller cannot lie about where an item was.

**The index.** `GET /api/containers` returns one
`ContainerCensus { padId, layout, items, references }` per container. `items` are what it
holds DIRECTLY — occupied leaves for a composition, elements for a canvas, in the container's
own order, each classified with the placement algebra's own item kinds so a census answer and
a placement resolution can never disagree about what something is. `references` is the
forward edge of containment (portal elements, and `pad` leaves). Inverting `references`
across every container yields:

> **INDEX VISIBILITY RULE.** The top level is HOMES and the HOMELESS. A container is a home
> and always shows. An ITEM shows at top level only while nothing holds it, because a placed
> item is already visible inside whatever holds it, and listing it twice would make the index
> a second, competing statement about where things are. A container no other container
> references is top-level; one with parents renders as a collapsed child under each of them.

A terminal is the only item with an index row of its own today (its home composition), and
`unplaced` from `GET /api/terminals` is the server's own answer to "does anything reference
this?". `censusSolo(census)` — the item a container of ONE holds, else null — is exported
rather than inlined because that one line IS the paradigm: chrome, merging, and the index all
read it, and three subsystems deciding it separately is how they would come to disagree.

Census cost model: ONE route rather than a field on each pad route, because the visibility
rule needs the containment GRAPH and a graph cannot be assembled from rows fetched one at a
time. Resident rooms answer from their live document (and drop their cache entry as they do);
every other pad is decoded from its newest stored snapshot and cached AGAINST THAT
REVISION — so an idle workspace costs one query per pad and a busy one costs only the pads
that actually changed. A pad with no stored document, or one whose snapshot fails to decode,
censuses as empty rather than failing the read.

**Solo-composition lifecycle.** There is no transient flag, no pin, and no expand. Entering a
composition is NAVIGATION to something that already exists, and nothing dissolves under
anybody.

- **Birth.** A terminal's home is created with the terminal and holds exactly one leaf. On a
  canvas it appears as a portal onto that home, wearing the terminal's own chrome.
- **Merge.** Compositions MERGE, never nest. A composition holding exactly ONE item is that
  item as far as placement is concerned, so it is absorbed as its occupant; a composition
  holding several (or none) that still reaches a tile destination is refused by name
  (`not_solo`). A canvas merge (`compose`) births ONE composition named `"<A> + <B>"` from
  the two surfaces' labels, repoints the target's portal element at it IN PLACE — same
  element id, same geometry, so no collaborator's widget jumps and no selection is lost —
  moves both occupants in, repoints every other reference that pointed at an absorbed home,
  and retires each emptied home. Dropping onto a reference to a MULTI-item composition is not
  a merge at all: the surface joins it as a plain tile.
- **Extract.** Dragging a leaf onto a canvas RE-HOMES its terminal into a fresh solo
  composition and authors a portal onto that, because a terminal always lives in a
  composition and the one it was sharing is not it any more. The new home is built BEFORE the
  old leaf goes, so a tree that refuses the write leaves the terminal where it was rather
  than nowhere. Extracting from an already-solo composition churns no ids: that composition
  IS the item, so the drop simply authors a reference to it. A note travels as its own
  element; an embedded canvas as a reference.
- **Unplace.** Every reference to the item goes and the item stays where it lives — a
  terminal in its home, a container in the index. A gesture that grabbed ONE reference
  releases that one; naming the item by identity releases all of them. Nothing is destroyed,
  which is the whole difference from the park it replaced: there is no pool to move into
  because there is nowhere else to be.
- **Reaping, and the ONE lifecycle predicate.** A terminal stops in exactly one of two ways,
  and the whole difference is INTENT.
  - **KILLED** — somebody asked for it: `terminal_kill`, the action
    `core.terminals.kill { sessionId }`, or `DELETE /api/pads/:id/tiles/:tileId` on its last
    leaf. All three are one write: the PTY, the session row, every leaf its home held for it,
    and — when the terminal was the last thing its home held — the home itself plus EVERY
    portal onto that home, on every canvas, whether or not anybody has it open. Nothing
    lingers, so there is no exited row to find afterwards and no exit code to report, because
    nothing is left to report it on. The tile door is the one tile gesture that is NOT a
    placement (nothing accepts "nowhere" as a destination for a LEAF); a note's leaf is its
    only placement, so its element goes with it.
  - **EXITED** — the PTY stopped on its own. That is INFORMATION, so nothing at all is
    deleted: the row keeps its REAL exit code (`null` only when none was observed, e.g. an
    agent-disconnected exit), its home keeps its leaf, and every portal onto that home keeps
    rendering it until somebody kills it. Killing an already-exited terminal sweeps it exactly
    like a running one — dismissing a dead terminal is the same verb, not a second path.

  The predicate is structural, not a stored flag: a killed session is gone before the
  machine's `exited` frame can arrive, so that frame finds nothing and no third status can
  propagate. An undeliverable kill (machine offline) still removes everything; the PTY that
  outlived it is killed by `hello` reconciliation, which finds no row to adopt it against.

- **Emptying and deletion.** A composition that just lost its last occupant retires: it is
  the DEPARTURE, not the emptiness, that retires a container, so a deliberately empty
  composition ("New composition", or one whose tiles were never filled) stays. Deleting a
  container (`DELETE /api/pads/:id`) removes every reference to it FIRST, then kills every
  PTY still homed in it, then drops its room and row. A reference never outlives what it
  references, which is why a widget pointing at nothing is not a state this server can reach.

## Plugins, actions, and the workspace layout

Everything above the foundation floor is a plugin (`AXIOMS.md` axiom A1); this section is what
the packages promise each other about that. Composition happens twice from the same manifests —
`packages/server/src/composition.ts` registers server halves, `packages/web/src/composition.ts`
web halves — and both run `composeRoster` from `@manifold/plugin`, which refuses duplicate
plugin ids, action names, panel ids, element types and tool ids by NAMING every offender.
Manifests are inert DATA: no executable fields, with `entry` and the roster's `source` reserved
for the later dynamic-distribution wave. Plugins are trusted in-process code today (ADR 0010);
the wire is the security boundary and every authority decision happens at a door.

**The roster.** `GET /api/plugins` returns one entry per composed plugin
`{ manifest, enabled, source: "builtin", actions: ActionSummary[] }`, each summary carrying
`{ name, title, caps, input, result }` with input/result as JSON Schemas generated from the zod
definitions. `GET /api/protocol` embeds the same vocabulary beside the wire schemas, so an agent
learns every door from one unauthenticated read.

**The action door.** `POST /api/actions/:name`, where `:name` is the FULL action name
`<pluginId>.<local>` (e.g. `core.terminals.rename`). The body is the action's own argument
object; the answer is always HTTP 200 carrying `ActionOutcome`. The ladder is MONOTONIC and
stops at the first rule that fires:

| Order | `rule`            | Fires when                                                                                                                                                                     |
| ----- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | `unknown_action`  | no composed action carries that name                                                                                                                                           |
| 2     | `plugin_disabled` | the owning plugin is disabled in this workspace — SKIPPED for actions declared `cleanup: true` (D12: removal survives a disable; `core.terminals.kill` is the wave-1 occupant) |
| 3     | `forbidden`       | the caller is pad-scoped (`padScope !== null`) — message "scoped tokens cannot invoke workspace actions"; actions are workspace-grade this wave                                |
| 4     | `forbidden`       | the caller lacks one of the action's DECLARED caps (intersection at the door, not inside the handler)                                                                          |
| 5     | `invalid_args`    | the body fails the action's `input` schema                                                                                                                                     |
| 6     | `refused`         | the handler refused on domain grounds and named the reason (e.g. `essential`)                                                                                                  |

Order matters: a caller must not learn that an action exists and is forbidden before the cheaper
facts (existence, enablement) are settled, and a handler never sees unvalidated arguments. A
handler's result is validated against the action's `result` schema; a mismatch is a server fault
(500), never a denial. Every dispatch emits one structured log line (`evt:"action"`).

**Enablement is workspace-global and hot.** `core.plugins.setEnabled { id, enabled }` (cap
`plugins:manage`) flips a server-persisted flag (`meta` key `plugins:disabled`, a JSON array of
ids) and the server pushes the new roster to every open socket; clients rebuild live, with no
reload. A manifest may declare `essential: true`, and disabling it is refused (`refused`, message
`essential`) — wave 1 marks only `core.shell`. Composition KEEPS a disabled plugin's
contributions in its registries and reflects the disabled set only in `roster[].enabled` and
`composition.enabled(id)` (false for unknown ids too): that is what lets the ladder tell
`plugin_disabled` from `unknown_action`, and lets a placeholder NAME the plugin it is standing
in for. Manifest, capability-subset and uniqueness validation runs across every registered
plugin whether enabled or not, so disabling can never mask a collision. A disabled or unknown
contribution renders an inert placeholder, on canvases and in the workspace tree alike.

**Disable semantics: creation and administration die, cleanup survives.** Disabling
`core.terminals` refuses new `terminal_open` over the session channel
(`error { code:"forbidden" }`, "terminals plugin disabled") and refuses its administrative
actions, but attach/detach/input and `terminal_kill` on EXISTING sessions keep working: a user is
never locked out of removing something that already exists. Every plugin that creates durable
things follows that shape.

**Workspace layout.** Each principal has a `TileLayout` of their own, stored under `meta` key
`layout:<principalId>` and read at `GET /api/layout` (`DEFAULT_WORKSPACE_LAYOUT` when unset). Its
leaves are `{ kind:"panel", panelId }` surfaces — the shell IS a composition, rendered by the
same `TileTree` a tiled pad uses, so there is one tree vocabulary everywhere. The ONLY writer is
`core.layout.set { layout }` (self-targeted; the ladder already refuses pad-scoped tokens), and
its validation is STRUCTURAL ONLY: `validateTileLayout` plus "every leaf surface is a panel".
Unknown or disabled panel ids are ACCEPTED — a disabled plugin must never brick layout writes —
and those leaves render placeholders whose chrome offers a remove control that commits the pruned
tree through the same action. Divider drags obey the plane rule: local optimistic ratios per
frame, ONE `core.layout.set` at the commit point, never one per frame.

**Deleted with this wave, with no aliases and no dual paths:** `PATCH /api/terminals/:id` and
`DELETE /api/terminals/:id`. Their replacements are the actions
`core.terminals.rename { sessionId, name }` and `core.terminals.kill { sessionId }`, both cap
`pads:write` (exactly the routes' own requirement), with the routes' semantics verbatim — the
rename broadcasts `session_event { kind:"renamed", name }` into the home; the kill sweeps the
session, its home, and every portal onto that home. `GET /api/terminals` stays. Mutating
affordances in the DOM carry `data-action="<action name>"`, which is how the gate proves the UI
and the API share one door.

**`manifold://` addressing.** One canonical serialization of the addressing algebra, bijective
with the structured wire forms (`parseManifoldUri` / `formatManifoldUri`,
`packages/protocol/src/uri.ts`). Seven forms; every id segment is percent-encoded:

```
manifold://pad/<padId>
manifold://pad/<padId>/element/<elementId>
manifold://pad/<padId>/tile/<tileId>
manifold://terminal/<sessionId>
manifold://principal/<principalId>
manifold://plugin/<pluginId>
manifold://action/<actionName>
```

An unknown scheme or shape parses to `null` — nothing guesses. `GET /api/resolve?uri=` answers
`ResolveResponse { uri, ref, exists, title }`, the round trip that turns a reference into
something an agent can name; `/uri/<encoded>` is the browser deep link onto the same grammar.
Grants, spotlights, and (from wave 2) event topics all name nodes this way.

## WS /ws/session — session channel (JSON text frames)

**Frame grammar (v14).** One socket per tab, many rooms. Every frame is either
connection-level or channel-level:

```
connection-level   client → server  {"type":"ping"}
                   server → client  {"type":"pong"}
                   server → client  {"type":"plugins","roster":[…]}
channel-level      both ways        {"ch":"<channelId>","type":"…", …}
```

A CHANNEL is one client-chosen handle onto one room. `ch` matches
`/^[A-Za-z0-9_-]{1,64}$/` (both halves splice `{"ch":"c7",` in front of ONE shared body
serialization, so an id needing JSON escaping would be a correctness hole rather than a
slow path), is unique per connection, and is deliberately NOT a pad id: two channels on
one socket may address the SAME pad with different roles (an occupant view and a widget's
watching preview), so a pad-keyed channel would be an id pun that collides. Liveness is a
property of the socket, so ping/pong carry no `ch`. `@manifold/protocol` publishes each
frame twice from the same shapes — a channel-less BODY union and the wire union that adds
`ch` — because a broadcast validates and serializes one body and tags it per peer.

**Connection frames address the SOCKET, not a channel.** `@manifold/protocol` publishes them as
`CONNECTION_BODIES` beside the channelized `SERVER_BODIES`, and they carry no `ch` because the
thing they concern is the connection itself. `plugins { roster }` is the first such
server→client frame: it is delivered once when the socket opens (before any `join`) and again
whenever the roster changes, which is what makes enable/disable hot for every open tab. The SDK
pool demultiplexes connection frames to pool-level listeners (`SessionClient.onPlugins`, which
replays the latest roster to a late subscriber) instead of dropping them as frames for an
unknown channel.

Handshake: the FIRST client frame on a connection MUST be
`join { ch, padId, token, protocolVersion, spectator?, lastEpoch?, lastRev? }`; the server
answers `init { ch, protocolVersion, epoch, rev, doc, roster, sessions, self, selfCaps,
selfConnId }` on that channel. The ten-second join deadline is re-armed whenever the last
channel leaves: a socket MUST carry at least one room to stay open, and an idle connection
is indistinguishable from one that never joined. Resume hints (`lastEpoch`/`lastRev`) ride
each channel's own join, so a reconnect redials ONE socket and rejoins every channel on
it; a mismatch simply yields a full init. `leave { ch }` frees one channel while every
other keeps streaming — a client closing its LAST channel closes the socket instead,
because the close already means "leave everything". `selfConnId` identifies the CHANNEL and
changes on every join (a role swap is `leave`+`join` on one socket, never TCP churn);
roster keying, cursor echo-suppression, and the terminal viewer registry hang off it
exactly as they hung off a socket before v12. `doc` is the base64-encoded full Yjs state
update for the room. `selfCaps` mirrors the joining principal's granted caps so clients can
gate UI affordances without a separate introspection round-trip. Presence is carried by
`roster`, whose entries are `PresenceState`; there is no separate `presences` field.

**Refusal scope.** A refusal closes the whole SOCKET when it invalidates the credential or
the framing itself, and ONE CHANNEL — a `channel_closed { code, reason }` frame, socket
untouched — when it concerns one room:

| Code      | Scope   | Cause                                                                                                                   |
| --------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| 4401      | socket  | bad token                                                                                                               |
| 4403      | socket  | forbidden, or revoked (a revocation fences every live connection of that principal)                                     |
| 4409      | socket  | protocol version mismatch                                                                                               |
| 4002      | socket  | malformed frame of a KNOWN type, non-`join` first frame, duplicate `ch`, or the join deadline elapsing with no channels |
| 4404      | channel | unknown pad at join; a DELETED pad closes every channel of its room with the same code                                  |
| 4429      | channel | `MAX_SESSION_CHANNELS_PER_CONNECTION` (64) already held                                                                 |
| 1009      | channel | that room's `init`/`resync` state exceeding the 16 MiB transport payload ceiling                                        |
| 1013      | channel | that channel's outbound queue overflowing (256 frames or 1 MiB, per channel)                                            |
| 1009/1013 | socket  | one frame exceeding the transport ceiling, or the socket refusing a write — transport failures no single room can heal  |

Killing a whole tab because one widget pointed at a deleted pad is precisely the blast
radius multiplexing exists to remove. A frame naming a channel this connection no longer
holds is logged and dropped: a frame can legitimately be in flight while the server retires
its channel, and that race must not kill the rooms still healthy on the socket. Unknown
frame TYPES stay forward-compatible (logged and ignored). Outbound bounds are PER CHANNEL
exactly as they were per socket before multiplexing, so N rooms behind one connection
buffer what N connections did; `init`/`resync` are authoritative and bounded by the
transport rather than by the flood queue, and a queued `resync` supersedes any earlier one.
Throttle state (cursor, gesture, resync cadence) is per channel because the cadences it
enforces are per room, and Bun's drain callback flushes channels in rotation so one chatty
room cannot monopolize the shared socket buffer.

**Spectators.** `spectator: true` joins a channel that WATCHES the room without occupying
it (absent ≡ occupant). A portal widget's resting preview uses it: the widget IS a real
channel into another container, and counting that as membership faked occupant avatars. A
spectator receives `init`/`resync`, `doc_update`, roster/presence/cursor fan-out and
terminal snapshots and output, and may send `leave`, `resync_request`, `ping`,
`terminal_attach` and `terminal_detach`. Every other client frame is refused with
`error { code:"forbidden" }` — a preview never writes. Spectators appear in NO roster and
in NO `GET /api/pad-presence` entry; a room holding watchers alone still counts as resident
for eviction. Engaging a widget swaps that channel to an occupant join, so watching versus
engaged is a socket role rather than a UI mode anyone has to learn.

### Scene sync (Yjs CRDT)

- Each room holds one canonical `Y.Doc`. Its `elements` map contains strict portal, text,
  and draw records from `@manifold/protocol` — the terminal element kind is RETIRED, so a
  canvas holds furniture and REFERENCES only; a removed element is absent rather than
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
- **Container discipline.** A pad row carries `layout: "canvas" | "tiled"`; both
  disciplines share the room/doc machinery, and the two are lenses on ONE container object.
  A tiled container (a "composition") stores its tile tree in the doc's `layout` map
  (`LAYOUT_KEY`): nodes are splits (`dir` row/column, parallel `ratios`/`children`,
  `surface` null) or leaves whose `surface` is `{ kind:"terminal", sessionId }`,
  `{ kind:"pad", padId }` (an embedded canvas — never the container itself), or
  `{ kind:"text", elementId }` (a note the composition's OWN document stores, so placing a
  note into a composition MOVES the element instead of referencing it across two docs). The
  fourth surface kind, `{ kind:"panel", panelId }`, belongs to WORKSPACE layouts only: a room
  document never carries one, and the placement algebra refuses `panel` items into any
  container (`not_accepted`). `validateTileLayout` gates every read: root exists, child
  references resolve, nothing is reachable twice, ratios stay parallel to children, surfaces
  sit on leaves only, and a container never tiles itself; unreachable nodes are inert garbage
  the next structural write prunes. Ratio drags are CRDT writes (`setTileRatios` through the
  SDK); every STRUCTURAL mutation is HTTP — `POST /api/place` and the one leaf-removal
  route — applied under `SERVER_PLACE_ORIGIN`, which client undo managers never track.
- **Portal elements.** A canvas record `{ type:"portal", containerId, ...geometry }` renders
  another container in place. This is also how a TERMINAL appears on a canvas: the portal
  points at the composition the session lives in, so one element kind covers both. Nesting
  renders live to depth 2 (the routed canvas is depth 1, so its portals show their
  containers' tiles) and as a navigable card deeper — a live chain would open a room channel
  per level. Cycles are legal: portals navigate on enter, they never recurse live. A portal
  onto a SOLO composition renders ELEMENT-CHROME-FIRST (`flow-portal--mono`): the item's own
  titlebar IS this node's chrome, there is no widget name strip, and the resize floor is the
  item's. A multi-tile widget keeps its name strip as the React Flow drag handle, and a tile
  titlebar drag inside it EXTRACTS that tile rather than moving the node.

### Presence (ephemeral, never persisted)

- `presence { payload }` where payload is a partial of
  `{ cursor: {x,y} | null, selection: string[], viewport: {x,y,zoom}, focus: {elementId} | null, status: "active"|"idle"|"working"|"waiting"|"needs_attention"|"done", view: {…} | undefined, spotlight: {…} | null }`.
- **View state is presence** (axiom A2: per-user view state is observable AND drivable).
  `view { tool?, editingElementId?, focusedContainerId?, sidebarCollapsed? }` is written by the
  CLIENT through the same throttled presence writer as every other field and dies with the
  connection, so a peer can see which tool somebody holds, what they are editing, and whether
  their sidebar is open. It is descriptive, never authoritative: nothing downstream branches on
  whose view it renders.
- **`spotlight { uri, from }` is SERVER-written only.** The server strips `spotlight` from any
  client payload; the sole writer is the action `core.presence.focus { targetPrincipalId, uri }`
  (cap `scene:write`), which requires that the target shares a joined room with the caller and
  that the caller holds `scene:write` on that room, and which is throttled to one per 2s per
  (caller, target). The recipient's client centers on `uri` with a source chip and a dismiss,
  and a device-local kill switch (`manifold:ignore-spotlight`) ignores spotlights entirely:
  driving someone else's view is consented, rate-limited, and attributable, or it does not
  happen.
- `cursor { x, y }` is its own high-rate message: clients throttle to
  `CURSOR_MIN_INTERVAL_MS` (16ms) and the server re-applies the same cadence per channel,
  retaining only the newest (latest-wins) and dropping under backpressure. `gesture
{ kind, phase, elementId, x, y, width?, height?, points?, carry? }` carries ephemeral move,
  resize, freehand, and CARRY previews at the same cadence; the server stamps
  `principalId`/`connId`, relays it, and never persists it. `phase:"end"` is never throttled
  and hands rendering back to the durable Yjs element; a stale override expires after
  `GESTURE_TTL_MS` (3s) even when its end frame is lost. `carry` is motion as the dynamic
  half of the placement algebra: one gesture kind for anything grabbed by its chrome, naming
  the `PlacementSurface` in flight plus the label it carried at grab time — a viewer often
  cannot derive that label, because the item belongs to a room it has not joined. All other
  presence fields send on change only; viewport ≤1Hz.
- **Cursor coordinate space is the room's discipline.** Cursors are container-scoped
  (per-room, like all presence): canvas rooms carry React-Flow scene coordinates; tiled
  rooms carry fractions of the view's tile area in `[0,1]²` (ratios are shared CRDT
  state, so a fraction resolves to the same tile for every viewer regardless of window
  size). Receivers clamp to the unit square. The workspace shell is not a room: its panels
  carry no cursors and there is no workspace-level cursor channel. What another principal sees
  of a peer's shell is the `view` payload above, relayed per room like the rest of presence.
- Roster: `init.roster` lists occupying principals; server broadcasts
  `roster { joined?, left? }` deltas. Presence for a principal dies with its last channel
  in that room.
- Several memberships per principal are legal (tabs, and several rooms per tab); roster
  entries are per principal with a membership count and the exact live `connIds`. Cursor and
  gesture frames are stamped per-membership, so viewers retire a closed tab's cursor from
  `connIds` — pruning by principal alone strands ghost cursors while sibling tabs remain —
  and disambiguate sibling-tab cursor labels ("name (2)") from the same shared order.

### Terminals over the session channel

- `terminal_open { elementId, cols, rows, cwd?, machineId?, placement? }` → server targets
  `machineId` when given (error `no_machine` if it is unknown or offline); without it the
  server falls back to the sole online machine (error `no_machine` when zero or several are
  online — clients with a picker, like the web menu, pass `machineId` explicitly).
  Discipline decides who authors the placement, and a mismatch is refused (`conflict`)
  rather than spawning a PTY no surface would ever show: on a CANVAS the opener authors the
  element (`placement` absent ≡ `"element"`), and in a COMPOSITION the container places the
  leaf itself (`placement: "tile"`).
- **A terminal is born with a home** (`homed: "eager"`). The home id is minted BEFORE the
  PTY, because the session-scoped agent token and the `MANIFOLD_PAD` a program inside the
  terminal reads must both name the container the terminal LIVES in — and a canvas is never
  that. A tiled opener IS the home; a canvas opener gets a fresh solo composition whose ROW
  is created when the PTY lands, so a create that never lands leaves nothing behind to clean
  up. The server mints a **session-scoped agent token** (caps
  `[pads:read, scene:write, terminal:spawn, terminal:write]`, scoped to the HOME), asks the
  agent to create the PTY with env `MANIFOLD_URL`, `MANIFOLD_PAD` (the home),
  `MANIFOLD_ELEMENT` (canvas openers only), `MANIFOLD_TOKEN` injected, then replies
  `terminal_opened { elementId, session, ref? }`. `elementId` is the PLACEMENT: the
  server-authored leaf id for a tiled opener (whose `ref` echoes the opener's correlation
  token, sent only to that opener), else the opener's own element id. `session.padId` is the
  home either way. The fan-out (`terminal_opened` plus `session_event { kind:"opened" }`)
  goes to the HOME's room, never the opener's — nothing about a session is canvas state any
  more. A canvas opener then authors ONE portal element onto `session.padId` through
  `client.transact`: the server never authors an element for `terminal_open`. Placement is
  the one place the server DOES write canvas elements, and it does so only through
  `POST /api/place`, under `SERVER_PLACE_ORIGIN`.
- **Terminal frames travel over the home composition's channel.** Every terminal frame
  (`terminal_attach`, `terminal_input`, `terminal_resize`, `terminal_take`, `terminal_kill`)
  resolves its session only when `session.padId === peer.padId`; anything else is
  `error { code:"not_found" }`. A canvas showing a terminal through a portal therefore joins
  the home's room on its own channel instead of streaming terminal bytes over the canvas's.
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
- **Client-side view pairing.** The viewer registry above is **channel-scoped** (one
  `Viewer` per room membership, which before v12 was one per socket). A client presenting
  several views of one session on that channel sends `terminal_attach` on EVERY view-attach:
  the server replaces the channel's viewer and re-emits snapshot(S′)+outputs(S′+1…), which
  is a late view's only path to existing screen state (frames fan out to all local views;
  each re-renders from the fresh snapshot). `terminal_detach` is refcounted and fires only
  on the 1→0 transition — a raw detach from one view starves every other view on that
  channel. The SDK owns this (plus re-attach after reconnect, since the registry dies with
  the channel); components just pair attach/detach per view. Guarded by SDK contract tests.
- `terminal_input { sessionId, data }` (data base64) — accepted only from the current
  **controller**; others receive `error { code:"not_controller" }`.
- Controller lease: opener starts as controller; `terminal_take { sessionId }` transfers
  it to any principal with `terminal:write` (event `session_event { kind:"controller_changed",
controllerId }`). Controller-only: input, `terminal_resize` (broadcast as
  `session_event { kind:"resized", cols, rows }` so every viewer refits), `terminal_kill`.
- Kill authorization: the current **controller**, OR any holder of the wildcard
  capability (`*`), may send `terminal_kill` for a RUNNING session; other principals
  receive `error { code:"forbidden" }`. An EXITED session has no controller, so there is no
  lease to win: `terminal:write` on the home is enough to dismiss it, and the dismissal is a
  kill (see the lifecycle predicate). Unlike input/resize/take, `terminal_kill` is therefore
  never `conflict` on an exited session. An exited session whose home no longer holds a leaf
  for it (a client rewrote the layout document directly) is pruned on the next init/resync of
  that home.
- **Unplaced terminals.** `SessionInfo.padId` is the composition the terminal lives in —
  never a canvas, never null, so "unbound" is not a state a session can be in. There is no
  pool: what parking used to mean is now `unplaced`, which says that nothing REFERENCES that
  home, and it is DERIVED from the containment graph on every read rather than stored — so
  releasing and re-placing a terminal leaves no state behind to go stale. `GET
/api/terminals` lists EVERY terminal as
  `{ id, machineId, name, createdAt, status, exitCode, homeId, unplaced }`. The pool's
  durable `sort_order` is retired with it: an unplaced terminal's position is its home
  composition's position in the one pad tree.
- Terminals carry a durable nullable `name`, renamed through the action
  `core.terminals.rename { sessionId, name }` (cap `pads:write`); the new label broadcasts into
  the home as `session_event { kind:"renamed", name }`, where every titlebar and index row picks
  it up without a refetch. Labels everywhere are `name ?? machine name`.
- `output { sessionId, seq, data }` streams to all LIVE viewers; `session_event
{ kind:"exited", exitCode }` on a PTY that stopped ON ITS OWN. Such a terminal stays listed
  (status `exited`, real code) with its leaf and every portal onto its home intact, so the
  exit code stays readable until somebody kills it. A KILL broadcasts no `exited` event: the
  leaf and the portals vanish through the documents instead, which is how viewers learn the
  terminal is gone rather than dead.
- `session_event { kind:"parked" }` keeps its pre-cutover name and now means exactly "this
  session left THIS room": it fires in the OLD home when a merge or an extraction re-homes
  the session, paired with `terminal_opened` carrying the new leaf in the new home, and
  UNPAIRED when a kill reaps the session — it left every room. Clients drop the row from
  their session listing on it, which is what makes a kill visible at once rather than at the
  next resync. Nothing is parked anywhere — the frame is a departure notice, not a state.
- Session ids are opaque. A session's placements are read from live containers (portal
  elements and tile leaves), never from the session row: one session can be referenced from
  many canvases at once, so no single `elementId` could describe it. Text and draw elements
  never reference terminal sessions. Session protocol v14.

## WS /ws/machine — machine channel (JSON; `data` fields base64)

Handshake: agent sends `hello { token, name, agentVersion, protocolVersion, sessions }`
where `sessions` advertises retained PTYs
`{ sessionId, cols, rows, alive, seq, exitCode? }` (server-restart adoption). An
`alive:false` advertisement reports a real `exitCode` when the PTY exited while
disconnected; absence is equivalent to `null`. Such exited sessions are retained through
the next `hello`, then forgotten when `welcome` acknowledges it (or when `kill` arrives).
Server replies `welcome { machineId, serverEpoch }` or closes: 4401 unauthorized,
4403 revoked, 4409 version. Version acceptance is the
`MACHINE_PROTOCOL_COMPAT_VERSIONS` set `{2…14}` (protocol/version.ts), NOT strict equality:
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
pads(id TEXT PK, name TEXT, created_at INTEGER, sort_order INTEGER, folder_id TEXT,
     layout TEXT NOT NULL DEFAULT 'canvas')            -- discipline: canvas | tiled
pad_folders(id TEXT PK, name TEXT, created_at INTEGER, parent_folder_id TEXT,
            sort_order INTEGER)
scene_docs(pad_id TEXT, epoch TEXT, rev INTEGER, ts INTEGER, hash TEXT, doc BLOB,
           PRIMARY KEY (pad_id, epoch, rev))          -- keep newest 30 valid docs per pad
events(id INTEGER PK AUTOINCREMENT, pad_id TEXT, ts INTEGER, principal_id TEXT,
       type TEXT, payload TEXT)                       -- lifecycle/caps/join-leave ONLY
principals(id TEXT PK, kind TEXT, name TEXT, color TEXT, created_at INTEGER)
tokens(id TEXT PK, hash TEXT UNIQUE, principal_id TEXT, caps TEXT, pad_id TEXT,
       created_at INTEGER, revoked_at INTEGER, minted_by TEXT)  -- HASH only, never raw
machines(id TEXT PK, name TEXT UNIQUE, token_id TEXT, last_seen INTEGER)
sessions(id TEXT PK, machine_id TEXT, pad_id TEXT, created_by TEXT, status TEXT,
         exit_code INTEGER, created_at INTEGER, agent_principal_id TEXT, name TEXT)
                            -- pad_id IS the home composition; no element_id, no pool order
meta(key TEXT PK, value TEXT)                         -- schema_version, plugins:disabled,
                                                      -- layout:<principalId>
```

Schema version 9. A migration is SQL, or CODE when the move is not expressible as SQL:
migration 9 (solo compositions) rewrites Yjs documents — every `terminal` element becomes a
`portal` onto a newly created solo composition, keeping id, geometry and z-order so
collaborators' element references survive; a session already living in a tiled container was
already homed and is left alone; the retired pool position becomes its composition's
position in the pad tree; then `pads.transient`, `pads.origin_pad_id` and
`sessions.sort_order` are dropped. A code migration declares whether it is recoverable, and
a one-way data move is not: this one takes a consistent `VACUUM INTO '<db>.pre-v9.bak'`
snapshot BEFORE its transaction opens (a VACUUM cannot run inside one, which is also what
makes it a true pre-migration image), skipped only for an in-memory or not-yet-existing
database.

The server snapshots a full encoded Yjs document 1.5s after the last change, at least every
10s under sustained edits, on room eviction, and on graceful shutdown. Loading scans the
newest retained documents and skips corrupt entries. Terminal bytes, presence, cursor,
gesture, and carry frames NEVER touch SQLite.

## Testability (agent-facing)

- **Debug seam** (`packages/web/src/debug-seam.ts`): when `localStorage["manifold:debug"]
=== "1"`, the active container renderer installs `window.__manifold` — READ-ONLY snapshot
  functions (`scene()`, `canvas()`, `outbox()`, `gestures()`, `rev()`, `epoch()`,
  `viewport()`, `renders()`) exposing the browser-canvas↔SDK projection boundary to
  automation. No
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
