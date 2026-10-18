// The Sand table preset's layers (ADR 0062 Phase 4, the overhead composer): their manifests, which
// load without their code (shader.ts, sim.ts). The table is drawn in field units (sim.ts SANDTABLE:
// the field square centred on the table, SANDTABLE.span view heights a field unit on a landscape
// frame), so every layer is drawn through its span alone (SANDTABLE_SPAN_METRES), dry: no water
// layer, and none of the pond's or the tide pool's, is offered here, nor these there.
//   sandBed    bed: the table, one height field with two finishes: fine sand the ball ploughs, or
//              dark slate the pendulum trickles sand onto (the pendulum's begin sets it); its rim
//              and the dark floor round it; the table's clock and run of drawings, which whatever
//              machine stands on it follows (its sim holds the sand and lends it to the machine)
//   tableLamp  dressing: the low lamp standing off beyond the table, where round it and how high;
//              without it the patch's light (the composer's sun) rakes the table from the lamp's
//              default height
//   ball       dressing, subject: the steel ball on its hidden magnet, its drawings, the M it draws
//              and the agents' rake on its table
//   pendulum   dressing, subject: the funnel on its string trickling rosettes onto the slate, and
//              the straight edge that wipes it
// The two machines share the bed's one height field, so they never stand on the table together
// (`excludes`): the one switched on lays its table once the other has swept its own away. Keys kept
// from the scene, every one but `machine`, which the two machines' switches replace; `sandBed` and
// `tableLamp` are new switches. The "now" slots: "next drawing" (the table's), the ball's M.
import type { CameraRange, LayerDef } from "../../composer/types.ts";
import { choice, counts, feature, range, seed, toggle } from "../../params.ts";
import { SANDTABLE, sandtableFigures, sandtablePatterns } from "./constants.ts";

/**
 * Metres a screen height spans over the table: its steel ball a one-inch ball (1.25 cm its radius,
 * SANDTABLE.ball field units), so a field unit is some 0.83 m and the frame, 1 / SANDTABLE.span
 * field units tall, 0.93 m; the sand some 0.78 m across inside its rim. Below the koi's metre.
 */
export const SANDTABLE_SPAN_METRES = 0.0125 / SANDTABLE.ball / SANDTABLE.span;

/** The table's own span, dry, and no other. */
const TABLE: CameraRange = { span: [SANDTABLE_SPAN_METRES, SANDTABLE_SPAN_METRES] };

/** Each layer's fields (sim.ts): the bed's heights, a machine's state. */
export const SAND_FIELDS = { heights: 0 } as const;
export const MACHINE_FIELDS = { state: 0 } as const;

export const sandBedLayer: LayerDef = {
  id: "sandBed",
  title: "Sand table",
  composers: ["overhead"],
  role: "bed",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: TABLE,
  switch: toggle(
    "layers",
    "sandBed",
    "sand table",
    false,
    "The table seen from straight above: fine sand in a rim on a dark floor, or under the pendulum dark slate with the sand it trickles; the pace and run of the drawings whatever draws on it.",
    { icon: "dunes" },
  ),
  params: [
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
    ),
    seed(
      "table",
      "drawings",
      "drawings",
      "The run of drawings: their proportions, turns and directions. Re-seed for another run.",
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
  ],
  triggers: ["renew"],
  groups: {
    table: {
      title: "Sand table",
      blurb:
        "How fast the drawings go, when the next one starts, and the run of them. Drag on the sand to rake it or on the ball to lead it; on the slate, drag to push the pendulum.",
    },
    look: {
      title: "Sand and rim",
      blurb: "The sand, the depth of its lines, how it glints, and the rim.",
    },
  },
  passes: { bed: "sandBedBed", grade: "sandBedGrade" },
  data: { fields: 1 },
};

export const tableLampLayer: LayerDef = {
  id: "tableLamp",
  title: "Lamp",
  composers: ["overhead"],
  role: "dressing",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: TABLE,
  switch: toggle(
    "layers",
    "tableLamp",
    "lamp",
    false,
    "One low lamp standing off beyond the table, raking across the sand: every groove a lit side and a shadowed one. Off: the patch's own light from the upper left, at the lamp's height.",
    { icon: "bulb" },
  ),
  params: [
    range(
      "lamp",
      "light",
      "light angle",
      0.38,
      "Where the lamp stands round the table. Every groove has a lit side facing it and a shadowed side away.",
      { step: 0.01 },
    ),
    range(
      "lamp",
      "height",
      "lamp height",
      0.45,
      "Low: a raking light, long shadows, every line in sharp relief. High: soft and even.",
    ),
  ],
  groups: {
    lamp: {
      title: "Lamp",
      blurb: "The lamp that rakes across the sand: where it stands, how high.",
    },
  },
  passes: { begin: "tableLampBegin" },
};

