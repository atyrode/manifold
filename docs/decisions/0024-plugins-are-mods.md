# 0024 — Plugins are mods: one execution mode, the full engine API, the installer decides

Date: 2026-09-05
Status: **PROPOSED** - drafted by an agent on the operator's direction, 2026-09-05; reverses the
`AXIOMS.md` §Roadmap marketplace gate and amends ADR 0016 §1/§3 letter where it assumed
installed ⇒ isolated; nothing here is ratified.

## Context

The operator's direction, verbatim: "I hope this doesn't imply that a plugin can't write on-the-fly
React, because I sure hope it can and it must. The experience I envision is that you can create a
plugin of your own ... temporary/scratch plugins made by the user, that they might host later as a
real plugin or not ... write a plugin in Manifold by asking an agent, and the plugin gets written
and deployed on their instance LIVE, not even needing a page reload, the engine detects a new
plugin, which can be anything and even write custom react if it needs to, as long as the plugin
respects the API Manifold needs to load it and use it ... the ideal experience of manifold is that
you can mutate your own interface in real time." And the frame that settles the question: manifold
is a game engine with multiplayer and MODS, self-hosted for one's own fleet; a plugin has the FULL
engine API, never a dumbed-down one; the person who installs a mod is expected to read what they
install.

What landed says the opposite for anything not compiled into the build. ADR 0016 §1 selects the
runner by roster data — "an installed row runs isolated" (`0016-plugin-isolation.md:196-200`) —
and §3 withdraws the DOM, React, `@manifold/plugin`, `HostServices.token` and the Yjs handle from
that row (`:219-240`); the protocol says the same in its own words: an `install` block means "a
stranger's code running isolated" (`packages/protocol/src/plugin.ts:772-778`), and the browser's
join resolves every installed panel to the Worker renderer (`packages/web/src/plugin-host.tsx:352`,
`:358-359`). The isolated authoring target is a program over thirteen node kinds
(`packages/protocol/src/isolate.ts:51`; `docs/PLUGINS.md:1585-1610`): it can never be React.
`AXIOMS.md:252-253` makes that the law for distribution: "It does not land before a dated
isolation ADR ratifies a runner, and that is a hard ordering rather than a preference."

The shipped mod systems that manifold's frame names do not work this way. None of them dumbs down
the API for a third party; each puts the decision with the player who installs:

