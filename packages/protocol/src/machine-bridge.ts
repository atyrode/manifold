import { z } from "zod";
import {
  DrainMachineRequestSchema,
  EnrollMachineRequestSchema,
  MachineDrainStatusSchema,
  MachineRefusalSchema,
  RevokeMachineRequestSchema,
} from "./http.ts";
import { ISOLATE_ERROR_TEXT_MAX, type IsolateCtxMethod } from "./isolate.ts";
import { TerminalExecutionSchema } from "./machine.ts";

/**
 * THE FLEET BRIDGE (issue #259): the only machine and identity questions a plugin handler may
 * ask its host, whether the handler runs in the host's realm or in a hardened child.
 *
 * Every answer is PUBLIC METADATA or a refusal. No token, token id, owner-host identity or
 * private container datum crosses, and nothing here is a store handle: the host resolves every
 * machine id against current state and re-proves the live caller against the plugin's admitted
 * ceiling at the moment of use. A plugin can therefore never hand the host a machine RECORD,
 * only an id the host looks up again.
 *
 * Enrollment is one host-side find-or-create decision. A guest cannot compose "look the name
 * up, then mint" across two round trips, because that would race two concurrent enrollments of
 * one name; `created` says which branch the host took and the raw token exists only on the
 * branch that minted it.
 */
export const MACHINE_BRIDGE_METHODS = [
  "machines.inventory",
  "machines.drain",
  "identity.enrollMachine",
  "identity.rotateMachineToken",
  "identity.revokeMachine",
  "identity.forgetMachine",
] as const satisfies readonly IsolateCtxMethod[];
export type MachineBridgeMethod = (typeof MACHINE_BRIDGE_METHODS)[number];

const machineId = RevokeMachineRequestSchema.shape.machineId;

/** A machine as a bridge names it: identity only, never its credential. */
export const MachineIdentitySchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
});
export type MachineIdentity = z.infer<typeof MachineIdentitySchema>;

/**
 * One inventory row: the persisted public facts plus what the socket registry knows live.
 * Presentation (the identity color, which optional wire fields are omitted) stays the
 * consuming plugin's policy; this is the data it is computed from, with every member present.
 */
export const MachineInventoryEntrySchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  online: z.boolean(),
  revoked: z.boolean(),
  draining: z.boolean(),
  terminalExecution: TerminalExecutionSchema.nullable(),
  lastRefusal: MachineRefusalSchema.nullable(),
});
export type MachineInventoryEntry = z.infer<typeof MachineInventoryEntrySchema>;

/** The whole fleet in store order, answered in one read rather than one question per row. */
export const MachineInventorySchema = z.strictObject({
  machines: MachineInventoryEntrySchema.array(),
});
export type MachineInventory = z.infer<typeof MachineInventorySchema>;

/** The host's find-or-create verdict; a token only when this call minted the machine. */
export const MachineEnrollmentOutcomeSchema = z.discriminatedUnion("created", [
  z.strictObject({
    created: z.literal(true),
    machine: MachineIdentitySchema,
    machineToken: z.string().min(1),
  }),
  z.strictObject({ created: z.literal(false), machine: MachineIdentitySchema }),
]);
export type MachineEnrollmentOutcome = z.infer<typeof MachineEnrollmentOutcomeSchema>;

/** A rotated credential for a machine the host re-resolved by id. */
export const MachineCredentialGrantSchema = z.strictObject({
  machine: MachineIdentitySchema,
  machineToken: z.string().min(1),
});
export type MachineCredentialGrant = z.infer<typeof MachineCredentialGrantSchema>;

/** The admission latch's report, or why there is none (offline, unknown, not authorized). */
export const MachineDrainOutcomeSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), status: MachineDrainStatusSchema }),
  z.strictObject({ ok: z.literal(false), reason: z.string().min(1).max(ISOLATE_ERROR_TEXT_MAX) }),
]);
export type MachineDrainOutcome = z.infer<typeof MachineDrainOutcomeSchema>;

/** The identity mechanism's refusal as data: its class, and the sentence a door relays. */
export const MachineBridgeRefusalSchema = z.strictObject({
  ok: z.literal(false),
  code: z.string().min(1).max(64),
  message: z.string().max(ISOLATE_ERROR_TEXT_MAX),
});
export type MachineBridgeRefusal = z.infer<typeof MachineBridgeRefusalSchema>;
export type MachineBridgeAnswer<T> = { readonly ok: true; readonly value: T } | MachineBridgeRefusal;

function answered<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), value }),
    MachineBridgeRefusalSchema,
  ]);
}

/** The positional arguments each bridge call carries; ids only, never a record. */
export const MachineBridgeArgsSchemas = {
  "machines.inventory": z.tuple([]),
  "machines.drain": z.tuple([
    DrainMachineRequestSchema.shape.machineId,
    DrainMachineRequestSchema.shape.draining,
  ]),
  "identity.enrollMachine": z.tuple([EnrollMachineRequestSchema.shape.name]),
  "identity.rotateMachineToken": z.tuple([machineId]),
  "identity.revokeMachine": z.tuple([machineId]),
  "identity.forgetMachine": z.tuple([machineId]),
} as const satisfies Record<MachineBridgeMethod, z.ZodType>;

/** What each bridge call answers. `forgetMachine` has nothing to say beyond success. */
export const MachineBridgeResultSchemas = {
  "machines.inventory": answered(MachineInventorySchema),
  "machines.drain": MachineDrainOutcomeSchema,
  "identity.enrollMachine": answered(MachineEnrollmentOutcomeSchema),
  "identity.rotateMachineToken": answered(MachineCredentialGrantSchema),
  "identity.revokeMachine": answered(z.number().int().nonnegative()),
  "identity.forgetMachine": answered(z.null()),
} as const satisfies Record<MachineBridgeMethod, z.ZodType>;

export function isMachineBridgeMethod(method: IsolateCtxMethod): method is MachineBridgeMethod {
  return (MACHINE_BRIDGE_METHODS as readonly string[]).includes(method);
}
