import { SceneElementSchema } from "@manifold/protocol";
import {
  createSharedText,
  elementsMap,
  sharedTextKey,
  sharedTextsMap,
  writeElement,
  LOCAL_ORIGIN,
  type Y,
} from "@manifold/scene";
import type { z } from "zod";
import { encodeTextDocument } from "./document.ts";
import {
  CreateTextInputSchema,
  CreateTextResultSchema,
  TextDocumentBodySchema,
  TEXT_NAMESPACE,
} from "./index.ts";

interface TextCtx {
  readonly rooms: { get(containerId: string): { readonly doc: Y.Doc } | null };
  readonly principal: { readonly id: string };
  now(): number;
  newId(): string;
  outsideScope(containerId: string | null): { readonly refused: string } | null;
}

export const textHandlers = {
  async create(
    ctx: TextCtx,
    args: z.output<typeof CreateTextInputSchema>,
  ): Promise<z.output<typeof CreateTextResultSchema> | { readonly refused: string }> {
    const containerId = args.home.containerId;
    const outside = ctx.outsideScope(containerId);
    if (outside !== null) return outside;
    const room = ctx.rooms.get(containerId);
    if (room === null) return { refused: "Document home not found" };
    const documentId = args.documentId ?? ctx.newId();
    if (
      sharedTextsMap(room.doc).has(sharedTextKey(TEXT_NAMESPACE, documentId)) ||
      (args.reference && elementsMap(room.doc).has(documentId))
    ) {
      return { refused: "A document or its reference already uses that id" };
    }

    const reference = encodeTextDocument(containerId, documentId);
    const body = TextDocumentBodySchema.parse({
      namespace: TEXT_NAMESPACE,
      id: documentId,
      text: args.text,
      lastEditedBy: ctx.principal.id,
      lastEditedAt: ctx.now(),
    });
    // Validate both halves before the transaction: Yjs transactions do not roll back throws.
    const element = args.reference
      ? SceneElementSchema.parse({
          id: documentId,
          type: "text",
          x: 0,
          y: 0,
          width: 640,
          height: 480,
          zIndex: 0,
          document: reference,
          fontSize: 20,
          color: "#f8f9fa",
          lastEditedBy: body.lastEditedBy,
          lastEditedAt: body.lastEditedAt,
        })
      : null;
    room.doc.transact(() => {
      createSharedText(room.doc, body, LOCAL_ORIGIN);
      if (element !== null) writeElement(room.doc, element, LOCAL_ORIGIN);
    }, LOCAL_ORIGIN);
    return { containerId, documentId, reference };
  },
};
