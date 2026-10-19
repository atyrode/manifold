// GPU regressions for the night sky's opt-in parts, the constellations (skyStars, src/shaders/lib/
// sky.ts), compiled in only while their knob is on (the library gate SKY_FIGURES), and the planets
// (skyGiant), compiled in only while the scene's list holds any (SKY_PLANETS), each kind and piece
// of dress only while a planet has it; run by concepts/landing/verify-browser.ts on real WebGL output.
// - `nightSky`: a probe compiled with Frost's knobs and every gate on samples skyStars, both
//   overloads, at every figure's stars and the middle of every figure line. At a clear midnight the
//   figures add light there while on (the lines as strong as their amount), and the knobs off draw
//   exactly what a program without them draws; by day, and with no stars, nothing; at a coarse
//   footprint the points still show. Star-joining (constellations.ts): with no agents, or the knob
//   off, the figures are drawn whole, as the setting's own program without the agents' cursors draws
//   them; with agents every line is drawn as far as the CPU's schedule has it joined, Orion's first
//   from the star it starts at with a cursor ringing the tip; by day nothing. A second probe reads
//   the GLSL schedule itself over standing and running clocks, and it agrees with the CPU twin's,
//   down to which agents skyJoinAway takes off the page.
// - `nightPlanets`: in two skies (the lake's fjord under its slow drapes, and the island at
//   midnight), two planets of different kinds each change the night sky where their placements put
//   them (the one placed further left, further left on screen), together as each alone does round
//   itself; an orbiting planet drifts left with the motion clock and, half a circuit on, has set: the
//   sky is then the empty list's again, byte for byte. A run scoped to some scenes draws only the
//   skies among them.
import {
  constellationUniforms,
  joinNight,
  joinPlan,
  joinTime,
  skyJoinAway,
} from "./constellations.ts";
import { effective, type ParamDef } from "./params.ts";
import { MAX_PRINCIPALS, type Pose } from "./principals.ts";
import { ratedKnobs } from "./rate-phase.ts";
import {
  featureKey,
  fragmentSourceFor,
  sceneFeatures,
  sceneFeaturesAll,
  shaderValues,
  packParams,
} from "./shaders/index.ts";
import { skyFigurePoint, skyFigures } from "./shaders/lib/sky.ts";
import { loadScene, type SceneId } from "./scenes/index.ts";
import { planetUniforms, readPlanet, type SkyPlanet } from "./scenes/planets.ts";
import type { LoadedScene } from "./scenes/types.ts";
import { smoothstep } from "./sims/math.ts";
import { paramDefaults } from "./state.ts";
import { check, drawFloats, LAKE_FJORD, link, VerifyError, walk } from "./verify/kit.ts";

/** Frost without its composed GLSL, which the probes' own GLSL replaces (SceneCode.glslFor). */
const { glslFor, ...frostScene } = await loadScene("frost");
if (glslFor === undefined) throw new VerifyError("night sky: frost is not composed");

/** The shared night knobs with library gates (skyComponentKnobs' constellations). */
const nightPart = (def: ParamDef): boolean =>
  def.widget?.kind === "night" && def.widget.part === "constellations";

interface Draw {
  readonly width: number;
  readonly height: number;
  readonly params: readonly number[];
  readonly uniforms?: Readonly<Record<string, readonly number[]>>;
  /** Integer uniforms (uPlanetCount). */
  readonly ints?: Readonly<Record<string, number>>;
  /** A float RGBA row on texture unit 0 (uSim0), one texel per pixel across. */
  readonly row?: Float32Array;
}

