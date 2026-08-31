import {
  createContext,
  createElement,
  useContext,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import type { MachineSummary, Container, Attendance, PlacementItem } from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";

import { ElementHostProvider } from "./element-host.ts";
import type { ElementDocument, ElementProps, HostServices, ViewportHandle } from "./host.ts";

/**
 * PROJECTION — how one renderer paints a node it does not own (A4: composition is projection,
 * never absorption).
 *
 * A container renderer is a mount site for other people's work. A tile leaf holds a terminal,
 * a canvas, or a note; a canvas node holds a terminal or a nested composition. Every one of
 * those occupants belongs to a different plugin, and no plugin may import another (REGISTRY.md
 * §Foundation), so the mount site cannot name the renderer it needs. It asks for a KIND and
 * the engine answers with whatever the composition registered for it.
 *
 * That is the same shape the element registry already had, generalized to the other three
 * things a ref projects, and it is deliberately one mechanism rather than four channels:
 *
 *   terminals   the terminal viewer plus the machine-choice policy that decides where a new
 *               terminal is born (one facet, because the birth and the paint are one plugin's)
 *   containers        a container renderer, keyed by the container's DISCIPLINE (`canvas`, `composition`) —
 *               which is how a composition leaf embeds a canvas and a canvas node embeds a
 *               composition without either plugin knowing the other exists
 *   overlays    decoration painted OVER somebody else's ref, keyed by slot (the presence
 *               island, the spotlight chip)
 *   elements    a scene record's renderer, keyed by wire element type
 *
 * The registry is built by the engine's browser half from the composition and republished on
 * every roster change, so a disabled plugin's occupant becomes the engine's named placeholder
 * (ADR 0013 §4) at every one of these mount sites at once — except overlays, which paint
 * NOTHING when absent, because an inert box floating over a canvas is worse than absence.
 *
 * Nothing here decides anything: it resolves names to components a plugin registered, and it
 * carries no domain knowledge beyond the four contribution kinds above.
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
  readonly Component: ComponentType<never> | null;
}

/**
 * A contributed toolbar mode. Modes carry no component — a tool is a NAME the ref that
 * owns the toolbar switches on — so the registry publishes the vocabulary and nothing else.
 * A disabled tool stays in the list, `enabled: false`, so the strip that draws it can leave
 * it out while the composition still explains why (ADR 0013 §4: chrome hides, data never).
 */
export interface RegisteredTool {
  readonly id: string;
  readonly plugin: string;
  readonly title: string;
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
  /** `preview` is the read-only chrome a WATCHED portal paints; `full` is the default. */
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
}

/**
 * The overlay slots a container renderer offers, and the whole of them.
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
export const OVERLAY_SLOTS = ["container-roster", "container-spotlight"] as const;

/** One named overlay position on a mounted container ref. */
export type OverlaySlot = (typeof OVERLAY_SLOTS)[number];

/**
 * What a plugin's browser half puts in the overlay channel: the slots it fills, by name.
 * `Partial` because filling one slot is normal — `core.presence` happens to fill both.
 */
export type OverlayRegistrations = Readonly<
  Partial<Record<OverlaySlot, ComponentType<ContainerOverlayProps>>>
>;

/**
 * The resolved registry. Built by the engine's browser half from the composition; `revision`
 * moves with the roster, so a consumer that memoizes on the vocabulary has a cheap key.
 */
export interface ProjectionRegistry {
  readonly revision: number;
  /** The engine's own inert-contribution chrome, injected so this module paints no CSS of its own. */
  readonly Placeholder: ComponentType<ProjectionPlaceholderProps>;
  readonly terminals: {
    readonly plugin: string;
    readonly title: string;
    readonly enabled: boolean;
    readonly facet: TerminalFacet;
  } | null;
  /** Keyed by container discipline — `Container["discipline"]`. */
  renderer(layout: string): RegisteredRenderer<ContainerRendererProps> | null;
  overlay(slot: OverlaySlot): RegisteredRenderer<ContainerOverlayProps> | null;
  element(type: string): RegisteredElement | null;
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
