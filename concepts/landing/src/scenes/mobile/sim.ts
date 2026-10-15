// The mobile's simulation: the solar system (solar.ts) hung on the shared mobile (sims/mobile.ts)
// under the Sun, its arms turned by motors at the planets' real periods, swung and rocked by the
// room's slow air, a draft from the window and its gusts (sims/wind.ts), and blown on by the pointer.
//
// The motor (K_motor): each arm's motor turns it once per orbital period of its planet, au^1.5 years
// (Kepler's third law), the Moon's once a sidereal month; its amount sets how many seconds of the
// motion clock make a year. The arms still swing, rock and knock in the air, and a gust can set an
// arm back for a moment before its motor catches up (sims/mobile.ts `drive`).
//
// The air at a ball: the draft (K_wind, along x), a gust front crossing the room the way the draft
// blows (a GustTrain, its pulse reaching each ball as the front passes, with a share toward or away
// from the wall drawn per gust), and eddies: smooth noise in time that varies across the room
// (K_drift).
//
// Time: the mobile steps on the motion clock (dt × motion). A "now" gust, or a planet blown on, plays
// even at motion 0: the mobile then runs in real time for a while, easing to a stop.
//
// The passage: the mobile (and the Sun it hangs from) is drawn lowered from above on its cord
// (entrance) and hoisted back up (exit) by a pose applied as it is packed; on the exit the motors
// also wind down. At rest nothing differs: the pose is not applied and the motors run at their rate.
//
// Texture: uSim0, the MobileTexture (layout in the sims/mobile.ts header).
import { KnobReader, type ParamDef } from "../../params.ts";
import { smoothstep } from "../../sims/math.ts";
import {
  Mobile,
  MOBILE_SUBSTEP,
  MobileTexture,
  type MobileAir,
  type MobilePose,
} from "../../sims/mobile.ts";
import { Random } from "../../sims/random.ts";
import { GustTrain, windNoise } from "../../sims/wind.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";
import {
  MOBILE_SUN_CENTRE,
  MOBILE_EYE,
  MOBILE_HOIST,
  MOBILE_LOWER,
  MOBILE_TEX_ORIGIN,
  mobileRay,
} from "./layout.ts";
import { solarMobile, type SolarMobile } from "./solar.ts";

type Knob = "planets" | "clearance" | "motor" | "wind" | "gusts" | "drift";
const KNOBS: readonly Knob[] = ["planets", "clearance", "motor", "wind", "gusts", "drift"];

/**
 * Seconds of the motion clock the motor takes over the Earth's year at speed s (its amount, 0..1):
 * 36 at the middle, half that at full speed (the Moon then goes round in under a second and a half),
 * nearly twice as long at the slowest.
 */
export function mobileYear(speed: number): number {
  return 36 * 4 ** (0.5 - speed);
}

/** Substeps a fresh mobile settles for before it is drawn (2 s): the motors are near their rate. */
const SETTLE = Math.round(2 / MOBILE_SUBSTEP);

/** The draft's speed (m/s) at wind ±1. */
const DRAFT = 1.2;
/** A gust's peak speed (m/s) at full power, its rise (s), and the front: where it starts upwind (m) and how fast it crosses (m/s). */
const GUST_SPEED = 2.6;
const GUST_RISE = 1.4;
const FRONT_FROM = 1.8;
const FRONT_SPEED = 2.2;
/** Seconds to the first gust on its own, and the seed of the gusts' draws. */
const FIRST_GUST = 14;
const GUST_SEED = 0x736f6c61;
/** The eddies' speed (m/s) at drift 1, their periods (s) along x, y and z, and how fast they change across the room (per m). */
const EDDY = 1.2;
const EDDY_PERIOD = [7.3, 9.1, 8.2] as const;
const EDDY_SPAN = 2.5;
/** How hard a click blows on a planet (m/s along the view), and how near the ray it must pass (m). */
const PUFF = 0.6;
const PUFF_SLACK = 0.03;
/** Seconds a "now" or a puff keeps the mobile moving at motion 0, the last of them easing to a stop. */
const BUSY = 14;
const BUSY_EASE = 4;

/** Mean seconds between gusts for the gusts' amount 0..1 (autumn's pacing). */
function gustMean(amount: number): number {
  return 45 / (0.4 + 1.2 * Math.min(1, Math.max(0, amount)));
}

class MobileSim implements SceneSim {
  readonly #knobs: KnobReader<Knob>;
  readonly #gustSlot: number;
  readonly #texture: MobileTexture;
  readonly #textures: readonly WebGLTexture[];
  readonly #random = new Random();
  #mobile: Mobile | undefined;
  #solar: SolarMobile | undefined;
  #key = "";
  #gusts = new GustTrain(() => 0, GUST_RISE, FIRST_GUST);
  /** The latest gust's share across the room (toward the viewer +). */
  #gustZ = 0;
  #wind = 0;
  #drift = 0;
  /** Seconds a "now" or a puff keeps the mobile moving at motion 0. */
  #busy = 0;

