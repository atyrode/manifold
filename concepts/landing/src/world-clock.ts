// The world clock: the one model of where a scene's sky stands, for the shaders and the CPU alike.
// The functions here are the model; worldClockGlsl is their GLSL mirror, which the sky library
// (shaders/lib/sky.ts) compiles into every program and `worldClock` (world-clock.verify.ts) checks
// against them on the GPU. Sims and the lab read the sky through skyNow, never a curve of their own.
// Its inputs are a scene's knobs: the time of day (K_time), the days the day cycle has run (K_cycle,
// a rate knob: its phase PHASE_cycle, src/rate-phase.ts), the moon's phase (K_moon) and, in a dated
// sky, the date (SKY_YEAR); its output is the Sky the scenes light and draw with (SkyState here).
//
// - The clock: 0 midnight, .25 sunrise, .5 noon, .75 sunset, the K_time contract, carried on by the
//   days the day cycle has run: at day cycle 1 a day passes in DAY_SECONDS of the motion clock. The
//   renderer integrates the cycle's pace frame by frame into those days (DAY_CYCLE_RATE), so moving
//   the knob changes the pace, never the hour (timeOfDay, GLSL timeOfDayM).
// - The staged sky: a low-latitude sky (15 degrees) seen facing the equator, the celestial pole low
//   behind the viewer (SKY_POLE). The sun rides a winter sun's daily circle (declination -28
//   degrees): it rises ~61 degrees right of straight ahead, culminates 47 degrees up dead ahead and
//   sets ~61 degrees left, so sunrise, golden hour and sunset happen in or near the frame. The clock
//   is warped onto its sunrise hour angle, so the sun crosses the horizon exactly at .25 and .75, and
//   eased so it lingers round sunrise and sunset (half speed there, 1.5x at noon and midnight):
//   golden hour and twilight get the stretch of the slider they would have at higher latitudes.
// - The date: a scene that keeps a season (climate.ts seasonKnob) has a dated sky, staged at its own
//   default date (skyAnchor; SKY_DATE_ANCHOR in its program). On that date its sun stands as staged;
//   as the date moves, the sun's declination moves by Earth's change since that date
//   (sunDeclination, 23.44 degrees either side of the equinoxes' over the year: a higher, longer arc
//   in the same twelve hours by summer, a lower, shorter one by winter), the warp following its
//   sunrise hour angle so sunrise stays at .25, and the staged full moon swings the other way, as a
//   full moon does (dateShift), no lower than a soft floor (fullMoonDeclination), so it still rises.
//   So one date stands each dated scene's sun where that scene's own staging puts it. Every other sky
//   is undated: the staged sky on any date.
// - The moon: K_moon runs through a lunation, 0 new, 1 full (the staged one), 2 new again: below 1
//   it waxes, above it wanes, its lit share p the knob's way from new (moonLit). The full moon is
//   the staged one, on a lower arc (declination -45 degrees), rising on the right just after sunset
//   and standing 30 degrees up straight ahead at midnight. A lesser phase stands where the sun lights
//   that share of its disc: E = acos(1 - 2p) from the sun (moonElongation), along the great circle
//   that leaves the sun along its daily circle (moonAt), eastward while it waxes and westward while
//   it wanes. A waxing crescent trails the sun and hangs over the sunset, a first quarter stands a
//   quarter of the sky east of it on the celestial equator and a waxing gibbous moon rises round
//   sunset; a waning gibbous moon rises late in the evening, the last quarter at midnight, and a
//   waning crescent leads the sun up before sunrise, in the morning sky. Its lit share is its
//   elongation's up to MOON_STAGED_FROM either side of full; the staged full moon, ~105 degrees from
//   the sun, is kept for every picture tuned to it, so a fuller moon moves off its elongation onto it
//   (moonStaging) and the moon's place never jumps with its phase. Its light on the land and on the
//   sky round it follows the measured lunar phase curve (moonPhaseLight): a half moon gives an
//   eleventh of the full moon's light, though its disc is drawn half lit.
// - The stars: fixed in a frame of their own that turns about the pole (starFrame): a sidereal
//   day's turn (SIDEREAL_TURNS) for every day the day cycle carries the clock on, and in a dated sky
//   a turn a year as the date moves from its staged date (starTurn). With the cycle off and the
//   date as staged they stand as staged, so the constellations keep their layout. The sky's planets
//   fixed among them turn with them (skyGiant).
// - The cold: one model of the year's cold, in climate.ts (climateChill, and climateCold made of it).
import { seasonKnob, yearAt } from "./climate.ts";
import { effective, type ParamDef, type Rate } from "./params.ts";
import { glslFloat } from "./shaders/glsl.ts";
import { clamp, fract, smoothstep } from "./sims/math.ts";

