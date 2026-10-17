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
// The line (TRAIN_LINES, the `line` knob) is the country the track runs through, and sets what
// passes and how: how often each kind comes, how long it is, how slowly the train takes it, its
// cruising pace, and what follows what at once, closer than the usual clear track (out of a tunnel's
// mouth straight onto a viaduct and into the next mountain; a rural halt's level crossing at the end
// of its platform). The shader draws the land to match (shader.ts, trainLine). "Country" is the line
// as it always ran: the same timetable for the same route, draw for draw.
//
// uSim0, one row of rgba16f texels (half floats hold whole numbers exactly up to 2048, so positions
// travel as whole 256 m blocks and metres plus a fraction):
//   0       odometer: x whole blocks (mod 2048), y whole metres into the block, z the fraction of a
//           metre, w speed (m/s)
//   1       x acceleration along the track (m/s², eased), yzw spare
//   2..13   events, two texels each: (block, metre where it starts, length m, kind) and (seed 0..1,
//           metres before the start the train slows over, 0, 0); kind 0 is an empty slot
//   14, 15  cars on the road alongside: (metres ahead of the train, heading +1 / -1, 1 while there, 0)
import { KnobReader, type ParamDef } from "../../params.ts";
import { approach, clamp, smoothstep } from "../../sims/math.ts";
import { mulberry32 } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

// ---- Shared with the shader ----

/** Event and car slots in the texture, and its width in texels. */
export const TRAIN_EVENT_SLOTS = 6;
export const TRAIN_CAR_SLOTS = 2;
export const TRAIN_TEXELS = 2 + 2 * TRAIN_EVENT_SLOTS + TRAIN_CAR_SLOTS;

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

/** The `line` choice, in the order the shader reads K_line: the country line as it always ran, a rural branch line, a mountain line. */
export const TRAIN_LINES = [
  { label: "country", value: 0 },
  { label: "rural", value: 1 },
  { label: "mountain", value: 2 },
] as const;

// ---- The timetable ----

type Kind = "station" | "crossing" | "bridge" | "tunnel";
type TrainKnob =
  "speed" | "stations" | "crossings" | "bridges" | "tunnels" | "cars" | "route" | "line";
const KNOB_KEYS: readonly TrainKnob[] = [
  "speed",
  "stations",
  "crossings",
  "bridges",
  "tunnels",
  "cars",
  "route",
  "line",
];

interface KindSpec {
  readonly code: number;
  readonly knob: TrainKnob;
  /** Events per km of track at frequency 1 on the country line. */
  readonly perKm: number;
  /** Track before and after it that belongs to it (slowing, cuttings, a road seen from afar), m. */
  readonly before: number;
  readonly after: number;
  /** How far ahead (m) a "now" one starts. */
  readonly lead: number;
}

const KINDS: Readonly<Record<Kind, KindSpec>> = {
  station: {
    code: TRAIN_STATION,
    knob: "stations",
    perKm: 0.8,
    before: 220,
    after: 150,
    lead: 100,
  },
  crossing: {
    code: TRAIN_CROSSING,
    knob: "crossings",
    perKm: 1.2,
    before: 130,
    after: 70,
    lead: 85,
  },
  bridge: { code: TRAIN_BRIDGE, knob: "bridges", perKm: 0.5, before: 130, after: 90, lead: 95 },
  tunnel: { code: TRAIN_TUNNEL, knob: "tunnels", perKm: 0.5, before: 120, after: 120, lead: 115 },
};
const KIND_ORDER: readonly Kind[] = ["station", "crossing", "bridge", "tunnel"];

/** A kind as a line has it. */
interface LineKind {
  /** Times the kind's events per km. */
  readonly rate: number;
  /** Length (m) of the platform, bridge or tunnel: least and most. */
  readonly length: readonly [number, number];
  /** Share of the cruising speed the train passes it at. */
  readonly slow: number;
}

/** What comes straight after an event of a kind, now and then: closer than the usual clear track. */
interface Follow {
  readonly kind: Kind;
  readonly chance: number;
  /** Metres from the end of the one to the start of the next: least and most. */
  readonly gap: readonly [number, number];
}