/** Draws `linked` into a float target, the clock frozen, and returns RGBA floats, rows bottom up. */
function draw(gl: WebGL2RenderingContext, linked: WebGLProgram, frame: Draw): Float32Array {
  const { width, height } = frame;
  const row = frame.row ? gl.createTexture() : null;
  try {
    return drawFloats(gl, width, height, () => {
      // Unit 0 holds the row, or nothing, so no uSim sampler reads the target it renders into.
      gl.bindTexture(gl.TEXTURE_2D, row);
      if (frame.row) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, 1, 0, gl.RGBA, gl.FLOAT, frame.row);
      }
      gl.useProgram(linked);
      const figures = constellationUniforms;
      const at = (name: string) => gl.getUniformLocation(linked, name);
      gl.uniform4fv(at("uConStars"), figures.stars);
      gl.uniform4fv(at("uConBright"), figures.brightness);
      gl.uniform4fv(at("uConLines"), figures.lines);
      gl.uniform1i(at("uConStarCount"), figures.starCount);
      gl.uniform1i(at("uConLineCount"), figures.lineCount);
      gl.uniform1i(at("uConMarkStar"), figures.markStar);
      gl.uniform1i(at("uConMarkLine"), figures.markLine);
      gl.uniform1i(at("uView"), 1);
      gl.uniform4fv(at("uParams"), packParams(frame.params));
      gl.uniform1fv(at("uTriggers"), new Float32Array(8).fill(-1e4));
      const uniforms: Record<string, readonly number[]> = {
        uRes: [width, height],
        uTime: [40],
        uMotion: [0.6],
        uMotionTime: [24],
        uPassage: [1, 0],
        uPrincipals: [-1, -1, 0, -1e4],
        uBg: [0.03, 0.03, 0.05],
        ...frame.uniforms,
      };
      for (const [name, value] of Object.entries(uniforms)) {
        const location = at(name);
        if (value.length === 1) gl.uniform1f(location, value[0] ?? 0);
        else if (value.length === 2) gl.uniform2fv(location, value);
        else if (value.length === 3) gl.uniform3fv(location, value);
        else gl.uniform4fv(location, value);
      }
      for (const [name, value] of Object.entries(frame.ints ?? {})) gl.uniform1i(at(name), value);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    });
  } finally {
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteTexture(row);
  }
}

const same = (a: Float32Array, b: Float32Array): boolean => a.every((value, i) => value === b[i]);

/** uPrincipals with every row off the page, so no agent's cursor of main's falls on a sample. */
const NOBODY = Array.from({ length: MAX_PRINCIPALS }, () => [-1, -1, 0, -1e4]).flat();

// Pixel x samples the direction in texel x of uSim0: x skyStars with a footprint, y without (its
// cell 1 / uRes.y radians, which uNight sets to the same footprint). uNight: x the time of day, y
// the star density, z the footprint (radians a dither cell spans).
const PROBE = `
uniform vec3 uNight;

Shade nightProbe(vec2 uv, vec2 cell, float t) {
  vec3 dir = texelFetch(uSim0, ivec2(cell), 0).xyz;
  Sky sky = skyAt(uNight.x);
  Shade o = blankShade();
  o.source = vec3(skyStars(sky, dir, uNight.y, uNight.z), skyStars(sky, dir, uNight.y), 0.0);
  return o;
}
`;

