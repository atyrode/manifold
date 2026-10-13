import {
  colorIds,
  ditherIds,
  DitherRenderer,
  sceneIds,
  type ColorId,
  type DitherId,
  type RenderSettings,
  type SceneId,
} from "./renderer.ts";

const modeIds = ["landing", "loading", "instance", "bare"] as const;
type ModeId = (typeof modeIds)[number];

interface LabState {
  scene: SceneId;
  mode: ModeId;
  dither: DitherId;
  color: ColorId;
  pixel: number;
  levels: number;
  motion: number;
  /** Empty means the scene's own accent. */
  accent: string;
  instance: string;
}

const sceneAccent: Record<SceneId, string> = {
  wave: "#4c6ef5",
  starry: "#f2c94c",
  orbit: "#5c7cfa",
  swell: "#4c6ef5",
};

const sceneCredit: Record<SceneId, string> = {
  wave: "after Katsushika Hokusai, The Great Wave off Kanagawa, c. 1831 — public domain",
  starry: "after Vincent van Gogh, The Starry Night, 1889 — public domain",
  orbit: "",
  swell: "",
};

const defaults: LabState = {
  scene: "wave",
  mode: "landing",
  dither: "bayer8",
  color: "accent",
  pixel: 2,
  levels: 2,
  motion: 0.6,
  accent: "",
  instance: "tyrode",
};

const BG = "#07080b";
const INK = "#e8e6df";

function pick<T extends string>(allowed: readonly T[], value: string | null, fallback: T): T {
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

function readNumber(value: string | null, min: number, max: number, fallback: number): number {
  const n = value === null ? Number.NaN : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function readState(): LabState {
  const q = new URLSearchParams(location.search);
  const accent = q.get("accent") ?? "";
  return {
    scene: pick(sceneIds, q.get("scene"), defaults.scene),
    mode: pick(modeIds, q.get("mode"), defaults.mode),
    dither: pick(ditherIds, q.get("dither"), defaults.dither),
    color: pick(colorIds, q.get("color"), defaults.color),
    pixel: readNumber(q.get("pixel"), 1, 8, defaults.pixel),
    levels: readNumber(q.get("levels"), 2, 6, defaults.levels),
    motion: readNumber(q.get("motion"), 0, 1, defaults.motion),
    accent: /^#[0-9a-f]{6}$/i.test(accent) ? accent.toLowerCase() : "",
    instance: (q.get("instance") ?? "").trim().slice(0, 40) || defaults.instance,
  };
}

function writeState(state: LabState): void {
  const q = new URLSearchParams();
  for (const key of Object.keys(defaults) as (keyof LabState)[]) {
    if (state[key] !== defaults[key]) q.set(key, String(state[key]));
  }
  const search = q.size > 0 ? `?${q}` : "";
  history.replaceState(null, "", `${location.pathname}${search}`);
}

function renderSettings(state: LabState): RenderSettings {
  return {
    scene: state.scene,
    dither: state.dither,
    color: state.color,
    pixel: state.pixel,
    levels: state.levels,
    motion: state.motion,
    bg: BG,
    ink: INK,
    accent: state.accent || sceneAccent[state.scene],
  };
}

function element<T extends Element>(selector: string, type: new () => T): T {
  const found = document.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`landing: missing ${selector}`);
  return found;
}

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const canvas = element("#stage", HTMLCanvasElement);
const lab = element("#lab", HTMLFormElement);
const labToggle = element("#lab-toggle", HTMLButtonElement);
const credit = element("#credit", HTMLElement);
const bar = element("#bar", HTMLElement);
const status = element("#status", HTMLElement);
const instanceName = element("#instance-name", HTMLElement);

let state = readState();
let renderer: DitherRenderer | undefined;
try {
  renderer = new DitherRenderer(canvas, renderSettings(state), reducedMotion);
  renderer.start();
} catch (error: unknown) {
  console.error("evt=landing.renderer.unavailable", error);
}

for (const [name, ids] of [["scene", sceneIds], ["mode", modeIds], ["dither", ditherIds], ["color", colorIds]] as const) {
  const select = element(`#lab select[name="${name}"]`, HTMLSelectElement);
  for (const id of ids) select.add(new Option(id, id));
}

function apply(next: LabState): void {
  state = next;
  writeState(state);
  renderer?.update(renderSettings(state));
  const accent = state.accent || sceneAccent[state.scene];
  document.body.dataset.scene = state.scene;
  document.body.dataset.mode = state.mode;
  document.body.classList.toggle("ui-hidden", state.mode === "bare");
  document.documentElement.style.setProperty("--accent", accent);
  for (const node of document.querySelectorAll<HTMLElement>("[data-show]")) {
    node.hidden = !(node.dataset.show ?? "").split(" ").includes(state.mode);
  }
  credit.textContent = sceneCredit[state.scene];
  instanceName.textContent = state.instance;

  for (const field of lab.elements) {
    if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) continue;
    const key = field.name as keyof LabState;
    if (!(key in state)) continue;
    const editing = field === document.activeElement && field.type === "text";
    if (!editing) field.value = key === "accent" ? accent : String(state[key]);
    const output = field.nextElementSibling;
    if (output instanceof HTMLOutputElement) output.value = String(state[key]);
  }
}

lab.addEventListener("input", (event) => {
  const field = event.target;
  if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) return;
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(state)) q.set(key, String(value));
  q.set(field.name, field.value);
  history.replaceState(null, "", `${location.pathname}?${q}`);
  apply(readState());
});

labToggle.addEventListener("click", () => {
  lab.hidden = !lab.hidden;
  labToggle.setAttribute("aria-expanded", String(!lab.hidden));
});
element("#lab-reset", HTMLButtonElement).addEventListener("click", () => apply({ ...defaults }));
element("#lab-copy", HTMLButtonElement).addEventListener("click", (event) => {
  const button = event.currentTarget;
  if (!(button instanceof HTMLButtonElement)) return;
  navigator.clipboard.writeText(location.href).then(
    () => { button.textContent = "copied"; },
    () => { button.textContent = "copy failed"; },
  );
  setTimeout(() => { button.textContent = "copy link"; }, 1400);
});

let modeBeforeHide: ModeId = state.mode === "bare" ? defaults.mode : state.mode;
window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === "[" || event.key === "]") {
    const step = event.key === "]" ? 1 : sceneIds.length - 1;
    const scene = sceneIds[(sceneIds.indexOf(state.scene) + step) % sceneIds.length] ?? defaults.scene;
    apply({ ...state, scene });
  } else if (event.key === "h") {
    if (state.mode !== "bare") modeBeforeHide = state.mode;
    apply({ ...state, mode: state.mode === "bare" ? modeBeforeHide : "bare" });
  } else if (event.key === "l") {
    labToggle.click();
  }
});

// Loading-mode choreography: a stepped bar and the boot phases a hub actually goes through.
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
  status.textContent = phases[Math.min(phases.length - 1, Math.floor((filled / cells.length) * (phases.length - 1)))] ?? "";
}, 110);

apply(state);
