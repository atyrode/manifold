// The bar's small life, scheduled on the CPU and handed to the shader (shader.ts) as one row of
// texels: who sits on which stool, who is walking in out of the rain or heading home, what the
// bartender is doing and where, and what is in each glass on the counter.
//
// World units are metres: x right, y up, z ahead, the eye EYE metres over the floor at x = 0 (a
// seat in the corner booth). The counter runs across the room; four stools stand in front of it,
// the bartender works behind it, the shelves of bottles stand against the mirror behind him, and the
// door is off the left edge, past the front window.
//
// Patrons. Each stool has a slot. A patron comes in at the door, walks along the floor in front of
// the stools (WALK_Z), turns to the counter and climbs onto the stool, then sits: looking at the
// bar, turning to a neighbour to talk, glancing back at the rain on the window, and every half
// minute or so lifting their glass for a sip (the drink goes down). After a few minutes they climb
// down and walk out, leaving their glass behind. How many stools are taken follows the `patrons`
// knob, thinned by the time of night (`night`): busy early, one regular left at last call. Arrivals
// and departures are spaced out so the room changes over minutes, one person at a time.
//
// The bartender keeps a short plan of steps. A patron without a drink gets served: he walks over,
// takes the order, and either turns to the shelf behind him, takes a bottle (its slot on the
// lower shelf stands empty while he has it), pours into a glass he sets on the counter and puts
// the bottle back, or shakes a cocktail and strains it into a coupe. Glasses left behind are
// cleared and the spot wiped. Between orders he polishes glasses, wipes the counter (more as last
// call nears), stands and looks out at the rain, or leans over to chat. A press on the bar, anyone's
// (SimFrame.principals), brings him over to it; the "now" buttons send in a new patron or have him
// shake a cocktail.
//
// Last call (the `night` knob's "now"). It is called when the bartender rings it: as soon as his
// hands are free he lifts a brass hand bell and rings it (ACT.bell), and the house lights blink twice
// (the shader, from the call's clock). With the bartender off, someone in the back flicks the
// lights at once and there is no bell. Everyone at the bar looks up, takes a last sip, and (if
// there is anyone to serve them) some order one for the road; with nobody at the bar he comes over
// to you instead. From then on it is closing time whatever the clock said (CLOSING_NIGHT): nobody
// new comes in, the room empties one by one (a regular last), the lamps go down and the OPEN sign
// goes dark. Moving the `night` knob ends it; the evening follows the knob again.
//
// The candle on your table bends with the air the hands sweeping past it push, then rights itself.
//
// Time runs in fixed steps of STEP seconds of simulated time (scene seconds times the lab's
// motion), so the evening depends only on the knobs and the clock, not on the frame rate. The first
// frame lays out an evening already under way: stools taken, drinks half drunk, the bartender
// polishing. Nothing is allocated per frame (planning, a few times a minute, makes its steps).
//
// Texture (rgba16f, TEXELS × 1, nearest):
//   0            bartender: x (m), action (ACT), seconds into it (60 at most), its length (s)
//   1            bartender: carrying (CARRY), lower-shelf slot of the bottle he holds (-1 none),
//                head turn (-1 left .. 1 right), attending you (0..1)
//   2 + i        patron on stool i: x, z (m), sitting 0..1, gait phase 0..1
//   6 + i        patron: look seed (0 = nobody), facing (-1 walking left, 0 back to us, 1 walking
//                right), head turn (-1.4 over the left shoulder .. 1 to the right), sip 0..1
//   10 + i       patron: talking 0..1, carrying a closed umbrella 0/1, wet coat 0..1
//   14 + i       glass at stool i: fill 0..1 (-1 no glass), kind (0 tumbler, 1 wine, 2 coupe,
//                3 highball), x (m, on the counter at GLASS_Z), source slot (-1 a cocktail)
//   18           candle: draught x, y (-1..1); the ceiling fan's angle (rad, 0..2π); seconds since
//                last call was called (-1: not called)
import type { ParamDef } from "../../params.ts";
import { MAX_PRINCIPALS } from "../../principals.ts";
import { approach, clamp, smoothstep } from "../../sims/math.ts";
import { Random } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFactory, SimFrame, ScenePoint } from "../types.ts";
import { PASSAGE } from "./constants.ts";

// ---- The room, shared with the shader ----

/** Focal length (screen heights) and eye height over the floor (m): the booth sits raised, so the
 *  counter top shows as a band of polished wood. The eye level sits HORIZON screen heights above
 *  the frame's middle. */
export const FOCAL = 0.85;
export const EYE = 1.5;
export const HORIZON = 0.03;
/** Your table is a foreground plate seen from closer, leaning in over it: its own eye height (m). */
export const TABLE_EYE = 1.09;
/** Narrow frames pan left toward the window: by PAN_RATE screen heights per unit of aspect below PAN_FROM. */
export const PAN_FROM = 1.6;
export const PAN_RATE = 0.3;
/** The stools: x of each (m), and how far ahead they stand. */
export const SEATS = 4;
export const STOOL_X: readonly number[] = [-0.6, 0.35, 1.3, 2.25];
export const STOOL_Z = 2.78;
/** The floor path in front of the stools, and where the door is along it (off the left edge). */
export const WALK_Z = 2.3;
export const DOOR_X = -4.3;
/** Glasses stand on the counter this far ahead, each seat's this far right of its stool: far enough
 *  that the bartender, pouring into it, stands clear of its owner's head. */
export const GLASS_Z = 3.3;
export const GLASS_OFFSET = 0.35;
/** The bartender's plane behind the counter, the stretch he works along, and how far right of him his pouring hand reaches. */
export const BARTENDER_Z = 4.05;
export const BARTENDER_MIN = -0.9;
export const BARTENDER_MAX = 3.1;
export const POUR_REACH = 0.13;
/** Bottle slots on the shelves: their width and where the first one starts (m along the shelf). */
export const SLOT_W = 0.12;
export const SLOT_X0 = -1.9;
/** The candle's flame on your table (m, in the table plate's view). */
export const CANDLE_X = 0.36;
export const CANDLE_Y = 0.83;
export const CANDLE_Z = 0.72;
/** The ceiling fan's pace at either end of its knob (turns per second): lazy; even the fastest leaves a second between blades. */
export const FAN_SLOW = 0.04;
export const FAN_FAST = 0.25;
/** The fan stands still as you sit down and spins up between these seconds of the entrance. */
const FAN_SPIN_FROM = 0.6;
const FAN_SPIN_TO = 2.7;

