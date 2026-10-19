// bun concepts/landing/scripts/glsl-check.ts [scene...]
//
// Whether every scene's fragment program compiles, links and fits WebGL 2's uniform minimum: its
// default program and, for a setting-keyed scene, its all-features program; for a composed scene
// also the all-features program of each of its layers turned and the programs of each other choice
// of a structural mode (the dunes' overhead `camera`), and for every scene its committed
// presets' programs (README "Programs and cost": every preset and committed mix, every layer over
// its preset's own); each as the renderer builds it (shaders/index.ts fragmentSourceFor: shaken),
// compiled and linked with the shared vertex shader by Khronos's reference compiler,
// glslangValidator, as GLSL ES 3.00. Its fragment uniform vectors are counted from glslang's
// reflection of the uniforms the program uses: an element of up to four components takes a row, a
// matrix a row per column, and samplers take texture units, not rows. WebGL 2 guarantees
// MAX_FRAGMENT_UNIFORM_VECTORS of 224 and no more, and a driver may give every element a row of its
// own, so a program counted over 224 fails here. A line per program goes to stdout; the run exits 1
// when a program fails to build or is over, 2 on a bad argument.
//
// glslangValidator is the system's: nixpkgs `glslang` on a dev box, apt `glslang-tools` in CI, or
// the binary GLSLANG_VALIDATOR names. Without one the check is skipped (exit 0), except under CI
// (CI set), where that fails.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { readKnobs } from "../src/params.ts";
import { presets } from "../src/presets.ts";
import { loadScene, sceneIds, type SceneId } from "../src/scenes/index.ts";
import {
  fragmentSourceFor,
  sceneFeatures,
  sceneFeaturesAll,
  shaderValues,
  vertexSource,
} from "../src/shaders/index.ts";

class GlslCheckError extends Error {}

/** WebGL 2's guaranteed MAX_FRAGMENT_UNIFORM_VECTORS. */
const FRAGMENT_UNIFORM_VECTORS = 224;
/** glslang's reflection marks a uniform the fragment stage uses with this bit of its `stages`. */
const FRAGMENT_STAGE = 1 << 4;
/** GL type enums (hex, as glslang reflects them) of float, int, uint, bool and their vectors. */
const VECTOR_TYPES =
  "1406 1404 1405 8b56 8b50 8b51 8b52 8b53 8b54 8b55 8b57 8b58 8b59 8dc6 8dc7 8dc8";
/** GL type enums of the GLSL ES 3.00 samplers. */
const SAMPLER_TYPES = "8b5e 8b5f 8b60 8b62 8dc1 8dc4 8dc5 8dca 8dcb 8dcc 8dcf 8dd2 8dd3 8dd4 8dd7";

/**
 * Rows an element of each uniform type takes, by its GL type enum: a scalar or vector one, a matrix
 * one per column (mat2, mat3, mat4, mat2x3, mat2x4, mat3x2, mat3x4, mat4x2, mat4x3), a sampler none
 * (it takes a texture unit).
 */
const ROWS: Readonly<Record<string, number>> = {
  ...Object.fromEntries(VECTOR_TYPES.split(" ").map((type) => [type, 1])),
  ...Object.fromEntries(SAMPLER_TYPES.split(" ").map((type) => [type, 0])),
  "8b5a": 2,
  "8b5b": 3,
  "8b5c": 4,
  "8b65": 2,
  "8b66": 2,
  "8b67": 3,
  "8b68": 3,
  "8b69": 4,
  "8b6a": 4,
};

/** One reflected uniform: `name: offset o, type t, size n, index i, binding b, stages s`. */
const REFLECTED = /^([\w.[\]]+): offset -?\d+, type ([0-9a-f]+), size (\d+), .*\bstages (\d+)/gm;

const asked = process.argv.slice(2);
for (const id of asked)
  if (!(sceneIds as readonly string[]).includes(id)) {
    console.error(
      `glsl-check: no scene "${id}"\nusage: bun concepts/landing/scripts/glsl-check.ts [scene...]`,
    );
    process.exit(2);
  }

const validator = process.env.GLSLANG_VALIDATOR ?? Bun.which("glslangValidator");
if (validator === null) {
  const how =
    "install glslangValidator (nixpkgs glslang, apt glslang-tools) or set GLSLANG_VALIDATOR";
  if (process.env.CI !== undefined) {
    console.error(`glsl-check: no glslangValidator under CI: ${how}`);
    process.exit(1);
  }
  console.log(`glsl-check: skipped, no glslangValidator on PATH: ${how}`);
  process.exit(0);
}

/**
 * A program to check: a scene's default or all-features fragment program; for a composed scene
 * (SceneDef.layers) also the all-features program of each layer turned (switched on, or off where
 * it is one of the preset's own; a backdrop or ground swapped for the one of its role), the own and
 * all-features programs of each other choice of a structural knob that is not a layer switch (the
 * dunes' overhead `camera`), and the default and all-features programs of each committed preset of
 * the scene (src/presets.ts).
 */
interface Program {
  id: SceneId;
  kind: string;
  source: string;
}

