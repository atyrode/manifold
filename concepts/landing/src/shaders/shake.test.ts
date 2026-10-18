import { describe, expect, test } from "bun:test";
import { loadScene, sceneIds, type SceneId } from "../scenes/index.ts";
import { assembleFragment, fragmentSourceFor, sceneFeatures, sceneFeaturesAll } from "./index.ts";
import { GlslShakeError, shakeGlsl } from "./shake.ts";

const HEAD = "#version 300 es\nprecision highp float;\nout vec4 o;\n";

/** The non-blank lines of a program, trimmed. */
const code = (glsl: string): string[] =>
  glsl
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

describe("shakeGlsl", () => {
  test("keeps what main reaches, each line where it was, without comments", () => {
    const source = `${HEAD}uniform float uUsed;
uniform float uUnused;
float unused(float x) { return x; }
float helper(float x) {
  /* a comment
     over lines */ return x * 2.0; // doubled
}
void main() { o = vec4(helper(uUsed)); }
`;
    expect(shakeGlsl(source)).toBe(`${HEAD}uniform float uUsed;


float helper(float x) {

 return x * 2.0;
}
void main() { o = vec4(helper(uUsed)); }
`);
  });

  test("keeps every overload and the prototype of a function main reaches", () => {
    const shaken = shakeGlsl(`${HEAD}float f(float x);
float f(vec2 v) { return v.x; }
float g() { return 1.0; }
float[2] pair() { return float[2](1.0, 2.0); }
float[2] unpaired() { return float[2](3.0, 4.0); }
void main() { o = vec4(f(1.0) + pair()[1]); }
float f(float x) { return x; }
`);
    expect(code(shaken)).toEqual([
      ...code(HEAD),
      "float f(float x);",
      "float f(vec2 v) { return v.x; }",
      "float[2] pair() { return float[2](1.0, 2.0); }",
      "void main() { o = vec4(f(1.0) + pair()[1]); }",
      "float f(float x) { return x; }",
    ]);
  });

  test("follows macros, struct constructors and initialisers", () => {
    const shaken = shakeGlsl(`${HEAD}#define UNUSED 3.0
#define TWICE(x) twice(x)
#define K uParams[1].y
uniform vec4 uParams[2];
struct Pair { float a; float b; };
struct Lone { float a; };
float twice(float x) { return 2.0 * x; }
float seed(float x) { return x + 1.0; }
const float SEED = seed(1.0), OTHER = 2.0;
float base() { return 0.0; }
void main() { Pair p = Pair(TWICE(K), SEED); o = vec4(p.a + p.b); }
`);
    expect(code(shaken)).toEqual([
      ...code(HEAD),
      "#define TWICE(x) twice(x)",
      "#define K uParams[1].y",
      "uniform vec4 uParams[2];",
      "struct Pair { float a; float b; };",
      "float twice(float x) { return 2.0 * x; }",
      "float seed(float x) { return x + 1.0; }",
      "const float SEED = seed(1.0), OTHER = 2.0;",
      "void main() { Pair p = Pair(TWICE(K), SEED); o = vec4(p.a + p.b); }",
    ]);
  });

  test("takes no swizzle or number for a mention, and a number's point for no member's", () => {
    const shaken = shakeGlsl(`${HEAD}struct S { float speed; };
float y() { return 0.0; }
float e3() { return 0.0; }
float scale(float x) { return x; }
void main() {
  S s = S(2.0);
  vec2 v = vec2(s.speed);
  o = vec4(v.y + 1.5*scale(2.0) + 2.5e3 + .5 + float(0x1F) + (v.x == 1.0 ? 1.0 : 0.0));
}
`);
    expect(code(shaken).filter((line) => /^(float|struct)/.test(line))).toEqual([
      "struct S { float speed; };",
      "float scale(float x) { return x; }",
    ]);
  });

  test("resolves the conditionals with the program's own defines", () => {
    const shaken = shakeGlsl(`${HEAD}#define TIER 2
#define LEVEL TIER
#define FLAG 1
#if LEVEL >= 2 && defined(FLAG) && 1 + 2 * 3 == 7 && (8 >> 1) == 4 && -1 < 0 && !(0 || 0)
float a() { return 1.0; }
#elif 1
float a() { return 2.0; }
#else
float a() { return 3.0; }
#endif
#ifndef MISSING
#define MISSING 0
#endif
#ifdef MISSING
#if MISSING
float b() { return gone(); }
#else
float c() { return 4.0; }
#endif
#endif
void main() { o = vec4(a() + c()); }
`);
    expect(code(shaken)).toEqual([
      ...code(HEAD),
      "float a() { return 1.0; }",
      "float c() { return 4.0; }",
      "void main() { o = vec4(a() + c()); }",
    ]);
  });

  test("ends on references that go round", () => {
    const shaken = shakeGlsl(`${HEAD}#define LOOP LOOP
float b();
float a() { return b() + LOOP; }
float b() { return a(); }
void main() { o = vec4(a()); }
`);
    expect(code(shaken)).toHaveLength(code(HEAD).length + 5);
    expect(() => shakeGlsl(`${HEAD}#define LOOP LOOP\n#if LOOP\n#endif\nvoid main() {}\n`)).toThrow(
      GlslShakeError,
    );
  });

  test("throws for a program it cannot read", () => {
    for (const program of [
      "#endif\nvoid main() {}\n",
      "#if 1\n#else\n#else\n#endif\nvoid main() {}\n",
      "#if 1\nvoid main() {}\n",
      "#if UNDEFINED\n#endif\nvoid main() {}\n",
      "#define F(x) x\n#if F(1)\n#endif\nvoid main() {}\n",
      "#if 1.0\n#endif\nvoid main() {}\n",
      "#if 1 / 0\n#endif\nvoid main() {}\n",
      "#define CAT(a, b) a ## b\nvoid main() {}\n",
      "void main() {}}\n",
      "void main() {}\nfloat x = 1.0\n",
      "float f() { return 1.0; }\n",
    ])
      expect(() => shakeGlsl(`${HEAD}${program}`)).toThrow(GlslShakeError);
  });
});