type Vec3 = readonly [number, number, number];

const TAU = 2 * Math.PI;
const scale = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** a × b. */
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

// ---- the clock ----

/** The K_time contract: the sun crosses the horizon at these times of day, and is up between. */
export const SUNRISE = 0.25;
export const SUNSET = 0.75;
/** Seconds of the motion clock a whole day takes at day cycle 1. */
export const DAY_SECONDS = 240;
/** Days in the staged world's year; the stars come round once more than the sun in it. */
export const YEAR_DAYS = 365;
/** The stars' turns about the pole a solar day: one sidereal day is 1 / SIDEREAL_TURNS of a day. */
export const SIDEREAL_TURNS = 1 + 1 / YEAR_DAYS;

/**
 * The day cycle as a rate knob (K_cycle's ParamDef.rate): its phase is the days it has carried the
 * clock on, a day every DAY_SECONDS of the motion clock at pace 1, wrapped at a year of YEAR_DAYS
 * days, whole days for the hour and whole turns for the stars (SIDEREAL_TURNS days a year), so
 * neither moves at the wrap.
 */
export const DAY_CYCLE_RATE: Rate = { per: 1 / DAY_SECONDS, period: YEAR_DAYS };

/**
 * The time of day 0..1 (0 midnight, .25 sunrise, .5 noon, .75 sunset): `time` (K_time) carried on by
 * the `days` the day cycle has run (its phase: SimFrame.phases.cycle, 0 without a cycle or while it
 * is off).
 */
export function timeOfDay(time: number, days: number): number {
  return fract(time + days);
}

/**
 * The days the day cycle had run `ago` seconds of the motion clock before now, when it has run `days`
 * now at pace `cycle` (K_cycle as the shader reads it): taken back at the pace now (GLSL skyDaysAt).
 */
export function daysAgo(days: number, cycle: number, ago: number): number {
  return days - (cycle * ago) / DAY_SECONDS;
}

// ---- the staged sky ----

/** The staged sky's latitude, 15 degrees: its cosine and sine. */
export const COS_LAT = 0.965926;
export const SIN_LAT = 0.258819;
/** The celestial pole in the sky's frame (x right, y up, z ahead): 15 degrees up behind the viewer. */
export const SKY_POLE: Vec3 = [0, SIN_LAT, -COS_LAT];
/** The staged sun's declination, -28 degrees (cosine, sine), and its hour angle at sunrise. */
const SUN_COS_DEC = 0.882948;
const SUN_SIN_DEC = -0.469472;
const SUN_H0 = 1.427839;
/** The staged full moon's declination, -45 degrees. */
const MOON_COS_DEC = 0.707107;
const MOON_SIN_DEC = -0.707107;
const SUN_DEC = Math.atan2(SUN_SIN_DEC, SUN_COS_DEC);
const MOON_DEC = Math.atan2(MOON_SIN_DEC, MOON_COS_DEC);
/**
 * The dated sky's full moon's soft floor (fullMoonDeclination): its knee, -64.17 degrees (just below
 * the countryside's lowest), and how far below the knee it eases toward, 3.8 degrees.
 */
const MOON_FLOOR = (-64.17 * Math.PI) / 180;
const MOON_FLOOR_SOFT = (3.8 * Math.PI) / 180;

/** A body on its daily circle at hour angle h (0 culmination, negative rising on the right). */
function body(h: number, cosDec: number, sinDec: number): Vec3 {
  const c = cosDec * Math.cos(h);
  return [-cosDec * Math.sin(h), c * COS_LAT + sinDec * SIN_LAT, c * SIN_LAT - sinDec * COS_LAT];
}

/**
 * The sun's hour angle at the time of day tod for a sunrise hour angle h0: the clock warped onto
 * -h0 .. h0 by day and h0 .. TAU - h0 by night, eased round sunrise and sunset.
 */
function sunHour(tod: number, h0: number): number {
  const d = fract(tod - SUNRISE);
  let u = fract(d * 2);
  u -= (0.5 * Math.sin(TAU * u)) / TAU;
  return d < 0.5 ? -h0 + 2 * h0 * u : h0 + (TAU - 2 * h0) * u;
}

// ---- the date ----

/** Earth's axial tilt: how far either side of the equator the date carries the sun. */
export const OBLIQUITY = (23.44 * Math.PI) / 180;

/**
 * Earth's sun's declination at a year position (0 the March equinox, .25 the June solstice, .5 the
 * September equinox, .75 the December solstice): asin(sin OBLIQUITY sin 2 pi year).
 */
