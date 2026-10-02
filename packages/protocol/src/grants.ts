import { z } from "zod";
import { AskableCapSchema, AuthoredCapSchema } from "./plugin.ts";
import { InstanceOriginSchema } from "./origin.ts";
import type { AskableCap } from "./capabilities.ts";
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
 * Four bounded ids at the maximum percent-encoded UTF-16 code-unit expansion, plus
 * the machine/operation/job/output path's fixed segments. Every canonical resource
 * reference must fit the grant door without truncating its identity.
 */
export const MAX_GRANT_NODE_LENGTH = 4 * 128 * 9 + 64;

/**
 * WHERE, as a `manifold://` URI string rather than a `ManifoldRef`. Two reasons, and both are
 * about the root: the workspace root has no ref form (there is nothing to discriminate), and a
 * grant node is stored, compared and walked as a string in every consumer, so a struct would be
 * formatted back to a string at each of them.
 *
 * Validation is the containment walk itself, which is the strongest possible check available
 * here: a node this returns null for is one no evaluator could ever reach, so accepting it
 * would be storing a row that can never fire.
 *
 * EVERY ADDRESSABLE NODE, which is what makes "on this machine" sayable (ADR 0035):
 * `manifold://machine/<id>` sits directly under the root and carries its operations, jobs,
 * outputs, locations and services beneath it, so a `subtree` row there is authority over one
 * enrolled machine and everything the fleet addresses through it. The walk is SYNTACTIC, so
 * this reader does not ask whether that machine is enrolled — a row naming a machine this
 * workspace never enrolled can never fire, and refusing it here would make a write depend on
 * inventory the evaluator deliberately never reads.
 */
export const GrantNodeSchema = z
  .string()
  .min(1)
  .max(MAX_GRANT_NODE_LENGTH)
  .refine((value) => containmentPath(value) !== null, {
    message: "node must be a manifold:// URI this workspace can address",
  });
export type GrantNode = z.infer<typeof GrantNodeSchema>;

export const MAX_AUTHORITY_SCOPE_ENTRIES = 64;
export const MAX_AUTHORITY_SCOPE_CAPS = 128;
export const AuthorityScopeEntrySchema = z.strictObject({
  target: GrantNodeSchema,
  reach: GrantReachSchema,
  caps: z
    .array(z.lazy(() => AskableCapSchema))
    .min(1)
    .max(MAX_AUTHORITY_SCOPE_CAPS),
});
export type AuthorityScopeEntry = z.infer<typeof AuthorityScopeEntrySchema>;
export type AuthorityScope = AuthorityScopeEntry[];
export const AuthorityScopeSchema = z
  .array(AuthorityScopeEntrySchema)
  .max(MAX_AUTHORITY_SCOPE_ENTRIES)
  .superRefine((scope, ctx) => {
    const groups = new Map<string, Set<AskableCap>>();
    for (const entry of scope) {
      const target = containmentPath(entry.target)?.at(-1) ?? entry.target;
      const key = `${target}\n${entry.reach}`;
      let caps = groups.get(key);
      if (caps === undefined) {
        caps = new Set();
        groups.set(key, caps);
      }
      for (const cap of entry.caps) caps.add(cap);
      if (caps.size > MAX_AUTHORITY_SCOPE_CAPS)
        ctx.addIssue({ code: "custom", message: "merged authority scope cap limit exceeded" });
    }
  });

/** Canonical storage/wire representation; an empty list means no ordinary authority. */
export function canonicalizeAuthorityScope(scope: readonly AuthorityScopeEntry[]): AuthorityScope {
  const parsed = AuthorityScopeSchema.parse(scope);
  const groups = new Map<string, AuthorityScopeEntry>();
  for (const entry of parsed) {
    const path = containmentPath(entry.target)!;
    entry.target = path[path.length - 1]!;
    const key = `${entry.target}\n${entry.reach}`;
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, entry);
    else existing.caps.push(...entry.caps);
  }
  const result = [...groups.values()];
  for (const entry of result) entry.caps = [...new Set(entry.caps)].sort();
  return result.sort((left, right) =>
    left.target < right.target
      ? -1
      : left.target > right.target
        ? 1
        : left.reach < right.reach
          ? -1
          : left.reach > right.reach
            ? 1
            : 0,
  );
}

