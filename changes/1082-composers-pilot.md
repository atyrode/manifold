---
section: Changed
issue: 1082
---

The landing concept's meadow and bees scenes are now presets of the `outdoor` composer (ADR 0062 Phase 1, `src/composer/`): eight layers (`downs`, `hillside`, `lawn`, `apiary`, `grass`, `wildflowers`, `dandelions`, `insects`) stacked over one rig, one light, one gust field and one shared speck map, placed by claims in metres. Each layer is switched by a knob keyed by its id; a layer set is its own program. The lab gathers the switches into a Layers section, a row per role, where a backdrop or ground swaps for the one on and a refused layer says why; in the compact bar each layer on has a chip of its own. Meadow draws the same pixels as before; bees' lawn, lavender and blooms now move in the shared gust field. A committed preset, "Bees · overgrown meadow", grows the meadow's grass and wildflowers into the garden under its afternoon light.
