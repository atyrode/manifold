# 0010 — Plugin engine and the action plane

Date: 2026-08-31
Status: accepted

Lexicon addendum 2026-08-31 (#69): this record is history and is not rewritten; the names it
cites moved in the lexicon cut. The plugin-roster join is **assembly**, so `composeRoster` is
`assembleRoster` and `CompositionError` is `AssemblyError` — "composition" below always means
that join, never the tiled container discipline that now owns the word. A "pad-scoped" token is
container-scoped (`AuthContext.containerScope`), `POST /api/place` became
`core.space.place`, and the capabilities it discusses are `containers:read` / `containers:write`
/ `scenes:write` / `terminals:spawn` / `terminals:write`. Canon is `REGISTRY.md` §Lexicon.

## Context

The axioms ratified for manifold are **A1 everything is a plugin** (the engine plus core
plugins, including the sidebar and the shell itself), **A2 multiplayer by design** (every
capability reachable identically by a local human, a remote human, and an agent, over UI and
API), and **A3 moddable by design** (a stranger's agent can author a plugin against
documented interfaces). The codebase audits found no registry seams anywhere: 34 closed
kind-unions, a hand-wired server, a 2003-line shell fusing the sidebar with the engine, 8
localStorage-only state keys invisible to every other principal, and an SDK wrapping 1 of 30
HTTP routes. Nothing in the tree could answer "what can this instance do?" as data.

Adding an extension mechanism to a server-authoritative multiplayer application is not the
same problem as adding one to a single-user CLI, so three harnesses were read in source
before deciding. Evidence one-liners, each from the pinned reads recorded in the studies:

- **DeepSeek harness (`deepseek-ai/deepseek-harness`, Cordis kernel, pkgs 0.1.2-alpha.2).**
  Composition is a data file of ~90 declarative rows addressed by stable `id`
  (`packages/bundle/base/cordis.patch.yml`), which is why its roster can be diffed and
  published — but its dynamic packages are "session-scoped and process-local", and authority
  is a _mount-time_ composition fact (`disabled: true` rows, `tools.restrict()` bound at
  registration), so presence in the tree implies permission. Copy the data-addressed roster;
  refuse mount-time authority, because a plugin mounted for the owner would then be reachable
  by a scoped guest token. Its manifest also interpolates `!!js` expressions at boot —
  correct for a single-user CLI, disqualifying for a server holding other principals'
  sessions.
- **Pi harness (`earendil-works/pi` 0.84.4).** Every principal — local TUI, RPC client,
  extension — funnels into one dispatch path (`session.prompt`), which is the concrete
  mechanism behind A2; but its own core is privileged (tools are a closed union plus a
  `switch`, 23 slash commands live in a hardcoded array), extension tools silently overwrite
  built-ins by name in directory-scan order, and its uniform UI interface degrades to silent
  per-mode no-ops. Copy the single door and provenance-on-every-registration; refuse
  last-write-wins collisions and silent degradation.
- **Core-as-plugin models (Obsidian API 1.13.2, VS Code `main`, Zed 1.19.0).** VS Code is the
  only one where core really loads through the extension path (97 directories under
  `extensions/`, same manifest + `contributes` machinery), and its one id-addressable
  `CommandsRegistry` is the shape worth copying — but `ICommandHandler` carries no caller
  identity, and `enablement` predicates are explicitly _not_ an authority check ("does not
  prevent executing the command by other means"). Obsidian hands plugins live `HTMLElement`s
  from a manifest with zero contribution declarations, so every contribution is invisible to
  every other principal by construction. Zed has the best permission primitive — declare in
  the manifest, grant at the host — but a closed contribution enum and a link-time action
  registry mean core is definitionally not a plugin there.

The synthesis those three force: one id-addressable registry, a declarative inert manifest, a
single dispatch door that carries the calling principal, declared capabilities intersected
per request, and collisions that refuse loudly.

## Decision

**The wire is the security boundary; realms are a stability boundary.** Plugins are trusted
in-process code, in the browser and on the server. There is no sandbox in this wave and no
pretence of one.

1. **Authority is enforced per request at the action door**, by intersecting the calling
   principal's capabilities with the capabilities the action declares. `PluginHost.dispatch`
   runs one monotonic ladder — `unknown_action` → `plugin_disabled` → `forbidden` (pad-scoped
   token) → `forbidden` (missing declared cap) → `invalid_args` → `refused` (handler) — and
   no later step can argue an earlier denial back to allow. Being mounted never implies being
   permitted; that is the DeepSeek failure mode, inverted.
2. **Manifests are inert data.** No executable fields, no interpolation, no `entry` evaluation
   in this wave. A manifest is a record the server can validate, store, diff, and publish at
   `GET /api/plugins`, which is what makes A1 observable to an agent instead of true only in
   prose.
3. **Contracts are sandbox-shaped even though nothing is sandboxed.** Actions declare their
   capabilities; arguments and results are zod-schema'd and JSON-serializable; no host
   internals appear in a plugin signature (a plugin sees `HostServices`, never the store, the
   room map, or the broker). An isolated runner for untrusted third-party code can therefore
   be added later _behind the same manifest_, without redesigning the contract — the seam is
   reserved, not built.
4. **The action envelope reuses the placement precedent.** `POST /api/actions/:name` returns
   an `ActionOutcome` — `{ ok: true, result }` or `{ ok: false, denial: { rule, message } }` —
   exactly as `POST /api/place` returns `placement_denied` naming the rule that refused. One
   shape for "the server considered your request and said no".
5. **Collisions refuse, they never shadow.** Duplicate plugin ids, action names, panel ids,
   element types, or tool ids fail composition with a `CompositionError` naming every
   offender.
6. **Workspace-graded actions refuse pad-scoped tokens.** A pad-scoped caller is refused at the
   door (`forbidden`, "scoped tokens cannot invoke workspace actions"), which is the exact
   precedent of `POST /api/place` and every workspace route. Finer per-node scoping arrives
   with the permission waterfall (ADR 0011). **Narrowed 2026-08-31 by ADR 0013 §15**: total
   conversion moves every remaining door onto this plane, so an action declares
   `scope: "pad"` when the door it replaces was reachable by a pad-scoped token — reads and
   mutations alike — and its handler then owes the confinement check the route performed. The
   default stays `"workspace"`, and genuinely workspace-wide doors keep the refusal.

## Dependency verdicts

Invariant 8 forbids new runtime dependencies without a dated decision entry. The converse is
now law too: any pattern that is not manifold-specific gets a named library evaluation —
candidates, code and maintenance saved, opinionation cost — recorded in the owning decision
before it is hand-rolled. This wave adds **no** runtime dependency. The verdicts:

| Pattern                                                                 | Verdict                                                                                                                            | Reasoning                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composition registry (`composeRoster`, uniqueness, cap-superset checks) | **Hand-rolled**, over a `zod`-driven generic registry                                                                              | The rules are manifold-specific (caps ⊆ manifest caps, panel/element/tool id uniqueness across plugins, essential-flag semantics) and the implementation is tens of lines. `zod` is already the schema authority and validates the manifest itself; wrapping the _rules_ in a schema DSL would add indirection without removing code.                                                   |
| Action envelope                                                         | **Placement-precedent shape**; JSON-RPC 2.0 evaluated and **rejected**                                                             | JSON-RPC brings request `id` correlation, a `jsonrpc` version field, batch semantics, and a numeric error-code space. HTTP-per-action already correlates by request, versions by `PROTOCOL_VERSION`, and names denials by rule. The machinery would be pure ceremony, and it would create a second refusal vocabulary beside `placement_denied` — an invariant 14 violation on day one. |
| Import-boundary enforcement in `verify:axioms`                          | **`typescript` package's parser** (`ts.createSourceFile`, walk import and export-from specifiers); regex over source is **banned** | `typescript` is already a devDependency. A regex cannot see type-only imports, multi-line specifiers, or re-exports, so a regex gate is a gate that lies.                                                                                                                                                                                                                               |
| `manifold://` URI parsing                                               | **Hand-rolled** over WHATWG `URL`                                                                                                  | `URL` mis-parses custom hierarchical schemes (non-special schemes do not populate `host`/`pathname` the way `http:` does). Percent-encoding still comes from the standard library (`encodeURIComponent`/`decodeURIComponent`); only the grammar walk is ours.                                                                                                                           |

Standing duties recorded here so they are not forgotten: ADR 0011 must evaluate `casbin` and
`CASL` before the permission-waterfall evaluator is hand-built; ADR 0012 must evaluate small
emitter libraries against an in-process micro-emitter; the federation wave must evaluate
transport libraries before extending the WebSocket stack.

## Alternatives rejected

- **WASM or Web Worker isolation for plugin code (rejected for now, seam reserved).** It buys
  nothing while every plugin in the tree is first-party code we compile and ship, and it costs
  a serialization boundary on every contribution — VS Code pays `cloneAndChange` plus `revive`
  on every command argument and makes even local `executeCommand` a `Thenable`, and Zed's
  wasmtime host cannot let an extension register an invocable action at all. Because manifests
  are inert and contracts are serializable, an isolated runner can be introduced later behind
  the same manifest for untrusted code specifically.
- **Dynamic plugin-code distribution and a marketplace (next wave).** The manifest reserves
  `entry: { web?, server? }` and the roster carries `source: "builtin"` so the shape exists,
  but loading code that did not ship with the binary is a distribution, signing, and override
  problem, not an architecture problem, and it is scheduled as its own wave in `AXIOMS.md`
  §Roadmap.
- **Mount-time authority (the DeepSeek model).** Withdrawing a capability by editing the
  composition collapses _mounted_ into _allowed_. manifold's authority is per principal and
  per request; enable/disable is a composition question, permission is a door question, and
  the two must never be the same lever.
- **A privileged core beside a plugin API (the Pi and Zed model).** A closed union plus a
  `switch` for core kinds is exactly the structure the audits found 34 instances of; keeping it
  would make A1 unenforceable. Core features load through the same registry, and `REGISTRY.md`
  makes the remaining floor a machine-readable, gate-checked list rather than a habit.
- **A capability-per-feature RPC pair (the VS Code `MainThreadX`/`ExtHostX` model).** ~120
  hand-written bridge files is a per-feature tax that does not scale to "every capability,
  every principal, UI and API". One declared action shape with schema'd arguments replaces the
  bridge with data.

## Revisit when

Third-party plugin code that manifold did not author is admitted to the tree (then the
isolated runner behind the manifest stops being a reserved seam and becomes the work), or the
per-request cap intersection proves insufficient — which is the trigger already anticipated by
ADR 0011's waterfall evaluator, whose single call surface is `AuthContext.allows`.
