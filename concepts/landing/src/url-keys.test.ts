import { expect, test } from "bun:test";
import { sceneDefs, sceneIds, type SceneId } from "./scenes/index.ts";
import { PLANETS_KEY } from "./scenes/planets.ts";
import { defaults, migrate, paramDefaults, sessionKeys } from "./state.ts";
import published from "./url-keys.json";

// Every URL key the lab has published (url-keys.json: its own settings, and each scene's keys by
// scene) keeps its meaning: a link carrying it opens as it did. The file only grows. A new knob adds
// its key; a key removed or renamed stays, and a migration has to map it, or this fails.

const known = (id: string): id is SceneId => (sceneIds as readonly string[]).includes(id);

/**
 * Whether a link's `key` still reaches something in `scene`: one of its knobs (or a feature's
 * amount), its planets, or the URL schema's migrations (state.ts MIGRATIONS) carry it there. A
 * link of schema 1 (no `v`, so it runs every step) naming the scene and the key is migrated and
 * compared with the same link without the key: the key resolves when
 * - it is a knob or the planets key, whatever the chain does (no step is needed), or
 * - a step took it out and everything the chain put in its place is a knob of the scene or its
 *   planets key (a rename, a rescale, the old giant planet's keys onto its planets), or a step took
 *   it out and put nothing (the key is dropped on purpose).
 * A key the chain leaves in the query that no knob reads, or one it maps onto a key that is no
 * knob, is lost.
 */
function resolves(scene: SceneId, key: string): boolean {
  const def = sceneDefs[scene];
  const knobs = paramDefaults(scene);
  const current = (name: string): boolean =>
    name in knobs || (def.planets !== undefined && name === PLANETS_KEY);
  if (current(key)) return true;
  const bare = migrate(new URLSearchParams({ scene }));
  const migrated = migrate(new URLSearchParams({ scene, [key]: "1" }));
  if (migrated.has(key)) return false;
  for (const name of migrated.keys()) {
    if (name !== "scene" && !bare.has(name) && !current(name)) return false;
  }
  return true;
}

const labKeys: readonly string[] = [...Object.keys(defaults), ...Object.values(sessionKeys)];

test("every published scene still opens", () => {
  expect(Object.keys(published.scenes).filter((scene) => !known(scene))).toEqual([]);
});

test("every published setting of the lab's own is still read", () => {
  expect(published.lab.filter((key) => !labKeys.includes(key))).toEqual([]);
});

test("every published key of a scene still reaches a knob, its planets or a migration", () => {
  const lost: string[] = [];
  for (const [scene, keys] of Object.entries(published.scenes)) {
    if (!known(scene)) continue;
    for (const key of keys) if (!resolves(scene, key)) lost.push(`${scene}: ${key}`);
  }
  expect(lost).toEqual([]);
});

test("every key the lab reads today is published", () => {
  // Add a new knob's key (and a feature's `-amount`) to url-keys.json.
  const scenes: Readonly<Record<string, readonly string[]>> = published.scenes;
  const missing = labKeys.filter((key) => !published.lab.includes(key));
  for (const scene of sceneIds) {
    const keys = Object.keys(paramDefaults(scene));
    if (sceneDefs[scene].planets !== undefined) keys.push(PLANETS_KEY);
    const listed = scenes[scene] ?? [];
    for (const key of keys) if (!listed.includes(key)) missing.push(`${scene}: ${key}`);
  }
  expect(missing).toEqual([]);
});
