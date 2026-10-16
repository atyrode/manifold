// Icon chips: a group's switches (toggles and features) as a grid of icon toggles. A feature whose
// amount is a range is a fader chip: the amount fills the chip while it is on and shows on it on
// hover, focus and drag; a click toggles it, a drag across sets the amount and switches it on, arrow
// keys step it (rules in chips-model.ts). A feature whose amount is a choice opens it in a row under
// the grid, under the same icon, while it is on. A chip with a trigger carries its "now". A chip that
// depends on another switch (`when`) shows only while that one is on.
import { formatValue, type Option, type ParamDef } from "../params.ts";
import { chipKey, pace, pressMove, type Press } from "./chips-model.ts";
import { nowButton, row, segments } from "./controls.ts";
import { drag, h, reveal, snap, type Built } from "./dom.ts";
import { icon } from "./icons.ts";
import { knobIcon, knobKeys, type FeatureDef, type Knobs, type SwitchDef } from "./knobs.ts";

const options = (list: readonly Option[]) =>
  list.map((option) => ({ label: option.label, value: String(option.value) }));

export interface Chips {
  grid: Built;
  /** The amounts that are choices, of the features that are on, one row each. */
  amounts: Built;
}

/** A switch's chip, showing its icon and `label` (its own by default); its owner sets aria-checked. */
export function chipButton(def: ParamDef, label = def.label): HTMLButtonElement {
  return h(
    "button",
    { type: "button", class: "chip", role: "switch", "aria-label": def.label, title: def.help },
    h("span", { class: "chip-icon" }, icon(knobIcon(def))),
    h("span", { class: "chip-label" }, label),
  );
}

/** A fader chip's amount, built onto its chip. */
interface Fader {
  /** Whether a click on the chip is the fader's (a drag's end, a press on the amount), not a toggle. */
  keeps(event: MouseEvent): boolean;
  sync(): void;
}

/** Faders built so far: each names its own description. */
let faders = 0;

/** Make `chip` the fader of `def`'s amount; `status` speaks what its keys set. */
function fader(knobs: Knobs, def: FeatureDef, chip: HTMLButtonElement, status: HTMLElement): Fader {
  const amountKey = `${def.key}-amount`;
  const fill = h("span", { class: "chip-fill" });
  const amount = h("span", { class: "chip-amount" });
  faders += 1;
  const description = h("span", { id: `chip-amount-${faders}`, hidden: true });
  chip.classList.add("fader");
  chip.prepend(fill);
  chip.append(amount, description);
  chip.setAttribute("aria-describedby", description.id);
  const reading = (value: number) => `${def.amountLabel} ${formatValue(def, value)}`;
  const set = (value: number, commit: boolean) =>
    knobs.set({ [def.key]: 1, [amountKey]: value }, commit);

  // The drag captures the pointer, so the click and double-click that follow a press land on the
  // chip whatever was under it: the press records whether a mouse began it on the amount (a touch
  // leaves the amount showing after a tap, and a tap on the chip always toggles it).
  let onAmount = false;
  let dragged = false;
  chip.addEventListener("pointerdown", (event) => {
    onAmount =
      event.pointerType === "mouse" &&
      event.target instanceof Node &&
      amount.contains(event.target);
    dragged = false;
    if (event.button !== 0) return;
    const perPixel = pace(def, chip.getBoundingClientRect().width);
    let press: Press = {
      x: event.clientX,
      y: event.clientY,
      value: knobs.value(amountKey),
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
      (end) => {
        chip.classList.remove("dragging");
        if (last === undefined) return;
        set(last, true);
        dragged = end.type === "pointerup";
      },
    );
  });
  chip.addEventListener("dblclick", () => {
    if (onAmount) knobs.reset([amountKey]);
  });
  chip.addEventListener("keydown", (event) => {
    const next = chipKey(event, knobs.value(def.key) > 0.5, knobs.value(amountKey), def);
    if (next === undefined) return;
    event.preventDefault();
    set(next, true);
    status.textContent = `${def.label} ${reading(next)}`;
  });

  return {
    keeps: (event) => {
      // A click from the keyboard (Space, Enter) has no press: it toggles.
      const kept = event.detail > 0 && (dragged || onAmount);
      dragged = false;
      return kept;
    },
    sync: () => {
      const value = knobs.value(amountKey);
      const share = Math.min(1, Math.max(0, (value - def.min) / (def.max - def.min)));
      fill.style.setProperty("--fill", `${(share * 100).toFixed(2)}%`);
      amount.textContent = formatValue(def, value);
      description.textContent = `${reading(value)}; arrow keys set it`;
      chip.title = `${def.help} ${reading(value)}: drag across the chip or use the arrow keys.`;
    },
  };
}

