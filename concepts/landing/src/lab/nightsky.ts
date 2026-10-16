// The night strip: the sky components a group holds (knobs tagged `night`: the stars' density, the
// Milky Way, shooting stars, the aurora; any of them) drawn as one small night sky over a dark
// horizon, each part in its state, dim and dashed while off and lit with its amount while on. Click
// a part to switch it, drag it (right or up for more) to set it; drag the open sky for more or fewer
// stars. A part with a trigger has its "now" on the strip, and plays it there too (a meteor falls).
// Each part is a slider for the keyboard and assistive technology: arrow keys set it, Space switches
// it, Delete puts it out. nightsky-model.ts holds the rules.
import { formatValue } from "../params.ts";
import { nowButton, row } from "./controls.ts";
import { drag, h, keyStep, svg, type Built } from "./dom.ts";
import { knobIcon, knobKeys, type Knobs } from "./knobs.ts";
import {
  amountKey,
  clickPatch,
  dragPatch,
  isDrag,
  keyPatch,
  NIGHT_STARS,
  nightSummary,
  partText,
  shareOf,
  starsOut,
  streaksOf,
  type NightPart,
  type NightPartName,
  type Patch,
  type PartState,
} from "./nightsky-model.ts";

// ---- the drawing: 240 x 64, stretched to the strip (strokes and dots keep their pixel size) ------

const WIDTH = 240;
const HEIGHT = 64;
/** The open sky above the horizon, where the stars stand. */
const SKY = { left: 3, top: 3, width: 234, height: 50 } as const;
/** How many stars stand, faint, in a strip whose group has no stars knob. */
const GHOST_STARS = 12;
/** How long a "now" plays on the strip (a meteor falling, the aurora surging), in ms. */
const PLAYING = 900;

/** Where a switching part lies: its hit area (x, y, width, height) and its "now" button's centre. */
const LAYOUT: Readonly<
  Record<
    Exclude<NightPartName, "stars">,
    { hit: readonly [number, number, number, number]; now: readonly [number, number] }
  >
> = {
  aurora: { hit: [6, 2, 72, 54], now: [70, 50] },
  milkyWay: { hit: [84, 0, 96, 58], now: [172, 50] },
  meteors: { hit: [184, 0, 56, 40], now: [226, 51] },
};

const percent = (value: number, of: number) => `${((value / of) * 100).toFixed(3)}%`;

/** A dot: a zero-length stroke whose round cap keeps it round however the strip is stretched. */
const dot = (className: string, x: number, y: number, width: number) =>
  svg("line", {
    class: className,
    x1: x.toFixed(2),
    y1: y.toFixed(2),
    x2: (x + 0.01).toFixed(2),
    y2: y.toFixed(2),
    "stroke-width": width.toFixed(2),
  });

/** Each strip's gradients need ids of their own. */
let strips = 0;

/** Curtains of light hanging over the horizon, coloured by `gradient` from their feet up. */
function auroraArt(gradient: string): SVGGElement {
  const curtains = [
    [16, 12],
    [30, 6],
    [44, 10],
    [58, 15],
  ].map(([x = 0, top = 0], index) => {
    const d = `M${x} 52C${x - 6} 40 ${x + 7} 24 ${x + 2} ${top}`;
    const curtain = svg(
      "g",
      { class: "night-curtain" },
      svg("path", { class: "night-glow", d, stroke: `url(#${gradient})` }),
      svg("path", { class: "night-ribbon", d, stroke: `url(#${gradient})` }),
    );
    curtain.style.setProperty("--delay", `${(-index * 1.3).toFixed(1)}s`);
    return curtain;
  });
  return svg("g", { class: "night-aurora" }, ...curtains);
}

