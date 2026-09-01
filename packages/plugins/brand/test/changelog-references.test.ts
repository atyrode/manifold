import { describe, expect, test } from "bun:test";
import { parseChangelogReferences } from "../src/changelog-references.ts";

describe("changelog references", () => {
  test("links issue and pull-request references without changing surrounding copy", () => {
    expect(parseChangelogReferences("Restored the cursor (#30, #32).")).toEqual([
      { kind: "text", text: "Restored the cursor (" },
      {
        kind: "reference",
        text: "#30",
        href: "https://github.com/atyrode/manifold/issues/30",
      },
      { kind: "text", text: ", " },
      {
        kind: "reference",
        text: "#32",
        href: "https://github.com/atyrode/manifold/issues/32",
      },
      { kind: "text", text: ")." },
    ]);
  });

  test("leaves entries without references as plain text", () => {
    expect(parseChangelogReferences("Added folders.")).toEqual([
      { kind: "text", text: "Added folders." },
    ]);
  });
});
