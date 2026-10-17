// The lab's workspace: panels over the picture. Each panel drags by its header (or its grip, by
// keyboard: arrows move it, Alt+arrows resize it, Enter docks it to the next edge), docks to the
// edges it allows (a docked column or bar takes its room from the stage instead of covering it) and
// keeps where it was in this browser. The lab's presentation (lab.ts) shows one of its two panels:
// the inspector or the compact bar. On a narrow screen the inspector becomes a bottom sheet, its
// header along the sheet's top, and the bar runs along the bottom edge; neither moves there.
import { iconButton } from "./controls.ts";
import { drag, h } from "./dom.ts";
import { icon } from "./icons.ts";

export const panelIds = ["inspector", "bar"] as const;
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
}

export interface PanelSpec {
  id: PanelId;
  title: string;
  /** The edges it docks to (besides floating). */
  docks: readonly Exclude<Dock, "float">[];
  /** A bar (the compact lab): one row, its size its content's, the body in its header. */
  bar: boolean;
  min: { w: number; h: number };
  max: { w: number };
  /** A panel's header between its grip and its close button (on the sheet, the sheet's header). */
  head?: HTMLElement;
  body: HTMLElement;
  /** The layout before the user has moved it, for this viewport. */
  initial: (viewport: { w: number; h: number }) => PanelLayout;
}

const EDGE = 28;
const GAP = 12;
const STEP = 16;
/** A narrow screen: the inspector is a bottom sheet, the bar spans the bottom edge. */
export const NARROW = "(max-width: 720px)";

export class Panel {
  readonly spec: PanelSpec;
  readonly el: HTMLElement;
  readonly grip: HTMLButtonElement;
  layout: PanelLayout;
  /** Whether the lab's presentation shows it (Workspace.setShown). */
  shown = true;

  constructor(spec: PanelSpec, layout: PanelLayout, close: () => void) {
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
    const hide = iconButton("close", "Hide the lab (l)", close);
    const body = h("div", { class: "panel-body" }, spec.body);
    const head = spec.bar
      ? h("header", { class: "panel-head" }, this.grip, body, hide)
      : h("header", { class: "panel-head" }, this.grip, spec.head, hide);
    this.el = h(
      "section",
      {
        class: `panel${spec.bar ? " is-bar" : ""}`,
        "data-panel": spec.id,
        "aria-label": spec.title,
      },
      head,
      spec.bar ? null : body,
      ...(spec.bar
        ? []
        : (["x", "y", "both"] as const).map((axis) =>
            h("div", { class: "panel-resize", "data-axis": axis, "aria-hidden": "true" }),
          )),
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
    ax:
      record.ax === "left" || record.ax === "right" || record.ax === "center"
        ? record.ax
        : fallback.ax,
    x: num(record.x, fallback.x),
    ay: record.ay === "top" || record.ay === "bottom" ? record.ay : fallback.ay,
    y: Math.max(0, num(record.y, fallback.y)),
    w: Math.min(spec.max.w, Math.max(spec.min.w, num(record.w, fallback.w))),
    h: Math.max(spec.min.h, num(record.h, fallback.h)),
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
  readonly #close: () => void;
  readonly #zone = h("div", { class: "dock-zone", hidden: true });
  readonly #narrow = matchMedia(NARROW);
  readonly #sheet: HTMLElement;
  readonly #sheetBody = h("div", { class: "sheet-body" });
  readonly #sheetHandle: HTMLButtonElement;
  /** Where the panels' headers stand on the sheet. */
  readonly #sheetHead = h("div", { class: "sheet-title" });
  readonly #sheetState: SheetState;
  /** Stage room the docked panels take, per edge. */
  readonly #docked = { left: 0, right: 0, top: 0, bottom: 0 };
  /** Watches the bars' sizes (see the constructor). */
  readonly #bars: ResizeObserver;

  constructor(
    root: HTMLElement,
    saved: { panels: Record<string, unknown>; sheet: SheetState },
    save: (layouts: Record<PanelId, PanelLayout>, sheet: SheetState) => void,
    close: () => void,
  ) {
    this.#root = root;
    this.#saved = saved.panels;
    this.#save = save;
    this.#close = close;
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
    this.#sheet = h(
      "div",
      { class: "sheet", role: "region", "aria-label": "Lab" },
      h(
        "div",
        { class: "sheet-head" },
        this.#sheetHandle,
        this.#sheetHead,
        iconButton("close", "Hide the lab (l)", close),
      ),
      this.#sheetBody,
    );
    root.append(this.#zone, this.#sheet);
    this.#narrow.addEventListener("change", () => this.arrange());
    window.addEventListener("resize", () => this.arrange());
    // A bar is as wide as its content: when that changes (its chips fit, A and B show), it stands
    // again where it is anchored, in the next frame.
    let pending: number | undefined;
    this.#bars = new ResizeObserver(() => {
      if (pending !== undefined) return;
      pending = requestAnimationFrame(() => {
        pending = undefined;
        this.arrange();
      });
    });
  }

