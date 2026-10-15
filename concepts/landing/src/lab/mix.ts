// A mix bar: relative weights (range knobs sharing a `mix` widget) as one stacked bar, each part's
// share of the total. Drag a divider to trade weight between the two parts beside it (their sum
// holds); each part in the legend is a slider for its own weight (arrows, Page keys, Home/End,
// Delete for zero) with a button that leaves it out or brings it back.
import { row } from "./controls.ts";
import { drag, h, keyStep, snap, type Built } from "./dom.ts";
import { icon } from "./icons.ts";
import type { Knobs, RangeDef } from "./knobs.ts";

export interface MixPart {
  def: RangeDef;
  part: string;
  swatch: string;
}

export function mixBar(knobs: Knobs, name: string, parts: readonly MixPart[]): Built {
  const weight = (part: MixPart) => knobs.value(part.def.key);
  const total = () => parts.reduce((sum, part) => sum + weight(part), 0);
  const shareText = (part: MixPart) => {
    const sum = total();
    return sum > 0 ? `${Math.round((weight(part) / sum) * 100)}%` : "0%";
  };

  const bar = h("div", { class: "mix-bar" });
  const empty = h("p", { class: "mix-empty" }, "all weights zero");
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

  /** The parts with weight, in order, as fractions of the bar: start and end. */
  const spans = () => {
    const sum = total();
    let start = 0;
    return parts
      .map((part) => {
        const width = sum > 0 ? weight(part) / sum : 0;
        const span = { part, start, end: start + width };
        start += width;
        return span;
      })
      .filter((span) => span.end > span.start || held.includes(span.part));
  };

  /**
   * Drag divider `index`: the two parts beside it trade share at the pointer and every other part
   * keeps its share. Their weights keep their sum while both fit under their maximum; past it every
   * weight scales down together, so the shares still come out as dragged.
   */
  const startDivider = (event: PointerEvent, divider: HTMLElement, index: number) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const shown = spans();
    const left = shown[index];
    const right = shown[index + 1];
    if (!left || !right) return;
    const start = new Map(parts.map((part) => [part, weight(part)]));
    const sum = total();
    const rect = bar.getBoundingClientRect();
    let patch: Record<string, number> = {};
    held = [left.part, right.part];
    divider.classList.add("dragging");
    drag(
      event,
      divider,
      (pointer) => {
        const at = (pointer.clientX - rect.left) / Math.max(1, rect.width);
        const into = Math.min(right.end, Math.max(left.start, at));
        const next = new Map(start);
        next.set(left.part, (into - left.start) * sum);
        next.set(right.part, (right.end - into) * sum);
        const over = Math.max(...parts.map((part) => (next.get(part) ?? 0) / part.def.max));
        const scale = over > 1 ? 1 / over : 1;
        patch = Object.fromEntries(
          parts.map((part) => {
            const { key, min, max, step } = part.def;
            return [key, snap((next.get(part) ?? 0) * scale, min, max, step)];
          }),
        );
        knobs.set(patch, false);
      },
      () => {
        held = [];
        divider.classList.remove("dragging");
        knobs.set(patch, true);
      },
    );
  };

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
      knobs.set({ [def.key]: snap(next, def.min, def.max, def.step) }, true);
    });
    const share = h("span", { class: "mix-share" });
    const raw = h("span", { class: "mix-weight" });
    const outIcon = icon("close");
    const inIcon = icon("plus");
    const toggle = h("button", { type: "button", class: "mix-toggle" }, outIcon, inIcon);
    toggle.addEventListener("click", () => {
      if (weight(part) > 0) {
        knobs.set({ [def.key]: def.min }, true);
        return;
      }
      // Back in with an even share of the parts already in, or half when none is.
      const others = parts.filter((other) => weight(other) > 0).map(weight);
      const mean =
        others.length > 0 ? others.reduce((a, b) => a + b, 0) / others.length : def.max / 2;
      knobs.set({ [def.key]: snap(mean, def.min, def.max, def.step) }, true);
    });
    const dot = h("button", {
      type: "button",
      class: "modified",
      title: "Changed: click to reset",
      "aria-label": `Reset ${def.label}`,
    });
    dot.addEventListener("click", () => knobs.reset([def.key]));
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
      toggle,
      h("p", { class: "hint" }, def.help),
    );
    legendSyncs.push(() => {
      const value = weight(part);
      const out = value <= 0;
      item.classList.toggle("out", out);
      share.textContent = shareText(part);
      raw.textContent = String(value);
      slider.setAttribute("aria-valuenow", String(value));
      slider.setAttribute("aria-valuetext", `weight ${value}, ${shareText(part)} of the mix`);
      toggle.title = out ? `Bring ${part.part} back in` : `Leave ${part.part} out (weight zero)`;
      toggle.setAttribute("aria-label", toggle.title);
      outIcon.style.display = out ? "none" : "";
      inIcon.style.display = out ? "" : "none";
      dot.hidden = !knobs.modified([def.key]);
    });
    return item;
  });

  const keys = parts.map((part) => part.def.key);
  const built = row({
    label: name,
    help: "Relative weights, normalised together: a part's share is its weight over the sum. Drag a divider to trade share between its neighbours; in the list, arrow keys change a part's weight and the cross leaves it out.",
    icon: "fields",
    block: h("div", { class: "mix" }, bar, h("ul", { class: "mix-legend" }, ...items)),
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
      const shown = spans();
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
