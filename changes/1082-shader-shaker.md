---
section: Changed
issue: 1082
---

The landing concept hands the graphics driver a fraction of each scene's shader: before a program compiles, its feature switches are resolved, its comments dropped and every function, constant and uniform the scene never reaches left out, line for line so compile errors still point at the right code. A scene's default program shrinks to about a fifth of its text (from a fifteenth for the simplest to under half for the busiest), with the same pictures. The knob values and the constellation tables now travel packed into four-wide slots, so even a scene with every night-sky feature on stays well inside the uniform space every WebGL 2 device guarantees (at most 164 of 224 vectors, where 14 programs needed up to 245). A unit test holds each scene's shader to a size budget, and a new glslang check compiles every scene's default and all-features shader and fails when one does not build or does not fit.
