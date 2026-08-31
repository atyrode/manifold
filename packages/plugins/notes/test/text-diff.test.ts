import { describe, expect, test } from "bun:test";
import { diffText } from "../src/text-diff.ts";

describe("diffText", () => {
  test("describes an insertion at the cursor", () => {
    expect(diffText("hello", "hello world", 11)).toEqual({
      index: 5,
      remove: 0,
      insert: " world",
    });
  });

  test("describes replacement and deletion without consuming a shared suffix", () => {
    expect(diffText("alpha beta omega", "alpha B omega", 7)).toEqual({
      index: 6,
      remove: 4,
      insert: "B",
    });
    expect(diffText("hello", "helo", 3)).toEqual({ index: 3, remove: 1, insert: "" });
  });

  test("bounds the common prefix by the cursor", () => {
    expect(diffText("abcabc", "abcXabc", 4)).toEqual({
      index: 3,
      remove: 0,
      insert: "X",
    });
  });
});
