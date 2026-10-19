// The room's shape, shared by its manifest (index.ts: bounds, the CPU cast), its GLSL (code.ts, the
// same constants and the same layout) and its tests.
//
// The room's own frame: origin at the centre of its base (the floor slab's underside), x across, y
// up, z ahead; the inside spans width x depth from the floor's top (ROOM.floor) up `height`. Walls
// stand ROOM.wall thick outside the inside, the far and near ones (z = ±depth / 2) across the whole
// front and back, corners included, the left and right ones between them; a ceiling slab, if any,
// lies on them. Each wall is drawn in its own frame: u along it (left to right seen from inside), y
// up, v into the room from its inner face (wallPoint): side 0 the far wall, 1 the right, 2 the near,
// 3 the left. A wall holds its openings in slots of equal length along its inside: the door first (a
// doorway, or a door standing in it), then its windows; each window has a frame and glazing bars at
// the glass, a sill ledge (its stool and apron) inside, a casing round it and a stone sill outside.
// A skirting board runs along each wall's foot, broken at its door, and a coved cornice along its
// head under a ceiling.
import { castBox, type Cut, type Entry, Nearest } from "../joinery.ts";
import type { Vec3 } from "../../types.ts";

/** The room's measures, metres. */
export const ROOM = {
  /** The walls' thickness. */
  wall: 0.16,
  /** The floor slab's: its top stands this high over the room's base. */
  floor: 0.1,
  /** The ceiling slab's. */
  ceiling: 0.14,
  /** The least wall over an opening's head, and either side of it within its slot. */
  lintel: 0.15,
  margin: 0.15,
  /** A door's width and height. */
  door: [0.86, 2.04],
  /** The skirting board's height and how far it stands out of the wall. */
  skirting: [0.11, 0.018],
  /** The cornice's drop down the wall and reach across the ceiling. */
  cornice: [0.075, 0.055],
  /** A casing's (architrave's) width and how far it stands out of the wall. */
  casing: [0.065, 0.02],
  /** A window frame's face width and depth, round the glass. */
  frame: [0.05, 0.07],
  /** A glazing bar's width and depth. */
  bar: [0.03, 0.045],
  /** Where the glass stands in the wall: this share of its thickness out from its inner face. */
  glassAt: 0.55,
  /** The stool (the sill ledge inside): its thickness, how far it stands out of the wall, its ears past the opening. */
  stool: [0.035, 0.04, 0.085],
  /** The apron under the stool: its height and how far it stands out. */
  apron: [0.075, 0.016],
  /** The stone sill outside: how far it stands out of the wall and its thickness. */
  sill: [0.05, 0.05],
  /** A door leaf's thickness. */
  leaf: 0.04,
  /** How far trims reach out of the walls inside (the cornice, the stool) and outside (the sill). */
  inside: 0.06,
  outside: 0.05,
} as const;

/** What a ray met of the room (Hit.part in the GLSL; a door leaf adds its share across, 0..1). */
export const PIECE = {
  floor: 0,
  ceiling: 1,
  /** A wall's inner face. */
  inside: 2,
  /** A wall's outer face, ends and top. */
  outside: 3,
  /** A window's reveal: the wall's depth round it. */
  reveal: 4,
  /** A door's lining: the wall's depth round it, and its threshold. */
  lining: 5,
  skirting: 6,
  cornice: 7,
  /** A window's frame and glazing bars. */
  frame: 8,
  /** A window's stool and apron. */
  stool: 9,
  casing: 10,
  glass: 11,
  /** A window's stone sill outside. */
  sill: 12,
  leaf: 13,
  handle: 14,
} as const;

