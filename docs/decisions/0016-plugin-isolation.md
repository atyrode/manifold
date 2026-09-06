# 0016 — The isolation boundary for third-party plugins

Date: 2026-08-31
Status: accepted
Ratified: ratified as written by the operator, 2026-09-01. §Decision (§1–§9) is normative from this date, and `AXIOMS.md` §Roadmap's marketplace gate — "does not land before a dated isolation ADR ratifies a runner, and that is a hard ordering rather than a preference" — is discharged by this file. The §Ratification asks are answered by the sections that raise them: **R1 yes** (one OS process per isolated plugin on the server, one dedicated worker per isolated plugin in the browser), **R2 yes** (never the DOM, by any route; a closed host-owned component vocabulary), **R3 yes** (`PluginStorage` becomes promise-returning for every plugin, reversing the synchronous ruling in `storage.ts`, in exchange for one storage contract), **R5 = A** (§8's stage 1 covers both halves, because §1's boundary IS process-and-worker and half a boundary is not one), **R8 yes** (fail-closed verification, the artifact hash pinned on the roster row and re-verified at load, registry review documented as not a security control), **R9 = stage 1** (stage 2 is the marketplace protocol itself, so it cannot be the gate on its own wave). **R4, R6 and R7 are left as choices deliberately and are decided in the stage-1 change that first needs each**: the default install grant's high-risk subtraction, SES adoption under §7 — never the boundary either way, and owing its own invariant-8 verdict where it lands — and §9's pillar question, which is a `REGISTRY.md` edit in the commit that adds the runner's files. No code depends on this file until stage 1 is scheduled; the dependency verdicts named in §Revisit when are still owed before it is. ADR 0025 (ratified 2026-09-05) re-scopes §1/§3 to rows installed with hardened: true, reverses R9, keeps R1/R2/R5/R8 for every row.

## Context

`AXIOMS.md` §Roadmap gates the marketplace on this decision, in the strongest terms the roadmap
uses anywhere: dynamic plugin distribution "does not land before a dated isolation ADR ratifies a
runner, and that is a hard ordering rather than a preference." The reasoning is already written
there and is not re-argued: everything in the tree today is first-party code compiled into the
build, which is the entire reason ADR 0010 could reject WASM and Worker isolation and reserve the
seam instead; a marketplace is the event that consumes that reservation; shipping distribution
first "would spend the seam without building it and leave per-request cap intersection as the only
boundary between a stranger's plugin and the store, the broker and the room map." ADR 0010's own
revisit trigger names the same moment: "third-party plugin code that manifold did not author is
admitted to the tree."

This file judges the runner. It is written against what actually landed, because the landed shapes
decide most of it:

- **The ctx-slice discipline is the RPC migration path, and it was designed to be.**
  `packages/server/src/plugin-host.ts:153-159` states it: "a plugin never names these types. Its
  `server.ts` declares the MINIMAL structural slice it needs
  (`{ broker: { rename(id, name): \"ok\" | \"not_found\" } }`), and assembling `SERVER_PLUGIN_DEFS`
  in `assembly.ts` is where that slice is checked against this context by assignment. That is the
  sandbox shape D1 asks for without a sandbox yet: a plugin's declared slice is exactly what it can
  touch, and it is verified at build time." Every declared slice is a candidate RPC interface, and
  the set of slices in the tree is the exact surface an isolated runner has to serve.
- **Three members of that context are synchronous, and one is a live CRDT handle.**
  `ctx.storage` is `PluginStorage` — `get`/`set`/`delete`/`keys` returning values, not promises,
  "SYNCHRONOUS on purpose" over Bun's SQLite (`packages/plugin/src/storage.ts:12-13`) — and
  `ctx.outsideScope()`, `ctx.now()` and `ctx.newId()` are synchronous too. On the browser half,
  a contributed element renderer receives `ElementTx.text(elementId): Y.Text | null`
  (`packages/plugin/src/host.ts:243-252`): a live Yjs handle, which is not serializable in any
  sense a boundary can carry.
- **The manifest already reserves the entry point.** `entry: { web?: string; server?: boolean }`
  (`packages/protocol/src/plugin.ts:259-260`, comment "reserved, dynamic wave") and the roster's
  `source` enum is already `["builtin", "plugin"]` with the note that "a distributed plugin will be
  `plugin` too, so the marketplace wave needs no new roster shape" (`:318-322`).
- **Consent has a place to live.** A manifest declares a capability ceiling (`capabilities`, at
  most 16), assembly refuses any action whose declared caps are not a subset of it, and dispatch
  rung 4 intersects the caller's caps with the action's per request. An install-time grant is one
  more intersection against data, not a new mechanism.
- **The doors are already observable.** Every dispatch writes one structured line with principal,
  action and outcome; `LOG_EVENTS` is a registry checked in both directions (S14); every mutating
  affordance carries `data-action` (S4, R7); refusals are named classes on a closed enum
  (ADR 0013 §2); and lifecycle failure is a roster state, not a log line.
