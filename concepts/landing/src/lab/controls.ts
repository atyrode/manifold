// The lab's plain controls: buttons, switches, sliders, segments, the "now" trigger and the seed's
// dice, the row that labels a control with its readout, reset and help, and what every custom
// slider-like widget shares: its slider behaviour (sliderBehaviour), a drag that lets a vertical
// swipe scroll the panel (dragAcross) and the "changed" dot (resetDot).
import { dragsAcross, pace, pressMove, SCRUB_SPAN, type Press } from "./chips-model.ts";
import {
  drag,
  h,
  setAttr,
  setHidden,
  setStyle,
  setText,
  snap,
  type Built,
  type Patch,
} from "./dom.ts";
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

export function switchControl(
  label: string,
  get: () => boolean,
  set: (on: boolean) => void,
): Built {
  const el = h(
    "button",
    { type: "button", role: "switch", class: "switch", "aria-label": label },
    h("span", { class: "knob" }),
  );
  el.addEventListener("click", () => set(!get()));
  return { el, sync: () => setAttr(el, "aria-checked", String(get())) };
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
    if (document.activeElement !== el && el.value !== String(value)) el.value = String(value);
    setStyle(el, "--fill", `${((value - min) / (max - min)) * 100}%`);
    if (valueText) setAttr(el, "aria-valuetext", valueText(value));
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
        setAttr(button, "aria-pressed", String(button.dataset.value === get()));
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

/**
 * A control's "changed" dot, hidden until its owner's sync shows it (while the control differs
 * from its default): a click resets it. It hangs off the control's left edge.
 */
export function resetDot(label: string, reset: (() => void) | undefined): HTMLButtonElement {
  const dot = h("button", {
    type: "button",
    class: "modified",
    title: "Changed: click to reset",
    "aria-label": `Reset ${label}`,
    hidden: true,
  });
  if (reset) dot.addEventListener("click", reset);
  return dot;
}

/**
 * Follow a press on a one-dimensional widget as `drag` does, except a touch (or pen): that waits
 * until it moves across (chips-model.ts dragsAcross), so a swipe down scrolls the panel (the
 * widget's `touch-action: pan-y`; the browser then cancels the press) and changes nothing, and a
 * tap that never moved lands once where it was let go.
 */
export function dragAcross(
  event: PointerEvent,
  target: HTMLElement,
  move: (event: PointerEvent) => void,
  end: (event: PointerEvent) => void,
): void {
  if (event.pointerType === "mouse") {
    drag(event, target, move, end);
    return;
  }
  let across = false;
  drag(
    event,
    target,
    (pointer) => {
      across ||= dragsAcross(pointer.clientX - event.clientX, pointer.clientY - event.clientY);
      if (across) move(pointer);
    },
    (last) => {
      if (!across && last.type === "pointerup") move(last);
      end(last);
    },
  );
}

/**
 * Make `el` a slider for the keyboard and assistive technology, its value in `min..max`: in the
 * tab order, a key sets `key`'s patch at once (one undo step), and a press, where `press` takes it,
 * sets the patch at each pointer position as it moves and records the last on release. `press`
 * gets the pointerdown and returns where each position lands (undefined there: nothing), or
 * undefined for a press that is not the widget's (it is left to what lies under it). `across`: the
 * widget runs one way across, so a touch waits until it moves across (dragAcross). While pressed
 * the widget is `dragging`. Returns the sync of its value and words (aria-valuenow, -valuetext).
 */
export function sliderBehaviour(
  el: HTMLElement,
  spec: {
    min: number;
    max: number;
    now: () => number;
    text: () => string;
    set: (patch: Patch, commit: boolean) => void;
    key: (event: KeyboardEvent) => Patch | undefined;
    press?: (down: PointerEvent) => ((pointer: PointerEvent) => Patch | undefined) | undefined;
    across?: boolean;
  },
): () => void {
  el.setAttribute("role", "slider");
  el.tabIndex = 0;
  el.setAttribute("aria-valuemin", String(spec.min));
  el.setAttribute("aria-valuemax", String(spec.max));
  el.addEventListener("keydown", (event) => {
    const patch = spec.key(event);
    if (!patch) return;
    event.preventDefault();
    spec.set(patch, true);
  });
  const { press } = spec;
  if (press)
    el.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const at = press(event);
      if (!at) return;
      event.preventDefault();
      el.focus();
      el.classList.add("dragging");
      let patch: Patch | undefined;
      let held = "";
      (spec.across ? dragAcross : drag)(
        event,
        el,
        (pointer) => {
          const next = at(pointer);
          if (!next) return;
          const key = JSON.stringify(next);
          if (key === held) return;
          held = key;
          patch = next;
          spec.set(next, false);
        },
        () => {
          el.classList.remove("dragging");
          if (patch) spec.set(patch, true);
        },
      );
    });
  return () => {
    setAttr(el, "aria-valuenow", String(spec.now()));
    setAttr(el, "aria-valuetext", spec.text());
  };
}

/**
 * Let a readout scrub the range input of its row (rules in chips-model.ts): a drag across moves the
 * value, finer with Shift, through the input's own events, so the row sets it while dragging and the
 * lab records it on release, as it does a drag of the slider.
 */
function scrubber(readout: HTMLElement, input: HTMLInputElement): void {
  readout.classList.add("scrub");
  readout.title = "Drag across to scrub (Shift: finer); double-click to reset";
  readout.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const bounds = { min: Number(input.min), max: Number(input.max), step: Number(input.step) };
    const perPixel = pace(bounds, SCRUB_SPAN);
    let press: Press = {
      x: event.clientX,
      y: event.clientY,
      value: Number(input.value),
      scrub: undefined,
    };
    drag(
      event,
      readout,
      (pointer) => {
        press = pressMove(
          press,
          pointer.clientX,
          pointer.clientY,
          perPixel,
          pointer.shiftKey,
          bounds,
        );
        if (!press.scrub) return;
        readout.classList.add("scrubbing");
        const value = String(snap(press.scrub.value, bounds.min, bounds.max, bounds.step));
        if (value === input.value) return;
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      },
      () => {
        if (!press.scrub) return;
        readout.classList.remove("scrubbing");
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
    );
  });
}

/**
 * One control row: label, help toggle, readout and inline controls on top, a block control under. A
 * readout over a range input scrubs it; double-clicking the label or the readout resets the row.
 */
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
  const dot = resetDot(spec.label, spec.reset);
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
  if (spec.readout && spec.block instanceof HTMLInputElement && spec.block.type === "range")
    scrubber(readout, spec.block);
  if (spec.reset)
    el.addEventListener("dblclick", (event) => {
      if (event.target instanceof Element && event.target.closest(".row-label, .readout"))
        spec.reset?.();
    });
  return {
    el,
    sync: () => {
      setHidden(dot, !(spec.modified?.() ?? false));
      if (spec.readout) setText(readout, spec.readout());
    },
  };
}

/** A seed's dice: rolls another arrangement (never the one on screen) with a short tumble. */
export function dice(label: string, roll: () => void): HTMLButtonElement {
  const button = h(
    "button",
    {
      type: "button",
      class: "dice",
      title: `Roll another ${label}`,
      "aria-label": `Roll ${label}`,
    },
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
