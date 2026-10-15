// The lab sidebar. Built entirely from the scene catalogue and knob definitions: every change goes
// through the host as a URL query, so links, presets and undo all share one representation. Its
// session tools, an A/B comparison (compare.ts) and a scene tour (tour.ts), sit beside the setup
// in the URL (`sessionQuery`) and never inside it.
import {
  otherSlot,
  readComparison,
  setupDifferences,
  slots,
  TapOrHold,
  writeComparison,
  type Comparison,
  type Slot,
} from "./compare.ts";
import { formatValue, MAX_SEED, type Option, type ParamDef } from "./params.ts";
import {
  loadLocalPresets,
  parsePresets,
  presets,
  saveLocalPresets,
  type Preset,
} from "./presets.ts";
import {
  colorIds,
  ditherIds,
  viewIds,
  type DitherRenderer,
  type SceneFailure,
} from "./renderer.ts";
import { sceneDefs, sceneIds, type SceneId } from "./scenes/index.ts";
import {
  accentOf,
  carryLook,
  defaults,
  defaultsFor,
  modeIds,
  paramDefaults,
  readState,
  serialise,
  type LabState,
  type Params,
} from "./state.ts";
import { clampDwell, readTour, TOUR_DWELL, TourPlayer, writeTour, type TourStep } from "./tour.ts";

export interface LabHost {
  current(): { state: LabState; params: Params };
  /**
   * Replace the whole setup. The host re-renders, then calls `Lab.sync()`. `cut`: switch scenes at
   * once, without the passage (an A/B flip).
   */
  apply(query: URLSearchParams, options?: { cut?: boolean }): void;
  renderer(): DitherRenderer | undefined;
  /** Commit the page was built from; empty for a working tree. */
  build: string;
}

type Patch = Record<string, string | number>;
type Child = Node | string | false | null | undefined;

/** Element factory: attributes for data-/aria-/role, properties otherwise. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === "class") el.className = String(value);
    else if (key.startsWith("data-") || key.startsWith("aria-") || key === "role")
      el.setAttribute(key, String(value));
    else (el as unknown as Record<string, unknown>)[key] = value;
  }
  for (const child of children)
    if (child !== false && child !== null && child !== undefined) el.append(child);
  return el;
}

const ICONS = {
  chevron: "M6 4l4 4-4 4",
  close: "M10 3 5 8l5 5",
  undo: "M5 6H10a3 3 0 0 1 0 6H6M5 6l3-3M5 6l3 3",
  redo: "M11 6H6a3 3 0 0 0 0 6h4M11 6 8 3M11 6 8 9",
  help: "M6 6a2 2 0 1 1 3 1.7c-.6.4-1 .8-1 1.6M8 11.5v.5",
  search: "M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM11 11l3 3",
  shuffle:
    "M2 4h3l6 8h3M2 12h3l2-2.6M10 5.6 11 4h3M12.5 2.5 14 4l-1.5 1.5M12.5 10.5 14 12l-1.5 1.5",
  reset: "M3 8a5 5 0 1 0 1.5-3.5M3 2.5V5h2.5",
  link: "M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5L8 4.5M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l1-1",
  play: "M5 3.5v9l7-4.5z",
  pause: "M5 3.5v9M11 3.5v9",
  external: "M9 3h4v4M13 3 7 9M11 9.5V13H3V5h3.5",
  dice: "M3 3h10v10H3zM6 6h.01M10 6h.01M8 8h.01M6 10h.01M10 10h.01",
  bolt: "M9 2 4 9h4l-1 5 5-7H8z",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5",
  previous: "M11 4 6 8l5 4M4.5 4v8",
  next: "M5 4l5 4-5 4M11.5 4v8",
  up: "M8 13V3M4 7l4-4 4 4",
  down: "M8 3v10M4 9l4 4 4-4",
  plus: "M8 3v10M3 8h10",
  cross: "M4 4l8 8M12 4l-8 8",
  compare: "M2 3h5v10H2zM9 3h5v10H9z",
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

const MODE_LABEL: Record<(typeof modeIds)[number], string> = {
  landing: "Landing",
  loading: "Loading",
  instance: "Sign-in",
  bare: "None",
};
const VIEW_LABEL: Record<(typeof viewIds)[number], string> = {
  dithered: "Dithered",
  source: "Source",
  split: "Split",
};
const DITHER_LABEL: Record<(typeof ditherIds)[number], string> = {
  bayer8: "Bayer 8",
  bayer4: "Bayer 4",
  ign: "Noise",
  none: "None",
};
const COLOR_LABEL: Record<(typeof colorIds)[number], string> = {
  accent: "Accent",
  mono: "Mono",
  full: "Full",
};
const FAILURE_LABEL: Record<SceneFailure["stage"], string> = {
  build: "its shader did not build",
  start: "its simulation did not start",
  frame: "it stopped while drawing",
};
const SWATCHES = ["#4c6ef5", "#ff004e", "#ff7a2f", "#f2c94c", "#2bd9a8", "#e8e6df"] as const;
/** The lab's own settings as an A/B comparison names them. */
const SETTING_LABEL: Record<keyof LabState, string> = {
  scene: "scene",
  mode: "page on top",
  dither: "dither",
  color: "colour",
  pixel: "dot size",
  levels: "tones",
  motion: "motion",
  accent: "accent",
  instance: "instance name",
  mouse: "follow mouse",
  view: "view",
  dim: "dim",
  blur: "blur",
  transitions: "transitions",
};