/** What the bartender is doing. */
export const ACT = {
  idle: 0,
  polish: 1,
  walk: 2,
  chat: 3,
  fetch: 4,
  pour: 5,
  put: 6,
  shake: 7,
  strain: 8,
  wipe: 9,
  clear: 10,
  bell: 11,
} as const;
type Act = (typeof ACT)[keyof typeof ACT];

/** What he has in his hands besides a towel. */
export const CARRY = { none: 0, bottle: 1, shaker: 2, glass: 3 } as const;
type Carry = (typeof CARRY)[keyof typeof CARRY];

/** Glass shapes on the counter. */
export const GLASS = { tumbler: 0, wine: 1, coupe: 2, highball: 3 } as const;

/** Key moments inside actions (s): shared with the shader so hands and glasses agree. */
export const FETCH_GRAB = 1.3;
export const PUT_RELEASE = 1.2;
export const POUR_SET = 0.6;
export const POUR_FLOW = [1.2, 3.2] as const;
export const STRAIN_SET = 0.5;
export const STRAIN_FLOW = [1.0, 2.6] as const;
export const CLEAR_TAKE = 0.9;
/** Seconds a patron takes to climb onto or down from a stool, and a sip from start to finish. */
export const SIT_TIME = 1.6;
export const SIP_TIME = 4.5;
/** Last call: how long he rings the bell (s), the house lights' two blinks (seconds after it is
 *  called: off from each start for BLINK_OFF), and the time of night it then is, whatever the knob. */
export const BELL_TIME = 3.2;
export const BLINKS = [2.7, 3.35] as const;
export const BLINK_OFF = 0.25;
export const CLOSING_NIGHT = 0.95;

export const TEXELS = 19;

// ---- The evening (sim only) ----

/** Simulated seconds per step, and the most steps one frame may take (after a stall). */
const STEP = 1 / 30;
const MAX_STEPS = 15;
/** Walking pace (m/s) of patrons and of the bartender, and a full gait cycle (two steps, m). */
const PATRON_PACE = 0.85;
const BARTENDER_PACE = 0.8;
const GAIT = 1.3;
/** A patron stays this long (s) on a busy evening (less toward last call), and the next one comes in this long after a stool frees (s). */
const STAY = [150, 420] as const;
const ARRIVAL_GAP = [18, 70] as const;
/** Seconds between sips, and how much of the glass each one takes. */
const SIP_GAP = [22, 55] as const;
const SIP_DRINK = [0.1, 0.16] as const;
/** Seconds between glances, and the share of them toward a neighbour and toward the window. */
const LOOK_GAP = [6, 22] as const;
const LOOK_NEIGHBOUR = 0.32;
const LOOK_WINDOW = 0.1;
/** Time constants (s) of turning the head, turning the body and starting or stopping a conversation. */
const TURN_TIME = 0.7;
const FACE_TIME = 0.35;
const TALK_TIME = 1.5;
/** A wet coat dries over this many seconds indoors. */
const COAT_DRY = 90;
/** The candle's lean: how hard a hand's speed (screen heights/s) pushes it, how near it must pass, and how fast it leans and recovers (s). */
const DRAUGHT_GAIN = 0.6;
const DRAUGHT_REACH = 0.12;
const DRAUGHT_LEAN = 0.12;
const DRAUGHT_SETTLE = 0.7;
/** Fixed seed: the same evening every time the scene opens. */
const SEED = 0x6ba7;

type KnobKey = "night" | "patrons" | "bartender" | "rain" | "fan";
const KNOB_KEYS: readonly KnobKey[] = ["night", "patrons", "bartender", "rain", "fan"];

/** Trigger slots (index.ts): a cocktail now, a new patron now, last call now. */
const TRIGGER_COCKTAIL = 0;
const TRIGGER_ARRIVAL = 4;
const TRIGGER_LAST_CALL = 5;
/** At last call: where he stands to talk to you, how many of those at the bar order one for the road. */
const YOUR_END = 0;
const ONE_FOR_THE_ROAD = 0.5;

export class BarSimError extends Error {}

type PatronState = "empty" | "arriving" | "sitting" | "seated" | "rising" | "leaving";

interface Patron {
  state: PatronState;
  /** Clock when the state began. */
  since: number;
  x: number;
  z: number;
  sit: number;
  /** Metres walked (for the gait). */
  stride: number;
  seed: number;
  facing: number;
  facingTo: number;
  turn: number;
  turnTo: number;
  talk: number;
  nextLook: number;
  /** Clock the current sip began; it drinks at its middle. */
  sipAt: number;
  sipDrunk: boolean;
  nextSip: number;
  leaveAt: number;
  /** Clock since which they have wanted a drink; Infinity while they have one or are being served. */
  wantsAt: number;
  umbrella: number;
  wet: number;
}

interface Drink {
  fill: number;
  kind: number;
  x: number;
  source: number;
  /** Left behind by someone who has gone. */
  abandoned: boolean;
}

interface Step {
  act: Act;
  dur: number;
  /** Where to walk to (walk) or the seat being served (-1 none). */
  x: number;
  seat: number;
}

interface Bartender {
  x: number;
  act: Act;
  age: number;
  dur: number;
  /** Walk target, and the seat this step serves (-1 none). */
  target: number;
  seat: number;
  carry: Carry;
  taken: number;
  look: number;
  lookTo: number;
  nextLook: number;
  attend: number;
  /** For pours: the fill the glass is poured up to. */
  pourTo: number;
}

