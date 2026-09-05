# 0023 — Plugin topology: a nested id is a claim, a `required` edge on the parent is the proof

Date: 2026-09-05
Status: **PROPOSED** - drafted by an agent on the operator's direction, 2026-09-05; nothing here is ratified.

## Context

Two things say how plugins relate, and today nothing binds them. A `dependencies` edge is
ENGINE information — "B cannot serve unless A serves": a `required` target absent from the build
refuses assembly by name (`packages/plugin/src/assemble.ts:787-808`, thrown at `:827`), a target
that is merely off answers the door with `dependency_disabled` and a disable that would strand
dependents answers `missing_dependency` (`packages/server/src/plugin-host.ts:788-796`; the roster
row carries the same class, `assemble.ts:873-882`; the vocabulary is
`packages/protocol/src/plugin.ts:641-644`). A dotted id is HUMAN information: the leading segment
is the authority publishing it (`plugin.ts:17-20`), and `PLUGIN_ID_PATTERN` admits any depth
(`(\.[a-z][a-z0-9-]*)+`, `plugin.ts:22`) while the engine reads nothing into a third segment. A
reader of `core.canvas.draw` hears "draw is part of canvas; toggling canvas toggles the family;
draw has no life of its own" — a different sentence from the edge's, and nothing checks it.

The failure mode is drift: an id that reads nested with no edge, or its mirror, an honest edge
under a flat name. The mirror already ships — `core.draw` `requires` `core.canvas` with the reason
"strokes are canvas elements; without the canvas renderer the tool has no surface"
(`packages/plugins/draw/src/index.ts:30-35`) and is named as a peer. Every one of the nineteen
registered manifests (`packages/server/src/assembly.ts:78-155`) is two segments deep, so the tree
has never had to answer the question. It has to now: atyrode/code and atyrode/babel are being
shaped as a baseline plus independently enable-able parts (`atyrode.code`, `atyrode.code.generator`,
`.usage`, `.accounts`), each part carrying `required` on the baseline, and the engine has no parent
notion. This record says it needs none — beyond one assembly check that makes the id and the edge
agree.

## Decision

### 1. Two statements, two mechanisms, one consistency check

The edge stays the ONLY mechanism the engine acts on: ordering (`assemble.ts:794-822`), build
refusal, door refusal. Nesting is data on the roster: a naming discipline a principal and an
agent read, plus the manager's grouping (§9). The engine's whole knowledge of hierarchy is §2's
check that the two never disagree.

### 2. A three-segment id is a claim of home; the `required` edge on the parent is the proof

An id with three segments claims `parent = id minus its last segment` as its home. Assembly
REFUSES the claim without the proof: a new fatal assembly problem, `orphan_child`, naming the
plugin and the missing parent — `plugin "core.canvas.draw" claims a home under "core.canvas"
without a required dependency on it (orphan_child)`. It joins the structural problems no toggle can
fix (duplicates, squats, cycles: `assemble.ts:475-483`, `:775-785`) and is thrown with them
(`:827`); it is NOT a member of `PLUGIN_REFUSAL_REASONS` (`plugin.ts:656-667`), because those are
answered at a door where an actor can act, and no actor can act on this. The parent must be a
composed manifest; a parent missing from the build is already `requires plugin X, which is not
composed` once the edge exists (`:805-808`), so the new problem is only ever the missing edge. A
two-segment id claims nothing — its first segment is an authority, not a plugin (`plugin.ts:17-20`)
— and `engine.*` rows are builtin, not manifests (`plugin.ts:27-37`). The `core.` reservation is
untouched: `core.canvas.draw` must still be in the distribution set (`assemble.ts:553-561`).
Dependencies remain the mechanism for peers; the proof edge is an ordinary `required` edge, so
`dependency_disabled` and `missing_dependency` already say what a family does under a toggle.

### 3. Depth is capped at three segments