/** The wall materials, in the `wall` option's order. */
export const ROOM_WALLS = ["plaster", "papered", "shoji", "panelling", "brick"] as const;
/** The floor materials, in the `floor` option's order. */
export const ROOM_FLOORS = ["boards", "tiles", "carpet"] as const;
/** The glazing, in the `panes` option's order: mullions and transoms across the glass. */
export const ROOM_PANES = ["one pane", "four panes", "six panes"] as const;
/** The walls, in side order (wallPoint), and their options' key prefixes. */
export const ROOM_SIDES = ["far", "right", "near", "left"] as const;
/** A wall's door, in its `<side>Door` option's order. */
export const ROOM_DOORS = ["none", "doorway", "door"] as const;
/** Most windows a wall holds. */
export const ROOM_MAX_WINDOWS = 3;

/** The room's options as its shape reads them. */
export interface RoomValues {
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly ceiling: boolean;
  /** Per side (ROOM_SIDES): its window count and its door (ROOM_DOORS). */
  readonly windows: readonly number[];
  readonly doors: readonly number[];
  readonly windowWidth: number;
  readonly windowHeight: number;
  readonly sill: number;
  /** ROOM_PANES. */
  readonly panes: number;
  readonly glazed: boolean;
}

export function roomValues(options: Readonly<Record<string, number>>): RoomValues {
  return {
    width: options["width"] ?? 4,
    depth: options["depth"] ?? 4,
    height: options["height"] ?? 2.6,
    ceiling: (options["ceiling"] ?? 1) > 0.5,
    windows: ROOM_SIDES.map((side) => Math.round(options[`${side}Windows`] ?? 0)),
    doors: ROOM_SIDES.map((side) => Math.round(options[`${side}Door`] ?? 0)),
    windowWidth: options["windowWidth"] ?? 1,
    windowHeight: options["windowHeight"] ?? 1.3,
    sill: options["sill"] ?? 0.85,
    panes: Math.round(options["panes"] ?? 1),
    glazed: (options["glazed"] ?? 1) > 0.5,
  };
}

/** An opening in a wall, its frame: its centre along it and half its width, its foot and head (y). */
export interface Opening {
  readonly at: number;
  readonly half: number;
  readonly foot: number;
  readonly head: number;
  readonly door: boolean;
}

/** Whether side `s` runs across the room (the far and near walls, which hold the corners). */
const across = (s: number): boolean => s % 2 === 0;

/** Wall s's length inside, and half its length corners included. */
export function wallLength(room: RoomValues, s: number): readonly [inside: number, reach: number] {
  return across(s) ? [room.width, room.width / 2 + ROOM.wall] : [room.depth, room.depth / 2];
}

/**
 * Wall s's openings: n slots of equal length along its inside, the door (if any) in the first, the
 * windows in the rest, each centred in its slot and kept ROOM.margin from its ends, its head
 * ROOM.lintel under the ceiling. The GLSL's roomOpening is the same.
 */
export function wallOpenings(room: RoomValues, s: number): Opening[] {
  const door = (room.doors[s] ?? 0) > 0;
  const n = (room.windows[s] ?? 0) + (door ? 1 : 0);
  const [inside] = wallLength(room, s);
  const slot = inside / Math.max(n, 1);
  const space = Math.max(slot - 2 * ROOM.margin, 0.2);
  const top = ROOM.floor + room.height - ROOM.lintel;
  return Array.from({ length: n }, (_, k) => {
    const at = -inside / 2 + (k + 0.5) * slot;
    if (door && k === 0)
      return {
        at,
        half: Math.min(ROOM.door[0], space) / 2,
        foot: ROOM.floor,
        head: ROOM.floor + Math.min(ROOM.door[1], room.height - ROOM.lintel),
        door: true,
      };
    const foot = ROOM.floor + Math.min(room.sill, room.height - ROOM.lintel - 0.2);
    return {
      at,
      half: Math.min(room.windowWidth, space) / 2,
      foot,
      head: Math.min(foot + room.windowHeight, top),
      door: false,
    };
  });
}

