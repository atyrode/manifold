import { z } from "zod";

const OpaqueIdSchema = z.string().min(1).max(128);
const DocumentTupleSchema = z.tuple([OpaqueIdSchema, OpaqueIdSchema]);
// Two maximally escaped ids, quotes, comma and brackets.
const MAX_REFERENCE_LENGTH = 128 * 6 * 2 + 7;

export interface TextDocumentRef {
  readonly homeContainerId: string;
  readonly documentId: string;
}

export function encodeTextDocument(homeContainerId: string, documentId: string): string {
  return JSON.stringify(DocumentTupleSchema.parse([homeContainerId, documentId]));
}

export function decodeTextDocument(value: unknown): TextDocumentRef | null {
  if (typeof value !== "string" || value.length > MAX_REFERENCE_LENGTH) return null;
  let tuple: unknown;
  try {
    tuple = JSON.parse(value);
  } catch {
    return null;
  }
  const parsed = DocumentTupleSchema.safeParse(tuple);
  return parsed.success ? { homeContainerId: parsed.data[0], documentId: parsed.data[1] } : null;
}

export const TextDocumentReferenceSchema = z
  .string()
  .max(MAX_REFERENCE_LENGTH)
  .refine((value) => decodeTextDocument(value) !== null, "Invalid text document reference");

export function textDocumentPath(reference: string): string {
  const ref = TextDocumentReferenceSchema.parse(reference);
  return `/text/${encodeURIComponent(ref)}`;
}

/** The router hands us the still-encoded remainder; a document is exactly one segment. */
export function decodeTextDocumentRoute(rest: string): TextDocumentRef | null {
  if (rest.includes("/")) return null;
  try {
    return decodeTextDocument(decodeURIComponent(rest));
  } catch {
    return null;
  }
}
