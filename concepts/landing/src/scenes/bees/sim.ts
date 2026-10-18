// The insects layer's sim (ADR 0062; the composer's LayerSim, src/composer/types.ts): the hillside's
// living specks, up to two hundred bees working the apiary's three hives, now and then a swarm, a
// handful of butterflies, bumblebees, hoverflies and dragonflies, and glow-worms in the grass after
// dusk (fireflies too, where asked for), flying in the garden's own three-dimensional space and
// drawn at the size and place that space projects to. This is the orchestrator: it reads the knobs
// and the world's clock into the garden, steps every kind on one fixed step and paints them into the
// composer's shared speck map (LayerFrame.specks, its codes BEES_CODE).
//
// The world (garden.ts). The garden is a ground plane seen through CAMERA (a LevelCamera,
// sims/camera.ts): the eye BEES_CAM metres above it, its horizon at uv height BEES_YH and a focal
// length of one screen height. A world point (X, Z, H) (metres: right, away from the viewer, above
// the ground) therefore lies at screen (x, y) = (X / Z, BEES_YH - (BEES_CAM - H) / Z) in screen
// heights from the middle of the view: the ground at depth Z is at BEES_YH - BEES_CAM / Z, and a metre
// there is 1 / Z screen heights, the shader's own ground mapping (beesS). Hives, flower drifts,
// foxgloves, near blooms, the orchard's trees and the blossom in their crowns are laid out on screen
// as fractions of the stage half width (layout.ts, which shader.ts paints from too) and converted to
// world targets through CAMERA, so a bee lands exactly on the landing board it is drawn next to, a
// bumblebee on the foxglove bell the shader sways in the wind, and a swarm hangs from the limb of the
// tree the shader draws; a perch stands a little in front of what it rests on, along its view ray, so
// it is drawn on it and never hidden by it.
//
// Size. A worker is BEE_LENGTH long, a butterfly, a bumblebee, a hoverfly and a dragonfly their own
// sizes, so at the hives' distance a bee is about one dither cell, and fewer the farther off: far
// traffic is one cell of a fainter dark, a bee within a few metres of the lens two or three with a
// glint of wing. There is no other scale. The map (SpeckMap, sims/specks.ts) carries, with each cell's
// code, the depth of what it draws (BEES_DEPTH_STEP bytes per metre) so the shader can hide an insect
// behind the wall, a tree or a hive, and fog it at its own depth. Where two insects fall in one cell
// the nearer one is drawn, whichever was plotted first: the shader sees one depth per cell, so a
// farther insect hidden behind a hive must not take the cell of a nearer one flying in front of it.
//
// The kinds, each in its own module stepped at a fixed 1/60 s:
//   colony.ts       bees, a small state machine each:
//                     inside   in the hive, waiting its turn;
//                     mill     at the entrance: walking on the landing board or hovering before the
//                              slot, a small crowd;
//                     orient   a young bee's orientation flight: slow loops in front of its hive;
//                     out      a forager's nearly straight, slightly wobbly beeline to a flower patch
//                              (a drift, or a bed in flower the gardening chore's agents grew, which
//                              the apiary lends: LayerFrame.host; now and then via a pass close to
//                              the lens);
//                     forage   hopping zig-zag from flower to flower in the patch, resting a moment on
//                              each, loading up with pollen;
//                     home     the beeline back to the landing board;
//                     land     alighting on the board for a moment, then in or among the crowd;
//                   and, pollen-drunk (the `silly` knob: a few heavily loaded foragers by default,
//                   every bee at 1), big curvy wobbly loops home, bumping off flowers, the hives'
//                   fronts and each other before landing.
//   swarm.ts        the swarm (BEES_SWARM_TRIGGER, or now and then by itself while the `swarm` knob
//                   is on, on a dry day): out of a hive, a ball over the garden, a cluster on an
//                   apple tree's limb, away.
//   butterflies.ts  an erratic, lazy flutter above the flowers, now and then settling on one.
//   bumblebees.ts   big, slow and low: up a foxglove's bells from the bottom, the near blooms, the
//                   lavender, a poppy or the cosmos, whatever the `flowers` knob leaves standing.
//   hoverflies.ts   dead still in the air, a dart, still again.
//   dragonflies.ts  fast straight runs, a hover or a rest on a foxglove's tip.
//   glowworms.ts    steady green lights low in the grass after dusk.
//   fireflies.ts    (off by default) rising from the grass after dusk, blinking.
//
// The world's hours and weather. The sim reads the world clock (world-clock.ts: timeOfDay and skyState
// from the `time` and `cycle` knobs, at each step's moment) and the `rain` and `snow` knobs where the
// scene has them. The hives close at dusk and in rain or snow: foragers come home, the crowd at the
// entrances files in and nobody comes out until it is light and dry again. Butterflies settle on a
// flower with their wings shut from the golden hour on and in the wet, and the other day fliers leave
// the frame. The glow-worms light up in the grass once the sky is dark, each at its own darkness, and
// go out as the night lifts; they and the fireflies go dark in rain or snow too. A pressed swarm plays
// whatever the hour and the weather, lit as the garden is. In a dry afternoon none of it applies.
//
// A thing is drawn in the cell its projection falls in, and only changes cell once it has clearly left
// it (hysteresis, followCell), so a hovering bee never flickers between two. It is drawn between its
// last two steps by the clock's alpha, so the traffic moves as smoothly at 144 Hz as at 60 (paint.ts).
//
// Randomness. The colony and the butterflies share one stream (Garden.random), as they always have;
// every other kind, the pollen-drunk bees and the swarm draw from streams of their own, so what else
// is about never moves a bee.
//
// Warm-up. The page opens on a garden at work: WARM_STEPS steps are run before anything is drawn, a
// count of steps spread over the first frames (at least WARM_MS of each, more as the frame's budget
// allows), so a slow machine takes more frames, never another picture; the map is empty until then.
//
// Passage (BEES_PASSAGE). An entrance skips the pre-run: the colony starts asleep and nearly every bee
// comes out of its hive within the first two seconds and flies at once for its flowers (a little hurried,
// easing to the usual pace), while the butterflies fly in over the edges of the screen. An exit sends the
// foragers home at speed (sober), files the crowd at the entrances in, keeps everyone inside and has the
// butterflies and the other insects bolt for the nearest edge. At rest none of it applies and the random
// draws are unchanged.
//
// Specks: the shared speck map (LayerFrame.specks), one texel per dither cell, each code a BEES_CODE
// value and its depth in SPECK_DEPTH_STEP-ths of a metre (BEES_DEPTH_STEP, the same quarter metre).
// The map is cleared every frame, so every insect is painted every frame once the warm-up is done.
import type { LayerFrame, LayerSim } from "../../composer/types.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { FixedStep, runBudgeted } from "../../sims/clock.ts";
import { clamp, smoothstep } from "../../sims/math.ts";
import { GardenBeds } from "./beds.ts";
import { BEES_MAX_BUMBLEBEES, Bumblebees } from "./bumblebees.ts";
import { BEES_MAX_BUTTERFLIES, Butterflies } from "./butterflies.ts";
import { BEES_MAX_BEES, Colony } from "./colony.ts";
import { BEES_MAX_DRAGONFLIES, Dragonflies } from "./dragonflies.ts";
import { BEES_MAX_FIREFLIES, Fireflies } from "./fireflies.ts";
import {
  type Flier,
  Garden,
  HIVES_OPEN,
  HIVES_SHUT,
  ROOST_FROM,
  ROOST_UNTIL,
  STEP,
} from "./garden.ts";
import { BEES_MAX_GLOWWORMS, Glowworms } from "./glowworms.ts";
import { BEES_MAX_HOVERFLIES, Hoverflies } from "./hoverflies.ts";
import { beesStage } from "./layout.ts";
import { Painter } from "./paint.ts";
import { Swarm } from "./swarm.ts";

