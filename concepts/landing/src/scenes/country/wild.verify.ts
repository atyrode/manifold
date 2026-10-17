// GPU checks of the countryside's verges and murmuration on the real sim's terrain, through the
// scene's own GLSL and its all-features program (verify-browser.ts):
//
// `countryMurmuration`: the starlings are never drawn over land nearer than them. The real sim flies
// the flock over the far fields at dusk, then the exit passage pours it down to roost toward the
// frame's foot; at moments along the way a probe draws, per pixel, where the flock's sheet covers
// before any occlusion and where the land lies nearer than COUNTRY_MURMURATION.depth. No pixel the
// murmuration changes (the scene with it against without) lies where that nearer land stands, while
// the fixture does put the flock there, and before the pour it shows.
//
// `countryVerges`: every clump the sim grew, looked up by the shader at its root as it packed it into
// the records atlas (terrainParcel over the GPU's textures, not the sim's CPU port of it), stands in
// a parcel a clump may grow into (not a pasture or a wood), at a hedge (one side farmed) the inset
// from its line, on its ground, clear of roads and streams and out of the woods (which reach into
// fields): on the default land and on it with its woods off. And the scene draws them, on the land
// with its woods off: the woods may fill the near ground the verges keep to, leaving few hedges in
// view there.
import { visitorAlone } from "../../principals.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { fragmentSourceFor, sceneFeaturesAll } from "../../shaders/index.ts";
import { paramDefaults } from "../../state.ts";
import { loadScene } from "../index.ts";
import type { SimFrame } from "../types.ts";
import {
  type CountryBuilt,
  countryDraw,
  countryProgram,
  countryValues,
  differing,
} from "./terrain.verify.ts";
import { COUNTRY_VERGE } from "./verges.ts";

const countryScene = await loadScene("country");

const WIDTH = 192;
const HEIGHT = 108;
/** Probe pixels for the verges' clumps: one each, in clump order. */
const CLUMPS = { width: 64, height: 32 } as const;

const probeGlsl = /* glsl */ `
uniform int probeMode;
Shade probeCountryWild(vec2 uv, vec2 cell, float t) {
  Shade actual = sceneCountry(uv, cell, t);
  if (probeMode == 0) return actual;
  if (probeMode == 1) {
    // r: the flock's sheet covers here before any occlusion; g: the land the ray meets lies nearer
    // than the flock; b: the ray meets land at all.
    vec3 rd = countryToWorld(viewRay(uv, uRes.x / uRes.y, COUNTRY_HORIZON, COUNTRY_FOV));
    float tHit = countryMarch(terrainEye(uSim3), rd);
    bool near = tHit > 0.0 && tHit * dot(rd, countryFwd) < COUNTRY_MURMURATION_DEPTH;
    return shadeOf(vec3(step(0.05, countryFlockSheet(uv).x), near ? 1.0 : 0.0, tHit > 0.0 ? 1.0 : 0.0), 0.0, 0.0);
  }
  // r: a clump at this pixel's index; g 1 where the shader finds its root as the sim placed it.
  int c = int(cell.x) + int(cell.y) * int(uRes.x);
  vec4 grid = texelFetch(uSim3, ivec2(COUNTRY_VERGE_HEAD, 0), 0);
  vec4 more = texelFetch(uSim3, ivec2(COUNTRY_VERGE_HEAD + 1, 0), 0);
  if (c >= int(more.z + 0.5)) return shadeOf(vec3(0.0), 0.0, 0.0);
  int clumps = int(more.x + 0.5);
  int row = int(grid.x + 0.5);
  int width = textureSize(uSim3, 0).x;
  vec4 xz = countryVergeTexel(row, width, clumps + 2 * c);
  vec4 hy = countryVergeTexel(row, width, clumps + 2 * c + 1);
  vec3 root = vec3(xz.x + xz.y, hy.x + hy.y, xz.z + xz.w);
  TerrainParcel parcel = terrainParcel(uSim2, uSim3, root.xz, COUNTRY_EXTENT);
  float use = floor(parcel.use + 0.5);
  float other = floor(parcel.otherUse + 0.5);
  bool hedged = (use >= LAND_CROPS && use <= LAND_PASTURE) || (other >= LAND_CROPS && other <= LAND_PASTURE);
  bool grows = use != LAND_PASTURE && use != LAND_WOODLAND;
  bool foot = abs(parcel.border - ${glslFloat(COUNTRY_VERGE.inset)}) <= ${glslFloat(COUNTRY_VERGE.slack + 0.05)};
  bool ground = abs(root.y - terrainSurface(terrainGround(uSim0, root.xz, COUNTRY_EXTENT))) < 0.3;
  vec4 cover = terrainCover(uSim1, root.xz, COUNTRY_EXTENT);
  bool clear = cover.x > ${glslFloat(COUNTRY_VERGE.road - 0.25)} && cover.y > ${glslFloat(COUNTRY_VERGE.stream - 0.25)};
  countryWoodsSet();
  bool open = countryWoods(cover, terrainWater(terrainGround(uSim0, root.xz, COUNTRY_EXTENT)), false) <= 0.0;
  return shadeOf(vec3(1.0, hedged && grows && foot && ground && clear && open ? 1.0 : 0.5, clamp(parcel.border / 10.0, 0.0, 1.0)), 0.0, 0.0);
}
`;

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`country: ${message}`);
}

