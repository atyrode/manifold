// A setup's row, as the Scenes view lists them (lab/gallery.ts): the scene on screen's committed
// presets in the Library, and the setups saved in this browser in Saved (lab/saved.ts). A click loads
// it; its arrow opens it exactly as it was, on the build it was made on; a room's preset that loads
// as itself promotes to a curated variant of its own (ADR 0062 D15, lab/promote-model.ts): the row
// opens its names, the entry they make and the command that writes it into the repository (the
// lab cannot write files). The rows' owner keeps which one's promotion is open across rebuilds.
import { presets, type Preset } from "../presets.ts";
import { sceneDefs } from "../scenes/index.ts";
import { flash, iconButton, textButton } from "./controls.ts";
import { h } from "./dom.ts";
import { icon } from "./icons.ts";
import {
  promote,
  promotedFrom,
  promotionBlocked,
  suggestNames,
  type PromotedNames,
} from "./promote-model.ts";
import { presetScene } from "./tree-model.ts";

/** The command that writes a promotion into the repository, run from its root. */
function promoteCommand(preset: Preset, names: PromotedNames): string {
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  return [
    "bun concepts/landing/scripts/promote.ts",
    `--id ${names.id}`,
    `--title ${quote(names.title)}`,
    `--blurb ${quote(names.blurb)}`,
    `--commit ${preset.commit}`,
    quote(preset.query),
  ].join(" ");
}

/** Copy `text`, saying so on `button`. */
export function copy(button: HTMLButtonElement, text: string): void {
  navigator.clipboard.writeText(text).then(
    () => flash(button, "Copied"),
    () => flash(button, "Copy failed"),
  );
}

export interface PresetRow {
  /** Where it is kept, unique among the rows: its promotion stays open under this key. */
  readonly key: string;
  /** Its name as shown (the preset's own name in its title). */
  readonly label: string;
  /** The line under its name. */
  readonly meta: string;
  /** Delete it from this browser; none for a committed preset. */
  readonly remove?: () => void;
}

export class PresetRows {
  readonly #load: (query: string) => void;
  /** The rows built since the last `clear`, by the setup they load, to mark the one on screen. */
  #rows: { readonly el: HTMLElement; readonly query: string }[] = [];
  /** The row whose promotion is open, if any. */
  #promoting: string | undefined;

  constructor(load: (query: string) => void) {
    this.#load = load;
  }

  /** Forget the rows built so far (their owner is rebuilding them). */
  clear(): void {
    this.#rows = [];
  }

