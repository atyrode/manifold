import { LIFECYCLE_TIMEOUT_MS } from "@manifold/plugin";
import { PluginIdSchema } from "@manifold/protocol";
import { z } from "zod";

/** Trusted server configuration only; neither plugin declarations nor guest requests set it. */
export type JobSettledTimeouts = Readonly<Record<string, number>>;

const TimeoutsSchema = z.record(
  PluginIdSchema,
  z.number().int().min(LIFECYCLE_TIMEOUT_MS).max(60_000),
);

/** Validate and copy the host policy so its caller cannot alter an admitted deadline later. */
export function jobSettledTimeouts(value: unknown): ReadonlyMap<string, number> {
  return new Map(Object.entries(TimeoutsSchema.parse(value === undefined ? {} : value)));
}
