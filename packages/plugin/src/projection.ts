import {
  createContext,
  createElement,
  useContext,
  useCallback,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import type {
  MachineSummary,
  Container,
  ContainerDiscipline,
  Attendance,
  PlacementItem,
  Toolbar,
  LocationPath,
  ManifoldRef,
} from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";

import { ElementHostProvider } from "./element-host.ts";
import { MAX_LOCATION_PATH_LENGTH } from "@manifold/protocol";
import { publishLocation } from "./ui/vantage.ts";
import type { TitlebarDragProps } from "./ui/node-titlebar.tsx";
import type {
  ElementDocument,
  ElementProps,
  HostServices,
  SectionProps,
  SessionHandle,
  ViewportHandle,
} from "./host.ts";

/**
 * PROJECTION — how one renderer paints a node it does not own (A4: composition is projection,
 * never absorption).
 *
 * A container renderer is a mount site for other people's work, and so is the sidebar's own
 * stack. A tile leaf holds a terminal, a canvas, or a note; a canvas node holds a terminal or a
 * nested composition; a sidebar row holds whichever plugin declared it. Every one of those
 * occupants belongs to a different plugin, and no plugin may import another (REGISTRY.md
 * §Foundation), so the mount site cannot name the renderer it needs. It asks for a KIND and
 * the engine answers with whatever the composition registered for it.
 *
 * That is the same shape the element registry already had, generalized to the other four
 * things a mount site projects, and it is deliberately one mechanism rather than five channels:
 *
 *   terminals   the terminal viewer plus the machine-choice policy that decides where a new
 *               terminal is born (one facet, because the birth and the paint are one plugin's)
 *   containers        a container renderer, keyed by the container's DISCIPLINE (`canvas`, `composition`) —
 *               which is how a composition leaf embeds a canvas and a canvas node embeds a
 *               composition without either plugin knowing the other exists
 *   overlays    decoration painted OVER somebody else's ref, keyed by slot — over a mounted
 *               container (the presence island, the spotlight chip) or over the WHOLE
 *               workspace (the inspector, the arrange toolbar), which are the same kind with
 *               two hosts and therefore two slot vocabularies
 *   elements    a scene record's renderer, keyed by wire element type
 *   sections    a sidebar row's own body, keyed by the global section id its manifest declared
 *               — the one kind whose mount site is itself a plugin, since the shell's panel
 *               draws the stack and may not import a single row's owner
 *
 * The registry is built by the engine's browser half from the composition and republished on
 * every roster change, so a disabled plugin's occupant becomes the engine's named placeholder
 * (ADR 0013 §4) at every one of these mount sites at once — except overlays, which paint
 * NOTHING when absent, because an inert box floating over a canvas is worse than absence.
 *
 * Nothing here decides anything: it resolves names to components a plugin registered, and it
 * carries no domain knowledge beyond the five contribution kinds above.
 */

/** Why a projection is inert. Mirrored into `data-plugin-state` for gate assertions. */
export type ProjectionState = "disabled" | "unknown" | "unavailable";

export interface ProjectionPlaceholderProps {
  /** What to name: a plugin title when one is known, the raw contribution id otherwise. */
  readonly name: string;
  readonly state: ProjectionState;
  readonly onRemove?: (() => void) | undefined;
}

/** A registered component plus the roster facts a placeholder needs to name its absence. */
export interface RegisteredRenderer<P> {
  readonly plugin: string;
  /** The owning plugin's human title, for the placeholder. */
  readonly title: string;
  readonly enabled: boolean;
  /** Null when the plugin declared the contribution and registered no component. */
  readonly Component: ComponentType<P> | null;
}

/** Element renderers stay opaque: only a mount site may name a renderer's props. */
export interface RegisteredElement {
  readonly plugin: string;
  readonly title: string;
  readonly enabled: boolean;
  /** Per-discipline framing; an undeclared discipline defaults to titlebar at its mount site. */
  readonly presentation?: Readonly<Record<ContainerDiscipline, "body" | "titlebar">>;
  readonly Component: ComponentType<never> | null;
}

/**
 * A contributed toolbar mode. Modes carry no component — a tool is a NAME the ref that
 * owns the toolbar switches on — so the registry publishes the vocabulary and nothing else.
 * A disabled tool stays in the list, `enabled: false`, so the strip that draws it can leave
 * it out while the composition still explains why (ADR 0013 §4: chrome hides, data never).
 *
 * `toolbar` is which strip this tool belongs to (`Toolbar`, `@manifold/protocol`) — the
 * composed, defaulted form of the manifest row's optional field, so every reader filters on
 * one closed value instead of re-applying the "absent means canvas" rule itself.
 */
export interface RegisteredTool {
  readonly id: string;
  readonly plugin: string;
  readonly title: string;
  readonly toolbar: Toolbar;
  readonly enabled: boolean;
}

/**
 * The terminal viewer, as every mount site sees it. These members are the props
 * `packages/plugins/terminals` already published to its two floor callers before terminals
 * became a plugin; they are declared HERE because the declaration has to sit where both the
 * implementor and the mount sites can reach it, and none of them may import each other.
 */
export interface TerminalRendererProps {
  readonly client: SessionClient;
  readonly terminalId: string;
  /** Stable placement id: a canvas element id, or a tile id inside a composition. */
  readonly elementId: string;
  readonly active: boolean;
  readonly panelHighlighted: boolean;
  /** The terminal's machine as the wire publishes it; null before the first fetch resolves. */
  readonly machine: MachineSummary | null;
  /**
   * `preview` keeps the PTY body read-only; host-owned titlebar actions remain independent.
   * `full` is the default.
   */
  readonly chrome?: "full" | "preview";
  readonly onPark?: () => void;
  readonly onClose?: () => void;
  readonly onRestart?: () => Promise<void>;
  readonly onExpand?: () => void;
  readonly onRenameTitle?: (name: string) => void;
  /** The action `onRenameTitle` dispatches, marked onto the rename input as `data-action`. */
  readonly renameAction?: string;
  readonly onShrink?: () => void;
  readonly titlebarExtras?: ReactNode;
  readonly titlebarMiddle?: ReactNode;
  readonly titlebarDragProps?: TitlebarDragProps | undefined;
  readonly projectionScope?: ProjectionScope | null;
  /** `window` (default) owns an outer frame; `tile` meets adjacent leaves with square seams. */
  readonly frame?: "window" | "tile";
}

/**
 * Everything a ref needs from whichever plugin owns terminals: how to paint one, and
 * where a new one is born. The two travel together because they are one plugin's policy —
 * a view that may open a terminal must be able to ask which machine this device last used
 * for this container, and that memory is the terminal plugin's, not the renderer's.
 */
export interface TerminalFacet {
  readonly View: ComponentType<TerminalRendererProps>;
  /**
   * The machine a terminal opened in `containerId` should land on: this device's memory for
   * that container when it still exists in `machines`, else the composed default, else null
   * (which the server reads as "wherever you like"). `null` machines means "not fetched yet".
   */
  defaultMachine(
    containerId: string,
    machines: readonly MachineSummary[] | null,
  ): MachineSummary | null;
  /** Records where a terminal actually landed, so the next one in this container matches. */
  rememberMachine(containerId: string, machineId: string): void;
}

/**
 * A container renderer, mounted INSIDE another container OR as the routed ref itself.
 * Deliberately the neutral subset of what a routed renderer takes: a projection is a
 * reference plus a pipe, so the props carry the address and the index facts the placement
 * algebra needs locally, and nothing about the route. Everything route-shaped — the return
 * address, the index refresh, the create-terminal publication — a renderer reads from
 * {@link ContainerRoute} itself.
 *
 * `host` arrives as a PROP, exactly as it does for a panel or a section: a renderer dials
 * its own room pipe with the host's token (A4) and paints in the host's principal colour,
 * and every mount site must therefore hand its own host down rather than let a renderer
 * discover one.
 */
export interface ContainerRendererProps {
  readonly host: HostServices;
  readonly containerId: string;
  /** Every container the index knows, so an embedded renderer can answer the algebra locally. */
  readonly containers: readonly Container[];
  readonly presence: readonly Attendance[];
  /** The index's solo-composition fold; an embedded renderer cannot compute it. */
  readonly soloOccupants?: ReadonlyMap<string, PlacementItem>;
  readonly navigate: (path: string) => void;
  /** Container nesting depth: 1 when routed, 2 when embedded in another container. */
  readonly depth?: number;
  readonly projectionScope?: ProjectionScope | null;
  /** `window` (default) owns an outer frame; `tile` meets adjacent leaves with square seams. */
  readonly frame?: "window" | "tile";
  readonly titlebarDragProps?: TitlebarDragProps | undefined;
  readonly titlebarExtras?: ReactNode;
  readonly titlebarMiddle?: ReactNode;
}

/**
 * Decoration painted over a mounted container ref, by slot. `host` rides along for the same
 * reason a panel's does, and one overlay makes it load-bearing: the spotlight chip is the
 * RECEIVING half of `core.presence.focus`, and moving the camera means calling
 * `host.viewport.centerOn` — the seam the mounted renderer registered.
 */
export interface ContainerOverlayProps {
  readonly host: HostServices;
  readonly client: SessionClient;
  readonly containerId: string;
  /** Declared mounted ancestry for a titlebar; absent in legacy container overlays. */
  readonly locationPath?: LocationPath | null;
}

/**
 * The overlay slots a mounted renderer offers, including its optional titlebar contribution.
 *
 * This is a CLOSED vocabulary because the join is otherwise invisible: a plugin registers a
 * component under a slot name, a renderer mounts `ContainerOverlayOutlet slot="…"`, and the
 * two sides never import each other — so with a `string` key a typo on either side compiles
 * clean and paints nothing at all (overlays paint NOTHING when absent, by design, which is
 * exactly what makes the failure silent). Naming the slots turns the runtime join into a
 * compile error, which is why this needs no gate check of its own.
 *
 * Slots live here rather than beside either party for the reason every vocabulary in this
 * package does: the registrant is a plugin, the outlet is a renderer in another plugin, and
 * `@manifold/plugin` is the only thing both are allowed to import. Adding a slot is a one-line
 * append plus the outlet that mounts it.
 */
export const OVERLAY_SLOTS = ["container-spotlight", "titlebar"] as const;

/** One named overlay position on a mounted container ref. */
export type OverlaySlot = (typeof OVERLAY_SLOTS)[number];

/**
 * What a plugin's browser half puts in the overlay channel: the slots it fills, by name.
 * `Partial` because filling one slot is normal; contributions need not participate everywhere.
 */
export type OverlayRegistrations = Readonly<
  Partial<Record<OverlaySlot, ComponentType<ContainerOverlayProps>>>
>;

/**
 * The WORKSPACE's own overlay slots — the same kind as {@link OVERLAY_SLOTS}, hosted by the
 * application frame instead of by a container renderer, and closed for the identical reason.
 *
 * Three slots exist because three things genuinely have no container to hang on. An INSPECTOR
 * chip follows the pointer across the sidebar, the workspace frame and whatever is mounted
 * inside it, so a chip painted into a container's slot could never name the sidebar row it is
 * hovering. An arrange TOOLBAR is chrome about the arrangement of the workspace, which is not
 * a node in any container either. A COMMANDS surface is the same shape one step further out:
 * it is opened by a keystroke rather than by anything on screen, so it must be mounted
 * wherever the viewer is — including the workspace root, where no container is mounted at all
 * and a container slot therefore does not exist.
 *
 * Hosted ABOVE the route switch (`packages/web/src/app.tsx`), for the reason the notice layer
 * is: a workspace overlay must outlive the shell it decorates and must sit outside the
 * sidebar's collapse subtree, which is what used to hide sidebar chrome on the icon rail.
 */
export const WORKSPACE_OVERLAY_SLOTS = ["commands", "inspector", "toolbar"] as const;

/** One named overlay position over the workspace itself. */
export type WorkspaceOverlaySlot = (typeof WORKSPACE_OVERLAY_SLOTS)[number];

/**
 * What a workspace overlay is handed, and the whole of it: the one host ref. There is no
 * `containerId` and no room pipe — an overlay over the WORKSPACE has no container to be about,
 * and the routed one is already `host.containerId`.
 */
export interface WorkspaceOverlayProps {
  readonly host: HostServices;
}

/** What a plugin's browser half puts in the workspace overlay channel: the slots it fills. */
export type WorkspaceOverlayRegistrations = Readonly<
  Partial<Record<WorkspaceOverlaySlot, ComponentType<WorkspaceOverlayProps>>>
>;

/**
 * The resolved registry. Built by the engine's browser half from the composition; `revision`
 * moves with the roster, so a consumer that memoizes on the vocabulary has a cheap key.
 */
export interface ProjectionRegistry {
  readonly revision: number;
  /** The engine's own inert-contribution chrome, injected so this module paints no CSS of its own. */
  readonly Placeholder: ComponentType<ProjectionPlaceholderProps>;
  /**
   * The engine's own fault-containment chrome, injected for exactly the reason
   * {@link Placeholder} is: a projected occupant that throws must not take the application
   * with it, the screen that says so is full-bleed floor chrome, and this module paints no CSS.
   */
  readonly ErrorBoundary: ComponentType<{ readonly children: ReactNode }>;
  readonly terminals: {
    readonly plugin: string;
    readonly title: string;
    readonly enabled: boolean;
    readonly facet: TerminalFacet;
  } | null;
  /** Keyed by container discipline — `Container["discipline"]`. */
  renderer(layout: string): RegisteredRenderer<ContainerRendererProps> | null;
  overlay(slot: OverlaySlot): RegisteredRenderer<ContainerOverlayProps> | null;
  /** Keyed by workspace overlay slot; only declared slots can appear. */
  workspaceOverlay(slot: WorkspaceOverlaySlot): RegisteredRenderer<WorkspaceOverlayProps> | null;
  element(type: string): RegisteredElement | null;
  /** Keyed by the GLOBAL section id a manifest declared — one sidebar, one slot per name. */
  section(id: string): RegisteredRenderer<SectionProps> | null;
  /** The whole element vocabulary, for a paint boundary that needs a map (React Flow's). */
  readonly elements: ReadonlyMap<string, RegisteredElement>;
  /** The tool vocabulary in roster order, for whichever ref owns a toolbar. */
  readonly tools: readonly RegisteredTool[];
}

const ProjectionContext = createContext<ProjectionRegistry | null>(null);

export function ProjectionProvider({
  value,
  children,
}: {
  readonly value: ProjectionRegistry;
  readonly children: ReactNode;
}): ReactElement {
  return createElement(ProjectionContext.Provider, { value }, children);
}

/**
 * Throws rather than degrading: a renderer with no registry would silently paint empty
 * leaves, which is the one failure mode the named placeholder exists to prevent.
 */
export function useProjection(): ProjectionRegistry {
  const registry = useContext(ProjectionContext);
  if (registry === null) {
    throw new Error("useProjection requires a <ProjectionProvider> ancestor");
  }
  return registry;
}

/**
 * A mounted projection's neutral participation contract. All descendants share the root
 * attendance client, not the child room's principal aggregate. Hosts append actual mount refs.
 */
export interface ProjectionScope {
  readonly host: HostServices;
  readonly client: SessionClient;
  readonly locationPath: LocationPath | null;
}

const ProjectionScopeContext = createContext<ProjectionScope | null>(null);

export function ProjectionScopeProvider({
  value,
  children,
}: {
  readonly value: ProjectionScope | null;
  readonly children: ReactNode;
}): ReactElement {
  return createElement(ProjectionScopeContext.Provider, { value }, children);
}

/** Missing scope is legitimate for an unparticipating renderer or standalone preview. */
export function useProjectionScope(): ProjectionScope | null {
  return useContext(ProjectionScopeContext);
}

/** Extend only declared ancestry. Never truncate a deep path into a false ancestor match. */
export function extendProjectionScope(
  scope: ProjectionScope | null,
  ...refs: ManifoldRef[]
): ProjectionScope | null {
  if (scope === null) return null;
  if (scope.locationPath === null) return scope;
  return {
    ...scope,
    locationPath:
      scope.locationPath.length + refs.length > MAX_LOCATION_PATH_LENGTH
        ? null
        : [...scope.locationPath, ...refs],
  };
}

/** Call on engagement/focus, not render; publication works even with no painter installed. */
export function usePublishLocation(scope?: ProjectionScope | null): () => void {
  const inherited = useProjectionScope();
  const locationPath = (scope === undefined ? inherited : scope)?.locationPath ?? null;
  return useCallback(() => publishLocation(locationPath), [locationPath]);
}

/** The existing overlay composition policy, hosted in NodeTitleBar.middle without a ghost box. */
export function TitlebarOutlet({
  scope,
}: {
  readonly scope?: ProjectionScope | null;
}): ReactElement | null {
  const inherited = useProjectionScope();
  const resolved = scope === undefined ? inherited : scope;
  const registry = useProjection();
  const registered = registry.overlay("titlebar");
  if (
    resolved?.locationPath == null ||
    registered === null ||
    !registered.enabled ||
    registered.Component === null
  ) {
    return null;
  }
  const root = resolved.locationPath.find((ref) => ref.kind === "container");
  const containerId = resolved.host.containerId ?? root?.containerId;
  if (containerId === undefined) return null;
  return createElement(registered.Component, {
    host: resolved.host,
    client: resolved.client,
    containerId,
    locationPath: resolved.locationPath,
  });
}

/**
 * THE OTHER DIRECTION: what a mounted container renderer publishes back to the host.
 *
 * `HostServices.viewport` is how a plugin moves the view a spotlight names (ADR 0013; A2's
 * "drivable by other principals"), and only the renderer actually on screen can answer it —
 * so the renderer registers its handle on mount and clears it on unmount. The channel is a
 * context declared HERE because its two ends are a floor host and a plugin renderer, and the
 * renderer may not import the host.
 *
 * Registering null is the honest state, not a no-op: no container view mounted means no viewport,
 * and a spotlight arriving then must land nowhere rather than somewhere stale.
 */
const ViewportRegistrationContext = createContext<((handle: ViewportHandle | null) => void) | null>(
  null,
);

export function ViewportRegistrationProvider({
  value,
  children,
}: {
  readonly value: (handle: ViewportHandle | null) => void;
  readonly children: ReactNode;
}): ReactElement {
  return createElement(ViewportRegistrationContext.Provider, { value }, children);
}

/**
 * Never throws: a renderer mounted outside a host (a test, a preview) still renders, it
 * simply has nowhere to publish. Silence beats a crash for a channel whose whole payload is
 * an optional capability.
 */
export function useViewportRegistration(): (handle: ViewportHandle | null) => void {
  return useContext(ViewportRegistrationContext) ?? noViewportRegistration;
}

const noViewportRegistration = (_handle: ViewportHandle | null): void => undefined;

/**
 * What the host routes through a published room pipe, and nothing more: the room's terminal
 * table (which is how a terminal-keyed verb finds its home) and the five terminal mutations.
 * A renderer publishes its whole room client and the type keeps the host to this slice.
 */
export type RoomPipe = Pick<
  SessionHandle,
  | "terminals"
  | "openTerminal"
  | "sendTerminalInput"
  | "resizeTerminal"
  | "takeTerminal"
  | "killTerminal"
>;

/**
 * THE ROOM PIPE, published (issue #196). A container renderer dials its own occupant pipe
 * (A4), and that pipe is the only channel in the tab on which a terminal in its room may be
 * born, typed into, resized or taken — the host's own handle only WATCHES the routed room. So
 * the renderer registers the pipe under its container id on mount and releases it on unmount,
 * and the host routes the terminal mutations a panel calls on `host.client` through it.
 *
 * The same shape as the viewport channel above, for the same reason: the publisher is a
 * plugin renderer and the consumer is the floor host, and the renderer may not import the
 * host. Keyed by container rather than a single slot because an embedded renderer is an
 * occupant of ITS room, and a terminal-keyed verb rides its home room's pipe.
 */
export type RoomPipeRegistration = (containerId: string, pipe: RoomPipe) => () => void;

const RoomPipeRegistrationContext = createContext<RoomPipeRegistration | null>(null);

export function RoomPipeRegistrationProvider({
  value,
  children,
}: {
  readonly value: RoomPipeRegistration;
  readonly children: ReactNode;
}): ReactElement {
  return createElement(RoomPipeRegistrationContext.Provider, { value }, children);
}

/**
 * Never throws, like the viewport's: a renderer mounted outside a host still renders, it
 * simply publishes to nobody, and the release it is handed back does nothing.
 */
export function useRoomPipeRegistration(): RoomPipeRegistration {
  return useContext(RoomPipeRegistrationContext) ?? noRoomPipeRegistration;
}

/** One stable identity, so a hostless renderer's registering effect never re-runs. */
const noRoomPipeRegistration: RoomPipeRegistration = () => () => undefined;

/**
 * The terminal facet, or null when no plugin owns terminals right now (unregistered, or its
 * owner is disabled). Null is a real answer: a ref that cannot paint a terminal also
 * must not offer to open one.
 */
export function useTerminalFacet(): TerminalFacet | null {
  const registry = useProjection();
  const terminals = registry.terminals;
  return terminals === null || !terminals.enabled ? null : terminals.facet;
}

/** One projected terminal. Every miss is the engine's named placeholder, never a blank box. */
export function TerminalRenderer(props: TerminalRendererProps): ReactElement {
  const registry = useProjection();
  const terminals = registry.terminals;
  const Placeholder = registry.Placeholder;
  if (terminals === null) return createElement(Placeholder, { name: "terminal", state: "unknown" });
  if (!terminals.enabled) {
    return createElement(Placeholder, { name: terminals.title, state: "disabled" });
  }
  return createElement(terminals.facet.View, props);
}

export interface ContainerRendererOutletProps extends ContainerRendererProps {
  /** The container's discipline, which decides whose renderer paints it. */
  readonly layout: string;
}

/**
 * One projected container. A composition leaf holding a canvas and a canvas node holding a
 * composition are the same call with a different `layout` — which is why compositions and
 * canvases can nest arbitrarily without either plugin importing the other.
 */
export function ContainerRenderer({ layout, ...ref }: ContainerRendererOutletProps): ReactElement {
  const registry = useProjection();
  const Placeholder = registry.Placeholder;
  const registered = registry.renderer(layout);
  if (registered === null) return createElement(Placeholder, { name: layout, state: "unknown" });
  if (!registered.enabled) {
    return createElement(Placeholder, { name: registered.title, state: "disabled" });
  }
  if (registered.Component === null) {
    return createElement(Placeholder, { name: registered.title, state: "unavailable" });
  }
  return createElement(registered.Component, ref);
}

export interface SectionOutletProps {
  /** The GLOBAL section id, exactly as the owning manifest declared it. */
  readonly id: string;
  readonly host: HostServices;
}

/**
 * One sidebar row's body. The mount site here is itself a PLUGIN — the shell's sidebar panel
 * draws the stack, reads the rows off `host.assembly.sections`, and may not import the owner of
 * a single one of them — so the stack asks for an id and the engine answers with whatever the
 * composition registered, on the identical placeholder policy as {@link ElementOutlet}.
 *
 * Which CHROME wraps this body — a disclosure with a header, or a plain row that draws itself
 * end to end — the stack decides from the row's `presentation`. This resolves the occupant and
 * nothing else.
 */
export function SectionOutlet({ id, host }: SectionOutletProps): ReactElement {
  const registry = useProjection();
  const Placeholder = registry.Placeholder;
  const registered = registry.section(id);
  if (registered === null) return createElement(Placeholder, { name: id, state: "unknown" });
  if (!registered.enabled) {
    return createElement(Placeholder, { name: registered.title, state: "disabled" });
  }
  if (registered.Component === null) {
    return createElement(Placeholder, { name: registered.title, state: "unavailable" });
  }
  return createElement(registered.Component, { host });
}

export interface ContainerOverlayOutletProps extends ContainerOverlayProps {
  readonly slot: OverlaySlot;
}

/**
 * A slot of decoration over the mounted ref. Absence paints NOTHING — no placeholder —
 * because an overlay is somebody else's chrome floating on this ref, and an inert box
 * over a live canvas would be worse than the missing decoration. The wrapper still carries
 * `data-overlay-slot`, so a gate can assert that the slot exists and is empty.
 */
export function ContainerOverlayOutlet({
  slot,
  ...overlay
}: ContainerOverlayOutletProps): ReactElement {
  const registry = useProjection();
  const registered = registry.overlay(slot);
  const painted =
    registered === null || !registered.enabled || registered.Component === null
      ? null
      : createElement(registered.Component, overlay);
  return createElement(
    "div",
    { className: "container-overlay-slot", "data-overlay-slot": slot },
    painted,
  );
}

export interface WorkspaceOverlayOutletProps extends WorkspaceOverlayProps {
  readonly slot: WorkspaceOverlaySlot;
}

/**
 * A slot of decoration over the WORKSPACE, on exactly the policy
 * {@link ContainerOverlayOutlet} follows: absence paints NOTHING — no placeholder — because an
 * inert box floating over somebody's workspace is worse than the missing decoration, and the
 * wrapper still carries `data-workspace-overlay-slot` so a gate can assert the slot exists and
 * is empty.
 *
 * A disabled plugin's overlay disappears with everything else it contributes, which is what
 * makes "turning core.debug off removes the inspector chrome entirely" a property of the
 * registry rather than a promise the plugin has to keep.
 */
export function WorkspaceOverlayOutlet({
  slot,
  ...overlay
}: WorkspaceOverlayOutletProps): ReactElement {
  const registry = useProjection();
  const registered = registry.workspaceOverlay(slot);
  const painted =
    registered === null || !registered.enabled || registered.Component === null
      ? null
      : createElement(registered.Component, overlay);
  return createElement(
    "div",
    { className: "workspace-overlay-slot", "data-workspace-overlay-slot": slot },
    painted,
  );
}

export interface ElementOutletProps {
  /** The WIRE element type, exactly as the scene document stores it (`text`). */
  readonly type: string;
  readonly elementId: string;
  /** The element's record, as this ref projected it; `{}` while the record is in flight. */
  readonly data: Readonly<Record<string, unknown>>;
  readonly doc: ElementDocument;
  /** This ref's editing focus — one occupant of it is in its editor at a time. */
  readonly editingElementId: string | null;
  readonly onBeginEditing: (elementId: string) => void;
  readonly onEndEditing: (elementId: string) => void;
  /** True where an emptied element is litter (a canvas), false where it IS a leaf's occupant. */
  readonly removeWhenEmpty: boolean;
}

/**
 * A contributed element painted OUTSIDE React Flow — a note occupying a tile leaf, today's
 * one case. The canvas reaches the same registry through its own paint boundary, because
 * React Flow demands a `nodeTypes` map keyed by wire type; a composition simply renders.
 * Two mount disciplines, one registry, one placeholder policy.
 */
export function ElementOutlet({
  type,
  elementId,
  data,
  doc,
  editingElementId,
  onBeginEditing,
  onEndEditing,
  removeWhenEmpty,
}: ElementOutletProps): ReactElement {
  const registry = useProjection();
  const Placeholder = registry.Placeholder;
  const element = registry.element(type);
  if (element === null) return createElement(Placeholder, { name: type, state: "unknown" });
  if (!element.enabled)
    return createElement(Placeholder, { name: element.title, state: "disabled" });
  if (element.Component === null) {
    return createElement(Placeholder, { name: element.title, state: "unavailable" });
  }
  /*
    The cast at this boundary, and the reason registered element components are opaque: a
    renderer's props are the ELEMENT contract (`ElementProps`), and only a mount site may name
    them. The canvas's paint boundary performs the same cast into React Flow's node props.
   */
  const Element = element.Component as unknown as ComponentType<ElementProps>;
  return createElement(ElementHostProvider, {
    value: {
      doc,
      editingElementId,
      beginEditing: onBeginEditing,
      endEditing: onEndEditing,
      removeWhenEmpty,
    },
    children: createElement(Element, { id: elementId, data }),
  });
}
