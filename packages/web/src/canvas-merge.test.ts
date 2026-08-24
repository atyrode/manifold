import { describe, expect, test } from "bun:test";
import type { SceneElement } from "@manifold/protocol";
import { mergeCanonicalScene, type CanvasSceneStamp } from "./canvas-merge.ts";

interface LiveElement extends CanvasSceneStamp {
  readonly local: true; // marker proving live object identity survives the merge
}

function live(
  id: string,
  version: number,
  versionNonce: number,
  index: string,
  isDeleted = false,
): LiveElement {
  return { id, version, versionNonce, isDeleted, index, local: true };
}

function canonical(
  id: string,
  version: number,
  versionNonce: number,
  index: string,
  isDeleted = false,
): SceneElement {
  return { id, version, versionNonce, isDeleted, index };
}

function scene(...elements: readonly SceneElement[]): ReadonlyMap<string, SceneElement> {
  return new Map(elements.map((element) => [element.id, element]));
}

describe("mergeCanonicalScene", () => {
  test("returns null when the canvas is ahead of canonical — own echo is a no-op", () => {
    // Regression for the revert-on-release bug: mid-gesture the canvas holds version 9
    // while only the version-5 partial was flushed. The echo must not repaint anything.
    const result = mergeCanonicalScene(
      [live("stroke", 9, 100, "a1")],
      scene(canonical("stroke", 5, 100, "a1")),
    );
    expect(result).toBeNull();
  });

  test("returns null for an identical version+nonce duplicate", () => {
    expect(
      mergeCanonicalScene([live("a", 3, 7, "a0")], scene(canonical("a", 3, 7, "a0"))),
    ).toBeNull();
  });

  test("applies a canonical record that beats the live element", () => {
    const remote = canonical("a", 4, 7, "a0");
    const result = mergeCanonicalScene([live("a", 3, 7, "a0")], scene(remote));
    expect(result).not.toBeNull();
    expect(result?.winners).toEqual([remote]);
    expect(result?.elements).toEqual([remote]);
  });

  test("preserves unflushed local-only elements alongside remote additions", () => {
    const remote = canonical("remote", 1, 1, "a2");
    const mine = live("mine", 6, 42, "a1");
    const result = mergeCanonicalScene([mine], scene(remote));
    expect(result?.winners).toEqual([remote]);
    // Local element survives with object identity intact; output is in canonical order.
    expect(result?.elements).toEqual([mine, remote]);
  });

  test("equal version resolves by lower nonce, matching protocol reconcile", () => {
    const lowerNonce = canonical("a", 3, 5, "a0");
    expect(mergeCanonicalScene([live("a", 3, 9, "a0")], scene(lowerNonce))?.winners).toEqual([
      lowerNonce,
    ]);
    expect(
      mergeCanonicalScene([live("a", 3, 2, "a0")], scene(canonical("a", 3, 9, "a0"))),
    ).toBeNull();
  });

  test("applies canonical deletions that win", () => {
    const tombstone = canonical("a", 5, 1, "a0", true);
    const result = mergeCanonicalScene([live("a", 4, 1, "a0")], scene(tombstone));
    expect(result?.elements).toEqual([tombstone]);
  });

  test("mixed batch: stale records skipped, fresh records applied, order canonical", () => {
    const freshB = canonical("b", 9, 1, "a0");
    const result = mergeCanonicalScene(
      [live("a", 5, 1, "a1"), live("b", 2, 1, "a3")],
      scene(canonical("a", 4, 1, "a1"), freshB),
    );
    expect(result?.winners).toEqual([freshB]);
    expect(result?.elements.map((element) => element.id)).toEqual(["b", "a"]);
    expect(result?.elements[1]).toMatchObject({ local: true });
  });
});
