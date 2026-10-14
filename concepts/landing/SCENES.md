# Scene backlog

Scene ideas beyond the first three (orbit, swell, pond). Each is a dithered shader
scene: animated, tweakable in the lab, with a standalone Manifold landmark that fits the scene.
How to write one: `src/scenes/README.md`.

## Status

All of the ideas below have a first implementation in the lab:

| Idea | Scene id | Notes |
|---|---|---|
| Above the clouds | `clouds` | Aurora and lightning come from the shared weather layer. |
| Waterfall | `falls` | Gorge choice: basalt flows (default), sandstone ledges, or a pale limestone slot whose walls close in. |
| Countryside | `country` | Relative weights for seasonal crops, wildflower meadows, lavender rows and sunflowers; reproducible landscape seeds. |
| Murmuration | `flock` | Authored deforming sheet on the CPU; optional emergent topological boids (`Boids`). |
| Paper marbling | `marble` | Mathematical marbling engine. |
| Dunes | `dunes` | Werner slab model. |
| Ice and frost | `frost` | Frost on a window pane; snowfall from the weather layer; the shared sky components (stars, moon phase, aurora, shooting stars) in the window. |
| Snow and rain | merged | Part of the shared weather layer, not a scene: rain, snow, rain on glass, ripples, fog. |
| Sea shore and bioluminescent bay | `shore` | |
| Window sill | `sill` | |

The shared options became libraries every outdoor scene can use: sky and time of day, weather,
lightning and aurora (`src/shaders/lib/`), with shared lab knobs (`src/scenes/atmosphere.ts`). The
giant ringed planet is an opt-in one (`src/shaders/lib/planet.ts`, included by the scenes that draw
it; knobs `src/scenes/planet.ts`): `orbit` draws it as its subject with every feature (belts,
clouds, storms, aurora, city lights, day cycle, banded rings, moons), `campfire` as scenery over its
pines.
The notes below are the original briefs.

## Zen batch

A second batch of calm scenes whose subject is a simulation, from grounded scenery to pure
mathematics. All have a first implementation in the lab:

| Idea | Scene id | Simulation | Shared engine |
|---|---|---|---|
| Dry stone garden (karesansui) | `garden` | Raked gravel height field, falling-plate maple leaves; fresh gravel dries on an `AgeField` clock, optionally with the weather (weathering, sun, wind, rain), damp lingering in the groove bottoms | `HeightField`, `AgeField` |
| Bamboo grove and water clock (shishi-odoshi) | `bamboo` | Damped culm springs under gust fronts, tipping tube; a moss pad on its stone softens the knock for a quiet clock | |
| Lantern river (tōrō nagashi) | `lanterns` | Lanterns in potential flow round stones, eddies, soft contacts; stones and deep lantern overlaps settled after each step | `separateDiscs` |
| Synchronous fireflies | `fireflies` | Pulse-coupled oscillators on a lattice; dense-crown or open-bank habitat at one population; the lights nearer than the bank move in the world in front of the eye | `LevelCamera` |
| Kelp forest | `kelp` | Buoyant Verlet stipes in surge: giant kelp, or bull kelp held up by one gas bulb (or a mix); boids school | `VerletSystem`, `fishGlsl` |
| Spider web at dawn | `dew` | Verlet orb web, dew drops creeping and falling; paged bin lists keep the dense hub whole | `VerletSystem`, `BinLists` |
| Meadow in the wind (honami) | `meadow` | Gust fronts shared by shader and sim, dandelion seeds carried in the world along the gust direction | `LevelCamera` |
| Ink-wash landscape scroll (shan shui) | `shanshui` | Procedural handscroll, drifting mist, four seasons' washes; painted in sections joined by mounting silk so days of unrolling stay precise | |
| Incense smoke | `incense` | Buoyant smoke, laminar to turbulent; a ceiling vent draws the layered veils off without bending the thread | `FluidSim` |
| Sand table | `sandtable` | Theta–rho ball and sand pendulum on a height field; the relief is re-sent every frame while a machine outruns it, so a groove's head stays under the ball | `HeightField` |
| Chladni plate | `chladni` | Sand grains drifting to the nodal lines of plate modes; grain size from fine sand (thin, crisp lines, slow to gather) to grit (broad, rough, steep ridges, quick) | `grainAt` |
| Ferrofluid | `ferro` | Rosensweig spike lattice, sloshing blob | |
| Soap film | `film` | Thin-film interference, gravity drainage, pops whose rim crosses the film from the break in least time | `FluidSim`, `ArrivalField` |
| Pearlescent fluid (rheoscopic) | `pearl` | Flake orientation advected and turned by the flow | `FluidSim` |
| Petri dish | `petri` | Gray–Scott Turing patterns, Barkley BZ spirals | `GpuCompute` |
| Slime mould network (Physarum) | `physarum` | Jones agent model linking oat flakes | `GpuCompute` |
| Hyperbolic tiling | `hyperbolic` | Möbius glide over a {p,q} weave; drags re-grip when the map or screen shape changes | |
| River delta from above | `delta` | Shallow water erosion and deposition | `GpuCompute` |
| Fractals | `fractal` | Julia walk, Mandelbrot dive, Apollonian gasket, Newton garden; drag pan tethered to the frame | `ElasticPan` |
| Prism | `prism` | Dispersion through glass, total internal reflection; Newton's recombination by a second prism that slides in along the fan and steps back when the first turns into it | |

