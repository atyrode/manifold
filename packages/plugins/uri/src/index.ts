import { type PluginManifest } from "@manifold/protocol";

/**
 * Deep links, as a plugin. `manifold://` is the canonical serialization of the addressing
 * algebra (D7); this is the half that turns one into a place in the browser: `/uri/<encoded>`
 * resolves the reference and takes the viewer there — a container it opens, an element or tile it
 * opens AND centers on, a terminal it follows to the container that holds it.
 *
 * It contributes no panels, sections, elements or tools, and declares no capabilities:
 * following a link reads nothing the viewer could not already read and mutates nothing at all.
 * Its one contribution is the ROUTE below — the path segment it claims in the URL space every
 * plugin shares, so the roster publishes the paths this build answers on and a second plugin
 * wanting `uri` is refused with both names rather than shadowing this one (D5). The web half
 * says who draws it; the manifest says it exists, which is also what makes a disabled
 * `core.uri` render a named placeholder at that route.
 */
export const uriManifest: PluginManifest = {
  id: "core.uri",
  version: "1.0.0",
  title: "Links",
  description: "Resolves manifold:// deep links into the workspace.",
  capabilities: [],
  contributes: {
    panels: [],
    sections: [],
    elements: [],
    tools: [],
    events: [],
    routes: [{ segment: "uri", title: "Deep links" }],
  },
};
