import { defineAction } from "@manifold/plugin";
import {
  PlaceRequestSchema,
  PlaceResponseSchema,
  TileLayoutSchema,
  type PluginManifest,
} from "@manifold/protocol";
import { z } from "zod";

/**
 * The shell: the sidebar and the container view, as plugin panels, and the rail's own chrome
 * as CONTRIBUTED ROWS. A principal's workspace is a tile tree whose leaves name these two
 * panel ids, rendered by the same component every composition uses — which is why the shell
 * is a composition rather than a frame with plugin holes cut in it (D2).
 *
 * THE SECTIONS ARE THE RAIL'S OWN CHROME, declared instead of hand-written. Each was floor JSX
 * inside the sidebar panel until this wave, which made "the shell owns the brand line" a fact
 * about a file rather than about the assembly: no reader of `GET /api/plugins` could see it,
 * nothing ordered it against the rows below it, and arrange mode could not move it. Both are
 * `plain` — they draw themselves end to end, with no disclosure header and nothing to fold —
 * and they inhabit the ONE section registry in the ONE order beside every other plugin's rows
 * (ADR 0017 §S17-A/B; `SectionPresentationSchema`).
 *
 * TWO OF THE FOUR LEFT, and that is ownership matching the mental map rather than a shrunken
 * seat (issue #91). The brand line is `core.brand` and the key table is `core.keys`: both are
 * rail NON-NEGOTIABLES, so each is now an essential seat a reader can find by name in the
 * roster, and each declares its own section id at its own order — `brand` at `1`, `keys` at
 * `50` — so a principal's stored arrangement keeps the seat it already chose. What stayed is
 * what the shell itself answers for: whether its socket is up, and who this device is.
 *
 * THE ORDER NUMBERS ARE THE RAIL, TOP TO BOTTOM. `1` is `core.brand`'s line; the creators the
 * two container disciplines and the index contribute take `2`–`4`; the bodies (`index` 10,
 * `machines` 20) sit in the middle where they always have; and the rail's foot is `status` 40,
 * then the `utility` cluster `core.keys` and `core.plugins` declare (50, 51 — painted side by
 * side), then `identity` 60. A principal's stored arrangement overrides all of it
 * (`arrangedSections`).
 *
 * ESSENTIAL: nothing else can draw the workspace, so disabling it is refused rather than
 * obeyed. It declares no actions and no capabilities — chrome is not authority, and every one
 * of these rows either reads a published surface (`host.assembly`, `host.principal`) or calls
 * a door somebody else owns.
 */
export const shellManifest: PluginManifest = {
  id: "core.shell",
  version: "1.0.0",
  title: "Workspace Shell",
  description:
    "The workspace itself: the sidebar panel and the container-view panel every layout is built from.",
  capabilities: [],
  essential: true,
  contributes: {
    /*
      THE SIDEBAR DECLARES ITS INNER ARRANGEMENT. Its rows reorder inside it, which is a
      SECOND arrangement nested in the workspace's own — and the floor may not know that, so
      the panel says it here and names it. Arrange mode reads the declaration off the roster,
      offers a zoom-in control on this panel's pill labelled with that name, and publishes the
      scope it enters as `vantage.arrangeScope`; the rows themselves are still entirely this
      package's business (`sidebar-panel.tsx`).

      The container view declares nothing: what it shows is a container's own composition,
      which already arranges by its own dividers and drags, not by a second mode.
    */
    panels: [
      { id: "sidebar", title: "Sidebar", arranges: { title: "Sidebar rows" } },
      { id: "container-view", title: "Container View" },
    ],
    /*
      WHERE THOSE TWO PANELS ASK TO SIT, which is how the classical workspace — rail left at
      0.22, container view right at 0.78 — survives the engine's default-layout constant being
      deleted (ADR 0017 S17-B). The numbers are the arrangement the shell has always had, moved
      from a floor function into the manifest that owns the panels: the engine composes the
      default from every enabled plugin's seats, so a stranger's panel plugin can now ask for a
      place in a fresh workspace instead of waiting for somebody to edit a registration file.

      A principal who has arranged a workspace is untouched by these numbers; their tree is
      stored, and only the default is composed.
    */
    seats: [
      { panel: "sidebar", order: 100, ratio: 0.22 },
      { panel: "container-view", order: 200, ratio: 0.78 },
    ],
    sections: [
      { id: "status", title: "Connection", order: 40, presentation: "plain" },
      { id: "identity", title: "Identity", order: 60, presentation: "plain" },
    ],
    elements: [],
    tools: [],
    events: [],
  },
};