/** The Milky Way rising from the horizon: a soft band, its brighter core, its dark lane of dust. */
function bandArt(): SVGGElement {
  // The band's centre line (a cubic), for the stars crowding into it.
  const centre = [
    [97, 58],
    [119, 40],
    [142, 21],
    [168, 0],
  ] as const;
  const crowd = Array.from({ length: 16 }, (_, index) => {
    const t = (index + 0.5) / 16;
    const weights = [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
    let x = 0;
    let y = 0;
    for (const [at, [px, py]] of centre.entries()) {
      x += px * (weights[at] ?? 0);
      y += py * (weights[at] ?? 0);
    }
    // Off the centre line across the band (along its normal), side to side.
    const off = (index % 2 === 0 ? 1 : -1) * (2 + ((index * 7) % 5));
    return dot("night-crowd", x + off * 0.63, y + off * 0.78, index % 3 === 0 ? 2 : 1.4);
  });
  return svg(
    "g",
    { class: "night-band" },
    svg("path", {
      class: "night-band-outer",
      d: "M86 58C108 40 132 20 158 0H178C152 22 130 40 108 58Z",
    }),
    svg("path", {
      class: "night-band-core",
      d: "M93 58C114 40 137 21 164 0H172C146 21 124 40 102 58Z",
    }),
    ...crowd,
    svg("path", { class: "night-lane", d: "M99 57C121 39 143 20 167 0" }),
  );
}

/** Shooting stars: three streaks falling to the left, coloured by `gradient` from tail to head. */
function meteorArt(gradient: string): { group: SVGGElement; streaks: SVGGElement[] } {
  const streaks = [
    [234, 6, 198, 32],
    [214, 2, 197, 14],
    [240, 21, 223, 33],
  ].map(([x1 = 0, y1 = 0, x2 = 0, y2 = 0]) =>
    svg(
      "g",
      { class: "night-streak" },
      svg("line", { class: "night-tail", x1, y1, x2, y2, stroke: `url(#${gradient})` }),
      dot("night-head", x2, y2, 3.2),
    ),
  );
  const flash = svg("line", { class: "night-flash", x1: 240, y1: 2, x2: 196, y2: 34 });
  return { group: svg("g", { class: "night-meteor" }, ...streaks, flash), streaks };
}

// ---- the strip -------------------------------------------------------------------------------

/** The night strip for a group's night parts (nightParts: at least one). */
export function nightStrip(knobs: Knobs, parts: readonly NightPart[]): Built {
  const id = `night-${++strips}`;
  const stateOf = (part: NightPart): PartState => ({
    on: part.name === "stars" || knobs.value(part.def.key) > 0.5,
    amount: knobs.value(amountKey(part)),
  });
  const starPart = parts.find((part) => part.name === "stars");

  const stars = NIGHT_STARS.map((star, index) => {
    const el = dot(
      `night-star${index % 4 === 1 ? " twinkle" : ""}`,
      SKY.left + star.x * SKY.width,
      SKY.top + star.y * SKY.height,
      1.2 + star.size * 1.3,
    );
    el.style.setProperty("--glint", star.size.toFixed(2));
    el.style.setProperty("--delay", `${(-index * 0.37).toFixed(2)}s`);
    return el;
  });
  const starField = svg("g", { class: "night-stars" }, ...stars);

  let hovered: NightPart | undefined;
  let focused: NightPart | undefined;
  const controls = parts.map((part) => {
    const { def } = part;
    let drawn: SVGGElement;
    let streaks: SVGGElement[] = [];
    switch (part.name) {
      case "stars":
        drawn = starField;
        break;
      case "aurora":
        drawn = auroraArt(`${id}-aurora`);
        break;
      case "milkyWay":
        drawn = bandArt();
        break;
      case "meteors":
        ({ group: drawn, streaks } = meteorArt(`${id}-meteor`));
        break;
      default: {
        const never: never = part;
        throw new Error(`night strip: no drawing for ${String(never)}`);
      }
    }
    const spot = part.name === "stars" ? undefined : LAYOUT[part.name];
    const how =
      part.name === "stars"
        ? "Drag the open sky right or up, or press the arrow keys, for more stars; left or down for fewer."
        : `Click or Space switches it; drag right or up, or press the arrow keys, for more ${part.def.amountLabel}; Delete puts it out.`;
    const el = h("div", {
      class: `night-part ${part.name}`,
      role: "slider",
      tabIndex: 0,
      "aria-label": def.label,
      "aria-valuemin": String(def.min),
      "aria-valuemax": String(def.max),
      title: `${def.label}: ${def.help}\n${how}`,
    });
    if (spot) {
      const [x, y, width, height] = spot.hit;
      el.style.left = percent(x, WIDTH);
      el.style.top = percent(y, HEIGHT);
      el.style.width = percent(width, WIDTH);
      el.style.height = percent(height, HEIGHT);
    }

    el.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      el.focus();
      const from = knobs.value(amountKey(part));
      let patch: Patch | undefined;
      drag(
        event,
        el,
        (pointer) => {
          const dx = pointer.clientX - event.clientX;
          const dy = pointer.clientY - event.clientY;
          if (!patch && !isDrag(dx, dy)) return;
          patch = dragPatch(part, from, dx, dy);
          knobs.set(patch, false);
        },
        () => {
          // A press that never moved is a click.
          const done = patch ?? clickPatch(part, stateOf(part));
          if (done) knobs.set(done, true);
        },
      );
    });
    el.addEventListener("keydown", (event) => {
      const step = keyStep(event, def.step, def.max - def.min);
      const patch = keyPatch(part, stateOf(part), event.key, step);
      if (!patch) return;
      event.preventDefault();
      knobs.set(patch, true);
    });

    // A trigger's "now" plays on the strip too: a meteor falls, the aurora surges.
    const slot = def.trigger;
    let playing: number | undefined;
    const now =
      slot === undefined || !spot
        ? undefined
        : nowButton(
            def.label,
            () => {
              knobs.fire(slot);
              drawn.classList.remove("firing");
              void drawn.getBoundingClientRect();
              drawn.classList.add("firing");
              window.clearTimeout(playing);
              playing = window.setTimeout(() => drawn.classList.remove("firing"), PLAYING);
            },
            { compact: true, whileOff: true },
          );
    if (now && spot) {
      now.style.left = percent(spot.now[0], WIDTH);
      now.style.top = percent(spot.now[1], HEIGHT);
    }
    // The readout names the part pointed at or focused, its "now" included.
    for (const target of now ? [el, now] : [el]) {
      target.addEventListener("pointerenter", () => {
        hovered = part;
        sync();
      });
      target.addEventListener("pointerleave", () => {
        if (hovered === part) hovered = undefined;
        sync();
      });
      target.addEventListener("focus", () => {
        focused = part;
        sync();
      });
      target.addEventListener("blur", () => {
        if (focused === part) focused = undefined;
        sync();
      });
    }
    return { part, drawn, streaks, el, now };
  });

  const drawing = svg(
    "svg",
    {
      class: "night-art",
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
      preserveAspectRatio: "none",
      "aria-hidden": "true",
      focusable: "false",
    },
    svg(
      "defs",
      {},
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
    starField,
    ...controls.flatMap(({ part, drawn }) => (part.name === "stars" ? [] : [drawn])),
    svg("path", {
      class: "night-ground",
      d: "M0 64V56.5C24 55 52 57.5 84 56.5S146 55 180 56.8 222 55.6 240 56.4V64Z",
    }),
  );
  // A strip of one part goes by that part's name; of several, by the night sky's.
  const [only] = parts;
  const lone = parts.length === 1 ? only : undefined;
  const label = lone ? lone.def.label : "night sky";
  const strip = h(
    "div",
    { class: "night-strip", role: "group", "aria-label": label },
    drawing,
    ...controls.flatMap(({ el, now }) => (now ? [el, now] : [el])),
  );

  const switching = parts.some((part) => part.name !== "stars");
  const help = [
    ...(switching
      ? [
          "Each part is drawn as it is, dim and dashed while off, lit with its amount while on: click it to switch it, drag it right or up for more, left or down for less.",
        ]
      : []),
    ...(starPart ? ["Drag the open sky right or up for more stars, left or down for fewer."] : []),
    `Tab to a part: the arrow keys set it${switching ? ", Space switches it, Delete puts it out" : ", Delete puts the stars out"}.`,
    ...parts.map((part) => `${part.def.label}: ${part.def.help}`),
  ].join(" ");
  const keys = parts.flatMap((part) => knobKeys(part.def));
  const built = row({
    label,
    help,
    icon: lone ? knobIcon(lone.def) : "stars",
    block: strip,
    readout: () => {
      const active = lone ? undefined : (focused ?? hovered);
      return active ? partText(active, stateOf(active)) : nightSummary(parts, stateOf);
    },
    modified: () => knobs.modified(keys),
    reset: () => knobs.reset(keys),
  });
  built.el.dataset.search = help.toLowerCase();
  built.el.dataset.keys = keys.join(" ");

  function sync(): void {
    built.sync();
    const active = focused ?? hovered;
    const out = starPart ? starsOut(shareOf(starPart.def, stateOf(starPart).amount)) : GHOST_STARS;
    for (const [index, star] of stars.entries()) {
      star.classList.toggle("out", index >= out);
      star.classList.toggle("ghost", !starPart);
    }
    for (const { part, drawn, streaks, el } of controls) {
      const { def } = part;
      const state = stateOf(part);
      const share = shareOf(def, state.amount);
      drawn.classList.toggle("on", state.on);
      drawn.classList.toggle("hot", active === part);
      drawn.style.setProperty("--level", share.toFixed(3));
      el.setAttribute("aria-valuenow", String(state.amount));
      el.setAttribute(
        "aria-valuetext",
        part.name === "stars"
          ? formatValue(def, state.amount)
          : state.on
            ? `${part.def.amountLabel} ${formatValue(def, state.amount)}`
            : "off",
      );
      // Off, the first streak stays as the shooting stars' dim outline.
      const shown = Math.max(1, streaksOf(state.on, share));
      for (const [index, streak] of streaks.entries())
        streak.classList.toggle("gone", index >= shown);
    }
  }

  return { el: built.el, sync };
}
