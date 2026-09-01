import "./shell.css";
import {
  panelSections,
  sameIndexEntries,
  withPanelSections,
  workspaceLayout,
} from "@manifold/plugin";
import {
  ContainerRouteProvider,
  WorkspaceShellProvider,
  areaUnits,
  projectLocalPresence,
  resolveTileAim,
  tileProspect,
  usePolledResource,
  ATTENDANCE_RESOURCE,
  INDEX_RESOURCE,
  TERMINALS_RESOURCE,
  type AreaFractions,
  type ContainerRoute,
  type TileAim,
  type UnitRect,
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
  TerminalSummary,
  TileEdge,
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
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { WORKSPACE_PANELS } from "./assembly.ts";
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
} from "./plugin-host.tsx";
import {
  movedPanelLayout,
  nudgedPanelLayout,
  panelArrangeMessage,
  panelsCanMove,
  type PanelArrangeOutcome,
} from "./workspace-arrange.ts";
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

/** One committed layout write per gesture, not per frame (D6). */
const LAYOUT_COMMIT_MS = 300;

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

/**
 * ── THE PANEL LEG OF ARRANGE MODE ────────────────────────────────────────────────────
 *
 * F8 arms the whole workspace, and BOTH its legs now land: sections rearrange inside the
 * sidebar, and panels rearrange inside the workspace tree. The panel leg's grab surface
 * belongs HERE, at the outlet that seats a panel, rather than inside any panel's own
 * component — a panel is a plugin's renderer and knows nothing about the tree it is a leaf
 * of, so the affordance for moving one is the floor's the way the seam already is.
 *
 * There is no new grammar. The pointer resolves through `resolveTileAim` — the same leaf
 * zones, seam bands and border ring every composition's own drag aims with — the preview is
 * `tileProspect` over the same kernel, and the release commits through
 * `core.space.setLayout`, the one layout door. What arriving here needed was not plumbing
 * but the realisation that this surface needs no CARRY: see {@link WorkspaceHost}'s commit
 * point for why a per-principal tree has nothing to stream.
 */

/** Which sibling an arrow key reaches for; the tile vocabulary's own edges, not a new one. */
const ARROW_EDGES: Readonly<Record<string, Exclude<TileEdge, "center">>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "top",
  ArrowDown: "bottom",
};

/** One panel in hand: the leaf it is leaving, and the pointer that is holding it. */
interface PanelGrab {
  readonly tileId: string;
  readonly panelId: string;
  readonly pointerId: number;
}

function initialSidebarOpen(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_MIRROR_KEY) !== "true";
  } catch {
    return true;
  }
}

interface PanelGripProps {
  readonly tileId: string;
  readonly panelId: string;
  /** What the panel calls itself, so the control names the thing it moves. */
  readonly title: string;
  /** This is the panel in hand right now. */
  readonly grabbed: boolean;
  readonly onGrab: (grab: PanelGrab, event: ReactPointerEvent<HTMLElement>) => void;
  readonly onNudge: (
    tileId: string,
    panelId: string,
    direction: Exclude<TileEdge, "center">,
  ) => void;
}

/**
 * THE GRAB SURFACE for one panel, covering the whole pane — the same shape the section leg
 * uses, for the same two reasons: it says the PANEL is the thing in hand, and it keeps the
 * pointer off everything underneath, which in a pane is somebody else's renderer.
 *
 * A real button, unlike the section's grip, because a pane has no header button above it for
 * arrow keys to bubble out of: this control is the panel leg's tab stop AND its keyboard
 * route. `data-action` names the door a release opens, so the DOM says which authority this
 * affordance reaches for (AGENTS.md invariant 12).
 */
function PanelGrip({
  tileId,
  panelId,
  title,
  grabbed,
  onGrab,
  onNudge,
}: PanelGripProps): ReactElement {
  return (
    <button
      type="button"
      className={`workspace-panel-grip${grabbed ? " is-grabbed" : ""}`}
      data-action="core.space.setLayout"
      data-panel-id={panelId}
      aria-label={`Move the ${title} panel`}
      onPointerDown={(event) => {
        onGrab({ tileId, panelId, pointerId: event.pointerId }, event);
      }}
      onKeyDown={(event) => {
        const direction = ARROW_EDGES[event.key];
        if (direction === undefined) return;
        event.preventDefault();
        onNudge(tileId, panelId, direction);
      }}
    >
      <span className="workspace-panel-grip-label">{title}</span>
    </button>
  );
}

