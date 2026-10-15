// A Calder mobile hanging in a quiet room, its shadows thrown large across the wall behind it. The
// mobile itself is the shared part (sims/mobile.ts): its texture, plates, wires and links traced
// along each view ray (mobileTrace) and the share of a round lamp it hides from any point
// (mobileShadow). This file is the room: the wall, the floor and the ceiling, the lights, the paint.
//
// Light: a key light (a spotlight on a stand at night, the window by day) whose position (K_lamp)
// and size (K_softness: how soft the shadows' edges) set where and how sharply the shadows fall, and
// an optional second, cooler light from the right (K_fill) that throws a second, paler shadow, so the
// shadows come in two colours where they part. Each shadow is cut per cell against its own
// threshold, so a moving edge flips each cell once and a penumbra reads as a gradient of cells.
//
// Knobs read here: K_palette, K_room, K_lamp, K_softness, K_fill, K_mark (the others shape the
// simulation). Textures: uSim0, the MobileTexture.
import { glslPick, glslVec3 } from "../../shaders/glsl.ts";
import { MOBILE_MARK_SHAPE, mobileGlsl } from "../../sims/mobile.ts";
import { MOBILE_TEX_ORIGIN, mobileLayoutGlsl } from "./layout.ts";

/** Painted plates: in `palette` knob order; a plate's tone picks its colour by the thresholds. */
export interface MobilePaint {
  label: string;
  /** Colours and the tone each one runs up to (the last runs to 1). */
  colours: readonly (readonly [string, number])[];
}

/** The Calder red: the accent, the red plates and the M. */
export const MOBILE_RED = "#c8321c";

export const mobilePaints: readonly MobilePaint[] = [
  {
    label: "primaries",
    colours: [
      ["#0d0d10", 0.42],
      [MOBILE_RED, 0.7],
      ["#eab421", 0.82],
      ["#1d3f8f", 0.92],
      ["#e6e1d4", 1],
    ],
  },
  {
    label: "black",
    colours: [
      ["#0d0d10", 0.86],
      [MOBILE_RED, 1],
    ],
  },
  {
    label: "white",
    colours: [
      ["#e9e5db", 0.82],
      ["#0d0d10", 0.94],
      [MOBILE_RED, 1],
    ],
  },
  { label: "brass", colours: [["#c99a45", 1]] },
];

/** The paint for tone h under the current palette: rgb, and a = 1 for the red (the accent). */
const paintBody = mobilePaints
  .map((paint, i) => {
    const lines = paint.colours.map(([hex, upTo], j) => {
      const red = hex === MOBILE_RED ? "1.0" : "0.0";
      return j === paint.colours.length - 1
        ? `    return vec4(${glslVec3(hex)}, ${red});`
        : `    if (h < ${upTo.toFixed(2)}) return vec4(${glslVec3(hex)}, ${red});`;
    });
    return `  if (K_palette < ${i}.5) {\n${lines.join("\n")}\n  }`;
  })
  .join("\n");

