import { z } from "zod";

/**
 * Capability-scoped authority. Uniform identity (humans and agents are both principals)
 * never implies uniform authority: every token carries an explicit cap set, optionally
 * scoped to a single pad.
 */
export const CAPS = [
  "*",
  "pads:read",
  "pads:write",
  "scene:write",
  "terminal:spawn",
  "terminal:write",
  "tokens:mint",
] as const;

export const CapSchema = z.enum(CAPS);
export type Cap = z.infer<typeof CapSchema>;

export function hasCap(granted: readonly Cap[], needed: Exclude<Cap, "*">): boolean {
  return granted.includes("*") || granted.includes(needed);
}
