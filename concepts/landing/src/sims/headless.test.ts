import { expect, test } from "bun:test";
import { effective } from "../params.ts";
import { barScene } from "../scenes/bar/index.ts";
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
