# 0018 — The trace ledger: traceability as a constitutional property of the dispatch ladder

Date: 2026-09-01
Status: accepted
Ratified: ratification-ready — the mechanism is landed and gated (#93); axiom A6's TEXT awaits the operator's final wording approval, which is the one thing this file does not decide.

## Context

Four axioms make authority the centre of the design and none of them makes it accountable. A2
says every capability is reachable identically by a human and an agent; A5 says authority is a
waterfall of grants; the plane rule says a mutation whose legality depends on unseen state is an
ACTION, dispatched at one door. So every exercise of authority in manifold already passes through
one function — `PluginHost.run`, the denial ladder — and until this change that function's only
durable record was a log line on stdout.

A log line is not accountability. It is unaddressed (nobody can read it through a door), it is
not durable (a rotated stream is a deleted audit), it is not attributable to a node (no
`manifold://` topic, so no grant governs reading it), and it is invisible to A2's agent half: an
agent can drive every door and cannot ask what was driven. Meanwhile the workspace already had a
durable journal — the `events` table, written since migration 1 and read since `core.events.list`
— carrying exactly the wrong half of the story: it recorded the CONSEQUENCES a door announced
(`terminal_opened`, `token_minted`, `grant_created`) and never the EXERCISE (who was allowed
what, and how it ended).

The gap is at its worst where it matters most: a refusal left no durable trace at all. A workspace
cannot answer "who tried to open my terminal and was told no", which is the first question an
operator asks and the last one a permission model should be unable to answer.

The operator's push, ratified in direction: traceability stops being a feature somebody could
forget and becomes constitutional — an axiom, woven mechanically at the choke point, with a gate
that fails RED when a door escapes it.

## Decision

**A6 — every exercise of authority at a door leaves a trace.** The normative text is
`AXIOMS.md` §Axioms; the mechanism is below.

### 1. A trace is a row in the ONE journal, not a table and not an API

The trace family lives in the `events` table, widened by five nullable columns (schema 14:
`door`, `authority`, `targets`, `outcome`, `session`), with `type = 'trace'` as the family
marker and `door IS NULL` meaning "an ordinary event row". Read back through
`core.events.list` — the door that already reads the trail — with `kind: "trace"` selecting the
ledger.

The alternative shape is a `traces` table with its own door, and every argument against it is
invariant 14. A second table means a second retention policy (the journal is pruned to 30 days,
10,000 rows per container and 100,000 container-less rows — that last ceiling is NEW here,
because A6 turned a rare family common: a workspace-grade dispatch's trace belongs to no
container, and those arrive as fast as a door can be called, so the 30-day window alone stopped
being a bound. One pruning got one more clause; two prunings would have drifted), a second read door
with a second authority ruling (`core.events.list` is root-only for a reason that applies
verbatim to traces: the trail carries other principals' activity and no cap in the vocabulary
means "may read other people's history"), and a second place to look when answering one
question. The journal family is also the honest data model: an event and a trace are the same
kind of fact at different grain — "this happened here" versus "this principal was allowed to
make it happen" — and the lexicon already said so before this change, in `event`'s own `means`
row ("the durable audit row of the same name is the same word for the same thing, read as a
table").

The `targets` column is the one thing published PARSED rather than as stored text, and the
asymmetry with `payload` is the producer count: `payload` has as many shapes as there are
writers, so a schema over it would publish a contract nobody signed, while `targets` has exactly
one writer — the ladder, serializing `formatManifoldUri` — so an array of strings is what it is.

### 2. The record, and its vocabulary

One row per dispatch that reaches a registered door:

| word          | column         | what it holds                                                                     |
| ------------- | -------------- | --------------------------------------------------------------------------------- |
| **ts**        | `ts`           | the runtime clock at the moment the door was resolved                             |
| **actor**     | `principal_id` | the acting principal; never null, because a dispatch always has one               |
| **authority** | `authority`    | `root`, or the declared caps discharged (`containers:write`), or `open`           |
| **door**      | `door`         | the full action name as the roster publishes it                                   |
| **targets**   | `targets`      | the `manifold://` nodes the door named, JSON array                                |
| **payload**   | `payload`      | the arguments as received: redacted, bounded, JSON text                           |
| **outcome**   | `outcome`      | `TRACE_OUTCOMES` — `ok`, `failed`, or the denial rung; NULL means still in flight |
| **origin**    | `session`      | the session the dispatch arrived on; NULL means the HTTP action door              |

Two of these need their wording defended.

**`authority` is `root` for a root caller, not the door's demand.** A root credential passes
every rung by being root, so recording `containers:write` would name a grant nothing consulted.
When ADR 0011's evaluator can report WHICH grant row decided, this column becomes that row's id;
today `allows` answers a boolean, so the cap name is the most precise honest answer available.
`open` is the third value and it exists so that "this door demands nothing" is stated rather than
inferred from a blank column.

**`origin` is a concept with two carriers, and the column is named `session`.** Where a dispatch
came FROM is the session channel it arrived on — and for a remote actor, the instance it belongs
to, which is already a fact about the actor (`principals.origin`, wave 3) rather than a second
column here. The column is not called `origin` because that word is taken: in this codebase
`origin` means an INSTANCE origin, and a second sense for one word is exactly what the lexicon
law forbids (invariant 16). NULL is information rather than a gap: a dispatch over
`POST /api/actions/:name` carries a credential, not a connection.

**Targets come from the staging buffer**, which is why this weave needs no plugin cooperation. A
door that changes a node already declares which node at its commit point (`ctx.emit`, ADR 0012
§2); the ledger reads that same statement instead of asking every handler for a second one. A
door that names nothing has no targets, and that is a true row: its subject was the workspace, or
its answer was a refusal.

### 3. Placement: write-ahead at the choke point

The ladder writes the row in two moves, and the ORDER is the mechanism:

1. **The attribution, before the handler runs.** Everything above except `outcome` and `targets`
   is a fact about the caller and the door, decided once, immediately after the action entry is
   resolved. It is INSERTed there — so by the time a handler can reach the store, its own trace
   is already committed.
2. **The settle, once the outcome is known.** `UPDATE ... WHERE id = ? AND outcome IS NULL`
   writes the outcome and the targets. The `WHERE` clause is the whole enforcement of
   exactly-once: no retry, no later rung and no bug can rewrite a recorded answer.

Rungs that refuse ABOVE the handler skip step 1's split entirely — they already know the
outcome, so their row is one settled INSERT.

**The settle precedes the flush.** A successful dispatch settles its outcome before the staged
emissions go out, so no subscriber can be told about a commit whose trace is still unsettled.

**An unsettled row is not a defect; it is the one thing a crash can say.** A process that dies
mid-handler leaves a row that reads "this principal was allowed through this door, and we never
learned how it ended" — which is exactly what happened, and strictly more than a ledger written
after the fact could report.

### 4. Unknown actions are NOT traced, and this is a ruling

`unknown_action` — a name that no registered door answers to — leaves no row. Three reasons, in
order of weight:

1. **Nothing was exercised.** There is no door, no declared capability, no authority discharged
   and nothing to attribute. A6 traces exercises of authority; a name nobody registered is a
   typo or a probe, not an exercise.
2. **The name is caller-chosen and unbounded.** Tracing it would make the `door` column a field
   any client can write arbitrary words into, and would let a stranger drive unbounded rows into
   a durable, pruned, root-readable table. An audit ledger with a caller-controlled writer is a
   denial-of-service surface wearing an accountability badge.
3. **It stays observable where every dispatch already is.** The ladder's structured `action` log
   line reports it at `outcome: "unknown_action"`, which is the floor's self-description
   obligation doing its job (`AXIOMS.md` §Foundation law). `verify:trace` T5 asserts both halves:
   no row, and the log line.

Every OTHER rung is traced, refusals included — which is the whole reason the ledger cannot share
a transaction with the mutation (§7).

### 5. What must never reach the ledger

The payload is written through `redactFields`, the same field rule the JSONL log has always
applied: names matching `token|key|authorization|secret` are dropped (invariant 6 — no bearer
secret anywhere), and `data|env|payload|terminalData` are dropped (invariant 5 — terminal bytes
are never persisted). One rule, one place, two records.

A per-action `redact` declaration was rejected: it is a second vocabulary a door author must
remember to fill in, and the cost of forgetting is a credential in a durable table. The name rule
fails the other way — an innocent field called `key` is dropped from a record — which costs an
auditor one field and costs nobody a secret.

The payload is also BOUNDED (4 KiB). Over the bound the row keeps the shape instead of the bytes:
`{ oversize, keys }`. Arguments are caller-controlled, so an unbounded copy of every dispatch body
is a door onto the disk; and "somebody called this door with something enormous" is the auditable
fact, which the shape carries.

### 6. Exemptions, listed rather than implied

A6 names its exemptions in its own text, because an unstated exemption is indistinguishable from
a hole:

- **Presence** is never persisted (invariant 5), so it has no trace to keep. Its authority is
  discharged at the socket, and its whole content dies with the connection.
- **Continuous streams** — PTY bytes, cursor motion, live drags — are channel traffic by the
  plane rule. Their LIFECYCLE is traced, because the lifecycle is actions: `core.terminals.open`,
  `take`, `kill` are doors and every one of them lands in the ledger. The bytes themselves are
  exempt by invariant 5 and always will be.
- **The document plane.** A Yjs delta's authority is discharged at the `doc_update` frame's cap
  check, and its durable commit point is the debounced snapshot flush, which is neither
  single-actor nor door-keyed. It is exempt, and the upgrade is named below rather than pretended.

### 7. The guarantee, per door class, honestly

| door class                                                                     | placement                                        | what is guaranteed                                                                                                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| rungs above the handler (`plugin_disabled`, both `forbidden`s, `invalid_args`) | one settled INSERT at the rung                   | atomic in itself (single statement); durable BEFORE the caller is told                                                                   |
| handler doors that write the store                                             | INSERT before invoking, settle after the outcome | the attribution is durable before the handler can touch the store, so a committed mutation is never untraced; the settle is exactly-once |
| handler doors that write nothing                                               | identical                                        | identical                                                                                                                                |
| a handler that throws                                                          | settle `failed`                                  | the attempt survives the failure, including when the handler's own transaction rolled its mutation back                                  |
| unregistered names                                                             | none, by ruling (§4)                             | observable in the structured log                                                                                                         |

**What is NOT claimed: the trace does not share a transaction with the handler's mutation.** The
brief for this change asked for same-transaction atomicity where a handler writes SQLite, and it
is not what shipped. Two reasons, and the first is the axiom's own text:

1. **Atomic-with-the-mutation and traces-every-refusal are incompatible requirements.** A trace
   that rolled back with its mutation would erase exactly the rows A6 insists on — the refused
   attempt and the door that mutated and then threw. Rollback-together is the wrong property for
   a ledger; ORDERING is the right one, and ordering is what is built.
2. **The transaction cannot span the handler anyway, and buying it would cost the workspace.**
   Handlers are `async`; `bun:sqlite` transactions are synchronous, so a ladder-owned transaction
   around an awaited handler means holding the connection's write lock across the await — across
   a machine round-trip, in `core.terminals.open`. Every other writer in the workspace would
   queue behind one slow door, and a hung broker would freeze durable state entirely. Serializing
   dispatch to make the lock safe has the same cost by another route.

The residual difference between write-ahead and same-transaction is one case: a mutation that
commits and then has its dispatch fail leaves a trace saying `failed` rather than leaving no
trace at all. That is the more truthful record of both.

### 8. Mechanical completeness (the gate)

`bun run verify:trace` (in `bun run gate`, static pool — it spawns a server, not a browser):

- **T1 — one writer.** `appendTrace`/`settleTrace` are called from the store that defines them
  and the ladder that uses them, and nowhere else, walked with the TypeScript parser. A trace
  written from a third place would be an attribution no dispatch stands behind.
- **T2 — every rung, by construction.** Every `{ ok: false }` denial literal inside
  `PluginHost.run` must write the ledger in its own statement block; exactly one may not, and its
  rule must be `unknown_action`. This is the STATIC half of coverage and it is the important
  half: a rung added tomorrow without a trace fails here, whether or not anybody thinks to
  dispatch it. Plus the vocabulary join — every denial rung except the exempt one is a member of
  `TRACE_OUTCOMES`.
- **T3 — every registered door, live.** Against the REAL composed server, every action in
  `GET /api/plugins` is dispatched and the ledger is required to contain a row naming it; a door
  without a trace is RED. No per-door fixture is needed, because every door's input is a
  `z.strictObject`, so one sentinel argument refuses at the argument rung and nothing is
  created or destroyed. It also asserts that the ONLY unsettled row is the reading door's own
  in-flight dispatch, which is the write-ahead observed in production rather than argued.
- **T4 — the ok path and a rung.** A real `core.index.createContainer` must leave an `ok` row
  carrying its actor, authority and targets; an attenuated token must leave a `forbidden` row.
- **T5 — the exemption, both halves.** The unregistered name leaves no row and one log line.

## Staged reversibility

The ledger is deliberately the cheapest thing that is honest, and the next three steps are
ordered by what each one buys:

1. **Inverses (next, and cheap).** A trace records what was asked and how it ended, not how to
   undo it. The doors whose effect is expressible as another door's arguments can record that
   inverse in the row (`payload.inverse`), which turns the ledger into an undo log for the subset
   where undo is meaningful. It is additive: a column-free convention inside a JSON payload the
   ladder already writes. Gate it on a door DECLARING its inverse, never on the ladder guessing.
2. **Replay (needs a decision, not just code).** Replaying a trace range is a second way to
   change the world, and ADR 0012 §5 already banned that shape on the event plane for the reason
   that applies here too. Replay may only ever mean "re-dispatch through the door, with the
   authority evaluated again NOW" — never "re-apply the effect". If it is ever built, it is a
   plugin over `core.events.list` plus the action door, and it needs no new floor.
3. **Merkle / signed segments (deferred, with conditions).** Tamper-evidence — hash-chaining rows
   and signing segment roots — is what turns "the ledger says" into "the ledger can prove". It is
   deferred because it buys nothing against the threat model this instance has today: single
   owner, single trusted host, an operator who can already write the SQLite file directly. Revisit
   when any of these becomes true: (a) a share reaches a principal whose instance the owner does
   not control AND traces cross that pipe; (b) an instance is operated by somebody other than the
   principals it records — a hosted deployment; (c) a trace is ever offered as evidence to a party
   who did not run the process. Any of those makes the chain load-bearing; none of them is true
   yet, and hash-chaining a table that its own operator can rewrite is theatre.

## Named first follow-up: attributing the document plane

The exact seam, so this is a deferral rather than a gap:

- **Where.** `Room.flushSnapshot` (`packages/server/src/room.ts`) is the document plane's durable
  commit point, and `this.doc.on("update", (update, origin) => …)` in the same file already
  receives the contributing principal id as the Yjs `origin` — `Y.applyUpdate(this.doc, update,
peer.auth.principal.id)` at the socket. Collecting those ids per flush window and writing ONE
  attributed batch row at the flush is a contained change in one file.
- **Why it is not in this change.** The trace record is single-actor and door-keyed; a flush is
  neither. Writing it into the trace family would put rows in the ledger whose `door` column is a
  fiction, and widening `actor` to a set on a guess is the kind of vocabulary change an axiom
  should not make before it has a reader. The volume question is real too: a flush fires per quiet
  window per active room, so the batch family needs its own retention answer rather than
  inheriting the per-dispatch one.
- **What it would say.** `{ rev, bytes, contributors: [principalId…] }` on the container's node —
  an attributed batch at a commit point, which is exactly the phrase A6's exemption uses.

## Alternatives rejected

- **A dedicated `traces` table with its own read door.** Two retentions, two authority rulings,
  two places to look, one concept — invariant 14, and the journal family is the truthful model
  anyway (§1).
- **Same-transaction atomicity with the handler's mutation.** Incompatible with tracing refusals
  and failures, and unbuyable without holding the write lock across an await (§7).
- **Tracing inside each handler.** Per-plugin discipline is exactly what an axiom must not depend
  on: coverage would be an intersection of thirty authors' attention instead of a property of one
  function, and the gate's static half would have nothing to assert.
- **A trace frame on the event plane.** Subscribable traces would double every emission and make
  the plane a surveillance feed; the trail's read door is already root-only for that reason.
- **A per-action `redact` declaration.** A second vocabulary whose failure mode is a secret in a
  durable table (§5).
- **Tracing only mutating doors.** "Mutating" is a judgement about a door's verb, and a read is
  an exercise of authority too — the first question after a leak is who READ what. Tracing every
  dispatch costs one row and removes the classification from the mechanism entirely.
- **A new `LogEvent` for the ledger.** The `action` line already reports every dispatch with the
  same outcome word; a second name for the same fact is invariant 16 debt, and the ledger is the
  durable half rather than a second log.

## Revisit when

- The operator's wording review lands, which is the one open item (this file's Status).
- ADR 0011's evaluator can report the deciding GRANT ROW: `authority` becomes that row's id and
  the cap name becomes its detail (§2).
- The document plane's attributed batch is built (the follow-up above), at which point A6's
  exemption list loses a line.
- Any of the three tamper-evidence conditions becomes true (§Staged reversibility, 3).