/** A point of the room's frame in wall s's (u along it, y up, v into the room from its inner face). */
export function wallPoint(room: RoomValues, s: number, p: Vec3): Vec3 {
  const w = room.width / 2;
  const d = room.depth / 2;
  if (s === 0) return [p[0], p[1], d - p[2]];
  if (s === 1) return [-p[2], p[1], w - p[0]];
  if (s === 2) return [-p[0], p[1], p[2] + d];
  return [p[2], p[1], p[0] + w];
}

/** A direction of the room's frame in wall s's; its own inverse, so also a wall's back in the room's. */
export function wallDir(s: number, v: Vec3): Vec3 {
  if (s === 0) return [v[0], v[1], -v[2]];
  if (s === 1) return [-v[2], v[1], -v[0]];
  if (s === 2) return [-v[0], v[1], v[2]];
  return [v[2], v[1], v[0]];
}

/** The room's extent in its own frame: its walls and ceiling, the sills outside. */
export function roomBounds(room: RoomValues): { min: Vec3; max: Vec3 } {
  const w = room.width / 2 + ROOM.wall + ROOM.outside;
  const d = room.depth / 2 + ROOM.wall + ROOM.outside;
  const top = ROOM.floor + room.height + (room.ceiling ? ROOM.ceiling : 0);
  return { min: [-w, 0, -d], max: [w, top, d] };
}

/** The piece of a window's or a door's trims a ray meets in wall s's frame, into `near`. */
function trims(
  room: RoomValues,
  s: number,
  q: Opening,
  ro: Vec3,
  rd: Vec3,
  from: number,
  near: Nearest,
  glass: boolean,
): void {
  const T = ROOM.wall;
  const [cw, cd] = ROOM.casing;
  const box = (lo: Vec3, hi: Vec3, piece: number, cut?: Cut): boolean =>
    near.take(castBox(lo, hi, ro, rd, from, near.t, cut), piece);
  const l = q.at - q.half;
  const r = q.at + q.half;
  if (q.door) {
    for (const [v0, v1] of [
      [0, cd],
      [-T - cd, -T],
    ] as const) {
      box([l - cw, q.foot, v0], [l, q.head + cw, v1], PIECE.casing);
      box([r, q.foot, v0], [r + cw, q.head + cw, v1], PIECE.casing);
      box([l - cw, q.head, v0], [r + cw, q.head + cw, v1], PIECE.casing);
    }
    if ((room.doors[s] ?? 0) < 2) return;
    const mid = -T / 2;
    const half = ROOM.leaf / 2;
    if (
      box(
        [l + 0.004, q.foot + 0.008, mid - half],
        [r - 0.004, q.head - 0.003, mid + half],
        PIECE.leaf,
      )
    )
      near.piece += Math.min(Math.max((ro[0] + rd[0] * near.t - l) / (r - l), 0), 0.999);
    box(
      [r - 0.17, q.foot + 0.975, mid + half],
      [r - 0.055, q.foot + 0.995, mid + half + 0.06],
      PIECE.handle,
    );
    box(
      [r - 0.17, q.foot + 0.975, mid - half - 0.06],
      [r - 0.055, q.foot + 0.995, mid - half],
      PIECE.handle,
    );
    return;
  }
  const [fw, fd] = ROOM.frame;
  const [bw, bd] = ROOM.bar;
  const g = -ROOM.glassAt * T;
  const f0 = g - fd / 2;
  const f1 = g + fd / 2;
  box([l, q.foot, f0], [l + fw, q.head, f1], PIECE.frame);
  box([r - fw, q.foot, f0], [r, q.head, f1], PIECE.frame);
  box([l, q.foot, f0], [r, q.foot + 1.3 * fw, f1], PIECE.frame);
  box([l, q.head - fw, f0], [r, q.head, f1], PIECE.frame);
  const u0 = l + fw;
  const u1 = r - fw;
  const y0 = q.foot + 1.3 * fw;
  const y1 = q.head - fw;
  const mullions = room.panes;
  for (let i = 0; i < mullions; i++) {
    const u = u0 + ((i + 1) / (mullions + 1)) * (u1 - u0);
    box([u - bw / 2, y0, g - bd / 2], [u + bw / 2, y1, g + bd / 2], PIECE.frame);
  }
  if (room.panes > 0) {
    const y = y0 + 0.62 * (y1 - y0);
    box([u0, y - bw / 2, g - bd / 2], [u1, y + bw / 2, g + bd / 2], PIECE.frame);
  }
  if (glass && room.glazed && Math.abs(rd[2]) > 1e-12) {
    const t = (g - ro[2]) / rd[2];
    const u = ro[0] + rd[0] * t;
    const y = ro[1] + rd[1] * t;
    if (t >= from && u > u0 && u < u1 && y > y0 && y < y1)
      near.take({ t, normal: [0, 0, rd[2] < 0 ? 1 : -1] }, PIECE.glass);
  }
  const [st, out, ear] = ROOM.stool;
  box([l - ear, q.foot + 0.015 - st, f1], [r + ear, q.foot + 0.015, out], PIECE.stool);
  const under = q.foot + 0.015 - st;
  box(
    [l - cw + 0.005, under - ROOM.apron[0], 0],
    [r + cw - 0.005, under, ROOM.apron[1]],
    PIECE.stool,
  );
  box([l - cw, q.foot + 0.015, 0], [l, q.head + cw, cd], PIECE.casing);
  box([r, q.foot + 0.015, 0], [r + cw, q.head + cw, cd], PIECE.casing);
  box([l - cw, q.head, 0], [r + cw, q.head + cw, cd], PIECE.casing);
  box(
    [l - 0.04, q.foot - ROOM.sill[1], -T - ROOM.sill[0]],
    [r + 0.04, q.foot + 0.005, f0],
    PIECE.sill,
  );
}

