import { expect, test } from "bun:test";
import { sceneIds } from "../scenes/index.ts";
import { families, labOnly, sceneCycle, sceneFamily, sceneOrder, sceneStep } from "./families.ts";

test("the Scenes view's order holds every scene once, shelf by shelf", () => {
  expect([...sceneOrder].sort()).toEqual([...sceneIds].sort());
  const shelves = sceneOrder.map((id) =>
    families.findIndex((family) => family.id === sceneFamily[id]),
  );
  expect(shelves).toEqual([...shelves].sort((a, b) => a - b));
});

test("the cycle is the Scenes view's order less the lab-only scenes", () => {
  expect(sceneCycle).toEqual(sceneOrder.filter((id) => labOnly[id] !== true));
  expect(sceneCycle).not.toContain("room");
  expect(sceneCycle).not.toContain("land");
  expect(sceneCycle).not.toContain("patch");
});

test("[ and ] walk the cycle, round from the last scene to the first", () => {
  const first = sceneCycle[0];
  const last = sceneCycle.at(-1);
  if (first === undefined || last === undefined) throw new Error("no scenes");
  expect(sceneStep(last, 1)).toBe(first);
  expect(sceneStep(first, -1)).toBe(last);
  // Off the end of a shelf, onto the next shelf's first scene.
  for (const [at, family] of families.slice(0, -1).entries()) {
    const shelf = sceneCycle.filter((id) => sceneFamily[id] === family.id);
    const next = sceneCycle.filter((id) => sceneFamily[id] === families[at + 1]?.id);
    const end = shelf.at(-1);
    if (end !== undefined) expect(sceneStep(end, 1)).toBe(next[0] ?? end);
  }
});

test("[ and ] leave a lab-only scene for the cycle's scenes either side of it", () => {
  for (const id of sceneOrder.filter((scene) => labOnly[scene] === true)) {
    const at = sceneOrder.indexOf(id);
    const before = sceneOrder.slice(0, at).filter((scene) => labOnly[scene] !== true);
    const after = sceneOrder.slice(at + 1).filter((scene) => labOnly[scene] !== true);
    expect(sceneStep(id, 1)).toBe(after[0] ?? sceneCycle[0] ?? id);
    expect(sceneStep(id, -1)).toBe(before.at(-1) ?? sceneCycle.at(-1) ?? id);
  }
});
