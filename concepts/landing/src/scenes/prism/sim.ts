// Newton's prism: a sunbeam through a slowly turning glass prism, traced here on the CPU once per
// frame (the paths are the same for every pixel) and drawn by shader.ts.
//
// Optics, in the plane of the picture. The beam is sampled at PRISM_SAMPLES wavelengths between
// 400 and 690 nm. The glass follows Cauchy's law n(λ) = A + B / λ² (λ in µm), with A chosen so that
// n(550 nm) = N_MID and B set by the dispersion knob (dense flint is B ≈ 0.01). Every ray is carried
// through the prisms face by face:
//   Snell's law       n1 sin θi = n2 sin θt, in vector form;
//   Fresnel           unpolarised reflectance R = (Rs + Rp) / 2: the beam splits into a crossing
//                     share 1 - R and a reflected share R, the faint secondary beams;
//   total internal    past the critical angle nothing crosses and all of it reflects; the crossing
//   reflection        ray is kept at grazing with no power, the limit it tends to, so a colour
//                     fades out smoothly as it is swallowed;
//   beam width        a refracted beam narrows or widens by cos θt / cos θi.
// All wavelengths travel together as a bundle. At every face a bundle splits into what crosses and
// what reflects, and where its rays meet different faces (near a vertex, or a second prism that
// catches only part of the fan) into one bundle per face. Each straight stretch of a bundle is one
// fan for the shader, which integrates it across wavelength between neighbouring samples: the
// spectrum is continuous however wide it spreads, and white where its colours still overlap.
//
// Motion: the prism rocks about minimum deviation (or spins), now and then turning far enough that
// total internal reflection swallows the rainbow; a drag turns it by hand. A second prism, turned
// the other way (Newton's recombination), can slide in along the fan; set close, it backs off along
// the fan while a turn would swing the first prism into it. Newton's shutter can be cut as the
// Manifold M.
//
// Passage (PRISM_PASSAGE): entering, the sunbeam swings about the M's hole from above its rest
// line down onto the glass, so the angle of incidence climbs from total internal reflection to
// rest and the fan sweeps down the wall into place; leaving, the glass turns until total internal
// reflection swallows the colours as the fan is thrown up the wall and off it.
//
// World units: screen heights, origin at the centre of the view, y up; x spans ±aspect / 2.
//
// Textures:
//   uSim0  rgba16f PRISM_ROW × PRISM_FANS, nearest: one fan per row, its header texels (listed
//          below) then one texel per wavelength: origin x, y and sin of the direction in the fan's
//          frame, and power.
//   uSim1  rgba16f STATE_TEXELS × 1, nearest: the prisms, the light source and the M (listed below).
// Values that need more than half precision are stored as two halves (hi + lo), each exactly
// representable, so however the GPU converts the upload it cannot round them.
import { KnobReader, type ParamDef } from "../../params.ts";
import { FixedStep } from "../../sims/clock.ts";
import { clamp, smoothstep } from "../../sims/math.ts";
import { springStep, type Spring } from "../../sims/spring.ts";
import { splitHalf } from "../../sims/half.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { PointerState, SceneSim, SimFactory, SimFrame } from "../types.ts";

export class PrismError extends Error {}

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
/** The prism's symmetry: an equilateral triangle looks the same every third of a turn. */
const THIRD = TAU / 3;

// ---- spectrum ------------------------------------------------------------------------------------

/** Wavelength samples. PRISM_SAMPLES - 1 divides by 2, 3, 4...: the shader can step over faint fans. */
export const PRISM_SAMPLES = 25;
const LAMBDA_MIN = 400;
const LAMBDA_MAX = 690;
/**
 * Out-of-gamut spectral colours are pulled toward white by this share of their most negative
 * channel before clipping, and each colour's peak is lifted by peak^-LIFT, so the dim violet and
 * deep red ends still read.
 */
const SPECTRUM_DESATURATE = 0.5;
const SPECTRUM_LIFT = 0.55;

const WAVELENGTHS: readonly number[] = Array.from(
  { length: PRISM_SAMPLES },
  (_, i) => LAMBDA_MIN + ((LAMBDA_MAX - LAMBDA_MIN) * i) / (PRISM_SAMPLES - 1),
);

function lobe(x: number, mu: number, below: number, above: number): number {
  const s = (x - mu) / (x < mu ? below : above);
  return Math.exp(-0.5 * s * s);
}

/**
 * Pure light of one wavelength (nm) in linear sRGB: the CIE 1931 colour-matching functions after
 * Wyman, Sloan and Shirley's multi-lobe fit ("Simple Analytic Approximations to the CIE XYZ Color
 * Matching Functions", JCGT 2(2), 2013), then XYZ to sRGB primaries.
 */
function spectralRgb(nm: number): [number, number, number] {
  const x =
    1.056 * lobe(nm, 599.8, 37.9, 31.0) +
    0.362 * lobe(nm, 442.0, 16.0, 26.7) -
    0.065 * lobe(nm, 501.1, 20.4, 26.2);
  const y = 0.821 * lobe(nm, 568.8, 46.9, 40.5) + 0.286 * lobe(nm, 530.9, 16.3, 31.1);
  const z = 1.217 * lobe(nm, 437.0, 11.8, 36.0) + 0.681 * lobe(nm, 459.0, 26.0, 13.8);
  return [
    3.2406 * x - 1.5372 * y - 0.4986 * z,
    -0.9689 * x + 1.8758 * y + 0.0415 * z,
    0.0557 * x - 0.204 * y + 1.057 * z,
  ];
}

/**
 * The samples' colours, linear sRGB: gamut-mapped, lifted, softened by a [1 2 1] blur along the
 * spectrum, and scaled per channel so that all of them together (trapezoid rule over the
 * PRISM_SAMPLES - 1 intervals) make white (1, 1, 1).
 */
export const prismSpectrum: readonly (readonly [number, number, number])[] = (() => {
  const lifted = WAVELENGTHS.map((nm): [number, number, number] => {
    const c = spectralRgb(nm);
    const low = Math.min(c[0], c[1], c[2]);
    const lift = low < 0 ? -low * SPECTRUM_DESATURATE : 0;
    const r = Math.max(0, c[0] + lift);
    const g = Math.max(0, c[1] + lift);
    const b = Math.max(0, c[2] + lift);
    const k = Math.max(r, g, b, 1e-6) ** -SPECTRUM_LIFT;
    return [r * k, g * k, b * k];
  });
  const at = (i: number): readonly [number, number, number] =>
    lifted[Math.min(PRISM_SAMPLES - 1, Math.max(0, i))] ?? [0, 0, 0];
  const soft = lifted.map((_, i): [number, number, number] => {
    const a = at(i - 1);
    const b = at(i);
    const c = at(i + 1);
    return [
      0.25 * a[0] + 0.5 * b[0] + 0.25 * c[0],
      0.25 * a[1] + 0.5 * b[1] + 0.25 * c[1],
      0.25 * a[2] + 0.5 * b[2] + 0.25 * c[2],
    ];
  });
  const sum = [0, 0, 0];
  soft.forEach((c, i) => {
    const w = i === 0 || i === PRISM_SAMPLES - 1 ? 0.5 : 1;
    for (let k = 0; k < 3; k++) sum[k] = (sum[k] ?? 0) + w * (c[k] ?? 0);
  });
  const scale = sum.map((s) => (PRISM_SAMPLES - 1) / Math.max(s, 1e-6));
  return soft.map(
    (c) => [c[0] * (scale[0] ?? 1), c[1] * (scale[1] ?? 1), c[2] * (scale[2] ?? 1)] as const,
  );
})();

// ---- texture layout ------------------------------------------------------------------------------

/** Most fans drawn; the brightest are kept. */
export const PRISM_FANS = 16;
/** Header texels in front of each fan's wavelength samples. */
export const PRISM_HEADER = 9;
const PRISM_ROW = PRISM_HEADER + PRISM_SAMPLES;
// Header texels:
//   0  world bounding box, glow included: xmin, ymin, xmax, ymax (xmin > xmax ends the list)
//   1  the fan's frame origin, x and y as hi + lo
//   2  cos and sin of the frame's angle, hi + lo
//   3  start line: nx, ny, c as hi + lo; the fan is where nx x + ny y + c > 0
//   4  end line, likewise (0, 0, 1, 0 when the fan leaves the picture)
//   5  bounds in the fan's frame: xmin, xmax, and y >= a + b x as a, b
//   6  y <= a + b x as a, b; beam half-width; wavelength step (0: white, one band)
//   7  the soft spot where the fan leaves its face: linear rgb, and the fan's kind (PRISM_KIND_*)
//   8  ghost fade k, per screen height: the fan dims as exp(-(k × distance along it)²)

