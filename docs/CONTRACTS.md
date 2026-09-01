# Cross-package contracts

This file is the integration authority for manifold's packages. Any change here requires
updating `@manifold/protocol` first, then every consumer, in the same change.
Wire message shapes live in `packages/protocol/src` (zod schemas are the source of truth;
this document explains semantics the schemas cannot).

## Topology

```
browser (web) ──┐
agent SDK ──────┼── WS /ws/session ──► manifold server ── SQLite (data/manifold.db)
tools/tests ─────┘                            ▲  ▲
                                             │  │ WS /ws/instance (outbound from the GUEST
                                             │  │   instance; control only — shares, liveness,
                                             │  │   tickets. No scene, presence or PTY bytes.)
                                             │  └── another manifold server
                                             │ WS /ws/machine (outbound from machine)
                              manifold-agent daemon ── Bun.Terminal PTYs
```

A guest instance's USERS do not ride `/ws/instance`. They point their own lens at the host's
`/ws/session` with a ticket the instance channel obtained for them, so a shared container
projects through the room, the document, the attendance roster and the PTY broker a local
viewer uses. There is no relay and no second sync path (ADR 0014).

- **server** (`packages/server`, entry `src/main.ts`): one Bun process. Serves web dist,
  HTTP API, all three WebSocket endpoints, owns rooms + SQLite.
- **agent** (`packages/agent`, entry `src/main.ts`): separate long-lived process on any
  machine. Owns PTYs. Dials the server. Survives server restarts.
- **web** (`packages/web`): Vite/React client over `/ws/session` via `@manifold/sdk`.
- **sdk** (`packages/sdk`): typed protocol client. The ONLY WebSocket state machine in the
  repo — web, tests, and tools all use it. No parallel implementations. It pools ONE socket
  per (WebSocket factory, url, token) and a `SessionClient` is a channel handle on it, so a
  tab holds one connection no matter how many rooms it renders; the pool owns dialing,
  liveness, reconnect-with-rejoin-every-channel, and demultiplexing.
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

**Cross-instance sharing adds NO variable, and that is a ruling rather than an omission.** An
instance's ORIGIN — the identity a share is minted for, the string a `hello` declares and a
host compares, the value a remote principal carries — is `MANIFOLD_PUBLIC_URL`'s origin and
nothing else. A `MANIFOLD_INSTANCE_ORIGIN` beside it would be a second door onto "how this
instance is addressed", which is invariant 14 in the one place it would be most tempting to
fudge; a deployment behind a proxy configures the URL it already configures. There is no
dial on/off switch either: disabling `core.access` stops new dials, and live ones surviving
that is D4′'s "creation dies, cleanup survives" applying exactly as written.

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
than device memory. Manifest order is the DEFAULT and stays it; a reader who rearranges the
stack in arrange mode (F8) stores their own order as per-principal LAYOUT data — the `sections`
field on the tile holding the sidebar panel, committed at release through
`core.space.setLayout` — so an arrangement follows the principal across devices, a section the
manifests stopped declaring leaves no gap, and a newly contributed section appears after the
arrangement rather than displacing a chosen slot. Folder membership and tree order are durable
server state; sidebar WIDTH
is the workspace layout's root ratio (`core.space.setLayout`), collapse is presence
(`vantage.sidebarCollapsed`, with a device-local mirror for first paint), and terminal-row
visibility plus folder expansion stay device-local (`REGISTRY.md` §Device-local register). The
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

- `Principal { id, kind: "human" | "agent", name, color, origin? }`. Stable; stored in SQLite.
- Every request, and every CHANNEL on a session socket, acts as exactly one principal via
  bearer token; a connection carries one credential's channels, because the SDK pools by
  token.
- **Owner key** = hex-64 secret; acts as a token with cap `*`. Generated on first boot.
- Caps: `*`, `containers:read`, `containers:write`, `scenes:write`, `terminals:spawn`,
  `terminals:write`, `tokens:mint`, `machines:mint`, `plugins:manage`. Reads of scene and
  presence come with `containers:read`. `terminals:write` covers input+resize+kill+take on
  terminals in scope. `plugins:manage` authorizes plugin administration only — the engine
  doors `engine.plugins.setEnabled` and `engine.plugins.purge`.
- Token scope: optional `containerId` restricts everything to one container. It is a subtree
  grant at `manifold://container/<id>`, which is what it always meant; the field did not move.
- Revocation: durable; server closes live sockets of revoked tokens with code 4403 and
  message `revoked`.
- **Expiry** (ADR 0019 §2, schema 15, v20). A token row carries `expires_at`; NULL means
  never, which is what every row written before schema 15 means and what nothing backfills.
  An interactively minted credential gets `INTERACTIVE_TOKEN_TTL_MS` = **14 days**
  (`packages/server/src/auth.ts`, with the reason for the number beside it). Enforced in
  `authenticate` on the rung after revocation, refused `forbidden` with message **`expired`**.
  `TokenGrant.expiresAt?` publishes it at the mint.
- **The two named credential refusals** are the closed set `AUTH_REFUSALS`
  (`revoked`, `expired`), published under `identity.authRefusals` in `GET /api/protocol`. They
  travel verbatim: as the 4403 close reason on `/ws/session`, and as the `forbidden` message
  on the HTTP door. A lens meeting `expired` re-bootstraps; one meeting `revoked` stops. Any
  other `forbidden` from `authenticate` closes with the generic `forbidden`.
- **Machine tokens are exempt, and so are agents' (ADR 0019 §2).** `expiryFor(kind)` answers
  `never` for `kind: "agent"`, and `persistMachine` passes `never` outright;
  `authenticateMachine` has no expiry rung at all, so a machine credential cannot expire by
  two independent constructions. An agent cannot re-authenticate through a browser, so
  shortening its credential is a fleet outage wearing a security hat.
- **The owner key does not expire and is not revocable by a grant.** It is break-glass, and
  break-glass that can lock you out is not break-glass (ADR 0019 §1, §Alternatives rejected).
- **The bootstrap audit** (ADR 0019 §4) leaves EVENT rows, not trace rows:
  `owner_authenticated` — at most one per `OWNER_AUDIT_WINDOW_MS` (**1 hour**), payload
  `{ window }` and nothing else, because `authenticate` runs on every request carrying the key
  and a row per request is a denial of service on the journal's own reader; and
  `principal_bootstrapped { subjectPrincipalId, kind, byOwnerKey }` on every
  `core.access.createPrincipal`. Neither row carries the key or any fragment of it. ADR 0018's
  one-writer rule is untouched: an authentication has no `door`, so it is not a trace, and
  `appendTrace`/`settleTrace` keep exactly the two callers `verify:trace` T1 permits.

### Authority is a waterfall of grants (ADR 0011, shipped)

**Authority is rows, not fields.** A **grant** is
`{ id, principal, node, caps, effect, reach, createdBy, createdAt }`, persisted in `grants`
(migration 13). `principal` is `{ kind: "principal", id }`, `{ kind: "any-human" }`,
`{ kind: "any-agent" }` or `{ kind: "instance", origin }`. `node` is a `manifold://` URI
STRING — the root is the bare scheme `manifold://` (`MANIFOLD_ROOT_URI`), and
`ManifoldRefSchema`'s seven forms are UNCHANGED, so nothing on a wire grew a node kind.
`effect` is `allow` or `deny`; `reach` is `node` (that node alone) or `subtree` (that node and
everything under it). A grant never names an action: actions declare capabilities, grants grant
capabilities, and the two meet at the door.

