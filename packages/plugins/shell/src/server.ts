import type { EmitEvent } from "@manifold/plugin";
import {
  placementRefusal,
  validateTileLayout,
  type ManifoldRef,
  type PlaceRequest,
  type PlaceResponse,
  type PlacementDenial,
  type TileLayout,
} from "@manifold/protocol";

/**
 * The slice of the host this plugin touches, declared locally: a principal id to write
 * under, one store call, and the placement executor. A plugin never imports the server's
 * types — `assembly.ts` checks this shape against the real `ActionCtx` by assignment, so
 * the ref a plugin declares is the ref it gets (D1).
 *
 * `placement` is the ALGEBRA, which stays floor: it arbitrates between kinds no single
 * plugin owns, and it is neutral over which kinds exist. What this plugin owns is the VERB —
 * who may place, what a refusal says, and that there is exactly one door for it (ADR 0013
 * §14).
 */
interface LayoutCtx {
  readonly principal: { readonly id: string };
  readonly store: {
    setWorkspaceLayout(principalId: string, layout: TileLayout): void;
  };
  /**
   * A layout write, announced. The topic is the caller's OWN principal node, which is the only
   * node a per-principal tree has: `setWorkspaceLayout` is keyed by principal id, and no
   * container, element or plugin node describes "this reader's arrangement".
   */
  readonly emit: EmitEvent;
}

interface PlaceCtx {
  readonly placement: {
    place(
      request: PlaceRequest,
    ):
      | { readonly status: "placed"; readonly result: PlaceResponse }
      | { readonly status: "denied"; readonly denial: PlacementDenial }
      | { readonly status: "failed"; readonly failure: "not_found" | "conflict" };
  };
  readonly emit: EmitEvent;
}

/**
 * Leaf removal's slice. The executor answers `"ok"` or names the state that stopped it — the
 * same two failures `place` reports — and nothing else about the algebra is reachable from
 * here: removing a leaf is one call, and which occupant that leaf held (and therefore whether
 * a terminal was reaped or a composition retired) is the floor's rule, not this plugin's.
 */
interface RemoveTileCtx {
  readonly placement: {
    removeTile(containerId: string, tileId: string): "ok" | "not_found" | "conflict";
  };
  readonly emit: EmitEvent;
}

/** Either the empty result the action publishes, or a refusal the door turns into a denial. */
type Outcome = { refused: string } | Record<string, never>;

/**
 * The node an `item_placed` announces on: the container the item landed IN, or — for
 * `unplaced`, which has no destination left to name because every reference to the item goes —
 * the item's OWN node, which is what a `PlacementRef` that names something already is.
 *
 * Null for the one ref that names nothing. A `structure` ref carries new tile material rather
 * than a representation of something that exists (issue #104), so there is no node to address
 * and no `manifold://` to mint for it. Unplacing it is unreachable anyway — a `tree_only` item
 * is refused (`no_tree`) at every destination but a tile — and saying "nothing to address" is
 * honest where inventing an address would not be.
 */
function placedTopic(
  ref: PlaceRequest["ref"],
  destination: PlaceRequest["destination"],
): ManifoldRef | null {
  if (destination.kind !== "unplaced") {
    return { kind: "container", containerId: destination.containerId };
  }
  return ref.kind === "structure" ? null : ref;
}

/**
 * Validation here is STRUCTURAL ONLY, and that is a decision rather than an omission.
 *
 * The tree must be a tree (`validateTileLayout`) and every occupied leaf must hold a PANEL OR
 * A SPACER — a workspace shows panels, plus the inert furniture `core.arrange`'s Spacer tool
 * writes (issue #89), and a terminal or container ref at this level would be a category error
 * the renderer could not honour. But an UNKNOWN or DISABLED panel id is accepted: panel ids
 * come and go as plugins are enabled, and a layout write that failed because one leaf named a
 * plugin somebody just switched off would mean a disable could lock a principal out of
 * rearranging their own workspace. Those leaves render an inert placeholder naming the
 * plugin, with a remove control that commits the pruned tree back through this same door (D4).
 *
 * A VACANT leaf — `ref: null` — passes, and now load-bearing rather than incidental: dropping
 * a Stack row or Stack column from `core.arrange`'s palette writes a split holding two empty
 * seats (issue #104), and the whole point of that gesture is that the seats are still empty
 * when the tree comes back through this door to be saved.
 */
