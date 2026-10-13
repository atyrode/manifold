// The pearl fluid's picture: the flakes the sim (sim.ts) carries, lit by a lamp as satin.
//   uSim0  the flakes: q = S (cos 2θ, sin 2θ), θ their direction, S 0..1 how well they agree
//   uSim1  the dye: r pigment, g temperature (convection), b the Manifold M's trace
//   uSim2  5×1 props: texels 0-2 the braid rods, 3 the Manifold rod (x, y in frame heights, shown,
//          radius), 4 the pigment nozzle (x, y, shown) with the share of convection in w
// Without the sim (no float render targets) the flakes are laid along the streamlines of a few
// slowly drifting eddies, drawn here.
// Knobs read here: K_palette, K_lamp, K_contrast, K_nacre.
import { glslVec3 } from "../../shaders/glsl.ts";

/** A fluid: its flakes edge-on, at random and turned to the lamp, and the pigment dripped into it. */
export interface PearlPalette {
  label: string;
  /** Flakes edge-on to the lamp: the liquid's own colour. */
  deep: string;
  /** Flakes in a jumble: the milky mid-tone. */
  milk: string;
  /** Flakes turned to the lamp: the satin's glint. */
  sheen: string;
  pigment: string;
  /** A light fluid: the page goes dark on it. */
  paper: boolean;
}

/** In `palette` knob order. */
export const pearlPalettes: readonly PearlPalette[] = [
  // Silver flakes in blue-black, with a vermilion thread. (The deeps stay just off black, so a
  // band turned edge-on reads as dark fluid, not a hole.)
  { label: "midnight", deep: "#070c1a", milk: "#1a2440", sheen: "#b3c1dd", pigment: "#e0583a", paper: false },
  // Gilt flakes in dark amber, with ultramarine.
  { label: "gold", deep: "#0e0905", milk: "#3b2711", sheen: "#f2d08a", pigment: "#2f4fc4", paper: false },
  // Pale flakes in deep green, with coral.
  { label: "jade", deep: "#05100e", milk: "#123129", sheen: "#b0ead0", pigment: "#e8644c", paper: false },
  // Mother-of-pearl, white on dove grey, with indigo.
  { label: "pearl", deep: "#76737e", milk: "#c3c0c6", sheen: "#fdfaf4", pigment: "#2c3f94", paper: true },
];

const last = pearlPalettes.length - 1;
const paletteCases = pearlPalettes
  .map((palette, i) => {
    const set = `deep = ${glslVec3(palette.deep)}; milk = ${glslVec3(palette.milk)}; sheen = ${glslVec3(palette.sheen)}; pigment = ${glslVec3(palette.pigment)};`;
    return i < last ? `  if (K_palette < ${i}.5) { ${set} return; }` : `  ${set}`;
  })
  .join("\n");

