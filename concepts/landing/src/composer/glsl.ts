// The composer's GLSL (README "Compositing"): the prelude every composed program starts with (the
// rig, the cell, the context its passes are given, the light, the placement, the layers' data
// accessors and their own entrances and exits, the plain floor) and the entry it generates, which
// runs the on layers' passes in the composer's order. Layers never write the entry themselves.
//
// The entry's order:
//   1. The context (`composerCtx`): the World now, the rig's ray, the light; then every shared
//      chunk's and every layer's `begin` (the backdrop's sets the air and where the floor ends).
//   2. The backdrop's `sky`; c.z starts at WORLD_FAR.
//   3. The far band: every layer's `far`, then every `farVeil`, in canonical order.
//   4. The ground layer's `ground`, or the composer's plain floor, below the backdrop's land line.
//   5. The middle band's opaque passes; the World's birds at c.z; the middle veils.
//   6. The front band's opaque passes, then its veils.
//   7. The shared speck map, against c.zs (what stands above the floor: specks hide behind it).
//   8. Every layer's `air` (the backdrop's forward scatter, a lamp's halo in the fog's air).
//   9. worldFog, then worldPrecip at c.z (thinned under shelter claims).
//  10. The grade's vignette and exposure, a speck's palette snap, and shadeOf with the grade's ink.
// A pass of a layer playing its own entrance or exit (sim.ts, row 0 of the atlas) is shown in a
// growing or shrinking share of cells, cut per cell; at rest every pass runs as written.
import { glslFloat } from "../shaders/glsl.ts";
import { worldGlsl } from "../shaders/lib/world.ts";
import { SPECK_DEPTH_STEP } from "./caps.ts";
import { claimsGlsl } from "./claims.ts";
import { gustGlsl, type PassageGustShape } from "./gust.ts";
import { ATLAS_SLOT, SPECK_SLOT, type Allocation } from "./sim.ts";
import type {
  FloorKind,
  Grade,
  LayerCode,
  LayerDef,
  LayerPasses,
  PlacedClaim,
  ScenePreset,
} from "./types.ts";

/** The entry every composed program has. */
export const COMPOSER_ENTRY = "composerEntry";

/** The plain floor's albedo, how porous it is (wetten), and how well it holds lying snow. */
const FLOORS: Readonly<
  Record<FloorKind, { albedo: readonly [number, number, number]; porous: number; snow: number }>
> = {
  earth: { albedo: [0.32, 0.25, 0.17], porous: 0.8, snow: 1 },
  lawn: { albedo: [0.2, 0.36, 0.13], porous: 0.6, snow: 1 },
  gravel: { albedo: [0.55, 0.52, 0.47], porous: 0.3, snow: 0.9 },
  sand: { albedo: [0.76, 0.66, 0.47], porous: 0.7, snow: 0.8 },
  rock: { albedo: [0.42, 0.41, 0.39], porous: 0.2, snow: 0.7 },
  moss: { albedo: [0.22, 0.32, 0.12], porous: 0.9, snow: 1 },
  ice: { albedo: [0.72, 0.8, 0.86], porous: 0, snow: 0.6 },
  snowfield: { albedo: [0.9, 0.92, 0.96], porous: 0.4, snow: 1 },
  water: { albedo: [0.1, 0.16, 0.2], porous: 0, snow: 0 },
  asphalt: { albedo: [0.16, 0.16, 0.17], porous: 0.1, snow: 0.3 },
};

const vec3 = (v: readonly [number, number, number]): string =>
  `vec3(${v.map(glslFloat).join(", ")})`;

const XYZW = "xyzw";

/** The uSimOn component that says whether sim slot `slot` is bound. */
export function simOn(slot: number): string {
  return `${slot < 4 ? "uSimOn" : "uSimOn2"}.${XYZW.charAt(slot % 4)}`;
}

/** A layer on in this program, its code loaded, and its index among them. */
export interface OnLayer {
  readonly def: LayerDef;
  readonly code: LayerCode;
}

