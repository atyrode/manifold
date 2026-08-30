import {
  dragAndDropFeature,
  hotkeysCoreFeature,
  isOrderedDragTarget,
  keyboardDragAndDropFeature,
  syncDataLoaderFeature,
  type ItemInstance,
  type TreeInstance,
} from "@headless-tree/core";
import { DEFAULT_CANVAS_DROP } from "@manifold/protocol";
import type {
  MachineSummary,
  Pad,
  PadPresence,
  PadSessionSummary,
  PadTreeItem,
  PlacementDestination,
  PlacementItem,
  SceneElement,
  TerminalSummary,
} from "@manifold/protocol";
import {
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  createPad,
  createPadFolder,
  deletePad,
  deletePadFolder,
  getPad,
  getMachines,
  getPadPresence,
  getPadSessions,
  killTerminal,
  listPadTree,
  listTerminals,
  movePadTreeItem,
  placeItem,
  renamePad,
  renamePadFolder,
  renameTerminal,
  type StoredIdentity,
} from "./api.ts";
import { parseChangelogReferences } from "./changelog-references.ts";
import { PadErrorBoundary } from "./error-boundary.tsx";
import { browserPadStorage, chooseInitialPad, forgetPad, rememberPad } from "./pad-memory.ts";
import { FlowPadView } from "./flow-pad-view.tsx";
import { TiledPadView } from "./tiled-pad-view.tsx";
import { createPlacementLookup, useItemDrop, type ItemDropAssessment } from "./item-drop.ts";
import { carriesItem, containerEnvelope, sealEnvelope, ITEM_MIME } from "./item-envelope.ts";
import { projectLocalPresence } from "./presence-projection.ts";
import { ControlIcon, ItemIcon } from "./icons.tsx";
import {
  buildPadTree,
  projectPadTreeMove,
  samePadTreeItems,
  treeItemId,
  type PadTreeNode,
} from "./pad-tree.ts";
import {
  MachinesSection,
  WorkspaceSessionRow,
  WorkspaceStatus,
  type WorkspaceSidebarState,
} from "./top-right.tsx";
import {
  initialCollapsedSections,
  initialSectionOrder,
  rememberCollapsedSections,
  rememberSectionOrder,
  SidebarSection,
  useSectionStackDrag,
  type CollapsedSections,
  type SidebarSectionId,
} from "./sidebar-section.tsx";
import { useToast } from "./toast.tsx";
import { WEB_CHANGELOG, WEB_VERSION_LABEL } from "./web-version.ts";
import { useHeadlessTree } from "./use-headless-tree.ts";
import { usePolledResource } from "./use-polled-resource.ts";

function renderChangelogChange(change: string): ReactNode {
  return parseChangelogReferences(change).map((part, index) =>
    part.kind === "text" ? (
      part.text
    ) : (
      <a
        key={`${part.href}-${index}`}
        href={part.href}
        target="_blank"
        rel="noreferrer"
        aria-label={`${part.text} on GitHub`}
      >
        {part.text}
      </a>
    ),
  );
}

interface NavigateOptions {
  readonly replace?: boolean;
}

interface PadBrowserProps {
  readonly identity: StoredIdentity;
  readonly requestedPadId: string | null;
  readonly navigate: (path: string, options?: NavigateOptions) => void;
}
interface CollapsedPresencePopover {
  readonly padId: string;
  readonly top: number;
  readonly left: number;
}

/** The name every container is born with; the operator renames it in place, or never. */
const DEFAULT_CONTAINER_NAME = "Untitled";

function initials(name: string): string {
  return [...name][0]?.toUpperCase() ?? "?";
}

function initialSidebarOpen(): boolean {
  try {
    return window.localStorage.getItem("manifold:sidebar-collapsed") !== "true";
  } catch {
    return true;
  }
}
const DEFAULT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 480;
const SIDEBAR_ROOT_ITEM: PadTreeItem = {
  kind: "folder",
  id: "__sidebar_root__",
  name: "Views",
  createdAt: 0,
  parentId: null,
  sortOrder: -1,
};

/** Icon rail: only the container index survives, so its tree container never reparents. */
const COLLAPSED_RAIL_SECTIONS: readonly SidebarSectionId[] = ["views"];

/**
 * "Nowhere" as a destination. Unplacing removes every reference to an item and leaves the item
 * exactly where it lives, so it carries no coordinates and no index — there is nothing to
 * position in a place that is the absence of one.
 */
const UNPLACED_DESTINATION: PlacementDestination = { kind: "unplaced" };

function initialSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem("manifold:sidebar-width");
    if (raw === null) return DEFAULT_SIDEBAR_WIDTH;
    const stored = Number(raw);
    return Number.isFinite(stored)
      ? Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, stored))
      : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}
function rememberSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem("manifold:sidebar-width", String(width));
  } catch {
    // Sidebar memory is optional.
  }
}

function initialSessionTree(): boolean {
  try {
    return window.localStorage.getItem("manifold:show-pad-sessions") === "true";
  } catch {
    return false;
  }
}

/**
 * Cadences of the workspace index. Everything here is HTTP because the workspace itself has no
 * event channel yet — rooms fan out, the index does not — so a container another tab created
 * becomes visible one tick later. When that channel exists these three constants and every
 * `usePolledResource` call become subscriptions.
 */
const INDEX_POLL_MS = 2_000;
const PRESENCE_POLL_MS = 1_500;
const MACHINE_POLL_MS = 5_000;

/** Stable empty snapshots: a fresh literal per render would reseed nothing but churn. */
const NO_SESSIONS: readonly PadSessionSummary[] = [];
const NO_TERMINALS: readonly TerminalSummary[] = [];
const NO_PRESENCE: readonly PadPresence[] = [];
/** The sidebar joins no room, so it never holds elements: one shared empty map, not one per render. */
const EMPTY_ELEMENTS: ReadonlyMap<string, SceneElement> = new Map();

/**
 * What a cold deep-link shows while the container record is in flight. A sentence would be a
 * loading screen; this is the shape of what is about to arrive, so nothing jumps when it does.
 * Every warm navigation skips it entirely — the discipline is already known.
 */
function CanvasSkeleton() {
  return (
    <div className="canvas-skeleton" role="presentation" aria-busy="true">
      <span className="canvas-skeleton-bar" />
      <span className="canvas-skeleton-body" />
    </div>
  );
}

/** The same courtesy in the index: ghost rows rather than the word “Loading”. */
function IndexSkeleton() {
  return (
    <div className="index-skeleton" role="presentation" aria-busy="true">
      <span className="index-skeleton-row" />
      <span className="index-skeleton-row" />
      <span className="index-skeleton-row" />
    </div>
  );
}

