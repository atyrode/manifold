import { z } from "zod";

/**
 * Capability-scoped authority. Uniform identity (humans and agents are both principals)
 * never implies uniform authority: every token carries an explicit cap set, optionally
 * scoped to a single container.
 *
 * Every name is `<domain-plural>:<verb>`, which is the whole naming law: a reader of a
 * token's cap set can tell what it reaches and what it may do there without a table.
 */
export const CAPS = [
  "*",
  "containers:read",
  "containers:write",
  "scenes:write",
  "terminals:spawn",
  "terminals:write",
  "tokens:mint",
  "machines:mint",
  /** Enable and disable plugins for the whole workspace: assembly administration. */
  "plugins:manage",
] as const;

export const CapSchema = z.enum(CAPS);
export type Cap = z.infer<typeof CapSchema>;

export function hasCap(granted: readonly Cap[], needed: Exclude<Cap, "*">): boolean {
  return granted.includes("*") || granted.includes(needed);
}
