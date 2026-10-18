// What the City crossing preset and its layer manifests (index.ts, layers.ts) share with its GLSL and
// sim (shader.ts, sim.ts), without loading them: the high window the crossing is seen from and the
// rig it is, the passage that tilts it, the light guest layers take, the World's birds over it and
// what the street's life keeps in the composer's shared resources.
import type { Flyway, Grade, Rig } from "../../composer/types.ts";

/**
 * Seconds the entrance and the exit take (SceneDef.passage). The window's pitch eases the same tilt
 * from passageIn() and passageOut() (shader.ts streetTiltAt): keep passageTilt (sim.ts) and its GLSL
 * twin in step.
 */
export const STREET_PASSAGE = { enter: 2.8, exit: 1.5 } as const;

/**
 * The eye: x (m), height (m), pitch below the horizontal (rad, 42°), focal length (screen heights per
 * unit of slope: a 37° vertical field of view). The window is a little left of the side street, so
 * the crossing sits right of centre and the lower left (the page's copy) looks down the quieter
 * avenue with its queue of cars.
 */
export const CAM_X = -5;
export const CAM_H = 28;
export const PITCH = 0.733;
export const FOCAL = 1.5;

/**
 * How far the window's pitch is raised (rad, 31.5°) when the entrance starts, with the skyline in
 * view and the crossing below the frame, and where the exit ends; the share of the entrance the
 * camera takes to come down and settle.
 */
export const TILT_IN = 0.55;
export const TILT_OUT = 0.55;
export const TILT_ARRIVE = 0.8;

/**
 * The street's rig: the window's pinhole CAM_H metres over the street, pitched PITCH down, facing the
 * sky's own frame (the sky has always stood in the street's frame). Its horizon is where the level
 * horizon would stand on the screen, far over the frame's top edge (0.5 + FOCAL tan PITCH). Nothing
 * is laid out across the frame's width, so it has no stage. Its passage is the window's tilt, which
 * the city's begin turns the rig's ray by (shader.ts streetTiltAt, cityBegin): it moves no eye and
 * shifts no lens, so the rig takes no passage of the composer's own.
 */
export const STREET_RIG: Rig = {
  horizon: 0.5 + FOCAL * Math.tan(PITCH),
  focal: FOCAL,
  eye: CAM_H,
  turn: 0,
  pitch: PITCH,
  minAspect: 1,
};

/**
 * The light the plain floor and any guest take: the World's sky as it is, the street's ink. The
 * street's own layers keep the street's light (shader.ts streetHour): its warm city bounce at night,
 * its own grey day under rain or snow.
 */
export const STREET_GRADE: Grade = { ink: { gain: 1.3, gamma: 0.8 } };

/**
 * The World's birds over the street: flights 60 to 400 metres out above the horizon, which the window
 * pitched down never shows at rest (only the passage's tilt brings the skyline into view).
 */
export const STREET_FLYWAY: Flyway = {
  depth: [60, 400],
  above: 0.03,
  top: 0.95,
  seed: 4.7,
  skim: 1e9,
  spread: 1.5,
  ext: 1 / 1500,
};

/** Where the shooting stars set out (skyAngles): low over the skyline the passage tilts up to. */
export const STREET_METEORS = [-0.5, 0.05, 1.0, 0.12] as const;

/**
 * What the street's life keeps in the composer's shared resources (LayerDef.data): three rows of the
 * records atlas (the walkers' and vehicles' slots in two, the signals' lamps in the third) and a field
 * slot for the tile lists (sim.ts).
 */
export const STREET_DATA = { streetLife: { rows: 3, fields: 1 } } as const;
