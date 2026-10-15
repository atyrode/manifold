import { expect, test } from "bun:test";
import { mulberry32 } from "../../sims/random.ts";
import { buildRoutine, marblePalettes, marblePatterns, marblePractice, marblePractices, type MarblePattern, type MarblePractice } from "./sim.ts";

const ASPECT = 16 / 9;

function routine(pattern: MarblePattern, palette: number, practice: MarblePractice) {
  const inks = marblePalettes[palette];
  if (!inks) throw new Error(`no palette ${palette}`);
  return buildRoutine({ pattern, palette: inks, practice, scale: 1, aspect: ASPECT, mark: 0, rand: mulberry32(1234) });
}

test("'by inks' follows each palette's own practice; the named practices override it", () => {
  for (const palette of marblePalettes) {
    expect(marblePractice(0, palette)).toBe(palette.practice);
    marblePractices.forEach((practice, index) => expect(marblePractice(index + 1, palette)).toBe(practice));
  }
});

test("the practice decides how ink is laid, whatever the inks", () => {
  for (let palette = 0; palette < marblePalettes.length; palette++) {
    const ebru = routine("bouquet", palette, "ebru");
    const ebruDrops = ebru.ops.filter((op) => op.kind === "drop");
    // Ebru: a ground colour spreading over the whole view first, then only coloured stones.
    const ground = ebruDrops[0];
    expect(ground?.color).not.toBeNull();
    expect(ground?.r2 ?? 0).toBeGreaterThan((ASPECT / 2) ** 2 + 0.25);
    expect(ebru.lead).toBeGreaterThan(0);
    expect(ebruDrops.every((op) => op.color !== null)).toBe(true);

    const sumi = routine("bouquet", palette, "suminagashi");
    const sumiDrops = sumi.ops.filter((op) => op.kind === "drop");
    // Suminagashi: no ground, ink and clear water touched in turn, so half the drops are water.
    expect(sumi.lead).toBe(0);
    const water = sumiDrops.filter((op) => op.color === null).length;
    expect(water * 2).toBe(sumiDrops.length);
    expect(sumiDrops.every((op) => op.r2 < 0.1 ** 2)).toBe(true);
  }
});

test("an uncombed suminagashi sheet is turned by breath and fan; combs replace it, and ebru stones stay still", () => {
  const kinds = (pattern: MarblePattern, practice: MarblePractice) => new Set(routine(pattern, 2, practice).ops.map((op) => op.kind));
  const fanned = kinds("stone", "suminagashi");
  expect(fanned.has("swirl")).toBe(true);
  expect(fanned.has("stroke")).toBe(false);
  const stones = kinds("stone", "ebru");
  expect(stones.has("swirl")).toBe(false);
  expect(stones.has("stroke")).toBe(false);
  for (const pattern of marblePatterns.filter((name) => name !== "stone")) {
    for (const practice of marblePractices) {
      const combed = kinds(pattern, practice);
      expect(combed.has("stroke")).toBe(true);
      expect(combed.has("swirl")).toBe(false);
    }
  }
});
