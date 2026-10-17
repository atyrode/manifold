// The lab's compact presentation (lab.ts): its whole menu laid flat along a bar. The Find chip
// opens the Controls view itself (its search, lens and rail, narrowing as in the panel), the scene's
// chip the Scenes view and the Presets chip the presets; then a chip per Controls section, in the
// Controls order (the World shelf, the scene's groups, Global), opens that section. A composed
// scene's layer gathers its sections (MenuSection.layer) under one chip of its own, its icon and
// title, shown while it is switched on, after its Layers section's chip. Each opens in a popover
// holding the panel's own elements, lent while it is open (dom.ts `borrow`, inspector.ts `lend`),
// so both presentations share one set of controls and one set of syncs. A chip is lit while its
// sections differ from their defaults, as the lens counts them, and a section's shows its master
// switch on or off (menu-model.ts). The chips keep their titles while they all fit, go icon-only
// together when they do not, and then scroll: every section stays one press away, in one order,
// never folded behind another popover. The chips are one tab stop (the arrow keys, Home and End
// move along them); the tools (lab.ts) and the way back to the panel follow them.
import { iconButton } from "./controls.ts";
import { borrow, h, setAttr, setStyle, setText, type Child } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import type { Inspector, MenuLayer, MenuSection, Shelf } from "./inspector.ts";
import { chipState, chipStep, fitChips, stripRoom } from "./menu-model.ts";
import { Popover } from "./popover.ts";

/** The panel's views the bar opens besides the sections: the Controls view is its Find chip's. */
export type MenuViewId = "controls" | "scenes" | "presets";

/** A view of the panel the bar opens (Controls, Scenes, Presets): its element, lent while open. */
export interface MenuView {
  el: HTMLElement;
  /** It came on screen in its popover. */
  shown(): void;
  /** Hand it the keyboard as it opens; by default the popover takes it. */
  focus?: () => void;
}

/** A chip of the strip: a section's, or a layer's, which lends all its sections. */
interface Entry {
  title: string;
  /** The sections its popover lends, in order. */
  parts: readonly MenuSection[];
  /** The layer it stands for, shown while switched on. */
  layer: MenuLayer | undefined;
  chip: HTMLButtonElement;
  popover: Popover;
}

/** A chip: its icon, and its title while the chips have room for titles. */
function chipButton(name: IconName, title: string, ...extra: Child[]): HTMLButtonElement {
  return h(
    "button",
    { type: "button", class: "menu-chip", title, "aria-label": title, tabIndex: -1 },
    icon(name),
    h("span", { class: "menu-chip-title" }, title),
    ...extra,
  );
}

const divider = () => h("span", { class: "menu-divider", "aria-hidden": "true" });

export class MenuBar {
  readonly el: HTMLElement;
  /** Where the tools stand while the bar shows (lab.ts moves them between it and the panel). */
  readonly tools = h("div", { class: "menu-tools" });
  /** The way back to the inspector panel. */
  readonly expand: HTMLButtonElement;
  /** The Find chip, at the head of the bar (an icon alone): the Controls view, its search in hand. */
  readonly find = h(
    "button",
    {
      type: "button",
      class: "menu-chip menu-find",
      title: "Find a control: the search, the changed lens and every group",
      "aria-label": "Find a control",
      tabIndex: -1,
    },
    icon("search"),
  );
  readonly #layer: HTMLElement;
  readonly #inspector: Inspector;
  /** The chips, one tab stop: the scene's, then the strip of the rest. */
  readonly #chips: HTMLElement;
  readonly #strip: HTMLElement;
  /** In the strip, the World shelf's and the scene's own sections (Global's stand after it). */
  readonly #sections = h("span", { class: "menu-sections" });
  readonly #scene: HTMLButtonElement;
  readonly #sceneName = h("span", { class: "menu-chip-title" });
  readonly #entries = new Map<string, Entry>();
  /** The Scenes and Presets views' popovers. */
  readonly #views: Record<MenuViewId, Popover>;
  #menu: readonly MenuSection[] = [];
  /** The strip's width with the chips' titles and as icons, measured for the chips it holds. */
  #widths: { titled: number; icons: number } | undefined;
  /** The frame the next fit runs in, while one is asked for. */
  #fitting: number | undefined;

