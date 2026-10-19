import { describe, expect, test } from "bun:test";
import { lavaLampDoc } from "./docs.ts";
import { kindById, loadKindCode } from "./kinds/index.ts";
import { InstanceStates, STATE_WIDTH, stateRow } from "./state.ts";
import type { EngineDoc, KindDef, Placed } from "./types.ts";

const lavaLamp = kindById("lavaLamp");
if (lavaLamp?.state === undefined) throw new Error("no lavaLamp kind with state");
await loadKindCode(lavaLamp);
const { width } = lavaLamp.state;

const lamp = (id: string, x: number, options: Record<string, number> = {}): Placed => ({
  id,
  kind: "lavaLamp",
  at: [x, 0, 2],
  yaw: 0,
  scale: 1,
  options,
});

const withLamps = (...lamps: Placed[]): EngineDoc => ({
  ...lavaLampDoc,
  objects: [...lavaLampDoc.objects.filter((placed) => placed.kind !== "lavaLamp"), ...lamps],
});

/** Instance i of `kind`'s block, as the texture holds it. */
function block(states: InstanceStates, kind: KindDef, i: number): Float32Array {
  const at = (stateRow(kind) * STATE_WIDTH + i * width) * 4;
  return states.data.slice(at, at + width * 4);
}

// The frame-rate contract (src/sims/frame-rate.test.ts's method): from the same first frame, at 60
// and at 144 Hz, at each of MOMENTS the state texture agrees to within TOLERANCE of its range. The
// first frame, FIRST, keeps the moments off every fixed step's boundary.
const RATES = [60, 144] as const;
const MOMENTS = [1, 2] as const;
const FIRST = 1 / 337;
const TOLERANCE = 0.01;

function run(doc: EngineDoc, rate: number): Float32Array[] {
  const states = new InstanceStates();
  states.advance(doc, FIRST, Infinity);
  const moments: Float32Array[] = [];
  let frames = 0;
  for (const seconds of MOMENTS) {
    for (; frames < seconds * rate; frames++) states.advance(doc, 1 / rate, Infinity);
    moments.push(states.data.slice());
  }
  return moments;
}

function drift(a: Float32Array, b: Float32Array): number {
  let low = Infinity;
  let high = -Infinity;
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    low = Math.min(low, x, y);
    high = Math.max(high, x, y);
    worst = Math.max(worst, Math.abs(x - y));
  }
  const range = Math.max(high - low, Math.abs(low), Math.abs(high));
  return range === 0 ? worst : worst / range;
}

describe("the instances' sim state", () => {
  test("plays the same at 60 and 144 frames a second", () => {
    const doc = withLamps(lamp("a", 0), lamp("b", 1, { heat: 0.9 }));
    const [slow = [], fast = []] = RATES.map((rate) => run(doc, rate));
    MOMENTS.forEach((seconds, k) => {
      const a = slow[k];
      const b = fast[k];
      if (a === undefined || b === undefined) throw new Error(`no state at ${seconds} s`);
      expect(drift(a, b), `at ${seconds} s`).toBeLessThanOrEqual(TOLERANCE);
    });
    // Something moved between the moments: the comparison is of a running sim.
    expect(drift(slow[0] ?? new Float32Array(), slow[1] ?? new Float32Array())).toBeGreaterThan(0);
  });

  test("is an object's own: it lives through moves and option edits, and goes with the object", () => {
    const states = new InstanceStates();
    const still = new InstanceStates();
    const doc = withLamps(lamp("a", 0), lamp("b", 1));
    states.advance(doc, 1 / 60, Infinity);
    still.advance(doc, 1 / 60, Infinity);
    // A new object shows its warmed sim at once (an unlimited budget finishes the warm-up).
    expect(block(states, lavaLamp, 1)[0]).toBeGreaterThan(0);
    const b = doc.objects.at(-1);
    if (b === undefined) throw new Error("no lamp b");
    // Lamp b moved and recoloured, lamp a unchanged: b's wax runs on as if nothing had happened.
    const moved = withLamps(lamp("a", 0), {
      ...b,
      at: [3, 0.5, -2],
      yaw: 1,
      options: { wax: 0.6 },
    });
    for (let frame = 0; frame < 120; frame++) {
      states.advance(moved, 1 / 60, Infinity);
      still.advance(doc, 1 / 60, Infinity);
    }
    expect(block(states, lavaLamp, 1)).toEqual(block(still, lavaLamp, 1));
    // Lamp a taken away: b moves into the first slot, its state with it, and the second is empty.
    const after = block(states, lavaLamp, 1);
    states.advance(withLamps({ ...b, options: { wax: 0.6 } }), 0, Infinity);
    expect(block(states, lavaLamp, 0)).toEqual(after);
    expect(block(states, lavaLamp, 1).every((x) => x === 0)).toBe(true);
    // Lamp a back: a new sim, warmed afresh, as it first began.
    const fresh = new InstanceStates();
    fresh.advance(withLamps(lamp("a", 0)), 0, Infinity);
    states.advance(withLamps({ ...b, options: { wax: 0.6 } }, lamp("a", 0)), 0, Infinity);
    expect(block(states, lavaLamp, 1)).toEqual(block(fresh, lavaLamp, 0));
  });
});