function simFrame(knobs: Record<string, number>, time: number, exit: number): SimFrame {
  return {
    dt: 1 / 60,
    time,
    motionTime: time,
    motion: 1,
    now: time * 1000,
    budget: Infinity,
    width: WIDTH,
    height: HEIGHT,
    aspect: WIDTH / HEIGHT,
    values: countryValues(knobs),
    params: { ...paramDefaults("country"), ...knobs },
    triggers: new Array<number>(8).fill(-1e4),
    fired: new Array<boolean>(8).fill(false),
    ...visitorAlone(),
    passage: { enter: 1, exit },
  };
}

/** The real sim, its terrain built for these knobs, run on frame by frame (each 1/60 s). */
interface Running {
  built: CountryBuilt;
  /** `frames` more frames with these knobs, the exit passage at exit(frame). */
  run(knobs: Record<string, number>, frames: number, exit?: (frame: number) => number): void;
}

function running(gl: WebGL2RenderingContext, knobs: Record<string, number>): Running {
  const sim = countryScene.sim?.(gl);
  if (!sim) throw new Error("country: no sim");
  let time = 0;
  let textures = sim.frame(simFrame(knobs, time, 0));
  let frames = 1;
  while (textures.length === 0 && frames < 4000) {
    time += 1 / 60;
    textures = sim.frame(simFrame(knobs, time, 0));
    frames++;
  }
  if (textures.length !== 4) {
    sim.dispose();
    throw new Error(`country: the sim bound ${textures.length} textures`);
  }
  const built: CountryBuilt = {
    textures,
    frames,
    step(more) {
      const started = performance.now();
      time += 1 / 60;
      sim.frame(simFrame(more, time, 0));
      return performance.now() - started;
    },
    dispose: () => sim.dispose(),
  };
  return {
    built,
    run(more, count, exit = () => 0) {
      for (let k = 0; k < count; k++) {
        time += 1 / 60;
        const bound = sim.frame(simFrame(more, time, exit(k)));
        check(
          bound.every((texture, slot) => texture === textures[slot]),
          "a sim frame bound other textures",
        );
      }
    },
  };
}

function programs(gl: WebGL2RenderingContext): { scene: WebGLProgram; probe: WebGLProgram } {
  const all = sceneFeaturesAll(countryScene);
  return {
    scene: countryProgram(gl, fragmentSourceFor(countryScene, all)),
    probe: countryProgram(
      gl,
      fragmentSourceFor(
        { ...countryScene, entry: "probeCountryWild", glsl: countryScene.glsl + probeGlsl },
        all,
      ),
    ),
  };
}

/** Per pixel, whether two frames differ in colour. */
function changed(a: Uint8Array, b: Uint8Array): boolean[] {
  return Array.from({ length: a.length / 4 }, (_, i) =>
    [0, 1, 2].some((c) => a[i * 4 + c] !== b[i * 4 + c]),
  );
}

