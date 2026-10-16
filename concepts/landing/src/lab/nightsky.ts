// The Night sky section: every sky component a group holds (knobs tagged `night`: the moon, the
// stars, the Milky Way, constellations, the giant planet, the aurora, shooting stars; any of them)
// under one heading. A drawn night shows each part in its state, dim and dashed while off and lit
// with its amount while on (a click on a drawn part switches it). Under it the controls, one per
// part: the moon's phases as drawn moons with "off" (a radio group, as the birds card's species),
// the stars' density as a fader chip without a switch, and every other part as a fader chip
// (chips.ts: a click switches it, a drag across or the arrow keys set how much; the shooting stars
// keep their "now", which falls on the drawing too). A part's companions, the knobs that hang off
// its switch (the giant planet's placement, palette, ring, moons and features), show under the
// chips while it is on: a placement on the position pad, switches as chips, the rest as rows. While
// the scene's clock stands in daylight (or the day passes), "See it at night" sets a night hour as
// one change. nightsky-model.ts holds the rules.
import { formatValue, type ParamDef } from "../params.ts";
import { chipKey, pace, pressMove, type Press } from "./chips-model.ts";
import { chipGrid } from "./chips.ts";
import { row, textButton } from "./controls.ts";
import { drag, h, reveal, snap, svg, type Built } from "./dom.ts";
import { tileStep } from "./flyway-model.ts";
import { icon } from "./icons.ts";
import {
  knobIcon,
  knobKeys,
  type FeatureDef,
  type Knobs,
  type RangeDef,
  type SwitchDef,
} from "./knobs.ts";
import {
  amountKey,
  clickPatch,
  giantDress,
  giantLook,
  MOON_PHASES,
  moonPatch,
  moonPath,
  NIGHT_STARS,
  nightCompanions,
  nightPatch,
  nightSummary,
  partValue,
  phaseIndex,
  shareOf,
  starsOut,
  streaksOf,
  type GiantDress,
  type NightClock,
  type NightPart,
  type NightPartName,
  type PartState,
} from "./nightsky-model.ts";
import { positionPad } from "./pads.ts";

const HELP =
  "What the sky shows once it is dark: the moon in its phase, and each part on or off with how much of it there is.";

// ---- the drawing: a 240 x 80 night over a dark horizon ------------------------------------------

const WIDTH = 240;
const HEIGHT = 80;
/** The open sky above the hills, where the stars stand. */
const SKY = { left: 4, top: 4, width: 232, height: 62 } as const;
/** How many stars stand, faint, in a night whose group has no stars knob. */
const GHOST_STARS = 14;
/** How long a "now" plays on the drawing (a meteor falling), in ms. */
const PLAYING = 900;
const MOON = { x: 219, y: 17, r: 8 } as const;
/** The Plough, after constellations.ts's Big Dipper: its stars and the lines between them. */
const FIGURE = {
  stars: [
    [35, 12.5],
    [46.6, 8.6],
    [58.2, 9.4],
    [69.7, 12.5],
    [72, 24.8],
    [89, 23.2],
    [88.2, 9.4],
  ],
  lines: [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
    [5, 6],
    [6, 3],
  ],
} as const;
/** The giant planet's tint in each of its palettes (GIANT_PALETTES in scenes/planet.ts), teal's first. */
const GIANT_TINTS: Readonly<Record<string, string>> = {
  teal: "#5fae98",
  amber: "#d99a45",
  rose: "#c9708f",
  ice: "#8fb4e6",
};
/**
 * Where the drawn giant stands: its centre from `left` to `right` across the sky and from `low`
 * over the hills to `high`, its radius from `small` to `large` with its size.
 */
const GIANT = { left: 16, right: 224, low: 58, high: 16, small: 4, large: 10 } as const;
/**
 * The giant's two bands, each its height on the disc in radii, and its moons on its ring's plane,
 * each its turn round it in degrees.
 */
const GIANT_BANDS = [-0.38, 0.22] as const;
const GIANT_MOONS = [160, 20, 300] as const;