export function verifyNightSky(gl: WebGL2RenderingContext): Record<string, unknown> {
  check(gl.getExtension("EXT_color_buffer_float") !== null, "float render targets unavailable");
  const frost = frostScene;
  check(frost.params.filter(nightPart).length === 1, "frost lacks the constellations");
  const probeDef: LoadedScene = { ...frost, entry: "nightProbe", glsl: PROBE };
  const plainDef: LoadedScene = {
    ...probeDef,
    params: probeDef.params.filter((def) => !nightPart(def)),
  };
  const probe = link(gl, fragmentSourceFor(probeDef, sceneFeaturesAll(probeDef)));
  const plain = link(gl, fragmentSourceFor(plainDef));

  // The samples: each figure's stars, then the middle of each of its lines.
  const offset = (star: number): [number, number] => [
    constellationUniforms.stars[star * 4 + 2] ?? 0,
    constellationUniforms.stars[star * 4 + 3] ?? 0,
  ];
  const stars: (readonly number[])[] = [];
  const lines: (readonly number[])[] = [];
  for (const figure of skyFigures) {
    for (let star = figure.stars[0]; star < figure.stars[1]; star++)
      stars.push(skyFigurePoint(figure, offset(star)));
    for (let line = figure.lines[0]; line < figure.lines[1]; line++) {
      const a = offset(constellationUniforms.lines[line * 2] ?? 0);
      const b = offset(constellationUniforms.lines[line * 2 + 1] ?? 0);
      lines.push(skyFigurePoint(figure, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]));
    }
  }
  // Star-joining's (below): along Orion's first line, a third and two thirds of the way from the
  // star it is drawn from, and across its middle by the radius of the cursor's ring while a line
  // runs (sky.ts skyJoinFigure: 0.7 of main's 0.011 of the height in cells, 1 / foot rows here).
  const foot = 0.002;
  const orion = skyFigures[0];
  const opening = joinPlan.lines[orion?.lines[0] ?? -1];
  if (orion === undefined || opening === undefined) throw new VerifyError("no Orion to join");
  const [ax, ay] = offset(opening.from);
  const [bx, by] = offset(opening.to);
  const across = (0.7 * Math.max(4, 0.011 / foot) * foot) / Math.hypot(bx - ax, by - ay);
  const joinSamples = [
    [ax + (bx - ax) / 3, ay + (by - ay) / 3],
    [ax + ((bx - ax) * 2) / 3, ay + ((by - ay) * 2) / 3],
    [(ax + bx) / 2 - (by - ay) * across, (ay + by) / 2 + (bx - ax) * across],
  ].map(([x = 0, y = 0]) => skyFigurePoint(orion, [x, y]));
  const samples = [...stars, ...lines, ...joinSamples];
  const width = samples.length;
  const row = new Float32Array(width * 4);
  samples.forEach((dir, i) => row.set(dir, i * 4));
  const figureSamples = stars.length + lines.length;

  const frostKnobs = paramDefaults("frost");
  const sky = (
    linked: WebGLProgram,
    def: LoadedScene,
    over: Record<string, number>,
    night: readonly [time: number, density: number, foot: number],
    cast: { readonly agents: number; readonly motionTime: number } = { agents: 0, motionTime: 24 },
  ): Float32Array =>
    draw(gl, linked, {
      width,
      height: 1,
      params: def.params.map((knob) => effective(knob, { ...frostKnobs, ...over })),
      // uRes.y: a cell of 1 / uRes.y radians for the overload without a footprint.
      uniforms: {
        uRes: [width, 1 / night[2]],
        uNight: [...night],
        uMotionTime: [cast.motionTime],
        uPrincipals: NOBODY,
      },
      ints: { uPrincipalCount: 1 + cast.agents },
      row,
    });
  /** Sample i's value, the lesser of the two overloads. */
  const value = (pixels: Float32Array, i: number): number =>
    Math.min(pixels[i * 4] ?? 0, pixels[i * 4 + 1] ?? 0);
  const indices = (from: number, to: number): number[] =>
    Array.from({ length: to - from }, (_, k) => from + k);
  const starIndices = indices(0, stars.length);
  const lineIndices = indices(stars.length, figureSamples);

  const midnight = [0, 0.5, foot] as const;
  const constellations = { constellations: 1, "constellations-amount": 1 };

  // Off: what a program without the knobs draws, and nothing of the parts.
  const off = sky(probe, probeDef, {}, midnight);
  check(same(off, sky(plain, plainDef, {}, midnight)), "the knobs off change skyStars");

  // The figures: every star and line lit, adding light over the field's stars.
  const figures = sky(probe, probeDef, constellations, midnight);
  const dim = [...starIndices, ...lineIndices].filter((i) => value(figures, i) < 0.85);
  check(dim.length === 0, `figure stars or lines dim at midnight: samples ${dim.join(", ")}`);
  const added = [...starIndices, ...lineIndices].reduce(
    (sum, i) => sum + value(figures, i) - value(off, i),
    0,
  );
  check(added > 0.5 * figureSamples, `the figures add little light: ${added.toFixed(2)}`);

  // The lines' amount: at a trace the stars stand out as before, the lines barely there.
  const trace = sky(
    probe,
    probeDef,
    { ...constellations, "constellations-amount": 0.05 },
    midnight,
  );
  check(
    starIndices.every((i) => value(trace, i) >= 0.85),
    "the figures' stars fade with the lines",
  );
  const traced = lineIndices.filter((i) => value(trace, i) > value(off, i) + 0.1);
  check(traced.length === 0, `lines at 0.05 more than a trace: samples ${traced.join(", ")}`);

  // Coarse cells (a 1-radian view at 100 rows): the points are sized in cells and still show.
  const coarse = sky(probe, probeDef, constellations, [0, 0.5, 0.01]);
  check(
    starIndices.every((i) => value(coarse, i) >= 0.85),
    "figure stars lost at a coarse footprint",
  );

  // Nothing by day, nor without stars.
  const day = sky(probe, probeDef, constellations, [0.5, 0.5, 0.002]);
  const starless = sky(probe, probeDef, constellations, [0, 0, 0.002]);
  check(
    day.every((v, i) => i % 4 > 1 || v === 0),
    "night parts by day",
  );
  check(
    starless.every((v, i) => i % 4 > 1 || v === 0),
    "night parts without stars",
  );

  // Star-joining at midnight, the clock standing. With no agents, or the knob off, the figures
  // whole, as the setting's own program, without the agents' cursors, draws them.
  const joining = { ...constellations, time: 0 };
  const pair = { agents: 2, motionTime: 24 };
  check(
    same(sky(probe, probeDef, joining, midnight), figures),
    "star-joining without agents changes the figures",
  );
  check(
    same(sky(probe, probeDef, { ...joining, join: 0 }, midnight, pair), figures),
    "star-joining switched off changes the figures",
  );
  const own = link(
    gl,
    fragmentSourceFor(probeDef, sceneFeatures(probeDef, shaderValues(probeDef, joining))),
  );
  check(
    same(sky(own, probeDef, joining, midnight), figures),
    "the figures differ from their own program's",
  );
  gl.deleteProgram(own);
  // With agents, each line drawn as far as the CPU's schedule has it joined: wherever its growth
  // (sky.ts skyJoinFigure) has passed its middle, lit there; short of it, nothing but the field,
  // unless the cursor is over it (within eight cells of the tip, worked out as skyJoinFigure does).
  const figureOf = (line: number): number =>
    skyFigures.findIndex((figure) => line >= figure.lines[0] && line < figure.lines[1]);
  const tipAt = (figure: number, t: number): readonly [number, number] | undefined => {
    const plan = joinPlan.figures[figure];
    if (plan === undefined || !(t >= 0 && t < plan.seconds)) return undefined;
    let tip: readonly [number, number] = [0, 0];
    for (let i = plan.lines[0]; i < plan.lines[1]; i++) {
      const line = joinPlan.lines[i];
      if (line === undefined || t < line.leave) break;
      const [fx, fy] = offset(line.from);
      const [tx, ty] = offset(line.to);
      const hop = Math.max(line.arrive - line.leave, 1e-3);
      const k = i === plan.lines[0] ? 1 : smoothstep(0, 1, (t - line.leave) / hop);
      tip = [tip[0] + (fx - tip[0]) * k, tip[1] + (fy - tip[1]) * k];
      if (t < line.start) continue;
      const grown = smoothstep(line.start, line.end, t);
      tip = [fx + (tx - fx) * grown, fy + (ty - fy) * grown];
    }
    return tip;
  };
  const growth = { whole: 0, growing: 0, covered: 0 };
  for (const agents of [1, 3])
    for (const motionTime of [1, 8, 16, 30, 45, 70, 100, 150]) {
      const cast = { agents, motionTime };
      const drawn = sky(probe, probeDef, joining, midnight, cast);
      const bare = sky(probe, probeDef, { time: 0 }, midnight, cast);
      lineIndices.forEach((sample, line) => {
        const figure = figureOf(line);
        const t = joinTime(joinNight(0, 0, motionTime, agents, 6), figure);
        const plan = joinPlan.lines[line];
        const grown =
          plan === undefined || t < plan.start ? 0 : smoothstep(plan.start, plan.end, t);
        const lit = value(drawn, sample);
        const at = `line ${line} at ${motionTime} s, ${agents} agents (grown ${grown.toFixed(2)})`;
        if (grown > 0.6) check(lit >= 0.85, `${at} not drawn: ${lit.toFixed(2)}`);
        const [ax, ay] = offset(constellationUniforms.lines[line * 2] ?? 0);
        const [bx, by] = offset(constellationUniforms.lines[line * 2 + 1] ?? 0);
        const tip = tipAt(figure, t);
        const covered =
          tip !== undefined &&
          Math.hypot(tip[0] - (ax + bx) / 2, tip[1] - (ay + by) / 2) < 8 * foot;
        if (covered) growth.covered++;
        else if (grown < 0.4)
          check(lit <= value(bare, sample) + 0.1, `${at} drawn: ${lit.toFixed(2)}`);
        if (grown >= 1) growth.whole++;
        else if (grown > 0) growth.growing++;
      });
    }
  check(growth.whole > 0 && growth.growing > 0, `no line seen growing: ${JSON.stringify(growth)}`);
  // Orion's first line half drawn by a lone agent: lit from the star it starts at to the tip, where
  // the cursor rings it, and nothing beyond; done, whole and the cursor gone.
  const lands = -joinTime(joinNight(0, 0, 0, 1, 6), 0);
  const third = figureSamples;
  const twoThirds = figureSamples + 1;
  const ring = figureSamples + 2;
  const half = { agents: 1, motionTime: lands + (opening.start + opening.end) / 2 };
  const done = { agents: 1, motionTime: lands + (joinPlan.figures[0]?.seconds ?? 0) + 1 };
  const [halfway, halfBare, after, afterBare] = [half, done].flatMap((cast) => [
    sky(probe, probeDef, joining, midnight, cast),
    sky(probe, probeDef, { time: 0 }, midnight, cast),
  ]);
  if (!halfway || !halfBare || !after || !afterBare) throw new VerifyError("no frames drawn");
  check(
    value(halfway, third) >= 0.85 && value(halfway, twoThirds) <= value(halfBare, twoThirds) + 0.1,
    "Orion's first line does not grow from its first star",
  );
  check(
    value(halfway, ring) >= 0.5 && value(halfway, ring) > value(halfBare, ring) + 0.3,
    `no cursor rings the tip: ${value(halfway, ring).toFixed(2)}`,
  );
  check(
    value(after, twoThirds) >= 0.85 && value(after, ring) <= value(afterBare, ring) + 0.1,
    "Orion's first line not whole, or its cursor still there, once joined",
  );
  // By day nothing, agents or not.
  const joinedDay = sky(probe, probeDef, { ...constellations, time: 0.5 }, [0.5, 0.5, foot], {
    agents: 2,
    motionTime: 30,
  });
  check(
    joinedDay.every((v, i) => i % 4 > 1 || v === 0),
    "star-joining by day",
  );
  const twin = joinTwin(gl, frost);

  gl.deleteProgram(probe);
  gl.deleteProgram(plain);
  return {
    samples: { stars: stars.length, lines: lines.length },
    added: Number(added.toFixed(2)),
    joining: { ...growth, schedules: twin },
  };
}