`publisher.product.part` or `core.<seat>.part`; a fourth segment is a design smell and is refused
by the schema. Proposed: `PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,2}$/`
(`plugin.ts:22`), and `BINDING_ID_PATTERN`'s prefix follows (`plugin.ts:775`), since its comment
defines every segment before the local one as a plugin-id segment (`:771-773`). What it breaks,
checked against every manifest and fixture at `main`: nothing shipped — all nineteen ids are two
segments; `packages/protocol/test/plugin.test.ts:752`, `:835` test two-segment ids; the one
three-segment id in the tree is a fixture (`core.index.tree`,
`packages/plugins/debug/test/identity.test.ts:136`) and still passes. `SettingRefSchema` is derived
from the pattern (`plugin.ts:823`) and tightens with it; the published manifest JSON Schema
(`plugin.ts:891`) changes its `pattern` string, which is protocol vocabulary and rides a
`protocol:` commit (invariant 10) that leaves the agent wire identical.

### 4. The litmus: part or peer

Nest under P iff **(a) NOUNS** — every contribution is about P's nouns (P's element kinds, tools,
tiles, catalog) and introduces no top-level noun of its own — and **(b) EXISTENCE** — with P
disabled it has NOTHING to do, not less to do. Otherwise it is a peer with an edge. §6 refines (a):
a contribution about a PEER's noun is an edge, not a disqualification — _nest where the child's
existence lives; edge where it borrows a noun._ Two nesting kinds are legitimate. EXTENSION: the
child adds to what the parent draws (`core.canvas.draw`). PRODUCT PART: the parent is a product
baseline owning shared state and doors, and the children are its faces, each free to own panels
(`atyrode.code` / `atyrode.code.generator` / `.usage` / `.accounts`). Split where the capability
ceiling or independent use genuinely differs; never deeper (§3).

### 5. Code layout is part of the claim

A child is a DIRECTORY inside its parent's package — `packages/plugins/canvas/draw/` — and never a
package of its own. npm allows exactly one slash in a package NAME, so `@manifold-plugin/canvas/draw`
cannot be a package; specifiers nest through `exports`. The parent's `package.json#exports`
extends the existing `.` / `./server` / `./web` convention (`docs/PLUGINS.md:36-48`) one level:
`@manifold-plugin/canvas/contract` (what children may import), `@manifold-plugin/canvas/draw`,
`@manifold-plugin/canvas/draw/web`, `@manifold-plugin/canvas/draw/server`. No hyphenated name, no
workspace-glob change (`package.json:5-8` stays), and the two scopes stay: `@manifold/*` is the
floor, `@manifold-plugin/*` is above it (invariant 12). Registration stays one plugin def per
plugin in the two assembly files (`PLUGINS.md:51-53`) — a child is its own roster row with its own
manifest, only its files live under the parent. The parent's `tsconfig.json#include` (`src`,
`test`: `packages/plugins/canvas/tsconfig.json:8`) widens to the child's directories.

Import direction follows the tree. A CHILD may import its PARENT's published contract only —
`@manifold-plugin/canvas/contract`: element kinds, tool and registration types, vocabulary; never
runtime state or components. The PARENT NEVER imports a child: that is what makes "canvas without
draw" literally true. SIBLINGS and PEERS never import each other — doors only, as today: a plugin's
budget is the four floor packages (`PLUGINS.md:55-57`) and S2 fails any `@manifold-plugin/*`
specifier outside the importer's own name (`scripts/verify-axioms.ts:710`). S2 cannot see this
rule, on two counts: a child under `canvas/draw/src/**` importing `@manifold-plugin/canvas/web` has
its own owner's name and passes `:710`, and S2 scans only `<dir>/src/**` (`:706`), so the child's
files are not walked at all. Proposed **S18 — import direction follows the plugin tree**, on PATHS:
every source under a plugin package is walked; a file under `canvas/src/**` never imports
`canvas/draw/**` by path or by subpath specifier; a file under `canvas/draw/**` imports, of its
parent, only `@manifold-plugin/canvas/contract`; the `contract` module itself imports only the four
floor packages and no React or DOM name, so it cannot smuggle runtime; any other `@manifold-plugin/*`
edge stays S2's offence. RED names file and line, as S2 does.

Honest cost: a child's third-party dependencies live in the parent's `package.json`. Since plugins
may depend only on the four floor packages today (`PLUGINS.md:55`), a child needing a dependency of
its own is a signal it may be a peer. Isolated out-of-tree plugins are unaffected at runtime — they
import no in-tree code at all (ADR 0016 §3, `0016-plugin-isolation.md:226-231`) and their bundles
are self-contained; the same directory convention applies in their own repositories.

