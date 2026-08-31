# manifold — axioms and the sworn boundary

This file is the constitution. `AGENTS.md` is how to operate the repo, `docs/CONTRACTS.md`
is what the parts promise each other, `docs/PLAN.md` is where we are going; this file says
what manifold _is_ and where the line runs between the foundation and everything built on
it. Three sections here are machine-readable — §Foundation law's `pillars` registry,
§Foundation's `floor` registry and §Device-local register's `deviceLocal` registry — and
`bun run verify:axioms` (part of `bun run gate`) parses them in both directions. Crossing the
boundary without editing the registry fails the gate. That is the whole point: an axiom nobody
can violate silently is an axiom. When this file and anything else disagree, this file wins
(§Change control, precedence).

## Axioms

**A1 — Everything above the floor is a plugin.** The floor is the axioms' own enforcement
machinery (§Foundation). Every feature above it — the sidebar, the drawing tool, terminal
administration, view presence, the shell itself — is a plugin: a manifest declaring what it
contributes, plus actions declaring the capabilities they need. Plugins load through ONE
registry, are enabled or disabled per workspace while the page keeps running, and collide
loudly rather than shadowing each other: duplicate plugin ids, action names, panel ids,
element types or tool ids fail composition by name. What happens to a plugin's data,
contributions and neighbours across that toggle is the behavioral contract — §Disable semantics
(D4′) here, normative in
[`docs/decisions/0013-plugin-behavioral-contract.md`](docs/decisions/0013-plugin-behavioral-contract.md).
There is no privileged "core" mechanism: core plugins use exactly the interfaces a stranger's
plugin uses. The engine's own doors are the one distinction, and it is a distinction in data
rather than in mechanism: the enablement door is a **builtin roster row** (`engine.plugins`,
`source: "builtin"`), described by the same manifest shape and dispatched through the same ladder
as any plugin, carrying no toggle of its own. A door that can delete itself is not a capability
(A2), so the mechanism that changes the composition never lives inside the composition — and
`engine.*` is a reserved namespace no plugin may claim.

**A2 — Multiplayer by design.** Every capability is reachable identically by a local human,
a remote human, and an agent, over the UI and over the API. There is no local-only path and
no API-only path: a gesture in the browser and a call from an SDK land on the same door, and
the door is the only place authority is decided. Solo is a room of one, never a second mode —
local input normalizes into the wire form first and is consumed as if received (AGENTS.md
invariant 11), so single-player is a special case of multiplayer and never the reverse.
Per-user _view_ state — the tool in hand, what is being edited, which container has focus,
whether the sidebar is open — is observable by other principals and drivable by them where
consent allows it (`core.presence.focus` writes a spotlight into a peer's presence; the peer
holds a kill switch). State that only one device can see is a bug unless it is registered in
§Device-local register.

**A3 — Moddable by design.** A stranger's agent can author a working plugin against
documented interfaces without reading the engine. The registries ARE the onboarding: the
manifest schema and action vocabulary are published live at `GET /api/protocol` and
`GET /api/plugins`, the authoring guide is `docs/PLUGINS.md`, and the boundary between
foundation and plugin territory is the machine-readable registry below. Contracts are
sandbox-shaped on purpose — declared capabilities, schema'd arguments, no host internals in
plugin signatures — so an isolated runner for untrusted third-party code can arrive later
behind the same manifest without re-cutting every plugin.

**A4 — Sovereign nodes: composition is projection.** Every node has one owner, one home, and
one canonical `manifold://` address. Composition mounts live references through
capability-scoped pipes; it never absorbs what it shows. Viewing any node is always the same
three steps: resolve the reference, open a pipe with a grant, project it. A **share** to
another manifold instance is that same reference-and-pipe shape over the network — the machine
channel (a remote process dialing in with a token, version-negotiated) is the shipped
precedent it generalizes — and because presence already rides room pipes, presence on a shared
node reaches the far side through the same pipe when both ends run a compatible presence
plugin. The same reference-and-pipe shape must hold whether the node's home is this instance
or another; wave 1 is single-instance. A **fork** ("detach as copy") is a distinct, explicit
operation, reserved and never implied by a share. When an owner cuts the pipe, the projection
dies everywhere.

**A5 — Authority is a waterfall of grants on the node tree.** A grant names a principal (or a
class of principals), a node by `manifold://` URI, a capability set, an effect (`allow` /
`deny`) and a reach (`node` / `subtree`); authority at a node is evaluated by walking the
containment path from the root down to that node, with deeper beating shallower,
principal-specific beating class-wildcard, `deny` beating `allow` at equal specificity. Tokens
are grant references: today's flat capability array is a synthesized root grant and today's
`padScope` is a subtree grant at `manifold://pad/<id>` — the degenerate case of the design, not
a different model. A share is a minted token bound to a subtree grant, portable because it is
data. The full evaluator design is normative in
[`docs/decisions/0011-permission-waterfall.md`](docs/decisions/0011-permission-waterfall.md);
it is designed now and implemented in a later wave, and `packages/server/src/auth.ts` is
registry-tagged as its single seam.

### The plane rule

Every discrete piece of state belongs to exactly one plane, decided mechanically per feature:

- **Action** — legality or effect depends on state the actor cannot see, or authority it does
  not hold. Actions are registered, declare their capabilities, validate their arguments, and
  answer refusals as data (`POST /api/actions/:name`).
- **Document** — a per-element edit whose worst-case merge a human accepts. Yjs, through
  `@manifold/scene`.
- **Presence** — state that dies with the connection. Never persisted.
- Continuous streams (PTY I/O, cursor motion, live drags) stay channel traffic or local echo.
  An action fires at the **commit point** of a gesture, never per frame: a divider drag is one
  `core.layout.set` on pointerup, not sixty.

A fourth plane — **events**: declared notifications emitted by the engine at the doors, whose
topics are nodes, which never mutate anything (reacting to one means calling an action) and
which carry no queue semantics (no offsets, no consumer groups; catch-up is reading state) —
is designed in
[`docs/decisions/0012-event-plane.md`](docs/decisions/0012-event-plane.md) and implemented in
wave 2. Wave-1 code touches it only through the manifest's reserved `contributes.events`.

### Disable semantics (D4′)

Disable is a permission-gated, workspace-global, hot act (`engine.plugins.setEnabled`, cap
`plugins:manage`). It gates a plugin's ACTIVE surface and **retains everything else**. Nothing
about a disabled plugin is engine-invented: the engine supplies a default per contribution kind,
the manifest may narrow it within a closed vocabulary, and destruction is a different verb.
Per kind:

