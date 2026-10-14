import { expect, test } from "bun:test";
import { effective } from "../../params.ts";
import type { PointerState, SimFrame } from "../types.ts";
import { forestScene } from "./index.ts";
import { FOREST_SPIRITS } from "./sim.ts";

/** A WebGL2 stand-in that keeps the last data uploaded into each texture: the spirits' row is what the shader reads. */
function recordingGl(): { gl: WebGL2RenderingContext; uploads: Map<object, Float32Array> } {
  let bound: object | undefined;
  const uploads = new Map<object, Float32Array>();
  const gl = new Proxy({}, {
    get(_, key) {
      if (typeof key === "string" && /^[A-Z0-9_]+$/.test(key)) return key.length;
      if (key === "createTexture") return () => ({});
      if (key === "bindTexture") return (_target: number, texture: object) => (bound = texture);
      if (key === "texSubImage2D") {
        return (...args: unknown[]) => {
          if (bound && args[8] instanceof Float32Array) uploads.set(bound, args[8].slice());
        };
      }
      return () => undefined;
    },
  });
  return { gl: gl as WebGL2RenderingContext, uploads };
}

interface SpiritRow {
  x: number;
  y: number;
  z: number;
  alpha: number;
  yaw: number;
  sink: number;
  size: number;
}

/**
 * The forest at night with `shy` spirits: the pointer comes up just right of a seated spirit's head
 * for a second, then leaves. Returns that spirit's row as the shader sees it, near and after.
 */
function approach(shy: number): { near: SpiritRow; away: SpiritRow[] } {
  const { gl, uploads } = recordingGl();
  const knobs: Record<string, number> = { shy };
  const values = forestScene.params.map((def) => effective(def, knobs));
  const sim = forestScene.sim?.(gl);
  if (!sim) throw new Error("forest has no sim");
  const aspect = 16 / 9;
  const pointer: PointerState = { x: 0.5, y: 0.5, inside: false, down: false, pressed: false, released: false };
  let time = 0;
  let texture: object | undefined;
  const step = (): void => {
    const dt = 1 / 60;
    time += dt;
    const frame: SimFrame = {
      dt, time, motionTime: time, motion: 1, width: 640, height: 360, aspect, values, params: knobs,
      triggers: new Array<number>(8).fill(-1e4), fired: new Array<boolean>(8).fill(false), pointer, passage: { enter: 1, exit: 0 },
    };
    texture = sim.frame(frame)[0] ?? undefined;
  };
  const row = (i: number): SpiritRow => {
    const data = texture ? uploads.get(texture) : undefined;
    if (!data) throw new Error("no spirits uploaded");
    const o = i * 12;
    return { x: data[o] ?? 0, y: data[o + 1] ?? 0, z: data[o + 2] ?? 1, alpha: data[o + 3] ?? 0, yaw: data[o + 5] ?? 0, sink: data[o + 8] ?? 0, size: data[o + 9] ?? 0 };
  };
  step();
  const seated = Array.from({ length: FOREST_SPIRITS }, (_, i) => i).find((i) => row(i).alpha >= 1 && row(i).sink === 0);
  if (seated === undefined) throw new Error("no spirit seated at night");
  const at = row(seated);
  pointer.inside = true;
  pointer.x = (at.x + 0.05) / aspect + 0.5;
  pointer.y = at.y + (0.75 * at.size) / at.z;
  for (let n = 0; n < 60; n++) step();
  const near = row(seated);
  pointer.inside = false;
  const away: SpiritRow[] = [];
  for (let second = 1; second <= 6; second++) {
    for (let n = 0; n < 60; n++) step();
    away.push(row(seated));
  }
  return { near, away };
}

test("a shy spirit ducks into the moss facing away from the pointer, and comes back up after it has gone", () => {
  const { near, away } = approach(1);
  // Deeper than any spirit rising out of the moss (sink <= 1): down to its eyes.
  expect(near.sink).toBeGreaterThan(1.1);
  expect(near.yaw).toBeLessThan(-0.3);
  expect(away[0]?.sink ?? 0).toBeGreaterThan(1.1);
  const last = away[away.length - 1];
  expect(last?.alpha).toBe(1);
  expect(last?.sink ?? 1).toBeLessThan(0.1);
});

test("with no shy spirits they stay up and turn to look at the pointer", () => {
  const { near, away } = approach(0);
  expect(near.sink).toBe(0);
  expect(near.yaw).toBeGreaterThan(0.3);
  for (const row of away) expect(row.sink).toBe(0);
});
