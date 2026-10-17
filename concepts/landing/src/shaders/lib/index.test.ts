import { describe, expect, test } from "bun:test";
import { common } from "../common.ts";
import { glslDefinitions, glslIdentifiers } from "../glsl.ts";
import { main } from "../main.ts";
import { birdsModule } from "./birds.ts";
import { libraryModules, modulesFor } from "./index.ts";
import { milkyWayModule } from "./milkyway.ts";
import { worldModule } from "./world.ts";

/** What every program holds ahead of its modules: the common preamble and `main`. */
const preamble = glslDefinitions(common + main("sceneEntry"));

describe("shared modules", () => {
  test("follow every module they require, each listed once", () => {
    expect(new Set(libraryModules).size).toBe(libraryModules.length);
    expect(new Set(libraryModules.map((module) => module.name)).size).toBe(libraryModules.length);
    libraryModules.forEach((module, at) => {
      for (const { module: needed } of module.requires) {
        expect({ module: module.name, needs: needed.name, after: libraryModules.indexOf(needed) < at }).toEqual({
          module: module.name,
          needs: needed.name,
          after: true,
        });
      }
    });
  });

  test("define each name in one place only", () => {
    const owner = new Map<string, string>();
    for (const module of libraryModules) {
      for (const name of module.provides) {
        expect({ name, also: owner.get(name) ?? (preamble.has(name) ? "common" : undefined) }).toEqual({
          name,
          also: undefined,
        });
        owner.set(name, module.name);
      }
    }
  });

  test("require exactly the modules whose names they use", () => {
    const owner = new Map(
      libraryModules.flatMap((module) => [...module.provides].map((name) => [name, module.name] as const)),
    );
    for (const module of libraryModules) {
      const used = new Set<string>();
      for (const name of glslIdentifiers(module.source)) {
        const from = module.provides.has(name) ? undefined : owner.get(name);
        if (from !== undefined) used.add(from);
      }
      const declared = module.requires.map(({ module: needed }) => needed.name).sort();
      expect({ module: module.name, requires: declared }).toEqual({
        module: module.name,
        requires: [...used].sort(),
      });
    }
  });
});

describe("a program's modules", () => {
  test("are none for GLSL that names no shared function", () => {
    const own = "float sceneWave(vec2 p) { return vnoise(p) * bell(p.x); }";
    expect(modulesFor(own, {})).toEqual([]);
  });

  test("leave out a name the scene defines itself", () => {
    expect(modulesFor("vec3 skyColor(vec3 d) { return d; } vec3 f() { return skyColor(vec3(1.0)); }", {})).toEqual([]);
  });

  test("take a module's requirements in order, those under a gate only with it", () => {
    const caller = "vec3 sceneSky() { World w = worldAt(0, 1); return w.sky.ambient; }";
    const plain = modulesFor(caller, { WORLD_BIRDS: 0, WORLD_MILKYWAY: 0 });
    expect(plain.at(-1)).toBe(worldModule);
    expect(plain).not.toContain(birdsModule);
    expect(plain).not.toContain(milkyWayModule);
    const gated = modulesFor(caller, { WORLD_BIRDS: 1, WORLD_MILKYWAY: 1 });
    expect(gated).toContain(birdsModule);
    expect(gated).toContain(milkyWayModule);
    expect(gated.indexOf(birdsModule)).toBeLessThan(gated.indexOf(worldModule));
  });

  test("leave out what the scene's own conditionals certainly drop, and keep what they may not", () => {
    const gated = "#if SCENE_HAS_BIRDS\nBirdSky b = birdSky(1.0, 0.0, 0.0, vec2(0.0), vec2(0.0), 0.0);\n#endif\n";
    expect(modulesFor(gated, { SCENE_HAS_BIRDS: 0 })).not.toContain(birdsModule);
    expect(modulesFor(gated, { SCENE_HAS_BIRDS: 1 })).toContain(birdsModule);
    // A condition on a macro some module may define cannot be decided from the scene alone.
    const undecided = gated.replace("SCENE_HAS_BIRDS", "WATER_TIER >= WATER_MIRROR");
    expect(modulesFor(undecided, {})).toContain(birdsModule);
  });
});
