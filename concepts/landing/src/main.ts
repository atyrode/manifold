import { effective, sceneParams, type ParamDef } from "./params.ts";
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
  pond: "#ff7a2f",
};

const sceneCredit: Record<SceneId, string> = {
  wave: "after Katsushika Hokusai, The Great Wave off Kanagawa, c. 1831 — public domain",
  starry: "after Vincent van Gogh, The Starry Night, 1889 — public domain",
  orbit: "",
  swell: "",
  pond: "",
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

const NIGHT = { bg: "#07080b", ink: "#e8e6df", muted: "#8b8a85", line: "rgb(232 230 223 / 0.14)" };
/** The wave's "ink on paper" theme: the print's paper with dark ink. */
const PAPER = { bg: "#ebe2cc", ink: "#1b2235", muted: "#5d5a52", line: "rgb(27 34 53 / 0.18)" };
const LOCAL_PRESETS = "landing.presets";
const LAB_PREFS = "landing.lab";

/** Sidebar layout preferences, kept per browser rather than in shared links. */
interface LabPrefs {
  open: boolean;
  /** `data-section` ids the user has folded. */
  folded: string[];
}

function loadPrefs(): LabPrefs {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LAB_PREFS) ?? "{}");
    const record = typeof parsed === "object" && parsed !== null ? (parsed as Partial<LabPrefs>) : {};
    return {
      open: record.open === true,
      folded: Array.isArray(record.folded) ? record.folded.filter((id): id is string => typeof id === "string") : [],
    };
  } catch (error: unknown) {
    console.error("evt=landing.lab_prefs.unreadable", error);
    return { open: false, folded: [] };
  }
}

const prefs = loadPrefs();
function savePrefs(): void {
  localStorage.setItem(LAB_PREFS, JSON.stringify(prefs));
}

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

/** The current scene's knobs, by key; a feature also stores `<key>-amount`. */
function readParams(scene: SceneId, q: URLSearchParams): Record<string, number> {
  const out: Record<string, number> = {};
  for (const def of sceneParams[scene]) {
    switch (def.kind) {
      case "range":
        out[def.key] = readNumber(q.get(def.key), def.min, def.max, def.value);
        break;
      case "toggle":
        out[def.key] = Math.round(readNumber(q.get(def.key), 0, 1, def.value));
        break;
      case "feature": {
        out[def.key] = Math.round(readNumber(q.get(def.key), 0, 1, def.on ? 1 : 0));
        const amount = readNumber(q.get(`${def.key}-amount`), def.min, def.max, def.value);
        out[`${def.key}-amount`] = def.options?.some((option) => option.value === amount) === false ? def.value : amount;
        break;
      }
      case "choice": {
        const value = Number(q.get(def.key));
        out[def.key] = def.options.some((option) => option.value === value) ? value : def.value;
        break;
      }
      default: {
        const unreachable: never = def;
        throw new Error(`landing: unknown knob ${String(unreachable)}`);
      }
    }
  }
  return out;
}

/** Each knob's default, keyed as readParams keys them. */
function paramDefaults(scene: SceneId): Record<string, number> {
  return readParams(scene, new URLSearchParams());
}

/** Minimal query: only values that differ from their defaults. */
function serialise(state: LabState, params: Record<string, number>): URLSearchParams {
  const q = new URLSearchParams();
  for (const key of Object.keys(defaults) as (keyof LabState)[]) {
    if (state[key] !== defaults[key]) q.set(key, String(state[key]));
  }
  const fallback = paramDefaults(state.scene);
  for (const [key, value] of Object.entries(params)) {
    if (value !== fallback[key]) q.set(key, String(value));
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
const labOpen = element("#lab-open", HTMLButtonElement);
const labParams = element("#lab-params", HTMLElement);
const presetSelect = element("#lab-presets", HTMLSelectElement);
const pinned = element("#lab-pinned", HTMLAnchorElement);
const credit = element("#credit", HTMLElement);
const bar = element("#bar", HTMLElement);
const status = element("#status", HTMLElement);
const instanceName = element("#instance-name", HTMLElement);
for (const label of lab.querySelectorAll<HTMLLabelElement>("label[data-help]")) withHelp(label, label.dataset.help ?? "");
const buildLine = element("#lab-build", HTMLElement);
buildLine.textContent = build ? `build ${build}` : "build: working tree";

const initial = new URLSearchParams(location.search);
let state = readState(initial);
let params = readParams(state.scene, initial);
let paramScene: SceneId | undefined;

function palette(): typeof NIGHT {
  return state.scene === "wave" && (params.paper ?? 0) > 0.5 ? PAPER : NIGHT;
}

function renderSettings(): RenderSettings {
  const colours = palette();
  return {
    scene: state.scene,
    dither: state.dither,
    color: state.color,
    pixel: state.pixel,
    levels: state.levels,
    motion: state.motion,
    bg: colours.bg,
    ink: colours.ink,
    accent: state.accent || sceneAccent[state.scene],
    params: sceneParams[state.scene].map((def) => effective(def, params)),
    followPointer: state.mouse === "follow",
    view: state.view,
  };
}

let renderer: DitherRenderer | undefined;
try {
  renderer = new DitherRenderer(canvas, renderSettings(), reducedMotion);
  renderer.start();
  buildLine.title = renderer.glInfo;
  buildLine.textContent += ` · ${renderer.glInfo.split(" · ")[1] ?? ""}`;
} catch (error: unknown) {
  buildLine.textContent += " · WebGL2 unavailable";
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

function switchLabel(text: string, name: string): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "switch";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = name;
  const knob = document.createElement("span");
  knob.className = "knob";
  label.append(text, input, knob);
  return label;
}

function sliderLabel(text: string, name: string, min: number, max: number, step: number): HTMLLabelElement {
  const label = document.createElement("label");
  const input = document.createElement("input");
  Object.assign(input, { type: "range", name, min: String(min), max: String(max), step: String(step) });
  label.append(text, input, document.createElement("output"));
  return label;
}

function segmentsLabel(text: string, name: string, options: readonly { label: string; value: number }[]): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "choice";
  const segments = document.createElement("span");
  segments.className = "segments";
  for (const option of options) {
    const input = document.createElement("input");
    Object.assign(input, { type: "radio", name, value: String(option.value), title: option.label });
    const face = document.createElement("span");
    face.textContent = option.label;
    const wrap = document.createElement("span");
    wrap.className = "segment";
    wrap.append(input, face);
    segments.append(wrap);
  }
  label.append(text, segments);
  return label;
}

/** "now": fire one occurrence of an occasional effect immediately, even while it is off. */
function triggerButton(slot: number, what: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "now";
  button.textContent = "▶ now";
  button.title = `Show one ${what} right now`;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    renderer?.trigger(slot);
  });
  return button;
}

