import type { PluginManifest } from "@manifold/protocol";

/**
 * The plugin manager: a UI over the composition, and nothing more.
 *
 * It used to own `setEnabled` and carry `essential: true` to protect it — a plugin made
 * permanently undisableable so that the mechanism inside it could not be switched off. That
 * was the correct diagnosis of a real self-lockout and the wrong cure (ADR 0013 §11): the
 * enablement door belongs to the engine, published as a builtin roster row
 * (`engine.plugins.setEnabled`), where no toggle can reach it.
 *
 * So this plugin is now ordinary and disableable. Turning it off costs a section, not the
 * ability to administer: the door stays reachable over the API to any principal holding
 * `plugins:manage`, and a substitute manager UI can be enabled in its place — which is what
 * "everything is a plugin" has to mean for the plugin list too.
 */
export const pluginManagerManifest: PluginManifest = {
  id: "core.plugins",
  version: "2.0.0",
  title: "Plugins",
  description: "Lists the workspace composition and drives the engine's enablement door.",
  capabilities: [],
  contributes: {
    panels: [],
    sections: [{ id: "plugins", title: "Plugins", order: 30 }],
    elements: [],
    tools: [],
    events: [],
  },
};
