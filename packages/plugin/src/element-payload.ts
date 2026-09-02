import {
  PORTAL_ELEMENT_TYPE,
  PortalPayloadSchema,
  elementPayload,
  type SceneElement,
} from "@manifold/protocol";
import type { z } from "zod";
import type { Assembly, AssemblyElement } from "./assemble.ts";

/**
 * THE element-payload boundary (ADR 0013 §16 clause 5).
 *
 * The protocol's element schema is a neutral envelope: it holds the geometry every renderer and
 * every placement rule reads, bounds the payload so a record cannot become a blob, and names no
 * element type. What a record of a GIVEN type must contain is its owning plugin's business, and
 * the plugin declares it as a payload schema on its registration (`PluginDef.elements`).
 *
 * This module is where those two halves meet, and it is deliberately the same shape as an
 * action's `input`: the assembly holds the schema, one boundary parses, and a failure is a
 * NAMED REFUSAL carrying the offender rather than a throw. Two consequences follow, and they
 * are why the check lives at a boundary instead of in the wire schema:
 *
 *   A STRANGER TYPE ROUND-TRIPS. A record whose type no registration claims has no schema to
 *   fail, so it validates, persists, syncs, sorts and renders the engine's placeholder. Before
 *   the envelope its `type` was refused by the wire schema outright, which meant a canvas could
 *   not hold a record whose owner was merely absent from this build — the outcome ADR 0013 §4
 *   forbids for panels and sections, arriving through the document plane instead.
 *
 *   A KNOWN TYPE WITH A MALFORMED PAYLOAD IS REFUSED, and refused where the offender can be
 *   named: the type, its owning plugin, and which field broke. A discriminated union could only
 *   say "matched no member".
 *
 * It has no React and no server import on purpose: the two boundaries that call it are the
 * browser's element host and the server room's repair pass, and a module either of them could
 * not import would have to be two modules.
 */

/** Why one record was refused. `problems` are field-level, so a log line can name the field. */
export interface ElementPayloadRefusal {
  readonly elementId: string;
  readonly type: string;
  /** The plugin whose registration refused it — the party a reader should go and ask. */
  readonly plugin: string;
  readonly problems: readonly string[];
}

/**
 * THE floor's own element kinds and their payload schemas — one entry, `portal`.
 *
 * Exported because it is the only statement of "which element types does nobody contribute",
 * and two consumers need it: this boundary, and `verify:axioms` S8, whose subset assertion used
 * to read a hand-written table that had drifted out of agreement with the tree (it listed `text`
 * as floor long after `core.notes` took it).
 */
export const FLOOR_ELEMENT_PAYLOADS: Readonly<Record<string, z.ZodType>> = {
  [PORTAL_ELEMENT_TYPE]: PortalPayloadSchema,
};

/** The engine, as the owner a refusal names when the refused kind is the floor's own. */
const FLOOR_OWNER = "engine";

/**
 * Validates one record's payload against its owner's schema, or answers null.
 *
 * Null means ACCEPTED, and it means accepted in three distinct situations a caller must not
 * conflate: the type is a stranger neither the floor nor this assembly has heard of, its owner
 * declared no payload schema, or the payload parsed. All three are records the document plane
 * should carry, which is the only question this function answers.
 *
 * The floor's kinds are consulted FIRST, and the order is the contract — the same order
 * `itemTraitsFor` resolves placement traits in, for the same reason: a manifest may not
 * redefine a kind the engine owns. Element-type ownership (ADR 0013 §7) already refuses a
 * plugin claiming a reserved type, so this order is belt to that brace rather than the only
 * guard.
 */
export function elementPayloadRefusal(
  elements: ReadonlyMap<string, AssemblyElement>,
  element: SceneElement,
): ElementPayloadRefusal | null {
  const floor = FLOOR_ELEMENT_PAYLOADS[element.type];
  const registered = floor === undefined ? elements.get(element.type) : undefined;
  const schema = floor ?? registered?.payload ?? null;
  if (schema === null) return null;
  const parsed = schema.safeParse(elementPayload(element));
  if (parsed.success) return null;
  return {
    elementId: element.id,
    type: element.type,
    plugin: registered?.plugin ?? FLOOR_OWNER,
    problems: parsed.error.issues.map(
      (issue) => `${issue.path.map(String).join(".") || "(payload)"} ${issue.message}`,
    ),
  };
}

/**
 * The boundary as a one-argument guard, bound to a LIVE assembly.
 *
 * The thunk is not indirection for its own sake: the assembly is rebuilt on every enablement
 * change, and a guard holding a snapshot would keep refusing a payload whose owner was just
 * enabled — or keep accepting one whose owner's schema has since been re-registered. The same
 * argument, and the same shape, as the server's `assemblyElementTraits`.
 */
export function elementPayloadGuard(
  assembly: () => Assembly,
): (element: SceneElement) => ElementPayloadRefusal | null {
  return (element) => elementPayloadRefusal(assembly().elements, element);
}
