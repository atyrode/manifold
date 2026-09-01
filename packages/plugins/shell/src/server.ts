import type { EmitEvent } from "@manifold/plugin";
import {
  placementRefusal,
  validateTileLayout,
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

/** Either the empty result the action publishes, or a refusal the door turns into a denial. */
type Outcome = { refused: string } | Record<string, never>;

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
    // ONE per gesture, and the gesture is already debounced to one call by the client (a
    // divider drag paints per frame and commits once, D6) — so this line runs once per commit
    // for the same reason the action does.
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
      THE DROP, announced once, on the container the item landed IN.

      Only a PLACED outcome announces: a denial and a failure are answers about state, and an
      event is a notification that something happened. The destination carries the container for
      all three real forms; `unplaced` carries none, because unplacing means every reference
      goes and there is no destination left to name — so it is addressed to the item's own node,
      which is what the ref already is. `PlacementRef`'s four forms are structurally the four
      `ManifoldRef` forms they address, so this is the compiler joining the address rather than
      this file spelling one.
     */
    ctx.emit(
      args.destination.kind === "unplaced"
        ? args.ref
        : { kind: "container", containerId: args.destination.containerId },
      "item_placed",
      { op: outcome.result.op, item: args.ref.kind, destination: args.destination.kind },
    );
    return outcome.result;
  },
};
