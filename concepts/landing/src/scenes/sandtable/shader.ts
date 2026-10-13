// The sand table's picture, from straight above: the sand (or slate) of the sim's height field
// (sim.ts), lit by one low lamp standing off beyond the table, inside a walnut or brass rim on a
// dark floor; and on it the steel ball, or the pendulum's funnel, string and wiping edge.
//   uSim0  heights, field units (r16f), the field square centred on the table
//   uSim1  texel 0: ball or funnel centre (field units from the table's centre), shown, stream
//          texel 1: wiping edge normal, offset of its middle along it, shown
//          texel 2: M lit, M height (field units), funnel fill
// Field space: x right, y up, field units from the table's centre; the screen shows SANDTABLE.span
// view heights per field unit (times the aspect on a portrait screen).
// Knobs read here: K_machine, K_sand, K_depth, K_sparkle, K_light, K_height, K_rim.
import { SANDTABLE } from "./sim.ts";

const f = (value: number): string => value.toFixed(5);

export const sandtableGlsl = `
const float SANDTABLE_SPAN = ${f(SANDTABLE.span)};
const float SANDTABLE_SAND = ${f(SANDTABLE.sand)};
const float SANDTABLE_RIM = ${f(SANDTABLE.rim)};
const float SANDTABLE_RIM_H = ${f(SANDTABLE.rimHeight)};
const float SANDTABLE_BALL = ${f(SANDTABLE.ball)};
const float SANDTABLE_GROOVE = ${f(SANDTABLE.groove)};
const float SANDTABLE_GRID = ${f(SANDTABLE.grid)};
const float SANDTABLE_FUNNEL = ${f(SANDTABLE.funnel)};
const float SANDTABLE_FUNNEL_H = ${f(SANDTABLE.funnelHeight)};
const float SANDTABLE_EDGE = ${f(SANDTABLE.edge)};
const float SANDTABLE_EDGE_H = ${f(SANDTABLE.edgeHeight)};
const float SANDTABLE_DEPTH_MIN = ${f(SANDTABLE.depthMin)};
const float SANDTABLE_DEPTH_RANGE = ${f(SANDTABLE.depthRange)};
const float SANDTABLE_LAMP_D = 2.4;    // how far out from the table's centre the lamp stands
const float SANDTABLE_PIVOT = 2.2;     // the pendulum's string hangs from this high over the centre
const float SANDTABLE_DROP = 0.32;     // the floor lies this far below the sand
const vec3 SANDTABLE_LAMP = vec3(1.0, 0.8, 0.56);      // warm tungsten
const vec3 SANDTABLE_ROOM = vec3(0.075, 0.082, 0.105); // the dark room's cool fill
const vec3 SANDTABLE_NIGHT = vec3(0.022, 0.024, 0.03); // the dark ceiling that polished metal mirrors
const vec3 SANDTABLE_SLATE = vec3(0.1, 0.11, 0.125);
const vec3 SANDTABLE_WALNUT = vec3(0.3, 0.165, 0.085);
const vec3 SANDTABLE_BRASS = vec3(0.88, 0.66, 0.31);
const vec3 SANDTABLE_FLOOR = vec3(0.05, 0.043, 0.038);
const vec3 SANDTABLE_CORD = vec3(0.62, 0.55, 0.44);

// The sand's own colour: pale silica, black basalt, or ochre.
vec3 sandtableSandColor() {
  if (K_sand < 0.5) return vec3(0.86, 0.83, 0.76);
  if (K_sand < 1.5) return vec3(0.2, 0.19, 0.18);
  return vec3(0.8, 0.55, 0.3);
}

// Height of the sand above its rest level at p (field units from the table's centre).
float sandtableHeight(vec2 p) {
  return uSimOn.x > 0.5 ? texture(uSim0, p + 0.5).r : 0.0;
}

// Where a point at height z over the table at 'at' throws its shadow from the lamp.
vec2 sandtableCast(vec3 lamp, vec2 at, float z) {
  return lamp.xy + (at - lamp.xy) * lamp.z / max(lamp.z - z, 1e-3);
}

// Polished brass with normal n, at p and height z: dim where it mirrors the dark room overhead,
// lamplit ground where it looks down and across, and the lamp's own highlight (also returned in
// spark, for the accent). vis shades the lamp.
vec3 sandtableBrass(vec3 n, vec2 p, float z, vec3 lamp, float sinE, vec3 around, float vis, out float spark) {
  vec3 toL = lamp - vec3(p, z);
  float fall = dot(lamp, lamp) / dot(toL, toL);
  vec3 L = normalize(toL);
  vec3 R = reflect(vec3(0.0, 0.0, -1.0), n);
  float s = max(dot(R, L), 0.0);
  spark = (0.5 * pow(s, 6.0) + 1.3 * pow(s, 40.0)) * vis;
  vec3 env = mix(around, SANDTABLE_NIGHT, smoothstep(-0.1, 0.6, R.z));
  float dif = max(dot(n, L), 0.0) / sinE;
  return SANDTABLE_BRASS * (0.85 * env + SANDTABLE_LAMP * fall * (0.12 * dif * vis + spark));
}

// The steel ball's shadow: an ellipse thrown away from the lamp, the longer the lower the lamp,
// and a dark ring where it sits down in its groove.
float sandtableBallShadow(vec2 p, vec4 ball, vec3 lamp, float sinE) {
  if (ball.z <= 0.0) return 0.0;
  vec2 c = sandtableCast(lamp, ball.xy, 0.8 * SANDTABLE_BALL);
  vec2 away = c - ball.xy;
  vec2 dir = dot(away, away) > 1e-10 ? normalize(away) : vec2(1.0, 0.0);
  vec2 q = p - c;
  vec2 e = vec2(dot(q, dir) * max(sinE, 0.15), dot(q, vec2(-dir.y, dir.x))) / SANDTABLE_BALL;
  float thrown = 1.0 - smoothstep(0.7, 1.15, length(e));
  float foot = exp(-pow(max(length(p - ball.xy) - SANDTABLE_BALL, 0.0) / 0.004, 2.0));
  return ball.z * max(0.88 * thrown, 0.5 * foot);
}

// The pendulum's shadows on the table: the thin falling stream, the funnel's mouth (a soft disc,
// the softer the higher it hangs), and its string running on away from the lamp: one chain that
// sweeps across the table with every swing.
float sandtablePendulumShadow(vec2 p, vec4 bob, vec3 lamp, float px) {
  if (bob.z <= 0.0) return 0.0;
  float shade = 0.0;
  float top = SANDTABLE_FUNNEL_H;
  float tipZ = min(top - 0.03, lamp.z - 0.04);
  if (tipZ > 0.0 && bob.w > 0.0) {
    float ds = segmentDistance(p, bob.xy, sandtableCast(lamp, bob.xy, tipZ));
    shade = 0.35 * bob.w * (1.0 - smoothstep(0.6 * px, 1.8 * px, ds));
  }
  float clear = lamp.z - top;
  if (clear > 0.04) {
    vec2 mouth = sandtableCast(lamp, bob.xy, top);
    float blur = 0.006 + 0.05 * top / clear;
    float radius = SANDTABLE_FUNNEL * lamp.z / clear;
    shade = max(shade, 0.55 * (1.0 - smoothstep(radius - blur, radius + blur, length(p - mouth))));
    // The string: toward its pivot's shadow when the pivot hangs below the lamp, else on toward
    // where the string climbs past the lamp's height, off beyond the table.
    vec2 end = SANDTABLE_PIVOT < lamp.z - 0.04
      ? sandtableCast(lamp, vec2(0.0), SANDTABLE_PIVOT)
      : mouth + 4.0 * normalize(bob.xy * (1.0 - clear / (SANDTABLE_PIVOT - top)) - lamp.xy + 1e-5);
    vec2 pa = p - mouth;
    vec2 ba = end - mouth;
    float along = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    float reach = along * length(ba);
    float w = 1.2 * px + 0.02 * reach;
    shade = max(shade, 0.28 * exp(-3.0 * reach) * (1.0 - smoothstep(0.5 * w, w, length(pa - ba * along))));
  }
  return shade * bob.z;
}

// The wiping edge's shadow: the band between the bar and where its top edge's shadow lands.
float sandtableEdgeShadow(vec2 p, vec4 edge, vec3 lamp, float rimOut) {
  if (edge.w <= 0.0) return 0.0;
  vec2 mid = edge.xy * edge.z;
  float shift = dot(sandtableCast(lamp, mid, SANDTABLE_EDGE_H) - mid, edge.xy);
  float d = dot(p, edge.xy) - edge.z;
  float lo = -0.5 * SANDTABLE_EDGE + min(shift, 0.0);
  float hi = 0.5 * SANDTABLE_EDGE + max(shift, 0.0);
  float band = smoothstep(lo - 0.003, lo + 0.001, d) * (1.0 - smoothstep(hi - 0.001, hi + 0.003, d));
  float along = abs(dot(p, vec2(-edge.y, edge.x)));
  return 0.7 * edge.w * band * (1.0 - smoothstep(rimOut + 0.026, rimOut + 0.036, along));
}

// The sand at p (under the pendulum, the slate and the sand trickled onto it): lit by the lamp,
// shadowed by its own relief and by the rim, grains glinting where a facet catches the lamp. vis
// is what else shades the lamp here. Returns the colour; h the height, lit how squarely the lamp
// falls on it (1 = as on level sand).
vec3 sandtableSurface(vec2 p, vec2 cell, vec3 lamp, float sinE, float vis, bool pendulum, bool framed, vec3 sand, out float h, out float lit) {
  float e = 1.0 / SANDTABLE_GRID;
  h = sandtableHeight(p);
  vec2 slope = vec2(
    sandtableHeight(p + vec2(e, 0.0)) - sandtableHeight(p - vec2(e, 0.0)),
    sandtableHeight(p + vec2(0.0, e)) - sandtableHeight(p - vec2(0.0, e))
  ) / (2.0 * e);
  vec3 n = normalize(vec3(-slope, 1.0));
  vec3 toL = lamp - vec3(p, h);
  float fall = dot(lamp, lamp) / dot(toL, toL);
  vec3 L = normalize(toL);
  // The lamp is a broad shade, not a point: its light wraps a little way round onto slopes facing
  // away, so their shadow sides fall to dim sand rather than black.
  lit = max(dot(n, L) + 0.3, 0.0) / (sinE + 0.3);

  // Shadows: the relief between here and the lamp, a few steps out (the penumbra widening with
  // distance); then the rim's, a crescent along the side nearest the lamp.
  vec2 ld = normalize(toL.xy);
  float rise = toL.z / length(toL.xy);
  float shadow = 0.0;
  for (int k = 1; k <= 6; k++) {
    float d = float(k) * 0.0035;
    float over = sandtableHeight(p + ld * d) - h - d * rise;
    shadow = max(shadow, smoothstep(0.0, 0.0002 + 0.04 * d, over));
  }
  if (framed) {
    float b = dot(p, ld);
    float reach = sqrt(max(b * b - dot(p, p) + SANDTABLE_SAND * SANDTABLE_SAND, 0.0)) - b;
    float w = 0.001 + 0.02 * reach;
    shadow = max(shadow, smoothstep(-w, w, SANDTABLE_RIM_H - h - reach * rise));
  }

  // The sand's colour, mottled a little and grain by grain (fixed to the cells, so it never crawls).
  vec3 albedo = sand * (1.0 + 0.08 * (vnoise(p * 150.0) - 0.5) + 0.08 * (hash12(cell) - 0.5));
  float cover = 1.0;
  if (pendulum) {
    cover = smoothstep(0.00002, 0.00045, h);
    float cleft = vnoise(rotate(p, 0.6) * vec2(5.0, 38.0));
    vec3 slate = SANDTABLE_SLATE * (0.88 + 0.16 * vnoise(p * 6.0 + 4.3) + 0.1 * cleft);
    albedo = mix(slate, albedo, cover);
  }
  // Grooves see less of the room; so does the sand tucked in against the rim.
  float cavity = clamp(1.0 + 40.0 * min(h, 0.0), 0.7, 1.0);
  if (framed) cavity *= 1.0 - 0.35 * smoothstep(SANDTABLE_SAND - 0.014, SANDTABLE_SAND, length(p));
  // Sand scatters a little light into its own shade: shadows stay dim sand, never black holes.
  float light = fall * vis * (1.0 - 0.8 * shadow);
  vec3 col = albedo * (SANDTABLE_ROOM * (0.55 + 0.45 * n.z) * cavity + SANDTABLE_LAMP * (0.42 * min(lit, 2.2) * light));

  // Glints: a few grains in a hundred are tiny mirrors, each tilted its own way, flashing when one
  // turns the lamp up toward us. They hold still while the sand does, and wake along a new groove.
  float black = step(0.5, K_sand) * step(K_sand, 1.5);
  float density = mix(0.025, 0.08, black) * 2.0 * K_sparkle * cover;
  if (hash12(cell + 71.3) > 1.0 - density) {
    vec2 tilt = vec2(hash12(cell + 19.1), hash12(cell + 47.7)) - 0.5;
    vec3 facet = normalize(n + vec3(1.8 * tilt, 0.0));
    float glint = smoothstep(0.95, 0.993, dot(facet, normalize(L + vec3(0.0, 0.0, 1.0))));
    col += SANDTABLE_LAMP * (1.2 * glint * light);
  }
  return col;
}

// The rim, a rounded band round the sand: dark walnut (rings of bent grain, a lacquer sheen on the
// bevels that face the lamp) or polished brass.
vec3 sandtableRim(vec2 p, float r, vec3 lamp, float sinE, bool brass, vec3 around, float vis) {
  float u = clamp((r - SANDTABLE_SAND) / SANDTABLE_RIM, 0.0, 1.0);
  vec2 radial = p / max(r, 1e-4);
  float phi = (u - 0.5) * 2.4;
  vec3 n = vec3(radial * sin(phi), cos(phi));
  float shine;
  if (brass) return sandtableBrass(n, p, SANDTABLE_RIM_H, lamp, sinE, around, vis, shine);
  vec3 toL = lamp - vec3(p, SANDTABLE_RIM_H);
  float fall = dot(lamp, lamp) / dot(toL, toL);
  vec3 L = normalize(toL);
  float dif = max(dot(n, L), 0.0) / sinE;
  float grain = sin(r * 520.0 + 9.0 * vnoise(p * 22.0));
  vec3 wood = SANDTABLE_WALNUT * (0.84 + 0.16 * grain) * (0.9 + 0.2 * vnoise(p * 70.0));
  float gloss = pow(max(dot(n, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 36.0);
  return wood * (SANDTABLE_ROOM + SANDTABLE_LAMP * (0.42 * fall * dif * vis)) + SANDTABLE_LAMP * (0.14 * gloss * fall * vis);
}

// The floor round the table, nearly black, and the table's own soft shadow thrown off across it.
vec3 sandtableFloor(vec2 p, float r, vec3 lamp, float sinE, float rimOut, float vis) {
  vec3 toL = lamp - vec3(p, -SANDTABLE_DROP);
  float fall = dot(lamp, lamp) / dot(toL, toL);
  vec2 ld = normalize(toL.xy);
  float rise = toL.z / length(toL.xy);
  float b = dot(p, ld);
  float disc = b * b - dot(p, p) + rimOut * rimOut;
  float shadow = 0.0;
  if (disc > 0.0 && b < 0.0) {
    // The ray toward the lamp meets the table: in shadow while it meets it below the top.
    float enter = -b - sqrt(disc);
    shadow = 1.0 - smoothstep(-0.02, 0.02, enter * rise - SANDTABLE_DROP);
  }
  float ao = 1.0 - 0.6 * exp(-(r - rimOut) / 0.025);
  vec3 ground = SANDTABLE_FLOOR * (0.85 + 0.3 * vnoise(p * 7.0));
  float dif = normalize(toL).z / sinE;
  return ground * ao * (SANDTABLE_ROOM + SANDTABLE_LAMP * (0.42 * fall * dif * (1.0 - 0.85 * shadow) * vis));
}

// The steel ball, satin-polished. Overhead it mirrors the room, warmed by the lamp's spill; round
// its sides, the sand: lamplit on the side toward the lamp, in shade on the far side,
// darkest at its foot. The lamp itself is a small round hot spot (into spark, for the accent),
// kept two or three cells across so it rolls along rather than flickers.
vec3 sandtableBall(vec3 under, vec2 p, vec4 ball, vec3 lamp, vec3 around, float px, inout float spark) {
  if (ball.z <= 0.0) return under;
  vec2 q = (p - ball.xy) / SANDTABLE_BALL;
  float d = length(q);
  float aa = px / SANDTABLE_BALL;
  float cover = ball.z * (1.0 - smoothstep(1.0 - aa, 1.0 + aa, d));
  if (cover <= 0.0) return under;
  vec3 n = vec3(q, sqrt(max(1.0 - d * d, 0.0)));
  vec3 toL = lamp - vec3(ball.xy, SANDTABLE_BALL);
  vec3 L = normalize(toL);
  float fall = dot(lamp, lamp) / dot(toL, toL);
  vec3 R = reflect(vec3(0.0, 0.0, -1.0), n);
  float facing = dot(normalize(R.xy + 1e-5), normalize(L.xy));
  vec3 ground = around * mix(0.2, 1.9, smoothstep(-0.6, 0.7, facing)) * mix(1.0, 0.4, smoothstep(0.8, 0.99, d));
  vec3 env = mix(ground, SANDTABLE_NIGHT + 0.3 * SANDTABLE_LAMP, smoothstep(-0.2, 0.5, R.z));
  float s = max(dot(R, L), 0.0);
  float hot = 1.6 * smoothstep(0.9, 0.975, s) + 0.3 * pow(s, 6.0);
  vec3 steel = 0.75 * env * vec3(0.93, 0.96, 1.0) + SANDTABLE_LAMP * hot * fall;
  spark = max(spark, cover * min(hot, 1.0));
  return mix(under, steel, cover);
}

// The wiping edge: a brass bar longer than the table is wide, resting across the rim, rounded on top.
vec3 sandtableEdgeBar(vec3 under, vec2 p, vec4 edge, vec3 lamp, float sinE, vec3 around, float px, float rimOut, inout float spark) {
  if (edge.w <= 0.0) return under;
  float d = dot(p, edge.xy) - edge.z;
  float along = abs(dot(p, vec2(-edge.y, edge.x)));
  float halfW = 0.5 * SANDTABLE_EDGE;
  float halfLen = rimOut + 0.03;
  float cover = edge.w * (1.0 - smoothstep(halfW - px, halfW + px, abs(d))) * (1.0 - smoothstep(halfLen - px, halfLen + px, along));
  if (cover <= 0.0) return under;
  float phi = clamp(d / halfW, -1.0, 1.0) * 1.2;
  float shine;
  vec3 col = sandtableBrass(vec3(edge.xy * sin(phi), cos(phi)), p, SANDTABLE_EDGE_H, lamp, sinE, around, 1.0, shine);
  spark = max(spark, cover * min(shine, 1.0));
  return mix(under, col, cover);
}

// The funnel's string, climbing to its pivot over the table's centre: from above, a pale cord
// running toward the middle, kept a couple of cells wide so it glides rather than flickers.
vec3 sandtableString(vec3 under, vec2 p, vec4 bob, float px) {
  float len = length(bob.xy);
  if (bob.z <= 0.0 || len < SANDTABLE_FUNNEL) return under;
  float d = segmentDistance(p, bob.xy * (1.0 - 0.9 * SANDTABLE_FUNNEL / len), vec2(0.0));
  float cover = 0.6 * bob.z * (1.0 - smoothstep(0.8 * px, 1.8 * px, d));
  return mix(under, SANDTABLE_CORD * (SANDTABLE_ROOM + 0.35 * SANDTABLE_LAMP), cover);
}

// The funnel from above: a rolled brass lip round a brass cone; the sand still in it a disc that
// shrinks as it runs low, dimpled where it drains; and at the last, the dark hole.
vec3 sandtableFunnel(vec3 under, vec2 p, vec4 bob, float fill, vec3 lamp, float sinE, vec3 sand, vec3 around, float px, inout float spark) {
  if (bob.z <= 0.0) return under;
  vec2 q = (p - bob.xy) / SANDTABLE_FUNNEL;
  float d = length(q);
  float aa = px / SANDTABLE_FUNNEL;
  float cover = bob.z * (1.0 - smoothstep(1.0 - aa, 1.0 + aa, d));
  if (cover <= 0.0) return under;
  vec2 radial = d > 1e-4 ? q / d : vec2(1.0, 0.0);
  float z = SANDTABLE_FUNNEL_H;
  float shine;
  vec3 col;
  if (d > 0.78) {
    float phi = ((d - 0.78) / 0.22 - 0.5) * 2.6;
    col = sandtableBrass(vec3(radial * sin(phi), cos(phi)), p, z, lamp, sinE, around, 1.0, shine);
  } else {
    col = 0.55 * sandtableBrass(vec3(-0.77 * radial, 0.64), p, z, lamp, sinE, around, 1.0, shine);
    shine *= 0.55;
    vec3 toL = lamp - vec3(p, z);
    float fall = dot(lamp, lamp) / dot(toL, toL);
    float rs = 0.76 * sqrt(clamp(fill, 0.0, 1.0));
    float inSand = 1.0 - smoothstep(rs - aa, rs + aa, d);
    float pit = 1.0 - smoothstep(0.0, 0.5 * rs + 0.02, d);
    vec3 n = normalize(vec3(-0.7 * pit * radial, 1.0));
    vec3 grains = sand * (SANDTABLE_ROOM + SANDTABLE_LAMP * (0.42 * fall * max(dot(n, normalize(toL)), 0.0) / sinE));
    col = mix(col, grains, inSand);
    float hole = 1.0 - smoothstep(0.14 - aa, 0.14 + aa, d);
    col = mix(col, vec3(0.008), hole * (1.0 - inSand));
  }
  spark = max(spark, cover * min(shine, 1.0));
  return mix(under, col, cover);
}

Shade sceneSandtable(vec2 uv, vec2 cell, float t) {
  Shade o = blankShade();
  float aspect = uRes.x / uRes.y;
  float span = SANDTABLE_SPAN * min(1.0, aspect);
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5) / span;
  float px = 1.0 / (uRes.y * span);
  float r = length(p);
  bool pendulum = K_machine > 0.5;
  bool framed = K_rim < 1.5;
  bool brass = framed && K_rim > 0.5;
  float rimOut = SANDTABLE_SAND + SANDTABLE_RIM;

  // One lamp, standing off beyond the table: K_light round it, K_height up.
  float az = K_light * TAU;
  float elev = mix(0.1, 0.95, K_height);
  float sinE = sin(elev);
  vec3 lamp = SANDTABLE_LAMP_D * vec3(cos(az), sin(az), tan(elev));

  vec4 s0 = vec4(0.0);
  vec4 s1 = vec4(0.0);
  vec4 s2 = vec4(0.0);
  if (uSimOn.y > 0.5) {
    s0 = texelFetch(uSim1, ivec2(0, 0), 0);
    s1 = texelFetch(uSim1, ivec2(1, 0), 0);
    s2 = texelFetch(uSim1, ivec2(2, 0), 0);
  }
  vec3 sand = sandtableSandColor();
  // Level, lamplit ground: what the polished metal mirrors round its sides.
  vec3 around = (pendulum ? SANDTABLE_SLATE : sand) * (SANDTABLE_ROOM + 0.42 * SANDTABLE_LAMP);

  // What stands on or hangs over the table shades the lamp on everything beneath it.
  float vis = pendulum
    ? (1.0 - sandtablePendulumShadow(p, s0, lamp, px)) * (1.0 - sandtableEdgeShadow(p, s1, lamp, rimOut))
    : 1.0 - sandtableBallShadow(p, s0, lamp, sinE);

  float inRim = framed ? smoothstep(SANDTABLE_SAND - px, SANDTABLE_SAND + px, r) : 0.0;
  float outRim = framed ? smoothstep(rimOut - px, rimOut + px, r) : 0.0;
  vec3 col = vec3(0.0);
  float accent = 0.0;
  if (inRim < 1.0) {
    float h;
    float lit;
    col += (1.0 - inRim) * sandtableSurface(p, cell, lamp, sinE, vis, pendulum, framed, sand, h, lit);
    // The Manifold M, while it lies in the sand: its carved strokes, lit, in the accent.
    if (!pendulum && s2.x > 0.0 && s2.y > 0.0) {
      float dm = markDistance(p / s2.y + vec2(0.0, -0.08)) * s2.y;
      float stroke = 1.0 - smoothstep(0.45 * SANDTABLE_GROOVE, 0.45 * SANDTABLE_GROOVE + px, dm);
      float depth = SANDTABLE_DEPTH_MIN + SANDTABLE_DEPTH_RANGE * K_depth;
      float carved = 1.0 - smoothstep(-0.45 * depth, -0.15 * depth, h);
      accent = s2.x * stroke * carved * (0.5 + 0.5 * clamp(lit, 0.0, 1.0)) * (1.0 - inRim);
    }
  }
  if (inRim > outRim) {
    vec3 rim = sandtableRim(p, r, lamp, sinE, brass, around, vis);
    col += (inRim - outRim) * rim;
    if (brass) accent = max(accent, (inRim - outRim) * clamp(1.5 * dot(rim, LUMA), 0.0, 1.0));
  }
  if (outRim > 0.0) col += outRim * sandtableFloor(p, r, lamp, sinE, rimOut, vis);

  // On top: the ball; or the wiping edge, the funnel's string and the funnel.
  float spark = 0.0;
  if (pendulum) {
    col = sandtableEdgeBar(col, p, s1, lamp, sinE, around, px, rimOut, spark);
    col = sandtableString(col, p, s0, px);
    col = sandtableFunnel(col, p, s0, s2.z, lamp, sinE, sand, around, px, spark);
  } else {
    col = sandtableBall(col, p, s0, lamp, around, px, spark);
  }

  o.rgb = col;
  o.source = col;
  o.ink = clamp(1.35 * dot(col, LUMA), 0.0, 1.0);
  o.accent = clamp(max(accent, spark), 0.0, 1.0);
  return o;
}
`;
