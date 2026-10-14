// Saved lab setups. `commit` is the build the setup was tuned on: `/@<commit>/?<query>` replays it
// exactly even after shader logic changes; loading it on a newer build applies the same knobs.
// Add entries from the lab's "export" output.

export interface Preset {
  name: string;
  commit: string;
  query: string;
  savedAt: string;
}

export const presets: readonly Preset[] = [
  {
    name: "orbit · red ign (baseline)",
    commit: "db4ca2e8",
    query: "scene=orbit&dither=ign&levels=4&motion=0.45&accent=%23ff004e",
    savedAt: "2026-10-13",
  },
  {
    name: "Countryside · crops (baseline)",
    commit: "8aecfb26",
    query: "scene=country",
    savedAt: "2026-10-14",
  },
  {
    name: "Countryside · flower valley",
    commit: "8aecfb26",
    query: "scene=country&time=0.58&clouds=0.25&season=0&fieldType=1&landscape=17",
    savedAt: "2026-10-14",
  },
  {
    name: "Countryside · lavender rows",
    commit: "8aecfb26",
    query: "scene=country&season=0&fieldType=2",
    savedAt: "2026-10-14",
  },
  {
    name: "Countryside · sunflowers",
    commit: "8aecfb26",
    query: "scene=country&season=0&fieldType=3",
    savedAt: "2026-10-14",
  },
  {
    name: "Countryside · mixed patchwork",
    commit: "8aecfb26",
    query: "scene=country&season=0&fieldType=4",
    savedAt: "2026-10-14",
  },
];

const LOCAL_PRESETS = "landing.presets";

function isPreset(entry: unknown): entry is Preset {
  if (typeof entry !== "object" || entry === null) return false;
  const record = entry as Record<string, unknown>;
  return typeof record.name === "string" && typeof record.commit === "string"
    && typeof record.query === "string" && typeof record.savedAt === "string";
}

/** Setups saved in this browser. */
export function loadLocalPresets(): Preset[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LOCAL_PRESETS) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isPreset) : [];
  } catch (error: unknown) {
    console.error("evt=landing.presets.unreadable", error);
    return [];
  }
}

export function saveLocalPresets(list: readonly Preset[]): void {
  localStorage.setItem(LOCAL_PRESETS, JSON.stringify(list));
}

/** Presets from pasted export JSON; throws on anything that is not a preset list. */
export function parsePresets(text: string): Preset[] {
  const parsed: unknown = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (!list.every(isPreset)) throw new Error("not a list of presets");
  return list;
}
