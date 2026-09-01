# 0011 — Authority is a waterfall of grants on the node tree

Date: 2026-08-31
Status: designed 2026-08-31, **landed 2026-09-01** (wave 4, #77)

Lexicon addendum 2026-08-31 (#69): this record is history and is not rewritten; the names it
cites moved in the lexicon cut. `padScope` is `containerScope`, `padId` is `containerId`, and
the subtree grant a token's scope stands for is at `manifold://container/<id>` rather than
`manifold://pad/<id>`. The degenerate cap array it describes reads
`containers:read` / `containers:write` / `scenes:write` / `terminals:spawn` / `terminals:write`
today. Canon is `REGISTRY.md` §Lexicon.

## Context

Axiom A4 (sovereign nodes) says every node has one owner, one home, and one canonical
`manifold://` address, and that composition mounts live references through capability-scoped
pipes rather than absorbing what it shows. Axiom A5 says authority follows the same tree:
permission is granted at a node and flows downward.

Today's model is flat. A token carries a `Cap[]` and an optional `padScope`, and
`AuthContext.allows(cap, padId)` answers every authority question in the server — 27 audited
call sites, reached either directly or through the `HttpApp.requireCap` funnel. That model
cannot express the things the axioms require: "this agent may write this one element", "any
human in this room may read but not write", "this share is a subtree of that pad, portable to
another instance". It also cannot express a denial, only the absence of a grant.

The plugin engine (ADR 0010) intersects a caller's capabilities with an action's declared
capabilities at the door. That intersection is orthogonal to _where_ the caller's capabilities
come from and survives this change untouched. What changes is the left-hand side of the
intersection: a flat token cap set becomes an evaluated, node-relative cap set.

This decision records the full evaluator design now, because wave-1 code must not preclude it
and because the wave-1 shape (flat caps plus `padScope`) is deliberately built as the
degenerate case of the design below. Nothing here is implemented in wave 1; `auth.ts` is
registry-tagged as the evaluator seam and that is the entire wave-1 footprint.

**Dependency duty (per ADR 0010's D14 policy):** before this evaluator is hand-built, `casbin`
and `CASL` must be evaluated by name — candidates, code and maintenance saved, opinionation
cost — and the verdict recorded in this file. Authorization is not a manifold-specific pattern
in general; what may be manifold-specific is the node-tree walk and the `manifold://`
addressing it rides on. That is a judgement to make with the code in front of us, not now.

## Decision

### The grant row

Authority is stored as rows, not as fields on tokens. The future SQLite `grants` table (its
migration is reserved, not written) holds:

```ts
type Grant = {
  id: string;
  principal:
    | { kind: "principal"; id: string }
    | { kind: "any-human" }
    | { kind: "any-agent" }
    | { kind: "instance"; origin: string }; // federation, reserved
  node: string; // a manifold:// URI; the root grant node is "manifold://"
  caps: Cap[];
  effect: "allow" | "deny";
  reach: "node" | "subtree";
  createdBy: string;
  createdAt: number;
};
```

A grant is data. It names _who_, _where_, _what_, _allow or deny_, and _how far down_. It never
names an action: actions declare the capabilities they need, grants grant capabilities, and the
two meet at the door.

### Evaluation

```ts
effectiveCaps(principal, nodeUri): Set<Cap>
```

Walk the containment path from the root to the node — workspace → pad → tile or element —
resolved from the same stores the census reads. At each depth, collect the rows that match:
a `reach: "subtree"` row applies from its node downward; a `reach: "node"` row applies at its
exact node only.

Precedence is deterministic and total, applied in this order:

1. **Deeper node beats shallower.** A grant at the element wins over a grant at the pad, which
   wins over a grant at the workspace root.
2. **At equal depth, specificity of principal:** principal-specific beats class-wildcard
   (`any-human`, `any-agent`), which beats instance-kind.
3. **At equal specificity, `deny` beats `allow`.**
4. **Ties break by `createdAt`, newer wins** — purely so the relation is total and evaluation
   is never order-dependent on row insertion.

The resulting set feeds the same capability intersection the doors already perform. Nothing
downstream of `effectiveCaps` changes shape.

### Doors

One evaluator call replaces `AuthContext.allows(cap, padId)` at its 27 audited call sites.
That is the single seam, and keeping it single is the point: authority must not be re-derived
per feature. The plugin engine's declared-capability intersection (ADR 0010) is unchanged and
sits on top of the evaluated set, not beside it.

### Tokens become grant references

Today's token fields are re-read as grants rather than replaced by a parallel system:

- A token's `caps` array is a set of **synthesized root grants** — `reach: "subtree"` at
  `manifold://`.
- A token's `padScope` is a **subtree grant at `manifold://pad/<id>`**.
- A **share** is a token minted against a subtree grant at the shared node, for a foreign
  principal. It is portable precisely because it is data: the same reference-and-pipe shape
  holds whether the node's home is this instance or another (A4).

The existing attenuation rule carries over unchanged: a minted grant set must be a subset of
the minter's effective set at every node it names. Minting cannot manufacture authority the
minter does not hold at that node.

### Non-goals of this design

- **No negative-capability arithmetic beyond `deny` rows.** There is no "allow everything
  except", no cap subtraction expression language. A denial is a row.
- **No per-action grants.** Actions declare capabilities; grants grant capabilities. Admitting
  per-action grants would create a second authority vocabulary beside capabilities, which is an
  invariant-14 violation.
- **No UI this wave, and none implied.** Grant administration is a later plugin (`core.access`
  in `REGISTRY.md` §Full-conversion inventory), not part of the evaluator.

## Landed 2026-09-01 (wave 4, #77)

The body above is the ratified design and is not rewritten. This section records what SHIPPED:
the duty §Context imposed as a precondition, the shapes that exist in the tree, the four places
implementation decided something this file left open, and the questions it is not this wave's
place to answer. A design record whose implementation moved is a design record that lies.

### 1. The dependency duty, discharged: `casbin` and `CASL` were evaluated, and neither was taken

§Context makes this a precondition on writing a line of evaluator code, so it is discharged
first. Both libraries were installed, read at source, and RUN under this repo's Bun (node-casbin
5.51.1, published 2026-06-25; `@casl/ability` 7.0.1, published 2026-07-06 — both actively
maintained, both Bun-clean, casbin's `fs` use lazy and injectable and its `.conf` avoidable via
`newModelFromString`). The question was never whether they work. It was whether this design's
four-rule precedence is a special case of what they model, and it is not.

**Two findings decide it, and both were verified by running the libraries rather than by reading
their marketing.**

_Deny precedence is the wrong shape in both, in opposite directions._ casbin's default
allow-and-deny effect (`some(where (p_eft == allow)) && !some(where (p_eft == deny))`) makes deny
UNCONDITIONALLY dominant and short-circuiting: a named principal's `allow` at a deep node loses
to a class-wide `deny` at a shallow one. That is precedence rule 3 outranking rules 1 and 2,
which is exactly the inversion this design rejects — under it, "everyone in this room except her"
is unsayable. It becomes expressible only by switching to `e = priority(p_eft) || deny` and
packing depth, specificity, effect and recency into one sortable integer ourselves. CASL errs the
other way: `cannot` is not dominant at all, only order-dependent, so the same sentence is natural
— but only after we sort the rows into the right declaration order first, which is the comparator
again.

_Neither library owns the two hard parts, and both add a third._ The hard parts of this evaluator
are (a) the total order over (depth, specificity, effect, `createdAt`) and (b) the syntactic
`manifold://` containment walk. **Both must be hand-written under either library.** casbin's
`keyMatch` family returns booleans and extracted substrings, never a specificity score; with two
matching rules at equal priority the deeper one does not win, the first-listed does. Its
`subjectPriority` effect orders only by SUBJECT role-graph depth from `g` edges, never by
resource path depth. Modelling containment at all means materializing `g2` resource-role edges —
an inheritance table to keep synchronized with the node tree, which §Alternatives rejected already
refuses under the name "role tables". CASL has no hierarchy concept whatsoever: a subtree is a
`$regex` condition, and conditions need the resource OBJECT, not a URI — passing a bare type
returns `true` OPTIMISTICALLY for a non-inverted conditional rule, so a URI string handed in as a
subject would silently over-permit. What adoption adds is an impedance layer: casbin's positional
`ptype, v0..v5` string rows to flatten our typed row into and a custom `bun:sqlite` adapter to
write (its core ships none), or CASL's per-credential `Ability` instances, since `can()` takes no
request-side extra parameter and cannot express "this row applies to this credential only".

Two further facts, each disqualifying on its own for this workspace. **Revocation is not free
under casbin:** it holds policy in memory, and deleting a grant row in our own table is NOT seen
by `enforce()` — it answered a stale `true` until an explicit `loadPolicy()`. "Revoke a grant and
the next request sees it" is this design's §Alternatives-rejected ruling against mount-time
evaluation, and it would arrive as a cache-coherency chore. **Neither resolves per capability:**
both answer one `(action, resource)` question at a time, so `effectiveCaps` becomes N calls where
one containment walk suffices. CASL's `actionsFor()` looks like the missing primitive and is not
— it lists action names without evaluating allow, deny or conditions.

One verified defect is recorded because it bears on how this workspace would have used casbin:
runtime `addPolicy()` under an explicit-priority model misorders rows and returns WRONG answers
(`Model.addPolicy` compares priorities as strings and tests `priorityIndex === -1` where it means
`insertIndex === -1`, so `splice(-1, 0, rule)` inserts before the last element instead of
appending). Bulk load is unaffected; runtime minting is not, and this workspace mints at runtime.
The public workaround is calling `sortPolicies()` after every add. Recorded as a fact about the
integration cost, not as an argument that the project is unhealthy — it is not.

**Verdict: hand-built.** Both libraries would leave us writing the comparator and the containment
walk, and would take in exchange a policy DSL nobody asked for, a stale-cache invariant to
maintain, and N evaluator calls per question. The saved code is the row-matching loop.

**What we gave up, stated plainly, because a verdict that lists only the wins is a sales
pitch.** casbin's `Watcher` is a real multi-process cache-invalidation story and this workspace
has none — the epoch counter of §3 is in-process, which §8 item 4 records as one member of a
queue this workspace already had rather than as a new fault. casbin also ships introspection
(`getImplicitPermissionsForUser`) we now do not have. CASL's
`rulesToQuery` compiles permissions into a database `WHERE` clause, which answers "list the nodes
this principal may read" — a question our evaluator cannot answer without walking everything, and
one a grant-administration UI will eventually ask. CASL is also built to serialize a rule set to
the browser so a client can decide which affordances to offer; a server-only evaluator forecloses
that, and if that need arrives, revisiting CASL for the CLIENT half alone — with this evaluator
staying authoritative on the server — is the honest reopening, not a rewrite.

### 2. What shipped, and what this file left open

Every shape in §The grant row is in the tree verbatim (`packages/protocol/src/grants.ts`), with
one representational decision this file did not make: **`node` is a `manifold://` URI STRING, and
`ManifoldRefSchema`'s seven forms are untouched.** The root is the bare scheme
(`MANIFOLD_ROOT_URI = "manifold://"`), which is not one of the seven and did not become an eighth
— growing the ref union would have changed a wire type shared by events, placement and resolution
for a node only the authority table names. `containmentPath` derives the walk syntactically from
the URI, so evaluation resolves no store to build a path.

**Grant administration is `core.access`, as §Non-goals said — and that is all §Non-goals said.**
It named the plugin and specified nothing about the doors, so the three that shipped are a
derivation, recorded here rather than assumed. `core.access.grant`, `core.access.revokeGrant` and
`core.access.listGrants` are **`scope: "workspace"` and root-only (`caps: ["*"]`)**, with
`revokeGrant` declared `cleanup: true`.

- Workspace grading is FORCED, not chosen: the argument is a node URI that may be the root
  itself, and a container-scoped token is scoped to a local container id the root is not inside.
  This is `dialShare`/`openDial`'s reasoning verbatim (ADR 0014).
- Root-only is STRICTER than `mint`, and the reason is `deny`. Minting attenuates monotonically —
  §Tokens become grant references carries that rule over unchanged — but a deny row takes
  authority away from somebody else, and by precedence rule 1 a deny at a container beats an allow
  at the root. A container-scoped `tokens:mint` holder could otherwise deny the workspace owner
  inside the owner's own container. **This file defines attenuation for minting and says nothing
  about attenuating a denial**, so the unwritten rule was read narrowly. Grading these
  `tokens:mint` later widens the door without moving it: no argument, result or refusal changes
  shape. It is the first entry in §8.
- No new capability was invented. `*` and `tokens:mint` already answer "who may hand authority
  out"; a `grants:manage` would be a second answer to one question (invariant 14).

**Invariant 10 verdict: NO protocol bump.** `PROTOCOL_VERSION` stays 18 and all three
compatibility sets are untouched. No session, machine or instance frame changed shape; the grant
vocabulary reaches clients solely through the live action roster and `GET /api/protocol`'s
`actions` block, both discovered at runtime rather than negotiated. A client that never learned
the new doors behaves byte-identically, which is the test the invariant actually asks.

**The seam held, and it is checkable rather than asserted.** `AuthContext.allows` kept its
signature and every one of its 27 call sites; `http.ts`, `session-ws.ts`, `event-hub.ts` and
`core.presence`'s server half have zero diff bytes, and `plugin-host.ts` is 16 insertions and 0
deletions — the three `ctx.identity` lines the new doors need — with both of its `allows()`
invocations byte-identical. The refusal vocabulary did not change either: a caller who lacks a
capability at a node is still rung 4, still `<cap> capability required`.

### 3. The evaluator as built

`effectiveCaps(context, nodeUri)` is public on `AuthService` and is the whole evaluator;
`allows(context, cap, containerId?)` is one question asked of it. Four things about it are
decisions rather than transcription, and none of them is visible from §Evaluation alone.

**A nodeless question is asked at the credential's ANCHOR, not at the root.** `allows` takes an
optional container id, and roughly a third of its call sites omit it — `auth.ts`'s own mint
checks, `event-hub`'s workspace read, `enrollMachine`. Under the flat model, omitting it SKIPPED
the scope comparison, so a container-scoped agent asking "may I mint" was answered yes. Mapping
the absent argument to the root would have refused that, because a scoped credential's row lives
at its container and the root is not below it — and it would have broken the delegated mint
`packages/testkit/e2e/auth.test.ts` exists to prove. So the absent argument means "at the only
place this credential can act": the root for an unscoped credential, `manifold://container/<id>`
for a scoped one. This is not a compatibility shim. It is what the question means, and the flat
model's skipped comparison was the same sentence said with less vocabulary.

**Precedence resolves PER CAPABILITY, not per row.** §Evaluation gives a total order over rows,
which reads as though one row wins outright; it cannot, and the reason is `deny`. A deny row
naming `scenes:write` at a container has to beat a `*` allow at the root for that one capability
while leaving `containers:read` exactly where it was. So a row enters the contest for capability
`c` only if it MENTIONS `c` — a row carrying `*` mentions every capability — and the winner's
effect is the answer for `c` alone. Eight contests, one per capability in `CAPS`, each over the
handful of rows on the path.

**`*` is expanded, never carried.** §Evaluation types the result `Set<Cap>` and `Cap` includes
the wildcard, but a set containing `*` cannot express "all of them except the one denied here",
which is precisely what a deny at depth beneath a root wildcard has to mean. So the returned set
holds concrete capabilities only, and `isRoot` — which is cap-derived and unchanged — stays the
separate question it always was.

A fifth key was added to the order §Evaluation states: after `createdAt`, the row **id**. That is
not a new rule, it is the rule this file already gives. §Evaluation adds `createdAt` "purely so
the relation is total and evaluation is never order-dependent on row insertion", and two rows
written in the same millisecond leave it partial again. At that point both carry the same effect,
so the key decides which row is CITED and never what the answer is.

**Memoization per credential, invalidated by an epoch — which is not the caching §Alternatives
rejected rejects.** That rejection is about caching authority INTO a composition, where
revocation becomes a restart. An `AuthContext` is not a composition: it is one authentication —
one request, or one channel on one socket — and it already froze the credential's caps and scope
at the moment it was created, with a live socket whose token is revoked closed by the revocation
fence rather than by re-reading its authority. Memoizing verdicts per context therefore adds no
staleness that was not already there, for exactly as long. What WOULD be new staleness is a grant
row written while a socket is open, and a process-wide epoch counter refuses it: every grant
write bumps it and every cached verdict in the process is discarded unread. This is load-bearing
for cost, not elegance — `doc_update` asks an authority question per frame, and under the flat
model that was an array scan. It is now a map lookup, with the SQL walk paid once per node per
credential. The cache is a `WeakMap` keyed by the context object, so a closed socket's verdicts
leave with it and no registry has to be told.

One consequence worth stating because it is observable: an administered `allow` written while a
socket is open WIDENS that live credential without re-authentication, and an administered `deny`
narrows it. That is A5 taken literally — authority is granted at a node, not carried by a
bearer — and it is what makes the grant doors worth having before any UI exists.

### 4. Deviation: a token's row applies to its own credential

§Tokens become grant references says a token's caps ARE a set of synthesized root grants. Read
literally against a table keyed by principal, that sentence has a hole: two tokens for one
principal produce two rows for that principal, and nothing in this file says the narrow token
may not read the broad token's row. It would — which is both a parity break against the flat
model and a live attenuation hole, since a minter's deliberate withholding would be undone by a
row minted for somebody else's credential.

So the shipped rule is: **a grant row REFERENCED BY A TOKEN applies only to the credential that
references it; a row no token references applies to every credential of the principal or class it
names.** The reference is a `tokens.grant_id` column (and `shares.grant_id`), on the referrer
rather than in a join table, because each credential references exactly one row — a token's
authority is one cap set at one node — and putting it on `tokens` means `authenticate` learns it
from the row it already fetched, so the hot path gains no query. `AuthContext` carries it as
`grantId: string | null`, null for the owner key.

This is a strict addition to this file, not a contradiction of it, and it is what makes parity
EXACT BY CONSTRUCTION rather than by inspection: after migration 13 every row is
token-referenced and every token references exactly its own, so the evaluator's row set for any
credential is precisely the authority that credential was issued. It also leaves the grant doors
fully live, because the rows they write are unreferenced by definition.

The alternative considered and rejected was an intersection: evaluate the principal's rows, then
clamp by the credential's own. It reaches the same answers for every case in the parity matrix
and one different answer elsewhere — an administered `allow` would never widen a live credential,
only permit a future mint — which would have left `allow` rows with no observable effect this
wave and made the grant door's more useful half unreachable. One mechanism, one filter, and the
widening behaviour that A5 actually describes.

### 5. Deviation: the owner is undeniable by evaluation, not by veto

This one is a correction, and both halves are recorded because the wrong one is the instructive
part.

The problem: a `deny` beats a shallower `allow` by rule 1, and the owner key's root authority is
the shallowest thing in the workspace. A deny row at a container therefore outranks it there. The
owner key authenticates outside the token system precisely so that no administration can lock out
its own administrator, and a row that could do it at depth would make that promise conditional.

The guard that shipped first refused, at the write, any deny row whose principal MATCHED the
owner. It was wrong in both directions. Too broad: the owner is a human, so it refused
`{ kind: "any-human", effect: "deny" }` outright, deleting class denials for humans — which is
the single sentence class principals exist for ("any human in this room may read but not write",
§Context) and the thing rule 2's ordering above rule 3 exists to enable. And too weak: a class
row walks around a name-matching veto anyway, so it was not even the guarantee it read as.

The shipped split puts each half where it can hold:

- `AuthService.grant` refuses a **principal-specific** deny naming the owner
  (`{ kind: "principal", id: ownerPrincipalId }`). An explicit, futile write is refused loudly
  rather than silently ignored.
- The **evaluator** drops `effect: "deny"` rows when the subject IS the owner principal. Class
  denials are admitted for every population, humans included, and slide off this one subject.

That makes the owner undeniable BY CONSTRUCTION rather than by a write-time veto, and it is the
same ruling as the synthesized root grant applied to the other half of the relation: owner
authority is a property of the evaluator, not a row that has to win a precedence fight. The
synthesized grant is itself deliberate for the same family of reasons — a STORED owner row would
be a row `revokeGrant` could delete — and it is gated on the credential being the owner's, not
merely on its having no token id, so a future construction site that forgot a token id cannot
inherit the workspace root from a check that only asked about tokens.

The narrow consequence, stated so nobody discovers it: deny rows cannot narrow a credential that
acts as the owner principal. Such a credential's ALLOW set is still clamped by its own token row,
so it cannot exceed what it was minted with; it is narrowed by minting it differently or by
revoking it, not by a denial.

### 6. Migration 13 and the parity matrix

**Migration 13**, `migrateToGrantRows` in `packages/server/src/migrate-grants.ts`, `backup: true`.
It creates `grants` with §The grant row's nine columns and nothing else — nothing hashed, no
`revoked_at` — adds `tokens.grant_id` and `shares.grant_id`, indexes
`grants(principal_kind, principal_id, node)`, `grants(node)` and `tokens(grant_id)`, and then
materializes what already exists:

- **every token with non-empty caps** → one `subtree` `allow` at `manifold://` (unscoped) or
  `manifold://container/<id>` (scoped), principal `{ kind: "principal" }`, `createdBy` its
  `minted_by` or, where none was recorded, its own subject; `createdAt` the token's own. This is
  §Tokens become grant references read literally. Revoked tokens are materialized too: a revoked
  token is refused at authentication long before any walk, so its row can never fire, and a
  filtered table would be a filter somebody later has to remember.
- **every LIVE share** → one `subtree` `allow` at its container addressed to
  `{ kind: "instance", origin }` (§7).
- **a token carrying `[]`** — an enrolled machine's, whose authority is to BE a machine rather
  than to act as a principal — gets no row, because a grant granting nothing answers no question.
- **a revoked share** gets no row, which is the same rule `revokeShare` applies going forward.

Ids are DERIVED, not minted: `grant-token-<tokenId>`, `grant-share-<shareId>`. A migration has no
`RuntimeDeps`, and derivation is better here anyway — re-running produces the identical table, and
an operator reading `grants` sees which credential each row answers for without a join.

It is CODE rather than SQL for a reason that is not stylistic: `node` is a percent-encoded
`manifold://` URI, and only `formatManifoldUri` may produce one. A SQL
`'manifold://container/' || container_id` would agree with it for every id this server has ever
minted and disagree silently for one holding a `/` or a `%` — which is not a formatting nit but a
grant no walk can ever find, i.e. authority that quietly vanished. It is `backup: true` as a
deliberate widening of `db.ts`'s stated criterion, which owes a snapshot only for a one-way data
move: this move is additive and owes none. It takes one because of what a mistake here LOOKS
like — not corrupt data an operator can read, but a workspace that refuses every request, the one
class of failure whose cause is invisible in the rows.

**The parity matrix** is `packages/server/test/grant-parity.test.ts`, and it is the reason this
wave is claimable at all. The contract is that every credential answers every authority question
identically across the migration — not similarly, and not for the cases somebody thought of — so
it is proved the only way an evaluator rewrite can be: the PRE-ADR body of `allows` is kept as a
frozen ORACLE (`flatAllows`), deliberately duplicating deleted code rather than importing
anything, because an oracle sharing an implementation with its subject agrees by construction and
proves nothing. A full matrix is diffed against it in one comparison, so a regression reports
every divergent cell at once.

Dimensions: **7 credential shapes × 8 askable capabilities × 4 node arguments.** The credentials
are the owner key, a bootstrapped `*` token, an unscoped delegate, a container-scoped agent, a
share ticket (scoped AND foreign-origin), a `[]`-caps token, and a NARROW second token for the
same principal as the wildcard one. The node arguments are the four shapes the argument actually
arrives in: absent, the credential's own container, another container, and a container that does
not exist — the last because the flat rule never resolved the tree and the walk must not either.
Both halves run: once against a hand-seeded schema-12 database migrated by `openDatabase`, and
once against credentials minted through the real ladder on a fresh database, so an upgrade and a
re-mint cannot disagree about the same token.

Asserted beside the diff: that the matrix contains BOTH answers, since an all-false matrix would
pass the comparison and prove nothing; the two cells most worth naming (a wildcard reaching a
container nothing told it about, a scoped credential refused at somebody else's); that the narrow
token does not inherit its principal's wildcard (§4, tested directly rather than argued);
row materialization exactly — seven rows, their ids, nodes, caps, effect and reach, the instance
row's origin, and every token's `grant_id`; that a revoked token still refuses; that a machine
secret still authenticates as a machine and is refused as a principal bearer; that `revokeShare`
retires its row; and the undeniable-owner ruling of §5.

A second suite in the same file covers what the flat model could not SAY, and therefore what the
matrix cannot see: a `deny` at an element biting one capability through a root wildcard while
leaving the rest, a `reach: "node"` row not descending to what its node holds, a named allow
outranking a class deny at equal depth, an administered allow widening a live `AuthContext` whose
verdicts were already memoized, and an instance row sitting out a local principal's walk.

### 7. Shares are grants, and `principal.kind === "instance"` is no longer inert

§Revisit when named this as the one field wave 1 and wave 2 left inert, to be supplied by
cross-instance sharing. It is supplied. `mintShare` writes
`{ principal: { kind: "instance", origin }, node: "manifold://container/<id>", caps,
effect: "allow", reach: "subtree" }` in the same transaction as the share row, which the share
references by `grant_id`; there is no instant where one exists without the other. Ticket
attenuation is then grant subsetting BY CONSTRUCTION rather than by a second rule — a ticket is an
ordinary token minted with the share's caps at the share's node, so it cannot exceed the row its
share stands on, and §Tokens become grant references' "a minted grant set must be a subset of the
minter's effective set at every node it names" holds across an instance boundary without a
cross-instance special case.

`revokeShare` DELETES the row rather than marking it revoked. That asymmetry with tokens and
shares is deliberate and worth stating: a grant presents no credential, so there is no holder left
to refuse and absence IS the revocation; a token and a share keep `revoked_at` only because a
bearer secret already handed over has to keep being refused by name. The share row itself
survives, marked revoked, because an owner who cut a pipe still needs to see that they did.

The practical consequence is the one A4 wanted: a guest instance's reach over this workspace is
now a row an owner can READ, alongside every other row, in one `listGrants` answer — not a
property of a credential nobody can enumerate.

### 8. Settled by the operator, 2026-09-01 (#83)

The wave shipped while the operator was asleep and made several deliberately conservative calls
where this file was silent. They were collected as answerable questions in #83 and answered on
2026-09-01; that issue is closed and this is the settled record. Every answer below either keeps
what shipped or confirms it, so nothing in the tree changed to write this section.

**The stance: stay conservative until identity lands.** `core.access.grant`, `revokeGrant` and
`listGrants` **remain root-only** (`caps: ["*"]`, `scope: "workspace"`), and the deny-attenuation
rule is **deferred to the identity milestone** (#58, and the posture ratified in
[`0019-identity-posture.md`](0019-identity-posture.md)). The reason is the one the candidate rule
exposes: "a deny may only name capabilities the writer holds at that node, and may not name a
principal whose effective set there exceeds the writer's" is built out of two identity predicates —
_the writer_, and _a principal whose effective set exceeds the writer's_ — so the rule cannot be
stated more tightly than the identity model allows, and grading a door down on a rule that loose is
how escalation by denial arrives. Reading grants stays root-only with the writes for the same
reason rather than a separate one: the answer is the map of who holds what over this workspace, and
the delegate that cannot see its own authority is a cost accepted until there is an identity to
scope the read to. **Revisit trigger: ADR 0019's NOW items landing** — session expiry, the
principal/device list with revoke, and bootstrap audit — at which point the doors, the rule and the
`listGrants` shape are decided together in one change.

**`revokeGrant` keeps `cleanup: true`.** Removing an allow row while `core.access` is off is the
D12 case; removing a deny row restores authority, which is administration. The carve-out is
defensible only because the door is root-only — the one principal who can reach it could re-enable
the plugin anyway — so it is settled for exactly as long as the paragraph above holds, and it is
re-decided in the same change that ever grades the doors down.

**Confirmed as shipped, lower stakes.** Migration 13 keeps its pre-migration `backup: true`,
because a mistake in materializing authority does not look like corrupt data — it looks like a
workspace that refuses every request. `revokeGrant` stays a hard DELETE with no tombstone: a grant
presents nothing, so absence of the row IS the revocation, and the audit lives in the
`grant_created` / `grant_revoked` trail. `revokeGrant` keeps refusing a token-referenced row, so
"revoke a credential" has one door (invariant 14). `MAX_GRANT_ID_LENGTH` stays 160 rather than
narrowing the derivation. **No grant UI: door-only is the answer for now**, with the deferral
published in `core.access`'s manifest description (`grant UI: deferred, door-only`) where a
principal can read it, as AXIOMS.md §Change control requires. And the class-denial reversal is
acknowledged and its shipped split confirmed: the write refuses only a **principal-specific** deny
naming the owner, and the evaluator drops deny rows for the owner **subject** — so the one sentence
class principals exist for ("any human may read but not write") survives owner protection.

**Open, and not gated on identity.** Three items were not answered on 2026-09-01 and stay open
with what shipped: **cross-process invalidation** (single-process is the shipped topology; the
question is what invalidation this workspace wants, with revocation as its first customer and
grants as its second, since a second process would miss a REVOCATION before it missed a widened
allow); **mint-time grant awareness** (`mintToken`'s ladder is still flat caps and container scope,
so administered rows widen at evaluation and not at mint); and **element-grade `allows()` call
sites** (`reach: "node"` and element/tile rows evaluate correctly and are unreachable through the
seam, whose only node argument is a container — inventing a call site to justify the feature would
be the tail wagging the dog). Each belongs to the wave that first needs it.

## Alternatives rejected

- **Keeping flat caps plus `padScope` permanently.** It cannot express element-level authority,
  class principals, denials, or portable shares — all four are load-bearing for A4 and A5.
- **Per-feature authority checks.** The audits found authority already spread across 27 call
  sites; multiplying rather than funnelling them is how an authority model rots into a set of
  habits.
- **Role tables.** A role is a named cap set, which the grant row already expresses as data
  (one grant, several caps) without a second indirection to keep synchronized with the node
  tree.
- **Evaluating at mount time.** Rejected in ADR 0010 for the plugin engine and rejected again
  here for the same reason: authority is a per-request question, and caching it into a
  composition makes revocation a restart.

## Revisit when

Implementation begins (next wave) — at which point the `casbin`/`CASL` evaluation above must be
completed and recorded here before a line of evaluator code is written; or when cross-instance
sharing (wave 3) supplies real values for `principal.kind === "instance"`, which is the one
field of this design that wave 1 and wave 2 leave inert.
