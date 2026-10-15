// A kerbside errand: a vehicle pulls in at its stop, puts its hazards on, and a porter carries loads
// between it and a door in trips (loading at the vehicle, setting the load down inside), then climbs
// back in and the vehicle leaves. A late-night konbini delivery, a brewer's keg drop at a bar, a
// porter's parcel trolley between a train's luggage van and the station house, a milk cart at a farm
// gate.
//
// This is the choreography only. The scene owns the space: it drives the vehicle (its own lanes,
// car following, pulling in and out), walks the porter (its own crowd model, avoiding people and
// being avoided), draws both, and tells the errand when each has got where it was going. The errand
// says what happens next: where the porter heads, what it carries, how long it stands there, and
// whether the hazards are on. Deterministic for the draws it is given; its seconds are the scene's
// simulated (motion-scaled) seconds.
//
//   const errand = new Errand();
//   errand.start(random, { trips: [3, 5] });   // random: anything with range(lo, hi)
//   each step, before moving the porter:
//     errand.step(dt, { parked, porterThere });  // parked: the vehicle stands at its stop;
//                                                // porterThere: the porter is at errand.goal
//   errand.stage      "idle" | "arriving" | "unloading" | "leaving"
//   errand.porterOut  the porter is out on foot (the scene spawns it as this turns true, at the
//                     vehicle, and takes it away as it turns false)
//   errand.goal       where the porter is heading or standing: "vehicle" (its back), "door", "cab"
//   errand.dwell      seconds it still stands at the goal (0 while it walks)
//   errand.load       loads on its trolley now (0 walking back empty)
//   errand.hazards    hazard lights: on from parking until the porter is back in
//   errand.stop()     back to idle: the scene reports the vehicle gone, or abandons the episode (a
//                     fresh layout)

export type ErrandStage = "idle" | "arriving" | "unloading" | "leaving";
export type ErrandGoal = "vehicle" | "door" | "cab";

export interface ErrandPlan {
  /** Trips between the vehicle and the door: least and most. */
  readonly trips: readonly [number, number];
  /** Loads per trip: least and most. */
  readonly loads: readonly [number, number];
  /** Seconds to load the trolley at the vehicle, to set the load down inside, to shut up and climb in. */
  readonly loadSeconds: number;
  readonly dropSeconds: number;
  readonly closeSeconds: number;
}

export const ERRAND_PLAN: ErrandPlan = {
  trips: [3, 5],
  loads: [2, 3],
  loadSeconds: 3,
  dropSeconds: 4.5,
  closeSeconds: 2.5,
};

/** Where an errand gets its dice: a seeded generator with range(lo, hi). */
export interface ErrandRandom {
  range(lo: number, hi: number): number;
}

export interface ErrandReport {
  /** The vehicle stands at its stop. */
  readonly parked: boolean;
  /** The porter has reached `goal`. */
  readonly porterThere: boolean;
}

export class ErrandError extends Error {}

export class Errand {
  stage: ErrandStage = "idle";
  goal: ErrandGoal = "vehicle";
  porterOut = false;
  dwell = 0;
  load = 0;
  /** Trips still to make after the one under way. */
  tripsLeft = 0;
  #plan: ErrandPlan = ERRAND_PLAN;
  #random: ErrandRandom | undefined;

  get hazards(): boolean {
    return this.stage === "unloading";
  }

  /** A new episode: the vehicle sets out for its stop. */
  start(random: ErrandRandom, plan: Partial<ErrandPlan> = {}): void {
    this.#plan = { ...ERRAND_PLAN, ...plan };
    const [least, most] = this.#plan.trips;
    if (least < 1 || most < least)
      throw new ErrandError(`errand: trips must be 1 or more, least first (got ${least}..${most})`);
    this.#random = random;
    this.stage = "arriving";
    this.goal = "vehicle";
    this.porterOut = false;
    this.dwell = 0;
    this.load = 0;
    this.tripsLeft = Math.floor(random.range(least, most + 1 - 1e-9)) - 1;
  }

  step(dt: number, report: ErrandReport): void {
    const plan = this.#plan;
    if (this.stage === "arriving") {
      if (!report.parked) return;
      // Parked: the porter gets out at the back and starts loading.
      this.stage = "unloading";
      this.porterOut = true;
      this.goal = "vehicle";
      this.dwell = plan.loadSeconds;
      return;
    }
    if (this.stage !== "unloading" || !report.porterThere) return;
    if (this.dwell > 0) {
      this.dwell = Math.max(0, this.dwell - dt);
      if (this.dwell > 0) return;
      this.#done();
      return;
    }
    // Just got there: stand for as long as the job takes.
    this.dwell =
      this.goal === "vehicle"
        ? plan.loadSeconds
        : this.goal === "door"
          ? plan.dropSeconds
          : plan.closeSeconds;
  }

  stop(): void {
    this.stage = "idle";
    this.porterOut = false;
    this.dwell = 0;
    this.load = 0;
    this.tripsLeft = 0;
  }

  /** The job at the goal is done: on to the next. */
  #done(): void {
    const random = this.#random;
    if (!random) throw new ErrandError("errand: stepped before it was started");
    switch (this.goal) {
      case "vehicle": {
        const [least, most] = this.#plan.loads;
        this.load = Math.floor(random.range(least, most + 1 - 1e-9));
        this.goal = "door";
        break;
      }
      case "door":
        this.load = 0;
        if (this.tripsLeft > 0) {
          this.tripsLeft--;
          this.goal = "vehicle";
        } else {
          this.goal = "cab";
        }
        break;
      case "cab":
        this.porterOut = false;
        this.stage = "leaving";
        break;
      default: {
        const unreachable: never = this.goal;
        throw new ErrandError(`errand: unknown goal ${String(unreachable)}`);
      }
    }
  }
}
