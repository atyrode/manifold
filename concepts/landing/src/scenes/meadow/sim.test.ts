import { expect, test } from "bun:test";
import { ATLAS_WIDTH } from "../../composer/caps.ts";
import { GUST } from "../../composer/gust.ts";
import { allocate, ATLAS_SLOT } from "../../composer/sim.ts";
import { HeadlessSim, type HeadlessFrame } from "../../sims/headless.ts";
import { loadScene } from "../index.ts";
import { MEADOW_FOCAL } from "./constants.ts";
import { meadowComposed } from "./index.ts";
import { MAX_SEEDS } from "./sim.ts";

const meadowScene = await loadScene("meadow");
/** The dandelions' first row in the records atlas with the meadow's own layers on screen. */
const SEED_ROW =
  allocate(meadowComposed.place(new Set(meadowComposed.preset.layers)).layers.map((p) => p.layer))
    .rows["dandelions"]?.base ?? 0;

const ASPECT = 16 / 9;
const ROWS = 540;
const DT = 1 / 60;
/** Frames between the samples a seed's motion is measured over. */
const SPAN = 8;

interface Seen {
  u: number;
  y: number;
  z: number;
}

interface Motion {
  n: number;
  /** Summed world displacement downwind across the view, and away from the eye. */
  across: number;
  away: number;
}

/**
 * Runs the real meadow simulation on the headless stand-in and follows the airborne seeds (the
 * dandelions' rows of the records atlas, as last uploaded) from sample to sample, summing their
 * world-space motion over the ground per depth band: x from the packed uv and depth through the
 * level camera, z the depth itself.
 */
function seedMotion(wind: number): Record<string, Motion> {
  const sim = new HeadlessSim(meadowScene);
  const frame: HeadlessFrame = {
    dt: DT,
    aspect: ASPECT,
    height: ROWS,
    knobs: { wind },
    pointer: { x: 0, y: 0, inside: false },
  };
  const side = wind < 0 ? -1 : 1;
  const bands: Record<string, Motion> = {};
  let previous: Seen[] = [];
  for (let f = 1; f <= 120 * 60; f++) {
    sim.step(frame);
    // Until its time-budgeted warm-up is done the sim hands over seeds it has not sent yet.
    if (f % SPAN !== 0 || !sim.uploaded(ATLAS_SLOT)) continue;
    const upload = sim.upload(ATLAS_SLOT).data;
    const row = (r: number, n: number, k: number) =>
      upload[((SEED_ROW + r) * ATLAS_WIDTH + n) * 4 + k] ?? 0;
    const seen: Seen[] = [];
    for (let n = 0; n < MAX_SEEDS; n++) {
      if (row(0, n, 2) <= 0) continue;
      seen.push({ u: row(0, n, 0), y: row(0, n, 1), z: row(1, n, 1) });
    }
    for (const now of seen) {
      let match: Seen | undefined;
      let nearest = 0.02;
      for (const before of previous) {
        const d = Math.hypot(
          (before.u - now.u) * ASPECT,
          before.y - now.y,
          (before.z - now.z) * 0.05,
        );
        if (d < nearest) {
          nearest = d;
          match = before;
        }
      }
      if (!match) continue;
      const worldX = (s: Seen): number => ((s.u - 0.5) * ASPECT * s.z) / MEADOW_FOCAL;
      const band = now.z < 3.5 ? "near" : now.z < 5 ? "middle" : "far";
      for (const key of [band, "all"]) {
        const motion = bands[key] ?? { n: 0, across: 0, away: 0 };
        motion.n++;
        motion.across += side * (worldX(now) - worldX(match));
        motion.away += now.z - match.z;
        bands[key] = motion;
      }
    }
    previous = seen;
  }
  sim.dispose();
  return bands;
}

// The gust field blows along (±dirX, dirZ): across the view and away from it. The seeds once drifted
// in screen units and receded at a fixed world rate, so far seeds ran ~9-13° flatter than the gusts
// (and those at the frame's upwind edge ~23° steeper); now the air carries them along it in the world.
test("airborne seeds travel over the ground along the shared gust direction at every depth, either way the wind blows", () => {
  const gustAngle = (Math.atan2(GUST.dirZ, GUST.dirX) * 180) / Math.PI;
  for (const wind of [0.2, -0.6]) {
    const bands = seedMotion(wind);
    const all = bands.all;
    expect(all?.n ?? 0).toBeGreaterThan(2000);
    for (const [band, motion] of Object.entries(bands)) {
      if (motion.n < 200) continue;
      const angle = (Math.atan2(motion.away, motion.across) * 180) / Math.PI;
      const within = Math.abs(angle - gustAngle) < (band === "all" ? 2 : 3);
      expect({
        wind,
        band,
        angle: Number(angle.toFixed(1)),
        gustAngle: Number(gustAngle.toFixed(1)),
        within,
      }).toMatchObject({ wind, band, within: true });
    }
  }
});
