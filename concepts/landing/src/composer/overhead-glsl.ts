// The overhead composer's program and code (ADR 0062 Phase 4, README "The overhead composer"): a
// patch seen straight down, orthographic, its frame `span` metres tall (OverheadRig). Its site is a
// bed and the water over it: the bed layer draws the floor, seen through the water where the water
// layer's surface bends it (x.floorP); the water layer's begin sets that surface from its sim or its
// own field (x.slope, x.depth, x.flow, x.waterCol, x.caustic). Every other layer stands, floats,
// grows or swims over them, in the composer's order:
//   1. The patch (`overheadPatch`): the cell, its point p (screen heights from the frame's centre,
//      x right, y up), the light (the sun or lamp on the frame, x.sunUV and x.sun, and its strength,
//      x.power), the World's wind over it (x.wind: |K_wind| where a layer is open to the sky, else
//      still air), the World's light where a layer the sky lights is offered (`overheadWorld`: the
//      key, its colour, the ambient, the sun's place from the key; else a fixed sun until a layer's
//      begin says otherwise) and a dry, flat surface; then every shared chunk's and every layer's
//      `begin`, in canonical order (the water's sets the surface, a lamp's layer the light).
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
//  12. Where the preset was painted for an hour of its own (OverheadPreset.painted), the World's
//      light against that hour's (x.relight); every `grade` pass; then the cell's colour is its
//      rgb, and its source where no layer dithered.
// A cell (`Spot`) carries the colour, the Shade channels its layers write (ink, accent, shimmer), the
// cover's shade, whether it is dry, and the undithered colour where a layer dithered it (the tank's
// lamp ramp). Turns are the outdoor composer's (glsl.ts turnsGlsl, sim.ts): a program that draws
// them shows each layer's passes in a growing or shrinking share of cells, cut per cell. Of the
// World over the patch (compose.ts worldPatchKnobs), its rain and wind ring and roughen the water,
// and over a patch the sky lights its hour places the sun (or the moon) and lights the patch, the
// rain's overcast greys that light, and the cloud deck's shadows drift over it with the wind; no
// fog, snow, wet bed or birds yet.
import { effective } from "../params.ts";
import type { SceneCode } from "../scenes/types.ts";
import { glslFloat } from "../shaders/glsl.ts";
import { WORLD_CLOUD_BASE } from "../shaders/lib/world.ts";
import { skyState } from "../world-clock.ts";
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
  /** A layer open to the sky is offered, so the World's rain and wind are knobs (LayerDef.open). */
  readonly open: boolean;
  /** A layer the sky lights is offered, so the World's hour and cloud light the patch (LayerDef.sunlit). */
  readonly sunlit: boolean;
}

/**
 * Where the sun's image stands on the frame for a key light (overheadWorld: x.sun = this times the
 * key's run over its rise), in screen heights: as an eye this high over the frame's centre would
 * see it mirrored, nearer than the pond's own (POND_EYE) would, so that at the pond's painted hour
 * the sun stands where the pond's own sun stood on a 16:10 frame, uv (0.15, 1.15).
 */
const OVERHEAD_SUN_STAGE = 0.563;

/**
 * How a painted preset follows the World's light against its painted hour's (the eye adapting): by
 * day its brightness to the power RELIGHT_ADAPT (half the light reads as 0.81 of it), so the
 * 4-level palette keeps the water's colour through the day; through twilight into the night it
 * falls with the light, the night dark; and RELIGHT_TINT of the light's colour, so a low sun warms
 * the patch without greying its water.
 */
const RELIGHT_ADAPT = 0.3;
const RELIGHT_TINT = 0.4;

