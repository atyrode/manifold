import { CURSOR_TTL_MS } from "@manifold/protocol";

import { CURSOR_HALF_LIFE_MS, stepToward } from "./interpolate";

export interface RemoteCursor {
  readonly principalId: string;
  readonly connId: string;
  readonly x: number;
  readonly y: number;
  readonly targetX: number;
  readonly targetY: number;
  /** When this cursor last heard from its sender; the clock behind {@link expireRemoteCursors}. */
  readonly updatedAt: number;
}

interface CursorFrame {
  readonly principalId: string;
  readonly connId: string;
  readonly x: number;
  readonly y: number;
}

/** Which socket a retraction speaks for. A cursor is per-connection, so a retraction is too. */
interface CursorSender {
  readonly principalId: string;
  readonly connId: string;
}

/** A socket id remains unique when one principal has several live browser connections. */
export function remoteCursorSocketId(principalId: string, connId: string): string {
  return `${principalId}:${connId}`;
}

/** Records every remote connection, including siblings, while dropping only this socket's echo. */
export function recordRemoteCursor(
  cursors: Map<string, RemoteCursor>,
  frame: CursorFrame,
  selfConnId: string | null,
  now: number,
): boolean {
  if (frame.connId === selfConnId) return false;
  const id = remoteCursorSocketId(frame.principalId, frame.connId);
  const previous = cursors.get(id);
  cursors.set(id, {
    principalId: frame.principalId,
    connId: frame.connId,
    x: previous?.x ?? frame.x,
    y: previous?.y ?? frame.y,
    targetX: frame.x,
    targetY: frame.y,
    updatedAt: now,
  });
  return true;
}

/**
 * Retires one sender's cursor because that sender SAID it is gone — a pointer off the
 * surface, or a tab gone hidden, published as a null cursor on the presence plane.
 *
 * Exactly one socket's cursor goes: the sibling tabs of the same principal are separate
 * pointers on separate screens, and the room's other principals are nobody's business
 * here. Reporting whether anything was actually removed keeps a retraction for a cursor
 * this viewer never painted — a peer who left before their first frame arrived, or this
 * socket's own echo — from costing a repaint.
 */
export function retractRemoteCursor(
  cursors: Map<string, RemoteCursor>,
  sender: CursorSender,
  selfConnId: string | null,
): boolean {
  if (sender.connId === selfConnId) return false;
  return cursors.delete(remoteCursorSocketId(sender.principalId, sender.connId));
}

/**
 * Retires what a missing retraction left behind. The explicit goodbye rides an ordered
 * socket, so this fires only when the socket itself died between the last frame and the
 * roster noticing — but "only" is not "never", and the cost of getting it wrong is a
 * cursor nobody can dismiss sitting on a shared canvas forever (#54).
 *
 * The clock is a parameter, never `performance.now()` read in here: the caller already
 * holds an animation-frame timestamp, and a pure module that reads a clock cannot be
 * tested at the boundary that matters.
 */
export function expireRemoteCursors(cursors: Map<string, RemoteCursor>, now: number): boolean {
  let changed = false;
  for (const [id, cursor] of cursors) {
    if (now - cursor.updatedAt <= CURSOR_TTL_MS) continue;
    cursors.delete(id);
    changed = true;
  }
  return changed;
}

interface AttendanceConnections {
  readonly principal: { readonly id: string };
  readonly connIds: readonly string[];
}

/**
 * Retires cursors whose connection is gone. Cursors are stamped per-connection, but a
 * principal with several tabs stays in the roster until the last one closes — pruning
 * by principal alone left a dead tab's cursor lying on the canvas forever. The roster
 * carries the exact live connection ids, so anything outside that set is a ghost.
 */
export function pruneRemoteCursors(
  cursors: Map<string, RemoteCursor>,
  roster: Iterable<AttendanceConnections>,
): boolean {
  const live = new Set<string>();
  for (const state of roster) {
    for (const connId of state.connIds) live.add(remoteCursorSocketId(state.principal.id, connId));
  }
  let changed = false;
  for (const id of cursors.keys()) {
    if (live.has(id)) continue;
    cursors.delete(id);
    changed = true;
  }
  return changed;
}

/**
 * Disambiguates sibling tabs of one principal: the roster's live conn ids sort into a
 * shared order, the first keeps the bare name, and later tabs render "name (2)", "name
 * (3)"... Every viewer computes the same label because every viewer holds the same
 * roster. A connId not (yet) in the roster keeps the bare name rather than guessing.
 */
export function cursorLabel(name: string, connId: string, connIds: readonly string[]): string {
  if (connIds.length < 2) return name;
  const ordinal = [...connIds].sort().indexOf(connId);
  return ordinal <= 0 ? name : `${name} (${ordinal + 1})`;
}

/**
 * Advances every cursor one animation frame. `epsilon` is the snap threshold in the
 * room's OWN coordinate units and is required, not defaulted: a canvas room carries
 * scene pixels while a composition room carries view-root fractions, and the pixel threshold
 * applied to fractions would snap on every frame instead of easing.
 */
export function stepRemoteCursors(
  cursors: Map<string, RemoteCursor>,
  dtMs: number,
  epsilon: number,
): boolean {
  let changed = false;
  for (const [id, cursor] of cursors) {
    const x = stepToward(cursor.x, cursor.targetX, dtMs, CURSOR_HALF_LIFE_MS, epsilon);
    const y = stepToward(cursor.y, cursor.targetY, dtMs, CURSOR_HALF_LIFE_MS, epsilon);
    if (x === cursor.x && y === cursor.y) continue;
    cursors.set(id, { ...cursor, x, y });
    changed = true;
  }
  return changed;
}

/** A point in some cursor coordinate space: client pixels, or unit-square fractions. */
export interface CursorPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * The box a fractional cursor is measured against. Field names match `DOMRect` so a
 * caller hands `getBoundingClientRect()` straight in.
 */
export interface CursorBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Projects a client point into unit-square fractions of a box.
 *
 * A container's coordinate space is decided by its discipline. Canvas rooms carry
 * React-Flow coordinates, which only mean anything against a shared scene. Composition rooms
 * have no such scene, but they do have a shared layout tree: tile ratios are CRDT state,
 * so a fraction of the view root resolves to the same tile for every viewer whatever
 * their window size. Hence fractions, not pixels, on the wire for composition rooms.
 *
 * A zero-sized box — a view that has not laid out yet — collapses to the origin instead
 * of dividing by zero.
 */
export function cursorFraction(box: CursorBox, point: CursorPoint): CursorPoint {
  return {
    x: box.width <= 0 ? 0 : clampUnit((point.x - box.left) / box.width),
    y: box.height <= 0 ? 0 : clampUnit((point.y - box.top) / box.height),
  };
}

/**
 * Clamps a received fraction back into the unit square before it is painted. The sender
 * clamps too, but a frame that predates a discipline change (or any future sender) must
 * never push a cursor outside the view root.
 */
export function clampCursorFraction(point: CursorPoint): CursorPoint {
  return { x: clampUnit(point.x), y: clampUnit(point.y) };
}
