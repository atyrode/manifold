# manifold — the enforcement registries

Enforcement data and check inventory: amended in the SAME commit as the code it indexes; the
gate is its reader; a row change here is not a constitutional amendment. The law it enforces
lives in [`AXIOMS.md`](AXIOMS.md); the reasoning behind contested rows lives in
`docs/decisions/`.

Six blocks below are machine-readable — §Pillar inventory's `pillars`, §Foundation's `floor`,
§Lexicon's `lexicon` and `cssFamilies`, §Device-local register's `deviceLocal`, and §Gate
contracts' `gateContracts` — and `bun run verify:axioms` (part of `bun run gate`) parses them in
both directions: every literal in the tree resolves to a row (soundness) and every row is
exercised by something live (liveness). A boundary crossed without a row edit fails the gate,
and that is the only reason the axioms are falsifiable rather than aspirational.

Every row carries its reason. A row missing its `why` is discarded by the reader, so an
unjustified entry fails the check that reads the registry instead of quietly widening the floor.

## Pillar inventory

The test that admits a pillar, the obligation admission carries, and the procedure for growing
the foundation are law: [`AXIOMS.md`](AXIOMS.md) §Foundation law. This is the inventory that law
operates on.

One entry per pillar: `id`, the `globs` it owns, the `litmus` criteria it passes, a one-line
`verdict`, and the `adr` that justifies its floor status. This registry is the mutable source of
truth for _which_ pillars exist, exactly as the `floor` registry is for which files are floor.

`verify:axioms` S9 reads it for **exhaustiveness**: every floor file must fall inside exactly one
pillar's globs, and anything unmatched is gate RED — an unowned floor file is how the
`packages/web/src/stroke.ts` hole happened (plugin-domain geometry in the floor tree, absent from
every registry, therefore invisible to the import walk and to registry liveness alike). Where two
pillars' globs overlap, the **most specific glob owns the file** (longest literal prefix wins);
two pillars claiming the same file at equal specificity is itself an error. A pillar glob that
claims no floor file is RED too — a stale pillar row is the S6 failure wearing the other
registry's clothes — with one exception the law itself names: `gate-and-registries` owns the
constitution and the gate scripts, which §Foundation puts outside floor and plugin territory
alike and which therefore carry no floor row.

