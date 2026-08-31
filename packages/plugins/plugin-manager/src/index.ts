import { defineAction } from "@manifold/plugin";
import { PluginIdSchema, type PluginManifest } from "@manifold/protocol";
import { z } from "zod";

/**
 * Composition administration, as a plugin — the list of plugins is itself something a
 * plugin renders and a door mutates. Its section shows the roster with a toggle per entry;
 * an essential plugin shows a lock, because its answer is already known.
 */
export const pluginManagerManifest: PluginManifest = {
  id: "core.plugins",
  version: "1.0.0",
  title: "Plugins",
  description: "Lists the workspace composition and turns plugins on and off for everyone.",
  capabilities: ["plugins:manage"],
  contributes: {
    panels: [],
    sections: [{ id: "plugins", title: "Plugins", order: 30 }],
    elements: [],
    tools: [],
    events: [],
  },
};

/**
 * Enablement is workspace-GLOBAL and hot: one principal with `plugins:manage` changes what
 * every principal's client composes, and the new roster is pushed rather than polled, so
 * nobody reloads to see it (D4).
 */
export const pluginManagerActions = [
  defineAction({
    name: "setEnabled",
    title: "Enable or disable a plugin",
    caps: ["plugins:manage"],
    input: z.strictObject({ id: PluginIdSchema, enabled: z.boolean() }),
    result: z.strictObject({}),
  }),
];
