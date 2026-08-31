import { describe, expect, test } from "bun:test";
import { noteHeightFor } from "../src/web.tsx";

/**
 * A note grows as it is typed, and the growth is committed to the SCENE (`tx.patch`), not to
 * CSS — because every other principal has to see the same box. So the formula is a wire-visible
 * contract, not a styling detail, and it moved out of the engine with the renderer that uses it.
 */
describe("noteHeightFor", () => {
  test("sizes multiline prose and never shrinks below a single line", () => {
    expect(noteHeightFor("one", 20)).toBe(48);
    expect(noteHeightFor("one\ntwo", 20)).toBe(72);
    // An empty note is still a target you can click into, so the floor holds.
    expect(noteHeightFor("", 8)).toBe(48);
  });
});