- **The floor has a budget, and it is already past its review line.** S16 caps
  `packages/plugin/src` at 9,000 lines WARN / 12,000 RED; it measures about 9,100 lines of
  `.ts`/`.tsx` (tests excluded) today, so the WARN is already printing and there are under 2,900
  lines to RED. An isolation runner's client half lands there.

Evidence below was measured or read from source on 2026-08-31. Latency figures were measured on
this machine (Bun 1.3.13, AMD EPYC 9645, Linux 6.18.34) with a throwaway harness; they are
order-of-magnitude facts, not benchmarks anybody should quote.

## What each boundary actually costs

**Worker / process RPC.** A Bun `Worker` `postMessage` round-trip with a small JSON-shaped object
measures **29.3 µs**; a `Bun.spawn` child process with an IPC channel measures **25.5 µs** for the
same payload — the process is not slower. Serialization is not the cost: `structuredClone` of that
object is 2.8 µs and a `JSON.parse(JSON.stringify(…))` round-trip is 0.7 µs, so what one pays for
is the thread or process wake-up. Startup differs: a Worker is ready in **7.0 ms**, a subprocess in
**18.2 ms**. Structured clone will not carry functions (`DataCloneError` on any callable, WHATWG
HTML §2.7.3), symbols, DOM nodes, or class prototypes. Against those numbers, **Bun's own
documentation says the `Worker` API "is still experimental (particularly for terminating
workers)"**, `smol: true` is a heap-size hint rather than a cap, and there is no documented
per-worker memory limit — so a Worker gives isolation of state but not a reliable kill switch,
while a process gives both plus OS-level memory limits and crash containment. VS Code's three host
kinds are `LocalProcess`, `LocalWebWorker` and `Remote`
(`extensionHostKind.ts:9-13`), and its crash policy is data worth copying: three crashes in five
minutes, then stop restarting and tell the human
(`abstractExtensionService.ts:1565-1588`).

**Realm-level isolation.** `ShadowRealm` is TC39 **Stage 2.7**, has no engine shipping it (it does
not appear anywhere in MDN's browser-compat data as of 2026-08-27; Firefox and Safari positions are
both "no signal"), and — decisively — **Bun's implementation is not a security boundary**: inside a
fresh `new ShadowRealm()` on Bun 1.3.13, `typeof process` is `"object"`, `Bun.spawnSync` is a
function and `Bun.file("/etc/hostname").text` is reachable. It is a separate global with a
callable-only boundary (18 ns per call), which is a modularity tool, not a sandbox. SES
(`ses@2.3.0`) is the real member of this family and it is honest about its own limits: `lockdown()`
tamper-proofs intrinsics and `Compartment` grants no ambient authority, but Endo's own
documentation states that compartments share one agent, "a single thread of execution and a single
heap", so an infinite loop "denies synchronous progress to every other compartment" and an
out-of-memory attack is both an availability and an **integrity** compromise — "a host that needs
to defend against them must impose a coarser boundary, as a separate worker or process around the
suspect code." MetaMask ships SES for exactly this job and layers a host-enforced execution timeout
on top (default 60 s, `maxRequestTime` caveat 5 s–3 min) because SES cannot bound CPU.

**WASM.** Zed is the reference embedding: wasmtime 48 with `epoch_interruption(true)`, a background
task incrementing the epoch every 100 ms, and `store.epoch_deadline_async_yield_and_update(1)` —
note that a runaway guest **yields**, it is not killed (`wasm_host.rs:552-593, 676-678`) — with WASI
preopens limited to the extension's work directory (`:743-753`). The instructive part is the WIT
world (`extension_api/wit/since_v0.6.0/extension.wit`): imports for github, http-client, process,
nodejs, settings and a key-value store; exports for language servers, slash commands, context
servers and DAP; and **not one UI import or export anywhere**. Zed extensions that add UI do it
declaratively through the manifest. Running manifold's TypeScript inside WASM is worse than that
picture suggests: `quickjs-emscripten@0.32.0` is a 491 KiB wasm (1004 KiB for the asyncify build
that async host calls require), 26 ms to compile once and 247 µs per fresh context; Javy 9.1.0
emits **1.30 MiB** for a two-line module and has no async import story; ComponentizeJS 0.22.0 —
whose own README says "This is an experimental project, no guarantees are provided for stability"
— produced a **11.92 MiB** component (3.85 MiB gzipped, 5.2 s build) for a trivial function, and
its documented limitation is fatal here: "imported functions can only be synchronous pending
component-model-level async support." WASI 0.3's async story is unstandardized (the proposal
tracker's Phase 4 and Phase 5 tables are empty).