interface LineSpec {
  readonly kinds: Readonly<Record<Kind, LineKind>>;
  /** Share of the speed knob's cruising speed. */
  readonly cruise: number;
  readonly follow: Readonly<Partial<Record<Kind, Follow>>>;
}

/** Events in one run at most: the first and those that follow it at once. */
const RUN = 3;

/** In TRAIN_LINES order. */
const LINES: readonly [LineSpec, LineSpec, LineSpec] = [
  // Country: stations every so often, level crossings, an iron bridge over a valley, a tunnel through a hill.
  {
    kinds: {
      station: { rate: 1, length: [150, 200], slow: 0.35 },
      crossing: { rate: 1, length: [0, 0], slow: 1 },
      bridge: { rate: 1, length: [70, 130], slow: 0.4 },
      tunnel: { rate: 1, length: [180, 420], slow: 1 },
    },
    cruise: 1,
    follow: {},
  },
  // Rural: a branch line through farmland, a little slower; short halts where the train all but
  // stops, most with a farm road crossing at the platform's end; crossings everywhere; short girder
  // bridges over streams; no hills to tunnel through.
  {
    kinds: {
      station: { rate: 1.4, length: [90, 130], slow: 0.25 },
      crossing: { rate: 2.2, length: [0, 0], slow: 1 },
      bridge: { rate: 0.6, length: [30, 60], slow: 0.6 },
      tunnel: { rate: 0, length: [150, 260], slow: 1 },
    },
    cruise: 0.85,
    follow: { station: { kind: "crossing", chance: 0.7, gap: [18, 30] } },
  },
  // Mountain: climbing slowly; long tunnels, often straight out of one onto a stone viaduct over a
  // gorge and into the next; few stations, hardly a road to cross.
  {
    kinds: {
      station: { rate: 0.6, length: [150, 200], slow: 0.35 },
      crossing: { rate: 0.15, length: [0, 0], slow: 1 },
      bridge: { rate: 2.4, length: [90, 220], slow: 0.6 },
      tunnel: { rate: 2.2, length: [240, 640], slow: 1 },
    },
    cruise: 0.75,
    follow: {
      tunnel: { kind: "bridge", chance: 0.55, gap: [20, 35] },
      bridge: { kind: "tunnel", chance: 0.6, gap: [15, 30] },
    },
  },
];

/** Events are committed this far ahead of the train (m): beyond anything the window shows. */
const HORIZON = 1000;
/** Clear track between one event's stretch and the next (m). */
const GAP = 90;
/** Events are handed to the shader while their stretch overlaps this window round the train (m). */
const SEEN_BEHIND = 700;
const SEEN_AHEAD = 1100;
/** The first station after loading starts this far ahead (m): most of a minute of open country first. */
const FIRST_STATION = 540;
/** Its platform (m), as near this as the line's platforms come. */
const FIRST_PLATFORM = 170;
/** Time constants (s): the speed following its target, the acceleration handed on. */
const SPEED_EASE = 2.2;
const ACCEL_EASE = 0.5;

/** Seconds between cars at the frequency knob's ends. */
const CAR_SPARSE = 90;
const CAR_BUSY = 12;
/** Metres past the edge of the view a car comes in from and leaves by. */
const CAR_MARGIN = 12;

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

