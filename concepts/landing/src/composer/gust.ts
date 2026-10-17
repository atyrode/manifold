// The composer's one gust field (ADR 0062 D4): the meadow's honami field, promoted. A deterministic
// function of a point on the floor and the motion clock, here for the sims and generated line for
// line as GLSL (`gustGlsl`) for the shader, so the waves of paler light rolling across the grass,
// the bow of the near blades, the clocks' rocking, the seeds' air and the sway of every other layer
// are one wind:
//   three trains of gust fronts travel downwind (mostly across the view, a little away), each a broad
//   swell with a soft leading edge and a long tail, then a faint rebound where released grass
//   springs up past upright. The fronts are bent by slow crosswind wobbles, and a gate drifting with
//   them switches stretches of a front on and off: `gustRate` moves only the gate's threshold, so
//   turning it never shifts a front. 'Now' (the gusts' trigger) adds one big front released at the
//   left of the field that sweeps across all of it. A preset's passage may send one more front
//   through (`PassageGustShape`: meadow's entrance and exit).
//
// Floor: x right, z away from the eye (metres). Times are seconds of the motion clock.
//
//   gustWind(out, wind, gusts, rate, nowAge, pass)   the field's state from the knobs
//   gustAt(w, x, z, tm, blur)                         the gust load at (x, z): ~0 in a lull, up to ~1
//                                                     in a strong gust (more under 'now'), slightly
//                                                     negative in a rebound; `blur` the floor length a
//                                                     sample spans along the wind (0: a point)
//   passageGust(out, shape, enter, exit)             the passage's front now
//   gustGlsl(shape?)                                  `GustWind`, `gustWind()`, `gustAt(w, p, tm, blur)`
import { glslFloat } from "../shaders/glsl.ts";
import { smoothstep } from "../sims/math.ts";

/** TAU as the shader spells it, so the gust phases match the GLSL. */
const GLSL_TAU = 6.2831853;

/**
 * Every constant of the gust field. Three trains (k = 0..2) of fronts `lambda` apart; distances in
 * metres, times in seconds of the motion clock, phases in radians.
 */
export const GUST = {
  /** Downwind direction before normalising: to the right (mirrored by a negative wind) and away. */
  dirX: 1,
  dirZ: 0.45,
  /** Front speed: base, and added at full wind. */
  speed: 3,
  speedWind: 3,
  lambda: [31, 47, 73],
  offset: [0, 0.37, 0.71],
  /** Crosswind wobble bending each train's fronts: amplitude, wavenumber, rate, phase; a second, finer harmonic at this share. */
  wobA: [5, 7, 9],
  wobK: [0.083, 0.061, 0.047],
  wobW: [0.11, 0.07, 0.05],
  wobP: [0, 2.1, 4.3],
  wobSecond: 0.4,
  /** The gate: its phase steps this many turns per front, varies across the wind, drifts in time. */
  gateStep: [0.29, 0.43, 0.23],
  gateK: [0.13, 0.09, 0.17],
  gateW: [0.05, 0.035, 0.06],
  gateP: [1.3, 3.7, 5.9],
  weight: [1, 0.85, 0.7],
  /** Gate threshold at gust frequency 0 and 1, and the width of its soft edge. */
  gateRare: 0.75,
  gateOften: -0.55,
  gateSoft: 0.5,
  /** A front over one period f in 0..1 (downwind = larger f): its tail starts, it peaks, and its soft leading edge ends. */
  tail: 0.04,
  peak: 0.58,
  edge: 0.8,
  /** The rebound just upwind of the tail: depth, centre, width (periods). */
  rebound: 0.15,
  reboundAt: 0.975,
  reboundWidth: 0.05,
  /** The front's mean over a period: what it fades to once a cell spans too much of it. */
  frontMean: 0.37,
  blurFrom: 0.04,
  blurTo: 0.16,
  /** Overlapping fronts saturate: sum / (1 + softclip × sum). */
  softclip: 0.35,
  /** The 'now' gust: released this far along the wind (left of the field), at this multiple of the front speed, its leading edge and tail lengths, gain, life (s), fade-in (s) and its gentle bend. */
  nowStart: -12,
  nowPace: 2,
  nowEdge: 4,
  nowTail: 20,
  nowGain: 1.3,
  nowLife: 24,
  nowRise: 0.6,
  nowWob: 4,
  nowWobK: 0.07,
  nowWobP: 1.3,
} as const;

