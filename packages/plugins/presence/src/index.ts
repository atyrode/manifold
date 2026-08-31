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
  contributes: {
    panels: [],
    sections: [],
    elements: [],
    tools: [],
    /*
      ATTENDANCE, declared here and emitted by the FLOOR — the room owns the roster and may not
      name a plugin, so it emits under whichever plugin `assembly.ts` says owns presence
      vocabulary (ADR 0012 §1).

      A principal ARRIVING is not the same concept as its presence PAYLOAD, and only the first
      one is here. A cursor or a viewport is continuous per-connection state that dies with the
      socket and rides the presence frames above; joining and leaving a room are discrete
      transitions a section outside the room wants to hear about, which is exactly the gap the
      event plane fills and exactly what `/api/attendance` was being polled for.

      Both are addressed to the presence COLLECTION, not to the container: `/api/attendance`
      is read workspace-wide by chrome that sits outside every room it reports on, so one
      subscription replaces the poll where a container-addressed topic would have cost that
      chrome one per container. The container travels in the payload and as the audit trail's
      scope, and the principal who arrived or left is the event's actor rather than its topic.
     */
    events: [
      { id: "principal_joined", title: "Principal joined a container" },
      { id: "principal_left", title: "Principal left a container" },
    ],
  },
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