/** Whether a scope covers this entire requested node/reach, not merely one descendant. */
export function scopeAdmits(
  scope: readonly AuthorityScopeEntry[],
  node: GrantNode,
  cap: AskableCap,
  reach: GrantReach = "node",
): boolean {
  const path = containmentPath(node);
  if (path === null) return false;
  const target = path[path.length - 1]!;
  return scope.some((entry) => {
    if (!entry.caps.includes(cap)) return false;
    const entryPath = containmentPath(entry.target);
    if (entryPath === null) return false;
    const entryTarget = entryPath[entryPath.length - 1]!;
    return entryTarget === target
      ? reach === "node" || entry.reach === "subtree"
      : entry.reach === "subtree" && path.includes(entryTarget);
  });
}

export function scopeWithin(
  requested: readonly AuthorityScopeEntry[],
  ceiling: readonly AuthorityScopeEntry[],
): boolean {
  return requested.every((entry) =>
    entry.caps.every((cap) => scopeAdmits(ceiling, entry.target, cap, entry.reach)),
  );
}

/** Intersect correlated entries without manufacturing a caps-by-targets product. */
export function intersectAuthorityScopes(
  left: readonly AuthorityScopeEntry[],
  right: readonly AuthorityScopeEntry[],
): AuthorityScope {
  const result = new Map<string, AuthorityScopeEntry>();
  const canonicalRight = canonicalizeAuthorityScope(right);
  for (const a of canonicalizeAuthorityScope(left)) {
    const aPath = containmentPath(a.target)!;
    for (const b of canonicalRight) {
      let target: GrantNode;
      let reach: GrantReach;
      if (a.target === b.target) {
        target = a.target;
        reach = a.reach === "node" || b.reach === "node" ? "node" : "subtree";
      } else if (b.reach === "subtree" && aPath.includes(b.target)) {
        target = a.target;
        reach = a.reach;
      } else if (a.reach === "subtree" && containmentPath(b.target)?.includes(a.target)) {
        target = b.target;
        reach = b.reach;
      } else continue;
      const caps = a.caps.filter((cap) => b.caps.includes(cap));
      if (caps.length === 0) continue;
      const key = `${target}\n${reach}`;
      const existing = result.get(key);
      if (existing === undefined) result.set(key, { target, reach, caps });
      else existing.caps.push(...caps);
    }
  }
  return canonicalizeAuthorityScope(
    [...result.values()].map((entry) => ({ ...entry, caps: [...new Set(entry.caps)] })),
  );
}

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
  /**
   * WHAT. The engine's own capabilities and a plugin's own namespaced ones alike (ADR 0035):
   * a row is written by a PRINCIPAL about somebody's authority, so unlike a manifest — which
   * may only declare its own namespace — a grant may name any plugin's capability. What makes
   * an undeclared name inert is the door, where the action's declaration is the other half of
   * the intersection; a row naming a vocabulary nobody declared answers no question, exactly
   * as ADR 0011 says of a grant that grants nothing.
   */
  caps: z.array(AuthoredCapSchema).min(1),
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
  caps: z.array(AuthoredCapSchema).min(1),
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
    /*
      The cap vocabulary a row may name: the engine's closed enum or a plugin's namespaced
      capability (ADR 0035). Published as its own entry rather than left inside `grant`,
      because "may I grant a capability the engine has never heard of?" is the question a
      plugin author arrives with, and the answer is a shape rather than a sentence.
    */
    cap: z.toJSONSchema(AuthoredCapSchema),
    grant: z.toJSONSchema(GrantSchema),
    createRequest: z.toJSONSchema(CreateGrantRequestSchema),
    revokeRequest: z.toJSONSchema(RevokeGrantRequestSchema),
    listRequest: z.toJSONSchema(ListGrantsRequestSchema),
    listResult: z.toJSONSchema(GrantsSchema),
  };
}
