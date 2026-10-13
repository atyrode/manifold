import { sceneParams, type ParamDef } from "./params.ts";
import { presets, type Preset } from "./presets.ts";
import {
  colorIds,
  ditherIds,
  DitherRenderer,
  sceneIds,
  type ColorId,
  type DitherId,
  type RenderSettings,
  type SceneId,
  type ViewId,
  viewIds,
} from "./renderer.ts";

const modeIds = ["landing", "loading", "instance", "bare"] as const;
type ModeId = (typeof modeIds)[number];
const mouseIds = ["follow", "still"] as const;
type MouseId = (typeof mouseIds)[number];

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
  /** Whether the scene parallaxes toward the pointer. */
  mouse: MouseId;
  view: ViewId;
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
  mouse: "follow",
  view: "dithered",
};

const BG = "#07080b";
const INK = "#e8e6df";
const LOCAL_PRESETS = "landing.presets";

/** The commit this page was built from; empty when served straight from a working tree. */
const build = document.querySelector<HTMLMetaElement>('meta[name="landing-build"]')?.content ?? "";

function pick<T extends string>(allowed: readonly T[], value: string | null, fallback: T): T {
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

function readNumber(value: string | null, min: number, max: number, fallback: number): number {
  const n = value === null || value === "" ? Number.NaN : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function readState(q: URLSearchParams): LabState {
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
    mouse: pick(mouseIds, q.get("mouse"), defaults.mouse),
    view: pick(viewIds, q.get("view"), defaults.view),
  };
}

/** The current scene's knobs, by key. */
function readParams(scene: SceneId, q: URLSearchParams): Record<string, number> {
  return Object.fromEntries(
    sceneParams[scene].map((def) => [def.key, readNumber(q.get(def.key), def.min, def.max, def.value)]),
  );
}

/** Minimal query: only values that differ from their defaults. */
function serialise(state: LabState, params: Record<string, number>): URLSearchParams {
  const q = new URLSearchParams();
  for (const key of Object.keys(defaults) as (keyof LabState)[]) {
    if (state[key] !== defaults[key]) q.set(key, String(state[key]));
  }
  for (const def of sceneParams[state.scene]) {
    const value = params[def.key] ?? def.value;
    if (value !== def.value) q.set(def.key, String(value));
  }
  return q;
}

function element<T extends Element>(selector: string, type: new () => T): T {
  const found = document.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`landing: missing ${selector}`);
  return found;
}

function loadLocalPresets(): Preset[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LOCAL_PRESETS) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is Preset =>
      typeof entry === "object" && entry !== null
      && typeof (entry as Preset).name === "string"
      && typeof (entry as Preset).commit === "string"
      && typeof (entry as Preset).query === "string"
      && typeof (entry as Preset).savedAt === "string");
  } catch (error: unknown) {
    console.error("evt=landing.presets.unreadable", error);
    return [];
  }
}

function flash(button: HTMLButtonElement, text: string): void {
  const original = button.dataset.label ?? button.textContent ?? "";
  button.dataset.label = original;
  button.textContent = text;
  setTimeout(() => { button.textContent = original; }, 1400);
}

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const canvas = element("#stage", HTMLCanvasElement);
const lab = element("#lab", HTMLFormElement);
const labToggle = element("#lab-toggle", HTMLButtonElement);
const labParams = element("#lab-params", HTMLElement);
const presetSelect = element("#lab-presets", HTMLSelectElement);
const pinned = element("#lab-pinned", HTMLAnchorElement);
const credit = element("#credit", HTMLElement);
const bar = element("#bar", HTMLElement);
const status = element("#status", HTMLElement);
const instanceName = element("#instance-name", HTMLElement);
for (const label of lab.querySelectorAll<HTMLLabelElement>("label[data-help]")) withHelp(label, label.dataset.help ?? "");
element("#lab-build", HTMLElement).textContent = build ? `build ${build}` : "build: working tree";

const initial = new URLSearchParams(location.search);
let state = readState(initial);
let params = readParams(state.scene, initial);
let paramScene: SceneId | undefined;

