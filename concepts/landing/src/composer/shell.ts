// The interior's shell (ADR 0062 "The interior baseline", README "The interior composer"): the
// room's back wall, its windows and its ledge, drawn from the rig in metres and shared by every room,
// and the light the room's elements and the World through its windows throw on them and on every
// layer that asks (`localLight`, `roomLight`).
//
// The room's frame: x across from the centre line, y up from the ledge's top (the rig's floor, the
// eye RIG_EYE over it), z ahead of the eye. The back wall stands ROOM_BACK ahead; a ledge's top runs
// from its front edge LEDGE_FRONT back to the wall. A frame point p (screen heights from the frame's
// centre) sees the wall at `roomWallAt(p)` and the ledge's top at `roomTopAt(p)`; `roomFrameOf(P)`
// takes a point back to the frame. Frame points are the rest rig's.
//
// The live camera (composer/camera.ts, compiled in while ROOM_POSE: the pose in uCamera) moves the
// eye to `roomEye`, turns and zooms the cell's ray `roomRd`; `roomPose` gives the painted layers the
// cell pulled back to the seat's plane as the rest rig sees it (x.p; the cell's own point is x.q),
// and the shell meets each plane it draws along the ray: the wall at `roomWallP` (the cell on the
// back wall, as the rest rig sees it), a body on its own plane (`roomPlaneP`), the ledge's top and
// the floor along roomRd. A view through a window (the city's) reads `roomViewP`, the cell's
// direction as the rest rig sees it, and what lies on its glass `roomWallP` and `roomWallUv`.
//
//   wall     the back wall's material (Room.material: plaster, the papered rings, shoji, a dark
//            alcove, panelling) lit by `roomLightAt`: the ambient, the elements (lamps' pools, the
//            sun's and the moon's patches through a window, the sky's light through it), the layers'
//            lights, and `roomCaster`'s shadows toward the World's key and the shadowing element.
//   window   a window element on the back wall, in frame: its casing, reveal and own sill, a raised
//            sash's rail, its stiles and glazing bars (`roomWin`, which the view backdrop draws
//            inside: its `far` pass where `roomWin.inOpen` or `roomWin.inGlass`), and with no view on
//            the World's sky in it. Windows on the other walls only light.
//   ledge    Room.ledge: a window's sill (its nosing, the wall and an old radiator under it), a
//            sideboard (its doors), a stand or a low table (its apron, legs and the floor), its top
//            lit as the wall is.
//   bodies   each lamp, candle, neon tube or fire in frame draws a small body of its kind.
//
// Every element is a light (composer/elements.ts): its kind compiled in (ROOM_KIND_<k>), its place,
// colour, power, reach and flicker in uElements. A window lets the World in from the way the room
// faces (Room.facing): the sun's and the moon's light through its opening onto what lies in their
// path, its edges softened by distance and its bars drawn in, dappled by rain on the glass; the sky's
// light through it, greyed by the overcast (the World's own), brighter over snow, with the
// lightning's flash and the aurora's glow in it. Flicker runs on uMotionTime, so it holds still at
// motion 0 and under reduced motion.
import { glslFloat } from "../shaders/glsl.ts";
import { ELEMENT_ROWS, LIGHT_CAP } from "./elements.ts";
import type { LedgeKind, Room, WallMaterial } from "./types.ts";

const MATERIALS: readonly WallMaterial[] = ["plaster", "papered", "shoji", "alcove", "panel"];
const LEDGES: readonly LedgeKind[] = ["sill", "sideboard", "stand", "table"];

const vec3 = (v: readonly [number, number, number]): string =>
  `vec3(${v.map(glslFloat).join(", ")})`;

/** Each slot's light, compiled for its kind (ROOM_KIND_<k>) while the program holds that many. */
function slotTerms(call: (k: number) => string): string {
  return Array.from(
    { length: LIGHT_CAP },
    (_, k) => `#if ROOM_ELEMENTS > ${k}\n${call(k)}\n#endif`,
  ).join("\n");
}

/**
 * Each kind's small body (ROOM_KIND_<k> 1..4: a lamp, a candle, a neon tube, a fire) over `c.col`,
 * sized to read through the dither (README "Art direction": nothing thinner than about two cells),
 * shared by a room's shell and the outdoor composer (glsl.ts). It reads `kind`, `q` (metres from the
 * element across and up, at its depth), `aa` (a cell's width there), the element's rows `a` and
 * `e`, `glow` and `light`; `ambient` and `tm` name the light all round and the motion clock. With
 * `cover` it also sets `cover`, how much of the cell the body takes (for its depth outdoors).
 */
