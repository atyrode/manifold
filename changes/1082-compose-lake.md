---
section: Changed
issue: 1082
---

The landing concept's frozen lake is now a preset of the `outdoor` composer (ADR 0062 Phase 2b), in two layers locked to the lake's rig: the `farShore` backdrop (the lake's own night, its hour and the World's sky knobs drawn its own way, the aurora's curtains or slow drapes on the substorm clock, the cabin on its point or the fjord's far shore, the geese, the exit's gust) and the `lake` ground (the black ice mirroring the far shore through `composerMirror`, its bubbles, singing cracks and drifting snow, or the fjord's water and near bank). It draws the same pixels as before at its defaults, in `view=source`, over the fjord under the slow drapes, with the ice or the fjord as a still mirror, and in its committed presets; the far shore stages its night on the World, so the World's snow and fog now fall through it at the composed depth (they read as the World's), and the lake gains the World's rain and cloud. Keys: `iceSeed` becomes `seed`, the M is `lakeMark`; the committed lake presets are rewritten in the composed key order.
