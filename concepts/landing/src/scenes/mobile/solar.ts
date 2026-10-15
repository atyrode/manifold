// The solar system the mobile carries, laid out on the shared mobile (sims/mobile.ts): the bodies,
// their real orbits and how they hang, for each `planets` choice.
//
// One arm per planet, stacked down one axis: each hangs on a short link from the loop of the arm
// above (`end: 2`), the top one's from a hook on the ceiling's cord. From the top: the outer bodies
// outermost first, then the inner ones from Mercury out. The Sun is a globe threaded on the axis at
// Mercury's loop, so the arms radiate from it, the inner planets circle it close to its own height and
// the giants' wide arms hang a little above. A long arm never passes under a shorter one's planet:
// only shorter arms' wires pass under the weights near the axis, so the stack stays low. Each planet
// rides end 0 at a reach that grows with its orbit (half its rank, half the logarithm of its
// distance: the inner planets apart, the giants not off the frame), and a small brass weight on
// end 1, near the axis, balances it by the lever rule. The Earth hangs from its arm's end with the
// Moon on a sub-arm
// of its own. Each arm hangs as far below the one above as keeps its wire, planet, weight (and
// Saturn's rings) clear of all that hangs above it; `clearance` scales those gaps.
//
// Sizes are not to scale: radius grows as about the 0.45 power of the real one, so Jupiter and
// Saturn are clearly the biggest and Mercury and the Moon still a few cells across. The planets'
// globes are hollow (SHELL kg/m²), the weights solid brass.
//
// Periods are real: a planet's arm turns once in its orbital period, au^1.5 years (Kepler's third
// law), the Moon's sub-arm once a sidereal month. The arms start spread round the Sun, the giants
// to either side and behind, the ice giants in front, so the system reads at a glance.
import { glslFloat } from "../../shaders/glsl.ts";
import {
  MOBILE_LOOP,
  MOBILE_MAX_ARMS,
  MOBILE_WIRE,
  type MobileArmDesign,
  type MobileDesign,
} from "../../sims/mobile.ts";
import type { Vec3 } from "../../sims/verlet.ts";

/** What each ball is drawn as (its look in the mobile's texture). */
export const SOLAR_LOOKS = {
  mercury: 0,
  venus: 1,
  earth: 2,
  moon: 3,
  mars: 4,
  ceres: 5,
  jupiter: 6,
  saturn: 7,
  uranus: 8,
  neptune: 9,
  pluto: 10,
  weight: 11,
} as const;

export interface SolarBody {
  readonly name: string;
  readonly look: number;
  /** Semi-major axis (AU). */
  readonly au: number;
  /** Radius on the mobile (m). */
  readonly radius: number;
  /** Where its arm points at the start: degrees anticlockwise seen from above from the room's right (90: toward the wall). */
  readonly start: number;
  readonly dwarf: boolean;
}

/** Sun to Pluto, in order out from the Sun. */
export const SOLAR_BODIES: readonly SolarBody[] = [
  { name: "Mercury", look: 0, au: 0.38709927, radius: 0.022, start: 200, dwarf: false },
  { name: "Venus", look: 1, au: 0.72333566, radius: 0.034, start: 320, dwarf: false },
  { name: "Earth", look: 2, au: 1.00000261, radius: 0.036, start: 115, dwarf: false },
  { name: "Mars", look: 4, au: 1.52371034, radius: 0.027, start: 250, dwarf: false },
  { name: "Ceres", look: 5, au: 2.7675, radius: 0.012, start: 230, dwarf: true },
  { name: "Jupiter", look: 6, au: 5.202887, radius: 0.09, start: 140, dwarf: false },
  { name: "Saturn", look: 7, au: 9.53667594, radius: 0.078, start: 20, dwarf: false },
  { name: "Uranus", look: 8, au: 19.18916464, radius: 0.061, start: 70, dwarf: false },
  { name: "Neptune", look: 9, au: 30.06992276, radius: 0.059, start: 300, dwarf: false },
  { name: "Pluto", look: 10, au: 39.48211675, radius: 0.016, start: 175, dwarf: true },
];

/** The Moon: its radius, its sub-arm's reach from the Earth (m), its sidereal month (years), where it starts (degrees, as SolarBody.start). */
export const SOLAR_MOON = {
  radius: 0.013,
  reach: 0.085,
  years: 27.321661 / 365.25636,
  start: 0,
} as const;

/** The Sun's radius (m): a globe threaded on the mobile's axis at Mercury's loop. */
export const SOLAR_SUN_RADIUS = 0.15;

/** Saturn's rings, in its radii (the C ring's inner edge to the A ring's outer), and its axis's tilt from upright (rad). */
export const SOLAR_RINGS = { inner: 1.24, outer: 2.27, tilt: 0.3 } as const;

/**
 * The `planets` choices: the inner four and the Moon; the eight planets; with Ceres and Pluto. Each
 * reaches out to `reach` (m); the inner four alone are made `size` times as big, to fill the room the
 * giants leave.
 */
