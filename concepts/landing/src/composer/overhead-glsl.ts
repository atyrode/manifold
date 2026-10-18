// The overhead composer's program and code (ADR 0062 Phase 4, README "The overhead composer"): a
// patch seen straight down, orthographic, its frame `span` metres tall (OverheadRig). Its site is a
// bed and the water over it: the bed layer draws the floor, seen through the water where the water
// layer's surface bends it (x.floorP); the water layer's begin sets that surface from its sim or its
// own field (x.slope, x.depth, x.flow, x.waterCol, x.caustic). Every other layer stands, floats,
// grows or swims over them, in the composer's order:
//   1. The patch (`overheadPatch`): the cell, its point p (screen heights from the frame's centre,
//      x right, y up), the light (the sun or lamp on the frame, x.sunUV and x.sun, and its strength,
//      x.power: the pond's sun until a layer's begin says otherwise), still air (x.wind) and a dry,
//      flat surface; then every shared chunk's and every layer's `begin`, in canonical order (the
//      water's sets the surface, the light's layer the light, the breeze's layer the breeze).
//   2. The bed layer's `bed` (or, under one mid-turn, the plain bed).
//   3. The water layer's `water`, over it.
//   4. Every `floor` pass: what lies on the bed, seen through the water (weeds, stems).
//   5. Every `cast` pass: the shadows on the bed, the most of every layer's, darkening what lies there.
//   6. Every `swim` pass: what is in the water, over the shadows (the koi).
//   7. Every `float` pass: what is on the surface (pads, petals, the rings' light, a boat).
//   8. Every `stand` pass: what stands out of the water (a stone).
//   9. Every `cover` pass: the shade of what hangs over the patch (c.shade), the light through it.
//  10. Every `glint` pass: the sun's glint on open water (not where c.dry).
//  11. Every `over` pass: over everything (the border's leaves).
//  12. Every `grade` pass; then the cell's colour is its rgb, and its source where no layer dithered.
// A cell (`Spot`) carries the colour, the Shade channels its layers write (ink, accent, shimmer), the
// cover's shade, whether it is dry, and the undithered colour where a layer dithered it (the tank's
// lamp ramp). Turns are the outdoor composer's (glsl.ts turnsGlsl, sim.ts): a program that draws
// them shows each layer's passes in a growing or shrinking share of cells, cut per cell. The World
// over the patch is not built: no sky, weather or birds, and the composer lists no knobs of its own.
import { effective } from "../params.ts";
import type { SceneCode } from "../scenes/types.ts";
import { TURNS_GATE, type ComposedScene } from "./compose.ts";
import { accessorsGlsl, begins, passCalls, turnsGlsl, type OnLayer } from "./glsl.ts";
import { allocate, composedSim, type Allocation } from "./sim.ts";
import type { LayerCode, LayerDef, OverheadPreset, OverheadRig } from "./types.ts";

/** The entry every overhead program has. */
export const OVERHEAD_ENTRY = "overheadEntry";

/** An overhead layer's code: its GLSL and its sim take the overhead rig. */
export type OverheadCode = LayerCode<OverheadRig, OverheadRig>;

export class OverheadCodeError extends Error {}

/** What one overhead program is assembled from. */
interface Assembly {
  readonly preset: OverheadPreset;
  /** On, placed, canonical order: index k is texel k of the atlas's row 0. */
  readonly layers: readonly OnLayer<OverheadRig, OverheadRig>[];
  readonly allocation: Allocation;
  readonly triggers: Readonly<Record<string, number>>;
  readonly rewrite: (layer: LayerDef, glsl: string) => string;
  readonly turns: boolean;
}

/** The prelude's fixed part: what every pass is given, the cell, the patch and the plain bed. */
const PRELUDE = `
// What every pass is given (composer/overhead-glsl.ts). p: screen heights from the frame's centre,
// x right, y up. The light: where the sun (or lamp) stands, in uv and in p, on the frame or off it,
// and its strength; the breeze (0 still). The surface: the water's depth (0 shallow .. 1 deep; 0
// with none), its slope here, where the bed is seen through it (p bent by the slope), its current,
// its own colour, and the light it gathers on the bed.
struct Patch {
  vec2 uv; vec2 cell; float aspect; float t; float tm; float m; vec2 p;
  vec2 sunUV; vec2 sun; float power; float wind;
  float depth; vec2 slope; vec2 floorP; vec2 flow; vec3 waterCol; float caustic;
};
// What a cell shows: its colour, its Shade channels (ink, accent, shimmer), the cover's shade over
// it, whether it is dry (nothing glints on it), and where a layer dithered col, the colour undithered.
struct Spot { vec3 col; Shade o; float shade; bool dry; bool dithered; vec3 src; };

// The patch at this cell: the light the pond's sun gives until a layer's begin sets its own, still
// air, and a dry, flat surface until the water's begin sets it.
Patch overheadPatch(vec2 uv, vec2 cell, float t) {
  Patch x;
  x.uv = uv;
  x.cell = cell;
  x.aspect = uRes.x / uRes.y;
  x.t = t;
  x.tm = uMotionTime;
  x.m = uMotion;
  x.p = (uv - 0.5) * vec2(x.aspect, 1.0);
  x.sunUV = vec2(0.15, 1.15);
  x.sun = (x.sunUV - 0.5) * vec2(x.aspect, 1.0);
  x.power = 0.4;
  x.wind = 0.0;
  x.depth = 0.0;
  x.slope = vec2(0.0);
  x.floorP = x.p;
  x.flow = vec2(0.0);
  x.waterCol = vec3(0.06, 0.46, 0.42);
  x.caustic = 0.0;
  return x;
}

// The plain bed: silt, drawn under a bed while it plays its own entrance or exit, where it does not show.
void overheadPlainBed(Patch x, inout Spot c) {
  c.col = vec3(0.36, 0.33, 0.27) * (0.9 + 0.2 * fbm(x.floorP * 6.0));
  c.o.ink = 0.12;
}
`;