/** What one composed program is assembled from (compose.ts glslFor). */
export interface Assembly {
  readonly preset: ScenePreset;
  /** On, placed, canonical order: index k is texel k of the atlas's row 0. */
  readonly layers: readonly OnLayer[];
  readonly claims: readonly PlacedClaim[];
  readonly allocation: Allocation;
  /** Every trigger slot by knob key (the World's, the gusts', each offered layer's). */
  readonly triggers: Readonly<Record<string, number>>;
  readonly gust: { readonly slot: number; readonly shape: PassageGustShape | undefined };
  /** Each layer's GLSL as this program takes it: its qualified keys and its M rewritten (compose.ts). */
  readonly rewrite: (layer: LayerDef, glsl: string) => string;
}

/** The light (README "Light"): the World's sky times the preset's grade. */
function lightGlsl(grade: Grade, turn: number): string {
  const tint = (expr: string, by: readonly [number, number, number] | undefined) =>
    by === undefined ? expr : `${expr} * ${vec3(by)}`;
  const floor = grade.floor === undefined ? "" : ` + ${vec3(grade.floor)}`;
  const moon = grade.moonlight;
  return `
// The light (composer/glsl.ts): the sun${moon === undefined ? "" : ", or once it has set the moon,"} as the key, in the rig's frame.
Light composerLight(World w) {
  Sky sky = w.sky;
  Light l;
  l.moonKey = ${moon === undefined ? "false" : "sky.sun.y < -0.02"};
  l.key = skyFacing(${moon === undefined ? "sky.sun" : "l.moonKey ? sky.moon : sky.sun"}, ${glslFloat(-turn)});
  l.sun = ${moon === undefined ? tint("sky.sunColor", grade.sunTint) : `l.moonKey ? sky.moonColor * ${glslFloat(moon)} : ${tint("sky.sunColor", grade.sunTint)}`};
  l.amb = ${tint("sky.ambient", grade.skyTint)}${floor};
  float keyLen = max(length(l.key.xz), 1e-3);
  l.keyGround = l.key.xz / keyLen;
  l.keyTan = max(l.key.y, 0.04) / keyLen;
  l.keyUp = smoothstep(-0.02, 0.12, l.key.y);
  return l;
}
`;
}

/** The prelude's fixed part: the structs and the cell's two writes. */
const STRUCTS = `
// The key light and the light around (composerLight): the key's direction in the rig's frame, its
// bearing on the floor and the tangent of its height, how far up it is (0 below the horizon).
struct Light { vec3 sun; vec3 amb; vec3 key; vec2 keyGround; float keyTan; float keyUp; bool moonKey; };
// The air, the backdrop's (its begin): the haze toward this bearing, the fog's and the rain's colour,
// the light the drops shine by, the bright sky wet things mirror; per metre, how much the rain hides
// (its own mist beside the World's veil) and the dust (haze) does; the share of a golden veil the far
// land takes beyond the dust.
struct Air { vec3 haze; vec3 fog; vec3 drop; vec3 deck; float rain; float dust; float veil; };
// What every pass is given. p of the rig's frame: x right, y up from the floor, z ahead (metres).
// eye: the rig's eye now, lift above its rest (the preset's passage); zg: how far this cell's ray
// meets the floor (WORLD_FAR above the horizon); groundTo: the uv height below which the site floor
// shows, landZ how far it reaches in this column (the backdrop's); stretch: how much wider the frame
// is than the rig's minAspect (layers on a stage spread with it).
struct Ctx {
  World w; WorldView v; vec2 uv; vec2 cell; float aspect; float aa; float tm; float eye; float lift;
  bool moving; float stretch; float zg; float groundTo; float landZ; GustWind gust; Light light; Air air;
};
// What a cell shows: its colour, the depth of what it shows (WORLD_FAR: open sky), the depth of the
// nearest thing standing above the floor (what hides a speck; the floor and the sky leave it), accent.
struct Cell { vec3 col; float z; float zs; float accent; };

// Opaque: where z is nearer than what the cell shows, over by rgba.a, taking z once a >= 0.5.
void cellPut(inout Cell c, vec4 rgba, float z) {
  if (z >= c.z) return;
  c.col = mix(c.col, rgba.rgb, rgba.a);
  if (rgba.a >= 0.5) {
    c.z = z;
    c.zs = min(c.zs, z);
    c.accent = 0.0;
  }
}

// Translucent: where z is nearer than what the cell shows, over by rgba.a; the depth stays.
void cellVeil(inout Cell c, vec4 rgba, float z) {
  if (z < c.z) c.col = mix(c.col, rgba.rgb, rgba.a);
}

vec3 localLight(vec3 p, vec3 n);
`;