/**
 * A front a preset's passage sends through the field (meadow's): it starts `from` along the wind
 * (clear of the view, to the left), sweeps at `inSpeed` from `inAt` seconds into the entrance
 * (amplitude `inAmp`, rising over `inRise` and gone over the last `inFade` seconds of the
 * `enter`-second entrance), and at `outSpeed` from the start of the `exit`-second exit; shaped
 * like the 'now' gust's front with its own `gain`, leading `edge` and short `tail`.
 */
export interface PassageGustShape {
  readonly enter: number;
  readonly exit: number;
  readonly from: number;
  readonly gain: number;
  readonly edge: number;
  readonly tail: number;
  readonly inAt: number;
  readonly inSpeed: number;
  readonly inAmp: number;
  readonly inRise: number;
  readonly inFade: number;
  readonly outSpeed: number;
  readonly outAmp: number;
  readonly outRise: number;
}

/** The passage gust's front (floor distance along the wind) and amplitude (0: none, as at rest). */
export interface PassageGust {
  front: number;
  amp: number;
}

/** No passage gust: at rest, and for a preset whose passage sends none. */
export const NO_PASSAGE_GUST: Readonly<PassageGust> = { front: 0, amp: 0 };

/** Fill `out` with the passage gust for the entrance and exit progress 0..1. Shader: gustPassage. */
export function passageGust(
  out: PassageGust,
  shape: PassageGustShape,
  enter: number,
  exit: number,
): PassageGust {
  out.front = shape.from;
  out.amp = 0;
  if (exit > 0) {
    const t = exit * shape.exit;
    out.front = shape.from + shape.outSpeed * t;
    out.amp = shape.outAmp * smoothstep(0, shape.outRise, t);
  } else if (enter < 1) {
    const tin = enter * shape.enter;
    const t = tin - shape.inAt;
    out.front = shape.from + shape.inSpeed * t;
    out.amp =
      shape.inAmp *
      smoothstep(0, shape.inRise, t) *
      (1 - smoothstep(shape.enter - shape.inFade, shape.enter, tin));
  }
  return out;
}

/** The field's state, from the knobs (`gustWind`). */
export interface GustWind {
  /** Unit downwind direction on the floor. */
  dirX: number;
  dirZ: number;
  /** Front speed, metres per second. */
  speed: number;
  /** The gusts knob (0 while off). */
  strength: number;
  /** The gate's threshold, from the gust frequency knob. */
  threshold: number;
  /** Motion seconds since 'now' sent a big gust; negative while idle. */
  nowAge: number;
  /** The passage gust's front and amplitude; 0 outside a passage. */
  passFront: number;
  passAmp: number;
  /** The passage's shape, for its edge, tail and gain; undefined: the preset sends none. */
  shape: PassageGustShape | undefined;
}

/** A fresh state, to fill with `gustWind`. */
export function newGustWind(): GustWind {
  return {
    dirX: 1,
    dirZ: 0,
    speed: 1,
    strength: 0,
    threshold: 1,
    nowAge: -1,
    passFront: 0,
    passAmp: 0,
    shape: undefined,
  };
}

