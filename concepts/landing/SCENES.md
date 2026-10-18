# Scene backlog

The lab's scenes, one row each in the tables below: the first three (orbit, swell, pond) and the
ideas that followed them. Each is a dithered shader scene: animated, tweakable in the lab, with a
standalone Manifold landmark that fits the scene. How to write one: `src/scenes/README.md`.

## Status

The first three and all of the ideas below have a first implementation in the lab:

| Idea                             | Scene id  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Planet in orbit                  | `orbit`   | The shared giant planet as the subject (`shaders/lib/planet.ts`, hero tier), every feature a knob: clouds, storms, aurora, city lights, a day cycle, moons and the banded ring system. Behind it real constellations (with figure lines), shooting stars, captured meteors, a nebula and a drifting starfield; the M as night-side city lights or an asterism.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Moonlit swell                    | `swell`   | A preset of the `outdoor` composer (ADR 0062 Phase 2c), four layers locked to its rig: the `openSea` backdrop (the World's sky over the sea, the M in the moon's seas, rain shafts, the moonlit air, the ink over a black point), the `swell` ground (two long Gerstner swells, three trains of wind sea and the chop, raised and turned by the wind and breaking white in a gale, mirroring the sky, the headland and the boats, the moon's glitter path in flecks, the crests glowing blue where the moon shines through; flat or, with `relief`, standing up near by), the `boats` (dressing: at anchor in the path, riding the same waves, `boatsLanterns` by night) and the `lighthouse` (dressing: a headland whose beams sweep the air over the fog, lit cones in fog and rain). The World's sky, weather and gulls, all mirrored in the sea; agents visit the boats and the lamp.                                 |
| Koi pond                         | `pond`    | Koi seen from above, drawn with the shared fish (`sims/fish.ts`) and steered by it while drawn to the pointer; lily pads, ripples, five floor beds, water weeds, caustics (the shared water's caustics tier, "Pond water") and god rays. The border plants are the shared plant component ("Pond plants"); optional: a canopy, a current carrying petals and a paper boat, a manifold stone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Above the clouds                 | `clouds`  | Aurora and lightning come from the shared weather layer. The sea of cloud below is the shared clouds' volume tier (`cloudSeaMarch`, `CLOUD_TIER` volume); the stars over it are the shared stars control.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Waterfall                        | `falls`   | A preset of the outdoor composer (`src/composer`), five layers: the `cliff` (gorge choice: basalt flows by default, sandstone ledges, or a pale limestone slot whose walls close in; the carved M), the plunge `pool` (its fireflies and the near bank), the `falls`, the `spray` with its rainbow, and the `greenery` (moss and ferns). The shared world's whole atmosphere (world layers) over the rim, seen half turned: a stars control, the moon's phase, an aurora whose arc is lifted to show its lower edge over the rim, shooting stars that fall behind it, the deck the rain brings down, lightning; swifts by day (off) behind the cliff they fly beyond; fog, rain and snow by depth.                                                                                                                                                                                                                        |
| Countryside                      | `country` | A preset of the `outdoor` composer (ADR 0062 Phase 2c), eight layers: the `valley` (the land carved by running water on one terrain map, `src/sims/terrain.ts`, its sim in four field slots; the far ridges over the World's sky; the valley fog on the World's fog knob), the `waterway`, the `farmland` (every parcel given one use by the land model, `src/sims/landuse.ts`: crops, wildflowers, lavender, sunflowers, pasture, woodland, or open grassland, by relative shares; the chalk M), the `settlements` (village, hamlets, farms, castle, roads over a bridge), the `verges`, the `herds`, the `travellers` (walkers and carts) and the `starlings`. The World's sky, rain, snow and birds replace its own (D10). Its optional parts are compiled in only while their knobs are on (`featuresFor`). The `valley` is offered to the bees garden too ("Bees · in the valley").                                  |
| Murmuration                      | `flock`   | A preset of the `outdoor` composer (ADR 0062 Phase 2c): the `roost` backdrop (the World's sky with the afterglow as the accent; the `skyline`, rooftops, a reed bed on still water or the sea under a headland, only the one shown compiled in; the water mirroring the sky's dome and its cloud deck; the reeds swaying in the wind) and the `murmuration` (life: the authored deforming sheet on the CPU, or emergent topological boids, `Boids`; its density in a field slot, its falcon and M in the records atlas), which every level rig with enough sky offers (the meadow, the bees' garden, the shore, the waterfall). The shared world's atmosphere: the stars after dusk, the moon's phase, aurora and shooting stars, cloud, rain and snow in front of the flock, fog, birds by day.                                                                                                                          |
| Paper marbling                   | `marble`  | Mathematical marbling engine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Dunes                            | `dunes`   | Werner slab model. A preset of the `outdoor` composer (ADR 0062 Phase 2a): the `desert` backdrop (the dune sea under its dust, the World's fog taken over as that dust and a sandstorm in a hard wind, heat shimmer bending every ray, mirage) and the `dunes` ground (the live field in two field slots, its ripples and blowing sand, the sandstone M as `dunesMark`, the pour under every hand); the view from overhead (`camera=1`) stays a program of the dunes' own until the overhead composer's `dunesabove`. The shared world's atmosphere (world layers): cloud and its shadows on the sand, stars (a dark desert sky), the Milky Way, the moon's phase (which lights the sand), aurora and shooting stars behind the clouds and the dust, lightning, a buzzard by day behind nearer dunes, rain and snow by depth (overhead, as a tilted camera sees them); rain darkens and stills the sand, snow lies on it. |
| Ice and frost                    | `frost`   | Frost on a window pane; snowfall from the weather layer; the world's sky (`worldSky`: the snow cloud, stars, moon phase, aurora, shooting stars) in the window, softened by the frost.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Snow and rain                    | merged    | Part of the shared weather layer, not a scene: rain, snow, rain on glass, ripples, fog.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Sea shore and bioluminescent bay | `shore`   | A preset of the `outdoor` composer (ADR 0062 Phase 2a): the `sea` backdrop (its sky staging, the surf, the hands' wake in the plankton), the `beach` ground (the wet sand and the M drawn in it), the agents' `cairns` (a chore) and a school of `fish` (life). The shared world's atmosphere (world layers): cloud and its shadows, stars, the Milky Way, the moon's phase, aurora and shooting stars behind the clouds, all mirrored in the sea and the wet sand; gulls by day, dipping behind breakers nearer than them and mirrored in the wet sand; fog, rain and snow by depth (snow lying on the dry sand); lightning out of the sea's storm bank.                                                                                                                                                                                                                                                                 |
| Window sill                      | `sill`    | The world's sky over the city (`worldSky`): a stars control, the moon's phase, an aurora whose light comes in through the window, shooting stars and lightning, all behind the cloud deck the rain brings down, under the city's glow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

The shared options became libraries every outdoor scene can use, compiled into every program: sky
and time of day (stars, the moon's phase, shooting stars), clouds in tiers (a calm deck, the lit
deck, its shadows, a sea of tops seen from above), weather, lightning, aurora, the weather under a
closed canopy and water in tiers (`src/shaders/lib/`), with shared lab knobs
(`src/scenes/atmosphere.ts`). Others are opt-in, included only by the scenes that draw them: the
giant ringed planet (`src/shaders/lib/planet.ts`, knobs `src/scenes/planet.ts`), which `orbit`
draws as its subject with every feature (belts, clouds, storms, aurora, city lights, day cycle,
banded rings, moons) and `campfire` as scenery over its pines, and whose body tier hangs an open
list of planets (up to eight, nine kinds, fixed among the stars or orbiting our world;
`src/scenes/planets.ts`, one `planets` URL key) in sixteen night skies; the Milky Way
(`src/shaders/lib/milkyway.ts`), over `campfire` and `lake`; the birds (`src/shaders/lib/birds.ts`);
the rooted plants (`src/sims/plants.ts`, `src/shaders/lib/plants.ts`, knobs `src/scenes/plants.ts`);
and the countryside's figures, livestock and buildings. Which scene composes which: "Composing
components" in `src/scenes/README.md`. The sections after the tables keep the original briefs, with
notes on what was built.

Every sky reads one world clock (`src/world-clock.ts`, its GLSL in the sky library): the staged
low-latitude sky by default, a sun whose height follows the date in the scenes whose season sets
their climate (country, garden), a moon standing as far from the sun as its phase needs, and stars
that turn about the pole while the days pass; the year's cold is one model (`src/climate.ts`).

## Zen batch

A second batch of calm scenes whose subject is a simulation, from grounded scenery to pure
mathematics. All have a first implementation in the lab:

| Idea                                         | Scene id     | Simulation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Shared engine                                                                                   |
| -------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Dry stone garden (karesansui)                | `garden`     | An `outdoor` composer preset of six layers: the raked gravel's height field round islands of stones and moss (`gravel`, two field slots), kept by an unseen rake and every hand (the `raking` chore); falling-plate maple leaves in the composer's gust field (`boughs`); the woods over the wall and an optional border at its foot, rooted plants on the records atlas (`templeWoods`, `border`); fresh gravel dries on an `AgeField` clock; the World's rain at the composed depth                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `HeightField`, `AgeField`, `FlutterPlates`, `RootedPlants`, composer layers, world layers       |
| Bamboo grove and water clock (shishi-odoshi) | `bamboo`     | An `outdoor` composer preset of five layers on its own rig: damped culm springs bowing in the composer's one gust field (stems brushed by any hand, a press's breath of wind), leaves letting go, a tipping tube whose moss pad softens the knock for a quiet clock, a stone lantern lighting every layer; the canopy's own weather (its rain cloud, rays and drips) over the World's sky in its gaps, half the World's rain kept off under it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `grove`, `groveFloor`, `culms`, `stoneLantern`, `clock` layers, `canopyGroveGlsl`, world layers |
| Lantern river (tōrō nagashi)                 | `lanterns`   | An `outdoor` composer preset of three layers: lanterns in potential flow round stones, eddies, soft contacts, stones and deep overlaps settled after each step, their light on other layers; the river mirroring the temple grounds and the World's sky (`composerMirror`), its ripples riding the current; the World's weather and birds (geese over the far bank, mirrored), the rain's deck in the river's warm grey                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `temple`, `river`, `lanterns` layers, `separateDiscs`, water `flow` tier, world layers          |
| Synchronous fireflies                        | `fireflies`  | A preset of the `outdoor` composer (`src/composer`), three layers rig-locked to its river: the `mangroves` (backdrop: the bank's rooted plants, dense crowns or an open bank, bowing to the breeze the composer's gusts send across now and then, "Fireflies mangroves"; the bank's skyglow staged on the World's night in place of its dome), the `creek` (ground: the still river mirroring them through `composerMirror`, its swells, a gust's catspaw, the rain dulling it, the mist) and the `fireflySwarm` (life: pulse-coupled oscillators on a lattice in the crowns, each pulse a wave or, with `unison` (frequency adaptation), one flash, at one population on either bank; the lights nearer than the bank in the world in front of the eye; the pointer's lantern; the M; every light two-state in its `shade` pass, its glow and the lantern lighting every other layer). The shared world's atmosphere: a moonless night by default, the stars control, shooting stars over the trees, rain veiling the fireflies, fog, snow, swifts by day | `outdoor` composer, `LevelCamera`, `RootedPlants`, world layers                                 |
| Kelp forest                                  | `kelp`       | Buoyant Verlet stipes in surge: giant kelp, or bull kelp held up by one gas bulb (or a mix); boids school                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `VerletSystem`, `fishGlsl`                                                                      |
| Spider web at dawn                           | `dew`        | A preset of the `outdoor` composer (ADR 0062 Phase 2c), two layers locked to its macro rig: the `bokeh` backdrop (the meadow, the hedge and the World's sky far out of focus, wet and snowed on by the World) and the `web` dressing (Verlet orb web, dew drops creeping and falling, the spider and her M as `webMark`; paged bin lists keep the dense hub whole); the World's fog, rain and snow at the composed depth                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `VerletSystem`, `BinLists`                                                                      |
| Meadow in the wind (honami)                  | `meadow`     | Gust fronts shared by shader and sim, dandelion seeds carried in the world along the gust direction; the shared world's whole atmosphere: cloud and its shadows, stars, the Milky Way, the moon's phase, aurora and shooting stars behind the clouds, lightning behind the hills, swallows by day behind the grass nearer than them, fog, rain and snow by depth (snow settling on the grass)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `LevelCamera`, world layers                                                                     |
| Ink-wash landscape scroll (shan shui)        | `shanshui`   | Procedural handscroll, drifting mist, four seasons' washes; painted in sections joined by mounting silk so days of unrolling stay precise                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |                                                                                                 |
| Incense smoke                                | `incense`    | Buoyant smoke, laminar to turbulent; a ceiling vent draws the layered veils off without bending the thread                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `FluidSim`, `FieldBetween`                                                                      |
| Sand table                                   | `sandtable`  | Theta–rho ball and sand pendulum on a height field; the relief is re-sent every frame while a machine outruns it, so a groove's head stays under the ball                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `HeightField`                                                                                   |
| Chladni plate                                | `chladni`    | Sand grains drifting to the nodal lines of plate modes; grain size from fine sand (thin, crisp lines, slow to gather, and at the very end powder heaping at the antinodes: Faraday's inverse figures) to grit (broad, rough, steep ridges, quick)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `grainAt`                                                                                       |
| Ferrofluid                                   | `ferro`      | Rosensweig spike lattice (subcritical: spikes pop up late and linger as the field falls), sloshing blob                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |                                                                                                 |
| Soap film                                    | `film`       | Thin-film interference, gravity drainage, pops whose rim crosses the film from the break in least time                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `FluidSim`, `ArrivalField`                                                                      |
| Pearlescent fluid (rheoscopic)               | `pearl`      | Flake orientation advected and turned by the flow                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `FluidSim`, `FieldBetween`                                                                      |
| Petri dish                                   | `petri`      | Gray–Scott Turing patterns, Barkley BZ spirals                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `GpuCompute`, `grayScottRegimes`                                                                |
| Slime mould network (Physarum)               | `physarum`   | Jones agents over Tero's adaptive flow network linking oat flakes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `GpuCompute`                                                                                    |
| Hyperbolic tiling                            | `hyperbolic` | Möbius glide over a {p,q} weave; drags re-grip when the map or screen shape changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |                                                                                                 |
| River delta from above                       | `delta`      | Shallow water erosion and deposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `ShallowWater`, `GpuCompute`                                                                    |
| Fractals                                     | `fractal`    | Julia walk, Mandelbrot dive, Apollonian gasket, Newton garden; drag pan tethered to the frame                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `ElasticPan`                                                                                    |
| Prism                                        | `prism`      | Dispersion through glass, total internal reflection; Newton's recombination by a second prism that slides in along the fan and steps back when the first turns into it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |                                                                                                 |

## Slices of life and more

A third batch built on the shared foundations (weather in the world, hard edges, the GPU and CPU sims):

| Idea                       | Scene id | Simulation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Late-night bar             | `bar`    | Patrons arrive, sip and leave; the bartender pours, shakes, polishes; rain and traffic outside the window. Last call (the time-of-night "now"): a hand bell and two blinks of the lamps (just the blinks with the bartender off), last sips, one for the road or a word with you if the bar is empty, then closing time until the time of night is moved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| City crossing at dusk      | `street` | A preset of the `outdoor` composer (ADR 0062 Phase 2c) through the street's own rig, a window pitched down at the crossing: the `city` backdrop (the blocks, signs and awnings, the shops' light, the skyline and the World's sky as the passage raises the view), the `crossing` ground (road, sidewalks, zebras and their M, the wet street's mirror and streaks), the `kerbside` (lamps and the vending machines' glow as declared lights, signals) and `streetLife`: social-force walkers, intelligent-driver traffic, a signal cycle with a scramble; walkers step round the poles at the kerb, none stands pinned and none is seen to vanish, cars keep out of a blocked junction and turn behind the cyclists, and a cyclist waits behind the parked delivery van while a car comes along or onto the next lane (`street/sim.test.ts`); umbrellas open in the rain; optional late delivery. The World's rain and snow fall along paths that close in below the street (`precip.seen`, `rainFallSeen`, `snowFallSeen`); the stars and the moon's phase in the window glass and the wet street |
| Night train window         | `train`  | A journey with stations, level crossings, bridges and tunnels; tea rings at every rail joint; everything that moves with the motion clock (clouds, lamps, flashers, station clock, the carriage's rock) keeps its phase when Motion changes. A `line` choice sets the country and its timetable together: country (as always), rural (low farmland, frequent halts with a crossing at the platform's end, crossings everywhere, short stream bridges, no tunnels, slower) or mountain (high hills and peaks, long tunnels chained over stone viaducts across deep gorges, few stations or crossings, slower still); the shared stars and moon phase are knobs, the cloud deck is the shared clouds' calm deck (`CLOUD_TIER` flat), and the shared birds (off by default) fly the line's own kinds by day                                                                                                                                                                                                                                                                                            |
| Mystic forest              | `forest` | A preset of the `outdoor` composer (ADR 0062 Phase 2b), five layers on its own rig with its dolly as the rig's passage: the `woods` backdrop (the mist and its shafts, the canopy with the World's sky in its gaps, three rows of far trunks, the canopy's drips; a shelter claim keeping 55 % of the World's drops off), the `forestFloor` ground (moss, litter, the stream and its stepping stones), the `shrine` (torii, log, beech, boulders, the great cedar, the mushrooms, the root M as `shrineMark`), the `undergrowth` ferns (in the composer's one gust field) and the `kodama` life: spirits appearing and turning their heads, curious of the pointer or (a tunable share) shy of it and ducking into the moss (`sims/temperament.ts`); spores on curl-noise air carrying the mist's banks, a stag crossing. The canopy's weather and grove (`shaders/lib/canopy.ts`, as bamboo's) close the sky over the leaves in the World's rain; the World's stars, moon's phase, shooting stars, aurora and lightning in the gaps; fog, rain and snow at the composed depth                      |
| Ripple tank                | `ripple` | GPU wave equation: interference, double slit, lens, Doppler, standing waves; projected caustics; edge absorption from beaches that swallow every wave to bare walls that reflect them, apart from open-water damping                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Lava lamp                  | `lava`   | Heated wax blobs with buoyancy, necks and merging; a wax body from silky (smaller blobs slipping through each other, long tails, smooth merges) to chunky (fewer, slower, knobbly lumps)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Frozen lake                | `lake`   | A preset of the `outdoor` composer (layers `farShore`, `lake`): aurora mirrored in black ice (`composerMirror`), singing cracks, drifting snow, frozen bubbles; lying snow from wind-packed crust to fresh powder at the same cover; the crack and snow fields laid out as the eye at rest sees the ice (`LevelCamera`). Or, as its place, the fjord (`aurora`, merged in): open water under mountains, freezing over in plates, streaked by cat's-paws (the water's `ripples` tier), a red cabin among birches. One night of its own over both (D10: its hour, our moon), staged on the World: the shared aurora on its substorm clock or the slow drapes and their corona, the shared Milky Way, shooting stars and geese, mirrored; the World's rain, snow and fog at the composed depth                                                                                                                                                                                                                                                                                                         |
| Bonsai through the seasons | `bonsai` | Space-colonisation growth, cloud pads on springs, leaf fall, snow, pruning; with the breeze off the pads hang still until a gust, snip or hover                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Quiet places and small machines

A fourth batch, after the cosy-game mood (gentle, warm, unhurried) rather than any game's look:

| Idea                           | Scene id       | Simulation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harmonograph                   | `harmonograph` | Damped, slightly detuned pendulums drive a pen; the figure precesses and spirals inward, then a fresh sheet slides in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Campfire under a ringed planet | `campfire`     | A preset of the `outdoor` composer (ADR 0062 Phase 2b): the `pines` backdrop, the `clearing` ground, the `camp` (tent and pack) and the `campfire` (the subject: licking flame tongues, a toasting marshmallow, the log bench and its M; its light falls on every other layer), with `smoke` and `sparks` as life. Optional burning down (`FuelBed`, `src/sims/fuel.ts`, in the records atlas): logs catch, char, thin, slump and crumble to embers, tended or left to go out. Over the clearing the World: its stars, the Milky Way, shooting stars, fog, rain and snow at the composed depth; the giant planet is the first of the World's planets the preset opens with (moons, aurora, city lights and its own day cycle as that planet's fields)                                                                                                                                                                                                                                                                                                                                              |
| Pendulum wave                  | `pendula`      | Exact small-angle pendulums with lengths for N + n swings per cycle: waves, helices, chaos, realignment; or real ones, released by a board and slowed by their own wide swing (`sims/pendulum.ts`), drifting off the realignment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A small island                 | `island`       | Raymarched island with surf, cloud shadows, a gull and weather; rain and snow seen from above both converge below the sea (`rainFallSeen`, `snowFallSeen` through one `islVanish`); the sea is the shared water's `mirror` tier (four hand-placed ripple trains, as ruffled as the wind blows)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Aurora over a fjord            | merged         | The lake's fjord (`setting`) under the lake's slow drapes (`drapes`): draped ribbons with rays and a corona, mirrored in still water or ice, broken into streaks by drifting cat's-paws with the wind ripples knob, a red cabin among birches, falling and lying snow, birds and shooting stars in the water                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Summer apiary                  | `bees`         | A hillside garden of hives, lavender, foxgloves and orchard; its insects are specks flying in its world through its eye (`LevelCamera`), each dither cell its nearest one (`SpeckMap`), lit by the world's light and seen through its fog and rain: up to 200 bees (beelines, crowds at the entrances, a few pollen-drunk foragers looping and bumping their way home, a swarm hanging in an apple tree), butterflies, bumblebees climbing the foxgloves, hoverflies, a dragonfly, glow-worms in the grass after dusk (fireflies as an option), all keeping the world clock's hours and sheltering from rain. The shared world over the valley: its painted cumulus towers and their shadows, moonlight, rain, snow, fog, swallows. With the lab's agents about, the `gardening` chore (on by default): they dig beds in the lawn and sow them (`gardening.ts`, on the apiary's beds, `beds.ts`), seedlings grow into poppies, daisies, cosmos and wild flowers over a minute or two and the bees go to them, weeds creep back until weeded or the lawn takes the bed back; no beds without agents |
| Looking up at the city         | `skyward`      | A preset of the `outdoor` composer (ADR 0062 Phase 2c), its rig lying on the road and pitched up toward the zenith: the `crossroads` backdrop (facades converging on the zenith, planes and contrails beyond the World's deck, pigeons and swifts on the World's birds knobs, the shared birds seen from below, the banner and its M), the `streetTree` and the `tramway` (wires, trams, lamps, gantry) as dressings. In its strip of sky the World's (`worldSky`, looking up): the stars, the moon's phase, the planets, shooting stars, the deck and lightning; its rain streams out of the zenith, its snow too with "snow from overhead", through the camera's own axes (`worldPrecipAxes`), and its fog is laid along each ray at its true height                                                                                                                                                                                                                                                                                                                                             |
| Autumn park                    | `autumn`       | A preset of the `outdoor` composer (layers `parkland`, `parkPath`, `lamp`, `maple`, `litter`, `rake`): leaves flutter and tumble down (the shared plate model `sims/flutter.ts`), build a carpet (the two-layer ground-litter lattice `sims/litter.ts`), and the composer's one gust field sways the canopy, shakes showers loose and lifts swirls of the top leaves off the path; agents rake them into piles. Over the park the World: a stars control, the moon's phase (which sets the night light), an aurora and shooting stars behind the clouds, optional cloud shadows sweeping the park (the shared clouds' `shadows` tier), rain and fog at the composed depth                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Tide pool                      | `tidepool`     | GPU shallow water (`ShallowWater`, `sims/shallow.ts`) over a rock pool seen from straight above: the swell shoals, breaks over the reefs and in the sets pours through the notch in the basin's rim; anemones close in the surge, kelp and surfgrass stream as rooted plants, optional rock pool fish dart from a touch; the caustics are the shared water's caustics tier. A prototype: see "Tide pool"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Hanging mobile                 | `mobile`       | A solar system on balanced arms stacked under a glowing Sun: coupled Verlet pendulums with balls, motors at the planets' real periods (Kepler's third law), ball drag in drafts, gusts and eddies, contacts, the Sun lighting each planet and throwing the mobile's shadows (Saturn's rings included) on the wall                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Rain everywhere falls at terminal speed in real time, along the world's vertical as each scene's
camera sees it, whatever the calm of the rest of the scene: straight down the frame under a level
camera (`rainFall`), toward a vanishing point under a tilted one (`rainFallSeen`: tidepool, skyward,
street, island, dunes overhead). Snow does the same where the camera tilts (`snowFallSeen`: skyward
looking up, street, island and dunes overhead looking down).

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
the coarsest pixel sizes) they fade to an even glow instead of flickering. The drop rings stay the
pond's own, as wave trains with an analytic slope. The floor is seen through that slope: a quarter
of the water's depth times it (refraction into water at small slopes, as the caustics take it), so
deeper water (`depth`) bends the floor further, whatever the pixel size; rings finer than 7 to 14
cells a wavelength are not drawn but roughen the surface instead. Their crests run through each ring
at the phase speed of ripples that long, twice the speed the ring spreads at, each born at its
inside and dying at its front. The sun's glint is the shared glint (`waterGlint`), seen from above
with the sun where its image falls (`sunX`, `sunY`): the rings tilt it, the breeze (`wind`) and the
rings too fine to draw spread it, the sun's `intensity` exposes it, and it lies on open water only.
Where the pads, the koi on their loops and the petals are is the same for every pixel:
a layout pass works it out once a frame on the GPU (`layout.ts`, read as `uSim3`) with the shader's
own functions, so the picture is the same as working it out per pixel, which the shader still does
where float render targets are missing.

## Tide pool

`tidepool`: a rock pool on a basalt platform, seen from straight above, with the open sea along the
top. Prototype (issue #1082, N1), built from shared parts rather than scene code:

- **Water:** `ShallowWater` (`src/sims/shallow.ts`), GPU shallow water over a bed (a well-balanced
  finite volume scheme, bores at their true speed and depth; the delta's river runs on it too), here
  at second order (MUSCL–Hancock), so the swell arrives as tall at every wave length. A
  wave maker in the top band forces both the swell's level and its flow, so waves run in one way and
  reflections are soaked up; they shoal, break over the reefs, run up the rock and, in the sets,
  pour through the notch in the basin's rim. The basin keeps what comes over and spills back to its
  sill. `stillWater` (priority flood) opens every layout settled: the basin and potholes full to
  their spill points.
- **Response:** the water carries foam (made where the flow nears or outruns its own waves),
  agitation (a hard surge or a touch closes the anemones; they reopen over ~10 s) and wetness (rock
  drying over half a minute). Kelp and surfgrass stream and flutter with the flow at their
  holdfasts; anemones lean with it and close when the water leaves them.
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

Since the outdoor composer (ADR 0062 Phase 2b) the bank is the `mangroves` backdrop's sim, lent to
the `fireflySwarm`'s through `LayerFrame.host` (`MangroveBank`), and the breeze is the composer's
gusts: on with `gusts` (its strength scales the detuning and the trees' push, 1 at the default
0.7), as often as `gustRate` (0.3 in the preset, the old `unrest`'s frequency), "now" the gusts'.
It is still one front of its own crossing the bank, not the gust field's trains, so the swarm keeps
its long calms to fall into step in; the shooting stars and the stars are the World's.

## Garden woods and border

`garden`'s woods over the wall (its `templeWoods` layer's records) are grown by the shared plant
component (issue #1082 M11): every crown of both rows is a tree, one stem from behind the wall up
to the crown tops, and the shader draws its old silhouette for each crown where its stem's tip
carries it. In still air (wind 0, no gust about) the woods are exactly the old picture. Visible
difference, the only one by default: in a breeze the crowns lean downwind and stir crown by crown
(about a cell's lean at the default wind, 540 cells high); the composer's one gust field (`gusts`,
off in the preset, and its "now") bows them where its fronts cross them, and the exit's flurry
crosses them as a front from the garden's upwind end, the trees bowing one after another and
swinging back; once the air has been still for six seconds they stand exactly as laid out again.
New, off: a border planting (the `border` layer, its fullness, with the plants' `borderGrowth`),
clumps of shield fern and mondo grass in the gutter at the wall's foot, swaying with the wind and
the gusts and following the season choice (pale young fronds in spring, ferns turning gold in
autumn and half of them gone in winter, the evergreen grass dulling, snow on them); from above they
lie out toward the gravel. The maple, moss, rake, leaves and drying are unchanged.

## Garden climate

`garden`'s season (the composer's `season`, the garden's choice of four) sets its climate
(`src/climate.ts`): in winter snow lies on the stones, the moss and the wall with none falling
(deep winter's own, from the renderer's `uWeather.y`, as in every scene's winter), the rain comes
down as snow, and the snow switch falls in any season, where the lab marks it out of season. Under
winter's rain the page stays as light as under a snowfall. Spring, summer and autumn draw exactly
as before without weather, and so does winter without rain; what falls is the World's
(`gardenClimate` check: winter's rain draws byte for byte as the same snow falling, and no snow
lies but `uWeather.y`'s).

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
- The near bank's ferns are rooted plants of the shared component (`falls/sim.ts`, the `greenery`
  layer's records): the same clumps and fronds, each frond bending on its own spring under the
  wind, the fall's stir and the composer's one gust field (`gusts`, off in the preset), turning and
  shedding with the year (`season`, off), replaced with `growth` (off). The ledge ferns draw the
  same shared frond (`plantFrond`) from hashes, unchanged.
- Gorges (`gorge`): the layered forms share one bedding model with different beds, dip, folds,
  ledges and stone: basalt flows on rusty ash (the default), or thin, level sandstone ledges on
  shale, cross-bedded. The pale limestone slot is a different form: a few thick, flush beds fluted
  by runnels, split by through-going joints, streaked dark under the lips and crusted with tufa by
  the water, and two side walls running from the back wall toward the eye (unrolled from it, their
  beds converging on the vanishing point), mirrored in the pool, shading the slot's floor and
  leaving a strip of sky over the fall.

## Countryside

`country`: a river valley seen from a hill at its corner, on one coherent terrain map (issue #1082
C1: the countryside on one land model; it replaced the layered-ridge Countryside, whose setups
replay at their pinned commits).

- **Terrain** (`src/sims/terrain.ts`, `TerrainBuilder`): a 3.2 km map at 512² texels (erosion at
  256²), deterministic per seed (its distances by `hypot2`/`hypot3` and its headings by `atan2`,
  V8's `Math.hypot` and `Math.atan2` bit for bit in any engine: each engine rounds its own
  differently, which moved seed 0's river and farms in Safari and turned buildings by up to 8 ulps;
  `country/engines.test.ts` builds three landscapes in JavaScriptCore and V8 and compares every
  part) and built on the page's build worker (`src/sims/build.ts`), packed and its land model
  weighed there too, its arrays handed back by transfer, so a knob change never stalls the page:
  the last map stays up until the new one lands, a newer change drops a build in progress (and so
  does the map on screen asked for again, building nothing), and the result is byte for byte the
  page's own (`build-worker.test.ts`, seeds 0-3). Without a worker it builds on the page in units
  a frame's budget spreads (a share of the time between frames, so a software renderer builds in
  as few frames as a GPU). Relief: a valley axis laid across the view, long rolling slopes below
  the vantage, hills beyond, fractal and ridged value noise; implicit stream-power erosion over a
  priority-flood drainage, thermal slumping. The
  river: the drainage tree's main path, meandering on gentle ground, widening with its catchment,
  its level the ground's running minimum smoothed (never rising), carved with a bed, banks and a
  floodplain. Streams; settlements scored for flatness, water, distance and a clear line of sight,
  on the land before the river is carved and against its course (off the largest river's
  floodplain, its meanders' widest sway included), so the river's size moves none of them;
  roads (A\* over slope, curvature, floodplain and fords, water impassable) over a spanning tree
  with a shortcut and a way out, farm tracks to the farms and down the near field, one bridge at the
  narrowest crossing, cut and fill no steeper than one in eight; buildings on terraces; the woods'
  clearance field; land parcels aligned to the contours and roads; lone trees on hedges and banks.
  Base relief (`land shape`): valley, coast, plateau or rolling hills.
- **Land use** (`src/sims/landuse.ts`): the woods are a layer of their own, the wildwood the fields
  were cleared from: they stand wherever the clearance field (`Terrain.clearance`, on the bare land:
  steep, high, remote ground last, shaws along streams, copses and lobes, never steeper than
  `TERRAIN_CLEARANCE_SLOPE`) lies above the woods' line, the clearance at the area quantile
  `woodland / Σ shares` takes; a parcel whose cell on the bare land they cover 70% of is a wood
  (so no road or yard that reshapes it turns it), and a field they reach into keeps its use (an
  assart). The shader thresholds the field itself (`countryWoods`), so a woodland drag writes one
  value and the few parcels crossing 70%, and a wood's edge is smooth at any distance; raising the
  share only lets the woods grow outward; no rule of the view's keeps them off the vantage's
  slopes. Every other parcel is one land unit with one field use. Each use weighs every parcel by
  its ground (slope, height, wetness, aspect to the sun, how near the settlements and roads lie, a
  seeded jitter) and each parcel takes the use bidding most for it, its score plus the price
  `ln(share)`. A use's price is its own share's alone, so raising one share converts only that
  use's marginal parcels (the best suited next) and moves nothing between other uses (it may only
  push the woods back); the same seed and settings give the same land. Area shares meet the
  normalised shares within a few points, the woods' within one (correlated ground biases the
  fields', the woods taking the ground lavender and the wildflowers like; `landuse.test.ts` bounds
  it). Shares all off leave open grassland; woodland alone takes all the land. Crops pick their
  kind (wheat, barley, grazing, hay, ploughed, rapeseed) by their ground; pastures their herd
  (`cattle share`, a share of the grazing land: cattle where a pasture's fixed cattle rank, low,
  flat, wet ground first, lies under it, so no share step flips a pasture that stays one); woods
  their species (`pine mix`: pine on high, steep, north-facing ground, each parcel's woods keeping
  their species as the woods grow). A change of the uses re-runs only the allocation and re-packs
  the records, and of the cover and parcel map only the parcels it moves (`repackLand`, byte for
  byte the whole land's packing), uploading only the rows whose bytes changed (`countryTerrain`;
  `country/sim.test.ts`), no rebuild.
  Stable under edits (issue #1082 S1, P1): each parcel is weighed and ranked by its cell on the bare
  land (`TerrainBare`: the ground as the river and streams left it, each site at its own heading as
  though no road turned it) and by every candidate settlement site (`Terrain.candidates`, built or
  not, at its nominal radius); only its nearness to the roads as laid moves its score, along that
  fixed ranking. So a village grown changes no land at all, and a settlement, road or track
  switched changes it only beside the ways that move (within 150 m of them, or a parcel they pass
  within 64 m of); the network itself still re-routes far from a toggled castle, hamlet or farm
  (up to 2.4 km on seeds 0-3), which P8's stable network takes on. A new `river` size moves no
  settlement and drops or keeps only the parcel sites in the water between the two sizes, and each
  parcel's seeded draws (jitter, crop, herd, species, its shape) are hashes of its place, not its
  index: a nudge from 0.5 to 0.55 changes 1.6-3.1% of the land on seeds 0-3, at most 0.45% of it
  beyond 400 m of the river (seeds 0-1 with the woods' layer: a few parcels whose bids were all but
  tied, and wood edges the woods' line moves by its riverside quantiles, nudged by the ranks they
  share with the riverside ones; 23-29% and 14-19% while the settlements were weighed against the
  carved river and the draws keyed by index), and the ways re-route within some 900 m of it.
- **Rendering** (`src/shaders/lib/terrain.ts`, `country/shader.ts`): a height-field march (ground,
  water and the trees' bounds; up to 224 steps, the shortest step growing after the 176th so the
  shortest steps alone carry any ray past the farthest look: rays grazing the land reach the far
  hills under the skyline rather than stopping in the air, for every land shape and landscape; a
  rising ray let go above the map's highest ground and trees, `terrainTop`; the crossing refined
  by two regula-falsi steps) with a soft sun-shadow march; buildings, walkers, carts, herds and the
  verges' clumps placed
  through the same pinhole as the march's rays (`country/camera.ts`); each parcel drawn from its
  record (crops of its kind, the shared flower materials, a pasture's grass, fence and herd, a
  wood's floor, open grassland) with exact borders between texels, hedges (half a cell at least)
  only where a farmed parcel meets another; roads likewise; the river mirroring the sky and its
  deck, a stone bridge, far ridges in the sky, the shared sky, clouds (and their shadows), rain,
  snow, wetness, lying snow and the valley fog (below). Past the map's edge, out to the farthest
  look, a ring of hills (`countryRing`: the edge carried out into rolling noise, never above the
  map's highest ground, its sea carried on), so a view turned off the diagonal meets land, not sky.
  Entrance: the camera comes down out of the sky.
- **Trees** (`country/trees.ts`, the shared `treesGlsl`): the woods stand where the clearance lies
  over the woods' line (cleared off roads, streams, yards and water), and no crop, hedge, fence,
  herd or bale stands under them; pine where its parcel's flag in the parcels' map says, kept out of
  the filtered clearance; the march meets bounds (the woods' envelope, the line lowered by as much
  clearance as a crown's reach can span, and each lone tree's steepened tent); near enough for a
  crown to span a cell, the crowns are found exactly at the hit, each a dome or a pine's tiered cone
  with a trunk; a ray between crowns goes on to the ground. Hedgerow trees stand only on standing
  hedges, riverbank trees on the banks, none inside the woods, all felled while woodland is off.
- **Buildings** (`country/buildings.ts`): a cottage, barn or church whose gable spans over 6 cells
  is a solid met in its own frame (block, roof, chimney, the church's tower and spire), with the
  sprites' windows; smaller ones are the shared sprites. Only the two nearest buildings whose bounds
  hold a pixel are drawn there. The castle (`country/castle.ts`) is always a model met by the eye
  ray: battlemented curtain walls, round corner towers, a gatehouse between two towers, a keep with
  a coned turret and a hall, its gate turned half a radian right of the vantage so two sides show,
  merlons at least three cells apart, windows lit at dusk at half the village's share; it is drawn
  in a loop of at most one turn, so a software rasteriser runs it only where it stands.
  `village lights` (`lights`, 0.7: the share of windows that ever light, one by one as dusk falls,
  most dark late at night; the glow round lit cottages) and `chimney smoke` (`smoke`, 0.5: curling,
  leaning with the wind, thicker as the light goes) are each compiled in only while on.
- **Chalk M** (`chalk`, off; `country/chalk.ts`): a giant M on the hillside that shows it best from
  the vantage, found once per terrain (steep enough, turned to the eye, inside the default framing,
  preferring a slope the default hour's sun lights, as chalk in the sky's light alone reads grey;
  clear of water, roads, streams, yards and the river's banks, in sight over any wood that may grow
  else over the bare land), laid out as the vantage's eye sees it so it reads upright, drawn out up
  the slope by at most 2.4 times its proportions; the parcels under it and just below its foot are
  kept open grassland (an allocation, no rebuild). Found for every valley, coast and rolling-hills
  landscape tried (0-9) and 2 of 10 plateaus.
- **Settlements**: the `village` (11 cottages; 1-30, its plots taken in a fixed order from the
  church outward along its roads, so a larger village keeps every cottage of a smaller),
  `hamlets` (1-3), `farms` (1-8), the `castle`, `roads` and `farm tracks`. Every site is chosen
  whether or not it is built, so switching one settlement moves no other; a change re-runs only the
  settlement, road and parcel stages, reusing the carved river and what is made of it alone (the
  settlements' sites, the woods' patches, the parcel sites and their cells by the bare metric, the
  land model's weights and ranks): a farm switched builds in 0.2-0.3 s where a fresh build takes
  about 0.9 s (bun, seed 3), byte for byte the fresh build (`country/build.test.ts`). Every route
  is planned whatever `roads` and `farm tracks` say; switched off, a route keeps only its stretch
  through the village (`TERRAIN_VILLAGE_STREETS`, the bridge whole where it reaches it) as the
  village's own street, so no cottage moves, and those streets are drawn with both off
  (`COUNTRY_HAS_ROADS` holds with the village).
- **River** (`river`, its amount the size): off, the river and its streams run dry, their beds pale
  stones, the carved valley, banks and bridge kept (`packWater`, no rebuild). `wind ripples`
  (`country/ripples.ts`, 0 by default, the shared water's ripples tier compiled in only while up):
  the breeze's cat's-paws (`windRipples`) tilt the river's reflected ray, their finer ripples
  jitter it cell by cell into streaks, and the paws glitter.
- **Season** (`season`, `country/season.ts`: summer, harvest by default, autumn): every crop parcel
  keeps its kind and shows it as the season has it: wheat green, gold, then drilled in green rows;
  barley green-gold, stubble with round bales, then mostly ploughed; rapeseed yellow, stubble, then
  ploughed; hay standing in flower, then the mown aftermath; grazing lusher in summer, duller in
  autumn. The flower fields take the shared fields' autumn, open grass turns tawnier, hedges russet
  and the broadleaf trees (near crowns and far canopy) each their own autumn colour; pines stay
  evergreen. Round bales (`COUNTRY_HAS_BALES`: harvest with crops on) lie on the barley's stubble,
  one at most to a cell of a 26 × 18 m grid along the rows, where the field's clear core or its own
  record looked up there lets them, each a cylinder met by the ray.
- **Life**: pastures' herds (shared livestock, kept to each parcel's clear core; `herd size`),
  walkers and carts (shared figures) going out and back along the roads by arc length; birds
  (shared `birdKnobs`, mixed). Under lying snow walkers and carts tread the roads they use, all of
  them (`country/trodden.ts`): packed grey but for a white rim, more the busier; snow still falling
  fills the way back in, so it shows clearest once the snowfall is over, and clears first.
- **Verges** (`verges`, off; `country/verges.ts`, the shared plant component): cow parsley, red
  campion and tussock grass at the foot of the hedges within 450 m of the vantage, slotted every
  5 m along each hedge as the shader's parcel lookup draws it (a fuller verge keeps a sparser
  one's clumps), never in a pasture or a wood, by a road, stream, water or yard, nor across a
  pasture's hedge from the eye; swaying on springs under the wind and the flower fields' gust
  bands, following `season` where the scene has it (else the harvest), carrying snow. Drawn per
  fragment from bearing bins, nearest first.
- **Murmuration** (`murmuration`, off; `country/murmuration.ts`): the Murmuration scene's flock
  (`Flock`) at 2.4 km over the far fields from late afternoon to its roost at dusk, carried by the
  wind, absent in steady rain, hidden by any land nearer than it.
- Neither needs a sampler slot: the sim packs the flock's field and the verges' plants beside and
  above the terrain's records in one texture (`country/atlas.ts`), only while they are on.
- **Valley fog** (`fog`, its amount; `country/fog.ts`, compiled in only while on): a bank of mist
  lying on the valley floor with a mist thinning upward over it, seen through along each ray rather
  than blended at the surface the ray meets. The floor is the river's level down the valley: the
  sim packs it once per terrain into the records' misc row (`packCountryFog`: the river's course
  projected on its axis, 16 samples, each the lowest the river has come down to by there), so the
  bank follows the river down past the vantage, fills the plateau's gorge and runs out over the
  coast's sea, shallower up the valley where the cold air drains away. The bank is full to its top
  (the floor and a depth that grows with the knob) and fades over a soft margin (a logistic step);
  the mist over it falls off exponentially with height. Both are integrated in closed form along
  the straight ray from the eye (the step through its softplus), the floor taken linear between the
  eye's and the ray's end: a ray down into the valley whitens, the valley's sides, ridges, trees and
  roofs rise out of it, a crest stands sharp against the bank behind it, and the far land, the far
  ridges (6 and 9.5 km) and the horizon's sky (16 km) take the same integral, so the land's fog
  and the sky's meet without a seam. Patches drifting down the valley and with the wind lift and
  lower its top and thin or thicken it where a ray ends (less the farther); ground mist lies in the
  hollows, the side valleys above the bank too, as deep as each is sunk below the land 70 m round.
  It is deepest and thickest at dawn and burns off through the morning to a thin, low remnant (less
  of it in a cold season, and less the thicker the fog), gathering again from late afternoon; wind
  and an overcast sky soften its top. Its light is the sky's and the moon's and the sun's scattered
  forward (Henyey-Greenstein, g 0.6): it glows toward a low sun and lies grey in the hills'
  shadows; dim by night, where lit windows deep in it are dimmed by it and haloed by the light it
  scatters. The general haze no longer thickens with the knob: the fog's mist carries the distance.
  With it off the scene draws as before, byte for byte; on, about 5% more of SwiftShader's frame.
- Knobs: land shape, landscape (seed), relief, erosion; the land use mix (crops 60 and woodland 30
  on, pasture 25, wildflowers, lavender and sunflowers 20 off) with pine mix, cattle share, herd size
  and season; river with its wind ripples; village, hamlets, farms, castle, roads, farm tracks;
  village lights, chimney smoke; walkers, carts, birds; verges, murmuration; chalk M; time of day,
  stars, moon, clouds, cloud shadows, rain, snow, fog, wind. Each optional part is compiled in only
  while on (`countryFeatures`); `COUNTRY_ALL` is the all-features program (`featuresAll`). Pasture
  is off by default: its fences and herds stay out of the default program (a software renderer runs
  every line), and the crops' catalogue already shows grazed grass.
- Checks: `src/sims/terrain.test.ts` (river level across and downstream, roads join every
  settlement, road grade bounded and cut into the ground, way points on their roads, clear cores
  inside their parcels, determinism and both reuses, the village's growth, settlements and their
  candidates that never move one another, the roads' and tracks' switches moving no cottage, the
  village keeping its streets, the build running a unit a frame); `src/sims/landuse.test.ts`
  (shares within bounds, a raised share converting only to its use and a lowered one only from it,
  woods on their best ground growing outward, none and woodland alone, determinism, minimal herd
  swaps, woods keeping their species, the canopy and lone trees as packed; at the scene's size, for
  seeds 0-3 at crops 60, woodland 30 and pasture 25, the castle, a third hamlet, a fourth farm or
  thirty cottages changing no land beyond 500 m of the site but beside the ways they move, and the
  roads or tracks switched changing none beyond 150 m of every way); `src/sims/math.test.ts`
  (`hypot2` and `hypot3` giving V8's recorded `Math.hypot` bits for zeros, NaN, subnormals,
  overflow, ties and map distances JavaScriptCore's rounds otherwise, `atan2` V8's `Math.atan2`
  bits for signed zeros, infinities, NaN, each reduction's edge and road headings);
  `country/engines.test.ts` (three landscapes, each another shape, built in JavaScriptCore and in
  V8 under node, every part the same bits; skipped, saying so, without a node that strips types);
  `country/build.test.ts` (one builder's builds as farms, the castle, the roads and the river turn,
  each handed away by transfer first, byte for byte a fresh builder's, the settlements' sites not
  sought again); `country/march.test.ts` (for every land shape, on the landscapes whose grazing
  rays take the most steps, the march meets the bare land where a dense march does for 99.8% of
  the land in a 640 × 360 frame and no ray runs out of steps; the shortest steps alone carry a ray
  past the farthest look); `countryTerrain` (the
  all-features program over the real sim: land, sky and river, deterministic per landscape; at 9216
  map points the shader finds each parcel with the land model's use and the woods only on woodland,
  for five settings; a use change one sim frame, timed, rewriting no ground, and no parcels where
  it keeps every wood and its species (the herds alone); the river dry and full again);
  `countryBehind` (every ray that passes between the crowns, over the whole view, ends where it
  first meets the land, within 5 cm along it or 0.2% of the distance, all but one in 200; the
  single flat step it replaced lands under a third of them);
  `countryLife` (every walker and cart on its road, every animal inside its own pasture and clear of
  the fence, roads and water; deterministic and still at motion 0); `countryFeaturesAll` (the
  all-features program draws every setting, as source and dithered, byte for byte as its own
  program: each knob turn that changes the program and all of them at once, then dusk with and
  without the lit windows and smoke, the murmuration's hour, each season, midwinter's snow and its
  rain falling as snow, the passing year, the wind ripples, walkers and carts over lying snow, and
  the roads, tracks and village off); `countrySeason` (walkers tread the lying snow darker beyond
  the figures themselves, less while snow still falls; autumn turns broadleaf woods orange and
  leaves pine woods and the harvest green); `country/verges.test.ts` (every clump
  at a hedge's foot, off roads, streams, water, yards, woods and pastures; a fuller verge keeping a
  sparser one's clumps; the farming year; sway and an exact rest); `countryVerges` (every clump's
  root, looked up by the shader in the atlas, at a hedge's foot on its ground; the scene draws
  them); `countryMurmuration` (the flock shows at dusk and is never drawn over land nearer than it
  as it pours down to roost); `countryChalk` (for three landscapes the M the knob cuts is one
  upright M wholly in the default view below the horizon, both legs and an open foot to its
  middle); `country/fog.test.ts` (for every land shape the fog's floor runs down the valley within
  the river's levels, never rising, to the lowest at the mouth's end, and its packing touches no
  other record); `countryFog` (the fog's program at 0 draws the fog-off picture byte for byte, at
  dawn and at night with the windows lit; at dawn the lowest quarter of the land in each band of
  distance changes far more than the highest quarter; the sky over the skyline takes the fog; by
  midday the same knob changes the land less than at dawn).
- Open: gates in the fences; the plateau's near table hides the gorge.

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
- The shared part carries balls (globes and weights: drag along the relative air, contacts with
  other arms' balls, wires and links; the Calder plates it was first built with are gone), arms
  hung from a parent's loop, and a motor (`Mobile.drive`): a couple across an arm's ends that makes
  up for the damping, brings the turn to the set rate and winds up any turn lost (up to a full
  turn, then it slips like a clutch), so an arm keeps its rate exactly over time while gusts and
  knocks still set it back for a while. Its solver runs 24 passes a substep and 3 more per arm, so
  at the default clearance the most loaded link stretches under 1% in a breeze for every planets
  choice (0.45%, 0.77% and 0.83% for 5, 9 and 11 arms, against 0.75%, 1.45% and 1.85% at a flat 24).
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
  substep for the eight planets (75 µs with the dwarfs) at 240 substeps a second (Bun).
- Check: `mobile` (`mobile/mobile.verify.ts`): the shared GLSL against its CPU twin for balls, the
  motors' periods (Mars against the Earth 1.881), planets lit on the Sun's side, and the picture at
  rest after an entrance bit for bit the one without.

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
  to bird as a wave. The falcon's fear reaches along the line of sight through it, a cylinder as wide
  on the birds' plane as its reach on screen, and pushes across that line: the birds it is seen
  passing through scatter, whatever their depth, and the hole opens on screen. Cohesion sets the
  spacing and pull, chaos the noise and how weakly the birds align. The ink, falcon, M and passage
  are shared with the sheet, and switching either way hands the birds over where they are.
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
  fly boids; it flies a `Flock` (the flight without its textures, which the `murmuration` layer's
  sim hands to the composer) and packs the field into its own records texture, inking it with the
  same `flockInk`.
- Sky at dusk; a low skyline at the bottom edge, never the focus. Since the outdoor composer (ADR
  0062 Phase 2c) the skyline is the `roost` backdrop and the flock the `murmuration` life layer, far
  out in the World's sky (3 km: everything nearer hides it). Over another rig it keeps the same
  shares of the sky above that rig's horizon, and its M stays clear of the land.

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

Jeff Jones's agent model of Physarum linking oat flakes on agar (`physarum`), over Tero et al.'s
adaptive flow network (the model of their Tokyo rail experiment).

- The network: a fine mesh of tubes over the dish, grown on the CPU. Food drives a flow through it
  and each tube swells with the flow it carries and withers without it (dD/dt = f(|Q|) − D), so
  the flakes are joined by trunks, Steiner junctions and a few loops. It opens the scene (drawn as
  the first frame's trail) and stays on as a faint film the specks ride, so the veins follow the
  food: the veins that served only an eaten flake are out of the film about a minute after it
  starts to be eaten, and a new flake is joined by a vein within a few seconds (at the default
  evaporation; evaporation sets how fast unused tubes wither, from about two minutes at 0 to under
  half a minute at 1).
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
- Built: the pane (`frost`). Behind it, the night is the world's sky (`worldSky`, src/scenes/README.md
  "World layers"): a star knob (the cabin, away from the town's lights, shows 1.7x the street's
  stars, `World.stars`), the moon's phase (`SKY_MOON_PHASE`: disc, halo, its light on the snow and
  in the room), an aurora (off by default) whose green lights the snow while the sky is open, and
  shooting stars (off by default, "now" on trigger 1) in the sky over the roofs. The snow cloud
  (out in fair weather at 0.3, closed from there by the world's overcast as it snows) hides them all
  and shuts out their light; the frost's blur coarsens their detail.
- The pane keeps its frost through a resize: every frond, scratch and nucleus takes its random
  draws from where it stands, counted in from its own side of the pane, so a wider or narrower
  window regrows the same pattern (each half following its own edge; only a few branches down the
  middle change), once the new shape has rested about a fifth of a second (`frost/sim.test.ts`).

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
- The open sea's wind ripples, mirror and glitter are the shared water's `mirror` tier
  (`rippleSpectrum` over four trains by the golden angle, `waterMirror`, `waterGlint`): the moon
  low over the sea lays a long blazing path, high up a short faint one; the breakers and swash are
  the scene's own.

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
  shore, dunes, bees, falls, swell, lake (over the ice and the fjord) and lanterns, each scene giving its
  camera, lanes, occlusion and light.
- **Sky components** (built: stars, the Milky Way, the moon's phase, the aurora and shooting stars
  in `src/shaders/lib/`, with `skyKnobs` and, for a scene that keeps its own night,
  `skyComponentKnobs` in `src/scenes/atmosphere.ts`): each an optional knob that starts at the
  picture the scene drew before, or off. A scene composes what its sky shows in its own frame,
  behind what stands in front of it, and mirrored where its water mirrors the sky (lanterns, lake's
  ice and fjord, and shore, the shore's through the world's mirror; glints in swell's waves). Which
  scene composes which: "Sky capabilities by scene" in `src/scenes/README.md`.
- **Clouds** (built: `src/shaders/lib/clouds.ts`, in tiers by `CLOUD_TIER`): the deck's plane and a
  calm deck (the night train's), the lit deck every sky draws, its shadows on the ground (autumn's
  optional cloud shadows, `weatherKnobs({ shadows })`) and a ray-marched sea of tops seen from above
  (the clouds scene). Which scene draws which tier, and the cloud look-alikes kept apart: "Clouds"
  in `src/scenes/README.md`.
- **World layers** (built: `src/shaders/lib/world.ts` with `worldKnobs` and `worldFeatures` in
  `src/scenes/world.ts`): the sky, its weather and its birds as one world state composed in one
  order (sky behind, then birds, fog, rain and snow by depth), every part compiled in only while its
  knobs can show it; a scene gives its camera and its distances. Meadow is the first adopter; shore,
  dunes and bees followed. Bees' painted cumulus towers and their drifting shadows became the
  world's opt-in cumulus (`WORLD_CUMULUS`), on in bees and a knob away in every other adopter:
  "World layers" in `src/scenes/README.md`.

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
  pauses it. Its own advances are one undo step, so one undo goes back to where it began. A tour
  link plays as it opens, except under reduced motion, where it waits for play and cuts. Example:
  `?tour=physarum-60.petri-45.delta-60.frost-45`.

Links are read in the keys of the build that opens them: a key it does not know is ignored, and
there is no URL version, migration or scene alias (no backward compatibility, operator decision
2026-10-17; "Links and the URL schema" in `src/scenes/README.md`). A setup made on an older build
replays exactly on that build, `/@<sha>/?<query>`. A link naming a scene the lab does not have
opens the default scene, and the lab says so in one line over the scene.

## Display, pacing and failures

How the page puts the scenes on screen (`src/renderer.ts`, `src/program-cache.ts`, `src/display.ts`,
`src/governor.ts`):

- **Cells on whole device pixels.** The canvas is sized from a ResizeObserver's device-pixel box,
  and `pixel` (`&pixel=`) means about that many CSS px per cell, rounded to whole device pixels:
  at 125 % scaling pixel 2 gives 3 device px a cell, where 2.5 showed as columns of 2 and 3 and
  bent the dither's tone by up to 8 points. At 100 % and a whole `pixel` the cells are as before.
- **A cell budget.** A frame draws ~960 × 540 cells (`CELL_BUDGET`, the scenes' budget), and a
  stage coarsens its cells only past 25 % more (`BUDGET_SLACK`): one CSS row past 1080p and a
  windowed 1920 × 1200 browser keep 2 px cells, where a hard cap halved them; a 4K screen at 100 %
  gets cells of 4 device px at pixel 2, a 1440p one 3.
- **Frame pacing.** Frames come every n-th refresh, n whole, so each stays up as long as the last:
  the even divisor of the measured refresh rate nearest 60 frames a second (75 at 75 Hz, 45 at
  90, 72 at 144, 55 at 165) while input, a trigger's response, a passage or an entrance lasts, and
  at rest too unless the lab's "At rest" setting says half rate: about half that (30 at 60, 90, 120
  and 240 Hz); none while the picture stands still
  (paused, reduced motion, motion 0) once the last change or input has played out. Input draws again
  at once, a pointer that only moves for a quarter of a second.
- **A clock per scene.** Each scene's clocks count from its own start, so the float32 `uTime` and
  `uMotionTime` stay small however long the page is open; through a passage the leaving and the
  incoming scene each keep their own, and a scene picked with "keep the world" or flipped to in a
  comparison takes over the clocks of the one it replaces, its hours, year and stars going on.
- **One sim clock.** Frames come at many rates (72 a second on a 144 Hz display, 30 at rest, fewer
  on a slow machine), so every CPU sim and GPU solver steps a fixed time on a `FixedStep`
  (`src/sims/clock.ts`) and is drawn between its last two steps (a GPU solver's fields through
  `FieldBetween`, `src/sims/between.ts`: the incense's smoke, the pearl tank's flakes; or, where the
  drawing must stay over what the last step laid down, as the harmonograph's pen over its ink,
  ahead of it by the time left over), and draws its chance on those steps, what is drawn a frame or
  an event at a time on a stream of its own (bamboo's leaves, apart from its gusts): a seed plays
  the same at any frame rate. Damped springs take the exact step (`springStep`,
  `src/sims/spring.ts`); the pointer's trails lay their ink per distance travelled, and a pointer
  held still at a rate per second (`TrailField`, `src/sims/trail.ts`).
- **Sims build off the page.** A sim's heavy build (the countryside's land, frost's field, dew's
  web, the bonsai's tree and its maps, the dry garden's layout, the forest's warm-up, the slime
  mould's dish, the pond's sheets) runs on the build worker (`src/sims/build.ts`), byte for byte
  the page's; the sim is not ready until its first lands, so a passage enters with it in place,
  and the page's first scene appears with it in place.
- **Builds never block.** Every program builds in the background, the first one too: the bare page
  shows until it is built and its sim is ready (at most 3 s), and the scene then appears out of it
  cell by cell, each cell at its own Bayer threshold, over 0.8 s, every cell crisp from the first
  (simply there once built with transitions off, at motion 0 or under reduced motion); a cut or a
  retry keeps the old picture moving meanwhile.
- **Failures.** A lost WebGL context is asked back and, once restored, the scene starts over as on
  the first load: the bare page while it is lost and while it builds again, then the same reveal.
  Without WebGL2, or without JavaScript, the page shows its copy over its bare background. A scene
  whose shader source does not assemble shows the failure screen. At most eight programs are kept
  across scenes.

## GPU cost on real hardware

Every timing elsewhere in this file is SwiftShader's, on the dev host. A scene's cost on a real
GPU comes from the lab's GPU timing page, `bench.html` beside the lab (`/bench.html` for the head,
`/@<sha>/bench.html` for a commit; `src/scenes/README.md`, "GPU timing"): opened on the device, it
times each scene at its defaults on 960×540 cells, one per device pixel (`budget=off` for grids past
the budget), its program's compile and link and then its frames, drawn unpaced (GPU time where the
browser has `EXT_disjoint_timer_query_webgl2`, else the time between drawn frames), and gives a
JSON report naming the renderer and the context's limits. Record a device's numbers here with its
renderer string, the build and the date, starting with an integrated GPU, against the budget of
60 fps at that size.
