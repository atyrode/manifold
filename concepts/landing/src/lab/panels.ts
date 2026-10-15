// The lab's workspace: floating panels over the picture. Each panel drags by its header (or its
// grip, by keyboard: arrows move it, Alt+arrows resize it, Enter docks it to the next edge), docks
// to the edges it allows (a docked column or bar takes its room from the stage instead of covering
// it), folds to an icon and keeps where it was in this browser. On a narrow screen the panels become
// a bottom sheet with a tab each and the transport along its foot.
import { iconButton } from "./controls.ts";
import { drag, h } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";

export const panelIds = ["browser", "inspector", "transport"] as const;
export type PanelId = (typeof panelIds)[number];
export type Dock = "float" | "left" | "right" | "top" | "bottom";

export interface PanelLayout {
  dock: Dock;
  /** Floating: offset from the left or right edge, or from the centre. */
  ax: "left" | "center" | "right";
  x: number;
  /** Floating: offset from the top or the bottom edge. */
  ay: "top" | "bottom";
  y: number;
  w: number;
  h: number;
  collapsed: boolean;
}

export interface PanelSpec {
  id: PanelId;
  title: string;
  /** Its tab on the narrow-screen sheet. */
  tab: string;
  icon: IconName;
  /** The edges it docks to (besides floating). */
  docks: readonly Exclude<Dock, "float">[];
  /** A bar (the transport): one row, its size its content's. */
  bar: boolean;
  min: { w: number; h: number };
  max: { w: number };
  actions: HTMLElement[];
  body: HTMLElement;
  /** The layout before the user has moved it, for this viewport. */
  initial: (viewport: { w: number; h: number }) => PanelLayout;
}

const EDGE = 28;
const GAP = 12;
const STEP = 16;
const NARROW = "(max-width: 720px)";

export class Panel {
  readonly spec: PanelSpec;
  readonly el: HTMLElement;
  /** The folded panel: an icon button where it stood. */
  readonly chip: HTMLButtonElement;
  readonly sub = h("span", { class: "panel-sub" });
  readonly grip: HTMLButtonElement;
  readonly collapse: HTMLButtonElement;
  layout: PanelLayout;

  constructor(spec: PanelSpec, layout: PanelLayout, fold: () => void) {
    this.spec = spec;
    this.layout = layout;
    const name = spec.title.toLowerCase();
    this.grip = h(
      "button",
      {
        type: "button",
        class: "grip",
        title: `Move the ${name}: drag it, or arrow keys; Alt+arrows resize; Enter docks it to the next edge`,
        "aria-label": `Move the ${name} panel`,
      },
      icon("grip"),
    );
    this.collapse = iconButton("minus", `Fold the ${name} to an icon`, fold);
    const body = h("div", { class: "panel-body" }, spec.body);
    const head = spec.bar
      ? h("header", { class: "panel-head" }, this.grip, body, ...spec.actions, this.collapse)
      : h(
          "header",
          { class: "panel-head" },
          this.grip,
          h("span", { class: "panel-icon" }, icon(spec.icon)),
          h("h2", { class: "panel-title" }, spec.title),
          this.sub,
          h("span", { class: "spacer" }),
          ...spec.actions,
          this.collapse,
        );
    this.el = h(
      "section",
      { class: `panel${spec.bar ? " is-bar" : ""}`, "data-panel": spec.id, "aria-label": spec.title },
      head,
      spec.bar ? null : body,
      spec.bar ? null : h("div", { class: "panel-resize", "aria-hidden": "true" }),
    );
    this.chip = h(
      "button",
      {
        type: "button",
        class: "panel-chip",
        title: `${spec.title} (folded): click to open, drag to move`,
        "aria-label": `Open the ${spec.title.toLowerCase()}`,
        "data-panel": spec.id,
      },
      icon(spec.icon),
    );
  }
}

