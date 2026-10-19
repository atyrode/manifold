// The lab panel's Scenes view (ADR 0062 D9, again), one switch between two halves. The Library is
// what ships: every scene as a thumbnail card, shelved by baseline (lab/gallery-model.ts) with a rail
// of the shelves, each baseline's own scene first ("baseline"), its variants, the standalone scenes
// apart, and ahead of them the Canvas shelf of the engine's bare canvases, each drawn as a plan from
// above and opened in the canvas. A card counts its scene's
// committed presets; under the shelf of the scene on screen stand its presets (lab/preset-rows.ts)
// and, for a variant, its compare with its baseline in the A/B slots (compare.ts). Saved is
// everything saved in this browser, one list (lab/saved.ts), apart from what ships. One search
// serves the half on screen: the Library by the scenes' titles, their presets' names and the
// documents', Saved by the saved entries'. Arrow keys move between the Library's cards (one card in
// the tab order), Enter or Space shows the scene or opens the document. The lab syncs it while it
// shows, and as it comes on screen.
import type { ComposerId } from "../composer/types.ts";
import { canonicalSetup } from "../compare.ts";
import { canvasDocs } from "../engine/docs.ts";
import type { EngineDoc } from "../engine/types.ts";
import { sceneDefs, type SceneId } from "../scenes/index.ts";
import { textButton } from "./controls.ts";
import { docPlan } from "./doc-plan.ts";
import { h, setAttr, setHidden, setText, type LabContext } from "./dom.ts";
import { sceneFamily } from "./families.ts";
import {
  cardMatches,
  docMatches,
  galleryShelves,
  scenePresets,
  type GalleryCard,
} from "./gallery-model.ts";
import { icon, type IconName } from "./icons.ts";
import { PresetRows } from "./preset-rows.ts";
import { Rail, type RailEntry } from "./rail.ts";
import { SavedView, type SavedHost } from "./saved.ts";
import { standIn, thumbUrl } from "./thumbs.ts";
import { baselineScene, variantBaseline } from "./tree-model.ts";

export interface GalleryHost extends SavedHost {
  /** Show `scene` at its defaults, picked by hand. */
  setScene(scene: SceneId): void;
  /** Compare setup `a`, kept hidden as slot A, with setup `b`, loaded as slot B (compare.ts). */
  compare(a: string, b: string): void;
}

/** The view's two halves: what ships, and what is saved in this browser. */
export type GalleryMode = "library" | "saved";

/** A card on screen: what it shows, and its element. */
interface Card {
  readonly card: GalleryCard;
  readonly el: HTMLButtonElement;
}

interface Shelf {
  readonly el: HTMLElement;
  /** Its cards' row. */
  readonly row: HTMLElement;
  readonly cards: readonly Card[];
}

/** A baseline's shelf's icon, by its composer; the standalone one's. */
const SHELF_ICONS: Readonly<Record<ComposerId, IconName>> = {
  interior: "house",
  outdoor: "mountain",
  overhead: "ripple",
};
const STANDALONE_ICON: IconName = "pattern";

export class SceneGallery {
  readonly el: HTMLElement;
  readonly #ctx: LabContext;
  readonly #host: GalleryHost;
  readonly #search: HTMLInputElement;
  readonly #body: HTMLElement;
  readonly #rail: Rail;
  readonly #saved: SavedView;
  readonly #tabs: Record<GalleryMode, HTMLButtonElement>;
  readonly #savedCount = h("span", { class: "scenes-switch-count" });
  #mode: GalleryMode = "library";
  /** The scenes' cards, by scene. */
  readonly #cards = new Map<SceneId, HTMLButtonElement>();
  readonly #shelves: Shelf[] = [];
  readonly #docShelf: HTMLElement;
  readonly #docCards: { readonly doc: EngineDoc; readonly el: HTMLButtonElement }[];
  readonly #empty = h("p", { class: "lab-empty", hidden: true }, "No scene matches.");
  /** Under the shelf of the scene on screen: its presets, and its compare with its baseline. */
  readonly #here = h("div", { class: "scene-here" });
  readonly #presetRows: PresetRows;
  /** The scene the cards and the presets under its shelf were last set for. */
  #shown: SceneId | undefined;

