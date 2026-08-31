# Cross-package contracts

This file is the integration authority for manifold's packages. Any change here requires
updating `@manifold/protocol` first, then every consumer, in the same change.
Wire message shapes live in `packages/protocol/src` (zod schemas are the source of truth;
this document explains semantics the schemas cannot).

## Topology

```
browser (web) ──┐
agent SDK ──────┼── WS /ws/session ──► manifold server ── SQLite (data/manifold.db)
tools/tests ─────┘                            ▲
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
last container used by that principal on this device, falling back to the first visible
container; `/p/<containerId>` remains the canonical deep link, and it renders the canvas or
the composition renderer according to that container's `discipline`. Both routes render one
persistent browser
shell with a collapsible, resizable sidebar and the active container—there is no separate
container-list route. The sidebar is the owner-visible workspace INDEX, and it is ONE index:
canvases, compositions, and the terminals that live in them are rows of the same tree
(titled "Index"), with folders over all three, because both disciplines are lenses on
one object and a row's glyph carries the difference. A solo composition wears its terminal's
name, mark and actions — a composition of one IS the item it holds — and renaming that row
renames the TERMINAL. The sidebar is itself a plugin panel (`core.shell.sidebar`) and its
sections are manifest contributions — each plugin declares
`sections: [{ id, title, order }]` — so the stack's ORDER is workspace vocabulary rather
than device memory. Folder membership and tree order are durable server state; sidebar WIDTH
is the workspace layout's root ratio (`core.space.setLayout`), collapse is presence
(`vantage.sidebarCollapsed`, with a device-local mirror for first paint), and terminal-row
visibility plus folder expansion stay device-local (`AXIOMS.md` §Device-local register). The
server SPA-fallbacks every non-`/api`, non-`/ws`, non-`/healthz` GET to `index.html`. The URL
fragment is reserved for `#key=<owner-key>` bootstrap and is stripped by the client after
storing it.

Canvas resize affordances differ by element on purpose. A canvas portal is a window: a
portal's frame border is a grab zone under the select tool (the same 8px edges and 14px
corners a terminal's frame carried), so hovering it shows the OS resize cursor and a drag
resizes with no selection step, and the controls carry no paint of their own — a mono portal
reads as the terminal it holds, down to using the terminal's size floor instead of the
portal's. Text and freehand keep the classic contract — no handles until the element is
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
- Caps: `*`, `containers:read`, `containers:write`, `scenes:write`, `terminals:spawn`,
  `terminals:write`, `tokens:mint`, `machines:mint`, `plugins:manage`. Reads of scene and
  presence come with `containers:read`. `terminals:write` covers input+resize+kill+take on
  terminals in scope. `plugins:manage` authorizes plugin administration only — the engine
  doors `engine.plugins.setEnabled` and `engine.plugins.purge`.
- Token scope: optional `containerId` restricts everything to one container.
- Revocation: durable; server closes live sockets of revoked tokens with code 4403 and
  message `revoked`.

### Authority (planned)

Today's model is flat and stays flat this wave: a token carries a `Cap[]` plus an optional
`containerScope`, and `AuthContext.allows(cap, containerId)` answers every authority question.
That is
deliberately the DEGENERATE case of the ratified design in
`docs/decisions/0011-permission-waterfall.md`, where authority is a waterfall of grants on
the node tree — `{ principal | class, node: "manifold://…", caps, effect, reach }` evaluated
root→node, deeper beating shallower, `deny` beating `allow` at equal specificity. Today's cap
array is a synthesized root grant; today's `containerScope` is a subtree grant at
`manifold://container/<id>`; a share will be a minted token bound to a subtree grant.
`packages/server/src/auth.ts` is the tagged evaluator call surface (`AXIOMS.md` floor
registry): the
evaluator replaces ONE call surface and the action door's declared-capability intersection
sits unchanged on top of it.

Principals reserve a future `origin` notion — which instance a principal belongs to — for
cross-instance sharing. Wave 1 writes no such field, and the SDK's channel pool is
conceptually keyed by `(origin, containerId)` with origin fixed to this instance, so wave 3 supplies
real origins without re-keying anything (`AXIOMS.md` §Roadmap).

## HTTP API (JSON; `Authorization: Bearer <token-or-owner-key>`)

| Method+Path                              | Auth cap              | Req → Res                                                                                                                                      |
| ---------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| GET /healthz                             | none                  | → `{ ok, version, protocolVersion, build? }` (`build` is the git SHA baked at build time)                                                      |
| GET /api/protocol                        | none                  | → generated JSON-Schema of all wire messages, plus the published placement vocabulary and the plugin/action vocabulary                         |
| GET /api/attendance                      | containers:read       | → `{ attendance: [{containerId, principals}] }` for currently connected OCCUPANTS; scoped tokens see only their container                      |
| DELETE /api/containers/:id/tiles/:tileId | containers:write      | → `{ ok }`; removes ONE leaf (not a placement). A terminal's last leaf reaps the terminal; an emptied composition retires                      |
| POST /api/actions/:name                  | per action (declared) | action args → 200 `ActionOutcome`: `{ok:true,result}` or `{ok:false,denial:{rule,message}}`. Refusals are DATA, never non-2xx. THE action door |
| GET /api/plugins                         | any token             | → `PluginRoster` (manifests, `enabled`, `source`, action summaries). Container-scoped tokens included: the roster is vocabulary                |
| GET /api/layout                          | any token             | → `{ layout }` — the CALLER's workspace `TileLayout`, or the injected default tree when unset. Self-scoped by construction                     |
| GET /api/resolve?uri=                    | containers:read       | → `ResolveResponse { uri, ref, exists, title }`; an unparseable or non-`manifold://` uri is 400 `invalid`                                      |
| GET /api/containers                      | containers:read       | → `{ containers: ContainerCensus[] }` (`ContainerCensusResponseSchema`) — what every container holds and points at; the index's whole input    |
| GET /api/introspect                      | `*`                   | → live rooms/terminals/machines/principals snapshot                                                                                            |

`IndexEntry` is either `{ kind:"container", container:{ id, name, createdAt, discipline },
parentId: string|null, sortOrder: nonnegative integer }` or `{ kind:"folder", id, name,
createdAt, parentId: string|null, sortOrder: nonnegative integer }`. An index move's `entry` is
exactly `{ kind:"container", id }` or `{ kind:"folder", id }`, and `index` is a nonnegative
integer. `ContainersResponseSchema` is the flat container LIST (`{ containers: Container[] }`);
the census route above answers `ContainerCensusResponseSchema`, and the two are different reads
of the same rows.
Every WORKSPACE-WIDE door rejects container-scoped tokens even when they hold the cap: index
organization, the terminal index, the container census, the placement door, leaf removal, and every
action whose `scope` is `"workspace"` (`POST /api/actions/:name` refuses `containerScope !== null`
with denial `forbidden`, message "scoped tokens cannot invoke workspace actions"). A placement moves
items between containers, so a token scoped to one container can never authorize it; finer per-node
scoping arrives with the permission waterfall (§Authority (planned)).

**But a door's audience is declared, not inferred from whether it mutates.** An action declares
`scope: "container"` if and only if the door it replaces was reachable by a container-scoped
token — reads
(`core.index.read`, `core.terminals.listByContainer`, `core.machines.list`) and mutations
(`core.terminals.open`/`rename`/`take`/`kill`, `core.index.renameContainer`,
`core.access.mint`/`revoke`)
alike. `scope: "container"` skips ladder rung 3 and creates an obligation with an exact division
of
labour: the ladder proves the caller's caps hold for the caller's OWN container, and only the
handler can
prove the thing NAMED in the arguments lives there. That check is the ENGINE's, called once per
handler — `ctx.outsideScope(containerId)` answers the canonical refusal `OUTSIDE_SCOPE_REFUSAL`
("outside this token's container") or `null` — so one concept has one wording a client can switch
on. It never names the target container (a scoped caller learns nothing about a container it may
not
reach), and a `null` container is refused for a scoped caller while passing for a workspace-grade
one.
Two other discharges are legitimate: the mechanism itself (attenuation already refuses a mint that
widens its minter's scope), or vacuous when nothing in the answer is container-addressed (the
machine
list) — but any door whose arguments or payload name a container-addressed node owes the check.
Conversion may never narrow who may call a door
(`docs/decisions/0013-plugin-behavioral-contract.md` §15). `GET /api/plugins` and `GET /api/layout`
are open to scoped tokens by construction: the roster is global vocabulary, and a layout read is
self-scoped.

