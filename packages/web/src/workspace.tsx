import "./shell.css";
import {
  DEFAULT_LAYOUT_NOTICES,
  composeDefaultLayout,
  panelSections,
  sameIndexEntries,
  withPanelSections,
} from "@manifold/plugin";
import {
  ContainerRouteProvider,
  WorkspaceShellProvider,
  carriesItem,
  projectLocalPresence,
  usePolledResource,
  ATTENDANCE_RESOURCE,
  INDEX_RESOURCE,
  TERMINALS_RESOURCE,
  type ContainerRoute,
  type WorkspaceShell,
  type WorkspaceSidebarState,
} from "@manifold/plugin/hooks";
import {
  TileTree,
  WORKSPACE_TREE_CLASSES,
  setVantage,
  useNotice,
  useVantage,
} from "@manifold/plugin/ui";
import { ContainerResponseSchema } from "@manifold/protocol";
import type {
  MachineSummary,
  Container,
  Attendance,
  IndexEntry,
  PlacementItem,
  SectionNode,
  TerminalSummary,
  TileLayout,
  Tile,
} from "@manifold/protocol";
import { withTileRatios, withoutTileLeaf } from "@manifold/scene";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  INDEX_CREATE_CONTAINER_ACTION,
  INDEX_CREATE_FOLDER_ACTION,
  SIDEBAR_PANEL,
  SPACE_SET_LAYOUT_ACTION,
} from "./assembly.ts";
import { getContainer, getAttendance, getWorkspaceLayout, type StoredIdentity } from "./api.ts";
import {
  browserContainerStorage,
  chooseInitialContainer,
  rememberContainer,
} from "./container-memory.ts";
import {
  PanelOutlet,
  PluginPlaceholder,
  useAssembly,
  useAuthoringRegistration,
  useHostServices,
  useTileGeometryRegistration,
} from "./plugin-host.tsx";
import { WEB_CHANGELOG, WEB_VERSION_LABEL } from "./web-version.ts";

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


/**
 * The FALLBACK cadence of the workspace index (ADR 0012, wave 2).
 *
 * Every feed below now names the collection nodes its answer is news about and refreshes on
 * an event; this number is what happens while there is no session channel to carry one — a
 * dropped socket, or the workspace root of a brand-new workspace, which has no room and
 * therefore nothing to subscribe through. It is never a rate a live workspace pays.
 *
 * ONE cadence, deliberately, for the same reason it was one before: the attendance roster
 * used to run at 1.5s here and at 2s in the index section — two rates for one resource,
 * chosen by nobody — and under the shared feed the faster one simply wins for both readers.
 */
const INDEX_POLL_MS = 2_000;

/** Stable empty snapshots: a fresh literal per render would reseed nothing but churn. */
const NO_TERMINALS: readonly TerminalSummary[] = [];
const NO_PRESENCE: readonly Attendance[] = [];

/** The name every container is born with; the operator renames it in place, or never. */
const DEFAULT_CONTAINER_NAME = "Untitled";

