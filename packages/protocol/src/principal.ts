import { z } from "zod";

/** One identity model for humans and agents — presence, ownership, terminals, audit. */
export const PrincipalSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["human", "agent"]),
  name: z.string().min(1).max(64),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .describe("stable presence color, assigned at principal creation"),
});
export type Principal = z.infer<typeof PrincipalSchema>;
