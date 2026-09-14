# ADR 0041: A plugin calls a declared dependency's door, and gains no authority by it

Date: 2026-09-14
Status: accepted
Ratified: 2026-09-14, by the operator (the rule: caller's principal AND caller's ceiling; PR #576 review, finding 2)

## Context

Every other caller can open a plugin's door. The browser dispatches one per gesture; `core.commands`
is a peer that "opens other plugins' doors and declares none" (ADR 0023 §7, `:188`); an external
client posts to `POST /api/actions/:name` with a credential (ADR 0040); a workload on a machine
reaches a service through a binding the owner consented to (ADR 0038). The one caller that could
not was another plugin's SERVER HALF. `ActionCtx` (`packages/server/src/plugin-host.ts:567`) carried
`jobs`, `services`, `streams`, `store`, `rooms`, `broker`, `machines`, `placement`, `host`,
`identity`, `dials`, `storage` and `database` — and no way to ask a sibling anything.

That is a hole in a doctrine the repository already states twice. ADR 0013 §11 rules that
"cross-plugin reads are an action call, not a shared key space" (`:549`); ADR 0034 §7 repeats it for
rows — "cross-plugin data travels through actions and events as it does today" (`:141-142`). Both
sentences describe a verb that did not exist on the server. A plugin that needed a sibling's work
had three options, and every one of them is worse than the hole: reimplement the sibling
(`atyrode.babel` built its own model-launching picker overnight on 2026-09-13 and the operator
rejected the shape), reach around it into the engine's own services, or move the composition out of
the hub into a second process with a second credential.

The verb was never written because the AUTHORITY question was never answered, and it is the
question, not the plumbing: when `atyrode.babel`'s handler opens `atyrode.code.runSession`, whose
principal does `runSession` see? Answer "the calling plugin's" and Manifold acquires plugin
identities, a second authority model beside the grant waterfall (ADR 0011), and a confused deputy
at every declared edge — a client who may open `babel`'s door but not `code`'s gets `code`'s work
done anyway. Answer "the caller's principal" and the composition is free: the callee's rungs are
already written, already published, already traced, and they grade exactly the credential that
asked.

The dependency model is already the shape of the permission. A manifest declares
`dependencies: Record<PluginId, { type: "required" | "optional" | "incompatible" }>` (ADR 0013 §5,
`:295`), composition refuses a missing or disabled `required` edge, a self-dependency and a cycle
(§5 rules 1, 3, 6), and the enablement door refuses a disable that would strand a dependant, naming
it (§5 rule 4). What a plugin composes on is therefore already written down, already machine-read,
and already arbitrated by the floor — which is criterion 3 of the foundation litmus (§13 `:682`:
"it referees between plugins where no plugin could be trusted to referee… an arbiter cannot be a
party"). A verb that admits exactly the declared edges adds no new registry, and §3's second bound
is what keeps it from adding a consent surface either: a call reaches no capability the calling
plugin's own install grant does not already hold, so the install screen keeps telling the whole
truth about what admitting a row lets its code do.

## Decision

1. **`ctx.actions.call({ plugin, action, input })` on the server context.** It resolves with the
   callee door's own parsed result and rejects with a named refusal. It is present on the in-realm
   `ActionCtx` (`plugin-host.ts:586`), on the hardened guest ctx through the isolate proxy
   (`ISOLATE_CTX_METHODS` gains `actions.call`; `packages/server/src/isolate/proxy-def.ts`,
   `packages/plugin-kit/src/server.ts` `GuestActions`), and on the lifecycle and settled-job
   contexts that already carry `jobs` — `onEnable`, `onDisable`, `onAssemblyChanged`,
   `onJobSettled`.

2. **THE AUTHORITY RULE: the callee runs under the principal of the request the caller is serving,
   and no plugin gains authority by calling another.** The call is the existing
   `PluginHost.dispatch` with the caller's own `AuthContext`, so every rung the callee declares is
   asked of that principal exactly as it would be asked of a client: the agent-run policy state,
   the plugin's enablement, the container scope, the installer's grant intersection, the declared
   capabilities at their targets, governed admission, the argument schema, the handler's own
   refusal. A principal that may not open `b.echo` directly cannot open it through `a.relay`; the
   refusal happens AT the callee and is reported as `capability`.

   In a lifecycle hook there is no request, and the principal is the INSTALLER's, restored from the
   row's stored lineage at every fan-out — exactly what `ctx.jobs` already does and for the same
   reason (#514): the row's authority at a transition is the authority that consented to the row.
   The slice is absent when that credential no longer restores, so a revoked installer lends
   nothing rather than silently downgrading to the engine's own hand. `onJobSettled` carries the
   settled job's credential, as its `jobs` slice does.

   The caller's own attenuation is deliberately NOT applied to the PRINCIPAL. `ctx.jobs` and
   `ctx.services` are handed a capability ceiling narrowed to the action's declared `delegates`,
   because there the plugin spends its own consented authority on a native effect. A sibling call
   spends none: the callee grades the principal, and narrowing the principal's capabilities on the
   way would refuse a client its own authority at a door it may open directly. What the caller's
   ceiling bounds instead is WHICH DOORS its code may open at all — §3's second bound, asked of
   the manifest rather than of the credential.

3. **A declared edge, and nothing else.** The callee must appear in the CALLER's manifest
   `dependencies` as `required` or `optional`; anything else — absent, or `incompatible` — is
   `undeclared_dependency`. Composition is declared, never discovered: a plugin cannot find a
   sibling in the roster at runtime and start using it, so the graph a reader sees in the manifests
   is the graph the hub runs. A declared dependency that is not composed or is disabled right now
   is `dependency_unavailable`, which only an `optional` edge can reach (a `required` one absent or
   off is a composition refusal), and the caller stays enabled either way: there is no cascade
   (§5 rule 5).

   **AND THE CALLER'S OWN CEILING (operator's ruling, 2026-09-14).** The callee door's declared
   capabilities must also lie inside the CALLING plugin's ceiling — `granted ∩ declared`, the same
   ceiling rung 4's first half applies to the caller's own doors — or the call is refused
   `caller_ceiling`, naming the caller, the callee door and the cap that fell outside. A plugin
   never does through a sibling what it could not have declared for itself.

   The rule exists because the review of this ADR reproduced its absence: `test.mgr`, a row with
   `capabilities: []` whose installer therefore granted it nothing, declared
   `dependencies: { "engine.plugins": { type: "required" } }` and disabled another plugin the
   moment an owner opened ANY of its doors — the owner's own authority, exercised by code the
   owner never consented to exercise it. Under the ceiling rule that call is refused before the
   dispatch, the owner keeps every ability they had directly, and ADR 0016 §5's install affordance
   keeps telling the truth: a row's high-risk caps are the ones it is shown asking for, whether
   its code spends them at its own doors or at a dependency's. No affordance change is owed.

   It is a SECOND bound, not a narrowing of the principal: the grade at the callee is still the
   caller's request principal (§2), both have to pass, and a caller holding the ceiling gains
   nothing when its caller does not hold the capability. Declared `caps` only — a `delegates`
   entry is a native ceiling the callee spends with its OWN consented authority, which a caller
   never borrows — and it is asked per HOP, so a chain is bounded by every ceiling along it rather
   than by the first one. A door nobody published has no caps to check and falls through to
   `unknown_action`, which is the order the vocabulary publishes.

   Three mechanics the rule needs to be the rule it says it is (PR #576 re-reviews):

   - **ENGINE caps only.** A plugin's OWN capability is namespaced to the plugin that declared it
     and a manifest may declare only its own namespace (ADR 0035), so demanding a namespaced cap
     of the CALLER's ceiling would make every door guarded by one unreachable — which is
     `atyrode.code.runSession`'s exact shape. A namespaced cap is the callee's own gate and it is
     graded where its grant rows live: against the principal, at the callee.
   - **A BUILTIN ROW IS NOT A CALLEE**, however a manifest names it: the call is refused
     `undeclared_dependency` with a sentence that says so and points at the native slices. A
     builtin is not a plugin in the dependency model (ADR 0023 §7 `:189`), and the reason is
     mechanical rather than tidy. The engine's own doors declare no caps of their own and
     resolve authority — and IDENTITY — from the context they are handed: `jobContext` pins the
     plugin identity to the plugin whose dispatch it belongs to, and `engine.jobs`'s doors take
     `pluginId` as an argument. Through this verb that identity would be `engine.jobs`'s own
     with a caller-chosen `pluginId`, so a plugin would read, cancel and execute ANOTHER
     plugin's jobs through a door whose `ctx.jobs` equivalent refuses exactly that (PR #576
     re-review, reproduced). Attenuating the authority does not answer it, because the identity
     rather than the ceiling is what the job service checks. The native slices are the way to
     those mechanisms — `ctx.jobs`, `ctx.services`, `ctx.machines` — each bound to the calling
     plugin and to its declared ceiling, which is what a plugin should be using them for.
   - **A governed cap is dropped from an installed caller's ceiling** rather than admitted by its
     grant, which is rung 4's first half read the other way round: a flat install grant never
     consents to governed authority — its consent is version-bound per artifact revision — so a
     dependency edge must not be able to carry one.

4. **Bounded by the trace, not by taste.** Each dispatch carries the plugin frames of its trace,
   caller last. A callee already on that stack is `dispatch_cycle` — including the caller itself,
   so a plugin reaching for its own door is refused rather than re-entering its own ladder — and a
   stack at `MAX_ACTION_CALL_DEPTH` (8) is `dispatch_depth`. Both are asked before the roster,
   because they are the two refusals no manifest edit can answer: composition already refuses a
   self-dependency and a dependency cycle, so naming the edge for a self-call would be advice that
   cannot be taken. The declared-edge graph is acyclic today, which makes the cycle check the
   runtime twin of an assembly-time truth and the bound that survives any future caller of this
   verb.

5. **Journaled as what it is: a door, opened by a plugin, on a principal's behalf.** The callee's
   dispatch writes its own write-ahead trace (ADR 0018 §3) with the caller's principal as `actor`,
   the callee's full name as `door`, and two reserved payload keys — `origin`, the calling plugin,
   and `parentTrace`, the ledger row of the dispatch it was serving. They are attribution rather
   than arguments, and `tracePayload` drops both names from every door's redacted body
   (`RESERVED_TRACE_KEYS`), so `traceOrigin` is their one writer: neither a client typing them
   into its own request nor a calling handler can make the ledger say a plugin opened a door it
   did not, on a committed row or on a refused rung's write-ahead one.
   One trace per frame, chained, with no second audit table — the ledger's one-writer rule
   (`scripts/verify-trace.ts` T1) is untouched.

6. **A refusal is a class, then the plugins it names.** `ACTION_CALL_REFUSALS` is closed and
   published at `GET /api/protocol` beside the denial ladder (`pluginVocabulary().actionCall`):
   `dispatch_cycle`, `dispatch_depth`, `undeclared_dependency`, `dependency_unavailable`,
   `unknown_action`, `caller_ceiling`, `capability`, `refused` — walked in that order, so a caller
   learns the first thing wrong. The message is the D5 house shape every other plugin refusal
   uses: the class, then
   the offenders after `": "`, caller first (`undeclared_dependency: atyrode.babel -> atyrode.code`,
   `capability: test.a -> test.b.echo (terminals:write capability required)`). A refusal the calling
   handler does not catch refuses the CALLER's dispatch with that same sentence, so a client learns
   which edge failed instead of reading a broken door, and nothing the caller staged goes out.

   **A sibling's FAILURE is not a refusal.** A callee whose handler throws settles its own row
   `failed` and the host logs the throw with its message; the caller is told
   `refused: <caller> -> <callee>.<door> (failed)` and never the callee's error text, because
   another plugin's internal sentence — a SQLite constraint, a stack message from its own
   `ctx.database` — is not this caller's to publish to its client. The conversion happens in
   `actionCalls` rather than at either boundary, so the in-realm and hardened answers are the same
   sentence, and the two rows still tell the truth apart: the callee's `failed`, the caller's
   `refused`.

7. **The callee's dispatch is whole.** It is one ordinary dispatch, so its staged emissions flush on
   ITS success and the caller's stay staged until the caller returns (`plugin-host.ts` `run`); its
   limits, its `scope`, its opacity and its `cleanup` carve-out are its own; and a refused nested
   dispatch commits nothing. This is the property that makes the verb small: it adds no rung, no
   second ladder and no second flush.

## Prior art

Two platforms have answered this exact question in opposite ways, and both were read.

**Factorio's `remote.call(interface, function, ...)`** is the closest analogue: a mod registers a
named interface and any other mod calls it in-process. It is deliberately unauthenticated — mods
are a single trust domain, there is no principal, and the documentation's own warning is about
load-order and interface existence rather than permission. Manifold takes the shape (a named,
in-process, cross-plugin verb whose arguments are plain data) and rejects the trust model, because
a workspace has principals, and a plugin that could act as "the platform" would be exactly the
privileged core axiom A1 denies exists.

**VS Code's `commands.executeCommand`** is the authority answer: an extension invokes another
extension's command, and the command runs with the same privileges the calling extension already
has — there is no elevation, and nothing about the caller's identity is added to the call. VS Code
also shows the cost of the missing half: it has no declared edge for a command call, so an
extension can invoke anything a registry happens to hold and the dependency graph it publishes
(`extensionDependencies`) says nothing about who calls whom. Manifold keeps the no-elevation rule
and adds the edge, because the edge already exists in the manifest and refusing an undeclared one
costs nothing a reader would not want refused.

Home Assistant's service calls and NeoForge's `InterModComms` were also surveyed: both are message
passing whose permission model is "the whole process is one trust domain", the same answer as
Factorio. None of the four gives a per-request principal to the callee, and none has a dependency
graph that is also the call permission. That pairing is this ADR's only novelty, and it is only
available because ADR 0011 made authority rows on a node tree and ADR 0013 made dependencies
declared data.

## Alternatives rejected

- **A plugin identity: the callee sees `atyrode.babel` as its principal.** Rejected. It is a second
  authority model (a principal that no `core.access` row minted, that no grant names and that no
  credential can be revoked from), and it is the confused deputy by construction: the caller's
  clients would inherit whatever the caller's identity held. Every capability question in the
  server goes through one evaluator (`AuthService.allows`); a plugin identity would be the first
  question that could not.
- **Narrowing the PRINCIPAL to the caller's ceiling** (handing the callee an attenuated
  `AuthContext` the way `ctx.jobs` gets one). Rejected, and it is the distinction §3's second
  bound rests on: a sibling call performs no effect of the caller's, so attenuating the credential
  would refuse a root client its own authority at a door it may open directly, and the refusal
  would name the wrong party. The caller's ceiling is a bound on WHICH DOORS its code may open,
  asked of the manifest; the principal is who is asking, asked of the credential. Both hold; only
  one of them is the caller's.
- **A new manifest field (`calls: [...]`) beside `dependencies`.** Rejected: two registries for one
  relationship. "I build on this plugin" and "I open this plugin's doors" are the same statement —
  ADR 0013 §5's `reason` field already exists to say why — and a second list would drift from the
  first the day someone edited one of them.
- **Direct import of the sibling's module, or a shared table.** Rejected by the contracts this ADR
  serves: a plugin is not linkable code (ADR 0016 puts a hardened row in another process, where an
  import cannot follow), and `ctx.database` is one file per plugin with exactly one writer
  (ADR 0034 §7). A door call is the only form that works identically in-realm and isolated.
- **An event, rather than a call.** Rejected: events are notifications with no answer and no
  ordering guarantee (ADR 0012). `runSession` returns a session; a caller that has to wait for an
  event about its own request has reimplemented a call badly.
- **`core.commands` as the seam** ("it already opens other plugins' doors"). Rejected as a detour:
  `core.commands` is a plugin, its door would need the caller's authority anyway, and routing a
  server-to-server call through a third plugin's dispatch adds a frame, a trace row and a
  dependency on a plugin that can be disabled. It may adopt this verb later; it is not required to.

## What this is NOT

- **Not an import.** No plugin gains access to another's code, module identity or types; the only
  thing that crosses is JSON the callee's own schema parses.
- **Not shared storage.** `ctx.storage` and `ctx.database` stay namespaced to one plugin with one
  writer (ADR 0013 §11, ADR 0034 §7). A sibling reads a sibling's data by calling a door that
  answers with it, which is the same sentence those two ADRs already wrote.
- **Not an authority gain.** There is no plugin principal, no cap inheritance along an edge, no
  elevation at a boundary, and no way for a caller to widen what its own caller held — nor to
  reach, through a dependency, a capability its own install grant withheld (§3). A declared
  dependency is permission to ASK, never permission to DO.
- **Not a transitive grant.** `a -> b` does not let `a` reach `c` because `b` declares it: each
  frame's edge is checked against the caller of that frame, and the trace carries the whole chain.
- **Not a new rung.** The denial ladder a client learned is unchanged; an escaped sibling refusal
  arrives as the existing `refused` rung, whose message is a published class.
- **Not a job, a service or a stream.** Those three remain what they are: `ctx.jobs` for a machine
  operation under the plugin's consented authority, `ctx.services` for a brokered credential, and
  `ctx.streams` for continuous data. This verb is one request and one answer inside the hub.

## Evidence boundary

`packages/server/test/plugin-actions-call.test.ts` drives the whole contract against a real host
and a real ladder: the declared edge succeeding under the caller's principal with `origin` on the
callee's ledger row, a client's forged `origin`/`parentTrace` stripped from both a committed row
and a refused rung's, the callee's emission flushing while the caller's refusal publishes nothing,
the undeclared plugin, the absent and the disabled optional dependency with the caller still
enabled, the review's `test.mgr` refused `caller_ceiling` at `engine.plugins.setEnabled` with the
victim still enabled and the owner's own dispatch still admitted, a caller whose ceiling does hold
the callee's caps succeeding, a principal without the callee's capability refused at the callee, an
unpublished door, the callee's own refusal, a callee that throws answered without its error text, a
self-call, a nine-plugin chain refused at the bound, and the same requests and refusals through
`serveCtxCall` — the proxy path a hardened guest's `call` frame reaches.
`packages/plugin-kit/test/server.test.ts` pins the guest half: one frame per call, and the
host's refusal sentence reaching the handler as `ActionCallError` with its class still at the front.
Not exercised here: no deployed instance was driven, and `atyrode.code.runSession`
(`atyrode/code#170`) does not exist yet — the first real edge is owed by that issue and
`atyrode/babel#279`.
