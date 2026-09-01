import { z } from "zod";
import { ACTION_DENIAL_RULES, type ActionDenialRule } from "./plugin.ts";

/**
 * THE TRACE VOCABULARY (axiom A6, ADR 0018).
 *
 * A trace is the durable record of one exercise of authority at a door: who asked, under what
 * authority, at which door, with what arguments, over which nodes, and how it ended. The record
 * itself is a row in the ONE journal (`events`), written by the dispatch ladder and read back
 * through the trail's existing door — there is no second audit API and no second table.
 *
 * What lives HERE is the one part of the record two packages must agree on: the closed set of
 * words the `outcome` column may hold. The server writes it, `core.events` publishes it in the
 * row schema at `GET /api/protocol`, and a reader switches on it — three parties joined at
 * runtime by a string, which is exactly the case §Foundation law says to make compiler-visible
 * rather than to leave as a literal on each side.
 */

/**
 * How a dispatch ended, as the ledger says it.
 *
 * `ok` and `failed` are the two answers the denial ladder does not produce: a door that
 * committed, and a door that threw. Every other member IS a denial rung, and the `satisfies`
 * below is what keeps the two vocabularies from drifting apart — a new rung that is not
 * spelled here fails to compile.
 *
 * `unknown_action` is deliberately absent, and its absence is a RULING rather than an
 * omission (ADR 0018 §4): an unregistered name is not an exercise of authority — there is no
 * door, no declared capability and nothing to attribute — and the name is caller-chosen, so
 * tracing it would let any client write unbounded rows of its own invention into the ledger.
 * It stays observable where every dispatch already is: the structured `action` log line.
 */
export const TRACE_OUTCOMES = [
  "ok",
  "failed",
  "plugin_disabled",
  "forbidden",
  "invalid_args",
  "refused",
] as const satisfies readonly (Exclude<ActionDenialRule, "unknown_action"> | "ok" | "failed")[];

export const TraceOutcomeSchema = z.enum(TRACE_OUTCOMES);
export type TraceOutcome = (typeof TRACE_OUTCOMES)[number];

/**
 * The one rung the ledger does not record. Exported so the ladder, the gate and the tests all
 * name the exemption from one place instead of each spelling the literal it depends on.
 */
export const UNTRACED_DENIAL_RULE = "unknown_action" as const satisfies ActionDenialRule;

/**
 * Every denial rung the ledger MUST be able to say. The complement of the one exemption above,
 * derived from the rung vocabulary rather than retyped beside it, so a rung added to
 * `ACTION_DENIAL_RULES` shows up here on its own and the completeness assertion has something
 * real to check.
 */
export const TRACED_DENIAL_RULES: readonly ActionDenialRule[] = ACTION_DENIAL_RULES.filter(
  (rule) => rule !== UNTRACED_DENIAL_RULE,
);

/**
 * What the ladder discharged to open the door, spelled for the one case the capability
 * vocabulary cannot name: a door that demands nothing at all.
 *
 * `root` is the wildcard; a cap list is what a token's grants satisfied; `open` is a door with
 * an empty `caps` array, where the honest answer is that authority was never the question. A
 * blank column would say the same thing far less clearly, and an auditor reading rows must not
 * have to distinguish "no authority was needed" from "we forgot to record it".
 */
export const TRACE_AUTHORITY_ROOT = "root";
export const TRACE_AUTHORITY_OPEN = "open";
