import { describe, expect, test } from "bun:test";
import { noteHeightFor } from "../src/web.tsx";

/**
 * A note grows and shrinks as it is typed, and every commit is the SCENE's (`tx.patch`), not
 * CSS's — because every other principal has to see the same box. The wrap itself is measured
 * live off the editing textarea's own `scrollHeight` (issue #98: a text-only, newline-counting
 * formula agreed with itself until a line actually wrapped, then silently under-sized the
 * committed box while the editor's native scrollbar hid the shortfall from the author). This
 * function is what is left to test purely: the floor a measured height may never cross, and
 * that a taller measurement always passes straight through.
 */
describe("noteHeightFor", () => {
  test("floors a small or degenerate measurement at one empty line", () => {
    expect(noteHeightFor(10)).toBe(48);
    expect(noteHeightFor(0)).toBe(48);
    expect(noteHeightFor(48)).toBe(48);
  });

  test("passes a genuinely taller measurement through unchanged", () => {
    // A wrapped paragraph's real scrollHeight, exactly as `NoteNode` would read it live.
    expect(noteHeightFor(268)).toBe(268);
    expect(noteHeightFor(72)).toBe(72);
  });
});
