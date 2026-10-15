# Scene backlog

The lab's scenes, one row each in the tables below: the first three (orbit, swell, pond) and the
ideas that followed them. Each is a dithered shader scene: animated, tweakable in the lab, with a
standalone Manifold landmark that fits the scene. How to write one: `src/scenes/README.md`.

## Status

The first three and all of the ideas below have a first implementation in the lab:

| Idea                             | Scene id  | Notes                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Planet in orbit                  | `orbit`   | The shared giant planet as the subject (`shaders/lib/planet.ts`, hero tier), every feature a knob: clouds, storms, aurora, city lights, a day cycle, moons and the banded ring system. Behind it real constellations (with figure lines), shooting stars, captured meteors, a nebula and a drifting starfield; the M as night-side city lights or an asterism.                                      |
| Moonlit swell                    | `swell`   | Open-ocean swell and chop rolling toward the horizon, painted flat or, with `relief`, standing up near by; its own moon (`moon` sizes it; an M in its seas as an option) and stars. Optional birds (the shared birds, gulls by default) over the night sea, hidden by the crests, and optional shooting stars (the shared meteors) glinting in the waves.                                           |
| Koi pond                         | `pond`    | Koi seen from above, drawn with the shared fish (`sims/fish.ts`) and steered by it while drawn to the pointer; lily pads, ripples, five floor beds, water weeds, caustics (the shared water's caustics tier, "Pond water") and god rays. The border plants are the shared plant component ("Pond plants"); optional: a canopy, a current carrying petals and a paper boat, a manifold stone.        |
| Above the clouds                 | `clouds`  | Aurora and lightning come from the shared weather layer. The sea of cloud below is the shared clouds' volume tier (`cloudSeaMarch`, `CLOUD_TIER` volume); the stars over it are the shared stars control.                                                                                                                                                                                           |
| Waterfall                        | `falls`   | Gorge choice: basalt flows (default), sandstone ledges, or a pale limestone slot whose walls close in. Optional birds (the shared birds): swifts crossing the gorge, hidden behind the cliff they fly beyond. The shared sky components over the rim: a stars control, the moon's phase, an aurora whose arc is lifted to show its lower edge over the rim, and shooting stars that fall behind it. |
| Countryside                      | `country` | Relative weights for seasonal crops, wildflower meadows, lavender rows, sunflowers and pasture enclosures with herds; reproducible landscape seeds. Its optional parts are compiled in only while their knobs are on (`featuresFor`).                                                                                                                                                               |
| Murmuration                      | `flock`   | Authored deforming sheet on the CPU; optional emergent topological boids (`Boids`). The stars after dusk are the shared stars control.                                                                                                                                                                                                                                                              |
| Paper marbling                   | `marble`  | Mathematical marbling engine.                                                                                                                                                                                                                                                                                                                                                                       |
| Dunes                            | `dunes`   | Werner slab model. The shared sky components over the dune sea: a stars control (a dark desert sky, drawn 1.3x bright), the moon's phase (which lights the sand), an aurora under the dust and shooting stars.                                                                                                                                                                                      |
| Ice and frost                    | `frost`   | Frost on a window pane; snowfall from the weather layer; the shared sky components (stars, moon phase, aurora, shooting stars) in the window.                                                                                                                                                                                                                                                       |
| Snow and rain                    | merged    | Part of the shared weather layer, not a scene: rain, snow, rain on glass, ripples, fog.                                                                                                                                                                                                                                                                                                             |
| Sea shore and bioluminescent bay | `shore`   | The stars over the sea and glinting in the wet sand are the shared stars control.                                                                                                                                                                                                                                                                                                                   |
| Window sill                      | `sill`    | The shared sky components over the city: a stars control, the moon's phase, an aurora whose light comes in through the window, and shooting stars, all behind the cloud deck.                                                                                                                                                                                                                       |

The shared options became libraries every outdoor scene can use, compiled into every program: sky
and time of day (stars, the moon's phase, shooting stars), clouds in tiers (a calm deck, the lit
deck, its shadows, a sea of tops seen from above), weather, lightning, aurora, the weather under a
closed canopy and water in tiers (`src/shaders/lib/`), with shared lab knobs
(`src/scenes/atmosphere.ts`). Others are opt-in, included only by the scenes that draw them: the
giant ringed planet (`src/shaders/lib/planet.ts`, knobs `src/scenes/planet.ts`), which `orbit`
draws as its subject with every feature (belts, clouds, storms, aurora, city lights, day cycle,
banded rings, moons) and `campfire` as scenery over its pines; the Milky Way
(`src/shaders/lib/milkyway.ts`), over `campfire` and `lake`; the birds (`src/shaders/lib/birds.ts`);
the rooted plants (`src/sims/plants.ts`, `src/shaders/lib/plants.ts`, knobs `src/scenes/plants.ts`);
and the countryside's figures, livestock and buildings. Which scene composes which: "Composing
components" in `src/scenes/README.md`. The sections after the tables keep the original briefs, with
notes on what was built.

## Zen batch

A second batch of calm scenes whose subject is a simulation, from grounded scenery to pure
mathematics. All have a first implementation in the lab:

| Idea                                         | Scene id     | Simulation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Shared engine                                                                                             |
| -------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Dry stone garden (karesansui)                | `garden`     | Raked gravel height field, falling-plate maple leaves on the shared gust pulse (the maple sways with its GLSL twin); fresh gravel dries on an `AgeField` clock, optionally with the weather (weathering, sun, wind, rain), damp lingering in the groove bottoms; at night the shared moon's phase sets the light (no stars: the horizon is the frame's top edge); the woods over the wall and an optional border along its foot are rooted plants swaying in the wind and the gust's front | `HeightField`, `AgeField`, `FlutterPlates`, `gustPulse`, `RootedPlants`, sky components                   |
| Bamboo grove and water clock (shishi-odoshi) | `bamboo`     | Damped culm springs under gust fronts, tipping tube; a moss pad on its stone softens the knock for a quiet clock; rain cloud, rays and gap sky under the leaves from the shared canopy weather, with a stars control and the moon's phase in the gaps and the night rays                                                                                                                                                                                                                   | `canopyWeather`, sky components                                                                           |
| Lantern river (tōrō nagashi)                 | `lanterns`   | Lanterns in potential flow round stones, eddies, soft contacts; stones and deep lantern overlaps settled after each step; the river's ripples ride the current; optional birds over the far bank, mirrored in the rippled river; a stars control (the scene's own sparse stars thin out below it), and an aurora over the temple and shooting stars, both mirrored in the river (its young crescent stays the scene's own)                                                                 | `separateDiscs`, water `flow` tier (`rippleSpectrum`, `waterDrift`, `waterMirror`), birds, sky components |
| Synchronous fireflies                        | `fireflies`  | Pulse-coupled oscillators on a lattice; dense-crown or open-bank habitat at one population; the lights nearer than the bank move in the world in front of the eye; the mangroves are rooted plants bowing to the breeze ("Fireflies mangroves"); optional shooting stars over the hills                                                                                                                                                                                                    | `LevelCamera`, `RootedPlants`, meteors                                                                    |
| Kelp forest                                  | `kelp`       | Buoyant Verlet stipes in surge: giant kelp, or bull kelp held up by one gas bulb (or a mix); boids school                                                                                                                                                                                                                                                                                                                                                                                  | `VerletSystem`, `fishGlsl`                                                                                |
| Spider web at dawn                           | `dew`        | Verlet orb web, dew drops creeping and falling; paged bin lists keep the dense hub whole                                                                                                                                                                                                                                                                                                                                                                                                   | `VerletSystem`, `BinLists`                                                                                |
| Meadow in the wind (honami)                  | `meadow`     | Gust fronts shared by shader and sim, dandelion seeds carried in the world along the gust direction; optional birds over the field, behind the grass nearer than them; a stars control, the moon's phase, an aurora and shooting stars behind the clouds                                                                                                                                                                                                                                   | `LevelCamera`, birds, sky components                                                                      |
| Ink-wash landscape scroll (shan shui)        | `shanshui`   | Procedural handscroll, drifting mist, four seasons' washes; painted in sections joined by mounting silk so days of unrolling stay precise                                                                                                                                                                                                                                                                                                                                                  |                                                                                                           |
| Incense smoke                                | `incense`    | Buoyant smoke, laminar to turbulent; a ceiling vent draws the layered veils off without bending the thread                                                                                                                                                                                                                                                                                                                                                                                 | `FluidSim`                                                                                                |
| Sand table                                   | `sandtable`  | Theta–rho ball and sand pendulum on a height field; the relief is re-sent every frame while a machine outruns it, so a groove's head stays under the ball                                                                                                                                                                                                                                                                                                                                  | `HeightField`                                                                                             |
| Chladni plate                                | `chladni`    | Sand grains drifting to the nodal lines of plate modes; grain size from fine sand (thin, crisp lines, slow to gather) to grit (broad, rough, steep ridges, quick)                                                                                                                                                                                                                                                                                                                          | `grainAt`                                                                                                 |
| Ferrofluid                                   | `ferro`      | Rosensweig spike lattice, sloshing blob                                                                                                                                                                                                                                                                                                                                                                                                                                                    |                                                                                                           |
| Soap film                                    | `film`       | Thin-film interference, gravity drainage, pops whose rim crosses the film from the break in least time                                                                                                                                                                                                                                                                                                                                                                                     | `FluidSim`, `ArrivalField`                                                                                |
| Pearlescent fluid (rheoscopic)               | `pearl`      | Flake orientation advected and turned by the flow                                                                                                                                                                                                                                                                                                                                                                                                                                          | `FluidSim`                                                                                                |
| Petri dish                                   | `petri`      | Gray–Scott Turing patterns, Barkley BZ spirals                                                                                                                                                                                                                                                                                                                                                                                                                                             | `GpuCompute`, `grayScottRegimes`                                                                          |
| Slime mould network (Physarum)               | `physarum`   | Jones agent model linking oat flakes                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `GpuCompute`                                                                                              |
| Hyperbolic tiling                            | `hyperbolic` | Möbius glide over a {p,q} weave; drags re-grip when the map or screen shape changes                                                                                                                                                                                                                                                                                                                                                                                                        |                                                                                                           |
| River delta from above                       | `delta`      | Shallow water erosion and deposition                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `GpuCompute`                                                                                              |
| Fractals                                     | `fractal`    | Julia walk, Mandelbrot dive, Apollonian gasket, Newton garden; drag pan tethered to the frame                                                                                                                                                                                                                                                                                                                                                                                              | `ElasticPan`                                                                                              |
| Prism                                        | `prism`      | Dispersion through glass, total internal reflection; Newton's recombination by a second prism that slides in along the fan and steps back when the first turns into it                                                                                                                                                                                                                                                                                                                     |                                                                                                           |

## Slices of life and more

A third batch built on the shared foundations (weather in the world, hard edges, the GPU and CPU sims):

| Idea                       | Scene id | Simulation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Late-night bar             | `bar`    | Patrons arrive, sip and leave; the bartender pours, shakes, polishes; rain and traffic outside the window. Last call (the time-of-night "now"): a hand bell and two blinks of the lamps (just the blinks with the bartender off), last sips, one for the road or a word with you if the bar is empty, then closing time until the time of night is moved                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| City crossing at dusk      | `street` | Social-force walkers, intelligent-driver traffic, a signal cycle with a scramble; umbrellas open in the rain; optional late delivery (a van at the kerb past the crossing, hazards on, its driver wheeling crates to the konbini through the crowd, cyclists swinging out round it). Seen from a window pitched down at the crossing, rain and snow both fall along paths that close in below the street (`rainFallSeen`, `snowFallSeen`). The sky shows only in reflections: a stars control in the window glass and the moon's phase in the windows and the wet street                                                                                                                                                                                                                                 |
| Night train window         | `train`  | A journey with stations, level crossings, bridges and tunnels; tea rings at every rail joint; everything that moves with the motion clock (clouds, lamps, flashers, station clock, the carriage's rock) keeps its phase when Motion changes. A `line` choice sets the country and its timetable together: country (as always), rural (low farmland, frequent halts with a crossing at the platform's end, crossings everywhere, short stream bridges, no tunnels, slower) or mountain (high hills and peaks, long tunnels chained over stone viaducts across deep gorges, few stations or crossings, slower still); the shared stars and moon phase are knobs, the cloud deck is the shared clouds' calm deck (`CLOUD_TIER` flat), and the shared birds (off by default) fly the line's own kinds by day |
| Mystic forest              | `forest` | Kodama spirits appearing and turning their heads, curious of the pointer or (a tunable share) shy of it and ducking into the moss (`sims/temperament.ts`); spores on curl-noise air, a stag crossing; rain cloud, shafts and gap sky under the canopy from the shared canopy weather (`shaders/lib/canopy.ts`, as bamboo's), with a stars control and the moon's phase in the gaps and the night rays                                                                                                                                                                                                                                                                                                                                                                                                    |
| Ripple tank                | `ripple` | GPU wave equation: interference, double slit, lens, Doppler, standing waves; projected caustics; edge absorption from beaches that swallow every wave to bare walls that reflect them, apart from open-water damping                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Lava lamp                  | `lava`   | Heated wax blobs with buoyancy, necks and merging; a wax body from silky (smaller blobs slipping through each other, long tails, smooth merges) to chunky (fewer, slower, knobbly lumps)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Frozen lake                | `lake`   | Aurora mirrored in black ice, singing cracks, drifting snow, frozen bubbles; lying snow from wind-packed crust to fresh powder at the same cover. The crack and snow fields are laid out on the ice as the eye at rest sees it (`LevelCamera`); optional birds (geese by default) mirrored in the ice; the shared Milky Way with its brightness control and optional shooting stars (the shared components without the clock, `skyComponentKnobs`: the lake keeps its own hour, stars and moon, and runs the shared aurora on its substorm clock) over the mountains and in the ice                                                                                                                                                                                                                      |
| Bonsai through the seasons | `bonsai` | Space-colonisation growth, cloud pads on springs, leaf fall, snow, pruning; with the breeze off the pads hang still until a gust, snip or hover                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Quiet places and small machines

A fourth batch, after the cosy-game mood (gentle, warm, unhurried) rather than any game's look:

| Idea                           | Scene id       | Simulation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harmonograph                   | `harmonograph` | Damped, slightly detuned pendulums drive a pen; the figure precesses and spirals inward, then a fresh sheet slides in                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Campfire under a ringed planet | `campfire`     | Licking flame tongues, sparks, smoke, a toasting marshmallow, a vast starry sky with the shared Milky Way (`shaders/lib/milkyway.ts`, with a brightness control). Optional burning down (`FuelBed`, `src/sims/fuel.ts`): logs catch, char, thin, slump and crumble to embers, tended or left to go out. The giant planet is the shared one (`shaders/lib/planet.ts`, decoration tier): optional moons on its ring plane (crossing in front of and behind it, casting shadows), an aurora, night-side city lights and its own day cycle                      |
| Pendulum wave                  | `pendula`      | Exact small-angle pendulums with lengths for N + n swings per cycle: waves, helices, chaos, realignment; or real ones, released by a board and slowed by their own wide swing (`sims/pendulum.ts`), drifting off the realignment                                                                                                                                                                                                                                                                                                                            |
| A small island                 | `island`       | Raymarched island with surf, cloud shadows, a gull and weather; rain and snow seen from above both converge below the sea (`rainFallSeen`, `snowFallSeen` through one `islVanish`); the sea is the shared water's `mirror` tier (four hand-placed ripple trains)                                                                                                                                                                                                                                                                                            |
| Aurora over a fjord            | `aurora`       | Draped ribbons with rays, mirrored in still water or ice (or, with the wind ripples knob, broken into streaks by drifting cat's-paws: the shared water's `ripples` tier, `shaders/windWater.ts`), a red cabin, falling and lying snow; optional birds (a skein of geese by default) mirrored in the fjord; optional shooting stars (the shared component without the clock, as the lake's: the fjord keeps its own night, stars, crescent and curtains) among the curtains and in the water                                                                 |
| Summer apiary                  | `bees`         | A hillside garden of hives, lavender rows and orchard under cumulus; bees are specks whose flight tells the story (beelines between hive and flowers, hovering, crowds at the entrances), with fluttering butterflies, all flying in the garden's world and projected through its eye (`LevelCamera`). Each dither cell shows its nearest insect (`SpeckMap`, `src/sims/specks.ts`), so scenery hides only what is behind it. The shared sky components over the valley: a stars control, the moon's phase, an aurora and shooting stars behind the cumulus |
| Looking up at the city         | `skyward`      | Facades converging on the zenith, trams, planes and contrails, pigeons and swifts (the shared birds seen from below); rain streams out of the sky overhead, and snow too with "snow from overhead" (`snowFallSeen`); in its strip of sky, beside the stars control, the shared moon's phase and shooting stars (no aurora: looking up, its curtains hang toward the horizon, out of view)                                                                                                                                                                   |
| Autumn park                    | `autumn`       | Leaves flutter and tumble down (the shared plate model `sims/flutter.ts`, as the garden's), build a carpet (the two-layer ground-litter lattice `sims/litter.ts`), and gusts (the shared pulse, `sims/wind.ts`) lift swirls of the top leaves off the path; over the park, the shared sky components: a stars control, the moon's phase (which sets the night light), an aurora and shooting stars behind the clouds; optional cloud shadows sweeping the park (the shared clouds' `shadows` tier)                                                          |
| Tide pool                      | `tidepool`     | GPU shallow water (`ShallowWater`, `sims/shallow.ts`) over a rock pool seen from straight above: the swell shoals, breaks over the reefs and in the sets pours through the notch in the basin's rim; anemones close in the surge, kelp and surfgrass stream as rooted plants, optional rock pool fish dart from a touch; the caustics are the shared water's caustics tier. A prototype: see "Tide pool"                                                                                                                                                    |
| Hanging mobile                 | `mobile`       | A solar system on balanced arms stacked under a glowing Sun: coupled Verlet pendulums with balls, motors at the planets' real periods (Kepler's third law), ball drag in drafts, gusts and eddies, contacts, the Sun lighting each planet and throwing the mobile's shadows (Saturn's rings included) on the wall                                                                                                                                                                                                                              |

Rain everywhere falls at terminal speed in real time, along the world's vertical as each scene's
camera sees it, whatever the calm of the rest of the scene: straight down the frame under a level
camera (`rainFall`), toward a vanishing point under a tilted one (`rainFallSeen`: tidepool, skyward,
street, island). Snow does the same where the camera tilts (`snowFallSeen`: skyward looking up,
street and island looking down).

## Pond plants

`pond`'s border is grown by the shared plant component (`src/sims/plants.ts`, issue #1082 M11):
every clump, stem, stalk, vine, frond, tuft and flower of the old painted border, laid out draw for
draw from the same seed, is now a rooted plant whose stems and stalks bend on their own springs
and carry their leaves, drawn each frame on the GPU from a botany sprite atlas (`plantsheet.ts`).
Visible differences at rest: leaves are drawn from a fixed set of variants per species instead of
each its own, their outlines come from a 128–256-pixel atlas cell (a touch softer up close), and
the sheet follows the frame's resolution. In the breeze each organ sways on its own (nearer layers
more) instead of whole layers sliding together. New, all off: seasons (the year turns and sheds the
plants, flowers keep their season), growth (leaves unfold, age and are replaced) and gusts (fronts
crossing the pond, "now").

## Pond water

`pond`'s caustics are the shared water's `caustics` tier (issue #1082 M13): two layers of its
cellular net (`causticCells`, `src/shaders/caustics.ts`), light where their seams cross, carried by
the current with the `flow` tier's `waterDrift`; the same picture as the pond's own layers drew.
Where the seams would be thinner than a dither cell (the pond drawn under ~94 cells high, only at
the coarsest pixel sizes) they fade to an even glow instead of flickering. The drop rings and the
refraction they bend the floor with stay the pond's own.

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
- **Caustics:** the shared water's `caustics` tier (`src/shaders/lib/water.ts` over
  `src/shaders/caustics.ts`): the swell's caustic focus from the sim's surface Hessian times
  analytic wind ripples', both det(I + D·H), D a quarter of the depth (`waterCaustic`).
- **Passage:** entering, the last of a wave's white water drains back up the frame and the anemones
  unfurl; leaving, a wave breaks in from the sea and sweeps down over everything.
- **Plants and fish (#1082 M11, M12):** kelp, surfgrass and anemones stand where the shader always
  placed them but are rooted plants of the shared component: the water's flow is averaged onto a
  coarse grid and read back each frame without stalling (`src/sims/readback.ts`), and blades stream
  and anemones lean on springs in it (a frame or two late) instead of following the flow cell by
  cell. Optional rock pool fish (`fish`, the shared `src/sims/fish.ts` with a `BLENNY` species)
  idle over the basin's floor and dart from a touch or a hard surge; seasons and growth (off) turn
  and replace the fronds.
- Knobs: tide (and a tide cycle), swell, wave length, direction, sets (with "now"), pace, foam;
  caustics, glints, breeze; time of day (and a day cycle) and rain; anemones (and shyness), kelp,
  surfgrass, sea lettuce, sea stars, urchins, sway, fish, seasons and growth; rock type, mussels
  (and barnacles), coralline, pool size, arrangement; bioluminescence; a pebble M (and where it
  lies).
- Open: the rock reads too dark and busy at the dither, the open sea reads as mottled rather than
  as swell, and the zonation needs art direction before this leaves the prototype stage.

## Valley

`valley`: a prototype of a shared terrain toolbox (issue #1082), the countryside's vantage over one
coherent map instead of six 1D ridge silhouettes, so the river can lie level and carve the land and
the roads can form a network. Countryside is unchanged until the prototype proves itself.

- **Generation** (`src/sims/terrain.ts`, `TerrainBuilder`): a 3.2 km map at 512² texels (erosion at
  256²), deterministic per seed and built in units a frame's budget spreads (a share of the time
  between frames, so a software renderer builds in as few frames as a GPU). Relief: a valley axis
  laid across the view (out of the far hills on one side, close past the vantage on the other), long
  rolling slopes below the vantage, hills beyond, fractal and ridged value noise. Erosion: implicit
  stream power over a priority-flood drainage (steepest-descent receivers, multiple-flow areas, so
  no grid furrows), thermal slumping. River: the drainage tree's main path, meandering on gentle
  ground, widening with its catchment, its level the ground's running minimum smoothed (never
  rising), carved with a bed, banks and a floodplain. Streams, settlements (village, hamlets, farms,
  a castle on a prominent hilltop) scored for flatness, water, distance and a clear line of sight,
  roads (A\* over slope, curvature, floodplain and fords, water impassable) over a spanning tree with
  a shortcut and a way out over the far hills, one bridge at the narrowest crossing, cut and fill no
  steeper than one in eight, cottages along the roads on terraces, woodland suitability, contour- and
  road-aligned field parcels, lone trees on hedges and banks.
- **Rendering** (`src/shaders/lib/terrain.ts`, `valley/shader.ts`): a height-field march (ground,
  water, the woods' canopy and lone trees) with a soft sun-shadow march, field parcels exact between
  texels with hedges held to half a cell, roads likewise, the river mirroring the sky and its deck,
  the shared buildings (`src/shaders/buildings.ts`) projected from their footings with lit windows and
  smoke, a stone bridge, far ridges in the sky, the shared sky, clouds (and their shadows), rain,
  snow, wetness, lying snow and valley mist. Entrance: the camera comes down out of the sky.
- Knobs: landscape (seed), relief, erosion, woodland (shader-only), river size, settlements, roads;
  time of day, stars, moon, clouds, cloud shadows, rain, snow, fog, wind. Rain, snow, fog, roads,
  cloud shadows and a waning moon are compiled in only while on (`valleyFeatures`).
- Checks: `src/sims/terrain.test.ts` (river level across and downstream, roads join every
  settlement, road grade bounded and cut into the ground, determinism and reuse, build budget);
  `valleyTerrain` (the real sim's textures through the scene's program: compiles, draws land, sky
  and river, deterministic per landscape).
- Open: lone trees and wood edges are texel-sized prisms close up (pixel 1); the near slopes are
  plain pasture; buildings are side-on sprites; no herds, walkers, verges or wildlife yet.

## Above the clouds

The view from a plane window: a sea of clouds below, open sky above.

- Time of day/night as the main dial: dawn, noon, golden hour, sunset glow lighting cloud tops from
  below the horizon, blue hour, moonlit night with stars.
- Cloud layer: a ray-marched sea of tops (the shared clouds' volume tier) with a sun-dependent
  silver lining, sliding past below; its cover, the plane's height above it and its drift are knobs.
- Options: **aurora** over the night side (the shared aurora, seen from inside the atmosphere),
  **lightning** flickering inside distant thunderheads (random, and "now"), the thunderheads
  themselves, a passing plane's contrail, the window frame and the wing (with an M on its winglet
  as an option). The moon has no knob: it keeps its own bearing.
- Level of detail: the march steps grow with distance, and the cauliflower relief that shapes the
  tops' normals fades out as a cell's footprint on the deck grows; once fully faded it is not
  computed at all, for the same picture. The macro field the march, normals and shadows trace keeps
  its full shape at every distance: fading it would reshape the far deck, and a projected-size floor
  under the march step saves only a few percent of steps, even skimming low over a full deck.

## Fireflies mangroves

`fireflies`' bank is grown by the shared plant component (issue #1082 M11): every tree is a rooted
plant, a stem carrying the clumps of its crown, with Rhizophora prop roots in pairs from apexes on
the lattice the shader always hashed them on (same hashes, same sizes, each pair belonging to the
tree above it), drawn per fragment from the plant records (`plantArc`). Habitat choice and swarm
behaviour are unchanged. Visible differences: each root is now a circular arc from its apex down
into the water, so tall narrow arches are pointed where they were elliptical, and a root over open
mud at a crown's edge is no longer drawn; when the breeze crosses, the crowns bow downwind tree
after tree (a few cells at the top of the tall Sonneratia) and swing back, then stand exactly as
laid out; between breezes the trees stand still, as before. New, off: shooting stars (the shared
meteors, `meteors` with "now"), over the hills behind the trees.

## Garden woods and border

`garden`'s woods over the wall are grown by the shared plant component (issue #1082 M11): every
crown of both rows is a tree, one stem from behind the wall up to the crown tops, and the shader
draws its old silhouette for each crown where its stem's tip carries it. In still air (wind 0, no
gust about) the woods are exactly the old picture. Visible difference, the only one by default:
in a breeze the crowns lean downwind and stir crown by crown (about a cell's lean at the default
wind, 540 cells high), and the leaves' "now" gust and the exit's flurry cross them as a front from
the garden's upwind end, the trees bowing one after another (5 to 7 cells at the peak) and swinging
back; once the air has been still for six seconds they stand exactly as laid out again. New, off:
a border planting (`border`, its fullness, with the plants' `growth`), clumps of shield fern and
mondo grass in the gutter at the wall's foot, swaying with the wind and the gust and following the
season choice (pale young fronds in spring, ferns turning gold in autumn and half of them gone in
winter, the evergreen grass dulling, snow on them); from above they lie out toward the gravel. The
maple, moss, rake, leaves and drying are unchanged.

## Meadow wildflowers

`meadow`'s optional `wildflowers` (off) are clumps of the shared plant component
(`meadow/wildflowers.ts`): ox-eye daisies, buttercups, knapweed and field scabious, three stems and
heads a clump, standing out of the grass 4.5 to 11 m away, rooted under the sea of grass's camera
and hidden by the grass nearer than them. The meadow's own gust field (`meadowGust`, the 'now' and
passage gusts included) bows each clump at its foot through `PlantClimate.wind`; once there is no
gust and no wind they come to rest exactly as clumps grown in still air. Compiled in only while on
(`MEADOW_HAS_WILDFLOWERS`); the meadow's own simulation, textures and default picture are unchanged
(`meadowWildflowers` check, `wildflowers.test.ts`).

## Waterfall

A cliff face with a waterfall as the focus.

- Falling water as streaks advected down a flow field, foam and spray mist at the base, a plunge
  pool with ripples.
- Rock strata, moss and ferns on the ledges, rainbow in the spray when the sun is behind the
  viewer.
- The near bank's ferns are rooted plants of the shared component (`falls/sim.ts`): the same clumps
  and fronds, each frond bending on its own spring under the wind, the fall's stir and gusts (new
  `gusts` knob, off), turning and shedding with the year (`season`, off), replaced with `growth`
  (off). The ledge ferns draw the same shared frond (`plantFrond`) from hashes, unchanged.
- Gorges (`gorge`): the layered forms share one bedding model with different beds, dip, folds,
  ledges and stone: basalt flows on rusty ash (the default), or thin, level sandstone ledges on
  shale, cross-bedded. The pale limestone slot is a different form: a few thick, flush beds fluted
  by runnels, split by through-going joints, streaked dark under the lips and crusted with tufa by
  the water, and two side walls running from the back wall toward the eye (unrolled from it, their
  beds converging on the vanishing point), mirrored in the pool, shading the slot's floor and
  leaving a strip of sky over the fall.

## Countryside

Overlooking rolling hills with a village in the distance and forest around.

- Layered hills with atmospheric perspective, patchwork fields, hedgerows, a winding road or river.
- Village: cottages round a church with its spire (`cottages`, 11 the original village; more fill
  lanes outward without moving any), windows lighting up at dusk (`village lights`) and chimney
  smoke. Beyond it, optional settlements: hamlets on the far hills, a castle on the chalk down and
  farmsteads among the nearer fields (`hamlets`, `castle`, `farmsteads`), all drawn with the shared
  buildings (`src/shaders/buildings.ts`).
- Woodland: `woodland cover` grows or clears the distant woods at their edges (50% is the original
  valley, 0 clears every wood); `pine mix` sets how many trees are tapered evergreen pines (25% by
  default). Woods are drawn as whole trees of varied size, with up to two per crown cell, ragged
  edges and clearings, over a shaded forest floor — never as a translucent overlay. Pines stay
  evergreen in autumn. Treetops raise the visible skyline and occlude what is behind them, but the
  ground's fields and lighting follow only the bare terrain, and pixels inside the treeline are
  always canopy. Unresolved distant crowns use an area-mean colour instead of per-crown detail.
- Day cycle and weather (cloud shadows sweeping over the fields): the shared clouds' lit deck by
  day, their calm deck by night and their shadows (compiled in only while `cloud shadows` is on).
- Night sky: the shared components: `stars` (density, 0.4 the original sky), the `moon`'s phase
  (full by default; it lights the land, clouds and river less as it wanes) and `shooting stars`
  (off by default, "now" on trigger 1) streaking through the gaps of the deck over the far hills.
- River: `river width` (50% the original stream) narrows it to a brook or dries it up, or widens it
  into a broad river with shingle and reed beds. It mirrors the sky as the cloud deck covers it, as
  the puddles on the tracks do (it used to mirror a cloudless sky whatever the cover: the woods'
  canopy cover shadowed the sky's under one name). `wind ripples` (0 by default: the original
  value-noise shimmer) brings in the shared water's ripples tier: cat's-paws drifting downwind break
  the mirrored sky into streaks.
- Tracks: `tracks` (0 by default: only the farm track over the near field) brings in the network,
  first the track on to the village, from 20% the valley road and a farm track over a stone bridge,
  from 40% a hill track and a chalk track up the far down, each plainer toward 100%; hedges open and
  hedgerow trees give way where they pass.
- Farm tracks: with farmsteads and tracks both on, a farm whose yard lies near the network gets a
  short straight farm track from just outside its house and barn to the nearest point of the
  nearest track, coming in as plainly as that track does as `tracks` brings it in. It keeps to its
  own bank of the river and never moves a building; it opens the hedges it crosses, hedgerow trees
  rooted on it give way, fences leave a gap and herds keep off it (their wall along it, and
  `countryRouteDistance` for every animal), as for the tracks.
- Walkers and carts (`walkers`, `carts`, off by default; the shared figures,
  `src/shaders/lib/figures.ts`) keep to the tracks in any weather: lamps lit after dark and under a
  heavy sky, wetted by rain, and under lying snow the tracks they use show trodden down through it.
- Livestock: pasture enclosures (`pasture weight`, under Fields) hold herds of cattle or sheep
  (`cattle share`, `herd size`) that graze, wander, lie down in the warm afternoon and at night and
  bunch up standing in rain and snow, each inside its fence, on the shared livestock schedule
  (`src/shaders/lib/livestock.ts`).
- Wildlife: birds crossing the valley by day (`birds`, off by default; `which birds`: mixed by the
  farming year and the hour, or one kind), the shared birds' species on the scene's own loop, and a
  starling murmuration at dusk (`murmuration`, off by default, 1500 to 5000 starlings): the
  Murmuration scene's sheet.
- Verges (`verges`, off): clumps of cow parsley, red campion and tussock grass at the foot of the
  hedges on the two near ridges, grown by the shared plant component (`country/verges.ts`), two
  slots a field border, drawn twice life size as the birds are. They sway with the wind and bow as
  the crops' gust bands reach them (the band of the field each grows into), follow the farming
  season (white umbels in summer, the parsley seeded and browning at harvest with the campion still
  flowering, no flowers in autumn), carry lying snow, keep off the lane, tracks, farm tracks, the
  river and its reeds and the farmsteads, and grow away from grazed pastures (none between two). A
  clump rooted nearer than a hedgerow tree, a building or a walker stands in front of it. Compiled
  in only while on (`COUNTRY_HAS_VERGES`, kept out of `COUNTRY_FULL`); checked by `countryVerges`.
  At the default pixel size they are a few cells tall, a sprinkle along the hedges; they read best
  at finer pixel sizes.
- Cost: every optional part (walkers and carts, the track network, hedgerow clearing, village
  growth, hamlets, farms and castle, the farm tracks, flower and pasture fields, herds and fences,
  birds and the murmuration, the chalk M, falling rain and snow, fog, wind ripples, the clouds'
  shadows, a moon below full) is compiled into the program only while its knobs are on
  (`countryFeatures`, SceneDef.featuresFor); turning one on builds that program once, the old frame
  holding meanwhile. The default program draws the same picture bit for bit at about the cost of
  the countryside before its woodland, routes, settlements and herds were added (SwiftShader,
  640×400).
- Fields: independently weight original seasonal crops, wildflowers, lavender, sunflowers and
  pasture from 0–100, through the farming year (`season`: summer, harvest, autumn). Weights are
  relative, not area percentages: crops 2, wildflowers 1, lavender 1 and the rest 0 give
  approximately half crop fields, a quarter wildflowers and a quarter lavender. All zero falls back
  to crops.
  Whole fields retain one material and the seed/layout remains fixed while weights change. The
  crop share retains its full seasonal catalogue, even when flowers dominate. Nearby plants have
  rooted stems, flower heads, spikes or leaves; distant detail resolves to field material.
- Landscape: a deterministic arrangement number changes hills, field borders and village placement
  together. Zero preserves the original view; changing weights, season or weather keeps the
  selected arrangement. Weights and landscape round-trip through URLs and saved setups. Previously
  saved `fieldType` recipes migrate on read unless any new weight is explicit; rewritten URLs contain
  only weights. Historical revision-pinned replay keeps its original controls and render.
- Presets: the original crop baseline, flower valley, lavender rows, sunflowers and mixed patchwork;
  woodland valley (autumn woods at full cover with a pine mix over grazed pasture, a buzzard
  circling) and riverside (the broad river, the whole track network with walkers and carts, cattle
  pasture, rooks and the murmuration at dusk). Their replay arrows point to the actual feature
  revision on which these setups were tuned.

## Hanging mobile

A solar system hanging in a quiet room under a glowing Sun, the room's lamp (issue #1082, N3).

- The mobile is the shared part (`src/sims/mobile.ts`) laid out by `mobile/solar.ts`: one arm per
  planet, stacked on one axis, each hung on a short link from the loop of the arm above (`end: 2`),
  so the arms are still coupled pendulums that swing and rock, each turning on its own. From the
  top: the outer bodies outermost first, then the inner ones from Mercury out; the Sun is a globe
  threaded on the axis at Mercury's loop, in the middle of the frame, so the arms radiate from it,
  the inner planets circle it close to its height and the giants' wide arms hang a little above. A
  planet rides end 0 at a reach that grows with its orbit (half its rank, half the logarithm of its
  distance), a small brass weight near the axis on end 1 balances it by the lever rule, and the
  Earth hangs from its arm's end with the Moon on a sub-arm. Each arm hangs as far below the one
  above as keeps it clear of everything above it that it passes under; `clearance` scales those
  gaps (below 1 they knock). Sizes are not to scale (radius about the 0.45 power of the real one):
  Jupiter and Saturn are clearly the biggest, Mercury and the Moon still a few cells across. The
  eye looks down on the planets' plane at about 26°, so every orbit is an ellipse round the Sun and
  planets pass in front of it and behind it.
- The shared part gained balls (globes and weights: drag along the relative air, contacts with
  other arms' balls, plates, wires and links), arms hung from a parent's loop, and a motor
  (`Mobile.drive`): a couple across an arm's ends that makes up for the damping, brings the turn to
  the set rate and winds up any turn lost (up to a full turn, then it slips like a clutch), so an
  arm keeps its rate exactly over time while gusts and knocks still set it back for a while.
- Motor (`motor`, on): each arm turns once in its planet's period, au^1.5 years (Kepler's third
  law), the Moon's once a sidereal month; the speed sets the Earth's year from 72 to 18 seconds of
  the motion clock (36 at the middle, about a minute at the default motion). The arms start spread
  round the Sun: Jupiter behind on the left, Saturn on the right, Uranus behind, Neptune in front.
- Light: the Sun (`Sun`) lights each planet from where it hangs, so phases change as the arms turn:
  full behind the Sun, a crescent in front of it. Its light (`soft shadows`: the bulb inside the
  globe, up to the whole globe) throws the mobile's shadows on the other planets (eclipses happen)
  and on the room, where they stay secondary: thrown from at least the whole globe, so they blur
  and shrink with distance, and never taking more than half the Sun's light. Saturn's rings shadow
  its globe and the wall. A dim window (`window light`) and the room's ambient keep the room and the
  night sides readable; `room` is a dark room or a white one in daylight (paper theme).
- Looks, from the shared planet (`src/shaders/lib/planet.ts`): Jupiter's and Saturn's belts in
  `planetBandColor` (Jupiter with its red spot), Venus's and Neptune's `planetBelts`, the Earth's
  oceans, land, ice caps and `planetClouds`, the rocky bodies' `planetFbm`, Saturn's tilted rings
  in `planetRingBands` (the C ring thin, the Cassini division), shadowing its globe and the wall.
  Each planet's markings keep their axis still in the room, as on a swivel.
- Knobs: planets (inner four and the Moon, drawn bigger; all eight; with Ceres and Pluto), motor,
  clearance; draft, gusts (with "now"), room air; room, Sun, soft shadows, window light; an M of
  glow-in-the-dark stars on the wall (off). Click a planet to blow on it.
- Passage: entering (2.8 s), the Sun and its mobile are lowered from above on the cord, the Sun an
  ember that lights up as they come to rest with a bob; leaving (1.5 s), the motors wind down, the
  Sun cools and the mobile is hoisted away. The lowering is a pose applied when the mobile is
  packed and the motors only slow on the way out, so the simulation at rest is untouched.
- Cost: about `pendula`'s per frame (software WebGL, 480×270, a loaded machine: medians 193–199 ms
  against 157–183 ms in the same runs; 70–160 ms for the inner set); the physics is about 50 µs a
  substep for the eight planets (75 µs with the dwarfs) at 240 substeps a second.
