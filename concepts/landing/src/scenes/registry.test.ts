import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { families, sceneFamily, sceneOrder } from "../lab/families.ts";
import { assembleFragment } from "../shaders/index.ts";
import { loadedScene, loadScene, sceneDefs, sceneIds } from "./index.ts";

const sorted = (items: Iterable<string>) => [...items].sort();

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

// The registry, its folders, families, thumbnails and docs in step (README "The scenes"): every
// registered scene has each, and none of them names a scene the registry lacks.
test("every scene, and only a registered one, has its folder, family and thumbnail", () => {
  const folders = readdirSync(new URL("./", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(new URL(`./${entry.name}/index.ts`, import.meta.url)))
    .map((entry) => entry.name);
  expect(sorted(folders)).toEqual(sorted(sceneIds));
  expect(sorted(Object.keys(sceneFamily))).toEqual(sorted(sceneIds));
  const familyIds = families.map((family) => family.id);
  expect(sceneIds.filter((id) => !familyIds.includes(sceneFamily[id]))).toEqual([]);
  expect(sorted(sceneOrder)).toEqual(sorted(sceneIds));
  const thumbs = readdirSync(new URL("../../thumbs/", import.meta.url));
  expect(sorted(thumbs)).toEqual(sorted(sceneIds.map((id) => `${id}.webp`)));
});

test("the README's scenes table holds every scene's row, as the registry has it", async () => {
  const readme = await Bun.file(new URL("./README.md", import.meta.url)).text();
  const region = readme.match(/<!-- gen:scenes -->([\s\S]*?)<!-- \/gen:scenes -->/)?.[1] ?? "";
  const rows = region
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) =>
      line
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim()),
    )
    .map(([id = "", title, family]) => [id.replaceAll("`", ""), title, family]);
  const familyTitle: Record<string, string> = Object.fromEntries(
    families.map((family) => [family.id, family.title]),
  );
  expect(rows).toEqual(
    sceneOrder.map((id) => [id, sceneDefs[id].title, familyTitle[sceneFamily[id]]]),
  );
});
