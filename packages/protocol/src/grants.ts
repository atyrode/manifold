import { z } from "zod";
import { CapSchema } from "./capabilities.ts";
import { InstanceOriginSchema } from "./origin.ts";
import { MANIFOLD_URI_SCHEME, containmentPath } from "./uri.ts";

/**
 * AUTHORITY AS DATA (ADR 0011). A grant names _who_, _where_, _what_, allow or deny, and how
 * far down. It never names an action: actions declare the capabilities they need, grants grant
 * capabilities, and the two meet at the door. That separation is why the plugin engine's
 * declared-capability intersection (ADR 0010) sits unchanged on top of the evaluator rather
 * than beside it.
 *
 * The vocabulary lives here, in the protocol, because three parties are measured against it —
 * the evaluator that walks the rows, the SQLite table that stores them, and the administration
 * doors that publish them — and a shape defined at any one of those three would make the other
 * two its consumers by accident.
 */

/**
 * A denial is a ROW, and this closed pair is the whole negative vocabulary. ADR 0011 rejects
 * cap subtraction expressions and "allow everything except" by name: an authority model whose
 * refusals need arithmetic is one nobody can read off the table.
 */
export const GRANT_EFFECTS = ["allow", "deny"] as const;
export const GrantEffectSchema = z.enum(GRANT_EFFECTS);
export type GrantEffect = z.infer<typeof GrantEffectSchema>;

/**
 * How far down the tree a row reaches. `subtree` is A5 itself — permission granted at a node
 * flows downward — and `node` is the exception that makes element-level authority sayable
 * without granting the container it lives in.
 */
export const GRANT_REACHES = ["node", "subtree"] as const;
export const GrantReachSchema = z.enum(GRANT_REACHES);
export type GrantReach = z.infer<typeof GrantReachSchema>;

/**
 * WHO. One principal by id, or a CLASS of them, and the class forms are the reason grants
 * exist as rows at all: "any human in this room may read but not write" is a sentence a flat
 * token cap set cannot say at any price.
 *
 * `instance` is the federation form. Wave 3 supplies its real values — a share's caps become
 * an instance grant at the shared node, so every ticket principal from that origin inherits
 * the share's authority without the host minting a row per guest.
 */
export const GrantPrincipalSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("principal"), id: z.string().min(1).max(128) }),
  z.strictObject({ kind: z.literal("any-human") }),
  z.strictObject({ kind: z.literal("any-agent") }),
  z.strictObject({ kind: z.literal("instance"), origin: InstanceOriginSchema }),
]);
export type GrantPrincipal = z.infer<typeof GrantPrincipalSchema>;

/**
 * A URI's worth of room: two 128-character ids and the longest form's fixed segments, rounded
 * up. Bounded for `RefIdSchema`'s reason — a resolver must never be handed an unbounded
 * attacker-chosen blob wearing an address's clothes.
 */
export const MAX_GRANT_NODE_LENGTH = 512;

/**
 * WHERE, as a `manifold://` URI string rather than a `ManifoldRef`. Two reasons, and both are
 * about the root: the workspace root has no ref form (there is nothing to discriminate), and a
 * grant node is stored, compared and walked as a string in every consumer, so a struct would be
 * formatted back to a string at each of them.
 *
 * Validation is the containment walk itself, which is the strongest possible check available
 * here: a node this returns null for is one no evaluator could ever reach, so accepting it
 * would be storing a row that can never fire.
 */
export const GrantNodeSchema = z
  .string()
  .min(1)
  .max(MAX_GRANT_NODE_LENGTH)
  .refine((value) => containmentPath(value) !== null, {
    message: "node must be a manifold:// URI this workspace can address",
  });

/**
 * A grant id's room. Wider than the 128 every other id in this protocol gets, and deliberately:
 * migration 13 DERIVES its ids from the credential each row was materialized from
 * (`grant-token-<tokenId>`) so that re-running produces the identical table and an operator can
 * see which credential a row answers for without a join. A prefix plus a 128-bounded id does not
 * fit in 128, and a bound a derived id could exceed is not a bound — it is a row this reader
 * would reject at the one moment authority is being asked for.
 */
export const MAX_GRANT_ID_LENGTH = 160;

/**
 * The durable row, ADR 0011's shape verbatim. Nothing here is a secret and nothing is hashed:
 * a grant is bookkeeping about authority, not a credential that proves it, and the credential
 * that does — a token — keeps its own hashed column and REFERENCES this row.
 */
