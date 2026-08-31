# manifold — axioms and the sworn boundary

This file is the constitution: what manifold _is_, and where the line runs between the
foundation and everything built on it. It is amended RARELY and by operator ratification only,
and **every amendment names the ratification that carries it** (§Change control). A change to
the law happens here; a change to the DATA the law currently indexes is not an amendment and
happens in [`REGISTRY.md`](REGISTRY.md), in the same commit as the code it indexes.

The law is enforceable because it is indexed by data somebody keeps honest. `REGISTRY.md`
carries the enforcement registries — the pillar inventory, the `floor` rows, the lexicon terms
and `cssFamilies`, the device-local register, the gate contracts — and the check inventory that
`bun run verify:axioms` (part of `bun run gate`) parses in both directions. Crossing a boundary
— of the floor, of this device, or of the language — without editing the registry fails the
gate. That is the whole point: an axiom nobody can violate silently is an axiom.

`AGENTS.md` is how to operate the repo, `docs/CONTRACTS.md` is what the parts promise each
other, `docs/decisions/` is the reasoning behind a contested ruling, `docs/PLAN.md` is where we
are going; this file says what may not be quietly changed. When this file and anything else
disagree, this file wins (§Change control, precedence).

## Axioms

**A1 — Everything above the floor is a plugin.** The floor is the axioms' own enforcement machinery
(`REGISTRY.md` §Foundation). Every feature above it — the sidebar, the drawing tool, terminal
administration, vantage presence, the shell itself — is a plugin: a manifest declaring what it
contributes, plus actions declaring the capabilities they need. Plugins load through ONE registry,
are enabled or disabled per workspace while the page keeps running, and collide loudly rather than
shadowing each other: duplicate plugin ids, action names, panel ids, element types or tool ids fail
assembly by name. What happens to a plugin's data, contributions and neighbours across that toggle
is the behavioral contract — normative in
[`docs/decisions/0013-plugin-behavioral-contract.md`](docs/decisions/0013-plugin-behavioral-contract.md),
with the ratified per-kind table (D4′) in [`REGISTRY.md`](REGISTRY.md) §Disable semantics. There is
no privileged "core" mechanism: core plugins use exactly the interfaces a stranger's plugin uses.
The engine's own doors are the one distinction, and it is a distinction in data rather than in
mechanism: the enablement door is a **builtin roster row** (`engine.plugins`, `source: "builtin"`),
described by the same manifest shape and dispatched through the same ladder as any plugin, carrying
no toggle of its own. A door that can delete itself is not a capability (A2), so the mechanism that
changes the assembly never lives inside the assembly — and `engine.*` is a reserved namespace no
plugin may claim.

**A2 — Multiplayer by design.** Every capability is reachable identically by a local human,
a remote human, and an agent, over the UI and over the API. There is no local-only path and
no API-only path: a gesture in the browser and a call from an SDK land on the same door, and
the door is the only place authority is decided. Solo is a room of one, never a second mode —
local input normalizes into the wire form first and is consumed as if received (AGENTS.md
invariant 11), so single-player is a special case of multiplayer and never the reverse.
Each principal's **vantage** — the tool in hand, what is being edited, which container has focus,
whether the sidebar is open — is observable by other principals and drivable by them where
consent allows it (`core.presence.focus` writes a spotlight into a peer's presence; the peer
holds a kill switch). State that only one device can see is a bug unless it is registered in
`REGISTRY.md` §Device-local register.

**A3 — Moddable by design.** A stranger's agent can author a working plugin against
documented interfaces without reading the engine. The registries ARE the onboarding: the
manifest schema and action vocabulary are published live at `GET /api/protocol` and
`GET /api/plugins`, the words themselves are `REGISTRY.md` §Lexicon, the authoring guide is
`docs/PLUGINS.md`, and the boundary between foundation and plugin territory is the
machine-readable registry in `REGISTRY.md` §Foundation. Contracts are
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
`containerScope` is a subtree grant at `manifold://container/<id>` — the degenerate case of the design, not
a different model. A share is a minted token bound to a subtree grant, portable because it is
data. The full evaluator design is normative in
[`docs/decisions/0011-permission-waterfall.md`](docs/decisions/0011-permission-waterfall.md);
it is designed now and implemented in a later wave, and `packages/server/src/auth.ts` is
registry-tagged as the one call surface it replaces.

