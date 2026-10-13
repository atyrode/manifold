// The ripple tank's experiments: where the dippers, the plane-wave bar, the barriers, the lens
// plate, the box and the M stand for a frame and a wavelength. The sim (sim.ts) drives, walls and
// seeds the water from a layout; the shader (shader.ts) draws the same fixtures' shadows from the
// layout texture the sim publishes.
//
// Units. Lengths are in short sides of the frame ("S"): a landscape frame is aspect × 1, a portrait
// one 1 × 1 / aspect, origin at its bottom-left corner, y up. Experiments are laid out along the
// frame's long axis (a, from 0 to `long`) and across it (b, 0..1), then placed: in portrait the
// long axis runs up the screen, so the waves travel upward. The Manifold M always stands upright.

/** Wave speed at the speed knob's 1, short sides per second, and the dippers' beat at frequency 1. */
export const RIPPLE_SPEED = 0.028;
export const RIPPLE_FREQUENCY = 0.25;

/** A dipper ball's radius, the plane-wave bar's and a barrier's half-width, the M strip's half-width. */
export const RIPPLE_DIPPER = 0.013;
export const RIPPLE_BAR = 0.006;
export const RIPPLE_WALL = 0.011;
export const RIPPLE_MARK_HALF = 0.0075;
/** The lamp's height above the screen and the dipper beam's (S): high things cast wider shadows. */
export const RIPPLE_LAMP_HEIGHT = 1.6;
export const RIPPLE_BEAM_HEIGHT = 0.3;
/** Where the lamp hangs over the tank: along the long axis (share of it), across it. */
export const RIPPLE_LAMP = { along: 0.58, across: 0.55 } as const;
/** The M's height at the small and large end of its size knob (S). */
export const RIPPLE_MARK_SIZE = [0.2, 0.42] as const;

/** Experiments, in cycle order; MARK only runs while the Manifold M is on. */
export const TWO = 0;
export const SLIT = 1;
export const LENS = 2;
export const DOPPLER = 3;
export const BOX = 4;
export const MARK = 5;
export type Experiment = typeof TWO | typeof SLIT | typeof LENS | typeof DOPPLER | typeof BOX | typeof MARK;
export const RIPPLE_EXPERIMENTS: readonly Experiment[] = [TWO, SLIT, LENS, DOPPLER, BOX];
/** Labels of the experiment knob after "cycle", in RIPPLE_EXPERIMENTS order. */
export const rippleExperimentLabels = ["interference", "double slit", "lens", "Doppler", "standing"] as const;

/** The Manifold M in mark units (common's markDistance): x in [-0.47, 0.47], y in [-0.5, 0.5]. */
export const RIPPLE_M: readonly (readonly [number, number])[] = [[-0.47, -0.5], [-0.47, 0.5], [0, -0.08], [0.47, 0.5], [0.47, -0.5]];

export interface TankFrame {
  /** Frame size in short sides. */
  width: number;
  height: number;
  /** The long side (the larger of the two). */
  long: number;
  portrait: boolean;
}

export interface Point {
  x: number;
  y: number;
}

export interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export interface Dipper extends Point {
  /** Wave height a wavelength out (the scene's unit wave is 1). */
  amp: number;
}

export interface Wall extends Segment {
  half: number;
}

/** A biconvex glass plate on the tank floor: the water over it is shallow and its waves slow. */
export interface Lens extends Point {
  /** Its axis (unit vector, the way the waves cross it), half its aperture and half its thickness. */
  ux: number;
  uy: number;
  half: number;
  thick: number;
  /** Wave speed over the plate / in open water. */
  ratio: number;
}

