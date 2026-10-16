// Shared giant planet: one implementation of a ringed gas giant that any sky composes, whether as its
// subject (orbit: ink and accent coverage, every feature) or as a decoration (campfire: RGB over the
// sky, behind its pines). The contract and conventions are in src/scenes/README.md ("The giant
// planet").
//
// Opt-in, unlike the libraries in `libs`: a scene that composes the planet puts `planetGlsl` in its
// own GLSL (at its top, before the functions that call it), so no other scene's program compiles it.
// It reads no knob defines: the scene passes every value.
//
// What is shared: the sphere and its phase lighting (the sun circling it), the surface (turbulent
// belts or storm-swirled bands, a cloud deck, night-side storms), the atmosphere (a sunward limb halo
// or a broad glow), night-side city lights, a polar aurora with curtains rising off the limb, the ring
// (one plane geometry with depth, the planet's shadow on it and its shadow on the planet, a banded
// system or a thin streaked material) and a family of moons (orbits, discs, eclipses, occultation).
// What is the scene's: placement, size, the sun's direction, palette, which features it composes,
// what stands in front, and how it composites.
//
// Frame: planet radii from the planet's centre, x right, y up, z toward the eye. planetAt maps the
// scene's flat units into it. Every detailed feature takes `foot`, one dither cell in planet radii
// (the scene's cell size over the radius): detail finer than a cell fades to its mean or coarsens, so
// the same planet is a hero filling the frame or a far decoration a few dozen cells across. Where the
// detail spans a cell or more the output is the full-detail one bit for bit.
//
// The body tier (`planetBodyGlsl`, after `planetGlsl`) is the decoration tier for the sky's planets
// (skyGiant in sky.ts): one planet of any of PLANET_BODY_KINDS (the banded giant as planetOver
// draws it, a belted giant, a rocky, an ocean, a home-like, a lava, a crystal, an eye and a bubble
// world), in its kind's palettes, with a thin or a wide banded ring, on its own clock.
import { WINTER_COVER } from "../../climate.ts";
import { glslFloat, glslVec3 } from "../glsl.ts";

