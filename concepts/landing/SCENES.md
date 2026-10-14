# Scene backlog

Scene ideas beyond the first three (orbit, swell, pond). Each is a dithered shader
scene: animated, tweakable in the lab, with a standalone Manifold landmark that fits the scene.
How to write one: `src/scenes/README.md`.

## Status

All of the ideas below have a first implementation in the lab:

| Idea | Scene id | Notes |
|---|---|---|
| Above the clouds | `clouds` | Aurora and lightning come from the shared weather layer. |
| Waterfall | `falls` | |
| Countryside | `country` | Relative weights for seasonal crops, wildflower meadows, lavender rows and sunflowers; reproducible landscape seeds. |
| Murmuration | `flock` | CPU boids, topological neighbours. |
| Paper marbling | `marble` | Mathematical marbling engine. |
| Dunes | `dunes` | Werner slab model. |
| Ice and frost | `frost` | Frost on a window pane; snowfall from the weather layer. |
| Snow and rain | merged | Part of the shared weather layer, not a scene: rain, snow, rain on glass, ripples, fog. |
| Sea shore and bioluminescent bay | `shore` | |
| Window sill | `sill` | |

The shared options became libraries every outdoor scene can use: sky and time of day, weather,
lightning and aurora (`src/shaders/lib/`), with shared lab knobs (`src/scenes/atmosphere.ts`). The
giant ringed planet is one too (`src/shaders/lib/planet.ts`, knobs `src/scenes/planet.ts`): `orbit`
draws it as its subject with every feature (belts, clouds, storms, aurora, city lights, day cycle,
banded rings, moons), `campfire` as scenery over its pines.
The notes below are the original briefs.

## Zen batch

A second batch of calm scenes whose subject is a simulation, from grounded scenery to pure
mathematics. All have a first implementation in the lab:

| Idea | Scene id | Simulation | Shared engine |
|---|---|---|---|
| Dry stone garden (karesansui) | `garden` | Raked gravel height field, falling-plate maple leaves; fresh gravel dries on an `AgeField` clock, optionally with the weather (weathering, sun, wind, rain), damp lingering in the groove bottoms | `HeightField`, `AgeField` |
| Bamboo grove and water clock (shishi-odoshi) | `bamboo` | Damped culm springs under gust fronts, tipping tube | |
| Lantern river (tōrō nagashi) | `lanterns` | Lanterns in potential flow round stones, eddies, soft contacts; stones and deep lantern overlaps settled after each step | `separateDiscs` |
| Synchronous fireflies | `fireflies` | Pulse-coupled oscillators on a lattice; dense-crown or open-bank habitat at one population | |
| Kelp forest | `kelp` | Buoyant Verlet stipes in surge, boids school | `VerletSystem` |
| Spider web at dawn | `dew` | Verlet orb web, dew drops creeping and falling; paged bin lists keep the dense hub whole | `VerletSystem`, `BinLists` |
| Meadow in the wind (honami) | `meadow` | Gust fronts shared by shader and sim, dandelion seeds | |
| Ink-wash landscape scroll (shan shui) | `shanshui` | Procedural handscroll, drifting mist, four seasons' washes; painted in sections joined by mounting silk so days of unrolling stay precise | |
| Incense smoke | `incense` | Buoyant smoke, laminar to turbulent | `FluidSim` |
| Sand table | `sandtable` | Theta–rho ball and sand pendulum on a height field; the relief is re-sent every frame while a machine outruns it, so a groove's head stays under the ball | `HeightField` |
| Chladni plate | `chladni` | Sand grains drifting to the nodal lines of plate modes | |
| Ferrofluid | `ferro` | Rosensweig spike lattice, sloshing blob | |
| Soap film | `film` | Thin-film interference, gravity drainage, pops | `FluidSim` |
| Pearlescent fluid (rheoscopic) | `pearl` | Flake orientation advected and turned by the flow | `FluidSim` |
| Petri dish | `petri` | Gray–Scott Turing patterns, Barkley BZ spirals | `GpuCompute` |
| Slime mould network (Physarum) | `physarum` | Jones agent model linking oat flakes | `GpuCompute` |
| Hyperbolic tiling | `hyperbolic` | Möbius glide over a {p,q} weave; drags re-grip when the map or screen shape changes | |
| River delta from above | `delta` | Shallow water erosion and deposition | `GpuCompute` |
| Fractals | `fractal` | Julia walk, Mandelbrot dive, Apollonian gasket, Newton garden; drag pan tethered to the frame | `ElasticPan` |
| Prism | `prism` | Dispersion through glass, total internal reflection | |

