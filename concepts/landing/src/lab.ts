// The lab: one menu over the scene, built entirely from the scene catalogue and knob definitions,
// in two presentations (a lab preference): expanded, the inspector panel, whose views
// (lab/views.ts) are the scene picker (lab/gallery.ts), the presets (lab/presets.ts) and the
// controls (lab/inspector.ts); and compact, a bar of chips that open the same views and sections in
// popovers (lab/menu.ts). Both carry one row of tools: play, undo, redo, shuffle, and "⋯", a
// popover (lab/popover.ts) with the setup's and the session's tools: reset, the link,
// explanations, every "now", the A/B comparison (compare.ts), the scene tour (tour.ts) and the
// shortcuts (the motion and the transitions live in the Controls' Motion section alone). Every
// change goes through the host as a URL query (a scene's planets under their one key among its
// knobs), so links, presets and undo (lab/history-model.ts) all share one representation; the
// session tools sit beside the setup in the URL (`sessionQuery`) and never inside it. While the
// engine's view is on screen (`attachCanvas`, the canvas mode, lab/canvas.ts) the Controls edit its
// document instead of a scene's knobs, the picture takes the pointer, and undo steps through the
// document and the setup beside it as one history (lab/canvas-history-model.ts).
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
import type { EngineDoc } from "./engine/types.ts";
import { CanvasEditor } from "./lab/canvas.ts";
import type { SavedDoc } from "./lab/canvas-docs.ts";
import {
  canvasHistoryAt,
  recordCanvas,
  redoCanvas,
  undoCanvas,
  type CanvasHistory,
  type CanvasStep,
} from "./lab/canvas-history-model.ts";
import type { CanvasHost } from "./lab/canvas-host.ts";
import { sceneCycle, sceneStep } from "./lab/gallery-model.ts";
import { SceneGallery } from "./lab/gallery.ts";
import { flash, iconButton, nowButton, row, slider, textButton } from "./lab/controls.ts";
import {
  h,
  setAttr,
  setHidden,
  setStyle,
  setText,
  type LabContext,
  type Patch,
} from "./lab/dom.ts";
import {
  historyAt,
  record,
  redoStep,
  undoStep,
  type CommitBy,
  type History,
} from "./lab/history-model.ts";
import { icon } from "./lab/icons.ts";
import { Inspector } from "./lab/inspector.ts";
import { knobIcon } from "./lab/knobs.ts";
import { MenuBar } from "./lab/menu.ts";
import { Workspace, type PanelLayout } from "./lab/panels.ts";
import { rollPlanets } from "./lab/planets-model.ts";
import { fold, Popover } from "./lab/popover.ts";
import { PREFS_KEY, readPrefs, type Presentation } from "./lab/prefs.ts";
import { PresetsView } from "./lab/presets.ts";
import { rollPatch } from "./lab/roll-model.ts";
import { sceneChange, type SceneChangeBy } from "./lab/scene-change-model.ts";
import { Views } from "./lab/views.ts";
import { carryPlanets, carryWorld } from "./lab/world-model.ts";
import type { ParamDef } from "./params.ts";
import type { DitherRenderer, SceneFailure } from "./renderer.ts";
import { prefetchScene, sceneDefs, type SceneId } from "./scenes/index.ts";
import { CAMERA_KEY, type CameraPose } from "./composer/camera.ts";
import { ELEMENTS_KEY } from "./composer/elements.ts";
import type { LightElement } from "./composer/types.ts";
import { encodePlanets, PLANETS_KEY, type SkyPlanet } from "./scenes/planets.ts";
import {
  carryLook,
  paramDefaults,
  readPlanets,
  readState,
  serialise,
  type LabState,
  type Params,
} from "./state.ts";
import { clampDwell, readTour, TOUR_DWELL, TourPlayer, writeTour, type TourStep } from "./tour.ts";

