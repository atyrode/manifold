// Page controller: owns the current setup (from the URL), drives the renderer and the page on top,
// and hands the lab a host interface. Every change is a URL query applied here, read as a link is
// (state.ts `readSetup`: this build's keys, an unknown scene reported).
import { Lab } from "./lab.ts";
import { sceneStep } from "./lab/gallery-model.ts";
import { kinds } from "./engine/kinds/index.ts";
import { CANVAS_SCENE, createEngineView } from "./engine/view.ts";
import { DitherRenderer } from "./renderer.ts";
import { loadScene, prefetchScene, type SceneId } from "./scenes/index.ts";
import type { CameraPose } from "./composer/camera.ts";
import type { LightElement } from "./composer/types.ts";
import type { SkyPlanet } from "./scenes/planets.ts";
import {
  accentOf,
  palette,
  readSetup,
  renderSettings,
  serialise,
  type LabState,
  type Params,
} from "./state.ts";

function element<T extends Element>(selector: string, type: new () => T): T {
  const found = document.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`landing: missing ${selector}`);
  return found;
}

/** The commit this page was built from; empty when served straight from a working tree. */
const build = document.querySelector<HTMLMetaElement>('meta[name="landing-build"]')?.content ?? "";
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const bar = element("#bar", HTMLElement);
const status = element("#status", HTMLElement);
const instanceName = element("#instance-name", HTMLElement);
const stage = element("#stage", HTMLCanvasElement);

const initial = new URLSearchParams(location.search);
const opened = readSetup(initial);
let state: LabState = opened.state;
let params: Params = opened.params;
let planets: SkyPlanet[] = opened.planets;
let elements: LightElement[] = opened.elements;
let camera: CameraPose = opened.camera;

let renderer: DitherRenderer | undefined;
try {
  renderer = new DitherRenderer(
    stage,
    renderSettings(state, params, planets, elements, camera),
    reducedMotion.matches,
  );
  renderer.start();
  // The code of the scene the page opens on (a chunk of its own: src/scenes/index.ts `loadScene`)
  // is fetched now, while the lab is built, rather than on the renderer's first frame.
  prefetchScene(state.scene);
} catch (error: unknown) {
  console.error("evt=landing.renderer.unavailable", error);
}

/**
 * The engine's view of its document (src/engine), while the canvas scene is on screen: the lab edits
 * the document through it (Lab.attachCanvas), and a change of the document's World comes back here
 * as the scene's knobs.
 */
const engine =
  renderer === undefined
    ? undefined
    : createEngineView(renderer, (world) => {
        if (state.scene === CANVAS_SCENE)
          apply(serialise(state, { ...params, ...world }, planets, elements, camera));
      });
let canvasAttached = false;

/** The lab's canvas mode follows the scene on screen: attached on the canvas, detached off it. */
function followCanvas(): void {
  const view = state.scene === CANVAS_SCENE ? engine : undefined;
  const drawn = renderer;
  if ((view !== undefined) === canvasAttached) return;
  canvasAttached = view !== undefined;
  if (view !== undefined && drawn !== undefined)
    lab.attachCanvas({ view, kinds, element: stage, cellAt: (x, y) => drawn.cellAt(x, y) });
  else lab.detachCanvas();
}

/** Milliseconds to wait for a quiet moment where the browser cannot say when it is idle. */
const IDLE_FALLBACK_MS = 1000;
/** The scene whose neighbours' code was last fetched ahead (see `prefetchAround`). */
let aroundScene: SceneId | undefined;

/**
 * Once the scene on screen has its code, fetch the code of the scenes `[` and `]` step to from it
 * (the Scenes view's order) while the page is idle, so a step there builds at once. Without
 * WebGL2 nothing is drawn, so nothing is fetched.
 */
function prefetchAround(): void {
  const scene = state.scene;
  if (renderer === undefined || scene === aroundScene) return;
  aroundScene = scene;
  loadScene(scene).then(
    () => {
      const ahead = () => {
        prefetchScene(sceneStep(scene, -1));
        prefetchScene(sceneStep(scene, 1));
      };
      if ("requestIdleCallback" in window) requestIdleCallback(ahead);
      else setTimeout(ahead, IDLE_FALLBACK_MS);
    },
    () => undefined,
  );
}

// Reduced motion follows the system's setting as it changes, not only as the page opened.
reducedMotion.addEventListener("change", (event) => renderer?.setFrozen(event.matches));

/**
 * The address bar follows the setup, written at most once per URL_EVERY ms: a slider drag applies a
 * change a frame, and browsers refuse history writes that come faster than about 20 a second
 * (Chromium ignores those past 200 in 10 s, leaving the address on an old setup; Firefox and Safari
 * throw, which would stop the change applying). The last setup is always written: once the interval
 * is up, or at once when the page is hidden.
 */
const URL_EVERY = 400;
let urlPending: string | undefined;
let urlTimer: number | undefined;
let urlWritten = Number.NEGATIVE_INFINITY;

function writeUrl(): void {
  window.clearTimeout(urlTimer);
  urlTimer = undefined;
  if (urlPending === undefined) return;
  history.replaceState(null, "", urlPending);
  urlPending = undefined;
  urlWritten = performance.now();
}