export function elementBodyKinds(ambient: string, tm: string, cover: boolean): string {
  const covers = (expr: string): string => (cover ? `\n    cover = ${expr};` : "");
  return `  if (kind == 2) {
    // A candle: a pillar of wax on what it stands on, glowing through near its top, its flame
    // swaying on its wick and a halo round it.
    float R = 0.026;
    float H = 0.085;
    float wax = smoothfall(R + aa, R - aa, abs(q.x)) * smoothstep(-aa, aa, q.y) * smoothfall(H + aa, H - aa, q.y);
    float bulge = sqrt(max(1.0 - q.x * q.x / (R * R), 0.0));
    vec3 waxCol = vec3(0.9, 0.84, 0.7) * (${ambient} * 3.0 + light * (0.9 + 1.6 * smoothstep(0.4 * H, H, q.y))) * (0.65 + 0.35 * bulge);
    c.col = mix(c.col, waxCol, wax);
    vec2 at = vec2(0.003 * sin(${tm} * 7.0 + e.y) * e.x, H + 0.024);
    vec2 f = (q - at) / vec2(0.0095, 0.024);
    float d = length(vec2(f.x / max(1.0 - 0.35 * f.y, 0.3), f.y));
    float flame = smoothfall(1.0, 1.0 - 2.0 * aa / 0.0095, d);
    c.col = mix(c.col, mix(light * 2.2 + vec3(0.3, 0.1, 0.0), vec3(1.0, 0.95, 0.8) * 1.7, smoothfall(0.75, 0.2, d)), flame);
    c.col += light * 0.7 * exp(-length(q - at) / 0.02) * (1.0 - flame);
    c.accent *= 1.0 - max(wax, flame);${covers("max(wax, flame)")}
  } else if (kind == 1) {
    // A lamp: its shade glowing, brightest at its open foot, and its stem and round foot down to
    // the ledge or the floor it stands on.
    float t = clamp(0.5 - q.y / 0.1, 0.0, 1.0);
    float hw = mix(0.05, 0.08, t);
    float shade = smoothfall(hw + aa, hw - aa, abs(q.x)) * smoothfall(0.05 + aa, 0.05 - aa, abs(q.y));
    vec3 shadeCol = light * (0.55 + 0.6 * t * t) + light * 0.8 * smoothfall(-0.04, -0.05, q.y);
    float foot = -a.y;
    float stem = step(0.06, a.y) * smoothfall(0.006 + aa, 0.006 - aa, abs(q.x)) * step(foot, q.y) * step(q.y, -0.05);
    float base = step(0.06, a.y) * smoothfall(0.045 + aa, 0.045 - aa, abs(q.x)) * smoothstep(foot - aa, foot + aa, q.y) * smoothfall(foot + 0.018 + aa, foot + 0.018 - aa, q.y);
    float metal = max(stem, base);
    c.col = mix(c.col, vec3(0.42, 0.33, 0.2) * (${ambient} * 2.0 + light * (0.25 + 0.5 * smoothstep(foot + 0.01, foot + 0.018, q.y))), metal);
    c.col = mix(c.col, shadeCol, shade);
    c.accent *= 1.0 - max(shade, metal);${covers("max(shade, metal)")}
  } else if (kind == 3) {
    // A neon tube: a short bar of light, its glow round it.
    float d = length(vec2(max(abs(q.x) - 0.12, 0.0), q.y));
    float tube = smoothfall(0.007 + aa, 0.007 - aa, d);
    c.col = mix(c.col, mix(light, vec3(1.0), 0.4) * 1.2, tube) + light * 0.25 * exp(-d * 30.0);
    c.accent = max(c.accent * (1.0 - tube), tube * 0.6);${covers("tube")}
  } else if (kind == 4) {
    // A fire: a cluster of tongues over an iron bowl, red at their edges and white at their heart,
    // the middle one tallest, each wavering on the motion clock; the bowl's rim catching it.
    vec2 r = vec2(q.x / 0.065, (q.y + 0.004) / 0.032);
    float bowl = smoothfall(1.0 + aa / 0.032, 1.0 - aa / 0.032, length(vec2(r.x, min(r.y, 0.0)))) * smoothfall(aa / 0.032, 0.0, r.y);
    c.col = mix(c.col, vec3(0.1, 0.08, 0.07) * (${ambient} * 2.0 + light * (0.2 + 0.9 * smoothstep(-0.5, 0.0, r.y))), bowl);
    float heat = 0.0;
    for (int i = 0; i < 5; i++) {
      float fi = float(i) - 2.0;
      float h = 0.075 - 0.016 * abs(fi) + 0.012 * sin(${tm} * (6.3 + fi) + fi * 2.0 + e.y) * e.x;
      vec2 f = (q - vec2(fi * 0.017 + 0.004 * sin(${tm} * (5.0 + fi) + e.y) * e.x, -0.004)) / vec2(0.022, h);
      float d = length(vec2(f.x / max(1.0 - f.y, 0.12), (f.y - 0.4) * 1.6));
      heat = max(heat, clamp((1.0 - d) / 0.6, 0.0, 1.0) * step(0.0, f.y) * (1.0 - 0.55 * f.y));
    }
    float tongue = smoothstep(0.0, 0.08, heat);
    vec3 flameCol = mix(mix(vec3(0.85, 0.2, 0.04), vec3(1.0, 0.55, 0.12), smoothstep(0.1, 0.4, heat)), vec3(1.0, 0.92, 0.7), smoothstep(0.55, 0.9, heat));
    c.col = mix(c.col, flameCol * (0.6 + 0.8 * glow / max(a.w, 1e-3)), tongue);
    c.col += light * 0.5 * exp(-length(q - vec2(0.0, 0.03)) / 0.04) * (1.0 - tongue);
    c.accent *= 1.0 - max(bowl, tongue);${covers("max(bowl, tongue)")}
  }`;
}

/**
 * The shell's GLSL for `room`: its constants, the World in the room (`world`: the room lists it),
 * the elements' light, the wall, window and ledge passes and the bodies.
 */
