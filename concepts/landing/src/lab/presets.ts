// The lab panel's Presets view: saved setups in groups, with a rail of the groups. First this
// scene's (committed and saved here), then the ones saved in this browser with export and import,
// then the tree (ADR 0062 D9 as amended, lab/tree-model.ts): a shelf per composer, its baseline and
// its curated variants, each with its committed and saved presets indented under it, and the
// standalone scenes on a shelf apart. A click loads a preset or a variant here; a preset's arrow
// opens it on the exact build it was tuned on; a variant compares with its baseline in the A/B
// slots (compare.ts). A room's preset that loads as itself promotes to a curated variant of its own
// (D15, lab/promote-model.ts): the lab shows and copies its entry and the command that writes it.
// The setup on screen is saved from the bar on top.
import { canonicalSetup } from "../compare.ts";
import { promotedVariants } from "../composer/interior-variants.ts";
import type { ComposerId } from "../composer/types.ts";
import {
  loadLocalPresets,
  parsePresets,
  presets,
  saveLocalPresets,
  type Preset,
} from "../presets.ts";
import { sceneDefs, type SceneId } from "../scenes/index.ts";
import { flash, iconButton, textButton } from "./controls.ts";
import { h, reveal, type LabContext } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import {
  promote,
  promotedFrom,
  promotionBlocked,
  suggestNames,
  type PromotedNames,
} from "./promote-model.ts";
import { Rail, type RailEntry } from "./rail.ts";
import {
  baselineScene,
  presetScene,
  presetTree,
  variantBaseline,
  type TreePreset,
  type TreeScene,
} from "./tree-model.ts";

export interface PresetsHost {
  /** Load a saved setup (one undo step). */
  load(query: string): void;
  /** Compare setup `a`, kept hidden as slot A, with setup `b`, loaded as slot B (compare.ts). */
  compare(a: string, b: string): void;
  /** The setup on screen as a minimal query. */
  query(): string;
  /** The commit this page was built from; empty for a working tree. */
  build: string;
}

interface Group {
  entry: RailEntry;
  list: HTMLUListElement;
  count: HTMLElement;
}

/** A composer's shelf: its heading. */
const SHELVES: Readonly<Record<ComposerId, { title: string; icon: IconName }>> = {
  interior: { title: "Interior", icon: "house" },
  outdoor: { title: "Outdoor", icon: "mountain" },
  overhead: { title: "Overhead", icon: "ripple" },
};

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
function copy(button: HTMLButtonElement, text: string): void {
  navigator.clipboard.writeText(text).then(
    () => flash(button, "Copied"),
    () => flash(button, "Copy failed"),
  );
}

export class PresetsView {
  readonly el: HTMLElement;
  readonly #ctx: LabContext;
  readonly #host: PresetsHost;
  readonly #rail: Rail;
  readonly #here: Group & { title: HTMLElement; empty: HTMLElement };
  readonly #saved: Group & { empty: HTMLElement; export: HTMLButtonElement };
  readonly #shelves: (Group & { composer: ComposerId | undefined })[];
  readonly #import: { sync: () => void };
  /** Rows by the query they load, to mark the one on screen. */
  #rows: { el: HTMLElement; query: string }[] = [];
  /** The variants opened or closed by hand; the others are open while their scene is on screen. */
  readonly #opened = new Map<SceneId, boolean>();
  /** The row whose promotion is open (`data-preset` and group), if any. */
  #promoting: string | undefined;
  #rendered = "";