const ids = asked.length > 0 ? (asked as SceneId[]) : sceneIds;
const programs: Program[] = (
  await Promise.all(ids.map(async (id) => ({ id, scene: await loadScene(id) })))
).flatMap(({ id, scene }) => {
  const out: Program[] = [
    { id, kind: "default", source: fragmentSourceFor(scene, sceneFeatures(scene)) },
  ];
  const all = sceneFeaturesAll(scene);
  if (all !== undefined)
    out.push({ id, kind: "all-features", source: fragmentSourceFor(scene, all) });
  const layers = scene.layers;
  if (layers !== undefined)
    for (const layer of layers.offered) {
      const home = layers.home.includes(layer.id);
      const knobs: Record<string, number> = { [layer.id]: home ? 0 : 1 };
      if (!home && (layer.role === "backdrop" || layer.role === "ground"))
        for (const other of layers.offered)
          if (other.role === layer.role && other.id !== layer.id) knobs[other.id] = 0;
      const features = sceneFeaturesAll(scene, shaderValues(scene, knobs));
      if (features !== undefined)
        out.push({
          id,
          kind: `all-features, ${layer.id} ${home ? "off" : "on"}`,
          source: fragmentSourceFor(scene, features),
        });
    }
  for (const key of scene.structural ?? []) {
    if (layers?.offered.some((layer) => layer.id === key) === true) continue;
    const def = scene.params.find((knob) => knob.key === key);
    if (def?.kind !== "choice") continue;
    for (const option of def.options) {
      if (option.value === def.value) continue;
      const values = shaderValues(scene, { [key]: option.value });
      out.push({
        id,
        kind: `${key} ${option.value}`,
        source: fragmentSourceFor(scene, sceneFeatures(scene, values)),
      });
      const features = sceneFeaturesAll(scene, values);
      if (features !== undefined)
        out.push({
          id,
          kind: `all-features, ${key} ${option.value}`,
          source: fragmentSourceFor(scene, features),
        });
    }
  }
  for (const preset of presets) {
    const query = new URLSearchParams(preset.query);
    if (query.get("scene") !== id) continue;
    const values = shaderValues(
      scene,
      readKnobs(scene.params, (key) => query.get(key)),
    );
    out.push({
      id,
      kind: `"${preset.name}"`,
      source: fragmentSourceFor(scene, sceneFeatures(scene, values)),
    });
    const allOf = sceneFeaturesAll(scene, values);
    if (allOf !== undefined)
      out.push({
        id,
        kind: `"${preset.name}" all-features`,
        source: fragmentSourceFor(scene, allOf),
      });
  }
  return out;
});

/**
 * The fragment uniform vectors `reflection` (glslangValidator -q) says a program uses; throws
 * GlslCheckError for a uniform type it does not know the rows of.
 */
function fragmentVectors(reflection: string): number {
  const uniforms = reflection
    .split("Uniform reflection:")[1]
    ?.split("Uniform block reflection:")[0];
  if (uniforms === undefined) throw new GlslCheckError("no uniform reflection in glslang's output");
  let vectors = 0;
  for (const [, name = "", type = "", size = "0", stages = "0"] of uniforms.matchAll(REFLECTED)) {
    if ((Number(stages) & FRAGMENT_STAGE) === 0) continue;
    const rows = ROWS[type];
    if (rows === undefined) throw new GlslCheckError(`uniform ${name}: unknown type 0x${type}`);
    vectors += rows * Number(size);
  }
  return vectors;
}

/** The program's line under each glslang error that names one (`ERROR: <file>:<line>: ...`). */
function annotated(log: string, source: string): string {
  const lines = source.split("\n");
  return log
    .split("\n")
    .filter((entry) => entry.startsWith("ERROR"))
    .map((entry) => {
      const line = /^ERROR: [^:]*\.frag:(\d+):/.exec(entry)?.[1];
      return line === undefined
        ? entry
        : `${entry}\n    > ${(lines[Number(line) - 1] ?? "").trim()}`;
    })
    .join("\n");
}

const dir = await mkdtemp(join(tmpdir(), "landing-glsl-"));
let failed = 0;
try {
  const vertex = join(dir, "landing.vert");
  await writeFile(vertex, vertexSource);
  const check = async (program: Program): Promise<string> => {
    const name = `${program.id} ${program.kind}`;
    const fragment = join(dir, `${program.id}.${programs.indexOf(program)}.frag`);
    await writeFile(fragment, program.source);
    const run = Bun.spawn([validator, "-l", "-q", fragment, vertex], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    if (code !== 0) {
      failed++;
      return `${name}: FAILED to build\n${annotated(`${out}\n${err}`, program.source)}`;
    }
    const vectors = fragmentVectors(out);
    const over = vectors > FRAGMENT_UNIFORM_VECTORS;
    if (over) failed++;
    return (
      `${name}: ${over ? "OVER" : "ok"}, ${vectors} of ${FRAGMENT_UNIFORM_VECTORS} fragment ` +
      `uniform vectors, ${program.source.length} chars`
    );
  };
  // A few glslang processes at a time, the lines in program order.
  const lanes = Math.max(1, Math.min(4, availableParallelism()));
  const results: string[] = [];
  for (let at = 0; at < programs.length; at += lanes)
    results.push(...(await Promise.all(programs.slice(at, at + lanes).map(check))));
  console.log(results.join("\n"));
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log(
  failed === 0
    ? `glsl-check: ${programs.length} programs build and fit`
    : `glsl-check: ${failed} of ${programs.length} programs fail`,
);
process.exitCode = failed === 0 ? 0 : 1;
