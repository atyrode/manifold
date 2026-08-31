/**
 * Per-container, per-device camera memory: the viewport (scroll + zoom) survives a
 * refresh via localStorage. Pure policy module — serialization, validation,
 * and storage-fault tolerance live here (unit-tested); the component only
 * decides WHEN to save/restore.
 *
 * Storage faults (privacy mode, quota, disabled storage) must never break the
 * container: every operation degrades to a no-op.
 */

export interface StoredViewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/** Shared bounds for every manifold canvas renderer. */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 30;

/** Minimal Storage ref so tests can inject fakes (including throwing ones). */
export interface ViewportStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function viewportMemoryKey(containerId: string): string {
  return `manifold:viewport:${containerId}`;
}

export function encodeViewport(viewport: StoredViewport): string {
  return JSON.stringify({ x: viewport.x, y: viewport.y, zoom: viewport.zoom });
}

/**
 * Parses and validates a stored viewport. Returns null for anything that is
 * not three finite numbers within manifold's zoom bounds — restoring garbage
 * would strand the user on an unusable camera.
 */
export function decodeViewport(raw: string | null): StoredViewport | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  const x = candidate["x"];
  const y = candidate["y"];
  const zoom = candidate["zoom"];
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (typeof y !== "number" || !Number.isFinite(y)) return null;
  if (typeof zoom !== "number" || !Number.isFinite(zoom)) return null;
  if (zoom < MIN_ZOOM || zoom > MAX_ZOOM) return null;
  return { x, y, zoom };
}

/** Loads the remembered camera for a container; null on absence, garbage, or storage fault. */
export function loadViewport(storage: ViewportStorage, containerId: string): StoredViewport | null {
  try {
    return decodeViewport(storage.getItem(viewportMemoryKey(containerId)));
  } catch {
    return null;
  }
}

/** Remembers the camera for a container; silently a no-op on storage faults. */
export function saveViewport(
  storage: ViewportStorage,
  containerId: string,
  viewport: StoredViewport,
): void {
  try {
    storage.setItem(viewportMemoryKey(containerId), encodeViewport(viewport));
  } catch {
    // quota/privacy mode: camera memory is a nicety, never worth breaking the container
  }
}
