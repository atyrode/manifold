// The shipped documents. Three bare canvases, the plainest land, an empty room and a view straight
// down (on spheres), the Library's baselines (lab/gallery-model.ts); and examples of the kinds, which the Library does
// not show: the bench's pictures (bench.ts) and the tests' worlds, a lava lamp on a plinth at night,
// a pond seen from its shore, a grove of trees in the grass, and the lava scene's room rebuilt with
// its lava lamp. The canvas scene opens on `land`.
import { groundHeight } from "./kinds/ground/height.ts";
import { WATER_LIFT } from "./kinds/water/index.ts";
import { ROOM } from "./kinds/room/shape.ts";
import type { EngineDoc, Placed, Vec3 } from "./types.ts";

const place = (
  id: string,
  kind: string,
  at: Vec3,
  options: Readonly<Record<string, number>>,
  yaw = 0,
): Placed => ({ id, kind, at, yaw, scale: 1, options });

/** An eye standing in an open field under the World's sky. */
export const landDoc: EngineDoc = {
  v: 1,
  title: "Land",
  camera: { at: [0, 1.65, 0], yaw: 0, pitch: -0.04, fov: 0.95 },
  world: {},
  objects: [place("ground", "ground", [0, 0, 0], { relief: 12, spread: 320, material: 0 })],
};

/**
 * An empty room, a true canvas: plaster walls, a boarded floor, a window in the far wall, the World's
 * afternoon coming in through it, and the eye standing by the near wall. Everything else is added.
 */
export const roomDoc: EngineDoc = {
  v: 1,
  title: "Room",
  camera: { at: [0, 1.6, -1.55], yaw: 0, pitch: -0.12, fov: 1.15 },
  world: { time: 0.62 },
  objects: [
    place("ground", "ground", [0, 0, 0], { relief: 0, material: 1 }),
    place("room", "room", [0, -ROOM.floor, 0], {}),
  ],
};

/** The ground the spheres of `topDoc` rest on, and a sphere resting on it at x, z. */
const TOP_GROUND = { relief: 3, spread: 160, material: 0 } as const;
const ball = (id: string, x: number, z: number, options: Readonly<Record<string, number>>) =>
  place(id, "sphere", [x, groundHeight(x, z, TOP_GROUND.relief, TOP_GROUND.spread), z], options);

/** Straight down from 22 m on spheres in the grass: matte, glossy and mirrors. */
export const topDoc: EngineDoc = {
  v: 1,
  title: "From above",
  camera: { at: [0, 22, 0], yaw: 0, pitch: -Math.PI / 2, fov: 0.9 },
  world: {},
  objects: [
    place("ground", "ground", [0, 0, 0], TOP_GROUND),
    ball("red", -4, 2, { radius: 1, material: 0, hue: 0.01, tone: 0.7 }),
    ball("mirror", 3, -2, { radius: 1.5, material: 2, hue: 0.6, tone: 0.9 }),
    ball("blue", 0.5, 4, { radius: 0.6, material: 1, hue: 0.62, tone: 0.65 }),
    ball("yellow", 5, 4.5, { radius: 0.8, material: 0, hue: 0.14, tone: 0.8 }),
    ball("green", -3, -4, { radius: 1.2, material: 1, hue: 0.33, tone: 0.55 }),
  ],
};

/** The plinth the lava lamp of `lavaLampDoc` stands on: its top's height, and where it stands. */
const PLINTH = { height: 0.9, at: [0, 0, 1.6] as const };

/**
 * The lava scene's lamp out of its room: on a timber plinth on the grass at night under the moon,
 * its glow on the plinth's top round the shadow of its base, the eye stood a pace off.
 */
export const lavaLampDoc: EngineDoc = {
  v: 1,
  title: "Lava lamp",
  camera: { at: [0.32, 1.22, 0.4], yaw: 0.26, pitch: -0.17, fov: 0.62 },
  world: { time: 0.94 },
  objects: [
    place("ground", "ground", [0, 0, 0], { relief: 0, material: 0 }),
    place("plinth", "block", PLINTH.at, {
      width: 0.38,
      height: PLINTH.height,
      depth: 0.38,
      material: 1,
    }),
    place("lava", "lavaLamp", [PLINTH.at[0], PLINTH.height, PLINTH.at[2]], {
      wax: 0.01,
      liquid: 0.11,
      heat: 0.6,
      size: 0.42,
    }),
  ],
};

/** The land round the pond of `pondDoc`: low, broad swells, the pond in the bottom of one. */
const POND_GROUND = { relief: 6, spread: 900, material: 0 } as const;
const pondGround = (x: number, z: number) =>
  groundHeight(x, z, POND_GROUND.relief, POND_GROUND.spread);
