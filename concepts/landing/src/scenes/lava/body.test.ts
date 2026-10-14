import { expect, test } from "bun:test";
import { HeadlessSim, type HeadlessFrame } from "../../sims/headless.ts";
import { lavaScene } from "./index.ts";
import { LAVA_MAX } from "./sim.ts";

interface Flow {
  /** Separate blobs in the lamp (parcels within 1.4 radii of each other are one blob), per frame. */
  blobs: number;
  /** Parcels per rising blob above the heap. */
  risingSize: number;
  /** Relative speed of touching parcels of like temperature, over the parcels' mean speed. */
  slip: number;
  /** Mean parcel speed, glass units per second. */
  speed: number;
  /** The wax's body handed to the shader (uSim2 texel 2): metaball reach and teardrop stretch. */
  blend: number;
  stretch: number;
}

/** Lamp A over `seconds` of lamp time at this wax body, averaged over pours 0..4, read on the headless stand-in. */
function flow(viscosity: number, seconds: number): Flow {
  const totals = { blobs: 0, frames: 0, rising: 0, risingParcels: 0, slip: 0, pairs: 0, speed: 0, parcels: 0 };
  let blend = Number.NaN;
  let stretch = Number.NaN;
  for (let pour = 0; pour < 5; pour++) {
    const sim = new HeadlessSim(lavaScene);
    const frame: HeadlessFrame = { dt: 0.1, aspect: 16 / 9, height: 360, knobs: { viscosity, pour }, pointer: { inside: false } };
    for (let t = 0; t < seconds; t += 0.1) {
      sim.step(frame);
      const parcels = sim.upload(0).data;
      const state = sim.upload(2).data;
      blend = state[8] ?? Number.NaN;
      stretch = state[9] ?? Number.NaN;
      const wax: { x: number; y: number; r: number; t: number; vx: number; vy: number }[] = [];
      for (let i = 0; i < (state[0] ?? 0); i++) {
        const r = parcels[i * 4 + 2] ?? 0;
        if (r <= 0) continue;
        const v = (LAVA_MAX + i) * 4;
        wax.push({ x: parcels[i * 4] ?? 0, y: parcels[i * 4 + 1] ?? 0, r, t: parcels[i * 4 + 3] ?? 0, vx: parcels[v] ?? 0, vy: parcels[v + 1] ?? 0 });
      }
      const blob = wax.map((_, i) => i);
      const root = (i: number): number => {
        let at = i;
        while (blob[at] !== at) at = blob[at] ?? at;
        return at;
      };
      for (const [i, a] of wax.entries()) {
        totals.speed += Math.hypot(a.vx, a.vy);
        totals.parcels++;
        for (const [j, b] of wax.entries()) {
          if (j <= i || Math.hypot(a.x - b.x, a.y - b.y) >= 1.4 * (a.r + b.r)) continue;
          blob[root(i)] = root(j);
          if (Math.abs(a.t - b.t) < 0.08) {
            totals.slip += Math.hypot(a.vx - b.vx, a.vy - b.vy);
            totals.pairs++;
          }
        }
      }
      const members = new Map<number, number[]>();
      for (const i of wax.keys()) members.set(root(i), [...(members.get(root(i)) ?? []), i]);
      totals.blobs += members.size;
      totals.frames++;
      for (const group of members.values()) {
        const rise = group.reduce((sum, i) => sum + (wax[i]?.vy ?? 0), 0) / group.length;
        const height = group.reduce((sum, i) => sum + (wax[i]?.y ?? 0), 0) / group.length;
        if (rise > 0.01 && height > 0.25) {
          totals.rising++;
          totals.risingParcels += group.length;
        }
      }
    }
    sim.dispose();
  }
  const speed = totals.speed / totals.parcels;
  return {
    blobs: totals.blobs / totals.frames,
    risingSize: totals.risingParcels / totals.rising,
    slip: totals.slip / totals.pairs / speed,
    speed,
    blend,
    stretch,
  };
}

test("chunky wax moves in fewer, slower lumps; silky wax rises in smaller blobs that slip through each other", () => {
  const silky = flow(0, 90);
  const classic = flow(0.5, 90);
  const chunky = flow(1, 90);
  // Measured over pours 0..4 (silky / classic / chunky): blobs 4.02 / 3.80 / 3.15, rising size
  // 2.46 / 2.93 / 3.17 parcels, slip 0.59 / 0.57 / 0.42, speed 0.0327 / 0.0317 / 0.0276.
  expect(chunky.blobs).toBeLessThan(0.9 * classic.blobs);
  expect(chunky.slip).toBeLessThan(0.85 * classic.slip);
  expect(chunky.speed).toBeLessThan(0.93 * classic.speed);
  expect(silky.risingSize).toBeLessThan(0.92 * classic.risingSize);
  expect(silky.blobs).toBeGreaterThan(classic.blobs);
  // The shader merges silky wax smoothly and stretches its tails; chunky keeps its lumps and stays round.
  expect(classic.blend).toBe(1);
  expect(classic.stretch).toBe(1);
  expect(silky.blend).toBeGreaterThan(1.1);
  expect(silky.stretch).toBeGreaterThan(1.5);
  expect(chunky.blend).toBeLessThan(0.9);
  expect(chunky.stretch).toBeLessThan(0.5);
});
