---
section: Changed
issue: 262
---

Drawing is now the canvas child plugin `core.canvas.draw`, shown under Canvas in the plugin roster. Use the new id in plugin-management action arguments and the deep link `manifold://plugin/core.canvas.draw`; the old id is not an alias. Existing drawing data and plugin state migrate to the new identity, while the `draw` element and tool ids stay unchanged. Canvas is now a required dependency: its family toggle includes drawing, including strokes placed in compositions, without deleting their data. In-tree imports now use `@manifold-plugin/canvas/draw` from `packages/plugins/canvas/draw`, inside the canvas package.