/** The plain floor (README "The site") of the preset's kind, where no ground layer lies. */
function floorGlsl(kind: FloorKind): string {
  const floor = FLOORS[kind];
  return `
// The plain floor: ${kind}, lit by the key (the claims' and the clouds' shadows taken out) and the
// layers' lights, wet and snowed on by the World, below the backdrop's land line.
void composerFloor(Ctx x, inout Cell c) {
  if (x.uv.y >= x.groundTo || x.zg >= x.landZ) return;
  vec2 xz = vec2((x.uv.x - 0.5) * x.aspect * x.zg / RIG_FOCAL, x.zg);
  float lit = worldSunlit(x.w, x.v, vec3(xz.x, -x.eye, x.zg)) * (1.0 - casterShadow(xz, x));
  vec3 albedo = wetten(${vec3(floor.albedo)}, uWeather.x, ${glslFloat(floor.porous)});
  vec3 col = albedo * (x.light.amb * 0.55 + x.light.sun * 0.5 * lit + localLight(vec3(xz.x, 0.0, x.zg), vec3(0.0, 1.0, 0.0)));
  col += wetGloss(uWeather.x, 0.85) * x.air.deck * 0.3;
  float snow = ${glslFloat(floor.snow)} * snowCover(vec3(0.0, 1.0, 0.0), xz, uWeather.y) * (1.0 - shelterAt(xz, x));
  c.col = mix(col, vec3(0.92, 0.94, 0.98) * (x.light.amb * 1.1 + x.light.sun * 0.5 * lit), snow);
  c.z = x.zg;
  c.accent = 0.0;
}
`;
}

/** Each layer's data accessors (README "Sims in a composition"): never uSimN in a layer's own GLSL. */
function accessorsGlsl(layers: readonly OnLayer[], alloc: Allocation): string {
  return layers
    .map(({ def }) => {
      const id = def.id;
      const out: string[] = [];
      const rows = alloc.rows[id];
      if (rows !== undefined)
        out.push(
          `#define ${id}Atlas uSim${ATLAS_SLOT}`,
          `const int ${id}Row = ${rows.base};`,
          `bool ${id}SimOn() { return ${simOn(ATLAS_SLOT)} > 0.5; }`,
          `vec4 ${id}Record(int x, int y) { return texelFetch(uSim${ATLAS_SLOT}, ivec2(x, ${id}Row + y), 0); }`,
        );
      (alloc.fields[id] ?? []).forEach((slot, k) => {
        out.push(
          `#define ${id}Field${k} uSim${slot}`,
          `bool ${id}Field${k}On() { return ${simOn(slot)} > 0.5; }`,
        );
      });
      return out.length === 0 ? "" : `// ${id}'s data\n${out.join("\n")}\n`;
    })
    .join("");
}