/** A part as drawn: its group, and what of its state shows beyond on/off and its level. */
interface Art {
  el: SVGGElement;
  sync?: (state: PartState, share: number) => void;
  play?: () => void;
}

/** Each section's gradients need ids of their own. */
let sections = 0;

const circle = (className: string, x: number, y: number, r: number) =>
  svg("circle", { class: className, cx: x.toFixed(2), cy: y.toFixed(2), r: r.toFixed(2) });

/** The star field, in the order the stars come out; a ghost of a few where the group has no stars. */
function starArt(ghost: boolean): Art {
  const stars = NIGHT_STARS.map((star, index) => {
    const el = circle(
      `night-star${index % 4 === 1 ? " twinkle" : ""}`,
      SKY.left + star.x * SKY.width,
      SKY.top + star.y * SKY.height,
      0.55 + star.size * 0.6,
    );
    el.style.setProperty("--glint", star.size.toFixed(2));
    el.style.setProperty("--delay", `${(-index * 0.37).toFixed(2)}s`);
    return el;
  });
  const show = (out: number) =>
    stars.forEach((star, index) => star.classList.toggle("out", index >= out));
  if (ghost) show(GHOST_STARS);
  return {
    el: svg("g", { class: ghost ? "night-stars ghost" : "night-stars" }, ...stars),
    sync: (_, share) => show(starsOut(share, stars.length)),
  };
}

/** The moon high on the right, lit from the right over its phase, in a halo as bright as it is full. */
function moonArt(): Art {
  const lit = svg("path", { class: "night-moon-lit" });
  return {
    el: svg(
      "g",
      { class: "night-moon", "data-part": "moon" },
      circle("night-moon-halo", MOON.x, MOON.y, MOON.r * 1.9),
      svg(
        "g",
        { transform: `translate(${MOON.x} ${MOON.y})` },
        circle("night-moon-disc", 0, 0, MOON.r),
        lit,
      ),
    ),
    sync: (state) => lit.setAttribute("d", moonPath(MOON.r, state.on ? state.amount : 0)),
  };
}

