import { expect, test } from "bun:test";
import { effective } from "../../params.ts";
import { BIRD_FORMATIONS, BIRD_KIND, BIRD_KINDS, birdKnobs, birdsGlsl } from "./birds.ts";

/** The GLSL constants `const float BIRD_<NAME> = <value>;` in birdsGlsl. */
const constants = new Map(
  [...birdsGlsl.matchAll(/^const float BIRD_(\w+) = (-?[\d.]+);/gm)].map((m) => [
    m[1] ?? "",
    Number(m[2]),
  ]),
);

test("the which-birds choice is valued as the GLSL species, one table entry per species", () => {
  const glslName = {
    rooks: "CROW",
    swallows: "SWALLOW",
    gulls: "GULL",
    geese: "GOOSE",
    buzzard: "RAPTOR",
    pigeons: "PIGEON",
    swifts: "SWIFT",
  } as const;
  for (const [label, value] of Object.entries(BIRD_KIND))
    expect(constants.get(glslName[label as keyof typeof glslName])).toBe(value);
  expect(BIRD_KINDS.map((option) => option.value)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  // birdSpecies' table holds one row per kind, in kind order.
  expect(birdsGlsl.match(/^\s*BirdSpecies\(/gm)?.length).toBe(BIRD_KINDS.length);
});

test("the formation choice is the GLSL formation plus one, 0 the species' own", () => {
  const glslName = { solo: "SOLO", party: "LOOSE", V: "SKEIN", circling: "CIRCLING" } as const;
  expect(BIRD_FORMATIONS[0]).toEqual({ label: "usual", value: 0 });
  for (const { label, value } of BIRD_FORMATIONS.slice(1))
    expect(constants.get(glslName[label as keyof typeof glslName])).toBe(value - 1);
});

test("birdKnobs: off by default, the scene's species first chosen, the choices shown only while on", () => {
  const knobs = birdKnobs({ kind: "gulls", help: "Gulls." });
  expect(knobs.map((knob) => knob.key)).toEqual(["birds", "birdKind", "birdFormation"]);
  const [birds, kind, formation] = knobs;
  if (birds?.kind !== "feature" || kind?.kind !== "choice" || formation?.kind !== "choice")
    throw new Error("unexpected knob kinds");
  expect(effective(birds, {})).toBe(0);
  expect(effective(birds, { birds: 1 })).toBe(0.5);
  expect(kind.value).toBe(BIRD_KIND.gulls);
  expect(kind.options.some((option) => option.value < 0)).toBe(false);
  expect(formation.value).toBe(0);
  expect([kind.when, formation.when]).toEqual(["birds", "birds"]);
  expect(knobs.every((knob) => knob.group === "birds")).toBe(true);
});

test("birdKnobs: a scene's own mix is offered as -1, and starts chosen when asked", () => {
  const [switched, kind] = birdKnobs({
    kind: "rooks",
    mixed: "by season.",
    help: "Birds.",
    group: "wildlife",
    on: true,
    often: 0.3,
  });
  if (switched?.kind !== "feature" || kind?.kind !== "choice")
    throw new Error("unexpected knob kinds");
  expect(kind.options[0]).toEqual({ label: "mixed", value: -1 });
  expect(kind.value).toBe(BIRD_KIND.rooks);
  expect(effective(switched, {})).toBe(0.3);
  const mixed = birdKnobs({ kind: "mixed", mixed: "by season.", help: "Birds." })[1];
  expect(mixed?.kind === "choice" && mixed.value).toBe(-1);
});
