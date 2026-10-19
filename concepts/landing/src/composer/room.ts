// The `interior` composer's program (ADR 0062 Phase 3, README "The interior composer"): a room seen
// by a level eye over a ledge across the front of the view, the back wall behind it, and the layers
// over them in the room's order. The room is laid out on the frame, as the scenes it came from were
// painted: across as a share of the frame's width, up in screen heights; things on the ledge stand
// on its seat line at the rig's scale there (`roomFrame`), so a layer drawn from the rig (the lava
// lamp) stands on any room's ledge at its size in metres.
//
// The entry's order:
//   1. The context (`roomCtx`): the cell, its frame point p (screen heights from the centre, x
//      across), the scene clock; the shell's state (`roomShellBegin`: the World in the room, its
//      back window on the frame); then every shared chunk's and every layer's `begin`.
//   2. The back wall: the shell's wall in its material, then a back window's frame (composer/
//      shell.ts), all drawn from the rig in metres.
//   3. The backdrop's `far` pass: what the back wall holds (the view through the window, a papered
//      wall). A backdrop that looks out (`LayerDef.window`) draws inside the shell's window
//      (`roomWin`): the World's sky and weather cross its glass, drawn through the view's own rig.
//      Then every `farVeil` pass: what lies on the window's glass (the frost), where `roomGlass`
//      says the backdrop's glass is (its `glass` pass).
//   4. The shell's ledge (Room.ledge: a sill, a sideboard, a stand, a low table), then the ground
//      layer's `ground` where a room draws its own.
//   5. The elements' bodies in frame (a candle's flame, a neon tube), then every `middle` pass, then
//      every `front` pass, then every `frontVeil`, in canonical order: what stands on the ledge and
//      in front of it. Painter's order is the canonical order; the room keeps no depth (a stated
//      limit).
//   6. The grade: the room's vignette (its corners fall into the dark), the exposure, the soft
//      roll-off of lights past 1, shadeOf with the grade's ink, the cell's shimmer.
// The room's light at a surface (`roomLightAt`, and `roomLight` at a frame point on the seat's
// plane) is its ambient and `localLight`: every on layer's declared lights and the room's elements
// (composer/elements.ts: its lamps, candles, neon and fires, and the World through its windows, the
// sun's and the moon's patches and the sky's light), at the surface's point in metres in the room's
// frame; with the backdrop's own daylight where it has one (its `daylight` pass).
// A layer that stands in the room may declare `casters` (LayerDef.casters): each its silhouette at a
// frame point on the plane it stands in, how much of a light it stops there, 0 .. 1. `roomCaster(p)`
// takes the most of every on layer's, so the shell throws the shadows of whatever stands in the room
// toward the World's key through a window and toward the one element that throws them (at most two
// shadowing lights), on the wall and the ledge's top.
// A layer whose shapes hang in the room's space may declare `rayCasters` (LayerDef.rayCasters): each
// how much of a round light they hide from a point, in the metres the layer is drawn in.
// `roomRayCaster(P, L, r)` takes the most of every on layer's (declared only while one is on), so a
// light (the mobile's Sun) throws them on the room's surfaces along the ray from each point to it.
// A program draws its layers' own entrances and exits as the outdoor composer's do (glsl.ts
// `turnsGlsl`, `passCalls`).
import { glslFloat } from "../shaders/glsl.ts";
import { worldGlsl } from "../shaders/lib/world.ts";
import {
  accessorsGlsl,
  begins,
  COMPOSER_ENTRY,
  passCalls,
  simOn,
  turnsGlsl,
  type Assembly,
} from "./glsl.ts";
import type { PlacedLayer } from "./place.ts";
import { shellGlsl } from "./shell.ts";
import { ATLAS_SLOT } from "./sim.ts";
import type { Room, RoomFrame, ScenePreset } from "./types.ts";

export class RoomError extends Error {}

/** What one room program is assembled from: an outdoor program's, and where each layer stands. */
export interface RoomAssembly extends Assembly {
  readonly placed: readonly PlacedLayer[];
}

/** An interior preset's room; throws for a preset without one. */
export function roomOf(preset: ScenePreset): Room {
  if (preset.room === undefined) throw new RoomError(`preset ${preset.id} has no room`);
  return preset.room;
}

/**
 * Where the room's seat line stands on the frame (screen heights up from its centre) and its scale
 * (screen heights a metre), from the preset's rig: the seat is the ledge's top `distance` metres
 * ahead of a level eye `eye` metres over it.
 */
export function roomFrame(preset: ScenePreset): RoomFrame {
  const scale = preset.rig.focal / roomOf(preset).distance;
  return { seat: preset.rig.horizon - 0.5 - preset.rig.eye * scale, scale };
}

/**
 * The on layers' silhouettes for a backdrop's shadows (LayerDef.casters), the most of them; and,
 * where a layer hangs shapes in the room (LayerDef.rayCasters), the most of those along a ray.
 */
