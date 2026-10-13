// Hand-drawn border plants for the pond, painted with Canvas 2D into a data texture the shader
// reads: R coverage, G shading (veins, rims, light along the blade), B species and depth layer
// (species × 64 + layer × 16 + 8). Each leaf is drawn alone so its cuts and holes cannot erase the
// leaves underneath, then laid onto the sheet back layer first.

export const speciesIds = ["monstera", "fern", "banana", "heart"] as const;
export type Species = (typeof speciesIds)[number];

export interface DecorConfig {
  /** 0..1: how far the plants reach into the pond. */
  reach: number;
  /** 0..1: how many clumps line the edges. */
  density: number;
  kinds: readonly Species[];
  /** Arrangement variant. */
  seed: number;
}

export function decorKey(config: DecorConfig): string {
  return `${config.reach.toFixed(3)}|${config.density.toFixed(3)}|${config.kinds.join(",")}|${config.seed}`;
}

type Context = OffscreenCanvasRenderingContext2D;

/** Small deterministic PRNG so an arrangement is stable across rebuilds. */
function random(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Ink {
  species: number;
  layer: number;
  /** 0..1 base lightness of this leaf. */
  shade: number;
}

function colour(ink: Ink, shade: number): string {
  const g = Math.round(Math.min(1, Math.max(0, shade)) * 255);
  return `rgb(255, ${g}, ${ink.species * 64 + ink.layer * 16 + 8})`;
}

/** Lighter toward the tip, the way light falls along a blade. */
function bladeFill(ctx: Context, ink: Ink): CanvasGradient {
  const gradient = ctx.createLinearGradient(0, 0, 1, 0);
  gradient.addColorStop(0, colour(ink, ink.shade * 0.7));
  gradient.addColorStop(1, colour(ink, Math.min(1, ink.shade * 1.25)));
  return gradient;
}

// Each leaf is drawn in its own unit space: the stalk joins at (0, 0) and the tip points to (1, 0).

function monstera(ctx: Context, ink: Ink, rand: () => number): void {
  const outline = new Path2D();
  outline.moveTo(0.03, 0);
  outline.bezierCurveTo(-0.1, -0.3, 0.22, -0.56, 0.6, -0.47);
  outline.bezierCurveTo(0.9, -0.38, 1.02, -0.14, 1.0, 0);
  outline.bezierCurveTo(1.02, 0.14, 0.9, 0.38, 0.6, 0.47);
  outline.bezierCurveTo(0.22, 0.56, -0.1, 0.3, 0.03, 0);
  ctx.fillStyle = bladeFill(ctx, ink);
  ctx.fill(outline);
  // Midrib and side veins, a little lighter.
  ctx.strokeStyle = colour(ink, Math.min(1, ink.shade * 1.45));
  ctx.lineWidth = 0.014;
  ctx.beginPath();
  ctx.moveTo(0.02, 0);
  ctx.quadraticCurveTo(0.5, 0.02, 0.98, 0);
  ctx.stroke();
  ctx.lineWidth = 0.006;
  for (let k = 1; k <= 7; k++) {
    const x = 0.08 + k * 0.11;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.quadraticCurveTo(x + 0.06, side * 0.2, x + 0.12, side * 0.42 * Math.sin(Math.PI * Math.min(0.95, x + 0.1)));
      ctx.stroke();
    }
  }
  // The splits and holes that make a monstera.
  ctx.globalCompositeOperation = "destination-out";
  // Deep splits nearly to the midrib, wide at the margin, and a row of holes between them.
  for (let k = 0; k < 6; k++) {
    const a = 0.13 + k * 0.13 + (rand() - 0.5) * 0.025;
    for (const side of [-1, 1]) {
      if (rand() < 0.1) continue;
      ctx.beginPath();
      ctx.moveTo(a, side * 0.75);
      ctx.lineTo(a + 0.06, side * 0.75);
      ctx.lineTo(a + 0.09, side * 0.07);
      ctx.lineTo(a + 0.075, side * 0.065);
      ctx.closePath();
      ctx.fill();
      if (k < 5 && rand() < 0.85) {
        ctx.beginPath();
        ctx.ellipse(a + 0.125, side * (0.16 + rand() * 0.04), 0.036, 0.016, side * 0.55, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.globalCompositeOperation = "source-over";
}

function fern(ctx: Context, ink: Ink, rand: () => number): void {
  const curl = (rand() - 0.5) * 0.3;
  const at = (s: number): [number, number, number] => {
    // Quadratic rachis from (0,0) through (0.5, curl) to (1, curl * 0.6); returns point and heading.
    const x = s;
    const y = 2 * (1 - s) * s * curl + s * s * curl * 0.6;
    const dy = 2 * (1 - 2 * s) * curl + 2 * s * curl * 0.6;
    return [x, y, Math.atan2(dy, 1)];
  };
  const pairs = 20;
  for (let i = 0; i < pairs; i++) {
    const s = 0.06 + (0.92 * i) / pairs;
    const [x, y, heading] = at(s);
    const size = 0.22 * Math.pow(1 - s, 0.8) + 0.03;
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(heading + side * (1.05 - 0.3 * s));
      ctx.scale(size, size);
      // A leaflet with a scalloped edge.
      ctx.beginPath();
      ctx.moveTo(0, 0);
      const lobes = 4;
      for (let j = 0; j <= lobes; j++) {
        const u = j / lobes;
        ctx.quadraticCurveTo(u - 0.12, -0.2 * Math.sin(Math.PI * u) - 0.05, u, -0.12 * Math.sin(Math.PI * u));
      }
      for (let j = lobes; j >= 0; j--) {
        const u = j / lobes;
        ctx.quadraticCurveTo(u + 0.12, 0.2 * Math.sin(Math.PI * u) + 0.05, u, 0.12 * Math.sin(Math.PI * u));
      }
      // Leaflets brighten toward the frond's tip.
      ctx.fillStyle = colour(ink, ink.shade * (0.85 + 0.3 * Math.min(1, s * 1.2)));
      ctx.fill();
      ctx.restore();
    }
  }
  ctx.strokeStyle = colour(ink, ink.shade * 0.6);
  ctx.lineWidth = 0.012;
  ctx.beginPath();
  for (let i = 0; i <= 24; i++) {
    const [x, y] = at(i / 24);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function banana(ctx: Context, ink: Ink, rand: () => number): void {
  const outline = new Path2D();
  outline.moveTo(0, 0);
  outline.bezierCurveTo(0.15, -0.2, 0.75, -0.2, 1.0, 0);
  outline.bezierCurveTo(0.75, 0.2, 0.15, 0.2, 0, 0);
  ctx.fillStyle = bladeFill(ctx, ink);
  ctx.fill(outline);
  ctx.strokeStyle = colour(ink, Math.min(1, ink.shade * 1.5));
  ctx.lineWidth = 0.02;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0.97, 0);
  ctx.stroke();
  // Parallel veins sweeping toward the tip.
  ctx.lineWidth = 0.004;
  ctx.strokeStyle = colour(ink, ink.shade * 1.1);
  for (let k = 0; k < 16; k++) {
    const x = 0.06 + k * 0.055;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + 0.06, side * 0.17 * Math.sin(Math.PI * Math.min(0.97, x + 0.06)));
      ctx.stroke();
    }
  }
  // Wind tears from the margin to the midrib.
  ctx.globalCompositeOperation = "destination-out";
  ctx.lineWidth = 0.01;
  const tears = 4 + Math.floor(rand() * 6);
  for (let k = 0; k < tears; k++) {
    const x = 0.15 + rand() * 0.75;
    const side = rand() < 0.5 ? -1 : 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.05, side * 0.3);
    ctx.lineTo(x, side * 0.015);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";
}

function heart(ctx: Context, ink: Ink): void {
  const outline = new Path2D();
  outline.moveTo(0.1, 0);
  outline.bezierCurveTo(-0.02, -0.28, 0.3, -0.5, 0.6, -0.38);
  outline.bezierCurveTo(0.86, -0.27, 1.0, -0.08, 1.0, 0);
  outline.bezierCurveTo(1.0, 0.08, 0.86, 0.27, 0.6, 0.38);
  outline.bezierCurveTo(0.3, 0.5, -0.02, 0.28, 0.1, 0);
  ctx.fillStyle = bladeFill(ctx, ink);
  ctx.fill(outline);
  ctx.strokeStyle = colour(ink, Math.min(1, ink.shade * 1.5));
  ctx.lineWidth = 0.012;
  ctx.beginPath();
  ctx.moveTo(0.1, 0);
  ctx.lineTo(0.98, 0);
  for (const side of [-1, 1]) {
    for (const x of [0.25, 0.45, 0.65]) {
      ctx.moveTo(x, 0);
      ctx.quadraticCurveTo(x + 0.12, side * 0.18, x + 0.26, side * 0.25 * (1.1 - x));
    }
  }
  ctx.stroke();
}

interface Leaf {
  species: Species;
  x: number;
  y: number;
  angle: number;
  length: number;
  layer: number;
  shade: number;
  flip: boolean;
}

/**
 * Clumps rooted just outside the frame, leaning in: big ones in the corners, smaller ones along
 * the edges. Unit is the sheet height.
 */
function layout(width: number, height: number, config: DecorConfig, rand: () => number): Leaf[] {
  const kinds = config.kinds.length > 0 ? config.kinds : speciesIds;
  const pick = (prefer: readonly Species[]): Species => {
    const pool = kinds.filter((kind) => prefer.includes(kind));
    const from = pool.length > 0 && rand() < 0.75 ? pool : kinds;
    return from[Math.floor(rand() * from.length)] ?? "fern";
  };
  const reach = height * (0.55 + 0.9 * config.reach);
  const leaves: Leaf[] = [];
  const clump = (x: number, y: number, inward: number, big: boolean) => {
    const species = pick(big ? ["monstera", "banana"] : ["fern", "heart"]);
    const count = (big ? 3 : 2) + Math.floor(rand() * 2);
    for (let i = 0; i < count; i++) {
      const lengthScale = species === "fern" ? 1.1 : species === "banana" ? 1.05 : species === "heart" ? 0.55 : 0.8;
      // Spread the leaves of a clump evenly across its fan, with a little jitter.
      const fan = (count === 1 ? 0 : i / (count - 1) - 0.5) * (big ? 1.9 : 1.3) + (rand() - 0.5) * 0.3;
      leaves.push({
        species,
        x: x + (rand() - 0.5) * height * 0.06,
        y: y + (rand() - 0.5) * height * 0.06,
        angle: inward + fan,
        length: reach * (big ? 0.36 : 0.26) * lengthScale * (0.75 + 0.45 * rand()),
        layer: big ? (rand() < 0.5 ? 2 : 1) : Math.floor(rand() * 2),
        shade: 0.45 + 0.35 * rand(),
        flip: rand() < 0.5,
      });
    }
  };
  const margin = height * 0.03;
  // Corners, rooted outside the frame and leaning toward the middle.
  for (const [x, y] of [[-margin, -margin], [width + margin, -margin], [-margin, height + margin], [width + margin, height + margin]] as const) {
    if (rand() < 0.15 * (1 - config.density)) continue;
    clump(x, y, Math.atan2(height / 2 - y, width / 2 - x), true);
  }
  // Edges: spacing tightens with density.
  const spacing = height * (0.75 - 0.5 * config.density);
  const edges: [number, number, number, number, number][] = [
    [0, -margin, width, -margin, Math.PI / 2],
    [0, height + margin, width, height + margin, -Math.PI / 2],
    [-margin, 0, -margin, height, 0],
    [width + margin, 0, width + margin, height, Math.PI],
  ];
  for (const [x0, y0, x1, y1, inward] of edges) {
    const length = Math.hypot(x1 - x0, y1 - y0);
    for (let d = spacing * (0.5 + rand() * 0.5); d < length - spacing * 0.4; d += spacing * (0.7 + rand() * 0.6)) {
      if (rand() < 0.2) continue;
      const t = d / length;
      clump(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, inward, rand() < 0.2);
    }
  }
  return leaves.sort((a, b) => a.layer - b.layer || b.length - a.length);
}

/** Paint the whole sheet: black background, leaves back to front. */
export function paintDecor(ctx: Context, width: number, height: number, config: DecorConfig): void {
  const rand = random(17 + config.seed * 101);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  const leaves = layout(width, height, config, rand);
  const size = Math.ceil(Math.max(...leaves.map((leaf) => leaf.length), 1) * 2.2);
  const sheet = new OffscreenCanvas(size, size);
  const leafCtx = sheet.getContext("2d");
  if (!leafCtx) throw new Error("landing: 2d canvas unavailable");
  for (const leaf of leaves) {
    const ink: Ink = { species: speciesIds.indexOf(leaf.species), layer: leaf.layer, shade: leaf.shade };
    leafCtx.setTransform(1, 0, 0, 1, 0, 0);
    leafCtx.clearRect(0, 0, size, size);
    leafCtx.translate(size / 2, size / 2);
    leafCtx.rotate(leaf.angle);
    leafCtx.scale(leaf.length, leaf.length * (leaf.flip ? -1 : 1));
    switch (leaf.species) {
      case "monstera": monstera(leafCtx, ink, rand); break;
      case "fern": fern(leafCtx, ink, rand); break;
      case "banana": banana(leafCtx, ink, rand); break;
      case "heart": heart(leafCtx, ink); break;
      default: {
        const unreachable: never = leaf.species;
        throw new Error(`landing: unknown plant ${String(unreachable)}`);
      }
    }
    ctx.drawImage(sheet, leaf.x - size / 2, leaf.y - size / 2);
  }
}