export function sunDeclination(year: number): number {
  return Math.asin(Math.sin(OBLIQUITY) * Math.sin(TAU * year));
}

/**
 * The steps a year the sky reads its date in: a step moves the sun far less than a cell, and a date
 * the passing year reaches reads exactly as the same date set on the knob, though the shader works
 * the two year positions out in different ways.
 */
const DATE_STEPS = 10000;
/** A shift (radians) under which the sun is taken to stand as staged: float32's error, no more. */
const SHIFT_SNAP = 1e-5;

/** The date as the sky reads it: `year` to the nearest of the DATE_STEPS a year. */
function skyDate(year: number): number {
  return Math.floor(year * DATE_STEPS + 0.5) / DATE_STEPS;
}

/**
 * How far toward the pole of its staged declination a dated sky's sun stands at `year` (radians,
 * the higher at noon the more): the change in sunDeclination since the sky's staged date `anchor`.
 * Exactly 0 without a date (either below 0) and wherever the sun stands as on the staged date
 * (a date mirrored about a solstice from the staged one).
 */
export function dateShift(year: number, anchor: number): number {
  if (year < 0 || anchor < 0) return 0;
  const shift = sunDeclination(skyDate(year)) - sunDeclination(skyDate(anchor));
  return Math.abs(shift) < SHIFT_SNAP ? 0 : shift;
}

/**
 * A dated sky's staged date: where the scene's season knob (seasonKnob) puts the year at its
 * default. Undefined for an undated sky: a scene without a season knob, or one whose default is no
 * time of year.
 */
export function skyAnchor(params: readonly ParamDef[]): number | undefined {
  const season = seasonKnob(params);
  if (season === undefined) return undefined;
  const year = yearAt(season, effective(season, {}));
  return year >= 0 ? year : undefined;
}

/**
 * The staged full moon's declination in a dated sky whose sun the date shifts by `shift` (dateShift):
 * swung the other way, but eased onto a soft floor below MOON_FLOOR, so that however far a scene's
 * staging and its date carry it south it still clears the horizon at midnight, low and golden (at
 * least MOON_FLOOR - MOON_FLOOR_SOFT, ~7 degrees up). The knee is the countryside's lowest full
 * moon, so its dates stand as they did.
 */
export function fullMoonDeclination(shift: number): number {
  const dec = MOON_DEC - shift;
  if (dec >= MOON_FLOOR) return dec;
  return MOON_FLOOR - MOON_FLOOR_SOFT * (1 - Math.exp((dec - MOON_FLOOR) / MOON_FLOOR_SOFT));
}

// ---- the moon ----

/** The lit share of the moon's disc at K_moon `phase` (0 new, 1 full, 2 new again): 0..1. */
export function moonLit(phase: number): number {
  return phase > 1 ? Math.max(2 - phase, 0) : Math.max(phase, 0);
}

/** Whether a moon at K_moon `phase` wanes: past full, standing west of the sun. */
export function moonWaning(phase: number): boolean {
  return phase > 1;
}

/**
 * How far from the sun a moon of lit share `lit` stands (radians): the elongation at which the sun
 * lights that share of its disc, acos(1 - 2 lit); pi for the full moon.
 */
export function moonElongation(lit: number): number {
  return Math.acos(1 - 2 * clamp(lit, 0, 1));
}

/**
 * Where a moon of lit share p (0 < p < 1) stands for the sun at `sun`: moonElongation(p) from it along
 * the great circle that leaves it along its daily circle, eastward while it waxes, westward while it
 * wanes (`waning`).
 */
export function moonAt(sun: Vec3, p: number, waning = false): Vec3 {
  const east = cross(SKY_POLE, sun);
  const size = Math.hypot(...east) * (waning ? -1 : 1);
  return add(scale(sun, 1 - 2 * p), scale(east, (2 * Math.sqrt(p * (1 - p))) / size));
}

/**
 * The lit share from which the moon moves off where its elongation puts it onto the staged full
 * moon, reaching it at full (moonStaging): the last tenth of the shares, waxing or waning.
 */
export const MOON_STAGED_FROM = 0.9;

/**
 * How far a moon of lit share `lit` has moved from its elongation's place (moonAt) onto the staged
 * full moon: 0 up to MOON_STAGED_FROM, easing to 1 at full. The staged full moon stands ~105 degrees
 * from the sun, not opposite it, so a moon in this stretch stands nearer the sun than its lit share
 * needs, and the moon's place runs on with its phase into the full moon every picture shows.
 */
export function moonStaging(lit: number): number {
  return smoothstep(MOON_STAGED_FROM, 1, lit);
}

