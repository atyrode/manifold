---
section: Changed
issue: 1082
---

The landing concept's simulations share one exponential ease and one relayout debounce instead of hand-written copies. `approach` and `easeFactor` in `sims/math.ts` replace about forty inline `1 - exp(-dt / tau)` easing expressions in the scene sims, with the same arithmetic. A `Settle` helper in `sims/clock.ts` replaces the four copies of the wait-until-the-knob-rests rule in the delta, dunes, garden and tidepool. The Manifold M in the forest, frost, lake, lava and ripple sims is read from `mark.ts` rather than retyped. No picture changes.
