import { expect, test } from "bun:test";
import { sceneDefs, sceneIds, type SceneId } from "./scenes/index.ts";
import { PLANETS_KEY } from "./scenes/planets.ts";
import { defaults, migrate, paramDefaults, resolveScene, sessionKeys } from "./state.ts";
import published from "./url-keys.json";

// Every URL key the lab has published (url-keys.json: its own settings, and each scene's keys by
// scene with the meaning it was published with, `signature`) keeps its meaning: a link carrying it
// opens as it did. The file only grows. A new knob adds its key; a key removed or renamed stays, and
// a migration has to map it, or this fails; so does a key that changes kind, or a choice that loses
// an option. A retired scene's keys stay too, under its id: its alias (state.ts MIGRATIONS) opens
// its links on its successor and has to carry each of them there.

/**
 * What a link's `key` means to `scene` today: its knob's kind (range, toggle, feature, choice or
 * seed), a choice's option values after it ("choice 0 1 2"), a feature's `-amount` as a range or
 * as its choice, and "planets" for the scene's planets. Undefined for a key the scene does not read.
 */
function signature(scene: SceneId, key: string): string | undefined {
  const def = sceneDefs[scene];
  if (def.planets !== undefined && key === PLANETS_KEY) return "planets";
  for (const knob of def.params) {
    const amount = knob.kind === "feature" && `${knob.key}-amount` === key;
    if (knob.key !== key && !amount) continue;
    const options = amount ? knob.options : knob.kind === "choice" ? knob.options : undefined;
    const kind = options ? "choice" : amount ? "range" : knob.kind;
    return [kind, ...(options ?? []).map((option) => option.value)].join(" ");
  }
  return undefined;
}

/**
 * Whether a link reads `key` as published (`was`): of the same kind, and a choice with every option
 * it had (an option added since leaves its links alone).
 */
function keepsMeaning(was: string, now: string): boolean {
  const [kind, ...values] = was.split(" ");
  const [today, ...options] = now.split(" ");
  return kind === today && values.every((value) => options.includes(value));
}

/**
 * Whether a link's `key` still reaches something in the scene that opens links naming `scene` (that
 * scene, or the one its aliases lead to, resolveScene): one of its knobs (or a feature's amount), its
 * planets, or the URL schema's migrations (state.ts MIGRATIONS) carry it there. A link of schema 1
 * (no `v`, so it runs every step) naming the scene and the key is migrated and compared with the
 * same link without the key: the key resolves when
 * - the chain leaves it in the query and it is a knob of the opening scene or its planets key (a key
 *   the successor shares carries over as it is), or
 * - a step took it out and everything the chain put in its place is a knob of the opening scene or
 *   its planets key (a rename, a rescale, the old giant planet's keys onto its planets, a retired
 *   scene's key onto its successor's knob), or a step took it out and put nothing (the key is
 *   dropped on purpose).
 * A key the chain leaves in the query that no knob reads, or one it maps onto a key that is no
 * knob, is lost.
 */
function resolves(scene: string, key: string): boolean {
  const opens = resolveScene(scene);
  if (opens === undefined) return false;
  const def = sceneDefs[opens];
  const knobs = paramDefaults(opens);
  const current = (name: string): boolean =>
    name in knobs || (def.planets !== undefined && name === PLANETS_KEY);
  const bare = migrate(new URLSearchParams({ scene }));
  const migrated = migrate(new URLSearchParams({ scene, [key]: "1" }));
  if (migrated.has(key)) return current(key);
  for (const name of migrated.keys()) {
    if (name !== "scene" && !bare.has(name) && !current(name)) return false;
  }
  return true;
}

/**
 * Whether the migration chain leaves a link's `key` alone, so the opening scene reads it as it is: a
 * link of schema 1 naming `scene` and `key` migrates to the same link without the key, plus the key
 * as it was. Otherwise a step carries it (the test above holds where to).
 */
function leftAlone(scene: string, key: string): boolean {
  const expected = migrate(new URLSearchParams({ scene }));
  expected.set(key, "1");
  expected.sort();
  const migrated = migrate(new URLSearchParams({ scene, [key]: "1" }));
  migrated.sort();
  return migrated.toString() === expected.toString();
}

const labKeys: readonly string[] = [...Object.keys(defaults), ...Object.values(sessionKeys)];
const scenes: Readonly<Record<string, Readonly<Record<string, string>>>> = published.scenes;

test("every published scene still opens, itself or through its alias", () => {
  expect(Object.keys(scenes).filter((scene) => resolveScene(scene) === undefined)).toEqual([]);
});

test("every published setting of the lab's own is still read", () => {
  expect(published.lab.filter((key) => !labKeys.includes(key))).toEqual([]);
});

test("every published key of a scene still reaches a knob, its planets or a migration", () => {
  const lost: string[] = [];
  for (const [scene, keys] of Object.entries(scenes)) {
    for (const key of Object.keys(keys)) if (!resolves(scene, key)) lost.push(`${scene}: ${key}`);
  }
  expect(lost).toEqual([]);
});

test("every published key the migrations leave alone keeps its kind, and a choice its options", () => {
  // A key whose meaning changes needs a migration that rewrites older links (state.ts MIGRATIONS).
  const changed: string[] = [];
  for (const [scene, keys] of Object.entries(scenes)) {
    const opens = resolveScene(scene);
    if (opens === undefined) continue;
    for (const [key, was] of Object.entries(keys)) {
      if (!leftAlone(scene, key)) continue;
      const now = signature(opens, key) ?? "unread";
      if (!keepsMeaning(was, now)) changed.push(`${scene}: ${key} was "${was}", now "${now}"`);
    }
  }
  expect(changed).toEqual([]);
});

test("every key the lab reads today is published", () => {
  // Add each missing entry (a new knob's key and a feature's `-amount`) to url-keys.json as listed.
  const missing = labKeys.filter((key) => !published.lab.includes(key));
  for (const scene of sceneIds) {
    const keys = Object.keys(paramDefaults(scene));
    if (sceneDefs[scene].planets !== undefined) keys.push(PLANETS_KEY);
    const listed = scenes[scene] ?? {};
    for (const key of keys)
      if (!(key in listed)) missing.push(`${scene}: "${key}": "${signature(scene, key) ?? ""}"`);
  }
  expect(missing).toEqual([]);
});
