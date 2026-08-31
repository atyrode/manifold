import type { MachineSummary, Pad, PadPresence, PlacementItem } from "@manifold/protocol";
import type { ConnectionStatus } from "@manifold/sdk";
import { createContext, createElement, useContext, type ReactElement, type ReactNode } from "react";

/**
 * THE ROUTE, published — the one contract between the workspace shell and whichever plugin
 * renders the container the viewer is looking at.
 *
 * A pad renderer is reached through the composition, and the composition knows nothing about
 * pads: a panel outlet takes no props and a projected surface takes only the neutral ones. So
 * the routed facts — which container, the workspace index around it, who is in it, and the
 * handful of callbacks that are genuinely the SHELL's (report your connection state, tell me
 * you can author a terminal, is this point over the sidebar) — arrive as context the shell
 * publishes above the tree.
 *
 * It lives in the engine because its two ends may not import each other. The shell writes it
 * and `core.canvas` / `core.compositions` read it; a floor module and a plugin module,
 * addressing one concept, which is precisely the litmus that puts a thing in `@manifold/plugin`
 * rather than in whichever package used it first (AXIOMS.md §Plugin layer).
 *
 * It carries NO identity: `HostServices` already answers "who is this device" for every
 * contribution, and a second answer here would be a second door onto the same question
 * (invariant 14).
 */

/**
 * What the MOUNTED pad renderer reports upward about itself, so the sidebar can paint the
 * connection dot and the index can say how many sessions the open container holds.
 *
 * `sessionCount` rather than the rows: a session row is `core.terminals`' shape, and neither
 * the shell nor the engine may name a plugin's type. Nothing upstream ever wanted the rows.
 */
export interface WorkspaceSidebarState {
  readonly status: ConnectionStatus;
  readonly savedAt: number | null;
  readonly rev: number;
  readonly sessionCount: number;
  readonly onCreateTerminal: (machine?: MachineSummary) => void;
}

export interface PadRoute {
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

export function PadRouteProvider({
  value,
  children,
}: {
  readonly value: PadRoute;
  readonly children: ReactNode;
}): ReactElement {
  return createElement(PadRouteContext.Provider, { value }, children);
}

/**
 * Throws rather than degrading: a pad renderer with no route has no container to render, and
 * a renderer that guessed one would tear a live room down to do it.
 */
export function usePadRoute(): PadRoute {
  const route = useContext(PadRouteContext);
  if (route === null) {
    throw new Error("usePadRoute requires a <PadRouteProvider> ancestor");
  }
  return route;
}
