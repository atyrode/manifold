// The sky dial: the time of day as the sun on its circle (sunrise on the right, noon at the top,
// sunset on the left, midnight below the horizon, as skyAt draws it), with the moon opposite in its
// phase. Drag the sun (or the moon) round; the day cycle plays from it and the moon switches on and
// off beside it, each with its amount below. Keys: arrows step the hour, wrapping past midnight.
import { formatValue } from "../params.ts";
import { row, slider } from "./controls.ts";
import { drag, h, snap, svg, type Built } from "./dom.ts";
import { icon } from "./icons.ts";
import { knobKeys, type FeatureDef, type Knobs, type RangeDef } from "./knobs.ts";

const C = 60;
const ORBIT = 43;
const TAU = Math.PI * 2;

/** "18:45" for a time of day 0..1. */
export function clockOf(time: number): string {
  const minutes = Math.round((((time % 1) + 1) % 1) * 24 * 60) % (24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** The part of the day a time falls in, by the sun's height (sunrise 0.25, sunset 0.75). */
export function daypartOf(time: number): string {
  const t = ((time % 1) + 1) % 1;
  if (t < 0.2 || t >= 0.81) return "night";
  if (t < 0.245) return "dawn";
  if (t < 0.3) return "sunrise";
  if (t < 0.45) return "morning";
  if (t < 0.55) return "noon";
  if (t < 0.69) return "afternoon";
  if (t < 0.755) return "golden hour";
  return "dusk";
}

/** The moon's look at a lit share 0..1. */
export function phaseOf(lit: number): string {
  if (lit < 0.15) return "thin crescent";
  if (lit < 0.4) return "crescent";
  if (lit < 0.6) return "half moon";
  if (lit < 0.92) return "gibbous";
  return "full moon";
}

/** A disc of radius r lit over `lit` of it from the right, the terminator an ellipse. */
function moonPath(r: number, lit: number): string {
  if (lit >= 0.995) return `M0 ${-r}A${r} ${r} 0 1 1 0 ${r}A${r} ${r} 0 1 1 0 ${-r}Z`;
  const rx = Math.abs(1 - 2 * lit) * r;
  return `M0 ${-r}A${r} ${r} 0 0 1 0 ${r}A${rx} ${r} 0 0 ${lit > 0.5 ? 1 : 0} 0 ${-r}Z`;
}

function mix(a: readonly number[], b: readonly number[], t: number): number[] {
  return a.map((value, index) => value + ((b[index] ?? value) - value) * t);
}

export function skyDial(
  knobs: Knobs,
  time: RangeDef,
  cycle: FeatureDef | undefined,
  moon: FeatureDef | undefined,
): Built {
  const angleOf = (t: number) => (t - 0.25) * TAU;
  const at = (angle: number, radius = ORBIT) => ({
    x: C + Math.cos(angle) * radius,
    y: C - Math.sin(angle) * radius,
  });

  const day = svg("path", { class: "sky-day", d: `M3 ${C}A57 57 0 0 1 117 ${C}Z` });
  const night = svg("path", { class: "sky-night", d: `M3 ${C}A57 57 0 0 0 117 ${C}Z` });
  const stars = [
    [30, 74],
    [46, 92],
    [78, 98],
    [92, 78],
    [62, 84],
    [22, 88],
    [100, 92],
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
      role: "slider",
      tabIndex: 0,
      "aria-label": time.label,
      "aria-valuemin": "0",
      "aria-valuemax": "1",
      title: "Drag the sun or the moon round; arrow keys step the hour",
    },
    face,
  );

  const lit = () => (moon ? knobs.value(`${moon.key}-amount`) : 1);
  const moonShown = () => moon === undefined || knobs.on(moon.key);
  const setTime = (value: number, commit: boolean) =>
    knobs.set({ [time.key]: snap(((value % 1) + 1) % 1, time.min, time.max, time.step) }, commit);

  let grabbedMoon = false;
  let lastValue = knobs.value(time.key);
  dial.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dial.focus();
    const rect = face.getBoundingClientRect();
    const point = (pointer: PointerEvent) => ({
      x: ((pointer.clientX - rect.left) / rect.width) * 120,
      y: ((pointer.clientY - rect.top) / rect.height) * 120,
    });
    const start = point(event);
    const moonAt = at(angleOf(knobs.value(time.key)) + Math.PI);
    grabbedMoon = moonShown() && Math.hypot(start.x - moonAt.x, start.y - moonAt.y) < 12;
    dial.classList.add("dragging");
    drag(
      event,
      dial,
      (pointer) => {
        const p = point(pointer);
        if (Math.hypot(p.x - C, p.y - C) < 6) return;
        const angle = Math.atan2(C - p.y, p.x - C) + (grabbedMoon ? Math.PI : 0);
        lastValue = angle / TAU + 0.25;
        setTime(lastValue, false);
      },
      () => {
        dial.classList.remove("dragging");
        setTime(lastValue, true);
      },
    );
  });
  dial.addEventListener("keydown", (event) => {
    const value = knobs.value(time.key);
    const big = 1 / 24 >= time.step ? Math.round(1 / 24 / time.step) * time.step : time.step;
    let next: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = value + time.step;
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = value - time.step;
    else if (event.key === "PageUp") next = value + big * 3;
    else if (event.key === "PageDown") next = value - big * 3;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = 0.5;
    if (next === undefined) return;
    event.preventDefault();
    setTime(next, true);
  });

  const side = h("div", { class: "sky-side" });
  const timeRow = row({
    label: time.label,
    help: `${time.help} Drag the sun round the dial (or the moon, opposite it); arrow keys step it, Home is midnight and End noon.`,
    icon: "sky",
    block: h("div", { class: "sky" }, dial, side),
    modified: () => knobs.modified([time.key]),
    reset: () => knobs.reset([time.key]),
  });
  timeRow.el.classList.add("sky-row");

  const syncs: (() => void)[] = [
    timeRow.sync,
    () => {
      const value = knobs.value(time.key);
      const angle = angleOf(value);
      const height = Math.sin(angle);
      const daylight = Math.min(1, Math.max(0, (height + 0.08) / 0.45));
      const glow = Math.max(0, 1 - Math.abs(height) / 0.32) * (height > -0.25 ? 1 : 0);
      const [r = 0, g = 0, b = 0] = mix(
        mix([16, 21, 38], [48, 80, 122], daylight),
        [214, 118, 62],
        glow * 0.55,
      );
      day.setAttribute("fill", `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`);
      const sunAt = at(angle);
      sun.setAttribute("transform", `translate(${sunAt.x.toFixed(2)} ${sunAt.y.toFixed(2)})`);
      sun.classList.toggle("below", height < -0.02);
      const moonAt = at(angle + Math.PI);
      moonGroup.setAttribute("transform", `translate(${moonAt.x.toFixed(2)} ${moonAt.y.toFixed(2)})`);
      // The lit side faces the sun.
      moonBody.setAttribute("transform", `rotate(${((-angle * 180) / Math.PI).toFixed(1)})`);
      moonGroup.classList.toggle("below", height > 0.02);
      moonGroup.classList.toggle("off", !moonShown());
      moonLit.setAttribute("d", moonPath(5.5, moonShown() ? lit() : 0));
      clock.textContent = clockOf(value);
      part.textContent = daypartOf(value);
      for (const star of stars) star.classList.toggle("lit", daylight < 0.4);
      dial.setAttribute("aria-valuenow", String(value));
      dial.setAttribute("aria-valuetext", `${clockOf(value)}, ${daypartOf(value)}`);
      dial.classList.toggle("cycling", cycle !== undefined && knobs.on(cycle.key));
    },
  ];

  if (cycle) {
    const amountKey = `${cycle.key}-amount`;
    const playIcon = icon("play");
    const pauseIcon = icon("pause");
    const play = h(
      "button",
      { type: "button", class: "chip", title: cycle.help, "aria-label": cycle.label },
      h("span", { class: "chip-icon" }, playIcon, pauseIcon),
      h("span", { class: "chip-label" }, cycle.label),
    );
    play.addEventListener("click", () =>
      knobs.set({ [cycle.key]: knobs.on(cycle.key) ? 0 : 1 }, true),
    );
    const speed = slider(
      `${cycle.label} ${cycle.amountLabel}`,
      cycle.min,
      cycle.max,
      cycle.step,
      () => knobs.value(amountKey),
      (value, commit) => knobs.set({ [amountKey]: value }, commit),
    );
    const speedRow = row({
      label: cycle.label,
      help: cycle.help,
      icon: "clock",
      block: speed.el,
      readout: () => `${cycle.amountLabel} ${formatValue(cycle, knobs.value(amountKey))}`,
      modified: () => knobs.modified(knobKeys(cycle)),
      reset: () => knobs.reset(knobKeys(cycle)),
    });
    side.append(play);
    timeRow.el.append(speedRow.el);
    syncs.push(speed.sync, speedRow.sync, () => {
      const on = knobs.on(cycle.key);
      play.setAttribute("aria-pressed", String(on));
      playIcon.style.display = on ? "none" : "";
      pauseIcon.style.display = on ? "" : "none";
      speedRow.el.hidden = !on;
    });
  }
  if (moon) {
    const amountKey = `${moon.key}-amount`;
    const toggle = h(
      "button",
      { type: "button", class: "chip", role: "switch", title: moon.help, "aria-label": moon.label },
      h("span", { class: "chip-icon" }, icon("moon")),
      h("span", { class: "chip-label" }, moon.label),
    );
    toggle.addEventListener("click", () =>
      knobs.set({ [moon.key]: knobs.on(moon.key) ? 0 : 1 }, true),
    );
    const glyph = svg("path", { class: "moon-glyph-lit" });
    const preview = svg(
      "svg",
      { viewBox: "-8 -8 16 16", class: "moon-glyph", "aria-hidden": "true" },
      svg("circle", { r: 6.5, class: "moon-glyph-disc" }),
      glyph,
    );
    const phase = slider(
      `${moon.label} ${moon.amountLabel}`,
      moon.min,
      moon.max,
      moon.step,
      () => knobs.value(amountKey),
      (value, commit) => knobs.set({ [amountKey]: value }, commit),
      (value) => `${phaseOf(value)}, ${Math.round(value * 100)}% lit`,
    );
    const phaseRow = row({
      label: `${moon.label} ${moon.amountLabel}`,
      help: moon.help,
      icon: "moon",
      inline: [preview],
      block: phase.el,
      readout: () => phaseOf(knobs.value(amountKey)),
      modified: () => knobs.modified(knobKeys(moon)),
      reset: () => knobs.reset(knobKeys(moon)),
    });
    side.append(toggle);
    timeRow.el.append(phaseRow.el);
    syncs.push(phase.sync, phaseRow.sync, () => {
      const on = knobs.on(moon.key);
      toggle.setAttribute("aria-checked", String(on));
      glyph.setAttribute("d", moonPath(6.5, knobs.value(amountKey)));
      phaseRow.el.hidden = !on;
    });
  }
  return {
    el: timeRow.el,
    sync: () => {
      for (const sync of syncs) sync();
    },
  };
}
