# 0025 — Plugins are mods: one execution mode, the full engine API, the installer decides

Date: 2026-09-05
Status: accepted
Ratified: by the operator, 2026-09-05, as the posture (§1, §2, §5, §6); §3/§4/§7/§8 are obligations (#253). Reverses the AXIOMS §Roadmap marketplace ordering and re-scopes ADR 0016 §1/§3 to hardened rows.

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

The living spec is the normative form of what follows; each section names the spec section that
carries it, and on disagreement the spec wins and this record is stale.

### 1. One execution mode: every plugin runs in-realm with the full engine API

Every row on the roster — `core.*`, installed from a bundle, unpacked from a directory — runs
in-realm: the web half in the page with React, all three `@manifold/plugin` entries, the real
`HostServices` (token included) and the raw DOM; the server half in the hub process with the full
`ActionCtx`. `core.*` is the set of mods bundled with the engine, and A1 already says so: "There
is no privileged 'core' mechanism: core plugins use exactly the interfaces a stranger's plugin
uses" (`AXIOMS.md:32-33`; `plugin.ts:40-43`). ADR 0010's ruling is the whole truth again, not the
first-party half of it: "The wire is the security boundary; realms are a stability boundary.
Plugins are trusted in-process code" (`0010-plugin-engine-and-action-plane.md:63-65`). The loader
that makes this true for an installed row is owed (#256); until it lands, every installed row still
runs on ADR 0016's runner and the spec says so.

Spec: `docs/CONTRACTS.md` §Hardened plugins (first paragraph); `docs/PLUGINS.md` §9 (intro).

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

Spec: `docs/CONTRACTS.md` §Hardened plugins, "The install grant".

### 5. Isolation is optional hardening; the marketplace gate is reversed

`install.hardened: true` (additive; absent ≡ false), chosen by the installer at install and by
nobody else, runs the row on ADR 0016's runner exactly as it landed: one process on the server
(`packages/server/src/isolate/`), one Worker in the browser (`packages/web/src/isolate/`), the
closed vocabulary over `render` frames (`isolate.ts:543-582`), every §2/§3 reachability rule
(`0016-plugin-isolation.md:202-240`). The web join's selector becomes `install?.hardened === true`
instead of `install !== undefined` (`plugin-host.tsx:352`) when #256 lands. It is never the
default. **The operator's call, stated as such:** the roadmap's "does not land before a dated
isolation ADR ratifies a runner ... a hard ordering rather than a preference" (`AXIOMS.md:252-253`)
is REVERSED by this record — distribution is gated on the install door, the hash pin and the
installer's reading, not on a boundary. The runner stays available because it exists and because
a row one does not trust deserves it; ADR 0016 R1/R2/R5/R8 stand for hardened rows, R9 is
reversed, and its §8 stage 1 is not undone.

Spec: `AXIOMS.md` §Roadmap, the marketplace bullet; `docs/CONTRACTS.md` §Hardened plugins;
`docs/PLUGINS.md` §9.

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

Spec: `docs/CONTRACTS.md` §Hardened plugins, "In-realm rows".

## Work this obliges

Not ratified text; each is an issue, and the spec section it edits lands with the code.

- **§3 The hub owns the mod list and distributes web halves.** The roster is the list and a
  browser already learns a row changed through `client.onPlugins` (why R3 proves hot enable with
  no reload). The loader lands beside the join: an in-realm row's `web.js` is fetched with the
  bearer and `import()`ed from a Blob URL, its `WebPluginDef` joins `WEB_PLUGIN_DEFS`, the server
  half is one `import()` in the hub. React, the `@manifold/plugin` entries, `@manifold/protocol`,
  `@manifold/sdk` and `@manifold/scene` are externals resolved through a registry under
  `globalThis[Symbol.for("manifold.shared")]` that shell and hub both populate — not an import
  map, which has no stable URL in a Vite build and would tie an instance-served bundle to
  origin-served URLs. No new dependency. #256.
- **§4 Unpacked mods and developer mode.** A directory under `<data>/authored/<id>/`, admitted
  only while root-only `engine.plugins.setDeveloperMode` is on (off: `developer_mode_off`, a named
  refusal the manager marks); the hub watches it, rebuilds with `Bun.build`, installs through the
  ONE install path with the hash pinned from the built bytes, and publishes; `engine.plugins.author
{ id, files }` writes into it, so "ask an agent, the panel appears" is one door and one file
  write. Promote = `pack` the same files. #257.
- **§7 Ink: S13 at load.** The gate's stylesheet-ownership rule at runtime: an installed or
  unpacked `styles.css` is admitted only if every selector's leftmost compound is the plugin's own
  root class (`.plugin-<id with "." as "_">`), refused `stylesheet_unscoped` otherwise; the
  selector walk leaves `verify-axioms.ts` for a module the gate and the hub share. #258.
- **§5 follow-up: React over frames.** The kit's `ui.*` builders give way to React delivered over
  the same `render` frames by a reconciler, so one React web half runs hardened or not; the
  reconciler is one new pinned dependency and owes its invariant-8 verdict. #259.
- **§8 What a plugin must honour, and the design system.** Nothing new to honour — manifest,
  ladder, D4′, `data-action`, registration channels, layout algebra, §7's stylesheet rule, the
  gate. The design system leaves `packages/plugin/src` as `@manifold/ui`, dogfooded by the shell
  and every `core.*` panel, imported by every mod; the hardened renderer serializes the same
  components. The roster becomes `install: { mode: "bundle" | "unpacked", hardened: boolean,
sha256, source, grantedCaps, installedBy, installedAt, refusal? }`, both new fields additive. #240.
- **The guide.** `docs/PLUGINS.md` §10 "Authoring a plugin on your instance"; §9 re-scoped in
  full to hardened rows. #260.

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

## Tensions

Resolved by the ratification, in the spec each names.

- **ADR 0016 §1-§3 letter.** Every sentence that assumed installed ⇒ isolated — §1 (`:196-200`),
  §3 in full, `plugin.ts:772-778`, `plugin-host.tsx:345-352`, `docs/PLUGINS.md` §9 — now describes
  a row installed with `hardened: true`. R1, R2 and R5 stand for hardened rows; R9 is reversed;
  R3 (async storage, #215) and R8 (hash pin, fail-closed) stand for every row. 0016's `Ratified:`
  line records the re-scope; its body is untouched.
- **`AXIOMS.md` §Roadmap.** The marketplace bullet's "hard ordering" and "prerequisite is
  discharged" sentences are replaced by the ratified posture naming this ratification; the agent's
  plugin story row points at #257 instead of calling itself a consumer of the isolation runner.
- **ADR 0010 rule 3, 0016 T1, A3.** `HostServices` has ONE shape for in-realm rows, token
  included; the narrowed shape and 0016 T3's two-class narrowing apply only to a row the
  installer hardened, and §4 is A3's fullest expression.
- **Invariant 16, S16, invariant 8.** "Mod" is this record's frame, not a lexicon term — the word
  stays `plugin` everywhere outside this file; the loader and registry land in `packages/web/src`
  and the hub, never in `packages/plugin/src`; §3 and §4 add no dependency and the reconciler
  (#259) is gated on its own verdict.
- **0016 T5/T6, dialled guests.** §Consequences (c), carried by `docs/CONTRACTS.md` §Hardened
  plugins.

## Consequences

- **(a) Sunk cost.** Stage-1 isolation — the server runner and install doors (#231), the Worker
  half and vocabulary renderer (#232), the end-to-end proof (#237), the kit's `ui.*` builders —
  becomes an option most installs will not use. The interim `atyrode.code` and `atyrode.babel`
  plugins, written against the vocabulary, are rewritten in React when #256 lands. The hash pin,
  the install door and the refusal ladder stay for every row; nothing about admission loosens.
- **(b) Version coupling.** An in-realm mod imports React and the floor packages as externals, so
  a hub upgrade can break an installed mod in a way a self-contained hardened bundle cannot. The
  row records what it was built against and the manager surfaces incompatibility — an obligation
  appended to #238, since that is where updates are designed.
- **(c) Guests.** A dialled guest's browser runs the host's in-realm mods with the guest's token
  for THAT hub — no authority beyond what the hub already holds for that principal, and nothing
  that reaches the guest's own instance. `docs/CONTRACTS.md` §Hardened plugins carries the
  sentence; `docs/SELF-HOST.md` §Security posture owes one pointing at it when that file is next
  edited.

## Revisit when

- Manifold hosts strangers on a shared instance rather than a fleet for oneself: §5's default
  flips and 0016's gate returns, by a dated record.
- The reconciler lands and a first-party plugin passes R3 both ways: `ui.*` is deleted.
