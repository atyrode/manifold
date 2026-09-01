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
 * `tools` — six rows on the `arrange` toolbar, and the bar reads them in TWO HALVES (issue
 * #104, superseding #89's button reading, which shipped root-split operations from a wrong
 * reading of the operator's intent).
 *
 * Stack row, Stack column and Spacer are the PALETTE: carry SOURCES you drag structure out
 * of. A palette drag is an ordinary carry whose payload is new structure rather than an
 * existing item — the same envelope, the same seam and zone resolution, the same release —
 * so where it lands decides what it means and which door writes it: the workspace's own tree
 * through `core.space.setLayout`, a composition's tree through `core.space.place`, and a
 * scoped panel's own arrangement through the layout door that already stores it. There is no
 * second drag flavour anywhere in that sentence, which is the invariant it exists to keep
 * (11 and 14).
 *
 * Equalize, Shelf and Reset are the OPERATIONS, and they are exactly the three a drag cannot
 * express, because none of them is a placement: Equalize is arithmetic over one split's
 * ratios, Shelf takes a panel OUT of the tree without putting it anywhere, and Reset discards
 * the arrangement for the manifest default. Stack and Swap used to sit beside them and no
 * longer do — the drag replaces Stack, and a center release already trades two seats, which
 * is all Swap ever did.
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
    "The F8 scene editor: a floating palette you drag stacks and spacers out of, plus the panel-move grips, wireframe delimitation and gesture/commit pipeline that render while it is armed.",
  capabilities: [],
  contributes: {
    panels: [],
    sections: [],
    elements: [],
    /*
      All six ride the SAME toolbar (`arrange`), so a disabled `core.arrange` takes every one
      of them out at once (D4′) rather than leaving an orphaned Reset button behind. WHICH
      half a row lands in is this plugin's own reading of its own ids and is not declared
      here: a toolbar row is a toolbar row, and the palette is a rendering of three of them.
    */
    tools: [
      { id: "stack-row", title: "Stack row", toolbar: "arrange" },
      { id: "stack-column", title: "Stack column", toolbar: "arrange" },
      { id: "spacer", title: "Spacer", toolbar: "arrange" },
      { id: "equalize", title: "Equalize", toolbar: "arrange" },
      { id: "shelf", title: "Shelf", toolbar: "arrange" },
      { id: "reset", title: "Reset", toolbar: "arrange" },
    ],
    events: [],
  },
};