Delegation is attenuation-only: a minted token's caps MUST be a subset of the minter's
caps (root's `*` covers everything); minting `*` itself requires `isRoot`. Violations are
`forbidden`. This kills privilege escalation through `tokens:mint` chains.

`*` in the auth column means the wildcard capability itself (root/owner) — scoped tokens
can never satisfy it. The server computes an `AuthContext { principal, caps, containerScope,
isRoot }` ONCE at the auth boundary (`isRoot` ⇔ caps contain `*`); root-only routes check
`isRoot`, scoped routes use `hasCap()` — never a wildcard sentinel comparison inline.
Machine enrollment requires `machines:mint`; ordinary `scenes:write`/`terminals:write`
tokens must be rejected (covered by e2e: owner succeeds, `machines:mint` token succeeds,
delegated scene/terminal token is denied).
Errors: non-2xx with `{ error: { code, message } }`. Codes: `unauthorized`, `forbidden`,
`not_found`, `invalid`, `conflict`, `internal`. A refused PLACEMENT is not an HTTP shape at all any
more: it is the action door's `refused` rung, carrying the rule that refused as the message's
leading class (below).

## Containers, placement, and the index

A container has one of two disciplines — `canvas` or `composition` — and is ONE object either
way. Everything that lands in one
goes through a single door — the action **`core.space.place`** — and its legality is DATA in
`packages/protocol/src/placement.ts`, published to agents and mods through `GET /api/protocol`.
The verb routes it replaced (bind, park, add-tile, compose, extract, expand, pin) are DELETED, not
deprecated: expand had nothing left to create once every terminal already lived in a composition,
and pin had nothing left to claim once no container dissolved under anybody.

Legality is data and the executor is floor; the VERB is a plugin's (`core.space.place`, cap
`containers:write`, `scope: "workspace"` — a placement genuinely spans containers). `POST /api/place` is
deleted, not aliased, and the refusal vocabulary did not fork: the placement rule that refused
travels in the action's denial, so `not_accepted` keeps one wording
(`docs/decisions/0013-plugin-behavioral-contract.md` §14). Leaf removal is not a placement —
nothing accepts "nowhere" as a destination for a leaf — so a leaf is still addressed directly by
its own door while every MOVE of its occupant goes through the action.

**Vocabulary.** Item kinds declare the capability GROUPS they belong to, container kinds
declare the groups they accept, and the only imperative rules are three enumerated guards.
Every nesting rule is therefore DERIVED from the tables rather than branched on in an
executor — "compositions never nest" IS the absence of `tileable` from the `composition`
declaration — and every refusal names the declaration that refused it. A plugin contributing an
element kind declares the same three traits (`groups`, `guards`, `homed`) in its manifest, and
`assembleRoster` resolves them into the element registry (defaulting to
`DEFAULT_ELEMENT_PLACEMENT_TRAITS`), so the table below is the closed union's rows in the same
shape a contribution uses. The fusion has landed: `ITEM_KINDS` and `CANVAS_OPS` keep FLOOR kinds
only (`terminal`, `canvas`, `composition`, `tile`, `panel` — the `text` and `draw` rows are
deleted),
`PlacementItem.kind` and `CensusItem.kind` are open strings, and resolution reads
`ITEM_KINDS[kind] ?? lookup.itemTraits(kind) ?? DEFAULT_ELEMENT_PLACEMENT_TRAITS`. A non-floor
kind's canvas op is `move_element`, decided by `canvasOpFor` — the canvas operation stays a floor
table, never manifest data. Every closed wire literal here is `snake_case`, which is the whole
casing rule: `canvas_item`, `no_self_embed`, `on_claim`, `add_tile`.

| Item kind     | Groups                                                   | Guards                   | Homing   |
| ------------- | -------------------------------------------------------- | ------------------------ | -------- |
| `terminal`    | tileable, unplaceable, canvas_item_as_portal             | —                        | eager    |
| `canvas`      | tileable, embeddable, unplaceable, canvas_item_as_portal | no_self_embed            | inline   |
| `composition` | mergeable, unplaceable, canvas_item_as_portal            | no_self_embed, solo_only | inline   |
| `text`        | tileable, canvas_item                                    | —                        | on_claim |
| `draw`        | canvas_item                                              | —                        | inline   |
| `tile`        | extractable                                              | —                        | inline   |
| `panel`       | tileable                                                 | —                        | none     |

Containers: `canvas` accepts canvas_item, canvas_item_as_portal, extractable; `composition`
accepts tileable, mergeable; `unplaced` accepts unplaceable — "nowhere" is listed as a destination
so that releasing an item is a named op the algebra can refuse, not a request that quietly does
nothing. Both real containers carry the `discipline_match` guard. Destination forms name the
container kind that admits them and the discipline it requires: `canvas`→canvas,
`tile`→a composition, `compose`→a composition born on a CANVAS, `unplaced`→neither. `text` and
`draw` are CONTRIBUTED kinds shown here for reading only: their traits live in
`core.notes`' and `core.draw`' manifests, not in `ITEM_KINDS`.

**Homing** is how an item acquires the composition it LIVES in, and it is a property of the
KIND, never of a gesture: `eager` — the server births the home with the item, so a terminal
has one before its first byte of output and "where does this live" never has two answers;
`on_claim` — the item is born inline in whatever document created it (CRDT-instant, no round
trip) and its home row materialises inside the first placement op that needs one; `inline` —
the item needs no home, which covers canvas furniture and containers, a container BEING a
home.

**Wire shapes.** `PlaceRequest { ref, destination }`:

- `ref` — `{kind:"terminal", terminalId}` and `{kind:"container", containerId}` name an ITEM by
  identity; `{kind:"tile", containerId, tileId}` and `{kind:"element", containerId, elementId}`
  name one existing PLACEMENT of one, which is how a single mirror of a multi-placed terminal
  becomes addressable. `PlacementRef` and `TileRef` are the same addressing concept in two
  shapes — a placement subject and a leaf's occupant — and both are bijective with a
  `manifold://` URI (`ManifoldRef`), which is why the names rhyme. They are deliberately not
  interchangeable in storage: a note has no identity outside the document holding it, so it is
  addressed as an `element` and stored as a leaf's `text` ref, and the executor translates.
- `destination` — four forms: `{kind:"canvas", containerId, x, y}`;
  `{kind:"tile", containerId, targetTileId, edge}`, where a null target fills the first empty leaf
  else splits the root and a null edge fills an empty target else splits it;
  `{kind:"compose", containerId, targetElementId, edge}`; and `{kind:"unplaced"}`, which carries no
  position, because what used to be a pool with a durable order is now the top level of the
  one index.
- `PlaceResponse` is tagged by the `op` that ran: `portal` / `extract` / `move_element` →
  `{ elementId }`, `add_tile` → `{ tileId }`, `compose` → `{ containerId, tileId }`, `unplace` →
  `{ removed }`. Zero removed is a legal, meaningful answer — the item was already unplaced —
  and that is the difference between "already so" and the silent no-op the algebra refuses to
  have.
- A refusal is DATA, and it travels on the action door's `refused` rung: the message is
  `"<rule>: <ref kind> -> <container kind>"` (e.g. `not_accepted: terminal -> canvas`), whose
  leading class is a member of the published `PLACEMENT_DENIAL_RULES` and is read back by
  `placementRefusalRule(message)`. Rules are `not_accepted` (group containment failed),
  `self_embed`, `discipline`, `not_solo`, `unknown_ref`, `unknown_container`. Clients switch on
  the RULE; nobody parses the remainder. The SDK's `place()` keeps its signature and rebuilds the
  full `PlacementDenial` from the rule plus the ref it sent and `placementContainerFor(destination)`,
  because the caller already holds those. `PLACEMENT_DENIED_CODE` and
  `PlacementDeniedResponseSchema` are DELETED with the route — no
  `placement_denied` code exists anywhere — and the display noun for a kind has exactly one
  home, `ITEM_NOUNS` in `packages/plugin/src/item-noun.ts`, where a floor kind takes the
  floor's word and a contributed kind takes its manifest TITLE (`verify:axioms` S12 refuses a
  second such table). Operational impossibilities (a vanished terminal, a tree
  that rejects a write)
  travel as ordinary `not_found` / `conflict`, because they are not statements about what
  composes.

`resolvePlacement` is PURE and answers from a `PlacementLookup` the caller already holds, so
the server runs it against its rows and live docs and the browser against its props and its
own docs: legality cannot drift between a drag preview and the write that follows it. The
executor then resolves the ref's CURRENT location from identity, never from the request,
so a caller cannot lie about where an item was.