/** The fixed part of the prelude: what every pass is given and the cell. */
const PRELUDE = `
// What every pass is given (composer/overhead-glsl.ts). p: screen heights from the frame's centre,
// x right, y up. The light: where the sun (or lamp) stands, in uv and in p, on the frame or off it,
// and its strength; the World's wind over the patch (0 still .. 1). The World's light where the sky
// lights the patch (overheadWorld; neutral elsewhere: a white key straight overhead, no ambient):
// toward the key (the sun, or the moon by night; x right, y up the frame, z up to the camera), its
// light here (greyed by the rain's overcast, under the cloud deck's shadow), the sky's ambient, the
// overcast and the deck's cover; against a painted preset's hour, the key's strength and the light.
// The surface: the water's depth (0 shallow .. 1 deep; 0 with none), its slope here, where the bed
// is seen through it (p bent by the slope), its current, its own colour, and the light it gathers
// on the bed.
struct Patch {
  vec2 uv; vec2 cell; float aspect; float t; float tm; float m; vec2 p;
  vec2 sunUV; vec2 sun; float power; float wind;
  vec3 key; vec3 keyCol; vec3 amb; float storm; float cover; float keyGain; vec3 relight;
  float depth; vec2 slope; vec2 floorP; vec2 flow; vec3 waterCol; float caustic;
};
// What a cell shows: its colour, its Shade channels (ink, accent, shimmer), the cover's shade over
// it, whether it is dry (nothing glints on it), and where a layer dithered col, the colour undithered.
struct Spot { vec3 col; Shade o; float shade; bool dry; bool dithered; vec3 src; };
`;

/** The patch's light where no layer the sky lights is offered: the pond's old sun, a neutral World. */
const FIXED_LIGHT = `
  x.sunUV = vec2(0.15, 1.15);
  x.sun = (x.sunUV - 0.5) * vec2(x.aspect, 1.0);
  x.power = 0.4;
  x.key = vec3(0.0, 0.0, 1.0);
  x.keyCol = vec3(1.0);
  x.amb = vec3(0.0);
  x.storm = 0.0;
  x.cover = 0.0;
  x.keyGain = 1.0;
  x.relight = vec3(1.0);`;

/** A vec3 literal. */
function vec3(v: readonly number[]): string {
  return `vec3(${v.map(glslFloat).join(", ")})`;
}

/**
 * The World's light over the patch at a painted hour, as overheadWorld works it out there (dry, no
 * cloud): the key's light, and the light on the painted things (the ambient and the key wrapped
 * half round them: leaves, fish, pads and ruffled water face every way, not only up).
 */
function paintedLight(hour: number): { key: string; light: string } {
  const sky = skyState(hour);
  const moonlit = sky.sun[1] < -0.04;
  const [bx, by, bz] = moonlit ? sky.moon : sky.sun;
  const rise = Math.max(by, 0.05);
  const up = rise / Math.hypot(bx, bz, rise);
  const key = (moonlit ? sky.moonColor : sky.sunColor).map((c) => c * (moonlit ? 1.4 : 1.15));
  const light = sky.ambient.map((c, i) => c * 0.9 + (key[i] ?? 0) * (0.5 + 0.5 * up));
  return { key: vec3(key), light: vec3(light) };
}

/**
 * The World over a patch the sky lights (compose.ts worldPatchKnobs: K_time, K_cycle, K_clouds,
 * K_shadows, K_rain, K_wind), and against a painted preset's hour (`painted`).
 */
