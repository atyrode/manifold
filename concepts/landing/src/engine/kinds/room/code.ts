// The room's code (src/engine/glsl.ts, the kind contract): shape.ts's room in GLSL, the same
// constants and layout. Its hit takes the nearest of the floor slab, the ceiling slab and each wall
// it crosses (each in its own frame, culled by the box of all it holds): the wall's box less its
// openings' prisms (a ray in an opening leaves by its reveal or passes), its skirting and cornice,
// and the trims of each opening it crosses. Its shadow is the same test with the glass let through,
// so the World's key and the lamps lay their patches through the windows. Its surface by piece: the
// walls' material inside and in the reveals (each compiled only while an instance holds it), a render
// or brick outside, the floor's material, white plaster overhead, the trims in their tone, the glass
// tinting what lies behind it and reflecting a little (Hit.clear, Hit.mirror); every pattern fades to
// its mean once a cell spans it.
import { glslFloat, glslVec3 } from "../../../shaders/glsl.ts";
import type { KindCode } from "../../types.ts";
import { joineryGlsl } from "../joinery.ts";
import { PIECE, ROOM, ROOM_FLOORS, ROOM_WALLS } from "./shape.ts";

/**
 * What the glass lets through, per channel (a faint green); its reflection's share (the core's mirror
 * mix makes that 0.09 at normal incidence, as a pane's two faces reflect); its own albedo (dust).
 */
const GLASS_CLEAR = [0.84, 0.9, 0.87] as const;
const GLASS_MIRROR = 0.3;
const GLASS_ALBEDO = 0.03;

const vec2 = (v: readonly [number, number]): string =>
  `vec2(${glslFloat(v[0])}, ${glslFloat(v[1])})`;

/** The values a compiled option's instances hold (bit v of `mask`), of `names`, with their index. */
function held<T extends string>(names: readonly T[], mask: number): (readonly [T, number])[] {
  return names.flatMap((name, k) => ((mask & (1 << k)) !== 0 ? [[name, k] as const] : []));
}

/** The code of each held material, by its option's value: one body alone, or a branch on `value`. */
function pick<T extends string>(
  names: readonly T[],
  mask: number,
  value: string,
  body: Readonly<Record<T, string>>,
): string {
  const kept = held(names, mask);
  const first = kept[0] ?? [names[0] as T, 0];
  if (kept.length <= 1) return body[first[0]];
  return `  int m = int(${value} + 0.5);
${kept.map(([name, k], at) => `  ${at === 0 ? "" : "else "}if (m == ${k}) {\n${body[name]}\n  }`).join("\n")}`;
}

export const glass: NonNullable<KindCode["glass"]> = (compiled) =>
  ((compiled["glazed"] ?? 0) & 2) !== 0;