**The index.** `GET /api/containers` returns one
`ContainerCensus { containerId, discipline, items, references }` per container. `items` are what
it
holds DIRECTLY — occupied leaves for a composition, elements for a canvas, in the container's
own order, each classified with the placement algebra's own item kinds so a census answer and
a placement resolution can never disagree about what something is. `references` is the
forward edge of containment (portal elements, and `container` leaves). Inverting `references`
across every container yields:

> **INDEX VISIBILITY RULE.** The top level is HOMES and the HOMELESS. A container is a home
> and always shows. An ITEM shows at top level only while nothing holds it, because a placed
> item is already visible inside whatever holds it, and listing it twice would make the index
> a second, competing statement about where things are. A container no other container
> references is top-level; one with parents renders as a collapsed child under each of them.

A terminal is the only item with an index row of its own today (its home composition), and
`unplaced` from `core.terminals.listAll` is the server's own answer to "does anything reference
this?". `censusSolo(census)` — the item a container of ONE holds, else null — is exported
rather than inlined because that one line IS the paradigm: chrome, merging, and the index all
read it, and three subsystems deciding it separately is how they would come to disagree.

Census cost model: ONE route rather than a field on each container read, because the visibility
rule needs the containment GRAPH and a graph cannot be assembled from rows fetched one at a
time. Resident rooms answer from their live document (and drop their cache entry as they do);
every other container is decoded from its newest stored snapshot and cached AGAINST THAT
REVISION — so an idle workspace costs one query per container and a busy one costs only the
containers
that actually changed. A container with no stored document, or one whose snapshot fails to
decode, censuses as empty rather than failing the read.

**Solo-composition lifecycle.** There is no transient flag, no pin, and no expand. Entering a
composition is NAVIGATION to something that already exists, and nothing dissolves under
anybody.

- **Birth.** A terminal's home is created with the terminal and holds exactly one leaf. On a
  canvas it appears as a portal onto that home, wearing the terminal's own chrome.
- **Merge.** Compositions MERGE, never nest. A composition holding exactly ONE item is that
  item as far as placement is concerned, so it is absorbed as its occupant; a composition
  holding several (or none) that still reaches a tile destination is refused by name
  (`not_solo`). A canvas merge (`compose`) births ONE composition named `"<A> + <B>"` from
  the two refs' labels, repoints the target's portal element at it IN PLACE — same
  element id, same geometry, so no collaborator's portal jumps and no selection is lost —
  moves both occupants in, repoints every other reference that pointed at an absorbed home,
  and retires each emptied home. Dropping onto a reference to a MULTI-item composition is not
  a merge at all: the ref joins it as a plain tile.
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
    `core.terminals.kill { terminalId }`, or `DELETE /api/containers/:id/tiles/:tileId` on its
    last
    leaf. All three are one write: the PTY, the terminal row, every leaf its home held for it,
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

  The predicate is structural, not a stored flag: a killed terminal is gone before the
  machine's `exited` frame can arrive, so that frame finds nothing and no third status can
  propagate. An undeliverable kill (machine offline) still removes everything; the PTY that
  outlived it is killed by `hello` reconciliation, which finds no row to adopt it against.

- **Emptying and deletion.** A composition that just lost its last occupant retires: it is
  the DEPARTURE, not the emptiness, that retires a container, so a deliberately empty
  composition ("New composition", or one whose tiles were never filled) stays. Deleting a
  container (`core.index.deleteContainer`) removes every reference to it FIRST, then kills every
  PTY still homed in it, then drops its room and row. A reference never outlives what it
  references, which is why a portal pointing at nothing is not a state this server can reach.

## Plugins, actions, and the workspace layout

Everything above the foundation floor is a plugin (`AXIOMS.md` axiom A1); this section is what
the packages promise each other about that. Assembly happens twice from the same manifests —
`packages/server/src/assembly.ts` registers server halves, `packages/web/src/assembly.ts`
web halves — and both run `assembleRoster` from `@manifold/plugin`, which refuses duplicate
plugin ids, action names, panel ids, element types and tool ids by NAMING every offender.
Manifests are inert DATA: no executable fields, with `entry` reserved for the later
dynamic-distribution wave. Plugins are trusted in-process code today (ADR 0010); the wire is the
security boundary and every authority decision happens at a door. What happens to a plugin's data,
contributions and neighbours across an enable/disable is the **behavioral contract**
(`docs/decisions/0013-plugin-behavioral-contract.md`, law in `AXIOMS.md` §Disable semantics).

**The roster.** `GET /api/plugins` returns one entry per assembled row:

```ts
{
  manifest, enabled,
  source: "builtin" | "plugin",              // "builtin" = an ENGINE door, not a package
  actions: ActionSummary[],                   // { name, title, caps, input, result } — JSON Schemas
  lifecycle?: "ok" | "enable_failed" | "disable_failed",   // absent ≡ ok
  refusal?: PluginRefusalReason,              // why this row cannot be toggled right now
  changedBy?: string | null, changedAt?: number | null     // who last flipped it, and when
}
```

`GET /api/protocol` embeds the same vocabulary beside the wire schemas, plus a `pluginContract`
block — `engineNamespace`, `sources`, `dependencyTypes`, `dormantModes`, `defaultDormantMode`,
`residualMechanisms`, `purgeTargets`, `lifecycleStates`, `refusalReasons`, `denialRules`,
`defaultElementPlacement`, and JSON Schemas for the manifest, actions, outcomes, roster entries and
purge results — so an agent learns every door AND every closed enum from one read.

**Manifest fields the behavioral contract adds** (all optional; absence reproduces the previous
semantics exactly): `dependencies` (a `Record<PluginId, { type: "required"|"optional"|"incompatible", reason? }>`),
`after` (soft ordering, a missing id is not an error), `dataVersion { major, minor }`,
`dormant { mode: "ghost"|"hide", label? }` (absent ≡ `ghost`), `purges` (audit declaration over
`storage`/`elements`/`ownership`, bound to no verb), and per-element `placement { groups, guards, homed }`
(absent ≡ `DEFAULT_ELEMENT_PLACEMENT_TRAITS`). Assembly order is topological over
`dependencies` ∪ `after`, ties broken by lexicographic plugin id, and that order is the lifecycle
fan-out order.

**The action door.** `POST /api/actions/:name`, where `:name` is the FULL action name
`<pluginId>.<local>` (e.g. `core.terminals.rename`). The body is the action's own argument
object; the answer is always HTTP 200 carrying `ActionOutcome`. The ladder is MONOTONIC and
stops at the first rule that fires:

| Order | `rule`            | Fires when                                                                                                                                                                                                                                                                              |
| ----- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `unknown_action`  | no assembled action carries that name                                                                                                                                                                                                                                                   |
| 2     | `plugin_disabled` | the owning plugin is disabled in this workspace — SKIPPED for actions declared `cleanup: true` (D12: removal survives a disable; `core.terminals.kill` is the wave-1 occupant)                                                                                                          |
| 3     | `forbidden`       | the caller is container-scoped (`containerScope !== null`) AND the action declares `scope: "workspace"` (the default) — message "scoped tokens cannot invoke workspace actions". An action declaring `scope: "container"` skips this rung; its handler MUST honour `ctx.containerScope` |
| 4     | `forbidden`       | the caller lacks one of the action's DECLARED caps (intersection at the door, not inside the handler)                                                                                                                                                                                   |
| 5     | `invalid_args`    | the body fails the action's `input` schema                                                                                                                                                                                                                                              |
| 6     | `refused`         | the handler refused on domain grounds, or the engine refused by CLASS — the message is a refusal class, optionally naming offenders (below)                                                                                                                                             |

Order matters: a caller must not learn that an action exists and is forbidden before the cheaper
facts (existence, enablement) are settled, and a handler never sees unvalidated arguments. A
handler's result is validated against the action's `result` schema; a mismatch is a server fault
(500), never a denial. Every dispatch emits one structured log line (`evt:"action"`).

**Refusal classes are the contract; prose is not.** `PLUGIN_REFUSAL_REASONS` is closed —
`essential`, `builtin`, `unknown_plugin`, `missing_dependency`, `incompatible_dependency`,
`dependency_disabled`, `data_downgrade`, `data_migration_missing`, `element_type_owned`,
`still_enabled` — and a `refused` message is the class verbatim when there is nothing to name,
otherwise `"<class>: <offenders, comma-separated>"` (`builtin: engine.plugins`,
`still_enabled: core.draw`, `missing_dependency: test.leaf`). Clients switch on the prefix before
`": "`; the remainder is identity for display, never meaning.

