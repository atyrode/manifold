// The scene browser: every scene as a thumbnail card, shelved by family, searchable, the one on
// screen marked; and a second tab of saved setups (presets) to load, save, export and import.
// Arrow keys move between cards (one card in the tab order), Enter or Space shows the scene.
import { defaults } from "../state.ts";
import {
  loadLocalPresets,
  parsePresets,
  presets,
  saveLocalPresets,
  type Preset,
} from "../presets.ts";
import { sceneDefs, sceneIds, type SceneId } from "../scenes/index.ts";
import { flash, iconButton, textButton } from "./controls.ts";
import { h, reveal, type LabContext } from "./dom.ts";
import { families, sceneFamily } from "./families.ts";
import { icon } from "./icons.ts";
import { standIn, thumbUrl } from "./thumbs.ts";

export interface BrowserHost {
  setScene(scene: SceneId): void;
  /** Load a saved setup (one undo step). */
  load(query: string): void;
  /** The setup on screen as a minimal query. */
  query(): string;
  /** The commit this page was built from; empty for a working tree. */
  build: string;
}

type Tab = "scenes" | "presets";

export class SceneBrowser {
  readonly el: HTMLElement;
  readonly #ctx: LabContext;
  readonly #host: BrowserHost;
  readonly #search: HTMLInputElement;
  readonly #cards = new Map<SceneId, { card: HTMLButtonElement; image: HTMLImageElement }>();
  readonly #shelves: { el: HTMLElement; scenes: SceneId[]; title: string }[] = [];
  readonly #empty = h("p", { class: "lab-empty", hidden: true }, "No scene matches.");
  readonly #tabs: Record<Tab, { tab: HTMLButtonElement; body: HTMLElement }>;
  readonly #syncers: (() => void)[] = [];
  #tab: Tab = "scenes";
  #shown: SceneId | undefined;