### 6. Text is its own noun: `core.text` and `core.canvas.note`

A document is first-class. Proposed: `core.text`, a standalone peer — own panel and route, own
storage, owner of the collaborative `Y.Text` — which must stay first-party and in-realm, because a
live `Y.Text` cannot cross the isolation boundary and `core.notes` is that ruling's worked example
(`0016-plugin-isolation.md:232-237`). The canvas integration becomes the child `core.canvas.note`:
a canvas ELEMENT KIND whose body is a text document, nested under `core.canvas` (no canvas → no
note: EXISTENCE) with the proof edge, and `required` on `core.text` as a PEER edge (BORROWED NOUN).
The `text` element's two placements today (`tileable` and `canvas_item`, `notes/src/index.ts:55-60`)
split the same way: a composition leaf that IS a document is `core.text`'s, a note on a canvas is
`core.canvas.note`'s; the canvas's `text` TOOL, which authors notes and lives in `core.canvas`
today (`canvas/src/index.ts:122-125`; `notes/src/index.ts:27-30`), moves to the child that owns
what it authors. The editor choice (Monaco versus CodeMirror 6) is a NEW runtime dependency and
needs its own dated decision under invariant 8 (`AGENTS.md:120-121`): this record obliges that
decision and does not make it.

### 7. The shipped roster under the litmus

Every `packages/plugins/*/src/index.ts` manifest read at `main` (contributions, edges, element
kinds); `packages/plugins/` prefixes elided. Verdicts are proposals.