/** Wall s and all it holds against the ray ro + rd t of its frame, into `near` (its frame's normal). */
function wall(
  room: RoomValues,
  s: number,
  ro: Vec3,
  rd: Vec3,
  from: number,
  near: Nearest,
  glass: boolean,
): void {
  const T = ROOM.wall;
  const top = ROOM.floor + room.height;
  const [inside, reach] = wallLength(room, s);
  // Whether the ray crosses the box lo..hi between from and the nearest hit so far.
  const crosses = (lo: Vec3, hi: Vec3): boolean => {
    const box = span(lo, hi, ro, rd);
    return box !== undefined && box.far >= from && box.near < near.t;
  };
  if (!crosses([-reach, 0, -T - ROOM.outside], [reach, top, ROOM.inside])) return;
  const openings = wallOpenings(room, s);
  // The wall itself: its box less the openings' prisms.
  const solid = span([-reach, 0, -T], [reach, top, 0], ro, rd);
  const enter = Math.max(solid?.near ?? Infinity, from);
  if (solid !== undefined && enter <= solid.far && enter < near.t) {
    const e: Vec3 = [ro[0] + rd[0] * enter, ro[1] + rd[1] * enter, ro[2] + rd[2] * enter];
    const hole = openings.find(
      (q) => Math.abs(e[0] - q.at) < q.half && e[1] > q.foot && e[1] < q.head,
    );
    if (hole === undefined) {
      const normal: Vec3 = solid.near >= from ? solid.normal : [-rd[0], -rd[1], -rd[2]];
      near.take({ t: enter, normal }, normal[2] > 0.5 ? PIECE.inside : PIECE.outside);
    } else {
      // Through the opening: out of its prism by a side (its reveal), or out of the wall.
      const exit = (lo: number, hi: number, o: number, d: number): number =>
        Math.abs(d) < 1e-12 ? Infinity : Math.max((lo - o) / d, (hi - o) / d);
      const tu = exit(hole.at - hole.half, hole.at + hole.half, ro[0], rd[0]);
      const ty = exit(hole.foot, hole.head, ro[1], rd[1]);
      const t = Math.min(tu, ty);
      if (t < solid.far)
        near.take(
          { t, normal: t === tu ? [rd[0] < 0 ? 1 : -1, 0, 0] : [0, rd[1] < 0 ? 1 : -1, 0] },
          hole.door ? PIECE.lining : PIECE.reveal,
        );
    }
  }
  // The skirting along its foot, broken at its door; the cornice along its head under a ceiling.
  const [sh, sd] = ROOM.skirting;
  const skirting = castBox(
    [-inside / 2, ROOM.floor, 0],
    [inside / 2, ROOM.floor + sh, sd],
    ro,
    rd,
    from,
    near.t,
  );
  const door = openings.find((q) => q.door);
  if (
    skirting !== undefined &&
    (door === undefined ||
      Math.abs(ro[0] + rd[0] * skirting.t - door.at) >= door.half + ROOM.casing[0])
  )
    near.take(skirting, PIECE.skirting);
  if (room.ceiling) {
    const [ch, cd] = ROOM.cornice;
    const cove: Cut = [0, -1 / ch, 1 / cd, 1 - top / ch];
    near.take(
      castBox([-inside / 2, top - ch, 0], [inside / 2, top, cd], ro, rd, from, near.t, cove),
      PIECE.cornice,
    );
  }
  const margin = ROOM.stool[2] + 0.01;
  for (const q of openings)
    if (
      crosses(
        [q.at - q.half - margin, q.foot - 0.12, -T - ROOM.outside],
        [q.at + q.half + margin, q.head + ROOM.casing[0] + 0.01, ROOM.inside],
      )
    )
      trims(room, s, q, ro, rd, from, near, glass);
}

