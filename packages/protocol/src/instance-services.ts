import { z } from "zod";
import { ServicePolicySchema, ServiceReadArgsSchema } from "./services.ts";

const name = ServiceReadArgsSchema.shape.serviceId;
const revision = ServiceReadArgsSchema.shape.revision;
const digest = ServiceReadArgsSchema.shape.policySha256;
export const InstanceServiceTargetSchema = z.strictObject({ serviceId: name });
export const InstanceServiceOwnerSchema = z.strictObject({
  machineId: name,
  name: z.string().min(1).max(256),
  online: z.boolean(),
});
export const InstanceServiceDescriptionSchema = z.strictObject({
  serviceId: name,
  defaultOwner: InstanceServiceOwnerSchema.nullable(),
  owner: InstanceServiceOwnerSchema.nullable(),
  configuration: z
    .strictObject({
      revision,
      pluginId: name,
      enabled: z.boolean(),
      policySha256: digest,
    })
    .nullable(),
  connected: z.boolean(),
  state: z.enum(["unconfigured", "stopped", "stopping", "starting", "ready", "unavailable"]),
  reason: z.string().max(256).nullable(),
});
export const InstanceServicesDescriptionSchema = z.strictObject({
  defaultOwner: InstanceServiceOwnerSchema.nullable(),
  services: z.array(InstanceServiceDescriptionSchema).max(64),
});
export const InstanceServiceConfigurationReadSchema = z.strictObject({
  description: InstanceServiceDescriptionSchema,
  policy: ServicePolicySchema.nullable(),
});
export const ConfigureInstanceServiceArgsSchema = z.strictObject({
  serviceId: name,
  expectedRevision: revision.nullable(),
  machineId: name.optional(),
  policy: ServicePolicySchema,
  enabled: z.boolean(),
});
export const InstanceServiceReadArgsSchema = z.strictObject({
  serviceId: name,
  expectedRevision: revision,
  operationId: ServiceReadArgsSchema.shape.operationId,
  input: ServiceReadArgsSchema.shape.input,
});
export type InstanceServiceOwner = z.infer<typeof InstanceServiceOwnerSchema>;
export type InstanceServiceDescription = z.infer<typeof InstanceServiceDescriptionSchema>;
export type InstanceServicesDescription = z.infer<typeof InstanceServicesDescriptionSchema>;
export type InstanceServiceConfigurationRead = z.infer<
  typeof InstanceServiceConfigurationReadSchema
>;
export type ConfigureInstanceServiceArgs = z.infer<typeof ConfigureInstanceServiceArgsSchema>;
export type InstanceServiceReadArgs = z.infer<typeof InstanceServiceReadArgsSchema>;
