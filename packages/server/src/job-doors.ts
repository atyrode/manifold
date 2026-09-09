import { defineAction } from "@manifold/plugin";
import type { PluginJobContext } from "@manifold/plugin";
import {
  CapSchema,
  ManifoldRefSchema,
  ListJobRunsArgsSchema,
  ListJobRunsResultSchema,
  JobInvocationEdgeSchema,
  JobInvocationTargetSchema,
  InspectJobInvocationsArgsSchema,
  InspectJobInvocationsResultSchema,
  type InspectJobInvocationsResult,
  type ListJobRunsArgs,
  type ListJobRunsResult,
  JobEventSchema,
  JobRequestSchema,
  PublicJobSchema,
  JobDescriptionSchema,
  MachineHalfSchema,
  JobResourceBindingsSchema,
  type PublicJob,
} from "@manifold/protocol";
import { z } from "zod";
import { ServiceError, type AuthContext } from "./auth.ts";
import type { ActionCtx, ServerPluginDef } from "./plugin-host.ts";
import type { JobService } from "./job-service.ts";

const id = z.string().min(1).max(256);
const jobNode = ManifoldRefSchema.options[10];
const outputNode = ManifoldRefSchema.options[11];
export const JobExecuteArgsSchema = JobRequestSchema.pick({
  jobId: true,
  machineId: true,
  operationId: true,
  input: true,
  outputs: true,
}).extend({
  limits: JobRequestSchema.shape.limits.optional(),
  installationRevision: JobRequestSchema.shape.installationRevision.optional(),
  artifactSha256: JobRequestSchema.shape.artifactSha256.optional(),
  resourceBindingDigest: PublicJobSchema.shape.resourceBindingDigest.optional(),
  resourceBindings: JobResourceBindingsSchema.optional(),
});
const execute = JobExecuteArgsSchema;
const schedule = execute.extend({
  scheduleId: id,
  revision: id,
  firstNominalAt: z.number().int().nonnegative(),
  intervalMs: z.number().int().positive(),
  deadlineMs: z.number().int().positive(),
  expiresAt: z.number().int().nonnegative(),
  offlinePolicy: z.enum(["skip", "coalesce-one"]),
});
const publicJob = PublicJobSchema;
const publicSchedule = schedule
  .omit({ jobId: true, input: true, outputs: true, limits: true })
  .extend(JobInvocationTargetSchema.shape);
export const jobDoorSchemas = {
  execute: execute.extend({ pluginId: id }),
  describe: z.strictObject({ machineId: id, pluginId: id, installationRevision: id.optional() }),
  status: z.strictObject({ node: jobNode }),
  listRuns: ListJobRunsArgsSchema.extend({ pluginId: JobRequestSchema.shape.pluginId }),
  input: z.strictObject({
    node: jobNode,
    requestId: id,
    seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    data: z.base64().max(87384),
    eof: z.boolean(),
  }),
  cancel: z.strictObject({ node: jobNode }),
  output: z.strictObject({
    node: outputNode,
    offset: z.number().int().nonnegative(),
    maxBytes: z.number().int().positive().max(65536),
  }),
  install: z.strictObject({
    machineId: id,
    pluginId: id,
    installationRevision: id,
    artifactSha256: JobRequestSchema.shape.artifactSha256,
    machine: MachineHalfSchema,
    resourceBindings: JobResourceBindingsSchema.optional(),
  }),
  consent: z.strictObject({
    machineId: id,
    pluginId: id,
    installationRevision: id,
    node: z.string().min(1).max(4096),
    artifactSha256: JobRequestSchema.shape.artifactSha256,
    cap: CapSchema,
    enabled: z.boolean(),
  }),
  schedule: schedule.extend({ pluginId: id }),
  schedules: z.strictObject({}),
  disableSchedule: z.strictObject({ scheduleId: id, revision: id }),
  inspectInvocations: InspectJobInvocationsArgsSchema,
  setInvocationEdge: z.strictObject({ edge: JobInvocationEdgeSchema, enabled: z.boolean() }),
};
const schemas = jobDoorSchemas;