**Tokens reference grants; they do not carry authority.** `TokenRecord.grant_id` and
`ShareRecord.grant_id` point at the row the credential was minted from — the referrer holds the
reference, so `authenticate()` gains no query and the published `Cap[]` on a `TokenGrant` is
unchanged. Migration 13 turned every existing token's flat caps into exactly one referenced row
(root `manifold://` for an unscoped token, `manifold://container/<id>` for a scoped one, both
`reach: "subtree"`, both `effect: "allow"`), which is why **every pre-migration token answers
every authority question identically after it** — parity is a fixture, not a claim.

**Evaluation.** `AuthService.effectiveCaps(context, node)` walks `containmentPath(node)` —
`manifold://` → `manifold://container/<id>` → `…/element/<id>` or `…/tile/<id>` — collecting the
rows that match the caller's principal or one of its classes, and resolves each capability
independently. The path is SYNTACTIC: containment is read off the URI, so evaluation touches no
store beyond the grant rows themselves.

| #   | Rule                        | Reading                                                                                             |
| --- | --------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | Deeper node beats shallower | An element row beats a container row, which beats a root row. This is what makes a denial local.    |
| 2   | Principal beats class       | `{ kind: "principal" }` beats `any-human` / `any-agent`, which beats `{ kind: "instance" }`.        |
| 3   | `deny` beats `allow`        | At equal depth AND equal specificity only — a named principal's `allow` still beats a class `deny`. |
| 4   | Newer `createdAt` wins      | Ties only, so the relation is total and no answer depends on row insertion order.                   |

Rule 3 sits BELOW rule 2 deliberately: "everyone except this person" is expressed as a class deny
plus a principal allow, and a `deny` that outranked specificity would make that unsayable. `*`
expands to the concrete cap set before comparison, so a deny at depth bites through a wildcard
allow at the root.