export interface LabHost {
  current(): {
    state: LabState;
    params: Params;
    planets: readonly SkyPlanet[];
    elements: readonly LightElement[];
    camera: CameraPose;
  };
  /**
   * Replace the whole setup. The host re-renders, then calls `Lab.sync()`. `cut`: switch scenes at
   * once, without the passage (an A/B flip). `keepClocks`: the scene switched to takes over the
   * clocks of the one left, so the world kept goes on where it stood. `crossfade`: it takes the
   * screen over from the one left in a plain crossfade, without their exit and entrance (two scenes
   * of one baseline: DitherRenderer.update).
   */
  apply(
    query: URLSearchParams,
    options?: { cut?: boolean; keepClocks?: boolean; crossfade?: boolean },
  ): void;
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
  pixel: "cell size",
  levels: "tones",
  motion: "motion",
  accent: "accent",
  instance: "instance name",
  mouse: "follow mouse",
  agents: "agents",
  rest: "rate at rest",
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
  ["[  ]", "previous / next scene, in the Scenes view's order (tour step while a tour plays)"],
  ["l", "show or hide the lab"],
  ["/", "find a control (from the bar, in the panel until Esc)"],
  ["p", "pause or play"],
  ["b", "flip between A and B; hold to peek"],
  ["t", "play or pause the tour"],
  ["Ctrl Z", "undo"],
  ["Ctrl ⇧ Z", "redo"],
  ["W A S D Q E", "the canvas: fly its camera (the picture clicked first; ⇧ faster)"],
  ["Esc", "the canvas: let go of the object selected (the picture clicked first)"],
];

/** The engine's canvas scene (src/scenes/canvas), where this build has it. */
const CANVAS_SCENE = "canvas";

