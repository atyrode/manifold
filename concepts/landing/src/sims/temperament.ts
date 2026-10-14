// How a creature takes the pointer coming near: curious ones turn to look at it, shy ones shrink away
// (duck, hide, back off) while it is close and come back out a while after it has gone. A population
// mixes the two by a share, each creature keeping its own temperament for as long as it lives.
//
//   isShy(trait, shyness)   trait: the creature's own stable number in [0, 1) (a hash, or a draw it
//                           already makes, so adding temperament never shifts a seeded stream);
//                           shyness: the share of the population that is shy, 0 none .. 1 all.
//                           Raising shyness only ever turns more of them shy, never one back.
//   facing(dx, width, shy)  which way it faces, -1..1 (+: toward +x), for a pointer dx away: toward
//                           it when curious, turned away when shy; fully turned at |dx| >= width.
//   atEase()                a fresh Shrink: { amount 0, calm Infinity }.
//   stepShrink(state, h, startled, timing = SHY_TIMING)
//                           one step of h seconds (h <= 0 does nothing): `amount` eases toward 1
//                           with time constant `hide` while startled; once nothing has startled it
//                           for `wait` seconds it eases back toward 0 with time constant `recover`.
//                           `calm` counts the seconds since the last startle.
//
// The scene decides what startles (usually the pointer within some reach, for shy creatures only)
// and what shrinking means on screen: sinking into moss, backing into a burrow, dimming a glow.
//
// Usage (forest's kodama):
//   spirit.trait = hash31(Math.floor(spirit.variant * 16777216), 0x6b6f, 0x7368);
//   spirit.shrink = atEase();
//   ...each step:
//   const shy = isShy(spirit.trait, shyness);
//   const startled = shy && near;
//   if (startled) spirit.yawTo = facing(dx, 0.1, true);
//   stepShrink(spirit.shrink, h, startled);
//   sink = Math.max(sink, DUCK * spirit.shrink.amount);

/** How quickly a shy creature shrinks away and how warily it comes back out (seconds). */
export interface ShyTiming {
  /** Time constant of shrinking away once startled: quick. */
  readonly hide: number;
  /** How long nothing must have startled it before it ventures out again. */
  readonly wait: number;
  /** Time constant of coming back out: slow. */
  readonly recover: number;
}

export const SHY_TIMING: ShyTiming = { hide: 0.18, wait: 1.5, recover: 1.4 };

/** One shy creature's reaction. */
export interface Shrink {
  /** 0 at ease .. 1 shrunk fully away. */
  amount: number;
  /** Seconds since something last startled it (Infinity: nothing yet). */
  calm: number;
}

/** True when a creature with this stable `trait` (0..1) is shy at `shyness` (the shy share, 0..1). */
export function isShy(trait: number, shyness: number): boolean {
  return trait < shyness;
}

/** Which way a creature faces, -1..1 (+: toward +x), with the pointer `dx` away along x: toward it when curious, away when shy. */
export function facing(dx: number, width: number, shy: boolean): number {
  const toward = Math.min(1, Math.max(-1, dx / width));
  return shy ? -toward : toward;
}

/** A creature at ease: not shrunk, never startled. */
export function atEase(): Shrink {
  return { amount: 0, calm: Number.POSITIVE_INFINITY };
}

/** Advance a shy creature's reaction by h seconds: shrink while startled, come back out once it has been calm for `wait`. */
export function stepShrink(state: Shrink, h: number, startled: boolean, timing: ShyTiming = SHY_TIMING): void {
  if (!(h > 0)) return;
  if (startled) {
    state.calm = 0;
    state.amount += (1 - state.amount) * (1 - Math.exp(-h / timing.hide));
    return;
  }
  state.calm += h;
  if (state.calm >= timing.wait) state.amount -= state.amount * (1 - Math.exp(-h / timing.recover));
}
