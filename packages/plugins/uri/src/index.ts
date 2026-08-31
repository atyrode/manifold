import { type PluginManifest } from "@manifold/protocol";

/**
 * Deep links, as a plugin. `manifold://` is the canonical serialization of the addressing
 * algebra (D7); this is the half that turns one into a place in the browser: `/uri/<encoded>`
 * resolves the reference and takes the viewer there — a container it opens, an element or tile it
 * opens AND centers on, a terminal it follows to the container that holds it.
 *
 * It contributes no panels, sections, elements or tools, and declares no capabilities:
 * following a link reads nothing the viewer could not already read and mutates nothing at all.
 * Its only contribution is a ROUTE, which the manifest has no vocabulary for this wave —
 * routes are attached by the web half alone, so the manifest exists to make the plugin
 * disableable and nameable (a disabled `core.uri` renders a placeholder at that route).
 */
export const uriManifest: PluginManifest = {
  id: "core.uri",
  version: "1.0.0",
  title: "Links",
  description: "Resolves manifold:// deep links into the workspace.",
  capabilities: [],
  contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
};