/** A knob's controls: a feature is its switch plus an amount row shown only while on. */
function paramFields(def: ParamDef): HTMLLabelElement[] {
  const name = `param:${def.key}`;
  let fields: HTMLLabelElement[];
  switch (def.kind) {
    case "range":
      fields = [withHelp(sliderLabel(def.label, name, def.min, def.max, def.step), def.help)];
      break;
    case "toggle":
      fields = [withHelp(switchLabel(def.label, name), def.help)];
      break;
    case "choice":
      fields = [withHelp(segmentsLabel(def.label, name, def.options), def.help)];
      break;
    case "feature": {
      const amountName = `param:${def.key}-amount`;
      const amount = def.options
        ? segmentsLabel(def.amountLabel, amountName, def.options)
        : sliderLabel(def.amountLabel, amountName, def.min, def.max, def.step);
      amount.classList.add("amount");
      amount.dataset.when = def.key;
      const toggleRow = switchLabel(def.label, name);
      if (def.trigger !== undefined) toggleRow.append(triggerButton(def.trigger, def.label));
      fields = [withHelp(toggleRow, def.help), amount];
      break;
    }
    default: {
      const unreachable: never = def;
      throw new Error(`landing: unknown knob ${String(unreachable)}`);
    }
  }
  if (def.when !== undefined) for (const field of fields) field.dataset.when ??= def.when;
  // A knob shown only under another stays hidden whenever that one is off.
  if (def.when !== undefined) for (const field of fields) field.dataset.whenAlso = def.when;
  return fields;
}

/** One collapsible section per knob group, in first-appearance order. */
function paramSections(scene: SceneId): HTMLDetailsElement[] {
  const sections = new Map<string, HTMLDetailsElement>();
  for (const def of sceneParams[scene]) {
    let section = sections.get(def.group);
    if (!section) {
      section = document.createElement("details");
      section.className = "section";
      section.dataset.section = `${scene}:${def.group}`;
      section.open = !prefs.folded.includes(section.dataset.section);
      const summary = document.createElement("summary");
      summary.textContent = def.group;
      section.append(summary);
      sections.set(def.group, section);
    }
    section.append(...paramFields(def));
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
  const colours = palette();
  const root = document.documentElement.style;
  root.setProperty("--bg", colours.bg);
  root.setProperty("--ink", colours.ink);
  root.setProperty("--muted", colours.muted);
  root.setProperty("--line", colours.line);
  if (state.mode !== "loading") renderer?.setProgress(-1);
  instanceName.textContent = state.instance;

  if (paramScene !== state.scene) {
    paramScene = state.scene;
    labParams.replaceChildren(...paramSections(state.scene));
  }
  for (const label of labParams.querySelectorAll<HTMLLabelElement>("label[data-when]")) {
    const on = (key: string | undefined) => key === undefined || (params[key] ?? 0) > 0.5;
    label.hidden = !on(label.dataset.when) || !on(label.dataset.whenAlso);
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
    else if (field instanceof HTMLInputElement && field.type === "radio") field.checked = field.value === value;
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

function setLabOpen(open: boolean): void {
  lab.hidden = !open;
  document.body.classList.toggle("lab-open", open);
  labOpen.setAttribute("aria-expanded", String(open));
  prefs.open = open;
  savePrefs();
}
labOpen.addEventListener("click", () => setLabOpen(true));
element("#lab-close", HTMLButtonElement).addEventListener("click", () => setLabOpen(false));
// <details> toggle events do not bubble; listen in the capture phase to remember folds.
lab.addEventListener("toggle", (event) => {
  const section = event.target;
  if (!(section instanceof HTMLDetailsElement) || !section.dataset.section) return;
  const id = section.dataset.section;
  prefs.folded = prefs.folded.filter((entry) => entry !== id);
  if (!section.open) prefs.folded.push(id);
  savePrefs();
}, true);
element("#lab-collapse-all", HTMLButtonElement).addEventListener("click", () => {
  const sections = [...lab.querySelectorAll<HTMLDetailsElement>("details.section")];
  const open = !sections.some((section) => section.open);
  for (const section of sections) section.open = open;
});
for (const section of lab.querySelectorAll<HTMLDetailsElement>("details.section[data-section]")) {
  section.open = !prefs.folded.includes(section.dataset.section ?? "");
}
setLabOpen(prefs.open);
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
    setLabOpen(lab.hidden);
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
  renderer?.setProgress(filled / cells.length);
  status.textContent = phases[Math.min(phases.length - 1, Math.floor((filled / cells.length) * (phases.length - 1)))] ?? "";
}, 110);

fillPresets();
apply(state, params);