  /** Mark the rows that load `query`, the setup on screen. */
  mark(query: string): void {
    for (const row of this.#rows) row.el.classList.toggle("active", row.query === query);
  }

  /** Preset `preset`'s row. */
  row(preset: Preset, { key, label, meta, remove }: PresetRow): HTMLElement {
    const scene = presetScene(preset);
    const main = h(
      "button",
      {
        type: "button",
        class: "preset-main",
        title: "Load these settings on this build",
        "data-preset": key,
      },
      h("span", { class: "preset-name", title: preset.name }, label),
      h("span", { class: "preset-meta" }, h("span", {}, meta)),
    );
    if (scene) main.style.setProperty("--dot", sceneDefs[scene].accent);
    main.addEventListener("click", () => this.#load(preset.query));
    const original = h(
      "a",
      {
        class: "icon-button",
        href: `${location.origin}/@${preset.commit}/${preset.query ? `?${preset.query}` : ""}`,
        title: "Open exactly as it was, on the build it was made with",
        "aria-label": `Open ${preset.name} on the build it was made with`,
      },
      icon("external"),
    );
    const blocked = promotionBlocked(preset);
    const promoteButton =
      promotedFrom(preset.query) === undefined
        ? null
        : iconButton(
            "up",
            blocked === undefined
              ? `Promote ${preset.name} to a variant of its own`
              : `Cannot promote: ${blocked}`,
            () => {
              this.#promoting = this.#promoting === key ? undefined : key;
              this.#showPromotion(el, preset, key, true);
            },
          );
    if (promoteButton) {
      promoteButton.disabled = blocked !== undefined;
      promoteButton.classList.add("promote-button");
    }
    const removeButton = remove ? iconButton("trash", `Delete ${preset.name}`, remove) : null;
    const el = h("li", { class: "preset" }, main, promoteButton, original, removeButton);
    if (this.#promoting === key) queueMicrotask(() => this.#showPromotion(el, preset, key, false));
    this.#rows.push({ el, query: preset.query });
    return el;
  }

  /**
   * Open or close preset `preset`'s promotion under its row `row`: its names, the entry they make
   * (copied as it opens by hand, `copyNow`), and the command that writes it into the repository.
   */
  #showPromotion(row: HTMLElement, preset: Preset, key: string, copyNow: boolean): void {
    const next = row.nextElementSibling;
    if (next instanceof HTMLElement && next.classList.contains("promote")) next.remove();
    row
      .querySelector(".promote-button")
      ?.setAttribute("aria-expanded", String(this.#promoting === key));
    if (this.#promoting !== key) return;
    let names = suggestNames(preset);
    const field = (label: string, name: keyof PromotedNames, hint: string) => {
      const input = h("input", {
        type: "text",
        value: names[name],
        "aria-label": label,
        title: hint,
      });
      input.addEventListener("input", () => {
        names = { ...names, [name]: input.value };
        update();
      });
      return [h("span", {}, label), input];
    };
    const status = h("p", { class: "promote-status" });
    const code = h("code", {});
    const entryButton = textButton("pin", "Copy entry", "Copy the variant's entry", (button) =>
      copy(button, code.textContent ?? ""),
    );
    const commandButton = textButton(
      "keyboard",
      "Copy command",
      "Copy the command that writes the entry into the repository",
      (button) => copy(button, promoteCommand(preset, names)),
    );
    const steps = h("p", { class: "shelf-note promote-steps" });
    const committed = presets.includes(preset);
    const update = () => {
      const result = promote(preset, names);
      status.classList.toggle("refused", !result.ok);
      entryButton.disabled = commandButton.disabled = !result.ok;
      steps.hidden = !result.ok;
      if (!result.ok) {
        status.textContent = `Cannot promote: ${result.reason}.`;
        code.textContent = "";
        return;
      }
      const folded = [...new URLSearchParams(preset.query).keys()].filter((key) => key !== "scene");
      status.textContent = `Folds ${folded.join(", ")} into ${sceneDefs[presetScene(preset) ?? "room"].title}'s differences from the baseline; checked to draw as this preset does.`;
      code.textContent = `${result.entry}\n`;
      steps.replaceChildren(
        "The lab cannot write files. Run the command from the repository's root: it writes this entry into ",
        h("code", {}, "src/composer/interior-variants.ts"),
        committed ? ", removes this preset from " : "",
        committed ? h("code", {}, "src/presets.ts") : "",
        " and regenerates the scene docs. Then render its thumbnail: ",
        h("code", {}, `bun concepts/landing/scripts/thumbs.ts ${names.id}`),
        committed ? "." : ", and delete this saved setup here.",
      );
    };
    const close = iconButton("close", "Close the promotion", () => {
      this.#promoting = undefined;
      this.#showPromotion(row, preset, key, false);
    });
    const el = h(
      "li",
      { class: "promote", "aria-label": `Promote ${preset.name}` },
      h("div", { class: "promote-head" }, icon("up"), h("span", {}, "Promote to a variant"), close),
      h(
        "div",
        { class: "promote-fields" },
        ...field("Id", "id", "The new scene's id: lowercase letters, never reused"),
        ...field("Title", "title", "Its card's title"),
        ...field("Blurb", "blurb", "Its card's line"),
      ),
      status,
      h("pre", { class: "promote-entry" }, code),
      h("div", { class: "lab-actions" }, entryButton, commandButton),
      steps,
    );
    update();
    row.after(el);
    if (copyNow && !entryButton.disabled) copy(entryButton, code.textContent ?? "");
  }
}
