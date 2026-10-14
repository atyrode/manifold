// Shared surfaces for the side-on camera (viewRay): where an eye ray meets level ground or water and
// how much of it one dither cell covers there (for antialiasing and level of detail), Schlick's
// Fresnel term, and LEAN-filtered trains of wind ripples on water, alone or summed as a spectrum.
// Compiled into every scene program after the weather library; the contract and conventions are in
// src/scenes/README.md. The tiers of a whole water surface that compose these are in water.ts.

export const surfaceGlsl = `
// ---- surface ----

// A point on a level plane eye units below the eye. p: where the ray meets it, x right and y ahead
// (the depth z), in the units of eye (scenes use metres); foot: the patch one dither cell covers
// there, x across and y along the depth (the depthwise side grows as z * z, so a far plane is
// foreshortened to slivers).
struct Ground {
  vec2 p;
  vec2 foot;
};

// Ground for a view ray from viewRay (dir.y < 0: below the horizon only), the eye height and the
// camera's focal length in screen heights (0.5 / tan(fov / 2)).
Ground groundHit(vec3 dir, float eye, float focal) {
  Ground g;
  float q = -dir.y / dir.z; // tangent of the angle below the horizon
  float z = eye / q;
  g.p = vec2(dir.x / dir.z * z, z);
  g.foot.x = z / (focal * uRes.y);
  g.foot.y = g.foot.x * z / eye;
  return g;
}

// The same for a screen point (uv.y < horizon only), for scenes that place things in screen space
// rather than casting viewRay: groundHit(viewRay(uv, aspect, horizon, fov), eye, focal) up to rounding.
Ground planeAt(vec2 uv, float aspect, float horizon, float eye, float focal) {
  Ground g;
  float z = eye * focal / (horizon - uv.y);
  g.p = vec2((uv.x - 0.5) * aspect / focal * z, z);
  g.foot.x = z / (focal * uRes.y);
  g.foot.y = g.foot.x * z / eye;
  return g;
}

// Schlick's approximation to the Fresnel reflectance of a dielectric (water f0 0.02, glass 0.04).
// cosI: cosine between the view (toward the eye) and the normal. minCos 0..1 floors it so a rough
// surface, whose facets face the eye at a spread of angles, never turns into the full grazing mirror
// (scenes use ~0.6-0.8 x the rms facet slope); 0 for a smooth one.
float fresnelSchlick(float cosI, float f0, float minCos) {
  return f0 + (1.0 - f0) * pow(1.0 - clamp(cosI, minCos, 1.0), 5.0);
}

// One train of wind ripples with deep-water dispersion (omega^2 = g k), filtered for the dither as
// LEAN mapping does (Olano & Baker 2010): a train is drawn only once its wavelength spans lod.y cells
// across its crests (fading in from lod.x; scenes use 7..14 or 8..16), and finer ones would sweep
// over the dither as flickering stripes, so their slope variance goes to roughen the mirror or the
// glitter instead. p: the point on the surface (m); tm: the motion clock (uMotionTime); foot: the
// surface one cell covers there (Ground.foot); along: the unit direction the crests travel; slope:
// the train's steepest slope; pace scales its phase speed (1 true dispersion, lower to calm it);
// phase: a fixed offset. Sum it over a scene's trains (rippleSpectrum): xy is the slope (dh/dx,
// dh/dz) it adds where it is drawn, z the slope variance it adds where it is too fine to draw.
vec3 rippleTrain(vec2 p, float tm, vec2 foot, float wavelength, vec2 along, float slope, float pace, float phase, vec2 lod) {
  float k = TAU / wavelength;
  float seen = smoothstep(lod.x, lod.y, wavelength / max(length(along * foot), 1e-6));
  float fine = 0.5 * slope * slope * (1.0 - seen);
  // Too fine for these cells, a train is only its variance: its phase is never worked out, so far
  // water costs a few multiplies per train.
  if (seen <= 0.0) return vec3(0.0, 0.0, fine);
  float ph = k * dot(along, p) - pace * sqrt(9.81 * k) * tm + phase;
  return vec3(along * cos(ph) * slope * seen, fine);
}

// A spectrum: up to RIPPLE_TRAINS trains of wind ripples, summed into one surface by rippleSpectrum
// (xy the slope, dh/dx and dh/dz, these cells draw; z the variance of the trains too fine to draw),
// each train's slope times gain (the wind, a knob). Two ways to give the trains:
const int RIPPLE_TRAINS = 5;

// A fan, by a law: count trains, train i (from 0) wavelength.x * wavelength.y^i long, its steepest
// slope slope.x - slope.y * i, its pace pace.x * (1 - pace.y * i), its phase phase * i, its crests
// travelling turn.x + turn.y * i + sway.x * sin(sway.y * i + sway.z) radians from +z (ahead) toward
// +x (right): a steady turn spreads them evenly (by the golden angle, 2.4), a sway rocks them about
// one heading. The law is applied train by train inside the sum, as a scene's own loop would be.
struct RippleFan {
  int count;
  vec2 wavelength;
  vec2 slope;
  vec2 pace;
  vec2 turn;
  vec3 sway;
  float phase;
  vec2 lod; // rippleTrain's: drawn once a wavelength spans lod.y cells, from lod.x
};

vec3 rippleSpectrum(vec2 p, float tm, vec2 foot, float gain, RippleFan f) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < RIPPLE_TRAINS; i++) {
    if (i >= f.count) break;
    float fi = float(i);
    float a = f.turn.x + fi * f.turn.y + f.sway.x * sin(fi * f.sway.y + f.sway.z);
    sum += rippleTrain(p, tm, foot, f.wavelength.x * pow(f.wavelength.y, fi), vec2(sin(a), cos(a)), gain * (f.slope.x - f.slope.y * fi), f.pace.x * (1.0 - f.pace.y * fi), fi * f.phase, f.lod);
  }
  return sum;
}

// A table of hand-placed trains (Island's crossing seas), best declared const.
struct RippleTable {
  int count;
  vec4 train[RIPPLE_TRAINS]; // each: wavelength (m), steepest slope, pace (1 true dispersion), phase
  vec2 along[RIPPLE_TRAINS]; // each: the unit direction its crests travel
  vec2 lod;
};

vec3 rippleSpectrum(vec2 p, float tm, vec2 foot, float gain, RippleTable s) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < RIPPLE_TRAINS; i++) {
    if (i >= s.count) break;
    vec4 w = s.train[i];
    sum += rippleTrain(p, tm, foot, w.x, s.along[i], gain * w.y, w.z, w.w, s.lod);
  }
  return sum;
}
`;