const blankPatron = (): Patron => ({
  state: "empty",
  since: 0,
  x: DOOR_X,
  z: WALK_Z,
  sit: 0,
  stride: 0,
  seed: 0,
  facing: 1,
  facingTo: 1,
  turn: 0,
  turnTo: 0,
  talk: 0,
  nextLook: 0,
  sipAt: Number.NEGATIVE_INFINITY,
  sipDrunk: true,
  nextSip: Number.POSITIVE_INFINITY,
  leaveAt: Number.POSITIVE_INFINITY,
  wantsAt: Number.POSITIVE_INFINITY,
  umbrella: 0,
  wet: 0,
});

/** The bartender as the evening opens: polishing a glass between the first two stools, where no one
 *  sitting hides him. */
const openingBartender = (): Bartender => ({
  x: 1.2,
  act: ACT.polish,
  age: 3,
  dur: 16,
  target: 1.2,
  seat: -1,
  carry: CARRY.none,
  taken: -1,
  look: 0,
  lookTo: 0,
  nextLook: 6,
  attend: 0,
  pourTo: 0.8,
});

/** Where a seat's glass stands on the counter (m), and where the bartender stands to pour into it. */
const glassX = (seat: number): number => (STOOL_X[seat] ?? 0) + GLASS_OFFSET;
const pourX = (seat: number): number =>
  clamp(glassX(seat) * (BARTENDER_Z / GLASS_Z) - POUR_REACH, BARTENDER_MIN, BARTENDER_MAX);
/** The lower-shelf slot right behind the bartender's reaching hand (the shader numbers slots the same way: barBackWall). */
const slotBehind = (x: number): number => Math.floor((x + POUR_REACH - SLOT_X0) / SLOT_W);