// The GLSL schedule itself (sky.ts skyJoinNight, skyJoinTime): pixel x gives skyJoinTime of figure
// x, tonight's work and, while the agents may work, the night's first figure (-1 while not).
const JOIN_PROBE = `
Shade joinProbe(vec2 uv, vec2 cell, float t) {
  SkyJoin j = skyJoinNight();
  Shade o = blankShade();
  o.source = vec3(skyJoinTime(j, int(cell.x)), j.work, j.open ? float(j.first) : -1.0);
  return o;
}
`;

/**
 * Clocks the twin is checked at: the hour (K_time), the day cycle's pace (0 off) and the days it
 * has run, the motion clock, the agents and the figures a night. Standing at midnight, late
 * evening, past midnight, before the window and by day; running early in the night, deep in it,
 * after it, and nights later. None within a few seconds of a boundary, which float32 may move.
 */
const SCHEDULES: readonly (readonly [number, number, number, number, number, number])[] = [
  [0, 0, 0, 0.5, 1, 6],
  [0, 0, 0, 17.25, 1, 6],
  [0, 0, 0, 64.5, 2, 6],
  [0.95, 0, 0, 33.3, 3, 6],
  [0.1, 0, 0, 140, 3, 4],
  [0.78, 0, 0, 20, 2, 6],
  [0.5, 0, 0, 20, 2, 6],
  [0.75, 1, 0.07, 1000, 1, 6],
  [0.75, 0.3, 0.2, 1000, 2, 6],
  [0.9, 0.3, 0.05, 12, 3, 5],
  [0.75, 1, 0.6, 1000, 2, 6],
  [0.4, 0.5, 37.45, 5000, 3, 6],
];