export function shellGlsl(room: Room, world: boolean, meteors: boolean): string {
  const ledge = room.ledge;
  return `
// ---- the shell (composer/shell.ts) ----
#ifndef ROOM_ELEMENTS
#define ROOM_ELEMENTS 0
#endif
uniform vec4 uElements[${LIGHT_CAP * ELEMENT_ROWS}];
const float ROOM_H0 = RIG_HORIZON - 0.5;
const float ROOM_BACK = ${glslFloat(room.back)};
const float ROOM_FACING = ${glslFloat(room.facing)};
const vec3 ROOM_WALL = ${vec3(room.wall)};
const vec3 ROOM_AMBIENT = ${vec3(room.ambient)};
#define ROOM_MATERIAL ${MATERIALS.indexOf(room.material)}
#define ROOM_LEDGE ${ledge === undefined ? 0 : LEDGES.indexOf(ledge.kind) + 1}
const float LEDGE_FRONT = ${glslFloat(ledge?.front ?? room.back)};
const float LEDGE_HALF = ${glslFloat(ledge?.half ?? 0)};
const float LEDGE_THICK = ${glslFloat(ledge?.thick ?? 0)};
const vec3 LEDGE_ALBEDO = ${vec3(ledge?.albedo ?? [0, 0, 0])};
#define ROOM_WORLD ${world ? 1 : 0}
#ifndef ROOM_POSE
#define ROOM_POSE 0
#endif

// Where frame point p sees the back wall, and the plane of the ledge's top (y 0); a point back on
// the frame.
vec3 roomWallAt(vec2 p) {
  float k = ROOM_BACK / RIG_FOCAL;
  return vec3(p.x * k, RIG_EYE + (p.y - ROOM_H0) * k, ROOM_BACK);
}
vec3 roomTopAt(vec2 p) {
  float z = RIG_FOCAL * RIG_EYE / max(ROOM_H0 - p.y, 1e-4);
  return vec3(p.x * z / RIG_FOCAL, 0.0, z);
}
vec2 roomFrameOf(vec3 P) {
  return vec2(P.x, P.y - RIG_EYE) * (RIG_FOCAL / max(P.z, 1e-3)) + vec2(0.0, ROOM_H0);
}

// The cell on the back wall and its direction, as the rest rig sees them (x.p at rest), and the
// first as uv.
vec2 roomWallP;
vec2 roomViewP;
vec2 roomWallUv;
#if ROOM_POSE
// The live camera (composer/camera.ts): (x, y, z, focal's factor), (yaw left, pitch down, 0, 0).
uniform vec4 uCamera[2];
// The eye (m, the room's frame), the cell's ray (its z the focal along the eye's axis), the zoom.
vec3 roomEye;
vec3 roomRd;
float roomZoom;

// The cell on the plane z = d facing the eye, as the rest rig sees it there.
vec2 roomPlaneP(float d) {
  return roomFrameOf(roomEye + roomRd * ((d - roomEye.z) / max(roomRd.z, 1e-4)));
}

// The camera for this cell: the eye moved, the ray through the cell's own point (x.q) turned and
// zoomed; what the painted layers see (x.p, x.uv, x.px) the cell pulled back to the seat's plane.
void roomPose(inout Ctx x) {
  vec4 a = uCamera[0];
  vec4 b = uCamera[1];
  roomEye = vec3(a.x, RIG_EYE + a.y, a.z);
  roomZoom = a.w;
  float cy = cos(b.x);
  float sy = sin(b.x);
  float cp = cos(b.y);
  float sp = sin(b.y);
  roomRd = vec3(cy, 0.0, sy) * x.q.x + vec3(-sp * sy, cp, sp * cy) * (x.q.y - ROOM_H0) + vec3(-cp * sy, -sp, cp * cy) * (RIG_FOCAL * a.w);
  x.p = roomPlaneP(ROOM_DISTANCE);
  x.uv = x.p / vec2(x.aspect, 1.0) + 0.5;
  x.px *= (ROOM_DISTANCE - roomEye.z) / (ROOM_DISTANCE * a.w);
}
#endif

// The World in the room, once a cell (roomShellBegin): the sky now, the sun and the moon turned
// into the room's frame by its facing.
#if ROOM_WORLD
World roomWorld;
#endif
vec3 roomSun;
vec3 roomMoon;
vec3 roomSkyLight;
vec3 roomSunLight;
vec3 roomMoonLight;
float roomRain;
float roomTm;

// How much of a light the room's layers stop on the way from P toward L (roomCaster where the ray
// crosses the plane they stand in): 1 lit, 0 shadowed.
float roomShade(vec3 P, vec3 L) {
  if (abs(L.z) < 1e-3) return 1.0;
  float t = (ROOM_DISTANCE - P.z) / L.z;
  if (t <= 0.0) return 1.0;
  return 1.0 - roomCaster(roomFrameOf(P + L * t));
}

// An element's flicker: 1 at rest, a candle's or a fire's breath on the motion clock.
float roomFlicker(float amount, float seed) {
  float t = roomTm + seed;
  return 1.0 + amount * (0.3 * sin(t * 9.1) + 0.2 * sin(t * 17.3 + 1.7) + 0.12 * sin(t * 31.7 + 0.4));
}

// A point light's share on a surface at P facing n (0: lit all round): its fall over its reach, the
// surface's turn toward it, the shadow where it throws them.
vec3 roomPointLight(int k, vec3 P, vec3 n) {
  vec4 a = uElements[k * ${ELEMENT_ROWS}];
  vec4 b = uElements[k * ${ELEMENT_ROWS} + 1];
  vec4 c = uElements[k * ${ELEMENT_ROWS} + 2];
  vec3 d = a.xyz - P;
  float r2 = max(dot(d, d), 1e-4);
  vec3 L = d * inversesqrt(r2);
  float face = dot(n, n) < 0.5 ? 1.0 : 0.25 + 0.75 * max(dot(n, L), 0.0);
  float shade = uElements[k * ${ELEMENT_ROWS} + 3].w > 0.5 ? roomShade(P, L) : 1.0;
  return b.rgb * a.w * roomFlicker(c.x, c.y) * face * shade / (1.0 + r2 / max(b.w * b.w, 1e-4));
}

// A window's axes on its wall (its kind's code: 8 back, 9 left, 10 right, 11 front): outward, across.
vec3 roomWindowOut(int wall) {
  return wall == 8 ? vec3(0.0, 0.0, 1.0) : wall == 9 ? vec3(-1.0, 0.0, 0.0) : wall == 10 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, -1.0);
}
vec3 roomWindowAcross(int wall) {
  return wall == 8 ? vec3(1.0, 0.0, 0.0) : wall == 9 ? vec3(0.0, 0.0, 1.0) : wall == 10 ? vec3(0.0, 0.0, -1.0) : vec3(-1.0, 0.0, 0.0);
}

// How much of a light from direction L reaches P through a window's opening (centre C, outward N,
// across U, half size h, panes across and up, a raised sash's rail at sash over its foot): 0 off it,
// its edges softer the further it travels, the bars and the rail in it, the rain on the glass
// dappling it.
float roomThrough(vec3 P, vec3 L, vec3 C, vec3 N, vec3 U, vec2 h, vec2 bars, float sash) {
  float ln = dot(L, N);
  if (ln < 0.02) return 0.0;
  float t = dot(C - P, N) / ln;
  if (t <= 0.0) return 0.0;
  vec3 Q = P + L * t - C;
  vec2 q = vec2(dot(Q, U), Q.y);
  float s = 0.004 + 0.012 * t;
  float open = smoothstep(-s, s, h.x - abs(q.x)) * smoothstep(-s, s, h.y - abs(q.y));
  if (open <= 0.0) return 0.0;
  vec2 pane = 2.0 * h / max(bars, 1.0);
  vec2 cell = (q + h) / pane;
  vec2 toBar = abs(cell - floor(cell + 0.5)) * pane;
  float glazed = sash > 0.0 ? step(sash, q.y + h.y) : 1.0;
  float barred = max(1.0 - smoothstep(0.009, 0.009 + s, toBar.x) * step(1.5, bars.x), 1.0 - smoothstep(0.009, 0.009 + s, toBar.y) * step(1.5, bars.y)) * glazed;
  float rail = sash > 0.0 ? 1.0 - smoothstep(0.0, s, abs(q.y + h.y - sash - 0.03) - 0.03) : 0.0;
  float drops = 1.0 - 0.5 * roomRain * glazed * smoothstep(0.5, 0.8, vnoise(q * 26.0 + vec2(0.0, roomTm * 0.6)));
  return open * (1.0 - 0.85 * max(barred, rail)) * drops;
}

// Window k's light on a surface at P facing n: the sky through its opening, and the sun's and the
// moon's light through it, the key's shadows where it throws them; and what all that light gives
// back off the room's surfaces, a soft fill near the window, so the wall it stands in and its own
// frame are lit too.
vec3 roomWindowLight(int k, int wall, vec3 P, vec3 n) {
  vec4 a = uElements[k * ${ELEMENT_ROWS}];
  vec4 b = uElements[k * ${ELEMENT_ROWS} + 1];
  vec4 c = uElements[k * ${ELEMENT_ROWS} + 2];
  vec4 e = uElements[k * ${ELEMENT_ROWS} + 3];
  vec3 N = roomWindowOut(wall);
  vec3 U = roomWindowAcross(wall);
  vec2 h = 0.5 * c.zw;
  vec3 d = a.xyz - P;
  float r2 = max(dot(d, d), 1e-4);
  vec3 dn = d * inversesqrt(r2);
  float area = 4.0 * h.x * h.y;
  float cosS = dot(n, n) < 0.5 ? 1.0 : 0.2 + 0.8 * max(dot(n, dn), 0.0);
  float reach = 1.0 / (1.0 + r2 / max(b.w * b.w, 1e-4));
  vec3 sky = roomSkyLight * area * max(dot(dn, N), 0.0) * cosS / (3.14159 * r2 + area) * (1.0 + reach);
  vec3 key = vec3(0.0);
  float sunUp = dot(roomSunLight, vec3(1.0));
  if (sunUp > 0.0) {
    float through = roomThrough(P, roomSun, a.xyz, N, U, h, e.xy, e.z);
    if (through > 0.0) key += roomSunLight * through * (dot(n, n) < 0.5 ? 1.0 : max(dot(n, roomSun), 0.0)) * (e.w > 0.5 ? roomShade(P, roomSun) : 1.0);
  }
  if (dot(roomMoonLight, vec3(1.0)) > 0.0) {
    float through = roomThrough(P, roomMoon, a.xyz, N, U, h, e.xy, e.z);
    if (through > 0.0) key += roomMoonLight * through * (dot(n, n) < 0.5 ? 1.0 : max(dot(n, roomMoon), 0.0)) * (e.w > 0.5 ? roomShade(P, roomMoon) : 1.0);
  }
  vec3 enters = roomSkyLight * 0.45 + roomSunLight * 0.3 * max(dot(roomSun, N), 0.0) + roomMoonLight * 0.3 * max(dot(roomMoon, N), 0.0);
  vec3 bounce = enters * min(area, 2.5) * (0.35 + 0.65 * reach);
  return b.rgb * a.w * (sky + key + bounce);
}

// The elements' light on a surface at P facing n (localLight's share).
vec3 roomElementsLight(vec3 P, vec3 n) {
  vec3 l = vec3(0.0);
${slotTerms((k) => `#if ROOM_KIND_${k} >= 8\n  l += roomWindowLight(${k}, ROOM_KIND_${k}, P, n);\n#else\n  l += roomPointLight(${k}, P, n);\n#endif`)}
  return l;
}

