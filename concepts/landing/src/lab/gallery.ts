// The lab panel's Scenes view (ADR 0062 D9, again): every scene as a thumbnail card, shelved by
// baseline (lab/gallery-model.ts) with a rail of the shelves: each baseline's own scene first
// ("baseline"), its variants, then the setups saved in this browser over them ("custom", loaded as
// the Presets view loads them), and the standalone scenes apart; ahead of them, the Canvas shelf of
// the engine's documents saved in this browser (lab/canvas-docs.ts), each drawn as a plan from
// above, opened in the canvas. Searchable by the scenes' titles, the custom setups' names and the
// documents', the scene on screen marked. Arrow keys move between cards (one card in the tab
// order), Enter or Space shows the scene or loads the setup. The lab syncs it while it shows, and
// as it comes on screen; a sync rebuilds the custom cards and the documents' once they change.
import type { ComposerId } from "../composer/types.ts";
import { starterDocs } from "../engine/docs.ts";
import type { EngineDoc } from "../engine/types.ts";
import { loadLocalPresets, type Preset } from "../presets.ts";
import { sceneDefs, type SceneId } from "../scenes/index.ts";
import { DOCS_KEY, readDocs, type SavedDoc } from "./canvas-docs.ts";
import { h, setAttr, setHidden, setText, svg, type LabContext } from "./dom.ts";
import { sceneFamily } from "./families.ts";
import { cardMatches, docMatches, galleryShelves, type GalleryCard } from "./gallery-model.ts";
import { icon, type IconName } from "./icons.ts";
import { Rail, type RailEntry } from "./rail.ts";
import { standIn, thumbUrl } from "./thumbs.ts";

export interface GalleryHost {
  /** Show `scene` at its defaults, picked by hand. */
  setScene(scene: SceneId): void;
  /** Load a saved setup (one undo step), as the Presets view does. */
  load(query: string): void;
  /** The setup on screen as a minimal query. */
  query(): string;
  /** Open a document saved in this browser in the canvas (one undo step). */
  openDoc(saved: SavedDoc): void;
}

/** A card on screen: what it shows, and its element. */
interface Card {
  readonly card: GalleryCard;
  readonly el: HTMLButtonElement;
}

interface Shelf {
  readonly el: HTMLElement;
  /** Its cards' row. */
  readonly row: HTMLElement;
  readonly count: HTMLElement;
  readonly scenes: readonly Card[];
  /** Its custom cards, after its scenes', rebuilt as the saved setups change. */
  custom: readonly Card[];
}

/** A baseline's shelf's icon, by its composer (the Presets view's shelves'); the standalone one's. */
const SHELF_ICONS: Readonly<Record<ComposerId, IconName>> = {
  interior: "house",
  outdoor: "mountain",
  overhead: "ripple",
};
const STANDALONE_ICON: IconName = "pattern";

/**
 * A document from above, for its card: x across, z up the card, every object a dot and the
 * camera a wedge pointing the way it looks, all fitted in.
 */
function docPlan(doc: EngineDoc): SVGSVGElement {
  const [w, hgt, pad] = [160, 100, 14];
  const points = [doc.camera.at, ...doc.objects.map((object) => object.at)];
  const xs = points.map((p) => p[0]);
  const zs = points.map((p) => p[2]);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const fit = Math.min(
    (w - 2 * pad) / Math.max(x1 - x0, 1),
    (hgt - 2 * pad) / Math.max(z1 - z0, 1),
  );
  const at = (x: number, z: number) =>
    [w / 2 + (x - (x0 + x1) / 2) * fit, hgt / 2 - (z - (z0 + z1) / 2) * fit] as const;
  const dots = doc.objects.map((object) => {
    const [cx, cy] = at(object.at[0], object.at[2]);
    return svg("circle", { cx: cx.toFixed(1), cy: cy.toFixed(1), r: 2.5, class: "plan-object" });
  });
  const [ex, ey] = at(doc.camera.at[0], doc.camera.at[2]);
  // The camera's heading on the card: +z up, a yaw turning counter-clockwise.
  const [dx, dy] = [-Math.sin(doc.camera.yaw), -Math.cos(doc.camera.yaw)];
  const wedge = [
    [ex + dx * 9, ey + dy * 9],
    [ex - dy * 4, ey + dx * 4],
    [ex + dy * 4, ey - dx * 4],
  ]
    .map(([px, py]) => `${(px ?? 0).toFixed(1)},${(py ?? 0).toFixed(1)}`)
    .join(" ");
  return svg(
    "svg",
    { viewBox: `0 0 ${w} ${hgt}`, class: "plan", "aria-hidden": "true" },
    ...dots,
    svg("polygon", { points: wedge, class: "plan-camera" }),
  );
}

