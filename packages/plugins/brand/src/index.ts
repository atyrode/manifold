import type { PluginManifest } from "@manifold/protocol";

/**
 * `core.brand` — the mark, the wordmark, the running build's version, and the release history
 * behind it. It was `core.shell`'s `brand` row until this wave; it is its own seat now because
 * the rail's brand line is a non-negotiable of the rail, and a non-negotiable seat's ownership
 * ought to match a reader's mental map of the rail rather than an accident of which package
 * happened to draw the top pixel first (issue #91).
 *
 * IT DECLARES NO ACTIONS AND NO CAPABILITIES, unchanged from when it was a row: a mark is not
 * authority, and nothing here reaches past `document.body` for the changelog dialog it owns.
 * `essential: true` is the refusal that is kinder than the alternative — a rail with no name
 * and no version on it is not a degraded workspace, it is a broken one, so the engine's
 * cluster policy refuses to disable this seat rather than let a principal discover the gap by
 * looking at an unlabeled sidebar.
 *
 * The section id and its order are UNCHANGED from the row this manifest used to carry inside
 * `core.shell` — `brand` at `1`, still `plain` — so a principal's stored arrangement keeps its
 * seat for this contribution across the extraction; `arrangedSectionIds` drops nothing.
 */
export const brandManifest: PluginManifest = {
  id: "core.brand",
  version: "1.0.0",
  title: "Brand",
  description:
    "The mark, the wordmark, and the running build's version and release history behind it.",
  capabilities: [],
  essential: true,
  contributes: {
    panels: [],
    sections: [{ id: "brand", title: "Manifold", order: 1, presentation: "plain" }],
    elements: [],
    tools: [],
    events: [],
  },
};
