// Shared surfaces for the side-on camera (viewRay): where an eye ray meets level ground or water and
// how much of it one dither cell covers there (for antialiasing and level of detail), Schlick's
// Fresnel term, and LEAN-filtered trains of wind ripples on water. Compiled into every scene program
// after the weather library; the contract and conventions are in src/scenes/README.md.

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
// phase: a fixed offset. Sum it over a scene's trains: xy is the slope (dh/dx, dh/dz) it adds where
// it is drawn, z the slope variance it adds where it is too fine to draw.
vec3 rippleTrain(vec2 p, float tm, vec2 foot, float wavelength, vec2 along, float slope, float pace, float phase, vec2 lod) {
  float k = TAU / wavelength;
  float seen = smoothstep(lod.x, lod.y, wavelength / max(length(along * foot), 1e-6));
  float ph = k * dot(along, p) - pace * sqrt(9.81 * k) * tm + phase;
  return vec3(along * cos(ph) * slope * seen, 0.5 * slope * slope * (1.0 - seen));
}
`;