**Enablement is workspace-global, hot, and an ENGINE door.** `engine.plugins.setEnabled { id, enabled }`
(cap `plugins:manage`) is a **builtin roster row** (`source: "builtin"`), not a plugin action: the
mechanism that changes the assembly cannot live inside the assembly, or one toggle would make
it unreachable for every principal (A2). It flips a server-persisted flag (`meta` key
`plugins:disabled`, a JSON array of ids), records attribution (`meta` key `plugins:attribution`),
and pushes the new roster to every open socket; clients rebuild live, with no reload. `engine.` is a
reserved namespace (`ENGINE_NAMESPACE_PREFIX`): a plugin claiming it fails assembly, and a
`setEnabled` aimed at a builtin row is refused with class `builtin`. `core.plugins` is the manager
**UI only** — an ordinary, disableable plugin with no actions and no `essential`. `core.shell`
remains the one `essential` plugin; attempting to disable it is `refused`/`essential`.

Assembly KEEPS a disabled plugin's contributions in its registries and reflects the disabled set
only in `roster[].enabled` and `assembly.enabled(id)` (false for unknown ids too): that is what
lets the ladder tell `plugin_disabled` from `unknown_action`, and lets a placeholder NAME the plugin
it is standing in for. Manifest, capability-subset and uniqueness validation runs across every
registered plugin whether enabled or not, so disabling can never mask a collision. Assembly
refuses only STRUCTURAL truths — a missing or disabled `required` dependency, a cycle, a
self-dependency, an `engine.*` squat, an element-type squat, and (for ENABLED plugins only) a
stored-data downgrade or a missing major migration — so one dormant plugin's stale rows can never
stop the server booting; its data is re-judged at the enablement door instead.

**Disable RETAINS. Destruction is a separate verb.** Disabling gates a plugin's active surface and
destroys nothing: scene records, `plugin_kv` rows, panel leaves in stored layouts, section slots and
element-type reservations all survive, and re-enabling restores them in place. Contributions render
the engine's inert placeholder naming the plugin (`dormant.mode: "ghost"`) or are skipped while their
record stands (`"hide"`) — the placeholder is ENGINE-owned, never supplied by the plugin it stands
in for. The residual mechanisms are the closed set `["cleanup", "dormant", "retain"]`.
`engine.plugins.purge { id }` (cap `plugins:manage`) is the destructive verb: refused while the
plugin is enabled (class `still_enabled`), it clears the plugin's storage namespace including its
`$version` stamp and `$migration:` ledger, releases its element-type reservations, runs `onPurge`,
and answers the exhaustive record `{ id, removed: { storage, elements, ownership } }`. It does NOT
touch documents: a canvas's elements are the workspace's data, not the plugin's.

**Lifecycle hooks** live on the plugin DEF (never the manifest) as
`{ onEnable?, onDisable?, onAssemblyChanged?, onPurge? }`, each receiving
`{ pluginId, storage, now() }` and nothing else — a hook orders a plugin's own durable state, while
anything touching the workspace goes through an action door. They are TRANSITION hooks: at boot,
everything enabled is simply live, with no fan-out and no lifecycle state invented.
`onAssemblyChanged(ctx, delta)` fires once per SURVIVING plugin (enabled before AND after), in
assembly order, after the roster commit and before the broadcast; the plugins named in
`delta { enabled, disabled }` get their own hook instead. Every hook is awaited under a 2-second
bound, and a throw, a rejection or an overrun are one outcome: the transition COMPLETES, the roster
records `lifecycle: "enable_failed" | "disable_failed"`, and one log line names the plugin and hook.
A failing `onPurge` does not stop a purge.

**Disable semantics: creation and administration die, cleanup survives.** Disabling
`core.terminals` refuses new `terminal_open` over the session channel
(`error { code:"forbidden" }`, "terminals plugin disabled") and refuses its administrative
actions, but attach/detach/input and `terminal_kill` on EXISTING terminals keep working: a user is
never locked out of removing something that already exists. That is the `cleanup: true` carve-out,
and `verify:axioms` publishes every action carrying it.

**Per-plugin storage.** `ctx.storage` is the only place a plugin persists anything: one SQLite table
`plugin_kv(plugin_id, key, value)` (added in schema 10), namespaced per plugin, SYNCHRONOUS and
string-valued (`get`/`set`/`delete`/`keys(prefix?)`/`dataVersion()`/`appliedMigrations()`). Keys
match `^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$`, values are ≤64 KiB, and `$`-prefixed keys are
engine-reserved and unforgeable by plugins — that is where the version stamp and migration ledger
live. Migrations are `{ name, to, migrate(storage): void }`, synchronous and all-or-nothing, run at
boot for enabled plugins and at the enablement door for one being switched on; applied NAMES are
recorded so none runs twice. Version rules: equal assembles; minor-only difference assembles with
no migration; a major difference needs an unapplied migration or the plugin is refused; stored major
greater than code major is refused as a downgrade.

**Workspace layout.** Each principal has a `TileLayout` of their own, stored under `meta` key
`layout:<principalId>` and read at `GET /api/layout`. When unset the door answers a DEFAULT that
is injected rather than imported: `workspaceLayout(panels)` in `@manifold/plugin` owns the
arrangement (two leaves in a row at `[0.22, 0.78]`) and `packages/server/src/assembly.ts` owns
the two panel NAMES, because `http.ts` is floor and may not name a plugin. Its
leaves are `{ kind:"panel", panelId }` refs — the shell IS a composition, rendered by the
same `TileTree` a composition container uses, so there is one tree vocabulary everywhere. The ONLY
writer is
`core.space.setLayout { layout }` (self-targeted; the ladder already refuses container-scoped
tokens), and
its validation is STRUCTURAL ONLY: `validateTileLayout` plus "every leaf ref is a panel".
Unknown or disabled panel ids are ACCEPTED — a disabled plugin must never brick layout writes —
and those leaves render placeholders whose chrome offers a remove control that commits the pruned
tree through the same action. Divider drags obey the plane rule: local optimistic ratios per
frame, ONE `core.space.setLayout` at the commit point, never one per frame.