export const planetGlsl = `
// ---- planet ----

// A pixel on the planet: q its offset from the centre in radii, d = |q|, and the sphere's unit normal
// there while d < 1 (on and beyond the limb, z = 0).
struct PlanetPoint { vec2 q; float d; vec3 normal; };

// p, centre and radius in the scene's own flat units.
PlanetPoint planetAt(vec2 p, vec2 centre, float radius) {
  PlanetPoint s;
  s.q = (p - centre) / radius;
  s.d = length(s.q);
  s.normal = vec3(s.q, sqrt(max(1.0 - s.d * s.d, 0.0)));
  return s;
}

// Level of detail: 1 while a feature 'size' across (radii) spans at least a cell (foot: a cell in
// radii), falling to 0 as it shrinks to half a cell. Exactly 1 where resolved: callers test < 1.0.
float planetLod(float size, float foot) {
  return smoothstep(0.5, 1.0, size / foot);
}

// How many times to halve a grid of cells 'size' tall (radii) so each spans at least 1.25 cells: a far
// planet's towns and storm cells merge into fewer, larger ones instead of shimmering. 0 up close.
float planetCoarsen(float size, float foot) {
  return max(ceil(log2(1.25 * foot / size)), 0.0);
}

// fbm (common) whose octaves fade to their mean 0.5 as their lattice shrinks from one cell to half a
// cell (foot: a cell in p units); fbm itself wherever every octave resolves.
float planetFbm(vec2 p, float foot) {
  float a = 0.5;
  float s = 0.0;
  float lattice = 1.0;
  for (int i = 0; i < 5; i++) {
    float keep = planetLod(lattice, foot);
    s += a * (keep < 1.0 ? mix(0.5, vnoise(p), keep) : vnoise(p));
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
    lattice /= 2.03;
  }
  return s;
}

// ---- lighting ----

// The sun's direction turned about the planet's vertical axis by 'sweep' radians: a day cycle sweeps
// the terminator across the planet (sweep on the motion clock), a fixed sweep sets its phase.
vec3 planetSun(vec3 light, float sweep) {
  return vec3(light.x * cos(sweep) + light.z * sin(sweep), light.y, -light.x * sin(sweep) + light.z * cos(sweep));
}

// How far round toward the sun a direction on screen points, -1..1: the sunward limb.
float planetSunward(vec2 q, vec3 light) {
  return dot(normalize(q), normalize(light.xy + 1e-4));
}

// The night side 0..1 from the sunlight's cosine (clamped at 0): 1 in the dark, gone 0.15 into the day.
float planetNight(float diffuse) {
  return smoothfall(0.15, 0.0, diffuse);
}

// Grazing light at the limb, 0 face-on .. 1 at the edge.
float planetRim(vec3 normal) {
  return pow(1.0 - normal.z, 3.0);
}

// ---- atmosphere ----

// A thin limb halo outside the disc (d >= 1): 'falloff' per scene unit of height, radius in scene
// units, so its thickness stays fixed on screen. Times planetSunward through the scene's own curve.
float planetHalo(float d, float radius, float falloff) {
  return exp(-(d - 1.0) * radius * falloff);
}

// A broad glow round the limb, 'width' radii wide, 1 on the limb (the decoration's airglow).
float planetGlow(float d, float width) {
  return bell((d - 1.0) / width);
}

// ---- surface ----

// Longitude of a point of the sphere about its vertical axis: drift is the surface's own rotation,
// swing a camera turning it.
float planetLongitude(vec3 normal, float drift, float swing) {
  return atan(normal.x, normal.z) + drift + swing;
}

// Turbulent belts 0..1 (the subject's surface), at a point of the sphere and its longitude.
float planetBelts(vec3 normal, float lon, float foot) {
  return planetFbm(vec2(lon * 3.0, normal.y * 11.0), 11.0 * foot);
}

// Storm-swirled bands (the decoration's surface), in the frame tipped with the ring ('roll', as
// PlanetRing): x the band 0..1, y the storm eye 0..1; tm the motion clock. Coarse by design.
vec2 planetSwirl(vec2 q, float roll, float tm) {
  vec2 qt = rotate(q, -roll);
  vec2 sw = qt - vec2(-0.30, -0.28);
  float storm = bell(length(sw) / 0.38);
  vec2 qs = vec2(-0.30, -0.28) + rotate(sw, 2.6 * storm);
  float warp = fbm3(vec2(qs.x * 1.8 + 0.004 * tm, qs.y * 5.0));
  float band = 0.5 + 0.5 * sin(qs.y * 11.0 + warp * 5.0);
  return vec2(band, storm);
}

// Banded colour from planetSwirl: deep, mid and pale bands, the storm eye washed toward 'eye'.
vec3 planetBandColor(vec2 swirl, vec3 deep, vec3 mid, vec3 pale, vec3 eye) {
  vec3 base = mix(mix(deep, mid, smoothstep(0.1, 0.6, swirl.x)), pale, 0.8 * smoothstep(0.62, 0.95, swirl.x));
  return mix(base, eye, 0.35 * swirl.y);
}

// The cloud deck 0..1, drifting faster than the surface.
float planetClouds(vec3 normal, float lon, float tm, float foot) {
  return smoothstep(0.52, 0.72, planetFbm(vec2(lon * 4.0 + tm * 0.02, normal.y * 9.0) + vec2(5.0, 1.0), 9.0 * foot));
}

// Lightning flashing in the night-side clouds, 0..1: each cell on its own clock (t, the scene clock),
// 'level' the rate (0 none), cloud the deck there (planetClouds), diffuse the sunlight (clamped cosine).
float planetStorms(vec3 normal, float lon, float t, float level, float cloud, float diffuse, float foot) {
  vec2 cells = vec2(lon * 40.0, normal.y * 60.0);
  float k = planetCoarsen(1.0 / 60.0, foot);
  if (k > 0.0) cells /= exp2(k);
  vec2 stormCell = floor(cells);
  float strike = step(1.0 - 0.06 * level, hash12(stormCell + floor(t * 6.0 + hash12(stormCell) * 6.0)));
  return strike * step(0.001, level) * (0.4 + 0.6 * cloud) * smoothfall(0.35, 0.0, diffuse);
}

// City lights 0..1, before the night mask (planetNight): one town in 125 cells of a grid 90 across a
// radian of longitude and 140 to a radius; 'twinkle' makes them flicker on the scene clock t. On a far
// planet the grid coarsens and each larger cell is lit as often as any of the towns in it would be.
float planetCityLights(vec3 normal, float lon, float t, float twinkle, float foot) {
  vec2 cells = vec2(lon * 90.0, normal.y * 140.0);
  float k = planetCoarsen(1.0 / 140.0, foot);
  if (k > 0.0) cells /= exp2(k);
  vec2 city = floor(cells);
  float lights = step(k > 0.0 ? pow(0.992, exp2(2.0 * k)) : 0.992, hash12(city));
  return lights * (1.0 - twinkle * uMotion * (0.5 + 0.5 * sin(t * (1.0 + 3.0 * hash12(city + 7.0)) + hash12(city) * 40.0)));
}

// ---- aurora ----

// The auroral oval round 'pole' (unit, planet frame; the scene's choice, tipped toward the eye to be
// seen): a band 0.25..0.75 rad from it as 'size' goes 0..1, broken into drifting folds and patches.
// n: a unit direction from the centre (the surface normal, or vec3(q / d, 0.0) on the limb). 0..~1.
float planetAurora(vec3 n, vec3 pole, float size, float tm, float foot) {
  float colat = acos(clamp(dot(n, pole), -1.0, 1.0));
  vec3 e1 = normalize(cross(pole, abs(pole.z) < 0.99 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0)));
  vec3 e2 = cross(pole, e1);
  float az = atan(dot(n, e2), dot(n, e1));
  vec2 ring = vec2(cos(az), sin(az));
  float wobble = (fbm(ring * 2.2 + vec2(tm * 0.06, -tm * 0.04)) - 0.5) * 0.22;
  float oval = mix(0.25, 0.75, size);
  float band = bell((colat - oval - wobble) / 0.09);
  float folds = 0.55 + 0.45 * sin(az * 38.0 + fbm(ring * 3.0 + tm * 0.08) * 7.0 + tm * 0.4);
  // A fold is half a period of 38 round the oval: finer than a cell, they blur to an even glow.
  float keep = planetLod(3.14159 * sin(oval) / 38.0, foot);
  if (keep < 1.0) folds = mix(0.55, folds, keep);
  float mass = smoothstep(0.25, 0.7, fbm(ring * 4.0 + vec2(colat * 6.0, tm * 0.12)));
  return band * folds * mass;
}

// Where the oval meets the limb its curtains rise into space: 0..~1 at q beyond the disc (d > 1).
float planetAuroraCurtain(vec2 q, float d, vec3 pole, float size, float tm, float foot) {
  float height = d - 1.0;
  return planetAurora(vec3(q / d, 0.0), pole, size, tm, foot) * exp(-height / 0.06) * smoothstep(0.0, 0.008, height);
}

// ---- ring ----

// A ring plane through the centre (also the frame moons orbit near): facing is the cosine of its tilt
// to the line of sight (0 edge-on .. 1 seen from above), roll its turn on screen (radians, counter-
// clockwise). Its normal is the planet's axis.
struct PlanetRing { float facing; float roll; };

vec3 planetRingNormal(PlanetRing ring) {
  float facing = max(ring.facing, 0.02);
  vec3 n = vec3(0.0, sqrt(1.0 - facing * facing), facing);
  n.xy = rotate(n.xy, ring.roll);
  return n;
}

// The ring plane on the line of sight through q: xy that point in the plane's own coordinates (radii:
// its length is the distance from the centre, its angle turns with the ring), z its depth toward the
// eye (radii; > 0 the near side, in front of the disc's centre).
vec3 planetRingAt(PlanetRing ring, vec2 q) {
  float facing = max(ring.facing, 0.02);
  vec2 qt = rotate(q, -ring.roll);
  return vec3(qt.x, qt.y / facing, -qt.y * sqrt(1.0 - facing * facing) / facing);
}

// A point of the plane (planet frame) in the plane's coordinates, as planetRingAt gives them.
vec2 planetRingPlane(PlanetRing ring, vec3 point) {
  float facing = max(ring.facing, 0.02);
  vec2 e = vec2(cos(ring.roll), sin(ring.roll));
  return vec2(dot(point.xy, e), facing * dot(point.xy, vec2(-e.y, e.x)) - sqrt(1.0 - facing * facing) * point.z);
}

// Whether a point (planet frame) lies in the planet's shadow, the sun toward 'light'.
bool planetShadowed(vec3 point, vec3 light) {
  float along = dot(point, light);
  return along < 0.0 && length(point - along * light) < 1.0;
}

// Where the sunward ray from a point of the surface (its normal) crosses the ring plane, in the
// plane's coordinates: the ring's shadow on the planet. False where the ray leaves the plane behind.
bool planetRingShadowAt(PlanetRing ring, vec3 normal, vec3 light, out vec2 plane) {
  vec3 n = planetRingNormal(ring);
  float toward = dot(n, light);
  float s = -dot(n, normal) / (abs(toward) < 1e-3 ? 1e-3 : toward);
  plane = planetRingPlane(ring, normal + light * s);
  return s > 0.0;
}

// How much of what lies behind it a ring's cover hides.
float planetRingOpacity(float cover) {
  return min(cover * 1.4, 1.0);
}

// A banded ring system: inner and outer edge (radii), 'count' bands with 'spacing' (share of each band)
// between them, density 0..1, texture 0 dust (soft), 1 ice (fine grooves), 2 rock (separate boulders),
// spin the orbital speed (0 still; inner bands faster, as Kepler has it).
struct PlanetRingBands { float inner; float outer; float count; float spacing; float density; float texture; float spin; };

// Its cover 0..~1.2 at a point of the plane (planetRingAt or planetRingShadowAt); band: which band (0
// innermost), for alternating tones. foot: a cell in plane units (divide by the facing where the plane
// is foreshortened): band edges never sharpen below a cell, grooves and boulders too fine fade out.
float planetRingBands(vec2 plane, PlanetRingBands b, float tm, float foot, out float band) {
  band = 0.0;
  float rho = length(plane);
  float u = (rho - b.inner) / (b.outer - b.inner);
  if (u < 0.0 || u > 1.0) return 0.0;
  float count = max(b.count, 1.0);
  band = floor(u * count);
  float v = fract(u * count);
  float gap = b.spacing * 0.5;
  float soft = max(0.015 * count, foot * count / (b.outer - b.inner));
  float inBand = count < 1.5 ? 1.0 : smoothstep(gap, gap + soft, v) * smoothfall(1.0 - gap, 1.0 - gap - soft, v);
  // The texture rides along with the bands.
  float spin = b.spin * tm * 0.6 / pow(rho, 1.5);
  vec2 at = rotate(plane, -spin);
  int kind = int(b.texture + 0.5);
  float material;
  if (kind == 0) {
    material = (0.65 + 0.35 * vnoise(at * 7.0)) * b.density;
  } else if (kind == 1) {
    float grooves = sin(rho * 190.0);
    float keep = planetLod(3.14159 / 190.0, foot);
    if (keep < 1.0) grooves *= keep;
    material = (0.62 + 0.22 * grooves + 0.16 * (vnoise(vec2(rho * 120.0, 1.0)) - 0.5) + 0.12 * (vnoise(at * 18.0) - 0.5)) * b.density;
  } else {
    vec2 grid = at * 45.0;
    vec2 id = floor(grid);
    vec2 f = fract(grid) - 0.5 - (vec2(hash12(id), hash12(id + 7.0)) - 0.5) * 0.5;
    float size = 0.12 + 0.28 * hash12(id + 3.0);
    material = step(length(f), size) * step(1.0 - b.density * 0.9, hash12(id + 11.0)) * 1.2;
    // Boulders too small for a cell become their mean cover.
    float keep = planetLod(0.5 / 45.0, foot);
    if (keep < 1.0) material = mix(0.25 * b.density, material, keep);
  }
  return inBand * material * (0.6 + 0.4 * hash12(vec2(band, 5.0)));
}

// A thin ring of fine streaks from 1.32 to 2.12 radii with a dark gap at 1.72 (the decoration's ring):
// cover 0..1 at distance rho from the centre (length of planetRingAt(...).xy); streak 0..1 the
// streak's brightness there, for its colour. Coarse by design: it resolves at decoration sizes.
float planetRingThin(float rho, out float streak) {
  float body = smoothstep(1.32, 1.38, rho) * smoothfall(2.12, 2.05, rho);
  streak = clamp(0.6 + 0.4 * sin(rho * 30.0 + 1.0), 0.0, 1.0);
  return body * ((1.0 - 0.85 * bell((rho - 1.72) / 0.035)) * streak);
}

// ---- moons ----

// Moon i (0..2) of the family: its angular rate (radians per second of the motion clock), phase,
// orbit radius and own radius (planet radii), and its orbit's tilt and roll (as planetOrbit). The
// orbits lie near the plane 'frame', each inclined a little more off it than the last.
struct PlanetMoon { float rate; float phase; float distance; float size; float tilt; float roll; };

PlanetMoon planetMoon(int i, PlanetRing frame) {
  float fi = float(i);
  return PlanetMoon(0.06 - 0.014 * fi, 1.2 + fi * 0.9, 1.2 + 0.18 * fi, (0.016 + 0.01 * fi) / 1.12, frame.facing - 0.1 * fi, frame.roll + 0.15 * fi);
}

// A point on an inclined circular orbit about the centre at 'angle': tilt is the orbit's facing (the
// cosine of its inclination to the line of sight), roll its turn on screen. Planet frame.
vec3 planetOrbit(float angle, float radius, float tilt, float roll) {
  vec3 p = vec3(cos(angle) * radius, sin(angle) * radius * tilt, -sin(angle) * radius * sqrt(1.0 - tilt * tilt));
  p.xy = rotate(p.xy, roll);
  return p;
}

// Whether a point (planet frame) is hidden behind the planet's disc.
bool planetBehind(vec3 p) {
  float l2 = dot(p.xy, p.xy);
  return l2 < 1.0 && p.z < sqrt(1.0 - l2);
}

// Moon m's centre at the motion clock tm, its angle moved on by 'swing' and its orbit scaled by
// 'spread' (a passage's camera; 0 and 1 at rest).
vec3 planetMoonAt(PlanetMoon m, float tm, float swing, float spread) {
  return planetOrbit(tm * m.rate + m.phase + swing, m.distance * spread, m.tilt, m.roll);
}

// A moon's disc at q (centre from planetMoonAt, radius 'size'), lit from 'light': x its cover 0 or 1
// (0 behind the planet), y its light 0..1 (the lit side, mottled by 'seed'), z the depth of its surface
// there (for ring material in front of it). Never drawn smaller than a cell, so a far moon stays a
// point of light; its mottling fades out below four cells across.
vec3 planetMoonDisc(vec2 q, vec3 centre, float size, vec3 light, float seed, float foot) {
  float drawn = max(size, foot);
  vec2 mq = (q - centre.xy) / drawn;
  float md = length(mq);
  if (md >= 1.0 || planetBehind(centre)) return vec3(0.0);
  vec3 mn = vec3(mq, sqrt(1.0 - md * md));
  float mottle = 0.7 + 0.3 * vnoise(mq * 4.0 + seed * 9.0);
  float keep = planetLod(drawn * 0.5, foot);
  if (keep < 1.0) mottle = mix(0.85, mottle, keep);
  return vec3(1.0, max(dot(mn, light), 0.0) * mottle, centre.z + mn.z * drawn);
}

// The shadow a moon (centre, size) casts on the planet's near side at q, 0..1, the sun toward 'light'.
float planetMoonShadow(vec2 q, vec3 centre, float size, vec3 light) {
  float toward = dot(centre, light);
  float disc = toward * toward - dot(centre, centre) + 1.0;
  if (toward <= 0.0 || disc <= 0.0) return 0.0;
  vec3 hit = centre - light * (toward - sqrt(disc));
  return hit.z > 0.0 ? smoothfall(size * 1.25, size * 0.8, length(q - hit.xy)) : 0.0;
}

// ---- the decoration tier ----

// A whole ringed giant over an RGB sky, for a scene where it is scenery (campfire). The scene places
// and sizes it, gives its sun, how much of it shows (faded by daylight) and how dark the sky is (the
// glow round its limb), picks the features, and draws its own foreground over it afterwards.
// planetGiant fills in a teal banded giant with a pale thin ring and every feature off; set any field
// after (ringed 0 takes the ring away).
struct PlanetLook {
  vec2 centre; float radius;       // the scene's flat units
  vec3 light;                      // toward the sun (planetSun turns it for phases or a day cycle)
  float visible;                   // 0..1 how much of it shows
  float night;                     // 0..1 the sky's darkness, for the glow round its limb
  PlanetRing ring;                 // the thin ring's plane: the bands tip with it, the moons orbit near it
  vec3 deep; vec3 mid; vec3 pale; vec3 eye; // band colours and the storm eye (planetBandColor)
  vec3 rim; vec3 glow;             // the lit limb, the airglow round it
  vec3 ringDark; vec3 ringLight;   // the ring between its streaks and on them
  float ringed;                    // 1 the thin ring, 0 none
  float moons; float moonScale; float eclipses; vec3 moon; // 0..3 moons, drawn moonScale times their size, casting shadows (0/1)
  float aurora; float auroraSize; vec3 auroraColor;        // strength (0 off) and oval size (planetAurora)
  float lights; float twinkle; vec3 lightsColor;           // city lights (0/1) and their flicker
};

PlanetLook planetGiant(vec2 centre, float radius, vec3 light) {
  return PlanetLook(centre, radius, light, 1.0, 1.0, PlanetRing(0.20, 0.32),
    vec3(0.04, 0.20, 0.22), vec3(0.12, 0.45, 0.40), vec3(0.62, 0.78, 0.62), vec3(0.80, 0.86, 0.76),
    vec3(0.08, 0.30, 0.30), vec3(0.012, 0.034, 0.034), vec3(0.42, 0.35, 0.25), vec3(0.78, 0.68, 0.50), 1.0,
    0.0, 2.5, 1.0, vec3(0.62, 0.64, 0.66), 0.0, 0.4, vec3(0.25, 1.0, 0.55), 0.0, 0.0, vec3(0.9, 0.6, 0.3));
}

// The giant over 'col' at p (scene units; px a cell there), tm the motion clock, t the scene clock.
// Back to front: the glow round the limb, the ring's far half, aurora curtains off the limb, the disc
// (bands, phase light, city lights, aurora, moon shadows), the ring's near half, then the moons, each
// hidden behind the disc and under ring material nearer the eye.
vec3 planetOver(vec3 col, vec2 p, float px, PlanetLook look, float tm, float t) {
  PlanetPoint s = planetAt(p, look.centre, look.radius);
  vec2 q = s.q;
  if (abs(q.x) > 2.3 || abs(q.y) > 2.3) return col;
  float vis = look.visible;
  float foot = px / look.radius;
  vec3 ring = planetRingAt(look.ring, q);
  float streak;
  float ringBody = planetRingThin(length(ring.xy), streak);
  vec3 ringCol = mix(look.ringDark, look.ringLight, streak);
  float ringCover = hardEdge(ringBody * 0.85) * look.ringed;
  vec3 pole = planetRingNormal(look.ring);
  col += look.glow * planetGlow(s.d, 0.9) * look.night * vis;
  if (ring.z <= 0.0) col = mix(col, ringCol, ringCover * vis);
  float cover = hardFill((s.d - 1.0) * look.radius, px);
  if (cover > 0.5) {
    vec3 n = s.normal;
    float lit = smoothstep(-0.12, 0.62, dot(n, look.light));
    vec3 base = planetBandColor(planetSwirl(q, look.ring.roll, tm), look.deep, look.mid, look.pale, look.eye);
    vec3 disc = base * (0.10 + 0.95 * lit) * (0.55 + 0.45 * n.z);
    disc += look.rim * planetRim(n) * lit * 0.8;
    if (look.lights > 0.5 || look.aurora > 0.0) {
      float night = planetNight(max(dot(n, look.light), 0.0));
      if (look.lights > 0.5) disc += look.lightsColor * planetCityLights(n, planetLongitude(n, tm * 0.012, 0.0), t, look.twinkle, foot) * night;
      if (look.aurora > 0.0) disc += look.auroraColor * planetAurora(n, pole, look.auroraSize, tm, foot) * mix(0.6, 1.0, night) * look.aurora;
    }
    if (look.eclipses > 0.5) {
      for (int i = 0; i < 3; i++) {
        if (float(i) >= look.moons) break;
        PlanetMoon m = planetMoon(i, look.ring);
        disc *= 1.0 - 0.9 * planetMoonShadow(q, planetMoonAt(m, tm, 0.0, 1.0), m.size * look.moonScale, look.light);
      }
    }
    col = mix(col, disc, vis);
  } else if (look.aurora > 0.0) {
    col += look.auroraColor * planetAuroraCurtain(q, s.d, pole, look.auroraSize, tm, foot) * look.aurora * 1.2 * vis;
  }
  if (ring.z > 0.0) col = mix(col, ringCol, ringCover * vis);
  for (int i = 0; i < 3; i++) {
    if (float(i) >= look.moons) break;
    PlanetMoon m = planetMoon(i, look.ring);
    vec3 moon = planetMoonDisc(q, planetMoonAt(m, tm, 0.0, 1.0), m.size * look.moonScale, look.light, float(i), foot);
    if (moon.x > 0.5) {
      col = mix(col, look.moon * (0.08 + 0.85 * moon.y), vis);
      if (ring.z > moon.z) col = mix(col, ringCol, ringCover * vis);
    }
  }
  return col;
}
`;

