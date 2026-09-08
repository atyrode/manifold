import { defineAction, type PluginServiceContext, type ServiceDescription, type ServiceConfigurationRead } from "@manifold/plugin";
import {
  ServiceConfigurationSchema,
  ServiceCredentialReferenceSchema,
  ServiceReadArgsSchema,
  ServiceReplySchema,
} from "@manifold/protocol";
import { z } from "zod";
import { ServiceError, type AuthContext } from "./auth.ts";
import type { JobService } from "./job-service.ts";
import type { ActionCtx, ServerPluginDef } from "./plugin-host.ts";

const machine = ServiceReadArgsSchema.pick({ machineId: true });
export const serviceDoorSchemas = {
  describe: machine,
  readConfiguration: machine,
  configureConfiguration: z.strictObject({
    machineId: ServiceReadArgsSchema.shape.machineId,
    expectedRevision: ServiceConfigurationSchema.shape.revision,
    policies: ServiceConfigurationSchema.shape.policies,
  }),
  read: ServiceReadArgsSchema,
};
const description: z.ZodType<ServiceDescription> = z.strictObject({
  machineId: ServiceReadArgsSchema.shape.machineId,
  connected: z.boolean(),
  services: z.array(z.strictObject({
    serviceId: ServiceReadArgsSchema.shape.serviceId,
    revision: ServiceReadArgsSchema.shape.revision,
    policySha256: ServiceReadArgsSchema.shape.policySha256,
    operations: z.array(z.strictObject({
      operationId: ServiceReadArgsSchema.shape.operationId,
      readable: z.boolean(),
      ready: z.boolean(),
      reason: z.string().nullable(),
    })),
  })),
});
const configurationRead: z.ZodType<ServiceConfigurationRead> = z.strictObject({
  configuration: ServiceConfigurationSchema,
  credentialReferences: z.array(ServiceCredentialReferenceSchema),
});

/** Use the same authority owner for native doors and caller-bound plugin contexts. */
export function serviceContext(
  service: () => JobService,
  auth: AuthContext,
  pluginId: string,
  traceId: number,
): PluginServiceContext {
  return {
    describe: (args) => service().describeServices(auth, machine.parse(args), pluginId),
    readConfiguration: (args) => service().readServiceConfiguration(auth, machine.parse(args)),
    configureConfiguration: (args) => service().configureServiceConfiguration(
      auth, serviceDoorSchemas.configureConfiguration.parse(args), pluginId, String(traceId),
    ),
    read: (args) => service().readService(auth, ServiceReadArgsSchema.parse(args), pluginId, String(traceId)),
  };
}

async function call(run: () => unknown) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ServiceError) return { refused: `${error.code}: service request refused` };
    throw error;
  }
}

export const serviceDoors: ServerPluginDef = {
  manifest: {
    id: "engine.services",
    version: "1.0.0",
    title: "Machine services",
    description: "Native service discovery, owner configuration and governed reads.",
    capabilities: ["*"],
    contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
  },
  actions: Object.entries(serviceDoorSchemas).map(([name, input]) =>
    defineAction<unknown, unknown>({
      name,
      title: name,
      caps: name === "readConfiguration" || name === "configureConfiguration" ? ["*"] : [],
      // Even malformed policy/input bodies must never enter the trace ledger.
      trace: "opaque",
      input,
      result: name === "describe" ? description
        : name === "readConfiguration" ? configurationRead
          : name === "configureConfiguration" ? ServiceConfigurationSchema : ServiceReplySchema,
    }),
  ),
  handlers: {
    describe: (ctx: ActionCtx, args: z.infer<typeof machine>) => call(() => ctx.services.describe(args)),
    readConfiguration: (ctx: ActionCtx, args: z.infer<typeof machine>) => call(() => ctx.services.readConfiguration(args)),
    configureConfiguration: (ctx: ActionCtx, args: z.infer<typeof serviceDoorSchemas.configureConfiguration>) =>
      call(() => ctx.services.configureConfiguration(args)),
    read: (ctx: ActionCtx, args: z.infer<typeof ServiceReadArgsSchema>) => call(() => ctx.services.read(args)),
  },
};