**"One door per concept" is not a sixth axiom.** It is an engineering law and lives as
`AGENTS.md` invariant 14: every concept has exactly one authoritative implementation and every
consumer goes through it. It is referenced here because the axioms above are unenforceable
without it — two doors onto one concept means two authority decisions, and the second one is
the one that gets forgotten.

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
  `core.space.setLayout` on pointerup, not sixty.

A fourth plane — **events**: declared notifications emitted by the engine at the doors, whose
topics are nodes, which never mutate anything (reacting to one means calling an action) and
which carry no queue semantics (no offsets, no consumer groups; catch-up is reading state) —
is designed in
[`docs/decisions/0012-event-plane.md`](docs/decisions/0012-event-plane.md) and implemented in
wave 2. Wave-1 code touches it only through the manifest's reserved `contributes.events`.

## Roadmap

The ratified wave order. A wave lands as one branch, one PR, one green `bun run gate`. Wave 1's
conversion work list — which floor surface becomes which plugin, and the ruling behind each row
— is enforcement data rather than law: [`REGISTRY.md`](REGISTRY.md) §Full-conversion inventory.

- **Wave 1 — plugin engine, TOTAL conversion, one language, mechanical enforcement (#69, this
  change).**
  Protocol v16 (connection-level `plugins` frame, presence `vantage`/`spotlight`, `panel` tile
  ref, `plugins:manage`, action and resolve doors, `manifold://` grammar, and the behavioral
  contract's manifest and roster vocabulary: dependencies, `after`, `dataVersion`, `dormant`,
  placement traits, lifecycle states, refusal classes, the closed residual enum, purge targets,
  `source`, `changedBy`/`changedAt`); `@manifold/plugin` with manifests, assembly, dependency
  resolution and ordering, per-plugin `ctx.storage`, and host contracts; the server plugin host,
  its denial ladder, and the **engine-owned enablement door** (`engine.plugins`, a builtin roster
  row); the workspace shell as a tile composition of plugin panels; the plugin behavioral contract
  v2 (ADR 0013) — retain-only disable, engine-owned placeholders, lifecycle hooks including the
  assembly-changed broadcast, data versions with migrations, element-type ownership
  reservation; and **zero floor-owned domain code**: every feature above the floor runs through
  the plugin system or is explicitly sunset, enumerated by `packages/plugins/*` via the two
  assembly files and live at `GET /api/plugins`, never by prose here (D10). Plus the **lexicon
  cut**: one canonical word per concept across identifiers, wire literals, routes, capabilities,
  the SQLite schema (migration 11), CSS, file names, tests and docs, with the retired synonyms
  banned in `REGISTRY.md` §Lexicon and enforced by S11/S12 — the machine wire genuinely breaks here, so
  `MACHINE_PROTOCOL_COMPAT_VERSIONS` resets to `{16}` and the fleet restarts together
  (invariant 10). Plus `AXIOMS.md` (including §Foundation law and §Lexicon law), `REGISTRY.md`
  (the lexicon rows, the `cssFamilies` register and the pillar inventory), `AGENTS.md`
  invariants 12–16, and `verify:axioms` in the gate.
- **Wave 2 — the event plane** (ADR 0012). A subscribe door, emission at the existing doors
  (actions, placement, lifecycle, roster), and real consumers for `contributes.events`. It
  replaces the Machines and Index sections' HTTP polling: one fetch line per section becomes a
  subscription and the moved section UI is untouched. The wave-1 roster frame may later be
  re-expressed as an always-on subscription over the mechanism it itself pioneered; the frame
  shape is unchanged either way.