/**
 * The workspace layout and the placement verb, as doors. They live in the shell's package
 * because the tree is the shell's own state, but under a SEPARATE plugin id so the ratified
 * action names stay `core.space.setLayout` and `core.space.place` — a plugin id is a namespace,
 * and "the tree" and "the panels that fill it" are two concepts even when one package ships
 * both.
 *
 * It contributes no panel, no section and no element, and it is `essential` (issue #113): the
 * tile tree is the SHELL's own state, and this is the only door that writes it. `core.shell`
 * is essential because nothing else can draw the workspace; splitting the tree out from the
 * panels that fill it was a NAMESPACE decision, so leaving the write half disableable made
 * half of one concept protected and the other half a toggle. Off, every arrangement in the
 * workspace freezes for every principal at once, nothing can be placed anywhere, and — the
 * decisive rung — the engine's own placeholder-with-remove, the affordance that guarantees a
 * disabled panel plugin can never brick a layout (D4), is dead, because it commits its pruned
 * tree through `setLayout`. An engine guarantee may not sit behind a plugin's toggle.
 *
 * `removeTile` stays `cleanup` and the carve-out stays live, because `essential` is a
 * REFUSAL at the door rather than an impossibility: an assembly can still arrive with this
 * seat off, out of band, and the floor answers that with its recovery gate
 * (`EssentialRecovery`). In that state removal must still reach a composition's leaves, for
 * `core.terminals.kill`'s reason exactly (D12).
 *
 * The three events it declares are its three doors' commit points, and each is addressed to the
 * node it actually changed. `layout_set` is announced on the CALLER'S PRINCIPAL node, because a
 * workspace tree is per principal (`setWorkspaceLayout(principal.id, ...)`) and no other node
 * describes it. `item_placed` is announced on the destination CONTAINER, so a socket watching a
 * canvas or composition learns something landed in it — once per gesture, at the drop, never
 * per frame of the drag (`AXIOMS.md` §Axioms, the plane rule's commit point). `tile_removed` is
 * that emission's mirror: the same container node, because a leaf that goes is a change to the
 * composition that held it. All three are also
 * DELIVERED at this plugin's own node, which is how the workspace-wide readings a placement
 * moves — the index's top level, both terminal rosters — hear a commit in a room they cannot
 * name in advance (ADR 0012 §2b). That is delivery, not a second emission: one row, one frame.
 */
export const spaceManifest: PluginManifest = {
  id: "core.space",
  version: "1.0.0",
  title: "Workspace Space",
  description:
    "Stores each principal's workspace tile tree, and places items into the containers they compose.",
  capabilities: ["containers:write"],
  essential: true,
  contributes: {
    panels: [],
    sections: [],
    elements: [],
    tools: [],
    events: [
      { id: "layout_set", title: "Workspace layout written" },
      { id: "item_placed", title: "Item placed" },
      { id: "tile_removed", title: "Composition leaf removed" },
    ],
  },
};

export const spaceActions = [
  /**
   * Writing a layout needs no capability: dispatch already refuses container-scoped tokens, and a
   * workspace tree is per principal — the only tree this door can write is the caller's own,
   * so there is nothing to attenuate. A layout is chrome that happens to be shared state.
   */
  defineAction({
    name: "setLayout",
    title: "Set the workspace layout",
    caps: [],
    input: z.strictObject({ layout: TileLayoutSchema }),
    result: z.strictObject({}),
  }),
  /**
   * THE placement door: put an item in a container (ADR 0013 §14). The algebra stays floor —
   * the rules engine arbitrates between kinds no plugin owns — and the VERB is here, so
   * placing a thing goes through the same published vocabulary, capability declaration and
   * denial ladder as every other mutation. `containers:write` is the cap the deleted route
   * required, unchanged; the workspace scope is that route's container-scoped refusal, unchanged.
   *
   * A refused placement is the `refused` rung carrying the algebra's own rule
   * (`placementRefusal`), so `not_accepted` has exactly one wording on the wire. The result
   * is `PlaceResponse` verbatim, tagged by the op that actually ran.
   */
  defineAction({
    name: "place",
    title: "Place an item",
    caps: ["containers:write"],
    input: PlaceRequestSchema,
    result: PlaceResponseSchema,
  }),
  /**
   * LEAF REMOVAL, as a door (issue #114). This was `DELETE /api/containers/:id/tiles/:tileId`,
   * the one mutation left standing outside the dispatch ladder: it committed workspace state
   * and wrote no trace row, and it fits none of A6's three named exemptions — it is neither
   * presence, nor a continuous stream, nor a document-plane delta discharged at `doc_update`.
   * A discrete authority-bearing mutation is an action (invariant 13), so it is one, and the
   * T3 completeness gate covers it from here on rather than a reviewer having to remember it.
   *
   * Removal is NOT a placement, which is why it is a SECOND door on this plugin rather than a
   * `PlaceRequest` form: nothing accepts "nowhere" for a LEAF, and `tile -> unplaced` already
   * means the opposite thing — releasing a leaf re-homes its occupant, closing one destroys it.
   * Two verbs, two doors, and the destructive one is never reached by a drag.
   *
   * `containers:write` and the workspace scope are the deleted route's own rungs, unchanged:
   * the route refused container-scoped tokens by hand, and an undeclared scope IS that refusal.
   * `cleanup`, for `core.terminals.kill`'s reason — closing a tile and killing from the sidebar
   * are the same write, so a disable may not reach one and leave the other (D12).
   */
  defineAction({
    cleanup: true,
    name: "removeTile",
    title: "Remove a composition leaf",
    caps: ["containers:write"],
    input: z.strictObject({
      containerId: z.string().min(1),
      tileId: z.string().min(1),
    }),
    result: z.strictObject({}),
  }),
];
