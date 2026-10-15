// Recognisable constellations, simplified from their usual stick figures. Local coordinates are y
// up in sky units; `at` places each figure (x as a fraction of the half-width, y in sky units) so
// they stay in frame at any aspect ratio.

interface Figure {
  name: string;
  at: readonly [number, number];
  scale: number;
  /** [x, y, brightness 0..1] */
  stars: readonly (readonly [number, number, number])[];
  /** Index pairs into `stars`. */
  lines: readonly (readonly [number, number])[];
}

const figures: readonly Figure[] = [
  {
    name: "Orion",
    at: [0.12, 0.2],
    scale: 0.42,
    stars: [
      [-0.18, 0.32, 1],
      [0.17, 0.3, 0.8],
      [0, 0.45, 0.5],
      [-0.06, 0, 0.8],
      [0, 0.02, 0.8],
      [0.06, 0.04, 0.7],
      [-0.14, -0.32, 0.7],
      [0.2, -0.28, 1],
    ],
    lines: [
      [0, 2],
      [2, 1],
      [0, 3],
      [1, 5],
      [3, 4],
      [4, 5],
      [3, 6],
      [5, 7],
    ],
  },
  {
    name: "Big Dipper",
    at: [0.6, 0.36],
    scale: 0.42,
    stars: [
      [-0.45, 0.02, 0.8],
      [-0.3, 0.07, 0.8],
      [-0.15, 0.06, 0.9],
      [0, 0.02, 0.6],
      [0.03, -0.14, 0.7],
      [0.25, -0.12, 0.8],
      [0.24, 0.06, 0.9],
    ],
    lines: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
      [6, 3],
    ],
  },
  {
    name: "Cassiopeia",
    at: [-0.3, 0.4],
    scale: 0.4,
    stars: [
      [-0.3, 0.05, 0.7],
      [-0.15, -0.08, 0.8],
      [0, 0, 0.8],
      [0.15, -0.1, 0.7],
      [0.28, 0.06, 0.6],
    ],
    lines: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ],
  },
  {
    name: "Cygnus",
    at: [0.86, 0.08],
    scale: 0.4,
    stars: [
      [0, 0.3, 1],
      [0, 0.05, 0.7],
      [-0.2, 0, 0.6],
      [0.2, 0.12, 0.6],
      [0.02, -0.3, 0.6],
    ],
    lines: [
      [0, 1],
      [1, 4],
      [2, 1],
      [1, 3],
    ],
  },
  {
    name: "Leo",
    at: [-0.72, 0.12],
    scale: 0.5,
    stars: [
      [-0.25, -0.12, 1],
      [-0.24, 0, 0.5],
      [-0.2, 0.1, 0.8],
      [-0.24, 0.18, 0.5],
      [-0.16, 0.25, 0.5],
      [-0.07, 0.22, 0.6],
      [0.12, 0.08, 0.6],
      [0.12, -0.05, 0.5],
      [0.32, -0.02, 0.8],
    ],
    lines: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [2, 6],
      [6, 8],
      [8, 7],
      [7, 0],
    ],
  },
  {
    name: "Crux",
    at: [-0.15, -0.02],
    scale: 0.45,
    stars: [
      [0, 0.16, 0.8],
      [0.02, -0.16, 0.9],
      [-0.1, 0.02, 0.8],
      [0.11, 0.05, 0.6],
      [0.05, -0.05, 0.4],
    ],
    lines: [
      [0, 1],
      [2, 3],
    ],
  },
];

/** The Manifold mark traced as an asterism, after the app icon's M. Kept separate so it toggles alone. */
const mark: Figure = {
  name: "Manifold",
  at: [0.45, 0.06],
  scale: 0.24,
  stars: [
    [-0.47, -0.5, 0.8],
    [-0.47, 0, 0.6],
    [-0.47, 0.5, 1],
    [0, -0.08, 0.7],
    [0.47, 0.5, 1],
    [0.47, 0, 0.6],
    [0.47, -0.5, 0.8],
  ],
  lines: [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
    [5, 6],
  ],
};

/** Must match `MAX_CON_STARS` / `MAX_CON_LINES` in the fragment shader. */
export const MAX_CON_STARS = 48;
export const MAX_CON_LINES = 48;

export interface ConstellationUniforms {
  /** Per star: anchor x (half-width fraction), anchor y, offset x, offset y. */
  stars: Float32Array;
  brightness: Float32Array;
  /** Per line: two star indices. */
  lines: Float32Array;
  starCount: number;
  lineCount: number;
  /** First star and line index belonging to the Manifold mark. */
  markStar: number;
  markLine: number;
}

export const constellationUniforms: ConstellationUniforms = (() => {
  const stars = new Float32Array(MAX_CON_STARS * 4);
  const brightness = new Float32Array(MAX_CON_STARS);
  const lines = new Float32Array(MAX_CON_LINES * 2);
  let starCount = 0;
  let lineCount = 0;
  let markStar = 0;
  let markLine = 0;
  for (const figure of [...figures, mark]) {
    if (figure === mark) {
      markStar = starCount;
      markLine = lineCount;
    }
    const first = starCount;
    for (const [x, y, b] of figure.stars) {
      stars.set([figure.at[0], figure.at[1], x * figure.scale, y * figure.scale], starCount * 4);
      brightness[starCount] = b;
      starCount++;
    }
    for (const [a, b] of figure.lines) {
      lines.set([first + a, first + b], lineCount * 2);
      lineCount++;
    }
  }
  return { stars, brightness, lines, starCount, lineCount, markStar, markLine };
})();
