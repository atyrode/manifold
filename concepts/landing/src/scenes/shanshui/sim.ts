// The handscroll's clockwork. The landscape itself is a pure function of the scroll position (see
// shader.ts); what a shader alone cannot keep is integrated here on the CPU, in double precision:
//   - how far the scroll has unrolled (eased toward the speed knob, so turning it never jumps),
//     handed over within its section (SHANSHUI_SECTION heights), which keeps the shader's float32
//     painting coordinate small however long the scroll runs,
//   - how far the mist has drifted along it and how far its billows have reshaped,
//   - the skein of wild geese crossing the sky (when it sets off, where it is, how many birds),
//   - the seal last pressed onto the paper (with "now" or a click), carried along with the scroll,
//   - the pointer's breath over the mist (a fading TrailField).
//
// uSim0, rgba16f, 4 x 1, nearest. Half floats hold integers exactly to 2048 but only ~11 bits of
// fraction, so positions are split (see `split3`/`split2`) and rebuilt in the shader:
//   texel 0  scroll within its section, in screen heights: (k, hi, lo, mist clock mod 256: the
//            shader only uses it in whole cycles of sines, and it also swings the boats along their
//            water)
//   texel 1  mist drift along the scroll: (k, hi, lo, section)  value = k * 32 + (hi + lo) / 64;
//            section: its number mod SHANSHUI_SECTIONS, plus SHANSHUI_SECTIONS after the first
//   texel 2  geese: leader x (hi, lo) in screen heights, leader y (uv), skein number
//   texel 3  seal: x (hi, lo) in screen heights, y (uv), seconds since pressed (-1: none yet)
//            value = (hi + lo) / 64
// uSim1, r8: the pointer's trail over the page (uv), thinning the mist where it has passed.
// Texel 2 alpha is the skein's number (1, 2, ...; 0 while the sky is empty), so each skein can
// fly in its own loose line.
import { KnobReader, type ParamDef } from "../../params.ts";
import { Random } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import { TrailField } from "../../sims/trail.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";
import { SHANSHUI_SECTION, SHANSHUI_SECTIONS } from "./shader.ts";

/** Screen heights per second of scroll at the speed knob's top. */
const SPEED_MAX = 0.016;
/** Seconds over which the scroll follows a change of the speed knob. */
const SPEED_EASE = 1.2;
/** Screen heights per second the mist drifts along the scroll at the drift knob's top. */
const DRIFT_MAX = 0.007;
/** Screen heights per second the geese fly, right to left with the reading of the scroll. */
const GEESE_SPEED = 0.034;
/** Seconds between skeins at the birds knob's bottom and top (jittered). */
const GEESE_RARE = 150;
const GEESE_OFTEN = 35;
/** Trail grid rows (the width follows the aspect); linear filtering smooths it. */
const TRAIL_ROWS = 48;
/** Seconds for the pointer's breath to fade to half. */
const TRAIL_HALF_LIFE = 2.2;
/** Radius of the breath, in uv heights, and its strength per uv height of travel. */
const TRAIL_RADIUS = 0.09;
const TRAIL_PER_TRAVEL = 4;
/** Seconds of seal age after which the shader no longer animates it (it is left there as is). */
const SEAL_SETTLED = 30;

type KnobKey = "speed" | "drift" | "birds" | "seal" | "seed";

/** value = k * 32 + (hi + lo) / 64, each part exact in a half float for 0 <= value < 65536. */
function split3(out: Float32Array, at: number, value: number): void {
  const v = Math.max(0, value);
  const k = Math.floor(v / 32);
  const r = (v - k * 32) * 64;
  const hi = Math.floor(r);
  out[at] = k;
  out[at + 1] = hi;
  out[at + 2] = r - hi;
}

/** value = (hi + lo) / 64, exact enough in half floats for |value| < 32. */
function split2(out: Float32Array, at: number, value: number): void {
  const r = Math.max(-31, Math.min(31, value)) * 64;
  const hi = Math.floor(r);
  out[at] = hi;
  out[at + 1] = r - hi;
}

class ShanshuiSim implements SceneSim {
  readonly #state: DataTexture;
  readonly #texels = new Float32Array(16);
  readonly #textures: (WebGLTexture | undefined)[] = [undefined, undefined];
  readonly #knobs: KnobReader<KnobKey>;
  readonly #geeseSlot: number;
  readonly #sealSlot: number;
  readonly #random = new Random();
  #trail: TrailField | undefined;
  #trailTexture: DataTexture | undefined;
  #uploaded = -1;
  #lastX = Number.NaN;
  #lastY = 0;

