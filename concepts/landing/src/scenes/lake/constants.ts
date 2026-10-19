// What the Frozen lake preset and its layer manifests (index.ts, layers.ts) share with its GLSL and
// sims (shader.ts, sim.ts), without loading them: the eye on the ice and the rig it is, the passage
// that tilts it, the light guest layers take, the World's birds over it (while another backdrop
// stands there: the lake's own night flies its own) and what each layer keeps in the composer's
// shared resources.
import type { Flyway, Grade, Rig } from "../../composer/types.ts";
import { glslFloat } from "../../shaders/glsl.ts";

/** Screen height (uv) of the horizon, the vertical field of view (rad) and its focal length (screen heights). */
export const HORIZON = 0.4;
export const FOV = 1.08;
export const FOCAL = 0.5 / Math.tan(FOV / 2);
/** The eye's height over the ice (m). */
export const EYE = 1.6;

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage; the shader reads both). Entrance:
 * the camera tilts down from the aurora onto the ice, and a crack sings across it. Exit: a gust of
 * snow streams across the ice while the camera tilts back up to the sky.
 */
export const LAKE_PASSAGE: { enter: number; exit: number } = { enter: 2.8, exit: 1.5 };

/** How far the camera tilts coming in and going out over the frozen lake (screen heights). */
const LAKE_TILT = 0.5;

/**
 * The lake's rig: a level pinhole EYE metres over the ice, facing north across the lake unturned (the
 * night is the lake's own, laid out in this frame). Nothing is laid out across the frame's width, so
 * it has no stage. Its passage moves no eye: it tilts the lens (rigShift), the frame read lower in uv
 * while the camera looks up. Over the frozen lake it arrives from the aurora, settling a little past
 * level and back, and leaves toward it, gathering pace once the exit's gust has begun. Over the fjord
 * (the far shore's `setting` 1, LAKE_FJORD) it comes down from the stars already moving and settles
 * with a touch of overshoot, and lifts to them again, ever faster. Exactly 0 at rest.
 */
export const LAKE_RIG: Rig = {
  horizon: HORIZON,
  focal: FOCAL,
  eye: EYE,
  turn: 0,
  pitch: 0,
  minAspect: 1,
  passage: {
    lift: () => 0,
    shift: true,
    glsl: `
// ---- the lake's passage: the camera tilting down from the sky and back up to it (constants.ts) ----
const float LAKE_TILT = ${glslFloat(LAKE_TILT)};

float rigLift() {
  return 0.0;
}

float rigCut() {
  return 0.0;
}

// The camera arriving from the aurora: the share of the tilt still to go at progress p. It comes
// down from the sky already moving fast and settles a little past level and back, landing on
// exactly zero at rest.
float lakeArrive(float p) {
  float a = 1.0 - clamp(p, 0.0, 1.0);
  return a * a * a * (2.5 * a - 1.5);
}

// The camera leaving toward the aurora: the share of the tilt done at progress p, gathering pace
// once the gust has begun and still at full pace as the exit ends.
float lakeLeave(float p) {
  float q = clamp((p - 0.1) / 0.9, 0.0, 1.0);
  return q * q * q;
}

// The lens's vertical shift in screen heights (the world read that much lower in uv), 0 at rest.
float rigShift() {
  float pin = passageIn();
  float pout = passageOut();
#if LAKE_FJORD
  if (K_setting > 0.5) {
    if (pin >= 1.0 && pout <= 0.0) return 0.0;
    float settle = passageSettle(pin / 0.82, 1.1);
    return 0.22 * (1.0 - settle) + 0.26 * pout * pout;
  }
#endif
  float shift = 0.0;
  if (pin < 1.0) shift += LAKE_TILT * lakeArrive(pin);
  if (pout > 0.0) shift += LAKE_TILT * lakeLeave(pout);
  return shift;
}
`,
  },
};

/**
 * The light guest layers and the plain floor take on the lake (its own layers keep the night's own
 * light, shader.ts lakeSetup): the far shore stages its night on the World, so this is the lake's
 * sky, its moon the key once the sun has set, at its full light on the land; the lake's ink.
 */
export const LAKE_GRADE: Grade = { moonlight: 1, ink: { gain: 1.4, gamma: 0.8 } };

/**
 * The World's birds while another backdrop stands over the ice (the far shore's night flies its own
 * skein, shader.ts), key by key over the outdoor baseline's (composer/outdoor.ts): flights 60 to
 * 450 metres out, from just over the horizon to near the top of the frame (the baseline's top),
 * geese never swooping, drawn three times life size, fading into the haze by 1 / 1500 a metre.
 */
export const LAKE_FLYWAY: Partial<Flyway> = {
  depth: [60, 450],
  above: 0.05,
  seed: 6.1,
  skim: 1e9,
  spread: 3,
  ext: 1 / 1500,
};

/** Where the shooting stars set out (skyAngles): high over the mountains, and seen again in the ice. */
export const LAKE_METEORS = [-0.6, 0.3, 1.2, 0.15] as const;

/**
 * What the layers keep in the composer's shared resources (LayerDef.data): the far shore a row of
 * the records atlas (texel 0: the aurora's substorm and clock), the lake a row (a texel per crack
 * slot, then the drifting snow) and its three fields (the crack field, its ids, the snow).
 */
export const LAKE_DATA = { farShore: { rows: 1 }, lake: { rows: 1, fields: 3 } } as const;