**The unmatched set is now empty, and S9 is wired** (wave 2, 2026-08-31). The rows that fell
outside every pillar when this section was written were the web files whose `why` ended
"awaiting `<plugin>`" — all gone, converted with their consumers — plus the shell's own two panel
files, `sidebar-panel.tsx` and `container-view-panel.tsx`. Those two are gone the other way now
(2026-09-01): they moved into `packages/plugins/shell/src`, because the one thing that made them
floor — the sidebar's need to read the live composition, which no plugin had a door for — became
`host.assembly`, a declared read-only surface any plugin may open. That is the ONLY way the set
empties — a file moves into its plugin, or a pillar states the litmus finding that owns it — and
the shell taking the first route rather than the second is the honest outcome the second was
always standing in for. §Foundation law admits no third state, so S9 has no exception list and
must never be taught one.

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
      "verdict": "the trait-driven rules engine and its executor: which item may enter which container, and which rule refused. Traits are manifest contribution data (G1), so the engine is neutral over kinds; it arbitrates between kinds no single plugin owns. The VERB is a plugin — core.space.place, not a bespoke route.",
      "adr": "docs/decisions/0013-plugin-behavioral-contract.md"
    },
    {
      "id": "assembly-engine",
      "globs": [
        "packages/plugin/src/**",
        "packages/server/src/plugin-host.ts",
        "packages/server/src/isolate/**",
        "packages/server/src/assembly.ts",
        "packages/server/src/main.ts",
        "packages/server/src/http.ts",
        "packages/server/src/config.ts",
        "packages/server/src/index.ts"
      ],
      "litmus": ["bootstrap", "neutrality", "arbitration"],
      "verdict": "the registry itself plus the doors it dispatches through, including the engine-owned enablement door (engine.plugins, a builtin roster row) and the isolation runner (ADR 0016 §9, R7: joined here rather than seated as its own pillar — the thing that loads a plugin's code is the same loader, one process boundary further out). Plugins presuppose the loader; it refuses collisions, resolves dependencies and order, and intersects capabilities — arbitration by definition. It ASSEMBLES the roster; it never renders a composition.",
      "adr": "docs/decisions/0010-plugin-engine-and-action-plane.md"
    },
    {
      "id": "identity-caps",
      "globs": ["packages/server/src/auth.ts", "packages/web/src/identity.tsx"],
      "litmus": ["bootstrap", "neutrality", "arbitration"],
      "verdict": "who is asking and what they may do, plus this device's token custody. Every door presupposes it, it knows no domain noun, and it is the one call surface the A5 evaluator replaces. Administration of principals and tokens is NOT here: those verbs are core.access.",
      "adr": "docs/decisions/0011-permission-waterfall.md"
    },
    {
      "id": "persistence",
      "globs": [
        "packages/server/src/db.ts",
        "packages/server/src/stores.ts",
        "packages/server/src/migrate-solo.ts",
        "packages/server/src/migrate-lexicon.ts",
        "packages/server/src/migrate-grants.ts"
      ],
      "litmus": ["bootstrap", "neutrality", "arbitration"],
      "verdict": "the SQLite substrate: schema, migrations, and the row-level accessors the engine's own bookkeeping needs (enablement, layout, plugin storage namespaces, ownership tombstones, migration ledgers). Plugin-domain rows reach it only through ctx.storage, which is why the substrate stays neutral and a purge can be exact.",
      "adr": "docs/decisions/0013-plugin-behavioral-contract.md"
    },
    {
      "id": "transport",
      "globs": [
        "packages/server/src/session-ws.ts",
        "packages/server/src/event-hub.ts",
        "packages/server/src/machine-ws.ts",
        "packages/server/src/instance-ws.ts",
        "packages/server/src/instance-dialer.ts",
        "packages/server/src/terminal-broker.ts",
        "packages/server/src/agent-spawn.ts",
        "packages/server/src/log.ts",
        "packages/agent/src/**"
      ],
      "litmus": ["bootstrap", "neutrality", "arbitration"],
      "verdict": "the pipes: channel multiplexing and connection-level frames, machine enrolment and version negotiation, instance dialling in BOTH directions (the host gateway and the outbound dialer share the machine channel's one liveness discipline), the PTY broker's attach state machine and no-gap invariant, and the structured log that discharges the self-description obligation. Bytes are floor, POLICY is a plugin (ADR 0013 §14) — the transport moves bytes and stops knowing why.",
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
      "globs": ["packages/server/src/session-channel.ts"],
      "litmus": ["bootstrap", "neutrality", "arbitration"],
      "verdict": "one channel's server-side half: frame validation, presence relay and fan-out. It carries presence payloads without reading them — cursor rendering, attendance projection and vantage writing are core.presence, not floor.",
      "adr": "docs/decisions/0010-plugin-engine-and-action-plane.md"
    },
    {
      "id": "web-plugin-host",
      "globs": [
        "packages/web/src/main.tsx",
        "packages/web/src/app.tsx",
        "packages/web/src/plugin-host.tsx",
        "packages/web/src/assembly.ts",
        "packages/web/src/api.ts",
        "packages/web/src/error-boundary.tsx",
        "packages/web/src/lens.tsx",
        "packages/web/sw.js",
        "packages/web/src/workspace.tsx",
        "packages/web/src/notice.tsx",
        "packages/web/src/styles.css",
        "packages/web/src/shell.css",
        "packages/web/src/container-memory.ts",
        "packages/web/src/web-version.ts",
        "packages/web/src/generated-changelog.ts"
      ],
      "litmus": ["bootstrap", "neutrality", "arbitration"],
      "verdict": "the registry's browser half: AssemblyProvider, PanelOutlet and the engine-owned placeholder, HostServices, the projection registry it publishes to plugin code, the typed HTTP client, fault containment, and the read-only debug probe. It mounts panels without knowing which panels exist — and as of 2026-09-01 that is literally true of the shell's own two panels as well: they moved into @manifold-plugin/shell once `host.assembly` gave every plugin the composition read the sidebar chrome needed, so this pillar claims no component it also renders. What is left is the frame — the tile layout and its one committed write per gesture, the workspace index, the two contexts the host publishes above the tree for its panels to read, and the shell's skin, which stays here because the `sidebar` row vocabulary is filled by core.index, core.machines and core.plugins and a plugin may not own three other plugins' appearance.",
      "adr": "docs/decisions/0010-plugin-engine-and-action-plane.md"
    },
    {
      "id": "sdk",
      "globs": ["packages/sdk/src/**"],
      "litmus": ["bootstrap", "neutrality", "arbitration"],
      "verdict": "the only WebSocket state machine plus the typed HTTP client: dial, liveness, rejoin, channel demux, connection frames, action dispatch. Every principal — browser, agent, remote SDK — reaches the doors through it, which is the mechanism behind A2's 'one door, every principal'.",
      "adr": "docs/decisions/0010-plugin-engine-and-action-plane.md"
    },
    {
      "id": "gate-and-registries",
      "globs": [
        "AXIOMS.md",
        "REGISTRY.md",
        "scripts/verify-axioms.ts",
        "scripts/verify-trace.ts",
        "scripts/gate.ts"
      ],
      "litmus": ["bootstrap", "neutrality", "arbitration"],
      "verdict": "the axioms' own enforcement machinery: the constitution, the registries in this file and the scripts that parse them in both directions — including the trace gate, which holds axiom A6's ledger to every registered door. It is the pillar that makes every other pillar falsifiable, and it is the one place a boundary crossing cannot be silent.",
      "adr": "docs/decisions/0013-plugin-behavioral-contract.md"
    }
  ]
}
```

## Foundation

**The floor criterion is the litmus test** (`AXIOMS.md` §Foundation law): all three of bootstrap
circularity, neutrality and arbitration, or it is a plugin. Every floor file belongs to exactly one
pillar in the registry above; the rows below are the file-level view the import walk and
registry-liveness checks read.

Everything else is a feature, and features are plugins (A1). Two consequences are mechanical:
floor files MUST NOT import `@manifold-plugin/*` — the two `assembly.ts` registration files
are the sole exceptions — and packages under `packages/plugins/*` import only
`@manifold/protocol`, `@manifold/scene`, `@manifold/sdk`, `@manifold/plugin` and their own
sources.

No row carries an `"until"` field; none may be added. A row is floor because its pillar passes the
litmus, never because its conversion is scheduled. Where a file is still floor only until its
consumers move, the row's `why` ends "awaiting `<plugin>`" — prose a reviewer reads, and wave C's
list of rows to delete alongside their files (§Full-conversion inventory).

Test files (`*.test.ts`), `packages/testkit`, and `scripts/` are neither floor nor plugin
territory: they exercise both and are governed by their subject. The three exceptions are named in
the `gate-and-registries` pillar — `scripts/verify-axioms.ts`, `scripts/verify-trace.ts` and
`scripts/gate.ts` are the enforcement machinery itself, not a test of somebody else's subject.

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
      "why": "the only WebSocket state machine plus the typed HTTP client; doc sync, presence relay, action dispatch and PTY streams reach every client through it"
    },
    {
      "glob": "packages/plugin/src/**",
      "why": "the registry itself: manifests, assembly, action definitions, host contracts, the default workspace layout — plus the plugin-facing standard library behind @manifold/plugin/hooks (plane mechanism: the carry/drop and tile vocabulary, the presence plane's browser half, the element host, the ELEMENT plane's polyline geometry — what a flat coordinate payload extends to and the SVG strings that paint it, neutral over producers so no plugin carries a private copy — the projection registry through which one renderer paints another plugin's occupant, the routed-container context, polling, WHICH INSTANCE the lens looks at and the session URL derived from it, the debug probe) and @manifold/plugin/ui (neutral chrome: glyphs, the one titlebar, THE one tile-tree renderer with its drop preview and zone debug, the notice consumer half, the published vantage store, and the two device-local handoff slots two plugins that may not import each other pass a gesture through — a rebind request, and the placed structure a grip has in hand for the palette it goes back to (issue #148))"
    },
    {
      "glob": "packages/agent/src/**",
      "why": "the PTY plane's far end: the daemon that owns terminals, dials in, and survives server restarts"
    },
    {
      "glob": "packages/server/src/main.ts",
      "why": "process entry: builds the assembly and the plugin host, wires every door"
    },
    {
      "glob": "packages/server/src/http.ts",
      "why": "the HTTP door dispatcher, including the action door and the roster/layout/resolve reads"
    },
    {
      "glob": "packages/server/src/auth.ts",
      "why": "identity and authority at the boundary; the A5 evaluator's one call surface — what effectiveCaps() replaced when the waterfall landed (ADR 0011, wave 4, #77)"
    },
    {
      "glob": "packages/server/src/db.ts",
      "why": "persistence: SQLite schema and migrations"
    },
    {
      "glob": "packages/server/src/stores.ts",
      "why": "persistence: containers, tokens, terminals, plugin enablement, per-principal workspace layout"
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
      "glob": "packages/server/src/session-channel.ts",
      "why": "session transport: one channel's server-side half — frame validation, presence relay, fan-out"
    },
    {
      "glob": "packages/server/src/machine-ws.ts",
      "why": "machine transport: agent enrolment, version negotiation, liveness"
    },
    {
      "glob": "packages/server/src/instance-ws.ts",
      "why": "instance transport, host half: share authentication, origin binding, version negotiation, liveness, the ticket hop"
    },
    {
      "glob": "packages/server/src/instance-dialer.ts",
      "why": "instance transport, guest half: the dial rows this instance holds, their outbound sockets, and the door that turns one into a per-principal ticket"
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
      "glob": "packages/server/src/assembly.ts",
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
      "glob": "packages/server/src/event-hub.ts",
      "why": "the event plane's one mechanism (ADR 0012): the per-connection subscription registry, the grammar-derived topic match, the read-authority arbitration at subscribe and at delivery, and the fan-out that appends every emission to the one durable trail. Floor by both criteria — it knows no kind and no plugin, and it arbitrates who may hear whose node"
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
      "why": "a code migration of persisted documents — persistence. Its body is frozen: it names the pre-rename schema by design (§Lexicon allow row)"
    },
    {
      "glob": "packages/server/src/migrate-lexicon.ts",
      "why": "migration 11: the lexicon cut's one-way move — the schema renames plus the document rewrite that retitles every stored tile leaf's old `surface` key to `ref` and every container reference to the `container` kind, SQL and documents in one transaction behind a backup"
    },
    {
      "glob": "packages/server/src/migrate-grants.ts",
      "why": "a code migration that materializes the authority substrate — persistence. Every token's flat caps become the grant row its token references, and every share's caps become the instance grant on its shared node"
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
      "why": "the registry, web half: AssemblyProvider, PanelOutlet and its placeholder, HostServices"
    },
    {
      "glob": "packages/web/src/assembly.ts",
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
      "glob": "packages/web/src/lens.tsx",
      "why": "the lens's own three conditions, above the identity gate: which instance this device looks at, whether it answers, and whether this bundle still speaks its protocol. Floor because it is the one surface that may REFUSE to compose an assembly at all — a cached bundle in front of a newer instance (AGENTS.md invariant 10) — and because a plugin cannot own the chrome for the app that hosts it. It also registers the app shell's cache (`packages/web/sw.js`); the offline condition it names is a state, never a second code path"
    },
    {
      "glob": "packages/web/sw.js",
      "why": "the app shell's cache, shipped verbatim into `dist/` by the existing vite build with this build's asset list injected. Plain JS because it is a service worker rather than a module in the bundle, and floor because it sits in front of EVERY request the browser makes: what it may answer for (the document, this build's hashed assets, the icon, the web app manifest) and what it must never answer for (`/api`, `/ws`, `/healthz`, any cross-origin request) is a foundation rule, not a preference — a worker that cached a door would be a second, silent source of scene state"
    },
    {
      "glob": "packages/web/src/error-boundary.tsx",
      "why": "fault containment: a panel or renderer that throws must not take the workspace with it"
    },
    {
      "glob": "packages/web/src/workspace.tsx",
      "why": "the workspace host: fetches the per-principal layout, renders its panel leaves through TileTree, and publishes the live tree (its layout plus its own DOM root) as the tile-geometry read surface core.arrange reads (issue #89) — the frame owns no grip, no gesture and no arrange chrome beyond the `.is-arranging` state class that blanks its own tile content hosts while the plugin's overlay is armed"
    },
    {
      "glob": "packages/web/src/notice.tsx",
      "why": "the one notice stack's PROVIDER: the queue, its two lifetimes, eviction order and the layer it paints into. The consumer half — the context, NoticeApi, useNotice — is @manifold/plugin/ui, because a plugin may not import a floor module and every plugin raises notices into this same stack"
    },
    {
      "glob": "packages/web/src/styles.css",
      "why": "the floor's own stylesheet: reset, type and colour ground, the two cross-owner tokens, the identity gate, the one notice stack, the engine's inert plugin placeholder, and the drop-denial cue every target shares. Everything that belongs to somebody is in that owner's sheet (§Lexicon cssFamilies, S13)"
    },
    {
      "glob": "packages/web/src/shell.css",
      "why": "the shell's skin — the workspace frame, the sidebar rail and the ROW VOCABULARY every contributed section is filled into. A separate OWNER from the floor stylesheet, and it stays floor even though @manifold-plugin/shell now paints the two panels: `.sidebar-row`, `.sidebar-link`, `.sidebar-list`, `.sidebar-muted`, `.sidebar-section-count` and `.sidebar-section-action` are painted by core.index, core.machines and core.plugins, so moving the family into one plugin's package would make three plugins depend on a fourth's stylesheet. Same reason `plugin-placeholder` and `notice` are the floor's: the layer's skin is the layer owner's (§Lexicon cssFamilies)"
    },
    {
      "glob": "packages/web/src/container-memory.ts",
      "why": "device-local last-container routing memory behind the root route (register: manifold.last-container.<principalId>)"
    },
    {
      "glob": "packages/web/src/web-version.ts",
      "why": "release metadata — the running build's own identity, injected by packages/web/vite.config.ts and frozen by the release path, handed to the shell's panel through the WorkspaceShell context. Floor-neutral"
    },
    {
      "glob": "packages/web/src/generated-changelog.ts",
      "why": "generated from CHANGELOG.md's released sections by the release path; never hand-edited, which is why §Lexicon allows its frozen vocabulary"
    }
  ]
}
```

## Plugin layer

Everything not floor-matched is plugin territory. The authoritative list of core plugins is
`packages/plugins/*` as registered in the two `assembly.ts` files, served live at
`GET /api/plugins`. It is never duplicated in prose here or anywhere else: a list in a document
is a second door onto the concept "which plugins exist", and by invariant 14 that is a bug.

A plugin package holds a manifest, its actions (server half) and its contributions (web half),
and it imports only `@manifold/protocol`, `@manifold/scene`, `@manifold/sdk` and
`@manifold/plugin`. The engine ships three entry points on purpose. `@manifold/plugin` is
platform-free (manifests, action definitions, assembly, host contracts) and is what the
server imports. `@manifold/plugin/hooks` carries the plane mechanism a plugin needs in a
browser (the carry/drop vocabulary, the element host, `usePolledResource`), so a server
typecheck never pulls React and a DOM lib into its type graph. `@manifold/plugin/ui` is the
plugin-facing standard library: the glyph vocabulary, the one node titlebar, the consumer half
of the one notice stack, and this device's published vantage store — neutral chrome
MECHANISM, every piece of it addressed by two parties that may not import each other, which is
the litmus that puts a thing there rather than in whichever package used it first. A plugin
reaches the host through `HostServices` and nothing else. `docs/PLUGINS.md` is the authoring
guide.

A plugin also imports NO DRAWING. `lucide-react` is named in
`packages/plugin/src/ui/icons.tsx` and nowhere else in the tree (ADR 0009 and its #116
addendum): a plugin asks `@manifold/plugin/ui` for a KIND — `<ControlIcon kind="discard" />`,
`<ItemIcon kind={container.discipline} />` — so re-drawing the set stays a change to one file,
and S2 checks it rather than remembering it. `ControlKind` is closed to ADDITIONS and not to
callers: a plugin may not grow the union, and is expected to call it, because a plugin's chrome
wearing a different mark for the same verb is the disagreement the vocabulary exists to end.
Every kind is spelled neutrally — a verb, or a noun for what pressing opens — so the list reads
the same with every plugin in this build replaced.

## Full-conversion inventory

The ratified wave order is `AXIOMS.md` §Roadmap; this is wave 1's work list under it.

A1 is not satisfied by a representative sample; it is satisfied when nothing above the floor is
still wired by hand. That is the wave-1 completion scope, not a later wave, so this table is a
work list rather than a ledger of debt: every row lands in this change.

| Was floor                                                                | Converts to                 | Ruling                                                                  |
| ------------------------------------------------------------------------ | --------------------------- | ----------------------------------------------------------------------- |
| notes/text element renderer + its inline editor                          | `core.notes`                | moved; the text TOOL is canvas chrome (next row)                        |
| canvas renderer, portal internals, canvas toolbar, viewport              | `core.canvas`               | moved; decomposed `core.shell.container-view`; absorbed stroke geometry |
| composition-route internals, tile drop gestures, carry previews          | `core.compositions`         | decomposes `core.shell.container-view`                                  |
| machine enrollment + machine presentation helpers                        | `core.machines`             | enrollment and inventory become actions; color moves to the wire        |
| container/folder CRUD, index moves, and the index reads (bespoke routes) | `core.index` actions        | routes deleted, callers migrated (D13); reads keep container scope      |
| terminal pool/park rows, the terminal index, terminal rows               | `core.terminals` completion | policy is the plugin's, bytes stay floor (ADR 0013 §14)                 |
| token and principal administration routes                                | `core.access`               | identity mechanism stays floor; administration converts now             |
| attendance island + spotlight chip rendering                             | `core.presence` overlays    | moved; the relay stays floor, and so does the plane MECHANISM           |
| `POST /api/place`                                                        | `core.space.place`          | mechanism/verb split; the route is deleted, not aliased                 |
| element placement traits (closed `ITEM_KINDS` tables)                    | manifest contribution data  | the algebra becomes a trait-driven rules engine (ADR 0013 §12)          |

**Where presence divides, and why it is not a hollow plugin.** The presence PLANE MECHANISM is
engine (`@manifold/plugin/hooks`): send cadence, interpolation, per-connection cursor identity,
gesture stepping, and the local-principal normalization every consumer reads. It is arithmetic
over wire payloads — neutral over producers, naming no plugin — and its parties may not import
each other. What a renderer PAINTS in its own coordinate space (a peer's cursor, a carry ghost, a
selection outline) the renderer paints itself, because a peer's pointer means nothing until
something projects it through a viewport transform and only the renderer holds that transform;
a renderer showing remote intent as part of its own output is AGENTS.md invariant 11, exactly as
it renders its own normalized input. `core.presence` keeps what is genuinely its own: the wire
publisher, the `focus` door, and its chrome — which reaches renderers as REGISTERED OVERLAYS
(`attendance`, `spotlight`) rather than as imports, so presence still owns its own
presentation and no renderer names the package.

`core.canvas`, `core.notes` and `core.compositions` together decompose today's
`core.shell.container-view` panel. Two rows reverse earlier scope notes, ruled in
[`docs/decisions/0013-plugin-behavioral-contract.md`](docs/decisions/0013-plugin-behavioral-contract.md)
§14: `POST /api/place` is superseded by `core.space.place` rather than left as a permanent
exception (invariant 14 admits no second door onto "place a thing"), and `core.access` takes the
token and principal administration verbs now. The A5 evaluator (ADR 0011, grant rows,
`effectiveCaps`) landed in wave 4 (#77) beneath that same seam — "identity mechanism is floor"
never made `POST /api/tokens` mechanism, and the evaluator arriving did not change which of the
two is which.

**The `until` tag is gone, and the registry now says so.** The floor registry once carried an
`"until": "<plugin>"` field on rows that were floor today and plugin territory tomorrow, and this
table was its prose half. Every such field has been stripped; each deferral is folded into its row's
`why` as "… — awaiting `<plugin>`". Nothing replaces the field — a file is floor because it passes
the litmus test (`AXIOMS.md` §Foundation law), or it belongs to a plugin. There is no third state,
and therefore no tag for one.

Those **awaiting-rows are wave C's deletion list**: each names a file whose consumers the canvas,
compositions, terminals and presence conversions absorb, and wave C deletes the file and its row
together rather than re-annotating either. Integration verifies that the list has emptied before the
gate run, so "awaiting" is a sentence in a `why` that a human reads during review — not a machine
licence, and not a state a gate can be taught to tolerate.

## Decisions awaiting ratification

Dated ADRs that are written, complete and **not yet ratified**. The ratified wave order is
`AXIOMS.md` §Roadmap and stays there — this is not a second copy of it, and a row here changes
nothing about what is law. It answers one question the roadmap cannot: which proposed record is
currently waiting on the operator, and what a yes to it would oblige. A record leaves this table
by having its `Status:` line changed in the same commit that acts on it.

**Only yeses that OBLIGE are ratified** (operator ruling, 2026-09-01, made on ADR 0021): a record
that changes law or takes a dependency waits here for a signature; an evaluation that concludes
"change nothing" is written with `Status: RECORDED` and never enters this table — it is kept for
the next reader, not for the operator's pen. The first such record is
[`0021-dockview-evaluation.md`](docs/decisions/0021-dockview-evaluation.md) (the tile renderer
stays ours; its §8 reopen trigger is the living part).

**Nothing is waiting as of 2026-09-01.** Every prior occupant left by the rule above, and the
record below is where they went — kept here, in the one place that indexes proposed records,
because "the table is empty" and "the table was never filled in" have to be distinguishable a
month from now.

| ADR                                                                   | Ratified                                  | What the yes obliged                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`0015-social-layer.md`](docs/decisions/0015-social-layer.md)         | 2026-09-01, as written (R1-R5, R9)        | The `AXIOMS.md` §Roadmap amendment it predicted, landed in the same commit: there is no `core.social` seat, and Matrix is demoted from ratified leading candidate to an optional third-party bridge. R6-R8 ride the waterfall wave that implements `kind: "instance"` grants.                                                                                                |
| [`0016-plugin-isolation.md`](docs/decisions/0016-plugin-isolation.md) | 2026-09-01, as written (R1-R3, R5, R8-R9) | The marketplace gate is discharged — a runner is ratified, so distribution is unblocked behind its stage 1. `PluginStorage` owes an async migration for every plugin, and §9's pillar question (R7) is a §Pillar inventory edit in the commit that adds the runner's files.                                                                                                  |
| [`0019-identity-posture.md`](docs/decisions/0019-identity-posture.md) | 2026-09-01, ratified on landing           | The layered posture for #58: the owner key stays forever as bootstrap and break-glass, three hardening items are owed NOW (session expiry, a principal/device list with revoke, bootstrap audit on the trace ledger), reverse-proxy deployment is documented, and OIDC waits for a second human.                                                                             |
| [`0020-desktop-shell.md`](docs/decisions/0020-desktop-shell.md)       | 2026-09-01, with one amendment            | Electron as a pinned runtime dependency with a CVE duty, PWA-first sequencing, the minted-token bootstrap, and the gated prototype — amended with acceptance claim 5: `verify:budgets` must hold INSIDE the shell, and a miss triggers the Tauri re-evaluation early. GPUI weighed and rejected as a category error (§1.4a). No shell code before the prototype's ADR terms. |

## Disable semantics (D4′)

The ratified PER-KIND table, and the four rules that bind it. A1 (`AXIOMS.md`) is the law it
serves; the reasoning is
[`docs/decisions/0013-plugin-behavioral-contract.md`](docs/decisions/0013-plugin-behavioral-contract.md)
§1 (retain-only, purge), §4 (declarative dormancy, engine-owned placeholder), §9 (the closed
residual enum) and its 2026-08-31 correction, whose subject is this table: a gate check inherits
the authority of the contract it encodes, so R3 and S10 are amended in the same change as a row
here.

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
| **section** (sidebar)      | ABSENT — chrome renders absence; the Plugins section is the one ledger of what is off                   | returns to its manifest-ordered slot | slot gone                                     |
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
  assembly so the carve-out cannot grow unseen.
- **Refusals are named classes, not one boolean.** `essential` (the four rail non-negotiables
  `core.shell`, `core.brand`, `core.keys` and `core.plugins`, plus the three seats the floor
  dispatches: `core.space`, `core.index` and `core.access`), `builtin`
  (an engine door has no toggle), the dependency classes, the data-version classes and
  `still_enabled` are members of one published set; the roster also carries `changedBy` /
  `changedAt`, so a placeholder can say who turned this off, and `lifecycle` (`ok` /
  `enable_failed` / `disable_failed`), because a teardown that fails is a state every principal
  can see rather than an assertion. Disable always completes.

**A settings drop is NOT on this table**, and the distinction is the reason to say so here.
`contributes.settings` declares preferences whose values are per PRINCIPAL, and a section naming
one of its own plugin's settings is dropped from the sidebar while that value reads false
(`visibleSections`, `packages/plugin/src/settings.ts`). Every axis above is workspace-global and
about a plugin's ACTIVE surface; this one is one reader's rail. So none of the four rules apply
to it: nothing is retained, because there was nothing to retain — the plugin is enabled, its
doors answer, its data is untouched, and its other contributions are exactly where they were.
Nothing is marked, either: chrome renders absence when the workspace took something away, and a
preference was taken away by the person looking at it. The one ledger of what a reader has
turned off is the manager's own settings pane, which is where they turned it off.

## Lexicon

The law is `AXIOMS.md` §Lexicon law — one word per concept, one concept per word, and the
addition/retirement asymmetry. These are the rows, and this is how to read one.

Each row carries the canonical `term`, what it `means`, the synonyms it retires (`banned`), and
the exemptions that survive (`allow`). The check is lexical on purpose. Ownership is a graph
property, so the import walk (S2) must parse and follow edges; vocabulary is a token property, so
a banned word is banned wherever it appears and a scanner that reads tokens is not an
approximation of the check — it IS the check. Subjects are identifiers, the classified wire
literals (a property key, a `z.literal`/`z.enum` argument, a `className` or `data-*` value, an
`/api/` path), CSS selector tokens, file and directory names, and Markdown ATX headings; every
subject is split on
camel/kebab/snake/dot boundaries and matched word by word, which is why `padding` is safe and
`padStart` is caught, and why a `banned` list spells out both singular and plural instead of
trusting a stemmer. A plain string literal is deliberately NOT a subject: migration 11's body has
to say `ALTER TABLE pads` and rewrite the old `"surface"` leaf key, and a check that read those
would force an exemption licensing retired names inside live migration code — the narrow subject
set is what keeps the allowlist small enough to mean something.

Exemptions carry a reason and are scoped to their term, never global, and each must state its own
case. Four selector kinds, narrowest first: `exactIdent` (this whole
identifier is a foreign name), `importSpecifier` (this file speaks a vendor's vocabulary because
it imports the vendor), `declaration` (one frozen or historical table inside an otherwise live
file — migration 11's `PANEL_ID_RENAMES` is the live case: a rename table's left column IS the
retired name, and the file around it must obey the canon like any other floor file), and `glob`
(the file is frozen or foreign in
its entirety — `migrate-solo.ts`, which is migration 9's body and still names the pre-rename
schema in its own IDENTIFIERS, is the live case). CSS vendor selectors are recognized by prefix
rather than by row, so
`.react-flow__*` and `.xterm*` are skipped while `.flow-*` — ours — is not. **Every `allow` row
must suppress at least one real occurrence**: an exemption that stops being needed stops being
permitted, exactly as a stale floor glob fails S6. Six rows survive that test today, and the
registry below holds exactly those six.

Three things this does not enforce, stated so nobody assumes otherwise. **Prose inside comment
bodies** is review's job — scanning every comment would flag every legitimate English use of
`index`, `surface` and `view`, and the false-positive rate would get the check switched off, which
is worse than not having it; what a comment describes is covered mechanically because its
identifiers are. **A canonical word used for the wrong concept** — `container` meaning a tile — is
a semantic error, and the `means` field is what a reviewer reads to catch it. **A new collision
between two canonical words** passes S11 by construction; that is the residual risk, and an ADR
is what it is for.

One word is deliberately absent from every `banned` list. `view` is not banned, because it
survives as plain English in renderer names (`canvas-view.tsx`, `composition-view.tsx`, the
`core.shell.container-view` panel) where it means "a screen showing something" and nothing else.
Its four former DOMAIN senses each have a canon word — per-principal state is `vantage`, a
registered component is a `renderer`, the tiled container is a `composition`, the sidebar tree is
the `index` — so an occurrence of `view` is a question for a reviewer with the `means` column in
hand, never a gate failure. Retiring it later would be a registry edit plus a sweep, in one
commit.

S12 is the corollary that made this section necessary. Before the lexicon cut, three tables in the
engine translated the same wire kinds into human words and disagreed with each other: one called a
container "view", one called it "canvas", one called it "A canvas", and `tile` came out as
"composition" in one while `view` came out as "A composition" in another. That is not a bug to fix
in place — it is what having no canon costs, and a codebase that must translate its own vocabulary
at three sites will keep those sites out of sync forever. S12 asserts that exactly ONE table in
the tree maps an item kind to a display noun, that its keys are the assembled item kinds and
element types, and that every value's canonical word is the key's registry term. That table is
`ITEM_NOUNS` in `packages/plugin/src/item-noun.ts`, where a floor kind takes the floor's word and
a contributed kind takes its manifest element `title` — so the table stays closed while the kind
vocabulary stays open. The three that disagreed are gone: `carry.ts`'s label map is deleted,
`item-drop.ts` derives its prose from `ITEM_NOUNS`, and `ui/icons.tsx` names glyphs directly
instead of translating kinds into words a second time. Invariant 14,
applied to vocabulary: one door onto "what do we call this kind".

```json
{
  "lexicon": [
    {
      "term": "container",
      "means": "an addressable container row plus its Yjs document; holds exactly one discipline and has exactly one canonical manifold://container/<id> address",
      "banned": ["pad", "pads", "board"],
      "allow": [
        {
          "glob": "docs/PLAN.md",
          "why": "pad.ws is a different product's proper noun; the lineage heading names it"
        },
        {
          "glob": "packages/server/src/migrate-solo.ts",
          "why": "migration 9's body: replayed history, it names the pre-rename schema by design"
        },
        {
          "declaration": {
            "file": "packages/server/src/migrate-lexicon.ts",
            "name": "PANEL_ID_RENAMES"
          },
          "why": "a rename table's left column is by definition the retired name: migration 11 cannot remap a stored panel id without naming core.shell.pad-view once"
        },
        {
          "glob": "docs/decisions/2026-08-26-dnd-kit-react.md",
          "why": "a dated ADR's title is a historical record; the rename is recorded there as a dated addendum"
        },
        {
          "exactIdent": ["padStart", "padEnd"],
          "why": "String.prototype; not a domain word"
        }
      ]
    },
    {
      "term": "discipline",
      "means": "which renderer a container asks for, as a bounded id. The one field that separates one renderer of an object from another, and an OPEN roster since #110: a discipline is declared in a plugin manifest (contributes.disciplines) with the placement rows it owns, not enumerated in the protocol. The distribution ships canvas and composition. The retired claim that a value equals its owning plugin's last id segment is recorded in packages/protocol/src/layout.ts; who declares a discipline is answered by the assembly's registry and the published roster instead",
      "banned": [],
      "allow": []
    },
    {
      "term": "canvas",
      "means": "the freeform discipline, its renderer (core.canvas) and its item kind: elements placed at coordinates",
      "banned": [],
      "allow": []
    },
    {
      "term": "composition",
      "means": "the tiled discipline, its renderer (core.compositions) and its item kind: a tile layout over occupants. Compositions merge, never nest",
      "banned": ["tiled"],
      "allow": []
    },
    {
      "term": "layout",
      "means": "a tile tree: the flat table of tiles keyed by tile id, in a room document or in a principal's workspace",
      "banned": [],
      "allow": []
    },
    {
      "term": "seat",
      "means": "a place in an arranged tree whose content is something else's address, rendered by rendering its referent (ADR 0017 §3): a tile leaf is one, and a manifest's contributes.seats is its declared intent to occupy one in the default workspace",
      "banned": [],
      "allow": []
    },
    {
      "term": "space",
      "means": "the workspace's own arrangement: the core.space plugin that owns the layout writer (core.space.setLayout), the placement verb (core.space.place) and leaf removal (core.space.removeTile)",
      "banned": [],
      "allow": []
    },
    {
      "term": "assembly",
      "means": "the plugin-roster join: manifests and registrations checked against each other, producing one roster or naming every offender",
      "banned": [],
      "allow": []
    },
    {
      "term": "roster",
      "means": "the published plugin list: one entry per assembled row, served at GET /api/plugins and pushed on the connection-level plugins frame",
      "banned": [],
      "allow": []
    },
    {
      "term": "projection",
      "means": "mounting a live reference through a pipe and painting it; never absorbing what it shows (A4)",
      "banned": [],
      "allow": []
    },
    {
      "term": "vantage",
      "means": "one principal's published view state: the tool in hand, the edit target, the focused container, whether the sidebar is open, whether they are arranging and which arrangement they are standing in",
      "banned": [],
      "allow": []
    },
    {
      "term": "arrange mode",
      "means": "the published mode (F8, `vantage.arranging`) in which a workspace stops being interactive and the parts of ONE arrangement become reachable within their parent composition: at the root the workspace's panels move inside its tree, and inside a scoped panel that panel's own parts reorder — by pointer over the same seam and zone vocabulary every composition's own drag uses or by arrow key, and the arrangement commits at release through `core.space.setLayout` as per-principal layout data. Its toolbar is a PALETTE first: dragging Stack row, Stack column or Spacer out of it carries new structure into the workspace tree, into a composition, or into a scoped panel's own arrangement, over that same vocabulary and committing at that same release — the mode's primary verb is a carry, not a button. Three operations survive as buttons because each acts on the whole arrangement rather than on a place in it: Equalize, Shelf and Reset. Arming it moves nothing: every affordance the mode adds is out of flow, and a seat that arrives empty takes no room until somebody is arranging or carrying. Manifest order remains the default; an untouched workspace stores no arrangement",
      "banned": [],
      "allow": []
    },
    {
      "term": "arrange scope",
      "means": "which arrangement arrange mode is standing in, published as `vantage.arrangeScope`: a panel ref whose own parts are reachable, absent for the root (the workspace's panels). One scope at a time; Escape pops one level and F8 leaves from anywhere. Which panels HAVE an inner arrangement is declared by the plugin that owns them (`contributes.panels[].arranges { title }`), never enumerated by the floor",
      "banned": [],
      "allow": []
    },
    {
      "term": "attendance",
      "means": "who is present in a room right now, and its chrome",
      "banned": [],
      "allow": []
    },
    {
      "term": "peer",
      "means": "another principal",
      "banned": [],
      "allow": []
    },
    {
      "term": "ref",
      "means": "a reference to an item. Three bijective shapes: ManifoldRef (URI), TileRef (a leaf's occupant), PlacementRef (a placement subject)",
      "banned": [],
      "allow": []
    },
    {
      "term": "renderer",
      "means": "a registered component that paints a discipline, an element or a terminal",
      "banned": ["surface", "surfaces"],
      "allow": [
        {
          "glob": "docs/decisions/0013-plugin-behavioral-contract.md",
          "why": "a dated ADR keeps its own headings; §11 calls per-plugin storage a first-class surface, and the record is not rewritten"
        }
      ]
    },
    {
      "term": "node",
      "means": "anything with a manifold:// address: a container, a terminal, an element, a tile, a principal, a plugin, an action. Grants, events and shares all name nodes",
      "banned": [],
      "allow": []
    },
    {
      "term": "tile",
      "means": "one entry of a layout: a split or a leaf",
      "banned": [],
      "allow": []
    },
    {
      "term": "leaf",
      "means": "a childless tile",
      "banned": [],
      "allow": []
    },
    {
      "term": "split",
      "means": "a tile with children and a direction: the only shape in the grammar that divides an axis, and the only one that holds ratios. Its two directions are `row` and `column`. The palette calls them \"Stack row\" and \"Stack column\" because stacking is what a reader is DOING when they drop one, and the two `data-testid` values a gate drags from spell that same phrasing — but \"stack\" is never a NAME for this tile. It is the reader-facing verb; as an identifier it already belongs to the neutral chrome's `Stack` primitive, a flex run of children with no tree under it and no ratios. A split whose subtree holds no occupant is vacant, and takes no room off a reader who is not arranging",
      "banned": [],
      "allow": []
    },
    {
      "term": "structure",
      "means": "new tile material a palette carry holds and a drop authors: a SPLIT with a direction, arriving with two vacant seats, or an inert SPACER leaf. The one `PlacementRef` shape that addresses something which does not exist yet, which is why it is the one item kind with no identity, no container and no home — every structure is interchangeable with every other of its shape, and a drop makes one rather than moving one",
      "banned": [],
      "allow": []
    },
    {
      "term": "slot",
      "means": "a named mount position for a contribution: an overlay slot, a section's slot",
      "banned": [],
      "allow": []
    },
    {
      "term": "pane",
      "means": "the rendered box for a tile",
      "banned": [],
      "allow": []
    },
    {
      "term": "divider",
      "means": "the painted gap between two panes, and its thickness. What you see",
      "banned": [],
      "allow": []
    },
    {
      "term": "seam",
      "means": "the interaction band around a divider, measurably wider than the divider it wraps at every zoom. What you can hit",
      "banned": [],
      "allow": []
    },
    {
      "term": "probe",
      "means": "a read-only instrument a gate or an agent reads state through. The prose form for an architectural extension point is 'call surface'",
      "banned": [],
      "allow": []
    },
    {
      "term": "inspector",
      "means": "the operator-facing probe (core.debug, F10): point at any painted thing and be told its display noun, its manifold:// address, its owning plugin, which registered component paints it, the doors reachable under it and who occupies it. A probe read by a PERSON rather than by a gate or an agent, which is why it has its own word. It holds no write of its own — its direct writes are vantage.tool while armed, the clipboard, and the host's own navigation — but since #128 its pinned card OPENS the doors it lists: a generated form per action schema, dispatched through the action door exactly as any client would, refusals rendered as data",
      "banned": [],
      "allow": []
    },
    {
      "term": "terminal",
      "means": "one PTY: its lifecycle, its controller lease and its home container",
      "banned": [],
      "allow": []
    },
    {
      "term": "program",
      "means": "the argv a PTY execs in place of $SHELL (`terminal_open.program`, judged at `core.terminals.open` whose input carries it, then carried to the agent as `create.program`, issue #192); absent ≡ the login shell. Named PROGRAM rather than command because `command` is core.commands' word for a palette row, and one concept per word means the second claimant renames",
      "banned": [],
      "allow": []
    },
    {
      "term": "session",
      "means": "one client connection: the socket, its channels and its connection-level frames",
      "banned": [],
      "allow": []
    },
    {
      "term": "role",
      "means": "a channel's join role: spectator or occupant",
      "banned": [],
      "allow": []
    },
    {
      "term": "item",
      "means": "a thing that can be placed: identity-bearing, addressed by identity",
      "banned": [],
      "allow": []
    },
    {
      "term": "placement",
      "means": "one appearance of an item inside a container. An item may have many; deleting a placement never deletes the item",
      "banned": [],
      "allow": []
    },
    {
      "term": "element",
      "means": "a canvas record type plus its renderer",
      "banned": [],
      "allow": []
    },
    {
      "term": "portal",
      "means": "a canvas element projecting another container",
      "banned": ["widget", "widgets"],
      "allow": []
    },
    {
      "term": "index",
      "means": "the one workspace index of containers and folders, owned by core.index",
      "banned": [],
      "allow": []
    },
    {
      "term": "entry",
      "means": "one row of the index: IndexEntry, a container or a folder",
      "banned": [],
      "allow": []
    },
    {
      "term": "branch",
      "means": "an index entry that holds children: IndexBranch",
      "banned": [],
      "allow": []
    },
    {
      "term": "notice",
      "means": "the one stack of transient and sticky messages",
      "banned": ["toast", "toasts"],
      "allow": []
    },
    {
      "term": "workspace",
      "means": "one instance's whole arrangement; the shell host is its root and each principal has their own layout of it",
      "banned": [],
      "allow": []
    },
    {
      "term": "shell",
      "means": "the workspace host: panels all the way down",
      "banned": [],
      "allow": []
    },
    {
      "term": "overlay",
      "means": "chrome a plugin paints into a renderer's named slot without either importing the other",
      "banned": [],
      "allow": []
    },
    {
      "term": "glyph",
      "means": "one icon from the single icon vocabulary",
      "banned": [],
      "allow": []
    },
    {
      "term": "spotlight",
      "means": "a server-written vantage field that asks a peer's renderer to center on an address; consented, rate-limited, attributable",
      "banned": [],
      "allow": []
    },
    {
      "term": "presence",
      "means": "state that dies with the connection: cursor, selection, viewport, vantage, status",
      "banned": [],
      "allow": []
    },
    {
      "term": "plugin",
      "means": "a manifest plus what it contributes and the actions it declares; everything above the floor is one",
      "banned": [],
      "allow": []
    },
    {
      "term": "builtin",
      "means": "a roster row the ENGINE registered rather than an assembly file: published as source \"builtin\", carrying no toggle (setEnabled against it is refused/builtin). A fact about who registered a row, DERIVED from the engine's own definitions and never claimable by a manifest — engine.plugins is the only one, and engine. is a reserved namespace",
      "banned": [],
      "allow": []
    },
    {
      "term": "essential",
      "means": "a manifest's declared claim that the workspace does not function without it: an enforced tier with its own refusal class, so setEnabled(false) is refused/essential while everything else about the row — dispatch, dependencies, dormancy, purge — is ordinary. A refusal at the DOOR rather than an impossibility: an assembly can still arrive with such a seat off out of band, which is the state the floor's recovery gate answers, so the disabled-door contracts (rung 2, cleanup carve-outs) stay live. Independent of source and of namespace; the claimants are the rail's non-negotiables (core.shell, core.brand, core.keys, core.plugins) and the seats the floor dispatches (core.space, core.index, core.access)",
      "banned": [],
      "allow": []
    },
    {
      "term": "core",
      "means": "the authorship namespace of the plugins manifold itself ships (core.shell, core.index, …), and NOTHING more: it confers no privilege anywhere in the engine, which is the checkable half of \"core is not privileged\". Reserved all the same — assembly refuses a manifest under core. that the shipped distribution did not register, the permitted set being derived from the two assembly files rather than listed a second time",
      "banned": [],
      "allow": []
    },
    {
      "term": "manifest",
      "means": "a plugin's inert declaration: id, capability ceiling, dependencies, data version, dormancy, contributions",
      "banned": [],
      "allow": []
    },
    {
      "term": "contribution",
      "means": "one declared offering of a plugin: a panel, a section, an element, a tool, an event, a binding",
      "banned": [],
      "allow": []
    },
    {
      "term": "binding",
      "means": "contribution kind: one key this workspace answers to — a declared key, label and scope claimed globally, dispatched to its owning plugin's handler and printed in the sidebar's key table",
      "banned": [],
      "allow": []
    },
    {
      "term": "panel",
      "means": "contribution kind: a full renderer that can be a leaf of a workspace layout",
      "banned": [],
      "allow": []
    },
    {
      "term": "section",
      "means": "contribution kind: a composable row of the sidebar — a disclosure with a body, or a plain row — ordered by its manifest unless the reader has arranged it (see arrange mode), and painted beside its cluster's other members when it declares one. A reader's arrangement of them is a TREE, not a flat order: a row sits somewhere in the rail's stack, and a stack dropped between two rows holds its own rows along the other axis",
      "banned": [],
      "allow": []
    },
    {
      "term": "setting",
      "means": "contribution kind: one preference a manifest declares (contributes.settings — id, title, kind, default), whose VALUE is per principal, server-saved as a delta over the declaration and written only through engine.plugins.setSetting. A section may name one of its own plugin's settings (SectionDef.setting), and a row whose setting reads false is DROPPED at composition (visibleSections) — a preference, never a disable: nothing is retained, marked or tombstoned, because the reader who turned it off already knows where it went. It is the engine's noun rather than any plugin's: the engine composes the table, refuses a write no declaration answers, and has no favourite among the manifests that declare them",
      "banned": [],
      "allow": []
    },
    {
      "term": "cluster",
      "means": "a set of sidebar rows that declared the same contributes.sections[].cluster word: they paint side by side as ONE unit of the rail's stack, placed where the cluster's earliest member sits in the live order (clusteredSections). Membership is declared, never positional, and no floor file, panel or registry holds a list of a cluster's members — core.keys and core.plugins sit together at the rail's foot because both manifests say \"utility\". NOT group: that word is the placement algebra's capability set, and one concept per word is the law. The Cluster box in @manifold/plugin/ui is a layout primitive that happens to paint one, exactly as the layout family's components are named for the shape they draw",
      "banned": [],
      "allow": []
    },
    {
      "term": "tool",
      "means": "contribution kind: one row of a toolbar, on whichever toolbar its contributes.tools row names. What the row IS to a reader belongs to the bar's owner and never to the manifest — the canvas bar draws modes, the arrange bar draws a palette of carry sources beside the buttons of its whole-arrangement operations",
      "banned": [],
      "allow": []
    },
    {
      "term": "toolbar",
      "means": "the closed vocabulary a tool's toolbar field names: canvas (core.canvas's tool strip) or arrange (core.arrange's floating F8 editor toolbar). Absent \u2261 canvas",
      "banned": [],
      "allow": []
    },
    {
      "term": "palette",
      "means": "core.arrange's row of carry SOURCES in the arrange toolbar: dragging one out carries new structure into a tree. Not a second drag flavour and not a new contribution kind — a palette drag is an ordinary carry whose ref names structure instead of an item, so it crosses the same seams, resolves through the same zones, is refused by the same named rules and commits at the same release as every other carry. Which rows the palette holds is core.arrange's own reading of its own `contributes.tools`, never a manifest field",
      "banned": [],
      "allow": []
    },
    {
      "term": "action",
      "means": "a registered, authority-checked, argument-validated mutation dispatched at POST /api/actions/:name",
      "banned": [],
      "allow": []
    },
    {
      "term": "command",
      "means": "one row of core.commands' surface: a composed ACTION, a composed BINDING or an index CONTAINER, projected into one addressable line a reader can filter and act on (issue #129). A command is a PROJECTION of a registry that already exists, never a fourth registry and never a contribution kind — nothing declares one, and nothing can be a command that is not already a door, a key or a node, which is what keeps the surface from becoming a second list of what a workspace can do. It is deliberately NOT called a palette: that word is taken, by core.arrange's row of carry sources, and one concept per word means the second claimant renames rather than the first blurring",
      "banned": [],
      "allow": []
    },
    {
      "term": "door",
      "means": "the one authoritative entry point onto a concept, where authority is decided",
      "banned": [],
      "allow": []
    },
    {
      "term": "plane",
      "means": "where a piece of state lives: action, document, presence, event, or channel traffic",
      "banned": [],
      "allow": []
    },
    {
      "term": "event",
      "means": "a notification emitted at a mutation's commit point — one node, one kind, once. It never mutates, is delivered only to the sockets subscribed at that instant, and is never replayed; the durable audit row of the same name is the same word for the same thing, read as a table",
      "banned": [],
      "allow": []
    },
    {
      "term": "trace",
      "means": "the durable record of ONE exercise of authority at a door: actor, authority satisfied, door, targets, payload, outcome, origin — appended by the dispatch ladder, never by a handler, and a row family in the same journal an event row lands in (axiom A6). A refusal is a trace; an unregistered name is not, because nothing was exercised",
      "banned": [],
      "allow": []
    },
    {
      "term": "journal",
      "means": "the workspace's one durable append-only table of what happened — the `events` table, holding both row families: event rows (a notification's durable half) and trace rows (an exercise of authority). One retention, one read door",
      "banned": [],
      "allow": []
    },
    {
      "term": "door",
      "means": "one registered action, addressed by its full name, through which a mutation's authority is decided exactly once; also the column naming it on a trace row",
      "banned": [],
      "allow": []
    },
    {
      "term": "topic",
      "means": "the node an event is about and a subscription names: a manifold:// address, never a string convention, a namespace of its own, or a wildcard pattern",
      "banned": [],
      "allow": []
    },
    {
      "term": "subscription",
      "means": "one socket's declared interest in a topic: presence-class state, authorized as a read of the topic's node, dying with the connection and never persisted",
      "banned": [],
      "allow": []
    },
    {
      "term": "pipe",
      "means": "the channel a reference crosses to be projected: a session channel onto a room, the machine channel onto a daemon, and from wave 3 an instance channel onto another manifold",
      "banned": [],
      "allow": []
    },
    {
      "term": "room",
      "means": "one container's live server-side document plus its members",
      "banned": [],
      "allow": []
    },
    {
      "term": "channel",
      "means": "one client-chosen handle onto one room, multiplexed over one socket",
      "banned": [],
      "allow": []
    },
    {
      "term": "frame",
      "means": "one JSON message on a socket: connection-level or channel-level",
      "banned": [],
      "allow": []
    },
    {
      "term": "scene",
      "means": "a room's document: its elements and its layout map",
      "banned": [],
      "allow": []
    },
    {
      "term": "doc",
      "means": "the Yjs document a scene is stored in",
      "banned": [],
      "allow": []
    },
    {
      "term": "grant",
      "means": "an authority row: principal or class, node, capabilities, effect, reach. The only thing that confers authority — a token references grants, it does not carry any",
      "banned": [],
      "allow": []
    },
    {
      "term": "waterfall",
      "means": "the evaluation of grants down a node's containment path: root to node, deeper beating shallower, principal beating class, deny beating allow at equal specificity. The one answer to \"what may this principal do here\" (effectiveCaps)",
      "banned": [],
      "allow": []
    },
    {
      "term": "effect",
      "means": "which way a grant row points: allow or deny. A denial is a row, never an expression",
      "banned": [],
      "allow": []
    },
    {
      "term": "reach",
      "means": "how far down a grant row applies from the node it names: node (that node alone) or subtree (that node and everything under it)",
      "banned": [],
      "allow": []
    },
    {
      "term": "cap",
      "means": "one capability name, spelled <domain-plural>:<verb>",
      "banned": [],
      "allow": []
    },
    {
      "term": "token",
      "means": "a bearer credential referencing grants; hashed at rest, optionally container-scoped",
      "banned": [],
      "allow": []
    },
    {
      "term": "principal",
      "means": "one actor: a human or an agent, with identical reach",
      "banned": [],
      "allow": []
    },
    {
      "term": "machine",
      "means": "one enrolled host running an agent daemon that owns PTYs",
      "banned": [],
      "allow": []
    },
    {
      "term": "instance",
      "means": "one manifold server and its data: an addressing space with exactly one origin, and the unit a share crosses between",
      "banned": [],
      "allow": []
    },
    {
      "term": "origin",
      "means": "which instance something belongs to, as one normalized absolute http(s) base URL; absent on a principal means this instance",
      "banned": [],
      "allow": []
    },
    {
      "term": "share",
      "means": "a token bound to a node and minted for a named guest origin: the cross-instance form of a grant, revocable and never expiring",
      "banned": [],
      "allow": []
    },
    {
      "term": "dial",
      "means": "a long-lived outbound pipe from a process to an instance, and the guest-side row for one accepted share: the machine channel and the instance channel are both dials",
      "banned": [],
      "allow": []
    },
    {
      "term": "host",
      "means": "the instance a shared node lives at: it mints the share, answers the dial and owns the room the projection joins",
      "banned": [],
      "allow": []
    },
    {
      "term": "guest",
      "means": "the instance a share was minted for: it holds the secret, dials the host and asks for tickets on behalf of its own principals",
      "banned": [],
      "allow": []
    },
    {
      "term": "ticket",
      "means": "the per-principal token a host mints under a share, carrying the guest's origin: an ordinary attenuated token, never a second credential kind",
      "banned": [],
      "allow": []
    },
    {
      "term": "place",
      "means": "the verb: move an item into a destination, refused by name when the algebra says no",
      "banned": [],
      "allow": []
    },
    {
      "term": "carry",
      "means": "motion as the dynamic half of the algebra: one gesture kind for anything grabbed by its chrome",
      "banned": [],
      "allow": []
    },
    {
      "term": "drop",
      "means": "the commit point of a carry",
      "banned": [],
      "allow": []
    },
    {
      "term": "flip",
      "means": "the ONE way a stack whose order is DATA animates a reflow: measure the rows' boxes, let the new order commit, measure again, invert each row with a transform and play it out (First-Last-Invert-Play). The engine's `@manifold/plugin/ui` owns the arithmetic (`flipShifts`, `useFlipStack`); `prefers-reduced-motion: reduce` disables it entirely rather than shortening it. Named because the sidebar's row stack reflows for three unrelated reasons — an arrange commit, a keyboard nudge, a plugin being enabled or disabled — and a re-render teleports: motion is what says which row went where",
      "banned": [],
      "allow": []
    },
    {
      "term": "zone",
      "means": "a region of a renderer that resolves a carry to one destination",
      "banned": [],
      "allow": []
    },
    {
      "term": "group",
      "means": "a capability set an item kind belongs to and a container kind accepts",
      "banned": [],
      "allow": []
    },
    {
      "term": "guard",
      "means": "one enumerated imperative placement rule",
      "banned": [],
      "allow": []
    },
    {
      "term": "trait",
      "means": "an item kind's declared placement data: groups, guards, homing",
      "banned": [],
      "allow": []
    },
    {
      "term": "kind",
      "means": "the discriminant of a wire union, or the declared class of an event. Both senses answer \"which of these is this one\" — the union's members are closed by a schema, an event's by the assembly's declarations — and the pair inside one event frame is deliberate: topic.kind names the address form, kind names what happened",
      "banned": [],
      "allow": []
    },
    {
      "term": "op",
      "means": "the operation a resolved placement will run",
      "banned": [],
      "allow": []
    },
    {
      "term": "rule",
      "means": "the named class a refusal carries",
      "banned": [],
      "allow": []
    },
    {
      "term": "denial",
      "means": "an action outcome that is not ok: a rule plus a message. Data, never an HTTP error",
      "banned": [],
      "allow": []
    },
    {
      "term": "refusal",
      "means": "a domain-grounded no from a handler or the engine, named by class",
      "banned": [],
      "allow": []
    },
    {
      "term": "floor",
      "means": "the foundation: the code the axioms' own enforcement machinery needs",
      "banned": [],
      "allow": []
    },
    {
      "term": "pillar",
      "means": "one admitted unit of the floor, passing all three litmus criteria and owning its globs",
      "banned": [],
      "allow": []
    },
    {
      "term": "folder",
      "means": "an index entry that holds entries and nothing else",
      "banned": [],
      "allow": []
    },
    {
      "term": "stroke",
      "means": "one freehand ink record: `core.draw`'s element kind, the sampling distance a gesture retains points at, and the width it is painted with. A stroke is not a POLYLINE — the ink is the domain noun, the coordinates are the geometry — and only a plugin may say the word",
      "banned": [],
      "allow": []
    },
    {
      "term": "polyline",
      "means": "a flat `[x0, y0, x1, y1, …]` coordinate sequence and the geometry over it: extents, SVG path data, a viewBox, a rebase onto an origin (`packages/plugin/src/polyline.ts`). The neutral half of what used to be two private copies of stroke math (issue #117) — it names no plugin and no element kind, which is why the ENGINE may hold it while `stroke` stays `core.draw`'s word",
      "banned": [],
      "allow": []
    },
    {
      "term": "draw",
      "means": "the freehand tool and its element kind",
      "banned": [],
      "allow": []
    },
    {
      "term": "route",
      "means": "one HTTP or browser path. As a CONTRIBUTION KIND it is a browser path segment a plugin claims in its manifest (contributes.routes: { segment, title }): one URL space, so the segment is claimed globally and two manifests wanting it refuse with both names, while the web half only registers who draws it",
      "banned": [],
      "allow": []
    },
    {
      "term": "isolate",
      "means": "the runtime an INSTALLED plugin's code lives in and the boundary around it (ADR 0016 §1): one OS process per plugin on the server, one dedicated Worker per plugin in the browser, reached only through the protocol's frame pairs (`IsolateHostFrame`/`IsolateChildFrame`, `WebIsolateHostFrame`/`WebIsolateWorkerFrame`). A first-party row has none — it runs in-realm — and the roster says which by the presence of `install`, never by a third `source`",
      "banned": [],
      "allow": []
    },
    {
      "term": "bundle",
      "means": "the one-file JSON artifact an isolated plugin is installed from (`PluginBundleSchema`: format, manifest with `entry`, base64 members), pinned on the roster row by the sha256 of its exact bytes and re-verified at every boot. `artifact` is the word for those bytes wherever they are read (`ISOLATE_MAX_ARTIFACT_BYTES`, `artifact_unreadable`, `artifact_invalid`); `bundle` is the parsed document — one is the file, the other its meaning",
      "banned": [],
      "allow": []
    },
    {
      "term": "vocabulary",
      "means": "a CLOSED set the engine publishes as data and refuses anything outside of: the action, placement, event, grant and instance vocabularies at `GET /api/protocol`, the `evt` log vocabulary, and — for an isolated web half — the component vocabulary (`UiNodeSchema`: thirteen node kinds, five tones) it renders with instead of ever touching the DOM (ADR 0016 §3). A vocabulary is the opposite of an escape hatch: a kind or word it does not list is a refusal, never an `unknown`",
      "banned": [],
      "allow": []
    }
  ]
}
```

### Where a selector family lives

The register above says which word names a concept. This one says whose stylesheet may paint
it, and it exists because until now the answer was "any of them, in one file".
`packages/web/src/styles.css` was 3,572 lines and 510 selectors, and the terminal's frame, the
canvas's portals, the presence stack and the plugin manager's rows were floor by accident of
where they had been typed. A skin that cannot leave with the plugin it dresses is a plugin that
was never really extracted (A1), so the stylesheet is split by owner and `verify:axioms` S13
holds the split. Every plugin package that paints anything now carries `src/styles.css`,
imported by its web half; vite emits it into the built CSS because all plugin code is
statically assembled.

**A family is a name, which is why this register sits here.** The family of a class is the
LONGEST `family` below that is a prefix of it ending on a `-` or `__` boundary, so `terminal`
answers for `.terminal-frame--panel-highlight` while `canvas-text` beats `canvas` for the note
element and `portal__slot` beats `portal` for the tile-tree's pane. A class matching no row is
RED: adding a family is a row, exactly as adding a canon word is.

**Ownership follows the SCOPE, not the subject.** The first class of a compound names a
family; classes written beside it in that compound qualify it (`.status-dot.open` is the
`status` family in its `open` state, never an `open` family). A rule belongs to the owner of
the LEFTMOST such family in each of its selectors — the subtree the rule reaches into — because
that is the code whose removal makes the rule dead. `.portal--mono .terminal-frame` is the
canvas plugin's rule about a terminal, and it goes when portals go. Compounds further right are
context: they are checked for REGISTRATION, so no family hides inside a descendant selector,
and never for ownership. `@keyframes` names are families too. A rule with no class anywhere —
the reset, `:root`, `[data-drop-denial]` — is the floor's by construction and may appear
nowhere else, which is what stops a plugin from restyling `body`.

**One owner is not a package, and that asymmetry is real.** Every plugin's stylesheet lives in
its package. The shell's cannot: the sidebar, the workspace frame and the routed container view
are FLOOR files (§Foundation), and a floor file may not import `@manifold-plugin/*`, so there
is no shell package to put them in. `packages/web/src/shell.css` is therefore a second owner
inside `packages/web`, registered as its own stylesheet rather than folded back into the floor
sheet — the check enforces the FILE, so a separate owner in the same directory costs nothing
and saying "the shell owns this" out loud is worth something. The neutral chrome has no such
problem: `packages/plugin/src/ui/styles.css` sits with the components that emit those classes,
because `packages/plugin` is floor that everything already imports.

Rows are live or they are gone. A row whose stylesheet does not exist, or which no rule in that
stylesheet defines, fails exactly as a stale floor glob fails S6 and a stale exemption fails
S11. `owner: "shared"` is the single exception and has exactly one member: `is-*` is a state
prefix, never a scope root, and belongs to no stylesheet.

```json
{
  "cssFamilies": [
    {
      "family": "*",
      "owner": "packages/web/src/styles.css",
      "why": "not a prefix: the rules with no class at all. The reset, `:root`, the element defaults and `[data-drop-denial]` reach every node in the document, which is exactly the reach a plugin must not have — so they live in the floor's sheet and the check refuses them anywhere else"
    },
    {
      "family": "gate",
      "owner": "packages/web/src/styles.css",
      "why": "the pre-identity gate screen and its card: the first paint of the product, before any plugin exists to have an opinion"
    },
    {
      "family": "identity",
      "owner": "packages/web/src/styles.css",
      "why": "the identity dialog and the colour dot beside a name — device bootstrap, which by definition cannot belong to a plugin"
    },
    {
      "family": "eyebrow",
      "owner": "packages/web/src/styles.css",
      "why": "the small line above a gate heading"
    },
    {
      "family": "color",
      "owner": "packages/web/src/styles.css",
      "why": "the identity colour picker: its fieldset, its grid and its swatches"
    },
    {
      "family": "field-label",
      "owner": "packages/web/src/styles.css",
      "why": "the one form label, shared by the gate and the identity dialog"
    },
    {
      "family": "form-error",
      "owner": "packages/web/src/styles.css",
      "why": "the one inline form error"
    },
    {
      "family": "primary-button",
      "owner": "packages/web/src/styles.css",
      "why": "the one primary action button the bootstrap dialogs use"
    },
    {
      "family": "sr-only",
      "owner": "packages/web/src/styles.css",
      "why": "the screen-reader-only utility"
    },
    {
      "family": "notice",
      "owner": "packages/web/src/styles.css",
      "why": "the one notice stack. The PROVIDER is floor (`notice.tsx`) and every plugin raises into it through `@manifold/plugin/ui`, so the layer's skin is the floor's"
    },
    {
      "family": "plugin-placeholder",
      "owner": "packages/web/src/styles.css",
      "why": "the engine-owned inert placeholder for a contribution whose plugin is off (ADR 0013 §4). A plugin may not supply the chrome for its own absence, so it may not supply the chrome's skin either"
    },
    {
      "family": "skeleton",
      "owner": "packages/web/src/styles.css",
      "why": "`@keyframes skeleton-pulse`, ridden by the shell's container skeleton and the index's rows alike: a token, which is what the floor publishes"
    },
    {
      "family": "lens",
      "owner": "packages/web/src/styles.css",
      "why": "the banner naming what this WINDOW is doing — offline, a newer build waiting, a foreign instance (`lens.tsx`). The floor's sheet rather than an owner's: it paints above the identity gate, before any plugin exists to have an opinion, and it is the one layer that has to be legible when the roster failed to load at all"
    },
    {
      "family": "sidebar",
      "owner": "packages/web/src/shell.css",
      "why": "the sidebar rail, its rows and inline actions. The rail's LAYOUT is painted by @manifold-plugin/shell's `sidebar-panel.tsx` — which after the rail was hollowed (2026-09-01) is the collapse control, the stack, the chrome each presentation wears, and the wrappers a declared CLUSTER and a reader's own nested arrangement paint in, and nothing else. Every class inside a row is filled by a PLUGIN: `.sidebar-row`, `.sidebar-link`, `.sidebar-list`, `.sidebar-muted`, `.sidebar-section-action` by core.index, core.machines and core.plugins; `.sidebar-section-content`, `.sidebar-section-count` and `.sidebar-section-empty` by those three AND core.access, whose credential list is the newest tenant of the same row rhythm (ADR 0019 §3); `.sidebar-new` by core.canvas, core.compositions and core.index, one creator each; `.sidebar-brand` by core.brand, `.sidebar-status` and `.sidebar-identity` by core.shell's two remaining rows; `.sidebar-opener` by core.keys AND core.plugins, which is the clearest case for the rule — two clustered rows that must look identical cannot be two stylesheets agreeing (issue #91) — and `.sidebar-cluster` by the rail itself, around rows whose plugins have never heard of each other, joined by `.sidebar-split` (issue #104) around the members of a stack the reader dropped between two rows, which is the same case again: two plugins' rows wear that wrapper, so it can live in neither plugin's package. So the owner is the floor sheet, exactly as for `plugin-placeholder` and `notice`: plugins fill these rows, the layer owner owns the row — and moving the family into one plugin's package would now make six plugins depend on a seventh's stylesheet"
    },
    {
      "family": "keys",
      "owner": "packages/plugins/keys/src/styles.css",
      "why": "core.keys' binding EDITOR: the modal, its rows, the loud collision refusal, the armed slot a captured keystroke lands in, and the reset controls. It left the floor sheet with the seat (issue #91) — a skin that cannot leave with the plugin it dresses is a plugin that was never really extracted — while the discreet OPENER row the seat wears stays in the `sidebar` family, because core.plugins wears it too, and the KEYCAP left one host further down (issue #129) the day a second surface began printing the same composed table"
    },
    {
      "family": "keycap",
      "owner": "packages/plugin/src/ui/styles.css",
      "why": "THE keycap: one keystroke drawn as a key, and the one place `Mod` becomes ⌘ or Ctrl — `keycap.tsx`. It was `.keys-cap` and its sheet called it \"the one keycap in the product\", which held exactly as long as one seat printed the composed key table; the table is the engine's read (`host.assembly.bindings`), so any plugin may print a row and the shape belongs to the stdlib rather than to whichever tenant drew it first (issue #129)"
    },
    {
      "family": "commands",
      "owner": "packages/plugins/commands/src/styles.css",
      "why": "core.commands' surface (issue #129): the Mod+K card, its search line, its grouped rows and the verb hint the highlighted row wears. Every rule is anchored on a `commands-*` class for a second reason beyond A1 — `cmdk` marks its own parts with ATTRIBUTES (`[cmdk-item]`, `[cmdk-group-heading]`), which own no family and would otherwise fall to the floor's `*` row, so scoping each under this surface keeps the library's internals styled by the package that chose the library"
    },
    {
      "family": "workspace",
      "owner": "packages/web/src/shell.css",
      "why": "the workspace frame and its empty state \u2014 painted by the floor host `workspace.tsx` and by @manifold-plugin/shell's `container-view-panel.tsx`. The arrange-mode affordances that used to live in this family (`workspace-arrange-*`, `workspace-panel-grip*`) moved out with the grips themselves to `core.arrange` (issue #89, `arrange` family below); what stays is the frame `workspace.tsx` still draws on its own account \u2014 the `.is-arranging` state class that blanks its own tile content hosts while the plugin's overlay is armed, and nothing that used to be chrome over a leaf it does not own"
    },
    {
      "family": "status",
      "owner": "packages/web/src/shell.css",
      "why": "the connection pip and its meta line in the sidebar identity block, `status-dot-ping` included"
    },
    {
      "family": "collapsed-presence",
      "owner": "packages/web/src/shell.css",
      "why": "the popover the collapsed rail shows instead of the presence stack"
    },
    {
      "family": "container-load-error",
      "owner": "packages/web/src/shell.css",
      "why": "the banner the routed shell raises when a container will not resolve"
    },
    {
      "family": "container-name-menu-item",
      "owner": "packages/web/src/shell.css",
      "why": "the container name row inside a sidebar menu"
    },
    {
      "family": "canvas-skeleton",
      "owner": "packages/web/src/shell.css",
      "why": "the cold-route skeleton. The prefix records WHERE it is painted; the owner is who paints it — the shell shows this before any discipline renderer has been asked for, so it cannot live in the canvas plugin"
    },
    {
      "family": "web-changelog",
      "owner": "packages/web/src/shell.css",
      "why": "the in-app history dialog the sidebar's version line opens"
    },
    {
      "family": "node-titlebar",
      "owner": "packages/plugin/src/ui/styles.css",
      "why": "the one titlebar a container node wears, `node-titlebar.tsx`"
    },
    {
      "family": "layout",
      "owner": "packages/plugin/src/ui/styles.css",
      "why": "the layout algebra (`layout.tsx`): Stack, Cluster, Sidebar, Switcher, Cover, Frame — the intrinsic boxes plugin bodies and the shell compose. Named for what a COMPONENT paints; the canon term `layout` (a tile tree) is untouched, and the prefix keeps the two apart in CSS the way the doc comment does in prose"
    },
    {
      "family": "disclosure",
      "owner": "packages/plugin/src/ui/styles.css",
      "why": "the one disclosure — a header button that folds the body under it (`disclosure.tsx`); its behavior engine is Radix Collapsible, an internals decision (docs/decisions/2026-08-31-radix-behavior-primitives.md)"
    },
    {
      "family": "chip",
      "owner": "packages/plugin/src/ui/styles.css",
      "why": "the one chip — a small bordered token that is a button exactly when it acts and an inert span otherwise, one box for both forms (`chip.tsx`). The box (border, radius, padding, type size) is the stdlib's; the tint is the adopter's, written in its own family's sheet"
    },
    {
      "family": "kv",
      "owner": "packages/plugin/src/ui/styles.css",
      "why": "the one key-value list — a labelled reading of one thing as the definition list it is (`kv.tsx`): the list's rhythm, the row's two columns, the wrap-not-scroll value contract, and the `--kv-label` width knob"
    },
    {
      "family": "popover",
      "owner": "packages/plugin/src/ui/styles.css",
      "why": "the one popover's floating layer (`popover.tsx`), portaled to the body above every pointer-transparent overlay; its behavior engine is Radix Popover, an internals decision (docs/decisions/2026-09-01-radix-popover.md)"
    },
    {
      "family": "credential",
      "owner": "packages/plugins/access/src/styles.css",
      "why": "core.access' credential list (ADR 0019 §3): the principal row, its colour pip, the meta line under the name, the two-press withdraw control and the refusal it renders in place. It is this plugin's sheet rather than a block in the shell's for `keys`' reason — a skin that cannot leave with the plugin it dresses is a plugin that was never really extracted — while the row VOCABULARY the section fills (`.sidebar-section-content`, `.sidebar-section-count`, `.sidebar-section-empty`) stays in the `sidebar` family, because a class more than one tenant fills belongs to whoever owns the rail"
    },
    {
      "family": "scroll-region",
      "owner": "packages/plugin/src/ui/styles.css",
      "why": "the one scroll container — vertical only, slim overlay thumb (`scroll-region.tsx`); its behavior engine is Radix ScrollArea, an internals decision (docs/decisions/2026-08-31-radix-behavior-primitives.md)"
    },
    {
      "family": "tile",
      "owner": "packages/plugin/src/ui/styles.css",
      "why": "the tile area, the live drop preview and its glyphs, the content host a pane's content rides in, and the F9 zone probe — `tile-tree.tsx`, `tile-preview-overlay.tsx`, `tile-zone-debug.tsx`"
    },
    {
      "family": "carry-ghost",
      "owner": "packages/plugin/src/ui/styles.css",
      "why": "the ghost that follows a carry, plus the ease-away the held item rides — `carry.ts`"
    },
    {
      "family": "drop-denial-note",
      "owner": "packages/plugin/src/ui/styles.css",
      "why": "the prose half of a refused drop; the machine half is the floor's `[data-drop-denial]`"
    },
    {
      "family": "container-overlay-slot",
      "owner": "packages/plugin/src/ui/styles.css",
      "why": "where one plugin's renderer paints another plugin's occupant — `projection.ts`"
    },
    {
      "family": "workspace-overlay-slot",
      "owner": "packages/plugin/src/ui/styles.css",
      "why": "the same slot one host up: where a plugin paints chrome over the WORKSPACE rather than over a container — the inspector chip, the arrange toolbar — `projection.ts`"
    },
    {
      "family": "inspector",
      "owner": "packages/plugins/debug/src/styles.css",
      "why": "core.debug's F10 inspector: the chip that follows the pointer, the card a press pins, and the row vocabulary both are built from. One family, because the two are one reading at two levels of detail"
    },
    {
      "family": "door-form",
      "owner": "packages/plugins/debug/src/door-form.css",
      "why": "the generated door-invocation form a pinned inspector card opens (#128): the popover layer's width, the generated fields' rhythm (element-scoped on purpose — rjsf's emitted class vocabulary is engine internals no sheet may anchor on, docs/decisions/2026-09-01-rjsf-door-forms.md), the dispatch control and the outcome/refusal rows. Its own sheet beside the module so the skin loads with the lazy chunk it dresses"
    },
    {
      "family": "mf-icon",
      "owner": "packages/plugin/src/ui/styles.css",
      "why": "the glyph vocabulary, `icons.tsx`"
    },
    {
      "family": "composition-split",
      "owner": "packages/plugin/src/ui/styles.css",
      "why": "tile-tree skin (`COMPOSITION_TREE_CLASSES`)"
    },
    {
      "family": "composition-pane",
      "owner": "packages/plugin/src/ui/styles.css",
      "why": "tile-tree skin (`COMPOSITION_TREE_CLASSES`)"
    },
    {
      "family": "composition-divider",
      "owner": "packages/plugin/src/ui/styles.css",
      "why": "tile-tree skin (`COMPOSITION_TREE_CLASSES`); `dividerPx: 5.6` in `tile-tree.tsx` is this rule's `flex-basis` read back in px"
    },
    {
      "family": "portal-split",
      "owner": "packages/plugin/src/ui/styles.css",
      "why": "tile-tree skin (`PORTAL_TREE_CLASSES`)"
    },
    {
      "family": "portal__slot",
      "owner": "packages/plugin/src/ui/styles.css",
      "why": "tile-tree skin (`PORTAL_TREE_CLASSES`) — the portal's pane"
    },
    {
      "family": "portal-divider",
      "owner": "packages/plugin/src/ui/styles.css",
      "why": "tile-tree skin (`PORTAL_TREE_CLASSES`); `dividerPx: 11.2` in `tile-tree.tsx` is this rule's `flex-basis` read back in px"
    },
    {
      "family": "workspace-split",
      "owner": "packages/plugin/src/ui/styles.css",
      "why": "tile-tree skin (`WORKSPACE_TREE_CLASSES`)"
    },
    {
      "family": "workspace-pane",
      "owner": "packages/plugin/src/ui/styles.css",
      "why": "tile-tree skin (`WORKSPACE_TREE_CLASSES`)"
    },
    {
      "family": "workspace-divider",
      "owner": "packages/plugin/src/ui/styles.css",
      "why": "tile-tree skin (`WORKSPACE_TREE_CLASSES`); `dividerPx: 5.6` in `tile-tree.tsx` is this rule's `flex-basis` read back in px"
    },
    {
      "family": "terminal",
      "owner": "packages/plugins/terminals/src/styles.css",
      "why": "the terminal frame, its titlebar, the idle veil, the focus-presence chips, the exited and restart states, and the pool's rows"
    },
    {
      "family": "xterm",
      "owner": "packages/plugins/terminals/src/styles.css",
      "why": "the xterm host and the two vendor classes it has to reach — the only stylesheet that embeds a terminal"
    },
    {
      "family": "view-only-ribbon",
      "owner": "packages/plugins/terminals/src/styles.css",
      "why": "the ribbon a spectator's terminal wears"
    },
    {
      "family": "canvas",
      "owner": "packages/plugins/canvas/src/styles.css",
      "why": "the freeform discipline's renderer: the canvas, its toolbar, its presence layer and its skeletonless empty"
    },
    {
      "family": "portal",
      "owner": "packages/plugins/canvas/src/styles.css",
      "why": "a container portal on a canvas, in every engagement state, plus its resize chrome"
    },
    {
      "family": "stroke-preview",
      "owner": "packages/plugins/canvas/src/styles.css",
      "why": "the ink preview the canvas toolbar shows"
    },
    {
      "family": "react-flow",
      "owner": "packages/plugins/canvas/src/styles.css",
      "why": "React Flow's own classes, dressed where the canvas mounts React Flow. A vendor prefix still needs an owner: exactly one stylesheet may reach into a vendor's vocabulary, or two of ours will fight over it"
    },
    {
      "family": "composition",
      "owner": "packages/plugins/compositions/src/styles.css",
      "why": "the tiled discipline's renderer: its page chrome, tiles, leaves and grips, its placeholder, its empty state and its presence layer"
    },
    {
      "family": "presence",
      "owner": "packages/plugins/presence/src/styles.css",
      "why": "the attendance stack, its popover and rows, and the peer dot"
    },
    {
      "family": "spotlight",
      "owner": "packages/plugins/presence/src/styles.css",
      "why": "the chip a peer's 'look at this' arrives as"
    },
    {
      "family": "remote",
      "owner": "packages/plugins/presence/src/styles.css",
      "why": "a peer's cursor and selection"
    },
    {
      "family": "you-chip",
      "owner": "packages/plugins/presence/src/styles.css",
      "why": "the chip marking your own row in the roster popover"
    },
    {
      "family": "agent-chip",
      "owner": "packages/plugins/presence/src/styles.css",
      "why": "the chip marking an agent principal in the roster popover"
    },
    {
      "family": "index",
      "owner": "packages/plugins/index/src/styles.css",
      "why": "the sidebar tree's own rows, its drag line, its section bar and its skeleton"
    },
    {
      "family": "plugin-manager",
      "owner": "packages/plugins/plugin-manager/src/styles.css",
      "why": "one row per assembled plugin, its toggle, and the lock an essential plugin wears"
    },
    {
      "family": "draw",
      "owner": "packages/plugins/draw/src/styles.css",
      "why": "freehand ink and its hit stroke"
    },
    {
      "family": "react-flow__node-draw",
      "owner": "packages/plugins/draw/src/styles.css",
      "why": "the React Flow node type the ink is drawn into — a longer prefix than `react-flow`, which is how the draw plugin keeps its own node without taking the canvas's vendor dressing"
    },
    {
      "family": "machine",
      "owner": "packages/plugins/machines/src/styles.css",
      "why": "a machine's liveness pip, the menu row shown when no machine can host a terminal, the two-press control that withdraws a machine's credential (ADR 0019 \u00a73) and the refusal the section renders in place"
    },
    {
      "family": "canvas-text",
      "owner": "packages/plugins/notes/src/styles.css",
      "why": "the note element and its in-place editor. The prefix says where a note is painted; the owner is the plugin whose element it is, so disabling notes takes this with it"
    },
    {
      "family": "arrange",
      "owner": "packages/plugins/arrange/src/styles.css",
      "why": "core.arrange's own chrome: the floating F8 toolbar, its drag handle, the PALETTE of carry sources it leads with and the buttons of the operations that survive beside it (issue #104), the panel grip overlay and its scope-in pill, the handle a placed split is picked up by and the frame that paints its selection, the palette's own carried state (\"Drop to cancel\" / \"Drop to remove\", issue #148), the live move preview slot, the mode bar and its scope crumbs, and the wireframe delimitation painted over stack/split containers while armed. `arrange-palette*` needs no row of its own: the longest-prefix rule already resolves it to this family, and this stylesheet is its owner. Extracted from the `workspace` family (issue #89) when the grips and the mode bar left `workspace.tsx` for the plugin that now owns arrange mode's affordances"
    },
    {
      "family": "is",
      "owner": "shared",
      "why": "the state-modifier prefix. `is-*` is never a family and never a definition: it only ever qualifies the class it is written beside, so it belongs to no stylesheet and is legal in all of them"
    }
  ]
}
```

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
      "prefix": true,
      "why": "this device's principal grant (id, name, color, token) — the credential itself, which is why it never leaves the device. PREFIXED because a grant belongs to ONE instance: a lens pointed elsewhere (`manifold:instance`) keys its grant `manifold.identity@<origin>` so pointing at a second instance can never read or overwrite the first's token. The served instance keeps the bare key, which is the spelling every reader and every browser gate already knows"
    },
    {
      "key": "manifold.ownerKey",
      "prefix": true,
      "why": "owner key captured from the #key= boot fragment; a secret, never sent anywhere but the Authorization header. Prefixed for the same reason as the grant beside it: an owner key authenticates as root at exactly one origin, so a lens looking at another instance stores it under `manifold.ownerKey@<origin>`"
    },
    {
      "key": "manifold:instance",
      "why": "WHICH INSTANCE this device's lens looks at, when that is not the origin that served it (`packages/plugin/src/instance.ts`, set by `?instance=<url>` and cleared by `?instance=`). Absent in the ordinary case, where the lens looks at its birthplace. Genuinely device-local and nothing else could be: it is a fact about this browser's choice of viewpoint, no part of any workspace, and publishing it would move somebody else's window to another server. AXIOMS §The portable lens is the rule it implements"
    },
    {
      "key": "manifold:debug",
      "why": "opt-in for the read-only debug probes `window.__manifold` (the mounted container renderer's) and `window.__manifoldFeeds` (the shared feeds', which is floor and therefore present on any page); a browser-automation switch, not workspace state"
    },
    {
      "key": "manifold:viewport:",
      "prefix": true,
      "why": "per-container camera (scroll + zoom) memory: where THIS screen was looking, meaningless to another device with another window size"
    },
    {
      "key": "manifold:machine:",
      "prefix": true,
      "why": "per-container machine choice memory for the next terminal opened from this device"
    },
    {
      "key": "manifold.last-container.",
      "prefix": true,
      "why": "per-principal last container used on this device, so the root route reopens where this browser left off"
    },
    {
      "key": "manifold:show-container-terminals",
      "why": "whether the Index section expands terminal rows on this device — presentation of an index whose content is durable server state"
    },
    {
      "key": "manifold:expanded-index-folders",
      "why": "folder expansion in the Index tree on this device; folder membership and order are durable server state, expansion is not"
    },
    {
      "key": "manifold:ignore-spotlight",
      "why": "kill switch for incoming core.presence.focus spotlights — consent lives with the person being driven, on the device being driven"
    },
    {
      "key": "manifold:sidebar-collapsed-mirror",
      "why": "device mirror of presence vantage.sidebarCollapsed so the first paint matches the last session before the socket opens; presence remains the authority"
    },
    {
      "key": "manifold:arrange-toolbar-position",
      "why": "where THIS device parked core.arrange's floating toolbar (an {dx,dy} offset from its bottom-centre default). A toolbar's parking spot is about this screen's size and this hand's reach — it names nothing in the workspace, and publishing it would move a collaborator's toolbar out from under them. Optional by construction: a write that throws leaves the toolbar at its default, which is why the drag never surfaces a storage failure"
    }
  ]
}
```

## Gate contracts

A gate script drives the product through the same DOM a person uses, so every string it hands
`document.querySelector` is a JOIN: the script names it, a renderer paints it, and nothing
between them is compiled. Two of those strings were load-bearing and undeclared. One was plain
button copy — `clickText("Enter manifold")` against `packages/web/src/identity.tsx`, whose
label changes to "Creating identity…" the moment it is pressed. The other was a `data-testid`
templated from a plugin MANIFEST id (`${section.id}-section`), so renaming a section id in
`packages/plugins/machines/src/index.ts` broke three gates with no compiler signal and no
failing unit test — only a browser assertion that stopped finding its element.

So a gate keys off a `data-testid` and never off copy, and every test-id a gate depends on is
declared here with the renderer that owns it. `verify:axioms` S15 reads this register in both
directions: every `[data-testid=…]` literal and every `clickTestId(…)` argument in `scripts/`
must have a row AND a live `data-testid=` attribute in the row's renderer, and every row must
be queried by some script — an unqueried row is stale and fails, exactly as a stale floor glob
fails S6.

This register holds the contracts, NOT the inventory. A `data-testid` no gate queries is
ordinary markup and belongs nowhere near this list: `plugin-manager`, `sidebar-list` and
`machines-rail` are live attributes with no row, and adding rows for them would be adding rows
nothing keeps honest. A row appears when a gate starts depending on the string, in the same
commit as the gate.

Templated attributes resolve by SHAPE, which is what keeps the register small while the
vocabulary stays open: `data-testid={`toolbar-${item.id}`}` answers for every tool a plugin
contributes, so `toolbar-draw` and `toolbar-select` are two rows against one attribute rather
than one row per plugin. The row still names the file, because "which renderer owes me this
string" is the question a broken gate actually asks.

```json
{
  "gateContracts": [
    {
      "testid": "identity-enter",
      "renderer": "packages/web/src/identity.tsx",
      "why": "every gate crosses the identity gate first; the submit button's COPY changes while submitting, so the contract cannot be its label"
    },
    {
      "testid": "connection-state",
      "renderer": "packages/plugins/shell/src/status-row.tsx",
      "why": "the word a gate reads to know the session is open; the one status a browser gate waits on before asserting anything else. It moved out of the sidebar panel with the rest of the rail's chrome (2026-09-01): the status line is a CONTRIBUTED plain row (`core.shell.status`) now, so the renderer that owes this attribute is the row, not the panel that stacks it"
    },
    {
      "testid": "lens-offline",
      "renderer": "packages/web/src/lens.tsx",
      "why": "the named disconnected condition the PWA gate reads with the network cut: the whole content of \"offline shell\" is that this word is on screen instead of a blank page, so the gate may not key off the copy around it. One shape (`lens-<condition>`) answers for every row of the banner"
    },
    {
      "testid": "lens-update",
      "renderer": "packages/web/src/lens.tsx",
      "why": "the offer a live page shows when a newer build is installed and waiting. The PWA gate simulates a deploy and reads this row to prove the running page is not swapped underneath itself, then presses it to prove the handover completes and the old generation is swept"
    },
    {
      "testid": "lens-instance",
      "renderer": "packages/web/src/lens.tsx",
      "why": "the row that says this device is pointed at another instance, and carries the way home. The PWA gate reads it to prove a lens served by one instance is looking at another (AXIOMS §The portable lens)"
    },
    {
      "testid": "lens-skew",
      "renderer": "packages/web/src/lens.tsx",
      "why": "the protocol-skew REFUSAL card. The gate asserts it appears in both drift directions and that the workspace behind it does not paint — invariant 10's failure mode is precisely a client that looks ordinary while it cannot speak to its server"
    },
    {
      "testid": "lens-skew-action",
      "renderer": "packages/web/src/lens.tsx",
      "why": "the refusal's one way out, whose LABEL and behaviour differ by drift direction (reload when this app is behind, re-check when the instance is), which is exactly why the gate cannot key off the copy"
    },
    {
      "testid": "sidebar-list",
      "renderer": "packages/plugins/index/src/web.tsx",
      "why": "the index tree's root; R9 waits for its seeded adversarial rows to land before sweeping sidebar widths, and R10 reads it to prove an EVENT repainted the tree — the one assertion in the gate that a poll could have faked, which is why the feed's own timer count is asserted beside it"
    },
    {
      "testid": "connection-status",
      "renderer": "packages/plugins/shell/src/status-row.tsx",
      "why": "the status block that carries the state, scoped so a gate can assert the sidebar's copy of it rather than any occurrence. Same move as the row above: the block is the `core.shell.status` row's own"
    },
    {
      "testid": "machines-section",
      "renderer": "packages/plugins/shell/src/sidebar-panel.tsx",
      "why": "templated `${section.id}-section`, so this row is the join between a PLUGIN MANIFEST section id (core.machines) and three gates that open that section — the rename this register exists to make loud"
    },
    {
      "testid": "toolbar-draw",
      "renderer": "packages/plugins/canvas/src/canvas-toolbar.tsx",
      "why": "templated `toolbar-${item.id}`; the tool a gate picks to prove a contributed tool paints, disappears on disable, and returns on enable (R3)"
    },
    {
      "testid": "toolbar-select",
      "renderer": "packages/plugins/canvas/src/canvas-toolbar.tsx",
      "why": "templated `toolbar-${item.id}`; the tool a gate returns to, so a stroke gate can prove the toolbar restores the default rather than staying armed"
    },
    {
      "testid": "plugin-manager",
      "renderer": "packages/plugins/plugin-manager/src/web.tsx",
      "why": "R3's enablement rung scopes its toggle selector to the plugin-manager listing root, so a row is picked out by plugin id inside the list that owns it. Since 2026-09-01 that list lives inside the manager's MODAL (issue #91), which is why the two rows below exist"
    },
    {
      "testid": "plugin-manager-toggle",
      "renderer": "packages/plugins/plugin-manager/src/web.tsx",
      "why": "R3 presses the REAL enablement affordance instead of dispatching the door twice; row identity comes from the sibling data-plugin attribute, never from button copy"
    },
    {
      "testid": "plugin-manager-open",
      "renderer": "packages/plugins/plugin-manager/src/web.tsx",
      "why": "the rail row is only the OPENER now, so R3 and R9 press it before reading any plugin row (`openPluginManager`). A gate keyed off the row's copy would break the moment the collapsed rail hides the label"
    },
    {
      "testid": "plugin-manager-modal",
      "renderer": "packages/plugins/plugin-manager/src/web.tsx",
      "why": "the modal's card, and the handle the gate reads OPENNESS through: a closed <dialog> keeps its subtree in the DOM, so 'the listing exists' is not 'a reader can see it'. R9 also closes the modal through it, by the backdrop press a reader would use"
    },
    {
      "testid": "palette-stack-row",
      "renderer": "packages/plugins/arrange/src/arrange-overlay.tsx",
      "why": "a palette DRAG SOURCE, not a button, and the one R4 drags TWICE because it is the only id that reaches two of the three destinations a palette carry has: dropped on a workspace pane's edge it seats a split holding two vacant seats, which is the only way to reach the claim that an empty seat takes no room until the mode is armed; dropped between two rail rows while scoped into the sidebar it authors that panel's own nested arrangement, which is the operator's headline for the rework. It replaced `toolbar-stack-row` in issue #104, and it is a different contract for the same reason it is a different id — a gate that CLICKS this element proves nothing about it"
    },
    {
      "testid": "palette-stack-column",
      "renderer": "packages/plugins/arrange/src/arrange-overlay.tsx",
      "why": "the other direction's drag source, and the row that keeps the pair honest: two palette items must differ only in the `dir` their carry seals, so a register naming one and not the other would let the second rot. Templated `palette-${tool.id}`, and dragged rather than pressed"
    },
    {
      "testid": "palette-spacer",
      "renderer": "packages/plugins/arrange/src/arrange-overlay.tsx",
      "why": "the drag source R4 uses to make the commit-once claim at RELEASE: one gesture out of the palette, one `{kind:'spacer'}` leaf in the reader's tree, one core.space.setLayout. The claim moved off the retired `toolbar-spacer` button with the tool itself (issue #104) and did not get weaker in the move"
    },
    {
      "testid": "toolbar-equalize",
      "renderer": "packages/plugins/arrange/src/arrange-overlay.tsx",
      "why": "templated `toolbar-${tool.id}`, on the OTHER toolbar: `core.arrange`'s floating bar renders the same shape the canvas bar does, so the same attribute answers for a second contributor's tools. R4 presses it after a divider drag has skewed the root ratios, which is what makes 'normalizes to one even share' an observable change rather than a no-op"
    },
    {
      "testid": "toolbar-shelf",
      "renderer": "packages/plugins/arrange/src/arrange-overlay.tsx",
      "why": "templated `toolbar-${tool.id}`; unseats the one selected panel, which is the only way a row appears on the shelf below — R4 presses it and then re-seats through the row it produced. It is also the last tool with a SELECTION precondition, so R4 taps grips before pressing it, which is how the tap-versus-drag threshold gets exercised by a real pointer instead of asserted in prose (the claim outlived the retired `toolbar-swap`, issue #104)"
    },
    {
      "testid": "toolbar-reset",
      "renderer": "packages/plugins/arrange/src/arrange-overlay.tsx",
      "why": "templated `toolbar-${tool.id}`; the least state-dependent tool, which is why R4 also uses its mere PRESENCE as the proof that F8 painted a toolbar and that leaving the mode took it away again"
    },
    {
      "testid": "arrange-shelf-item",
      "renderer": "packages/plugins/arrange/src/arrange-overlay.tsx",
      "why": "the shelved panel's own row, and the second half of Shelf: R4 presses it to put the panel back, so 'nothing vanishes' is proved by re-seating rather than by reading the tree the tool left behind"
    },
    {
      "testid": "arrange-palette",
      "renderer": "packages/plugins/arrange/src/arrange-overlay.tsx",
      "why": "the palette as a DROP TARGET (issue #148): where structure comes from and where it goes back to. R4 drops a fresh Stack row back on it and reads the tree byte-identical, releases a placed spacer's grip and a rail stack's grip on it and reads them gone — and reads `data-carry` off it mid-gesture, which is the only way to prove the palette SAYS which of the two it is about to do rather than doing one silently"
    },
    {
      "testid": "toolbar-remove",
      "renderer": "packages/plugins/arrange/src/arrange-overlay.tsx",
      "why": "templated `toolbar-${tool.id}`; the third door onto `removedStructure` (issue #148), and the one tool whose precondition a reader can SEE: R4 reads it disabled with a panel selected and enabled with a structure selected, so 'Remove never means Shelf' is a painted fact rather than a refusal somebody has to trigger"
    }
  ]
}
```

## Budgets

What an IDLE workspace is allowed to cost. Every other register in this file names a
vocabulary; this one names a price, because the failure it exists to catch is not a boundary
crossed but a bill nobody was shown. Wave F shipped a canvas whose route context was rebuilt
every render — the effect that publishes workspace state back to the shell re-ran on every
one of them, re-rendered the shell, and rebuilt the context again — so an open canvas spent
~600 React commits and 24 seconds of script time per 30 seconds of doing nothing, while the
shell and the index section each opened their own timers onto the same three doors. Both were
invisible to a fully green gate, and the operator found them instead.

`bun run verify:budgets` boots a real server, a real agent and a real browser, opens a canvas
holding a live terminal, six notes and six strokes, settles, and then watches for sixty
seconds. RED names the resource and the measured rate.

**Wave 2 collapsed the `network` rows to zero, and they are still rows.** The five feeds traded
their timers for subscriptions on the session channel (ADR 0012), so a steady workspace asks
nothing at all — but the ceilings stay in the table rather than leaving it, because a resource
with no row is a resource that escaped the budget, and a subscription that regresses to a timer
has to land on a number somebody wrote down. The cadence itself is not gone: it is the documented
fallback for exactly two states, a socket that is down and a feed with no topics at all (the
roomless workspace root), and it never runs beside a live subscription. Neither state is what this
table measures, which is why zero is the honest ceiling and not an aspiration.

The settle window is where the honest exception lives. A subscription-backed feed still takes ONE
initial read — catch-up is reading state, never draining a backlog — plus one more if the socket
reached `open` after the mount read, which closes the mount-to-subscribe gap. Both land inside
the settle, and both are counted by the feed as `initial`/`resume` rather than `timer`/`event`.
What the table governs is the steady state AFTER that, where the answer is zero.

Four rules give it teeth:

- **An undeclared door polled at idle is RED on sight.** A budget you can escape by not being in
  it is not a budget.
- **A backgrounded tab has a ceiling of ZERO**, and always did. It used to say "polling is an
  interim only for as long as it stops when the operator looks away"; it now says the weaker and
  more durable thing, that a tab nobody is looking at asks nothing.
- **A zero must be a subscription and not a corpse.** A feed that died reads zero exactly like a
  feed that subscribed, so before the window the gate reads the feed's own report seam
  (`window.__manifoldFeeds()`, `packages/plugin/src/polled-resource.ts`) and requires every row's
  `feed` to be LIVE, in `events` mode, holding a non-empty topic list, with no armed timer and at
  least one initial read behind it. That is the check the collapse to zero rests on.
- **`reads.timer` is the claim.** Zero requests could also be a timer that fired and was answered
  from a cache; the feed counts its reads by REASON, so "no timer ran" is asserted rather than
  inferred from a rate. A timer beside a live subscription is RED even at a rate the table would
  otherwise admit.

`feed` is the join between this table and the feed vocabulary those five names live in, and it is
checked in both directions like every other runtime join here: a row whose feed is absent from
the page is RED, and a live feed with no row is the undeclared-resource rule.

`scriptMsPer30s` was declared with the rest of this table and measured by nothing until wave 2;
it is now read from the browser's own `ScriptDuration` accounting as a difference across the
window (measured post-swap: ~105ms per 30s against a ceiling of 1,500). A declared ceiling nobody
asserts is the same defect as an undeclared door, one register further in.

```json
{
  "budgets": {
    "totalRequestsPerMin": 0,
    "network": [
      {
        "resource": "core.index.read",
        "feed": "core.index.read",
        "perMin": 0,
        "why": "the container index. ZERO: one subscription per node that MOVES it — manifold://plugin/core.index for its own doors, core.space because a placement births and absorbs containers, core.terminals because a terminal is born with a home composition and takes it away when killed — and a re-read only when an event says the collection moved. One feed still: the shell needs it to name portal targets and the index section needs it to draw rows, so the collapse is one subscription set for both, not two"
      },
      {
        "resource": "core.terminals.listAll",
        "feed": "core.terminals.listAll",
        "perMin": 0,
        "why": "the terminal index. ZERO: one subscription to manifold://plugin/core.terminals, which is where terminal lifecycle is addressed because a terminal born or killed has no node that outlives the event, plus manifold://plugin/core.space because `unplaced` is DERIVED from the containment graph and a placement is what moves it. The placement algebra is answered from the snapshot between events"
      },
      {
        "resource": "core.terminals.listByContainer",
        "feed": "core.terminals.listByContainer",
        "perMin": 0,
        "why": "terminals grouped by home. ZERO, on the same two collection topics as the row above: rehoming is `terminal_bound` and unplacing is a placement commit, and the grouping is recomputed from a read the event earns rather than from a clock"
      },
      {
        "resource": "/api/attendance",
        "feed": "attendance",
        "perMin": 0,
        "why": "cross-container presence. ZERO: one subscription to manifold://plugin/core.presence, whose `principal_joined` / `principal_left` fire on the FIRST and LAST connection per principal, so a second tab is not an attendance change. It once ran at two cadences under two callers — 1.5s in the shell, 2s in the section — which is two answers to one question; now there is one subscription and no answer until something happens"
      },
      {
        "resource": "core.machines.list",
        "feed": "core.machines.list",
        "perMin": 0,
        "why": "the machine roster. ZERO: one subscription to manifold://plugin/core.machines. It was the slowest timer of the five on the grounds that a machine coming online is not a thing an operator waits on; with `machine_online` gated on a genuine transition, the operator no longer waits at all"
      }
    ],
    "idleCanvas": {
      "commitsPerSec": 2,
      "scriptMsPer30s": 1500,
      "longTasks": 2,
      "longTaskMaxMs": 120,
      "socketFramesPerMin": 120,
      "why": "an open canvas with a live terminal, at rest. The ceilings are near-zero on purpose: content-compared shared feeds mean an unchanged answer reaches no subscriber, so a STEADY workspace should re-render nobody at all (measured: 0 commits, 195ms of script and 0 socket frames per 30s). The socket-frame ceiling is headroom for LIVENESS and nothing else — the server pings on DIAL_PING_INTERVAL_MS (30s) and the tab answers, which is 4 frames a minute; an `event` frame at idle means something is emitting without a commit point behind it, which is the wave-2 shape of the same defect the re-render ceiling catches. Anything that puts a number here has found a new heartbeat"
    },
    "instanceChannel": {
      "framesPerMinPerDial": 4,
      "requestsPerMin": 0,
      "why": "ONE dialled instance, at rest. A dial is not idle chatter and the number says exactly how much it is: the host pings on DIAL_PING_INTERVAL_MS (30s) and the guest answers, which is two frames per interval, so two intervals a minute is 4 frames per dial per minute and NOTHING else — no catalogue poll, no share refresh, no keepalive of its own. `requestsPerMin` is 0 because the control link asks the host no HTTP questions at all: a share's vocabulary arrives on the welcome and is cached in the dial row, so a guest drawing an index row while the socket is down reads its own database. The ceiling is per DIAL rather than per instance because dials are the thing an operator adds, and a budget that did not scale with the countable thing would stop being a budget the first time somebody accepted a second share. This row is DECLARED rather than measured by `verify:budgets`, which boots one server and one browser and therefore cannot see a second instance; declaring it anyway is the undeclared-resource rule applying to its own author — a resource with no row is a resource that escaped the budget, and the honest thing when the stopwatch cannot reach is to write the number down where the next person can check it against the code"
    }
  }
}
```

## Runtime-joined namespaces

The law is `AXIOMS.md` §Foundation law, "Every runtime-joined namespace has a registry". These
are its instances, each written after the join it guards had already broken once:

| Runtime-joined namespace                             | Registry                    | Check            |
| ---------------------------------------------------- | --------------------------- | ---------------- |
| device-local storage keys                            | the `deviceLocal` register  | S3               |
| `data-action` markers ↔ published actions            | the live assembly           | S4               |
| `/api/…` route literals ↔ the doors that exist       | the script's allowlist      | S7               |
| every word for a concept, across every plane         | §Lexicon rows               | S11              |
| item kind → display noun                             | `ITEM_NOUNS`, the ONE table | S12              |
| CSS selector families ↔ their owning package         | §Lexicon `cssFamilies`      | S13              |
| `evt=` log names ↔ the gates that match them         | `LOG_EVENTS`                | S14              |
| `data-testid` attributes ↔ the gates that click them | §Gate-contracts rows        | S15              |
| §Budgets rows ↔ the browser's feed vocabulary        | each row's `feed` field     | `verify:budgets` |

## Gates

`bun run verify:axioms` (in `bun run gate`) is the axioms made falsifiable. Its static half runs
against the source tree, its browser half against a real server and a real browser.

The **T rows belong to `bun run verify:trace`** (also in `bun run gate`), which is axiom A6's
completeness check and is a sibling script rather than a section of the one above for a reason
that is about cost rather than taste: it needs a real composed SERVER and no browser at all, so
it rides the gate's static pool and finishes in seconds. Its static half is the TypeScript
parser over the dispatch ladder; its live half dispatches every registered door.

| Check | What it asserts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1    | Both `assembly.ts` files assemble without an `AssemblyError`, and every panel id in the default workspace tree — `composeDefaultLayout(roster)`, composed from the enabled roster's declared `contributes.seats` rather than from a constant — exists in the assembly, and the composition is `validateTileLayout`-clean. Discipline values equal their owning plugin's last id segment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| S2    | Import boundary, walked with the TypeScript parser over this file's `floor` globs: floor files import no `@manifold-plugin/*` (the two `assembly.ts` files excepted); plugin packages import only protocol/scene/sdk/plugin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| S3    | Every `localStorage` key literal in `packages/web` and `packages/plugins` appears in the `deviceLocal` register.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| S4    | Every `data-action` literal in the source names an action the assembly actually publishes (soundness; coverage ratchets up as later waves convert the remaining affordances).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| S5    | Every `packages/plugins/*` directory is registered per the halves it exports, and every assembled definition maps back to a package — **builtin rows excepted**: an engine door (`source: "builtin"`) has no package by design, and the script assembles it explicitly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| S6    | Registry liveness: every `floor` glob matches at least one file, so a stale row fails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| S7    | Route allowlist: the `/api/…` literals in the server's HTTP dispatcher equal the script's allowlist, so a bespoke feature route that bypasses the action door fails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| S8    | **Element vocabulary, read from the OWNERS' end.** `SceneElementSchema` is a neutral ENVELOPE and enumerates nothing (ADR 0013 §16), so there are no schema members to walk: what the check walks is the set of types some party CLAIMS — `FLOOR_ELEMENT_PAYLOADS` ∪ the assembly's contributed element types — and asserts every claim is claimed ONCE, so no type is owned by both the floor and a plugin. The envelope's own promise is asserted beside it: a STRANGER type nothing claims still round-trips, validating on the envelope's bounds alone, because a canvas holding a record whose plugin is absent from this build must keep it rather than have the wire refuse a `type` it was never told about.                                                                                                                                                                                                                                |
| S9    | **Pillar exhaustiveness**: every floor FILE — stylesheets included, tests excluded — falls inside exactly one pillar's globs, where the most specific glob owns the file (longest literal prefix wins) and two pillars claiming one file at equal specificity is itself RED. An unmatched floor file is RED and is named. A pillar glob claiming no floor file is RED too, `gate-and-registries` excepted: it owns the constitution and the gate scripts, which §Foundation puts outside floor and plugin territory alike. There is no exception list — §Foundation law admits no third state, so a file leaves the unmatched set by moving into its plugin or by a pillar stating the litmus finding that owns it.                                                                                                                                                                                                                                 |
| S10   | **The residual carve-out, published**: the script prints every `cleanup: true` action in the assembly, so growth of the action plane's one disable exemption is a line in a gate diff rather than a later discovery (ADR 0013 §9). Two assertions give the list teeth: a cleanup door's verb is REMOVAL, against the script's closed verb list — which mechanizes the ruling `core.terminals` makes by hand in a comment, that claiming a lease is administration and therefore not `cleanup` — and a cleanup door belongs to a PLUGIN, because an engine door publishes `source: "builtin"`, has no toggle, and cannot carry a residual from a disable it can never suffer.                                                                                                                                                                                                                                                                        |
| S11   | **Lexicon**: no word in any §Lexicon row's `banned` list appears in an identifier, a classified wire literal, a CSS selector, a file or directory name, or a Markdown heading, outside a declared `allow` row — and every `allow` row suppresses at least one real occurrence, every `term` occurs at least once, and no `term` sits in another row's `banned` list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| S12   | **One label vocabulary**: exactly ONE table in the tree translates an item kind into a display noun, its keys are `ITEM_KINDS` ∪ the assembly's element types, and every value's canonical word is that key's registry term. A second such table fails (invariant 14 applied to vocabulary).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| S13   | **CSS ownership**: every selector family in every stylesheet under `packages/` resolves to a §Lexicon `cssFamilies` row, and every rule is defined by the owner of the leftmost family it scopes into. A family painted from another package's sheet, a family with no row, a row whose stylesheet defines nothing, or a classless rule outside the floor sheet — each is RED, named by file and selector.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| S14   | **Log-event vocabulary**: every `evt` a producer passes to `Logger.info/warn/error` in `packages/server/src` or to the agent's log sink, and every `"evt":"…"` literal a `packages/testkit` e2e or a `scripts/` gate matches inside raw stdout, is a member of `LOG_EVENTS` — and every member has a live producer, so a name nobody emits is a stale row. The producer half is also a compile error (`LogEvent`); the CONSUMER half is why the check exists, because no type reaches inside a string literal.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| S15   | **Gate contracts**: every `[data-testid=…]` literal and every `clickTestId(…)` argument in `scripts/` resolves to a §Gate-contracts row AND to a live `data-testid=` attribute in that row's renderer (templated attributes match by shape), and every row is queried by some script. A gate keyed off button copy, or off a test-id nobody declared, fails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| S16   | **The floor's budget**: `packages/plugin/src` (source only, tests excluded) stays inside a declared line ceiling — a printed WARN at 9,000 and RED above 12,000. Every other static check asks whether a boundary is clean; this one asks how big the engine got, which is the failure mode the litmus test cannot see because it governs each addition and never the aggregate. `packages/plugin/src` is where growth lands first: every plugin imports it, so a helper put there is reachable by everything without justifying itself to a second party. Raising a threshold is a diff somebody defends.                                                                                                                                                                                                                                                                                                                                          |
| S17   | **Hosting neutrality**: no file a self-hoster ships or runs — `Dockerfile`, `compose.yaml`, `flake.nix`, `infra/**`, `packages/**`, `scripts/**`, `.github/workflows/**` — names a hosting provider or carries its env prefix; the one exemption is the operator's own deployment workflow, `.github/workflows/deploy-hub.yml`, which is gated on a repository variable so a fork never runs it (ADR 0022). A hit is reworded, never allow-listed: the exemption list is that one path.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| R1    | Vocabulary: `GET /api/protocol` actions ≡ the assembly; `GET /api/plugins` ≡ the roster; input/result schemas are present.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| R2    | Parity both directions: an SDK `core.terminals.rename` updates the browser DOM with no reload, and the browser's rename affordance is observed by the SDK as a `terminal_event`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| R3    | Hot enable/disable with no reload: `core.draw` off removes the tool and placeholders existing strokes; `core.machines` off makes its section VANISH from the sidebar while the manager row stays the ledger, and re-enable restores its manifest-ordered place (D4′ — chrome renders absence; data ghosts); `core.terminals` off refuses `terminal_open` while an existing terminal still accepts `kill` (D12); disabling `core.shell` is `refused`/`essential`, and so is each of the three seats the floor itself dispatches — `core.space`, `core.index`, `core.access` — whose `essential` flag the live roster must also carry, while an ordinary coupling (`core.machines`, named by the floor's `FEED_TOPICS`) goes off and comes back with the rail and the canvas still painting (issue #113).                                                                                                                                             |
| R4    | Shell as composition: `GET /api/layout` has panel leaves; a real divider drag changes the stored ratios and dispatches exactly ONE `core.space.setLayout`; another principal's layout is untouched; arming the mode moves nothing, because every affordance it adds is out of flow. Inside a scoped panel every grabbable row is GLYPHLESS (the tint is the whole affordance), a real pointer drag across three rows passes through exactly one order per boundary it crosses and never returns to an order it left, three slow passes over one boundary make six reorders and end where they began, and a glyphless row still carries its label and answers the arrow keys.                                                                                                                                                                                                                                                                        |
| R5    | Presence and spotlight: a picked tool is visible to an SDK peer as `vantage.tool` within 2s; `core.presence.focus` centers the target's viewport through the debug probe; a container-scoped token invoking it is `forbidden`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R6    | Addressing: `GET /api/resolve` round-trips a terminal and a container, and the `/uri/<encoded>` deep link navigates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| R7    | Every `[data-action]` in the live DOM names an action in the roster.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| R8    | The denial ladder end to end, including a container-scoped token on `engine.plugins.setEnabled` → `forbidden` (a door's audience is DECLARED: `scope: "workspace"` refuses scoped callers, `scope: "container"` admits them and obliges the handler to confine the answer — ADR 0013 §15).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| R9    | Layout resilience: under adversarial content (unbroken 60+ character names, eight containers, a three-deep folder chain, a long terminal name) and a bounded sweep of sidebar widths (≥6), the sidebar, the plugin manager and a canvas terminal node's chrome hold four invariant classes — no VISIBLE horizontal overflow where overflow is `visible`, no visible content cut by `overflow: hidden` without a declared ellipsis, no visible descendant escaping the audited root's box, no two statically-flowing siblings painting over each other. Grounded in what an observer sees: effective opacity 0 paints nothing, and a negative-margin stack is a declared overlap.                                                                                                                                                                                                                                                                    |
| R10   | **The plane is live** (ADR 0012). Three real connections: a browser whose feeds hold subscriptions, an SDK peer subscribed to the same collection node, and a THIRD principal mutating through the action door — so `actor` names somebody neither observer could mistake for itself. The frame must arrive with the right topic, kind and actor; the browser's sidebar must reflect the change inside ONE SECOND measured from the dispatch, not from the frame; and the feed's own report must show `reads.event` moving while `reads.timer` stands still, because no DOM assertion can tell a subscription from a poll that happened to be fast. The negative rung is the admission half: a container-scoped token subscribing to a foreign collection is refused SILENTLY — no frame, no socket close — and the refusal is read in the structured log, since "received nothing" would also be true of a subscription that merely never matched. |
| T1    | **One ledger writer** (A6, ADR 0018; `verify:trace`). `appendTrace`/`settleTrace` are called from the store that defines them and the dispatch ladder that uses them, and from nowhere else — walked with the TypeScript parser, because a trace written from a third place is an attribution no dispatch stands behind.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| T2    | **Every rung, by construction.** Every `{ ok: false }` denial literal inside `PluginHost.run` writes the ledger in its OWN statement block; exactly one may not, and its rule must be `unknown_action` — the exemption ADR 0018 §4 rules out by argument. This is the half that survives nobody remembering to dispatch a new rung. Beside it, the vocabulary join: every denial rung except that one is a member of `TRACE_OUTCOMES`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| T3    | **Every registered door traces, live.** Against the REAL composed server (its own process, its own data dir, ephemeral port), every action in `GET /api/plugins` is dispatched and the ledger must hold a row naming it; a door without a trace is RED. The sentinel argument refuses at the argument rung — every input is a `z.strictObject` — so every door is knocked on and nothing is created or destroyed. It also asserts the WRITE-AHEAD in production: the only unsettled row is the reading door's own in-flight dispatch, which is the attribution being durable before its handler runs.                                                                                                                                                                                                                                                                                                                                               |
| T4    | **A commit and a refusal are attributed.** A real `core.index.createContainer` leaves an `ok` row carrying actor, authority and the `manifold://` targets the door named; an attenuated token on the same door leaves a `forbidden` row naming the authority that failed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| T5    | **The one exemption, both halves.** An unregistered name leaves NO ledger row — the `door` column is never caller-chosen — and is still observable as one `action` log line at `outcome: "unknown_action"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Per-axiom round table — which checks would fail first if an axiom stopped holding:

| Axiom / rule                                  | Checks                                                                                                                                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 everything above the floor is a plugin     | S1, S2, S5, S8, S13, R1, R3                                                                                                                                                                              |
| A2 multiplayer by design                      | R2, R4, R5, R10 (R10 is the one with a stopwatch: two principals observe the same instant, or they do not)                                                                                               |
| A3 moddable by design                         | `docs/PLUGINS.md` + R1, S5, S11, S12, R9 (a stranger's agent onboards against the vocabulary and composes with the layout algebra; two words for one concept is two things to learn)                     |
| A4 sovereign nodes                            | R6 (addressing); wave 3 adds its own                                                                                                                                                                     |
| A5 waterfall authority                        | R8 guards the flat degenerate case; the evaluator LANDED in wave 4 (ADR 0011, #77) and its parity is proven by that wave's own suites rather than by a gate row, so a dedicated row is still owed        |
| A6 every exercise of authority is traced      | T1, T2, T3, T4, T5 (T2 is the one that holds without a dispatch: a rung that refuses without recording fails in the parser, never in a scenario somebody has to think of)                                |
| Foundation law (litmus, pillars)              | S2, S6, S7, S9, S13, S16                                                                                                                                                                                 |
| Every runtime-joined namespace has a registry | S3, S4, S7, S11, S12, S13, S14, S15, and `verify:budgets` for the §Budgets ↔ feed-vocabulary join                                                                                                        |
| D4′ disable semantics (ADR 0013)              | R3, S10                                                                                                                                                                                                  |
| One word per concept (invariant 16)           | S11, S12, S14                                                                                                                                                                                            |
| Plane rule and state discipline               | S3, S4, R7, R8, R10 (the event plane's own rule — a notification never mutates, and a subscription dies with its socket)                                                                                 |
| Self-description (the structured log)         | S14, R10 (the subscribe refusal is SILENT on the wire by design, so the log is the only place it is observable), T1-T5 (the durable half: what an operator tails versus what the workspace can be asked) |
| Gates assert on declared contracts            | S15                                                                                                                                                                                                      |
| Self-hosted first (ADR 0022)                  | S17 (the tree ships provider-neutral artifacts; the operator's instance is one deployment of them, named in exactly one file)                                                                            |

Also standing, in `bun run gate`: `verify:trace` (axiom A6's completeness check — T1-T5 above,
headless, its own server), `verify:convergence` (the document plane), `verify:tile-drop`
(the placement algebra through real gestures), `verify:budgets` (§Budgets — what an idle
workspace costs, which no boundary check can see), and the terminal e2e suites (the PTY
plane). Those prove the planes the axioms ride on; `verify:axioms` proves the axioms
themselves.