**Terminal administration (`core.terminals`).** `PATCH /api/terminals/:id`,
`DELETE /api/terminals/:id`, `GET /api/terminals` and `GET /api/container-terminals` are deleted,
with no
`core.terminals.rename { terminalId, name }`, `take { terminalId }` and `kill { terminalId }`
carry `terminals:write` at `scope: "container"` — the authority the session channel's own
`terminal_kill`
verb has always enforced, and the one the browser's `canKill` rule is computed from. The deleted
routes asked for `containers:write` instead: two doors onto one concept answering differently,
which is
exactly what invariant 14 forbids, so the cutover took the channel's answer rather than the route's.
`kill` is `cleanup: true` (removal survives a disable), the rename broadcasts
`terminal_event { kind:"renamed", name }` into the home, and the kill sweeps the terminal, its home,
and every portal onto that home. `open` carries `terminals:spawn` at `scope: "container"`, because a
terminal is born inside one container and the per-terminal agent token minted for it is
container-scoped
with that cap — a workspace-graded creation door would have quietly ended agents spawning their own
terminals. The reads are doors too: `listByContainer` is `scope: "container"` (the route it replaces
answered a
scoped token with its own container's rows), while `listAll` keeps the default because the terminal
index it
replaces refused scoped tokens outright. Mutating affordances in the DOM carry
`data-action="<action name>"`, which is how the gate proves the UI and the API share one door.

Two things about that door are worth stating because they are what "one door per concept" cost here.
The session channel now DISPATCHES the action rather than duplicating its authority:
`terminal_open` calls `core.terminals.open` first and only then asks the broker (a create is a
machine round trip whose reply is socket traffic, so the PTY is still born on the channel), and
`terminal_kill` dispatches `core.terminals.kill` — `broker.kill(channel, …)` is deleted, so one door
answers for both the UI and the channel, and the surviving rule is the stricter one: an exited
terminal is
dismissable by any `terminals:write` holder, a running one only by its controller or the wildcard.
`terminal_take` has `terminal_open`'s shape rather than `terminal_kill`'s: it dispatches
`core.terminals.take` and, only if allowed, lets the broker move the lease and broadcast
`controller_changed`, because a lease is held BY a connection and the broadcast goes to the room
that connection is joined to. `take` is NOT `cleanup` — claiming control of a live PTY is
administration, not tidying up — and its rule is the broker's former one minus the authority
half: a terminal that cannot be named is `terminal not found`, an exited one is
`terminal has exited`, and the principal currently HOLDING the lease is deliberately no
obstacle, since claiming first is the documented way out of `kill`'s lease refusal.
The broker's own `terminals:spawn` and `terminals:write` checks are deleted; authority lives at
the door and nowhere
else. And containment behaves differently by shape: it FILTERS a listing (`listByContainer` answers
a
scoped reader its own container's rows) and REFUSES on the five doors that name one terminal, all
through `ctx.outsideScope`.

**Index and container administration (`core.index`).** `GET`/`POST /api/pads`,
`GET`/`PATCH`/`DELETE /api/pads/:id`, `GET`/`PUT /api/pad-tree` and the three `/api/pad-folders`
routes are deleted; `DELETE /api/containers/:id/tiles/:tileId` survives as leaf removal, which is
not a
placement. The doors, with the routes' own request schemas as their inputs:

| Action                       | Caps             | Scope     | Args → Result                              |
| ---------------------------- | ---------------- | --------- | ------------------------------------------ |
| `core.index.read`            | containers:read  | container | `{}` → `{ items: IndexEntry[] }`           |
| `core.index.listContainers`  | containers:read  | container | `{}` → `{ containers: Container[] }`       |
| `core.index.readContainer`   | containers:read  | container | `{ containerId }` → `{ container }`        |
| `core.index.createContainer` | containers:write | workspace | `{ name, discipline? }` → `{ container }`  |
| `core.index.renameContainer` | containers:write | container | `{ containerId, name }` → `{ container }`  |
| `core.index.deleteContainer` | `*`              | workspace | `{ containerId }` → `{}` — `cleanup: true` |
| `core.index.createFolder`    | containers:write | workspace | `{ name, parentId }` → `{ items }`         |
| `core.index.renameFolder`    | containers:write | workspace | `{ folderId, name }` → `{ items }`         |
| `core.index.deleteFolder`    | containers:write | workspace | `{ folderId }` → `{}` — `cleanup: true`    |
| `core.index.moveEntry`       | containers:write | workspace | `{ entry, parentId, index }` → `{ items }` |

What CHANGED rather than moved: `deleteContainer`'s `requireRoot` became a declared `*` cap
evaluated at
ladder rung 4, so its refusal is `forbidden: * capability required` instead of an HTTP 403; every
404 and 409 became a `refused` carrying the route's own sentence verbatim ("container not found",
"index folder not found", "parent folder changed while creating a folder", "index changed while
moving an entry"); `deleteContainer` and `deleteFolder` are `cleanup: true`, so removal outlives a
disable
of `core.index` while its reads and other writes answer `plugin_disabled` (D12); `readContainer` and
`renameContainer` discharge containment through `ctx.outsideScope`; and `createContainer`, which
refused
container-scoped tokens by hand, now does so at rung 3 — same outcome, named rung. What did NOT
change:
`deleteFolder` still moves children up rather than cascading, a move still refuses cycles through
the store's ancestor walk, and `deleteContainer` still routes through the placement executor so no
portal
or leaf is left pointing at a dead container.

**Machine administration (`core.machines`).** `POST /api/machines` and `GET /api/machines` are
deleted. `core.machines.enroll { name, rotateToken? }` carries `machines:mint` at the default
workspace scope (the route refused container-scoped callers itself) and answers
`{ machine: { id, name, color? }, machineToken? }`; it is idempotent by name, and
`rotateToken: true` is the lost-token-file recovery path — it revokes the old secret, fences the
live socket at 4403, and mints once. `core.machines.list {}` carries `containers:read` at
`scope: "container"`
because `GET /api/machines` answered any authenticated token including a scoped one (a share-link
viewer still has to paint the machine badge on the terminal in front of it); its containment
obligation is vacuous, since nothing in a fleet-wide answer is addressed by container.

A machine summary now carries an optional **`color`**, derived server-side by `identityColorFor`
over the shared `IDENTITY_COLORS` palette — both exported from `@manifold/protocol`
(`packages/protocol/src/principal.ts`), with the web layer re-exporting the palette rather than
declaring a second copy. Presentation that was derived per client is wire data now, which is what
lets any principal render the same badge.

**Access administration (`core.access`).** `POST /api/principals`, `POST /api/tokens` and
`POST /api/tokens/revoke` are deleted; the identity MECHANISM (hashing, bearer authentication,
attenuation, the revocation fence) stays floor and unchanged. The three doors:

| Action                        | Caps          | Scope     | Args → Result                                                                |
| ----------------------------- | ------------- | --------- | ---------------------------------------------------------------------------- |
| `core.access.createPrincipal` | `*`           | workspace | `{ name, color?, kind? }` → `TokenGrant` (caps `["*"]`, `containerId: null`) |
| `core.access.mint`            | `tokens:mint` | container | `{ principal \| principalId, caps, containerId? }` → `TokenGrant`            |
| `core.access.revoke`          | `tokens:mint` | container | `{ principalId }` → `{ revoked: <count> }` — **`cleanup: true`**             |

`createPrincipal` demands `*` because `requireRoot` did; the other two demand `tokens:mint`
because the mechanism did. Both of those are `scope: "container"` (§Actions rung 3) because
`POST /api/tokens` authenticated any token and let the mechanism attenuate: a container-scoped agent
holding `tokens:mint` may mint inside its own container and revoke what it minted there, and the
mechanism performs the containment check — a mint may not widen its minter's container scope, and a
scoped revocation reaches only that container's tokens. Attenuation failures are `refused` denials
carrying the mechanism's own wording verbatim (`cannot mint capability <cap>`, `cannot widen
container
scope`, `principal not found`, `cannot revoke another principal`); a cap the caller does not hold
is `forbidden` at the door, one rung earlier.

`revoke` is `cleanup: true`: revocation is what somebody reaches for when a secret has
leaked, so disabling `core.access` must not keep a compromised token alive (ADR 0013 §9). Its
result is an exhaustive count rather than `{ ok }` — `0` means "there was nothing left to
revoke", which the deleted route could not say. `core.access` is NOT `essential`: the owner key
authenticates outside the token system, so no disable can lock the owner out. The A5 evaluator
(ADR 0011) later replaces what happens BENEATH these doors; their published vocabulary does not
move.

**The audit trail (`core.events`).** The server has recorded events since the first migration —
`principal_joined`, `principal_left`, `terminal_opened`/`renamed`/`bound`/`exited`,
`token_minted`, `token_revoked` — into the `events` table (`id`, `container_id`, `ts`,
`principal_id`, `type`, `payload`), pruned to 30 days and 10,000 rows per container. Nothing
could read them back, so the trail was a fact about the database rather than about the
workspace. One door now reads it:

| Action             | Caps | Scope     | Args → Result                                                                                             |
| ------------------ | ---- | --------- | --------------------------------------------------------------------------------------------------------- |
| `core.events.list` | `*`  | workspace | `{ limit?: 1..500, kind?: string(1..64), containerId?: string }` → `{ events: EventRow[] }`, newest first |

`EventRow` is `{ id, containerId: string\|null, ts, principalId: string\|null, type, payload }` —
camelCase, with `payload` carried as the stored JSON TEXT because no schema declares what a given
event type's payload holds, so a reader decides what to parse and a malformed row still reads as a
row. The filter's word is `kind` while the row publishes `type`: the filter is the caller's
question, the row is the column's own name.

`*` is root-only and deliberate. The trail is workspace-wide and carries OTHER principals'
activity; no cap in the vocabulary means "may read other people's history", and reusing
`containers:read` would hand every share-link holder a surveillance feed. `scope: "workspace"`
follows: a container-scoped token is refused at rung 3 before arguments are parsed, so the
`containerId` filter is a narrowing for a caller who could already see everything rather than a
way out of a container — which is why the handler owes `ctx.outsideScope` nothing. `limit` is
bounded at the schema instead of clamped, so the maximum is published in the roster's JSON
Schema; reading past 500 rows needs paging, and paging needs a cursor this wave does not invent.

`core.events` contributes no panel, section, element or tool — a door-only plugin, like
`core.access`. It is not `essential`: the rows keep accruing while it is off (a disable retains,
ADR 0013 §1), so re-enabling restores the whole trail.

**`manifold://` addressing.** One canonical serialization of the addressing algebra, bijective
with the structured wire forms (`parseManifoldUri` / `formatManifoldUri`,
`packages/protocol/src/uri.ts`). Seven forms; every id segment is percent-encoded:

```
manifold://container/<containerId>
manifold://container/<containerId>/element/<elementId>
manifold://container/<containerId>/tile/<tileId>
manifold://terminal/<terminalId>
manifold://principal/<principalId>
manifold://plugin/<pluginId>
manifold://action/<actionName>
```

An unknown scheme or shape parses to `null` — nothing guesses. `GET /api/resolve?uri=` answers
`ResolveResponse { uri, ref, exists, title }`, the round trip that turns a reference into
something an agent can name; `/uri/<encoded>` is the browser deep link onto the same grammar.
Grants, spotlights, and (from wave 2) event topics all name nodes this way.

## WS /ws/session — session channel (JSON text frames)

**Frame grammar (v16).** One socket per tab, many rooms. Every frame is either
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
slow path), is unique per connection, and is deliberately NOT a container id: two channels on
one socket may address the SAME container with different roles (an occupant renderer and a
portal's watching preview), so a container-keyed channel would be an id pun that collides.
Liveness is a
property of the socket, so ping/pong carry no `ch`. `@manifold/protocol` publishes each
frame twice from the same shapes — a channel-less BODY union and the wire union that adds
`ch` — because a broadcast validates and serializes one body and tags it per channel.

**Connection frames address the SOCKET, not a channel.** `@manifold/protocol` publishes them as
`CONNECTION_BODIES` beside the channelized `SERVER_BODIES`, and they carry no `ch` because the
thing they concern is the connection itself. `plugins { roster }` is the first such
server→client frame: it is delivered once when the socket opens (before any `join`) and again
whenever the roster changes, which is what makes enable/disable hot for every open tab. The SDK
pool demultiplexes connection frames to pool-level listeners (`SessionClient.onPlugins`, which
replays the latest roster to a late subscriber) instead of dropping them as frames for an
unknown channel.

Handshake: the FIRST client frame on a connection MUST be
`join { ch, containerId, token, protocolVersion, spectator?, lastEpoch?, lastRev? }`; the server
answers `init { ch, protocolVersion, epoch, rev, doc, attendance, terminals, self, selfCaps,
selfConnId }` on that channel. The ten-second join deadline is re-armed whenever the last
channel leaves: a socket MUST carry at least one room to stay open, and an idle connection
is indistinguishable from one that never joined. Resume hints (`lastEpoch`/`lastRev`) ride
each channel's own join, so a reconnect redials ONE socket and rejoins every channel on
it; a mismatch simply yields a full init. `leave { ch }` frees one channel while every
other keeps streaming — a client closing its LAST channel closes the socket instead,
because the close already means "leave everything". `selfConnId` identifies the CHANNEL and
changes on every join (a role swap is `leave`+`join` on one socket, never TCP churn);
attendance keying, cursor echo-suppression, and the terminal viewer registry hang off it
exactly as they hung off a socket before v12. `doc` is the base64-encoded full Yjs state
update for the room. `selfCaps` mirrors the joining principal's granted caps so clients can
gate UI affordances without a separate introspection round-trip. Presence is carried by
`attendance`, whose entries are `PresenceState`; there is no separate `presences` field.

**Refusal scope.** A refusal closes the whole SOCKET when it invalidates the credential or
the framing itself, and ONE CHANNEL — a `channel_closed { code, reason }` frame, socket
untouched — when it concerns one room:

| Code      | Scope   | Cause                                                                                                                   |
| --------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| 4401      | socket  | bad token                                                                                                               |
| 4403      | socket  | forbidden, or revoked (a revocation fences every live connection of that principal)                                     |
| 4409      | socket  | protocol version mismatch                                                                                               |
| 4002      | socket  | malformed frame of a KNOWN type, non-`join` first frame, duplicate `ch`, or the join deadline elapsing with no channels |
| 4404      | channel | unknown container at join; a DELETED container closes every channel of its room with the same code                      |
| 4429      | channel | `MAX_SESSION_CHANNELS_PER_CONNECTION` (64) already held                                                                 |
| 1009      | channel | that room's `init`/`resync` state exceeding the 16 MiB transport payload ceiling                                        |
| 1013      | channel | that channel's outbound queue overflowing (256 frames or 1 MiB, per channel)                                            |
| 1009/1013 | socket  | one frame exceeding the transport ceiling, or the socket refusing a write — transport failures no single room can heal  |

Killing a whole tab because one portal pointed at a deleted container is precisely the blast
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
it (absent ≡ occupant) — the two members of `ChannelRole`. A portal's resting preview uses it:
the portal IS a real
channel into another container, and counting that as membership faked occupant avatars. A
spectator receives `init`/`resync`, `doc_update`, attendance/presence/cursor fan-out and
terminal snapshots and output, and may send `leave`, `resync_request`, `ping`,
`terminal_attach` and `terminal_detach`. Every other client frame is refused with
`error { code:"forbidden" }` — a preview never writes. Spectators appear in NO attendance and
in NO `GET /api/attendance` entry; a room holding watchers alone still counts as resident
for eviction. Engaging a portal swaps that channel to an occupant join, so watching versus
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
- **Container discipline.** A container row carries `discipline: "canvas" | "composition"`; both
  disciplines share the room/doc machinery, and the two are lenses on ONE container object.
  A composition stores its tile tree in the doc's `layout` map
  (`LAYOUT_KEY`): tiles are splits (`dir` row/column, parallel `ratios`/`children`,
  `ref` null) or leaves whose `ref` is `{ kind:"terminal", terminalId }`,
  `{ kind:"container", containerId }` (an embedded canvas — never the container itself), or
  `{ kind:"text", elementId }` (a note the composition's OWN document stores, so placing a
  note into a composition MOVES the element instead of referencing it across two docs). The
  fourth ref kind, `{ kind:"panel", panelId }`, belongs to WORKSPACE layouts only: a room
  document never carries one, and the placement algebra refuses `panel` items into any
  container (`not_accepted`). `validateTileLayout` gates every read: root exists, child
  references resolve, nothing is reachable twice, ratios stay parallel to children, refs
  sit on leaves only, and a container never tiles itself; unreachable tiles are inert garbage
  the next structural write prunes. Ratio drags are CRDT writes (`setTileRatios` through the
  SDK); every STRUCTURAL mutation goes through a door — the action `core.space.place` and the one
  leaf-removal route — applied under `SERVER_PLACE_ORIGIN`, which client undo managers never track.
- **Portal elements.** A canvas record `{ type:"portal", containerId, ...geometry }` renders
  another container in place. This is also how a TERMINAL appears on a canvas: the portal
  points at the composition the terminal lives in, so one element kind covers both. Nesting
  renders live to depth 2 (the routed canvas is depth 1, so its portals show their
  containers' tiles) and as a navigable card deeper — a live chain would open a room channel
  per level. Cycles are legal: portals navigate on enter, they never recurse live. A portal
  onto a SOLO composition renders ELEMENT-CHROME-FIRST (`.portal--mono`): the item's own
  titlebar IS this node's chrome, there is no portal name strip, and the resize floor is the
  item's. A multi-tile portal keeps its name strip as the React Flow drag handle, and a tile
  titlebar drag inside it EXTRACTS that tile rather than moving the node.

### Presence (ephemeral, never persisted)

- `presence { payload }` where payload is a partial of
  `{ cursor: {x,y} | null, selection: string[], viewport: {x,y,zoom}, focus: {elementId} | null, status: "active"|"idle"|"working"|"waiting"|"needs_attention"|"done", vantage: {…} | undefined, spotlight: {…} | null }`.
- **Vantage is presence** (axiom A2: per-principal view state is observable AND drivable).
  `vantage { tool?, editingElementId?, focusedContainerId?, sidebarCollapsed? }` is written by the
  CLIENT through the same throttled presence writer as every other field and dies with the
  connection, so a peer can see which tool somebody holds, what they are editing, and whether
  their sidebar is open. It is descriptive, never authoritative: nothing downstream branches on
  whose vantage it renders.
- **`spotlight { uri, from }` is SERVER-written only.** The server strips `spotlight` from any
  client payload; the sole writer is the action `core.presence.focus { targetPrincipalId, uri }`
  (cap `scenes:write`), which requires that the target shares a joined room with the caller and
  that the caller holds `scenes:write` on that room, and which is throttled to one per 2s per
  (caller, target). The recipient's client centers on `uri` with a source chip and a dismiss,
  and a device-local kill switch (`manifold:ignore-spotlight`) ignores spotlights entirely:
  driving someone else's vantage is consented, rate-limited, and attributable, or it does not
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
  the `PlacementRef` in flight, the `PlacementItem` that ref RESOLVES to, and the
  label it carried at grab time — a viewer often cannot derive either, because the item
  belongs to a room it has not joined and classifying an address takes the workspace census
  the grabber has and the watcher may be a poll behind on. `item` is REQUIRED for exactly
  that reason: a watcher judges legality and paints from the frame, never by re-resolving
  somebody else's address. All other presence fields send on change only; viewport ≤1Hz.
- **Cursor coordinate space is the room's discipline.** Cursors are container-scoped
  (per-room, like all presence): canvas rooms carry React-Flow scene coordinates; composition
  rooms carry fractions of the container's tile area in `[0,1]²` (ratios are shared CRDT
  state, so a fraction resolves to the same tile for every viewer regardless of window
  size). Receivers clamp to the unit square. The workspace shell is not a room: its panels
  carry no cursors and there is no workspace-level cursor channel. What another principal sees
  of a peer's shell is the `vantage` payload above, relayed per room like the rest of presence.
- Attendance: `init.attendance` lists occupying principals; server broadcasts
  `attendance { joined?, left? }` deltas. Presence for a principal dies with its last channel
  in that room.
- Several memberships per principal are legal (tabs, and several rooms per tab); attendance
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
  rather than spawning a PTY no renderer would ever show: on a CANVAS the opener authors the
  element (`placement` absent ≡ `"element"`), and in a COMPOSITION the container places the
  leaf itself (`placement: "tile"`).
- **A terminal is born with a home** (`homed: "eager"`). The home id is minted BEFORE the
  PTY, because the terminal-scoped agent token and the `MANIFOLD_CONTAINER` a program inside the
  terminal reads must both name the container the terminal LIVES in — and a canvas is never
  that. A composition opener IS the home; a canvas opener gets a fresh solo composition whose ROW
  is created when the PTY lands, so a create that never lands leaves nothing behind to clean
  up. The server mints a **terminal-scoped agent token** (caps
  `[containers:read, scenes:write, terminals:spawn, terminals:write]`, scoped to the HOME), asks
  the
  agent to create the PTY with env `MANIFOLD_URL`, `MANIFOLD_CONTAINER` (the home),
  `MANIFOLD_ELEMENT` (canvas openers only), `MANIFOLD_TOKEN` injected, then replies
  `terminal_opened { elementId, terminal, ref? }`. `elementId` is the PLACEMENT: the
  server-authored leaf id for a composition opener (whose `ref` echoes the opener's correlation
  token, sent only to that opener), else the opener's own element id. `terminal.containerId` is
  the
  home either way. The fan-out (`terminal_opened` plus `terminal_event { kind:"opened" }`)
  goes to the HOME's room, never the opener's — nothing about a terminal is canvas state any
  more. A canvas opener then authors ONE portal element onto `terminal.containerId` through
  `client.transact`: the server never authors an element for `terminal_open`. Placement is
  the one place the server DOES write canvas elements, and it does so only through the placement
  executor behind `core.space.place`, under `SERVER_PLACE_ORIGIN`.
- **Terminal frames travel over the home composition's channel.** Every terminal frame
  (`terminal_attach`, `terminal_input`, `terminal_resize`, `terminal_take`, `terminal_kill`)
  resolves its terminal only when `terminal.containerId === channel.containerId`; anything else is
  `error { code:"not_found" }`. A canvas showing a terminal through a portal therefore joins
  the home's room on its own channel instead of streaming terminal bytes over the canvas's.
- **Attach state machine (no-gap invariant).** On `terminal_attach { terminalId }`:
  1. server registers the viewer as PENDING and starts queueing that terminal's live
     `output` frames for it (nothing is sent yet);
  2. server sends the agent `snapshot_request`;
  3. agent serializes its headless mirror at its current byte-sequence `S` (same ordered
     pipeline as output emission — an output emitted before the snapshot has seq ≤ S);
  4. server sends the viewer `terminal_snapshot { terminalId, seq: S, data }`, flushes
     queued outputs with `seq > S` in order, discards `seq ≤ S`, then marks the viewer LIVE.
     Viewer byte stream ≡ snapshot(S) + outputs(S+1…). e2e MUST assert mid-stream attach
     contiguity (counter test), repeated ≥10×.
- **Snapshot geometry.** A viewer MUST construct xterm at the advertised terminal
  `cols`/`rows` and replay the serialized snapshot before fitting to its canvas element.
  Serialized cursor movement is geometry-dependent; fitting first can corrupt wrapping after
  a container switch or reload. After replay, the viewer fits once rendering settles and the
  controller reports the resulting geometry through `terminal_resize`.
- **Client-side viewer pairing.** The viewer registry above is **channel-scoped** (one
  `Viewer` per room membership, which before v12 was one per socket). A client presenting
  several renderers of one terminal on that channel sends `terminal_attach` on every mount:
  the server replaces the channel's viewer and re-emits snapshot(S′)+outputs(S′+1…), which
  is a late renderer's only path to existing screen state (frames fan out to all local
  renderers;
  each re-renders from the fresh snapshot). `terminal_detach` is refcounted and fires only
  on the 1→0 transition — a raw detach from one renderer starves every other one on that
  channel. The SDK owns this (plus re-attach after reconnect, since the registry dies with
  the channel); components just pair attach/detach per mount. Guarded by SDK contract tests.
- `terminal_input { terminalId, data }` (data base64) — accepted only from the current
  **controller**; others receive `error { code:"not_controller" }`.
- Controller lease: opener starts as controller; `terminal_take { terminalId }` dispatches
  `core.terminals.take` (cap `terminals:write`, `scope: "container"`) and, only when that door
  allows, transfers the lease to that principal (event
  `terminal_event { kind:"controller_changed", controllerId }`). Controller-only: input,
  `terminal_resize` (broadcast as
  `terminal_event { kind:"resized", cols, rows }` so every viewer refits), `terminal_kill`.
- Kill authorization: the current **controller**, OR any holder of the wildcard
  capability (`*`), may send `terminal_kill` for a RUNNING terminal; other principals
  receive `error { code:"forbidden" }`. An EXITED terminal has no controller, so there is no
  lease to win: `terminals:write` on the home is enough to dismiss it, and the dismissal is a
  kill (see the lifecycle predicate). Unlike input/resize/take, `terminal_kill` is therefore
  never `conflict` on an exited terminal. An exited terminal whose home no longer holds a leaf
  for it (a client rewrote the layout document directly) is pruned on the next init/resync of
  that home.
- **Unplaced terminals.** `TerminalInfo.containerId` is the composition the terminal lives in —
  never a canvas, never null, so "unbound" is not a state a terminal can be in. There is no
  pool: what parking used to mean is now `unplaced`, which says that nothing REFERENCES that
  home, and it is DERIVED from the containment graph on every read rather than stored — so
  releasing and re-placing a terminal leaves no state behind to go stale.
  `core.terminals.listAll` lists EVERY terminal as
  `{ id, machineId, name, createdAt, status, exitCode, homeId, unplaced }`. The pool's
  durable `sort_order` is retired with it: an unplaced terminal's position is its home
  composition's position in the one index.
- Terminals carry a durable nullable `name`, renamed through the action
  `core.terminals.rename { terminalId, name }` (cap `terminals:write`); the new label broadcasts
  into
  the home as `terminal_event { kind:"renamed", name }`, where every titlebar and index row picks
  it up without a refetch. Labels everywhere are `name ?? machine name`.
- `output { terminalId, seq, data }` streams to all LIVE viewers; `terminal_event
{ kind:"exited", exitCode }` on a PTY that stopped ON ITS OWN. Such a terminal stays listed
  (status `exited`, real code) with its leaf and every portal onto its home intact, so the
  exit code stays readable until somebody kills it. A KILL broadcasts no `exited` event: the
  leaf and the portals vanish through the documents instead, which is how viewers learn the
  terminal is gone rather than dead.
- `terminal_event { kind:"parked" }` keeps its pre-cutover kind name and now means exactly "this
  terminal left THIS room": it fires in the OLD home when a merge or an extraction re-homes
  the terminal, paired with `terminal_opened` carrying the new leaf in the new home, and
  UNPAIRED when a kill reaps the terminal — it left every room. Clients drop the row from
  their terminal listing on it, which is what makes a kill visible at once rather than at the
  next resync. Nothing is parked anywhere — the frame is a departure notice, not a state.
- Terminal ids are opaque. A terminal's placements are read from live containers (portal
  elements and tile leaves), never from the terminal row: one terminal can be referenced from
  many canvases at once, so no single `elementId` could describe it. Text and draw elements
  never reference terminals. Session protocol v16.