type Vec3 = readonly [number, number, number];

/**
 * One palette of a sky planet's kind (planetBodyColours), display sRGB 0..1 as planetGiant's: its
 * surface's four tones, which each kind reads its own way (PLANET_BODY_KINDS), the lit limb, the
 * glow round it, and its ring between its streaks or bands and on them. `name` is the lab's word.
 */
export interface PlanetColours {
  readonly name: string;
  readonly deep: Vec3;
  readonly mid: Vec3;
  readonly pale: Vec3;
  readonly eye: Vec3;
  readonly rim: Vec3;
  readonly glow: Vec3;
  readonly ringDark: Vec3;
  readonly ringLight: Vec3;
}

/** The rings a sky planet can wear: none, planetOver's thin one, or a wide banded system. */
export const PLANET_RINGS = ["none", "thin", "wide"] as const;

/**
 * A kind of sky planet (planetBodyOver): its id (the GLSL constant PLANET_<ID>), the ring it comes
 * with (an index into PLANET_RINGS) and its four palettes.
 */
export interface PlanetBodyKind {
  readonly id: string;
  readonly ring: number;
  readonly palettes: readonly [PlanetColours, PlanetColours, PlanetColours, PlanetColours];
}

const colours = (
  name: string,
  [deep, mid, pale, eye]: readonly [Vec3, Vec3, Vec3, Vec3],
  [rim, glow]: readonly [Vec3, Vec3],
  [ringDark, ringLight]: readonly [Vec3, Vec3] = [
    [0.4, 0.4, 0.42],
    [0.8, 0.8, 0.8],
  ],
): PlanetColours => ({ name, deep, mid, pale, eye, rim, glow, ringDark, ringLight });

