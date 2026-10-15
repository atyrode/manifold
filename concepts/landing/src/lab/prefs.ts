// The lab's preferences in this browser: whether it is open, explanations on, each group folded or
// open, each panel's place and the narrow-screen sheet raised or not. Read defensively: anything
// missing or malformed falls back, and what older layouts kept that this one has no use for is
// dropped (the Scenes panel's place, `panels.browser`, from before it became a view of the one
// panel; the sheet's tab, `sheet.tab`, from when the sheet had a tab per panel).
import { panelIds, type SheetState } from "./panels.ts";

export const PREFS_KEY = "landing.lab.v3";

export interface Prefs {
  open: boolean;
  explain: boolean;
  /** Open (true) or folded (false) per section id; missing means the section's default. */
  sections: Record<string, boolean>;
  /** Each panel's place, as the workspace saved it (it checks each value as it loads). */
  panels: Record<string, unknown>;
  sheet: SheetState;
}

/** The preferences stored as `stored` (null when there are none). */
export function readPrefs(stored: string | null): Prefs {
  const fallback: Prefs = {
    open: false,
    explain: false,
    sections: {},
    panels: {},
    sheet: { open: true },
  };
  let raw: unknown;
  try {
    raw = JSON.parse(stored ?? "{}");
  } catch (error: unknown) {
    console.error("evt=landing.lab_prefs.unreadable", error);
    return fallback;
  }
  if (typeof raw !== "object" || raw === null) return fallback;
  const record = raw as Partial<Record<keyof Prefs, unknown>>;
  const object = (value: unknown) =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const panels = object(record.panels);
  return {
    open: record.open === true,
    explain: record.explain === true,
    sections: Object.fromEntries(
      Object.entries(object(record.sections)).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
      ),
    ),
    panels: Object.fromEntries(
      panelIds.filter((id) => Object.hasOwn(panels, id)).map((id) => [id, panels[id]]),
    ),
    sheet: { open: object(record.sheet).open !== false },
  };
}
