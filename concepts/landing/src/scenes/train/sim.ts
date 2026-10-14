// The night train's journey, on the CPU: the odometer and the speed, the timetable of what passes
// the window (stations, level crossings, bridges, tunnels) and the cars on the road alongside.
//
// The shader draws the whole landscape as a function of the distance travelled, so that distance is
// integrated here: a shader alone cannot follow a speed that changes (the speed knob, slowing for a
// station or onto a bridge) without the view jumping. Events are committed once, as they come within
// sight ahead, by a Poisson process in distance whose rate follows the frequency knobs as they are
// now, so moving a knob never makes something appear or vanish in view. A "now" button sets one just
// ahead (after whatever is passing). The train slows through stations and over bridges (an old
// bridge's speed limit), and its acceleration is handed on for the curtain and the tea.
//
// uSim0, one row of rgba16f texels (half floats hold whole numbers exactly up to 2048, so positions
// travel as whole 256 m blocks and metres plus a fraction):
//   0       odometer: x whole blocks (mod 2048), y whole metres into the block, z the fraction of a
//           metre, w speed (m/s)
//   1       x acceleration along the track (m/s², eased), yzw spare
//   2..9    events, two texels each: (block, metre where it starts, length m, kind) and (seed 0..1,
//           metres before the start the train slows over, 0, 0); kind 0 is an empty slot
//   10, 11  cars on the road alongside: (metres ahead of the train, heading +1 / -1, 1 while there, 0)
import type { ParamDef } from "../../params.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

// ---- Shared with the shader ----

/** Event and car slots in the texture. */
export const TRAIN_EVENT_SLOTS = 4;
export const TRAIN_CAR_SLOTS = 2;
const TEXELS = 2 + 2 * TRAIN_EVENT_SLOTS + TRAIN_CAR_SLOTS;

/** Event kinds as the texture carries them. */
export const TRAIN_STATION = 1;
export const TRAIN_CROSSING = 2;
export const TRAIN_BRIDGE = 3;
export const TRAIN_TUNNEL = 4;

/** Metres in an odometer block; blocks before the odometer wraps (about 12 hours at 12 m/s). */
export const TRAIN_BLOCK = 256;
export const TRAIN_BLOCKS = 2048;

/** Speed (m/s) at speed 1: 108 km/h. The default 0.4 is a slow night train at 43 km/h. */
export const TRAIN_TOP_SPEED = 30;
/** The camera's focal length (screen heights per unit of x / z) and the road's centre line (m). */
export const TRAIN_FOCAL = 0.82;
export const TRAIN_ROAD_Z = 26.5;

/** Seconds the scene's entrance and exit take (SceneDef.passage; shader.ts reads the same): out of a tunnel, into a tunnel. */
export const TRAIN_PASSAGE = { enter: 2.8, exit: 1.5 } as const;

// ---- The timetable ----

type Kind = "station" | "crossing" | "bridge" | "tunnel";
type TrainKnob = "speed" | "stations" | "crossings" | "bridges" | "tunnels" | "cars" | "route";

interface KindSpec {
  readonly code: number;
  readonly knob: TrainKnob;
  /** "Now" slot. */
  readonly trigger: number;
  /** Events per km of track at frequency 1. */
  readonly perKm: number;
  /** Length (m) of the platform, bridge or tunnel: least and most. */
  readonly length: readonly [number, number];
  /** Track before and after it that belongs to it (slowing, cuttings, a road seen from afar), m. */
  readonly before: number;
  readonly after: number;
  /** How far ahead (m) a "now" one starts. */
  readonly lead: number;
  /** Share of the cruising speed the train passes it at. */
  readonly slow: number;
}

