// The lab sidebar. Built entirely from the scene catalogue and knob definitions: every change goes
// through the host as a URL query, so links, presets and undo all share one representation.
import { formatValue, groupInfo, MAX_SEED, sceneInfo, sceneParams, type Option, type ParamDef } from "./params.ts";
import { loadLocalPresets, parsePresets, presets, saveLocalPresets, type Preset } from "./presets.ts";
import { colorIds, ditherIds, sceneIds, viewIds, type DitherRenderer, type SceneId } from "./renderer.ts";
import { accentOf, carryLook, defaultsFor, modeIds, paramDefaults, sceneAccent, serialise, type LabState, type Params } from "./state.ts";

export interface LabHost {
  current(): { state: LabState; params: Params };
  /** Replace the whole setup. The host re-renders, then calls `Lab.sync()`. */
  apply(query: URLSearchParams): void;
  renderer(): DitherRenderer | undefined;
  /** Commit the page was built from; empty for a working tree. */
  build: string;
}

type Patch = Record<string, string | number>;
type Child = Node | string | false | null | undefined;

/** Element factory: attributes for data-/aria-/role, properties otherwise. */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === "class") el.className = String(value);
    else if (key.startsWith("data-") || key.startsWith("aria-") || key === "role") el.setAttribute(key, String(value));
    else (el as unknown as Record<string, unknown>)[key] = value;
  }
  for (const child of children) if (child !== false && child !== null && child !== undefined) el.append(child);
  return el;
}

const ICONS = {
  chevron: "M6 4l4 4-4 4",
  close: "M10 3 5 8l5 5",
  undo: "M5 6H10a3 3 0 0 1 0 6H6M5 6l3-3M5 6l3 3",
  redo: "M11 6H6a3 3 0 0 0 0 6h4M11 6 8 3M11 6 8 9",
  help: "M6 6a2 2 0 1 1 3 1.7c-.6.4-1 .8-1 1.6M8 11.5v.5",
  search: "M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM11 11l3 3",
  shuffle: "M2 4h3l6 8h3M2 12h3l2-2.6M10 5.6 11 4h3M12.5 2.5 14 4l-1.5 1.5M12.5 10.5 14 12l-1.5 1.5",
  reset: "M3 8a5 5 0 1 0 1.5-3.5M3 2.5V5h2.5",
  link: "M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5L8 4.5M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l1-1",
  play: "M5 3.5v9l7-4.5z",
  pause: "M5 3.5v9M11 3.5v9",
  external: "M9 3h4v4M13 3 7 9M11 9.5V13H3V5h3.5",
  dice: "M3 3h10v10H3zM6 6h.01M10 6h.01M8 8h.01M6 10h.01M10 10h.01",
  bolt: "M9 2 4 9h4l-1 5 5-7H8z",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5",
} as const;

function icon(name: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

const MODE_LABEL: Record<(typeof modeIds)[number], string> = { landing: "Landing", loading: "Loading", instance: "Sign-in", bare: "None" };
const VIEW_LABEL: Record<(typeof viewIds)[number], string> = { dithered: "Dithered", source: "Source", split: "Split" };
const DITHER_LABEL: Record<(typeof ditherIds)[number], string> = { bayer8: "Bayer 8", bayer4: "Bayer 4", ign: "Noise", none: "None" };
const COLOR_LABEL: Record<(typeof colorIds)[number], string> = { accent: "Accent", mono: "Mono", full: "Full" };
const SWATCHES = ["#4c6ef5", "#ff004e", "#ff7a2f", "#f2c94c", "#2bd9a8", "#e8e6df"] as const;

const SHORTCUTS: readonly (readonly [string, string])[] = [
  ["[  ]", "previous / next scene"],
  ["l", "show or hide the lab"],
  ["/", "find a control"],
  ["h", "hide the page on top"],
  ["p", "pause or play"],
  ["Ctrl Z", "undo"],
  ["Ctrl ⇧ Z", "redo"],
];

interface Prefs {
  open: boolean;
  width: number;
  explain: boolean;
  /** Open (true) or folded (false) per section id; missing means the section's default. */
  sections: Record<string, boolean>;
}

const PREFS_KEY = "landing.lab.v2";

function loadPrefs(): Prefs {
  const fallback: Prefs = { open: false, width: 340, explain: false, sections: {} };
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    if (typeof raw !== "object" || raw === null) return fallback;
    const record = raw as Partial<Prefs>;
    return {
      open: record.open === true,
      width: typeof record.width === "number" ? Math.min(560, Math.max(290, record.width)) : fallback.width,
      explain: record.explain === true,
      sections: typeof record.sections === "object" && record.sections !== null ? record.sections : {},
    };
  } catch (error: unknown) {
    console.error("evt=landing.lab_prefs.unreadable", error);
    return fallback;
  }
}

interface Built {
  el: HTMLElement;
  sync: () => void;
}

/** Open while 'isOpen' holds; animates height through a grid row. */
function reveal(child: HTMLElement, isOpen: () => boolean): Built {
  const el = h("div", { class: "reveal" }, h("div", { class: "reveal-inner" }, child));
  return { el, sync: () => el.classList.toggle("open", isOpen()) };
}

export class Lab {
  readonly #root: HTMLElement;
  readonly #opener: HTMLButtonElement;
  readonly #host: LabHost;
  readonly #prefs = loadPrefs();
  readonly #syncers: (() => void)[] = [];
  #sceneSyncers: (() => void)[] = [];
  readonly #sceneSlot = h("div", { class: "scene-sections" });
  #builtScene: SceneId | undefined;
  readonly #undoStack: string[] = [];
  readonly #redoStack: string[] = [];
  #committed: string;
  readonly #search: HTMLInputElement;
  readonly #undoButton: HTMLButtonElement;
  readonly #redoButton: HTMLButtonElement;
  readonly #sceneLabel = h("span", { class: "lab-scene" });
  readonly #status = h("div", { class: "lab-status" });