export const pearlGlsl = `
const vec3 PEARL_NACRE = vec3(0.36, -0.14, 0.16);  // rose on one flank of a bright band, sea-green on the other
const vec3 PEARL_GLASS = vec3(0.03, 0.035, 0.045);  // the glass rods' own dark tint
const vec3 PEARL_HEATER = vec3(1.0, 0.5, 0.18);     // the heater glowing along the floor

void pearlPalette(out vec3 deep, out vec3 milk, out vec3 sheen, out vec3 pigment) {
${paletteCases}
}

// Flakes where no simulation runs: five slow eddies, the flakes laid along their streamlines (so a
// four-lobed cross of light stands in each), a jumble where the currents stall.
vec2 pearlStill(vec2 p, float aspect, float t) {
  vec2 v = vec2(0.0);
  for (int i = 0; i < 5; i++) {
    float f = float(i);
    vec2 c = vec2((0.15 + 0.7 * fract(0.31 + 0.618 * f)) * aspect, 0.2 + 0.6 * fract(0.77 + 0.382 * f));
    c += 0.04 * vec2(sin(0.05 * t + 1.7 * f), cos(0.043 * t + 2.3 * f));
    vec2 d = p - c;
    float spin = mod(f, 2.0) < 0.5 ? 1.0 : -0.8;
    v += spin * vec2(-d.y, d.x) * exp(-dot(d, d) / 0.05);
  }
  float speed = length(v);
  vec2 dir = v / max(speed, 1e-6);
  return smoothstep(0.0, 0.06, speed) * vec2(dir.x * dir.x - dir.y * dir.y, 2.0 * dir.x * dir.y);
}

// A glass rod standing in the fluid, seen from above (rod: centre in frame heights, shown 0..1,
// radius): its shadow falls away from the lamp, the fluid climbs it in a faint bright meniscus, and
// its end is dark glass with the rim and a highlight toward the lamp.
vec3 pearlRod(vec3 col, vec2 p, vec4 rod, vec2 lamp, float aa) {
  float shown = rod.z;
  if (shown < 0.001) return col;
  float r = rod.w;
  vec2 d = p - rod.xy;
  float l = length(d);
  float shadow = 1.0 - smoothstep(0.5 * r, 1.7 * r, length(d + 0.75 * r * lamp));
  col *= 1.0 - 0.45 * shadow * shown;
  col += 0.05 * shown * (1.0 - smoothstep(0.0, 0.45 * r, abs(l - 1.25 * r)));
  float toward = dot(d, lamp) / max(l, 1e-6);
  vec3 glass = 0.4 * col + PEARL_GLASS;
  glass += 0.5 * smoothstep(0.55 * r, 0.95 * r, l) * max(toward, 0.0);
  glass += 0.7 * (1.0 - smoothstep(0.12 * r, 0.36 * r, length(d - 0.42 * r * lamp)));
  float body = 1.0 - smoothstep(r - aa, r + aa, l);
  return mix(col, glass, body * shown);
}

Shade scenePearl(vec2 uv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  vec2 mid = vec2(0.5 * aspect, 0.5);
  vec3 deep;
  vec3 milk;
  vec3 sheen;
  vec3 pigment;
  pearlPalette(deep, milk, sheen, pigment);

  // The lamp, as a direction across the tank and as a doubled angle for the flakes (a flake and
  // its half-turn catch the light alike).
  float angle = radians(K_lamp);
  vec2 lamp = vec2(cos(angle), sin(angle));
  vec2 lamp2 = vec2(cos(2.0 * angle), sin(2.0 * angle));

  vec2 q;
  if (uSimOn.x > 0.5) {
    // A soft five-tap footprint about two cells across: whatever the flakes do below the dither's
    // grain never reaches it.
    vec2 texel = 1.0 / uRes;
    q = 0.36 * texture(uSim0, uv).xy
      + 0.16 * (texture(uSim0, uv + texel).xy + texture(uSim0, uv - texel).xy
              + texture(uSim0, uv + vec2(texel.x, -texel.y)).xy + texture(uSim0, uv - vec2(texel.x, -texel.y)).xy);
  } else {
    q = pearlStill(p, aspect, uMotionTime);
  }
  vec4 dye = uSimOn.y > 0.5 ? texture(uSim1, uv) : vec4(0.0);
  vec4 nozzle = uSimOn.z > 0.5 ? texelFetch(uSim2, ivec2(4, 0), 0) : vec4(0.0);
  float convect = nozzle.w;

  // Satin: flakes turned to the lamp glint, edge-on ones go dark, a jumble stays milky. The
  // contrast knob steepens the step between them (gently: a band edge spans many cells, so a
  // slight turn of the flakes never flips a cell back and forth) and adds a glint along each
  // band's crest.
  float facing = dot(q, lamp2);
  float skew = dot(q, vec2(-lamp2.y, lamp2.x));
  float k = mix(0.6, 2.8, K_contrast);
  float lit = 0.5 + 0.5 * tanh(k * facing) / tanh(k);
  vec3 col = lit < 0.5 ? mix(deep, milk, 2.0 * lit) : mix(milk, sheen, 2.0 * lit - 1.0);
  col += sheen * (0.25 * K_contrast) * pow(max(facing, 0.0), 4.0);
  // Nacre: on either flank of a bright band, where the flakes turn off the lamp one way or the
  // other, the glint leans rose on one side and sea-green on the other.
  float pearly = K_nacre * skew * smoothstep(0.3, 0.85, lit);
  col = max(col * (1.0 + pearly * PEARL_NACRE), 0.0);

  // Over the heater, warm currents blush and the element glows along the floor.
  float warmth = clamp(0.3 * dye.g, -0.3, 0.8) * convect;
  col *= 1.0 + warmth * vec3(0.22, 0.05, -0.15);
  col += convect * 0.12 * PEARL_HEATER * exp(-p.y / 0.018);

  // Pigment colours the fluid, the satin still glinting through it.
  float stain = smoothstep(0.03, 0.6, dye.r);
  col = mix(col, pigment * (0.3 + 1.1 * lit), 0.85 * stain);

  // Where the Manifold rod passed, the fluid keeps a faint pearly lift, so the M reads at any lamp
  // angle while its satin ribbon unwinds.
  float trace = clamp(dye.b, 0.0, 1.0);
  col = mix(col, sheen, 0.16 * trace);

  // The lamp's broad reflection on the surface, a little shade toward the corners and along the
  // tank's walls.
  vec2 g = p - (mid + lamp * vec2(0.3 * aspect, 0.3));
  col += sheen * 0.05 * exp(-dot(g, g) / 0.12);
  vec2 vq = (p - mid) / mid;
  col *= 1.0 - 0.15 * dot(vq, vq);
  float wall = min(min(p.x, aspect - p.x), min(p.y, 1.0 - p.y));
  col *= 0.82 + 0.18 * smoothstep(0.0, 0.05, wall);

  // The glass: braid rods, the Manifold rod, the pigment nozzle's tip.
  if (uSimOn.z > 0.5) {
    float aa = 1.0 / uRes.y;
    for (int i = 0; i < 4; i++) col = pearlRod(col, p, texelFetch(uSim2, ivec2(i, 0), 0), lamp, aa);
    col = pearlRod(col, p, vec4(nozzle.xy, nozzle.z, 0.009), lamp, aa);
  }

  // The page theme (paper for the pearl fluid, see index.ts) turns the ink dark there.
  float accent = clamp(max(0.9 * stain, smoothstep(0.08, 0.6, trace)), 0.0, 1.0);
  return shadeOf(col, inkOf(col, 1.2, 1.0, vec2(0.95, 0.6)), accent);
}
`;