/** The pond's middle, at the bottom of the hollow, and its waterline. */
const POND: Vec3 = [32, pondGround(32, 150) + 0.01, 150];
const WATERLINE = POND[1] + WATER_LIFT;
/** A post of the jetty at x, z, from half a metre under the water up to its deck. */
const post = (id: string, x: number, z: number) =>
  place(id, "block", [x, WATERLINE - 0.5, z], {
    width: 0.12,
    height: 0.78,
    depth: 0.12,
    material: 1,
  });

/**
 * A kidney-shaped pond with a sandy bed in a hollow of the land, a timber jetty reaching into it
 * from the far shore with a lamp at its end, boulders on its bank; the eye stands on the near shore
 * in the afternoon, looking toward the sun over the water, a light wind ruffling it.
 */
export const pondDoc: EngineDoc = {
  v: 1,
  title: "Pond side",
  camera: { at: [37.2, pondGround(37.2, 149.2) + 1.65, 149.2], yaw: 1.22, pitch: -0.17, fov: 0.95 },
  world: { time: 0.66, wind: 0.25 },
  objects: [
    place("ground", "ground", [0, 0, 0], POND_GROUND),
    // Its dent toward the eye: turned a quarter, its width runs along z.
    place(
      "pond",
      "water",
      POND,
      { shape: 2, width: 14, length: 10, depth: 1.2, bed: 0, clarity: 0.6, tint: 0.45, ice: 0 },
      Math.PI / 2,
    ),
    place("jetty", "block", [28.6, WATERLINE + 0.28, 153], {
      width: 4.6,
      height: 0.1,
      depth: 1.2,
      material: 1,
    }),
    post("post-1", 30.6, 152.5),
    post("post-2", 30.6, 153.5),
    post("post-3", 29.3, 152.5),
    post("post-4", 29.3, 153.5),
    place("lamp", "lamp", [30.5, WATERLINE + 0.38, 153.4], {
      height: 1.1,
      power: 1.5,
      warmth: 0.8,
    }),
    place("boulder", "sphere", [28.5, pondGround(28.5, 143.5) - 0.25, 143.5], {
      radius: 0.6,
      material: 0,
      hue: 0.08,
      tone: 0.45,
    }),
    place("stone", "sphere", [29.8, pondGround(29.8, 142.8) - 0.1, 142.8], {
      radius: 0.3,
      material: 0,
      hue: 0.1,
      tone: 0.5,
    }),
  ],
};

/** The land the grove's trees and grass stand on, and a thing of `kind` standing on it at x, z. */
const GROVE_GROUND = { relief: 6, spread: 260, material: 0 } as const;
const onGrove = (
  id: string,
  kind: string,
  x: number,
  z: number,
  options: Readonly<Record<string, number>>,
  yaw = 0,
) =>
  place(
    id,
    kind,
    [x, groundHeight(x, z, GROVE_GROUND.relief, GROVE_GROUND.spread), z],
    options,
    yaw,
  );

/**
 * A grove late on a gusty afternoon in late summer: an oak, two birches turning, a pine and a
 * windswept pine on the land, long grass round them with wildflowers through it, the gusts crossing
 * it in waves.
 */
export const groveDoc: EngineDoc = {
  v: 1,
  title: "Grove",
  camera: {
    at: [0.5, groundHeight(0.5, 0, GROVE_GROUND.relief, GROVE_GROUND.spread) + 1.65, 0],
    yaw: 0.06,
    pitch: -0.06,
    fov: 0.95,
  },
  world: { time: 0.68, wind: 0.55, gusts: 1, "gusts-amount": 0.85, gustRate: 0.65 },
  objects: [
    place("ground", "ground", [0, 0, 0], GROVE_GROUND),
    onGrove("oak", "tree", 1, 20, { species: 0, height: 9, spread: 10, seed: 3, season: 0.42 }),
    onGrove("birch", "tree", -7.5, 15, { species: 1, height: 10, spread: 4, seed: 5, season: 0.5 }),
    onGrove("birch-far", "tree", -10.5, 21, {
      species: 1,
      height: 8.5,
      spread: 3.5,
      seed: 11,
      season: 0.56,
    }),
    onGrove("pine", "tree", 9.5, 25, { species: 2, height: 12, spread: 5, seed: 2 }),
    onGrove("windswept", "tree", 5.5, 11, { species: 3, height: 3.6, spread: 4.5, seed: 7 }),
    onGrove("meadow", "grass", 0, 7, {
      width: 12,
      depth: 10,
      height: 0.45,
      density: 0.8,
      flowers: 0.22,
    }),
    onGrove("under-oak", "grass", 0, 18, {
      width: 16,
      depth: 10,
      height: 0.3,
      density: 0.7,
      flowers: 0.08,
      dry: 0.25,
    }),
    onGrove("rough", "grass", 10, 14, {
      width: 8,
      depth: 9,
      height: 0.6,
      density: 0.65,
      flowers: 0.1,
      dry: 0.4,
    }),
  ],
};

