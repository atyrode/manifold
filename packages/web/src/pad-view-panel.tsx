import type { PanelProps } from "@manifold/plugin";
import type {
  MachineSummary,
  Pad,
  PadPresence,
  PlacementItem,
} from "@manifold/protocol";
import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import type { StoredIdentity } from "./api.ts";
import { PadErrorBoundary } from "./error-boundary.tsx";
import { FlowPadView } from "./flow-pad-view.tsx";
import { TiledPadView } from "./tiled-pad-view.tsx";
import type { WorkspaceSidebarState } from "./top-right.tsx";

/**
 * The `core.shell.pad-view` panel — FLOOR, tagged `"until": "core.canvas"` /
 * `"until": "core.compositions"` in AXIOMS.md §Foundation.
 *
 * The routed renderer switch moved here VERBATIM from the shell. That is the whole of this
 * file's ambition: the workspace is now a tile tree of panels, so the thing that used to be
 * "the area beside the sidebar" has to be a panel like any other. What it renders — the
 * canvas, the tiled route, their internals — is still engine code, and stays so until
 * `core.canvas` and `core.compositions` decompose it. The registry's `"until"` tag is what
 * keeps that debt visible instead of quietly permanent.
 *
 * A panel is reached through `PanelOutlet`, which knows nothing about pads, so the route
 * cannot arrive as props: it arrives as context the shell publishes above the tree. That is
 * not a shortcut around the plugin boundary — this file IS the shell's other half — and it
 * is exactly the seam `core.canvas` will cut when the renderer becomes a plugin and the
 * route becomes an addressed reference instead of a prop bundle.
 */
export interface PadRoute {
  readonly identity: StoredIdentity;
  readonly requestedPadId: string | null;
  /** The routed container's record, from the index, a direct fetch, or this tab's memory. */
  readonly activePad: Pad | null;
  /** Every indexed container; null while the first index response is in flight. */
  readonly pads: readonly Pad[] | null;
  /** Which renderer the route asks for; `unknown` is a cold deep-link only. */
  readonly routedLayout: Pad["layout"] | "unknown";
  /** Shrink's return address: the last canvas visited, else the workspace root. */
  readonly originPadId: string | null;
  readonly presence: readonly PadPresence[];
  readonly soloOccupants: ReadonlyMap<string, PlacementItem>;
  readonly creating: boolean;
  navigate(path: string, options?: { readonly replace?: boolean }): void;
  createContainer(layout: Pad["layout"]): void;
  refreshActivePad(): void;
  onWorkspaceChange(state: WorkspaceSidebarState | null): void;
  onCreateTerminalChange(create: ((machine?: MachineSummary) => void) | null): void;
  isOverSidebar(clientX: number, clientY: number): boolean;
}

const PadRouteContext = createContext<PadRoute | null>(null);

interface PadRouteProviderProps {
  readonly value: PadRoute;
  readonly children: ReactNode;
}

export function PadRouteProvider({ value, children }: PadRouteProviderProps): ReactElement {
  return <PadRouteContext.Provider value={value}>{children}</PadRouteContext.Provider>;
}

/** Throws: the pad-view panel is the shell's own half and never renders outside it. */
export function usePadRoute(): PadRoute {
  const route = useContext(PadRouteContext);
  if (route === null) {
    throw new Error("usePadRoute requires a <PadRouteProvider> ancestor");
  }
  return route;
}

/**
 * What a cold deep-link shows while the container record is in flight. A sentence would be a
 * loading screen; this is the shape of what is about to arrive, so nothing jumps when it does.
 * Every warm navigation skips it entirely — the discipline is already known.
 */
function CanvasSkeleton(): ReactElement {
  return (
    <div className="canvas-skeleton" role="presentation" aria-busy="true">
      <span className="canvas-skeleton-bar" />
      <span className="canvas-skeleton-body" />
    </div>
  );
}

export function PadViewPanel(_props: PanelProps): ReactElement {
  const route = usePadRoute();
  const { activePad, identity, pads, requestedPadId, routedLayout } = route;

  return (
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
                  disabled={route.creating}
                  onClick={() => route.createContainer("canvas")}
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
            originPadId={route.originPadId}
            navigate={route.navigate}
            presence={route.presence}
            onPadChanged={route.refreshActivePad}
            soloOccupants={route.soloOccupants}
            onCreateTerminalChange={route.onCreateTerminalChange}
          />
        </PadErrorBoundary>
      ) : (
        <PadErrorBoundary key={requestedPadId}>
          <FlowPadView
            padId={requestedPadId}
            pads={pads ?? []}
            identity={identity}
            navigate={route.navigate}
            presence={route.presence}
            onWorkspaceChange={route.onWorkspaceChange}
            soloOccupants={route.soloOccupants}
            isOverSidebar={route.isOverSidebar}
          />
        </PadErrorBoundary>
      )}
    </section>
  );
}
