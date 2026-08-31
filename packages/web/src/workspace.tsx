import { DEFAULT_WORKSPACE_LAYOUT, sameIndexEntries } from "@manifold/plugin";
import {
  ContainerRouteProvider,
  projectLocalPresence,
  usePolledResource,
  type ContainerRoute,
  type WorkspaceSidebarState,
} from "@manifold/plugin/hooks";
import { TileTree, WORKSPACE_TREE_CLASSES, setVantage, useNotice } from "@manifold/plugin/ui";
import { ContainerResponseSchema } from "@manifold/protocol";
import type {
  MachineSummary,
  Container,
  Attendance,
  IndexEntry,
  PlacementItem,
  TerminalSummary,
  TileLayout,
  Tile,
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
import { getContainer, getAttendance, getWorkspaceLayout, type StoredIdentity } from "./api.ts";
import {
  browserContainerStorage,
  chooseInitialContainer,
  rememberContainer,
} from "./container-memory.ts";
import {
  PanelOutlet,
  PluginPlaceholder,
  useAuthoringRegistration,
  useHostServices,
} from "./plugin-host.tsx";

/**
 * THE workspace shell — and it is a composition, not a frame with plugin holes cut in it
 * (D2). A principal's layout is a `TileLayout` whose leaves are `panel` refs, rendered by
 * the same {@link TileTree} every composition uses: the sidebar and the container view are
 * panes, and the seam between them is an ordinary divider. One tree vocabulary everywhere,
 * which is why the v0.5 tiling behaviour (seam bands, ratio normalization, drag) applies to
 * the workspace for free and needed no new code — only a third skin.
 *
 * What this file still owns is what a shell owns: the layout (fetch, optimistic drag, one
 * committed write per gesture), the workspace index the container renderers need as props, and the
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
const NO_PRESENCE: readonly Attendance[] = [];

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

interface WorkspaceHostProps {
  readonly identity: StoredIdentity;
  readonly requestedContainerId: string | null;
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
  createContainer(discipline: Container["discipline"]): void;
  createFolder(name: string): Promise<void>;
  registerSidebarElement(element: HTMLElement | null): void;
}

const WorkspaceShellContext = createContext<WorkspaceShell | null>(null);

/** Throws: the sidebar panel is the shell's own half and never renders outside it. */
export function useWorkspaceShell(): WorkspaceShell {
  const shell = useContext(WorkspaceShellContext);
  if (shell === null) {
    throw new Error("useWorkspaceShell requires a <WorkspaceHost> ancestor");
  }
  return shell;
}

export function WorkspaceHost({
  identity,
  requestedContainerId,
  navigate,
}: WorkspaceHostProps): ReactElement {
  const host = useHostServices();
  const registerAuthoring = useAuthoringRegistration();
  const { notify } = useNotice();

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
   * ONE `core.space.setLayout` per gesture. A divider drag paints optimistically per frame and
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
          .action("core.space.setLayout", { layout: committed })
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
    (node: Tile): ReactNode => {
      const ref = node.ref;
      if (ref === null || ref.kind !== "panel") {
        // `core.space.setLayout` refuses a non-panel leaf, so this is either an empty pane or a
        // tree written by a client that spoke a different vocabulary. Named, and removable.
        return (
          <PluginPlaceholder
            name={ref === null ? "empty pane" : ref.kind}
            state="unknown"
            onRemove={() => pruneLeaf(node.id)}
          />
        );
      }
      return <PanelOutlet panelId={ref.panelId} onRemove={() => pruneLeaf(node.id)} />;
    },
    [pruneLeaf],
  );

  // ------------------------------------------------------------- sidebar state

  const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);

  useEffect(() => {
    // Two writes, one truth: presence is what other principals and agents observe (A2),
    // the mirror is what this device paints before the first frame arrives.
    setVantage({ sidebarCollapsed: !sidebarOpen });
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

  const [memory] = useState(browserContainerStorage);
  const [creating, setCreating] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceSidebarState | null>(null);
  /**
   * A composition publishes only one thing to the shell: how to birth a terminal inside it.
   * The wrapper object keeps that function out of the setState updater slot, where React
   * would call it instead of storing it.
   */
  const [compositionCreate, setCompositionCreate] = useState<{
    readonly create: (machine?: MachineSummary) => void;
  } | null>(null);
  const [fetchedContainer, setFetchedContainer] = useState<Container | null>(null);
  const [unresolvedContainerId, setUnresolvedContainerId] = useState<string | null>(null);
  const directContainerFetchRef = useRef<string | null>(null);
  /** Shrink's return address: the last canvas the viewer was on, else the workspace root. */
  const [originContainerId, setOriginContainerId] = useState<string | null>(null);

  const fetchTree = useCallback(() => host.client.index(), [host.client]);
  const fetchPresence = useCallback(() => getAttendance(identity.token), [identity.token]);
  const fetchTerminals = useCallback(() => host.client.allTerminals(), [host.client]);

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
    readonly IndexEntry[] | null
  >(fetchTree, INDEX_POLL_MS, {
    initial: null,
    equal: (current, incoming) =>
      current !== null && incoming !== null && sameIndexEntries(current, incoming),
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
    restartKey: requestedContainerId,
  });

  const activeTerminalCount = workspace?.status === "open" ? workspace.terminalCount : null;
  const { value: terminals, refresh: refreshTerminals } = usePolledResource(
    fetchTerminals,
    INDEX_POLL_MS,
    { initial: NO_TERMINALS, restartKey: activeTerminalCount },
  );

  const containers = useMemo(
    () =>
      treeItems === null
        ? null
        : treeItems
            .filter(
              (item): item is Extract<IndexEntry, { kind: "container" }> =>
                item.kind === "container",
            )
            .map((item) => item.container),
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
    for (const containerId of shared) homes.delete(containerId);
    return new Map(
      [...homes].map(([containerId, terminal]) => [
        containerId,
        { kind: "terminal" as const, containerId: terminal.homeId },
      ]),
    );
  }, [terminals]);

  /**
   * Every container record this tab has already resolved. A warm navigation must not wait on
   * a round trip for an answer this tab already has; only a cold deep-link falls through to
   * the fetch. State rather than a ref: the very first render after a navigation reads it.
   */
  const [knownContainers, setKnownContainers] = useState<ReadonlyMap<string, Container>>(
    () => new Map(),
  );
  const rememberContainers = useCallback((records: readonly Container[]): void => {
    setKnownContainers((current) => {
      let next: Map<string, Container> | null = null;
      for (const container of records) {
        if (current.get(container.id) === container) continue;
        next ??= new Map(current);
        next.set(container.id, container);
      }
      return next ?? current;
    });
  }, []);

  /** Refetches the routed container and the index; a pin or a split changes both. */
  const refreshActiveContainer = useCallback((): void => {
    if (requestedContainerId === null) return;
    refreshTree();
    refreshTerminals();
    void getContainer(identity.token, requestedContainerId)
      .then((container) => {
        setFetchedContainer(container);
        rememberContainers([container]);
        setUnresolvedContainerId(null);
      })
      .catch(() => {
        // Unreachable record: the renderer refs the join failure the way a bad
        // container id always has, and the route recovery effect below takes it from there.
        setUnresolvedContainerId(requestedContainerId);
      });
  }, [identity.token, refreshTerminals, refreshTree, rememberContainers, requestedContainerId]);

  const activeContainer =
    requestedContainerId === null
      ? null
      : (containers?.find((container) => container.id === requestedContainerId) ??
        (fetchedContainer?.id === requestedContainerId ? fetchedContainer : null) ??
        knownContainers.get(requestedContainerId) ??
        null);

  // Render-phase adjustment (not an effect): the last canvas container visited is the
  // Shrink return address, and it only moves when the routed canvas actually changes.
  if (activeContainer?.discipline === "canvas" && originContainerId !== activeContainer.id) {
    setOriginContainerId(activeContainer.id);
  }

  useEffect(() => {
    // Fetch each unknown routed id exactly once after the tree has answered; the tree
    // refetch inside refreshActiveContainer re-runs this effect with the row present.
    if (requestedContainerId === null || containers === null) return;
    if (containers.some((container) => container.id === requestedContainerId)) return;
    if (directContainerFetchRef.current === requestedContainerId) return;
    directContainerFetchRef.current = requestedContainerId;
    refreshActiveContainer();
  }, [containers, refreshActiveContainer, requestedContainerId]);

  useEffect(() => {
    // The index no longer holds the routed container and the direct fetch refused it: it is
    // gone (another principal, another tab, or the Views section deleted it). Leave rather
    // than sit on a dead route.
    if (requestedContainerId === null || containers === null) return;
    if (unresolvedContainerId !== requestedContainerId) return;
    if (containers.some((container) => container.id === requestedContainerId)) return;
    const fallback = containers[0] ?? null;
    if (fallback === null) {
      navigate("/", { replace: true });
      return;
    }
    rememberContainer(memory, identity.principal.id, fallback.id);
    navigate(`/p/${encodeURIComponent(fallback.id)}`, { replace: true });
  }, [
    identity.principal.id,
    memory,
    navigate,
    containers,
    requestedContainerId,
    unresolvedContainerId,
  ]);

  useEffect(() => {
    if (containers === null) return;
    if (requestedContainerId !== null) {
      if (containers.some((container) => container.id === requestedContainerId)) {
        rememberContainer(memory, identity.principal.id, requestedContainerId);
      }
      return;
    }
    const initialContainer = chooseInitialContainer(memory, identity.principal.id, containers);
    if (initialContainer !== null) {
      navigate(`/p/${encodeURIComponent(initialContainer.id)}`, { replace: true });
    }
  }, [identity.principal.id, memory, navigate, containers, requestedContainerId]);

  /**
   * Creation is ONE click. A container is born as "Untitled" and the operator lands inside
   * it; the Views section renames it in place from its row, which is where every other rename
   * of that row already happens.
   */
  const createContainer = useCallback(
    (discipline: Container["discipline"]): void => {
      if (creating) return;
      setCreating(true);
      void host.client
        .action("core.index.createContainer", {
          name: DEFAULT_CONTAINER_NAME,
          discipline,
        })
        .then((outcome) => {
          if (!outcome.ok) {
            notify(outcome.denial.message, { key: "container-create" });
            return;
          }
          const { container } = ContainerResponseSchema.parse(outcome.result);
          rememberContainers([container]);
          refreshTree();
          rememberContainer(memory, identity.principal.id, container.id);
          navigate(`/p/${encodeURIComponent(container.id)}`);
        })
        .catch((reason: unknown) => {
          notify(
            reason instanceof Error
              ? reason.message
              : `Could not create the ${discipline === "composition" ? "composition" : "canvas"}`,
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
      rememberContainers,
    ],
  );

  const createFolder = useCallback(
    async (name: string): Promise<void> => {
      try {
        const outcome = await host.client.action("core.index.createFolder", {
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
      setCompositionCreate(create === null ? null : { create });
    },
    [],
  );

  /**
   * The mounted renderer's authoring door, published to plugin code (the Machines section's
   * "+" is the one caller this wave). Null when nothing on screen can author a terminal —
   * the workspace root — which is exactly when the affordance must not be offered.
   */
  const createTerminal = workspace?.onCreateTerminal ?? compositionCreate?.create ?? null;
  useEffect(() => {
    registerAuthoring(createTerminal === null ? null : { createTerminal });
    return () => registerAuthoring(null);
  }, [createTerminal, registerAuthoring]);

  /**
   * THIS device's own principal, normalized into the wire shape the cross-container presence poll
   * will report a tick later, so every renderer downstream consumes one producer-agnostic row
   * set and never learns which principal is local (AGENTS.md invariant 11). It is engine plane
   * mechanism rather than `core.presence`'s, and deliberately: the projection is neutral
   * arithmetic over wire payloads, and routing it through a plugin registration would put a
   * second producer of "where is this principal" beside the server's.
   */
  const displayedPresence = projectLocalPresence(
    presence,
    identity.principal,
    requestedContainerId,
  );

  /**
   * Which renderer the route asks for. `unknown` is reserved for the one case that truly is
   * unknown — a cold deep-link to an id this tab has never resolved — because `activeContainer`
   * answers from the remembered record for everything else.
   */
  const routedDiscipline: Container["discipline"] | "unknown" =
    requestedContainerId === null
      ? "unknown"
      : activeContainer?.id === requestedContainerId
        ? activeContainer.discipline
        : unresolvedContainerId === requestedContainerId
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

  const route = useMemo<ContainerRoute>(
    () => ({
      identity,
      requestedContainerId,
      activeContainer,
      containers,
      routedDiscipline,
      originContainerId,
      presence: displayedPresence,
      soloOccupants,
      creating,
      navigate,
      createContainer,
      refreshActiveContainer,
      onWorkspaceChange: setWorkspace,
      onCreateTerminalChange,
      isOverSidebar,
    }),
    [
      activeContainer,
      createContainer,
      creating,
      displayedPresence,
      identity,
      isOverSidebar,
      navigate,
      onCreateTerminalChange,
      originContainerId,
      containers,
      refreshActiveContainer,
      requestedContainerId,
      routedDiscipline,
      soloOccupants,
    ],
  );

  return (
    <main className={`workspace${sidebarOpen ? "" : " is-collapsed"}`}>
      <WorkspaceShellContext.Provider value={shell}>
        <ContainerRouteProvider value={route}>
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
        </ContainerRouteProvider>
      </WorkspaceShellContext.Provider>
    </main>
  );
}
