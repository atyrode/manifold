import { z } from "zod";

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .refine((value) => !["__proto__", "constructor", "prototype", ".", ".."].includes(value));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revisions = z.record(name, digest).refine((value) => Object.keys(value).length <= 128);

/** An installation promotes exact native bindings, never the contents of credentials. */
export const JobResourceBindingsSchema = z.strictObject({
  tools: revisions,
  services: revisions,
  anchors: revisions,
});
export type JobResourceBindings = z.infer<typeof JobResourceBindingsSchema>;

/** The owner advertises only non-secret identifiers and immutable policy fingerprints. */
export const JobResourceInventorySchema = JobResourceBindingsSchema.extend({
  serviceDefinitions: z.record(name, z.strictObject({
    revision: name,
    operationIds: z.array(name).max(64),
  })).refine((value) => Object.keys(value).length <= 64),
});
export type JobResourceInventory = z.infer<typeof JobResourceInventorySchema>;
