# 0062 — One world, three composers: the landing scenes become presets of stacked layers

Date: 2026-10-17
Status: accepted
Ratified: D1–D12 by the operator, 2026-10-17 (#1082 item U1); restated after Phase 2 below

## Problem and boundary

The landing concept lab (`concepts/landing`, tracker #1082, draft #1083) holds 49 scenes, each one
`SceneDef` compiled to a fragment program of its own. Most of the outdoor scenes show the same
thing: a camera standing on the ground, something in front of it, a landscape behind, the sky
above. The World (`src/scenes/README.md` "World layers") gave them one sky, one weather and one set
of birds, but each scene kept its camera, its ground, its light, its gusts and everything in front
of the eye, so nothing of one scene could stand in another: the lab could not show the bees'
garden overgrown by the meadow, or the bees' garden above the countryside's valley.

#1082 item U1, which the operator ratified as "go all in", folds the scenes into three composers.
Each composer is a shared camera, site and light over which layers taken from the scenes stack.
Scene ids stay as presets; no aliases and no link migrations (no backward compatibility, operator
decision 2026-10-17).

This record is the decision as it stands after Phase 2, when the `outdoor` composer runs all
nineteen eye-level scenes, and of the two pilots and what followed them: the `interior` composer's
(Phase 3) runs sill, lava and bonsai, the `overhead` composer's (Phase 4) pond and ripple. It keeps
the reasoning, the evidence and the phases ahead. The lab is not product code, so no axiom,
`REGISTRY.md` row or `docs/CONTRACTS.md` section changes; the contract's normative form is the
"Composers" section of `concepts/landing/src/scenes/README.md`, the lab's own spec.

Paths are relative to `concepts/landing/` unless they start at the repository root. Measurements
are the ports' own, taken under #1082 on the shared dev host.

## Where it stands

- **Built:** `src/composer/` (the contract in `types.ts`, `composeScene` in `compose.ts`, the
  placer in `place.ts`, the claims in `claims.ts`, the program in `glsl.ts`, the gust field in
  `gust.ts`, the composed sim in `sim.ts`, the code assembly in `code.ts`, the caps in `caps.ts`)
  and the `outdoor` composer: 84 layers in canonical order (`outdoor.ts`: 20 backdrops, 16 grounds,
  23 dressings, 7 covers, 14 life, 4 chores), their code by id in `outdoor-code.ts`. The `interior`
  composer (Phase 3): 27 layers (`interior.ts`: 8 backdrops, 6 grounds, 13 dressings), their code in
  `interior-code.ts`, the room's program in `room.ts`. The `overhead` composer (Phase 4): 19 layers
  (`overhead.ts`: 5 beds, 4 waters, 4 dressings, 2 covers, 4 life), its program and code assembly in
  `overhead-glsl.ts`, the layers' code in `overhead-code.ts`. All three share
  `composeScene`, the placer, the composed sim and the layers' turns (`turnsGlsl`, `passCalls`),
  and the per-program knob layout (`knobSlots` in `src/shaders/index.ts`, `checkKnobCaps`).
- **Presets:** meadow and bees (Phase 1); shore, dunes, autumn, lanterns and falls (2a); campfire,
  fireflies, forest, bamboo, garden and lake (2b); country, street, skyward, flock, swell and dew
  (2c); island (after Phase 2); sill and lava (the Phase 3 pilot), bonsai, incense, frost, bar,
  train and mobile; pond and ripple (the Phase 4 pilot), tidepool, sandtable and delta (4).
  `src/composer/budget.test.ts` holds that list.
- **Committed mixes:** "Bees · overgrown meadow" (the meadow's grass and wildflowers in the bees'
  garden), "Bees · in the valley" (the countryside's `valley` in place of the bees' hillside),
  "Sill · lava lamp on the sill" (the lava lamp standing on the sill, lighting the room), "Sill ·
  frost on the window" (the frost's glass layer on the sill's panes), "Ripple tank ·
  koi in the tank" (the pond's koi in the ripple tank's water) and "Swell · an island offshore" (the
  island standing out on the afternoon swell). The other mixes the
  waves planned ("Autumn maple by the lantern river", "Campfire in the meadow", "Fireflies over the
  apiary", "A campfire on the valley's hill") were not made: their layers are drawn through their
  own rigs alone (see "Rigs, locking and offering").
- **Not built:** the rest of the interiors (clouds and harmonograph; Phase 3); the rest of the
  `overhead` composer (its `tilt` and `orbit`, the `height` pass, the World over the patch beyond its
  rain and wind, and its presets after delta; Phase 4); packed trigger slots;
  `scripts/layer-costs.ts`, the stack meter and the role's "+" listing; the browser
  checks `composerDepth`, `composerClaims`, `composerWeather` and `layerToggles`; a check of the
  SwiftShader instruction budget; the principals' points in the site; shelving the presets by
  composer (D9).

## Decision summary

1. **Three composers share one layer contract.** `outdoor` is a pinhole over a floor, level or
   pitched; `interior` a room with a ledge and a window; `overhead` a patch of ground seen from
   above. A composer is a camera rig, a site and an order of composition, and the World is in all
   three (in a room, through its window; over the overhead's patch, not yet). `outdoor` is built;
   `interior` is piloted with sill and lava and runs bonsai, incense and frost (Phase 3),
   `overhead` is piloted with pond and ripple and runs the tide pool, the sand table and the delta
   too (Phase 4).
2. **A layer is a module.** Its manifest (`LayerDef`: role, bands, claims, the rigs it can be drawn
   through, its switch, knobs, passes and data) loads without its code (`LayerCode`: its GLSL built
   for the preset's rig, the chunks it shares with its scene's other layers, its sim). One steady
   switch keyed by its id turns it on, and its knobs hang on that switch.
3. **Composition is per-cell depth.** The composer generates the entry. Opaque passes write a cell
   behind a depth test and translucent ones veil it; the bands run far to front, the layers in
   canonical order, and each layer keeps its scene's painter's order inside its passes. The World's
   birds, fog, rain and snow are laid once, at the depth each cell shows.
4. **One light, one scale, one weather, one wind.** The World's sky times the preset's grade lights
   every layer, with the lights layers declare; everything is in metres in the rig's frame; the
   World's knobs are the only weather; one gust field moves what sways (D4).
5. **Space is claimed, not painted.** Layers claim the floor and take the first of their anchors
   that fits; a pure placer refuses, with a reason, a layer it has no room for.
6. **Scenes become scene presets** (D1): a composer, a rig, a grade, home layers and values, from
   which `composeScene` makes the scene.
7. **A layer set is a program, and a program costs what it holds.** Turning a layer on or off builds
   another program; no composer-wide all-features program is ever built. Under SwiftShader every
   line a program holds runs, so only compile-time gates remove cost. Budgets hold each program's
   size, uniforms and SwiftShader instructions.
8. **Sims share one frame.** One composed sim fans out to the layers' sims, which share a speck
   map, a records atlas and up to six field slots, and reach each other's state only through the
   affordances a sim declares.
9. **The lab shows layers by role:** a Layers section, each layer's sections under it, a chip per
   layer on in the compact bar.
10. **Chores are layers that act on a host layer's affordances**: the host owns the state and
    nature's undo, the chore the plan and the tool.
11. **A layer is drawn through its own scene's rig** unless it is drawn in metres from the ray of
    any rig in a declared span, as the meadow's layers, the murmuration and the valley are. Every
    preset that offers a layer pays for its knobs and trigger slots, on or off.
12. **Migration runs in phases.** Phases 0 to 2 built the `outdoor` composer and ported every
    eye-level scene; the interiors, the views from above and the matter shelf follow (see
    "Migration").

## The outdoor composer

### The rig

The `outdoor` rig (`Rig`, `src/composer/types.ts`) is a pinhole `eye` metres over the floor: the
horizon at uv.y `horizon`, `focal` screen heights per unit of slope, turned `turn` from the sky's
frame, `pitch` off the level, and `minAspect`, the narrowest frame laid out as itself (a narrower
one is laid out as if this wide and cropped; a layer whose `space.stretch` is set spreads across a
wider one, as the bees' garden does). The values are compile-time constants of the preset's
programs (`RIG_*`), so a preset's own layers draw as their scene drew them. The camera belongs to
the preset and has no knobs.

`RigPassage` moves the rig through the preset's entrance and exit: `lift` raises the eye (the
meadow's drop, with the gust front it sends), `shift` tilts the lens (`rigShift()`: shore, autumn,
falls, lake, country and swell), and its `glsl` may do more (the forest's dolly, `forestCamera`). A
passage that does what a rig cannot stays inside the preset's layers: the dunes' glide, the
street's tilt, skyward's tip toward the street.

Four kinds of rig are not a standing eye:

- **Raised level rigs** need nothing new: the countryside's hill (eye 30 m), the swell's (15 m, its
  sea worked in heights of that eye and its depths handed over in metres) and the dunes' (70 m).
- **Pitched rigs:** the street's window, 28 m up and pitched 0.733 rad (42°) down, and skyward's,
  lying on the road and looking up to 0.28 rad short of the zenith (`pitch` 1.29). The backdrop's
  `begin` gives each cell's ray and the floor's distance along it (`x.v`, `x.zg`), the plain floor
  stands where they say, and the backdrop names the axes the World's rain and snow are seen
  through (`precip.seen`). The World's birds fly a level camera's view: skyward compiles them out
  (`WORLD_BIRDS` 0 in `skyward/index.ts`) and flies the street's own pigeons and swifts on the
  World's birds knobs, and the street's window never shows their band at rest. Skyward's backdrop
  also takes over the World's fog (`x.w.fog` put out), laying it along each ray at the height it
  has climbed, and closes the floor (`x.groundTo` 0).
- **The macro rig:** dew's, 0.6 m up among the grass tops. The composer has no focal blur: every
  pass cuts its edges per cell, and one pass cannot blur another layer's output. Each dew layer
  draws its own defocus (the backdrop with nothing finer than a few cells, every thread and drop by
  its depth off the hub's), the backdrop's grass tops close the floor, and no layer of another
  scene is offered the rig, since a guest standing on the floor would be drawn sharp. The World
  arrives as light, colour and weather at the composed depth; its stars, cloud deck, painted
  cumulus and bolts are not drawn in the blur.
- **Views from above** are not an `outdoor` rig at all. Until the overhead composer, dunes'
  `camera` and garden's `gravelCamera` are steady structural knobs: at 1 the setting's features
  hold `DUNES_OVERHEAD` or `GARDEN_OVERHEAD`, and its own and all-features programs are the scene's
  own view from above (`dunesAboveGlsl`, `gardenAboveGlsl`), reading the fields the composed sim
  allocates for that layer set.

### The site

The preset names its floor's kind (`ScenePreset.floor`): earth, lawn, gravel, sand, rock, moss,
ice, snowfield, water or asphalt, each with an albedo, how porous it is and how well it holds
snow (`FLOORS` in `glsl.ts`). The composer draws this plain floor below the backdrop's land line
(`x.groundTo`, and `x.landZ` in depth) wherever no ground layer lies: lit by the key with the
clouds' and the claims' shadows taken out, by the layers' lights, wetted by `uWeather.x` and
snowed on by `uWeather.y` (water holds none and is drawn without the snow term). A ground layer
replaces it: the bees' lawn, shore's beach, the lake's ice.

### Layers

A layer lives in its scene's folder (`src/scenes/<scene>/layers.ts` for its manifest, its GLSL and
sim beside it). The composer's registry lists every layer in canonical order, by role: backdrops,
grounds, dressings, covers, the dressings that stand or fall on covers (dandelions, boughs), life,
chores.

| Role     | How many                                             | Built                                                                                      |
| -------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| backdrop | exactly 1; with none switched on the home one stands | one per preset (19): its sky staging, air, far land, and the rain's air                    |
| ground   | at most 1; without one, the plain floor              | 15: the lawn, beach, ice, river, gravel, the sea's swell, the farmland                     |
| dressing | any number; at most 2 `subject`s in the front band   | 22: the apiary, the campfire, the maple, the water clock, the shrine, the web              |
| cover    | any number                                           | 7: grass, wildflowers, litter, greenery, undergrowth, border, verges                       |
| life     | any number                                           | 12: the insects, fish, lanterns, kodama, the firefly swarm, the street's life, murmuration |
| chore    | any number, each with its host on                    | 4: gardening, cairns, rake, raking                                                         |

Bands say where a layer stands: far (beyond about 60 m), middle (6–60 m), front (within about 6 m).
The World is not a role: every composition has it, under its own knobs and gates.

`LayerCode` holds what does not load with the scene's metadata: `glsl(rig)`, the layer's functions
prefixed with its id; `shared`, the chunks (`SharedGlsl`) several layers of a scene compile in once,
each with an optional per-cell `begin`; and `sim(gl, params)`. A composed scene's code module
gathers every offered layer's code (`composedCode`), and `outdoor-code.ts` loads with the first
composed scene's code, never with the registry (D8).

### Claims and placement

A claim is a disc, a box with a turn, or a strip along points with a half width, in metres from
its layer's anchor, of one of three kinds:

- **exclusive:** no other exclusive or clearing claim overlaps it and no cover grows inside: the
  hives, the campfire's ring, the river's water, the forest's stream;
- **clears:** covers thin to nothing in its core and come back over 0.3 m (`CLEAR_FEATHER`); an
  exclusive claim may stand at its edge: the campfire's clearing, the park's path;
- **shared:** covers grow in by their `overgrowth` knob: the bees' drifts under the meadow's grass,
  and the forest's and the grove's canopies.

A claim may also cast a key-light `shadow` on the floor and on covers (`casterShadow`, the hives'
model; a layer may add shadow functions of its own, `casters`, as the orchard's crowns and the
maple do), give `shelter` (the share of rain, snow and lying snow kept off beneath it: the forest's
canopy 0.55, the grove's 0.5), `keepOut` life, or be `mustShow`.

#### Foreground conflicts

A pure TypeScript solver (`place.ts`) places the layers from the preset (its rig and home layers)
and the layers switched on, and nothing else: never the window's aspect or another knob. It takes
the home layers, then the guests, each in canonical order. A layer is refused, with a reason that
names what holds its place, when its role holds one already (a second backdrop or ground), a layer
kept before excludes it, its host is not kept, eight layers are kept already, the front holds two
subjects, none of its anchors fits (its exclusive and clearing claims overlap one placed, or a
`mustShow` claim leaves the rig's view at its `minAspect`), or its claims would pass twelve. A
later layer never moves an earlier one, so adding a layer never shifts what was there. A refused
layer keeps its switch on and is not drawn; the lab shows it refused, with the reason.

Placement is a function of what a program is built for, so the claims and anchors are compile-time
constants of the program (`coverAllowed`, `casterShadow`, `shelterAt`) and reach the sims as
`LayerFrame.ground`. Anchors are part of a layer's meaning: changing a shipped one moves things in
every setup that holds the layer.

#### Relations

- `excludes`: never on together (the lake's ice and the meadow's grass, wildflowers and
  dandelions). The lab switches the other off; in a link the one placed first stands.
- `suppresses`: turns off another layer's gate while both are on (`grass` turns off the lawn's
  `LAWN_BLADES`, so the front holds one sea of grass).
- `requires`: a host, for a chore or for any layer that draws on another (shore's beach on the
  sea, the falls' spray on the falls, every grove layer on the grove).
- The Manifold M: a layer names its M knob (`mark`); the lab keeps one on, and a program turns a
  later layer's M off while an earlier one's is on (`compose.ts` `rewrite`).

### Compositing

The composer generates the program's entry (`composerEntry`, `glsl.ts`); layers contribute passes
and never write the entry. A cell is `Cell { col, z, zs, accent }`: its colour, the depth of what it
shows (`WORLD_FAR` for open sky), the depth of the nearest thing standing above the floor (what
hides a speck), and its accent. `cellPut` writes where its depth is nearer and takes it once the
alpha reaches 0.5; `cellVeil` veils where nearer and keeps the depth. The entry runs:

1. The context (`composerCtx`): the World now, the arrangement seed (`K_seed`), the rig's ray
   through the passage's lens shift, the floor's distance, the gust state, the light; then each
   shared chunk's and each layer's `begin`, in canonical order (the backdrop's sets the air, the
   land line and how far the land reaches).
2. The backdrop's `sky`.
3. The far band: every `far` pass, then every `farVeil`.
4. The ground layer's `ground`, or the plain floor.
5. The middle band's opaque passes, the World's birds at the composed depth, the middle veils.
6. The front band's opaque passes, then its veils.
7. The shared speck map, against `zs`.
8. Every layer's `air` pass (a backdrop's forward scatter, a lamp's halo in the fog's air).
9. `worldFog`, every layer's `glow`, then the World's rain and snow at the composed depth.
10. The grade's vignette and exposure, the specks' palette snap, `shadeOf` with the grade's ink,
    then every layer's `shade` pass.

Opaque passes need no order across layers: edges are cut per cell (`hardEdge`; README "Hard
edges"), so coverage is 0 or 1 and the depth test decides. Soft alpha (fringes, glows, smoke) is
why there are bands and a canonical order. Each layer's parts keep their scene's painter's order,
standing at depths in metres, so the World's fog and rain fall between them: the campfire's parts
each stand behind what stands nearer (`c.zs`), the forest's over whatever nothing nearer has
covered (`forestStand`), skyward's against the facade behind them. A scene drawn as one march or
one trace keeps it as one shared chunk, whose parts its layers' passes put down: the countryside's
terrain (`COUNTRY`), the street's lit trace (`streetBegin`).

A layer turned on or off mid-scene plays its own entrance or exit (D12, `LAYER_ENTER` 1.2 s,
`LAYER_EXIT` 0.9 s) in a program that draws turns: row 0 of the records atlas holds each on layer's
turn, and every one of its passes is shown in a growing or shrinking share of cells, cut per cell
(`layerShows`). Each pass has one call site, because a software rasteriser runs every line: a
second call site ran shore's passes twice (1.8× its scene before the port, 1.16× after). No pass
sits under a branch either, which costs more than the pass (dew's backdrop: a tenth of its
program): a cell that does not show the layer drops the pass's result.

Programs come in two kinds (`COMPOSER_TURNS`). A steady one (every setting's own program) carries
no cut and no plain floor under a ground layer; one that draws turns, as every all-features program
does, is drawn while a turn plays or is on its way (`SceneSim.turning`), and on a GPU wherever the
all-features program stands in for a setting's own. Every program samples row 0 right after the
begins and uses the value until the grade: under SwiftShader that keeps the passes' code cheaper
(skyward's steady program costs 18% more without it, bees' 16%), so a steady one reads the first
texel and spends it on a test no texel passes. At their defaults the presets' steady programs cost
1–11% fewer SwiftShader instructions than the programs before the split, which all drew turns.

### Light, air and weather

- **Light.** `composerLight` is the World's sky times the preset's `Grade`: the sun's and the sky's
  tints, an ambient floor, and the moon as the key once the sun has set where the grade gives it a
  `moonlight` share (bees' model); then `exposure`, a `vignette` (round across the frame's width
  with `vignetteRound`, the campfire's) and `ink` for `shadeOf` (with `paper`, inkOf's paper
  white and range: dew's mist). Every layer is lit alike. A preset whose scene had a light of its
  own keeps it in its layers, read from the World's sky: the gorge's eye adapting to the dark, the
  forest's and the grove's canopy weather (`canopyWeather`), the garden's and the street's grey
  days. Guests there are lit by the composer's light, an approximation of theirs.
- **Local lights.** A layer declares lights (`LayerLight`, each a GLSL function and an optional
  gate), and `localLight(p, n)` sums those of the layers on; every layer lights its materials with
  it: the apiary's lantern, autumn's lamp, the campfire, the lanterns, the stone lantern, the
  street's shops and kerbside, the fireflies' glow and lantern. A light casts no shadow from one
  layer onto another; this is a stated limit.
- **The air** is the backdrop's (`Air`, set in its `begin`): the haze toward each bearing, the
  fog's and the rain's colours, the light the drops shine by, the sky wet things mirror, the dust.
  A backdrop may take a World part over and put the World's out: the dunes' desert lays its dust
  in place of the World's fog, the valley its valley fog on the World's fog knob, skyward its fog
  along its rays.
- **Precipitation.** The World's knobs are the only weather, laid once at the composed depth,
  thinned under `shelter` claims, and as the backdrop's `precip` says: `thin` (far, near) so the
  drops never bury a subject, `air` the colour the far rain fuses into, `seen` the axes a pitched
  rig sees them through. Layers' materials go through `wetten`, `wetGloss` and `snowCover` on
  `uWeather`.
- **The night sky** is the World's (D10): the campfire's giant is a planet of the World's list
  (`SkyPlanets.defaults`), its shooting stars the World's `meteors`; the fireflies' moonless night
  is the World's stars with the moon off, the bank's skyglow standing in for the World's dome
  (`worldSkyOver`, with `WORLD_DAYLIGHT` off). The lake keeps a night of its own: its far shore
  stages it on the World (its `begin` sets the World's sky to the lake's and relights the
  composer's light) and `lake/index.ts` compiles the World's stars, Milky Way, shooting stars,
  aurora, birds, painted cumulus, cloud shadows and lightning out while it stands, so the World's
  rain, snow and fog fall through the lake's night.
- **Wind.** One wind direction (`K_wind`) and one gust field (`gust.ts`: `gustAt` in GLSL with its
  CPU twin, the meadow's honami field), on the composer's knobs `gusts`, `gustRate` and the gusts'
  "now" (D4). It bows the meadow's grass and clocks, the bees' lawn and blooms, autumn's canopy and
  leaves, the bamboo culms, the garden's woods, maple, border and leaves, the forest's ferns and
  skyward's tree. Ten presets open with it off. It does not move what kept a breeze of its own: the
  fireflies' breeze (a single front, timed by `gustRate`, as strong as `gusts`), the lake's
  drifting snow, the dew web's breeze, a press in the bamboo grove, and the flock's reeds, which
  sway in the wind alone because one gust sample a cell cost a tenth of their frame.
- **Mirrors.** A ground that mirrors asks `composerMirror`: the backdrop's own view in a level
  mirror (its `mirror` pass: the temple grounds, the mangroves, the lake's far shore), else the
  World's sky, with the World's birds in it.
- **Scale** is metres in the rig's frame. A readability cheat is declared (`display.scale`: the
  apiary's hives at 1.5, D5), and the claims are sized as the layer is drawn. A scene in units of
  its own hands the composer metres: the garden's depths are 10 m each (`GARDEN_METRES`), the
  dunes' grid cells 5 m, the swell's heights its eye's.

### Hooks

What the ports added to the contract, each optional and each leaving the other presets' pictures as
they were:

| Hook                                                                                                               | What it does                                                                                                          | Used by                                                                                 |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `LayerSim.interest(aspect)`                                                                                        | where a press does something for the layer; the composed sim gathers every on-screen layer's, in canonical order      | the chores, the lanterns' drop-off points, the swell's boats and lamp                   |
| `LayerSim.affordances`, `LayerFrame.host(id)`                                                                      | another layer's state, narrowed by the caller with `instanceof`                                                       | the chores' hosts; the bamboo grove's sim, the fireflies' bank, shore's sea             |
| `RigPassage.shift`                                                                                                 | the passage's lens shift, `rigShift()`: the world read lower in uv                                                    | shore, autumn, falls, lake, country, swell                                              |
| `LayerDef.precip`: `thin`, `air`, `seen`                                                                           | a backdrop's say over the World's drops: their thinning, the far rain's air, a pitched rig's axes (`worldPrecipAxes`) | thin: sea, grove, woods, templeWall, city; air: seven backdrops; seen: crossroads, city |
| `shade` pass                                                                                                       | after `shadeOf`: an accent or a colour of the layer's own                                                             | sea, cliff, dunes, crossroads, openSea, roost, valley, fireflySwarm                     |
| `glow` pass                                                                                                        | after `worldFog`, before the rain and snow: light the fog does not veil                                               | the lighthouse's beams, the boats' lanterns                                             |
| `mirror` pass, `composerMirror`                                                                                    | a backdrop's view in a level mirror; the World's sky and birds where it has none                                      | temple, mangroves, farShore; asked by the river, the creek, the lake                    |
| `Flyway.dust`                                                                                                      | the World's birds hazed by the backdrop's dust (`composerMirror` does not take it)                                    | dunes                                                                                   |
| `Grade.vignetteRound`                                                                                              | a vignette round across the frame's width                                                                             | campfire                                                                                |
| `Grade.ink.paper`                                                                                                  | inkOf's paper white and range                                                                                         | dew                                                                                     |
| `LayerDef.season`                                                                                                  | the first offered layer's `season` knob is the composer's, with the climate in the World's gates                      | autumn, falls, garden, country (and bees, through the valley)                           |
| `SkyPlanets.defaults`                                                                                              | the planets a scene opens with: a link without the `planets` key holds them, `planets=` none                          | campfire's giant                                                                        |
| `worldSkyOver`                                                                                                     | `worldSky` over a dome of the scene's own, so the World's dome is never worked out                                    | the fireflies' mangroves                                                                |
| The World's settled gates: `WORLD_METEOR_RATE`, `WORLD_LIGHTNING_RATE`, `WORLD_MOON`, `WORLD_DAYLIGHT`             | each part a setting cannot show compiled out, drawing what the runtime path draws there                               | every composed preset                                                                   |
| Planet gates: `SKY_PLANETS_<KIND>`, `SKY_PLANETS_WIDE_RING`, `_MOONS`, `_AURORA`, `_LIGHTS`, `SKY_PLANETS_SEVERAL` | only the kinds, palettes and dress a planet list holds, a lone planet drawn straight                                  | every scene with planets                                                                |
| A preset's own gates over the composer's (`index.ts`)                                                              | the lake's night (`lakeNight`), skyward's `WORLD_BIRDS` 0, dunes' and garden's overhead programs                      | lake, skyward, dunes, garden                                                            |
| `ScenePreset.room`, `LayerFrame.room`, `<id>Anchor` (interior)                                                     | the room: the eye's distance to the seat line, the wall, its ambient and lamp; the seat and scale for sims; anchors   | sill, lava, bonsai; the lava lamp's sim and GLSL                                        |
| `LayerDef.casters`, `roomCaster` (interior)                                                                        | a layer's silhouette on the plane it stands in; the most of every on layer's, for a backdrop's shadows on its wall    | the bonsai's tree; asked by the veranda                                                 |
| `LayerDef.rayCasters`, `roomRayCaster` (interior)                                                                  | shapes hanging in the room's space: how much of a round light they hide from a point; the most of every on layer's    | the mobile's solar system; asked by its Sun's declared light for the quiet room         |
| `daylight` pass, `LayerDef.window` (interior)                                                                      | a window's light into the room (`roomLight`); a backdrop the World crosses, which lists the World's knobs             | cityWindow                                                                              |

### Rigs, locking and offering

A layer's `camera` gives the spans of eye, horizon, focal and pitch it can be drawn through; a
preset whose rig falls outside any span does not offer it (`admits`, `place.ts`). Most ports locked
every layer to their own rig: each span is the rig's own value (`ON_THE_HILL`, `ON_THE_BANK`),
because the scene was drawn for that pinhole and no other:

- its parts are laid out on the frame (autumn's `layout.ts`, the grove's corner where the clock and
  the lantern stand, the fireflies' lattice over the mangroves' crowns, the flock's skyline);
- it works in units of its own (the garden's depths, the swell's eye heights, the dunes' cells);
- it is one march or one trace that every layer's knobs feed (the countryside, the street);
- it keeps a light of its own, which a guest would not share.

A layer is offered to other rigs when it is drawn in metres from the rig's ray, so that any rig in
its spans draws it correctly:

- **the meadow's four** (`downs`, `grass`, `wildflowers`, `dandelions`), for any level standing
  eye of 1 to 2.5 m: offered to ten presets (meadow, bees, shore, lanterns, falls, fireflies,
  forest, bamboo, lake, autumn);
- **the murmuration**, for a level eye of 1.6 to 3 m with the horizon at 0.08 to 0.6 and a focal of
  0.9 to 1.4: it flies the same shares of the sky above any such rig's horizon, its M kept clear of
  the land (meadow, bees, shore, falls, flock);
- **the valley**, for the bees' garden's rig and the hill's: under the bees' rig it lies beyond the
  lawn's hedge, seen from the vantage's hilltop, and its program leaves out the hill's own parts
  (herds, walkers and carts, flower fields, the chalk M, ripples, bales, near crowns, the valley
  fog) to hold the 256 KB budget.
- **the island**, for its own camera and the open sea's: under the swell's level rig it is drawn
  from the ray, standing 220 m out (`ISLAND_OFFSHORE`) at a cottage's true size (6 m a unit, its
  own camera's toy island 2.2), without the shallows, swash and shadow that go with the island's own
  sea.

Offering is not free. Every offered layer's switch and knobs are knobs of the preset, and its "now"
buttons trigger slots, whether it is on or not: the meadow's four bring nine knobs and one slot to
each of their ten presets, the murmuration seven knobs and two slots to its five. A layer is
offered only where the preset still holds its knobs (see "Budgets and caps").

### Keys and links

- **A port keeps its scene's keys** wherever they are still unique in the preset. Every composed
  preset lists the World's 20 knobs, then the composer's (`gusts`, `gustRate`, `season` where a
  layer has a year, `seed`), every offered layer's switch, then every offered layer's knobs.
- **A colliding key is qualified** `<layerId><Key>` (D2): `composeScene` qualifies a key another
  knob of the preset already holds, and the ports qualified by hand in the manifest the keys a
  layer that might share a rig already holds (falls' `mark` as `cliffMark`, the grove's `mist` as
  `groveMist`). Layers that never share a rig may hold the same key: `mark` is the apiary's and the
  beach's, `ripples` and `drift` the dunes' and the lake's.
- **A layer's switch is its id**: a toggle, or the feature knob it grew from, keeping its amount
  (the lanterns' count as `lanterns-amount`, the flock's starling count as
  `murmuration-amount`, the garden's raking speed as `raking-amount`).
- **Keys that became the composer's** are renamed with the port: every scene's seed is `seed`, its
  gusts the composer's `gusts`, its date or season the composer's `season`.
- **No link is carried over:** no URL schema step, no alias, no key history. A setup made before a
  port replays on its own build (`/@<sha>/`). A committed preset that set a renamed key, or whose
  query's order changed, is rewritten with its `commit` moved to the porting build.

## Cost

### What a program costs

Under SwiftShader a program costs every line it holds, whatever a cell takes: an untaken branch,
an early return and a loop's body all run at least once. PlanetKinds measured it on the campfire:
the giant's drawing loop cost the same with no planet in the list (2.72 G instructions a draw at
320×200, against 3.03 G with one and 1.60 G with the planet code cut out), and wrapping it in an
`if` saved nothing. Only compile-time gates remove cost. Hence the World's settled gates, the
planet gates, the lake's and skyward's gates over the World's, the flock's skyline compiled in one
at a time (`ROOST_CITY`, `ROOST_REEDS`, `ROOST_SEA`), and the bees' beds compiled in only behind
`PRINCIPAL_CURSORS`.

The composer's own part is the context, the turn machinery and the plain floor. FirefliesFix
counted the fireflies' default program part by part (490 M instructions a draw, against 290 M before
its port; the parts, as it measured them, overlap and do not add up to the whole):

| Part                                                       | M instructions |
| ---------------------------------------------------------- | -------------- |
| Dithering and `main` (as before the port)                  | 78             |
| `worldAt`                                                  | 33             |
| View, light and gust                                       | 11             |
| The mangroves' and the fireflies' begins                   | 71             |
| The World's sky: stars, shooting stars, the bolt, the rest | 140            |
| The swarm's shade pass, the lantern pass, the creek        | 123            |
| The composer's turn machinery (shown, guards, the floor)   | 79             |

A guard can cost more than its lines: dew's around the web's list walk measured about 700 M of
6,354 M, without which the port measured 1.018× its scene. On a GPU a coherent branch is cheap; the
GPU budget is `bench.html`'s.

### Budgets and caps

| Limit                                      | Value                                                                                                                                                | Held by, and where the presets stand                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Layers on, the World not counted           | 8                                                                                                                                                    | `place.ts`; the largest home stacks hold 6 (autumn, campfire, country)                                                |
| Front subjects                             | 2                                                                                                                                                    | `place.ts`                                                                                                            |
| Claims a program holds                     | 12                                                                                                                                                   | `place.ts`; the apiary alone holds 11                                                                                 |
| Local lights                               | 8                                                                                                                                                    | `caps.ts`, not checked; no stack holds more than 2                                                                    |
| Sim textures                               | 8: the speck map, the records atlas, 6 fields                                                                                                        | `allocate` (`sim.ts`); the valley alone takes 4 fields                                                                |
| Knobs a preset lists                       | 512, `MAX_PARAMS`                                                                                                                                    | `checkKnobCaps` (`compose.ts`), `budget.test.ts`; bees 63, country 57, lake 52                                        |
| Knobs one program reads                    | 128, `MAX_PROGRAM_PARAMS`: the composer's and its eight largest offered layers'                                                                      | `checkKnobCaps`, `knobSlots`; `knobs.test.ts`                                                                         |
| Trigger slots                              | 8, the renderer's `MAX_TRIGGERS`                                                                                                                     | `compose.ts`, `budget.test.ts`; forest and lake 8, bees, shore and bamboo 7                                           |
| Shaken program at a preset's defaults      | 160 KB                                                                                                                                               | `budget.test.ts`; the largest, street, 129,136 characters                                                             |
| Shaken all-features program of a layer set | 256 KB                                                                                                                                               | `budget.test.ts`; country 253,359 characters, "Bees · in the valley" 252,886                                          |
| The pilot mix's all-features program       | 230 KB                                                                                                                                               | `budget.test.ts`; "Bees · overgrown meadow" 220,819 characters                                                        |
| Fragment uniform vectors                   | 224, WebGL2's guaranteed minimum                                                                                                                     | `scripts/glsl-check.ts`; of 211 programs measured, the largest 202 (sill, frost glass on; 205 before the knob layout) |
| SwiftShader draw at 320×200                | a preset's default program within 10 % of its recorded instruction count; a mix within its preset's count plus its guests' marginal counts plus 10 % | not checked yet; recorded: fireflies 490 M, campfire 1.63–1.65 G, dew 6,354 M                                         |
| Sim CPU time, whole stack, headless        | 4 ms a frame                                                                                                                                         | not checked yet                                                                                                       |
| GPU frame at 960×540                       | 16.7 ms on the reference integrated GPU, once one is recorded                                                                                        | `bench.html` (`SCENES.md`, "GPU cost on real hardware"), which has no `layers=` yet                                   |

**The SwiftShader budget is on the composed program itself**, counted, not timed: the user-space
instructions the GPU process retires per draw of the preset's default program at 320×200 (`perf`),
which repeat within about 1 % where wall time on the shared host swung by ±15 %. A preset's count is
recorded beside its shaken size and moves only on purpose, as `shake.test.ts` holds sizes. During
Phase 2 the yardstick was each scene before its port (1.15× its frame time); that program no longer
exists to compare against, and the ratio said nothing of a scene whose old program lacked what the
World and the composer add (the fireflies, 1.69× in instructions; the campfire, 2.7× in time until
the planet gates).

**The caps bind on offering, not on stacking.** A preset lists its own layers' knobs and every
offered guest's, so the bees' garden, offered the meadow's four, the valley and the murmuration,
lists 63 knobs, and the forest and the lake use all 8 trigger slots: one more layer with a "now"
offered to the forest or the lake makes the preset fail to compose (`ComposeError`); packed
trigger slots (32, numbered statically) are the way past, not built. Knobs take the per-program
layout: a program defines `K_<key>` only for the knobs it reads (the composer's, its on layers',
and any other its code names), packed into a `uParams` sized to them with a slot map the renderer
uploads through, so a preset lists up to 512 knobs and a program reads up to 128 ("Step 6's knob
layout, built" below).

### Programs: how many and when

- **A layer turn is structural.** A layer switch is a `LAYER_<ID>` gate in the feature key, so
  turning it builds another program in the background while the old picture keeps drawing: the
  new set's all-features program on a GPU, its own on a software rasteriser. A layer switched on
  enters in a program of the new set that draws turns (on a software rasteriser the setting's own
  drawing turns, then its steady program). A layer switched off plays its exit in a program of the
  set on screen that draws turns, which goes on drawing the new setting until then. While the lab
  is open that program is built ahead at rest, so the exit starts on the next frame: the set's
  all-features program on a GPU, the steady program's set drawing turns on a software rasteriser
  (one build per steady program); the page itself builds nothing ahead. A scene's own view (the
  dunes' and the garden's from above) draws no turns, so a layer turned there swaps programs.
- **A knob turn inside a layer set** draws with that set's all-features program on a GPU, built once
  in the background, and a software rasteriser builds the setting's own program, as for any scene.
  A turn that flips a settled gate (the moon, the day cycle, a planet's kind or dress) is such a
  turn.
- **A set is order-free:** its key is its `LAYER_*` gates.
- **Retention is the renderer's:** 4 programs a scene, 8 in all (`program-cache.ts`).
- **No composer-wide all-features program is ever built.** The second audit's shaker measured one
  for the fifteen outdoor scenes then named at 868 KB, against the countryside's 213 KB, which
  already took about 20 s to compile under SwiftShader.

### Checks

- **Built:** `budget.test.ts` (the ported presets, the shaken budgets of each preset's defaults, of
  the all-features program of each one-layer turn and of each committed preset, the knob and
  trigger caps); `place.test.ts`, `claims.test.ts`, `sim.test.ts`; `glsl-check.ts`, which also
  compiles each choice of a structural knob that is not a layer switch; each scene's ceilings in
  `src/shaders/shake.test.ts`; the Layers section's model and its browser check
  (`layers-model.test.ts`, `inspector.verify.ts`); `ab.ts` with `--turns` and `--presets`.
- **Not built:** `composerDepth` (with alpha rounded, the opaque passes in reversed order draw the
  same cells), `composerClaims` (no cover in an exclusive or clearing core), `composerWeather`
  (wetness and lying snow change every on layer), `layerToggles` (a layer turn never waits for a
  build), `scripts/layer-costs.ts` writing `src/composer/costs.json`, and the instruction count.

## Sims

The renderer sees one sim, the composed sim (`sim.ts`). Each on layer's `LayerSim` gets a
`LayerFrame`: the scene's clocks, size, pointer and principals, its own knobs under their short
keys, the rig at rest (`LevelCamera`) and the passage's lift, the placement (`ground`), the gust
field's CPU twin, its rows of the records atlas, its codes in the speck map, its field slots, and
`host(id)`.

| Slot | Texture                                   | Shared how                                                                                      |
| ---- | ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 0    | the speck map: rg8 at frame size, nearest | each layer a range of codes, one depth step (a quarter metre), every speck behind nearer things |
| 1    | the records atlas: `rgba16f`, 512 wide    | row 0 the layers' turns, then each layer's rows in canonical order                              |
| 2–7  | fields: any format and filter             | each layer's own, in canonical order                                                            |

The allocation is a pure function of the layer set on screen, the program the frame draws with
(`SimFrame.features`). A layer switched on but not yet on screen runs ahead at `dt` 0 and is copied
in the frame its program arrives. A layer's GLSL reads its data through the accessors the composer
generates (`<id>Record`, `<id>Field<k>`, `<id>SimOn`), never `uSimN`. GPU solvers keep their own
passes and hand their output to a field slot. A scene whose life is one simulation keeps it in one
sim and lends it: the grove's sim moves the culms, leaves, tube and rings, the mangroves' sim grows
the bank the swarm lives in, the maple's sim holds the park's leaves and piles.

## The lab

- **The Layers section** (`src/lab/layers.ts`, its rules in `layers-model.ts`): every switch
  carries a `{ kind: "layer", role }` widget, and they gather into one section after the World
  shelf, a row per role, a chip per offered layer: on, off or refused (switched on and not drawn,
  the placer's reason in its title and under the row). A backdrop's or a ground's chip swaps for
  the one of its role, the backdrop on stays on, and switching a layer on switches off what it
  excludes.
- **Layer sections:** a layer's groups carry `Blurb.layer` and show while it is on; a change left
  on an off layer still counts under the lens and comes back with the layer.
- **The compact bar:** the World's chips, the Layers chip, a chip per layer on lending all its
  sections (`Inspector.lend`), then Global.
- **Presets are the starting points.** Shuffle never turns a layer (switches are steady); undo and
  redo take layer turns like any knob; "Reset what changed" returns to the preset, layers included.
- **Not built:** the stack meter and the over-budget chip, the role's "+" listing with thumbnails
  and costs, and shelving the Scenes view by composer (D9): it is shelved by family
  (`src/lab/families.ts`).

## Principals and chores

Principals (I-20) are a renderer concept (`src/principals.ts`): the visitor is principal 0, then up
to three agents of a scripted cast that goes to the points the sims declare (`interest`). A
**chore** is a layer of role `chore` that `requires` its host and acts through the affordances the
host's sim exposes, reached with `LayerFrame.host`: the host owns the state and nature's undo, the
chore the plan and the tool. Chores are deterministic for the seed and stand still at motion 0.
The bees', shore's and autumn's act only through the cast's agents, so a page without agents draws
as before; the garden's has a default agent of its own, the unseen rake on the layout's plan, and
every hand dragged on the gravel rakes it too.

| Chore       | Preset | Host                         | Affordance                                                                               | Nature's undo                                   |
| ----------- | ------ | ---------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `gardening` | bees   | the apiary's beds            | `GardenBeds`: `dig`, `plant`, `weed` along a row                                         | weeds choke a bed left alone; the lawn takes it |
| `cairns`    | shore  | the beach                    | the sea's surf (`SeaSurf`, `host("sea")`) toppling stones stacked on `src/sims/stack.ts` | the bigger waves' swash knocks the cairns down  |
| `rake`      | autumn | the litter, the maple's park | `Park.rake`                                                                              | the gusts lift the piles                        |
| `raking`    | garden | the gravel                   | `Gravel.groove`                                                                          | the garden's drying and weather                 |

Star-joining is the World's (the `join` knob beside the constellations), and the shared table is
the harmonograph's own; neither is a layer. The principals' points in the site (the ground a
principal stands over, through the rig) are not built: chores read the cast's screen points.

## Migration

### Phases 0 and 1: done

Phase 0's prerequisites are in the tree: the function shaker and its compile budget, `glsl-check`,
the verify kit and the frame-rate contract, lazy scene loading (D8) and presence (I-20). Phase 1
built the composer and its first eight layers, with meadow and bees as presets: meadow `SAME`, bees
`SAME` but for its lawn moving in the shared gust field (13 % of cells, accepted by the operator
under D4). The pilot mix, "Bees · overgrown meadow", stands within its 230 KB.

### Phase 2: the rest of the eye-level scenes

Phase 2 ported the rest of the eye-level scenes in three waves: 2a, the World's adopters on level
rigs (shore, dunes, autumn, lanterns, falls); 2b, ground-level scenes with skies or canopies of
their own (campfire, fireflies, forest, bamboo, garden, lake); 2c, raised, pitched and macro rigs
and sky subjects (country, street, skyward, flock, swell, dew). Every port ran `ab.ts` against the
revision before it:

| Preset    | At its defaults (dithered) | Differences, attributed                                                                                                                       | SwiftShader, against the scene before |
| --------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| shore     | `SAME`                     | none: every witness `SAME`                                                                                                                    | 1.07–1.16× wall time                  |
| dunes     | `SAME`                     | `seed` reseeds the World's cumulus                                                                                                            | about 1.0× wall time                  |
| autumn    | 52 cells (0.23 %)          | the gust field (D4); the World's rain at the composed depth (D10)                                                                             | 1.06–1.10× wall time                  |
| lanterns  | 3 cells                    | a lantern's edge now blends with the near stone; the World's rain and birds                                                                   | 0.45–0.68× wall time                  |
| falls     | `SAME`                     | the World's fog (22 % of cells with fog on); the nearest drops dimmed as the World's                                                          | 0.70–0.89× wall time                  |
| campfire  | 7.2 %, the sky only        | the World's stars, Milky Way and shooting stars; the giant a World planet (D10)                                                               | 1.07–1.08× instructions               |
| fireflies | 1.1 %, the stars only      | the World's stars (D10)                                                                                                                       | 1.69× instructions                    |
| forest    | `SAME`                     | the World's rain, fog and snow                                                                                                                | 1.01–1.07× wall time                  |
| bamboo    | 7.2 %                      | the culms' sway in the gust field (D4): `SAME` with the old gusts swapped back                                                                | 0.93× wall time                       |
| garden    | `SAME`                     | the World's rain (5.5 %) and snow (2.8 %)                                                                                                     | about 0.86× wall time                 |
| lake      | `SAME`                     | the World's rain (new), snow and fog                                                                                                          | about 0.83× wall time                 |
| country   | `SAME`                     | the World's rain (19 %) and snow (79 %)                                                                                                       | 1.06× timer queries (worst 1.11×)     |
| street    | `SAME`                     | the World's fog, rain and snow                                                                                                                | 1.02–1.03× wall time                  |
| skyward   | `SAME`                     | the World's rain (1.4 %), snow (about 20 %) and fog (9 %)                                                                                     | 0.94× wall time                       |
| flock     | `SAME`                     | the World's stars at night, a cell or two                                                                                                     | 1.08× instructions                    |
| swell     | 5 cells                    | the gulls fly on the composer's `seed` (D10)                                                                                                  | 1.02× instructions                    |
| island    | `SAME`                     | night: 1 cell of the World's stars (D10); rain 44 %, snow 92 %, fog 36 % of cells: the World's darker grey day, its drops and its thinner fog | not measured                          |
| dew       | `SAME`                     | the World's rain (new)                                                                                                                        | 1.144× instructions                   |

What Phase 2 settled beyond its ports: the layers stay locked to their rigs unless drawn from the
ray (decision 11), the caps bind on offering, the SwiftShader budget is counted on the program
itself, and dew joined the composer (D7).

### Phase 3: the interior composer

**The pilot, built:** the `interior` composer (`src/composer/interior.ts`, `room.ts`,
`interior-code.ts`; README "The interior composer") with sill and lava as presets, and the mix
"Sill · lava lamp on the sill".

- **The room rig** is the outdoor `Rig` read as a level eye over a ledge (`eye` over its top), and
  `ScenePreset.room`: the eye's `distance` to the ledge's seat line, the back wall's albedo, the
  room's ambient and its lamp out of frame. The seat's height on the frame and the scale there
  (`roomFrame`: `ROOM_SEAT`, `ROOM_SCALE`, `LayerFrame.room`) follow from the rig. The room is laid
  out on the frame, as the scenes were painted: across in shares of the frame's width (anchors' and
  claims' x), up in screen heights. Sill: eye 0.35 m, 1.14 m from the seat, 0.8 screen heights a
  metre; lava: eye 0.248 m, 1.28 m, 1.9 a metre.
- **The site:** the composer draws the back wall, lit by the room's light (`roomLight`: its lamp,
  its ambient, the backdrop's `daylight` through its window, the layers' declared lights). The
  ledge is the ground layer (the sill, the sideboard).
- **The window is a backdrop drawn through its own rig (D11):** the sill's `cityWindow`, its city
  seen by the room's horizon and focal 10 m over the street. The World crosses its glass, sky and
  weather, in its cells only. A room lists the World only while it offers a window (`LayerDef.window`),
  never its birds (none fly a window yet), and no gusts or seed; its layers' trigger slots follow the
  World's two. The lava lamp's room shows no window and lists no World.
- **The order** is the canonical order, painter's: the begins, the wall, the backdrop's `far`, the
  ground's `ground`, every `middle`, `front` and `frontVeil`, the grade. A room keeps no depth (a
  stated limit); a layer's shapes throw shadows only where a backdrop asks for them (`roomCaster`,
  below), or, hung in the room's space, where a light asks along its ray (`roomRayCaster`: the
  mobile's).
- **The lamp's light is a declared light.** The lava lamp (`lavaLamp`) is drawn from the rig, 0.4 m
  tall on any room's seat line at its anchor, so it is offered to every interior preset; on the
  sill it takes its second anchor, the cat holding the first. Its `lavaLampLight` reaches the sill's
  wall, frame, sill, props, curtain and cat through `roomLight` and `localLight`. The sill's five
  layers and the lava room's papered wall and sideboard stay locked to their rigs.

**The bonsai, built:** three layers, the room's shell kept apart from its subject, all locked to
the bonsai's rig (`ON_THE_VERANDA`: eye 0.167 m, 1.19 m from the stand's top, 1.175 screen heights
a metre, the eye's height over its distance the display's tilt, 0.14):

- **The `veranda`** (backdrop): the wall (plaster, shoji or dark) with the window's patch of sun,
  the paper lamp's pool, the floorboards; its knobs the light (`time` and `cycle` its own, as the
  papered wall's moonlight is: a room without a window lists no World; `light`, `wall`, `lamp`).
  The **`stand`** (ground): the rosewood stand. The **`bonsaiTree`** (dressing): the tree in its pot,
  its sim's four textures as its fields, the falling snow its front veil.
- **Shadows on the wall are the room's** (`LayerDef.casters`, `roomCaster`): a layer that stands in
  the room declares its silhouette at a frame point on the plane it stands in, and a backdrop asks
  the most of every on layer's, seen from each of its points toward each of its lights. The veranda
  asks it toward the sun and toward the lamp, so the tree's shadow is no longer drawn by the wall's
  own code. The pot's and the stand's boxes on the wall and the stand's shadow on the floor stay the
  veranda's, gated by those layers, because the scene's lamp threw the tree's shadow alone.
- **The caps:** the bonsai's five "now" slots run 0 to 4 (its room lists no World: below, "The
  caps"); the lava lamp, offered to it, stands only while the tree is off (their fields pass six).
- **At its defaults** `SAME` (`ab.ts` against 47e062d9, dithered and `view=source`); further
  witnesses, all `SAME`: shoji, pine and the lamp at dusk; winter in the dark alcove under heavy
  snow; cherry in the unglazed pot, the sun from the left, the kintsugi M on. The shaken default
  program is 58,003 characters; its all-features program, which plays the layers' turns, 60,500.

| Preset    | At its defaults (dithered)                                             | Differences, attributed                                                                                                                  |
| --------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| sill      | `SAME`                                                                 | none; the World's knobs replace the sill's sky and weather (Milky Way, cumulus, cloud shadows new and off)                               |
| lava      | `SAME`                                                                 | none                                                                                                                                     |
| bonsai    | `SAME`                                                                 | none                                                                                                                                     |
| mix       | 1,434 of 23,040 cells against the sill (6.2 %): the lamp and its light | the lamp on the sill, its warm light on the wall, the frame, the sill, the props and the cat                                             |
| incense   | `SAME`                                                                 | none                                                                                                                                     |
| frost     | `SAME`                                                                 | none; the World's knobs replace the frost's sky and weather (rain, fog, lightning, cumulus, cloud shadows and the Milky Way new and off) |
| frost mix | 2,101 of 23,040 cells against the sill (9.1 %): the frost on the panes | the rime along each pane's edges and the condensation over the glass; the sill's city unblurred behind it                                |
| bar       | `SAME`                                                                 | none; the knobs gathered in their layers' sections                                                                                       |
| train     | `SAME`                                                                 | none; the knobs gathered in their layers' sections                                                                                       |
| mobile    | `SAME`                                                                 | none; the knobs gathered in their layers' sections, the shell's first                                                                    |

**The incense, built:** three layers, the shell kept apart from the subject, locked to the
incense's rig (`ON_THE_TABLE`: eye 0.3 m, 1 m from where the incense stands, 1.2 screen heights a
metre): the **`shaftWall`** (backdrop: the dark plaster, the window's light lying on it as a tall
pane, the M of lamplight, the hazy shaft as its front veil; its knobs the light), the
**`lowTable`** (ground) and the **`incense`** (dressing: the burner, the candle, the smoke and the
motes, its fluid's four fields). The smoke's and the holder's shadows on the wall go through
`roomCaster`: the incense declares its silhouette, the wall asks it back along the window's light,
the second backdrop to throw the room's shadows. The cell's state (the window's light, the shaft,
the smoke's shadow down it) is the scene's shared chunk. The placer now refuses a layer whose
textures would take the stack past its six fields (`COMPOSER_CAPS.fields`; the allocation threw
before): the lava lamp the incense's room offers (eye 0.3 m) stands only while the incense is off,
their four and three fields passing the six. At its defaults, dithered and `view=source`, and four
witnesses (coil, candle and late sun; washi and the M; the waterfall burner, steep light, umber,
dust; the cone, window off, candle) `SAME` against 113498b3. Its programs: 39,286 and 41,848 shaken
characters (ceilings 43,000 and 46,000: the room's program frame).

**The frost, built:** the window kept apart from what lies on its glass. The **`frostView`**
(backdrop, a window, locked to `AT_THE_PANE`: eye 0.15 m over the window's bottom rail, half a
metre from the pane) draws the frame and, through its own camera 1.8 m over the street (D11), the
street or the cabin under the World's sky and snow, blurred and bent by the frost; the World's light
on the room's side of the glass is its `daylight`. The **`frostGlass`** (dressing) is the first
**glass layer**: a window backdrop says where its glass is (`LayerPasses.glass`, `roomGlass(x)`:
how far inside it from its four edges), the room paints every layer's `farVeil` over the backdrop
and under all that stands in the room, and a layer marked `LayerDef.glass` is offered only where a
window with glass is (`compose.ts`). The frost's rime forms along the glass's edges, so on the sill
it gathers along each of the six panes; it is lit by `roomLight` and by what shows through the
glass (a guest window's view is its own, unblurred: a stated limit). The room's grade gains the
frost's soft roll-off (`Grade.rolloff`), and the frost holds the World's cloud deck at every
setting (its view's fair-weather cover). At its defaults (dithered and `view=source`), its two
committed presets and two witnesses (fur, condensation and sparkle up; the cabin in a blizzard)
`SAME` against 113498b3; "Frost · aurora over the cabin" is rewritten for its query's order. Its
all-features program is the World's every gate now, 126,601 shaken characters (ceiling 139,500).

**The bar, built:** five layers, the shell kept apart from the subject, all drawn through the bar's
own pinhole (its eye 1.5 m over the floor, panned on narrow frames, moved by the pointer and the
passage: `barBegin`, the scene's shared chunk) and locked to its rig (`IN_THE_BOOTH`: the booth
table's far edge the seat line, eye 0.33 m over its top, 1 m to it, 0.85 screen heights a metre).
The **`storefront`** (backdrop, the shell: the front wall and its window onto the rainy street, the
column with the coat and the dripping umbrella, the tin ceiling, the floor, the back wall's bare
panelling; the street's and the rain's knobs), the **`booth`** (ground: your table, its candle,
coffee and whisky; nearest the eye, its front veil), the **`backBar`** (dressing, the subject: the
mirror wall, the bottles and the M, the bartender, the counter and its glasses, the stools and the
patrons; its sim's one field schedules the evening), the **`pendants`** (the four lamps, their
light on the room with them) and the **`ceilingFan`** (the fan, its bowl's light and the blades'
shadows on the tin with it). The street is the window's own view under the bar's own rain: the
storefront is not yet a `window` (its sim reads the rain for the umbrellas; the World's rain
through it is U2's), so the room lists no World, and it has no `glass` pass. The room's grade
gains the vignette's reach (`Grade.vignetteReach`: the bar's from 0.5, the train's from 0.5 to 1.05
across 1.25). At its defaults (dithered and `view=source`) and three witnesses (closing time, one
patron, cold lamps, soft bokeh; no rain, the fan and the candle off, the neon M; heavy traffic in a
downpour and wind, the jukebox up, the sign off) `SAME` against e60dc623. Its programs: 114,615 and
117,194 shaken characters (ceilings 122,500 and 129,000: the all-features program is the composer's
turns).

**The train, built:** four layers, the window's view kept apart from the compartment, locked to its
rig (`BY_THE_WINDOW`: the table's back edge under the window the seat line, eye 0.265 m over it,
0.7 m to it, 1.17 screen heights a metre). The **`nightLine`** (backdrop: through the glass the
country sliding past under the night sky through the view's own pinhole, the rain on the pane, the
snow banked at its foot, the compartment mirrored in it; the journey's sim its one field; the
journey's, line's, country's, birds', sky's and weather's knobs, the M stars; its gates the shared
moon's phase and the calm cloud deck), the **`compartment`** (ground: the frame round the glass,
the laminate wall, the curtain rod and the walnut table, lit by the reading lamp), the
**`teaGlass`** and the **`velvetCurtain`** (dressings). The cell's state (the journey, the sky's
light, the rails' knock, the compartment's light) is the scene's shared chunk (`trainBegin`). The
view keeps its own sky and weather and the room lists no World, as the bar's; its planets are the
preset's. At its defaults (dithered and `view=source`) and three witnesses (noon on the mountain
line in heavy rain at full speed; a dark lamp, full reflections, no tea or curtain, the M stars in
snow; the rural line, no cloud, stations every stretch, the aurora) `SAME` against e60dc623. Its
programs: 144,396 and 191,566 shaken characters, within its standalone ceilings (154,000 and
199,000).

**The mobile, built:** two layers, the room's shell kept apart from the mobile, both drawn through
the mobile's own pinhole (`mobileBegin`, the scene's shared chunk: the eye 3.3 m over the floor
looking down about 26°, swayed by the pointer, and where the cell's ray meets the wall, the floor or
the ceiling) and locked to its rig (`UNDER_THE_SUN`: the wall's foot the seat line, eye 3.3 m over
the floor, 4.4 m to it, focal 1.41, pitch 0.448). The **`quietRoom`** (backdrop, the shell: the
plaster wall, the oak floor, the ceiling, the window's dim light, the M of glow-in-the-dark stars,
and the night room falling away toward the picture's edges as its front veil; `room`, `fill`,
`mark`) and the **`solarMobile`** (dressing, the subject: the Sun on its cord and its ceiling rose,
the arms, the planets, Saturn's rings, the Sun's glow; the mobile's sim its one field). **The
shadows are the room's, in a 3D form:** the Sun is the solar system's declared light
(`solarMobileSun`), the quiet room lights its surfaces through `localLight`, and the light asks
`roomRayCaster(P, L, r)` from each point toward itself, the most of every on layer's
`LayerDef.rayCasters` (`float <fn>(vec3 P, vec3 L, float r)`: how much of a round light the
layer's shapes hide from P); the solar system declares its balls, wires, links and rings. The
planets' shadows on one another stay the mobile's own. Its cost: a manifest field and a dozen lines
of `room.ts`'s generator, `roomRayCaster` declared only while a layer on declares one, so every
other room's program is unchanged; in the mobile's the same trace runs behind two more calls. It is
the hook U2's two
shadowing lights can ask once the shell is in metres. The lava lamp, offered, finds no room: the
quiet room claims the floor, its room being in the mobile's metres, which nothing drawn on the
frame shares. No mix: the mobile is drawn through its own camera, and the lava room's would need
it redrawn from that rig at another scale. At its defaults (dithered and `view=source`), its three
committed presets and two witnesses (crisp shadows from a bright bulb, a compact mobile in a strong
draft from the left, no window light; the daylight room, the inner planets with the motor off, the
whole globe's soft shadows from a dim Sun, the M of stars at full glow) `SAME` against 768cbbd2;
sill, lava and bonsai `SAME` beside it. "Mobile · inner planets, glow stars" and "Mobile · dwarf
planets, daylight" are rewritten for their query's order. Its programs: 34,175 and 36,484 shaken
characters (31,358 standalone; ceilings 39,000 and 40,000: the room's program frame, and the
composer's turns in the all-features program).

**Still to build:** clouds and harmonograph as presets; the World's birds through a window;
the World through the bar's storefront and the train's window; depth across a room's layers, and
shadows on another layer's surface than a backdrop's, once two layers that overlap need them. What
Phase 2 changes for them:

- **The window's view is drawn for the window (D11).** Outdoor backdrops are locked to their own
  rigs (the street's `city` to a window 28 m up and pitched down), so a room's window draws a view of
  its own through its rig, as the sill's city is.
- **The caps.** No slot is held for a knob a preset does not list: a room with a window numbers its
  layers' trigger slots from 2, after the World's two; a room without one from 0. The bar's six and
  the train's six run 0 to 5 and the lava lamp's two (its cold start and its M) fit beside them, so
  the lamp is offered to every room (the eye-height workaround that kept it from the bonsai's is
  gone); the frost glass brings one to every room whose window has glass. The fullest rooms leave
  two: the bar and the train (six each) and the sill (the World's two, its neon, its cat and the
  frost's, five). A guest with more slots than a room leaves waits for the packed trigger slots.

### Phase 4: the overhead composer

**Built, the pilot:** the `overhead` composer (`overhead.ts`, `overhead-glsl.ts`,
`overhead-code.ts`) with pond and ripple as its presets and the mix "Ripple tank · koi in the
tank" (`scene=ripple&koi=1`):

- **The rig** (`OverheadRig`): orthographic, `span` metres a screen height and `minAspect`;
  straight down, so no march is compiled in. A layer's `camera.span` says the spans it is drawn at
  (`admits`), and the placer's view test is the frame's rectangle.
- **The site** is two roles beside the outdoor's: a `bed` (exactly one, as a backdrop: the home one
  stands with none on; the plain bed under one mid-turn) and a `water` (at most one, as a ground;
  without one the bed is dry). The water layer's `begin` sets the surface every pass reads from
  `Patch x`: its slope (`x.slope`), where the bed is seen through it (`x.floorP`), its depth, its
  current, its colour and the light it gathers on the bed (`x.caustic`); the bed draws at
  `x.floorP`. The light (`x.sun`, `x.power`) is the pond's sun until a layer's begin sets its own:
  the pond's water sets the pond's knobs' sun, the ripple tank its lamp. The tank's waves are its
  water layer's sim (`tankWaterSim`: the wave equation's view, the next experiment's while it
  fades in, and the fixtures' layout, three fields), so any life layer swims in them.
- **The order** (`Spot` cells, each pass in canonical order): begins, `bed`, `water`, `floor` (on
  the bed through the water), `cast` (the most of every layer's shadow on the bed, darkening what
  lies there once), `swim`, `float`, `stand`, `cover` (`c.shade`), `glint` (not where `c.dry`),
  `over`, `grade`. The order is the pond's painter's order cut at its seams, which is what keeps
  its picture: the pads' and the koi's shadows were one `max` in the scene and stay one.
- **The layers:** `pondBed` (the floor and its weeds), `pondWater` (the water, its sun, the rings,
  caustics and glint, the current, and what floats: pads on their stems, petals, the paper boat),
  `stone` (the Manifold stone), `border` (the plants and canopy, their shade and the rays through
  them, the breeze), `koi`; `tank` (the screen or table, the tray, the lamp's ramp) and `tankWater`
  (the waves and the experiment, which needs its tank). The pond's layout pass is split: the
  water's lays out the pads and petals, the koi's their loops. The ripple tank's "now" slots are
  read from its knobs rather than fixed at 0, 1 and 2.

**The knobs.** The pond has 51 knobs of its own (not 50); with the World's 20 it passes the
renderer's 64. The pilot takes the cheapest way the ADR named, further: the overhead composer lists
no World knobs and no knobs of its own (no gusts, season or seed: the pond's breeze, year and seeds
are its border's and its water's), because nothing of the World is drawn over the patch yet. The
pond's knobs are trimmed into its layers, each knob in the layer that reads it, its feature knobs
`koi` and `stone` becoming those layers' switches; it lists 54 (its 51, and `pondBed`,
`pondWater` and `border`), the ripple tank 18 (its 11, `tank` and `tankWater`, the koi's five).
Neither needs the per-program knob layout; the whole World over the patch (its sky, cloud and light
seen from above) will, for the pond.

**The World's rain and wind over the patch** (W1 step 1): an overhead preset that offers a layer
open to the sky (`LayerDef.open`: the pond's water and border, the tank's water, the tide pool's
bed and water) lists the World's `rain` and `wind` first (`worldPatchKnobs`, the outdoor keys and
meaning), and `WORLD_RAIN` is its only World gate, so a dry patch compiles none of the rain; the
sand table, under its lamp, lists neither. The wind is the patch's `x.wind` (`|K_wind|`); the
border's own `wind` became it (the pond sets 0.4, the tank and the tide pool 0, the breezes they
had), and the tide pool's own `rain` became the World's, so there is one rain. Every drop is an
impulse on the water: the pond's analytic rings land at each site of a grid on a fixed beat (the
amount gates only which beats land, so no ring runs backward as the rain eases) and sum their
slopes and light with its own; the tank's wave sim takes small dimples at hashed places on its
`FixedStep`, and the wind pushes it from a field of puffs in gusts; the tide pool's shallow water
takes splats on its step, hashed from the step count and the rock's seed, which it had not before
(its rain only drew rings over the sea), lit on their crests, and the wind roughens its ripples.
The pond lists 55 knobs, the tank 20, the tide pool 37. Defaults, the committed presets of the
tank and the tide pool, the pond with stone and canopy, and the sand table are `SAME` against
4bf629be; the pond without its border differs in 8 cells, the World's wind now ruffling its glint
where the border's breeze was still. Under SwiftShader at 640×400 the pond's default draws 16,764
M instructions (16,774 before) and at rain 1 17,566, the tank's 1,411 either way (its rain and
wind are the sim's), the tide pool's default 6,412 (6,799 before: its rain was compiled in dry)
and at rain 1 7,955 (7,930 before).

**At their defaults:** pond `SAME`, ripple `SAME`, "Ripple tank · walled tank" `SAME` (`ab.ts`
against 3819c80c, dithered). Further witnesses, all `SAME`: the pond with the stone, canopy, current
and sand bed on; with its year, growth, gusts and koi following; with no koi, plants or pads on
slate at full depth; with the sun moved on screen in a full breeze; the tank as a surface under the
safelight, and at another focus. The shaken programs grew: pond 42,308 → 44,379 characters, ripple
18,233 → 20,724 (the composer's prelude, and the still water the tank lays before its water's
begin); their ceilings in `shake.test.ts` were raised with them.

**The tide pool** (tidepool, after the pilot) is five layers: `rockPool` (the bed: the rock laid out
per seed by its sim, its zones, sea lettuce, sea stars, urchins and pebble M, and the shore's sky by
the time of day and the rain, which lights the patch), `surge` (the water: the GPU shallow water
over the bed's rock, which it reaches through the bed's affordances, its surface and the light
through it, its white water, night glow and the passage's wash, and the life's records it streams),
`fronds`, `anemones` and `fish` (life on the water's records, so each needs the water). What lies
on the bed before the light is the shared chunk's `tpB`: the bed's, then each life layer's `floor`
pass over it in the scene's order, relighting the cell where it paints. Its frame is 3 m tall like
the pond's, so the rig and the layers gained `salt`: a layer is offered only over its own water,
which keeps the pond's 55 knobs off it and the koi out of the sea. Its default, its three committed
presets, rain with fish and the M, and granite at dawn are `SAME` against 47e062d9; its shaken
default is 50,001 characters (within its ceiling), its all-features program 52,896 (ceiling 58,000).

**The sand table** (sandtable) is four layers: `sandBed` (the bed: one height field with two
finishes, the ball's fine sand or the pendulum's slate, its rim and the floor, and the table's pace,
run of drawings and "next drawing"), `tableLamp` (the low lamp, a dressing: without it the patch's
light rakes the table from the lamp's height), and two subjects that exclude each other, `ball`
(home: the steel ball, its drawings, its M and the agents' rake) and `pendulum` (offered). One bed
with two finishes, not two beds: both machines work one height field under one lamp in one rim, and
the slate shows only where the pendulum has not yet trickled sand. The bed's sim holds the sand and
lends it through its affordances to the machine on the table, which lays its opening table once the
other has swept its own away, works it and settles it in the scene's order; so a switch between them
plays the one's sweep as its exit and the other's arrival as its entrance. A machine's shadow comes
off the lamp's light in its begin, as the scene drew it, rather than through the composer's `cast`
darkening. Its frame is 0.93 m tall (the ball a one-inch ball), below the koi's metre, so nothing
else is offered. Its default, its committed preset, the pendulum on slate and on ochre in a brass
rim, the M under a low lamp on black sand, and rimless at full depth are `SAME` against dfc9c2dc;
its shaken default is 23,168 characters (23,891 before), its all-features program 26,250 (ceiling
29,000, new).

**The delta** (delta) is three layers: `deltaBed` (the bed: the land and the sea's bed, laid out per
seed by its sim for the frame's shape, its plants, fields and rock M, and the palette and relief the
picture is drawn in), `deltaWater` (the water: the river and the sea on the GPU, shallow water over
the bed it erodes and silts, its floods and the hands that dig or bank the land) and `clouds` (a
cover, offered: the fair-weather clouds and their shadows, the delta's own weather until the World
is drawn over the patch). The land and the water work each other every step, so they cannot be two
sims stepping apart: the bed lays the landscape out and affords it (`DeltaLand`), the water runs the
coupled river, sea and bed over each new layout; each binds the same two views of the ground, the
water's live, the bed's of its layout lying dry, which the bed draws when the water is off. The
dig is the water's (it works the bed in the GPU state), reading the bed's `tool`. Its frame is
20 km tall (the river half a kilometre wide), and its open water is the sea, the river's fresh
water running into it: the rig and its layers are `salt`, and at that span nothing else is offered
anyway. The span is used only by the placer's offering and view tests, so kilometres need nothing
more of the rig. Its default (dithered and `view=source`), infrared, the chart, clouds over both,
the M with the bank tool, a high sea on another landscape without plants or fields, and a muddy
full river without tide against the current are `SAME` against e60dc623; its shaken default is
20,908 characters (18,850 before), its all-features program 23,779 (ceiling 26,000, new).

**Not built yet:** the `tilt` feature and its march (a tilted rig's march costs its full length
under SwiftShader wherever it ends, so the gate, off, keeps it out), the `orbit` range, a `height`
pass and a bed height field shared across layers (the pond's and the tank's beds are flat, the
tide pool's relief its own layout's; the water's slope is the only relief they share), a material
at each point, the rest of the World over the patch (its sky, cloud shadows, fog, snow; the
delta's rain and wind), and the presets after delta: `dunesabove` and `gardenabove`, which retire
the dunes' `camera` and the garden's `gravelCamera` and their own programs. Layers drawn in the
frame's units are locked to their span; the koi are offered from 1 m to the pond's 3 m, drawn at the
frame's scale (11–17 cm fish in the 1 m tank), so a bench-scale layer is refused beside the delta's
20 km by its span.

### Phase 5: the matter shelf, and what stays standalone

- **Optional (D7):** petri, physarum, marble, chladni, ferro, film and pearl, as dishes, plates and
  boards on the interior's ledge or the overhead's bench; decided after the interior baseline.
- **Standalone:** fractal, hyperbolic, orbit, shanshui, prism and pendula keep their own
  `SceneDef`, full-screen (D24): a pure field, a tiling, outer space, a painted scroll, a beam and a
  row of pendulums have no space to share.
- **Kelp** stays standalone until an underwater baseline has a second variant.

## Baselines and variants (U2)

#1082 item U2, ratified by the operator on 2026-10-18 (D13–D24): each composer gets one baseline,
and every scene becomes a variant stored as its differences from it, so improving the baseline
improves every variant.

### Three tiers

- **The baseline** (D13), one per composer: `Composer.baseline` beside its `layers`. It holds what a
  scene preset holds but its identity: the camera at rest, the grade, the World's options, the floor
  or the room's shell, the shell's home layers, values and elements. Each is also a lab-only scene
  (`room`, `land`, `patch`), outside the tour and the public cycle, to load and compare against.
- **Curated variants** are today's scenes (D14). A `Variant` names its baseline (`base`, a composer
  id), keeps its identity (id, title, blurb, accent, look, theme, passage, planets) and holds only
  its differences: layers added or removed, knob values, elements, the camera's rest pose, a grade.
  `variantPreset(baseline, variant)` makes the `ScenePreset`, so `composeScene`, ids, cards,
  thumbnails and links stay as D1 has them. A variant never names another; a test refuses a
  redundant difference, so no variant keeps a copy that would hide a better baseline.
- **Saved presets** stay minimal queries over a variant: the committed ones in `src/presets.ts`, the
  local ones in the browser, the operator's experiments.

**A pinned commit keeps its meaning.** On `/@<commit>/` a query resolves against that build's
baseline and variant, so it looks as it did; on the head it shows the baseline as it is now. Variant
ids are never reused for another picture; a baseline change never moves a commit; a renamed key
still rewrites the committed presets that set it and moves their commit ("Keys and links").

**Promotion** (D15) makes a saved preset a curated variant with its own id, card and thumbnail and
`from` (its commit and query) as provenance. "Promote" copies the entry, the query folded into the
variant's differences (switches into adds and removes, `elements=` into elements, the rest into
values), for a preset that loads as itself on this build. The entry goes into
`src/composer/<composer>-variants.ts`, and the source preset is removed.

**The lab tree** (D9 as amended, D16): the Presets view shelves by composer, each a tree of its
baseline, its curated variants and under each its committed and local presets ("saved here", with
Promote); standalone scenes stand apart. The committed presets' tag "baseline" becomes "committed".

### The camera

A live pose (D18: position offsets, eye height, yaw, pitch, focal) rides in one packed URL key,
`cam=`, uploaded as `uCamera` outside `uParams`; `RIG_*` stays the rest pose. `CameraRange` gains
`x`, `z` and `turn` spans, and a `tolerance` about the rest pose for layers painted on their frame.
Layers drawn from the ray (the World, the meadow's four, the murmuration, the valley, the lava lamp,
the koi; the mobile and the bar once ported) read the live pose; painted layers read only the offset
within their tolerance, as they take the pointer's parallax. The pose is held to the intersection of
the on layers' ranges, the shell's included: a drag clamps the camera, home layers whose ranges do
not meet are a `ComposeError`, and a guest out of range is refused with its reason, never moving the
camera. Overhead: pan and span live, yaw for layers in metres, tilt still a gated march.

### Light elements

An **element** (D17) is a placed light: `{ kind, at, colour, power, reach, flicker, shadow }`, a
window, lamp, candle, neon, fire or screen, `at` in metres in the composer's frame and free to stand
out of it (as `Room.lamp` does). In frame it draws a small body of its kind; its flicker runs on
`uMotionTime`, still at motion 0 and under reduced motion. A link carries a variant's elements in
one packed key, `elements=`, read as `planets=` is. Kind and count are compile-time (adding one
builds a program, as a layer turn does); place, colour, power and flicker are uniforms.
`localLight(p, n)` sums the layers' lights and the elements unrolled to the count; a layer is lit by
elements once it calls it, which every shell layer does and every port adopts. **The cap**, fixed
from the marginal SwiftShader cost on the sill (320×200, user-space instructions a draw): 8 lights a
program with the layers' own, at most 2 of them windows and at most 2 shadowing (the World's key
through a window and one element, as the bonsai's veranda throws `roomCaster` toward its sun and
its lamp), the shadows on the back wall and the ledge's top; checked when composed and on a link.
A point light with its body costs about 31 M (no elements 897 M; 1, 4 and 8 candles 927, 1,018
and 1,146 M), so 8 add 10% to the sill's default (2,374 M with its window and lamp); a window's
light about 285 M (a second, on the left wall), as much as 9 point lights, hence its own cap; a
shadow no more than the noise (about 10 M); two windows and six candles, the most a program holds,
2,796 M, 18% over the default. A framed picture or TV showing a standalone scene fits as a `screen`
and waits (D23).

### Window light, palette and time

**The World drives a room's light** (D19, D20). The baseline room has a `facing`, the yaw from the
staged sky's ahead to the room's forward (`Rig.turn` outdoors). A window element stands on the back,
left, right or front wall; in frame on the back wall it draws its frame, glass and view (D11),
elsewhere it only lights. Through its rectangle the sun (`skyFacing(sky.sun, -facing)`) lays a patch
on the wall or the ledge at its colour less the overcast, the moon at its phase's light; the sky
adds diffuse light greyed by the overcast; rain dapples the patch, snow brightens the room,
lightning flashes it and the aurora tints it. A shaft shows only in a layer's smoke or dust
(`windowShaft`). A room with no glass in frame compiles a light-only World. Every baseline lists the
World's date at one anchor, rooms included, and **a variant may pin its hour or date through its
values** (the lava lamp's room stays at midnight with its moon up). Light's colours, the climate and
the page theme follow the World; a variant's own grade is a `Partial<Grade>` over the baseline's,
data in code (D21).

### The interior baseline

The room's shell, from the sill's, the lava room's and the bonsai's layers, drawn from the rig in
metres: a **wall** with materials (plaster, the papered rings, shoji, a dark alcove, panelling)
taking the window's patches, the lamps' pools and `roomCaster`'s shadows; a **window** (clear,
drops, frost or steam) and its **view**, a backdrop of its own (none, city, street, snowy street or
cabin, the moving line); one **ledge** with kinds (sill, sideboard, stand, table); its light from
elements. Its default is an empty room at dusk with the sill's rest pose. Sill, lava, bonsai,
mobile, incense, frost, bar and train are its variants; the bar's `night` stays its evening's
schedule (D22).

### The World seen from every camera

The World's hour, sky and weather are one state, and every camera shows it. A composer never drops
the weather; it renders the weather in the way its camera would see it. Outdoors, this is built: the
sky, cloud, rain, snow, fog, lightning and wind. Indoors, the weather is seen through the window: drops on the
glass, the light under overcast, lightning's flash, and the snow's brighter light. From above, the
rain and the wind are built: every drop rings the water as an impulse in its sim or its analytic
field (the pond, the ripple tank, the tide pool), the rings crossing, and the wind roughens the
surface; not yet the wet darkening on the bed, cloud shadows crossing, fog as a veil or snow
settling, which wait for the rest of the World over the patch.
Underwater it would show as rain dimpling the surface, the light dimmed by overcast, lightning
through the water, and the surge of the wind. Each camera a baseline adds, and each new kind of
weather, is accepted only once it is rendered for every camera that can be in it.

### Falling things (W1)

#1082 item W1, step 2, built (2026-10-19) as far as the edge drips: one pool of falling things for
every layer on (`composer/falling.ts`, README "Falling things"), in the composed sim.

- **On the CPU.** Layers name their drip points and surfaces from their own sims each frame, and a
  landing reaches another layer's sim. A pool on the GPU would need to read both back every frame.
  A few hundred particles step on the CPU in a fraction of a millisecond.
- **Drawn as points into the speck map.** Each particle is plotted in the cell its rig-frame position
  projects to, at its depth, under codes of the composer's own, after every layer's
  (`Allocation.falling`; no texture slot, no trigger, no knob). The outdoor speck pass colours them
  (`fallingSpeck`) and hides them behind nearer things, so no layer loops over them per pixel.
- **The contract.** A layer's `falling` declares the kinds it lets fall (`drop`, whose codes compile
  in while it is on) and how far they slide with the pointer's parallax. Its sim calls
  `LayerFrame.falling.drip(lane, x, y, z)` and `.surface(...)`: a plane, a ledge strip, or water,
  which strikes the named layer's `FallingWater` through its affordances. A preset whose passage
  shifts the lens gives `RigPassage.shiftAt`, the CPU twin of `rigShift`.
- **The physics.** Drops fall under gravity and drag toward the air: the wind, plus the gust
  field's load where they are (D4). Each lane's beat is fixed on the pool's step count, and the
  World's rain and wetness only pick which beats let go, at the rate the shared edge drips had.
  Nothing can run backward as the world dries (`4bf629be`). A drop that lands splashes, with a
  crown and droplets, and leaves a wet mark that dries, or it strikes the water. The pool steps
  on a `FixedStep` at the fall clock's pace, with chance drawn from the step count, the lane and
  the seed. The renderer hands sims the world's weather (`SimFrame.weather`).
- **First user: the waterfall's bank ferns.** Each frame they name drip points under their fronds'
  outer leaflets. Each side's bank top (poolFront's `bankTop`, its CPU twin) is a run of short
  ledges that the drops land on. The shader's `rainDrips` for the ferns is gone. Differences:
  the defaults are `SAME` (`ab.ts --base 1d9460ef`, 960×600). In rain at its default amount 0.5,
  10 cells of the still frame differ: beads at drip points the old lanes did not draw. In motion,
  drops now fall the whole way to the boulders and splash there, where the old streaks faded out at
  the fronds' roots.
- **Cost.** SwiftShader, M user-space instructions per 320×200 draw, median of six rounds, base →
  head: 2,116 → 2,107 at the defaults, and 2,570 → 2,567 in rain 0.5. Composed sim, headless, at
  480×300 cells: 0.024 → 0.038 ms a frame dry, and 0.024 → 0.049 ms in rain 0.5.
- **The drops' light.** A drop is a lens (`fallingSpeck`, at the speck's depth, which the speck pass
  hands it). Its head, a bead and a splash show the brightest light behind and over the eye at its
  own brightness, the brighter of `x.air.drop` and `x.air.deck`, plus 0.4 of the key while it is up
  and the lamps at the drop (`localLight`). Its body passes a third of what lies behind it: a cell
  either side of a head two cells across, painted with the streak's code (no new code), and the
  streak, so it reads as a darker rim and trail against the spray. A wet mark darkens the stone by
  up to 45% and glints with the sky on up to 30% of its cells, both fading as it dries. The first
  rule (heads at 1.1 × the World's rain's drop light) drew them on the palette level of the spray
  behind the ferns. Now, at rain 0.7 and 0.2 (`rain=1&rain-amount=…`; `rain=0.7` alone is the
  switch, on at the default 0.5, and `rain=0.2` is off), heads
  and crowns show light grey under the closed deck and white in sunlit drizzle, and marks a dark
  dash with a glint. The falls' defaults are `SAME` (`ab.ts --base c14f1c9f`); the still frame at
  rain 0.7 differs in 3 cells, a bead's rim. SwiftShader: 2,117 → 2,109 at the defaults and
  2,567 → 2,570 in rain 0.7. The bench binds no speck map, so that is the program's code alone;
  only the few cells a falling thing covers run its colours.
- **Leaves: autumn's maple (2026-10-19).** The `leaf` kind: a crown (`FallLeaves`) gives a rate
  that only gates the pool's per-step beats (`4bf629be` again cannot happen), fills each leaf in
  from the leaf's own `hash31` stream, and names the air its leaves fly in at each step's moment;
  `leaf(lane, …)` lets one go at once and `aloft(lane)` counts them. A leaf is the shared
  fluttering plate on the pool's fixed step; it comes to rest on the highest surface under it, eases
  flat, and joins the litter its surface names where that layer's `FallingLitter.lay` takes it
  (`Litter.deposit` now says whether it laid the leaf), else lies 8 s and fades. It is drawn as its
  outline, from a mask per outline, through its plate's two axes, one code a cell: 8 hue bands of
  the layer's palette × the face shown, flat or on edge (32 codes, after the drops'). The layer
  names its palette (`LayerFalling.leaf`, `mapleLeafSpeck`), declared ahead of the layers' GLSL; the
  speck pass hands it the speck's depth for the canopy's shadow. The 512 particles hold a park's
  leaves many times over; nothing about the speck map's encoding changed. The Park keeps its knobs,
  air (swirl, passage flurry and whirl), shower, pickups and carpet; its record row and the shader's
  36-slot loop over it are gone. Differences: autumn's still differs in 290 of 144,000 cells (the
  leaves in the air, `ab.ts --base c14f1c9f`, 960×600); every other scene `SAME`. A leaf has no
  veins any more, its hue is one of 8 bands, it falls on the fall clock (still at motion 0 even
  through a passage), a new seed lets the leaves already in the air finish their fall, and with
  the litter off a leaf lies and fades instead of vanishing. Cost:
  SwiftShader, M user-space instructions of the GPU process per presented frame of the lab page at
  960×600, base → head: 20,429 → 9,843 at the defaults, 20,449 → 9,858 with the leaf fall at 1 and
  strong gusts. Composed sim, headless, 480×300 cells: 0.054 → 0.138 ms a frame at the defaults,
  0.087 → 0.173 ms at leaf fall 1.
- **Not built yet:** petals, seeds, flakes and sparks; the interior's and the overhead's draw (a
  room keeps no depth, and its program has no speck pass); the other scenes' leaf and drip code
  (bonsai, dew, meadow, campfire, garden, bamboo, `rainDrips` and `canopyDrip` elsewhere).

### Order of work

| Step | What                                                                                                                        | Accepted when                                                                                                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | The interior's variant model, no picture change: `Composer.baseline`, `Variant`, `variantPreset`                            | `ab.ts` `SAME` for every interior default and committed preset; `budget.test.ts`, `presets.test.ts` and the redundancy test pass                                                           |
| 2    | The interior's shell in metres, window light from the World, `elements=`, two shadowing lights, the light-only World        | before and after images of the eight rooms with diff shares, changes of character flagged; per-variant SwiftShader counts recorded; 1, 4 and 8 candles measured, the cap fixed and checked |
| 3    | The interior's camera: `cam=`, ranges, clamping, refusals                                                                   | `SAME` at the rest pose; every layer draws within its range; a guest out of range refused with its reason; the mobile moves freely                                                         |
| 4    | The lab tree (D9) and Promote                                                                                               | the tree shows baselines, variants and presets; a promoted preset's variant draws `SAME` as its query did                                                                                  |
| 5    | The outdoor baseline (the World, `downs`, the plain floor at a standing eye), its presets as variants, `localLight` adopted | each preset's differences attributed, as in Phase 2; budgets hold                                                                                                                          |
| 6    | The overhead baseline, after the per-program knob layout and the World over the patch                                       | the same, for the overhead presets                                                                                                                                                         |

**Step 1, built (2026-10-19):** `Baseline`, `Variant` and `LightElement` (`types.ts`),
`Composer.baseline`, `variantPreset` (`compose.ts`) and the interior's baseline (`interior.ts`): an
empty room at dusk at the sill's rest pose, its window onto the city over the bare sill (`cityWindow`
and `sill` on), the sill's room, the World at 0.8 over the city, the plainest ink the rooms share
(the incense's and the frost's, 1.25 and 1) and no vignette, no elements (`variantPreset` refuses
any until step 2 draws them). The eight rooms are variants in their folders' `index.ts`; every one
but the sill removes the baseline's window and sill for its own shell layers and brings its camera
and its room (`Variant.room`, the per-room `Room` until the shell is one in metres), and the frost
pins its winter night through its values (`time`, `clouds`, `snow`). Its lab-only scene `room`
(`labOnly`, `sceneCycle` in `src/lab/families.ts`) is in the Scenes view, outside the tour and
`[` / `]`. `ab.ts --base 214b15ae --presets`: `SAME` for the eight defaults, dithered and
`view=source`, and all 61 committed presets, the sill's mixes and the rest of the indoor ones among
them; the eight rooms' default and all-features programs, knobs and lab metadata are byte for byte
as before; `interior-variants.test.ts` refuses a redundant difference.

**Step 2, built (2026-10-19):** the shell (`composer/shell.ts`) draws the back wall (in plaster,
papered, shoji, alcove or panel), a back-wall window element's casing, reveal, sash and bars (its
view a backdrop inside `roomWin`) and the ledge (sill, sideboard, stand or table) from the rig in
metres; sill, `room` and lava stand on it. Light elements ride in `elements=`, their kinds and count
compiled in, their values in `uElements`, summed by `localLight`; in frame a lamp, candle, neon tube
or fire draws its body (a table lamp, a wax pillar and its flame, a tube, tongues over a bowl).
Each window lets in the World's sun, moon and sky from `Room.facing`, its patches barred and
dappled, its key throwing `roomCaster`'s shadows, and gives back a soft fill so the wall it stands
in is lit. Bonsai and incense take the World's sun or moon through a window element in place of
their `light`, `angle` and `tint` knobs but keep their painted wall and ledge; frost, bar, train
and mobile keep their own shells. A room with no glass in frame lists and compiles the light-only
World (time, cycle, moon, rain, snow, lightning, aurora and wind, the lightning's trigger slot
alone). Every room that lists the World lists its date at 0.62, where the climate is warm, so rain
stays rain at every default; the frost pins midwinter (its snow in season), and the bonsai's tree
takes the World's snow, one snow. **The cap** (D17, as above): 8 lights, 2 windows, 1 shadowing
element, checked in `checkElements` when composed and `fitElements` on a link (`elements.test.ts`).
Before and after (`ab.ts --base ecbf21d5`, 960×600), cells differing at the default, noon, night
and in rain: sill 17, 30, 21 and 14%; `room` 13, 22, 14 and 11%; lava 9, 11, 11 and 10%; bonsai
29, 32, `SAME` and 70%; incense 5, 18, 6 and 5%; frost `SAME` but in rain (6%: midwinter's rain
falls as snow); bar, train and mobile `SAME`. Changes of character: the sill and the room at noon
are lit by the sun's patch through the window (in summer the sash's and the bars' shadows lie on
the sill); the bonsai's shadow falls the other way, its sun now on the World's arc through the
window behind the eye, and rain greys its room; the lava lamp's moon pane is sheared by the moon's
slant through the left window, where it was a painted square. SwiftShader counts (M user-space
instructions a 320×200 draw at the defaults, one run, before → after): sill 2,046 → 2,394, `room`
1,470 → 1,735, lava 649 → 913, incense 911 → 1,068, bonsai 1,560 → 1,580, frost 1,823 → 1,852,
bar 4,979 → 4,975, train 4,021 → 4,052, mobile 876 → 887; absolute counts move 5–8% between runs,
ratios within one run about 1%.

**Step 3, built (2026-10-19):** the camera (`composer/camera.ts`). A pose about the variant's rest
rig (x, y and z offsets in metres, yaw, pitch, the focal's factor) rides in `cam=` (base64url
varints of thousandths, read as `elements=`: no key, the rest pose) and reaches the shader as
`uCamera` (2 vec4) under the gate `ROOM_POSE`, so a room at rest compiles as before and a camera
off rest builds one program, moving further building nothing. `CameraRange` gains `x`, `z`, `turn`
and `tolerance`: the shell holds a third of the way to its back wall (`shellPoseRange`); the
mobile's two layers their room under its ceiling; the lava lamp a turn of 0.3 rad; the city
through the sill's window any pose (drawn from the cell's direction); every painted layer (sill,
lava's room, bonsai, incense, frost, bar, train) `PAINTED`, 3 cm across, 2 up, 5 in, about a
degree. Off rest the shell meets the live ray plane by plane, painted layers read the cell pulled
back to the seat's plane, the mobile traces from its moved, turned and zoomed eye. The pose is held
to the intersection of the shell's and the on layers' ranges (a link's to the home layers', the
lab's Camera section's to every placed layer's, shaded on each slider's track); home layers that do
not meet at the rest pose are a `ComposeError`, a guest out of range is refused with its reason and
the camera stays (`camera.test.ts`). `ab.ts --base 36bc94dd`: `SAME` for the nine rooms' defaults,
dithered and `view=source`, and the ten interior committed presets. SwiftShader counts (M a 320×200
draw, median of six rounds, one run, before → after at rest → posed): sill 2,388 → 2,382 → 2,406
(within its tolerance), `room` 1,715 → 1,720 → 1,739 (30 cm left, turned 0.12 rad). The mobile's
pointer picking (`mobile/sim.ts`) still casts from the rest eye.
The lab dishes (the matter shelf) are decided after step 2.

**Step 4, built (2026-10-19):** the Presets view is the tree (`src/lab/tree-model.ts`,
`src/lab/presets.ts`): a shelf per composer, the interior's baseline room (tagged "baseline") and
its variants (tagged "variant", or "promoted"), each with its committed presets (tagged
"committed", D16) and those saved here under it; outdoor and overhead shelve their scenes at the
top until steps 5 and 6, the standalone scenes on a shelf apart. A variant's "Compare with
baseline" sets the A/B slots to `a.scene=room` and the variant as B. Promote (D15,
`src/lab/promote-model.ts`) folds a room's preset that loads as itself (and holds no lab setting,
planets or pose) into its room's differences, drops the values the baseline holds, checks that the
variant's defaults are the query's setup, and shows and copies the entry;
`scripts/promote.ts <query>` writes it into `src/composer/interior-variants.ts` (its scenes in
`src/scenes/promoted/`, no folder), adds its compile budget to `shake.test.ts`, removes the
committed preset and regenerates the scene docs. "Sill · lava lamp on the sill", promoted on a
scratch tree as `silllava`, drew `SAME` as `scene=sill&lavaLamp=1` at `36bc94dd`
(`ab.ts 'scene=silllava~scene=sill&lavaLamp=1'`, dithered and `view=source`); no preset is promoted
in the tree yet.

**Step 6's knob layout, built (2026-10-19):** the per-program knob layout that step 6 waits on. A
program defines `K_<key>` only for the knobs it reads: the composer's (the World's and its own),
its on layers' (each switch and its knobs, `SceneDef.knobsFor`, from the program's `LAYER_<ID>`
gates) and any other knob its code names (`knobSlots` in `src/shaders/index.ts` scans the year
define, the libraries and the program's GLSL). The last are needed: a chunk shared by several
layers names a knob of one that is off (the night line's lamp and tea glass, the incense's stick
in the shaft wall's program, the bar's back bar, pendants and fan, the sill's cat in the room's),
and `SKY_YEAR` a layer's season or year cycle (the bees' `year`, the tidepool's `season`); without
them 31 of 211 programs failed to compile. `uParams` moved out of `common` into the knob defines,
sized to the program (`ceil(n / 4)` rows, one at least). The program cache keeps each program's
slot map and an upload buffer of its length (`SceneProgram.knobs`, `params`); the renderer packs
the knobs through it (`packParams`) when the settings change; the lab, the URL, the sims and the
rate phases keep the preset's whole list. `checkKnobCaps` (`compose.ts`) refuses a preset listing
more than 512 knobs (`MAX_PARAMS`), or whose composer's knobs and eight largest offered layers'
pass 128 (`MAX_PROGRAM_PARAMS`); `knobSlots` refuses a program past 128. No program grows: of the
211 programs `glsl-check.ts` builds for bees, meadow, country, autumn, sill, frost, bar, pond,
tidepool, delta, falls, street, room, lava, bonsai, incense, train, mobile and lake, each uses 0
to 6 fewer uniform vectors, the largest 202 of 224 (sill's all-features with the frost glass on,
205 before); bees' default 42 (45), its all-features 174 (177). Shaken programs shrink by 34 to 60
characters (`shake.test.ts` ceilings unchanged). `ab.ts --base 94463a6a --size 960x600 --presets`
over those twelve presets, `scene=meadow&wildflowers=1`, `scene=pond&canopy=1` and every
committed preset: 75 `SAME`, 0 differ. `knobs.test.ts` holds both caps at their boundaries and
each composed program's defines (at its defaults and each one-layer turn, steady and
all-features) against the composer's, its on layers' and the knobs its code names.

### Amendments

- **D7 and Phase 5:** prism and pendula are standalone, full-screen, with fractal, hyperbolic, orbit
  and shanshui; the matter shelf keeps petri, physarum, marble, chladni, ferro, film and pearl.
- **D9:** by composer, as one tree in the Presets view (baseline, curated variants, their presets),
  standalone scenes on a shelf of their own.
- **D9, again (2026-10-19):** the Scenes view shelves by baseline too, once the outdoor and the
  overhead baselines are built: each baseline (`room`, `land`, `patch`) a shelf with its variants
  in a row and the setups saved here in that row as "custom", the standalone scenes apart; between
  variants of one baseline the lab keeps the World and blends rather than loading another scene.

### Decisions D13–D24

| #   | Question                              | Decision                                                                                                                                                                                                             |
| --- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D13 | Is each baseline a scene?             | Yes, lab-only (`room`, `land`, `patch`): outside the tour and the public cycle.                                                                                                                                      |
| D14 | How deep variants go                  | One level, baseline then variant; saved presets stay queries over a variant.                                                                                                                                         |
| D15 | What promotion makes                  | A curated variant: its own id, card and thumbnail, `from` provenance; the source preset removed.                                                                                                                     |
| D16 | The lab's tag on committed presets    | "committed", no longer "baseline".                                                                                                                                                                                   |
| D17 | Light elements                        | One packed key, `elements=`; kinds and count compiled in, values uniforms; 8 lights, at most 2 windows and 2 shadowing, fixed from 1, 4 and 8 candles on the sill (about 31 M instructions a light, 285 M a window). |
| D18 | The camera                            | A live pose in `cam=`; spans per layer, a tolerance for painted layers; the camera clamped, guests out of range refused.                                                                                             |
| D19 | A room's light                        | `facing` on the room, set by a variant; windows on any wall; the World's sun, moon, sky and weather light the room through them.                                                                                     |
| D20 | The date                              | Every baseline lists the World's date at one anchor; a variant may pin its hour or date; no glass in frame, a light-only World.                                                                                      |
| D21 | A variant's grade                     | Data in code; grade knobs after the per-program knob layout.                                                                                                                                                         |
| D22 | The bar's `night`                     | Its evening's schedule, apart from the World's hour; the variant pins the hour at night.                                                                                                                             |
| D23 | A picture or TV of a standalone scene | Later; the `screen` kind leaves room for it.                                                                                                                                                                         |
| D24 | Prism and pendula                     | Standalone (D7 and Phase 5 amended).                                                                                                                                                                                 |

### Open, not yet decided: the countryside behind the bees

None of the countryside's options reach "Bees · in the valley". The `valley` is offered to the bees'
rig (`OVER_THE_VALLEY`, `country/layers.ts`), but its seven parts (`waterway`, `farmland`,
`settlements`, `verges`, `herds`, `travellers`, `starlings`) only to the hill's (`ON_THE_HILL`): a
guest valley reads their knobs at the countryside's defaults (`valleyValue`) and compiles out what
is small that far off (`countryGlsl`). The parts would add 28 knobs to the bees' 63, and the
mix's all-features program stands at 252,886 characters of 256 KB. Three steps: (a) the per-program
knob layout, which the overhead baseline needs too (built: a preset lists up to 512); (b) the parts
offered to the bees' rig, so river, farmland, settlements and herds are tuned from the garden; (c) a
far level of detail for the valley as a backdrop, making today's guest cut a rule that holds the
budget.

Bolder, decided after (a)–(c): **the outdoor baseline's land is the countryside**, each outdoor
variant standing somewhere in its 3.2 km (`COUNTRY_MAP`), as the garden already stands on the
vantage's hilltop. That is coherent for the meadow, the bees, the country, autumn, the forest, the
campfire, the falls, dew and the flock's reeds; not for shore, swell, the island, the dunes, the
frozen lake, the mangroves, the city's street and skyward, nor in character the temple garden, the
grove and the lanterns. The land's `shape` (`TERRAIN_BASES`: valley, coast, plateau, hills) might
take some: the coast's bay for the sea scenes, the plateau's gorge for the falls. Every outdoor
program would carry the valley's march, and the flat floor would need the land's height.

An idea for later, not planned: in one land, the passage between two outdoor variants could carry
the camera from one vantage to the next across the valley instead of the dissolve between their
programs, the arriving variant's own layers entering as layer turns do (D12). It rests on the shared
land, the live pose (D18) and the far level of detail.

Also later, not planned: an **underwater** baseline (a camera below the surface, light absorbed with
depth, the sky only through Snell's window, the World's weather seen from below), kelp its first variant and the pond's koi from the
side, the lake under its ice or the swell under its boats candidates, built once a second variant is
wanted; and **above the clouds** as an interior variant, a seat by an aircraft window whose view is
the outdoor World at cruise altitude over a cloud deck, once a window can show another composer's
live view.

## Risks

1. **The caps bind on offering.** The forest and the lake use all 8 trigger slots; every further
   cross-offering of a "now" waits for packed triggers. Knobs no longer bind there: the
   per-program layout lets a preset list 512 and each program reads its own (the bees list 63,
   the pond 55 with its rain and wind alone).
2. **Rig-locking limits the mixes.** Of the outdoor presets' 84 layers, seven are offered beyond
   their own rig; of the interior's 11, the lava lamp, drawn from the rig; of the overhead's 19, the
   koi beyond their own span (over fresh water only). Five mixes are committed. The worth of
   composing grows only as layers are redrawn from the ray (or, from above, in metres).
3. **Shared chunks couple layers.** The countryside's layers are switches and knobs over one march
   (`VALLEY_*` macros), the street's over one trace whose turn cut assumes its four layers are the
   only ones the rig offers; neither can be offered elsewhere as it stands.
4. **Software rasterisers pay for everything a program holds.** The World's sky and the composer's
   turn machinery cost in full at every cell; the fix is a compile-time gate, and each gate is
   another program a knob turn may build. Audit I-10's lite mode (a poster on software renderers)
   matters more.
5. **Program size.** The countryside's all-features program and "Bees · in the valley" stand
   within about 9 KB of 256 KB, and only `bench.html` on real devices sees a mobile driver's limits.
6. **Shared fields change scenes.** The gust field, the World's stars, fog, rain and snow and the
   arrangement seed make ports close rather than `SAME` (D3, D4, D10).
7. **Knobs that do nothing.** A preset lists every World and composer knob, so some move nothing
   there: the lake's hour and day cycle, cumulus, cloud shadows and lightning while its far shore
   stands; skyward's `birdFormation` and cloud shadows; dew's stars, cumulus and fair-weather cloud;
   the gusts where nothing reads them (the dunes, the lake, the flock).
8. **Placement stability.** Anchors and claims are part of each layer's meaning; a careless change
   moves things in every setup that holds the layer.

## Decisions

The operator ratified D1–D12 on 2026-10-17 and D13–D24 ("Baselines and variants") on 2026-10-18. D1–D12 as they stand:

| #   | Question                            | Decision as it stands                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | How a scene becomes a preset        | Its id stays and its `SceneDef` is generated from a scene preset (`composeScene`): card, thumbnail, family, tour step and links unchanged, so `ab.ts` compares like for like. No aliases.                                                                                                |
| D2  | Layer knob keys                     | Keep each scene's keys where unique in the preset; qualify a collision `<layerId><Key>`, automatically within a preset and by hand where a layer might share a rig. No dotted keys.                                                                                                      |
| D3  | Pixel identity per port             | `SAME` for every part a scene keeps; a difference stands when it is attributed to a shared part taking over (D4, D10) or to a named fix, with its diff image inspected. Weather a scene never had compares against nothing. A part missing, moved or lit differently fails at any share. |
| D4  | One gust field                      | The meadow's field is the composer's, and what sways in it sways together; a breeze that is a scene's own subject stays its own (the fireflies', the dew web's, the lake's drifting snow), and a preset may open with the gusts off.                                                     |
| D5  | Readability scale cheats            | Allowed when declared (`display.scale`), with the claims sized as drawn: the apiary's hives at 1.5.                                                                                                                                                                                      |
| D6  | Caps and budgets                    | The table under "Budgets and caps", with the SwiftShader budget counted in instructions on the composed program, not as a ratio to the scene before its port.                                                                                                                            |
| D7  | What stays outside the composers    | Fractal, hyperbolic, orbit, shanshui, prism and pendula standalone (amended by D24); dew composed, locked to its macro rig; kelp standalone, an underwater baseline later; the matter shelf optional.                                                                                    |
| D8  | Lazy loading                        | Done: a scene's metadata loads without its code, and the layers' code loads with the first composed scene's.                                                                                                                                                                             |
| D9  | How the Scenes view shelves presets | By composer, as one tree per composer in the Presets view: baseline, curated variants, their presets (amended under "Baselines and variants"); not built.                                                                                                                                |
| D10 | Scenes with skies of their own      | Folded into the World with staging hooks (the campfire's giant and meteors, the fireflies' night over `worldSkyOver`); the lake keeps its own night, staged on the World and its sky parts compiled out while its far shore stands.                                                      |
| D11 | Interior windows                    | A live view through the glass, in window cells only, drawn through the window's own rig. The World crosses the glass; an outdoor backdrop crosses only once it is drawn from the ray of any rig in its spans.                                                                            |
| D12 | Turning a layer on or off           | Plays its own entrance or exit, cut per cell (1.2 s and 0.9 s), never a cut.                                                                                                                                                                                                             |

## Alternatives considered

- **Status quo, with more shared components.** Rejected: it gives no mixes, and every new scene
  repeats a camera, a ground and a grade.
- **One scene per composer, with a `preset` key.** Rejected (D1): every link would write every
  value where its preset departs from the composer's defaults, every committed preset would be
  rewritten into the composer's form, and the composer's own defaults would be arbitrary.
- **One all-layers program per composer.** Rejected by measurement: 868 KB shaken for the outdoor
  scenes, against a countryside of 213 KB that already took 20 s to compile under SwiftShader.
- **Deferred layers.** Each layer would draw into its own colour-and-depth target and a fixed pass
  would composite them: each layer compiled once, a scissor at its footprint saving work even under
  SwiftShader. Rejected for now: it breaks the one-pass budget (README "Art direction"), the
  five-channel `Shade` contract and the leaving scene's dissolve, costs N full-frame `rgba16f`
  targets of bandwidth on phones, and would rewrite the renderer's frame loop.
- **A focal blur in the rig** (dew's macro). Rejected: passes cut their edges per cell and one pass
  cannot blur another's output; the macro preset's layers draw their own defocus.
- **A `layers=` list key.** Rejected for switch knobs, which reuse `when`, the lens, undo and the
  presets unchanged.
- **Dotted keys** (`bees.flowers`). Rejected: they read like the A/B slots' `a.` and `b.` prefixes
  and would change the knob key pattern and the GLSL names.
- **An entity system or scene graph.** Rejected, as the second audit's slices already did.

## Revisit when

- A committed preset's own program takes more than 5 s to compile on the reference GPU, or a layer
  turn on a phone takes more than 2 s before the layer shows: revisit deferred layers.
- A preset outgrows 8 trigger slots, or a program 128 knobs, or a port needs either: pack the
  trigger slots, or split what one program reads.
- The stack meter refuses a mix the operator wants: revisit the caps with that mix's measurements.
- WebGPU reaches Firefox on Linux and Android: the platform consensus (WebGL2) is the premise of
  the single-program design.