/**
 * Every kind of sky planet, in the order the URL and the shader number them (append only), and
 * how each reads its tones:
 *   banded   the giant planetOver draws: storm-swirled bands deep, mid and pale round an eye
 *            (campfire's teal first, then the night sky giant's amber, rose and ice)
 *   belted   a ringed giant after Orbit's: turbulent belts deep to mid, pale zones and a pale cloud
 *            deck, lightning in its night-side clouds in the eye colour; it comes with the wide ring
 *   rocky    mottled ground deep to pale, cratered, the craters' floors in the eye colour
 *   ocean    seas deep to mid, polar caps and swirling cloud pale, the sun's glint in the eye colour
 *   home     our own climate: land mid with deserts in the eye colour, seas deep, cloud, sea ice and
 *            snow pale, spreading and shrinking with its own year
 *   lava     a crust deep to mid split by molten cracks glowing pale to the eye colour
 *   crystal  flat facets between mid and pale over deep, sparkling in the eye colour
 *   eye      a white (pale) round an iris (mid) and pupil (deep), veined in the eye colour, its lids
 *            the rim colour
 *   bubble   a film between mid and pale (rainbow in the first palette), a heart in the eye colour
 */
export const PLANET_BODY_KINDS: readonly PlanetBodyKind[] = [
  {
    id: "banded",
    ring: 1,
    palettes: [
      colours(
        "teal",
        [
          [0.04, 0.2, 0.22],
          [0.12, 0.45, 0.4],
          [0.62, 0.78, 0.62],
          [0.8, 0.86, 0.76],
        ],
        [
          [0.08, 0.3, 0.3],
          [0.012, 0.034, 0.034],
        ],
        [
          [0.42, 0.35, 0.25],
          [0.78, 0.68, 0.5],
        ],
      ),
      colours(
        "amber",
        [
          [0.3, 0.13, 0.05],
          [0.78, 0.46, 0.16],
          [0.98, 0.84, 0.56],
          [1.0, 0.7, 0.42],
        ],
        [
          [0.45, 0.24, 0.08],
          [0.04, 0.022, 0.008],
        ],
        [
          [0.36, 0.38, 0.42],
          [0.8, 0.82, 0.86],
        ],
      ),
      colours(
        "rose",
        [
          [0.28, 0.07, 0.18],
          [0.7, 0.3, 0.46],
          [0.98, 0.76, 0.78],
          [1.0, 0.9, 0.82],
        ],
        [
          [0.42, 0.14, 0.28],
          [0.04, 0.014, 0.03],
        ],
        [
          [0.3, 0.34, 0.46],
          [0.7, 0.78, 0.92],
        ],
      ),
      colours(
        "ice",
        [
          [0.05, 0.12, 0.32],
          [0.26, 0.46, 0.78],
          [0.82, 0.92, 1.0],
          [0.96, 0.98, 1.0],
        ],
        [
          [0.18, 0.34, 0.62],
          [0.012, 0.024, 0.05],
        ],
        [
          [0.4, 0.46, 0.56],
          [0.86, 0.92, 1.0],
        ],
      ),
    ],
  },
  {
    id: "belted",
    ring: 2,
    palettes: [
      colours(
        "gold",
        [
          [0.42, 0.3, 0.16],
          [0.78, 0.64, 0.4],
          [0.96, 0.9, 0.74],
          [1.0, 0.95, 0.85],
        ],
        [
          [0.5, 0.4, 0.22],
          [0.03, 0.025, 0.012],
        ],
        [
          [0.45, 0.4, 0.32],
          [0.88, 0.8, 0.62],
        ],
      ),
      colours(
        "jade",
        [
          [0.06, 0.24, 0.18],
          [0.3, 0.6, 0.46],
          [0.78, 0.94, 0.84],
          [0.9, 1.0, 0.95],
        ],
        [
          [0.12, 0.36, 0.28],
          [0.012, 0.035, 0.026],
        ],
        [
          [0.3, 0.4, 0.38],
          [0.72, 0.86, 0.8],
        ],
      ),
      colours(
        "violet",
        [
          [0.2, 0.1, 0.32],
          [0.5, 0.36, 0.74],
          [0.86, 0.8, 0.98],
          [0.95, 0.92, 1.0],
        ],
        [
          [0.3, 0.18, 0.48],
          [0.026, 0.016, 0.045],
        ],
        [
          [0.36, 0.32, 0.46],
          [0.8, 0.74, 0.94],
        ],
      ),
      colours(
        "ash",
        [
          [0.16, 0.16, 0.18],
          [0.46, 0.46, 0.48],
          [0.86, 0.86, 0.84],
          [1.0, 1.0, 1.0],
        ],
        [
          [0.26, 0.26, 0.3],
          [0.02, 0.02, 0.024],
        ],
        [
          [0.34, 0.34, 0.36],
          [0.78, 0.78, 0.76],
        ],
      ),
    ],
  },
  {
    id: "rocky",
    ring: 0,
    palettes: [
      colours(
        "grey",
        [
          [0.2, 0.2, 0.21],
          [0.48, 0.47, 0.45],
          [0.78, 0.77, 0.73],
          [0.3, 0.29, 0.28],
        ],
        [
          [0.1, 0.1, 0.1],
          [0.0, 0.0, 0.0],
        ],
      ),
      colours(
        "rust",
        [
          [0.3, 0.12, 0.06],
          [0.7, 0.36, 0.18],
          [0.92, 0.66, 0.44],
          [0.42, 0.18, 0.09],
        ],
        [
          [0.3, 0.12, 0.06],
          [0.02, 0.008, 0.004],
        ],
      ),
      colours(
        "ochre",
        [
          [0.3, 0.24, 0.12],
          [0.66, 0.56, 0.32],
          [0.9, 0.84, 0.62],
          [0.4, 0.32, 0.18],
        ],
        [
          [0.2, 0.16, 0.08],
          [0.0, 0.0, 0.0],
        ],
      ),
      colours(
        "basalt",
        [
          [0.08, 0.09, 0.12],
          [0.26, 0.28, 0.34],
          [0.56, 0.6, 0.68],
          [0.14, 0.15, 0.19],
        ],
        [
          [0.1, 0.12, 0.16],
          [0.0, 0.0, 0.0],
        ],
      ),
    ],
  },
  {
    id: "ocean",
    ring: 0,
    palettes: [
      colours(
        "ocean",
        [
          [0.03, 0.1, 0.3],
          [0.08, 0.3, 0.58],
          [0.92, 0.96, 1.0],
          [1.0, 1.0, 0.95],
        ],
        [
          [0.2, 0.42, 0.8],
          [0.016, 0.032, 0.07],
        ],
        [
          [0.4, 0.46, 0.56],
          [0.86, 0.92, 1.0],
        ],
      ),
      colours(
        "teal",
        [
          [0.02, 0.18, 0.22],
          [0.08, 0.46, 0.48],
          [0.86, 0.98, 0.96],
          [1.0, 1.0, 1.0],
        ],
        [
          [0.12, 0.46, 0.48],
          [0.01, 0.04, 0.045],
        ],
        [
          [0.36, 0.46, 0.46],
          [0.8, 0.94, 0.92],
        ],
      ),
      colours(
        "frost",
        [
          [0.4, 0.58, 0.72],
          [0.68, 0.84, 0.92],
          [0.97, 0.99, 1.0],
          [1.0, 1.0, 1.0],
        ],
        [
          [0.5, 0.7, 0.9],
          [0.02, 0.035, 0.05],
        ],
        [
          [0.4, 0.46, 0.56],
          [0.86, 0.92, 1.0],
        ],
      ),
      colours(
        "violet",
        [
          [0.12, 0.05, 0.3],
          [0.36, 0.22, 0.62],
          [0.9, 0.86, 1.0],
          [1.0, 0.95, 1.0],
        ],
        [
          [0.4, 0.28, 0.8],
          [0.03, 0.018, 0.06],
        ],
        [
          [0.36, 0.32, 0.5],
          [0.82, 0.76, 0.98],
        ],
      ),
    ],
  },
  {
    id: "home",
    ring: 0,
    palettes: [
      colours(
        "earth",
        [
          [0.04, 0.12, 0.34],
          [0.2, 0.42, 0.16],
          [0.95, 0.97, 1.0],
          [0.74, 0.62, 0.38],
        ],
        [
          [0.24, 0.48, 0.92],
          [0.02, 0.04, 0.09],
        ],
      ),
      colours(
        "arid",
        [
          [0.05, 0.14, 0.3],
          [0.52, 0.4, 0.2],
          [0.95, 0.95, 0.92],
          [0.86, 0.62, 0.34],
        ],
        [
          [0.4, 0.4, 0.7],
          [0.03, 0.03, 0.05],
        ],
      ),
      colours(
        "lush",
        [
          [0.03, 0.16, 0.3],
          [0.1, 0.46, 0.2],
          [0.94, 0.98, 0.96],
          [0.4, 0.56, 0.22],
        ],
        [
          [0.22, 0.56, 0.8],
          [0.016, 0.045, 0.07],
        ],
      ),
      colours(
        "ice age",
        [
          [0.06, 0.14, 0.3],
          [0.3, 0.4, 0.3],
          [0.96, 0.98, 1.0],
          [0.62, 0.6, 0.52],
        ],
        [
          [0.4, 0.56, 0.86],
          [0.025, 0.04, 0.08],
        ],
      ),
    ],
  },
  {
    id: "lava",
    ring: 0,
    palettes: [
      colours(
        "magma",
        [
          [0.06, 0.04, 0.035],
          [0.2, 0.13, 0.1],
          [1.0, 0.42, 0.08],
          [1.0, 0.86, 0.4],
        ],
        [
          [0.4, 0.1, 0.02],
          [0.08, 0.025, 0.005],
        ],
      ),
      colours(
        "sulphur",
        [
          [0.1, 0.09, 0.04],
          [0.34, 0.3, 0.12],
          [0.86, 0.92, 0.18],
          [1.0, 1.0, 0.6],
        ],
        [
          [0.3, 0.3, 0.04],
          [0.05, 0.05, 0.008],
        ],
      ),
      colours(
        "cobalt",
        [
          [0.03, 0.04, 0.08],
          [0.12, 0.14, 0.22],
          [0.2, 0.5, 1.0],
          [0.7, 0.9, 1.0],
        ],
        [
          [0.06, 0.14, 0.4],
          [0.01, 0.03, 0.08],
        ],
      ),
      colours(
        "ember",
        [
          [0.08, 0.02, 0.02],
          [0.22, 0.07, 0.06],
          [0.9, 0.1, 0.06],
          [1.0, 0.5, 0.3],
        ],
        [
          [0.36, 0.04, 0.03],
          [0.07, 0.01, 0.008],
        ],
      ),
    ],
  },
  {
    id: "crystal",
    ring: 1,
    palettes: [
      colours(
        "amethyst",
        [
          [0.22, 0.08, 0.36],
          [0.52, 0.28, 0.8],
          [0.86, 0.72, 1.0],
          [1.0, 0.95, 1.0],
        ],
        [
          [0.5, 0.3, 0.9],
          [0.03, 0.015, 0.05],
        ],
        [
          [0.4, 0.32, 0.5],
          [0.86, 0.78, 0.98],
        ],
      ),
      colours(
        "emerald",
        [
          [0.02, 0.24, 0.12],
          [0.1, 0.62, 0.36],
          [0.62, 1.0, 0.78],
          [0.95, 1.0, 0.95],
        ],
        [
          [0.1, 0.6, 0.4],
          [0.01, 0.04, 0.025],
        ],
        [
          [0.3, 0.44, 0.36],
          [0.74, 0.94, 0.82],
        ],
      ),
      colours(
        "quartz",
        [
          [0.4, 0.44, 0.52],
          [0.7, 0.76, 0.84],
          [0.96, 0.98, 1.0],
          [1.0, 1.0, 1.0],
        ],
        [
          [0.6, 0.7, 0.85],
          [0.03, 0.035, 0.045],
        ],
      ),
      colours(
        "ruby",
        [
          [0.3, 0.02, 0.06],
          [0.76, 0.1, 0.2],
          [1.0, 0.56, 0.62],
          [1.0, 0.92, 0.92],
        ],
        [
          [0.7, 0.1, 0.2],
          [0.05, 0.006, 0.012],
        ],
        [
          [0.42, 0.3, 0.32],
          [0.9, 0.76, 0.78],
        ],
      ),
    ],
  },
  {
    id: "eye",
    ring: 0,
    palettes: [
      colours(
        "blue",
        [
          [0.02, 0.02, 0.04],
          [0.2, 0.48, 0.86],
          [0.94, 0.92, 0.88],
          [0.8, 0.16, 0.14],
        ],
        [
          [0.62, 0.42, 0.38],
          [0.02, 0.02, 0.03],
        ],
      ),
      colours(
        "green",
        [
          [0.02, 0.03, 0.02],
          [0.24, 0.62, 0.3],
          [0.94, 0.92, 0.88],
          [0.8, 0.16, 0.14],
        ],
        [
          [0.62, 0.42, 0.38],
          [0.02, 0.03, 0.02],
        ],
      ),
      colours(
        "amber",
        [
          [0.03, 0.02, 0.01],
          [0.86, 0.56, 0.12],
          [0.94, 0.92, 0.88],
          [0.8, 0.16, 0.14],
        ],
        [
          [0.62, 0.42, 0.38],
          [0.03, 0.02, 0.01],
        ],
      ),
      colours(
        "violet",
        [
          [0.03, 0.01, 0.04],
          [0.56, 0.26, 0.86],
          [0.94, 0.92, 0.88],
          [0.8, 0.16, 0.14],
        ],
        [
          [0.62, 0.42, 0.38],
          [0.025, 0.012, 0.035],
        ],
      ),
    ],
  },
  {
    id: "bubble",
    ring: 0,
    palettes: [
      colours(
        "soap",
        [
          [0.5, 0.5, 0.6],
          [0.9, 0.9, 1.0],
          [1.0, 1.0, 1.0],
          [0.9, 0.95, 1.0],
        ],
        [
          [0.6, 0.7, 0.9],
          [0.02, 0.025, 0.035],
        ],
      ),
      colours(
        "jelly",
        [
          [0.6, 0.2, 0.4],
          [1.0, 0.52, 0.72],
          [1.0, 0.86, 0.92],
          [1.0, 0.6, 0.8],
        ],
        [
          [0.8, 0.3, 0.5],
          [0.05, 0.015, 0.03],
        ],
      ),
      colours(
        "lime",
        [
          [0.3, 0.56, 0.1],
          [0.62, 0.96, 0.3],
          [0.92, 1.0, 0.8],
          [0.8, 1.0, 0.5],
        ],
        [
          [0.4, 0.8, 0.2],
          [0.025, 0.05, 0.012],
        ],
      ),
      colours(
        "ink",
        [
          [0.12, 0.06, 0.24],
          [0.34, 0.18, 0.56],
          [0.82, 0.7, 1.0],
          [0.6, 0.4, 1.0],
        ],
        [
          [0.4, 0.2, 0.7],
          [0.02, 0.012, 0.04],
        ],
      ),
    ],
  },
];

