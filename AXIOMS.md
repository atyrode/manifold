# manifold — axioms and the sworn boundary

This file is the constitution. `AGENTS.md` is how to operate the repo, `docs/CONTRACTS.md`
is what the parts promise each other, `docs/PLAN.md` is where we are going; this file says
what manifold *is* and where the line runs between the foundation and everything built on
it. Two sections here are machine-readable — §Foundation's `floor` registry and §Device-local
register's `deviceLocal` registry — and `bun run verify:axioms` (part of `bun run gate`)
parses them in both directions. Crossing the boundary without editing the registry fails the
gate. That is the whole point: an axiom nobody can violate silently is an axiom.

## Axioms

**A1 — Everything above the floor is a plugin.** The floor is the axioms' own enforcement
machinery (§Foundation). Every feature above it — the sidebar, the drawing tool, terminal
administration, view presence, the shell itself — is a plugin: a manifest declaring what it
contributes, plus actions declaring the capabilities they need. Plugins load through ONE
registry, are enabled or disabled per workspace while the page keeps running, and collide
loudly rather than shadowing each other: duplicate plugin ids, action names, panel ids,
element types or tool ids fail composition by name. A contribution whose plugin is disabled
or unknown renders an inert placeholder naming the plugin — on canvases and in the workspace
tree alike — because a missing feature must be visible, not invisible. A manifest may declare
`essential: true`; disabling an essential plugin is refused (`refused`, message `essential`).
There is no privileged "core" mechanism: core plugins use exactly the interfaces a stranger's
plugin uses.

**A2 — Multiplayer by design.** Every capability is reachable identically by a local human,
a remote human, and an agent, over the UI and over the API. There is no local-only path and
no API-only path: a gesture in the browser and a call from an SDK land on the same door, and
the door is the only place authority is decided. Solo is a room of one, never a second mode —
local input normalizes into the wire form first and is consumed as if received (AGENTS.md
invariant 11), so single-player is a special case of multiplayer and never the reverse.
Per-user *view* state — the tool in hand, what is being edited, which container has focus,
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

**"One door per concept" is not a sixth axiom.** It is an engineering law and lives as
`AGENTS.md` invariant 14: every concept has exactly one authoritative implementation and every
consumer goes through it. It is referenced here because the axioms above are unenforceable
without it — two doors onto one concept means two authority decisions, and the second one is
the one that gets forgotten.

## Roadmap

The ratified wave order. A wave lands as one branch, one PR, one green `bun run gate`.