/** The Doppler dipper's track: a long loop, straight both ways with round turns at the ends. */
export interface Track {
  /** Centre, the long axis (unit) and the axis across it. */
  x: number;
  y: number;
  ux: number;
  uy: number;
  wx: number;
  wy: number;
  /** Half the straight's length and the turns' radius (S); speed (S per second). */
  reach: number;
  radius: number;
  speed: number;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The double slit, for the seed: the barrier's faces along the waves' way, the slits just past it. */
export interface Slits {
  /** Slit centres on the barrier's far face, their clear width, and the faces' positions along the bar's normal. */
  centres: Point[];
  width: number;
  near: number;
  far: number;
}

export interface Layout {
  experiment: Experiment;
  /** The fixed dippers; the Doppler dipper is `track`. */
  dippers: Dipper[];
  track: (Track & { amp: number }) | undefined;
  /** The dippers' holder over the water: only its shadow shows. */
  beam: Segment | undefined;
  /** The plane-wave bar dipping along a line, its wave height, and its normal (the waves' way). */
  bar: (Segment & { amp: number; nx: number; ny: number }) | undefined;
  walls: Wall[];
  slits: Slits | undefined;
  lens: Lens | undefined;
  /** The Manifold M, a strip bent into the mark dipping along its whole length. */
  mark: (Point & { height: number; amp: number }) | undefined;
  box: Box | undefined;
  /** How hard the screen focuses this experiment's waves, × the focus knob. */
  contrast: number;
}

/** The frame in short sides for an aspect (width / height). */
export function tankFrame(aspect: number): TankFrame {
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const portrait = ratio < 1;
  const width = portrait ? 1 : ratio;
  const height = portrait ? 1 / ratio : 1;
  return { width, height, long: Math.max(width, height), portrait };
}

/** A point at (a along the long axis, b across it) in frame coordinates. */
export function place(frame: TankFrame, a: number, b: number): Point {
  return frame.portrait ? { x: b, y: a } : { x: a, y: b };
}

function segmentAt(frame: TankFrame, a0: number, b0: number, a1: number, b1: number): Segment {
  const p = place(frame, a0, b0);
  const q = place(frame, a1, b1);
  return { ax: p.x, ay: p.y, bx: q.x, by: q.y };
}

/**
 * Where the Doppler dipper is at `time` seconds into its experiment, and its velocity. It starts
 * on the near straight heading along the long axis, turns at the far end and comes back.
 */
export function trackAt(track: Track, time: number): { x: number; y: number; vx: number; vy: number } {
  const straight = 2 * track.reach;
  const turn = Math.PI * track.radius;
  const loop = 2 * straight + 2 * turn;
  // At time 0 the dipper is a fifth of the way along the near straight.
  let s = (0.2 * straight + track.speed * time) % loop;
  if (s < 0) s += loop;
  let a: number;
  let b: number;
  let da: number;
  let db: number;
  if (s < straight) {
    a = -track.reach + s;
    b = -track.radius;
    da = 1;
    db = 0;
  } else if (s < straight + turn) {
    const angle = -Math.PI / 2 + (s - straight) / track.radius;
    a = track.reach + track.radius * Math.cos(angle);
    b = track.radius * Math.sin(angle);
    da = -Math.sin(angle);
    db = Math.cos(angle);
  } else if (s < 2 * straight + turn) {
    a = track.reach - (s - straight - turn);
    b = track.radius;
    da = -1;
    db = 0;
  } else {
    const angle = Math.PI / 2 + (s - 2 * straight - turn) / track.radius;
    a = -track.reach + track.radius * Math.cos(angle);
    b = track.radius * Math.sin(angle);
    da = -Math.sin(angle);
    db = Math.cos(angle);
  }
  return {
    x: track.x + a * track.ux + b * track.wx,
    y: track.y + a * track.uy + b * track.wy,
    vx: track.speed * (da * track.ux + db * track.wx),
    vy: track.speed * (da * track.uy + db * track.wy),
  };
}

/**
 * The experiment's fixtures for a frame and wavelength (S). Sizes follow the wavelength so each
 * experiment shows its effect at any frequency: slits a wavelength wide and three apart, a box a
 * whole number of half-waves on each side so it rings.
 */
export function rippleLayout(experiment: Experiment, frame: TankFrame, lambda: number, waveSpeed: number, markSize: number): Layout {
  const L = frame.long;
  const layout: Layout = {
    experiment,
    dippers: [],
    track: undefined,
    beam: undefined,
    bar: undefined,
    walls: [],
    slits: undefined,
    lens: undefined,
    mark: undefined,
    box: undefined,
    contrast: 1,
  };
  // The waves' way along the long axis, and across it, in frame coordinates.
  const along = place(frame, 1, 0);
  const across = place(frame, 0, 1);
  // Slit and lens: a straight bar near the tank's end sends plane waves along it.
  const barAt = 0.2;
  if (experiment === SLIT || experiment === LENS) {
    layout.bar = { ...segmentAt(frame, barAt, -0.3, barAt, 1.3), amp: 0.5, nx: along.x, ny: along.y };
  }
  switch (experiment) {
    case TWO: {
      // Two dippers on one beam, in step: the fan of calm lines between them.
      const a = 0.3 * L;
      const d = Math.min(3.5 * lambda, 0.6);
      layout.dippers.push({ ...place(frame, a, 0.5 - d / 2), amp: 1 }, { ...place(frame, a, 0.5 + d / 2), amp: 1 });
      layout.beam = segmentAt(frame, a, 0.5 - d / 2 - 0.05, a, 1.3);
      break;
    }
    case SLIT: {
      // The bar's plane waves meet a barrier with two slits; past it, two new sources.
      const ab = barAt + Math.max(2.25 * lambda, 0.2);
      const d = Math.min(3 * lambda, 0.46);
      const w = Math.min(Math.max(0.9 * lambda, 0.05), 0.12);
      const h = RIPPLE_WALL;
      const lo = 0.5 - d / 2;
      const hi = 0.5 + d / 2;
      // The walls' rounded ends sit back from the gaps by their half-width, so each slit is w clear.
      const spans: [number, number][] = [[-0.3, lo - w / 2 - h], [lo + w / 2 + h, hi - w / 2 - h], [hi + w / 2 + h, 1.3]];
      for (const [b0, b1] of spans) layout.walls.push({ ...segmentAt(frame, ab, b0, ab, b1), half: h });
      layout.slits = {
        centres: [place(frame, ab + h, lo), place(frame, ab + h, hi)],
        width: w,
        near: ab - h,
        far: ab + h,
      };
      layout.contrast = 1.5;
      break;
    }
    case LENS: {
      // Plane waves cross a lens-shaped shallow: slower over it, they bend to a focus and on.
      const c = place(frame, barAt + 0.42, 0.5);
      layout.lens = { ...c, ux: along.x, uy: along.y, half: 0.36, thick: 0.11, ratio: 0.62 };
      break;
    }
    case DOPPLER: {
      // One dipper drawn slowly along the tank at a third of the waves' speed: crowded ahead, spread behind.
      const c = place(frame, L / 2, 0.5);
      layout.track = {
        ...c,
        ux: along.x,
        uy: along.y,
        wx: across.x,
        wy: across.y,
        reach: Math.max(L / 2 - 0.32, 0.1),
        radius: 0.17,
        speed: 0.35 * waveSpeed,
        amp: 0.7,
      };
      layout.contrast = 0.78;
      break;
    }
    case BOX: {
      // A box of walls a whole number of half-waves each way, a dipper at its centre: it rings in
      // standing waves that pulse in place.
      const half = lambda / 2;
      const n = Math.max(2, 2 * Math.floor(0.62 / lambda));
      const m = Math.max(2, 2 * Math.floor(Math.min(1, L - 0.55) / lambda));
      const ha = (m * half) / 2;
      const hb = (n * half) / 2;
      const h = RIPPLE_WALL;
      const ac = L / 2;
      const p0 = place(frame, ac - ha, 0.5 - hb);
      const p1 = place(frame, ac + ha, 0.5 + hb);
      layout.box = { x0: Math.min(p0.x, p1.x), y0: Math.min(p0.y, p1.y), x1: Math.max(p0.x, p1.x), y1: Math.max(p0.y, p1.y) };
      const ea = ha + h;
      const eb = hb + h;
      layout.walls.push(
        { ...segmentAt(frame, ac - ea, 0.5 - eb, ac + ea, 0.5 - eb), half: h },
        { ...segmentAt(frame, ac + ea, 0.5 - eb, ac + ea, 0.5 + eb), half: h },
        { ...segmentAt(frame, ac + ea, 0.5 + eb, ac - ea, 0.5 + eb), half: h },
        { ...segmentAt(frame, ac - ea, 0.5 + eb, ac - ea, 0.5 - eb), half: h },
      );
      layout.dippers.push({ ...place(frame, ac, 0.5), amp: 1 });
      layout.beam = segmentAt(frame, ac, 0.5, ac, 1.3);
      break;
    }
    case MARK: {
      // A strip bent into the M, dipping along its whole length: its waves leave M-shaped and round off.
      const height = RIPPLE_MARK_SIZE[0] + (RIPPLE_MARK_SIZE[1] - RIPPLE_MARK_SIZE[0]) * Math.min(1, Math.max(0, markSize));
      layout.mark = { x: frame.width / 2, y: frame.height / 2, height, amp: 0.6 };
      layout.contrast = 0.9;
      break;
    }
    default: {
      const unreachable: never = experiment;
      throw new Error(`landing: unknown ripple experiment ${String(unreachable)}`);
    }
  }
  return layout;
}
