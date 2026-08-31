# 0011 — Authority is a waterfall of grants on the node tree

Date: 2026-08-31
Status: designed 2026-08-31, implementation next wave

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
