import type { MachineSummary, Container, Attendance, PlacementItem } from "@manifold/protocol";
import type { ConnectionStatus } from "@manifold/sdk";
import { createContext, createElement, useContext, type ReactElement, type ReactNode } from "react";

/**
 * THE ROUTE, published — the one contract between the workspace shell and whichever plugin
 * renders the container the viewer is looking at.
 *
 * A container renderer is reached through the composition, and the composition knows nothing about
 * containers: a panel outlet takes no props and a projected ref takes only the neutral ones. So
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
 * What the MOUNTED container renderer reports upward about itself, so the sidebar can paint the
 * connection dot and the index can say how many terminals the open container holds.
 *
 * `terminalCount` rather than the rows: a terminal row is `core.terminals`' shape, and neither
 * the shell nor the engine may name a plugin's type. Nothing upstream ever wanted the rows.
 */
export interface WorkspaceSidebarState {
  readonly status: ConnectionStatus;
  readonly savedAt: number | null;
  readonly rev: number;
  readonly terminalCount: number;
  readonly onCreateTerminal: (machine?: MachineSummary) => void;
}

export interface ContainerRoute {
  readonly requestedContainerId: string | null;
  /** The routed container's record, from the index, a direct fetch, or this tab's memory. */
  readonly activeContainer: Container | null;
  /** Every indexed container; null while the first index response is in flight. */
  readonly containers: readonly Container[] | null;
  /** Which renderer the route asks for; `unknown` is a cold deep-link only. */
  readonly routedDiscipline: Container["discipline"] | "unknown";
  /** Shrink's return address: the last canvas visited, else the workspace root. */
  readonly originContainerId: string | null;
  readonly presence: readonly Attendance[];
  readonly soloOccupants: ReadonlyMap<string, PlacementItem>;
  readonly creating: boolean;
  navigate(path: string, options?: { readonly replace?: boolean }): void;
  createContainer(discipline: Container["discipline"]): void;
  refreshActiveContainer(): void;
  onWorkspaceChange(state: WorkspaceSidebarState | null): void;
  onCreateTerminalChange(create: ((machine?: MachineSummary) => void) | null): void;
  isOverSidebar(clientX: number, clientY: number): boolean;
}

const ContainerRouteContext = createContext<ContainerRoute | null>(null);

export function ContainerRouteProvider({
  value,
  children,
}: {
  readonly value: ContainerRoute;
  readonly children: ReactNode;
}): ReactElement {
  return createElement(ContainerRouteContext.Provider, { value }, children);
}

/**
 * Throws rather than degrading: a container renderer with no route has no container to render, and
 * a renderer that guessed one would tear a live room down to do it.
 */
export function useContainerRoute(): ContainerRoute {
  const route = useContext(ContainerRouteContext);
  if (route === null) {
    throw new Error("useContainerRoute requires a <ContainerRouteProvider> ancestor");
  }
  return route;
}