- **Emacs** — "a real-time display editor which can be extended by the user while it is running",
  in the same language the editor is written in
  (<https://www.gnu.org/software/emacs/emacs-paper.html>). Everything in-realm, runtime-mutable.
- **Factorio** — Lua mods in-process against the full runtime API; `info.json` carries `name`,
  `version`, `dependencies` with hard (`mod-a`), optional (`? mod-c > 0.4.3`) and incompatible
  (`! mod-g`) edges that decide load order
  (<https://lua-api.factorio.com/latest/auxiliary/mod-structure.html>). Multiplayer: "All game
  instances need the installation of exactly the same game-versions and mods", and "Mod checksums
  are calculated when the game starts and are compared with other peers when joining"
  (<https://wiki.factorio.com/Multiplayer>) — the SERVER's list is the list.
- **Minecraft (Fabric)** — in-process JVM mods; `fabric.mod.json` is "authoritative": an `id`
  (`^[a-z][a-z0-9-_]{1,63}$`), `depends`/`breaks` version ranges, `main`/`client`/`server`
  entrypoints, and `mixins` that patch the game's own classes
  (<https://wiki.fabricmc.net/documentation:fabric_mod_json_spec>). The API is the game.
- **Garry's Mod** — "The server will download the collection at startup and mount all the
  downloaded addons"; maps and the gamemode are "marked for download by clients"; and
  `host_workshop_autoupdate 0` exists because "addons might be updated to contain malicious or
  otherwise unwanted changes" — the operator's call, not the engine's
  (<https://wiki.facepunch.com/gmod/Workshop_for_Dedicated_Servers>).
- **Roblox** — Luau, "a fast, small, safe, gradually typed embeddable scripting language", runs
  in-process on a server that "is the ultimate authority for maintaining the game's state" and
  replicates to every client (<https://create.roblox.com/docs/luau>,
  <https://create.roblox.com/docs/projects/client-server>).
- **Obsidian and Chrome, for the live loop** — Obsidian community plugins are in-realm JS, hot
  enabled, developed by writing `main.js` into the vault and reloading, the warning stated rather
  than engineered away: "When developing plugins, one mistake can lead to unintended changes to
  your vault ... Always use a separate vault dedicated to plugin development"
  (<https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin>). Chrome: "Enable Developer
  Mode ... Click the Load unpacked button and select the extension directory" — unpacked is a
  folder you edit, reloaded live, and the MODE is the switch, not a property of the code
  (<https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world>).
- **The one that isolates, for what it costs** — Shopify checkout UI extensions "run in an
  isolated sandbox", "inside of a Web Worker which doesn't have access to `window` or the DOM", and
  "are limited to specific UI components and APIs that are exposed by the platform", mirrored by
  remote-dom (<https://shopify.dev/docs/api/checkout-ui-extensions>,
  <https://github.com/Shopify/remote-dom>). Right for code a merchant never reads on a page a
  buyer pays on; it is what ADR 0016 built, and this record keeps it — as an option.

Evidence below was read from source at `main` (`608db96`) on 2026-09-05.

## Decision

### 1. One execution mode: every plugin runs in-realm with the full engine API

Every row on the roster — `core.*`, installed from a bundle, unpacked from a directory — runs
in-realm: the web half in the page with React, all three `@manifold/plugin` entries, the real
`HostServices` (token included) and the raw DOM; the server half in the hub process with the full
`ActionCtx`. `core.*` is the set of mods bundled with the engine, and A1 already says so: "There
is no privileged 'core' mechanism: core plugins use exactly the interfaces a stranger's plugin
uses" (`AXIOMS.md:32-33`; `plugin.ts:40-43`). ADR 0010's ruling is the whole truth again, not the
first-party half of it: "The wire is the security boundary; realms are a stability boundary.
Plugins are trusted in-process code" (`0010-plugin-engine-and-action-plane.md:63-65`).

### 2. The capability ceiling is a declaration for visibility; the installer reads it

A manifest's `capabilities` is the mod's "requires" list. At `engine.plugins.install` the manager
shows it beside every door the plugin publishes with the caps each needs (`ActionSummary`, as ADR
0016 §5 already specifies, `:265-266`), and the installer says yes or no. The mechanism stays
exactly today's: `grantedCaps` on the row (`plugin.ts:740-749`), the default `declared` minus
`*`/`tokens:mint`/`plugins:manage` (`packages/server/src/plugin-host.ts:250-254`, `:267-276`),
intersected at rung 4 before the caller's caps. It is harmless and honest about what it governs:
DOORS, never code — an in-realm plugin holds the process; the grant decides which of its doors
anyone can dispatch. ADR 0016 read Zed's wildcard-granted default as "an honesty mechanism, not
enforcement" (`:149-153`). For a self-hosted fleet operated by someone who reads what they
install, honesty IS the mechanism: the hub's list is the only list, every grant is on the roster
for every principal (A2), and the row that lies is the row the operator removes.

### 3. The hub owns the mod list and distributes web halves to every browser

The roster is the list (`GET /api/plugins`, the `plugins` frame), and a browser learns a row
appeared, changed or was toggled the way it does today — `client.onPlugins(publish)`
(`plugin-host.tsx:821-823`), a digest-guarded state bump (`:744-749`) and the `useMemo` that
rebuilds `buildBrowserAssembly` (`:834-837`), which is why R3 proves hot enable/disable with no
reload (`REGISTRY.md:2161`). This record adds the LOADER beside the join: a row with `entry.web`
whose runner is in-realm is fetched from `GET /api/plugins/:id/web.js` (`plugin-host.ts:1412-1420`,
served only while enabled, tagged with its pin) with the bearer and `import()`ed from a Blob URL —
the exact shape the Worker factory already uses because a module cannot carry an `Authorization`
header and a token may never ride a URL (`packages/web/src/isolate/worker-host.ts:66-84`). The
module's default export is a `WebPluginDef` (`plugin-host.tsx:124-174`); the loader holds loaded
defs as state and hands `WEB_PLUGIN_DEFS ∪ loaded` to the join, so a new row's panels appear in
every open browser without a reload and a disable drops the def (D4′ unchanged: contributions stay
registered, tagged `enabled: false`, `:92-95`). Factorio's "exactly the same mods" is the roster's
`install.sha256`, re-verified at boot (0016 R8, kept) and returned with the bytes.

**Shared modules: a registry, not an import map.** A plugin bundle imports `react`, `react-dom`,
`react/jsx-runtime`, `@manifold/plugin` (all three entries), `@manifold/protocol`, `@manifold/sdk`
and `@manifold/scene` as EXTERNALS — one React (`packages/plugin/package.json` pins `react` as a
peer at `19.2.8`; `packages/web/package.json` ships it). Proposed: a module registry. One floor
module in `packages/web/src` imports the seven names through the shell's own graph (so they ARE
the shell's instances) and publishes them under `globalThis[Symbol.for("manifold.shared")]`; the
hub's build rewrites every shared specifier into a read of that registry, so the emitted bundle
carries no bare specifier and loads with a plain `import()`. Why not an import map:
`packages/web/index.html:21` carries none, and Vite's default build emits `react` inside a
content-hashed chunk (`vite.config.ts:101-104` sets no `rollupOptions`), so no stable URL exists
to map to — making one means externalizing React from the shell build, folding a vendor entry into
the `sw.js` shell cache (`:63-71`), and dev (`/node_modules/.vite/deps/…`) and prod URLs that
differ; an import map must precede the first module script, freezing the shared set in HTML; and
the portable lens — the shell is served by one origin, a bundle by the INSTANCE (`index.html:6-12`,
`instanceUrl`) — would tie an instance-served bundle to origin-served URLs. The registry is
origin-free and it is the SAME mechanism on the server: the hub populates the same symbol, so a
server half is one `import()` in either realm (invariant 14: one way to share a module). No new
dependency (invariant 8): `Bun.build` plugins resolve the names at pack time.

### 4. Unpacked mods and developer mode

An UNPACKED mod is a directory the operator or their agent writes to, `<data>/authored/<id>/`
(`manifest.json`, `web.tsx`, `server.ts`, `styles.css`, …), admitted only while the hub's
**developer mode** is on — a root-only engine door, `engine.plugins.setDeveloperMode { on }`,
persisted as a workspace meta row and published on the roster response so agents and humans read
the same switch (A2). Off, every unpacked row is refused enable by name (`developer_mode_off`, a
`PLUGIN_REFUSAL_REASONS` member, `plugin.ts:684-697`) and the manager marks it, as Chrome marks an
unpacked extension. The loop: the hub watches the directory (`node:fs` `watch`, no dependency),
rebuilds with `Bun.build` — `web.tsx` for the browser with §3's shared externals, `server.ts` for
Bun the same way — installs the result through the ONE install path (`plugin-host.ts:1230-1331`:
hash pinned from the built bytes, `replace` semantics, rollback on an `AssemblyError`), and
publishes; §3 does the rest. A rebuild remounts the plugin's panels and their state is lost;
state-preserving HMR is a later refinement. The server half is replaced in-realm: disable hooks, a
fresh `import()` under a cache-busting query, reassemble, fan out — the old module stays in memory
until the process restarts, a cost developer mode accepts. The authoring door,
`engine.plugins.author { id, files }` (root only), writes into that directory and triggers the
same rebuild, so "ask an agent, the panel appears" is one door and one file write. "Promote" =
`pack` the same files into a bundle and install it; or keep it unpacked forever. Same code.

### 5. Isolation is optional hardening; the marketplace gate is reversed

`install.hardened: true` (additive; absent ≡ false), chosen by the installer at install and by
nobody else, runs the row on ADR 0016's runner exactly as it landed tonight: one process on the
server (`packages/server/src/isolate/`), one Worker in the browser (`packages/web/src/isolate/`),
the closed vocabulary over `render` frames (`isolate.ts:543-582`), every §2/§3 reachability rule
(`0016-plugin-isolation.md:202-240`). The web join's selector becomes `install?.hardened === true`
instead of `install !== undefined` (`plugin-host.tsx:352`). It is never the default. **The
operator's call, stated as such:** the roadmap's "does not land before a dated isolation ADR
ratifies a runner ... a hard ordering rather than a preference" (`AXIOMS.md:252-253`) is REVERSED
by this record — distribution is gated on the install door, the hash pin and the installer's
reading, not on a boundary. The runner stays available because it exists and because a row one
does not trust deserves it; ADR 0016 R1/R2/R5/R8 stand for hardened rows and its §8 stage 1 is
not undone. Follow-up: the kit's `ui.*` builders are deprecated in favour of React delivered over
the same frames by a reconciler (the remote-dom shape), so one React web half runs hardened or
not — ADR 0016 §8.1's "first-party plugin running both ways" (`:306-310`) made natural; that
reconciler is one new pinned dependency and owes its own invariant-8 verdict.

### 6. The failure model: a mod degrades its own row, and can take the hub down

A panel that throws is caught at the outlet by the boundary the shell already has
(`packages/web/src/error-boundary.tsx:19-27`) and painted as the engine's placeholder naming the
plugin; a web module that fails to `import()` degrades the row on THAT browser only — "a browser's
failure is not something the server knows" (`worker-host.ts:35`). A hook that throws is
`enable_failed`/`disable_failed` on the roster (`plugin.ts:638-658`; ADR 0013 §2), and the disable
always completes. A server half that corrupts the process or loops forever takes the hub down, and
this record says so the way Obsidian does rather than pretending a boundary it did not build: the
operator installed it, the trace ledger names every door it opened (ADR 0018), the remedy is
`uninstall` or `hardened: true`, and a crash is a restart with the row's `lifecycle` saying why.

### 7. Ink: S13 at load for every non-core stylesheet

S13's static rule — "every selector family in every stylesheet under `packages/` resolves to a
§Lexicon `cssFamilies` row, and every rule is defined by the owner of the leftmost family it scopes
into" (`REGISTRY.md:2154`; `scripts/verify-axioms.ts:1633-1638`) — cannot see a stylesheet that is
not in the tree. Its runtime twin, for an installed or unpacked plugin's `styles.css`: the hub
admits the sheet only if the leftmost compound of EVERY selector is the plugin's own root class,
`.plugin-<id with each "." as "_">` (`acme.counter` → `.plugin-acme_counter`; `_` because a segment
may contain `-` but never `_`, `PLUGIN_ID_PATTERN` `plugin.ts:22`, so two ids never share a root),
and a classless rule is refused outright (`:1640-1641`). An unscoped selector refuses the install
or the enable by name — `stylesheet_unscoped`, a lifecycle refusal — so a second writer for a
shell family is impossible by construction, not by review (`AXIOMS.md:337-343`). This is ink
ownership, not security: it binds `core.*` too, whose sheets S13 checks in the tree already
(`docs/PLUGINS.md:89-109`). The selector walk (`splitTop`, `anchorOf`, `everyCompound`,
`verify-axioms.ts:1664-1701`) is lifted into a module the gate and the hub both import.

### 8. What a plugin must honour to be loadable

Nothing new: the authoring guide IS the contract. The manifest (`docs/PLUGINS.md` §2), the ladder
(§3), disable semantics and dormant modes (§4, D4′: retain, never destroy), `data-action` on every
mutating affordance (S4, `REGISTRY.md:2145`), the web registration channels and the
tile-geometry/projection contracts (§7), the layout algebra (§7b), §7's stylesheet rule, §8's gate
checks, and the design system. Today that system is scattered: components live at
`@manifold/plugin/ui` ("the plugin-facing standard library", `packages/plugin/src/ui/index.ts:1-31`)
inside the ENGINE-API package, the tokens and CSS families in the shell, and stage 1's vocabulary
renderer is a serialized subset of the same set. The operator ratified the extraction (#240): a
new package `@manifold/ui` — components, tokens, motion and layout rules — dogfooded by the shell
and every `core.*` panel and imported by every mod; three named layers then hold (SDK:
`@manifold/protocol` + `@manifold/sdk`; engine API: `@manifold/plugin`; design system:
`@manifold/ui`). Raycast's phrase for its React component set is "Think of it as a design system"
(<https://developers.raycast.com/api-reference/user-interface>), and ADR 0016's "closed,
host-owned component vocabulary" was that library seen from a Worker: with the extraction,
`ui.box` IS `<Stack>`, the hardened mode's renderer serializes the same components, and the kit's
`ui.*` builders are retired. Rules: tokens are the theming seam; a mod owns its own ink, never the
shell's (§7); components are optional, the contracts above are not. A plugin that paints with
`@manifold/ui` looks like manifold; one that draws raw DOM may, and owns the result. The extraction
is also the S16 relief the WARN line has asked for since 9,000: design-system code leaving
`packages/plugin/src`. The roster: `install: { mode: "bundle" | "unpacked", hardened: boolean,
sha256, source, grantedCaps, installedBy, installedAt, refusal? }`, `mode` and `hardened`
additive; one trust per row.

## Alternatives rejected

- **Two execution modes, remote-ui as the default for installed rows** (this record's own earlier
  draft): a Worker plus a React reconciler mirroring a component tree, in-realm only under
  developer mode. Rejected as a security tax the threat model does not justify — the operator
  installs on their own hub, for their own fleet — and kept as §5's optional hardening.
- **Three trust tiers** (`built-in` / `instance` / `isolated`): a homebrew name for what §2-§5
  say with two booleans. A tier is a property of the CODE; the decision belongs to the installer.
- **Everything isolated** (ADR 0016 §1 read literally for every non-tree row): the authoring
  target "is a different authoring target" by its own admission (`:356-359`) and can never be
  React; it kills the vision in the operator's words above.
- **A sandboxed iframe for non-tree plugins**: rejected by ADR 0016 (`:383-387`) — containment
  comes from a second origin, which the portable lens cannot demand.
- **Trust declared by the manifest**: a claim the author makes about themselves. `hardened` and
  `mode` are acts of the installer, like `grantedCaps` (0016 §5).

## Tensions with landed decisions

Flagged, not resolved.

- **T1 — ADR 0016 §1-§3 letter and its asks.** §1 "an installed row runs isolated" (`:196-200`),
  §3 in full, `plugin.ts:772-778`, `plugin-host.tsx:345-352` and `docs/PLUGINS.md:6-15`,
  `:1627-1652` all assume installed ⇒ isolated; this record re-scopes every one of them to
  `hardened: true`. R1, R2 and R5 (`:434-447`) stand for hardened rows; **R9** (`:455-456`) is
  reversed; R3 (async storage, landed #215) and R8 (hash pin, fail-closed) are kept for every row.
- **T2 — `AXIOMS.md` §Roadmap.** `:252-253` and `:264-267` state the gate as law and as
  discharged; a yes here amends both sentences in the same commit, and the agent's-plugin-story
  row (`:303-314`), which calls itself "a consumer of the marketplace's runner", becomes §4.
- **T3 — ADR 0010 rule 3 and 0016 T1.** `HostServices` has ONE shape again for in-realm rows,
  token included; the narrowed shape is the hardened runner's alone (`0016:401-405`).
- **T4 — A3.** "A stranger's agent can author a working plugin against documented interfaces"
  (`AXIOMS.md:53-61`): §4 is A3's fullest expression, and 0016 T3's two-class narrowing
  (`:410-414`) now applies only to a row the installer hardened.
- **T5 — invariant 16.** "Mod" is this record's explanatory frame, not a lexicon term: no
  identifier, selector, wire literal or heading outside this file says `mod`; the word stays
  `plugin`. A registry row is NOT proposed.
- **T6 — S16.** `packages/plugin/src` measures about 12,700 lines against the 12,800 RED
  (`verify-axioms.ts:2177-2178`). §3's loader and registry land in `packages/web/src`
  (`web-plugin-host` pillar), the server loader in `packages/server/src`, the build in the hub
  and `@manifold/plugin-kit`; only the roster fields and two refusal names touch the budget.
- **T7 — invariant 8.** §3 and §4 add no dependency; §5's reconciler follow-up adds one, gated on
  its own dated verdict.
- **T8 — 0016 T5/T6.** An in-realm mod on a wave-3 host that accepts dialled guests is the
  operator's risk to read; `docs/SELF-HOST.md` owes a sentence saying so.

## Work this obliges (filed as issues by the orchestrator)

1. `install.mode`, `install.hardened`, `developer_mode_off`, `stylesheet_unscoped` and the
   `setDeveloperMode` door — one `protocol:` commit.
2. The shared-module registry and the in-realm web loader in `packages/web/src`; the in-realm
   server loader in the hub; `pack` and the hub build rewriting shared specifiers.
3. Unpacked mods: the watched directory, `Bun.build`, the authoring door, the manager's marker
   and its third grouping (bundled / installed / unpacked — the manager redesign agent is told).
4. The S13-at-load check, shared with the gate.
5. `docs/PLUGINS.md` §10 "Authoring a plugin on your instance"; §9 re-scoped to hardened rows.
6. The React-over-frames reconciler and the `ui.*` deprecation, with its dependency verdict.

7. `@manifold/ui`: the design-system extraction (#240) — components and tokens out of
   `packages/plugin/src`, dogfooded by the shell and every `core.*` panel; the hardened renderer and
   the kit consume the same components.

## Revisit when

- Manifold hosts strangers on a shared instance rather than a fleet for oneself: §5's default
  flips and 0016's gate returns, by a dated record.
- The reconciler lands and a first-party plugin passes R3 both ways: `ui.*` is deleted.
