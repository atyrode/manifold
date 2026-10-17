// Page controller: owns the current setup (from the URL), drives the renderer and the page on top,
// and hands the lab a host interface. Every change is a URL query applied here, read as a link is
// (state.ts `readSetup`: brought up to this build's URL schema, an unknown scene reported).
import { Lab } from "./lab.ts";
import { thumbUrl } from "./lab/thumbs.ts";
import { DitherRenderer } from "./renderer.ts";
import { sceneDefs } from "./scenes/index.ts";
import type { SkyPlanet } from "./scenes/planets.ts";
import {
  accentOf,
  palette,
  readSetup,
  renderSettings,
  serialise,
  URL_VERSION,
  VERSION_KEY,
  type LabState,
  type ModeId,
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
const credit = element("#credit", HTMLElement);
const bar = element("#bar", HTMLElement);
const status = element("#status", HTMLElement);
const instanceName = element("#instance-name", HTMLElement);
const stage = element("#stage", HTMLCanvasElement);

const initial = new URLSearchParams(location.search);
const opened = readSetup(initial);
let state: LabState = opened.state;
let params: Params = opened.params;
let planets: SkyPlanet[] = opened.planets;

let renderer: DitherRenderer | undefined;
try {
  renderer = new DitherRenderer(
    stage,
    renderSettings(state, params, planets),
    reducedMotion.matches,
  );
  renderer.start();
} catch (error: unknown) {
  console.error("evt=landing.renderer.unavailable", error);
}
// Without WebGL2, and while the context is lost (until the browser gives it back), the scene's
// committed thumbnail stands in for the canvas, still (`body.poster`, styles.css).
document.body.classList.toggle("poster", renderer === undefined);
stage.addEventListener("webglcontextlost", () => document.body.classList.add("poster"));
stage.addEventListener("webglcontextrestored", () => document.body.classList.remove("poster"));

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

function apply(query: URLSearchParams, options: { cut?: boolean } = {}): void {
  const setup = readSetup(query);
  state = setup.state;
  params = setup.params;
  planets = setup.planets;
  // The lab's session tools (an A/B comparison, a tour) ride beside the setup in the URL.
  const minimal = serialise(state, params, planets);
  for (const [key, value] of lab?.sessionQuery() ?? []) minimal.append(key, value);
  const search = minimal.toString();
  showUrl(`${location.pathname}${search ? `?${search}` : ""}`);
  const settings = renderSettings(state, params, planets);
  renderer?.update(options.cut ? { ...settings, passage: false } : settings);

  document.body.dataset.scene = state.scene;
  document.body.dataset.mode = state.mode;
  document.body.classList.toggle("ui-hidden", state.mode === "bare");
  const colours = palette(state, params);
  const root = document.documentElement.style;
  root.setProperty("--accent", accentOf(state));
  root.setProperty("--bg", colours.bg);
  root.setProperty("--ink", colours.ink);
  root.setProperty("--muted", colours.muted);
  root.setProperty("--line", colours.line);
  root.setProperty("--poster", `url("${new URL(thumbUrl(state.scene), location.href).href}")`);
  for (const node of document.querySelectorAll<HTMLElement>("[data-show]")) {
    node.hidden = !(node.dataset.show ?? "").split(" ").includes(state.mode);
  }
  credit.textContent = sceneDefs[state.scene].credit ?? "";
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
}

// `apply` reads `lab`, so nothing may apply before this line has run: the first call is the last
// line of this module, and the Lab only calls `host.apply` from user actions, never while it is
// being built (it reads `host.current()` then).
const lab = new Lab(element("#lab", HTMLElement), element("#lab-open", HTMLButtonElement), {
  current: () => ({ state, params, planets }),
  apply,
  renderer: () => renderer,
  build,
});

let modeBeforeHide: ModeId = state.mode === "bare" ? "landing" : state.mode;
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
  } else if (event.key === "h") {
    if (state.mode !== "bare") modeBeforeHide = state.mode;
    const query = serialise(state, params, planets);
    query.set("mode", state.mode === "bare" ? modeBeforeHide : "bare");
    // In this build's keys: read as this schema, never as an older link.
    query.set(VERSION_KEY, String(URL_VERSION));
    apply(query);
    lab?.commit();
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
