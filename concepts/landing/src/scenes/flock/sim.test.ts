import { expect, spyOn, test } from "bun:test";
import { ATLAS_WIDTH } from "../../composer/caps.ts";
import { featureKey, sceneFeatures } from "../../shaders/index.ts";
import { Boids, type BoidRules } from "../../sims/boids.ts";
import { HeadlessSim } from "../../sims/headless.ts";
import type { Random } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import { loadScene } from "../index.ts";
import type { LoadedScene } from "../types.ts";
import { FLOCK_SIZES } from "./constants.ts";
import { boidNear, FLOCK_FEAR_RADIUS } from "./sim.ts";

const flockScene = await loadScene("flock");

const EMERGENT = { emergent: 1, "emergent-amount": 7 };

/**
 * Where the composed sim hands over the murmuration's data: its field 0 in the first field slot (the
 * roost has none), its state in the first texels of its row, the atlas's first after the composer's.
 */
const FIELD_SLOT = 2;
const ATLAS_SLOT = 1;
const STATE_AT = ATLAS_WIDTH * 4;

/** The density field (R birds per texel, G rolled) after a frame. */
const density = (sim: HeadlessSim): Float32Array =>
  Float32Array.from(sim.upload(FIELD_SLOT).data);

/** How much the field changed between two frames (L1 of the birds channel). */
function change(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let k = 0; k < a.length; k += 2) sum += Math.abs((a[k] ?? 0) - (b[k] ?? 0));
  return sum;
}

/** Total birds and rolled birds in the field. */
function totals(field: Float32Array): { birds: number; rolled: number } {
  let birds = 0;
  let rolled = 0;
  for (let k = 0; k < field.length; k += 2) {
    birds += field[k] ?? 0;
    rolled += field[k + 1] ?? 0;
  }
  return { birds, rolled };
}

/** The birds' mean height in the field (screen heights from the frame's foot), and how many there are. */
function heightOf(sim: HeadlessSim): { height: number; birds: number } {
  const { width, height, data } = sim.upload(FIELD_SLOT);
  let birds = 0;
  let sum = 0;
  for (let k = 0; k < width * height; k++) {
    const r = data[2 * k] ?? 0;
    birds += r;
    sum += r * (Math.floor(k / width) + 0.5);
  }
  return { height: sum / Math.max(birds, 1e-9) / height, birds };
}

test("switched off, the murmuration plays its own exit with its birds: they pour down to roost", () => {
  // The renderer keeps drawing the program the flock is in through the layer's exit
  // (SimFrame.features), so the composed sim plays it on the layer's own clock.
  const drawn = featureKey(sceneFeatures(flockScene));
  const factory = flockScene.sim;
  if (factory === undefined) throw new Error("the murmuration has a sim");
  const scene: LoadedScene = {
    ...flockScene,
    sim: (gl) => {
      const sim = factory(gl);
      return {
        frame: (frame) => sim.frame({ ...frame, features: drawn }),
        dispose: () => sim.dispose(),
      };
    },
  };
  const sim = new HeadlessSim(scene);
  for (let f = 0; f < 240; f++) sim.step();
  const flying = heightOf(sim);
  // 0.8 s into the 0.9 s exit: the birds are still all there, most of the way down.
  for (let f = 0; f < 48; f++) sim.step({ knobs: { murmuration: 0 } });
  const leaving = heightOf(sim);
  expect(leaving.birds).toBeGreaterThan(0.8 * flying.birds);
  expect(leaving.height).toBeLessThan(flying.height - 0.15);
});

test("with emergent flight off, whatever its neighbours, the flock flies its authored sheet", () => {
  const plain = new HeadlessSim(flockScene);
  const off = new HeadlessSim(flockScene);
  for (let f = 0; f < 240; f++) {
    off.step({ knobs: { emergent: 0, "emergent-amount": 12 } });
    plain.step();
    if (f % 30 === 29) expect(density(off)).toEqual(density(plain));
  }
});

test("emergent flight is its own, the same every time from the same start", () => {
  const sheet = new HeadlessSim(flockScene);
  const a = new HeadlessSim(flockScene);
  const b = new HeadlessSim(flockScene);
  for (let f = 0; f < 180; f++) {
    sheet.step();
    a.step({ knobs: EMERGENT });
    b.step({ knobs: EMERGENT });
  }
  expect(density(a)).toEqual(density(b));
  expect(change(density(a), density(sheet))).toBeGreaterThan(0.5 * totals(density(sheet)).birds);
});

