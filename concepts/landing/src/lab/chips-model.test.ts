import { describe, expect, test } from "bun:test";
import { chipKey, DRAG_THRESHOLD, pace, pressMove, SCRUB_SPAN, type Press } from "./chips-model.ts";

const unit = { min: 0, max: 1, step: 0.01 };
/** A press at (100, 50) on a value of 0.5. */
const down: Press = { x: 100, y: 50, value: 0.5, scrub: undefined };
const key = (name: string, shiftKey = false) => ({ key: name, shiftKey }) as KeyboardEvent;

describe("a press", () => {
  test("stays a click until it moves the threshold across", () => {
    const short = pressMove(down, 100 + DRAG_THRESHOLD - 1, 50, 0.01, false, unit);
    expect(short.scrub).toBeUndefined();
    expect(pressMove(down, 100 - DRAG_THRESHOLD + 1, 50, 0.01, false, unit).scrub).toBeUndefined();
    const far = pressMove(down, 100 + DRAG_THRESHOLD, 50, 0.01, false, unit);
    expect(far.scrub?.value).toBeCloseTo(0.5 + DRAG_THRESHOLD * 0.01);
  });

  test("does not drag while it moves more down than across, and keeps dragging once it does", () => {
    expect(pressMove(down, 106, 57, 0.01, false, unit).scrub).toBeUndefined();
    expect(pressMove(down, 106, 56, 0.01, false, unit).scrub).toBeUndefined();
    const dragging = pressMove(down, 110, 52, 0.01, false, unit);
    expect(dragging.scrub).toBeDefined();
    const wandered = pressMove(dragging, 110, 140, 0.01, false, unit);
    expect(wandered.scrub?.value).toBeCloseTo(0.6);
  });

  test("moves the value with the pointer from where it went down, a tenth as fast when fine", () => {
    const right = pressMove(down, 120, 50, 0.01, false, unit);
    expect(right.scrub?.value).toBeCloseTo(0.7);
    const fine = pressMove(right, 140, 50, 0.01, true, unit);
    expect(fine.scrub?.value).toBeCloseTo(0.72);
    const back = pressMove(fine, 90, 50, 0.01, false, unit);
    expect(back.scrub?.value).toBeCloseTo(0.22);
  });

  test("holds the value at its ends, so turning back moves it at once", () => {
    const past = pressMove(down, 300, 50, 0.01, false, unit);
    expect(past.scrub?.value).toBe(1);
    expect(pressMove(past, 290, 50, 0.01, false, unit).scrub?.value).toBeCloseTo(0.9);
    const under = pressMove(down, -200, 50, 0.01, false, unit);
    expect(under.scrub?.value).toBe(0);
    expect(pressMove(under, -195, 50, 0.01, false, unit).scrub?.value).toBeCloseTo(0.05);
  });
});

describe("a pace", () => {
  test("runs the whole range over the pixels given", () => {
    expect(pace({ min: 2, max: 12, step: 1 }, 50)).toBe(0.2);
    expect(pace(unit, SCRUB_SPAN) * SCRUB_SPAN).toBeCloseTo(1);
  });

  test("never divides by a chip with no width", () => {
    expect(pace(unit, 0)).toBe(1);
  });
});

describe("a key on a fader chip", () => {
  test("steps the amount of a chip that is on, a tenth of the range with Shift", () => {
    expect(chipKey(key("ArrowRight"), true, 0.5, unit)).toBe(0.51);
    expect(chipKey(key("ArrowUp"), true, 0.5, unit)).toBe(0.51);
    expect(chipKey(key("ArrowLeft"), true, 0.5, unit)).toBe(0.49);
    expect(chipKey(key("ArrowDown"), true, 0.5, unit)).toBe(0.49);
    expect(chipKey(key("ArrowRight", true), true, 0.5, unit)).toBe(0.6);
    expect(chipKey(key("PageDown"), true, 0.5, unit)).toBe(0.4);
  });

  test("takes it to its ends with Home and End and holds it there", () => {
    const counts = { min: 1, max: 30, step: 1 };
    expect(chipKey(key("Home"), true, 11, counts)).toBe(1);
    expect(chipKey(key("End"), true, 11, counts)).toBe(30);
    expect(chipKey(key("ArrowRight"), true, 30, counts)).toBe(30);
    expect(chipKey(key("ArrowLeft", true), true, 2, counts)).toBe(1);
  });

  test("brings a chip that is off on at the amount it had", () => {
    expect(chipKey(key("ArrowRight"), false, 0.5, unit)).toBe(0.5);
    expect(chipKey(key("End"), false, 0.5, unit)).toBe(0.5);
  });

  test("leaves Space, Enter and other keys to the button", () => {
    expect(chipKey(key(" "), true, 0.5, unit)).toBeUndefined();
    expect(chipKey(key("Enter"), false, 0.5, unit)).toBeUndefined();
    expect(chipKey(key("a"), true, 0.5, unit)).toBeUndefined();
  });
});
