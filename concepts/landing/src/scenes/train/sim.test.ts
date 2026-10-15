import { expect, test } from "bun:test";
import { HeadlessSim } from "../../sims/headless.ts";
import { trainScene } from "./index.ts";
import {
  TRAIN_BLOCK,
  TRAIN_BRIDGE,
  TRAIN_CROSSING,
  TRAIN_EVENT_SLOTS,
  TRAIN_STATION,
  TRAIN_TUNNEL,
} from "./sim.ts";

/** An event as the shader is handed it: kind code, odometer reading (m) where it starts, length, seed 0..255. */
type Seen = [kind: number, start: number, length: number, seed: number];

interface Journey {
  /** Every event handed over, in order of first sight. */
  events: Seen[];
  /** Metres ahead of the train each was when first handed over (the first frame's excepted). */
  firstSight: number[];
  /** Metres run, seconds taken. */
  run: number;
  seconds: number;
  /** The last frame's upload. */
  last: Float32Array;
}

const FRAME = 0.1;
const MAX = {
  stations: 1,
  "stations-amount": 1,
  crossings: 1,
  "crossings-amount": 1,
  bridges: 1,
  "bridges-amount": 1,
  tunnels: 1,
  "tunnels-amount": 1,
};

/** A journey of `seconds` at 10 frames a second with these knobs and "now" presses ([second, knob]). */
function journey(
  knobs: Record<string, number>,
  seconds: number,
  presses: readonly (readonly [number, string])[] = [],
): Journey {
  const sim = new HeadlessSim(trainScene);
  const keys = new Set<string>();
  const out: Journey = { events: [], firstSight: [], run: 0, seconds, last: new Float32Array() };
  let from = Number.NaN;
  const frames = Math.round(seconds / FRAME);
  for (let i = 0; i < frames; i++) {
    const now = presses.filter(([at]) => Math.round(at / FRAME) === i).map(([, key]) => key);
    const data = sim.step({ dt: FRAME, knobs, now }).upload(0).data as Float32Array;
    const s = (data[0] ?? 0) * TRAIN_BLOCK + (data[1] ?? 0) + (data[2] ?? 0);
    if (Number.isNaN(from)) from = s;
    for (let k = 0; k < TRAIN_EVENT_SLOTS; k++) {
      const o = (2 + 2 * k) * 4;
      const kind = data[o + 3] ?? 0;
      if (kind < 0.5) continue;
      const start = (data[o] ?? 0) * TRAIN_BLOCK + (data[o + 1] ?? 0);
      const key = `${kind}:${start}`;
      if (keys.has(key)) continue;
      keys.add(key);
      out.events.push([kind, start, data[o + 2] ?? 0, Math.round((data[o + 4] ?? 0) * 256)]);
      if (i > 0) out.firstSight.push(start - s);
    }
    out.run = s - from;
    out.last = data;
  }
  sim.dispose();
  return out;
}

const count = (j: Journey, kind: number): number => j.events.filter(([k]) => k === kind).length;
/** Runs where an event of kind `b` starts within `gap` metres of the end of one of kind `a`. */
function runs(j: Journey, a: number, b: number, gap: readonly [number, number]): number {
  const sorted = [...j.events].sort((x, y) => x[1] - y[1]);
  let n = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    if (prev === undefined || next === undefined || prev[0] !== a || next[0] !== b) continue;
    const between = next[1] - (prev[1] + prev[2]);
    if (between >= gap[0] && between <= gap[1]) n++;
  }
  return n;
}

test("the country line keeps its timetable, draw for draw", () => {
  // Recorded from the train before the line knob: route 0 at the defaults, a tunnel "now" at 60 s
  // and a bridge at 240 s. Any change to the order or number of the journey's dice moves these.
  const j = journey({}, 600, [
    [60, "tunnels"],
    [240, "bridges"],
  ]);
  expect(j.events).toEqual([
    [TRAIN_STATION, 4540, 170, 10],
    [TRAIN_CROSSING, 5607, 0, 103],
    [TRAIN_TUNNEL, 5065, 314, 135],
    [TRAIN_BRIDGE, 5933, 115, 210],
    [TRAIN_STATION, 6475, 181, 201],
    [TRAIN_BRIDGE, 6323, 93, 146],
    [TRAIN_STATION, 8543, 186, 55],
    [TRAIN_CROSSING, 9263, 0, 87],
    [TRAIN_CROSSING, 9566, 0, 209],
    [TRAIN_BRIDGE, 9918, 127, 148],
  ]);
  expect((j.last[0] ?? 0) * TRAIN_BLOCK + (j.last[1] ?? 0) + (j.last[2] ?? 0)).toBe(
    9444.879571318626,
  );
});