// The room's lamps' reach at frame point p on the seat's plane (no colour, no power): for a layer
// painted on the frame that tints its own highlights by it.
float roomLamp(vec2 p) {
  float l = 0.0;
  vec3 P = vec3(p.x / ROOM_SCALE, (p.y - ROOM_SEAT) / ROOM_SCALE, ROOM_DISTANCE);
${slotTerms((k) => `#if ROOM_KIND_${k} == 1\n  { vec4 a = uElements[${k * ELEMENT_ROWS}]; vec4 b = uElements[${k * ELEMENT_ROWS + 1}]; vec3 d = a.xyz - P; l += a.w / (1.0 + dot(d, d) / max(b.w * b.w, 1e-4)); }\n#endif`)}
  return l;
}

// The back window in frame (the first window element on the back wall), on the frame: its opening
// (left, right, foot, head), its casing and reveal, the sash's rail and the glass's stiles and bars,
// and where this cell is: in the open part, on the glass (and that pane's edges, roomGlass).
struct RoomWin {
  bool on;
  vec4 open;
  float casing;
  float reveal;
  float rail;
  float railTop;
  vec2 glass;
  vec2 bars;
  float bar;
  bool inOpen;
  bool inGlass;
  vec4 pane;
};
RoomWin roomWin;

void roomWindowBegin(Ctx x, int k) {
  vec4 a = uElements[k * ${ELEMENT_ROWS}];
  vec4 c = uElements[k * ${ELEMENT_ROWS} + 2];
  vec4 e = uElements[k * ${ELEMENT_ROWS} + 3];
  float s = RIG_FOCAL / max(a.z, 1e-3);
  vec2 lo = roomFrameOf(a.xyz - vec3(0.5 * c.zw, 0.0));
  vec2 hi = roomFrameOf(a.xyz + vec3(0.5 * c.zw, 0.0));
  roomWin.on = true;
  roomWin.open = vec4(lo.x, hi.x, lo.y, hi.y);
  roomWin.casing = 0.055 * s;
  roomWin.reveal = 0.036 * s;
  roomWin.rail = e.z > 0.0 ? lo.y + e.z * s : lo.y;
  roomWin.railTop = e.z > 0.0 ? roomWin.rail + 0.06 * s : lo.y + 0.02 * s;
  roomWin.glass = vec2(lo.x + roomWin.reveal + 0.033 * s, hi.x - roomWin.reveal - 0.033 * s);
  roomWin.bars = max(e.xy, 1.0);
  roomWin.bar = 0.009 * s;
  vec2 p = roomWallP;
  roomWin.inOpen = e.z > 0.0 && p.y > lo.y + 0.02 * s && p.y < roomWin.rail && p.x > lo.x + roomWin.reveal && p.x < hi.x - roomWin.reveal;
  // The glazed part: above the rail (or the window's own sill), between the stiles, off the bars.
  vec2 paneSize = vec2(roomWin.glass.y - roomWin.glass.x, hi.y - roomWin.railTop) / roomWin.bars;
  vec2 cell = (p - vec2(roomWin.glass.x, roomWin.railTop)) / paneSize;
  vec2 f = fract(cell) * paneSize;
  vec2 lo2 = min(f, paneSize - f);
  bool interior = all(greaterThan(cell, vec2(0.0))) && cell.x < roomWin.bars.x && p.y < hi.y;
  vec2 edgeBar = vec2(floor(cell.x) > 0.0 ? roomWin.bar : 0.0, floor(cell.y) > 0.0 ? roomWin.bar : 0.0);
  vec2 edgeBarHi = vec2(floor(cell.x) < roomWin.bars.x - 1.0 ? roomWin.bar : 0.0, floor(cell.y) < roomWin.bars.y - 1.0 ? roomWin.bar : 0.0);
  roomWin.pane = vec4(f.y - edgeBar.y, paneSize.y - f.y - edgeBarHi.y, f.x - edgeBar.x, paneSize.x - f.x - edgeBarHi.x);
  roomWin.inGlass = interior && min(min(roomWin.pane.x, roomWin.pane.y), min(roomWin.pane.z, roomWin.pane.w)) > 0.0;
  if (floor(cell.y) >= roomWin.bars.y - 1.0) roomWin.pane.y = 1e3;
}