/** The canvas mode while an engine view is attached (Lab.attachCanvas). */
interface Canvas {
  readonly host: CanvasHost;
  readonly editor: CanvasEditor;
  /** The scene on screen as it was attached: setup commits on it are the canvas's undo steps. */
  readonly scene: SceneId;
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
  /** The compact presentation: the menu laid flat along a bar. */
  readonly #bar: MenuBar;
  /** The tools, in the inspector's foot or on the bar, as the presentation has them. */
  readonly #tools: HTMLElement;
  /** The inspector panel's foot: the tools, while expanded. */
  readonly #foot = h("div", { class: "panel-foot" });
  /** The way from the inspector to the bar (the bar's own leads back, MenuBar.expand). */
  readonly #minimise: HTMLButtonElement;
  readonly #syncers: (() => void)[] = [];
  /**
   * The presentation on screen: the preference, except while `/` from the bar has the panel up
   * for this session (focusSearch), until Escape in the search or the lab closes.
   */
  #presentation: Presentation = this.#prefs.presentation;
  /** The undo history of the setup on screen (with a comparison, the live slot's). */
  #history: History;
  /** The steps the undo and redo buttons last named (#syncHistory). */
  #historyShown = "";
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
  /** The tour's place beside the tools while it plays: the step, and the step's time as a line. */
  readonly #tourMark = h("span", { class: "tool-tour", hidden: true });
  readonly #tourStep = h("span", { class: "tool-tour-step" });
  readonly #tourBar = h("span", { class: "tool-tour-bar", "aria-hidden": "true" });
  readonly #reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  readonly #undoButton: HTMLButtonElement;
  readonly #redoButton: HTMLButtonElement;
  /** The build, the frame rate and the GPU, at the foot of the tools' popover. */
  readonly #status = h("p", { class: "tools-status" });
  /** Polls the status and a failed scene while the lab is open (setOpen). */
  #statusTimer: number | undefined;
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
  /** The canvas mode, while an engine view is attached (attachCanvas). */
  #canvas: Canvas | undefined;
  /**
   * The canvas's undo history and the document "New" starts from, kept across a detach: back on
   * the same canvas scene, the document is as it was left, with its undo.
   */
  #canvasSession: { scene: SceneId; history: CanvasHistory; starter: EngineDoc } | undefined;
  /** A saved document picked while no view was attached: it opens once one is. */
  #pendingDoc: SavedDoc | undefined;

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
    this.#history = historyAt(this.#query());
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
    // The Scenes view's custom cards load a saved setup as the Presets view does.
    const load = (query: string) => {
      host.apply(new URLSearchParams(query));
      this.commit();
    };
    this.#gallery = new SceneGallery(this.#ctx, {
      setScene: (scene) => this.#setScene(scene, "hand"),
      load,
      query: () => this.#query(),
      openDoc: (saved) => this.#openDoc(saved),
    });
    this.#presets = new PresetsView(this.#ctx, {
      load,
      compare: (a, b) => this.#compareWith(a, b),
      query: () => this.#query(),
      build: host.build,
    });
    const prefs = this.#prefs;
    this.#inspector = new Inspector(
      this.#ctx,
      {
        sections: prefs.sections,
        get keepWorld() {
          return prefs.keepWorld;
        },
        set keepWorld(keep: boolean) {
          prefs.keepWorld = keep;
        },
        save,
      },
      () => this.#leaveSearch(),
    );
    this.#minimise = iconButton("minimise", "Minimise the lab to a bar", () =>
      this.#present("compact", true),
    );
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
      () => this.#workspace.raiseSheet(),
      () => this.#pickScene(),
      [this.#minimise],
    );
    this.#undoButton = iconButton("undo", "Undo (Ctrl Z)", () => this.undo());
    this.#redoButton = iconButton("redo", "Redo (Ctrl ⇧ Z)", () => this.redo());
    this.#tools = this.#toolRow();
    // The bar opens the panel's own views and sections, lent to its popovers while they are open.
    this.#bar = new MenuBar(
      root,
      this.#inspector,
      {
        scenes: {
          el: this.#gallery.el,
          shown: () => {
            this.#gallery.sync();
            this.#gallery.shown();
          },
          focus: () => this.#gallery.focusCurrent(),
        },
        presets: {
          el: this.#presets.el,
          shown: () => {
            this.#presets.sync();
            this.#presets.shown();
          },
        },
      },
      () => this.#present("expanded", true),
    );

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
      docks: ["left", "right"],
      bar: false,
      min: { w: 280, h: 240 },
      max: { w: 560 },
      head: this.#views.head,
      body: h("div", { class: "panel-frame" }, this.#views.body, this.#foot),
      initial: ({ h: vh }) => ({
        dock: "float",
        ax: "right",
        x: 16,
        ay: "top",
        y: 16,
        w: 352,
        h: Math.round(vh - 32),
      }),
    });
    this.#workspace.add({
      id: "bar",
      title: "Lab bar",
      docks: ["top", "bottom"],
      bar: true,
      min: { w: 200, h: 40 },
      max: { w: 4000 },
      body: this.#bar.el,
      initial: () => ({
        dock: "float",
        ax: "center",
        x: 0,
        ay: "bottom",
        y: 16,
        w: 640,
        h: 44,
      }),
    });
    this.#layOut(this.#presentation);

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
    if (open) {
      this.#workspace.arrange();
      // The controls skipped their syncs while the lab was closed: on screen again, they catch up.
      if (this.#presentation === "expanded" && this.#views.current === "controls")
        this.#inspector.shown();
      // The build's status and a failed scene's alert show only in the open lab: polled while open.
      this.#statusTimer ??= window.setInterval(() => this.#syncStatus(), 500);
      this.#syncStatus();
    } else {
      Popover.closeAll();
      window.clearInterval(this.#statusTimer);
      this.#statusTimer = undefined;
      // A session's panel (`/` from the bar) closes back to the bar.
      if (this.#presentation !== this.#prefs.presentation) this.#present(this.#prefs.presentation);
    }
    // Knob changes are likely while the lab is open: on a GPU, scenes with knob-keyed features get
    // their all-features program built ahead (DitherRenderer.expectChanges).
    this.#host.renderer()?.expectChanges(open);
    // The canvas takes the picture's pointer, and shows its selection, while the lab is open.
    this.#canvas?.editor.setActive(open);
  }

  /**
   * `/`: the keyboard to the control search, in the panel. From the bar the panel comes up for
   * this session only (the bar stays the preference, its Find chip the search in a popover): Escape
   * in the search, or closing the lab, brings the bar back.
   */
  focusSearch(): void {
    this.setOpen(true);
    if (this.#presentation === "compact") this.#present("expanded", false, false);
    this.#views.show("controls");
    this.#inspector.focusSearch();
  }

  /** Escape left the search: a session's panel goes back to the bar, the keyboard to Find. */
  #leaveSearch(): void {
    if (this.#presentation === this.#prefs.presentation) return;
    this.#present(this.#prefs.presentation);
    this.#bar.find.focus();
  }

  /**
   * Reflect the host's current state into the lab's controls: the Controls view's in full only while
   * on screen, catching up as it comes back.
   */
  sync(): void {
    const { state } = this.#current();
    const compact = this.#presentation === "compact";
    // The notice explains the scene it went up over: once another scene is on screen, it goes.
    if (this.#noticeScene !== undefined && state.scene !== this.#noticeScene) this.#dismissNotice();
    // A step of the tour (its own switch or the user's) becomes the current one; another scene holds it.
    this.#tour?.follow(state.scene);
    // The canvas's selection and its cue follow the document.
    this.#canvas?.editor.sync();
    // The Scenes and Presets views reflect the setup only while on screen, in the panel or the bar.
    if (compact ? this.#bar.showing("scenes") : this.#views.current === "scenes")
      this.#gallery.sync();
    if (compact ? this.#bar.showing("presets") : this.#views.current === "presets")
      this.#presets.sync();
    // The controls follow in full only while on screen (the open lab on the Controls view, in the
    // panel or the bar's Find popover, or a section lent to the bar); off it only their counts,
    // which the bar's chips read.
    this.#inspector.sync(
      this.open && (compact ? this.#bar.showing("controls") : this.#views.current === "controls"),
    );
    if (compact) this.#bar.sync();
    for (const sync of this.#syncers) sync();
    const scene = sceneDefs[state.scene];
    this.#views.setScene(scene.title, scene.accent);
    this.#bar.setScene(scene.title, scene.accent);
    this.#syncHistory();
  }

  /**
   * Show the lab as `presentation`, from now on unless `save` is false (a session's panel): the
   * popovers close, the tools move there, and the keyboard, if `focus`, goes to the way back.
   */
  #present(presentation: Presentation, focus = false, save = true): void {
    Popover.closeAll();
    this.#presentation = presentation;
    if (save) {
      this.#prefs.presentation = presentation;
      this.#savePrefs();
    }
    this.#layOut(presentation);
    if (this.open) this.#workspace.arrange();
    this.sync();
    if (presentation === "expanded" && this.#views.current === "controls") this.#inspector.shown();
    if (focus) (presentation === "compact" ? this.#bar.expand : this.#minimise).focus();
  }

  /** Put the tools and the panels where `presentation` has them. */
  #layOut(presentation: Presentation): void {
    const compact = presentation === "compact";
    (compact ? this.#bar.tools : this.#foot).append(this.#tools);
    this.#workspace.setShown("inspector", !compact);
    this.#workspace.setShown("bar", compact);
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

  /**
   * Record the current setup as an undo step (sliders commit on release): a commit to the same
   * keys as the step before it, within a second of it, grows that step (lab/history-model.ts).
   */
  commit(): void {
    this.#commit("hand");
  }

  #commit(by: CommitBy): void {
    // On the canvas, a change of the setup is a step of the canvas's own history, beside its document.
    const canvas = this.#canvas;
    const history = this.#canvasSession?.history;
    if (canvas && history && this.#current().state.scene === canvas.scene) {
      const query = this.#query();
      const keys = setupDifferences(history.committed.query, query).sort();
      if (keys.length === 0) this.#recordCanvas("document", "the document");
      else
        this.#recordCanvas(
          `setup:${keys.join(" ")}`,
          this.#stepWords(history.committed.query, query),
        );
      return;
    }
    if (record(this.#history, this.#query(), performance.now(), by)) this.#syncHistory();
  }

  /** Step back: on the canvas through its own history, and past its first step through the setup's. */
  undo(): void {
    if (this.#canvas && this.#canvasSession?.history.undo.length) {
      this.#stepCanvas(undoCanvas);
      return;
    }
    const previous = undoStep(this.#history);
    if (previous !== undefined) this.#host.apply(new URLSearchParams(previous));
  }

  redo(): void {
    if (this.#canvas && this.#canvasSession?.history.redo.length) {
      this.#stepCanvas(redoCanvas);
      return;
    }
    const next = redoStep(this.#history);
    if (next !== undefined) this.#host.apply(new URLSearchParams(next));
  }

  /**
   * The canvas mode: while `host`'s engine view is on screen, the Controls show its document
   * (lab/canvas.ts) in place of the scene's knobs, the picture takes the pointer while the lab is
   * open, and undo steps through the document and the setup beside it as one history. Back on the
   * canvas after leaving it, the document is as it was left; a saved document picked meanwhile
   * (the Scenes view's Canvas shelf) opens.
   */
  attachCanvas(host: CanvasHost): void {
    this.detachCanvas();
    const scene = this.#current().state.scene;
    // The setup's own history learns the canvas (an undo from another scene comes back to it).
    this.#commit("hand");
    const query = this.#query();
    const kept = this.#canvasSession?.scene === scene ? this.#canvasSession : undefined;
    if (kept) {
      host.view.setDoc(kept.history.committed.doc);
      kept.history.committed = { ...kept.history.committed, query };
    }
    const session = kept ?? {
      scene,
      history: canvasHistoryAt({ doc: host.view.doc, query, words: "" }),
      starter: host.view.doc,
    };
    this.#canvasSession = session;
    const editor = new CanvasEditor(host, {
      ctx: this.#ctx,
      worldDefs: sceneDefs[scene].params,
      starter: session.starter,
      layer: this.#root,
      commit: (what, words) => this.#recordCanvas(what, words),
      changed: () => this.sync(),
      reveal: (id) => {
        if (this.#presentation === "expanded") this.#views.show("controls");
        this.#inspector.reveal(id);
      },
    });
    this.#canvas = { host, editor, scene };
    this.#inspector.setCanvas(editor.controls);
    editor.setActive(this.open);
    const pending = this.#pendingDoc;
    this.#pendingDoc = undefined;
    if (pending) editor.open(pending);
    this.sync();
  }

  /** Leave the canvas mode: the view is gone, the scene's own controls come back. */
  detachCanvas(): void {
    const canvas = this.#canvas;
    if (!canvas) return;
    this.#canvas = undefined;
    canvas.editor.detach();
    this.#inspector.setCanvas(undefined);
    // The setup's own history goes on from the setup as it now stands.
    this.#commit("hand");
    this.sync();
  }

  /** Record the canvas's document and the setup beside it as an undo step of change `what`. */
  #recordCanvas(what: string, words: string): void {
    const canvas = this.#canvas;
    const history = this.#canvasSession?.history;
    if (!canvas || !history) return;
    const step: CanvasStep = { doc: canvas.host.view.doc, query: this.#query(), words };
    if (recordCanvas(history, step, performance.now(), what)) this.#syncHistory();
  }

  /** Show the canvas's step `step` takes it to: the setup, then the document over it. */
  #stepCanvas(step: (history: CanvasHistory) => CanvasStep | undefined): void {
    const canvas = this.#canvas;
    const history = this.#canvasSession?.history;
    const to = canvas && history && step(history);
    if (!canvas || !to) return;
    if (to.query !== this.#query()) this.#host.apply(new URLSearchParams(to.query));
    canvas.host.view.setDoc(to.doc);
    this.sync();
  }

  /**
   * Open saved document `saved` (the Scenes view's Canvas shelf): in the canvas on screen, or once
   * the canvas scene, shown for it, attaches its view.
   */
  #openDoc(saved: SavedDoc): void {
    const canvas = this.#canvas;
    if (canvas) {
      canvas.editor.open(saved);
      return;
    }
    const scene = Object.keys(sceneDefs).find((id): id is SceneId => id === CANVAS_SCENE);
    if (scene === undefined) {
      const { scene: here } = this.#current().state;
      this.#noticeScene = here;
      setText(this.#noticeText, `No canvas in this build to open “${saved.name}” in.`);
      setHidden(this.#notice, false);
      return;
    }
    this.#pendingDoc = saved;
    this.#setScene(scene, "hand");
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

  /**
   * Go to the previous (-1) or next (1) scene in the Scenes view's order less the lab-only scenes
   * (lab/gallery-model.ts `sceneCycle`), as a scene picked by hand.
   */
  stepScene(by: -1 | 1): void {
    this.#setScene(sceneStep(this.#current().state.scene, by), "hand");
  }

  // ---- state plumbing -------------------------------------------------------------------------

  #current(): {
    state: LabState;
    params: Params;
    planets: readonly SkyPlanet[];
    elements: readonly LightElement[];
    camera: CameraPose;
  } {
    return this.#host.current();
  }

  #query(): string {
    const { state, params, planets, elements, camera } = this.#current();
    return serialise(state, params, planets, elements, camera).toString();
  }

  /** Apply a patch over the current setup; `replace` starts from the patch alone. */
  #change(patch: Patch, commit: boolean, replace = false): void {
    const { state, params, planets, elements, camera } = this.#current();
    const q = replace ? new URLSearchParams() : serialise(state, params, planets, elements, camera);
    for (const [key, value] of Object.entries(patch)) q.set(key, String(value));
    this.#host.apply(q);
    if (commit) this.commit();
  }

  #savePrefs(): void {
    localStorage.setItem(PREFS_KEY, JSON.stringify(this.#prefs));
  }

  /**
   * The undo and redo buttons: off with nothing to step to, else named by what the step changes; on
   * the canvas its own steps first (named by the words they were recorded with), past them the
   * setup's.
   */
  #syncHistory(): void {
    const canvas = this.#canvas ? this.#canvasSession?.history : undefined;
    const canvasBack = canvas && canvas.undo.length > 0 ? canvas.committed.words : undefined;
    const canvasAhead = canvas?.redo.at(-1)?.words;
    const { undo, redo, committed } = this.#history;
    const [back, ahead] = [undo.at(-1), redo.at(-1)];
    const shown = [
      canvas ? `${canvas.undo.length} ${canvas.redo.length} ${canvasBack} ${canvasAhead}` : "",
      back ?? "",
      committed,
      ahead ?? "",
    ].join("\n");
    if (shown === this.#historyShown) return;
    this.#historyShown = shown;
    for (const [button, verb, keys, words] of [
      [
        this.#undoButton,
        "Undo",
        "Ctrl Z",
        canvasBack ?? (back === undefined ? undefined : this.#stepWords(committed, back)),
      ],
      [
        this.#redoButton,
        "Redo",
        "Ctrl ⇧ Z",
        canvasAhead ?? (ahead === undefined ? undefined : this.#stepWords(committed, ahead)),
      ],
    ] as const) {
      if (button.disabled !== (words === undefined)) button.disabled = words === undefined;
      const label = words === undefined || words === "" ? verb : `${verb}: ${words}`;
      setAttr(button, "title", `${label} (${keys})`);
      setAttr(button, "aria-label", label);
    }
  }

  /** A step from setup `from` to `to` in a few words: the scene it goes to, or what it sets. */
  #stepWords(from: string, to: string): string {
    const scene = readState(new URLSearchParams(to)).scene;
    if (readState(new URLSearchParams(from)).scene !== scene) return sceneDefs[scene].title;
    const names = [
      ...new Set(setupDifferences(from, to).map((key) => this.#settingLabel(key, [scene]))),
    ];
    return names.length > 3 ? `${names.slice(0, 3).join(", ")}…` : names.join(", ");
  }

  #syncStatus(): void {
    const renderer = this.#host.renderer();
    const gpu = renderer?.glInfo.split(" · ")[1] ?? "WebGL2 unavailable";
    const build = this.#host.build ? `build ${this.#host.build}` : "working tree";
    const fps = renderer ? `${Math.round(renderer.fps)} fps` : "no WebGL";
    setText(this.#status, `${build} · ${renderer?.paused ? `${fps}, paused` : fps} · ${gpu}`);
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

  // ---- the tools ------------------------------------------------------------------------------

  /**
   * The tools, in either presentation (the inspector's foot, or the bar): play or pause, undo, redo
   * and shuffle at hand; A and B while a comparison runs; the tour's place while it plays; and
   * "⋯", a popover with the rest.
   */
  #toolRow(): HTMLElement {
    const playIcon = icon("play");
    const pauseIcon = icon("pause");
    const play = h("button", { type: "button", class: "icon-button" }, playIcon, pauseIcon);
    play.addEventListener("click", () => {
      const renderer = this.#host.renderer();
      renderer?.setPaused(!renderer.paused);
      this.sync();
    });
    const flips = slots.map((slot) => {
      const button = h(
        "button",
        { type: "button", class: "tool-slot", title: `Show ${slot.toUpperCase()} (b flips)` },
        slot.toUpperCase(),
      );
      button.addEventListener("click", () => this.#showSlot(slot));
      return { slot, button };
    });
    const flipGroup = h(
      "div",
      { class: "tool-slots", role: "group", "aria-label": "Setup on screen", hidden: true },
      ...flips.map(({ button }) => button),
    );
    this.#tourMark.append(icon("tour"), this.#tourStep, this.#tourBar);
    // The keyboard goes to its first control on screen, Reset.
    const more = new Popover(this.#root, {
      id: "tools",
      title: "Tools",
      icon: "more",
      label: "More tools: reset, link, explanations, every now, A/B, tour and shortcuts",
      content: this.#toolsContent(),
    });
    this.#syncers.push(() => {
      const paused = this.#host.renderer()?.paused ?? false;
      setStyle(playIcon, "display", paused ? "" : "none");
      setStyle(pauseIcon, "display", paused ? "none" : "");
      const playLabel = paused ? "Play (p)" : "Pause (p)";
      setAttr(play, "title", playLabel);
      setAttr(play, "aria-label", playLabel);
      setAttr(play, "aria-pressed", String(paused));
      const comparison = this.#comparison;
      setHidden(flipGroup, comparison === undefined);
      for (const { slot, button } of flips)
        setAttr(button, "aria-pressed", String(slot === comparison?.live));
    });
    return h(
      "div",
      { class: "tool-row", role: "group", "aria-label": "Tools" },
      play,
      this.#undoButton,
      this.#redoButton,
      iconButton("shuffle", "Shuffle this scene's knobs (framing stays put)", () =>
        this.#shuffle(),
      ),
      flipGroup,
      this.#tourMark,
      h("span", { class: "spacer" }),
      more.button,
    );
  }

  /**
   * The tools' popover: the setup's own actions (reset, link, explanations), then a fold each for
   * every "now", the A/B comparison, the tour and the shortcuts, and the build's status at the foot.
   * The motion and the transitions are the Controls' Motion section's alone.
   */
  #toolsContent(): HTMLElement[] {
    const state = () => this.#current().state;
    const explain = textButton("info", "Explain", "Explain every control", () => {
      this.#prefs.explain = !this.#prefs.explain;
      this.#root.classList.toggle("explain", this.#prefs.explain);
      this.#savePrefs();
      this.sync();
    });
    const actions = h(
      "div",
      { class: "lab-actions" },
      textButton("reset", "Reset", "Reset this scene to its defaults", () =>
        this.#change({ scene: state().scene }, true, true),
      ),
      textButton(
        "link",
        "Copy link",
        "Copy a link that replays this exact setup on this build, with its A/B comparison and tour",
        (button) => this.#copyLink(button),
      ),
      explain,
    );

    // Every "now" of the scene, in one list.
    const nowList = h("ul", { class: "now-list" });
    let nowScene: SceneId | undefined;
    const now = fold({
      id: "now",
      icon: "bolt",
      title: "Now",
      content: [
        h(
          "p",
          { class: "pop-note" },
          "One of each event right now, whether or not it is switched on.",
        ),
        nowList,
      ],
    });
    const compare = fold({
      id: "compare",
      icon: "compare",
      title: "Compare A/B",
      content: this.#compareContent(),
    });
    const tour = fold({ id: "tour", icon: "tour", title: "Tour", content: this.#tourContent() });
    const keys = fold({
      id: "keys",
      icon: "keyboard",
      title: "Shortcuts",
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
      ],
    });

    this.#syncers.push(() => {
      setAttr(explain, "aria-pressed", String(this.#prefs.explain));
      const scene = state().scene;
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
        // A scene without events has no list to fold.
        setHidden(now.el, triggers.length === 0);
        setText(now.note, `${triggers.length} event${triggers.length === 1 ? "" : "s"}`);
      }
      const comparison = this.#comparison;
      setText(compare.note, comparison ? `${comparison.live.toUpperCase()} on screen` : "");
      const touring = this.#tour;
      const steps = touring?.tour.steps.length ?? 0;
      setText(
        tour.note,
        touring
          ? `${steps} scene${steps === 1 ? "" : "s"}${touring.playing ? " · playing" : ""}`
          : "",
      );
    });
    return [actions, now.el, compare.el, tour.el, keys.el, this.#status];
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
   * name), the planets of one that takes them, or a room's light elements or camera.
   */
  #settingLabel(key: string, scenes: readonly SceneId[]): string {
    if (Object.hasOwn(SETTING_LABEL, key)) return SETTING_LABEL[key as keyof LabState];
    if (key === PLANETS_KEY && scenes.some((scene) => sceneDefs[scene].planets !== undefined))
      return "planets";
    if (key === ELEMENTS_KEY && scenes.some((scene) => sceneDefs[scene].elements !== undefined))
      return "light elements";
    if (key === CAMERA_KEY && scenes.some((scene) => sceneDefs[scene].camera !== undefined))
      return "camera";
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
      const scene = sceneCycle.find((id) => id === picker.value);
      if (scene) this.#editTour([...(this.#tour?.tour.steps ?? []), { scene }]);
    });
    const addAll = textButton(
      "plus",
      "All",
      "Add every scene not on the tour yet, in the Scenes view's order",
      () => {
        const on = this.#tour?.tour.steps ?? [];
        this.#editTour([
          ...on,
          ...sceneCycle
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
      const available = sceneCycle.filter((id) => !list.some((step) => step.scene === id));
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

  /**
   * The tour's place in words and as bars, in its fold and beside the tools; runs every frame
   * while it plays.
   */
  #syncTourClock(): void {
    const tour = this.#tour;
    const status = this.#tourStatus;
    const progress = this.#tourProgress;
    setHidden(progress, tour === undefined);
    setHidden(this.#tourMark, tour?.playing !== true);
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
    const steps = tour.tour.steps.length;
    const title = sceneDefs[tour.step.scene].title;
    setText(status, `${tour.index + 1} / ${steps} · ${title} · ${where}`);
    setText(this.#tourStep, `${tour.index + 1}/${steps}`);
    setAttr(
      this.#tourMark,
      "title",
      `Tour: ${title}, ${tour.index + 1} of ${steps} · ${where} (t pauses)`,
    );
    const share = Math.round((tour.elapsed / tour.dwell) * 200) / 200;
    if (progress.value !== share) progress.value = share;
    setStyle(this.#tourBar, "--share", String(share));
  }

  /** Keep the setup on screen as A and go on editing a copy of it as B, with the history so far. */
  #startCompare(): void {
    this.commit();
    const here = this.#query();
    this.#comparison = { live: "b", other: here };
    this.#hiddenHistory = historyAt(here);
    this.#host.apply(new URLSearchParams(here));
  }

  /** Compare setup `a` (hidden, with an undo history of its own) with `b`, loaded as B. */
  #compareWith(a: string, b: string): void {
    this.commit();
    this.#comparison = { live: "b", other: a };
    this.#hiddenHistory = historyAt(a);
    this.#host.apply(new URLSearchParams(b));
    this.commit();
  }

  #stopCompare(): void {
    this.#comparison = undefined;
    this.#hiddenHistory = undefined;
    this.#host.apply(new URLSearchParams(this.#query()));
  }

  /**
   * Show `slot`'s setup at once, on the clocks of the setup left (two scenes compared at the same
   * moment); the one on screen waits in its own slot, with its own undo.
   */
  #showSlot(slot: Slot): void {
    const comparison = this.#comparison;
    if (!comparison || comparison.live === slot) return;
    this.commit();
    const leaving = this.#history;
    this.#history = this.#hiddenHistory ?? historyAt(comparison.other);
    this.#hiddenHistory = leaving;
    this.#comparison = { live: slot, other: leaving.committed };
    this.#host.apply(new URLSearchParams(comparison.other), { cut: true, keepClocks: true });
  }

  /** Make the hidden slot the setup on screen, as an undo step of the hidden slot's own. */
  #copyToHidden(): void {
    const comparison = this.#comparison;
    if (!comparison) return;
    this.commit();
    const here = this.#query();
    const hidden = this.#hiddenHistory ?? historyAt(comparison.other);
    record(hidden, here, performance.now());
    this.#hiddenHistory = hidden;
    this.#comparison = { live: comparison.live, other: here };
    this.#host.apply(new URLSearchParams(here));
  }

  /**
   * Show the tour's scene (the current step unless the page already shows one) and play or hold
   * it, fetching the next step's code ahead (as every step that starts does).
   */
  #beginTour(play: boolean): void {
    const tour = this.#tour;
    if (!tour) return;
    if (!tour.follow(this.#current().state.scene)) this.#setScene(tour.step.scene, "tour");
    tour.playing = play;
    prefetchScene(tour.upcoming);
    this.#runTour();
    this.sync();
  }

  /** Go `by` steps along the tour, playing or not. */
  #stepTour(by: number): void {
    const tour = this.#tour;
    if (!tour) return;
    this.#setScene(tour.skip(by), "tour");
    prefetchScene(tour.upcoming);
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
    if (next !== undefined) {
      this.#setScene(next, "advance");
      prefetchScene(tour.upcoming);
    }
    this.#syncTourClock();
    this.#tourFrame = requestAnimationFrame(this.#tourTick);
  };

  // ---- actions --------------------------------------------------------------------------------

  /**
   * Show `scene` at its own defaults; picked by hand (the Scenes view, [ and ], Next scene) while
   * "keep the world" is on, or within one baseline (its own scene and its variants) whatever that
   * says, under the world of the scene left (world-model.ts `carryWorld`, and its planets,
   * `carryPlanets`), within one baseline crossfading into it (lab/scene-change-model.ts). A playing
   * tour's own `advance` joins the undo step of the advance before it, so one undo goes back to
   * where the tour began (lab/history-model.ts).
   */
  #setScene(scene: SceneId, by: SceneChangeBy): void {
    const { state, params, planets } = this.#current();
    if (scene === state.scene) return;
    const defaults = paramDefaults(scene);
    const { keepWorld: keep, crossfade } = sceneChange(
      state.scene,
      scene,
      by,
      this.#prefs.keepWorld,
    );
    const from = sceneDefs[state.scene];
    const to = sceneDefs[scene];
    const next = keep ? carryWorld(from, params, to, defaults) : defaults;
    const sky = keep ? carryPlanets(from, planets, to) : readPlanets(scene, new URLSearchParams());
    this.#host.apply(serialise(carryLook(state, scene), next, sky), {
      keepClocks: keep,
      crossfade,
    });
    this.#commit(by === "advance" ? "advance" : "hand");
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
      () => flash(button, "Link copied"),
      () => flash(button, "Copy failed"),
    );
  }
}
