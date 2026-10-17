// Icon chips: a group's switches (toggles and features) as a grid of icon toggles. A feature whose
// amount is a range is a fader chip: the amount fills the chip while it is on and shows on it on
// hover, focus and drag; a click toggles it, a drag across sets the amount and switches it on, arrow
// keys step it (rules in chips-model.ts). The same fader without a switch is a range's slider (the
// night's stars, nightsky.ts). A feature whose amount is a choice opens it in a row under the grid,
// under the same icon, while it is on. A chip with a trigger carries its "now". A chip that hangs on
// another switch (`when`, to any depth) is a gate: the Controls view shows it while that one is on
// (availability-model.ts). Where the season sets the climate, the rain's and the snow's chips carry
// its marks (climate-hint-model.ts), a readout over their top edge that changes nothing. A grid's
// owner may decide what switching a chip changes besides its own switch (a composed scene's layers
// swap and exclude each other, layers.ts) and mark a chip switched on that draws nothing as refused,
// dimmed, with the reason in its title.
import { formatValue, type Option, type ParamDef } from "../params.ts";
import { chipKey, pace, pressMove, type Press } from "./chips-model.ts";
import type { ClimateMark, ClimateMarks } from "./climate-hint-model.ts";
import { nowButton, resetDot, row, segments } from "./controls.ts";
import {
  dependent,
  drag,
  gate,
  h,
  setAttr,
  setHidden,
  setStyle,
  setText,
  snap,
  type Built,
  type Patch,
} from "./dom.ts";
import { icon } from "./icons.ts";
import {
  knobIcon,
  knobKeys,
  type FeatureDef,
  type Knobs,
  type RangeDef,
  type SwitchDef,
} from "./knobs.ts";

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
export interface Fader {
  /** Whether a click on the chip is the fader's (a drag's end, a press on the amount), not a toggle. */
  keeps(event: MouseEvent): boolean;
  /** Reflect the amount; `note` follows the chip's title. */
  sync(note?: string): void;
}

/** What switching `def` on or off changes: by default its own switch alone. */
export type Turn = (def: SwitchDef, on: boolean) => Patch;

const ownTurn: Turn = (def, on) => ({ [def.key]: on ? 1 : 0 });

/** Faders built so far: each names its own description. */
let faders = 0;

/**
 * Make `chip` the fader of `def`: a feature's amount on its switch's chip (a button whose owner
 * sets aria-checked; a drag or a key switches it on, as `turn` has it, `status` speaks what a key
 * sets, a description reads the amount), or a range itself on a chip that is its slider.
 * Double-clicking the amount resets it.
 */
export function fader(
  knobs: Knobs,
  def: FeatureDef | RangeDef,
  chip: HTMLElement,
  status: HTMLElement | undefined,
  turn: Turn = ownTurn,
): Fader {
  const switched = def.kind === "feature";
  const key = switched ? `${def.key}-amount` : def.key;
  const fill = h("span", { class: "chip-fill" });
  const amount = h("span", { class: "chip-amount" });
  chip.classList.add("fader");
  chip.prepend(fill);
  chip.append(amount);
  let description: HTMLElement | undefined;
  if (switched) {
    faders += 1;
    description = h("span", { id: `chip-amount-${faders}`, hidden: true });
    chip.append(description);
    chip.setAttribute("aria-describedby", description.id);
  } else {
    chip.setAttribute("role", "slider");
    chip.tabIndex = 0;
    chip.setAttribute("aria-valuemin", String(def.min));
    chip.setAttribute("aria-valuemax", String(def.max));
  }
  const reading = (value: number) =>
    `${switched ? def.amountLabel : def.label} ${formatValue(def, value)}`;
  const set = (value: number, commit: boolean) =>
    knobs.set(
      def.kind === "feature" ? { ...turn(def, true), [key]: value } : { [key]: value },
      commit,
    );

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
      value: knobs.value(key),
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
    if (onAmount) knobs.reset([key]);
  });
  chip.addEventListener("keydown", (event) => {
    const on = !switched || knobs.value(def.key) > 0.5;
    const next = chipKey(event, on, knobs.value(key), def);
    if (next === undefined) return;
    event.preventDefault();
    set(next, true);
    if (status) status.textContent = `${def.label} ${reading(next)}`;
  });

  return {
    keeps: (event) => {
      // A click from the keyboard (Space, Enter) has no press: it toggles.
      const kept = event.detail > 0 && (dragged || onAmount);
      dragged = false;
      return kept;
    },
    sync: (note = "") => {
      const value = knobs.value(key);
      const share = Math.min(1, Math.max(0, (value - def.min) / (def.max - def.min)));
      setStyle(fill, "--fill", `${(share * 100).toFixed(2)}%`);
      setText(amount, formatValue(def, value));
      if (description) setText(description, `${reading(value)}; arrow keys set it`);
      else {
        setAttr(chip, "aria-valuenow", String(value));
        setAttr(chip, "aria-valuetext", formatValue(def, value));
      }
      setAttr(
        chip,
        "title",
        `${def.help} ${reading(value)}: drag across the chip or use the arrow keys.${note}`,
      );
    },
  };
}