- Check: `mobile` (`mobile/mobile.verify.ts`): the shared GLSL against its CPU twin for plates and
  balls, the motors' periods (Mars against the Earth 1.881), planets lit on the Sun's side, and the
  picture at rest after an entrance bit for bit the one without.

## Murmuration

A sky scene whose subject is a starling murmuration.

- Simulation, by default: an authored sheet on the CPU (`flock/sim.ts`). Each bird keeps a place on
  a disc that slow sums of sines carry through the sky in 3D: stretched into a ribbon and gathered,
  bowed, cupped, bent by a travelling wave, banked and twisted, turned into depth, parted into two
  lobes and merged. Turns sweep head to tail (Attanasi et al. 2014), agitation rings run over the
  sheet (Procaccini et al. 2011), and the falcon pushes birds aside on springs. No bird reacts to
  another: the shape is choreographed.
- Emergent flight (`emergent`, off by default; its amount, 3–12, is how many neighbours each bird
  watches, 7 by default): the same birds as topological boids (`src/sims/boids.ts`). Each steers by
  separation, cohesion and alignment with its K nearest (Ballerini et al. 2008), found through a
  spatial hash whose search is bounded (at most 96 candidates) and refreshed by a third of the
  flock each step. It also cruises at the speed knob's pace, holds a level plane seen from below,
  is pulled back over the band of sky, drifts downwind and flees the falcon, and startles relay bird
  to bird as a wave. Cohesion sets the spacing and pull, chaos the noise and how weakly the birds
  align. The ink, falcon, M and passage are shared with the sheet, and switching either way hands
  the birds over where they are.
