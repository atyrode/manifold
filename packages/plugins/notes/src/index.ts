import { type PluginManifest } from "@manifold/protocol";

/**
 * Notes, as a plugin: one element kind — `text` — and the inline editor that authors it.
 *
 * THERE ARE NO ACTIONS, and that is the plane rule (D6) rather than an omission. A note's
 * every mutation is a per-character edit of a `Y.Text` inside the room's scene document: its
 * legality depends on nothing the author cannot see, its worst-case merge is two people's
 * characters both surviving, and no other principal's authority is consulted. So it is
 * DOCUMENT traffic, exactly like `core.draw`'s strokes, and `scene:write` is declared for the
 * same reason draw declares it — it is the capability a viewer needs to author one, even
 * though nothing here dispatches. The transaction is the door; an action would be a second
 * one (invariant 14).
 *
 * `placement` carries the traits the closed `ITEM_KINDS.text` row used to hold, byte for byte:
 * a note is `tileable` (a composition leaf may BE a note) as well as `canvas-item`, and it is
 * `homed: "on-claim"` because a note born on a canvas has no home container until something
 * claims it. Traits are data, so the placement algebra learns this kind without a switch arm
 * (ADR 0013 §12).
 *
 * No `dormant` field: the default is `ghost`, which is the only honest answer for a node
 * holding a user's prose. Disable this plugin and every note stays in its document, named and
 * inert, on canvases and in tile leaves alike; enable it and the words come back in place,
 * with no reload (D4/R3).
 *
 * What is NOT here yet: the canvas's `text` TOOL (double-click-to-author, the default width,
 * height, font and colour of a fresh note) is still engine chrome inside
 * `core.shell.pad-view`, and it moves with `core.canvas` — AXIOMS.md §Roadmap keeps that row.
 */
export const notesManifest: PluginManifest = {
  id: "core.notes",
  version: "1.0.0",
  title: "Notes",
  description: "Notes: the text element renderer and its collaborative inline editor.",
  capabilities: ["scene:write"],
  contributes: {
    panels: [],
    sections: [],
    elements: [
      {
        type: "text",
        title: "Note",
        placement: { groups: ["tileable", "canvas-item"], guards: [], homed: "on-claim" },
      },
    ],
    tools: [],
    events: [],
  },
};
