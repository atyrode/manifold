import { expect, test } from "bun:test";
import { effective } from "../params.ts";
import { barScene } from "../scenes/bar/index.ts";
import { marbleScene } from "../scenes/marble/index.ts";
import type { SceneDef, SimFrame } from "../scenes/types.ts";
import { paramDefaults } from "../state.ts";
import { HeadlessError, HeadlessGl, HeadlessSim } from "./headless.ts";
import { DataTexture } from "./texture.ts";

test("the stand-in keeps each texture's size and a copy of its last whole upload, and nothing else", () => {
  const headless = new HeadlessGl();
  const texture = new DataTexture(headless.gl, { width: 2, height: 1, format: "rg16f" });
  expect(() => headless.upload(texture.texture)).toThrow(HeadlessError);
  const data = new Float32Array([1, 2, 3, 4]);
  texture.upload(data);
  const kept = headless.upload(texture.texture);
  data[0] = 9;
  expect(kept).toEqual({ width: 2, height: 1, data: new Float32Array([1, 2, 3, 4]) });
  // The same array until the next upload, so a test can tell when a sim sends again.
  expect(headless.upload(texture.texture).data).toBe(kept.data);
  texture.upload(data);
  expect(headless.upload(texture.texture).data[0]).toBe(9);
  expect(kept.data[0]).toBe(1);
  // Resized, its contents are undefined until the next upload.
  texture.resize(1, 1);
  expect(() => headless.upload(texture.texture)).toThrow(HeadlessError);
  expect(() => headless.gl.getExtension("EXT_color_buffer_float")).toThrow("gl.getExtension");
});

test("frames carry the knobs over the scene's defaults, and a 'now' fires on one frame and keeps its stamp", () => {
  const frames: SimFrame[] = [];
  const scene: SceneDef = {
    ...barScene,
    sim: (gl) => {
      const texture = new DataTexture(gl, { width: 1, height: 1, format: "r8" });
      return {
        frame: (frame) => {
          frames.push(structuredClone(frame));
          texture.upload(new Uint8Array([frames.length]));
          return [texture.texture, undefined];
        },
        dispose: () => texture.dispose(),
      };
    },
  };
  const slot = barScene.params.find((def) => def.key === "night")?.trigger ?? -1;
  const sim = new HeadlessSim(scene);
  // As in the renderer, a sim's first frame reports no presses.
  sim.step({ now: ["night"] });
  sim.step({ dt: 0.5, knobs: { patrons: 2, night: 1.5 }, now: ["night"] });
  sim.step({ dt: 0.5 });
  expect(frames.map((frame) => frame.fired[slot])).toEqual([false, true, false]);
  expect(frames.map((frame) => frame.triggers[slot])).toEqual([0, 1 / 60, 1 / 60]);
  const [, second] = frames;
  // The given knobs as given, past the slider's end too, and every other at its default.
  const knobs = { ...paramDefaults("bar"), patrons: 2, night: 1.5 };
  expect(second?.params).toEqual(knobs);
  expect(second?.values).toEqual(barScene.params.map((def) => effective(def, knobs)));
  expect(second).toMatchObject({
    time: 1 / 60 + 0.5,
    motionTime: 1 / 60 + 0.5,
    width: 960,
    height: 540,
  });
  // The wall clock moves on with the frames' time; the budget never runs out.
  expect(second?.now).toBeCloseTo((1 / 60 + 0.5) * 1000, 9);
  expect(second?.budget).toBe(Infinity);
  expect(sim.upload(0).data[0]).toBe(3);
  expect(sim.uploaded(0)).toBe(true);
  expect(() => sim.upload(1)).toThrow(HeadlessError);
  expect(() => new HeadlessSim(scene, new HeadlessGl().gl).step()).toThrow(HeadlessError);
});

test("marble runs headless: its ink canvas is stood in for, and goes up as a premultiplied image", () => {
  // bun has no OffscreenCanvas (HeadlessSim stands HeadlessCanvas in for it), and marble sets
  // UNPACK_PREMULTIPLY_ALPHA_WEBGL around each upload of its canvas.
  const sim = new HeadlessSim(marbleScene);
  for (let f = 0; f < 360; f++) {
    // Six seconds of the tray, with a drag across it in the middle second.
    const down = f >= 150 && f < 210;
    const x = 0.3 + Math.max(0, Math.min(60, f - 150)) / 150;
    sim.step({ pointer: { x, y: 0.5, down, pressed: f === 150, released: f === 210 } });
  }
  const state = sim.upload(1);
  expect([state.width, state.height]).toEqual([2, 1]);
  expect([...state.data].every(Number.isFinite)).toBe(true);
  sim.dispose();
});

test("half-float bits go up as HALF_FLOAT and are kept as the floats they hold", () => {
  const headless = new HeadlessGl();
  const texture = new DataTexture(headless.gl, { width: 2, height: 2, format: "r16f" });
  // 1, -2, 0.5 and the smallest subnormal, 2^-24.
  texture.upload(new Uint16Array([0x3c00, 0xc000, 0x3800, 0x0001]));
  expect(headless.upload(texture.texture).data).toEqual(new Float32Array([1, -2, 0.5, 2 ** -24]));
  texture.uploadRegion(new Uint16Array([0, 0, 0, 0x4400]), 1, 1, 1, 1);
  expect(headless.upload(texture.texture).data).toEqual(new Float32Array([1, -2, 0.5, 4]));
  // Float32 values still go up as FLOAT; bytes or half bits do not fit an 8-bit or a float texture.
  texture.upload(new Float32Array([0.25, 0, 0, 0]));
  expect(headless.upload(texture.texture).data[0]).toBe(0.25);
  const bytes = new DataTexture(headless.gl, { width: 1, height: 1, format: "r8" });
  expect(() => bytes.upload(new Uint16Array(1))).toThrow("does not match its format");
  expect(() => texture.upload(new Uint8Array(4))).toThrow("does not match its format");
});