const KINDS: Readonly<Record<Kind, KindSpec>> = {
  station: { code: TRAIN_STATION, knob: "stations", trigger: 0, perKm: 0.8, length: [150, 200], before: 220, after: 150, lead: 100, slow: 0.35 },
  crossing: { code: TRAIN_CROSSING, knob: "crossings", trigger: 1, perKm: 1.2, length: [0, 0], before: 130, after: 70, lead: 85, slow: 1 },
  bridge: { code: TRAIN_BRIDGE, knob: "bridges", trigger: 2, perKm: 0.5, length: [70, 130], before: 130, after: 90, lead: 95, slow: 0.4 },
  tunnel: { code: TRAIN_TUNNEL, knob: "tunnels", trigger: 3, perKm: 0.5, length: [180, 420], before: 120, after: 120, lead: 115, slow: 1 },
};
const KIND_ORDER: readonly Kind[] = ["station", "crossing", "bridge", "tunnel"];

/** Events are committed this far ahead of the train (m): beyond anything the window shows. */
const HORIZON = 1000;
/** Clear track between one event's stretch and the next (m). */
const GAP = 90;
/** Events are handed to the shader while their stretch overlaps this window round the train (m). */
const SEEN_BEHIND = 700;
const SEEN_AHEAD = 1100;
/** The first station after loading starts this far ahead (m): most of a minute of open country first. */
const FIRST_STATION = 540;
/** Time constants (s): the speed following its target, the acceleration handed on. */
const SPEED_EASE = 2.2;
const ACCEL_EASE = 0.5;

/** The "now" slot for a car. */
const CAR_TRIGGER = 4;
/** Seconds between cars at the frequency knob's ends. */
const CAR_SPARSE = 90;
const CAR_BUSY = 12;
/** Metres past the edge of the view a car comes in from and leaves by. */
const CAR_MARGIN = 12;

export class TrainSimError extends Error {}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Mulberry32: a small seedable generator, so a route always runs the same timetable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface TrainEvent {
  kind: Kind;
  /** Odometer reading (whole metres) where the platform, road, bridge or tunnel begins. */
  start: number;
  length: number;
  /** Metres of track before the start the train has to slow over. */
  braking: number;
  /** 0..255, the shader's own dice for it. */
  seed: number;
}

interface Car {
  /** Metres ahead of the train (negative: behind). */
  rel: number;
  /** Its own speed along the line (m/s, negative: coming the other way). */
  speed: number;
  alive: boolean;
}

interface KnobSlot {
  index: number;
  fallback: number;
}

/** Reads the knobs the journey needs by key, through their position in the scene's `params`. */
class TrainKnobs {
  readonly #slots: Record<TrainKnob, KnobSlot>;

  constructor(params: readonly ParamDef[]) {
    const slot = (key: TrainKnob): KnobSlot => {
      const index = params.findIndex((def) => def.key === key);
      const def = params[index];
      if (def === undefined) throw new TrainSimError(`train: the scene has no '${key}' knob`);
      return { index, fallback: def.kind === "feature" && !def.on ? 0 : def.value };
    };
    this.#slots = {
      speed: slot("speed"),
      stations: slot("stations"),
      crossings: slot("crossings"),
      bridges: slot("bridges"),
      tunnels: slot("tunnels"),
      cars: slot("cars"),
      route: slot("route"),
    };
  }

  /** As the shader sees it: a feature reads its amount while on, 0 while off. */
  value(frame: SimFrame, key: TrainKnob): number {
    const slot = this.#slots[key];
    return frame.values[slot.index] ?? slot.fallback;
  }
}

class TrainJourney implements SceneSim {
  readonly #texture: DataTexture;
  readonly #data = new Float32Array(TEXELS * 4);
  readonly #knobs: TrainKnobs;
  readonly #events: TrainEvent[] = [];
  readonly #cars: Car[] = Array.from({ length: TRAIN_CAR_SLOTS }, () => ({ rel: 0, speed: 0, alive: false }));
  readonly #seen = new Array<number>(5).fill(-1e4);
  #primed = false;
  #route = Number.NaN;
  #random = mulberry32(1);

