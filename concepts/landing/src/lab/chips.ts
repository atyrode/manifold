// Icon chips: a group's switches (toggles and features) as a grid of icon toggles. A chip with a
// trigger carries its "now"; a feature that is on opens its amount in a row under the grid, under the
// same icon. A chip that depends on another switch (`when`) shows only while that one is on.
import { formatValue, type Option } from "../params.ts";
import { nowButton, row, segments, slider } from "./controls.ts";
import { h, reveal, type Built } from "./dom.ts";
import { icon } from "./icons.ts";
import { knobIcon, knobKeys, type Knobs, type SwitchDef } from "./knobs.ts";

const options = (list: readonly Option[]) =>
  list.map((option) => ({ label: option.label, value: String(option.value) }));

export interface Chips {
  grid: Built;
  /** The amounts of the features that are on, one row each. */
  amounts: Built;
}

export function chipGrid(knobs: Knobs, defs: readonly SwitchDef[]): Chips {
  const syncs: (() => void)[] = [];
  const amountSyncs: (() => void)[] = [];
  const amountRows: HTMLElement[] = [];
  const cells = defs.map((def) => {
    const name = knobIcon(def);
    const chip = h(
      "button",
      { type: "button", class: "chip", role: "switch", "aria-label": def.label, title: def.help },
      h("span", { class: "chip-icon" }, icon(name)),
      h("span", { class: "chip-label" }, def.label),
    );
    chip.addEventListener("click", () =>
      knobs.set({ [def.key]: knobs.value(def.key) > 0.5 ? 0 : 1 }, true),
    );
    const dot = h("button", {
      type: "button",
      class: "modified",
      title: "Changed: click to reset",
      "aria-label": `Reset ${def.label}`,
    });
    dot.addEventListener("click", () => knobs.reset(knobKeys(def)));
    const slot = def.trigger;
    const cell = h(
      "div",
      { class: "chip-cell", "data-search": `${def.label} ${def.help}`.toLowerCase() },
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
    });

    if (def.kind === "feature") {
      const amountKey = `${def.key}-amount`;
      const control = def.options
        ? segments(
            `${def.label} ${def.amountLabel}`,
            options(def.options),
            () => String(knobs.value(amountKey)),
            (value) => knobs.set({ [amountKey]: Number(value) }, true),
          )
        : slider(
            `${def.label} ${def.amountLabel}`,
            def.min,
            def.max,
            def.step,
            () => knobs.value(amountKey),
            (value, commit) => knobs.set({ [amountKey]: value }, commit),
          );
      const amount = row({
        label: def.label,
        help: def.help,
        icon: name,
        block: control.el,
        readout: () =>
          def.options
            ? def.amountLabel
            : `${def.amountLabel} ${formatValue(def, knobs.value(amountKey))}`,
        modified: () => knobs.modified([amountKey]),
        reset: () => knobs.reset([amountKey]),
      });
      amount.el.classList.add("amount-row");
      const shown = reveal(amount.el, () => knobs.value(def.key) > 0.5 && knobs.on(def.when));
      amountRows.push(shown.el);
      amountSyncs.push(control.sync, amount.sync, shown.sync);
    }
    return cell;
  });

  return {
    grid: {
      el: h("div", { class: "chips" }, ...cells),
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
