// A height field for sand and gravel: a karesansui garden raked into grooves that soften with the
// seasons, a sand table where a steel ball ploughs its track and the walls slump to the angle of
// repose.
//
// Heights live in a Float32Array grid, row 0 at uv.y = 0 (the way DataTexture uploads it), in the
// same unit as lengths: view heights. So slopes are true slopes, `talus` is the tangent of the angle
// of repose (dry sand ≈ 0.65, about 33°), and a groove 0.004 deep is about two dither cells at 540
// rows. Positions are uv (0..1, y up); lengths are in view heights and the field knows the view's
// aspect, so a round stamp stays round on a wide screen whatever shape the texels are. Keep the rest
// level at 0: r16f is finest near zero.
//
// Tools:
//   stamp   adds a radial profile (a pebble's crater, a mound of moss)
//   groove  a tine (or a ball) drawn along a segment: it rides at `level`, cuts away everything above
//           its round bottom, and lays exactly what it removed as banks either side
//   rake    several parallel tines at once, square to the stroke; the banks between them are shared
//   relax   slumps every slope steeper than the talus, a share of the excess per second (mass
//           conserving); optionally a band of rows per call
//   smooth  diffusion, for slow weathering
//
// Cutting is idempotent (a tine cuts down to its bottom and no deeper), so a tool moved a little
// each frame, segment by segment, digs the same groove as one long stroke, and lingering digs
// nothing more. The banks are laid beside each segment through a soft window along the path that
// sums to one over consecutive segments, so slow strokes leave even banks rather than beads. A tool
// set down without moving lays its spoil in a ring instead.
//
// Cost at 512×288 (147k texels; V8 estimates, to be measured in the scene):
//   groove/rake  the strip a frame's segment touches, ~1–3k texels × 2 passes: well under 0.1 ms
//   relax        4 neighbour edges per texel, ~2–4 ms a full pass; rows = 72 spreads it over 4
//                frames; free once settled (a full cycle with nothing to move) until the next change
//   smooth       2 edges per texel, ~0.5 ms a call
//   upload       590 KB of float32 per change; skipped while nothing changes
// Nothing allocates after construction.
//
// Usage (a sand table):
//   const sand = new HeightField(512, 288, frame.aspect);
//   const texture = new DataTexture(gl, { width: 512, height: 288, format: "r16f" });
//   const ball: GrooveOptions = { width: 0.016, depth: 0.005 };
//   // each frame (keep `ball`; do not rebuild it):
//   sand.groove(lastX, lastY, ballX, ballY, ball);
//   sand.relax(0.65, 4, frame.dt * frame.motion, 72);
//   sand.upload(texture);
//   return [texture.texture];
//   // GLSL: float h = texture(uSim0, uv).r;  with e = vec2(1.0 / 512.0, 0.0):
//   //   float dhdx = (texture(uSim0, uv + e).r - texture(uSim0, uv - e).r) / (2.0 * e.x * aspect);
//   //   (dhdy likewise with e = vec2(0, 1/288) and no aspect); normal = normalize(vec3(-dhdx, -dhdy, 1))
import type { DataTexture } from "./texture.ts";

/** A radial profile: the height at r = distance / radius, r in [0, 1). */
export type HeightProfile = (r: number) => number;

/** A smooth mound, 1 at the centre: (1 - r²)². */
export const domeProfile: HeightProfile = (r) => {
  const s = 1 - r * r;
  return s * s;
};

/**
 * A mass-neutral dimple, a pebble dropped in sand: -1 at the centre, a rim of +0.25 at r ≈ 0.71 and
 * zero net volume: (1 - r²)² (4r² - 1).
 */
export const craterProfile: HeightProfile = (r) => {
  const s = r * r;
  return (1 - s) * (1 - s) * (4 * s - 1);
};

