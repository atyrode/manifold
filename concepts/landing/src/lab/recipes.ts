// A group's recipes (`Blurb.recipes`, see recipes-model.ts) as a strip of glyph chips at the top of
// the group: a tap sets the recipe's knobs in one change (one undo step), the recipes the setup
// already is light up, and a line under the chips names the one under the pointer or focus, else
// the lit one. The strip is one tab stop; arrow keys, Home and End move between its chips.
import type { Blurb, ParamDef } from "../params.ts";
import { h, type Built } from "./dom.ts";
import { icon, iconFromWords } from "./icons.ts";
import type { Knobs } from "./knobs.ts";
import { recipeLit, shownRecipes } from "./recipes-model.ts";

const STEPS: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/** The strip for group `info` in a scene with knobs `defs`; undefined where it shows no recipe. */
export function recipeStrip(
  knobs: Knobs,
  info: Blurb,
  defs: readonly ParamDef[],
): Built | undefined {
  const shown = shownRecipes(info.recipes ?? [], defs);
  if (shown.length === 0) return undefined;
  const name = h("span", { class: "recipe-name", "aria-hidden": "true" });
  let hovered: string | undefined;
  let litLabel: string | undefined;
  const showName = () => {
    name.textContent = hovered ?? litLabel ?? "";
    name.classList.toggle("is-lit", (hovered ?? litLabel) === litLabel && litLabel !== undefined);
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
        hovered = recipe.label;
        showName();
      });
    for (const type of ["pointerleave", "blur"] as const)
      chip.addEventListener(type, () => {
        hovered = undefined;
        showName();
      });
    return { chip, label: recipe.label, patch };
  });

  const el = h(
    "div",
    { class: "recipes", role: "toolbar", "aria-label": `${info.title} recipes` },
    ...chips.map(({ chip }) => chip),
    name,
  );
  /** Put `to` alone in the tab order. */
  const rove = (to: HTMLButtonElement | undefined) => {
    for (const { chip } of chips) chip.tabIndex = chip === to ? 0 : -1;
  };
  el.addEventListener("keydown", (event) => {
    const visible = chips
      .map(({ chip }) => chip)
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
      litLabel = undefined;
      let first: HTMLButtonElement | undefined;
      for (const { chip, label, patch } of chips) {
        const lit = recipeLit(patch, (key) => knobs.value(key));
        chip.setAttribute("aria-pressed", String(lit));
        if (lit && litLabel === undefined) {
          litLabel = label;
          first = chip;
        }
      }
      // Off the strip, the tab lands on the lit chip (else the first).
      if (!el.contains(document.activeElement)) rove(first ?? chips[0]?.chip);
      showName();
    },
  };
}
