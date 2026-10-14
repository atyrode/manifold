import { expect, test } from "bun:test";
import { effective } from "../../params.ts";
import type { SimFrame } from "../types.ts";
import { lavaScene } from "./index.ts";
import { LAVA_MAX } from "./sim.ts";

/** A GL that keeps the last image uploaded to each texture: the sim's real output, without a GPU. */
function recordingGl(): { gl: WebGL2RenderingContext; uploads: Map<object, Float32Array> } {
  const uploads = new Map<object, Float32Array>();
  let bound: object | undefined;
  const gl = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "createTexture") return () => ({});
        if (prop === "bindTexture") return (_slot: unknown, texture: object) => (bound = texture);
        if (prop === "texSubImage2D") {
          return (...args: unknown[]) => {
            if (bound !== undefined && args[8] instanceof Float32Array) uploads.set(bound, Float32Array.from(args[8]));
          };
        }
        return () => undefined;
      },
    },
  ) as WebGL2RenderingContext;
  return { gl, uploads };
}

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

/** Lamp A over `seconds` of lamp time at this wax body, averaged over pours 0..4. */
function flow(viscosity: number, seconds: number): Flow {
  const totals = { blobs: 0, frames: 0, rising: 0, risingParcels: 0, slip: 0, pairs: 0, speed: 0, parcels: 0 };
  let blend = Number.NaN;
  let stretch = Number.NaN;
  for (let pour = 0; pour < 5; pour++) {
    const { gl, uploads } = recordingGl();
    const sim = lavaScene.sim?.(gl);
    if (sim === undefined) throw new Error("lava has no sim");
    const raw = { viscosity, pour };
    const frame: SimFrame = {
      dt: 0.1,
      time: 0,
      motionTime: 0,
      motion: 1,
      width: 640,
      height: 360,
      aspect: 16 / 9,
      values: lavaScene.params.map((def) => effective(def, raw)),
      params: raw,
      triggers: Array.from({ length: 8 }, () => -1e4),
      fired: Array.from({ length: 8 }, () => false),
      pointer: { x: 0.5, y: 0.5, inside: false, down: false, pressed: false, released: false },
      passage: { enter: 1, exit: 0 },
    };
    for (let t = 0; t < seconds; t += frame.dt) {
      const textures = sim.frame(frame);
      const parcels = uploads.get(textures[0] ?? {});
      const state = uploads.get(textures[2] ?? {});
      if (parcels === undefined || state === undefined) throw new Error("lava uploaded no parcels or state");
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