export interface GrooveOptions {
  /** Width of the groove, view heights. */
  width: number;
  /** How far the tine's bottom sits below `level`, view heights. */
  depth: number;
  /** Width of the bank the spoil forms on each side, view heights. Default 0.75 × width. */
  ridge?: number;
  /** The surface the tine rides on. Default 0, the rest level. */
  level?: number;
}

export interface RakeOptions extends GrooveOptions {
  /** Number of tines. */
  tines: number;
  /** Centre-to-centre tine spacing, view heights. */
  spacing: number;
}

export class HeightFieldError extends Error {}

/**
 * Below this excess (view heights) a slope is left alone: far finer than r16f resolves near the rest
 * level, and it lets a pile settle for good instead of creeping forever.
 */
const SETTLE = 1e-6;

/**
 * Bank profile across the ridge band, u = 0 at the groove's edge to 1 at the band's outer edge: a
 * crest at u = 1/3, close to the cut, easing flat into the ground.
 */
function bank(u: number): number {
  const v = 1 - u;
  return u * v * v;
}

/**
 * One edge of the angle-of-repose relaxation: if the height step between texels a and b exceeds
 * `limit`, move `share` of the excess from the higher to the lower. Returns whether it moved.
 */
function slump(h: Float32Array, a: number, b: number, limit: number, share: number): boolean {
  const ha = h[a] ?? 0;
  const hb = h[b] ?? 0;
  const excess = Math.abs(ha - hb) - limit;
  if (excess <= SETTLE) return false;
  const m = ha > hb ? excess * share : -excess * share;
  h[a] = ha - m;
  h[b] = hb + m;
  return true;
}

export class HeightField {
  readonly width: number;
  readonly height: number;
  /** Heights in view heights, row-major, row 0 at uv.y = 0. Call `touch()` after writing it directly. */
  readonly data: Float32Array;
  /** Bumped on every change; `upload` skips while it stands still. */
  version = 0;
  #aspect: number;
  #uploaded = -1;
  #relaxRow = 0;
  #relaxCycle = 0;
  /** Rows relaxed in a row with nothing to move since the last change; a full height = settled. */
  #relaxQuiet = 0;
  #relaxTalus = Number.NaN;
  #smoothPass = 0;

  /** A flat field (height 0) of width × height texels over a view of the given aspect. */
  constructor(width: number, height: number, aspect = width / height) {
    if (!(Number.isInteger(width) && Number.isInteger(height) && width >= 2 && height >= 2)) {
      throw new HeightFieldError(
        `a height field needs at least 2×2 whole texels, got ${width}×${height}`,
      );
    }
    if (!(aspect > 0)) throw new HeightFieldError(`aspect must be positive, got ${aspect}`);
    this.width = width;
    this.height = height;
    this.#aspect = aspect;
    this.data = new Float32Array(width * height);
  }

  /** The view's width over its height. Set it on resize: the grid stays, its texels stretch. */
  get aspect(): number {
    return this.#aspect;
  }

