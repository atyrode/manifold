// The Scenes view's Saved list (lab/gallery.ts switches between it and the Library): everything
// saved in this browser, the setups over the scenes and the canvas's documents, one list, the last
// saved first (lab/saved-model.ts). The bar on top saves what is on screen under a name: on the
// canvas its document (over one of that name), elsewhere the setup. A setup's row loads it, opens it
// on the build it was made on, promotes a room's (lab/preset-rows.ts); a document's row opens it in
// the canvas and downloads it as a file; either deletes it from this browser. Export downloads the
// whole list as one file, Import adds a file's (that file, a document's own, or setups as the lab
// once exported them).
import { kinds } from "../engine/kinds/index.ts";
import type { EngineDoc } from "../engine/types.ts";
import { loadLocalPresets, PRESETS_KEY, saveLocalPresets, type Preset } from "../presets.ts";
import { sceneDefs } from "../scenes/index.ts";
import {
  DOCS_KEY,
  deleteDoc,
  exportDoc,
  loadSavedDocs,
  saveDoc,
  storeSavedDocs,
  type SavedDoc,
} from "./canvas-docs.ts";
import { iconButton, textButton } from "./controls.ts";
import { docPlan } from "./doc-plan.ts";
import { h, setAttr, setHidden, setText, type LabContext } from "./dom.ts";
import { sceneFamily } from "./families.ts";
import { icon } from "./icons.ts";
import { PresetRows } from "./preset-rows.ts";
import {
  exportSaved,
  mergeSaved,
  readSaved,
  savedItems,
  savedMatches,
  type SavedItem,
} from "./saved-model.ts";
import { standIn, thumbUrl } from "./thumbs.ts";
import { presetScene } from "./tree-model.ts";

export interface SavedHost {
  /** Load a setup (one undo step). */
  load(query: string): void;
  /** Open a document in the canvas (one undo step). */
  openDoc(saved: SavedDoc): void;
  /** The setup on screen as a minimal query. */
  query(): string;
  /** The canvas's document while the canvas is on screen, else undefined. */
  doc(): EngineDoc | undefined;
  /** The commit this page was built from; empty for a working tree. */
  build: string;
  /** Something saved here changed. */
  changed(): void;
}