/**
 * The one device-local mirror of the sidebar's collapse state. The state itself is PRESENCE
 * (`view.sidebarCollapsed`, observable by every principal, A2); this key exists only so the
 * first paint after a reload matches what the tab looked like before it, before any socket
 * has answered. It is listed in the REGISTRY.md device-local register.
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

export function WorkspaceHost({
  identity,
  requestedContainerId,
  navigate,
}: WorkspaceHostProps): ReactElement {
  const host = useHostServices();
  // The panel TITLES, for the grab controls arrange mode puts on every pane. Which panels
  // exist is composition's answer, not this file's — it reads the registry, names nothing.
  const assembly = useAssembly();
  const registerAuthoring = useAuthoringRegistration();
  const { notify } = useNotice();

  // ------------------------------------------------------------------- layout

  const [layout, setLayout] = useState<TileLayout | null>(null);
  /**
   * The tree a gesture is mutating, readable without a render. A divider drag emits per
   * frame and must not read a `layout` captured by a stale closure; the ref is that read.
   */
  const layoutRef = useRef<TileLayout | null>(null);
  /**
   * The CURRENT roster, readable from the boot fetch without being a reason to re-run it. The
   * fallback below needs whatever is enabled at the moment the fetch fails; putting `assembly`
   * in that effect's dependencies would instead re-fetch the stored tree on every enablement
   * change and discard a gesture that has not reached its commit point.
   */
  const assemblyRef = useRef(assembly);
  useEffect(() => {
    assemblyRef.current = assembly;
  }, [assembly]);

  /** Discrete gestures dispatch here; divider frames only update the local tree. */
  const commitLayout = useCallback(
    (next: TileLayout): void => {
      void host.client
        .action(SPACE_SET_LAYOUT_ACTION, { layout: next })
        .then((outcome) => {
          if (outcome.ok) return;
          notify(outcome.denial.message, { key: "layout-set" });
        })
        .catch((reason: unknown) => {
          notify(reason instanceof Error ? reason.message : "Could not save the layout", {
            key: "layout-set",
          });
        });
    },
    [host.client, notify],
  );


  const applyLayout = useCallback(
    (next: TileLayout, commit: boolean): void => {
      layoutRef.current = next;
      setLayout(next);
      if (commit) commitLayout(next);
    },
    [commitLayout],
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
        /*
          A workspace with no readable tree is a workspace with no shell, so the DEFAULT stands
          in rather than leaving the viewer with nothing to look at. It is composed from the
          roster this browser already holds — its enabled half's own declared seats (ADR 0017
          S17-B) — so the fallback is the tree the layout door would have answered with, derived
          from the same manifests, rather than a second arrangement kept here beside a favourite
          pair of panel names.

          A composition that is not the ordinary one is SAID: a roster nothing seats composes an
          empty workspace, and a reader owed the reason gets the sentence instead of an empty
          pane and a guess.
        */
        console.error("evt=workspace_layout_fetch_failed", reason);
        const seeded = composeDefaultLayout(assemblyRef.current.roster);
        const notice = DEFAULT_LAYOUT_NOTICES[seeded.condition];
        if (notice !== null) notify(notice, { key: "layout-default" });
        layoutRef.current = seeded.layout;
        setLayout(seeded.layout);
      });
    return () => {
      cancelled = true;
    };
  }, [identity.token, notify]);

  const onRatios = useCallback(
    (splitId: string, ratios: readonly number[]): void => {
      const current = layoutRef.current;
      if (current === null) return;
      const next = withTileRatios(current, splitId, ratios);
      if (next === null) return;
      applyLayout(next, false);
    },
    [applyLayout],
  );

  const commitRatios = useCallback((): void => {
    const current = layoutRef.current;
    if (current !== null) commitLayout(current);
  }, [commitLayout]);

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

  /**
   * The sidebar's arrangement, read out of the same tree the dividers write to — so it
   * arrives with the layout, survives a reload, and follows the principal to another device
   * without a second store, a second fetch or a second door.
   *
   * This plumbing stays floor: it is the generic write door for ANY panel's declared inner
   * order (`panelSections`/`withPanelSections`, `@manifold/plugin`), tied to this file's own
   * `layoutRef`/`applyLayout` — not arrange-mode UI. `core.shell`'s sidebar panel is its one
   * caller today, reached through `WorkspaceShell` exactly as `sidebarOpen` is.
   */
  const sectionArrangement = panelSections(layout, SIDEBAR_PANEL);

  const commitSectionArrangement = useCallback(
    (arrangement: readonly SectionNode[]): void => {
      const current = layoutRef.current;
      if (current === null) return;
      const next = withPanelSections(current, SIDEBAR_PANEL, arrangement);
      // Null means the arrangement was not writable (no sidebar leaf in this tree, or one
      // naming a section twice, or nested past the bound). The layout the reader is looking
      // at is left alone.
      if (next === null) return;
      applyLayout(next, true);
    },
    [applyLayout],
  );

  /**
   * ARRANGE MODE, read off the vantage store the F8 binding writes — presence, not this
   * component's state (AXIOMS.md A2, AGENTS.md invariant 11). The only thing the frame still
   * does with it is blank its own tile content hosts (`.is-arranging`, `shell.css`) so
   * `core.arrange`'s overlay is the only thing left answering the pointer while armed; every
   * grip, every gesture and every commit that mode once ran HERE now lives in that plugin,
   * reached through the tile-geometry read surface registered below (issue #89).
   */
  const { arranging } = useVantage();

  /**
   * IS SOMETHING IN THE AIR? One boolean, on the frame, because two rules depend on it and
   * neither can be written any lower down:
   *
   *   ARRANGE MODE'S CONTENT SUPPRESSION LIFTS FOR A DRAG. Blanking the panes is how the
   *   overlay gets the pointer to itself while armed — but a palette drag is precisely the
   *   case where the content underneath MUST answer, because a composition takes new
   *   structure through its own door and a scoped panel takes it into its own rows. A
   *   `pointer-events: none` pane never sees a `dragover`, so without this the palette could
   *   only ever drop into the workspace's own tree.
   *
   *   A VACANT SUBTREE BECOMES TARGETABLE. A stack with nothing in it holds no room at rest
   *   (that is the point of it), which also makes it impossible to aim at — so it takes room
   *   again exactly while somebody is arranging or carrying, and gives it back after.
   *
   * Read off the DOM's own drag lifecycle rather than a store: an HTML5 drag is a browser
   * mode, `dragend` fires on the source however it finished, and there is no plane this
   * belongs on — it dies with the gesture and nobody else can act on it (invariant 13's
   * device-local clause is about persistence; this persists nowhere at all).
   */
  const [carrying, setCarrying] = useState(false);
  useEffect(() => {
    const begin = (event: DragEvent): void => {
      if (event.dataTransfer !== null && carriesItem(event.dataTransfer)) setCarrying(true);
    };
    const finish = (): void => setCarrying(false);
    /*
      `dragstart` on the BUBBLE phase, and that one word is load-bearing: every source in the
      application seals the mime inside a React `onDragStart`, which React dispatches at its
      root container — so a window CAPTURE listener runs strictly before `setData` and reads
      an empty `DataTransfer` every single time. Measured against a real Chromium drag, not
      reasoned: capture saw `types=[]` where the window's own bubble listener saw the mime.

      `dragend` and `drop` stay on CAPTURE. Neither reads a transfer, and both mean "it is
      over" whatever a handler downstream decides to do about it — a `stopPropagation` in a
      drop target must not be able to strand the mode with the workspace still unblanked.
    */
    window.addEventListener("dragstart", begin);
    window.addEventListener("dragend", finish, true);
    window.addEventListener("drop", finish, true);
    return () => {
      window.removeEventListener("dragstart", begin);
      window.removeEventListener("dragend", finish, true);
      window.removeEventListener("drop", finish, true);
    };
  }, []);

  /**
   * THE WORKSPACE TREE'S OWN DOM ROOT, and the read surface built over it — see
   * {@link TileGeometryHandle}. `getTreeElement` stays a live query rather than a cached
   * node for the reason the deleted gesture code always re-asked it: a committed move
   * replaces the boxes `TileTree` draws, and a stored element would go stale silently.
   */
  const workspaceRef = useRef<HTMLElement | null>(null);
  const registerTileGeometry = useTileGeometryRegistration();
  const getTreeElement = useCallback(
    (): HTMLElement | null =>
      workspaceRef.current?.querySelector<HTMLElement>(":scope > [data-tile-id]") ?? null,
    [],
  );
  /**
   * The write half of {@link TileGeometryHandle}: a stable wrapper over the floor's own
   * `applyLayout`, always committing (every plugin-driven change is a discrete gesture, never
   * a per-frame paint). Divider release, toolbar clicks and grip releases share the same
   * commit path, while divider frames stay local.
   */
  const applyLayoutFromHost = useCallback(
    (next: TileLayout): void => {
      applyLayout(next, true);
    },
    [applyLayout],
  );
  useEffect(() => {
    registerTileGeometry({ layout, getTreeElement, applyLayout: applyLayoutFromHost });
    return () => registerTileGeometry(null);
  }, [applyLayoutFromHost, getTreeElement, layout, registerTileGeometry]);

  const renderLeaf = useCallback(
    (node: Tile): ReactNode => {
      const ref = node.ref;
      if (ref === null || ref.kind !== "panel") {
        // `core.space.setLayout` refuses a non-panel, non-spacer leaf, so this is either an
        // empty pane, a spacer (its own inert render, never a placeholder) or a tree written
        // by a client that spoke a different vocabulary. Named, and removable.
        return ref?.kind === "spacer" ? (
          <div className="workspace-tile-spacer" aria-hidden="true" />
        ) : (
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
   * target, and the placement algebra is answered from the terminals listing. The Index
   * section reads the SAME three doors for itself — a plugin fetches its own data through
   * `host.client` and holds no wire to the shell's state — and because both name the resource
   * rather than open a timer, the two readers are one subscription and one request, not two.
   *
   * The topics come from `host` rather than from a literal here: a `manifold://plugin/<id>`
   * topic names a plugin, and the shell is floor (see `assembly.ts`, `FEED_TOPICS`).
   */
  const { value: treeItems, refresh: refreshTree } = usePolledResource<
    readonly IndexEntry[] | null
  >(fetchTree, INDEX_POLL_MS, {
    key: INDEX_RESOURCE,
    initial: null,
    topics: host.topics.index,
    events: host.client,
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

  const { value: presence } = usePolledResource(fetchPresence, INDEX_POLL_MS, {
    key: ATTENDANCE_RESOURCE,
    initial: NO_PRESENCE,
    topics: host.topics.attendance,
    events: host.client,
    restartKey: requestedContainerId,
  });

  const activeTerminalCount = workspace?.status === "open" ? workspace.terminalCount : null;
  const { value: terminals, refresh: refreshTerminals } = usePolledResource(
    fetchTerminals,
    INDEX_POLL_MS,
    {
      key: TERMINALS_RESOURCE,
      initial: NO_TERMINALS,
      topics: host.topics.terminals,
      events: host.client,
    },
  );
  /*
   * A terminal was born or died in the open container: ask now rather than wait out the
   * interval. This used to be a `restartKey`, which under a SHARED feed would have partitioned
   * the listing by a count — one cached answer per number of terminals, and no sharing with
   * the index section, which asks the same door with no count at all.
   */
  useEffect(() => {
    refreshTerminals();
  }, [activeTerminalCount, refreshTerminals]);

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
        .action(INDEX_CREATE_CONTAINER_ACTION, {
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
        const outcome = await host.client.action(INDEX_CREATE_FOLDER_ACTION, {
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
   *
   * MEMOIZED, load-bearing: the projection allocates, it sits in `route`'s dependency list, and
   * a renderer publishes back into this component — so an unmemoized call here rebuilt the
   * route on every render and every route-keyed effect below re-ran on every render.
   */
  const displayedPresence = useMemo(
    () => projectLocalPresence(presence, identity.principal, requestedContainerId),
    [presence, identity.principal, requestedContainerId],
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
      sidebarOpen,
      setSidebarOpen,
      workspace,
      creating,
      createContainer,
      createFolder,
      registerSidebarElement,
      sectionArrangement,
      commitSectionArrangement,
      // Module constants: the web build's own frozen identity, never state, never deps.
      webVersionLabel: WEB_VERSION_LABEL,
      webChangelog: WEB_CHANGELOG,
    }),
    [
      commitSectionArrangement,
      createContainer,
      createFolder,
      creating,
      registerSidebarElement,
      sectionArrangement,
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
    <main
      ref={workspaceRef}
      className={`workspace${sidebarOpen ? "" : " is-collapsed"}${arranging ? " is-arranging" : ""}${carrying ? " is-carrying" : ""}`}
    >
      <WorkspaceShellProvider value={shell}>
        <ContainerRouteProvider value={route}>
          {layout === null ? null : (
            <TileTree
              layout={layout}
              classes={WORKSPACE_TREE_CLASSES}
              // Always: this is the caller's OWN layout, so its seams are always live.
              interactive={true}
              onRatios={onRatios}
              onRatiosCommit={commitRatios}
              renderLeaf={renderLeaf}
            />
          )}
        </ContainerRouteProvider>
      </WorkspaceShellProvider>
    </main>
  );
}
