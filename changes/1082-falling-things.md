---
section: Added
issue: 1082
---

The landing concept's outdoor scenes share one system for falling things (`src/composer/falling.ts`). A pool of particles in the composed sim falls under gravity and drag, carried by the composer's gust field, and is drawn as points into the shared speck map, so no layer loops over the particles per pixel. Layers name their drip points and landing surfaces (a plane, a ledge, water). A drop splashes and wets the spot where it lands, or strikes a water layer's sim. The waterfall's bank ferns are the first to use it: their drips are now real drops that swell on the fronds, fall, and splash on the bank's boulders. Defaults are unchanged; in rain a few beads and drips are drawn differently.