export const GrantSchema = z.strictObject({
  id: z.string().min(1).max(MAX_GRANT_ID_LENGTH),
  principal: GrantPrincipalSchema,
  node: GrantNodeSchema,
  caps: z.array(CapSchema).min(1),
  effect: GrantEffectSchema,
  reach: GrantReachSchema,
  createdBy: z.string().min(1).max(128),
  createdAt: z.number().int(),
});
export type Grant = z.infer<typeof GrantSchema>;

/**
 * What an administration door takes. Every field is REQUIRED — no zod defaults — because each
 * of the two closed pairs is a decision with a blast radius: a row that meant `deny` and got
 * `allow` by omission, or `node` and got `subtree`, is the kind of mistake a default makes
 * silently and a required field makes impossible.
 */
export const CreateGrantRequestSchema = z.strictObject({
  principal: GrantPrincipalSchema,
  node: GrantNodeSchema,
  caps: z.array(CapSchema).min(1),
  effect: GrantEffectSchema,
  reach: GrantReachSchema,
});
export type CreateGrantRequest = z.infer<typeof CreateGrantRequestSchema>;

/**
 * Naming a row to delete, bounded at the width the ROW's id has rather than the 128 every other
 * id gets: a revoke argument is an id `GrantSchema` produced, so a narrower bound here is a row
 * that can be written and never withdrawn — and migration 13's derived ids
 * (`grant-token-<tokenId>`) are exactly the ones that overflow 128.
 */
export const RevokeGrantRequestSchema = z.strictObject({
  grantId: z.string().min(1).max(MAX_GRANT_ID_LENGTH),
});
export type RevokeGrantRequest = z.infer<typeof RevokeGrantRequestSchema>;

/**
 * Narrowing a read, never widening one: both filters are optional and omitting both asks for
 * every row. A grant is not a secret, so there is nothing here for a filter to protect — what
 * the filters buy is an administrator asking "who reaches this node" and "what does this
 * principal hold" without reading the whole table.
 */
export const ListGrantsRequestSchema = z.strictObject({
  node: GrantNodeSchema.optional(),
  principalId: z.string().min(1).max(128).optional(),
});
export type ListGrantsRequest = z.infer<typeof ListGrantsRequestSchema>;

export const GrantsSchema = z.strictObject({
  grants: z.array(GrantSchema),
});
export type Grants = z.infer<typeof GrantsSchema>;

/**
 * The grant vocabulary, published — the counterpart of `pluginVocabulary()`,
 * `eventVocabulary()` and `instanceVocabulary()`. A stranger's agent reading
 * `GET /api/protocol` learns the shapes behind `core.access.grant`,
 * `core.access.revokeGrant` and `core.access.listGrants` from the declarations themselves:
 * what a row IS, the two closed pairs a row must decide, and what each of the three doors
 * takes and answers.
 *
 * A3 is why it is here rather than only in prose. The three doors already publish their
 * argument schemas through the live action roster, but a roster row describes ONE door; the
 * authority model it opens — that `effect` and `reach` are closed pairs with no default, that
 * WHERE is a `manifold://` URI and not an id — is a shape all three share, and a shape shared
 * by three doors that lives in none of them is a shape a stranger reconstructs by guessing.
 *
 * `nodeScheme` is published beside the node schema because the generated JSON Schema cannot
 * carry the refinement that matters: a bounded string is all `z.toJSONSchema` can say about a
 * value whose real constraint is the containment walk, so the scheme is stated as data rather
 * than left for a reader to infer from a `maxLength`.
 *
 * What is NOT here is which rows a given workspace holds. That is `core.access.listGrants`'s
 * answer, and this package describes shapes, never their inhabitants.
 */
export function grantVocabulary(): Record<string, unknown> {
  return {
    effects: GRANT_EFFECTS,
    reaches: GRANT_REACHES,
    nodeScheme: MANIFOLD_URI_SCHEME,
    maxNodeLength: MAX_GRANT_NODE_LENGTH,
    maxIdLength: MAX_GRANT_ID_LENGTH,
    principal: z.toJSONSchema(GrantPrincipalSchema),
    node: z.toJSONSchema(GrantNodeSchema),
    grant: z.toJSONSchema(GrantSchema),
    createRequest: z.toJSONSchema(CreateGrantRequestSchema),
    revokeRequest: z.toJSONSchema(RevokeGrantRequestSchema),
    listRequest: z.toJSONSchema(ListGrantsRequestSchema),
    listResult: z.toJSONSchema(GrantsSchema),
  };
}