export function verifyCountryMurmuration(gl: WebGL2RenderingContext): Record<string, unknown> {
  const { scene, probe } = programs(gl);
  const dusk = { time: 0.72, clouds: 0, shadows: 0, wind: 0, fog: 0 };
  const flock = { ...dusk, murmuration: 1, "murmuration-amount": 3000 };
  const sim = running(gl, dusk);
  const options = { width: WIDTH, height: HEIGHT, time: 30, motionTime: 30 };
  const draw = (program: WebGLProgram, knobs: Record<string, number>, mode: number) => {
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "probeMode"), mode);
    return countryDraw(gl, program, sim.built, knobs, options);
  };
  try {
    // Over the far fields, it shows.
    sim.run(flock, 120);
    const shown = differing(draw(scene, flock, 0), draw(scene, dusk, 0));
    check(shown >= 30, `the murmuration at dusk barely showed: ${shown} pixels`);
    // Down to roost: at moments along the pour, nothing of it over the land nearer than it.
    let drawn = 0;
    let behind = 0;
    let overLand = 0;
    for (let moment = 0; moment < 6; moment++) {
      const start = 10 * moment;
      sim.run(flock, 10, (k) => Math.min(1, (start + k) / 50));
      const starlings = changed(draw(scene, flock, 0), draw(scene, dusk, 0));
      const mask = draw(probe, flock, 1);
      starlings.forEach((bird, i) => {
        const raw = (mask[4 * i] ?? 0) > 127;
        const near = (mask[4 * i + 1] ?? 0) > 127;
        const land = (mask[4 * i + 2] ?? 0) > 127;
        check(!(bird && near), `the murmuration was drawn over nearer land, pixel ${i}`);
        if (bird) drawn++;
        if (bird && land) overLand++;
        if (raw && near) behind++;
      });
    }
    check(drawn >= 30, `the pouring murmuration barely showed: ${drawn} pixels`);
    check(behind >= 30, `the fixture never put the murmuration behind nearer land: ${behind}`);
    return { shown, drawn, behind, overLand };
  } finally {
    sim.built.dispose();
    gl.deleteProgram(scene);
    gl.deleteProgram(probe);
  }
}

export function verifyCountryVerges(gl: WebGL2RenderingContext): Record<string, unknown> {
  const { scene, probe } = programs(gl);
  const knobs = { verges: 1, "verges-amount": 1, time: 0.5, wind: 0.6, clouds: 0, shadows: 0 };
  const open = { ...knobs, woodland: 0 };
  const sim = running(gl, knobs);
  try {
    // Every clump the sim grew for these knobs, each checked at its root as the shader finds it.
    const probed = (settings: Record<string, number>): number => {
      sim.run(settings, 30);
      gl.useProgram(probe);
      gl.uniform1i(gl.getUniformLocation(probe, "probeMode"), 2);
      const roots = countryDraw(gl, probe, sim.built, settings, CLUMPS);
      let clumps = 0;
      for (let c = 0; c < CLUMPS.width * CLUMPS.height; c++) {
        if ((roots[4 * c] ?? 0) < 200) continue;
        clumps++;
        check(
          (roots[4 * c + 1] ?? 0) > 200,
          `clump ${c} does not stand at a hedge's foot out of the woods as the shader finds it (border code ${roots[4 * c + 2] ?? 0})`,
        );
      }
      check(clumps >= 100, `only ${clumps} clumps to check`);
      return clumps;
    };
    const clumps = { wooded: probed(knobs), open: probed(open) };
    gl.useProgram(scene);
    const options = { width: WIDTH, height: HEIGHT, time: 30, motionTime: 30 };
    const drawn = differing(
      countryDraw(gl, scene, sim.built, open, options),
      countryDraw(gl, scene, sim.built, { ...open, verges: 0 }, options),
    );
    // Measured: 512 pixels for 435 clumps (each a pixel or so at its depth in this frame).
    check(drawn >= 0.5 * clumps.open, `the verges drew ${drawn} pixels for ${clumps.open} clumps`);
    return { clumps, drawn };
  } finally {
    sim.built.dispose();
    gl.deleteProgram(scene);
    gl.deleteProgram(probe);
  }
}