/**
 * The moon's light at a lit share relative to full: the measured lunar phase curve (Allen's
 * magnitudes, 0.026 |a| + 4e-9 a^4 at phase angle a degrees, where the lit share is (1 + cos a) / 2).
 * The opposition surge makes the full moon far brighter than any lesser phase: 0.9 lit gives 0.41,
 * half lit 0.09, a quarter 0.026.
 */
export function moonPhaseLight(lit: number): number {
  const a = (Math.acos(clamp(2 * lit - 1, -1, 1)) * 180) / Math.PI;
  return 10 ** (-0.4 * (0.026 * a + 4e-9 * a ** 4));
}

// ---- the stars ----

/**
 * How far the stars have turned about the pole (radians, 0..TAU): SIDEREAL_TURNS for every one of the
 * `days` the day cycle has carried the clock on (its phase), and in a dated sky a turn for every year
 * its date `year` stands from its staged date `anchor`, both read in the sky's date steps. 0 with the
 * cycle off and the date as staged.
 */
export function starTurn(days: number, year = -1, anchor = -1): number {
  let turns = SIDEREAL_TURNS * days;
  if (year >= 0 && anchor >= 0) turns += skyDate(year) - skyDate(anchor);
  return TAU * fract(turns);
}

/**
 * A sky direction in the stars' own frame, the stars having turned by `turn` (starTurn): `dir`
 * turned back about the pole, so a star fixed in that frame rises and sets as the sun does.
 */
export function starFrame(dir: Vec3, turn: number): Vec3 {
  if (turn === 0) return dir;
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  return add(
    add(scale(dir, c), scale(cross(SKY_POLE, dir), s)),
    scale(SKY_POLE, (SKY_POLE[0] * dir[0] + SKY_POLE[1] * dir[1] + SKY_POLE[2] * dir[2]) * (1 - c)),
  );
}

// ---- the sky now ----

/** The sky at a moment: the GLSL Sky (worldClockGlsl) field for field. */
export interface SkyState {
  /** Unit directions in the sky's frame (x right, y up, z ahead). */
  readonly sun: Vec3;
  readonly moon: Vec3;
  /** 0..1, full once the sun is ~12 degrees up. */
  readonly day: number;
  /** 0..1, peaks with the sun on the horizon, lingers through civil and nautical twilight. */
  readonly twilight: number;
  /** 0..1, first stars at ~5 degrees down, full once the sun is ~15 degrees down. */
  readonly night: number;
  /** Direct sunlight, reddened by the air mass; 0 once the sun has set. */
  readonly sunColor: Vec3;
  /** Light from the whole sky, for shading; never 0. */
  readonly ambient: Vec3;
  /** Direct moonlight in its phase; 0 below the horizon, by day and without a moon. */
  readonly moonColor: Vec3;
  /** The lit share of the moon's disc: 1 full .. 0 no moon. */
  readonly moonPhase: number;
  /** How far the stars have turned about the pole (starTurn). */
  readonly starTurn: number;
}

/** Transmittance of a beam arriving at elevation sine e (Kasten and Young's air mass, simplified). */
function transmit(e: number): Vec3 {
  const m = 1 / (Math.max(e, 0) + 0.036);
  return [Math.exp(-0.02 * m), Math.exp(-0.056 * m), Math.exp(-0.125 * m)];
}

/** Moonlight on the land from a full moon at `moon` by day `day`: cool and soft. */
function moonLight(moon: Vec3, day: number): Vec3 {
  const [r, g, b] = transmit(moon[1]);
  const k = smoothstep(-0.02, 0.06, moon[1]) * (1 - day);
  return [0.3 * Math.sqrt(r) * k, 0.36 * Math.sqrt(g) * k, 0.5 * Math.sqrt(b) * k];
}

/** What skyState takes beside the time of day. */
export interface SkyWorld {
  /** dateShift: how far the date moves the sun north of its staged declination; default 0. */
  readonly shift?: number;
  /** starTurn; default 0. */
  readonly turn?: number;
  /** The moon's phase (K_moon): 0 new, below 1 waxing, 1 full (the default), above 1 waning, 2 new. */
  readonly phase?: number;
}

