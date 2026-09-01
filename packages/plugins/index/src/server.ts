import type { EmitEvent } from "@manifold/plugin";
import { rosterDisciplines } from "@manifold/protocol";
import type { Container, EventKind, IndexEntry, PluginRoster } from "@manifold/protocol";
import { indexManifest } from "./index.ts";

/** One index item as a move addresses it: the kind, and the id inside that kind. */
interface TreeItemRef {
  readonly kind: "container" | "folder";
  readonly id: string;
}

/**
 * The slice of the host this plugin touches, declared locally (D1). It is wider than most
 * plugins' because the index is the workspace's own tree: the persistence substrate that
 * holds the rows, the placement executor that retires a container without leaving portals
 * pointing at nothing, the caller's container scope, and the two runtime facts a new row needs.
 *
 * `store` is named method by method rather than as `ServerStore` on purpose — a plugin may
 * call exactly the eight functions its doors are made of, and a widened demand fails the
 * assignment in `packages/server/src/assembly.ts` instead of quietly reaching further.
 */
interface IndexCtx {
  readonly auth: { readonly containerScope: string | null };
  /**
   * The engine's canonical containment refusal. The scope rung proved the caller's caps hold
   * for its OWN container; this is the only way to ask whether the container this door's
   * ARGUMENTS name is that one, and it is engine-owned so every container-scoped door in the
   * workspace refuses in one wording (ADR 0013 §15).
   */
  outsideScope(containerId: string | null): { readonly refused: string } | null;
  readonly store: {
    listIndex(): IndexEntry[];
    listContainers(): Container[];
    getContainer(id: string): Container | null;
    createContainer(container: Container): void;
    renameContainer(id: string, name: string): Container | null;
    createFolder(
      folder: { readonly id: string; readonly name: string; readonly createdAt: number },
      parentId: string | null,
    ): boolean;
    renameFolder(id: string, name: string): boolean;
    deleteFolder(id: string): boolean;
    moveIndexEntry(item: TreeItemRef, parentId: string | null, index: number): boolean;
  };
  readonly placement: {
    deleteContainer(containerId: string): void;
  };
  /**
   * The composed roster, for one question only: does anything here DECLARE the discipline
   * this call asked for (#110)? The creation door is where an unknown discipline has to be
   * refused, because it is the only moment where refusing costs nothing — a container that
   * already exists with an uninstalled discipline is legible by design (a placeholder, a
   * named placement refusal), while one CREATED that way would be unrenderable on purpose.
   */
  readonly host: {
    roster(): PluginRoster;
  };
  newId(): string;
  now(): number;
  /**
   * The index's own news, staged on the engine and published only if this dispatch commits
   * (ADR 0012). Declared here in the slice like every other reach: a plugin's `contributes.events`
   * is what it may spell, and this is how it says it.
   */
  readonly emit: EmitEvent;
}

type Refusal = { refused: string };
type TreeOutcome = Refusal | { items: readonly IndexEntry[] };
type ContainerOutcome = Refusal | { container: Container };

/**
 * THE INDEX VISIBILITY RULE, as a scoped token sees it. A container-scoped caller reads its own
 * container and the folders it hangs under, and nothing else: the ancestor chain is included
 * because a row with no visible parent is a row the sidebar cannot place, not because the
 * folders themselves are interesting.
 *
 * This is `GET /api/container-tree`'s filter verbatim, and it is the obligation `scope: "container"`
 * creates: the ladder proved the caller holds `containers:read` at its own container, and only this
 * function can prove the answer stays inside it (ADR 0013 §15).
 */
function scopedTree(tree: readonly IndexEntry[], containerScope: string): readonly IndexEntry[] {
  const included = new Set<string>();
  const container = tree.find(
    (item) => item.kind === "container" && item.container.id === containerScope,
  );
  if (container?.kind === "container") {
    included.add(`container:${container.container.id}`);
    let parentId = container.parentId;
    while (parentId !== null) {
      const folder = tree.find((item) => item.kind === "folder" && item.id === parentId);
      if (folder?.kind !== "folder") break;
      included.add(`folder:${folder.id}`);
      parentId = folder.parentId;
    }
  }
  return tree.filter((item) =>
    included.has(
      item.kind === "container" ? `container:${item.container.id}` : `folder:${item.id}`,
    ),
  );
}

/**
 * THE INDEX'S TOPIC, stated once: this plugin's OWN node.
 *
 * Every door below announces onto it rather than onto the row it touched, and the reason is
 * addressability rather than convenience — a container that does not exist yet cannot be
 * subscribed to in advance, a container that was just deleted has no address left to be a
 * topic, and a folder has no `manifold://` form at all. The index is a view OF the collection,
 * so the collection is the topic and WHICH row moved is the payload. One subscription replaces
 * the section's whole poll.
 *
 * Built from the manifest's own id, so the address and the declaration cannot drift; the
 * engine refuses an emission on any other plugin's node anyway.
 */
const INDEX_TOPIC = { kind: "plugin", pluginId: indexManifest.id } as const;

