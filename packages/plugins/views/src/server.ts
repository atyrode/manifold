import type { Pad, PadTreeItem } from "@manifold/protocol";

/** One index item as a move addresses it: the kind, and the id inside that kind. */
interface TreeItemRef {
  readonly kind: "pad" | "folder";
  readonly id: string;
}

/**
 * The slice of the host this plugin touches, declared locally (D1). It is wider than most
 * plugins' because the index is the workspace's own tree: the persistence substrate that
 * holds the rows, the placement executor that retires a container without leaving widgets
 * pointing at nothing, the caller's pad scope, and the two runtime facts a new row needs.
 *
 * `store` is named method by method rather than as `ServerStore` on purpose — a plugin may
 * call exactly the eight functions its doors are made of, and a widened demand fails the
 * assignment in `packages/server/src/composition.ts` instead of quietly reaching further.
 */
interface ViewsCtx {
  readonly auth: { readonly padScope: string | null };
  /**
   * The engine's canonical containment refusal. The scope rung proved the caller's caps hold
   * for its OWN container; this is the only way to ask whether the container this door's
   * ARGUMENTS name is that one, and it is engine-owned so every pad-scoped door in the
   * workspace refuses in one wording (ADR 0013 §15).
   */
  outsideScope(padId: string | null): { readonly refused: string } | null;
  readonly store: {
    listPadTree(): PadTreeItem[];
    listPads(): Pad[];
    getPad(id: string): Pad | null;
    createPad(pad: Pad): void;
    renamePad(id: string, name: string): Pad | null;
    createPadFolder(
      folder: { readonly id: string; readonly name: string; readonly createdAt: number },
      parentId: string | null,
    ): boolean;
    renamePadFolder(id: string, name: string): boolean;
    deletePadFolder(id: string): boolean;
    movePadTreeItem(item: TreeItemRef, parentId: string | null, index: number): boolean;
  };
  readonly placement: {
    deleteContainer(padId: string): void;
  };
  newId(): string;
  now(): number;
}

type Refusal = { refused: string };
type TreeOutcome = Refusal | { items: readonly PadTreeItem[] };
type PadOutcome = Refusal | { pad: Pad };

/**
 * THE INDEX VISIBILITY RULE, as a scoped token sees it. A pad-scoped caller reads its own
 * container and the folders it hangs under, and nothing else: the ancestor chain is included
 * because a row with no visible parent is a row the sidebar cannot place, not because the
 * folders themselves are interesting.
 *
 * This is `GET /api/pad-tree`'s filter verbatim, and it is the obligation `scope: "pad"`
 * creates: the ladder proved the caller holds `pads:read` at its own pad, and only this
 * function can prove the answer stays inside it (ADR 0013 §15).
 */
function scopedTree(tree: readonly PadTreeItem[], padScope: string): readonly PadTreeItem[] {
  const included = new Set<string>();
  const pad = tree.find((item) => item.kind === "pad" && item.pad.id === padScope);
  if (pad?.kind === "pad") {
    included.add(`pad:${pad.pad.id}`);
    let parentId = pad.parentId;
    while (parentId !== null) {
      const folder = tree.find((item) => item.kind === "folder" && item.id === parentId);
      if (folder?.kind !== "folder") break;
      included.add(`folder:${folder.id}`);
      parentId = folder.parentId;
    }
  }
  return tree.filter((item) =>
    included.has(item.kind === "pad" ? `pad:${item.pad.id}` : `folder:${item.id}`),
  );
}

