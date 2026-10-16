// The lab: a floating-inspector workspace over the scene, built entirely from the scene catalogue
// and knob definitions. Two panels (lab/panels.ts): the inspector, whose views (lab/views.ts) are
// the scene picker (lab/gallery.ts), the presets (lab/presets.ts) and the controls
// (lab/inspector.ts); and the transport bar, whose popovers (lab/transport.ts) hold the A/B
// comparison (compare.ts), the scene tour (tour.ts), every "now" and the shortcuts. Every change goes
// through the host as a URL query (a scene's planets under their one key among its knobs), so
// links, presets and undo all share one representation; the session tools sit beside the setup in
// the URL (`sessionQuery`) and never inside it.
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
import { SceneGallery } from "./lab/gallery.ts";
import { iconButton, nowButton, row, slider, textButton } from "./lab/controls.ts";
import {
  h,
  setAttr,
  setHidden,
  setStyle,
  setText,
  type LabContext,
  type Patch,
} from "./lab/dom.ts";
import { icon } from "./lab/icons.ts";
import { Inspector } from "./lab/inspector.ts";
import { knobIcon } from "./lab/knobs.ts";
import { Workspace, type PanelLayout } from "./lab/panels.ts";
import { rollPlanets } from "./lab/planets-model.ts";
import { PREFS_KEY, readPrefs } from "./lab/prefs.ts";
import { PresetsView } from "./lab/presets.ts";
import { rollPatch } from "./lab/roll-model.ts";
import { Popover, separator } from "./lab/transport.ts";
import { Views } from "./lab/views.ts";
import { carryPlanets, carryWorld } from "./lab/world-model.ts";
import type { ParamDef } from "./params.ts";
import type { DitherRenderer, SceneFailure } from "./renderer.ts";
import { sceneDefs, sceneIds, type SceneId } from "./scenes/index.ts";
import { encodePlanets, PLANETS_KEY, type SkyPlanet } from "./scenes/planets.ts";
import {
  carryLook,
  paramDefaults,
  readState,
  serialise,
  URL_VERSION,
  VERSION_KEY,
  type LabState,
  type Params,
} from "./state.ts";
import { clampDwell, readTour, TOUR_DWELL, TourPlayer, writeTour, type TourStep } from "./tour.ts";

export interface LabHost {
  current(): { state: LabState; params: Params; planets: readonly SkyPlanet[] };
  /**
   * Replace the whole setup. The host re-renders, then calls `Lab.sync()`. `cut`: switch scenes at
   * once, without the passage (an A/B flip).
   */
  apply(query: URLSearchParams, options?: { cut?: boolean }): void;
  renderer(): DitherRenderer | undefined;
  /** Commit the page was built from; empty for a working tree. */
  build: string;
}