/** The host binds authority and caller identity, never a caller-provided credential or parent. */
export function jobContext(
  service: () => JobService,
  auth: AuthContext,
  pluginId: string,
  traceId: number,
): JobContext {
  const callee = (requested?: string): string =>
    pluginId === "engine.jobs" ? id.parse(requested) : pluginId;
  const administrator = (): void => {
    if (pluginId !== "engine.jobs") throw new ServiceError("forbidden", "job_admin_required");
  };
  return {
    describe: (args) => service().describe(auth, schemas.describe.parse(args), pluginId),
    execute: (args) => {
      const { pluginId: requested, ...request } = args;
      return service().publicJob(
        service().execute(auth, callee(requested), String(traceId), execute.parse(request)),
      );
    },
    status: (node: z.infer<typeof jobNode>) =>
      service().publicJob(service().status(auth, jobNode.parse(node), pluginId)),
    follow: (node, receive) => service().follow(auth, jobNode.parse(node), receive, pluginId),
    listRuns: (args) => {
      const { pluginId: requested, ...query } = args;
      return service().listRuns(
        auth,
        callee(requested),
        ListJobRunsArgsSchema.parse(query),
        pluginId,
      );
    },
    input: async (args: z.infer<typeof schemas.input>) => {
      const a = schemas.input.parse(args);
      await service().input(
        auth,
        a.node,
        a.requestId,
        a.seq,
        a.data,
        a.eof,
        pluginId,
        String(traceId),
      );
      return { accepted: true as const };
    },
    cancel: (node: z.infer<typeof jobNode>) => {
      service().cancel(auth, jobNode.parse(node), pluginId);
      return { accepted: true };
    },
    output: (args: z.infer<typeof schemas.output>) => {
      const a = schemas.output.parse(args);
      return service().output(auth, a.node, a.offset, a.maxBytes, pluginId);
    },
    install: (args: z.infer<typeof schemas.install>) => {
      administrator();
      service().install(auth, schemas.install.parse(args));
      return { accepted: true };
    },
    consent: (args: z.infer<typeof schemas.consent>) => {
      administrator();
      service().consent(auth, schemas.consent.parse(args));
      return {};
    },
    schedule: (args) => {
      const { pluginId: requested, ...request } = args;
      service().schedule(
        auth,
        callee(requested),
        String(traceId),
        schedule.parse(request),
        pluginId,
      );
      return {};
    },
    schedules: () =>
      service()
        .schedules(auth, pluginId)
        .map(({ request, ...metadata }) => ({
          ...metadata,
          machineId: request.machineId,
          pluginId: request.pluginId,
          operationId: request.operationId,
          installationRevision: request.installationRevision,
          artifactSha256: request.artifactSha256,
        })),
    disableSchedule: (args: z.infer<typeof schemas.disableSchedule>) => {
      const a = schemas.disableSchedule.parse(args);
      service().disableSchedule(auth, a.scheduleId, a.revision, pluginId);
      return {};
    },
    inspectInvocations: (args) => {
      administrator();
      return service().inspectInvocations(auth, schemas.inspectInvocations.parse(args));
    },
    setInvocationEdge: (args) => {
      administrator();
      service().setInvocationEdge(auth, schemas.setInvocationEdge.parse(args));
      return {};
    },
  };
}
export interface JobContext extends PluginJobContext {
  execute(args: z.infer<typeof execute> & { pluginId?: string }): PublicJob;
  listRuns(args: ListJobRunsArgs & { pluginId?: string }): ListJobRunsResult;
  install(args: z.infer<typeof schemas.install>): { accepted: true };
  consent(args: z.infer<typeof schemas.consent>): Record<string, never>;
  schedule(args: z.infer<typeof schedule> & { pluginId?: string }): Record<string, never>;
  inspectInvocations(args: z.infer<typeof schemas.inspectInvocations>): InspectJobInvocationsResult;
  setInvocationEdge(args: z.infer<typeof schemas.setInvocationEdge>): Record<string, never>;
}

