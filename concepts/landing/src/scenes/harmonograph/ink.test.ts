import { expect, test } from "bun:test";
import { HeadlessGl, HeadlessSim } from "../../sims/headless.ts";
import { harmonographScene } from "./index.ts";
import { HARMONOGRAPH } from "./sim.ts";

/** One texSubImage2D: the texture bound, its rectangle, and the array it was read from. */
interface Upload {
  texture: unknown;
  width: number;
  height: number;
  source: unknown;
}

test("the pen's ink reaches the GPU a changed rectangle at a time, and the texture is always the sheet", () => {
  const headless = new HeadlessGl();
  const uploads: Upload[] = [];
  let bound: unknown;
  let ink: WebGLTexture | undefined;
  // A spy on the stand-in context: which texture is bound, and every upload into it.
  const spy = new Proxy(headless.gl, {
    get(target, name) {
      const member: unknown = Reflect.get(target, name);
      if (typeof member !== "function") return member;
      if (name === "bindTexture")
        return (unit: number, texture: unknown) => {
          bound = texture;
          return Reflect.apply(member, target, [unit, texture]);
        };
      if (name === "texSubImage2D")
        return (...args: unknown[]) => {
          const [, , , , width, height, , , source] = args;
          uploads.push({ texture: bound, width: Number(width), height: Number(height), source });
          return Reflect.apply(member, target, args);
        };
      return member;
    },
  });
  const sim = new HeadlessSim(harmonographScene, spy);
  const inked = (): Upload[] => uploads.filter((upload) => upload.texture === ink);
  // The opening sheet is warmed up over a few frames before it is first shown, all of it.
  ink = sim.frame()[0];
  while (inked().length === 0) ink = sim.frame()[0];
  const sheet = HARMONOGRAPH.grid * HARMONOGRAPH.grid;
  expect(inked()[0]?.width).toBe(HARMONOGRAPH.grid);
  expect(inked()[0]?.height).toBe(HARMONOGRAPH.grid);
  // Four seconds of drawing at 60 fps.
  for (let i = 0; i < 240; i++) ink = sim.frame()[0];
  const drawing = inked().slice(1);
  // The pen moves on every frame and inks a few texels: each frame sends a rectangle round them,
  // never the sheet (measured: at most some 200 texels, against 1024 x 1024).
  expect(drawing.length).toBeGreaterThan(200);
  for (const upload of drawing) expect(upload.width * upload.height).toBeLessThan(sheet / 64);
  // Nothing inked was left out: the texture holds the sheet exactly as the sim drew it.
  const source = inked().at(-1)?.source;
  if (!(source instanceof Uint8Array)) throw new Error("no ink was uploaded");
  const texture = headless.upload(ink).data;
  let differing = 0;
  for (let k = 0; k < source.length; k++) if (texture[k] !== source[k]) differing++;
  expect(source.some((value) => value > 0)).toBe(true);
  expect(differing).toBe(0);
  sim.dispose();
});