  #seed = Number.NaN;
  #rate = Number.NaN;
  /** Screen heights unrolled since the scroll began (seeded), and at the start of this section. */
  #scroll = 0;
  #sectionStart = 0;
  /** Sections begun since the scroll began. */
  #section = 0;
  #drift = 0;
  #morph = 0;
  #clock = 0;

  // Geese: the skein in flight (x of the leader in screen heights) and when the next one sets off.
  #geeseX = Number.NaN;
  #geeseY = 0.78;
  #skein = 0;
  #nextGeese = Number.NaN;

  // The seal last pressed: where on the scroll (screen x minus scroll, in heights) and how long ago.
  #sealAt = Number.NaN;
  #sealY = 0;
  #sealAge = -1;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#knobs = new KnobReader("shanshui", params, ["speed", "drift", "birds", "seal", "seed"]);
    this.#geeseSlot = this.#knobs.trigger("birds");
    this.#sealSlot = this.#knobs.trigger("seal");
    this.#state = new DataTexture(gl, {
      width: 4,
      height: 1,
      format: "rgba16f",
      filter: "nearest",
    });
    this.#trailTexture = new DataTexture(gl, { width: 1, height: 1, format: "r8" });
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const knobs = this.#knobs;
    const speed = knobs.value(frame, "speed");
    const drift = knobs.value(frame, "drift");
    const birds = knobs.value(frame, "birds");
    const seal = knobs.value(frame, "seal");
    const seed = Math.round(knobs.value(frame, "seed"));
    const aspect = frame.aspect > 0 ? frame.aspect : 16 / 9;

    if (seed !== this.#seed) this.#reset(seed, speed, birds > 0, aspect);

    // The scroll and the mist move on the scene clock, scaled by the lab's motion.
    const dt = Math.max(0, frame.dt);
    const step = dt * frame.motion;
    this.#rate += (speed * SPEED_MAX - this.#rate) * (1 - Math.exp(-dt / SPEED_EASE));
    this.#scroll += step * this.#rate;
    this.#drift += step * drift * DRIFT_MAX;
    this.#morph = (this.#morph + step * (0.15 + drift)) % 256;
    this.#clock += step;
    // A new section begins once this one is a section long: its painting restarts from its own
    // origin, while the one before runs on beyond the join (shader.ts).
    const sections = Math.floor((this.#scroll - this.#sectionStart) / SHANSHUI_SECTION);
    if (sections > 0) {
      this.#sectionStart += sections * SHANSHUI_SECTION;
      this.#section += sections;
    }

    this.#flyGeese(dt, frame.motion, birds, aspect, frame.fired[this.#geeseSlot] === true);
    this.#pressSeal(frame, dt, seal, aspect, frame.fired[this.#sealSlot] === true);
    this.#breathe(frame, aspect);

    const out = this.#texels;
    split3(out, 0, this.#scroll - this.#sectionStart);
    out[3] = this.#morph;
    split3(out, 4, this.#drift);
    out[7] = this.#section === 0 ? 0 : SHANSHUI_SECTIONS + (this.#section % SHANSHUI_SECTIONS);
    split2(out, 8, Number.isFinite(this.#geeseX) ? this.#geeseX : -9);
    out[10] = this.#geeseY;
    out[11] = Number.isFinite(this.#geeseX) ? this.#skein : 0;
    const sealShown = Number.isFinite(this.#sealAt) && seal > 0;
    split2(out, 12, sealShown ? this.#sealAt + this.#scroll : -9);
    out[14] = this.#sealY;
    out[15] = sealShown ? Math.min(this.#sealAge, SEAL_SETTLED) : -1;
    this.#state.upload(out);
    this.#textures[0] = this.#state.texture;
    this.#textures[1] = this.#trailTexture?.texture;
    return this.#textures;
  }

  dispose(): void {
    this.#state.dispose();
    this.#trailTexture?.dispose();
    this.#trailTexture = undefined;
    this.#trail = undefined;
  }

  /** A new scroll: start at its beginning, with a skein of geese already crossing (prewarmed). */
  #reset(seed: number, speed: number, geese: boolean, aspect: number): void {
    this.#seed = seed;
    // A scroll's own run of numbers: its seed mixed so neighbouring seeds do not start alike.
    this.#random.seed(Math.imul((seed + 1) | 0, 0x9e3779b1) ^ 0x5eed5a17);
    this.#rate = speed * SPEED_MAX;
    this.#scroll = 0;
    this.#sectionStart = 0;
    this.#section = 0;
    this.#drift = 0;
    this.#morph = 0;
    this.#clock = 0;
    this.#sealAt = Number.NaN;
    this.#sealAge = -1;
    // The first skein is already a third of the way across, so the opening view has its geese.
    this.#skein = 0;
    this.#geeseX = Number.NaN;
    if (geese) {
      this.#launchGeese(aspect);
      this.#geeseX = aspect * 0.62;
    }
    this.#nextGeese = Number.NaN;
  }

  #launchGeese(aspect: number): void {
    const random = this.#random;
    this.#geeseX = aspect + 0.12;
    this.#geeseY = 0.7 + 0.16 * random.next();
    this.#skein = (this.#skein % 2000) + 1;
  }

  /**
   * Geese cross the sky right to left; the next skein waits a while, jittered, after one is gone.
   * A skein in the air keeps flying, slowly, even while motion is held at zero.
   */
  #flyGeese(dt: number, motion: number, birds: number, aspect: number, now: boolean): void {
    if (now && (!Number.isFinite(this.#geeseX) || this.#geeseX < aspect * 0.5))
      this.#launchGeese(aspect);
    if (Number.isFinite(this.#geeseX)) {
      this.#geeseX -= dt * Math.max(motion, 0.35) * GEESE_SPEED;
      // The skein trails up to ~0.45 heights behind (to the right of) its leader.
      if (this.#geeseX < -0.6) this.#geeseX = Number.NaN;
      return;
    }
    if (birds <= 0) {
      this.#nextGeese = Number.NaN;
      return;
    }
    const often = Math.min(1, Math.max(0, birds));
    const interval = GEESE_RARE + (GEESE_OFTEN - GEESE_RARE) * often * often * (3 - 2 * often);
    if (!Number.isFinite(this.#nextGeese))
      this.#nextGeese = this.#clock + interval * (0.6 + 0.8 * this.#random.next());
    else if (this.#clock >= this.#nextGeese) {
      this.#nextGeese = Number.NaN;
      this.#launchGeese(aspect);
    }
  }

  /** A click on the page, or "now", presses the seal onto the paper; it then travels with the scroll. */
  #pressSeal(frame: SimFrame, dt: number, seal: number, aspect: number, now: boolean): void {
    const pointer = frame.pointer;
    const clicked = seal > 0 && pointer.inside && pointer.pressed;
    if (clicked || (now && seal > 0)) {
      const random = this.#random;
      let x: number;
      let y: number;
      if (clicked) {
        x = pointer.x * aspect;
        y = pointer.y;
      } else {
        // A collector's place: the empty sky toward the top right, a little different each press.
        x = aspect * (0.62 + 0.26 * random.next());
        y = 0.74 + 0.13 * random.next();
      }
      // Keep the whole impression inside the frame (the shader's seal is 0.04..0.09 heights across
      // with the size knob and only shows fully 0.05 heights in from an edge).
      const margin = 0.75 * (0.04 + 0.05 * seal) + 0.05;
      x = Math.min(Math.max(x, margin), Math.max(margin, aspect - margin));
      y = Math.min(Math.max(y, margin), 1 - margin);
      this.#sealAt = x - this.#scroll;
      this.#sealY = y;
      this.#sealAge = 0;
    }
    if (this.#sealAge >= 0) this.#sealAge += dt;
    // Gone off the right edge with the scroll: forget it.
    if (Number.isFinite(this.#sealAt) && this.#sealAt + this.#scroll > aspect + 0.3) {
      this.#sealAt = Number.NaN;
      this.#sealAge = -1;
    }
  }

  /** The pointer's breath over the page thins the mist along its path, fading on the scene clock. */
  #breathe(frame: SimFrame, aspect: number): void {
    const columns = Math.min(256, Math.max(8, Math.round(TRAIL_ROWS * aspect)));
    if (this.#trail === undefined || this.#trail.width !== columns) {
      this.#trail = new TrailField(columns, TRAIL_ROWS);
      this.#trailTexture?.resize(columns, TRAIL_ROWS);
      this.#uploaded = -1;
      this.#lastX = Number.NaN;
    }
    const trail = this.#trail;
    const pointer = frame.pointer;
    if (pointer.inside) {
      const travel = Number.isNaN(this.#lastX)
        ? 0
        : Math.hypot((pointer.x - this.#lastX) * aspect, pointer.y - this.#lastY);
      const strength = Math.min(0.6, travel * TRAIL_PER_TRAVEL);
      if (strength > 0.002) trail.stroke(pointer.x, pointer.y, TRAIL_RADIUS, strength, aspect);
      this.#lastX = pointer.x;
      this.#lastY = pointer.y;
    } else {
      trail.lift();
      this.#lastX = Number.NaN;
    }
    trail.decay(frame.dt * frame.motion, TRAIL_HALF_LIFE);
    if (trail.version !== this.#uploaded) {
      this.#trailTexture?.upload(trail.data);
      this.#uploaded = trail.version;
    }
  }
}

/** The handscroll's clock, geese, seal and breath for a scene whose knobs are `params` (by key). */
export function shanshuiSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new ShanshuiSim(gl, params);
}
