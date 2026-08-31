import "./styles.css";
import {
  dragAndDropFeature,
  hotkeysCoreFeature,
  isOrderedDragTarget,
  keyboardDragAndDropFeature,
  syncDataLoaderFeature,
  type ItemInstance,
  type TreeInstance,
} from "@headless-tree/core";
import {
  buildIndexTree,
  projectIndexMove,
  sameIndexEntries,
  treeItemId,
  type SectionProps,
  type IndexBranch,
} from "@manifold/plugin";
import {
  ITEM_MIME,
  carriesItem,
  containerEnvelope,
  createPlacementLookup,
  envelopeRef,
  sealEnvelope,
  useItemDrop,
  usePolledResource,
  ATTENDANCE_RESOURCE,
  CONTAINER_TERMINALS_RESOURCE,
  INDEX_RESOURCE,
  TERMINALS_RESOURCE,
  type ItemDropAssessment,
} from "@manifold/plugin/hooks";
import { DEFAULT_CANVAS_DROP, placementItemFor } from "@manifold/protocol";
import type {
  Container,
  Attendance,
  ContainerTerminalSummary,
  IndexEntry,
  PlacementDestination,
  PlacementItem,
  SceneElement,
  TerminalSummary,
} from "@manifold/protocol";
import { Cluster, Stack } from "@manifold/plugin/ui";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Folder,
  FolderOpen,
  LayoutDashboard,
  ListTree,
  Plus,
  SquareDashed,
  SquareTerminal,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useHeadlessTree } from "./use-headless-tree.ts";

/**
 * The workspace index's browser half — the sidebar's largest section, and the plugin that
 * proves the boundary is real: it holds no shell state, receives no props but `host`, and
 * every question it asks (what exists, who is where, which terminals are alive) and every
 * write it performs (rename, delete, move, kill) goes through a door a stranger's agent has
 * too. What used to be 900 lines fused into the shell is now a plugin the shell only knows
 * the ORDER of.
 *
 * The index has no event channel yet, so it polls; when the event plane lands (wave 2) the
 * four `usePolledResource` calls below become four subscriptions and nothing else moves.
 */

/** Index cadence, matching what the shell used to poll on the section's behalf. */
const INDEX_POLL_MS = 2_000;

/** Device-local presentation memory. Both keys are listed in the REGISTRY.md register. */
const TERMINAL_TREE_KEY = "manifold:show-container-terminals";
const EXPANDED_FOLDERS_KEY = "manifold:expanded-index-folders";

const NO_CONTAINER_TERMINALS: readonly ContainerTerminalSummary[] = [];
const NO_TERMINALS: readonly TerminalSummary[] = [];
const NO_PRESENCE: readonly Attendance[] = [];

/**
 * Releasing an item over the index's own body — past the last row, not on one — unplaces it:
 * every reference to it goes and the item stays where it lives. That is what parking became
 * once there was no pool to park into, and it is why the target is the index itself rather
 * than a section of its own.
 */
const UNPLACED_DESTINATION: PlacementDestination = { kind: "unplaced" };

/** The index joins no room, so it renders no elements: its lookup answers from rows alone. */
const EMPTY_ELEMENTS: ReadonlyMap<string, SceneElement> = new Map();

/** The tree's own root, which is never a row: it exists so folders have a parent. */
const SIDEBAR_ROOT_ITEM: IndexEntry = {
  kind: "folder",
  id: "__sidebar_root__",
  name: "Index",
  createdAt: 0,
  parentId: null,
  sortOrder: -1,
};

/** One stroke weight, one rhythm — the same the floor's icon vocabulary paints with. */
const ICON = { strokeWidth: 1.75, absoluteStrokeWidth: true, focusable: "false" } as const;

function Glyph({ icon: Icon, size = 14 }: { icon: LucideIcon; size?: number }): ReactElement {
  return <Icon className="mf-icon" size={size} {...ICON} />;
}

function initials(name: string): string {
  return [...name][0]?.toUpperCase() ?? "?";
}

function initialShowTerminals(): boolean {
  try {
    return window.localStorage.getItem(TERMINAL_TREE_KEY) === "true";
  } catch {
    return false;
  }
}