**A worker cannot touch the DOM, and every shipped system answers that the same way.** VS Code's
web-worker extension host is a cross-origin `<iframe>` that hosts the Worker
(`webWorkerExtensionHost.ts:147-155`), and extension UI is never drawn by the extension host at all
— webviews are separate sandboxed iframes fed HTML strings. Figma runs plugin code in a QuickJS
sandbox with no browser APIs and no DOM, and UI is an `<iframe>` created by `figma.showUI()` that
talks to the sandbox by message passing. MetaMask Snaps run in SES with "no DOM … other than the
default `snap` global" and render through a **closed, host-defined component vocabulary**
(`@metamask/snaps-sdk/jsx`: `Box`, `Heading`, `Text`, `Button`, `Card`, `Image`, `Link`, …) with
interactivity delivered as an `onUserInput` callback keyed by component name. The one shipped
alternative — AMP's `worker-dom`, 5 kB main thread and 13 kB worker brotli, with React and Preact
demos — streams arbitrary DOM mutations from a worker, and it is precisely arbitrary DOM that
manifold cannot accept: S13 requires every selector family to have exactly one owner and makes a
family painted from another package's stylesheet gate RED, and `AXIOMS.md` §"Explicitly not a goal:
themes" refuses "a second writer for every family in the tree" by name. An isolated plugin
streaming DOM mutations is that second writer.

