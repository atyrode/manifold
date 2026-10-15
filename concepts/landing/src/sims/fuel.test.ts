import { expect, test } from "bun:test";
import { FUEL_STEP, FuelBed, STEADY_FIRE } from "./fuel.ts";

/** Run `seconds` of motion time in fixed steps, calling `each` after every step with the elapsed time. */
function run(
  bed: FuelBed,
  seconds: number,
  burnTime: number,
  tend: boolean,
  each?: (time: number) => void,
): void {
  const steps = Math.round(seconds / FUEL_STEP);
  for (let i = 1; i <= steps; i++) {
    bed.step(FUEL_STEP, burnTime, tend);
    each?.(i * FUEL_STEP);
  }
}

function snapshot(bed: FuelBed): number[] {
  return [
    bed.heat,
    bed.embers,
    bed.smoke,
    bed.burst,
    ...bed.logs.flatMap((log) => [log.mass, log.lit, log.char, log.settle, log.placed]),
  ];
}

test("an untended fire burns down to a glowing bed, then goes out", () => {
  const bed = new FuelBed(3, 7);
  bed.open(STEADY_FIRE);
  expect(bed.heat).toBeGreaterThan(0.9);
  let flamesOut = Number.NaN;
  let embersAtFlamesOut = 0;
  run(bed, 6 * 240, 240, false, (time) => {
    if (Number.isNaN(flamesOut) && bed.heat === 0) {
      flamesOut = time;
      embersAtFlamesOut = bed.embers;
    }
  });
  // The flames die within the logs' burn time, the coals glowing on after them, then nothing.
  expect(flamesOut).toBeLessThan(240);
  expect(embersAtFlamesOut).toBeGreaterThan(0.3);
  expect(bed.embers).toBeLessThan(0.01);
  expect(bed.logs.every((log) => log.mass === 0)).toBe(true);
});

test("a tended fire never goes out: fresh logs are laid as old ones burn away", () => {
  const bed = new FuelBed(3, 7);
  bed.open(STEADY_FIRE);
  let lowest = Number.POSITIVE_INFINITY;
  let laid = 0;
  const resting = bed.logs.map(() => true);
  run(bed, 30 * 60, 240, true, () => {
    lowest = Math.min(lowest, Math.max(bed.heat, bed.embers));
    for (const [i, log] of bed.logs.entries()) {
      if (log.placed < 1 && resting[i]) laid++;
      resting[i] = log.placed >= 1;
    }
  });
  expect(lowest).toBeGreaterThan(0.3);
  // About one log a minute for three logs that each last four minutes or so.
  expect(laid).toBeGreaterThan(15);
  expect(laid).toBeLessThan(45);
});

test("a burning log chars, and slumps into the bed in steps, each with a burst of sparks", () => {
  const bed = new FuelBed(1, 3);
  bed.open([1]);
  let char = bed.logs[0]?.char ?? -1;
  let settle = bed.logs[0]?.settle ?? -1;
  let bursts = 0;
  let previous = bed.burst;
  run(bed, 240, 240, false, () => {
    const log = bed.logs[0];
    if (!log) throw new Error("no log");
    expect(log.char).toBeGreaterThanOrEqual(char);
    expect(log.settle).toBeGreaterThanOrEqual(settle - 1e-12);
    char = log.char;
    settle = log.settle;
    if (bed.burst > previous + 0.5) bursts++;
    previous = bed.burst;
  });
  expect(char).toBeGreaterThan(0.95);
  expect(settle).toBeGreaterThan(0.99);
  expect(bursts).toBe(4);
});

test("the burn time stretches the whole lifecycle", () => {
  const outAfter = (burnTime: number): number => {
    const bed = new FuelBed(3, 7);
    bed.open(STEADY_FIRE);
    let out = Number.NaN;
    run(bed, 4 * burnTime, burnTime, false, (time) => {
      if (Number.isNaN(out) && bed.heat === 0) out = time;
    });
    return out;
  };
  const ratio = outAfter(480) / outAfter(120);
  expect(ratio).toBeGreaterThan(3.8);
  expect(ratio).toBeLessThan(4.2);
});

test("a fresh log smokes until it catches, then the fire flares", () => {
  const bed = new FuelBed(3, 7);
  bed.open(STEADY_FIRE);
  const before = { heat: bed.heat, smoke: bed.smoke };
  bed.addLog();
  // The emptiest slot took it: the 0.25 stub went into the coals.
  expect(bed.logs[2]?.mass).toBe(1);
  run(bed, 3, 240, true);
  expect(bed.smoke).toBeGreaterThan(before.smoke + 0.4);
  let peak = 0;
  run(bed, 60, 240, true, () => {
    peak = Math.max(peak, bed.heat);
  });
  expect(bed.smoke).toBeLessThan(0.3);
  expect(peak).toBeGreaterThan(before.heat * 1.1);
});

test("a log laid on a dead fire never catches", () => {
  const bed = new FuelBed(3, 7);
  bed.open([0, 0, 0]);
  bed.addLog();
  run(bed, 600, 240, false);
  expect(bed.logs.some((log) => log.mass === 1 && log.lit === 0)).toBe(true);
  expect(bed.heat).toBe(0);
});

test("a paused fire holds still, and the same fire opens every time", () => {
  const bed = new FuelBed(3, 7);
  bed.open(STEADY_FIRE);
  run(bed, 200, 240, true);
  const held = snapshot(bed);
  bed.step(0, 240, true);
  expect(snapshot(bed)).toEqual(held);
  bed.open(STEADY_FIRE);
  const reopened = new FuelBed(3, 7);
  reopened.open(STEADY_FIRE);
  run(bed, 500, 240, true);
  run(reopened, 500, 240, true);
  expect(snapshot(bed)).toEqual(snapshot(reopened));
});
