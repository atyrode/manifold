import { useSyncExternalStore } from "react";

/**
 * IS THE COMMAND SURFACE OPEN, on this device.
 *
 * A module store rather than component state because the two parties are a static BINDING
 * HANDLER (`run(host)`, registration data the engine calls with no React around it) and a
 * mounted OVERLAY — the same shape `core.arrange`'s F8 toggle has, and for the same reason: a
 * handler cannot read state it is not rendered inside of.
 *
 * DEVICE-LOCAL AND UNPUBLISHED. It is not a {@link Vantage} facet: whether somebody's search
 * box is up dies with the keystroke that dismisses it, nobody merges it, and a collaborator
 * has nothing to render from it. Nothing persists either, so it needs no device-local register
 * row — the surface opens closed, every time.
 */
let open = false;
const listeners = new Set<() => void>();

export function toggleCommands(): void {
  open = !open;
  for (const listener of listeners) listener();
}

export function closeCommands(): void {
  if (!open) return;
  open = false;
  for (const listener of listeners) listener();
}

function commandsOpen(): boolean {
  return open;
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

export function useCommandsOpen(): boolean {
  return useSyncExternalStore(subscribe, commandsOpen, commandsOpen);
}