export const mobileSceneGlsl = `
${mobileGlsl("uSim0", MOBILE_TEX_ORIGIN)}
${mobileLayoutGlsl}
const vec3 MOBILE_RED = ${glslVec3(MOBILE_RED)};
// Where the spotlight is aimed: between the mobile and its shadow, so the pool of light lies on the
// right of the frame and the copy on the left stays in the room's dark.
const vec3 MOBILE_SPOT_AIM = vec3(0.9, 1.6, -0.8);
// The window on the right the second light comes through.
const vec3 MOBILE_WINDOW = vec3(2.4, 2.2, 2.6);

vec4 mobileRoomPaint(float h) {
${paintBody}
  return vec4(0.5, 0.5, 0.5, 0.0);
}

bool mobileRoomDay() {
  return K_room > 0.5;
}

// The key light: position, radius (m), colour times intensity.
vec3 mobileRoomKeyPos() {
  return vec3(mix(-3.0, 3.0, K_lamp), mobileRoomDay() ? 2.4 : 2.25, mobileRoomDay() ? 2.2 : 3.0);
}

float mobileRoomKeyRadius() {
  return mobileRoomDay() ? mix(0.25, 0.9, K_softness) : mix(0.012, 0.28, K_softness);
}

vec3 mobileRoomKeyColour() {
${glslPick("room", ["vec3(1.0, 0.87, 0.7) * 30.0", "vec3(1.0, 0.98, 0.94) * 11.0"], "vec3(1.0)")}
}

// How much of the key reaches P: a spotlight's cone falling off with the square of the distance at
// night; by day the window, a broad source, falls off gently across the room.
float mobileRoomKeyReach(vec3 P, vec3 L) {
  vec3 d = P - L;
  float r2 = dot(d, d);
  if (mobileRoomDay()) return 1.0 / (4.0 + 0.5 * r2);
  float c = dot(normalize(d), normalize(MOBILE_SPOT_AIM - L));
  return smoothstep(0.8, 0.98, c) / r2;
}

vec3 mobileRoomFillColour() {
  return (mobileRoomDay() ? vec3(1.0, 0.86, 0.68) * 8.0 : vec3(0.5, 0.62, 1.0) * 18.0) * K_fill;
}

float mobileRoomFillRadius() {
  return mobileRoomDay() ? 0.3 : 0.2;
}

vec3 mobileRoomAmbient() {
  return mobileRoomDay() ? vec3(0.34, 0.35, 0.37) : vec3(0.02, 0.022, 0.032);
}

// Light arriving at P with normal n from both lights, each hidden by the mobile as far as its share
// cut per cell (skip: the plate P lies on, -1 for none).
vec3 mobileRoomLight(vec3 P, vec3 n, vec2 cell, int skipArm, int skipEnd) {
  vec3 light = mobileRoomAmbient();
  vec3 L = mobileRoomKeyPos();
  vec3 toL = L - P;
  float key = max(dot(n, normalize(toL)), 0.0) * mobileRoomKeyReach(P, L);
  if (key > 0.0) {
    float hidden = hardEdge(mobileShadow(P, L, mobileRoomKeyRadius(), skipArm, skipEnd));
    light += mobileRoomKeyColour() * key * (1.0 - hidden);
  }
  // The second light falls through the window in a broad beam toward the mobile, so the far side of
  // the room stays in the dark rather than holding the window's lone shadows.
  if (K_fill > 0.0) {
    vec3 toW = MOBILE_WINDOW - P;
    float beam = smoothstep(0.88, 0.97, dot(normalize(-toW), normalize(MOBILE_SPOT_AIM - MOBILE_WINDOW)));
    float fill = max(dot(n, normalize(toW)), 0.0) * beam / dot(toW, toW);
    if (fill > 0.0) {
      float hidden = hardEdge(mobileShadow(P, MOBILE_WINDOW, mobileRoomFillRadius(), skipArm, skipEnd), edgeThreshold(cell, vec2(17.0, 5.0)));
      light += mobileRoomFillColour() * fill * (1.0 - hidden);
    }
  }
  return light;
}

// The plaster wall: a faint, broad mottle; a skirting board along the floor.
vec3 mobileRoomWall(vec3 P) {
  vec3 plaster = mobileRoomDay() ? vec3(0.86, 0.85, 0.82) : vec3(0.5, 0.48, 0.46);
  plaster *= 0.96 + 0.06 * vnoise(P.xy * 3.0 + 7.0) + 0.03 * vnoise(P.xy * 11.0);
  if (P.y < 0.12) plaster = mobileRoomDay() ? vec3(0.8, 0.79, 0.76) : vec3(0.33, 0.3, 0.27);
  return plaster;
}

// The floor: oak boards running across the room.
vec3 mobileRoomFloor(vec3 P, float cw) {
  float v = P.z / 0.14;
  float board = floor(v);
  float seam = smoothfall(0.06 + cw / 0.14, 0.02, min(fract(v), 1.0 - fract(v)));
  float tone = 0.85 + 0.3 * hash12(vec2(board, 3.1));
  float grain = 0.9 + 0.2 * vnoise(vec2(P.x * 1.5 + board * 4.7, P.z * 40.0));
  vec3 oak = (mobileRoomDay() ? vec3(0.55, 0.4, 0.26) : vec3(0.36, 0.25, 0.15)) * tone * mix(1.0, grain, smoothfall(0.02, 0.006, cw));
  return oak * (1.0 - 0.5 * seam);
}

Shade sceneMobile(vec2 uv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  vec3 ro = MOBILE_EYE + vec3(MOBILE_SWAY * uPointer, 0.0);
  vec3 fwd = normalize(MOBILE_AIM - ro);
  vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(right, fwd);
  float focal = mobileFocal(aspect);
  vec3 rd = normalize(fwd * focal + right * p.x + up * p.y);
  float cellW = dot(fwd, rd) / (focal * uRes.y);
  mobileMark = K_mark > 0.0 ? mix(0.85, 1.35, K_mark) : 0.0;

  // The room: the wall, or the floor or ceiling where the ray meets them first.
  float tSurf = (MOBILE_WALL - ro.z) / rd.z;
  vec3 n = vec3(0.0, 0.0, 1.0);
  int surface = 0;
  if (rd.y < 0.0 && -ro.y / rd.y < tSurf) {
    tSurf = -ro.y / rd.y;
    n = vec3(0.0, 1.0, 0.0);
    surface = 1;
  } else if (rd.y > 0.0 && (MOBILE_CEILING - ro.y) / rd.y < tSurf) {
    tSurf = (MOBILE_CEILING - ro.y) / rd.y;
    n = vec3(0.0, -1.0, 0.0);
    surface = 2;
  }
  vec3 P = ro + rd * tSurf;
  vec3 albedo = surface == 1 ? mobileRoomFloor(P, tSurf * cellW) : surface == 2 ? (mobileRoomDay() ? vec3(0.8) : vec3(0.45)) : mobileRoomWall(P);
  // The hook in the ceiling the mobile hangs from.
  if (surface == 2) albedo *= 1.0 - 0.85 * hardFill((length(P.xz - MOBILE_HOOK.xz) - 0.03) / (tSurf * cellW), 0.7);
  vec3 col = albedo * mobileRoomLight(P + n * 0.002, n, cell, -1, -1);
  float accent = 0.0;

  // The mobile, in front of it.
  MobileHit hit = mobileTrace(ro, rd, cellW, tSurf, 0.0013, 0.0007);
  if (hit.kind == MOBILE_PLATE) {
    vec3 Q = ro + rd * hit.t;
    vec4 paint = hit.shape == ${MOBILE_MARK_SHAPE} ? vec4(MOBILE_RED, 1.0) : mobileRoomPaint(hit.tone);
    vec3 light = mobileRoomLight(Q + hit.n * 0.002, hit.n, cell, hit.arm, hit.end);
    vec3 L = normalize(mobileRoomKeyPos() - Q);
    float glint = pow(max(dot(reflect(rd, hit.n), L), 0.0), 40.0);
    bool brass = K_palette > 2.5 && hit.shape != ${MOBILE_MARK_SHAPE};
    col = brass ? paint.rgb * (0.35 * light + 2.2 * glint * mobileRoomKeyColour() * mobileRoomKeyReach(Q, mobileRoomKeyPos()))
                : paint.rgb * light + 0.08 * glint * mobileRoomKeyColour() * mobileRoomKeyReach(Q, mobileRoomKeyPos());
    accent = paint.a;
  } else if (hit.kind != MOBILE_NONE) {
    vec3 Q = ro + rd * hit.t;
    vec3 L = mobileRoomKeyPos();
    float glint = pow(max(dot(reflect(rd, hit.n), normalize(L - Q)), 0.0), 24.0);
    col = vec3(0.03, 0.03, 0.035) * (1.0 + 4.0 * mobileRoomAmbient()) + 0.5 * glint * mobileRoomKeyColour() * mobileRoomKeyReach(Q, L);
  }

  // At night the room falls away into the dark toward the edges of the picture.
  if (!mobileRoomDay()) col *= 1.0 - 0.4 * smoothstep(0.45, 1.3, length(p * vec2(0.75, 1.0)));
  return shadeOf(col, inkOf(col, 1.4, 0.8), accent);
}
`;