export const glsl: KindCode["glsl"] = (compiled) => {
  const glazed = compiled["glazed"] ?? 0;
  const brick = ((compiled["wall"] ?? 0) & (1 << ROOM_WALLS.indexOf("brick"))) !== 0;
  const pieces = Object.entries(PIECE)
    .map(([name, value]) => `const float ROOM_P_${name.toUpperCase()} = ${glslFloat(value)};`)
    .join("\n");
  const walls: Readonly<Record<(typeof ROOM_WALLS)[number], string>> = {
    plaster: `    vec2 f = fbmLod(q * 2.3, foot * 2.3, 3);
    h.albedo = roomPaint(o, roomTone(o)) * (0.95 + 0.1 * (f.x - 0.5));`,
    // The lava room's paper (composer/shell.ts): rings and beads, tone on tone, a little stronger
    // than the shell's so that they still read through the dither by a dim lamp.
    papered: `    vec2 w = q / 0.08;
    w.x += 0.5 * mod(floor(w.y), 2.0);
    float d = length(fract(w) - 0.5);
    float px = foot / 0.08;
    float ring = 1.0 - smoothstep(0.03, 0.06 + px, abs(d - 0.32));
    float bead = 1.0 - smoothstep(0.08, 0.11 + px, d);
    h.albedo = roomPaint(o, roomTone(o)) * (0.88 + mix(0.04, 0.2 * ring + 0.12 * bead, 1.0 - smoothstep(0.08, 0.25, px)));`,
    // Washi in a lattice of cedar bars over a board along the floor.
    shoji: `    if (q.y < ROOM_FLOOR_TOP + 0.32) {
      h.albedo = roomWood(0.3) * roomGrain(q, foot, 1.0);
      h.rough = 0.7;
    } else {
      vec2 cell = vec2(0.24, 0.3);
      vec2 g = abs(fract((q - vec2(0.0, ROOM_FLOOR_TOP + 0.32)) / cell + 0.5) - 0.5) * cell;
      float bar = mix(0.13, 1.0 - smoothstep(0.009, 0.012 + foot, min(g.x, g.y)), 1.0 - smoothstep(0.006, 0.02, foot));
      vec3 washi = mix(vec3(0.93, 0.91, 0.86), roomPaint(o, roomTone(o)), 0.3) * (0.97 + 0.08 * (fbmLod(q * 40.0, foot * 40.0, 2).x - 0.5));
      h.albedo = mix(washi, vec3(0.3, 0.19, 0.1), bar);
    }`,
    // Boards on end, 12 cm wide, a groove between each.
    panelling: `    float u = q.x / 0.12;
    float board = floor(u);
    float edge = min(fract(u), 1.0 - fract(u)) * 0.12;
    float groove = mix(0.85, smoothstep(0.002, 0.006 + foot, edge), 1.0 - smoothstep(0.004, 0.012, foot));
    h.albedo = roomWood(roomTone(o)) * (0.88 + 0.24 * hash12(vec2(board, 3.7))) * roomGrain(q.yx, foot, board) * mix(0.45, 1.0, groove);
    h.rough = 0.65;`,
    brick: `    h.albedo = roomBrick(q, foot, roomTone(o));`,
  };
  const floors: Readonly<Record<(typeof ROOM_FLOORS)[number], string>> = {
    // Boards along x, 14 cm wide, 1.8 m long, their ends staggered row by row.
    boards: `    float row = floor(p.z / 0.14);
    float run = p.x / 1.8 + hash12(vec2(row, 1.3));
    vec2 id = vec2(floor(run), row);
    vec2 e = vec2(min(fract(run), 1.0 - fract(run)) * 1.8, min(fract(p.z / 0.14), 1.0 - fract(p.z / 0.14)) * 0.14);
    float gap = (1.0 - smoothstep(0.0015, 0.0015 + foot, min(e.x, e.y))) * (1.0 - smoothstep(0.01, 0.04, foot));
    float seed = hash12(id);
    vec3 wood = roomWood(roomFloorTone(o)) * (0.85 + 0.3 * seed) * roomGrain(p.xz, foot, seed * 9.0);
    h.albedo = mix(wood, wood * 0.35, gap);
    h.rough = 0.55;`,
    // Square tiles, 30 cm, slate through terracotta to cream by tone, their grout.
    tiles: `    vec2 f = p.xz / 0.3;
    vec2 e = min(fract(f), 1.0 - fract(f)) * 0.3;
    float grout = (1.0 - smoothstep(0.002, 0.002 + foot, min(e.x, e.y))) * (1.0 - smoothstep(0.01, 0.03, foot));
    float tone = roomFloorTone(o);
    vec3 tile = tone < 0.5 ? mix(vec3(0.16, 0.16, 0.18), vec3(0.58, 0.29, 0.18), tone * 2.0) : mix(vec3(0.58, 0.29, 0.18), vec3(0.86, 0.81, 0.7), tone * 2.0 - 1.0);
    h.albedo = mix(tile * (0.88 + 0.24 * hash12(floor(f) + 0.5)), vec3(0.55, 0.53, 0.5), grout);
    h.rough = 0.45;`,
    // Wool, dark brown through rust to oatmeal by tone: its pile and its wear.
    carpet: `    float tone = roomFloorTone(o);
    vec3 wool = tone < 0.5 ? mix(vec3(0.18, 0.09, 0.05), vec3(0.5, 0.22, 0.08), tone * 2.0) : mix(vec3(0.5, 0.22, 0.08), vec3(0.75, 0.66, 0.48), tone * 2.0 - 1.0);
    float pile = fbmLod(p.xz * 90.0, foot * 90.0, 2).x;
    float wear = fbmLod(p.xz * 3.0, foot * 3.0, 2).x;
    h.albedo = wool * (0.9 + 0.22 * (pile - 0.5) + 0.14 * (wear - 0.5));`,
  };
  return `${joineryGlsl("room")}
// ---- the room's measures (src/engine/kinds/room/shape.ts) ----
const float ROOM_T = ${glslFloat(ROOM.wall)};
const float ROOM_FLOOR_TOP = ${glslFloat(ROOM.floor)};
const float ROOM_CEILING_T = ${glslFloat(ROOM.ceiling)};
const float ROOM_LINTEL = ${glslFloat(ROOM.lintel)};
const float ROOM_MARGIN = ${glslFloat(ROOM.margin)};
const vec2 ROOM_DOOR = ${vec2(ROOM.door)};
const vec2 ROOM_SKIRTING = ${vec2(ROOM.skirting)};
const vec2 ROOM_CORNICE = ${vec2(ROOM.cornice)};
const vec2 ROOM_CASING = ${vec2(ROOM.casing)};
const vec2 ROOM_FRAME = ${vec2(ROOM.frame)};
const vec2 ROOM_BAR = ${vec2(ROOM.bar)};
const float ROOM_GLASS_AT = ${glslFloat(ROOM.glassAt)};
const vec3 ROOM_STOOL = ${glslVec3(ROOM.stool)};
const vec2 ROOM_APRON = ${vec2(ROOM.apron)};
const vec2 ROOM_SILL = ${vec2(ROOM.sill)};
const float ROOM_LEAF = ${glslFloat(ROOM.leaf)};
const float ROOM_IN = ${glslFloat(ROOM.inside)};
const float ROOM_OUT = ${glslFloat(ROOM.outside)};
${pieces}

// The room's options as its shape reads them.
struct RoomShape {
  float w;       // inside: across (x), front to back (z), up
  float d;
  float h;
  float top;     // the walls' head, the ceiling's underside
  bool ceiling;
  vec2 win;      // a window's width and height
  float sill;
  float panes;   // its mullions: 0, 1 or 2 (a transom with any)
  bool glazed;
};

RoomShape roomShape(EngineObj o) {
  RoomShape r;
  r.w = roomWidth(o);
  r.d = roomDepth(o);
  r.h = roomHeight(o);
  r.top = ROOM_FLOOR_TOP + r.h;
  r.ceiling = roomCeiling(o) > 0.5;
  r.win = vec2(roomWindowWidth(o), roomWindowHeight(o));
  r.sill = roomSill(o);
  r.panes = floor(roomPanes(o) + 0.5);
  r.glazed = ${glazed === 2 ? "true" : glazed === 3 ? "roomGlazed(o) > 0.5" : "false"};
  return r;
}

// Wall s's windows and door (0 none, 1 a doorway, 2 a door).
vec2 roomOpenings(EngineObj o, int s) {
  vec2 a = s == 0 ? vec2(roomFarWindows(o), roomFarDoor(o)) : s == 1 ? vec2(roomRightWindows(o), roomRightDoor(o)) : s == 2 ? vec2(roomNearWindows(o), roomNearDoor(o)) : vec2(roomLeftWindows(o), roomLeftDoor(o));
  return floor(a + 0.5);
}

// Opening k of n along a wall \`inside\` metres long inside, the door first if \`door\` (shape.ts
// wallOpenings): its centre along it and half its width, its foot and head.
vec4 roomOpening(RoomShape r, float inside, float n, bool door, int k) {
  float slot = inside / max(n, 1.0);
  float at = -0.5 * inside + (float(k) + 0.5) * slot;
  float space = max(slot - 2.0 * ROOM_MARGIN, 0.2);
  if (door && k == 0) return vec4(at, 0.5 * min(ROOM_DOOR.x, space), ROOM_FLOOR_TOP, ROOM_FLOOR_TOP + min(ROOM_DOOR.y, r.h - ROOM_LINTEL));
  float foot = ROOM_FLOOR_TOP + min(r.sill, r.h - ROOM_LINTEL - 0.2);
  return vec4(at, 0.5 * min(r.win.x, space), foot, min(foot + r.win.y, r.top - ROOM_LINTEL));
}

// A point of the room's frame in wall s's (u along it, y up, v into the room from its inner face);
// a direction (its own inverse: also a wall's direction back in the room's).
vec3 roomWallPoint(RoomShape r, int s, vec3 p) {
  return s == 0 ? vec3(p.x, p.y, 0.5 * r.d - p.z) : s == 1 ? vec3(-p.z, p.y, 0.5 * r.w - p.x) : s == 2 ? vec3(-p.x, p.y, p.z + 0.5 * r.d) : vec3(p.z, p.y, p.x + 0.5 * r.w);
}
vec3 roomWallDir(int s, vec3 v) {
  return s == 0 ? vec3(v.x, v.y, -v.z) : s == 1 ? vec3(-v.z, v.y, -v.x) : s == 2 ? vec3(-v.x, v.y, v.z) : vec3(v.z, v.y, v.x);
}

// A window's trims (q: its opening) in its wall's frame: the frame and bars round the glass${glazed >= 2 ? ", the glass (not for a shadow)" : ""}, the
// stool and apron inside, the casing, the stone sill outside.
void roomWindow(RoomShape r, vec4 q, vec3 ro, vec3 rd, vec3 inv, float from, bool shadow, inout float t, inout vec3 n, inout float part) {
  float l = q.x - q.y;
  float u = q.x + q.y;
  float g = -ROOM_GLASS_AT * ROOM_T;
  float f0 = g - 0.5 * ROOM_FRAME.y;
  float f1 = g + 0.5 * ROOM_FRAME.y;
  float fw = ROOM_FRAME.x;
  float before = t;
  roomBox(ro, inv, vec3(l, q.z, f0), vec3(l + fw, q.w, f1), from, t, n);
  roomBox(ro, inv, vec3(u - fw, q.z, f0), vec3(u, q.w, f1), from, t, n);
  roomBox(ro, inv, vec3(l, q.z, f0), vec3(u, q.z + 1.3 * fw, f1), from, t, n);
  roomBox(ro, inv, vec3(l, q.w - fw, f0), vec3(u, q.w, f1), from, t, n);
  vec4 pane = vec4(l + fw, u - fw, q.z + 1.3 * fw, q.w - fw);
  vec2 bar = 0.5 * ROOM_BAR;
  for (int i = 0; i < 2; i++) {
    if (float(i) >= r.panes) break;
    float x = pane.x + (float(i) + 1.0) / (r.panes + 1.0) * (pane.y - pane.x);
    roomBox(ro, inv, vec3(x - bar.x, pane.z, g - bar.y), vec3(x + bar.x, pane.w, g + bar.y), from, t, n);
  }
  if (r.panes > 0.5) {
    float y = pane.z + 0.62 * (pane.w - pane.z);
    roomBox(ro, inv, vec3(pane.x, y - bar.x, g - bar.y), vec3(pane.y, y + bar.x, g + bar.y), from, t, n);
  }
  if (t < before) part = ROOM_P_FRAME;${
    glazed >= 2
      ? `
  if (!shadow && r.glazed) {
    float s = (g - ro.z) * inv.z;
    vec2 at = ro.xy + rd.xy * s;
    if (s >= from && s < t && at.x > pane.x && at.x < pane.y && at.y > pane.z && at.y < pane.w) {
      t = s;
      n = vec3(0.0, 0.0, -sign(inv.z));
      part = ROOM_P_GLASS;
    }
  }`
      : ""
  }
  before = t;
  float under = q.z + 0.015 - ROOM_STOOL.x;
  roomBox(ro, inv, vec3(l - ROOM_STOOL.z, under, f1), vec3(u + ROOM_STOOL.z, q.z + 0.015, ROOM_STOOL.y), from, t, n);
  roomBox(ro, inv, vec3(l - ROOM_CASING.x + 0.005, under - ROOM_APRON.x, 0.0), vec3(u + ROOM_CASING.x - 0.005, under, ROOM_APRON.y), from, t, n);
  if (t < before) part = ROOM_P_STOOL;
  before = t;
  roomBox(ro, inv, vec3(l - ROOM_CASING.x, q.z + 0.015, 0.0), vec3(l, q.w + ROOM_CASING.x, ROOM_CASING.y), from, t, n);
  roomBox(ro, inv, vec3(u, q.z + 0.015, 0.0), vec3(u + ROOM_CASING.x, q.w + ROOM_CASING.x, ROOM_CASING.y), from, t, n);
  roomBox(ro, inv, vec3(l - ROOM_CASING.x, q.w, 0.0), vec3(u + ROOM_CASING.x, q.w + ROOM_CASING.x, ROOM_CASING.y), from, t, n);
  if (t < before) part = ROOM_P_CASING;
  if (roomBox(ro, inv, vec3(l - 0.04, q.z - ROOM_SILL.y, -ROOM_T - ROOM_SILL.x), vec3(u + 0.04, q.z + 0.005, f0), from, t, n)) part = ROOM_P_SILL;
}

// A door's trims (q: its opening) in its wall's frame: its casing either side of the wall, and with
// \`leaf\` the door standing closed in it and its handles.
void roomDoor(vec4 q, bool leaf, vec3 ro, vec3 rd, vec3 inv, float from, inout float t, inout vec3 n, inout float part) {
  float l = q.x - q.y;
  float u = q.x + q.y;
  float before = t;
  for (int side = 0; side < 2; side++) {
    float v0 = side == 0 ? 0.0 : -ROOM_T - ROOM_CASING.y;
    float v1 = v0 + ROOM_CASING.y;
    roomBox(ro, inv, vec3(l - ROOM_CASING.x, q.z, v0), vec3(l, q.w + ROOM_CASING.x, v1), from, t, n);
    roomBox(ro, inv, vec3(u, q.z, v0), vec3(u + ROOM_CASING.x, q.w + ROOM_CASING.x, v1), from, t, n);
    roomBox(ro, inv, vec3(l - ROOM_CASING.x, q.w, v0), vec3(u + ROOM_CASING.x, q.w + ROOM_CASING.x, v1), from, t, n);
  }
  if (t < before) part = ROOM_P_CASING;
  if (!leaf) return;
  float mid = -0.5 * ROOM_T;
  float thick = 0.5 * ROOM_LEAF;
  if (roomBox(ro, inv, vec3(l + 0.004, q.z + 0.008, mid - thick), vec3(u - 0.004, q.w - 0.003, mid + thick), from, t, n))
    part = ROOM_P_LEAF + clamp((ro.x + rd.x * t - l) / (u - l), 0.0, 0.999);
  before = t;
  roomBox(ro, inv, vec3(u - 0.17, q.z + 0.975, mid + thick), vec3(u - 0.055, q.z + 0.995, mid + thick + 0.06), from, t, n);
  roomBox(ro, inv, vec3(u - 0.17, q.z + 0.975, mid - thick - 0.06), vec3(u - 0.055, q.z + 0.995, mid - thick), from, t, n);
  if (t < before) part = ROOM_P_HANDLE;
}

// Whether the ray ro + rd t of wall s's frame, t in [from, t), crosses the box of all it holds.
bool roomReaches(RoomShape r, int s, vec3 ro, vec3 rd, float from, float t) {
  float reach = s == 0 || s == 2 ? 0.5 * r.w + ROOM_T : 0.5 * r.d;
  vec2 cull = engineSlab(ro, rd, vec3(-reach, 0.0, -ROOM_T - ROOM_OUT), vec3(reach, r.top, ROOM_IN));
  return cull.x <= cull.y && cull.y >= from && cull.x < t;
}

// Wall s and all it holds against the ray ro + rd t of its frame, t in [from, t): t, n (its frame)
// and part become the nearest hit's. Skipped unless the ray crosses the box of all it holds.
void roomSide(EngineObj o, RoomShape r, int s, vec3 ro, vec3 rd, float from, bool shadow, inout float t, inout vec3 n, inout float part) {
  if (!roomReaches(r, s, ro, rd, from, t)) return;
  bool across = s == 0 || s == 2;
  float inside = across ? r.w : r.d;
  float reach = across ? 0.5 * r.w + ROOM_T : 0.5 * r.d;
  vec3 inv = roomInv(rd);
  vec2 op = roomOpenings(o, s);
  bool door = op.y > 0.5;
  int count = int(op.x) + (door ? 1 : 0);
  vec4 ops[4];
  for (int k = 0; k < 4; k++) {
    if (k >= count) break;
    ops[k] = roomOpening(r, inside, float(count), door, k);
  }
  // The wall itself: its box less the openings' prisms.
  vec3 a = (vec3(-reach, 0.0, -ROOM_T) - ro) * inv;
  vec3 b = (vec3(reach, r.top, 0.0) - ro) * inv;
  vec3 near = min(a, b);
  vec3 far = max(a, b);
  float enter = max(max(near.x, near.y), near.z);
  float leave = min(min(far.x, far.y), far.z);
  float at = max(enter, from);
  if (at <= leave && at < t) {
    vec3 e = ro + rd * at;
    int hole = -1;
    for (int k = 0; k < 4; k++) {
      if (k >= count) break;
      vec4 q = ops[k];
      if (abs(e.x - q.x) < q.y && e.y > q.z && e.y < q.w) hole = k;
    }
    if (hole < 0) {
      t = at;
      n = enter < from ? -rd : enter == near.x ? vec3(-sign(inv.x), 0.0, 0.0) : enter == near.y ? vec3(0.0, -sign(inv.y), 0.0) : vec3(0.0, 0.0, -sign(inv.z));
      part = n.z > 0.5 ? ROOM_P_INSIDE : ROOM_P_OUTSIDE;
    } else {
      // Through the opening: out of its prism by a side (its reveal), or out of the wall.
      vec4 q = ops[hole];
      float tu = max((q.x - q.y - ro.x) * inv.x, (q.x + q.y - ro.x) * inv.x);
      float ty = max((q.z - ro.y) * inv.y, (q.w - ro.y) * inv.y);
      float exit = min(tu, ty);
      if (exit < leave && exit < t) {
        t = exit;
        n = tu <= ty ? vec3(-sign(inv.x), 0.0, 0.0) : vec3(0.0, -sign(inv.y), 0.0);
        part = door && hole == 0 ? ROOM_P_LINING : ROOM_P_REVEAL;
      }
    }
  }
  // A shadow ray stops at the first thing it meets (roomTrace sends it in with nothing met yet).
  if (shadow && part >= 0.0) return;
  // The skirting along its foot, broken at its door; the cornice along its head under a ceiling.
  float ts = t;
  vec3 ns = n;
  if (roomBox(ro, inv, vec3(-0.5 * inside, ROOM_FLOOR_TOP, 0.0), vec3(0.5 * inside, ROOM_FLOOR_TOP + ROOM_SKIRTING.x, ROOM_SKIRTING.y), from, ts, ns)
      && !(door && abs(ro.x + rd.x * ts - ops[0].x) < ops[0].y + ROOM_CASING.x)) {
    t = ts;
    n = ns;
    part = ROOM_P_SKIRTING;
  }
  if (r.ceiling && roomCutBox(ro, rd, inv, vec3(-0.5 * inside, r.top - ROOM_CORNICE.x, 0.0), vec3(0.5 * inside, r.top, ROOM_CORNICE.y), vec4(0.0, -1.0 / ROOM_CORNICE.x, 1.0 / ROOM_CORNICE.y, 1.0 - r.top / ROOM_CORNICE.x), from, t, n))
    part = ROOM_P_CORNICE;
  // The trims of the openings the ray reaches (bit k), gathered first so that a software rasteriser
  // works out as many as a cell reaches rather than every one (src/engine/glsl.ts "What a program
  // costs"); each is tried again as the hits so far leave it.
  float m = ROOM_STOOL.z + 0.01;
  uint reached = 0u;
  for (int k = 0; k < 4; k++) {
    if (k >= count) break;
    vec4 q = ops[k];
    vec2 box = engineSlab(ro, rd, vec3(q.x - q.y - m, q.z - 0.12, -ROOM_T - ROOM_OUT), vec3(q.x + q.y + m, q.w + ROOM_CASING.x + 0.01, ROOM_IN));
    if (box.x <= box.y && box.y >= from && box.x < t) reached |= 1u << uint(k);
  }
  while (reached != 0u) {
    if (shadow && part >= 0.0) break;
    uint low = reached & (~reached + 1u);
    reached ^= low;
    int k = int(log2(float(low)) + 0.5);
    vec4 q = ops[k];
    vec2 box = engineSlab(ro, rd, vec3(q.x - q.y - m, q.z - 0.12, -ROOM_T - ROOM_OUT), vec3(q.x + q.y + m, q.w + ROOM_CASING.x + 0.01, ROOM_IN));
    if (box.x > box.y || box.y < from || box.x >= t) continue;
    if (door && k == 0) roomDoor(q, op.y > 1.5, ro, rd, inv, from, t, n, part);
    else roomWindow(r, q, ro, rd, inv, from, shadow, t, n, part);
  }
}

// The nearest hit in span: the ceiling, the floor, each wall and all it holds. With \`shadow\` the
// glass lets the ray through, and the first thing met (the nearest or not) ends it. t, else -1.
float roomTrace(EngineObj o, vec3 ro, vec3 rd, vec2 span, bool shadow, out vec3 n, out float part) {
  RoomShape r = roomShape(o);
  vec3 inv = roomInv(rd);
  float t = span.y;
  n = vec3(0.0, 1.0, 0.0);
  part = -1.0;
  if (r.ceiling && roomBox(ro, inv, vec3(-0.5 * r.w - ROOM_T, r.top, -0.5 * r.d - ROOM_T), vec3(0.5 * r.w + ROOM_T, r.top + ROOM_CEILING_T, 0.5 * r.d + ROOM_T), span.x, t, n)) part = ROOM_P_CEILING;
  if (shadow && part >= 0.0) return t;
  if (roomBox(ro, inv, vec3(-0.5 * r.w, 0.0, -0.5 * r.d), vec3(0.5 * r.w, ROOM_FLOOR_TOP, 0.5 * r.d), span.x, t, n)) part = ROOM_P_FLOOR;
  // The walls the ray reaches (bit s), gathered first as their openings are (roomSide).
  uint walls = 0u;
  for (int s = 0; s < 4; s++)
    if (roomReaches(r, s, roomWallPoint(r, s, ro), roomWallDir(s, rd), span.x, t)) walls |= 1u << uint(s);
  while (walls != 0u) {
    if (shadow && part >= 0.0) break;
    uint low = walls & (~walls + 1u);
    walls ^= low;
    int s = int(log2(float(low)) + 0.5);
    float before = t;
    vec3 m = n;
    roomSide(o, r, s, roomWallPoint(r, s, ro), roomWallDir(s, rd), span.x, shadow, t, m, part);
    if (t < before) n = roomWallDir(s, m);
  }
  return part < 0.0 ? -1.0 : t;
}

float roomHit(EngineObj o, vec3 ro, vec3 rd, vec2 span, out vec3 n, out float part) {
  return roomTrace(o, ro, rd, span, false, n, part);
}

float roomShadow(EngineObj o, vec3 ro, vec3 rd, vec2 span) {
  vec3 n;
  float part;
  return roomTrace(o, ro, rd, span, true, n, part) < 0.0 ? 1.0 : 0.0;
}

// The plaster's and the paper's colour at tone: white at tint 0, then round the hues, muted.
vec3 roomPaint(EngineObj o, float tone) {
  float tint = roomTint(o);
  vec3 hue = clamp(abs(mod(tint * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return mix(vec3(1.0), hue, 0.25 * smoothstep(0.0, 0.08, tint)) * mix(0.25, 0.95, tone);
}
${
  brick
    ? `
// Brick in stretcher bond at q (metres), its mortar joints gone to their mean once a cell spans a course.
vec3 roomBrick(vec2 q, float foot, float tone) {
  vec2 unit = vec2(0.225, 0.075);
  float row = floor(q.y / unit.y);
  vec2 b = vec2(q.x / unit.x + 0.5 * mod(row, 2.0), q.y / unit.y);
  vec2 e = min(fract(b), 1.0 - fract(b)) * unit;
  float joint = mix(0.15, 1.0 - smoothstep(0.005, 0.005 + max(foot, 1e-3), min(e.x, e.y)), 1.0 - smoothstep(0.025, 0.075, foot));
  vec3 brick = vec3(0.55, 0.25, 0.17) * mix(0.6, 1.25, tone) * (0.8 + 0.4 * hash12(floor(b) + 7.1));
  return mix(brick, vec3(0.68, 0.66, 0.6), joint);
}
`
    : ""
}
// The walls' material inside and in the reveals, at q on the face (metres along it, up).
void roomInside(EngineObj o, vec2 q, float foot, inout Hit h) {
${pick(ROOM_WALLS, compiled["wall"] ?? 0, "roomWall(o)", walls)}
}

void roomSurface(EngineObj o, vec3 p, inout vec3 n, float part, inout Hit h) {
  float foot = h.t * engineCell / o.scale;
  float piece = floor(part);
  vec2 q = abs(n.x) > 0.5 ? p.zy : abs(n.y) > 0.5 ? p.xz : p.xy;
  h.rough = 1.0;
  h.mat = int(piece);
  if (piece == ROOM_P_FLOOR) {
${pick(ROOM_FLOORS, compiled["floor"] ?? 0, "roomFloor(o)", floors)}
  } else if (piece == ROOM_P_INSIDE || piece == ROOM_P_REVEAL) {
    roomInside(o, q, foot, h);
  } else if (piece == ROOM_P_OUTSIDE || (piece == ROOM_P_CEILING && abs(n.y) < 0.5)) {
    // A lime render outside, of the walls' tint lightened; brick stays brick.
${
  brick && (compiled["wall"] ?? 0) === 1 << ROOM_WALLS.indexOf("brick")
    ? `    h.albedo = roomBrick(q, foot, roomTone(o));`
    : `    h.albedo = mix(vec3(0.8, 0.77, 0.7), roomPaint(o, 0.85), 0.4) * (0.92 + 0.16 * (fbmLod(q * 4.0, foot * 4.0, 3).x - 0.5));${
        brick
          ? `
    if (int(roomWall(o) + 0.5) == ${ROOM_WALLS.indexOf("brick")}) h.albedo = roomBrick(q, foot, roomTone(o));`
          : ""
      }`
}
  } else if (piece == ROOM_P_CEILING || piece == ROOM_P_CORNICE) {
    // White plaster under the ceiling and on the cornice, roofing felt on top.
    h.albedo = n.y > 0.5 ? vec3(0.24, 0.23, 0.24) : vec3(0.84, 0.83, 0.8) * (0.96 + 0.08 * (fbmLod(q * 3.0, foot * 3.0, 2).x - 0.5));
    h.rough = n.y > 0.5 ? 0.85 : 1.0;${
      glazed >= 2
        ? `
  } else if (piece == ROOM_P_GLASS) {
    h.albedo = vec3(${glslFloat(GLASS_ALBEDO)});
    h.rough = 0.04;
    h.mirror = ${glslFloat(GLASS_MIRROR)};
    h.clear = ${glslVec3(GLASS_CLEAR)};`
        : ""
    }
  } else if (piece == ROOM_P_SILL) {
    h.albedo = vec3(0.6, 0.58, 0.54) * (0.92 + 0.16 * (fbmLod(q * 9.0, foot * 9.0, 2).x - 0.5));
  } else if (piece == ROOM_P_HANDLE) {
    h.albedo = vec3(0.72, 0.55, 0.26);
    h.rough = 0.25;
  } else {
    // The trims: wood, or painted over it.
    float paint = roomTrim(o);
    h.albedo = mix(roomWood(0.3) * roomGrain(q, foot, 2.0), vec3(0.86, 0.85, 0.81), paint);
    h.rough = mix(0.55, 0.7, paint);
    if (piece == ROOM_P_LEAF) {
      // Four panels, fielded: their bevels shaded, gone once a cell spans them.
      vec2 c = vec2(fract(part) < 0.5 ? (fract(part) - 0.14) / 0.33 : (fract(part) - 0.53) / 0.33, q.y < ROOM_FLOOR_TOP + 0.98 ? (q.y - ROOM_FLOOR_TOP - 0.18) / 0.72 : (q.y - ROOM_FLOOR_TOP - 1.06) / 0.8);
      vec2 e = min(c, 1.0 - c) * vec2(0.28, 0.76);
      float bevel = step(0.0, min(e.x, e.y)) * (1.0 - smoothstep(0.0, 0.025, min(e.x, e.y)));
      h.albedo *= 1.0 - 0.35 * bevel * (1.0 - smoothstep(0.01, 0.03, foot));
    }
  }
}
`;
};
