// The compact bar's rules, apart from its DOM (menu.ts): what a section's chip shows, how the chips
// fit the bar, and where the arrow keys take the keyboard among them.

/** What a section's chip shows. */
export interface ChipState {
  /** Lit: some of the section's knobs differ from their defaults. */
  lit: boolean;
  /** Its master switch, where it has one. */
  switched: "on" | "off" | undefined;
  /** Its name in the tooltip and for assistive technology: the title, then its state. */
  label: string;
}

/**
 * The chip of section `title`, `changed` of whose knobs differ from their defaults (as the lens
 * counts them, lens-model.ts `changedCounts`), its master switch `on` (undefined without one).
 */
export function chipState(title: string, changed: number, on: boolean | undefined): ChipState {
  const switched = on === undefined ? undefined : on ? "on" : "off";
  const states = [...(switched ? [switched] : []), ...(changed > 0 ? [`${changed} changed`] : [])];
  return {
    lit: changed > 0,
    switched,
    label: states.length > 0 ? `${title} (${states.join(", ")})` : title,
  };
}

/** How the chips stand in the bar: with their titles, as icons alone, or as icons that scroll. */
export type ChipFit = "titled" | "icons" | "scroll";

/**
 * The chips' fit in `room` px: with their titles while all of them fit (`titled` px wide), else as
 * icons alone while those fit (`icons` px), else as icons the strip scrolls through. Every chip
 * goes the same way, so none folds away and the order never changes.
 */
export function fitChips(titled: number, icons: number, room: number): ChipFit {
  if (titled <= room) return "titled";
  return icons <= room ? "icons" : "scroll";
}

/**
 * The strip's room, in px: its width now and what its bar may still grow by, the bar `bar` px wide
 * of at most `limit` (a floating bar is as wide as its content up to the screen's edges; a docked
 * one spans its edge already, its strip taking the rest).
 */
export function stripRoom(strip: number, bar: number, limit: number): number {
  return strip + Math.max(0, limit - bar);
}

/**
 * Where a key takes the keyboard from chip `at` of `count`: the arrows step round the ends, Home
 * and End go to them; undefined for any other key (or no chip in hand).
 */
export function chipStep(key: string, at: number, count: number): number | undefined {
  if (at < 0 || at >= count) return undefined;
  switch (key) {
    case "ArrowRight":
      return (at + 1) % count;
    case "ArrowLeft":
      return (at - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return undefined;
  }
}