  constructor(ctx: LabContext, host: PresetsHost) {
    this.#ctx = ctx;
    this.#host = host;
    const body = h("div", { class: "view-body preset-groups" });
    this.#rail = new Rail(body, "Preset groups", ctx.reducedMotion);

    const group = (id: string, title: string, name: IconName, ...extra: HTMLElement[]) => {
      const list = h("ul", { class: "presets" });
      const count = h("span", { class: "shelf-count" });
      const heading = h("span", {}, title);
      const el = h(
        "section",
        { class: "shelf", "aria-label": title },
        h("h3", { class: "shelf-title" }, icon(name), heading, count),
        ...extra,
        list,
      );
      return { entry: { id, title, icon: name, el }, list, count, title: heading };
    };

    const hereEmpty = h("p", { class: "shelf-note" });
    this.#here = { ...group("here", "This scene", "image", hereEmpty), empty: hereEmpty };

    let importing = false;
    const importBox = h("textarea", {
      rows: 4,
      placeholder: "Paste exported JSON here",
      "aria-label": "Presets to import",
    });
    const importAdd = textButton("plus", "Add to this browser", "Add the pasted setups", () => {
      try {
        saveLocalPresets([...loadLocalPresets(), ...parsePresets(importBox.value)]);
        importBox.value = "";
        importing = false;
        this.sync();
      } catch (error: unknown) {
        flash(importAdd, error instanceof Error ? error.message : "could not read that");
      }
    });
    const importReveal = reveal(
      h("div", { class: "import" }, importBox, importAdd),
      () => importing,
    );
    this.#import = importReveal;
    const exportButton = textButton(
      "external",
      "Export",
      "Copy this browser's saved setups as JSON, with the commit each was made on",
      (button) => copy(button, JSON.stringify(loadLocalPresets(), null, 2)),
    );
    const importButton = textButton(
      "redo",
      "Import",
      "Add setups exported from another browser",
      () => {
        importing = !importing;
        importReveal.sync();
      },
    );
    const savedEmpty = h(
      "p",
      { class: "shelf-note" },
      "Setups you save stay in this browser. Export them as JSON to share one or commit it.",
    );
    const saved = group("saved", "Saved here", "person", savedEmpty);
    saved.entry.el.append(
      h("div", { class: "lab-actions" }, exportButton, importButton),
      importReveal.el,
    );
    this.#saved = { ...saved, empty: savedEmpty, export: exportButton };

    // The tree: a shelf per composer, then the standalone scenes.
    this.#shelves = [
      ...(Object.keys(SHELVES) as ComposerId[]).map((composer) => {
        const { title, icon: name } = SHELVES[composer];
        const shelf = group(`composer-${composer}`, title, name);
        shelf.list.className = "tree";
        return { ...shelf, composer };
      }),
      (() => {
        const shelf = group(
          "standalone",
          "Standalone",
          "pattern",
          h("p", { class: "shelf-note" }, "Scenes with a program of their own, in no composer."),
        );
        shelf.list.className = "tree";
        return { ...shelf, composer: undefined };
      })(),
    ];

    const sections = [this.#here, this.#saved, ...this.#shelves].map(({ entry }) => entry);
    body.append(...sections.map((entry) => entry.el));
    this.#rail.set([
      [this.#here.entry, this.#saved.entry],
      this.#shelves.map(({ entry }) => entry),
    ]);

