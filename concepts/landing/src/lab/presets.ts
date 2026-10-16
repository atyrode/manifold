// The lab panel's Presets view: saved setups in groups, with a rail of the groups. First this
// scene's (baseline and saved here), then the ones saved in this browser with export and import,
// then the baseline shelved by scene family. A click loads one here; its arrow opens it on the
// exact build it was tuned on. The setup on screen is saved from the bar on top.
import {
  loadLocalPresets,
  parsePresets,
  presets,
  saveLocalPresets,
  type Preset,
} from "../presets.ts";
import { sceneDefs, sceneIds, type SceneId } from "../scenes/index.ts";
import { defaults, resolveScene } from "../state.ts";
import { flash, iconButton, textButton } from "./controls.ts";
import { h, reveal, type LabContext } from "./dom.ts";
import { families, sceneFamily } from "./families.ts";
import { icon, type IconName } from "./icons.ts";
import { Rail, type RailEntry } from "./rail.ts";

export interface PresetsHost {
  /** Load a saved setup (one undo step). */
  load(query: string): void;
  /** The setup on screen as a minimal query. */
  query(): string;
  /** The commit this page was built from; empty for a working tree. */
  build: string;
}

/** A preset and where it is kept: the baseline (undefined) or its index among the local ones. */
interface Entry {
  preset: Preset;
  local: number | undefined;
  scene: string;
}

interface Group {
  entry: RailEntry;
  list: HTMLUListElement;
  count: HTMLElement;
}

/** The scene a preset opens: the one it names, or its successor where that scene was retired. */
const sceneOf = (query: string) => {
  const named = new URLSearchParams(query).get("scene") ?? defaults.scene;
  return resolveScene(named) ?? named;
};

export class PresetsView {
  readonly el: HTMLElement;
  readonly #ctx: LabContext;
  readonly #host: PresetsHost;
  readonly #rail: Rail;
  readonly #here: Group & { title: HTMLElement; empty: HTMLElement };
  readonly #saved: Group & { empty: HTMLElement; export: HTMLButtonElement };
  readonly #families: (Group & { entries: Entry[] })[];
  readonly #import: { sync: () => void };
  /** Rows by the query they load, to mark the one on screen. */
  #rows: { el: HTMLElement; query: string }[] = [];
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
        list,
        ...extra,
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
      (button) => {
        navigator.clipboard.writeText(JSON.stringify(loadLocalPresets(), null, 2)).then(
          () => flash(button, "Copied"),
          () => flash(button, "Copy failed"),
        );
      },
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
      "Setups you save stay in this browser. Export them as JSON to share one or keep it in the baseline.",
    );
    this.#saved = {
      ...group(
        "saved",
        "Saved here",
        "person",
        savedEmpty,
        h("div", { class: "lab-actions" }, exportButton, importButton),
        importReveal.el,
      ),
      empty: savedEmpty,
      export: exportButton,
    };

    // The baseline is fixed: a group per family that has presets.
    const baseline = presets.map((preset) => ({
      preset,
      local: undefined,
      scene: sceneOf(preset.query),
    }));
    this.#families = families.flatMap((family) => {
      const entries = baseline.filter((entry) => {
        const scene = sceneIds.find((id) => id === entry.scene);
        return scene !== undefined && sceneFamily[scene] === family.id;
      });
      return entries.length === 0
        ? []
        : [{ ...group(`family-${family.id}`, family.title, family.icon), entries }];
    });

    const sections = [this.#here, this.#saved, ...this.#families].map(({ entry }) => entry);
    body.append(...sections.map((entry) => entry.el));
    this.#rail.set([
      [this.#here.entry, this.#saved.entry],
      this.#families.map(({ entry }) => entry),
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
    const saved = local.map((preset, index) => ({
      preset,
      local: index,
      scene: sceneOf(preset.query),
    }));
    const baseline = this.#families.flatMap((family) => family.entries);
    const here = [...baseline, ...saved].filter((entry) => entry.scene === scene);
    const title = sceneDefs[scene].title;
    this.#here.title.textContent = `This scene · ${title}`;
    this.#here.empty.textContent = `Nothing saved for ${title} yet: name the setup above and save it.`;
    const fill = (group: Group, entries: readonly Entry[], empty?: HTMLElement) => {
      group.list.replaceChildren(...entries.map((entry) => this.#row(entry, group.entry.id)));
      group.list.hidden = entries.length === 0;
      group.count.textContent = String(entries.length);
      if (empty) empty.hidden = entries.length > 0;
    };
    fill(this.#here, here, this.#here.empty);
    fill(this.#saved, saved, this.#saved.empty);
    this.#saved.export.disabled = saved.length === 0;
    for (const family of this.#families) fill(family, family.entries);
    if (focused?.preset === undefined) return;
    const rows = [...this.el.querySelectorAll<HTMLElement>(".preset-main")];
    const again =
      rows.find(
        (row) => row.dataset.preset === focused.preset && row.dataset.group === focused.group,
      ) ?? rows.find((row) => row.dataset.preset === focused.preset);
    again?.focus({ preventScroll: true });
  }

  /** A preset's row in group `group`. */
  #row({ preset, local, scene }: Entry, group: string): HTMLElement {
    const sceneId = sceneIds.find((id) => id === scene);
    const main = h(
      "button",
      {
        type: "button",
        class: "preset-main",
        title: "Load these settings on this build",
        "data-group": group,
        "data-preset":
          local === undefined ? `baseline-${presets.indexOf(preset)}` : `local-${local}`,
      },
      h("span", { class: "preset-name" }, preset.name),
      h(
        "span",
        { class: "preset-meta" },
        h(
          "span",
          {},
          `${sceneId ? sceneDefs[sceneId].title : scene} · ${local === undefined ? "baseline" : "saved here"} · @${preset.commit}`,
        ),
      ),
    );
    if (sceneId) main.style.setProperty("--dot", sceneDefs[sceneId].accent);
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
    const remove =
      local === undefined
        ? null
        : iconButton("trash", `Delete ${preset.name}`, () => {
            saveLocalPresets(loadLocalPresets().filter((_, index) => index !== local));
            this.sync();
          });
    const el = h("li", { class: "preset" }, main, original, remove);
    this.#rows.push({ el, query: preset.query });
    return el;
  }
}
