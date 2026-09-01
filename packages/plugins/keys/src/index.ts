import { defineAction } from "@manifold/plugin";
import { BindingIdSchema, BindingKeySchema, type PluginManifest } from "@manifold/protocol";
import { z } from "zod";

/**
 * `core.keys` — the key table's seat, and the BINDING EDITOR behind it.
 *
 * It was `core.shell`'s `keys` row until this wave. It is its own seat now because the rail's
 * key door is one of the rail's non-negotiables, and a non-negotiable's ownership ought to
 * match a reader's mental map instead of an accident of which package drew that pixel first
 * (issue #91). `essential: true` is the refusal that is kinder than the alternative: a
 * workspace that answers to keys nobody can list, and now nobody can change, is not a degraded
 * workspace but a locked one.
 *
 * THE SEAT IS A CLUSTER MEMBER. It declares `cluster: "utility"`, so it paints side by side
 * with whoever else declares that word — `core.plugins` does — as one horizontal row at the
 * rail's foot. Neither plugin knows about the other: the word is the whole vocabulary and the
 * policy that pulls them together is the engine's (`clusteredSections`).
 *
 * WHAT IT OWNS AND WHAT IT DOES NOT. The key REGISTRY is the engine's: plugins declare rows,
 * composition claims their keys and refuses duplicates, and `host.assembly.bindings` publishes
 * the composed table with EFFECTIVE keys in it. What this plugin owns is the two doors that
 * write a principal's DELTA over that table, and the chrome that reads both — so a stranger's
 * shell can drop this seat and keep every declared key, or keep the seat and replace the
 * editor, without the engine changing.
 */
export const keysManifest: PluginManifest = {
  id: "core.keys",
  version: "1.0.0",
  title: "Keys",
  description:
    "Lists every key this workspace answers to, and rebinds them per principal through its own doors.",
  capabilities: [],
  essential: true,
  contributes: {
    panels: [],
    sections: [{ id: "keys", title: "Keys", order: 50, presentation: "plain", cluster: "utility" }],
    elements: [],
    tools: [],
    events: [],
  },
};

/**
 * The two door names, built from the manifest id rather than spelled: a full action name is the
 * pair `${manifest.id}.${local}`, so the chrome that dispatches one and the `data-action`
 * attribute that names it in the DOM (invariant 12) cannot drift from the declaration below.
 */
export const KEYS_SET_ACTION = `${keysManifest.id}.setBinding`;
export const KEYS_RESET_ACTION = `${keysManifest.id}.resetBinding`;

/**
 * THE REBIND DOORS. Two, and both are per-principal writes of a delta over a table neither the
 * door nor the store can see — the key registry is browser-side registration data, so what the
 * server owns here is the MAP, its bounds and its collisions among the caller's own overrides,
 * and the composition seam owns the rest (`effectiveBindings`).
 *
 * NO CAPABILITY on either, for the reason `core.space.setLayout` needs none: dispatch already
 * refuses container-scoped tokens, and the only overrides these doors can touch are the
 * caller's own — there is nothing to attenuate. A rebinding is chrome that happens to be
 * shared state, and it is a door rather than a document because it is a discrete commit with a
 * legality question (does this key already answer to something?) the actor cannot answer alone.
 *
 * Both are traced by the ladder for free, like every dispatch (axiom A6), which is why neither
 * handler logs anything itself.
 */
export const keysActions = [
  defineAction({
    name: "setBinding",
    title: "Rebind a key",
    caps: [],
    input: z.strictObject({ binding: BindingIdSchema, key: BindingKeySchema }),
    result: z.strictObject({}),
  }),
  /**
   * ONE DOOR FOR BOTH RESETS, and `null` is what makes it one: a reset drops overrides, and
   * "this row" and "every row" are the same verb over a different subject. Two doors would put
   * one concept behind two names (invariant 14), and a client that wanted "reset all" by
   * calling the row door in a loop would produce N traces for one gesture.
   */
  defineAction({
    name: "resetBinding",
    title: "Reset a key to its declared default",
    caps: [],
    input: z.strictObject({ binding: BindingIdSchema.nullable() }),
    result: z.strictObject({}),
  }),
];
