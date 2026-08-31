import { PluginManifestSchema } from "@manifold/protocol";
import { assembleRoster } from "@manifold/plugin";
import { describe, expect, test } from "bun:test";
import { notesManifest } from "../src/index.ts";

/**
 * A NOTE IS NOT DEFAULT CANVAS FURNITURE, and this manifest is the only place that says so.
 *
 * When the `text` element moved out of the engine, the closed `ITEM_KINDS.text` row moved with
 * it: the placement algebra now reads a contributed kind's traits from the composition (ADR
 * 0013 §12). Two of those traits are load-bearing and neither is the default a stroke gets —
 * `tileable`, because a composition leaf may BE a note, and `on-claim`, because a note born on
 * a canvas has no home container until something claims it. Getting either wrong silently
 * changes where notes may be dropped, with no type error anywhere, so it is asserted here.
 */
describe("core.notes manifest", () => {
  test("declares the placement traits the closed ITEM_KINDS row used to hold", () => {
    const element = notesManifest.contributes.elements[0];

    expect(notesManifest.contributes.elements).toHaveLength(1);
    expect(element?.type).toBe("text");
    expect(element?.placement).toEqual({
      groups: ["tileable", "canvas_item"],
      guards: [],
      homed: "on_claim",
    });
  });

  test("is legal manifest data the server will accept, and composes", () => {
    // The manifest is inert DATA validated by a strict schema (ADR 0010 rule 2): a field the
    // protocol does not know is a refusal, not an extension point.
    expect(PluginManifestSchema.safeParse(notesManifest).success).toBe(true);

    const assembly = assembleRoster([{ manifest: notesManifest, actions: [] }], new Set<string>());
    expect(assembly.elements.get("text")?.plugin).toBe("core.notes");
    // No actions: every note mutation is a scene transaction (D6), so there is no door to
    // declare and nothing for the denial ladder to guard.
    expect([...assembly.actions.keys()]).toEqual([]);
  });

  test("goes dormant as a named ghost, because a note holds a user's prose", () => {
    // Silence IS the declaration: absent `dormant` means the engine's inert named placeholder,
    // so disabling the plugin leaves every note visible and recoverable rather than blank.
    expect(notesManifest.dormant).toBeUndefined();
  });
});