/** The sky at the time of day `tod` (GLSL skyAtWorld, then skyMoonPhase). */
export function skyState(tod: number, { shift = 0, turn = 0, phase = 1 }: SkyWorld = {}): SkyState {
  let sun: Vec3;
  let moon: Vec3;
  if (shift === 0) {
    sun = body(sunHour(tod, SUN_H0), SUN_COS_DEC, SUN_SIN_DEC);
    moon = body(tod * TAU, MOON_COS_DEC, MOON_SIN_DEC);
  } else {
    const dec = SUN_DEC + shift;
    const h0 = Math.acos(clamp(-Math.tan(dec) * (SIN_LAT / COS_LAT), -1, 1));
    sun = body(sunHour(tod, h0), Math.cos(dec), Math.sin(dec));
    const moonDec = fullMoonDeclination(shift);
    moon = body(tod * TAU, Math.cos(moonDec), Math.sin(moonDec));
  }
  const e = sun[1];
  const day = smoothstep(-0.02, 0.22, e);
  const w = (e + 0.02) / (e > -0.02 ? 0.17 : 0.15);
  const twilight = Math.exp(-w * w);
  const night = 1 - smoothstep(-0.26, -0.03, e);
  const sunColor = scale(transmit(e), smoothstep(-0.035, 0.02, e));
  let moonColor = moonLight(moon, day);
  const glow = smoothstep(-0.1, 0.03, e);
  const dusk = add(scale([0.12, 0.15, 0.3], 1 - glow), scale([0.36, 0.25, 0.3], glow));
  let ambient = add(
    add(
      add([0.03, 0.038, 0.075], scale([0.4, 0.48, 0.62], day)),
      scale(dusk, twilight * (1 - day)),
    ),
    scale(moonColor, 0.3),
  );
  let moonPhase = 1;
  if (phase !== 1) {
    const p = moonLit(phase);
    let light: Vec3 = [0, 0, 0];
    if (p > 0) {
      // Its elongation's place, moved onto the staged full moon (`moon` so far) as it nears full.
      const staging = moonStaging(p);
      const placed = add(
        scale(moonAt(sun, p, moonWaning(phase)), 1 - staging),
        scale(moon, staging),
      );
      moon = scale(placed, 1 / Math.hypot(...placed));
      light = scale(moonLight(moon, day), moonPhaseLight(p));
    } else moon = scale([moon[0], -2, moon[2]], 1 / Math.hypot(moon[0], -2, moon[2]));
    ambient = add(ambient, scale(add(light, scale(moonColor, -1)), 0.3));
    moonColor = light;
    moonPhase = p;
  }
  return {
    sun,
    moon,
    day,
    twilight,
    night,
    sunColor,
    ambient,
    moonColor,
    moonPhase,
    starTurn: turn,
  };
}

/** Where a scene's sky stands, as its shader reads it. */
export interface SkyClock {
  /** K_time. */
  readonly time: number;
  /**
   * The days the day cycle has carried the clock on: its rate phase (PHASE_cycle, SimFrame.phases
   * .cycle), 0 without a cycle or while it is off.
   */
  readonly days: number;
  /** K_moon as the shader reads it: 1 full (the default), 0 or 2 no moon, above 1 waning. */
  readonly phase?: number;
  /** The date (SKY_YEAR: yearNow of the season knob); default none (-1). */
  readonly year?: number;
  /** The sky's staged date (skyAnchor); default none: an undated sky. */
  readonly anchor?: number;
}

/** The scene's sky now: skyState at its time of day, its date, its stars' turn and its moon. */
export function skyNow({ time, days, phase = 1, year = -1, anchor = -1 }: SkyClock): SkyState {
  return skyState(timeOfDay(time, days), {
    shift: dateShift(year, anchor),
    turn: starTurn(days, year, anchor),
    phase,
  });
}

// ---- the GLSL mirror ----

/**
 * The model above in GLSL, in the sky library (shaders/lib/sky.ts) of every program: the clock, the
 * Sky struct, skyAt and its parts, the moon's phase (with SKY_MOON_PHASE) and the stars' frame.
 */