function castersGlsl(layers: RoomAssembly["layers"]): string {
  const casters = layers.flatMap(({ def }) => def.casters ?? []).map((fn) => `${fn}(p)`);
  const rays = layers.flatMap(({ def }) => def.rayCasters ?? []).map((fn) => `${fn}(P, L, r)`);
  return `
// How much of a light the room's layers stop at frame point p, on the plane they stand in.
float roomCaster(vec2 p) {
  return ${casters.length === 0 ? "0.0" : casters.reduce((a, b) => `max(${a}, ${b})`)};
}
${
  rays.length === 0
    ? ""
    : `
// How much of a round light (centre L, radius r) the shapes hanging in the room hide from point P.
float roomRayCaster(vec3 P, vec3 L, float r) {
  return ${rays.reduce((a, b) => `max(${a}, ${b})`)};
}
`
}`;
}

/** The whole room program's own GLSL: the World (while it lists it), the prelude, the shell, the layers, the entry. */
export function roomGlsl(a: RoomAssembly): string {
  const { preset, layers, allocation, turns } = a;
  const rig = preset.rig;
  const room = roomOf(preset);
  const frame = roomFrame(preset);
  const grade = preset.grade;
  const shared = new Map<string, string>();
  for (const { code } of layers)
    for (const chunk of code.shared ?? [])
      if (!shared.has(chunk.id)) shared.set(chunk.id, chunk.glsl(rig));
  const triggers = Object.entries(a.triggers)
    .map(([key, slot]) => `const int TRIGGER_${key} = ${slot};`)
    .join("\n");
  const anchors = a.placed
    .map(
      ({ layer, anchor }) =>
        `const vec2 ${layer.id}Anchor = vec2(${glslFloat(anchor.at[0])}, ${glslFloat(anchor.at[1])});`,
    )
    .join("\n");
  const backdrop = layers.find(({ def }) => def.role === "backdrop")?.def;
  const view = layers.some(({ def }) => def.window === true);
  // A room lists the World while it offers a window or holds a window element (compose.ts); the
  // World's code is the program's whenever it does: with no glass in frame only worldAt runs (the
  // light-only World), the sky's stars, deck and meteors compiled out with their knobs.
  const world = a.triggers["lightning"] !== undefined;
  const daylight =
    backdrop?.passes.daylight === undefined ? "" : ` + ${backdrop.passes.daylight}(x, p)`;
  const glass = backdrop?.passes.glass === undefined ? "vec4(-1.0)" : `${backdrop.passes.glass}(x)`;
  const n = Math.max(1, layers.length);
  const reach = grade.vignetteReach ?? { from: 0.45, to: 1, across: 1.2 };
  const vignette =
    grade.vignette === undefined
      ? ""
      : `  c.col *= 1.0 - ${glslFloat(grade.vignette)} * smoothstep(${glslFloat(reach.from)}, ${glslFloat(reach.to)}, length((uv - 0.5) * vec2(${glslFloat(reach.across)}, 1.0)));\n`;
  const exposure =
    grade.exposure === undefined
      ? ""
      : `  c.col = clamp(c.col * ${glslFloat(grade.exposure)}, 0.0, 1.0);\n`;
  const rolloff =
    grade.rolloff === undefined
      ? ""
      : `  c.col = 1.0 - exp(-c.col * ${glslFloat(grade.rolloff)});\n`;
  const paper =
    grade.ink.paper === undefined
      ? ""
      : `, vec2(${glslFloat(grade.ink.paper[0])}, ${glslFloat(grade.ink.paper[1])})`;
  const lights = layers
    .flatMap(({ def }) => def.lights ?? [])
    .map((light) =>
      light.gate === undefined
        ? `  l += ${light.glsl}(p, n);`
        : `#if ${light.gate}\n  l += ${light.glsl}(p, n);\n#endif`,
    );
  return `
${world ? worldGlsl : ""}
// ---- the room (composer/room.ts): preset ${preset.id}, layers ${layers.map(({ def }) => def.id).join(", ")} ----
const float RIG_HORIZON = ${glslFloat(rig.horizon)};
const float RIG_FOCAL = ${glslFloat(rig.focal)};
const float RIG_EYE = ${glslFloat(rig.eye)};
// The seat line things on the ledge stand on (screen heights up from the frame's centre), the
// ledge's screen heights a metre there, and how far the eye stands from it (m).
const float ROOM_SEAT = ${glslFloat(frame.seat)};
const float ROOM_SCALE = ${glslFloat(frame.scale)};
const float ROOM_DISTANCE = ${glslFloat(room.distance)};
${triggers}
// What every pass is given: the cell, its frame point p (screen heights from the centre, x across),
// the frame's aspect, a cell's height, the scene clock. Off the rest pose (ROOM_POSE, the shell's
// roomPose) p, uv and px are the cell pulled back to the seat's plane as the rest rig sees it, what
// a layer painted on the frame reads, and q the cell's own frame point, which a layer drawing its
// own camera reads (the mobile's); at rest q is p.
struct Ctx { vec2 uv; vec2 cell; vec2 p; vec2 q; float aspect; float px; float tm; };
// What a cell shows: its colour, its accent, its shimmer.
struct Cell { vec3 col; float accent; float shimmer; };

// A frame point p on the seat's plane, in metres in the room's frame: x across from the centre line,
// y up from the ledge's top, z ahead of the eye (ROOM_DISTANCE).
vec3 roomAt(vec2 p) {
  return vec3(p.x / ROOM_SCALE, (p.y - ROOM_SEAT) / ROOM_SCALE, ROOM_DISTANCE);
}

vec3 localLight(vec3 p, vec3 n);
vec3 roomLight(Ctx x, vec2 p, vec3 n);
vec3 roomLightAt(vec3 P, vec3 n);
float roomCaster(vec2 p);
${layers.some(({ def }) => (def.rayCasters?.length ?? 0) > 0) ? "float roomRayCaster(vec3 P, vec3 L, float r);\n" : ""}vec4 roomGlass(Ctx x);
${shellGlsl(room, world, a.triggers["meteors"] !== undefined)}
${turnsGlsl(turns)}
${accessorsGlsl(layers, allocation)}
// Where each layer on stands (its anchor: x a share of the frame's width from its centre).
${anchors}

Ctx roomCtx(vec2 uv, vec2 cell) {
  Ctx x;
  x.uv = uv;
  x.cell = cell;
  x.aspect = uRes.x / uRes.y;
  x.px = 1.0 / uRes.y;
  x.tm = uMotionTime;
  x.p = (uv - 0.5) * vec2(x.aspect, 1.0);
  x.q = x.p;
#if ROOM_POSE
  roomPose(x);
#endif
  return x;
}
${[...shared.values()].join("\n")}
${layers.map(({ def, code }) => a.rewrite(def, code.glsl(rig))).join("\n")}
${castersGlsl(layers)}
// The light on a surface at P (the room's frame) facing n (0 for a thing lit all round): the layers'
// lights and the room's elements (its lamps, candles, neon and fires; the World through its windows).
vec3 localLight(vec3 p, vec3 n) {
  vec3 l = roomElementsLight(p, n);
${lights.join("\n")}
  return l;
}

// The room's light at P: its light all round and localLight's; at frame point p on the seat's plane,
// with the backdrop's own daylight where it lets one in.
vec3 roomLightAt(vec3 P, vec3 n) {
  return ROOM_AMBIENT + localLight(P, n);
}
vec3 roomLight(Ctx x, vec2 p, vec3 n) {
  return roomLightAt(roomAt(p), n)${daylight};
}

// Where the backdrop's window glass is (its glass pass): how far inside it from its bottom, top, left
// and right edges, negative off it.
vec4 roomGlass(Ctx x) {
  return ${glass};
}

Shade ${COMPOSER_ENTRY}(vec2 uv, vec2 cell, float t) {
  // 1. The context, the shell's state (the World in the room, its window), then each shared part's
  // and each layer's own state for this cell.
  Ctx x = roomCtx(uv, cell);
  roomShellBegin(x);
${begins(layers)}
${
  turns
    ? `  // Which cells show each layer: every one at rest, its share while it enters or leaves.
  bool shows[${n}];
${layers.map((_, k) => `  shows[${k}] = layerShows(${k}, cell);`).join("\n")}\n`
    : `  // Row 0's first texel, spent at the grade (glsl.ts composedGlsl).
  float heldTurn = ${simOn(ATLAS_SLOT)} > 0.5 ? texelFetch(uSim${ATLAS_SLOT}, ivec2(0, 0), 0).x : -1.0;\n`
}  // 2. The back wall, then its window's frame (the World's light in it with no view on).
  Cell c = Cell(vec3(0.0), 0.0, 0.0);
  roomShellWall(x, c);
  roomShellWindow(x, c, ${view ? "true" : "false"});
  // 3. What the back wall holds.
${passCalls(layers, turns, "far", "x, c", (def) => def.role === "backdrop")}${passCalls(layers, turns, "farVeil", "x, c")}
  // 4. The ledge: the shell's, then a ground layer's own.
  roomShellLedge(x, c);
${passCalls(layers, turns, "ground", "x, c", (def) => def.role === "ground")}
  // 5. The elements' bodies, then what stands on the ledge and in front of it.
  roomShellBodies(x, c);
${passCalls(layers, turns, "middle", "x, c")}${passCalls(layers, turns, "front", "x, c")}${passCalls(layers, turns, "frontVeil", "x, c")}
  // 6. The grade.
${turns ? "" : "  if (heldTurn < -1.5) c.col = vec3(0.0);\n"}${vignette}${exposure}${rolloff}  Shade o = shadeOf(c.col, inkOf(c.col, ${glslFloat(grade.ink.gain)}, ${glslFloat(grade.ink.gamma)}${paper}), clamp(c.accent, 0.0, 1.0));
  o.shimmer = c.shimmer;
  return o;
}
`;
}
