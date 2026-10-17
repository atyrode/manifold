// The almanac. The sky dial: the time of day as the sun on its circle (sunrise on the right, noon at
// the top, sunset on the left, midnight below the horizon), with the moon in its phase where its
// phase puts it (the scene's night `moon` part; its controls are the Night sky's, nightsky.ts): as far
// round behind the sun as it trails the sun in the sky, a crescent just behind it, a half moon a
// quarter of the day, the full moon opposite, a moon nearing full moving onto it as the sky's does.
// The dial's light, the sun and moon going down and the stars coming out follow the scene's own sky
// (skyNow, src/world-clock.ts, dated with the scene's date where its sky is), with as many stars in
// the night half as the scene's `stars` part lets out. Drag the sun (or the moon) round; keys: arrows
// step the hour, wrapping past midnight. Under it, "Day speed": the day cycle as one slider, still at
// the left end and faster to the right (speed-model.ts).
//
// The season ring round it is the year laid out the same way (almanac-model.ts): spring on the right,
// summer at the top, autumn on the left, winter below, tinted through the seasons. A span knob's
// stretch of the year is bright, the rest dim; a choice's seasons are segments that a drag snaps to,
// its options that are no time of year chips beside the dial; a feature's switch is a chip, and
// moving the marker switches it on. The year's cycle is "Year speed", as the day's. Keys on the ring
// step the season. Where the scene keeps no time of day, the ring stands alone round the season's
// glyph and name (seasonWheel).
import { climateCold, climateLying } from "../climate.ts";
import type { Params } from "../state.ts";
import {
  moonElongation,
  moonLit as litShare,
  moonStaging,
  moonWaning,
  skyNow,
} from "../world-clock.ts";
import {
  namedYear,
  seasonPatch,
  seasonSpan,
  seasonStops,
  seasonText,
  stepSeason,
  yearOf,
  type AlmanacParts,
  type SeasonDef,
} from "./almanac-model.ts";
import { row, slider, sliderBehaviour } from "./controls.ts";
import { gate, h, keyStep, setAttr, setStyle, setText, snap, svg, type Built } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { knobIcon, knobKeys, type FeatureDef, type Knobs, type RangeDef } from "./knobs.ts";
import { isNight, moonPath } from "./nightsky-model.ts";
import { speedStops, speedText, stopOf, stopPatch, type Cycle } from "./speed-model.ts";

const C = 60;
const ORBIT = 43;
const TAU = Math.PI * 2;

// The season ring in its own pixels: the wheel, its middle, the band the year runs round and the rim
// outside it, which the marker's knob rides.
const WHEEL = 148;
const MID = WHEEL / 2;
const BAND_IN = 59;
const BAND_OUT = 68;
const BAND = (BAND_IN + BAND_OUT) / 2;
const RIM = 71.5;
const CELLS = 48;
/** The seasons' tints at their middles (spring, summer, autumn, winter); the ring blends between. */
const TINTS: readonly (readonly number[])[] = [
  [140, 207, 110],
  [242, 201, 76],
  [226, 115, 58],
  [168, 200, 232],
];
const SEASON_ICONS: readonly IconName[] = ["sprout", "sun", "leaf", "snow"];
const RING_HELP =
  "On the ring spring is on the right, summer at the top, autumn on the left and winter below: drag round it, or step it with the arrow keys.";
/** Ids for the ring's word paths, unique on the page. */
let rings = 0;