## Slices of life and more

A third batch built on the shared foundations (weather in the world, hard edges, the GPU and CPU sims):

| Idea | Scene id | Simulation |
|---|---|---|
| Late-night bar | `bar` | Patrons arrive, sip and leave; the bartender pours, shakes, polishes; rain and traffic outside the window. Last call (the time-of-night "now"): a hand bell and two blinks of the lamps (just the blinks with the bartender off), last sips, one for the road or a word with you if the bar is empty, then closing time until the time of night is moved |
| City crossing at dusk | `street` | Social-force walkers, intelligent-driver traffic, a signal cycle with a scramble; umbrellas open in the rain; optional late delivery (a van at the kerb past the crossing, hazards on, its driver wheeling crates to the konbini through the crowd, cyclists swinging out round it). Seen from a window pitched down at the crossing, rain and snow both fall along paths that close in below the street (`rainFallSeen`, `snowFallSeen`) |
| Night train window | `train` | A journey with stations, level crossings, bridges and tunnels; tea rings at every rail joint; everything that moves with the motion clock (clouds, lamps, flashers, station clock, the carriage's rock) keeps its phase when Motion changes |
| Mystic forest | `forest` | Kodama spirits appearing and turning their heads, curious of the pointer or (a tunable share) shy of it and ducking into the moss (`sims/temperament.ts`); spores on curl-noise air, a stag crossing |
| Ripple tank | `ripple` | GPU wave equation: interference, double slit, lens, Doppler, standing waves; projected caustics; edge absorption from beaches that swallow every wave to bare walls that reflect them, apart from open-water damping |
| Lava lamp | `lava` | Heated wax blobs with buoyancy, necks and merging; a wax body from silky (smaller blobs slipping through each other, long tails, smooth merges) to chunky (fewer, slower, knobbly lumps) |
| Frozen lake | `lake` | Aurora mirrored in black ice, singing cracks, drifting snow, frozen bubbles; lying snow from wind-packed crust to fresh powder at the same cover. The crack and snow fields are laid out on the ice as the eye at rest sees it (`LevelCamera`) |
| Bonsai through the seasons | `bonsai` | Space-colonisation growth, cloud pads on springs, leaf fall, snow, pruning; with the breeze off the pads hang still until a gust, snip or hover |

## Quiet places and small machines

A fourth batch, after the cosy-game mood (gentle, warm, unhurried) rather than any game's look:

| Idea | Scene id | Simulation |
|---|---|---|
| Harmonograph | `harmonograph` | Damped, slightly detuned pendulums drive a pen; the figure precesses and spirals inward, then a fresh sheet slides in |
| Campfire under a ringed planet | `campfire` | Licking flame tongues, sparks, smoke, a toasting marshmallow, a vast starry sky. Optional burning down (`FuelBed`, `src/sims/fuel.ts`): logs catch, char, thin, slump and crumble to embers, tended or left to go out. The giant planet is the shared one (`shaders/lib/planet.ts`, decoration tier): optional moons on its ring plane (crossing in front of and behind it, casting shadows), an aurora, night-side city lights and its own day cycle |
| Pendulum wave | `pendula` | Exact small-angle pendulums with lengths for N + n swings per cycle: waves, helices, chaos, realignment; or real ones, released by a board and slowed by their own wide swing (`sims/pendulum.ts`), drifting off the realignment |
| A small island | `island` | Raymarched island with surf, cloud shadows, a gull and weather; rain seen from above converges below |
| Aurora over a fjord | `aurora` | Draped ribbons with rays, mirrored in still water or ice (or, with the wind ripples knob, broken into streaks by drifting cat's-paws: `shaders/windWater.ts`), a red cabin, falling and lying snow |
| Summer apiary | `bees` | A hillside garden of hives, lavender rows and orchard under cumulus; bees are specks whose flight tells the story (beelines between hive and flowers, hovering, crowds at the entrances), with fluttering butterflies, all flying in the garden's world and projected through its eye (`LevelCamera`). Each dither cell shows its nearest insect (`SpeckMap`, `src/sims/specks.ts`), so scenery hides only what is behind it |
| Looking up at the city | `skyward` | Facades converging on the zenith, trams, planes and contrails, birds; rain streams out of the sky overhead, and snow too with "snow from overhead" (`snowFallSeen`) |
| Autumn park | `autumn` | Leaves flutter and tumble down (quasi-steady plate model), build a carpet (the two-layer ground-litter lattice `sims/litter.ts`), and gusts lift swirls of the top leaves off the path |
| Hanging mobile | `mobile` | Balanced arms on links as coupled Verlet pendulums, plate drag in drafts, gusts and eddies, plate contacts, shadows from one or two lamps on the wall |

Rain everywhere falls at terminal speed in real time, along the world's vertical as each scene's camera
sees it (`rainFallSeen`), whatever the calm of the rest of the scene; snow does the same where the
camera tilts (`snowFallSeen`: skyward looking up, street looking down).

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
- Level of detail: the march steps grow with distance, and the cauliflower relief that shapes the
  tops' normals fades out as a cell's footprint on the deck grows; once fully faded it is not
  computed at all, for the same picture. The macro field the march, normals and shadows trace keeps
  its full shape at every distance: fading it would reshape the far deck, and a projected-size floor
  under the march step saves only a few percent of steps, even skimming low over a full deck.

## Waterfall

A cliff face with a waterfall as the focus.

- Falling water as streaks advected down a flow field, foam and spray mist at the base, a plunge
  pool with ripples.
- Rock strata, moss and ferns on the ledges (reuse the pond's botany), rainbow in the spray when
  the sun is behind the viewer.
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

## Hanging mobile

A Calder mobile turning in a quiet room, its shadows thrown large across the wall behind it.

- The mobile is a shared part (`src/sims/mobile.ts`): a seeded cascade of wire arms, each a rigid
  triangle (two ends and a hang loop just above them) balanced by the lever rule, hung on a link
  from the end above it, so the arms are coupled pendulums that swing, rock and turn freely. Plates
  ride the arm ends; the air pushes on each plate along its normal (quadratic drag), and plates
  that meet another arm's plate, wire or link are pushed apart instead of passing through. Its GLSL
  traces plates, wires and links along a view ray and gives the share of a round lamp they hide
  from any point, so other scenes can hang one (a window sill, a bar) and light it their own way.
- Air (`src/sims/wind.ts`, the shared wind conventions): the draft (`wind`, -1..1) from a window,
  gusts on the garden/autumn pulse crossing the room as a front with a "now", and the room's eddies
  (`room air`). Uniform air barely turns a balanced arm (its plates' drag balances about the loop
  as their weight does), so it is the difference between neighbouring plates' air that turns the
  arms, a few degrees a second at the defaults.
- Light: a spotlight on a stand at night (paper theme off) or a white room in daylight (paper
  theme); `light from` moves it, `soft shadows` sizes it; a second, cooler light through a window
  on the right throws a paler second shadow, so the two shadows take each other's colour where
  they part. Each shadow is cut per cell against its own threshold.
- Knobs: arms (3..7), plate outlines (leaves, discs, mixed), paint (primaries, black, white,
  brass), clearance, design seed; draft, gusts, room air; room, light from, soft shadows, second
  light; the Manifold M cut from red sheet at the cascade's tip. Click a plate to blow on it.
- Passage: lowered from the ceiling on its link, bobbing once as it stops; hoisted back up on exit.
  It is a pose applied when the mobile is packed, so the simulation at rest is untouched.
- Cost: about the same per frame as `pendula` (software WebGL, 480×270: 108–139 ms against
  105–136 ms; 147 ms at 7 arms); the physics is 16 µs a substep at 240 substeps a second.

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
  |---|---|---|
  | 1500 | 0.33, 0.37 | 0.95, 0.94 |
  | 3000 | 0.59, 0.65 | 1.85, 1.71 |
  | 5000 | 1.01, 0.98 | 3.37, 2.95 |

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
- Interaction: click to drop ink, drag to comb; presets for traditional patterns (nonpareil,
  chevron, bouquet).
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
  read as distinct networks (proposed as lab presets rather than a knob, so the three sliders stay
  the only controls):
  - lace: reach 4, angle 60°, evaporation 15%. A fine, curly lace over the whole dish; the flakes
    pool gold with thin links between some of them.
  - woven: reach 9, angle 12°, evaporation 10%. Straight threads knit an even, open polygon mesh;
    pooled flakes, thin links.
  - routes: reach 18, angle 22°, evaporation 75%. A few bold trunks meeting in star-shaped
    junctions at the flakes, and almost no lace; with the Tokyo food and the rail palette, a
    transit map.
  The default (reach 9, angle 35°, evaporation 40%) sits between: trunks over a faint lace. At
  short and middle reach, low evaporation lets the lace win and trunks barely form; a wide angle
  curls the filaments and a narrow one straightens them.

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

- **Aurora** (orbit has one; adapt it for ground- and plane-level views).
- **Lightning**: branching bolts (stochastic L-system or dielectric-breakdown model), sky flash,
  trigger with a "now" button like the meteors.
- **Weather and time of day** as a common layer across outdoor scenes.

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
