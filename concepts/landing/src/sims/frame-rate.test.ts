import { describe, expect, test } from "bun:test";
import { loadScene, sceneIds, type SceneId } from "../scenes/index.ts";
import type { LoadedScene } from "../scenes/types.ts";
import { HeadlessError, HeadlessSim } from "./headless.ts";

// The frame-rate contract (src/scenes/README.md, "Time and motion"): a seed plays the same at 60
// and at 144 Hz. Each scene's sim that runs headless runs from the same first frame at both rates,
// and at each of MOMENTS every texture it hands the shader must agree to within TOLERANCE of the
// texture's range. The first frame, FIRST, keeps those moments off every fixed step's boundary (a
// step of 1/n s, n under 337, is never due exactly then), where the rounding of sums of 1/60 and
// 1/144 could leave one rate a step behind the other.

const RATES = [60, 144] as const;
/** Seconds after the first frame at which both rates draw a frame and are compared. */
const MOMENTS = [1, 2] as const;
const FIRST = 1 / 337;
/** The largest difference allowed, as a share of a texture's range. */
const TOLERANCE = 0.01;

/** Sims that step on the GPU (GpuCompute), for which HeadlessGl stands in for nothing. */
const ON_THE_GPU: readonly SceneId[] = [
  "pond",
  "pearl",
  "petri",
  "physarum",
  "film",
  "incense",
  "delta",
  "ripple",
  "tidepool",
];

/** Knobs a sim does nothing without at its defaults. */
const KNOBS: Partial<Record<SceneId, Readonly<Record<string, number>>>> = {
  // The logs burn down only with `fuel` on.
  campfire: { fuel: 1 },
};

/** Sims that break the contract, in the textures (uSim slots) named or wholly, and why. */
const EXEMPT: Partial<
  Record<SceneId, { readonly slots?: readonly number[]; readonly reason: string }>
> = {
  bamboo: {
    slots: [2],
    reason:
      "its leaves let go by a chance drawn once a frame and fall over each frame's whole time, on a stream of their own so the gusts keep the seed",
  },
  dew: {
    slots: [1],
    reason:
      "its bins list what reaches into each (ids, not amounts): a drop a hair from where the other rate draws it lists in the next bin",
  },
  dunes: {
    reason:
      "the creeping sand goes up at most every UPLOAD_EVERY of wall time, so its last upload falls on another frame at each rate",
  },
  flock: {
    slots: [0],
    reason:
      "the specks' density field fades by TRAIL and takes each speck where it stands once a frame, so a 144 Hz frame lays more, closer samples of each streak",
  },
  garden: {
    slots: [0, 3],
    reason:
      "the rake and the gravel's slump step once a frame (a band of RELAX_ROWS rows), not on a fixed step",
  },
  sandtable: {
    slots: [0],
    reason:
      "the sand slumps a band of RELAX_ROWS rows a frame and goes up at most every UPLOAD_MS of wall time",
  },
};

type Uploads = readonly (Float32Array | Uint8Array | undefined)[];

/** What `id`'s sim hands the shader at each of MOMENTS, slot by slot, run at `rate` frames a second. */
function run(id: SceneId, scene: LoadedScene, rate: number): Uploads[] {
  const knobs = KNOBS[id] ?? {};
  const sim = new HeadlessSim(scene);
  try {
    sim.step({ dt: FIRST, knobs });
    const moments: Uploads[] = [];
    let frames = 0;
    for (const seconds of MOMENTS) {
      for (; frames < seconds * rate; frames++) sim.step({ dt: 1 / rate, knobs });
      moments.push(
        [0, 1, 2, 3].map((slot) =>
          sim.uploaded(slot) ? sim.upload(slot).data.slice() : undefined,
        ),
      );
    }
    return moments;
  } finally {
    sim.dispose();
  }
}

/** The largest difference between two uploads of one texture, as a share of their values' range. */
function drift(a: ArrayLike<number>, b: ArrayLike<number>): number {
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

const loaded = await Promise.all(sceneIds.map(async (id) => ({ id, scene: await loadScene(id) })));

describe("a seed plays the same at 60 and 144 frames a second", () => {
  for (const { id, scene } of loaded) {
    if (scene.sim === undefined) continue;
    if (ON_THE_GPU.includes(id)) {
      test(`${id} steps on the GPU, so it runs only in the browser`, () => {
        expect(() => run(id, scene, RATES[0])).toThrow(HeadlessError);
      });
      continue;
    }
    const exemption = EXEMPT[id];
    if (exemption !== undefined && exemption.slots === undefined) {
      test.skip(`${id}: ${exemption.reason}`, () => {});
      continue;
    }
    // Within 30 s: the countryside builds its land in its first frame, at each rate.
    test(
      id,
      () => {
        const [slow = [], fast = []] = RATES.map((rate) => run(id, scene, rate));
        const exempt = exemption?.slots ?? [];
        const compared: string[] = [];
        MOMENTS.forEach((seconds, moment) => {
          for (let slot = 0; slot < 4; slot++) {
            if (exempt.includes(slot)) continue;
            const a = slow[moment]?.[slot];
            const b = fast[moment]?.[slot];
            const at = `${id} uSim${slot} at ${seconds} s`;
            expect(b?.length, at).toBe(a?.length);
            if (a === undefined || b === undefined) continue;
            expect(drift(a, b), at).toBeLessThanOrEqual(TOLERANCE);
            compared.push(at);
          }
        });
        // Exemptions name textures the sim hands over, and leave something to compare.
        for (const slot of exempt) expect(slow.at(-1)?.[slot], `${id} uSim${slot}`).toBeDefined();
        expect(compared.length, `${id} hands the shader nothing to compare`).toBeGreaterThan(0);
      },
      30_000,
    );
  }
});
