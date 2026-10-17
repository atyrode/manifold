// The lab's preferences in this browser: whether it is open, and in which presentation,
// explanations on, a picked scene keeping the world, each group folded or open, each panel's place
// and the narrow-screen sheet raised or not. Read defensively: anything missing or malformed falls
// back, and what older layouts kept that this one has no use for is dropped (the Scenes panel's
// place, `panels.browser`, from before it became a view of the one panel; the transport bar's,
// `panels.transport`, from before the compact bar took its place; the sheet's tab, `sheet.tab`,
// from when the sheet had a tab per panel).
import { panelIds, type SheetState } from "./panels.ts";

export const PREFS_KEY = "landing.lab.v3";

/** The lab's two presentations of one menu: the inspector panel, or the compact bar. */
export type Presentation = "expanded" | "compact";

export interface Prefs {
  open: boolean;
  presentation: Presentation;
  explain: boolean;
  /** A scene picked by hand opens under the world of the one left (lab.ts #setScene). */
  keepWorld: boolean;
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
    presentation: "expanded",
    explain: false,
    keepWorld: false,
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
    presentation: record.presentation === "compact" ? "compact" : "expanded",
    explain: record.explain === true,
    keepWorld: record.keepWorld === true,
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