**The iframe gotcha, since two of those precedents use one.** `allow-scripts` together with
`allow-same-origin` on content served from the host's own origin lets the frame reach
`parent.document` and remove its own sandbox attribute. VS Code sets exactly that pair and defends
with **origin separation** instead, logging "The web worker extension host is started in a
same-origin iframe!" when a separate origin is unavailable. Origin separation, not the `sandbox`
attribute, is what contains a frame — and a separate origin is a deployment requirement, which
collides with `AXIOMS.md` §The portable lens ("no assumption that the server it talks to is the
origin it was served from" cuts both ways: the lens must also work when there is only one origin).

**Consent mechanisms, compared.** Zed declares capabilities in the manifest and checks twice — the
manifest, then the host's granted set (`capability_granter.rs:23-45`) — but its shipped default is
`{"kind":"process:exec","command":"*","args":["**"]}` and two more wildcards
(`assets/settings/default.json:2235-2241`), so out of the box the declaration is an honesty
mechanism, not enforcement. Chrome consents required permissions once at install and grants
optional ones at runtime, with a documented asymmetry worth avoiding: after
`permissions.remove()`, "calling `permissions.request()` usually adds the permission back
**without prompting the user**." MetaMask narrows permissions with structural caveats
(`allowedOrigins`, `maxRequestTime`) and makes revocation an explicit settings action. VS Code has
no per-capability model at all — `IExtensionCapabilities` is self-declared _compatibility_
(`untrustedWorkspaces`), and the actual gate is per-folder workspace trust, default-deny for any
extension with a `main` entry point that says nothing.

**Signing, and what it does not buy.** VS Code verifies a detached PKCS#7 signature plus a
per-file integrity manifest before install, with a 28-value result enum naming every failure mode
— but it is a **repository** signature (the Marketplace signed it), not a publisher signature, and
if `@vscode/vsce-sign` fails to load the service logs "Extension signature verification is not
done" and returns undefined: **fail-open**. Zed's registry is a monorepo of git submodules gated by
a human PR review ("every submission is reviewed") with no signing at all. Obsidian's registry
grants a name: after the one-time review, "actual files are fetched from your GitHub releases",
with no re-review, no signature and no hash pinning. npm provenance states its own limit plainly:
it "does not guarantee the package has no malicious code", only a verifiable link to source and
build. And Figma, which is the only surveyed vendor that had to survive a real escape, wrote the
rule this ADR takes: "we do not rely on human reviews to audit newly-published plugins for
security as audits can produce false negatives. We instead use a sandbox to enforce a security
boundary."

## Decision

### 1. The boundary: a process per isolated plugin on the server, a worker per isolated plugin in the browser

**Server half — one OS process per isolated plugin, supervised by the host.** The measured
per-call cost is the same as a Worker's (25.5 µs vs 29.3 µs) and the containment is strictly
better: a crashed or wedged child is killable, memory-limitable by the OS, and cannot take the
server down, whereas Bun's own docs call `Worker` termination experimental. Startup is 18.2 ms,
paid at enable, not per call.

**Browser half — one dedicated Worker per isolated plugin.** There is no process to have, the
Worker is the only real boundary the platform offers, and the iframe alternative buys containment
only with an origin manifold cannot promise every deployer (§Context, the portable lens). The
Worker holds plugin logic; it never holds the plugin's pixels (§3).

**Rejected as the boundary, with reasons in §Alternatives:** WASM (no UI path, and the JS-in-WASM
toolchains are experimental, multi-megabyte, or synchronous-imports-only), ShadowRealm (Stage 2.7,
not a boundary in the runtime we ship on), SES alone (no availability, memory or timing isolation
by its own documentation — though see §7: SES is a _complement_, not a competitor).

**First-party plugins are unaffected.** Everything in `packages/plugins/*` keeps running in-realm.
The runner is selected by the roster's `source`: `builtin` and first-party `plugin` rows run
in-realm, an installed row runs isolated. That is not a privileged core — it is the same manifest,
the same doors, the same ladder, and the distinction is the one A1 already permits: data on the
roster, not mechanism in the engine.

### 2. What an isolated plugin CAN reach

Exactly the ctx slices it declares, served over the RPC, with every argument and result
JSON-serializable — which ADR 0010 rule 3 already made true of actions and which the ctx-slice
discipline already made true of the context. Concretely:

- **Its own actions' dispatch**: `ctx.principal`, `ctx.auth`, `ctx.containerScope`,
  `ctx.outsideScope()`, `ctx.now()`, `ctx.newId()`, `ctx.emit`.
- **Its own storage namespace**: `ctx.storage`, unchanged in meaning — namespaced by plugin id,
  versioned, migration-ledgered, erasable by purge. Its shape changes (§4).
- **The host services a slice names**: `ctx.placement.place()`, `ctx.machines.isOnline()`,
  `ctx.broker`'s declared methods, `ctx.store` reads a slice names — each one an RPC method the
  host implements and the manifest's declared caps still gate at the door.
- **The action door, as a caller**, exactly like any other principal.
- **The event plane**, as an emitter of kinds its manifest declares (`emitterMayEmit` is unchanged)
  and as a subscriber through its own client.

### 3. What an isolated plugin CANNOT reach

- **The DOM. Ever.** Not through a handle, not through a mutation stream, not through
  `worker-dom`. An isolated plugin's UI is a **closed, host-owned component vocabulary** —
  serialized component trees in, named callbacks out, the MetaMask Snaps shape — rendered by the
  engine into families the engine owns. This is not caution, it is S13: ink has exactly one owner,
  and a stranger's plugin painting arbitrary DOM is the second writer the themes not-goal refuses.
- **`@manifold/plugin`'s React interfaces.** An isolated plugin does not import the engine's hook
  and component library at all: no `usePolledResource`, no tile geometry, no projection registry,
  no `HostServices` object with a live `SessionHandle` in it. It gets the protocol package (pure
  data), the component vocabulary, and an RPC client. `HostServices.token` — today a real bearer
  handed to trusted in-realm code (`packages/plugin/src/host.ts:194-201`) — is **not** given to an
  isolated plugin; it calls the door through the host, which attaches the caller's authority.
- **The Yjs document.** `ElementTx.text()` returns a live `Y.Text`, which cannot cross a boundary.
  So in the first cut an isolated plugin **may not contribute a collaborative-text element
  renderer**. It may contribute elements whose edits are whole-record patches (`patch`, `remove`
  are serializable calls) and elements whose edits are actions. `core.notes` is therefore the
  worked example of what stays first-party, and that limit must be a named refusal at assembly, not
  a runtime surprise.
- **Another plugin's storage, another plugin's event kinds, the store, the room map, the broker,
  the socket registry, the logger, or any host class.** These were already unreachable by contract
  (ADR 0010 rule 3); isolation makes them unreachable by construction.

### 4. `PluginStorage` becomes asynchronous, for everybody

An isolated plugin's storage calls cross a boundary, so they are promises. Two storage contracts —
sync for in-realm plugins, async for isolated ones — would be two doors onto one concept, which is
invariant 14 with the seams showing, and every plugin author would have to know which kind of
plugin they are. So the isolation wave migrates `PluginStorage` to a promise-returning interface
for all plugins, first-party included.

The cost is real and is stated rather than hidden: in-realm plugins pay a promise per read over a
synchronous SQLite call — the very allocation `storage.ts:12-13` declined to pay — and every
first-party handler that reads storage gains an `await`. The alternative costs more. This is
§Ratification ask R3.

### 5. Consent is a grant on the roster row, intersected at the door

Install-time consent needs no new mechanism, because the manifest already publishes a capability
ceiling and rung 4 already intersects. The wave adds one field to the roster row — the capability
set an installer **granted** — and one intersection: an isolated plugin's effective caps are
`granted ∩ declared`, evaluated where the ladder already evaluates.

- The grant is **data on the roster**, visible at `GET /api/plugins`, so an agent sees exactly what
  a human sees (A2), and changing it is an action at the engine's own door with a named refusal
  when it is refused.
- The install affordance shows two things and no prose: the declared ceiling, and every door the
  plugin publishes with the caps each one needs. That list already exists — it is `ActionSummary`.
- Narrowing a grant after install is allowed and its consequence is the existing `forbidden`
  denial at rung 4, which is already a named, displayable outcome. Chrome's asymmetry is refused
  explicitly: re-granting a narrowed capability is an act with the same visibility as the first
  grant, never a silent restore.
- Zed's wildcard default is the lesson, not the model: a grant that defaults to everything makes
  the declaration an honesty mechanism. Whether manifold's default grant is "the declared ceiling"
  or "the declared ceiling minus a named high-risk set (`*`, `tokens:mint`, `plugins:manage`)" is
  §Ratification ask R4.

### 6. Isolation is observable at the doors, in the vocabulary that already exists

No new observability mechanism, three extensions of ratified ones:

- **Dispatch logging** gains the isolate's identity on the existing structured line; every new
  `evt` name is a `LOG_EVENTS` row, checked in both directions by S14 as usual.
- **Isolate lifecycle is a roster state.** `PLUGIN_LIFECYCLE_STATES` is a closed enum today
  (`ok`, `enable_failed`, `disable_failed`, ADR 0013 §2); isolation adds the states a runner can be
  in — a crashed isolate is a degraded roster row every principal sees, not a log line somebody
  greps. The crash policy is VS Code's, as data: a bounded number of restarts in a bounded window,
  then stop and say so on the roster.
- **A hung isolate is a refusal, not a hang.** Every RPC call the host makes into an isolate is
  bounded, exactly as ADR 0013 §2 bounds a lifecycle hook at 2 seconds, and the expiry is a named
  refusal class rather than a stuck promise. MetaMask's `maxRequestTime` is the precedent for
  making the bound a declared, narrowable number.

### 7. SES is a complement, not the boundary

Loading an isolated plugin's code inside `lockdown()` in its own process or worker costs one
dependency and buys prototype-poisoning defence and ambient-authority denial _within_ the isolate —
which is worth having, because a plugin that pulls in a compromised npm package is the likeliest
threat in practice. It is not the boundary, because Endo says it is not: no availability, no
memory, no timing isolation. If it is adopted, it is adopted as an in-isolate hardening pass with
its own invariant-8 dependency verdict, and never as the reason a coarser boundary is skipped.
§Ratification ask R6.

### 8. Staging: engine, protocol, distribution — in that order, each landable alone

1. **The isolation engine.** The runner (process + worker), the ctx RPC generated from the declared
   slices, the closed component vocabulary, the async storage migration (§4), the lifecycle and
   refusal vocabulary (§6), and the gate checks that make it falsifiable. **The proof is a
   first-party plugin running both ways**: one existing plugin, in-realm in one run and isolated in
   another, passing the same browser checks — which is the only way to know the boundary preserves
   behaviour before a stranger's code depends on it. No third-party code is admitted in this stage,
   so it can land, be lived with, and be reverted cheaply.
2. **The marketplace protocol.** `entry { web?, server? }` is consumed for the first time, roster
   `source: "plugin"` gains real occupants, install and uninstall become doors with named
   refusals, the granted-caps field and its consent affordance land (§5), and the core-plugin
   override mechanism the roadmap already specifies (disable-then-enable-a-substitute by id) is
   implemented as data. Still no network registry: installation is from a local artifact, which is
   enough to exercise every door.
3. **Distribution and signing.** The registry, the artifact format, and provenance. Three rules
   fall out of the evidence and are proposed as binding on that stage: verification is
   **fail-closed** (VS Code's fail-open path is a bug manifold should not copy); the roster row
   pins the artifact **hash** it was installed from and re-verifies at load, because Obsidian's
   model — review a repository once, then fetch whatever the developer released — is a supply-chain
   hole with a name; and registry review is documented as **not** a security control, per Figma.

### 9. The runner is floor, and the litmus test says so

Applying `AXIOMS.md` §Foundation law criterion by criterion, as a floor addition must:

- **Bootstrap circularity** — plugins presuppose the runner: the thing that loads a plugin's code
  cannot be a plugin, for the same reason the enablement door cannot be one.
- **Neutrality** — the runner knows contribution kinds and slice shapes; it names no plugin and
  would be unchanged if every plugin in the tree were replaced.
- **Arbitration** — it is the boundary between mutually untrusting parties, enforces the capability
  grant, bounds CPU and memory, and decides what a crash means. An arbiter cannot be a party.

It passes all three. Whether it joins the existing `assembly-engine` pillar (which already owns
`packages/plugin/src/**` and the host) or is admitted as its own pillar row is §Ratification ask
R7. Either way the S16 budget is the cost to watch: `packages/plugin/src` measures about 9,100
lines against a 9,000-line WARN it has already crossed and a 12,000-line RED, and the RPC client
plus the component vocabulary land
exactly there.

## The performance bill, stated plainly

- **Per action: ~25–35 µs**, added to a dispatch that already parses zod schemas and touches
  SQLite. For a door fired at a gesture's commit point this is invisible. It is only fatal for
  per-frame or per-keystroke traffic — which the plane rule already forbids on the action plane
  ("an action fires at the commit point of a gesture, never per frame"). The boundary is
  affordable **because** the plane rule holds, which is worth stating: if a future door starts
  firing per frame, this ADR's arithmetic is void.
- **Per enable: 18 ms** for a server isolate, 7 ms for a browser worker. Hot enable/disable stays
  hot; R3's "no reload" claim is unaffected at these magnitudes.
- **Per isolated plugin: one process and one JS heap.** This is the real cost, and it scales with
  the number of installed plugins rather than with traffic. Ten installed plugins is ten processes
  on a server whose §Budgets ceilings are currently about idle network reads. A per-plugin memory
  ceiling and an idle-eviction policy are part of stage 1, not an optimization for later.
- **DX: an isolated plugin is a different authoring target, and pretending otherwise would be the
  real cost.** No React from the engine's library, no Yjs handle, async storage, a component
  vocabulary instead of components. `docs/PLUGINS.md` gains a section that says which of the two
  targets a reader is writing for, and the manifest — through `entry` — is what decides.

## Alternatives rejected

- **WASM (wasmtime-class), the runner ADR 0010 named first.** Rejected on two independent grounds.
  The UI ground: no shipped WASM plugin system renders host UI — Zed's WIT world has zero UI
  imports or exports — and getting React into a guest costs 11.92 MiB per plugin with an
  experimental toolchain whose imported functions must be synchronous. The runtime ground: manifold
  plugins are TypeScript, and every JS-in-WASM path is either large (Javy: 1.3 MiB for two lines),
  async-hostile, or experimental. QuickJS is the honourable exception — 491 KiB, a hard memory cap
  via `setMemoryLimit`, and preemptive interruption via `setInterruptHandler`, which is strictly
  more control than a Worker offers — and it is the right answer for the specific case of running
  _untrusted expressions_ (a formula, a filter, a rule) if manifold ever wants one. It is the wrong
  answer for "a plugin with a server half and a panel", because it forces every host call through a
  hand-written C-ABI bridge, which is the ~120-file `MainThreadX`/`ExtHostX` tax ADR 0010 already
  rejected by name.
- **ShadowRealm.** Stage 2.7, no browser implementation, and Bun's implementation leaks `process`,
  `fetch` and `Bun.spawnSync` into the realm. Not a boundary today; revisit if it reaches Stage 4
  and engines ship it.
- **SES alone.** Refused by its own documentation for availability and memory, which are exactly
  the failure modes a shared multiplayer server cannot absorb. Kept as §7's complement.
- **`worker-dom`-style DOM streaming.** Technically shipped and cheap (5 kB + 13 kB brotli), and
  refused on constitutional grounds: it makes an isolated plugin a second writer for every selector
  family (S13, and the themes not-goal).
- **A sandboxed iframe as the primary browser boundary.** `allow-scripts` + `allow-same-origin` on
  the host's own origin is decorative; the containment comes from a second origin, and requiring
  one of every deployer contradicts the portable-lens rule. An iframe remains available later as
  the _escape hatch_ for a plugin that genuinely needs its own document (the VS Code webview
  shape), which is a separate decision with its own name.
- **No isolation, plus review.** The status quo extended to strangers' code. Figma's ruling is the
  answer: audits produce false negatives, and they had eleven days between a disclosed escape and a
  shipped VM. It is also what `AXIOMS.md` §Roadmap already forbids.
- **Isolating only the server half.** Tempting — it is where the store, the broker and the room map
  live — and rejected because a stranger's web half runs in the same realm as the token, the
  session client and every other plugin's state, so "isolated" would name something that is only
  half true. If the operator prefers a smaller stage 1, the honest version is not "isolate one
  half": it is "admit no third-party web half yet", which is §Ratification ask R5.

## Tensions with landed decisions

Flagged, not resolved.

- **T1 — ADR 0010 rule 3 says a plugin sees `HostServices`.** For an isolated plugin, §3 withdraws
  the token, the live `SessionHandle` and the Yjs handle from that object. That is a narrowing of a
  ratified contract for one class of plugin, and it means `HostServices` has two shapes. Either the
  isolated shape is a declared subset with its own name, or ADR 0010's rule needs an addendum. The
  first is cleaner and neither is chosen here.
- **T2 — the synchronous-storage ruling is reversed.** `packages/plugin/src/storage.ts:12-13`
  records a deliberate decision that "an async facade over it would add a promise per read for no
  concurrency". §4 pays exactly that price to keep one contract. It is a reversal of a documented
  choice and should be ratified as such rather than absorbed.
- **T3 — element renderers are a two-class contribution.** §3 says an isolated plugin cannot
  contribute a collaborative-text element. `AXIOMS.md` A3 says a stranger's agent can author a
  working plugin against documented interfaces; after this wave, _which_ interfaces depends on how
  the plugin is distributed. That is defensible and it is a genuine narrowing of A3's promise; it
  needs to be said out loud in `docs/PLUGINS.md` rather than discovered.
- **T4 — S16's budget is already spent.** The runner's client half, the component vocabulary and
  the RPC stubs land in `packages/plugin/src`, which is already past the 9,000-line WARN with
  under 2,900 lines to RED. Raising
  the threshold is "a diff somebody defends"; this ADR predicts the defence will be needed in stage
  1 and does not pre-approve it.
- **T5 — a per-plugin process contradicts nothing in the axioms and everything in the deployment
  story.** `docs/SELF-HOST.md`'s premise is one server process and one SQLite file. Ten isolates is
  a different operational shape, and the §Budgets register has no row for "what an idle installed
  plugin costs". If stage 1 lands, that register needs one.
- **T6 — wave 3 makes the blast radius bigger than this file assumes.** An isolated plugin runs on
  a host that now accepts dialled guests from other origins (ADR 0014). Nothing here is wrong
  because of that, but the threat model in stage 1 must be written against a multi-origin instance,
  not a single-tenant one, and this ADR does not do that work.

## Ratification asks

Each is answerable yes/no, or by choosing among named options. Nothing here is normative until they
are answered.

- **R1.** Ratify the boundary in §1 — one OS process per isolated plugin on the server, one
  dedicated Worker per isolated plugin in the browser — as the runner the marketplace is gated on?
  (yes / no)
- **R2.** Ratify §3's reachability limits, in particular that an isolated plugin **never** touches
  the DOM and renders only through a closed, host-owned component vocabulary? (yes / no)
- **R3.** Accept the migration of `PluginStorage` to a promise-returning interface for **all**
  plugins, reversing the synchronous ruling in `storage.ts`, in exchange for one storage contract?
  (yes / no — if no, name which of the two contracts a first-party plugin uses)
- **R4.** Does an install grant default to the plugin's full declared ceiling (**A**, Zed's shape
  with the honesty caveat), or to the ceiling minus a named high-risk set — `*`, `tokens:mint`,
  `plugins:manage` — which must be granted deliberately (**B**)? (A / B, and name the set if B)
- **R5.** Stage 1 scope: does the isolation engine cover both halves at once (**A**), or does the
  first cut admit **no third-party web half at all** — server halves and declarative contributions
  only — with the browser worker landing in stage 2 (**B**)? (A / B)
- **R6.** Is SES (`ses@2.3.0`) adopted as in-isolate hardening under §7, with its own invariant-8
  dependency verdict recorded in this file at implementation? (yes / no / defer)
- **R7.** Does the runner join the existing `assembly-engine` pillar, or is it admitted as its own
  pillar row in `REGISTRY.md` §Pillar inventory with this ADR as its `adr`? (join / new pillar)
- **R8.** Are stage 3's three rules binding now — fail-closed verification, an artifact hash pinned
  on the roster row and re-verified at load, and registry review documented as not a security
  control? (yes / no)
- **R9.** Does the marketplace wave remain hard-gated on stage 1 alone, or on stages 1 **and** 2
  landing green? (stage 1 / stages 1+2)

## Revisit when

Stage 1 is scheduled — at which point the dependency verdicts this file defers (SES, and any RPC
or supervision library evaluated by name against a hand-rolled one, per ADR 0010's D14 policy) must
be recorded here before code is written; or `ShadowRealm` reaches Stage 4 with engine
implementations, which would change §1's browser answer; or the component model lands standardized
async imports, which is the one development that would make a WASM runner worth re-measuring.

## Addendum 2026-09-06

This closes the evaluation gap identified in [#127's 2026-09-05 triage](https://github.com/atyrode/manifold/issues/127).
Stage 1 has shipped (`CHANGELOG.md` 0.7.0); this is a retrospective comparison, not a claim that
the missing evaluation preceded its code. No dependency is adopted and no ratified rule changes.
The normative contract is `docs/CONTRACTS.md` §Hardened plugins, including ADR 0025's later
choice of hardening rather than mandatory isolation. The comparison here concerns that runner,
not the in-realm loader #256 is to supply.

### The runner being compared

- **Browser:** `packages/web/src/isolate/worker-host.ts` fetches the installed `web.js` with the
  page's bearer and starts a module Worker from its bytes as a Blob; the bearer is not sent to
  the Worker. `WorkerRegistry` actually keys workers by `(pluginId, containerId)` within a host
  gate, shares one across mounted panel instances for that pair, and terminates it after the last
  lease's grace period. Logic executes off the page's thread, without its DOM or live host
  objects. Schema-checked frames carry named host calls and closed component trees;
  `vocabulary.tsx` paints those trees in the host. Worker-wide faults terminate that Worker and
  reach its panels, not the server roster. These are concrete benefits a replacement must retain,
  not a claim of a browser memory quota or an implemented browser execution deadline.
- **Server:** `packages/server/src/isolate/ipc.ts` starts one Bun child process per installed
  server half with a minimal environment and JSON IPC. `supervisor.ts` supplies bounded round
  trips, a kill path, a crash budget and idle eviction; `proxy-def.ts` serves the request's ctx
  calls. A separate process is not an OS permission sandbox: the spawn shown here installs no
  filesystem/network restriction or per-plugin memory ceiling. `--smol` is not such a ceiling.
- **Loading:** `packages/plugin-kit/src/pack.ts` bundles each half with `Bun.build`, inlining the
  kit and dependencies into self-contained files. The installed artifact is hash-pinned and
  rechecked at boot (§Hardened plugins). There is no runtime package-resolution service to
  replace. Nor does this runner put guest code in SES Compartments: withholding host handles
  over RPC does not remove a Worker's ambient browser APIs or a Bun child's ambient OS APIs.

### SES / Endo: in-isolate authority confinement

[Hardened JavaScript's mechanisms and boundaries](https://hardenedjs.org/) support §7's existing
conclusion: SES is a complement, not the runner. It would replace ordinary guest evaluation
inside each Worker/process with a locked-down environment and a Compartment endowed only with
the intended guest API. It would save implementing intrinsic taming, safe evaluators and
capability confinement ourselves. Calling `lockdown()` before an ordinary module import is
not enough: lockdown does not erase the initial global's powerful objects; code must actually
execute in the Compartment, with module loading and endowments controlled.

SES cannot replace the Worker's separate execution thread, externally invoked termination,
or the server supervisor's process kill and crash/idle accounting. Compartments still share
a thread and heap (§What each boundary actually costs); the host-rendered component vocabulary
and request authority checks remain necessary. Conversely, ordinary Workers do not supply SES's
intrinsic taming or ambient-authority confinement.

**Verdict:** rejected as a replacement boundary; **not adopted as an additional layer, revisit
when an in-isolate ambient-authority fence is proposed**, before writing its evaluator or
endowment machinery. Invariant 8 then needs a pinned SES version, any Endo loader dependencies,
measured bundle/startup/heap cost per isolate and compatibility evidence for the actual Bun and
browser guest bundles. The earlier `ses@2.3.0` discussion is evidence, not an adoption or a
current size measurement. No dependency cost is paid by this addendum.

### LavaMoat: per-package supply-chain policy

[LavaMoat's Node runtime](https://lavamoat.github.io/guides/lavamoat-node/) uses SES Compartments
and a policy controlling each package's globals, built-ins and dependency access. Its
[webpack integration](https://lavamoat.github.io/guides/webpack/) wraps modules and applies policy
per package. This would replace unrestricted evaluation of dependencies inside a guest, not the
Worker host or process supervisor, and would save writing package compartmentalization, policy
generation and policy enforcement ourselves. Package policy is not manifold's per-request
capability grant, artifact verification, or closed UI vocabulary; those remain separate duties.
As a SES-based layer it cannot supply the Worker's separate thread or replace process termination.

There is a concrete integration mismatch, not proof that LavaMoat could never work here:
the shipped packer has already collapsed dependencies into a Bun bundle. Per-package enforcement
would require preserving their boundaries through a supported build/loader, not applying policy
to the flattened file and claiming its dependencies are separately confined. Upstream documents
Node and webpack/Browserify integrations, not a demonstrated drop-in for this Bun packer and Blob
Worker. The webpack guide also excludes Module Federation and calls the integration experimental.

**Verdict: not adopted, revisit when a hardened plugin needs independently restricted npm
dependencies and a supported packaging path can preserve those package boundaries.** Invariant 8
would weigh SES plus the policy runtime, build integration, generated policies and overrides
against the confinement code and maintenance saved. Bun IPC compatibility, Blob Worker loading,
policy review ownership and measured per-bundle weight would need proof with pinned versions;
this source review does not provide that adoption evidence. A generated policy is a review
starting point, not proof that a malicious dependency deserves the authority it requests.

### Module federation: runtime code sharing

[Webpack's Module Federation model](https://webpack.js.org/concepts/module-federation/) loads
remote modules and negotiates shared modules between builds; evaluation then executes module
factories in the consuming runtime. It could replace self-contained packaging/loading with
remote entries, chunk loading and shared dependency resolution. It would save building that
machinery if independent runtime code sharing were needed, but it cannot replace the Worker's
thread, termination or message-only host interface. Importing a remote component into the page
would instead give it the page realm and bypass the hardened runner's no-DOM contract. Loading
federated code inside a Worker could retain that boundary, but would still need the existing
host protocol and an authenticated, hash-pinned path for every loaded chunk.

**Verdict:** rejected as an isolation mechanism; **not adopted for loading, revisit when
self-contained artifacts have a measured duplication cost or independently shared modules become
a requirement.** Invariant 8 would then weigh the federation runtime and bundler integration,
version negotiation and chunk verification against bytes actually saved. No such saving is
established here; a remote loader adds machinery to a path that currently needs no runtime
dependency resolver. Sharing a React runtime cannot make live React/DOM objects cross a Worker.

### Import maps: module specifier resolution

[Native import maps](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/importmap)
map module specifiers to URLs in documents; they do not apply to modules loaded into Workers or
worklets. They could replace document-side specifier-resolution configuration, but the hardened
runner loads a self-contained Blob module, not a document module graph. An import map provides
neither a separate thread nor termination, authority confinement, or the runner's message
validation and host-owned UI. Its integrity metadata does not turn resolution into isolation.

**Verdict:** rejected as a replacement for this Worker loader/boundary; **not adopted, revisit
when native Worker import maps are supported by the targeted browsers and the artifact contract
actually needs an external module graph.** Native maps add no JavaScript runtime dependency;
a shim or custom resolver would add one and need its own invariant-8 comparison, including
authenticated loading and pins for that graph. This is not a reason to build a Worker import-map
shim now, nor a verdict on document loading for an in-realm plugin.

### No hand-rolled JavaScript sandbox

The anti-goal in #127 remains explicit: **no hand-rolled JavaScript sandbox**. The runner uses
platform Worker/process primitives plus manifold's protocol and supervision; those do not amount
to a safe JavaScript evaluator. Deferring SES or LavaMoat does not authorize substituting a custom
evaluator, global-object filter or package-policy engine. If those protections become required,
the triggers above reopen the named libraries before implementation. Likewise, federation and
import maps being loading tools rather than isolation boundaries does not discredit SES or
LavaMoat's complementary role. This addendum closes the missing comparison, not the historical
pre-code ordering gap, and claims no new sandbox guarantees for the shipped runner.
