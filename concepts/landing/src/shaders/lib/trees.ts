// Tree crowns, shared: a pine's tiered, tapered outline and a broadleaf crown's leafy dome, so every
// landscape draws its trees with the same shapes. Opt-in (not in `libs`): a scene with trees
// interpolates `treesGlsl` into its GLSL ahead of the code that calls it (the countryside's wood
// crowns and its hedgerow and riverbank trees). The scene decides where trees stand, how big they
// are, their colours and their light.
//
// Crown units: the crown's own radius, y up.
//
//   float treePineWidth(float y);  // a pine's half-width at height y (about -1 its lowest boughs,
//                                  // 1.4 its tip; 0.82 at the foot), tiered in steps of 0.5
//   vec3 treeDomeNormal(vec2 dc);  // a broadleaf dome's normal at disc point dc (|dc| <= 1) in the
//                                  // eye's frame (x right, y up, z into the scene)
export const treesGlsl = /* glsl */ `
// ---- trees ----

// Tiered, tapered boughs in crown coordinates (y up); evergreen structure, not a tinted dome.
float treePineWidth(float y) {
  float taper = clamp((1.4 - y) / 2.4, 0.0, 1.0);
  return 0.82 * taper * (0.78 + 0.22 * fract((1.4 - y) * 2.0));
}

// A leafy dome seen from the side: the sphere's normal at disc point dc, lifted toward the sky and
// turned a little toward the eye, so its top catches the light and its underside falls dark.
vec3 treeDomeNormal(vec2 dc) {
  return normalize(vec3(dc.x, dc.y * 0.8 + 0.25, -sqrt(max(1.0 - dot(dc, dc), 0.0)) - 0.2));
}
`;
