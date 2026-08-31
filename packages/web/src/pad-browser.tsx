import { DEFAULT_WORKSPACE_LAYOUT, samePadTreeItems } from "@manifold/plugin";
import {
  PadRouteProvider,
  projectLocalPresence,
  usePolledResource,
  type PadRoute,
  type WorkspaceSidebarState,
} from "@manifold/plugin/hooks";
import { TileTree, WORKSPACE_TREE_CLASSES, setViewState, useToast } from "@manifold/plugin/ui";
import { PadResponseSchema } from "@manifold/protocol";
import type {
  MachineSummary,
  Pad,
  PadPresence,
  PadTreeItem,
  PlacementItem,
  TerminalSummary,
  TileLayout,
  TileNode,
} from "@manifold/protocol";
import { withTileRatios, withoutTileLeaf } from "@manifold/scene";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { getPad, getPadPresence, getWorkspaceLayout, type StoredIdentity } from "./api.ts";
import { browserPadStorage, chooseInitialPad, rememberPad } from "./pad-memory.ts";
import {
  PanelOutlet,
  PluginPlaceholder,
  useAuthoringRegistration,
  useHostServices,
} from "./plugin-host.tsx";

/**
 * THE workspace shell — and it is a composition, not a frame with plugin holes cut in it
 * (D2). A principal's layout is a `TileLayout` whose leaves are `panel` surfaces, rendered by
 * the same {@link TileTree} every tiled container uses: the sidebar and the pad view are
 * panes, and the seam between them is an ordinary divider. One tree vocabulary everywhere,
 * which is why the v0.5 tiling behaviour (seam bands, ratio normalization, drag) applies to
 * the workspace for free and needed no new code — only a third skin.
 *
 * What this file still owns is what a shell owns: the layout (fetch, optimistic drag, one
 * committed write per gesture), the workspace index the pad renderers need as props, and the
 * two contexts its own two panels read. Everything a user recognises AS a feature — the
 * sections, the drawing tool, the terminal actions — is a plugin.
 */

/** One committed layout write per gesture, not per frame (D6). */
const LAYOUT_COMMIT_MS = 300;

/**
 * Cadences of the workspace index. Everything here is HTTP because the workspace itself has
 * no event channel yet — rooms fan out, the index does not — so a container another tab
 * created becomes visible one tick later. When that channel exists (wave 2) these constants
 * and every `usePolledResource` call become subscriptions.
 */
const INDEX_POLL_MS = 2_000;
const PRESENCE_POLL_MS = 1_500;

/** Stable empty snapshots: a fresh literal per render would reseed nothing but churn. */
const NO_TERMINALS: readonly TerminalSummary[] = [];
const NO_PRESENCE: readonly PadPresence[] = [];

/** The name every container is born with; the operator renames it in place, or never. */
const DEFAULT_CONTAINER_NAME = "Untitled";

/**
 * The one device-local mirror of the sidebar's collapse state. The state itself is PRESENCE
 * (`view.sidebarCollapsed`, observable by every principal, A2); this key exists only so the
 * first paint after a reload matches what the tab looked like before it, before any socket
 * has answered. It is listed in the AXIOMS.md device-local register.
 */
const COLLAPSE_MIRROR_KEY = "manifold:sidebar-collapsed-mirror";

function initialSidebarOpen(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_MIRROR_KEY) !== "true";
  } catch {
    return true;
  }
}

interface NavigateOptions {
  readonly replace?: boolean;
}

interface PadBrowserProps {
  readonly identity: StoredIdentity;
  readonly requestedPadId: string | null;
  readonly navigate: (path: string, options?: NavigateOptions) => void;
}

/**
 * What the shell publishes to its own sidebar panel. Deliberately NOT `HostServices`: these
 * are the shell's internals, the sidebar panel is the shell's other half (see
 * `sidebar-panel.tsx`), and no plugin can reach this context.
 */
export interface WorkspaceShell {
  readonly identity: StoredIdentity;
  readonly sidebarOpen: boolean;
  setSidebarOpen(open: boolean): void;
  /** Connection and persistence state of the mounted canvas, when one is mounted. */
  readonly workspace: WorkspaceSidebarState | null;
  readonly creating: boolean;
  createContainer(layout: Pad["layout"]): void;
  createFolder(name: string): Promise<void>;
  registerSidebarElement(element: HTMLElement | null): void;
}