  set aspect(value: number) {
    if (!(value > 0)) throw new HeightFieldError(`aspect must be positive, got ${value}`);
    if (value === this.#aspect) return;
    this.#aspect = value;
    this.#relaxQuiet = 0;
  }

  /** Mark `data` changed (after writing it directly). */
  touch(): void {
    this.version++;
    this.#relaxQuiet = 0;
  }

  fill(value: number): void {
    this.data.fill(value);
    this.touch();
  }

  /** Add amount × profile(d / radius) within `radius` (view heights) of uv (x, y). */
  stamp(x: number, y: number, radius: number, profile: HeightProfile, amount = 1): void {
    if (!(radius > 0) || amount === 0) return;
    const w = this.width;
    const h = this.data;
    const cx = x * w - 0.5;
    const cy = y * this.height - 0.5;
    const rx = (radius / this.#aspect) * w;
    const ry = radius * this.height;
    const i0 = Math.max(0, Math.ceil(cx - rx));
    const i1 = Math.min(w - 1, Math.floor(cx + rx));
    const j0 = Math.max(0, Math.ceil(cy - ry));
    const j1 = Math.min(this.height - 1, Math.floor(cy + ry));
    if (i0 > i1 || j0 > j1) return;
    for (let j = j0; j <= j1; j++) {
      const dy = (j - cy) / ry;
      for (let i = i0; i <= i1; i++) {
        const dx = (i - cx) / rx;
        const r2 = dx * dx + dy * dy;
        if (r2 >= 1) continue;
        const k = j * w + i;
        h[k] = (h[k] ?? 0) + amount * profile(Math.sqrt(r2));
      }
    }
    this.touch();
  }

  /** Draw one tine from uv (x0, y0) to (x1, y1): cut the groove, bank the spoil beside it. */
  groove(x0: number, y0: number, x1: number, y1: number, options: GrooveOptions): void {
    this.#cut(x0, y0, x1, y1, 1, 0, options);
  }

  /** Draw a rake from uv (x0, y0) to (x1, y1): `tines` grooves square to the stroke, centred on it. */
  rake(x0: number, y0: number, x1: number, y1: number, options: RakeOptions): void {
    this.#cut(x0, y0, x1, y1, options.tines, options.spacing, options);
  }

  /**
   * Slump to the angle of repose: wherever a slope is steeper than `talus` (rise over run), move
   * material downhill. `rate` (per second) is how fast the excess goes: 1 a slow creep, 20 near
   * instant. `rows` per call time-slices the work (each row is relaxed for the whole time since its
   * last turn). Does nothing while paused or once settled.
   */
  relax(talus: number, rate: number, dt: number, rows = this.height): void {
    if (!(dt > 0) || !(rate > 0)) return;
    const w = this.width;
    const height = this.height;
    const h = this.data;
    const slope = Math.max(0, talus);
    if (slope !== this.#relaxTalus) {
      this.#relaxTalus = slope;
      this.#relaxQuiet = 0;
    }
    if (this.#relaxQuiet >= height) return;
    const count = Math.max(1, Math.min(height, Math.floor(rows)));
    // Each edge moves up to a quarter of its excess (halving the step), so the in-place sweep stays
    // smooth whatever order the edges come in.
    const share = 0.5 * Math.min(0.5, 1 - Math.exp(-rate * dt * (height / count)));
    const tw = this.#aspect / w;
    const th = 1 / height;
    const limitX = slope * tw;
    const limitY = slope * th;
    const limitD = slope * Math.hypot(tw, th);
    // Alternate the sweep direction every cycle, so sand does not drift with the scan.
    const reverse = (this.#relaxCycle & 1) === 1;
    let moved = false;
    for (let r = 0; r < count; r++) {
      const j = this.#relaxRow;
      const row = j * w;
      const up = j + 1 < height;
      for (let s = 0; s < w; s++) {
        const i = reverse ? w - 1 - s : s;
        const k = row + i;
        if (i + 1 < w && slump(h, k, k + 1, limitX, share)) moved = true;
        if (!up) continue;
        if (slump(h, k, k + w, limitY, share)) moved = true;
        if (i + 1 < w && slump(h, k, k + w + 1, limitD, share)) moved = true;
        if (i > 0 && slump(h, k, k + w - 1, limitD, share)) moved = true;
      }
      if (up) {
        this.#relaxRow = j + 1;
      } else {
        this.#relaxRow = 0;
        this.#relaxCycle++;
      }
    }
    if (moved) this.touch();
    else this.#relaxQuiet += count;
  }

  /**
   * Diffuse: every texel moves toward its four neighbours by `amount` (0..1) of the way to their
   * mean. Mass conserving, and never sharper than before. Scale with dt for steady weathering.
   */
  smooth(amount: number): void {
    const c = 0.25 * Math.min(1, Math.max(0, amount));
    if (!(c > 0)) return;
    const w = this.width;
    const height = this.height;
    const h = this.data;
    // Edges are averaged in place; flipping the sweep each call keeps it from leaning one way.
    const reverse = (this.#smoothPass++ & 1) === 1;
    for (let r = 0; r < height; r++) {
      const j = reverse ? height - 1 - r : r;
      const row = j * w;
      const up = j + 1 < height;
      for (let s = 0; s < w; s++) {
        const i = reverse ? w - 1 - s : s;
        const k = row + i;
        if (i + 1 < w) {
          const a = h[k] ?? 0;
          const b = h[k + 1] ?? 0;
          const m = (b - a) * c;
          h[k] = a + m;
          h[k + 1] = b - m;
        }
        if (up) {
          const a = h[k] ?? 0;
          const b = h[k + w] ?? 0;
          const m = (b - a) * c;
          h[k] = a + m;
          h[k + w] = b - m;
        }
      }
    }
    this.touch();
  }

  /** Bilinear height at uv (x, y), clamped to the edges. */
  sample(x: number, y: number): number {
    const w = this.width;
    const height = this.height;
    const h = this.data;
    const fx = Math.min(w - 1, Math.max(0, x * w - 0.5));
    const fy = Math.min(height - 1, Math.max(0, y * height - 0.5));
    const i0 = Math.min(w - 2, Math.floor(fx));
    const j0 = Math.min(height - 2, Math.floor(fy));
    const tx = fx - i0;
    const ty = fy - j0;
    const k = j0 * w + i0;
    const a = h[k] ?? 0;
    const b = h[k + 1] ?? 0;
    const c = h[k + w] ?? 0;
    const d = h[k + w + 1] ?? 0;
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }

  /**
   * The slope at uv (x, y) into out[0..1]: dh/dx and dh/dy, rise over run in view heights, by
   * central differences one texel apart. A ball on the sand rolls along minus this.
   */
  gradient(x: number, y: number, out: Float32Array | number[]): void {
    const ex = 1 / this.width;
    const ey = 1 / this.height;
    out[0] = (this.sample(x + ex, y) - this.sample(x - ex, y)) / (2 * ex * this.#aspect);
    out[1] = (this.sample(x, y + ey) - this.sample(x, y - ey)) / (2 * ey);
  }

  /** Upload to an r16f texture (resized to the grid if needed), only when changed since the last. */
  upload(texture: DataTexture): boolean {
    if (texture.width !== this.width || texture.height !== this.height) {
      texture.resize(this.width, this.height);
      this.#uploaded = -1;
    }
    if (this.version === this.#uploaded) return false;
    texture.upload(this.data);
    this.#uploaded = this.version;
    return true;
  }

  /**
   * Draw `tines` tines `spacing` apart, square to the stroke from (x0, y0) to (x1, y1). Pass 0 cuts
   * every texel inside a tine's capsule down to the tine's round bottom and weighs the banks; pass 1
   * spreads exactly the removed volume over them.
   */
  #cut(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    tines: number,
    spacing: number,
    options: GrooveOptions,
  ): void {
    const width = options.width;
    const depth = options.depth;
    if (!(width > 0) || !(depth > 0)) return;
    const half = 0.5 * width;
    const ridge = Math.max(options.ridge ?? 0.75 * width, 1e-6);
    const level = options.level ?? 0;
    const w = this.width;
    const height = this.height;
    const h = this.data;
    // World units: view heights, x across 0..aspect.
    const tw = this.#aspect / w;
    const th = 1 / height;
    const ax = x0 * this.#aspect;
    const ay = y0;
    let ux = x1 * this.#aspect - ax;
    let uy = y1 - ay;
    const length = Math.hypot(ux, uy);
    if (length > 1e-9) {
      ux /= length;
      uy /= length;
    } else {
      ux = 1;
      uy = 0;
    }
    const nx = -uy;
    const ny = ux;
    const n = Math.max(1, Math.round(tines));
    const gap = n > 1 ? Math.max(0, spacing) : 0;
    const first = -0.5 * (n - 1) * gap;
    // The bank window along the path: a box over the segment blurred by `soft`, so the windows of
    // consecutive segments sum to one; at least two texels, so a short segment still reaches a texel.
    const soft = Math.max(width, 2 * Math.max(tw, th));
    const reachT = Math.max(half + ridge, 0.5 * soft);
    const reachD = -first + half + ridge;
    const midY = ay + 0.5 * length * uy;
    const extentY = Math.abs(uy) * (0.5 * length + reachT) + Math.abs(ny) * reachD;
    const j0 = Math.max(0, Math.ceil((midY - extentY) * height - 0.5));
    const j1 = Math.min(height - 1, Math.floor((midY + extentY) * height - 0.5));

    let removed = 0;
    let band = 0;
    let ring = 0;
    let scale = 0;
    let useBand = false;
    for (let pass = 0; pass < 2; pass++) {
      for (let j = j0; j <= j1; j++) {
        const py = (j + 0.5) * th - ay;
        const tRow = uy * py;
        const dRow = ny * py;
        // The columns where this row crosses the tool's rectangle: -reachT ≤ t ≤ length + reachT
        // along the stroke and |d| ≤ reachD across it, with t and d affine in x.
        let lo = -Infinity;
        let hi = Infinity;
        if (Math.abs(ux) > 1e-9) {
          const p = (-reachT - tRow) / ux;
          const q = (length + reachT - tRow) / ux;
          lo = Math.max(lo, Math.min(p, q));
          hi = Math.min(hi, Math.max(p, q));
        } else if (tRow < -reachT || tRow > length + reachT) {
          continue;
        }
        if (Math.abs(nx) > 1e-9) {
          const p = (-reachD - dRow) / nx;
          const q = (reachD - dRow) / nx;
          lo = Math.max(lo, Math.min(p, q));
          hi = Math.min(hi, Math.max(p, q));
        } else if (Math.abs(dRow) > reachD) {
          continue;
        }
        const i0 = Math.max(0, Math.ceil((ax + lo) / tw - 0.5));
        const i1 = Math.min(w - 1, Math.floor((ax + hi) / tw - 0.5));
        const row = j * w;
        for (let i = i0; i <= i1; i++) {
          const px = (i + 0.5) * tw - ax;
          const t = ux * px + tRow;
          const d = nx * px + dRow;
          const tine = gap > 0 ? Math.min(n - 1, Math.max(0, Math.round((d - first) / gap))) : 0;
          const across = d - first - tine * gap;
          const beyond = t < 0 ? -t : t > length ? t - length : 0;
          const dist = Math.sqrt(beyond * beyond + across * across);
          const k = row + i;
          if (dist < half) {
            if (pass === 0) {
              const s = dist / half;
              const bottom = level - depth * (1 - s * s);
              const v = h[k] ?? 0;
              if (v > bottom) {
                removed += v - bottom;
                h[k] = bottom;
              }
            }
            continue;
          }
          // Beside the stroke: the bank band, windowed along the path.
          const edge = Math.abs(across) - half;
          let side = 0;
          if (edge >= 0 && edge < ridge) {
            const along = Math.min(t + 0.5 * soft, length) - Math.max(t - 0.5 * soft, 0);
            if (along > 0) side = (bank(edge / ridge) * along) / soft;
          }
          // Around the tine's capsule: the ring a tool set down in place piles up.
          const out = dist - half;
          const around = out < ridge ? bank(out / ridge) : 0;
          if (pass === 0) {
            band += side;
            ring += around;
          } else {
            const share = useBand ? side : around;
            if (share > 0) h[k] = (h[k] ?? 0) + scale * share;
          }
        }
      }
      if (pass === 0) {
        if (!(removed > 0)) return;
        useBand = band > 0;
        const total = useBand ? band : ring;
        // Banks wholly outside the grid: the spoil leaves with them.
        if (!(total > 0)) break;
        scale = removed / total;
      }
    }
    this.touch();
  }
}