| Plugin              | Candidate parent                                   | Verdict                                                    | Why (evidence at `main`)                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | -------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core.shell`        | —                                                  | peer (root)                                                | draws the workspace; `essential` (`shell/src/index.ts:50`). Nothing above it to nest under.                                                                                                                                                                                                                                                                                                                                  |
| `core.space`        | `core.shell`                                       | peer, recorded                                             | same package, split as a NAMESPACE decision: "the tree" and "the panels that fill it" are two concepts (`shell/src/index.ts:93-97`); `place` names containers, a noun beyond the shell's panels — NOUNS fails. Both essential (`:50`, `:134`).                                                                                                                                                                               |
| `core.plugins`      | —                                                  | peer                                                       | a UI over the roster with its own nouns — categories, filters (`plugin-manager/src/catalog.ts:33`); essential (`plugin-manager/src/index.ts:43`).                                                                                                                                                                                                                                                                            |
| `core.brand`        | `core.shell`                                       | peer                                                       | a rail non-negotiable split OUT of the shell on purpose (`shell/src/index.ts:24-28`); own section at order 1 (`brand/src/index.ts:31`).                                                                                                                                                                                                                                                                                      |
| `core.keys`         | —                                                  | peer                                                       | own noun (bindings) and own doors (`keys/src/index.ts:28-37`).                                                                                                                                                                                                                                                                                                                                                               |
| `core.access`       | —                                                  | peer                                                       | sessions, shares, dials — its own nouns and events (`access/src/index.ts:126`, `:148-151`).                                                                                                                                                                                                                                                                                                                                  |
| `core.events`       | —                                                  | peer                                                       | one read over the trace ledger, a floor noun (`events/src/index.ts:27-38`).                                                                                                                                                                                                                                                                                                                                                  |
| `core.index`        | —                                                  | peer                                                       | containers, folders, "the terminals inside them" (`index/src/index.ts:49`); essential (`:51`).                                                                                                                                                                                                                                                                                                                               |
| `core.machines`     | —                                                  | peer                                                       | fleet nouns and enrollment doors (`machines/src/index.ts:28-29`, `:56-59`).                                                                                                                                                                                                                                                                                                                                                  |
| `core.terminals`    | `core.canvas` / `core.compositions` / `core.index` | peer                                                       | own nouns, and homed in THREE places: born into a composition (`protocol/src/placement.ts:196-205`), listed by the index (`index/src/index.ts:49`), portalled onto a canvas (`placement.ts:198-199`; `canvas/src/index.ts:17`). EXISTENCE fails for every candidate.                                                                                                                                                         |
| `core.presence`     | —                                                  | peer                                                       | vantage and spotlight over any container (`presence/src/index.ts:21`, `:45-48`).                                                                                                                                                                                                                                                                                                                                             |
| `core.canvas`       | —                                                  | peer — a PARENT                                            | owns the `canvas` discipline (`canvas/src/index.ts:108-120`) and the `canvas` toolbar (`protocol/src/plugin.ts:256-257`).                                                                                                                                                                                                                                                                                                    |
| `core.compositions` | `core.canvas`                                      | peer of canvas                                             | owns the `composition` discipline (`compositions/src/index.ts:85-98`); renders with the canvas off. NOUNS and EXISTENCE both fail.                                                                                                                                                                                                                                                                                           |
| `core.draw`         | `core.canvas`                                      | **nest → `core.canvas.draw`** (EXTENSION)                  | element `draw` carries the default traits, `canvas_item` only (`draw/src/index.ts:39`; `placement.ts:172-176`); its tool rides the `canvas` toolbar (`draw/src/index.ts:40`; `plugin.ts:265-268`); the edge is already `required`, reason "strokes are canvas elements; without the canvas renderer the tool has no surface" (`draw/src/index.ts:30-35`). NOUNS and EXISTENCE pass; the id is the only thing that says peer. |
| `core.notes`        | `core.canvas`                                      | **split → `core.text` (peer) + `core.canvas.note` (nest)** | as shipped, a note is `tileable` as well as `canvas_item` (`notes/src/index.ts:55-60`), so the plugin has a life without the canvas (`:32-38`; `optional` edge `:46-51`) — EXISTENCE fails for the WHOLE and §6 splits it: the document is a noun, the canvas note borrows it.                                                                                                                                               |
| `core.uri`          | —                                                  | peer                                                       | a route in the shared URL space (`uri/src/index.ts:29`).                                                                                                                                                                                                                                                                                                                                                                     |
| `core.debug`        | —                                                  | peer                                                       | an inspector over identity, authority and traces (`debug/src/index.ts:47`).                                                                                                                                                                                                                                                                                                                                                  |
| `core.arrange`      | `core.space`                                       | peer, edge OWED                                            | tools ride the `arrange` toolbar (`arrange/src/index.ts:83-91`); stacks and spacers are the floor's `structure` kind (`placement.ts:243`); every write is `core.space.setLayout` (`server/src/assembly.ts:139-140`) with NO declared edge — an unstated dependency (ADR 0013 `:313-315`), not a nesting: declare `required` on `core.space`, inert while `core.space` is essential and honest regardless.                    |
| `core.commands`     | —                                                  | peer                                                       | opens other plugins' doors and declares none (`server/src/assembly.ts:145-146`).                                                                                                                                                                                                                                                                                                                                             |
| `engine.plugins`    | —                                                  | excluded                                                   | a builtin row, not a manifest in the assembly (`plugin.ts:27-37`); §2 speaks of manifests.                                                                                                                                                                                                                                                                                                                                   |

### 8. What nesting does NOT do

No capability inheritance: the ceiling is per manifest, and assembly checks every action's caps
against its OWN manifest (`assemble.ts:574-582`); the manager may show a family's union as
information, never as authority. Purge stays per plugin (`engine.plugins.purge` takes one id,
`packages/plugin/src/builtin.ts:138`; `DELETE FROM plugin_kv WHERE plugin_id = ?`,
`packages/server/src/stores.ts:833`). Storage stays per plugin id (`plugin_kv`,
`packages/server/src/db.ts:252-257`). Disable stays per plugin, with no cascade either way
(`assemble.ts:482-483`; ADR 0013 §5 rules 4-5).

### 9. Manager consequence

Roster rows group by parent inside the category they already group by (`catalog.ts:172-186`). A
disabled parent shows its children as `dependency_disabled` — the refusal the roster already
carries (`assemble.ts:880`; copy at `plugin-manager/src/web.tsx:60`). The one family control is
the parent's toggle. Because there is no cascade, pressing it with children on meets
`missing_dependency` naming them (`plugin-host.ts:790-791`), so the manager turns a family off by
dispatching the children's toggles and then the parent's, and on in the reverse order — N+1
traced dispatches through the one enablement door, no new door (invariant 14).

### 10. Migration cost is NOT this record's acceptance

Renaming a shipped id touches: the storage namespace (`db.ts:252-257`), the persisted disabled set
and attribution (`stores.ts:677-702`), element-type reservations (`$owner:<type>`, `db.ts:247-249`;
`assemble.ts:688-693`), every `data-action` literal (S4, `REGISTRY.md:2102`), the lexicon rows that
name `core.draw` (`REGISTRY.md:1303`, `:1309`; `cssFamilies` rows are keyed by stylesheet path,
`:1697-1698`, and move with the directory instead), R3 (`REGISTRY.md:2118`;
`verify-axioms.ts:4449-4481`) and the tests. That is a rename migration on the ADR 0013 ledger, in
a dedicated attended wave, and explicitly outside this record's acceptance. The rule binds every
NEW plugin immediately; code and babel are being shaped by it now.

## Alternatives rejected

- **Hierarchy without edges.** The engine is blind to it: `core.canvas` off leaves
  `core.canvas.draw` composed and serving, and the id lies to everyone reading the roster.
- **Edges only, flat ids forever.** The operator cannot toggle a family and cannot name a part
  honestly; every product ships as N unrelated seats (roster restraint, `AGENTS.md:229-234`).
- **An engine-level `parent` field in the manifest.** A second mechanism beside `dependencies`
  saying the same thing (invariant 14, `AGENTS.md:180-185`), and one that could disagree with it.
- **Capability inheritance.** A parent's ceiling handed down is a grant nobody wrote; the per-plugin
  ceiling is what makes "grant each part only what it needs" possible at all.
- **A nested workspace package (`packages/plugins/canvas/draw/package.json`).** Rejected by the
  operator: a hyphenated name, a widened workspace glob, and a package boundary where the tree has
  a directory boundary. Subpath exports say the same thing with nothing new.

## Tensions with landed decisions

Flagged, not resolved.

- **T1 — invariant 12** ("a feature lands as a package under `packages/plugins/*`",
  `AGENTS.md:159-166`): unchanged; a child lands under a package there. S5's package walk
  (`verify-axioms.ts:493`) is unchanged too, but its "every composed plugin maps back to a package"
  (`:886-890`) must accept a child mapping back to its parent's.
- **T2 — REGISTRY §Disable semantics D4′** (`REGISTRY.md:502-557`): the per-kind table is
  untouched. The refusals rule (`:539-546`) may want one sentence — "a family control is the
  parent's toggle; children meet `dependency_disabled`" — at ratification, not before.
- **T3 — ADR 0013 §5 rule 6** says the structural set "is closed" (`:343-345`); `orphan_child`
  grows it, so the ratifying commit owes 0013 an addendum. The regex in §3 is the kind of sentence
  0013 kept out of the dependency section on purpose (`:350-355`).
- **T4 — AXIOMS A1** (`AXIOMS.md:23-39`): nesting is data on the roster, not mechanism in the
  engine — except §2, which is the first time assembly reads meaning into an id's segments beyond
  the two reserved prefixes. One check, structural, fatal, in the D5 style; it should be said out
  loud that this is the whole of it.
- **T5 — S2** (`verify-axioms.ts:706-731`) is a ratified check that S18 amends, not extends: the
  own-name rule at `:710` becomes a path rule.

## Work this obliges (filed as issues by the orchestrator)

1. S18 import-direction check and the `orphan_child` assembly refusal, with §3's regex.
2. The `contract` subpath convention and `core.draw` moved under `core.canvas` as the first nested
   child — `packages/plugins/canvas/draw/`, id `core.canvas.draw` — as the rename-migration wave
   (§10), plus `core.arrange`'s owed edge.
3. `core.text` extracted from `core.notes` and the editor dependency decision (§6).
4. atyrode/code and atyrode/babel adopt the layout in their own repositories.

## Revisit when

- Version ranges arrive on dependencies (ADR 0013 `:350-355`, `:990`): a proof edge with a range is
  a different sentence and may need its own word.
- A fourth-level need appears twice. Once is a smell; twice is a rule that was wrong.
