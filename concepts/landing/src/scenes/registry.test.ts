import { expect, test } from "bun:test";
import { assembleFragment } from "../shaders/index.ts";
import { loadedScene, loadScene, sceneDefs, sceneIds } from "./index.ts";

/** What a scene's code module may add to its definition (SceneCode). */
const CODE_KEYS = ["entry", "glsl", "glslFor", "sim"];

test("every scene loads its code, which carries the registry's definition unchanged", async () => {
  for (const id of sceneIds) {
    const def = sceneDefs[id];
    expect({ id, def: def.id }).toEqual({ id, def: id });
    const scene = await loadScene(id);
    // The definition as the registry holds it, field for field (the very values the lab reads).
    const changed = Object.keys(def).filter(
      (key) => !Object.is(Reflect.get(scene, key), Reflect.get(def, key)),
    );
    expect({ id, changed }).toEqual({ id, changed: [] });
    // The code adds its own fields alone: none overrides a definition's.
    const added = Object.keys(scene).filter((key) => !Object.hasOwn(def, key));
    expect({ id, foreign: added.filter((key) => !CODE_KEYS.includes(key)) }).toEqual({
      id,
      foreign: [],
    });
    // Its GLSL defines the entry its program's main calls.
    expect({ id, entry: assembleFragment(scene).includes(`Shade ${scene.entry}(`) }).toEqual({
      id,
      entry: true,
    });
    // One loaded scene, shared by every later ask (a check that patches it patches what draws).
    expect(loadedScene(id)).toBe(scene);
    expect(await loadScene(id)).toBe(scene);
  }
});
