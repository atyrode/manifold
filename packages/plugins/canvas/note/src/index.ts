import { HEX_COLOR, MAX_TEXT_LENGTH, type PluginManifest } from "@manifold/protocol";
import { z } from "zod";

/** Canvas geometry belongs to this child; the referenced document belongs to its text peer. */
export const canvasNoteManifest: PluginManifest = {
  id: "core.canvas.note",
  version: "1.0.0",
  title: "Canvas notes",
  description: "Canvas notes and the text tool, borrowing the independent text editor.",
  capabilities: ["scenes:write"],
  dependencies: {
    "core.canvas": {
      type: "required",
      reason: "the note representation and its point tool belong to the canvas surface",
    },
    "core.text": {
      type: "required",
      reason: "notes reference documents and borrow their owner's collaborative editor",
    },
  },
  contributes: {
    panels: [],
    sections: [],
    elements: [
      {
        type: "canvas_note",
        title: "Canvas note",
        representationOf: "text",
        presentation: { canvas: "body", composition: "titlebar" },
        placement: { groups: ["canvas_item"], guards: [], homed: "on_claim" },
      },
    ],
    tools: [{ id: "text", title: "Text" }],
    events: [],
  },
};

export const canvasNoteElements = {
  canvas_note: z.strictObject({
    // The peer owns address decoding. This child carries its bounded opaque reference.
    document: z.string().min(1).max(MAX_TEXT_LENGTH),
    fontSize: z.number().finite().positive(),
    color: z.string().regex(HEX_COLOR),
    fitContent: z.boolean().optional(),
  }),
};