/** Fan kinds: in air, inside prism 1 (or 2: + 1), or the beam from the light source. */
const PRISM_KIND_AIR = 0;
const PRISM_KIND_GLASS = 1;
export const PRISM_KIND_SOURCE = 3;

const STATE_TEXELS = 8;
// State texels:
//   0, 1  prism 1: centre (hi + lo), cos and sin of its turn (hi + lo)
//   2, 3  prism 2, likewise
//   4     circumradius, prism 2 in place (0/1), light inside prism 1 and inside prism 2
//   5     the M shutter's centre (hi + lo)
//   6     beam direction x, y; the M shown 0..1; its height
//   7     the source beam's half-width; the screen's x and whether it is up (0/1)

/** The glow around a beam: half-width as a multiple of the beam's, plus this many dither cells. */
export const PRISM_GLOW_SPREAD = 3;
export const PRISM_GLOW_CELLS = 3;
/** No beam is drawn thinner than this half-width in cells (thinner lines shimmer under the dither). */
export const PRISM_MIN_WIDTH = 1.2;
/** The soft spot where a beam meets glass: radius as a multiple of the beam's half-width, plus cells. */
export const PRISM_CAUSTIC_SPREAD = 2.5;
export const PRISM_CAUSTIC_CELLS = 2;

// ---- layout --------------------------------------------------------------------------------------

/** The sunbeam slants down from the upper left, as through a high window. */
const BEAM_ANGLE = -50 * DEG;
/** Prism centre: screen widths right of the centre, screen heights up. */
const PRISM_X = -0.2;
const PRISM_Y = 0.06;
/** Prism side (screen heights) on a wide screen; narrower screens shrink the whole set-up. */
const PRISM_SIDE = 0.34;
const WIDE_ASPECT = 1.5;
const NARROW_SCALE = 0.6;
/**
 * How far the beam passes from the prism's centre, in sides, toward the edge between the faces it
 * enters and leaves by: both crossings stay near the middle of their faces as the prism rocks.
 */
const BEAM_OFFSET = -0.2;
/** Source beam half-width (screen heights) at beam width 0 and 1. */
const BEAM_THIN = 0.0025;
const BEAM_WIDE = 0.012;
/** The view box rays are followed to, beyond the picture's edge (screen heights). */
const VIEW_MARGIN = 0.05;
/** The screen the spectrum can land on: this far in from the picture's right edge (screen heights). */
const SCREEN_INSET = 0.09;
/** The screen, as a face index after the prisms' six. */
const SCREEN = 6;

// ---- glass ---------------------------------------------------------------------------------------

/** Refractive index at 550 nm, a dense flint. */
const N_MID = 1.62;
/** Cauchy's B (µm²) at dispersion 0 and 1: dense flint is about 0.01; the top is an impossible glass. */
const CAUCHY_MIN = 0.008;
const CAUCHY_MAX = 0.06;
/** Partial reflections are drawn this many times their share at reflections 1. */
const GHOST_GAIN = 2.5;
/** Partial reflections fade along their length (as a Gaussian), to 1/e over this distance (screen heights). */
const GHOST_FADE = 0.14;
/** Weakest light that still makes a fan, faces a ray may meet, and the pools. */
const FAN_MIN = 0.008;
const MAX_DEPTH = 7;
const BUNDLE_POOL = 48;
const FAN_POOL = 40;
/** A refracted beam is never widened past this many source widths (grazing entry). */
const WIDTH_CAP = 6;
const EPS = 1e-7;

// ---- motion --------------------------------------------------------------------------------------

/** The rock, as the angle of incidence on the entry face: this far below minimum deviation to this far above. */
const ROCK_BELOW = 5 * DEG;
const ROCK_ABOVE = 10 * DEG;
/** Seconds per rock at speed 0 and 1 (geometric in between). */
const ROCK_SLOW = 300;
const ROCK_FAST = 45;
/** Spin rate (rad/s) at speed 0 and 1 (geometric in between). */
const SPIN_SLOW = 0.15 * DEG;
const SPIN_FAST = 3 * DEG;
/** An eclipse turns the prism this far past the reddest light's critical angle: turn in, hold, turn back (s). */
const ECLIPSE_PAST = 5 * DEG;
const ECLIPSE_IN = 16;
const ECLIPSE_HOLD = 8;
const ECLIPSE_OUT = 16;
const ECLIPSE_LENGTH = ECLIPSE_IN + ECLIPSE_HOLD + ECLIPSE_OUT;
/** Seconds between eclipses at frequency 0 and 1 (geometric, ±15%), and the share of one before the first. */
const ECLIPSE_RARE = 420;
const ECLIPSE_OFTEN = 75;
const ECLIPSE_FIRST = 0.45;
/**
 * Second prism: gap along the fan (screen heights) at gap 0 and 1, the time it takes to follow a
 * change of set-up, slide time and a visit. It slides in along the fan from just beyond the picture.
 */
const GAP_NEAR = 0.03;
const GAP_FAR = 0.5;
const SETTLE = 0.8;
const SLIDE = 4;
const VISIT = 40;
/**
 * The least the second prism stands from the first (screen heights, on a wide screen): an eclipse
 * or a drag can turn the first prism far enough to swing its faces through a close-set second one,
 * which then backs off along the fan to keep this gap (#backOff). An eclipse at the default gap and
 * dispersion brings them no closer than about 0.005, so that set-up never moves.
 */
const CLEARANCE = 0.004;
/** M shutter: distance up the beam from the prism, height at size 0 and 1, fade time and a visit. */
const MARK_DISTANCE = 0.42;
const MARK_SMALL = 0.06;
const MARK_LARGE = 0.13;
const MARK_FADE = 2.5;
const MARK_VISIT = 24;
/**
 * A released prism returns to its rock (critically damped, s), on springStep at RETURN_STEP on a
 * FixedStep and drawn between its last two steps; or, spinning, coasts to a stop (s).
 */
const RETURN = 2.5;
const RETURN_STEP = 1 / 60;
const COAST = 1.5;
/** Drags within this radius of the prism's centre (screen heights) barely turn it. */
const GRIP_INNER = 0.03;
const GRIP_OUTER = 0.12;
/** Longest step simulated at once. */
const MAX_STEP = 0.1;

// ---- passage -------------------------------------------------------------------------------------

/** Seconds of the scene's entrance and exit (SceneDef.passage). */
export const PRISM_PASSAGE = { enter: 2.8, exit: 1.6 } as const;
/**
 * Entrance: the sunbeam starts turned this far above its rest direction, pivoting about the M's
 * hole, so it skims over the glass and lands on the wall; it swings down onto the prism, the
 * angle of incidence climbing and the colours coming out of total internal reflection (red first)
 * as the fan swings down the wall to its place, overshooting a little and settling.
 */
const ENTER_SWEEP = 26 * DEG;
const ENTER_SETTLE = 1.1;
/** Exit: the glass turns this far (incidence falling), throwing the fan up the wall and off it as total internal reflection swallows the colours. */
const EXIT_TURN = 26 * DEG;

/** Ease-out with a small overshoot: 0 → 1, passing 1 by a few per cent on the way to rest. */
const settleBack = (p: number): number =>
  1 + (ENTER_SETTLE + 1) * (p - 1) ** 3 + ENTER_SETTLE * (p - 1) ** 2;

/** An angle wrapped into (-span / 2, span / 2]. */
const wrap = (angle: number, span: number): number => angle - span * Math.round(angle / span);

/** Unpolarised Fresnel reflectance from index n1 into n2. */
function fresnel(n1: number, n2: number, cosI: number, cosT: number): number {
  const s = (n1 * cosI - n2 * cosT) / (n1 * cosI + n2 * cosT);
  const p = (n1 * cosT - n2 * cosI) / (n1 * cosT + n2 * cosI);
  return 0.5 * (s * s + p * p);
}

