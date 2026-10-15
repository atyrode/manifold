// The lab panel's views, Scenes, Presets and Controls: one shows at a time, picked with segmented
// icon tabs in the panel's header (on a narrow screen, the sheet's). Beside the tabs stand the
// view's name and the scene on screen; the scene's name opens the scene picker (the Scenes view).
import { h } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";

export type ViewId = "scenes" | "presets" | "controls";

export interface View {
  id: ViewId;
  label: string;
  icon: IconName;
  el: HTMLElement;
  /** The view came on screen (its layout is known again). */
  shown(): void;
}

export class Views {
  /** The tabs, the view's name and the scene: the panel's header. */
  readonly head: HTMLElement;
  /** The views, one shown. */
  readonly body: HTMLElement;
  readonly #views: { view: View; tab: HTMLButtonElement; panel: HTMLElement }[];
  readonly #title = h("h2", { class: "view-title" });
  readonly #scene: HTMLButtonElement;
  readonly #sceneName = h("span", { class: "view-scene-name" });
  readonly #onShow: () => void;
  #current: ViewId = "controls";

  /** `onShow`: a view was picked (the panel should come up); `onScene`: the scene's name was. */
  constructor(views: readonly View[], onShow: () => void, onScene: () => void) {
    this.#onShow = onShow;
    const tablist = h("div", { class: "view-tabs", role: "tablist", "aria-label": "Lab views" });
    this.#views = views.map((view) => {
      const panel = h(
        "div",
        { class: "view", role: "tabpanel", id: `lab-view-${view.id}`, "aria-label": view.label },
        view.el,
      );
      const tab = h(
        "button",
        {
          type: "button",
          role: "tab",
          class: "view-tab",
          title: view.label,
          "aria-label": view.label,
          "aria-controls": panel.id,
          "data-view": view.id,
        },
        icon(view.icon),
      );
      tab.addEventListener("click", () => this.show(view.id));
      tablist.append(tab);
      return { view, tab, panel };
    });
    tablist.addEventListener("keydown", (event) => {
      const at = this.#views.findIndex((entry) => entry.view.id === this.#current);
      const last = this.#views.length - 1;
      const moves: Record<string, number> = {
        ArrowRight: at === last ? 0 : at + 1,
        ArrowLeft: at === 0 ? last : at - 1,
        Home: 0,
        End: last,
      };
      const next = this.#views[moves[event.key] ?? -1];
      if (!next) return;
      event.preventDefault();
      this.show(next.view.id);
      next.tab.focus();
    });
    this.#scene = h(
      "button",
      { type: "button", class: "view-scene", title: "Pick another scene" },
      h("span", { class: "scene-dot" }),
      this.#sceneName,
    );
    this.#scene.addEventListener("click", onScene);
    this.head = h("div", { class: "view-head" }, tablist, this.#title, this.#scene);
    this.body = h("div", { class: "views" }, ...this.#views.map(({ panel }) => panel));
    this.#render();
  }

  /** Show view `id` and bring the panel up. */
  show(id: ViewId): void {
    const changed = id !== this.#current;
    this.#current = id;
    this.#render();
    this.#onShow();
    if (changed) this.#views.find((entry) => entry.view.id === id)?.view.shown();
  }

  /** The scene on screen, beside the view's name. */
  setScene(title: string, accent: string): void {
    if (this.#sceneName.textContent !== title) this.#sceneName.textContent = title;
    this.#scene.style.setProperty("--dot", accent);
    this.#scene.setAttribute("aria-label", `Scene: ${title}. Pick another`);
  }

  #render(): void {
    for (const { view, tab, panel } of this.#views) {
      const selected = view.id === this.#current;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panel.hidden = !selected;
      if (selected) this.#title.textContent = view.label;
    }
  }
}
