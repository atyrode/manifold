// Wildlife over the countryside: parties of birds crossing the valley (the shared birds library,
// shaders/lib/birds.ts) and a starling murmuration at dusk (the Murmuration scene's flock), both in
// the same world as the land (see shader.ts for its projection).
//
// Birds (`songbirds`, `flights`): four flight slots, each on a cycle of its own (birdSchedule). In
// each cycle a slot may send one flight across the frame. Whether it comes is the knob's amount, the
// time of day when its cycle began (none at night) and the weather (fewer in snow, none in steady
// rain); its species is the `flights` choice, or with "mixed" the farming year and the hour: rooks
// most of the day and nearly all of them at dusk, flying home to roost; swallows through summer and
// harvest; a buzzard circling on the thermals from late morning; in autumn gulls following the
// plough and skeins of geese. Everything else (depth, height, direction, party) is hashed from the
// cycle, the slot and the landscape seed, so the sky is the same at the same motion time and stands
// still at motion 0. A party sometimes swoops low over the fields, but never below the bare crest of
// the ridge whose face lies at its depth, plus the height of the trees on it, so it never cuts
// through the hill under it. Birds are drawn twice life size like the scene's trees and houses.
//
// Murmuration (`murmuration`): the Murmuration scene's flock (flockSim, flown as countryMurmuration
// says) at COUNTRY_MURMURATION_DEPTH over the far fields, inked from its density field with the same
// flockSheet; the band of sky it keeps to dips just below the far skyline, where the hills hide it.
//
// Coherence: both are composited after the land or sky under each pixel is shaded and only where
// they lie nearer than that surface (`seen`, world units), so a nearer hill, tree crown or building
// hides them; they then become the surface the rain and snow stop at. Every bird is nearer than the
// murmuration. Both use the lens-shifted uv of the passage and the ridges' pointer parallax for their
// depth, so they stay in the world while the camera moves. Both, with the birds library and the
// flock's ink, are compiled in only while one of their knobs is on (COUNTRY_HAS_WILDLIFE, index.ts).
//
// Butterflies and bees are not drawn: at ~120 m a world unit, a 5 cm butterfly on the nearest field
// (the bottom of the frame, about 0.65 world units away) is 0.00064 screen heights across, 0.35 of a
// cell at the default pixel size on a 1080-pixel-high window and 0.7 at the finest; a 1.5 cm bee a
// third of that.
import { birdsGlsl } from "../../shaders/lib/birds.ts";
import { flockInkGlsl } from "../flock/shader.ts";
import type { FlockSetup } from "../flock/sim.ts";

/** The `flights` choice: which birds cross the valley ("mixed" follows the farming year and the hour). */
export const COUNTRY_FLIGHTS = [
  { label: "mixed", value: 0 },
  { label: "rooks", value: 1 },
  { label: "swallows", value: 2 },
  { label: "gulls", value: 3 },
  { label: "geese", value: 4 },
  { label: "buzzard", value: 5 },
] as const;

/**
 * The countryside's murmuration (flockSim): the size knob switches it (0 while off idles the sim),
 * the scene's wind carries it, and it keeps to a band of sky over the far ridges, smaller than the
 * Murmuration scene's because the flock shrinks to fit it. No falcon, no M: the shader draws neither.
 */
export const countryMurmuration: FlockSetup = {
  knobs: {
    birds: "murmuration",
    cohesion: 0.6,
    chaos: 0.3,
    speed: 0.4,
    predator: 0,
    wind: "wind",
    mark: 0,
  },
  sky: { low: 0.58, high: 0.9 },
};

