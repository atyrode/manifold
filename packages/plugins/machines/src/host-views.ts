import { z } from "zod";

const HostViewLabelSchema = z.string().trim().min(1).max(64);

/** Operator metadata only: machine IDs remain the exact execution identities. */
export const HostViewMemberSchema = z.strictObject({
  machineId: z.string().min(1),
  accountLabel: HostViewLabelSchema,
});
export type HostViewMember = z.infer<typeof HostViewMemberSchema>;

export const HostViewSchema = z
  .strictObject({
    id: z.uuid(),
    name: HostViewLabelSchema,
    members: HostViewMemberSchema.array().min(1).max(64),
  })
  .superRefine((host, ctx) => {
    const ids = new Set<string>();
    for (const [index, member] of host.members.entries()) {
      if (ids.has(member.machineId)) {
        ctx.addIssue({
          code: "custom",
          path: ["members", index, "machineId"],
          message: "host_view_duplicate_member",
        });
      }
      ids.add(member.machineId);
    }
  });
export type HostView = z.infer<typeof HostViewSchema>;

export const HostViewsSchema = z
  .strictObject({
    revision: z.number().int().nonnegative(),
    hosts: HostViewSchema.array().max(128),
  })
  .superRefine((registry, ctx) => {
    const hostIds = new Set<string>();
    const machineIds = new Set<string>();
    for (const [index, host] of registry.hosts.entries()) {
      if (hostIds.has(host.id)) {
        ctx.addIssue({ code: "custom", path: ["hosts", index, "id"], message: "duplicate_host_view" });
      }
      hostIds.add(host.id);
      for (const [memberIndex, member] of host.members.entries()) {
        if (machineIds.has(member.machineId)) {
          ctx.addIssue({
            code: "custom",
            path: ["hosts", index, "members", memberIndex, "machineId"],
            message: "host_view_member_already_grouped",
          });
        }
        machineIds.add(member.machineId);
      }
    }
  });
export type HostViews = z.infer<typeof HostViewsSchema>;

export const SetHostViewRequestSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  host: HostViewSchema,
});

export const RemoveHostViewRequestSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  hostId: z.uuid(),
});