## WS /ws/machine — machine channel (JSON; `data` fields base64)

Handshake: agent sends `hello { token, name, agentVersion, protocolVersion, terminals }`
where `terminals` advertises retained PTYs
`{ terminalId, cols, rows, alive, seq, exitCode? }` (server-restart adoption). An
`alive:false` advertisement reports a real `exitCode` when the PTY exited while
disconnected; absence is equivalent to `null`. Such exited terminals are retained through
the next `hello`, then forgotten when `welcome` acknowledges it (or when `kill` arrives).
Server replies `welcome { machineId, serverEpoch }` or closes: 4401 unauthorized,
4403 revoked, 4409 version. Version acceptance is the
`MACHINE_PROTOCOL_COMPAT_VERSIONS` set `{16}` (protocol/version.ts), NOT strict equality:
agents are long-lived and survive server deploys, so every compatible agent version stays
accepted (session/browser joins remain strictly current). An unchanged agent wire adds the
new version to the set; a strictly additive-optional change also adds it when every old
frame still parses and the absent-field default reproduces pre-bump semantics. Any other
agent-wire change resets the set to the new version and requires a coordinated fleet
restart — which v16 did: `terminal_event`, `TerminalInfo` and `MANIFOLD_CONTAINER` renamed
the agent wire, so the set holds v16 alone and the fleet restarts together. Every
rejection path emits a structured server log (`machine_version_rejected`,
`machine_rejected`, …) — silent closes are how a whole fleet goes dark undiagnosed.

