import { describe, expect, test } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Cluster,
  FrameModeProvider,
  ItemIcon,
  Stack,
  Text,
} from "../src/frames.ts";

/**
 * THE FRAME SEAM'S CONTRACT (ADR 0053): one component is ordinary DOM in the page and one
 * closed intrinsic under a frame root, carrying its kind's data and the author's callbacks —
 * and whatever only a DOM could carry refuses by name instead of vanishing.
 */


/** Let React invoke the component under the real frame-mode context. */
function emitted(element: ReactElement): string {
  return renderToStaticMarkup(<FrameModeProvider>{element}</FrameModeProvider>);
}


describe("what a frame cannot carry refuses by name", () => {
  test("DOM-only props on a layout primitive", () => {
    expect(() => emitted(<Stack className="rail" />)).toThrow("`className`");
    expect(() => emitted(<Stack style={{ flex: 1 }} />)).toThrow("`style`");
    expect(() => emitted(<Stack ref={() => {}} />)).toThrow("`ref`");
    expect(() => emitted(<Cluster onClick={() => {}} />)).toThrow("`onClick`");
    expect(() => emitted(<Stack role="list" />)).toThrow('role "list"');
  });

  test("a gap outside the box's bounded rem lengths", () => {
    expect(() => emitted(<Stack gap="1em" />)).toThrow('gap "1em"');
    expect(() => emitted(<Stack gap="4.5rem" />)).toThrow('gap "4.5rem"');
  });

  test("an element where a label's text belongs", () => {
    // The type already forbids it; a frame must refuse it anyway, since JS callers exist.
    expect(() => emitted(createElement(Text, null, createElement("b", null, "bold")))).toThrow(
      TypeError,
    );
  });

  test("a glyph size the wire does not admit", () => {
    expect(() => emitted(<ItemIcon kind="machine" size={40} />)).toThrow("size 40");
    expect(() => emitted(<ItemIcon kind="machine" className="mark" />)).toThrow("`className`");
  });
});
