import { z } from "zod";
import { InstanceOriginSchema } from "./origin.ts";

/** One identity model for humans and agents — presence, ownership, terminals, audit. */
export const PrincipalSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["human", "agent"]),
  name: z.string().min(1).max(64),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .describe("stable presence color, assigned at principal creation"),
  /**
   * WHICH INSTANCE this principal belongs to, and ABSENT means this one (ADR 0014 §4).
   *
   * Optional rather than nullable so that "local" has exactly one representation: every
   * pre-v18 payload parses unchanged, and a reader that never meets a remote peer sees the
   * field it always saw. It rides the principal and nowhere else — attendance carries it
   * because an attendance row IS a principal — because a fact stored twice is a fact that
   * disagrees with itself.
   *
   * Invariant 11 across instances: this is DATA. Nothing downstream of arbitration may branch
   * on it; rendering it beside a peer's name and color is presentation of a datum, not a
   * branch, and a second "remote flavor" of any shared behavior is a defect.
   */
  origin: InstanceOriginSchema.optional(),
});
export type Principal = z.infer<typeof PrincipalSchema>;

/**
 * THE color scheme, and the reason it lives in the protocol rather than in a stylesheet:
 * a principal picks from it in the browser, and the server hashes machine ids into it
 * before putting the result on the wire (`MachineSummary.color`). Two ends agreeing on a
 * palette makes it vocabulary, not decoration.
 */
export const IDENTITY_COLORS = [
  "#e03131",
  "#f08c00",
  "#2f9e44",
  "#1971c2",
  "#6741d9",
  "#c2255c",
  "#0c8599",
  "#495057",
] as const;

/**
 * A stable color for anything with an id but no chosen one — machines, today. FNV-1a over
 * the id, so the answer is identical across sessions, devices, reloads and processes: the
 * browser derived machine dots this way before the server did, and the algorithm is pinned
 * here precisely so the move to the wire changed nobody's colors.
 */
export function identityColorFor(id: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return IDENTITY_COLORS[(hash >>> 0) % IDENTITY_COLORS.length] ?? IDENTITY_COLORS[0];
}