export class SceneGallery {
  readonly el: HTMLElement;
  readonly #ctx: LabContext;
  readonly #host: GalleryHost;
  readonly #search: HTMLInputElement;
  readonly #body: HTMLElement;
  readonly #rail: Rail;
  /** The scenes' cards, by scene. */
  readonly #cards = new Map<SceneId, HTMLButtonElement>();
  readonly #shelves: Shelf[] = [];
  readonly #empty = h("p", { class: "lab-empty", hidden: true }, "No scene matches.");
  #shown: SceneId | undefined;
  /** The saved setups the custom cards show, as stored, to rebuild them only when they change. */
  #saved = "";
  /** The Canvas shelf: the documents saved in this browser, and their cards. */
  readonly #docShelf: {
    readonly el: HTMLElement;
    readonly row: HTMLElement;
    readonly count: HTMLElement;
  };
  #docCards: { readonly saved: SavedDoc; readonly el: HTMLButtonElement }[] = [];
  /**
   * The documents the Canvas shelf shows, as read, to rebuild its cards only when they change
   * (undefined until the first sync builds the shelf with its starters).
   */
  #docs: string | undefined;

  constructor(ctx: LabContext, host: GalleryHost) {
    this.#ctx = ctx;
    this.#host = host;
    this.#search = h("input", {
      type: "search",
      placeholder: "Find a scene or setup…",
      "aria-label": "Find a scene or a saved setup",
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

    this.#body = h("div", { class: "view-body gallery", role: "group", "aria-label": "Scenes" });
    this.#rail = new Rail(this.#body, "Scene shelves", ctx.reducedMotion);
    const baselines: RailEntry[] = [];
    const apart: RailEntry[] = [];
    for (const shelf of galleryShelves([])) {
      const title = shelf.baseline === undefined ? "Standalone" : sceneDefs[shelf.baseline].title;
      const name = shelf.composer === undefined ? STANDALONE_ICON : SHELF_ICONS[shelf.composer];
      const scenes = shelf.cards.map((card) => ({ card, el: this.#card(card) }));
      const row = h("div", { class: "cards" }, ...scenes.map(({ el }) => el));
      const count = h("span", { class: "shelf-count" });
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
          count,
        ),
        shelf.baseline === undefined &&
          h("p", { class: "shelf-note" }, "Scenes with a program of their own, in no composer."),
        row,
      );
      this.#shelves.push({ el, row, count, scenes, custom: [] });
      const entry = {
        id: shelf.baseline ?? "standalone",
        title,
        icon: name,
        el,
        focus: scenes[0]?.el,
      };
      (shelf.baseline === undefined ? apart : baselines).push(entry);
    }
    const docRow = h("div", { class: "cards" });
    const docCount = h("span", { class: "shelf-count" });
    const docShelf = h(
      "section",
      { class: "shelf", "aria-label": "Canvas documents", hidden: true },
      h("h3", { class: "shelf-title" }, icon("layers"), h("span", {}, "Canvas"), docCount),
      h(
        "p",
        { class: "shelf-note" },
        "One world with a free camera: start from a canvas, or open a document saved in this browser.",
      ),
      docRow,
    );
    this.#docShelf = { el: docShelf, row: docRow, count: docCount };
    this.#body.append(docShelf, ...this.#shelves.map(({ el }) => el), this.#empty);
    this.#body.addEventListener("keydown", (event) => this.#roam(event));
    this.#rail.set([
      [{ id: "canvas-documents", title: "Canvas", icon: "layers", el: docShelf, focus: docRow }],
      baselines,
      apart,
    ]);

    this.el = h(
      "div",
      { class: "view-scenes" },
      h(
        "div",
        { class: "view-tools" },
        h("label", { class: "panel-search" }, icon("search"), this.#search),
      ),
      h("div", { class: "view-main" }, this.#rail.el, this.#body),
    );
  }

  /** Hand the keyboard the current scene's card, in view. */
  focusCurrent(): void {
    const card = this.#cards.get(this.#ctx.current().state.scene);
    card?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: "nearest" });
  }

  /** The view came on screen: bring the current scene's card into view. */
  shown(): void {
    if (!this.el.contains(document.activeElement))
      this.#cards.get(this.#ctx.current().state.scene)?.scrollIntoView({ block: "nearest" });
    this.#rail.spy();
  }

  sync(): void {
    const local = loadLocalPresets();
    const saved = JSON.stringify(local);
    if (saved !== this.#saved) {
      this.#saved = saved;
      this.#setCustom(local);
    }
    const docs = localStorage.getItem(DOCS_KEY) ?? "";
    if (docs !== this.#docs) {
      this.#docs = docs;
      this.#setDocs(readDocs(docs));
    }
    const { scene } = this.#ctx.current().state;
    const query = this.#host.query();
    for (const { card, el } of this.#all()) {
      const current = card.kind === "scene" && card.scene === scene;
      const exact = card.kind === "custom" && card.preset.query === query;
      setAttr(el, "aria-pressed", String(current || exact));
      if (current) setAttr(el, "aria-current", "true");
      else el.removeAttribute("aria-current");
    }
    // One card in the tab order: the current scene's, unless the keyboard is already in the gallery.
    if (this.#shown !== scene) {
      this.#shown = scene;
      for (const { card, el } of this.#all())
        el.tabIndex = card.kind === "scene" && card.scene === scene ? 0 : -1;
      if (!this.el.contains(document.activeElement))
        this.#cards.get(scene)?.scrollIntoView({ block: "nearest" });
    }
  }

  /** Rebuild the custom cards from the `local` setups, each on its scene's shelf. */
  #setCustom(local: readonly Preset[]): void {
    const shelves = galleryShelves(local);
    for (const [at, shelf] of this.#shelves.entries()) {
      for (const { el } of shelf.custom) el.remove();
      shelf.custom = (shelves[at]?.cards ?? [])
        .filter((card) => card.kind === "custom")
        .map((card) => ({ card, el: this.#card(card) }));
      shelf.row.append(...shelf.custom.map(({ el }) => el));
      const scenes = `${shelf.scenes.length} scenes`;
      setText(
        shelf.count,
        shelf.custom.length ? `${scenes} · ${shelf.custom.length} custom` : scenes,
      );
    }
    this.#filter();
  }

  /** Rebuild the Canvas shelf's cards from the documents saved in this browser. */
  #setDocs(docs: readonly SavedDoc[]): void {
    const starters = Object.values(starterDocs).map((doc) => ({
      name: doc.title,
      savedAt: 0,
      doc,
    }));
    this.#docCards = [...starters, ...docs].map((saved, at) => {
      const start = at < starters.length;
      const count = saved.doc.objects.length;
      const objects = `${count} object${count === 1 ? "" : "s"}`;
      const el = h(
        "button",
        {
          type: "button",
          class: `scene-card doc${start ? " baseline" : ""}`,
          tabIndex: -1,
          "aria-label": `${saved.name}, ${start ? "a canvas to start from" : "a canvas document"}`,
          title: start
            ? `${saved.name}: ${objects}, a canvas to start from. Opens in the canvas.`
            : `${saved.name}: ${objects}, saved ${new Date(saved.savedAt).toLocaleString()}. Opens in the canvas.`,
        },
        h(
          "span",
          { class: "thumb" },
          docPlan(saved.doc),
          h("span", { class: "card-tag" }, start ? "start" : "doc"),
        ),
        h("span", { class: "card-title" }, saved.name),
      );
      el.addEventListener("click", () => this.#host.openDoc(saved));
      return { saved, el };
    });
    this.#docShelf.row.replaceChildren(...this.#docCards.map(({ el }) => el));
    setText(
      this.#docShelf.count,
      docs.length ? `${docs.length} saved` : `${starters.length} to start from`,
    );
    this.#filter();
  }

  /** A card: a scene's (tagged "baseline" for a baseline's own) or a custom setup's. */
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
    const custom = card.kind === "custom";
    const name = custom ? card.preset.name : def.title;
    const tag = custom ? "custom" : card.baseline ? "baseline" : undefined;
    const el = h(
      "button",
      {
        type: "button",
        class: tag === undefined ? "scene-card" : `scene-card ${tag}`,
        tabIndex: -1,
        "data-scene": card.scene,
        "data-preset": custom ? `local-${card.local}` : undefined,
        "aria-label": tag === undefined ? name : `${name}, ${tag}`,
        title: custom
          ? `${name}: ${def.title} as saved in this browser, @${card.preset.commit}`
          : `${def.title}: ${def.blurb}`,
      },
      h(
        "span",
        { class: "thumb" },
        image,
        tag !== undefined && h("span", { class: "card-tag" }, tag),
      ),
      h("span", { class: "card-title" }, name),
    );
    el.style.setProperty("--dot", def.accent);
    el.addEventListener("click", () =>
      card.kind === "custom" ? this.#host.load(card.preset.query) : this.#host.setScene(card.scene),
    );
    if (card.kind === "scene") this.#cards.set(card.scene, el);
    return el;
  }

  /** Every card, shelf by shelf, in the order shown. */
  #all(): Card[] {
    return this.#shelves.flatMap((shelf) => [...shelf.scenes, ...shelf.custom]);
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
    let docs = 0;
    for (const { saved, el } of this.#docCards) {
      const hit = docMatches(saved, query);
      setHidden(el, !hit);
      if (hit) docs++;
    }
    setHidden(this.#docShelf.el, docs === 0);
    let any = docs > 0;
    for (const shelf of this.#shelves) {
      let shown = 0;
      for (const { card, el } of [...shelf.scenes, ...shelf.custom]) {
        const hit = cardMatches(card, query);
        setHidden(el, !hit);
        if (hit) shown++;
      }
      setHidden(shelf.el, shown === 0);
      if (shown > 0) any = true;
    }
    setHidden(this.#empty, any);
    const visible = this.#visibleCards();
    const first = visible[0];
    if (first && !visible.some((card) => card.tabIndex === 0)) first.tabIndex = 0;
    this.#rail.spy();
  }
}
