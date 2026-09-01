import type { Container } from "@manifold/protocol";
import { createContext, createElement, useContext, type ReactElement, type ReactNode } from "react";
import type { WorkspaceSidebarState } from "./container-route.ts";

/**
 * THE SHELL'S OWN HALF, published — the second contract between the workspace host and the
 * plugin that draws its sidebar, and the exact counterpart of {@link ContainerRoute}.
 *
 * It exists here for the same reason the route does, and by the same litmus: its two ends may
 * not import each other. The workspace host is FLOOR (`packages/web/src/workspace.tsx`); the
 * sidebar panel is `core.shell`'s browser half, a plugin, reached through a panel outlet that
 * takes no props. So the handful of facts that are genuinely the HOST's — how wide the rail is
 * drawn, which arrangement this principal stored, the two creation doors beside the stack, the
 * running build's own version — arrive as context the host publishes above the tree, and
 * `@manifold/plugin` is the only thing both halves are allowed to import (REGISTRY.md
 * §Plugin layer).
 *
 * It is NOT {@link HostServices}, and the difference is the point. `HostServices` is what EVERY
 * plugin may touch; this is what the one plugin occupying the shell's own panel is handed by the
 * host that mounts it. A section inside the stack never sees it — a section talks to the server
 * through `host.client` like any other contribution.
 *
 * It carries NO identity and NO assembly: `HostServices.principal` already answers "who is this
 * device" and `HostServices.assembly` already answers "what did the composition decide", and a
 * second answer to either would be a second door onto one question (invariant 14).
 */

/**
 * One frozen release of the running browser build, as its history dialog prints it.
 *
 * Release metadata is the FLOOR's: the version is injected into the bundle by the web package's
 * own build (`vite.config.ts`) and the history is generated from `CHANGELOG.md` by the release
 * path, so neither is a plugin's data even though a plugin's chrome prints it. The shape is
 * declared here because the producer is floor and the consumer is a plugin.
 */
export interface WebChangelogRelease {
  readonly version: string;
  readonly date: string;
  readonly changes: readonly string[];
}

export interface WorkspaceShell {
  /** False while the rail is collapsed to icons. PRESENCE, not device state (A2). */
  readonly sidebarOpen: boolean;
  setSidebarOpen(open: boolean): void;
  /** Connection and persistence state of the mounted container, when one is mounted. */
  readonly workspace: WorkspaceSidebarState | null;
  readonly creating: boolean;
  createContainer(discipline: Container["discipline"]): void;
  createFolder(name: string): Promise<void>;
  /**
   * The rail's own element, handed back so the host can answer "is this point over the
   * sidebar" for a carry that crosses it — the one geometric question the host cannot ask
   * without the node the panel rendered.
   */
  registerSidebarElement(element: HTMLElement | null): void;
  /**
   * This principal's stored section arrangement, or undefined for "the manifests decide" —
   * which is the default and the overwhelmingly common case.
   */
  readonly sectionOrder: readonly string[] | undefined;
  /**
   * COMMIT: the arrangement the sidebar let go of, written through the workspace layout
   * door. One call per gesture at the release, never per frame (the plane rule's commit
   * point) — the sidebar previews locally and calls this once.
   */
  commitSectionOrder(order: readonly string[]): void;
  /** The running build's label, already joined: version and build in one string. */
  readonly webVersionLabel: string;
  readonly webChangelog: readonly WebChangelogRelease[];
}

const WorkspaceShellContext = createContext<WorkspaceShell | null>(null);

export function WorkspaceShellProvider({
  value,
  children,
}: {
  readonly value: WorkspaceShell;
  readonly children: ReactNode;
}): ReactElement {
  return createElement(WorkspaceShellContext.Provider, { value }, children);
}

/**
 * Throws rather than degrading: the shell's own panel outside the shell that mounts it has no
 * rail to draw, no arrangement to read and no door to commit one through, and a panel that
 * guessed those would paint a sidebar nothing on screen agrees with.
 */
export function useWorkspaceShell(): WorkspaceShell {
  const shell = useContext(WorkspaceShellContext);
  if (shell === null) {
    throw new Error("useWorkspaceShell requires a <WorkspaceShellProvider> ancestor");
  }
  return shell;
}
