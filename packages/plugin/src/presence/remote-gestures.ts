import {
  GESTURE_TTL_MS,
  type Carry,
  type GestureKind,
  type ServerGesture,
} from "@manifold/protocol";
import { GESTURE_HALF_LIFE_MS, stepToward } from "./interpolate";

export interface GestureGeometry {
  readonly x: number;
  readonly y: number;
  readonly width?: number;
  readonly height?: number;
}

export interface GestureOverride {
  readonly connId: string;
  readonly principalId: string;
  readonly elementId: string;
  readonly kind: GestureKind;
  readonly target: GestureGeometry;
  readonly current: GestureGeometry;
  /**
   * Set on `carry` frames: the item in flight. Its presence is what lets a viewer paint
   * a ghost for something this room does not render — the geometry above is only ever
   * WHERE, never WHAT.
   */
  readonly carry?: Carry;
  readonly points?: readonly number[];
  readonly updatedAt: number;
}

export function applyGestureFrame(
  state: Map<string, GestureOverride>,
  frame: ServerGesture,
  selfConnId: string | null,
  now: number,
): boolean {
  if (frame.connId === selfConnId) return false;
  if (frame.phase === "end") {
    if (state.get(frame.elementId)?.connId !== frame.connId) return false;
    return state.delete(frame.elementId);
  }

  const previous = state.get(frame.elementId);
  const target = {
    x: frame.x,
    y: frame.y,
    ...(frame.width === undefined ? {} : { width: frame.width }),
    ...(frame.height === undefined ? {} : { height: frame.height }),
  };
  const sameSender = previous?.connId === frame.connId;
  state.set(frame.elementId, {
    connId: frame.connId,
    principalId: frame.principalId,
    elementId: frame.elementId,
    kind: frame.kind,
    target,
    current: sameSender && previous !== undefined ? previous.current : target,
    ...(frame.points === undefined ? {} : { points: frame.points }),
    ...(frame.carry === undefined ? {} : { carry: frame.carry }),
    updatedAt: now,
  });
  return true;
}

/**
 * How long a peer's AIM stays believable — far shorter than the geometry TTL, because
 * the two cost different things when a carrier's end frame is lost. A stale ghost is a
 * chip left hanging; a stale aim holds FLIP transforms on the real panes, so the whole
 * composition sits visibly squeezed. A few send intervals is enough to ride out a
 * dropped frame and short enough that nobody watches a phantom split.
 */
export const AIM_TTL_MS = 400;

/**
 * Retires what a missing end frame left behind. Geometry survives to
 * `GESTURE_TTL_MS`; the aim inside a carry is dropped at `AIM_TTL_MS`, which leaves
 * the ghost in place (the carry is still believed to be happening) while every
 * viewer's preview clears, because a preview is a claim about what a release WOULD do.
 */
export function expireGestures(state: Map<string, GestureOverride>, now: number): boolean {
  let changed = false;
  for (const [elementId, gesture] of state) {
    const age = now - gesture.updatedAt;
    if (age > GESTURE_TTL_MS) {
      state.delete(elementId);
      changed = true;
      continue;
    }
    const carry = gesture.carry;
    if (carry?.aim === undefined || age <= AIM_TTL_MS) continue;
    const aimless: Carry = {
      surface: carry.surface,
      item: carry.item,
      ...(carry.label === undefined ? {} : { label: carry.label }),
    };
    state.set(elementId, { ...gesture, carry: aimless });
    changed = true;
  }
  return changed;
}

export function stepGestures(state: Map<string, GestureOverride>, dtMs: number): boolean {
  let changed = false;
  for (const [elementId, gesture] of state) {
    const current = gesture.current;
    const target = gesture.target;
    const next = {
      x: stepToward(current.x, target.x, dtMs, GESTURE_HALF_LIFE_MS),
      y: stepToward(current.y, target.y, dtMs, GESTURE_HALF_LIFE_MS),
      ...(target.width === undefined
        ? {}
        : {
            width: stepToward(
              current.width ?? target.width,
              target.width,
              dtMs,
              GESTURE_HALF_LIFE_MS,
            ),
          }),
      ...(target.height === undefined
        ? {}
        : {
            height: stepToward(
              current.height ?? target.height,
              target.height,
              dtMs,
              GESTURE_HALF_LIFE_MS,
            ),
          }),
    };
    if (
      next.x !== current.x ||
      next.y !== current.y ||
      next.width !== current.width ||
      next.height !== current.height
    ) {
      state.set(elementId, { ...gesture, current: next });
      changed = true;
    }
  }
  return changed;
}