const WorkspaceShellContext = createContext<WorkspaceShell | null>(null);

/** Throws: the sidebar panel is the shell's own half and never renders outside it. */
export function useWorkspaceShell(): WorkspaceShell {
  const shell = useContext(WorkspaceShellContext);
  if (shell === null) {
    throw new Error("useWorkspaceShell requires a <PadBrowser> ancestor");
  }
  return shell;
}

export function PadBrowser({ identity, requestedPadId, navigate }: PadBrowserProps): ReactElement {
  const host = useHostServices();
  const registerAuthoring = useAuthoringRegistration();
  const { notify } = useToast();

  // ------------------------------------------------------------------- layout

  const [layout, setLayout] = useState<TileLayout | null>(null);
  /**
   * The tree a gesture is mutating, readable without a render. A divider drag emits per
   * frame and must not read a `layout` captured by a stale closure; the ref is that read.
   */
  const layoutRef = useRef<TileLayout | null>(null);
  const commitTimerRef = useRef<number | null>(null);
  const pendingCommitRef = useRef<TileLayout | null>(null);

  /**
   * ONE `core.layout.set` per gesture. A divider drag paints optimistically per frame and
   * commits once, on a trailing debounce after the last frame — the plane rule's commit
   * point (D6). An action per frame would put a hundred authority-checked writes on the wire
   * for one drag.
   */
  const scheduleCommit = useCallback(
    (next: TileLayout): void => {
      pendingCommitRef.current = next;
      if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = window.setTimeout(() => {
        commitTimerRef.current = null;
        const committed = pendingCommitRef.current;
        pendingCommitRef.current = null;
        if (committed === null) return;
        void host.client
          .action("core.layout.set", { layout: committed })
          .then((outcome) => {
            if (outcome.ok) return;
            notify(outcome.denial.message, { key: "layout-set" });
          })
          .catch((reason: unknown) => {
            notify(reason instanceof Error ? reason.message : "Could not save the layout", {
              key: "layout-set",
            });
          });
      }, LAYOUT_COMMIT_MS);
    },
    [host, notify],
  );

  useEffect(
    () => () => {
      if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current);
    },
    [],
  );

  const applyLayout = useCallback(
    (next: TileLayout, commit: boolean): void => {
      layoutRef.current = next;
      setLayout(next);
      if (commit) scheduleCommit(next);
    },
    [scheduleCommit],
  );

  useEffect(() => {
    let cancelled = false;
    void getWorkspaceLayout(identity.token)
      .then((stored) => {
        if (cancelled) return;
        layoutRef.current = stored;
        setLayout(stored);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        // A workspace with no readable tree is a workspace with no shell, so the engine's
        // default stands in rather than leaving the viewer with nothing to look at.
        console.error("evt=workspace_layout_fetch_failed", reason);
        layoutRef.current = DEFAULT_WORKSPACE_LAYOUT;
        setLayout(DEFAULT_WORKSPACE_LAYOUT);
      });
    return () => {
      cancelled = true;
    };
  }, [identity.token]);

  const onRatios = useCallback(
    (splitId: string, ratios: readonly number[]): void => {
      const current = layoutRef.current;
      if (current === null) return;
      const next = withTileRatios(current, splitId, ratios);
      if (next === null) return;
      applyLayout(next, true);
    },
    [applyLayout],
  );

  /**
   * A placeholder's own remove control. A disabled or unknown panel must never be able to
   * brick a layout (D4), so the pruned tree goes back through the same door the drag uses.
   */
  const pruneLeaf = useCallback(
    (tileId: string): void => {
      const current = layoutRef.current;
      if (current === null) return;
      const next = withoutTileLeaf(current, tileId);
      if (next === null) return;
      applyLayout(next, true);
    },
    [applyLayout],
  );

  const renderLeaf = useCallback(
    (node: TileNode): ReactNode => {
      const surface = node.surface;
      if (surface === null || surface.kind !== "panel") {
        // `core.layout.set` refuses a non-panel leaf, so this is either an empty pane or a
        // tree written by a client that spoke a different vocabulary. Named, and removable.
        return (
          <PluginPlaceholder
            name={surface === null ? "empty pane" : surface.kind}
            state="unknown"
            onRemove={() => pruneLeaf(node.id)}
          />
        );
      }
      return <PanelOutlet panelId={surface.panelId} onRemove={() => pruneLeaf(node.id)} />;
    },
    [pruneLeaf],
  );

  // ------------------------------------------------------------- sidebar state

  const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);

  useEffect(() => {
    // Two writes, one truth: presence is what other principals and agents observe (A2),
    // the mirror is what this device paints before the first frame arrives.
    setViewState({ sidebarCollapsed: !sidebarOpen });
    try {
      window.localStorage.setItem(COLLAPSE_MIRROR_KEY, String(!sidebarOpen));
    } catch {
      // Sidebar memory is optional.
    }
  }, [sidebarOpen]);

  const sidebarElementRef = useRef<HTMLElement | null>(null);
  const registerSidebarElement = useCallback((element: HTMLElement | null): void => {
    sidebarElementRef.current = element;
  }, []);

  // ----------------------------------------------------------- workspace index

  const [memory] = useState(browserPadStorage);
  const [creating, setCreating] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceSidebarState | null>(null);
  /**
   * A composition publishes only one thing to the shell: how to birth a terminal inside it.
   * The wrapper object keeps that function out of the setState updater slot, where React
   * would call it instead of storing it.
   */
  const [tiledCreate, setTiledCreate] = useState<{
    readonly create: (machine?: MachineSummary) => void;
  } | null>(null);
  const [fetchedPad, setFetchedPad] = useState<Pad | null>(null);
  const [unresolvedPadId, setUnresolvedPadId] = useState<string | null>(null);
  const directPadFetchRef = useRef<string | null>(null);
  /** Shrink's return address: the last canvas the viewer was on, else the workspace root. */
  const [originPadId, setOriginPadId] = useState<string | null>(null);

  const fetchTree = useCallback(() => host.client.padTree(), [host.client]);
  const fetchPresence = useCallback(() => getPadPresence(identity.token), [identity.token]);
  const fetchTerminals = useCallback(() => host.client.terminals(), [host.client]);

  /** Set once an index exists, so a failing tick stops re-announcing what is still shown. */
  const indexLoadedRef = useRef(false);

  /*
   * The index the RENDERERS need: a canvas is handed every container so it can name a portal's
   * target, and the placement algebra is answered from the terminals listing. The Views
   * section polls the same doors for itself — a plugin fetches its own data through
   * `host.client` and holds no wire to the shell's state — which is one duplicated request per
   * tick until the event plane replaces both with one subscription (wave 2).
   */
  const { value: treeItems, refresh: refreshTree } = usePolledResource<
    readonly PadTreeItem[] | null
  >(fetchTree, INDEX_POLL_MS, {
    initial: null,
    equal: (current, incoming) =>
      current !== null && incoming !== null && samePadTreeItems(current, incoming),
    onError: (reason) => {
      if (indexLoadedRef.current) return;
      notify(reason instanceof Error ? reason.message : "Could not load views", {
        key: "tree-load",
      });
    },
  });

  useEffect(() => {
    indexLoadedRef.current = treeItems !== null;
  }, [treeItems]);

  const { value: presence } = usePolledResource(fetchPresence, PRESENCE_POLL_MS, {
    initial: NO_PRESENCE,
    restartKey: requestedPadId,
  });

  const activeSessionCount = workspace?.status === "open" ? workspace.sessionCount : null;
  const { value: terminals, refresh: refreshTerminals } = usePolledResource(
    fetchTerminals,
    INDEX_POLL_MS,
    { initial: NO_TERMINALS, restartKey: activeSessionCount },
  );

  const pads = useMemo(
    () =>
      treeItems === null
        ? null
        : treeItems
            .filter((item): item is Extract<PadTreeItem, { kind: "pad" }> => item.kind === "pad")
            .map((item) => item.pad),
    [treeItems],
  );

  /**
   * What a container holds when it holds exactly ONE item — the whole of "compositions merge,
   * never nest". Placement looks THROUGH a solo composition to its occupant, so a canvas
   * portal onto a lone terminal drags as that terminal. Only the index can answer this, so
   * the shell owns the answer for every renderer below it.
   */
  const soloOccupants = useMemo<ReadonlyMap<string, PlacementItem>>(() => {
    const homes = new Map<string, TerminalSummary>();
    const shared = new Set<string>();
    for (const terminal of terminals) {
      if (homes.has(terminal.homeId)) shared.add(terminal.homeId);
      homes.set(terminal.homeId, terminal);
    }
    for (const homeId of shared) homes.delete(homeId);
    return new Map(
      [...homes].map(([homeId, terminal]) => [
        homeId,
        { kind: "terminal" as const, containerId: terminal.homeId },
      ]),
    );
  }, [terminals]);

  /**
   * Every container record this tab has already resolved. A warm navigation must not wait on
   * a round trip for an answer this tab already has; only a cold deep-link falls through to
   * the fetch. State rather than a ref: the very first render after a navigation reads it.
   */
  const [knownPads, setKnownPads] = useState<ReadonlyMap<string, Pad>>(() => new Map());
  const rememberPads = useCallback((records: readonly Pad[]): void => {
    setKnownPads((current) => {
      let next: Map<string, Pad> | null = null;
      for (const pad of records) {
        if (current.get(pad.id) === pad) continue;
        next ??= new Map(current);
        next.set(pad.id, pad);
      }
      return next ?? current;
    });
  }, []);

  /** Refetches the routed container and the index; a pin or a split changes both. */
  const refreshActivePad = useCallback((): void => {
    if (requestedPadId === null) return;
    refreshTree();
    refreshTerminals();
    void getPad(identity.token, requestedPadId)
      .then((pad) => {
        setFetchedPad(pad);
        rememberPads([pad]);
        setUnresolvedPadId(null);
      })
      .catch(() => {
        // Unreachable record: the renderer surfaces the join failure the way a bad
        // container id always has, and the route recovery effect below takes it from there.
        setUnresolvedPadId(requestedPadId);
      });
  }, [identity.token, refreshTerminals, refreshTree, rememberPads, requestedPadId]);

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

  useEffect(() => {
    // The index no longer holds the routed container and the direct fetch refused it: it is
    // gone (another principal, another tab, or the Views section deleted it). Leave rather
    // than sit on a dead route.
    if (requestedPadId === null || pads === null) return;
    if (unresolvedPadId !== requestedPadId) return;
    if (pads.some((pad) => pad.id === requestedPadId)) return;
    const fallback = pads[0] ?? null;
    if (fallback === null) {
      navigate("/", { replace: true });
      return;
    }
    rememberPad(memory, identity.principal.id, fallback.id);
    navigate(`/p/${encodeURIComponent(fallback.id)}`, { replace: true });
  }, [identity.principal.id, memory, navigate, pads, requestedPadId, unresolvedPadId]);

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

  /**
   * Creation is ONE click. A container is born as "Untitled" and the operator lands inside
   * it; the Views section renames it in place from its row, which is where every other rename
   * of that row already happens.
   */
  const createContainer = useCallback(
    (containerLayout: Pad["layout"]): void => {
      if (creating) return;
      setCreating(true);
      void host.client
        .action("core.views.createPad", {
          name: DEFAULT_CONTAINER_NAME,
          layout: containerLayout,
        })
        .then((outcome) => {
          if (!outcome.ok) {
            notify(outcome.denial.message, { key: "container-create" });
            return;
          }
          const { pad } = PadResponseSchema.parse(outcome.result);
          rememberPads([pad]);
          refreshTree();
          rememberPad(memory, identity.principal.id, pad.id);
          navigate(`/p/${encodeURIComponent(pad.id)}`);
        })
        .catch((reason: unknown) => {
          notify(
            reason instanceof Error
              ? reason.message
              : `Could not create the ${containerLayout === "tiled" ? "composition" : "canvas"}`,
            { key: "container-create" },
          );
        })
        .finally(() => setCreating(false));
    },
    [
      creating,
      host.client,
      identity.principal.id,
      memory,
      navigate,
      notify,
      refreshTree,
      rememberPads,
    ],
  );

  const createFolder = useCallback(
    async (name: string): Promise<void> => {
      try {
        const outcome = await host.client.action("core.views.createFolder", {
          name,
          parentId: null,
        });
        if (!outcome.ok) {
          notify(outcome.denial.message, { key: "folder-create" });
          return;
        }
        refreshTree();
      } catch (reason: unknown) {
        notify(reason instanceof Error ? reason.message : "Could not create the folder", {
          key: "folder-create",
        });
      }
    },
    [host.client, notify, refreshTree],
  );

  /** Stable identity: the publishing effect inside the composition must not re-run per render. */
  const onCreateTerminalChange = useCallback(
    (create: ((machine?: MachineSummary) => void) | null): void => {
      setTiledCreate(create === null ? null : { create });
    },
    [],
  );

  /**
   * The mounted renderer's authoring door, published to plugin code (the Machines section's
   * "+" is the one caller this wave). Null when nothing on screen can author a terminal —
   * the workspace root — which is exactly when the affordance must not be offered.
   */
  const createTerminal = workspace?.onCreateTerminal ?? tiledCreate?.create ?? null;
  useEffect(() => {
    registerAuthoring(createTerminal === null ? null : { createTerminal });
    return () => registerAuthoring(null);
  }, [createTerminal, registerAuthoring]);

  /**
   * THIS device's own principal, normalized into the wire shape the cross-pad presence poll
   * will report a tick later, so every renderer downstream consumes one producer-agnostic row
   * set and never learns which principal is local (AGENTS.md invariant 11). It is engine plane
   * mechanism rather than `core.presence`'s, and deliberately: the projection is neutral
   * arithmetic over wire payloads, and routing it through a plugin registration would put a
   * second producer of "where is this principal" beside the server's.
   */
  const displayedPresence = projectLocalPresence(presence, identity.principal, requestedPadId);

  /**
   * Which renderer the route asks for. `unknown` is reserved for the one case that truly is
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

  const isOverSidebar = useCallback((clientX: number, clientY: number): boolean => {
    const bounds = sidebarElementRef.current?.getBoundingClientRect();
    return (
      bounds !== undefined &&
      clientX >= bounds.left &&
      clientX <= bounds.right &&
      clientY >= bounds.top &&
      clientY <= bounds.bottom
    );
  }, []);

  const shell = useMemo<WorkspaceShell>(
    () => ({
      identity,
      sidebarOpen,
      setSidebarOpen,
      workspace,
      creating,
      createContainer,
      createFolder,
      registerSidebarElement,
    }),
    [
      createContainer,
      createFolder,
      creating,
      identity,
      registerSidebarElement,
      sidebarOpen,
      workspace,
    ],
  );

  const route = useMemo<PadRoute>(
    () => ({
      identity,
      requestedPadId,
      activePad,
      pads,
      routedLayout,
      originPadId,
      presence: displayedPresence,
      soloOccupants,
      creating,
      navigate,
      createContainer,
      refreshActivePad,
      onWorkspaceChange: setWorkspace,
      onCreateTerminalChange,
      isOverSidebar,
    }),
    [
      activePad,
      createContainer,
      creating,
      displayedPresence,
      identity,
      isOverSidebar,
      navigate,
      onCreateTerminalChange,
      originPadId,
      pads,
      refreshActivePad,
      requestedPadId,
      routedLayout,
      soloOccupants,
    ],
  );

  return (
    <main className={`pad-browser${sidebarOpen ? "" : " is-collapsed"}`}>
      <WorkspaceShellContext.Provider value={shell}>
        <PadRouteProvider value={route}>
          {layout === null ? null : (
            <TileTree
              layout={layout}
              classes={WORKSPACE_TREE_CLASSES}
              // Always: this is the caller's OWN layout, so its seams are always live.
              interactive={true}
              onRatios={onRatios}
              renderLeaf={renderLeaf}
            />
          )}
        </PadRouteProvider>
      </WorkspaceShellContext.Provider>
    </main>
  );
}
