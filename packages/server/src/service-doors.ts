import { defineAction, type PluginServiceContext, type ServiceDescription } from "@manifold/plugin";
import {
  ServiceConfigurationSchema,
  ServiceConfigurationReadSchema,
  ServiceReadArgsSchema,
  ServiceInvokeArgsSchema,
  ServiceReplySchema,
  ServiceRefusalSchema,
  ServiceDirectQuoteSchema,
  ServiceProxyOperationPolicySchema,
  ServiceOperationPolicySchema,
  ServicePolicySchema,
  ServiceCredentialEnrollmentPrepareArgsSchema,
  ServiceCredentialEnrollmentPrepareReplySchema,
  ServiceCredentialEnrollmentCommitArgsSchema,
  ServiceCredentialEnrollmentCommitReplySchema,
  ServiceCredentialEnrollmentCancelArgsSchema,
  ServiceCredentialEnrollmentCancelReplySchema,
} from "@manifold/protocol";
import {
  InstanceServiceTargetSchema,
  InstanceServiceDescriptionSchema,
  InstanceServicesDescriptionSchema,
  InstanceServiceConfigurationReadSchema,
  ConfigureInstanceServiceArgsSchema,
  InstanceServiceReadArgsSchema,
  InstanceServiceInvokeArgsSchema,
} from "@manifold/protocol";
import { z } from "zod";
import { ServiceError, type AuthContext } from "./auth.ts";
import type { JobService } from "./job-service.ts";
import type { ActionCtx, ServerPluginDef } from "./plugin-host.ts";
import type { ActionAuthorityFence } from "./action-authority-fence.ts";

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
  invoke: ServiceInvokeArgsSchema,
  describeInstance: InstanceServiceTargetSchema,
  listInstances: z.strictObject({}),
  readInstanceConfiguration: InstanceServiceTargetSchema,
  configureInstance: ConfigureInstanceServiceArgsSchema,
  readInstance: InstanceServiceReadArgsSchema,
  invokeInstance: InstanceServiceInvokeArgsSchema,
  prepareCredentialEnrollment: ServiceCredentialEnrollmentPrepareArgsSchema,
  commitCredentialEnrollment: ServiceCredentialEnrollmentCommitArgsSchema,
  cancelCredentialEnrollment: ServiceCredentialEnrollmentCancelArgsSchema,
};
const description: z.ZodType<ServiceDescription> = z.strictObject({
  machineId: ServiceReadArgsSchema.shape.machineId,
  connected: z.boolean(),
  services: z.array(
    z.strictObject({
      serviceId: ServiceReadArgsSchema.shape.serviceId,
      revision: ServiceReadArgsSchema.shape.revision,
      policySha256: ServiceReadArgsSchema.shape.policySha256,
      operations: z.array(
        z.strictObject({
          operationId: ServiceReadArgsSchema.shape.operationId,
          readable: z.boolean(),
          invocable: z.boolean(),
          ready: z.boolean(),
          reason: z.string().nullable(),
          meter: z
            .union([
              ServiceProxyOperationPolicySchema.shape.meter.unwrap(),
              ServiceOperationPolicySchema.shape.meter.unwrap(),
            ])
            .optional(),
          prices: ServicePolicySchema.shape.prices,
          accounting: ServiceDirectQuoteSchema.optional(),
        }),
      ),
    }),
  ),
});

/** Use the same authority owner for native doors and caller-bound plugin contexts. */
export function serviceContext(
  service: () => JobService,
  auth: AuthContext,
  pluginId: string,
  traceId: number,
  mode: "read" | "invoke",
  authorityFence?: ActionAuthorityFence,
): PluginServiceContext {
  return {
    describe: (args) => service().describeServices(auth, machine.parse(args), pluginId),
    readConfiguration: (args) => service().readServiceConfiguration(auth, machine.parse(args)),
    configureConfiguration: (args) =>
      service().configureServiceConfiguration(
        auth,
        serviceDoorSchemas.configureConfiguration.parse(args),
        pluginId,
        String(traceId),
        authorityFence,
      ),
    read: (args) =>
      service().readService(
        auth,
        ServiceReadArgsSchema.parse(args),
        pluginId,
        String(traceId),
        authorityFence,
      ),
    invoke: (args) => {
      if (mode !== "invoke")
        return Promise.reject(new ServiceError("forbidden", "service_unauthorized"));
      return service().invokeService(auth, args, pluginId, String(traceId), authorityFence);
    },
    describeInstance: (args) =>
      service().describeInstanceService(auth, InstanceServiceTargetSchema.parse(args)),
    listInstances: (args) => {
      serviceDoorSchemas.listInstances.parse(args);
      return service().listInstanceServices(auth);
    },
    readInstanceConfiguration: (args) =>
      service().readInstanceServiceConfiguration(auth, InstanceServiceTargetSchema.parse(args)),
    configureInstance: (args) =>
      service().configureInstanceService(
        auth,
        ConfigureInstanceServiceArgsSchema.parse(args),
        pluginId,
        String(traceId),
        authorityFence,
      ),
    readInstance: (args) =>
      service().readInstanceService(
        auth,
        InstanceServiceReadArgsSchema.parse(args),
        pluginId,
        String(traceId),
        authorityFence,
      ),
    invokeInstance: (args) => {
      if (mode !== "invoke")
        return Promise.reject(new ServiceError("forbidden", "service_unauthorized"));
      return service().invokeInstanceService(auth, args, pluginId, String(traceId), authorityFence);
    },
  };
}

