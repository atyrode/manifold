export interface CursorUpdate {
  readonly x: number;
  readonly y: number;
  readonly tool: "pointer" | "laser";
}

export interface ViewportUpdate {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface VersionStamp {
  readonly id: string;
  readonly version: number;
  readonly versionNonce: number;
}

export interface TransportCadenceOptions<TScene extends VersionStamp, TCursor, TViewport> {
  readonly now: () => number;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (timer: number) => void;
  readonly sceneIntervalMs: number;
  readonly cursorIntervalMs: number;
  readonly viewportIntervalMs: number;
  readonly maxSceneBatchSize: number;
  readonly canSendScene: () => boolean;
  readonly sendScene: (elements: readonly TScene[]) => void;
  readonly sendCursor: (cursor: TCursor) => void;
  readonly sendViewport: (viewport: TViewport) => void;
  readonly sameViewport: (left: TViewport, right: TViewport) => boolean;
}

export interface TransportCadence<TScene extends VersionStamp, TCursor, TViewport> {
  readonly queueScene: (
    elements: readonly VersionStamp[],
    parse: (element: VersionStamp) => TScene,
  ) => void;
  readonly publishSceneImmediately: (elements: readonly TScene[]) => void;
  readonly recordCanonicalScene: (elements: readonly TScene[]) => void;
  readonly forgetSceneVersion: (id: string) => void;
  readonly resetScene: () => void;
  readonly flushScene: () => void;
  readonly sendCursor: (cursor: TCursor) => void;
  readonly pendingSceneIds: () => readonly string[];
  readonly sendViewport: (viewport: TViewport) => void;
  readonly flushViewport: () => void;
  readonly latestViewport: () => TViewport | null;
  /** Side-band observer invoked after every viewport send (e.g. device-local persistence). */
  readonly setViewportSentListener: (listener: ((viewport: TViewport) => void) | null) => void;
  readonly cancel: () => void;
}

/** Pure transport timing and coalescing policy; the caller supplies clock, timers, and sends. */
export function createTransportCadence<TScene extends VersionStamp, TCursor, TViewport>(
  options: TransportCadenceOptions<TScene, TCursor, TViewport>,
): TransportCadence<TScene, TCursor, TViewport> {
  const versions = new Map<string, { readonly version: number; readonly versionNonce: number }>();
  const pendingScene = new Map<string, TScene>();
  let sceneTimer: number | null = null;
  let lastSceneSentAt: number | null = null;
  let cursorTimer: number | null = null;
  let pendingCursor: TCursor | null = null;
  let lastCursorSentAt: number | null = null;
  let viewportTimer: number | null = null;
  let pendingViewport: TViewport | null = null;
  let observedViewport: TViewport | null = null;
  let lastViewportSentAt: number | null = null;
  let onViewportSent: ((viewport: TViewport) => void) | null = null;

  const sendSceneBatches = (elements: readonly TScene[]): void => {
    for (let offset = 0; offset < elements.length; offset += options.maxSceneBatchSize) {
      options.sendScene(elements.slice(offset, offset + options.maxSceneBatchSize));
    }
  };

  const flushScene = (): void => {
    sceneTimer = null;
    if (!options.canSendScene()) return;
    const pending = [...pendingScene.values()];
    pendingScene.clear();
    if (pending.length === 0) return;
    lastSceneSentAt = options.now();
    sendSceneBatches(pending);
  };

  const scheduleSceneFlush = (): void => {
    if (sceneTimer !== null) return;
    const delay =
      lastSceneSentAt === null
        ? options.sceneIntervalMs
        : Math.max(0, options.sceneIntervalMs - (options.now() - lastSceneSentAt));
    sceneTimer = options.setTimer(flushScene, delay);
  };

  const queueScene = (
    elements: readonly VersionStamp[],
    parse: (element: VersionStamp) => TScene,
  ): void => {
    let changed = false;
    for (const element of elements) {
      const previous = versions.get(element.id);
      if (
        previous !== undefined &&
        previous.version === element.version &&
        previous.versionNonce === element.versionNonce
      ) {
        continue;
      }
      const parsed = parse(element);
      versions.set(parsed.id, { version: parsed.version, versionNonce: parsed.versionNonce });
      pendingScene.set(parsed.id, parsed);
      changed = true;
    }
    if (changed) scheduleSceneFlush();
  };

  const publishSceneImmediately = (elements: readonly TScene[]): void => {
    for (const element of elements) {
      versions.set(element.id, { version: element.version, versionNonce: element.versionNonce });
      pendingScene.delete(element.id);
    }
    if (pendingScene.size === 0 && sceneTimer !== null) {
      options.clearTimer(sceneTimer);
      sceneTimer = null;
    }
    lastSceneSentAt = options.now();
    sendSceneBatches(elements);
  };

  const recordCanonicalScene = (elements: readonly TScene[]): void => {
    for (const element of elements) {
      versions.set(element.id, { version: element.version, versionNonce: element.versionNonce });
      pendingScene.delete(element.id);
    }
  };

  const flushCursor = (): void => {
    cursorTimer = null;
    const cursor = pendingCursor;
    pendingCursor = null;
    if (cursor === null) return;
    options.sendCursor(cursor);
    lastCursorSentAt = options.now();
  };

  const sendCursor = (cursor: TCursor): void => {
    const lastSentAt = lastCursorSentAt;
    if (lastSentAt === null || options.now() - lastSentAt >= options.cursorIntervalMs) {
      if (cursorTimer !== null) {
        options.clearTimer(cursorTimer);
        cursorTimer = null;
      }
      pendingCursor = null;
      options.sendCursor(cursor);
      lastCursorSentAt = options.now();
      return;
    }
    pendingCursor = cursor;
    if (cursorTimer === null) {
      const delay = Math.max(0, options.cursorIntervalMs - (options.now() - lastSentAt));
      cursorTimer = options.setTimer(flushCursor, delay);
    }
  };

  const flushViewport = (): void => {
    viewportTimer = null;
    const viewport = pendingViewport;
    pendingViewport = null;
    if (viewport === null) return;
    options.sendViewport(viewport);
    lastViewportSentAt = options.now();
    onViewportSent?.(viewport);
  };

  const sendViewport = (viewport: TViewport): void => {
    if (observedViewport !== null && options.sameViewport(observedViewport, viewport)) return;
    observedViewport = viewport;
    pendingViewport = viewport;
    if (viewportTimer !== null) return;
    const delay =
      lastViewportSentAt === null
        ? 0
        : Math.max(0, options.viewportIntervalMs - (options.now() - lastViewportSentAt));
    viewportTimer = options.setTimer(flushViewport, delay);
  };

  const resetScene = (): void => {
    pendingScene.clear();
    versions.clear();
    if (sceneTimer !== null) options.clearTimer(sceneTimer);
    sceneTimer = null;
  };

  const cancel = (): void => {
    if (sceneTimer !== null) options.clearTimer(sceneTimer);
    if (cursorTimer !== null) options.clearTimer(cursorTimer);
    if (viewportTimer !== null) options.clearTimer(viewportTimer);
    sceneTimer = null;
    cursorTimer = null;
    viewportTimer = null;
  };

  return {
    queueScene,
    publishSceneImmediately,
    recordCanonicalScene,
    forgetSceneVersion: (id) => versions.delete(id),
    resetScene,
    flushScene,
    sendCursor,
    pendingSceneIds: () => [...pendingScene.keys()],
    sendViewport,
    flushViewport,
    latestViewport: () => observedViewport,
    setViewportSentListener: (listener) => {
      onViewportSent = listener;
    },
    cancel,
  };
}