const FAILURE_LABEL: Record<SceneFailure["stage"], string> = {
  build: "its shader did not build",
  start: "its simulation did not start",
  frame: "it stopped while drawing",
};
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
  overlap: "transition overlap",
  weave: "transition blend length",
  blend: "transition pattern",
  slowmo: "transition slow motion",
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
  readonly #prefs = readPrefs(localStorage.getItem(PREFS_KEY));
  readonly #ctx: LabContext;
  readonly #workspace: Workspace;
  readonly #views: Views;
  readonly #gallery: SceneGallery;
  readonly #presets: PresetsView;
  readonly #inspector: Inspector;
  readonly #syncers: (() => void)[] = [];
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
  readonly #barProgress = h("span", { class: "bar-progress", "aria-hidden": "true" });
  readonly #reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  readonly #undoButton: HTMLButtonElement;
  readonly #redoButton: HTMLButtonElement;
  readonly #status = h("span", { class: "bar-status" });
  readonly #statusLong = h("p", { class: "keys-status" });
  readonly #failure: { el: HTMLElement; sync: () => void };
  /** One line over the scene: the link just applied named a scene this build does not have. */
  readonly #noticeText = h("span", { class: "lab-notice-text" });
  readonly #notice = h(
    "div",
    { class: "lab-notice", role: "status", hidden: true },
    this.#noticeText,
    iconButton("close", "Dismiss", () => this.#dismissNotice()),
  );
  /** The scene on screen when the notice went up: it goes once another scene is. */
  #noticeScene: SceneId | undefined;

  constructor(root: HTMLElement, opener: HTMLButtonElement, host: LabHost) {
    this.#root = root;
    this.#opener = opener;
    this.#host = host;
    this.#ctx = {
      current: () => host.current(),
      change: (patch, commit) => this.#change(patch, commit),
      on: (key) => key === undefined || (host.current().params[key] ?? 0) > 0.5,
      renderer: () => host.renderer(),
      reducedMotion: this.#reducedMotion,
    };
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
    root.classList.toggle("explain", this.#prefs.explain);

    const save = () => this.#savePrefs();
    this.#gallery = new SceneGallery(this.#ctx, (scene) => this.#setScene(scene, "hand"));
    this.#presets = new PresetsView(this.#ctx, {
      load: (query) => {
        host.apply(new URLSearchParams(query));
        this.commit();
      },
      query: () => this.#query(),
      build: host.build,
    });
    const prefs = this.#prefs;
    this.#inspector = new Inspector(this.#ctx, {
      sections: prefs.sections,
      get keepWorld() {
        return prefs.keepWorld;
      },
      set keepWorld(keep: boolean) {
        prefs.keepWorld = keep;
      },
      save,
    });
    // The Scenes and Presets views reflect the setup only while on screen, and as they come on.
    this.#views = new Views(
      [
        {
          id: "scenes",
          label: "Scenes",
          icon: "grid",
          el: this.#gallery.el,
          shown: () => {
            this.#gallery.sync();
            this.#gallery.shown();
          },
        },
        {
          id: "presets",
          label: "Presets",
          icon: "bookmark",
          el: this.#presets.el,
          shown: () => {
            this.#presets.sync();
            this.#presets.shown();
          },
        },
        {
          id: "controls",
          label: "Controls",
          icon: "sliders",
          el: this.#inspector.el,
          shown: () => this.#inspector.shown(),
        },
      ],
      () => this.#workspace.show("inspector"),
      () => this.#pickScene(),
    );
    this.#undoButton = iconButton("undo", "Undo (Ctrl Z)", () => this.undo());
    this.#redoButton = iconButton("redo", "Redo (Ctrl ⇧ Z)", () => this.redo());

    this.#workspace = new Workspace(
      root,
      { panels: this.#prefs.panels, sheet: this.#prefs.sheet },
      (layouts: Record<string, PanelLayout>, sheet) => {
        this.#prefs.panels = layouts;
        this.#prefs.sheet = sheet;
        this.#savePrefs();
      },
      () => this.setOpen(false),
    );
    this.#workspace.add({
      id: "inspector",
      title: "Inspector",
      icon: "sliders",
      docks: ["left", "right"],
      bar: false,
      min: { w: 280, h: 240 },
      max: { w: 560 },
      head: this.#views.head,
      body: this.#views.body,
      initial: ({ h: vh }) => ({
        dock: "float",
        ax: "right",
        x: 16,
        ay: "top",
        y: 16,
        w: 352,
        h: Math.round(vh - 16 - 76),
        collapsed: false,
      }),
    });
    this.#workspace.add({
      id: "transport",
      title: "Transport",
      icon: "play",
      docks: ["top", "bottom"],
      bar: true,
      min: { w: 200, h: 40 },
      max: { w: 4000 },
      body: this.#transportBar(),
      initial: () => ({
        dock: "float",
        ax: "center",
        x: 0,
        ay: "bottom",
        y: 16,
        w: 640,
        h: 44,
        collapsed: false,
      }),
    });

    this.#failure = this.#failureAlert();
    root.append(h("div", { class: "lab-alerts" }, this.#notice, this.#failure.el));
    root.addEventListener("change", () => this.commit());
    opener.addEventListener("click", () => this.setOpen(true));
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!Popover.owns(event.target)) Popover.closeAll();
      },
      true,
    );
    window.addEventListener("resize", () => Popover.placeOpen());
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
    if (open) this.#workspace.arrange();
    else Popover.closeAll();
    // Knob changes are likely while the lab is open: on a GPU, scenes with knob-keyed features get
    // their all-features program built ahead (DitherRenderer.expectChanges).
    this.#host.renderer()?.expectChanges(open);
  }

  focusSearch(): void {
    this.setOpen(true);
    this.#views.show("controls");
    this.#inspector.focusSearch();
  }

  /** Reflect the host's current state into every control. */
  sync(): void {
    const { state } = this.#current();
    // The notice explains the scene it went up over: once another scene is on screen, it goes.
    if (this.#noticeScene !== undefined && state.scene !== this.#noticeScene) this.#dismissNotice();
    // A step of the tour (its own switch or the user's) becomes the current one; another scene holds it.
    this.#tour?.follow(state.scene);
    if (this.#views.current === "scenes") this.#gallery.sync();
    if (this.#views.current === "presets") this.#presets.sync();
    this.#inspector.sync();
    for (const sync of this.#syncers) sync();
    const scene = sceneDefs[state.scene];
    this.#views.setScene(scene.title, scene.accent);
    this.#syncHistory();
  }

  /**
   * The setup just applied came from a link or a preset naming `id`, a scene this build does not
   * have, so the default scene opened instead: say so in one line, until another scene comes on
   * screen or the notice is dismissed.
   */
  noteUnknownScene(id: string): void {
    const { scene } = this.#current().state;
    const text = `No scene "${id}" in this build: showing ${sceneDefs[scene].title} instead.`;
    this.#noticeScene = scene;
    setText(this.#noticeText, text);
    setAttr(this.#notice, "title", text);
    setHidden(this.#notice, false);
  }

  #dismissNotice(): void {
    this.#noticeScene = undefined;
    setHidden(this.#notice, true);
  }

  /** Open the scene picker: the inspector's Scenes view, the keyboard on the scene on screen. */
  #pickScene(): void {
    this.#views.show("scenes");
    this.#gallery.focusCurrent();
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

  /** Go to the previous (-1) or next (1) scene of the catalogue, as a scene picked by hand. */
  stepScene(by: -1 | 1): void {
    const { scene } = this.#current().state;
    const next = sceneIds[(sceneIds.indexOf(scene) + by + sceneIds.length) % sceneIds.length];
    this.#setScene(next ?? scene, "hand");
  }

  // ---- state plumbing -------------------------------------------------------------------------

  #current(): { state: LabState; params: Params; planets: readonly SkyPlanet[] } {
    return this.#host.current();
  }

  #query(): string {
    const { state, params, planets } = this.#current();
    return serialise(state, params, planets).toString();
  }

  /** Apply a patch over the current setup; `replace` starts from the patch alone. */
  #change(patch: Patch, commit: boolean, replace = false): void {
    const { state, params, planets } = this.#current();
    const q = replace ? new URLSearchParams() : serialise(state, params, planets);
    for (const [key, value] of Object.entries(patch)) q.set(key, String(value));
    // The patch is in this build's keys: it is read as this schema, never as an older link.
    q.set(VERSION_KEY, String(URL_VERSION));
    this.#host.apply(q);
    if (commit) this.commit();
  }

  #savePrefs(): void {
    localStorage.setItem(PREFS_KEY, JSON.stringify(this.#prefs));
  }

  #syncHistory(): void {
    const [undo, redo] = [this.#history.undo.length === 0, this.#history.redo.length === 0];
    if (this.#undoButton.disabled !== undo) this.#undoButton.disabled = undo;
    if (this.#redoButton.disabled !== redo) this.#redoButton.disabled = redo;
  }

  #syncStatus(): void {
    const renderer = this.#host.renderer();
    const gpu = renderer?.glInfo.split(" · ")[1] ?? "WebGL2 unavailable";
    const build = this.#host.build ? `build ${this.#host.build}` : "working tree";
    const fps = renderer ? `${Math.round(renderer.fps)} fps` : "no WebGL";
    setText(this.#status, renderer?.paused ? `${fps} · paused` : fps);
    setAttr(this.#status, "title", `${build} · ${fps}\n${gpu}`);
    setText(this.#statusLong, `${build} · ${fps} · ${gpu}`);
    this.#failure.sync();
  }

  /** Shown while the scene on screen has failed (polled with the status): what broke, a retry, and a way on. */
  #failureAlert(): { el: HTMLElement; sync: () => void } {
    const what = h("p");
    const detail = h("p", { class: "lab-failure-detail" });
    const retry = textButton("reset", "Retry", "Build this scene again from scratch", () => {
      this.#host.renderer()?.retry();
      el.hidden = true;
    });
    const next = textButton("next", "Next scene", "Go on to the next scene", () => {
      this.stepScene(1);
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
        setHidden(el, failure === undefined);
        if (failure === undefined) return;
        setText(what, `${sceneDefs[failure.scene].title}: ${FAILURE_LABEL[failure.stage]}.`);
        setText(detail, failure.message.split("\n")[0] ?? "");
        setAttr(
          el,
          "title",
          `${failure.message}\n\nThe console has the full error (evt=landing.renderer.scene_failed).`,
        );
      },
    };
  }

  // ---- the transport bar ----------------------------------------------------------------------

  #transportBar(): HTMLElement {
    const layer = this.#root;
    const state = () => this.#current().state;

    // The scene picker: the scene on screen, a click from the inspector's Scenes view.
    const sceneName = h("span", { class: "bar-scene-name" });
    const scenePick = h(
      "button",
      { type: "button", class: "bar-scene" },
      h("span", { class: "scene-dot" }),
      sceneName,
    );
    scenePick.addEventListener("click", () => this.#pickScene());

    const playIcon = icon("play");
    const pauseIcon = icon("pause");
    const play = h("button", { type: "button", class: "icon-button" }, playIcon, pauseIcon);
    play.addEventListener("click", () => {
      const renderer = this.#host.renderer();
      renderer?.setPaused(!renderer.paused);
      this.sync();
    });
    const motion = slider(
      "Motion",
      0,
      1,
      0.05,
      () => state().motion,
      (value, commit) => this.#change({ motion: value }, commit),
      (value) => (value === 0 ? "still" : `${Math.round(value * 100)}%`),
    );
    const motionReadout = h("span", { class: "bar-readout" });
    const motionBox = h(
      "label",
      { class: "bar-motion", title: "Motion: how much things move (0 is a still frame)" },
      icon("motion"),
      motion.el,
      motionReadout,
    );
    const transitions = iconButton("transition", "Scene transitions", () =>
      this.#change({ transitions: state().transitions === "on" ? "off" : "on" }, true),
    );
    const replay = iconButton(
      "replay",
      "Replay this scene's exit, then its entrance, now",
      (button) => {
        this.#host.renderer()?.replayPassage();
        button.classList.remove("firing");
        void button.offsetWidth;
        button.classList.add("firing");
      },
    );
    replay.addEventListener("animationend", () => replay.classList.remove("firing"));

    // Every "now" of the scene, in one list.
    const nowList = h("ul", { class: "now-list" });
    let nowScene: SceneId | undefined;
    const nowPop = new Popover(layer, {
      id: "now",
      title: "Now",
      icon: "bolt",
      label: "Now: set off one of this scene's events",
      content: [
        h(
          "p",
          { class: "pop-note" },
          "One of each event right now, whether or not it is switched on.",
        ),
        nowList,
      ],
    });
    const nowCount = h("span", { class: "bar-count" });
    nowPop.button.append(nowCount);

    const comparePop = new Popover(layer, {
      id: "compare",
      title: "Compare A/B",
      icon: "compare",
      label: "Compare two setups, A and B",
      content: this.#compareContent(),
    });
    const flips = slots.map((slot) => {
      const button = h(
        "button",
        { type: "button", class: "bar-slot", title: `Show ${slot.toUpperCase()} (b flips)` },
        slot.toUpperCase(),
      );
      button.addEventListener("click", () => this.#showSlot(slot));
      return { slot, button };
    });
    const flipGroup = h(
      "div",
      { class: "bar-slots", role: "group", "aria-label": "Setup on screen" },
      ...flips.map(({ button }) => button),
    );

    const tourPop = new Popover(layer, {
      id: "tour",
      title: "Tour",
      icon: "tour",
      label: "Tour: play chosen scenes one after another (t)",
      content: this.#tourContent(),
    });
    tourPop.button.append(this.#barProgress);

    const explain = iconButton("info", "Explain every control", () => {
      this.#prefs.explain = !this.#prefs.explain;
      this.#root.classList.toggle("explain", this.#prefs.explain);
      this.#savePrefs();
      this.sync();
    });
    const keysPop = new Popover(layer, {
      id: "keys",
      title: "Shortcuts",
      icon: "keyboard",
      label: "Keyboard shortcuts",
      content: [
        h(
          "dl",
          { class: "keys" },
          ...SHORTCUTS.flatMap(([key, what]) => [
            h("dt", {}, h("kbd", {}, key)),
            h("dd", {}, what),
          ]),
        ),
        h("p", { class: "pop-note" }, "Shortcuts work anywhere on the page, outside text fields."),
        this.#statusLong,
      ],
    });

    const link = iconButton(
      "link",
      "Copy a link that replays this exact setup on this build, with its A/B comparison and tour",
      (button) => this.#copyLink(button),
    );
    const bar = h(
      "div",
      { class: "bar-items" },
      scenePick,
      separator(),
      play,
      motionBox,
      separator(),
      transitions,
      replay,
      nowPop.button,
      separator(),
      comparePop.button,
      flipGroup,
      tourPop.button,
      separator(),
      this.#undoButton,
      this.#redoButton,
      iconButton("shuffle", "Shuffle this scene's knobs (framing stays put)", () =>
        this.#shuffle(),
      ),
      iconButton("reset", "Reset this scene to its defaults", () =>
        this.#change({ scene: state().scene }, true, true),
      ),
      link,
      separator(),
      explain,
      keysPop.button,
      this.#status,
      iconButton("close", "Hide the lab (l)", () => this.setOpen(false)),
    );

    this.#syncers.push(() => {
      const paused = this.#host.renderer()?.paused ?? false;
      setStyle(playIcon, "display", paused ? "" : "none");
      setStyle(pauseIcon, "display", paused ? "none" : "");
      const playLabel = paused ? "Play (p)" : "Pause (p)";
      setAttr(play, "title", playLabel);
      setAttr(play, "aria-label", playLabel);
      setAttr(play, "aria-pressed", String(paused));
      motion.sync();
      setText(
        motionReadout,
        state().motion === 0 ? "still" : `${Math.round(state().motion * 100)}%`,
      );
      const passing = state().transitions === "on";
      setAttr(transitions, "aria-pressed", String(passing));
      setAttr(transitions, "title", `Scene transitions: ${passing ? "on" : "off (cuts)"}`);
      setAttr(explain, "aria-pressed", String(this.#prefs.explain));

      const scene = state().scene;
      const { title, accent } = sceneDefs[scene];
      if (sceneName.textContent !== title) {
        sceneName.textContent = title;
        scenePick.style.setProperty("--dot", accent);
        scenePick.title = `${title}: pick another scene ([ and ] step through them)`;
        scenePick.setAttribute("aria-label", `Scene: ${title}. Pick another`);
      }
      if (nowScene !== scene) {
        nowScene = scene;
        const triggers = sceneDefs[scene].params.filter(
          (def): def is ParamDef & { trigger: number } => def.trigger !== undefined,
        );
        nowList.replaceChildren(
          ...triggers.map((def) => {
            const whileOff = def.kind === "feature" || def.kind === "toggle";
            const slot = def.trigger;
            return h(
              "li",
              { class: "now-item" },
              icon(knobIcon(def)),
              h("span", {}, def.label),
              h("span", { class: "spacer" }),
              nowButton(def.label, () => this.#host.renderer()?.trigger(slot), { whileOff }),
            );
          }),
        );
        nowCount.textContent = triggers.length > 0 ? String(triggers.length) : "";
        nowPop.button.disabled = triggers.length === 0;
        const label =
          triggers.length > 0
            ? `Now: set off one of this scene's ${triggers.length} events`
            : "This scene has no events to set off";
        nowPop.button.title = label;
        nowPop.button.setAttribute("aria-label", label);
        if (triggers.length === 0) nowPop.toggle(false);
      }

      const comparison = this.#comparison;
      setHidden(flipGroup, comparison === undefined);
      setAttr(comparePop.button, "aria-pressed", String(comparison !== undefined));
      for (const { slot, button } of flips)
        setAttr(button, "aria-pressed", String(slot === comparison?.live));
      tourPop.button.classList.toggle("touring", this.#tour?.playing === true);
      setAttr(tourPop.button, "aria-pressed", String(this.#tour !== undefined));
    });
    return bar;
  }

  // ---- session tools: A/B comparison and tour -------------------------------------------------

  #compareContent(): HTMLElement[] {
    const start = textButton(
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
    const onRow = row({
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
    const stop = textButton("close", "Stop", "Stop comparing and keep the setup on screen", () =>
      this.#stopCompare(),
    );
    const active = h(
      "div",
      { class: "compare-active" },
      onRow.el,
      differs,
      h("div", { class: "lab-actions" }, copy, stop),
    );
    const blurb = h(
      "p",
      { class: "pop-note" },
      "Hold two complete setups, A and B, and flip between them.",
    );
    this.#syncers.push(onRow.sync, () => {
      const comparison = this.#comparison;
      setHidden(start, comparison !== undefined);
      setHidden(active, comparison === undefined);
      setHidden(this.#badge, comparison === undefined);
      if (!comparison) return;
      const here = this.#query();
      const live = this.#current().state.scene;
      const hidden = readState(new URLSearchParams(comparison.other)).scene;
      for (const { slot, button, scene } of slotButtons) {
        setAttr(button, "aria-pressed", String(slot === comparison.live));
        setText(scene, sceneDefs[slot === comparison.live ? live : hidden].title);
      }
      const keys = setupDifferences(here, comparison.other);
      setText(
        differs,
        keys.length === 0
          ? "A and B are the same setup: change the one on screen."
          : `They differ in ${keys.map((key) => this.#settingLabel(key, [live, hidden])).join(", ")}.`,
      );
      setText(copyLabel, `Copy to ${otherSlot(comparison.live).toUpperCase()}`);
      setText(this.#badge, `${comparison.live.toUpperCase()} · ${sceneDefs[live].title}`);
    });
    return [blurb, start, active];
  }

  /**
   * A URL key in words: a lab setting, a knob of one of `scenes` (a feature's amount after its
   * name), or the planets of one that takes them.
   */
  #settingLabel(key: string, scenes: readonly SceneId[]): string {
    if (Object.hasOwn(SETTING_LABEL, key)) return SETTING_LABEL[key as keyof LabState];
    if (key === PLANETS_KEY && scenes.some((scene) => sceneDefs[scene].planets !== undefined))
      return "planets";
    const amount = key.endsWith("-amount");
    const knob = amount ? key.slice(0, -"-amount".length) : key;
    for (const scene of scenes) {
      const def = sceneDefs[scene].params.find((candidate) => candidate.key === knob);
      if (def)
        return amount && def.kind === "feature" ? `${def.label} ${def.amountLabel}` : def.label;
    }
    return key;
  }

  #tourContent(): HTMLElement[] {
    const steps = h("ol", { class: "tour-steps", "aria-label": "Scenes on the tour" });
    let rendered = "";
    const picker = h("select", { class: "tour-picker", "aria-label": "Scene to add" });
    let offered = "";
    const add = textButton("plus", "Add", "Add the chosen scene at the end of the tour", () => {
      const scene = sceneIds.find((id) => id === picker.value);
      if (scene) this.#editTour([...(this.#tour?.tour.steps ?? []), { scene }]);
    });
    const addAll = textButton(
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
    const scenesRow = row({
      label: "Scenes",
      help: "The tour plays these in order and starts over after the last. Give a scene its own seconds, or leave it empty for the tour's. Click a name to go there now.",
      block: h(
        "div",
        { class: "tour-build" },
        steps,
        h("div", { class: "tour-add" }, picker, add, addAll),
      ),
    });
    const dwell = slider(
      "Seconds per scene",
      TOUR_DWELL.min,
      180,
      5,
      () => this.#tourDwell,
      (value) => this.#editTour(this.#tour?.tour.steps ?? [], value),
    );
    const dwellRow = row({
      label: "Each scene",
      help: "Seconds on each scene without its own, counted from the switch to it, on the scene clock: nothing passes while the clock is paused, and a slow frame counts at most a tenth of a second, so slow machines still give a growing scene its time.",
      block: dwell.el,
      readout: () => `${this.#tourDwell} s`,
      modified: () => this.#tourDwell !== TOUR_DWELL.fallback,
      reset: () => this.#editTour(this.#tour?.tour.steps ?? [], TOUR_DWELL.fallback),
    });
    const previous = iconButton("previous", "Previous scene on the tour ([ while it plays)", () =>
      this.#stepTour(-1),
    );
    const playIcon = icon("play");
    const pauseIcon = icon("pause");
    const playLabel = h("span");
    const play = h(
      "button",
      { type: "button", class: "text-button tour-play", title: "Play or pause the tour (t)" },
      playIcon,
      pauseIcon,
      playLabel,
    );
    play.addEventListener("click", () => this.toggleTour());
    const next = iconButton("next", "Next scene on the tour (] while it plays)", () =>
      this.#stepTour(1),
    );
    const clear = iconButton("trash", "Remove the tour", () => this.#editTour([]));
    const playRow = row({
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

    this.#syncers.push(scenesRow.sync, dwell.sync, dwellRow.sync, playRow.sync, () => {
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
        if (index === tour?.index) setAttr(item, "aria-current", "step");
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
      if (document.activeElement !== picker && available.includes(scene) && picker.value !== scene)
        picker.value = scene;
      for (const control of [picker, add, addAll])
        if (control.disabled !== (available.length === 0))
          control.disabled = available.length === 0;
      const playing = tour?.playing === true;
      setStyle(playIcon, "display", playing ? "none" : "");
      setStyle(pauseIcon, "display", playing ? "" : "none");
      setText(playLabel, playing ? "Pause" : "Play");
      for (const button of [previous, play, next, clear])
        if (button.disabled !== (tour === undefined)) button.disabled = tour === undefined;
      this.#syncTourClock();
    });
    return [
      h("p", { class: "pop-note" }, "Play chosen scenes one after another, each for a while."),
      scenesRow.el,
      dwellRow.el,
      playRow.el,
    ];
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
      this.#setScene(step.scene, "tour");
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
    const up = iconButton("up", `Move ${title} earlier`, () => move(-1));
    up.dataset.focus = `up:${step.scene}`;
    up.disabled = index === 0;
    const down = iconButton("down", `Move ${title} later`, () => move(1));
    down.dataset.focus = `down:${step.scene}`;
    down.disabled = index === list.length - 1;
    const remove = iconButton("close", `Remove ${title} from the tour`, () =>
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
    setHidden(progress, tour === undefined);
    setHidden(this.#barProgress, tour === undefined);
    if (!tour) {
      setText(status, "Add scenes to build a tour.");
      return;
    }
    const where =
      tour.step.scene !== this.#current().state.scene
        ? "paused: off the tour"
        : tour.playing
          ? `${Math.ceil(tour.dwell - tour.elapsed)} s left`
          : "paused";
    setText(
      status,
      `${tour.index + 1} / ${tour.tour.steps.length} · ${sceneDefs[tour.step.scene].title} · ${where}`,
    );
    const share = Math.round((tour.elapsed / tour.dwell) * 200) / 200;
    if (progress.value !== share) progress.value = share;
    setStyle(this.#barProgress, "--share", String(share));
  }

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
    if (!tour.follow(this.#current().state.scene)) this.#setScene(tour.step.scene, "tour");
    tour.playing = play;
    this.#runTour();
    this.sync();
  }

  /** Go `by` steps along the tour, playing or not. */
  #stepTour(by: number): void {
    const tour = this.#tour;
    if (!tour) return;
    this.#setScene(tour.skip(by), "tour");
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
    if (next !== undefined) this.#setScene(next, "tour");
    this.#syncTourClock();
    this.#tourFrame = requestAnimationFrame(this.#tourTick);
  };

  // ---- actions --------------------------------------------------------------------------------

  /**
   * Show `scene` at its own defaults; picked by hand (the Scenes view, [ and ], Next scene) while
   * "keep the world" is on, under the world of the scene left (world-model.ts `carryWorld`, and its
   * planets, `carryPlanets`).
   */
  #setScene(scene: SceneId, by: "hand" | "tour"): void {
    const { state, params, planets } = this.#current();
    if (scene === state.scene) return;
    const defaults = paramDefaults(scene);
    const keep = by === "hand" && this.#prefs.keepWorld;
    const from = sceneDefs[state.scene];
    const to = sceneDefs[scene];
    const next = keep ? carryWorld(from, params, to, defaults) : defaults;
    this.#host.apply(
      serialise(carryLook(state, scene), next, keep ? carryPlanets(from, planets, to) : []),
    );
    this.commit();
  }

  /** Every knob of the scene rolled (but its steady ones), and its planets with them. */
  #shuffle(): void {
    const scene = sceneDefs[this.#current().state.scene];
    const knobs = rollPatch(scene.params);
    this.#change(
      scene.planets
        ? { ...knobs, [PLANETS_KEY]: encodePlanets(scene.planets, rollPlanets(scene.planets)) }
        : knobs,
      true,
    );
  }

  #copyLink(button: HTMLButtonElement): void {
    const setup = new URLSearchParams(this.#query());
    for (const [key, value] of this.sessionQuery()) setup.append(key, value);
    const query = setup.toString();
    // From the setup, not the address bar, which the page writes a moment late (main.ts `showUrl`).
    const url = this.#host.build
      ? `${location.origin}/@${this.#host.build}/${query ? `?${query}` : ""}`
      : `${location.origin}${location.pathname}${query ? `?${query}` : ""}`;
    navigator.clipboard.writeText(url).then(
      () => this.#confirm(button, "Link copied"),
      () => this.#confirm(button, "Copy failed"),
    );
  }

  /** A short word over an icon button (it has no text of its own to flash). */
  #confirm(button: HTMLButtonElement, text: string): void {
    const tip = h("span", { class: "bar-tip", role: "status" }, text);
    button.append(tip);
    setTimeout(() => tip.remove(), 1500);
  }
}
