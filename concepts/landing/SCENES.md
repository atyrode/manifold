# Scene backlog

Scene ideas beyond the first five (wave, starry, orbit, swell, pond). Each is a dithered shader
scene: animated, tweakable in the lab, with a standalone Manifold landmark that fits the scene.
How to write one: `src/scenes/README.md`.

## Status

All of the ideas below have a first implementation in the lab:

| Idea | Scene id | Notes |
|---|---|---|
| Above the clouds | `clouds` | Aurora and lightning come from the shared weather layer. |
| Waterfall | `falls` | |
| Countryside | `country` | |
| Murmuration | `flock` | CPU boids, topological neighbours. |
| Paper marbling | `marble` | Mathematical marbling engine. |
| Dunes | `dunes` | Werner slab model. |
| Ice and frost | `frost` | Frost on a window pane; snowfall from the weather layer. |
| Snow and rain | merged | Part of the shared weather layer, not a scene: rain, snow, rain on glass, ripples, fog. |
| Sea shore and bioluminescent bay | `shore` | |
| Window sill | `sill` | |

The shared options became libraries every outdoor scene can use: sky and time of day, weather,
lightning and aurora (`src/shaders/lib/`), with shared lab knobs (`src/scenes/atmosphere.ts`).
The notes below are the original briefs.

## Zen batch

A second batch of calm scenes whose subject is a simulation, from grounded scenery to pure
mathematics. All have a first implementation in the lab:

| Idea | Scene id | Simulation | Shared engine |
|---|---|---|---|
| Dry stone garden (karesansui) | `garden` | Raked gravel height field, falling-plate maple leaves | `HeightField` |
| Bamboo grove and water clock (shishi-odoshi) | `bamboo` | Damped culm springs under gust fronts, tipping tube | |
| Lantern river (tōrō nagashi) | `lanterns` | Lanterns in potential flow round stones, eddies, contacts | |
| Synchronous fireflies | `fireflies` | Pulse-coupled oscillators on a lattice | |
| Kelp forest | `kelp` | Buoyant Verlet stipes in surge, boids school | `VerletSystem` |
| Spider web at dawn | `dew` | Verlet orb web, dew drops creeping and falling | `VerletSystem` |
| Meadow in the wind (honami) | `meadow` | Gust fronts shared by shader and sim, dandelion seeds | |
| Ink-wash landscape scroll (shan shui) | `shanshui` | Procedural handscroll, drifting mist | |
| Incense smoke | `incense` | Buoyant smoke, laminar to turbulent | `FluidSim` |
| Sand table | `sandtable` | Theta–rho ball and sand pendulum on a height field | `HeightField` |
| Chladni plate | `chladni` | Sand grains drifting to the nodal lines of plate modes | |
| Ferrofluid | `ferro` | Rosensweig spike lattice, sloshing blob | |
| Soap film | `film` | Thin-film interference, gravity drainage, pops | `FluidSim` |
| Pearlescent fluid (rheoscopic) | `pearl` | Flake orientation advected and turned by the flow | `FluidSim` |
| Petri dish | `petri` | Gray–Scott Turing patterns, Barkley BZ spirals | `GpuCompute` |
| Slime mould network (Physarum) | `physarum` | Jones agent model linking oat flakes | `GpuCompute` |
| Hyperbolic tiling | `hyperbolic` | Möbius glide over a {p,q} weave | |
| River delta from above | `delta` | Shallow water erosion and deposition | `GpuCompute` |
| Fractals | `fractal` | Julia walk, Mandelbrot dive, Apollonian gasket, Newton garden | |
| Prism | `prism` | Dispersion through glass, total internal reflection | |

## Slices of life and more

A third batch built on the shared foundations (weather in the world, hard edges, the GPU and CPU sims):

| Idea | Scene id | Simulation |
|---|---|---|
| Late-night bar | `bar` | Patrons arrive, sip and leave; the bartender pours, shakes, polishes; rain and traffic outside the window |
| City crossing at dusk | `street` | Social-force walkers, intelligent-driver traffic, a signal cycle with a scramble; umbrellas open in the rain |
| Night train window | `train` | A journey with stations, level crossings, bridges and tunnels; tea rings at every rail joint |
| Mystic forest | `forest` | Kodama spirits appearing and turning their heads, spores on curl-noise air, a stag crossing |
| Ripple tank | `ripple` | GPU wave equation: interference, double slit, lens, Doppler, standing waves; projected caustics |
| Lava lamp | `lava` | Heated wax blobs with buoyancy, necks and merging |
| Frozen lake | `lake` | Aurora mirrored in black ice, singing cracks, drifting snow, frozen bubbles |
| Bonsai through the seasons | `bonsai` | Space-colonisation growth, cloud pads on springs, leaf fall, snow, pruning |

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

## Window sill

A view from inside, through an open window onto a city skyline, with a cat sitting on the sill, in
the spirit of lo-fi study streams.

- The cat as the living detail: breathing, ear twitches, tail flicks, the occasional slow blink or
  stretch; a "now" trigger for a bigger gesture (yawn, turning to look at the pointer).
- Skyline layers with parallax, windows lighting up and going dark, a time-of-day dial from dusk
  to deep night, rain on the glass or snow as options (shared with the weather layer).
- Interior hints at the frame edges: curtain stirring in the breeze, a plant or a mug on the sill,
  warm lamp light spilling onto the sill against the cool city.

## Shared options worth building once

- **Aurora** (orbit has one; adapt it for ground- and plane-level views).
- **Lightning**: branching bolts (stochastic L-system or dielectric-breakdown model), sky flash,
  trigger with a "now" button like the meteors.
- **Weather and time of day** as a common layer across outdoor scenes.