/**
 * The GLSL schedule against the CPU twin's (constellations.ts joinNight, joinTime) at SCHEDULES, in
 * Frost's program with every gate on: every figure's job time, tonight's work and whether the night
 * is open and from which figure; then the agents whose figure's job runs while open, as the sky
 * draws their cursors, against those skyJoinAway takes off the page. How many were compared.
 */
function joinTwin(gl: WebGL2RenderingContext, frost: LoadedScene): number {
  const def: LoadedScene = { ...frost, entry: "joinProbe", glsl: JOIN_PROBE };
  const linked = link(gl, fragmentSourceFor(def, sceneFeaturesAll(def)));
  const cycle = ratedKnobs(frost.params).findIndex(({ def: knob }) => knob.key === "cycle");
  if (cycle < 0) throw new VerifyError("frost has no day cycle");
  const defaults = paramDefaults("frost");
  const figures = skyFigures.length;
  try {
    for (const [time, pace, days, motionTime, agents, count] of SCHEDULES) {
      const knobs = {
        ...defaults,
        constellations: 1,
        time,
        cycle: pace > 0 ? 1 : 0,
        "cycle-amount": pace,
        "join-amount": count,
      };
      const values = frost.params.map((knob) => effective(knob, knobs));
      const phases = [0, 0, 0, 0];
      phases[cycle] = days;
      const pixels = draw(gl, linked, {
        width: figures,
        height: 1,
        params: values,
        uniforms: { uMotionTime: [motionTime], uPhases: phases, uPrincipals: NOBODY },
        ints: { uPrincipalCount: 1 + agents },
      });
      const night = joinNight(time + days, pace, motionTime, agents, count);
      const at = `at ${JSON.stringify({ time, pace, days, motionTime, agents, count })}`;
      const gpu = { work: pixels[1] ?? Number.NaN, first: pixels[2] ?? Number.NaN };
      check(
        Math.abs(gpu.work - night.work) <= 0.02,
        `${at}: work ${gpu.work} on the GPU, ${night.work}`,
      );
      check(
        gpu.first === (night.open ? night.first : -1),
        `${at}: first ${gpu.first} on the GPU, ${night.open ? night.first : -1}`,
      );
      const up = Array.from({ length: agents }, () => false);
      for (let figure = 0; figure < figures; figure++) {
        const t = joinTime(night, figure);
        const shown = pixels[figure * 4] ?? Number.NaN;
        check(
          t === Number.NEGATIVE_INFINITY ? shown <= -1e8 : Math.abs(shown - t) <= 0.02,
          `${at}: figure ${figure}'s job at ${shown} on the GPU, ${t}`,
        );
        const seconds = joinPlan.figures[figure]?.seconds ?? 0;
        if (gpu.first >= 0 && shown >= 0 && shown < seconds)
          up[((figure - gpu.first + figures) % figures) % agents] = true;
      }
      const poses: Pose[] = up.map(() => ({ x: 0.5, y: 0.5, down: false, inside: true }));
      skyJoinAway(poses, frost.params, values, { cycle: days }, motionTime);
      const away = poses.map((pose) => Number(!pose.inside)).join("");
      check(
        poses.every((pose, agent) => pose.inside === !up[agent]),
        `${at}: the sky draws agents ${up.map(Number).join("")} up, skyJoinAway takes ${away}`,
      );
    }
  } finally {
    gl.deleteProgram(linked);
  }
  return SCHEDULES.length;
}