  /** The air at a ball now (see the header); reads the mobile's own clock, so it is the same at every frame rate. */
  readonly #air: MobileAir = (x, y, z, out) => {
    const t = this.#mobile?.system.time ?? 0;
    const gusts = this.#gusts;
    const gust = GUST_SPEED * gusts.strength((gusts.sign * x + FRONT_FROM) / FRONT_SPEED);
    const eddy = EDDY * this.#drift;
    out[0] = DRAFT * this.#wind + gust + eddy * windNoise(t / EDDY_PERIOD[0] + EDDY_SPAN * x, 11);
    out[1] = 0.3 * eddy * windNoise(t / EDDY_PERIOD[1] + 1.3 * y, 12);
    out[2] =
      Math.abs(gust) * this.#gustZ +
      eddy * windNoise(t / EDDY_PERIOD[2] + EDDY_SPAN * z + 0.6 * x, 13);
  };

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#knobs = new KnobReader("mobile", params, KNOBS);
    this.#gustSlot = this.#knobs.trigger("gusts");
    this.#texture = new MobileTexture(gl, MOBILE_TEX_ORIGIN);
    this.#textures = [this.#texture.texture];
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const knobs = this.#knobs;
    this.#wind = knobs.value(frame, "wind");
    this.#drift = knobs.value(frame, "drift");
    const enter = Math.min(1, Math.max(0, frame.passage.enter));
    const exit = Math.min(1, Math.max(0, frame.passage.exit));
    const passing = enter < 1 || exit > 0;
    const motor = knobs.value(frame, "motor");
    const mobile = this.#build(frame, motor);
    // On the way out the motors wind down, ever faster, until the exit ends.
    this.#drive(mobile, motor, exit > 0 ? 1 - exit * exit : 1);
    const gusts = knobs.value(frame, "gusts");
    const power = 0.55 + 0.45 * knobs.amount(frame, "gusts");
    const mean = gustMean(knobs.amount(frame, "gusts"));
    if (frame.fired[this.#gustSlot] === true) {
      this.#startGust(power, mean);
      this.#busy = BUSY;
    }
    if (!passing && frame.pointer.pressed && frame.pointer.inside) this.#puff(mobile, frame);

    // At motion 0 a "now" or a puff still plays, in real time, easing to a stop.
    this.#busy = Math.max(0, this.#busy - frame.dt);
    const pace = frame.motion > 0 ? frame.motion : smoothstep(0, BUSY_EASE, this.#busy);
    const dt = frame.dt * pace;
    if (dt > 0 && this.#gusts.step(dt, gusts > 0 ? mean : Infinity, this.#wind, power))
      this.#gustZ = (this.#random.next() - 0.5) * 0.8;
    mobile.step(dt, this.#air);

    this.#texture.upload(mobile, passing ? this.#pose(enter, exit) : undefined);
    return this.#textures;
  }

  dispose(): void {
    this.#texture.dispose();
  }

  /** The mobile for the knobs: rebuilt (and its air and gusts started afresh) when its layout changes. */
  #build(frame: SimFrame, motor: number): Mobile {
    const knobs = this.#knobs;
    const planets = Math.round(knobs.value(frame, "planets"));
    const clearance = knobs.value(frame, "clearance");
    const key = `${planets}|${clearance}`;
    if (this.#mobile !== undefined && key === this.#key) return this.#mobile;
    this.#key = key;
    this.#random.seed(GUST_SEED);
    const next = this.#random.next();
    this.#gusts = new GustTrain(
      () => this.#random.next(),
      GUST_RISE,
      FIRST_GUST * (0.8 + 0.4 * next),
    );
    this.#gustZ = 0;
    this.#busy = 0;
    const solar = solarMobile(planets, clearance, MOBILE_SUN_CENTRE);
    const mobile = new Mobile(solar.design);
    this.#solar = solar;
    this.#mobile = mobile;
    this.#drive(mobile, motor, 1);
    mobile.settle(SETTLE, this.#air);
    return mobile;
  }

  /** Each arm's motor at its period for the motor's speed (`motor`: 0 off), times `share`. */
  #drive(mobile: Mobile, motor: number, share: number): void {
    const year = mobileYear(motor);
    this.#solar?.arms.forEach((arm, k) =>
      mobile.drive(k, motor > 0 ? ((2 * Math.PI) / (arm.years * year)) * share : Number.NaN),
    );
  }

  #startGust(power: number, mean: number): void {
    this.#gusts.start(this.#wind, power, mean);
    this.#gustZ = (this.#random.next() - 0.5) * 0.8;
  }

  /** A click blows on the planet under the pointer, along the view. */
  #puff(mobile: Mobile, frame: SimFrame): void {
    const rd = mobileRay(
      (frame.pointer.x - 0.5) * frame.aspect,
      frame.pointer.y - 0.5,
      frame.aspect,
    );
    const body = mobile.pick(MOBILE_EYE, rd, PUFF_SLACK);
    if (body < 0) return;
    mobile.kick(body, rd[0] * PUFF, rd[1] * PUFF, rd[2] * PUFF);
    this.#busy = BUSY;
  }

  /**
   * The passage's pose. Entrance: lowered from MOBILE_LOWER above its place on the Sun's cord, slowing
   * to a stop at 70% of the way and bobbing once on the cord's give. Exit: hoisted MOBILE_HOIST up and
   * out of the frame, gathering speed. Both exactly still at rest.
   */
  #pose(enter: number, exit: number): MobilePose {
    let lift = 0;
    if (enter < 1) {
      const x = Math.min(1, enter / 0.7);
      const bob = enter > 0.7 ? (enter - 0.7) / 0.3 : 0;
      lift = MOBILE_LOWER * (1 - x) ** 3 - 0.03 * Math.sin(Math.PI * 2 * bob) * (1 - bob);
    }
    if (exit > 0) lift += MOBILE_HOIST * exit * exit * exit;
    return { lift, swing: 0 };
  }
}

/** The mobile's simulation for a scene whose knobs are `params` (looked up by key). */
export function mobileSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new MobileSim(gl, params);
}
