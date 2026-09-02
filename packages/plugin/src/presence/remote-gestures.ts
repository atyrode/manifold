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
  /**
   * Set when the server fanned this frame here because the carry's AIM addresses this
   * container, not because the gesture is happening in this room. The geometry above is
   * then in the origin room's space and means nothing locally, so the aim is the only
   * part of the frame anything may read: `carryGhosts` skips these, because a chip at
   * another canvas's flow coordinates is not a ghost, it is a lie about where a pointer is.
   */
  readonly aimOnly?: true;
  readonly updatedAt: number;
}

/**
 * THE override key: a gesture is identified by WHAT IS HAPPENING as much as by what it
 * happens to, and the bare element id was an under-specified key for it. One element can
 * be under two gestures at once — a second input source, an SDK agent driving both — and
 * keyed by id alone the newer frame REPLACED the older, so a `resize` frame reusing a
 * live carry's element id silently deleted the carry and every viewer's split preview
 * with it. Keyed by the pair, both facts are held and neither has to win an arbitration
 * nobody could adjudicate honestly.
 */
export function gestureKey(kind: GestureKind, elementId: string): string {
  return `${kind}:${elementId}`;
}

export function applyGestureFrame(
  state: Map<string, GestureOverride>,
  frame: ServerGesture,
  selfConnId: string | null,
  now: number,
): boolean {
  if (frame.connId === selfConnId) return false;
  const key = gestureKey(frame.kind, frame.elementId);
  if (frame.phase === "end") {
    if (state.get(key)?.connId !== frame.connId) return false;
    return state.delete(key);
  }

  const previous = state.get(key);
  const target = {
    x: frame.x,
    y: frame.y,
    ...(frame.width === undefined ? {} : { width: frame.width }),
    ...(frame.height === undefined ? {} : { height: frame.height }),
  };
  const sameSender = previous?.connId === frame.connId;
  state.set(key, {
    connId: frame.connId,
    principalId: frame.principalId,
    elementId: frame.elementId,
    kind: frame.kind,
    target,
    current: sameSender && previous !== undefined ? previous.current : target,
    ...(frame.points === undefined ? {} : { points: frame.points }),
    ...(frame.carry === undefined ? {} : { carry: frame.carry }),
    ...(frame.aimOnly === undefined ? {} : { aimOnly: frame.aimOnly }),
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
  for (const [key, gesture] of state) {
    const age = now - gesture.updatedAt;
    if (age > GESTURE_TTL_MS) {
      state.delete(key);
      changed = true;
      continue;
    }
    const carry = gesture.carry;
    if (carry?.aim === undefined || age <= AIM_TTL_MS) continue;
    const aimless: Carry = {
      ref: carry.ref,
      item: carry.item,
      ...(carry.label === undefined ? {} : { label: carry.label }),
    };
    state.set(key, { ...gesture, carry: aimless });
    changed = true;
  }
  return changed;
}

export function stepGestures(state: Map<string, GestureOverride>, dtMs: number): boolean {
  let changed = false;
  for (const [key, gesture] of state) {
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
      state.set(key, { ...gesture, current: next });
      changed = true;
    }
  }
  return changed;
}
