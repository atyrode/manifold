import { expect, test } from "bun:test";
import { HeadlessSim } from "../../sims/headless.ts";
import { ferroScene } from "./index.ts";

/** A spike stands where its height (uSim0 r) is past this: well above a settled spring's ringing. */
const STANDING = 0.01;

interface Crown {
  /** Texels whose spikes stand. */
  standing: number;
  /** The lowest standing spike. */
  lowest: number;
}

/** The crown after holding the field (breath off, the magnet still) at `strength` for three seconds. */
function hold(sim: HeadlessSim, strength: number, exit = 0): Crown {
  let field: Float32Array = new Float32Array();
  for (let i = 0; i < 30; i++) {
    const knobs = { strength, breath: 0, drift: 0, follow: 0 };
    const data = sim.step({ dt: 0.1, knobs, passage: { exit } }).upload(0).data;
    if (data instanceof Float32Array) field = data;
  }
  let standing = 0;
  let lowest = Infinity;
  for (let k = 0; k < field.length; k += 4) {
    const height = field[k] ?? 0;
    if (height <= STANDING) continue;
    standing++;
    lowest = Math.min(lowest, height);
  }
  return { standing, lowest };
}

test("the crown is subcritical: spikes pop up late on a rising field and linger on a falling one", () => {
  const sim = new HeadlessSim(ferroScene);
  // Strengths where the crown's rim lies inside the pool; past them the crown fills it.
  const strengths = [0, 0.1, 0.2, 0.3, 0.4];
  const rising = strengths.map((strength) => hold(sim, strength));
  const top = hold(sim, 1);
  const falling = strengths
    .toReversed()
    .map((strength) => hold(sim, strength))
    .toReversed();
  // Measured: rising 804..2284 texels, falling 216..280 more at each strength; without the latch
  // the two agree to within the pool's slosh (±20).
  strengths.forEach((_, i) => {
    expect(falling[i]?.standing).toBeGreaterThan((rising[i]?.standing ?? 0) + 100);
  });
  expect(top.standing).toBeGreaterThan(falling.at(-1)?.standing ?? Infinity);
  // On the way up a patch either lies flat or stands at once to a finite height (measured 0.091,
  // the jump, against 0.01 for spikes growing from nothing); on the way down they sink lower
  // before they drop.
  for (const crown of rising.slice(0, 3)) expect(crown.lowest).toBeGreaterThan(0.06);
  expect(falling[0]?.lowest).toBeLessThan(0.06);
  // Below the lower threshold the latch lets go: as the exit takes the field away, every spike falls.
  expect(hold(sim, 0, 1).standing).toBe(0);
  sim.dispose();
});
