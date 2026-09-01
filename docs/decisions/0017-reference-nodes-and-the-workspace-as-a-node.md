# 0017 - Reference nodes: seats, cursors, and the workspace as an ordinary node

Date: 2026-09-01
Status: PROPOSED (awaiting operator ratification; ratified items become law, deferred items stay listed here)

## Context

The sidebar decomposition (#85) proved the shell was only partly composed: chrome was floor
JSX, the arrange surface covered one registry, and the workspace tree was a special structure
beside the composition discipline rather than an instance of it. While ratifying the fixes,
the operator pushed the question to its root: if everything is a plugin and everything is
addressable, then the sidebar, the viewport, and the workspace itself must be *things with
addresses that plugins build*, not files. This ADR names the model that answers that push,
so the concepts stop drifting between conversations.

The operator's acceptance intuition, verbatim in spirit: *"my computer screen split in half
with their computer screen"* - seat a friend's live sidebar and viewport from THEIR instance
beside mine, with presence, because everything is a node and they granted me the nodes.

## The model

Five primitives. Everything else is derived and MUST NOT become a new primitive.

1. **Node.** Everything that exists has a `manifold://` address. One ownership tree; grants
   (ADR 0011), presence, and events (ADR 0012) are planes over the same tree.
2. **Kind + renderer.** Every node has a kind; plugins declare kinds and own each kind's
   renderer through the projection registry (one owner, D5 collisions, D4' placeholders).
3. **Reference node ("seat").** A node whose content is another node's ADDRESS. Rendering a
   seat renders its referent, transitively. The symlink of Manifold. A tile in a tree is a
   seat; per-seat state (e.g. a rail seat's row arrangement) belongs to the seat, not the
   referent.
4. **Cursor.** A per-principal reference node that navigation WRITES. Index rows, `/uri/…`
   deep links, and spotlight do nothing but update a cursor's referent.
5. **Composition.** An arranged tree of seats, itself a node. A principal's workspace is
   their ROOT COMPOSITION - an ordinary node: addressable, grantable, shareable.

Derived (each provably a composition of primitives, none a new concept):

- **Viewport** = seat → cursor. "My viewport" is a seat referencing my cursor. There is no
  viewport panel kind in the end state.
- **Rendering someone's viewport** = my seat pinned to THEIR cursor node. Inherently live -
  "follow" is not a binding; it is what referencing an alive node already means.
- **Follow mode (in-instance)** = temporarily writing my cursor's referent to be another
  principal's cursor address; unfollow repoints. An edit of my own node - no new plane.
- **Guest independence** = a guest principal on a foreign instance gets their OWN cursor and
  workspace nodes there (extends wave-3 sharing; same identity machinery).
- **Rail** = a node kind whose renderer stacks contributed section rows (#85). N rails, any
  seat, per-seat arrangement.

Non-negotiable consequences:

- A seat whose referent the viewer holds no grant for renders a NAMED refusal, never blank.
- Reference chains resolve with cycle detection; a cycle renders a named refusal.
- A shared surface is a presence surface. The sidebar's historical cursor-free-ness was a
  property of it being personal, not of it being a sidebar.
- Arrangement data lives with the tree that seats it: workspace rail → per-principal;
  rail seated in a shared composition → that container's document.

## Decisions asked of the operator

- **R1 - The workspace is a node.** Each principal's workspace becomes an ordinary
  composition node instead of a parallel structure. Consequence (invariant 14): the two
  tree-mutation doors - `core.space.setLayout` and the placement algebra - converge on ONE
  door, and the other is deleted at the end of the migration. Staging below.
- **R2 - Cursors are nodes.** Per-principal navigation state becomes an addressable
  reference node written through a door (today it is client route state). Prerequisite for
  every cross-viewport scenario.
- **R3 - Seats carry addresses.** The tile wire's panel leaf generalizes to a seat holding a
  `manifold://` address (protocol change, version-bumped, dedicated `protocol:` commit).
  Panel ids become plugin-node addresses; pre-migration trees migrate mechanically.
- **R4 - Viewport and container-view dissolve.** The main area becomes a seat referencing
  the principal's cursor; the renderer is the referent's owner. Navigation IS population.
- **R5 - Presence on shared seats.** A rail or workspace seated into a shared container
  carries presence like any shared surface.

## Migration stages (each independently green, each behind the gate)

1. **S17-A (landed with #85):** rails render only contributed rows; panels move in F8; the
   shell plugin exits the floor; per-seat arrangement travels with moved seats.
2. **S17-B:** seeded defaults - the classical layout is composed from manifest seat intents;
   the engine's layout constant dies. (Ratified already; in flight as wave 2.)
3. **S17-C (needs R2+R3):** cursor nodes + seats-carry-addresses; container-view becomes a
   cursor seat; deep links and spotlight write cursors.
4. **S17-D (needs R1):** workspace-as-composition migration + one-door convergence; delete
   the losing door the same change the winning door absorbs its callers.
5. **S17-E (needs R5 + grants scope):** cross-principal and cross-instance seats - grant
   rows on workspace/cursor subtrees, guest cursors, presence on shared seats.

## Acceptance scenario - "the split-screen test"

Instance A (mine), instance B (my friend's). In MY workspace I arrange four seats:
my rail · a seat → my cursor · a seat → B's cursor node (granted) · a seat → B's rail
(granted). Expected: B navigating on B's instance re-resolves my third seat live; B's rail
renders B's arrangement through MY roster (rows my instance lacks ghost by name); presence
shows B's pointer on the surfaces we share; revoking the grants collapses my seats into
named refusals, never blanks. When this passes against two real instances, the model is
not prose.

## Deferred doors ledger (so nothing silently drops)

- Canvas-seating legality rows: a rail/composition seat placed ON a canvas (placement
  algebra rows; mechanism exists, legality unratified).
- In-instance follow-mode affordance (uses R2; UI = one cursor write + an unfollow chip).
- Guest cursors on foreign instances (S17-E).
- Discipline roster openness: issue #86 (separate ratification).
- `essential: true` boundary: disable must never orphan its own undo (the plugin-manager
  row lives in a rail; the rail owner therefore refuses disable). Revisit only if the
  engine ever grows a rosterless recovery door.

## Alternatives rejected

- **"Follow" as a binding enum on seats** (pinned | navigation | follow): rejected by the
  operator - reference nodes subsume it; three bindings would be three names for "render
  the node at this address".
- **A distribution-owned default-layout document**: rejected in favor of manifest seat
  intents; a seed document is a favourite-plugin list wearing a data file's clothes.
- **Keeping the workspace tree special**: rejected; it is the one structure that would
  forever contradict "everything is a node", and the split-screen test is unreachable
  while it stands.

## Revisit when

- R1-R5 ratification (operator, this morning's review).
- Any stage finds a seat/referent shape the placement algebra cannot express - escalate,
  never special-case.