export const spaceHandlers = {
  async setLayout(ctx: LayoutCtx, args: { layout: TileLayout }): Promise<Outcome> {
    if (!validateTileLayout(args.layout)) {
      return { refused: "layout is not a valid tile tree" };
    }
    for (const node of Object.values(args.layout)) {
      if (node.ref === null || node.ref.kind === "panel" || node.ref.kind === "spacer") continue;
      return { refused: `workspace leaves hold panels, not "${node.ref.kind}"` };
    }
    ctx.store.setWorkspaceLayout(ctx.principal.id, args.layout);
    // The client commits once at gesture release; intermediate divider frames stay local.
    ctx.emit({ kind: "principal", principalId: ctx.principal.id }, "layout_set", {
      leaves: Object.keys(args.layout).length,
    });
    return {};
  },

  /**
   * One placement, dispatched. The executor answers three ways and each maps to exactly one
   * thing the door can say:
   *
   *   placed  → the `PlaceResponse`, tagged by the op that actually ran.
   *   denied  → the `refused` rung, carrying the algebra's own rule first
   *             (`placementRefusal`). The rule is a member of the published closed set, so a
   *             caller reads it back mechanically and `not_accepted` keeps one wording.
   *   failed  → the `refused` rung too, led by the failure's name. A legal placement that
   *             cannot be carried out (a terminal that vanished mid-flight, a tree that
   *             rejected the write) is an ANSWER about state, not a transport error — the old
   *             route raised HTTP 404/409 for these, and the ladder's rule is that a refusal
   *             is data.
   */
  async place(ctx: PlaceCtx, args: PlaceRequest): Promise<PlaceResponse | { refused: string }> {
    const outcome = ctx.placement.place(args);
    if (outcome.status === "denied") return { refused: placementRefusal(outcome.denial) };
    if (outcome.status === "failed") {
      return {
        refused:
          outcome.failure === "not_found"
            ? "not_found: placement ref or container not found"
            : "conflict: placement could not be carried out",
      };
    }
    /*
      THE DROP, announced once, on the container the item landed IN — `placedTopic` above holds
      that address rule, because it is the one part of this handler that has an unreachable arm
      and so deserves to be stated in full rather than inlined.

      Only a PLACED outcome announces: a denial and a failure are answers about state, and an
      event is a notification that something happened. A ref that addresses nothing announces
      nothing either — there is no node to notify about.
     */
    const topic = placedTopic(args.ref, args.destination);
    if (topic !== null) {
      ctx.emit(topic, "item_placed", {
        op: outcome.result.op,
        item: args.ref.kind,
        destination: args.destination.kind,
      });
    }
    return outcome.result;
  },

  /**
   * One leaf, removed (issue #114). This was a bespoke DELETE route that mutated a
   * composition's tree without passing the ladder — the single untraced door in the tree —
   * and the conversion is behaviour-preserving on every rung: the same capability, the same
   * container-scope refusal (now the declared scope rather than a hand-written throw), and the
   * same two state answers.
   *
   * The two failures become the `refused` rung, for `place`'s reason: the route raised HTTP
   * 404/409 for "no such leaf" and "that leaf is not removable", and both are ANSWERS ABOUT
   * STATE rather than transport faults. The ladder's rule is that a refusal is data.
   *
   * The announcement is `item_placed`'s mirror — the container that held the leaf, once, after
   * the write — and it is staged, so a refusal above publishes nothing.
   */
  async removeTile(
    ctx: RemoveTileCtx,
    args: { containerId: string; tileId: string },
  ): Promise<Outcome> {
    const removed = ctx.placement.removeTile(args.containerId, args.tileId);
    if (removed === "not_found") return { refused: "not_found: tile not found" };
    if (removed === "conflict") return { refused: "conflict: tile is not removable" };
    ctx.emit({ kind: "container", containerId: args.containerId }, "tile_removed", {
      tileId: args.tileId,
    });
    return {};
  },
};