## Slices of life and more

A third batch built on the shared foundations (weather in the world, hard edges, the GPU and CPU sims):

| Idea | Scene id | Simulation |
|---|---|---|
| Late-night bar | `bar` | Patrons arrive, sip and leave; the bartender pours, shakes, polishes; rain and traffic outside the window. Last call (the time-of-night "now"): a hand bell and two blinks of the lamps (just the blinks with the bartender off), last sips, one for the road or a word with you if the bar is empty, then closing time until the time of night is moved |
| City crossing at dusk | `street` | Social-force walkers, intelligent-driver traffic, a signal cycle with a scramble; umbrellas open in the rain |
| Night train window | `train` | A journey with stations, level crossings, bridges and tunnels; tea rings at every rail joint |
| Mystic forest | `forest` | Kodama spirits appearing and turning their heads, curious of the pointer or (a tunable share) shy of it and ducking into the moss (`sims/temperament.ts`); spores on curl-noise air, a stag crossing |
| Ripple tank | `ripple` | GPU wave equation: interference, double slit, lens, Doppler, standing waves; projected caustics |
| Lava lamp | `lava` | Heated wax blobs with buoyancy, necks and merging |
| Frozen lake | `lake` | Aurora mirrored in black ice, singing cracks, drifting snow, frozen bubbles; lying snow from wind-packed crust to fresh powder at the same cover |
| Bonsai through the seasons | `bonsai` | Space-colonisation growth, cloud pads on springs, leaf fall, snow, pruning |

## Quiet places and small machines

A fourth batch, after the cosy-game mood (gentle, warm, unhurried) rather than any game's look:

