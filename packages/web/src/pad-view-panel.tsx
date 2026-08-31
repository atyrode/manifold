import type { PanelProps } from "@manifold/plugin";
import { PadSurface, usePadRoute } from "@manifold/plugin/hooks";
import type { ReactElement } from "react";
import { PadErrorBoundary } from "./error-boundary.tsx";

/**
 * The `core.shell.pad-view` panel — FLOOR, and now genuinely neutral.
 *
 * It holds no renderer. `core.canvas` and `core.compositions` own the two disciplines, and a
 * container renderer is reached by LAYOUT through the projection's pad-surface registry: this
 * panel resolves the route to a discipline and asks for that discipline's surface. The routed
 * shell and a composition's tile leaf make the same call with a different `layout`, which is
 * the whole of why one door is enough (invariant 14) and why a canvas can hold a composition
 * and a composition a canvas without either plugin importing the other.
 *
 * So what is left here is exactly the shell's own three answers, and nothing that knows how a
 * container is drawn: nothing routed yet, an index that has not answered yet, and a record in
 * flight. Everything else is somebody's registration — including the placeholder a disabled
 * `core.canvas` paints, which `PadSurface` supplies.
 *
 * A panel is reached through `PanelOutlet`, which knows nothing about pads, so the route
 * cannot arrive as props: it arrives as `PadRoute` context published above the tree by the
 * shell and read here and by both renderers through `@manifold/plugin`.
 */

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

export function PadViewPanel({ host }: PanelProps): ReactElement {
  const route = usePadRoute();
  const { pads, requestedPadId, routedLayout } = route;

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
      ) : (
        <PadErrorBoundary key={requestedPadId}>
          <PadSurface
            layout={routedLayout}
            host={host}
            padId={requestedPadId}
            pads={pads ?? []}
            presence={route.presence}
            soloOccupants={route.soloOccupants}
            navigate={route.navigate}
          />
        </PadErrorBoundary>
      )}
    </section>
  );
}