function renderSettings(): RenderSettings {
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
    params: sceneParams[state.scene].map((def) => params[def.key] ?? def.value),
    followPointer: state.mouse === "follow",
    view: state.view,
  };
}

let renderer: DitherRenderer | undefined;
try {
  renderer = new DitherRenderer(canvas, renderSettings(), reducedMotion);
  renderer.start();
} catch (error: unknown) {
  console.error("evt=landing.renderer.unavailable", error);
}

for (const [name, ids] of [["scene", sceneIds], ["mode", modeIds], ["dither", ditherIds], ["color", colorIds], ["view", viewIds]] as const) {
  const select = element(`#lab select[name="${name}"]`, HTMLSelectElement);
  for (const id of ids) select.add(new Option(id, id));
}

function withHelp(label: HTMLLabelElement, help: string): HTMLLabelElement {
  const tip = document.createElement("span");
  tip.className = "help";
  tip.tabIndex = 0;
  tip.textContent = "?";
  tip.dataset.help = help;
  label.append(tip);
  return label;
}

function paramField(def: ParamDef): HTMLLabelElement {
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.name = `param:${def.key}`;
  if (def.kind === "toggle") {
    input.type = "checkbox";
    label.className = "switch";
    label.append(def.label, input);
  } else {
    Object.assign(input, { type: "range", min: String(def.min), max: String(def.max), step: String(def.step) });
    label.append(def.label, input, document.createElement("output"));
  }
  if (def.when !== undefined) label.dataset.when = def.when;
  return withHelp(label, def.help);
}

/** One fieldset per knob group, in first-appearance order. */
function paramSections(scene: SceneId): HTMLFieldSetElement[] {
  const sections = new Map<string, HTMLFieldSetElement>();
  for (const def of sceneParams[scene]) {
    let section = sections.get(def.group);
    if (!section) {
      section = document.createElement("fieldset");
      const legend = document.createElement("legend");
      legend.textContent = def.group;
      section.append(legend);
      sections.set(def.group, section);
    }
    section.append(paramField(def));
  }
  return [...sections.values()];
}

function fillPresets(): void {
  presetSelect.replaceChildren(new Option("presets…", ""));
  const groups: [string, readonly Preset[]][] = [["baselines", presets], ["saved here", loadLocalPresets()]];
  groups.forEach(([label, entries], group) => {
    if (entries.length === 0) return;
    const optgroup = document.createElement("optgroup");
    optgroup.label = label;
    entries.forEach((preset, index) => optgroup.append(new Option(`${preset.name} @${preset.commit}`, `${group}:${index}`)));
    presetSelect.append(optgroup);
  });
}

function selectedPreset(): Preset | undefined {
  const [group, index] = presetSelect.value.split(":").map(Number);
  const list = group === 0 ? presets : group === 1 ? loadLocalPresets() : [];
  return index === undefined ? undefined : list[index];
}

function pinnedUrl(commit: string, query: string): string {
  return `${location.origin}/@${commit}/${query ? `?${query}` : ""}`;
}

