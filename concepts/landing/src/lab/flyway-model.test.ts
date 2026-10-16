import { describe, expect, test } from "bun:test";
import { BIRD_FORMATIONS, BIRD_KIND, birdsGlsl, type BirdKind } from "../shaders/lib/birds.ts";
import {
  aloft,
  flightOf,
  formationOf,
  SPECIES_FLIGHT,
  speciesOf,
  STRIP_BIRDS,
  tileStep,
} from "./flyway-model.ts";

const kind = (label: BirdKind) => BIRD_KIND[label];
const formation = (label: (typeof BIRD_FORMATIONS)[number]["label"]) =>
  BIRD_FORMATIONS.find((option) => option.label === label)?.value ?? Number.NaN;

test("each species flies as birdSpecies has it: its own formation and flock", () => {
  const constants = new Map(
    [...birdsGlsl.matchAll(/^const float BIRD_(\w+) = (-?[\d.]+);/gm)].map((m) => [
      m[1] ?? "",
      Number(m[2]),
    ]),
  );
  // birdSpecies' table holds one BirdSpecies per kind, in kind order: ..., formation, flock (vec2), ...
  const rows = [
    ...birdsGlsl.matchAll(/^\s*BirdSpecies\(.*?BIRD_(\w+), vec2\(([\d.]+), ([\d.]+)\)/gm),
  ];
  const species = (Object.keys(BIRD_KIND) as BirdKind[]).sort((a, b) => kind(a) - kind(b));
  expect(rows.length).toBe(species.length);
  for (const [index, label] of species.entries()) {
    const row = rows[index];
    const glsl = constants.get(row?.[1] ?? "") ?? Number.NaN;
    expect(formationOf(glsl + 1)).toBe(SPECIES_FLIGHT[label].formation);
    expect([Number(row?.[2]), Number(row?.[3])]).toEqual([...SPECIES_FLIGHT[label].flock]);
  }
});

describe("a flight of one species", () => {
  test("flies its own formation and flock as usual", () => {
    expect(flightOf(kind("geese"), formation("usual"))).toEqual({ formation: "V", party: [5, 9] });
    expect(flightOf(kind("buzzard"), formation("usual"))).toEqual({
      formation: "circling",
      party: [1, 1],
    });
    expect(flightOf(kind("gulls"), formation("usual"))).toEqual({
      formation: "party",
      party: [1, 4],
    });
  });

  test("flies alone, whatever its flock", () => {
    for (const label of ["pigeons", "geese", "buzzard"] as const)
      expect(flightOf(kind(label), formation("solo"))).toEqual({
        formation: "solo",
        party: [1, 1],
      });
  });

  test("makes up a party or a V to their least, keeping a larger flock", () => {
    expect(flightOf(kind("buzzard"), formation("party")).party).toEqual([2, 4]);
    expect(flightOf(kind("gulls"), formation("party")).party).toEqual([2, 4]);
    expect(flightOf(kind("rooks"), formation("party")).party).toEqual([2, 6]);
    expect(flightOf(kind("swallows"), formation("V")).party).toEqual([5, 9]);
    expect(flightOf(kind("buzzard"), formation("V")).party).toEqual([5, 9]);
  });

  test("circles with its own flock: one buzzard, a wheeling flock of pigeons", () => {
    expect(flightOf(kind("buzzard"), formation("circling")).party).toEqual([1, 1]);
    expect(flightOf(kind("pigeons"), formation("circling")).party).toEqual([5, 9]);
    expect(flightOf(kind("swifts"), formation("circling")).party).toEqual([3, 7]);
  });
});

describe("a mixed sky", () => {
  test("leaves the usual formation and party to each flight's species", () => {
    expect(flightOf(-1, formation("usual"))).toEqual({ formation: undefined, party: undefined });
  });

  test("flies a chosen formation, its party known only for one alone", () => {
    expect(flightOf(-1, formation("V"))).toEqual({ formation: "V", party: undefined });
    expect(flightOf(-1, formation("circling"))).toEqual({
      formation: "circling",
      party: undefined,
    });
    expect(flightOf(-1, formation("solo"))).toEqual({ formation: "solo", party: [1, 1] });
  });
});

test("knob values read as the GLSL reads them, past the options' ends included", () => {
  expect(speciesOf(-1)).toBeUndefined();
  expect(speciesOf(-0.2)).toBeUndefined();
  expect(speciesOf(0)).toBe("rooks");
  expect(speciesOf(0.5)).toBe("swallows");
  expect(speciesOf(9)).toBe("swifts");
  expect(formationOf(0)).toBeUndefined();
  expect(formationOf(-3)).toBeUndefined();
  expect(formationOf(1)).toBe("solo");
  expect(formationOf(4)).toBe("circling");
  expect(formationOf(9)).toBe("circling");
});

describe("the sky strip", () => {
  test("has no birds aloft while off, whatever the amount", () => {
    expect(aloft(false, 0)).toBe(0);
    expect(aloft(false, 1)).toBe(0);
  });

  test("shows one bird at the least amount and every bird at the most", () => {
    expect(aloft(true, 0)).toBe(1);
    expect(aloft(true, 1)).toBe(STRIP_BIRDS.length);
  });

  test("puts more birds aloft the more often flights pass", () => {
    let last = 0;
    for (let step = 0; step <= 20; step++) {
      const count = aloft(true, step / 20);
      expect(count).toBeGreaterThanOrEqual(last);
      last = count;
    }
    expect(aloft(true, 0.5)).toBeGreaterThan(aloft(true, 0.1));
  });
});

describe("arrow keys along a row of tiles", () => {
  test("step to the neighbours and wrap round at either end", () => {
    expect(tileStep("ArrowRight", 2, 5)).toBe(3);
    expect(tileStep("ArrowDown", 2, 5)).toBe(3);
    expect(tileStep("ArrowLeft", 2, 5)).toBe(1);
    expect(tileStep("ArrowUp", 2, 5)).toBe(1);
    expect(tileStep("ArrowRight", 4, 5)).toBe(0);
    expect(tileStep("ArrowLeft", 0, 5)).toBe(4);
  });

  test("Home and End go to the ends; with none chosen the arrows start at an end", () => {
    expect(tileStep("Home", 3, 5)).toBe(0);
    expect(tileStep("End", 1, 5)).toBe(4);
    expect(tileStep("ArrowRight", -1, 5)).toBe(0);
    expect(tileStep("ArrowLeft", -1, 5)).toBe(4);
  });

  test("leave other keys and empty rows alone", () => {
    expect(tileStep("Enter", 1, 5)).toBeUndefined();
    expect(tileStep("ArrowRight", 0, 0)).toBeUndefined();
  });
});
