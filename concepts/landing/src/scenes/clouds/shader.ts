// Above the clouds: the view from an airliner window at cruise altitude. A ray-marched sea of
// cumulus tops below, the shared sky above, thunderheads on the horizon, a wingtip with its lights,
// the occasional passing plane, all framed by the cabin's porthole.
//
// Frames: the camera frame has x right, y up, z out through the window. The shared sky libraries
// work in a world frame whose "ahead" is cloudsTurn to the right of the window's view, so the sun
// sets inside the window at golden hour; directions turn into that frame only to read the sky.
//
// Knobs (index.ts): K_time, K_cycle (sky); K_cover, K_altitude, K_drift, K_thunderheads (cloud
// sea); K_window, K_wing, K_contrail (window seat, trigger slot 1); K_wind, K_lightning (trigger
// slot 0), K_aurora (weather); K_livery (manifold).

export const cloudsGlsl = `
const float cloudsHorizon = 0.08; // horizon line above the screen centre, in screen heights (~58% up)
const float cloudsFocal = 1.2;    // lens: about 45 degrees of vertical field of view
const float cloudsTurn = 0.82;    // the window looks this far (radians) left of the sky's "ahead"
const float cloudsAmp = 0.45;     // height range of the cloud tops, world units (domes are ~1.6 across)
const vec3 cloudsBoltLight = vec3(0.74, 0.78, 1.0);

vec3 cloudsToWorld(vec3 d) {
  vec2 xz = rotate(d.xz, cloudsTurn);
  return vec3(xz.x, d.y, xz.y);
}

vec3 cloudsToCamera(vec3 d) {
  vec2 xz = rotate(d.xz, -cloudsTurn);
  return vec3(xz.x, d.y, xz.y);
}

// The shared sky for a camera-frame direction.
vec3 cloudsSky(Sky sky, vec3 dirCam) {
  return skyColor(sky, cloudsToWorld(dirCam));
}

float cloudsCross(vec2 a, vec2 b) {
  return a.x * b.y - a.y * b.x;
}

float cloudsRoundBox(vec2 q, vec2 size, float radius) {
  vec2 d = abs(q) - size + radius;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - radius;
}

// Highlights roll off toward 1 instead of clipping flat, so sunlit domes keep their modelling.
vec3 cloudsShoulder(vec3 c) {
  vec3 over = max(c - 0.7, 0.0);
  return min(c, vec3(0.7)) + 0.3 * (1.0 - exp(-over / 0.3));
}

// Henyey-Greenstein phase relative to isotropic scattering: about 19 straight into the light for
// g = 0.7, a quarter side-on. Its forward lobe is what silvers cloud edges against a low sun
// (Schneider & Vos, "The real-time volumetric cloudscapes of Horizon Zero Dawn", SIGGRAPH 2015).
float cloudsPhase(float cosAngle, float g) {
  float g2 = g * g;
  return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * cosAngle, 1e-4), 1.5);
}

// Folded value noise |2n - 1|: rounded domes with sharp creases between them (Perlin's
// "turbulence", 1985), which is how cumulus tops read from above.
float cloudsBillow(vec2 p) {
  return abs(2.0 * vnoise(p) - 1.0);
}

// The deck's large forms, 0 on the floor of a gap .. 1 on the highest domes. A slow coverage noise
// opens gaps; a sine warp phased by it (cheap domain warping) breaks the value-noise lattice into
// drifting, swirling billows, and 'boil' lets the tops change shape slowly.
float cloudsMacro(vec2 w, float cover, float boil) {
  float c = vnoise(w * 0.16 + vec2(11.3, 4.7));
  vec2 q = w + 0.75 * vec2(sin(w.y * 0.47 + c * 5.0 + boil), sin(w.x * 0.39 - c * 4.0 - boil * 0.7));
  float b = 0.62 * cloudsBillow(q * 0.6) + 0.38 * cloudsBillow(q * 1.37 + vec2(5.1, 2.3));
  float lo = 0.8 - 0.85 * cover;
  float deck = smoothstep(lo, lo + 0.2, c * 0.55 + b * 0.6);
  return deck * (0.3 + 0.7 * pow(b, 0.6));
}

// Cauliflower detail on the domes, for normals only; 'detail' fades it out before it would alias.
float cloudsSurface(vec2 w, float cover, float boil, float detail) {
  float h = cloudsMacro(w, cover, boil);
  float fine = 0.62 * cloudsBillow(w * 3.3 + vec2(1.7, 8.2)) + 0.38 * cloudsBillow(w * 7.4 - vec2(3.3, 0.6));
  return h + (fine - 0.4) * 0.16 * detail * smoothstep(0.1, 0.5, h);
}

// The cloud-top height field against a ray from the camera at the origin; tops lie between
// y = -drop (highest domes) and -drop - cloudsAmp (the floor of the gaps). Steps follow the vertical
// gap to the surface as in terrain marching (Quilez, "Terrain raymarching", 2002), capped so a
// step never jumps a whole dome and growing with distance where domes shrink below a cell; three
// secant steps then settle the hit. Returns the distance, or -1 when the ray passes tFar first. A
// ray that runs out of steps is skimming just over the tops, so where it stopped is taken as the hit.
float cloudsMarch(vec3 rd, vec2 drift, float cover, float boil, float drop, float tFar) {
  float t = drop / -rd.y;
  float tEnd = min((drop + cloudsAmp) / -rd.y, tFar);
  if (t >= tEnd) return -1.0;
  float ta = t;
  float ga = cloudsAmp;
  for (int i = 0; i < 32; i++) {
    vec3 at = rd * t;
    float g = at.y + drop + cloudsAmp * (1.0 - cloudsMacro(at.xz + drift, cover, boil));
    if (g <= 0.0) {
      float tb = t;
      float gb = g;
      for (int k = 0; k < 3; k++) {
        float ts = ta + (tb - ta) * ga / max(ga - gb, 1e-5);
        vec3 mid = rd * ts;
        float gm = mid.y + drop + cloudsAmp * (1.0 - cloudsMacro(mid.xz + drift, cover, boil));
        if (gm > 0.0) {
          ta = ts;
          ga = gm;
        } else {
          tb = ts;
          gb = gm;
        }
      }
      return ta + (tb - ta) * ga / max(ga - gb, 1e-5);
    }
    if (t >= tEnd) break;
    ta = t;
    ga = g;
    t = min(t + clamp(0.55 * g / -rd.y, 0.01 + 0.004 * t, 0.12 + 0.05 * t), tEnd);
  }
  return t < tEnd ? t : -1.0;
}

// Light reaching a point on the tops: two taps toward the light through the coarse field; the
// depth of cloud the ray passes under dims it as Beer-Lambert extinction would. A low sun reaches
// further, so long shadows stretch from the towers across the valleys at golden hour.
float cloudsShadow(vec3 at, vec3 L, vec2 drift, float cover, float boil, float drop) {
  float reach = clamp(0.14 / max(L.y, 0.04), 0.3, 1.8);
  vec3 a = at + L * (reach * 0.3);
  vec3 b = at + L * reach;
  float ya = -drop - cloudsAmp * (1.0 - cloudsMacro(a.xz + drift, cover, boil));
  float yb = -drop - cloudsAmp * (1.0 - cloudsMacro(b.xz + drift, cover, boil));
  float depth = max(ya - a.y, 0.0) * 1.3 + max(yb - b.y, 0.0) * 0.8;
  return exp(-depth * 9.0);
}

// Everything that lights the scene, in the camera frame.
struct CloudsLight {
  vec3 dir;        // key light: the sun, or the moon at night (held a little above the horizon)
  vec3 key;        // its colour on the cloud tops, with the afterglow they keep past sunset
  vec3 high;       // the same for anvils and contrails, which hold the light longer still
  vec3 toward;     // low sky toward the sun: the sunset glow
  vec3 away;       // low sky opposite: the Earth's shadow and the pink Belt of Venus at dusk
  vec3 zenith;     // the deep sky overhead
  vec3 ambient;    // the sky libraries' overall skylight
  vec2 sunBearing; // the sun's compass direction in the camera's xz plane
};

CloudsLight cloudsLighting(Sky sky) {
  CloudsLight li;
  vec3 sun = cloudsToCamera(sky.sun);
  vec3 moon = cloudsToCamera(sky.moon);
  li.sunBearing = normalize(sun.xz + vec2(0.0, 1e-3));
  // Sky samples that colour indirect light; each is aimed so the sun's disc never lands in it.
  vec2 aside = rotate(li.sunBearing, 0.25);
  li.toward = cloudsSky(sky, normalize(vec3(aside.x, 0.06, aside.y)));
  li.away = cloudsSky(sky, normalize(vec3(-li.sunBearing.x, 0.12, -li.sunBearing.y)));
  li.zenith = cloudsSky(sky, normalize(vec3(-0.3 * li.sunBearing.x, 1.0, -0.3 * li.sunBearing.y)));
  // From cruise altitude the horizon dips: cloud tops see the sun a few degrees after the shared
  // sky has put it out, and anvils longer still. They keep the red of the glow toward it.
  float dusk = smoothstep(0.03, -0.02, sky.sun.y);
  vec3 afterglow = li.toward * dusk * smoothstep(-0.13, -0.05, sky.sun.y) * 0.6;
  li.key = sky.sunColor + afterglow + sky.moonColor;
  li.high = sky.sunColor + li.toward * dusk * smoothstep(-0.2, -0.09, sky.sun.y) * 0.8 + sky.moonColor;
  float ws = dot(sky.sunColor + afterglow, LUMA);
  float wm = dot(sky.moonColor, LUMA);
  vec3 dir = normalize(vec3(sun.x, max(sun.y, 0.03), sun.z)) * ws + moon * wm + vec3(0.0, 1e-4, 0.0);
  dir = normalize(dir);
  li.dir = normalize(vec3(dir.x, max(dir.y, 0.03), dir.z));
  li.ambient = sky.ambient;
  return li;
}

// Skylight on a surface facing n: the glow on the sun's side, the cool (or, at dusk, pink) sky
// opposite, the deep zenith overhead, and the bright deck around for faces turned sideways.
vec3 cloudsAmbient(CloudsLight li, vec3 n) {
  float side = dot(n.xz, li.sunBearing);
  vec3 low = mix(li.away, li.toward, 0.5 + 0.5 * side);
  vec3 dome = mix(low, li.zenith, 0.4 + 0.4 * max(n.y, 0.0));
  vec3 deck = li.key * (0.15 + 0.6 * max(li.dir.y, 0.0)) + li.ambient * 0.6;
  return mix(li.ambient, mix(deck, dome, 0.55 + 0.45 * n.y), 0.6);
}

// Light on the cloud tops: wrapped diffuse for the soft terminator of a translucent volume (as in
// Green, "Real-time approximations to subsurface scattering", GPU Gems 2004) over a floor of light
// scattered through the dome from its sunlit side, so even a low sun blushes the tops; then
// self-shadowing, skylight by facing with the valleys occluded, and the forward lobe: a golden
// glare over the deck toward a low sun and bright rims where domes turn away from the eye.
vec3 cloudsShadeTop(CloudsLight li, vec3 rd, vec3 n, float h, float sunlit) {
  float ao = mix(0.5, 1.0, smoothstep(0.05, 0.85, h));
  float wrap = clamp((dot(n, li.dir) + 0.35) / 1.35, 0.0, 1.0);
  // Seen this obliquely every top is near grazing: measure the rim against a flat top's facing.
  float rim = clamp(1.0 - dot(n, -rd) / max(-rd.y * 1.3 + 0.08, 0.1), 0.0, 1.0);
  float fwd = min(cloudsPhase(dot(rd, li.dir), 0.7), 12.0);
  vec3 c = 0.92 * (cloudsAmbient(li, n) * ao + li.key * (0.15 + 0.85 * wrap * wrap) * sunlit);
  c += li.key * fwd * (0.025 + 0.2 * rim * rim) * (0.25 + 0.75 * sunlit);
  return cloudsShoulder(c);
}

// One distant cumulonimbus in its own frame: q.x across from its axis, q.y up from the horizon,
// 1 = its height. A cauliflower column narrowing upward, an overshooting dome, and the flat anvil
// spread downwind ('lean' -1..1) by the high winds. 'strike' lights it from inside at 'strikeAt'.
vec4 cloudsThunderhead(vec2 q, float seed, float lean, float aa, Sky sky, CloudsLight li, vec3 rd, float strike, vec2 strikeAt) {
  float side = q.x < 0.0 ? -1.0 : 1.0;
  float bulge = cloudsBillow(vec2(q.y * 5.5 + seed * 7.0, side * 2.0 + seed * 3.0));
  float cw = 0.15 + 0.08 * (1.0 - q.y) + 0.08 * bulge;
  float column = smoothstep(-aa, aa, cw - abs(q.x)) * smoothstep(-aa, aa, 0.93 - q.y);
  float reach = (0.42 + 0.55 * max(lean * side, 0.0)) * (0.9 + 0.2 * vnoise(vec2(q.y * 14.0, seed * 5.0 + side)));
  float across = abs(q.x) / reach;
  float bottom = 0.8 + 0.13 * across * across;
  float dome = 0.07 * sqrt(max(1.0 - (q.x / 0.16) * (q.x / 0.16), 0.0));
  float top = 0.97 - 0.05 * across * across + dome;
  float anvil = smoothstep(-aa, aa, reach - abs(q.x)) * smoothstep(-aa, aa, q.y - bottom) * smoothstep(-aa, aa, top - q.y);
  // The base sinks into the far deck.
  float cov = max(column, anvil) * smoothstep(-0.06, 0.04, q.y);
  if (cov <= 0.0) return vec4(0.0);

  // A stand-in normal (z toward the camera) and the texture of the cloud: boiling cauliflower on
  // the column, smooth fibrous ice on the anvil.
  vec3 n = vec3(0.0, 1.0, 0.0);
  float tex = 1.0;
  if (anvil > column) {
    float v = clamp((q.y - bottom) / max(top - bottom, 0.02), 0.0, 1.0);
    n = normalize(vec3(side * across * 0.6, mix(-0.8, 0.9, v), -0.55));
    tex = 0.92 + 0.12 * vnoise(vec2(q.x * 3.0, q.y * 26.0) + seed * 9.0);
  } else {
    float nx = clamp(q.x / cw, -1.0, 1.0);
    n = normalize(vec3(nx, 0.2 * (bulge - 0.4), -sqrt(max(1.0 - nx * nx, 0.0)) - 0.05));
    tex = 0.8 + 0.35 * cloudsBillow(q * vec2(9.0, 7.0) + seed * 3.0);
  }
  vec3 key = mix(li.key, li.high, clamp(q.y, 0.0, 1.0));
  float wrap = clamp((dot(n, li.dir) + 0.35) / 1.35, 0.0, 1.0);
  float rim = 1.0 - clamp(-n.z, 0.0, 1.0);
  float fwd = min(cloudsPhase(dot(rd, li.dir), 0.7), 12.0);
  vec3 c = tex * 0.92 * (cloudsAmbient(li, n) + key * wrap * wrap) + key * fwd * 0.18 * rim * rim;
  c = cloudsShoulder(c);
  // A hundred kilometres of air: the base is lost in the horizon haze, the tops stand clearer.
  vec3 haze = cloudsSky(sky, normalize(vec3(rd.x, -0.01, rd.z)));
  c = mix(c, haze, mix(0.72, 0.32, smoothstep(0.0, 0.7, q.y)));
  vec2 dq = q - strikeAt;
  c += cloudsBoltLight * strike * tex * (exp(-dot(dq, dq) * 14.0) * 1.4 + 0.18);
  return vec4(c, cov);
}

// A thunderhead standing on the horizon at hv.x = tower.x, tower.y high, over 'col'.
vec3 cloudsTowerOver(vec3 col, vec2 hv, vec2 tower, float seed, float lean, float px, Sky sky, CloudsLight li, vec3 rd, float strike, vec2 strikeAt) {
  vec2 q = vec2(hv.x - tower.x, hv.y + 0.01) / tower.y;
  if (q.y < -0.1 || q.y > 1.12 || abs(q.x) > 1.3) return col;
  vec4 tw = cloudsThunderhead(q, seed, lean, px / tower.y, sky, li, rd, strike, strikeAt);
  return mix(col, tw.rgb, tw.a);
}

// A distant airliner 'since' seconds into its pass across the frame (half-width 'span'). Its
// contrail condenses a little behind the engines as two lines that merge, then spreads, sinks,
// drifts with the wind and breaks into the regular puffs of the Crow instability as the wingtip
// vortices link up (Crow, "Stability theory for a pair of trailing vortices", AIAA J. 1970).
// Returns trail density (x) and the plane's own coverage (y).
vec2 cloudsContrail(vec2 hv, float px, float since, float seed, float wind, float span) {
  float heading = seed < 0.5 ? 1.0 : -1.0;
  float y0 = 0.07 + 0.2 * fract(seed * 7.13);
  vec2 a = vec2(-heading * span, y0);
  vec2 b = vec2(heading * span, y0 + (fract(seed * 3.77) - 0.5) * 0.1);
  vec2 d = normalize(b - a);
  vec2 across = vec2(-d.y, d.x);
  float speed = 0.035;
  vec2 r = hv - a;
  float s = dot(r, d);
  float age = since - s / speed; // seconds since the plane passed this point of its track
  float trail = 0.0;
  if (age > 0.0 && s > 0.0 && age < 40.0) {
    float sink = dot(vec2(wind * 0.0012, -0.0006), across) * age;
    float wobble = (vnoise(vec2(s * 25.0, seed * 50.0)) - 0.5) * 0.006 * smoothstep(3.0, 25.0, age);
    float puff = 1.0 + 0.6 * smoothstep(8.0, 24.0, age) * pow(0.5 + 0.5 * sin(s * 150.0 + seed * 40.0), 3.0);
    float width = (1.1 * px + 0.0009 * age) * puff;
    float sep = 1.4 * px * (1.0 - smoothstep(0.5, 5.0, age));
    float x = dot(r, across) - sink - wobble;
    float u0 = (x - sep) / width;
    float u1 = (x + sep) / width;
    float lines = max(exp(-u0 * u0), exp(-u1 * u1));
    trail = lines * smoothstep(0.2, 1.5, age) * (1.0 - smoothstep(22.0, 38.0, age)) * sqrt(1.1 * px / width);
  }
  float flown = since * speed;
  vec2 at = a + d * flown;
  float body = segmentDistance(hv, at - d * 0.007, at + d * 0.004);
  float plane = (1.0 - smoothstep(0.5 * px, 1.3 * px, body)) * step(flown, length(b - a));
  return vec2(trail, plane);
}

// The wingtip, in wing units w: origin at the frame's lower-right corner, 1 = about half the
// frame's height (cellW = one cell). The wing sweeps in from the corner toward the horizon, seen
// nearly edge-on from the cabin; a blended winglet rises from its tip. Returns rgb and coverage;
// 'glow' gets the red navigation light and the white strobe (with the steady position light),
// which shine into the air around them, and 'mark' the accent coverage (nav light, livery).
vec4 cloudsWing(vec2 w, float cellW, vec3 rdCam, Sky sky, CloudsLight li, float strobe, float nav, bool livery, out vec3 glow, out float mark) {
  glow = vec3(0.0);
  mark = 0.0;
  vec2 tipLead = vec2(-0.98, 0.80);
  vec2 tipTrail = vec2(-1.24, 0.76);
  vec2 leadDir = normalize(vec2(0.98, -0.30));
  vec2 trailDir = normalize(vec2(0.88, -0.76));
  vec2 chordDir = normalize(tipLead - tipTrail);
  // Distances inside each edge (positive inside): leading, trailing, and the tip chord.
  float inLead = -cloudsCross(leadDir, w - tipLead);
  float inTrail = cloudsCross(trailDir, w - tipTrail);
  float inTip = -cloudsCross(chordDir, w - tipTrail);
  float wingD = min(min(inLead, inTrail), inTip);

  // Winglet: its leading edge is a quadratic Bezier leaving the wing's leading edge along its own
  // direction (the blend), curving up and back; y rises monotonically along it, so solve for the
  // parameter at this height and measure across, corrected by the edge's slope.
  vec2 b0 = tipLead + leadDir * 0.16;
  vec2 b1 = vec2(-1.04, 0.82);
  vec2 b2 = vec2(-1.27, 1.22);
  vec2 topTrail = vec2(-1.42, 1.19);
  float letLead = inLead;
  if (w.y >= b0.y) {
    float qa = b0.y - 2.0 * b1.y + b2.y;
    float qb = 2.0 * (b1.y - b0.y);
    float s = clamp((-qb + sqrt(max(qb * qb - 4.0 * qa * (b0.y - w.y), 0.0))) / (2.0 * qa), 0.0, 1.0);
    float x = mix(mix(b0.x, b1.x, s), mix(b1.x, b2.x, s), s);
    vec2 tangent = mix(b1 - b0, b2 - b1, s);
    float slope = tangent.x / max(tangent.y, 1e-3);
    letLead = (x - w.x) / sqrt(1.0 + slope * slope);
  }
  float letTrail = -cloudsCross(normalize(topTrail - tipTrail), w - tipTrail);
  float letTop = -cloudsCross(normalize(b2 - topTrail), w - topTrail);
  float letBase = min(0.03 - inTip, inTrail + 0.01);
  float letD = min(min(letLead, letTrail), min(letTop, letBase));
  float cov = smoothstep(-0.7 * cellW, 0.7 * cellW, max(wingD, letD));

  // The lights: red navigation light on the tip's leading edge, white strobe and steady white
  // position light at the trailing tip. Sizes are in cells so they stay crisp points of light.
  vec2 navAt = vec2(-0.86, 0.765);
  vec2 strobeAt = tipTrail + vec2(0.012, 0.004);
  float dn = length(w - navAt) / cellW;
  float ds = length(w - strobeAt) / cellW;
  vec3 red = vec3(1.0, 0.1, 0.05);
  vec3 white = vec3(0.95, 0.97, 1.0);
  float navCore = smoothstep(2.6, 0.9, dn) * nav;
  glow = red * (navCore * 1.2 + nav * (exp(-dn / 4.0) * 0.45 + exp(-dn / 18.0) * 0.12));
  glow += white * (smoothstep(3.0, 1.0, ds) * (0.45 + 1.8 * strobe) + strobe * (exp(-ds / 6.0) * 0.9 + exp(-ds / 36.0) * 0.3));
  mark = navCore;
  if (cov <= 0.0) return vec4(0.0);

  bool onWinglet = letD > wingD;
  // Upper skin faces up (a touch of dihedral tips it toward the cabin); the winglet's inner face
  // looks back at the fuselage.
  vec3 n = onWinglet ? normalize(vec3(0.18, 0.3, -1.0)) : normalize(vec3(0.0, 1.0, -0.12));
  vec3 paint = vec3(0.82, 0.83, 0.85);
  float lines = 0.0;
  float edgeLight = 0.0;
  float livered = 0.0;
  if (onWinglet) {
    float acrossLet = clamp(letTrail / max(letTrail + letLead, 1e-3), 0.0, 1.0);
    edgeLight = smoothstep(0.82, 0.97, acrossLet);
    if (livery) {
      // The M, leaning back with the winglet.
      vec2 mq = rotate(w - vec2(-1.215, 0.94), -0.3) / 0.12;
      float aaM = cellW / 0.12;
      livered = 1.0 - smoothstep(0.085 - aaM, 0.085 + aaM, markDistance(mq));
      paint = mix(paint, vec3(1.0, 0.54, 0.24), livered);
    }
  } else {
    // Panel lines in chord/span terms: the aileron hinge and its ends, the slat line.
    float chord = inTrail + inLead;
    float cf = clamp(inTrail / max(chord, 1e-3), 0.0, 1.0);
    lines = 1.0 - smoothstep(0.3 * cellW, 1.1 * cellW, abs(cf - 0.27) * chord);
    float ends = min(abs(inTip - 0.05), abs(inTip - 0.55));
    lines = max(lines, (1.0 - smoothstep(0.3 * cellW, 1.1 * cellW, ends)) * step(cf, 0.27));
    lines = max(lines, (1.0 - smoothstep(0.3 * cellW, 1.1 * cellW, abs(cf - 0.86) * chord)) * 0.6);
    edgeLight = smoothstep(0.9, 0.99, cf);
    paint *= mix(0.86, 1.0, smoothstep(0.0, 0.08, cf));
  }
  float ndl = max(dot(n, li.dir), 0.0);
  vec3 r = reflect(rdCam, n);
  float fres = 0.04 + 0.96 * pow(1.0 - clamp(dot(-rdCam, n), 0.0, 1.0), 5.0);
  vec3 refl = cloudsSky(sky, normalize(vec3(r.x, max(r.y, 0.02), r.z)));
  float spec = pow(max(dot(r, li.dir), 0.0), 90.0);
  vec3 c = paint * (cloudsAmbient(li, n) * 0.85 + li.key * ndl);
  // Glossy paint mirrors the sky at this grazing angle: the horizon glow runs along the wing.
  c += refl * fres * 0.55 + li.key * spec * 1.6;
  // The rounded leading edges catch the light from above.
  c += paint * (li.zenith * 0.2 + li.key * 0.25) * edgeLight;
  c *= 1.0 - 0.3 * lines;
  // Lit by its own lights: a red wash near the tip, the strobe flaring over wingtip and winglet.
  c += paint * (red * nav * exp(-length(w - navAt) * 9.0) * 0.8 + white * strobe * exp(-length(w - strobeAt) * 3.0) * 1.6);
  c = cloudsShoulder(c);
  mark = max(mark, livered * cov * clamp(dot(c, LUMA) * 2.0 + 0.35, 0.0, 1.0));
  return vec4(c, cov);
}

// Everything beyond the pane: sky, thunderheads, the passing plane, the cloud sea, the wing.
// 'frame' is the half-size of what frames the view (the porthole, or the screen without it).
vec3 cloudsView(vec2 p, vec2 head, vec2 frame, float px, float t, float tm, Sky sky, CloudsLight li, out float stars, out float accent) {
  stars = 0.0;
  accent = 0.0;
  // The world rolls a fraction of a degree as the aircraft rides the air; wing and window don't.
  float roll = 0.006 * sin(tm * 0.21) + 0.004 * sin(tm * 0.083 + 1.3);
  vec2 hv = rotate(p, roll) - vec2(0.0, cloudsHorizon);
  vec3 rd = normalize(vec3(hv, cloudsFocal));
  // The sky; below the horizon, the horizon colour the far deck dissolves into. Rays are held just
  // under the horizon, where the shared sky keeps the sun's glow but cuts its disc.
  vec3 bg = cloudsSky(sky, normalize(vec3(rd.x, max(rd.y, -0.01), rd.z)));
  vec3 col = bg;

  float lseed = 0.0;
  float lage = lightningAge(t, K_lightning, 0, lseed);
  float flash = lightningFlash(lage);
  bool towersOn = K_thunderheads > 0.0;
  float tall = 0.55 + 0.9 * K_thunderheads;
  vec2 tower0 = vec2(0.3 * frame.x, 0.2 * tall);   // x, height: right of the sun's setting point
  vec2 tower1 = vec2(0.95 * frame.x, 0.14 * tall);
  bool hitFirst = fract(lseed * 13.7) < 0.6;       // which of the two near towers the strike is in

  if (rd.y > 0.0) {
    vec3 dw = cloudsToWorld(rd);
    stars = skyStars(sky, dw, 0.75);
    col += vec3(0.88, 0.92, 1.0) * stars;
    if (K_aurora > 0.0) col += aurora(dw, t, K_aurora) * sky.night;
  }

  if (towersOn && hv.y > -0.03) {
    float lean = clamp(0.35 + 0.65 * K_wind, -1.0, 1.0);
    vec2 strikeAt = vec2((fract(lseed * 7.3) - 0.5) * 0.3, 0.25 + 0.55 * fract(lseed * 3.1));
    // The storm's glow spills into the sky around it.
    vec2 storm = hv - vec2(hitFirst ? tower0.x : tower1.x, 0.1);
    col += cloudsBoltLight * flash * 0.06 * exp(-length(storm) * 6.0);
    // Now and then a bolt leaps between the two nearer towers; they hide its ends.
    if (lage < 1.5 && fract(lseed * 29.1) < 0.4) {
      vec2 a = vec2(tower0.x + 0.12 * tower0.y, 0.5 * tower0.y);
      vec2 b = vec2(tower1.x - 0.1 * tower1.y, 0.38 * tower1.y);
      float g = lightningBolt(hv, a, b, lseed, lage);
      col += mix(vec3(0.6, 0.5, 1.0) * g, vec3(1.0), smoothstep(0.6, 0.9, g));
    }
    // Farthest first; the outer two only show on wide frames.
    col = cloudsTowerOver(col, hv, vec2(-1.25 * frame.x, 0.17 * tall), 0.31, lean, px, sky, li, rd, flash * 0.06, strikeAt);
    col = cloudsTowerOver(col, hv, vec2(1.7 * frame.x, 0.12 * tall), 0.67, lean, px, sky, li, rd, flash * 0.06, strikeAt);
    col = cloudsTowerOver(col, hv, tower1, 0.53, lean, px, sky, li, rd, flash * (hitFirst ? 0.12 : 1.0), strikeAt);
    col = cloudsTowerOver(col, hv, tower0, 0.19, lean, px, sky, li, rd, flash * (hitFirst ? 1.0 : 0.12), strikeAt);
  }

  if (hv.y > -0.02) {
    // A passing plane: one crossing per period at a random moment in it, or now on the trigger
    // (which, like the lightning trigger, runs on real seconds even with motion off).
    float span = frame.x + 0.1;
    float dur = 2.0 * span / 0.035 + 38.0;
    float period = max(mix(260.0, 80.0, K_contrail), dur + 4.0);
    float k = floor(tm / period);
    float seed = hash12(vec2(k, 7.1));
    float since = K_contrail > 0.0 ? tm - k * period - seed * (period - dur) : -1.0;
    float fired = sinceTrigger(1);
    if (fired >= 0.0 && fired < dur) {
      since = fired;
      seed = hash12(vec2(uTriggers[1], 3.3));
    }
    if (since >= 0.0 && since < dur) {
      vec2 tr = cloudsContrail(hv, px, since, seed, K_wind, span);
      col = mix(col, li.high * 0.9 + li.ambient * 0.75, tr.x * 0.85);
      float beacon = step(0.88, fract(tm * 0.8 + seed * 7.0));
      col += tr.y * (li.high * 1.3 + li.ambient * 0.3 + vec3(1.0, 0.95, 0.9) * sky.night * beacon);
    }
  }

  if (rd.y < 0.0) {
    // The cloud sea. Its scale is fixed: flying higher shrinks the billows toward a fine grain.
    float drop = 0.4 + 4.0 * K_altitude;
    float tFar = 35.0 * drop;
    vec2 drift = vec2(tm * (0.45 * K_drift - 0.1 * K_wind), tm * 0.015);
    float boil = tm * (0.025 + 0.02 * abs(K_wind));
    float tHit = cloudsMarch(rd, drift, K_cover, boil, drop, tFar);
    if (tHit > 0.0) {
      vec3 at = rd * tHit;
      vec2 wq = at.xz + drift;
      // One cell's footprint on the deck, stretched by the grazing view: fine detail and normal
      // spacing follow it, a cheap stand-in for a mip level.
      float footprint = tHit * px / cloudsFocal;
      float detail = 1.0 - smoothstep(0.04, 0.12, footprint / max(-rd.y, 0.05));
      float e = max(0.012, footprint * 1.5);
      float h0 = cloudsSurface(wq, K_cover, boil, detail);
      float hx = cloudsSurface(wq + vec2(e, 0.0), K_cover, boil, detail);
      float hz = cloudsSurface(wq + vec2(0.0, e), K_cover, boil, detail);
      vec3 n = normalize(vec3(-(hx - h0) * cloudsAmp / e, 1.0, -(hz - h0) * cloudsAmp / e));
      float sunlit = cloudsShadow(at, li.dir, drift, K_cover, boil, drop);
      vec3 c = cloudsShadeTop(li, rd, n, h0, sunlit);
      // Through the gaps, the ocean kilometres further down, half lost in the air between.
      vec3 ocean = vec3(0.012, 0.035, 0.07) + li.ambient * 0.08 + li.key * vec3(0.02, 0.05, 0.08);
      c = mix(c, mix(ocean, bg, 0.4), 1.0 - smoothstep(0.03, 0.22, h0));
      // Aerial perspective: the deck dissolves into the horizon glow.
      float fog = max(1.0 - exp(-tHit / (12.0 * drop)), smoothstep(0.7 * tFar, tFar, tHit));
      col = mix(c, bg, fog);
    }
  }

  if (flash > 0.0 && rd.y < 0.02) {
    // The strike lights the deck from inside: under the struck tower, or deep in the far deck.
    vec2 g = towersOn
      ? vec2(hitFirst ? tower0.x : tower1.x, -0.012)
      : vec2((fract(lseed * 5.3) - 0.5) * 1.6 * frame.x, -0.02 - 0.04 * fract(lseed * 9.7));
    vec2 dg = (hv - g) * vec2(0.55, 1.8);
    col += cloudsBoltLight * flash * exp(-dot(dg, dg) * 700.0) * (towersOn ? 0.45 : 0.9);
  }

  if (K_wing > 0.5) {
    // Sized by the frame's height, shrunk on narrow frames so the winglet stays inside.
    float scale = min(frame.y, frame.x * 1.25);
    float cellW = px / scale;
    vec2 w = (p + head * 0.004 - vec2(frame.x, -frame.y)) / scale;
    if (w.x > -1.75 && w.y < 1.45) {
      vec3 rdCam = normalize(vec3(p.x, p.y - cloudsHorizon, cloudsFocal));
      // Anti-collision strobe: a double flash every 1.5 s (none at all with motion off).
      float ph = mod(tm, 1.5);
      float strobe = (exp(-ph * 30.0) + step(0.14, ph) * exp(-max(ph - 0.14, 0.0) * 30.0)) * step(0.001, uMotion);
      float blink = fract(tm / 1.2 + 0.4);
      float nav = smoothstep(0.0, 0.05, blink) * (1.0 - smoothstep(0.5, 0.56, blink));
      vec3 glow = vec3(0.0);
      float mark = 0.0;
      vec4 wing = cloudsWing(w, cellW, rdCam, sky, li, strobe, nav, K_livery > 0.5, glow, mark);
      col = mix(col, wing.rgb, wing.a) + glow;
      accent = max(accent, mark);
    }
  }
  return col;
}

// The porthole and the cabin wall around it, over the view. qp is the point relative to the pane;
// dP and dT are the distances to the pane's and the cabin-side trim's rounded rectangles (shifted
// apart by the head: the reveal between them has depth). sunAt: the key light on screen.
vec3 cloudsWindow(vec3 view, vec2 p, vec2 qp, float dP, float dT, vec2 size, float radius, float pitch, float cx, float px, Sky sky, CloudsLight li, vec2 sunAt) {
  float dayish = clamp(sky.day + 0.5 * sky.twilight, 0.0, 1.0);
  float night = 1.0 - dayish;
  // Cabin light: daylight through the windows by day, dim violet mood lighting at night.
  vec3 cabin = mix(vec3(0.04, 0.035, 0.065), vec3(0.15, 0.145, 0.14), dayish);
  vec3 winLight = li.ambient * 0.8 + li.key * 0.3;
  vec3 plastic = vec3(0.74, 0.73, 0.7);

  // The inner pane: its thick edge, a faint reflection of the cabin (and a reading light at night),
  // hairline scratches that only show where light catches them, glare round the sun, and the
  // little breather hole near the bottom.
  vec3 pane = view * mix(1.0, 0.76, smoothstep(-0.04, 0.0, dP));
  float sheen = smoothstep(0.3, 0.0, abs(dot(qp, vec2(0.83, 0.56)) + 0.12));
  pane += (cabin * 1.5 + 0.01) * (0.25 + 0.75 * sheen) * (0.15 + 0.45 * night);
  vec2 lamp = qp - size * vec2(0.42, 0.5);
  pane += vec3(1.0, 0.82, 0.55) * exp(-dot(lamp, lamp) * 1600.0) * 0.08 * night;
  vec2 grid = qp * 7.0 + 0.5;
  vec2 id = floor(grid);
  float hs = hash12(id + 31.7);
  float scratch = 0.0;
  if (hs > 0.45) {
    float ang = hash12(id + 7.3) * 3.14159;
    vec2 along = vec2(cos(ang), sin(ang));
    vec2 mid = 0.3 + 0.4 * vec2(hash12(id + 2.9), hash12(id + 5.1));
    float len = 0.08 + 0.2 * hash12(id + 9.9);
    float d = segmentDistance(fract(grid), mid - along * len, mid + along * len) / 7.0;
    scratch = (1.0 - smoothstep(0.35 * px, 1.1 * px, d)) * (0.4 + 0.6 * fract(hs * 13.0));
  }
  float nearSun = exp(-length(p - sunAt) * 2.4) * smoothstep(0.0, 0.2, li.dir.z);
  pane += li.key * nearSun * (0.06 + 0.6 * scratch) + scratch * winLight * 0.06;
  float hole = length(qp - vec2(0.0, -size.y * 0.8));
  pane *= 1.0 - 0.45 * (1.0 - smoothstep(0.006, 0.006 + px, hole));
  pane += (winLight * 0.12 + 0.02) * exp(-abs(hole - 0.0075) / px) * 0.5;

  // The reveal: moulded plastic between the pane and the trim. Its sill faces up into the
  // skylight; the sun shining in lights the wall of it across from where the sun stands.
  vec2 corner = vec2(qp.x < 0.0 ? -1.0 : 1.0, qp.y < 0.0 ? -1.0 : 1.0);
  vec2 outward = normalize(max(abs(qp) - (size - radius), 0.0) + 1e-4) * corner;
  float rv = clamp(dP / max(dP - dT, 1e-3), 0.0, 1.0); // 0 at the pane .. 1 at the trim
  float fromSky = 0.5 - 0.5 * outward.y;
  float sunSide = max(dot(-outward, normalize(li.dir.xy + 1e-4)), 0.0) * smoothstep(0.05, 0.3, li.dir.z) * smoothstep(0.03, 0.2, length(li.dir.xy));
  vec3 reveal = plastic * (cabin + winLight * (0.2 + 0.6 * fromSky) * (1.0 - 0.5 * rv) + li.key * sunSide * (1.0 - 0.5 * rv) * 0.8);
  // The rolled-up shade along the top, its finger grip at the middle.
  float blind = smoothstep(0.6, 0.9, outward.y) * (1.0 - smoothstep(0.42, 0.48, rv));
  reveal *= 1.0 - 0.16 * blind;
  float grip = 1.0 - smoothstep(-px, px, cloudsRoundBox(qp - vec2(0.0, size.y + 0.014), vec2(0.04, 0.006), 0.005));
  reveal = mix(reveal, reveal * 1.15 + 0.01, grip);
  // The dark seal round the pane, and the trim's rounded lip catching the light.
  reveal *= 1.0 - 0.6 * (1.0 - smoothstep(0.0, 2.5 * px, dP));
  reveal += plastic * winLight * 0.25 * exp(-abs(dT) / (2.0 * px));

  // The cabin wall: dim, lit around the window, a panel seam halfway to the next one.
  vec3 wall = plastic * 0.55 * (cabin + winLight * (0.06 + 0.3 * exp(-max(dT, 0.0) / 0.08)));
  wall *= 0.85 + 0.15 * smoothstep(-0.5, 0.5, p.y);
  wall *= 1.0 - 0.35 * (1.0 - smoothstep(0.5 * px, 1.5 * px, abs(abs(p.x - cx) - 0.5 * pitch)));

  vec3 frameCol = mix(reveal, wall, smoothstep(-0.6 * px, 0.6 * px, dT));
  return mix(pane, frameCol, smoothstep(-0.6 * px, 0.6 * px, dP));
}

Shade sceneClouds(vec2 uv, vec2 cell, float t) {
  float m = uMotion;
  float tm = t * m;
  float aspect = uRes.x / uRes.y;
  float px = 1.0 / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  // Leaning toward the pointer: the near frame slides against the view, the wing a little.
  vec2 head = uPointer * m;

  Sky sky = skyAt(timeOfDay(K_time, K_cycle, t));
  CloudsLight li = cloudsLighting(sky);
  // Under an aurora the tops pick up a faint green.
  li.ambient += vec3(0.04, 0.22, 0.14) * K_aurora * sky.night * 0.15;

  // The porthole: a deeply rounded rectangle, repeating along the cabin on very wide screens.
  bool windowOn = K_window > 0.5;
  vec2 size = vec2(min(0.315, aspect * 0.5 - 0.045), 0.425);
  float radius = min(size.x, size.y) * 0.82;
  float pitch = 2.0 * (size.x + 0.055) + 0.55;
  float cx = pitch * floor(p.x / pitch + 0.5);
  vec2 qp = p - vec2(cx, 0.0) + head * 0.008;
  vec2 qt = p - vec2(cx, 0.0) + head * 0.02;
  float dP = windowOn ? cloudsRoundBox(qp, size, radius) : -1.0;
  float dT = windowOn ? cloudsRoundBox(qt, size + 0.055, radius + 0.055) : -1.0;
  vec2 frame = windowOn ? size : vec2(aspect * 0.5, 0.5);

  vec3 col = vec3(0.0);
  float stars = 0.0;
  float accent = 0.0;
  if (dP < px) col = cloudsView(p, head, frame, px, t, tm, sky, li, stars, accent);
  if (windowOn) {
    vec2 sunAt = li.dir.xy / max(li.dir.z, 0.05) * cloudsFocal + vec2(0.0, cloudsHorizon);
    col = cloudsWindow(col, p, qp, dP, dT, size, radius, pitch, cx, px, sky, li, sunAt);
    float paneMask = 1.0 - smoothstep(-0.6 * px, 0.6 * px, dP);
    stars *= paneMask;
    accent *= paneMask;
  }
  float v = length((uv - 0.5) * vec2(1.0, 0.85)) * 1.45;
  col *= 1.0 - 0.25 * smoothstep(0.45, 1.05, v);

  Shade o = blankShade();
  o.rgb = col;
  o.source = col;
  o.ink = clamp(dot(col, LUMA), 0.0, 1.0);
  o.accent = accent;
  o.shimmer = stars * 0.4 * m;
  return o;
}
`;
