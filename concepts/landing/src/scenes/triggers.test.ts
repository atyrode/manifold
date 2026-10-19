import { expect, test } from "bun:test";
import { sceneDefs } from "./index.ts";

test("no two knobs of a scene share a trigger slot, so each 'now' fires only its own", () => {
  // The lab stamps a slot, not a knob (renderer.trigger): two knobs on one slot fire together.
  const shared: string[] = [];
  for (const [id, scene] of Object.entries(sceneDefs)) {
    const owners = new Map<number, string>();
    for (const def of scene.params) {
      if (def.trigger === undefined) continue;
      const owner = owners.get(def.trigger);
      if (owner === undefined) owners.set(def.trigger, def.key);
      else shared.push(`${id}: ${owner} and ${def.key} on slot ${def.trigger}`);
    }
  }
  expect(shared).toEqual([]);
});