export const ballLayer: LayerDef = {
  id: "ball",
  title: "Steel ball",
  composers: ["overhead"],
  role: "dressing",
  subject: true,
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: TABLE,
  switch: toggle(
    "layers",
    "ball",
    "steel ball",
    false,
    "A steel ball, pulled by a magnet hidden under the table (after Bruce Shapiro's Sisyphus tables), ploughs slow drawings through fine sand, erasing the last one wherever it crosses it. Press on it to lead it.",
    { icon: "dot" },
  ),
  params: [
    choice(
      "ball",
      "pattern",
      "ball draws",
      sandtablePatterns.map((label, value) => ({ label, value })),
      0,
      "What the ball draws, with an erase spiral after each drawing to groom the table for the next. Cycle: each in turn. Spiral: nothing but erase spirals, wound in and out a ball's width apart. Clover: lobes swept round and round, slipping a little each turn. Rose: a rose curve's overlapping petals. Star: star polygons nested into a turning vortex. Waves: a wide spiral rippled into twisting waves. Loops: a spirograph's curls.",
    ),
    feature(
      "ball",
      "rake",
      "rake",
      true,
      "tines",
      5,
      "The agents' chore on the ball's table, while the lab has agents in the scene: they comb the sand with a rake, taking it up at one side of the table and combing across to the other, band after band of parallel lines, while the ball's drawings and erase spirals slowly plough them away. While it is on, a drag on the sand rakes it too (press on the ball to lead the ball). Tines: how many lines a stroke combs.",
      { options: counts(3, 5, 7) },
    ),
    feature(
      "manifold",
      "mark",
      "M track",
      false,
      "size",
      0.5,
      "Switch on, or press now, and the ball heads straight for the Manifold M and draws it as one continuous stroke, foot to foot, the groove glowing warm as it goes, then rests to show it. While on, it comes round again every few drawings on a freshly groomed table.",
    ),
  ],
  triggers: ["mark"],
  groups: {
    ball: {
      title: "Steel ball",
      blurb:
        "What the ball draws, and the agents' rake. Drag on the sand to rake it or on the ball to lead it.",
    },
    manifold: {
      title: "Manifold M",
      blurb: "A landmark of its own: the M drawn into the sand by the ball.",
    },
  },
  mark: "mark",
  excludes: [{ layer: "pendulum", why: "both work the table's one bed of sand" }],
  requires: ["sandBed"],
  passes: { begin: "ballBegin", floor: "ballFloor", stand: "ballStand" },
  data: { fields: 1 },
};

export const pendulumLayer: LayerDef = {
  id: "pendulum",
  title: "Pendulum",
  composers: ["overhead"],
  role: "dressing",
  subject: true,
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: TABLE,
  switch: toggle(
    "layers",
    "pendulum",
    "pendulum",
    false,
    "A funnel swinging on a string trickles sand onto dark slate, drawing a rosette as the swing dies away; then a straight edge wipes the slate and it swings again. Drag to push it.",
    { icon: "swirl" },
  ),
  params: [
    choice(
      "pendulum",
      "figure",
      "pendulum swings",
      sandtableFigures.map((label, value) => ({ label, value })),
      0,
      "How the pendulum's two swings beat against each other: 1:1 draws turning ellipses, 1:2 figure-eights, 2:3 and 3:4 knotted rosettes, each detuned a hair so the figure slowly turns. Cycle: a different one each time.",
    ),
  ],
  groups: {
    pendulum: {
      title: "Pendulum",
      blurb: "How its swings beat. On the slate, drag to push it.",
    },
  },
  excludes: [{ layer: "ball", why: "both work the table's one bed of sand" }],
  requires: ["sandBed"],
  passes: { begin: "pendulumBegin", stand: "pendulumStand" },
  data: { fields: 1 },
};