**The ceiling rule** (implementation deviation, recorded in ADR 0011's landed addendum): a row
REFERENCED by a token applies only to the credential that references it; an UNREFERENCED row —
everything `core.access.grant` writes, plus a share's row — applies to every credential of the
matching principal or class. Without it, a principal holding both a broad and a narrow token
would see the narrow one inherit the broad one's row: a parity break and a live attenuation hole.
With it, a node-scoped grant genuinely widens or narrows a LIVE credential — observable through
ordinary dispatch, with no re-authentication, because authority is a per-request question and
never cached into a session.

**The owner key is synthesized, never stored.** A context with no token (`tokenId`/`grantId`
`null`) is evaluated against a synthesized root grant (`manifold://`, `["*"]`, allow, subtree),
so no `revokeGrant` can lock the owner out of their own workspace. Symmetrically,
`AuthService.grant` refuses any `deny` row that would match the workspace owner at any node
(`cannot deny the workspace owner`).

**Nothing above the seam moved.** `AuthContext.allows(cap, containerId)` keeps its signature and
all 27 call sites; it maps `containerId` to `manifold://container/<id>` and asks the evaluator.
An ABSENT `containerId` means the credential's own anchor — the root for an unscoped token,
`manifold://container/<containerScope>` for a scoped one — not the root unconditionally, because
`auth.ts` asks `allows(minter, "tokens:mint")` with no node and a container-scoped agent's row
lives at its container: a root walk would refuse the delegated mint that
`packages/testkit/e2e/auth.test.ts` proves. The plugin engine's declared-capability intersection
(ADR 0010) sits unchanged on top of the evaluated set — a manifest's `capabilities` is still a
ceiling on what a plugin's ACTIONS may declare, which is the other side of the intersection
entirely. `packages/server/src/auth.ts` remains the one tagged evaluator call surface
(`REGISTRY.md` floor registry).

**No protocol bump.** The permission waterfall left `PROTOCOL_VERSION` where it found it and all
three compatibility sets untouched: no session, machine or instance frame changed shape. The
grant vocabulary reaches clients through the live action roster, `GET /api/protocol`'s `actions`
block and its `grantContract` block, all three discovered at runtime rather than negotiated, so a
client that never learned the new doors behaves identically.

**`grantContract` (`GET /api/protocol`).** The authority model as data, beside the wire schemas:
`effects` and `reaches` (the two closed pairs), `nodeScheme` (`manifold://`, which the generated
string schema cannot carry — the node's real constraint is the containment walk), `maxNodeLength`,
`maxIdLength`, and JSON Schemas for the row, the principal, the node and each of the three doors'
arguments and answers (`principal`, `node`, `grant`, `createRequest`, `revokeRequest`,
`listRequest`, `listResult`). WHICH rows a workspace holds is not published here — that is
`core.access.listGrants`, and a second copy of a live table is a second thing to keep true.

**Principal origin (ADR 0014, shipped in v18).** `Principal.origin` says WHICH INSTANCE a
principal belongs to, as one normalized absolute `http(s)` base URL
(`normalizeInstanceOrigin`, `packages/protocol/src/origin.ts` — lowercase scheme and host, no
path, no trailing slash, ≤256 chars). It is OPTIONAL and **absent means this instance**, which
is the one representation of local: `null` is refused, so no consumer branches on two spellings
of the same fact, and every pre-v18 payload parses unchanged.

It rides the principal and nothing else. Attendance carries it because an attendance row IS a
principal, and a ticket carries it because a ticket carries a principal; no frame grows a second
origin field. A remote participant is otherwise ORDINARY: the host mints its ticket through the
same attenuation ladder, fences it through the same revocation fanout, and rooms it through the
same `Room`. Invariant 11 across instances — origin is DATA, and nothing downstream of
arbitration may branch on it. Rendering a peer's origin beside its name and color is
presentation of a datum; a "remote flavor" of a cursor, a roster row or a projection is a defect.
The SDK's channel pool keys connections by (factory, url, token), which is the
`(origin, containerId)` keying wave 1 reserved — a lens pointed at a second instance is a second
pool entry and no new client (`AXIOMS.md` §The portable lens).

## HTTP API (JSON; `Authorization: Bearer <token-or-owner-key>`)

| Method+Path             | Auth cap              | Req → Res                                                                                                                                                 |
| ----------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET /healthz            | none                  | → `{ ok, version, protocolVersion, build? }` (`build` is the git SHA baked at build time)                                                                 |
| GET /api/protocol       | none                  | → generated JSON-Schema of all wire messages, plus the published placement, plugin/action, event and grant vocabularies                                   |
| GET /api/attendance     | containers:read       | → `{ attendance: [{containerId, principals}] }` for currently connected OCCUPANTS; scoped tokens see only their container                                 |
| POST /api/actions/:name | per action (declared) | action args → 200 `ActionOutcome`: `{ok:true,result}` or `{ok:false,denial:{rule,message}}`. Refusals are DATA, never non-2xx. THE action door            |
| GET /api/plugins        | any token             | → `PluginRoster` (manifests, `enabled`, `source`, action summaries). Container-scoped tokens included: the roster is vocabulary                           |
| GET /api/layout         | any token             | → `{ layout }` — the CALLER's workspace `TileLayout`, or the default composed from the roster's seats when unset. Self-scoped by construction             |
| GET /api/bindings       | containers:read       | → `{ overrides }` — the CALLER's key rebindings as binding id → key, self-scoped exactly as the layout read is. `core.keys.setBinding` is the only writer |
| GET /api/resolve?uri=   | containers:read       | → `ResolveResponse { uri, ref, exists, title }`; an unparseable or non-`manifold://` uri is 400 `invalid`                                                 |
| GET /api/containers     | containers:read       | → `{ containers: ContainerCensus[] }` (`ContainerCensusResponseSchema`) — what every container holds and points at; the index's whole input               |
| GET /api/introspect     | `*`                   | → live rooms/terminals/machines/principals snapshot                                                                                                       |

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

**Every door answers any origin (issue #109).** `/api/*` and `/healthz` carry
`access-control-allow-origin: *`, allow `GET, POST, DELETE, OPTIONS` with `authorization` and
`content-type`, and answer a preflight `OPTIONS` with 204. Static files do NOT: the shell is
served same-origin only. The reason is the portable lens (`AXIOMS.md` §The portable lens): a
client installed from one instance may be pointed at another (`?instance=<url>`), and a browser
will not let it knock on a door that refuses the preflight. It is safe because a bearer token is
the ONLY authority on these doors — there are no cookies and no ambient session — so
`access-control-allow-credentials` is never sent and `*` cannot widen anything: the permission is
still "whoever holds a valid token".

**`GET /healthz` is the protocol handshake for the browser too.** A client compares its own
compiled-in `PROTOCOL_VERSION` against the `protocolVersion` in that answer and REFUSES to
compose when they disagree, in both directions, rather than dialing a socket that would be closed
4409 forever (`AGENTS.md` invariant 10; `packages/web/src/lens.tsx`). This is what keeps a cached
bundle honest about protocol skew.

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
    `core.terminals.kill { terminalId }`, or `core.space.removeTile { containerId, tileId }` on
    its last
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
(`docs/decisions/0013-plugin-behavioral-contract.md`, per-kind table in `REGISTRY.md`
§Disable semantics).

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

**`core.` is reserved too, and it is the OTHER kind of reservation.** `CORE_NAMESPACE_PREFIX`
(published at `GET /api/protocol` as `coreNamespace`) marks AUTHORSHIP and confers no privilege:
no engine branch anywhere reads it, and a `core.` row is dispatched, authorized, disabled and
purged by the rules a stranger's row is — which is what makes "core is not privileged" a checkable
claim rather than a promise. What the prefix buys is a name: assembly refuses a manifest under
`core.` that the shipped distribution did not register, because an id is what a principal reads on
the roster and what an agent reads over `GET /api/plugins`, so a third party publishing
`core.anything` would read as official to both. The permitted set is DERIVED from the
distribution's registration table (`SHIPPED_PLUGIN_IDS` in `packages/server/src/assembly.ts`) and
handed to assembly as `AssemblyEnv.distribution`; there is deliberately no second list of "our"
plugins anywhere, and a caller that declares no distribution — a unit test, the browser rebuilding
a roster the server already ruled on — has the reservation unenforced rather than inverted.

Assembly KEEPS a disabled plugin's contributions in its registries and reflects the disabled set
only in `roster[].enabled` and `assembly.enabled(id)` (false for unknown ids too): that is what
lets the ladder tell `plugin_disabled` from `unknown_action`, and lets a placeholder NAME the plugin
it is standing in for. Manifest, capability-subset and uniqueness validation runs across every
registered plugin whether enabled or not, so disabling can never mask a collision. Assembly
refuses only STRUCTURAL truths — a missing or disabled `required` dependency, a cycle, a
self-dependency, an `engine.*` squat, an unshipped `core.*` squat, an element-type squat, and (for
ENABLED plugins only) a stored-data downgrade or a missing major migration — so one dormant
plugin's stale rows can never stop the server booting; its data is re-judged at the enablement
door instead.

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
is COMPOSED rather than authored: `composeDefaultLayout(roster)` in `@manifold/plugin` lays the
enabled roster's declared seats (`contributes.seats` — `{ panel, order, ratio? }`, absent ≡ the
plugin seats nothing) out in one row, in seat order, ties broken by full panel id. It takes the
published ROSTER, not an assembly, because that is the document both halves hold — the browser's
boot fallback composes the same tree from the same declaration. `core.shell`
declares the two seats that reproduce the classical workspace (`sidebar` at 0.22, `container-view` at
0.78), so `http.ts` stays floor and names no plugin while nothing has to be injected into it
either — the names come from the manifests and the arrangement is derived (ADR 0017 S17-B). A
roster asking for nothing composes an empty-but-valid root leaf and reports the condition
`unseated`; more seats than a split may hold report `crowded` and seat the first
`MAX_TILE_CHILDREN`. Only the DEFAULT is composed: a stored tree is read out of the store
untouched, so toggling a plugin changes what the next unarranged principal sees and nobody's
arrangement. Its
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

**Leaf removal (`core.space.removeTile`).** `DELETE /api/containers/:id/tiles/:tileId` is
deleted, not aliased. It was the LAST bespoke route that mutated workspace state, and the one
committed mutation the trace ledger never saw (issue #114): it fits none of A6's three
exemptions, so the honest fix was to make it what it always was — a discrete
authority-bearing mutation, therefore an action. `core.space.removeTile { containerId, tileId }`
→ `{}` carries `containers:write` at the default workspace scope (the route refused
container-scoped callers by hand) and is `cleanup: true`, for `core.terminals.kill`'s reason:
closing a tile and killing from the sidebar are the same write, so a disable may not reach one
and leave the other. The route's two statuses are now `refused` denials carrying its own
sentences — `not_found: tile not found`, `conflict: tile is not removable` — which is the
`core.space.place` move again: a refusal is data, so every outcome answers 200. What did not
change: removal is still NOT a placement (nothing accepts "nowhere" for a leaf), a terminal's
last leaf still reaps the terminal, and a composition emptied BY a departure still retires
while an empty root stays put. The commit announces `tile_removed` on the container that held
the leaf — `item_placed`'s mirror.

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
routes are deleted, and so is `DELETE /api/containers/:id/tiles/:tileId` — leaf removal is
`core.space.removeTile` (§Leaf removal above), which is not a
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

`core.machines.revoke { machineId }` carries `machines:mint` at the default workspace scope and
answers `{ revoked: 0 | 1 }`; it is **`cleanup: true`**. It is the door ADR 0019 §3 named as
missing: `list` and `enroll` were the whole vocabulary, so a credential minted for a process
nobody in the workspace can see could be REPLACED (`enroll { rotateToken: true }`) but never
taken away. It revokes the token the machine row references, writes `token_revoked`, and severs
the live machine socket through the same `AuthService.onRevoked` fence a principal's revocation
rides — and it mints nothing, which is the difference from a rotation. **The inventory row
survives**: withdrawing a credential and forgetting a box are different verbs, so the machine
stays listed with `revoked: true` and comes back through `enroll { rotateToken: true }`. One
door, one concept — there is no second spelling of "revoke this machine's credential"
(invariant 14) — and it carries `machines:mint` rather than a new cap because minting and
withdrawing a machine credential are one authority.

A machine summary carries an optional **`revoked`** (absent ≡ live, so a pre-v20 row parses
unchanged), derived from the token the row references by one store join
(`ServerStore.revokedMachineIds`).

A machine summary now carries an optional **`color`**, derived server-side by `identityColorFor`
over the shared `IDENTITY_COLORS` palette — both exported from `@manifold/protocol`
(`packages/protocol/src/principal.ts`), with the web layer re-exporting the palette rather than
declaring a second copy. Presentation that was derived per client is wire data now, which is what
lets any principal render the same badge.

**Access administration (`core.access`).** `POST /api/principals`, `POST /api/tokens` and
`POST /api/tokens/revoke` are deleted; the identity MECHANISM (hashing, bearer authentication,
attenuation, the revocation fence) stays floor and unchanged. The three doors, plus the five
cross-instance ones below:

| Action                        | Caps          | Scope     | Args → Result                                                                |
| ----------------------------- | ------------- | --------- | ---------------------------------------------------------------------------- |
| `core.access.createPrincipal` | `*`           | workspace | `{ name, color?, kind? }` → `TokenGrant` (caps `["*"]`, `containerId: null`) |
| `core.access.mint`            | `tokens:mint` | container | `{ principal \| principalId, caps, containerId? }` → `TokenGrant`            |
| `core.access.revoke`          | `tokens:mint` | container | `{ principalId }` → `{ revoked: <count> }` — **`cleanup: true`**             |
| `core.access.listCredentials` | `tokens:mint` | workspace | `{}` → `{ principals: PrincipalCredentials[] }`                              |

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

**Sharing across instances (`core.access`, ADR 0014).** A **share** is a token bound to a node
and minted for a named guest **origin**; a **dial** is the guest's side of one accepted share.
No new capability: a share hands authority out, so it declares the cap that already means that.

| Action                    | Caps               | Scope     | Args → Result                                                           |
| ------------------------- | ------------------ | --------- | ----------------------------------------------------------------------- |
| `core.access.mintShare`   | `tokens:mint`      | container | `{ node, caps, origin }` → `ShareGrant { share, token }` — raw ONCE     |
| `core.access.revokeShare` | `tokens:mint`      | container | `{ shareId }` → `{ revoked: <tickets severed> }` — **`cleanup: true`**  |
| `core.access.listShares`  | `tokens:mint`      | container | `{}` → `ShareInventory { shares, dials }` — both directions, no secrets |
| `core.access.dialShare`   | `containers:write` | workspace | `{ origin, token }` → `Dial`; BLOCKS on the host's welcome              |
| `core.access.openDial`    | `containers:read`  | workspace | `{ dialId }` → `DialTicket { origin, ref, caps, token }`                |

`node` is a `manifold://` reference, never a bare container id (invariant 13); a ref that is not
a container is refused `only a container can be shared`, which is the one rung these handlers
own — everything else is `mint`'s ladder, run by the mechanism on the real caller. The two guest
doors are `scope: "workspace"` because a dial names a node at ANOTHER instance, so a
container-scoped token here is scoped to something the dial cannot be inside. `dialShare` waits
for the host to say what the share names (ten seconds, then `conflict` `host did not answer`)
because a `Dial` that named nothing yet would be indistinguishable from a live share that
happens to be offline; an unanswered attempt is deleted, not revoked.

`openDial` is the guest's own authority question — may THIS principal use this dial — and its
answer is a per-principal TICKET the host minted, never the share secret. Every admitted
principal gets the share's full caps this wave; narrowing per remote principal is a grant
question (ADR 0011). Three lifecycle events (`dial_online`, `dial_offline`, `dial_revoked`) are
declared by this plugin and emitted by the floor on `manifold://plugin/core.access`, which is
`machine_online`'s split: a socket coming up is nobody's commit point.

A share's caps become a GRANT ROW on the shared node at mint (ADR 0011 §Tokens become grant
references): `{ principal: { kind: "instance", origin }, node: "manifold://container/<id>",
caps, effect: "allow", reach: "subtree" }`, referenced by `ShareRecord.grant_id`. Ticket
attenuation is then grant subsetting by construction — a ticket is an ordinary token minted with
the share's caps at the share's node, so it can never exceed the row its share stands on.
`revokeShare` DELETES that row in the same transaction that marks the share revoked (and nulls
`grant_id`; the share stays listable and auditable), so a revoked share confers nothing even
before its tickets are severed. A grant presents no credential, so absence of the row IS its
revocation — `revoked_at` exists on tokens and shares only because a bearer secret already
handed over has to keep being refused. This is the field ADR 0011 left inert until wave 3:
`principal.kind === "instance"` has a real value now.

**Grant administration (`core.access`, ADR 0011).** The rows themselves, through the plugin the
ADR named. No new capability — `*` and `tokens:mint` already answer "who may hand authority
out", and a `grants:manage` would be a second answer to one question.

| Action                    | Caps | Scope     | Args → Result                                                                       |
| ------------------------- | ---- | --------- | ----------------------------------------------------------------------------------- |
| `core.access.grant`       | `*`  | workspace | `{ principal, node, caps, effect, reach }` → `Grant` (the whole row, `id` included) |
| `core.access.revokeGrant` | `*`  | workspace | `{ grantId }` → `{ revoked: 0 \| 1 }` — **`cleanup: true`**                         |
| `core.access.listGrants`  | `*`  | workspace | `{ node?, principalId? }` → `{ grants: Grant[] }`                                   |

Every shape in that table is published as JSON Schema under `grantContract` at
`GET /api/protocol` (`grantVocabulary()`, `packages/protocol/src/grants.ts`), so an agent learns
the three doors' arguments — and that `effect` and `reach` are closed pairs with no default —
without reading this file. `grantId` is bounded at the ROW's id width (160), not 128: a revoke
argument is an id `GrantSchema` produced, and migration 13's derived
`grant-token-<tokenId>` ids overflow the narrower bound.

All three are ROOT-ONLY, which is stricter than `mint`, and the reason is `deny`. Minting
attenuates monotonically — a minter hands out a subset of what it holds — but a deny row takes
authority away from somebody else, and by precedence rule 1 a deny at a container beats an allow
at the root. A container-scoped `tokens:mint` holder could otherwise deny the owner inside the
owner's own container. ADR 0011 defines attenuation for minting and says nothing about
attenuating a denial, so the unwritten rule is read narrowly until the operator rules; grading
these `tokens:mint` later widens the door without moving it, since no argument, result or
refusal changes shape. The mechanism closes the same hole independently
(`cannot deny the workspace owner`), because a door and a mechanism disagreeing about who may
write authority is invariant 14 failing.

`scope: "workspace"` is FORCED, exactly as it is for the two guest doors: the argument is a
`manifold://` node URI that may be the root itself, and a container-scoped token is scoped to a
local container id the root is not inside. `revokeGrant` is `cleanup: true` for `revoke`'s
reason — a grant that should not exist is the administrative analogue of a leaked token, and an
administrative toggle must never be what keeps it alive; `0` is a success, meaning the row was
already gone. It refuses a TOKEN-REFERENCED row (`a token's grant is revoked by revoking the
token`): a credential's own row is that credential, and deleting it out from under a live token
would leave a bearer whose authority came from nowhere. `listGrants` is `core.access`'s first
read door and converts nothing: a grant row had no other door onto it, so this is the only way
to see what decides every other answer. The floor records `grant_created` and `grant_revoked` in
the `events` table, `token_minted`'s precedent — audit rows, not manifest-declared event kinds.

**The journal and its two families (`core.events`).** ONE durable append-only table, `events`,
holding two row families read through one door. **Event rows** are the durable half of a
notification — `principal_joined`, `principal_left`,
`terminal_opened`/`renamed`/`bound`/`exited`, `token_minted`, `token_revoked`,
`grant_created`/`grant_revoked`, and — since ADR 0019 §4 — `owner_authenticated` and
`principal_bootstrapped` — recorded since the first migration. **Trace rows** are axiom
A6's ledger: one row per exercise of authority at a door, appended by the dispatch ladder
(schema 14, ADR 0018). Both are pruned by the same policy — 30 days, 10,000 rows per container,
and 100,000 rows in the container-less bucket (that last ceiling arrived with the ledger: a
workspace-grade dispatch's trace belongs to no container, and those arrive per dispatch rather
than per token mint) — and both come back from the same read:

| Action             | Caps | Scope     | Args → Result                                                                                             |
| ------------------ | ---- | --------- | --------------------------------------------------------------------------------------------------------- |
| `core.events.list` | `*`  | workspace | `{ limit?: 1..500, kind?: string(1..64), containerId?: string }` → `{ events: EventRow[] }`, newest first |

`EventRow` is
`{ id, containerId: string\|null, ts, principalId: string\|null, type, payload, door: string\|null, authority: string\|null, targets: string[], outcome: string\|null, session: string\|null }` —
camelCase, with `payload` carried as the stored JSON TEXT because no schema declares what a given
event type's payload holds, so a reader decides what to parse and a malformed row still reads as a
row. The filter's word is `kind` while the row publishes `type`: the filter is the caller's
question, the row is the column's own name.

**The five trace fields are `door`-discriminated**: an event row carries `door: null`, no
authority, no outcome, no session and an empty `targets`; a trace row carries all five and
`type: "trace"`, so `{ kind: "trace" }` IS the ledger and nothing has to be inferred from a NULL
check. `door` is the full action name; `authority` is what the ladder discharged (`root`, the
declared caps joined by `+`, or `open` for a door that demands nothing); `targets` are the
`manifold://` nodes the door named, read off the same emissions the event plane carries and
published PARSED because the ladder is their only writer; `outcome` is `ok`, `failed`, or the
denial rung (`TRACE_OUTCOMES` in `@manifold/protocol`), and NULL means the dispatch was still in
flight — the ledger is written AHEAD of the handler, so an unsettled row is a dispatch that never
came back rather than a row somebody forgot to finish; `session` is the socket it arrived on, NULL
meaning the HTTP action door. The `payload` of a trace row is the ARGUMENTS as received, run
through the same field redaction the JSONL log applies (no `token`/`key`/`authorization`/`secret`,
no `data`/`env`/`payload` — invariants 5 and 6) and bounded at 4 KiB, past which the row keeps
`{ oversize, keys }` instead of the bytes.

**Refusals are traced and unregistered names are not.** Every denial rung the ladder can answer
with lands in the ledger; `unknown_action` does not, because there is no door, no declared
authority and nothing to attribute, and because the name is caller-chosen — a ledger a stranger
can write arbitrary `door` values into is a denial-of-service surface (ADR 0018 §4). It stays
observable in the structured `action` log line. `verify:trace` (T1-T5, `REGISTRY.md` §Gates)
asserts both halves against the real composed server.

`*` is root-only and deliberate. The trail is workspace-wide and carries OTHER principals'
activity; no cap in the vocabulary means "may read other people's history", and reusing
`containers:read` would hand every share-link holder a surveillance feed. `scope: "workspace"`
follows: a container-scoped token is refused at rung 3 before arguments are parsed, so the
`containerId` filter is a narrowing for a caller who could already see everything rather than a
way out of a container — which is why the handler owes `ctx.outsideScope` nothing. `limit` is
bounded at the schema instead of clamped, so the maximum is published in the roster's JSON
Schema; reading past 500 rows needs paging, and paging needs a cursor this wave does not invent.

The ledger inherits that ruling verbatim, which is half the reason it is a row family here
rather than a table with a door of its own: a trace names who exercised what, so a second read
door would be a second place to get the authority question wrong (invariant 14). Traces are also
deliberately NOT subscribable — the event plane carries what a door announced, not the record of
its being allowed to.

`core.events` contributes no panel, section, element or tool — a door-only plugin, like
`core.access`. It is not `essential`: the rows keep accruing while it is off (a disable retains,
ADR 0013 §1) — trace rows included, because the ladder writes them through the store rather than
through this plugin — so re-enabling restores the whole trail.

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

**Frame grammar (v19).** One socket per tab, many rooms. Every frame is either
connection-level or channel-level. v19 changed exactly one pair: the liveness frames now point
the way every dialed pipe points — the server asks `ping`, the client answers `pong` (§Liveness
below) — and the v18 spellings of that pair (client `ping`, server `pong`) are gone, which is
why this is a bump rather than an addition.

```
connection-level   client → server  {"type":"pong"}
                   client → server  {"type":"subscribe","topics":[…]}
                   client → server  {"type":"unsubscribe","topics":[…]}
                   server → client  {"type":"ping"}
                   server → client  {"type":"plugins","roster":[…]}
                   server → client  {"type":"event","topic":{…},"kind":"…","at":…,"actor":…,"payload":{…}}
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
`CONNECTION_BODIES` and `CLIENT_CONNECTION_BODIES` beside the channelized `SERVER_BODIES` and
`CLIENT_BODIES`, and they carry no `ch` because the thing they concern is the connection
itself. `plugins { roster }` was the first such server→client frame: it is delivered once when
the socket opens (before any `join`) and again whenever the roster changes, which is what makes
enable/disable hot for every open tab. The SDK pool demultiplexes connection frames to
pool-level listeners (`SessionClient.onPlugins`, which replays the latest roster to a late
subscriber) instead of dropping them as frames for an unknown channel.

**The event plane (v17, ADR 0012).** `subscribe`/`unsubscribe { topics: ManifoldRef[] }` declare
and withdraw interest; `event { topic, kind, at, actor, payload }` is one notification. All three
are connection-level because a TOPIC IS A NODE — routinely a node no channel on this socket has
joined — and topics travel as structured refs rather than `manifold://` strings, so the wire has
nowhere to carry a hand-typed address and the namespace needs no registry
(`REGISTRY.md` §Runtime-joined namespaces). `kind` is snake_case (`EventKindSchema`) and must be
DECLARED by the emitting plugin's `contributes.events`; the assembly indexes those declarations
and refuses an undeclared emission by name, so the vocabulary a live workspace emits is closed
and published while the vocabulary a build may declare stays open. Subscribing is a READ of the
topic's node, discharged with the same authority the resolve door uses; a topic this credential
may not read is simply not subscribed, because a per-topic refusal frame would make the plane a
permission oracle. There are no offsets, acknowledgements or replay: an event reaches the sockets
subscribed AT THE INSTANT OF EMISSION and catch-up is reading state back through the ordinary
door. Subscriptions are presence-class state — they die with the socket, and the SDK pool
re-declares every live topic after each rejoin (never before it: the credential arrives on
`join`). Bounds: `MAX_SUBSCRIBE_TOPICS` (64) topics per frame, over which the frame is malformed
(4002), and `MAX_SUBSCRIPTIONS_PER_CONNECTION` (256) per socket, past which further topics are
dropped and logged with the socket left alone.

**Which subscription hears which event** is `topicMatches(subscribed, topic)`, published by
`@manifold/protocol` and used by BOTH halves — the server to pick sockets, the SDK to pick
handlers. It is SELF plus exactly the one hop the address grammar states: a subscription to
`container/<c>` hears `container/<c>` and that container's `element`/`tile` leaves, because an
element and a tile have no identity outside their container. Nothing else nests — a terminal, a
principal, a plugin and an action are all roots — so the relation is total over the seven forms
and needs no store to answer, which is precisely why it can be the one rule on both sides.
Authority is a different question, asked with the store in hand at subscribe AND again per
subscriber at delivery, and it can only ever narrow this.

**Where an event is addressed.** To the most specific node that exists both before and after it.
When the subject is being created or destroyed, or has no `manifold://` form at all (a machine, a
folder), that node is its COLLECTION: `manifold://plugin/<owner>`, which is also the only plugin
node the emission check lets that plugin address. So a container created, a terminal opened, a
machine enrolled and a principal joining are all collection-addressed, and one subscription to a
plugin's node is how a client watches everything that plugin originates.

**And it is DELIVERED at two addresses**, the node it named and its door's collection, because
that last sentence has to be true for the emissions that name a node as well. A placement is
addressed to the destination container, and the readings it moves are taken from chrome OUTSIDE
every room they report on: the index's top level and both terminal rosters, whose `unplaced` is
DERIVED from the containment graph and whose newly born compositions have ids no subscriber
could have named in advance. So `manifold://plugin/<owner>` means what a collection subscription
already assumes — everything that plugin's doors announced — and a room subscription is
unchanged. It is one emission, not two: ONE audit row, and one frame per socket, since the
audience is a set of sockets across both addresses with the named node offered first. Each
socket receives the frame under the address that REACHED it, so `topicMatches` routes it on the
client with no second rule. Authority is re-discharged against the SAME container at both
addresses, so the collection can only ever narrow, never widen, who hears a room's news.

**What a subscriber owes itself.** An event says something happened; it is not the new state, and
nothing is replayed. A consumer that needs the state READS it, through the same door a fresh
client uses — which is why the browser's shared feeds
(`@manifold/plugin/hooks`, `usePolledResource`) still hold exactly one fetch function and traded
only their cadence: one initial read at mount, then one read per burst of matching events, and a
content compare so an unchanged answer reaches no subscriber. The cadence is NOT removed — it is
the documented fallback, and it runs in exactly two states: while the socket is down (the
reconnect gap, because a client with no channel learns nothing by waiting) and while a feed has
no topics at all (the roomless workspace root of an instance with no containers). It never runs
beside a live subscription; the two are mutually exclusive by construction, and `mode: "events"`
is precisely the state in which no timer exists. `REGISTRY.md` §Budgets is the ceiling that keeps
that honest — every network row is ZERO at idle.

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

**Liveness (v19, issue #55).** The session channel is a DIAL like the machine and instance
channels, so it runs their one scheme rather than a second (invariant 14) off the same
constants. After a socket's FIRST surviving join the server sends `ping` every
`DIAL_PING_INTERVAL_MS` (30s) and closes 4008 `liveness timeout` when a ping is still
unanswered as the next one fires, bounding detection at two intervals; the close runs the
ordinary close path, so room membership, presence entries and terminal viewers are released
exactly as a clean disconnect frees them. Before that first join nothing is pinged — the
ten-second join deadline is already the whole answer for a socket carrying no room. The
client never generates a heartbeat: it answers `pong`, and when it hears NOTHING for
`DIAL_LIVENESS_TIMEOUT_MS` (75s — two intervals plus grace) it closes 4008 itself and heals
through the reconnect-and-rejoin path it already owns, rather than waiting on an OS that may
never notice. ANY inbound frame resets that deadline, room traffic and pings alike: what it
watches is the TRANSPORT, not the pair.

Which side asks is not a coin flip. A background tab's timers are throttled to roughly one
firing per minute, so a reap keyed on pings the BROWSER generates would close tabs that are
perfectly alive, while answering an inbound ping rides the message event and is throttled by
nothing. A late watchdog only detects late, which is harmless; an eager reap is not. Before
v19 the pair pointed the other way and neither side enforced a deadline, so a half-open
socket — a slept laptop, a wifi handoff, a discarded tab — stayed registered for the life of
the process and inflated every presence count that named it.

**Refusal scope.** A refusal closes the whole SOCKET when it invalidates the credential or
the framing itself, and ONE CHANNEL — a `channel_closed { code, reason }` frame, socket
untouched — when it concerns one room:

| Code      | Scope   | Cause                                                                                                                   |
| --------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| 4401      | socket  | bad token                                                                                                               |
| 4403      | socket  | forbidden, or revoked (a revocation fences every live connection of that principal)                                     |
| 4409      | socket  | protocol version mismatch                                                                                               |
| 4002      | socket  | malformed frame of a KNOWN type, non-`join` first frame, duplicate `ch`, or the join deadline elapsing with no channels |
| 4008      | socket  | liveness timeout: the server's `ping` still unanswered as the next fires, or the client's silence deadline elapsing     |
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
terminal snapshots and output, and may send `leave`, `resync_request`, `pong`,
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
  container (`not_accepted`). A panel leaf may additionally carry `sections: string[]` — the
  reader's own arrangement of the sections that panel hosts, which is why the field is legal on
  a panel leaf and nowhere else. `validateTileLayout` gates every read: root exists, child
  references resolve, nothing is reachable twice, ratios stay parallel to children, refs
  sit on leaves only, a `sections` arrangement sits on a panel leaf and names each section at
  most once, and a container never tiles itself; unreachable tiles are inert garbage
  the next structural write prunes. Ratio drags are CRDT writes (`setTileRatios` through the
  SDK); every STRUCTURAL mutation goes through a door — the actions `core.space.place` and
  `core.space.removeTile` — applied under `SERVER_PLACE_ORIGIN`, which client undo managers never track.
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
  `vantage { tool?, editingElementId?, focusedContainerId?, sidebarCollapsed?, arranging?, arrangeScope? }`
  is written by the
  CLIENT through the same throttled presence writer as every other field and dies with the
  connection, so a peer can see which tool somebody holds, what they are editing, whether
  their sidebar is open, and whether they are in ARRANGE MODE (F8: the workspace's panes stop
  taking pointer input and one arrangement's parts become reachable). It is
  descriptive, never authoritative: nothing downstream branches on whose vantage it renders,
  and every arrangement arrange mode produces — a section order, a moved panel — commits
  through `core.space.setLayout` like any other layout write.
- **Arranging is SCOPED, and the scope is a panel ref.** `arrangeScope` names the panel whose
  own parts are reachable right now; ABSENT ≡ the root, where the workspace's panels are. One
  scope is live at a time. Which panels offer an inner arrangement is PUBLISHED BY THE PLUGIN,
  never known to the floor: a manifest's `contributes.panels[].arranges { title }` says "this
  panel contains an arrangement, and this is its name", the workspace draws a way in labelled
  with that name, and it learns nothing else. Escape pops one scope level and leaves the mode
  at the root; F8 leaves from anywhere and always arms at the root. Both fields are
  additive-optional: a frame that carries neither is a client that never arranges, and a frame
  carrying only `arranging` means "arranging, at the root" — exactly what it meant before the
  scope existed.
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
- **A cursor is retracted, not just stopped.** A pointer leaving the rendering surface, or a
  tab going hidden, publishes `presence { cursor: null }` — the payload's existing "null
  clears" form, on the same ordered channel as the motion it ends, never a frame type of its
  own. Viewers drop exactly that `(principalId, connId)` cursor and leave the sender's sibling
  tabs alone. The backstop for a goodbye that never got sent (a socket cut mid-motion) is
  `CURSOR_TTL_MS` (30s) since the last frame. It sits an order of magnitude above
  `GESTURE_TTL_MS` because the silences differ: a gesture is motion by definition, while a
  cursor emits only while it MOVES, so silence is the ordinary state of a resting pointer and
  the bound must outlast a reading pause rather than a send interval.

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
  never reference terminals. Session protocol v17.

## WS /ws/machine — machine channel (JSON; `data` fields base64)

Handshake: agent sends `hello { token, name, agentVersion, protocolVersion, terminals }`
where `terminals` advertises retained PTYs
`{ terminalId, cols, rows, alive, seq, exitCode? }` (server-restart adoption). An
`alive:false` advertisement reports a real `exitCode` when the PTY exited while
disconnected; absence is equivalent to `null`. Such exited terminals are retained through
the next `hello`, then forgotten when `welcome` acknowledges it (or when `kill` arrives).
Server replies `welcome { machineId, serverEpoch }` or closes: 4401 unauthorized,
4403 revoked, 4409 version. Version acceptance is the
`MACHINE_PROTOCOL_COMPAT_VERSIONS` set `{16, 17, 18, 19}` (protocol/version.ts), NOT strict equality:
agents are long-lived and survive server deploys, so every compatible agent version stays
accepted (session/browser joins remain strictly current). An unchanged agent wire adds the
new version to the set; a strictly additive-optional change also adds it when every old
frame still parses and the absent-field default reproduces pre-bump semantics. Any other
agent-wire change resets the set to the new version and requires a coordinated fleet
restart — which v16 did: `terminal_event`, `TerminalInfo` and `MANIFOLD_CONTAINER` renamed
the agent wire, so the set was reset to v16 alone and the fleet restarted together. v17, v18
and v19 are all the other case and ADDED: the event plane is session-only, cross-instance
sharing is a channel of its own (`/ws/instance`, its own `INSTANCE_PROTOCOL_COMPAT_VERSIONS`
set), and v19 reoriented a SESSION frame pair — so `AgentMessage` and `ServerToAgentMessage`
are byte-identical across all three bumps (an agent never sees a `Principal`, and therefore
never sees `origin`, nor any session frame) and a v16 agent keeps its terminals across any of
those deploys. Every
rejection path emits a structured server log (`machine_version_rejected`,
`machine_rejected`, …) — silent closes are how a whole fleet goes dark undiagnosed.

The unknown-NEWER direction is the one with no recovery, and it is the operator-facing failure
mode. A hub cannot accept a protocol version that did not exist when it was built, so an agent
whose `protocolVersion` falls outside `MACHINE_PROTOCOL_COMPAT_VERSIONS` is closed 4409 on every
dial and re-dials with jittered backoff indefinitely rather than exiting: the refusal is permanent,
and from the spoke's side it is silent. systemd keeps reporting the unit `active (running)`, so
unit state is NOT evidence the agent is on the canvas — the evidence is the agent journal's
`protocol_version_rejected` (logged at error, with the close code, on every rejected dial) and the
server's `machine_version_rejected`, which carries both versions. The guard is not in the handshake,
it is in release
discipline: `bun run release` publishes the agent binary and the fleet picks it up, so publishing a
release is a fleet action (AGENTS.md invariant 10) and the hub ships at or ahead of any release
whose `PROTOCOL_VERSION` exceeds the deployed one.

Server→agent: `create { terminalId, cols, rows, cwd?, env }`, `input { terminalId, data }`,
`resize`, `kill`, `snapshot_request { terminalId }`, `ping`.
Agent→server: `created { terminalId }` | `create_error { terminalId, message }`,
`output { terminalId, seq, data }` (seq: monotonic per terminal, assigned at emission),
`snapshot { terminalId, seq, data }`, `exited { terminalId, exitCode }`, `pong`.

Liveness, server half: after `welcome` the server sends `ping` every
`DIAL_PING_INTERVAL_MS` (30s); a ping still unanswered when the next fires closes the
socket (4008 `liveness timeout`), so a frozen or partitioned agent (laptop sleep, dropped
network) is marked offline within two intervals — TCP alone would keep it "online"
indefinitely. Agent half: a healthy connection carries those pings even when idle, so the
agent closes and re-dials after `DIAL_LIVENESS_TIMEOUT_MS` (75s) of total silence —
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

## WS /ws/instance — instance channel (JSON text frames; ADR 0014)

The CONTROL link between two instances, and only the control link. A guest dials OUT to a
host, exactly as a machine agent dials out, and the socket carries three things: proof the
guest holds a share, liveness, and per-principal tickets. **No scene, presence or PTY bytes
ever cross it.** A guest's users project by pointing their own lens at the HOST's
`/ws/session` with a ticket obtained here, which is why a shared container renders through
the same room, document, attendance roster and PTY broker a local viewer uses — one door per
concept (invariant 14), and no second sync path.

Handshake: guest sends `hello { protocolVersion, origin, instanceVersion, token, tickets? }`.
`token` is the raw share secret (the host stores only its SHA-256). `origin` is the guest's
own `MANIFOLD_PUBLIC_URL` origin and MUST equal the origin the share was minted for —
mismatch closes 4401 `origin mismatch`, because the credential is not valid as presented.
That comparison is what makes a principal's `origin` trustworthy DATA rather than a claim,
which invariant 11 depends on. `tickets` is RESUME, carried on the hello exactly as a machine
hello advertises retained PTYs: the host-side ticket principals the guest believes it still
holds. There is no separate resume frame.

Host replies `welcome { origin, serverEpoch, shareId, ref, caps, title, tickets }` — `ref` is
the shared node in the HOST's address space and `origin` says whose space that is; the pair
IS the cross-instance reference. `tickets` answers with the subset of the advertised ones
still live, and the guest drops the rest. Or the host closes: 4401 unauthorized / origin
mismatch, 4403 revoked, 4409 version, 4002 malformed or first-frame-not-hello or duplicate
hello, 4008 liveness timeout, 4001 superseded. Version acceptance is
`INSTANCE_PROTOCOL_COMPAT_VERSIONS` `{18, 19}` — its own wire, its own set, the same
invariant-10 discipline the machine channel follows.

Guest→host: `pong`, `ticket_request { requestId, principal }` — the guest's OWN principal
verbatim; the host mints its own mirror id and never adopts a foreign one, because two
instances' id spaces are independent.
Host→guest: `ping`, `ticket { requestId, token, principal }` — an ORDINARY attenuated token
for an ordinary host-side principal whose `origin` is the guest's; that is the whole of
federation — or `ticket_error { requestId, reason }` with `reason` ∈ `share_revoked` |
`invalid_principal` | `unavailable`. Refusals are data, never a dropped request.

Liveness is the machine channel's, not a second scheme: after `welcome` the host pings every
`DIAL_PING_INTERVAL_MS` (30s) and closes 4008 when a ping is still unanswered as the next one
fires; the guest closes and re-dials after `DIAL_LIVENESS_TIMEOUT_MS` (75s) of total silence.
Re-dial uses jittered backoff. A 4403 STOPS re-dialing and marks the dial `revoked` — an
unreachable host is a transport problem worth retrying, a revoked share is a decision.

**One dial is one share.** The token authenticates the share, so there is no share id in a
ticket request and no catalogue frame; a second share to the same origin is a second token
and a second dial. Per-origin pairing would need an instance-level principal, which is new
authority semantics and belongs to ADR 0011's waterfall.

Revocation cuts BOTH credentials through their own fences: `core.access.revokeShare` marks
the share row revoked durably, revokes every ticket principal it minted — which closes those
principals' live `/ws/session` sockets through the ordinary revocation fence — and closes
this control link with 4403. Nothing cross-instance is added to the session path to make that
work; a ticket is a token, and tokens were always revocable.

Every rejection emits a structured log (`instance_rejected`, `instance_version_rejected`,
`instance_liveness_timeout`, `instance_ticket_refused`, …). Guest-side status transitions
emit `dial_online` / `dial_offline` / `dial_revoked` on the event plane, declared by
`core.access` and emitted by the floor for the reason `machine_online` is: a socket coming up
is not a commit point any action owns.

## Persistence (SQLite, WAL; server-only)

```
containers(id TEXT PK, name TEXT, created_at INTEGER, sort_order INTEGER, folder_id TEXT,
     discipline TEXT NOT NULL DEFAULT 'canvas')        -- canvas | composition
container_folders(id TEXT PK, name TEXT, created_at INTEGER, parent_folder_id TEXT,
            sort_order INTEGER)
scene_docs(container_id TEXT, epoch TEXT, rev INTEGER, ts INTEGER, hash TEXT, doc BLOB,
           PRIMARY KEY (container_id, epoch, rev))     -- keep newest 30 valid docs each
events(id INTEGER PK AUTOINCREMENT, container_id TEXT, ts INTEGER, principal_id TEXT,
       type TEXT, payload TEXT,
       door TEXT, authority TEXT, targets TEXT, outcome TEXT, session TEXT)
                            -- THE JOURNAL, two row families. door IS NULL: an event row
                            -- (lifecycle/caps/join-leave). door IS NOT NULL and type='trace':
                            -- axiom A6's ledger — one exercise of authority at one door, with
                            -- the authority discharged, the manifold:// nodes it named (JSON
                            -- array), its outcome (NULL = in flight), and the session it
                            -- arrived on (NULL = the HTTP action door). One retention for both
principals(id TEXT PK, kind TEXT, name TEXT, color TEXT, created_at INTEGER, origin TEXT)
                            -- origin NULL means THIS instance; a remote principal carries
                            -- the guest origin its share was minted for
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
shares(id TEXT PK, hash TEXT UNIQUE, container_id TEXT, caps TEXT, origin TEXT,
       minted_by TEXT, created_at INTEGER, revoked_at INTEGER)  -- HASH only, never raw
share_tickets(share_id TEXT, guest_principal_id TEXT, principal_id TEXT, created_at INTEGER,
              PRIMARY KEY (share_id, guest_principal_id))
                            -- WITHOUT ROWID; the dedupe map from one of the GUEST's
                            -- principals to the host-side principal minted to stand for it.
                            -- Not a second identity system: principal_id is an ordinary
                            -- principal with an ordinary token, which is why revocation,
                            -- the doors and attendance need no cross-instance special case
dials(id TEXT PK, origin TEXT, secret TEXT, ref TEXT, caps TEXT, title TEXT,
      dialed_at INTEGER, revoked_at INTEGER)            -- UNIQUE(origin, secret)
                            -- The GUEST half. `secret` is RAW here, and the asymmetry with
                            -- shares.hash is the design: a host only VERIFIES a presented
                            -- secret, which a hash does; a guest must PRESENT one, which a
                            -- hash cannot. `ref`/`caps`/`title` are the host's last word,
                            -- cached to draw a row while the socket is down — never an
                            -- authority the guest evaluates. `ref` is NULL only between the
                            -- row's creation and the first welcome
meta(key TEXT PK, value TEXT)                         -- schema_version, plugins:disabled,
                                                      -- plugins:attribution,
                                                      -- plugins:element-owners,
                                                      -- layout:<principalId>
```

Schema version 14 (10 added `plugin_kv`; 11 is the lexicon cut; 12 is cross-instance sharing
— `shares`, `share_tickets`, `dials` and `principals.origin`; 13 is the permission waterfall's
`grants` substrate; 14 is the trace ledger — five nullable columns on `events`). Migrations 12
and 14 are plain SQL for the same reason: neither touches a stored document and existing rows
need no backfill, since absence already means the right thing — a NULL origin means "this
instance", and a NULL `door` means "this row is an event, not a trace". Neither takes a
pre-migration snapshot, and that is the house rule rather than an exception to it: the snapshot
belongs to a one-way DATA move (9, 11, 13), and adding nullable columns is reversible by a later
migration that drops them. A migration is SQL, or CODE
when the move is not
expressible as SQL:
migration 9 (solo compositions) rewrites Yjs documents — every `terminal` element becomes a
`portal` onto a newly created solo composition, keeping id, geometry and z-order so
collaborators' element references survive; a terminal already living in a composition was
already homed and is left alone; the retired pool position becomes its composition's
position in the index; then `pads.transient`, `pads.origin_pad_id` and
`sessions.sort_order` are dropped (its body names the pre-rename schema on purpose — replayed
history, allowlisted in `REGISTRY.md` §Lexicon).
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

## The app shell (installable lens, issue #109)

One bundle, installable from any instance, pointable at any instance. Nothing here is a second
build target and nothing branches on which instance is being looked at.

- **Web app manifest**: `packages/web/public/app.webmanifest`, linked from `index.html`, copied
  into `dist/` by the existing vite build and served by the existing static route. `start_url`
  and `scope` are `/`, icons are `icon.svg` (any) and `icon-maskable.svg` (maskable), display is
  `standalone`. Every path in it is relative: the SHELL belongs to whoever served it.
- **Shell cache**: `packages/web/sw.js`, emitted to `dist/sw.js` by the build with the shipped
  asset list and a cache name of `manifold-shell-<build>-<digest of those asset names>`.
  Registered by `packages/web/src/lens.tsx` in a built app. It caches the document, the build's
  hashed assets, the icon and the manifest — and passes through `/api`, `/ws`, `/healthz`, every
  non-GET and every CROSS-ORIGIN request untouched, so no scene state is ever served from a
  cache and no API origin is baked into a worker.
- **Update flow**: navigations are network-first (so the load after a deploy fetches the new
  document even under the old worker), a new generation installs and WAITS rather than swapping a
  running page, `activate` deletes every older `manifold-shell-*`, and the waiting generation is
  offered to the human as a reload. Protocol skew is refused rather than degraded (§HTTP API,
  `/healthz`).
- **Which instance**: `instanceOrigin()` (`packages/plugin/src/instance.ts`, exported through
  `@manifold/plugin/hooks`) is the ONE answer, resolved once per page: `?instance=<url>` (a
  one-shot carrier, consumed and remembered in `manifold:instance`), else this device's memory,
  else `window.location.origin`. `?instance=` with no value forgets the choice. Every HTTP door
  and the session socket derive from it — `sessionUrl()` here, and the SDK's own `apiOrigin()`
  from that — so a plugin inherits the choice without knowing it exists. Credentials are keyed
  per instance (`REGISTRY.md` §Device-local register).

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
- **Feed report** (`packages/plugin/src/polled-resource.ts`), behind the SAME flag: the feed
  store installs `window.__manifoldFeeds(): readonly PolledFeedReport[]`, one row per live feed
  — `key` (`<resource>|<restartKey>`), `subscribers`, `mode` (`"events"` | `"timer"`), `live`,
  `topics` (the subscribed nodes as `manifold://` URIs), `intervalMs` (null when no timer is
  armed) and `reads` counted by REASON (`initial`, `event`, `timer`, `manual`, `resume`). It is
  SEPARATE from `window.__manifold` on purpose: that probe is installed by the mounted container
  renderer and dies with it, while a feed is floor and outlives every view, so the report is
  present on any page rather than only where a canvas is mounted. Consumers:
  `scripts/verify-budgets.ts` (the zero in `REGISTRY.md` §Budgets is only meaningful beside
  `reads.timer === 0` and a live subscription) and `verify:axioms` R10. Read-only, like the other.
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

The log is the OPERATIONAL stream and it is not the audit: the durable record of who exercised
what is the journal's trace family, read through `core.events.list` (axiom A6, §The journal and
its two families). The two say the same word for the same dispatch — the `action` line's
`outcome` and the trace row's `outcome` are the same vocabulary — and one field rule redacts both
(`redactFields`, `packages/server/src/log.ts`), so a secret cannot reach either.

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