Server→agent: `create { terminalId, cols, rows, cwd?, env }`, `input { terminalId, data }`,
`resize`, `kill`, `snapshot_request { terminalId }`, `ping`.
Agent→server: `created { terminalId }` | `create_error { terminalId, message }`,
`output { terminalId, seq, data }` (seq: monotonic per terminal, assigned at emission),
`snapshot { terminalId, seq, data }`, `exited { terminalId, exitCode }`, `pong`.

Liveness, server half: after `welcome` the server sends `ping` every
`MACHINE_PING_INTERVAL_MS` (30s); a ping still unanswered when the next fires closes the
socket (4008 `liveness timeout`), so a frozen or partitioned agent (laptop sleep, dropped
network) is marked offline within two intervals — TCP alone would keep it "online"
indefinitely. Agent half: a healthy connection carries those pings even when idle, so the
agent closes and re-dials after `AGENT_LIVENESS_TIMEOUT_MS` (75s) of total silence —
catching phantom transports (dead TCP with no RST, e.g. a proxy swallowing the close
mid-reload). The agent also logs every disconnect's close code/reason.

Reconnect: agent redials with jittered backoff (cap 15s), re-`hello`s with retained
terminals; a new server epoch re-adopts them. On successful re-adoption of a running
terminal, the server transitions every existing viewer back to PENDING and uses the normal
attach machinery to request a fresh snapshot. This heals output dropped during the
disconnect window, including ring-buffer overflow. Stale sockets are fenced: the server
drops a machine's previous socket when a new `hello` for the same machine token arrives.
PTY output while disconnected goes to the agent's per-terminal ring buffer (default 2MiB);
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
containers(id TEXT PK, name TEXT, created_at INTEGER, sort_order INTEGER, folder_id TEXT,
     discipline TEXT NOT NULL DEFAULT 'canvas')        -- canvas | composition
