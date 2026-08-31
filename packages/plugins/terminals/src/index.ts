import { defineAction } from "@manifold/plugin";
import { type PluginManifest } from "@manifold/protocol";
import { z } from "zod";

/**
 * Terminal administration, as a plugin. The PTY plane itself stays floor — bytes flow on
 * the session channel, which is transport, not a mutation anybody can name — but the two
 * verbs that ARE mutations, naming and killing, moved here from bespoke HTTP routes and
 * became the action door's first occupants.
 *
 * Disabling this plugin refuses new terminals and these administrative verbs, but never
 * touches attach/input/detach/kill of sessions that already exist: creation and
 * administration die, cleanup survives, so nobody is ever locked out of removing a
 * terminal by an administrator turning a plugin off (D12).
 */
export const terminalsManifest: PluginManifest = {
  id: "core.terminals",
  version: "1.0.0",
  title: "Terminals",
  description: "Names and kills terminal sessions, and owns the terminal affordances.",
  capabilities: ["pads:write"],
  contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
};

/**
 * `pads:write` on both, matching the routes these replaced exactly: renaming or killing a
 * terminal changes what the one index shows, and the index is the workspace's own tree.
 */
export const terminalsActions = [
  defineAction({
    name: "rename",
    title: "Rename a terminal",
    caps: ["pads:write"],
    input: z.strictObject({
      sessionId: z.string().min(1),
      name: z.string().min(1).max(120),
    }),
    result: z.strictObject({}),
  }),
  defineAction({
    // D12: kill is CLEANUP — it stays dispatchable while this plugin is disabled, so a
    // disable can refuse new terminals without ever locking anyone out of removing one.
    cleanup: true,
    name: "kill",
    title: "Kill a terminal",
    caps: ["pads:write"],
    input: z.strictObject({ sessionId: z.string().min(1) }),
    result: z.strictObject({}),
  }),
];