interface PanelArrangeLayerProps {
  readonly layout: TileLayout;
  readonly grab: PanelGrab;
  /** The tree's own area box, resolved per frame: the tree is drawn by `TileTree`, not here. */
  readonly area: () => HTMLElement | null;
  /** The release, with whatever the last frame aimed at — null means "nowhere". */
  readonly onRelease: (aim: TileAim | null) => void;
}

/** One frame of the gesture: what it aims at, and the measurement that resolved it. */
interface PanelArrangeFrame {
  readonly aim: TileAim;
  readonly units: AreaFractions;
}

/**
 * THE LIVE DESTINATION, and the only thing in this file that runs per pointer frame.
 *
 * It is its own component for the reason the composition's preview overlay is: a per-frame
 * `setState` on the shell would re-render every pane's renderer sixty times a second, and
 * one of those panes holds terminals. Here the shell re-renders exactly twice per gesture —
 * once when a panel is grabbed, once when it is let go — and this layer owns the frames.
 *
 * It listens on the WINDOW rather than on the grip: the grip has pointer capture, so every
 * frame is retargeted to it and bubbles here regardless of what the pointer is over, which
 * is what lets an aim resolve over a pane whose content is inert.
 */
function PanelArrangeLayer({ layout, grab, area, onRelease }: PanelArrangeLayerProps): ReactNode {
  const [frame, setFrame] = useState<PanelArrangeFrame | null>(null);
  /** The aim the release will commit, readable without a render (the divider drag's rule). */
  const aimRef = useRef<TileAim | null>(null);

  useEffect(() => {
    const track = (event: PointerEvent): void => {
      if (event.pointerId !== grab.pointerId) return;
      const element = area();
      const units = element === null ? null : areaUnits(element, WORKSPACE_TREE_CLASSES.dividerPx);
      if (units === null) return;
      const next = resolveTileAim(
        layout,
        {
          x: (event.clientX - units.rect.left) / units.rect.width,
          y: (event.clientY - units.rect.top) / units.rect.height,
        },
        // The panel in hand always holds a seat to trade: it is a leaf of THIS tree.
        { carriedTileId: grab.tileId, holdsTileSeat: true },
        units.dividers,
        units.ring,
        // The zone already held, so a pointer near a boundary does not flutter (hysteresis).
        aimRef.current,
      );
      const held = aimRef.current;
      aimRef.current = next;
      if (next === null) {
        if (held !== null) setFrame(null);
        return;
      }
      // A pointer sliding inside one zone repaints nothing: same aim, same preview.
      if (
        held !== null &&
        held.tileId === next.tileId &&
        held.edge === next.edge &&
        held.action === next.action &&
        (held.between === true) === (next.between === true)
      ) {
        return;
      }
      setFrame({ aim: next, units });
    };
    const release = (event: PointerEvent): void => {
      if (event.pointerId !== grab.pointerId) return;
      onRelease(aimRef.current);
    };
    const abandon = (event: PointerEvent): void => {
      if (event.pointerId !== grab.pointerId) return;
      onRelease(null);
    };
    window.addEventListener("pointermove", track);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", abandon);
    return () => {
      window.removeEventListener("pointermove", track);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", abandon);
    };
  }, [area, grab, layout, onRelease]);

  const prospect =
    frame === null ? null : tileProspect(layout, frame.aim, grab.tileId, frame.units.dividers);
  if (frame === null || prospect === null) return null;

  /*
    Unit space out, client px in — and painted `fixed`, so the slot needs no containing block
    and cannot be clipped by the pane it overlaps. The tree's own area is what the fractions
    are fractions OF, which is why the rect comes from the frame that resolved them.
  */
  const paint = (unit: UnitRect): CSSProperties => ({
    left: frame.units.rect.left + unit.x * frame.units.rect.width,
    top: frame.units.rect.top + unit.y * frame.units.rect.height,
    width: unit.width * frame.units.rect.width,
    height: unit.height * frame.units.rect.height,
  });
  const trade = frame.aim.action === "swap";
  return (
    <>
      <div
        className={`workspace-arrange-slot${trade ? " is-swap" : ""}`}
        style={paint(prospect.slot)}
        aria-hidden="true"
      />
      {prospect.partner === null ? null : (
        // The seat the panel came from: a trade is two rects, because two panels move.
        <div
          className="workspace-arrange-slot is-swap"
          style={paint(prospect.partner)}
          aria-hidden="true"
        />
      )}
    </>
  );
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
        /*
          A workspace with no readable tree is a workspace with no shell, so the engine's
          default arrangement stands in rather than leaving the viewer with nothing to look at.
          The ARRANGEMENT is the floor's; the two panel NAMES come from `assembly.ts`, the one
          file here allowed to know which plugin draws a workspace (REGISTRY.md §Foundation).
        */
        console.error("evt=workspace_layout_fetch_failed", reason);
        const fallback = workspaceLayout(WORKSPACE_PANELS);
        layoutRef.current = fallback;
        setLayout(fallback);
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

  // ------------------------------------------------------------- arrange mode

  /**
   * ARRANGE MODE, read off the vantage store the F8 binding writes.
   *
   * The flag is not this component's state, and that is the whole design: it is PRESENCE
   * (`vantage.arranging`), so the binding row in `core.shell` flips it, this shell renders it,
   * the sidebar panel renders it, and every collaborator sees it — one value, no owner
   * (AXIOMS.md A2, AGENTS.md invariant 11). A `useState` here would have been a mode only
   * this browser tab could know about, which is the exact capability the vantage store exists
   * to abolish.
   */
  const { arranging } = useVantage();

  /**
   * Escape leaves. Bound here rather than in the binding table because Escape is not a
   * declared binding — it is the universal "never mind" every mode owes its user, and a table
   * row would claim the key for the workspace against every dialog and menu that needs it.
   * Armed only while the mode is, so nothing listens for a key it cannot act on.
   */
  useEffect(() => {
    if (!arranging) return;
    const leaveArranging = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setVantage({ arranging: false });
    };
    window.addEventListener("keydown", leaveArranging);
    return () => window.removeEventListener("keydown", leaveArranging);
  }, [arranging]);

  /**
   * THE PANEL IN HAND, and the tree area the gesture aims inside.
   *
   * A ref beside the state, for the reason every gesture in this codebase keeps one: the
   * state is what paints, the ref is what the next pointer frame reads before React has
   * re-rendered. The AREA is resolved lazily rather than held: the tree's boxes are
   * `TileTree`'s to draw and a committed move replaces them, so the only honest way to ask
   * where the area is, is to ask the DOM when a frame needs it.
   */
  const [panelGrab, setPanelGrab] = useState<PanelGrab | null>(null);
  const panelGrabRef = useRef<PanelGrab | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const holdPanel = useCallback((next: PanelGrab | null): void => {
    panelGrabRef.current = next;
    setPanelGrab(next);
  }, []);
  const treeArea = useCallback(
    (): HTMLElement | null =>
      workspaceRef.current?.querySelector<HTMLElement>(":scope > [data-tile-id]") ?? null,
    [],
  );

  /*
    Leaving the mode mid-grab drops what was in hand — the section leg's semantics exactly:
    the RELEASE is the commit, so a gesture the mode outlived commits nothing. The state
    resets during render (React's derived-state guidance; an effect would paint one stale
    frame first) and the ref resets in an effect, because the ref is what event handlers read.
  */
  if (!arranging && panelGrab !== null) {
    setPanelGrab(null);
  }
  useEffect(() => {
    if (!arranging) panelGrabRef.current = null;
  }, [arranging]);

  /**
   * THE COMMIT POINT of a panel arrange gesture — and the place invariant 11 reads
   * differently, so it says why out loud.
   *
   * Everywhere else a live drag is producer-agnostic pipeline: the local pointer normalises
   * into the WIRE form (`CarryAim`) and is consumed as if received, so a collaborator sees
   * the drag the dragger sees. There is no such form to normalise into here, and that is not
   * an omission — a workspace tree is PER-PRINCIPAL chrome. Nobody else renders this tree,
   * so there is no second viewer for a frame to reach and no arbitration to perform: this
   * pointer is the only producer this surface can ever have. What IS shared is published
   * already — the MODE is presence (`vantage.arranging`, which is how a collaborator knows
   * why your panes stopped answering), and the OUTCOME is the layout write below. So the
   * commit is the one observable truth about a panel move, which is exactly why it is one
   * action at the release and never a frame per pointer move (the plane rule's commit point,
   * invariant 13).
   */
  const landPanel = useCallback(
    (outcome: PanelArrangeOutcome): void => {
      if (!outcome.ok) {
        // A refusal is a named rule with a sentence, never a silent no-op: the reader who
        // pressed the key is owed the reason the tree would not take it.
        notify(panelArrangeMessage(outcome.rule), { key: "panel-arrange" });
        return;
      }
      applyLayout(outcome.layout, true);
    },
    [applyLayout, notify],
  );

  const grabPanel = useCallback(
    (grab: PanelGrab, event: ReactPointerEvent<HTMLElement>): void => {
      // Swallowed: the grip covers somebody else's renderer, which must not see the press.
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      holdPanel(grab);
    },
    [holdPanel],
  );

  const releasePanel = useCallback(
    (aim: TileAim | null): void => {
      const held = panelGrabRef.current;
      holdPanel(null);
      const current = layoutRef.current;
      // Nothing was armed under the pointer, so nothing was promised and nothing is said.
      if (held === null || current === null || aim === null) return;
      landPanel(movedPanelLayout(current, held.tileId, aim));
    },
    [holdPanel, landPanel],
  );

  const nudgePanel = useCallback(
    (tileId: string, panelId: string, direction: Exclude<TileEdge, "center">): void => {
      const current = layoutRef.current;
      if (current === null) return;
      landPanel(nudgedPanelLayout(current, tileId, direction));
      /*
        A committed move re-seats every pane's content host with `appendChild`, and moving a
        focused element that way blurs it — so without this the SECOND arrow key would have
        nothing focused to act on. The grip is re-found by the panel it moves rather than held
        in a ref, because the panel's leaf (and therefore its grip's seat) is what just moved.
      */
      window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(`.workspace-panel-grip[data-panel-id="${panelId}"]`)
          ?.focus();
      });
    },
    [landPanel],
  );

  /**
   * The sidebar's arrangement, read out of the same tree the dividers write to — so it
   * arrives with the layout, survives a reload, and follows the principal to another device
   * without a second store, a second fetch or a second door.
   */
  const sectionOrder = panelSections(layout, WORKSPACE_PANELS.sidebar);

  const commitSectionOrder = useCallback(
    (order: readonly string[]): void => {
      const current = layoutRef.current;
      if (current === null) return;
      const next = withPanelSections(current, WORKSPACE_PANELS.sidebar, order);
      // Null means the arrangement was not writable (no sidebar leaf in this tree, or an
      // order naming a section twice). The layout the reader is looking at is left alone.
      if (next === null) return;
      applyLayout(next, true);
    },
    [applyLayout],
  );

  /**
   * WHETHER A PANEL IS GRABBABLE AT ALL: the mode is armed, and this tree holds a second
   * panel for one to move against. A workspace showing one panel offers no grip rather than
   * a grip that refuses — the same honesty the collapsed rail practises with its one section.
   */
  const panelsGrabbable = arranging && panelsCanMove(layout);

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
      /*
        The grip is a SIBLING of the panel inside the leaf's content host, never a wrapper
        around it: a box between the host and the panel would change the flex layout every
        renderer already lays itself out in, and the grip takes itself out of flow instead.
      */
      return (
        <>
          {panelsGrabbable ? (
            <PanelGrip
              tileId={node.id}
              panelId={ref.panelId}
              title={assembly.panels.get(ref.panelId)?.title ?? ref.panelId}
              grabbed={panelGrab?.tileId === node.id}
              onGrab={grabPanel}
              onNudge={nudgePanel}
            />
          ) : null}
          <PanelOutlet panelId={ref.panelId} onRemove={() => pruneLeaf(node.id)} />
        </>
      );
    },
    [assembly, grabPanel, nudgePanel, panelGrab, panelsGrabbable, pruneLeaf],
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
      sectionOrder,
      commitSectionOrder,
      // Module constants: the web build's own frozen identity, never state, never deps.
      webVersionLabel: WEB_VERSION_LABEL,
      webChangelog: WEB_CHANGELOG,
    }),
    [
      commitSectionOrder,
      createContainer,
      createFolder,
      creating,
      registerSidebarElement,
      sectionOrder,
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
      className={`workspace${sidebarOpen ? "" : " is-collapsed"}${arranging ? " is-arranging" : ""}`}
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
              renderLeaf={renderLeaf}
            />
          )}
          {/*
            THE MODE, said out loud. A workspace whose terminals have stopped answering the
            mouse owes the reader the reason and the way out, and now the same sentence for
            both legs: sections reorder inside the sidebar, panels move inside the tree, and
            either one is one gesture or one arrow key.
          */}
          {arranging ? (
            <div className="workspace-arrange-bar" role="status">
              <strong className="workspace-arrange-title">Arrange mode</strong>
              <span className="workspace-arrange-hint">
                Drag a panel or a sidebar section by its grip, or nudge it with the arrow keys. Esc
                or F8 to finish.
              </span>
            </div>
          ) : null}
          {/*
            The live destination, mounted only while a panel is in hand — so the per-frame
            component does not exist at all in a workspace nobody is arranging.
          */}
          {panelGrab === null || layout === null ? null : (
            <PanelArrangeLayer
              layout={layout}
              grab={panelGrab}
              area={treeArea}
              onRelease={releasePanel}
            />
          )}
        </ContainerRouteProvider>
      </WorkspaceShellProvider>
    </main>
  );
}