class TrainJourney implements SceneSim {
  readonly #texture: DataTexture;
  readonly #data = new Float32Array(TRAIN_TEXELS * 4);
  readonly #knobs: KnobReader<TrainKnob>;
  /** Kind by "now" slot, and the car's slot. */
  readonly #nowKinds: readonly (readonly [number, Kind])[];
  readonly #carTrigger: number;
  readonly #events: TrainEvent[] = [];
  /** The events handed to the shader this frame (kept to avoid an array a frame). */
  readonly #shown: TrainEvent[] = [];
  readonly #cars: Car[] = Array.from({ length: TRAIN_CAR_SLOTS }, () => ({
    rel: 0,
    speed: 0,
    alive: false,
  }));
  #route = Number.NaN;
  #lineIndex = Number.NaN;
  #line: LineSpec = LINES[0];
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
    this.#knobs = new KnobReader("train", params, KNOB_KEYS);
    this.#nowKinds = KIND_ORDER.map(
      (kind) => [this.#knobs.trigger(KINDS[kind].knob), kind] as const,
    );
    this.#carTrigger = this.#knobs.trigger("cars");
    this.#texture = new DataTexture(gl, {
      width: TRAIN_TEXELS,
      height: 1,
      format: "rgba16f",
      filter: "nearest",
    });
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    if (frame.aspect > 0 && Number.isFinite(frame.aspect)) this.#aspect = frame.aspect;
    const route = Math.round(this.#knobs.value(frame, "route"));
    const line = clamp(Math.round(this.#knobs.value(frame, "line")), 0, LINES.length - 1);
    if (route !== this.#route || line !== this.#lineIndex) this.#depart(frame, route, line);
    this.#watchTriggers(frame);

    const advance = Math.max(0, frame.dt) * Math.max(0, frame.motion);
    if (advance > 0) {
      this.#clock += advance;
      const cruise = this.#cruise(frame);
      const before = this.#v;
      this.#v = approach(this.#v, cruise * this.#slowing(), advance, SPEED_EASE);
      this.#s += 0.5 * (before + this.#v) * advance;
      this.#accel = approach(this.#accel, (this.#v - before) / advance, advance, ACCEL_EASE);
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
    return TRAIN_TOP_SPEED * clamp(this.#knobs.value(frame, "speed"), 0.05, 1) * this.#line.cruise;
  }

  /** A fresh journey for a route on a line: a stretch of line of its own, the train already running. */
  #depart(frame: SimFrame, route: number, line: number): void {
    this.#route = route;
    this.#lineIndex = line;
    this.#line = LINES[line] ?? this.#line;
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
      const [shortest, longest] = this.#line.kinds.station.length;
      const length = clamp(FIRST_PLATFORM, shortest, longest);
      const start = Math.round(this.#s + FIRST_STATION);
      const first: TrainEvent = {
        kind: "station",
        start,
        length,
        braking: spec.before,
        seed: Math.floor(random() * 256),
      };
      this.#events.push(first);
      const last = this.#follow(first);
      this.#cursor = Math.max(this.#cursor, this.#span(last)[1] + GAP);
    }
    this.#v = this.#cruise(frame) * this.#slowing();
    for (const car of this.#cars) car.alive = false;
    const cars = this.#knobs.value(frame, "cars");
    this.#nextCar = cars > 0 ? this.#carInterval(cars) * 0.6 : Number.POSITIVE_INFINITY;
    // A car on the road alongside, a little slower than the train: it drifts back out of view.
    if (cars > 0) this.#launchCar(0.25 * this.#roadHalfWidth(), this.#v - 1.6);
  }

  /** A "now" button: one of its kind as soon as the track allows, or a car overtaking. */
  #watchTriggers(frame: SimFrame): void {
    for (const [slot, kind] of this.#nowKinds) if (frame.fired[slot] === true) this.#now(kind);
    if (frame.fired[this.#carTrigger] === true)
      this.#launchCar(-(this.#roadHalfWidth() + CAR_MARGIN), this.#v + 2.4);
  }

  /** Track (m) an event claims: from the start of its approach to the end of its run-out. */
  #span(event: TrainEvent): [number, number] {
    const spec = KINDS[event.kind];
    return [event.start - spec.before, event.start + event.length + spec.after];
  }

  /** A length for a kind on this line. */
  #length(kind: Kind): number {
    const [shortest, longest] = this.#line.kinds[kind].length;
    return Math.round(shortest + (longest - shortest) * this.#random());
  }

  /**
   * What follows `head` at once on this line, by chance (the dice are only thrown on a line that
   * has something to follow it): pushed after it, a run of at most RUN. Returns the run's last event.
   */
  #follow(head: TrainEvent): TrainEvent {
    let last = head;
    for (let i = 1; i < RUN; i++) {
      const next = this.#line.follow[last.kind];
      if (next === undefined || this.#random() >= next.chance) break;
      const length = this.#length(next.kind);
      const gap = Math.round(next.gap[0] + (next.gap[1] - next.gap[0]) * this.#random());
      const event: TrainEvent = {
        kind: next.kind,
        start: last.start + last.length + gap,
        length,
        braking: KINDS[next.kind].before,
        seed: Math.floor(this.#random() * 256),
      };
      this.#events.push(event);
      last = event;
    }
    return last;
  }

  /** One of a kind, as soon as the track allows: just ahead, or right after what is passing. */
  #now(kind: Kind): void {
    const spec = KINDS[kind];
    const random = this.#random;
    const length = this.#length(kind);
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
    const braking = clamp(start - earliest, 20, spec.before);
    const head: TrainEvent = { kind, start, length, braking, seed: Math.floor(random() * 256) };
    // The run it heads, pushed at the end of the list; then what it now overlaps makes way.
    const first = this.#events.length;
    this.#events.push(head);
    const from = start - spec.before;
    const to = this.#span(this.#follow(head))[1];
    for (let i = first - 1; i >= 0; i--) {
      const event = this.#events[i];
      if (event === undefined) continue;
      const [a, b] = this.#span(event);
      if (a > this.#s + 5 && a < to + GAP && b > from - GAP) this.#events.splice(i, 1);
    }
    this.#events.sort((a, b) => a.start - b.start);
    this.#cursor = Math.max(this.#cursor, to + GAP);
  }

  /** Commit events up to the horizon: a Poisson process in distance at the knobs' current rates. */
  #schedule(frame: SimFrame): void {
    const kinds = this.#line.kinds;
    const rates = KIND_ORDER.map(
      (kind) =>
        (KINDS[kind].perKm / 1000) *
        kinds[kind].rate *
        Math.max(0, this.#knobs.value(frame, KINDS[kind].knob)),
    );
    const total = rates.reduce((sum, rate) => sum + rate, 0);
    const target = this.#s + HORIZON;
    for (const event of this.#events)
      this.#cursor = Math.max(this.#cursor, this.#span(event)[1] + GAP);
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
      const length = this.#length(kind);
      const start = Math.round(at + spec.before);
      const head: TrainEvent = {
        kind,
        start,
        length,
        braking: spec.before,
        seed: Math.floor(this.#random() * 256),
      };
      this.#events.push(head);
      this.#cursor = this.#span(this.#follow(head))[1] + GAP;
    }
    // Forget what is well behind.
    for (let i = this.#events.length - 1; i >= 0; i--) {
      const event = this.#events[i];
      if (event !== undefined && this.#span(event)[1] < this.#s - SEEN_BEHIND - 200)
        this.#events.splice(i, 1);
    }
  }

  /** Share of the cruising speed the track asks for here: down for stations, onto bridges. */
  #slowing(): number {
    let factor = 1;
    for (const event of this.#events) {
      const slow = this.#line.kinds[event.kind].slow;
      if (slow >= 1) continue;
      const x = this.#s - event.start;
      const down = smoothstep(-event.braking, -0.1 * event.braking, x);
      const up = smoothstep(event.length, event.length + KINDS[event.kind].after, x);
      factor = Math.min(factor, 1 - (1 - slow) * down * (1 - up));
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

  /** Metres from the train to an event's platform, road, bridge or tunnel (0 while on it). */
  #distance(event: TrainEvent): number {
    return Math.max(event.start - this.#s, this.#s - event.start - event.length, 0);
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
    // Those whose stretch overlaps the window, in timetable order; if there are more than the
    // texture holds, the nearest.
    const shown = this.#shown;
    shown.length = 0;
    for (const event of this.#events) {
      const [from, to] = this.#span(event);
      if (to >= this.#s - SEEN_BEHIND && from <= this.#s + SEEN_AHEAD) shown.push(event);
    }
    if (shown.length > TRAIN_EVENT_SLOTS) {
      shown.sort((a, b) => this.#distance(a) - this.#distance(b));
      shown.length = TRAIN_EVENT_SLOTS;
      shown.sort((a, b) => a.start - b.start);
    }
    for (const [slot, event] of shown.entries()) {
      const base = (2 + 2 * slot) * 4;
      const block = Math.floor(event.start / TRAIN_BLOCK);
      d[base] = ((block % TRAIN_BLOCKS) + TRAIN_BLOCKS) % TRAIN_BLOCKS;
      d[base + 1] = event.start - block * TRAIN_BLOCK;
      d[base + 2] = event.length;
      d[base + 3] = KINDS[event.kind].code;
      d[base + 4] = event.seed / 256;
      d[base + 5] = event.braking;
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
