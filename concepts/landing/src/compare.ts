// A/B comparison of two complete setups: scene, knobs, look, motion and page, everything a link
// carries. The setup on screen belongs to the live slot and is edited as usual; the other slot waits
// as its minimal query. Flipping swaps them. It is a session tool beside the setup in the URL:
//
//   ?scene=forest&rain=1&compare=b&a.scene=pond&a.motion=0.2
//
// shows slot B (forest in rain) and keeps slot A (pond at motion 0.2) under the "a." prefix. With
// both slots at defaults the prefix keys are simply absent: `?compare=b` compares pond with pond.
import { readSetup, serialise, sessionKeys } from "./state.ts";

export const slots = ["a", "b"] as const;
export type Slot = (typeof slots)[number];

export interface Comparison {
  /** The slot on screen: the page's current setup is this slot's. */
  live: Slot;
  /** The other slot's setup, as a minimal query (`serialise`). */
  other: string;
}

export function otherSlot(slot: Slot): Slot {
  return slot === "a" ? "b" : "a";
}

/** A setup query as the page writes it: normalised and minimal. */
export function canonicalSetup(query: URLSearchParams): string {
  const { state, params, planets, elements } = readSetup(query);
  return serialise(state, params, planets, elements).toString();
}

/** The comparison in a page query, or undefined when it has none. */
export function readComparison(query: URLSearchParams): Comparison | undefined {
  const live = slots.find((slot) => slot === query.get(sessionKeys.compare));
  if (live === undefined) return undefined;
  const prefix = `${otherSlot(live)}.`;
  const other = new URLSearchParams();
  for (const [key, value] of query)
    if (key.startsWith(prefix)) other.append(key.slice(prefix.length), value);
  return { live, other: canonicalSetup(other) };
}

/** Add the comparison's keys to a page query (the inverse of readComparison). */
export function writeComparison(comparison: Comparison, query: URLSearchParams): void {
  query.set(sessionKeys.compare, comparison.live);
  const prefix = `${otherSlot(comparison.live)}.`;
  for (const [key, value] of new URLSearchParams(comparison.other))
    query.append(`${prefix}${key}`, value);
}

/**
 * The URL keys whose values differ between two minimal setup queries, `scene` first and then in
 * the order they appear. A knob of one scene and a same-named knob of another count as one key.
 */
export function setupDifferences(a: string, b: string): string[] {
  const left = new URLSearchParams(a);
  const right = new URLSearchParams(b);
  const keys = [...new Set(["scene", ...left.keys(), ...right.keys()])];
  return keys.filter((key) => left.get(key) !== right.get(key));
}

/** Milliseconds a press must last to count as a hold. */
export const HOLD_MS = 300;

/**
 * One key (or button) for both kinds of comparison: a tap flips and stays, a press held for
 * HOLD_MS or longer flips back on release (a peek). The caller flips on every press; `release`
 * says whether to flip back. Times in milliseconds (`event.timeStamp`).
 */
export class TapOrHold {
  #pressedAt: number | undefined;

  press(now: number): void {
    this.#pressedAt = now;
  }

  /** The press ended: true when it was a hold. A release without a press (missed keydown) is not. */
  release(now: number): boolean {
    const at = this.#pressedAt;
    this.#pressedAt = undefined;
    return at !== undefined && now - at >= HOLD_MS;
  }
}
