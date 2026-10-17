// Shared aurora: curtains of light over the night sky for a ground view, their light on the land and
// how much of them shows. Compiled into every scene program after the lightning library; the contract
// and conventions are in src/scenes/README.md ("Composing components").

export const auroraGlsl = `
// ---- aurora ----

// Curtains hung one behind another (auroraCurtains, auroraM): 3 unless the scene selects fewer (or
// more) with the AURORA_CURTAINS feature, e.g. 1 for a far, small patch of sky.
#ifndef AURORA_CURTAINS
#define AURORA_CURTAINS 3
#endif

// One curtain: a vertical sheet hanging along an east-west arc dist ahead (units in which its lower
// edge is ~1 up and its top ~3.6). The arc bows away toward the sides (+0.06 x^2), so on screen it
// arches over the view like an auroral arc, and ripples in depth. The ray meets it where its reach
// across the ground equals the arc's; one fixed-point step solves for the bend and the ripples.
// Light: a bright, sharp lower edge; above it rays (vertical striations) that drift along the sheet
// and flicker slowly up and down it; lit stretches and dark gaps; more glow where the sheet folds
// edge-on to the viewer. keep 0..1: how much of the finest rays the view resolves (1 all of them;
// less fades them toward their mean, as fbmLod does with octaves).
vec3 auroraCurtain(vec3 dir, float dist, float T, float salt, float keep) {
  float s = dist / dir.z;
  float x = dir.x * s;
  float ph1 = x * 0.35 + T * 0.05 + salt;
  float ph2 = x * 0.9 - T * 0.08 + salt * 2.3;
  float ph3 = x * 2.3 + T * 0.15 + salt * 4.1;
  s = (dist + 0.06 * x * x + 0.8 * sin(ph1) + 0.35 * sin(ph2) + 0.12 * sin(ph3)) / dir.z;
  x = dir.x * s;
  float slope = 0.28 * cos(ph1) + 0.315 * cos(ph2) + 0.276 * cos(ph3); // d(ripple)/dx
  float base = 0.7 + 0.6 * vnoise(vec2(x * 0.4 + T * 0.02, salt));      // ragged lower edge
  float hn = (dir.y * s - base) / 2.6;                                  // 0 lower edge .. 1 top
  if (hn < -0.05 || hn > 1.0) return vec3(0.0);
  // Rays are spaced by angle (x / dist), so far curtains keep the same on-screen stripe width
  // instead of aliasing into noise; stretched noise lets each ray brighten and fade along its height.
  float u = x / dist;
  float fine = vnoise(vec2(u * 38.0 - T * 0.08, hn * 2.5 - T * 0.1 + salt));
  float coarse = vnoise(vec2(u * 11.0 + T * 0.03, salt * 5.0));
  float rays;
  if (keep < 1.0) {
    // The finest noise fades to its mean; widening the threshold by as much as its spread (sd 0.2,
    // weight 0.6) keeps the rays' mean brightness, so the curtain dims by no more than ~1%.
    float w = 0.12 * (1.0 - keep);
    rays = smoothstep(0.38 - w, 0.85 + w, mix(0.5, fine, keep) * 0.6 + coarse * 0.4);
  } else {
    rays = smoothstep(0.38, 0.85, fine * 0.6 + coarse * 0.4);
  }
  float stretch = smoothstep(0.3, 0.75, vnoise(vec2(u * 3.0 - T * 0.02, salt + 7.0)));
  float edge = smoothstep(-0.05, 0.01, hn);
  float lum = edge * (exp(-hn * 7.0) * (0.55 + 0.45 * rays) + 0.5 * rays * exp(-hn * 1.6)) * (1.0 - smoothstep(0.7, 1.0, hn))
            * stretch * (1.0 + 0.8 * min(abs(slope), 1.0));
  // Oxygen green (557.7 nm) low in the curtain, giving way to oxygen red (630 nm) and nitrogen
  // violet toward the top.
  return mix(vec3(0.25, 1.0, 0.55), vec3(0.78, 0.2, 0.58), smoothstep(0.2, 0.75, hn)) * lum;
}

// The curtains at clock T (motion seconds: uMotionTime, or a scene's own motion clock), nearer ones
// higher, farther ones crowding the horizon; keep as for auroraCurtain (1: full detail).
vec3 auroraCurtains(vec3 dir, float T, float strength, float keep) {
  if (strength <= 0.0 || dir.y <= 0.0 || dir.z <= 0.05) return vec3(0.0);
  vec3 c = vec3(0.0);
  float dist = 3.5;
  float gain = 1.0;
  for (int i = 0; i < AURORA_CURTAINS; i++) {
    c += auroraCurtain(dir, dist, T, float(i) * 2.7, keep) * gain;
    dist *= 1.7;
    gain *= 0.75;
  }
  return c * strength * 0.7 * (0.8 + 0.2 * sin(T * 0.21)) * smoothstep(0.0, 0.06, dir.y);
}

// Aurora for a view ray, to add to the night sky, rippling on the motion clock tm (uMotionTime).
// strength 0..1 (K_aurora). 0 below the horizon and behind the viewer; not faded by daylight or
// cloud: multiply by auroraSeen. foot: radians one dither cell spans along dir (about the view's
// vertical field over uRes.y; raise it where the scene blurs its sky): the finest rays, ~0.026 rad
// apart, fade to an even glow once they come closer than two cells (exactly full detail at
// foot <= 0.013, a 1-radian view at 76 rows or finer). A reflection takes the mirrored ray
// (dir.y flipped) and the scene's own dimming.
vec3 auroraM(vec3 dir, float tm, float strength, float foot) {
  return auroraCurtains(dir, tm, strength, smoothstep(1.0, 2.0, 0.026 / max(foot, 1e-6)));
}

// The aurora's light on the land under it, green from the curtains' lower edges and breathing with
// them: add it to the ambient light of snow, water and walls (and the air's haze), times the same
// auroraSeen as the curtains. tm and strength as for auroraM.
vec3 auroraGlow(float tm, float strength) {
  return vec3(0.25, 1.0, 0.55) * 0.06 * strength * (0.8 + 0.2 * sin(tm * 0.21));
}

// How much of the aurora shows, 0..1: only by night (fading in through nautical twilight, as the
// stars do) and only where cloud (cover 0..1, the deck's alpha along the ray) leaves the sky open.
float auroraSeen(Sky sky, float cloud) {
  return sky.night * (1.0 - clamp(cloud, 0.0, 1.0));
}
`;
