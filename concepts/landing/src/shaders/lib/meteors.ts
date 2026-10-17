// Shared shooting stars: when one flies (randomly at a rate, or on the scene's "now" trigger) and its
// streak in a flat sky frame the scene projects into. Compiled into every scene program after the
// aurora library; the contract and conventions are in src/scenes/README.md ("Composing components").

export const meteorsGlsl = `
// ---- meteors ----

// Seconds a shooting star takes to cross, head to fade.
const float METEOR_FLIGHT = 0.9;

// The cool white most scenes give a shooting star's streak.
const vec3 METEOR_TINT = vec3(0.9, 0.95, 1.0);

// Seconds since the latest shooting star, the random one's or the trigger's (slot; -1 for none),
// whichever is more recent; 1e4 when there is none: the sky's event scheduler (skyEventAge) with the
// motion clock tm (uMotionTime) cut into windows of 60 s (rate near 0) down to 5 s (rate 1), each
// holding one meteor in 80% of them, the age in real seconds; none at random while rate is 0.
// seed: a stable id for the meteor, for meteorStreak.
float meteorAge(float tm, float rate, int slot, out float seed) {
  return skyEventAge(tm, mix(60.0, 5.0, clamp(rate, 0.0, 1.0)), rate > 0.0 ? 0.8 : 0.0, 2, vec4(13.1, 57.3, 91.7, 6.1), slot, seed);
}

// A shooting star age seconds into its flight, at q in a flat sky frame the scene chooses (its
// projection: skyAngles(dir) for a dome, in radians; screen heights for a painted backdrop). It
// starts at a point hashed from seed inside field (xy: the lower left corner, zw: the size), heading
// down 20-50 degrees from level toward the field's far side, 0.45 units a second, a tail growing to
// 0.12 behind a bright head; it flares in and fades over METEOR_FLIGHT. foot: one dither cell in q
// units (raise it where the scene blurs its sky): the core is ~1.2 cells wide at any resolution and
// a streak too short to resolve still shows as a point. Returns 0..1 coverage: multiply by the scene's
// visibility (night, cloud, what stands in front), then cut it with hardEdge so it moves cleanly.
float meteorStreak(vec2 q, vec4 field, float age, float seed, float foot) {
  if (age < 0.0 || age > METEOR_FLIGHT) return 0.0;
  vec2 h = vec2(hash12(vec2(seed, 3.1)), hash12(vec2(seed, 5.7)));
  vec2 from = field.xy + field.zw * h;
  float ang = 0.35 + 0.52 * hash12(vec2(seed, 9.2));
  vec2 way = vec2(cos(ang) * (h.x > 0.5 ? -1.0 : 1.0), -sin(ang));
  vec2 head = from + way * 0.45 * age;
  float tail = max(min(0.12, 0.45 * age), 1e-4);
  float d = segmentDistance(q, head - way * tail, head);
  if (d > 4.0 * foot) return 0.0;
  float along = clamp(dot(q - head, way) / tail + 1.0, 0.0, 1.0); // 0 tail end .. 1 head
  float life = smoothstep(0.0, 0.08, age) * (1.0 - smoothstep(0.55, METEOR_FLIGHT, age));
  return (1.0 - smoothstep(0.6 * foot, 1.4 * foot, d)) * (0.25 + 0.75 * along) * life;
}
`;