/** The whole overhead program's own GLSL: the prelude, the shared and the layers' GLSL, the entry. */
function overheadGlsl(a: Assembly): string {
  const { preset, layers, allocation, turns } = a;
  const rig = preset.rig;
  const bed = layers.findIndex(({ def }) => def.role === "bed" && def.passes.bed !== undefined);
  const shared = new Map<string, string>();
  for (const { code } of layers)
    for (const chunk of code.shared ?? [])
      if (!shared.has(chunk.id)) shared.set(chunk.id, chunk.glsl(rig));
  const triggers = Object.entries(a.triggers)
    .map(([key, slot]) => `const int TRIGGER_${key} = ${slot};`)
    .join("\n");
  const n = Math.max(1, layers.length);
  const calls = (kind: Parameters<typeof passCalls>[2], role?: LayerDef["role"]) =>
    passCalls(layers, turns, kind, "x, c", (def) => role === undefined || def.role === role, [
      "Spot",
      "c",
    ]);
  return `
// ---- the overhead composer (composer/overhead-glsl.ts): preset ${preset.id}, layers ${layers.map(({ def }) => def.id).join(", ")} ----
${triggers}
${PRELUDE}
${turnsGlsl(turns)}
${accessorsGlsl(layers, allocation)}
${[...shared.values()].join("\n")}
${layers.map(({ def, code }) => a.rewrite(def, code.glsl(rig))).join("\n")}
Shade ${OVERHEAD_ENTRY}(vec2 uv, vec2 cell, float t) {
  // 1. The patch, then each shared part's and each layer's own state for this cell.
  Patch x = overheadPatch(uv, cell, t);
${begins(layers)}
${
  turns
    ? `  // Which cells show each layer: every one at rest, its share while it enters or leaves.
  bool shows[${n}];
${layers.map((_, k) => `  shows[${k}] = layerShows(${k}, cell);`).join("\n")}\n`
    : ""
}  Spot c = Spot(vec3(0.0), blankShade(), 0.0, false, false, vec3(0.0));
  // 2. The bed.
${turns && bed >= 0 ? `  if (!shows[${bed}]) overheadPlainBed(x, c);\n` : ""}${bed < 0 ? "  overheadPlainBed(x, c);\n" : calls("bed", "bed")}  // 3. The water over it.
${calls("water", "water")}  // 4. On the bed, seen through the water.
${calls("floor")}  // 5. The shadows on the bed: the most of every layer's.
  float shadow = 0.0;
${passCalls(layers, turns, "cast", "x, shadow", () => true, ["float", "shadow"])}  c.o.ink *= 1.0 - 0.85 * shadow;
  c.col = c.col * (1.0 - 0.55 * shadow);
  c.src *= 1.0 - 0.55 * shadow;
  // 6. In the water.
${calls("swim")}  // 7. On the surface.
${calls("float")}  // 8. Standing out of the water.
${calls("stand")}  // 9. The cover's shade, and the light through it.
${calls("cover")}  // 10. The glint on open water.
${calls("glint")}  // 11. Over everything.
${calls("over")}  // 12. The grade.
${calls("grade")}  c.o.rgb = c.col;
  c.o.source = c.dithered ? c.src : c.col;
  return c.o;
}
`;
}

/**
 * An overhead scene's code from every offered layer's (by id), as composedCode (code.ts) assembles
 * an outdoor one: `glslFor(features)` the program of the layers that feature set's LAYER_<ID> gates
 * hold, steady or drawing their turns; `glsl` the one at the defaults; `sim` the composed sim.
 */
export function overheadCode(
  scene: ComposedScene<OverheadPreset>,
  codes: Readonly<Record<string, OverheadCode>>,
): Required<SceneCode> {
  const preset = scene.preset;
  const codeOf = (id: string): OverheadCode => {
    const code = codes[id];
    if (code === undefined)
      throw new OverheadCodeError(`scene ${preset.id}: no code for its layer ${id}`);
    return code;
  };
  for (const layer of scene.offered) codeOf(layer.id);
  const glslFor = (features: Readonly<Record<string, number>>): string => {
    const on = new Set<string>();
    for (const [name, value] of Object.entries(features)) {
      const id = scene.gates[name];
      if (id !== undefined && value === 1) on.add(id);
    }
    const layers = scene.place(on).layers.map((placed) => placed.layer);
    return overheadGlsl({
      preset,
      layers: layers.map((def) => ({ def, code: codeOf(def.id) })),
      allocation: allocate(layers),
      triggers: scene.triggers,
      rewrite: scene.rewrite(layers),
      turns: features[TURNS_GATE] === 1,
    });
  };
  const params = scene.def.params;
  const defaults = Object.fromEntries(params.map((knob) => [knob.key, effective(knob, {})]));
  return {
    glsl: glslFor(scene.def.featuresFor?.(defaults) ?? {}),
    entry: OVERHEAD_ENTRY,
    glslFor,
    sim: composedSim({
      params,
      camera: preset.rig,
      minAspect: preset.rig.minAspect,
      gates: scene.gates,
      placement: scene.placed,
      sims: Object.fromEntries(scene.offered.map((layer) => [layer.id, codes[layer.id]?.sim])),
      shortParams: scene.shortParams,
      gust: undefined,
      rigLift: () => 0,
      offered: scene.offered,
      drawsTurns: (features) => features[TURNS_GATE] === 1,
    }),
  };
}
