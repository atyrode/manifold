// The starter documents: the plainest land, a room built of blocks with a lamp in it, and a view
// straight down on spheres. The canvas scene opens on `land`.
import { groundHeight } from "./kinds/ground/height.ts";
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

/** A wall of the room: a block `width` across, `depth` front to back, standing at x, z. */
const wall = (
  id: string,
  x: number,
  z: number,
  width: number,
  depth: number,
  y = 0,
  height = 2.6,
) => place(id, "block", [x, y, z], { width, height, depth, material: 2 });

/**
 * Four walls of stone on bare earth, open to the sky, a window in the far one, a lamp lit in the
 * corner, and the eye standing inside by the near wall.
 */
export const roomDoc: EngineDoc = {
  v: 1,
  title: "Room",
  camera: { at: [0, 1.6, 0.8], yaw: 0.12, pitch: -0.06, fov: 1.15 },
  world: { time: 0.7 },
  objects: [
    place("ground", "ground", [0, 0, 0], { relief: 0, material: 1 }),
    wall("far-left", -1.7, 6, 1.8, 0.2),
    wall("far-right", 1.7, 6, 1.8, 0.2),
    wall("sill", 0, 6, 1.6, 0.2, 0, 0.9),
    wall("lintel", 0, 6, 1.6, 0.2, 2.1, 0.5),
    wall("left", -2.5, 3, 0.2, 6.2),
    wall("right", 2.5, 3, 0.2, 6.2),
    wall("near", 0, 0, 5.2, 0.2),
    place("lamp", "lamp", [1.6, 0, 4.6], { height: 1.3, power: 2, warmth: 0.75 }),
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

/** The starter documents by name. */
export const starterDocs: Readonly<Record<string, EngineDoc>> = {
  land: landDoc,
  "room-demo": roomDoc,
  top: topDoc,
};