  add(spec: PanelSpec): Panel {
    const viewport = { w: window.innerWidth, h: window.innerHeight };
    const layout = clampLayout(this.#saved[spec.id], spec.initial(viewport), spec);
    const panel = new Panel(spec, layout, this.#close);
    this.#panels.push(panel);
    this.#sheet.before(panel.el);
    if (spec.bar) this.#bars.observe(panel.el);
    panel.el.querySelector(".panel-head")?.addEventListener("pointerdown", (event) => {
      // Panels stand still on a narrow screen: the sheet and the bar keep to the bottom edge.
      if (!(event instanceof PointerEvent) || event.button !== 0 || this.#narrow.matches) return;
      const target = event.target instanceof Element ? event.target : null;
      // Controls in the header keep their clicks; the grip and the bare header move the panel.
      const control = target?.closest("button, input, select, textarea, a, [role=slider]");
      if (control && !control.classList.contains("grip")) return;
      this.#move(panel, event);
    });
    panel.grip.addEventListener("keydown", (event) => this.#key(panel, event));
    for (const handle of panel.el.querySelectorAll<HTMLElement>(".panel-resize")) {
      const { axis } = handle.dataset;
      handle.addEventListener("pointerdown", (event) => {
        if (event.button === 0)
          this.#resize(panel, event, axis === "x" || axis === "y" ? axis : "both");
      });
    }
    return panel;
  }

  /** Show or hide panel `id`, as the lab's presentation has it; `arrange` lays it out. */
  setShown(id: PanelId, shown: boolean): void {
    const panel = this.#panels.find((candidate) => candidate.spec.id === id);
    if (panel) panel.shown = shown;
  }

  /** On a narrow screen, raise the sheet (a view was picked). */
  raiseSheet(): void {
    if (!this.#narrow.matches || this.#sheetState.open) return;
    this.#sheetState.open = true;
    this.#persist();
    this.arrange();
  }

  get narrow(): boolean {
    return this.#narrow.matches;
  }

  /** Lay every panel out for the viewport, and give the stage what the docked ones leave. */
  arrange(): void {
    const narrow = this.#narrow.matches;
    this.#root.classList.toggle("sheet-mode", narrow);
    Object.assign(this.#docked, { left: 0, right: 0, top: 0, bottom: 0 });
    for (const panel of this.#panels) panel.el.hidden = !panel.shown;
    if (narrow) this.#arrangeNarrow();
    else this.#arrangeFloating();
    const style = document.documentElement.style;
    for (const [edge, size] of Object.entries(this.#docked))
      style.setProperty(`--dock-${edge}`, `${Math.round(size)}px`);
  }

  /** A narrow screen: the inspector in the bottom sheet, the bar across the bottom edge. */
  #arrangeNarrow(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let sheet = false;
    for (const panel of this.#panels.filter((candidate) => candidate.shown)) {
      const { el, spec } = panel;
      if (spec.bar) {
        // As tall as its content, which it takes from the stage.
        el.dataset.dock = "bottom";
        el.style.left = "0px";
        el.style.width = `${vw}px`;
        el.style.height = "";
        this.#docked.bottom = el.offsetHeight;
        el.style.top = `${vh - this.#docked.bottom}px`;
        continue;
      }
      sheet = true;
      if (el.parentElement !== this.#sheetBody) this.#sheetBody.append(el);
      if (spec.head && spec.head.parentElement !== this.#sheetHead)
        this.#sheetHead.append(spec.head);
      el.removeAttribute("style");
    }
    this.#sheet.hidden = !sheet;
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
    for (const panel of this.#panels) {
      if (panel.el.parentElement !== this.#root) this.#sheet.before(panel.el);
      const { head } = panel.spec;
      if (head && head.parentElement === this.#sheetHead) panel.grip.after(head);
    }
    const open = this.#panels.filter((panel) => panel.shown);
    const column = (dock: Dock) => open.filter((panel) => panel.layout.dock === dock);
    const left = column("left");
    const right = column("right");
    const top = column("top");
    const bottom = column("bottom");
    const width = (list: Panel[]) =>
      list.reduce((most, panel) => Math.max(most, panel.layout.w), 0);
    this.#docked.left = width(left);
    this.#docked.right = width(right);
    // Bars measure themselves: placed first, so their height is known.
    for (const panel of [...top, ...bottom]) {
      this.#place(panel, {
        left: this.#docked.left,
        top: 0,
        width: vw - this.#docked.left - this.#docked.right,
        height: 0,
      });
    }
    this.#docked.top = top.reduce((sum, panel) => sum + panel.el.offsetHeight, 0);
    this.#docked.bottom = bottom.reduce((sum, panel) => sum + panel.el.offsetHeight, 0);
    let y = 0;
    for (const panel of top) {
      this.#place(panel, {
        left: this.#docked.left,
        top: y,
        width: vw - this.#docked.left - this.#docked.right,
        height: 0,
      });
      y += panel.el.offsetHeight;
    }
    y = vh;
    for (const panel of bottom) {
      y -= panel.el.offsetHeight;
      this.#place(panel, {
        left: this.#docked.left,
        top: y,
        width: vw - this.#docked.left - this.#docked.right,
        height: 0,
      });
    }
    for (const [list, side] of [
      [left, "left"],
      [right, "right"],
    ] as const) {
      const share = vh / Math.max(1, list.length);
      list.forEach((panel, index) => {
        const w = this.#docked[side];
        this.#place(panel, {
          left: side === "left" ? 0 : vw - w,
          top: index * share,
          width: w,
          height: share,
        });
      });
    }
    for (const panel of open) {
      panel.el.dataset.dock = panel.layout.dock;
      panel.el.dataset.anchor = panel.layout.ax;
      if (panel.layout.dock !== "float") continue;
      // A bar is measured at its content's width (not the one a narrow screen gave it).
      if (panel.spec.bar) panel.el.style.width = "";
      this.#place(panel, this.#floatRect(panel));
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
      layout.ax === "left"
        ? layout.x
        : layout.ax === "right"
          ? vw - layout.x - width
          : (vw - width) / 2 + layout.x;
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
      rect = {
        ...rect,
        width: panel.layout.w,
        height: Math.min(panel.layout.h, window.innerHeight - GAP * 2),
      };
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

  /** Drag a resize handle: `x` the inner side edge, `y` the bottom edge, `both` the corner. */
  #resize(panel: Panel, event: PointerEvent, axis: "x" | "y" | "both"): void {
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, w: panel.layout.w, h: panel.layout.h };
    const { dock, ax, ay } = panel.layout;
    const fromLeft = dock === "right" || (dock === "float" && ax === "right");
    document.body.classList.add("resizing");
    drag(
      event,
      event.currentTarget instanceof HTMLElement ? event.currentTarget : panel.el,
      (pointer) => {
        const { min, max } = panel.spec;
        if (axis !== "y") {
          const dx = (pointer.clientX - start.x) * (fromLeft ? -1 : 1);
          panel.layout.w = Math.round(Math.min(max.w, Math.max(min.w, start.w + dx)));
        }
        if (axis !== "x" && dock === "float") {
          const dy = (pointer.clientY - start.y) * (ay === "bottom" ? -1 : 1);
          panel.layout.h = Math.round(Math.max(min.h, start.h + dy));
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
      this.#anchor(panel, {
        left: rect.left + dx * step,
        top: rect.top + dy * step,
        width: rect.width,
        height: rect.height,
      });
    } else return;
    this.#persist();
    this.arrange();
  }

  #persist(): void {
    const layouts = Object.fromEntries(this.#panels.map((panel) => [panel.spec.id, panel.layout]));
    this.#save(layouts as Record<PanelId, PanelLayout>, this.#sheetState);
  }
}

/** The narrow-screen sheet: whether it stands raised (lowered, only its header shows). */
export interface SheetState {
  open: boolean;
}
