// The soap film's picture: the film the sim (sim.ts) drains and stirs, coloured by thin-film
// interference, in its wire against the dark.
//   uSim0  the film: r thickness (µm), g cover 0..1; missing without float render targets, when
//          filmAnalytic stands in
//   uSim1  the interference colours by thickness (linear sRGB, 1 = the first-order white)
//   uSim2  texel 0: the break (q), seconds since, 1 while bursting
//          texel 1: the drawing line (or the blown bubble's radius), 1 while drawing, unused, 1 while there is a film
// Knobs read here: K_shape, K_colour, K_backdrop, K_mark, K_filmSeed.
import { filmCommonGlsl } from "./sim.ts";

/** What the film is seen against, in `backdrop` knob order. */
export const filmBackdrops = ["black", "midnight", "plum"] as const;

export const filmGlsl = `
${filmCommonGlsl}

const vec3 FILM_STEEL = vec3(0.21, 0.215, 0.23);          // the wire, linear
const vec3 FILM_LIGHT = vec3(-0.5014, 0.6217, 0.6017);    // toward the studio light: high on the left, behind the viewer
const vec4 FILM_WINDOW = vec4(-0.42, 0.5, 0.26, 0.32);    // its window mirrored in a bubble: reflected direction xy, half size
const float FILM_INSET = 0.011;           // the film is read this far inside the wire, where the grid still holds it
const float FILM_MENISCUS = 0.35;         // µm the wire's meniscus adds at its surface...
const float FILM_MENISCUS_LENGTH = 0.008; // ...falling by e over this many frame heights
const float FILM_STEM_R = 0.0065;         // the twisted handle
const float FILM_TWIST = 0.022;           // frame heights per half turn of its two wires
const float FILM_RIM_WIDTH = 0.012;       // the burst's rim
const float FILM_DROPS = 72.0;            // sectors round the break, a droplet in about a third of them
const float FILM_DROP_R = 0.0045;
const float FILM_DROP_SPEED = 2.4;        // frame heights per second, the fastest droplets
const float FILM_GRAVITY = 0.8;
const float FILM_FRONT_R = 0.0035;        // the liquid line drawing a new film

// The colour a film h µm thick reflects, linear, 1 = the first-order white: the table from sim.ts,
// or without it each channel's band of wavelengths in closed form (sin² averaged over a Gaussian
// band: a cosine fading out with thickness to the silvery grey of thick film).
vec3 filmSpectrum(float h) {
  if (uSimOn.y > 0.5) {
    float u = clamp(h / FILM_LUT_MAX, 0.0, 1.0) * (FILM_LUT_SIZE - 1.0) + 0.5;
    return texture(uSim1, vec2(u / FILM_LUT_SIZE, 0.5)).rgb;
  }
  vec3 k = vec3(13.70, 15.19, 18.17);
  vec3 spread = 0.066 * k;
  return 0.53 * (1.0 - cos(2.0 * k * h) * exp(-2.0 * spread * spread * h * h));
}

// Behind the film, linear: black velvet, a midnight blue deepening downward, or a dim plum glow.
vec3 filmBackdrop(vec2 uv) {
  vec2 v = uv - vec2(0.5, 0.62);
  if (K_backdrop < 0.5) return vec3(0.0);
  if (K_backdrop < 1.5) return mix(vec3(0.0012, 0.002, 0.007), vec3(0.004, 0.007, 0.022), uv.y) * (1.0 - 0.4 * dot(v, v));
  return vec3(0.03, 0.007, 0.026) * exp(-3.0 * dot(v, v));
}

// The studio light a flat film mirrors: a broad softbox high on the left.
float filmKeyLight(vec2 q, float aspect) {
  vec2 d = q - vec2(-0.3 * aspect, 0.32);
  return 0.5 + 0.6 * exp(-dot(d, d) / 0.55);
}

// The outline's outward normal near q.
vec2 filmEdgeNormal(vec2 q, float shape, vec4 o) {
  vec2 e = vec2(0.0015, 0.0);
  return normalize(vec2(filmEdge(q + e.xy, shape, o) - filmEdge(q - e.xy, shape, o),
                        filmEdge(q + e.yx, shape, o) - filmEdge(q - e.yx, shape, o)) + 1e-6);
}

// A round wire seen side on: s is the signed distance from its axis over its radius, along side.
// Steel wet with soap: lit by the studio light, a glint along it and a faint sheen of colour.
vec3 filmWire(float s, vec2 side, float light) {
  float c = clamp(s, -1.0, 1.0);
  vec3 n = vec3(side * c, sqrt(max(1.0 - c * c, 0.0)));
  float diffuse = max(dot(n, FILM_LIGHT), 0.0);
  float glint = pow(max(reflect(-FILM_LIGHT, n).z, 0.0), 10.0);
  return FILM_STEEL * (0.15 + 0.85 * diffuse) * light + vec3(1.1) * glint + 0.12 * filmSpectrum(0.3 + 0.2 * c);
}

Shade sceneFilm(vec2 uv, vec2 cell, float t) {
  Shade o = blankShade();
  float aspect = uRes.x / uRes.y;
  vec2 q = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
  float px = 1.0 / uRes.y;
  float shape = K_shape;
  bool bubble = shape > 1.5;
  vec4 ol = filmOutline(shape, aspect);
  float edge = filmEdge(q, shape, ol);
  float key = filmKeyLight(q, aspect);

  // The film's life (sim.ts): the break, and the line drawing a new film up.
  vec4 hole = vec4(0.0);
  vec4 life = vec4(0.0, 0.0, 0.0, 1.0);
  if (uSimOn.z > 0.5) {
    hole = texelFetch(uSim2, ivec2(0, 0), 0);
    life = texelFetch(uSim2, ivec2(1, 0), 0);
  }
  bool drawing = life.y > 0.5;
  // A bubble being blown grows from nothing.
  float radius = bubble && drawing ? life.x : ol.z;

  // Thickness (µm) and cover from the sim, or else the analytic film.
  vec2 qs = filmInside(q, shape, ol, FILM_INSET);
  float h;
  float present;
  if (uSimOn.x > 0.5) {
    vec2 s = texture(uSim0, vec2(qs.x / aspect + 0.5, qs.y + 0.5)).rg;
    h = s.x;
    present = clamp(s.y, 0.0, 1.0);
  } else {
    h = filmAnalytic(qs, ol, K_filmSeed, t * uMotion);
    present = life.w;
  }

  // Crisp where the grid is soft: the outline, the line drawing the film, the burst's rim (which
  // runs fast through thin film and slowly through thick, Taylor–Culick).
  float inside = 1.0 - smoothstep(-px, px, bubble ? length(q - ol.xy) - radius : edge);
  float drawn = drawing ? filmDrawn(q, shape, ol, life.x, px) : 1.0;
  float ahead = 1.0;
  if (hole.w > 0.5) ahead = length(q - hole.xy) - hole.z * filmRimSpeed(h * present);
  float film = present * inside * drawn * smoothstep(-px, px, ahead);

  // The wires' meniscus: the film thickens toward the outline's wire and the M, drawing fine
  // fringes of colour along them.
  float near = bubble ? 1.0 : abs(edge) - FILM_WIRE_R;
  vec3 mark = vec3(0.0, 0.0, 1.0);
  float dm = 1.0;
  if (K_mark > 0.0) {
    mark = filmMarkPlace(shape, ol, FILM_MARK_MIN + FILM_MARK_SPAN * K_mark);
    dm = filmMarkDistance(q, mark);
    near = min(near, dm - FILM_WIRE_R);
  }
  float hv = h + FILM_MENISCUS * exp(-max(near, 0.0) / FILM_MENISCUS_LENGTH);

  float exposure = mix(0.6, 1.05, K_colour);
  vec3 col = filmBackdrop(uv) * (1.0 - 0.08 * film);
  vec3 lit;
  if (bubble) {
    // A sphere of film. Light crosses it aslant toward the rim, so the colours there step down an
    // order; its reflectance climbs toward the rim (Fresnel); the far wall shows through, turned
    // round and faint; and the studio window is mirrored high on the left.
    vec2 d = (q - ol.xy) / max(radius, 0.001);
    float z = sqrt(max(1.0 - dot(d, d), 0.0));
    float slant = sqrt(1.0 - (1.0 - z * z) / (FILM_N * FILM_N));
    float fresnel = min(1.0 + 40.0 * pow(1.0 - z, 5.0), 5.0);
    vec3 r = vec3(2.0 * z * d, 2.0 * z * z - 1.0);
    vec2 w = (r.xy - FILM_WINDOW.xy) / FILM_WINDOW.zw;
    float pane = (1.0 - smoothstep(0.8, 1.0, max(abs(w.x), abs(w.y)))) * smoothstep(0.05, 0.12, min(abs(w.x), abs(w.y)));
    float light = 0.16 + 0.22 * (0.5 + 0.5 * r.y) + 1.8 * pane;
    vec2 qb = filmInside(vec2(2.0 * ol.x - q.x, q.y), shape, ol, FILM_INSET);
    float hb = uSimOn.x > 0.5 ? texture(uSim0, vec2(qb.x / aspect + 0.5, qb.y + 0.5)).r : filmAnalytic(qb, ol, K_filmSeed + 17.0, t * uMotion);
    lit = filmSpectrum(hv * slant) * fresnel * light + 0.25 * filmSpectrum(hb * slant);
  } else {
    lit = filmSpectrum(hv) * key;
  }
  // A toe, as a photograph of a film has: black film (a few percent of the first-order white)
  // reads black, not a dim grey sprinkle of dither.
  lit *= exposure * film;
  col += lit * smoothstep(0.01, 0.06, dot(lit, LUMA));

  if (hole.w > 0.5) {
    // The rim: the burst film gathered into a bright rope, crumpled along its length.
    float rim = smoothstep(-px, px, ahead) * (1.0 - smoothstep(FILM_RIM_WIDTH - px, FILM_RIM_WIDTH + px, ahead)) * present * inside * drawn;
    float around = atan(q.y - hole.y, q.x - hole.x) / TAU + 0.5;
    float crumple = 0.6 + 0.4 * filmHash(vec2(floor(around * 150.0), hole.x * 53.0 + 7.0));
    col = mix(col, (filmSpectrum(1.7) * 1.6 + 0.35) * crumple * key, rim);
    // Droplets flung off the rim, flying out and falling: one per lucky sector round the break,
    // found by undoing the fall they all share.
    vec2 dq = q + vec2(0.0, 0.5 * FILM_GRAVITY * hole.z * hole.z) - hole.xy;
    float sector = floor((atan(dq.y, dq.x) / TAU + 0.5) * FILM_DROPS);
    float pick = filmHash(vec2(sector + 0.5, hole.x * 71.0 + hole.y * 13.0));
    if (pick > 0.65) {
      float angle = ((sector + 0.2 + 0.6 * fract(pick * 7.13)) / FILM_DROPS - 0.5) * TAU;
      float travel = hole.z * FILM_DROP_SPEED * (0.35 + 0.55 * fract(pick * 3.71));
      float drop = 1.0 - smoothstep(FILM_DROP_R - px, FILM_DROP_R + px, length(dq - travel * vec2(cos(angle), sin(angle))));
      col += drop * exp(-4.0 * hole.z) * vec3(0.75, 0.78, 0.85);
    }
  }

  if (drawing && !bubble) {
    // The liquid line drawing the new film up from the bottom wire, sagging under its weight.
    float dist = abs(q.y - filmLevel(q, ol, life.x));
    float within = step(edge, 0.0);
    float filament = (1.0 - smoothstep(FILM_FRONT_R - px, FILM_FRONT_R + px, dist)) * within;
    col += exp(-dist / 0.008) * 0.06 * within * key;
    col = mix(col, (filmSpectrum(1.9) * 1.3 + 0.2) * key, filament);
  }

  if (!bubble) {
    // The handle: two wires twisted together, down from the bottom of the outline. Each strand
    // shows as a bright lens leaning with the twist, between dark grooves.
    float across = q.x - ol.x;
    if (q.y < ol.y - ol.w && abs(across) < FILM_STEM_R + px) {
      float s = across / FILM_STEM_R;
      float stem = 1.0 - smoothstep(FILM_STEM_R - px, FILM_STEM_R + px, abs(across));
      float strand = sin(3.14159 * fract(q.y / FILM_TWIST + 0.3 * s));
      col = mix(col, filmWire(s, vec2(1.0, 0.0), key) * (0.35 + 0.65 * strand), stem);
    }
    // The outline's wire.
    float wire = 1.0 - smoothstep(FILM_WIRE_R - px, FILM_WIRE_R + px, abs(edge));
    if (wire > 0.0) col = mix(col, filmWire(edge / FILM_WIRE_R, filmEdgeNormal(q, shape, ol), key), wire);
  }

  // The Manifold M, a wire standing in the film on the lower wire.
  float markWire = 0.0;
  if (K_mark > 0.0) {
    markWire = 1.0 - smoothstep(FILM_WIRE_R - px, FILM_WIRE_R + px, dm);
    if (markWire > 0.0) {
      vec2 e = vec2(0.0015, 0.0);
      vec2 side = normalize(vec2(filmMarkDistance(q + e.xy, mark) - filmMarkDistance(q - e.xy, mark),
                                 filmMarkDistance(q + e.yx, mark) - filmMarkDistance(q - e.yx, mark)) + 1e-6);
      col = mix(col, filmWire(dm / FILM_WIRE_R, side, key), markWire);
    }
  }

  vec3 shown = pow(max(col, 0.0), vec3(1.0 / 2.2));
  float lum = dot(shown, LUMA);
  shown = clamp(mix(vec3(lum), shown, mix(0.5, 1.5, K_colour)), 0.0, 1.0);
  o.rgb = shown;
  o.source = shown;
  o.ink = clamp(1.25 * lum, 0.0, 1.0);
  // The two-tone palette lights the film's magentas, and the M, in the accent.
  o.accent = max(clamp(2.5 * (min(shown.r, shown.b) - shown.g), 0.0, 1.0) * film, markWire);
  return o;
}
`;