function showUrl(url: string): void {
  urlPending = url;
  if (urlTimer !== undefined) return;
  const wait = urlWritten + URL_EVERY - performance.now();
  if (wait <= 0) writeUrl();
  else urlTimer = window.setTimeout(writeUrl, wait);
}

addEventListener("pagehide", writeUrl);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") writeUrl();
});

/**
 * Show the setup `query` holds (see `LabHost.apply`): `cut` switches scenes without the passage,
 * `keepClocks` lets the scene switched to take over the clocks of the one left (the lab keeping the
 * world), `crossfade` blends it in over the one left without their exit and entrance (the lab
 * moving within one baseline; `DitherRenderer.update`).
 */
function apply(
  query: URLSearchParams,
  options: { cut?: boolean; keepClocks?: boolean; crossfade?: boolean } = {},
): void {
  const setup = readSetup(query);
  state = setup.state;
  params = setup.params;
  planets = setup.planets;
  elements = setup.elements;
  camera = setup.camera;
  // The lab's session tools (an A/B comparison, a tour) ride beside the setup in the URL.
  const minimal = serialise(state, params, planets, elements, camera);
  for (const [key, value] of lab?.sessionQuery() ?? []) minimal.append(key, value);
  const search = minimal.toString();
  showUrl(`${location.pathname}${search ? `?${search}` : ""}`);
  const settings = renderSettings(state, params, planets, elements, camera);
  renderer?.update(options.cut ? { ...settings, passage: false } : settings, {
    keepClocks: options.keepClocks === true,
    crossfade: options.crossfade === true,
  });
  prefetchAround();

  document.body.dataset.scene = state.scene;
  document.body.dataset.mode = state.mode;
  const colours = palette(state, params);
  const root = document.documentElement.style;
  root.setProperty("--accent", accentOf(state));
  root.setProperty("--bg", colours.bg);
  root.setProperty("--ink", colours.ink);
  root.setProperty("--muted", colours.muted);
  root.setProperty("--line", colours.line);
  for (const node of document.querySelectorAll<HTMLElement>("[data-show]")) {
    node.hidden = !(node.dataset.show ?? "").split(" ").includes(state.mode);
  }
  // Backdrop focus aids: blur and dim the scene behind the page.
  stage.style.filter =
    state.dim > 0 || state.blur > 0
      ? `blur(${(state.blur * 12).toFixed(1)}px) brightness(${(1 - state.dim * 0.85).toFixed(2)})`
      : "";
  // Scale up slightly while blurred so the soft edges stay off screen, about the middle (the
  // renderer puts the canvas's transform origin at its top left: src/display.ts).
  const edge = (state.blur * 2.5).toFixed(2);
  stage.style.transform =
    state.blur > 0
      ? `translate(-${edge}%, -${edge}%) scale(${(1 + state.blur * 0.05).toFixed(3)})`
      : "";
  instanceName.textContent = state.instance;
  // A link (or a preset) naming a scene this build lacks opened the default scene: the lab says so.
  if (setup.unknownScene !== undefined) lab?.noteUnknownScene(setup.unknownScene);
  lab?.sync();
  followCanvas();
}

// `apply` reads `lab`, so nothing may apply before this line has run: the first call is the last
// line of this module, and the Lab only calls `host.apply` from user actions, never while it is
// being built (it reads `host.current()` then).
const lab = new Lab(element("#lab", HTMLElement), element("#lab-open", HTMLButtonElement), {
  current: () => ({ state, params, planets, elements, camera }),
  apply,
  renderer: () => renderer,
  build,
});

window.addEventListener("keydown", (event) => {
  const target = event.target;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  )
    return;
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) lab?.redo();
    else lab?.undo();
    return;
  }
  if (mod || event.altKey) return;
  if (event.key === "[" || event.key === "]") {
    const by = event.key === "]" ? 1 : -1;
    // While a tour plays, the keys step along it instead of the whole catalogue.
    if (!lab?.skipTour(by)) lab?.stepScene(by);
  } else if (event.key === "l") {
    lab?.setOpen(!lab.open);
  } else if (event.key === "p") {
    renderer?.setPaused(!renderer.paused);
    lab?.sync();
  } else if (event.key === "b") {
    // Tap to flip between A and B, hold to peek (released in the keyup listener below).
    if (!event.repeat) lab?.pressCompare(event.timeStamp);
  } else if (event.key === "t") {
    lab?.toggleTour();
  } else if (event.key === "/") {
    event.preventDefault();
    lab?.focusSearch();
  }
});
window.addEventListener("keyup", (event) => {
  if (event.key === "b") lab?.releaseCompare(event.timeStamp);
});

// Loading-page choreography: a stepped bar and the boot phases a hub actually goes through.
const cells = Array.from({ length: 32 }, () => bar.appendChild(document.createElement("i")));
const phases = [
  "resolving hub",
  "admitting session",
  "syncing canvas",
  "attaching terminals",
  "ready",
];
let step = 0;
setInterval(() => {
  if (state.mode !== "loading") return;
  step = reducedMotion.matches ? 20 : (step + 1) % 44;
  const filled = Math.min(step, cells.length);
  cells.forEach((cell, index) => {
    cell.className = index < filled - 1 ? "on" : index === filled - 1 ? "head" : "";
  });
  status.textContent =
    phases[
      Math.min(phases.length - 1, Math.floor((filled / cells.length) * (phases.length - 1)))
    ] ?? "";
}, 110);

apply(initial);
