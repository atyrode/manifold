// What the Tiny island preset and its layer manifests (index.ts, layers.ts) share with its GLSL
// (shader.ts), without loading it: the rig the island is seen through, the light it is graded by,
// where the World's birds and shooting stars would fly, and where the island stands under another
// rig. The island is built in units of its own, ISLAND_METRES metres each; the composer's depths are
// metres.
import type { Flyway, Grade, MeteorField, Rig } from "../../composer/types.ts";

/** Seconds of the island's entrance (the camera swoops down, the gull glides in) and exit (the camera lifts away) (SceneDef.passage). */
export const ISLAND_PASSAGE = { enter: 2.8, exit: 1.5 } as const;

/** Metres in one of the island's units (its cottage is a little over one wide). */
export const ISLAND_METRES = 2.2;

/**
 * The island's own camera at rest, as the composer's rig: pitched 20 degrees down over the sea, its
 * lens shifted so the horizon stands at 66% of the frame, focal 1.2, the eye 1.88 units (4.14 m)
 * over the sea on a frame at least 1.65 wide; it backs away and up on a narrower one rather than
 * cropping it, and swoops through the passage (the sky over the sea's begin, shader.ts, which hands
 * the World its ray). Turned 2.2 rad from the sky's frame, so the sun climbs over the left shoulder
 * and sets behind the eye; the sky over the sea stages the World's sky in the rig's frame, so its
 * cloud deck lies over the sea as the island's always did.
 */
export const ISLAND_RIG: Rig = {
  horizon: 0.66,
  focal: 1.2,
  eye: 4.14,
  turn: -2.2,
  pitch: 0.349066,
  minAspect: 1.65,
};

/** The island's light is the World's sky as it is (its layers light themselves by it); its ink is its own. */
export const ISLAND_GRADE: Grade = { exposure: 1, ink: { gain: 1.15, gamma: 1 } };

/**
 * The World's birds over the island, should they be switched on (the preset opens with them off: its
 * own gull circles it), over the baseline's flyway: 8 to 60 m out, cruising from just over the
 * horizon to the top of the frame.
 */
export const ISLAND_FLYWAY: Partial<Flyway> = { depth: [8, 60], above: 0.03 };

/** Where shooting stars set out: skyAngles of the rig's ray, high over the sea. */
export const ISLAND_METEORS: MeteorField = [-0.3, 0.12, 0.6, 0.1];

/**
 * Where the island stands under a level rig that offers it (the open sea's): across and ahead of the
 * eye's foot (m), right of the moon's path at the swell's hour, and the metres in one of its units
 * there: its cottage at a cottage's true size (3 m wide), the island some 30 m across, so it reads
 * from the swell's 15 m eye. Under its own camera the island keeps its toy scale (ISLAND_METRES).
 */
export const ISLAND_OFFSHORE = { across: 32, ahead: 220, metres: 6 } as const;