/** The prism's index at wavelength nm for Cauchy's B. */
const cauchy = (nm: number, b: number): number => N_MID + b * (1e6 / (nm * nm) - 1 / 0.3025);

/** The angle of incidence below which light of index n cannot leave by the second face (60° apex). */
const swallowedBelow = (n: number): number =>
  Math.asin(clamp(n * Math.sin(Math.PI / 3 - Math.asin(1 / n)), -1, 1));

// ---- rays ----------------------------------------------------------------------------------------

class Ray {
  x = 0;
  y = 0;
  dx = 1;
  dy = 0;
  /** Share of the beam's light, partial reflections drawn at the reflections knob's gain. */
  power = 0;
  /** Beam half-width. */
  width = 0;
  /** The face it meets next (prism * 3 + side), or -1 if it leaves the picture. */
  face = -1;
  /** Distance to that face, or to the edge of the view. */
  t = 0;

  copyPath(from: Ray): void {
    this.x = from.x;
    this.y = from.y;
    this.dx = from.dx;
    this.dy = from.dy;
    this.width = from.width;
    this.face = from.face;
    this.t = from.t;
  }
}

const rayList = (): Ray[] => Array.from({ length: PRISM_SAMPLES }, () => new Ray());

/** One ray per wavelength, travelling together. */
class Bundle {
  readonly rays = rayList();
  /** The prism the rays travel inside, or -1 in air. */
  medium = -1;
  /** The face they start from, or -1 at the light source. */
  face = -1;
  depth = 0;
  /** Share of its light that came by partial reflection: such ghosts fade along their length. */
  ghost = 0;
}

class Face {
  ax = 0;
  ay = 0;
  /** Unit tangent from its first vertex to its second. */
  tx = 1;
  ty = 0;
  /** Outward unit normal. */
  nx = 0;
  ny = -1;
  length = 0;
  prism = 0;
  active = false;
}

/** A straight stretch of a bundle, as the shader draws it. */
class Fan {
  readonly rays = rayList();
  kind = PRISM_KIND_AIR;
  startX = 0;
  startY = 0;
  startC = 0;
  endX = 0;
  endY = 0;
  endC = 1;
  width = 0;
  weight = 0;
  /** Average power times length (for the glow of light inside the glass). */
  flux = 0;
  ghost = 0;
}

const byWeight = (a: Fan, b: Fan): number => b.weight - a.weight;

// ---- the simulation ------------------------------------------------------------------------------

type KnobKey =
  | "turn"
  | "speed"
  | "dispersion"
  | "beam"
  | "eclipse"
  | "second"
  | "reflections"
  | "mark"
  | "screen";

class PrismSim implements SceneSim {
  readonly #fanTexture: DataTexture;
  readonly #stateTexture: DataTexture;
  readonly #fanData = new Float32Array(PRISM_ROW * PRISM_FANS * 4);
  readonly #stateData = new Float32Array(STATE_TEXELS * 4);
  readonly #knobs: KnobReader<KnobKey>;
  readonly #eclipseTrigger: number;
  readonly #secondTrigger: number;
  readonly #markTrigger: number;

  readonly #faces: Face[] = Array.from({ length: 6 }, () => new Face());
  readonly #bundles: Bundle[] = Array.from({ length: BUNDLE_POOL }, () => new Bundle());
  readonly #free: Bundle[] = [];
  readonly #work: Bundle[] = [];
  readonly #fans: Fan[] = Array.from({ length: FAN_POOL }, () => new Fan());
  readonly #order: Fan[] = [];
  #fanCount = 0;
  readonly #index = new Float64Array(PRISM_SAMPLES);
  readonly #nearest = new Int32Array(PRISM_SAMPLES);
  readonly #groups = new Int32Array(9);
  readonly #local = new Float64Array(PRISM_SAMPLES * 4);
  readonly #glow = new Float64Array(2);
  /** Where the middle of the spectrum leaves prism 1 at minimum deviation: x, y, direction. */
  readonly #exit = new Float64Array(4);

  // Knobs.
  #spinning = false;
  #speed = 0.35;
  #cauchyB = CAUCHY_MIN;
  #ghost = 1;
  #eclipseRate = 0;
  #gap = 0.4;
  #secondOn = false;
  #markSize = 0.5;
  #markOn = false;
  #beam = 0.3;
  #screenOn = false;

  // Layout.
  #aspect = 16 / 9;
  #cell = 1 / 540;
  #scale = 1;
  #side = PRISM_SIDE;
  #centreX = 0;
  #centreY = 0;
  #beamDX = Math.cos(BEAM_ANGLE);
  #beamDY = Math.sin(BEAM_ANGLE);
  #sourceX = 0;
  #sourceY = 0;
  #markX = 0;
  #markY = 0;
  #beamWidth = BEAM_THIN;
  /** The sunbeam as traced and drawn: the rest line, or swung about the M's hole while entering. */
  #lightX = 0;
  #lightY = 0;
  #lightDX = Math.cos(BEAM_ANGLE);
  #lightDY = Math.sin(BEAM_ANGLE);
  /** The prism's extra turn while it leaves (radians, 0 at rest). */
  #leaveTurn = 0;
  #screenX = 0;

