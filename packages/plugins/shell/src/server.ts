import { validateTileLayout, type TileLayout } from "@manifold/protocol";

/**
 * The slice of the host this plugin touches, declared locally: a principal id to write
 * under and one store call. A plugin never imports the server's types — `composition.ts`
 * checks this shape against the real `ActionCtx` by assignment, so the surface a plugin
 * declares is the surface it gets (D1).
 */
interface LayoutCtx {
  readonly principal: { readonly id: string };
  readonly store: {
    setWorkspaceLayout(principalId: string, layout: TileLayout): void;
  };
}

/** Either the empty result the action publishes, or a refusal the door turns into a denial. */
type Outcome = { refused: string } | Record<string, never>;

/**
 * Validation here is STRUCTURAL ONLY, and that is a decision rather than an omission.
 *
 * The tree must be a tree (`validateTileLayout`) and every occupied leaf must hold a PANEL
 * — a workspace shows panels, and a terminal or pad surface at this level would be a
 * category error the renderer could not honour. But an UNKNOWN or DISABLED panel id is
 * accepted: panel ids come and go as plugins are enabled, and a layout write that failed
 * because one leaf named a plugin somebody just switched off would mean a disable could
 * lock a principal out of rearranging their own workspace. Those leaves render an inert
 * placeholder naming the plugin, with a remove control that commits the pruned tree back
 * through this same door (D4).
 */
export const layoutHandlers = {
  async set(ctx: LayoutCtx, args: { layout: TileLayout }): Promise<Outcome> {
    if (!validateTileLayout(args.layout)) {
      return { refused: "layout is not a valid tile tree" };
    }
    for (const node of Object.values(args.layout)) {
      if (node.surface === null || node.surface.kind === "panel") continue;
      return { refused: `workspace leaves hold panels, not "${node.surface.kind}"` };
    }
    ctx.store.setWorkspaceLayout(ctx.principal.id, args.layout);
    return {};
  },
};
