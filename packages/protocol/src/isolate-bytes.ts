import { z } from "zod";
import {
  ByteAdmissionSchema,
  ByteCarrierRequestSchema,
  ByteReadReceiptSchema,
  ByteRefusalSchema,
  ByteWriteReceiptSchema,
  MAX_BYTE_CHUNK_BYTES,
} from "./bytes.ts";
import { LocalNameSchema } from "./plugin.ts";
import { PrincipalSchema } from "./principal.ts";

/** Binary encoding is private to the bounded process boundary, never action/event payloads. */
export const IsolateByteDataSchema = z
  .base64()
  .max(Math.ceil(MAX_BYTE_CHUNK_BYTES / 3) * 4)
  .refine((data) => {
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    return (data.length / 4) * 3 - padding <= MAX_BYTE_CHUNK_BYTES;
  });

const target = { carrierId: LocalNameSchema, input: ByteCarrierRequestSchema };
export const IsolateByteRequestSchema = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("authorize"), ...target }),
  z.strictObject({ method: z.literal("read"), ...target }),
  z.strictObject({ method: z.literal("write"), ...target, data: IsolateByteDataSchema }),
]);
export type IsolateByteRequest = z.infer<typeof IsolateByteRequestSchema>;

export const IsolateByteCtxSchema = z.strictObject({
  principal: PrincipalSchema,
  credentialBinding: z.string().regex(/^[a-f0-9]{64}$/),
  now: z.number().int().nonnegative(),
});
export const IsolateByteReplySchema = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("authorize"), result: ByteAdmissionSchema }),
  z.strictObject({ method: z.literal("write"), result: ByteWriteReceiptSchema }),
  z.strictObject({
    method: z.literal("read"),
    result: ByteReadReceiptSchema.extend({ data: IsolateByteDataSchema }),
  }),
]);
export type IsolateByteReply = z.infer<typeof IsolateByteReplySchema>;
export const IsolateByteOutcomeSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), reply: IsolateByteReplySchema }),
  z.strictObject({ ok: z.literal(false), reason: ByteRefusalSchema }),
]);
export const IsolateByteDeclarationsSchema = z
  .array(z.strictObject({ id: LocalNameSchema, direction: z.enum(["incoming", "outgoing"]) }))
  .max(8)
  .refine((declarations) => new Set(declarations.map(({ id }) => id)).size === declarations.length);