  /** Odometer (m, unwrapped), speed (m/s), eased acceleration (m/s²), the journey's own clock (s). */
  #s = 0;
  #v = 0;
  #accel = 0;
  #clock = 0;
  /** The commit point: track up to here has been considered for events. */
  #cursor = 0;
  /** What is left of the current exponential draw (events happen where the rate's integral uses it up). */
  #hazard = 1;
  #nextCar = Number.POSITIVE_INFINITY;
  #aspect = 16 / 9;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#knobs = new TrainKnobs(params);
    this.#texture = new DataTexture(gl, { width: TEXELS, height: 1, format: "rgba16f", filter: "nearest" });
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    if (frame.aspect > 0 && Number.isFinite(frame.aspect)) this.#aspect = frame.aspect;
    const route = Math.round(this.#knobs.value(frame, "route"));
    if (route !== this.#route) this.#depart(frame, route);
    this.#watchTriggers(frame);

    const advance = Math.max(0, frame.dt) * Math.max(0, frame.motion);
    if (advance > 0) {
      this.#clock += advance;
      const cruise = this.#cruise(frame);
      const before = this.#v;
      this.#v += (cruise * this.#slowing() - this.#v) * (1 - Math.exp(-advance / SPEED_EASE));
      this.#s += 0.5 * (before + this.#v) * advance;
      this.#accel += ((this.#v - before) / advance - this.#accel) * (1 - Math.exp(-advance / ACCEL_EASE));
      this.#schedule(frame);
      this.#driveCars(frame, advance);
    }
    this.#upload();
    return [this.#texture.texture];
  }

  dispose(): void {
    this.#texture.dispose();
  }

  #cruise(frame: SimFrame): number {
    return TRAIN_TOP_SPEED * clamp(this.#knobs.value(frame, "speed"), 0.05, 1);
  }

  /** A fresh journey for a route: a stretch of line of its own, the train already running. */
  #depart(frame: SimFrame, route: number): void {
    this.#route = route;
    this.#random = mulberry32(Math.imul(route + 1, 0x9e3779b1) ^ 0x7261696c);
    const random = this.#random;
    this.#s = 4000 + ((route * 7919) % 400) * 997 + Math.floor(random() * 200);
    this.#events.length = 0;
    this.#cursor = this.#s + HORIZON;
    this.#hazard = -Math.log(1 - random());
    this.#clock = 0;
    this.#accel = 0;
    // Open on the country with a first stop a minute ahead, so the journey's rhythm shows early.
    if (this.#knobs.value(frame, "stations") > 0) {
      const spec = KINDS.station;
      const start = Math.round(this.#s + FIRST_STATION);
      this.#events.push({ kind: "station", start, length: 170, braking: spec.before, seed: Math.floor(random() * 256) });
      this.#cursor = Math.max(this.#cursor, start + 170 + spec.after + GAP);
    }
    this.#v = this.#cruise(frame) * this.#slowing();
    for (const car of this.#cars) car.alive = false;
    const cars = this.#knobs.value(frame, "cars");
    this.#nextCar = cars > 0 ? this.#carInterval(cars) * 0.6 : Number.POSITIVE_INFINITY;
    // A car on the road alongside, a little slower than the train: it drifts back out of view.
    if (cars > 0) this.#launchCar(0.25 * this.#roadHalfWidth(), this.#v - 1.6);
  }

  /** A "now" button stamps its slot with the scene clock: any change since the last frame fires. */
  #watchTriggers(frame: SimFrame): void {
    for (let slot = 0; slot < this.#seen.length; slot++) {
      const stamp = frame.triggers[slot] ?? -1e4;
      if (this.#primed && stamp !== this.#seen[slot] && stamp > -1e3) {
        if (slot === CAR_TRIGGER) this.#launchCar(-(this.#roadHalfWidth() + CAR_MARGIN), this.#v + 2.4);
        else {
          const kind = KIND_ORDER.find((k) => KINDS[k].trigger === slot);
          if (kind !== undefined) this.#now(kind);
        }
      }
      this.#seen[slot] = stamp;
    }
    this.#primed = true;
  }

  /** Track (m) an event claims: from the start of its approach to the end of its run-out. */
  #span(event: TrainEvent): [number, number] {
    const spec = KINDS[event.kind];
    return [event.start - spec.before, event.start + event.length + spec.after];
  }

  /** One of a kind, as soon as the track allows: just ahead, or right after what is passing. */
  #now(kind: Kind): void {
    const spec = KINDS[kind];
    const random = this.#random;
    const length = Math.round(spec.length[0] + (spec.length[1] - spec.length[0]) * random());
    let start = Math.round(this.#s + spec.lead);
    // Whatever has begun stays: this one waits until it has passed, and slows (if it must) only
    // after it. Anything not yet reached that would overlap makes way.
    let earliest = this.#s + 15;
    for (const event of this.#events) {
      const [from, to] = this.#span(event);
      if (from > this.#s + 5 || to + GAP < this.#s) continue;
      earliest = Math.max(earliest, to + GAP);
      start = Math.max(start, Math.round(to + GAP + Math.min(spec.before, spec.lead)));
    }
    const from = start - spec.before;
    const to = start + length + spec.after;
    for (let i = this.#events.length - 1; i >= 0; i--) {
      const event = this.#events[i];
      if (event === undefined) continue;
      const [a, b] = this.#span(event);
      if (a > this.#s + 5 && a < to + GAP && b > from - GAP) this.#events.splice(i, 1);
    }
    const braking = clamp(start - earliest, 20, spec.before);
    this.#events.push({ kind, start, length, braking, seed: Math.floor(random() * 256) });
    this.#events.sort((a, b) => a.start - b.start);
    this.#cursor = Math.max(this.#cursor, to + GAP);
  }

  /** Commit events up to the horizon: a Poisson process in distance at the knobs' current rates. */
  #schedule(frame: SimFrame): void {
    const rates = KIND_ORDER.map((kind) => (KINDS[kind].perKm / 1000) * Math.max(0, this.#knobs.value(frame, KINDS[kind].knob)));
    const total = rates.reduce((sum, rate) => sum + rate, 0);
    const target = this.#s + HORIZON;
    for (const event of this.#events) this.#cursor = Math.max(this.#cursor, this.#span(event)[1] + GAP);
    while (this.#cursor < target) {
      const room = target - this.#cursor;
      if (total <= 0 || total * room < this.#hazard) {
        this.#hazard -= total * room;
        this.#cursor = target;
        break;
      }
      const at = this.#cursor + this.#hazard / total;
      this.#hazard = -Math.log(1 - this.#random());
      let pick = this.#random() * total;
      let kind: Kind = "crossing";
      for (const [i, k] of KIND_ORDER.entries()) {
        pick -= rates[i] ?? 0;
        if (pick <= 0) {
          kind = k;
          break;
        }
      }
      const spec = KINDS[kind];
      const length = Math.round(spec.length[0] + (spec.length[1] - spec.length[0]) * this.#random());
      const start = Math.round(at + spec.before);
      this.#events.push({ kind, start, length, braking: spec.before, seed: Math.floor(this.#random() * 256) });
      this.#cursor = start + length + spec.after + GAP;
    }
    // Forget what is well behind.
    for (let i = this.#events.length - 1; i >= 0; i--) {
      const event = this.#events[i];
      if (event !== undefined && this.#span(event)[1] < this.#s - SEEN_BEHIND - 200) this.#events.splice(i, 1);
    }
  }

  /** Share of the cruising speed the track asks for here: down for stations, onto bridges. */
  #slowing(): number {
    let factor = 1;
    for (const event of this.#events) {
      const spec = KINDS[event.kind];
      if (spec.slow >= 1) continue;
      const x = this.#s - event.start;
      const down = smoothstep(-event.braking, -0.1 * event.braking, x);
      const up = smoothstep(event.length, event.length + spec.after, x);
      factor = Math.min(factor, 1 - (1 - spec.slow) * down * (1 - up));
    }
    return factor;
  }

  /** Half the view's width at the road (m), past which a car is out of sight. */
  #roadHalfWidth(): number {
    return (0.5 * this.#aspect * TRAIN_ROAD_Z) / TRAIN_FOCAL;
  }

  #carInterval(amount: number): number {
    return CAR_SPARSE + (CAR_BUSY - CAR_SPARSE) * clamp(amount, 0, 1);
  }

  #launchCar(rel: number, speed: number): void {
    const car = this.#cars.find((c) => !c.alive);
    if (car === undefined) return;
    car.rel = rel;
    car.speed = speed;
    car.alive = true;
  }

  /** Cars come and go on the road alongside: most going our way a little faster or slower than the
   *  train (one keeps pace for half a minute), a few coming the other way. */
  #driveCars(frame: SimFrame, advance: number): void {
    const amount = this.#knobs.value(frame, "cars");
    const reach = this.#roadHalfWidth() + CAR_MARGIN;
    for (const car of this.#cars) {
      if (!car.alive) continue;
      car.rel += (car.speed - this.#v) * advance;
      if (Math.abs(car.rel) > reach + 30) car.alive = false;
    }
    if (amount <= 0) {
      this.#nextCar = Number.POSITIVE_INFINITY;
      return;
    }
    if (!Number.isFinite(this.#nextCar)) this.#nextCar = this.#clock + 4;
    if (this.#clock < this.#nextCar) return;
    const random = this.#random;
    this.#nextCar = this.#clock + this.#carInterval(amount) * (0.5 + random());
    if (random() < 0.3) {
      this.#launchCar(reach, -(11 + 5 * random()));
      return;
    }
    const pace = (random() < 0.5 ? -1 : 1) * (1.5 + 3.5 * random());
    this.#launchCar(pace > 0 ? -reach : reach, Math.max(2, this.#v + pace));
  }

  #upload(): void {
    const d = this.#data;
    d.fill(0);
    const whole = Math.floor(this.#s / TRAIN_BLOCK);
    const into = this.#s - whole * TRAIN_BLOCK;
    d[0] = ((whole % TRAIN_BLOCKS) + TRAIN_BLOCKS) % TRAIN_BLOCKS;
    d[1] = Math.floor(into);
    d[2] = into - Math.floor(into);
    d[3] = this.#v;
    d[4] = this.#accel;
    let slot = 0;
    for (const event of this.#events) {
      if (slot >= TRAIN_EVENT_SLOTS) break;
      const [from, to] = this.#span(event);
      if (to < this.#s - SEEN_BEHIND || from > this.#s + SEEN_AHEAD) continue;
      const base = (2 + 2 * slot) * 4;
      const block = Math.floor(event.start / TRAIN_BLOCK);
      d[base] = ((block % TRAIN_BLOCKS) + TRAIN_BLOCKS) % TRAIN_BLOCKS;
      d[base + 1] = event.start - block * TRAIN_BLOCK;
      d[base + 2] = event.length;
      d[base + 3] = KINDS[event.kind].code;
      d[base + 4] = event.seed / 256;
      d[base + 5] = event.braking;
      slot++;
    }
    for (const [i, car] of this.#cars.entries()) {
      const base = (2 + 2 * TRAIN_EVENT_SLOTS + i) * 4;
      if (!car.alive) continue;
      d[base] = car.rel;
      d[base + 1] = car.speed >= 0 ? 1 : -1;
      d[base + 2] = 1;
    }
    this.#texture.upload(d);
  }
}

/** The journey's simulation for a scene whose knobs are `params` (looked up by key). */
export function trainSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new TrainJourney(gl, params);
}
