// The constants Countryside's preset and its layer manifests (index.ts, layers.ts) share with its
// code (shader.ts, season.ts, murmuration.ts, verges.ts, sim.ts), kept apart from that code so that
// the scene registry loads without it (SceneDef.code): the hill's rig and its passage, the light,
// the World's birds and shooting stars over the valley, and what the valley keeps in the composer's
// shared resources.
import type { Flyway, Grade, MeteorField, Rig } from "../../composer/types.ts";
import { counts, feature } from "../../params.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { FLOCK_SIZES } from "../flock/constants.ts";
import { COUNTRY_CAMERA } from "./camera.ts";

/** Seconds of the entrance (the camera comes down out of the sky and settles) and exit. */
export const COUNTRY_PASSAGE = { enter: 2.8, exit: 1.4 } as const;

/**
 * The vantage's eye over its hilltop (m): the terrain's own (sims/terrain.ts TerrainOptions.vantage,
 * 30 m up), which the valley's march starts from (terrainEye); the rig's eye, for the World's birds
 * and the layers' camera ranges (a standing eye's layers are not offered on the hill).
 */
export const COUNTRY_EYE = 30;

/** How far the passage lifts the eye at the passage's full lift (m): it comes down out of the sky. */
const COUNTRY_LIFT = 220;

/**
 * The hill's rig: the countryside's level pinhole (camera.ts: the horizon high on the screen, a field
 * a little long) at the vantage, facing down the map's diagonal; the sky's frame is its own (turn
 * 0). Its passage is the old camera's: arriving, it is already on its way down out of the sky and
 * settles (ease-out), tilting down onto the valley (the lens shift) as the eye eases down; leaving,
 * it rises back toward the clouds, gathering speed to the end (ease-in). Exactly 0 at rest.
 */
export const COUNTRY_RIG: Rig = {
  horizon: COUNTRY_CAMERA.horizon,
  focal: COUNTRY_CAMERA.focal,
  eye: COUNTRY_EYE,
  turn: 0,
  pitch: 0,
  minAspect: 1,
  passage: {
    lift: (enter, exit) => {
      const arrive = (1 - enter) * (1 - enter);
      const leave = exit * exit;
      return COUNTRY_LIFT * (arrive * arrive + 0.6 * leave * leave);
    },
    shift: true,
    glsl: `
// ---- the countryside's passage: down out of the sky and back up (country/constants.ts) ----
// How far the camera has still to come down (1 as the entrance starts, an ease-out to 0) and how far
// it has risen leaving (0 at rest, an ease-in).
float countryArrive() {
  return (1.0 - passageIn()) * (1.0 - passageIn());
}

float countryLeave() {
  return passageOut() * passageOut();
}

// The eye's lift as a share of its full lift, 0 at rest.
float countryLift() {
  float arrive = countryArrive();
  float leave = countryLeave();
  return arrive * arrive + 0.6 * leave * leave;
}

float rigLift() {
  return ${glslFloat(COUNTRY_LIFT)} * countryLift();
}

float rigCut() {
  return 0.0;
}

// The lens's vertical shift in screen heights (the world read that much lower in uv), 0 at rest.
float rigShift() {
  return 0.34 * countryArrive() + 0.3 * countryLeave();
}
`,
  },
};

/** The countryside's light: the World's sky as it is, no tint; its picture clamped; its ink. */
export const COUNTRY_GRADE: Grade = { exposure: 1, ink: { gain: 1.1, gamma: 1 } };

/**
 * The World's birds over the valley (the countryside's own until ADR 0062 Phase 2c): flights 90 to
 * 2400 m out, from just over the horizon to near the top of the frame, a swooping party coming down to
 * 5 m over the ground (25 m under the eye), drawn three times life size, fading into the valley's haze
 * by 1 / 5200 a metre.
 */
export const COUNTRY_FLYWAY: Flyway = {
  depth: [90, 2400],
  above: 0.03,
  top: 0.93,
  seed: 3.1,
  skim: COUNTRY_EYE - 25,
  spread: 3,
  ext: 1 / 5200,
};

/** Where the shooting stars set out (skyAngles): high over the far ridges, ahead and to the right. */
export const COUNTRY_METEORS: MeteorField = [-0.4, 0.2, 1.0, 0.25];

/**
 * What the valley keeps in the composer's shared resources (LayerDef.data): its four textures in field
 * slots (sim.ts: the ground, the cover, the parcels, the records atlas).
 */
export const COUNTRY_DATA = { valley: { fields: 4 } } as const;

/** The farming year's keys (year positions): the land exactly as the old season choice showed it. */
export const COUNTRY_SEASONS = { summer: 0.375, harvest: 0.47, autumn: 0.6 } as const;

/** The year from the first round bale dropped on a cut barley field to the last one carted away. */
export const COUNTRY_BALES = [0.418, 0.497] as const;

/** The starlings layer's switch: the murmuration feature, its amount how many starlings. */
export const countryStarlingsKnob = feature(
  "birds",
  "starlings",
  "murmuration",
  false,
  "starlings",
  3000,
  "A starling murmuration wheeling over the far fields, from late afternoon until it goes down to roost at dusk (set the time of day near sunset to see it): the valley's sides hide it where it dips below them, the wind carries it, and steady rain keeps it away, as does the nesting season from mid-spring to early summer. The amount is how many starlings: more make a darker cloud.",
  { options: counts(...FLOCK_SIZES) },
);

/** The verges layer's switch: the clumps at the hedges' foot, its amount how full. */
export const countryVergesKnob = feature(
  "land",
  "verges",
  "verges",
  false,
  "fullness",
  0.6,
  "Clumps of cow parsley, red campion and tussock grass at the foot of the hedges on the fields nearest the hill. They sway in the wind and bow as its gusts roll across the fields, follow the farming year (new leaves in spring, the parsley's white umbels in early summer, gone to seed at harvest with the campion still in flower, everything browning in autumn, dead stems through winter) and carry the snow; they keep off the roads, the streams and the river, the yards, the woods and the grazed pastures. Fullness: how many clumps, from one here and there to a row along every hedge.",
  { icon: "flower" },
);