- Comparison (measured headless on a shared 12-core machine at load ~32, so absolute numbers run
  high; the modes ran interleaved, median of three runs of 1200 frames at 60 fps):

  | Birds | Sheet ms/frame (median, CPU mean) | Boids ms/frame (median, CPU mean) |
  | ----- | --------------------------------- | --------------------------------- |
  | 1500  | 0.33, 0.37                        | 0.95, 0.94                        |
  | 3000  | 0.59, 0.65                        | 1.85, 1.71                        |
  | 5000  | 1.01, 0.98                        | 3.37, 2.95                        |

  Boids that search every step instead of by turns take a median 1.9, 5.3 and 9.4 ms. Visually, the
  sheet is sculptural: a smooth veil with crisp dark folds and rims, always framed, its pace
  calm and predictable. The boids have life the sheet lacks. Birds stream through the flock, which
  wheels at the edges of its sky and knots dark as it turns. It strings into streams that part and
  rejoin, and startles visibly travel. They are grainier (clumps speckle under the dither), have no
  folds or edge-on darks (nothing banks), sometimes mill into rings, and cannot be paced.

- Decision: the authored sheet stays the default, unchanged byte for byte. It is the dependable,
  readable and cheaper silhouette a landing page needs. Emergent flight is adopted as an optional
  mode, through the lab, its URL and its reset, and `Boids` is shared for any CPU flock or school.
  The countryside flies the sheet (its FlockSetup omits `emergent`) and could name the control to
  fly boids.