// The shell's state for this cell: the World in the room, the back window on the frame.
void roomShellBegin(Ctx x) {
#if ROOM_POSE
  roomWallP = roomPlaneP(ROOM_BACK);
  roomViewP = roomRd.xy * (RIG_FOCAL / max(roomRd.z, 1e-4)) + vec2(0.0, ROOM_H0);
  roomWallUv = roomWallP / vec2(x.aspect, 1.0) + 0.5;
#else
  roomWallP = x.p;
  roomViewP = x.p;
  roomWallUv = x.uv;
#endif
  roomTm = x.tm;
  roomRain = 0.0;
  roomSun = vec3(0.0, -1.0, 0.0);
  roomMoon = vec3(0.0, -1.0, 0.0);
  roomSkyLight = vec3(0.0);
  roomSunLight = vec3(0.0);
  roomMoonLight = vec3(0.0);
#if ROOM_WORLD
  roomWorld = worldAt(${meteors ? "TRIGGER_meteors" : "-1"}, TRIGGER_lightning);
  Sky sky = roomWorld.sky;
  roomSun = skyFacing(sky.sun, -ROOM_FACING);
  roomMoon = skyFacing(sky.moon, -ROOM_FACING);
  // The sky's light through a window: its own, greyed by the overcast with the flash and the
  // aurora's glow in it (World.sky.ambient), brighter over snow; the sun's less the overcast; the
  // moon's under the deck dimmed as the sill's always was.
  roomSkyLight = sky.ambient * (1.0 + 0.6 * roomWorld.lying + 0.4 * roomWorld.snow) + vec3(0.5, 0.3, 0.2) * sky.twilight * 0.25;
  roomSunLight = sky.sunColor;
  roomMoonLight = sky.moonColor * (1.0 - 0.7 * roomWorld.overcast);
  roomRain = roomWorld.rain;
#endif
  roomWin.on = false;
  roomWin.inOpen = false;
  roomWin.inGlass = false;
  roomWin.pane = vec4(-1.0);
${slotTerms((k) => `#if ROOM_KIND_${k} == 8\n  if (!roomWin.on) roomWindowBegin(x, ${k});\n#endif`)}
}

