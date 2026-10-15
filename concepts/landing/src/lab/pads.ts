// Pads for knobs that are directions or places. A direction pad draws a signed strength (the wind,
// a current) as an arrow out of calm, a compass pad a heading and its strength as one vector, a
// position pad a point in the frame. Each is a slider for assistive technology: arrow keys move it
// (Shift for larger steps), and a drag sets it on release.
import { formatValue } from "../params.ts";
import { row } from "./controls.ts";
import { drag, h, keyStep, snap, svg, type Built } from "./dom.ts";
import type { IconName } from "./icons.ts";
import type { FeatureDef, Knobs, RangeDef } from "./knobs.ts";

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

/** A signed strength, min to the left, max to the right, zero in the middle. */
export function directionPad(knobs: Knobs, def: RangeDef, iconName: IconName): Built {
  const vector = h("div", { class: "pad-vector" });
  const flow = h("div", { class: "pad-flow" });
  const pad = h(
    "div",
    {
      class: "dir-pad",
      role: "slider",
      tabIndex: 0,
      "aria-label": def.label,
      "aria-valuemin": String(def.min),
      "aria-valuemax": String(def.max),
    },
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
  const set = (value: number, commit: boolean) =>
    knobs.set({ [def.key]: snap(value, def.min, def.max, def.step) }, commit);

  pad.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    pad.focus();
    const rect = pad.getBoundingClientRect();
    let last = knobs.value(def.key);
    drag(
      event,
      pad,
      (pointer) => {
        const at = ((pointer.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
        last = at < 0 ? at * -def.min : at * def.max;
        set(last, false);
      },
      () => set(last, true),
    );
  });
  pad.addEventListener("keydown", (event) => {
    const delta = keyStep(event, def.step, def.max - def.min);
    const next =
      delta !== undefined
        ? knobs.value(def.key) + delta
        : event.key === "Home"
          ? def.min
          : event.key === "End"
            ? def.max
            : event.key === "Delete" || event.key === "0"
              ? 0
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    set(next, true);
  });

  const built = row({
    label: def.label,
    help: `${def.help} Drag the arrow out of the middle, or use the arrow keys; 0 calms it.`,
    icon: iconName,
    block: pad,
    readout: () => describe(knobs.value(def.key)),
    modified: () => knobs.modified([def.key]),
    reset: () => knobs.reset([def.key]),
  });
  return {
    el: built.el,
    sync: () => {
      built.sync();
      const value = knobs.value(def.key);
      const share = value < 0 ? value / -def.min : value / def.max;
      vector.style.setProperty("--share", Math.abs(share).toFixed(4));
      vector.classList.toggle("back", share < 0);
      vector.hidden = value === 0;
      flow.style.setProperty("--strength", Math.abs(share).toFixed(3));
      flow.style.setProperty("--flow-to", `${share < 0 ? -24 : 24}px`);
      flow.classList.toggle("still", value === 0);
      pad.setAttribute("aria-valuenow", String(value));
      pad.setAttribute(
        "aria-valuetext",
        `${describe(value)} ${value < 0 ? "to the left" : value > 0 ? "to the right" : ""}`.trim(),
      );
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
      role: "slider",
      tabIndex: 0,
      "aria-label": `${heading.label}; up and down arrows change the ${power.kind === "feature" ? power.amountLabel : power.label}`,
      "aria-valuemin": String(heading.min),
      "aria-valuemax": String(heading.max),
    },
    face,
  );
  const share = (value: number) => (value - power.min) / (power.max - power.min);
  const heading8 = () => HEADINGS[Math.round(knobs.value(heading.key) * 8) % 8] ?? HEADINGS[0];
  const amount = () => formatValue(power, knobs.value(powerKey));

  pad.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    pad.focus();
    const rect = face.getBoundingClientRect();
    let patch: Record<string, number> = {};
    drag(
      event,
      pad,
      (pointer) => {
        const x = ((pointer.clientX - rect.left) / rect.width) * 100 - 50;
        const y = 50 - ((pointer.clientY - rect.top) / rect.height) * 100;
        const turn = (((Math.atan2(y, x) / TAU) % 1) + 1) % 1;
        const reach = Math.min(1, Math.hypot(x, y) / R);
        patch = {
          [heading.key]: snap(turn, heading.min, heading.max, heading.step),
          [powerKey]: snap(
            power.min + reach * (power.max - power.min),
            power.min,
            power.max,
            power.step,
          ),
        };
        knobs.set(patch, false);
      },
      () => knobs.set(patch, true),
    );
  });
  pad.addEventListener("keydown", (event) => {
    let patch: Record<string, number> | undefined;
    const turn = knobs.value(heading.key);
    const big = event.shiftKey ? 2 : 1;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const next = turn + (event.key === "ArrowLeft" ? heading.step : -heading.step) * big;
      patch = { [heading.key]: snap(((next % 1) + 1) % 1, heading.min, heading.max, heading.step) };
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const next =
        knobs.value(powerKey) + (event.key === "ArrowUp" ? power.step : -power.step) * big;
      patch = { [powerKey]: snap(next, power.min, power.max, power.step) };
    }
    if (!patch) return;
    event.preventDefault();
    knobs.set(patch, true);
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
      const angle = knobs.value(heading.key) * TAU;
      const length = 8 + share(knobs.value(powerKey)) * (R - 8);
      const x = 50 + Math.cos(angle) * length;
      const y = 50 - Math.sin(angle) * length;
      shaft.setAttribute("x2", x.toFixed(2));
      shaft.setAttribute("y2", y.toFixed(2));
      tip.setAttribute("cx", x.toFixed(2));
      tip.setAttribute("cy", y.toFixed(2));
      const head = (offset: number) =>
        `${(x - Math.cos(angle + offset) * 9).toFixed(2)} ${(y + Math.sin(angle + offset) * 9).toFixed(2)}`;
      arrow.setAttribute("d", `M${head(0.45)}L${x.toFixed(2)} ${y.toFixed(2)}L${head(-0.45)}`);
      pad.setAttribute("aria-valuenow", String(knobs.value(heading.key)));
      pad.setAttribute("aria-valuetext", `toward ${heading8()[0]}, ${amount()}`);
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
      role: "slider",
      tabIndex: 0,
      "aria-label": `${label}: left and right arrows move it ${x.label}, up and down ${y.label}`,
      "aria-valuemin": String(x.min),
      "aria-valuemax": String(x.max),
    },
    frame,
    across,
    up,
    point,
  );
  const describe = () =>
    `${formatValue(x, knobs.value(x.key))} · ${formatValue(y, knobs.value(y.key))}`;

  pad.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    pad.focus();
    const rect = pad.getBoundingClientRect();
    let patch: Record<string, number> = {};
    pad.classList.add("dragging");
    drag(
      event,
      pad,
      (pointer) => {
        const u = (pointer.clientX - rect.left) / Math.max(1, rect.width);
        const v = 1 - (pointer.clientY - rect.top) / Math.max(1, rect.height);
        patch = {
          [x.key]: snap(x.min + u * (x.max - x.min), x.min, x.max, x.step),
          [y.key]: snap(y.min + v * (y.max - y.min), y.min, y.max, y.step),
        };
        knobs.set(patch, false);
      },
      () => {
        pad.classList.remove("dragging");
        knobs.set(patch, true);
      },
    );
  });
  pad.addEventListener("keydown", (event) => {
    const big = event.shiftKey ? 5 : 1;
    let patch: Record<string, number> | undefined;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const next = knobs.value(x.key) + (event.key === "ArrowRight" ? x.step : -x.step) * big;
      patch = { [x.key]: snap(next, x.min, x.max, x.step) };
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const next = knobs.value(y.key) + (event.key === "ArrowUp" ? y.step : -y.step) * big;
      patch = { [y.key]: snap(next, y.min, y.max, y.step) };
    }
    if (!patch) return;
    event.preventDefault();
    knobs.set(patch, true);
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
      const left = `${fx(knobs.value(x.key)).toFixed(3)}%`;
      const top = `${fy(knobs.value(y.key)).toFixed(3)}%`;
      point.style.left = left;
      point.style.top = top;
      up.style.left = left;
      across.style.top = top;
      pad.setAttribute("aria-valuenow", String(knobs.value(x.key)));
      pad.setAttribute(
        "aria-valuetext",
        `${x.label} ${formatValue(x, knobs.value(x.key))}, ${y.label} ${formatValue(y, knobs.value(y.key))}`,
      );
    },
  };
}