- Sky at dusk; a low skyline at the bottom edge, never the focus.

## Paper marbling

Ink dropped on water, combed and swirled, as in ebru / suminagashi.

- Mathematical marbling (Lu, Jaffer, Jin, Zhao & Mao, "Mathematical Marbling", IEEE CG&A 2012):
  drops and tine strokes are closed-form deformations of the ink boundaries, so patterns stay crisp.
- Interaction: click to drop ink, drag to comb; a `pattern` choice of traditional ones (stone,
  gel-git, nonpareil, bouquet, chevron).
- Practice, inks and pattern are independent. `practice` picks how the ink is laid: ebru (a
  ground colour over the tray, then brush-flicked stones) or suminagashi (an ink brush and a water
  brush touched in turn, raising rings; an uncombed sheet is turned only by breath and a fan).
  "By inks" (the default) keeps each palette's own practice, so existing setups are unchanged;
  clicks follow the practice. The ground follows the inks, not the practice: suminagashi's sumi
  and indigo float on clear water over a pale tray, the other palettes on dark size.

## Petri dish

Gray–Scott Turing patterns or Belousov–Zhabotinsky spirals in a glass dish (`petri`).

- Regimes: `regime` holds the Turing dish at one of Pearson's classes, from the shared catalogue
  in `src/sims/grayscott.ts` (fingerprints, coral, worms, mitosis, spots, mazes, holes); "wander"
  (the default) drifts through them as before. A new regime starts a fresh dish: its labyrinth
  seed settles at the loop's start and is eased over to the regime in four chemistry seconds,
  because most classes starve a fresh seed at once, and a settled dish of one class often dies
  outright when switched to another (holes to anything sparser, mazes to coral).
