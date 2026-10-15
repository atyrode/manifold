// GPU check for verify-browser.ts: every curated Gray–Scott regime grows its own class of pattern in
// a fresh petri dish, through the scene's real sim and passes. A held regime that starved the
// labyrinth seed (the seed is laid at the loop start's levels) would leave the dish bare; a regime
// that never reached the pass would grow the same stripes as any other.
import { effective } from "../../params.ts";
import { grayScottRegimes } from "../../sims/grayscott.ts";
import type { SimFrame } from "../types.ts";
import { petriScene } from "./index.ts";
import { gridFor, petriRadius } from "./sim.ts";

/** Frames of 10 Gray–Scott steps each (dt 0.1 s at tempo 1 asks for 16), after the sim's prewarm. */
const FRAMES = 160;
/** The activator level that counts as growth in the view's smoothed v. */
const GROWN = 0.2;

interface Census {
  /** Share of the dish grown over. */
  cover: number;
  /** 4-connected parts of the growth. */
  parts: number;
  /** The largest part's share of the growth. */
  largest: number;
}

function census(view: Float32Array, n: number): Census {
  const on = new Uint8Array(n * n);
  const r = n / 2 - 2;
  let inside = 0;
  let grown = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = x + 0.5 - n / 2;
      const dy = y + 0.5 - n / 2;
      if (dx * dx + dy * dy >= r * r) continue;
      inside++;
      if ((view[(y * n + x) * 4] ?? 0) > GROWN) {
        on[y * n + x] = 1;
        grown++;
      }
    }
  }
  const stack: number[] = [];
  let parts = 0;
  let largest = 0;
  for (let start = 0; start < n * n; start++) {
    if (on[start] !== 1) continue;
    on[start] = 2;
    stack.push(start);
    let size = 0;
    while (stack.length > 0) {
      const at = stack.pop() ?? 0;
      size++;
      const x = at % n;
      for (const next of [x > 0 ? at - 1 : -1, x < n - 1 ? at + 1 : -1, at - n, at + n]) {
        if (next >= 0 && next < n * n && on[next] === 1) {
          on[next] = 2;
          stack.push(next);
        }
      }
    }
    parts++;
    largest = Math.max(largest, size);
  }
  return { cover: grown / Math.max(1, inside), parts, largest: grown > 0 ? largest / grown : 0 };
}

export function petriRegimesVerify(gl: WebGL2RenderingContext): Record<string, unknown> {
  const results: Record<string, Census> = {};
  const width = 160;
  const height = 100;
  // The view is the sim's square grid, sized from the dish's diameter in cells and the scale knob.
  const size = gridFor(2 * petriRadius(width / height, 0.5) * height, 0.5);
  const framebuffer = gl.createFramebuffer();
  grayScottRegimes.forEach((regime, index) => {
    const sim = petriScene.sim?.(gl);
    if (!sim) throw new Error("Petri simulation unavailable");
    const knobs = { regime: index + 1, drops: 0 };
    const frame: SimFrame = {
      dt: 0.1,
      time: 0,
      motionTime: 0,
      motion: 1,
      width,
      height,
      aspect: width / height,
      params: knobs,
      values: petriScene.params.map((def) => effective(def, knobs)),
      triggers: Array.from({ length: 8 }, () => -1e4),
      fired: Array.from({ length: 8 }, () => false),
      passage: { enter: 1, exit: 0 },
      pointer: { x: 0.5, y: 0.5, inside: false, down: false, pressed: false, released: false },
    };
    try {
      let view: WebGLTexture | undefined;
      for (let i = 0; i < FRAMES; i++) {
        frame.time += frame.dt;
        frame.motionTime += frame.dt;
        view = sim.frame(frame)[0];
      }
      if (!view) throw new Error("Petri returned no view");
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, view, 0);
      const pixels = new Float32Array(size * size * 4);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.FLOAT, pixels);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (gl.getError() !== gl.NO_ERROR) throw new Error(`Petri ${regime.label}: view readback failed`);
      results[regime.label] = census(pixels, size);
    } finally {
      sim.dispose();
    }
  });
  gl.deleteFramebuffer(framebuffer);
  const failures: string[] = [];
  for (const [label, found] of Object.entries(results)) {
    if (found.cover < 0.1) failures.push(`${label} left a bare dish`);
  }
  const { spots, coral, holes } = results;
  if (!spots || spots.parts < 12 || spots.largest > 0.2) failures.push("spots did not break into many small spots");
  if (!coral || coral.largest < 0.6) failures.push("coral did not grow one branching network");
  if (!holes || holes.cover < 0.55) failures.push("holes did not swell round dark holes");
  if (failures.length > 0) throw new Error(`Petri regimes: ${failures.join("; ")}: ${JSON.stringify(results)}`);
  return results;
}