| Idea | Scene id | Simulation |
|---|---|---|
| Harmonograph | `harmonograph` | Damped, slightly detuned pendulums drive a pen; the figure precesses and spirals inward, then a fresh sheet slides in |
| Campfire under a ringed planet | `campfire` | Licking flame tongues, sparks, smoke, a toasting marshmallow, a vast starry sky. Optional burning down (`FuelBed`, `src/sims/fuel.ts`): logs catch, char, thin, slump and crumble to embers, tended or left to go out. The giant planet is the shared one (`shaders/lib/planet.ts`, decoration tier): optional moons on its ring plane (crossing in front of and behind it, casting shadows), an aurora, night-side city lights and its own day cycle |
| Pendulum wave | `pendula` | Exact small-angle pendulums with lengths for N + n swings per cycle: waves, helices, chaos, realignment |
| A small island | `island` | Raymarched island with surf, cloud shadows, a gull and weather; rain seen from above converges below |
| Aurora over a fjord | `aurora` | Draped ribbons with rays, mirrored in still water or ice (or, with the wind ripples knob, broken into streaks by drifting cat's-paws: `shaders/windWater.ts`), a red cabin, falling and lying snow |
| Summer apiary | `bees` | A hillside garden of hives, lavender rows and orchard under cumulus; bees are specks whose flight tells the story (beelines between hive and flowers, hovering, crowds at the entrances), with fluttering butterflies. Each dither cell shows its nearest insect (`SpeckMap`, `src/sims/specks.ts`), so scenery hides only what is behind it |
| Looking up at the city | `skyward` | Facades converging on the zenith, trams, planes and contrails, birds; rain streams out of the sky overhead |
| Autumn park | `autumn` | Leaves flutter and tumble down (quasi-steady plate model), build a carpet (the two-layer ground-litter lattice `sims/litter.ts`), and gusts lift swirls of the top leaves off the path |

Rain everywhere falls at terminal speed in real time, along the world's vertical as each scene's camera
sees it (`rainFallSeen`), whatever the calm of the rest of the scene.

## Tide pool

`tidepool`: a rock pool on a basalt platform, seen from straight above, with the open sea along the
top. Prototype (issue #1082, N1), built from shared parts rather than scene code:

- **Water:** `ShallowWater` (`src/sims/shallow.ts`), GPU shallow water over a bed (virtual pipes,
  local inertial flow, the scheme the delta's river uses). A wave maker in the top band forces both
  the swell's level and its flow, so waves run in one way and reflections are soaked up; they shoal,
  break over the reefs, run up the rock and, in the sets, pour through the notch in the basin's rim.
  The basin keeps what comes over and spills back to its sill. `stillWater` (priority flood) opens
  every layout settled: the basin and potholes full to their spill points.
- **Response:** the water carries foam (made where the flow outruns its own waves), agitation (a
  hard surge or a touch closes the anemones; they reopen over ~10 s) and wetness (rock drying over
  half a minute). Kelp and surfgrass stream and flutter with the flow at their holdfasts; anemones
  lean with it and close when the water leaves them.
- **Caustics:** `src/shaders/caustics.ts`: the swell's caustic focus from the sim's surface Hessian
  times analytic wind ripples', both det(I + D·H), D a quarter of the depth.
- **Passage:** entering, the last of a wave's white water drains back up the frame and the anemones
  unfurl; leaving, a wave breaks in from the sea and sweeps down over everything.
- Knobs: tide (and a tide cycle), swell, wave length, direction, sets (with "now"), pace, foam;
  caustics, glints, breeze; sky time and rain; anemones (and shyness), kelp, surfgrass, sea lettuce,
  sea stars, urchins, sway; rock type, mussels/barnacles, coralline, pool size, arrangement;
  bioluminescence; a pebble M.
- Open: the rock reads too dark and busy at the dither, the open sea reads as mottled rather than
  as swell, and the zonation needs art direction before this leaves the prototype stage.

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
- Village: a few roofs and a church spire, chimney smoke.
- Woodland: `woodland cover` grows or clears the distant woods at their edges (50% is the original
  valley, 0 clears every wood); `pine mix` sets how many trees are tapered evergreen pines (25% by
  default). Woods are drawn as whole trees of varied size, with up to two per crown cell, ragged
  edges and clearings, over a shaded forest floor — never as a translucent overlay. Pines stay
  evergreen in autumn. Treetops raise the visible skyline and occlude what is behind them, but the
  ground's fields and lighting follow only the bare terrain, and pixels inside the treeline are
  always canopy. Unresolved distant crowns use an area-mean colour instead of per-crown detail.
- Day cycle and weather (cloud shadows sweeping over the fields).
- Fields: independently weight original seasonal crops, wildflowers, lavender and sunflowers from
  0–100. Weights are relative, not area percentages: 2:1:1:0 gives approximately half crop fields,
  a quarter wildflowers and a quarter lavender, with no sunflowers. All zero falls back to crops.
  Whole fields retain one material and the seed/layout remains fixed while weights change. The
  crop share retains its full seasonal catalogue, even when flowers dominate. Nearby plants have
  rooted stems, flower heads, spikes or leaves; distant detail resolves to field material.
- Landscape: a deterministic arrangement number changes hills, field borders and village placement
  together. Zero preserves the original view; changing weights, season or weather keeps the
  selected arrangement. Weights and landscape round-trip through URLs and saved setups. Previously
  saved `fieldType` recipes migrate on read unless any new weight is explicit; rewritten URLs contain
  only weights. Historical revision-pinned replay keeps its original controls and render.
- Presets: the original crop baseline, flower valley, lavender rows, sunflowers and mixed patchwork.
  Their replay arrows point to the actual feature revision on which these setups were tuned.

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
- Clicks pour where the pointer's line of sight meets the sand as drawn (`marchHeight` with the
  shader's own march numbers, turned with the pointer parallax), or at the sandstone M's face.

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