- Advanced: `own feed & kill` (off by default) sets the two rates by hand, in thousandths (feed
  10–90, kill 45–70, starting at fingerprints' 37 and 60). Switching it on starts a fresh dish; the
  sliders then move the living one. Most of the map grows nothing or a solid wash.

## Slime mould

Jeff Jones's agent model of Physarum linking oat flakes on agar (`physarum`).

- Habits: sensor reach, sensor angle and evaporation act together, and three coupled settings
  read as distinct networks (lab presets rather than a knob, so the three sliders stay the only
  controls: lace, ink lace, routes and Tokyo rail routes ship as presets; woven stays a recipe, as
  its open mesh reads dim and sparse for the first minutes):
  - lace: reach 4, angle 60°, evaporation 15%. A fine, curly lace over the whole dish; the flakes
    pool gold with thin links between some of them.
  - woven: reach 9, angle 12°, evaporation 10%. Straight threads knit an even, open polygon mesh;
    pooled flakes, thin links.
  - routes: reach 18, angle 22°, evaporation 75%. A few bold trunks meeting in star-shaped
    junctions at the flakes, and almost no lace; with the Tokyo food and the rail palette, a
    transit map.
  - the default: reach 9, angle 35°, evaporation 40%. Between them: trunks over a faint lace. At
    short and middle reach, low evaporation lets the lace win and trunks barely form; a wide angle
    curls the filaments and a narrow one straightens them.

## Dunes

Wind over a sand sea.

- Ripples and dune crests migrating downwind, sand blowing off the crests, long low-sun shadows.
- A height-field simulation: Werner's slab model (saltation and avalanching), whose sand supply
  picks lone barchans, barchanoid ridges or transverse dunes.
- Clicks pour where the pointer's line of sight meets the sand as drawn (`marchHeight` with the
  shader's own march numbers, turned with the pointer parallax), or at the sandstone M's face.

## Ice and frost

- Frost crystals growing across a pane (diffusion-limited aggregation or a phase-field model),
  melting from a warm point under the pointer.
- Or a frozen lake: cracks, trapped bubbles, snow drifting across the surface (built as a scene of
  its own, `lake`).
- Built: the pane (`frost`). Behind it, the night composes the shared sky components
  (src/scenes/README.md, "Composing components"): a star knob (the cabin, away from the town's
  lights, shows 1.7x the street's stars), the moon's phase (`SKY_MOON_PHASE`: disc, halo, its light
  on the snow and in the room), an aurora (off by default) whose green lights the snow while the
  sky is open, and shooting stars (off by default, "now" on trigger 1) in the sky over the roofs.
  The snow cloud hides them all and shuts out their light; the frost's blur coarsens their detail.

## Weather: snow and rain

- Snowfall with depth layers and wind gusts, settling on edges.
- Rain on a window: drops sliding and merging, the scene behind them refracted and blurred.
- Lightning as an option (shared with the cloud scene).

## Sea shore and bioluminescent bay

- A beach at night: waves rolling in, foam lines, wet sand reflections.
- **Bioluminescence** as an option: blue glow where water is disturbed (breaking waves, the
  pointer stirring the water, fish darting).
- Day mode as an ordinary seaside scene.
- Every wave is intersected in full wherever it shows: rows of surf too far out to stand two cells
  tall take about 3% of the intersection work at the default wave size (under 10% at the smallest),
  too little to justify a cheaper path beside the near breakers.
- The open sea's wind ripples and mirror are the shared water's `mirror` tier (`rippleSpectrum`
  over four trains by the golden angle, `waterMirror`); the breakers, swash and glitter are the
  scene's own.

## Window sill

A view from inside, through an open window onto a city skyline, with a cat sitting on the sill, in
the spirit of lo-fi study streams.

- The cat as the living detail: breathing, ear twitches, tail flicks, the occasional slow blink or
  stretch; a "now" trigger for a bigger gesture (yawn, turning to look at the pointer).
- Skyline layers with parallax, windows lighting up and going dark, a time-of-day dial from dusk
  to deep night, rain on the glass or snow as options (shared with the weather layer).
- Interior hints at the frame edges: curtain stirring in the breeze, a plant or a mug on the sill,
  warm lamp light spilling onto the sill against the cool city.
- A quiet shelter needs no mode of its own: rain falling outside, a cat at peace, steam rising
  straight and a curtain barely stirring are the existing knobs
  (`restless=0.1&steam-amount=0.8&curtain-amount=0.25&rain=1&rain-amount=0.4&wind=0.05`).

## Shared options worth building once

- **Aurora** (built: `shaders/lib/aurora.ts` with `weatherKnobs({ aurora })`): curtains for ground-
  and plane-level views, their light on the land and what hides them; orbit's oval is the giant
  planet's own (`planetAurora`).
- **Lightning** (built: `shaders/lib/lightning.ts`): forked bolts and the sky-wide flash, random or
  on a "now" trigger like the meteors.
- **Weather and time of day** (built: `shaders/lib/sky.ts` and `weather.ts`, with `skyKnobs` and
  `weatherKnobs`) as a common layer across outdoor scenes.
- **Birds** (built: `shaders/lib/birds.ts` with `birdKnobs`): seven species, four formations,
  side-on, mirrored in still water or seen from below; flown by country, skyward, train, meadow,
  falls, swell, aurora, lake and lanterns, each scene giving its camera, lanes, occlusion and light.
- **Sky components** (built: stars, the Milky Way, the moon's phase, the aurora and shooting stars
  in `src/shaders/lib/`, with `skyKnobs` and, for a scene that keeps its own night,
  `skyComponentKnobs` in `src/scenes/atmosphere.ts`): each an optional knob that starts at the
  picture the scene drew before, or off. A scene composes what its sky shows in its own frame,
  behind what stands in front of it, and mirrored where its water mirrors the sky (lanterns, lake
  and aurora; glints in swell's waves). Which scene composes which: "Sky capabilities by scene" in
  `src/scenes/README.md`.
- **Clouds** (built: `src/shaders/lib/clouds.ts`, in tiers by `CLOUD_TIER`): the deck's plane and a
  calm deck (the night train's), the lit deck every sky draws, its shadows on the ground (autumn's
  optional cloud shadows, `weatherKnobs({ shadows })`) and a ray-marched sea of tops seen from above
  (the clouds scene). Which scene draws which tier, and the cloud look-alikes kept apart: "Clouds"
  in `src/scenes/README.md`.

## Lab: comparing setups and touring scenes

Two session tools sit beside the setup in the URL, never inside it, so presets and undo stay
setups and "copy link" carries both:

- **Compare** (`compare=a|b` names the slot on screen; the hidden slot's keys follow with an `a.`
  or `b.` prefix): two complete setups, each a scene with its knobs, look, motion and page. The one
  on screen is edited as usual, with its own undo. Tap `b` (or click a slot or the badge over the
  page) to flip, hold `b` to peek and let go to come back. A flip cuts without passages, so between
  two scenes the other one starts afresh: the page has one renderer and one simulation. This is not
  the source/split view, which shows one setup's picture before and after dithering. Example:
  `?scene=forest&rain=1&compare=b&a.scene=forest`.
- **Tour** (`tour=<scene>[-<seconds>].<scene>…`, `dwell=<seconds>` for the rest, 10–600, 30 by
  default): scenes played in order through their passages, starting over after the last. A step
  lasts from the switch to it to the next switch, counted on the scene clock's pace (nothing while
  paused, at most 0.1 s per frame), so a slow machine still gives a growing scene its time. `t`
  plays or pauses, `[` and `]` step along it while it plays, and choosing a scene off the tour
  pauses it. A tour link plays as it opens, except under reduced motion, where it waits for play
  and cuts. Example: `?mode=bare&tour=physarum-60.petri-45.delta-60.frost-45`.