export const SOLAR_SETS = [
  { label: "inner", names: ["Mercury", "Venus", "Earth", "Mars"], reach: 0.95, size: 1.4 },
  {
    label: "all",
    names: ["Mercury", "Venus", "Earth", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"],
    reach: 1.3,
    size: 1,
  },
  {
    label: "+ dwarfs",
    names: SOLAR_BODIES.map((body) => body.name),
    reach: 1.38,
    size: 1,
  },
] as const;

/** Where the innermost planet hangs from the axis (m): clear of the Sun's globe. */
const INNER_REACH = 0.3;
/** Hollow globes (kg/m² of surface) and the brass weights (kg/m³). */
const SHELL = 0.6;
const BRASS = 8500;
/** A weight's reach against its planet's. */
const WEIGHT_SHARE = 0.22;
/** The loop's height above an arm's line: a base and a share of its span (m). */
const LOOP_BASE = 0.02;
const LOOP_SHARE = 0.02;
/** The links: the shortest (m), the Earth's drop below its arm's end, and the Moon's sub-arm's loop. */
const LINK_MIN = 0.045;
const EARTH_DROP = 0.05;
const MOON_LOOP = 0.015;
/** Room kept between anything of one arm and anything of an arm above it that it passes under (m). */
const ROOM = 0.02;
/** Half the thickness of an arm's wire (m), for the room it needs. */
const WIRE_HALF = 0.002;

export interface SolarMobile {
  readonly design: MobileDesign;
  /** Per arm: the body it carries, and its period (Earth years per turn). */
  readonly arms: readonly { readonly name: string; readonly years: number }[];
  /** Saturn's arm (its planet on end 0), or -1. */
  readonly saturn: number;
  /** The arm whose loop the Sun is threaded on. */
  readonly sun: number;
}

function shellMass(radius: number): number {
  return SHELL * 4 * Math.PI * radius * radius;
}

/** Where end 1 points with end 0 at `degrees` (SolarBody.start; MobileArmDesign.heading). */
function headingFor(degrees: number): number {
  // A body at angle λ sits at (cos λ, 0, -sin λ) from its arm's loop: anticlockwise seen from
  // above, the way the motor turns (sims/mobile.ts `drive`). End 1 points the other way.
  const lambda = (degrees * Math.PI) / 180;
  return -(lambda + Math.PI);
}

/** What one arm holds, relative to its loop, for keeping the arms below clear of it. */
interface Extent {
  readonly from: number;
  readonly to: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * The mobile for `planets` choice `set` (0..2) with the Sun's centre at `sun`, its links scaled by
 * `clearance` (the hook it hangs from is placed above to suit).
 */
export function solarMobile(set: number, clearance: number, sun: Vec3): SolarMobile {
  const choice = SOLAR_SETS[Math.min(SOLAR_SETS.length - 1, Math.max(0, Math.round(set)))];
  const names: readonly string[] = choice?.names ?? [];
  const bodies = SOLAR_BODIES.filter((body) => names.includes(body.name));
  const n = bodies.length;
  const logFirst = Math.log(bodies[0]?.au ?? 1);
  const logLast = Math.log(bodies[n - 1]?.au ?? 1);
  const outer = choice?.reach ?? 1;
  const size = choice?.size ?? 1;
  const moonRadius = SOLAR_MOON.radius * size;
  const moon = SOLAR_MOON.reach * size;
  const drop = EARTH_DROP * size;

  const arms: MobileArmDesign[] = [];
  const periods: { name: string; years: number }[] = [];
  let saturn = -1;
  // Every extent placed so far, at its loop's height below the anchor (m, downward), unscaled.
  const placed: { depth: number; extent: Extent }[] = [];
  // Each planet's arm and how far its loop hangs below the hook (scaled).
  const hubs: { arm: number; depth: number }[] = [];
  let hub = 0;
  let hung = 0;
  let parent = -1;
  // From the top: the outer bodies outermost first, then the inner ones from Mercury out, so the
  // Sun on Mercury's loop has the inner planets close round it and the giants' wide arms above.
  const order = [
    ...bodies.filter((body) => body.au > 2).reverse(),
    ...bodies.filter((body) => body.au <= 2),
  ];
  order.forEach((body) => {
    const rank = bodies.indexOf(body);
    const share =
      0.5 * (rank / Math.max(1, n - 1)) +
      0.5 * ((Math.log(body.au) - logFirst) / (logLast - logFirst));
    const reach = INNER_REACH + (outer - INNER_REACH) * share;
    const radius = body.radius * size;
    const earth = body.name === "Earth";
    const weightReach = WEIGHT_SHARE * reach;
    const span = reach + weightReach;
    const loop = LOOP_BASE + LOOP_SHARE * span;
    const wire = MOBILE_WIRE * span;
    // What end 0 carries: the globe, or the Earth and Moon on their sub-arm with its wire and loop,
    // hung below the loop end 0 then is. The Earth sits at e from the sub-arm's loop and the Moon at
    // its reach M, each with half the wire: (mE + w (e + M) / 2) e = (mM + w (e + M) / 2) M.
    const moonMass = shellMass(moonRadius);
    const earthMass = shellMass(radius);
    const earthReach =
      (Math.sqrt(
        earthMass ** 2 + 2 * MOBILE_WIRE * (moonMass * moon + (MOBILE_WIRE / 2) * moon ** 2),
      ) -
        earthMass) /
      MOBILE_WIRE;
    const carried = earth
      ? MOBILE_LOOP + earthMass + moonMass + MOBILE_WIRE * (earthReach + moon) + MOBILE_LOOP
      : shellMass(radius);
    const weightMass = ((carried + wire / 2) * reach) / weightReach - wire / 2;
    const weightRadius = Math.cbrt(weightMass / ((4 / 3) * Math.PI * BRASS));
    const ringed = body.name === "Saturn";
    const plan = ringed ? radius * SOLAR_RINGS.outer : radius;
    const rise = ringed ? Math.max(radius, plan * Math.sin(SOLAR_RINGS.tilt)) : radius;
    const extents: Extent[] = [
      { from: 0, to: reach / 2, top: 0, bottom: -loop / 2 - WIRE_HALF },
      { from: reach / 2, to: reach, top: -loop / 2, bottom: -loop - WIRE_HALF },
      {
        from: weightReach - weightRadius,
        to: weightReach + weightRadius,
        top: -loop + weightRadius,
        bottom: -loop - weightRadius,
      },
      earth
        ? {
            from: reach - moon - moonRadius,
            to: reach + moon + moonRadius,
            top: -loop,
            bottom: -loop - drop - MOON_LOOP - radius,
          }
        : { from: reach - plan, to: reach + plan, top: -loop + rise, bottom: -loop - rise },
    ];
    // As high as keeps every part clear of all that hangs above it that it passes under.
    let depth = hub + LINK_MIN;
    for (const above of placed) {
      for (const part of extents) {
        if (part.from < above.extent.to && above.extent.from < part.to)
          depth = Math.max(depth, above.depth - above.extent.bottom + part.top + ROOM);
      }
    }
    for (const extent of extents) placed.push({ depth, extent });
    const link = parent < 0 ? LINK_MIN : (depth - hub) * clearance;
    hub = depth;
    hung += link;

    const k = arms.length;
    hubs.push({ arm: k, depth: hung });
    if (ringed) saturn = k;
    arms.push({
      parent,
      end: 2,
      depth: k,
      link,
      reach: [reach, weightReach],
      loop,
      heading: headingFor(body.start),
      plates: [undefined, undefined],
      balls: [
        earth ? undefined : { radius, mass: shellMass(radius), look: body.look },
        { radius: weightRadius, mass: weightMass, look: SOLAR_LOOKS.weight },
      ],
    });
    periods.push({ name: body.name, years: body.au ** 1.5 });
    if (earth) {
      arms.push({
        parent: k,
        end: 0,
        depth: k + 1,
        link: drop,
        reach: [earthReach, moon],
        loop: MOON_LOOP,
        // The Moon rides end 1.
        heading: headingFor(SOLAR_MOON.start + 180),
        plates: [undefined, undefined],
        balls: [
          { radius, mass: earthMass, look: body.look },
          { radius: moonRadius, mass: moonMass, look: SOLAR_LOOKS.moon },
        ],
      });
      periods.push({ name: "Moon", years: SOLAR_MOON.years });
    }
    parent = k;
  });
  if (arms.length > MOBILE_MAX_ARMS) throw new Error(`solar mobile: ${arms.length} arms`);
  // The Sun on Mercury's loop; the hook as far above it as that loop hangs.
  const centre = hubs.find((h) => periods[h.arm]?.name === "Mercury") ?? { arm: 0, depth: 0 };
  return {
    design: { anchor: [sun[0], sun[1] + centre.depth, sun[2]], arms },
    arms: periods,
    saturn,
    sun: centre.arm,
  };
}

/** GLSL: Saturn's arm (-1 without it) and the Sun's arm for the `planets` choice (K_planets). */
export function solarGlsl(sun: Vec3): string {
  const layouts = SOLAR_SETS.map((_, set) => solarMobile(set, 1, sun));
  const table = (name: string, pick: (layout: SolarMobile) => number, fallback: number) => {
    const lines = layouts.map(
      (layout, set) => `  if (K_planets < ${glslFloat(set + 0.5)}) return ${pick(layout)};`,
    );
    return `int ${name}() {\n${lines.join("\n")}\n  return ${fallback};\n}`;
  };
  return `${table("mobileSaturnArm", (layout) => layout.saturn, -1)}\n${table("mobileSunArm", (layout) => layout.sun, 0)}`;
}
