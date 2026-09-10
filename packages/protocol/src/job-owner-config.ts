import { z } from "zod";
import { ServiceCredentialReferenceSchema } from "./services.ts";

const absolute = z
  .string()
  .startsWith("/")
  .max(4096)
  .refine((value) => !value.includes("\0"));

/** Reviewed local authority; never accepted from a job or service RPC. */
export const JobOwnerConfigSchema = z.strictObject({
  machineId: z.string().min(1).max(128),
  admissionPublicKey: z.string().min(1).max(4096),
  stateDirectory: absolute,
  delegatedCgroup: absolute,
  bubblewrap: absolute,
  protectedDirectories: z.array(absolute).max(32),
  anchors: z.partialRecord(
    z.enum(["home", "data", "state", "cache", "config", "runtime"]),
    absolute,
  ),
  runtimeTools: z
    .record(
      z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
      z
        .array(
          z.strictObject({
            source: absolute,
            target: absolute,
            kind: z.enum(["file", "directory"]),
          }),
        )
        .min(1)
        .max(128),
    )
    .refine((tools) => Object.keys(tools).length <= 128),
  serviceCredentials: z
    .record(
      z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
        .refine((value) => !["__proto__", "constructor", "prototype"].includes(value)),
      z.strictObject({ source: absolute, origins: ServiceCredentialReferenceSchema.shape.origins }),
    )
    .refine((values) => Object.keys(values).length <= 64)
    .optional(),
  artifactOrigins: z
    .array(
      z
        .url()
        .refine((value) => new URL(value).protocol === "https:" && new URL(value).origin === value),
    )
    .min(1)
    .max(128),
});
export type JobOwnerConfig = z.infer<typeof JobOwnerConfigSchema>;

/** Bootstrap binds authenticated identity, issuer and private state; templates cannot override them. */
export const JobOwnerConfigTemplateSchema = JobOwnerConfigSchema.omit({
  machineId: true,
  admissionPublicKey: true,
  stateDirectory: true,
});
export type JobOwnerConfigTemplate = z.infer<typeof JobOwnerConfigTemplateSchema>;