export const worldClockGlsl = `
// ---- the world clock (src/world-clock.ts) ----

// The clock: K_time carried on by the days the day cycle has run -> 0..1 (0 midnight, .25 sunrise,
// .5 noon, .75 sunset): timeOfDayM(K_time, skyDays()). At cycle 1 a whole day passes in four minutes
// of the motion clock. The renderer integrates the cycle's pace into those days frame by frame (its
// rate phase, PHASE_cycle), so neither the motion slider nor the cycle's own pace jumps the hour.
float timeOfDayM(float time, float days) {
  return fract(time + days);
}

// The days the day cycle (K_cycle) has carried the clock on: its phase, 0 without a cycle or while it
// is off.
float skyDays() {
#ifdef PHASE_cycle
  return PHASE_cycle;
#else
  return 0.0;
#endif
}

// skyDays as they stood at the earlier motion clock at (a flight's or a herd's start), taken back at
// the day cycle's pace now, cycle (K_cycle; 0 for a scene without one).
float skyDaysAt(float cycle, float at) {
  return skyDays() - cycle * (uMotionTime - at) / ${glslFloat(DAY_SECONDS)};
}

struct Sky {
  vec3 sun;       // unit direction (x right, y up, z into the scene)
  vec3 moon;      // unit direction
  float day;      // 0..1, full once the sun is ~12 degrees up
  float twilight; // 0..1, peaks with the sun on the horizon, lingers through civil and nautical twilight
  float night;    // 0..1, first stars at ~5 degrees down, full once the sun is ~15 degrees down
  vec3 sunColor;  // direct sunlight, reddened by the air mass; 0 once the sun has set
  vec3 ambient;   // light from the whole sky, for shading; never 0
  vec3 moonColor; // direct moonlight, cool and soft; 0 below the horizon and by day
  float starTurn; // radians the stars have turned about the pole (skyStarFrame); 0 as staged
#ifdef SKY_MOON_PHASE
  float moonPhase; // lit share of the moon's disc: 1 full (skyAt) .. 0 no moon (skyMoonPhase)
#endif
};

// The staged sky: a low-latitude sky (15 degrees) seen facing the equator, the celestial pole
// (SKY_POLE) low behind the viewer. The sun's daily circle is a winter sun's (-28 degrees): it rises
// ~61 degrees right of straight ahead, culminates 47 degrees up dead ahead and sets ~61 degrees left,
// so sunrise, golden hour and sunset happen in or near the frame; the full moon (-45 degrees) runs a
// lower arc, rising ~43 degrees right, 30 degrees up ahead at midnight. A dated sky moves both with
// the date (skyAt).
const float SKY_COS_LAT = ${glslFloat(COS_LAT)};
const float SKY_SIN_LAT = ${glslFloat(SIN_LAT)};
const vec3 SKY_POLE = vec3(0.0, SKY_SIN_LAT, -SKY_COS_LAT);
const float SKY_SUN_COS_DEC = ${glslFloat(SUN_COS_DEC)};
const float SKY_SUN_SIN_DEC = ${glslFloat(SUN_SIN_DEC)};
const float SKY_MOON_COS_DEC = ${glslFloat(MOON_COS_DEC)};
const float SKY_MOON_SIN_DEC = ${glslFloat(MOON_SIN_DEC)};
// The sun's hour angle at sunrise, acos(-tan(dec) tan(lat)). The clock is warped onto it so the sun
// crosses the horizon exactly at .25 and .75 as the K_time contract says, and eased so it lingers
// around sunrise and sunset (half speed there, 1.5x at noon and midnight): golden hour and twilight
// get a wider stretch of the time slider, as they would at higher latitudes.
const float SKY_SUN_H0 = ${glslFloat(SUN_H0)};
// The date: the staged declinations (radians), the full moon's soft floor (its knee and its depth),
// the tangent of the latitude, the sine of Earth's tilt (sunDeclination), and the stars' turns a
// solar day (a sidereal day's).
const float WORLD_SUN_DEC = ${glslFloat(SUN_DEC)};
const float WORLD_MOON_DEC = ${glslFloat(MOON_DEC)};
const float WORLD_MOON_FLOOR = ${glslFloat(MOON_FLOOR)};
const float WORLD_MOON_FLOOR_SOFT = ${glslFloat(MOON_FLOOR_SOFT)};
const float WORLD_TAN_LAT = ${glslFloat(SIN_LAT / COS_LAT)};
const float WORLD_SIN_TILT = ${glslFloat(Math.sin(OBLIQUITY))};
const float WORLD_SIDEREAL = ${glslFloat(SIDEREAL_TURNS)};

// A body on its daily circle at hour angle h (0 = culmination, negative = rising on the right).
vec3 skyBody(float h, float cosDec, float sinDec) {
  float c = cosDec * cos(h);
  return vec3(-cosDec * sin(h), c * SKY_COS_LAT + sinDec * SKY_SIN_LAT, c * SKY_SIN_LAT - sinDec * SKY_COS_LAT);
}

// Transmittance of a beam arriving at elevation sine e. Air mass ~ 1 / (e + 0.036), about 28 at the
// horizon (a simplification of Kasten and Young 1989), times a Rayleigh-like extinction that grows
// toward blue, so low light turns gold, then orange, then red.
vec3 skyTransmit(float e) {
  float m = 1.0 / (max(e, 0.0) + 0.036);
  return exp(-vec3(0.020, 0.056, 0.125) * m);
}

// A full moon's light on the land at moon by day day: cool and soft, 0 below the horizon and by day.
vec3 skyMoonLight(vec3 moon, float day) {
  float moonUp = smoothstep(-0.02, 0.06, moon.y);
  return vec3(0.30, 0.36, 0.50) * sqrt(skyTransmit(moon.y)) * moonUp * (1.0 - day);
}

// The date as the sky reads it: to a ten-thousandth of a year, so a date the passing year reaches
// reads as the same date set on the knob.
float worldSkyDate(float year) {
  return floor(year * ${glslFloat(DATE_STEPS)} + 0.5) / ${glslFloat(DATE_STEPS)};
}

// How far toward the pole of its staged declination a dated sky's sun stands at the year position
// year (radians, the higher at noon the more): the change in Earth's sun's declination, asin(sin
// tilt sin 2 pi year), since the sky's staged date anchor. Exactly 0 without a date (either below 0)
// and wherever the sun stands as on the staged date.
float worldDateShift(float year, float anchor) {
  if (year < 0.0 || anchor < 0.0) return 0.0;
  float shift = asin(WORLD_SIN_TILT * sin(TAU * worldSkyDate(year))) - asin(WORLD_SIN_TILT * sin(TAU * worldSkyDate(anchor)));
  return abs(shift) < ${glslFloat(SHIFT_SNAP)} ? 0.0 : shift;
}

// The staged full moon's declination in a dated sky whose sun the date shifts by shift: swung the other
// way, eased onto a soft floor below WORLD_MOON_FLOOR so it still rises, low and golden.
float worldFullMoonDec(float shift) {
  float dec = WORLD_MOON_DEC - shift;
  if (dec >= WORLD_MOON_FLOOR) return dec;
  return WORLD_MOON_FLOOR - WORLD_MOON_FLOOR_SOFT * (1.0 - exp((dec - WORLD_MOON_FLOOR) / WORLD_MOON_FLOOR_SOFT));
}

// How far the stars have turned about the pole (radians, 0..TAU): a sidereal day's turn for every one
// of the days the day cycle has carried the clock on (skyDays), and in a dated sky a turn a year as
// the date moves from its staged date. 0 with the cycle off and the date as staged.
float worldStarTurn(float days, float year, float anchor) {
  float turns = WORLD_SIDEREAL * days;
  if (year >= 0.0 && anchor >= 0.0) turns += worldSkyDate(year) - worldSkyDate(anchor);
  return TAU * fract(turns);
}

// The sky at the time of day tod with the sun shift radians toward the pole of its staged
// declination (the date's, worldDateShift) and the stars turned by turn (worldStarTurn). Unshifted it
// is the staged sky exactly; shifted, the clock is warped onto the shifted sun's own sunrise hour
// angle, and the full moon's arc swings the other way.
Sky skyAtWorld(float tod, float shift, float turn) {
  Sky s;
  float d = fract(tod - 0.25); // 0 sunrise, 0.5 sunset
  float u = fract(d * 2.0);    // progress through the day half or the night half
  u -= 0.5 * sin(TAU * u) / TAU;
  if (shift == 0.0) {
    float h = d < 0.5 ? mix(-SKY_SUN_H0, SKY_SUN_H0, u) : mix(SKY_SUN_H0, TAU - SKY_SUN_H0, u);
    s.sun = skyBody(h, SKY_SUN_COS_DEC, SKY_SUN_SIN_DEC);
    s.moon = skyBody(tod * TAU, SKY_MOON_COS_DEC, SKY_MOON_SIN_DEC);
  } else {
    float sun = WORLD_SUN_DEC + shift;
    float cosSun = cos(sun);
    float sinSun = sin(sun);
    float h0 = acos(clamp(-sinSun / cosSun * WORLD_TAN_LAT, -1.0, 1.0));
    float h = d < 0.5 ? mix(-h0, h0, u) : mix(h0, TAU - h0, u);
    s.sun = skyBody(h, cosSun, sinSun);
    float moon = worldFullMoonDec(shift);
    s.moon = skyBody(tod * TAU, cos(moon), sin(moon));
  }
  float e = s.sun.y;
  s.day = smoothstep(-0.02, 0.22, e);
  // Asymmetric bell: golden hour above the horizon, civil and nautical twilight below it.
  float w = (e + 0.02) / (e > -0.02 ? 0.17 : 0.15);
  s.twilight = exp(-w * w);
  s.night = 1.0 - smoothstep(-0.26, -0.03, e);
  s.sunColor = skyTransmit(e) * smoothstep(-0.035, 0.02, e);
  s.moonColor = skyMoonLight(s.moon, s.day);
  // Dusk light is warm while the sun is up and turns blue once it has set (the blue hour).
  vec3 dusk = mix(vec3(0.12, 0.15, 0.30), vec3(0.36, 0.25, 0.30), smoothstep(-0.1, 0.03, e));
  s.ambient = vec3(0.030, 0.038, 0.075) + vec3(0.40, 0.48, 0.62) * s.day + dusk * s.twilight * (1.0 - s.day) + s.moonColor * 0.3;
  s.starTurn = turn;
#ifdef SKY_MOON_PHASE
  s.moonPhase = 1.0;
#endif
  return s;
}

// The scene's sky at the time of day tod (timeOfDayM): dated by SKY_YEAR in a dated sky (a program
// with SKY_DATE_ANCHOR, its staged date), its stars turned by the days the day cycle has run
// (skyDays). The full moon; skyMoonPhase gives it a phase.
Sky skyAt(float tod) {
#ifdef SKY_DATE_ANCHOR
  float year = SKY_YEAR;
  float anchor = SKY_DATE_ANCHOR;
#else
  float year = -1.0;
  float anchor = -1.0;
#endif
  return skyAtWorld(tod, worldDateShift(year, anchor), worldStarTurn(skyDays(), year, anchor));
}

// A sky direction in the stars' frame: dir turned back about the pole by the turn the stars have
// made, so a star fixed there rises and sets as the sun does. dir itself while they stand as staged.
// Look stars, constellations and a Milky Way up at it; keep dir for how high they stand.
vec3 skyStarFrame(Sky sky, vec3 dir) {
  if (sky.starTurn == 0.0) return dir;
  float c = cos(sky.starTurn);
  float s = sin(sky.starTurn);
  return dir * c + cross(SKY_POLE, dir) * s + SKY_POLE * (dot(SKY_POLE, dir) * (1.0 - c));
}

#ifdef SKY_MOON_PHASE
// The moon's light at a lit share (0..1) relative to full: the measured lunar phase curve (Allen's
// magnitudes 0.026 |a| + 4e-9 a^4 at phase angle a degrees, where the lit share is (1 + cos a) / 2),
// the opposition surge making the full moon far brighter than any lesser phase. 0.9 lit gives 0.41,
// half lit 0.09, a quarter 0.026.
float skyMoonPhaseLight(float phase) {
  float a = degrees(acos(clamp(2.0 * phase - 1.0, -1.0, 1.0)));
  float a2 = a * a;
  return exp2(-0.4 * ${glslFloat(Math.log2(10))} * (0.026 * a + 4e-9 * a2 * a2));
}

// Where a moon of lit share p (0 < p < 1) stands for the sun at sun: acos(1 - 2p) from it, the
// elongation at which the sun lights that share of its disc, along the great circle that leaves the
// sun along its daily circle, eastward while it waxes and westward while it wanes (waning). A waxing
// crescent trails the sun, a first quarter stands a quarter of the sky east of it on the celestial
// equator, a gibbous moon nears the point opposite; a waning crescent leads the sun up at dawn.
vec3 skyMoonAt(vec3 sun, float p, bool waning) {
  vec3 east = normalize(cross(SKY_POLE, sun)) * (waning ? -1.0 : 1.0);
  return (1.0 - 2.0 * p) * sun + 2.0 * sqrt(p * (1.0 - p)) * east;
}

// The sky with its moon in a phase (K_moon): 1 full (the sky unchanged: the staged full moon); below 1
// waxing, its lit share the phase, down to a thin crescent; above 1 waning, its lit share 2 - phase;
// 0 or 2 no moon (put away well below the horizon on its own bearing, so a scene keying its light off
// sky.moon still gets a direction with a heading). A partial moon stands where its phase puts it
// (skyMoonAt), moved onto the staged full moon from a lit share of MOON_STAGED_FROM up (moonStaging),
// so it never jumps as the phase passes full; its light on the land (moonColor, its share of
// ambient), the moonlit blue round it and its halo scale with skyMoonPhaseLight; skyColor draws the
// lit share of the disc on the side toward the sun, skyStars lets stars nearer a dim moon.
Sky skyMoonPhase(Sky sky, float phase) {
  if (phase == 1.0) return sky;
  float p = phase > 1.0 ? max(2.0 - phase, 0.0) : max(phase, 0.0);
  vec3 light = vec3(0.0);
  if (p > 0.0) {
    sky.moon = normalize(mix(skyMoonAt(sky.sun, p, phase > 1.0), sky.moon, smoothstep(${glslFloat(MOON_STAGED_FROM)}, 1.0, p)));
    light = skyMoonLight(sky.moon, sky.day) * skyMoonPhaseLight(p);
  }
  sky.ambient += (light - sky.moonColor) * 0.3;
  sky.moonColor = light;
  sky.moonPhase = p;
  if (p <= 0.0) sky.moon = normalize(vec3(sky.moon.x, -2.0, sky.moon.z));
  return sky;
}
#endif
`;