async function call(run: () => unknown) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ServiceError) return { refused: `${error.code}: job request refused` };
    throw error;
  }
}
const empty = z.strictObject({});
const accepted = z.strictObject({ accepted: z.literal(true) });
export const jobDoors: ServerPluginDef = {
  manifest: {
    id: "engine.jobs",
    version: "1.0.0",
    title: "Machine jobs",
    description:
      "Governed execution, private outputs, explicit installation consent and schedules.",
    capabilities: ["*"],
    contributes: {
      panels: [],
      sections: [],
      elements: [],
      tools: [],
      events: [
        { id: "job_changed", title: "Job changed" },
        { id: "job_access_changed", title: "Job read authority changed" },
      ],
    },
  },
  actions: Object.entries(schemas).map(([name, input]) =>
    defineAction<unknown, unknown>({
      name,
      title: name,
      caps:
        name === "install" ||
        name === "consent" ||
        name === "setInvocationEdge" ||
        name === "inspectInvocations"
          ? ["*"]
          : [],
      trace: "opaque",
      input,
      result:
        name === "inspectInvocations"
          ? InspectJobInvocationsResultSchema
          : name === "describe"
            ? JobDescriptionSchema
            : name === "execute" || name === "status"
              ? publicJob
              : name === "listRuns"
                ? ListJobRunsResultSchema
                : name === "output"
                  ? JobEventSchema
                  : name === "schedules"
                    ? z.array(publicSchedule)
                    : name === "install" || name === "input" || name === "cancel"
                      ? accepted
                      : empty,
    }),
  ),
  handlers: {
    describe: (ctx: ActionCtx, args: z.infer<typeof schemas.describe>) =>
      call(() => ctx.jobs.describe(args)),
    execute: (ctx: ActionCtx, args: z.infer<typeof schemas.execute>) =>
      call(() => ctx.jobs.execute(args)),
    status: (ctx: ActionCtx, args: z.infer<typeof schemas.status>) =>
      call(() => ctx.jobs.status(args.node)),
    listRuns: (ctx: ActionCtx, args: z.infer<typeof schemas.listRuns>) =>
      call(() => ctx.jobs.listRuns(args)),
    input: (ctx: ActionCtx, args: z.infer<typeof schemas.input>) =>
      call(() => ctx.jobs.input(args)),
    cancel: (ctx: ActionCtx, args: z.infer<typeof schemas.cancel>) =>
      call(() => ctx.jobs.cancel(args.node)),
    output: (ctx: ActionCtx, args: z.infer<typeof schemas.output>) =>
      call(() => ctx.jobs.output(args)),
    install: (ctx: ActionCtx, args: z.infer<typeof schemas.install>) =>
      call(() => ctx.jobs.install(args)),
    consent: (ctx: ActionCtx, args: z.infer<typeof schemas.consent>) =>
      call(() => ctx.jobs.consent(args)),
    schedule: (ctx: ActionCtx, args: z.infer<typeof schemas.schedule>) =>
      call(() => ctx.jobs.schedule(args)),
    schedules: (ctx: ActionCtx) => call(() => ctx.jobs.schedules()),
    disableSchedule: (ctx: ActionCtx, args: z.infer<typeof schemas.disableSchedule>) =>
      call(() => ctx.jobs.disableSchedule(args)),
    inspectInvocations: (ctx: ActionCtx, args: z.infer<typeof schemas.inspectInvocations>) =>
      call(() => ctx.jobs.inspectInvocations(args)),
    setInvocationEdge: (ctx: ActionCtx, args: z.infer<typeof schemas.setInvocationEdge>) =>
      call(() => ctx.jobs.setInvocationEdge(args)),
  },
};