async function call(run: () => unknown, accounting = false) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ServiceError) {
      const reason = accounting ? ServiceRefusalSchema.safeParse(error.message) : null;
      return {
        refused: `${error.code}: ${reason?.success ? reason.data : "service request refused"}`,
      };
    }
    throw error;
  }
}

/** Static declarations are also the axiom verifier's authoritative builtin metadata input. */
export const serviceDoorMetadata: Pick<ServerPluginDef, "manifest" | "actions"> = {
  manifest: {
    id: "engine.services",
    version: "1.0.0",
    title: "Services",
    description: "Native instance ownership, machine service discovery and governed access.",
    capabilities: ["*"],
    contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
  },
  actions: Object.entries(serviceDoorSchemas).map(([name, input]) =>
    defineAction<unknown, unknown>({
      name,
      title: name,
      caps: [
        "readConfiguration",
        "configureConfiguration",
        "readInstanceConfiguration",
        "configureInstance",
        "prepareCredentialEnrollment",
        "commitCredentialEnrollment",
        "cancelCredentialEnrollment",
      ].includes(name)
        ? ["*"]
        : [],
      // Even malformed policy/input bodies must never enter the trace ledger.
      trace: "opaque",
      input,
      result:
        name === "prepareCredentialEnrollment"
          ? ServiceCredentialEnrollmentPrepareReplySchema
          : name === "commitCredentialEnrollment"
            ? ServiceCredentialEnrollmentCommitReplySchema
            : name === "cancelCredentialEnrollment"
              ? ServiceCredentialEnrollmentCancelReplySchema
              : name === "describe"
          ? description
          : name === "readConfiguration"
            ? ServiceConfigurationReadSchema
            : name === "configureConfiguration"
              ? ServiceConfigurationSchema
              : name === "describeInstance" || name === "configureInstance"
                ? InstanceServiceDescriptionSchema
                : name === "listInstances"
                  ? InstanceServicesDescriptionSchema
                  : name === "readInstanceConfiguration"
                    ? InstanceServiceConfigurationReadSchema
                    : ServiceReplySchema,
    }),
  ),
};

/** Enrollment is a host-only closure, not a PluginServiceContext or isolate bridge member. */
export function createServiceDoors(
  service: () => JobService | null,
  signal?: AbortSignal,
): ServerPluginDef {
  return {
    ...serviceDoorMetadata,
  handlers: {
    describe: (ctx: ActionCtx, args: z.infer<typeof machine>) =>
      call(() => ctx.services.describe(args)),
    readConfiguration: (ctx: ActionCtx, args: z.infer<typeof machine>) =>
      call(() => ctx.services.readConfiguration(args)),
    configureConfiguration: (
      ctx: ActionCtx,
      args: z.infer<typeof serviceDoorSchemas.configureConfiguration>,
    ) => call(() => ctx.services.configureConfiguration(args)),
    read: (ctx: ActionCtx, args: z.infer<typeof ServiceReadArgsSchema>) =>
      call(() => ctx.services.read(args)),
    invoke: (ctx: ActionCtx, args: z.infer<typeof ServiceInvokeArgsSchema>) =>
      call(() => ctx.services.invoke(args), args.accounting !== undefined),
    describeInstance: (ctx: ActionCtx, args: z.infer<typeof InstanceServiceTargetSchema>) =>
      call(() => ctx.services.describeInstance(args)),
    listInstances: (ctx: ActionCtx, args: Record<string, never>) =>
      call(() => ctx.services.listInstances(args)),
    readInstanceConfiguration: (
      ctx: ActionCtx,
      args: z.infer<typeof InstanceServiceTargetSchema>,
    ) => call(() => ctx.services.readInstanceConfiguration(args)),
    configureInstance: (ctx: ActionCtx, args: z.infer<typeof ConfigureInstanceServiceArgsSchema>) =>
      call(() => ctx.services.configureInstance(args)),
    readInstance: (ctx: ActionCtx, args: z.infer<typeof InstanceServiceReadArgsSchema>) =>
      call(() => ctx.services.readInstance(args)),
    invokeInstance: (ctx: ActionCtx, args: z.infer<typeof InstanceServiceInvokeArgsSchema>) =>
      call(() => ctx.services.invokeInstance(args), args.accounting !== undefined),
    prepareCredentialEnrollment: (
      ctx: ActionCtx,
      args: z.infer<typeof ServiceCredentialEnrollmentPrepareArgsSchema>,
    ) => {
      const jobs = service();
      return jobs
        ? jobs.prepareCredentialEnrollment(
            ctx.credential, args, String(ctx.traceId), ctx.authorityFence, signal,
          )
        : Promise.resolve({ kind: "refused", reason: "credential_owner_offline" });
    },
    commitCredentialEnrollment: (
      ctx: ActionCtx,
      args: z.infer<typeof ServiceCredentialEnrollmentCommitArgsSchema>,
    ) => {
      const jobs = service();
      return jobs
        ? jobs.commitCredentialEnrollment(ctx.credential, args, String(ctx.traceId), ctx.authorityFence)
        : Promise.resolve({ kind: "refused", reason: "credential_owner_offline" });
    },
    cancelCredentialEnrollment: (
      ctx: ActionCtx,
      args: z.infer<typeof ServiceCredentialEnrollmentCancelArgsSchema>,
    ) => {
      const jobs = service();
      return jobs
        ? jobs.cancelCredentialEnrollment(ctx.credential, args, String(ctx.traceId), ctx.authorityFence)
        : Promise.resolve({ kind: "refused", reason: "credential_owner_offline" });
    },
  },
  };
}
