---
section: Changed
issue: 1082
---

The landing concept's koi pond is now a preset of the new `overhead` composer (ADR 0062 Phase 4), a patch seen straight down, in five layers: the floor and its weeds (`pondBed`, the bed), the water with its sun, rings, caustics, glint, current, pads, petals and paper boat (`pondWater`, the water), the Manifold stone (`stone`), the border plants and canopy with their shade and god rays (`border`) and the koi (`koi`). The lab's Layers section shows them in Bed, Water, Dressings, Covers and Life rows. It draws the same pixels as before at its defaults; every knob keeps its key, the koi count and the stone became their layers' switches, and `pondBed`, `pondWater` and `border` are new switches (54 knobs, within the renderer's 64 because the overhead composer lists no World knobs yet).
