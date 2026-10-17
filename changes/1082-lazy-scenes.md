---
section: Changed
issue: 1082
---

The landing concept now loads a scene's shader and simulation only when the scene is needed: the scene a page opens on, one picked in the lab, the tour's next step, a passage's incoming scene, and the scenes next to the one on screen while the page is idle. The first load carries every scene's card, knobs and presets, the lab and the code of the scene on screen alone: about 308 KiB gzipped with the pond, down from about 1,300 KiB. Each scene's trigger, passage and choice constants now live in a small module of its own, so listing the scenes no longer pulls in their shaders. The build worker no longer loads whole scene simulations either: what it runs for a scene (frost's growth, the dew web, the forest's life, the dry garden's layout, the bonsai's tree, the slime mould's dish) lives in that scene's own build module, and the worker script is about 75 KiB gzipped, down from about 91 KiB.
