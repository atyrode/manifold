import type { CarryAim, PlacementItem } from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import { useEffect, useRef, useState } from "react";
import { carryFrame, carryPlacementId, type CarryPoint, type CarrySource } from "./carry.ts";
import {
  applyGestureFrame,
  createGestureStream,
  expireGestures,
  gestureSendIntervalOverride,
  stepGestures,
  type GestureOverride,
  type GestureStream,
} from "./presence/index.ts";
import {
  beginCarry,
  carriedItem,
  carriedPlacement,
  endCarry,
  startItemDrag,
  type ItemEnvelope,
} from "./item-envelope.ts";

/**
 * The carry lifecycle, in React. One grab is one carry whatever grabbed it — a React
 * Flow node drag, a portal's tile grip, a leaf's grip inside a composition, or an HTML5
 * drag that started in the sidebar and wandered in — so the send half lives here once
 * and every renderer calls the same three verbs.
 *
 * The receive half ({@link useRemoteGestures}) sits beside it deliberately: a carry is
 * only half a concept if collaborators cannot see it, and both renderers need the same
 * override map, the same self-echo drop and the same easing tick.
 */

const NO_OVERRIDES: ReadonlyMap<string, GestureOverride> = new Map();

export interface CarryController {
  /**
   * A grab starts here. `transfer` seals the envelope into an HTML5 drag as well, which
   * is the same event — a source that has a DataTransfer must hand the payload over in
   * `dragstart` or the drop has nothing to read.
   *
   * `at` is optional because half the sources cannot answer it: an HTML5 `dragstart`
   * fires on chrome that knows nothing of the room's coordinate space. Those carries
   * simply begin streaming on their first {@link CarryController.track} frame.
   *
   * A grab whose item this renderer cannot classify does not begin at all: the carry's
   * item is required data (every viewer judges legality from it), and such a gesture was
   * already refused on release by the same lookup that cannot classify it now.
   */
  begin(
    envelope: ItemEnvelope,
    options: {
      readonly at?: CarryPoint;
      readonly label?: string | null;
      readonly transfer?: DataTransfer;
    },
  ): void;
  /**
   * One frame of motion. A carry that started somewhere else (a sidebar row, whose
   * source cannot reach this room) is ADOPTED on its first frame: the item register is
   * process-wide, so entering a renderer is all the invitation a carry needs. `aim` is
   * the resolved drop target while one is armed — it rides the same frame so every
   * viewer re-derives this drag's split preview from the shared kernel.
   */
  track(at: CarryPoint, aim?: CarryAim): void;
  /** Ends the carry: final frame, and the item register is cleared. */
  end(at?: CarryPoint): void;
  /** The placement id being streamed, for a source that renders its own carried state. */
  id(): string | null;
}

export interface UseCarryOptions {
  readonly client: SessionClient;
  /**
   * What to call an ADOPTED carry — the renderer knows names this module cannot: its
   * own terminals, its own container index. Null falls back to the species name.
   */
  readonly describe?: (envelope: ItemEnvelope) => string | null;
  /**
   * What a grab in THIS renderer is holding, classified against the renderer's own
   * placement lookup. The grab site is the only party that can answer without a census,
   * so it answers once and the answer rides every frame this carry sends. Null refuses
   * the grab (see {@link CarryController.begin}).
   */
  readonly resolveItem: (envelope: ItemEnvelope) => PlacementItem | null;
}

/**
 * One carry per renderer. The controller is stable for the life of the mount, so drag
 * handlers can depend on it without re-subscribing every frame.
 */
