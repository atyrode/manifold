// Pads for knobs that are directions or places. A direction pad draws a signed strength (the wind,
// a current) as an arrow out of calm, a compass pad a heading and its strength as one vector, a
// position pad a point in the frame. Each is a slider for assistive technology (sliderBehaviour):
// arrow keys move it (Shift for larger steps), and a drag sets it on release; on a touch screen a
// direction pad waits for a drag across, so a swipe down scrolls the panel. Gusts riding a
// direction (widget `gusts`) make its pad the wind card: a gust lane under the arrow switches them,
// sets their strength and sends one now, and while they are on the arrow puffs out now and then (a
// sent one surges it).
import { formatValue } from "../params.ts";
import { chipButton } from "./chips.ts";
import { nowButton, row, segments, slider, sliderBehaviour } from "./controls.ts";
import { h, keyStep, setAttr, setHidden, setStyle, snap, svg, type Built } from "./dom.ts";
import type { IconName } from "./icons.ts";
import { knobKeys, type FeatureDef, type Knobs, type RangeDef } from "./knobs.ts";

const TAU = Math.PI * 2;
/** The eight headings from the right, counter-clockwise: a word and an arrow each. */
const HEADINGS = [
  ["right", "→"],
  ["up and right", "↗"],
  ["up", "↑"],
  ["up and left", "↖"],
  ["left", "←"],
  ["down and left", "↙"],
  ["down", "↓"],
  ["down and right", "↘"],
] as const;

/**
 * A signed strength, min to the left, max to the right, zero in the middle; with `gusts` the wind
 * card, the gusts' lane under it.
 */
