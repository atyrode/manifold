// The starling murmuration (the `starlings` layer, off by default): the Murmuration scene's flock (flock/
// sim.ts's Flock, flown as countryMurmuration says) wheeling over the far fields from late afternoon
// until it goes down to roost as dusk deepens, never in steady rain nor while the starlings nest in
// late spring (the time of year, season.ts's countryYear), carried by the scene's wind. The
// flock keeps to its band of sky in screen heights (COUNTRY_MURMURATION.sky), which dips below the
// skyline; the shader stands it COUNTRY_MURMURATION.depth metres out (camera depth) and inks it from
// its density field with the flock's own ink (flockInk), only where the first surface along the ray
// lies farther: the valley's sides and anything else nearer hide it, the far fields and hills and the
// sky show behind it. Where it covers the pixel it becomes the surface the birds, rain and snow stop
// at, and it hides the lamplight behind it. It follows the passage's lens shift, so it stays in the
// world while the camera comes down.
//
// Its textures have no slot of their own (the terrain takes all four): the flock's density field
// and reference density ride in the records atlas (atlas.ts), its header at texel (64, 0) (field
// width, height, the birds per texel of the reference sheet, 0) and the field beside the terrain's
// records, columns 64.. and rows 1..height (rg birds and their roll), read through the atlas's
// linear filter with its edges clamped as the flock's own texture clamps them. Compiled in only
// while the knob is on (COUNTRY_HAS_MURMURATION, the valley's featuresFor); while it is off the flock
// idles. The flock's ink (flockInk) is the composer's shared chunk FLOCK_INK, compiled in once.
import { glslFloat } from "../../shaders/glsl.ts";
import { TERRAIN_RECORDS } from "../../sims/terrain.ts";
import { type Flock, type FlockSetup } from "../flock/sim.ts";

/** Where the flock flies: its camera depth (metres) and its band of sky (screen heights). */
export const COUNTRY_MURMURATION = { depth: 2400, sky: { low: 0.55, high: 0.9 } } as const;

/** The atlas texel holding the flock's header; its field starts in this column, a row up. */
export const COUNTRY_FLOCK_HEAD = TERRAIN_RECORDS.width;

/**
 * The countryside's flock (Flock): the knob's starlings, 0 while it is off (the flock idles), the
 * scene's wind carrying it, its own band of sky. No falcon, no M: the shader draws neither.
 */
export const countryMurmuration: FlockSetup = {
  knobs: {
    birds: "starlings",
    cohesion: 0.6,
    chaos: 0.3,
    speed: 0.4,
    predator: 0,
    wind: "wind",
    mark: 0,
  },
  sky: COUNTRY_MURMURATION.sky,
};

/** Writes the flock's header and density field into the atlas's rgba texels, `width` a row. */
export function writeCountryFlock(flock: Flock, data: Float32Array, width: number): void {
  const w = flock.fieldWidth;
  const h = flock.fieldHeight;
  const field = flock.field;
  const head = 4 * COUNTRY_FLOCK_HEAD;
  data[head] = w;
  data[head + 1] = h;
  data[head + 2] = flock.state[7] ?? 1;
  data[head + 3] = 0;
  for (let j = 0; j < h; j++) {
    const row = 4 * ((1 + j) * width + COUNTRY_FLOCK_HEAD);
    for (let i = 0; i < w; i++) {
      data[row + 4 * i] = field[2 * (j * w + i)] ?? 0;
      data[row + 4 * i + 1] = field[2 * (j * w + i) + 1] ?? 0;
    }
  }
}

export const countryMurmurationGlsl = /* glsl */ `
#if COUNTRY_HAS_MURMURATION
// ---- the murmuration (murmuration.ts) ----
const int COUNTRY_FLOCK_HEAD = ${COUNTRY_FLOCK_HEAD};
const float COUNTRY_MURMURATION_DEPTH = ${glslFloat(COUNTRY_MURMURATION.depth)};
const vec3 COUNTRY_STARLING = vec3(0.035, 0.03, 0.045);

// The flock's field at field texel coordinates at (texel centres on halves) of a field size texels
// big, in an atlas atlas texels big: linear, clamped to its edge texels.
vec2 countryFlockAt(vec2 at, vec2 size, vec2 atlas) {
  vec2 c = clamp(at, vec2(0.5), size - 0.5);
  return texture(valleyField3, (vec2(float(COUNTRY_FLOCK_HEAD), 1.0) + c) / atlas).rg;
}

// The flock's sheet at uv (flockInk), sampled as flockSheet samples the flock's own texture.
vec2 countryFlockSheet(vec2 uv) {
  vec4 head = texelFetch(valleyField3, ivec2(COUNTRY_FLOCK_HEAD, 0), 0);
  vec2 size = head.xy;
  vec2 atlas = vec2(textureSize(valleyField3, 0));
  vec2 at = uv * size;
  vec2 fine = countryFlockAt(at, size, atlas);
  vec2 wide = 0.25 * (countryFlockAt(at - 1.0, size, atlas) + countryFlockAt(at + 1.0, size, atlas)
    + countryFlockAt(at + vec2(1.0, -1.0), size, atlas) + countryFlockAt(at + vec2(-1.0, 1.0), size, atlas));
  return flockInk(fine, wide, max(head.z, 0.01));
}

// The starlings in front of the surface shaded at this pixel (seen: its distance along the ray,
// 8000 the sky; ahead: the ray's share along the view), at uv (the passage's lens shift included),
// lit by the sky and hazed by their distance as the land is, in the valley fog too (fog.ts); where
// they cover the pixel they become that surface. They gather from late afternoon and go down to
// roost as dusk deepens; not in steady rain, and not while they nest (they thin out from early
// spring and gather again from midsummer).
void countryMurmuration(inout vec3 col, inout float seen, inout float accent, vec2 uv, float ahead, Sky sky, vec3 haze, float tod, float rain, float overcast) {
  if (VALLEY_STARLINGS <= 0.0) return;
  float far = COUNTRY_MURMURATION_DEPTH / ahead;
  if (far >= seen) return;
  float nesting = smoothstep(0.06, 0.12, countryYear) * smoothfall(0.34, 0.28, countryYear);
  float shows = smoothstep(0.66, 0.7, tod) * smoothfall(0.84, 0.79, tod) * smoothfall(0.6, 0.2, rain) * (1.0 - nesting);
  if (shows <= 0.0 || uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) return;
  vec2 sheet = countryFlockSheet(uv);
  float cover = sheet.x * shows;
  vec3 light = sky.ambient * 1.2 + sky.sunColor * 0.3 + sky.moonColor * 0.25;
  float thick = 1.0 / (5200.0 - 2600.0 * overcast);
  vec3 ink = mix(COUNTRY_STARLING * light, haze, 1.0 - exp(-far * thick));
#if COUNTRY_HAS_FOG
  if (K_fog > 0.0) countryFogged(ink, far, 1.0, 0.0);
#endif
  col = mix(col, mix(ink, col, 0.1 * (1.0 - sheet.y)), cover);
  accent *= 1.0 - cover;
  if (cover > 0.5) seen = far;
}
#endif
`;