/** Fill `out` from the knobs: wind -1..1, gusts 0..1, gust frequency 0..1; and the passage's gust. */
export function gustWind(
  out: GustWind,
  wind: number,
  gusts: number,
  rate: number,
  nowAge: number,
  pass: Readonly<PassageGust>,
  shape: PassageGustShape | undefined,
): GustWind {
  const G = GUST;
  const side = wind < 0 ? -1 : 1;
  const length = Math.sqrt(G.dirX * G.dirX + G.dirZ * G.dirZ);
  out.dirX = (side * G.dirX) / length;
  out.dirZ = G.dirZ / length;
  out.speed = G.speed + G.speedWind * Math.abs(wind);
  out.strength = gusts;
  out.threshold = G.gateRare + (G.gateOften - G.gateRare) * rate;
  out.nowAge = nowAge;
  out.passFront = pass.front;
  out.passAmp = pass.amp;
  out.shape = shape;
  return out;
}

/** One front over its period, f in 0..1, blurred by b periods (shader: gustFront). */
function gustFront(f: number, b: number): number {
  const G = GUST;
  const rise = smoothstep(G.tail - b, G.peak + b, f);
  const fall = 1 - smoothstep(G.peak - b, G.edge + b, f);
  const width = Math.sqrt(G.reboundWidth * G.reboundWidth + b * b);
  let df = f - G.reboundAt;
  df -= Math.floor(df + 0.5);
  return (
    rise * fall - G.rebound * (G.reboundWidth / width) * Math.exp((-df * df) / (width * width))
  );
}

/** The gust load at floor point (x, z) at motion time tm (see the header). Shader: gustAt. */
export function gustAt(w: GustWind, x: number, z: number, tm: number, blur: number): number {
  const G = GUST;
  const s = x * w.dirX + z * w.dirZ;
  const c = x * w.dirZ - z * w.dirX;
  let sum = 0;
  for (let k = 0; k < 3; k++) {
    const lambda = G.lambda[k] ?? 1;
    const wobK = G.wobK[k] ?? 0;
    const wobW = G.wobW[k] ?? 0;
    const wobP = G.wobP[k] ?? 0;
    const wob =
      (G.wobA[k] ?? 0) *
      (Math.sin(c * wobK + tm * wobW + wobP) +
        G.wobSecond * Math.sin(c * wobK * 2.3 - tm * wobW * 1.4 + wobP * 2 + 1));
    const u = (s - w.speed * tm + wob) / lambda + (G.offset[k] ?? 0);
    const b = blur / lambda;
    const raw = gustFront(u - Math.floor(u), b);
    const front = raw + (G.frontMean - raw) * smoothstep(G.blurFrom, G.blurTo, b);
    const n = Math.sin(
      GLSL_TAU * (G.gateStep[k] ?? 0) * u +
        c * (G.gateK[k] ?? 0) +
        tm * (G.gateW[k] ?? 0) +
        (G.gateP[k] ?? 0),
    );
    sum += (G.weight[k] ?? 0) * smoothstep(w.threshold, w.threshold + G.gateSoft, n) * front;
  }
  let g = (w.strength * sum) / (1 + G.softclip * Math.max(sum, 0));
  if (w.nowAge >= 0 && w.nowAge < G.nowLife) {
    const at = G.nowStart + G.nowPace * w.speed * w.nowAge;
    const d = at - s - G.nowWob * Math.sin(c * G.nowWobK + G.nowWobP);
    const edge = G.nowEdge + blur;
    const life =
      smoothstep(0, G.nowRise, w.nowAge) * (1 - smoothstep(G.nowLife * 0.6, G.nowLife, w.nowAge));
    g += G.nowGain * life * smoothstep(0, edge, d) * Math.exp(-Math.max(d - edge, 0) / G.nowTail);
  }
  const shape = w.shape;
  if (shape !== undefined && w.passAmp > 0) {
    const d = w.passFront - s - G.nowWob * Math.sin(c * G.nowWobK + G.nowWobP);
    const edge = shape.edge + blur;
    g +=
      shape.gain *
      w.passAmp *
      smoothstep(0, edge, d) *
      Math.exp(-Math.max(d - edge, 0) / shape.tail);
  }
  return g;
}

