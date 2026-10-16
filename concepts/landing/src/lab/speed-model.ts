// The almanac's speeds (dial.ts), apart from their DOM: a cycle (the day's, the year's: a feature)
// as one slider of stops, still at the left end, then the cycle's amounts from the slowest to the
// fastest. The URL keeps the knob's own keys: still is the switch off; any other stop switches it
// on with that amount. The day's amount is a pace (at 1 a whole day passes in DAY_MINUTES of the
// motion clock, timeOfDayM in shaders/lib/sky.ts); the year's is minutes per season (yearNow in
// climate.ts), so its faster stops hold fewer minutes.
import { snap } from "./dom.ts";

/** Minutes of the motion clock a whole day takes at day cycle 1 (timeOfDayM's 240 s). */
export const DAY_MINUTES = 4;

/** A cycle's amount: its range and step. */
export interface Pace {
  min: number;
  max: number;
  step: number;
}

/** What a cycle's amount means: the day's a pace (higher is faster), the year's minutes per season. */
export type Cycle = "day" | "year";

/** How many stops the slider has past still: one for each of the amount's steps. */
export function speedStops(pace: Pace): number {
  return Math.round((pace.max - pace.min) / pace.step) + 1;
}

/** The slider's stop for a cycle's state: 0 still (off), then 1 slowest up to speedStops fastest. */
export function stopOf(cycle: Cycle, pace: Pace, on: boolean, amount: number): number {
  if (!on) return 0;
  const steps = Math.round((snap(amount, pace.min, pace.max, pace.step) - pace.min) / pace.step);
  return cycle === "day" ? steps + 1 : speedStops(pace) - steps;
}

/**
 * The URL patch for a stop: still switches the cycle off and puts its amount back to `rest` (its
 * default), so still is one setting whichever way it was reached; any other stop switches the cycle
 * on at that stop's amount.
 */
export function stopPatch(
  cycle: Cycle,
  pace: Pace,
  key: string,
  stop: number,
  rest: number,
): Record<string, number> {
  const amountKey = `${key}-amount`;
  const at = Math.min(speedStops(pace), Math.max(0, Math.round(stop)));
  if (at === 0) return { [key]: 0, [amountKey]: rest };
  const steps = cycle === "day" ? at - 1 : speedStops(pace) - at;
  return {
    [key]: 1,
    [amountKey]: snap(pace.min + steps * pace.step, pace.min, pace.max, pace.step),
  };
}

/** "30 s", "4.4 min", "13 min", "1 h 20 min": a span of minutes in plain words. */
export function minutesText(minutes: number): string {
  if (minutes < 1) return `${Math.round(minutes * 60)} s`;
  if (minutes < 10) return `${Number(minutes.toFixed(1))} min`;
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole} min`;
  const rest = whole % 60;
  return `${Math.floor(whole / 60)} h${rest === 0 ? "" : ` ${rest} min`}`;
}

/** How long one turn takes at an amount: a day's minutes from its pace, a season's minutes as they are. */
export function turnMinutes(cycle: Cycle, amount: number): number {
  return cycle === "day" ? DAY_MINUTES / amount : amount;
}

/** A cycle's speed in words: "still", "a day in 4 min", "a season in 2 min". */
export function speedText(cycle: Cycle, on: boolean, amount: number): string {
  if (!on || amount <= 0) return "still";
  return `a ${cycle === "day" ? "day" : "season"} in ${minutesText(turnMinutes(cycle, amount))}`;
}
