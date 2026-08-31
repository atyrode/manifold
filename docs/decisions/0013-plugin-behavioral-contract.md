# 0013 — The plugin behavioral contract (v2)

Date: 2026-08-31
Status: accepted (contract v2 ratified 2026-08-31); implemented in the wave-1 completion

Lexicon addendum 2026-08-31 (#69): this record is history and is not rewritten; the names it
cites moved in the lexicon cut. The plugin-roster join is **assembly**: `composeRoster` is
`assembleRoster`, `CompositionError` is `AssemblyError`, `onCompositionChanged` is
`onAssemblyChanged`, `CompositionDelta` is `AssemblyDelta` — where this record says
"composition" it means that join, and where it says "composition" as a container it means the
tiled **discipline**, which is now the word's only container sense. The placement verb
`core.layout.place` is `core.space.place`; `scope: "pad"` and `padScope` are the
container-scoped rung (`containerScope`); `pads:write` is `containers:write`; item kind
`canvas-pad` is `canvas` and the guard `discipline-match` is `discipline_match` (wire enum
literals are snake_case); `/api/pads/…` reads `/api/containers/…`; and `PadTreeItem` is
`IndexEntry`. Canon is `REGISTRY.md` §Lexicon.

## Context

Wave 1's first pass shipped the mechanism: one registry, one action door, a hot workspace-global
toggle, `essential` as a refusal, `cleanup: true` as a per-action carve-out, and an inert
placeholder for contributions whose plugin is off. What it did not ship is the behavior around
that toggle — what a plugin's stored data, its contributions, its neighbours and its version do
when it is turned off, turned back on, or updated. Those questions were answered ad hoc, one
site at a time, which is how every platform surveyed below acquired its scars.

Two things forced this decision now. First, the operator's ruling that wave 1 is complete only
when nothing above the floor is hand-wired: the conversion batch moves ~34 floor files and two
route families into plugins, which means plugin-owned data and plugin-owned renderers stop being
a demo (`core.draw`) and become the entire product surface. A toggle that silently changes what
happens to other principals' work is acceptable in a demo and not acceptable there. Second, a
source read of five shipped plugin platforms — Obsidian API 1.13.2 plus the official developer
docs, VS Code `main`, Factorio Lua API 2.1.17, MinecraftForge 1.19.x / NeoForged 26.1 / Fabric
`fabric.mod.json` v1, and Home Assistant core `dev` — produced ten named corrections (C1–C10)
and a six-row innovation-risk table (R1–R6) against the operator's contract draft. The corrections
are ratified design input, not commentary; this file is the draft plus the corrections, and it is
normative.

The single most important number from that read is R1: **nobody hot-enables and hot-disables
in-process plugin code while other principals are live in the same workspace.** VS Code refuses
outright — `canRemoveExtension` returns `false` once `activationStarted`, with the comment
`// Extension is running, cannot remove it safely` (`abstractExtensionService.ts:392-404`) — and
its clean live-disable story covers only extensions that never ran. Obsidian hot-toggles but is
single-user. Factorio needs a save reload. Forge and Fabric need a process restart. Home Assistant
reloads the config entry and only its entities observe the change. manifold's hot toggle is a
genuinely novel claim, and every rule below exists to keep the novelty in the mechanism instead of
in the failure modes: teardown of arbitrary in-process code is unreliable everywhere, which is a
fact about the world and not a fact about VS Code.

The unifying insight from the draft survives intact and is worth restating, because it is why this
contract is small: `cleanup: true` was already a **declared residual behavior** — a carve-out the
plugin declares and the engine honours while the plugin is off. Everything below generalizes that
one shape to the other planes, with the engine supplying a default when the plugin declares
nothing. What the corrections change is _which_ residuals are expressible, and who owns the parts
a disabled plugin cannot be trusted to own.

## Decision

### 1. Disable retains. Destruction is a separate verb (C4, risk R3)

Disable is reversible. It never erases, resets, migrates, or rewrites a single row of plugin-owned
data, and no manifest field can make it do so. The draft's `retention: "retain" | "reset" | "erase"`
loses two of its three values and stops being a choice: retention on disable is `retain`, always,
for scene elements, plugin storage, layout entries and roster state alike.

This is the one place where all five platforms agree and the draft disagreed with all five.
Obsidian keeps `data.json` untouched (`loadData`/`saveData`, `obsidian.d.ts:5055-5069`). VS Code
keeps `globalState` and `workspaceState` across disable and runs `scripts['vscode:uninstall']`
only on full uninstall. Factorio keeps the per-mod `storage` table in the save file. Home Assistant
disables by _reloading_ the entry (`async_set_disabled_by`, `config_entries.py:2510-2542`) and
marks the integration's devices and entities `disabled_by: CONFIG_ENTRY` — the registry rows and
every piece of user customization stay, and returning restores them. Forge goes further and forbids
_anyone else_ from taking a vanished id's place. Against that, a permission-gated one-click
workspace-global lever that irreversibly destroys other principals' work is not a feature with a
sharp edge; it is a different verb wearing the disable verb's clothes.

So destruction gets its own name, its own refusal, and its own hook:

- **`engine.plugins.purge { id }`**, cap `plugins:manage`, is the destructive verb. It is
  **refused while the plugin is enabled** — denial rule `refused`, refusal class
  `still_enabled` — because purging is a two-step act by construction: disable first, purge
  second, and the first step is the reversible one.
- **`onPurge`** on `PluginDef.lifecycle` is where the plugin destroys what it owns. This is Home
  Assistant's `async_remove_entry` shape exactly: a hook that runs on _removal_ only, distinct from
  the unload hook, so "clean up your connections" and "delete the user's data" can never be the
  same code path. It runs under the same 2-second bound as every other hook, and — like a disable —
  a failing `onPurge` does not stop the purge: the engine's own bookkeeping is what makes the
  outcome definite. Around the hook the engine clears that plugin's `ctx.storage` namespace
  including its version stamp and migration ledger (§6, §11) and releases its element-type
  reservation (§7).
- Those three consequences are the closed purge vocabulary the protocol publishes —
  `PLUGIN_PURGE_TARGETS = ["storage", "elements", "ownership"]` — and a manifest may declare
  `purges?: PluginPurgeTarget[]` to say which of them it holds. That declaration is **audit
  visibility only**: it answers "what does purging this cost me?" before the button is pressed,
  and it is never bound to the disable verb.
- The action's result is an **exhaustive record**, not a summary:
  `{ id, removed: { storage, elements, ownership } }` with all three keys always present, zeros
  included. A destructive verb that reports only what it happened to touch cannot be audited, and
  "nothing was removed" and "that target was not considered" must not look alike.
- **A purge does not touch documents.** Elements a plugin's kinds contributed live in a room's Yjs
  document, which is the workspace's data rather than the plugin's; what the purge releases is the
  plugin's claim on those kinds, not the records. Deleting a canvas's contents remains the
  workspace's own verb, invoked by someone who can see what they are deleting.

Consequence for the conversion batch: a disabled plugin's element rows stay in the scene document,
its `ctx.storage` namespace stays in SQLite, its panel leaf stays in every principal's stored
layout, and its section keeps its manifest-declared slot in the sidebar order. Re-enabling restores
what was there, in place.

### 2. Lifecycle hooks, and failure as a named state (C6)

`PluginDef.lifecycle` — on the definition, never the manifest, because manifests stay inert data
(ADR 0010 rule 2) — carries four optional hooks:

```ts
interface LifecycleCtx {
  readonly pluginId: string;
  readonly storage: PluginStorage;
  now(): number;
}
interface PluginLifecycle {
  readonly onEnable?: (ctx: LifecycleCtx) => void | Promise<void>;
  readonly onDisable?: (ctx: LifecycleCtx) => void | Promise<void>;
  readonly onCompositionChanged?: (
    ctx: LifecycleCtx,
    delta: CompositionDelta,
  ) => void | Promise<void>;
  readonly onPurge?: (ctx: LifecycleCtx) => void | Promise<void>;
}
```

That context is deliberately three members wide. A lifecycle hook exists to put a plugin's **own**
durable state in order; anything that touches the workspace is a mutation, and a mutation goes
through an action door where it can be authorized, validated, logged and observed (invariant 13). A
hook holding the room map or the store would be a second mutation path that no principal can see,
which is the failure this whole contract is built to avoid.

The draft left "what if `onDisable` throws, or never resolves?" unspecified. That is not a corner
case in a shared workspace; it is the mechanism by which one plugin's bad teardown wedges every
other principal's session. The two platforms that met this problem answered it in opposite ways and
both answers are instructive. VS Code punted honestly and wrote the punt into the public API:
`ExtensionContext.subscriptions` is documented as "_Note_ that asynchronous dispose-functions
aren't awaited" (`vscode.d.ts:8422-8433`). Home Assistant made it a **state**: unload support is
optional per integration, and `failed unload` — "attempted to be unloaded, but this was either not
supported or it raised an exception" — is a first-class, displayable config-entry state beside
`loaded`, `setup error`, `setup retry` and `migration error`.

manifold takes Home Assistant's answer with VS Code's timing discipline:

1. Every hook runs under a **bounded await of 2 seconds**.
2. **Disable always completes.** A throw or a timeout in `onDisable` does not abort, retry, or
   defer the disable; the roster commits and the broadcast goes out regardless. A shared workspace
   must never be held hostage by one plugin's cleanup.
3. Failure is **named on the roster**, not logged and forgotten: the roster entry carries
   `lifecycle`, drawn from the closed set `PLUGIN_LIFECYCLE_STATES = ["ok", "enable_failed",
"disable_failed"]`, so every connected principal — human or agent, UI or `GET /api/plugins` —
   sees the same degraded truth. A throwing `onEnable` leaves the plugin composed-but-degraded
   with `enable_failed`, never half-mounted and never silently fine.
4. One structured log line per failure, carrying the plugin id and the hook name.
5. **The hooks are TRANSITION hooks, not boot hooks.** At boot, everything enabled is simply live:
   no `onEnable` fan-out, no `onCompositionChanged`, and no lifecycle state inferred from a start
   that nobody toggled. A `lifecycle` value other than `ok` therefore always describes a
   transition that actually happened, which is the only way the roster's degraded states stay
   meaningful. This is the Obsidian `onUserEnable` distinction (`obsidian.d.ts:5073`, "The user has
   explicitly interacted with the plugin") and Factorio's `on_init`-vs-`on_load` split arriving at
   the same place: "restored" and "just turned on" are different events and must not share a hook.

`essential` joins this vocabulary rather than sitting beside it: it becomes one member of a **named
refusal class** on the roster entry (`refusal`), because manifold needs several the moment the rest
of this contract lands, and VS Code already ships three — language packs, the Settings-Sync auth
provider, and env-enabled extensions each throw their own named refusal
(`extensionEnablementService.ts:255-268`). A boolean cannot carry a reason, and a reason is what a
UI and an agent both need. The published set is
`PLUGIN_REFUSAL_REASONS = ["essential", "builtin", "unknown_plugin", "missing_dependency",
"incompatible_dependency", "dependency_disabled", "data_downgrade", "data_migration_missing",
"element_type_owned", "still_enabled"]` — `builtin` is what a toggle attempt against an engine door
gets (§10), and the rest are the refusals §5, §6 and §7 name.

**How a refusal is worded.** The class is the contract, but a class alone cannot say _which_ plugin
is in the way, so `ActionDenial.message` for rule `refused` is the class **verbatim** when there is
nothing to name and `"<class>: <offenders, comma-separated>"` when there is. Live examples:
`essential`, `builtin: engine.plugins`, `still_enabled: core.draw`,
`unknown_plugin: core.ghost`, `missing_dependency: test.leaf`,
`dependency_disabled: test.base`, `incompatible_dependency: test.rival`. A client switches on the
prefix before `": "` and never parses the remainder for meaning — it is offender identity, for
display. That format is how §5's "the refusal names what is in the way" is actually satisfied, and
it is why the vocabulary is a class plus a name rather than a sentence: VS Code's
"Cannot uninstall '{0}' extension. '{1}' extension depends on this." carries exactly the same two
pieces of information inside prose a client cannot branch on.

### 3. The composition-changed broadcast (C3)

The draft's lifecycle fired on the plugin being toggled. Factorio's hard-won answer is the
opposite, and it is the highest-value hook this contract adds:

> This step runs for all mods if the save's mod configuration has changed. The configuration is
> considered to be different when the game version or any mod version changed, when any mod was
> added or removed, when a startup setting has changed, when any prototypes have been added or
> removed, or when a migration was applied. … This is mod-agnostic, meaning the
> `on_configuration_changed()` handlers will either be run for every active mod, or for none of
> them.
> — Factorio data lifecycle, `auxiliary/data-lifecycle.html`

The plugin that needs to repair state is usually not the plugin that changed. So:

**`onCompositionChanged(ctx, delta)` fires once per SURVIVING server plugin** — enabled both before
and after the change — in composition order, **after the roster commit and before the roster
broadcast**, with `delta: { enabled: PluginId[]; disabled: PluginId[] }`. The plugins named in the
delta do **not** get this hook: they get their own `onEnable` or `onDisable`, so no plugin is told
twice about its own transition. Same 2-second bound, same "never blocks the commit" rule as §2.
Ordering is the topological order of §5, which is why that order has to be deterministic rather
than incidental.

This is the wave-1-shaped version of the wave-2 event plane (ADR 0012) and does not pre-empt it:
it is one synchronous in-process fan-out at a door the engine already owns, with no subscription,
no topic, no transport. When the event plane lands, `roster changed` becomes one of its declared
emissions and this hook is the local, ordered, pre-broadcast half that a repair pass needs and a
notification cannot give. Without it, "plugins own behavior" is true only for the plugin that was
toggled, and every neighbour discovers dangling references lazily — which is precisely the failure
Factorio's step 5 exists to prevent.

### 4. Dormancy is declarative; the engine owns the placeholder (C7, risk R2)

The draft allowed a plugin's web half to supply the renderer used when that plugin is disabled
(`dormant?: ComponentType<DormantProps>`). Contract v2 refuses this shape. Dormancy is
**declarative manifest data**:

```ts
dormant?: { mode: "ghost" | "hide"; label?: string };
```

`ghost` renders the engine's inert named placeholder; `hide` skips paint while keeping the record,
the slot and the data. The modes are the closed set
`PLUGIN_DORMANT_MODES = ["ghost", "hide"]` and the default when a manifest is silent is `ghost` —
absence must be visible unless a plugin author deliberately says otherwise. `label` is an optional
string the engine puts in its own chrome. That is the entire vocabulary, and it is inert data in a
manifest that the server validates, stores, diffs and publishes — which is ADR 0010's rule 2,
unchanged.

The reason is circularity, and it is structural rather than stylistic. A residual renderer for a
disabled plugin lives in that plugin's web half. It works in wave 1 only because every plugin's
code is statically bundled and permanently resident. The manifest already reserves
`entry: { web?, server? }` for dynamic distribution, and the day `entry.web` means "code that may
not be loaded", the engine's rendering of an absent plugin depends on loading the absent plugin's
code. There is no clean answer at that point, only a fallback path that will be written under
pressure.

Obsidian is the precedent, and it went further than manifold needs to: since 1.7.2 the placeholder
is not a special case for absent plugins at all — "all views are created as instances of
**DeferredView**", with `leaf.isDeferred` and `leaf.loadIfDeferred()` (`obsidian.d.ts:8289-8301`)
materializing the real view when it becomes visible. The engine owns "a slot whose view is not
there", uniformly, for performance and for absence alike. Forge's rule is the same conviction from
the data side: when a registry id vanishes, the default action is "notifying the user about the
missing entry", never silent absence.

Obsidian also documents the layout half of this, and it is the default the draft already had right:

> ### Don't detach leaves in `onunload`
>
> When the user updates your plugin, any open leaves will be reinitialized at their original
> position, regardless of where the user had moved them.
> — Obsidian plugin guidelines

`Workspace.detachLeavesOfType` exists (`obsidian.d.ts:8037`) and is explicitly discouraged. The
slot survives; restoration is in place. manifold's stored per-principal layout behaves identically:
a disabled panel's leaf stays in the tree, the placeholder carries a remove control for the
principal who genuinely wants it gone, and layout writes naming an unknown panel id are **accepted**
so that a disable can never brick a layout write.

The component form of `dormant` is not merely deprecated, it is deleted; the orthogonal case
Obsidian actually uses a component for — the owner is enabled but this node is not materialized yet
— is a rendering-performance question, and if manifold ever wants it, it is a separate decision
with its own name.

Two consequences of engine ownership are worth stating because they are what makes the rule
checkable rather than aspirational. First, the placeholder decision happens **before a plugin's
component is constructed**, at every mount site, asking the same three questions in the same order:
unknown contribution → `unknown`, owning plugin disabled → `disabled`, declared but no renderer
registered → `unavailable`. A plugin implements nothing for dormancy and has no seam to implement it
in — which is the C7 circularity closed by construction rather than by convention — and the state is
mirrored to `data-plugin-state` so a gate can assert on it.

Second, `hide` is for **chrome**, never for a node holding a user's work. A toolbar tool that
vanishes costs a button; a hidden note record makes someone's prose invisible without deleting it,
which is the one outcome worse than a placeholder and the exact failure A1's "a missing feature must
be visible, not invisible" exists to forbid. The default therefore points the safe way, and silence
in a manifest is a real declaration: `core.notes` ships no `dormant` field at all.

### 5. Dependencies, and ordering as a separate axis (C2, risk R6)

The manifest gains:

```ts
dependencies?: Record<PluginId, { type: "required" | "optional" | "incompatible"; reason?: string }>;
after?: PluginId[];
```

Four of the five platforms have a dependency model, and three of them treat _ordering_ as an axis
distinct from _requirement_ — NeoForge most explicitly, where a `[[dependencies.<modid>]]` block
carries `type` ∈ `required|optional|incompatible|discouraged`, a `versionRange`, an
`ordering` ∈ `BEFORE|AFTER|NONE`, a `side`, and a `reason`: "An optional user-facing message to
describe why this dependency is required, or why it is incompatible." Home Assistant splits the same
axis by name — `dependencies` must set up first, while `after_dependencies` only orders against
integrations that happen to be configured ("If `stream` is not configured, `camera` will still
load"). Factorio encodes both in one string grammar (`!` incompatible, `?` optional, `+`
recommended, `(?)` hidden optional, `~` does-not-affect-load-order, bare = hard requirement, with
`< <= = >= >` version operators). Fabric splits five relations by failure severity: `depends`
(hard), `recommends` (warning), `suggests` (metadata), `conflicts` (warning), `breaks` (hard).

Obsidian is the sole zero-dependency model, and it is the wrong precedent for manifold precisely
because Obsidian plugins never compose with each other: a grep for `dependenc|depends|requires`
across all 8,498 lines of `obsidian.d.ts` finds nothing but unrelated prose. manifold's core plugins
compose by construction — `core.shell` hosts every panel and section, and after the conversion
batch `core.canvas` hosts contributed element renderers — so the absence of a dependency model is
not minimalism, it is an unstated dependency graph.

The rules, deliberately smaller than any of the grammars above:

1. **`required` missing or disabled, or `incompatible` present → composition refuses**, naming both
   offenders in the D5 house style, and quoting `reason` when the manifest supplied one. `reason` is
   NeoForge's field and it is worth demanding at authoring time: dependency failures are read by
   humans, and the cost of the field is one string.
2. **`after` is soft ordering only.** It never makes a plugin required. Missing `after` targets are
   ignored — Home Assistant's `after_dependencies` semantics.
3. **Order is derived, deterministic, and total**: topological over `dependencies` ∪ `after`, ties
   broken by lexicographic plugin id. That is Factorio's rule minus its dependency-depth heuristic
   ("for mods with identical chain depths, the natural sort order of their internal names then
   determines the definitive ordering"), and, as in Factorio, **that same order is the dispatch
   order** for the §2 and §3 lifecycle fan-outs. A cycle is a `CompositionError` naming the cycle.
4. **Disabling a plugin with enabled dependents is refused**, naming them. This is deliberately
   VS Code's uninstall rule ("Cannot uninstall '{0}' extension. '{1}' extension depends on this.",
   `abstractExtensionManagementService.ts:942-958`) rather than VS Code's disable rule, which
   silently computes dependents into `EnablementState.DisabledByExtensionDependency`
   (`extensionEnablementService.ts:606-641`) and then cannot re-enable them individually ("Cannot
   enable '{0}' extension because it depends on '{1}' extension that cannot be enabled"). A cascade
   that disables plugins the actor did not name is a worse outcome in a shared workspace than a
   refusal that names them: the refusal is one round trip, the cascade is other people's surfaces
   disappearing without their consent.
5. **No enable cascade.** VS Code's `setEnablement` recursively enables dependencies and pack
   members (`extensionEnablementService.ts:311-313`); manifold refuses instead and names what is
   missing. One toggle, one plugin, one visible consequence — a cascade in a workspace-global
   setting is a lever whose blast radius the presser cannot see.
6. **Composition refuses only STRUCTURAL truths**, and the set is closed: a missing or disabled
   `required` dependency, a cycle, a self-dependency, an `engine.*` squat, an element-type squat,
   and — for ENABLED plugins only — a stored-data downgrade or a missing major migration (§6).
   Anything about a disabled plugin is retained and re-judged at the enablement door, so one
   dormant plugin's stale rows can never stop a server from booting. That asymmetry is the whole
   reason the data checks live at two places instead of one.

Version ranges on dependencies are **not** in this contract. Every platform surveyed has them, and
every platform surveyed distributes plugin code independently of the host, which manifold does not
yet do (ADR 0010: `entry` is a reserved seam, the marketplace is its own wave). Adding a range
grammar now would be compatibility machinery for a case that cannot occur, which D13 forbids; the
field arrives with dynamic distribution, and §6's `dataVersion` already covers the case that _can_
occur today, which is a plugin updating against its own stored rows.

### 6. `dataVersion`, migrations, and the HA asymmetry (C1)

The manifest gains `dataVersion: { major: number; minor: number }`, and `PluginDef` gains
`migrations: readonly PluginMigration[]` — each one a `{ name, to, migrate(storage): void }`, where
`name` is what the ledger records and `to` is the version the migration produces. A migration is
**synchronous** because the substrate is synchronous SQLite and a migration must be all-or-nothing:
an `await` in the middle of a rewrite is a window in which dispatch interleaves with half a
migration, and there is nothing a plugin migration legitimately needs to await. Migrations run at
boot for enabled plugins and at the enablement door for a plugin being switched on, never for a
disabled one.

Applied migration **names** are recorded in the plugin's own storage namespace under engine-reserved
keys (`$migration:<name>`, with the current stamp at `$version`) and no migration ever runs twice —
Factorio's rule, which is stated as a save-file property: "Each save file remembers (by name) which
migrations from which mods have been applied and will not apply the same migration twice. When
adding a mod to an existing save, all migration scripts for that mod will be run." Names, not
numbers, because a name survives branch merges and a sequence number does not; and the ledger lives
beside the data it describes, so a purge that clears the namespace cannot leave a ledger claiming
migrations were applied to rows that no longer exist.

The compose-time rule is Home Assistant's asymmetry, adopted verbatim because it is the shape that
makes "no compatibility machinery" (D13) survive contact with a plugin's second release:

| Stored vs. code `dataVersion`         | Outcome                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| equal                                 | compose                                                                        |
| minor differs, major equal            | **compose anyway**, with no migration required                                 |
| major differs, migration present      | run the unapplied migrations in order, record them, compose                    |
| major differs, **no** migration       | **refuse to compose that plugin**, named error                                 |
| stored major > code major (downgrade) | **refuse**, named error — "stored data is newer than this build of the plugin" |

Home Assistant's source is unambiguous on all three branches (`config_entries.py:1166-1193`),
including the downgrade refusal (`if self.version > handler.VERSION:` → log "has version %s which
is higher than the current version %s" → `return False`), and its docs state the asymmetry as
policy: "If minor versions differ but major versions are the same, integration setup will be allowed
to continue even if the integration does not implement `async_migrate_entry`… unlike a major version
bump which causes the integration to fail setup if the user downgrades."

Two manifold-specific notes. First, a refusal here is a **per-plugin** refusal with a named reason
on the roster (§2), not a boot failure: one plugin's version mismatch must not take the workspace
down. Second, this is where D13 is honoured rather than violated. D13 forbids compatibility
machinery for _manifold's own_ shipped data, and it holds: there are no dual readers, no aliases, no
fallback paths in the engine. `dataVersion` is not a compatibility layer, it is the mechanism by
which a plugin author performs a **one-way** conversion and the engine refuses to guess. Without it,
the first plugin to ship a v2 schema against v1 rows either silently mis-reads them or destroys
them, and "no migrations owed" would have quietly become "data loss is the migration".

### 7. Element-type ownership is reserved, not recycled (C5)

Composition already refuses duplicate element types _among composed plugins_ (D5). It says nothing
about a plugin claiming an element type that stored scene data attributes to a **disabled or purged**
plugin — and that gap is the one Forge decided was more dangerous than missing data:

> All actions besides remapping will prevent any other registry object from taking the place of the
> existing id in case the associated entry ever gets added back into the game.
> — MinecraftForge, handling missing entries

with a default that asks rather than deletes: "If no action is specified, then the default action
will occur by notifying the user about the missing entry and whether they still would like to load
the world." The four actions (`IGNORE`, `WARN`, `FAIL`, `REMAP`) are a **closed enum**, which is
also the model for §9. Worth recording as a caution rather than a precedent: NeoForge's 20.2
vanilla-registry realignment ships no documented missing-mappings mechanism, and Fabric never had
one — this is a safety net a successor platform dropped, not a universal feature.

So manifold writes ownership down. A **reservation record** maps `element type → owning plugin id`,
written at compose time and stored as a `meta` row (`plugins:element-owners`) beside the enablement
set (`plugins:disabled`) and the attribution row (`plugins:attribution`) — the same substrate the
engine's other bookkeeping already uses, because a reservation is one small map, not a table's worth
of rows. Composition **refuses** when a plugin claims a type the record attributes to a different
id, naming both. A disabled plugin's element types are its own while it is off, and a purge is what
releases them. Home Assistant is the model for the restore half: `async_remove` does not drop the
registry row, it moves it into `deleted_entities` keyed by `(domain, platform, unique_id)` carrying
aliases, area, categories, labels, name, icon, options and `disabled_by`
(`entity_registry.py:1625-1660`), so re-adding the same `unique_id` restores the user's settings.

manifold does **not** adopt Home Assistant's TTL (`ORPHANED_ENTITY_KEEP_SECONDS = 3600 * 24 * 30`,
`entity_registry.py:81`). A workspace is not a device registry: nobody benefits from an element type
becoming claimable again 30 days after someone turned a plugin off, and a reservation that expires
on a wall clock is a reservation that expires while a user is on holiday. Reservations end by
explicit purge, and only by explicit purge. Remapping — an owner handing its types to a successor id,
Forge's `REMAP` — is the natural next verb here and is **not** in this contract; the marketplace wave
owns it, because that is when a substitute plugin claiming a core plugin's types becomes a real
scenario (AXIOMS.md §Roadmap: replacing a core plugin is disable-then-enable-a-substitute by id).

### 8. The roster names who changed it (C8)

The roster entry gains `changedBy` (the principal id, nullish when nobody has toggled this row) and
`changedAt` (epoch millis, likewise nullish), and the placeholder chrome reads them: "Draw disabled
by alex". This is not an event-plane feature and does not wait for wave 2 — it is two fields on data
the server already broadcasts on every roster change.

The reason is that a workspace-global hot toggle changes what other people are looking at, right
now, and the draft's answer ("transient roster-change notice; actor attribution arrives with wave-2
event provenance") is weaker than the act deserves. The calibration point is Forge, which blocks
world entry on a modal question for the strictly less social event of a single missing registry id.
Attribution is also the cheapest possible mitigation for risk R5 (enablement as workspace-global
shared state, which no surveyed platform does — Obsidian and VS Code are per-user, VS Code even
per-workspace; Home Assistant is per-install; Factorio is per-save with everyone reloading).

The second half of C8 — refusing or confirming a disable when another principal has the plugin's
panel mounted right now, VS Code's dependents refusal applied to live sessions ("Cannot disable
'core.draw': 2 other principals have its panel open") — is a reserved future member of §2's
refusal-class set. It is not implemented in this wave: it needs a live census of who has what
mounted, which is presence-shaped data, and the honest place for it is after the presence
conversion completes. The vocabulary is a named enum precisely so that adding it later is one
member, not a redesign.

### 9. Residual mechanisms are a closed enum (C10)

The draft generalized "declared residual behavior" to every plane without a ceiling. An open-ended
carve-out from the disable rule is an open-ended hole in it. Forge's four missing-mapping actions
are a closed enum for exactly this reason.

The complete, closed set of residual mechanisms is
`PLUGIN_RESIDUAL_MECHANISMS = ["cleanup", "dormant", "retain"]`:

| Plane  | Mechanism                    | Meaning while the owner is disabled                            |
| ------ | ---------------------------- | -------------------------------------------------------------- |
| Action | `cleanup: true` on an action | dispatchable — removal survives a disable (D12)                |
| Render | `dormant: { mode, label? }`  | `ghost` (engine placeholder) or `hide` (record kept, no paint) |
| Data   | `retain`                     | not a choice; §1                                               |

The lifecycle hooks of §2 are not residual mechanisms and deliberately do not appear in that set:
they run _during_ the transition, under a bound, and grant a disabled plugin no standing surface.
A mechanism belongs in the enum only if it leaves something of a disabled plugin live.

The enum lives in the protocol as a closed vocabulary, and `verify:axioms` **publishes the list of
every `cleanup: true` action in the composition** — so growth of the carve-out is visible in a gate
diff and in review, rather than discovered later by someone auditing why a disabled plugin mutated
something.

### 10. The enablement door belongs to the engine (risk R5, axiom A2)

`setEnabled` moves out of `core.plugins` and into the engine, published as a **builtin roster row**:
manifest id `engine.plugins`, actions `engine.plugins.setEnabled` and `engine.plugins.purge` (both
cap `plugins:manage`), roster `source: "builtin"` from the closed set
`PLUGIN_SOURCES = ["builtin", "plugin"]`, dispatched through the same denial ladder, published in
the same `GET /api/plugins` and `GET /api/protocol` vocabulary, described by the same manifest and
`ActionSummary` shapes as any plugin row. What distinguishes a builtin row is data, not a parallel
mechanism: it carries no toggle, and a `setEnabled` aimed at one is refused with the class
`builtin`. The protocol publishes `ENGINE_NAMESPACE_PREFIX = "engine."` and `engine.*` becomes a
**reserved namespace**: `composeRoster` refuses any non-builtin definition claiming an
`engine.`-prefixed id, in the same named-offender style as every other collision (D5). The id
pattern itself is untouched — `engine.plugins` is dotted like every other plugin id, because a
builtin door is described by the same schema it is dispatched through.

`core.plugins` keeps only what it always should have owned: the manager UI. It loses the action
entirely — its section's toggle and its `data-action` attribute now name
`engine.plugins.setEnabled` — and it loses `essential: true`, becoming an ordinary, disableable
plugin. Disabling the plugin manager now means losing a section and keeping the door: the workspace
stays administrable over the API by any principal with `plugins:manage`, and any substitute manager
UI can be enabled in its place.

The current code says out loud why it needed the flag before this ruling
(`packages/plugins/plugin-manager/src/index.ts:16-21`): without `essential`, any `plugins:manage`
holder could disable `core.plugins`, at which point `setEnabled` is refused as `plugin_disabled`
for _everyone including root_, and the composition is frozen short of editing SQLite by hand. That
comment is a correct diagnosis of a real self-lockout — and `essential` is the wrong cure, because it
makes a plugin undisableable in order to protect a mechanism that should never have lived inside a
plugin. The bug is the location of the door, not the absence of a lock.

The A2 argument is decisive. A2 requires every capability to be reachable identically by a local
human, a remote human, and an agent, over the UI and over the API. If the door that changes the
composition lives _inside_ the composition, then the reachability of the enablement capability is
contingent on composition state — one toggle and it is reachable by nobody. A capability that can be
deleted by exercising it is not a capability, and no amount of `essential` flags changes that; it
only papers over the one instance we happened to foresee. The same argument applies to the roster
itself: the roster must always contain the door that changes the roster, which is what
`source: "builtin"` is for.

The precedent is VS Code's, and it was read in source: enablement is **workbench** code, not an
extension. `extensionEnablementService.ts` owns `setEnablement`, the cascade, the
`DisabledByExtensionDependency` state and all three named refusals; the Extensions _view_ is UI over
that service. No extension can disable the extension-management mechanism, and the mechanism is not
itself an extension point. Factorio corroborates the same separation from the opposite direction:
mods declare a dependency on `base` as they would on any mod (the `info.json` dependency grammar
makes no exception for it), while the mod-manager GUI is engine, never a mod — even the platform that
most aggressively ships its own content as mods keeps the manager out of the managed set. (That
Factorio detail is background from the platform's structure rather than a citation re-verified in
this wave's prior-art read; the load-bearing precedent here is VS Code's, which was.)

Names in this design are readable rather than authoritative: `source: "builtin"` carries the truth in
data, and `engine.plugins` merely makes a roster row legible to a human reading it.

### 11. `ctx.storage` — per-plugin storage as a first-class surface (G2)

Plugins own data, so the engine owes them a place to put it that is not "reach into the store".
`ctx.storage` is that place, and it is the only one:

- **One table, namespaced by plugin.** The substrate is a single SQLite table,
  `plugin_kv(plugin_id, key, value)` at schema version 10. A plugin addresses keys, never rows: it
  cannot name another plugin's data and never sees a table name. Cross-plugin reads are an action
  call, not a shared key space.
- **Keys and values are bounded**, because an unbounded key space in a shared table is a shared
  problem: keys match `^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$` and values are ≤64 KiB. A plugin with
  more than that to store has a document, and documents have a plane.
- **`$`-prefixed keys are engine-reserved and unforgeable by plugins.** That is where the version
  stamp (`$version`) and the migration ledger (`$migration:<name>`) live — inside the namespace they
  describe, so §1's purge cannot leave a ledger behind that outlives its data, and a plugin cannot
  forge a claim that a migration already ran.
- **Versioned and migration-ledgered.** The `dataVersion` rules of §6 govern this surface.
- **Purge-scoped.** `engine.plugins.purge` knows exactly what a plugin owns, which is what makes §1's
  clean separation implementable rather than aspirational. A plugin that writes outside `ctx.storage`
  is a plugin whose purge is a guess.
- **Retained on disable**, per §1.

The surface is synchronous and string-valued, which are both decisions rather than omissions:

```ts
interface PluginStorage {
  readonly pluginId: string;
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
  keys(prefix?: string): readonly string[]; // sorted, and never the engine's `$` rows
  dataVersion(): PluginDataVersion | null; // null until something is stamped
  appliedMigrations(): readonly string[]; // bare names, `$migration:` stripped
}
```

Synchronous because the substrate is Bun's synchronous SQLite: an async facade would add a promise
per read for no concurrency and would make an all-or-nothing migration interleavable with dispatch
(§6). String-valued because the engine has no business knowing whether a plugin's blob is JSON —
typing it `unknown` would only move a `JSON.parse` into the floor, which is a domain decision in a
neutral pillar (§13, litmus 2).

The reserved half never reaches a plugin: `stampDataVersion`, `recordMigration` and `clear` live on
an admin view the engine keeps, and the plugin-facing `set`/`delete` throw on a reserved or
malformed key. That is what makes `$version` and `$migration:<name>` **unforgeable** rather than
merely conventional — a plugin that could write its own ledger could claim a migration ran, and the
refusal in §6 would be advisory.

The engine's own workspace-level bookkeeping stays where it already was — `meta` rows beside
`plugins:disabled` for enablement attribution (`plugins:attribution`) and element-type reservations
(`plugins:element-owners`) — because those are facts about the composition, not data belonging to
any one plugin, and putting them in a plugin's namespace would make them purgeable by the plugin
they describe.

This is Obsidian's `loadData`/`saveData` and Home Assistant's per-entry registry rows in manifold
shape, and Factorio's `storage` table is the same idea with the same lifecycle coupling ("`storage`
not yet restored" during `control.lua`, read-only during `on_load`). The engine implements the
surface in this wave; the table moves — which floor code stops owning which rows — happen in the
conversion batch, per plugin, with the ownership of each row recorded where the plugin is registered.

Storage is not a fourth plane. It is the durable half of the action plane: a handler reached through
the door writes through `ctx.storage`, and nothing else does.

### 12. Placement traits are manifest contribution data (G1)

The placement algebra was a set of closed tables in `packages/protocol/src/placement.ts` —
`ITEM_KINDS` enumerated `terminal`, `canvas-pad`, `view`, `text`, `draw`, `tile` with their groups,
guards and homing, and `CANVAS_OPS` mapped a kind to its canvas operation. Five of those six kinds
resolved to floor-owned renderers. As long as the tables are closed, every new element kind is an
edit to the floor, which is A1's failure mode in its purest form: a plugin cannot contribute an
element without the engine learning its name.

So the traits move into the manifest. An element contribution declares its **placement behavior** as
data — exactly three fields, `groups` (which containment groups it belongs to), `guards` (which
item-side guards apply) and `homed` (its homing mode, or `null` for no home) — and the algebra
becomes a **trait-driven rules engine**: the rules stay floor (arbitration is floor, §13), the
vocabulary each kind speaks becomes contribution data. Two boundaries in that shape are deliberate.
The canvas operation is **not** declared in the manifest: it stays a floor table the algebra
consults (`CANVAS_OPS`), because letting a plugin name the operation a canvas performs on its kind
would move an arbitration decision into a party's manifest. And container-site discipline stays a
container's business — an element declaring `discipline-match` is refused. Omitting `placement`
entirely means the engine's default traits, so the simplest element contribution is unchanged. The
refusal shape is untouched, which is the whole point of doing it this way: `not_accepted` still names
the rule that refused, and `verify:tile-drop` still exercises the same algebra through real gestures.

The engine already closes half the loop: `composeRoster` resolves each element contribution's
`placement` into the element registry, defaulting to `DEFAULT_ELEMENT_PLACEMENT_TRAITS` when it is
absent. Every composed element kind therefore has resolved traits **today**, and what the conversion
batch changes is the algebra's consumer — reading traits from the registry instead of the closed
table — not the contract plugins were written against. That is the difference between a seam and a
promise.

This decision designed the schema in the protocol, because the schema is what the conversion
consumes when `core.canvas`, `core.notes` and `core.compositions` take ownership of their kinds. The
compiler carried the proof that the traits are complete: `ITEM_KINDS` is typed
`satisfies Record<string, PlacementTraits>`, so the closed union's rows and a plugin's declaration
are the same type, and nothing about a kind can live outside the traits without breaking the build.

The fusion has since landed, and it kept every boundary this section drew. `ITEM_KINDS` and
`CANVAS_OPS` now hold FLOOR kinds only (`terminal`, `canvas-pad`, `view`, `tile`, `panel`; the
`text` and `draw` rows are deleted), `PlacementItem.kind` and `CensusItem.kind` are open strings,
and resolution reads `ITEM_KINDS[kind] ?? lookup.itemTraits(kind) ?? DEFAULT_ELEMENT_PLACEMENT_TRAITS`.
A non-floor kind's canvas op is `move_element`, decided by `canvasOpFor` — still a floor table,
never manifest data. `ITEM_KIND_NAMES` is gone with the closed enumeration it served: no schema
enumerates kinds any more.

NeoForge's registry discipline is the caution to carry: registration happens in a lifecycle window
and "Query operations are only safe to use after registration has finished. DO NOT QUERY REGISTRIES
WHILE REGISTRATION IS STILL ONGOING!" manifold's equivalent is that trait tables are composed once
per roster commit and read as immutable data thereafter — the composition is the freeze.

### 13. The foundation litmus test (C9)

The draft proposed enforcing the floor boundary by scanning floor files for plugin-domain nouns
(machine, pad, folder, terminal, stroke, token, cursor). Contract v2 refuses that mechanism and keeps
its goal. No platform enforces module boundaries lexically, and the failure modes are symmetrical: a
transport file whose comment says "e.g. a terminal" fails the gate, while a genuinely domain-owning
file that carefully avoids the word passes it. A gate that can be beaten by renaming a variable is a
gate that lies, which is the same objection ADR 0010 recorded against regex import scanning.

Enforcement stays **structural** — the TypeScript-parser import-boundary walk (S2), registry
liveness (S6), the route allowlist (S7), and element-kind coverage (S8) — plus the operator's
ratified requirement that the ownership map be **exhaustive**: every file above the packages the
engine itself ships matches exactly one owner, floor or a named plugin, with no unowned residue. The
`stroke.ts` hole found by the floor audit (plugin-domain geometry in `packages/web/src`, absent from
the floor registry entirely, therefore invisible to both S2 and S6) is exactly what exhaustiveness
catches and what a noun scan would have missed.

What replaces the noun scan for _human_ judgement — the question "should this be floor?", asked
whenever a registry edit is proposed — is a three-part **admission test** plus one **obligation**.
Both are law in `AXIOMS.md` §Foundation law; this section is the reasoning behind them.

A pillar is admitted to the foundation if and only if it passes **all three**:

1. **Bootstrap circularity.** Plugins presuppose it. If it had to be a plugin, some plugin would
   have to load before the loader or render before the renderer — the test §10 applies to the
   enablement door and §4 applies to the placeholder.
2. **Neutrality.** Zero domain nouns, no favourite plugin: it would be unchanged if every plugin in
   the tree were replaced by different plugins. It knows contribution _kinds_ (panel, section,
   element, tool) but never which ones exist; it speaks the vocabulary, never the words.
3. **Arbitration.** It referees between plugins where no plugin could be trusted to referee —
   collisions, ordering, ownership reservation, capability intersection, placement legality — and an
   arbiter cannot be a party. This is why composition, the denial ladder, the placement rules engine
   (§12) and `auth.ts` are floor while everything they arbitrate over is not.

Failing any one means it is a plugin. There is no partial credit and no third state.

The fourth property is not a criterion but a **duty the foundation owes**, because being floor
grants no privilege and imposes visibility: **self-description**. Every engine door is a builtin
roster row described by the same manifest shape as a plugin's (§10); every dispatch is one
structured log line; every registry is machine-readable and read in both directions. Floor that
cannot be read as data is floor that A3 cannot onboard against, and an unauditable foundation is
indistinguishable from the privileged core A1 denies exists.

The mechanism stays what it was: the litmus is what a floor-addition ADR must argue, criterion by
criterion, and the gates are what cannot be talked around. `REGISTRY.md` carries the **pillar
inventory** as a machine-readable registry — one entry per pillar with its globs, the criteria it
passes, its verdict and its justifying ADR — and `verify:axioms` checks exhaustiveness against it:
every floor file falls inside exactly one pillar's globs, most specific glob winning, and anything
unmatched is RED.

One field dies with this ruling: the floor registry's `"until": "<plugin>"` tag. It named a third
state — floor today, plugin tomorrow — and a third state is exactly what the litmus denies. Under
total conversion the tagged rows are the work, not the vocabulary, so the tag is removed from the
registry schema and leaves with the last row that carries it. Deferral remains legitimate as a
statement about effort (`AXIOMS.md` §Change control); it stops being expressible as a property of
a file.

### 14. Floor rulings

Three boundary questions the audit surfaced, ruled once here so the conversion batch does not
re-litigate them per file. All three have the same shape — **mechanism is floor, the verb is a
plugin** — which is §13's litmus applied rather than a new principle.

**Placement: the algebra is mechanism, the verb is a plugin. `core.layout.place` supersedes
`POST /api/place`.** The rules engine, the legality data and the executor stay floor: they arbitrate
between kinds no single plugin owns (litmus 3), and they are neutral over which kinds exist once §12
lands (litmus 2). The _door_ is not mechanism. `POST /api/place` is a bespoke feature route that
predates the action door, and keeping it means two doors onto "place a thing" — one with a published
action vocabulary, capability declaration, `data-action` traceability and a denial ladder, one
without. Invariant 14 gives that exactly one reading. `core.layout.place` is the action; the route is
deleted in the same change, with every caller migrated (D13: no aliases, no dual paths). The denial
vocabulary does not fork — the placement rule that refused is carried in the action's `refused`
denial, so `not_accepted` keeps one wording.

**Terminals: policy is a plugin, bytes are floor.** The PTY broker, the attach state machine, the
viewer registry, the no-gap invariant and the byte frames (`terminal_input`, `terminal_resize`,
output) are floor — a plane transport by the §Foundation criterion, and neutral over what runs in the
shell. The **policy verbs** are `core.terminals`: whether a terminal may be created here and now, by
whom, on which machine, what a rename means, what a kill means, and what survives a disable (D12).
The concrete debt this ruling names is the composition-enablement check for `terminal_open` currently
living inside `session-ws.ts` — floor code consulting `composition.enabled("core.terminals")`, which
is floor code holding a plugin's policy. It moves behind a plugin-owned decision; the transport keeps
moving bytes and stops knowing why.

**Identity: the mechanism is floor, administration is `core.access`.** Token hashing, principal rows,
the capability intersection at the door, and `auth.ts` as the future A5 evaluator seam are floor by
every part of the litmus — nothing loads without them, they are neutral over plugins, they arbitrate,
and they publish their vocabulary. The **administrative verbs** — mint a token, create a principal,
revoke — are a plugin, `core.access`, over that mechanism. The conversion inventory
(`REGISTRY.md` §Full-conversion inventory) currently
schedules `core.access` for the permission-waterfall wave, and the floor audit read that as correctly
deferred. Under total conversion the two halves separate: the _evaluator_ (ADR 0011, grant rows,
`effectiveCaps`) stays a later wave, and the _administration routes_ convert now, because "identity
mechanism is floor" does not make "POST /api/tokens" mechanism. A grant UI arriving later is a plugin
gaining contributions, not a floor extraction repeated.

### 15. Conversion never narrows who may call a door (`scope` on the action)

Total conversion moves every remaining door onto the action plane, and that collided with a rule
written when the plane held only administrative verbs. ADR 0010 rule 6 made actions
workspace-grade — dispatch rung 3 refuses `padScope !== null` before capabilities are even
consulted — with `POST /api/place` as its precedent: a placement moves items between containers, so
a token scoped to one container can never authorize it. Applied unchanged to the doors being
converted, the same rung silently revokes access that exists today. Reads first: `GET /api/pad-tree`
filters to the scoped pad plus its ancestor folders, `GET /api/machines` and `GET /api/pad-sessions`
answer scoped tokens, and the roster and layout reads were already carved out by hand for exactly
this reason ("the roster is vocabulary and scoped viewers still render UI"). But not only reads:
`POST /api/tokens` authenticated any token, so a pad-scoped agent holding `tokens:mint` could mint a
further-attenuated token inside its own container — which is how a terminal agent delegates to a
sub-agent — `PATCH /api/pads/:id` authorized `pads:write` AT the named pad, and the session
channel's own terminal verbs have always been reachable by the pad-scoped token minted for that
terminal.

A principal who can no longer do through the new door what their grant already let them do through
the old one has lost a capability. That is an A2 and A5 outcome, not a conversion detail, so the
rule is stated as parity rather than as a taxonomy of verbs:

**`ActionDef` gains `scope: "workspace" | "pad"`, defaulting to `"workspace"`.** Rung 3 refuses a
pad-scoped caller only when the action's scope is `workspace`. **An action declares `scope: "pad"`
if and only if the door it replaces was reachable by a pad-scoped token** — whether it reads or
mutates. Everything owner- or workspace-only keeps the default, and `POST /api/place`'s successor
keeps it too, because a placement genuinely spans containers.

`scope: "pad"` carries an **obligation on the handler**, and the division of labour is exact: the
ladder proves the caller's declared caps hold for the caller's OWN pad, and only a handler can ask
whether the thing named in the arguments lives there. So a pad-scoped `renamePad` naming another
container is refused inside the handler, a pad-scoped session read answers that container's rows and
learns nothing about another, and a mint may not widen its minter's scope.

The obligation is discharged **once, by the engine**: `ctx.outsideScope(padId)` returns the
canonical refusal (`OUTSIDE_SCOPE_REFUSAL`, "outside this token's container") when the caller's
scope excludes that pad and `null` when dispatch may proceed. That it is one call rather than a
per-plugin convention was learned rather than assumed: the first pad-scoped handlers to land had
three wordings for one concept — a shared local helper in one plugin, two differently-phrased
hand-rolled checks in another — which is invariant 14 with the seams showing, and a client cannot
switch on prose. Two decisions are baked into the shared call so no plugin re-litigates them: the
refusal does **not** name the target pad (telling a scoped caller the id of a container it may not
reach is a disclosure the refusal does not need), and a **null** pad is refused for a scoped caller
while passing for a workspace-grade one (authority cannot be proven against a container nobody
named).

Two other discharges stay legitimate, and they are **not interchangeable with the first** — this is
the loophole the rule has to close in writing, because "the mechanism handles it" is what a future
author will reach for:

1. **Handler discharge** — `ctx.outsideScope(padOfTheThingNamed)`. REQUIRED whenever the arguments
   name a pad-addressed node: a session, an element, a folder, a layout, a pad.
2. **Mechanism discharge** — legitimate ONLY when the mechanism refuses on the CALLER'S OWN SCOPE.
   The identity mechanism qualifies: it refuses a mint that widens its minter's pad scope and
   confines a scoped revocation to that pad's tokens, both by reading the caller's `padScope`.
   **A mechanism discharges the obligation only if it refuses on the caller's own scope;
   validating the argument is not confining it.** A check that only asks "is this well-formed" or
   "does this row exist" discharges nothing, and calling it a discharge is how a door quietly
   becomes reachable across containers.
3. **Vacuous** — nothing in the answer is addressed by pad, as with a fleet-wide machine list. The
   reason MUST be a comment on the handler, or the next reader adds a filter and breaks
   share-link viewers; and any other door in that plugin whose arguments name a pad-addressed node
   owes path 1 regardless.

Three properties make this a narrowing of rule 6 rather than a hole in it. It is **declarative**, so
a reviewer sees a door's audience in the definition instead of inferring it from a handler; it is
**the same shape as `cleanup: true`** (§9) — a declared, published, gate-visible carve-out from one
rung, not a second ladder; and it **cannot widen authority**, because rung 4's capability
intersection still runs and a pad-scoped token still carries only its own caps. What it buys is that
a token whose grant already covers a node may reach a door about that node, which is precisely the
degenerate case ADR 0011's evaluator will express as a subtree grant — arriving early where the
mismatch was doing damage.

ADR 0010 rule 6 is therefore narrowed to **workspace-graded doors specifically**: an action that is
genuinely about the workspace refuses scoped callers, and R8 keeps proving it on
`engine.plugins.setEnabled`. What it no longer claims is that every action is workspace-grade by
nature.

### 16. The scene element envelope: the protocol stops naming element types (addendum 2026-08-31, #69 wave F)

This clause is dated because it is a later ruling on a shipped shape, not a rewrite of the record
above. Everything §7 says about element-type OWNERSHIP stands unchanged; what changes is who owns
an element's PAYLOAD.

**The defect.** `SceneElementSchema` was a `z.discriminatedUnion("type", …)` over three members —
`portal`, `text`, `draw` — sitting in `packages/protocol/src/**`, a pillar whose admission verdict
reads "the vocabulary every plane speaks … it names no plugin" (`REGISTRY.md` §Pillar inventory). Those
three names are `core.canvas`'s, `core.notes`' and `core.draw`'s respectively, and the neutrality
criterion is not a style preference: it is the second of three litmus criteria, and failing any one
means the thing is a plugin. The union also had a harder consequence than an unclean registry. A
`type` the union did not list was REFUSED by the wire schema, so a scene document could not hold a
record whose owning plugin was merely absent from this build — which is exactly the outcome §4
forbids for panels and sections ("data untouched; renders the engine placeholder"), arriving through
the document plane instead of the layout plane and therefore never noticed.

Everything needed to fix it already existed. `contributes.elements` publishes a kind's `type`, its
`title` and its `placement` traits (§12); `assembleRoster` reserves the type name against its
declaring plugin and keeps the reservation across a disable (§7); `itemTraitsFor` already resolves a
kind the assembly never heard of to `DEFAULT_ELEMENT_PLACEMENT_TRAITS` rather than refusing it. The
payload was the one part still hardcoded, and it was hardcoded in the one package that may not know
a plugin's name.

**1. The protocol publishes an ENVELOPE, not a union.** The envelope is the geometry every renderer,
every placement rule and every fingerprint already reads without caring what the record means:
`id`, `type`, `x`, `y`, `width`, `height`, `zIndex`. `type` is a bounded string, not an enum. Every
other key in the record is PAYLOAD: carried, bounded, persisted, synced — and unread by the floor.

**2. The payload stays FLAT.** It is not nested under a `payload` key, and the reason is the
strongest argument in this clause. Nesting is a document rewrite, not a protocol edit: every element
that exists today lives in a `Y.Map` whose keys are exactly these fields, `ScenePatch` patches them
by name, and migration 9 is this repository's own evidence that rewriting stored Yjs documents is
the expensive and dangerous class of change — one that must convert every revision of every
document, because a room's fallback loading walks back through older revisions. Nesting buys nothing
that a reading discipline does not already buy. So the schema LOOSENS (`z.looseObject`) and the
envelope/payload split becomes a rule about who may read a key rather than a change to where it is
stored. The property that makes this an opening rather than a migration: **every document on disk
validates unchanged the day this lands.**

**3. Bounded, because a loosened schema without bounds is a blob channel.** The ceilings are the
union of the ceilings the three retired members carried, so nothing that validated yesterday stops
validating: at most `MAX_ELEMENT_PAYLOAD_KEYS` payload keys; every value a JSON scalar or an array
of them at depth one — no object graphs, no nesting, nothing that can carry a second document
inside a record; a string at most `MAX_TEXT_LENGTH`; an array at most `MAX_STROKE_POINT_VALUES`
values. A record that breaks a bound is not a record with a large field, it is a refusal.

**4. Per-type payload schemas move to the owning plugin's element REGISTRATION** — `PluginDef`,
never the manifest, because manifests stay inert data (ADR 0010 rule 2) and a Zod schema is code.
The registration carries `payload`, the assembly collects it onto `AssemblyElement.payload` exactly
as it already collects `placement`, and a contribution that declares no payload schema declares that
its records carry no payload the engine should police — the same "absence is a real declaration"
shape as `dormant` in §4.

**5. Validation happens at ONE boundary, in the shape actions already use.** An action's arguments
are validated where the assembly is in hand, at the door, and answer a named denial rather than a
throw; an element's payload is validated the same way at the element-host/scene boundary. The
assembly holds the schema, the boundary parses, and a malformed payload for a KNOWN type is refused
there. Two properties follow, and both are the point of putting it at a boundary instead of in the
wire schema. A stranger type — one no registration claims — passes, because there is no schema to
fail and the envelope's bounds already held. A known type with a malformed payload is refused at the
door that could name the offender, which is strictly more useful than a discriminated union's
"matched no member".

**6. Collaborative text becomes structural instead of nominal.** The scene pillar's last domain noun
was in `writeElement`: `if (element.type === "text") map.set("text", new Y.Text(element.text))` —
the floor asserting both a plugin's type name and a plugin's field name. It splits by who actually
knows. A CREATOR declares which payload fields are collaborative when it writes a new element, and
the creator is the owning plugin, the only party that knows. A RE-WRITE of an existing element
derives them from the document: the payload fields whose stored value is already a `Y.Text`. So the
floor's re-write sites — repoint, move, adopt across documents — preserve collaborative text without
naming a field, and they preserve it for a stranger plugin's collaborative field exactly as well as
for `core.notes`'.

**7. What the floor still knows, stated rather than smuggled.** `packages/server/src/placement.ts`
resolves "a portal places the container it points at" by reading a payload field by name. That
predates this clause — the file's own comment already flags it as the last per-kind arm — and the
neutral form is a DECLARED REFERENCE TRAIT on the element contribution, saying which payload field
carries a container reference, so the algebra follows the declaration the way it already follows
`placement`. That is named here as the follow-on and is deliberately NOT bundled in: it adds
manifest vocabulary, and manifest vocabulary is a protocol version's business, not an envelope's.
The envelope neither worsens nor blesses it.

**8. S8 keeps checking the type-name subset, from the other end.** With no `z.literal` members left
in the protocol there is nothing in the wire schema to enumerate, so the check reads the element
REGISTRATIONS' type names and asserts they are the floor's own kinds ∪ the assembly's contributed
types. The assertion is unchanged in meaning — no element type is owned by nobody — and it now reads
it where ownership actually lives.

Three shapes were considered and refused. **Nesting the payload** under its own key: a full document
migration for a tidier record, against a flat form that already works and already validates.
**Keeping the union and adding a catch-all member**: the protocol still names three plugins' types,
and the catch-all's payload is the one member nobody bounded. **TypeScript module augmentation**, so
each plugin declares its payload type into an interface the protocol leaves empty: it compiles, and
that is the problem — augmentation is program-global, so floor narrowing would keep working in any
build whose file graph happens to reach the plugin, type safety would vary by build, and the
neutrality question would be answered by a compiler trick instead of by moving the schema.

## Alternatives rejected

- **Erase- or reset-on-disable (the draft's `retention`).** Rejected per §1: no surveyed platform
  binds destruction to a reversible verb, and manifold's disable is workspace-global, hot,
  one-click and reaches other principals' work. The capability survives as `engine.plugins.purge`
  plus `onPurge`, refused while enabled.
- **A plugin-supplied dormant renderer.** Rejected per §4: it makes the engine's rendering of an
  absent plugin depend on the absent plugin's code, which is structurally broken the day
  `entry.web` means anything. Obsidian's engine-owned `DeferredView` is the shipped answer.
- **`essential` as the cure for the plugin-manager self-lockout.** Rejected per §10: it makes a
  plugin permanently undisableable to protect a mechanism that should not have been in a plugin.
  The door moves; `essential` becomes one named refusal class among several, and `core.plugins`
  becomes ordinary.
- **VS Code's enable cascade and its `DisabledByExtensionDependency` disable cascade.** Rejected per
  §5 in both directions: in a shared workspace, a toggle whose blast radius the presser cannot see
  is worse than a refusal that names what is in the way.
- **Dependency version ranges now.** Rejected per §5: every platform that has them distributes
  plugin code independently of the host; manifold does not yet, so a range grammar would be
  compatibility machinery for an impossible case (D13). It arrives with dynamic distribution.
- **A TTL on ownership reservations (Home Assistant's 30 days).** Rejected per §7: a workspace
  reservation that expires on a wall clock expires while its owner is away, and nobody benefits from
  an element type becoming claimable again by elapsed time. Purge is the release.
- **Element-type remapping now (Forge's `REMAP`).** Deferred, not rejected: it becomes real when a
  substitute plugin may claim a core plugin's types, which is the marketplace wave (AXIOMS.md
  §Roadmap). Reservation without remapping is the safe half, and it is the half that is needed today.
- **Lexical domain-noun scanning of floor files.** Rejected per §13: unenforceable in both
  directions, and beatable by renaming. Structural import walking plus an exhaustive ownership map
  gets the operator's actual goal — no unowned code — mechanically.
- **Waiting for the wave-2 event plane to carry composition changes.** Rejected per §3: a
  notification plane cannot give an ordered, pre-broadcast, write-capable repair pass over surviving
  plugins, and Factorio's step 5 is precisely that pass. The hook is not a proto-event-plane and does
  not compete with ADR 0012; roster change becomes a declared emission there, and this stays the
  local half.
- **Keeping `POST /api/place` beside a placement action.** Rejected per §14: two doors onto one
  concept is invariant 14, and the exception's cost (no action vocabulary, no `data-action`
  traceability, a second refusal path) is exactly what total conversion exists to remove.
- **Accepting the scoped-read regression and merely documenting it.** Rejected per §15: a deferral
  may cost effort, never a capability a grant already implies, and "converted, therefore invisible
  to the principal it was for" is exactly the axiom-violating state scope is not allowed to license
  (`AXIOMS.md` §Change control).
- **Keeping converted reads as bespoke plugin-owned HTTP routes until ADR 0011's evaluator lands.**
  Rejected per §15: it preserves scoped readability by preserving a second door onto every read
  (invariant 14), and it leaves the read vocabulary unpublished — no `ActionSummary`, no schemas at
  `GET /api/protocol`, no `data-action` traceability. One declared field on the action buys the same
  outcome inside the door that already exists.

## Protocol impact

The manifest and roster additions above are protocol v15. They are session-side and HTTP-side
vocabulary — manifest fields, roster fields, the closed enums, the purge action names — and the
machine wire is untouched, so the machine-protocol compat set gains v15 additively under the
invariant-10 mechanism.

Two properties of the landed schema matter to this decision. First, **every new manifest field is
optional and absence reproduces v14 semantics exactly** (`dependencies`, `after`, `dataVersion`,
`dormant`, `purges`, and `placement` on an element contribution, whose absence means
`DEFAULT_ELEMENT_PLACEMENT_TRAITS`), so this contract adds vocabulary without invalidating a single
shipped manifest. Second, the whole vocabulary is **published as data** at `GET /api/protocol`
under `pluginContract` — the engine namespace, the source, dependency-type, dormant-mode, residual,
purge-target, lifecycle-state, refusal-reason and denial-rule enums, plus JSON Schemas for the
manifest, actions, outcomes, roster entries and purge results. That is the self-description
obligation of §13 discharged for this contract specifically: a stranger's agent reads the rules of
disable from the endpoint, not from this file. `ProtocolContract` owns the exact shapes; this file
owns the semantics they encode.

## Revisit when

Dynamic plugin distribution admits code that manifold did not compile (then §5 gains version ranges,
§7 gains Forge-style remapping, and §4's declarative dormancy stops being a discipline and starts
being load-bearing); or the second refusal class of §8 becomes implementable on a live mounted-panel
census after the presence conversion (then "in use by another principal" joins `essential`); or the
2-second lifecycle bound of §2 proves wrong in practice — in which case the number changes and the
rule that **disable always completes** does not.

---

## Correction — 2026-08-31: sections render ABSENCE, not a tombstone

The ratified D4′ table is PER-KIND: chrome (sidebar sections, toolbar tools) renders
ABSENCE while the owner is disabled; scene elements ghost; stored data is retained. During
implementation the per-kind table was mistranscribed into a universal engine placeholder,
the R3 gate check was written against that mistranscription — so the gate actively
DEFENDED the rejected design — and the operator caught the tombstone live, twice. §4's
prose above stands for elements and panels; for SECTIONS the placeholder sentence is
superseded: a disabled plugin's section vanishes from the sidebar, the Plugins section is
the one ledger of what is off, and re-enable restores the manifest-ordered slot for free.
Panels keep the placeholder-with-remove behavior TODAY because every panel contributor is
essential (the dormant-collapse target for layout leaves remains ratified and becomes
exercisable with the first disableable panel plugin — this sentence is that deferral's
in-product-adjacent marker). Process lesson, now law-adjacent: a gate check inherits the
authority of the contract it encodes — when a contract is amended, its checks amend in the
SAME change, or the gate defends the past.