container_folders(id TEXT PK, name TEXT, created_at INTEGER, parent_folder_id TEXT,
            sort_order INTEGER)
scene_docs(container_id TEXT, epoch TEXT, rev INTEGER, ts INTEGER, hash TEXT, doc BLOB,
           PRIMARY KEY (container_id, epoch, rev))     -- keep newest 30 valid docs each
events(id INTEGER PK AUTOINCREMENT, container_id TEXT, ts INTEGER, principal_id TEXT,
       type TEXT, payload TEXT)                       -- lifecycle/caps/join-leave ONLY
principals(id TEXT PK, kind TEXT, name TEXT, color TEXT, created_at INTEGER)
tokens(id TEXT PK, hash TEXT UNIQUE, principal_id TEXT, caps TEXT, container_id TEXT,
       created_at INTEGER, revoked_at INTEGER, minted_by TEXT)  -- HASH only, never raw
machines(id TEXT PK, name TEXT UNIQUE, token_id TEXT, last_seen INTEGER)
terminals(id TEXT PK, machine_id TEXT, container_id TEXT, created_by TEXT, status TEXT,
         exit_code INTEGER, created_at INTEGER, agent_principal_id TEXT, name TEXT)
                            -- container_id IS the home composition; no element_id, no pool
                            -- order
plugin_kv(plugin_id TEXT, key TEXT, value TEXT, PRIMARY KEY (plugin_id, key))
                            -- WITHOUT ROWID; per-plugin storage, `$`-prefixed keys are
                            -- engine-reserved ($version stamp, $migration:<name> ledger)
meta(key TEXT PK, value TEXT)                         -- schema_version, plugins:disabled,
                                                      -- plugins:attribution,
                                                      -- plugins:element-owners,
                                                      -- layout:<principalId>
```

Schema version 11 (10 added `plugin_kv`; 11 is the lexicon cut). A migration is SQL, or CODE
when the move is not
expressible as SQL:
migration 9 (solo compositions) rewrites Yjs documents — every `terminal` element becomes a
`portal` onto a newly created solo composition, keeping id, geometry and z-order so
collaborators' element references survive; a terminal already living in a composition was
already homed and is left alone; the retired pool position becomes its composition's
position in the index; then `pads.transient`, `pads.origin_pad_id` and
`sessions.sort_order` are dropped (its body names the pre-rename schema on purpose — replayed
history, allowlisted in `AXIOMS.md` §Lexicon).
Migration 11 (`packages/server/src/migrate-lexicon.ts`) is the lexicon cut applied to durable
state, and it is CODE for one non-stylistic reason: two of the renamed names are DOCUMENT data.
The schema half renames `pads`→`containers`, `pad_folders`→`container_folders`,
`sessions`→`terminals`, every `pad_id`→`container_id` (including inside `scene_docs`' primary
key, which SQLite rewrites itself), `pads.layout`→`containers.discipline` with `'tiled'` becoming
`'composition'`, and rewrites `tokens.caps` to the new capability names so every credential in
existence keeps working. The document half rewrites EVERY revision of every scene document and
every per-principal `layout:<principalId>` value: a leaf's occupant moves from `surface` to `ref`
and `{kind:"pad",padId}` becomes `{kind:"container",containerId}`, plus the one panel id that
moved (`core.shell.pad-view`→`core.shell.container-view`). `TileSchema` is strict, so a document
left alone would fail to parse, `readTileLayout` would answer null, and the next structural write
would seed an EMPTY tree over somebody's composition — renaming the schema without rewriting the
documents is silent data loss, which is why both halves ride ONE transaction.
A code migration declares whether it is recoverable, and
a one-way data move is not: 9 and 11 each take a consistent `VACUUM INTO` snapshot BEFORE the
transaction opens (a VACUUM cannot run inside one, which is also what
makes it a true pre-migration image), skipped only for an in-memory or not-yet-existing
database.
The snapshot lands beside the database as `<db>.pre-v<version>.bak`, so a `manifold.db` opened
at schema 8 leaves `manifold.db.pre-v9.bak` and `manifold.db.pre-v11.bak` once the replay
finishes, and **the operator prunes them**. The server never deletes an elder VERSION's
snapshot: that set is the recovery path for moves nothing can run backwards, and a process
that silently deletes a recovery image is a worse failure than a full disk. The one exception
the engine takes is bounded to a single version — at most the NEWEST snapshot per version
survives, so a migration retried at the same version replaces its own predecessor instead of
accumulating one full copy of the database per attempt. That is safe precisely because it is
same-version: a `pre-v11.bak` can only still be there if 11 never committed, so the live
database still holds every byte the stale image copies. Replacement is staged through a
sibling `<db>.pre-v<version>.bak.partial` renamed over the canonical name BEFORE the
transaction opens (`VACUUM INTO` refuses to overwrite), which is what leaves the image of a
migration that then throws under the documented name rather than a temporary one; an operator
who wants an earlier attempt kept renames it out of that name, where the engine cannot reach
it.

The server snapshots a full encoded Yjs document 1.5s after the last change, at least every
10s under sustained edits, on room eviction, and on graceful shutdown. Loading scans the
newest retained documents and skips corrupt entries. Terminal bytes, presence, cursor,
gesture, and carry frames NEVER touch SQLite.

## Testability (agent-facing)

- **Debug probe** (`packages/plugin/src/debug-probe.ts`, reached by plugin code through
  `@manifold/plugin/hooks`): when `localStorage["manifold:debug"]
=== "1"`, the active container renderer installs `window.__manifold` — READ-ONLY snapshot
  functions (`scene()`, `canvas()`, `outbox()`, `gestures()`, `rev()`, `epoch()`,
  `viewport()`, `renders()`) exposing the browser-canvas↔SDK projection boundary to
  automation. No
  mutation door, no secrets. Consumers: `scripts/verify-convergence.ts`,
  `scripts/verify-public.ts`. The probe exists because this boundary shipped two divergence
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
   nonempty `terminalId`, nonnegative integer `seq`, and string `data` bounded to 700,000
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