/**
 * Each scene's shaken program may grow to about 10% past its size when the ceiling was last set,
 * in characters: [default program, all-features program]. A scene past it has grown its compile
 * cost; raise its ceiling on purpose, or find what it pulled in.
 */
const BUDGET = {
  autumn: [90500, 181500],
  bamboo: [103500, 195000],
  bar: [122500],
  bees: [114500, 191000],
  bonsai: [59500],
  campfire: [122500, 169000],
  chladni: [23000],
  clouds: [59500, 104500],
  country: [138500, 278500],
  delta: [20500],
  dew: [62500, 94500],
  dunes: [79500, 159500],
  falls: [110000, 196500],
  ferro: [22000],
  film: [21500],
  fireflies: [65500, 146000],
  flock: [51500, 147500],
  forest: [124000, 199000],
  fractal: [34000],
  frost: [68000, 112500],
  garden: [97000, 127500],
  harmonograph: [17000],
  hyperbolic: [24000],
  incense: [39000],
  island: [89500, 134500],
  kelp: [67500],
  lake: [89000, 179500],
  lanterns: [84500, 178500],
  lava: [39500, 42500],
  marble: [20000],
  meadow: [106000, 184000],
  mobile: [39000],
  orbit: [21000, 33500],
  pearl: [14000],
  pendula: [25500, 30500],
  petri: [23500],
  physarum: [27500],
  pond: [49000, 52500],
  prism: [23000],
  ripple: [23000, 26500],
  sandtable: [26000],
  shanshui: [54000],
  shore: [104000, 182000],
  sill: [114000, 181000],
  skyward: [93000, 176500],
  street: [129500, 212000],
  swell: [82500, 154000],
  tidepool: [53000],
  train: [154000, 199000],
} as const satisfies Record<SceneId, readonly [number, number?]>;

const loaded = await Promise.all(sceneIds.map(async (id) => ({ id, scene: await loadScene(id) })));

describe("scene programs", () => {
  const programs = loaded.flatMap(({ id, scene }) => {
    const all = sceneFeaturesAll(scene);
    return [
      { id, scene, kind: "default", features: sceneFeatures(scene) },
      ...(all === undefined ? [] : [{ id, scene, kind: "all-features", features: all }]),
    ];
  });

  test("shake line for line, to a program that shakes to itself", () => {
    for (const { id, scene, kind, features } of programs) {
      const raw = assembleFragment(scene, features).split("\n");
      const shaken = fragmentSourceFor(scene, features);
      const lines = shaken.split("\n");
      expect({ id, kind, lines: lines.length }).toEqual({ id, kind, lines: raw.length });
      // Every line holds code from the same line of the assembled program (annotate's line numbers).
      const moved = lines.findIndex((line, i) => !(raw[i] ?? "").includes(line.trim()));
      expect({ id, kind, moved }).toEqual({ id, kind, moved: -1 });
      expect({ id, kind, again: shakeGlsl(shaken) === shaken }).toEqual({ id, kind, again: true });
    }
  });

  test("stay within their compile budget", () => {
    const rows = programs.map(({ id, scene, kind, features }) => {
      const budget: readonly [number, number?] = BUDGET[id];
      return {
        id,
        kind,
        assembled: assembleFragment(scene, features).length,
        shaken: fragmentSourceFor(scene, features).length,
        ceiling: kind === "default" ? budget[0] : budget[1],
      };
    });
    console.log(
      rows
        .map(
          (row) =>
            `${`${row.id} ${row.kind}`.padEnd(24)} ${String(row.assembled).padStart(7)} -> ` +
            `${String(row.shaken).padStart(7)} chars (ceiling ${row.ceiling ?? "none"})`,
        )
        .join("\n"),
    );
    for (const row of rows)
      expect({ ...row, within: row.shaken <= (row.ceiling ?? 0) }).toEqual({
        ...row,
        within: true,
      });
  });
});