/** Where a frame differs from another: how many pixels, and their mean across (0..1 of the width). */
function difference(a: Float32Array, b: Float32Array, width: number): { count: number; x: number } {
  let count = 0;
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    const moved =
      Math.abs((a[i] ?? 0) - (b[i] ?? 0)) +
        Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)) +
        Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0)) >
      0.02;
    if (!moved) continue;
    count++;
    sum += ((i / 4) % width) / width;
  }
  return { count, x: count > 0 ? sum / count : Number.NaN };
}

/**
 * The nights nightPlanets draws, each with its knobs: the lake's fjord under its slow drapes, and
 * the island at midnight.
 */
const NIGHTS: readonly (readonly [SceneId, () => Record<string, number>])[] = [
  ["lake", () => LAKE_FJORD],
  ["island", () => ({ ...paramDefaults("island"), time: 0 })],
];

/** nightPlanets (see the header), in the nights of the run's scope. */
export const verifyNightPlanets = walk(
  NIGHTS.map(([id]) => id),
  nightPlanets,
);

async function nightPlanets(
  gl: WebGL2RenderingContext,
  scenes: readonly SceneId[],
): Promise<Record<string, unknown>> {
  check(gl.getExtension("EXT_color_buffer_float") !== null, "float render targets unavailable");
  const width = 160;
  const height = 100;
  const result: Record<string, unknown> = {};
  for (const [id, knobsOf] of NIGHTS) {
    if (!scenes.includes(id)) continue;
    const knobs = knobsOf();
    const scene = await loadScene(id);
    const spec = scene.planets;
    if (spec === undefined) throw new VerifyError(`${id} takes no planets`);
    const params = scene.params.map((knob) => effective(knob, knobs));
    const programs = new Map<string, WebGLProgram>();
    const frame = (planets: readonly SkyPlanet[], motionTime = 24): Float32Array => {
      const uniforms = planetUniforms(planets);
      const features = sceneFeatures(scene, shaderValues(scene, knobs), uniforms);
      const key = featureKey(features);
      const linked = programs.get(key) ?? link(gl, fragmentSourceFor(scene, features));
      programs.set(key, linked);
      return draw(gl, linked, {
        width,
        height,
        params,
        uniforms: { uPlanets: Array.from(uniforms.data), uMotionTime: [motionTime] },
        ints: { uPlanetCount: uniforms.count },
      });
    };
    const [low, , high] = spec.across;
    const up = spec.up[1];
    const left = readPlanet(spec, {
      kind: 3,
      ring: 0,
      size: 0.6,
      across: low + (high - low) * 0.25,
      up,
    });
    const right = readPlanet(spec, {
      kind: 5,
      ring: 0,
      size: 0.6,
      across: low + (high - low) * 0.75,
      up,
    });
    const empty = frame([]);
    const one = difference(frame([left]), empty, width);
    const other = difference(frame([right]), empty, width);
    const both = difference(frame([left, right]), empty, width);
    check(
      one.count > 20 && other.count > 20,
      `${id}: a planet barely shows (${one.count}, ${other.count})`,
    );
    check(
      one.x < other.x,
      `${id}: the planet placed further left stands at ${one.x.toFixed(2)}, the other at ${other.x.toFixed(2)}`,
    );
    check(
      Math.abs(both.count - one.count - other.count) < 0.1 * both.count,
      `${id}: two planets draw ${both.count} pixels, alone ${one.count} and ${other.count}`,
    );
    // An orbiting planet, a circuit every half minute: on its way left, then set.
    const orbit = readPlanet(spec, {
      orbit: 1,
      "orbit-amount": 0.5,
      ring: 0,
      size: 0.6,
      across: (low + high) / 2,
      up,
    });
    // Each against the empty list's frame at the same motion clock (the stars twinkle on it).
    const top = difference(frame([orbit], 0), frame([], 0), width);
    const later = difference(frame([orbit], 2), frame([], 2), width);
    const set = frame([orbit], 15);
    check(top.count > 20, `${id}: the orbiting planet does not show at its height`);
    check(
      later.count > 0 && later.x < top.x,
      `${id}: the orbiting planet stays at ${top.x.toFixed(2)} (then ${later.x.toFixed(2)})`,
    );
    check(same(set, frame([], 15)), `${id}: half a circuit on, the orbiting planet still shows`);
    for (const linked of programs.values()) gl.deleteProgram(linked);
    result[id] = { left: one, right: other, orbit: { top: top.x, later: later.x } };
  }
  return result;
}