/** The on layers' lights summed (README "Light"): every layer lights its materials with it. */
function lightsGlsl(layers: readonly OnLayer[]): string {
  const lights = layers.flatMap(({ def }) => def.lights ?? []);
  const terms = lights.map((light) =>
    light.gate === undefined
      ? `  l += ${light.glsl}(p, n);`
      : `#if ${light.gate}\n  l += ${light.glsl}(p, n);\n#endif`,
  );
  return `
// The layers' lights on a surface at p (rig frame) facing n (0 for a thin thing lit all round).
vec3 localLight(vec3 p, vec3 n) {
${terms.length === 0 ? "  return vec3(0.0);" : `  vec3 l = vec3(0.0);\n${terms.join("\n")}\n  return l;`}
}
`;
}

/**
 * The passes of `kind` of the on layers (those `only` keeps), in canonical order, each shown in its
 * share of cells while the layer plays its own entrance or exit.
 */
function passCalls(
  layers: readonly OnLayer[],
  kind: keyof LayerPasses,
  args: string,
  only: (def: LayerDef) => boolean = () => true,
): string {
  return layers
    .map(({ def }, k) => {
      const fn = def.passes[kind];
      if (fn === undefined || !only(def)) return "";
      return `  if (shown[${k}] >= 1.0) ${fn}(${args});
  else if (shown[${k}] > 0.0) { Cell was = c; ${fn}(${args}); if (edgeThreshold(cell, vec2(${13 + 7 * k}.0, 29.0)) >= shown[${k}]) c = was; }
`;
    })
    .join("");
}

/**
 * Each cell's begins, in canonical order: before a layer's own, the begin of every shared chunk it
 * holds that has not run yet (so the backdrop's runs before a later layer's chunk reads its air).
 */
function begins(layers: readonly OnLayer[]): string {
  const ran = new Set<string>();
  return layers
    .flatMap(({ def, code }) => [
      ...(code.shared ?? []).flatMap((chunk) => {
        if (ran.has(chunk.id)) return [];
        ran.add(chunk.id);
        return chunk.begin === undefined ? [] : [`  ${chunk.begin}(x);`];
      }),
      ...(def.passes.begin === undefined ? [] : [`  ${def.passes.begin}(x);`]),
    ])
    .join("\n");
}

