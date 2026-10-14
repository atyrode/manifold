import { describe, expect, test } from "bun:test";
import {
  LAST_CREATOR_KEY,
  cycleCreator,
  draftCreator,
  recallCreator,
  rememberCreator,
} from "../src/creator-choice.ts";
import { brokenStorage, memoryStorage } from "./storage-fakes.ts";

const offered = [{ id: "new-canvas" }, { id: "new-composition" }, { id: "new-folder" }];

/**
 * WHERE THE DRAFT ENTRY OPENS (#1079): the creator last run on this device while it is still
 * offered to this reader, otherwise the first entry offered. The offered list is already
 * filtered (owner enabled, own setting not false), so "hidden", "disabled", "uninstalled" and
 * "never a creator" all arrive here as the same case: not in the list.
 */
describe("draftCreator", () => {
  test("the remembered pick opens the draft while it is offered", () => {
    expect(draftCreator(offered, "new-folder")?.id).toBe("new-folder");
  });

  test("no memory, or a pick no longer offered, falls back to the first entry", () => {
    expect(draftCreator(offered, null)?.id).toBe("new-canvas");
    expect(draftCreator(offered, "a-stranger-entry")?.id).toBe("new-canvas");
    // The pick was hidden: the draft falls back, and returns to it when the entry does.
    expect(draftCreator(offered.slice(0, 2), "new-folder")?.id).toBe("new-canvas");
  });

  test("nothing offered is no draft at all, so the control is absent", () => {
    expect(draftCreator([], "new-folder")).toBeNull();
  });
});

describe("cycleCreator", () => {
  test("Tab steps forward in declared order and wraps past the last entry", () => {
    expect(cycleCreator(offered, "new-canvas", 1)?.id).toBe("new-composition");
    expect(cycleCreator(offered, "new-folder", 1)?.id).toBe("new-canvas");
  });

  test("Shift+Tab steps back and wraps before the first entry", () => {
    expect(cycleCreator(offered, "new-composition", -1)?.id).toBe("new-canvas");
    expect(cycleCreator(offered, "new-canvas", -1)?.id).toBe("new-folder");
  });

  test("a choice that left the list mid-draft steps from the first entry", () => {
    expect(cycleCreator(offered, "gone", 1)?.id).toBe("new-composition");
    expect(cycleCreator(offered, "gone", -1)?.id).toBe("new-folder");
  });

  test("one entry stays itself; none is nothing", () => {
    expect(cycleCreator([{ id: "only" }], "only", 1)?.id).toBe("only");
    expect(cycleCreator([], "only", 1)).toBeNull();
  });
});

describe("creator memory", () => {
  test("a pick round-trips under its registered key", () => {
    const storage = memoryStorage();
    expect(recallCreator(storage)).toBeNull();
    rememberCreator(storage, "new-folder");
    expect(storage.items.get(LAST_CREATOR_KEY)).toBe("new-folder");
    expect(recallCreator(storage)).toBe("new-folder");
  });

  test("a storage fault is no memory, never a broken control", () => {
    expect(recallCreator(brokenStorage)).toBeNull();
    expect(() => rememberCreator(brokenStorage, "new-folder")).not.toThrow();
  });
});