    const name = h("input", {
      type: "text",
      placeholder: "Name this setup",
      maxLength: 60,
      "aria-label": "Preset name",
    });
    const save = h(
      "button",
      { type: "submit", class: "text-button", title: "Save the setup on screen in this browser" },
      icon("plus"),
      h("span", {}, "Save"),
    );
    const form = h("form", { class: "view-tools save-row" }, name, save);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const { state } = this.#ctx.current();
      const preset: Preset = {
        name:
          name.value.trim() || `${sceneDefs[state.scene].title} · ${new Date().toLocaleString()}`,
        commit: this.#host.build || "working-tree",
        query: this.#host.query(),
        savedAt: new Date().toISOString().slice(0, 10),
      };
      saveLocalPresets([...loadLocalPresets(), preset]);
      name.value = "";
      this.sync();
    });

    this.el = h(
      "div",
      { class: "view-presets" },
      form,
      h("div", { class: "view-main" }, this.#rail.el, body),
    );
  }

  /** The view came on screen. */
  shown(): void {
    this.#rail.spy();
  }

  sync(): void {
    const { scene } = this.#ctx.current().state;
    const local = loadLocalPresets();
    const signature = JSON.stringify([scene, local]);
    if (signature !== this.#rendered) {
      this.#rendered = signature;
      this.#render(scene, local);
    }
    const current = this.#host.query();
    for (const row of this.#rows) row.el.classList.toggle("active", row.query === current);
    this.#import.sync();
    this.#rail.spy();
  }

  #render(scene: SceneId, local: readonly Preset[]): void {
    // The keyboard stays on the preset it was on (in its group, or else wherever it still is).
    const active = document.activeElement;
    const focused =
      active instanceof HTMLElement && this.el.contains(active) ? active.dataset : undefined;
    this.#rows = [];
    const tree = presetTree(presets, local);
    const entries: TreePreset[] = [
      ...presets.map((preset) => ({ preset, local: undefined })),
      ...local.map((preset, index) => ({ preset, local: index })),
    ];
    const here = entries.filter((entry) => presetScene(entry.preset) === scene);
    const saved = entries.filter((entry) => entry.local !== undefined);
    const title = sceneDefs[scene].title;
    this.#here.title.textContent = `This scene · ${title}`;
    this.#here.empty.textContent = `Nothing saved for ${title} yet: name the setup above and save it.`;
    const fill = (group: Group, rows: readonly TreePreset[], empty?: HTMLElement) => {
      group.list.replaceChildren(...rows.map((entry) => this.#row(entry, group.entry.id, false)));
      group.list.hidden = rows.length === 0;
      group.count.textContent = String(rows.length);
      if (empty) empty.hidden = rows.length > 0;
    };
    fill(this.#here, here, this.#here.empty);
    fill(this.#saved, saved, this.#saved.empty);
    this.#saved.export.disabled = saved.length === 0;
    for (const shelf of this.#shelves) {
      const branch = tree.composers.find((composer) => composer.composer === shelf.composer);
      const nodes = branch ? [branch.baseline, ...branch.variants] : tree.standalone;
      shelf.list.replaceChildren(...nodes.map((node) => this.#node(node, shelf.entry.id, scene)));
      shelf.count.textContent = String(nodes.reduce((sum, node) => sum + node.presets.length, 0));
      shelf.count.title = `${nodes.length} scenes, ${shelf.count.textContent} presets`;
    }
    if (focused?.preset === undefined && focused?.scene === undefined) return;
    const rows = [...this.el.querySelectorAll<HTMLElement>(".preset-main, .tree-main")];
    const again =
      rows.find(
        (row) =>
          row.dataset.preset === focused.preset &&
          row.dataset.scene === focused.scene &&
          row.dataset.group === focused.group,
      ) ??
      rows.find(
        (row) => row.dataset.preset === focused.preset && row.dataset.scene === focused.scene,
      );
    again?.focus({ preventScroll: true });
  }

  /** A scene's node in shelf `group`: its row, and its presets under it while it is open. */
  #node({ scene, presets: rows }: TreeScene, group: string, current: SceneId): HTMLElement {
    const def = sceneDefs[scene];
    const isBaseline = Object.values(baselineScene).includes(scene);
    const over = variantBaseline(scene);
    const promoted = promotedVariants.some((entry) => entry.id === scene);
    const tag = isBaseline
      ? "baseline"
      : promoted
        ? "promoted"
        : over !== undefined
          ? "variant"
          : undefined;
    const query = canonicalSetup(new URLSearchParams({ scene }));
    const list = h(
      "ul",
      { class: "presets tree-presets", id: `tree-${group}-${scene}` },
      ...rows.map((entry) => this.#row(entry, group, true)),
    );
    const toggle = h(
      "button",
      {
        type: "button",
        class: "tree-toggle",
        title: rows.length === 0 ? "No presets yet" : `Show or hide ${def.title}'s presets`,
        "aria-label": `${def.title}'s presets`,
        "aria-controls": list.id,
      },
      icon("chevron"),
    );
    toggle.disabled = rows.length === 0;
    const main = h(
      "button",
      {
        type: "button",
        class: "tree-main",
        title: `Load ${def.title} at its defaults`,
        "data-group": group,
        "data-scene": scene,
      },
      h("span", { class: "tree-name" }, def.title),
      tag ? h("span", { class: "tree-tag" }, tag) : null,
    );
    main.style.setProperty("--dot", def.accent);
    main.addEventListener("click", () => this.#host.load(query));
    const compare =
      over !== undefined
        ? iconButton(
            "compare",
            `Compare ${def.title} with the baseline (A: ${over}, B: ${def.title})`,
            () => this.#host.compare(canonicalSetup(new URLSearchParams({ scene: over })), query),
          )
        : h("span", { class: "tree-spacer" });
    const row = h(
      "div",
      { class: "tree-row" },
      toggle,
      main,
      h(
        "span",
        { class: "tree-count", title: `${rows.length} presets` },
        rows.length ? String(rows.length) : "",
      ),
      compare,
    );
    const el = h(
      "li",
      { class: `tree-node${isBaseline ? " baseline" : ""}`, "data-scene": scene },
      row,
      list,
    );
    const show = (open: boolean) => {
      el.classList.toggle("open", open && rows.length > 0);
      toggle.setAttribute("aria-expanded", String(open && rows.length > 0));
    };
    show(this.#opened.get(scene) ?? scene === current);
    toggle.addEventListener("click", () => {
      const open = !el.classList.contains("open");
      this.#opened.set(scene, open);
      show(open);
      this.#rail.spy();
    });
    this.#rows.push({ el: row, query });
    return el;
  }

  /**
   * A preset's row in group `group`; in the tree (`nested`), under its scene, its name without the
   * scene's title ("Sill · quiet shelter" as "Quiet shelter") and its meta without it.
   */
  #row({ preset, local }: TreePreset, group: string, nested: boolean): HTMLElement {
    const scene = presetScene(preset);
    const key = local === undefined ? `committed-${presets.indexOf(preset)}` : `local-${local}`;
    const prefix = scene ? `${sceneDefs[scene].title} · ` : undefined;
    const own =
      nested && prefix && preset.name.startsWith(prefix) ? preset.name.slice(prefix.length) : "";
    const label = own ? own.charAt(0).toUpperCase() + own.slice(1) : preset.name;
    const main = h(
      "button",
      {
        type: "button",
        class: "preset-main",
        title: "Load these settings on this build",
        "data-group": group,
        "data-preset": key,
      },
      h("span", { class: "preset-name", title: preset.name }, label),
      h(
        "span",
        { class: "preset-meta" },
        h(
          "span",
          {},
          [
            ...(nested ? [] : [scene ? sceneDefs[scene].title : "unknown scene"]),
            local === undefined ? "committed" : "saved here",
            `@${preset.commit}`,
          ].join(" · "),
        ),
      ),
    );
    if (scene) main.style.setProperty("--dot", sceneDefs[scene].accent);
    main.addEventListener("click", () => this.#host.load(preset.query));
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
    const panel = `${group}/${key}`;
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
              this.#promoting = this.#promoting === panel ? undefined : panel;
              this.#showPromotion(el, preset, panel, true);
            },
          );
    if (promoteButton) {
      promoteButton.disabled = blocked !== undefined;
      promoteButton.classList.add("promote-button");
    }
    const remove =
      local === undefined
        ? null
        : iconButton("trash", `Delete ${preset.name}`, () => {
            saveLocalPresets(loadLocalPresets().filter((_, index) => index !== local));
            this.sync();
          });
    const el = h("li", { class: "preset" }, main, promoteButton, original, remove);
    if (this.#promoting === panel)
      queueMicrotask(() => this.#showPromotion(el, preset, panel, false));
    this.#rows.push({ el, query: preset.query });
    return el;
  }

  /**
   * Open or close preset `preset`'s promotion under its row `row`: its names, the entry they make
   * (copied as it opens by hand, `copyNow`), and the command that writes it into the repository.
   */
  #showPromotion(row: HTMLElement, preset: Preset, panel: string, copyNow: boolean): void {
    const next = row.nextElementSibling;
    if (next instanceof HTMLElement && next.classList.contains("promote")) next.remove();
    row
      .querySelector(".promote-button")
      ?.setAttribute("aria-expanded", String(this.#promoting === panel));
    if (this.#promoting !== panel) return;
    let names = suggestNames(preset);
    const field = (label: string, key: keyof PromotedNames, hint: string) => {
      const input = h("input", {
        type: "text",
        value: names[key],
        "aria-label": label,
        title: hint,
      });
      input.addEventListener("input", () => {
        names = { ...names, [key]: input.value };
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
        committed ? "." : ", and delete this saved preset here.",
      );
    };
    const close = iconButton("close", "Close the promotion", () => {
      this.#promoting = undefined;
      this.#showPromotion(row, preset, panel, false);
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
