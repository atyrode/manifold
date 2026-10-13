# Scene backlog

Scenes to explore after the current ones (wave, starry, orbit, swell, pond). Each is a dithered
shader scene like the others: animated, tweakable in the lab, with a standalone Manifold landmark
that fits the scene. Notes give a starting direction, not a design.

## Above the clouds

The view from a plane window: a sea of clouds below, open sky above.

- Time of day/night as the main dial: dawn, noon, golden hour, sunset glow lighting cloud tops from
  below the horizon, blue hour, moonlit night with stars.
- Cloud layer: raymarched or layered fbm density with a sun-dependent silver lining; slow drift.
- Options: **aurora** over the night side (reuse orbit's aurora curtains, seen from inside the
  atmosphere), **lightning** flickering inside distant cumulonimbus (trigger + random), the moon,
  contrails, a distant wingtip in the corner.

## Waterfall

A cliff face with a waterfall as the focus.

- Falling water as streaks advected down a flow field, foam and spray mist at the base, a plunge
  pool with ripples.
- Rock strata, moss and ferns on the ledges (reuse the pond's botany), rainbow in the spray when
  the sun is behind the viewer.

## Countryside

Overlooking rolling hills with a village in the distance and forest around.

- Layered hills with atmospheric perspective, patchwork fields, hedgerows, a winding road or river.
- Village: a few roofs and a church spire, chimney smoke; forest canopy as dithered texture.
- Day cycle and weather (cloud shadows sweeping over the fields).

## Murmuration

A sky scene whose subject is a starling murmuration.

- Simulation: boids (separation, alignment, cohesion) with the topological rule of starlings
  (each bird tracks ~7 neighbours), predator passes as a trigger, the flock folding and pulsing.
- Thousands of birds: GPU simulation in textures, or CPU for a few thousand with spatial hashing.
- Sky at dusk; a low skyline at the bottom edge, never the focus.

## Paper marbling

Ink dropped on water, combed and swirled, as in ebru / suminagashi.

- Mathematical marbling (Lu, Jaffer, Jin, Zhao & Mao, "Mathematical Marbling", IEEE CG&A 2012):
  drops and tine strokes are closed-form deformations of the ink boundaries, so patterns stay crisp.
- Interaction: click to drop ink, drag to comb; presets for traditional patterns (nonpareil,
  chevron, bouquet).

## Dunes

Wind over a sand sea.

- Ripples and dune crests migrating downwind, sand blowing off the crests, long low-sun shadows.
- Possibly a height-field simulation (saltation and avalanching).

## Ice and frost

- Frost crystals growing across a pane (diffusion-limited aggregation or a phase-field model),
  melting from a warm point under the pointer.
- Or a frozen lake: cracks, trapped bubbles, snow drifting across the surface.

## Weather: snow and rain

- Snowfall with depth layers and wind gusts, settling on edges.
- Rain on a window: drops sliding and merging, the scene behind them refracted and blurred.
- Lightning as an option (shared with the cloud scene).

## Sea shore and bioluminescent bay

- A beach at night: waves rolling in, foam lines, wet sand reflections.
- **Bioluminescence** as an option: blue glow where water is disturbed (breaking waves, the
  pointer stirring the water, fish darting).
- Day mode as an ordinary seaside scene.

## Shared options worth building once

- **Aurora** (orbit has one; adapt it for ground- and plane-level views).
- **Lightning**: branching bolts (stochastic L-system or dielectric-breakdown model), sky flash,
  trigger with a "now" button like the meteors.
- **Weather and time of day** as a common layer across outdoor scenes.
