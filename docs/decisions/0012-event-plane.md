# 0012 — The event plane: declared notifications emitted at the doors

Date: 2026-08-31
Status: designed 2026-08-31, implementation wave 2

## Context

manifold has three planes and each one has a rule (the plane rule, `AXIOMS.md` §Axioms):
legality or effect depends on state the actor cannot see, or authority it does not hold →
**action**; a per-element edit whose worst-case merge a human accepts → **document** (Yjs);
state that dies with the connection → **presence**. Continuous streams — PTY I/O, cursor
motion, live drags — stay channel traffic, and an action fires at the *commit point* of a
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
   when the plugin's *action* runs at the door, not by a plugin calling an emit API from
   anywhere in its code. Emission points are therefore auditable by reading the doors.
2. **Topics are nodes.** A topic is a `manifold://` URI. There is no separate topic namespace,
   no string convention, no wildcard grammar to invent — the addressing algebra already exists
   (ADR 0010's URI module, `AXIOMS.md` §Taxonomy). This has a direct consequence: **subscribing
   is a read-grant question**, answered by the A5 evaluator (ADR 0011) against the topic's node,
   with no second authorization vocabulary.
3. **Subscriptions ride the session channel.** The transport is the existing WebSocket — a
   `subscribe` client frame and an `event` server frame, in the connection/channel frame
   categories the roster frame pioneered in wave 1. No new socket, no new endpoint, no new
   reconnect state machine; the SDK's one pool keeps owning dial, keepalive, and rejoin.
4. **An event never mutates.** An event is a notification. A plugin that wants to *do*
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
