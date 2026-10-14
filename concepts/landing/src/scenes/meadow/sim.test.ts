import { expect, test } from "bun:test";
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import type { SimFrame } from "../types.ts";
import { meadowScene } from "./index.ts";
import { MAX_SEEDS, MEADOW_FOCAL, MEADOW_GUST } from "./sim.ts";

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
 * Runs the real meadow simulation (textures go to a stand-in GL that keeps the last seed upload) and
 * follows the airborne seeds from sample to sample, summing their world-space motion over the ground
 * per depth band: x from the packed uv and depth through the level camera, z the depth itself.
 */
function seedMotion(wind: number): Record<string, Motion> {
  let upload: Float32Array | undefined;
  const gl = new Proxy({}, {
    get(_target, key) {
      if (key === "texSubImage2D") {
        return (...args: unknown[]) => {
          const data = args[8];
          if (args[4] === MAX_SEEDS && args[5] === 3 && data instanceof Float32Array) upload = data.slice();
        };
      }
      return typeof key === "string" && /^[A-Z0-9_]+$/.test(key) ? 1 : () => ({});
    },
  }) as unknown as WebGL2RenderingContext;
  const sim = meadowScene.sim?.(gl);
  if (!sim) throw new Error("meadow has no simulation");
  const knobs = { ...paramDefaults("meadow"), wind };
  const values = renderSettings(defaultsFor("meadow"), knobs).params;
  const pointer = { x: 0, y: 0, inside: false, down: false, pressed: false, released: false };
  const side = wind < 0 ? -1 : 1;
  const bands: Record<string, Motion> = {};
  let previous: Seen[] = [];
  for (let f = 1; f <= 120 * 60; f++) {
    const time = f * DT;
    const frame: SimFrame = {
      dt: DT, time, motionTime: time, motion: 1, width: Math.round(ROWS * ASPECT), height: ROWS, aspect: ASPECT,
      values, params: knobs, triggers: new Array<number>(8).fill(-1e4), fired: new Array<boolean>(8).fill(false),
      pointer, passage: { enter: 1, exit: 0 },
    };
    sim.frame(frame);
    if (f % SPAN !== 0 || !upload) continue;
    const seen: Seen[] = [];
    for (let n = 0; n < MAX_SEEDS; n++) {
      if ((upload[n * 4 + 2] ?? 0) <= 0) continue;
      seen.push({ u: upload[n * 4] ?? 0, y: upload[n * 4 + 1] ?? 0, z: upload[(MAX_SEEDS + n) * 4 + 1] ?? 0 });
    }
    for (const now of seen) {
      let match: Seen | undefined;
      let nearest = 0.02;
      for (const before of previous) {
        const d = Math.hypot((before.u - now.u) * ASPECT, before.y - now.y, (before.z - now.z) * 0.05);
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
  const gustAngle = (Math.atan2(MEADOW_GUST.dirZ, MEADOW_GUST.dirX) * 180) / Math.PI;
  for (const wind of [0.2, -0.6]) {
    const bands = seedMotion(wind);
    const all = bands.all;
    expect(all?.n ?? 0).toBeGreaterThan(2000);
    for (const [band, motion] of Object.entries(bands)) {
      if (motion.n < 200) continue;
      const angle = (Math.atan2(motion.away, motion.across) * 180) / Math.PI;
      const within = Math.abs(angle - gustAngle) < (band === "all" ? 2 : 3);
      expect({ wind, band, angle: Number(angle.toFixed(1)), gustAngle: Number(gustAngle.toFixed(1)), within }).toMatchObject({ wind, band, within: true });
    }
  }
});
