---
section: Added
issue: 201
---

A workspace layout can now show a container inline: `core.space.setLayout` accepts a `container` leaf beside panel, spacer and empty leaves, and the workspace mounts that canvas or composition with its own renderer in place, so a plugin panel and a composition's live terminals, or a canvas with its live terminal portals, notes and its own camera, sit in one screen with no navigation hop and survive a reload. The inline view never takes over the routed view: the address, Escape and the routed camera stay where they were. The door refuses a newly written container leaf, by id, when the container does not exist or the caller may not read it, and still refuses terminal and element leaves. A container deleted or made unreadable after it was seated leaves a named placeholder with a Remove control rather than blocking later layout changes. Container renderers take a new optional `routed` prop that separates being the route from nesting depth.
