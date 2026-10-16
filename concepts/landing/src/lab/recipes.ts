// A group's recipes (`Blurb.recipes`, see recipes-model.ts) as a strip of glyph chips at the top of
// the group: a tap sets the recipe's knobs in one change (one undo step), the recipes the setup
// already is light up, and a line under the chips names the one under the pointer or focus, else
// the lit one. The strip is one tab stop; arrow keys, Home and End move between its chips. Where the
// season sets the climate, a recipe whose rain or snow the time of year changes carries its mark
// (climate-hint-model.ts): a ring in the chip's corner, and the mark beside its name.
import type { Blurb, ParamDef } from "../params.ts";
import { recipeMark, type ClimateMark, type ClimateMarks } from "./climate-hint-model.ts";
import { h, setAttr, setText, type Built } from "./dom.ts";
import { icon, iconFromWords } from "./icons.ts";
import type { Knobs } from "./knobs.ts";
import { recipeLit, shownRecipes } from "./recipes-model.ts";

const STEPS: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/** A recipe's chip, and what the strip says of it. */
interface Entry {
  chip: HTMLButtonElement;
  label: string;
  help: string;
  /** What the time of year makes of the recipe, where the season sets the climate. */
  mark: ClimateMark | undefined;
}

/**
 * The strip for group `info` in a scene with knobs `defs`; undefined where it shows no recipe.
 * `marks`, where the season sets the climate, marks what the time of year makes of a recipe.
 */
export function recipeStrip(
  knobs: Knobs,
  info: Blurb,
  defs: readonly ParamDef[],
  marks?: ClimateMarks,
): Built | undefined {
  const shown = shownRecipes(info.recipes ?? [], defs);
  if (shown.length === 0) return undefined;
  const name = h("span", { class: "recipe-name", "aria-hidden": "true" });
  let hovered: Entry | undefined;
  let lit: Entry | undefined;
  const showName = () => {
    const named = hovered ?? lit;
    setText(name, named ? named.label + (named.mark ? ` · ${named.mark.text}` : "") : "");
    name.classList.toggle("is-lit", named !== undefined && named === lit);
  };

  const chips = shown.map(({ recipe, patch }) => {
    const chip = h(
      "button",
      {
        type: "button",
        class: "recipe",
        "aria-label": recipe.label,
        "aria-pressed": "false",
        title: `${recipe.label}: ${recipe.help}`,
        "data-search": `${recipe.label} ${recipe.help}`.toLowerCase(),
        tabIndex: -1,
      },
      icon(recipe.icon ?? iconFromWords(recipe.label) ?? "sparkle"),
    );
    const entry: Entry = { chip, label: recipe.label, help: recipe.help, mark: undefined };
    chip.addEventListener("click", () => {
      knobs.set(patch, true);
      chip.classList.remove("applied");
      // Restart the pop on a quick second tap.
      void chip.offsetWidth;
      chip.classList.add("applied");
    });
    chip.addEventListener("animationend", () => chip.classList.remove("applied"));
    for (const type of ["pointerenter", "focus"] as const)
      chip.addEventListener(type, () => {
        hovered = entry;
        showName();
      });
    for (const type of ["pointerleave", "blur"] as const)
      chip.addEventListener(type, () => {
        hovered = undefined;
        showName();
      });
    return { entry, patch };
  });

  const el = h(
    "div",
    { class: "recipes", role: "toolbar", "aria-label": `${info.title} recipes` },
    ...chips.map(({ entry }) => entry.chip),
    name,
  );
  /** Put `to` alone in the tab order. */
  const rove = (to: HTMLButtonElement | undefined) => {
    for (const { entry } of chips) setAttr(entry.chip, "tabindex", entry.chip === to ? "0" : "-1");
  };
  el.addEventListener("keydown", (event) => {
    const visible = chips
      .map(({ entry }) => entry.chip)
      .filter((chip) => !chip.classList.contains("no-match"));
    const at = visible.findIndex((chip) => chip === document.activeElement);
    const step = STEPS[event.key];
    const to =
      at < 0
        ? undefined
        : event.key === "Home"
          ? visible[0]
          : event.key === "End"
            ? visible.at(-1)
            : step === undefined
              ? undefined
              : visible[(at + step + visible.length) % visible.length];
    if (!to) return;
    event.preventDefault();
    rove(to);
    to.focus();
  });

  return {
    el,
    sync: () => {
      lit = undefined;
      const read = (key: string) => knobs.value(key);
      for (const { entry, patch } of chips) {
        const { chip } = entry;
        const pressed = recipeLit(patch, read);
        setAttr(chip, "aria-pressed", String(pressed));
        if (pressed && lit === undefined) lit = entry;
        entry.mark = marks ? recipeMark(marks, patch, read) : undefined;
        if (entry.mark) setAttr(chip, "data-mark", entry.mark.kind);
        else chip.removeAttribute("data-mark");
        setAttr(
          chip,
          "title",
          `${entry.label}: ${entry.help}${entry.mark ? ` ${entry.mark.help}` : ""}`,
        );
        setAttr(
          chip,
          "aria-label",
          entry.mark ? `${entry.label}, ${entry.mark.text}` : entry.label,
        );
      }
      // Off the strip, the tab lands on the lit chip (else the first).
      if (!el.contains(document.activeElement)) rove(lit?.chip ?? chips[0]?.entry.chip);
      showName();
    },
  };
}