export function directionPad(
  knobs: Knobs,
  def: RangeDef,
  iconName: IconName,
  gusts: FeatureDef | undefined,
): Built {
  const vector = h("div", { class: "pad-vector" });
  const flow = h("div", { class: "pad-flow" });
  const pad = h(
    "div",
    { class: "dir-pad", "aria-label": def.label },
    flow,
    h("span", { class: "pad-axis" }),
    vector,
    h("span", { class: "pad-end left" }, "left"),
    h("span", { class: "pad-end right" }, "right"),
  );
  const describe = (value: number) => {
    if (value === 0) return "calm";
    const share = Math.round((Math.abs(value) / (value < 0 ? -def.min : def.max)) * 100);
    return `${value < 0 ? "←" : "→"} ${share}%`;
  };
  const to = (value: number) => ({ [def.key]: snap(value, def.min, def.max, def.step) });
  const syncSlider = sliderBehaviour(pad, {
    min: def.min,
    max: def.max,
    now: () => knobs.value(def.key),
    text: () => {
      const value = knobs.value(def.key);
      return `${describe(value)} ${value < 0 ? "to the left" : value > 0 ? "to the right" : ""}`.trim();
    },
    set: (patch, commit) => knobs.set(patch, commit),
    key: (event) => {
      const delta = keyStep(event, def.step, def.max - def.min);
      if (delta !== undefined) return to(knobs.value(def.key) + delta);
      if (event.key === "Home") return to(def.min);
      if (event.key === "End") return to(def.max);
      if (event.key === "Delete" || event.key === "0") return to(0);
      return undefined;
    },
    press: () => {
      const rect = pad.getBoundingClientRect();
      return (pointer) => {
        const at = ((pointer.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
        return to(at < 0 ? at * -def.min : at * def.max);
      };
    },
    across: true,
  });

  const lane = gusts ? gustLane(knobs, gusts, pad) : undefined;
  const keys = [def.key, ...(gusts ? knobKeys(gusts) : [])];
  const gustText = () => {
    if (!gusts) return "";
    const amount = formatValue(gusts, knobs.value(`${gusts.key}-amount`));
    return knobs.value(gusts.key) > 0.5 ? ` · ${gusts.label} ${amount}` : ` · no ${gusts.label}`;
  };
  const built = row({
    label: def.label,
    help: gusts
      ? `${def.help} Drag the arrow out of the middle, or use the arrow keys; 0 calms it. ${gusts.label}: ${gusts.help} The lane under the arrow switches them and sets their ${gusts.amountLabel}; while they are on the arrow puffs out now and then.`
      : `${def.help} Drag the arrow out of the middle, or use the arrow keys; 0 calms it.`,
    icon: iconName,
    block: lane ? h("div", { class: "wind-card" }, pad, lane.el) : pad,
    readout: () => describe(knobs.value(def.key)) + gustText(),
    modified: () => knobs.modified(keys),
    reset: () => knobs.reset(keys),
  });
  if (gusts) {
    built.el.dataset.search = `${def.label} ${def.help} ${gusts.label} ${gusts.help}`.toLowerCase();
    built.el.dataset.keys = keys.join(" ");
  }
  return {
    el: built.el,
    sync: () => {
      built.sync();
      lane?.sync();
      syncSlider();
      const value = knobs.value(def.key);
      const share = value < 0 ? value / -def.min : value / def.max;
      setStyle(vector, "--share", Math.abs(share).toFixed(4));
      vector.classList.toggle("back", share < 0);
      setHidden(vector, value === 0);
      setStyle(flow, "--strength", Math.abs(share).toFixed(3));
      setStyle(flow, "--flow-to", `${share < 0 ? -24 : 24}px`);
      flow.classList.toggle("still", value === 0);
    },
  };
}

/** How long a sent gust surges the wind's arrow, in ms (its CSS animation's length). */
const GUST_SURGE = 1100;

/**
 * The wind card's gust lane: the gusts' switch, their strength (a drag switches them on with it)
 * and their "now", which also surges the arrow on `pad`; while they are on, `pad` puffs (CSS
 * `gusty`, `--gust` their strength 0..1).
 */
function gustLane(knobs: Knobs, gusts: FeatureDef, pad: HTMLElement): Built {
  const amountKey = `${gusts.key}-amount`;
  const on = () => knobs.value(gusts.key) > 0.5;
  const chip = chipButton(gusts);
  chip.addEventListener("click", () => knobs.set({ [gusts.key]: on() ? 0 : 1 }, true));
  const strength = gusts.options
    ? segments(
        `${gusts.label} ${gusts.amountLabel}`,
        gusts.options.map((option) => ({ label: option.label, value: String(option.value) })),
        () => String(knobs.value(amountKey)),
        (value) => knobs.set({ [gusts.key]: 1, [amountKey]: Number(value) }, true),
      )
    : slider(
        `${gusts.label} ${gusts.amountLabel}`,
        gusts.min,
        gusts.max,
        gusts.step,
        () => knobs.value(amountKey),
        (value, commit) => knobs.set({ [gusts.key]: 1, [amountKey]: value }, commit),
        (value) => (on() ? `${gusts.amountLabel} ${formatValue(gusts, value)}` : "off"),
      );
  const slot = gusts.trigger;
  let surging: number | undefined;
  const now =
    slot === undefined
      ? undefined
      : nowButton(
          gusts.label,
          () => {
            knobs.fire(slot);
            pad.classList.remove("gusting");
            void pad.offsetWidth;
            pad.classList.add("gusting");
            window.clearTimeout(surging);
            surging = window.setTimeout(() => pad.classList.remove("gusting"), GUST_SURGE);
          },
          { compact: true, whileOff: true },
        );
  const el = h("div", { class: "gust-lane" }, chip, strength.el, now);
  return {
    el,
    sync: () => {
      strength.sync();
      const lit = on();
      setAttr(chip, "aria-checked", String(lit));
      el.classList.toggle("on", lit);
      pad.classList.toggle("gusty", lit);
      const share = (knobs.value(amountKey) - gusts.min) / (gusts.max - gusts.min);
      setStyle(pad, "--gust", Math.min(1, Math.max(0, share)).toFixed(3));
    },
  };
}

/** The knob a compass pad's length reads: a range, or a feature's amount. */
export interface Strength {
  def: RangeDef | FeatureDef;
  key: string;
}

/** A heading (a turn counter-clockwise from the right) and a strength, as one vector. */
export function compassPad(knobs: Knobs, heading: RangeDef, strength: Strength): Built {
  const { def: power, key: powerKey } = strength;
  const R = 44;
  const arrow = svg("path", { class: "compass-arrow" });
  const shaft = svg("line", { class: "compass-shaft", x1: 50, y1: 50 });
  const tip = svg("circle", { class: "compass-tip", r: 4 });
  const rings = [R, (R * 2) / 3, R / 3].map((r) =>
    svg("circle", { class: "compass-ring", cx: 50, cy: 50, r: r.toFixed(2) }),
  );
  const ticks = Array.from({ length: 8 }, (_, index) => {
    const angle = (index / 8) * TAU;
    const inner = index % 2 === 0 ? R - 6 : R - 3;
    return svg("line", {
      class: "compass-tick",
      x1: (50 + Math.cos(angle) * inner).toFixed(2),
      y1: (50 - Math.sin(angle) * inner).toFixed(2),
      x2: (50 + Math.cos(angle) * R).toFixed(2),
      y2: (50 - Math.sin(angle) * R).toFixed(2),
    });
  });
  const face = svg(
    "svg",
    { viewBox: "0 0 100 100", class: "compass-face", "aria-hidden": "true" },
    ...rings,
    ...ticks,
    shaft,
    arrow,
    tip,
  );
  const pad = h(
    "div",
    {
      class: "compass-pad",
      "aria-label": `${heading.label}; up and down arrows change the ${power.kind === "feature" ? power.amountLabel : power.label}`,
    },
    face,
  );
  const share = (value: number) => (value - power.min) / (power.max - power.min);
  const heading8 = () => HEADINGS[Math.round(knobs.value(heading.key) * 8) % 8] ?? HEADINGS[0];
  const amount = () => formatValue(power, knobs.value(powerKey));
  const syncSlider = sliderBehaviour(pad, {
    min: heading.min,
    max: heading.max,
    now: () => knobs.value(heading.key),
    text: () => `toward ${heading8()[0]}, ${amount()}`,
    set: (patch, commit) => knobs.set(patch, commit),
    key: (event) => {
      const big = event.shiftKey ? 2 : 1;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const turn = knobs.value(heading.key);
        const next = turn + (event.key === "ArrowLeft" ? heading.step : -heading.step) * big;
        return {
          [heading.key]: snap(((next % 1) + 1) % 1, heading.min, heading.max, heading.step),
        };
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        const next =
          knobs.value(powerKey) + (event.key === "ArrowUp" ? power.step : -power.step) * big;
        return { [powerKey]: snap(next, power.min, power.max, power.step) };
      }
      return undefined;
    },
    press: () => {
      const rect = face.getBoundingClientRect();
      return (pointer) => {
        const x = ((pointer.clientX - rect.left) / rect.width) * 100 - 50;
        const y = 50 - ((pointer.clientY - rect.top) / rect.height) * 100;
        const turn = (((Math.atan2(y, x) / TAU) % 1) + 1) % 1;
        const reach = Math.min(1, Math.hypot(x, y) / R);
        return {
          [heading.key]: snap(turn, heading.min, heading.max, heading.step),
          [powerKey]: snap(
            power.min + reach * (power.max - power.min),
            power.min,
            power.max,
            power.step,
          ),
        };
      };
    },
  });

  const keys = [heading.key, powerKey];
  const built = row({
    label: heading.label,
    help: `${heading.help} Drag the arrow's tip: its way is the heading, its length the ${power.kind === "feature" ? power.amountLabel : power.label}. Left and right arrow keys turn it, up and down lengthen and shorten it.`,
    icon: "waves",
    block: h("div", { class: "compass" }, pad),
    readout: () => `${heading8()[1]} ${amount()}`,
    modified: () => knobs.modified(keys),
    reset: () => knobs.reset(keys),
  });
  return {
    el: built.el,
    sync: () => {
      built.sync();
      syncSlider();
      const angle = knobs.value(heading.key) * TAU;
      const length = 8 + share(knobs.value(powerKey)) * (R - 8);
      const x = 50 + Math.cos(angle) * length;
      const y = 50 - Math.sin(angle) * length;
      setAttr(shaft, "x2", x.toFixed(2));
      setAttr(shaft, "y2", y.toFixed(2));
      setAttr(tip, "cx", x.toFixed(2));
      setAttr(tip, "cy", y.toFixed(2));
      const head = (offset: number) =>
        `${(x - Math.cos(angle + offset) * 9).toFixed(2)} ${(y + Math.sin(angle + offset) * 9).toFixed(2)}`;
      setAttr(arrow, "d", `M${head(0.45)}L${x.toFixed(2)} ${y.toFixed(2)}L${head(-0.45)}`);
    },
  };
}

/** A point: `x` across, `y` up; `screen` the values where the frame's edges lie, if not the pad's. */
export function positionPad(
  knobs: Knobs,
  x: RangeDef,
  y: RangeDef,
  screen: readonly [number, number] | undefined,
): Built {
  const point = h("span", { class: "pos-point" });
  const across = h("span", { class: "pos-line across" });
  const up = h("span", { class: "pos-line up" });
  const frame = h("span", { class: "pos-frame" });
  const fx = (value: number) => ((value - x.min) / (x.max - x.min)) * 100;
  const fy = (value: number) => (1 - (value - y.min) / (y.max - y.min)) * 100;
  if (screen) {
    const [lo, hi] = screen;
    frame.style.left = `${Math.max(0, fx(lo))}%`;
    frame.style.right = `${Math.max(0, 100 - fx(hi))}%`;
    frame.style.top = `${Math.max(0, fy(hi))}%`;
    frame.style.bottom = `${Math.max(0, 100 - fy(lo))}%`;
  } else frame.classList.add("whole");
  const [firstX] = x.label.split(" ");
  const [firstY] = y.label.split(" ");
  const label =
    firstX !== undefined && firstX === firstY && x.label.includes(" ")
      ? `${firstX} position`
      : "position";
  const pad = h(
    "div",
    {
      class: "pos-pad",
      "aria-label": `${label}: left and right arrows move it ${x.label}, up and down ${y.label}`,
    },
    frame,
    across,
    up,
    point,
  );
  const describe = () =>
    `${formatValue(x, knobs.value(x.key))} · ${formatValue(y, knobs.value(y.key))}`;
  const syncSlider = sliderBehaviour(pad, {
    min: x.min,
    max: x.max,
    now: () => knobs.value(x.key),
    text: () =>
      `${x.label} ${formatValue(x, knobs.value(x.key))}, ${y.label} ${formatValue(y, knobs.value(y.key))}`,
    set: (patch, commit) => knobs.set(patch, commit),
    key: (event) => {
      const big = event.shiftKey ? 5 : 1;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const next = knobs.value(x.key) + (event.key === "ArrowRight" ? x.step : -x.step) * big;
        return { [x.key]: snap(next, x.min, x.max, x.step) };
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        const next = knobs.value(y.key) + (event.key === "ArrowUp" ? y.step : -y.step) * big;
        return { [y.key]: snap(next, y.min, y.max, y.step) };
      }
      return undefined;
    },
    press: () => {
      const rect = pad.getBoundingClientRect();
      return (pointer) => {
        const u = (pointer.clientX - rect.left) / Math.max(1, rect.width);
        const v = 1 - (pointer.clientY - rect.top) / Math.max(1, rect.height);
        return {
          [x.key]: snap(x.min + u * (x.max - x.min), x.min, x.max, x.step),
          [y.key]: snap(y.min + v * (y.max - y.min), y.min, y.max, y.step),
        };
      };
    },
  });

  const keys = [x.key, y.key];
  const built = row({
    label,
    help: `${x.help} ${y.help} Drag the point${screen ? " (the inner frame is the screen)" : ""}, or use the arrow keys.`,
    icon: "frame",
    block: pad,
    readout: describe,
    modified: () => knobs.modified(keys),
    reset: () => knobs.reset(keys),
  });
  return {
    el: built.el,
    sync: () => {
      built.sync();
      syncSlider();
      const left = `${fx(knobs.value(x.key)).toFixed(3)}%`;
      const top = `${fy(knobs.value(y.key)).toFixed(3)}%`;
      setStyle(point, "left", left);
      setStyle(point, "top", top);
      setStyle(up, "left", left);
      setStyle(across, "top", top);
    },
  };
}