| Kind                       | While the owner is disabled                                                                             | On re-enable                         | On purge                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------- |
| **actions**                | refused `plugin_disabled`, EXCEPT `cleanup: true` actions, which stay dispatchable (D12)                | dispatchable again                   | gone with the plugin                          |
| **element** (scene record) | data untouched; renders the engine placeholder (`dormant.mode` `ghost`, default) or is skipped (`hide`) | renders again, in place              | records released, ownership freed             |
| **panel** (layout leaf)    | leaf stays in every principal's stored layout; paints the placeholder, which carries a remove control   | paints its component again, in place | leaf becomes an unknown-panel placeholder     |
| **section** (sidebar)      | placeholder body in its manifest-declared slot; the slot is never re-flowed                             | body returns, same order             | slot gone                                     |
| **tool** (toolbar)         | absent from the strip; any in-flight tool state falls back to select                                    | reappears                            | gone                                          |
| **stored data**            | retained — `ctx.storage` namespace, migration ledger, element-type reservation all stand                | read as they were                    | cleared, ledger dropped, reservation released |
| **route**                  | the engine's named "disabled" page                                                                      | serves again                         | 404                                           |

Four rules bind that table:

- **Retain-only.** No manifest field can make disable erase, reset, or migrate anything.
  Destruction is `engine.plugins.purge`, refused while the plugin is enabled, running the
  plugin's `onPurge` hook.
- **The engine owns the placeholder.** Dormancy is declarative manifest data
  (`ghost` | `hide` plus an optional label), never a component supplied by the plugin being
  rendered in its absence.
- **Residual mechanisms are a closed enum** — `cleanup` actions, `dormant` render mode, `retain`
  — published in the protocol; `verify:axioms` lists every `cleanup: true` action in the
  composition so the carve-out cannot grow unseen.
- **Refusals are named classes, not one boolean.** `essential` (only `core.shell`), `builtin`
  (an engine door has no toggle), the dependency classes, the data-version classes and
  `still_enabled` are members of one published set; the roster also carries `changedBy` /
  `changedAt`, so a placeholder can say who turned this off, and `lifecycle` (`ok` /
  `enable_failed` / `disable_failed`), because a teardown that fails is a state every principal
  can see rather than an assertion. Disable always completes.

**"One door per concept" is not a sixth axiom.** It is an engineering law and lives as
`AGENTS.md` invariant 14: every concept has exactly one authoritative implementation and every
consumer goes through it. It is referenced here because the axioms above are unenforceable
without it — two doors onto one concept means two authority decisions, and the second one is
the one that gets forgotten.

## Roadmap

The ratified wave order. A wave lands as one branch, one PR, one green `bun run gate`.