test("switching flight either way hands the birds over where they are, without a jump", () => {
  const sim = new HeadlessSim(flockScene);
  const steps: number[] = [];
  let before = density(sim.step());
  for (let f = 1; f < 600; f++) {
    const knobs = f >= 200 && f < 400 ? EMERGENT : {};
    const after = density(sim.step({ knobs }));
    steps.push(change(after, before));
    before = after;
  }
  // A bird that jumped would leave its old texels and fill new ones at once: about twice the birds a
  // frame's trail lays down, many times an ordinary frame's change.
  const ordinary = (from: number): number => Math.max(...steps.slice(from - 60, from - 1));
  for (const at of [199, 399]) {
    for (const step of steps.slice(at, at + 3)) expect(step).toBeLessThan(1.5 * ordinary(at));
  }
});

// Each flight is 900 fixed steps (15 s) of the boids, most of it their neighbour search: about 2 s
// for 1500 birds and 5 s for 5000 on a busy machine, past bun's 5 s default. The length is what the
// test is for: 1500 birds cruising three times too fast still have 85% of the flock in frame at 9 s
// and fall short only after that. So the flights keep their length and get the time they take, with
// room for a loaded machine.
const FLIGHT_TIMEOUT = 30_000;

for (const birds of [1500, 5000]) {
  test(
    `emergent birds keep to the sky over the frame, all of them drawn (${birds} birds)`,
    () => {
      const sim = new HeadlessSim(flockScene);
      let least = Number.POSITIVE_INFINITY;
      for (let f = 0; f < 900; f++) {
        sim.step({ knobs: { ...EMERGENT, "murmuration-amount": birds } });
        if (f >= 300 && f % 30 === 0) least = Math.min(least, totals(density(sim)).birds);
      }
      // Each bird lays down about its own ink once the trail has filled: none of them off the frame.
      expect(least).toBeGreaterThan(0.85 * birds);
    },
    { timeout: FLIGHT_TIMEOUT },
  );
}

test("the falcon's strike starts a startle that runs through the boids and dies away", () => {
  const struck = new HeadlessSim(flockScene);
  const calm = new HeadlessSim(flockScene);
  for (let f = 0; f < 240; f++) {
    struck.step({ knobs: EMERGENT });
    calm.step({ knobs: EMERGENT });
  }
  const rolling = (sim: HeadlessSim, now: string[] = []): number => {
    const { birds, rolled } = totals(density(sim.step({ knobs: EMERGENT, now })));
    return rolled / birds;
  };
  let peak = rolling(struck, ["predator"]);
  let calmPeak = rolling(calm);
  for (let f = 0; f < 150; f++) {
    peak = Math.max(peak, rolling(struck));
    calmPeak = Math.max(calmPeak, rolling(calm));
  }
  expect(peak).toBeGreaterThan(calmPeak + 0.1);
  let after = 0;
  for (let f = 0; f < 240; f++) after = rolling(struck);
  expect(after).toBeLessThan(0.02);
});

