/**
 * The engine's browser PLANE mechanism: what a plugin needs in order to participate in a
 * plane the engine already owns — the carry/drop vocabulary, the element host, polling. Its
 * sibling `@manifold/plugin/ui` is the other browser entry and answers a different question:
 * how a plugin LOOKS like manifold (glyphs, the one titlebar, the notice hook, view state).
 *
 * Both are subpaths rather than part of `@manifold/plugin` itself because that entry is what
 * the server composes through, which is what lets the shell and a plugin share one drag
 * vocabulary without dragging `DataTransfer` into the server's type graph.
 */
export {
  ITEM_MIME,
  beginCarry,
  carriedItem,
  carriedPlacement,
  carriesItem,
  containerEnvelope,
  endCarry,
  envelopeSurface,
  parseEnvelope,
  readEnvelope,
  sealEnvelope,
  startItemDrag,
  validateEnvelope,
  type ItemEnvelope,
  type ItemEnvelopeKind,
} from "./item-envelope.ts";
export {
  createPlacementLookup,
  denialMessage,
  itemDenialMessage,
  useItemDrop,
  type ItemDropApi,
  type ItemDropAssessment,
  type PlacementLookupInputs,
  type RefusalProps,
  type UseItemDropOptions,
} from "./item-drop.ts";

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
} from "react";

import type { ElementHost } from "./host.ts";

/**
 * How a contributed element renderer reaches its mount site.
 *
 * A CONTEXT rather than props because the engine paints contributed elements through two
 * different frames — a React Flow node type on a canvas, a tile leaf in a composition — and
 * each of them already owns a wrapper. Threading the host through those wrappers' prop types
 * would make React Flow's node-props shape part of the element contract, which is exactly the
 * host internal a plugin must not learn (ADR 0010). The surface provides; the renderer asks.
 */
const ElementHostContext = createContext<ElementHost | null>(null);

export function ElementHostProvider({
  value,
  children,
}: {
  readonly value: ElementHost;
  readonly children: ReactNode;
}): ReactElement {
  return createElement(ElementHostContext.Provider, { value }, children);
}

/** Throws rather than degrading: an element with no mount site has nowhere to commit an edit. */
export function useElementHost(): ElementHost {
  const host = useContext(ElementHostContext);
  if (host === null) {
    throw new Error("useElementHost requires an <ElementHostProvider> ancestor");
  }
  return host;
}

/**
 * The workspace index is HTTP, not a live channel: this tab learns that another tab created a
 * container, parked a terminal, or joined a room only by asking again. Five surfaces did that
 * with five hand-rolled effects, each re-deriving the same four concerns — fetch once
 * immediately, then on an interval; drop a response that a token or route change superseded;
 * hold a response that would land mid-gesture; and leave state untouched when the answer did
 * not change. This is that one poll.
 *
 * EVENTUAL FIX: a workspace event channel. The session socket already carries per-room fan-out;
 * once the server pushes container/session/presence changes over it, every caller of this hook
 * becomes a subscription and the intervals go away. The hook is deliberately shaped like a
 * subscription (value + local writes + explicit refresh) so that swap stays mechanical.
 */
export interface PolledResourceOptions<T> {
  /** The value before the first response settles; read once, like any `useState` seed. */
  readonly initial: T;
  /** While false nothing is fetched and no timer runs; flipping it true fetches at once. */
  readonly enabled?: boolean;
  /**
   * Consulted when a response settles: true drops it. A held response is never queued — the
   * next tick asks again — so pausing costs one stale interval and never a burst on release.
   */
  readonly hold?: () => boolean;
  /**
   * Content comparison. An equal response never reaches state, so an unchanged workspace
   * re-renders nobody: without this a 2s poll would rebuild every subscriber on every tick.
   */
  readonly equal?: (current: T, incoming: T) => boolean;
  readonly onError?: (reason: unknown) => void;
  /**
   * Anything outside the fetch that should make the answer stale right now — a route id, a
   * count a placement just moved. Changing it restarts the poll, immediate first fetch included.
   */
  readonly restartKey?: string | number | boolean | null;
}

export interface PolledResource<T> {
  readonly value: T;
  /** Local writes: an optimistic move, or a mutation's own response, ahead of the next tick. */
  readonly setValue: Dispatch<SetStateAction<T>>;
  /** Ask now, for a mutation whose effect the caller should not wait an interval to see. */
  readonly refresh: () => void;
}

/**
 * `fetchFn` identity is the restart signal for everything the fetch itself closes over (the
 * bearer token, an id): pass a `useCallback`. The policy callbacks are read late, so they may
 * be written inline without churning the timer.
 */
export function usePolledResource<T>(
  fetchFn: () => Promise<T>,
  intervalMs: number,
  options: PolledResourceOptions<T>,
): PolledResource<T> {
  const { initial, enabled = true, hold, equal, onError, restartKey = null } = options;
  const [value, setValue] = useState<T>(initial);

  const policy = useRef({ hold, equal, onError });
  // Declared before the poll effect, so it has already published this render's callbacks by the
  // time an immediate first fetch can settle.
  useEffect(() => {
    policy.current = { hold, equal, onError };
  });

  /**
   * Bumped whenever the poll restarts or unmounts. A response issued before the bump belongs to
   * a superseded fetch — an old token, a route the viewer already left — and is dropped rather
   * than allowed to overwrite the current answer.
   */
  const generation = useRef(0);

  const refresh = useCallback((): void => {
    const issued = generation.current;
    void fetchFn()
      .then((incoming) => {
        if (issued !== generation.current) return;
        if (policy.current.hold?.() === true) return;
        setValue((current) =>
          policy.current.equal?.(current, incoming) === true ? current : incoming,
        );
      })
      .catch((reason: unknown) => {
        if (issued !== generation.current) return;
        policy.current.onError?.(reason);
      });
  }, [fetchFn]);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const timer = window.setInterval(refresh, intervalMs);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
    };
  }, [enabled, intervalMs, refresh, restartKey]);

  return { value, setValue, refresh };
}