test("the rural line: halts with their crossings, crossings everywhere, no tunnels, a slower pace", () => {
  const country = journey({ route: 4 }, 3600);
  const rural = journey({ route: 4, line: 1 }, 3600);
  expect(count(rural, TRAIN_TUNNEL)).toBe(0);
  expect(count(rural, TRAIN_CROSSING) / rural.run).toBeGreaterThan(
    2 * (count(country, TRAIN_CROSSING) / country.run),
  );
  // Most halts have a farm road crossing just past the platform's end.
  expect(runs(rural, TRAIN_STATION, TRAIN_CROSSING, [18, 30])).toBeGreaterThanOrEqual(
    0.5 * count(rural, TRAIN_STATION),
  );
  expect(rural.events.filter(([k, , length]) => k === TRAIN_STATION && length > 130)).toEqual([]);
  expect(rural.run).toBeLessThan(0.9 * country.run);
});

test("the mountain line: out of tunnels onto viaducts and into the next, few crossings", () => {
  const country = journey({ route: 4 }, 3600);
  const mountain = journey({ route: 4, line: 2 }, 3600);
  expect(count(mountain, TRAIN_TUNNEL) / mountain.run).toBeGreaterThan(
    2 * (count(country, TRAIN_TUNNEL) / country.run),
  );
  expect(count(mountain, TRAIN_BRIDGE) / mountain.run).toBeGreaterThan(
    2 * (count(country, TRAIN_BRIDGE) / country.run),
  );
  expect(count(mountain, TRAIN_CROSSING) / mountain.run).toBeLessThan(
    0.5 * (count(country, TRAIN_CROSSING) / country.run),
  );
  expect(runs(mountain, TRAIN_TUNNEL, TRAIN_BRIDGE, [20, 35])).toBeGreaterThanOrEqual(3);
  expect(runs(mountain, TRAIN_BRIDGE, TRAIN_TUNNEL, [15, 30])).toBeGreaterThanOrEqual(3);
  // Nothing else is ever that close: a run's members only.
  expect(
    runs(mountain, TRAIN_BRIDGE, TRAIN_BRIDGE, [0, 89]) +
      runs(mountain, TRAIN_TUNNEL, TRAIN_TUNNEL, [0, 89]),
  ).toBe(0);
  expect(mountain.run).toBeLessThan(0.85 * country.run);
});

test("a now press on the mountain line can bring the viaduct and the next tunnel with it", () => {
  let led = 0;
  for (const route of [1, 2, 3, 5, 6, 8]) {
    const j = journey({ route, line: 2, tunnels: 0, bridges: 0, stations: 0, crossings: 0 }, 120, [
      [1, "tunnels"],
    ]);
    expect(count(j, TRAIN_TUNNEL)).toBeGreaterThanOrEqual(1);
    if (runs(j, TRAIN_TUNNEL, TRAIN_BRIDGE, [20, 35]) > 0) led++;
  }
  expect(led).toBeGreaterThanOrEqual(1);
});

test("every event is handed over well before it comes into view, on every line at its busiest", () => {
  for (const line of [0, 1, 2]) {
    for (const route of [0, 3, 7]) {
      const j = journey({ ...MAX, line, route }, 1800);
      expect(j.firstSight.length).toBeGreaterThan(10);
      expect(Math.min(...j.firstSight)).toBeGreaterThan(900);
    }
  }
});

test("changing the line starts a fresh journey on it", () => {
  const switched = new HeadlessSim(trainScene);
  for (let i = 0; i < 300; i++) switched.step({ dt: FRAME });
  const after = switched.step({ dt: FRAME, knobs: { line: 2 } }).upload(0).data;
  const fresh = new HeadlessSim(trainScene).step({ dt: FRAME, knobs: { line: 2 } }).upload(0).data;
  expect(Array.from(after)).toEqual(Array.from(fresh));
});