// The back wall's albedo at W (m): its material.
vec3 roomWallAlbedo(vec3 W) {
#if ROOM_MATERIAL == 1
  // Papered: a tone-on-tone seventies pattern of rings and beads.
  vec2 w = W.xy / 0.08;
  w.x += 0.5 * mod(floor(w.y), 2.0);
  float d = length(fract(w) - 0.5);
  return ROOM_WALL * (0.92 + 0.12 * (1.0 - smoothstep(0.03, 0.06, abs(d - 0.32))) + 0.08 * (1.0 - smoothstep(0.08, 0.11, d)));
#elif ROOM_MATERIAL == 2
  // Shoji: washi in a lattice of thin cedar bars.
  vec2 g = abs(fract(W.xy / vec2(0.24, 0.3) + 0.5) - 0.5) * vec2(0.24, 0.3);
  float bar = 1.0 - smoothstep(0.007, 0.011, min(g.x, g.y));
  return mix(ROOM_WALL * (0.95 + 0.05 * vnoise(W.xy * 60.0)), vec3(0.2, 0.13, 0.08), bar);
#elif ROOM_MATERIAL == 3
  // A dark alcove: earthen plaster, darker toward its top.
  return ROOM_WALL * (0.85 + 0.15 * vnoise(W.xy * 6.0)) * (1.0 - 0.3 * smoothstep(0.2, 1.4, W.y));
#elif ROOM_MATERIAL == 4
  // Panelling: boards on end, their grooves and grain.
  float u = W.x / 0.14;
  float f = fract(u);
  float groove = smoothstep(0.0, 0.05, f) * (1.0 - smoothstep(0.95, 1.0, f));
  return ROOM_WALL * (0.82 + 0.18 * vnoise(vec2(floor(u) * 3.1 + f * 2.0, W.y * 14.0))) * (0.5 + 0.5 * groove);
#else
  // Plaster.
  return ROOM_WALL * (0.95 + 0.05 * vnoise(W.xy * 7.0));
#endif
}

// The back wall where nothing covers it.
void roomShellWall(Ctx x, inout Cell c) {
  vec3 W = roomWallAt(roomWallP);
  c.col = roomWallAlbedo(W) * roomLightAt(W, vec3(0.0, 0.0, -1.0));
}

// The sky in a window with no view (the World's light seen out of it): a plain gradient of its colour.
vec3 roomPlainSky(vec2 p) {
  return roomSkyLight * (0.9 + 0.5 * clamp(p.y - roomWin.open.z, 0.0, 1.0)) + roomSunLight * 0.08;
}