function worldPatchGlsl(rig: OverheadRig, painted: number | undefined): string {
  const at = painted === undefined ? undefined : paintedLight(painted);
  return `
// The World's sky over the patch now (overheadWorld), for a layer that mirrors it (overheadSkySeen).
Sky overheadSky;

// The World over the patch at this cell: the sky at the World's hour looked at straight down (the
// frame's up is the sky's "ahead"); the key, the sun or by night the moon, its light greyed by the
// rain's overcast (weatherOvercast) and under the cloud deck's shadow here (skyCloudShadow: the
// World's deck WORLD_CLOUD_BASE metres up, drifting with K_wind as the outdoor sky's does; the
// patch ${glslFloat(rig.span)} metres tall); the sky's ambient; where the sun's image stands on the
// frame (OVERHEAD_SUN_STAGE). ${at === undefined ? "Its layers light themselves from these." : `Its layers were painted for the hour ${glslFloat(painted ?? 0)}: the key's strength and the light against that hour's (x.keyGain, x.relight; 1 there).`}
void overheadWorld(inout Patch x) {
  Sky sky = skyAt(timeOfDayM(K_time, skyDays()));
  overheadSky = sky;
#if WORLD_RAIN
  float rain = K_rain;
#else
  float rain = 0.0;
#endif
  x.storm = weatherOvercast(rain, 0.0);
#if WORLD_CLOUDS
  x.cover = max(K_clouds, x.storm);
#else
  x.cover = 0.0;
#endif
  bool moonlit = sky.sun.y < -0.04;
  vec3 body = moonlit ? sky.moon : sky.sun;
  x.key = normalize(vec3(body.x, body.z, max(body.y, 0.05)));
  x.keyCol = (moonlit ? sky.moonColor * 1.4 : sky.sunColor * 1.15) * (1.0 - 0.75 * x.storm);
  x.amb = greyed(sky.ambient, vec3(0.95, 0.98, 1.04), 0.4 * x.storm) * 0.9;
#if WORLD_SHADOWS
  if (K_shadows > 0.0 && x.cover > 0.0) {
    vec3 ground = vec3(x.p.x, 0.0, x.p.y) * ${glslFloat(rig.span)};
    x.keyCol *= 1.0 - K_shadows * skyCloudShadow(sky, ground, ${glslFloat(WORLD_CLOUD_BASE)}, 1.0, x.tm, x.cover, cloudDeckDrift(K_wind));
  }
#endif
  x.sun = ${glslFloat(OVERHEAD_SUN_STAGE)} * x.key.xy / x.key.z;
  x.sunUV = x.sun / vec2(x.aspect, 1.0) + 0.5;
${
  at === undefined
    ? `  x.keyGain = 1.0;
  x.relight = vec3(1.0);`
    : `  x.keyGain = dot(x.keyCol, LUMA) / dot(${at.key}, LUMA);
  // The eye adapts (RELIGHT_ADAPT, RELIGHT_TINT): a low sun, a passing cloud or the night dims the
  // patch by less than the light falls, and tints it less than the light is tinted; 1 at the
  // painted hour.
  vec3 relight = (x.amb + x.keyCol * (0.5 + 0.5 * x.key.z)) / ${at.light};
  float bright = max(dot(relight, LUMA), 1e-3);
  float seen = mix(bright, pow(bright, ${glslFloat(RELIGHT_ADAPT)}), smoothstep(-0.06, 0.08, sky.sun.y));
  x.relight = mix(vec3(1.0), relight / bright, ${glslFloat(RELIGHT_TINT)}) * seen;`
}
  // The pond's old sun's strength, at the World's key's against the painted hour's.
  x.power = 0.4 * x.keyGain;
}

// The World's sky seen along dir (the sky's frame: x right, y up, z ahead), as open water mirrors
// it: its dome and the cloud deck drifting over it (while there is cloud: WORLD_CLOUDS).
vec3 overheadSkySeen(Patch x, vec3 dir) {
  vec3 col = skyColor(overheadSky, dir);
#if WORLD_CLOUDS
  vec4 deck = skyClouds(overheadSky, dir, x.tm, x.cover, cloudDeckDrift(K_wind));
  col = mix(col, deck.rgb, deck.a);
#endif
  return col;
}
`;
}

/** The patch at this cell, and the plain bed. */
function patchGlsl(sunlit: boolean): string {
  return `
// The patch at this cell: the World's light where the sky lights it (overheadWorld), else the pond's
// sun until a layer's begin sets its own; the World's wind (OVERHEAD_WIND); and a dry, flat surface
// until the water's begin sets it.
Patch overheadPatch(vec2 uv, vec2 cell, float t) {
  Patch x;
  x.uv = uv;
  x.cell = cell;
  x.aspect = uRes.x / uRes.y;
  x.t = t;
  x.tm = uMotionTime;
  x.m = uMotion;
  x.p = (uv - 0.5) * vec2(x.aspect, 1.0);
${sunlit ? "  overheadWorld(x);" : FIXED_LIGHT}
  x.wind = OVERHEAD_WIND;
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
}

/** The whole overhead program's own GLSL: the prelude, the shared and the layers' GLSL, the entry. */
function overheadGlsl(a: Assembly): string {
  const { preset, layers, allocation, turns, open, sunlit } = a;
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
// The World's wind over the patch where a layer is open to the sky (K_wind: its strength either way).
#define OVERHEAD_WIND ${open ? "abs(K_wind)" : "0.0"}
${PRELUDE}
${sunlit ? worldPatchGlsl(rig, preset.painted) : ""}
${patchGlsl(sunlit)}
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
${calls("over")}  // 12. ${
    sunlit && preset.painted !== undefined
      ? `The World's light against the painted hour's, then the grade.
  c.col *= x.relight;
  c.src *= x.relight;
  c.o.ink *= dot(x.relight, LUMA);`
      : "The grade."
  }
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
      open: scene.offered.some((layer) => layer.open === true),
      sunlit:
        scene.offered.some((layer) => layer.open === true) &&
        scene.offered.some((layer) => layer.sunlit === true),
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
