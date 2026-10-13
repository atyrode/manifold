// Load-time analysis of the source paintings: a backdrop mask (paper/sky to drop to black) and a
// flow field that follows the brushstrokes, so the shader can advect paint instead of wobbling it.
// Coordinates are image-normalised with y down; radii are fractions of the image height.

export interface Vortex {
  x: number;
  y: number;
  r: number;
  /** Signed strength: positive turns clockwise on screen. */
  spin: number;
  /** Light rings pulse outward through this vortex (stars, moon). */
  pulse: boolean;
}

export interface Artwork {
  url: string;
  focus: readonly [number, number];
  /** Flood the unpainted paper from the top-right so the scene can drop it to black. */
  backdrop: boolean;
  /** Extra rectangles [x0, y0, x1, y1] forced into the backdrop (title cartouche). */
  clear: readonly (readonly [number, number, number, number])[];
  vortices: readonly Vortex[];
  /** Uniform drift added to the vortex field. */
  wind: readonly [number, number];
  /** 0..1 weight of motion at a pixel (0 keeps the paint still). */
  moves: (x: number, y: number, r: number, g: number, b: number, backdrop: number) => number;
}

export interface Raster {
  data: Uint8Array | Float32Array;
  width: number;
  height: number;
}

/** Hand-traced ridge of the hills in The Starry Night; everything below it stays still. */
const starryHills: readonly (readonly [number, number])[] = [
  [0, 0.7], [0.37, 0.72], [0.45, 0.7], [0.55, 0.64], [0.65, 0.63], [0.75, 0.58], [0.8, 0.55], [0.88, 0.51], [1, 0.5],
];

function ridge(points: readonly (readonly [number, number])[], x: number): number {
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1] ?? [0, 0];
    const [x1, y1] = points[i] ?? [1, 0];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return points.at(-1)?.[1] ?? 1;
}

export const artworks: Readonly<Record<string, Artwork>> = {
  wave: {
    url: "art/great-wave.jpg",
    focus: [0.4, 0.52],
    backdrop: true,
    clear: [[0, 0.04, 0.1, 0.31]],
    // Water climbs the face, rolls over the lip and falls into the claws around the barrel.
    vortices: [
      { x: 0.45, y: 0.43, r: 0.24, spin: 1.3, pulse: false },
      { x: 0.86, y: 0.72, r: 0.2, spin: 0.6, pulse: false },
    ],
    wind: [0.25, 0],
    moves: (_x, _y, _r, _g, _b, backdrop) => 1 - backdrop,
  },
  starry: {
    url: "art/starry-night.jpg",
    focus: [0.5, 0.6],
    backdrop: false,
    clear: [],
    vortices: [
      { x: 0.523, y: 0.322, r: 0.13, spin: 1.2, pulse: false },
      { x: 0.695, y: 0.451, r: 0.1, spin: -1.1, pulse: false },
      { x: 0.906, y: 0.169, r: 0.137, spin: 0.45, pulse: true },
      { x: 0.108, y: 0.04, r: 0.048, spin: 0.9, pulse: true },
      { x: 0.233, y: 0.032, r: 0.028, spin: -0.8, pulse: true },
      { x: 0.344, y: 0.039, r: 0.036, spin: 0.8, pulse: true },
      { x: 0.415, y: 0.06, r: 0.028, spin: -0.8, pulse: true },
      { x: 0.609, y: 0.081, r: 0.052, spin: 0.9, pulse: true },
      { x: 0.239, y: 0.173, r: 0.044, spin: -0.9, pulse: true },
      { x: 0.705, y: 0.226, r: 0.048, spin: 0.9, pulse: true },
      { x: 0.325, y: 0.326, r: 0.032, spin: -0.8, pulse: true },
      { x: 0.048, y: 0.447, r: 0.028, spin: 0.8, pulse: true },
      { x: 0.134, y: 0.479, r: 0.036, spin: -0.8, pulse: true },
      { x: 0.354, y: 0.528, r: 0.077, spin: 1, pulse: true },
    ],
    wind: [0.22, -0.02],
    moves: (x, y, r, g, b) => {
      const sky = Math.min(1, Math.max(0, (ridge(starryHills, x) - y) / 0.03));
      const cypress = 0.299 * r + 0.587 * g + 0.114 * b < 80 && b - Math.max(r, g) < 12 ? 1 : 0;
      return sky * (1 - cypress);
    },
  },
};

export function raster(image: HTMLImageElement, width: number): Raster {
  const height = Math.round((width * image.naturalHeight) / image.naturalWidth);
  const context = new OffscreenCanvas(width, height).getContext("2d");
  if (!context) throw new Error("landing: 2d canvas unavailable");
  context.drawImage(image, 0, 0, width, height);
  return { data: new Uint8Array(context.getImageData(0, 0, width, height).data.buffer), width, height };
}

/** Separable box blur, in place, clamped at the edges. */
function boxBlur(values: Float32Array, width: number, height: number, radius: number): void {
  const line = new Float32Array(Math.max(width, height));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += values[y * width + Math.min(width - 1, Math.max(0, x + k))] ?? 0;
      line[x] = sum / (2 * radius + 1);
    }
    values.set(line.subarray(0, width), y * width);
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += values[Math.min(height - 1, Math.max(0, y + k)) * width + x] ?? 0;
      line[y] = sum / (2 * radius + 1);
    }
    for (let y = 0; y < height; y++) values[y * width + x] = line[y] ?? 0;
  }
}

/**
 * Paper/sky mask: light, non-blue pixels reachable from the top-right edge without crossing a
 * (one-cell dilated) line or ink. Woodblock outlines are closed enough that foam stays separate
 * from the identically coloured paper.
 */