// The back window's frame: its casing, its own sill, the reveals, a raised sash's rail and the glazed
// part's stiles and bars; with no view in it (\`view\` false), the World's light seen out of it.
void roomShellWindow(Ctx x, inout Cell c, bool view) {
  if (!roomWin.on) return;
  vec2 p = roomWallP;
  vec4 o = roomWin.open;
  if (p.y < o.z || p.x < o.x - roomWin.casing || p.x > o.y + roomWin.casing) return;
  if (!view && (roomWin.inOpen || roomWin.inGlass)) {
    c.col = roomPlainSky(p);
    return;
  }
  if (roomWin.inOpen || roomWin.inGlass) return;
  vec3 W = roomWallAt(p);
  vec3 lit = roomLightAt(W, vec3(0.0, 0.0, -1.0));
  vec3 wood = LEDGE_HALF > 0.0 ? LEDGE_ALBEDO : vec3(0.42, 0.26, 0.15);
  vec3 outside = roomSkyLight + roomMoonLight * 0.2;
  if (p.y > o.w + roomWin.casing) return;
  if (p.x < o.x || p.x > o.y || p.y > o.w) {
    // The casing: a moulded surround, a groove and a bead along its inner edge.
    float u = p.x < o.x ? (p.x - o.x + roomWin.casing) / roomWin.casing : p.x > o.y ? (o.y + roomWin.casing - p.x) / roomWin.casing : (o.w + roomWin.casing - p.y) / roomWin.casing;
    float profile = 0.75 + 0.25 * smoothstep(0.0, 0.25, u) - 0.3 * smoothstep(0.55, 0.6, u) * smoothfall(0.72, 0.67, u) + 0.2 * smoothstep(0.85, 1.0, u);
    c.col = wood * lit * profile + outside * 0.2 * smoothstep(0.8, 1.0, u);
  } else if (p.y < o.z + 0.02 * RIG_FOCAL / ROOM_BACK) {
    // The window's own sill, its top edge lit from outside.
    c.col = wood * 0.6 * lit + outside * 0.25;
  } else if (p.x < o.x + roomWin.reveal || p.x > o.y - roomWin.reveal) {
    // The reveal, the wall's depth: the side facing the room's light lit, the other turned away.
    c.col = ROOM_WALL * lit * (p.x < 0.0 ? 1.0 : 0.45) + outside * 0.25;
  } else {
    // The sash: its bottom rail lit from under, its stiles and glazing bars.
    vec3 col = wood * 0.85 * lit + outside * 0.15;
    if (p.y < roomWin.railTop && p.y > roomWin.rail) {
      float v = (p.y - roomWin.rail) / max(roomWin.railTop - roomWin.rail, 1e-4);
      col *= 0.8 + 0.3 * smoothstep(0.0, 0.2, v);
      vec2 lq = (p - vec2(0.5 * (o.x + o.y), roomWin.railTop - 0.004)) / vec2(0.024, 0.008);
      if (dot(lq, lq) < 1.0) col = vec3(0.85, 0.64, 0.3) * (0.4 + lit * 1.5) * (0.8 + 0.2 * lq.y);
    }
    c.col = col;
  }
}