function initialExpandedFolders(): string[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(EXPANDED_FOLDERS_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Ghost rows rather than the word “Loading”. */
function IndexSkeleton(): ReactElement {
  return (
    <div className="index-skeleton" role="presentation" aria-busy="true">
      <span className="index-skeleton-row" />
      <span className="index-skeleton-row" />
      <span className="index-skeleton-row" />
    </div>
  );
}

export function IndexSection({ host }: SectionProps): ReactElement {
  const client = host.client;
  const activeContainerId = host.containerId;

  const [failure, setFailure] = useState<string | null>(null);
  const report = useCallback((reason: unknown, fallback: string): void => {
    setFailure(reason instanceof Error ? reason.message : fallback);
  }, []);

  const [showTerminals, setShowTerminals] = useState(initialShowTerminals);
  const [actionContainerId, setActionContainerId] = useState<string | null>(null);
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [folderRenameName, setFolderRenameName] = useState("");
  const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null);
  const [folderCreateParentId, setFolderCreateParentId] = useState<string | null>(null);
  const [folderName, setFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [initialExpandedItems] = useState<string[]>(initialExpandedFolders);
  /**
   * What the row under the cursor and the index's own body would do with the current carry.
   * Held as state rather than derived because the payload is unreadable during `dragover`:
   * the assessment is taken when the pointer arrives and worn until it leaves.
   */
  const [dropRow, setDropRow] = useState<{
    readonly containerId: string;
    readonly assessment: ItemDropAssessment | null;
  } | null>(null);
  const [unplaceDrop, setUnplaceDrop] = useState<ItemDropAssessment | null>(null);
  const [, renderTreeState] = useState(0);
  const reorderingRef = useRef(false);
  const treeInstanceRef = useRef<TreeInstance<IndexEntry> | null>(null);
  const dndFrameRef = useRef<number | null>(null);

  const fetchTree = useCallback(() => client.index(), [client]);
  const fetchByContainer = useCallback(() => client.terminalsByContainer(), [client]);
  const fetchPresence = useCallback(() => client.attendanceByContainer(), [client]);
  const fetchTerminals = useCallback(() => client.allTerminals(), [client]);

  /**
   * The one question that tells a tree gesture apart from everything else. While a row is
   * held, the tree owns its own DOM and its own idea of the index: a poll that committed
   * underneath would rebuild the rows out from under the pointer. Held responses are dropped,
   * not queued — the tick after the gesture settles carries the truth.
   */
  const treeOwnsDrag = useCallback(
    (): boolean => treeInstanceRef.current?.getState().dnd != null,
    [],
  );

  const {
    value: treeItems,
    setValue: setTreeItems,
    refresh: refreshTree,
  } = usePolledResource<readonly IndexEntry[] | null>(fetchTree, INDEX_POLL_MS, {
    key: INDEX_RESOURCE,
    initial: null,
    hold: treeOwnsDrag,
    equal: (current, incoming) =>
      current !== null && incoming !== null && sameIndexEntries(current, incoming),
    onError: (reason) => report(reason, "Could not load the index"),
  });
  const { value: terminalsByContainer } = usePolledResource(fetchByContainer, INDEX_POLL_MS, {
    key: CONTAINER_TERMINALS_RESOURCE,
    initial: NO_CONTAINER_TERMINALS,
    hold: treeOwnsDrag,
  });
  const { value: presence } = usePolledResource(fetchPresence, INDEX_POLL_MS, {
    key: ATTENDANCE_RESOURCE,
    initial: NO_PRESENCE,
    hold: treeOwnsDrag,
    restartKey: activeContainerId,
  });
  const { value: terminals, refresh: refreshTerminals } = usePolledResource(
    fetchTerminals,
    INDEX_POLL_MS,
    { key: TERMINALS_RESOURCE, initial: NO_TERMINALS, hold: treeOwnsDrag },
  );

  /**
   * A container row IS a terminal when exactly one terminal calls it home: that is a solo
   * composition, and a composition of one is the item it holds — so the index shows the
   * terminal, with the terminal's name, glyph and destructive verb. A composition two
   * terminals call home is a real composition again, and falls out of this map by construction.
   */
  const terminalByHome = useMemo(() => {
    const homes = new Map<string, TerminalSummary>();
    const shared = new Set<string>();
    for (const terminal of terminals) {
      if (homes.has(terminal.homeId)) shared.add(terminal.homeId);
      homes.set(terminal.homeId, terminal);
    }
    for (const containerId of shared) homes.delete(containerId);
    return homes;
  }, [terminals]);

  /**
   * INDEX VISIBILITY: the top level is homes and the homeless. A container is a home and
   * always shows; an ITEM shows here only while nothing holds it, because a placed item is
   * already visible inside whatever holds it and listing it twice would make the index a
   * second, competing statement about where things are.
   */
  const indexedTreeItems = useMemo(
    () =>
      treeItems?.filter(
        (item) =>
          item.kind === "folder" || (terminalByHome.get(item.container.id)?.unplaced ?? true),
      ) ?? null,
    [terminalByHome, treeItems],
  );

  /**
   * Every container that exists, whatever the index chooses to SHOW. A drag's source or
   * target may be a row the visibility rule elides (a placed terminal's home), and legality
   * is a question about what exists, never about what is on screen.
   */
  const containers = useMemo<readonly Container[]>(
    () =>
      treeItems?.flatMap((item) => (item.kind === "container" ? [item.container] : [])) ??
      ([] as const),
    [treeItems],
  );

  /**
   * The same fold as {@link terminalByHome}, in the shape the placement algebra asks for.
   * The index is the ONLY party that can see how many items a container holds, so it owns
   * this answer for everything below it: that is what keeps a drag preview and the server's
   * write in agreement about "compositions merge, never nest".
   */
  const soloOccupants = useMemo<ReadonlyMap<string, PlacementItem>>(
    () =>
      new Map(
        [...terminalByHome].map(([containerId, terminal]) => [
          containerId,
          { kind: "terminal" as const, containerId: terminal.homeId },
        ]),
      ),
    [terminalByHome],
  );

  /**
   * The index's placement pipeline. It joins no room, so it holds no elements and is not
   * itself a container: every legality question it asks is answered from the rows it already
   * polls, and every write goes through `place` — the same door the canvas and the composition
   * renderer use, from a plugin that owns none of them.
   */
  const roster = host.assembly.roster();
  const lookup = useMemo(
    () =>
      createPlacementLookup({
        containers,
        self: null,
        elements: EMPTY_ELEMENTS,
        terminalHomes: new Map(terminals.map((terminal) => [terminal.id, terminal.homeId])),
        soloOccupants,
        roster,
      }),
    [containers, roster, soloOccupants, terminals],
  );
  const drop = useItemDrop({
    lookup,
    place: (ref, destination) => client.place(ref, destination),
    notify: setFailure,
    onPlaced: () => {
      setFailure(null);
      // A placement re-homes items and can retire an emptied container: both listings change.
      refreshTerminals();
      refreshTree();
    },
  });

  /** Where a release on a container's row lands, decided by that row's own discipline. */
  const rowDestination = (container: Container): PlacementDestination =>
    container.discipline === "composition"
      ? { kind: "tile", containerId: container.id, targetTileId: null, edge: null }
      : {
          kind: "canvas",
          containerId: container.id,
          x: DEFAULT_CANVAS_DROP.x,
          y: DEFAULT_CANVAS_DROP.y,
        };

  /**
   * A container row accepts ANY carried item. The row's discipline picks the destination and
   * the pipeline decides legality, so an item that cannot land there SAYS so instead of doing
   * nothing. The tree's own reorder gesture is excluded by `treeOwnsDrag`: a row dragged onto
   * a row orders the index, and only a carry from elsewhere is a placement.
   */
  const containerDropProps = (container: Container) => ({
    onDragOver: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (!carriesItem(event.dataTransfer) || treeOwnsDrag()) return;
      // Claimed either way: a refusal has to be shown here, not handed back to the browser.
      event.preventDefault();
      const assessment = drop.assess(rowDestination(container));
      event.dataTransfer.dropEffect = assessment?.denial == null ? "move" : "none";
      setDropRow({ containerId: container.id, assessment });
    },
    onDragLeave: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (!carriesItem(event.dataTransfer) || treeOwnsDrag()) return;
      setDropRow((current) => (current?.containerId === container.id ? null : current));
    },
    onDrop: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (!carriesItem(event.dataTransfer) || treeOwnsDrag()) return;
      event.preventDefault();
      event.stopPropagation();
      setDropRow(null);
      drop.commit(event.dataTransfer, rowDestination(container));
    },
  });

  /** The index's own body as a destination: a release past the last row unplaces the carry. */
  const unplacedDropProps = {
    onDragOver: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (!carriesItem(event.dataTransfer) || treeOwnsDrag()) return;
      event.preventDefault();
      const assessment = drop.assess(UNPLACED_DESTINATION);
      event.dataTransfer.dropEffect = assessment?.denial == null ? "move" : "none";
      setUnplaceDrop(assessment);
    },
    onDragLeave: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (!carriesItem(event.dataTransfer) || treeOwnsDrag()) return;
      setUnplaceDrop(null);
    },
    onDrop: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (!carriesItem(event.dataTransfer) || treeOwnsDrag()) return;
      event.preventDefault();
      event.stopPropagation();
      setUnplaceDrop(null);
      drop.commit(event.dataTransfer, UNPLACED_DESTINATION);
    },
  };

  const scheduleDndPresentation = useCallback((): void => {
    if (dndFrameRef.current !== null) return;
    dndFrameRef.current = window.requestAnimationFrame(() => {
      dndFrameRef.current = null;
      const tree = treeInstanceRef.current;
      if (tree === null) return;
      const container = tree.getElement();
      if (container === null || container === undefined) return;

      for (const element of container.querySelectorAll(".index-item.is-drop-target")) {
        element.classList.remove("is-drop-target");
      }
      for (const item of tree.getItems()) {
        item
          .getElement()
          ?.closest(".index-item")
          ?.classList.toggle("is-drop-target", item.isDragTarget());
      }

      const dragLine = container.querySelector<HTMLElement>(".index-drag-line");
      if (dragLine !== null) {
        dragLine.removeAttribute("style");
        Object.assign(dragLine.style, tree.getDragLineStyle());
      }
    });
  }, []);

  const renderSettledTreeState = useCallback((): void => {
    const tree = treeInstanceRef.current;
    if (tree === null) return;
    if (tree.getState().dnd !== null && tree.getState().dnd !== undefined) return;
    try {
      window.localStorage.setItem(
        EXPANDED_FOLDERS_KEY,
        JSON.stringify(tree.getState().expandedItems),
      );
    } catch {
      // Folder expansion memory is optional.
    }
    renderTreeState((revision) => revision + 1);
  }, []);

  useEffect(
    () => () => {
      if (dndFrameRef.current !== null) window.cancelAnimationFrame(dndFrameRef.current);
    },
    [],
  );

  useEffect(() => {
    if (actionContainerId === null) return;
    const closeMenu = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest(".sidebar-actions") !== null) {
        return;
      }
      setActionContainerId(null);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setActionContainerId(null);
    };
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [actionContainerId]);

  const treeData = useMemo(() => {
    const data = new Map<string, { item: IndexEntry; children: string[] }>();
    const roots = buildIndexTree(indexedTreeItems ?? []);
    const addNodes = (nodes: readonly IndexBranch[]): string[] =>
      nodes.map((node) => {
        const id = `${node.item.kind}:${treeItemId(node.item)}`;
        data.set(id, { item: node.item, children: addNodes(node.children) });
        return id;
      });
    data.set("root", { item: SIDEBAR_ROOT_ITEM, children: addNodes(roots) });
    return data;
  }, [indexedTreeItems]);
  const treeDataRef = useRef(treeData);

  const tree = useHeadlessTree<IndexEntry>({
    initialState: { expandedItems: initialExpandedItems },
    // Core owns drag targeting; this paints its state without routing ItemInstance objects
    // through React, which tears down the tree during native drags in React 19.
    setDndState: scheduleDndPresentation,
    rootItemId: "root",
    getItemName: (item) => {
      const data = item.getItemData();
      return item.getId() === "root"
        ? "Index"
        : data.kind === "container"
          ? data.container.name
          : data.name;
    },
    isItemFolder: (item) => item.getItemData().kind === "folder",
    dataLoader: {
      getItem: (itemId) => {
        const entry = treeDataRef.current.get(itemId);
        if (entry === undefined) throw new Error(`Unknown sidebar tree item: ${itemId}`);
        return entry.item;
      },
      getChildren: (itemId) => treeDataRef.current.get(itemId)?.children ?? [],
    },
    indent: 16,
    canReorder: true,
    seperateDragHandle: false,
    draggedItemOverwritesSelection: true,
    canDrag: (items) => {
      if (reorderingRef.current || items.length !== 1) return false;
      const data = items[0]?.getItemData();
      if (data === undefined || data === null) return false;
      return data.kind === "container"
        ? renameTargetId !== data.container.id
        : renamingFolderId !== data.id;
    },
    canDrop: (_items, target) => isOrderedDragTarget(target) || target.item.isFolder(),
    // A container row drag also carries the one item envelope, so the same gesture that
    // reorders the index drops that container into a tile or onto another canvas. The
    // envelope goes out with the item it names, resolved from THIS section's census: the
    // index is the only party that can classify a row without asking anyone, and every
    // renderer the drag crosses — including a collaborator's — reads that answer instead
    // of re-deriving it from an address.
    createForeignDragObject: (items) => {
      const data = items[0]?.getItemData();
      const envelope =
        data?.kind === "container"
          ? containerEnvelope(data.container.id, data.container.discipline)
          : null;
      const item = envelope === null ? null : placementItemFor(envelopeRef(envelope), lookup);
      return {
        format: ITEM_MIME,
        // A folder — or a row this section cannot classify — carries an empty payload:
        // `carriesItem` is true but the envelope parser rejects it, so every target reads
        // it as "not one of our drags" and stays silent.
        data: envelope === null || item === null ? "" : sealEnvelope(envelope, item),
        effectAllowed: "move",
      };
    },
    onDrop: (items, target) => {
      const moved = items[0]?.getItemData();
      if (moved === undefined || moved === null || reorderingRef.current || treeItems === null) {
        return;
      }
      const targetData = target.item.getItemData();
      const parentId =
        target.item.getId() === "root"
          ? null
          : targetData.kind === "folder"
            ? targetData.id
            : targetData.parentId;
      // The tree renders every stored sibling, so the insertion index needs no translation.
      const index = isOrderedDragTarget(target)
        ? target.insertionIndex
        : (treeDataRef.current.get(target.item.getId())?.children.length ?? 0);
      const item = { kind: moved.kind, id: treeItemId(moved) } as const;
      const previousTreeItems = treeItems;
      const optimisticTreeItems = projectIndexMove(treeItems, item, parentId, index);
      const request = client.moveIndexEntry(item, parentId, index).then(
        (nextTreeItems) => ({ ok: true, nextTreeItems }) as const,
        (reason: unknown) => ({ ok: false, reason }) as const,
      );

      reorderingRef.current = true;
      // Headless Tree clears native DnD state after onDrop returns. Paint the local
      // projection in the following task, then reconcile with the server response.
      window.setTimeout(() => {
        setTreeItems(optimisticTreeItems);
        void request.then((outcome) => {
          if (outcome.ok) {
            setTreeItems(outcome.nextTreeItems);
          } else {
            setTreeItems(previousTreeItems);
            report(outcome.reason, "Could not move the sidebar item");
          }
          reorderingRef.current = false;
        });
      }, 0);
    },
    features: [
      syncDataLoaderFeature,
      dragAndDropFeature,
      keyboardDragAndDropFeature,
      hotkeysCoreFeature,
    ],
  });

  useEffect(() => {
    treeInstanceRef.current = tree;
    treeDataRef.current = treeData;
    tree.rebuildTree();
    return () => {
      treeInstanceRef.current = null;
    };
  }, [tree, treeData]);

  /**
   * A row's mark: the object's own species icon, the same one it wears in its titlebar. A solo
   * composition wears the TERMINAL's mark, because a composition of one is the item it holds.
   * Liveness rides ON that mark for a terminal (`terminal-state` tints it) rather than beside it.
   */
  const containerMark = (container: Container): ReactNode => {
    const terminal = terminalByHome.get(container.id);
    if (terminal !== undefined) {
      return (
        <span
          className={`sidebar-item-mark terminal-state ${terminal.status === "running" ? "is-running" : ""}`}
          aria-hidden="true"
        >
          <Glyph icon={SquareTerminal} />
        </span>
      );
    }
    return (
      <span className="sidebar-item-mark" aria-hidden="true">
        <Glyph icon={container.discipline === "composition" ? LayoutDashboard : SquareDashed} />
      </span>
    );
  };

  /** What a row calls itself: a solo composition shows its terminal's name. */
  const rowName = (container: Container): string =>
    terminalByHome.get(container.id)?.name ?? container.name;

  /** What a row IS, for every label that has to name it. */
  const rowNoun = (container: Container): string =>
    terminalByHome.has(container.id)
      ? "terminal"
      : container.discipline === "composition"
        ? "composition"
        : "canvas";

  const openRename = (container: Container): void => {
    setActionContainerId(null);
    setRenameTargetId(container.id);
    setRenameName(rowName(container));
  };

  /**
   * One rename gesture, two doors. A solo composition and the terminal in it are one object to
   * the operator, and the terminal is the half that owns the name — so renaming that row
   * dispatches `core.terminals.rename`. Every other row renames the container over its own
   * route, which the index can apply locally at once.
   */
  const submitRename = async (container: Container): Promise<void> => {
    const trimmedName = renameName.trim();
    if (trimmedName.length === 0 || trimmedName === rowName(container)) {
      setRenameTargetId(null);
      return;
    }
    const terminal = terminalByHome.get(container.id);
    setRenaming(true);
    try {
      if (terminal !== undefined) {
        const outcome = await client.action("core.terminals.rename", {
          terminalId: terminal.id,
          name: trimmedName,
        });
        if (!outcome.ok) {
          setFailure(outcome.denial.message);
          return;
        }
        refreshTerminals();
        setRenameTargetId(null);
        return;
      }
      const renamed = await client.renameContainer(container.id, trimmedName);
      setTreeItems(
        (current) =>
          current?.map((item) =>
            item.kind === "container" && item.container.id === renamed.id
              ? { ...item, container: renamed }
              : item,
          ) ?? null,
      );
      setRenameTargetId(null);
    } catch (reason: unknown) {
      report(reason, `Could not rename the ${rowNoun(container)}`);
    } finally {
      setRenaming(false);
    }
  };

  /**
   * Destroying an index row is ONE gesture, whatever the row is — and for a terminal it really
   * is destruction: there is no pool to fall back into, so the PTY dies and the composition it
   * lived in goes with it. The verb on the menu item says so.
   */
  const destroyRow = async (container: Container): Promise<void> => {
    setActionContainerId(null);
    const terminal = terminalByHome.get(container.id);
    setDeletingId(container.id);
    try {
      if (terminal !== undefined) {
        const outcome = await client.action("core.terminals.kill", { terminalId: terminal.id });
        if (!outcome.ok) setFailure(outcome.denial.message);
      } else {
        await client.deleteContainer(container.id);
      }
      // Killing a terminal empties and deletes its home composition, so both listings change.
      refreshTerminals();
      refreshTree();
    } catch (reason: unknown) {
      report(reason, `Could not remove the ${rowNoun(container)}`);
    } finally {
      setDeletingId(null);
    }
  };

  const submitFolder = async (parentId: string): Promise<void> => {
    const trimmedName = folderName.trim();
    if (trimmedName.length === 0) return;
    setCreatingFolder(true);
    try {
      setTreeItems(await client.createFolder(trimmedName, parentId));
      tree.getItemInstance(`folder:${parentId}`).expand();
      renderSettledTreeState();
      setFolderName("");
      setFolderCreateParentId(null);
    } catch (reason: unknown) {
      report(reason, "Could not create the folder");
    } finally {
      setCreatingFolder(false);
    }
  };

  const submitFolderRename = async (
    folder: Extract<IndexEntry, { kind: "folder" }>,
  ): Promise<void> => {
    const trimmedName = folderRenameName.trim();
    if (trimmedName.length === 0 || trimmedName === folder.name) {
      setRenamingFolderId(null);
      return;
    }
    try {
      setTreeItems(await client.renameFolder(folder.id, trimmedName));
      setRenamingFolderId(null);
    } catch (reason: unknown) {
      report(reason, "Could not rename the folder");
    }
  };

  const removeFolder = async (folder: Extract<IndexEntry, { kind: "folder" }>): Promise<void> => {
    setDeletingFolderId(folder.id);
    try {
      setTreeItems(await client.deleteFolder(folder.id));
      setRenamingFolderId(null);
    } catch (reason: unknown) {
      report(reason, "Could not delete the folder");
    } finally {
      setDeletingFolderId(null);
    }
  };

  /** One inline editor for every index row: canvas, composition and terminal alike. */
  const renderContainerRenameRow = (container: Container, active: boolean): ReactNode => {
    const label = rowName(container);
    const isTerminal = terminalByHome.has(container.id);
    return (
      <div className={`sidebar-row is-editing${active ? " is-active" : ""}`}>
        {containerMark(container)}
        <input
          className="sidebar-rename-input"
          aria-label={`Rename ${label}`}
          maxLength={120}
          value={renameName}
          disabled={renaming}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setRenameName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submitRename(container);
            if (event.key === "Escape") setRenameTargetId(null);
          }}
        />
        <button
          className="sidebar-inline-action is-primary"
          type="button"
          aria-label={`Save name for ${label}`}
          title="Save"
          {...(isTerminal
            ? { "data-action": "core.terminals.rename" }
            : { "data-action": "core.index.renameContainer" })}
          disabled={renaming || renameName.trim() === "" || renameName.trim() === label}
          onClick={() => void submitRename(container)}
        >
          <Glyph icon={Check} />
        </button>
        <button
          className="sidebar-inline-action"
          type="button"
          aria-label={`Cancel renaming ${label}`}
          title="Cancel"
          disabled={renaming}
          onClick={() => setRenameTargetId(null)}
        >
          <Glyph icon={X} />
        </button>
      </div>
    );
  };

  /** The row menu: rename inline, destroy on the click. */
  const renderContainerActions = (container: Container): ReactNode => {
    const label = rowName(container);
    const kind = rowNoun(container);
    const heading = `${kind[0]?.toUpperCase() ?? ""}${kind.slice(1)}`;
    const isTerminal = terminalByHome.has(container.id);
    return (
      <div className="sidebar-actions">
        <button
          className="sidebar-delete"
          type="button"
          title={`${heading} actions for ${label}`}
          aria-label={`${heading} actions for ${label}`}
          aria-pressed={actionContainerId === container.id}
          onClick={() =>
            setActionContainerId((current) => (current === container.id ? null : container.id))
          }
        >
          <Glyph icon={Ellipsis} />
        </button>
        {actionContainerId === container.id ? (
          <div className="sidebar-action-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => openRename(container)}>
              Rename
            </button>
            <button
              className="is-danger"
              type="button"
              role="menuitem"
              {...(isTerminal
                ? { "data-action": "core.terminals.kill" }
                : { "data-action": "core.index.deleteContainer" })}
              disabled={deletingId !== null}
              onClick={() => void destroyRow(container)}
            >
              {isTerminal ? "Kill" : "Delete"}
            </button>
          </div>
        ) : null}
      </div>
    );
  };

  /**
   * One row per thing that exists. A canvas, a composition and a terminal are all index rows
   * here: the glyph, the name and the destructive verb come from the row's own identity, and
   * nothing else about the row forks.
   */
  const renderContainerRow = (container: Container): ReactNode => {
    const active = container.id === activeContainerId;
    const principals =
      presence.find((entry) => entry.containerId === container.id)?.principals ?? [];
    const visiblePrincipals = principals.slice(0, 3);
    const summaries = terminalsByContainer.filter(
      (terminal) => terminal.containerId === container.id,
    );
    const runningCount = summaries.filter((terminal) => terminal.status === "running").length;
    const rowDrop = dropRow?.containerId === container.id ? dropRow.assessment : null;

    const row =
      renameTargetId === container.id ? (
        renderContainerRenameRow(container, active)
      ) : (
        <div
          className={`sidebar-row${active ? " is-active" : ""}${terminalByHome.get(container.id)?.status === "exited" ? " is-exited" : ""}${rowDrop !== null && rowDrop.denial === null ? " sidebar-row--terminal-target" : ""}`}
          {...drop.refusalProps(rowDrop)}
          {...containerDropProps(container)}
        >
          <button
            className="sidebar-link"
            type="button"
            title={rowName(container)}
            aria-label={`Open ${rowNoun(container)} ${rowName(container)}`}
            aria-current={active ? "page" : undefined}
            onClick={() =>
              host.navigate(`manifold://container/${encodeURIComponent(container.id)}`)
            }
            onKeyDown={(event) => {
              // Enter is the button's own activation; F2 and Delete match the row menu's items.
              if (event.key === "F2") {
                event.preventDefault();
                openRename(container);
              }
              if (event.key === "Delete") {
                event.preventDefault();
                void destroyRow(container);
              }
            }}
          >
            {containerMark(container)}
            <span className="sidebar-container-name">{rowName(container)}</span>
            {runningCount > 0 ? (
              <span
                className="sidebar-terminal-count"
                title={`${runningCount} open ${runningCount === 1 ? "terminal" : "terminals"}`}
              >
                {runningCount}
              </span>
            ) : null}
            {principals.length > 0 ? (
              <span
                className="sidebar-presence"
                aria-label={`${principals.length} present in ${rowName(container)}`}
              >
                {visiblePrincipals.map((principal) => (
                  <span
                    className={`presence-avatar${principal.kind === "agent" ? " is-agent" : ""}`}
                    style={{ backgroundColor: principal.color }}
                    title={`${principal.name} (${principal.kind})`}
                    key={principal.id}
                  >
                    {initials(principal.name)}
                  </span>
                ))}
                {principals.length > visiblePrincipals.length ? (
                  <span className="presence-avatar presence-overflow">
                    +{principals.length - visiblePrincipals.length}
                  </span>
                ) : null}
              </span>
            ) : null}
          </button>
          {renderContainerActions(container)}
        </div>
      );

    return (
      <>
        {row}
        {showTerminals
          ? summaries.map((terminal) => (
              <div
                className={`sidebar-terminal is-summary${terminal.status === "exited" ? " is-exited" : ""}`}
                key={terminal.id}
              >
                <span
                  className={`terminal-state ${terminal.status === "running" ? "is-running" : ""}`}
                  aria-hidden="true"
                >
                  <Glyph icon={SquareTerminal} size={13} />
                </span>
                <span>{terminal.machineId}</span>
                <small>{terminal.status}</small>
                {terminal.status === "running" ? (
                  <button
                    className="sidebar-inline-action"
                    type="button"
                    data-action="core.terminals.kill"
                    aria-label={`Kill terminal ${terminal.id}`}
                    title="Kill terminal"
                    onClick={() => {
                      void client
                        .action("core.terminals.kill", { terminalId: terminal.id })
                        .then((outcome) => {
                          if (!outcome.ok) setFailure(outcome.denial.message);
                          refreshTerminals();
                          refreshTree();
                        })
                        .catch((reason: unknown) => report(reason, "Could not kill the terminal"));
                    }}
                  >
                    <Glyph icon={X} size={12} />
                  </button>
                ) : null}
              </div>
            ))
          : null}
      </>
    );
  };

  const renderFolderCreateForm = (parentId: string): ReactNode => (
    <form
      className="sidebar-create sidebar-folder-create is-nested"
      onSubmit={(event) => {
        event.preventDefault();
        void submitFolder(parentId);
      }}
    >
      <input
        maxLength={120}
        value={folderName}
        onChange={(event) => setFolderName(event.currentTarget.value)}
        placeholder="Folder name"
        aria-label="Folder name"
        autoFocus
        disabled={creatingFolder}
      />
      <div>
        <button
          type="button"
          onClick={() => setFolderCreateParentId(null)}
          disabled={creatingFolder}
        >
          Cancel
        </button>
        <button
          type="submit"
          data-action="core.index.createFolder"
          disabled={creatingFolder || folderName.trim() === ""}
        >
          {creatingFolder ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
  );

  const renderFolder = (
    folder: Extract<IndexEntry, { kind: "folder" }>,
    item: ItemInstance<IndexEntry>,
  ): ReactNode => {
    const actionId = `folder:${folder.id}`;
    if (renamingFolderId === folder.id) {
      return (
        <div className="sidebar-row is-editing">
          <span className="sidebar-folder-icon" aria-hidden="true">
            <Glyph icon={Folder} />
          </span>
          <input
            className="sidebar-rename-input"
            value={folderRenameName}
            maxLength={120}
            aria-label={`Rename folder ${folder.name}`}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setFolderRenameName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submitFolderRename(folder);
              if (event.key === "Escape") setRenamingFolderId(null);
            }}
          />
          <button
            className="sidebar-inline-action is-primary"
            type="button"
            aria-label={`Save name for ${folder.name}`}
            data-action="core.index.renameFolder"
            disabled={folderRenameName.trim() === ""}
            onClick={() => void submitFolderRename(folder)}
          >
            <Glyph icon={Check} />
          </button>
          <button
            className="sidebar-inline-action"
            type="button"
            aria-label={`Cancel renaming ${folder.name}`}
            onClick={() => setRenamingFolderId(null)}
          >
            <Glyph icon={X} />
          </button>
        </div>
      );
    }
    /* No confirmation step: the menu item already said Delete, and children move up. */
    return (
      <>
        <div className="sidebar-row sidebar-folder-row">
          <button
            className="sidebar-folder-toggle"
            type="button"
            aria-label={`${item.isExpanded() ? "Collapse" : "Expand"} folder ${folder.name}`}
            aria-expanded={item.isExpanded()}
            onClick={(event) => {
              event.stopPropagation();
              if (item.isExpanded()) item.collapse();
              else item.expand();
              renderSettledTreeState();
            }}
          >
            <span className="sidebar-folder-chevron" aria-hidden="true">
              <Glyph icon={item.isExpanded() ? ChevronDown : ChevronRight} size={12} />
            </span>
            <span className="sidebar-folder-icon" aria-hidden="true">
              <Glyph icon={item.isExpanded() ? FolderOpen : Folder} />
            </span>
            <strong>{folder.name}</strong>
          </button>
          <div className="sidebar-actions" onClick={(event) => event.stopPropagation()}>
            <button
              className="sidebar-folder-add"
              type="button"
              title={`New folder inside ${folder.name}`}
              aria-label={`New folder inside ${folder.name}`}
              onClick={() => {
                setFolderName("");
                setFolderCreateParentId(folder.id);
              }}
            >
              <Glyph icon={Plus} size={12} />
            </button>
            <button
              className="sidebar-delete"
              type="button"
              title={`Folder actions for ${folder.name}`}
              aria-label={`Folder actions for ${folder.name}`}
              aria-pressed={actionContainerId === actionId}
              onClick={() =>
                setActionContainerId((current) => (current === actionId ? null : actionId))
              }
            >
              <Glyph icon={Ellipsis} />
            </button>
            {actionContainerId === actionId ? (
              <div className="sidebar-action-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setActionContainerId(null);
                    setRenamingFolderId(folder.id);
                    setFolderRenameName(folder.name);
                  }}
                >
                  Rename
                </button>
                <button
                  className="is-danger"
                  type="button"
                  role="menuitem"
                  data-action="core.index.deleteFolder"
                  disabled={deletingFolderId === folder.id}
                  onClick={() => {
                    setActionContainerId(null);
                    void removeFolder(folder);
                  }}
                >
                  Delete
                </button>
              </div>
            ) : null}
          </div>
        </div>
        {folderCreateParentId === folder.id ? renderFolderCreateForm(folder.id) : null}
      </>
    );
  };

  const containerCount = indexedTreeItems?.filter((item) => item.kind === "container").length ?? 0;

  return (
    <Stack className="index-section" gap="0">
      <Cluster className="index-section-bar" justify="space-between" gap="0.3rem">
        <span className="sidebar-section-count">{containerCount}</span>
        <button
          className="sidebar-section-action"
          type="button"
          aria-pressed={showTerminals}
          title={
            showTerminals ? "Hide terminals under containers" : "Show terminals under containers"
          }
          aria-label={showTerminals ? "Hide terminal tree" : "Show terminal tree"}
          onClick={() => {
            setShowTerminals((current) => {
              try {
                window.localStorage.setItem(TERMINAL_TREE_KEY, String(!current));
              } catch {
                // Terminal tree memory is optional.
              }
              return !current;
            });
          }}
        >
          <Glyph icon={ListTree} />
        </button>
      </Cluster>
      {failure === null ? null : (
        <p className="index-section-error" role="alert">
          {failure}
        </p>
      )}
      {/*
        The index body is itself a target: releasing an item over it — anywhere a row is not —
        unplaces it. The tree's own reorder gesture is excluded by `treeOwnsDrag`, and a row
        under the pointer stops the event before it reaches here, so the two never contend.
      */}
      <div
        {...tree.getContainerProps()}
        className={`sidebar-list sidebar-tree${unplaceDrop !== null && unplaceDrop.denial === null ? " is-drop-target" : ""}`}
        data-testid="sidebar-list"
        {...drop.refusalProps(unplaceDrop)}
        {...unplacedDropProps}
      >
        {indexedTreeItems === null ? <IndexSkeleton /> : null}
        {indexedTreeItems?.length === 0 ? <p className="sidebar-muted">Nothing here yet</p> : null}
        {indexedTreeItems === null
          ? null
          : tree.getItems().map((item) => {
              const data = item.getItemData();
              const itemProps = item.getProps();
              return (
                <div
                  {...itemProps}
                  className="index-item"
                  data-tree-kind={data.kind}
                  data-tree-id={treeItemId(data)}
                  style={{ marginInlineStart: `${item.getItemMeta().level * 0.75}rem` }}
                  key={item.getId()}
                >
                  {data.kind === "container"
                    ? renderContainerRow(data.container)
                    : renderFolder(data, item)}
                </div>
              );
            })}
        <div style={{ display: "none" }} className="index-drag-line" />
      </div>
    </Stack>
  );
}
