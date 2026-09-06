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
it **landed 2026-09-01** (wave 4, #77 / PR #78) beneath `packages/server/src/auth.ts`, which the
registry tags as the one call surface it replaced — one seam, unchanged signature, and the
evaluator behind it.

**A6 — Every exercise of authority leaves a trace.** Authority that cannot be audited is
indistinguishable from authority nobody has. So every dispatch at a door — granted, refused, or
broken — is recorded as a **trace**: one durable row, appended by the dispatch ladder itself and
never by a handler, carrying `ts`, the **actor** principal, the **authority** satisfied (the
capability set discharged, or `root`), the **door**, the **targets** the door named as
`manifold://` refs, the **payload** of arguments, the **outcome** (`ok`, the denial rung, or
`failed`), and the **origin** it came from. **Refusals are traced**: a denial is the answer an
audit most needs and the one nobody thinks to keep. A trace is a row in the workspace's ONE
journal, read through the ONE door that already reads it (`core.events.list`) — never a second
audit surface — and the ledger is written AHEAD of the effect: the attribution commits before a
handler can mutate anything, so a committed mutation with no trace is not a state this engine can
reach. Secrets and terminal bytes are redacted from a payload by the same rule that redacts them
from the log, because a ledger that leaks a credential is a worse artifact than no ledger.
**The exemptions are these three and no others, each because it is not an exercise of authority
at a door**: presence, which is never persisted and dies with its connection; continuous streams
— PTY bytes, cursor motion, live drags — whose LIFECYCLE is traced because opening, taking and
killing are doors, while the bytes themselves are exempt by invariant 5; and document-plane
deltas, whose authority is discharged at the socket and whose commit point is a batch, to be
traced as attributed batches when that batch has an attribution (the seam is named in
[`docs/decisions/0018-trace-ledger.md`](docs/decisions/0018-trace-ledger.md)). An unregistered
action name is not an exemption from tracing an exercise — it is the absence of one: no door, no
authority, nothing to attribute, and a caller-chosen name the ledger must never let a stranger
write. It is recorded in the structured log instead. The record, the placement, the guarantee
achieved per door class and the staged path to tamper-evidence are normative in
[`docs/decisions/0018-trace-ledger.md`](docs/decisions/0018-trace-ledger.md); the completeness
check is `REGISTRY.md` §Gates (T1-T5), and a registered door that yields no trace is gate RED.

**"One door per concept" is not a seventh axiom.** It is an engineering law and lives as
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
[`docs/decisions/0012-event-plane.md`](docs/decisions/0012-event-plane.md) and **landed in wave
2** (#72, #73): protocol v17's `subscribe`/`unsubscribe`/`event` frames, emission at every
commit point the engine already owns, and `contributes.events` with live consumers. A plugin
joins it by declaring the kinds it originates and emitting through `ctx.emit` at its own action's
door; the ADR's "Landed" section records the shapes that shipped.

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
- **Wave 2 — the event plane** (ADR 0012, #72 / #73). Landed: protocol v17 (`subscribe`,
  `unsubscribe`, `event` — connection-level, structured `ManifoldRef` topics, snake_case declared
  kinds), emission at the doors the engine already owns (action dispatch staged behind the
  handler's own success, placement, node lifecycle, roster and attendance change), read-grant
  admission discharged at subscribe AND at delivery, and real consumers for `contributes.events`.
  It replaced the HTTP polling of all five shared feeds — the container index, both terminal
  listings, attendance and the machine roster — each becoming ONE subscription on the owning
  plugin's collection node, with the moved section UI untouched and only the feed's options
  changed. `REGISTRY.md` §Budgets network ceilings are now zero at idle and `verify:axioms` R10
  puts a stopwatch on the claim. The wave-1 roster frame may later be re-expressed as an
  always-on subscription over the mechanism it itself pioneered; the frame shape is unchanged
  either way.
- **Wave 3 — cross-instance sharing** (A4, ADR 0014, #74). Landed: protocol v18 and the
  **instance channel** (`/ws/instance`), a guest instance dialing OUT to a host with a share
  token under the machine channel's own discipline — version-negotiated against its own
  acceptance set, hello-carried resume, one liveness scheme shared with the machine channel
  (`DIAL_PING_INTERVAL_MS`); **shares** minted and revoked through `core.access` as tokens bound
  to a node and addressed to a named guest origin, hashed at rest and carrying no expiry because
  revocation is the mechanism; and `Principal.origin` as an additive-optional datum whose
  absence means this instance. The projection is deliberately NOT new machinery: a guest's lens
  dials the HOST's existing session channel with a per-principal ticket — an ordinary attenuated
  token — so a remote viewer is another participant in the same room, fenced by the same
  revocation fanout, and there is no relay, no second sync path and no second renderer. Wave 1's
  reserved room was exactly right: the SDK pool keys connections by (factory, url, token), which
  IS the `(origin, containerId)` keying, so pointing a lens at a second instance needed no
  re-keying and no new client (§The portable lens).
- **Wave 4 — the permission waterfall** (A5, ADR 0011, #77 / PR #78). Landed: authority is grant
  ROWS on the node tree — `principal | class`, node by `manifold://` URI, capability set, effect,
  reach — walked root-to-node with deeper beating shallower, evaluated entirely beneath
  `AuthService.allows`, whose signature and all 27 call sites are unchanged. `effectiveCaps` is
  the whole evaluator and `allows` is one question asked of it; verdicts are memoized per
  `AuthContext` and discarded by a `grantsEpoch` bumped on every grant write, so an administered
  row widens or narrows a live socket on its next dispatch with no reconnect. `PROTOCOL_VERSION`
  stayed 18 — this wave moved no wire — and migration 13 materialized every existing token's caps
  into one subtree allow, so parity with the flat model is exact by construction. `AuthContext`
  gained exactly one field, `grantId`, which answers what a credential may do and never who
  presented it. The dependency duty was discharged before a line of evaluator code: `casbin` and
  `CASL` were installed, read at source and run under this repo's Bun, and **neither was taken**,
  with the verdict recorded in the ADR. Shares became grant rows in the same act, so
  `principal.kind === "instance"` is no longer inert (wave 3's one reserved field). Authentication
  did NOT move and is not in this wave's scope — that is #58, and its posture is
  [`docs/decisions/0019-identity-posture.md`](docs/decisions/0019-identity-posture.md).
- **The trace ledger — traceability made constitutional** (A6, ADR 0018, #93). Landed with the
  axiom: the ledger is a row family in the ONE journal (schema 14 widens `events` with `door`,
  `authority`, `targets`, `outcome`, `session`), appended by the dispatch ladder at the choke
  point every principal already goes through, WRITE-AHEAD of the handler so a committed mutation
  cannot exist without its attribution, settled exactly once, read through `core.events.list`
  with `kind: "trace"` and through no second door. Refusals are traced; the payload is redacted
  by the log's own field rule and bounded; unregistered names are ruled out of the ledger with
  the reasoning recorded. `verify:trace` is the completeness check and it dispatches every
  registered door against the real composed server. **The direction is operator-ratified
  (2026-09-01); A6's WORDING is presented for approval with this change**, which is the one
  thing the ADR does not decide (§Change control: axiom text changes by ratification only).
- **Later waves, each gated on its own dated ADR:**
  - **Permission waterfall follow-ups** (ADR 0011 §8, settled 2026-09-01, #83): the doors stay
    root-only and the deny-attenuation rule waits for the identity milestone, because both halves
    of the candidate rule are identity predicates. Cross-process invalidation, mint-time grant
    awareness and element-grade call sites stay open there too.
  - **Social layer — there is no `core.social` seat** (ADR 0015, ratified by the operator
    2026-09-01, which is the amendment this bullet carries). Matrix, XMPP and ActivityPub are
    rejected as the SUBSTRATE and not only as foundation, on the evidence in that file: **Matrix
    is demoted from ratified leading candidate to an optional third-party bridge that is never in
    the default distribution.** The five nouns this row used to promise are redistributed rather
    than seated — identity is #58's question and ADR 0019's posture, contacts are a local,
    asymmetric ledger on `core.access` keyed by ADR 0014's `(origin, ref)` pair, share-invitation
    signaling is wave 3's instance channel, and agent chat is a durable notification owed to the
    Notifications wave, never an event. Matrix stays **rejected as foundation** for the original
    reason: adopting it below the floor would install a second room model, a second event model
    and a second permission model beside manifold's own, and A5 plus the plane rule would then
    have two answers to every question. Nothing recognisably social ships in the default
    distribution; anything social is therefore third-party, and waits on the marketplace wave and
    so on ADR 0016's runner.
  - **Marketplace and dynamic plugin distribution** — plugin code that is not compiled into the
    build. The seams are already reserved: the manifest's `entry { web?, server? }` and the
    roster's `source` field. This wave also carries the explicit **core-plugin override**
    mechanism: replacing a core plugin is disable-then-enable-a-substitute by id, never a silent
    collision (A1 has no shadowing).
    **Distribution is gated on the install door, the hash pin and the installer's reading, not
    on a boundary; isolation is `install.hardened`, the installer's choice per row, and ADR
    0016's runner stands for hardened rows (ADR 0025, operator-ratified 2026-09-05).** That
    reverses the ordering this bullet carried until then — "it does not land before a dated
    isolation ADR ratifies a runner, and that is a hard ordering rather than a preference" —
    whose reasoning stands as history: everything in the tree was first-party code
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
    implements distribution on top of whatever it ratifies. ADR 0016 was ratified 2026-09-01
    and judges the runner as one OS process per isolated plugin on the server and one dedicated
    worker per isolated plugin in the browser; ADR 0025 keeps that runner as the installer's
    option and makes in-realm, with the full engine API, the default for every row.
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
    RUNNING workspace. ADR 0025 (operator-ratified 2026-09-05) makes this wave a peer of
    distribution rather than a consumer of an isolation runner: an agent writes a plugin into an
    unpacked directory on the instance and the hub loads it live, in-realm, behind developer
    mode — the work is #257. What this wave owes on its own is the authoring CONTRACT: a
    manifest an agent can generate, doors it can verify its own plugin through, and the failure
    modes stated as data rather than as a build log.
  - **App shells** — packaging manifold's client for hosts that are not a plain browser tab, and
    ADR-gated when it is built rather than sketched now. A **PWA pass is the near milestone**:
    installability, offline shell, and the origin-configurability the portable-lens rule already
    demands, with no client fork. For desktop, **Ratified (operator, 2026-09-01): Electron is
    confirmed** by [ADR 0020](docs/decisions/0020-desktop-shell.md) as a pinned runtime dependency
    with a CVE duty — because rendering predictability matters to the two surfaces manifold is
    hardest on (the React Flow canvas and xterm), which its own bundled Chromium gives, because
    `WebContentsView` embeds a real web view without re-implementing one, and because the local
    agent already fits the sidecar shape it packages well. **The ratification's one amendment
    (§6.3, acceptance claim 5): `verify:budgets` must hold inside the shell; a miss triggers the
    Tauri re-evaluation early.** **Tauri is
    re-evaluated at a native-mobile milestone**, where a system web view stops being a liability
    and binary size starts being one. Whatever ships obeys the portable-lens rule: a shell adds
    host-composed plugins, never a second client. **The ordering is ratified (operator,
    2026-09-01, #82): the PWA pass lands FIRST, and the desktop ADR is authored and ratified
    before any shell code exists** — no Electron directory, no packaging target, no sidecar
    wiring ahead of the record. #82 is that gate and stays open until the ADR does.

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
  outcome — and **traced**, one durable row on the workspace's journal, with the authority it
  discharged and the nodes it named (A6). The log is what an operator tails; the trace is what
  the workspace can be asked;
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
- **The living spec is the normative form of every ratified decision.** `REGISTRY.md`,
  `docs/CONTRACTS.md` and `docs/PLUGINS.md` — with this file above them — carry what a ruling
  SAYS; a record in `docs/decisions/` carries why it was made, what was weighed and what the
  evidence was, and its decision section summarizes and points at the spec section that carries
  it. Where the two disagree the spec wins and the record is stale, never the other way round:
  ratifying a record IS the spec edit, in the same PR, and a record no spec section carries has
  decided nothing yet. Records are immutable once written and status-first — the block under
  the title (`Date`, `Status`, `Superseded-by`, `Ratified`) is the one part that moves, and
  `docs/decisions/README.md` is generated from it (`verify:axioms` S19). Operator-ratified
  2026-09-05 (#248).
- **Precedence: axioms > spec (`REGISTRY.md`, `docs/CONTRACTS.md`, `docs/PLUGINS.md`) >
  decisions > scope notes.** This file's axioms and its foundation law outrank the spec; the
  spec outranks a dated ADR; an ADR outranks a scope note, a plan bullet, a roadmap row or a
  task brief. A lower rank may refine a higher one and may never contradict it — a record can
  only refine the spec, never overrule it. Operator-ratified 2026-09-05 (#248).
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