/** The lava room's ground, near level round it, and the room's measures inside. */
const LAVA_GROUND = { relief: 0.6, spread: 800, material: 0 } as const;
const LAVA_ROOM = { width: 3.6, depth: 4.4, height: 2.6 } as const;
/**
 * The room's turn: its windows in the left wall face the World's moon at midnight (due ahead of the
 * world, 30 degrees up), so its light comes in 35 degrees off the room's axis and lays a pane of
 * moonlight on the far wall left of the lamp.
 */
const LAVA_YAW = (-145 * Math.PI) / 180;
/** Its floor's top: a centimetre over the highest ground under it, so the land never shows through. */
const LAVA_FLOOR =
  Math.max(
    ...[-1, 0, 1].flatMap((sx) =>
      [-1, 0, 1].map((sz) => {
        const x = sx * (LAVA_ROOM.width / 2 + ROOM.wall);
        const z = sz * (LAVA_ROOM.depth / 2 + ROOM.wall);
        const c = Math.cos(LAVA_YAW);
        const s = Math.sin(LAVA_YAW);
        return groundHeight(c * x - s * z, s * x + c * z, LAVA_GROUND.relief, LAVA_GROUND.spread);
      }),
    ),
  ) + 0.01;

/** A point of the lava room's frame (x across, y up from its floor's top, z toward its far wall) in the world's. */
function inLavaRoom(x: number, y: number, z: number): Vec3 {
  const c = Math.cos(LAVA_YAW);
  const s = Math.sin(LAVA_YAW);
  return [c * x - s * z, LAVA_FLOOR + y, s * x + c * z];
}

/** Where the sideboard stands against the far wall, and the lamp on it 0.27 m out from the wall. */
const SIDEBOARD_AT = { x: -0.6, z: LAVA_ROOM.depth / 2 - 0.245, top: 0.75 } as const;
const LAMP_AT = { x: -0.8, z: LAVA_ROOM.depth / 2 - 0.27 } as const;

/**
 * The lava lamp's room (src/scenes/lava) rebuilt: papered walls and a rust carpet, a teak sideboard
 * against the far wall with the lava lamp on it, two windows in the left wall
 * letting the midnight moon in, a shelf on that wall in the far corner, a table under the windows,
 * and behind the eye the door and a window that takes the noon sun; the eye level 0.25 m over the
 * sideboard's top and 1.28 m from the lamp, the lamp right of the middle, as the scene's rig stands.
 */
export const lavaRoomDoc: EngineDoc = {
  v: 1,
  title: "Lava room",
  camera: {
    at: inLavaRoom(LAMP_AT.x - 0.11, SIDEBOARD_AT.top + 0.248, LAMP_AT.z - 1.28),
    yaw: LAVA_YAW,
    pitch: -0.037,
    fov: 0.405,
  },
  world: { time: 0 },
  objects: [
    place("ground", "ground", [0, 0, 0], LAVA_GROUND),
    place(
      "room",
      "room",
      inLavaRoom(0, -ROOM.floor, 0),
      {
        ...LAVA_ROOM,
        wall: 1,
        tint: 0.07,
        tone: 0.36,
        floor: 2,
        floorTone: 0.35,
        trim: 0.15,
        ceiling: 1,
        farWindows: 0,
        nearWindows: 1,
        nearDoor: 2,
        leftWindows: 2,
        windowWidth: 0.8,
        windowHeight: 1,
        sill: 1.25,
        panes: 1,
      },
      LAVA_YAW,
    ),
    place(
      "sideboard",
      "sideboard",
      inLavaRoom(SIDEBOARD_AT.x, 0, SIDEBOARD_AT.z),
      { width: 1.8, depth: 0.45, height: SIDEBOARD_AT.top, tone: 0.45 },
      LAVA_YAW + Math.PI,
    ),
    place(
      "lava",
      "lavaLamp",
      inLavaRoom(LAMP_AT.x, SIDEBOARD_AT.top, LAMP_AT.z),
      { wax: 0.01, liquid: 0.11, heat: 0.6, size: 0.42 },
      LAVA_YAW,
    ),
    place(
      "shelf",
      "shelf",
      inLavaRoom(-LAVA_ROOM.width / 2 + 0.11, 1.5, LAVA_ROOM.depth / 2 - 0.3),
      { width: 0.5, depth: 0.22, tone: 0.45 },
      LAVA_YAW - Math.PI / 2,
    ),
    place(
      "table",
      "table",
      inLavaRoom(-1.35, 0, -1.1),
      { width: 0.7, depth: 1.1, height: 0.72, tone: 0.4 },
      LAVA_YAW,
    ),
  ],
};

/** The bare canvases a setup starts from: the land, an empty room, the view from above. */
export const canvasDocs: readonly EngineDoc[] = [landDoc, roomDoc, topDoc];

/** Examples of the kinds, for the bench and the tests (see the header). */
export const exampleDocs: readonly EngineDoc[] = [lavaRoomDoc, lavaLampDoc, pondDoc, groveDoc];
