import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJobJson, ManifoldRefSchema, GrantNodeSchema, GrantReachSchema, AuthoredCapSchema, type ActionPreparationCtx, type ActionPreparationDef, type AskableCap, type ManifoldRef, type PreparedRequirement } from "@manifold/protocol";

export class ActionPreparationError extends Error {}

const requirement = z.strictObject({
  cap: AuthoredCapSchema.refine((cap) => cap !== "*"),
  node: GrantNodeSchema,
  reach: GrantReachSchema,
});

export interface ActionPreparationEvidence {
  readonly originalArgsDigest: string;
  readonly targets: readonly ManifoldRef[];
  readonly additionalRequirements: readonly PreparedRequirement[];
}

export function argumentDigest(args: unknown): string {
  return createHash("sha256").update(canonicalJobJson(args) ?? "undefined").digest("hex");
}

export function validatePreparedRequirements(
  values: readonly PreparedRequirement[] | undefined,
  ceiling: readonly AskableCap[],
): readonly PreparedRequirement[] {
  const parsed = requirement.array().max(64).safeParse(values ?? []);
  if (!parsed.success) throw new ActionPreparationError("invalid additional authority requirements");
  for (const value of parsed.data) {
    if (!ceiling.includes(value.cap as AskableCap))
      throw new ActionPreparationError("additional requirement exceeds preparer ceiling");
  }
  return parsed.data as PreparedRequirement[];
}


function parseActionArgs(input: z.ZodType, args: unknown): unknown {
  try {
    const parsed = input.safeParse(args);
    if (!parsed.success) throw new ActionPreparationError(parsed.error.message);
    return parsed.data;
  } catch (error) {
    throw error instanceof ActionPreparationError ? error
      : new ActionPreparationError(error instanceof Error ? error.message : "invalid action arguments");
  }
}
/** Shared execution/review path. This receives a new read-only context, never ActionCtx. */
export async function prepareActionInput(
  input: z.ZodType,
  fixed: readonly { readonly target: readonly string[] }[],
  rawArgs: unknown,
  context: ActionPreparationCtx,
  preparation?: ActionPreparationDef,
): Promise<ActionPreparationEvidence & { readonly args: unknown }> {
  const first = parseActionArgs(input, rawArgs);
  if (preparation === undefined) {
    const targets = fixed.map(({ target }) => {
      let value: unknown = first;
      for (const segment of target) {
        value = value !== null && typeof value === "object" && Object.hasOwn(value, segment)
          ? Reflect.get(value, segment) : undefined;
      }
      return ManifoldRefSchema.parse(value);
    });
    return { args: first, targets, additionalRequirements: [], originalArgsDigest: argumentDigest(rawArgs) };
  }
  const prepared = await preparation.prepare(context, first as never);
  if (prepared === null || typeof prepared !== "object")
    throw new ActionPreparationError("invalid prepared action");
  const second = parseActionArgs(input, prepared.args);
  const targets = ManifoldRefSchema.array().max(128).safeParse(prepared.targets);
  if (!targets.success || targets.data.length !== fixed.length)
    throw new ActionPreparationError("invalid authority targets");
  return {
    args: second,
    targets: targets.data,
    additionalRequirements: validatePreparedRequirements(prepared.additionalRequirements, preparation.caps),
    originalArgsDigest: argumentDigest(rawArgs),
  };
}