  constructor(ctx: LabContext, host: BrowserHost) {
    this.#ctx = ctx;
    this.#host = host;
    this.#search = h("input", {
      type: "search",
      placeholder: "Find a scene…",
      "aria-label": "Find a scene",
      spellcheck: false,
    });
    this.#search.addEventListener("input", () => this.#filter());
    this.#search.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.#search.value = "";
        this.#filter();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        this.#visibleCards()[0]?.focus();
      }
    });

    const gallery = h("div", { class: "gallery", role: "group", "aria-label": "Scenes" });
    for (const family of families) {
      const scenes = sceneIds.filter((id) => sceneFamily[id] === family.id);
      const grid = h("div", { class: "cards" }, ...scenes.map((id) => this.#card(id)));
      const shelf = h(
        "section",
        { class: "shelf", "aria-label": family.title },
        h(
          "h3",
          { class: "shelf-title" },
          icon(family.icon),
          h("span", {}, family.title),
          h("span", { class: "shelf-count" }, String(scenes.length)),
        ),
        grid,
      );
      this.#shelves.push({ el: shelf, scenes, title: family.title });
      gallery.append(shelf);
    }
    gallery.append(this.#empty);
    gallery.addEventListener("keydown", (event) => this.#roam(event));

    const scenesBody = h(
      "div",
      { class: "browser-scenes", role: "tabpanel", id: "browser-scenes" },
      h("label", { class: "panel-search" }, icon("search"), this.#search),
      gallery,
    );
    const presetsBody = h(
      "div",
      { class: "browser-presets", role: "tabpanel", id: "browser-presets", hidden: true },
      ...this.#presets(),
    );
    const tab = (id: Tab, label: string, name: "grid" | "bookmark", body: HTMLElement) => {
      const button = h(
        "button",
        { type: "button", role: "tab", "aria-controls": body.id, class: "tab" },
        icon(name),
        h("span", {}, label),
      );
      button.addEventListener("click", () => {
        this.#tab = id;
        this.sync();
      });
      return { tab: button, body };
    };
    this.#tabs = {
      scenes: tab("scenes", "Scenes", "grid", scenesBody),
      presets: tab("presets", "Presets", "bookmark", presetsBody),
    };
    const tablist = h(
      "div",
      { class: "tabs", role: "tablist", "aria-label": "Browse" },
      this.#tabs.scenes.tab,
      this.#tabs.presets.tab,
    );
    tablist.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      this.#tab = this.#tab === "scenes" ? "presets" : "scenes";
      this.sync();
      this.#tabs[this.#tab].tab.focus();
    });
    this.el = h("div", { class: "browser" }, tablist, scenesBody, presetsBody);
  }

  focusSearch(): void {
    this.#tab = "scenes";
    this.sync();
    this.#search.focus();
  }

  sync(): void {
    const { scene } = this.#ctx.current().state;
    for (const [id, { card }] of this.#cards) {
      const current = id === scene;
      card.setAttribute("aria-pressed", String(current));
      if (current) card.setAttribute("aria-current", "true");
      else card.removeAttribute("aria-current");
    }
    // One card in the tab order: the current scene's, unless the keyboard is already in the gallery.
    if (this.#shown !== scene) {
      this.#shown = scene;
      for (const [id, { card }] of this.#cards) card.tabIndex = id === scene ? 0 : -1;
      if (this.#tab === "scenes" && !this.el.contains(document.activeElement))
        this.#cards.get(scene)?.card.scrollIntoView({ block: "nearest" });
    }
    for (const [id, { tab, body }] of Object.entries(this.#tabs)) {
      const selected = id === this.#tab;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      body.hidden = !selected;
    }
    for (const sync of this.#syncers) sync();
  }

  #card(id: SceneId): HTMLButtonElement {
    const scene = sceneDefs[id];
    const image = h("img", {
      alt: "",
      src: thumbUrl(id),
      loading: "lazy",
      decoding: "async",
      draggable: false,
    });
    // A build without this scene's thumbnail shows its stand-in.
    image.addEventListener("error", () => (image.src = standIn(scene.accent, sceneFamily[id])), {
      once: true,
    });
    const card = h(
      "button",
      {
        type: "button",
        class: "scene-card",
        "data-scene": id,
        "aria-label": scene.title,
        title: `${scene.title}: ${scene.blurb}`,
      },
      h("span", { class: "thumb" }, image),
      h("span", { class: "card-title" }, scene.title),
    );
    card.style.setProperty("--dot", scene.accent);
    card.addEventListener("click", () => this.#host.setScene(id));
    this.#cards.set(id, { card, image });
    return card;
  }

  #visibleCards(): HTMLButtonElement[] {
    return [...this.#cards.values()].map(({ card }) => card).filter((card) => !card.hidden);
  }

  /** Arrow keys between cards: across a row, and up or down to the card nearest in the next row. */
  #roam(event: KeyboardEvent): void {
    const cards = this.#visibleCards();
    const at = cards.findIndex((card) => card === document.activeElement);
    if (at < 0) return;
    let next: HTMLButtonElement | undefined;
    const here = cards[at]?.getBoundingClientRect();
    if (event.key === "ArrowRight") next = cards[at + 1];
    else if (event.key === "ArrowLeft") next = cards[at - 1];
    else if (event.key === "Home") next = cards[0];
    else if (event.key === "End") next = cards[cards.length - 1];
    else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && here) {
      const down = event.key === "ArrowDown";
      const rows = cards.filter((card) => {
        const top = card.getBoundingClientRect().top;
        return down ? top > here.top + 4 : top < here.top - 4;
      });
      const rowTop = rows.reduce(
        (best, card) => {
          const top = card.getBoundingClientRect().top;
          return down ? Math.min(best, top) : Math.max(best, top);
        },
        down ? Infinity : -Infinity,
      );
      next = rows
        .filter((card) => Math.abs(card.getBoundingClientRect().top - rowTop) < 4)
        .sort(
          (a, b) =>
            Math.abs(a.getBoundingClientRect().left - here.left) -
            Math.abs(b.getBoundingClientRect().left - here.left),
        )[0];
      if (!next && !down) {
        this.#search.focus();
        event.preventDefault();
        return;
      }
    } else return;
    event.preventDefault();
    if (!next) return;
    for (const card of cards) card.tabIndex = card === next ? 0 : -1;
    next.focus();
    next.scrollIntoView({ block: "nearest" });
  }

  #filter(): void {
    const text = this.#search.value.trim().toLowerCase();
    let any = false;
    for (const shelf of this.#shelves) {
      let shown = 0;
      for (const id of shelf.scenes) {
        const scene = sceneDefs[id];
        const words = `${id} ${scene.title} ${scene.blurb} ${shelf.title}`.toLowerCase();
        const hit = text === "" || words.includes(text);
        const entry = this.#cards.get(id);
        if (entry) entry.card.hidden = !hit;
        if (hit) shown++;
      }
      shelf.el.hidden = shown === 0;
      if (shown > 0) any = true;
    }
    this.#empty.hidden = any;
    const first = this.#visibleCards()[0];
    if (first && !this.#visibleCards().some((card) => card.tabIndex === 0)) first.tabIndex = 0;
  }

  // ---- presets --------------------------------------------------------------------------------

  #presets(): HTMLElement[] {
    const list = h("ul", { class: "presets" });
    const name = h("input", {
      type: "text",
      placeholder: "Name this setup",
      maxLength: 60,
      "aria-label": "Preset name",
    });
    const save = h(
      "button",
      { type: "submit", class: "text-button" },
      icon("plus"),
      h("span", {}, "Save"),
    );
    const form = h("form", { class: "save-row" }, name, save);
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
    const exportButton = textButton(
      "external",
      "Export",
      "Copy this browser's saved setups as JSON, with the commit each was made on",
      (button) => {
        const text = JSON.stringify(loadLocalPresets(), null, 2);
        navigator.clipboard.writeText(text).then(
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

    let rendered = "";
    this.#syncers.push(importReveal.sync, () => {
      const current = this.#host.query();
      const entries: { preset: Preset; local: number | undefined }[] = [
        ...presets.map((preset) => ({ preset, local: undefined })),
        ...loadLocalPresets().map((preset, index) => ({ preset, local: index })),
      ];
      const signature = JSON.stringify([current, entries]);
      if (signature === rendered) return;
      rendered = signature;
      list.replaceChildren(
        ...entries.map(({ preset, local }) => {
          const scene = new URLSearchParams(preset.query).get("scene") ?? defaults.scene;
          const sceneId = sceneIds.find((id) => id === scene);
          const main = h(
            "button",
            { type: "button", class: "preset-main", title: "Load these settings on this build" },
            h("span", { class: "preset-name" }, preset.name),
            h(
              "span",
              { class: "preset-meta" },
              `${sceneId ? sceneDefs[sceneId].title : scene} · ${local === undefined ? "baseline" : "saved here"} · @${preset.commit}`,
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
          return h(
            "li",
            { class: `preset${preset.query === current ? " active" : ""}` },
            main,
            original,
            remove,
          );
        }),
      );
    });
    return [
      h(
        "p",
        { class: "browser-note" },
        "Saved setups. Click one to load it here; the arrow opens it on the exact build it was tuned on.",
      ),
      list,
      form,
      h("div", { class: "lab-actions" }, exportButton, importButton),
      importReveal.el,
    ];
  }
}
