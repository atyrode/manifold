// Shared giant planet: one implementation of a ringed gas giant that any sky composes, whether as its
// subject (orbit: ink and accent coverage, every feature) or as a decoration (campfire: RGB over the
// sky, behind its pines). Compiled into every scene program after the aurora library; the contract
// and conventions are in src/scenes/README.md ("The giant planet").
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
// after.
struct PlanetLook {
  vec2 centre; float radius;       // the scene's flat units
  vec3 light;                      // toward the sun (planetSun turns it for phases or a day cycle)
  float visible;                   // 0..1 how much of it shows
  float night;                     // 0..1 the sky's darkness, for the glow round its limb
  PlanetRing ring;                 // the thin ring's plane: the bands tip with it, the moons orbit near it
  vec3 deep; vec3 mid; vec3 pale; vec3 eye; // band colours and the storm eye (planetBandColor)
  vec3 rim; vec3 glow;             // the lit limb, the airglow round it
  vec3 ringDark; vec3 ringLight;   // the ring between its streaks and on them
  float moons; float moonScale; float eclipses; vec3 moon; // 0..3 moons, drawn moonScale times their size, casting shadows (0/1)
  float aurora; float auroraSize; vec3 auroraColor;        // strength (0 off) and oval size (planetAurora)
  float lights; float twinkle; vec3 lightsColor;           // city lights (0/1) and their flicker
};

PlanetLook planetGiant(vec2 centre, float radius, vec3 light) {
  return PlanetLook(centre, radius, light, 1.0, 1.0, PlanetRing(0.20, 0.32),
    vec3(0.04, 0.20, 0.22), vec3(0.12, 0.45, 0.40), vec3(0.62, 0.78, 0.62), vec3(0.80, 0.86, 0.76),
    vec3(0.08, 0.30, 0.30), vec3(0.012, 0.034, 0.034), vec3(0.42, 0.35, 0.25), vec3(0.78, 0.68, 0.50),
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
  float ringCover = hardEdge(ringBody * 0.85);
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