/** The whole composed program's own GLSL: the World, the prelude, the shared and the layers' GLSL, the entry. */
export function composedGlsl(a: Assembly): string {
  const { preset, layers, allocation } = a;
  const rig = preset.rig;
  const grade = preset.grade;
  const fly = preset.flyway;
  const ground = layers.some(({ def }) => def.role === "ground" && def.passes.ground !== undefined);
  const specks = layers.filter(
    ({ def }) => allocation.specks[def.id] !== undefined && def.passes.speck !== undefined,
  );
  const stretched = new Set(
    layers.filter(({ def }) => def.space.stretch === true).map(({ def }) => def.id),
  );
  const shelter = a.claims.some((claim) => (claim.shelter ?? 0) > 0);
  const shared = new Map<string, { glsl: string; begin: string | undefined }>();
  for (const { code } of layers)
    for (const chunk of code.shared ?? [])
      if (!shared.has(chunk.id))
        shared.set(chunk.id, { glsl: chunk.glsl(rig), begin: chunk.begin });
  const triggers = Object.entries(a.triggers)
    .map(([key, slot]) => `const int TRIGGER_${key} = ${slot};`)
    .join("\n");
  const n = Math.max(1, layers.length);
  const passage =
    rig.passage?.glsl ??
    "float rigLift() {\n  return 0.0;\n}\nfloat rigCut() {\n  return 0.0;\n}\n";
  const speckDraw =
    specks.length === 0
      ? ""
      : `
  // 7. The shared speck map, against what stands above the floor.
  bool speck = false;
  {
    ivec2 ic = ivec2(cell);
    ivec2 size = textureSize(uSim${SPECK_SLOT}, 0);
    if (${simOn(SPECK_SLOT)} > 0.5 && ic.x < size.x && ic.y < size.y) {
      vec2 tex = texelFetch(uSim${SPECK_SLOT}, ic, 0).rg;
      int code = int(tex.r * 255.0 + 0.5);
      float zSpeck = tex.g * 255.0 / ${glslFloat(SPECK_DEPTH_STEP)};
      if (code > 0 && zSpeck < c.zs) {
${specks
  .map(({ def }) => {
    const k = layers.findIndex((on) => on.def === def);
    const base = allocation.specks[def.id] ?? 0;
    const count = def.data?.specks ?? 0;
    return `        if (code > ${base} && code <= ${base + count} && (shown[${k}] >= 1.0 || edgeThreshold(cell, vec2(${13 + 7 * k}.0, 29.0)) < shown[${k}])) {
          c.col = ${def.passes.speck}(code - ${base}, c.col, x);
          c.z = zSpeck;
          speck = true;
        }`;
  })
  .join("\n")}
      }
    }
  }
`;
  const vignette =
    grade.vignette === undefined
      ? ""
      : `  c.col *= 1.0 - ${glslFloat(grade.vignette)} * smoothstep(0.7, 1.4, length((uv - 0.5) * vec2(1.0, 0.9)) * 1.5);\n`;
  const exposure =
    grade.exposure === undefined
      ? ""
      : `  c.col = clamp(c.col * ${glslFloat(grade.exposure)}, 0.0, 1.0);\n`;
  const precip = shelter
    ? `  vec2 under = vec2((uv.x - 0.5) * x.aspect * min(c.z, x.landZ) / RIG_FOCAL, min(c.z, x.landZ));
  worldPrecipThinned(x.w, x.v, x.air.fog, x.air.drop, c.z, vec2(1.0 - shelterAt(under, x)), c.col, c.accent);`
    : "  worldPrecip(x.w, x.v, x.air.fog, x.air.drop, c.z, c.col, c.accent);";
  return `
${worldGlsl}
// ---- the composer (composer/glsl.ts): preset ${preset.id}, layers ${layers.map(({ def }) => def.id).join(", ")} ----
const float RIG_HORIZON = ${glslFloat(rig.horizon)};
const float RIG_FOCAL = ${glslFloat(rig.focal)};
const float RIG_EYE = ${glslFloat(rig.eye)};
const float RIG_TURN = ${glslFloat(rig.turn)};
// Half the width of the narrowest frame laid out as itself (minAspect): wider frames stretch.
const float RIG_STAGE = ${glslFloat(0.5 * rig.minAspect)};
const vec4 WORLD_METEOR_FIELD = vec4(${preset.meteors.map(glslFloat).join(", ")});
${triggers}
${passage}${gustGlsl(a.gust.slot, a.gust.shape)}${STRUCTS}${lightGlsl(grade, rig.turn)}${claimsGlsl(
    a.claims,
    stretched,
    layers.flatMap(({ def }) => def.casters ?? []),
  )}
// The layers' own entrances and exits (sim.ts, the atlas's row 0, texel k for the k-th layer on):
// -1 while the layer follows the scene's passage.
vec2 layerTurn(int k) {
  return ${simOn(ATLAS_SLOT)} > 0.5 ? texelFetch(uSim${ATLAS_SLOT}, ivec2(k, 0), 0).xy : vec2(-1.0);
}
float layerIn(int k) {
  float own = layerTurn(k).x;
  return own < 0.0 ? passageIn() : own;
}
float layerOut(int k) {
  float own = layerTurn(k).y;
  return own < 0.0 ? passageOut() : own;
}
// The share of cells showing layer k: 1 at rest and through the scene's passage.
float layerShown(int k) {
  vec2 own = layerTurn(k);
  return own.x < 0.0 ? 1.0 : own.x * (1.0 - max(own.y, 0.0));
}
${accessorsGlsl(layers, allocation)}
Ctx composerCtx(vec2 uv, vec2 cell) {
  Ctx x;
  x.uv = uv;
  x.cell = cell;
  x.aspect = uRes.x / uRes.y;
  x.aa = 1.0 / uRes.y;
  x.tm = uMotionTime;
  x.lift = rigLift();
  x.eye = RIG_EYE + x.lift;
  x.moving = rigCut() > edgeThreshold(cell, vec2(41.0, 17.0));
  x.stretch = max(0.5 * x.aspect, RIG_STAGE) / RIG_STAGE;
  x.w = worldAt(TRIGGER_meteors, TRIGGER_lightning);
  x.w.seed = K_seed * 0.37;
  x.v = worldView(uv, RIG_HORIZON, RIG_FOCAL, x.eye, RIG_TURN, 1.0);
  x.zg = uv.y < RIG_HORIZON ? x.eye * RIG_FOCAL / (RIG_HORIZON - uv.y) : WORLD_FAR;
  x.gust = gustWind();
  x.light = composerLight(x.w);
  x.air = Air(vec3(0.0), vec3(0.0), vec3(0.0), vec3(0.0), 0.0, 0.0, 0.0);
  x.groundTo = RIG_HORIZON;
  x.landZ = WORLD_FAR;
  return x;
}
${floorGlsl(preset.floor)}
${[...shared.values()].map((chunk) => chunk.glsl).join("\n")}
${layers.map(({ def, code }) => a.rewrite(def, code.glsl(rig))).join("\n")}
${lightsGlsl(layers)}
Shade ${COMPOSER_ENTRY}(vec2 uv, vec2 cell, float t) {
  // 1. The context, then each shared part's and each layer's own state for this cell.
  Ctx x = composerCtx(uv, cell);
${begins(layers)}
  float shown[${n}];
${layers.map((_, k) => `  shown[${k}] = layerShown(${k});`).join("\n")}
  Cell c = Cell(vec3(0.0), WORLD_FAR, WORLD_FAR, 0.0);
  // 2. The sky.
${passCalls(layers, "sky", "x, c", (def) => def.role === "backdrop")}
  // 3. The far band.
${passCalls(layers, "far", "x, c")}${passCalls(layers, "farVeil", "x, c")}
  // 4. The floor: the ground layer's, else the plain one.
${ground ? `  if (shown[${layers.findIndex(({ def }) => def.role === "ground")}] < 1.0) composerFloor(x, c);\n${passCalls(layers, "ground", "x, c", (def) => def.role === "ground")}` : "  composerFloor(x, c);"}
  // 5. The middle band, the World's birds among it, its veils.
${passCalls(layers, "middle", "x, c")}  float zBird = c.z;
  worldBirds(x.w, x.v, WorldFlyway(vec2(${glslFloat(fly.depth[0])}, ${glslFloat(fly.depth[1])}), vec2(RIG_HORIZON + ${glslFloat(fly.above)}, ${glslFloat(fly.top)}), vec2(K_seed * 0.37, ${glslFloat(fly.seed)}), ${glslFloat(fly.skim)}, ${glslFloat(fly.spread)}), x.air.haze, ${glslFloat(fly.ext)} + x.air.rain, c.col, zBird, c.accent);
  if (zBird < c.z) {
    c.z = zBird;
    c.zs = zBird;
  }
${passCalls(layers, "middleVeil", "x, c")}
  // 6. The front band.
${passCalls(layers, "front", "x, c")}${passCalls(layers, "frontVeil", "x, c")}${speckDraw}
  // 8. The air's own light.
${passCalls(layers, "air", "x, c")}
  // 9. The World's fog, then its rain and snow, at the depth of what the cell shows.
  worldFog(x.w, x.v, x.air.fog, c.z, c.col, c.accent);
${precip}
  // 10. The grade.
${vignette}${exposure}${specks.length === 0 ? "" : "  if (speck) c.col = snapLevel(c.col);\n"}  return shadeOf(c.col, inkOf(c.col, ${glslFloat(grade.ink.gain)}, ${glslFloat(grade.ink.gamma)}), clamp(c.accent, 0.0, 1.0));
}
`;
}