class BarEvening implements SceneSim {
  readonly #texture: DataTexture;
  readonly #data = new Float32Array(TEXELS * 4);
  readonly #index: Readonly<Record<KnobKey, number>>;
  readonly #patrons: readonly Patron[] = Array.from({ length: SEATS }, blankPatron);
  readonly #drinks: readonly Drink[] = Array.from({ length: SEATS }, (_, seat) => ({
    fill: -1,
    kind: 0,
    x: glassX(seat),
    source: -1,
    abandoned: false,
  }));
  readonly #plan: Step[] = [];
  readonly #bar: Bartender = openingBartender();
  /** The evening's chance: the same evening every time the scene opens (SEED). */
  readonly #rng = new Random(SEED);

  #clock = 0;
  #pending = 0;
  #lastTime = Number.NaN;
  #started = false;
  #seen: number[] = [];

  #night = 0.3;
  #crowd = 3;
  #serving = true;
  #rain = 0;
  #aspect = 16 / 9;
  #fan = 0;
  #fanAngle = 0;
  #nextArrival = 0;
  #nextLeave = 0;
  #visitX = Number.NaN;
  #cocktail = false;
  /** Last call: asked for and waiting for his hands to be free; the clock when it was called (NaN:
   *  not called), so closing time from then on; the time of night it was asked for at. */
  #callPending = false;
  #callAt = Number.NaN;
  #callNight = Number.NaN;
  /** The glass he will set down for the pour he has planned. */
  #pourKind: number = GLASS.tumbler;

  #draftX = 0;
  #draftY = 0;
  /** Each hand's point last frame (NaN while off the page), by place in SimFrame.principals. */
  readonly #prevX = new Float64Array(MAX_PRINCIPALS).fill(Number.NaN);
  readonly #prevY = new Float64Array(MAX_PRINCIPALS).fill(Number.NaN);
  /** Points of interest along the counter for #interestAspect (SceneSim.interest). */
  readonly #interest: ScenePoint[] = [];
  #interestAspect = Number.NaN;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    const find = (key: KnobKey): number => {
      const at = params.findIndex((def) => def.key === key);
      if (at < 0) throw new BarSimError(`bar: the scene has no '${key}' knob`);
      return at;
    };
    const index: Record<KnobKey, number> = { night: 0, patrons: 0, bartender: 0, rain: 0, fan: 0 };
    for (const key of KNOB_KEYS) index[key] = find(key);
    this.#index = index;
    this.#texture = new DataTexture(gl, {
      width: TEXELS,
      height: 1,
      format: "rgba16f",
      filter: "nearest",
    });
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const values = frame.values;
    this.#night = clamp(values[this.#index.night] ?? 0.3, 0, 1);
    this.#crowd = clamp(Math.round(values[this.#index.patrons] ?? 3), 0, SEATS);
    this.#serving = (values[this.#index.bartender] ?? 1) > 0.5;
    this.#rain = clamp(values[this.#index.rain] ?? 0, 0, 1);
    this.#fan = clamp(values[this.#index.fan] ?? 0, 0, 1);
    if (frame.aspect > 0) this.#aspect = frame.aspect;
    // Moving the time of night after last call ends it: the evening follows the knob again.
    if (Number.isFinite(this.#callNight) && this.#night !== this.#callNight) this.#endCall();

    // A clock that went backwards (the lab restarted the scene) starts the evening over.
    if (!this.#started || frame.time < this.#lastTime - 0.5) this.#reset(frame);
    this.#lastTime = frame.time;

    this.#watchTriggers(frame.triggers);
    // With nobody behind the bar, last call is the lights flicked from the back, at once.
    if (this.#callPending && !this.#serving) this.#startCall();
    this.#follow(frame);

    const advance = Math.max(0, frame.dt) * Math.max(0, frame.motion);
    // The fan turns at the knob's pace, carrying on from where it was when the knob moves; on the
    // entrance it starts from a standstill (exactly 1 once arrived).
    const spin =
      frame.passage.enter >= 1
        ? 1
        : smoothstep(FAN_SPIN_FROM, FAN_SPIN_TO, frame.passage.enter * PASSAGE.enter);
    if (this.#fan > 0)
      this.#fanAngle =
        (this.#fanAngle +
          advance * spin * 2 * Math.PI * (FAN_SLOW + (FAN_FAST - FAN_SLOW) * this.#fan)) %
        (2 * Math.PI);
    this.#pending = Math.min(this.#pending + advance, MAX_STEPS * STEP);
    while (this.#pending >= STEP) {
      this.#step();
      this.#pending -= STEP;
    }
    this.#upload();
    return [this.#texture.texture];
  }

  dispose(): void {
    this.#texture.dispose();
  }

  /** Along the counter, where a press calls the bartender over: three places he works, those in frame. */
  interest(aspect: number): readonly ScenePoint[] {
    if (aspect !== this.#interestAspect) {
      this.#interestAspect = aspect;
      const pan = -Math.max(0, PAN_FROM - aspect) * PAN_RATE;
      this.#interest.length = 0;
      for (const metres of [0, 1.2, 2.4]) {
        const x = ((metres * FOCAL) / BARTENDER_Z - pan) / aspect + 0.5;
        if (x > 0.08 && x < 0.92) this.#interest.push({ x, y: 0.5 + HORIZON });
      }
    }
    return this.#interest;
  }

  /** The time of night the evening keeps: the knob's, or closing time once last call has been called. */
  #lateness(): number {
    return Number.isFinite(this.#callAt) ? Math.max(this.#night, CLOSING_NIGHT) : this.#night;
  }

  /** How many stools should be taken now: the knob, thinned toward last call, one regular staying on. */
  #target(): number {
    if (this.#crowd === 0) return 0;
    const share = 1 - 0.8 * smoothstep(0.35, 0.95, this.#lateness());
    return Math.max(1, Math.round(this.#crowd * share));
  }

  /** Minutes a patron stays: shorter as the night gets late. */
  #stay(): number {
    return this.#rng.range(STAY[0], STAY[1]) * (1 - 0.45 * this.#lateness());
  }

  /** An evening already under way: stools taken, drinks half drunk, the bartender polishing. */
  #reset(frame: SimFrame): void {
    this.#rng.seed(SEED);
    this.#clock = 0;
    this.#pending = 0;
    this.#plan.length = 0;
    this.#seen = [...frame.triggers];
    this.#started = true;
    this.#visitX = Number.NaN;
    this.#cocktail = false;
    this.#endCall();
    const target = this.#target();
    const order = [1, 2, 0, 3];
    this.#patrons.forEach((patron, seat) => {
      Object.assign(patron, blankPatron());
      const drink = this.#drinks[seat];
      if (drink)
        Object.assign(drink, { fill: -1, kind: 0, x: glassX(seat), source: -1, abandoned: false });
    });
    for (let k = 0; k < target; k++) {
      const seat = order[k] ?? k;
      const patron = this.#patrons[seat];
      const drink = this.#drinks[seat];
      if (!patron || !drink) continue;
      Object.assign(patron, {
        state: "seated",
        since: -this.#rng.range(30, 200),
        x: STOOL_X[seat] ?? 0,
        z: STOOL_Z,
        sit: 1,
        seed: 0.05 + 0.9 * this.#rng.next(),
        facing: 0,
        facingTo: 0,
        nextLook: this.#rng.range(2, 12),
        nextSip: this.#rng.range(4, 30),
        // Staggered, so the first change comes within a minute or two and the rest spread out.
        leaveAt: 45 + k * this.#rng.range(60, 140) + this.#rng.range(0, 60),
      } satisfies Partial<Patron>);
      Object.assign(drink, {
        fill: 0.3 + 0.55 * this.#rng.next(),
        kind: Math.floor(this.#rng.next() * 4),
        source: Math.floor(this.#rng.next() * 50),
        abandoned: false,
      } satisfies Partial<Drink>);
    }
    this.#nextArrival = this.#rng.range(20, 50);
    this.#nextLeave = 0;
    Object.assign(this.#bar, openingBartender());
  }

  /** A "now" button stamps its slot with the scene clock: any change since the last frame fires. */
  #watchTriggers(triggers: readonly number[]): void {
    if (this.#fired(triggers, TRIGGER_COCKTAIL) && this.#serving) {
      this.#cocktail = true;
      this.#interrupt();
    }
    if (this.#fired(triggers, TRIGGER_ARRIVAL)) this.#arrive(true);
    if (this.#fired(triggers, TRIGGER_LAST_CALL)) this.#call();
    this.#seen.length = triggers.length;
    for (let slot = 0; slot < triggers.length; slot++) this.#seen[slot] = triggers[slot] ?? -1e4;
  }

  #fired(triggers: readonly number[], slot: number): boolean {
    const stamp = triggers[slot] ?? -1e4;
    return stamp !== (this.#seen[slot] ?? -1e4) && stamp > -1e3;
  }

  /** Last call is asked for: he rings it as soon as his hands are free (#think), or, with nobody behind the bar, it is called at once (frame). */
  #call(): void {
    this.#callPending = true;
    this.#callNight = this.#night;
    if (this.#serving) this.#interrupt();
  }

  /** Last call is called (the lights blink in the shader): everyone at the bar looks up and takes a last sip, and some order one for the road while there is someone to pour it. */
  #startCall(): void {
    const clock = this.#clock;
    this.#callPending = false;
    this.#callAt = clock;
    for (const [seat, patron] of this.#patrons.entries()) {
      if (patron.state !== "seated") continue;
      patron.turnTo = 0;
      patron.nextLook = clock + this.#rng.range(4, 9);
      patron.nextSip = Math.min(patron.nextSip, clock + this.#rng.range(2, 7));
      const drink = this.#drinks[seat];
      if (
        this.#serving &&
        drink &&
        drink.fill < 0.45 &&
        patron.wantsAt === Number.POSITIVE_INFINITY &&
        this.#rng.next() < ONE_FOR_THE_ROAD
      ) {
        patron.wantsAt = clock + this.#rng.range(3, 10);
        patron.leaveAt = Math.max(patron.leaveAt, clock + 90);
      }
    }
  }

  #endCall(): void {
    this.#callPending = false;
    this.#callAt = Number.NaN;
    this.#callNight = Number.NaN;
  }

  /**
   * The hands (every principal's): a press on the bar calls the bartender over; moving near the
   * candle bends its flame, the draughts of several hands adding.
   */
  #follow(frame: SimFrame): void {
    const pan = -Math.max(0, PAN_FROM - this.#aspect) * PAN_RATE;
    const dt = Math.max(0, frame.dt) * Math.max(0, frame.motion);
    const cx = (FOCAL * CANDLE_X) / CANDLE_Z;
    const cy = (FOCAL * (CANDLE_Y - TABLE_EYE)) / CANDLE_Z;
    let pushX = 0;
    let pushY = 0;
    for (let i = 0; i < MAX_PRINCIPALS; i++) {
      const hand = frame.principals[i];
      if (hand === undefined || !hand.inside) {
        this.#prevX[i] = Number.NaN;
        this.#prevY[i] = Number.NaN;
        continue;
      }
      const px = (hand.x - 0.5) * this.#aspect + pan;
      const py = hand.y - 0.5 - HORIZON;
      // The bar: from the counter top up to the shelves' bottles, right of the counter's end.
      if (hand.pressed && this.#serving && py > -0.12 && py < 0.12 && px > -0.34) {
        this.#visitX = clamp((px * BARTENDER_Z) / FOCAL, BARTENDER_MIN, BARTENDER_MAX);
        this.#interrupt();
      }
      const prevX = this.#prevX[i] ?? Number.NaN;
      if (dt > 0 && Number.isFinite(prevX)) {
        const d2 = (px - cx) ** 2 + (py - cy) ** 2;
        const near = Math.exp(-d2 / (2 * DRAUGHT_REACH * DRAUGHT_REACH));
        pushX += clamp(((px - prevX) / dt) * DRAUGHT_GAIN * near, -1, 1);
        pushY += clamp(((py - (this.#prevY[i] ?? py)) / dt) * DRAUGHT_GAIN * 0.6 * near, -1, 1);
      }
      this.#prevX[i] = px;
      this.#prevY[i] = py;
    }
    pushX = clamp(pushX, -1, 1);
    pushY = clamp(pushY, -1, 1);
    if (dt > 0) {
      this.#draftX = approach(
        this.#draftX,
        pushX,
        dt,
        Math.abs(pushX) > Math.abs(this.#draftX) ? DRAUGHT_LEAN : DRAUGHT_SETTLE,
      );
      this.#draftY = approach(
        this.#draftY,
        pushY,
        dt,
        Math.abs(pushY) > Math.abs(this.#draftY) ? DRAUGHT_LEAN : DRAUGHT_SETTLE,
      );
    }
  }

  /** Cut short whatever the bartender is doing, if his hands are free and it can wait: it eases to
   *  its end over the next 0.6 s, as every action does. */
  #interrupt(): void {
    const bar = this.#bar;
    const free =
      bar.act === ACT.idle ||
      bar.act === ACT.polish ||
      bar.act === ACT.wipe ||
      bar.act === ACT.chat ||
      bar.act === ACT.walk;
    if (!free || bar.carry !== CARRY.none) return;
    // Orders already planned go back on the waiting list.
    for (const step of this.#plan) {
      const patron = this.#patrons[step.seat];
      if (
        patron &&
        patron.state === "seated" &&
        patron.wantsAt === Number.POSITIVE_INFINITY &&
        (this.#drinks[step.seat]?.fill ?? -1) < 0.1
      )
        patron.wantsAt = this.#clock;
    }
    this.#plan.length = 0;
    bar.dur = Math.min(bar.dur, bar.age + 0.6);
  }

  /** Whether a step of the bartender's plan (or what he is doing) is for this seat. */
  #planned(seat: number): boolean {
    if (this.#bar.seat === seat) return true;
    for (const step of this.#plan) if (step.seat === seat) return true;
    return false;
  }

  #step(): void {
    this.#clock += STEP;
    const clock = this.#clock;
    for (let seat = 0; seat < SEATS; seat++) {
      const patron = this.#patrons[seat];
      if (patron) this.#stepPatron(patron, seat, clock);
    }
    this.#balance(clock);
    this.#talk();
    this.#stepBartender(clock);
  }

  /** Keep the room near its target: one new arrival at a time, one departure at a time. */
  #balance(clock: number): void {
    let present = 0;
    let moving = false;
    for (const patron of this.#patrons) {
      if (patron.state === "seated" || patron.state === "arriving" || patron.state === "sitting")
        present++;
      if (patron.state !== "empty" && patron.state !== "seated") moving = true;
    }
    const target = this.#target();
    // At closing time nobody new comes in (unless sent in with "now").
    if (present < target && clock >= this.#nextArrival && !moving && !Number.isFinite(this.#callAt))
      this.#arrive(false);
    if (present > target && clock >= this.#nextLeave) {
      let first: Patron | undefined;
      for (const patron of this.#patrons) {
        if (patron.state === "seated" && (!first || patron.leaveAt < first.leaveAt)) first = patron;
      }
      if (first && first.leaveAt > clock + 12) first.leaveAt = clock + this.#rng.range(3, 12);
      this.#nextLeave = clock + this.#rng.range(10, 25);
    }
  }

  /** Someone comes in at the door and heads for a free stool (now: even if the room is full enough). */
  #arrive(now: boolean): void {
    const free: number[] = [];
    this.#patrons.forEach((patron, seat) => {
      if (patron.state === "empty") free.push(seat);
    });
    if (free.length === 0) return;
    const seat = free[Math.floor(this.#rng.next() * free.length)] ?? 0;
    const patron = this.#patrons[seat];
    if (!patron) return;
    Object.assign(patron, blankPatron(), {
      state: "arriving",
      since: this.#clock,
      seed: 0.05 + 0.9 * this.#rng.next(),
      umbrella: this.#rain > 0.05 ? 1 : 0,
      wet: this.#rain > 0 ? 0.5 + 0.5 * this.#rain : 0,
    } satisfies Partial<Patron>);
    const gap = this.#rng.range(ARRIVAL_GAP[0], ARRIVAL_GAP[1]) * (1 + this.#lateness());
    this.#nextArrival = this.#clock + (now ? Math.max(gap, 25) : gap);
  }

  #stepPatron(patron: Patron, seat: number, clock: number): void {
    const stoolX = STOOL_X[seat] ?? 0;
    const drink = this.#drinks[seat];
    const age = clock - patron.since;
    switch (patron.state) {
      case "empty":
        return;
      case "arriving": {
        const step = Math.min(PATRON_PACE * STEP, stoolX - patron.x);
        patron.x += step;
        patron.stride += Math.abs(step);
        patron.facingTo = 1;
        if (stoolX - patron.x < 1e-3) this.#enter(patron, "sitting", clock);
        break;
      }
      case "sitting": {
        const u = clamp(age / SIT_TIME, 0, 1);
        patron.z = WALK_Z + (STOOL_Z - WALK_Z) * smoothstep(0, 0.6, u);
        patron.sit = smoothstep(0.25, 1, u);
        patron.facingTo = u < 0.15 ? 1 : 0;
        if (u >= 1) {
          this.#enter(patron, "seated", clock);
          patron.leaveAt = clock + this.#stay();
          patron.nextLook = clock + this.#rng.range(3, 10);
          patron.nextSip = clock + this.#rng.range(15, 30);
          // A newcomer orders a drink of their own; the glass left on this spot gets cleared first.
          patron.wantsAt = clock;
        }
        break;
      }
      case "seated":
        this.#seatedLife(patron, seat, clock);
        break;
      case "rising": {
        const u = clamp(age / SIT_TIME, 0, 1);
        patron.z = STOOL_Z + (WALK_Z - STOOL_Z) * smoothstep(0.4, 1, u);
        patron.sit = 1 - smoothstep(0, 0.75, u);
        patron.facingTo = u > 0.7 ? -1 : 0;
        patron.turnTo = 0;
        if (u >= 1) this.#enter(patron, "leaving", clock);
        break;
      }
      case "leaving": {
        patron.x -= PATRON_PACE * STEP;
        patron.stride += PATRON_PACE * STEP;
        patron.facingTo = -1;
        if (patron.x <= DOOR_X) {
          Object.assign(patron, blankPatron());
          this.#nextArrival = Math.max(
            this.#nextArrival,
            clock + this.#rng.range(ARRIVAL_GAP[0], ARRIVAL_GAP[1]) * (1 + this.#lateness()),
          );
        }
        break;
      }
      default: {
        const never: never = patron.state;
        throw new BarSimError(`bar: unknown patron state ${String(never)}`);
      }
    }
    patron.facing = approach(patron.facing, patron.facingTo, STEP, FACE_TIME);
    patron.turn = approach(patron.turn, patron.turnTo, STEP, TURN_TIME);
    patron.wet = Math.max(0, patron.wet - STEP / COAT_DRY);
    if (patron.state !== "seated") patron.talk = approach(patron.talk, 0, STEP, TALK_TIME * 0.5);
    if (drink && patron.state === "rising" && drink.fill > -0.5) drink.abandoned = true;
  }

  #enter(patron: Patron, state: PatronState, clock: number): void {
    patron.state = state;
    patron.since = clock;
  }

  /** Looking about, sipping, wanting another, and getting up to go. */
  #seatedLife(patron: Patron, seat: number, clock: number): void {
    const drink = this.#drinks[seat];
    const sipping = clock - patron.sipAt < SIP_TIME;
    if (clock >= patron.nextLook) {
      const r = this.#rng.next();
      const left = this.#patrons[seat - 1]?.state === "seated";
      const right = this.#patrons[seat + 1]?.state === "seated";
      if (r < LOOK_NEIGHBOUR && (left || right))
        patron.turnTo = left && (!right || this.#rng.next() < 0.5) ? -1 : 1;
      else if (r < LOOK_NEIGHBOUR + LOOK_WINDOW) patron.turnTo = -1.4;
      else patron.turnTo = (this.#rng.next() - 0.5) * 0.3;
      patron.nextLook = clock + this.#rng.range(LOOK_GAP[0], LOOK_GAP[1]);
    }
    // Being served: they face the bartender.
    if (this.#bar.seat === seat && this.#bar.act === ACT.chat) patron.turnTo = 0;
    if (
      drink &&
      drink.fill > 0.05 &&
      !drink.abandoned &&
      !sipping &&
      clock >= patron.nextSip &&
      !this.#planned(seat)
    ) {
      patron.sipAt = clock;
      patron.sipDrunk = false;
      patron.turnTo = 0;
      patron.nextSip = clock + SIP_TIME + this.#rng.range(SIP_GAP[0], SIP_GAP[1]);
    }
    if (!patron.sipDrunk && clock - patron.sipAt > SIP_TIME * 0.5 && drink && drink.fill > -0.5) {
      drink.fill = Math.max(0.02, drink.fill - this.#rng.range(SIP_DRINK[0], SIP_DRINK[1]));
      patron.sipDrunk = true;
      if (
        drink.fill < 0.1 &&
        patron.leaveAt - clock > 50 &&
        patron.wantsAt === Number.POSITIVE_INFINITY
      )
        patron.wantsAt = clock + this.#rng.range(4, 15);
    }
    if (clock >= patron.leaveAt && !sipping && !this.#planned(seat)) {
      this.#enter(patron, "rising", clock);
      patron.wantsAt = Number.POSITIVE_INFINITY;
    }
  }

  /** Neighbours both turned to each other are talking: their heads nod and tilt in the shader. */
  #talk(): void {
    for (let seat = 0; seat < SEATS; seat++) {
      const patron = this.#patrons[seat];
      if (!patron) continue;
      const left = this.#patrons[seat - 1];
      const right = this.#patrons[seat + 1];
      const withLeft =
        patron.turnTo < -0.5 &&
        patron.turnTo > -1.2 &&
        left?.state === "seated" &&
        left.turnTo > 0.5;
      const withRight =
        patron.turnTo > 0.5 &&
        right?.state === "seated" &&
        right.turnTo < -0.5 &&
        right.turnTo > -1.2;
      const talking = patron.state === "seated" && (withLeft || withRight);
      patron.talk = approach(patron.talk, talking ? 1 : 0, STEP, TALK_TIME);
    }
  }

  #stepBartender(clock: number): void {
    const bar = this.#bar;
    bar.age += STEP;
    if (bar.act === ACT.walk) {
      const dx = bar.target - bar.x;
      const step = Math.sign(dx) * Math.min(Math.abs(dx), BARTENDER_PACE * STEP);
      bar.x += step;
      if (Math.abs(bar.target - bar.x) < 1e-3) bar.age = Math.max(bar.age, bar.dur);
    }
    this.#moments();
    if (bar.age >= bar.dur) this.#next(clock);

    // Where he looks: at whoever he is serving or chatting with (straight ahead, across the counter),
    // at you when he comes over, otherwise now and then along the bar or out at the rain.
    if (
      bar.act === ACT.chat ||
      bar.act === ACT.pour ||
      bar.act === ACT.strain ||
      bar.act === ACT.clear ||
      bar.act === ACT.bell
    )
      bar.lookTo = 0;
    else if (clock >= bar.nextLook) {
      const r = this.#rng.next();
      bar.lookTo = r < 0.2 ? -1 : r < 0.55 ? (this.#rng.next() - 0.5) * 1.2 : 0;
      bar.nextLook = clock + this.#rng.range(4, 14);
    }
    bar.look = approach(bar.look, bar.lookTo, STEP, TURN_TIME);
    bar.attend = approach(bar.attend, bar.act === ACT.chat && bar.seat < 0 ? 1 : 0, STEP, 0.6);
  }

  /** What happens at fixed moments inside an action: bottles taken and returned, glasses set down, filled and cleared. */
  #moments(): void {
    const bar = this.#bar;
    const drink = this.#drinks[bar.seat];
    switch (bar.act) {
      case ACT.fetch:
        if (bar.age >= FETCH_GRAB && bar.carry === CARRY.none) {
          bar.carry = CARRY.bottle;
          bar.taken = slotBehind(bar.x);
        }
        break;
      case ACT.put:
        if (bar.age >= PUT_RELEASE && bar.carry === CARRY.bottle) {
          bar.carry = CARRY.none;
          bar.taken = -1;
        }
        break;
      case ACT.pour:
        if (drink && bar.age >= POUR_SET && (drink.fill < -0.5 || drink.abandoned)) {
          Object.assign(drink, {
            fill: 0,
            kind: this.#pourKind,
            source: bar.taken,
            abandoned: false,
          } satisfies Partial<Drink>);
        }
        if (drink && drink.fill > -0.5 && bar.age > POUR_FLOW[0])
          drink.fill = Math.max(
            drink.fill,
            bar.pourTo * smoothstep(POUR_FLOW[0], POUR_FLOW[1], bar.age),
          );
        break;
      case ACT.shake:
        bar.carry = CARRY.shaker;
        break;
      case ACT.strain:
        if (drink && bar.age >= STRAIN_SET && (drink.fill < -0.5 || drink.abandoned)) {
          Object.assign(drink, {
            fill: 0,
            kind: GLASS.coupe,
            source: -1,
            abandoned: false,
          } satisfies Partial<Drink>);
        }
        if (drink && drink.fill > -0.5 && bar.age > STRAIN_FLOW[0])
          drink.fill = Math.max(
            drink.fill,
            bar.pourTo * smoothstep(STRAIN_FLOW[0], STRAIN_FLOW[1], bar.age),
          );
        if (bar.age >= bar.dur - 0.4) bar.carry = CARRY.none;
        break;
      case ACT.clear:
        if (drink && bar.age >= CLEAR_TAKE && drink.fill > -0.5) {
          drink.fill = -1;
          drink.abandoned = false;
          bar.carry = CARRY.glass;
        }
        if (bar.age >= bar.dur - 0.3) bar.carry = CARRY.none;
        break;
      case ACT.idle:
      case ACT.polish:
      case ACT.walk:
      case ACT.chat:
      case ACT.wipe:
      case ACT.bell:
        break;
      default: {
        const never: never = bar.act;
        throw new BarSimError(`bar: unknown action ${String(never)}`);
      }
    }
  }

  /** Start the next step of the plan, planning anew when it runs out. */
  #next(clock: number): void {
    const bar = this.#bar;
    if (this.#plan.length === 0) this.#think(clock);
    const step = this.#plan.shift() ?? { act: ACT.idle, dur: 3, x: bar.x, seat: -1 };
    bar.act = step.act;
    bar.age = 0;
    bar.seat = step.seat;
    bar.target = step.x;
    bar.dur =
      step.act === ACT.walk
        ? Math.max(0.6, Math.abs(step.x - bar.x) / BARTENDER_PACE + 0.3)
        : step.dur;
    if (step.act === ACT.pour || step.act === ACT.strain)
      bar.pourTo = 0.72 + 0.18 * this.#rng.next();
    if (step.act === ACT.bell) this.#startCall();
  }

  /** Decide what comes next: you, an order, a glass to clear, or something to do meanwhile. */
  #think(clock: number): void {
    const bar = this.#bar;
    const plan = this.#plan;
    const walkTo = (x: number): void => {
      const to = clamp(x, BARTENDER_MIN, BARTENDER_MAX);
      if (Math.abs(to - bar.x) > 0.05) plan.push({ act: ACT.walk, dur: 0, x: to, seat: -1 });
    };
    if (!this.#serving) {
      plan.push({ act: ACT.idle, dur: 4, x: bar.x, seat: -1 });
      return;
    }
    if (this.#callPending) {
      plan.push({ act: ACT.bell, dur: BELL_TIME, x: bar.x, seat: -1 });
      // Nobody at the bar to call it to: he comes over to you.
      if (!this.#patrons.some((patron) => patron.state === "seated")) {
        walkTo(YOUR_END);
        plan.push({ act: ACT.chat, dur: 6, x: YOUR_END, seat: -1 });
      }
      return;
    }
    if (Number.isFinite(this.#visitX)) {
      walkTo(this.#visitX);
      plan.push({ act: ACT.chat, dur: 6, x: this.#visitX, seat: -1 });
      this.#visitX = Number.NaN;
      return;
    }
    // An order: whoever has waited longest (a few seconds at least).
    let order = -1;
    this.#patrons.forEach((patron, seat) => {
      if (patron.state !== "seated" || clock - patron.wantsAt < 3) return;
      if (order < 0 || patron.wantsAt < (this.#patrons[order]?.wantsAt ?? 0)) order = seat;
    });
    if (this.#cocktail) {
      this.#cocktail = false;
      let nearest = -1;
      this.#patrons.forEach((patron, seat) => {
        if (
          patron.state === "seated" &&
          (nearest < 0 || Math.abs(pourX(seat) - bar.x) < Math.abs(pourX(nearest) - bar.x))
        )
          nearest = seat;
      });
      const seat = order >= 0 ? order : nearest;
      if (seat >= 0) {
        this.#serve(seat, true);
        return;
      }
      plan.push(
        { act: ACT.shake, dur: 5, x: bar.x, seat: -1 },
        { act: ACT.strain, dur: 3.2, x: bar.x, seat: -1 },
      );
      return;
    }
    if (order >= 0) {
      this.#serve(order, this.#rng.next() < 0.35);
      return;
    }
    // A glass left behind by someone who has gone.
    const stale = this.#drinks.findIndex(
      (drink, seat) =>
        drink.fill > -0.5 && (drink.abandoned || this.#patrons[seat]?.state === "empty"),
    );
    if (stale >= 0) {
      walkTo(pourX(stale));
      plan.push(
        { act: ACT.clear, dur: 2.2, x: bar.x, seat: stale },
        { act: ACT.wipe, dur: this.#rng.range(4, 7), x: bar.x, seat: -1 },
      );
      return;
    }
    // Meanwhile: polishing, wiping (more toward last call), a stroll along the bar, a word with someone.
    const r = this.#rng.next();
    const wipe = 0.12 + 0.55 * smoothstep(0.5, 1, this.#lateness());
    const seated: number[] = [];
    this.#patrons.forEach((patron, seat) => {
      if (patron.state === "seated") seated.push(seat);
    });
    if (r < wipe) {
      if (this.#rng.next() < 0.5)
        walkTo(BARTENDER_MIN + (BARTENDER_MAX - BARTENDER_MIN) * this.#rng.next());
      plan.push({ act: ACT.wipe, dur: this.#rng.range(6, 12), x: bar.x, seat: -1 });
    } else if (r < wipe + 0.15 && seated.length > 0) {
      const seat = seated[Math.floor(this.#rng.next() * seated.length)] ?? 0;
      walkTo(pourX(seat));
      plan.push({ act: ACT.chat, dur: this.#rng.range(6, 12), x: bar.x, seat });
    } else if (r < wipe + 0.3) {
      walkTo(BARTENDER_MIN + (BARTENDER_MAX - BARTENDER_MIN) * this.#rng.next());
      plan.push({ act: ACT.idle, dur: this.#rng.range(4, 9), x: bar.x, seat: -1 });
    } else {
      plan.push({ act: ACT.polish, dur: this.#rng.range(10, 24), x: bar.x, seat: -1 });
    }
  }

  /** Serve a seat: walk over, take the order, pour from a bottle or shake a cocktail. */
  #serve(seat: number, cocktail: boolean): void {
    const plan = this.#plan;
    const patron = this.#patrons[seat];
    const drink = this.#drinks[seat];
    if (!patron || !drink) return;
    patron.wantsAt = Number.POSITIVE_INFINITY;
    const x = pourX(seat);
    if (Math.abs(x - this.#bar.x) > 0.05) plan.push({ act: ACT.walk, dur: 0, x, seat: -1 });
    if (drink.fill > -0.5) plan.push({ act: ACT.clear, dur: 2.2, x, seat });
    plan.push({ act: ACT.chat, dur: this.#rng.range(2.5, 4), x, seat });
    if (cocktail) {
      plan.push({ act: ACT.shake, dur: 5, x, seat }, { act: ACT.strain, dur: 3.2, x, seat });
    } else {
      // The glass suits what he pours: a tumbler, a wine glass or a highball (set down at the pour).
      const kinds = [GLASS.tumbler, GLASS.wine, GLASS.highball] as const;
      this.#pourKind = kinds[Math.floor(this.#rng.next() * kinds.length)] ?? GLASS.tumbler;
      plan.push(
        { act: ACT.fetch, dur: 2.6, x, seat },
        { act: ACT.pour, dur: 4, x, seat },
        { act: ACT.put, dur: 2.4, x, seat },
      );
    }
  }

  #put(texel: number, a: number, b: number, c: number, e: number): void {
    const d = this.#data;
    d[texel * 4] = a;
    d[texel * 4 + 1] = b;
    d[texel * 4 + 2] = c;
    d[texel * 4 + 3] = e;
  }

  #upload(): void {
    const bar = this.#bar;
    this.#put(0, bar.x, bar.act, Math.min(bar.age, 60), Math.min(bar.dur, 60));
    this.#put(1, bar.carry, bar.taken, bar.look, bar.attend);
    const clock = this.#clock;
    for (let seat = 0; seat < SEATS; seat++) {
      const patron = this.#patrons[seat];
      const drink = this.#drinks[seat];
      if (!patron || !drink) continue;
      const sipU = clamp((clock - patron.sipAt) / SIP_TIME, 0, 1);
      const sip = smoothstep(0, 0.3, sipU) * (1 - smoothstep(0.7, 1, sipU));
      this.#put(2 + seat, patron.x, patron.z, patron.sit, (patron.stride % GAIT) / GAIT);
      this.#put(
        6 + seat,
        patron.state === "empty" ? 0 : patron.seed,
        patron.facing,
        patron.turn,
        sip,
      );
      this.#put(10 + seat, patron.talk, patron.umbrella, patron.wet, 0);
      this.#put(14 + seat, drink.fill, drink.kind, drink.x, drink.source);
    }
    this.#put(
      18,
      this.#draftX,
      this.#draftY,
      this.#fanAngle,
      Number.isFinite(this.#callAt) ? Math.min(this.#clock - this.#callAt, 60) : -1,
    );
    this.#texture.upload(this.#data);
  }
}

/** The bar's simulation for a scene whose knobs are `params` (looked up by key). */
export function barSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new BarEvening(gl, params);
}
