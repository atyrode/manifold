# 0062 — One world, three composers: the landing scenes become presets of stacked layers

Date: 2026-10-17
Status: accepted
Ratified: D1–D12 resolved as recommended below (2026-10-17, #1082 item U1).

## Problem and boundary

The landing concept lab (`concepts/landing`, tracker #1082, draft #1083) holds 49 scenes. Each is
one `SceneDef` compiled to a fragment program of its own (`src/scenes/types.ts:4-12`,
`src/shaders/index.ts:184-199`). Most of the outdoor scenes show the same thing: a camera standing
on the ground at eye level, something in front of it, a landscape behind, the sky above. Stage 2 of
the World (`src/scenes/README.md:1546-1790`) already gives them one sky, one weather and one set of
birds. Each scene still owns its camera, its ground, its light grade, its gusts and everything in
front of the eye, so nothing from one scene can stand in another. The lab cannot show the bees'
garden overgrown by the meadow, or a campfire on the valley's hill.

#1082 item U1, which the operator ratified as "go all in", folds the scenes into three composers.
Each composer is a shared camera, ground and light over which layers stack. Every existing scene is
kept as a preset, and every link keeps working through `MIGRATIONS` (`src/state.ts:392-425`).

This record is U1's **design milestone only**. It sets out:

- the contract: what a composer provides and what a layer declares;
- the rules for space, compositing, cost, sims, the lab and principals;
- an ordered migration with acceptance criteria.

None of it exists at `4d490f15`, and no code changes with this record. It authorizes no port by
itself: each phase lands as its own change under #1082, with the evidence its acceptance names.

The concept lab is not product code, so no axiom, `REGISTRY.md` row or `docs/CONTRACTS.md`
section changes. Once ratified, the contract's normative form is the "Composers" section of
`concepts/landing/src/scenes/README.md`, the lab's own spec. This record keeps the reasoning, the
evidence and the phases.

Paths are relative to `concepts/landing/` unless they start at the repository root.

## What the tree does today

| Seam                  | What the source does at `4d490f15`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Consequence for composers                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| One program per scene | `fragmentSourceFor` concatenates `common`, the feature defines, the knob defines, `libs`, `scene.glsl` and `main` (`src/shaders/index.ts:184-199`). A knob key is both a URL key and a GLSL name, `^[a-z][A-Za-z0-9]*$` (`:30`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | A composed scene assembles its source from the layers it shows. Knob keys must be unique across everything one program holds.               |
| Gates                 | `featuresFor` leaves code behind an off knob out of the program. `featuresAll` turns every gate on and must draw every setting byte for byte as that setting's own program does (`src/scenes/types.ts:177-195`). On a GPU, a knob change draws with the all-features program, which is built once in the background; a software rasteriser builds the setting's own program instead (`README.md:802-823`). The renderer keeps 4 programs per scene and 8 in all (`src/program-cache.ts:22-33`).                                                                                                                                                                                                                                                                                                | Reusable as it is, provided the all-features set is per layer set. A composer-wide all-features program is infeasible (see "Measurements"). |
| Software cost         | SwiftShader "runs every line of a program whatever branches a pixel takes" (`README.md:765-772`). The countryside's all-features program takes about 20 s to compile there; a setting's own program takes 2–5 s (`:818-819`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | An off layer must be absent from the source, not branched over.                                                                             |
| One pass              | "one full-screen pass at ~960×540 cells must hold 60 fps on an integrated GPU" (`README.md` "Art direction").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Composition happens inside one fragment program.                                                                                            |
| The World             | `worldAt`, `worldView`, `worldSky`, `worldBirds`, `worldFog`, `worldPrecip` and the mirrors. The scene supplies its camera (horizon, focal, eye, yaw, units per metre), the depth of the first opaque thing in each cell, its haze, its air and its drop light (`README.md:1558-1594`, `:1742-1748`). The gates are `worldFeatures`, `WORLD_ALL` and `worldGates` (`src/scenes/world.ts:147-224`). Views from straight above are not in it yet (`README.md:1789-1790`).                                                                                                                                                                                                                                                                                                                        | The World becomes the layer every composition has. Its contract already asks each scene for exactly what a composer will provide.           |
| Depth per cell        | Scenes paint far to near and keep the depth of what each cell shows: meadow's `zHit` (`src/scenes/meadow/shader.ts:1199-1256`), autumn's `hitZ` (`src/scenes/autumn/shader.ts:813-878`), and bees' `beesZ`, set by every part that changes the cell (`src/scenes/bees/shader.ts:1354-1406`). The bees' specks are drawn against that depth (`:1467-1474`).                                                                                                                                                                                                                                                                                                                                                                                                                                     | Per-cell depth compositing generalises existing practice; it does not need a new renderer.                                                  |
| Cameras               | Each outdoor scene has a camera of its own, most of them a level pinhole. Horizon, focal length and eye height: meadow 0.4, 1.18, 2 m (`src/scenes/meadow/sim.ts:78-84`); bees 0.47, 1.0, 1.6 m (`src/scenes/bees/sim.ts:95-97`, `:111`); autumn 0.36, 1.0, 1.5 m (`src/scenes/autumn/layout.ts:51`). Horizon and eye only: bamboo 0.4 and 1.3 m (`src/scenes/bamboo/sim.ts:49-50`); forest 0.36 and 1.15 m (`src/scenes/forest/sim.ts:51-52`). Fireflies' eye is 1.2 m, with focal 1.2 and the bank 60 m away (`src/scenes/fireflies/sim.ts:102-108`). The countryside looks down from a hill, horizon 0.63 (`src/scenes/country/camera.ts:15`); the dunes are seen from about 80 m up (`README.md:1765-1774`). One CPU camera class already serves four scenes (`src/sims/camera.ts:30-32`). | One camera rig per preset; layers project through it.                                                                                       |
| Scale                 | The World works in metres (`WorldView.unit`), but bees builds its hives 1.5× "so the entrances read" (`src/scenes/bees/sim.ts:133-134`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Scale is metres. A readability cheat is declared, never implicit.                                                                           |
| Sims                  | A `SceneSim` returns up to four textures, bound as `uSim0..uSim3` (`src/scenes/types.ts:119-134`, `src/program-cache.ts:19-21`, `src/renderer.ts:1227-1230`). Precedents for packing: the countryside's records atlas, `PlantTexture.pack` (`README.md:1812-1816`, `src/sims/plants.ts:48-59`) and the nearest-depth speck map (`src/sims/specks.ts:1-42`).                                                                                                                                                                                                                                                                                                                                                                                                                                    | Meadow (4 textures) and bees (1) do not fit four slots together. Records pack; fields need slots.                                           |
| Knob limits           | `MAX_PARAMS` is 64 and `MAX_TRIGGERS` is 8 (`src/params.ts:118-120`). A scene has at most `MAX_PARAMS` knobs (`src/scenes/types.ts:153`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Meadow (28 knobs) and bees (31) share 19 World keys. A third large layer passes 64. Their trigger slots collide: meadow uses 0–3, bees 0–2. |
| Links                 | A setup is a query with defaults left out. `MIGRATIONS` holds `keys` steps and `alias` steps (`src/state.ts:274-297`, `:392-425`). `url-keys.json` lists every key ever published and only grows (`README.md:231-241`). Committed presets must load as themselves (`src/presets.ts:1-9`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Every published key keeps its meaning. A key that must change takes a `keys` step.                                                          |
| Lab                   | Controls are laid out from knob metadata, and `when` chains a knob to its switches (`README.md:492-499`). The World shelf comes from `Blurb.shelf` (`src/params.ts:305-317`). The compact bar has one chip per section (`README.md:359-376`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | A layer can be a switch with its knobs hung on it, gathered into one section as the Night sky section is.                                   |
| Presence              | There is one pointer (`src/scenes/types.ts:24-35`). "Principals as a renderer concept" is A2 follow-through: second-audit item I-20 adds `SimFrame.principals` and `uPrincipals[8]`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Principals become a composer service built on I-20.                                                                                         |

## Measurements

The numbers come from Bun probes at `4d490f15`, using the second audit's item-level shaker
prototype (H2-1). The prototype evaluates the `#if`s, strips comments and keeps what `main` reaches
by name. Because it matches by name, it over-keeps, so these figures are upper bounds.

**Shaken program size, at defaults / with all features (KB).**

| Scene     | Default / all | Scene   | Default / all | Scene    | Default / all |
| --------- | ------------- | ------- | ------------- | -------- | ------------- |
| meadow    | 81 / 153      | bees    | 84 / 151      | campfire | 54 / 57       |
| fireflies | 19 / 19       | autumn  | 71 / 111      | forest   | 87 / 90       |
| bamboo    | 73 / 76       | garden  | 78 / 78       | country  | 98 / 213      |
| falls     | 95 / 135      | lake    | 65 / 132      | shore    | 77 / 141      |
| dunes     | 56 / 123      | street  | 107 / 110     | skyward  | 78 / 118      |
| lanterns  | 76 / 116      | sill    | 98 / 139      | lava     | 27 / 27       |
| bonsai    | 50 / 50       | train   | 134 / 174     | bar      | 105 / 105     |
| mobile    | 31 / 31       | incense | 30 / 30       | ripple   | 14 / 14       |
| sandtable | 20 / 20       | pond    | 36 / 36       | tidepool | 44 / 44       |
| delta     | 15 / 15       |         |               |          |               |

**Union of the shaken all-features programs.** Items shared by the scenes (`common`, the
libraries, the World) count once:

| Set                                  | Union  | Sum of parts |
| ------------------------------------ | ------ | ------------ |
| meadow + bees                        | 204 KB | 304 KB       |
| meadow + bees + campfire + fireflies | 253 KB | 381 KB       |
| the 15 eye-level scenes U1 names     | 868 KB | 1,707 KB     |
| the 7 named interiors                | 447 KB | 557 KB       |
| the 5 named top-down views           | 115 KB | 129 KB       |

The pilot mix is no larger than the countryside's all-features program is today (213 KB). One
all-features program for the whole outdoor composer would be four times that, and the countryside's
alone already takes about 20 s to compile under SwiftShader.

**Sim textures.** Counting the distinct `uSimN` slots each shader reads:

- four slots: meadow, fireflies, autumn, garden, country, lake, bonsai, incense, pond, tidepool;
- three: forest, bamboo, street, lava, ripple;
- two: dunes, sandtable, delta;
- one: bees, campfire, falls, shore, lanterns, sill, train, bar, mobile.

Most of these textures are small `rgba16f` record textures read with `texelFetch`. The linear-filtered
fields are the exceptions: dunes' sand, lake's crack and snow fields, garden's gravel, and the
`rgba32f` GPU solvers of ripple, delta, tidepool and incense.

**Knob keys.**

- Own knobs, World keys excluded: meadow 9, bees 12, campfire 19, country 30, lake 19.
- Across 23 outdoor candidates, 29 own keys collide. `mark` alone collides in 19 scenes; `gusts`
  in 4; `lantern` is a feature in bees and bamboo but a toggle in fireflies.
- Among 11 interior candidates (with frost, harmonograph, pendula and prism), 17 own keys collide;
  among 12 top-down and matter candidates, 27.

## Decision summary

1. **Three composers share one layer contract.** They are `outdoor` (an eye-level pinhole on the
   ground), `interior` (a room box with a ledge and a window) and `overhead` (a patch of ground
   seen from above, with optional tilt and orbit). A composer is a camera rig, a site model and a
   composition order. The World is in all three.
2. **A layer is a module.** It has a manifest (role, bands, claims, exclusions, cost), GLSL behind
   its own gate, an optional sim, and its knobs. One steady toggle or feature knob switches it,
   keyed by the layer's id. Its knobs hang on that switch (`when`).
3. **Composition is per-cell depth.** A `Cell { col, z, accent }` is written by opaque passes
   behind a depth test, which is order-independent because edges are cut per cell. Translucent
   passes then run from far to front. The World's fog and precipitation are applied once, at the
   composed depth, and every speck shares one nearest-depth map.
4. **Light, scale and weather are shared.** Scale is metres. There is one World, one light grade
   per preset, up to 8 local lights and one gust field. Every layer reads `uWeather`.
5. **Space is claimed, not painted.** Layers claim footprints on the floor (exclusive, clearing or
   shared), choose among candidate anchors and stand in bands. A deterministic solver resolves
   foreground conflicts and refuses a layer, with a reason, when there is no room.
6. **Scenes become scene presets.** Every ported scene's id stays, with its card, thumbnail, tour
   step and links, but is generated from data: a composer, a rig, a light grade, home layers and
   values. Old keys migrate through `keys` steps; only retired ids take aliases.
7. **Cost is bounded per layer set.** The layer set is structural; the all-features program is
   built per layer set; an off layer is absent from the source; the shaker prunes the rest. There
   are budgets per program and caps per stack, and never a composer-wide all-features program.
8. **Sims share one frame.** One `SimFrame` goes to a composed sim, which fans out to the layer
   sims. They share a speck map and a records atlas and get up to six field slots, eight in all.
   The sim follows the program on screen (`SimFrame.features`).
9. **The lab shows layers by role.** A Layers section gathers the switches by role; each on layer's
   sections stand under it; the compact bar has one chip per on layer; presets are the starting
   points.
10. **Principals are a composer service.** Chores are layers that act on a host layer's affordances,
    and the composer draws every principal's cursor.
11. **Migration runs in five phases after its prerequisites.** The pilot ports meadow and bees and
    proves the overgrown garden; then the rest of the outdoor scenes, the interiors, the top-down
    views, and finally the matter shelf.

## The composer contract

### Composers and their rigs

Each composer has one camera rig, and each preset fixes its values. They are compile-time constants
of the preset's programs, as each scene's camera constants are today, so a preset's own layers
draw exactly as their scene drew them. Passages move the rig at run time, as they move the cameras
today: meadow's drop, autumn's lens shift, forest's dolly, the countryside's tilt. The camera
belongs to the preset, so it has no knobs, except the overhead's tilt and orbit (below). Layers
declare the rigs they can be drawn through.

| Composer   | Rig                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Site                                                                                                                                                                                                                     | Scenes it takes |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| `outdoor`  | A level pinhole: eye height (m), turn (the yaw from its frame to the sky's), horizon (uv.y), focal (screen heights per unit of slope), pitch (rad, 0 by default), a lens shift for passages, and `minAspect` (a frame narrower than this is laid out as if this wide, then cropped: bees 1.24, its stage half width of at least 0.62; autumn 1.45; forest 1.3). Its projection is `LevelCamera` (`src/sims/camera.ts`) and `worldView` / `worldViewOf`; a pitched rig draws precipitation with `worldPrecipSeen`. | The floor plane `y = 0` in the camera's frame (x right, z ahead, metres). Its floor kind is earth, lawn, gravel, sand, rock, moss, ice, snowfield, water or asphalt, unless a ground layer replaces it.                  | Phases 1 and 2  |
| `interior` | A pinhole inside a room box: room size (m), eye position and look, the window as a rectangle on the back wall. Rays that leave through the window continue as an `outdoor` rig standing at the eye.                                                                                                                                                                                                                                                                                                               | Floor, walls and ceiling with their kinds (boards, plaster, paper, tin, stone); one ledge across the front (sill, counter, table, sideboard, stand: height, depth, kind); the window's glass, with rain and frost on it. | Phase 3         |
| `overhead` | A patch of ground seen straight down, orthographic, at a given number of metres per screen height (0.6 m for the tank, 5 km for the delta). The one exception to fixed rigs: a `tilt` feature knob (off: straight down, with no march compiled in; on: a pitch from 90° down to 30°) and an `orbit` range (yaw), both steady. A tilted rig marches the composed height; `src/sims/heightray.ts` is the CPU twin of that march.                                                                                    | The bed: a height field in metres over the patch. The water: its depth over the bed, from a layer's sim. A material at each point.                                                                                       | Phase 4         |

### The site

The site is the floor every layer stands on: its height, its kind, its wetness and its lying snow.

- The composer draws a plain floor of the preset's kind wherever no cover or ground layer
  overrides it. A ground layer replaces the floor with something richer: bees' lawn with its path
  and hedge, the garden's gravel field, shore's beach and surf, lake's ice.
- Wetness is `uWeather.x`. Lying snow is `uWeather.y`, scaled by how well the kind holds it: none
  on water, little on asphalt. A ground layer may add its own local wetness, such as shore's wet
  band.
- Claims (see "Layers") change the floor inside their footprint: a campfire's clearing is bare
  earth and stone, a path is gravel.
- Under a tilted `overhead` rig, the bed's height is the sum of the on layers' `height(xz)`
  contributions.

### Depth compositing

The composer generates the program's entry function. Layers contribute passes; they never write
the entry themselves.

```glsl
struct Cell { vec3 col; float z; float accent; };
void cellPut(inout Cell c, vec4 rgba, float z);   // opaque: where z < c.z, over by rgba.a; takes z once a >= 0.5
void cellVeil(inout Cell c, vec4 rgba, float z);  // translucent: where z < c.z, over by rgba.a; keeps c.z
```

The entry runs, in this order:

1. The World now (`worldAt`), the rig's ray for this cell, the light (see "Light").
2. The sky: `worldSky`, with the backdrop's sky staging over it, and `c.z = WORLD_FAR`.
3. The floor or ground layer, where the ray meets the site. Claims and caster shadows apply, then
   cloud shadows, wetness and snow.
4. For each band (far, middle, front), every on layer's opaque pass in canonical order, then every
   on layer's veil pass.
5. `worldBirds` at `c.z`.
6. Each local light's glow in the air, added to the fog's air and the drop light (bees' lantern
   model, `src/scenes/bees/shader.ts:1433-1460`, generalised).
7. `worldFog`, then `worldPrecip` at `c.z`, thinned under shelter claims.
8. The shared speck map, drawn against `c.z`.
9. Every principal's cursor.
10. `shadeOf(col, inkOf(col, gain, gamma), accent)`, with the preset's ink gain and gamma.

Opaque passes are order-independent because the art direction cuts edges per cell (`hardEdge`,
`hardFill`; README "Hard edges"). A cell's coverage is 0 or 1, so the depth test alone decides what
shows. Soft alpha (fringes, glows, smoke) does depend on order. That is why passes run by band and
then in canonical order, which is also each preset's old painter's order for its own layers. A
layer's passes keep their internal order exactly as its scene drew them, so a preset with only its
home layers can draw byte for byte as before.

### Light

`composerLight(w)` is the World's sky (`w.sky`), times the preset's grade:

- the sun's tint, the sky's tint and an ambient floor;
- whether the moon takes over as the key light once the sun has set. This is bees' model
  (`BEES_SUN_TINT`, `BEES_SKY_TINT`, `BEES_MOONLIGHT`), made a preset parameter.

Every layer is lit by the same light, so the layers of a mix match.

- **Local lights.** A layer declares up to a few lights in its manifest: a position relative to its
  anchor, a reach, and the GLSL function that gives the light's colour now (the apiary's lantern
  reads `K_lantern` and the dusk; the campfire's flame flickers on the motion clock). The
  composer generates `localLight(p, n)`, which sums the lights of the layers on, at most 8 in
  all. Every layer lights its materials with it: a campfire lights the hives, a lava lamp lights
  the cat.
- **Shadows.** The World's cloud shadows reach every layer through `worldSunlit`, at points the
  layer chooses. A claim with a `shadow` (a height and a radius) casts a key-light shadow onto the
  floor and onto covers (`casterShadow(xz)`, bees' `beesGroundShadow` model lifted unchanged).
- **Not shadowed across layers.** A local light casts no shadow from one layer onto another; each
  layer may shadow its own parts. This is a stated limit, not an omission.
- **The air.** The backdrop owns it: the haze colour toward each bearing, the forward scatter
  round the sun, and the sky staging over the deck. Meadow's golden haze and `meadowDeck` belong
  to its backdrop, and bees' warm haze to its own.

### Scale

Everything is in metres in the rig's frame, and a cell spans `foot(z) = z / (focal · uRes.y)`
metres at depth z.

A readability cheat is declared, as `display: { scale }` on the layer (bees' hives at 1.5). The
layer's claims are sized as it is drawn, so a cheated layer never overlaps its neighbours.

Each layer declares the range of scales it makes sense at. The `overhead` composer refuses to put
a 6 m pond beside a 5 km delta.

### Weather and wind

The World's knobs are the only weather, and they reach every layer:

- Precipitation and fog are applied once, at the composed depth, so rain falls between the hives
  and the grass exactly as it does between meadow's blades today.
- Every layer's materials go through the shared surface functions (`wetten`, `wetGloss`,
  `snowCover`), reading `uWeather`. A check holds every layer to it (see "Checks").
- A layer may claim shelter: under a canopy, the precipitation and the lying snow thin by the
  claim's `shelter` (forest's 45 %, bamboo's half).

There is one wind direction (`K_wind`) and one gust field, `gustAt(xz, tm)` in GLSL with a CPU
twin. It bows every layer's grass, flowers, crowns and leaves together, and its knobs (`gusts`,
`gustRate`, the gusts' trigger) are the composer's.

Meadow's honami field is the one promoted: it is already deterministic and shared between its
shader and its sim (`src/scenes/meadow/index.ts:1-6`). Bees', autumn's, bamboo's, garden's and
falls' gusts then follow it (an operator decision, D4).

## Layers

### What a layer declares

| Field                                    | Meaning                                                                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                     | camelCase. It is the layer's switch key, a token in diagnostics and the prefix of any qualified key (see "Keys").                                                             |
| `composers`                              | The rigs it can be drawn through (garden's gravel: `outdoor` and `overhead`).                                                                                                 |
| `role`                                   | One of backdrop, ground, dressing, cover, life, chore (below).                                                                                                                |
| `bands`                                  | Where it stands: far (beyond about 60 m), middle (6–60 m), front (within about 6 m of the eye).                                                                               |
| `space`                                  | Its anchors (candidate placements in metres, in order of preference) and its claims relative to the chosen anchor.                                                            |
| `camera`                                 | The eye heights, pitches and scales it can be drawn at. A preset whose rig falls outside them does not offer it.                                                              |
| `params`, `groups`                       | Its knobs and lab groups, as a scene's are today.                                                                                                                             |
| `triggers`                               | Named "now" slots; the composer assigns the numbers.                                                                                                                          |
| `glsl`, `passes`                         | Functions prefixed with the id, and the name of each pass it has: `far`, `middle`, `front` (opaque or veil), `ground`, `height` (overhead), `sky` (a backdrop's sky staging). |
| `features`, `featuresFor`, `featuresAll` | Its own gates, named with its prefix.                                                                                                                                         |
| `sim`                                    | A `LayerSim` (see "Sims").                                                                                                                                                    |
| `excludes`, `suppresses`, `requires`     | Its relations to other layers (below).                                                                                                                                        |
| `cost`                                   | Generated, never hand-written: shaken KB, uniform vectors, sim textures and SwiftShader milliseconds, each as a margin over the composer's base.                              |

### Roles and bands

| Role     | How many                                                 | Examples                                                                                                    |
| -------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| backdrop | exactly 1; turning on another swaps it                   | meadow's downs and tree line, bees' hillside, campfire's pines, lake's mountains, the sea, the city skyline |
| ground   | at most 1; without one, the site's plain floor           | bees' lawn, garden's gravel, shore's beach, lake's ice, a river                                             |
| dressing | any number; at most 2 marked `subject` in the front band | the apiary, the campfire, the maple and bench, the water clock, the cat on the sill                         |
| cover    | any number                                               | meadow's grass, wildflowers, leaf litter, moss                                                              |
| life     | any number                                               | bees' insects, the fireflies' swarm, the koi, the kodama, a murmuration                                     |
| chore    | any number; each needs its host on                       | leaf raking, cairns, sand raking, star-joining                                                              |

The World is not a role: every composition has it, under its own knobs and gates.

### Claims

A claim is a shape in metres (a disc, a box with a turn, or a strip along points with a half width)
of one of three kinds:

- **exclusive**: no other exclusive or clearing claim may overlap it, and covers do not grow inside
  it. Examples: the hives on their stands, the campfire's ring, the wall.
- **clears**: covers thin to nothing inside its core and feather out over about 0.3 m. Another
  layer's exclusive claim may stand at its edge but not in its core. It may set the floor's kind
  inside. Examples: the campfire's clearing, a path, a bench's patch.
- **shared**: a covered area that covers may grow into by their `overgrowth`. Example: bees'
  flower drifts, which meadow's grass overgrows as far as its `overgrowth` knob says.

A claim may also carry:

- a `shadow` (height and radius), which casts on the floor and covers;
- a `shelter` (0..1);
- `keepOut`, which life layers steer around.

The placement depends only on the preset and the layer set (see "Foreground conflicts"), which are
what a program is built for. So claims and anchors reach the GLSL as compile-time constants of the
program: at most 12 claims, and no uniforms. Covers ask `coverAllowed(xz)`: 0 inside exclusive and
clearing cores, the overgrowth inside shared claims, 1 elsewhere. The same placement reaches the
sims through `LayerFrame.ground`, so the bees' drifts and the meadow's dandelion clocks are laid
out where they may grow.

### Foreground conflicts

A pure TypeScript solver places the layers. Its inputs are the preset (rig, home layers) and the
on layers, and nothing else: not the window's aspect, not any other knob. It places, in order:

1. the preset's home layers, in canonical order (the composer's registry order);
2. then every guest layer, in canonical order.

Each layer takes its first anchor that meets all of these:

- none of its exclusive or clearing claims overlaps an exclusive or clearing claim already placed;
- the front band holds at most two `subject` dressings;
- a claim marked `mustShow` lies inside the rig's view at the preset's `minAspect`.

A layer with no such anchor is **refused**. The lab dims it with a reason that names the layer
holding the space ("the hives stand where the campfire would"). A link that turns it on drops it,
with a one-line notice like the unknown-scene notice. A later layer never moves an earlier one, so
adding a layer never shifts what was there.

So when two layers both want the foreground:

- the one the preset is built round keeps its anchor;
- otherwise the one first in canonical order keeps it;
- the other steps aside or back to its next candidate (the campfire at 3.4 m in the middle, or at
  4.5 m to the left or right);
- if it has no candidate left, it is refused rather than overlapped.

A cover in the front band (meadow's near blades) is not a subject. Its conflicts with another
front cover are settled by `suppresses` (below).

Anchors are part of a layer's meaning, like a knob's: changing a shipped anchor moves things in old
links, so it takes a URL schema step as a knob's change of meaning does.

### Exclusions and dependencies

- **`excludes`**: two layers that cannot be on together (lake's ice and meadow's grass). The lab
  turns the other off in the same undoable change. A link holding both keeps the first in
  canonical order and drops the other, with a notice.
- **`suppresses`**: a layer turns off a named gate of another layer while both are on.
  `grass` suppresses `lawn`'s near blades (`LAWN_BLADES`), so the front band shows one sea of
  grass, not two.
- **`requires`**: a chore's host. Without it, the chore is off and offered dimmed.
- **Single-role swap**: a second backdrop or ground replaces the first.
- **Camera range**: a layer drawn for a standing eye is not offered at all under the countryside's
  hill rig, the street's high window or skyward's upturned rig.
- **The Manifold M**: at most one layer's M is on at a time. The lab turns the others off; a link
  keeps the first in canonical order (art direction: "one standalone element", `README.md`
  "Art direction").

## Scene presets and links

### A scene becomes a preset

A **scene preset** is data:

- its composer, id, title, blurb, accent, look, page theme, passage and planets pad;
- its rig, its light grade and its home layers;
- the values where it departs from its layers' defaults.

`composeScene(preset)` makes the `SceneDef` from it:

- **params**: the composer's own knobs (the World's, `gusts`, `gustRate`, `seed`, and `season`
  where a layer has a year), then every offered layer's switch (on by default for home layers),
  then every offered layer's knobs, hung on their switches with `when`. An offered layer is one
  whose camera range admits the preset's rig.
- **defaults**: the preset's values.
- **`glslFor(features)`**: the composer's prelude, the GLSL of the layers on in that feature set,
  and the generated entry.
- **`featuresFor`**: the World's gates, a `LAYER_<ID>` gate per placed layer, and each on layer's
  own gates.
- **`featuresAllFor(values)`**: every gate of the layers on in `values`.
- **`structural`**: the layer switches.
- **`sim`**: a composed sim.

The id, card, thumbnail, family, tour step and passage stay, so `scene=bees` opens the bees
preset and `ab.ts bees` compares the same setting on both sides of a port.

A committed preset (`src/presets.ts`) remains a saved setup of a scene. "Bees · overgrown meadow"
is `scene=bees&grass=1&wildflowers=1` plus its values.

Considered and rejected: one scene per composer with a `preset` key, every old scene aliased onto
it the way `aurora` was aliased onto `lake` (`src/state.ts:353-384`). Every link would then write
every value where its preset departs from the composer's defaults: for bees, about a dozen keys
(eight layer switches, its hour, its cumulus), where the aurora alias writes 6. Every committed
preset of a ported scene would have to be rewritten into the composer's form to light in the
Presets view again, and the composer's own defaults would be arbitrary.

### Keys

- **Unique per composer.** A registry test checks it in both directions, as AXIOMS' law for
  runtime-joined namespaces asks (`AXIOMS.md:436-469`): every key a link, preset or migration
  names resolves to a knob or a step, and every knob is reachable.
- **A port keeps its scene's keys** wherever they are unique in the composer. For meadow and bees
  every key survives but the two seeds (`meadowSeed`, `scenerySeed`, which become the composer's
  `seed`): `grassHeight`, `haze`, `dandelions`, `wildflowers`, `mown`, `flowers`, `lantern`,
  `bees`, `swarm` and the rest keep their meaning.
- **A colliding key is qualified** as `<layerId><Key>` and migrated. The scenes ported later take
  most of the qualifying: country's `wildflowers` becomes `valleyWildflowers`; each further scene's
  `mark` becomes `<layer>Mark`.
- **A layer's switch is its id**: a toggle, or the feature knob it grew from (meadow's
  `dandelions` and `wildflowers` keep their key, kind and `-amount`). A layer switch never needs a
  migration of its own.
- **Keys that become the composer's** (`meadowSeed` and `scenerySeed` become `seed`; autumn's and
  bamboo's `gusts` take the shared field's meaning) take a `keys` step for links naming those
  scenes.
- **Rejected**: a dotted form `bees.flowers`. It reads like the A/B slots' `a.` and `b.` prefixes
  and would change the knob key pattern and the GLSL names.

`MIGRATIONS` changes as follows:

- **One `keys` step per phase** (`since: URL_VERSION + 1`), holding each ported scene's renames.
- **`alias`** only for an id that is retired.
- **A new `split` step**, for a scene whose knob chose a camera that now belongs to another
  composer. Garden's and dunes' `camera=1` (from above, overhead) open new scene ids of the
  `overhead` composer, `gardenabove` and `dunesabove`. `checkMigrations` learns the kind: `from`
  still names a scene, `to` names a scene, and the step moves only `from`'s keys.
- **`url-keys.json`** lists each composer's keys once, for every preset of that composer, and
  still only grows.
- **Committed presets** that set a renamed key are rewritten in the new keys, their `commit`
  moved to the porting build (`src/presets.ts:5-9`).

### The A/B plan

Every port carries its pixel comparison (`scripts/ab.ts`, `README.md` "Pixel identity").

1. **Before porting,** record the scene's witness set in the PR:
   - its defaults, both dithered and with `view=source`;
   - every committed preset of the scene;
   - one witness per knob group: night, rain, snow, and each gate on.
2. **After porting,** run `ab.ts --base <pre-port revision>` over the witnesses.
3. **Pass:**
   - `SAME`; or
   - `DIFFERS` within tolerance: at most 0.5 % of cells at defaults and 2 % on witnesses, each
     difference attributed in the PR to a named shared-part change (the gust field, the grade),
     with its diff image inspected.
   - A structural difference fails at any share: a part missing, moved or lit differently.
4. `ab.ts` gains a `--tolerance` report of the share of differing cells. The operator decides
   whether a tolerance is allowed at all (D3).
5. Regenerate a thumbnail only where the defaults differ.
6. The GPU checks keep holding every layer set's all-features program byte for byte to each
   setting's own program, as `worldFeaturesAll` does today.

## Cost

### Per-pixel cost

**What costs.** Under SwiftShader a stack costs:

```
base (World and composer prelude) + Σ over on layers of (the gated cost of its passes)
```

Every line runs whatever a pixel takes, so covering only part of the frame saves nothing.

On a GPU, each layer's passes first test its claims' screen bounds, which is a coherent branch, so
a stack costs about:

```
base + Σ (gated cost × the share of cells the layer covers)
```

The composer's own work per cell is small: the depth tests, at most 12 claim tests where a cover
asks, and at most 8 lights.

**What is free.**

- An off layer is absent from the source: its GLSL is not concatenated.
- An off gate inside an on layer is absent after `#if`.
- Whatever is left unreached is removed by the function shaker (A2, in flight).
- On a GPU drawing the all-features program of the current layer set, an off gate's runtime test
  is a uniform branch.

So "off layers are free" holds on every renderer, and the cost of a stack is the sum of what is
on.

### Budgets and caps

| Limit                                      | Value                                                                                                                   | Basis                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layers on, the World not counted           | at most 8                                                                                                               | Bees has 4 layers, and the pilot mix 6.                                                                                                                                                                                                                                                                                                  |
| Front `subject` dressings                  | at most 2                                                                                                               | Placement (see "Foreground conflicts").                                                                                                                                                                                                                                                                                                  |
| Shaken program at a preset's defaults      | at most 160 KB                                                                                                          | The largest today: train 134 KB, street 107 KB.                                                                                                                                                                                                                                                                                          |
| Shaken all-features program of a layer set | at most 256 KB                                                                                                          | The pilot mix's union is 204 KB, and meadow + bees + campfire + fireflies 253 KB. Today's largest is the countryside at 213 KB.                                                                                                                                                                                                          |
| Fragment uniform vectors                   | at most 224                                                                                                             | WebGL2's guaranteed minimum, checked by the shaker's `glsl:check`.                                                                                                                                                                                                                                                                       |
| Knobs one program reads                    | at most 128                                                                                                             | `uParams` is laid out per program, holding only the knobs of on layers (see "Programs: how many and when").                                                                                                                                                                                                                              |
| Knobs a composed scene lists               | at most 512                                                                                                             | CPU only.                                                                                                                                                                                                                                                                                                                                |
| Trigger slots                              | 32                                                                                                                      | Packed; every offered layer's slots are numbered statically at assembly. An estimate from today's scenes: about 28 for the outdoor composer once the World's meteors and lightning and the shared gusts are counted once. `triggers.test.ts` checks each composer; one that outgrows 32 lays its slots out per program, as `uParams` is. |
| Composer uniforms                          | 8 vectors                                                                                                               | The principals' ground points only. Claims, anchors, lights and the grade are compile-time constants of the program.                                                                                                                                                                                                                     |
| Sim textures                               | 8                                                                                                                       | WebGL2 guarantees 16 fragment texture units. Today uses 4 + `uLeaving`.                                                                                                                                                                                                                                                                  |
| Sim CPU time, whole stack                  | at most 4 ms a frame (headless)                                                                                         | The audit measured 0.001–4 ms per sim.                                                                                                                                                                                                                                                                                                   |
| SwiftShader frame, 320×200                 | a preset at most 1.15× its scene before porting; a committed mix within the sum of its layers' marginal costs plus 10 % | `verify.ts`                                                                                                                                                                                                                                                                                                                              |
| GPU frame, 960×540                         | at most 16.7 ms on the reference integrated GPU, once one is recorded (`SCENES.md`, "GPU cost on real hardware")        | `bench.html`, which gains `layers=`                                                                                                                                                                                                                                                                                                      |

The lab sums the on layers' costs (`cost`) into a stack meter. A layer whose turn would break a
budget is dimmed, with the budget named. A link over the cap keeps layers in canonical order up to
it and drops the rest, with a notice.

### Programs: how many and when

A composer's feature sets are every subset of its layers, each with every subset of its own gates:
for a layer set S, Π over i in S of 2^gᵢ. Summed over sets, that is astronomically many. None is
compiled ahead; the renderer builds what is visited:

- **A knob turn inside a layer set** draws with that set's all-features program on a GPU, built
  once in the background; a software rasteriser builds the setting's own program. This is today's
  rule, scoped to the set.
- **A layer turn is structural.** It builds the new set's own program in the background on every
  renderer. Meanwhile the old picture keeps drawing as it did. When the new program is on screen,
  the layer's entrance plays. While the lab is open, the new set's all-features program is then
  built aside.
- **The set is order-free.** A layer set's key is its layers in canonical order, so the same set
  reached two ways is one program.
- **Knobs are laid out per program.** A program defines `K_<key>` only for the composer's knobs
  and its on layers' knobs, packed into `uParams` in canonical order. The program carries its
  index map, and the renderer uploads through it; today it copies the first `MAX_PARAMS` values
  (`src/renderer.ts:1249-1250`). `MAX_PARAMS` splits in two: the scene's knob list (512, CPU
  only) and what one program reads (128).
- **Retention is unchanged:** 4 programs per scene, 8 in all.
- **Never** is a composer-wide all-features program built: 868 KB shaken for the outdoor scenes,
  where the countryside's 213 KB already takes 20 s under SwiftShader.

### Checks

- **Static (glslang, compile only):**
  - each preset's default and all-features programs;
  - each committed mix;
  - each layer alone over its composer's base;
  - for each changed layer only, each compatible pair with it. Estimated from the porting tables
    below, the outdoor composer will hold about 60 layers, so at most about 59 pairs per changed
    layer. Each must be under the budgets.
- **Browser (SwiftShader, draws):**
  - each preset's and committed mix's all-features program byte for byte against every knob turn
    of its layers (`src/knob-turns.ts`);
  - `composerDepth`: with alpha rounded to 0 or 1 (a define only the check sets), the opaque passes
    in reversed order draw the same cells;
  - `composerClaims`: no cover grows inside an exclusive or clearing core;
  - `composerWeather`: with wetness and lying snow at 1, every on layer's cells change;
  - `layerToggles`: a layer turn never waits for a build;
  - `passageSpeeds` per preset (split in four by A2's in-flight tests work).
- **Generated:** `scripts/layer-costs.ts` writes `src/compose/costs.json`, and a check fails when
  the file is stale, as the decisions index does.
- **Timing records:** every new browser check gets a record in `scripts/verify-timings.ts`, which
  A2's in-flight tests work makes `verify-plan.test.ts` require.

## Sims

One `SimFrame` reaches one `ComposedSim`, which is what the renderer sees as the scene's sim. Each
on layer's `LayerSim` receives a `LayerFrame`: the same clocks, budget, size, pointer, parallax and
passage, plus the following.

- **Its knobs** under their short keys. The views are rewritten in place each frame, so nothing is
  allocated per frame.
- **Its trigger slots and `fired`.**
- **The rig** as a `LevelCamera`, or the interior or overhead twin.
- **The ground:** the placed claims, `coverAllowed`, the floor at a point, and the layer's own
  anchor.
- **The gust field's CPU twin.**
- **The principals** (see "Principals and chores").
- **Writers for the shared resources:**
  - slot 0, the **speck map**: rg8 at frame size, one nearest-depth `SpeckMap` (`src/sims/specks.ts`)
    with a range of codes per layer and one depth step for all (bees' quarter metre). Every speck
    of every layer is hidden by every other layer's nearer things.
  - slot 1, the **records atlas**: `rgba16f`, nearest, 512 texels wide, rows allocated per layer.
    `PlantTexture`'s `rowBase` already writes there. Meadow's `rg16f` blades take two channels of
    a row.
  - slots 2–7, the **fields**: up to six textures in any format and filter. Height fields, the
    pointer's wake, GPU solvers' outputs.

Allocation is a pure function of the layer set **on screen**:

- Rows and slots go by canonical order.
- `SimFrame` gains `features`, the feature set of the program this frame draws with, and the
  composed sim serves that set's allocation. A layer switched on but not yet on screen is built and
  run ahead at `dt` 0, as an incoming scene's sim is during a passage. When the new program
  arrives, the allocation switches within that frame.
- A layer's GLSL reads its data through accessors the assembler generates (`<layer>Record(x, y)`,
  `<layer>Field0()`, `<layer>SimOn()`), never through `uSimN` directly.

Budgeted work (`runBudgeted`) is handed down the layers in canonical order. The composed sim's
`ready()` is true when every layer on screen is ready. Every layer sim keeps the frame-rate
contract A2's tests work adds (`src/sims/frame-rate.test.ts`, 60 against 144 Hz): a `FixedStep`,
and chance drawn on steps. GPU solvers (ripple, tidepool, delta, incense) keep their own passes and
only hand their output to a field slot.

## The lab

- **Layer switches.** Each layer's switch carries a `{ kind: "layer", role }` widget. The switches
  gather into one **Layers** section after the World shelf, as the `night` parts gather into the
  Night sky section. It has a row per role:
  - in each row, a chip per offered layer: on, off, refused (dimmed, with its reason) or over
    budget (dimmed, with the meter);
  - a "+" opens the role's offered layers, with their thumbnails and costs.
- **Layer sections.** Each layer's groups carry `Blurb.layer`. They stand under their layer's
  heading after the Layers section, in role order, and show only while the layer is on (`when`).
  The lens still counts changes left dormant on an off layer, so turning a layer back on keeps its
  settings.
- **Presets are the starting points.** The Scenes view's cards are the scene presets, shelved by
  composer (an operator decision, D9). "Reset what changed" returns to the preset, layers
  included.
- **Shuffle, undo and redo.** Shuffle never turns layers (their switches are steady). Undo and
  redo cover layer turns like any knob.
- **The compact bar,** in order:
  - the World chips;
  - a Layers chip, lit while the layer set differs from the preset's;
  - one chip per on layer: its icon, and a popover holding all of that layer's sections;
  - Global.

  The fit rule is unchanged: chips go icon-only together, then the strip scrolls.

## Principals and chores

Principals (A2, audit I-20) are a composer service. For each principal, the composed sim has:

- its screen point;
- its point in the site, through the rig: the ground hit outdoors, the ledge or floor indoors, the
  patch point from above;
- the claim and the layer under it.

Layers receive this list. The GLSL gets `uPrincipalGround[8]` beside I-20's `uPrincipals[8]`. The
composer draws every cursor last: a human's and an agent's differ by motion alone (I-40). The
visitor is principal 0.

A **chore** is a layer of role `chore`:

- It `requires` its host.
- It acts through **affordances** the host's `LayerSim` exposes, a typed interface: the host owns
  the state and nature's undo; the chore owns the plan and the tool.
- The cast (I-40) assigns agents to chores.
- Chores are deterministic for the seed and stand still at motion 0.
- Principal 0 can do the same chore with the pointer.

| Chore         | Composer                                                | Host                                   | Affordance                                                                  | Nature's undo                                                    |
| ------------- | ------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Leaf raking   | `outdoor`                                               | autumn's litter (`src/sims/litter.ts`) | `rake(path, width)` gathers the top layer into piles                        | gusts lift the piles in swirls                                   |
| Cairns        | `outdoor`                                               | shore's beach                          | `place(stone, on)` on a small rigid stacking sim (new, `src/sims/stack.ts`) | the surf's run-up topples them                                   |
| Garden chores | `outdoor`                                               | bees' apiary                           | `plant(drift, row)`, `weed(drift)` change a drift's density map             | weeds come back on the growth clock; the bees follow the flowers |
| Star-joining  | any composer with a sky, an interior through its window | the World's constellations             | `join(starA, starB)` adds a figure line                                     | the figure fades at dawn and is redrawn the next night           |
| Sand raking   | `overhead` (sand table), `outdoor` (garden)             | the sand bed, the gravel               | `groove(path, tines)` writes the height field                               | the ball's track; garden's drying and weather (`AgeField`)       |
| Shared table  | `interior`                                              | the harmonograph's sheet               | `pen(path)`                                                                 | a fresh sheet slides in once the figure is signed with the M     |

J1 ("agents at work") builds these chores. This record only fixes where they plug in.

## Migration

Each phase is one coherent change under #1082, with its acceptance below and the A/B plan above.

### Phase 0: prerequisites (A2, already scoped; U1 waits for them)

- The function shaker, the compile budget test, `glsl:check` and the uniform packing (A2 "Shader
  assembly", A-16). These are in flight.
- The shared verify kit and the frame-rate contract suite, in flight in A2's tests and CI work.
- Lazy scene loading (A-8, I-22), before Phase 2: a composed scene's import closure is every
  layer it offers.
- Presence plumbing (I-20), before the first chore and before any layer reads principals.

**Acceptance:** those items' own criteria, on `main`.

### Phase 1: the composer runtime and the outdoor pilot (meadow, bees, the overgrown garden)

**Builds:**

- `src/compose/`: types, `composeScene`, the placement solver, the composed sim, the site.
- `src/shaders/lib/compose.ts`: `Cell`, the rig, claims, lights, the gust field and the entry
  generator.
- The `outdoor` composer.
- The `SceneDef` additions: `glslFor`, `featuresAllFor`, `structural`.
- Per-program `uParams` layout; `SimFrame.features`; 8 sim slots; 32 triggers.
- The layer widget, `Blurb.layer`, the Layers section and its chips.
- The checks listed under "Checks", and `layer-costs.ts`.

**Layers:**

- `downs` (backdrop): meadow's hills, tree line, mown M, air and deck tint, rain shafts and
  curtains.
- `grass` (cover): the sea of grass and the two near layers.
- `dandelions` (dressing): the clocks and their seeds.
- `wildflowers` (cover): the shared plant component.
- `hillside` (backdrop): bees' three hill bands and the far orchard.
- `lawn` (ground): lawn, path, hedge and near blades.
- `apiary` (dressing, subject): hives, wall, orchard trees, drifts, foxgloves, near blooms,
  lantern, fairy lights.
- `insects` (life).

**Presets:** `meadow`, `bees`.

**Committed mix:** "Bees · overgrown meadow".

**Acceptance:**

1. **Pixels.** `ab.ts --base <pre-port> meadow bees`, over the witness sets, passes the A/B plan.
   Meadow is `SAME` (its gust field becomes the shared one). Bees is `SAME` except the sway its
   gusts move, if D4 promotes meadow's field; that difference is attributed.
2. **The mix.**
   - Covers grow nowhere inside the hives', wall's and path's cores (`composerClaims`).
   - Nearer grass hides the feet of the hives and stands in front of the hills.
   - A bee behind a near blade is hidden.
   - The lawn's near blades are suppressed.
   - Hive shadows fall on the grass.
3. **Weather.** `composerWeather` passes for all 8 layers. Rain falls between the hives and the
   grass at the composed depth.
4. **Cost.**
   - Meadow and bees are each within 5 % of today's shaken sizes (81 and 153 KB, 84 and 151 KB).
   - The mix's all-features program is at most 230 KB shaken.
   - Every program is at most 224 uniform vectors.
   - SwiftShader frames: each preset at most 1.15× its scene before the port; the mix within the
     sum of the layer margins plus 10 %.
5. **Links.**
   - Every key in `url-keys.json` for meadow and bees opens as before: `state.test.ts` cases for
     `meadowSeed` and `scenerySeed` moving to `seed`, for bees' schema 3 `clouds` step still
     running first, and for `wildflowers` and `dandelions` unchanged.
   - Their committed presets load as themselves (`presets.test.ts`).
   - `url-keys.test.ts` passes.
6. **Lab.** In a real browser, driving the actual controls:
   - adding and removing `grass` in bees;
   - the refusal of a second ground, with its reason;
   - undo and redo;
   - the lens counting a dormant change.

   Vision inspection of screenshots of the panel and the compact bar.

7. **Programs and passages.**
   - A layer turn never waits for a build (`layerToggles`).
   - Turning `grass` on plays its entrance.
   - `passageSpeeds` holds for both presets.

| Scene  | At risk                                                                                                                                                                                                                                        | Preserved by                                                                                                                                                                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| meadow | Camera constants baked into the grass (`MEADOW_LAYER_Z`, the root and pitch arrays), the eye's drop on entry (`meadowDrop`), the golden haze and `meadowDeck`, its own gust field, `meadowSeed`                                                | Rig parameters with the same values; the drop as the rig's passage; the air and sky staging owned by `downs`; its gust field becomes the composer's; `seed` with the same value draws the same                                                               |
| bees   | Its camera (0.47, 1.0, 1.6 m) and its stage of at least 0.62 half widths; the 1.5× hives; shadows of trees and hives on the lawn; `beesGust`; the moon as key after sunset; `SKY_MOON_PHASE` compiled in always; specks tested against `beesZ` | A rig with `minAspect` 1.24; a declared display scale; caster claims on bees' own shadow model; the shared gust field (the attributed sway difference); the grade's moon key; a preset feature; the composed depth, which equals `beesZ` while bees is alone |

### Phase 2: the rest of the outdoor composer

Phase 2 runs in three waves, each with its own A/B and one committed cross-scene mix:

- **2a** (World adopters on level rigs): shore, autumn, falls, lanterns, and dunes' aerial view.
  Mix: "Autumn maple by the lantern river".
- **2b** (ground-level scenes with skies or canopies of their own): campfire, fireflies, forest,
  bamboo, garden from the veranda, lake. Mixes: "Campfire in the meadow" and "Fireflies over the
  apiary".
- **2c** (raised or tilted rigs, sky subjects): country, street, skyward, flock, swell, dew. Mix: "A
  campfire on the valley's hill".

**Acceptance for each wave:**

- every ported scene passes the A/B plan;
- every budget holds;
- the new scenes' links and committed presets pass;
- `triggers.test.ts` holds;
- the wave's mixes pass `composerClaims` and `composerWeather`.

| Scene          | At risk                                                                                                                                                                                                                                                         | Preserved by                                                                                                                                                                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shore          | The storm bank at sea and its bolts on the World's strike timing; drops thinned so they never bury the surf; the sky mirrored in the sea and the wet sand; the pointer's wake (`r8`)                                                                            | The `sea` backdrop owns the bank and its bolts; the backdrop may thin precipitation (`thin`, as `worldPrecipThinned` does); the `beach` ground draws its mirror through `worldMirrorView`; the wake becomes a field slot                                             |
| dunes          | The Werner sand fields (`r16f` heights, `rgba16f` slopes, linear); the heat shimmer bending the ray; the dust replacing the World's fog; the pour under the pointer; the overhead view                                                                          | Two field slots; the backdrop's ray hook (`worldViewOf`); the backdrop owns the air; principal 0 on the dune field; a `split` to `dunesabove` in Phase 4                                                                                                             |
| autumn         | Its own `rainFall` and `fogAmount` instead of the World's (`src/scenes/autumn/shader.ts:888-897`); canopy layers blended by alpha; the passage's lens shift; litter and leaves (4 `rgba16f` textures); the `gusts` knob's meaning                               | World precipitation at the composed depth (attributed, close); one `maple` dressing that keeps its internal order; the rig's lens shift; the records atlas; a `keys` step onto the shared gusts                                                                      |
| falls          | The cliff as a backdrop that is also the subject; `auroraLift`; its own swifts (`birdKnobs`); the ferns on plant records; the spray and the rainbow                                                                                                             | `auroraLift` stays the backdrop's World staging; its birds move to the World's (the species stays the preset's); the records atlas; the spray as a veil                                                                                                              |
| lanterns       | The river mirroring the World's sky; potential-flow lanterns; the young crescent, already lost (#1082 known open point)                                                                                                                                         | A `river` ground, shared with fireflies; a `lanterns` life layer; no further loss                                                                                                                                                                                    |
| campfire       | Its own shooting stars (`K_shooting`) and the giant planet in place of the moon (`README.md:947`); a low seat across the flames; the fire, sparks and smoke; the fuel bed                                                                                       | World meteors (`keys` step) and the giant as a planet in the World's list (the giant-to-planets step is the precedent); a rig eye of about 0.9 m; a `campfire` dressing (subject) with veils and a declared light, which lights every other layer; the records atlas |
| fireflies      | Its own moonless sky and its own stars (`README.md:953`); the river's mirror; the mangrove bank (plant records); the pointer's lantern; bees' simpler fireflies, a second implementation                                                                        | World stars with the moon off (close, attributed); the `river` ground; a `mangroves` backdrop; every principal a lantern (I-35); one `fireflySwarm` life layer (not `swarm`, which is bees' key), with bees' `fireflies` mapped onto it at coupling 0                |
| forest, bamboo | The canopy weather (shelter, gap sky, rays, drips; `canopyGroveGlsl`); kodama, stag and spores; the water clock; the dolly passages                                                                                                                             | A `grove` backdrop and dressing with shelter claims; the life layers keep their sims; the clock as a subject dressing; the dolly as the rig's passage                                                                                                                |
| garden         | Its own units (garden depths, not metres) and gravel grid (672 × 280 over an aspect of 2.4; `src/scenes/garden/sim.ts:74-99`); the horizon at the frame's top edge (1.0: no stars); the woods over the wall (plant records); the unseen rake; its season choice | A fixed number of metres per garden depth, declared by the layer; a `gravel` ground with a field slot; a rig horizon of 1.0; the records atlas; the rake as a chore whose default agent is unseen; the composer's `season` (a `keys` step)                           |
| lake           | Its own night by design (own stars and hour knobs, the substorm aurora, the drapes; `README.md:955-961`); two places (ice, fjord); the `aurora` alias                                                                                                           | A night override the backdrop stages on the World, keeping lake's keys; `setting` becomes two layer pairs under a radio (a `keys` step: `setting=1` turns the fjord's layers on); the `aurora → lake` alias still runs first                                         |
| country        | The terrain build on the worker; its records atlas and terrain textures (all 4 slots); 30 own knobs and 19 gates; the hill vantage; the keys `wildflowers`, `smoke`, `mark`                                                                                     | A `valley` backdrop and ground pair that keeps its textures in field slots; a hill rig whose front band offers the hilltop to dressings; its budget measured; collisions qualified (`valleyWildflowers`)                                                             |
| street         | The high window, pitched down; crowd and traffic sims (3 slots); the city round the crossing                                                                                                                                                                    | A pitched rig; `crowd` and `traffic` life layers; a `city` backdrop shared with the interiors' windows; standing-eye layers not offered (camera range)                                                                                                               |
| skyward        | Lying on your back (pitch about 70–90°); birds from below (`birdBelowHit`); snow from overhead (`snowFallSeen`)                                                                                                                                                 | The rig's pitch; the World's `worldPrecipSeen`; only sky-side layers offered                                                                                                                                                                                         |
| flock          | The murmuration over a skyline; the boids and density field                                                                                                                                                                                                     | A `murmuration` life layer (any outdoor sky) over a skyline backdrop                                                                                                                                                                                                 |
| swell          | Its own moon disc and its `waterGlitter` path                                                                                                                                                                                                                   | The World's moon (close, attributed); a `sea` backdrop and ground                                                                                                                                                                                                    |
| dew            | A macro web against a backdrop out of focus                                                                                                                                                                                                                     | A rig with a focal blur that raises each layer's `foot` with distance. If the blur cannot hold the picture, dew stays standalone (D7).                                                                                                                               |

### Phase 3: the interior composer

**Builds:** the `interior` rig and site, with a window that continues the ray into `outdoor`
backdrops and the World.

**Pilot:** sill, lava, and the mix "Lava lamp on the sill". Then bar, train, bonsai, mobile,
incense, frost, clouds and harmonograph.

**Acceptance:**

- the A/B plan for each scene;
- in the pilot mix, the lamp's declared light lighting the cat and the books;
- outdoor layers drawn through the window only in window cells;
- the budgets, with the window's outdoor cost counted.

| Scene        | At risk                                                                                                        | Preserved by                                                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sill         | The city through the glass under the World's sky; the cat's gaze sim; steam; the curtain; the neon M           | The room's window with the `city` backdrop; dressings for the cat, mug, plant and books; the M as the `city` backdrop's                                              |
| lava         | The coloured light thrown about the room; the metaballs through the glass; its parcels                         | A `lavaLamp` dressing with a declared light; the records atlas                                                                                                       |
| bonsai       | The sun's shadow moving over the wall; its seasons; the build on the worker (4 slots)                          | A key-light caster on the back wall; the composer's `season`; field slots                                                                                            |
| train        | The carriage; the country sliding past; tunnels turning the window into a mirror; stations; `line`; 6 triggers | A `line` backdrop that travels with its own sim; the tunnel mirror inside the backdrop; 6 static trigger slots                                                       |
| bar          | The back-bar mirror doubling the room; bartender and patrons; the street in the rain                           | The mirror stays inside the `bar` dressing and reflects only its own parts: guest dressings are not mirrored (a stated loss); the `city` backdrop through the window |
| mobile       | Shadows from the Sun lamp onto the wall and ceiling                                                            | A declared light, with casters on the walls and ceiling                                                                                                              |
| incense      | The GPU smoke (`rgba32f`, 4 slots); the window's shaft of light; the vent                                      | Field slots; the window as an area light; the vent as the dressing's own                                                                                             |
| frost        | The pane's frost; the street or cabin outside                                                                  | A `pane` dressing on the window glass; an `outdoor` backdrop beyond it                                                                                               |
| clouds       | The cloud sea from a plane window                                                                              | A cabin room; a `cloudSea` backdrop (the clouds' volume tier)                                                                                                        |
| harmonograph | Paper, pendulums, pen                                                                                          | The shared table (I-41): the ledge as the table, with the pens as a chore                                                                                            |

### Phase 4: the overhead composer

**Builds:** the `overhead` rig, with tilt and orbit gated, and the bed and water site.

**Pilot:** pond and ripple, and the mix "Ripples in the koi pond", in which every principal is a
wave source (I-38). Then sandtable, tidepool, delta, island, and garden's and dunes' views from
above (the `split` scenes).

**Acceptance:**

- the A/B plan at a tilt of 90°, where the picture is exactly today's;
- tilt and orbit off cost nothing (the gate is absent);
- with tilt on, the march stays within the budgets;
- scale ranges refuse mismatched layers.

| Scene                       | At risk                                                                                   | Preserved by                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| pond                        | 51 knobs; plant sheets rasterised flat on the worker; koi; caustics; the canopy           | Bed, water, dressing and `koi` life layers; while a sheet layer is on, the tilt knob stops at 60°, since the sheets are flat sprites |
| ripple                      | The wave tank's GPU solver; the experiments' layouts                                      | A `tank` layer; in the mix, its wave field is the pond's surface slope                                                               |
| sandtable                   | The ball and funnel machines on a height field                                            | A `sandBed` ground, which is also the raking chore's host                                                                            |
| tidepool                    | GPU shallow water; plants read back from the GPU; caustics                                | Bed, water and life layers                                                                                                           |
| delta                       | Kilometre scale; satellite palettes                                                       | A scale class of its own; layers at bench scale are refused                                                                          |
| island                      | A raymarched island under an orbiting camera at 20° (`src/scenes/island/shader.ts:30-39`) | The rig's orbit at tilt 20° and kilometre scale                                                                                      |
| garden and dunes from above | Their second camera                                                                       | The same layers drawn through the `overhead` rig (`split` ids)                                                                       |

### Phase 5: the matter shelf, and what stays standalone

- **Optional (D7):** petri, physarum, marble, chladni, ferro, film, pearl, prism and pendula, as
  dishes, plates and boards on the interior's ledge or the overhead's bench.
- **Standalone:** fractal, hyperbolic, orbit and shanshui keep their own `SceneDef`. They have no
  space to share: a pure field, a tiling, outer space, a painted scroll.
- **Pending (D7):** kelp, under water. It could become a "submerged" outdoor rig, or stay
  standalone.

## Risks

1. **Porting effort.** The 35 scenes the phases port hold about 87,000 lines of TypeScript outside
   their tests and checks (`wc` over their folders at `4d490f15`). Every port turns camera
   constants into rig parameters, a source of slow visual drift. The phases, the A/B plan and the
   kept ids bound it, but U1 is the largest workload in #1082.
2. **Compile stalls.** A layer turn costs a background build: 2–5 s under SwiftShader, and an
   unknown time on a phone GPU. The old picture keeps drawing and the layer enters on arrival,
   but a slow phone may show a long wait. Mitigations: bench `layers=`, and keep the landing page
   to fixed presets, where no structural turn happens.
3. **Program size on drivers.** A 256 KB shaken program may exceed a mobile driver's limits even
   inside WebGL2's minimums. `glsl:check` sees uniforms, not instruction limits; only `bench.html`
   on real devices does.
4. **Software rasterisers.** There, the cost of a stack is its full sum. Audit I-10's lite mode (a
   poster on software renderers) becomes more important.
5. **Link churn.** Each later port qualifies colliding keys. Old links rely on the `keys` steps,
   and every committed preset that sets a renamed key is rewritten.
6. **Art-direction clashes.** Bees' picture-book cumulus and meadow's photographic grass may not
   belong in one frame. That is curation, not engineering: committed mixes are operator-reviewed.
7. **Placement stability.** Anchors and claims become part of each layer's meaning (see
   "Foreground conflicts"). A careless change moves things in old links.
8. **Shared fields change scenes.** One gust field, one grade model and one firefly
   implementation make some scenes close rather than `SAME` (D3, D4).
9. **README growth.** The audit already flags it (H2-17). The Composers section replaces per-scene
   prose as scenes port: their "what stays the scene's" paragraphs move into each layer's header.
10. **Dependencies.** U1 depends on in-flight A2 work: the shaker, the packing, presence and lazy
    loading. A late prerequisite delays Phase 1 or 2; it does not change the design.

## Decisions for the operator

| #   | Question                                                                                   | Options                                                                                                                              | Recommendation                                                                                                    |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| D1  | How a scene becomes a preset                                                               | (a) The scene id stays and is generated from a scene preset. (b) One scene per composer with a `preset` key, every old id aliased.   | (a): compact links, unchanged cards, thumbnails and tours, and `ab.ts` compares like for like                     |
| D2  | Layer knob keys                                                                            | (a) Keep each scene's keys where unique; qualify collisions as `beesFlowers`. (b) Qualify every key. (c) Dotted, `bees.flowers`.     | (a)                                                                                                               |
| D3  | Pixel identity per port                                                                    | (a) `SAME` only. (b) `SAME`, or "close" within the tolerances above with each difference attributed.                                 | (b), with structural differences always failing                                                                   |
| D4  | One gust field                                                                             | (a) Promote meadow's field; bees', autumn's, bamboo's, garden's and falls' sway changes. (b) Keep each scene's gusts as layer-local. | (a): one wind is what makes a mix one world                                                                       |
| D5  | Readability scale cheats                                                                   | (a) Allowed when declared. (b) Forbidden.                                                                                            | (a)                                                                                                               |
| D6  | Caps and budgets                                                                           | the table under "Budgets and caps"                                                                                                   | as stated, revisited after Phase 1's measurements                                                                 |
| D7  | What stays outside the composers                                                           | dew, kelp, the matter shelf                                                                                                          | fractal, hyperbolic, orbit and shanshui standalone; kelp and dew decided at their wave; the matter shelf optional |
| D8  | Lazy loading before Phase 2                                                                | yes / no                                                                                                                             | yes                                                                                                               |
| D9  | How the Scenes view shelves presets                                                        | (a) Today's families. (b) By composer.                                                                                               | (b) once Phase 2 lands                                                                                            |
| D10 | Scenes with skies of their own (campfire's meteors, fireflies' moonless sky, lake's night) | (a) Fold into the World, with staging hooks. (b) Keep each scene's own.                                                              | (a), except lake's night, which stays as a backdrop's night override (by design today)                            |
| D11 | Interior windows                                                                           | (a) A live `outdoor` backdrop through the glass. (b) A painted backdrop.                                                             | (a), in window cells only                                                                                         |
| D12 | Turning a layer on or off                                                                  | (a) Plays its entrance or exit. (b) A cut.                                                                                           | (a)                                                                                                               |

## Alternatives considered

- **Status quo, with more shared components.** Rejected: it gives no mixes, and every new scene
  repeats a camera, a ground and a grade.
- **One scene per composer, with old ids aliased onto presets.** Rejected: see "A scene becomes a
  preset".
- **One all-layers program per composer.** Rejected by measurement: 868 KB shaken for the outdoor
  scenes, against 213 KB that already takes 20 s under SwiftShader.
- **Deferred layers.** Each layer would draw into its own colour-and-depth target, and a fixed
  pass would composite them. This would remove the combinatorial programs: each layer compiles
  once, and a scissor at its footprint saves work even under SwiftShader. Rejected for now:
  - it breaks the one-pass budget (`README.md` "Art direction");
  - it breaks the five-channel `Shade` contract and the leaving scene's dissolve;
  - it costs N full-frame `rgba16f` targets of bandwidth on phones;
  - it would rewrite the renderer's frame loop.

  The revisit trigger is below.

- **A `layers=` list key.** Rejected in favour of switch knobs, which reuse `when`, the lens,
  undo, presets, `url-keys.json` and the migrations unchanged.
- **Dotted keys.** Rejected: see "Keys".
- **An entity system or scene graph.** Rejected, as the second audit's slices already did.

## Revisit when

- A committed preset's own program takes more than 5 s to compile on the reference GPU, or a layer
  turn on a phone takes more than 2 s before the layer shows. Revisit deferred layers then.
- The stack meter's budget refuses a mix the operator wants. Revisit the caps with that mix's
  measurements.
- WebGPU reaches Firefox on Linux and Android. The platform consensus (WebGL2) is the premise of
  the single-program design.