const SHORTCUTS: readonly (readonly [string, string])[] = [
  ["[  ]", "previous / next scene (tour step while a tour plays)"],
  ["l", "show or hide the lab"],
  ["/", "find a control"],
  ["h", "hide the page on top"],
  ["p", "pause or play"],
  ["b", "flip between A and B; hold to peek"],
  ["t", "play or pause the tour"],
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
      width:
        typeof record.width === "number"
          ? Math.min(560, Math.max(290, record.width))
          : fallback.width,
      explain: record.explain === true,
      sections:
        typeof record.sections === "object" && record.sections !== null ? record.sections : {},
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

/** One slot's undo history: setups (minimal queries) before and after the committed one. */
interface History {
  undo: string[];
  redo: string[];
  committed: string;
}

/** Make `query` the history's committed setup, the old one an undo step; false when unchanged. */
function record(history: History, query: string): boolean {
  if (query === history.committed) return false;
  history.undo.push(history.committed);
  if (history.undo.length > 100) history.undo.shift();
  history.redo.length = 0;
  history.committed = query;
  return true;
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
  /** The undo history of the setup on screen (with a comparison, the live slot's). */
  #history: History;
  /** An A/B comparison, and the hidden slot's own undo history once it has been on screen. */
  #comparison: Comparison | undefined;
  #hiddenHistory: History | undefined;
  readonly #flip = new TapOrHold();
  /** Shows which slot is on screen, over the page, while comparing; a click flips. */
  readonly #badge = h("button", {
    type: "button",
    class: "ab-badge",
    hidden: true,
    title: "Flip between A and B (b; hold to peek)",
    "aria-live": "polite",
  });
  /** A scene tour, and its clock's pending frame and last frame time while it plays. */
  #tour: TourPlayer | undefined;
  #tourFrame: number | undefined;
  #tourLast: number | undefined;
  /** Seconds per tour step without its own (the tour's, kept while no tour is set). */
  #tourDwell: number = TOUR_DWELL.fallback;
  readonly #tourStatus = h("p", { class: "tour-status" });
  readonly #tourProgress = h("progress", { max: 1, value: 0, "aria-label": "Time on this scene" });
  readonly #reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  readonly #search: HTMLInputElement;
  readonly #undoButton: HTMLButtonElement;
  readonly #redoButton: HTMLButtonElement;
  readonly #sceneLabel = h("span", { class: "lab-scene" });
  readonly #status = h("div", { class: "lab-status" });
  readonly #failure: Built;

  constructor(root: HTMLElement, opener: HTMLButtonElement, host: LabHost) {
    this.#root = root;
    this.#opener = opener;
    this.#host = host;
    this.#history = { undo: [], redo: [], committed: this.#query() };
    // The page's query as opened (main.ts applies it after building the lab): a shared comparison
    // or tour comes back with it.
    const opened = new URLSearchParams(location.search);
    this.#comparison = readComparison(opened);
    const tour = readTour(opened);
    if (tour) {
      this.#tour = new TourPlayer(tour, false);
      this.#tourDwell = tour.dwell;
      // Once the page has applied its setup. Under reduced motion it shows the tour's scene and waits for play.
      queueMicrotask(() => this.#beginTour(!this.#reducedMotion));
    }
    this.#badge.addEventListener("click", () => {
      if (this.#comparison) this.#showSlot(otherSlot(this.#comparison.live));
    });
    document.body.append(this.#badge);
    document.documentElement.style.setProperty("--lab-width", `${this.#prefs.width}px`);
    root.classList.toggle("explain", this.#prefs.explain);

    this.#search = h("input", {
      type: "search",
      placeholder: "Find a control…",
      "aria-label": "Find a control",
      spellcheck: false,
    });
    this.#search.addEventListener("input", () => this.#filter());
    this.#search.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.#search.value = "";
        this.#filter();
        this.#search.blur();
      }
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

    const header = h(
      "header",
      { class: "lab-header" },
      h(
        "div",
        { class: "lab-bar" },
        h("span", { class: "lab-name" }, "Lab"),
        this.#sceneLabel,
        h("span", { class: "spacer" }),
        this.#undoButton,
        this.#redoButton,
        explain,
        this.#iconButton("close", "Hide the lab (l)", () => this.setOpen(false)),
      ),
      h("label", { class: "lab-search" }, icon("search"), this.#search),
    );

    const body = h(
      "div",
      { class: "lab-body" },
      this.#sceneSection(),
      this.#sceneSlot,
      this.#lookSection(),
      this.#motionSection(),
      this.#presetsSection(),
      this.#compareSection(),
      this.#tourSection(),
      this.#keysSection(),
      h("p", { class: "lab-empty" }, "Nothing matches. Try another word, or press Esc."),
    );

    this.#failure = this.#failureAlert();
    const footer = h(
      "footer",
      { class: "lab-footer" },
      this.#failure.el,
      h(
        "div",
        { class: "lab-actions" },
        this.#textButton(
          "shuffle",
          "Shuffle",
          "Randomise this scene's knobs (camera stays put)",
          () => this.#shuffle(),
        ),
        this.#textButton("reset", "Reset", "Back to this scene's defaults", () =>
          this.#change(Object.fromEntries([["scene", this.#current().state.scene]]), true, true),
        ),
        this.#textButton(
          "link",
          "Copy link",
          "Copy a link that replays this exact setup on this build, with its A/B comparison and tour",
          (button) => this.#copyLink(button),
        ),
      ),
      this.#status,
    );

    const resize = h("div", {
      class: "lab-resize",
      role: "separator",
      "aria-orientation": "vertical",
      title: "Drag to resize",
    });
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
    // Knob changes are likely while the lab is open: scenes with knob-keyed features get their
    // all-features program built ahead (DitherRenderer.expectChanges).
    this.#host.renderer()?.expectChanges(open);
  }

  focusSearch(): void {
    this.setOpen(true);
    this.#search.focus();
    this.#search.select();
  }

  /** Reflect the host's current state into every control. */
  sync(): void {
    const { state } = this.#current();
    // A step of the tour (its own switch or the user's) becomes the current one; another scene holds it.
    this.#tour?.follow(state.scene);
    if (this.#builtScene !== state.scene) this.#buildScene(state.scene);
    this.#sceneLabel.textContent = sceneDefs[state.scene].title;
    for (const sync of this.#syncers) sync();
    for (const sync of this.#sceneSyncers) sync();
    this.#filter();
    this.#syncHistory();
  }

  /** Record the current setup as one undo step (sliders commit on release). */
  commit(): void {
    if (record(this.#history, this.#query())) this.#syncHistory();
  }

  undo(): void {
    const history = this.#history;
    const previous = history.undo.pop();
    if (previous === undefined) return;
    history.redo.push(history.committed);
    history.committed = previous;
    this.#host.apply(new URLSearchParams(previous));
  }

  redo(): void {
    const history = this.#history;
    const next = history.redo.pop();
    if (next === undefined) return;
    history.undo.push(history.committed);
    history.committed = next;
    this.#host.apply(new URLSearchParams(next));
  }

  /** The session tools' URL keys (comparison, tour), for the host to write beside the setup. */
  sessionQuery(): URLSearchParams {
    const query = new URLSearchParams();
    if (this.#comparison) writeComparison(this.#comparison, query);
    if (this.#tour) writeTour(this.#tour.tour, query);
    return query;
  }

  /** The compare key went down (`event.timeStamp`): flip to the other slot; a tap keeps it. */
  pressCompare(now: number): void {
    const comparison = this.#comparison;
    if (!comparison) return;
    this.#flip.press(now);
    this.#showSlot(otherSlot(comparison.live));
  }

  /** The compare key came up: after a hold, flip back. */
  releaseCompare(now: number): void {
    const comparison = this.#comparison;
    if (this.#flip.release(now) && comparison) this.#showSlot(otherSlot(comparison.live));
  }

  /** Play or pause the tour; nothing without one. */
  toggleTour(): void {
    const tour = this.#tour;
    if (!tour) return;
    if (!tour.playing) {
      this.#beginTour(true);
      return;
    }
    tour.playing = false;
    this.sync();
  }

  /** While a tour plays, go to its previous or next step and return true; otherwise false. */
  skipTour(by: number): boolean {
    if (!this.#tour?.playing) return false;
    this.#stepTour(by);
    return true;
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
    this.#undoButton.disabled = this.#history.undo.length === 0;
    this.#redoButton.disabled = this.#history.redo.length === 0;
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
    this.#failure.sync();
  }

  /** Shown while the scene on screen has failed (polled with the status): what broke, a retry, and a way on. */
  #failureAlert(): Built {
    const what = h("p");
    const detail = h("p", { class: "lab-failure-detail" });
    const retry = this.#textButton("reset", "Retry", "Build this scene again from scratch", () => {
      this.#host.renderer()?.retry();
      el.hidden = true;
    });
    const next = this.#textButton("chevron", "Next scene", "Go on to the next scene", () => {
      const { state } = this.#current();
      this.#setScene(
        sceneIds[(sceneIds.indexOf(state.scene) + 1) % sceneIds.length] ?? state.scene,
      );
      el.hidden = true;
    });
    const el = h(
      "div",
      { class: "lab-failure", role: "alert", hidden: true },
      what,
      detail,
      h("div", { class: "lab-actions" }, retry, next),
    );
    return {
      el,
      sync: () => {
        const failure = this.#host.renderer()?.failure;
        el.hidden = failure === undefined;
        if (failure === undefined) return;
        what.textContent = `${sceneDefs[failure.scene].title}: ${FAILURE_LABEL[failure.stage]}.`;
        detail.textContent = failure.message.split("\n")[0] ?? "";
        el.title = `${failure.message}\n\nThe console has the full error (evt=landing.renderer.scene_failed).`;
      },
    };
  }

  // ---- primitives -----------------------------------------------------------------------------

  #iconButton(name: keyof typeof ICONS, title: string, onClick: () => void): HTMLButtonElement {
    const button = h(
      "button",
      { type: "button", class: "icon-button", title, "aria-label": title },
      icon(name),
    );
    button.addEventListener("click", onClick);
    return button;
  }

  #textButton(
    name: keyof typeof ICONS,
    text: string,
    title: string,
    onClick: (button: HTMLButtonElement) => void,
  ): HTMLButtonElement {
    const button = h(
      "button",
      { type: "button", class: "text-button", title },
      icon(name),
      h("span", {}, text),
    );
    button.addEventListener("click", () => onClick(button));
    return button;
  }

  #flash(button: HTMLButtonElement, text: string): void {
    const label = button.querySelector("span");
    if (!label) return;
    const original = label.dataset.text ?? label.textContent ?? "";
    label.dataset.text = original;
    label.textContent = text;
    setTimeout(() => {
      label.textContent = original;
    }, 1500);
  }

  #switch(label: string, get: () => boolean, set: (on: boolean) => void): Built {
    const el = h(
      "button",
      { type: "button", role: "switch", class: "switch", "aria-label": label },
      h("span", { class: "knob" }),
    );
    el.addEventListener("click", () => set(!get()));
    return { el, sync: () => el.setAttribute("aria-checked", String(get())) };
  }

  #slider(
    label: string,
    min: number,
    max: number,
    step: number,
    get: () => number,
    set: (value: number, commit: boolean) => void,
  ): Built {
    const el = h("input", {
      type: "range",
      min: String(min),
      max: String(max),
      step: String(step),
      "aria-label": label,
    });
    el.addEventListener("input", () => set(Number(el.value), false));
    const sync = () => {
      if (document.activeElement !== el) el.value = String(get());
      el.style.setProperty("--fill", `${((get() - min) / (max - min)) * 100}%`);
    };
    return { el, sync };
  }

  #segments(
    label: string,
    options: readonly { label: string; value: string }[],
    get: () => string,
    set: (value: string) => void,
  ): Built {
    const buttons = options.map((option) => {
      const button = h("button", { type: "button", "data-value": option.value }, option.label);
      button.addEventListener("click", () => set(option.value));
      return button;
    });
    const el = h("div", { class: "segments", role: "group", "aria-label": label }, ...buttons);
    // Let long choices wrap into rows instead of truncating their names in the sidebar.
    const width =
      options.reduce((longest, option) => Math.max(longest, option.label.length), 0) + 2;
    el.style.setProperty("--option-width", `${width}ch`);
    return {
      el,
      sync: () => {
        for (const button of buttons)
          button.setAttribute("aria-pressed", String(button.dataset.value === get()));
      },
    };
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
    const hintToggle = h(
      "button",
      {
        type: "button",
        class: "hint-toggle",
        title: "What is this?",
        "aria-label": `About ${spec.label}`,
        "aria-expanded": "false",
      },
      "?",
    );
    hintToggle.addEventListener("click", () => {
      const open = hintToggle.getAttribute("aria-expanded") !== "true";
      hintToggle.setAttribute("aria-expanded", String(open));
      el.classList.toggle("hint-open", open);
    });
    const dot = h("button", {
      type: "button",
      class: "modified",
      title: "Changed — click to reset",
      "aria-label": `Reset ${spec.label}`,
    });
    if (spec.reset) dot.addEventListener("click", spec.reset);
    const readout = h("span", { class: "readout" });
    const el = h(
      "div",
      { class: "row", "data-search": `${spec.label} ${spec.help}`.toLowerCase() },
      h(
        "div",
        { class: "row-head" },
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
    if (spec.reset)
      el.addEventListener("dblclick", (event) => {
        if (event.target instanceof HTMLElement && event.target.closest(".row-label"))
          spec.reset?.();
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
    const toggle = h(
      "button",
      { type: "button", class: "sec-toggle" },
      icon("chevron"),
      h("span", { class: "sec-title" }, spec.title),
      chips,
    );
    const reset = h(
      "button",
      {
        type: "button",
        class: "sec-reset",
        title: `Reset ${spec.title.toLowerCase()} to defaults`,
      },
      "reset",
    );
    if (spec.reset) reset.addEventListener("click", spec.reset);
    const offNote = spec.offNote ? h("p", { class: "sec-off" }, spec.offNote) : null;
    const inner = h(
      "div",
      { class: "sec-body" },
      h("p", { class: "sec-blurb" }, spec.blurb),
      offNote,
      ...spec.content,
    );
    const body = h("div", { class: "reveal" }, h("div", { class: "reveal-inner" }, inner));
    const el = h(
      "section",
      { class: "sec", "data-id": spec.id },
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
      chips.replaceChildren(
        ...items.slice(0, 3).map((item) => h("span", { class: "chip" }, item)),
        items.length > 3 ? h("span", { class: "chip" }, `+${items.length - 3}`) : "",
      );
    };
    spec.syncers.push(sync);
    return el;
  }

  // ---- global sections ------------------------------------------------------------------------

  #sceneSection(): HTMLElement {
    const cards = sceneIds.map((id) => {
      const scene = sceneDefs[id];
      const card = h(
        "button",
        {
          type: "button",
          class: "scene-card",
          "data-scene": id,
          title: `${scene.title}: ${scene.blurb}`,
        },
        h("span", { class: "scene-dot" }),
        h("span", { class: "scene-title" }, scene.title),
        h("span", { class: "scene-blurb" }, scene.blurb),
      );
      card.style.setProperty("--dot", scene.accent);
      card.addEventListener("click", () => this.#setScene(id));
      return card;
    });
    const page = this.#segments(
      "Page on top",
      modeIds.map((id) => ({ label: MODE_LABEL[id], value: id })),
      () => this.#current().state.mode,
      (mode) => this.#change({ mode }, true),
    );
    const nameInput = h("input", {
      type: "text",
      maxLength: 40,
      spellcheck: false,
      "aria-label": "Instance name",
    });
    nameInput.addEventListener("input", () => this.#change({ instance: nameInput.value }, false));
    const nameRow = this.#row({
      label: "Instance name",
      help: "Shown on the sign-in card of a private instance.",
      block: nameInput,
    });
    const nameReveal = reveal(nameRow.el, () => this.#current().state.mode === "instance");
    const pageRow = this.#row({
      label: "Page on top",
      help: "Landing: the public introduction. Loading: what shows while the app boots. Sign-in: the face of a private instance. None: the scene alone (h toggles this).",
      block: page.el,
    });
    const grid = h(
      "div",
      {
        class: "scene-grid",
        "data-search": `scene picture ${sceneIds.map((id) => `${id} ${sceneDefs[id].title.toLowerCase()}`).join(" ")}`,
      },
      ...cards,
    );
    const dim = this.#slider(
      "Dim background",
      0,
      1,
      0.05,
      () => this.#current().state.dim,
      (value, commit) => this.#change({ dim: value }, commit),
    );
    const blur = this.#slider(
      "Blur background",
      0,
      1,
      0.05,
      () => this.#current().state.blur,
      (value, commit) => this.#change({ blur: value }, commit),
    );
    const dimRow = this.#row({
      label: "Dim background",
      help: "Darken the scene behind the page, to judge whether the copy needs help to stand out.",
      block: dim.el,
      readout: () => `${Math.round(this.#current().state.dim * 100)}%`,
      modified: () => this.#current().state.dim !== 0,
      reset: () => this.#change({ dim: 0 }, true),
    });
    const blurRow = this.#row({
      label: "Blur background",
      help: "Soften the scene behind the page so the copy is the only sharp thing on screen.",
      block: blur.el,
      readout: () => `${Math.round(this.#current().state.blur * 12)}px`,
      modified: () => this.#current().state.blur !== 0,
      reset: () => this.#change({ blur: 0 }, true),
    });
    this.#syncers.push(
      () => {
        const { state } = this.#current();
        for (const card of cards)
          card.setAttribute("aria-pressed", String(card.dataset.scene === state.scene));
        if (document.activeElement !== nameInput) nameInput.value = state.instance;
      },
      page.sync,
      pageRow.sync,
      nameRow.sync,
      nameReveal.sync,
      dim.sync,
      blur.sync,
      dimRow.sync,
      blurRow.sync,
    );
    return this.#section({
      id: "scene",
      title: "Scene",
      blurb: "Pick the picture, then what sits on top of it.",
      open: true,
      content: [grid, pageRow.el, nameReveal.el, dimRow.el, blurRow.el],
      summary: () => {
        const { state } = this.#current();
        return [
          sceneDefs[state.scene].title,
          MODE_LABEL[state.mode],
          state.dim > 0 ? `dim ${Math.round(state.dim * 100)}%` : "",
          state.blur > 0 ? "blurred" : "",
        ].filter(Boolean);
      },
      syncers: this.#syncers,
    });
  }

  #lookSection(): HTMLElement {
    const view = this.#segments(
      "View",
      viewIds.map((id) => ({ label: VIEW_LABEL[id], value: id })),
      () => this.#current().state.view,
      (value) => this.#change({ view: value }, true),
    );
    const dither = this.#segments(
      "Dither pattern",
      ditherIds.map((id) => ({ label: DITHER_LABEL[id], value: id })),
      () => this.#current().state.dither,
      (value) => this.#change({ dither: value }, true),
    );
    const colour = this.#segments(
      "Colour",
      colorIds.map((id) => ({ label: COLOR_LABEL[id], value: id })),
      () => this.#current().state.color,
      (value) => this.#change({ color: value }, true),
    );
    const levels = this.#slider(
      "Tones",
      2,
      6,
      1,
      () => this.#current().state.levels,
      (value, commit) => this.#change({ levels: value }, commit),
    );
    const pixel = this.#slider(
      "Dot size",
      1,
      8,
      1,
      () => this.#current().state.pixel,
      (value, commit) => this.#change({ pixel: value }, commit),
    );

    const swatches = [
      { value: "", label: "Scene default" },
      ...SWATCHES.map((value) => ({ value, label: value })),
    ].map((swatch) => {
      const button = h("button", {
        type: "button",
        class: "swatch",
        title: swatch.label,
        "aria-label": swatch.label,
        "data-value": swatch.value,
      });
      button.addEventListener("click", () => this.#change({ accent: swatch.value }, true));
      return button;
    });
    const custom = h("input", {
      type: "color",
      class: "swatch-custom",
      title: "Any colour",
      "aria-label": "Custom accent colour",
    });
    custom.addEventListener("input", () => this.#change({ accent: custom.value }, false));
    const swatchRow = h("div", { class: "swatches" }, ...swatches, custom);

    const rows = [
      this.#row({
        label: "View",
        help: "Dithered is the finished look. Source shows the picture before dithering; Split puts source on the left and dithered on the right, to see what the shader does.",
        block: view.el,
        modified: () => this.#current().state.view !== this.#base().view,
        reset: () => this.#change({ view: this.#base().view }, true),
      }),
      this.#row({
        label: "Dither pattern",
        help: "How tones turn into dots. Bayer 8 and 4: ordered cross-hatch grids (4 is coarser). Noise: finer, film-like grain. None: hard posterised bands.",
        block: dither.el,
        modified: () => this.#current().state.dither !== this.#base().dither,
        reset: () => this.#change({ dither: this.#base().dither }, true),
      }),
      this.#row({
        label: "Colour",
        help: "Accent: one accent colour plus off-white ink, the house look. Mono: ink only. Full: the picture's own colours, quantised per channel.",
        block: colour.el,
        modified: () => this.#current().state.color !== this.#base().color,
        reset: () => this.#change({ color: this.#base().color }, true),
      }),
      this.#row({
        label: "Accent",
        help: "The single accent colour. The first swatch follows the scene's own default.",
        block: swatchRow,
        modified: () => this.#current().state.accent !== "",
        reset: () => this.#change({ accent: "" }, true),
      }),
      this.#row({
        label: "Tones",
        help: "Shades per channel. 2 is pure on/off dots; more adds in-between shades and softens the look.",
        block: levels.el,
        readout: () => `${this.#current().state.levels}`,
        modified: () => this.#current().state.levels !== this.#base().levels,
        reset: () => this.#change({ levels: this.#base().levels }, true),
      }),
      this.#row({
        label: "Dot size",
        help: "Size of one dot in screen pixels. Larger is chunkier and cheaper to draw.",
        block: pixel.el,
        readout: () => `${this.#current().state.pixel}px`,
        modified: () => this.#current().state.pixel !== this.#base().pixel,
        reset: () => this.#change({ pixel: this.#base().pixel }, true),
      }),
    ];
    this.#syncers.push(
      view.sync,
      dither.sync,
      colour.sync,
      levels.sync,
      pixel.sync,
      ...rows.map((row) => row.sync),
      () => {
        const { state } = this.#current();
        for (const swatch of swatches)
          swatch.setAttribute("aria-pressed", String(swatch.dataset.value === state.accent));
        for (const swatch of swatches)
          swatch.style.setProperty(
            "--swatch",
            swatch.dataset.value || sceneDefs[state.scene].accent,
          );
        if (document.activeElement !== custom) custom.value = accentOf(state);
      },
    );
    const keys = ["view", "dither", "color", "accent", "levels", "pixel"] as const;
    return this.#section({
      id: "look",
      title: "Look",
      blurb: "How the picture becomes dots: pattern, palette and resolution.",
      open: false,
      content: rows.map((row) => row.el),
      summary: () => {
        const { state } = this.#current();
        return [
          DITHER_LABEL[state.dither],
          COLOR_LABEL[state.color],
          `${state.pixel}px`,
          state.view !== "dithered" ? VIEW_LABEL[state.view] : "",
        ].filter(Boolean);
      },
      modified: () => keys.some((key) => this.#current().state[key] !== this.#base()[key]),
      reset: () =>
        this.#change(Object.fromEntries(keys.map((key) => [key, this.#base()[key]])), true),
      syncers: this.#syncers,
    });
  }

  #motionSection(): HTMLElement {
    const motion = this.#slider(
      "Motion",
      0,
      1,
      0.05,
      () => this.#current().state.motion,
      (value, commit) => this.#change({ motion: value }, commit),
    );
    const follow = this.#switch(
      "Follow mouse",
      () => this.#current().state.mouse === "follow",
      (on) => this.#change({ mouse: on ? "follow" : "still" }, true),
    );
    const play = h("button", { type: "button", class: "text-button wide" });
    play.addEventListener("click", () => {
      const renderer = this.#host.renderer();
      renderer?.setPaused(!renderer.paused);
      this.sync();
    });
    const transitions = this.#switch(
      "Scene transitions",
      () => this.#current().state.transitions === "on",
      (on) => this.#change({ transitions: on ? "on" : "off" }, true),
    );
    const replay = h(
      "button",
      {
        type: "button",
        class: "fire",
        title: "Play this scene's exit, then its entrance, right now",
      },
      icon("bolt"),
      h("span", {}, "now"),
    );
    replay.addEventListener("click", () => this.#host.renderer()?.replayPassage());
    const rows = [
      this.#row({
        label: "Amount",
        help: "Overall animation. 0 is a still frame; triggered events still play.",
        block: motion.el,
        readout: () =>
          this.#current().state.motion === 0
            ? "still"
            : `${Math.round(this.#current().state.motion * 100)}%`,
        modified: () => this.#current().state.motion !== this.#base().motion,
        reset: () => this.#change({ motion: this.#base().motion }, true),
      }),
      this.#row({
        label: "Follow mouse",
        help: "Tilt and parallax the scene gently toward the pointer.",
        inline: [follow.el],
        modified: () => this.#current().state.mouse !== this.#base().mouse,
        reset: () => this.#change({ mouse: this.#base().mouse }, true),
      }),
      this.#row({
        label: "Transitions",
        help: "Scenes come in and leave gracefully: the old frame dissolves away in dither order, and many scenes play their own entrance and exit (a camera settling, a fire catching, lanterns arriving). Off: a straight cut. Skipped at motion 0 and under reduced motion; now plays it anyway.",
        inline: [replay, transitions.el],
        modified: () => this.#current().state.transitions !== this.#base().transitions,
        reset: () => this.#change({ transitions: this.#base().transitions }, true),
      }),
      this.#row({
        label: "Clock",
        help: "Freeze time to study a frame (p). Unlike motion 0, a paused frame keeps its current pose.",
        block: play,
      }),
    ];
    this.#syncers.push(
      motion.sync,
      follow.sync,
      transitions.sync,
      ...rows.map((row) => row.sync),
      () => {
        const paused = this.#host.renderer()?.paused ?? false;
        play.replaceChildren(
          icon(paused ? "play" : "pause"),
          h("span", {}, paused ? "Play" : "Pause"),
        );
      },
    );
    return this.#section({
      id: "motion",
      title: "Motion",
      blurb: "How much things move, and whether the scene follows you.",
      open: false,
      content: rows.map((row) => row.el),
      summary: () => {
        const { state } = this.#current();
        return [
          this.#host.renderer()?.paused
            ? "paused"
            : state.motion === 0
              ? "still"
              : `${Math.round(state.motion * 100)}%`,
          state.mouse === "follow" ? "follows mouse" : "fixed camera",
        ];
      },
      modified: () =>
        this.#current().state.motion !== this.#base().motion ||
        this.#current().state.mouse !== this.#base().mouse ||
        this.#current().state.transitions !== this.#base().transitions,
      reset: () =>
        this.#change(
          {
            motion: this.#base().motion,
            mouse: this.#base().mouse,
            transitions: this.#base().transitions,
          },
          true,
        ),
      syncers: this.#syncers,
    });
  }

  #presetsSection(): HTMLElement {
    const list = h("ul", { class: "presets" });
    const name = h("input", {
      type: "text",
      placeholder: "Name this setup",
      maxLength: 60,
      "aria-label": "Preset name",
    });
    const save = h("button", { type: "submit", class: "text-button" }, h("span", {}, "Save"));
    const form = h("form", { class: "save-row" }, name, save);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const { state } = this.#current();
      const preset: Preset = {
        name:
          name.value.trim() || `${sceneDefs[state.scene].title} · ${new Date().toLocaleString()}`,
        commit: this.#host.build || "working-tree",
        query: this.#query(),
        savedAt: new Date().toISOString().slice(0, 10),
      };
      saveLocalPresets([...loadLocalPresets(), preset]);
      name.value = "";
      this.sync();
    });

    const importBox = h("textarea", {
      rows: 4,
      placeholder: "Paste exported JSON here",
      "aria-label": "Presets to import",
    });
    const importAdd = h(
      "button",
      { type: "button", class: "text-button" },
      h("span", {}, "Add to this browser"),
    );
    let importing = false;
    const importReveal = reveal(
      h("div", { class: "import" }, importBox, importAdd),
      () => importing,
    );
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
    const exportButton = this.#textButton(
      "external",
      "Export",
      "Copy this browser's saved setups as JSON, with the commit each was made on",
      (button) => {
        const text = JSON.stringify(loadLocalPresets(), null, 2);
        navigator.clipboard.writeText(text).then(
          () => this.#flash(button, "Copied"),
          () => this.#flash(button, "Copy failed"),
        );
      },
    );
    const importButton = this.#textButton(
      "redo",
      "Import",
      "Add setups exported from another browser",
      () => {
        importing = !importing;
        importReveal.sync();
      },
    );

    const renderList = () => {
      const current = this.#query();
      const entries: { preset: Preset; local: number | undefined }[] = [
        ...presets.map((preset) => ({ preset, local: undefined })),
        ...loadLocalPresets().map((preset, index) => ({ preset, local: index })),
      ];
      list.replaceChildren(
        ...entries.map(({ preset, local }) => {
          const scene = new URLSearchParams(preset.query).get("scene") ?? defaults.scene;
          const main = h(
            "button",
            { type: "button", class: "preset-main", title: "Load these settings on this build" },
            h("span", { class: "preset-name" }, preset.name),
            h(
              "span",
              { class: "preset-meta" },
              `${scene} · ${local === undefined ? "baseline" : "saved here"} · @${preset.commit}`,
            ),
          );
          main.addEventListener("click", () => {
            this.#host.apply(new URLSearchParams(preset.query));
            this.commit();
          });
          const original = h(
            "a",
            {
              class: "icon-button",
              href: `${location.origin}/@${preset.commit}/${preset.query ? `?${preset.query}` : ""}`,
              title: "Open exactly as it was, on the build it was made with",
            },
            icon("external"),
          );
          const remove =
            local === undefined
              ? null
              : this.#iconButton("trash", "Delete this saved setup", () => {
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
    };
    this.#syncers.push(renderList, importReveal.sync);
    return this.#section({
      id: "presets",
      title: "Presets",
      blurb:
        "Saved setups. Click one to load it here; the arrow opens it on the exact build it was tuned on.",
      open: false,
      content: [
        list,
        form,
        h("div", { class: "lab-actions" }, exportButton, importButton),
        importReveal.el,
      ],
      summary: () => [`${presets.length + loadLocalPresets().length} saved`],
      syncers: this.#syncers,
    });
  }

  #compareSection(): HTMLElement {
    const start = this.#textButton(
      "compare",
      "Compare from here",
      "Keep this setup as A and edit a copy of it as B",
      () => this.#startCompare(),
    );
    start.classList.add("wide");
    const slotButtons = slots.map((slot) => {
      const scene = h("span", { class: "slot-scene" });
      const button = h(
        "button",
        { type: "button", "data-value": slot },
        h("span", { class: "slot-letter" }, slot.toUpperCase()),
        scene,
      );
      button.addEventListener("click", () => this.#showSlot(slot));
      return { slot, button, scene };
    });
    const onScreen = h(
      "div",
      { class: "segments slots", role: "group", "aria-label": "Setup on screen" },
      ...slotButtons.map(({ button }) => button),
    );
    const onRow = this.#row({
      label: "On screen",
      help: "Each slot is a complete setup: scene, knobs, look, motion and page. Edits change the slot on screen, and each slot keeps its own undo. Tap b, click a slot or the badge over the page to flip; hold b to peek at the other slot and let go to come back. Flips cut instead of playing passages, so a flip between two scenes starts the other one afresh.",
      block: onScreen,
    });
    const differs = h("p", { class: "differs" });
    const copyLabel = h("span", {});
    const copy = h(
      "button",
      {
        type: "button",
        class: "text-button",
        title: "Make the other slot this exact setup (undo there brings its old one back)",
      },
      icon("redo"),
      copyLabel,
    );
    copy.addEventListener("click", () => this.#copyToHidden());
    const stop = this.#textButton(
      "cross",
      "Stop",
      "Stop comparing and keep the setup on screen",
      () => this.#stopCompare(),
    );
    const active = h(
      "div",
      { class: "compare-active" },
      onRow.el,
      differs,
      h("div", { class: "lab-actions" }, copy, stop),
    );
    const sync = () => {
      const comparison = this.#comparison;
      start.hidden = comparison !== undefined;
      active.hidden = comparison === undefined;
      this.#badge.hidden = comparison === undefined;
      if (!comparison) return;
      const here = this.#query();
      const live = this.#current().state.scene;
      const hidden = readState(new URLSearchParams(comparison.other)).scene;
      for (const { slot, button, scene } of slotButtons) {
        button.setAttribute("aria-pressed", String(slot === comparison.live));
        scene.textContent = sceneDefs[slot === comparison.live ? live : hidden].title;
      }
      const keys = setupDifferences(here, comparison.other);
      differs.textContent =
        keys.length === 0
          ? "A and B are the same setup: change the one on screen."
          : `They differ in ${keys.map((key) => this.#settingLabel(key, [live, hidden])).join(", ")}.`;
      copyLabel.textContent = `Copy to ${otherSlot(comparison.live).toUpperCase()}`;
      this.#badge.textContent = `${comparison.live.toUpperCase()} · ${sceneDefs[live].title}`;
    };
    this.#syncers.push(sync, onRow.sync);
    return this.#section({
      id: "compare",
      title: "Compare",
      blurb: "Hold two complete setups, A and B, and flip between them.",
      open: false,
      content: [start, active],
      summary: () => {
        const comparison = this.#comparison;
        if (!comparison) return [];
        const count = setupDifferences(this.#query(), comparison.other).length;
        return [
          `showing ${comparison.live.toUpperCase()}`,
          count === 0 ? "same" : `${count} ${count === 1 ? "difference" : "differences"}`,
        ];
      },
      syncers: this.#syncers,
    });
  }

  /** A URL key in words: a lab setting, or a knob of one of `scenes` (a feature's amount after its name). */
  #settingLabel(key: string, scenes: readonly SceneId[]): string {
    if (Object.hasOwn(SETTING_LABEL, key)) return SETTING_LABEL[key as keyof LabState];
    const amount = key.endsWith("-amount");
    const knob = amount ? key.slice(0, -"-amount".length) : key;
    for (const scene of scenes) {
      const def = sceneDefs[scene].params.find((candidate) => candidate.key === knob);
      if (def)
        return amount && def.kind === "feature" ? `${def.label} ${def.amountLabel}` : def.label;
    }
    return key;
  }

  #tourSection(): HTMLElement {
    const steps = h("ol", { class: "tour-steps", "aria-label": "Scenes on the tour" });
    let rendered = "";
    const picker = h("select", { class: "tour-picker", "aria-label": "Scene to add" });
    let offered = "";
    const add = this.#textButton(
      "plus",
      "Add",
      "Add the chosen scene at the end of the tour",
      () => {
        const scene = sceneIds.find((id) => id === picker.value);
        if (scene) this.#editTour([...(this.#tour?.tour.steps ?? []), { scene }]);
      },
    );
    const addAll = this.#textButton(
      "plus",
      "All",
      "Add every scene not on the tour yet, in the lab's order",
      () => {
        const on = this.#tour?.tour.steps ?? [];
        this.#editTour([
          ...on,
          ...sceneIds
            .filter((id) => !on.some((step) => step.scene === id))
            .map((scene) => ({ scene })),
        ]);
      },
    );
    const scenesRow = this.#row({
      label: "Scenes",
      help: "The tour plays these in order and starts over after the last. Give a scene its own seconds, or leave it empty for the tour's. Click a name to go there now.",
      block: h(
        "div",
        { class: "tour-build" },
        steps,
        h("div", { class: "tour-add" }, picker, add, addAll),
      ),
    });
    const dwell = this.#slider(
      "Seconds per scene",
      TOUR_DWELL.min,
      180,
      5,
      () => this.#tourDwell,
      (value) => this.#editTour(this.#tour?.tour.steps ?? [], value),
    );
    const dwellRow = this.#row({
      label: "Each scene",
      help: "Seconds on each scene without its own, counted from the switch to it, on the scene clock: nothing passes while the clock is paused, and a slow frame counts at most a tenth of a second, so slow machines still give a growing scene its time.",
      block: dwell.el,
      readout: () => `${this.#tourDwell} s`,
      modified: () => this.#tourDwell !== TOUR_DWELL.fallback,
      reset: () => this.#editTour(this.#tour?.tour.steps ?? [], TOUR_DWELL.fallback),
    });
    const previous = this.#iconButton(
      "previous",
      "Previous scene on the tour ([ while it plays)",
      () => this.#stepTour(-1),
    );
    const play = h("button", {
      type: "button",
      class: "text-button tour-play",
      title: "Play or pause the tour (t)",
    });
    play.addEventListener("click", () => this.toggleTour());
    const next = this.#iconButton("next", "Next scene on the tour (] while it plays)", () =>
      this.#stepTour(1),
    );
    const clear = this.#iconButton("trash", "Remove the tour", () => this.#editTour([]));
    const playRow = this.#row({
      label: "Play",
      help: this.#reducedMotion
        ? "Your system asks for reduced motion: a tour link waits for play here, and scenes cut and stand still instead of passing."
        : "Scenes come and go through their own passages (cuts with transitions off or at motion 0). A tour link starts playing as it opens; choosing a scene that is not on the tour pauses it.",
      block: h(
        "div",
        { class: "tour-clock" },
        h(
          "div",
          { class: "tour-transport" },
          previous,
          play,
          next,
          h("span", { class: "spacer" }),
          clear,
        ),
        this.#tourProgress,
        this.#tourStatus,
      ),
    });

    const sync = () => {
      const tour = this.#tour;
      const list = tour?.tour.steps ?? [];
      const signature = JSON.stringify(tour?.tour ?? null);
      if (signature !== rendered) {
        rendered = signature;
        // Keep the keyboard where it was across the re-render (a moved step's button, an edited dwell).
        const focus =
          document.activeElement instanceof HTMLElement
            ? document.activeElement.dataset.focus
            : undefined;
        steps.replaceChildren(...list.map((step, index) => this.#tourStepRow(step, index, list)));
        if (focus !== undefined)
          steps.querySelector<HTMLElement>(`[data-focus="${focus}"]`)?.focus();
      }
      for (const [index, item] of [...steps.children].entries()) {
        if (index === tour?.index) item.setAttribute("aria-current", "step");
        else item.removeAttribute("aria-current");
      }
      const available = sceneIds.filter((id) => !list.some((step) => step.scene === id));
      const { scene } = this.#current().state;
      if (available.join() !== offered) {
        offered = available.join();
        picker.replaceChildren(
          ...available.map((id) => h("option", { value: id }, sceneDefs[id].title)),
        );
      }
      if (document.activeElement !== picker && available.includes(scene)) picker.value = scene;
      for (const control of [picker, add, addAll]) control.disabled = available.length === 0;
      play.replaceChildren(
        icon(tour?.playing ? "pause" : "play"),
        h("span", {}, tour?.playing ? "Pause" : "Play"),
      );
      for (const button of [previous, play, next, clear]) button.disabled = tour === undefined;
      this.#syncTourClock();
    };
    this.#syncers.push(sync, scenesRow.sync, dwell.sync, dwellRow.sync, playRow.sync);
    return this.#section({
      id: "tour",
      title: "Tour",
      blurb: "Play chosen scenes one after another, each for a while.",
      open: false,
      content: [scenesRow.el, dwellRow.el, playRow.el],
      summary: () => {
        const tour = this.#tour;
        return tour
          ? [
              `${tour.tour.steps.length} ${tour.tour.steps.length === 1 ? "scene" : "scenes"}`,
              tour.playing ? "playing" : "paused",
            ]
          : [];
      },
      modified: () => this.#tour !== undefined,
      reset: () => this.#editTour([], TOUR_DWELL.fallback),
      syncers: this.#syncers,
    });
  }

  #tourStepRow(step: TourStep, index: number, list: readonly TourStep[]): HTMLElement {
    const { title, accent } = sceneDefs[step.scene];
    const go = h(
      "button",
      {
        type: "button",
        class: "tour-title",
        title: `Show ${title} now`,
        "data-focus": `go:${step.scene}`,
      },
      h("span", { class: "scene-dot" }),
      h("span", {}, title),
    );
    go.style.setProperty("--dot", accent);
    go.addEventListener("click", () => {
      this.#setScene(step.scene);
      this.sync();
    });
    const seconds = h("input", {
      type: "number",
      class: "tour-seconds",
      min: String(TOUR_DWELL.min),
      max: String(TOUR_DWELL.max),
      step: "1",
      placeholder: String(this.#tourDwell),
      value: step.dwell === undefined ? "" : String(step.dwell),
      "aria-label": `Seconds on ${title} (empty: the tour's ${this.#tourDwell})`,
      "data-focus": `dwell:${step.scene}`,
    });
    seconds.addEventListener("change", () => {
      const raw = seconds.value.trim();
      this.#editTour(
        list.map((entry, at) =>
          at !== index
            ? entry
            : raw === ""
              ? { scene: entry.scene }
              : { scene: entry.scene, dwell: clampDwell(Number(raw)) },
        ),
      );
    });
    const move = (by: number) => {
      const next = [...list];
      next.splice(index + by, 0, ...next.splice(index, 1));
      this.#editTour(next);
    };
    const up = this.#iconButton("up", `Move ${title} earlier`, () => move(-1));
    up.dataset.focus = `up:${step.scene}`;
    up.disabled = index === 0;
    const down = this.#iconButton("down", `Move ${title} later`, () => move(1));
    down.dataset.focus = `down:${step.scene}`;
    down.disabled = index === list.length - 1;
    const remove = this.#iconButton("cross", `Remove ${title} from the tour`, () =>
      this.#editTour(list.filter((_, at) => at !== index)),
    );
    return h(
      "li",
      { class: "tour-step" },
      go,
      seconds,
      h("span", { class: "tour-unit" }, "s"),
      up,
      down,
      remove,
    );
  }

  /** The tour's place in words and as a bar; runs every frame while it plays. */
  #syncTourClock(): void {
    const tour = this.#tour;
    const status = this.#tourStatus;
    const progress = this.#tourProgress;
    progress.hidden = tour === undefined;
    if (!tour) {
      status.textContent = "Add scenes to build a tour.";
      return;
    }
    const where =
      tour.step.scene !== this.#current().state.scene
        ? "paused: off the tour"
        : tour.playing
          ? `${Math.ceil(tour.dwell - tour.elapsed)} s left`
          : "paused";
    const text = `${tour.index + 1} / ${tour.tour.steps.length} · ${sceneDefs[tour.step.scene].title} · ${where}`;
    if (status.textContent !== text) status.textContent = text;
    const share = Math.round((tour.elapsed / tour.dwell) * 200) / 200;
    if (progress.value !== share) progress.value = share;
  }

  #keysSection(): HTMLElement {
    const table = h(
      "dl",
      { class: "keys" },
      ...SHORTCUTS.flatMap(([key, what]) => [h("dt", {}, h("kbd", {}, key)), h("dd", {}, what)]),
    );
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

  // ---- session tools: A/B comparison and tour -------------------------------------------------

  /** Keep the setup on screen as A and go on editing a copy of it as B, with the history so far. */
  #startCompare(): void {
    this.commit();
    const here = this.#query();
    this.#comparison = { live: "b", other: here };
    this.#hiddenHistory = { undo: [], redo: [], committed: here };
    this.#host.apply(new URLSearchParams(here));
  }

  #stopCompare(): void {
    this.#comparison = undefined;
    this.#hiddenHistory = undefined;
    this.#host.apply(new URLSearchParams(this.#query()));
  }

  /** Show `slot`'s setup at once; the one on screen waits in its own slot, with its own undo. */
  #showSlot(slot: Slot): void {
    const comparison = this.#comparison;
    if (!comparison || comparison.live === slot) return;
    this.commit();
    const leaving = this.#history;
    this.#history = this.#hiddenHistory ?? { undo: [], redo: [], committed: comparison.other };
    this.#hiddenHistory = leaving;
    this.#comparison = { live: slot, other: leaving.committed };
    this.#host.apply(new URLSearchParams(comparison.other), { cut: true });
  }

  /** Make the hidden slot the setup on screen, as an undo step of the hidden slot's own. */
  #copyToHidden(): void {
    const comparison = this.#comparison;
    if (!comparison) return;
    this.commit();
    const here = this.#query();
    const hidden = this.#hiddenHistory ?? { undo: [], redo: [], committed: comparison.other };
    record(hidden, here);
    this.#hiddenHistory = hidden;
    this.#comparison = { live: comparison.live, other: here };
    this.#host.apply(new URLSearchParams(here));
  }

  /** Show the tour's scene (the current step unless the page already shows one) and play or hold it. */
  #beginTour(play: boolean): void {
    const tour = this.#tour;
    if (!tour) return;
    if (!tour.follow(this.#current().state.scene)) this.#setScene(tour.step.scene);
    tour.playing = play;
    this.#runTour();
    this.sync();
  }

  /** Go `by` steps along the tour, playing or not. */
  #stepTour(by: number): void {
    const tour = this.#tour;
    if (!tour) return;
    this.#setScene(tour.skip(by));
    this.sync();
  }

  /** Replace the tour's steps (none removes it) and its dwell, and write it to the URL. */
  #editTour(steps: readonly TourStep[], dwell = this.#tourDwell): void {
    this.#tourDwell = dwell;
    if (steps.length === 0) this.#tour = undefined;
    else if (this.#tour) this.#tour.edit({ steps, dwell });
    else this.#tour = new TourPlayer({ steps, dwell }, false);
    this.#host.apply(new URLSearchParams(this.#query()));
  }

  /** Start the tour's frame clock if it plays and is not running yet. */
  #runTour(): void {
    if (!this.#tour?.playing || this.#tourFrame !== undefined) return;
    this.#tourLast = undefined;
    this.#tourFrame = requestAnimationFrame(this.#tourTick);
  }

  /** One frame of the tour's clock: it stops once the tour pauses or is removed. */
  readonly #tourTick = (now: number): void => {
    this.#tourFrame = undefined;
    const tour = this.#tour;
    if (!tour?.playing) return;
    const seconds = this.#tourLast === undefined ? 0 : (now - this.#tourLast) / 1000;
    this.#tourLast = now;
    const next = tour.tick(seconds, this.#host.renderer()?.paused ?? false);
    if (next !== undefined) this.#setScene(next);
    this.#syncTourClock();
    this.#tourFrame = requestAnimationFrame(this.#tourTick);
  };

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
    for (const def of sceneDefs[scene].params)
      groups.set(def.group, [...(groups.get(def.group) ?? []), def]);
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
    if (!head || (head.kind !== "toggle" && head.kind !== "feature") || rest.length === 0)
      return undefined;
    return rest.every((def) => def.when === head.key) ? head : undefined;
  }

  #groupSection(
    scene: SceneId,
    group: string,
    defs: readonly ParamDef[],
    open: boolean,
  ): HTMLElement {
    const info = sceneDefs[scene].groups[group] ?? { title: group, blurb: "" };
    const master = this.#masterOf(defs);
    const fallback = paramDefaults(scene);
    const keysOf = (def: ParamDef) =>
      def.kind === "feature" ? [def.key, `${def.key}-amount`] : [def.key];
    const keys = defs.flatMap(keysOf);
    const syncers = this.#sceneSyncers;
    const rows = defs
      .filter((def) => def !== master || def.kind === "feature")
      .map((def) => this.#paramRow(def, def === master, fallback, syncers));
    const masterSwitch = master
      ? this.#switch(
          master.label,
          () => this.#on(master.key),
          (on) => {
            if (on) {
              this.#prefs.sections[`${scene}:${group}`] = true;
              this.#savePrefs();
            }
            this.#change({ [master.key]: on ? 1 : 0 }, true);
          },
        )
      : undefined;
    return this.#section({
      id: `${scene}:${group}`,
      title: info.title,
      blurb: info.blurb,
      open,
      content: rows,
      summary: () => this.#groupSummary(defs, master, fallback),
      ...(masterSwitch ? { master: masterSwitch } : {}),
      ...(master
        ? {
            masterOn: () => this.#on(master.key),
            offNote: `Switch on to shape the ${info.title.toLowerCase()}.`,
          }
        : {}),
      modified: () => keys.some((key) => this.#current().params[key] !== fallback[key]),
      reset: () =>
        this.#change(Object.fromEntries(keys.map((key) => [key, fallback[key] ?? 0])), true),
      syncers,
    });
  }

  #groupSummary(
    defs: readonly ParamDef[],
    master: ParamDef | undefined,
    fallback: Params,
  ): string[] {
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
          if (value > 0.5)
            chips.push(
              def.options ? `${params[`${def.key}-amount`] ?? def.value} ${def.label}` : def.label,
            );
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

  #paramRow(
    def: ParamDef,
    isMaster: boolean,
    fallback: Params,
    syncers: (() => void)[],
  ): HTMLElement {
    const params = () => this.#current().params;
    const value = (key: string) => params()[key] ?? fallback[key] ?? 0;
    const setKey =
      (key: string) =>
      (next: number | string, commit = true) =>
        this.#change({ [key]: next }, commit);
    const modifiedKeys = def.kind === "feature" ? [def.key, `${def.key}-amount`] : [def.key];
    const modified = () => modifiedKeys.some((key) => value(key) !== fallback[key]);
    const reset = () =>
      this.#change(Object.fromEntries(modifiedKeys.map((key) => [key, fallback[key] ?? 0])), true);
    const options = (list: readonly Option[]) =>
      list.map((option) => ({ label: option.label, value: String(option.value) }));
    let built: Built;

    switch (def.kind) {
      case "range": {
        const slider = this.#slider(
          def.label,
          def.min,
          def.max,
          def.step,
          () => value(def.key),
          (next, commit) => setKey(def.key)(next, commit),
        );
        built = this.#row({
          label: def.label,
          help: def.help,
          block: slider.el,
          readout: () => formatValue(def, value(def.key)),
          modified,
          reset,
        });
        syncers.push(slider.sync);
        break;
      }
      case "toggle": {
        const toggle = this.#switch(
          def.label,
          () => value(def.key) > 0.5,
          (on) => setKey(def.key)(on ? 1 : 0),
        );
        built = this.#row({
          label: def.label,
          help: def.help,
          inline: [toggle.el],
          modified,
          reset,
        });
        syncers.push(toggle.sync);
        break;
      }
      case "choice": {
        const segments = this.#segments(
          def.label,
          options(def.options),
          () => String(value(def.key)),
          (next) => setKey(def.key)(Number(next)),
        );
        built = this.#row({
          label: def.label,
          help: def.help,
          block: segments.el,
          modified,
          reset,
        });
        syncers.push(segments.sync);
        break;
      }
      case "seed": {
        const reseed = h(
          "button",
          { type: "button", class: "fire", title: "Pick another arrangement" },
          icon("dice"),
          h("span", {}, "re-seed"),
        );
        reseed.addEventListener("click", () => {
          let next = Math.floor(Math.random() * (MAX_SEED + 1));
          if (next === value(def.key)) next = (next + 1) % (MAX_SEED + 1);
          setKey(def.key)(next);
        });
        built = this.#row({
          label: def.label,
          help: def.help,
          inline: [reseed],
          readout: () => formatValue(def, value(def.key)),
          modified,
          reset,
        });
        break;
      }
      case "feature": {
        const amountKey = `${def.key}-amount`;
        const amount = def.options
          ? this.#segments(
              def.amountLabel,
              options(def.options),
              () => String(value(amountKey)),
              (next) => setKey(amountKey)(Number(next)),
            )
          : this.#slider(
              def.amountLabel,
              def.min,
              def.max,
              def.step,
              () => value(amountKey),
              (next, commit) => setKey(amountKey)(next, commit),
            );
        // A master feature's row is already titled by its amount, so the amount needs no second label.
        const amountRow = h(
          "div",
          { class: `amount${isMaster ? " bare" : ""}` },
          isMaster ? null : h("span", { class: "amount-label" }, def.amountLabel),
          amount.el,
        );
        const amountReadout = h("span", { class: "readout" });
        if (!def.options) amountRow.append(amountReadout);
        const amountReveal = reveal(amountRow, () => value(def.key) > 0.5);
        const inline: HTMLElement[] = [];
        if (def.trigger !== undefined) {
          const slot = def.trigger;
          const fire = h(
            "button",
            {
              type: "button",
              class: "fire",
              title: `Show one ${def.label} right now, even while it is switched off`,
            },
            icon("bolt"),
            h("span", {}, "now"),
          );
          fire.addEventListener("click", () => this.#host.renderer()?.trigger(slot));
          inline.push(fire);
        }
        const toggle = this.#switch(
          def.label,
          () => value(def.key) > 0.5,
          (on) => setKey(def.key)(on ? 1 : 0),
        );
        if (!isMaster) inline.push(toggle.el);
        built = this.#row({
          label: isMaster ? def.amountLabel : def.label,
          help: def.help,
          inline,
          block: amountReveal.el,
          modified,
          reset,
        });
        if (isMaster) amountReveal.el.classList.add("always");
        syncers.push(amount.sync, toggle.sync, amountReveal.sync, () => {
          amountReadout.textContent = formatValue(def, value(amountKey));
        });
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
    const pickOne = <T>(list: readonly T[]): T | undefined =>
      list[Math.floor(Math.random() * list.length)];
    const within = (min: number, max: number, step: number) =>
      Math.round((min + Math.random() * (max - min)) / step) * step;
    for (const def of sceneDefs[state.scene].params) {
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
          patch[`${def.key}-amount`] = def.options
            ? (pickOne(def.options)?.value ?? def.value)
            : Number(within(def.min, def.max, def.step).toFixed(4));
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
    const setup = new URLSearchParams(this.#query());
    for (const [key, value] of this.sessionQuery()) setup.append(key, value);
    const query = setup.toString();
    const url = this.#host.build
      ? `${location.origin}/@${this.#host.build}/${query ? `?${query}` : ""}`
      : location.href;
    navigator.clipboard.writeText(url).then(
      () => this.#flash(button, "Copied"),
      () => this.#flash(button, "Copy failed"),
    );
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
      const titleHit =
        searching &&
        (section.querySelector(".sec-title")?.textContent ?? "").toLowerCase().includes(text);
      const visible = !searching || matches > 0 || titleHit;
      section.hidden = !visible;
      if (titleHit)
        for (const row of section.querySelectorAll<HTMLElement>("[data-search]"))
          row.classList.remove("no-match");
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
