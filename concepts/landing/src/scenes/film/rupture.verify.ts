// The soap film's burst on the GPU (verify-browser.ts): the hole is one piece growing from the break.
// A thin spot blown low in the film, under thicker bands, must open only once the rim has crossed
// those bands, never on its own ahead of it (the rim's arrival field, sim.ts and sims/front.ts).
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import type { SimFrame } from "../types.ts";
import { sceneDefs } from "../index.ts";

/** A square view, so the film is 320 × 320 texels. */
const SIDE = 320;

function readFilm(gl: WebGL2RenderingContext, texture: WebGLTexture, width: number, height: number): Float32Array {
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const out = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, out);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(framebuffer);
  return out;
}

/** Sizes of the 4-connected pieces of `mask`, and which piece each texel is in (-1: none). */
function pieces(mask: Uint8Array, side: number): { piece: Int32Array; sizes: number[] } {
  const piece = new Int32Array(side * side).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || piece[start] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    piece[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const at = stack.pop() ?? 0;
      size++;
      const x = at % side;
      for (const next of [x > 0 ? at - 1 : -1, x < side - 1 ? at + 1 : -1, at - side, at + side]) {
        if (next < 0 || next >= mask.length || mask[next] === 0 || piece[next] !== -1) continue;
        piece[next] = id;
        stack.push(next);
      }
    }
    sizes.push(size);
  }
  return { piece, sizes };
}

/** Blow a thin spot low in the film, pop it, and follow the hole for the first 0.4 s. */
export function verifyFilmRupture(gl: WebGL2RenderingContext): Record<string, unknown> {
  const sim = sceneDefs.film.sim?.(gl);
  if (!sim) throw new Error("film: no simulation");
  const knobs = { ...paramDefaults("film"), "blow-amount": 1 };
  const popSlot = sceneDefs.film.params.find((param) => param.key === "pop")?.trigger;
  if (popSlot === undefined) throw new Error("film: the pop knob has no trigger");
  const frame: SimFrame = {
    dt: 0.15,
    time: 0,
    motionTime: 0,
    motion: 1,
    width: SIDE,
    height: SIDE,
    aspect: 1,
    params: knobs,
    values: renderSettings(defaultsFor("film"), knobs).params,
    triggers: [],
    fired: [],
    passage: { enter: 1, exit: 0 },
    // Held low in the middle, under the bands of thicker film.
    pointer: { x: 0.5, y: 0.3, inside: true, down: true, pressed: true, released: false },
  };
  try {
    let textures = sim.frame(frame);
    for (let i = 0; i < 8; i++) {
      frame.time += frame.dt;
      frame.motionTime += frame.dt;
      frame.pointer.pressed = false;
      textures = sim.frame(frame);
    }
    const film = textures[0];
    if (!film) throw new Error("film: no film texture");
    const before = readFilm(gl, film, SIDE, SIDE);
    frame.pointer = { x: 0.5, y: 0.3, inside: false, down: false, pressed: false, released: true };
    frame.dt = 1 / 30;
    frame.fired = Array.from({ length: 8 }, (_, slot) => slot === popSlot);
    let gone = 0;
    let frames = 0;
    for (; frames < 12; frames++) {
      frame.time += frame.dt;
      frame.motionTime += frame.dt;
      textures = sim.frame(frame);
      frame.fired = [];
      const life = textures[2];
      const now = textures[0];
      if (!life || !now) throw new Error("film: no state texture");
      const state = readFilm(gl, life, 2, 1);
      if ((state[3] ?? 0) < 0.5) throw new Error("film: the film did not burst on 'now'");
      const after = readFilm(gl, now, SIDE, SIDE);
      const mask = new Uint8Array(SIDE * SIDE);
      for (let i = 0; i < mask.length; i++) mask[i] = (before[i * 4 + 1] ?? 0) > 0.9 && (after[i * 4 + 1] ?? 1) < 0.5 ? 1 : 0;
      const { piece, sizes } = pieces(mask, SIDE);
      // The break's piece: the first one met in a widening square round the break.
      const bx = Math.round(((state[0] ?? 0) + 0.5) * SIDE - 0.5);
      const by = Math.round(((state[1] ?? 0) + 0.5) * SIDE - 0.5);
      let broken = -1;
      for (let r = 0; r < 16 && broken < 0; r++) {
        for (let y = by - r; y <= by + r && broken < 0; y++) {
          for (let x = bx - r; x <= bx + r && broken < 0; x++) {
            if (x >= 0 && y >= 0 && x < SIDE && y < SIDE) broken = piece[y * SIDE + x] ?? -1;
          }
        }
      }
      const loose = sizes.filter((size, id) => id !== broken && size >= 4);
      if (loose.length > 0) {
        throw new Error(`film: ${(state[2] ?? 0).toFixed(3)} s after the break the hole was in ${loose.length + 1} pieces (${loose.join(", ")} texels away from the break)`);
      }
      gone = sizes[broken] ?? 0;
    }
    if (gone < 0.15 * SIDE * SIDE) throw new Error(`film: the hole reached only ${gone} texels in 0.4 s`);
    return { framesChecked: frames, holeTexels: gone };
  } finally {
    sim.dispose();
  }
}
