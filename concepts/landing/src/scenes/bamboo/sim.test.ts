import { expect, test } from "bun:test";
import { SimHarness } from "../../sims/harness.ts";
import { bambooScene } from "./index.ts";
import { BAMBOO_DEVICE_DEPTH, BAMBOO_MAX_LEAVES } from "./sim.ts";

const STEP = 1 / 60;

interface Knock {
  /** Scene seconds. */
  at: number;
  strength: number;
  /** Leaves above the basin that let go on the very frame of the knock. */
  startled: number;
}

/** Every knock of the tube on its stone over `seconds`, read from the textures the shader samples. */
function knocks(query: string, seconds: number): Knock[] {
  const run = new SimHarness(bambooScene, query);
  const out: Knock[] = [];
  let since = 60;
  while (run.time < seconds) {
    const [, device, leaves] = run.step(STEP);
    if (device === undefined || leaves === undefined) throw new Error("bamboo: the sim bound no device or leaf texture");
    // Device texel 1: seconds since the last knock (60 before the first), its strength.
    const age = device[4] ?? 60;
    if (age < since) {
      let startled = 0;
      for (let i = 0; i < BAMBOO_MAX_LEAVES; i++) {
        // A falling leaf at the water clock's depth (as the float texture holds it), still fading
        // in: it has only just let go.
        const row = i * 8;
        if (leaves[row + 7] === 1 && leaves[row + 5] === Math.fround(BAMBOO_DEVICE_DEPTH) && (leaves[row + 6] ?? 1) < 0.05) startled++;
      }
      out.push({ at: run.time, strength: device[5] ?? 0, startled });
    }
    since = age;
  }
  run.dispose();
  return out;
}

/** The knocks that end a swing back, without the bounces that follow them within a second. */
function swings(list: readonly Knock[]): Knock[] {
  return list.filter((knock, i) => i === 0 || knock.at - (list[i - 1]?.at ?? Number.NEGATIVE_INFINITY) > 1);
}

test("on bare stone the tube clacks hard, bounces, and its knock startles leaves above the basin", () => {
  const all = knocks("leaves-amount=1", 200);
  const main = swings(all);
  expect(main.length).toBeGreaterThanOrEqual(5);
  for (const knock of main) expect(knock.strength).toBeGreaterThan(0.6);
  // Each swing's clack is followed within a second by the bounce's smaller one.
  for (const knock of main.filter((m) => m.at < 199)) {
    const bounce = all[all.indexOf(knock) + 1];
    expect(bounce === undefined ? Number.POSITIVE_INFINITY : bounce.at - knock.at).toBeLessThan(1);
    expect(bounce?.strength ?? 1).toBeLessThan(knock.strength);
  }
  expect(main.reduce((sum, knock) => sum + knock.startled, 0)).toBeGreaterThan(0);
});

test("a quiet clock eases onto its moss: a soft knock on the same beat, no bounce, no startled leaf", () => {
  const bare = swings(knocks("leaves-amount=1", 200));
  const quiet = knocks("knock=0&leaves-amount=1", 200);
  // It still keeps time: one knock per swing, at the bare stone's moments.
  expect(quiet.length).toBe(bare.length);
  quiet.forEach((knock, i) => {
    expect(Math.abs(knock.at - (bare[i]?.at ?? Number.NaN))).toBeLessThan(0.5);
    expect(knock.strength).toBeGreaterThan(0);
    expect(knock.strength).toBeLessThan(0.3);
    expect(knock.startled).toBe(0);
  });
});