export function floodBackdrop(px: Raster, clear: Artwork["clear"]): Raster {
  const { width, height, data } = px;
  const blocked = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i] ?? 0, g = data[i + 1] ?? 0, b = data[i + 2] ?? 0;
      if (0.299 * r + 0.587 * g + 0.114 * b >= 175 && b - r <= 0) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const X = x + dx, Y = y + dy;
          if (X >= 0 && Y >= 0 && X < width && Y < height) blocked[Y * width + X] = 1;
        }
      }
    }
  }
  const mask = new Uint8Array(width * height);
  const stack: number[] = [];
  for (let x = Math.round(width * 0.45); x < width; x++) stack.push(x);
  for (let y = 0; y < height * 0.4; y++) stack.push(y * width + width - 1);
  while (stack.length > 0) {
    const i = stack.pop() ?? 0;
    if (mask[i] || blocked[i]) continue;
    mask[i] = 255;
    const x = i % width;
    if (x > 0) stack.push(i - 1);
    if (x < width - 1) stack.push(i + 1);
    if (i >= width) stack.push(i - width);
    if (i < width * (height - 1)) stack.push(i + width);
  }
  // Paper flecks become islands after dilation; fold islands of at most 24 cells back into the sky.
  const seen = new Uint8Array(width * height);
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] || seen[start]) continue;
    const island: number[] = [];
    const queue = [start];
    seen[start] = 1;
    while (queue.length > 0) {
      const i = queue.pop() ?? 0;
      island.push(i);
      const x = i % width;
      for (const n of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width]) {
        if (n >= 0 && n < mask.length && !mask[n] && !seen[n]) {
          seen[n] = 1;
          queue.push(n);
        }
      }
    }
    if (island.length <= 24) for (const i of island) mask[i] = 255;
  }
  for (const [x0, y0, x1, y1] of clear) {
    for (let y = Math.round(y0 * height); y < Math.round(y1 * height); y++) {
      mask.fill(255, y * width + Math.round(x0 * width), y * width + Math.round(x1 * width));
    }
  }
  return { data: mask, width, height };
}

/**
 * Velocity field (RG, image-uv per cycle, y up) that follows the brushstrokes. The structure
 * tensor gives each stroke's orientation but not its direction; the hand-placed vortices and wind
 * pick the direction and speed, and coherent strokes bend that field along themselves.
 */
export function flowField(px: Raster, art: Artwork, backdrop: Raster | undefined): Raster {
  const { width, height, data } = px;
  const aspect = width / height;
  const n = width * height;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    lum[i] = (0.299 * (data[i * 4] ?? 0) + 0.587 * (data[i * 4 + 1] ?? 0) + 0.114 * (data[i * 4 + 2] ?? 0)) / 255;
  }
  const jxx = new Float32Array(n), jxy = new Float32Array(n), jyy = new Float32Array(n);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const at = (dx: number, dy: number) => lum[(y + dy) * width + x + dx] ?? 0;
      const gx = at(1, -1) + 2 * at(1, 0) + at(1, 1) - at(-1, -1) - 2 * at(-1, 0) - at(-1, 1);
      const gy = at(-1, 1) + 2 * at(0, 1) + at(1, 1) - at(-1, -1) - 2 * at(0, -1) - at(1, -1);
      const i = y * width + x;
      jxx[i] = gx * gx;
      jxy[i] = gx * gy;
      jyy[i] = gy * gy;
    }
  }
  for (const channel of [jxx, jxy, jyy]) {
    boxBlur(channel, width, height, 4);
    boxBlur(channel, width, height, 4);
  }

  const vx = new Float32Array(n), vy = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const weight = art.moves(
        (x + 0.5) / width, (y + 0.5) / height,
        data[i * 4] ?? 0, data[i * 4 + 1] ?? 0, data[i * 4 + 2] ?? 0,
        (backdrop?.data[i] ?? 0) / 255,
      );
      if (weight <= 0) continue;
      const X = ((x + 0.5) / width) * aspect;
      const Y = (y + 0.5) / height;
      let rx = art.wind[0], ry = art.wind[1];
      for (const v of art.vortices) {
        const dx = X - v.x * aspect, dy = Y - v.y;
        const q = Math.hypot(dx, dy) / v.r;
        const f = (v.spin * Math.exp(-((q / 1.4) ** 2))) / v.r;
        rx += -dy * f;
        ry += dx * f;
      }
      const speed = Math.hypot(rx, ry);
      if (speed < 1e-5) continue;
      const ux = rx / speed, uy = ry / speed;
      const a = jxx[i] ?? 0, b = jxy[i] ?? 0, c = jyy[i] ?? 0;
      const coherence = Math.sqrt((a - c) ** 2 + 4 * b * b) / (a + c + 1e-6);
      const theta = 0.5 * Math.atan2(2 * b, a - c);
      let tx = -Math.sin(theta), ty = Math.cos(theta);
      let along = tx * ux + ty * uy;
      if (along < 0) { tx = -tx; ty = -ty; along = -along; }
      const k = 0.85 * coherence * along;
      const dx = ux * (1 - k) + tx * k, dy = uy * (1 - k) + ty * k;
      const len = Math.hypot(dx, dy) || 1;
      vx[i] = (dx / len) * speed * weight;
      vy[i] = (dy / len) * speed * weight;
    }
  }
  boxBlur(vx, width, height, 2);
  boxBlur(vy, width, height, 2);

  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[i * 2] = (vx[i] ?? 0) / aspect;
    out[i * 2 + 1] = -(vy[i] ?? 0);
  }
  return { data: out, width, height };
}