/**
 * One announcement, so every door below reads the same and none of them spells the topic.
 * Seven doors, one collection, one address.
 */
function announce(ctx: IndexCtx, kind: EventKind, payload: Record<string, string | null>): void {
  ctx.emit(INDEX_TOPIC, kind, payload);
}

/**
 * The bodies of the deleted container, folder and container-tree routes, moved with their semantics
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
 *   and its terminals must be dropped, or the workspace keeps portals onto nothing.
 */
export const indexHandlers = {
  async read(ctx: IndexCtx): Promise<TreeOutcome> {
    const tree = ctx.store.listIndex();
    const containerScope = ctx.auth.containerScope;
    return { items: containerScope === null ? tree : scopedTree(tree, containerScope) };
  },

  async listContainers(ctx: IndexCtx): Promise<{ containers: readonly Container[] }> {
    const containerScope = ctx.auth.containerScope;
    return {
      containers: ctx.store
        .listContainers()
        .filter((container) => containerScope === null || container.id === containerScope),
    };
  },

  async readContainer(ctx: IndexCtx, args: { containerId: string }): Promise<ContainerOutcome> {
    const outside = ctx.outsideScope(args.containerId);
    if (outside !== null) return outside;
    const container = ctx.store.getContainer(args.containerId);
    if (container === null) return { refused: "container not found" };
    return { container };
  },

  async createContainer(
    ctx: IndexCtx,
    args: { name: string; discipline?: Container["discipline"] },
  ): Promise<ContainerOutcome> {
    /*
      The discipline roster is OPEN (#110), so this argument is a bounded string the schema
      cannot check against a list — the list is the composed assembly, and it is checked
      here. Omitted still means `canvas`, which is the same default it has always had and is
      itself subject to the check: a build with `core.canvas` disabled or absent refuses to
      mint a container nothing can render, rather than minting one and hoping.
    */
    const discipline = args.discipline ?? "canvas";
    if (!rosterDisciplines(ctx.host.roster()).has(discipline)) {
      return { refused: `no plugin renders the "${discipline}" discipline` };
    }
    const container: Container = {
      id: ctx.newId(),
      name: args.name,
      createdAt: ctx.now(),
      discipline,
    };
    ctx.store.createContainer(container);
    announce(ctx, "container_created", { containerId: container.id, name: container.name });
    return { container };
  },

  async renameContainer(
    ctx: IndexCtx,
    args: { containerId: string; name: string },
  ): Promise<ContainerOutcome> {
    // The `scope: "container"` obligation: the ladder authorized the caller's OWN container, so a
    // scoped token naming any other one is refused here and nowhere else.
    const outside = ctx.outsideScope(args.containerId);
    if (outside !== null) return outside;
    const renamed = ctx.store.renameContainer(args.containerId, args.name);
    if (renamed === null) return { refused: "container not found" };
    announce(ctx, "container_renamed", { containerId: renamed.id, name: renamed.name });
    return { container: renamed };
  },

  async deleteContainer(
    ctx: IndexCtx,
    args: { containerId: string },
  ): Promise<Refusal | Record<string, never>> {
    if (ctx.store.getContainer(args.containerId) === null)
      return { refused: "container not found" };
    ctx.placement.deleteContainer(args.containerId);
    announce(ctx, "container_deleted", { containerId: args.containerId });
    return {};
  },

  async createFolder(
    ctx: IndexCtx,
    args: { name: string; parentId: string | null },
  ): Promise<TreeOutcome> {
    const folderId = ctx.newId();
    const created = ctx.store.createFolder(
      { id: folderId, name: args.name, createdAt: ctx.now() },
      args.parentId,
    );
    if (!created) return { refused: "parent folder changed while creating a folder" };
    announce(ctx, "folder_created", { folderId, name: args.name, parentId: args.parentId });
    return { items: ctx.store.listIndex() };
  },

  async renameFolder(
    ctx: IndexCtx,
    args: { folderId: string; name: string },
  ): Promise<TreeOutcome> {
    if (!ctx.store.renameFolder(args.folderId, args.name)) {
      return { refused: "container folder not found" };
    }
    announce(ctx, "folder_renamed", { folderId: args.folderId, name: args.name });
    return { items: ctx.store.listIndex() };
  },

  async deleteFolder(ctx: IndexCtx, args: { folderId: string }): Promise<TreeOutcome> {
    if (!ctx.store.deleteFolder(args.folderId)) return { refused: "container folder not found" };
    announce(ctx, "folder_deleted", { folderId: args.folderId });
    return { items: ctx.store.listIndex() };
  },

  async moveEntry(
    ctx: IndexCtx,
    args: { item: TreeItemRef; parentId: string | null; index: number },
  ): Promise<TreeOutcome> {
    if (!ctx.store.moveIndexEntry(args.item, args.parentId, args.index)) {
      return { refused: "sidebar tree changed while moving an item" };
    }
    announce(ctx, "index_moved", {
      kind: args.item.kind,
      id: args.item.id,
      parentId: args.parentId,
    });
    return { items: ctx.store.listIndex() };
  },
};