  constructor(root: HTMLElement, opener: HTMLButtonElement, host: LabHost) {
    this.#root = root;
    this.#opener = opener;
    this.#host = host;
    this.#committed = this.#query();
    document.documentElement.style.setProperty("--lab-width", `${this.#prefs.width}px`);
    root.classList.toggle("explain", this.#prefs.explain);

    this.#search = h("input", { type: "search", placeholder: "Find a control…", "aria-label": "Find a control", spellcheck: false });
    this.#search.addEventListener("input", () => this.#filter());
    this.#search.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { this.#search.value = ""; this.#filter(); this.#search.blur(); }
    });
    this.#undoButton = this.#iconButton("undo", "Undo (Ctrl Z)", () => this.undo());
    this.#redoButton = this.#iconButton("redo", "Redo (Ctrl ⇧ Z)", () => this.redo());
    const explain = this.#iconButton("help", "Explain every control", () => {
      this.#prefs.explain = !this.#prefs.explain;
      root.classList.toggle("explain", this.#prefs.explain);
      explain.setAttribute("aria-pressed", String(this.#prefs.explain));
      this.#savePrefs();
    });
    explain.setAttribute("aria-pressed", String(this.#prefs.explain));

    const header = h("header", { class: "lab-header" },
      h("div", { class: "lab-bar" },
        h("span", { class: "lab-name" }, "Lab"), this.#sceneLabel,
        h("span", { class: "spacer" }),
        this.#undoButton, this.#redoButton, explain,
        this.#iconButton("close", "Hide the lab (l)", () => this.setOpen(false)),
      ),
      h("label", { class: "lab-search" }, icon("search"), this.#search),
    );

    const body = h("div", { class: "lab-body" },
      this.#sceneSection(),
      this.#sceneSlot,
      this.#lookSection(),
      this.#motionSection(),
      this.#presetsSection(),
      this.#keysSection(),
      h("p", { class: "lab-empty" }, "Nothing matches. Try another word, or press Esc."),
    );

    const footer = h("footer", { class: "lab-footer" },
      h("div", { class: "lab-actions" },
        this.#textButton("shuffle", "Shuffle", "Randomise this scene's knobs (camera stays put)", () => this.#shuffle()),
        this.#textButton("reset", "Reset", "Back to this scene's defaults", () => this.#change(Object.fromEntries([["scene", this.#current().state.scene]]), true, true)),
        this.#textButton("link", "Copy link", "Copy a link that replays this exact setup on this build", (button) => this.#copyLink(button)),
      ),
      this.#status,
    );

    const resize = h("div", { class: "lab-resize", role: "separator", "aria-orientation": "vertical", title: "Drag to resize" });
    resize.addEventListener("pointerdown", (event) => this.#startResize(event));

    root.replaceChildren(header, body, footer, resize);
    root.addEventListener("change", () => this.commit());
    opener.addEventListener("click", () => this.setOpen(true));
    setInterval(() => this.#syncStatus(), 500);
    this.setOpen(this.#prefs.open);
  }

  get open(): boolean {
    return !this.#root.hidden;
  }

  setOpen(open: boolean): void {
    this.#root.hidden = !open;
    document.body.classList.toggle("lab-open", open);
    this.#opener.setAttribute("aria-expanded", String(open));
    this.#prefs.open = open;
    this.#savePrefs();
  }

  focusSearch(): void {
    this.setOpen(true);
    this.#search.focus();
    this.#search.select();
  }

  /** Reflect the host's current state into every control. */
  sync(): void {
    const { state } = this.#current();
    if (this.#builtScene !== state.scene) this.#buildScene(state.scene);
    this.#sceneLabel.textContent = sceneInfo[state.scene].title;
    for (const sync of this.#syncers) sync();
    for (const sync of this.#sceneSyncers) sync();
    this.#filter();
    this.#syncHistory();
  }

  /** Record the current setup as one undo step (sliders commit on release). */
  commit(): void {
    const now = this.#query();
    if (now === this.#committed) return;
    this.#undoStack.push(this.#committed);
    if (this.#undoStack.length > 100) this.#undoStack.shift();
    this.#redoStack.length = 0;
    this.#committed = now;
    this.#syncHistory();
  }

  undo(): void {
    const previous = this.#undoStack.pop();
    if (previous === undefined) return;
    this.#redoStack.push(this.#committed);
    this.#committed = previous;
    this.#host.apply(new URLSearchParams(previous));
  }

  redo(): void {
    const next = this.#redoStack.pop();
    if (next === undefined) return;
    this.#undoStack.push(this.#committed);
    this.#committed = next;
    this.#host.apply(new URLSearchParams(next));
  }

  // ---- state plumbing -------------------------------------------------------------------------

  #current(): { state: LabState; params: Params } {
    return this.#host.current();
  }

  /** Defaults for the current scene (its look may differ from the global defaults). */
  #base(): LabState {
    return defaultsFor(this.#current().state.scene);
  }

  #query(): string {
    const { state, params } = this.#current();
    return serialise(state, params).toString();
  }

  /** Apply a patch over the current setup; `replace` starts from the patch alone. */
  #change(patch: Patch, commit: boolean, replace = false): void {
    const { state, params } = this.#current();
    const q = replace ? new URLSearchParams() : serialise(state, params);
    for (const [key, value] of Object.entries(patch)) q.set(key, String(value));
    this.#host.apply(q);
    if (commit) this.commit();
  }

  #on(key: string | undefined): boolean {
    return key === undefined || (this.#current().params[key] ?? 0) > 0.5;
  }

  #savePrefs(): void {
    localStorage.setItem(PREFS_KEY, JSON.stringify(this.#prefs));
  }

  #syncHistory(): void {
    this.#undoButton.disabled = this.#undoStack.length === 0;
    this.#redoButton.disabled = this.#redoStack.length === 0;
  }

  #syncStatus(): void {
    const renderer = this.#host.renderer();
    const gpu = renderer?.glInfo.split(" · ")[1] ?? "WebGL2 unavailable";
    const parts = [
      this.#host.build ? `build ${this.#host.build}` : "working tree",
      renderer ? `${Math.round(renderer.fps)} fps` : "",
      renderer?.paused ? "paused" : "",
    ].filter(Boolean);
    this.#status.textContent = parts.join(" · ");
    this.#status.title = `${parts.join(" · ")}\n${gpu}`;
  }

  // ---- primitives -----------------------------------------------------------------------------

  #iconButton(name: keyof typeof ICONS, title: string, onClick: () => void): HTMLButtonElement {
    const button = h("button", { type: "button", class: "icon-button", title, "aria-label": title }, icon(name));
    button.addEventListener("click", onClick);
    return button;
  }

  #textButton(name: keyof typeof ICONS, text: string, title: string, onClick: (button: HTMLButtonElement) => void): HTMLButtonElement {
    const button = h("button", { type: "button", class: "text-button", title }, icon(name), h("span", {}, text));
    button.addEventListener("click", () => onClick(button));
    return button;
  }

  #flash(button: HTMLButtonElement, text: string): void {
    const label = button.querySelector("span");
    if (!label) return;
    const original = label.dataset.text ?? label.textContent ?? "";
    label.dataset.text = original;
    label.textContent = text;
    setTimeout(() => { label.textContent = original; }, 1500);
  }

  #switch(label: string, get: () => boolean, set: (on: boolean) => void): Built {
    const el = h("button", { type: "button", role: "switch", class: "switch", "aria-label": label }, h("span", { class: "knob" }));
    el.addEventListener("click", () => set(!get()));
    return { el, sync: () => el.setAttribute("aria-checked", String(get())) };
  }

  #slider(label: string, min: number, max: number, step: number, get: () => number, set: (value: number, commit: boolean) => void): Built {
    const el = h("input", { type: "range", min: String(min), max: String(max), step: String(step), "aria-label": label });
    el.addEventListener("input", () => set(Number(el.value), false));
    const sync = () => {
      if (document.activeElement !== el) el.value = String(get());
      el.style.setProperty("--fill", `${((get() - min) / (max - min)) * 100}%`);
    };
    return { el, sync };
  }

  #segments(label: string, options: readonly { label: string; value: string }[], get: () => string, set: (value: string) => void): Built {
    const buttons = options.map((option) => {
      const button = h("button", { type: "button", "data-value": option.value }, option.label);
      button.addEventListener("click", () => set(option.value));
      return button;
    });
    const el = h("div", { class: "segments", role: "group", "aria-label": label }, ...buttons);
    el.style.setProperty("--count", String(options.length));
    return { el, sync: () => { for (const button of buttons) button.setAttribute("aria-pressed", String(button.dataset.value === get())); } };
  }

  /**
   * One control row: label, optional readout and inline control on the first line, a block
   * control under it, and a hint that the "?" (or explain mode) unfolds.
   */
  #row(spec: {
    label: string;
    help: string;
    inline?: HTMLElement[];
    block?: HTMLElement;
    readout?: () => string;
    modified?: () => boolean;
    reset?: () => void;
  }): Built {
    const hint = h("p", { class: "hint" }, spec.help);
    const hintToggle = h("button", { type: "button", class: "hint-toggle", title: "What is this?", "aria-label": `About ${spec.label}`, "aria-expanded": "false" }, "?");
    hintToggle.addEventListener("click", () => {
      const open = hintToggle.getAttribute("aria-expanded") !== "true";
      hintToggle.setAttribute("aria-expanded", String(open));
      el.classList.toggle("hint-open", open);
    });
    const dot = h("button", { type: "button", class: "modified", title: "Changed — click to reset", "aria-label": `Reset ${spec.label}` });
    if (spec.reset) dot.addEventListener("click", spec.reset);
    const readout = h("span", { class: "readout" });
    const el = h("div", { class: "row", "data-search": `${spec.label} ${spec.help}`.toLowerCase() },
      h("div", { class: "row-head" },
        dot,
        h("span", { class: "row-label" }, spec.label),
        hintToggle,
        h("span", { class: "spacer" }),
        spec.readout ? readout : null,
        ...(spec.inline ?? []),
      ),
      spec.block ?? null,
      hint,
    );
    if (spec.reset) el.addEventListener("dblclick", (event) => {
      if (event.target instanceof HTMLElement && event.target.closest(".row-label")) spec.reset?.();
    });
    return {
      el,
      sync: () => {
        dot.hidden = !(spec.modified?.() ?? false);
        if (spec.readout) readout.textContent = spec.readout();
      },
    };
  }

  /** A collapsible section with summary chips when folded, an optional master switch and reset. */
  #section(spec: {
    id: string;
    title: string;
    blurb: string;
    open: boolean;
    content: HTMLElement[];
    summary: () => string[];
    master?: Built;
    masterOn?: () => boolean;
    offNote?: string;
    modified?: () => boolean;
    reset?: () => void;
    syncers: (() => void)[];
  }): HTMLElement {
    const isOpen = () => this.#prefs.sections[spec.id] ?? spec.open;
    const chips = h("span", { class: "chips" });
    const toggle = h("button", { type: "button", class: "sec-toggle" }, icon("chevron"), h("span", { class: "sec-title" }, spec.title), chips);
    const reset = h("button", { type: "button", class: "sec-reset", title: `Reset ${spec.title.toLowerCase()} to defaults` }, "reset");
    if (spec.reset) reset.addEventListener("click", spec.reset);
    const offNote = spec.offNote ? h("p", { class: "sec-off" }, spec.offNote) : null;
    const inner = h("div", { class: "sec-body" }, h("p", { class: "sec-blurb" }, spec.blurb), offNote, ...spec.content);
    const body = h("div", { class: "reveal" }, h("div", { class: "reveal-inner" }, inner));
    const el = h("section", { class: "sec", "data-id": spec.id },
      h("div", { class: "sec-head" }, toggle, spec.reset ? reset : null, spec.master?.el ?? null),
      body,
    );
    toggle.addEventListener("click", () => {
      this.#prefs.sections[spec.id] = !isOpen();
      this.#savePrefs();
      sync();
    });
    const sync = () => {
      const open = isOpen() || el.classList.contains("searching");
      body.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", String(open));
      el.classList.toggle("collapsed", !open);
      const on = spec.masterOn?.() ?? true;
      el.classList.toggle("off", !on);
      if (offNote) offNote.hidden = on;
      spec.master?.sync();
      reset.hidden = !(spec.modified?.() ?? false);
      const items = spec.summary();
      chips.replaceChildren(...items.slice(0, 3).map((item) => h("span", { class: "chip" }, item)), items.length > 3 ? h("span", { class: "chip" }, `+${items.length - 3}`) : "");
    };
    spec.syncers.push(sync);
    return el;
  }

  // ---- global sections ------------------------------------------------------------------------

  #sceneSection(): HTMLElement {
    const cards = sceneIds.map((id) => {
      const card = h("button", { type: "button", class: "scene-card", "data-scene": id },
        h("span", { class: "scene-dot" }),
        h("span", { class: "scene-title" }, sceneInfo[id].title),
        h("span", { class: "scene-blurb" }, sceneInfo[id].blurb),
      );
      card.style.setProperty("--dot", sceneAccent[id]);
      card.addEventListener("click", () => this.#setScene(id));
      return card;
    });
    const page = this.#segments("Page on top", modeIds.map((id) => ({ label: MODE_LABEL[id], value: id })),
      () => this.#current().state.mode, (mode) => this.#change({ mode }, true));
    const nameInput = h("input", { type: "text", maxLength: 40, spellcheck: false, "aria-label": "Instance name" });
    nameInput.addEventListener("input", () => this.#change({ instance: nameInput.value }, false));
    const nameRow = this.#row({ label: "Instance name", help: "Shown on the sign-in card of a private instance.", block: nameInput });
    const nameReveal = reveal(nameRow.el, () => this.#current().state.mode === "instance");
    const pageRow = this.#row({
      label: "Page on top",
      help: "Landing: the public introduction. Loading: what shows while the app boots. Sign-in: the face of a private instance. None: the scene alone (h toggles this).",
      block: page.el,
    });
    const grid = h("div", { class: "scene-grid", "data-search": "scene wave starry orbit swell pond picture" }, ...cards);
    const dim = this.#slider("Dim background", 0, 1, 0.05, () => this.#current().state.dim, (value, commit) => this.#change({ dim: value }, commit));
    const blur = this.#slider("Blur background", 0, 1, 0.05, () => this.#current().state.blur, (value, commit) => this.#change({ blur: value }, commit));
    const dimRow = this.#row({ label: "Dim background", help: "Darken the scene behind the page, to judge whether the copy needs help to stand out.", block: dim.el, readout: () => `${Math.round(this.#current().state.dim * 100)}%`, modified: () => this.#current().state.dim !== 0, reset: () => this.#change({ dim: 0 }, true) });
    const blurRow = this.#row({ label: "Blur background", help: "Soften the scene behind the page so the copy is the only sharp thing on screen.", block: blur.el, readout: () => `${Math.round(this.#current().state.blur * 12)}px`, modified: () => this.#current().state.blur !== 0, reset: () => this.#change({ blur: 0 }, true) });
    this.#syncers.push(() => {
      const { state } = this.#current();
      for (const card of cards) card.setAttribute("aria-pressed", String(card.dataset.scene === state.scene));
      if (document.activeElement !== nameInput) nameInput.value = state.instance;
    }, page.sync, pageRow.sync, nameRow.sync, nameReveal.sync, dim.sync, blur.sync, dimRow.sync, blurRow.sync);
    return this.#section({
      id: "scene",
      title: "Scene",
      blurb: "Pick the picture, then what sits on top of it.",
      open: true,
      content: [grid, pageRow.el, nameReveal.el, dimRow.el, blurRow.el],
      summary: () => {
        const { state } = this.#current();
        return [sceneInfo[state.scene].title, MODE_LABEL[state.mode], state.dim > 0 ? `dim ${Math.round(state.dim * 100)}%` : "", state.blur > 0 ? "blurred" : ""].filter(Boolean);
      },
      syncers: this.#syncers,
    });
  }

  #lookSection(): HTMLElement {
    const view = this.#segments("View", viewIds.map((id) => ({ label: VIEW_LABEL[id], value: id })),
      () => this.#current().state.view, (value) => this.#change({ view: value }, true));
    const dither = this.#segments("Dither pattern", ditherIds.map((id) => ({ label: DITHER_LABEL[id], value: id })),
      () => this.#current().state.dither, (value) => this.#change({ dither: value }, true));
    const colour = this.#segments("Colour", colorIds.map((id) => ({ label: COLOR_LABEL[id], value: id })),
      () => this.#current().state.color, (value) => this.#change({ color: value }, true));
    const levels = this.#slider("Tones", 2, 6, 1, () => this.#current().state.levels, (value, commit) => this.#change({ levels: value }, commit));
    const pixel = this.#slider("Dot size", 1, 8, 1, () => this.#current().state.pixel, (value, commit) => this.#change({ pixel: value }, commit));

    const swatches = [
      { value: "", label: "Scene default" },
      ...SWATCHES.map((value) => ({ value, label: value })),
    ].map((swatch) => {
      const button = h("button", { type: "button", class: "swatch", title: swatch.label, "aria-label": swatch.label, "data-value": swatch.value });
      button.addEventListener("click", () => this.#change({ accent: swatch.value }, true));
      return button;
    });
    const custom = h("input", { type: "color", class: "swatch-custom", title: "Any colour", "aria-label": "Custom accent colour" });
    custom.addEventListener("input", () => this.#change({ accent: custom.value }, false));
    const swatchRow = h("div", { class: "swatches" }, ...swatches, custom);

    const rows = [
      this.#row({ label: "View", help: "Dithered is the finished look. Source shows the picture before dithering; Split puts source on the left and dithered on the right, to see what the shader does.", block: view.el, modified: () => this.#current().state.view !== this.#base().view, reset: () => this.#change({ view: this.#base().view }, true) }),
      this.#row({ label: "Dither pattern", help: "How tones turn into dots. Bayer 8 and 4: ordered cross-hatch grids (4 is coarser). Noise: finer, film-like grain. None: hard posterised bands.", block: dither.el, modified: () => this.#current().state.dither !== this.#base().dither, reset: () => this.#change({ dither: this.#base().dither }, true) }),
      this.#row({ label: "Colour", help: "Accent: one accent colour plus off-white ink, the house look. Mono: ink only. Full: the picture's own colours, quantised per channel.", block: colour.el, modified: () => this.#current().state.color !== this.#base().color, reset: () => this.#change({ color: this.#base().color }, true) }),
      this.#row({ label: "Accent", help: "The single accent colour. The first swatch follows the scene's own default.", block: swatchRow, modified: () => this.#current().state.accent !== "", reset: () => this.#change({ accent: "" }, true) }),
      this.#row({ label: "Tones", help: "Shades per channel. 2 is pure on/off dots; more adds in-between shades and softens the look.", block: levels.el, readout: () => `${this.#current().state.levels}`, modified: () => this.#current().state.levels !== this.#base().levels, reset: () => this.#change({ levels: this.#base().levels }, true) }),
      this.#row({ label: "Dot size", help: "Size of one dot in screen pixels. Larger is chunkier and cheaper to draw.", block: pixel.el, readout: () => `${this.#current().state.pixel}px`, modified: () => this.#current().state.pixel !== this.#base().pixel, reset: () => this.#change({ pixel: this.#base().pixel }, true) }),
    ];
    this.#syncers.push(view.sync, dither.sync, colour.sync, levels.sync, pixel.sync, ...rows.map((row) => row.sync), () => {
      const { state } = this.#current();
      for (const swatch of swatches) swatch.setAttribute("aria-pressed", String(swatch.dataset.value === state.accent));
      for (const swatch of swatches) swatch.style.setProperty("--swatch", swatch.dataset.value || sceneAccent[state.scene]);
      if (document.activeElement !== custom) custom.value = accentOf(state);
    });
    const keys = ["view", "dither", "color", "accent", "levels", "pixel"] as const;
    return this.#section({
      id: "look",
      title: "Look",
      blurb: "How the picture becomes dots: pattern, palette and resolution.",
      open: false,
      content: rows.map((row) => row.el),
      summary: () => {
        const { state } = this.#current();
        return [DITHER_LABEL[state.dither], COLOR_LABEL[state.color], `${state.pixel}px`, state.view !== "dithered" ? VIEW_LABEL[state.view] : ""].filter(Boolean);
      },
      modified: () => keys.some((key) => this.#current().state[key] !== this.#base()[key]),
      reset: () => this.#change(Object.fromEntries(keys.map((key) => [key, this.#base()[key]])), true),
      syncers: this.#syncers,
    });
  }

  #motionSection(): HTMLElement {
    const motion = this.#slider("Motion", 0, 1, 0.05, () => this.#current().state.motion, (value, commit) => this.#change({ motion: value }, commit));
    const follow = this.#switch("Follow mouse", () => this.#current().state.mouse === "follow", (on) => this.#change({ mouse: on ? "follow" : "still" }, true));
    const play = h("button", { type: "button", class: "text-button wide" });
    play.addEventListener("click", () => {
      const renderer = this.#host.renderer();
      renderer?.setPaused(!renderer.paused);
      this.sync();
    });
    const rows = [
      this.#row({ label: "Amount", help: "Overall animation. 0 is a still frame; triggered events still play.", block: motion.el, readout: () => (this.#current().state.motion === 0 ? "still" : `${Math.round(this.#current().state.motion * 100)}%`), modified: () => this.#current().state.motion !== this.#base().motion, reset: () => this.#change({ motion: this.#base().motion }, true) }),
      this.#row({ label: "Follow mouse", help: "Tilt and parallax the scene gently toward the pointer.", inline: [follow.el], modified: () => this.#current().state.mouse !== this.#base().mouse, reset: () => this.#change({ mouse: this.#base().mouse }, true) }),
      this.#row({ label: "Clock", help: "Freeze time to study a frame (p). Unlike motion 0, a paused frame keeps its current pose.", block: play }),
    ];
    this.#syncers.push(motion.sync, follow.sync, ...rows.map((row) => row.sync), () => {
      const paused = this.#host.renderer()?.paused ?? false;
      play.replaceChildren(icon(paused ? "play" : "pause"), h("span", {}, paused ? "Play" : "Pause"));
    });
    return this.#section({
      id: "motion",
      title: "Motion",
      blurb: "How much things move, and whether the scene follows you.",
      open: false,
      content: rows.map((row) => row.el),
      summary: () => {
        const { state } = this.#current();
        return [this.#host.renderer()?.paused ? "paused" : state.motion === 0 ? "still" : `${Math.round(state.motion * 100)}%`, state.mouse === "follow" ? "follows mouse" : "fixed camera"];
      },
      modified: () => this.#current().state.motion !== this.#base().motion || this.#current().state.mouse !== this.#base().mouse,
      reset: () => this.#change({ motion: this.#base().motion, mouse: this.#base().mouse }, true),
      syncers: this.#syncers,
    });
  }

  #presetsSection(): HTMLElement {
    const list = h("ul", { class: "presets" });
    const name = h("input", { type: "text", placeholder: "Name this setup", maxLength: 60, "aria-label": "Preset name" });
    const save = h("button", { type: "submit", class: "text-button" }, h("span", {}, "Save"));
    const form = h("form", { class: "save-row" }, name, save);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const { state } = this.#current();
      const preset: Preset = {
        name: name.value.trim() || `${sceneInfo[state.scene].title} · ${new Date().toLocaleString()}`,
        commit: this.#host.build || "working-tree",
        query: this.#query(),
        savedAt: new Date().toISOString().slice(0, 10),
      };
      saveLocalPresets([...loadLocalPresets(), preset]);
      name.value = "";
      this.sync();
    });

    const importBox = h("textarea", { rows: 4, placeholder: "Paste exported JSON here", "aria-label": "Presets to import" });
    const importAdd = h("button", { type: "button", class: "text-button" }, h("span", {}, "Add to this browser"));
    let importing = false;
    const importReveal = reveal(h("div", { class: "import" }, importBox, importAdd), () => importing);
    importAdd.addEventListener("click", () => {
      try {
        saveLocalPresets([...loadLocalPresets(), ...parsePresets(importBox.value)]);
        importBox.value = "";
        importing = false;
        this.sync();
      } catch (error: unknown) {
        this.#flash(importAdd, error instanceof Error ? error.message : "could not read that");
      }
    });
    const exportButton = this.#textButton("external", "Export", "Copy this browser's saved setups as JSON, with the commit each was made on", (button) => {
      const text = JSON.stringify(loadLocalPresets(), null, 2);
      navigator.clipboard.writeText(text).then(() => this.#flash(button, "Copied"), () => this.#flash(button, "Copy failed"));
    });
    const importButton = this.#textButton("redo", "Import", "Add setups exported from another browser", () => {
      importing = !importing;
      importReveal.sync();
    });

    const renderList = () => {
      const current = this.#query();
      const entries: { preset: Preset; local: number | undefined }[] = [
        ...presets.map((preset) => ({ preset, local: undefined })),
        ...loadLocalPresets().map((preset, index) => ({ preset, local: index })),
      ];
      list.replaceChildren(...entries.map(({ preset, local }) => {
        const scene = new URLSearchParams(preset.query).get("scene") ?? "wave";
        const main = h("button", { type: "button", class: "preset-main", title: "Load these settings on this build" },
          h("span", { class: "preset-name" }, preset.name),
          h("span", { class: "preset-meta" }, `${scene} · ${local === undefined ? "baseline" : "saved here"} · @${preset.commit}`),
        );
        main.addEventListener("click", () => {
          this.#host.apply(new URLSearchParams(preset.query));
          this.commit();
        });
        const original = h("a", { class: "icon-button", href: `${location.origin}/@${preset.commit}/${preset.query ? `?${preset.query}` : ""}`, title: "Open exactly as it was, on the build it was made with" }, icon("external"));
        const remove = local === undefined ? null : this.#iconButton("trash", "Delete this saved setup", () => {
          saveLocalPresets(loadLocalPresets().filter((_, index) => index !== local));
          this.sync();
        });
        return h("li", { class: `preset${preset.query === current ? " active" : ""}` }, main, original, remove);
      }));
    };
    this.#syncers.push(renderList, importReveal.sync);
    return this.#section({
      id: "presets",
      title: "Presets",
      blurb: "Saved setups. Click one to load it here; the arrow opens it on the exact build it was tuned on.",
      open: false,
      content: [list, form, h("div", { class: "lab-actions" }, exportButton, importButton), importReveal.el],
      summary: () => [`${presets.length + loadLocalPresets().length} saved`],
      syncers: this.#syncers,
    });
  }

  #keysSection(): HTMLElement {
    const table = h("dl", { class: "keys" }, ...SHORTCUTS.flatMap(([key, what]) => [h("dt", {}, h("kbd", {}, key)), h("dd", {}, what)]));
    return this.#section({
      id: "keys",
      title: "Shortcuts",
      blurb: "Keyboard shortcuts work anywhere on the page, outside text fields.",
      open: false,
      content: [table],
      summary: () => [],
      syncers: this.#syncers,
    });
  }

  // ---- scene sections -------------------------------------------------------------------------

  #setScene(scene: SceneId): void {
    const { state } = this.#current();
    if (scene === state.scene) return;
    this.#host.apply(serialise(carryLook(state, scene), paramDefaults(scene)));
    this.commit();
  }

  #buildScene(scene: SceneId): void {
    this.#builtScene = scene;
    this.#sceneSyncers = [];
    const groups = new Map<string, ParamDef[]>();
    for (const def of sceneParams[scene]) groups.set(def.group, [...(groups.get(def.group) ?? []), def]);
    let first = true;
    const sections = [...groups.entries()].map(([group, defs]) => {
      const section = this.#groupSection(scene, group, defs, first);
      first = false;
      return section;
    });
    this.#sceneSlot.replaceChildren(...sections);
  }

  /** The knob a group hinges on: its first switch, when every other knob depends on it. */
  #masterOf(defs: readonly ParamDef[]): ParamDef | undefined {
    const [head, ...rest] = defs;
    if (!head || (head.kind !== "toggle" && head.kind !== "feature") || rest.length === 0) return undefined;
    return rest.every((def) => def.when === head.key) ? head : undefined;
  }

  #groupSection(scene: SceneId, group: string, defs: readonly ParamDef[], open: boolean): HTMLElement {
    const info = groupInfo[scene][group] ?? { title: group, blurb: "" };
    const master = this.#masterOf(defs);
    const fallback = paramDefaults(scene);
    const keysOf = (def: ParamDef) => (def.kind === "feature" ? [def.key, `${def.key}-amount`] : [def.key]);
    const keys = defs.flatMap(keysOf);
    const syncers = this.#sceneSyncers;
    const rows = defs.filter((def) => def !== master || def.kind === "feature").map((def) => this.#paramRow(def, def === master, fallback, syncers));
    const masterSwitch = master
      ? this.#switch(master.label, () => this.#on(master.key), (on) => {
        if (on) {
          this.#prefs.sections[`${scene}:${group}`] = true;
          this.#savePrefs();
        }
        this.#change({ [master.key]: on ? 1 : 0 }, true);
      })
      : undefined;
    return this.#section({
      id: `${scene}:${group}`,
      title: info.title,
      blurb: info.blurb,
      open,
      content: rows,
      summary: () => this.#groupSummary(defs, master, fallback),
      ...(masterSwitch ? { master: masterSwitch } : {}),
      ...(master ? { masterOn: () => this.#on(master.key), offNote: `Switch on to shape the ${info.title.toLowerCase()}.` } : {}),
      modified: () => keys.some((key) => this.#current().params[key] !== fallback[key]),
      reset: () => this.#change(Object.fromEntries(keys.map((key) => [key, fallback[key] ?? 0])), true),
      syncers,
    });
  }

  #groupSummary(defs: readonly ParamDef[], master: ParamDef | undefined, fallback: Params): string[] {
    if (master && !this.#on(master.key)) return ["off"];
    const params = this.#current().params;
    const chips: string[] = [];
    for (const def of defs) {
      if (def === master && def.kind !== "feature") continue;
      if (def.when !== undefined && !this.#on(def.when)) continue;
      const value = params[def.key] ?? 0;
      switch (def.kind) {
        case "toggle":
          if (value > 0.5) chips.push(def.label);
          break;
        case "feature":
          if (value > 0.5) chips.push(def.options ? `${params[`${def.key}-amount`] ?? def.value} ${def.label}` : def.label);
          break;
        case "choice":
          if (master || value !== fallback[def.key]) {
            const chosen = def.options.find((option) => option.value === value)?.label ?? "";
            chips.push(/^\d+$/.test(chosen) ? `${chosen} ${def.label}` : chosen);
          }
          break;
        case "range":
        case "seed":
          if (value !== fallback[def.key]) chips.push(`${def.label} ${formatValue(def, value)}`);
          break;
        default: {
          const unreachable: never = def;
          throw new Error(`landing: unknown knob ${String(unreachable)}`);
        }
      }
    }
    if (master && chips.length === 0) chips.push("on");
    return chips.filter(Boolean);
  }

  #paramRow(def: ParamDef, isMaster: boolean, fallback: Params, syncers: (() => void)[]): HTMLElement {
    const params = () => this.#current().params;
    const value = (key: string) => params()[key] ?? fallback[key] ?? 0;
    const setKey = (key: string) => (next: number | string, commit = true) => this.#change({ [key]: next }, commit);
    const modifiedKeys = def.kind === "feature" ? [def.key, `${def.key}-amount`] : [def.key];
    const modified = () => modifiedKeys.some((key) => value(key) !== fallback[key]);
    const reset = () => this.#change(Object.fromEntries(modifiedKeys.map((key) => [key, fallback[key] ?? 0])), true);
    const options = (list: readonly Option[]) => list.map((option) => ({ label: option.label, value: String(option.value) }));
    let built: Built;

    switch (def.kind) {
      case "range": {
        const slider = this.#slider(def.label, def.min, def.max, def.step, () => value(def.key), (next, commit) => setKey(def.key)(next, commit));
        built = this.#row({ label: def.label, help: def.help, block: slider.el, readout: () => formatValue(def, value(def.key)), modified, reset });
        syncers.push(slider.sync);
        break;
      }
      case "toggle": {
        const toggle = this.#switch(def.label, () => value(def.key) > 0.5, (on) => setKey(def.key)(on ? 1 : 0));
        built = this.#row({ label: def.label, help: def.help, inline: [toggle.el], modified, reset });
        syncers.push(toggle.sync);
        break;
      }
      case "choice": {
        const segments = this.#segments(def.label, options(def.options), () => String(value(def.key)), (next) => setKey(def.key)(Number(next)));
        built = this.#row({ label: def.label, help: def.help, block: segments.el, modified, reset });
        syncers.push(segments.sync);
        break;
      }
      case "seed": {
        const reseed = h("button", { type: "button", class: "fire", title: "Pick another arrangement" }, icon("dice"), h("span", {}, "re-seed"));
        reseed.addEventListener("click", () => {
          let next = Math.floor(Math.random() * (MAX_SEED + 1));
          if (next === value(def.key)) next = (next + 1) % (MAX_SEED + 1);
          setKey(def.key)(next);
        });
        built = this.#row({ label: def.label, help: def.help, inline: [reseed], readout: () => formatValue(def, value(def.key)), modified, reset });
        break;
      }
      case "feature": {
        const amountKey = `${def.key}-amount`;
        const amount = def.options
          ? this.#segments(def.amountLabel, options(def.options), () => String(value(amountKey)), (next) => setKey(amountKey)(Number(next)))
          : this.#slider(def.amountLabel, def.min, def.max, def.step, () => value(amountKey), (next, commit) => setKey(amountKey)(next, commit));
        // A master feature's row is already titled by its amount, so the amount needs no second label.
        const amountRow = h("div", { class: `amount${isMaster ? " bare" : ""}` }, isMaster ? null : h("span", { class: "amount-label" }, def.amountLabel), amount.el);
        const amountReadout = h("span", { class: "readout" });
        if (!def.options) amountRow.append(amountReadout);
        const amountReveal = reveal(amountRow, () => value(def.key) > 0.5);
        const inline: HTMLElement[] = [];
        if (def.trigger !== undefined) {
          const slot = def.trigger;
          const fire = h("button", { type: "button", class: "fire", title: `Show one ${def.label} right now, even while it is switched off` }, icon("bolt"), h("span", {}, "now"));
          fire.addEventListener("click", () => this.#host.renderer()?.trigger(slot));
          inline.push(fire);
        }
        const toggle = this.#switch(def.label, () => value(def.key) > 0.5, (on) => setKey(def.key)(on ? 1 : 0));
        if (!isMaster) inline.push(toggle.el);
        built = this.#row({ label: isMaster ? def.amountLabel : def.label, help: def.help, inline, block: amountReveal.el, modified, reset });
        if (isMaster) amountReveal.el.classList.add("always");
        syncers.push(amount.sync, toggle.sync, amountReveal.sync, () => { amountReadout.textContent = formatValue(def, value(amountKey)); });
        break;
      }
      default: {
        const unreachable: never = def;
        throw new Error(`landing: unknown knob ${String(unreachable)}`);
      }
    }
    syncers.push(built.sync);
    if (def.when === undefined) return built.el;
    const dependent = reveal(built.el, () => this.#on(def.when));
    syncers.push(dependent.sync);
    return dependent.el;
  }

  // ---- actions --------------------------------------------------------------------------------

  #shuffle(): void {
    const { state } = this.#current();
    const patch: Patch = {};
    const pickOne = <T>(list: readonly T[]): T | undefined => list[Math.floor(Math.random() * list.length)];
    const within = (min: number, max: number, step: number) => Math.round((min + Math.random() * (max - min)) / step) * step;
    for (const def of sceneParams[state.scene]) {
      if (def.steady) continue;
      switch (def.kind) {
        case "range":
          patch[def.key] = Number(within(def.min, def.max, def.step).toFixed(4));
          break;
        case "toggle":
          patch[def.key] = Math.random() < 0.45 ? 1 : 0;
          break;
        case "choice":
          patch[def.key] = pickOne(def.options)?.value ?? def.value;
          break;
        case "seed":
          patch[def.key] = Math.floor(Math.random() * (MAX_SEED + 1));
          break;
        case "feature":
          patch[def.key] = Math.random() < 0.55 ? 1 : 0;
          patch[`${def.key}-amount`] = def.options ? pickOne(def.options)?.value ?? def.value : Number(within(def.min, def.max, def.step).toFixed(4));
          break;
        default: {
          const unreachable: never = def;
          throw new Error(`landing: unknown knob ${String(unreachable)}`);
        }
      }
    }
    this.#change(patch, true);
  }

  #copyLink(button: HTMLButtonElement): void {
    const query = this.#query();
    const url = this.#host.build ? `${location.origin}/@${this.#host.build}/${query ? `?${query}` : ""}` : location.href;
    navigator.clipboard.writeText(url).then(() => this.#flash(button, "Copied"), () => this.#flash(button, "Copy failed"));
  }

  #filter(): void {
    const text = this.#search.value.trim().toLowerCase();
    const searching = text.length > 0;
    this.#root.classList.toggle("searching", searching);
    let any = false;
    for (const section of this.#root.querySelectorAll<HTMLElement>("section.sec")) {
      let matches = 0;
      for (const row of section.querySelectorAll<HTMLElement>("[data-search]")) {
        const hit = !searching || (row.dataset.search ?? "").includes(text);
        row.classList.toggle("no-match", !hit);
        if (hit) matches++;
      }
      const titleHit = searching && (section.querySelector(".sec-title")?.textContent ?? "").toLowerCase().includes(text);
      const visible = !searching || matches > 0 || titleHit;
      section.hidden = !visible;
      if (titleHit) for (const row of section.querySelectorAll<HTMLElement>("[data-search]")) row.classList.remove("no-match");
      section.classList.toggle("searching", searching && visible);
      if (visible) any = true;
    }
    const empty = this.#root.querySelector<HTMLElement>(".lab-empty");
    if (empty) empty.hidden = any;
    if (searching) for (const sync of [...this.#syncers, ...this.#sceneSyncers]) sync();
  }

  #startResize(event: PointerEvent): void {
    event.preventDefault();
    const move = (moveEvent: PointerEvent) => {
      this.#prefs.width = Math.min(560, Math.max(290, moveEvent.clientX));
      document.documentElement.style.setProperty("--lab-width", `${this.#prefs.width}px`);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.classList.remove("resizing");
      this.#savePrefs();
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }
}