/** A day and an hour, short: "19 Oct, 14:02". */
function when(time: number, hour: boolean): string {
  const date = new Date(time);
  const day = date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return hour
    ? `${day}, ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    : day;
}

/** Hand `text` to the browser as a download named `name`. */
function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  h("a", { href: url, download: name }).click();
  URL.revokeObjectURL(url);
}

export class SavedView {
  readonly el: HTMLElement;
  readonly #ctx: LabContext;
  readonly #host: SavedHost;
  readonly #rows: PresetRows;
  readonly #name: HTMLInputElement;
  readonly #status = h("p", { class: "saved-status", role: "status" });
  readonly #list = h("ul", { class: "presets saved-list", "aria-label": "Saved in this browser" });
  readonly #empty = h(
    "p",
    { class: "shelf-note saved-empty" },
    "Nothing saved in this browser yet. Name what is on screen above and save it: a setup of a scene, or the canvas's document. It stays in this browser; export it as a file to keep it or move it to another.",
  );
  readonly #none = h("p", { class: "lab-empty", hidden: true }, "Nothing saved matches.");
  readonly #export: HTMLButtonElement;
  /** The entries on screen, and their rows. */
  #items: { readonly item: SavedItem; readonly el: HTMLElement }[] = [];
  /** The stores as last read, to rebuild the list only when they change. */
  #read: string | undefined;
  #query = "";

  constructor(ctx: LabContext, host: SavedHost) {
    this.#ctx = ctx;
    this.#host = host;
    this.#rows = new PresetRows((query) => host.load(query));
    this.#name = h("input", {
      type: "text",
      maxLength: 60,
      "aria-label": "Name to save under",
      spellcheck: false,
    });
    const save = h(
      "button",
      { type: "submit", class: "text-button", title: "Save what is on screen in this browser" },
      icon("plus"),
      h("span", {}, "Save"),
    );
    const form = h("form", { class: "save-row" }, this.#name, save);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.#save();
    });

    const file = h("input", { type: "file", accept: ".json,application/json", hidden: true });
    file.addEventListener("change", () => {
      const chosen = file.files?.[0];
      file.value = "";
      if (chosen) void chosen.text().then((text) => this.#import(chosen.name, text));
    });
    this.#export = textButton(
      "external",
      "Export all",
      "Download everything saved in this browser as one .json file",
      () => {
        const { name, text } = exportSaved(loadLocalPresets(), loadSavedDocs());
        download(name, text);
        setText(this.#status, `Exported ${name}.`);
      },
    );
    const importButton = textButton(
      "down",
      "Import",
      "Add what a .json file holds: an export of this list, a canvas document, or setups",
      () => file.click(),
    );

    this.el = h(
      "div",
      { class: "view-body saved" },
      form,
      this.#status,
      this.#empty,
      this.#list,
      this.#none,
      h("div", { class: "lab-actions saved-actions" }, this.#export, importButton, file),
    );
  }

  /** How many entries are saved here, as last read. */
  get count(): number {
    return this.#items.length;
  }

  /** Show only the entries answering `query`. */
  filter(query: string): void {
    this.#query = query;
    let shown = 0;
    for (const { item, el } of this.#items) {
      const hit = savedMatches(item, query);
      setHidden(el, !hit);
      if (hit) shown++;
    }
    setHidden(this.#none, this.#items.length === 0 || shown > 0);
  }

  /** Read the stores again, rebuilding the list if they changed, and mark what is on screen. */
  sync(): void {
    const read = `${localStorage.getItem(PRESETS_KEY) ?? ""}\n${localStorage.getItem(DOCS_KEY) ?? ""}`;
    if (read !== this.#read) {
      this.#read = read;
      this.#render();
    }
    const doc = this.#host.doc();
    setAttr(this.#name, "placeholder", doc ? "Name this document" : "Name this setup");
    const query = this.#host.query();
    this.#rows.mark(query);
    const open = doc && JSON.stringify(doc);
    for (const { item, el } of this.#items)
      if (item.kind === "doc")
        el.classList.toggle(
          "active",
          open !== undefined && JSON.stringify(item.saved.doc) === open,
        );
  }

  #render(): void {
    const items = savedItems(loadLocalPresets(), loadSavedDocs());
    this.#rows.clear();
    this.#items = items.map((item) => ({ item, el: this.#row(item) }));
    this.#list.replaceChildren(...this.#items.map(({ el }) => el));
    setHidden(this.#list, items.length === 0);
    setHidden(this.#empty, items.length > 0);
    this.#export.disabled = items.length === 0;
    this.filter(this.#query);
  }

  #row(item: SavedItem): HTMLElement {
    if (item.kind === "setup") {
      const { preset, index } = item;
      const scene = presetScene(preset);
      const image = h("img", { alt: "", loading: "lazy", decoding: "async", draggable: false });
      if (scene) {
        image.src = thumbUrl(scene);
        image.addEventListener(
          "error",
          () => (image.src = standIn(sceneDefs[scene].accent, sceneFamily[scene])),
          { once: true },
        );
      }
      const day = Date.parse(preset.savedAt);
      const row = this.#rows.row(preset, {
        key: `local-${index}`,
        label: preset.name,
        meta: [
          scene ? sceneDefs[scene].title : "a scene this build lacks",
          Number.isFinite(day) ? when(day, preset.savedAt.length > 10) : preset.savedAt,
          ...(preset.commit === "working-tree" ? [] : [`@${preset.commit}`]),
        ].join(" · "),
        remove: () => {
          saveLocalPresets(loadLocalPresets().filter((_, at) => at !== index));
          setText(this.#status, `Deleted “${preset.name}”.`);
          this.#changed();
        },
      });
      row.prepend(h("span", { class: "saved-picture" }, image));
      return row;
    }
    const { saved } = item;
    const count = saved.doc.objects.length;
    const main = h(
      "button",
      {
        type: "button",
        class: "preset-main",
        title: `Open “${saved.name}” in the canvas (undo brings back what is there)`,
      },
      h("span", { class: "preset-name", title: saved.name }, saved.name),
      h(
        "span",
        { class: "preset-meta" },
        h(
          "span",
          {},
          `Canvas · ${count} object${count === 1 ? "" : "s"} · ${when(saved.savedAt, true)}`,
        ),
      ),
    );
    main.addEventListener("click", () => this.#host.openDoc(saved));
    const exported = iconButton("down", `Download “${saved.name}” as a .json file`, () => {
      const { name, text } = exportDoc(saved.doc);
      download(name, text);
      setText(this.#status, `Exported ${name}.`);
    });
    const remove = iconButton("trash", `Delete “${saved.name}” from this browser`, () => {
      storeSavedDocs(deleteDoc(loadSavedDocs(), saved.name));
      setText(this.#status, `Deleted “${saved.name}”.`);
      this.#changed();
    });
    return h(
      "li",
      { class: "preset saved-doc" },
      h("span", { class: "saved-picture" }, docPlan(saved.doc)),
      main,
      exported,
      remove,
    );
  }

  /** Save what is on screen under the name typed, or its own. */
  #save(): void {
    const typed = this.#name.value.trim();
    const doc = this.#host.doc();
    if (doc) {
      const name = typed || doc.title.trim() || "Untitled";
      const docs = loadSavedDocs();
      const over = docs.some((saved) => saved.name === name);
      storeSavedDocs(saveDoc(docs, name, doc, Date.now()));
      setText(this.#status, over ? `Saved over “${name}”.` : `Saved “${name}”.`);
    } else {
      const { title } = sceneDefs[this.#ctx.current().state.scene];
      const now = new Date();
      const preset: Preset = {
        name: typed || `${title} · ${when(now.getTime(), true)}`,
        commit: this.#host.build || "working-tree",
        query: this.#host.query(),
        savedAt: now.toISOString(),
      };
      saveLocalPresets([...loadLocalPresets(), preset]);
      setText(this.#status, `Saved “${preset.name}”.`);
    }
    this.#name.value = "";
    this.#changed();
  }

  /** Add what file `name`'s `text` holds, or say why it cannot be. */
  #import(name: string, text: string): void {
    const read = readSaved(text, kinds);
    if ("why" in read) {
      setText(this.#status, `Cannot import ${name}: ${read.why}`);
      return;
    }
    const merged = mergeSaved(loadLocalPresets(), loadSavedDocs(), read, Date.now());
    saveLocalPresets(merged.setups);
    storeSavedDocs(merged.docs);
    const parts = [
      read.setups.length && `${read.setups.length} setup${read.setups.length === 1 ? "" : "s"}`,
      read.docs.length && `${read.docs.length} document${read.docs.length === 1 ? "" : "s"}`,
    ].filter(Boolean);
    setText(this.#status, `Imported ${parts.join(" and ")} from ${name}.`);
    this.#changed();
  }

  #changed(): void {
    this.sync();
    this.#host.changed();
  }
}
