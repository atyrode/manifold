import { z } from "zod";
import type { MachineHalf } from "./jobs.ts";
import { ServiceCredentialReferenceSchema } from "./services.ts";

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
  credentialReferences: z.array(ServiceCredentialReferenceSchema).max(64).optional(),
});
export type JobResourceInventory = z.infer<typeof JobResourceInventorySchema>;

export type JobResourceRequirements = Record<"tools" | "services" | "anchors", string[]>;

/** Artifact-managed tools are already pinned by the installation's immutable declaration. */
export function jobResourceRequirements(
  machine: MachineHalf,
  operationId: string,
  platform: keyof MachineHalf["artifacts"],
): JobResourceRequirements {
  const operation = machine.operations[operationId];
  if (!operation) throw new Error("unknown_operation");
  const artifact = machine.artifacts[platform];
  const managed = new Set(Object.keys(machine.tools ?? {}));
  for (const platforms of Object.values(machine.tools ?? {}))
    for (const alias of Object.keys(platforms[platform]?.files ?? {})) managed.add(alias);
  return {
    tools: operation.runtimeTools.filter((tool) => !managed.has(tool) && !artifact?.files?.[tool]),
    services: (operation.services ?? []).map((binding) => binding.serviceId),
    anchors: [...new Set(operation.locations.map(({ locationId }) => {
      const location = machine.locations[locationId];
      if (!location) throw new Error("unknown_location");
      return location.anchor;
    }))],
  };
}

/** Unrelated installation resources do not become an operation's authority or drift boundary. */
export function jobResourceBindingsFor(
  machine: MachineHalf,
  operationId: string,
  platform: keyof MachineHalf["artifacts"],
  bindings: JobResourceBindings | undefined,
): JobResourceBindings | undefined {
  if (bindings === undefined) return undefined;
  const required = jobResourceRequirements(machine, operationId, platform);
  const result: JobResourceBindings = { tools: {}, services: {}, anchors: {} };
  for (const group of ["tools", "services", "anchors"] as const)
    for (const key of required[group])
      if (Object.hasOwn(bindings[group], key)) result[group][key] = bindings[group][key]!;
  return result;
}

/** Missing resources disable only the operations that need them, not the installed worker. */
export function jobResourceRefusal(
  machine: MachineHalf,
  operationId: string,
  platform: keyof MachineHalf["artifacts"],
  bindings: JobResourceBindings | undefined,
  inventory: JobResourceInventory | undefined,
): string | null {
  const operation = machine.operations[operationId];
  if (!operation) return "unknown_operation";
  if (!machine.requiresResourceBindings && !operation.services?.length) return null;
  if (!bindings) return "resource_bindings_required";
  if (!inventory) return "resource_owner_unavailable";
  const required = jobResourceRequirements(machine, operationId, platform);
  for (const group of ["tools", "services", "anchors"] as const) {
    for (const key of required[group]) {
      if (!inventory[group][key]) return `${group}_unavailable`;
      if (!bindings[group][key]) return `${group}_not_promoted`;
      if (bindings[group][key] !== inventory[group][key]) return `${group}_revision_changed`;
    }
  }
  for (const binding of operation.services ?? []) {
    const policy = inventory.serviceDefinitions[binding.serviceId];
    if (!policy || policy.revision !== binding.revision ||
        binding.operationIds.some((id) => !policy.operationIds.includes(id)))
      return "service_definition_changed";
  }
  return null;
}