export const countryWildlifeGlsl = /* glsl */ `
#if COUNTRY_HAS_WILDLIFE
${birdsGlsl}
${flockInkGlsl}

// The murmuration's distance (world): beyond the fourth ridge, over the fifth ridge's fields.
const float COUNTRY_MURMURATION_DEPTH = 6.0;
const vec3 COUNTRY_STARLING = vec3(0.035, 0.03, 0.045);

// The lowest a bird at depth D may fly over screen x (world height above the valley floor): clear of
// the trees on the bare crest of the ridge whose face lies at that depth, as no ground under it is
// higher than that crest.
float countryFlightFloor(float D, float x, vec2 spots) {
  float k = 5.0;
  for (int i = 0; i < 6; i++) {
    if (countryLayer(float(i)).x >= D) {
      k = float(i);
      break;
    }
  }
  return COUNTRY_EYE + (countryGroundCrest(k, x, spots) - COUNTRY_HORIZON) * countryLayer(k).x + 0.05;
}

// The nearest bird covering screen point p (lens-shifted, before parallax). tm: the motion clock;
// parallax: the ridges' pointer shift at depth one; spots: the village and chalk down (for the
// crests under a low flight).
BirdHit countryBirds(vec2 p, float tm, vec2 parallax, vec2 spots) {
  BirdHit near = birdNone();
  // The scene's camera; a world unit is some 120 m (COUNTRY_METRES).
  BirdCamera cam = BirdCamera(COUNTRY_HORIZON, 1.0, COUNTRY_EYE, 1.0 / COUNTRY_METRES, 2.0);
  float aspect = uRes.x / uRes.y;
  float calm = smoothfall(0.5, 0.1, K_rain) * (1.0 - 0.5 * smoothstep(0.2, 0.8, K_snow));
  for (int j = 0; j < 4; j++) {
    vec2 key;
    float start;
    float v = birdSchedule(float(j), tm, countrySeed, key, start);
    if (v <= 0.0 || v >= 1.0) continue;
    float tod = timeOfDayM(K_time, K_cycle, start);
    if (hash12(key) >= K_songbirds * calm * smoothstep(0.23, 0.27, tod) * smoothfall(0.84, 0.8, tod)) continue;

    float kind = K_flights - 1.0;
    if (K_flights < 0.5) {
      float dusk = smoothstep(0.68, 0.74, tod);
      float autumn = step(1.5, K_season);
      float raptor = 0.2 * (1.0 - dusk) * smoothstep(0.33, 0.4, tod);
      float swallow = 0.28 * (1.0 - autumn) * (1.0 - dusk);
      float gull = (0.06 + 0.18 * autumn) * (1.0 - dusk);
      float goose = 0.25 * autumn + 0.05 * dusk;
      float pick = hash12(key + 1.7);
      kind = pick < raptor ? BIRD_RAPTOR
        : (pick < raptor + swallow ? BIRD_SWALLOW
        : (pick < raptor + swallow + gull ? BIRD_GULL
        : (pick < raptor + swallow + gull + goose ? BIRD_GOOSE : BIRD_CROW)));
    }
    // Where each flies (depths, then screen heights): swallows near and low, geese far and high.
    vec4 lane = kind > 3.5 ? vec4(1.6, 3.2, 0.72, 0.86)
      : (kind > 2.5 ? vec4(2.0, 4.2, 0.76, 0.92)
      : (kind > 0.5 && kind < 1.5 ? vec4(1.05, 1.7, 0.66, 0.8) : vec4(1.3, 3.3, 0.69, 0.88)));
    BirdFlight f = birdCrossing(key, v, kind, lane.xy, lane.zw, cam, aspect);
    if (f.swoop > 0.01) f.lead.y = mix(f.lead.y, countryFlightFloor(f.lead.z, f.lead.x / f.lead.z, spots), f.swoop);
    BirdHit hit = birdFlightHit(p + parallax / f.lead.z, f, cam, tm, 1.0 / uRes.y);
    if (hit.cover > 0.5 && hit.depth < near.depth) near = hit;
  }
  return near;
}

// The songbirds and the murmuration in front of the surface shaded at this pixel (sceneCountry,
// once the land or sky is shaded): each only where it lies nearer than that surface (seen, world),
// lit by the sky and hazed by its own distance; where one covers the pixel it becomes the surface
// the rain and snow stop at, and it hides any lamp glow behind it. p, uv: the lens-shifted screen
// point and uv; sky: as the weather has it; haze: the horizon colour the land fades into.
void countryWildlife(inout vec3 col, inout float seen, inout float accent, vec2 p, vec2 uv, vec2 spots, Sky sky, vec3 haze, float tod, float overcast) {
  if (K_songbirds <= 0.0 && K_murmuration <= 0.0) return;
  vec3 light = sky.ambient * 1.2 + sky.sunColor * 0.3 + sky.moonColor * 0.25;
  float thin = 0.06 + 0.08 * overcast;
  vec2 parallax = uPointer * uMotion * vec2(0.022, 0.01);
  if (K_murmuration > 0.0 && uSimOn.x > 0.5 && COUNTRY_MURMURATION_DEPTH < seen) {
    // The starlings gather over the fields from late afternoon, wheel through the sunset and go
    // down to roost as dusk deepens; not in steady rain.
    float shows = smoothstep(0.66, 0.7, tod) * smoothfall(0.84, 0.79, tod) * smoothfall(0.6, 0.2, K_rain);
    vec2 at = uv + parallax * vec2(uRes.y / uRes.x, 1.0) / COUNTRY_MURMURATION_DEPTH;
    if (shows > 0.0 && at.x > 0.0 && at.x < 1.0 && at.y > 0.0 && at.y < 1.0) {
      vec2 sheet = flockSheet(at);
      float cover = sheet.x * shows;
      vec3 ink = mix(COUNTRY_STARLING * light, haze, 1.0 - exp(-COUNTRY_MURMURATION_DEPTH * thin));
      col = mix(col, mix(ink, col, 0.1 * (1.0 - sheet.y)), cover);
      accent *= 1.0 - cover;
      if (cover > 0.5) seen = COUNTRY_MURMURATION_DEPTH;
    }
  }
  if (K_songbirds > 0.0) {
    BirdHit bird = countryBirds(p, uMotionTime, parallax, spots);
    if (bird.cover > 0.5 && bird.depth < seen) {
      col = mix(bird.albedo * light, haze, 1.0 - exp(-bird.depth * thin));
      accent = 0.0;
      seen = bird.depth;
    }
  }
}
#endif
`;
