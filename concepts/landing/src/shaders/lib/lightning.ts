// Shared lightning: when strikes happen (randomly or on the scene's "now" trigger), a forked bolt and
// the sky-wide flash. Compiled into every scene program after the weather library; the contract and
// conventions are in src/scenes/README.md.

export const lightningGlsl = `
// ---- lightning ----

// Seconds since the latest strike: the random storm's or the trigger's (slot; -1 for none),
// whichever is more recent; 1e4 when there is none: the sky's event scheduler (skyEventAge). The
// storm cuts the motion clock tm (uMotionTime) into windows that each hold at most one strike at a
// hashed moment (70% of them do), so the mean interval is ~window / 0.7 motion seconds: ~24 s at rate
// 0.35, ~4 s at rate 1. The age runs in real seconds, so a strike always flickers at its own pace.
// seed is a stable id for the strike, to shape its bolt.
float lightningAge(float tm, float rate, int slot, out float seed) {
  return skyEventAge(tm, mix(24.0, 3.0, clamp(rate, 0.0, 1.0)), rate > 0.0 ? 0.7 : 0.0, 3, vec4(9.3, 41.7, 77.1, 5.3), slot, seed);
}

// Brightness of a strike over time: the first return stroke, then subsequent strokes down the same
// channel ~90 and ~220 ms later, each flaring at once and decaying over decay seconds, all gone by
// ~0.6 s. Shared by the bolt and the flash so they stay in step. At most three flashes in a second.
float lightningStrokes(float age, float decay) {
  if (age < 0.0) return 0.0;
  float s = exp(-age / decay);
  s += 0.75 * step(0.09, age) * exp(-(age - 0.09) / decay);
  s += 0.5 * step(0.22, age) * exp(-(age - 0.22) / decay);
  return s * (1.0 - smoothstep(0.3, 0.6, age));
}

// Sky-wide flash 0..1 for a strike of this age: light the clouds and the land with it.
float lightningFlash(float age) {
  return clamp(lightningStrokes(age, 0.05), 0.0, 1.0);
}

// 1D value noise along the channel, seeded per strike.
float lightningNoise(float x, float seed) {
  float i = floor(x);
  float f = x - i;
  return mix(hash12(vec2(i, seed)), hash12(vec2(i + 1.0, seed)), f * f * (3.0 - 2.0 * f));
}

// Vertex i (0 at the top .. 14 at the ground) of the main channel: the straight line pushed sideways
// by three octaves of seeded noise along its length plus a per-vertex jolt, pinned at both ends.
vec2 lightningVertex(float i, float seed, vec2 top, vec2 ground) {
  float s = i / 14.0;
  vec2 axis = ground - top;
  vec2 side = vec2(-axis.y, axis.x); // perpendicular, as long as the channel
  float n = (lightningNoise(s * 3.0, seed * 37.0) - 0.5) * 0.5
          + (lightningNoise(s * 7.0, seed * 53.0 + 9.0) - 0.5) * 0.22
          + (lightningNoise(s * 17.0, seed * 71.0 + 3.0) - 0.5) * 0.1
          + (hash12(vec2(i, seed * 91.0)) - 0.5) * 0.07;
  return top + axis * s + side * n * 2.0 * sqrt(s * (1.0 - s));
}

// A forked bolt from top (cloud base) to ground at p, all in screen-height units with y up, e.g.
// (uv - 0.5) * vec2(aspect, 1.0). A jagged 14-segment main channel and 2-4 branches of 4 segments,
// each a sharp core at least ~2 cells wide in a soft halo. The main channel carries every return
// stroke; branches only the first. Returns glow 0..~1.5: >= 0.6 is the core (colour it white), below
// is the halo (colour it violet).
float lightningBolt(vec2 p, vec2 top, vec2 ground, float seed, float age) {
  float flash = lightningStrokes(age, 0.035) + 0.12 * (1.0 - smoothstep(0.05, 0.5, age));
  if (age < 0.0 || flash <= 0.001) return 0.0;
  vec2 axis = ground - top;
  float len = length(axis);
  // The channel strays less than ~0.3 of its length from the axis, forks reach ~0.45 further and the
  // halo fades within ~0.15: skip everything outside that.
  if (segmentDistance(p, top, ground) > 0.75 * len + 0.15) return 0.0;

  float d = 1e3;
  vec2 a = top;
  for (int i = 1; i <= 14; i++) {
    vec2 b = lightningVertex(float(i), seed, top, ground);
    d = min(d, segmentDistance(p, a, b));
    a = b;
  }

  // Branches leave the channel at vertices 3..10 and zig-zag down and outward.
  int count = 2 + int(floor(hash12(vec2(seed, 3.3)) * 2.999));
  vec2 along = axis / len;
  float db = 1e3;
  vec2 b0 = top;
  vec2 stride = vec2(0.0);
  for (int j = 0; j < 16; j++) {
    int k = j / 4;
    if (k >= count) break;
    float fk = float(k);
    if (j - k * 4 == 0) {
      float hk = hash12(vec2(seed * 13.0, fk + 1.0));
      b0 = lightningVertex(3.0 + floor(hk * 7.999), seed, top, ground);
      float turn = (fract(hk * 7.3) < 0.5 ? -1.0 : 1.0) * (0.5 + 0.6 * fract(hk * 31.1));
      stride = rotate(along, turn) * len * (0.06 + 0.05 * fract(hk * 57.0));
    }
    vec2 b1 = b0 + rotate(stride, (hash12(vec2(seed + fk, float(j))) - 0.5) * 0.9);
    db = min(db, segmentDistance(p, b0, b1));
    b0 = b1;
  }

  float w = max(0.0018, 1.2 / uRes.y);
  float trunk = ((1.0 - smoothstep(w, 2.0 * w, d)) + exp(-d * 28.0) * 0.55 + exp(-d * 90.0) * 0.35) * flash;
  float first = (exp(-age / 0.035) + 0.15 * (1.0 - smoothstep(0.0, 0.25, age))) * (1.0 - smoothstep(0.3, 0.6, age));
  float fork = ((1.0 - smoothstep(0.6 * w, 1.3 * w, db)) * 0.8 + exp(-db * 45.0) * 0.4) * first;
  return max(trunk, fork);
}
`;