/**
 * What the composed sim hands every layer each frame (LayerFrame.gusts): the knobs as the shader
 * reads them, the 'now' gust's age at the frame (negative while idle) and the passage's front now.
 * A sim stepping on a FixedStep builds its own `GustWind` per step from these (`gustWind`), its
 * steps' 'now' ages lagging the frame's.
 */
export interface GustField {
  readonly wind: number;
  readonly gusts: number;
  readonly rate: number;
  readonly nowAge: number;
  /** The gusts' "now" slot, in SimFrame.triggers. */
  readonly slot: number;
  readonly pass: Readonly<PassageGust>;
  readonly shape: PassageGustShape | undefined;
}

const floats = (values: readonly number[]): string =>
  `float[${values.length}](${values.map(glslFloat).join(", ")})`;

/**
 * The field in GLSL, the CPU twin's line for line: `GustWind gustWind()` from K_wind, K_gusts,
 * K_gustRate, the gusts' "now" slot and (with `shape`) the passage's front; `float gustAt(GustWind
 * w, vec2 p, float tm, float blur)` at floor point p = (x, z).
 */
export function gustGlsl(slot: number, shape: PassageGustShape | undefined): string {
  const G = GUST;
  const passage =
    shape === undefined
      ? ""
      : `
const float GUST_PASS_ENTER = ${glslFloat(shape.enter)};
const float GUST_PASS_EXIT = ${glslFloat(shape.exit)};
const float GUST_PASS_FROM = ${glslFloat(shape.from)};
const float GUST_PASS_GAIN = ${glslFloat(shape.gain)};
const float GUST_PASS_EDGE = ${glslFloat(shape.edge)};
const float GUST_PASS_TAIL = ${glslFloat(shape.tail)};
const float GUST_PASS_IN_AT = ${glslFloat(shape.inAt)};
const float GUST_PASS_IN_SPEED = ${glslFloat(shape.inSpeed)};
const float GUST_PASS_IN_AMP = ${glslFloat(shape.inAmp)};
const float GUST_PASS_IN_RISE = ${glslFloat(shape.inRise)};
const float GUST_PASS_IN_FADE = ${glslFloat(shape.inFade)};
const float GUST_PASS_OUT_SPEED = ${glslFloat(shape.outSpeed)};
const float GUST_PASS_OUT_AMP = ${glslFloat(shape.outAmp)};
const float GUST_PASS_OUT_RISE = ${glslFloat(shape.outRise)};

// The front the preset's passage sends through (gust.ts passageGust): arriving, a first wave once
// the rig has mostly come down, fading out before the scene is at rest; leaving, a strong one at once.
void gustPassage(inout GustWind w) {
  float tout = passageOut() * GUST_PASS_EXIT;
  if (passageOut() > 0.0) {
    w.passFront = GUST_PASS_FROM + GUST_PASS_OUT_SPEED * tout;
    w.passAmp = GUST_PASS_OUT_AMP * smoothstep(0.0, GUST_PASS_OUT_RISE, tout);
  } else if (passageIn() < 1.0) {
    float tin = passageIn() * GUST_PASS_ENTER;
    float t = tin - GUST_PASS_IN_AT;
    w.passFront = GUST_PASS_FROM + GUST_PASS_IN_SPEED * t;
    w.passAmp = GUST_PASS_IN_AMP * smoothstep(0.0, GUST_PASS_IN_RISE, t) * (1.0 - smoothstep(GUST_PASS_ENTER - GUST_PASS_IN_FADE, GUST_PASS_ENTER, tin));
  }
}
`;
  return `
// ---- the gust field (composer/gust.ts: gustWind, gustFront, gustAt) ----
const int GUST_TRIGGER = ${slot};
const float GUST_DIR_X = ${glslFloat(G.dirX)};
const float GUST_DIR_Z = ${glslFloat(G.dirZ)};
const float GUST_SPEED = ${glslFloat(G.speed)};
const float GUST_SPEED_WIND = ${glslFloat(G.speedWind)};
const float GUST_LAMBDA[3] = ${floats(G.lambda)};
const float GUST_TRAIN_OFFSET[3] = ${floats(G.offset)};
const float GUST_WOB_A[3] = ${floats(G.wobA)};
const float GUST_WOB_K[3] = ${floats(G.wobK)};
const float GUST_WOB_W[3] = ${floats(G.wobW)};
const float GUST_WOB_P[3] = ${floats(G.wobP)};
const float GUST_WOB_SECOND = ${glslFloat(G.wobSecond)};
const float GUST_GATE_STEP[3] = ${floats(G.gateStep)};
const float GUST_GATE_K[3] = ${floats(G.gateK)};
const float GUST_GATE_W[3] = ${floats(G.gateW)};
const float GUST_GATE_P[3] = ${floats(G.gateP)};
const float GUST_TRAIN_WEIGHT[3] = ${floats(G.weight)};
const float GUST_GATE_RARE = ${glslFloat(G.gateRare)};
const float GUST_GATE_OFTEN = ${glslFloat(G.gateOften)};
const float GUST_GATE_SOFT = ${glslFloat(G.gateSoft)};
const float GUST_FRONT_TAIL = ${glslFloat(G.tail)};
const float GUST_FRONT_PEAK = ${glslFloat(G.peak)};
const float GUST_FRONT_EDGE = ${glslFloat(G.edge)};
const float GUST_REBOUND = ${glslFloat(G.rebound)};
const float GUST_REBOUND_AT = ${glslFloat(G.reboundAt)};
const float GUST_REBOUND_WIDTH = ${glslFloat(G.reboundWidth)};
const float GUST_FRONT_MEAN = ${glslFloat(G.frontMean)};
const float GUST_BLUR_FROM = ${glslFloat(G.blurFrom)};
const float GUST_BLUR_TO = ${glslFloat(G.blurTo)};
const float GUST_SOFTCLIP = ${glslFloat(G.softclip)};
const float GUST_NOW_START = ${glslFloat(G.nowStart)};
const float GUST_NOW_PACE = ${glslFloat(G.nowPace)};
const float GUST_NOW_EDGE = ${glslFloat(G.nowEdge)};
const float GUST_NOW_TAIL = ${glslFloat(G.nowTail)};
const float GUST_NOW_GAIN = ${glslFloat(G.nowGain)};
const float GUST_NOW_LIFE = ${glslFloat(G.nowLife)};
const float GUST_NOW_RISE = ${glslFloat(G.nowRise)};
const float GUST_NOW_WOB = ${glslFloat(G.nowWob)};
const float GUST_NOW_WOB_K = ${glslFloat(G.nowWobK)};
const float GUST_NOW_WOB_P = ${glslFloat(G.nowWobP)};

struct GustWind {
  vec2 dir;        // unit downwind direction on the floor (x right, y = z away from the eye)
  float speed;     // front speed, metres per second
  float strength;  // K_gusts
  float threshold; // the gate's threshold, from K_gustRate
  float nowAge;    // motion seconds (sinceTriggerM) since 'now' sent a big gust; negative while idle
  float passFront; // the passage gust's front (floor distance along the wind) ...
  float passAmp;   // ... and its amplitude; 0 outside a passage
};
${passage}
GustWind gustWind() {
  GustWind w;
  float side = K_wind < 0.0 ? -1.0 : 1.0;
  w.dir = normalize(vec2(side * GUST_DIR_X, GUST_DIR_Z));
  w.speed = GUST_SPEED + GUST_SPEED_WIND * abs(K_wind);
  w.strength = K_gusts;
  w.threshold = GUST_GATE_RARE + (GUST_GATE_OFTEN - GUST_GATE_RARE) * K_gustRate;
  w.nowAge = uTriggers[GUST_TRIGGER] < -1000.0 ? -1.0 : sinceTriggerM(GUST_TRIGGER);
  w.passFront = ${shape === undefined ? "0.0" : "GUST_PASS_FROM"};
  w.passAmp = 0.0;
${shape === undefined ? "" : "  if (K_gusts > 0.0) gustPassage(w);\n"}  return w;
}

// One front over its period f (downwind = larger f): a long tail swelling to a soft leading edge,
// and a faint rebound just upwind of the tail. b widens it to the span of a cell (periods).
float gustFront(float f, float b) {
  float rise = smoothstep(GUST_FRONT_TAIL - b, GUST_FRONT_PEAK + b, f);
  float fall = 1.0 - smoothstep(GUST_FRONT_PEAK - b, GUST_FRONT_EDGE + b, f);
  float width = sqrt(GUST_REBOUND_WIDTH * GUST_REBOUND_WIDTH + b * b);
  float df = f - GUST_REBOUND_AT;
  df -= floor(df + 0.5);
  return rise * fall - GUST_REBOUND * (GUST_REBOUND_WIDTH / width) * exp(-df * df / (width * width));
}

// The gust load at floor point p = (x, z) at time tm (uMotionTime); blur is the floor length the
// sample spans along the wind.
float gustAt(GustWind w, vec2 p, float tm, float blur) {
  float s = p.x * w.dir.x + p.y * w.dir.y;
  float c = p.x * w.dir.y - p.y * w.dir.x;
  float sum = 0.0;
  for (int k = 0; k < 3; k++) {
    float lambda = GUST_LAMBDA[k];
    float wobK = GUST_WOB_K[k];
    float wobW = GUST_WOB_W[k];
    float wobP = GUST_WOB_P[k];
    float wob = GUST_WOB_A[k] * (sin(c * wobK + tm * wobW + wobP) + GUST_WOB_SECOND * sin(c * wobK * 2.3 - tm * wobW * 1.4 + wobP * 2.0 + 1.0));
    float u = (s - w.speed * tm + wob) / lambda + GUST_TRAIN_OFFSET[k];
    float b = blur / lambda;
    float raw = gustFront(u - floor(u), b);
    float front = raw + (GUST_FRONT_MEAN - raw) * smoothstep(GUST_BLUR_FROM, GUST_BLUR_TO, b);
    float n = sin(TAU * GUST_GATE_STEP[k] * u + c * GUST_GATE_K[k] + tm * GUST_GATE_W[k] + GUST_GATE_P[k]);
    sum += GUST_TRAIN_WEIGHT[k] * smoothstep(w.threshold, w.threshold + GUST_GATE_SOFT, n) * front;
  }
  float g = w.strength * sum / (1.0 + GUST_SOFTCLIP * max(sum, 0.0));
  if (w.nowAge >= 0.0 && w.nowAge < GUST_NOW_LIFE) {
    float at = GUST_NOW_START + GUST_NOW_PACE * w.speed * w.nowAge;
    float d = at - s - GUST_NOW_WOB * sin(c * GUST_NOW_WOB_K + GUST_NOW_WOB_P);
    float edge = GUST_NOW_EDGE + blur;
    float life = smoothstep(0.0, GUST_NOW_RISE, w.nowAge) * (1.0 - smoothstep(GUST_NOW_LIFE * 0.6, GUST_NOW_LIFE, w.nowAge));
    g += GUST_NOW_GAIN * life * smoothstep(0.0, edge, d) * exp(-max(d - edge, 0.0) / GUST_NOW_TAIL);
  }
${
  shape === undefined
    ? ""
    : `  if (w.passAmp > 0.0) {
    float d = w.passFront - s - GUST_NOW_WOB * sin(c * GUST_NOW_WOB_K + GUST_NOW_WOB_P);
    float edge = GUST_PASS_EDGE + blur;
    g += GUST_PASS_GAIN * w.passAmp * smoothstep(0.0, edge, d) * exp(-max(d - edge, 0.0) / GUST_PASS_TAIL);
  }
`
}  return g;
}
`;
}
