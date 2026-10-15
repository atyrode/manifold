// The lab's plain controls: buttons, switches, sliders, segments, the "now" trigger and the seed's
// dice, and the row that labels a control with its readout, reset and help.
import { h, type Built } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";

export function iconButton(
  name: IconName,
  label: string,
  onClick: (button: HTMLButtonElement) => void,
  className = "icon-button",
): HTMLButtonElement {
  const button = h(
    "button",
    { type: "button", class: className, title: label, "aria-label": label },
    icon(name),
  );
  button.addEventListener("click", () => onClick(button));
  return button;
}

export function textButton(
  name: IconName | undefined,
  text: string,
  title: string,
  onClick: (button: HTMLButtonElement) => void,
): HTMLButtonElement {
  const button = h(
    "button",
    { type: "button", class: "text-button", title },
    name ? icon(name) : null,
    h("span", {}, text),
  );
  button.addEventListener("click", () => onClick(button));
  return button;
}

/** Show `text` on a text button for a moment (copied, failed...). */
export function flash(button: HTMLButtonElement, text: string): void {
  const label = button.querySelector("span");
  if (!label) return;
  const original = label.dataset.text ?? label.textContent ?? "";
  label.dataset.text = original;
  label.textContent = text;
  setTimeout(() => {
    label.textContent = original;
  }, 1500);
}

export function switchControl(label: string, get: () => boolean, set: (on: boolean) => void): Built {
  const el = h(
    "button",
    { type: "button", role: "switch", class: "switch", "aria-label": label },
    h("span", { class: "knob" }),
  );
  el.addEventListener("click", () => set(!get()));
  return { el, sync: () => el.setAttribute("aria-checked", String(get())) };
}

export function slider(
  label: string,
  min: number,
  max: number,
  step: number,
  get: () => number,
  set: (value: number, commit: boolean) => void,
  valueText?: (value: number) => string,
): Built {
  const el = h("input", {
    type: "range",
    min: String(min),
    max: String(max),
    step: String(step),
    "aria-label": label,
  });
  el.addEventListener("input", () => set(Number(el.value), false));
  const sync = () => {
    const value = get();
    if (document.activeElement !== el) el.value = String(value);
    el.style.setProperty("--fill", `${((value - min) / (max - min)) * 100}%`);
    if (valueText) el.setAttribute("aria-valuetext", valueText(value));
  };
  return { el, sync };
}

export function segments(
  label: string,
  options: readonly { label: string; value: string }[],
  get: () => string,
  set: (value: string) => void,
): Built {
  const buttons = options.map((option) => {
    const button = h("button", { type: "button", "data-value": option.value }, option.label);
    button.addEventListener("click", () => set(option.value));
    return button;
  });
  const el = h("div", { class: "segments", role: "group", "aria-label": label }, ...buttons);
  // Long choices wrap into rows instead of truncating their names.
  const width = options.reduce((longest, option) => Math.max(longest, option.label.length), 0) + 2;
  el.style.setProperty("--option-width", `${width}ch`);
  return {
    el,
    sync: () => {
      for (const button of buttons)
        button.setAttribute("aria-pressed", String(button.dataset.value === get()));
    },
  };
}

/**
 * A knob's "now": fires one occurrence of its event (`fire`) and plays a short cooldown sweep (a
 * colour change alone under reduced motion). `compact` drops the word, for chips and the transport.
 * A switch's "now" plays its event even while the switch is off.
 */
export function nowButton(
  what: string,
  fire: () => void,
  options: { compact?: boolean; whileOff?: boolean } = {},
): HTMLButtonElement {
  const label = `Now: ${what}`;
  const button = h(
    "button",
    {
      type: "button",
      class: `now${options.compact ? " compact" : ""}`,
      title: `${what}, right now${options.whileOff ? ", even while it is switched off" : ""}`,
      "aria-label": label,
    },
    icon("bolt"),
    options.compact ? null : h("span", {}, "now"),
  );
  let cooling: number | undefined;
  button.addEventListener("click", () => {
    fire();
    button.classList.remove("firing");
    // Restart the sweep on a quick second press.
    void button.offsetWidth;
    button.classList.add("firing");
    window.clearTimeout(cooling);
    cooling = window.setTimeout(() => button.classList.remove("firing"), 900);
  });
  return button;
}

/** One control row: label, help toggle, readout and inline controls on top, a block control under. */
export function row(spec: {
  label: string;
  help: string;
  icon?: IconName;
  inline?: Element[];
  block?: HTMLElement;
  readout?: () => string;
  modified?: () => boolean;
  reset?: () => void;
}): Built {
  const hint = h("p", { class: "hint" }, spec.help);
  const hintToggle = h(
    "button",
    {
      type: "button",
      class: "hint-toggle",
      title: "What is this?",
      "aria-label": `About ${spec.label}`,
      "aria-expanded": "false",
    },
    "?",
  );
  hintToggle.addEventListener("click", () => {
    const open = hintToggle.getAttribute("aria-expanded") !== "true";
    hintToggle.setAttribute("aria-expanded", String(open));
    el.classList.toggle("hint-open", open);
  });
  const dot = h("button", {
    type: "button",
    class: "modified",
    title: "Changed: click to reset",
    "aria-label": `Reset ${spec.label}`,
  });
  if (spec.reset) dot.addEventListener("click", spec.reset);
  const readout = h("span", { class: "readout" });
  const el = h(
    "div",
    { class: "row", "data-search": `${spec.label} ${spec.help}`.toLowerCase() },
    h(
      "div",
      { class: "row-head" },
      dot,
      spec.icon ? icon(spec.icon) : null,
      h("span", { class: "row-label" }, spec.label),
      hintToggle,
      h("span", { class: "spacer" }),
      spec.readout ? readout : null,
      ...(spec.inline ?? []),
    ),
    spec.block ?? null,
    hint,
  );
  if (spec.reset)
    el.addEventListener("dblclick", (event) => {
      if (event.target instanceof Element && event.target.closest(".row-label")) spec.reset?.();
    });
  return {
    el,
    sync: () => {
      dot.hidden = !(spec.modified?.() ?? false);
      if (spec.readout) readout.textContent = spec.readout();
    },
  };
}

/** A seed's dice: rolls another arrangement (never the one on screen) with a short tumble. */
export function dice(label: string, roll: () => void): HTMLButtonElement {
  const button = h(
    "button",
    { type: "button", class: "dice", title: `Roll another ${label}`, "aria-label": `Roll ${label}` },
    icon("dice"),
    h("span", {}, "roll"),
  );
  button.addEventListener("click", () => {
    roll();
    button.classList.remove("rolling");
    void button.offsetWidth;
    button.classList.add("rolling");
  });
  button.addEventListener("animationend", () => button.classList.remove("rolling"));
  return button;
}
