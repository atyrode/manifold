// Page controller: owns the current setup (from the URL), drives the renderer and the page on top,
// and hands the lab a host interface. Every change is a URL query applied here.
import { Lab } from "./lab.ts";
import { DitherRenderer } from "./renderer.ts";
import { sceneDefs, sceneIds } from "./scenes/index.ts";
import {
  accentOf,
  carryLook,
  palette,
  paramDefaults,
  readParams,
  readState,
  renderSettings,
  serialise,
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
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const credit = element("#credit", HTMLElement);
const bar = element("#bar", HTMLElement);
const status = element("#status", HTMLElement);
const instanceName = element("#instance-name", HTMLElement);
const stage = element("#stage", HTMLCanvasElement);

const initial = new URLSearchParams(location.search);
let state: LabState = readState(initial);
let params: Params = readParams(state.scene, initial);

let renderer: DitherRenderer | undefined;
try {
  renderer = new DitherRenderer(stage, renderSettings(state, params), reducedMotion);
  renderer.start();
} catch (error: unknown) {
  console.error("evt=landing.renderer.unavailable", error);
}

function apply(query: URLSearchParams): void {
  state = readState(query);
  params = readParams(state.scene, query);
  const minimal = serialise(state, params).toString();
  history.replaceState(null, "", `${location.pathname}${minimal ? `?${minimal}` : ""}`);
  renderer?.update(renderSettings(state, params));

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
  for (const node of document.querySelectorAll<HTMLElement>("[data-show]")) {
    node.hidden = !(node.dataset.show ?? "").split(" ").includes(state.mode);
  }
  credit.textContent = sceneDefs[state.scene].credit ?? "";
  // Backdrop focus aids: blur and dim the scene behind the page.
  stage.style.filter = state.dim > 0 || state.blur > 0 ? `blur(${(state.blur * 12).toFixed(1)}px) brightness(${(1 - state.dim * 0.85).toFixed(2)})` : "";
  // Scale up slightly while blurred so the soft edges stay off screen.
  stage.style.transform = state.blur > 0 ? `scale(${(1 + state.blur * 0.05).toFixed(3)})` : "";
  instanceName.textContent = state.instance;
  if (state.mode !== "loading") renderer?.setProgress(-1);
  lab?.sync();
}

// `apply` reads `lab`, so nothing may apply before this line has run: the first call is the last
// line of this module, and the Lab only calls `host.apply` from user actions, never while it is
// being built (it reads `host.current()` then).
const lab = new Lab(element("#lab", HTMLElement), element("#lab-open", HTMLButtonElement), {
  current: () => ({ state, params }),
  apply,
  renderer: () => renderer,
  build,
});

let modeBeforeHide: ModeId = state.mode === "bare" ? "landing" : state.mode;
window.addEventListener("keydown", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) lab?.redo();
    else lab?.undo();
    return;
  }
  if (mod || event.altKey) return;
  if (event.key === "[" || event.key === "]") {
    const step = event.key === "]" ? 1 : sceneIds.length - 1;
    const scene = sceneIds[(sceneIds.indexOf(state.scene) + step) % sceneIds.length] ?? state.scene;
    apply(serialise(carryLook(state, scene), paramDefaults(scene)));
    lab?.commit();
  } else if (event.key === "h") {
    if (state.mode !== "bare") modeBeforeHide = state.mode;
    const query = serialise(state, params);
    query.set("mode", state.mode === "bare" ? modeBeforeHide : "bare");
    apply(query);
    lab?.commit();
  } else if (event.key === "l") {
    lab?.setOpen(!lab.open);
  } else if (event.key === "p") {
    renderer?.setPaused(!renderer.paused);
    lab?.sync();
  } else if (event.key === "/") {
    event.preventDefault();
    lab?.focusSearch();
  }
});

// Loading-page choreography: a stepped bar and the boot phases a hub actually goes through.
const cells = Array.from({ length: 32 }, () => bar.appendChild(document.createElement("i")));
const phases = ["resolving hub", "admitting session", "syncing canvas", "attaching terminals", "ready"];
let step = 0;
setInterval(() => {
  if (state.mode !== "loading") return;
  step = reducedMotion ? 20 : (step + 1) % 44;
  const filled = Math.min(step, cells.length);
  cells.forEach((cell, index) => {
    cell.className = index < filled - 1 ? "on" : index === filled - 1 ? "head" : "";
  });
  renderer?.setProgress(filled / cells.length);
  status.textContent = phases[Math.min(phases.length - 1, Math.floor((filled / cells.length) * (phases.length - 1)))] ?? "";
}, 110);

apply(initial);