/** Where the ray ro + rd t is inside the box lo..hi (any t), and the normal of the face it enters by. */
function span(
  lo: Vec3,
  hi: Vec3,
  ro: Vec3,
  rd: Vec3,
): { near: number; far: number; normal: Vec3 } | undefined {
  const entry = castBox(lo, hi, ro, rd, -Infinity, Infinity);
  if (entry === undefined) return undefined;
  let far = Infinity;
  for (let k = 0; k < 3; k++) {
    const d = rd[k] ?? 0;
    if (Math.abs(d) < 1e-12) continue;
    const o = ro[k] ?? 0;
    far = Math.min(far, Math.max(((lo[k] ?? 0) - o) / d, ((hi[k] ?? 0) - o) / d));
  }
  return { near: entry.t, far, normal: entry.normal };
}

/**
 * Where the ray ro + rd t of the room's frame first meets it with t in span: the floor, the ceiling,
 * each wall and all it holds; the glass too where `glass`, else rays pass through it as through an
 * open window. Its normal is the room's frame's, its piece what it met (PIECE).
 */
export function castRoom(
  room: RoomValues,
  ro: Vec3,
  rd: Vec3,
  [from, to]: readonly [number, number],
  glass: boolean,
): (Entry & { readonly piece: number }) | undefined {
  const near = new Nearest(to);
  const w = room.width / 2;
  const d = room.depth / 2;
  near.take(castBox([-w, 0, -d], [w, ROOM.floor, d], ro, rd, from, near.t), PIECE.floor);
  if (room.ceiling) {
    const top = ROOM.floor + room.height;
    const T = ROOM.wall;
    near.take(
      castBox([-w - T, top, -d - T], [w + T, top + ROOM.ceiling, d + T], ro, rd, from, near.t),
      PIECE.ceiling,
    );
  }
  for (let s = 0; s < ROOM_SIDES.length; s++) {
    const before = near.t;
    wall(room, s, wallPoint(room, s, ro), wallDir(s, rd), from, near, glass);
    if (near.t < before) near.normal = wallDir(s, near.normal);
  }
  return near.piece < 0 ? undefined : { t: near.t, normal: near.normal, piece: near.piece };
}
