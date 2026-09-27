import { describe, expect, test } from "bun:test";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Button,
  Cluster,
  FRAME_ELEMENT_PREFIX,
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

type Props = Record<string, unknown>;

/**
 * What one component emits when a frame root renders it. The component is called inside a
 * real render (its frame-mode read needs a React owner); a refusal is carried out and thrown
 * here, where the test can see it.
 */
function emitted(element: ReactElement): ReactElement<Props> {
  const { type, props } = element as ReactElement<Props>;
  const component = type as (props: Props) => unknown;
  let result = { value: null } as { readonly value: unknown } | { readonly refusal: unknown };
  function Probe(): null {
    try {
      result = { value: component(props) };
    } catch (refusal) {
      result = { refusal };
    }
    return null;
  }
  renderToStaticMarkup(
    <FrameModeProvider>
      <Probe />
    </FrameModeProvider>,
  );
  if ("refusal" in result) throw result.refusal;
  if (!isValidElement<Props>(result.value)) throw new Error("the component emitted no element");
  return result.value;
}

describe("one component, two modes", () => {
  test("a button is a DOM button in the page and a closed intrinsic in a frame", () => {
    expect(
      renderToStaticMarkup(
        <Button action="acme.notes.save" onClick={() => {}}>
          Save
        </Button>,
      ),
    ).toBe('<button type="button" class="mf-vocab-button" data-action="acme.notes.save">Save</button>');

    let pressed = 0;
    const frame = emitted(
      <Button action="acme.notes.save" tone="accent" onClick={() => (pressed += 1)}>
        Save {2}
      </Button>,
    );
    expect(frame.type).toBe(`${FRAME_ELEMENT_PREFIX}button`);
    expect(frame.props["label"]).toBe("Save 2");
    expect(frame.props["action"]).toBe("acme.notes.save");
    expect(frame.props["tone"]).toBe("accent");
    const onClick = frame.props["onClick"];
    if (typeof onClick !== "function") throw new Error("the press did not cross");
    onClick();
    expect(pressed).toBe(1);
  });

  test("Stack and Cluster are boxes carrying a bounded rem gap and their metadata", () => {
    const column = emitted(<Stack gap="0" align="flex-start" />);
    expect(column.type).toBe(`${FRAME_ELEMENT_PREFIX}box`);
    expect(column.props).toMatchObject({ direction: "column", gapRem: 0, align: "start" });

    const row = emitted(
      <Cluster gap="0.45rem" justify="space-between" data-testid="machines-rail" title="Fleet">
        <Text>one</Text>
      </Cluster>,
    );
    expect(row.props).toMatchObject({
      direction: "row",
      wrap: true,
      gapRem: 0.45,
      justify: "between",
      testId: "machines-rail",
      title: "Fleet",
    });
  });

  test("an icon crosses as a name from its vocabulary, never as a drawing", () => {
    expect(emitted(<ItemIcon kind="machine" size={14} />).props).toEqual({
      icon: { family: "item", name: "machine", size: 14 },
    });
  });
});

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
      "not text",
    );
  });

  test("a glyph size the wire does not admit", () => {
    expect(() => emitted(<ItemIcon kind="machine" size={40} />)).toThrow("size 40");
    expect(() => emitted(<ItemIcon kind="machine" className="mark" />)).toThrow("`className`");
  });
});
