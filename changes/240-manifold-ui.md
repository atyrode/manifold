---
section: Changed
issue: 240
---

The design system is its own package: plugin authors import components, tokens and the layout algebra from `@manifold/ui`, the same package the shell and every core panel are drawn with, and installed React plugins receive it as a shared module. `@manifold/plugin/ui` is gone; the engine's browser mechanism (the tile tree, notices, view state, `keyCapLabel`) rides `@manifold/plugin/hooks`.
