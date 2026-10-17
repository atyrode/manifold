// A sand table under a low lamp, seen from straight above. Two machines draw in it (sim.ts): a
// steel ball pulled by a hidden magnet along slow theta–rho tracks, ploughing grooves and erasing
// the last drawing as it crosses it; or a swinging funnel trickling rosettes of sand onto dark
// slate, wiped clean and swung again once the swing has died away. The shader (shader.ts) lights
// the sand's relief with the raking lamp, every groove a bright side and a shadowed one.
import { choice, counts, feature, range, seed, type ParamDef } from "../../params.ts";
import type { SceneDef } from "../types.ts";
import {
  SANDTABLE_PASSAGE,
  sandtableFigures,
  sandtableMachines,
  sandtablePatterns,
} from "./constants.ts";

const params: readonly ParamDef[] = [
  choice(
    "table",
    "machine",
    "machine",
    sandtableMachines.map((label, value) => ({ label, value })),
    0,
    "Ball: a steel ball, pulled by a magnet hidden under the table (after Bruce Shapiro's Sisyphus tables), ploughs slow drawings through fine sand, erasing the last one wherever it crosses it. Pendulum: a funnel swinging on a string trickles sand onto dark slate, drawing a rosette as the swing dies away; then a straight edge wipes the slate and it swings again.",
  ),
  choice(
    "table",
    "pattern",
    "ball draws",
    sandtablePatterns.map((label, value) => ({ label, value })),
    0,
    "What the ball draws, with an erase spiral after each drawing to groom the table for the next. Cycle: each in turn. Spiral: nothing but erase spirals, wound in and out a ball's width apart. Clover: lobes swept round and round, slipping a little each turn. Rose: a rose curve's overlapping petals. Star: star polygons nested into a turning vortex. Waves: a wide spiral rippled into twisting waves. Loops: a spirograph's curls.",
  ),
  choice(
    "table",
    "figure",
    "pendulum swings",
    sandtableFigures.map((label, value) => ({ label, value })),
    0,
    "How the pendulum's two swings beat against each other: 1:1 draws turning ellipses, 1:2 figure-eights, 2:3 and 3:4 knotted rosettes, each detuned a hair so the figure slowly turns. Cycle: a different one each time.",
  ),
  range(
    "table",
    "speed",
    "drawing speed",
    1,
    "How fast the ball travels, or the pendulum swings. At 1 a drawing takes a few minutes.",
    { min: 0.25, max: 4, step: 0.05 },
  ),
  feature(
    "table",
    "renew",
    "next drawing",
    true,
    "pause",
    0.25,
    "When a drawing is done, rest a while (up to a minute), then start the next. Off: the finished drawing stays. Now: start the next one at once.",
    { trigger: 0 },
  ),
  seed(
    "table",
    "drawings",
    "drawings",
    "The run of drawings: their proportions, turns and directions. Re-seed for another run.",
  ),
  feature(
    "table",
    "rake",
    "rake",
    true,
    "tines",
    5,
    "The agents' chore on the ball's table, while the lab has agents in the scene: they comb the sand with a rake, taking it up at one side of the table and combing across to the other, band after band of parallel lines, while the ball's drawings and erase spirals slowly plough them away. While it is on, a drag on the sand rakes it too (press on the ball to lead the ball). Tines: how many lines a stroke combs.",
    { options: counts(3, 5, 7) },
  ),
  choice(
    "look",
    "sand",
    "sand",
    [
      { label: "white", value: 0 },
      { label: "black", value: 1 },
      { label: "ochre", value: 2 },
    ],
    0,
    "Pale silica sand, glittering black basalt, or warm ochre.",
  ),
  range(
    "look",
    "depth",
    "groove depth",
    0.5,
    "How deep the ball ploughs, so how bold its lines; for the pendulum, how heavy its stream of sand. Deep grooves slump at their edges, as dry sand does.",
  ),
  range(
    "look",
    "sparkle",
    "sparkle",
    0.5,
    "Grains glinting where a facet catches the lamp. They hold still while the sand does, and wake along every fresh groove.",
  ),
  range(
    "look",
    "light",
    "light angle",
    0.38,
    "Where the lamp stands round the table. Every groove has a lit side facing it and a shadowed side away.",
    { step: 0.01 },
  ),
  range(
    "look",
    "height",
    "lamp height",
    0.45,
    "Low: a raking light, long shadows, every line in sharp relief. High: soft and even.",
  ),
  choice(
    "look",
    "rim",
    "rim",
    [
      { label: "walnut", value: 0 },
      { label: "brass", value: 1 },
      { label: "none", value: 2 },
    ],
    0,
    "A dark walnut rim on a dark floor, a polished brass one, or none: the sand runs on off the page.",
  ),
  feature(
    "manifold",
    "mark",
    "M track",
    false,
    "size",
    0.5,
    "Switch on, or press now, and the ball heads straight for the Manifold M and draws it as one continuous stroke, foot to foot, the groove glowing warm as it goes, then rests to show it. While on, it comes round again every few drawings on a freshly groomed table (ball).",
    { trigger: 1 },
  ),
];

export const sandtableScene: SceneDef = {
  id: "sandtable",
  title: "Sand table",
  blurb:
    "A steel ball ploughing slow patterns through sand under a low lamp; or a pendulum pouring rosettes onto slate.",
  accent: "#d9a441",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    table: {
      title: "Sand table",
      blurb:
        "What draws in the sand, and how fast, and the agents' rake. Drag on the sand to rake it or on the ball to lead it; on the slate, drag to push the pendulum.",
    },
    look: {
      title: "Sand and lamp",
      blurb: "The sand, the depth of its lines, the lamp that rakes across them, and the rim.",
    },
    manifold: {
      title: "Manifold M",
      blurb: "A landmark of its own: the M drawn into the sand by the ball.",
    },
  },
  code: () => import("./code.ts"),
  passage: SANDTABLE_PASSAGE,
};
