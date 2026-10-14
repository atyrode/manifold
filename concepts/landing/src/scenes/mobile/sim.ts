// The mobile's simulation: a Calder mobile (sims/mobile.ts) hanging in a quiet room, turned by the
// room's slow air, a draft from the window and its gusts (sims/wind.ts), and blown on by the pointer.
//
// The air at a plate: the draft (K_wind, along x), a gust front crossing the room the way the draft
// blows (a GustTrain, its pulse reaching each plate as the front passes, with a share toward or away
// from the wall drawn per gust), and eddies: smooth noise in time that varies across the room, so
// neighbouring arms are pushed a little differently and the mobile keeps turning even when the
// window is still (K_drift).
//
// Time: the mobile steps on the motion clock (dt × motion). A "now" gust, or a plate blown on, plays
// even at motion 0: the mobile then runs in real time for a while, easing to a stop.
//
// The passage: the mobile is drawn lowered from the ceiling on its link (entrance) and hoisted back
// up (exit) by a pose applied as it is packed; its simulation is untouched, so at rest nothing
// differs.
//
// Texture: uSim0, the MobileTexture (layout in the sims/mobile.ts header).
import { KnobReader, type ParamDef } from "../../params.ts";
import { smoothstep } from "../../sims/math.ts";
import { designMobile, Mobile, MOBILE_SETTLE, MobileTexture, type MobileAir, type MobilePose } from "../../sims/mobile.ts";
import { Random } from "../../sims/random.ts";
import { GustTrain, windNoise } from "../../sims/wind.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";
import { MOBILE_ANCHOR, MOBILE_EYE, MOBILE_HOIST, MOBILE_LOWER, MOBILE_PASSAGE, MOBILE_SPAN, MOBILE_TEX_ORIGIN, MOBILE_TOP_LINK, mobileRay } from "./layout.ts";

type Knob = "arms" | "shapes" | "clearance" | "mobileSeed" | "wind" | "gusts" | "drift";
const KNOBS: readonly Knob[] = ["arms", "shapes", "clearance", "mobileSeed", "wind", "gusts", "drift"];

/** The plate outlines each `shapes` choice draws from (indices into MOBILE_SHAPES): leaves, discs, all. */
export const MOBILE_SHAPE_SETS: readonly (readonly number[])[] = [[1, 2, 3], [0], [0, 1, 2, 3]];

/**
 * The draft's speed (m/s) at wind ±1. A steady draft barely leans a balanced mobile (0.2° at full
 * draft) but the plates' differing turns catch it unevenly: at full draft the arms turn about three
 * times as fast as in still air.
 */
const DRAFT = 1.2;
/** A gust's peak speed (m/s) at full power, its rise (s), and the front: where it starts upwind (m) and how fast it crosses (m/s). */
const GUST_SPEED = 2.4;
const GUST_RISE = 1.4;
const FRONT_FROM = 1.8;
const FRONT_SPEED = 2.2;
/** Seconds to the first gust on its own. */
const FIRST_GUST = 14;
/**
 * The eddies' speed (m/s) at drift 1, their periods (s) along x, y and z, and how fast they change
 * across the room (per m). Uniform air hardly turns a balanced arm (its plates' drag balances about
 * the loop just as their weight does), so it is the difference between neighbouring plates' air
 * that turns the arms: at drift 0.5 most arms turn 2-5° a second.
 */
