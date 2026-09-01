import { type PluginManifest } from "@manifold/protocol";

/**
 * The F8 scene editor, as a plugin — `core.arrange` (issue #89, ratifying #89's first
 * comment).
 *
 * EVERYTHING F8 ONCE DID INSIDE THE FLOOR HOST (`packages/web/src/workspace.tsx`) LIVES HERE
 * NOW: the panel-move grip, the pointer gesture and its live preview, the release's commit,
 * the mode bar and its scope crumbs, and the #88 scope resolution (`resolveArrangeScope`).
 * None of it is a private import of the file it used to be part of — it reaches the tree
 * through a documented host contract (`host.tileGeometry`, `@manifold/plugin`) and paints
 * through the workspace overlay outlet (`workspaceOverlays.toolbar`, the same channel a
 * container overlay uses one host up), and it commits the one way anything has ever moved a
 * workspace tree: `core.space.setLayout`, dispatched through `host.client.action`, no second
 * mutation path.
 *
 * `core.shell` keeps no arrange code: the F8 binding is this plugin's own row now (`web.ts`),
 * and the floor host that used to render the grip and the bar keeps only what the litmus
 * demands — the vantage store (`@manifold/plugin/ui`, untouched), the layout door
 * (`core.space.setLayout`, `@manifold-plugin/shell`, untouched), the tile-geometry read
 * surface it now PUBLISHES instead of privately owning, and the overlay outlet it mounts.
 * Disabling this plugin removes the F8 binding, the toolbar, the grips and the wireframe —
 * and leaves a fully usable, un-rearrangeable workspace: the tree still loads, still resizes
 * by its ordinary dividers, still places items, because none of that ever belonged to arrange
 * mode in the first place.
 *
 * `core.shell`'s OWN section-arrange leg — the sidebar's row grips (`sidebar-panel.tsx`) — is
 * NOT here and is not moving. #88 made that leg's ownership explicit: a panel that declares
 * `arranges` renders its own affordance for reordering its own parts ("the rows themselves
 * are still entirely this package's business"), coordinating with this plugin purely through
 * the published vantage store (`vantage.arranging`, `vantage.arrangeScope`) — the same
 * decoupled channel every other plugin uses, never a private import either way. Moving that
 * leg here would trade a real decoupling (two plugins agreeing on a wire value) for a worse
 * one (this plugin needing private knowledge of the sidebar's own row shapes, disclosure vs
 * plain chrome, and collapsed state).
 *
 * WHAT IT CONTRIBUTES:
 *
 * `tools` — the floating toolbar's seven buttons, all on the `arrange` toolbar (issue #89's
 * discriminator on the existing tool-contribution mechanism, `protocol/plugin.ts`). Stack
 * row/column re-orient the workspace tree's own root split; Spacer inserts a first-class
 * inert leaf into the tile grammar; Equalize normalizes a split's ratios; Swap trades two
 * selected seats; Shelf unseats a selected panel without loss (it stays listed, tap to
 * re-seat); Reset recomposes the manifest default (`composeDefaultLayout`). Every one commits
 * through `core.space.setLayout` and nothing else — no second door, no per-frame write.
 *
 * No `panels`, no `sections`, no `elements`. This plugin owns no leaf and no row of its own;
 * it is chrome over OTHER plugins' panels, painted through the overlay outlet rather than
 * occupying a seat in the tree it edits.
 */
export const arrangeManifest: PluginManifest = {
  id: "core.arrange",
  version: "1.0.0",
  title: "Arrange",
  description:
    "The F8 scene editor: a floating toolbar over the workspace tree, plus the panel-move grips, wireframe delimitation and gesture/commit pipeline that render while it is armed.",
  capabilities: [],
  contributes: {
    panels: [],
    sections: [],
    elements: [],
    /*
      All seven ride the SAME toolbar (`arrange`), so a disabled `core.arrange` takes every
      one of them out at once (D4′) rather than leaving an orphaned Reset button behind.
    */
    tools: [
      { id: "stack-row", title: "Stack row", toolbar: "arrange" },
      { id: "stack-column", title: "Stack column", toolbar: "arrange" },
      { id: "spacer", title: "Spacer", toolbar: "arrange" },
      { id: "equalize", title: "Equalize", toolbar: "arrange" },
      { id: "swap", title: "Swap", toolbar: "arrange" },
      { id: "shelf", title: "Shelf", toolbar: "arrange" },
      { id: "reset", title: "Reset", toolbar: "arrange" },
    ],
    events: [],
  },
};