export function chipGrid(knobs: Knobs, defs: readonly SwitchDef[]): Chips {
  const syncs: (() => void)[] = [];
  const amountSyncs: (() => void)[] = [];
  const amountRows: HTMLElement[] = [];
  const status = h("span", { class: "chips-status", role: "status" });
  const cells = defs.map((def) => {
    const name = knobIcon(def);
    const chip = chipButton(def);
    const faded =
      def.kind === "feature" && !def.options ? fader(knobs, def, chip, status) : undefined;
    chip.addEventListener("click", (event) => {
      if (faded?.keeps(event)) return;
      knobs.set({ [def.key]: knobs.value(def.key) > 0.5 ? 0 : 1 }, true);
    });
    const dot = h("button", {
      type: "button",
      class: "modified",
      title: "Changed: click to reset",
      "aria-label": `Reset ${def.label}`,
    });
    dot.addEventListener("click", () => knobs.reset(knobKeys(def)));
    const slot = def.trigger;
    const words = def.kind === "feature" ? `${def.label} ${def.amountLabel}` : def.label;
    const cell = h(
      "div",
      {
        class: "chip-cell",
        "data-search": `${words} ${def.help}`.toLowerCase(),
        "data-keys": knobKeys(def).join(" "),
      },
      dot,
      chip,
      slot === undefined
        ? null
        : nowButton(def.label, () => knobs.fire(slot), { compact: true, whileOff: true }),
      h("p", { class: "hint" }, `${def.label}: ${def.help}`),
    );
    syncs.push(() => {
      const on = knobs.value(def.key) > 0.5;
      chip.setAttribute("aria-checked", String(on));
      cell.classList.toggle("on", on);
      cell.hidden = !knobs.on(def.when);
      dot.hidden = !knobs.modified(knobKeys(def));
      faded?.sync();
    });

    if (def.kind === "feature" && def.options) {
      const amountKey = `${def.key}-amount`;
      const control = segments(
        `${def.label} ${def.amountLabel}`,
        options(def.options),
        () => String(knobs.value(amountKey)),
        (value) => knobs.set({ [amountKey]: Number(value) }, true),
      );
      const amount = row({
        label: def.label,
        help: def.help,
        icon: name,
        block: control.el,
        readout: () => def.amountLabel,
        modified: () => knobs.modified([amountKey]),
        reset: () => knobs.reset([amountKey]),
      });
      amount.el.classList.add("amount-row");
      amount.el.dataset.keys = knobKeys(def).join(" ");
      const shown = reveal(amount.el, () => knobs.value(def.key) > 0.5 && knobs.on(def.when));
      amountRows.push(shown.el);
      amountSyncs.push(control.sync, amount.sync, shown.sync);
    }
    return cell;
  });

  return {
    grid: {
      el: h("div", { class: "chips" }, ...cells, status),
      sync: () => {
        for (const sync of syncs) sync();
      },
    },
    amounts: {
      el: h("div", { class: "amounts" }, ...amountRows),
      sync: () => {
        for (const sync of amountSyncs) sync();
      },
    },
  };
}