  constructor(ctx: LabContext, host: GalleryHost) {
    this.#ctx = ctx;
    this.#host = host;
    this.#presetRows = new PresetRows((query) => host.load(query));
    this.#saved = new SavedView(ctx, {
      ...host,
      changed: () => {
        this.#countSaved();
        host.changed();
      },
    });
    this.#search = h("input", {
      type: "search",
      spellcheck: false,
    });
    this.#search.addEventListener("input", () => this.#filter());
    this.#search.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.#search.value = "";
        this.#filter();
      } else if (event.key === "ArrowDown" && this.#mode === "library") {
        event.preventDefault();
        this.#visibleCards()[0]?.focus();
      }
    });

    const tab = (mode: GalleryMode, label: string, title: string, ...extra: HTMLElement[]) => {
      const button = h(
        "button",
        { type: "button", role: "tab", class: "scenes-switch-tab", title },
        h("span", {}, label),
        ...extra,
      );
      button.addEventListener("click", () => this.show(mode));
      return button;
    };
    this.#tabs = {
      library: tab("library", "Library", "What ships: the canvases, the scenes and their presets"),
      saved: tab(
        "saved",
        "Saved",
        "What is saved in this browser: setups and documents",
        this.#savedCount,
      ),
    };
    const switcher = h(
      "div",
      { class: "scenes-switch", role: "tablist", "aria-label": "Library or saved" },
      this.#tabs.library,
      this.#tabs.saved,
    );

    this.#body = h("div", { class: "view-body gallery", role: "group", "aria-label": "Scenes" });
    this.#rail = new Rail(this.#body, "Scene shelves", ctx.reducedMotion);
    const baselines: RailEntry[] = [];
    const apart: RailEntry[] = [];
    for (const shelf of galleryShelves) {
      const title = shelf.baseline === undefined ? "Standalone" : sceneDefs[shelf.baseline].title;
      const name = shelf.composer === undefined ? STANDALONE_ICON : SHELF_ICONS[shelf.composer];
      const cards = shelf.cards.map((card) => ({ card, el: this.#card(card) }));
      const row = h("div", { class: "cards" }, ...cards.map(({ el }) => el));
      const el = h(
        "section",
        {
          class: "shelf",
          "aria-label": shelf.baseline === undefined ? title : `${title} baseline`,
        },
        h(
          "h3",
          { class: "shelf-title" },
          icon(name),
          h("span", {}, title),
          shelf.baseline !== undefined && h("span", { class: "shelf-chip" }, "baseline"),
          h("span", { class: "shelf-count" }, `${cards.length} scenes`),
        ),
        shelf.baseline === undefined &&
          h("p", { class: "shelf-note" }, "Scenes with a program of their own, in no composer."),
        row,
      );
      this.#shelves.push({ el, row, cards });
      const entry = {
        id: shelf.baseline ?? "standalone",
        title,
        icon: name,
        el,
        focus: cards[0]?.el,
      };
      (shelf.baseline === undefined ? apart : baselines).push(entry);
    }
    this.#docCards = canvasDocs.map((doc) => this.#docCard(doc));
    const docRow = h("div", { class: "cards" }, ...this.#docCards.map(({ el }) => el));
    this.#docShelf = h(
      "section",
      { class: "shelf", "aria-label": "Canvas" },
      h(
        "h3",
        { class: "shelf-title" },
        icon("layers"),
        h("span", {}, "Canvas"),
        h("span", { class: "shelf-count" }, `${canvasDocs.length} canvases`),
      ),
      h("p", { class: "shelf-note" }, "One world with a free camera: start from a bare canvas."),
      docRow,
    );
    this.#body.append(this.#docShelf, ...this.#shelves.map(({ el }) => el), this.#empty);
    this.#body.addEventListener("keydown", (event) => this.#roam(event));
    this.#rail.set([
      [{ id: "canvas", title: "Canvas", icon: "layers", el: this.#docShelf, focus: docRow }],
      baselines,
      apart,
    ]);

    this.el = h(
      "div",
      { class: "view-scenes" },
      h(
        "div",
        { class: "view-tools" },
        switcher,
        h("label", { class: "panel-search" }, icon("search"), this.#search),
      ),
      h("div", { class: "view-main" }, this.#rail.el, this.#body, this.#saved.el),
    );
    this.show("library");
  }

  /** The half on screen. */
  get mode(): GalleryMode {
    return this.#mode;
  }

  /** Show half `mode`. */
  show(mode: GalleryMode): void {
    this.#mode = mode;
    for (const [id, button] of Object.entries(this.#tabs)) {
      setAttr(button, "aria-selected", String(id === mode));
      button.tabIndex = id === mode ? 0 : -1;
    }
    const library = mode === "library";
    setHidden(this.#rail.el, !library);
    setHidden(this.#body, !library);
    setHidden(this.#saved.el, library);
    setAttr(this.#search, "placeholder", library ? "Find a scene…" : "Find saved…");
    setAttr(
      this.#search,
      "aria-label",
      library ? "Find a scene, a preset or a canvas" : "Find something saved in this browser",
    );
    if (!library) this.#saved.sync();
    this.#filter();
  }

  /** Hand the keyboard the current scene's card, in view (the Library, the scene picker). */
  focusCurrent(): void {
    if (this.#mode !== "library") this.show("library");
    const card = this.#cards.get(this.#ctx.current().state.scene);
    card?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: "nearest" });
  }

  /** The view came on screen: bring the current scene's card into view. */
  shown(): void {
    if (this.#mode === "library" && !this.el.contains(document.activeElement))
      this.#cards.get(this.#ctx.current().state.scene)?.scrollIntoView({ block: "nearest" });
    this.#rail.spy();
  }

  sync(): void {
    this.#countSaved();
    const { scene } = this.#ctx.current().state;
    for (const { card, el } of this.#all()) {
      const current = card.scene === scene;
      setAttr(el, "aria-pressed", String(current));
      if (current) setAttr(el, "aria-current", "true");
      else el.removeAttribute("aria-current");
    }
    // One card in the tab order: the current scene's, unless the keyboard is already in the gallery.
    if (this.#shown !== scene) {
      this.#shown = scene;
      for (const { card, el } of this.#all()) el.tabIndex = card.scene === scene ? 0 : -1;
      this.#setHere(scene);
      if (this.#mode === "library" && !this.el.contains(document.activeElement))
        this.#cards.get(scene)?.scrollIntoView({ block: "nearest" });
    }
    this.#presetRows.mark(this.#host.query());
  }

  /** The Saved tab's count: how many entries this browser holds. */
  #countSaved(): void {
    this.#saved.sync();
    const count = this.#saved.count;
    setText(this.#savedCount, count > 0 ? String(count) : "");
  }

  /**
   * Put `scene`'s presets and its compare with its baseline right after its card, a row of its own
   * (the cards after it fill the card's row first: `.cards`); nothing for a scene with neither (a
   * baseline, a standalone scene without presets, the canvas).
   */
  #setHere(scene: SceneId): void {
    const def = sceneDefs[scene];
    const committed = scenePresets(scene);
    const over = variantBaseline(scene);
    const card = this.#cards.get(scene);
    this.#presetRows.clear();
    if (!card || (committed.length === 0 && over === undefined)) {
      this.#here.remove();
      return;
    }
    const isBaseline = Object.values(baselineScene).includes(scene);
    const head = h(
      "div",
      { class: "scene-here-head" },
      h("span", { class: "scene-here-name" }, def.title),
      h(
        "span",
        { class: "scene-here-what" },
        isBaseline
          ? "a baseline"
          : over !== undefined
            ? `a variant of ${sceneDefs[over].title}`
            : "a scene of its own",
      ),
    );
    if (over !== undefined)
      head.append(
        textButton(
          "compare",
          "Compare",
          `Compare ${def.title} with its baseline in the A/B slots (A: ${sceneDefs[over].title}, B: ${def.title})`,
          () =>
            this.#host.compare(
              canonicalSetup(new URLSearchParams({ scene: over })),
              canonicalSetup(new URLSearchParams({ scene })),
            ),
        ),
      );
    const prefix = `${def.title} · `;
    const list = h(
      "ul",
      { class: "presets", "aria-label": `${def.title}'s presets` },
      ...committed.map((preset, at) => {
        const own = preset.name.startsWith(prefix) ? preset.name.slice(prefix.length) : "";
        return this.#presetRows.row(preset, {
          key: `committed-${scene}-${at}`,
          label: own ? own.charAt(0).toUpperCase() + own.slice(1) : preset.name,
          meta: `preset · ${preset.savedAt} · @${preset.commit}`,
        });
      }),
    );
    setHidden(list, committed.length === 0);
    this.#here.style.setProperty("--dot", def.accent);
    this.#here.replaceChildren(head, list);
    card.after(this.#here);
  }

  /** A bare canvas's card. */
  #docCard(doc: EngineDoc): { doc: EngineDoc; el: HTMLButtonElement } {
    const count = doc.objects.length;
    const el = h(
      "button",
      {
        type: "button",
        class: "scene-card doc baseline",
        tabIndex: -1,
        "aria-label": `${doc.title}, a bare canvas`,
        title: `${doc.title}: ${count} object${count === 1 ? "" : "s"}, a bare canvas. Opens in the canvas.`,
      },
      h("span", { class: "thumb" }, docPlan(doc), h("span", { class: "card-tag" }, "canvas")),
      h("span", { class: "card-title" }, doc.title),
    );
    el.addEventListener("click", () => this.#host.openDoc({ name: doc.title, savedAt: 0, doc }));
    return { doc, el };
  }

  /** A scene's card (tagged "baseline" for a baseline's own), counting its committed presets. */
  #card(card: GalleryCard): HTMLButtonElement {
    const def = sceneDefs[card.scene];
    const image = h("img", {
      alt: "",
      src: thumbUrl(card.scene),
      loading: "lazy",
      decoding: "async",
      draggable: false,
    });
    // A build without this scene's thumbnail shows its stand-in.
    image.addEventListener(
      "error",
      () => (image.src = standIn(def.accent, sceneFamily[card.scene])),
      { once: true },
    );
    const count = scenePresets(card.scene).length;
    const presets = count > 0 ? `, ${count} preset${count === 1 ? "" : "s"}` : "";
    const el = h(
      "button",
      {
        type: "button",
        class: card.baseline ? "scene-card baseline" : "scene-card",
        tabIndex: -1,
        "data-scene": card.scene,
        "aria-label": `${def.title}${card.baseline ? ", baseline" : ""}${presets}`,
        title: `${def.title}: ${def.blurb}`,
      },
      h(
        "span",
        { class: "thumb" },
        image,
        card.baseline && h("span", { class: "card-tag" }, "baseline"),
        count > 0 &&
          h(
            "span",
            { class: "card-count", title: `${count} preset${count === 1 ? "" : "s"}` },
            icon("bookmark"),
            String(count),
          ),
      ),
      h("span", { class: "card-title" }, def.title),
    );
    el.style.setProperty("--dot", def.accent);
    el.addEventListener("click", () => this.#host.setScene(card.scene));
    this.#cards.set(card.scene, el);
    return el;
  }

  /** Every scene's card, shelf by shelf, in the order shown. */
  #all(): Card[] {
    return this.#shelves.flatMap((shelf) => shelf.cards);
  }

  #visibleCards(): HTMLButtonElement[] {
    return [...this.#docCards, ...this.#all()].map(({ el }) => el).filter((el) => !el.hidden);
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
    const query = this.#search.value;
    if (this.#mode === "saved") {
      this.#saved.filter(query);
      return;
    }
    let docs = 0;
    for (const { doc, el } of this.#docCards) {
      const hit = docMatches({ name: doc.title, savedAt: 0, doc }, query);
      setHidden(el, !hit);
      if (hit) docs++;
    }
    setHidden(this.#docShelf, docs === 0);
    let any = docs > 0;
    for (const shelf of this.#shelves) {
      let shown = 0;
      for (const { card, el } of shelf.cards) {
        const hit = cardMatches(card, query);
        setHidden(el, !hit);
        if (hit) shown++;
      }
      setHidden(shelf.el, shown === 0);
      if (shown > 0) any = true;
    }
    // The scene on screen's presets go with its card.
    const card = this.#here.previousElementSibling;
    setHidden(this.#here, card instanceof HTMLElement && card.hidden);
    setHidden(this.#empty, any);
    const visible = this.#visibleCards();
    const first = visible[0];
    if (first && !visible.some((card) => card.tabIndex === 0)) first.tabIndex = 0;
    this.#rail.spy();
  }
}