/** The Milky Way rising from the horizon: a soft band, its brighter core, its dark lane of dust. */
function bandArt(): Art {
  // The band's centre line (a cubic), for the stars crowding into it.
  const centre = [
    [95, 70],
    [115, 47],
    [135, 23],
    [153, 0],
  ] as const;
  const crowd = Array.from({ length: 18 }, (_, index) => {
    const t = (index + 0.5) / 18;
    const weights = [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
    let x = 0;
    let y = 0;
    for (const [at, [px, py]] of centre.entries()) {
      x += px * (weights[at] ?? 0);
      y += py * (weights[at] ?? 0);
    }
    // Off the centre line across the band (along its normal), side to side.
    const off = (index % 2 === 0 ? 1 : -1) * (2 + ((index * 7) % 5));
    return circle("night-crowd", x + off * 0.75, y + off * 0.65, index % 3 === 0 ? 0.9 : 0.6);
  });
  return {
    el: svg(
      "g",
      { class: "night-band", "data-part": "milkyWay" },
      svg("path", {
        class: "night-band-outer",
        d: "M84 70C104 47 124 23 143 0H163C145 23 125 47 106 70Z",
      }),
      svg("path", {
        class: "night-band-core",
        d: "M91 70C111 47 131 23 150 0H156C138 23 118 47 99 70Z",
      }),
      ...crowd,
      svg("path", { class: "night-lane", d: "M97 69C117 46 137 22 155 0" }),
    ),
  };
}

/** Curtains of light hanging over the horizon on the left, coloured by `gradient` from their feet up. */
function auroraArt(gradient: string): Art {
  const curtains = [
    [14, 34],
    [28, 28],
    [42, 32],
    [56, 38],
  ].map(([x = 0, top = 0], index) => {
    const d = `M${x} 70C${x - 6} 56 ${x + 7} 44 ${x + 2} ${top}`;
    const curtain = svg(
      "g",
      { class: "night-curtain" },
      svg("path", { class: "night-glow", d, stroke: `url(#${gradient})` }),
      svg("path", { class: "night-ribbon", d, stroke: `url(#${gradient})` }),
    );
    curtain.style.setProperty("--delay", `${(-index * 1.3).toFixed(1)}s`);
    return curtain;
  });
  return { el: svg("g", { class: "night-aurora", "data-part": "aurora" }, ...curtains) };
}

/** The Plough over the aurora: its stars stand out, its lines as clear as the amount. */
function figureArt(): Art {
  const lines = FIGURE.lines.map(([a, b]) => {
    const [x1, y1] = FIGURE.stars[a];
    const [x2, y2] = FIGURE.stars[b];
    return svg("line", { class: "night-figure-line", x1, y1, x2, y2 });
  });
  const stars = FIGURE.stars.map(([x, y]) => circle("night-figure-star", x, y, 1.25));
  return {
    el: svg(
      "g",
      { class: "night-figure", "data-part": "constellations" },
      svg("g", {}, ...lines),
      ...stars,
    ),
  };
}

/**
 * The giant planet where its placement puts it (giantLook), as big as its size: a disc in its
 * palette's tint with two bands and a thin ring tipped across it (the far half behind the disc),
 * its moons on the ring's plane. `clip` names the clip path that keeps the bands on the disc.
 */
function giantArt(knobs: Knobs, giant: FeatureDef, dress: GiantDress, clip: string): Art {
  const back = svg("path", { class: "night-giant-ring" });
  const front = svg("path", { class: "night-giant-ring" });
  const disc = circle("night-giant-disc", 0, 0, GIANT.small);
  const edge = circle("", 0, 0, GIANT.small);
  const bands = GIANT_BANDS.map((at) => ({
    at,
    el: svg("ellipse", { class: "night-giant-band" }),
  }));
  const moons = GIANT_MOONS.map(() => circle("night-giant-moon", 0, 0, 1));
  const tipped = svg(
    "g",
    { transform: "rotate(-18)" },
    back,
    disc,
    svg("clipPath", { id: clip }, edge),
    svg("g", { "clip-path": `url(#${clip})` }, ...bands.map((band) => band.el)),
    front,
    ...moons,
  );
  const el = svg("g", { class: "night-giant", "data-part": "giant" }, tipped);
  const title = svg("title");
  title.textContent = giant.label;
  el.prepend(title);
  return {
    el,
    sync: () => {
      const look = giantLook(giant, dress, (key) => knobs.value(key));
      const x = GIANT.left + look.x * (GIANT.right - GIANT.left);
      const y = GIANT.low - look.y * (GIANT.low - GIANT.high);
      const r = GIANT.small + look.size * (GIANT.large - GIANT.small);
      el.setAttribute("transform", `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
      for (const each of [disc, edge]) each.setAttribute("r", r.toFixed(2));
      for (const band of bands) {
        band.el.setAttribute("cy", (band.at * r).toFixed(2));
        band.el.setAttribute("rx", (r * 1.05).toFixed(2));
        band.el.setAttribute("ry", (r * 0.16).toFixed(2));
      }
      const rx = r * 2.05;
      const ry = r * 0.42;
      back.setAttribute("d", `M${-rx} 0A${rx} ${ry} 0 0 1 ${rx} 0`);
      front.setAttribute("d", `M${-rx} 0A${rx} ${ry} 0 0 0 ${rx} 0`);
      el.classList.toggle("ringless", !look.ring);
      moons.forEach((moon, index) => {
        const turn = ((GIANT_MOONS[index] ?? 0) * Math.PI) / 180;
        moon.setAttribute("cx", (Math.cos(turn) * r * 1.8).toFixed(2));
        moon.setAttribute("cy", (-Math.sin(turn) * r * 0.5).toFixed(2));
        moon.setAttribute("r", Math.max(1, r * 0.13).toFixed(2));
        moon.classList.toggle("gone", index >= look.moons);
      });
      disc.style.setProperty("--tint", GIANT_TINTS[look.palette] ?? "#5fae98");
    },
  };
}

/** Shooting stars: three streaks falling to the left, coloured by `gradient` from tail to head. */
function meteorArt(gradient: string): Art {
  const streaks = [
    [204, 6, 180, 24],
    [189, 2, 174, 12],
    [208, 25, 194, 35],
  ].map(([x1 = 0, y1 = 0, x2 = 0, y2 = 0]) =>
    svg(
      "g",
      { class: "night-streak" },
      svg("line", { class: "night-tail", x1, y1, x2, y2, stroke: `url(#${gradient})` }),
      circle("night-head", x2, y2, 1.4),
    ),
  );
  const flash = svg("line", { class: "night-flash", x1: 206, y1: 2, x2: 176, y2: 26 });
  const el = svg("g", { class: "night-meteor", "data-part": "meteors" }, ...streaks, flash);
  let playing: number | undefined;
  return {
    el,
    sync: (state, share) => {
      // Off, the first streak stays as the shooting stars' dim outline.
      const shown = Math.max(1, streaksOf(state.on, share));
      streaks.forEach((streak, index) => streak.classList.toggle("gone", index >= shown));
    },
    play: () => {
      el.classList.remove("firing");
      void el.getBoundingClientRect();
      el.classList.add("firing");
      window.clearTimeout(playing);
      playing = window.setTimeout(() => el.classList.remove("firing"), PLAYING);
    },
  };
}

/**
 * A part's drawing; the stars' field is drawn whether or not they are a part. The giant follows its
 * companions (nightCompanions).
 */
function artOf(
  knobs: Knobs,
  part: Exclude<NightPart, { name: "stars" }>,
  companions: readonly ParamDef[],
  id: string,
): Art {
  switch (part.name) {
    case "moon":
      return moonArt();
    case "milkyWay":
      return bandArt();
    case "aurora":
      return auroraArt(`${id}-aurora`);
    case "constellations":
      return figureArt();
    case "giant":
      return giantArt(knobs, part.def, giantDress(part.def, companions), `${id}-giant`);
    case "meteors":
      return meteorArt(`${id}-meteor`);
    default: {
      const never: never = part.name;
      throw new Error(`night sky: no drawing for ${String(never)}`);
    }
  }
}

/** The drawing's layers, back to front. */
const LAYERS: readonly Exclude<NightPartName, "stars">[] = [
  "milkyWay",
  "aurora",
  "constellations",
  "giant",
  "meteors",
  "moon",
];

// ---- the controls ------------------------------------------------------------------------------

/** A control's "changed" dot, which resets its keys. */
function changedDot(knobs: Knobs, label: string, keys: readonly string[]): HTMLButtonElement {
  const dot = h("button", {
    type: "button",
    class: "modified",
    title: "Changed: click to reset",
    "aria-label": `Reset ${label}`,
  });
  dot.addEventListener("click", () => knobs.reset(keys));
  return dot;
}

/**
 * The stars' density as a fader chip without a switch (the stars are always out): the amount fills
 * the chip and shows on it on hover, focus and drag; a drag across sets it and arrow keys step it
 * (chips-model.ts); double-clicking the amount resets it.
 */
function starsChip(knobs: Knobs, def: RangeDef): Built {
  const fill = h("span", { class: "chip-fill" });
  const amount = h("span", { class: "chip-amount" });
  const chip = h(
    "div",
    {
      class: "chip fader always",
      role: "slider",
      tabIndex: 0,
      "aria-label": def.label,
      "aria-valuemin": String(def.min),
      "aria-valuemax": String(def.max),
    },
    fill,
    h("span", { class: "chip-icon" }, icon(knobIcon(def))),
    h("span", { class: "chip-label" }, def.label),
    amount,
  );
  const set = (value: number, commit: boolean) => knobs.set({ [def.key]: value }, commit);
  let onAmount = false;
  chip.addEventListener("pointerdown", (event) => {
    onAmount =
      event.pointerType === "mouse" &&
      event.target instanceof Node &&
      amount.contains(event.target);
    if (event.button !== 0) return;
    const perPixel = pace(def, chip.getBoundingClientRect().width);
    let press: Press = {
      x: event.clientX,
      y: event.clientY,
      value: knobs.value(def.key),
      scrub: undefined,
    };
    let last: number | undefined;
    drag(
      event,
      chip,
      (pointer) => {
        press = pressMove(press, pointer.clientX, pointer.clientY, perPixel, pointer.shiftKey, def);
        if (!press.scrub) return;
        chip.classList.add("dragging");
        const value = snap(press.scrub.value, def.min, def.max, def.step);
        if (value === last) return;
        last = value;
        set(value, false);
      },
      () => {
        chip.classList.remove("dragging");
        if (last !== undefined) set(last, true);
      },
    );
  });
  chip.addEventListener("dblclick", () => {
    if (onAmount) knobs.reset([def.key]);
  });
  chip.addEventListener("keydown", (event) => {
    const next = chipKey(event, true, knobs.value(def.key), def);
    if (next === undefined) return;
    event.preventDefault();
    set(next, true);
  });
  const dot = changedDot(knobs, def.label, [def.key]);
  const cell = h(
    "div",
    {
      class: "chip-cell on",
      "data-search": `${def.label} ${def.help}`.toLowerCase(),
      "data-keys": def.key,
    },
    dot,
    chip,
    h("p", { class: "hint" }, `${def.label}: ${def.help}`),
  );
  return {
    el: cell,
    sync: () => {
      const value = knobs.value(def.key);
      const text = formatValue(def, value);
      fill.style.setProperty("--fill", `${(shareOf(def, value) * 100).toFixed(2)}%`);
      amount.textContent = text;
      chip.setAttribute("aria-valuenow", String(value));
      chip.setAttribute("aria-valuetext", text);
      chip.title = `${def.help} ${def.label} ${text}: drag across the chip or use the arrow keys.`;
      cell.hidden = !knobs.on(def.when);
      dot.hidden = !knobs.modified([def.key]);
    },
  };
}

/** A small moon lit over `lit` of it (none: an empty dashed disc). */
function moonGlyph(lit: number | undefined): SVGSVGElement {
  return svg(
    "svg",
    {
      class: "night-moon-glyph",
      viewBox: "-10 -10 20 20",
      "aria-hidden": "true",
      focusable: "false",
    },
    circle("night-moon-glyph-disc", 0, 0, 7.5),
    ...(lit === undefined
      ? []
      : [svg("path", { class: "night-moon-glyph-lit", d: moonPath(7.5, lit) })]),
  );
}

/**
 * The moon's row: off and its phases as drawn moons, a radio group (a click or the arrow keys
 * choose); the readout names the phase it is at.
 */
function moonRow(knobs: Knobs, def: FeatureDef): Built {
  const key = `${def.key}-amount`;
  const choices: readonly { phase: number | undefined; label: string; lit: number | undefined }[] =
    [
      { phase: undefined, label: "off", lit: undefined },
      ...MOON_PHASES.map((each, phase) => ({ phase, label: each.name, lit: each.lit })),
    ];
  const tiles = choices.map((choice) => {
    const button = h(
      "button",
      {
        type: "button",
        role: "radio",
        class: "night-moon-tile",
        "aria-label": choice.lit === undefined ? "no moon" : `${choice.label} moon`,
        title:
          choice.lit === undefined
            ? "No moon: a moonless night"
            : `${choice.label}: ${Math.round(choice.lit * 100)}% lit`,
      },
      moonGlyph(choice.lit),
      h("span", { class: "night-moon-tile-label" }, choice.label),
    );
    button.addEventListener("click", () => knobs.set(moonPatch(def, choice.phase), true));
    return { choice, button };
  });
  const chosen = () => (knobs.value(def.key) > 0.5 ? phaseIndex(knobs.value(key)) + 1 : 0);
  const group = h(
    "div",
    { class: "night-moons", role: "radiogroup", "aria-label": `${def.label} ${def.amountLabel}` },
    ...tiles.map((tile) => tile.button),
  );
  group.addEventListener("keydown", (event) => {
    const focused = tiles.findIndex((tile) => tile.button === document.activeElement);
    const next = tileStep(event.key, focused >= 0 ? focused : chosen(), tiles.length);
    const target = next === undefined ? undefined : tiles[next];
    if (!target) return;
    event.preventDefault();
    knobs.set(moonPatch(def, target.choice.phase), true);
    target.button.focus();
  });
  const part: NightPart = { name: "moon", def };
  const built = row({
    label: def.label,
    help: def.help,
    icon: knobIcon(def),
    block: group,
    readout: () => partValue(part, { on: knobs.value(def.key) > 0.5, amount: knobs.value(key) }),
    modified: () => knobs.modified(knobKeys(def)),
    reset: () => knobs.reset(knobKeys(def)),
  });
  built.el.classList.add("night-moon-row");
  built.el.dataset.keys = knobKeys(def).join(" ");
  return {
    el: built.el,
    sync: () => {
      built.sync();
      const at = chosen();
      tiles.forEach(({ button }, index) => {
        button.setAttribute("aria-checked", String(index === at));
        button.tabIndex = index === at ? 0 : -1;
      });
      built.el.hidden = !knobs.on(def.when);
    },
  };
}

/** "See it at night": shown while the clock stands in daylight or the day passes. */
function nightButton(knobs: Knobs, clock: NightClock): Built {
  const cycling = () => clock.cycle !== undefined && knobs.on(clock.cycle.key);
  const patch = () => nightPatch(clock, knobs.value(clock.time.key), cycling());
  const note = h("span", { class: "night-day-note" });
  const button = textButton(
    "moon",
    "See it at night",
    "Set the clock to late evening, the day standing still: one change, undone in one step",
    () => {
      const night = patch();
      if (night) knobs.set(night, true);
    },
  );
  const el = h("div", { class: "night-day" }, note, button);
  return {
    el,
    sync: () => {
      el.hidden = patch() === undefined;
      note.textContent = cycling() ? "The day is passing." : "Daytime in the scene.";
    },
  };
}

/**
 * The controls of a part's companions (nightCompanions), shown while the part is on: a placement on
 * the position pad (a range with a `position` widget, and its y), the switches as chips (a count's
 * segments under them while it is on), every other knob as `knobRow` makes it, each shown while what
 * it hangs off is on.
 */
function companionControls(
  knobs: Knobs,
  part: FeatureDef,
  companions: readonly ParamDef[],
  knobRow: (def: Exclude<ParamDef, SwitchDef>) => Built,
): Built {
  const placed = new Set<ParamDef>();
  const pads = companions.flatMap((def) => {
    const widget = def.widget;
    if (def.kind !== "range" || widget?.kind !== "position") return [];
    const y = companions.find(
      (other): other is RangeDef => other.kind === "range" && other.key === widget.y,
    );
    if (!y) return [];
    placed.add(def).add(y);
    const pad = positionPad(knobs, def, y, widget.screen);
    pad.el.dataset.keys = `${def.key} ${y.key}`;
    return [pad];
  });
  const switches = companions.filter(
    (def): def is SwitchDef => def.kind === "toggle" || def.kind === "feature",
  );
  const chips = switches.length > 0 ? chipGrid(knobs, switches) : undefined;
  const rows = companions.flatMap((def): Built[] => {
    if (placed.has(def) || def.kind === "toggle" || def.kind === "feature") return [];
    const built = knobRow(def);
    built.el.dataset.keys = def.key;
    if (def.when === part.key) return [built];
    const shown = reveal(built.el, () => knobs.on(def.when));
    return [
      {
        el: shown.el,
        sync: () => {
          built.sync();
          shown.sync();
        },
      },
    ];
  });
  const block = h(
    "div",
    { class: "night-companions" },
    ...pads.map((pad) => pad.el),
    chips?.grid.el,
    chips?.amounts.el,
    ...rows.map((each) => each.el),
  );
  const shown = reveal(block, () => knobs.on(part.key));
  return {
    el: shown.el,
    sync: () => {
      for (const each of [...pads, ...rows]) each.sync();
      chips?.grid.sync();
      chips?.amounts.sync();
      shown.sync();
    },
  };
}

// ---- the section -------------------------------------------------------------------------------

/**
 * The Night sky section for a group's night parts (nightParts: at least one), with their companions
 * among the group's knobs (`defs`; `row` lays out a range or a choice as the group's rows are);
 * `clock` is the scene's time of day and day cycle, for "See it at night" (none: no button).
 */
export function nightSection(
  knobs: Knobs,
  parts: readonly NightPart[],
  clock: NightClock | undefined,
  group: { defs: readonly ParamDef[]; row: (def: Exclude<ParamDef, SwitchDef>) => Built },
): Built {
  const id = `night-${++sections}`;
  const stateOf = (part: NightPart): PartState => ({
    on: part.name === "stars" || knobs.value(part.def.key) > 0.5,
    amount: knobs.value(amountKey(part)),
  });
  const companions = new Map(parts.map((part) => [part, nightCompanions(part, group.defs)]));

  // The drawing: every part present, each linked to its control.
  const starPart = parts.find((part) => part.name === "stars");
  const field = starArt(starPart === undefined);
  const drawn = parts.map((part) => ({
    part,
    art: part.name === "stars" ? field : artOf(knobs, part, companions.get(part) ?? [], id),
  }));
  const layered = LAYERS.flatMap((name) =>
    drawn.flatMap(({ part, art }) => (part.name === name ? [art.el] : [])),
  );
  const drawing = svg(
    "svg",
    {
      class: "night-art",
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
      "aria-hidden": "true",
      focusable: "false",
    },
    svg(
      "defs",
      {},
      svg(
        "linearGradient",
        { id: `${id}-sky`, x1: 0, y1: 0, x2: 0, y2: 1 },
        svg("stop", { offset: 0, "stop-color": "#05070f" }),
        svg("stop", { offset: 1, "stop-color": "#17203a" }),
      ),
      // Up a curtain (its bounding box, foot to top) and along a streak (tail, top right, to head).
      svg(
        "linearGradient",
        { id: `${id}-aurora`, x1: 0, y1: 1, x2: 0, y2: 0 },
        svg("stop", { offset: 0, "stop-color": "#5df2a6", "stop-opacity": 0.95 }),
        svg("stop", { offset: 0.55, "stop-color": "#4fd8b0", "stop-opacity": 0.75 }),
        svg("stop", { offset: 1, "stop-color": "#a07bff", "stop-opacity": 0.15 }),
      ),
      svg(
        "linearGradient",
        { id: `${id}-meteor`, x1: 1, y1: 0, x2: 0, y2: 1 },
        svg("stop", { offset: 0, "stop-color": "#ffffff", "stop-opacity": 0 }),
        svg("stop", { offset: 1, "stop-color": "#fff6dc", "stop-opacity": 1 }),
      ),
    ),
    svg("rect", { width: WIDTH, height: HEIGHT, fill: `url(#${id}-sky)` }),
    field.el,
    ...layered,
    svg("path", {
      class: "night-ground",
      d: "M0 80V71C26 68.5 54 72 90 70.5S150 68.5 186 71 222 69 240 70V80Z",
    }),
  );
  // A click on a drawn part switches it (the controls under it are the way in for the keyboard).
  drawing.addEventListener("click", (event) => {
    const name =
      event.target instanceof Element
        ? event.target.closest<SVGElement>("[data-part]")?.dataset.part
        : undefined;
    const part = parts.find((each) => each.name === name);
    const patch = part && clickPatch(part, stateOf(part));
    if (patch) knobs.set(patch, true);
  });

  // The controls: the moon's phases, then a chip for each other part, the stars first.
  const moonPart = parts.find((part) => part.name === "moon");
  const moon = moonPart?.def.kind === "feature" ? moonRow(knobs, moonPart.def) : undefined;
  const switching = parts.flatMap((part) =>
    part.name === "stars" || part.name === "moon" ? [] : [part],
  );
  const chips =
    switching.length > 0
      ? chipGrid(
          knobs,
          switching.map((part) => part.def),
        )
      : undefined;
  // chipGrid lays a cell out for each def, in order.
  const cells = chips
    ? [...chips.grid.el.querySelectorAll<HTMLElement>(":scope > .chip-cell")]
    : [];
  const stars = starPart ? starsChip(knobs, starPart.def) : undefined;
  const grid = chips?.grid.el ?? (stars ? h("div", { class: "chips" }) : undefined);
  if (stars) grid?.prepend(stars.el);
  // Under the chips, each part's companions while it is on (the giant planet's).
  const held = switching.flatMap((part) => {
    const list = companions.get(part) ?? [];
    return list.length > 0
      ? [{ part, built: companionControls(knobs, part.def, list, group.row) }]
      : [];
  });

  // A control and its drawing light up together while either is pointed at or focused.
  let hot: NightPart | undefined;
  const links = [
    ...(moon && moonPart ? [{ part: moonPart, el: moon.el }] : []),
    ...(stars && starPart ? [{ part: starPart, el: stars.el }] : []),
    ...switching.flatMap((part, index) => {
      const el = cells[index];
      return el ? [{ part, el }] : [];
    }),
  ];
  // A search for the section finds each of its parts.
  for (const { el } of links) el.dataset.search = `${el.dataset.search ?? ""} night sky`;
  // ... and so do a part's companions with its drawing.
  const lit = [...links, ...held.map(({ part, built }) => ({ part, el: built.el }))];
  const light = (part: NightPart | undefined) => {
    hot = part;
    for (const { part: each, el } of lit) el.classList.toggle("hot", each === part);
    for (const { part: each, art } of drawn) art.el.classList.toggle("hot", each === part);
  };
  for (const { part, el } of lit) {
    el.addEventListener("pointerenter", () => light(part));
    el.addEventListener("pointerleave", () => light(hot === part ? undefined : hot));
    el.addEventListener("focusin", () => light(part));
    el.addEventListener("focusout", () => light(hot === part ? undefined : hot));
  }
  for (const { part, art } of drawn) {
    if (part.name === "stars") continue;
    art.el.addEventListener("pointerenter", () => light(part));
    art.el.addEventListener("pointerleave", () => light(hot === part ? undefined : hot));
  }
  // The shooting stars' "now" falls on the drawing too.
  for (const { part, el } of links) {
    const play = drawn.find((each) => each.part === part)?.art.play;
    if (play) el.querySelector(".now")?.addEventListener("click", play);
  }

  const holds = parts.flatMap((part) => [part.def, ...(companions.get(part) ?? [])]);
  const keys = holds.flatMap(knobKeys);
  const header = row({
    label: "Night sky",
    help: HELP,
    icon: "stars",
    block: h("div", { class: "night-scene" }, drawing),
    readout: () => nightSummary(parts, stateOf),
    modified: () => knobs.modified(keys),
    reset: () => knobs.reset(keys),
  });
  // The section's own words cover its heading, which shows whenever any of its parts does.
  header.el.removeAttribute("data-search");
  header.el.classList.add("night-head");
  const night = clock ? nightButton(knobs, clock) : undefined;
  const words = [
    "night sky",
    HELP,
    ...holds.map((def) =>
      def.kind === "feature"
        ? `${def.label} ${def.amountLabel} ${def.help}`
        : `${def.label} ${def.help}`,
    ),
  ];
  const el = h(
    "div",
    {
      class: "night-sky",
      "data-search": words.join(" ").toLowerCase(),
      "data-keys": keys.join(" "),
    },
    header.el,
    night?.el,
    moon?.el,
    grid,
    chips?.amounts.el,
    ...held.map(({ built }) => built.el),
  );

  return {
    el,
    sync: () => {
      header.sync();
      night?.sync();
      moon?.sync();
      stars?.sync();
      chips?.grid.sync();
      chips?.amounts.sync();
      for (const { built } of held) built.sync();
      for (const { part, art } of drawn) {
        const state = stateOf(part);
        const share = shareOf(part.def, state.amount);
        art.el.classList.toggle("on", state.on);
        art.el.style.setProperty("--level", share.toFixed(3));
        art.el.style.display = knobs.on(part.def.when) ? "" : "none";
        art.sync?.(state, share);
      }
    },
  };
}
