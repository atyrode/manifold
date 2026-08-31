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
      "verdict": "the trait-driven rules engine and its executor: which item may enter which container, and which rule refused. Traits are manifest contribution data (G1), so the engine is neutral over kinds; it arbitrates between kinds no single plugin owns. The VERB is a plugin — core.space.place, not a bespoke route.",
      "adr": "docs/decisions/0013-plugin-behavioral-contract.md"
    },
    {
      "id": "assembly-engine",
      "globs": [
        "packages/plugin/src/**",
        "packages/server/src/plugin-host.ts",
        "packages/server/src/assembly.ts",
        "packages/server/src/main.ts",
        "packages/server/src/http.ts",
        "packages/server/src/config.ts",
        "packages/server/src/index.ts"
      ],
      "litmus": ["bootstrap", "neutrality", "arbitration"],
      "verdict": "the registry itself plus the doors it dispatches through, including the engine-owned enablement door (engine.plugins, a builtin roster row). Plugins presuppose the loader; it refuses collisions, resolves dependencies and order, and intersects capabilities — arbitration by definition. It ASSEMBLES the roster; it never renders a composition.",
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
        "packages/server/src/migrate-lexicon.ts"
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
        "packages/web/src/workspace.tsx",
        "packages/web/src/notice.tsx",
        "packages/web/src/styles.css",
        "packages/web/src/shell.css",
        "packages/web/src/container-memory.ts",
        "packages/web/src/web-version.ts",
        "packages/web/src/generated-changelog.ts",
        "packages/web/src/changelog-references.ts"
      ],
      "litmus": ["bootstrap", "neutrality", "arbitration"],
      "verdict": "the registry's browser half: AssemblyProvider, PanelOutlet and the engine-owned placeholder, HostServices, the projection registry it publishes to plugin code, the typed HTTP client, fault containment, and the read-only debug probe. It mounts panels without knowing which panels exist.",
      "adr": "docs/decisions/0010-plugin-engine-and-action-plane.md"
    },
    {
      "id": "sdk",
      "globs": ["packages/sdk/src/**"],
      "litmus": ["bootstrap", "neutrality", "arbitration"],
      "verdict": "the only WebSocket state machine plus the typed HTTP client: dial, keepalive, rejoin, channel demux, connection frames, action dispatch. Every principal — browser, agent, remote SDK — reaches the doors through it, which is the mechanism behind A2's 'one door, every principal'.",
      "adr": "docs/decisions/0010-plugin-engine-and-action-plane.md"
    },
    {
      "id": "gate-and-registries",
      "globs": ["AXIOMS.md", "REGISTRY.md", "scripts/verify-axioms.ts", "scripts/gate.ts"],
      "litmus": ["bootstrap", "neutrality", "arbitration"],
      "verdict": "the axioms' own enforcement machinery: the constitution, the registries in this file and the script that parses them in both directions. It is the pillar that makes every other pillar falsifiable, and it is the one place a boundary crossing cannot be silent.",
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
      "why": "the only WebSocket state machine plus the typed HTTP client; doc sync, presence relay, action dispatch and PTY streams reach every client through it"
    },
    {
      "glob": "packages/plugin/src/**",
      "why": "the registry itself: manifests, assembly, action definitions, host contracts, the default workspace layout — plus the plugin-facing standard library behind @manifold/plugin/hooks (plane mechanism: the carry/drop and tile vocabulary, the presence plane's browser half, the element host, the projection registry through which one renderer paints another plugin's occupant, the routed-container context, polling, the session URL, the debug probe) and @manifold/plugin/ui (neutral chrome: glyphs, the one titlebar, THE one tile-tree renderer with its drop preview and zone debug, the notice consumer half, the published vantage store)"
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
      "why": "identity and authority at the boundary; tagged as the future A5 evaluator's one call surface — what effectiveCaps() replaces"
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
      "glob": "packages/web/src/error-boundary.tsx",
      "why": "fault containment: a panel or renderer that throws must not take the workspace with it"
    },
    {
      "glob": "packages/web/src/workspace.tsx",
      "why": "the workspace host: fetches the per-principal layout and renders its panel leaves through TileTree"
    },
    {
      "glob": "packages/web/src/sidebar-panel.tsx",
      "why": "the core.shell.sidebar panel: sidebar chrome and the section stack, which must read the assembly to know which sections exist"
    },
    {
      "glob": "packages/web/src/container-view-panel.tsx",
      "why": "the core.shell.container-view panel: resolves the route to a container discipline and asks the projection registry for that discipline's renderer — it holds no renderer of its own"
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
      "why": "the shell's skin — the sidebar, the workspace frame and the routed container view. A separate OWNER from the floor stylesheet, in the same package because it has nowhere else to go: the components that paint it are floor, and a floor file may not import `@manifold-plugin/*` (§Lexicon cssFamilies)"
    },
    {
      "glob": "packages/web/src/container-memory.ts",
      "why": "device-local last-container routing memory behind the root route (register: manifold.last-container.<principalId>)"
    },
    {
      "glob": "packages/web/src/web-version.ts",
      "why": "release metadata read by the shell — floor-neutral"
    },
    {
      "glob": "packages/web/src/generated-changelog.ts",
      "why": "generated from CHANGELOG.md's released sections by the release path; never hand-edited, which is why §Lexicon allows its frozen vocabulary"
    },
    {
      "glob": "packages/web/src/changelog-references.ts",
      "why": "issue/PR reference parsing for the in-app history — floor-neutral"
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
token and principal administration verbs now, while the A5 evaluator (ADR 0011, grant rows,
`effectiveCaps`) remains a later wave — "identity mechanism is floor" never made
`POST /api/tokens` mechanism.

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
- **Refusals are named classes, not one boolean.** `essential` (only `core.shell`), `builtin`
  (an engine door has no toggle), the dependency classes, the data-version classes and
  `still_enabled` are members of one published set; the roster also carries `changedBy` /
  `changedAt`, so a placeholder can say who turned this off, and `lifecycle` (`ok` /
  `enable_failed` / `disable_failed`), because a teardown that fails is a state every principal
  can see rather than an assertion. Disable always completes.

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
      "means": "which renderer a container asks for: canvas or composition. The one field that separates the two renderers, and its value equals its owning plugin's last id segment",
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
      "term": "space",
      "means": "the workspace's own arrangement: the core.space seat that owns the layout writer (core.space.setLayout) and the placement verb (core.space.place)",
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
      "means": "one principal's published view state: the tool in hand, the edit target, the focused container, whether the sidebar is open",
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
      "term": "terminal",
      "means": "one PTY: its lifecycle, its controller lease and its home container",
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
      "term": "manifest",
      "means": "a plugin's inert declaration: id, capability ceiling, dependencies, data version, dormancy, contributions",
      "banned": [],
      "allow": []
    },
    {
      "term": "contribution",
      "means": "one declared offering of a plugin: a panel, a section, an element, a tool, an event",
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
      "means": "contribution kind: a collapsible block in the sidebar stack, ordered by its manifest",
      "banned": [],
      "allow": []
    },
    {
      "term": "tool",
      "means": "contribution kind: a canvas toolbar mode",
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
      "means": "an authority row: principal or class, node, capabilities, effect, reach",
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
      "means": "one freehand ink record",
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
      "means": "one HTTP or browser path",
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
      "family": "sidebar",
      "owner": "packages/web/src/shell.css",
      "why": "the sidebar rail, its sections, rows and inline actions — painted by `sidebar-panel.tsx`. Plugins fill these rows; the shell owns the row"
    },
    {
      "family": "workspace",
      "owner": "packages/web/src/shell.css",
      "why": "the workspace frame and its empty state, painted by `workspace.tsx` and `container-view-panel.tsx`"
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
      "why": "a machine's liveness pip and the menu row shown when no machine can host a terminal"
    },
    {
      "family": "canvas-text",
      "owner": "packages/plugins/notes/src/styles.css",
      "why": "the note element and its in-place editor. The prefix says where a note is painted; the owner is the plugin whose element it is, so disabling notes takes this with it"
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
      "why": "this device's principal grant (id, name, color, token) — the credential itself, which is why it never leaves the device"
    },
    {
      "key": "manifold.ownerKey",
      "why": "owner key captured from the #key= boot fragment; a secret, never sent anywhere but the Authorization header"
    },
    {
      "key": "manifold:debug",
      "why": "opt-in for the read-only debug probe window.__manifold; a browser-automation switch, not workspace state"
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
      "renderer": "packages/web/src/sidebar-panel.tsx",
      "why": "the word a gate reads to know the session is open; the one status a browser gate waits on before asserting anything else"
    },
    {
      "testid": "sidebar-list",
      "renderer": "packages/plugins/index/src/web.tsx",
      "why": "the index tree's root; R9 waits for its seeded adversarial rows to land before sweeping sidebar widths"
    },
    {
      "testid": "connection-status",
      "renderer": "packages/web/src/sidebar-panel.tsx",
      "why": "the status block that carries the state, scoped so a gate can assert the sidebar's copy of it rather than any occurrence"
    },
    {
      "testid": "machines-section",
      "renderer": "packages/web/src/sidebar-panel.tsx",
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
      "why": "R3's enablement rung scopes its toggle selector to the plugin-manager section root, so a row is picked out by plugin id inside the section that owns it"
    },
    {
      "testid": "plugin-manager-toggle",
      "renderer": "packages/plugins/plugin-manager/src/web.tsx",
      "why": "R3 presses the REAL enablement affordance instead of dispatching the door twice; row identity comes from the sibling data-plugin attribute, never from button copy"
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

Two rules give the table teeth. An undeclared door polled at idle is RED on sight — a budget
you can escape by not being in it is not a budget — and a backgrounded tab has a ceiling of
ZERO, because polling is a ratified wave-1 interim only for as long as it stops when the
operator looks away. The ceilings are the measured steady state with roughly 2× headroom, so
they pin the fixed behaviour rather than blessing whatever the tree happens to do today: the
`perMin` figures below sit against measurements of 30, 30, 30, 30 and 12 per minute.

When the workspace event channel lands (wave 2), the `network` rows do not move — they
collapse to zero, and the row that stops being reached becomes the diff that says so.

```json
{
  "budgets": {
    "totalRequestsPerMin": 160,
    "network": [
      {
        "resource": "core.index.read",
        "perMin": 45,
        "why": "the container index, at INDEX_POLL_MS. One feed: the shell needs it to name portal targets, the index section needs it to draw rows, and both subscribe to the same key rather than opening two timers"
      },
      {
        "resource": "core.terminals.listAll",
        "perMin": 45,
        "why": "the terminal index, at INDEX_POLL_MS. Same two subscribers, one feed; the placement algebra is answered from it"
      },
      {
        "resource": "core.terminals.listByContainer",
        "perMin": 45,
        "why": "terminals grouped by home, at INDEX_POLL_MS. One subscriber today (the index section's tree); the row exists so a second one shows up as a rate rather than as a mystery"
      },
      {
        "resource": "/api/attendance",
        "perMin": 45,
        "why": "cross-container presence, at INDEX_POLL_MS. It ran at two cadences under two callers before the feeds were shared — 1.5s in the shell and 2s in the section — which is two answers to one question"
      },
      {
        "resource": "core.machines.list",
        "perMin": 24,
        "why": "the machine roster, at MACHINE_POLL_MS. Slowest of the five because a machine coming online is not a thing an operator waits on"
      }
    ],
    "idleCanvas": {
      "commitsPerSec": 2,
      "scriptMsPer30s": 1500,
      "longTasks": 2,
      "longTaskMaxMs": 120,
      "socketFramesPerMin": 120,
      "why": "an open canvas with a live terminal, at rest. The ceilings are near-zero on purpose: content-compared shared feeds mean an unchanged answer reaches no subscriber, so a STEADY workspace should re-render nobody at all (measured: 0 commits, 195ms of script and 0 socket frames per 30s). Anything that puts a number here has found a new heartbeat"
    }
  }
}
```

## Runtime-joined namespaces

The law is `AXIOMS.md` §Foundation law, "Every runtime-joined namespace has a registry". These
are its instances, each written after the join it guards had already broken once:

| Runtime-joined namespace                             | Registry                    | Check |
| ---------------------------------------------------- | --------------------------- | ----- |
| device-local storage keys                            | the `deviceLocal` register  | S3    |
| `data-action` markers ↔ published actions            | the live assembly           | S4    |
| `/api/…` route literals ↔ the doors that exist       | the script's allowlist      | S7    |
| every word for a concept, across every plane         | §Lexicon rows               | S11   |
| item kind → display noun                             | `ITEM_NOUNS`, the ONE table | S12   |
| CSS selector families ↔ their owning package         | §Lexicon `cssFamilies`      | S13   |
| `evt=` log names ↔ the gates that match them         | `LOG_EVENTS`                | S14   |
| `data-testid` attributes ↔ the gates that click them | §Gate-contracts rows        | S15   |

## Gates

`bun run verify:axioms` (in `bun run gate`) is the axioms made falsifiable. Its static half runs
against the source tree, its browser half against a real server and a real browser.

| Check | What it asserts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1    | Both `assembly.ts` files assemble without an `AssemblyError`, and every panel id in the default workspace tree (`workspaceLayout(WORKSPACE_PANELS)` — the floor's arrangement applied to the registration's own pair) exists in the assembly. Discipline values equal their owning plugin's last id segment.                                                                                                                                                                                                                                                                                                                                                                                                         |
| S2    | Import boundary, walked with the TypeScript parser over this file's `floor` globs: floor files import no `@manifold-plugin/*` (the two `assembly.ts` files excepted); plugin packages import only protocol/scene/sdk/plugin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| S3    | Every `localStorage` key literal in `packages/web` and `packages/plugins` appears in the `deviceLocal` register.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| S4    | Every `data-action` literal in the source names an action the assembly actually publishes (soundness; coverage ratchets up as later waves convert the remaining affordances).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| S5    | Every `packages/plugins/*` directory is registered per the halves it exports, and every assembled definition maps back to a package — **builtin rows excepted**: an engine door (`source: "builtin"`) has no package by design, and the script assembles it explicitly.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| S6    | Registry liveness: every `floor` glob matches at least one file, so a stale row fails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| S7    | Route allowlist: the `/api/…` literals in the server's HTTP dispatcher equal the script's allowlist, so a bespoke feature route that bypasses the action door fails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| S8    | **Element vocabulary, read from the OWNERS' end.** `SceneElementSchema` is a neutral ENVELOPE and enumerates nothing (ADR 0013 §16), so there are no schema members to walk: what the check walks is the set of types some party CLAIMS — `FLOOR_ELEMENT_PAYLOADS` ∪ the assembly's contributed element types — and asserts every claim is claimed ONCE, so no type is owned by both the floor and a plugin. The envelope's own promise is asserted beside it: a STRANGER type nothing claims still round-trips, validating on the envelope's bounds alone, because a canvas holding a record whose plugin is absent from this build must keep it rather than have the wire refuse a `type` it was never told about. |
| S9    | Pillar exhaustiveness: every `floor` row falls inside exactly one pillar's globs (most specific glob owns the file); an unmatched floor file is RED. Wiring lands with the conversion batch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| S10   | The residual carve-out is published: the script lists every `cleanup: true` action in the assembly, so growth of the disable exemption shows up in a gate diff (ADR 0013 §9).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| S11   | **Lexicon**: no word in any §Lexicon row's `banned` list appears in an identifier, a classified wire literal, a CSS selector, a file or directory name, or a Markdown heading, outside a declared `allow` row — and every `allow` row suppresses at least one real occurrence, every `term` occurs at least once, and no `term` sits in another row's `banned` list.                                                                                                                                                                                                                                                                                                                                                 |
| S12   | **One label vocabulary**: exactly ONE table in the tree translates an item kind into a display noun, its keys are `ITEM_KINDS` ∪ the assembly's element types, and every value's canonical word is that key's registry term. A second such table fails (invariant 14 applied to vocabulary).                                                                                                                                                                                                                                                                                                                                                                                                                         |
| S13   | **CSS ownership**: every selector family in every stylesheet under `packages/` resolves to a §Lexicon `cssFamilies` row, and every rule is defined by the owner of the leftmost family it scopes into. A family painted from another package's sheet, a family with no row, a row whose stylesheet defines nothing, or a classless rule outside the floor sheet — each is RED, named by file and selector.                                                                                                                                                                                                                                                                                                           |
| S14   | **Log-event vocabulary**: every `evt` a producer passes to `Logger.info/warn/error` in `packages/server/src` or to the agent's log sink, and every `"evt":"…"` literal a `packages/testkit` e2e or a `scripts/` gate matches inside raw stdout, is a member of `LOG_EVENTS` — and every member has a live producer, so a name nobody emits is a stale row. The producer half is also a compile error (`LogEvent`); the CONSUMER half is why the check exists, because no type reaches inside a string literal.                                                                                                                                                                                                       |
| S15   | **Gate contracts**: every `[data-testid=…]` literal and every `clickTestId(…)` argument in `scripts/` resolves to a §Gate-contracts row AND to a live `data-testid=` attribute in that row's renderer (templated attributes match by shape), and every row is queried by some script. A gate keyed off button copy, or off a test-id nobody declared, fails.                                                                                                                                                                                                                                                                                                                                                         |
| S16   | **The floor's budget**: `packages/plugin/src` (source only, tests excluded) stays inside a declared line ceiling — a printed WARN at 9,000 and RED above 12,000. Every other static check asks whether a boundary is clean; this one asks how big the engine got, which is the failure mode the litmus test cannot see because it governs each addition and never the aggregate. `packages/plugin/src` is where growth lands first: every plugin imports it, so a helper put there is reachable by everything without justifying itself to a second party. Raising a threshold is a diff somebody defends.                                                                                                           |
| R1    | Vocabulary: `GET /api/protocol` actions ≡ the assembly; `GET /api/plugins` ≡ the roster; input/result schemas are present.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| R2    | Parity both directions: an SDK `core.terminals.rename` updates the browser DOM with no reload, and the browser's rename affordance is observed by the SDK as a `terminal_event`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| R3    | Hot enable/disable with no reload: `core.draw` off removes the tool and placeholders existing strokes; `core.machines` off makes its section VANISH from the sidebar while the manager row stays the ledger, and re-enable restores its manifest-ordered place (D4′ — chrome renders absence; data ghosts); `core.terminals` off refuses `terminal_open` while an existing terminal still accepts `kill` (D12); disabling `core.shell` is `refused`/`essential`.                                                                                                                                                                                                                                                     |
| R4    | Shell as composition: `GET /api/layout` has panel leaves; a real divider drag changes the stored ratios and dispatches exactly ONE `core.space.setLayout`; another principal's layout is untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| R5    | Presence and spotlight: a picked tool is visible to an SDK peer as `vantage.tool` within 2s; `core.presence.focus` centers the target's viewport through the debug probe; a container-scoped token invoking it is `forbidden`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| R6    | Addressing: `GET /api/resolve` round-trips a terminal and a container, and the `/uri/<encoded>` deep link navigates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| R7    | Every `[data-action]` in the live DOM names an action in the roster.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| R8    | The denial ladder end to end, including a container-scoped token on `engine.plugins.setEnabled` → `forbidden` (a door's audience is DECLARED: `scope: "workspace"` refuses scoped callers, `scope: "container"` admits them and obliges the handler to confine the answer — ADR 0013 §15).                                                                                                                                                                                                                                                                                                                                                                                                                           |
| R9    | Layout resilience: under adversarial content (unbroken 60+ character names, eight containers, a three-deep folder chain, a long terminal name) and a bounded sweep of sidebar widths (≥6), the sidebar, the plugin manager and a canvas terminal node's chrome hold four invariant classes — no VISIBLE horizontal overflow where overflow is `visible`, no visible content cut by `overflow: hidden` without a declared ellipsis, no visible descendant escaping the audited root's box, no two statically-flowing siblings painting over each other. Grounded in what an observer sees: effective opacity 0 paints nothing, and a negative-margin stack is a declared overlap.                                     |

Per-axiom round table — which checks would fail first if an axiom stopped holding:

| Axiom / rule                                  | Checks                                                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1 everything above the floor is a plugin     | S1, S2, S5, S8, S13, R1, R3                                                                                                                                                          |
| A2 multiplayer by design                      | R2, R4, R5                                                                                                                                                                           |
| A3 moddable by design                         | `docs/PLUGINS.md` + R1, S5, S11, S12, R9 (a stranger's agent onboards against the vocabulary and composes with the layout algebra; two words for one concept is two things to learn) |
| A4 sovereign nodes                            | R6 (addressing); wave 3 adds its own                                                                                                                                                 |
| A5 waterfall authority                        | none yet — designed (ADR 0011), not implemented; R8 guards the flat degenerate case                                                                                                  |
| Foundation law (litmus, pillars)              | S2, S6, S7, S9, S13, S16                                                                                                                                                             |
| Every runtime-joined namespace has a registry | S3, S4, S7, S11, S12, S13, S14, S15                                                                                                                                                  |
| D4′ disable semantics (ADR 0013)              | R3, S10                                                                                                                                                                              |
| One word per concept (invariant 16)           | S11, S12, S14                                                                                                                                                                        |
| Plane rule and state discipline               | S3, S4, R7, R8                                                                                                                                                                       |
| Self-description (the structured log)         | S14                                                                                                                                                                                  |
| Gates assert on declared contracts            | S15                                                                                                                                                                                  |

Also standing, in `bun run gate`: `verify:convergence` (the document plane), `verify:tile-drop`
(the placement algebra through real gestures), `verify:budgets` (§Budgets — what an idle
workspace costs, which no boundary check can see), and the terminal e2e suites (the PTY
plane). Those prove the planes the axioms ride on; `verify:axioms` proves the axioms
themselves.
