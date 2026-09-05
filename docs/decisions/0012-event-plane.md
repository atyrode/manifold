# 0012 — The event plane: declared notifications emitted at the doors

Date: 2026-08-31
Status: accepted
Ratified: designed 2026-08-31, **landed 2026-08-31** (wave 2, #72 / #73)

Lexicon addendum 2026-08-31 (#69): this record is history and is not rewritten; the names it
cites moved in the lexicon cut. The sidebar section it names "Views" is the **Index** section
(`core.index`), and the topics it designs are `manifold://container/<id>` addresses rather than
`manifold://pad/<id>`. Canon is `REGISTRY.md` §Lexicon.

## Context

manifold has three planes and each one has a rule (the plane rule, `AXIOMS.md` §Axioms):
legality or effect depends on state the actor cannot see, or authority it does not hold →
**action**; a per-element edit whose worst-case merge a human accepts → **document** (Yjs);
state that dies with the connection → **presence**. Continuous streams — PTY I/O, cursor
motion, live drags — stay channel traffic, and an action fires at the _commit point_ of a
gesture, never per frame.

There is a gap those three do not cover: "something happened that a plugin wants to know
about, and nobody is editing anything." Wave 1 fills that gap with HTTP polling — the Machines
section polls every 5s, the Views section every 2s — which is the honest interim answer and an
obviously wrong permanent one. A2 makes it worse than cosmetic: a polled surface tells an agent
"the world may have changed up to five seconds ago", so agent and human do not observe the
same instant even though the axiom says every capability must be reachable identically.

The plugin manifest already reserves `contributes.events` (wave 1 writes the field and gives it
no consumer) precisely so this plane can arrive without a manifest change.

The failure mode to avoid is well documented: adding a general-purpose message bus to an
application that already has an authoritative mutation door produces two ways to change the
world, and the bus wins by being easier. Every design choice below exists to make that
impossible.

## Decision

A fourth plane — **events** — with the following normative shape.

1. **The engine emits; plugins do not.** Events are emitted by the engine at the doors it
   already owns: action dispatch, placement, node lifecycle, and roster change. A plugin
   declares the event kinds it originates via `contributes.events`, but the emission happens
   when the plugin's _action_ runs at the door, not by a plugin calling an emit API from
   anywhere in its code. Emission points are therefore auditable by reading the doors.
2. **Topics are nodes.** A topic is a `manifold://` URI. There is no separate topic namespace,
   no string convention, no wildcard grammar to invent — the addressing algebra already exists
   (ADR 0010's URI module, `REGISTRY.md` §Lexicon). This has a direct consequence: **subscribing
   is a read-grant question**, answered by the A5 evaluator (ADR 0011) against the topic's node,
   with no second authorization vocabulary.
3. **Subscriptions ride the session channel.** The transport is the existing WebSocket — a
   `subscribe` client frame and an `event` server frame, in the connection/channel frame
   categories the roster frame pioneered in wave 1. No new socket, no new endpoint, no new
   reconnect state machine; the SDK's one pool keeps owning dial, keepalive, and rejoin.
4. **An event never mutates.** An event is a notification. A plugin that wants to _do_
   something in response calls an action, which goes through the door, which performs the
   authority check, which emits the next event. **RPC-over-pubsub is banned**: no
   request/response correlation over events, no "command topics", no handler whose contract is
   "publish here to make something happen". If a thing changes the world it is an action.
5. **No queue semantics.** No offsets, no consumer groups, no acknowledgements, no replay, no
   delivery guarantees beyond "delivered to sockets subscribed at the time of emission".
   Catch-up is reading state — the same `GET`/join path a fresh client uses — never draining a
   backlog. Durable history remains the existing SQLite `events` table, which is an audit log
   read as a table, not a stream consumers position themselves in.
6. **Wave 2 replaces the polling with subscriptions.** The Machines and Views sections keep
   their moved UI verbatim; one fetch line per section flips to a subscription. That is the
   test of this design: if converting a polled section costs more than its data source, the
   plane is over-built.

**Dependency duty (per ADR 0010's D14 policy):** before an in-process emitter is hand-rolled,
small emitter libraries must be evaluated by name — candidates, code and maintenance saved,
opinionation cost — and the verdict recorded in this file. The likely finding is that the
in-process fan-out is a `Map<string, Set<listener>>` and that everything interesting lives in
the authorization walk and the frame plumbing, both of which are manifold-specific; but the
evaluation is owed in writing, not assumed.

**Dependency verdict, recorded at implementation (wave 2, 2026-08-31).** The candidates, by
name, with what each would have saved:

- **`nanoevents`** (~108 bytes brotlied; `on` returns its own unbind). The API is the closest
  fit of the four — an unbind-returning subscribe is exactly the shape both halves ended up
  with — and it would have saved the six lines that add a listener to a set and delete it again.
- **`mitt`** (~200 bytes, functional, `on`/`off`/`emit` plus a `"*"` listener). Saves the same
  six lines, plus a wildcard nobody wants here: the plane deliberately has no wildcard grammar,
  and shipping one would make "subscribe to everything" the path of least resistance.
- **`eventemitter3`** (~2 KB, Node's `EventEmitter` surface: `once`, listener counts, removal by
  reference). Saves the same six lines and adds `once`, which is a queue affordance in
  disguise — a subscriber that wants one event and then stops is asking for a delivery
  guarantee this plane refuses to make.
- **`emittery`** / **RxJS `Subject`**. Async iteration, operators, backpressure. This is a
  second scheduling model beside the socket's, and the ordering authority is the commit point,
  not a pipeline.
- **The platform's `EventTarget`.** No dependency at all, but it costs an allocation per
  notification (`CustomEvent`), erases types at the `detail` boundary, and answers questions
  about `capture`/`bubbles` that no topic has.

**Verdict: hand-rolled, and the evaluation is the reason rather than the excuse.** What every
candidate replaces is the `Map<key, Set<listener>>` — six lines, and the only part of this plane
that is generic. What none of them replaces is everything that made the work: the index is keyed
by a manifold:// ADDRESS and a match is a relation over the addressing grammar, not string
equality (`topicMatches`, `packages/protocol/src/events.ts`); admission is a read-grant walk
against the topic's node, re-discharged at delivery because a node's home can move under a live
subscription; emission is refused unless the assembly's declared-topics index says the emitter
owns the kind (`emitterMayEmit`, `packages/plugin/src/emit.ts`); and the fan-out's real job is
writing ONE serialized frame to N sockets whose subscriptions die with them
(`packages/server/src/event-hub.ts`, and the refcounted per-socket registry in
`packages/sdk/src/connection-pool.ts`). A library at the centre of that would be a six-line
saving wrapped in an API surface — `once`, wildcards, operators, listener counts — whose every
extra affordance is something this ADR spent its Decision section forbidding.

## Landed 2026-08-31 (wave 2, #72 / #73)

What shipped, recorded here because a design record whose implementation moved is a design
record that lies. Five shapes were decided at implementation and are normative from now on; one
of them is a deviation from this file's own wording, and it is written down as such rather than
quietly absorbed.

**1. The delivery relation is `topicMatches`, and it lives in the protocol.** Not string
equality, not a prefix convention: a relation over the addressing grammar
(`packages/protocol/src/events.ts`). A subscription to `S` receives an event on `T` iff `S` is
`T`, or `S` is `container/<c>` and `T` is `container/<c>`, `container/<c>/element/<e>` or
`container/<c>/tile/<t>` — SELF plus exactly the one hop the URI grammar itself states, since an
element and a tile have no identity outside their container while a terminal, a principal, a
plugin and an action are all roots. It is in the protocol because BOTH halves must decide with
it: the server picks the sockets, the SDK picks the handler, and a rule either side could not
evaluate would let the server deliver frames no client rule could route. The server narrows to
at most two candidate keys before asking, so the index is a prefilter and this relation is the
decider (`packages/server/src/event-hub.ts`).

**2. Collection addressing, and the rule that produces it.** An event is addressed to the most
specific node that exists both BEFORE and AFTER it. When the subject is being created or
destroyed, or has no `manifold://` form at all (a machine, a folder), that node is its
COLLECTION — `manifold://plugin/<owner>`, which is also the only plugin node `emitterMayEmit`
lets that plugin address. This is why §6's test is passed rather than argued: each of the five
polled feeds subscribes to exactly ONE collection topic
(`core.index` → `manifold://plugin/core.index`, both terminal feeds →
`manifold://plugin/core.terminals`, attendance → `manifold://plugin/core.presence`, machines →
`manifold://plugin/core.machines`), so converting a polled section cost one options change at
the call site and nothing else. The floor may not spell a plugin id, so the two ends name their
owners through a registration table each — `FLOOR_EVENT_OWNERS` in
`packages/server/src/assembly.ts` and `FEED_TOPICS` in `packages/web/src/assembly.ts`, the two
files already permitted to.

**2b. An emission is DELIVERED at two addresses: the node it named, and its door's collection.**
Clause 2 says where an event is addressed. This says who is reached, and it exists because clause
2's own sentence — "one subscription to a plugin's node is how a client watches everything that
plugin originates" — is false for the emissions that name a node. The placement door addresses
`item_placed` to the destination CONTAINER, which is right (the container exists before and
after, and a socket watching a room should learn that something landed in it) and unreachable by
the surfaces the commit actually moves: the index's top level and both terminal rosters are read
from chrome OUTSIDE every room they report on, `unplaced` is DERIVED from the containment graph,
and a placement births compositions whose ids no subscriber could have named in advance. While
those feeds still had a cadence the gap was invisible; once §6 traded the cadence for a
subscription it became "the index never resurfaces an unplaced terminal", which is how it was
found (`verify:terminal-mirror`, `verify:tile-drop`).

So `EventHub.fanOut` offers every emission at the named node and then at
`manifold://plugin/<emitter>`. It is one EMISSION, not two: one audit row, and one frame per
socket, because the audience is a set of sockets across both addresses with the named node
offered first. Each socket receives the frame under the address that REACHED it, so clause 1
still holds exactly — the SDK routes with its own copy of `topicMatches` and no second rule.
Authority is re-discharged against the SAME container at both addresses (clause 3), so the
collection narrows and never widens: a container-scoped token cannot hold a collection
subscription at all, and an unscoped one must still pass `containers:read` for the room the
commit happened in. The emission check is untouched — a plugin's own node is the one plugin node
`emitterMayEmit` always lets it address, so this reaches nowhere an emitter could not have
addressed itself.

The browser half's consequence is one line in `FEED_TOPICS`: a feed lists every node that MOVES
its reading, so the index watches `core.space` (placements) and `core.terminals` (a terminal is
born with a home composition and takes it away when killed) beside its own. And the canvas's
portal minimize became a PLACEMENT (`{kind:"element"} -> {kind:"unplaced"}`) instead of a
document-plane tombstone — an unplacement carried on the document plane is a commit the event
plane never sees, which is the same defect wearing the plane rule's clothes.

**3. Authority is discharged TWICE, and it is the same authority the resolve door uses.**
Subscribing is a read-grant question (§2), asked as `allows(context, "containers:read", <the
topic's governing container>)`. It is asked at SUBSCRIBE, so a socket does not grow state it may
never be told about, and again at DELIVERY per subscriber, because a terminal's home is mutable
under a live subscription and the guarantee has to hold at the moment the frame goes out. An
UNGOVERNED topic — `principal`, `plugin`, `action`, which is every collection — additionally
requires the token's container scope to be null: a scoped token's authority is a subtree, and a
node with no container above it is in nobody's subtree. The refusal is SILENT, logged as
`session_subscribe_forbidden` and never framed, because a per-topic answer would make the event
plane a permission oracle.

**4. Deviation: there is NO terminal → home-container hop for DELIVERY.** The design brief for
this wave had the fan-out resolve a terminal's home and deliver its news to that container's
subscribers. It does not. The store hop survives for AUTHORITY only, where it can only ever
narrow delivery. The reason is clause 1: a terminal is a grammar ROOT because it can be rehomed
and keeps its identity, so its container is a fact of STATE, and the SDK — which must route the
same frame with the same rule — cannot perform a store lookup. A store-based delivery hop would
therefore have the server send frames that no client-side rule could route, which is a
subscriber watching frames vanish. Terminal news still reaches every watcher because terminal
lifecycle is collection-addressed per clause 2, and the in-room half of the same news already
rides the session channel (`terminal_event`, attendance frames).

**Two mechanisms worth naming because they are what make §4 and §5 checkable rather than
aspirational.** Emission through the action door is STAGED: `ctx.emit` buffers, and the buffer
flushes only after the handler returned `{ ok: true }` and its own result schema parsed, so a
handler that mutates and then refuses, throws, or fails its schema publishes nothing —
"refusals are not events" is mechanized rather than left to handler discipline. And emission is
refused outright unless the assembly's declared-topics index says the emitter owns the kind
(`emitterMayEmit`, `packages/plugin/src/emit.ts`), which is how the vocabulary stays open while
the mechanism stays closed.

**The bill.** `REGISTRY.md` §Budgets network ceilings are ZERO at idle, and the gate proves the
zero is a subscription rather than a corpse by reading each feed's own report before it measures
(`verify:budgets`). `verify:axioms` R10 asserts the whole plane end to end: an event frame's
topic, kind and actor at an SDK peer, a browser's UI reflecting a third principal's mutation
inside one second with `reads.timer` still at zero, and a container-scoped token refused a
foreign collection in silence.

## Alternatives rejected

- **Keeping HTTP polling.** Two principals observe different instants, which is an A2
  violation with a stopwatch. It also scales by multiplying requests against a server that
  already holds an open socket to the same client.
- **A general message bus (queues, offsets, consumer groups, replay).** It is a second
  durability system beside SQLite and the Yjs document, a second ordering authority, and — the
  moment replay exists — a second way to apply changes. Catch-up by reading state is strictly
  simpler and already implemented.
- **Letting plugins emit arbitrary events from arbitrary code.** Emission would stop being
  auditable, and "publish to make something happen" would become the path of least resistance
  around the action door. Declaring event kinds in the manifest while emitting only at the
  doors keeps the vocabulary open and the mechanism closed.
- **A separate events WebSocket or SSE endpoint.** A second connection to authenticate,
  reconnect, and keep alive, for frames that fit in the frame categories the session channel
  already has.
- **Reusing Yjs awareness or document updates as the notification channel.** Awareness is
  connection-lifetime presence and document updates are durable edits; a roster change or an
  action completion is neither, and stuffing it into either plane is exactly the plane-rule
  violation this decision exists to prevent.

## Revisit when

Implementation begins (wave 2) — at which point the emitter-library evaluation above must be
recorded here first; or when cross-instance sharing (wave 3) needs events to cross a pipe to
another manifold, which is the first case where "delivered to sockets subscribed at the time of
emission" meets a network partition and the no-replay rule has to be restated rather than
quietly relaxed.
