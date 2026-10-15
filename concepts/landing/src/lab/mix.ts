// A mix bar: relative weights (knobs sharing a `mix` widget) as one stacked bar, each part's share of
// the total; mix-model.ts holds the rules. A part is a range, or a feature whose amount is its weight
// while it is on: each feature part has an icon chip over the bar that switches it on (with the
// weight it had) and off, and only the parts that are in take a segment. Drag a divider to trade
// weight between the two parts beside it (their sum holds); each part in the legend is a slider for
// its own weight (arrows, Page keys, Home/End, Delete for zero, which switches a feature off), and a
// range's has a button that leaves it out or brings it back.
import { chipButton } from "./chips.ts";
import { row } from "./controls.ts";
import { drag, h, keyStep, type Built } from "./dom.ts";
import { icon } from "./icons.ts";
import { knobKeys, type Knobs } from "./knobs.ts";
import {
  dividerDrag,
  setWeight,
  shareOf,
  spans,
  switchedOn,
  toggleIn,
  weightKey,
  weightOf,
  type KnobPatch,
  type MixPart,
} from "./mix-model.ts";

export function mixBar(knobs: Knobs, name: string, parts: readonly MixPart[]): Built {
  const read = (key: string) => knobs.value(key);
  const defaults = (key: string) => knobs.default(key);
  const weight = (part: MixPart) => weightOf(part, read);
  const shareText = (part: MixPart) => `${Math.round(shareOf(part, parts, read) * 100)}%`;
  const features = parts.filter((part) => part.def.kind === "feature");
  const hasRanges = features.length < parts.length;

  const bar = h("div", { class: "mix-bar" });
  const empty = h(
    "p",
    { class: "mix-empty" },
    features.length > 0 ? "nothing in the mix" : "all weights zero",
  );
  const segments = parts.map((part) => {
    const label = h("span", { class: "mix-seg-label" });
    const segment = h("div", { class: "mix-seg", title: part.def.help }, label);
    segment.style.setProperty("--swatch", part.swatch);
    segment.addEventListener("click", () => legend.get(part)?.focus());
    return { part, segment, label };
  });
  bar.append(...segments.map(({ segment }) => segment), empty);
  const dividers: HTMLElement[] = [];
  /** The two parts beside the divider being dragged: shown even at weight zero until it is let go. */
  let held: readonly MixPart[] = [];

  const startDivider = (event: PointerEvent, divider: HTMLElement, index: number) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const trade = dividerDrag(parts, read, index);
    if (!trade) return;
    const rect = bar.getBoundingClientRect();
    let patch: KnobPatch = {};
    held = trade.held;
    divider.classList.add("dragging");
    drag(
      event,
      divider,
      (pointer) => {
        patch = trade.at((pointer.clientX - rect.left) / Math.max(1, rect.width));
        knobs.set(patch, false);
      },
      () => {
        held = [];
        divider.classList.remove("dragging");
        knobs.set(trade.release(patch), true);
      },
    );
  };

  /** A modified dot resetting `keys`. */
  const resetDot = (label: string, keys: readonly string[]) => {
    const dot = h("button", {
      type: "button",
      class: "modified",
      title: "Changed: click to reset",
      "aria-label": `Reset ${label}`,
    });
    dot.addEventListener("click", () => knobs.reset(keys));
    return dot;
  };

  // The feature parts' chips: the part's icon in its swatch while it is on.
  const chips = new Map<MixPart, HTMLButtonElement>();
  const chipSyncs: (() => void)[] = [];
  const chipCells = features.map((part) => {
    const { def } = part;
    const chip = chipButton(def, part.part);
    chip.style.setProperty("--swatch", part.swatch);
    chip.addEventListener("click", () => knobs.set(toggleIn(part, parts, read, defaults), true));
    chips.set(part, chip);
    const dot = resetDot(def.label, knobKeys(def));
    chipSyncs.push(() => {
      chip.setAttribute("aria-checked", String(switchedOn(part, read)));
      dot.hidden = !knobs.modified(knobKeys(def));
    });
    return h(
      "div",
      { class: "chip-cell" },
      dot,
      chip,
      h("p", { class: "hint" }, `${part.part}: ${def.help}`),
    );
  });

  const legend = new Map<MixPart, HTMLElement>();
  const legendSyncs: (() => void)[] = [];
  const items = parts.map((part) => {
    const { def } = part;
    const slider = h(
      "span",
      {
        class: "mix-name",
        role: "slider",
        tabIndex: 0,
        "aria-label": def.label,
        "aria-valuemin": String(def.min),
        "aria-valuemax": String(def.max),
        title: def.help,
      },
      part.part,
    );
    legend.set(part, slider);
    slider.addEventListener("keydown", (event) => {
      const delta = keyStep(event, def.step, def.max - def.min);
      const zero = event.key === "Home" || event.key === "Delete" || event.key === "Backspace";
      const next =
        delta !== undefined
          ? weight(part) + delta
          : zero
            ? def.min
            : event.key === "End"
              ? def.max
              : undefined;
      if (next === undefined) return;
      event.preventDefault();
      knobs.set(setWeight(part, next), true);
      // A feature switched off leaves the legend: its chip takes the focus.
      if (!switchedOn(part, read)) chips.get(part)?.focus();
    });
    const share = h("span", { class: "mix-share" });
    const raw = h("span", { class: "mix-weight" });
    const key = weightKey(def);
    const dot = resetDot(def.label, [key]);
    const swatch = h("span", { class: "mix-swatch" });
    swatch.style.setProperty("--swatch", part.swatch);
    const item = h(
      "li",
      { class: "mix-part", "data-search": `${def.label} ${def.help}`.toLowerCase() },
      dot,
      swatch,
      slider,
      share,
      raw,
    );
    let syncToggle = () => {};
    if (def.kind === "range") {
      // A range leaves and comes back by its cross; a feature's chip does that, and holds its help.
      const outIcon = icon("close");
      const inIcon = icon("plus");
      const toggle = h("button", { type: "button", class: "mix-toggle" }, outIcon, inIcon);
      toggle.addEventListener("click", () =>
        knobs.set(toggleIn(part, parts, read, defaults), true),
      );
      item.append(toggle, h("p", { class: "hint" }, def.help));
      syncToggle = () => {
        const out = weight(part) <= 0;
        toggle.title = out ? `Bring ${part.part} back in` : `Leave ${part.part} out (weight zero)`;
        toggle.setAttribute("aria-label", toggle.title);
        outIcon.style.display = out ? "none" : "";
        inIcon.style.display = out ? "" : "none";
      };
    }
    legendSyncs.push(() => {
      const value = knobs.value(key);
      item.hidden = !switchedOn(part, read);
      item.classList.toggle("out", weight(part) <= 0);
      share.textContent = shareText(part);
      raw.textContent = String(value);
      slider.setAttribute("aria-valuenow", String(value));
      slider.setAttribute("aria-valuetext", `weight ${value}, ${shareText(part)} of the mix`);
      syncToggle();
      dot.hidden = !knobs.modified([key]);
    });
    return item;
  });

  const keys = parts.flatMap((part) => knobKeys(part.def));
  const built = row({
    label: name,
    help:
      features.length === 0
        ? "Relative weights, normalised together: a part's share is its weight over the sum. Drag a divider to trade share between its neighbours; in the list, arrow keys change a part's weight and the cross leaves it out."
        : `Relative weights, normalised together: a part's share is its weight over the sum of the parts switched on. A chip switches its part on, with the weight it had, or off; drag a divider to trade share between its neighbours; in the list, arrow keys change a part's weight${hasRanges ? " and the cross leaves it out" : ""}.`,
    icon: "fields",
    block: h(
      "div",
      { class: "mix" },
      chipCells.length > 0 ? h("div", { class: "chips mix-chips" }, ...chipCells) : null,
      bar,
      h("ul", { class: "mix-legend" }, ...items),
    ),
    readout: () => `${parts.filter((part) => weight(part) > 0).length} of ${parts.length} in`,
    modified: () => knobs.modified(keys),
    reset: () => knobs.reset(keys),
  });
  built.el.dataset.search = [name, ...parts.map((part) => `${part.def.label} ${part.def.help}`)]
    .join(" ")
    .toLowerCase();

  return {
    el: built.el,
    sync: () => {
      built.sync();
      for (const sync of chipSyncs) sync();
      const shown = spans(parts, read, held);
      for (const { part, segment, label } of segments) {
        const span = shown.find((candidate) => candidate.part === part);
        segment.hidden = span === undefined;
        segment.style.flexGrow = String(weight(part));
        const width = span ? span.end - span.start : 0;
        label.textContent =
          width >= 0.3 ? `${part.part} ${shareText(part)}` : width >= 0.1 ? shareText(part) : "";
      }
      empty.hidden = shown.length > 0;
      // One divider between each pair of neighbours; rebuilt only when their number changes, so a
      // divider being dragged keeps its pointer capture.
      while (dividers.length < shown.length - 1) {
        const index = dividers.length;
        const divider = h("div", { class: "mix-divider", "aria-hidden": "true" });
        divider.addEventListener("pointerdown", (event) => startDivider(event, divider, index));
        dividers.push(divider);
        bar.append(divider);
      }
      for (const [index, divider] of dividers.entries()) {
        const span = shown[index];
        divider.hidden = index >= shown.length - 1 || span === undefined;
        if (span) divider.style.left = `${(span.end * 100).toFixed(3)}%`;
      }
      for (const sync of legendSyncs) sync();
    },
  };
}