/** "18:45" for a time of day 0..1. */
export function clockOf(time: number): string {
  const minutes = Math.round((((time % 1) + 1) % 1) * 24 * 60) % (24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** The part of the day a time falls in, by the sun's height (sunrise 0.25, sunset 0.75). */
export function daypartOf(time: number): string {
  const t = ((time % 1) + 1) % 1;
  if (isNight(t)) return "night";
  if (t < 0.245) return "dawn";
  if (t < 0.3) return "sunrise";
  if (t < 0.45) return "morning";
  if (t < 0.55) return "noon";
  if (t < 0.69) return "afternoon";
  if (t < 0.755) return "golden hour";
  return "dusk";
}

function mix(a: readonly number[], b: readonly number[], t: number): number[] {
  return a.map((value, index) => value + ((b[index] ?? value) - value) * t);
}

/** A year position's angle on the ring, anticlockwise from the right: mid-spring 0, mid-summer up. */
const yearAngle = (year: number) => (year - 0.125) * TAU;

/** "x y" on the ring's circle of `radius` at a year position. */
function ringPoint(year: number, radius: number): string {
  const angle = yearAngle(year);
  return `${(MID + Math.cos(angle) * radius).toFixed(2)} ${(MID - Math.sin(angle) * radius).toFixed(2)}`;
}

/** The band from year position `from` on to `to` (from < to), between two radii. */
function bandPath(from: number, to: number, inner: number, outer: number): string {
  const large = to - from > 0.5 ? 1 : 0;
  return `M${ringPoint(from, outer)}A${outer} ${outer} 0 ${large} 0 ${ringPoint(to, outer)}L${ringPoint(to, inner)}A${inner} ${inner} 0 ${large} 1 ${ringPoint(from, inner)}Z`;
}

/** The ring's tint at a year position, blended between the seasons' middles. */
function yearTint(year: number): string {
  const t = ((((year - 0.125) % 1) + 1) % 1) * 4;
  const index = Math.floor(t);
  const [r = 0, g = 0, b = 0] = mix(
    TINTS[index % 4] ?? [],
    TINTS[(index + 1) % 4] ?? [],
    t - index,
  );
  return `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`;
}

/**
 * A word set along the band over `from`..`to`, upright on either half: over the top it runs
 * clockwise and stands outward from its baseline, below it runs anticlockwise and stands inward.
 * Nothing where it would not fit.
 */
function bandWord(
  id: string,
  text: string,
  from: number,
  to: number,
): { path: SVGPathElement; word: SVGTextElement } | undefined {
  if (text.length * 4.1 + 6 > (to - from) * TAU * BAND) return undefined;
  const top = Math.sin(yearAngle((from + to) / 2)) > -0.01;
  const radius = top ? BAND - 2 : BAND + 2;
  const d = top
    ? `M${ringPoint(to, radius)}A${radius} ${radius} 0 0 1 ${ringPoint(from, radius)}`
    : `M${ringPoint(from, radius)}A${radius} ${radius} 0 0 0 ${ringPoint(to, radius)}`;
  const along = svg("textPath", { href: `#${id}`, startOffset: "50%", "text-anchor": "middle" });
  along.textContent = text;
  return { path: svg("path", { id, d }), word: svg("text", { class: "almanac-word" }, along) };
}

/** The season knob's URL values, its defaults where unset. */
function seasonParams(knobs: Knobs, season: SeasonDef): Params {
  return Object.fromEntries(knobKeys(season).map((key) => [key, knobs.value(key)]));
}

/**
 * The season ring round `dial` (the sky dial), or round the season's own face (its glyph and name)
 * without one: the year in tints, the knob's seasons on it and a marker where it puts the year.
 */
function seasonRing(
  knobs: Knobs,
  season: SeasonDef,
  year: FeatureDef | undefined,
  dial: HTMLElement | undefined,
): Built {
  const id = `almanac-${++rings}`;
  const stretch = seasonSpan(season);
  const stops = seasonStops(season);
  const live = (at: number) =>
    stretch !== undefined && (((at - stretch.from) % 1) + 1) % 1 <= stretch.length;
  // A hair over each cell's end hides the seams between them; each group fades as a whole, so the
  // overlaps never show.
  const cells = Array.from({ length: CELLS }, (_, index) =>
    svg("path", {
      d: bandPath(index / CELLS, (index + 1.06) / CELLS, BAND_IN, BAND_OUT),
      fill: yearTint((index + 0.5) / CELLS),
    }),
  );
  const bright = cells.filter((_, index) => live((index + 0.5) / CELLS));
  const tints = [
    svg("g", { class: "almanac-tint" }, ...bright),
    svg("g", { class: "almanac-tint dead" }, ...cells.filter((cell) => !bright.includes(cell))),
  ];
  // Where the season sets the climate (a snow knob beside it, src/climate.ts), a dashed line of
  // frost just inside the band over deep winter, the cells where snow lies with none falling.
  const deep = Array.from({ length: CELLS }, (_, index) => index).filter(
    (index) => climateLying(climateCold((index + 0.5) / CELLS)) > 0,
  );
  const [first, last] = [deep[0], deep.at(-1)];
  const snowLine = BAND_IN - 2;
  const frost =
    knobs.def("snow") !== undefined && first !== undefined && last !== undefined
      ? [
          svg("path", {
            class: "almanac-frost",
            d: `M${ringPoint(first / CELLS, snowLine)}A${snowLine} ${snowLine} 0 0 0 ${ringPoint((last + 1) / CELLS, snowLine)}`,
            fill: "none",
            stroke: "#eef3ff",
            "stroke-opacity": "0.7",
            "stroke-width": "1.3",
            "stroke-dasharray": "2 1.6",
          }),
        ]
      : [];
  const segments = stops.map((stop) => {
    const title = svg("title");
    title.textContent = stop.label;
    const gap = Math.min(0.003, (stop.to - stop.from) / 4);
    return svg(
      "path",
      {
        class: "almanac-stop",
        d: bandPath(stop.from + gap, stop.to - gap, BAND_IN, BAND_OUT),
        fill: yearTint(stop.at),
      },
      title,
    );
  });
  // A choice names its seasons on their segments; a span names the year's quarters.
  const words = (
    stops.length > 0
      ? stops.map((stop, index) => bandWord(`${id}-${index}`, stop.label, stop.from, stop.to))
      : ["spring", "summer", "autumn", "winter"].map((name, quarter) => {
          const word = bandWord(`${id}-${quarter}`, name, quarter / 4, (quarter + 1) / 4);
          word?.word.classList.toggle("dead", !live(quarter / 4 + 0.125));
          return word;
        })
  ).flatMap((word) => word ?? []);
  // The marker: a knob on the rim and, over a span, a needle across the band to read it by (a
  // choice's season is its lit segment, its name left whole).
  const knob = svg("circle", { class: "almanac-knob", cx: RIM, cy: 0, r: 2.6 });
  const across = { x1: BAND_IN - 1.5, y1: 0, x2: RIM, y2: 0 };
  const marker = svg(
    "g",
    { class: "almanac-marker" },
    ...(stops.length > 0
      ? []
      : [
          svg("line", { class: "almanac-needle halo", ...across }),
          svg("line", { class: "almanac-needle", ...across }),
        ]),
    knob,
  );
  const face = svg(
    "svg",
    { viewBox: `0 0 ${WHEEL} ${WHEEL}`, class: "almanac-face", "aria-hidden": "true" },
    svg("defs", {}, ...words.map((word) => word.path)),
    svg("circle", { class: "almanac-rim", cx: MID, cy: MID, r: RIM }),
    ...tints,
    ...segments,
    ...frost,
    ...words.map((word) => word.word),
    marker,
  );
  const ring = h(
    "div",
    {
      class: "almanac-ring",
      "aria-label": season.label,
      title:
        stops.length > 0
          ? "Drag round the ring to pick the season; arrow keys step through them"
          : "Drag the marker round the ring; arrow keys step the season",
    },
    face,
  );
  const scale =
    season.kind === "choice"
      ? { min: 0, max: season.options.length - 1, count: stops.length }
      : season.kind === "range" || season.kind === "feature"
        ? { min: season.min, max: season.max, count: (season.max - season.min) / season.step }
        : { min: 0, max: 1, count: 1 };
  const syncSlider = sliderBehaviour(ring, {
    min: scale.min,
    max: scale.max,
    now: () => {
      const params = seasonParams(knobs, season);
      return season.kind === "choice"
        ? season.options.findIndex((option) => option.value === params[season.key])
        : (params[season.kind === "feature" ? `${season.key}-amount` : season.key] ?? 0);
    },
    text: () => seasonText(season, seasonParams(knobs, season)),
    set: (patch, commit) => knobs.set(patch, commit),
    key: (event) => {
      const steps = keyStep(event, 1, scale.count);
      return steps === undefined
        ? undefined
        : stepSeason(season, seasonParams(knobs, season), steps);
    },
    press: (down) => {
      const rect = ring.getBoundingClientRect();
      const point = (pointer: PointerEvent) => ({
        x: ((pointer.clientX - rect.left) / rect.width) * WHEEL - MID,
        y: MID - ((pointer.clientY - rect.top) / rect.height) * WHEEL,
      });
      const start = point(down);
      // The face's middle is no grip (round the dial, the dial takes it).
      if (Math.hypot(start.x, start.y) < BAND_IN - 24) return undefined;
      return (pointer) => {
        const p = point(pointer);
        return Math.hypot(p.x, p.y) < 6
          ? undefined
          : seasonPatch(season, Math.atan2(p.y, p.x) / TAU + 0.125);
      };
    },
  });

  const glyphs = SEASON_ICONS.map((name) => icon(name));
  const name = h("span", { class: "almanac-name" });
  const middle = dial
    ? undefined
    : h("div", { class: "almanac-centre" }, h("span", { class: "almanac-glyph" }, ...glyphs), name);
  // Round the dial, the ring and the season's chips follow the season's row, a gate on what the
  // season hangs on (skyDial; lab.css hides them with it); a wheel's group gates the whole wheel.
  const el = h("div", { class: dial ? "almanac" : "almanac alone" }, dial, ring, middle);
  return {
    el,
    sync: () => {
      const params = seasonParams(knobs, season);
      const at = yearOf(season, params);
      const text = seasonText(season, params);
      const on = season.kind !== "feature" || knobs.on(season.key);
      el.classList.toggle("off", !on);
      el.classList.toggle("passing", year !== undefined && knobs.on(year.key));
      setStyle(marker, "display", at === undefined ? "none" : "");
      if (at !== undefined) {
        const turn = (-yearAngle(at) * 180) / Math.PI;
        setAttr(marker, "transform", `translate(${MID} ${MID}) rotate(${turn.toFixed(1)})`);
        setAttr(knob, "fill", yearTint(at));
      }
      marker.classList.toggle("off", !on);
      segments.forEach((segment, index) =>
        segment.classList.toggle("on", stops[index]?.value === knobs.value(season.key)),
      );
      syncSlider();
      setText(name, text);
      const named = namedYear(season, params);
      const quarter = named === undefined ? -1 : Math.floor((((named % 1) + 1) % 1) * 4);
      glyphs.forEach((glyph, index) => setStyle(glyph, "display", index === quarter ? "" : "none"));
      if (named !== undefined && middle) setStyle(middle, "--tint", yearTint(named));
    },
  };
}

/**
 * The season's switches beside the ring: a feature's on/off, a choice's options that are no time
 * of year (shanshui's "none").
 */
function seasonChips(knobs: Knobs, season: SeasonDef): { chips: HTMLElement[]; sync: () => void } {
  if (season.kind === "feature") {
    const chip = h(
      "button",
      {
        type: "button",
        class: "chip",
        role: "switch",
        title: season.help,
        "aria-label": season.label,
      },
      h("span", { class: "chip-icon" }, icon(knobIcon(season))),
      h("span", { class: "chip-label" }, season.label),
    );
    chip.addEventListener("click", () =>
      knobs.set({ [season.key]: knobs.on(season.key) ? 0 : 1 }, true),
    );
    return {
      chips: [chip],
      sync: () => setAttr(chip, "aria-checked", String(knobs.on(season.key))),
    };
  }
  if (season.kind !== "choice" || !("at" in season.widget.year))
    return { chips: [], sync: () => {} };
  const at = season.widget.year.at;
  const offYear = season.options.filter((_, index) => (at[index] ?? null) === null);
  const chips = offYear.map((option) => {
    const label = `${season.label}: ${option.label}`;
    const chip = h(
      "button",
      { type: "button", class: "chip", title: label, "aria-label": label },
      h("span", { class: "chip-icon" }, icon("minus")),
      h("span", { class: "chip-label" }, option.label),
    );
    chip.addEventListener("click", () => knobs.set({ [season.key]: option.value }, true));
    return { chip, option };
  });
  return {
    chips: chips.map(({ chip }) => chip),
    sync: () => {
      for (const { chip, option } of chips)
        setAttr(chip, "aria-pressed", String(knobs.value(season.key) === option.value));
    },
  };
}

/** What each cycle's speed is called, and what it moves, for its row's label and help. */
const SPEEDS: Readonly<Record<Cycle, { label: string; moves: string }>> = {
  day: { label: "Day speed", moves: "How fast the sun and moon move" },
  year: { label: "Year speed", moves: "How fast the seasons turn" },
};

/**
 * A cycle's speed (the day's, the year's) as one slider of stops: still at the left end (the cycle
 * off), then its amounts from the slowest to the fastest; the readout says how long a turn takes.
 */
function speedRow(knobs: Knobs, def: FeatureDef, cycle: Cycle, iconName: IconName): Built {
  const amountKey = `${def.key}-amount`;
  const { label, moves } = SPEEDS[cycle];
  const text = () => speedText(cycle, knobs.on(def.key), knobs.value(amountKey));
  const control = slider(
    label,
    0,
    speedStops(def),
    1,
    () => stopOf(cycle, def, knobs.on(def.key), knobs.value(amountKey)),
    (stop, commit) =>
      knobs.set(stopPatch(cycle, def, def.key, stop, knobs.default(amountKey)), commit),
    text,
  );
  const [slowest, fastest] = cycle === "day" ? [def.min, def.max] : [def.max, def.min];
  const built = row({
    label,
    help: `${moves}: still at the left end, then from ${speedText(cycle, true, slowest)} up to ${speedText(cycle, true, fastest)} at full motion.`,
    icon: iconName,
    block: control.el,
    readout: text,
    modified: () => knobs.modified(knobKeys(def)),
    reset: () => knobs.reset(knobKeys(def)),
  });
  control.el.after(
    h(
      "div",
      { class: "speed-scale", "aria-hidden": "true" },
      h("span", {}, "still"),
      h("span", {}, "fast"),
    ),
  );
  built.el.classList.add("speed-row");
  built.el.dataset.search = `${built.el.dataset.search ?? ""} ${def.label}`.toLowerCase();
  built.el.dataset.keys = knobKeys(def).join(" ");
  return {
    el: built.el,
    sync: () => {
      control.sync();
      built.sync();
    },
  };
}

/** Add the names of the parts a row gathers to what the panel's search finds it by. */
function searchAlso(el: HTMLElement, names: readonly (string | undefined)[]): void {
  const words = names.flatMap((name) => (name === undefined ? [] : [name]));
  el.dataset.search = [el.dataset.search ?? "", ...words].join(" ").toLowerCase();
}

/**
 * The sky dial's own parts: the time of day, the day cycle, the night's moon and stars it draws, and
 * the date the scene's sky is staged at where the date moves its sky (skyAnchor).
 */
export interface SkyParts {
  time: RangeDef;
  cycle: FeatureDef | undefined;
  moon: FeatureDef | undefined;
  stars: RangeDef | undefined;
  anchor: number | undefined;
}

export function skyDial(
  knobs: Knobs,
  { time, cycle, moon, stars: starKnob, anchor }: SkyParts,
  { season, year }: AlmanacParts,
): Built {
  const angleOf = (t: number) => (t - 0.25) * TAU;
  const at = (angle: number, radius = ORBIT) => ({
    x: C + Math.cos(angle) * radius,
    y: C - Math.sin(angle) * radius,
  });

  const day = svg("path", { class: "sky-day", d: `M3 ${C}A57 57 0 0 1 117 ${C}Z` });
  const night = svg("path", { class: "sky-night", d: `M3 ${C}A57 57 0 0 0 117 ${C}Z` });
  // In the order they come out as the stars knob rises; a scene without one keeps the first seven.
  const stars = [
    [30, 74],
    [46, 92],
    [78, 98],
    [92, 78],
    [62, 84],
    [22, 88],
    [100, 92],
    [40, 82],
    [84, 90],
    [54, 100],
    [16, 70],
    [70, 104],
  ].map(([x, y]) => svg("circle", { class: "sky-star", cx: x ?? 0, cy: y ?? 0, r: 0.9 }));
  const ticks = Array.from({ length: 24 }, (_, hour) => {
    const angle = angleOf(hour / 24);
    const major = hour % 6 === 0;
    const a = at(angle, ORBIT + 5);
    const b = at(angle, ORBIT + (major ? 10 : 7.5));
    return svg("line", {
      class: major ? "sky-tick major" : "sky-tick",
      x1: a.x.toFixed(2),
      y1: a.y.toFixed(2),
      x2: b.x.toFixed(2),
      y2: b.y.toFixed(2),
    });
  });
  const orbit = svg("circle", { class: "sky-orbit", cx: C, cy: C, r: ORBIT });
  const sunGlow = svg("circle", { class: "sky-sun-glow", r: 10 });
  const sunDisc = svg("circle", { class: "sky-sun", r: 6 });
  const sun = svg("g", { class: "sky-body" }, sunGlow, sunDisc);
  const moonDisc = svg("circle", { class: "sky-moon-disc", r: 5.5 });
  const moonLit = svg("path", { class: "sky-moon-lit" });
  const moonBody = svg("g", {}, moonDisc, moonLit);
  const moonGroup = svg("g", { class: "sky-body" }, moonBody);
  const clock = svg("text", { class: "sky-clock", x: C, y: C - 8 });
  const part = svg("text", { class: "sky-part", x: C, y: C + 16 });
  const face = svg(
    "svg",
    { viewBox: "0 0 120 120", class: "sky-face", "aria-hidden": "true" },
    day,
    night,
    ...stars,
    svg("line", { class: "sky-horizon", x1: 3, y1: C, x2: 117, y2: C }),
    ...ticks,
    orbit,
    moonGroup,
    sun,
    clock,
    part,
  );
  const dial = h(
    "div",
    {
      class: "sky-dial",
      "aria-label": time.label,
      title: "Drag the sun or the moon round; arrow keys step the hour",
    },
    face,
  );

  const phase = () => (moon ? knobs.value(`${moon.key}-amount`) : 1);
  const lit = () => litShare(phase());
  const moonShown = () => moon === undefined || knobs.on(moon.key);
  /**
   * How far round the dial the moon trails the sun: its elongation in its phase (a waning moon
   * leads it, so the rest of the turn), moved onto the staged full moon's half a day as it nears
   * full, as the sky moves it (moonStaging).
   */
  const lag = () => {
    const staging = moonStaging(lit());
    const elongation = moonElongation(lit());
    return (
      (moonWaning(phase()) ? TAU - elongation : elongation) * (1 - staging) + Math.PI * staging
    );
  };
  const timeAt = (value: number) => ({
    [time.key]: snap(((value % 1) + 1) % 1, time.min, time.max, time.step),
  });
  const syncSlider = sliderBehaviour(dial, {
    min: 0,
    max: 1,
    now: () => knobs.value(time.key),
    text: () => `${clockOf(knobs.value(time.key))}, ${daypartOf(knobs.value(time.key))}`,
    set: (patch, commit) => knobs.set(patch, commit),
    key: (event) => {
      const value = knobs.value(time.key);
      const big = 1 / 24 >= time.step ? Math.round(1 / 24 / time.step) * time.step : time.step;
      if (event.key === "ArrowRight" || event.key === "ArrowUp") return timeAt(value + time.step);
      if (event.key === "ArrowLeft" || event.key === "ArrowDown") return timeAt(value - time.step);
      if (event.key === "PageUp") return timeAt(value + big * 3);
      if (event.key === "PageDown") return timeAt(value - big * 3);
      if (event.key === "Home") return timeAt(0);
      if (event.key === "End") return timeAt(0.5);
      return undefined;
    },
    press: (down) => {
      const rect = face.getBoundingClientRect();
      const point = (pointer: PointerEvent) => ({
        x: ((pointer.clientX - rect.left) / rect.width) * 120,
        y: ((pointer.clientY - rect.top) / rect.height) * 120,
      });
      const start = point(down);
      const moonAt = at(angleOf(knobs.value(time.key)) - lag());
      const grabbedMoon = moonShown() && Math.hypot(start.x - moonAt.x, start.y - moonAt.y) < 12;
      return (pointer) => {
        const p = point(pointer);
        if (Math.hypot(p.x - C, p.y - C) < 6) return undefined;
        const angle = Math.atan2(C - p.y, p.x - C) + (grabbedMoon ? lag() : 0);
        return timeAt(angle / TAU + 0.25);
      };
    },
  });

  const ring = season ? seasonRing(knobs, season, year, dial) : undefined;
  const side = h("div", { class: "sky-side" });
  const timeRow = row({
    label: time.label,
    help: `${time.help} Drag the sun round the dial (or the moon behind it); arrow keys step it, Home is midnight and End noon.`,
    icon: "sky",
    block: h("div", { class: "sky" }, ring?.el ?? dial, side),
    modified: () => knobs.modified([time.key]),
    reset: () => knobs.reset([time.key]),
  });
  timeRow.el.classList.add("sky-row");
  searchAlso(timeRow.el, [
    ...(cycle ? [SPEEDS.day.label, cycle.label] : []),
    season?.label,
    ...(year ? [SPEEDS.year.label, year.label] : []),
  ]);

  const syncs: (() => void)[] = [
    timeRow.sync,
    () => {
      const value = knobs.value(time.key);
      const angle = angleOf(value);
      // The scene's sky at the knob's hour: its moon in its phase and, where it is dated, its date.
      const sky = skyNow({
        time: value,
        days: 0,
        phase: moonShown() ? phase() : 0,
        year:
          season && anchor !== undefined ? (yearOf(season, seasonParams(knobs, season)) ?? -1) : -1,
        anchor: anchor ?? -1,
      });
      const [r = 0, g = 0, b = 0] = mix(
        mix([16, 21, 38], [48, 80, 122], sky.day),
        [214, 118, 62],
        sky.twilight * 0.55,
      );
      setAttr(day, "fill", `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`);
      const sunAt = at(angle);
      setAttr(sun, "transform", `translate(${sunAt.x.toFixed(2)} ${sunAt.y.toFixed(2)})`);
      sun.classList.toggle("below", sky.sun[1] < 0);
      const moonAngle = angle - lag();
      const moonAt = at(moonAngle);
      setAttr(moonGroup, "transform", `translate(${moonAt.x.toFixed(2)} ${moonAt.y.toFixed(2)})`);
      // The lit side faces the sun, along the chord between them.
      const toSun = (angle + moonAngle) / 2 + Math.PI / 2;
      setAttr(moonBody, "transform", `rotate(${((-toSun * 180) / Math.PI).toFixed(1)})`);
      moonGroup.classList.toggle("below", sky.moon[1] < 0);
      moonGroup.classList.toggle("off", !moonShown());
      setAttr(moonLit, "d", moonPath(5.5, moonShown() ? lit() : 0));
      setText(clock, clockOf(value));
      setText(part, daypartOf(value));
      const density = starKnob
        ? (knobs.value(starKnob.key) - starKnob.min) / (starKnob.max - starKnob.min)
        : 7 / stars.length;
      stars.forEach((star, index) => {
        star.classList.toggle("lit", sky.night > 0);
        star.classList.toggle("out", index >= Math.round(density * stars.length));
      });
      syncSlider();
      dial.classList.toggle("cycling", cycle !== undefined && knobs.on(cycle.key));
    },
  ];
  // The season's row stands right under the dial, its chips beside it; the speeds follow. The row
  // is a gate on what the season hangs on; the ring and the chips follow it (lab.css).
  if (ring && season) {
    const chips = seasonChips(knobs, season);
    side.append(...chips.chips);
    const seasonRow = row({
      label: season.label,
      help: `${season.help} ${RING_HELP}`,
      icon: knobIcon(season),
      readout: () => seasonText(season, seasonParams(knobs, season)),
      modified: () => knobs.modified(knobKeys(season)),
      reset: () => knobs.reset(knobKeys(season)),
    });
    seasonRow.el.classList.add("season-row");
    seasonRow.el.dataset.keys = knobKeys(season).join(" ");
    if (season.when !== undefined)
      gate(seasonRow.el, knobs.chain(season.when), () => knobs.live(season.when));
    timeRow.el.append(seasonRow.el);
    syncs.push(ring.sync, chips.sync, seasonRow.sync);
  }
  for (const speed of [
    cycle && speedRow(knobs, cycle, "day", "clock"),
    year && speedRow(knobs, year, "year", knobIcon(year)),
  ]) {
    if (!speed) continue;
    timeRow.el.append(speed.el);
    syncs.push(speed.sync);
  }
  return {
    el: timeRow.el,
    sync: () => {
      for (const sync of syncs) sync();
    },
  };
}

/**
 * The season parts of a scene that keeps no time of day: the ring round the season's own face, its
 * switches beside it and the year's speed under it.
 */
export function seasonWheel(knobs: Knobs, season: SeasonDef, year: FeatureDef | undefined): Built {
  const ring = seasonRing(knobs, season, year, undefined);
  const chips = seasonChips(knobs, season);
  const side = h("div", { class: "sky-side" }, ...chips.chips);
  const wheelRow = row({
    label: season.label,
    help: `${season.help} ${RING_HELP}`,
    icon: knobIcon(season),
    block: h("div", { class: "sky" }, ring.el, side),
    modified: () => knobs.modified(knobKeys(season)),
    reset: () => knobs.reset(knobKeys(season)),
  });
  wheelRow.el.classList.add("sky-row");
  searchAlso(wheelRow.el, year ? [SPEEDS.year.label, year.label] : []);
  const syncs = [wheelRow.sync, ring.sync, chips.sync];
  if (year) {
    const speed = speedRow(knobs, year, "year", knobIcon(year));
    wheelRow.el.append(speed.el);
    syncs.push(speed.sync);
  }
  return {
    el: wheelRow.el,
    sync: () => {
      for (const sync of syncs) sync();
    },
  };
}