export function useCarry({ client, describe, resolveItem }: UseCarryOptions): CarryController {
  const describeRef = useRef(describe);
  const resolveItemRef = useRef(resolveItem);
  useEffect(() => {
    describeRef.current = describe;
    resolveItemRef.current = resolveItem;
  });
  const sourceRef = useRef<CarrySource | null>(null);
  const lastPointRef = useRef<CarryPoint | null>(null);
  const streamRef = useRef<GestureStream | null>(null);
  const [controller] = useState<CarryController>(() => {
    const stream = (): GestureStream => {
      const intervalMs = gestureSendIntervalOverride();
      streamRef.current ??= createGestureStream({
        ...(intervalMs === null ? {} : { intervalMs }),
        send: (gesture) => client.sendGesture(gesture),
      });
      return streamRef.current;
    };
    const open = (
      envelope: ItemEnvelope,
      item: PlacementItem,
      label: string | null,
    ): CarrySource => ({
      // Keyed by the placement wherever there is one, so a viewer's override lands on
      // the object itself and the source container moves live. An unplaced item (pool
      // row, sidebar container) gets a throwaway key: nothing here renders it anyway.
      id: carryPlacementId(envelope) ?? crypto.randomUUID(),
      envelope,
      item,
      label,
    });
    return {
      begin(envelope, options) {
        const item = resolveItemRef.current(envelope);
        if (item === null) return;
        const source = open(envelope, item, options.label ?? null);
        sourceRef.current = source;
        lastPointRef.current = options.at ?? null;
        if (options.transfer === undefined) beginCarry(envelope, item);
        else startItemDrag({ dataTransfer: options.transfer }, envelope, item);
        if (options.at !== undefined) stream().push(carryFrame(source, options.at, "active"));
      },
      track(at, aim) {
        let source = sourceRef.current;
        if (source === null) {
          // ADOPTION: the register already holds the grabber's own answer, and that is the
          // one to stream — re-classifying a foreign grab here would ask this renderer's
          // census a question the source already answered.
          const envelope = carriedItem();
          const held = carriedPlacement();
          if (envelope === null || held === null) return;
          source = open(envelope, held.item, describeRef.current?.(envelope) ?? null);
          sourceRef.current = source;
        }
        lastPointRef.current = at;
        stream().push(carryFrame(source, at, "active", aim));
      },
      end(at) {
        const source = sourceRef.current;
        endCarry();
        if (source === null) return;
        sourceRef.current = null;
        const point = at ?? lastPointRef.current;
        lastPointRef.current = null;
        // A carry with no frame yet cannot strand an override, so there is nothing to
        // retract; otherwise the end frame is what releases the peers' ghosts at once.
        if (point !== null) stream().end(carryFrame(source, point, "end"));
      },
      id: () => sourceRef.current?.id ?? null,
    };
  });

  useEffect(() => {
    /**
     * `dragend` fires on the source of an HTML5 drag however it finished, including an
     * abort with no drop, and it is the only signal an adopted carry ever gets. Without
     * it a cancelled sidebar drag would leave a ghost hanging in every other browser
     * until the gesture TTL swept it.
     */
    const onDragEnd = (): void => controller.end();
    window.addEventListener("dragend", onDragEnd);
    return () => {
      window.removeEventListener("dragend", onDragEnd);
      controller.end();
      streamRef.current?.cancel();
    };
  }, [controller]);

  return controller;
}

/**
 * Peers' live geometry for one room: overrides keyed by placement id, eased toward the
 * newest frame and expired when an end frame never arrives. Both renderers mount it —
 * a canvas projects the overrides onto its elements, a composition paints the carries
 * it is handed — so the subscription, the self-echo drop and the tick live here once.
 */
export function useRemoteGestures(client: SessionClient): ReadonlyMap<string, GestureOverride> {
  const [overrides, setOverrides] = useState<ReadonlyMap<string, GestureOverride>>(NO_OVERRIDES);
  const stateRef = useRef(new Map<string, GestureOverride>());

  useEffect(() => {
    const state = stateRef.current;
    const offGesture = client.on("gesture", (message) => {
      if (applyGestureFrame(state, message, client.selfConnId, performance.now())) {
        setOverrides(new Map(state));
      }
    });
    // A reset replaces the document under every override: keeping them would animate
    // geometry toward positions in a scene that no longer exists.
    const offReset = client.on("scene_reset", () => {
      if (state.size === 0) return;
      state.clear();
      setOverrides(NO_OVERRIDES);
    });
    return () => {
      offGesture();
      offReset();
      state.clear();
    };
  }, [client]);

  useEffect(() => {
    const state = stateRef.current;
    let animationFrame = 0;
    let previous = performance.now();
    const tick = (now: number): void => {
      const elapsed = Math.max(0, now - previous);
      previous = now;
      const stepped = stepGestures(state, elapsed);
      const expired = expireGestures(state, now);
      if (stepped || expired) setOverrides(new Map(state));
      animationFrame = requestAnimationFrame(tick);
    };
    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, []);

  return overrides;
}
