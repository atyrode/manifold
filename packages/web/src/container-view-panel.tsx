import type { PanelProps } from "@manifold/plugin";
import { ContainerRenderer, useContainerRoute } from "@manifold/plugin/hooks";
import type { ReactElement } from "react";
import { ContainerErrorBoundary } from "./error-boundary.tsx";

/**
 * The `core.shell.container-view` panel — FLOOR, and now genuinely neutral.
 *
 * It holds no renderer. `core.canvas` and `core.compositions` own the two disciplines, and a
 * container renderer is reached by LAYOUT through the projection's container-ref registry: this
 * panel resolves the route to a discipline and asks for that discipline's ref. The routed
 * shell and a composition's tile leaf make the same call with a different `layout`, which is
 * the whole of why one door is enough (invariant 14) and why a canvas can hold a composition
 * and a composition a canvas without either plugin importing the other.
 *
 * So what is left here is exactly the shell's own three answers, and nothing that knows how a
 * container is drawn: nothing routed yet, an index that has not answered yet, and a record in
 * flight. Everything else is somebody's registration — including the placeholder a disabled
 * `core.canvas` paints, which `ContainerRenderer` supplies.
 *
 * A panel is reached through `PanelOutlet`, which knows nothing about containers, so the route
 * cannot arrive as props: it arrives as `ContainerRoute` context published above the tree by the
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

export function ContainerViewPanel({ host }: PanelProps): ReactElement {
  const route = useContainerRoute();
  const { containers, requestedContainerId, routedDiscipline } = route;

  return (
    <section className="workspace-canvas" aria-label="Active view">
      {requestedContainerId === null ? (
        containers === null ? (
          <CanvasSkeleton />
        ) : (
          <div className="workspace-empty">
            {containers.length === 0 ? (
              <>
                <span className="workspace-empty-mark">M</span>
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
      ) : routedDiscipline === "unknown" ? (
        // A cold deep-link only: every id this tab has already seen answered above. The
        // renderer follows the container's discipline, so an unseen id waits for the record
        // rather than guessing — guessing would mean tearing a live room back down.
        <CanvasSkeleton />
      ) : (
        <ContainerErrorBoundary key={requestedContainerId}>
          <ContainerRenderer
            layout={routedDiscipline}
            host={host}
            containerId={requestedContainerId}
            containers={containers ?? []}
            presence={route.presence}
            soloOccupants={route.soloOccupants}
            navigate={route.navigate}
          />
        </ContainerErrorBoundary>
      )}
    </section>
  );
}
