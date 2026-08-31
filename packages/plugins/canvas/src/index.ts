import { type PluginManifest } from "@manifold/protocol";

/**
 * The infinite canvas, as a plugin — `core.canvas`.
 *
 * This is the renderer half of what used to be `core.shell.container-view`: the React Flow
 * projection boundary, the node-type map, the viewport and its per-container camera memory, the
 * tool strip, portal portals, and the gesture wiring that turns a pointer into document
 * traffic. It is one of the two plugins that decompose that panel (`core.compositions` is the
 * other), and after it there is no renderer left in the floor.
 *
 * THERE ARE NO ACTIONS, and that is the plane rule (D6) rather than an omission. Everything a
 * canvas does to a canvas is a per-element edit of the room's scene document: authoring a
 * note or a stroke, moving a box, resizing one, tombstoning one. Legality depends on nothing
 * the author cannot see and the worst-case merge is two people's edits both surviving, so it
 * is DOCUMENT traffic. Everything the canvas does that ISN'T a document edit already belongs
 * to somebody else's door and is dispatched by name: `core.terminals.rename` from a portal
 * titlebar, `core.views` for a container's life, `core.space.place` for every placement. A
 * canvas action would be a second door onto one of those (invariant 14).
 *
 * `scenes:write` is declared for the same reason `core.draw` and `core.notes` declare it: it is
 * the capability a viewer needs in order to author into a room, even though nothing here
 * dispatches an action.
 *
 * WHAT IT CONTRIBUTES, and what it deliberately does not:
 *
 * `tools` — `select` and `text` are the canvas's own two modes, declared here rather than left
 * as anonymous chrome so the vocabulary is READABLE: an agent asking `GET /api/plugins` sees
 * every mode the ref offers, not just the ones other plugins added. `core.draw`'s tool
 * arrives through the same registry, which is why the strip has no literal naming it.
 *
 * No `panels`. A container renderer is reached by LAYOUT, through the projection's container-ref
 * registry (`renderers` in the browser half): the routed shell asks for the ref of the
 * container it is showing, and a composition's tile leaf asks for exactly the same thing when
 * it embeds a canvas. One door onto "project a container of this discipline", used identically by
 * both — a panel row beside it would be a second door onto the same concept.
 *
 * No `elements`. The canvas paints two species that are not content: `portal`, which is
 * ADDRESSING — the projection of one container inside another — and nothing else. Its wire
 * schema stays protocol vocabulary and its renderer is the canvas's own, not a contribution
 * routed through the engine's element frame, because the engine's frame exists to give a
 * STRANGER's element a resizer and a commit path, and the canvas needs neither for its own
 * addressing species. Content elements — `text`, `draw` — belong to `core.notes` and
 * `core.draw`, and reach this ref through the element registry like any other plugin's.
 */
export const canvasManifest: PluginManifest = {
  id: "core.canvas",
  version: "1.0.0",
  title: "Canvas",
  description:
    "The infinite canvas: the React Flow renderer, portal portals, the tool strip and per-container camera memory.",
  capabilities: ["scenes:write"],
  contributes: {
    panels: [],
    sections: [],
    elements: [],
    tools: [
      { id: "select", title: "Select" },
      { id: "text", title: "Text" },
    ],
    events: [],
  },
};
