// GPU check (verify-browser.ts, `countryChalk`): the chalk M reads at the default framing. For the
// default landscape and two others, the countryside's real sim with the chalk M on, drawn by the
// scene's own program with the M cut and without it (K_chalk off) over the same land, its hillside
// kept open: the largest group of pixels the M turns to chalk is one upright M wholly inside the
// view, below the horizon, about as tall as wide, its two legs (its bounds' outer columns) chalk
// over a third of its height and the foot of its middle (between the legs, low down) open turf.
// The M is measured against the open grass it is cut through, not the crops the land model would
// grow there with the knob off: those may be as pale as a ripe field.
import { fragmentSourceFor, sceneFeatures, shaderValues } from "../../shaders/index.ts";
import { countryScene } from "./index.ts";
import { countryBuild, countryDraw, countryProgram } from "./terrain.verify.ts";

const WIDTH = 320;
const HEIGHT = 180;
/** Landscapes drawn: the default and two others. */
const LANDSCAPES = [0, 3, 7] as const;

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`country chalk: ${message}`);
}

/**
 * The largest 8-connected group of pixels (row 0 at the top) the M turned to chalk: much paler
 * than without it, and near white.
 */
function chalked(on: Uint8Array, off: Uint8Array): Uint8Array {
  const pale = new Uint8Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const o = 4 * ((HEIGHT - 1 - y) * WIDTH + x);
      const r = on[o] ?? 0;
      const g = on[o + 1] ?? 0;
      const b = on[o + 2] ?? 0;
      const before = (off[o] ?? 0) + (off[o + 1] ?? 0) + (off[o + 2] ?? 0);
      const white = Math.min(r, g, b) > 140 && Math.max(r, g, b) - Math.min(r, g, b) < 45;
      if (white && r + g + b > before + 120) pale[y * WIDTH + x] = 1;
    }
  }
  const group = new Int32Array(WIDTH * HEIGHT);
  let best = 0;
  let bestSize = 0;
  let groups = 0;
  for (let start = 0; start < pale.length; start++) {
    if (pale[start] !== 1 || group[start] !== 0) continue;
    groups++;
    group[start] = groups;
    const stack = [start];
    let size = 0;
    for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
      size++;
      const x = at % WIDTH;
      const y = Math.floor(at / WIDTH);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          const next = ny * WIDTH + nx;
          if (nx < 0 || ny < 0 || nx >= WIDTH || ny >= HEIGHT) continue;
          if (pale[next] !== 1 || group[next] !== 0) continue;
          group[next] = groups;
          stack.push(next);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = groups;
    }
  }
  return Uint8Array.from(group, (g) => (g === best && best > 0 ? 1 : 0));
}

export function verifyCountryChalk(gl: WebGL2RenderingContext): Record<string, unknown> {
  const on = { chalk: 1 };
  const program = countryProgram(
    gl,
    fragmentSourceFor(countryScene, sceneFeatures(countryScene, shaderValues(countryScene, on))),
  );
  const result: Record<string, unknown> = {};
  try {
    for (const landscape of LANDSCAPES) {
      const built = countryBuild(gl, { landscape, ...on });
      try {
        const options = { width: WIDTH, height: HEIGHT };
        const drawn = countryDraw(gl, program, built, { landscape, ...on }, options);
        const mask = chalked(drawn, countryDraw(gl, program, built, { landscape }, options));
        let count = 0;
        let x0 = WIDTH;
        let x1 = -1;
        let y0 = HEIGHT;
        let y1 = -1;
        for (let y = 0; y < HEIGHT; y++) {
          for (let x = 0; x < WIDTH; x++) {
            if (mask[y * WIDTH + x] !== 1) continue;
            count++;
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
            y0 = Math.min(y0, y);
            y1 = Math.max(y1, y);
          }
        }
        const at = `landscape ${landscape}`;
        check(count >= 40, `${at}: the M shows in ${count} pixels`);
        const width = x1 - x0 + 1;
        const height = y1 - y0 + 1;
        check(
          x0 > 0.05 * WIDTH && x1 < 0.95 * WIDTH && y0 > 0.37 * HEIGHT && y1 < 0.97 * HEIGHT,
          `${at}: the M (${x0}..${x1}, ${y0}..${y1}) is not wholly in view below the horizon`,
        );
        check(
          height >= 0.5 * width && height <= 2 * width,
          `${at}: the M is ${width} wide and ${height} tall`,
        );
        // Rows of the bounds that hold chalk in its outer columns (a leg), and chalk at the foot of
        // its middle.
        const leg = (from: number, to: number): number => {
          let rows = 0;
          for (let y = y0; y <= y1; y++) {
            let any = false;
            for (let x = from; x <= to; x++) any ||= mask[y * WIDTH + x] === 1;
            if (any) rows++;
          }
          return rows / height;
        };
        const side = Math.max(1, Math.round(0.2 * width));
        const left = leg(x0, x0 + side - 1);
        const right = leg(x1 - side + 1, x1);
        let foot = 0;
        for (let y = y1 - Math.floor(0.25 * height); y <= y1; y++)
          for (let x = x0 + Math.round(0.4 * width); x <= x0 + Math.round(0.6 * width); x++)
            foot += mask[y * WIDTH + x] ?? 0;
        check(
          left >= 0.35 && right >= 0.35,
          `${at}: its legs hold ${left} and ${right} of its height`,
        );
        check(foot === 0, `${at}: ${foot} chalk pixels at the foot of its middle`);
        result[at] = { pixels: count, bounds: [x0, y0, width, height], legs: [left, right] };
      } finally {
        built.dispose();
      }
    }
    return result;
  } finally {
    gl.deleteProgram(program);
  }
}