- **Wave 1 — plugin engine, TOTAL conversion, mechanical enforcement (#69, this change).**
  Protocol v15 (connection-level `plugins` frame, presence `view`/`spotlight`, `panel` tile
  surface, `plugins:manage`, action and resolve doors, `manifold://` grammar, and the behavioral
  contract's manifest and roster vocabulary: dependencies, `after`, `dataVersion`, `dormant`,
  placement traits, lifecycle states, refusal classes, the closed residual enum, purge targets,
  `source`, `changedBy`/`changedAt`); `@manifold/plugin` with manifests, composition, dependency
  resolution and ordering, per-plugin `ctx.storage`, and host contracts; the server plugin host,
  its denial ladder, and the **engine-owned enablement door** (`engine.plugins`, a builtin roster
  row); the workspace shell as a tile composition of plugin panels; the plugin behavioral contract
  v2 (ADR 0013) — retain-only disable, engine-owned placeholders, lifecycle hooks including the
  composition-changed broadcast, data versions with migrations, element-type ownership
  reservation; and **zero floor-owned domain code**: every feature above the floor runs through
  the plugin system or is explicitly sunset, enumerated by `packages/plugins/*` via the two
  composition files and live at `GET /api/plugins`, never by prose here (D10). Plus `AXIOMS.md`
  (including §Foundation law and the pillar registry), `AGENTS.md` invariants 12–15, and
  `verify:axioms` in the gate.
- **Wave 2 — the event plane** (ADR 0012). A subscribe door, emission at the existing doors
  (actions, placement, lifecycle, roster), and real consumers for `contributes.events`. It
  replaces the Machines and Views sections' HTTP polling: one fetch line per section becomes a
  subscription and the moved section UI is untouched. The wave-1 roster frame may later be
  re-expressed as an always-on subscription over the mechanism it itself pioneered; the frame
  shape is unchanged either way.
- **Wave 3 — cross-instance sharing** (A4, riding wave 2's pipes). Instance dialing that
  generalizes the machine channel, share minting bound to subtree grants, principal `origin` in
  the schema. Wave 1 reserves the structural room: SDK pool channels are conceptually keyed by
  `(origin, padId)` with origin fixed to the current instance, and CONTRACTS carries the
  principal-origin note.
- **Later waves, each gated on its own dated ADR:**
  - **Permission waterfall implementation** (ADR 0011): the evaluator, the `grants` table, and
    the one call-surface swap in `auth.ts`. Its dependency duty (evaluate `casbin` and `CASL`
    by name before hand-building) is recorded in that ADR.
  - **Social layer** — a `core.social` plugin: identity beyond a device-local grant, friends,
    invites, agent chat, share-invitation signaling. **Matrix is the ratified leading
    candidate**, to be judged at that wave against ActivityPub and plain invite links in its
    own ADR. Matrix is **rejected as foundation**: adopting it below the floor would install a
    second room model, a second event model and a second permission model beside manifold's
    own, and A5 plus the plane rule would then have two answers to every question.
  - **Marketplace and dynamic plugin distribution** — plugin code that is not compiled into the
    build. The seams are already reserved: the manifest's `entry { web?, server? }` and the
    roster's `source` field. This wave also carries the explicit **core-plugin override**
    mechanism: replacing a core plugin is disable-then-enable-a-substitute by id, never a silent
    collision (A1 has no shadowing).
  - **App shells** — packaging manifold's client for hosts that are not a plain browser tab, and
    ADR-gated when it is built rather than sketched now. A **PWA pass is the near milestone**:
    installability, offline shell, and the origin-configurability the portable-lens rule already
    demands, with no client fork. For desktop, **Electron is the ratified leading candidate** — to
    be judged in its own ADR at that milestone — because rendering predictability matters to the
    two surfaces manifold is hardest on (the React Flow canvas and xterm), which its own bundled
    Chromium gives, because `WebContentsView` embeds a real web view without re-implementing one,
    and because the local agent already fits the sidecar shape it packages well. **Tauri is
    re-evaluated at a native-mobile milestone**, where a system web view stops being a liability
    and binary size starts being one. Whatever ships obeys the portable-lens rule: a shell adds
    host-composed plugins, never a second client.

### Full-conversion inventory

A1 is not satisfied by a representative sample; it is satisfied when nothing above the floor is
still wired by hand. That is the wave-1 completion scope, not a later wave, so this table is a
work list rather than a ledger of debt: every row lands in this change.

| Was floor                                                                  | Converts to                 | Ruling                                                           |
| -------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------- |
| notes/text element renderer + its inline editor                            | `core.notes`                | moved; the text TOOL is canvas chrome (next row)                 |
| canvas renderer, portal internals, canvas toolbar, viewport                | `core.canvas`               | decomposes `core.shell.pad-view`; absorbs stroke geometry        |
| tiled-route internals, tile drop gestures, carry previews                  | `core.compositions`         | decomposes `core.shell.pad-view`                                 |
| machine enrollment + machine presentation helpers                          | `core.machines`             | enrollment and inventory become actions; color moves to the wire |
| pad/folder CRUD, pad-tree moves, and the index reads (bespoke HTTP routes) | `core.views` actions        | routes deleted, callers migrated (D13); reads keep pad scope     |
| terminal pool/park rows, the terminal index, session rows                  | `core.terminals` completion | policy is the plugin's, bytes stay floor (ADR 0013 §14)          |
| token and principal administration routes                                  | `core.access`               | identity mechanism stays floor; administration converts now      |
| cursor overlay + roster island rendering                                   | `core.presence` completion  | the presence relay stays floor                                   |
| `POST /api/place`                                                          | `core.layout.place`         | mechanism/verb split; the route is deleted, not aliased          |
| element placement traits (closed `ITEM_KINDS` tables)                      | manifest contribution data  | the algebra becomes a trait-driven rules engine (ADR 0013 §12)   |

`core.canvas`, `core.notes` and `core.compositions` together decompose today's
`core.shell.pad-view` panel. Two rows reverse earlier scope notes, ruled in
[`docs/decisions/0013-plugin-behavioral-contract.md`](docs/decisions/0013-plugin-behavioral-contract.md)
§14: `POST /api/place` is superseded by `core.layout.place` rather than left as a permanent
exception (invariant 14 admits no second door onto "place a thing"), and `core.access` takes the
token and principal administration verbs now, while the A5 evaluator (ADR 0011, grant rows,
`effectiveCaps`) remains a later wave — "identity mechanism is floor" never made
`POST /api/tokens` mechanism.

**The `until` tag is gone, and the registry now says so.** The floor registry once carried an
`"until": "<plugin>"` field on rows that were floor today and plugin territory tomorrow, and this
table was its prose half. Every such field has been stripped; each deferral is folded into its row's
`why` as "… — awaiting `<plugin>`". Nothing replaces the field — a file is floor because it passes
the litmus test (§Foundation law), or it belongs to a plugin. There is no third state, and therefore
no tag for one.

Those **awaiting-rows are wave C's deletion list**: each names a file whose consumers the canvas,
compositions, terminals and presence conversions absorb, and wave C deletes the file and its row
together rather than re-annotating either. Integration verifies that the list has emptied before the
gate run, so "awaiting" is a sentence in a `why` that a human reads during review — not a machine
licence, and not a state a gate can be taught to tolerate.

## Taxonomy

One noun per concept; a second name for an existing concept is invariant-14 debt.

| Noun          | Means                                                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **node**      | Anything with a `manifold://` address: a pad, a terminal, an element, a tile, a principal, a plugin, an action. Grants, events and shares all name nodes.                         |
| **item**      | A thing that can be placed — identity-bearing, addressed by identity (`terminal`, `canvas-pad`, `view`, `text`, `draw`, `tile`).                                                  |
| **placement** | One appearance of an item inside a container (a portal element, a tile leaf). An item may have many; deleting a placement never deletes the item.                                 |
| **panel**     | Contribution kind: a full surface that can be a leaf of a tile layout. The workspace shell is panels all the way down (`core.shell.sidebar`, `core.shell.pad-view`).              |
| **section**   | Contribution kind: a collapsible block in the sidebar stack. Order comes from the manifest, not from device memory.                                                               |
| **element**   | Contribution kind: a canvas record type plus its renderer (`draw` is the worked example).                                                                                         |
| **tool**      | Contribution kind: a canvas toolbar mode.                                                                                                                                         |
| **pipe**      | The channel a reference crosses to be projected: a session channel onto a room, the machine channel onto a daemon, and — from wave 3 — an instance channel onto another manifold. |
| **grant**     | An authority row: principal (or class) × node × capabilities × effect × reach. A token is a reference to grants; a share is a minted token bound to a subtree grant.              |

## Foundation law

The foundation is not "the code we did not convert". It is a small set of **pillars**, each
admitted by a test, each carrying an obligation, and each named in a machine-readable registry
below. This section is normative: it is the law an agent applies before touching floor code, and
the reasoning a floor-addition ADR must show.

### The litmus test (admission)

A pillar belongs to the engine **if and only if it passes all three** criteria:

1. **Bootstrap circularity** — plugins presuppose it. If it were a plugin, some plugin would have
   to load before the loader, or render before the renderer. The enablement door is the worked
   example: a door that can disable itself cannot be relied on to re-enable anything (ADR 0013
   §10), and the placeholder for an absent plugin cannot be drawn by the absent plugin (§4).
2. **Neutrality** — zero domain nouns, no favorite plugin. It would be unchanged if every plugin
   in the tree were replaced by different plugins. It knows contribution _kinds_ (panel, section,
   element, tool) and never which ones exist; it speaks the vocabulary, never the words.
3. **Arbitration** — it referees between plugins where no plugin could be trusted to referee:
   collisions, ordering, ownership reservation, capability intersection, placement legality. An
   arbiter cannot be a party.

**Failing any one criterion means it is a plugin.** There is no partial credit, no "mostly
mechanism", and no third state between floor and plugin territory.

### The obligation (not a power)

Being floor grants no privilege; it imposes **self-description**. The foundation must be readable
as data by a stranger's agent, or A3 has nothing to onboard against:

- every engine door is a **builtin roster row** (`source: "builtin"`), described by the same
  manifest and `ActionSummary` shapes as a plugin's and dispatched through the same ladder —
  never a hidden entry point;
- every dispatch is **logged**, one structured line, with the principal, the action and the
  outcome;
- every registry is **machine-readable** and checked in both directions: the pillar registry and
  the floor registry here, the device-local register below, the live roster at
  `GET /api/plugins`, the schemas at `GET /api/protocol`.

A pillar that cannot be read as data is a pillar that cannot be audited, and an unauditable
foundation is indistinguishable from a privileged core — which A1 denies exists.

### The portable lens

**The client is a lens onto an instance, and the browser is the baseline host.** The web floor
stays browser-pure: no Electron, Node, or otherwise host-specific import anywhere above
`packages/web`'s entry, and no assumption that the server it talks to is the origin it was served
from — the instance is configurable, because a lens that can only look at its own birthplace is not
a lens.

Native capabilities — filesystem access, OS notifications, tray, deep window integration — may
arrive **only as host-composed plugins through the same manifests**, registered by whatever shell
is hosting the lens. Two consequences follow, and both are already the plugin rules rather than new
ones: a host that lacks a capability composes a workspace where that plugin is simply absent, and
absence looks exactly like any other disabled plugin (§Disable semantics — a named, inert
placeholder, data retained), so no feature is ever conditionally compiled and no surface silently
degrades. **A fork of the client is never the answer.** A shell that needs different behavior
contributes plugins; if it needs the lens itself to change, that is a change to the one lens every
host shares.

### Growing the foundation

Growing the foundation means **editing the pillar registry**, in the same commit as the code, with
a dated ADR in `docs/decisions/` that applies the litmus test criterion by criterion. The litmus
is the admission criterion reviewers apply; the registries are the mechanism that makes an
unrecorded crossing fail the gate rather than a review. Shrinking the foundation — moving a pillar
or part of one into `packages/plugins/*` — needs only the registry edit and the code: that is the
direction the axioms want.

### The pillar inventory

One entry per pillar: `id`, the `globs` it owns, the `litmus` criteria it passes, a one-line
`verdict`, and the `adr` that justifies its floor status. This registry is the mutable source of
truth for _which_ pillars exist, exactly as the `floor` registry is for which files are floor.

`verify:axioms` reads it for **exhaustiveness**: every floor file must fall inside exactly one
pillar's globs, and anything unmatched is gate RED — an unowned floor file is how the
`packages/web/src/stroke.ts` hole happened (plugin-domain geometry in the floor tree, absent from
every registry, therefore invisible to the import walk and to registry liveness alike). Where two
pillars' globs overlap, the **most specific glob owns the file** (longest literal prefix wins);
two pillars claiming the same file at equal specificity is itself an error. The gate wiring lands
with the conversion batch; the registry below is written to be consumed by it.

As this section is written, the rows that fall outside every pillar are exactly the ones the
conversion still owns: the web files whose `why` ends "awaiting `<plugin>`", plus any shell-panel
file not yet moved into its plugin. That is the intended reading of the check — the unmatched set IS
the work list, it empties as each file moves, and S9 turns green when it is empty rather than by
being taught exceptions.

```json
{
  "pillars": [
    {
      "id": "protocol",
      "globs": ["packages/protocol/src/**"],
      "litmus": ["bootstrap", "neutrality", "arbitration"],
      "verdict": "the vocabulary every plane speaks: wire schemas, capabilities, manifest and action shapes, the manifold:// grammar. Nothing can be validated, published or refused by name before it exists, it names no plugin, and it arbitrates by being the single definition every party is measured against.",
      "adr": "docs/decisions/0010-plugin-engine-and-action-plane.md"
    },
    {
      "id": "placement-algebra",
      "globs": ["packages/protocol/src/placement.ts", "packages/server/src/placement.ts"],
      "litmus": ["bootstrap", "neutrality", "arbitration"],
      "verdict": "the trait-driven rules engine and its executor: which item may enter which container, and which rule refused. Traits are manifest contribution data (G1), so the engine is neutral over kinds; it arbitrates between kinds no single plugin owns. The VERB is a plugin — core.layout.place, not a bespoke route.",
      "adr": "docs/decisions/0013-plugin-behavioral-contract.md"
    },
    {
      "id": "composition-engine",
      "globs": [
        "packages/plugin/src/**",
        "packages/server/src/plugin-host.ts",
        "packages/server/src/composition.ts",
        "packages/server/src/main.ts",
        "packages/server/src/http.ts",
        "packages/server/src/config.ts",
        "packages/server/src/index.ts"
      ],
      "litmus": ["bootstrap", "neutrality", "arbitration"],
      "verdict": "the registry itself plus the doors it dispatches through, including the engine-owned enablement door (engine.plugins, a builtin roster row). Plugins presuppose the loader; it refuses collisions, resolves dependencies and order, and intersects capabilities — arbitration by definition.",
      "adr": "docs/decisions/0010-plugin-engine-and-action-plane.md"
    },
    {
      "id": "identity-caps",
      "globs": ["packages/server/src/auth.ts", "packages/web/src/identity.tsx"],
      "litmus": ["bootstrap", "neutrality", "arbitration"],
      "verdict": "who is asking and what they may do, plus this device's token custody. Every door presupposes it, it knows no domain noun, and it is the single seam the A5 evaluator replaces. Administration of principals and tokens is NOT here: those verbs are core.access.",
      "adr": "docs/decisions/0011-permission-waterfall.md"
    },
    {
      "id": "persistence",
      "globs": [
        "packages/server/src/db.ts",
        "packages/server/src/stores.ts",
        "packages/server/src/migrate-solo.ts"
      ],
      "litmus": ["bootstrap", "neutrality", "arbitration"],
      "verdict": "the SQLite substrate: schema, migrations, and the row-level accessors the engine's own bookkeeping needs (enablement, layout, plugin storage namespaces, ownership tombstones, migration ledgers). Plugin-domain rows reach it only through ctx.storage, which is why the substrate stays neutral and a purge can be exact.",
      "adr": "docs/decisions/0013-plugin-behavioral-contract.md"
    },
    {
      "id": "transport",
      "globs": [
        "packages/server/src/session-ws.ts",
        "packages/server/src/machine-ws.ts",
        "packages/server/src/terminal-broker.ts",
        "packages/server/src/agent-spawn.ts",
        "packages/server/src/log.ts",
        "packages/agent/src/**"
      ],
      "litmus": ["bootstrap", "neutrality", "arbitration"],
      "verdict": "the pipes: channel multiplexing and connection-level frames, machine enrolment and version negotiation, the PTY broker's attach state machine and no-gap invariant, and the structured log that discharges the self-description obligation. Bytes are floor, POLICY is a plugin (ADR 0013 §14) — the transport moves bytes and stops knowing why.",
      "adr": "docs/decisions/0013-plugin-behavioral-contract.md"
    },
    {
      "id": "scene-sync",
      "globs": ["packages/scene/src/**", "packages/server/src/room.ts"],
      "litmus": ["bootstrap", "neutrality", "arbitration"],
      "verdict": "the document plane: the canonical Y.Doc per room, accept-then-repair, snapshots, and the scene representation element renderers project from. It arbitrates concurrent edits between principals; element KINDS are contribution data.",
      "adr": "docs/decisions/0008-yjs-scene-engine.md"
    },
    {
      "id": "presence-transport",
      "globs": ["packages/server/src/session-peer.ts"],
      "litmus": ["bootstrap", "neutrality", "arbitration"],
      "verdict": "one channel's server-side peer: frame validation, presence relay and fan-out. It carries presence payloads without reading them — cursor rendering, roster projection and view-state writing are core.presence, not floor.",
      "adr": "docs/decisions/0010-plugin-engine-and-action-plane.md"
    },
    {
      "id": "web-plugin-host",
      "globs": [
        "packages/web/src/main.tsx",
        "packages/web/src/app.tsx",
        "packages/web/src/plugin-host.tsx",
        "packages/web/src/composition.ts",
        "packages/web/src/api.ts",
        "packages/web/src/error-boundary.tsx",
        "packages/web/src/debug-seam.ts",
        "packages/web/src/pad-browser.tsx",
        "packages/web/src/tile-tree.tsx",
        "packages/web/src/tile-geometry.ts",
        "packages/web/src/toast.tsx",
        "packages/web/src/styles.css",
        "packages/web/src/pad-memory.ts",
        "packages/web/src/web-version.ts",
        "packages/web/src/generated-changelog.ts",
        "packages/web/src/changelog-references.ts"
      ],
      "litmus": ["bootstrap", "neutrality", "arbitration"],
      "verdict": "the registry's browser half: CompositionProvider, PanelOutlet and the engine-owned placeholder, HostServices, the one tile-tree renderer, the typed HTTP client, fault containment, and the read-only debug seam. It mounts panels without knowing which panels exist.",
      "adr": "docs/decisions/0010-plugin-engine-and-action-plane.md"
    },
    {
      "id": "sdk",
      "globs": ["packages/sdk/src/**"],
      "litmus": ["bootstrap", "neutrality", "arbitration"],
      "verdict": "the only WebSocket state machine plus the typed HTTP surface: dial, keepalive, rejoin, channel demux, connection frames, action dispatch. Every principal — browser, agent, remote SDK — reaches the doors through it, which is the mechanism behind A2's 'one door, every principal'.",
      "adr": "docs/decisions/0010-plugin-engine-and-action-plane.md"
    },
    {
      "id": "gate-and-registries",
      "globs": ["AXIOMS.md", "scripts/verify-axioms.ts", "scripts/gate.ts"],
      "litmus": ["bootstrap", "neutrality", "arbitration"],
      "verdict": "the axioms' own enforcement machinery: the registries in this file and the script that parses them in both directions. It is the pillar that makes every other pillar falsifiable, and it is the one place a boundary crossing cannot be silent.",
      "adr": "docs/decisions/0013-plugin-behavioral-contract.md"
    }
  ]
}
```

## Foundation

**The floor criterion is the litmus test** (§Foundation law): all three of bootstrap circularity,
neutrality and arbitration, or it is a plugin. Every floor file belongs to exactly one pillar in
the registry above; the rows below are the file-level view the import walk and registry-liveness
checks read.

Everything else is a feature, and features are plugins (A1). Two consequences are mechanical:
floor files MUST NOT import `@manifold-plugin/*` — the two `composition.ts` registration files
are the sole exceptions — and packages under `packages/plugins/*` import only
`@manifold/protocol`, `@manifold/scene`, `@manifold/sdk`, `@manifold/plugin` and their own
sources.

No row carries an `"until"` field; none may be added. A row is floor because its pillar passes the
litmus, never because its conversion is scheduled. Where a file is still floor only until its
consumers move, the row's `why` ends "awaiting `<plugin>`" — prose a reviewer reads, and wave C's
list of rows to delete alongside their files (§Roadmap, full-conversion inventory).

Test files (`*.test.ts`), `packages/testkit`, and `scripts/` are neither floor nor plugin
territory: they exercise both and are governed by their subject. The two exceptions are named in
the `gate-and-registries` pillar — `scripts/verify-axioms.ts` and `scripts/gate.ts` are the
enforcement machinery itself, not a test of somebody else's subject.

```json
{
  "floor": [
    {
      "glob": "packages/protocol/src/**",
      "why": "wire schemas, capabilities, the placement algebra, manifest and action shapes, the manifold:// grammar — the vocabulary every plane speaks"
    },
    {
      "glob": "packages/scene/src/**",
      "why": "the document plane: the Yjs representation of scenes and tile layouts"
    },
    {
      "glob": "packages/sdk/src/**",
      "why": "the only WebSocket state machine plus the typed HTTP surface; doc sync, presence relay, action dispatch and PTY streams reach every client through it"
    },
    {
      "glob": "packages/plugin/src/**",
      "why": "the registry itself: manifests, composition, action definitions, host contracts, the default workspace layout — plus the plugin-facing standard library behind @manifold/plugin/hooks (plane mechanism) and @manifold/plugin/ui (neutral chrome: glyphs, the one titlebar, the notice consumer half, the published view-state store)"
    },
    {
      "glob": "packages/agent/src/**",
      "why": "the PTY plane's far end: the daemon that owns terminals, dials in, and survives server restarts"
    },
    {
      "glob": "packages/server/src/main.ts",
      "why": "process entry: builds the composition and the plugin host, wires every door"
    },
    {
      "glob": "packages/server/src/http.ts",
      "why": "the HTTP door dispatcher, including the action door and the roster/layout/resolve reads"
    },
    {
      "glob": "packages/server/src/auth.ts",
      "why": "identity and authority at the boundary; tagged as the future A5 evaluator seam (ADR 0011) — the one call surface effectiveCaps() replaces"
    },
    {
      "glob": "packages/server/src/db.ts",
      "why": "persistence: SQLite schema and migrations"
    },
    {
      "glob": "packages/server/src/stores.ts",
      "why": "persistence: pads, tokens, sessions, plugin enablement, per-principal workspace layout"
    },
    {
      "glob": "packages/server/src/room.ts",
      "why": "the document plane, server half: the canonical Y.Doc per room, accept-then-repair, snapshots"
    },
    {
      "glob": "packages/server/src/session-ws.ts",
      "why": "session transport: channel multiplexing, connection-level frames, roster fan-out"
    },
    {
      "glob": "packages/server/src/session-peer.ts",
      "why": "session transport: one channel's server-side peer — frame validation, presence relay, fan-out"
    },
    {
      "glob": "packages/server/src/machine-ws.ts",
      "why": "machine transport: agent enrolment, version negotiation, liveness"
    },
    {
      "glob": "packages/server/src/terminal-broker.ts",
      "why": "the PTY broker: attach state machine, viewer registry, the no-gap invariant"
    },
    {
      "glob": "packages/server/src/placement.ts",
      "why": "the placement door's executor — legality is protocol data, the executor is floor"
    },
    {
      "glob": "packages/server/src/plugin-host.ts",
      "why": "action dispatch: the denial ladder, capability intersection, enablement, roster change fan-out"
    },
    {
      "glob": "packages/server/src/composition.ts",
      "why": "the server-side registration point — the ONLY server file permitted to import @manifold-plugin/*"
    },
    {
      "glob": "packages/server/src/config.ts",
      "why": "process configuration and the env contract"
    },
    {
      "glob": "packages/server/src/log.ts",
      "why": "structured logging, including the one line per action dispatch"
    },
    {
      "glob": "packages/server/src/index.ts",
      "why": "package root exports"
    },
    {
      "glob": "packages/server/src/agent-spawn.ts",
      "why": "the PTY plane's bootstrap: local agent lifecycle and token custody"
    },
    {
      "glob": "packages/server/src/migrate-solo.ts",
      "why": "a code migration of persisted documents — persistence"
    },
    {
      "glob": "packages/web/src/main.tsx",
      "why": "browser entry"
    },
    {
      "glob": "packages/web/src/app.tsx",
      "why": "route table and the identity gate the plugin host mounts inside"
    },
    {
      "glob": "packages/web/src/plugin-host.tsx",
      "why": "the registry, web half: CompositionProvider, PanelOutlet and its placeholder, HostServices"
    },
    {
      "glob": "packages/web/src/composition.ts",
      "why": "the web registration point — the ONLY web file permitted to import @manifold-plugin/*"
    },
    {
      "glob": "packages/web/src/api.ts",
      "why": "the typed client for the HTTP doors"
    },
    {
      "glob": "packages/web/src/identity.tsx",
      "why": "identity bootstrap and token custody on this device"
    },
    {
      "glob": "packages/web/src/error-boundary.tsx",
      "why": "fault containment: a panel or renderer that throws must not take the workspace with it"
    },
    {
      "glob": "packages/web/src/debug-seam.ts",
      "why": "the read-only automation seam the browser gates read; no mutation surface, no secrets"
    },
    {
      "glob": "packages/web/src/pad-browser.tsx",
      "why": "the workspace host: fetches the per-principal layout and renders its panel leaves through TileTree"
    },
    {
      "glob": "packages/web/src/sidebar-panel.tsx",
      "why": "the core.shell.sidebar panel: sidebar chrome and the section stack, which must read the composition to know which sections exist"
    },
    {
      "glob": "packages/web/src/pad-view-panel.tsx",
      "why": "the core.shell.pad-view panel: the routed renderer switch, still holding the canvas and tiled routes — awaiting core.canvas"
    },
    {
      "glob": "packages/web/src/tile-tree.tsx",
      "why": "the one tile-tree renderer — the workspace layout and every composition share it (one tree vocabulary everywhere)"
    },
    {
      "glob": "packages/web/src/tile-geometry.ts",
      "why": "tile geometry and hit-testing shared by the workspace tree and compositions"
    },
    {
      "glob": "packages/web/src/toast.tsx",
      "why": "the one notice stack's PROVIDER: the queue, its two lifetimes, eviction order and the layer it paints into. The consumer half — the context, ToastApi, useToast — is @manifold/plugin/ui, because a plugin may not import a floor module and every plugin raises notices into this same stack"
    },
    {
      "glob": "packages/web/src/styles.css",
      "why": "the single stylesheet, including the workspace tree skin and the plugin-placeholder chrome"
    },
    {
      "glob": "packages/web/src/pad-memory.ts",
      "why": "device-local last-pad routing memory behind the root route (register: manifold.last-pad.<principalId>)"
    },
    {
      "glob": "packages/web/src/web-version.ts",
      "why": "release metadata read by the shell — floor-neutral"
    },
    {
      "glob": "packages/web/src/generated-changelog.ts",
      "why": "generated from CHANGELOG.md by the release path; never hand-edited"
    },
    {
      "glob": "packages/web/src/changelog-references.ts",
      "why": "issue/PR reference parsing for the in-app history — floor-neutral"
    },
    {
      "glob": "packages/web/src/flow-pad-view.tsx",
      "why": "canvas renderer: the React Flow projection boundary, node type map, viewport and gesture wiring — awaiting core.canvas"
    },
    {
      "glob": "packages/web/src/flow-scene.ts",
      "why": "canvas projection: SDK elements to renderer-owned nodes at the paint boundary — awaiting core.canvas"
    },
    {
      "glob": "packages/web/src/flow-portal-node.tsx",
      "why": "canvas renderer: portal widgets — the projection of one container inside another — awaiting core.canvas"
    },
    {
      "glob": "packages/web/src/flow-terminal-node.tsx",
      "why": "canvas renderer: the pad context a node reads plus terminal node chrome — awaiting core.canvas"
    },
    {
      "glob": "packages/web/src/canvas-toolbar.tsx",
      "why": "canvas chrome: the tool strip that renders composition-contributed tools — awaiting core.canvas"
    },
    {
      "glob": "packages/web/src/canvas-tool.ts",
      "why": "canvas tool state machine (select/text are still engine tools this wave) — awaiting core.canvas"
    },
    {
      "glob": "packages/web/src/widget-engagement.ts",
      "why": "canvas policy: when a watching widget swaps to an engaged channel — awaiting core.canvas"
    },
    {
      "glob": "packages/web/src/viewport-memory.ts",
      "why": "per-pad camera memory policy (register: manifold:viewport:<padId>) — awaiting core.canvas"
    },
    {
      "glob": "packages/web/src/tiled-pad-view.tsx",
      "why": "the tiled route's internals — a composition rendered as the routed surface — awaiting core.compositions"
    },
    {
      "glob": "packages/web/src/tile-snap.ts",
      "why": "tile drop targeting: which leaf and which edge a gesture means — awaiting core.compositions"
    },
    {
      "glob": "packages/web/src/tile-drop-store.ts",
      "why": "tile drop gesture state shared by canvas widgets and the tiled route — awaiting core.compositions"
    },
    {
      "glob": "packages/web/src/use-tile-drop.ts",
      "why": "tile drop gesture hook: assessment through the pure placement algebra — awaiting core.compositions"
    },
    {
      "glob": "packages/web/src/tile-preview-overlay.tsx",
      "why": "tile drop preview rendering — awaiting core.compositions"
    },
    {
      "glob": "packages/web/src/tile-zone-debug.tsx",
      "why": "tile drop zone debug overlay behind the debug seam — awaiting core.compositions"
    },
    {
      "glob": "packages/web/src/carry.ts",
      "why": "carry previews: the dynamic half of the placement algebra — awaiting core.compositions"
    },
    {
      "glob": "packages/web/src/use-carry.ts",
      "why": "carry/gesture subscription hooks for renderers — awaiting core.compositions"
    },
    {
      "glob": "packages/web/src/machine-visibility.ts",
      "why": "machine presentation policy (color and online derivation) for the canvas chrome that still calls it; the derivation is superseded by MachineSummary.color on the wire, so wave C deletes this file with its consumers — awaiting core.canvas"
    }
  ]
}
```

## Plugin layer

Everything not floor-matched is plugin territory. The authoritative list of core plugins is
`packages/plugins/*` as registered in the two `composition.ts` files, served live at
`GET /api/plugins`. It is never duplicated in prose here or anywhere else: a list in a document
is a second door onto the concept "which plugins exist", and by invariant 14 that is a bug.

A plugin package holds a manifest, its actions (server half) and its contributions (web half),
and it imports only `@manifold/protocol`, `@manifold/scene`, `@manifold/sdk` and
`@manifold/plugin`. The engine ships three entry points on purpose. `@manifold/plugin` is
platform-free (manifests, action definitions, composition, host contracts) and is what the
server imports. `@manifold/plugin/hooks` carries the plane mechanism a plugin needs in a
browser (the carry/drop vocabulary, the element host, `usePolledResource`), so a server
typecheck never pulls React and a DOM lib into its type graph. `@manifold/plugin/ui` is the
plugin-facing standard library: the glyph vocabulary, the one node titlebar, the consumer half
of the one notice surface, and this device's published view-state store — neutral chrome
MECHANISM, every piece of it addressed by two parties that may not import each other, which is
the litmus that puts a thing there rather than in whichever package used it first. A plugin
reaches the host through `HostServices` and nothing else. `docs/PLUGINS.md` is the authoring
guide.

## Device-local register

State may be device-local only when it is genuinely about this device and nobody else can be
harmed by not seeing it. Every such key is registered here, with a reason; `verify:axioms` S3
fails on any `localStorage` key in `packages/web` or `packages/plugins` that is absent from this
register. Anything else is presence, document, or action state — A2 leaves no fourth option, and
"it was easier" is not a reason.

```json
{
  "deviceLocal": [
    {
      "key": "manifold.identity",
      "why": "this device's principal grant (id, name, color, token) — the credential itself, which is why it never leaves the device"
    },
    {
      "key": "manifold.ownerKey",
      "why": "owner key captured from the #key= boot fragment; a secret, never sent anywhere but the Authorization header"
    },
    {
      "key": "manifold:debug",
      "why": "opt-in for the read-only debug seam window.__manifold; a browser-automation switch, not workspace state"
    },
    {
      "key": "manifold:viewport:",
      "prefix": true,
      "why": "per-pad camera (scroll + zoom) memory: where THIS screen was looking, meaningless to another device with another window size"
    },
    {
      "key": "manifold:machine:",
      "prefix": true,
      "why": "per-pad machine choice memory for the next terminal opened from this device"
    },
    {
      "key": "manifold.last-pad.",
      "prefix": true,
      "why": "per-principal last pad used on this device, so the root route reopens where this browser left off"
    },
    {
      "key": "manifold:show-pad-sessions",
      "why": "whether the Views section expands terminal rows on this device — presentation of an index whose content is durable server state"
    },
    {
      "key": "manifold:expanded-pad-folders",
      "why": "folder expansion in the Views tree on this device; folder membership and order are durable server state, expansion is not"
    },
    {
      "key": "manifold:ignore-spotlight",
      "why": "kill switch for incoming core.presence.focus spotlights — consent lives with the person being driven, on the device being driven"
    },
    {
      "key": "manifold:sidebar-collapsed-mirror",
      "why": "device mirror of presence view.sidebarCollapsed so the first paint matches the last session before the socket opens; presence remains the authority"
    }
  ]
}
```

## Change control

- **The registries are the mechanism of record.** A file that becomes floor or stops being floor
  is a registry edit — the pillar inventory and the `floor` rows — in the same commit as the code.
  So is a new device-local key. `verify:axioms` reads the registries in both directions, so an
  unrecorded crossing fails `bun run gate` rather than a review.
- **Floor ADDITIONS need a dated ADR in `docs/decisions/` in the same commit**, applying the
  litmus test (§Foundation law) criterion by criterion and naming the pillar the file joins. The
  floor is meant to shrink; growing it is a decision, not a diff.
- **Extractions need only the registry edit.** Moving a feature out of the floor into
  `packages/plugins/*` is the direction the axioms want; it costs a registry line and the code.
- **Axiom text and the plane rule change by operator ratification only**, recorded here with the
  wave that carries it. An implementer who finds a decision absent from this file and from
  `docs/PLAN.md` has found a bug in the plan, not an open question.
- **Precedence: axioms > decisions > scope notes.** This file's axioms and its foundation law
  outrank a dated ADR; an ADR outranks a scope note, a plan bullet, a roadmap row or a task
  brief. A lower rank may refine a higher one and may never contradict it.
  - **A contradiction discovered mid-implementation MUST escalate.** An implementer — human or
    agent — who finds a decision or a scope note that cannot be executed without violating an
    axiom stops and escalates to the operator. Choosing quietly is prohibited even when the
    choice looks obvious, because a silently resolved contradiction becomes precedent nobody
    ratified.
  - **Scope may DEFER work; it may never license an axiom-violating state.** "Not this wave" is a
    legitimate answer about effort. "Broken in this wave" is not an answer about state: a
    deferral must leave the tree in a condition every axiom still describes truthfully. The
    `"until"` tag was removed for exactly this reason — it turned deferral into a licence.
  - **Deferrals are visible in-product, not only in prose.** A capability that is designed but
    not implemented shows up where a user or an agent looks: a named refusal class, a
    placeholder that says what is missing, a roster field, a documented status. A deferral only a
    reader of `docs/` can discover is indistinguishable from a bug.
- **New dependencies:** `AGENTS.md` invariant 8 (no new runtime dependency without a dated ADR)
  and its converse both apply — any pattern that is not manifold-specific gets a named library
  evaluation (candidates, code and maintenance saved, opinionation cost) recorded in the owning
  ADR before it is hand-rolled.

## Gates

`bun run verify:axioms` (in `bun run gate`) is the axioms made falsifiable. Its static half runs
against the source tree, its browser half against a real server and a real browser.

| Check | What it asserts                                                                                                                                                                                                                                                                                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1    | Both composition files compose without a `CompositionError`, and every `DEFAULT_WORKSPACE_LAYOUT` panel id exists in the composition.                                                                                                                                                                                                                                                       |
| S2    | Import boundary, walked with the TypeScript parser over this file's `floor` globs: floor files import no `@manifold-plugin/*` (the two `composition.ts` files excepted); plugin packages import only protocol/scene/sdk/plugin.                                                                                                                                                             |
| S3    | Every `localStorage` key literal in `packages/web` and `packages/plugins` appears in the `deviceLocal` register.                                                                                                                                                                                                                                                                            |
| S4    | Every `data-action` literal in the source names an action the composition actually publishes (soundness; coverage ratchets up as later waves convert the remaining affordances).                                                                                                                                                                                                            |
| S5    | Every `packages/plugins/*` directory is registered per the halves it exports, and every composed definition maps back to a package — **builtin rows excepted**: an engine door (`source: "builtin"`) has no package by design, and the script composes it explicitly.                                                                                                                       |
| S6    | Registry liveness: every `floor` glob matches at least one file, so a stale row fails.                                                                                                                                                                                                                                                                                                      |
| S7    | Route allowlist: the `/api/…` literals in the server's HTTP dispatcher equal the script's allowlist, so a bespoke feature route that bypasses the action door fails.                                                                                                                                                                                                                        |
| S8    | `SceneElementSchema`'s member types are a subset of the engine's floor element kinds plus the composition's contributed element types.                                                                                                                                                                                                                                                      |
| S9    | Pillar exhaustiveness: every `floor` row falls inside exactly one pillar's globs (most specific glob owns the file); an unmatched floor file is RED. Wiring lands with the conversion batch.                                                                                                                                                                                                |
| S10   | The residual carve-out is published: the script lists every `cleanup: true` action in the composition, so growth of the disable exemption shows up in a gate diff (ADR 0013 §9).                                                                                                                                                                                                            |
| R1    | Vocabulary: `GET /api/protocol` actions ≡ the composition; `GET /api/plugins` ≡ the roster; input/result schemas are present.                                                                                                                                                                                                                                                               |
| R2    | Parity both directions: an SDK `core.terminals.rename` updates the browser DOM with no reload, and the browser's rename affordance is observed by the SDK as a `session_event`.                                                                                                                                                                                                             |
| R3    | Hot enable/disable with no reload: `core.draw` off removes the tool and placeholders existing strokes; `core.machines` off renders its section body as a named inert placeholder live (D4′ — contributions placeholder, never vanish); `core.terminals` off refuses `terminal_open` while an existing terminal still accepts `kill` (D12); disabling `core.shell` is `refused`/`essential`. |
| R4    | Shell as composition: `GET /api/layout` has panel leaves; a real divider drag changes the stored ratios and dispatches exactly ONE `core.layout.set`; another principal's layout is untouched.                                                                                                                                                                                              |
| R5    | Presence and spotlight: a picked tool is visible to an SDK peer as `view.tool` within 2s; `core.presence.focus` centers the target's viewport through the debug seam; a pad-scoped token invoking it is `forbidden`.                                                                                                                                                                        |
| R6    | Addressing: `GET /api/resolve` round-trips a terminal and a pad, and the `/uri/<encoded>` deep link navigates.                                                                                                                                                                                                                                                                              |
| R7    | Every `[data-action]` in the live DOM names an action in the roster.                                                                                                                                                                                                                                                                                                                        |
| R8    | The denial ladder end to end, including a pad-scoped token on `engine.plugins.setEnabled` → `forbidden` (a door's audience is DECLARED: `scope: "workspace"` refuses scoped callers, `scope: "pad"` admits them and obliges the handler to confine the answer — ADR 0013 §15).                                                                                                              |

Per-axiom round table — which checks would fail first if an axiom stopped holding:

| Axiom / rule                              | Checks                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| A1 everything above the floor is a plugin | S1, S2, S5, S8, R1, R3                                                              |
| A2 multiplayer by design                  | R2, R4, R5                                                                          |
| A3 moddable by design                     | `docs/PLUGINS.md` + R1, S5                                                          |
| A4 sovereign nodes                        | R6 (addressing); wave 3 adds its own                                                |
| A5 waterfall authority                    | none yet — designed (ADR 0011), not implemented; R8 guards the flat degenerate case |
| Foundation law (litmus, pillars)          | S2, S6, S7, S9                                                                      |
| D4′ disable semantics (ADR 0013)          | R3, S10                                                                             |
| Plane rule and state discipline           | S3, S4, R7, R8                                                                      |

Also standing, in `bun run gate`: `verify:convergence` (the document plane), `verify:tile-drop`
(the placement algebra through real gestures), and the terminal e2e suites (the PTY plane).
Those prove the planes the axioms ride on; `verify:axioms` proves the axioms themselves.
