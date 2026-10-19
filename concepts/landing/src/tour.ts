// A scene tour: the lab plays chosen scenes one after another, each for its own dwell, through
// their passages (a cut with transitions off, at motion 0 or under reduced motion). It is a session
// tool beside the setup in the URL, never part of it:
//
//   tour=physarum-60.petri.delta   the scenes in order, each at most once; "-<seconds>" gives one
//                                  its own dwell
//   dwell=40                       seconds for the others (omitted at TOUR_DWELL.fallback)
//
// A step's dwell runs from the switch to it (its predecessor's exit included) to the next switch,
// on the scene clock's pace: each frame counts its real duration capped as the renderer caps its
// clock, and nothing while the clock is paused or the tab hidden. A slow machine therefore grows
// each scene as far as a fast one before moving on.
//
//   const player = new TourPlayer(readTour(query) ?? tour, true);
//   const next = player.tick(frameSeconds, renderer.paused); // a scene to switch to, or undefined
//   player.follow(state.scene);                              // after every page change
import { sceneCycle } from "./lab/families.ts";
import type { SceneId } from "./scenes/index.ts";
import { sessionKeys } from "./state.ts";

/** Seconds per step. The floor leaves a moment at rest after the longest exit and the longest
 *  entrance in the catalogue (harmonograph's 2.4 s and 5 s). */
export const TOUR_DWELL = { min: 10, max: 600, fallback: 30 } as const;
/** The renderer's per-frame cap on its scene clock (and simulation catch-up), in seconds. */
export const TOUR_FRAME_CAP = 0.1;
/** Sums of frame steps fall a hair short of whole seconds (120 × 0.1 < 12): a step ends this close. */
const DWELL_SLACK = 1e-6;

export interface TourStep {
  scene: SceneId;
  /** Seconds on this scene; undefined: the tour's own dwell. */
  dwell?: number;
}

export interface Tour {
  steps: readonly TourStep[];
  /** Seconds on each step without a dwell of its own. */
  dwell: number;
}

/** A dwell in whole seconds within TOUR_DWELL; NaN gives the fallback. */
export function clampDwell(seconds: number): number {
  if (!Number.isFinite(seconds)) return TOUR_DWELL.fallback;
  return Math.min(TOUR_DWELL.max, Math.max(TOUR_DWELL.min, Math.round(seconds)));
}

/**
 * The tour in a query, or undefined when it has none: unknown, lab-only (lab/families.ts) and
 * repeated scenes are dropped.
 */
export function readTour(query: URLSearchParams): Tour | undefined {
  const steps: TourStep[] = [];
  for (const part of (query.get(sessionKeys.tour) ?? "").split(".")) {
    const match = /^([a-z]+)(?:-(\d+))?$/.exec(part);
    const scene = sceneCycle.find((id) => id === match?.[1]);
    if (scene === undefined || steps.some((step) => step.scene === scene)) continue;
    const own = match?.[2];
    steps.push(own === undefined ? { scene } : { scene, dwell: clampDwell(Number(own)) });
  }
  if (steps.length === 0) return undefined;
  const dwell = query.get(sessionKeys.dwell);
  return {
    steps,
    dwell: dwell === null || dwell === "" ? TOUR_DWELL.fallback : clampDwell(Number(dwell)),
  };
}

/** Add the tour's keys to a query (the inverse of readTour). */
export function writeTour(tour: Tour, query: URLSearchParams): void {
  if (tour.steps.length === 0) return;
  query.set(
    sessionKeys.tour,
    tour.steps
      .map((step) => (step.dwell === undefined ? step.scene : `${step.scene}-${step.dwell}`))
      .join("."),
  );
  if (tour.dwell !== TOUR_DWELL.fallback) query.set(sessionKeys.dwell, String(tour.dwell));
}

/** Where a tour stands and when it moves on; the lab switches to the scenes it names. */
export class TourPlayer {
  #tour: Tour;
  #index = 0;
  /** Seconds the current step has run. */
  #elapsed = 0;
  playing: boolean;

  constructor(tour: Tour, playing: boolean) {
    if (tour.steps.length === 0) throw new RangeError("landing: a tour needs at least one scene");
    this.#tour = tour;
    this.playing = playing;
  }

  get tour(): Tour {
    return this.#tour;
  }

  get index(): number {
    return this.#index;
  }

  get step(): TourStep {
    const step = this.#tour.steps[this.#index];
    if (step === undefined) throw new RangeError("landing: tour index out of range");
    return step;
  }

  /** Seconds the current step lasts. */
  get dwell(): number {
    return this.step.dwell ?? this.#tour.dwell;
  }

  /** The scene the tour moves on to from this step (its own, when it is the only step). */
  get upcoming(): SceneId {
    const steps = this.#tour.steps;
    return steps[(this.#index + 1) % steps.length]?.scene ?? this.step.scene;
  }

  get elapsed(): number {
    return this.#elapsed;
  }

  /**
   * One frame of `seconds` real time. Returns the next step's scene when the current step's dwell
   * is up, and undefined otherwise; a lone step never moves on.
   */
  tick(seconds: number, paused: boolean): SceneId | undefined {
    if (!this.playing || paused) return undefined;
    this.#elapsed = Math.min(
      this.dwell,
      this.#elapsed + Math.min(TOUR_FRAME_CAP, Math.max(0, seconds)),
    );
    if (this.#elapsed < this.dwell - DWELL_SLACK || this.#tour.steps.length < 2) return undefined;
    return this.skip(1);
  }

  /** Move `by` steps, wrapping round, and start that step afresh; returns its scene. */
  skip(by: number): SceneId {
    const count = this.#tour.steps.length;
    this.#index = (((this.#index + by) % count) + count) % count;
    this.#elapsed = 0;
    return this.step.scene;
  }

  /**
   * The page now shows `scene`. A scene on the tour becomes the current step (started afresh when
   * it is another step); any other scene holds the tour where it is, paused. Returns whether the
   * scene is on the tour.
   */
  follow(scene: SceneId): boolean {
    if (this.step.scene === scene) return true;
    const at = this.#tour.steps.findIndex((step) => step.scene === scene);
    if (at < 0) {
      this.playing = false;
      return false;
    }
    this.#index = at;
    this.#elapsed = 0;
    return true;
  }

  /** Take an edited tour, staying on the current scene while it is still a step. */
  edit(tour: Tour): void {
    if (tour.steps.length === 0) throw new RangeError("landing: a tour needs at least one scene");
    const at = tour.steps.findIndex((step) => step.scene === this.step.scene);
    if (at < 0) this.#elapsed = 0;
    this.#index = at >= 0 ? at : Math.min(this.#index, tour.steps.length - 1);
    this.#tour = tour;
    this.#elapsed = Math.min(this.#elapsed, this.dwell);
  }
}
