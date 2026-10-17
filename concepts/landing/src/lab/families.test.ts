import { expect, test } from "bun:test";
import { sceneIds } from "../scenes/index.ts";
import { families, sceneFamily, sceneOrder, sceneStep } from "./families.ts";

test("the Scenes view's order holds every scene once, shelf by shelf", () => {
  expect([...sceneOrder].sort()).toEqual([...sceneIds].sort());
  const shelves = sceneOrder.map((id) =>
    families.findIndex((family) => family.id === sceneFamily[id]),
  );
  expect(shelves).toEqual([...shelves].sort((a, b) => a - b));
});

test("[ and ] walk the Scenes view's order, round from the last scene to the first", () => {
  const first = sceneOrder[0];
  const last = sceneOrder.at(-1);
  if (first === undefined || last === undefined) throw new Error("no scenes");
  expect(sceneStep(last, 1)).toBe(first);
  expect(sceneStep(first, -1)).toBe(last);
  // Off the end of a shelf, onto the next shelf's first scene.
  for (const [at, family] of families.slice(0, -1).entries()) {
    const shelf = sceneOrder.filter((id) => sceneFamily[id] === family.id);
    const next = sceneOrder.filter((id) => sceneFamily[id] === families[at + 1]?.id);
    const end = shelf.at(-1);
    if (end !== undefined) expect(sceneStep(end, 1)).toBe(next[0] ?? end);
  }
});