  // Motion.
  #clock = 0;
  #rock = 0;
  #spin = 0;
  #base = Number.NaN;
  #wasSpinning = false;
  #user = 0;
  #userVelocity = 0;
  /** Springing back to the rock: #user a step before, the spring's clock and its scratch. */
  #returning = false;
  #userWas = 0;
  readonly #returnSteps = new FixedStep(RETURN_STEP, Math.ceil(MAX_STEP / RETURN_STEP));
  readonly #returnSpring: Spring = { x: 0, v: 0 };
  #dragging = false;
  #dragAngle = 0;
  #eclipseAge = Number.POSITIVE_INFINITY;
  #eclipseTarget = 0;
  #eclipseNow = false;
  #eclipses = 0;
  #nextEclipse = Number.NaN;
  #secondShown = 0;
  #secondVisit = 0;
  #markShown = 0;
  #markVisit = 0;
  #angle = 0;
  #secondX = 0;
  #secondY = 0;
  #restX = Number.NaN;
  #restY = 0;
  #secondActive = false;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#knobs = new KnobReader<KnobKey>("prism", params, [
      "turn",
      "speed",
      "dispersion",
      "beam",
      "eclipse",
      "second",
      "reflections",
      "mark",
      "screen",
    ]);
    this.#eclipseTrigger = this.#knobs.trigger("eclipse");
    this.#secondTrigger = this.#knobs.trigger("second");
    this.#markTrigger = this.#knobs.trigger("mark");
    this.#free.push(...this.#bundles);
    this.#fanTexture = new DataTexture(gl, {
      width: PRISM_ROW,
      height: PRISM_FANS,
      format: "rgba16f",
      filter: "nearest",
    });
    this.#stateTexture = new DataTexture(gl, {
      width: STATE_TEXELS,
      height: 1,
      format: "rgba16f",
      filter: "nearest",
    });
    // Rocking or spinning, the prism starts at minimum deviation, the fan at rest, swinging away
    // from the eclipse.
    this.#rock = Math.asin(-(ROCK_ABOVE - ROCK_BELOW) / (ROCK_ABOVE + ROCK_BELOW));
    this.#spin = this.#turnFor(this.#minimumDeviation());
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    this.#readKnobs(frame);
    this.#layout(frame);
    this.#fire(frame.fired);
    const dt = clamp(frame.dt, 0, MAX_STEP);
    this.#advance(dt, clamp(frame.motion, 0, 1), frame.pointer);
    this.#place(dt);
    this.#trace();
    this.#pack();
    this.#fanTexture.upload(this.#fanData);
    this.#stateTexture.upload(this.#stateData);
    return [this.#fanTexture.texture, this.#stateTexture.texture];
  }

  dispose(): void {
    this.#fanTexture.dispose();
    this.#stateTexture.dispose();
  }

  // ---- knobs, layout, triggers -----------------------------------------------------------------

  #readKnobs(frame: SimFrame): void {
    const knobs = this.#knobs;
    this.#spinning = knobs.value(frame, "turn") > 0.5;
    this.#speed = clamp(knobs.value(frame, "speed"), 0, 1);
    this.#cauchyB =
      CAUCHY_MIN + (CAUCHY_MAX - CAUCHY_MIN) * clamp(knobs.value(frame, "dispersion"), 0, 1);
    this.#ghost = GHOST_GAIN * clamp(knobs.value(frame, "reflections"), 0, 1);
    this.#eclipseRate = clamp(knobs.value(frame, "eclipse"), 0, 1);
    const second = knobs.value(frame, "second");
    this.#secondOn = second > 0;
    // A feature's amount reads even while it is off: its "now" button still plays one.
    this.#gap = clamp(this.#secondOn ? second : knobs.amount(frame, "second"), 0, 1);
    const mark = knobs.value(frame, "mark");
    this.#markOn = mark > 0;
    this.#markSize = clamp(this.#markOn ? mark : knobs.amount(frame, "mark"), 0, 1);
    this.#beam = clamp(knobs.value(frame, "beam"), 0, 1);
    this.#screenOn = knobs.value(frame, "screen") > 0;
    for (let i = 0; i < PRISM_SAMPLES; i++)
      this.#index[i] = cauchy(WAVELENGTHS[i] ?? 550, this.#cauchyB);
  }

  #layout(frame: SimFrame): void {
    if (frame.aspect > 0) this.#aspect = frame.aspect;
    if (frame.height > 0) this.#cell = 1 / frame.height;
    this.#scale = clamp(this.#aspect / WIDE_ASPECT, NARROW_SCALE, 1);
    this.#side = PRISM_SIDE * this.#scale;
    this.#centreX = PRISM_X * this.#aspect;
    this.#centreY = PRISM_Y;
    this.#beamWidth = (BEAM_THIN + (BEAM_WIDE - BEAM_THIN) * this.#beam) * this.#scale;
    this.#screenX = this.#aspect / 2 - SCREEN_INSET * this.#scale;
    // The beam's line passes the centre at BEAM_OFFSET sides; the source is far up it, off screen.
    const dx = this.#beamDX;
    const dy = this.#beamDY;
    const offset = BEAM_OFFSET * this.#side;
    const px = this.#centreX - dy * offset;
    const py = this.#centreY + dx * offset;
    this.#sourceX = px - 4 * dx;
    this.#sourceY = py - 4 * dy;
    // The M sits up the beam, kept inside the picture.
    const half =
      0.5 * (MARK_SMALL + (MARK_LARGE - MARK_SMALL) * this.#markSize) * this.#scale + 0.04;
    const reachX =
      dx < 0
        ? (this.#aspect / 2 - half - px) / -dx
        : dx > 0
          ? (px + this.#aspect / 2 - half) / dx
          : Number.POSITIVE_INFINITY;
    const reachY =
      dy < 0 ? (0.5 - half - py) / -dy : dy > 0 ? (py + 0.5 - half) / dy : Number.POSITIVE_INFINITY;
    const along = clamp(
      Math.min(MARK_DISTANCE * this.#scale, reachX, reachY),
      0.6 * this.#side,
      MARK_DISTANCE,
    );
    this.#markX = px - dx * along;
    this.#markY = py - dy * along;
    // Passage. Entering, the beam swings about the M's hole from above its rest line down onto
    // the glass; leaving, the glass turns away (see #advance). At rest both are exactly off.
    const enter = frame.passage.enter;
    const leave = frame.passage.exit;
    this.#lightX = this.#sourceX;
    this.#lightY = this.#sourceY;
    this.#lightDX = dx;
    this.#lightDY = dy;
    if (enter < 1) {
      const swing = BEAM_ANGLE + ENTER_SWEEP * (1 - settleBack(clamp(enter, 0, 1)));
      this.#lightDX = Math.cos(swing);
      this.#lightDY = Math.sin(swing);
      this.#lightX = this.#markX - (4 - along) * this.#lightDX;
      this.#lightY = this.#markY - (4 - along) * this.#lightDY;
    }
    // Leaving, the glass turns ever faster (ease-in), still at full speed as the exit ends.
    this.#leaveTurn = leave > 0 ? -EXIT_TURN * leave * leave : 0;
  }

  /** A "now" button fires its feature's one occurrence at once (frame.fired is true on the frame after the press). */
  #fire(fired: readonly boolean[]): void {
    if (fired[this.#eclipseTrigger] === true) this.#startEclipse(true);
    if (fired[this.#secondTrigger] === true) this.#secondVisit = VISIT;
    if (fired[this.#markTrigger] === true) this.#markVisit = MARK_VISIT;
  }

  // ---- motion ----------------------------------------------------------------------------------

  /** Incidence on the entry face at minimum deviation for the middle of the spectrum. */
  #minimumDeviation(): number {
    return Math.asin(N_MID / 2);
  }

  /** The prism's turn for an angle of incidence on its entry face (the beam is fixed). */
  #turnFor(incidence: number): number {
    // Face 0's outward normal points at the prism's turn + 150°; the light arrives from BEAM_ANGLE + 180°.
    return incidence + BEAM_ANGLE + Math.PI / 6;
  }

  /** Where the prism would be now without hands or eclipses. */
  #restingTurn(): number {
    if (this.#spinning) return this.#spin;
    const mid = this.#minimumDeviation() + (ROCK_ABOVE - ROCK_BELOW) / 2;
    const amp = (ROCK_ABOVE + ROCK_BELOW) / 2;
    return this.#turnFor(mid + amp * Math.sin(this.#rock));
  }

  /** Begins an eclipse: the prism turns until the reddest light can no longer leave by its second face. */
  #startEclipse(now: boolean): void {
    if (this.#eclipseAge < ECLIPSE_LENGTH) return;
    const red = cauchy(LAMBDA_MAX, this.#cauchyB);
    const target = this.#turnFor(swallowedBelow(red) - ECLIPSE_PAST);
    const from = this.#restingTurn() + this.#user;
    this.#eclipseAge = 0;
    this.#eclipseNow = now;
    // The equivalent pose nearest where the prism is, so it never turns the long way round.
    this.#eclipseTarget = from + wrap(target - from, THIRD);
    this.#eclipses++;
  }

  #eclipseEnvelope(): number {
    const age = this.#eclipseAge;
    if (age < ECLIPSE_IN) return smoothstep(0, 1, age / ECLIPSE_IN);
    if (age < ECLIPSE_IN + ECLIPSE_HOLD) return 1;
    if (age < ECLIPSE_LENGTH) return smoothstep(0, 1, (ECLIPSE_LENGTH - age) / ECLIPSE_OUT);
    return 0;
  }

  #advance(dt: number, motion: number, pointer: PointerState): void {
    const calm = dt * motion;
    this.#clock += calm;
    const speed = this.#speed;
    this.#rock += (calm * TAU) / (ROCK_SLOW * (ROCK_FAST / ROCK_SLOW) ** speed);
    this.#spin += calm * SPIN_SLOW * (SPIN_FAST / SPIN_SLOW) ** speed;

    // Switching between rock and spin hands the difference to the user offset, so nothing jumps.
    const base = this.#restingTurn();
    if (Number.isFinite(this.#base) && this.#spinning !== this.#wasSpinning) {
      const handed = wrap(this.#base - base, THIRD);
      this.#user += handed;
      this.#userWas += handed;
    }
    this.#wasSpinning = this.#spinning;
    this.#base = base;

    // Eclipses come on their own while rocking; "now" plays one at any time, even with motion off.
    const interval = ECLIPSE_RARE * (ECLIPSE_OFTEN / ECLIPSE_RARE) ** this.#eclipseRate;
    if (Number.isNaN(this.#nextEclipse)) this.#nextEclipse = ECLIPSE_FIRST * interval;
    if (
      this.#eclipseRate > 0 &&
      !this.#spinning &&
      !this.#dragging &&
      this.#clock >= this.#nextEclipse &&
      this.#eclipseAge >= ECLIPSE_LENGTH
    ) {
      this.#startEclipse(false);
      const jitter = 0.85 + 0.3 * ((Math.imul(this.#eclipses, 0x9e3779b1) >>> 0) / 4294967296);
      this.#nextEclipse = this.#clock + interval * jitter;
    }
    if (this.#eclipseRate <= 0 && this.#clock >= this.#nextEclipse)
      this.#nextEclipse = this.#clock + interval;
    if (this.#eclipseAge < ECLIPSE_LENGTH) this.#eclipseAge += this.#eclipseNow ? dt : calm;

    this.#turnByHand(dt, pointer);

    const pose = base + this.#drawnUser();
    const shade = this.#eclipseEnvelope();
    this.#angle = pose + shade * (this.#eclipseTarget - pose) + this.#leaveTurn;

    // The second prism and the M slide and fade on the scene clock, whatever the motion.
    this.#secondVisit = Math.max(0, this.#secondVisit - dt);
    this.#markVisit = Math.max(0, this.#markVisit - dt);
    const secondWanted = this.#secondOn || this.#secondVisit > 0 ? 1 : 0;
    const markWanted = this.#markOn || this.#markVisit > 0 ? 1 : 0;
    this.#secondShown = clamp(
      this.#secondShown + Math.sign(secondWanted - this.#secondShown) * (dt / SLIDE),
      0,
      1,
    );
    this.#markShown = clamp(
      this.#markShown + Math.sign(markWanted - this.#markShown) * (dt / MARK_FADE),
      0,
      1,
    );
  }

  /**
   * Dragging turns the prism about its centre. Let go, a rocking prism springs back to its rock
   * (critically damped); a spinning one keeps the turn and coasts to a stop.
   */
  #turnByHand(dt: number, pointer: PointerState): void {
    const x = (pointer.x - 0.5) * this.#aspect - this.#centreX;
    const y = pointer.y - 0.5 - this.#centreY;
    const held = pointer.down && pointer.inside;
    this.#returning = false;
    if (held) {
      const angle = Math.atan2(y, x);
      if (!this.#dragging) {
        this.#dragging = true;
        this.#userVelocity = 0;
        // A hand on the prism ends an eclipse where it stands.
        const shade = this.#eclipseEnvelope();
        if (shade > 0) this.#user += shade * (this.#eclipseTarget - (this.#base + this.#user));
        this.#eclipseAge = Number.POSITIVE_INFINITY;
      } else {
        const grip = smoothstep(0, 1, (Math.hypot(x, y) - GRIP_INNER) / (GRIP_OUTER - GRIP_INNER));
        const turn = wrap(angle - this.#dragAngle, TAU) * grip;
        this.#user += turn;
        if (dt > 0) this.#userVelocity += (turn / dt - this.#userVelocity) * Math.min(1, dt / 0.1);
      }
      this.#dragAngle = angle;
      this.#settleReturn();
      return;
    }
    this.#dragging = false;
    if (this.#spinning) {
      if (dt > 0) {
        this.#user += this.#userVelocity * dt;
        this.#userVelocity *= Math.exp(-dt / COAST);
        this.#user = wrap(this.#user, TAU * 3);
      }
      this.#settleReturn();
      return;
    }
    // Critically damped return.
    this.#returning = true;
    const spring = this.#returnSpring;
    for (let i = 0, n = this.#returnSteps.advance(dt); i < n; i++) {
      this.#userWas = this.#user;
      spring.x = this.#user;
      spring.v = this.#userVelocity;
      springStep(spring, 0, 1 / RETURN, 1, RETURN_STEP);
      this.#user = spring.x;
      this.#userVelocity = spring.v;
    }
  }

  /** The hand's offset is drawn as it is (no spring between steps); the next return starts afresh. */
  #settleReturn(): void {
    this.#userWas = this.#user;
    this.#returnSteps.reset();
  }

  /** The hand's offset as drawn: springing back, between its last two steps. */
  #drawnUser(): number {
    if (!this.#returning) return this.#user;
    return this.#userWas + (this.#user - this.#userWas) * this.#returnSteps.alpha;
  }

  // ---- geometry --------------------------------------------------------------------------------

  #faceAt(f: number): Face {
    const face = this.#faces[f];
    if (face === undefined) throw new PrismError(`prism: no face ${f}`);
    return face;
  }

  /** Lays out prism k's three faces (counter-clockwise, face m from vertex m to m + 1). */
  #setPrism(k: number, cx: number, cy: number, turn: number, active: boolean): void {
    const radius = this.#side / Math.sqrt(3);
    for (let m = 0; m < 3; m++) {
      const a0 = turn + Math.PI / 2 + m * THIRD;
      const a1 = a0 + THIRD;
      const ax = cx + radius * Math.cos(a0);
      const ay = cy + radius * Math.sin(a0);
      const bx = cx + radius * Math.cos(a1);
      const by = cy + radius * Math.sin(a1);
      const face = this.#faceAt(3 * k + m);
      const length = Math.hypot(bx - ax, by - ay);
      face.ax = ax;
      face.ay = ay;
      face.tx = (bx - ax) / length;
      face.ty = (by - ay) / length;
      face.nx = face.ty;
      face.ny = -face.tx;
      face.length = length;
      face.prism = k;
      face.active = active;
    }
  }

  /**
   * Where the middle of the spectrum leaves prism 1 at minimum deviation: the second prism is that
   * prism turned half round about a point further along this ray, so every colour it catches leaves
   * parallel to the incoming beam again. Writes the exit point and direction to `out`.
   */
  #centralExit(out: Float64Array): boolean {
    this.#setPrism(0, this.#centreX, this.#centreY, this.#turnFor(this.#minimumDeviation()), true);
    this.#faceAt(3).active = false;
    this.#faceAt(4).active = false;
    this.#faceAt(5).active = false;
    const probe = this.#free.pop();
    if (probe === undefined) return false;
    probe.medium = -1;
    probe.face = -1;
    const ray = probe.rays[0];
    let ok = false;
    if (ray !== undefined) {
      ray.x = this.#sourceX;
      ray.y = this.#sourceY;
      ray.dx = this.#beamDX;
      ray.dy = this.#beamDY;
      for (let pass = 0; pass < 2; pass++) {
        this.#aim(ray, probe);
        if (ray.face < 0) break;
        const face = this.#faceAt(ray.face);
        const entering = probe.medium < 0;
        const mx = entering ? face.nx : -face.nx;
        const my = entering ? face.ny : -face.ny;
        const eta = entering ? 1 / N_MID : N_MID;
        const cosI = -(ray.dx * mx + ray.dy * my);
        const k = 1 - eta * eta * (1 - cosI * cosI);
        if (k < 0) break;
        const cosT = Math.sqrt(k);
        ray.x += ray.dx * ray.t;
        ray.y += ray.dy * ray.t;
        const dx = eta * ray.dx + (eta * cosI - cosT) * mx;
        const dy = eta * ray.dy + (eta * cosI - cosT) * my;
        ray.dx = dx;
        ray.dy = dy;
        probe.medium = entering ? face.prism : -1;
        probe.face = ray.face;
        if (pass === 1) {
          out[0] = ray.x;
          out[1] = ray.y;
          out[2] = dx;
          out[3] = dy;
          ok = true;
        }
      }
    }
    this.#free.push(probe);
    return ok;
  }

  /** Both prisms' poses for this frame. */
  #place(dt: number): void {
    // The second prism: set up for minimum deviation, turning in step with the first.
    const exit = this.#exit;
    let active = this.#secondShown > 0 && this.#centralExit(exit);
    this.#setPrism(0, this.#centreX, this.#centreY, this.#angle, true);
    if (active) {
      const radius = this.#side / Math.sqrt(3);
      const ex = exit[0] ?? 0;
      const ey = exit[1] ?? 0;
      const ux = exit[2] ?? 1;
      const uy = exit[3] ?? 0;
      // Half the gap along the ray is the centre of symmetry. Spinning, it must stay clear of
      // prism 1 at any turn; rocking, the prisms may stand close, and the second backs off only
      // while a turn (an eclipse, a drag) would swing the first one's faces into it (#backOff).
      let half = 0.5 * (GAP_NEAR + (GAP_FAR - GAP_NEAR) * this.#gap) * this.#scale;
      if (this.#spinning) {
        const vx = ex - this.#centreX;
        const vy = ey - this.#centreY;
        const clear = 1.05 * radius;
        const along = vx * ux + vy * uy;
        half = Math.max(
          half,
          -along + Math.sqrt(Math.max(0, along * along - (vx * vx + vy * vy - clear * clear))),
        );
      }
      const restX = 2 * (ex + ux * half) - this.#centreX;
      const restY = 2 * (ey + uy * half) - this.#centreY;
      // A change of set-up (gap, motion, screen) moves it over a moment rather than at once.
      const follow =
        Number.isNaN(this.#restX) || this.#secondShown < 1 ? 1 : 1 - Math.exp(-dt / SETTLE);
      this.#restX = Number.isNaN(this.#restX)
        ? restX
        : this.#restX + (restX - this.#restX) * follow;
      this.#restY += (restY - this.#restY) * follow;
      // Prism 2 is prism 1 mirrored through the centre of symmetry, so moving it along the fan keeps
      // every colour leaving parallel to the sunbeam: it slides in that way from just beyond the
      // picture, recombining the colours as it comes and never passing through the first prism.
      const slide =
        this.#beyondView(this.#restX, this.#restY, radius, ux, uy) *
        (1 - smoothstep(0, 1, this.#secondShown));
      const x = this.#restX + slide * ux;
      const y = this.#restY + slide * uy;
      const back = this.#backOff(0.5 * (x + this.#centreX), 0.5 * (y + this.#centreY), ux, uy);
      this.#secondX = x + 2 * back * ux;
      this.#secondY = y + 2 * back * uy;
      active =
        Math.abs(this.#secondX) < this.#aspect / 2 + VIEW_MARGIN + radius &&
        Math.abs(this.#secondY) < 0.5 + VIEW_MARGIN + radius;
    }
    this.#secondActive = active;
    this.#setPrism(1, this.#secondX, this.#secondY, this.#angle + Math.PI, active);
  }

  /** How far a circle of radius r at (x, y) must move along (ux, uy) to lie wholly beyond the view (0 if it already does). */
  #beyondView(x: number, y: number, r: number, ux: number, uy: number): number {
    const hx = this.#aspect / 2 + VIEW_MARGIN + r;
    const hy = 0.5 + VIEW_MARGIN + r;
    const sx = ux > 1e-9 ? (hx - x) / ux : ux < -1e-9 ? (-hx - x) / ux : Number.POSITIVE_INFINITY;
    const sy = uy > 1e-9 ? (hy - y) / uy : uy < -1e-9 ? (-hy - y) / uy : Number.POSITIVE_INFINITY;
    return Math.max(0, Math.min(sx, sy));
  }

  /**
   * How far the centre of symmetry (sx, sy) must move along the fan (ux, uy) to stand half of
   * CLEARANCE outside one of prism 1's faces as it is turned now (faces 0..2 in place); 0 when it
   * already does. A point that far outside a face of the first prism puts its mirror image, the
   * second prism, twice as far beyond that face.
   */
  #backOff(sx: number, sy: number, ux: number, uy: number): number {
    const clear = 0.5 * CLEARANCE * this.#scale;
    let outside = Number.NEGATIVE_INFINITY;
    let back = Number.POSITIVE_INFINITY;
    for (let m = 0; m < 3; m++) {
      const face = this.#faceAt(m);
      const height = face.nx * (sx - face.ax) + face.ny * (sy - face.ay);
      outside = Math.max(outside, height);
      const rate = face.nx * ux + face.ny * uy;
      if (rate > 1e-6) back = Math.min(back, (clear - height) / rate);
    }
    return outside >= clear || !Number.isFinite(back) ? 0 : back;
  }

  // ---- tracing ---------------------------------------------------------------------------------

  #trace(): void {
    this.#fanCount = 0;
    this.#glow[0] = 0;
    this.#glow[1] = 0;
    const source = this.#free.pop();
    if (source === undefined) return;
    source.medium = -1;
    source.face = -1;
    source.depth = 0;
    source.ghost = 0;
    for (const ray of source.rays) {
      ray.x = this.#lightX;
      ray.y = this.#lightY;
      ray.dx = this.#lightDX;
      ray.dy = this.#lightDY;
      ray.power = 1;
      ray.width = this.#beamWidth;
    }
    const work = this.#work;
    work.length = 0;
    work.push(source);
    for (let bundle = work.pop(); bundle !== undefined; bundle = work.pop()) {
      this.#follow(bundle);
      this.#free.push(bundle);
    }
  }

  /** Sends every ray of a bundle to the next face it meets, and splits the bundle there. */
  #follow(bundle: Bundle): void {
    for (const ray of bundle.rays) this.#aim(ray, bundle);
    // One fan per face met (usually all rays meet the same one), and one for rays that leave.
    const groups = this.#groups;
    let count = 0;
    for (const ray of bundle.rays) {
      if (ray.power <= 0) continue;
      let known = false;
      for (let g = 0; g < count; g++) if (groups[g] === ray.face) known = true;
      if (!known && count < groups.length) groups[count++] = ray.face;
    }
    for (let g = 0; g < count; g++) {
      const face = groups[g] ?? -1;
      let peak = 0;
      for (const ray of bundle.rays) if (ray.face === face) peak = Math.max(peak, ray.power);
      if (peak < FAN_MIN) continue;
      this.#nearestMembers(bundle.rays, face);
      this.#emit(bundle, face, peak);
      if (face >= 0 && face !== SCREEN && bundle.depth < MAX_DEPTH) this.#cross(bundle, face);
    }
  }

  /** The face a ray meets next: inside glass, the nearer of the prism's other faces; in air, any face turned toward it. */
  #aim(ray: Ray, bundle: Bundle): void {
    ray.face = -1;
    ray.t = Number.POSITIVE_INFINITY;
    const inside = bundle.medium;
    const left = inside < 0 && bundle.face >= 0 ? this.#faceAt(bundle.face).prism : -1;
    for (let f = 0; f < this.#faces.length; f++) {
      const face = this.#faceAt(f);
      if (!face.active) continue;
      if (inside >= 0) {
        if (face.prism !== inside || f === bundle.face) continue;
      } else if (face.prism === left || ray.dx * face.nx + ray.dy * face.ny >= 0) {
        continue;
      }
      const den = ray.dx * face.ty - ray.dy * face.tx;
      if (Math.abs(den) < 1e-12) continue;
      const rx = face.ax - ray.x;
      const ry = face.ay - ray.y;
      const t = (rx * face.ty - ry * face.tx) / den;
      if (t <= EPS || t >= ray.t) continue;
      if (inside < 0) {
        const u = (rx * ray.dy - ry * ray.dx) / den;
        if (u < 0 || u > face.length) continue;
      }
      ray.t = t;
      ray.face = f;
    }
    // The screen, when it is up, catches whatever reaches it in air.
    if (inside < 0 && this.#screenOn && ray.dx > 1e-9) {
      const t = (this.#screenX - ray.x) / ray.dx;
      if (t > EPS && t < ray.t) {
        ray.t = t;
        ray.face = SCREEN;
      }
    }
    if (ray.face < 0) ray.t = this.#exitDistance(ray);
  }

  /** Distance along a ray to where it leaves the view (0 if it never crosses it); slab clipping. */
  #exitDistance(ray: Ray): number {
    const hx = this.#aspect / 2 + VIEW_MARGIN;
    const hy = 0.5 + VIEW_MARGIN;
    if (
      (Math.abs(ray.dx) < 1e-12 && Math.abs(ray.x) > hx) ||
      (Math.abs(ray.dy) < 1e-12 && Math.abs(ray.y) > hy)
    )
      return 0;
    const ax = (-hx - ray.x) / ray.dx;
    const bx = (hx - ray.x) / ray.dx;
    const ay = (-hy - ray.y) / ray.dy;
    const by = (hy - ray.y) / ray.dy;
    // A zero direction component gives ±Infinity here, which leaves that slab unbounded.
    const enter = Math.max(0, Math.min(ax, bx), Math.min(ay, by));
    const leave = Math.min(10, Math.max(ax, bx), Math.max(ay, by));
    return leave > enter ? leave : 0;
  }

  /** For every ray, the nearest ray (by wavelength) of the group meeting `face`. */
  #nearestMembers(rays: readonly Ray[], face: number): void {
    const nearest = this.#nearest;
    let last = -1;
    for (let i = 0; i < PRISM_SAMPLES; i++) {
      if (rays[i]?.face === face) last = i;
      nearest[i] = last;
    }
    let next = -1;
    for (let i = PRISM_SAMPLES - 1; i >= 0; i--) {
      if (rays[i]?.face === face) next = i;
      const previous = nearest[i] ?? -1;
      if (previous < 0 || (next >= 0 && next - i < i - previous)) nearest[i] = next;
    }
  }

  /**
   * Records the stretch of a bundle that runs to `face` (or out of the picture). Rays of the bundle
   * that go elsewhere take the path of the nearest ray that does, with no power, so the fan fades
   * out across one wavelength step where it splits.
   */
  #emit(bundle: Bundle, face: number, peak: number): void {
    const fan = this.#fans[this.#fanCount];
    if (fan === undefined) return;
    this.#fanCount++;
    const glass = bundle.medium >= 0;
    fan.kind =
      bundle.face < 0
        ? PRISM_KIND_SOURCE
        : glass
          ? PRISM_KIND_GLASS + bundle.medium
          : PRISM_KIND_AIR;
    const side = glass ? -1 : 1;
    if (bundle.face < 0) {
      fan.startX = this.#lightDX;
      fan.startY = this.#lightDY;
      fan.startC = -(this.#lightDX * this.#lightX + this.#lightDY * this.#lightY);
    } else {
      const from = this.#faceAt(bundle.face);
      fan.startX = side * from.nx;
      fan.startY = side * from.ny;
      fan.startC = -(fan.startX * from.ax + fan.startY * from.ay);
    }
    if (face === SCREEN) {
      fan.endX = -1;
      fan.endY = 0;
      fan.endC = this.#screenX;
    } else if (face >= 0) {
      const to = this.#faceAt(face);
      fan.endX = side * to.nx;
      fan.endY = side * to.ny;
      fan.endC = -(fan.endX * to.ax + fan.endY * to.ay);
    } else {
      fan.endX = 0;
      fan.endY = 0;
      fan.endC = 1;
    }
    let power = 0;
    let width = 0;
    let flux = 0;
    for (let i = 0; i < PRISM_SAMPLES; i++) {
      const out = fan.rays[i];
      const own = bundle.rays[i];
      const path = bundle.rays[this.#nearest[i] ?? i];
      if (out === undefined || own === undefined || path === undefined) continue;
      out.copyPath(path);
      out.power = own.face === face ? own.power : 0;
      power += out.power;
      width += out.power * out.width;
      flux += out.power * out.t;
    }
    fan.width = power > 0 ? width / power : this.#beamWidth;
    fan.weight = peak;
    fan.flux = flux / PRISM_SAMPLES;
    fan.ghost = bundle.ghost;
    if (glass) this.#glow[bundle.medium] = (this.#glow[bundle.medium] ?? 0) + fan.flux / this.#side;
  }

  /** Splits the rays meeting `face` into what crosses it and what it reflects, and follows both. */
  #cross(bundle: Bundle, face: number): void {
    const through = this.#free.pop();
    const back = this.#free.pop();
    if (through === undefined || back === undefined) {
      if (through !== undefined) this.#free.push(through);
      if (back !== undefined) this.#free.push(back);
      return;
    }
    const f = this.#faceAt(face);
    const entering = bundle.medium < 0;
    through.medium = entering ? f.prism : -1;
    through.face = face;
    through.depth = bundle.depth + 1;
    back.medium = bundle.medium;
    back.face = face;
    back.depth = bundle.depth + 1;
    // The face's normal turned against the incoming light.
    const mx = entering ? f.nx : -f.nx;
    const my = entering ? f.ny : -f.ny;
    const widest = WIDTH_CAP * this.#beamWidth;
    // Reflected light totally (stays at full strength) or partially (a ghost, fading with distance).
    let total = 0;
    let partial = 0;
    for (let i = 0; i < PRISM_SAMPLES; i++) {
      const ray = bundle.rays[i];
      const t = through.rays[i];
      const r = back.rays[i];
      if (ray === undefined || t === undefined || r === undefined || ray.face !== face) continue;
      const n = this.#index[i] ?? N_MID;
      const eta = entering ? 1 / n : n;
      const x = ray.x + ray.dx * ray.t;
      const y = ray.y + ray.dy * ray.t;
      const cosI = Math.max(0, -(ray.dx * mx + ray.dy * my));
      t.x = x;
      t.y = y;
      r.x = x;
      r.y = y;
      r.dx = ray.dx + 2 * cosI * mx;
      r.dy = ray.dy + 2 * cosI * my;
      r.width = ray.width;
      const k = 1 - eta * eta * (1 - cosI * cosI);
      if (k < 0) {
        // Total internal reflection: all of it reflects; the crossing ray grazes the face, dark.
        const gx = ray.dx + cosI * mx;
        const gy = ray.dy + cosI * my;
        const g = Math.hypot(gx, gy) || 1;
        t.dx = gx / g;
        t.dy = gy / g;
        t.power = 0;
        t.width = ray.width;
        r.power = ray.power;
        total += r.power;
      } else {
        const cosT = Math.sqrt(k);
        t.dx = eta * ray.dx + (eta * cosI - cosT) * mx;
        t.dy = eta * ray.dy + (eta * cosI - cosT) * my;
        const reflected = entering ? fresnel(1, n, cosI, cosT) : fresnel(n, 1, cosI, cosT);
        t.power = ray.power * (1 - reflected);
        t.width = Math.min(widest, (ray.width * cosT) / Math.max(cosI, 1e-3));
        r.power = ray.power * reflected * this.#ghost;
        partial += r.power;
      }
    }
    // Rays that met another face borrow the path of the nearest that met this one, with no power.
    for (let i = 0; i < PRISM_SAMPLES; i++) {
      const m = this.#nearest[i] ?? i;
      if (m === i) continue;
      const t = through.rays[i];
      const r = back.rays[i];
      const tm = through.rays[m];
      const rm = back.rays[m];
      if (t === undefined || r === undefined || tm === undefined || rm === undefined) continue;
      t.copyPath(tm);
      t.power = 0;
      r.copyPath(rm);
      r.power = 0;
    }
    through.ghost = bundle.ghost;
    back.ghost = Math.max(bundle.ghost, partial / Math.max(partial + total, 1e-9));
    this.#queue(through);
    this.#queue(back);
  }

  /** Follows a bundle later if any of its light is still worth drawing; otherwise frees it. */
  #queue(bundle: Bundle): void {
    let peak = 0;
    for (const ray of bundle.rays) peak = Math.max(peak, ray.power);
    if (peak >= FAN_MIN) this.#work.push(bundle);
    else this.#free.push(bundle);
  }

  // ---- packing ---------------------------------------------------------------------------------

  #pack(): void {
    const order = this.#order;
    order.length = 0;
    for (let i = 0; i < this.#fanCount; i++) {
      const fan = this.#fans[i];
      if (fan !== undefined) order.push(fan);
    }
    order.sort(byWeight);
    let row = 0;
    for (const fan of order) {
      if (row >= PRISM_FANS) break;
      if (this.#packFan(fan, row)) row++;
    }
    if (row < PRISM_FANS) {
      // The end of the list: a bounding box that contains nothing.
      const end = row * PRISM_ROW * 4;
      this.#fanData[end] = 1;
      this.#fanData[end + 2] = -1;
    }
    this.#packState();
  }

  /** Writes one fan's row; false if none of it reaches the picture. */
  #packFan(fan: Fan, row: number): boolean {
    const data = this.#fanData;
    const base = row * PRISM_ROW * 4;
    const cell = this.#cell;
    // The fan's frame: its power-weighted origin and direction.
    let sum = 0;
    let ox = 0;
    let oy = 0;
    let dx = 0;
    let dy = 0;
    for (const ray of fan.rays) {
      sum += ray.power;
      ox += ray.power * ray.x;
      oy += ray.power * ray.y;
      dx += ray.power * ray.dx;
      dy += ray.power * ray.dy;
    }
    if (sum <= 0) return false;
    ox /= sum;
    oy /= sum;
    const length = Math.hypot(dx, dy) || 1;
    const c = dx / length;
    const s = dy / length;

    const hw = Math.max(fan.width, PRISM_MIN_WIDTH * cell);
    const hg = PRISM_GLOW_SPREAD * hw + PRISM_GLOW_CELLS * cell;
    const caustic = PRISM_CAUSTIC_SPREAD * hw + PRISM_CAUSTIC_CELLS * cell;
    const reach = Math.max(3 * hg, 2.5 * caustic);
    // A ghost is followed only as far as it can still be seen.
    const fade = fan.ghost / (GHOST_FADE * this.#scale);
    // The shader fades it as exp(-(distance * fade)²): past 3 / fade nothing is left.
    const seen = fade > 0 ? 3 / fade : Number.POSITIVE_INFINITY;

    // Every ray in the frame: origin, sin of its direction, end; bounds and colour separation.
    const local = this.#local;
    let xmin = Number.POSITIVE_INFINITY;
    let xmax = Number.NEGATIVE_INFINITY;
    let wxmin = Number.POSITIVE_INFINITY;
    let wymin = Number.POSITIVE_INFINITY;
    let wxmax = Number.NEGATIVE_INFINITY;
    let wymax = Number.NEGATIVE_INFINITY;
    let topStart = Number.NEGATIVE_INFINITY;
    let topEnd = Number.NEGATIVE_INFINITY;
    let lowStart = Number.POSITIVE_INFINITY;
    let lowEnd = Number.POSITIVE_INFINITY;
    let startX = 0;
    let endX = 0;
    let spread = 0;
    for (let i = 0; i < PRISM_SAMPLES; i++) {
      const ray = fan.rays[i];
      if (ray === undefined) continue;
      const vx = ray.x - ox;
      const vy = ray.y - oy;
      const lx = c * vx + s * vy;
      const ly = c * vy - s * vx;
      const ldx = c * ray.dx + s * ray.dy;
      const ldy = c * ray.dy - s * ray.dx;
      const ex = lx + ldx * Math.min(ray.t, seen);
      const ey = ly + ldy * Math.min(ray.t, seen);
      local[i * 4] = lx;
      local[i * 4 + 1] = ly;
      local[i * 4 + 2] = ldx > 0 ? ldy : Math.sign(ldy);
      local[i * 4 + 3] = ray.power;
      xmin = Math.min(xmin, lx, ex);
      xmax = Math.max(xmax, lx, ex);
      topStart = Math.max(topStart, ly);
      topEnd = Math.max(topEnd, ey);
      lowStart = Math.min(lowStart, ly);
      lowEnd = Math.min(lowEnd, ey);
      startX += lx;
      endX += ex;
      if (ray.power > 0) spread = Math.max(spread, Math.abs(ly), Math.abs(ey));
      const wx0 = ray.x;
      const wy0 = ray.y;
      const wx1 = ray.x + ray.dx * Math.min(ray.t, seen);
      const wy1 = ray.y + ray.dy * Math.min(ray.t, seen);
      wxmin = Math.min(wxmin, wx0, wx1);
      wxmax = Math.max(wxmax, wx0, wx1);
      wymin = Math.min(wymin, wy0, wy1);
      wymax = Math.max(wymax, wy0, wy1);
    }
    // World bounds, glow included, clipped to the picture.
    const hx = this.#aspect / 2;
    wxmin = Math.max(wxmin - reach, -hx);
    wxmax = Math.min(wxmax + reach, hx);
    wymin = Math.max(wymin - reach, -0.5);
    wymax = Math.min(wymax + reach, 0.5);
    if (wxmin > wxmax || wymin > wymax) return false;

    // In the fan's frame: two lines bounding every ray from above and below.
    const run = Math.max(1e-3, (endX - startX) / PRISM_SAMPLES);
    const topSlope = (topEnd - topStart) / run;
    const lowSlope = (lowEnd - lowStart) / run;
    let top = Number.NEGATIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    for (let i = 0; i < PRISM_SAMPLES; i++) {
      const ray = fan.rays[i];
      if (ray === undefined) continue;
      const lx = local[i * 4] ?? 0;
      const ly = local[i * 4 + 1] ?? 0;
      const ldx = Math.sqrt(Math.max(0, 1 - (local[i * 4 + 2] ?? 0) ** 2));
      const ldy = local[i * 4 + 2] ?? 0;
      const ex = lx + ldx * Math.min(ray.t, seen);
      const ey = ly + ldy * Math.min(ray.t, seen);
      top = Math.max(top, ly - topSlope * lx, ey - topSlope * ex);
      low = Math.min(low, ly - lowSlope * lx, ey - lowSlope * ex);
    }

    // Faint fans skip every other wavelength; a fan whose colours never part is drawn as one white band.
    const white = spread < 0.35 * fan.width;
    const step = white ? 0 : fan.weight >= 0.15 ? 1 : 2;

    // The soft spot where the fan leaves its face: the colour of all its light together.
    let r = 0;
    let g = 0;
    let b = 0;
    let mean = 0;
    for (let i = 0; i < PRISM_SAMPLES; i++) {
      const w = (i === 0 || i === PRISM_SAMPLES - 1 ? 0.5 : 1) * (fan.rays[i]?.power ?? 0);
      const colour = prismSpectrum[i];
      mean += w;
      if (colour === undefined) continue;
      r += w * colour[0];
      g += w * colour[1];
      b += w * colour[2];
    }
    const source = fan.kind === PRISM_KIND_SOURCE ? 0 : 1 / (PRISM_SAMPLES - 1);

    data[base] = wxmin;
    data[base + 1] = wymin;
    data[base + 2] = wxmax;
    data[base + 3] = wymax;
    splitHalf(data, base + 4, ox);
    splitHalf(data, base + 6, oy);
    splitHalf(data, base + 8, c);
    splitHalf(data, base + 10, s);
    data[base + 12] = fan.startX;
    data[base + 13] = fan.startY;
    splitHalf(data, base + 14, fan.startC);
    data[base + 16] = fan.endX;
    data[base + 17] = fan.endY;
    splitHalf(data, base + 18, fan.endC);
    data[base + 20] = xmin - reach;
    data[base + 21] = xmax + reach;
    data[base + 22] = low - reach * Math.hypot(1, lowSlope);
    data[base + 23] = lowSlope;
    data[base + 24] = top + reach * Math.hypot(1, topSlope);
    data[base + 25] = topSlope;
    data[base + 26] = fan.width;
    data[base + 27] = step;
    data[base + 28] = r * source;
    data[base + 29] = g * source;
    data[base + 30] = b * source;
    data[base + 31] = fan.kind;
    data[base + 32] = fade;
    data[base + 33] = 0;
    data[base + 34] = 0;
    data[base + 35] = 0;
    const samples = base + PRISM_HEADER * 4;
    for (let i = 0; i < PRISM_SAMPLES; i++) {
      data[samples + i * 4] = local[i * 4] ?? 0;
      data[samples + i * 4 + 1] = local[i * 4 + 1] ?? 0;
      data[samples + i * 4 + 2] = local[i * 4 + 2] ?? 0;
      data[samples + i * 4 + 3] = local[i * 4 + 3] ?? 0;
    }
    if (white) {
      // One band along the frame's axis, carrying the fan's average power.
      const middle = samples + ((PRISM_SAMPLES - 1) / 2) * 4;
      data[middle] = 0;
      data[middle + 1] = 0;
      data[middle + 2] = 0;
      data[middle + 3] = mean / (PRISM_SAMPLES - 1);
    }
    return true;
  }

  #packState(): void {
    const data = this.#stateData;
    splitHalf(data, 0, this.#centreX);
    splitHalf(data, 2, this.#centreY);
    splitHalf(data, 4, Math.cos(this.#angle));
    splitHalf(data, 6, Math.sin(this.#angle));
    splitHalf(data, 8, this.#secondX);
    splitHalf(data, 10, this.#secondY);
    splitHalf(data, 12, Math.cos(this.#angle + Math.PI));
    splitHalf(data, 14, Math.sin(this.#angle + Math.PI));
    data[16] = this.#side / Math.sqrt(3);
    data[17] = this.#secondActive ? 1 : 0;
    data[18] = this.#glow[0] ?? 0;
    data[19] = this.#glow[1] ?? 0;
    splitHalf(data, 20, this.#markX);
    splitHalf(data, 22, this.#markY);
    data[24] = this.#lightDX;
    data[25] = this.#lightDY;
    data[26] = smoothstep(0, 1, this.#markShown);
    data[27] = (MARK_SMALL + (MARK_LARGE - MARK_SMALL) * this.#markSize) * this.#scale;
    data[28] = this.#beamWidth;
    data[29] = this.#screenX;
    data[30] = this.#screenOn ? 1 : 0;
    data[31] = 0;
  }
}

/** The prism's optics, for a scene whose `params` carry the knobs `KnobKey` names. */
export function prismSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new PrismSim(gl, params);
}