/** Climate marks built so far: each names its own element. */
let badges = 0;

/** `chip`'s climate mark, read as part of its description; hidden while it has none. */
function markBadge(chip: HTMLButtonElement): {
  el: HTMLElement;
  show(mark: ClimateMark | undefined): void;
} {
  badges += 1;
  const el = h("span", { class: "chip-mark", id: `chip-mark-${badges}`, hidden: true });
  const described = chip.getAttribute("aria-describedby");
  chip.setAttribute("aria-describedby", described ? `${described} ${el.id}` : el.id);
  return {
    el,
    show: (mark) => {
      setHidden(el, mark === undefined);
      setText(el, mark?.text ?? "");
      setAttr(el, "data-kind", mark?.kind ?? "");
    },
  };
}

/** What a grid's owner decides of its chips. */
export interface ChipOptions {
  /** Where the season sets the climate: the marks on the rain's and the snow's chips. */
  marks?: ClimateMarks | undefined;
  /** What switching a chip changes (a click, a fader's drag or key switching it on). */
  turn?: Turn;
  /** Why `def`, switched on, draws nothing: its chip shows refused, dimmed, the reason in its title. */
  refusal?: (def: SwitchDef) => string | undefined;
}

/** The grid of `defs`' chips, as `options` has them. */
export function chipGrid(
  knobs: Knobs,
  defs: readonly SwitchDef[],
  { marks, turn = ownTurn, refusal }: ChipOptions = {},
): Chips {
  const syncs: (() => void)[] = [];
  const amountSyncs: (() => void)[] = [];
  const amountRows: HTMLElement[] = [];
  const status = h("span", { class: "chips-status", role: "status" });
  /** The marks for the knobs as they stand, read once per sync. */
  let marked: Readonly<Record<string, ClimateMark>> = {};
  const cells = defs.map((def) => {
    const name = knobIcon(def);
    const chip = chipButton(def);
    const faded =
      def.kind === "feature" && !def.options ? fader(knobs, def, chip, status, turn) : undefined;
    const badge = marks ? markBadge(chip) : undefined;
    chip.addEventListener("click", (event) => {
      if (faded?.keeps(event)) return;
      const patch = turn(def, knobs.value(def.key) <= 0.5);
      if (Object.keys(patch).length > 0) knobs.set(patch, true);
    });
    const dot = resetDot(def.label, () => knobs.reset(knobKeys(def)));
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
      badge?.el ?? null,
      slot === undefined
        ? null
        : nowButton(def.label, () => knobs.fire(slot), { compact: true, whileOff: true }),
      h("p", { class: "hint" }, `${def.label}: ${def.help}`),
    );
    if (def.when !== undefined) gate(cell, knobs.chain(def.when), () => knobs.live(def.when));
    syncs.push(() => {
      const on = knobs.value(def.key) > 0.5;
      setAttr(chip, "aria-checked", String(on));
      cell.classList.toggle("on", on);
      setHidden(dot, !knobs.modified(knobKeys(def)));
      // A fader's title words its amount, a plain chip's is its help; a climate mark or why it
      // draws nothing follows.
      const mark = badge ? marked[def.key] : undefined;
      badge?.show(mark);
      const refused = on ? refusal?.(def) : undefined;
      cell.classList.toggle("refused", refused !== undefined);
      const note = mark ? ` ${mark.help}` : refused ? ` Not drawn: ${refused}.` : "";
      if (faded) faded.sync(note);
      else if (badge || refusal) setAttr(chip, "title", `${def.help}${note}`);
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
      amount.el.dataset.keys = amountKey;
      // Open while its feature is on (and whatever that hangs on).
      const chain = [def.key, ...knobs.chain(def.when)];
      amountRows.push(dependent(amount.el, chain, () => knobs.on(def.key) && knobs.live(def.when)));
      amountSyncs.push(control.sync, amount.sync);
    }
    return cell;
  });

  return {
    grid: {
      el: h("div", { class: "chips" }, ...cells, status),
      sync: () => {
        if (marks) marked = marks((key) => knobs.value(key));
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