  constructor(
    layer: HTMLElement,
    inspector: Inspector,
    views: Record<Exclude<MenuViewId, "controls">, MenuView>,
    expand: () => void,
  ) {
    this.#layer = layer;
    this.#inspector = inspector;
    this.expand = iconButton("expand", "Expand the lab into its panel", expand);
    this.#scene = h(
      "button",
      { type: "button", class: "menu-chip menu-scene", tabIndex: 0 },
      h("span", { class: "scene-dot" }),
      this.#sceneName,
    );
    const presets = chipButton("bookmark", "Presets");
    // The Controls view moves into the popover whole, its search taking the keyboard.
    this.#views = {
      controls: this.#view("controls", "Find a control", "search", this.find, {
        el: inspector.el,
        shown: () => inspector.shown(),
        focus: () => inspector.focusSearch(),
      }),
      scenes: this.#view("scenes", "Scenes", "grid", this.#scene, views.scenes),
      presets: this.#view("presets", "Presets", "bookmark", presets, views.presets),
    };
    this.#strip = h("div", { class: "menu-strip" }, presets, divider(), this.#sections, divider());
    this.#strip.dataset.fit = "titled";
    this.#chips = h(
      "div",
      { class: "menu-chips", role: "toolbar", "aria-label": "Lab menu" },
      this.find,
      this.#scene,
      this.#strip,
    );
    this.el = h(
      "div",
      { class: "menu-bar" },
      this.#chips,
      h("span", { class: "lab-sep", "aria-hidden": "true" }),
      this.tools,
      h("span", { class: "lab-sep", "aria-hidden": "true" }),
      this.expand,
    );

    this.#chips.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        Popover.closeAll();
        return;
      }
      const chips = this.#chipList();
      const at = chips.findIndex((chip) => chip === document.activeElement);
      const to = chips[chipStep(event.key, at, chips.length) ?? -1];
      if (!to) return;
      event.preventDefault();
      this.#rove(to);
      to.focus();
    });
    // A chip pressed or reached by Tab is where the keyboard comes back to.
    this.#chips.addEventListener("focusin", (event) => {
      if (event.target instanceof HTMLButtonElement) this.#rove(event.target);
    });
    // A wheel turned over chips that scroll moves them along.
    this.#strip.addEventListener(
      "wheel",
      (event) => {
        const across = Math.abs(event.deltaX) >= Math.abs(event.deltaY);
        if (this.#strip.dataset.fit !== "scroll" || across) return;
        event.preventDefault();
        this.#strip.scrollLeft += event.deltaY;
      },
      { passive: false },
    );
    // The room changes with the strip's own size (a docked bar's edge, the screen's), the scene's
    // name and the tools beside it (A and B, the tour), and a floating bar's limit with the screen.
    const resized = new ResizeObserver(() => this.#askFit());
    for (const el of [this.#strip, this.#scene, this.tools]) resized.observe(el);
    window.addEventListener("resize", () => this.#askFit());
    void document.fonts.ready.then(() => {
      this.#widths = undefined;
      this.#askFit();
    });
  }

  /** The scene on screen, on its chip. */
  setScene(title: string, accent: string): void {
    setText(this.#sceneName, title);
    setStyle(this.#scene, "--dot", accent);
    setAttr(this.#scene, "title", `${title}: pick another scene ([ and ] step through them)`);
    setAttr(this.#scene, "aria-label", `Scene: ${title}. Pick another`);
  }

  /**
   * Reflect the setup into the chips (the sections' again once the scene's are rebuilt): a sync
   * that changes nothing writes nothing. A layer's chip shows while it is switched on; switched
   * off, its popover closes, and the chips fit again.
   */
  sync(): void {
    const menu = this.#inspector.menu;
    if (menu !== this.#menu) this.#rebuild(menu);
    let shown = false;
    for (const { title, parts, layer, chip, popover } of this.#entries.values()) {
      const changed = parts.reduce((sum, part) => sum + this.#inspector.changes(part.id), 0);
      const state = chipState(title, changed, layer ? undefined : parts[0]?.on());
      chip.classList.toggle("lit", state.lit);
      if (state.switched) setAttr(chip, "data-switch", state.switched);
      else if (chip.hasAttribute("data-switch")) chip.removeAttribute("data-switch");
      setAttr(chip, "title", state.label);
      setAttr(chip, "aria-label", state.label);
      if (layer === undefined || chip.hidden !== layer.on()) continue;
      chip.hidden = !layer.on();
      if (chip.hidden && popover.open) popover.toggle(false);
      shown = true;
    }
    if (!shown) return;
    if (!this.#chipList().some((chip) => chip.tabIndex === 0)) this.#rove(this.#scene);
    this.#widths = undefined;
    this.#askFit();
  }

  /** Whether view `id` is on screen, lent to its popover. */
  showing(id: MenuViewId): boolean {
    return this.#views[id].open;
  }

  /** The Scenes or Presets view's chip opens it, lent from the panel while it is open. */
  #view(
    id: MenuViewId,
    title: string,
    name: IconName,
    chip: HTMLButtonElement,
    view: MenuView,
  ): Popover {
    let back: (() => void) | undefined;
    const popover: Popover = new Popover(this.#layer, {
      id: `menu-${id}`,
      title,
      icon: name,
      button: chip,
      view: true,
      open: () => {
        back = borrow(view.el);
        popover.el.append(view.el);
        view.shown();
      },
      close: () => {
        back?.();
        back = undefined;
      },
      focus: () => (view.focus ? view.focus() : popover.el.focus()),
    });
    return popover;
  }

  /**
   * A chip for `parts`, which opens them, lent by the inspector while it is open: a section's, or
   * a layer's (its title and icon, its sections).
   */
  #entry(id: string, parts: readonly MenuSection[], layer: MenuLayer | undefined): Entry {
    const head = layer ?? parts[0];
    const title = head?.title ?? id;
    const name = head?.icon ?? "sliders";
    const chip = chipButton(
      name,
      title,
      h("span", { class: "menu-switch", "aria-hidden": "true" }),
    );
    chip.dataset.id = id;
    if (layer) chip.hidden = !layer.on();
    const popover: Popover = new Popover(this.#layer, {
      id: `menu-${id}`,
      title,
      icon: name,
      button: chip,
      bare: true,
      // The sections as the latest rebuild has them.
      open: () => {
        const lent = (this.#entries.get(id)?.parts ?? parts).map((part) => part.id);
        popover.el.append(...this.#inspector.lend(lent));
      },
      close: () => this.#inspector.giveBack(),
      focus: () => popover.el.focus(),
    });
    return { title, parts, layer, chip, popover };
  }

  /**
   * Chips for the sections of `menu`, a layer's sections under one chip: the scene left's go
   * (their popover closed), the new scene's come, Global's stay where they are (an open one stays
   * open). Then they fit again.
   */
  #rebuild(menu: readonly MenuSection[]): void {
    this.#menu = menu;
    const ids = new Set(menu.map((section) => section.layer?.key ?? section.id));
    let held = false;
    for (const [id, entry] of this.#entries) {
      if (ids.has(id)) continue;
      held ||= [entry.chip, entry.popover.el].some((el) => el.contains(document.activeElement));
      entry.popover.remove();
      entry.chip.remove();
      this.#entries.delete(id);
    }
    const chips = (shelf: Shelf) =>
      [...ids].flatMap((id) => {
        const parts = menu.filter((section) => (section.layer?.key ?? section.id) === id);
        const first = parts[0];
        if (first?.shelf !== shelf) return [];
        const entry = this.#entries.get(id) ?? this.#entry(id, parts, first.layer);
        entry.parts = parts;
        this.#entries.set(id, entry);
        return [entry.chip];
      });
    const world = chips("world");
    const own = chips("scene");
    this.#sections.replaceChildren(
      ...world,
      ...(world.length > 0 && own.length > 0 ? [divider()] : []),
      ...own,
    );
    for (const chip of chips("global"))
      if (chip.parentElement !== this.#strip) this.#strip.append(chip);
    const list = this.#chipList();
    if (!list.some((chip) => chip.tabIndex === 0)) this.#rove(this.#scene);
    // The keyboard was on a chip or in a popover that went: it comes back to the scene's chip.
    if (held) this.#scene.focus();
    this.#widths = undefined;
    this.#askFit();
  }

  /** The chips on show, in order. */
  #chipList(): HTMLButtonElement[] {
    return [...this.#chips.querySelectorAll<HTMLButtonElement>(".menu-chip:not([hidden])")];
  }

  /** Put chip `to` alone in the tab order. */
  #rove(to: HTMLButtonElement): void {
    for (const chip of this.#chips.querySelectorAll<HTMLButtonElement>(".menu-chip"))
      setAttr(chip, "tabindex", chip === to ? "0" : "-1");
  }

  #askFit(): void {
    if (this.#fitting !== undefined) return;
    this.#fitting = requestAnimationFrame(() => {
      this.#fitting = undefined;
      this.#fit();
    });
  }

  /**
   * Fit the chips to their room (menu-model.ts `fitChips`): how wide they run measured once for
   * the chips they are (both ways, a layout each; from the first chip's left to the last one's
   * right, whatever room the strip stretches to), the room each time. A hidden bar fits as it
   * shows.
   */
  #fit(): void {
    const strip = this.#strip;
    const bar = this.el.closest<HTMLElement>(".panel") ?? this.el;
    if (bar.getClientRects().length === 0) return;
    if (!this.#widths) {
      const run = () => {
        const first = strip.firstElementChild?.getBoundingClientRect();
        const last = strip.lastElementChild?.getBoundingClientRect();
        return first && last ? Math.ceil(last.right - first.left) : 0;
      };
      strip.dataset.fit = "titled";
      const titled = run();
      strip.dataset.fit = "icons";
      this.#widths = { titled, icons: run() };
    }
    // A floating bar grows with its content up to its max-width; a docked one spans its edge.
    const limit = Number.parseFloat(getComputedStyle(bar).maxWidth);
    const room = stripRoom(
      strip.clientWidth,
      bar.offsetWidth,
      Number.isFinite(limit) ? limit : bar.offsetWidth,
    );
    setAttr(strip, "data-fit", fitChips(this.#widths.titled, this.#widths.icons, room));
  }
}
