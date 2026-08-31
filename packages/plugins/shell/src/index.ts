import { defineAction } from "@manifold/plugin";
import {
  PlaceRequestSchema,
  PlaceResponseSchema,
  TileLayoutSchema,
  type PluginManifest,
} from "@manifold/protocol";
import { z } from "zod";

/**
 * The shell: the sidebar and the pad view, as plugin panels. A principal's workspace is a
 * tile tree whose leaves name these two panel ids, rendered by the same component every
 * tiled container uses — which is why the shell is a composition rather than a frame with
 * plugin holes cut in it (D2).
 *
 * ESSENTIAL: nothing else can draw the workspace, so disabling it is refused rather than
 * obeyed. It declares no actions and no capabilities — chrome is not authority.
 */
export const shellManifest: PluginManifest = {
  id: "core.shell",
  version: "1.0.0",
  title: "Workspace Shell",
  description:
    "The workspace itself: the sidebar panel and the pad-view panel every layout is built from.",
  capabilities: [],
  essential: true,
  contributes: {
    panels: [
      { id: "sidebar", title: "Sidebar" },
      { id: "pad-view", title: "Pad View" },
    ],
    sections: [],
    elements: [],
    tools: [],
    events: [],
  },
};

/**
 * The workspace layout and the placement verb, as doors. They live in the shell's package
 * because the tree is the shell's own state, but under a SEPARATE plugin id so the ratified
 * action names stay `core.layout.set` and `core.layout.place` — a plugin id is a namespace,
 * and "the tree" and "the panels that fill it" are two concepts even when one package ships
 * both.
 *
 * It contributes nothing: no panel, no section, no element. Disabling it stops layout writes
 * and placements without taking the shell's panels down with it.
 */
export const layoutManifest: PluginManifest = {
  id: "core.layout",
  version: "1.0.0",
  title: "Workspace Layout",
  description:
    "Stores each principal's workspace tile tree, and places items into the containers they compose.",
  capabilities: ["pads:write"],
  contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
};

export const layoutActions = [
  /**
   * Writing a layout needs no capability: dispatch already refuses pad-scoped tokens, and a
   * workspace tree is per principal — the only tree this door can write is the caller's own,
   * so there is nothing to attenuate. A layout is chrome that happens to be shared state.
   */
  defineAction({
    name: "set",
    title: "Set workspace layout",
    caps: [],
    input: z.strictObject({ layout: TileLayoutSchema }),
    result: z.strictObject({}),
  }),
  /**
   * THE placement door: put an item in a container (ADR 0013 §14). The algebra stays floor —
   * the rules engine arbitrates between kinds no plugin owns — and the VERB is here, so
   * placing a thing goes through the same published vocabulary, capability declaration and
   * denial ladder as every other mutation. `pads:write` is the cap the deleted route
   * required, unchanged; the workspace scope is that route's pad-scoped refusal, unchanged.
   *
   * A refused placement is the `refused` rung carrying the algebra's own rule
   * (`placementRefusal`), so `not_accepted` has exactly one wording on the wire. The result
   * is `PlaceResponse` verbatim, tagged by the op that actually ran.
   */
  defineAction({
    name: "place",
    title: "Place an item",
    caps: ["pads:write"],
    input: PlaceRequestSchema,
    result: PlaceResponseSchema,
  }),
];
