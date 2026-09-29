import { z } from "zod";
import { MAX_TEXT_LENGTH } from "./elements.ts";

/** A collection name, not a plugin registry or an additional authority root. */
export const SharedTextNamespaceSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

/** The containing room supplies the authority home; ids stay opaque within a namespace. */
export const SharedTextRefSchema = z.strictObject({
  namespace: SharedTextNamespaceSchema,
  id: z.string().min(1).max(128),
});
export type SharedTextRef = z.infer<typeof SharedTextRefSchema>;

/**
 * A read projection of one independently retained collaborative text. The document stores
 * `text` as a Y.Text, never this string as a second canonical copy. Authorship has the same
 * optional, server-acceptance-order meaning as a scene element's attribution.
 */
export const SharedTextRecordSchema = SharedTextRefSchema.extend({
  text: z.string().max(MAX_TEXT_LENGTH),
  lastEditedBy: z.string().min(1).max(128).optional(),
  lastEditedAt: z.number().int().nonnegative().optional(),
});
export type SharedTextRecord = z.infer<typeof SharedTextRecordSchema>;
