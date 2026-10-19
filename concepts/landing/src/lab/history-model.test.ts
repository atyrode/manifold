import { describe, expect, test } from "bun:test";
import {
  COALESCE_MS,
  HISTORY_CAP,
  historyAt,
  record,
  redoStep,
  undoStep,
} from "./history-model.ts";

const at = (levels: number, pixel = 2) => `scene=country&levels=${levels}&pixel=${pixel}`;

describe("undo steps", () => {
  test("a held arrow key on one control is one step", () => {
    const steps = historyAt(at(2));
    for (let press = 1; press <= 40; press++) record(steps, at(2 + press), press * 33);
    expect(steps.undo).toEqual([at(2)]);
    expect(undoStep(steps)).toBe(at(2));
  });

  test("commits to the same keys further apart than the window are separate steps", () => {
    const steps = historyAt(at(2));
    record(steps, at(3), 0);
    record(steps, at(4), COALESCE_MS + 1);
    expect(steps.undo).toEqual([at(2), at(3)]);
  });

  test("the window runs from the step's last commit, not its first", () => {
    const steps = historyAt(at(2));
    for (let press = 0; press < 5; press++) record(steps, at(3 + (press % 2)), press * 900);
    expect(steps.undo).toEqual([at(2)]);
  });

  test("a commit to other keys is a step of its own, however soon", () => {
    const steps = historyAt(at(2));
    record(steps, at(3), 0);
    record(steps, at(3, 4), 10);
    record(steps, at(4, 4), 20);
    expect(steps.undo).toEqual([at(2), at(3), at(3, 4)]);
  });

  test("a step grown back to where it began goes", () => {
    const steps = historyAt(at(2));
    record(steps, at(3), 0);
    record(steps, at(4), 10);
    record(steps, at(2), 20);
    expect(steps.undo).toEqual([]);
    expect(steps.committed).toBe(at(2));
  });

  test("a playing tour's advances are one step, a hand edit between them breaks it", () => {
    const steps = historyAt("scene=orbit");
    record(steps, "scene=clouds", 0, "advance");
    record(steps, "scene=flock", 60_000, "advance");
    record(steps, "scene=flock&motion=0.2", 61_000);
    record(steps, "scene=skyward", 120_000, "advance");
    record(steps, "scene=swell", 180_000, "advance");
    expect(steps.undo).toEqual(["scene=orbit", "scene=flock", "scene=flock&motion=0.2"]);
  });

  test("after an undo or a redo the next commit is a step of its own", () => {
    const steps = historyAt(at(2));
    record(steps, at(3), 0);
    record(steps, at(4), 10);
    expect(undoStep(steps)).toBe(at(2));
    record(steps, at(5), 20);
    record(steps, at(6), 30);
    expect(steps.undo).toEqual([at(2)]);
    expect(undoStep(steps)).toBe(at(2));
    expect(redoStep(steps)).toBe(at(6));
    record(steps, at(3), 40);
    expect(steps.undo).toEqual([at(2), at(6)]);
    expect(steps.redo).toEqual([]);
  });

  test("an unchanged setup records nothing", () => {
    const steps = historyAt(at(2));
    expect(record(steps, at(2), 0)).toBe(false);
    expect(steps.undo).toEqual([]);
  });

  test("the oldest steps go past the cap", () => {
    const steps = historyAt(at(2, 1));
    for (let step = 0; step <= HISTORY_CAP; step++) record(steps, at(2, step + 2), step * 2000);
    expect(steps.undo.length).toBe(HISTORY_CAP);
    expect(steps.undo[0]).toBe(at(2, 2));
  });
});