const EDDY = 1.2;
const EDDY_PERIOD = [7.3, 9.1, 8.2] as const;
const EDDY_SPAN = 2.5;
/** How hard a click blows on a plate (m/s along the view), and how near the ray it must pass (m). */
const PUFF = 0.5;
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
  #key = "";
  #gusts = new GustTrain(() => 0, GUST_RISE, FIRST_GUST);
  /** The latest gust's share across the room (toward the viewer +). */
  #gustZ = 0;
  #wind = 0;
  #drift = 0;
  /** Seconds a "now" or a puff keeps the mobile moving at motion 0. */
  #busy = 0;

  /** The air at a plate now (see the header); reads the mobile's own clock, so it is the same at every frame rate. */
  readonly #air: MobileAir = (x, y, z, out) => {
    const t = this.#mobile?.system.time ?? 0;
    const gusts = this.#gusts;
    const gust = GUST_SPEED * gusts.strength((gusts.sign * x + FRONT_FROM) / FRONT_SPEED);
    const eddy = EDDY * this.#drift;
    out[0] = DRAFT * this.#wind + gust + eddy * windNoise(t / EDDY_PERIOD[0] + EDDY_SPAN * x, 11);
    out[1] = 0.3 * eddy * windNoise(t / EDDY_PERIOD[1] + 1.3 * y, 12);
    out[2] = Math.abs(gust) * this.#gustZ + eddy * windNoise(t / EDDY_PERIOD[2] + EDDY_SPAN * z + 0.6 * x, 13);
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
    const mobile = this.#build(frame);
    const gusts = knobs.value(frame, "gusts");
    const power = 0.55 + 0.45 * knobs.amount(frame, "gusts");
    const mean = gustMean(knobs.amount(frame, "gusts"));
    if (frame.fired[this.#gustSlot] === true) {
      this.#startGust(power, mean);
      this.#busy = BUSY;
    }
    const enter = Math.min(1, Math.max(0, frame.passage.enter));
    const exit = Math.min(1, Math.max(0, frame.passage.exit));
    const passing = enter < 1 || exit > 0;
    if (!passing && frame.pointer.pressed && frame.pointer.inside) this.#puff(mobile, frame);

    // At motion 0 a "now" or a puff still plays, in real time, easing to a stop.
    this.#busy = Math.max(0, this.#busy - frame.dt);
    const pace = frame.motion > 0 ? frame.motion : smoothstep(0, BUSY_EASE, this.#busy);
    const dt = frame.dt * pace;
    if (dt > 0 && this.#gusts.step(dt, gusts > 0 ? mean : Infinity, this.#wind, power)) this.#gustZ = (this.#random.next() - 0.5) * 0.8;
    mobile.step(dt, this.#air);

    this.#texture.upload(mobile, passing ? this.#pose(enter, exit) : undefined);
    return this.#textures;
  }

  dispose(): void {
    this.#texture.dispose();
  }

  /** The mobile for the knobs: rebuilt (and its air and gusts started afresh) when its design changes. */
  #build(frame: SimFrame): Mobile {
    const knobs = this.#knobs;
    const seed = Math.round(knobs.value(frame, "mobileSeed"));
    const arms = Math.round(knobs.value(frame, "arms"));
    const shapes = knobs.pick(frame, "shapes", MOBILE_SHAPE_SETS, MOBILE_SHAPE_SETS[2] ?? [0]);
    const clearance = knobs.value(frame, "clearance");
    const key = `${seed}|${arms}|${shapes.join(",")}|${clearance}`;
    if (this.#mobile !== undefined && key === this.#key) return this.#mobile;
    this.#key = key;
    this.#random.seed(Math.imul(seed + 1, 0x9e3779b1) ^ 0x6d6f6273);
    const next = this.#random.next();
    this.#gusts = new GustTrain(() => this.#random.next(), GUST_RISE, FIRST_GUST * (0.8 + 0.4 * next));
    this.#gustZ = 0;
    this.#busy = 0;
    const mobile = new Mobile(designMobile({ seed, arms, anchor: MOBILE_ANCHOR, span: MOBILE_SPAN, clearance, shapes, top: MOBILE_TOP_LINK }));
    this.#mobile = mobile;
    mobile.settle(MOBILE_SETTLE, this.#air);
    return mobile;
  }

  #startGust(power: number, mean: number): void {
    this.#gusts.start(this.#wind, power, mean);
    this.#gustZ = (this.#random.next() - 0.5) * 0.8;
  }

  /** A click blows on the plate under the pointer, along the view. */
  #puff(mobile: Mobile, frame: SimFrame): void {
    const rd = mobileRay((frame.pointer.x - 0.5) * frame.aspect, frame.pointer.y - 0.5, frame.aspect);
    const plate = mobile.pick(MOBILE_EYE, rd, PUFF_SLACK);
    if (plate < 0) return;
    mobile.kick(plate, rd[0] * PUFF, rd[1] * PUFF, rd[2] * PUFF);
    this.#busy = BUSY;
  }

  /**
   * The passage's pose. Entrance: lowered from MOBILE_LOWER above its place on its link, slowing to a
   * stop at 78% of the way and bobbing once on the link's give, swaying a little as it comes. Exit:
   * hoisted MOBILE_HOIST up and out of the frame, gathering speed, leaning as it goes. Both exactly
   * still at rest.
   */
  #pose(enter: number, exit: number): MobilePose {
    let lift = 0;
    let swing = 0;
    if (enter < 1) {
      const t = enter * MOBILE_PASSAGE.enter;
      const x = Math.min(1, enter / 0.78);
      const bob = enter > 0.78 ? (enter - 0.78) / 0.22 : 0;
      lift = MOBILE_LOWER * (1 - x) ** 3 - 0.03 * Math.sin(Math.PI * 2 * bob) * (1 - bob);
      swing = 0.05 * Math.sin(2.4 * t + 0.6) * (1 - enter) ** 2;
    }
    if (exit > 0) {
      lift += MOBILE_HOIST * exit * exit * (0.4 + 0.6 * exit);
      swing += -0.04 * exit;
    }
    return { lift, swing };
  }
}

/** The mobile's simulation for a scene whose knobs are `params` (looked up by key). */
export function mobileSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new MobileSim(gl, params);
}
