import { defineAction } from "@manifold/plugin";
import {
  HEX_COLOR,
  MAX_TEXT_LENGTH,
  type PluginManifest,
  SharedTextRecordSchema,
} from "@manifold/protocol";
import { z } from "zod";
import { TextDocumentReferenceSchema } from "./document.ts";

export {
  decodeTextDocument,
  decodeTextDocumentRoute,
  encodeTextDocument,
  textDocumentPath,
  TextDocumentReferenceSchema,
  type TextDocumentRef,
} from "./document.ts";

export const TEXT_NAMESPACE = "core.text";

export const TextDocumentBodySchema = SharedTextRecordSchema.extend({
  namespace: z.literal(TEXT_NAMESPACE),
});

export const textManifest: PluginManifest = {
  id: TEXT_NAMESPACE,
  version: "1.0.0",
  title: "Text",
  description: "Independent collaborative documents, with one editor wherever they are shown.",
  capabilities: ["scenes:write", "containers:read", "containers:write"],
  contributes: {
    panels: [{ id: "documents", title: "Documents" }],
    sections: [{ id: "documents", title: "Documents", order: 4, presentation: "plain" }],
    routes: [{ segment: "text", title: "Documents" }],
    elements: [
      {
        type: "text",
        title: "Text document",
        presentation: { canvas: "body", composition: "titlebar" },
        placement: { groups: ["tileable"], guards: [], homed: "on_claim" },
      },
    ],
    disciplines: [
      {
        id: "text",
        title: "Documents",
        item: {
          groups: ["tileable", "embeddable", "unplaceable", "canvas_item_as_portal"],
          guards: ["no_self_embed"],
          homed: "inline",
        },
        accepts: [],
        guards: ["discipline_match"],
        destinations: [],
      },
    ],
    tools: [],
    events: [],
  },
};

export const textElements = {
  text: z.strictObject({
    document: TextDocumentReferenceSchema,
    fontSize: z.number().finite().positive(),
    color: z.string().regex(HEX_COLOR),
    fitContent: z.boolean().optional(),
  }),
};

export const CreateTextInputSchema = z.strictObject({
  home: z.strictObject({ kind: z.literal("container"), containerId: z.string().min(1).max(128) }),
  documentId: z.string().min(1).max(128).optional(),
  text: z.string().max(MAX_TEXT_LENGTH).default(""),
  reference: z.boolean().default(true),
});

export const CreateTextResultSchema = z.strictObject({
  containerId: z.string().min(1).max(128),
  documentId: z.string().min(1).max(128),
  reference: TextDocumentReferenceSchema,
});

export const textActions = [
  defineAction({
    name: "create",
    title: "Create a text document in its authority home",
    caps: ["scenes:write"],
    requirements: [{ cap: "scenes:write", target: ["home"] }],
    scope: "container",
    input: CreateTextInputSchema,
    result: CreateTextResultSchema,
  }),
];
