import type { PluginManifest } from "@manifold/protocol";

/**
 * The workspace index, as a plugin. ONE index of everything that exists: canvases,
 * compositions, and the terminals that live in them, with folders over all three — a canvas
 * and a composition are one object told apart by its discipline, so nothing here filters by
 * layout and the row's glyph carries the difference.
 *
 * It declares no capabilities. Every write it performs is authorised at the door it calls:
 * pad and folder CRUD by `pads:write` on their routes, terminal rename and kill by the
 * `core.terminals` actions it dispatches. A section that declared caps would be claiming
 * authority it does not hold — the caller's token holds it.
 */
export const viewsManifest: PluginManifest = {
  id: "core.views",
  version: "1.0.0",
  title: "Views",
  description:
    "The one workspace index: canvases, compositions, the terminals inside them, and folders over all three.",
  capabilities: [],
  contributes: {
    panels: [],
    sections: [{ id: "views", title: "Views", order: 10 }],
    elements: [],
    tools: [],
    events: [],
  },
};