function apply(next: LabState, nextParams: Record<string, number>): void {
  state = next;
  params = nextParams;
  const query = serialise(state, params).toString();
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}`);
  renderer?.update(renderSettings());

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

  if (paramScene !== state.scene) {
    paramScene = state.scene;
    labParams.replaceChildren(...paramSections(state.scene));
  }
  for (const label of labParams.querySelectorAll<HTMLLabelElement>("label[data-when]")) {
    label.hidden = (params[label.dataset.when ?? ""] ?? 0) < 0.5;
  }
  for (const label of lab.querySelectorAll<HTMLLabelElement>("label[data-when-mode]")) {
    label.hidden = label.dataset.whenMode !== state.mode;
  }
  for (const field of lab.elements) {
    if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) continue;
    let value: string | undefined;
    if (field.name.startsWith("param:")) value = String(params[field.name.slice(6)] ?? "");
    else if (field.name === "accent") value = accent;
    else if (field.name in state) value = String(state[field.name as keyof LabState]);
    if (value === undefined) continue;
    const editing = field === document.activeElement && field.type === "text";
    if (field instanceof HTMLInputElement && field.type === "checkbox") field.checked = value === "1" || value === "follow";
    else if (!editing) field.value = value;
    const output = field.nextElementSibling;
    if (output instanceof HTMLOutputElement) output.value = value;
  }
}

function applyQuery(q: URLSearchParams): void {
  const next = readState(q);
  apply(next, readParams(next.scene, q));
}

lab.addEventListener("input", (event) => {
  const field = event.target;
  if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) return;
  if (field === presetSelect) return;
  const q = serialise(state, params);
  if (state.accent === "") q.delete("accent");
  const value = field instanceof HTMLInputElement && field.type === "checkbox"
    ? field.name === "mouse" ? (field.checked ? "follow" : "still") : (field.checked ? "1" : "0")
    : field.value;
  if (field.name.startsWith("param:")) q.set(field.name.slice(6), value);
  else if (field.name === "mouse") q.set("mouse", value);
  else if (field.name !== "accent" || field.value !== sceneAccent[state.scene]) q.set(field.name, field.value);
  // A scene switch starts that scene's knobs from their defaults.
  if (field.name === "scene") for (const def of sceneParams[state.scene]) q.delete(def.key);
  applyQuery(q);
});

presetSelect.addEventListener("change", () => {
  const preset = selectedPreset();
  pinned.hidden = !preset;
  if (!preset) return;
  pinned.href = pinnedUrl(preset.commit, preset.query);
  pinned.textContent = `open on its build @${preset.commit}`;
  applyQuery(new URLSearchParams(preset.query));
});

labToggle.addEventListener("click", () => {
  lab.hidden = !lab.hidden;
  labToggle.setAttribute("aria-expanded", String(!lab.hidden));
});
element("#lab-reset", HTMLButtonElement).addEventListener("click", () => applyQuery(new URLSearchParams()));
element("#lab-copy", HTMLButtonElement).addEventListener("click", (event) => {
  const button = event.currentTarget;
  if (!(button instanceof HTMLButtonElement)) return;
  const query = serialise(state, params).toString();
  const url = build ? pinnedUrl(build, query) : location.href;
  navigator.clipboard.writeText(url).then(() => flash(button, "copied"), () => flash(button, "copy failed"));
});
element("#lab-save", HTMLButtonElement).addEventListener("click", (event) => {
  const button = event.currentTarget;
  if (!(button instanceof HTMLButtonElement)) return;
  const name = prompt("Name this setup", `${state.scene} · ${new Date().toISOString().slice(0, 10)}`)?.trim();
  if (!name) return;
  const saved: Preset = {
    name,
    commit: build || "working-tree",
    query: serialise(state, params).toString(),
    savedAt: new Date().toISOString().slice(0, 10),
  };
  localStorage.setItem(LOCAL_PRESETS, JSON.stringify([...loadLocalPresets(), saved]));
  fillPresets();
  flash(button, "saved");
});
element("#lab-export", HTMLButtonElement).addEventListener("click", (event) => {
  const button = event.currentTarget;
  if (!(button instanceof HTMLButtonElement)) return;
  const local = loadLocalPresets();
  const current: Preset = {
    name: "current",
    commit: build || "working-tree",
    query: serialise(state, params).toString(),
    savedAt: new Date().toISOString().slice(0, 10),
  };
  const text = JSON.stringify(local.length > 0 ? local : [current], null, 2);
  navigator.clipboard.writeText(text).then(() => flash(button, "copied json"), () => flash(button, "copy failed"));
});

let modeBeforeHide: ModeId = state.mode === "bare" ? defaults.mode : state.mode;
window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === "[" || event.key === "]") {
    const step = event.key === "]" ? 1 : sceneIds.length - 1;
    const scene = sceneIds[(sceneIds.indexOf(state.scene) + step) % sceneIds.length] ?? defaults.scene;
    apply({ ...state, scene }, readParams(scene, new URLSearchParams()));
  } else if (event.key === "h") {
    if (state.mode !== "bare") modeBeforeHide = state.mode;
    apply({ ...state, mode: state.mode === "bare" ? modeBeforeHide : "bare" }, params);
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

fillPresets();
apply(state, params);
