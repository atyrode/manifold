import { describe, expect, test } from "bun:test";
import { SECTION_FOLDS_KEY, isFolded, recallFolds, rememberFolds } from "../src/section-folds.ts";
import { brokenStorage, memoryStorage } from "./storage-fakes.ts";

/**
 * WHICH SIDEBAR DISCLOSURES START FOLDED (#1079): a section nobody on this device has touched
 * follows its manifest — folded unless it declares `defaultOpen` — and a reader's own fold or
 * unfold outranks the declaration in either direction and survives a reload.
 */
describe("isFolded", () => {
  const index = { id: "index", defaultOpen: true };
  const machines = { id: "machines" };

  test("untouched, only a section declaring defaultOpen starts open", () => {
    expect(isFolded(index, {})).toBe(false);
    expect(isFolded(machines, {})).toBe(true);
    expect(isFolded({ id: "agents", defaultOpen: false }, {})).toBe(true);
  });

  test("the reader's choice outranks the declaration both ways", () => {
    expect(isFolded(index, { index: true })).toBe(true);
    expect(isFolded(machines, { machines: false })).toBe(false);
  });
});

describe("fold memory", () => {
  test("choices round-trip under the registered key", () => {
    const storage = memoryStorage();
    expect(recallFolds(storage)).toEqual({});
    rememberFolds(storage, { index: true, machines: false });
    expect(storage.items.has(SECTION_FOLDS_KEY)).toBe(true);
    expect(recallFolds(storage)).toEqual({ index: true, machines: false });
  });

  test("a corrupt or foreign value is no memory, and non-boolean entries are dropped", () => {
    const storage = memoryStorage();
    for (const stored of ["{", "[true]", "null", '"index"']) {
      storage.setItem(SECTION_FOLDS_KEY, stored);
      expect(recallFolds(storage)).toEqual({});
    }
    storage.setItem(SECTION_FOLDS_KEY, JSON.stringify({ index: "yes", machines: false }));
    expect(recallFolds(storage)).toEqual({ machines: false });
  });

  test("a storage fault is the manifest defaults, never a broken rail", () => {
    expect(recallFolds(brokenStorage)).toEqual({});
    expect(() => rememberFolds(brokenStorage, { index: true })).not.toThrow();
  });
});
