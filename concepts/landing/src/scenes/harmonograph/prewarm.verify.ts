// Real-WebGL check of the harmonograph's budgeted warm-up (registered in verify-browser.ts): the ink
// texture a slow machine ends up with is the one a fast machine draws in a single frame, a sheet on
// screen stays until a reseed's warm-up is done, a knob moved meanwhile does not change the new
// sheet, and an exit that begins mid warm-up slides off the finished sheet.
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import type { SimFrame } from "../types.ts";
import { harmonographScene } from "./index.ts";
import { HARMONOGRAPH } from "./sim.ts";

/** FNV-1a over the bytes: equal sheets hash equal. */
function fnv(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const byte of bytes) h = Math.imul(h ^ byte, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

interface Sheets {
  first: string;
  reseeded: string;
  heldOnReseed: string;
  leaving: string;
  /** Texels with figure ink in the first sheet: the fixture draws something. */
  inked: number;
}

/**
 * Run one fixed script of knob changes with `performance.now` advancing `tick` ms per look (0: a
 * machine fast enough for any budget; 1000: every budget runs out after one chunk of steps).
 */
function script(gl: WebGL2RenderingContext, tick: number): Sheets {
  const knobs = paramDefaults("harmonograph");
  const frame: SimFrame = {
    dt: 0,
    time: 0,
    motionTime: 0,
    motion: 1,
    width: 960,
    height: 540,
    aspect: 16 / 9,
    params: knobs,
    values: renderSettings(defaultsFor("harmonograph"), knobs).params,
    triggers: [],
    fired: [],
    passage: { enter: 1, exit: 0 },
    pointer: { x: 0.5, y: 0.5, inside: false, down: false, pressed: false, released: false },
  };
  const set = (key: string, value: number): void => {
    knobs[key] = value;
    frame.values = renderSettings(defaultsFor("harmonograph"), knobs).params;
  };
  const size = HARMONOGRAPH.grid;
  const bytes = new Uint8Array(size * size * 4);
  const framebuffer = gl.createFramebuffer();
  let at = 0;
  Object.defineProperty(performance, "now", { configurable: true, value: () => (at += tick) });
  const sim = harmonographScene.sim?.(gl);
  if (!sim) throw new Error("Harmonograph simulation unavailable");
  let ink: WebGLTexture | undefined;
  // Paused frames (dt 0): only the warm-up draws, so a settled sheet is the warm-up's alone.
  const frames = (count: number): void => {
    for (let i = 0; i < count; i++) ink = sim.frame(frame)[0];
  };
  const read = (): string => {
    if (!ink) throw new Error("Harmonograph returned no ink texture");
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ink, 0);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (gl.getError() !== gl.NO_ERROR) throw new Error("Harmonograph ink readback failed");
    return fnv(bytes);
  };
  try {
    // The longest warm-up is PREWARM_MAX / STEP = 10800 steps: 400 one-chunk frames cover it.
    const settle = 400;
    frames(settle);
    const first = read();
    let inked = 0;
    for (let i = 0; i < bytes.length; i += 4) if ((bytes[i] ?? 0) > 0) inked++;
    set("drawings", 1);
    frames(1);
    const heldOnReseed = read();
    // A broad nib from here on: the reseeded sheet's warm-up must keep the nib it began with.
    set("nib", 1);
    frames(settle);
    const reseeded = read();
    set("drawings", 2);
    frames(1);
    frame.passage = { enter: 1, exit: 0.2 };
    frames(1);
    const leaving = read();
    return { first, reseeded, heldOnReseed, leaving, inked };
  } finally {
    sim.dispose();
    gl.deleteFramebuffer(framebuffer);
    Reflect.deleteProperty(performance, "now");
  }
}

export function verifyHarmonographPrewarm(gl: WebGL2RenderingContext): Record<string, unknown> {
  const fast = script(gl, 0);
  const slow = script(gl, 1000);
  if (fast.inked < 1000) throw new Error(`Harmonograph fixture drew only ${fast.inked} texels`);
  if (fast.reseeded === fast.first) throw new Error("Harmonograph reseed fixture drew the same sheet");
  if (slow.first !== fast.first) throw new Error("Budgeted warm-up changed the first sheet");
  if (slow.reseeded !== fast.reseeded) throw new Error("Budgeted warm-up changed a reseeded sheet or followed a knob moved during it");
  if (fast.heldOnReseed !== fast.reseeded) throw new Error("A fast machine did not finish a reseed's warm-up in one frame");
  if (slow.heldOnReseed !== slow.first) throw new Error("A reseed replaced the sheet on screen before its warm-up was done");
  if (slow.leaving !== fast.leaving || fast.leaving === fast.reseeded) throw new Error("An exit during a warm-up did not slide off the finished sheet");
  return { sheets: [fast.first, fast.reseeded, fast.leaving], inked: fast.inked, heldOnSlowReseed: true };
}