test(
  "emergent birds flee the falcon wherever it is seen passing through them, and only there",
  () => {
    const aspect = 16 / 9;
    const sim = new HeadlessSim(flockScene);
    for (let f = 0; f < 240; f++) sim.step({ knobs: EMERGENT, aspect });
    // Each boid step with the falcon out: where every bird is drawn as the step begins (a frame of
    // 1/60 s is one step, and shows the birds there), and whether the falcon's threat holds it, so
    // that it flees and is startled (sims/boids.ts: within the radius of the threat's point, or of
    // its line when it has an axis).
    let birds = 0;
    let threatened = false;
    const drawnX = new Float64Array(Math.max(...FLOCK_SIZES));
    const drawnY = new Float64Array(drawnX.length);
    const held = new Uint8Array(drawnX.length);
    const fly = Boids.prototype.step;
    const spy = spyOn(Boids.prototype, "step").mockImplementation(function (
      this: Boids,
      dt: number,
      rules: BoidRules,
      random: Random,
    ) {
      birds = this.count;
      threatened = rules.threatRadius > 0;
      if (threatened) {
        const { threat, threatAxis: axis } = rules;
        for (let i = 0; i < birds; i++) {
          const x = this.x[i] ?? 0;
          const y = this.y[i] ?? 0;
          const z = this.z[i] ?? 0;
          const near = boidNear(z);
          drawnX[i] = aspect / 2 + (x - aspect / 2) * near;
          drawnY[i] = 0.5 + (y - 0.5) * near;
          const dx = x - threat.x;
          const dy = y - threat.y;
          const dz = z - threat.z;
          const along = dx * axis.x + dy * axis.y + dz * axis.z;
          const d = Math.hypot(dx - axis.x * along, dy - axis.y * along, dz - axis.z * along);
          held[i] = d < rules.threatRadius ? 1 : 0;
        }
      }
      fly.call(this, dt, rules, random);
    });
    let inReach = 0;
    let fled = 0;
    let holds = 0;
    let unseen = 0;
    try {
      // Three strikes, each sent "now" and given time to come and go.
      for (let f = 0; f < 450; f++) {
        threatened = false;
        sim.step({ knobs: EMERGENT, aspect, now: f % 150 === 0 ? ["predator"] : [] });
        if (!threatened) continue;
        // The falcon where the frame draws it (the murmuration's row, texel 0: uv x, y).
        const state = sim.upload(ATLAS_SLOT).data;
        const fx = (state[STATE_AT] ?? 0) * aspect;
        const fy = state[STATE_AT + 1] ?? 0;
        for (let i = 0; i < birds; i++) {
          const drawn =
            Math.hypot((drawnX[i] ?? 0) - fx, (drawnY[i] ?? 0) - fy) < FLOCK_FEAR_RADIUS;
          const h = held[i] ?? 0;
          if (drawn) {
            inReach++;
            fled += h;
          }
          holds += h;
          if (h && !drawn) unseen++;
        }
      }
    } finally {
      spy.mockRestore();
    }
    // The strikes did pass through the flock. The birds drawn within the falcon's reach on screen
    // fled, whatever their depth (a sphere about it on their plane holds about 60% of them: the
    // plane is seen aslant, so the birds under it on screen spread deeper than its reach), and few
    // of the birds it held were drawn beyond that reach.
    expect(inReach).toBeGreaterThan(10_000);
    expect(fled / inReach).toBeGreaterThanOrEqual(0.9);
    expect(unseen / holds).toBeLessThanOrEqual(0.15);
  },
  { timeout: FLIGHT_TIMEOUT },
);

test("the density texture holds the field, but for texels too faint for a half float to tell from 0", () => {
  // Each paint uploads only the box it changed; outside it the texture keeps an older paint's values,
  // which must be ones the rg16f texture holds as 0, as it does the field's own there now. Through a
  // strike, a new frame shape (a new field), the layer switched off and on (the flock growing
  // afresh), and emergent flight. The composer's atlas goes up by uploadRegion too: a field upload
  // is one of the field's size.
  const faint = 2 ** -25; // half the smallest half float: anything under it is held as 0
  const region = spyOn(DataTexture.prototype, "uploadRegion");
  const sim = new HeadlessSim(flockScene);
  let checked = 0;
  let wrong = 0;
  try {
    for (let f = 0; f < 600; f++) {
      const calls = region.mock.calls.length;
      sim.step({
        aspect: f < 200 ? 16 / 9 : 4 / 3,
        now: f % 150 === 75 ? ["predator"] : [],
        knobs: f >= 300 && f < 320 ? { murmuration: 0 } : f >= 400 ? EMERGENT : {},
      });
      if (!sim.uploaded(FIELD_SLOT)) continue;
      const texture = sim.upload(FIELD_SLOT);
      const size = texture.width * texture.height * 2;
      const field = region.mock.calls
        .slice(calls)
        .map(([data]) => data)
        .findLast((data) => data.length === size);
      if (field === undefined) continue;
      const shown = texture.data;
      checked++;
      for (let k = 0; k < field.length; k++) {
        const a = field[k] ?? 0;
        const b = shown[k] ?? 0;
        if (a !== b && (Math.abs(a) >= faint || Math.abs(b) >= faint)) wrong++;
      }
    }
  } finally {
    region.mockRestore();
  }
  expect(checked).toBeGreaterThan(500);
  expect(wrong).toBe(0);
});
