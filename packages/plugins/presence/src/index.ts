import { defineAction } from "@manifold/plugin";
import { type PluginManifest } from "@manifold/protocol";
import { z } from "zod";

/**
 * The presence domain, as one plugin: cursors, roster, status, published view state and
 * spotlights are facets of a single concept — what a principal is doing right now, visible
 * to everyone sharing the room and gone when the connection dies.
 *
 * Both halves now live here: the browser refs (cursor overlay, remote gesture overrides,
 * roster island, spotlight receipt) behind `@manifold-plugin/presence/web`, and the one door
 * presence needs on the server — a request that another principal look at a node. The
 * device's view-state store itself is engine mechanism (`@manifold/plugin`), because chrome
 * that is not presence writes into it too; what presence owns is putting it on the wire.
 */
export const presenceManifest: PluginManifest = {
  id: "core.presence",
  version: "1.0.0",
  title: "Presence",
  description:
    "Publishes each principal's view state and delivers consent-guarded spotlight requests.",
  capabilities: ["scenes:write"],
  contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
};

/**
 * "Look at this." `scenes:write` because it DRIVES another principal's client — the same
 * authority that lets a caller move things in a room lets it point somebody in that room at
 * a node, and nothing weaker would do, since a viewport yank is an interruption.
 *
 * The handler additionally requires a shared room and rate-limits the pair, so consent is
 * structural (you are already together) rather than a preference nobody set.
 */
export const presenceActions = [
  defineAction({
    name: "focus",
    title: "Ask a principal to look at a node",
    caps: ["scenes:write"],
    input: z.strictObject({
      targetPrincipalId: z.string().min(1),
      uri: z.string().min(1).max(512),
    }),
    result: z.strictObject({}),
  }),
];
