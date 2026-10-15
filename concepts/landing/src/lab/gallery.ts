// The lab panel's Scenes view: every scene as a thumbnail card, shelved by family with a rail of the
// families, searchable, the one on screen marked. Arrow keys move between cards (one card in the tab
// order), Enter or Space shows the scene.
import { sceneDefs, sceneIds, type SceneId } from "../scenes/index.ts";
import { h, type LabContext } from "./dom.ts";
import { families, sceneFamily } from "./families.ts";
import { icon } from "./icons.ts";
import { Rail } from "./rail.ts";
import { standIn, thumbUrl } from "./thumbs.ts";

export class SceneGallery {
  readonly el: HTMLElement;
  readonly #ctx: LabContext;
  readonly #search: HTMLInputElement;
  readonly #body: HTMLElement;
  readonly #rail: Rail;
  readonly #cards = new Map<SceneId, HTMLButtonElement>();
  readonly #shelves: { el: HTMLElement; scenes: SceneId[]; title: string }[] = [];
  readonly #empty = h("p", { class: "lab-empty", hidden: true }, "No scene matches.");
  #shown: SceneId | undefined;

  constructor(ctx: LabContext, setScene: (scene: SceneId) => void) {
    this.#ctx = ctx;
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

    this.#body = h("div", { class: "view-body gallery", role: "group", "aria-label": "Scenes" });
    this.#rail = new Rail(this.#body, "Scene families", ctx.reducedMotion);
    const entries = families.map((family) => {
      const scenes = sceneIds.filter((id) => sceneFamily[id] === family.id);
      const cards = scenes.map((id) => this.#card(id, setScene));
      const el = h(
        "section",
        { class: "shelf", "aria-label": family.title },
        h(
          "h3",
          { class: "shelf-title" },
          icon(family.icon),
          h("span", {}, family.title),
          h("span", { class: "shelf-count" }, String(scenes.length)),
        ),
        h("div", { class: "cards" }, ...cards),
      );
      this.#shelves.push({ el, scenes, title: family.title });
      return { id: family.id, title: family.title, icon: family.icon, el, focus: cards[0] };
    });
    this.#body.append(...entries.map((entry) => entry.el), this.#empty);
    this.#body.addEventListener("keydown", (event) => this.#roam(event));
    this.#rail.set([entries]);

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
    const { scene } = this.#ctx.current().state;
    for (const [id, card] of this.#cards) {
      const current = id === scene;
      card.setAttribute("aria-pressed", String(current));
      if (current) card.setAttribute("aria-current", "true");
      else card.removeAttribute("aria-current");
    }
    // One card in the tab order: the current scene's, unless the keyboard is already in the gallery.
    if (this.#shown !== scene) {
      this.#shown = scene;
      for (const [id, card] of this.#cards) card.tabIndex = id === scene ? 0 : -1;
      if (!this.el.contains(document.activeElement))
        this.#cards.get(scene)?.scrollIntoView({ block: "nearest" });
    }
    this.#rail.spy();
  }

  #card(id: SceneId, setScene: (scene: SceneId) => void): HTMLButtonElement {
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
    card.addEventListener("click", () => setScene(id));
    this.#cards.set(id, card);
    return card;
  }

  #visibleCards(): HTMLButtonElement[] {
    return [...this.#cards.values()].filter((card) => !card.hidden);
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
        const card = this.#cards.get(id);
        if (card) card.hidden = !hit;
        if (hit) shown++;
      }
      shelf.el.hidden = shown === 0;
      if (shown > 0) any = true;
    }
    this.#empty.hidden = any;
    const first = this.#visibleCards()[0];
    if (first && !this.#visibleCards().some((card) => card.tabIndex === 0)) first.tabIndex = 0;
    this.#rail.spy();
  }
}
