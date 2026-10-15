---
section: Changed
issue: 1082
---

Scene transitions in the landing concept lab now weave the two scenes together: the next scene starts its entrance part-way through the leaving scene's exit and takes the screen over dot by dot while both keep moving, instead of dissolving out of a still last frame once the exit has finished. The next scene's shader is built and drawn once off screen before the exit begins, so a driver's compile pause falls at the switch rather than in the middle of the motion, and an exit shorter than the blend is drawn out to last it, so the leaving scene never stands still under the incoming one. The lab's Motion section tunes the overlap, the blend length, the blend pattern (middle first, even fade, sweep or grain) and a slow motion for studying transitions, all kept in the link.
