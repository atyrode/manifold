import { describe, expect, test } from "bun:test";
import { UI_NODE_TYPES, UiNodeSchema, type UiNode } from "@manifold/protocol";
import { ui } from "../src/ui.ts";

/**
 * THE BUILDERS AND THE SCHEMA AGREE. A builder exists per published kind and nothing it can
 * produce is refused by the host's `UiNodeSchema` — that is the whole promise of typing the
 * builders against the protocol's own union rather than against a private copy.
 */

/** One node of every kind, every optional field set, nested under one box. */
const everything: UiNode = ui.box({ direction: "row", gap: 3, grow: true, wrap: true }, [
  ui.heading("Title", 1),
  ui.text("prose", { tone: "muted", mono: true, wrap: false }),
  ui.code("{ }"),
  ui.badge("new", "success"),
  ui.divider(),
  ui.spinner("loading"),
  ui.button("Go", "go", {
    payload: { n: 1 },
    tone: "accent",
    disabled: false,
    action: "acme.thing.go",
  }),
  ui.select("pick", "a", [{ value: "a", label: "A" }], { label: "Pick", disabled: false }),
  ui.input("edit", "text", { label: "Edit", placeholder: "type", mono: true, disabled: false }),
  ui.toggle("flip", true, "Flip", { disabled: false }),
  ui.list([{ key: "k", primary: "P", secondary: "S", tone: "danger", event: "open", payload: 1 }]),
  ui.empty("nothing here"),
]);

describe("ui builders", () => {
  test("one builder per published kind, and a tree of all of them is schema-valid", () => {
    expect(Object.keys(ui).sort()).toEqual([...UI_NODE_TYPES].sort());
    const parsed = UiNodeSchema.safeParse(everything);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual(everything);
    const kinds = new Set<string>();
    const walk = (node: UiNode): void => {
      kinds.add(node.type);
      if (node.type === "box") node.children.forEach(walk);
    };
    walk(parsed.data);
    expect([...kinds].sort()).toEqual([...UI_NODE_TYPES].sort());
  });

  test("the bare forms carry no optional keys, so a strict schema accepts them", () => {
    for (const node of [
      ui.heading("h"),
      ui.text("t"),
      ui.badge("b"),
      ui.spinner(),
      ui.button("b", "e"),
      ui.select("e", null, []),
      ui.input("e", ""),
      ui.toggle("e", false, "l"),
      ui.list([]),
      ui.box({}, []),
    ]) {
      expect(UiNodeSchema.safeParse(node).success).toBe(true);
    }
    expect(ui.heading("h")).toEqual({ type: "heading", text: "h" });
    expect(ui.button("Bump", "bump", { action: "acme.counter.bump" })).toEqual({
      type: "button",
      label: "Bump",
      event: "bump",
      action: "acme.counter.bump",
    });
  });
});