/**
 * The bodies of the deleted pad, folder and pad-tree routes, moved with their semantics
 * intact. Each route's 404 and 409 became a refusal carrying the same sentence, because the
 * outcome envelope's equivalent of "there is no such row" is a denial that says so:
 *
 * - a missing container or folder refuses (`not found`) rather than succeeding silently;
 * - a folder created under a parent that vanished mid-flight, or a move whose item, parent
 *   or destination changed underneath it, refuses as a CONFLICT — the store answers false
 *   for exactly those races, and the caller's next read is the resolution;
 * - a move into a folder's own descendant refuses through the same conflict: the store's
 *   ancestor walk is what refuses a cycle, and a cycle is not a shape this door can fix;
 * - deleting a folder is not a cascade. Its children move up into its place in the parent's
 *   order (the store's own transaction), so retiring an organizer never destroys what it
 *   organized;
 * - deleting a container goes through the PLACEMENT executor rather than the row delete,
 *   because a container is referenced: every portal and leaf pointing at it must go with it,
 *   and its terminals must be dropped, or the workspace keeps widgets onto nothing.
 */
export const viewsHandlers = {
  async tree(ctx: ViewsCtx): Promise<TreeOutcome> {
    const tree = ctx.store.listPadTree();
    const padScope = ctx.auth.padScope;
    return { items: padScope === null ? tree : scopedTree(tree, padScope) };
  },

  async list(ctx: ViewsCtx): Promise<{ pads: readonly Pad[] }> {
    const padScope = ctx.auth.padScope;
    return {
      pads: ctx.store.listPads().filter((pad) => padScope === null || pad.id === padScope),
    };
  },

  async pad(ctx: ViewsCtx, args: { padId: string }): Promise<PadOutcome> {
    const outside = ctx.outsideScope(args.padId);
    if (outside !== null) return outside;
    const pad = ctx.store.getPad(args.padId);
    if (pad === null) return { refused: "pad not found" };
    return { pad };
  },

  async createPad(
    ctx: ViewsCtx,
    args: { name: string; layout?: Pad["layout"] },
  ): Promise<PadOutcome> {
    const pad: Pad = {
      id: ctx.newId(),
      name: args.name,
      createdAt: ctx.now(),
      layout: args.layout ?? "canvas",
    };
    ctx.store.createPad(pad);
    return { pad };
  },

  async renamePad(ctx: ViewsCtx, args: { padId: string; name: string }): Promise<PadOutcome> {
    // The `scope: "pad"` obligation: the ladder authorized the caller's OWN container, so a
    // scoped token naming any other one is refused here and nowhere else.
    const outside = ctx.outsideScope(args.padId);
    if (outside !== null) return outside;
    const renamed = ctx.store.renamePad(args.padId, args.name);
    if (renamed === null) return { refused: "pad not found" };
    return { pad: renamed };
  },

  async deletePad(
    ctx: ViewsCtx,
    args: { padId: string },
  ): Promise<Refusal | Record<string, never>> {
    if (ctx.store.getPad(args.padId) === null) return { refused: "pad not found" };
    ctx.placement.deleteContainer(args.padId);
    return {};
  },

  async createFolder(
    ctx: ViewsCtx,
    args: { name: string; parentId: string | null },
  ): Promise<TreeOutcome> {
    const created = ctx.store.createPadFolder(
      { id: ctx.newId(), name: args.name, createdAt: ctx.now() },
      args.parentId,
    );
    if (!created) return { refused: "parent folder changed while creating a folder" };
    return { items: ctx.store.listPadTree() };
  },

  async renameFolder(
    ctx: ViewsCtx,
    args: { folderId: string; name: string },
  ): Promise<TreeOutcome> {
    if (!ctx.store.renamePadFolder(args.folderId, args.name)) {
      return { refused: "pad folder not found" };
    }
    return { items: ctx.store.listPadTree() };
  },

  async deleteFolder(ctx: ViewsCtx, args: { folderId: string }): Promise<TreeOutcome> {
    if (!ctx.store.deletePadFolder(args.folderId)) return { refused: "pad folder not found" };
    return { items: ctx.store.listPadTree() };
  },

  async move(
    ctx: ViewsCtx,
    args: { item: TreeItemRef; parentId: string | null; index: number },
  ): Promise<TreeOutcome> {
    if (!ctx.store.movePadTreeItem(args.item, args.parentId, args.index)) {
      return { refused: "sidebar tree changed while moving an item" };
    }
    return { items: ctx.store.listPadTree() };
  },
};
