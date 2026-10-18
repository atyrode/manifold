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
  and the `outdoor` composer: 79 layers in canonical order (`outdoor.ts`: 19 backdrops, 15 grounds,
  22 dressings, 7 covers, 12 life, 4 chores), their code by id in `outdoor-code.ts`. The `interior`
  composer (Phase 3): 11 layers (`interior.ts`: 3 backdrops, 3 grounds, 5 dressings), their code in
  `interior-code.ts`, the room's program in `room.ts`. The `overhead` composer's pilot
  (Phase 4): 7 layers (`overhead.ts`: 2 beds, 2 waters, 1 dressing, 1 cover, 1 life), its program
  and code assembly in `overhead-glsl.ts`, the layers' code in `overhead-code.ts`. All three share
  `composeScene`, the placer, the composed sim and the layers' turns (`turnsGlsl`, `passCalls`).
- **Presets:** meadow and bees (Phase 1); shore, dunes, autumn, lanterns and falls (2a); campfire,
  fireflies, forest, bamboo, garden and lake (2b); country, street, skyward, flock, swell and dew
  (2c); sill and lava (the Phase 3 pilot) and bonsai; pond and ripple (the Phase 4 pilot).
  `src/composer/budget.test.ts` holds that list.
- **Committed mixes:** "Bees · overgrown meadow" (the meadow's grass and wildflowers in the bees'
  garden), "Bees · in the valley" (the countryside's `valley` in place of the bees' hillside),
  "Sill · lava lamp on the sill" (the lava lamp standing on the sill, lighting the room) and
  "Ripple tank · koi in the tank" (the pond's koi in the ripple tank's water). The other mixes the
  waves planned ("Autumn maple by the lantern river", "Campfire in the meadow", "Fireflies over the
  apiary", "A campfire on the valley's hill") were not made: their layers are drawn through their
  own rigs alone (see "Rigs, locking and offering").
- **Not built:** the rest of the interiors (bar, train, mobile, incense, frost, clouds,
  harmonograph; Phase 3); the rest of the `overhead` composer (its `tilt` and `orbit`, the `height`
  pass, the World over the patch, and its presets after pond and ripple; Phase 4); the per-program
  knob layout and packed trigger slots; `scripts/layer-costs.ts`, the stack meter and the role's
  "+" listing; the browser checks `composerDepth`, `composerClaims`, `composerWeather` and
  `layerToggles`; a check of the SwiftShader instruction budget; the principals' points in the
  site; shelving the presets by composer (D9).

## Decision summary

1. **Three composers share one layer contract.** `outdoor` is a pinhole over a floor, level or
   pitched; `interior` a room with a ledge and a window; `overhead` a patch of ground seen from
   above. A composer is a camera rig, a site and an order of composition, and the World is in all
   three (in a room, through its window; over the overhead's patch, not yet). `outdoor` is built;
   `interior` is piloted with sill and lava and runs bonsai (Phase 3), `overhead` is piloted with
   pond and ripple (Phase 4).
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

| Limit                                      | Value                                                                                                                                                | Held by, and where the presets stand                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Layers on, the World not counted           | 8                                                                                                                                                    | `place.ts`; the largest home stacks hold 6 (autumn, campfire, country)              |
| Front subjects                             | 2                                                                                                                                                    | `place.ts`                                                                          |
| Claims a program holds                     | 12                                                                                                                                                   | `place.ts`; the apiary alone holds 11                                               |
| Local lights                               | 8                                                                                                                                                    | `caps.ts`, not checked; no stack holds more than 2                                  |
| Sim textures                               | 8: the speck map, the records atlas, 6 fields                                                                                                        | `allocate` (`sim.ts`); the valley alone takes 4 fields                              |
| Knobs a preset lists                       | 64, the renderer's `MAX_PARAMS`                                                                                                                      | `compose.ts`, `budget.test.ts`; bees 63, country 57, lake 52, falls 51, shore 49    |
| Trigger slots                              | 8, the renderer's `MAX_TRIGGERS`                                                                                                                     | `compose.ts`, `budget.test.ts`; forest and lake 8, bees, shore and bamboo 7         |
| Shaken program at a preset's defaults      | 160 KB                                                                                                                                               | `budget.test.ts`; the largest, street, 129,136 characters                           |
| Shaken all-features program of a layer set | 256 KB                                                                                                                                               | `budget.test.ts`; country 253,359 characters, "Bees · in the valley" 252,886        |
| The pilot mix's all-features program       | 230 KB                                                                                                                                               | `budget.test.ts`; "Bees · overgrown meadow" 220,819 characters                      |
| Fragment uniform vectors                   | 224, WebGL2's guaranteed minimum                                                                                                                     | `scripts/glsl-check.ts`; the largest measured, 180 (lake)                           |
| SwiftShader draw at 320×200                | a preset's default program within 10 % of its recorded instruction count; a mix within its preset's count plus its guests' marginal counts plus 10 % | not checked yet; recorded: fireflies 490 M, campfire 1.63–1.65 G, dew 6,354 M       |
| Sim CPU time, whole stack, headless        | 4 ms a frame                                                                                                                                         | not checked yet                                                                     |
| GPU frame at 960×540                       | 16.7 ms on the reference integrated GPU, once one is recorded                                                                                        | `bench.html` (`SCENES.md`, "GPU cost on real hardware"), which has no `layers=` yet |

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
lists 63 of 64 knobs, and the forest and the lake use all 8 trigger slots: one more layer with a
knob offered to the bees, or with a "now" offered to the forest or the lake, makes the preset fail
to compose (`ComposeError`). The way past is the per-program layout: a program defines `K_<key>`
only for the composer's knobs and its on layers', packed into `uParams` with an index map the
renderer uploads through, so a preset lists up to 512 knobs and a program reads up to 128; and
trigger slots packed to 32, numbered statically. `uParams` at 128 floats takes 16 more uniform
vectors than today's 64, which the largest program (180) has room for.

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

| Preset    | At its defaults (dithered) | Differences, attributed                                                              | SwiftShader, against the scene before |
| --------- | -------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------- |
| shore     | `SAME`                     | none: every witness `SAME`                                                           | 1.07–1.16× wall time                  |
| dunes     | `SAME`                     | `seed` reseeds the World's cumulus                                                   | about 1.0× wall time                  |
| autumn    | 52 cells (0.23 %)          | the gust field (D4); the World's rain at the composed depth (D10)                    | 1.06–1.10× wall time                  |
| lanterns  | 3 cells                    | a lantern's edge now blends with the near stone; the World's rain and birds          | 0.45–0.68× wall time                  |
| falls     | `SAME`                     | the World's fog (22 % of cells with fog on); the nearest drops dimmed as the World's | 0.70–0.89× wall time                  |
| campfire  | 7.2 %, the sky only        | the World's stars, Milky Way and shooting stars; the giant a World planet (D10)      | 1.07–1.08× instructions               |
| fireflies | 1.1 %, the stars only      | the World's stars (D10)                                                              | 1.69× instructions                    |
| forest    | `SAME`                     | the World's rain, fog and snow                                                       | 1.01–1.07× wall time                  |
| bamboo    | 7.2 %                      | the culms' sway in the gust field (D4): `SAME` with the old gusts swapped back       | 0.93× wall time                       |
| garden    | `SAME`                     | the World's rain (5.5 %) and snow (2.8 %)                                            | about 0.86× wall time                 |
| lake      | `SAME`                     | the World's rain (new), snow and fog                                                 | about 0.83× wall time                 |
| country   | `SAME`                     | the World's rain (19 %) and snow (79 %)                                              | 1.06× timer queries (worst 1.11×)     |
| street    | `SAME`                     | the World's fog, rain and snow                                                       | 1.02–1.03× wall time                  |
| skyward   | `SAME`                     | the World's rain (1.4 %), snow (about 20 %) and fog (9 %)                            | 0.94× wall time                       |
| flock     | `SAME`                     | the World's stars at night, a cell or two                                            | 1.08× instructions                    |
| swell     | 5 cells                    | the gulls fly on the composer's `seed` (D10)                                         | 1.02× instructions                    |
| dew       | `SAME`                     | the World's rain (new)                                                               | 1.144× instructions                   |

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
  below).
- **The lamp's light is a declared light.** The lava lamp (`lavaLamp`) is drawn from the rig, 0.4 m
  tall on any room's seat line at its anchor, so it is offered to every interior preset whose eye
  stands 0.2 m or more over its ledge (the sill's and its own); on the sill it takes its second
  anchor, the cat holding the first. Its `lavaLampLight` reaches the sill's wall, frame, sill, props,
  curtain and cat through `roomLight` and `localLight`. The sill's five layers and the lava room's
  papered wall and sideboard stay locked to their rigs.

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
- **The caps:** the bonsai's five "now" slots run 2 to 6; the lava lamp is offered only to rooms
  whose eye stands 0.2 m or more over the ledge, so it is not offered to the bonsai.
- **At its defaults** `SAME` (`ab.ts` against 47e062d9, dithered and `view=source`); further
  witnesses, all `SAME`: shoji, pine and the lamp at dusk; winter in the dark alcove under heavy
  snow; cherry in the unglazed pot, the sun from the left, the kintsugi M on. The shaken default
  program is 58,003 characters; its all-features program, which plays the layers' turns, 60,500.

| Preset | At its defaults (dithered)                                             | Differences, attributed                                                                                    |
| ------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| sill   | `SAME`                                                                 | none; the World's knobs replace the sill's sky and weather (Milky Way, cumulus, cloud shadows new and off) |
| lava   | `SAME`                                                                 | none                                                                                                       |
| bonsai | `SAME`                                                                 | none                                                                                                       |
| mix    | 1,434 of 23,040 cells against the sill (6.2 %): the lamp and its light | the lamp on the sill, its warm light on the wall, the frame, the sill, the props and the cat               |

**Still to build:** bar, train, mobile, incense, frost, clouds and harmonograph as presets; the
World's birds through a window; depth across a room's layers, and shadows on another layer's
surface than a backdrop's, once two layers that overlap need them. What Phase 2 changes for them:

- **The window's view is drawn for the window (D11).** Outdoor backdrops are locked to their own
  rigs (the street's `city` to a window 28 m up and pitched down), so a room's window draws a view of
  its own through its rig, as the sill's city is.
- **The caps.** A room's layers number their trigger slots from 2, after the World's two. The bar has
  six of its own, which fill the eight; the train has five, which leave one, as the bonsai's do; the
  packed trigger slots come before a guest with a "now" is offered to the bar, the train or the
  bonsai. The lava lamp brings two (its cold start and its M), so it is offered only to rooms whose
  eye stands 0.2 m or more over the ledge (not the bonsai's); the bar's and the train's ports lock it
  out too or wait for the packed slots.

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
Neither needs the per-program knob layout; the World over the patch (its weather seen from above,
its light) will, for the pond.

**At their defaults:** pond `SAME`, ripple `SAME`, "Ripple tank · walled tank" `SAME` (`ab.ts`
against 3819c80c, dithered). Further witnesses, all `SAME`: the pond with the stone, canopy, current
and sand bed on; with its year, growth, gusts and koi following; with no koi, plants or pads on
slate at full depth; with the sun moved on screen in a full breeze; the tank as a surface under the
safelight, and at another focus. The shaken programs grew: pond 42,308 → 44,379 characters, ripple
18,233 → 20,724 (the composer's prelude, and the still water the tank lays before its water's
begin); their ceilings in `shake.test.ts` were raised with them.

**Not built yet:** the `tilt` feature and its march (a tilted rig's march costs its full length
under SwiftShader wherever it ends, so the gate, off, keeps it out), the `orbit` range, a `height`
pass and a bed height field shared across layers (the pond's and the tank's beds are flat; the
water's slope is the only relief), a material at each point, the World over the patch, and the
presets after the pilot: sandtable, tidepool, delta, island, and `dunesabove` and `gardenabove`,
which retire the dunes' `camera` and the garden's `gravelCamera` and their own programs. Layers
drawn in the frame's units are locked to their span; the koi are offered from 1 m to the pond's
3 m, drawn at the frame's scale (11–17 cm fish in the 1 m tank), so a bench-scale layer is refused
beside the delta's kilometres by its span.

### Phase 5: the matter shelf, and what stays standalone

- **Optional (D7):** petri, physarum, marble, chladni, ferro, film, pearl, prism and pendula, as
  dishes, plates and boards on the interior's ledge or the overhead's bench.
- **Standalone:** fractal, hyperbolic, orbit and shanshui keep their own `SceneDef`: a pure field, a
  tiling, outer space, a painted scroll have no space to share.
- **Pending (D7):** kelp, under water: a submerged `outdoor` rig, or standalone.

## Risks

1. **The caps bind on offering.** Bees lists 63 of 64 knobs and the forest and the lake all 8 slots;
   every further cross-offering waits for the per-program layout and packed triggers, as do the
   bar's port and the World over the overhead's patch (the pond lists 54 without it).
2. **Rig-locking limits the mixes.** Of the nineteen outdoor presets' 79 layers, six are offered
   beyond their own rig; of the interior's 11, the lava lamp, drawn from the rig; of the overhead's 7,
   the koi beyond their own span. Four mixes are committed. The worth of composing grows only as
   layers are redrawn from the ray (or, from above, in metres).
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

The operator ratified D1–D12 on 2026-10-17. As they stand:

| #   | Question                            | Decision as it stands                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | How a scene becomes a preset        | Its id stays and its `SceneDef` is generated from a scene preset (`composeScene`): card, thumbnail, family, tour step and links unchanged, so `ab.ts` compares like for like. No aliases.                                                                                                |
| D2  | Layer knob keys                     | Keep each scene's keys where unique in the preset; qualify a collision `<layerId><Key>`, automatically within a preset and by hand where a layer might share a rig. No dotted keys.                                                                                                      |
| D3  | Pixel identity per port             | `SAME` for every part a scene keeps; a difference stands when it is attributed to a shared part taking over (D4, D10) or to a named fix, with its diff image inspected. Weather a scene never had compares against nothing. A part missing, moved or lit differently fails at any share. |
| D4  | One gust field                      | The meadow's field is the composer's, and what sways in it sways together; a breeze that is a scene's own subject stays its own (the fireflies', the dew web's, the lake's drifting snow), and a preset may open with the gusts off.                                                     |
| D5  | Readability scale cheats            | Allowed when declared (`display.scale`), with the claims sized as drawn: the apiary's hives at 1.5.                                                                                                                                                                                      |
| D6  | Caps and budgets                    | The table under "Budgets and caps", with the SwiftShader budget counted in instructions on the composed program, not as a ratio to the scene before its port.                                                                                                                            |
| D7  | What stays outside the composers    | Fractal, hyperbolic, orbit and shanshui standalone; dew composed, locked to its macro rig; kelp decided at its wave; the matter shelf optional.                                                                                                                                          |
| D8  | Lazy loading                        | Done: a scene's metadata loads without its code, and the layers' code loads with the first composed scene's.                                                                                                                                                                             |
| D9  | How the Scenes view shelves presets | By composer; not built (the view still shelves by family).                                                                                                                                                                                                                               |
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
- A preset outgrows 64 knobs or 8 trigger slots, or a port needs to: build the per-program layout.
- The stack meter refuses a mix the operator wants: revisit the caps with that mix's measurements.
- WebGPU reaches Firefox on Linux and Android: the platform consensus (WebGL2) is the premise of
  the single-program design.
