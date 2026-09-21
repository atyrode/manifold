import { z } from "zod";

export const HarnessIdSchema = z.string().min(1).max(64);
export type HarnessId = z.infer<typeof HarnessIdSchema>;

/** Exact harness identity on one machine; correlation metadata, never authority. */
export const SessionRefSchema = z.strictObject({
  harness: HarnessIdSchema,
  sessionId: z.string().min(1).max(256),
  machineId: z.string().min(1).max(128),
});
export type SessionRef = z.infer<typeof SessionRefSchema>;