// The ledge: its top from its front edge back to the wall, its front, and what stands under it.
void roomShellLedge(Ctx x, inout Cell c) {
#if ROOM_LEDGE > 0
#if ROOM_POSE
  // Along the live ray: its top, the plane of its front face, and the wall behind.
  if (roomRd.y >= 0.0) return;
  vec3 T = roomEye + roomRd * (-roomEye.y / roomRd.y);
  vec3 F = roomEye + roomRd * ((LEDGE_FRONT - roomEye.z) / roomRd.z);
#else
  vec2 p = x.p;
  if (p.y >= ROOM_H0) return;
  vec3 T = roomTopAt(p);
#endif
  if (T.z > ROOM_BACK) return;
  if (T.z >= LEDGE_FRONT && abs(T.x) < LEDGE_HALF) {
    // The top: its grain running across, lit as everything is, the wall's foot in its shadow.
    float depth = (T.z - LEDGE_FRONT) / max(ROOM_BACK - LEDGE_FRONT, 1e-3);
    float grain = 0.82 + 0.18 * vnoise(vec2(T.x * 3.0 + vnoise(vec2(T.x * 11.0, T.z * 4.0)) * 1.5, T.z * 26.0));
#if ROOM_LEDGE == 3
    grain = 0.9 + 0.1 * grain;
#endif
    vec3 col = LEDGE_ALBEDO * grain * roomLightAt(T, vec3(0.0, 1.0, 0.0));
    col *= 1.0 - 0.35 * smoothstep(0.9, 1.0, depth);
#if ROOM_WORLD && ROOM_LEDGE == 1
    // Rain blowing in through an open window wets the sill by it.
    float wet = roomWorld.wet * (roomWin.on ? 1.0 : 0.0) * smoothstep(0.45, 1.0, depth) * (0.6 + 0.4 * vnoise(vec2(T.x * 40.0, depth * 3.0)));
    col = col * (1.0 - 0.3 * wet) + roomSkyLight * wet * 0.15;
#endif
    c.col = col;
    return;
  }
  // The front face, on its plane: the top's thickness, its edge catching the light.
#if !ROOM_POSE
  float k = LEDGE_FRONT / RIG_FOCAL;
  vec3 F = vec3(p.x * k, RIG_EYE + (p.y - ROOM_H0) * k, LEDGE_FRONT);
#endif
  bool across = abs(F.x) < LEDGE_HALF + 0.02;
  if (across && F.y > -LEDGE_THICK && T.z < LEDGE_FRONT) {
    float f = 1.0 + F.y / LEDGE_THICK;
    vec3 lit = roomLightAt(F, vec3(0.0, 0.0, -1.0));
    c.col = LEDGE_ALBEDO * lit * 0.75 * (0.8 + 0.2 * f) + LEDGE_ALBEDO * roomLightAt(F, vec3(0.0, 1.0, 0.0)) * 0.4 * smoothstep(0.75, 1.0, f);
    return;
  }
  if (T.z >= LEDGE_FRONT) return;
#if ROOM_LEDGE == 1
  // Under a sill: the wall in its shadow, an old radiator whose pale fins run under it.
  vec3 U = vec3(F.x, F.y, LEDGE_FRONT + 0.05);
  vec3 lit = roomLightAt(U, vec3(0.0, 0.0, -1.0));
  float under = mix(0.3, 0.85, smoothstep(0.0, 0.1, -LEDGE_THICK - F.y));
  vec3 col = roomWallAlbedo(U) * lit * under;
  if (F.y < -LEDGE_THICK - 0.03 && F.x > 0.05 && F.x < LEDGE_HALF - 0.1) {
    float fin = abs(fract(F.x / 0.033) - 0.5) * 2.0;
    float ribs = smoothfall(0.75, 0.55, fin) * (0.75 + 0.25 * sqrt(max(1.0 - fin * fin, 0.0)));
    vec3 paint = vec3(0.6, 0.56, 0.5) * lit * under;
    col = mix(col * 0.6, paint, ribs * smoothfall(-LEDGE_THICK - 0.03, -LEDGE_THICK - 0.045, F.y));
    col = mix(col, paint * 1.1, smoothfall(0.009, 0.0, abs(F.y + LEDGE_THICK + 0.04)));
  }
  c.col = across ? col : roomWallAlbedo(roomWallAt(roomWallP)) * roomLightAt(roomWallAt(roomWallP), vec3(0.0, 0.0, -1.0)) * 0.7;
#elif ROOM_LEDGE == 2
  // A sideboard's front: sliding doors in its shadow under the top's lit edge, their seams.
  if (!across) return;
  vec3 lit = roomLightAt(F, vec3(0.0, 0.0, -1.0));
  float seam = 1.0 - smoothstep(0.0, 0.004, abs(fract(F.x / 0.55 + 0.3) - 0.5) * 0.55);
  float under = 1.0 - smoothstep(0.0, 0.02, -LEDGE_THICK - F.y);
  c.col = LEDGE_ALBEDO * (0.1 + 0.04 * vnoise(vec2(F.x * 3.0, F.y * 30.0))) * (lit + 0.02) * (1.0 - max(0.6 * under, 0.5 * seam));
#else
  // A stand's or a low table's apron and legs, the wall and the floor behind them.
  float apron = LEDGE_THICK * 2.0;
  bool leg = abs(abs(F.x) - (LEDGE_HALF - 0.05)) < 0.025;
  if (across && (F.y > -apron || leg)) {
    vec3 lit = roomLightAt(F, vec3(0.0, 0.0, -1.0));
    c.col = LEDGE_ALBEDO * lit * (F.y > -apron ? 0.55 : 0.45);
    return;
  }
  // Behind: the wall down to the floor, the floor ahead of it in the ledge's shadow.
  vec3 W = roomWallAt(roomWallP);
  float floorY = -0.45;
  if (W.y > floorY) {
    c.col = roomWallAlbedo(W) * roomLightAt(W, vec3(0.0, 0.0, -1.0)) * 0.8;
  } else {
#if ROOM_POSE
    vec3 G = roomEye + roomRd * ((floorY - roomEye.y) / roomRd.y);
#else
    float z = RIG_FOCAL * (RIG_EYE - floorY) / max(ROOM_H0 - p.y, 1e-4);
    vec3 G = vec3(p.x * z / RIG_FOCAL, floorY, z);
#endif
    float shade = 1.0 - 0.5 * smoothfall(LEDGE_HALF + 0.1, LEDGE_HALF - 0.1, abs(G.x)) * step(G.z, ROOM_BACK);
    c.col = vec3(0.32, 0.26, 0.2) * (0.85 + 0.15 * vnoise(G.xz * 6.0)) * roomLightAt(G, vec3(0.0, 1.0, 0.0)) * shade;
  }
#endif
#endif
}

// A small body of each lamp, candle, neon tube or fire in frame, over what lies behind it, sized to
// read through the dither (README "Art direction": nothing thinner than about two cells).
void roomElementBody(Ctx x, inout Cell c, int k, int kind) {
  vec4 a = uElements[k * ${ELEMENT_ROWS}];
  vec4 b = uElements[k * ${ELEMENT_ROWS} + 1];
  vec4 e = uElements[k * ${ELEMENT_ROWS} + 2];
  if (a.z < 0.2) return;
  float s = RIG_FOCAL / a.z;
  // q: metres from the element across and up, at its depth; aa: a cell's width there.
#if ROOM_POSE
  vec2 q = (roomPlaneP(a.z) - roomFrameOf(a.xyz)) / s;
  float aa = (a.z - roomEye.z) / (RIG_FOCAL * roomZoom * uRes.y);
#else
  vec2 q = (x.p - roomFrameOf(a.xyz)) / s;
  float aa = x.px / s;
#endif
  float glow = a.w * roomFlicker(e.x, e.y);
  vec3 light = b.rgb * glow;
${elementBodyKinds("ROOM_AMBIENT", "roomTm", false)}
}

void roomShellBodies(Ctx x, inout Cell c) {
${slotTerms((k) => `#if ROOM_KIND_${k} >= 1 && ROOM_KIND_${k} <= 4\n  roomElementBody(x, c, ${k}, ROOM_KIND_${k});\n#endif`)}
}
`;
}