function clampLayout(raw: unknown, fallback: PanelLayout, spec: PanelSpec): PanelLayout {
  if (typeof raw !== "object" || raw === null) return fallback;
  const record = raw as Partial<Record<keyof PanelLayout, unknown>>;
  const docks: readonly Dock[] = ["float", ...spec.docks];
  const dock = docks.find((candidate) => candidate === record.dock) ?? fallback.dock;
  const num = (value: unknown, otherwise: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : otherwise;
  return {
    dock,
    ax: record.ax === "left" || record.ax === "right" || record.ax === "center" ? record.ax : fallback.ax,
    x: num(record.x, fallback.x),
    ay: record.ay === "top" || record.ay === "bottom" ? record.ay : fallback.ay,
    y: Math.max(0, num(record.y, fallback.y)),
    w: Math.min(spec.max.w, Math.max(spec.min.w, num(record.w, fallback.w))),
    h: Math.max(spec.min.h, num(record.h, fallback.h)),
    collapsed: record.collapsed === true,
  };
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export class Workspace {
  readonly #root: HTMLElement;
  readonly #panels: Panel[] = [];
  readonly #saved: Record<string, unknown>;
  readonly #save: (layouts: Record<PanelId, PanelLayout>, sheet: SheetState) => void;
  readonly #zone = h("div", { class: "dock-zone", hidden: true });
  readonly #narrow = matchMedia(NARROW);
  readonly #sheet: HTMLElement;
  readonly #sheetBody = h("div", { class: "sheet-body" });
  readonly #sheetBar = h("div", { class: "sheet-bar" });
  readonly #sheetHandle: HTMLButtonElement;
  readonly #tabs: HTMLButtonElement[] = [];
  readonly #tablist = h("div", { class: "sheet-tabs", role: "tablist", "aria-label": "Lab" });
  readonly #sheetState: SheetState;
  /** Stage room the docked panels take, per edge. */
  readonly #docked = { left: 0, right: 0, top: 0, bottom: 0 };

  constructor(
    root: HTMLElement,
    saved: { panels: Record<string, unknown>; sheet: SheetState },
    save: (layouts: Record<PanelId, PanelLayout>, sheet: SheetState) => void,
    close: () => void,
  ) {
    this.#root = root;
    this.#saved = saved.panels;
    this.#save = save;
    this.#sheetState = { ...saved.sheet };
    this.#sheetHandle = h(
      "button",
      { type: "button", class: "sheet-handle", "aria-label": "Expand the lab" },
      h("span"),
    );
    this.#sheetHandle.addEventListener("click", () => {
      this.#sheetState.open = !this.#sheetState.open;
      this.#persist();
      this.arrange();
    });
    this.#tablist.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const at = this.#tabs.findIndex((tab) => tab.dataset.panel === this.#sheetState.tab);
      const by = event.key === "ArrowRight" ? 1 : -1;
      const next = this.#tabs[(at + by + this.#tabs.length) % this.#tabs.length];
      next?.click();
      next?.focus();
    });
    this.#sheet = h(
      "div",
      { class: "sheet", role: "region", "aria-label": "Lab" },
      h(
        "div",
        { class: "sheet-head" },
        this.#sheetHandle,
        this.#tablist,
        iconButton("close", "Hide the lab (l)", close),
      ),
      this.#sheetBody,
      this.#sheetBar,
    );
    root.append(this.#zone, this.#sheet);
    this.#narrow.addEventListener("change", () => this.arrange());
    window.addEventListener("resize", () => this.arrange());
  }

  add(spec: PanelSpec): Panel {
    const viewport = { w: window.innerWidth, h: window.innerHeight };
    const layout = clampLayout(this.#saved[spec.id], spec.initial(viewport), spec);
    const panel = new Panel(spec, layout, () => this.#fold(panel, true));
    this.#panels.push(panel);
    this.#root.append(panel.el, panel.chip);
    panel.el.querySelector(".panel-head")?.addEventListener("pointerdown", (event) => {
      if (!(event instanceof PointerEvent) || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      // Controls in the header keep their clicks; the grip and the bare header move the panel.
      const control = target?.closest("button, input, select, textarea, a, [role=slider]");
      if (control && !control.classList.contains("grip")) return;
      this.#move(panel, event);
    });
    panel.grip.addEventListener("keydown", (event) => this.#key(panel, event));
    panel.chip.addEventListener("pointerdown", (event) => this.#moveChip(panel, event));
    // Enter or Space on the folded icon (a click without a pointer) unfolds it.
    panel.chip.addEventListener("click", (event) => {
      if (event.detail === 0) this.#fold(panel, false);
    });
    panel.el.querySelector(".panel-resize")?.addEventListener("pointerdown", (event) => {
      if (event instanceof PointerEvent && event.button === 0) this.#resize(panel, event);
    });
    if (!spec.bar) {
      const tab = h(
        "button",
        { type: "button", role: "tab", class: "sheet-tab", "data-panel": spec.id },
        icon(spec.icon),
        h("span", {}, spec.tab),
      );
      tab.addEventListener("click", () => {
        this.#sheetState.tab = spec.id;
        this.#sheetState.open = true;
        this.#persist();
        this.arrange();
      });
      this.#tabs.push(tab);
      this.#tablist.append(tab);
    }
    return panel;
  }

  /** Bring a panel up (unfolded, and in the sheet its tab). */
  show(id: PanelId): void {
    const panel = this.#panels.find((candidate) => candidate.spec.id === id);
    if (!panel) return;
    if (this.#narrow.matches && !panel.spec.bar) {
      this.#sheetState.tab = id;
      this.#sheetState.open = true;
      this.#persist();
      this.arrange();
    } else if (panel.layout.collapsed) this.#fold(panel, false);
  }

  get narrow(): boolean {
    return this.#narrow.matches;
  }

  /** Lay every panel out for the viewport, and give the stage what the docked ones leave. */
  arrange(): void {
    const narrow = this.#narrow.matches;
    this.#root.classList.toggle("sheet-mode", narrow);
    if (narrow) this.#arrangeSheet();
    else this.#arrangeFloating();
    const style = document.documentElement.style;
    for (const [edge, size] of Object.entries(this.#docked))
      style.setProperty(`--dock-${edge}`, `${Math.round(size)}px`);
  }

  #arrangeSheet(): void {
    Object.assign(this.#docked, { left: 0, right: 0, top: 0, bottom: 0 });
    const tab = this.#sheetState.tab;
    for (const panel of this.#panels) {
      const place = panel.spec.bar ? this.#sheetBar : this.#sheetBody;
      if (panel.el.parentElement !== place) place.append(panel.el);
      panel.el.removeAttribute("style");
      panel.el.hidden = !panel.spec.bar && panel.spec.id !== tab;
      panel.chip.hidden = true;
    }
    for (const button of this.#tabs) {
      const selected = button.dataset.panel === tab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    this.#sheet.hidden = false;
    this.#sheet.classList.toggle("open", this.#sheetState.open);
    this.#sheetHandle.setAttribute("aria-expanded", String(this.#sheetState.open));
    this.#sheetHandle.setAttribute(
      "aria-label",
      this.#sheetState.open ? "Lower the lab to see the scene" : "Raise the lab",
    );
  }

  #arrangeFloating(): void {
    this.#sheet.hidden = true;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    for (const panel of this.#panels)
      if (panel.el.parentElement !== this.#root) this.#root.insertBefore(panel.el, panel.chip);
    const open = this.#panels.filter((panel) => !panel.layout.collapsed);
    const column = (dock: Dock) => open.filter((panel) => panel.layout.dock === dock);
    const left = column("left");
    const right = column("right");
    const top = column("top");
    const bottom = column("bottom");
    const width = (list: Panel[]) => list.reduce((most, panel) => Math.max(most, panel.layout.w), 0);
    this.#docked.left = width(left);
    this.#docked.right = width(right);
    // Bars measure themselves: placed first, so their height is known.
    for (const panel of [...top, ...bottom]) {
      this.#place(panel, { left: this.#docked.left, top: 0, width: vw - this.#docked.left - this.#docked.right, height: 0 });
    }
    this.#docked.top = top.reduce((sum, panel) => sum + panel.el.offsetHeight, 0);
    this.#docked.bottom = bottom.reduce((sum, panel) => sum + panel.el.offsetHeight, 0);
    let y = 0;
    for (const panel of top) {
      this.#place(panel, { left: this.#docked.left, top: y, width: vw - this.#docked.left - this.#docked.right, height: 0 });
      y += panel.el.offsetHeight;
    }
    y = vh;
    for (const panel of bottom) {
      y -= panel.el.offsetHeight;
      this.#place(panel, { left: this.#docked.left, top: y, width: vw - this.#docked.left - this.#docked.right, height: 0 });
    }
    for (const [list, side] of [
      [left, "left"],
      [right, "right"],
    ] as const) {
      const share = vh / Math.max(1, list.length);
      list.forEach((panel, index) => {
        const w = this.#docked[side];
        this.#place(panel, { left: side === "left" ? 0 : vw - w, top: index * share, width: w, height: share });
      });
    }
    for (const panel of this.#panels) {
      panel.el.hidden = panel.layout.collapsed;
      panel.chip.hidden = !panel.layout.collapsed;
      panel.el.dataset.dock = panel.layout.dock;
      panel.el.dataset.anchor = panel.layout.ax;
      if (panel.layout.dock === "float" && !panel.layout.collapsed) this.#place(panel, this.#floatRect(panel));
    }
    // Folded panels sit where their panel stood: a floating one at its corner, a docked one along its edge.
    const stacks = { left: 0, right: 0, top: 0, bottom: 0 };
    for (const panel of this.#panels.filter((candidate) => candidate.layout.collapsed)) {
      const size = 40;
      const { dock } = panel.layout;
      let at: { left: number; top: number };
      if (dock === "float") {
        const rect = this.#floatRect(panel);
        at = {
          left: panel.layout.ax === "right" ? rect.left + rect.width - size : rect.left,
          top: panel.layout.ay === "bottom" ? rect.top + rect.height - size : rect.top,
        };
      } else {
        const index = stacks[dock]++;
        at =
          dock === "left"
            ? { left: GAP, top: GAP + index * (size + 8) }
            : dock === "right"
              ? { left: vw - size - GAP, top: GAP + index * (size + 8) }
              : { left: vw / 2 - size / 2 + index * (size + 8), top: dock === "top" ? GAP : vh - size - GAP };
      }
      panel.chip.style.left = `${Math.round(Math.min(vw - size, Math.max(0, at.left)))}px`;
      panel.chip.style.top = `${Math.round(Math.min(vh - size, Math.max(0, at.top)))}px`;
    }
  }

  /** Where a floating panel stands, kept inside the viewport. */
  #floatRect(panel: Panel): Rect {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { layout, spec } = panel;
    const width = spec.bar ? panel.el.offsetWidth || layout.w : Math.min(layout.w, vw - GAP * 2);
    const height = spec.bar ? panel.el.offsetHeight || layout.h : Math.min(layout.h, vh - GAP * 2);
    const left =
      layout.ax === "left" ? layout.x : layout.ax === "right" ? vw - layout.x - width : (vw - width) / 2 + layout.x;
    const top = layout.ay === "top" ? layout.y : vh - layout.y - height;
    return {
      left: Math.min(vw - width, Math.max(0, left)),
      top: Math.min(vh - height, Math.max(0, top)),
      width,
      height,
    };
  }

  #place(panel: Panel, rect: Rect): void {
    const style = panel.el.style;
    style.left = `${Math.round(rect.left)}px`;
    style.top = `${Math.round(rect.top)}px`;
    if (panel.spec.bar) {
      style.width = panel.layout.dock === "float" ? "" : `${Math.round(rect.width)}px`;
      style.height = "";
    } else {
      style.width = `${Math.round(rect.width)}px`;
      style.height = `${Math.round(rect.height)}px`;
    }
  }

  /** Store a floating panel's position, anchored to the edges it is nearest. */
  #anchor(panel: Panel, rect: Rect): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const centre = rect.left + rect.width / 2;
    const layout = panel.layout;
    layout.dock = "float";
    if (panel.spec.bar && Math.abs(centre - vw / 2) < vw / 6) {
      layout.ax = "center";
      layout.x = Math.round(centre - vw / 2);
    } else if (centre < vw / 2) {
      layout.ax = "left";
      layout.x = Math.round(rect.left);
    } else {
      layout.ax = "right";
      layout.x = Math.round(vw - rect.left - rect.width);
    }
    if (rect.top + rect.height / 2 < vh / 2) {
      layout.ay = "top";
      layout.y = Math.round(rect.top);
    } else {
      layout.ay = "bottom";
      layout.y = Math.round(vh - rect.top - rect.height);
    }
  }

  /** The edge a drag at (x, y) would dock to, if it allows one there. */
  #edgeAt(panel: Panel, x: number, y: number): Exclude<Dock, "float"> | undefined {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const near: [Exclude<Dock, "float">, boolean][] = [
      ["left", x < EDGE],
      ["right", x > vw - EDGE],
      ["top", y < EDGE],
      ["bottom", y > vh - EDGE],
    ];
    return near.find(([edge, hit]) => hit && panel.spec.docks.includes(edge))?.[0];
  }

  #showZone(panel: Panel, edge: Exclude<Dock, "float"> | undefined): void {
    this.#zone.hidden = edge === undefined;
    if (!edge) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const size = edge === "left" || edge === "right" ? panel.layout.w : panel.el.offsetHeight;
    const style = this.#zone.style;
    style.left = `${edge === "right" ? vw - size : 0}px`;
    style.top = `${edge === "bottom" ? vh - size : 0}px`;
    style.width = `${edge === "left" || edge === "right" ? size : vw}px`;
    style.height = `${edge === "top" || edge === "bottom" ? size : vh}px`;
  }

  #move(panel: Panel, event: PointerEvent): void {
    event.preventDefault();
    const start = panel.el.getBoundingClientRect();
    const offset = { x: event.clientX - start.left, y: event.clientY - start.top };
    let edge: Exclude<Dock, "float"> | undefined;
    let rect: Rect = { left: start.left, top: start.top, width: start.width, height: start.height };
    // A docked panel floats off at its own size, under the pointer.
    if (panel.layout.dock !== "float" && !panel.spec.bar) {
      rect = { ...rect, width: panel.layout.w, height: Math.min(panel.layout.h, window.innerHeight - GAP * 2) };
      offset.x = Math.min(offset.x, rect.width - 24);
    }
    panel.el.classList.add("moving");
    drag(
      event,
      event.currentTarget instanceof HTMLElement ? event.currentTarget : panel.el,
      (pointer) => {
        rect = { ...rect, left: pointer.clientX - offset.x, top: pointer.clientY - offset.y };
        if (panel.layout.dock !== "float") {
          this.#anchor(panel, rect);
          this.arrange();
        }
        this.#place(panel, {
          ...rect,
          left: Math.min(window.innerWidth - 40, Math.max(40 - rect.width, rect.left)),
          top: Math.min(window.innerHeight - 24, Math.max(0, rect.top)),
        });
        edge = this.#edgeAt(panel, pointer.clientX, pointer.clientY);
        this.#showZone(panel, edge);
      },
      () => {
        panel.el.classList.remove("moving");
        this.#zone.hidden = true;
        if (edge) panel.layout.dock = edge;
        else this.#anchor(panel, panel.el.getBoundingClientRect());
        this.#persist();
        this.arrange();
      },
    );
  }

  #moveChip(panel: Panel, event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY };
    const origin = panel.chip.getBoundingClientRect();
    let moved = false;
    drag(
      event,
      panel.chip,
      (pointer) => {
        if (!moved && Math.hypot(pointer.clientX - start.x, pointer.clientY - start.y) < 5) return;
        moved = true;
        panel.chip.style.left = `${origin.left + pointer.clientX - start.x}px`;
        panel.chip.style.top = `${origin.top + pointer.clientY - start.y}px`;
      },
      () => {
        if (!moved) {
          this.#fold(panel, false);
          return;
        }
        // The panel unfolds where its icon was left.
        const chip = panel.chip.getBoundingClientRect();
        const vw = window.innerWidth;
        const width = panel.spec.bar ? panel.el.offsetWidth || panel.layout.w : panel.layout.w;
        const left = chip.left + chip.width / 2 < vw / 2 ? chip.left : chip.right - width;
        const height = panel.spec.bar ? 44 : panel.layout.h;
        const top = chip.top + chip.height / 2 < window.innerHeight / 2 ? chip.top : chip.bottom - height;
        this.#anchor(panel, { left, top, width, height });
        this.#persist();
        this.arrange();
      },
    );
  }

  #resize(panel: Panel, event: PointerEvent): void {
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, w: panel.layout.w, h: panel.layout.h };
    const fromLeft = panel.layout.dock === "right" || (panel.layout.dock === "float" && panel.layout.ax === "right");
    document.body.classList.add("resizing");
    drag(
      event,
      event.currentTarget instanceof HTMLElement ? event.currentTarget : panel.el,
      (pointer) => {
        const dx = (pointer.clientX - start.x) * (fromLeft ? -1 : 1);
        panel.layout.w = Math.round(Math.min(panel.spec.max.w, Math.max(panel.spec.min.w, start.w + dx)));
        if (panel.layout.dock === "float") {
          const dy = (pointer.clientY - start.y) * (panel.layout.ay === "bottom" ? -1 : 1);
          panel.layout.h = Math.round(Math.max(panel.spec.min.h, start.h + dy));
        }
        this.arrange();
      },
      () => {
        document.body.classList.remove("resizing");
        this.#persist();
      },
    );
  }

  #key(panel: Panel, event: KeyboardEvent): void {
    const { layout, spec } = panel;
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const arrow = arrows[event.key];
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const order: Dock[] = ["float", ...spec.docks];
      if (layout.dock === "float") this.#anchor(panel, panel.el.getBoundingClientRect());
      layout.dock = order[(order.indexOf(layout.dock) + 1) % order.length] ?? "float";
    } else if (arrow && event.altKey && !spec.bar) {
      event.preventDefault();
      const [dx, dy] = arrow;
      layout.w = Math.min(spec.max.w, Math.max(spec.min.w, layout.w + dx * STEP));
      layout.h = Math.max(spec.min.h, layout.h + dy * STEP);
    } else if (arrow) {
      event.preventDefault();
      const [dx, dy] = arrow;
      const step = event.shiftKey ? STEP * 4 : STEP;
      const rect = panel.el.getBoundingClientRect();
      this.#anchor(panel, { left: rect.left + dx * step, top: rect.top + dy * step, width: rect.width, height: rect.height });
    } else return;
    this.#persist();
    this.arrange();
  }

  #fold(panel: Panel, folded: boolean): void {
    panel.layout.collapsed = folded;
    this.#persist();
    this.arrange();
    (folded ? panel.chip : panel.grip).focus();
  }

  #persist(): void {
    const layouts = Object.fromEntries(this.#panels.map((panel) => [panel.spec.id, panel.layout]));
    this.#save(layouts as Record<PanelId, PanelLayout>, this.#sheetState);
  }
}

/** The narrow-screen sheet: which tab shows, and whether it stands raised. */
export interface SheetState {
  tab: PanelId;
  open: boolean;
}