- **Wave 1 — plugin engine, core plugins, mechanical enforcement (#69, this change).** Protocol
  v14 (connection-level `plugins` frame, presence `view`/`spotlight`, `panel` tile surface,
  `plugins:manage`, action and resolve doors, `manifold://` grammar); `@manifold/plugin` with
  manifests, composition and host contracts; the server plugin host and its denial ladder; the
  workspace shell as a tile composition of plugin panels; the core plugins themselves —
  enumerated by `packages/plugins/*` via the two composition files and live at
  `GET /api/plugins`, never by prose here (D10);
  `AXIOMS.md`, `AGENTS.md` invariants 12–14, and `verify:axioms` in the gate.
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

### Full-conversion inventory

A1 is not satisfied by a representative sample; it is satisfied when nothing above the floor is
still wired by hand. The remaining conversions are tracked here, and each row is the prose half
of an `"until"` tag in the `floor` registry below — `verify:axioms` S6 keeps the tags honest, so
this ledger cannot rot into a wish.

| Still floor today                                          | Converts to                          | Floor tag           |
| ---------------------------------------------------------- | ------------------------------------ | ------------------- |
| notes/text element renderer + the text tool                | `core.notes`                         | `core.notes`        |
| canvas renderer, portal internals, canvas toolbar, viewport | `core.canvas`                        | `core.canvas`       |
| tiled-route internals, tile drop gestures, carry previews   | `core.compositions`                  | `core.compositions` |
| machine enrollment + machine presentation helpers           | `core.machines` actions              | `core.machines`     |
| pad/folder CRUD and pad-tree moves (bespoke HTTP routes)    | workspace-index actions              | —                   |
| terminal pool/park rows, the terminal index, session rows   | `core.terminals` completion          | `core.terminals`    |
| token and principal administration routes                   | `core.access` (waterfall wave)       | —                   |
| cursor overlay + roster island rendering                    | `core.presence` completion           | `core.presence`     |
| `POST /api/place`                                           | action-alias evaluation, deferred    | —                   |

`core.canvas`, `core.notes` and `core.compositions` together decompose today's
`core.shell.pad-view` panel. `POST /api/place` stays its own door for now on purpose: it is
already a single door with published, data-driven legality, so aliasing it as an action buys
vocabulary uniformity and nothing else — the decision waits for full conversion, when the cost
of the exception is visible next to everything else that went through the action door.

## Taxonomy

One noun per concept; a second name for an existing concept is invariant-14 debt.

| Noun          | Means                                                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **node**      | Anything with a `manifold://` address: a pad, a terminal, an element, a tile, a principal, a plugin, an action. Grants, events and shares all name nodes.                     |
| **item**      | A thing that can be placed — identity-bearing, addressed by identity (`terminal`, `canvas-pad`, `view`, `text`, `draw`, `tile`).                                              |
| **placement** | One appearance of an item inside a container (a portal element, a tile leaf). An item may have many; deleting a placement never deletes the item.                             |
| **panel**     | Contribution kind: a full surface that can be a leaf of a tile layout. The workspace shell is panels all the way down (`core.shell.sidebar`, `core.shell.pad-view`).          |
| **section**   | Contribution kind: a collapsible block in the sidebar stack. Order comes from the manifest, not from device memory.                                                           |
| **element**   | Contribution kind: a canvas record type plus its renderer (`draw` is the worked example).                                                                                     |
| **tool**      | Contribution kind: a canvas toolbar mode.                                                                                                                                    |
| **pipe**      | The channel a reference crosses to be projected: a session channel onto a room, the machine channel onto a daemon, and — from wave 3 — an instance channel onto another manifold. |
| **grant**     | An authority row: principal (or class) × node × capabilities × effect × reach. A token is a reference to grants; a share is a minted token bound to a subtree grant.          |

## Foundation

**The floor criterion.** A file is floor if, and only if, it is part of the axioms' own
enforcement machinery:

- identity and authority (who is asking, what they may do),
- protocol schemas (the vocabulary every plane speaks),
- plane transports — document sync, presence relay, action dispatch, the PTY broker,
- persistence,
- the registry itself (composition, the plugin host, the panel outlet).

Everything else is a feature, and features are plugins (A1). Two consequences are mechanical:
floor files MUST NOT import `@manifold-plugin/*` — the two `composition.ts` registration files
are the sole exceptions — and packages under `packages/plugins/*` import only
`@manifold/protocol`, `@manifold/scene`, `@manifold/sdk`, `@manifold/plugin` and their own
sources.

Rows carrying `"until"` are floor **today** and plugin territory **tomorrow**: the named plugin
is the one that will absorb them (§Roadmap inventory). A tag is a debt marker, not an excuse —
it makes the remaining migration machine-visible.

Test files (`*.test.ts`), `packages/testkit`, and `scripts/` are neither floor nor plugin
territory: they exercise both and are governed by their subject.

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
      "why": "the registry itself: manifests, composition, action definitions, host contracts, the default workspace layout"
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
      "why": "the core.shell.pad-view panel: the routed renderer switch, still holding the canvas and tiled routes",
      "until": "core.canvas"
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
      "why": "the shared transient-notification surface plugins and floor both raise"
    },
    {
      "glob": "packages/web/src/icons.tsx",
      "why": "shared icon set — floor-neutral UI utility"
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
      "why": "canvas renderer: the React Flow projection boundary, node type map, viewport and gesture wiring",
      "until": "core.canvas"
    },
    {
      "glob": "packages/web/src/flow-scene.ts",
      "why": "canvas projection: SDK elements to renderer-owned nodes at the paint boundary",
      "until": "core.canvas"
    },
    {
      "glob": "packages/web/src/flow-portal-node.tsx",
      "why": "canvas renderer: portal widgets — the projection of one container inside another",
      "until": "core.canvas"
    },
    {
      "glob": "packages/web/src/flow-terminal-node.tsx",
      "why": "canvas renderer: the pad context a node reads plus terminal node chrome",
      "until": "core.canvas"
    },
    {
      "glob": "packages/web/src/canvas-toolbar.tsx",
      "why": "canvas chrome: the tool strip that renders composition-contributed tools",
      "until": "core.canvas"
    },
    {
      "glob": "packages/web/src/canvas-tool.ts",
      "why": "canvas tool state machine (select/text are still engine tools this wave)",
      "until": "core.canvas"
    },
    {
      "glob": "packages/web/src/node-titlebar.tsx",
      "why": "canvas/composition widget chrome shared by portals, terminals and tiles",
      "until": "core.canvas"
    },
    {
      "glob": "packages/web/src/widget-engagement.ts",
      "why": "canvas policy: when a watching widget swaps to an engaged channel",
      "until": "core.canvas"
    },
    {
      "glob": "packages/web/src/viewport-memory.ts",
      "why": "per-pad camera memory policy (register: manifold:viewport:<padId>)",
      "until": "core.canvas"
    },
    {
      "glob": "packages/web/src/flow-text-node.tsx",
      "why": "notes: the text element renderer and its inline editor",
      "until": "core.notes"
    },
    {
      "glob": "packages/web/src/text-diff.ts",
      "why": "notes: the character-level merge policy behind collaborative Y.Text editing",
      "until": "core.notes"
    },
    {
      "glob": "packages/web/src/tiled-pad-view.tsx",
      "why": "the tiled route's internals — a composition rendered as the routed surface",
      "until": "core.compositions"
    },
    {
      "glob": "packages/web/src/tile-snap.ts",
      "why": "tile drop targeting: which leaf and which edge a gesture means",
      "until": "core.compositions"
    },
    {
      "glob": "packages/web/src/tile-drop-store.ts",
      "why": "tile drop gesture state shared by canvas widgets and the tiled route",
      "until": "core.compositions"
    },
    {
      "glob": "packages/web/src/use-tile-drop.ts",
      "why": "tile drop gesture hook: assessment through the pure placement algebra",
      "until": "core.compositions"
    },
    {
      "glob": "packages/web/src/tile-preview-overlay.tsx",
      "why": "tile drop preview rendering",
      "until": "core.compositions"
    },
    {
      "glob": "packages/web/src/tile-zone-debug.tsx",
      "why": "tile drop zone debug overlay behind the debug seam",
      "until": "core.compositions"
    },
    {
      "glob": "packages/web/src/item-drop.ts",
      "why": "client half of the placement algebra: assessment and the place call for dropped items",
      "until": "core.compositions"
    },
    {
      "glob": "packages/web/src/item-envelope.ts",
      "why": "drag-and-drop envelope for items crossing surfaces",
      "until": "core.compositions"
    },
    {
      "glob": "packages/web/src/carry.ts",
      "why": "carry previews: the dynamic half of the placement algebra",
      "until": "core.compositions"
    },
    {
      "glob": "packages/web/src/use-carry.ts",
      "why": "carry/gesture subscription hooks for renderers",
      "until": "core.compositions"
    },
    {
      "glob": "packages/web/src/terminal-view.tsx",
      "why": "xterm viewer: attach/detach pairing, snapshot geometry, terminal chrome",
      "until": "core.terminals"
    },
    {
      "glob": "packages/web/src/session-inventory.ts",
      "why": "terminal index rows derived from sessions and machines",
      "until": "core.terminals"
    },
    {
      "glob": "packages/web/src/machine-choice.ts",
      "why": "per-pad machine choice memory for terminal creation (register: manifold:machine:<padId>)",
      "until": "core.terminals"
    },
    {
      "glob": "packages/web/src/machine-visibility.ts",
      "why": "machine presentation: color and online derivation shared by chips and rows",
      "until": "core.machines"
    },
    {
      "glob": "packages/web/src/use-remote-cursors.ts",
      "why": "presence rendering: remote cursor overlay state",
      "until": "core.presence"
    },
    {
      "glob": "packages/web/src/cursor-identity.ts",
      "why": "presence rendering: per-membership cursor identity and labels",
      "until": "core.presence"
    },
    {
      "glob": "packages/web/src/presence-projection.ts",
      "why": "presence projection: wire presence to renderable rows",
      "until": "core.presence"
    },
    {
      "glob": "packages/web/src/remote-gestures.ts",
      "why": "presence rendering: remote gesture overrides and their TTL",
      "until": "core.presence"
    },
    {
      "glob": "packages/web/src/gesture-stream.ts",
      "why": "presence rendering: the throttled local gesture publisher",
      "until": "core.presence"
    },
    {
      "glob": "packages/web/src/interpolate.ts",
      "why": "presence rendering: cursor motion smoothing",
      "until": "core.presence"
    },
    {
      "glob": "packages/web/src/roster-model.ts",
      "why": "presence rendering: roster rows derived from wire presence",
      "until": "core.presence"
    },
    {
      "glob": "packages/web/src/top-right.tsx",
      "why": "presence rendering: the roster island (avatars, statuses, view chips)",
      "until": "core.presence"
    },
    {
      "glob": "packages/web/src/view-presence.ts",
      "why": "presence writing: this device's published view state (tool, text edit, focused container, sidebar collapse) — the store every presence writer merges",
      "until": "core.presence"
    },
    {
      "glob": "packages/web/src/spotlight.tsx",
      "why": "presence receiving: applies a spotlight to the mounted pad view, names the asker, and holds the device kill-switch (register: manifold:ignore-spotlight)",
      "until": "core.presence"
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
`@manifold/plugin`. The engine ships two entry points on purpose: `@manifold/plugin` is
platform-free (manifests, action definitions, composition, host contracts) and is what the
server imports; `@manifold/plugin/hooks` carries the React half (`usePolledResource`), so a
server typecheck never pulls React and a DOM lib into its type graph. A plugin reaches the host
through `HostServices` and nothing else. `docs/PLUGINS.md` is the authoring guide.

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

- **The registries are the mechanism of record.** A file that becomes floor, stops being floor,
  or changes its `"until"` tag is a registry edit in the same commit as the code. So is a new
  device-local key. `verify:axioms` reads both registries in both directions, so an unrecorded
  crossing fails `bun run gate` rather than a review.
- **Floor ADDITIONS need a dated ADR in `docs/decisions/` in the same commit**, naming what the
  file enforces and why it cannot be a plugin. The floor is meant to shrink; growing it is a
  decision, not a diff.
- **Extractions need only the registry edit.** Moving a feature out of the floor into
  `packages/plugins/*` is the direction the axioms want; it costs a registry line and the code.
- **Axiom text and the plane rule change by operator ratification only**, recorded here with the
  wave that carries it. An implementer who finds a decision absent from this file and from
  `docs/PLAN.md` has found a bug in the plan, not an open question.
- **New dependencies:** `AGENTS.md` invariant 8 (no new runtime dependency without a dated ADR)
  and its converse both apply — any pattern that is not manifold-specific gets a named library
  evaluation (candidates, code and maintenance saved, opinionation cost) recorded in the owning
  ADR before it is hand-rolled.

## Gates

`bun run verify:axioms` (in `bun run gate`) is the axioms made falsifiable. Its static half runs
against the source tree, its browser half against a real server and a real browser.

| Check | What it asserts                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| S1    | Both composition files compose without a `CompositionError`, and every `DEFAULT_WORKSPACE_LAYOUT` panel id exists in the composition. |
| S2    | Import boundary, walked with the TypeScript parser over this file's `floor` globs: floor files import no `@manifold-plugin/*` (the two `composition.ts` files excepted); plugin packages import only protocol/scene/sdk/plugin. |
| S3    | Every `localStorage` key literal in `packages/web` and `packages/plugins` appears in the `deviceLocal` register.                      |
| S4    | Every `data-action` literal in the source names an action the composition actually publishes (soundness; coverage ratchets up as later waves convert the remaining affordances). |
| S5    | Every `packages/plugins/*` directory is registered per the halves it exports, and every composed definition maps back to a package.   |
| S6    | Registry liveness: every `floor` glob matches at least one file — a stale row, or an `"until"` tag whose debt was silently paid, fails. |
| S7    | Route allowlist: the `/api/…` literals in the server's HTTP dispatcher equal the script's allowlist, so a bespoke feature route that bypasses the action door fails.                |
| S8    | `SceneElementSchema`'s member types are a subset of the engine's floor element kinds plus the composition's contributed element types. |
| R1    | Vocabulary: `GET /api/protocol` actions ≡ the composition; `GET /api/plugins` ≡ the roster; input/result schemas are present.         |
| R2    | Parity both directions: an SDK `core.terminals.rename` updates the browser DOM with no reload, and the browser's rename affordance is observed by the SDK as a `session_event`.      |
| R3    | Hot enable/disable with no reload: `core.draw` off removes the tool and placeholders existing strokes; `core.machines` off removes its section live; `core.terminals` off refuses `terminal_open` while an existing terminal still accepts `kill` (D12); disabling `core.shell` is `refused`/`essential`. |
| R4    | Shell as composition: `GET /api/layout` has panel leaves; a real divider drag changes the stored ratios and dispatches exactly ONE `core.layout.set`; another principal's layout is untouched. |
| R5    | Presence and spotlight: a picked tool is visible to an SDK peer as `view.tool` within 2s; `core.presence.focus` centers the target's viewport through the debug seam; a pad-scoped token invoking it is `forbidden`. |
| R6    | Addressing: `GET /api/resolve` round-trips a terminal and a pad, and the `/uri/<encoded>` deep link navigates.                        |
| R7    | Every `[data-action]` in the live DOM names an action in the roster.                                                                  |
| R8    | The denial ladder end to end, including a pad-scoped token on `core.plugins.setEnabled` → `forbidden` (actions are workspace-grade this wave). |

Per-axiom round table — which checks would fail first if an axiom stopped holding:

| Axiom / rule                            | Checks                              |
| --------------------------------------- | ----------------------------------- |
| A1 everything above the floor is a plugin | S1, S2, S5, S8, R1, R3            |
| A2 multiplayer by design                  | R2, R4, R5                         |
| A3 moddable by design                     | `docs/PLUGINS.md` + R1, S5         |
| A4 sovereign nodes                        | R6 (addressing); wave 3 adds its own |
| A5 waterfall authority                    | none yet — designed (ADR 0011), not implemented; R8 guards the flat degenerate case |
| Foundation boundary (registries)          | S2, S6, S7                         |
| Plane rule and state discipline           | S3, S4, R7, R8                     |

Also standing, in `bun run gate`: `verify:convergence` (the document plane), `verify:tile-drop`
(the placement algebra through real gestures), and the terminal e2e suites (the PTY plane).
Those prove the planes the axioms ride on; `verify:axioms` proves the axioms themselves.
