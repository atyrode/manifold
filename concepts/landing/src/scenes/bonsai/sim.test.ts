import { expect, test } from "bun:test";
import { effective } from "../../params.ts";
import type { SimFrame } from "../types.ts";
import { BONSAI_FIELD, BONSAI_ROWS } from "./geometry.ts";
import { bonsaiScene } from "./index.ts";

/** Values the sim uploads as uSim3 (the field rows hold each texel's sway in r and g). */
const DATA_LENGTH = BONSAI_FIELD.width * BONSAI_ROWS.total * 4;

/** Just enough WebGL2 for DataTexture: every upload of the data texture lands in `uploads`. */
function recordingGl(uploads: Float32Array[]): WebGL2RenderingContext {
  return new Proxy({} as Record<string | symbol, unknown>, {
    get(_, key) {
      if (key === "texSubImage2D") {
        return (...args: unknown[]) => {
          const data = args[8];
          if (data instanceof Float32Array && data.length === DATA_LENGTH) uploads.push(data.slice(0, BONSAI_FIELD.width * BONSAI_FIELD.height * 4));
        };
      }
      if (key === "createTexture") return () => ({});
      if (typeof key === "string" && /^[A-Z0-9_]+$/.test(key)) return 1;
      return () => undefined;
    },
  }) as unknown as WebGL2RenderingContext;
}

/** The largest pad deflection the sim hands the shader over `seconds` at 60 fps (after the first
 *  second), with the knobs `params` (raw, as in the URL) and an optional "now" gust at `gustAt`. */
function maxSway(params: Record<string, number>, seconds: number, gustAt?: number): number {
  const uploads: Float32Array[] = [];
  const factory = bonsaiScene.sim;
  if (!factory) throw new Error("bonsai has no sim");
  const sim = factory(recordingGl(uploads));
  const values = bonsaiScene.params.map((def) => effective(def, params));
  const triggers = new Array<number>(8).fill(-1e4);
  const fired = new Array<boolean>(8).fill(false);
  const pointer = { x: 0.5, y: 0.5, inside: false, down: false, pressed: false, released: false };
  const dt = 1 / 60;
  let largest = 0;
  for (let f = 0; f < seconds * 60; f++) {
    const time = f * dt;
    if (gustAt !== undefined && time >= gustAt && (triggers[0] ?? 0) < 0) triggers[0] = time;
    const frame: SimFrame = { dt: f === 0 ? 0 : dt, time, motionTime: time, motion: 1, width: 480, height: 270, aspect: 16 / 9, values, params, triggers, fired, pointer, passage: { enter: 1, exit: 0 } };
    uploads.length = 0;
    sim.frame(frame);
    const field = uploads[uploads.length - 1];
    if (!field) throw new Error("the sim uploaded no data texture");
    if (f < 60) continue;
    for (let i = 0; i < field.length; i += 4) largest = Math.max(largest, Math.abs(field[i] ?? 0), Math.abs(field[i + 1] ?? 0));
  }
  sim.dispose();
  return largest;
}

test("with the breeze off the pads hang still", () => {
  for (const species of [0, 1, 2]) expect(maxSway({ breeze: 0, species }, 20)).toBe(0);
});

test("a now gust still stirs the pads with the breeze off", () => {
  expect(maxSway({ breeze: 0 }, 14, 4)).toBeGreaterThan(5e-4);
});

test("below the gust floor the pads sway more as the breeze rises", () => {
  // Scheduled gusts start 20 s in, so these 15 s are the breeze's own waves.
  const sway = [0.02, 0.05, 0.08].map((amount) => maxSway({ breeze: 1, "breeze-amount": amount }, 15));
  expect(sway[0]).toBeGreaterThan(0);
  expect(sway[1]).toBeGreaterThan(sway[0] ?? 0);
  expect(sway[2]).toBeGreaterThan(sway[1] ?? 0);
});
