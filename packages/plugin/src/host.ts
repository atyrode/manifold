import type {
  ActionOutcome,
  Cap,
  MachineSummary,
  PadPresence,
  PadSessionSummary,
  PadTreeItem,
  PlaceResponse,
  PlacementDenial,
  PlacementDestination,
  PlacementSurface,
  TerminalSummary,
} from "@manifold/protocol";

/**
 * What `place()` answers: the placement it executed, or the declared RULE that refused it.
 * Structurally identical to the SDK's own `PlaceOutcome` — the engine cannot depend on the
 * SDK (the SDK is a consumer of these contracts, not a provider of them), so the shape is
 * restated here over the same protocol types and satisfied structurally.
 */
export type PlaceOutcome =
  | { readonly ok: true; readonly result: PlaceResponse }
  | { readonly ok: false; readonly denial: PlacementDenial };

/**
 * The session surface a plugin is handed. It is deliberately the SDK's own surface described
 * structurally: `SessionClient` satisfies it without importing anything from here, so a
 * plugin talks to the server through exactly the doors a stranger's agent has, and nothing
 * else. Whatever is not on this interface is not reachable from plugin code — that is the
 * sandbox shape (ADR 0010) the contracts keep even while plugins run in-process.
 */
export interface SessionHandle {
  /** Invoke an action by its FULL name (`core.terminals.rename`); a denial is data, not a throw. */
  action(name: string, args: unknown): Promise<ActionOutcome>;
  /** THE placement call: put an item in a container. */
  place(surface: PlacementSurface, destination: PlacementDestination): Promise<PlaceOutcome>;
  /** The caller's own caps, as the server granted them: what UI to offer, and what to gray out. */
  selfCaps(): readonly Cap[];
  machines(): Promise<readonly MachineSummary[]>;
  padTree(): Promise<readonly PadTreeItem[]>;
  padPresence(): Promise<readonly PadPresence[]>;
  padSessions(): Promise<readonly PadSessionSummary[]>;
  terminals(): Promise<readonly TerminalSummary[]>;
}

/**
 * The viewport of the pad currently on screen, when one is. Plugins never reach into the
 * renderer: they ask the host to move the view (a spotlight lands here) and to report where
 * it is. Null when no pad view is mounted — the workspace root, for instance.
 */
export interface PadViewportHandle {
  centerOn(uri: string): void;
  viewport(): { x: number; y: number; zoom: number } | null;
}

/**
 * Everything a plugin may touch outside itself. Three capabilities, all of them addressed:
 * talk to the server (`client`), send the viewer somewhere by `manifold://` URI (`navigate`),
 * and move the mounted pad's viewport (`viewport`). No host internals, no React context of
 * the shell, no DOM handles — a contribution that needs more needs a new declared contract.
 */
export interface HostServices {
  readonly client: SessionHandle;
  navigate(uri: string): void;
  readonly viewport: PadViewportHandle | null;
}

/** A contributed panel: a tile-surface leaf, including the workspace shell's own two. */
export interface PanelProps {
  readonly host: HostServices;
}

/** A contributed sidebar section, ordered by its manifest's declared `order`. */
export interface SectionProps {
  readonly host: HostServices;
}