const kindConstants = PLANET_BODY_KINDS.map(
  (kind, index) => `const int PLANET_${kind.id.toUpperCase()} = ${index};`,
).join("\n");
/**
 * planetBodyColours' cases, one per palette of every kind (index kind * 4 + palette): a chain of
 * branches rather than a const table, which a software rasteriser would build afresh for every
 * pixel of the program, near a planet or not.
 */
const colourCases = PLANET_BODY_KINDS.flatMap((kind) => kind.palettes)
  .map((palette, at) => {
    const set = (["deep", "mid", "pale", "eye", "rim", "glow", "ringDark", "ringLight"] as const)
      .map((name) => `look.${name} = ${glslVec3(palette[name])};`)
      .join(" ");
    return `  ${at === 0 ? "if" : "else if"} (at == ${at}) { ${set} }`;
  })
  .join("\n");

export const planetBodyGlsl = `
// ---- the body tier: the sky's planets ----

// The kinds (PLANET_BODY_KINDS in shaders/lib/planet.ts); each kind's four palettes are
// planetBodyColours' (deep, mid, pale, eye, rim, glow, ring dark, ring light).
${kindConstants}

// A sky planet: the decoration tier's look (PlanetLook: where it stands, its light, its ring's plane,
// its features; planetBodyColours its colours) and what the body tier adds: its kind and palette, its
// ring (PLANET_RINGS: 0 none, 1 planetOver's thin one, 2 a wide banded system), a seed of its own,
// and its own clock (the motion clock times its spin), which turns its surface and carries its moons
// and ring material round.
struct PlanetBody {
  PlanetLook look;
  int kind;
  int palette;
  int ring;
  float seed;
  float clock;
};

// look's colours: palette 'palette' of kind 'kind'.
void planetBodyColours(inout PlanetLook look, int kind, int palette) {
  int at = kind * 4 + palette;
${colourCases}
}

// What a kind shows at a point of its disc: its colour before the light, the light it gives off
// itself (molten cracks, a storm's flash, a glint), the normal the light falls on (a crystal's facet)
// and how much of the sky behind it hides (all of it, but through a bubble).
struct PlanetFace { vec3 base; vec3 glow; vec3 normal; float cover; };

// A point of the sphere (planet frame) in the planet's own: y up its axis (the ring plane's normal,
// the moons' and the aurora's), x and z round its equator, z the side toward the eye.
vec3 planetSpun(vec3 n, PlanetRing ring) {
  vec3 pole = planetRingNormal(ring);
  vec3 e1 = vec3(cos(ring.roll), sin(ring.roll), 0.0);
  return vec3(dot(n, e1), dot(n, pole), dot(n, cross(e1, pole)));
}

// Longitude in the planet's own frame, turned on by 'turn' radians: the seam stays behind the planet,
// so a turn slides its surface round without ever showing where the ends meet.
float planetTurned(vec3 m, float turn) {
  return atan(m.x, m.z) + turn;
}

// A point in the planet's own frame turned 'turn' radians about its axis, as planetTurned turns it.
vec3 planetTurn(vec3 m, float turn) {
  vec2 r = rotate(m.xz, -turn);
  return vec3(r.x, m.y, r.y);
}

float planetHash3(vec3 p) {
  return hash12(p.xy + p.z * vec2(37.17, 17.31));
}

// Half-way between the light and the eye: a glint's direction.
vec3 planetHalfway(vec3 light) {
  return normalize(light + vec3(0.0, 0.0, 1.0));
}

// Craters over the sphere (m: a point of it, the planet's own frame turned), from a 3D grid k cells to
// a radius, each of which may hold one: x the dark floor, y the bright rim, 0..1; one too small for a
// cell (foot, a cell in radii) fades out.
vec2 planetCraters(vec3 m, float k, float foot, float seed) {
  vec3 p = m * k + seed * 7.13;
  vec3 id = floor(p);
  vec3 f = fract(p) - 0.5 - 0.3 * (vec3(planetHash3(id + 1.3), planetHash3(id + 2.7), planetHash3(id + 4.1)) - 0.5);
  float r = 0.16 + 0.14 * planetHash3(id + 6.2);
  float d = length(f) / r;
  float keep = planetLod(2.0 * r / k, foot) * step(0.4, planetHash3(id));
  return vec2(smoothfall(1.0, 0.7, d), bell((d - 1.08) / 0.25)) * keep;
}

// The banded giant: planetOver's storm-swirled bands, tipped with the ring.
PlanetFace planetBanded(PlanetBody b, vec2 q, vec3 n) {
  PlanetLook l = b.look;
  return PlanetFace(planetBandColor(planetSwirl(q, l.ring.roll, b.clock), l.deep, l.mid, l.pale, l.eye), vec3(0.0), n, 1.0);
}

// The ringed giant after Orbit's, at backdrop scale: bands of latitude bent by turbulent belts
// (deep and mid, pale zones), an oval storm in its eye colour riding a southern belt, a faster
// cloud deck, and lightning in the night side's clouds while the scene moves (diffuse: the
// sunlight's clamped cosine). Bands too fine for a cell fade to their mean.
PlanetFace planetBelted(PlanetBody b, vec3 n, float diffuse, float foot, float t) {
  PlanetLook l = b.look;
  vec3 m = planetSpun(n, l.ring);
  float lon = planetTurned(m, b.clock * 0.012 + b.seed * 2.3);
  // The turbulence calms toward the poles, where the longitude it is drawn in closes up.
  float calm = 1.0 - m.y * m.y;
  float zone = sin(m.y * 10.0 + (planetBelts(m, lon, foot) - 0.5) * 5.0 * calm);
  float keep = planetLod(0.314, foot);
  if (keep < 1.0) zone *= keep;
  vec3 base = mix(l.deep, l.mid, smoothstep(-0.5, 0.5, zone));
  base = mix(base, l.pale, 0.6 * smoothstep(0.55, 0.95, zone));
  float oval = bell(length(vec2(lon - 0.6, (m.y + 0.36) * 2.6)) / 0.26);
  base = mix(base, mix(l.deep, l.eye, 0.45), 0.75 * oval);
  float cloud = planetClouds(m, lon + b.clock * 0.008, b.clock, foot);
  base = mix(base, l.pale, 0.55 * cloud * calm);
  float storm = planetStorms(m, lon, t, 0.5 * step(0.001, uMotion), cloud, diffuse, foot);
  return PlanetFace(base, l.eye * storm * 0.9, n, 1.0);
}

// The rocky world: mottled ground, pocked by craters of two sizes, dark floors under bright rims.
PlanetFace planetRocky(PlanetBody b, vec3 n, float foot) {
  PlanetLook l = b.look;
  float turn = b.clock * 0.04;
  vec3 m = planetSpun(n, l.ring);
  float ground = planetFbm(vec2(planetTurned(m, turn) * 2.2, m.y * 3.4) + b.seed * 5.1, 3.4 * foot);
  vec3 base = mix(l.deep, l.mid, smoothstep(0.32, 0.5, ground));
  base = mix(base, l.pale, 0.7 * smoothstep(0.6, 0.8, ground));
  vec3 at = planetTurn(m, turn);
  vec2 big = planetCraters(at, 1.8, foot, b.seed);
  vec2 small = planetCraters(at, 4.2, foot, b.seed + 3.0);
  base = mix(base, l.eye, 0.9 * max(big.x, 0.85 * small.x));
  base = mix(base, l.pale, 0.85 * max(big.y, 0.7 * small.y));
  return PlanetFace(base, vec3(0.0), n, 1.0);
}

// The ocean world: deep and shallow seas, ragged polar caps, cloud wound into swirls, and the sun's
// glint on open water.
PlanetFace planetOcean(PlanetBody b, vec3 n, vec3 light, float foot) {
  PlanetLook l = b.look;
  vec3 m = planetSpun(n, l.ring);
  float lon = planetTurned(m, b.clock * 0.03);
  float depth = planetFbm(vec2(lon * 1.8, m.y * 2.8) + b.seed * 3.3, 2.8 * foot);
  vec3 base = mix(l.deep, l.mid, smoothstep(0.35, 0.75, depth));
  float edge = 0.74 + 0.16 * (planetFbm(vec2(lon * 3.0, m.y * 3.0) + 9.0, 3.0 * foot) - 0.5);
  float cap = smoothstep(edge, edge + 0.03 + foot, abs(m.y));
  vec2 sw = vec2(lon * 2.0 + b.clock * 0.01, m.y * 4.0);
  float cloud = smoothstep(0.56, 0.72, planetFbm(sw + 0.8 * vec2(sin(sw.y * 1.3 + b.seed), cos(sw.x * 0.9)), 4.0 * foot));
  base = mix(base, l.pale, max(cap, 0.85 * cloud));
  float glint = pow(max(dot(n, planetHalfway(light)), 0.0), 28.0) * (1.0 - cap) * (1.0 - cloud);
  return PlanetFace(base, l.eye * glint * 0.7, n, 1.0);
}

// The home-like world, with our own climate: continents (deserts toward the tropics) over seas, a
// cloud deck, and a year of its own, one every two minutes of its clock, its hemispheres half a year
// apart, in which the cold of the time of year (climateCold, climateLying: src/climate.ts) spreads sea
// ice and snow out from its poles into winter and takes them back by summer. Palette 1 (arid) has
// more land, 2 (lush) more sea, and 3 (ice age) lies under more snow all year.
PlanetFace planetHome(PlanetBody b, vec3 n, vec3 light, float foot) {
  PlanetLook l = b.look;
  vec3 m = planetSpun(n, l.ring);
  float lon = planetTurned(m, b.clock * 0.05);
  float lift = planetFbm(vec2(lon * 1.5, m.y * 2.4) + b.seed * 4.7, 2.4 * foot);
  float shore = b.palette == 1 ? 0.46 : b.palette == 2 ? 0.54 : 0.5;
  float land = smoothstep(shore, shore + 0.02 + foot, lift);
  float wild = planetFbm(vec2(lon * 4.0, m.y * 6.0) + 7.0, 6.0 * foot);
  float dry = smoothstep(0.48, 0.62, wild) * smoothfall(0.5, 0.3, abs(m.y));
  vec3 base = mix(l.deep, mix(l.mid, l.eye, dry), land);
  float year = fract(b.clock / 120.0 + b.seed * 0.37);
  float cold = climateCold(m.y > 0.0 ? year : fract(year + 0.5));
  float lying = min(climateLying(cold) / ${glslFloat(WINTER_COVER)} + (b.palette == 3 ? 0.45 : 0.0), 1.0);
  float reach = abs(m.y) + 0.06 * (wild - 0.5);
  float seaIce = smoothstep(0.88 - 0.24 * lying, 0.91 - 0.24 * lying, reach);
  float snow = smoothstep(0.8 - 0.4 * lying, 0.84 - 0.4 * lying, reach);
  base = mix(base, l.pale, mix(seaIce, snow, land));
  float cloud = planetClouds(m, lon + b.clock * 0.01, b.clock, foot);
  base = mix(base, l.pale, 0.8 * cloud);
  float glint = pow(max(dot(n, planetHalfway(light)), 0.0), 28.0) * (1.0 - land) * (1.0 - seaIce) * (1.0 - cloud);
  return PlanetFace(base, vec3(0.9, 0.92, 0.85) * glint * 0.6, n, 1.0);
}

// The lava world: a dark crust split by molten cracks, at least a cell wide, that glow on its night
// side too and pulse slowly.
PlanetFace planetLava(PlanetBody b, vec3 n, float foot) {
  PlanetLook l = b.look;
  vec3 m = planetSpun(n, l.ring);
  vec2 at = vec2(planetTurned(m, b.clock * 0.03) * 2.0, m.y * 3.2) + b.seed * 6.1;
  float crust = planetFbm(at * 1.7 + 4.0, 5.4 * foot);
  float flow = planetFbm(at, 3.2 * foot);
  float width = max(0.04, 3.0 * foot);
  float crack = smoothfall(width, 0.35 * width, abs(flow - 0.5));
  float pulse = 0.8 + 0.2 * sin(b.clock * 1.3 + flow * 30.0);
  vec3 base = mix(l.deep, l.mid, smoothstep(0.35, 0.75, crust)) * (1.0 - 0.8 * crack);
  return PlanetFace(base, mix(l.pale, l.eye, crack * crack) * crack * pulse, n, 1.0);
}

// The crystal world: the sphere cut flat into facets (rounded onto a grid of directions), each its own
// shade and lit flat, glinting, now and then one sparkling.
PlanetFace planetCrystal(PlanetBody b, vec3 n, vec3 light) {
  PlanetLook l = b.look;
  float turn = b.clock * 0.05;
  vec3 cell = floor(planetTurn(planetSpun(n, l.ring), turn) * 1.7 + 0.5);
  vec3 f = normalize(cell);
  // The facet's normal back in the planet frame: turned back, then out of the planet's own frame.
  vec2 r = rotate(f.xz, turn);
  vec3 pole = planetRingNormal(l.ring);
  vec3 e1 = vec3(cos(l.ring.roll), sin(l.ring.roll), 0.0);
  vec3 facet = r.x * e1 + f.y * pole + r.y * cross(e1, pole);
  float h = planetHash3(cell + b.seed);
  vec3 base = mix(l.deep, mix(l.mid, l.pale, h), 0.45 + 0.55 * h);
  float glint = pow(max(dot(facet, planetHalfway(light)), 0.0), 40.0);
  float sparkle = step(0.97, planetHash3(cell + floor(b.clock * 1.5) + b.seed)) * max(dot(facet, light), 0.0);
  return PlanetFace(base, l.eye * (0.9 * glint + 0.5 * sparkle), facet, 1.0);
}

// The eye world: a white round an iris and pupil that gaze about the eye on its clock, veins toward
// the back, a catchlight, and now and then its lids blinking shut.
PlanetFace planetEye(PlanetBody b, vec3 n, vec3 light, float foot) {
  PlanetLook l = b.look;
  float w = b.clock * 0.25 + b.seed * 2.1;
  vec3 gaze = normalize(vec3(0.42 * sin(w) + 0.12 * sin(w * 2.3), 0.28 * sin(w * 0.7 + 1.3), 1.0));
  float a = acos(clamp(dot(n, gaze), -1.0, 1.0));
  float soft = max(foot, 0.02);
  vec3 e1 = normalize(cross(vec3(0.0, 1.0, 0.0), gaze));
  float az = atan(dot(n, cross(gaze, e1)), dot(n, e1));
  float stripes = 0.7 + 0.3 * sin(az * 22.0) * (0.6 + 0.4 * sin(az * 5.0 + b.seed));
  float keep = planetLod(0.45 * 3.14159 / 22.0, foot);
  if (keep < 1.0) stripes = mix(0.82, stripes, keep);
  vec3 iris = l.mid * stripes * mix(1.0, 0.45, smoothstep(0.3, 0.45, a));
  // Veins: the middle line of a smooth field (no octave finer than a sixth of a radius), a cell wide.
  float vein = smoothfall(max(0.03, 1.5 * foot), 0.0, abs(planetFbm(n.xy * 2.2 + b.seed * 2.7, max(3.0 * foot, 0.5)) - 0.5)) * smoothstep(1.0, 1.5, a);
  vec3 base = mix(l.pale, l.eye, 0.6 * vein);
  base = mix(base, iris, smoothfall(0.45 + soft, 0.45 - soft, a));
  base = mix(base, l.deep, smoothfall(0.17 + soft, 0.17 - soft, a));
  float blink = fract(b.clock * 0.08 + b.seed * 0.29);
  float shut = smoothstep(0.0, 0.012, blink) * smoothfall(0.03, 0.018, blink);
  float lid = step(1.0 - 1.05 * shut, abs(n.y));
  base = mix(base, l.rim, lid);
  float glint = pow(max(dot(n, planetHalfway(light)), 0.0), 60.0) * (1.0 - lid);
  return PlanetFace(base, vec3(glint), n, 1.0);
}

// The bubble world: a thin film whose swirls drift over it, thicker toward its rim, the sky showing
// through; a soft heart drifts inside and the sun glints off it. Rainbow in palette 0.
PlanetFace planetBubble(PlanetBody b, vec2 q, vec3 n, vec3 light, float foot) {
  PlanetLook l = b.look;
  float edge = pow(1.0 - n.z, 1.6);
  float film = planetFbm(q * 1.6 + vec2(b.clock * 0.02, -b.clock * 0.015) + b.seed * 3.0, 1.6 * foot) + 0.6 * n.z;
  vec3 tint = b.palette == 0 ? 0.55 + 0.45 * cos(6.2831853 * (film * 1.6 + vec3(0.0, 0.33, 0.67))) : mix(l.mid, l.pale, smoothstep(0.3, 0.9, film));
  vec2 drift = 0.25 * vec2(sin(b.clock * 0.11 + b.seed), cos(b.clock * 0.08 + b.seed * 1.7));
  float heart = bell(length(q - drift) / 0.45);
  float glint = pow(max(dot(n, planetHalfway(light)), 0.0), 50.0);
  return PlanetFace(tint, l.eye * heart * 0.35 + vec3(0.9 * glint) + tint * edge * 0.35, n, 0.1 + 0.8 * edge);
}

// The face of planet b at q on its disc (n the sphere's normal there). One kind per planet, each in a
// loop of at most one turn: a software rasteriser runs every line of a branch whichever way its pixels
// go, but no turn of a loop none of them enters, so a pixel pays for the kinds on screen only.
PlanetFace planetBodyFace(PlanetBody b, vec2 q, vec3 n, float foot, float t) {
  vec3 light = b.look.light;
  int k = b.kind;
  PlanetFace face = PlanetFace(b.look.mid, vec3(0.0), n, 1.0);
  for (int i = 0; i < (k == PLANET_BANDED ? 1 : 0); i++) face = planetBanded(b, q, n);
  for (int i = 0; i < (k == PLANET_BELTED ? 1 : 0); i++) face = planetBelted(b, n, max(dot(n, light), 0.0), foot, t);
  for (int i = 0; i < (k == PLANET_ROCKY ? 1 : 0); i++) face = planetRocky(b, n, foot);
  for (int i = 0; i < (k == PLANET_OCEAN ? 1 : 0); i++) face = planetOcean(b, n, light, foot);
  for (int i = 0; i < (k == PLANET_HOME ? 1 : 0); i++) face = planetHome(b, n, light, foot);
  for (int i = 0; i < (k == PLANET_LAVA ? 1 : 0); i++) face = planetLava(b, n, foot);
  for (int i = 0; i < (k == PLANET_CRYSTAL ? 1 : 0); i++) face = planetCrystal(b, n, light);
  for (int i = 0; i < (k == PLANET_EYE ? 1 : 0); i++) face = planetEye(b, n, light, foot);
  for (int i = 0; i < (k == PLANET_BUBBLE ? 1 : 0); i++) face = planetBubble(b, q, n, light, foot);
  return face;
}

// The wide banded ring: five bands of dust from 1.3 to 2.2 radii, turning as Kepler has it (smooth
// material reads at backdrop scale where ice's grooves and rock's boulders only speckle).
const PlanetRingBands PLANET_WIDE_RING = PlanetRingBands(1.3, 2.2, 5.0, 0.22, 0.9, 0.0, 0.4);

// Planet b's ring at q ('at' its plane there, planetRingAt): its colour, and in 'cover' how much of
// what lies behind it hides. Thin: planetOver's, all or nothing per cell; wide: PLANET_WIDE_RING's
// bands, alternately dark and light, as thick as their material, in the planet's shadow behind it;
// none: nothing.
vec3 planetBodyRing(PlanetBody b, vec2 q, vec3 at, float foot, out float cover) {
  PlanetLook l = b.look;
  if (b.ring == 2) {
    float band;
    float body = planetRingBands(at.xy, PLANET_WIDE_RING, b.clock, foot / max(l.ring.facing, 0.02), band);
    vec3 colour = mix(l.ringDark, l.ringLight, mod(band, 2.0) > 0.5 ? 0.45 : 0.9);
    if (planetShadowed(vec3(q, at.z), l.light)) colour *= 0.18;
    cover = min(planetRingOpacity(body) * 1.25, 1.0);
    return colour;
  }
  float streak;
  float body = planetRingThin(length(at.xy), streak);
  cover = hardEdge(body * 0.85) * l.ringed;
  return mix(l.ringDark, l.ringLight, streak);
}

// Planet b over 'col' at p (scene units; px a cell there), t the scene clock, drawn as planetOver
// draws its giant, back to front (the glow round the limb, the ring's far half, aurora curtains off
// the limb, the disc, the ring's near half, then the moons), with its kind's face on the disc, lit by
// the face's normal, and a wide ring's shadow across it. A banded planet with a thin ring or none is
// planetOver's giant on the planet's own clock.
vec3 planetBodyOver(vec3 col, vec2 p, float px, PlanetBody b, float t) {
  PlanetLook look = b.look;
  float tm = b.clock;
  PlanetPoint s = planetAt(p, look.centre, look.radius);
  vec2 q = s.q;
  if (abs(q.x) > 2.3 || abs(q.y) > 2.3) return col;
  float vis = look.visible;
  float foot = px / look.radius;
  vec3 ring = planetRingAt(look.ring, q);
  float ringCover;
  vec3 ringCol = planetBodyRing(b, q, ring, foot, ringCover);
  vec3 pole = planetRingNormal(look.ring);
  col += look.glow * planetGlow(s.d, 0.9) * look.night * vis;
  if (ring.z <= 0.0) col = mix(col, ringCol, ringCover * vis);
  float cover = hardFill((s.d - 1.0) * look.radius, px);
  if (cover > 0.5) {
    vec3 n = s.normal;
    PlanetFace face = planetBodyFace(b, q, n, foot, t);
    float lit = smoothstep(-0.12, 0.62, dot(face.normal, look.light));
    vec3 disc = face.base * (0.10 + 0.95 * lit) * (0.55 + 0.45 * n.z);
    disc += look.rim * planetRim(n) * lit * 0.8;
    if (look.lights > 0.5 || look.aurora > 0.0) {
      float night = planetNight(max(dot(n, look.light), 0.0));
      if (look.lights > 0.5) disc += look.lightsColor * planetCityLights(n, planetLongitude(n, tm * 0.012, 0.0), t, look.twinkle, foot) * night;
      if (look.aurora > 0.0) disc += look.auroraColor * planetAurora(n, pole, look.auroraSize, tm, foot) * mix(0.6, 1.0, night) * look.aurora;
    }
    if (look.eclipses > 0.5) {
      for (int i = 0; i < 3; i++) {
        if (float(i) >= look.moons) break;
        PlanetMoon m = planetMoon(i, look.ring);
        disc *= 1.0 - 0.9 * planetMoonShadow(q, planetMoonAt(m, tm, 0.0, 1.0), m.size * look.moonScale, look.light);
      }
    }
    vec2 shadowAt;
    if (b.ring == 2 && planetRingShadowAt(look.ring, n, look.light, shadowAt)) {
      float band;
      disc *= 1.0 - 0.7 * min(planetRingBands(shadowAt, PLANET_WIDE_RING, tm, foot, band) * 1.3, 1.0);
    }
    col = mix(col, disc + face.glow, vis * face.cover);
  } else if (look.aurora > 0.0) {
    col += look.auroraColor * planetAuroraCurtain(q, s.d, pole, look.auroraSize, tm, foot) * look.aurora * 1.2 * vis;
  }
  if (ring.z > 0.0) col = mix(col, ringCol, ringCover * vis);
  for (int i = 0; i < 3; i++) {
    if (float(i) >= look.moons) break;
    PlanetMoon m = planetMoon(i, look.ring);
    vec3 moon = planetMoonDisc(q, planetMoonAt(m, tm, 0.0, 1.0), m.size * look.moonScale, look.light, float(i), foot);
    if (moon.x > 0.5) {
      col = mix(col, look.moon * (0.08 + 0.85 * moon.y), vis);
      if (ring.z > moon.z) col = mix(col, ringCol, ringCover * vis);
    }
  }
  return col;
}
`;