/** One application shell: pad navigation stays mounted beside the active canvas. */
export function PadBrowser({ identity, requestedPadId, navigate }: PadBrowserProps) {
  /**
   * The container row under the cursor and what the carried item would do there. Any item can
   * be released on a row, so this is not a terminals-only hover: the assessment decides
   * whether the row paints as a target or as a refusal.
   */
  const [dropRow, setDropRow] = useState<{
    readonly padId: string;
    readonly assessment: ItemDropAssessment | null;
  } | null>(null);
  /** The same question for the index's own body, which is one target rather than one per row. */
  const [unplaceDrop, setUnplaceDrop] = useState<ItemDropAssessment | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);
  const [creating, setCreating] = useState(false);
  const [folderCreateParentId, setFolderCreateParentId] = useState<string | null | undefined>();
  const [folderName, setFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [folderRenameName, setFolderRenameName] = useState("");
  const [showSessions, setShowSessions] = useState(initialSessionTree);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [sectionOrder, setSectionOrder] =
    useState<readonly SidebarSectionId[]>(initialSectionOrder);
  // Destructured because the rule tracking ref reads taints every member access on an
  // object holding one; separate bindings keep the render-safe pieces render-usable.
  const {
    stackRef: sectionStackRef,
    reordering: sectionReordering,
    stackProps: sectionStackProps,
    dragProps: sectionDragProps,
  } = useSectionStackDrag(sectionOrder, (next) => {
    setSectionOrder(next);
    rememberSectionOrder(next);
  });
  const [collapsedSections, setCollapsedSections] =
    useState<CollapsedSections>(initialCollapsedSections);
  const reorderingRef = useRef(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [, renderTreeState] = useState(0);
  const dndFrameRef = useRef<number | null>(null);
  const treeInstanceRef = useRef<TreeInstance<PadTreeItem> | null>(null);
  const { notify } = useToast();
  const [workspace, setWorkspace] = useState<WorkspaceSidebarState | null>(null);
  /**
   * A composition publishes only one thing to the sidebar: how to birth a terminal inside it.
   * The wrapper object keeps that function out of the setState updater slot, where React
   * would call it instead of storing it.
   */
  const [tiledCreate, setTiledCreate] = useState<{
    readonly create: (machine?: MachineSummary) => void;
  } | null>(null);

  const fetchTree = useCallback(() => listPadTree(identity.token), [identity.token]);
  const fetchSessions = useCallback(() => getPadSessions(identity.token), [identity.token]);
  const fetchTerminals = useCallback(() => listTerminals(identity.token), [identity.token]);
  const fetchPresence = useCallback(() => getPadPresence(identity.token), [identity.token]);
  const fetchMachines = useCallback(() => getMachines(identity.token), [identity.token]);

  /**
   * The one question that tells a tree gesture apart from everything else. While a row is held,
   * the tree owns its own DOM and its own idea of the index: a poll that committed underneath
   * would rebuild the rows out from under the pointer, and the drop pipeline claiming the event
   * would steal a sibling reorder. Held poll responses are dropped, not queued — the tick after
   * the gesture settles carries the truth.
   */
  const treeOwnsDrag = useCallback(
    (): boolean => treeInstanceRef.current?.getState().dnd != null,
    [],
  );

  /** Set once an index exists, so a failing tick stops re-announcing what the sidebar still shows. */
  const indexLoadedRef = useRef(false);

  /**
   * The container index, polled like everything else in the workspace: a canvas another tab
   * creates has to appear here without a refresh. Content-compared, because the answer is
   * usually the previous answer and committing it would rebuild the headless tree — and drop an
   * in-flight rename — every couple of seconds for nothing.
   */
  const {
    value: treeItems,
    setValue: setTreeItems,
    refresh: refreshTree,
  } = usePolledResource<readonly PadTreeItem[] | null>(fetchTree, INDEX_POLL_MS, {
    initial: null,
    hold: treeOwnsDrag,
    equal: (current, incoming) =>
      current !== null && incoming !== null && samePadTreeItems(current, incoming),
    onError: (reason) => {
      if (indexLoadedRef.current) return;
      notify(reason instanceof Error ? reason.message : "Could not load views", {
        key: "tree-load",
      });
    },
  });

  /**
   * Every container the sidebar indexes. A pad and a composition are one object told apart by its
   * discipline, so nothing here filters by layout: the Views section lists them together and the
   * row's glyph carries the difference.
   */
  const pads = useMemo(
    () =>
      treeItems === null
        ? null
        : treeItems
            .filter((item): item is Extract<PadTreeItem, { kind: "pad" }> => item.kind === "pad")
            .map((item) => item.pad),
    [treeItems],
  );

  useEffect(() => {
    indexLoadedRef.current = treeItems !== null;
  }, [treeItems]);

  /** Session inventory and presence keep their last good snapshot; a failed tick says nothing. */
  const { value: padSessions } = usePolledResource(fetchSessions, INDEX_POLL_MS, {
    initial: NO_SESSIONS,
    hold: treeOwnsDrag,
  });
  const { value: presence } = usePolledResource(fetchPresence, PRESENCE_POLL_MS, {
    initial: NO_PRESENCE,
    hold: treeOwnsDrag,
    restartKey: requestedPadId,
  });

  /**
   * Every terminal in the workspace, not a pool: a terminal lives in a composition from birth,
   * so this listing is how the index learns which pad rows are actually terminals wearing a
   * composition's clothes, and which of them nothing references yet. Placing anything changes
   * both facts, so the active canvas's session count is the signal to re-ask at once.
   */
  const activeSessionCount = workspace?.status === "open" ? workspace.rows.length : null;
  const { value: terminals, refresh: refreshTerminals } = usePolledResource(
    fetchTerminals,
    INDEX_POLL_MS,
    { initial: NO_TERMINALS, hold: treeOwnsDrag, restartKey: activeSessionCount },
  );

  /**
   * A pad row IS a terminal when exactly one terminal calls it home: that is a solo
   * composition, and the paradigm says a composition of one is the item it holds — so the
   * index shows the terminal, with the terminal's name, glyph and actions. A composition two
   * terminals call home is a real composition again, and falls out of this map by construction.
   */
  const terminalByHome = useMemo(() => {
    const homes = new Map<string, TerminalSummary>();
    const shared = new Set<string>();
    for (const terminal of terminals) {
      if (homes.has(terminal.homeId)) shared.add(terminal.homeId);
      homes.set(terminal.homeId, terminal);
    }
    for (const homeId of shared) homes.delete(homeId);
    return homes;
  }, [terminals]);

  /**
   * The same fold as {@link terminalByHome}, in the shape the placement algebra asks for.
   * The index is the ONLY party that can see how many items a container holds, so it owns
   * this answer for everything below it — the sidebar's own drops and the canvas's compose
   * gesture both read it, which is what keeps a drag preview and the server's write in
   * agreement about "compositions merge, never nest".
   */
  const soloOccupants = useMemo<ReadonlyMap<string, PlacementItem>>(
    () =>
      new Map(
        [...terminalByHome].map(([homeId, terminal]) => [
          homeId,
          { kind: "terminal" as const, containerId: terminal.homeId },
        ]),
      ),
    [terminalByHome],
  );

  // The Machines section must outlive the canvas that used to feed it: on tiled routes
  // and at the workspace root no FlowPadView is mounted, so the list falls back to HTTP.
  const { value: fallbackMachines } = usePolledResource<readonly MachineSummary[] | null>(
    fetchMachines,
    MACHINE_POLL_MS,
    { initial: null, enabled: workspace === null },
  );
  const [collapsedPresence, setCollapsedPresence] = useState<CollapsedPresencePopover | null>(null);
  const [actionPadId, setActionPadId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<Pad | null>(null);
  const [renameName, setRenameName] = useState("");
  const [initialExpandedItems] = useState<string[]>(() => {
    try {
      const stored: unknown = JSON.parse(
        window.localStorage.getItem("manifold:expanded-pad-folders") ?? "[]",
      );
      return Array.isArray(stored)
        ? stored.filter((id): id is string => typeof id === "string")
        : [];
    } catch {
      return [];
    }
  });
  const [renaming, setRenaming] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  /**
   * Focus follows the ROW, not a render pass. A just-created container opens its rename
   * before the index tick carrying its row has landed, so an effect keyed on the rename
   * target fires while there is nothing to focus; the node claims focus as it attaches
   * instead — and never steals a selection back from an input already being typed in.
   */
  const renameInputRef = useCallback((input: HTMLInputElement | null): void => {
    if (input === null || input === document.activeElement) return;
    input.focus();
    input.select();
  }, []);
  const versionButtonRef = useRef<HTMLButtonElement | null>(null);
  const changelogDialogRef = useRef<HTMLDialogElement | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const [memory] = useState(browserPadStorage);
  /**
   * The routed container's own record. The tree is the usual source, but a composition born
   * by an expand exists before the sidebar has heard of it, so an unknown id is
   * fetched directly and the tree refetched so its row appears.
   */
  const [fetchedPad, setFetchedPad] = useState<Pad | null>(null);
  const [unresolvedPadId, setUnresolvedPadId] = useState<string | null>(null);
  const directPadFetchRef = useRef<string | null>(null);
  /** Shrink's return address: the last canvas the viewer was on, else the workspace root. */
  const [originPadId, setOriginPadId] = useState<string | null>(null);
  /**
   * Every container record this tab has already resolved. The renderer follows the container's
   * discipline, so navigating to something the index has ALREADY described must not wait on a
   * round trip — the answer is right here, and withholding it would mount a loading state over
   * a question that is already answered. Only a cold deep-link, an id this tab has never seen,
   * falls through to the fetch. State rather than a ref: the very first render after a
   * navigation reads it, which is the whole point.
   */
  const [knownPads, setKnownPads] = useState<ReadonlyMap<string, Pad>>(() => new Map());
  const rememberPads = useCallback((records: readonly Pad[]): void => {
    setKnownPads((current) => {
      // Rebuilt only when something actually changed: a poll that repeats itself must not
      // hand every reader a new map.
      let next: Map<string, Pad> | null = null;
      for (const pad of records) {
        if (current.get(pad.id) === pad) continue;
        next ??= new Map(current);
        next.set(pad.id, pad);
      }
      return next ?? current;
    });
  }, []);
  const forgetContainer = useCallback((padId: string): void => {
    setKnownPads((current) => {
      if (!current.has(padId)) return current;
      const next = new Map(current);
      next.delete(padId);
      return next;
    });
  }, []);

  /** Stable identity: the publishing effect inside the composition must not re-run per render. */
  const publishTiledCreate = useCallback(
    (create: ((machine?: MachineSummary) => void) | null): void => {
      setTiledCreate(create === null ? null : { create });
    },
    [],
  );

  const scheduleDndPresentation = useCallback((): void => {
    if (dndFrameRef.current !== null) return;
    dndFrameRef.current = window.requestAnimationFrame(() => {
      dndFrameRef.current = null;
      const tree = treeInstanceRef.current;
      if (tree === null) return;
      const container = tree.getElement();
      if (container === null || container === undefined) return;

      for (const element of container.querySelectorAll(".pad-tree-item.is-drop-target")) {
        element.classList.remove("is-drop-target");
      }
      for (const item of tree.getItems()) {
        item
          .getElement()
          ?.closest(".pad-tree-item")
          ?.classList.toggle("is-drop-target", item.isDragTarget());
      }

      const dragLine = container.querySelector<HTMLElement>(".pad-tree-drag-line");
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
        "manifold:expanded-pad-folders",
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

  /** Refetches the routed container and the index; a pin or a split changes both. */
  const refreshActivePad = useCallback((): void => {
    if (requestedPadId === null) return;
    refreshTree();
    void getPad(identity.token, requestedPadId)
      .then((pad) => {
        setFetchedPad(pad);
        rememberPads([pad]);
        setUnresolvedPadId(null);
      })
      .catch(() => {
        // Unreachable record: fall through to the canvas renderer, which surfaces the
        // join failure the same way a bad container id always has.
        setUnresolvedPadId(requestedPadId);
      });
  }, [identity.token, refreshTree, rememberPads, requestedPadId]);

  /**
   * The routed container's record: the index's copy when it holds one, else the one-shot fetch,
   * else what this tab already learned about that id. The last of those is what makes a warm
   * navigation instant.
   */
  const activePad =
    requestedPadId === null
      ? null
      : (pads?.find((pad) => pad.id === requestedPadId) ??
        (fetchedPad?.id === requestedPadId ? fetchedPad : null) ??
        knownPads.get(requestedPadId) ??
        null);

  // Render-phase adjustment (not an effect): the last canvas container visited is the
  // Shrink return address, and it only moves when the routed canvas actually changes.
  if (activePad?.layout === "canvas" && originPadId !== activePad.id) {
    setOriginPadId(activePad.id);
  }

  useEffect(() => {
    // Fetch each unknown routed id exactly once after the tree has answered; the tree
    // refetch inside refreshActivePad re-runs this effect with the row present.
    if (requestedPadId === null || pads === null) return;
    if (pads.some((pad) => pad.id === requestedPadId)) return;
    if (directPadFetchRef.current === requestedPadId) return;
    directPadFetchRef.current = requestedPadId;
    refreshActivePad();
  }, [pads, refreshActivePad, requestedPadId]);

  const killTerminalRow = useCallback(
    (sessionId: string): void => {
      void killTerminal(identity.token, sessionId)
        .catch((reason: unknown) => {
          // Kill and dismiss are one verb server-side (no conflict for exited rows), so
          // any rejection is a real failure worth reporting.
          console.error("evt=terminal_kill_failed", reason);
          notify("Could not kill the terminal", { key: "terminal-kill" });
        })
        .finally(() => {
          // Killing a terminal empties and deletes its home composition, so the container
          // index changes too: both listings have to be re-asked, not just the terminals one.
          refreshTerminals();
          refreshTree();
        });
    },
    [identity.token, notify, refreshTerminals, refreshTree],
  );

  const renameTerminalRow = useCallback(
    async (sessionId: string, name: string): Promise<void> => {
      try {
        await renameTerminal(identity.token, sessionId, name);
      } catch (reason: unknown) {
        notify(reason instanceof Error ? reason.message : "Could not rename the terminal", {
          key: "terminal-rename",
        });
        throw reason;
      } finally {
        refreshTerminals();
      }
    },
    [identity.token, notify, refreshTerminals],
  );

  /**
   * The sidebar's placement pipeline. It joins no room, so it holds no elements and is not
   * itself a container: every legality question it asks is answered from the container index
   * alone, and every write goes over HTTP because there is no socket here to carry it.
   *
   * The index CAN answer the two questions a room would otherwise answer. `terminalHomes` is
   * the terminals listing read the other way round, and `soloOccupants` is the same solo-comp
   * fold the rows are drawn from — so a drag onto a row previews exactly the placement the
   * server will perform, including looking THROUGH a solo composition to the terminal in it.
   */
  const lookup = useMemo(
    () =>
      createPlacementLookup({
        pads: pads ?? [],
        self: null,
        elements: EMPTY_ELEMENTS,
        terminalHomes: new Map(terminals.map((terminal) => [terminal.id, terminal.homeId])),
        soloOccupants,
      }),
    [pads, soloOccupants, terminals],
  );
  const drop = useItemDrop({
    lookup,
    place: (surface, destination) => placeItem(identity.token, surface, destination),
    notify,
    onPlaced: () => {
      refreshTerminals();
      refreshActivePad();
    },
  });

  /** Where a release on a container's row lands, decided by that row's own discipline. */
  const rowDestination = (pad: Pad): PlacementDestination =>
    pad.layout === "tiled"
      ? { kind: "tile", padId: pad.id, targetTileId: null, edge: null }
      : { kind: "canvas", padId: pad.id, x: DEFAULT_CANVAS_DROP.x, y: DEFAULT_CANVAS_DROP.y };

  /**
   * A container row accepts ANY carried item. The row's discipline picks the destination and the
   * pipeline decides legality, so an item that cannot land there says so instead of doing nothing.
   */
  const containerDropProps = (pad: Pad) => ({
    onDragOver: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (!carriesItem(event.dataTransfer) || treeOwnsDrag()) return;
      // Claimed either way: a refusal has to be shown here, not handed back to the browser.
      event.preventDefault();
      const assessment = drop.assess(rowDestination(pad));
      event.dataTransfer.dropEffect = assessment?.denial == null ? "move" : "none";
      setDropRow({ padId: pad.id, assessment });
    },
    onDragLeave: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (!carriesItem(event.dataTransfer) || treeOwnsDrag()) return;
      setDropRow((current) => (current?.padId === pad.id ? null : current));
    },
    onDrop: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (!carriesItem(event.dataTransfer) || treeOwnsDrag()) return;
      event.preventDefault();
      event.stopPropagation();
      setDropRow(null);
      drop.commit(event.dataTransfer, rowDestination(pad));
    },
  });

  /**
   * Releasing an item over the index's own body — past the last row, not on one — unplaces it:
   * every reference to it goes, and the item stays where it lives. That is what parking became
   * once there was no pool to park into, and it is why the target is the index rather than a
   * section of its own.
   */
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

  useEffect(() => {
    if (pads === null) return;
    if (requestedPadId !== null) {
      if (pads.some((pad) => pad.id === requestedPadId)) {
        rememberPad(memory, identity.principal.id, requestedPadId);
      }
      return;
    }
    const initialPad = chooseInitialPad(memory, identity.principal.id, pads);
    if (initialPad !== null) {
      navigate(`/p/${encodeURIComponent(initialPad.id)}`, { replace: true });
    }
  }, [identity.principal.id, memory, navigate, pads, requestedPadId]);

  useEffect(() => {
    if (actionPadId === null) return;
    const closeMenu = (event: PointerEvent): void => {
      if (
        event.target instanceof Element &&
        event.target.closest(".pad-sidebar-actions") !== null
      ) {
        return;
      }
      setActionPadId(null);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setActionPadId(null);
    };
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [actionPadId]);

  useEffect(() => {
    if (!changelogOpen) return;
    const dialog = changelogDialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, [changelogOpen]);

  const setOpen = (open: boolean): void => {
    setSidebarOpen(open);
    if (open) setCollapsedPresence(null);
    try {
      window.localStorage.setItem("manifold:sidebar-collapsed", String(!open));
    } catch {
      // Sidebar memory is optional.
    }
  };

  const toggleSection = (id: SidebarSectionId, collapsed: boolean): void => {
    // The icon rail force-opens the container index; that is layout, not a user collapse choice.
    if (!sidebarOpen) return;
    setCollapsedSections((current) => {
      if (current[id] === collapsed) return current;
      const next = { ...current, [id]: collapsed };
      rememberCollapsedSections(next);
      return next;
    });
  };

  /**
   * Creation is ONE click. A container is born as "Untitled", the operator lands inside it,
   * and its index row opens its inline rename — a name form in front of the object asked for
   * a name before there was anything to look at, and stood between the button and the work.
   */
  const createContainer = async (layout: Pad["layout"]): Promise<void> => {
    if (creating) return;
    setCreating(true);
    try {
      const pad = await createPad(identity.token, DEFAULT_CONTAINER_NAME, layout);
      // The new container's record is right here, so navigation has everything the renderer
      // needs: seed the memory and go. The index catches up on its own tick rather than making
      // a creation wait for a second round trip before it paints.
      rememberPads([pad]);
      refreshTree();
      rememberPad(memory, identity.principal.id, pad.id);
      navigate(`/p/${encodeURIComponent(pad.id)}`);
      openRename(pad);
    } catch (reason: unknown) {
      notify(
        reason instanceof Error
          ? reason.message
          : `Could not create the ${layout === "tiled" ? "composition" : "canvas"}`,
        { key: "container-create" },
      );
    } finally {
      setCreating(false);
    }
  };

  const remove = async (pad: Pad): Promise<void> => {
    setDeletingId(pad.id);
    try {
      await deletePad(identity.token, pad.id);
      const nextTree = await listPadTree(identity.token);
      const remaining = nextTree
        .filter((item): item is Extract<PadTreeItem, { kind: "pad" }> => item.kind === "pad")
        .map((item) => item.pad);
      setTreeItems(nextTree);
      forgetContainer(pad.id);
      forgetPad(memory, identity.principal.id, pad.id);
      if (requestedPadId === pad.id) {
        const deletedIndex = (pads ?? []).findIndex((candidate) => candidate.id === pad.id);
        const fallback = remaining[Math.min(deletedIndex, remaining.length - 1)] ?? null;
        if (fallback === null) {
          navigate("/", { replace: true });
        } else {
          rememberPad(memory, identity.principal.id, fallback.id);
          navigate(`/p/${encodeURIComponent(fallback.id)}`, { replace: true });
        }
      }
    } catch (reason: unknown) {
      notify(
        reason instanceof Error
          ? reason.message
          : `Could not delete the ${pad.layout === "tiled" ? "composition" : "canvas"}`,
        { key: "container-delete" },
      );
    } finally {
      setDeletingId(null);
    }
  };

  const openRename = (pad: Pad): void => {
    setActionPadId(null);
    setRenameTarget(pad);
    setRenameName(rowName(pad));
  };

  /**
   * One rename gesture, two writes. A solo composition and the terminal in it are one object
   * to the operator, and the terminal is the half that owns the name — so renaming that row
   * renames the TERMINAL, and the index picks the new label up on its next tick. Every other
   * row renames the container, which the index can apply locally at once.
   */
  const submitRename = async (): Promise<void> => {
    if (renameTarget === null) return;
    const target = renameTarget;
    const trimmedName = renameName.trim();
    if (trimmedName.length === 0 || trimmedName === rowName(target)) {
      setRenameTarget(null);
      return;
    }
    const terminal = terminalByHome.get(target.id);
    setRenaming(true);
    try {
      if (terminal !== undefined) {
        await renameTerminalRow(terminal.id, trimmedName);
        setRenameTarget(null);
        return;
      }
      const renamed = await renamePad(identity.token, target.id, trimmedName);
      setTreeItems(
        (current) =>
          current?.map((item) =>
            item.kind === "pad" && item.pad.id === renamed.id ? { ...item, pad: renamed } : item,
          ) ?? null,
      );
      setRenameTarget(null);
    } catch (reason: unknown) {
      // `renameTerminalRow` already announced its own failure; only the container path speaks.
      if (terminal !== undefined) return;
      notify(reason instanceof Error ? reason.message : `Could not rename the ${rowNoun(target)}`, {
        key: "container-rename",
      });
    } finally {
      setRenaming(false);
    }
  };

  const submitFolder = async (): Promise<void> => {
    const trimmedName = folderName.trim();
    if (trimmedName.length === 0 || folderCreateParentId === undefined) return;
    setCreatingFolder(true);
    try {
      const nextTree = await createPadFolder(identity.token, trimmedName, folderCreateParentId);
      setTreeItems(nextTree);
      if (folderCreateParentId !== null) {
        tree.getItemInstance(`folder:${folderCreateParentId}`).expand();
        renderSettledTreeState();
      }
      setFolderName("");
      setFolderCreateParentId(undefined);
    } catch (reason: unknown) {
      notify(reason instanceof Error ? reason.message : "Could not create the folder", {
        key: "folder-create",
      });
    } finally {
      setCreatingFolder(false);
    }
  };

  const submitFolderRename = async (
    folder: Extract<PadTreeItem, { kind: "folder" }>,
  ): Promise<void> => {
    const trimmedName = folderRenameName.trim();
    if (trimmedName.length === 0 || trimmedName === folder.name) {
      setRenamingFolderId(null);
      return;
    }
    try {
      setTreeItems(await renamePadFolder(identity.token, folder.id, trimmedName));
      setRenamingFolderId(null);
    } catch (reason: unknown) {
      notify(reason instanceof Error ? reason.message : "Could not rename the folder", {
        key: "folder-rename",
      });
    }
  };

  const removeFolder = async (folder: Extract<PadTreeItem, { kind: "folder" }>): Promise<void> => {
    setDeletingFolderId(folder.id);
    try {
      setTreeItems(await deletePadFolder(identity.token, folder.id));
      setRenamingFolderId(null);
    } catch (reason: unknown) {
      notify(reason instanceof Error ? reason.message : "Could not delete the folder", {
        key: "folder-delete",
      });
    } finally {
      setDeletingFolderId(null);
    }
  };

  const beginSidebarResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (!sidebarOpen || event.button !== 0) return;
    event.preventDefault();
    const move = (pointer: PointerEvent): void => {
      const max = Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - 320);
      setSidebarWidth(Math.max(MIN_SIDEBAR_WIDTH, Math.min(max, pointer.clientX)));
    };
    const finish = (pointer: PointerEvent): void => {
      move(pointer);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      const max = Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - 320);
      const width = Math.max(MIN_SIDEBAR_WIDTH, Math.min(max, pointer.clientX));
      rememberSidebarWidth(width);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish);
  };

  /**
   * A row click carries the record it was drawn from, so the renderer that mounts on the next
   * render already knows the discipline. Nothing here waits on the network: the row would not
   * exist if the index had not already answered.
   */
  const selectPad = (pad: Pad): void => {
    rememberPads([pad]);
    rememberPad(memory, identity.principal.id, pad.id);
    navigate(`/p/${encodeURIComponent(pad.id)}`);
  };
  const displayedPresence = projectLocalPresence(presence, identity.principal, requestedPadId);
  /**
   * Which renderer the route asks for. `unknown` is now reserved for the one case that truly is
   * unknown — a cold deep-link to an id this tab has never resolved — because `activePad`
   * answers from the remembered record for everything else.
   */
  const routedLayout: Pad["layout"] | "unknown" =
    requestedPadId === null
      ? "unknown"
      : activePad?.id === requestedPadId
        ? activePad.layout
        : unresolvedPadId === requestedPadId
          ? "canvas"
          : "unknown";
  /**
   * INDEX VISIBILITY: the top level is homes and the homeless. A container is a home and
   * always shows; an ITEM shows here only while nothing holds it, because a placed item is
   * already visible inside whatever holds it and listing it twice would make the index a
   * second, competing statement about where things are.
   *
   * A terminal is the only item with an index row of its own today (its home composition), and
   * `unplaced` is the server's own answer to "does anything reference this?" — derived, never
   * stored, so parking and unparking leave no state to go stale. Eliding the row is curation:
   * the composition exists either way.
   */
  const indexedTreeItems = useMemo(
    () =>
      treeItems?.filter(
        (item) => item.kind === "folder" || (terminalByHome.get(item.pad.id)?.unplaced ?? true),
      ) ?? null,
    [terminalByHome, treeItems],
  );

  const treeData = useMemo(() => {
    const data = new Map<string, { item: PadTreeItem; children: string[] }>();
    const roots = buildPadTree(indexedTreeItems ?? []);
    const addNodes = (nodes: readonly PadTreeNode[]): string[] =>
      nodes.map((node) => {
        const id = `${node.item.kind}:${treeItemId(node.item)}`;
        data.set(id, { item: node.item, children: addNodes(node.children) });
        return id;
      });
    data.set("root", { item: SIDEBAR_ROOT_ITEM, children: addNodes(roots) });
    return data;
  }, [indexedTreeItems]);
  const treeDataRef = useRef(treeData);
  const tree = useHeadlessTree<PadTreeItem>({
    initialState: { expandedItems: initialExpandedItems },
    // Core owns drag targeting; this paints its state without routing ItemInstance objects
    // through React, which tears down the tree during native drags in React 19.
    setDndState: scheduleDndPresentation,
    rootItemId: "root",
    getItemName: (item) => {
      const data = item.getItemData();
      return item.getId() === "root" ? "Views" : data.kind === "pad" ? data.pad.name : data.name;
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
      return data.kind === "pad" ? renameTarget?.id !== data.pad.id : renamingFolderId !== data.id;
    },
    canDrop: (_items, target) => isOrderedDragTarget(target) || target.item.isFolder(),
    // A container row drag also carries the one item envelope, so the same gesture that
    // reorders the tree drops that container into a tile or onto another canvas.
    createForeignDragObject: (items) => {
      const data = items[0]?.getItemData();
      return {
        format: ITEM_MIME,
        // A folder carries an empty payload: `carriesItem` is true but the envelope parser
        // rejects it, so every target reads it as "not one of our drags" and stays silent.
        data:
          data?.kind === "pad" ? sealEnvelope(containerEnvelope(data.pad.id, data.pad.layout)) : "",
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
      const optimisticTreeItems = projectPadTreeMove(treeItems, item, parentId, index);
      const request = movePadTreeItem(identity.token, item, parentId, index).then(
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
            notify(
              outcome.reason instanceof Error
                ? outcome.reason.message
                : "Could not move the sidebar item",
              { key: "tree-move" },
            );
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
   * A row's mark, one vocabulary for the one index: the object's own species icon, the same
   * one it wears in its titlebar. A solo composition wears the TERMINAL's mark, because a
   * composition of one is the item it holds and showing it as a container would be telling
   * the operator about bookkeeping they never asked for. Liveness rides ON that mark for a
   * terminal (`session-state` tints it) rather than beside it: one row, one glyph.
   */
  const containerMark = (pad: Pad): ReactNode => {
    const terminal = terminalByHome.get(pad.id);
    if (terminal !== undefined) {
      return (
        <span
          className={`pad-sidebar-item-mark session-state ${terminal.status === "running" ? "is-running" : ""}`}
          aria-hidden="true"
        >
          <ItemIcon kind="terminal" />
        </span>
      );
    }
    return (
      <span className="pad-sidebar-item-mark" aria-hidden="true">
        <ItemIcon kind={pad.layout === "tiled" ? "composition" : "canvas"} />
      </span>
    );
  };

  /**
   * What a row calls itself. A solo composition shows its terminal's name — the two are one
   * object from the operator's side — falling back to the container's own name while the
   * terminal is unnamed.
   */
  const rowName = (pad: Pad): string => terminalByHome.get(pad.id)?.name ?? pad.name;

  /** What a row IS, for every label that has to name it. */
  const rowNoun = (pad: Pad): string =>
    terminalByHome.has(pad.id) ? "terminal" : pad.layout === "tiled" ? "composition" : "canvas";

  /**
   * One inline editor for every index row. A canvas, a composition and a terminal are renamed
   * the same way from here; only the write differs, and `submitRename` decides that from the
   * row itself rather than from a second entry point.
   */
  const renderContainerRenameRow = (pad: Pad, active: boolean): ReactNode => {
    const label = rowName(pad);
    return (
      <div className={`pad-sidebar-row is-editing${active ? " is-active" : ""}`}>
        {containerMark(pad)}
        <input
          ref={renameInputRef}
          className="pad-sidebar-rename-input"
          aria-label={`Rename ${label}`}
          maxLength={120}
          value={renameName}
          disabled={renaming}
          onChange={(event) => setRenameName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submitRename();
            if (event.key === "Escape") setRenameTarget(null);
          }}
        />
        <button
          className="pad-sidebar-inline-action is-primary"
          aria-label={`Save name for ${label}`}
          title="Save"
          disabled={renaming || renameName.trim() === "" || renameName.trim() === label}
          onClick={() => void submitRename()}
        >
          <ControlIcon kind="confirm" />
        </button>
        <button
          className="pad-sidebar-inline-action"
          aria-label={`Cancel renaming ${label}`}
          title="Cancel"
          disabled={renaming}
          onClick={() => setRenameTarget(null)}
        >
          <ControlIcon kind="cancel" />
        </button>
      </div>
    );
  };

  /**
   * Destroying an index row is ONE action, whatever the row is — and for a terminal it really
   * is destruction: there is no pool to fall back into, so the PTY dies and the composition it
   * lived in goes with it. The verb on the menu item says so, which is the whole warning an
   * operator who chose "Kill" needs.
   */
  const destroyRow = (pad: Pad): void => {
    setActionPadId(null);
    const terminal = terminalByHome.get(pad.id);
    if (terminal === undefined) {
      void remove(pad);
      return;
    }
    killTerminalRow(terminal.id);
  };

  /** The row menu: rename inline, destroy on the click. */
  const renderContainerActions = (pad: Pad): ReactNode => {
    const label = rowName(pad);
    const kind = rowNoun(pad);
    const heading = `${kind[0]?.toUpperCase() ?? ""}${kind.slice(1)}`;
    return (
      <div className="pad-sidebar-actions">
        <button
          className="pad-sidebar-delete"
          title={`${heading} actions for ${label}`}
          aria-label={`${heading} actions for ${label}`}
          aria-pressed={actionPadId === pad.id}
          onClick={() => setActionPadId((current) => (current === pad.id ? null : pad.id))}
        >
          <ControlIcon kind="more" />
        </button>
        {actionPadId === pad.id ? (
          <div className="pad-sidebar-action-menu" role="menu">
            <button role="menuitem" onClick={() => openRename(pad)}>
              Rename
            </button>
            <button
              className="is-danger"
              role="menuitem"
              disabled={deletingId !== null}
              onClick={() => destroyRow(pad)}
            >
              {terminalByHome.has(pad.id) ? "Kill" : "Delete"}
            </button>
          </div>
        ) : null}
      </div>
    );
  };

  /**
   * One row per thing that exists. A canvas, a composition and a terminal are all index rows
   * here, because a terminal lives in a composition and a composition of one IS that terminal:
   * the glyph, the name and the destructive verb come from the row's own identity, and nothing
   * else about the row forks. Any carried item released on it is placed into that container —
   * whether that means a canvas element or a tile is the server's business, not the sidebar's.
   */
  const renderContainerRow = (pad: Pad): ReactNode => {
    const active = pad.id === requestedPadId;
    const principals = displayedPresence.find((entry) => entry.padId === pad.id)?.principals ?? [];
    const otherPrincipals = principals.filter(
      (principal) => principal.id !== identity.principal.id,
    );
    const visiblePrincipals = principals.slice(0, 3);
    const summaries = padSessions.filter((session) => session.padId === pad.id);
    const activeWorkspace = active ? workspace : null;
    const liveRows = activeWorkspace?.status === "open" ? activeWorkspace.rows : null;
    const displayedSessions = liveRows ?? summaries;
    const runningCount = displayedSessions.filter((session) => session.status === "running").length;

    let row: ReactNode;
    if (sidebarOpen && renameTarget?.id === pad.id) {
      row = renderContainerRenameRow(pad, active);
    } else {
      const rowDrop = dropRow?.padId === pad.id ? dropRow.assessment : null;
      row = (
        <div
          className={`pad-sidebar-row${active ? " is-active" : ""}${terminalByHome.get(pad.id)?.status === "exited" ? " is-exited" : ""}${rowDrop !== null && rowDrop.denial === null ? " pad-sidebar-row--terminal-target" : ""}`}
          {...drop.refusalProps(rowDrop)}
          {...containerDropProps(pad)}
        >
          <button
            className="pad-sidebar-link"
            type="button"
            title={rowName(pad)}
            aria-label={`Open ${rowNoun(pad)} ${rowName(pad)}`}
            aria-current={active ? "page" : undefined}
            onClick={() => selectPad(pad)}
            onKeyDown={(event) => {
              // Enter is the button's own activation; F2 and Delete match the row menu's items.
              if (event.key === "F2") {
                event.preventDefault();
                openRename(pad);
              }
              if (event.key === "Delete") {
                event.preventDefault();
                destroyRow(pad);
              }
            }}
          >
            {containerMark(pad)}
            {sidebarOpen ? <span className="pad-sidebar-pad-name">{rowName(pad)}</span> : null}
            {sidebarOpen && runningCount > 0 ? (
              <span
                className="pad-sidebar-session-count"
                title={`${runningCount} open ${runningCount === 1 ? "session" : "sessions"}`}
              >
                {runningCount}
              </span>
            ) : null}
            {sidebarOpen && principals.length > 0 ? (
              <span
                className="pad-sidebar-presence"
                aria-label={`${principals.length} present in ${rowName(pad)}`}
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
          {!sidebarOpen && otherPrincipals.length > 0 ? (
            <button
              className="pad-sidebar-collapsed-presence"
              type="button"
              aria-label={`${otherPrincipals.length} other ${otherPrincipals.length === 1 ? "participant" : "participants"} in ${rowName(pad)}`}
              aria-describedby={
                collapsedPresence?.padId === pad.id ? "collapsed-presence-popover" : undefined
              }
              onPointerEnter={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                setCollapsedPresence({ padId: pad.id, top: bounds.top, left: bounds.right + 8 });
              }}
              onPointerLeave={() => setCollapsedPresence(null)}
              onFocus={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                setCollapsedPresence({ padId: pad.id, top: bounds.top, left: bounds.right + 8 });
              }}
              onBlur={() => setCollapsedPresence(null)}
            >
              +{otherPrincipals.length}
            </button>
          ) : null}
          {sidebarOpen ? renderContainerActions(pad) : null}
        </div>
      );
    }

    return (
      <>
        {row}
        {sidebarOpen && showSessions && activeWorkspace?.status === "open"
          ? activeWorkspace.rows.map((session) => (
              <div className="pad-sidebar-session" key={session.id}>
                <WorkspaceSessionRow
                  row={session}
                  onFocus={activeWorkspace.onFocus}
                  onKill={activeWorkspace.onKill}
                  onRemoveCopy={activeWorkspace.onRemoveCopy}
                  onRemoveAllCopies={activeWorkspace.onRemoveAllCopies}
                  onHighlight={activeWorkspace.onHighlight}
                />
              </div>
            ))
          : null}
        {sidebarOpen && showSessions && activeWorkspace?.status !== "open"
          ? summaries.map((session) => {
              const machine = workspace?.machines?.find(
                (candidate) => candidate.id === session.machineId,
              );
              return (
                <button
                  className={`pad-sidebar-session is-summary${session.status === "exited" ? " is-exited" : ""}`}
                  type="button"
                  onClick={() => selectPad(pad)}
                  key={session.id}
                >
                  <span
                    className={`session-state ${session.status === "running" ? "is-running" : ""}`}
                    aria-hidden="true"
                  >
                    <ItemIcon kind="terminal" />
                  </span>
                  <span>{machine?.name ?? session.machineId}</span>
                  <small>{session.status}</small>
                </button>
              );
            })
          : null}
      </>
    );
  };

  const renderFolderCreateForm = (nested: boolean): ReactNode => (
    <form
      className={`pad-sidebar-create pad-sidebar-folder-create${nested ? " is-nested" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submitFolder();
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
          onClick={() => setFolderCreateParentId(undefined)}
          disabled={creatingFolder}
        >
          Cancel
        </button>
        <button type="submit" disabled={creatingFolder || folderName.trim() === ""}>
          {creatingFolder ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
  );

  const renderFolder = (
    folder: Extract<PadTreeItem, { kind: "folder" }>,
    item: ItemInstance<PadTreeItem>,
  ): ReactNode => {
    const actionId = `folder:${folder.id}`;
    if (!sidebarOpen) {
      return (
        <div className="pad-sidebar-row">
          <button
            className="pad-sidebar-link"
            type="button"
            title={folder.name}
            aria-label={`${item.isExpanded() ? "Collapse" : "Expand"} folder ${folder.name}`}
            onClick={(event) => {
              event.stopPropagation();
              if (item.isExpanded()) item.collapse();
              else item.expand();
              renderSettledTreeState();
            }}
          >
            <span className="pad-sidebar-folder-icon" aria-hidden="true">
              <ItemIcon kind={item.isExpanded() ? "folderOpen" : "folder"} />
            </span>
          </button>
        </div>
      );
    }
    if (renamingFolderId === folder.id) {
      return (
        <div className="pad-sidebar-row is-editing">
          <span className="pad-sidebar-folder-icon" aria-hidden="true">
            <ItemIcon kind="folder" />
          </span>
          <input
            className="pad-sidebar-rename-input"
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
            className="pad-sidebar-inline-action is-primary"
            aria-label={`Save name for ${folder.name}`}
            disabled={folderRenameName.trim() === ""}
            onClick={() => void submitFolderRename(folder)}
          >
            <ControlIcon kind="confirm" />
          </button>
          <button
            className="pad-sidebar-inline-action"
            aria-label={`Cancel renaming ${folder.name}`}
            onClick={() => setRenamingFolderId(null)}
          >
            <ControlIcon kind="cancel" />
          </button>
        </div>
      );
    }
    /* No confirmation step: the menu item already said Delete, and children move up. */
    return (
      <>
        <div className="pad-sidebar-row pad-sidebar-folder-row">
          <button
            className="pad-sidebar-folder-toggle"
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
            <span className="pad-sidebar-folder-chevron" aria-hidden="true">
              <ControlIcon kind={item.isExpanded() ? "disclosed" : "collapsed"} size={12} />
            </span>
            <span className="pad-sidebar-folder-icon" aria-hidden="true">
              <ItemIcon kind={item.isExpanded() ? "folderOpen" : "folder"} />
            </span>
            <strong>{folder.name}</strong>
          </button>
          <div className="pad-sidebar-actions" onClick={(event) => event.stopPropagation()}>
            <button
              className="pad-sidebar-folder-add"
              title={`New folder inside ${folder.name}`}
              aria-label={`New folder inside ${folder.name}`}
              onClick={() => {
                setFolderName("");
                setFolderCreateParentId(folder.id);
              }}
            >
              <span aria-hidden="true">+</span>
            </button>
            <button
              className="pad-sidebar-delete"
              title={`Folder actions for ${folder.name}`}
              aria-label={`Folder actions for ${folder.name}`}
              aria-pressed={actionPadId === actionId}
              onClick={() => setActionPadId((current) => (current === actionId ? null : actionId))}
            >
              <ControlIcon kind="more" />
            </button>
            {actionPadId === actionId ? (
              <div className="pad-sidebar-action-menu" role="menu">
                <button
                  role="menuitem"
                  onClick={() => {
                    setActionPadId(null);
                    setRenamingFolderId(folder.id);
                    setFolderRenameName(folder.name);
                  }}
                >
                  Rename
                </button>
                <button
                  className="is-danger"
                  role="menuitem"
                  disabled={deletingFolderId === folder.id}
                  onClick={() => {
                    setActionPadId(null);
                    void removeFolder(folder);
                  }}
                >
                  Delete
                </button>
              </div>
            ) : null}
          </div>
        </div>
        {folderCreateParentId === folder.id ? renderFolderCreateForm(true) : null}
      </>
    );
  };

  /**
   * The index body is itself a target: releasing an item over it — anywhere a row is not —
   * unplaces it. The tree's own reorder gesture is excluded by `treeOwnsDrag`, and a row
   * under the pointer stops the event before it reaches here, so the two never contend.
   */
  const containerTreeBody = (
    <div
      {...tree.getContainerProps()}
      className={`pad-sidebar-list pad-sidebar-tree${unplaceDrop !== null && unplaceDrop.denial === null ? " is-drop-target" : ""}`}
      data-testid="pad-sidebar-list"
      {...drop.refusalProps(unplaceDrop)}
      {...unplacedDropProps}
    >
      {sidebarOpen && indexedTreeItems === null ? <IndexSkeleton /> : null}
      {sidebarOpen && indexedTreeItems?.length === 0 ? (
        <p className="pad-sidebar-muted">Nothing here yet</p>
      ) : null}
      {indexedTreeItems === null
        ? null
        : tree.getItems().map((item) => {
            const data = item.getItemData();
            const itemProps = item.getProps();
            return (
              <div
                {...itemProps}
                className="pad-tree-item"
                data-tree-kind={data.kind}
                data-tree-id={treeItemId(data)}
                style={
                  sidebarOpen
                    ? { marginInlineStart: `${item.getItemMeta().level * 0.75}rem` }
                    : undefined
                }
                key={item.getId()}
              >
                {data.kind === "pad" ? renderContainerRow(data.pad) : renderFolder(data, item)}
              </div>
            );
          })}
      <div style={{ display: "none" }} className="pad-tree-drag-line" />
    </div>
  );

  /**
   * One shell per section, ordered by the user's stack. Collapsing the sidebar keeps only the
   * container index mounted (header hidden by CSS) so its tree container never reparents.
   */
  const renderSidebarSection = (section: SidebarSectionId): ReactNode => {
    if (section === "machines") {
      // A canvas feeds live machine state; tiled routes and the root use the HTTP poll.
      const machines = workspace?.machines ?? fallbackMachines;
      const online = machines?.filter((machine) => machine.online).length ?? 0;
      return (
        <SidebarSection
          id="machines"
          title="Machines"
          testId="machines-section"
          count={`${online}/${machines?.length ?? 0} online`}
          collapsed={collapsedSections.machines === true}
          onCollapsedChange={toggleSection}
          {...sectionDragProps("machines")}
          key="machines"
        >
          <div className="workspace-sidebar workspace-machines">
            {/* Whichever renderer is mounted owns the "+": a pad authors an element,
                a composition lets the server place a tile. */}
            <MachinesSection
              machines={machines}
              onCreateTerminal={workspace?.onCreateTerminal ?? tiledCreate?.create}
            />
          </div>
        </SidebarSection>
      );
    }
    if (section === "views") {
      // ONE index: canvases, compositions, and the terminals that live in them, folders over
      // all three. The count is what the index actually shows, not what exists — a placed
      // terminal's row is curated out, and counting it here would contradict the rows below.
      return (
        <SidebarSection
          id="views"
          title="Views"
          testId="views-section"
          count={indexedTreeItems?.filter((item) => item.kind === "pad").length ?? 0}
          collapsed={sidebarOpen && collapsedSections.views === true}
          grow
          actions={
            sidebarOpen ? (
              <button
                className="pad-sidebar-section-action"
                aria-pressed={showSessions}
                title={showSessions ? "Hide sessions under views" : "Show sessions under views"}
                aria-label={showSessions ? "Hide session tree" : "Show session tree"}
                onClick={(event) => {
                  // Inside the disclosure header: never toggle the section on an action click.
                  event.preventDefault();
                  event.stopPropagation();
                  setShowSessions((current) => {
                    try {
                      window.localStorage.setItem("manifold:show-pad-sessions", String(!current));
                    } catch {
                      // Session tree memory is optional.
                    }
                    return !current;
                  });
                }}
              >
                <ControlIcon kind="sessionTree" />
              </button>
            ) : undefined
          }
          onCollapsedChange={toggleSection}
          {...sectionDragProps("views")}
          key="views"
        >
          {sidebarOpen && folderCreateParentId === null ? renderFolderCreateForm(false) : null}
          {containerTreeBody}
        </SidebarSection>
      );
    }
    return null;
  };

  const collapsedPresencePrincipals =
    collapsedPresence === null
      ? []
      : (
          displayedPresence.find((entry) => entry.padId === collapsedPresence.padId)?.principals ??
          []
        ).filter((principal) => principal.id !== identity.principal.id);

  return (
    <>
      <main
        className={`pad-browser${sidebarOpen ? "" : " is-collapsed"}`}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <aside className="pad-sidebar" aria-label="Sidebar" ref={sidebarRef}>
          <header className="pad-sidebar-header">
            <span className="pad-sidebar-brand">
              <span className="pad-sidebar-mark" aria-hidden="true">
                M
              </span>
              {sidebarOpen ? (
                <span className="pad-sidebar-brand-copy">
                  <strong>manifold</strong>
                  <button
                    ref={versionButtonRef}
                    className="pad-sidebar-version"
                    type="button"
                    aria-label={`Open web changelog for ${WEB_VERSION_LABEL}`}
                    onClick={() => setChangelogOpen(true)}
                  >
                    {WEB_VERSION_LABEL}
                  </button>
                </span>
              ) : null}
            </span>
            <button
              className="pad-sidebar-icon-button"
              type="button"
              title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
              aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
              onClick={() => setOpen(!sidebarOpen)}
            >
              <ControlIcon kind={sidebarOpen ? "sidebarCollapse" : "sidebarExpand"} />
            </button>
          </header>

          <div className="pad-sidebar-create-buttons">
            <button
              className="pad-sidebar-new"
              type="button"
              title="New canvas"
              aria-label="New canvas"
              onClick={() => {
                if (!sidebarOpen) setOpen(true);
                void createContainer("canvas");
              }}
              disabled={creating}
            >
              <ControlIcon kind="add" />
              {sidebarOpen ? <span>New canvas</span> : null}
            </button>
            <button
              className="pad-sidebar-new pad-sidebar-new-view"
              type="button"
              title="New composition"
              aria-label="New composition"
              onClick={() => {
                if (!sidebarOpen) setOpen(true);
                void createContainer("tiled");
              }}
              disabled={creating}
            >
              <ItemIcon kind="composition" />
              {sidebarOpen ? <span>New composition</span> : null}
            </button>
            <button
              className="pad-sidebar-new pad-sidebar-new-folder"
              type="button"
              title="New folder"
              aria-label="New folder"
              onClick={() => {
                if (!sidebarOpen) setOpen(true);
                setFolderName("");
                setFolderCreateParentId(null);
              }}
            >
              <ItemIcon kind="folder" />
              {sidebarOpen ? <span>New folder</span> : null}
            </button>
          </div>

          <div
            ref={sectionStackRef}
            className={`pad-sidebar-sections${sectionReordering ? " is-reordering" : ""}`}
            {...sectionStackProps}
          >
            {(sidebarOpen ? sectionOrder : COLLAPSED_RAIL_SECTIONS).map(renderSidebarSection)}
          </div>

          {sidebarOpen && workspace !== null ? (
            <WorkspaceStatus
              status={workspace.status}
              savedAt={workspace.savedAt}
              rev={workspace.rev}
            />
          ) : null}

          <footer className="pad-sidebar-identity" title={identity.principal.name}>
            <span className="identity-dot" style={{ backgroundColor: identity.principal.color }} />
            {sidebarOpen ? <span>{identity.principal.name}</span> : null}
          </footer>
        </aside>
        {sidebarOpen ? (
          <button
            className="pad-sidebar-resize"
            type="button"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuemin={MIN_SIDEBAR_WIDTH}
            aria-valuemax={MAX_SIDEBAR_WIDTH}
            aria-valuenow={Math.round(sidebarWidth)}
            onPointerDown={beginSidebarResize}
            onDoubleClick={() => {
              setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
              rememberSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const delta = event.key === "ArrowLeft" ? -16 : 16;
              setSidebarWidth((current) => {
                const next = Math.max(
                  MIN_SIDEBAR_WIDTH,
                  Math.min(MAX_SIDEBAR_WIDTH, current + delta),
                );
                rememberSidebarWidth(next);
                return next;
              });
            }}
          />
        ) : null}

        <section className="pad-browser-canvas" aria-label="Active view">
          {requestedPadId === null ? (
            pads === null ? (
              <CanvasSkeleton />
            ) : (
              <div className="pad-browser-empty">
                {pads.length === 0 ? (
                  <>
                    <span className="pad-browser-empty-mark">M</span>
                    <h1>Your canvas starts here</h1>
                    <p>Create a canvas from the sidebar to begin.</p>
                    <button
                      className="primary-button"
                      type="button"
                      disabled={creating}
                      onClick={() => {
                        setOpen(true);
                        void createContainer("canvas");
                      }}
                    >
                      Create your first canvas
                    </button>
                  </>
                ) : null}
              </div>
            )
          ) : routedLayout === "unknown" ? (
            // A cold deep-link only: every id this tab has already seen answered above. The
            // renderer follows the container's discipline, so an unseen id waits for the record
            // rather than guessing — guessing would mean tearing a live room back down.
            <CanvasSkeleton />
          ) : routedLayout === "tiled" && activePad !== null ? (
            <PadErrorBoundary key={requestedPadId}>
              <TiledPadView
                pad={activePad}
                identity={identity}
                pads={pads ?? []}
                originPadId={originPadId}
                navigate={navigate}
                presence={displayedPresence}
                onPadChanged={refreshActivePad}
                soloOccupants={soloOccupants}
                onCreateTerminalChange={publishTiledCreate}
              />
            </PadErrorBoundary>
          ) : (
            <PadErrorBoundary key={requestedPadId}>
              <FlowPadView
                padId={requestedPadId}
                pads={pads ?? []}
                identity={identity}
                navigate={navigate}
                presence={displayedPresence}
                onWorkspaceChange={setWorkspace}
                soloOccupants={soloOccupants}
                isOverSidebar={(clientX, clientY) => {
                  const bounds = sidebarRef.current?.getBoundingClientRect();
                  return (
                    bounds !== undefined &&
                    clientX >= bounds.left &&
                    clientX <= bounds.right &&
                    clientY >= bounds.top &&
                    clientY <= bounds.bottom
                  );
                }}
              />
            </PadErrorBoundary>
          )}
        </section>
      </main>
      {typeof document !== "undefined" && changelogOpen
        ? createPortal(
            <dialog
              ref={changelogDialogRef}
              className="web-changelog-dialog"
              aria-labelledby="web-changelog-title"
              onCancel={(event) => {
                event.preventDefault();
                setChangelogOpen(false);
                window.requestAnimationFrame(() => versionButtonRef.current?.focus());
              }}
              onPointerDown={(event) => {
                if (event.target !== event.currentTarget) return;
                setChangelogOpen(false);
                window.requestAnimationFrame(() => versionButtonRef.current?.focus());
              }}
            >
              <section className="web-changelog-card">
                <header>
                  <div>
                    <span>Web application</span>
                    <h2 id="web-changelog-title">What’s new</h2>
                    <code>{WEB_VERSION_LABEL}</code>
                  </div>
                  <button
                    type="button"
                    aria-label="Close changelog"
                    onClick={() => {
                      setChangelogOpen(false);
                      window.requestAnimationFrame(() => versionButtonRef.current?.focus());
                    }}
                  >
                    <ControlIcon kind="close" />
                  </button>
                </header>
                <div className="web-changelog-releases">
                  {WEB_CHANGELOG.map((release) => (
                    <article key={release.version}>
                      <div>
                        <h3>Version {release.version}</h3>
                        <time dateTime={release.date}>{release.date}</time>
                      </div>
                      <ul>
                        {release.changes.map((change) => (
                          <li key={change}>{renderChangelogChange(change)}</li>
                        ))}
                      </ul>
                    </article>
                  ))}
                </div>
              </section>
            </dialog>,
            document.body,
          )
        : null}
      {typeof document !== "undefined" &&
      collapsedPresence !== null &&
      collapsedPresencePrincipals.length > 0
        ? createPortal(
            <div
              id="collapsed-presence-popover"
              className="collapsed-presence-popover"
              role="tooltip"
              style={{ top: collapsedPresence.top, left: collapsedPresence.left }}
            >
              {collapsedPresencePrincipals.map((principal) => (
                <div className="collapsed-presence-popover-row" key={principal.id}>
                  <span
                    className={`presence-avatar${principal.kind === "agent" ? " is-agent" : ""}`}
                    style={{ backgroundColor: principal.color }}
                  >
                    {initials(principal.name)}
                  </span>
                  <span>
                    <strong>{principal.name}</strong>
                    <small>{principal.kind}</small>
                  </span>
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