/** The codes of the speck map this sim writes. */
export { BEES_CODE } from "./layout.ts";

const MAX_STEPS = 6;
/** Steps pre-run so the page opens with the colony at work (30 s), at least WARM_MS of a frame on them, WARM_CHUNK between two looks at the clock. */
const WARM_STEPS = 30 * 60;
const WARM_MS = 24;
const WARM_CHUNK = 60;

type WeatherKnob = "rain" | "snow" | "wind";
const WEATHER_KNOBS: readonly WeatherKnob[] = ["rain", "snow", "wind"];
type BeesKnob =
  | "bees"
  | "silly"
  | "butterflies"
  | "swarm"
  | "bumblebees"
  | "hoverflies"
  | "dragonflies"
  | "glowworms"
  | "fireflies"
  | "flowers"
  | "time"
  | "cycle"
  | WeatherKnob;

class InsectsSim implements LayerSim {
  readonly #knobs: KnobReader<BeesKnob>;
  /** The weather knobs the scene has (the rest read 0). */
  readonly #weather: readonly WeatherKnob[];
  readonly #swarmSlot: number;
  readonly #clock = new FixedStep(STEP, MAX_STEPS);
  #painter: Painter | undefined;
  readonly #garden = new Garden();
  readonly #colony = new Colony(this.#garden);
  readonly #butterflies = new Butterflies(this.#garden);
  readonly #bumblebees = new Bumblebees(this.#garden);
  readonly #hoverflies = new Hoverflies(this.#garden);
  readonly #dragonflies = new Dragonflies(this.#garden);
  readonly #fireflies = new Fireflies(this.#garden);
  readonly #glowworms = new Glowworms(this.#garden);
  readonly #swarm = new Swarm(this.#garden);
  /** Every flier the map draws, to place afresh after a resize. */
  readonly #fliers: readonly (readonly Flier[])[] = [
    this.#colony.bees,
    this.#butterflies.list,
    this.#bumblebees.list,
    this.#hoverflies.list,
    this.#dragonflies.list,
    this.#fireflies.list,
    this.#glowworms.list,
    this.#swarm.bees,
  ];
  readonly #warmStep = (): void => this.#step(STEP, false);
  /** Steps of the pre-run taken (WARM_STEPS once it has landed, or at once for an entrance). */
  #warmed = 0;
  /** The opening frame has been taken: the world read as the page opens, every kind seeded. */
  #seeded = false;
  #born = false;
  /** The frame's size in cells the fliers were placed for. */
  #width = 0;
  #height = 0;

  constructor(params: readonly ParamDef[]) {
    this.#weather = WEATHER_KNOBS.filter((key) => params.some((def) => def.key === key));
    this.#knobs = new KnobReader<BeesKnob>("insects", params, [
      "bees",
      "silly",
      "butterflies",
      "swarm",
      "bumblebees",
      "hoverflies",
      "dragonflies",
      "glowworms",
      "fireflies",
      "flowers",
      "time",
      "cycle",
      ...this.#weather,
    ]);
    this.#swarmSlot = this.#knobs.trigger("swarm");
  }

  frame(frame: LayerFrame): void {
    const knobs = this.#knobs;
    const garden = this.#garden;
    const count = (key: BeesKnob, most: number): number =>
      clamp(Math.round(knobs.value(frame, key)), 0, most);
    this.#colony.count = count("bees", BEES_MAX_BEES);
    this.#colony.silly = clamp(knobs.value(frame, "silly"), 0, 1);
    this.#butterflies.count = count("butterflies", BEES_MAX_BUTTERFLIES);
    this.#bumblebees.count = count("bumblebees", BEES_MAX_BUMBLEBEES);
    this.#hoverflies.count = count("hoverflies", BEES_MAX_HOVERFLIES);
    this.#dragonflies.count = count("dragonflies", BEES_MAX_DRAGONFLIES);
    this.#glowworms.count = count("glowworms", BEES_MAX_GLOWWORMS);
    this.#fireflies.count = count("fireflies", BEES_MAX_FIREFLIES);
    this.#swarm.on = knobs.value(frame, "swarm") > 0.5;
    garden.time = knobs.value(frame, "time");
    garden.cycle = knobs.value(frame, "cycle");
    garden.days = frame.phases?.["cycle"] ?? 0;
    garden.wet = Math.max(this.#weatherKnob(frame, "rain"), this.#weatherKnob(frame, "snow"));
    garden.wind = this.#weatherKnob(frame, "wind");
    garden.setFlowers(Math.max(0, knobs.value(frame, "flowers")));
    const beds = frame.host("apiary");
    garden.beds = beds instanceof GardenBeds ? beds : undefined;
    const width = Math.max(1, Math.round(frame.width));
    const height = Math.max(1, Math.round(frame.height));
    if (width !== this.#width || height !== this.#height) {
      this.#width = width;
      this.#height = height;
      for (const list of this.#fliers)
        for (const thing of list) {
          thing.cx = Number.NaN;
          thing.cy = Number.NaN;
        }
    }
    garden.aspect = frame.aspect > 0 ? frame.aspect : width / height;
    this.#setStage(beesStage(garden.aspect));
    this.#passage(frame);
    const opening = !this.#seeded;
    if (opening) {
      // The world as the page opens: the hives shut and the butterflies roosting from the start.
      garden.tm = frame.motionTime;
      garden.skyAt(0);
      garden.open = garden.wet <= 0 && garden.day >= 0.5 * (HIVES_SHUT + HIVES_OPEN);
      garden.roost = garden.wet > 0 || garden.day < 0.5 * (ROOST_FROM + ROOST_UNTIL);
    }
    this.#wake();
    if (opening) {
      this.#seeded = true;
      // An entrance skips the pre-run: the colony is to be seen coming out of its hives.
      if (garden.arriving) this.#warmed = WARM_STEPS;
      garden.arriving = false;
    }
    const advance = Math.max(0, frame.dt) * Math.max(0, frame.motion);
    // A "now": the swarm starts at the first step at least half a step past the press's moment on the
    // motion clock (the frame's start where the frame carries no stamps, as a press just before it would
    // have stamped). Never a step taken before the press was seen, and never a step that lands on the
    // stamp itself, which float rounding may count on either side of it at another frame rate.
    if (frame.fired[this.#swarmSlot] === true)
      this.#swarm.press(frame.motionTriggers?.[this.#swarmSlot] ?? frame.motionTime - advance);
    if (this.#warmed < WARM_STEPS) {
      this.#warmed = runBudgeted(
        this.#warmStep,
        Math.max(WARM_MS, frame.budget),
        WARM_STEPS,
        this.#warmed,
        WARM_CHUNK,
      );
      // Nothing drawn until the garden is at work.
      if (this.#warmed < WARM_STEPS) return;
    }
    const steps = this.#clock.advance(advance);
    for (let i = 0; i < steps; i++) {
      garden.tm = frame.motionTime - this.#clock.lag(i);
      garden.skyAt(this.#clock.lag(i));
      this.#step(STEP, true);
    }
    // Drawn between the last two steps, every frame: the composer clears the map before each.
    const painter = (this.#painter ??= new Painter(frame.specks));
    painter.specks = frame.specks;
    this.#paint(painter, this.#clock.alpha);
  }

  dispose(): void {}

  #weatherKnob(frame: LayerFrame, key: WeatherKnob): number {
    return this.#weather.includes(key) ? this.#knobs.value(frame, key) : 0;
  }

  /** A new stage width (the frame's aspect changed): the layout widens, so every X (which scales with it) follows. */
  #setStage(stage: number): void {
    const garden = this.#garden;
    if (Math.abs(stage - garden.stage) < 1e-5) return;
    const ratio = stage / garden.stage;
    garden.stage = stage;
    this.#colony.restage(ratio);
    this.#butterflies.restage(ratio);
    this.#bumblebees.restage(ratio);
    this.#hoverflies.restage(ratio);
    this.#dragonflies.restage(ratio);
    this.#fireflies.restage(ratio);
    this.#glowworms.restage(ratio);
    this.#swarm.restage(ratio);
  }

  /** Each kind as many as its knob asks for (and the day fliers only on a dry day): newcomers appear at the edge of the frame, the rest leave. */
  #wake(): void {
    // The page opens with them at work where they are; later ones come in from the edge.
    const first = this.#warmed < WARM_STEPS;
    this.#butterflies.wake();
    if (!this.#seeded) {
      // The very first frame: bees asleep inside at scattered times, butterflies in the air over the
      // flowers (or, for an entrance, the colony about to pour out).
      this.#colony.seed();
      if (this.#garden.arriving) this.#colony.pourOut();
      else this.#butterflies.scatter();
    }
    this.#bumblebees.wake(first);
    this.#hoverflies.wake(first);
    this.#dragonflies.wake(first);
    this.#fireflies.wake(first);
    this.#glowworms.wake(first);
  }

  /** Where the scene stands in its entrance and exit: how hurried the traffic is, and the moment the exit begins. */
  #passage(frame: LayerFrame): void {
    const garden = this.#garden;
    const enter = clamp(frame.passage.enter, 0, 1);
    const leave = clamp(frame.passage.exit, 0, 1);
    if (!this.#born) {
      this.#born = true;
      garden.arriving = enter < 1;
    }
    const leaving = leave > 0;
    const recall = leaving && !garden.leaving;
    garden.leaving = leaving;
    if (recall) {
      // The exit begins: foragers and young bees turn for their hive, the crowd at the entrances files
      // in, the butterflies bolt for the nearest edge.
      this.#colony.recall();
      this.#butterflies.recall();
    }
    garden.rush = 1;
    garden.flit = 1;
    if (leaving) {
      garden.rush = 1 + 5 * smoothstep(0, 0.2, leave);
      garden.flit = 1 + 6 * smoothstep(0, 0.25, leave);
    } else if (enter < 1) {
      // Quick at first, easing back to their ordinary pace over the last of the entrance.
      garden.rush = 1 + 1.5 * (1 - smoothstep(0.7, 1, enter));
      garden.flit = 1 + 2 * (1 - smoothstep(0.5, 1, enter));
    }
  }

  /** One step of everything; `live` for the steps the clock owes (not the pre-run), which the swarm takes. */
  #step(dt: number, live: boolean): void {
    this.#colony.step(dt);
    this.#butterflies.step(dt);
    this.#bumblebees.step(dt);
    this.#hoverflies.step(dt);
    this.#dragonflies.step(dt);
    this.#fireflies.step(dt);
    this.#glowworms.step(dt);
    if (live) this.#swarm.tend(dt);
  }

  /** Every insect into the speck map, `alpha` of the way from where it was a step ago to where it is. */
  #paint(p: Painter, alpha: number): void {
    this.#colony.paint(p, alpha);
    this.#butterflies.paint(p, alpha);
    this.#bumblebees.paint(p, alpha);
    this.#hoverflies.paint(p, alpha);
    this.#dragonflies.paint(p, alpha);
    this.#swarm.paint(p, alpha);
    this.#fireflies.paint(p, alpha);
    this.#glowworms.paint(p, alpha);
  }
}

/** The insects' sim, for a composition whose `params` carry the knobs BeesKnob names (rain, snow and wind where it has them). */
export function insectsSim(_gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  return new InsectsSim(params);
}
