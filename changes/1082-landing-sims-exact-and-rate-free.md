---
section: Changed
issue: 1082
---

The landing concept's simulations behave as tuned at any frame rate and step. Damped springs (plants, meadow, bamboo, the fireflies' lantern, ferrofluid, prism, sand table) now take the exact step, so they ring and settle at the frequencies they are set to and stay stable at any step length. The pointer's trails in the ink-wash scroll, the shore, the kelp forest and the frosted window lay their ink per distance travelled, so a stroke leaves the same mark at 60 and 144 Hz; slow and medium strokes look as before at 60 Hz, and fast strokes no longer leave a stronger mark there. The pearlescent tank's pigment now really fades in still water. The hanging mobile's solver runs more passes for more arms, which keeps its loaded links within 1% of their length at the default spacing, and its unused flat-plate code is removed. The dunes send their sand to the GPU as often as the wind moves it: a few times a second in a breeze instead of twenty.