- **Wave 3 — cross-instance sharing** (A4, riding wave 2's pipes). Instance dialing that
  generalizes the machine channel, share minting bound to subtree grants, principal `origin` in
  the schema. Wave 1 reserves the structural room: SDK pool channels are conceptually keyed by
  `(origin, containerId)` with origin fixed to the current instance, and CONTRACTS carries the
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
    **It does not land before a dated isolation ADR ratifies a runner, and that is a hard
    ordering rather than a preference.** Everything in the tree today is first-party code
    compiled into the build, which is the entire reason ADR 0010 could reject WASM and Worker
    isolation and reserve the seam instead: contracts are sandbox-shaped (declared capabilities,
    schema'd JSON arguments, no host internals in a plugin signature) precisely so an isolated
    runner can arrive later behind the same manifest. A marketplace is the event that consumes
    that reservation — it is the moment code manifold did not author runs in-process, and ADR
    0010's own revisit trigger names it. Shipping distribution first would spend the seam
    without building it and leave per-request cap intersection as the only boundary between a
    stranger's plugin and the store, the broker and the room map. So the isolation ADR is the
    PREREQUISITE deliverable: it judges a runner (wasmtime-class, Worker-class, or a separate
    process) against the serialization cost ADR 0010 measured, and the marketplace wave
    implements distribution on top of whatever it ratifies.
  - **Settings** — a `core.settings` plugin over per-principal preferences. The mechanism is
    already floor and already neutral: `ctx.storage` is a namespaced per-plugin key-value store,
    so a preference is a plugin's own row and there is nothing for the engine to centralize. What
    the wave adds is the PANEL — one place a human edits what is currently edited nowhere — and
    the rule it must obey is that the panel is neutral over what it edits: a settings panel
    that enumerated known plugins would be the floor naming favorites in the one file that must
    not, so preferences are DECLARED by their owning plugin and rendered from the declaration.
  - **Command palette** — one keyboard door onto the whole action vocabulary. It is the cheapest
    proof that A1 and A2 actually hold, and it is deliberately NOT new mechanism: the assembly
    already publishes every action with its title, caps and scope, and `GET /api/protocol`
    already publishes the argument schema, so a palette is a reader over the roster plus the one
    dispatch door every other caller uses. An action a palette cannot reach is an action that
    escaped the door — which makes the palette an audit instrument as much as an affordance. Actions
    needing arguments are the design work: a schema is enough to prompt from, and inventing a
    second per-action UI declaration beside it would be the second convention invariant 14
    forbids.
  - **Notifications** — durable, addressed messages that outlive a tab, on wave 2's event plane.
    This is NOT the notice stack: `notice` is the one canonical word for the transient and sticky
    message layer a floor provider owns and every plugin raises into (`REGISTRY.md` §Lexicon), it is
    per-connection, and it is already built. What is missing is a message that survives a reload
    and finds a principal who was not connected when it was raised — "your terminal exited",
    "somebody joined your container", "your agent finished". That needs persistence, a per-
    principal read/unread state and a delivery door, which is why it waits for the event plane
    rather than growing sideways out of the notice provider. Both keep their own word; a plugin
    raising a notice must not silently become a plugin sending mail.
  - **Templates** — a container, or a subtree of containers, saved as something a principal can
    instantiate again. It is a plugin and a pure projection: a template is scene data plus index
    structure, both of which are already readable and already writable through declared doors, so
    nothing about it needs new floor. The design constraint is what a template may name — a saved
    tree carries element `type`s and panel ids, which are PLUGIN names, so instantiating a
    template into a workspace missing one of them must land the same placeholder every other
    absent contribution lands (D4′, `REGISTRY.md` §Disable semantics) rather than refusing the whole
    tree. That is the same rule
    the default workspace layout already follows, and it is why the envelope round-trips a
    stranger type (S8).
  - **The agent's plugin story** — how an agent AUTHORS a plugin, not merely calls one. A3 is
    satisfied today for the calling half: the roster, the schemas and the one action door mean a
    stranger's agent can discover and drive every capability without reading the source. The
    authoring half is unproven, and it is the harder and more interesting claim: writing a
    plugin currently means editing a workspace package, adding a row to two `assembly.ts` files
    and rebuilding, all of which an agent can do to a checkout and none of which it can do to a
    RUNNING workspace. That makes this wave a consumer of the marketplace's runner rather than a
    peer of it — the distribution seam is what turns "an agent wrote a plugin" into "an agent
    installed the plugin it wrote", and the isolation ADR above is what makes running it
    defensible. What this wave owes on its own is the authoring CONTRACT: a manifest an agent can
    generate, doors it can verify its own plugin through, and the failure modes stated as data
    rather than as a build log.
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

### Explicitly not a goal: themes

**A theming system is a NOT-GOAL, and recording it here is the point — an unstated not-goal gets
built by accident.** Themes are the standard answer to a question manifold has already answered
differently, so the omission needs to read as a ruling rather than as a gap somebody should
helpfully close.

The reason is ownership. A theme is a mechanism for one party to restyle everything, and
`REGISTRY.md` §Lexicon's `cssFamilies` plus S13 say the opposite: every selector family has exactly
ONE owner, every rule is written by the owner of the family it scopes into, and a family painted
from another package's stylesheet is RED. A theme layer is precisely a sanctioned way to violate
that — it would be a second writer for every family in the tree, which is a second convention for
who owns ink (invariant 14) and the end of the check that currently makes ownership falsifiable.
There is no version of "a theme may override any plugin's skin" that S13 survives.

What already exists and is enough: the floor's stylesheet publishes **exactly two cross-owner
tokens**, which is the whole sanctioned vocabulary for shared appearance, and every other value
belongs to the package that paints with it. A plugin that wants to look different changes its
own sheet. If shared appearance ever needs to be genuinely configurable, the honest shape is
MORE published tokens — named, owned by the floor, and each one a deliberate addition to a
registry — never a layer that reaches into families it does not own. That path is open and it is
not a theming system.

Dark mode is not an exception. It is a value question inside the tokens the floor already
publishes, answerable by the floor sheet on its own terms, and it needs no mechanism by which
one party restyles another.

## Lexicon law

One word per concept, one concept per word. A second name for an existing concept is
invariant-14 debt, and the whole of it is recorded as DATA rather than argued case by case: the
registry is [`REGISTRY.md`](REGISTRY.md) §Lexicon, it is machine-readable, and `verify:axioms`
reads it in both directions (S11, S12). It replaced the prose taxonomy that used to sit here — a
document cannot hold two statements of what a word means without becoming the second door onto
its own vocabulary.

Two rules keep the registry honest, and both are S11's. Every `term` must occur at least once in
the tree, because a canon word nobody uses is a canon nobody adopted; and no `term` may appear in
any row's `banned` list, because a registry that contradicts itself cannot arbitrate anything.
Adding a term needs the row alone — the direction the axioms want. **Retiring** one needs the row
plus the mechanical sweep in the same commit, because a `banned` word with live occurrences is
gate RED by construction, so the registry can never run ahead of the code even by accident. That
asymmetry is the same shape as floor additions versus extractions (§Change control).

## Foundation law

The foundation is not "the code we did not convert". It is a small set of **pillars**, each
admitted by a test, each carrying an obligation, and each named in a machine-readable registry
([`REGISTRY.md`](REGISTRY.md) §Pillar inventory). This section is normative: it is the law an
agent applies before touching floor code, and the reasoning a floor-addition ADR must show.

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
- every registry is **machine-readable** and checked in both directions: the pillar inventory,
  the floor rows, the lexicon, the `cssFamilies` register, the device-local register and the gate
  contracts in `REGISTRY.md`, the live roster at `GET /api/plugins`, the schemas at
  `GET /api/protocol`.

A pillar that cannot be read as data is a pillar that cannot be audited, and an unauditable
foundation is indistinguishable from a privileged core — which A1 denies exists.

### Every runtime-joined namespace has a registry (the LAW)

**A namespace whose two halves are joined at RUNTIME, by matching strings, gets a registry and a
gate check — or it rots invisibly.** This is the generalization the gate's checks were each
discovered by, one incident at a time, and it is stated here so the next one is designed rather
than suffered.

The failure mode is specific and it is always the same. Two parties agree on a name; neither
holds a reference to the other; the compiler sees a string on each side and has nothing to
compare. Rename one side and nothing breaks at build time — the join simply stops happening.
The write goes to a key nobody reads, the click fires an action nobody publishes, the rule
paints a class nobody has, the gate queries an element nobody renders, the log line names an
event no consumer greps. **Every one of these is silent**, and silence is what makes it a law
rather than a preference: a boundary violation is loud, a broken runtime join is not.

So the rule has two obligations and both are mechanical. **A registry**: the namespace's members
are enumerated as DATA — in this file, or in one exported table — so a stranger's agent can read
what the names are without reading every producer. **A check in BOTH directions**: every literal
in the tree resolves to a registry row (soundness — no unrecorded name), and every registry row
is exercised by something live (liveness — no stale row). One direction alone is half a gate: a
soundness-only check blesses a registry that has quietly become fiction, and a liveness-only
check cannot see the name somebody added yesterday.

Each of these is one instance of the law, and none of them was foreseen — each was written after
the join it guards had already broken once, and each is inventoried with the check that guards it
([`REGISTRY.md`](REGISTRY.md) §Runtime-joined namespaces).

The corollary is a design instruction, not just an audit rule: **prefer a join the compiler can
see.** A registry is what you owe when the join genuinely cannot be typed — because it crosses
the wire, the DOM, a stylesheet, a database or a process boundary — and S14's producer half is
the worked example of the preference in action, where `LogEvent` makes the emitting side a
compile error and the check exists only for the CONSUMER half, which lives inside string
literals in gate scripts where no type reaches. When you find yourself adding the second string
literal that has to equal a first one somewhere else, the law has already applied.

### The portable lens

**The client is a lens onto an instance, and the browser is the baseline host.** The web floor
stays browser-pure: no Electron, Node, or otherwise host-specific import anywhere above
`packages/web`'s entry, and no assumption that the server it talks to is the origin it was served
from — the instance is configurable, because a lens that can only look at its own birthplace is not
a lens.

Native capabilities — filesystem access, OS notifications, tray, deep window integration — may
arrive **only as host-composed plugins through the same manifests**, registered by whatever shell is
hosting the lens. Two consequences follow, and both are already the plugin rules rather than new
ones: a host that lacks a capability composes a workspace where that plugin is simply absent, and
absence looks exactly like any other disabled plugin (`REGISTRY.md` §Disable semantics — a named,
inert placeholder, data retained), so no feature is ever conditionally compiled and no surface
silently degrades. **A fork of the client is never the answer.** A shell that needs different
behavior contributes plugins; if it needs the lens itself to change, that is a change to the one
lens every host shares.

### Growing the foundation

Growing the foundation means **editing the pillar registry**, in the same commit as the code, with
a dated ADR in `docs/decisions/` that applies the litmus test criterion by criterion. The litmus
is the admission criterion reviewers apply; the registries are the mechanism that makes an
unrecorded crossing fail the gate rather than a review. Shrinking the foundation — moving a pillar
or part of one into `packages/plugins/*` — needs only the registry edit and the code: that is the
direction the axioms want.

## Change control

- **The registries are the mechanism of record.** A file that becomes floor or stops being floor
  is a registry edit — the pillar inventory and the `floor` rows in `REGISTRY.md` — in the same
  commit as the code. So is a new device-local key, and so is a new or retired WORD
  (`REGISTRY.md` §Lexicon). `verify:axioms` reads
  every registry in both directions, so an unrecorded crossing fails `bun run gate` rather than a
  review.
- **A new term needs the `REGISTRY.md` §Lexicon row alone; RETIRING one needs the row plus the
  sweep**, in the same commit — a `banned` word with live occurrences is gate RED by
  construction, so the registry
  can never run ahead of the code. Same asymmetry as floor additions versus extractions, for the
  same reason: the cheap direction is the one the axioms want.
- **Floor ADDITIONS need a dated ADR in `docs/decisions/` in the same commit**, applying the
  litmus test (§Foundation law) criterion by criterion and naming the pillar the file joins. The
  floor is meant to shrink; growing it is a decision, not a diff.
- **Extractions need only the registry edit.** Moving a feature out of the floor into
  `packages/plugins/*` is the direction the axioms want; it costs a registry line and the code.
- **Axiom text and the plane rule change by operator ratification only**, recorded here with the
  wave that carries it. An implementer who finds a decision absent from this file and from
  `docs/PLAN.md` has found a bug in the plan, not an open question.
- **A registry row is not an amendment.** `REGISTRY.md` is enforcement data: a row lands in the
  SAME commit as the code it indexes, the gate is its reader, and editing one changes nothing in
  this file. Where a row is contested, the reasoning is a dated ADR in `docs/decisions/`; where
  the change would alter what the law SAYS, the amendment happens here first and names its
  ratification, and the row follows in the commit that implements it.
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
