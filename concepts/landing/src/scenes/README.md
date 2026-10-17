# Writing a scene

A scene is one folder, `src/scenes/<id>/`, whose `index.ts` exports a `SceneDef` (see `types.ts`).
The registry `src/scenes/index.ts` lists scenes in lab order. Everything a scene needs is in its
folder; shared pieces live in `src/shaders/common.ts`, `src/shaders/lib/` and `src/shaders/*.ts`
(GLSL), `src/scenes/atmosphere.ts` (shared knobs, page themes), `src/scenes/plants.ts` and
`src/scenes/planet.ts` (the plant component's and the giant planet's knobs), `src/params.ts` (knob
builders, `KnobReader`), `src/sims/` (simulation helpers, CPU and GPU), `src/mark.ts` (the
Manifold M) and `src/shaders/glsl.ts` (GLSL literals from TS).

```
src/scenes/<id>/index.ts    SceneDef: title, blurb, accent, look, params, groups, glsl, entry, sim
src/scenes/<id>/shader.ts   export const <id>Glsl = `...` defining Shade scene<Id>(vec2 uv, vec2 cell, float t)
src/scenes/<id>/sim.ts      optional SimFactory (CPU or GPU simulation feeding textures)
```

## The shader

Each scene compiles to its own program: `common` + its library `features` (`#define`s, see
"Composing components") + generated knob defines and `SKY_YEAR` (see "The climate") + shared `libs`
\+ the scene's `glsl` + the dithering `main`. The knob defines come ahead of the libraries so a
library may test an opt-in shared knob with `#ifdef K_<key>`; libraries read no other knob. The
entry returns a `Shade`:

```glsl
struct Shade {
  float ink;      // 0..1 coverage of the neutral ink   (palette "accent"/"mono")
  float accent;   // 0..1 coverage of the accent colour (palette "accent"; wins over ink)
  float shimmer;  // per-cell dither-threshold jitter: sparkle on water, frost, stars
  vec3 rgb;       // full-colour rendition (palette "full", the usual default for new scenes)
  vec3 source;    // undithered picture for the source/split views (usually = rgb)
};
Shade o = blankShade();
```

Fill all of `ink`, `accent`, `rgb` and `source`: the lab can switch palettes at any time. `ink` is
roughly the luminance of what matters; `accent` marks the one thing that should glow in the
scene's accent colour (the Manifold landmark, bioluminescence, a neon sign...). Most entries end
with `return shadeOf(col, inkOf(col, gain, gamma), accent);`: `inkOf` turns the ink dark on the
paper page (`pagePaper()`, see "Page theme"), so it can never disagree with the page.

Available in GLSL (from `common`): `uRes`, `uTime`, `uMotion` (the lab's motion 0..1),
`uMotionTime` (the motion clock, below), `uFallTime` (the fall clock, below), `uPointer` (smoothed
-1..1 parallax, 0 when the pointer is not followed), `uMouse` (raw pointer: xy in uv, z = button
held, w = scene time of the last press), `uBg` (the page background), `uParams[]`, `uTriggers[]`,
`sinceTrigger(slot)`, `uMotionTriggers[]`, `sinceTriggerM(slot)` (below), `uSim0..uSim3` +
`uSimOn` (textures from the scene's sim), `uWeather` (x: how wet the world is, y: how much snow
lies, both 0..1; see "Weather in the world"), `hash12`, `vnoise`, `fbm`, `rotate`, `rotateAbout`,
`segmentDistance` (a zero-length segment gives the distance to its end, as the TS twin in `mark.ts`
does), `markDistance` (the Manifold M in mark units: x in [-0.47, 0.47], y in [-0.5, 0.5]),
`starfield`, `threshold`, `LUMA`, `TAU`, and (`[...]` marks an overload):

```glsl
float cellTh;                                         // this cell's threshold(cell), set by main before the entry: read only
float edgeThreshold(vec2 cell, vec2 offset);          // a decorrelated threshold for a second edge layer, 0.004..0.996
float hardEdge(float cover[, float th]);              // cover > th (default cellTh) ? 1 : 0
float hardFill(float d, float aa[, float th]);        // hardEdge(softFill(d, aa), th): an SDF's inside, cut per cell
vec3 snapLevel(vec3 c);                               // c snapped per channel to the nearest palette level
vec4 hardRamp(float b, float cover, vec3 tint, float th); // light b in tint's hue, level-snapped whole; a = hard coverage

bool pagePaper();                                     // the page shows its paper theme (read from uBg)
float inkOf(vec3 col, float gain, float gamma[, vec2 paper]); // night: gain * lum^gamma; paper: (paper.x - lum) / paper.y, default (0.9, 0.8)
Shade shadeOf(vec3 col, float ink, float accent);     // rgb = source = col, no shimmer

vec2 hash22(vec2 p);                                  // its own hash, not a hash12 pair: swapping one for a pair moves seeded positions
vec4 vnoiseLattice(vec2 i);                           // vnoise's four lattice values round cell i = floor(p)
vec4 vnoiseLatticeNext(vec4 before, vec2 i);          // cell i's, from the cell before it in x: two hashes, not four
float vnoiseFrom(vec4 lattice, vec2 f);               // vnoise from its cell's lattice values at f = fract(p), bit for bit
vec3 vnoiseD(vec2 p);                                 // vnoise with its gradient (x value, yz d/dp)
vec2 vnoise1(float x, float seed);                    // 1D value noise 0..1 and d/dx
float fbm3(vec2 p);                                   // three octaves of vnoise, 0..1
vec2 fbmLod(vec2 p, float foot, int octaves);         // fbm whose octaves fade to their mean below ~4 cells: x noise, y detail kept; foot = a cell in p units

float smoothfall(float a, float b, float x);          // 1 at x <= b .. 0 at x >= a: write this, never smoothstep with edge0 > edge1
float softFill(float d, float aa);                    // 1 - smoothstep(-aa, aa, d): an SDF's inside, soft
float bell(float x);                                  // exp(-x * x)
float smin(float a, float b, float k);                // polynomial smooth minimum: min(a, b) rounded over a blend k wide
float sdBox(vec2 p, vec2 halfSize, float r);          // rounded box (r = 0: sharp corners)
float sdTaperCapsule(vec2 p, vec2 a, vec2 b, float ra, float rb[, out float t]); // t: position along a..b
float sdEllipse(vec2 p, vec2 r);
vec3 heightGrad(sampler2D h, vec2 uv, vec2 texel);    // a sim height texture's red channel: x height, yz d/du, d/dv
```

GPU simulation passes (`sims/gpu.ts`) don't get `common`: prepend `gpuCommonGlsl` (from
`shaders/common.ts`: the hashing, noise, rotation, shape, `heightGrad` and mark helpers; no
uniforms, `TAU` or `LUMA`) to a pass body.

### Time and motion

The entry's `t` is `uTime`, the scene clock: it stands still while paused and keeps running across
scene changes. Anything that moves at the lab's motion pace reads `uMotionTime` (a sim:
`frame.motionTime`): the renderer sums each frame's scene-clock step times `uMotion`, from the same
origin as `uTime`. It equals `t * uMotion` while the slider stands still, and moving the slider
changes the pace instead of jumping every phase, as `t * uMotion` does (with the day cycle on, by
hours after a few minutes). Never write `t * uMotion`, or divide a clock by `uMotion` (only
`meteorAge` and `lightningAge` do, to give a sub-second flash its real-time pace); `uMotion` alone
is for amplitudes. The sky uses `timeOfDayM(K_time, K_cycle, uMotionTime)` in every scene;
CPU day/night decisions use the same `frame.motionTime / 240` phase. Library functions take the
clocks they run on: a `tm` or `motionTime` parameter takes `uMotionTime` (or the scene's own motion
clock), a `tf` parameter `uFallTime`, the fall clock: each scene-clock step times
min(1, 2.5 × motion), for what gravity drives (falling rain, splashes, rings, drips), so rain keeps
real time above motion 0.4 and still stops at 0, and never jumps either. A "now" response that
plays at the motion's pace, as the scene's own events on `uMotionTime` do, keys on
`sinceTriggerM(slot)`: the motion seconds since the press (`uMotionTime - uMotionTriggers[slot]`,
huge while idle; a sim: `frame.motionTime - frame.motionTriggers[slot]`). It stands still with the
motion clock, so under reduced motion such a response holds its first frame.
`main` already stills `shimmer` with the motion: don't multiply it by `uMotion` again.

Under reduced motion the scene holds still but interactions still end. The scene clock and the
motion clock stand still, sims get `dt` 0, weather sits where it leads and there are no passages.
A press over the page or a "now" trigger is stamped on a clock that keeps real time, and reaches
the shader (`uMouse.w`, `uTriggers`) and sims (`frame.triggers`) moved back by as much, so
`t - uMouse.w`, `sinceTrigger(slot)` and `frame.time - frame.triggers[slot]` count real seconds
since it happened. Key a press's or a trigger's response to that age and bound it, so it plays
once and settles (Dunes' pouring streak fades 0.6 s after the press, and is held only while the
button is down); anything driven by `t` or `uMotionTime` stays put. Sims see the press and release
edges and `fired`, but no time, so their response is one still step. Paused, every age holds.

A picture that stands still is not redrawn. Paused, under reduced motion or at motion 0, the page
draws while something is on its way (an entrance, a passage, a program building, the parallax
easing to the pointer, a sim whose `ready()` is false) and for a while after each change or input
(`SETTLE_SECONDS`, 5 s; after a press, its release or a "now" trigger while the interaction clock
runs, `RESPONSE_SECONDS`, 20 s: `src/governor.ts`), then stops until the next. Bound a response to
that, and a sim that works on over frames at `dt` 0 (a budgeted rebuild, a build on the build
worker) reports `ready()` false until it is done, or its picture can stop half-way.

### Entrances and exits

Switching scenes (or first loading the page) is a passage, not a cut. The outgoing scene first
idles on while the incoming scene gets ready: its program builds in the background and is drawn
once off to the side (many drivers finish compiling a program at its first draw and hold the GPU
up while they do), then the incoming scene itself is created and runs ahead off screen, its sim
stepping with `dt` 0 and `enter` 0 and drawing one cell, until the sim reports `ready()` (a sim
that builds its world over several frames or on the build worker: the countryside's land, frost's
first field, the slime mould's first dish, the pond's plant sheets; at most 3 s). Any pause
therefore comes right at the switch, before anything moves, never in the middle of the passage,
and the scene enters with its world in place. Then the outgoing
scene plays its exit, drawn with its own settings. Part-way through that exit (the lab's overlap,
half by default) the incoming scene, the one run ahead, starts its entrance and takes the screen
over cell by cell in ordered-dither order (the middle first by default) over the blend length,
1.5 s by default. Both scenes draw while they overlap: the outgoing one goes on playing its exit
off screen at its own cell size, into the frame the incoming one dissolves out of, so both sides
of the dissolve move. An exit that would end before the blend does is drawn out to end with it,
so the outgoing scene never stands still under the incoming one. A switch made during the blend
leaves for the newest scene once the blend is done. The entrance's clock starts on its second
frame. Every scene gets the blend for free. On first load the bare page shows while the program
builds, and the scene dissolves in out of it. With passages off, under reduced motion or at motion
0 a switch is a cut, and so is a retry: the scene on screen goes on as it last drew until the next
one's program is built in the background, and then the next one is there. A context the browser
restores after losing it starts over as on first load. Nothing ever waits for a build.
The outgoing frame is sampled in normalized stage coordinates with nearest filtering, so a different
viewport or pixel size stretches the whole image rather than fetching outside it.

Every scene makes the passage its own, in the world rather than by fading:

- Set `passage: { enter, exit }` (seconds, about 2–3.2 in and 1–1.8 out) on its `SceneDef`, from a
  constant the shader also reads (through `glslFloat`) when it needs seconds.
- Read `passageIn()` and `passageOut()` in GLSL, or `frame.passage.enter` and `.exit` in a sim.
  - `passageIn()` runs linearly 0→1 over `enter` and then stays 1.
  - `passageOut()` is 0 until the scene leaves, then 0→1 over its exit (stretched to the blend if
    that is longer).
  - Ease them yourself, so that the passage carries its speed across the seam (below).
- Passages carry their speed, so that a switch reads as one continuous movement:
  - an exit starts gently from rest and accelerates away, still at or near full speed when
    `passageOut()` reaches 1 (`pout²`, `pout³`; never an ease-in-out such as `smoothstep`, and
    never motion that finishes early and then holds);
  - an entrance arrives moving and settles, at or near full speed at `passageIn()` 0 and at rest at
    1 (`1 - (1 - pin)²`, or `passageSettle(pin, s)` from `common`: a settle overshooting by as much
    as s sets, about 5% at 1.2; never a start from rest or a hold before the motion begins); light
    and fade accents may still be staged.
  - `bun concepts/landing/verify.ts passageSpeeds` measures it on the real renderer at motion 0:
    the picture change over the last steps of the exit and the first steps of the entrance as a
    share of the passage's fastest step (`LANDING_PASSAGE_SCENES=a,b` limits it to some scenes).
    It fails a scene below 0.35 on either side unless that side is exempt in
    `src/passage-speed.verify.ts` with its reason (an object leaving the frame at full speed, a
    passage that is a process or a light change, or one that only plays with motion).
- Things move into place, enter or leave the frame, a camera settles, a process starts up; light
  changes are at most an accent. Some examples:
  - The border plants of `pond` close in from the edges as the koi swim into view.
  - `country` tilts down from the sky onto the valley.
  - `chladni` strews sand on a still plate that then starts singing; on exit the plate tilts and the sand slides off.
  - `sill`'s cat hops up onto the sill.
  - `train` comes out of a tunnel.
  - `shanshui` unrolls its scroll.
  - `ferro` raises its spikes out of a flat pool.
- A sim that warms up over several frames runs its growth on a clock of its own that starts after
  the warm-up (physarum's `GrowthClock`), so a slow first frame doesn't use up the entrance. A sim
  run ahead gets `dt` 0, so a clock summed from `dt` holds; a clock keyed to `time` or wall time
  starts once `enter` is above 0. A sim that shows nothing until a build is done implements
  `ready()`.
- Put the readable part after ~0.5 s, which the blend half covers. The outgoing scene can still be
  exiting then: an entrance that rises out of empty sky or dark water reads best over another
  scene's exit.
- At rest (`passageIn() == 1`, `passageOut() == 0`) the scene must be exactly what it was: gate
  every change, and keep the sim's prewarm and random draws as they were.

Passages run in real time whatever the motion. The lab's Motion section switches them off
(`&transitions=off`), replays the current scene's exit and entrance with "now", and tunes the
overlap (`&overlap=0..1`), blend length (`&weave=` seconds), blend pattern (`&blend=bloom|fade|sweep|grain`)
and a slow motion for study (`&slowmo=2|4|8`). They are skipped at motion 0 and under reduced motion.

### Hard edges

Moving hard edges flicker under the dither when a soft edge steps each colour channel at its own
moment. Cut them per cell instead: `hardEdge(cover)` compares the coverage with the cell's own
threshold (`cellTh`), so a passing edge flips each cell once and the coverage still reads as the
share of cells covered; `hardFill(d, aa)` does the same for an SDF. A second edge layer over the
first takes its own `edgeThreshold(cell, offset)`, and light that fades in a hue of its own uses
`hardRamp`, snapped whole so no channel rounds off on its own. Keep `shimmer` off anything large:
the page re-rolls it several times a second.

### Knobs

Declare knobs with the builders in `src/params.ts` (`range`, `toggle`, `feature`, `choice`, `seed`,
`counts`). Each knob gets a define: `K_<key>` reads its value (a feature reads its amount while on
and 0 while off). Never index `uParams` by hand in new scenes. Keys are camelCase letters.

URL keys and values keep their meaning: links, presets and the lab's history carry them. A knob
that outgrows its key (a choice that becomes a range, say) or changes kind (a share of 0..100 that
became a feature would read 30 as its switch: on, at the default share) takes a step of the URL
schema that rewrites older links into the knobs that now say it (`MIGRATIONS` in `src/state.ts`; see
"Links and the URL schema" below). Rewrite the committed presets (`src/presets.ts`) in those knobs
as well (the share on its `-amount`), their `commit` moved to a build that has them.
`src/presets.test.ts` holds every committed preset to loading as itself: only its scene's keys and
the lab's, each value as its knob reads it, and the whole query as the lab writes it
(`canonicalSetup`), which is how the Presets view lights the preset just loaded.

`src/url-keys.json` lists every URL key the lab has published: its own settings, and each scene's
keys (its knobs, the `-amount` of each feature, its planets, and the outgrown keys its migrations
map). The list only grows: add a new knob's keys to it, and never take one out.
`src/url-keys.test.ts` fails while a key the lab reads is missing from it, and while a key in it
reaches nothing: no knob of its scene, nor its planets, nor a step of the migration chain
(`MIGRATIONS` in `src/state.ts`) that maps it onto one of them or drops it on purpose, so a renamed
or removed key needs its migration.

Shared knobs come from `src/scenes/atmosphere.ts`: `skyKnobs({ time })` gives `K_time`, `K_cycle`;
`weatherKnobs({...})` gives `K_rain`, `K_snow`, `K_fog`, `K_wind`, `K_lightning`, `K_aurora`
as requested. The rest are opt-in sky components (see "Composing components"), each given the value
the scene draws with as its default: `skyKnobs({ stars: 0.6 })` adds `K_stars` (density for
`skyStars`, 0 none .. 1 a dark-site sky), `skyKnobs({ milkyWay: { on: true } })` adds `K_milkyWay`
(the band's brightness for `milkyWay`, 1 as the component draws it, up to 2; 0 while switched off,
off unless `on`), `skyKnobs({ moon: 1 })` adds `K_moon` (the moon's phase for `skyMoonPhase`, 1 full,
0 while switched off: no moon), `skyKnobs({ meteors: { trigger: 1 } })` adds `K_meteors` (shooting
stars for `meteorAge`, off by default, "now" on that slot), `skyKnobs({ constellations: true })`
adds `K_constellations` (the figures' lines, 0.05 a trace .. 1 clear stick figures; 0 while switched
off: no figures; off at 0.4; `skyStars` draws them itself, so only a scene whose stars come from it
takes them), `weatherKnobs({ clouds: 0.3 })` adds
`K_clouds` (fair-weather cover 0..1, which rain and snow thicken) and `weatherKnobs({ shadows: true })`
adds `K_shadows` (how dark the cloud deck's shadows fall, for `skyCloudShadow`: 0.6 while on, off
unless `on: { shadows: true }`). A scene with a night of its own (an hour knob, a painted sky) takes
the components without the clock from `skyComponentKnobs({ stars, milkyWay, moon, meteors,
constellations, group })`. The night sky's planets are no knobs but a list of the scene's own
(`SceneDef.planets`, see "The sky's planets").
Use `atmosphereGroups.sky` / `.weather` for their lab headings, `.skyNight` for a sky group that
also holds components. A scene that composes the whole shared world takes all of these, with the
birds' below, from one call, `worldKnobs` (`src/scenes/world.ts`, see "World layers").

Birds come with their library: `birdKnobs({ kind: "gulls", help })` from `src/shaders/lib/birds.ts`
adds `K_birds` (how often a flight passes, off by default), `K_birdKind` (the species, the GLSL
`BIRD_*` kind; -1 "mixed" where the scene offers its own mix) and `K_birdFormation` (the formation
plus one, 0 the species' own), with `birdsGroup` as their heading (see "Birds" below). The plant
component's knobs come from `plantKnobs` (`src/scenes/plants.ts`, see "Rooted plants") and the giant
planet's from `planetKnobs` (`src/scenes/planet.ts`, see "The giant planet").

A knob with `trigger: n` gets a "now" button (a lightning bolt, whatever the knob's kind) that stamps
`uTriggers[n]` with the scene clock; read it with `sinceTrigger(n)` (huge while idle) in GLSL and
`frame.fired[n]` in a sim. Use slots 0..7, each for one knob only: the button stamps the slot, so
two knobs on one slot fire together (`triggers.test.ts` checks every scene). Lightning takes the
slot you give `weatherKnobs`. The lab's tools list every "now" of the scene as well.

### Links and the URL schema

A setup is a URL query: the lab's settings, the scene's knobs and its lists, each only where it
differs from its default, `scene` first. Links, presets, the lab's history and each slot of an A/B
comparison (under its `a.` or `b.` prefix) are that one form, and all of them enter through
`readSetup` (`src/state.ts`), which brings an older query up to this build's schema, then reads it.

**Versions.** A query's keys belong to a schema, numbered from 1, and `v=<n>` names it only where
the query needs it: the lab writes `v` when a reader taking the query for schema 1, as it takes
every link without `v`, would read it otherwise (`withVersion`). Every link from before versions is
schema 1. Schema 2 only rewrote keys that no build writes any more, so no link needs `v` yet. When
a range becomes a feature, say, the step that turns an old `<key>=30` into `<key>=1&<key>-amount=30`
would misread a new `<key>=1`, so every link that sets that knob from then on carries `v`, and only
those. Writing `v` always would lengthen every link and, at each new version, unlight every
committed preset until it was rewritten. A link of a later schema than the build knows (a newer
build's, opened on an older one) is read as it stands.

**Migrations.** `MIGRATIONS` is the schema's history, in order. Each step makes the version
`since`; a query of an earlier version runs every step past its own, in order, so a schema 1 link
runs them all and each step rewrites the query as the steps before it left it. Two kinds:

- `keys`: outgrown keys of the scene the query names at that point (`renameKey` renames one with a
  map of its values). Schema 2 holds two: the countryside's `season` (0 summer, 1 harvest, 2
  autumn) opens at its `date` (0.375, 0.47, 0.6), and the night skies' one giant planet becomes the
  first of their planets.
- `alias`: a retired scene id (renamed, merged into another scene or removed) whose links open its
  successor, `to`, which a later alias may retire in turn. Its `keys` move the retired scene's keys
  onto the successor's: rename them, and set the successor's knobs whose defaults differ from what
  the retired scene showed, since a link leaves defaults out.

To change what a key means, append a step of the next version (`since: URL_VERSION + 1`) that
rewrites older queries into the new keys; to retire a scene, append an alias of the next version
and take the scene out of the registry. Never edit, move or drop a step that has shipped: links rely
on it. A step that calls live code (`COUNTRY_SEASONS`, `encodePlanets`, a scene's `planets`) must
keep writing its own version's keys, so freeze what it uses before that code changes meaning, and
retiring a scene that an earlier step reads (a sky that takes planets) means handing that step the
part it read. The chain reads a query that names no scene as today's default scene's: changing the
default scene needs each version's default kept first. `checkMigrations` runs at load: steps in
version order, and each alias retires, once, an id no scene has, for a successor that leads to one.

A setup naming a scene this build lacks, once its aliases have run, opens the default scene with
its lab settings, and the lab says so in one line over the scene until another scene is on screen.
A tour names scenes only, so it needs no version of its own: each step resolves through the
aliases (`resolveScene`) whatever the link's version, since a retired id never names a scene
again, and a step naming no scene is dropped.

**Lists.** A list of items, each a set of knob-like values (the night sky's planets,
`src/scenes/planets.ts`), lives beside the knobs as one key per list (`planets=`): packed
(`encodePlanets`, base64url varints), last in the query and absent while the list is empty. Its
value has its own format version, its first varint, apart from the URL schema's. The schema says
which key holds the list and what it replaced (the giant's keys, a schema 2 step); the packing says
how the value's bytes read, and grows by appending field ids, which needs no new version of either.
A packing that reorders or reinterprets fields takes a new packing version, whose decoder reads the
old one too, or a schema step that re-encodes old values. As one key a list goes wherever keys go:
minimal links, undo steps, presets, the `a.`/`b.` prefix and `setupDifferences` (the list is one
difference). The lab edits the list decoded (`readPlanets`) and writes it back whole
(`encodePlanets`), and the shader takes it as uniforms beside `uParams` (`planetUniforms`), so items
cost no knob slots. A new list follows the same pattern under a key of its own that no knob of its
scenes may take (`state.ts` checks `planets`).

### Lab widgets

The lab (`src/lab.ts`, `src/lab/`) is one menu over the scene in two presentations, a lab
preference (`presentation` in `src/lab/prefs.ts`): expanded, a floating inspector panel, and
compact, a bar along the bottom edge. The inspector has three views, picked by the icons in its
header: Scenes (every scene's thumbnail, shelved by family), Presets (saved setups) and Controls (the
scene's groups, then Look, Motion and Page); a rail beside each view jumps between its families,
preset groups or control groups. The scene's name in the header opens the Scenes view, and the
header's last icons minimise the lab to the bar and hide it.

The compact bar (`src/lab/menu.ts`, rules in `menu-model.ts`) is the same menu laid flat: the scene's
chip (its dot and name) opens the Scenes view, a Presets chip the presets, then one chip per
Controls section in the Controls order (the World shelf, the scene's groups, Global), its icon and
title as the rail and the headings pick them. A chip is lit while its section differs from its
defaults, as the lens counts it, and a section with a master switch shows it on or off. A chip
opens a popover (`src/lab/popover.ts`) holding the panel's own element, lent while it is open
(`Inspector.lend`, `borrow` in `src/lab/dom.ts`), never a copy: one set of controls, one set of
syncs. A section shows open and whole there, under its own heading with its recipes and dice (the
search and the lens wait while the lab is compact), in a popover as wide as the inspector, at most
most of the screen tall and scrolling; on a narrow screen a popover is a sheet the full width of the
screen, standing on the bar. While the chips do not all fit with their titles they go icon-only
together, the title their tooltip and name, and then the strip scrolls (a wheel over it too): every
section stays one press away, in one order, where a "more" chip would hide the rest behind a
popover of popovers. The fit is measured, never decided by scene. The chips are one tab stop (the
arrow keys, Home and End move along them); Escape closes a popover and hands the keyboard back to
its chip, and a popover's controls are in the tab order only while it is open. The bar docks top or
bottom or floats like any panel, and "expand" takes the lab back to the panel.

Both presentations carry one row of tools, in the panel's foot or on the bar: play or pause, undo,
redo and shuffle; A and B while a comparison runs; the tour's place while it plays; and "⋯", a
popover with the motion, the transitions and their replay, every "now" of the scene, the A/B
comparison, the tour, reset, the link, the explanations, the shortcuts and the build's status. `l`
hides the whole lab, and `/` opens the panel at the control search.

Controls lay a group out from its knobs' metadata, never from scene ids: a switch (toggle or
feature) is an icon chip (a feature's amount on its chip, or under the chips while it is on when it
is a choice), and ranges, choices and seeds are rows. A knob names a purpose-built widget with
`widget` (`Widget` in `src/params.ts`); widgets only change how the lab draws the knob, never its
URL keys, values, reset, shuffle or presets:

- `{ kind: "mix", mix, part, swatch }` on range or feature knobs of one group: one stacked bar of
  relative weights named `mix`, each knob a segment while it is in (country's land use). A range is
  in while above zero; a feature is in while on, its amount the weight (the shader reads 0 while
  off), and gets an on/off chip over the bar that keeps its amount while off. Make a part that may be
  left out a feature with `min: 0`, `max: 100`, `step: 1`; a drag or key that takes it to zero
  switches it off.
- `{ kind: "sky", part }`: the almanac. `skyKnobs` sets it on `time` and `cycle`; the sky dial
  stands where a group holds a `time` part, with the scene's night `moon` opposite the sun in its
  phase and its `stars` as dots in the night half, wherever those parts stand. Under it "Day speed"
  is the day cycle as one slider: still at the left end (`cycle` off), faster to the right (`cycle`
  on, `cycle-amount` the pace), reading "a day in 4 min" at the fastest (`src/lab/speed-model.ts`).
  A `season` part (with its `year`, see `SeasonYear`) and the year's cycle (`year`, a feature) join
  the dial from any group as a season ring round it: spring on the right, summer at the top, autumn
  on the left, winter below. A span's stretch is lit and the rest dim; a choice's seasons are
  segments a drag snaps to, its options that are no time of year chips beside it; a feature's
  switch is a chip, and dragging the marker switches it on. Arrow keys on the ring step the season.
  The year's cycle is "Year speed", as the day's ("a season in 2 min": its amount is minutes per
  season, so its faster stops hold fewer). Without a `time` part the season parts make a season
  wheel of their own in their group.
- `{ kind: "direction" }` on a range from below 0 to above 0: a vector pad, min to the left
  (`weatherKnobs`' wind, kelp's and delta's currents). `{ kind: "gusts" }` on a feature in the same
  group (`plantKnobs`' gusts, meadow's) makes it the wind card: a gust lane under the arrow holds the
  gusts' switch, strength and "now" (which surges the arrow), and while they are on the arrow puffs.
- `{ kind: "compass", strength }` on a heading (a turn 0..1 counter-clockwise from the right): a
  vector pad whose length is knob `strength`, a range or a feature's amount (pond's current).
- `{ kind: "position", y, screen? }` on the across range of a point whose height is range `y`: one
  XY pad; `screen` gives the values where the frame's edges lie when the point may leave it.
- `{ kind: "flyway", part }`: the birds card. `birdKnobs` sets it on `birds` (the switch and how
  often), `birdKind` (`kind`) and `birdFormation` (`formation`); the card stands where a group holds
  the `birds` part and takes that group's other parts. A sky strip draws more birds aloft the more
  often flights pass (drag or arrow keys; Delete grounds them), the species are tiles of their
  silhouettes and the formations dot diagrams of the chosen species' own party, each row a radio
  group. A group whose master is `birds` keeps the switch in its header.
- Fader chips and scrub readouts, with no `widget`: a feature whose amount is a range carries it on
  its chip (`src/lab/chips.ts`, rules in `chips-model.ts`), a fill while on and the value on hover,
  focus and drag. A click toggles it, a drag across sets the amount and switches it on, arrow keys
  step it (Shift a tenth of the range); double-clicking the value resets the amount. A row's readout
  over a slider scrubs it (drag across, Shift finer); double-clicking a readout or label resets it.
  On a touch screen these and the one-way pads (a direction, the birds' strip, a mix's dividers)
  wait for a drag across, so a swipe down scrolls the panel.
- `{ kind: "night", part }`: the Night sky section. `skyComponentKnobs` sets it on `stars` (a
  range), `moon`, `milkyWay`, `constellations` and `meteors`, `weatherKnobs` on `aurora`
  (features); every one a group holds gathers into one section at the first, headed "Night sky"
  (`src/lab/nightsky.ts`, rules in `nightsky-model.ts`), with the scene's planets where
  `SceneDef.planets` names the group (`src/lab/planets.ts`, rules in `planets-model.ts`). A drawn
  night shows each part the scene has in its state, dim and dashed while off (a click on a drawn
  part switches it), and each planet where it stands, as big as its size, in its palette's tint
  with its ring and moons, an orbiting one over its dashed path (a click on one picks it). With an
  aurora the drawing is three layers, the curtains alone in the middle one so their sway repaints
  that layer only, and a click reaches whatever part or planet is under it. Under it
  one control per part: the moon's phases as drawn moons with "off" (a radio group), and a fader
  chip for each other part, the stars' without a switch, the shooting stars' with their "now".
  Then the planets: a chip for each (a click picks it, its × removes it) and "+ planet" (up to the
  cap), and under them the picked planet's own controls, laid out from its knobs (`planetDefs`) as
  a group's are: its kind, size and palette, its placement pad, its switches as chips (orbits, real
  phases, day cycle, moons, shadows, aurora, city lights), the rest as rows. Each part's control
  answers the search and the lens on its own; the planets answer them as one (their URL key). While
  the scene's `time` part stands in daylight, or the day cycle runs, "See it at night" sets the
  clock to late evening and stops the day, as one undoable change.

A group's heading may carry `recipes` (`Recipe` in `src/params.ts`): one-tap setups drawn as a strip
of glyph chips at the top of the group, the one the setup already is lit. A recipe sets URL keys of
any group in one undoable change; a scene shows it only where it has every key in `needs` and one
key it sets, and takes only the keys it has, each as its knob holds it (rules in
`src/lab/recipes-model.ts`). The shared sky and weather headings carry the sky's (Dawn .. Aurora
night) and the weather's (Clear .. Fog): give a scene's own blurb as `{ ...atmosphereGroups.weather,
blurb }` so they come along. Each group's heading also has a dice that shuffles that group alone, by
the tools' shuffle rule (`src/lab/roll-model.ts`).

Where the season sets the climate (`hasClimate`, see "The climate" under "Weather in the world"),
the lab shows what the time of year makes of the weather, with marks that change no value (rules in
`src/lab/climate-hint-model.ts`). They read the season knob's own time of year (`yearAt`), not
the passing year's, so they hold still while the year cycle runs. A readout over the top edge of the
weather's rain and snow chips says "out of season" for snow switched on while it is warm
(`climateCold` below `SNOW_SHARE[0]`: it falls anyway), "sleet" for rain while some of it comes
down as snow and "falls as snow" once all of it does (from `SNOW_SHARE[1]`), and, on the snow's
chip, "snow lies" in deep winter (`climateLying` above 0). A weather recipe whose rain or snow the
season changes gets a ring in its corner and its mark beside its name. Round the almanac, a dashed
line of frost inside the season ring marks the deep winter where snow lies with none falling.

Icons come from `src/lab/icons.ts`, one line set: a knob's `icon` (or a group's `Blurb.icon`) picks
one, otherwise the first word of its key or label that names one does.

Controls put the shared world first: a group whose heading has `shelf: "world"` (the shared
headings `atmosphereGroups`, `worldGroups` and `birdsGroup` have it; spread one, `{ ...heading,
blurb }`, to word it for the scene, or set it on a world group of the scene's own, as meadow's wind)
stands on a World shelf, sky, weather, wind and birds first, above the scene's own groups and the
Global ones; the rail shows the same three. The World divider's "keep" switch (a lab preference, off
by default) has a scene picked by hand (the Scenes view, `[` `]`, "Next scene") open under the world
of the one left: each World knob takes the value of the World knob with its key and kind, kept in
its range (a choice only where offered), and the season goes over through the year (`carryWorld` in
`src/lab/world-model.ts`); presets, tours and links keep their own. So the sky's knobs, the aurora
among them (`weatherKnobs` puts it in "sky", or `auroraGroup`), belong in the sky's group, and a
scene's subject (lake's aurora) in a group of its own.

- The lens beside the Controls search ("n changed") narrows every group to the controls that differ
  from their defaults (Global settings against the scene's own), with the search's words if any;
  the rail dots each group with changes and "Reset what changed" restores them all in one undoable
  change (rules in `src/lab/lens-model.ts`). A control holds the knobs its element, or the widget
  round it, lists in `data-keys`: the inspector's `place` tags a widget with its knob's keys, so tag
  one that holds several knobs with all of theirs.
- A knob with `when` hangs on that switch and on whatever the switch hangs on, to any depth: it
  takes effect, and its control shows, while every one of them is on (`switchChain` in
  `src/lab/availability-model.ts`; a `when` names a toggle or feature of the same scene, without a
  loop, as `availability-model.test.ts` checks for every scene). Its control is a gate (`gate` in
  `src/lab/dom.ts`), and after every sync the Controls view alone decides what shows. A change
  behind a switch that is off still counts under the lens: the lens and the search show it dormant
  (dimmed, still in reach) beside the switches it waits on, never folded away. Folded groups and
  closed controls leave the tab order.

The Scenes view's thumbnails are committed files, `concepts/landing/thumbs/<id>.webp`: each scene
at its defaults, settled, dithered at 240 x 150 as the page draws it. After changing how a scene
looks at rest (or adding one), run `bun concepts/landing/scripts/thumbs.ts <id>` and commit the
file; a scene without one shows a stand-in in its accent.

### Page theme

The copy sits on the scene, so a light scene needs the paper theme (dark copy). Decide it once, in
`theme`, from the knobs: `skyTheme(params, { from, to, rainBelow, when })` is paper on a still
daylight clock (day cycle off, `from < K_time < to`, default 0.33..0.67, rain below `rainBelow`,
and `when(values)`); `paletteTheme(params, key, (index, values) => ...)` is paper for some options
of a choice or toggle (a palette, a backdrop). Both throw a KnobError as the scene loads if a knob
they read is missing (or the palette knob is another kind). The shader never repeats the test:
`pagePaper()` reads the page background, and `inkOf` follows it.

### Shared libraries (`src/shaders/lib/`)

Compiled into every program after `common` and the scene's features (`libs`,
`src/shaders/lib/index.ts`): `sky.ts`, `clouds.ts`, `weather.ts`, `surface.ts`, `water.ts` (with
`src/shaders/windWater.ts` and `src/shaders/caustics.ts` as two of its tiers), `lightning.ts`,
`aurora.ts`, `meteors.ts` and `canopy.ts`, listed below with the opt-in Milky Way. The other opt-in
components (`birds.ts`, `plants.ts`, `planet.ts`, `figures.ts`, `livestock.ts` and
`src/shaders/buildings.ts`) have sections of their own under "Composing components". Coordinates:
`viewRay` gives x right, y up, z into the scene.

```glsl
float timeOfDayM(float time, float cycle, float motionTime); // K_time, K_cycle, uMotionTime -> 0..1 (0 midnight, .25 sunrise, .5 noon, .75 sunset)
struct Sky { vec3 sun; vec3 moon; float day; float twilight; float night; vec3 sunColor; vec3 ambient; vec3 moonColor; float starTurn; }; // + float moonPhase with SKY_MOON_PHASE
Sky skyAt(float tod);                                     // the world clock's sky: sun rises on the right, crosses high, sets on the left; the staged full moon; dated by SKY_YEAR in a dated sky; stars turned by the day cycle
Sky skyAtWorld(float tod, float shift, float turn);       // the same with the date's sun shift (worldDateShift) and the stars' turn (worldStarTurn) given
vec3 viewRay(vec2 uv, float aspect, float horizon, float fov); // side-on camera, horizon at screen height `horizon`
vec3 skyColor(Sky sky, vec3 dir);                         // gradient, sunset glow, sun and moon discs (no stars)
vec3 skyDome(Sky sky, vec3 dir);                          // skyColor without the sun's and moon's discs (aureole and halo kept): what haze and fog take on
vec3 skyStarFrame(Sky sky, vec3 dir);                     // a sky direction in the stars' frame (turned back about the pole by sky.starTurn): look a Milky Way up at it
float skyStars(Sky sky, vec3 dir, float density);         // stars faded by daylight, stable in the stars' frame
float skyStars(Sky sky, vec3 dir, float density, float foot); // the same with a level of detail: foot = radians a dither cell spans
float skyStarFade(Sky sky, vec3 dir);                     // where stars show at all: night, height, away from the moon's disc and glare
vec3 skyStarLight(Sky sky, vec3 dir, float density);      // skyStars tinted SKY_STAR_TINT (cool white), to add to the sky
vec3 skyFacing(vec3 dir, float yaw);                      // turn a direction about +y (+x toward +z): a camera looking off-axis
Sky skyFacing(Sky sky, float yaw);                        // the sun and moon turned with it
Sky skyMirror(Sky sky);                                   // moon swung behind the viewer, for reflections
vec3 horizonHaze(Sky sky, vec3 dir, float lift);          // the dome without discs just above the horizon in dir's heading (lift 0..0.04)
float skyMoonCover(Sky sky, vec3 dir);                    // 0..1 the moon's disc (unlit part too) over dir: hide what lies behind it
vec2 skyAngles(vec3 dir);                                 // (bearing from straight ahead, elevation) in radians: a flat frame on the dome
// With SKY_MOON_PHASE (SceneDef.features):
Sky skyMoonPhase(Sky sky, float phase);                   // K_moon: 1 full (unchanged) .. 0 no moon; a partial moon stands acos(1 - 2 phase) from the sun, moving onto the full moon above 0.9; disc, halo, moonColor, ambient follow
float skyMoonPhaseLight(float phase);                     // the moon's light at a phase relative to full (0.32 half, 0.11 a quarter)
// With the scene's K_constellations (skyComponentKnobs({ constellations })), both skyStars overloads
// also draw, over the field and only while the knob is on (never at density 0), in a program that
// compiles them in (the library gate SKY_FIGURES, see "Knob-keyed features"): six figures fixed on
// the dome 13-42 degrees up, from 37 degrees left to 50 right of ahead (clear of the full moon at
// midnight); their stars brighter than the field's, the stick lines at K_constellations (0.05 a
// trace .. 1 clear); faded as the stars (skyStarFade); sized in dither cells (foot; 1 / uRes.y
// radians without it), so they show at any cell size.
// With the scene's planets (SceneDef.planets, the library gate SKY_PLANETS while its list holds
// any; without it the sky as it was):
vec3 skyGiant(Sky sky, vec3 col, vec3 dir, float foot, float clear); // the sky's planets over col (the sky up to its stars); see "The sky's planets"

// Clouds in tiers (clouds.ts), each only in a scene whose SceneDef.features CLOUD_TIER reaches it, the
// lit deck where it selects none (see "Clouds"):
// CLOUD_FLAT, in every program
vec2 cloudDeckPoint(vec3 dir, vec2 travel, float tm, float wind); // where dir meets the deck (cloud-base heights), drifted on tm; travel: the eye's own way under it
float cloudFlatField(vec2 p, float fine);                 // the calm deck: two broad octaves 0..1, the finer kept by fine
float cloudFlatFine(vec3 dir);                            // how much of the finer octave a view along dir keeps (none toward the horizon)
// CLOUD_LIT (and without CLOUD_TIER)
vec4 skyClouds(Sky sky, vec3 dir, float tm, float cover, float wind); // the lit deck seen from below: rgb, alpha
float skyCloudField(vec2 p, float foot, float tm);        // its density at a deck point, octaves faded to their mean below ~3 cells
// CLOUD_SHADOWS
float skyCloudShadow(Sky sky, vec3 ground, float base, float tm, float cover, float wind); // 0..1 its shadow at ground (eye-relative), the deck base above the eye
float skyCloudShadow(Sky sky, vec3 ground, float base, float low, float tm, float cover, float wind); // the same under a deck rain brought down to base / low
// CLOUD_VOLUME: a sea of tops below the eye (drift, cover, boil: the tops' slow change, drop: the highest domes' depth, amp: their height range)
struct CloudSea { vec2 drift; float cover; float boil; float drop; float amp; };
float cloudSeaMarch(vec3 rd, CloudSea sea, float tFar);   // distance to the tops along rd, -1 past tFar
vec4 cloudSeaTop(vec3 at, vec3 rd, CloudSea sea, float foot); // xyz the normal, w the height 0..1 at the hit; foot: a cell there (deck units)
float cloudSeaShadow(vec3 at, vec3 L, CloudSea sea);      // 1 in the open .. toward 0 under a dome: Beer-Lambert to the light
float cloudSeaMacro(vec2 w, float cover, float boil);     // the large forms 0..1; cloudSeaSurface(w, cover, boil, detail) adds the relief
float cloudPhase(float cosAngle, float g);                // Henyey-Greenstein, relative to isotropic
float cloudBillow(vec2 p);                                // folded value noise |2n - 1|: domes with creases

float weatherOvercast(float rain, float snow);            // cloud cover under rain/snow: .64 drizzle, .76 steady, .88 heavy, 1 downpour
vec3 greyed(vec3 c, vec3 tint, float amount);             // toward c's luminance times tint (vec3(1.0) plain grey): overcast, moonlight
float rainShafts(vec2 p, float tm, float amount, float wind); // 0..1 toward cloud-base grey; p = (along the horizon, up) in cloud-base heights

// Rain or snow through the air between the eye and the first opaque surface. depth: distance to that
// surface, 0 at the eye .. 1 far horizon or open sky, as 1.0 - exp(-z / 30.0) with z in metres.
// cover: drops/flakes (all layers, binarised per cell); veil: unresolved distant rain/snow (mix toward
// the air colour); near: share of cover from the nearest, out-of-focus layer.
struct Precip { float cover; float veil; float near; };
Precip rainFall(vec2 uv, float aspect, float tm, float tf, float amount, float wind, float depth); // level camera: paths straight down the frame; gusts on tm, drops on tf
// A camera pitched up or down: the drops' paths meet at the vanishing point of their fall direction.
// right/up/fwd: camera axes in the world; focal in screen heights (ray = fwd*focal + right*x + up*y,
// x, y about the frame's centre). Shift vanish.y by -lens * vanish.z for a lens-shifted frame.
vec3 rainFallDir(float amount, float wind);               // the drops' world direction (terminal speed 4..9 m/s, wind drift)
vec3 rainVanish(vec3 dir, vec3 right, vec3 up, vec3 fwd, float focal);
Precip rainFallSeen(vec2 uv, float aspect, float tm, float tf, float amount, float wind, float depth, vec3 vanish);
Precip snowFall(vec2 uv, float aspect, float tm, float amount, float wind, float depth);
vec3 snowFallDir(float amount, float wind);               // the flakes' world direction, for rainVanish
Precip snowFallSeen(vec2 uv, float aspect, float tm, float amount, float wind, float depth, vec3 vanish); // tilted camera: flakes stream out of (or into) the vanishing point; vanish.z = 0 is snowFall
vec3 precipOver(vec3 col, vec3 air, vec3 dropLight, Precip p); // the veil toward air, then the drops toward dropLight (see below)

// Surfaces (p in the scene's own ground units, roughly metres; scale freely):
float rainSplashes(vec2 p, float tf, float amount);       // 0 or the light of brief splash crowns on hard upward-facing ground
vec3 rainRipples(vec2 p, float tf, float amount);         // rings on water or puddles: xy normal tilt, z ring light (p in ring cells)
float rainPuddles(vec2 p, float wet);                     // 0..1 where water pools on flat ground as wet (uWeather.x) rises
vec3 wetten(vec3 albedo, float wet, float porous);        // wet albedo: darker, richer; porous 0 stone/metal/glass .. 1 soil/wood/cloth
float wetGloss(float wet, float up);                      // 0..1 extra specular/reflection; up = normal.y (flat ground pools and mirrors)
float rainDrips(vec2 p, float tf, float amount, float width); // drops gathering and falling from an edge: p.x along it, p.y down; width = drip spacing
float snowCover(vec3 n, vec2 p, float lying);             // 0..1 snow on a surface with normal n (y up), lying = uWeather.y
vec3 glassDrops(vec2 uv, float aspect, float tm, float amount); // rain on a pane: xy refraction offset, z drop coverage
float fogAmount(float fog, float distance, float height); // 0..1 of fog colour to mix in (distance 0 near..1 far)

// Level ground or water under the side-on camera (surface.ts). p: (x right, depth z) in eye's units;
// foot: the patch one dither cell covers there (across, along the depth), for antialiasing and LOD.
struct Ground { vec2 p; vec2 foot; };
Ground groundHit(vec3 dir, float eye, float focal);       // a viewRay dir below the horizon; focal = 0.5 / tan(fov / 2)
Ground planeAt(vec2 uv, float aspect, float horizon, float eye, float focal); // the same from screen uv (uv.y < horizon)
float fresnelSchlick(float cosI, float f0, float minCos); // water f0 0.02; minCos floors cosI on a rough surface (0 smooth)
vec3 rippleTrain(vec2 p, float tm, vec2 foot, float wavelength, vec2 along, float slope, float pace, float phase, vec2 lod);
                                                          // one wind-ripple train, LEAN-filtered: xy slope, z slope variance too fine to draw
// A spectrum: up to RIPPLE_TRAINS (5) trains summed, each train's slope times gain (the wind, a knob): xy slope, z variance.
// A fan by a law: train i wavelength.x * wavelength.y^i long, slope slope.x - slope.y * i, pace pace.x * (1 - pace.y * i),
// phase phase * i, heading turn.x + turn.y * i + sway.x * sin(sway.y * i + sway.z) rad from +z (ahead) toward +x (right).
struct RippleFan { int count; vec2 wavelength; vec2 slope; vec2 pace; vec2 turn; vec3 sway; float phase; vec2 lod; };
// A table of hand-placed trains (island): each (wavelength m, steepest slope, pace, phase) and its unit heading.
struct RippleTable { int count; vec4 train[RIPPLE_TRAINS]; vec2 along[RIPPLE_TRAINS]; vec2 lod; };
vec3 rippleSpectrum(vec2 p, float tm, vec2 foot, float gain, RippleFan f);
vec3 rippleSpectrum(vec2 p, float tm, vec2 foot, float gain, RippleTable t);

// Water in tiers (water.ts), each only in a scene whose SceneDef.features WATER_TIER reaches it (see "Water"):
// WATER_RIPPLES (windWater.ts): the breeze on open water under the side-on camera, mirrored in screen space.
vec4 windRipples(Ground g, float tm, float wind, float amount); // cat's-paws' ripples: xy slope, z unresolved variance, w paw cover
vec2 windMirror(vec4 ripples, float below, float focal);  // how far a screen-space mirror lookup moves (screen heights)
float windMirrorSpread(vec4 ripples, float focal);        // the vertical smear (one sd) the unresolved ripples add to it
// WATER_MIRROR
struct WaterMirror { vec3 normal; vec3 ray; float fresnel; };
WaterMirror waterMirror(vec3 dir, vec2 slope, float minCos); // a view ray on rippled water: normal, reflected ray, Fresnel (f0 0.02)
float waterGlitter(vec3 n, vec3 view, vec3 light, float s2); // the sun's or moon's glitter 0..1: Beckmann lobe, variance s2, 1 at its heart
// WATER_FLOW
vec2 waterDrift(vec2 p, vec2 current, float tm);          // where to evaluate a pattern a steady current (velocity) has carried to p
vec4 waterFlow(vec2 p, vec2 current, float tm, float period, out float weight); // a current that varies: mix(at xy, at zw, weight)
// WATER_CAUSTICS (caustics.ts)
vec2 causticRipples(vec2 p, float tm, vec2 wind, float scale, float steep, float pace, float foot, out vec3 hessian); // five trains with curvature
float causticJacobian(vec3 hessian, float d);             // det(I + d H): d = 0.25 x depth for water
float waterCaustic(vec3 hessian, float depth, float focus, float soft); // light on the bed vs still water, times a sim's focus
float causticCells(vec2 x, float t, float foot);           // the stylised cellular net 0..1 (seams where the cells meet), x in net cells

float lightningAge(float tm, float rate, int slot, out float seed); // real seconds since the latest strike (random at `rate` on tm, or the trigger)
float lightningBolt(vec2 p, vec2 top, vec2 ground, float seed, float age); // forked bolt glow at p (aspect-corrected units)
float lightningFlash(float age);                               // sky-wide flash 0..1

// Aurora (AURORA_CURTAINS feature: curtains, default 3). tm: uMotionTime; foot: radians a dither cell spans.
vec3 auroraM(vec3 dir, float tm, float strength, float foot);   // curtains of light for a view ray, to add to the night sky
vec3 auroraGlow(float tm, float strength);                       // its light on the land, to add to ambient (times auroraSeen)
float auroraSeen(Sky sky, float cloud);                          // night and open sky: multiply the curtains and their glow by it
vec3 auroraCurtains(vec3 dir, float tm, float strength, float keep); // keep 1: full detail, for scenes with their own motion clock (lake's surge) or detail

// Shooting stars: when, and the streak in the scene's own flat sky frame (skyAngles for a dome).
float meteorAge(float tm, float rate, int slot, out float seed); // seconds since the latest one (random at `rate` while motion > 0, or slot's "now")
float meteorStreak(vec2 q, vec4 field, float age, float seed, float foot); // 0..1 coverage; starts in field (xy corner, zw size)
const vec3 METEOR_TINT;                                          // the streak's cool white, times hardEdge(coverage)

// Weather under a closed canopy (canopy.ts; bamboo, forest). The scene keeps its tint, fill, shelter and mist.
struct CanopyWeather { Sky sky; float rain; float overcast; float cloud; vec2 keySide; float slant; };
CanopyWeather canopyWeather(Sky clear, float rain);       // the sky under the rain's cloud (sun and moon gone from rain 0.25, ambient
                                                          // toward the deck's grey), overcast 0..1, the deck's luminance, the key
                                                          // light's level heading (x, z) and its shafts' slant from straight down
vec3 canopyRaySources(vec3 base, float spread, float seed, float aspect, float tm, float slant); // screen x of three shafts at the top
float canopyGap(vec2 p, float wind, float seed, vec3 raySrc); // 0 under the leaves .. 1 open overhead (always under a shaft), leaning with the wind
vec3 canopyGapSky(CanopyWeather w, vec3 washed, vec3 dir, float stars, vec2 p, float wind, float seed, float deck);
                                                          // the sky in a gap: the scene's washed sky, stars while clear, the rain deck (gain deck) with shafts

// The grove under it (canopy.ts, opt-in: put canopyGroveGlsl in the scene's GLSL), shaped by the scene's constants.
vec2 canopyRays(vec2 p, float tm, vec3 raySrc, float slant, float seed, vec2 width); // three shafts: x how much p lies in one, y their glow;
                                                          // width.x at the gap, widening by width.y (+ up to 0.04) per unit fallen
struct CanopyCrowns { vec3 edge; vec2 grain; vec2 fine; vec3 rise; vec3 gaps; vec4 opening; }; // a canopy's shape (see canopy.ts)
vec3 canopyCrowns(vec2 q, vec2 p, CanopyCrowns c, float seed, bool shafts, vec3 raySrc, vec2 keySide);
                                                          // the canopy overhead: x cover, y the leaves' noise, z the key light from behind
struct CanopyDrips { float horizon; float eye; float width; float share; vec2 tip; }; // the view and the dripping tips' columns
float canopyDrip(vec2 q, float tm, float amount, float z, float salt, CanopyDrips drips); // drops off the canopy at depth z: coverage

// The Milky Way (milkyway.ts, opt-in: put milkyWayGlsl in the scene's GLSL, see "Opt-in components").
struct MilkyWayBand { vec3 pole; vec3 across; };          // where a band runs; declare it once: const MilkyWayBand X = MILKY_WAY_BAND(pole);
float milkyWay(vec3 dir, MilkyWayBand band);              // its brightness 0..~1.3 for a view ray: 0 below the horizon and off the plane
float milkyWayStars(float density, float band);           // the star density to hand skyStars there: 0.7x off the band .. ~1.7x in it
```

Name scene-local GLSL functions with the scene id as a prefix (`dunesHeight`, `sillCat`) so they can
never collide with common or library functions.

### Composing components

A component is shared simulation that a scene composes into its own picture. The shared code
decides what happens and where: which star sits in which direction, how the aurora's curtains
ripple on the motion clock, which side of a crescent is lit, when a shooting star flies and along
which path. The scene decides how it looks there: its tint, what stands in front of it, how much of
its light reaches the scene's own materials, and what the passage does. A component has three
parts, all inside the existing scene contract (no registry, render pass or engine of its own):

1. **Controls.** A knob builder with shared keys, labels and help, so they ride the URL, reset,
   shuffle and presets like any knob: `skyKnobs`, `skyComponentKnobs` and `weatherKnobs`
   (`src/scenes/atmosphere.ts`, see "Knobs"), `birdKnobs` (`src/shaders/lib/birds.ts`),
   `plantKnobs` (`src/scenes/plants.ts`) and `planetKnobs` (`src/scenes/planet.ts`). Optional
   components are opt-in and start at the value the scene already draws with, or off, so adopting
   one never changes the default picture. Give a scene a knob only if its shader reads it.
2. **Code.** GLSL that reaches the scene's program from `libs`, compiled into every program, or as
   an opt-in string the scene includes itself; compile-time features, fixed (`SceneDef.features`)
   or keyed by the knobs (`SceneDef.featuresFor`), select how much of it is compiled. The three
   rules follow: "Opt-in components", "Capabilities and tiers", "Knob-keyed features".
3. **Outputs.** GLSL functions that return explicit values:
   - _coverage_ 0..1: multiply it by the scene's own occlusion, then cut moving edges with `hardEdge`;
   - _radiance_: light added to the sky before the scene draws what stands in front of it;
   - _light on materials_: added into the scene's own lighting;
   - _visibility_: what hides the component (night, cloud).

   They read only the common uniforms (clocks, triggers). Everything that belongs to the scene is a
   parameter: directions, footprints, fields and trigger slots.

**Opt-in components.** `libs` (`src/shaders/lib/index.ts`) is compiled into every scene's program,
so it holds only what most scenes use: the sky, clouds, weather, surfaces, water, lightning,
aurora, meteors and the canopy weather (see "Shared libraries"). A component few scenes compose is
a GLSL string of its own that each consumer interpolates into its `glsl`, at the top or at least
before the functions that call it, so no other program pays for it:

| String            | File                           | Composed by                                                                | See                                  |
| ----------------- | ------------------------------ | -------------------------------------------------------------------------- | ------------------------------------ |
| `worldGlsl`       | `src/shaders/lib/world.ts`     | meadow, shore, dunes, bees (it composes `birdsGlsl` and `milkyWayGlsl`)    | "World layers"                       |
| `birdsGlsl`       | `src/shaders/lib/birds.ts`     | aurora, country, falls, lake, lanterns, skyward, swell, train; the world's | "Birds"                              |
| `milkyWayGlsl`    | `src/shaders/lib/milkyway.ts`  | campfire, lake; the world's                                                | the Milky Way row below              |
| `canopyGroveGlsl` | `src/shaders/lib/canopy.ts`    | bamboo, forest                                                             | "Shared libraries" (the canopy)      |
| `plantsGlsl`      | `src/shaders/lib/plants.ts`    | falls, fireflies, garden, pond, tidepool                                   | "Rooted plants"                      |
| `planetGlsl`      | `src/shaders/lib/planet.ts`    | orbit, campfire, mobile; `skyGiant` behind its gate (`SKY_GIANT`)          | "The giant planet"                   |
| `figuresGlsl`     | `src/shaders/lib/figures.ts`   | country                                                                    | "Figures, livestock and buildings"   |
| `livestockGlsl`   | `src/shaders/lib/livestock.ts` | country                                                                    | "Figures, livestock and buildings"   |
| `buildingsGlsl`   | `src/shaders/buildings.ts`     | country                                                                    | "Figures, livestock and buildings"   |
| `terrainGlsl`     | `src/shaders/lib/terrain.ts`   | country                                                                    | `TerrainBuilder` under "Simulations" |
| `fieldsGlsl`      | `src/shaders/lib/fields.ts`    | country                                                                    | the fields row below                 |
| `treesGlsl`       | `src/shaders/lib/trees.ts`     | country                                                                    | the trees row below                  |

- **Fields** (`fieldsGlsl`): `fieldHold` and `fieldRows` (row profiles that settle to their mean
  where the dither cannot hold them) and `fieldFlowerMaterial` (meadow, lavender and sunflower
  materials through the year: given a year position, as `SKY_YEAR`, they flower through summer, go
  over into autumn, lie dormant through winter and come back green in spring, `fieldFlowerYear`):
  the countryside's flower parcels, whose use the land model (`src/sims/landuse.ts`) decides.
- **Trees** (`treesGlsl`): `treePineWidth(y)`, a pine's tiered, tapered outline, and
  `treeDomeNormal(dc)`, a broadleaf dome's normal in the eye's frame: the countryside's wood crowns
  and hedgerow and riverbank trees.

Such a component reads no knob defines (they are the scene's own): the scene passes every value as
an argument, and its knobs come from the component's builder where it has one (`birdKnobs`,
`plantKnobs`, `planetKnobs`, `skyKnobs({ milkyWay })`). Sims with a GLSL side export it beside
their TypeScript in the same way (`fishGlsl`, `plantSheetGlsl`, `mobileGlsl`, `binListsGlsl`,
`unsplitHalfGlsl`, `gustPulseGlsl`, `pendulumGlsl`; see "Simulations"). The breeze's cat's-paws
and the caustics (`src/shaders/windWater.ts`, `src/shaders/caustics.ts`) are not opt-in: they are
tiers of the water in `libs` (see "Water").

**Capabilities and tiers.** `SceneDef.features` puts `#define NAME n` ahead of the libraries. A
capability no scene selects is not in its program. A function a scene never calls costs nothing
anyway, so features are for what changes a function every scene calls (the moon's phase inside
`skyColor`: `SKY_MOON_PHASE`) or for a cheaper tier of a costly loop (`AURORA_CURTAINS`, default
3; `PLANT_DETAIL`, default 2). A component in tiers (`WATER_TIER`, see "Water"; `CLOUD_TIER`, see
"Clouds") compiles up to the tier the scene selects, each tier including the ones below it; code
that draws its part more than one way tests the tier (`#if WATER_TIER >= WATER_MIRROR`). A scene
that calls a function of a feature or tier it did not select fails to compile (without
`SKY_MOON_PHASE`, `skyMoonPhase` does not exist), never silently.

**Knob-keyed features.** `SceneDef.featuresFor(values)` extends the capabilities to the knobs: it
gets every knob as the shader reads it (`K_<key>`, keyed by knob key) and returns more defines,
merged over `features`, so a part behind a knob that is off is not in the program at all. This
matters because a software rasteriser (SwiftShader, the lab's fallback and its checks) runs every
line of a program whatever branches a pixel takes, and a loop's body at least once: an early-out
saves nothing there, only code that is not compiled in. Its companion `SceneDef.featuresAll` turns
every gate on and each tier up to the highest a knob selects. That program draws every setting
byte for byte as the setting's own does, because the shader's runtime tests of the knobs decide
(on a GPU they are uniform branches, nearly free). The adopters are `country` (`countryFeatures` and
`COUNTRY_ALL`: roads and tracks, rain, snow, fog, pine woods, flower fields, herds, walkers and carts
(and the snow they tread), birds, the harvest's bales, the verges, the murmuration, lit windows,
chimney smoke, the chalk M, the clouds' shadows tier, the water's ripples tier and the moon's phase;
its rain and snow as the climate makes them of the knobs at the date, `climatePrecip` over the cold
of `climateCold`, and the bales while the date lies in their stretch of the year, both at any date
while the year passes; `countryFeaturesAll` checks each gated setting), `meadow` (its wildflowers,
and the world's gates, `worldFeatures` and `WORLD_ALL`: see "World layers"), `shore` and `dunes`
(the world's gates alone), and `orbit` (`orbitFeatures` and `ORBIT_ALL`: the
figures in its stars, the planet's aurora and city lights, the M's lights, the moons and the ring
system, all off at its defaults; its storms, shooting stars and captured meteors stay in, as a
"now" shows them, and so do the cloud decks the storms flash in).

Library gates are setting-keyed features the shared libraries own: code a library compiles in only
while it shows (`src/shaders/index.ts`): the constellations, `SKY_FIGURES`, while their night
part's knob is on (`LIBRARY_GATES`), and the sky's planets, `SKY_PLANETS` (`PLANETS_GATE`), while
the scene's list holds any. `sceneFeatures(scene, values, planets)` defines each gate a scene can
hold, 0 or 1, and `sceneFeaturesAll` turns it on (the library defines it 0 where a scene lacks
it), so a program with the part off has none of its code (lake's frame under SwiftShader is as
fast as before the constellations), and every such scene is setting-keyed (`settingKeyed`)
whether or not it has `featuresFor`: the renderer takes it through the machinery below.
`src/shaders/index.test.ts` checks that every scene's all-features set covers each knob's turn and
its gates, the planets' too; the GPU checks take the knob gates through the `featuresFor` scenes,
which hold them too.

A scene enters with the program for its setting, built in the background like every program (see
"Entrances and exits"), so the plain page draws its lean program and builds no other. On a GPU a
knob change that needs another feature set builds none either: building a program can stall the
browser's GPU process, and every frame of the page with it, for as long as the driver compiles.
The change draws with a program the scene entered with for exactly that set, else with the scene's
all-features program. That one is built once per page, in the background, and never waited for:
the renderer asks KHR_parallel_shader_compile's completion status or, without that extension, a
fence set after the link, and then asks about the link no sooner than links have taken so far for
a source of its length, one a frame (the fence only says the GPU has run what came before it;
ANGLE links on threads of its own past that, so asking at once could wait out the whole link).
Once built it draws one frame, so a driver that compiles at the first draw does it then. While the
lab is open (`DitherRenderer.expectChanges`) it is built ahead once the scene has arrived, beside
whatever else builds: the next scene's program never waits for it, and a build for a scene passed
over finishes aside the same way; otherwise the first such change starts it, and the program on
screen goes on drawing the settings it drew last until it is built. A software rasteriser (a
renderer string naming SwiftShader, llvmpipe, softpipe or WARP) never uses it: there every gate's
code would run in every frame (the countryside's frames 5-10x slower under SwiftShader) and it takes
some 20 s to compile, a setting's own program 2-5 s.
There a change builds the setting's own program in the background in the same way, never waited
for. The renderer keeps up to four programs per scene and eight in all (the least recently drawn
freed, never one on screen or in a passage). A scene whose source does not assemble
(`SceneShaderError`) fails as one whose program does not compile. Rules:

- Gate each part on a superset of where its knobs show it (`x > 0` for `K_x > 0.0`), and keep the
  shader's own runtime test inside the gate: the all-features program draws by it.
- Define each gate 0 or 1 every time and test it with `#if` (a library feature tested with
  `#ifdef` is left out instead).
- Leave in anything a "now" button can show while its knob is off.
- Check that the default picture is bit for bit what it was (`scripts/ab.ts`).
- Give `featuresAll` every gate and tier `featuresFor` can select. `src/shaders/index.test.ts`
  checks that it covers each knob's turn. The GPU checks draw every gated setting (each knob turn
  that changes the program, derived from the knobs by `src/knob-turns.ts`, and all of them at once)
  with it, dithered and as source, and require it byte for byte as the setting's own program:
  `countryFeaturesAll` (`src/scenes/country/features.verify.ts`, over the countryside's land
  directly, with the settings no single turn reaches added by name) and `worldFeaturesAll`
  (`src/features.verify.ts`, the world's adopters, through the renderer). Through the renderer,
  `featureToggles` checks that no change waits for a build or builds a program after the first,
  and `sceneFeatures` how the programs take over.
- Checks that draw many settings with one program compile with every gate on (`country`'s
  `COUNTRY_ALL`).

**Level of detail.** One component can be a hero subject or a far decoration. A function with a
`foot` parameter takes the size of one dither cell at that point, in its own units. For sky
directions that is radians: about the vertical field of view over `uRes.y`. Raise it where the scene
blurs, as Frost does behind thick frost. Detail finer than a cell or two fades to its area mean, as
`fbmLod` does with octaves:

- a star layer whose grid falls under ~1.25 cells becomes a faint glow;
- the aurora's finest rays become an even glow;
- a meteor's core stays about a cell wide;
- the constellations' stars and lines are sized in cells, so they keep their shape at any footprint,
  and a figure line too short to clear its stars is left out; the giant planet takes the footprint
  as its cell (see "The giant planet").

Where the detail is resolved (stars at 96 rows or more for a 1-radian view, the aurora's rays at 76),
the result is bit for bit the full-detail one, so passing `foot` never changes a picture that was
already right.

**Clocks.** Moving components take the motion clock (`uMotionTime`), so the motion slider changes
their pace, never their phase. Events, meteors like lightning, fly in real seconds once started.
Random events stop at motion 0 (still pictures, reduced motion), and "now" still fires one.

The components and their three parts:

| Component      | Controls                                                                                                             | Features                                            | Outputs                                                                                                                                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stars          | `skyKnobs({ stars })`: `K_stars`                                                                                     |                                                     | `skyStars(sky, dir, density, foot)` coverage, `SKY_STAR_TINT`; `skyStarFade`                                                                                                                                                                                                         |
| Milky Way      | `skyKnobs({ milkyWay })` (`skyComponentKnobs` without the clock): `K_milkyWay`                                       | opt-in `milkyWayGlsl`                               | `milkyWay(dir, band)` radiance (times the scene's tint, `K_milkyWay`, `K_stars` and night), `milkyWayStars(density, band)` the stars crowding into it; the band's pole is the scene's (`MILKY_WAY_BAND`)                                                                             |
| Moon           | `skyKnobs({ moon })`: `K_moon`                                                                                       | `SKY_MOON_PHASE`                                    | `skyMoonPhase(sky, K_moon)`: the disc and halo in `skyColor`, the light in `sky.moonColor` and `sky.ambient`, the glare in `skyStars`; `skyMoonCover(sky, dir)` coverage                                                                                                             |
| Aurora         | `weatherKnobs({ aurora })`: `K_aurora`                                                                               | `AURORA_CURTAINS` (3)                               | `auroraM(dir, tm, strength, foot)` radiance, `auroraGlow(tm, strength)` light, `auroraSeen(sky, cloud)` visibility                                                                                                                                                                   |
| Canopy weather | `weatherKnobs({ rain, wind })`: `K_rain`, `K_wind`; the scene's seed knob                                            |                                                     | `canopyWeather(sky, K_rain)` light (the sky under the rain's cloud, the deck's brightness, the key's side and slant); `canopyRaySources`, `canopyGap(p, wind, seed, raySrc)` coverage (where the rain pours in); `canopyGapSky(w, washed, dir, stars, p, wind, seed, deck)` radiance |
| Water          | the scene's own (`K_wind` and its water knobs)                                                                       | `WATER_TIER` (tiers, see "Water")                   | slope and unresolved variance (`rippleSpectrum`, `windRipples`), mirror ray and Fresnel (`waterMirror`), drifted points (`waterDrift`, `waterFlow`), light on the bed (`waterCaustic`, the cellular net `causticCells`)                                                              |
| Clouds         | `weatherKnobs({ clouds, shadows })`: `K_clouds`, `K_shadows`; the scene's own (the cloud sea's cover, height, drift) | `CLOUD_TIER` (tiers, see "Clouds")                  | the deck's plane and calm field (`cloudDeckPoint`, `cloudFlatField`), the lit deck (`skyClouds`) rgb and coverage, its shadow (`skyCloudShadow`) light on materials, the sea of tops (`cloudSeaMarch`, `cloudSeaTop`, `cloudSeaShadow`) distance, normal and light                   |
| Meteors        | `skyKnobs({ meteors: { trigger } })` (`skyComponentKnobs` without the clock): `K_meteors`                            |                                                     | `meteorAge(tm, rate, slot, seed)` schedule, `meteorStreak(q, field, age, seed, foot)` coverage in the scene's frame (`skyAngles(dir)` on a dome, screen heights for a flat backdrop), `METEOR_TINT`                                                                                  |
| Constellations | `skyKnobs({ constellations: true })` (`skyComponentKnobs` without the clock): `K_constellations`, off at 0.4         | the library gate `SKY_FIGURES`                      | inside `skyStars`' coverage, no call of its own: the figures of `constellations.ts` (its `uCon*` uniforms, all but the Manifold mark) fixed on the dome, their stars brighter than the field's, the lines at `K_constellations`; faded as the stars (`skyStarFade`)                  |
| Sky giant      | `skyKnobs({ giant: { across, up } })` (`giantKnobs`): `K_planet` and its placement, palette, ring, moons, aurora...  | the library gate `SKY_GIANT` (`planetGlsl` with it) | `skyGiant(sky, col, dir, foot, clear)`: the giant over the sky up to its stars, fixed in the stars' frame, behind what the scene draws after (cloud, aurora, ground); see "The giant planet"                                                                                         |
| Birds          | `birdKnobs({ kind })` (`shaders/lib/birds.ts`): `K_birds`, `K_birdKind`, `K_birdFormation`                           | opt-in `birdsGlsl`                                  | `birdFlights(p, sky, cam, tm, pxl)` coverage, depth and albedo (`BirdHit`); `birdFlightsSeen(..., true)` the image in still water; `birdBelowHit` from below                                                                                                                         |
| Rooted plants  | `plantKnobs({ group, season, growth, gusts })` (`src/scenes/plants.ts`), read by the sim only                        | opt-in `plantsGlsl`, `PLANT_DETAIL` (2)             | organs on springs (`RootedPlants`) packed as records (`PlantTexture`, `plantOrgan`) for shared shapes drawn per fragment (`plantFrond`, `plantArc`, `plantPoint`), or rasterised into a sheet the scene samples (`PlantSheet`, `plantSheetGlsl`); see "Rooted plants"                |
| Giant planet   | `planetKnobs({ prefix, clouds, storms, aurora, lights, daycycle, moons, ring })` (`src/scenes/planet.ts`)            | opt-in `planetGlsl`                                 | a hero composes the parts (`planetBelts`, `planetClouds`, `planetAurora`, `planetCityLights`, `planetRingBands`, `planetMoonDisc`...) as coverage and light; a decoration draws the whole giant over an RGB sky (`planetOver`); see "The giant planet"                               |

Bamboo and Forest compose the canopy weather under their leaves, each with its own tint on the
washed sky, deck gain (1.3, 1.25), shelter (half, 45% of the rain under the leaves) and ray bases;
and the grove under it (`canopyGroveGlsl`): the shafts, the crowns overhead and the drips off the
leaves, each in the scene's own shapes (`FOREST_CROWNS`, `BAMBOO_DRIPS`, the shafts' widths).

Frost composes the four sky components through its window (`frost/index.ts`, `frost/shader.ts`):

```ts
...skyKnobs({ time: 0.9, stars: 0.5, moon: 1, meteors: { trigger: FROST_METEOR_TRIGGER } }),
...weatherKnobs({ snow: true, wind: true, aurora: true, on: { snow: true } }),
// in the SceneDef:
features: { SKY_MOON_PHASE: 1 },
```

```glsl
Sky sky = skyMoonPhase(skyAt(timeOfDayM(K_time, K_cycle, uMotionTime)), K_moon);
// ... behind the glass, sky first:
float foot = 1.0 / uRes.y;                             // a cell in radians: the view spans 1 radian
vec3 col = skyColor(sky, dir);                         // the moon's disc and halo in its phase
vec4 cloud = skyClouds(sky, dir, uMotionTime, cover, K_wind);
col = mix(col, cloud.rgb, cloud.a);
col += SKY_STAR_TINT * skyStars(sky, dir, K_stars, foot) * (1.0 - cloud.a) * sharp;
float open = auroraSeen(sky, cloud.a);
col += auroraM(dir, uMotionTime, K_aurora, max(foot, blur)) * open;
float seed;
float age = meteorAge(uMotionTime, K_meteors, FROST_METEOR_SLOT, seed);
col += METEOR_TINT * hardEdge(meteorStreak(skyAngles(dir), FROST_METEOR_FIELD, age, seed, max(foot, 0.5 * blur)) * open * sharp);
// ... then houses, trees and lamps over it, lit by
lit += auroraGlow(uMotionTime, K_aurora) * auroraSeen(sky, overcast);   // the snow cloud shuts it out
```

The moon's light reaches the snow, the clouds and the room through `sky` itself. Setups are plain
URLs, e.g. `?scene=frost&snow=0&aurora=1&moon-amount=0.3&meteors=1`, and reset restores the
defaults: full moon, aurora and meteors off.

#### Sky capabilities by scene

What each scene with a sky does with the components. **knob**: wired to the shared knob (every one
changes the picture at night; the default is the value the scene drew before). **fixed n**: drawn by
the shared component at a fixed value. **full**: the ordinary full moon of `skyColor`, not exposed.
**own**: a scene-specific version kept on purpose. **—**: not applicable, no knob. Rows marked † still
have **open** cells: an open night sky where the component could be composed.

| Scene              | Sky seen                                                         | Stars                                            | Moon                                                       | Aurora                                                             | Meteors                                                                              |
| ------------------ | ---------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `train`            | through the window                                               | knob 0.75                                        | knob (phase) + night glow                                  | knob (`auroraCurtains`, full detail)                               | own: `K_meteors`, trigger 5, window and tunnel                                       |
| `frost`            | through the window                                               | knob 0.5 (cabin ×1.7)                            | knob (phase)                                               | knob                                                               | knob, trigger 1                                                                      |
| `autumn`           | over the park, under the canopy                                  | knob 0.5                                         | knob (phase; keys the night light)                         | knob, behind the clouds                                            | knob, trigger 2                                                                      |
| `bees`             | over the valley (the world's sky, "World layers")                | knob 0.6 + the world's Milky Way (knob, on)      | knob (phase at every setting; keys the night light)        | knob, behind the clouds and the cumulus                            | knob, trigger 0                                                                      |
| `dunes`            | over the dune sea (the world's sky; none overhead)               | knob 1 + the world's Milky Way (knob, on)        | knob (phase; keys the sand's light)                        | knob, behind the clouds and the dust                               | knob, trigger 0, behind the clouds and the dust                                      |
| `falls`            | above the cliff                                                  | knob 0.45                                        | knob (phase)                                               | knob, its arc lifted over the rim                                  | knob, trigger 0, falling behind the rim                                              |
| `garden`           | the haze over the wall (the horizon is the frame's top edge)     | —                                                | knob (phase; keys the night light)                         | —                                                                  | —                                                                                    |
| `lanterns`         | over the river, mirrored                                         | knob 0.55 (+ own sparse stars, thinned below it) | own young crescent, fixed in the frame                     | knob, mirrored                                                     | knob, trigger 2, mirrored                                                            |
| `meadow`           | over the meadow (the world's sky, "World layers")                | knob 0.6 + the world's Milky Way (knob, on)      | knob (phase)                                               | knob, behind the clouds                                            | knob, trigger 2                                                                      |
| `shore`            | over the sea and mirrored in it and the wet sand (the world's)   | knob 0.6 + the world's Milky Way (knob, on)      | knob (phase, compiled in at every setting; moonrise)       | knob, behind the clouds, mirrored                                  | knob, trigger 2, mirrored                                                            |
| `sill`             | over the city                                                    | knob 0.5                                         | knob (phase)                                               | knob, light through the window                                     | knob, trigger 3                                                                      |
| `skyward`          | a strip between roofs                                            | knob 0.3                                         | knob (phase)                                               | — (looking up: the curtains hang toward the horizon, out of view)  | knob, trigger 0, camera frame                                                        |
| `bamboo`, `forest` | canopy gaps                                                      | knob 0.5                                         | knob (phase; the gaps and the night rays)                  | —                                                                  | —                                                                                    |
| `street`           | in reflections only                                              | knob 0.55 (window glass)                         | knob (phase; the windows and wet street)                   | —                                                                  | —                                                                                    |
| `lake`             | over the ice, mirrored                                           | own `K_stars` + shared Milky Way (knob)          | own phase, fixed bearing                                   | knob (`auroraCurtains` on the sim's substorm clock, rough-ice tap) | knob, trigger 3, mirrored                                                            |
| `aurora`           | the subject, mirrored in the fjord                               | own `K_stars` on a fixed night                   | own crescent                                               | own curtains                                                       | knob, trigger 1, mirrored                                                            |
| `swell`            | over the sea                                                     | own (`starfield`, `K_stars`)                     | own disc (`K_moon` sizes it), its `waterGlitter` path      | —                                                                  | knob, trigger 0, screen frame, glints in the waves                                   |
| `clouds` †         | above the cloud sea                                              | knob 0.75                                        | own bearing, drawn by `skyColor`                           | knob (`auroraCurtains`, full detail)                               | open                                                                                 |
| `country`          | over the valley                                                  | knob 0.5                                         | knob (phase; `SKY_MOON_PHASE` compiled in only below full) | open                                                               | open                                                                                 |
| `flock` †          | the subject over a skyline (only the dome mirrored in its water) | knob 0.45                                        | full                                                       | open                                                               | open                                                                                 |
| `island` †         | round the island                                                 | knob 0.6                                         | full                                                       | open                                                               | open                                                                                 |
| `campfire` †       | above the pines                                                  | knob 0.8 + shared Milky Way (knob)               | — (the giant planet replaces it)                           | open                                                               | own: `K_shooting`, trigger 0, under the planet                                       |
| `kelp`             | Snell's window                                                   | —                                                | full, refracted                                            | —                                                                  | —                                                                                    |
| `tidepool`         | the sky in the pools' mirror                                     | —                                                | full, mirrored                                             | —                                                                  | —                                                                                    |
| `dew`              | out-of-focus dawn backdrop                                       | —                                                | —                                                          | —                                                                  | —                                                                                    |
| `bonsai`           | none (its light only)                                            | —                                                | —                                                          | —                                                                  | —                                                                                    |
| `orbit`            | its own sky                                                      | own                                              | own                                                        | —                                                                  | own (captured meteors)                                                               |
| `fireflies`        | its own moonless sky over the mangroves                          | own                                              | — (moonless)                                               | —                                                                  | knob (`skyComponentKnobs`), trigger 2, over the hills behind the trees, not mirrored |

`aurora` and `lake` keep a night of their own: their own `K_stars` knob sets the shared stars
(`skyStarLight`) on it.

The constellations come with `skyStars`, so every scene whose stars it draws, directly, through
`skyStarLight` or through the canopy's (`canopyGapSky`) or the world's sky, has the knob: every
**knob** in the Stars column above, and `aurora` and `lake` for the shared stars on their own
nights. How much of them shows is the view's: `aurora` sees every figure; `lake`, `frost`,
`campfire` and `sill` three or four; `country` (a strip of sky some 15 degrees deep) little;
`street` only its window glass. `swell`, `orbit` and `fireflies` draw stars of their own and have
none (orbit keeps a `constellations` toggle of its own).

Planets can hang in every such sky that has room for them: `aurora`, `autumn`, `bees`, `clouds`,
`country`, `dunes`, `flock`, `frost`, `island`, `lake`, `lanterns`, `meadow`, `shore`, `sill`,
`skyward` and `train` (see "The sky's planets"). `campfire` keeps its own giant; `falls` sees only a
strip of sky over its cliff under the cloud deck, `bamboo` and `forest` only gaps in the canopy, and
`street` only reflections, so none of them takes them.

The rest have no sky: `bar`, `chladni`, `delta`, `ferro`, `film`, `fractal`, `harmonograph`,
`hyperbolic`, `incense`, `lava`, `marble`, `mobile`, `pearl`, `pendula`, `petri`, `physarum`,
`pond`, `prism`, `ripple`, `sandtable`, `shanshui`.

#### Birds

The birds family (`src/shaders/lib/birds.ts`; opt-in: put `birdsGlsl` in the scene's GLSL) decides
what flies and how: seven species (rooks, swallows, gulls, geese, a buzzard, pigeons, swifts), each
with its size, colour, wingbeat, party and the share of a scene's lane it keeps to (swallows near
and low, geese far and high); four formations (solo, a loose party, a V, circling on a thermal);
and the schedule, four flight slots on the motion clock, still at motion 0. The scene supplies its
camera (`BirdCamera`), its lanes, hours and weather (`BirdSky`: `birdSky(K_birds * calm, K_birdKind,
K_birdFormation - 1.0, depths, band, seed)`, then `hours`, `clock`, `swoopTo`, `parallax`), the
occlusion (`BirdHit.depth` against the depth of its own first surface) and the light. Views:
side-on for a level pinhole camera (`birdFlights`), the same flights' image in still water
(`birdFlightsSeen(q, ..., true)`, looked up at the scene's own mirrored sky point, ripples and all),
and from below for a camera looking up (`birdBelowHit`, the scene moving its birds). Level of
detail: a bird is never narrower than its species' `cells`, its strokes about a cell wide, so a far
flight is a few clear marks rather than flicker.

| Scene      | Birds                                                                                                           | Default                  | Hidden by                                                         | Mirrored in       |
| ---------- | --------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------- | ----------------- |
| `country`  | `birdFlights` through its level pinhole (metres), `birdKnobs` (mixed: rooks, gulls, swallows...)                | off, mixed               | land, crowns, buildings, figures, by depth                        | —                 |
| `skyward`  | `birdBelowHit` on the scene's own paths (pigeons wheeling over the street, swifts looping above); `birds` range | 0.5, pigeons and swifts  | anything nearer along the ray                                     | —                 |
| `meadow`   | the world's (`worldBirds`, `worldKnobs`)                                                                        | on 0.35 by day, swallows | the sea of grass by depth; the near blades and clocks             | —                 |
| `shore`    | the world's (`worldBirds`, `worldKnobs`); its image `worldBirdsMirrored`                                        | on 0.35 by day, gulls    | the surf by depth (a skimming gull dips behind a nearer breaker)  | the wet sand      |
| `dunes`    | the world's (`worldBirds`, `worldKnobs`); none overhead                                                         | on 0.35 by day, buzzard  | the dunes and the M by depth; hazed by the dust                   | —                 |
| `bees`     | the world's (`worldBirds`, `worldKnobs`); a bird hides the insects behind it                                    | on 0.35 by day, swallows | the orchard, the wall, the hives and the near flowers by depth    | —                 |
| `falls`    | `birdFlights` (`fallsBirds`), `birdKnobs`                                                                       | off, swifts              | cliff, rim trees and slot walls by depth; spray and the near bank | —                 |
| `swell`    | `birdFlights`, `birdKnobs`                                                                                      | off, gulls               | the sea by depth (crests, with relief)                            | —                 |
| `aurora`   | `birdFlights` in `aurFar`, `birdKnobs`                                                                          | off, geese               | the near bank and birches                                         | the fjord         |
| `lake`     | `birdFlights` in `lakeBeyond`, `birdKnobs`                                                                      | off, geese               | the cabin and the point's grove                                   | the black ice     |
| `lanterns` | `birdFlights`, `birdKnobs`                                                                                      | off, geese               | (nearer than the far bank)                                        | the rippled river |
| `train`    | `birdFlights`, `birdKnobs` (the `line` choice sets the mix)                                                     | off, mixed               | the line's land and structures (the scene's)                      | —                 |

#### Figures, livestock and buildings

Three opt-in parts for a scene that peoples a landscape, each drawn in the scene's own screen units
around a point the scene projects from its world and moved only by analytic clocks, so it stands
still with the motion. The scene supplies placement, occlusion, light, wetness and snow. The
countryside composes all three.

- `figuresGlsl` (`src/shaders/lib/figures.ts`): small people and land vehicles at their world size
  (`figureWalker`, and `figureCart`: a horse and cart or a tractor and trailer), cut per cell and
  never under a cell, a faint cell below ~1.6 cells tall (`figureSpeck`), on analytic stroll and
  shuttle clocks (`figureStroll`, `figureShuttle`; country's roads). It has no boats, and neither
  island nor shore draws a figure for it to replace: island's distant movers are a gull and a
  balloon, shore's the surf, its plankton and fish. A scene that gains people (island's pier,
  shore's tideline) or a harbour's boats would start from it, boats as a new shape beside
  `figureCart`.
- `livestockGlsl` (`src/shaders/lib/livestock.ts`): cattle and sheep seen side-on, and the
  schedule that keeps a herd alive without a simulation: slots on the motion clock in which each
  animal grazes, walks, stands about or lies down, by the hour and the weather (`livestockMood`),
  from one anchor of the scene's to the next. The scene supplies the anchors (its ground, walls and
  projection) and the shading (country's pasture enclosures).
- `buildingsGlsl` (`src/shaders/buildings.ts`): a cottage and a church that sort a point into faces
  in the shape's own units, with walls reaching down to the land's outline, details dropping out or
  growing to a cell below `px`, windows lit by the time of day (`buildingWindow`) and chimney smoke
  on the motion clock (`buildingSmoke`): country's far houses (its near houses and its castle are
  models of its own, `country/buildings.ts` and `country/castle.ts`).

#### Rooted plants (`src/sims/plants.ts`, `src/shaders/lib/plants.ts`, `src/scenes/plants.ts`)

One plant component for every scene that grows things. The CPU side (`RootedPlants`) owns what
happens: a scene lays out sites (where, which way, how lush and wet, under water or not) and picks
a species for each (`plantFitness` weighs a species against a site's moisture); the plant keeps its
root and structure (axes carrying leaves, fronds, blades, flowers, roots) from frame to frame. Each
organ bends on a damped spring under the breeze, eddies and gust fronts (`GustTrain`) or, under
water, the current's quadratic drag; a growth clock unfolds, ages and replaces leaves; the year
(`season` 0..1 from spring; `PLANT_SUMMER` while the knob is off) turns, sheds and flowers them.
The scene owns how they look: its projection, palette, light, what hides them and the passage.

- **Tiers.** Two drawing tiers over the same organs: per fragment, `plantsGlsl` (opt-in, interpolate
  it) reads `PlantTexture` records (`plantOrgan`) and draws shared shapes (`plantFrond`, `plantArc`)
  for tens of organs a pixel looks at (falls' bank, the tide pool's grid-slotted holdfasts); or
  `PlantSheet` rasterises hundreds into a sheet the scene samples (`plantSheetGlsl` decodes it; the
  pond). A compile-time tier `PLANT_DETAIL` (`SceneDef.features`, default 2) drops fine shape
  detail (1: silhouettes) for a scene that never shows it.
- **Level of detail.** Each organ's projected length in cells (`cells` per unit, per site for a
  camera) sets its tier: full, simplified (a flat-shaded rounder silhouette, no taper), or not
  drawn; simplified organs follow their spring's balance instead of integrating it. Shapes taking
  `foot` fade detail finer than two cells to its mean (`plantKeep`) and are bit for bit unchanged
  where it is resolved.
- **Composition.** An organ on the site may spring from a point `offset` from it (a tree's prop
  roots along its crown); `PlantClimate.wind` adds air the scene moves itself (a breeze front of its
  own, the garden's gust crossing as a front) to the breeze, and is told each organ's plant, for air
  that differs from plant to plant (the meadow's gust field
  at each clump's foot); an organ with a negative slot is never packed (one the scene draws its own
  way, as fireflies' crowns through the bank's profile);
  `PlantTexture.pack(a, b)` writes two systems into one texture (the garden's woods and border, each
  in its own frame, after the scene's own rows); `writePlantRecords` writes the same records into a
  texture the scene lays out itself (the countryside's verges, in its records atlas); `plantPoint`
  (GLSL) finds a point along a posed organ (a swaying stem's tip).
- **Controls.** `plantKnobs({ group, season, growth, gusts })` gives `season`, `growth` and `gusts`
  (with its trigger), all off: adopting them never changes a picture. A scene with a season of its
  own leaves `season` out and maps its own onto the year (garden's season choice).
- **Consumers.** pond (sheet tier, the border), falls (the near bank's ferns per fragment; the
  ledge ferns draw the same `plantFrond` from hashes), tidepool (kelp, surfgrass and anemones in
  the water's flow, read back from the GPU), fireflies (every tree of the bank: a stem carrying its
  crown's clumps, bowing to the breeze front through `wind`, and Rhizophora prop roots per fragment
  from grid-slotted records), garden (a stem under every crown of the woods over the wall, the
  shader drawing its old silhouette where the stems' tips carry the crowns, `plantPoint`; and an
  optional border of fern and mondo grass in the wall-foot gutter, binned records drawn per fragment
  with `plantFrond` and `plantArc`, following the maple's season choice; not the maple),
  meadow (optional `wildflowers`: clumps of daisies, buttercups, knapweed and scabious bowed by its
  own gust field, compiled in only while on), country (optional `verges`: cow parsley, campion and
  tussock grass at the near hedges' foot, binned by bearing and drawn per fragment with `plantArc`
  from its records atlas, bowed by the flower fields' gust bands, their plant year the countryside's
  date through `countryVergeYear`, compiled in only while on). Next: meadow's near grass and
  dandelion stems (on their own springs), kelp (stipes stay on Verlet).

#### The giant planet (`src/shaders/lib/planet.ts`)

One ringed gas giant, one implementation, that any sky composes: Orbit's subject and Campfire's
scenery. It is opt-in: put `${planetGlsl}` at the top of the scene's GLSL, as both of them do. The
library decides the planet and what moves where (belts, clouds, storms, the aurora's oval, city
lights, the ring plane, the moons' orbits); the scene decides placement, size, the sun's direction,
the palette, which features it composes, what stands in front and how it composites. Frame: planet
radii from its centre, x right, y up, z toward the eye; `planetAt` maps the scene's flat units into
it.

- **Two tiers.** A hero composes the functions one by one and maps their outputs to its own picture
  (Orbit: ink and accent coverage). A decoration calls `planetOver(col, p, px, look, tm, t)`, which
  draws the whole giant over an RGB sky; `planetGiant(centre, radius, light)` fills a `PlanetLook`
  (Campfire's teal bands and thin ring, every feature off) for the scene to adjust field by field,
  and the scene draws its foreground over it afterwards.
- **Level of detail.** Every detailed function takes `foot`, one dither cell in planet radii (the
  scene's cell over the radius). Detail spanning a cell or more is the full-detail result bit for
  bit, so a planet that already resolved its detail draws the same picture; finer belts and cloud
  octaves fade to their mean, aurora folds blur, ring grooves and boulders fade to their mean cover,
  city lights and storm cells merge into fewer, larger cells (each lit as often as any of the towns
  it covers), and a moon never shrinks below a cell. The same planet works filling the frame or a
  few dozen cells across.
- **Controls.** `planetKnobs(options)` (`src/scenes/planet.ts`) gives the planet's knobs with shared
  labels, help and defaults: `clouds`, `storms` (with its trigger slot), `aurora` and `auroraSize`,
  `lights` and `lightsTwinkle`, `daycycle`, `moons` and `eclipses`, and the ring system (`ring`,
  `ringCount` .. `ringSpin`), each only if asked for and all starting off, so adopting one never
  changes the picture. `prefix` keeps a sky's keys apart from its own (`prefix: "planet"` gives
  `planetMoons`, read as `K_planetMoons`); `groups` and `when` place them in the lab;
  `planetGroups` has the planet's headings. Placement and size stay the scene's knobs.

```glsl
struct PlanetPoint { vec2 q; float d; vec3 normal; };            // q radii from the centre, d = |q|, the sphere's normal while d < 1
PlanetPoint planetAt(vec2 p, vec2 centre, float radius);         // p, centre, radius in the scene's units
float planetLod(float size, float foot);                         // 1 while size (radii) spans a cell, 0 at half a cell
vec3 planetSun(vec3 light, float sweep);                         // the sun turned about the planet's axis: a day cycle or a phase
float planetSunward(vec2 q, vec3 light);                         // -1..1 toward the sunward limb
float planetNight(float diffuse);                                // 0..1 the night side from the clamped sun cosine
float planetRim(vec3 normal);                                    // grazing light at the limb
float planetHalo(float d, float radius, float falloff);          // a thin limb halo, falloff per scene unit (orbit)
float planetGlow(float d, float width);                          // a broad airglow round the limb (campfire)
float planetLongitude(vec3 normal, float drift, float swing);    // longitude, turned by the surface's drift and a camera swing
float planetBelts(vec3 normal, float lon, float foot);           // turbulent belts 0..1 (orbit)
vec2 planetSwirl(vec2 q, float roll, float tm);                  // storm-swirled bands: x band, y storm eye (campfire)
vec3 planetBandColor(vec2 swirl, vec3 deep, vec3 mid, vec3 pale, vec3 eye);
float planetClouds(vec3 normal, float lon, float tm, float foot); // the cloud deck 0..1
float planetStorms(vec3 normal, float lon, float t, float level, float cloud, float diffuse, float foot); // night-side lightning 0..1
float planetCityLights(vec3 normal, float lon, float t, float twinkle, float foot); // 0..1, times planetNight
float planetAurora(vec3 n, vec3 pole, float size, float tm, float foot); // the oval round a pole the scene picks
float planetAuroraCurtain(vec2 q, float d, vec3 pole, float size, float tm, float foot); // its curtains off the limb (d > 1)
struct PlanetRing { float facing; float roll; };                 // a plane through the centre: cos of its tilt to the eye, its turn on screen
vec3 planetRingNormal(PlanetRing ring);                          // the planet's axis
vec3 planetRingAt(PlanetRing ring, vec2 q);                      // the plane on this line of sight: xy in-plane (radii), z depth toward the eye
vec2 planetRingPlane(PlanetRing ring, vec3 point);               // a 3D point of the plane in the same coordinates
bool planetShadowed(vec3 point, vec3 light);                     // in the planet's shadow (the ring behind it)
bool planetRingShadowAt(PlanetRing ring, vec3 normal, vec3 light, out vec2 plane); // where the sun ray from the surface meets the plane
float planetRingOpacity(float cover);                            // how much a ring's cover hides behind it
struct PlanetRingBands { float inner; float outer; float count; float spacing; float density; float texture; float spin; };
float planetRingBands(vec2 plane, PlanetRingBands b, float tm, float foot, out float band); // the banded system's cover (orbit)
float planetRingThin(float rho, out float streak);               // a thin streaked ring with a gap (campfire)
struct PlanetMoon { float rate; float phase; float distance; float size; float tilt; float roll; };
PlanetMoon planetMoon(int i, PlanetRing frame);                  // moon 0..2 of a family orbiting near the plane `frame`, at Kepler's rates
vec3 planetOrbit(float angle, float radius, float tilt, float roll); // a point on an inclined orbit
bool planetBehind(vec3 p);                                       // hidden behind the disc
vec3 planetMoonAt(PlanetMoon m, float tm, float swing, float spread); // its centre (a passage may swing and spread it)
vec3 planetMoonDisc(vec2 q, vec3 centre, float size, vec3 light, float seed, float foot); // x cover, y light, z surface depth
float planetMoonShadow(vec2 q, vec3 centre, float size, vec3 light); // its eclipse on the disc 0..1
PlanetLook planetGiant(vec2 centre, float radius, vec3 light);   // the decoration: palette, thin ring, features off
vec3 planetOver(vec3 col, vec2 p, float px, PlanetLook look, float tm, float t); // the decoration over an RGB sky
```

| Feature        | `orbit` (hero)                   | `campfire` (decoration)                                           |
| -------------- | -------------------------------- | ----------------------------------------------------------------- |
| Surface        | turbulent belts, rim light       | swirled teal bands, rim light                                     |
| Atmosphere     | sunward halo                     | airglow                                                           |
| Clouds, storms | knobs                            | —                                                                 |
| Aurora         | knob; pole tipped toward the eye | knob; pole on the ring's axis                                     |
| City lights    | knob (+ the M, its own)          | knob                                                              |
| Day cycle      | knob                             | knob                                                              |
| Ring           | banded system, knobs             | thin ring, fixed                                                  |
| Moons          | knob; near face-on orbits        | knob; on the ring plane, crossing in front of and behind the disc |

A scene that places its own planet adds it in a few lines, its own foreground drawn after
(`PlanetLook.ringed` 0 takes the thin ring away):

```glsl
PlanetLook look = planetGiant(vec2(-0.4, 0.75), 0.12, normalize(vec3(-0.6, 0.4, 0.7)));
look.visible = sky.night;
look.moons = K_planetMoons;                                     // from planetKnobs({ prefix: "planet", moons: true })
col = planetOver(col, p, 1.0 / uRes.y, look, uMotionTime, uTime);
```

**The sky's planets.** Any night sky of the shared library hangs an open list of planets among its
stars with one call, `skyGiant(sky, col, dir, foot, clear)` (`src/shaders/lib/sky.ts`, compiled in
only while the scene's list holds a planet: the library gate `SKY_PLANETS`, which brings
`planetGlsl` and the body tier `planetBodyGlsl` with it; a stand-in that returns `col` otherwise).
A scene takes them with `SceneDef.planets: { group, across, up }`: the lab group whose Night sky
section holds them, and the stretch of its sky the placement pad covers, in degrees across from
straight ahead and up from the horizon, each `[least, start, most]`. The list starts empty.

- **A planet** (`src/scenes/planets.ts`) is a set of values keyed as knobs are, from `planetDefs`:
  its `kind` and `size` (as small as our moon .. a giant filling a good part of the sky; a bigger
  planet is a nearer one and stands in front), its `palette` (four per kind), where it stands
  (`across`, `up`) or, with `orbit` on, the path it orbits our world on: a daily circle of the
  sky's latitude that tops out where the pad puts it, leaned by `incline`, a circuit every
  `orbit-amount` minutes of the motion clock from `phase` of the way round, so it rises on the
  right, crosses and sets on the left, drifting against the stars and the day and hidden below the
  horizon; its light (`phases`: lit by the scene's own sun, so it waxes and wanes as the sun goes
  round; off, from the upper left as campfire's giant is, with its `daycycle`), its `spin` (its own
  clock: the surface turns, the clouds and moons go round with it; 0 holds it still), its `ring`
  (none, thin, wide banded) with `ringTilt` and `ringRoll`, its `moons` (count, `moonSize`,
  `eclipses`), `aurora` (`auroraSize`) and city `lights` (`twinkle`).
- **Kinds** (`PLANET_BODY_KINDS` in `src/shaders/lib/planet.ts`), stylised for a few dozen
  dithered cells: the banded giant (planetOver's, campfire's teal, amber, rose, ice), a ringed
  giant after Orbit's (belts bent by turbulence, an oval storm, cloud decks, night-side lightning;
  it comes with the wide ring), a cratered rock, an ocean world (caps, cloud swirls, the sun's
  glint), a home-like world on our own climate (continents, deserts, cloud; its own year, one
  every two minutes of its clock, spreads sea ice and snow from its poles by `climateCold` and
  `climateLying` of `src/climate.ts`, its hemispheres half a year apart), a lava world (molten
  cracks glowing on its night side), a crystal (flat facets, glints, sparkles), an eye (an iris
  that looks about, veins, blinking lids) and a bubble (a rainbow film the stars show through).
  Each kind's surface is a loop of at most one turn, so a software rasteriser runs only the kinds
  on screen.
- **In the URL** the list is one key, `planets` (`PLANETS_KEY`): base64url of unsigned varints,
  the version (1), the count, then per planet how many of its values differ from their defaults
  and each as a field id (`FIELDS`, append only) and its value in its step's quantum (zigzag for a
  sign). Values sit on their steps' grid, so a list round-trips exactly; a malformed value (another
  version, bad base64url, cut short, trailing bytes) is no planets, an out-of-range value is
  clamped, past the cap the first eight stay; nothing throws. A link from before the list whose
  one giant planet was on (`planet=1` with `planetX`, `planetY`, `planetPalette`, `planetRing` and
  the `planet...` features) opens with that giant as its first planet (a step of the URL schema,
  state.ts `MIGRATIONS`, by `GIANT_KEYS`), and the page writes the list in their place. How a list
  lives beside the knobs: "Links and the URL schema".
- **In the shader** the list is uniforms beside `uParams` (`planetUniforms`): `uPlanets`, five
  vec4 rows per planet (its path's circle, so a fixed planet is its direction and an orbiting one
  moves with `uMotionTime` alone; its radius; its switches packed, `SKY_PLANET_FLAGS`; its dress)
  and `uPlanetCount`, at most `SKY_PLANET_CAP` (8, the drawn maximum; the lab adds none past it),
  the smaller first so they draw back to front. Editing a planet sends uniforms and never builds a
  program; only the first planet and the last one's going change the program (the gate). A cheap
  bound finds the planets that reach a pixel, and only those are drawn, in a loop whose turns are
  those planets, so eight planets cost little more than one. Under SwiftShader (320 x 200 cells,
  midnight) aurora's frame takes some 57 ms without planets, 225 ms with one and 258 ms with eight,
  its program 1.9 s to build without the gate and 4.8 s with it; country's 108, 187 and 323 ms,
  4.0 and 6.1 s. A sky without planets compiles none of it. The palettes are a chain of branches,
  not a const table: SwiftShader builds a dynamically indexed const array afresh in every pixel.

The library maps each planet onto the scene's sky directions: `dir` is the direction the scene
gives `skyStars` (so a fixed planet stands among the stars as they do, and moves with them under a
pointer's parallax), each planet seen square-on round its centre (a gnomonic view), `foot` the
radians a dither cell spans, `clear` how much of the sky the scene's cloud leaves open where the
cloud is drawn before the stars. Call it after the stars and the Milky Way and before the cloud,
the aurora, shooting stars and the ground, in mirrors too:

```glsl
col += SKY_STAR_TINT * skyStars(sky, dir, K_stars, foot) * (1.0 - cloud.a);
col = skyGiant(sky, col, dir, foot, 1.0 - cloud.a);   // frost: its deck drawn before the stars
```

Each planet is drawn as campfire's decoration draws its giant (`planetBodyOver`, the body tier of
`planetOver`: a banded planet with a thin ring or none is that giant); by day the planets fade to
pale ghosts as campfire's does (15% of them shows), and they hide behind the moon's disc and the
horizon. Campfire keeps its own planet, placed in its frame low over the pines, with
`giantKnobs({ group, on, help })` for its existing knobs; orbit is its own hero.

#### Water

Water is one component in tiers, cheapest first, each including the ones below it. A scene selects
the highest it draws, `features: { WATER_TIER: WATER_TIERS.mirror }` (`WATER_TIERS` from
`shaders/lib/water.ts`), and only that much is compiled into its program: calling a function of a
higher tier fails to compile. The tiers compose the water parts that already exist rather than
repeating them:

| Tier       | `WATER_TIER`       | What the scene gets                                                                                                                                                                                                                                                                                                                       |
| ---------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flat`     | `WATER_FLAT` 0     | nothing shared: its own tint, its sky mirrored flat if it likes                                                                                                                                                                                                                                                                           |
| `ripples`  | `WATER_RIPPLES` 1  | wind ripples: `rippleSpectrum` over its own trains (surface.ts, in every program), or the breeze's cat's-paws, `windRipples`, with the screen-space mirror shift `windMirror` (`shaders/windWater.ts`)                                                                                                                                    |
| `mirror`   | `WATER_MIRROR` 2   | reflections: `waterMirror`, the rippled normal, reflected ray and Fresnel; the scene looks its own sky and scenery up along the ray. The sun's or moon's glitter, `waterGlitter`: a Beckmann lobe (Cox & Munk) on the variance the cells do not draw, 1 at its heart                                                                      |
| `flow`     | `WATER_FLOW` 3     | currents: `waterDrift` carries a pattern on a steady current, `waterFlow` on one that varies from place to place (two copies, evaluated twice)                                                                                                                                                                                            |
| `caustics` | `WATER_CAUSTICS` 4 | the bed lit through the surface: `causticRipples`' net (`shaders/caustics.ts`) and `waterCaustic`, which multiplies it by a simulated surface's own focus (`ShallowWater.surface`, `sims/shallow.ts`); or, for water with no spectrum of its own, the stylised cellular net `causticCells` (seams where a wandering lattice's cells meet) |

The shared parts own the physics: ripple trains with deep-water dispersion and their LEAN split
between drawn slope and unresolved variance, the cat's-paws, the mirror's normal and Fresnel, the
glitter's lobe, the advection, the caustic Jacobians. The scene owns its numbers (its spectrum, its
current, its knobs, the roughness finer than its trains that it adds to their variance for the
glitter), the rain rings it adds to the slope, what it mirrors and how it keeps the reflected ray
above its horizon, its body colour, foam, sparkle and lights. GLSL code that draws its water more
than one way tests the tier: `#if WATER_TIER >= WATER_MIRROR`.

**Projected size.** Every tier takes `foot` and fades its detail to the area mean once a cell
outgrows it: a ripple train is drawn from `lod.x` to `lod.y` cells per wavelength (7..14 or 8..16)
and below that is only the variance that roughens the mirror; the caustic net fades from 12 to 6
cells, and the cellular net's seams (0.06 of a net cell) from one cell to half a cell, to its area
mean. A train or seam faded out is not worked out at all, so far or small water costs little more
than the flat tier whatever tier the scene selects, and resolved water is bit for bit the
full-detail picture. Pick the tier for what the water shows at its largest: a river a few cells
wide far off takes `ripples`, open water seen close takes `mirror` or `flow`, a pool seen from
above `caustics`.

| Scene      | Tier               | Uses                                                                                                                                             |
| ---------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `aurora`   | ripples            | `windRipples`, `windMirror` on the fjord (`K_ripples`, `K_wind`)                                                                                 |
| `country`  | ripples, else flat | `windRipples` on the river while `K_ripples` is up (`K_wind`): the cat's-paws tilt its reflected ray, their finer ripples jitter it cell by cell |
| `island`   | mirror             | `rippleSpectrum` (a `RippleTable`: four hand-placed trains), `waterMirror`, `waterGlitter` for the sun, the moon and the lantern                 |
| `shore`    | mirror             | `rippleSpectrum` (a `RippleFan`: four trains by the golden angle, scaled by the wind), `waterMirror`, `waterGlitter`                             |
| `swell`    | mirror             | three Gerstner swells of its own and `rippleSpectrum` (a `RippleFan` of chop), `waterMirror`, `waterGlitter` for the moon                        |
| `lake`     | mirror             | `waterGlitter` for the moon's and the cabin window's paths down the black ice; the ice's mirror, bubbles and cracks are its own                  |
| `lanterns` | flow               | `rippleSpectrum` (a `RippleFan`: five trains rocking about the current), `waterDrift` downstream, `waterMirror`                                  |
| `tidepool` | caustics           | `causticRipples`, `waterCaustic` with `ShallowWater`'s focus; seen from above, it mirrors the sky its own way                                    |
| `pond`     | caustics           | two layers of `causticCells` on the floor, carried by the current (`waterDrift`); `waterGlitter` for the sun; its drop rings are its own         |

The rest of the lab's water is still drawn its own way: `falls`, `fireflies`, `bamboo`, `forest`,
`kelp`, `delta`, `ripple`.

#### Clouds

Clouds are one component in tiers too, cheapest first, each including the ones below it: one cloud
deck that the scenes compose rather than each drawing its own. A scene selects the highest tier it
draws, `features: { CLOUD_TIER: CLOUD_TIERS.shadows }` (`CLOUD_TIERS` from `shaders/lib/clouds.ts`);
a scene that selects none gets the lit deck, as every sky had before the tiers, so `skyClouds` needs
no feature. Calling a function of a higher tier fails to compile.

| Tier      | `CLOUD_TIER`      | What the scene gets                                                                                                                                                                                                                                                                 |
| --------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flat`    | `CLOUD_FLAT` 0    | the deck's plane and drift (`cloudDeckPoint`: 0.09 cloud-base heights a second with the wind, creeping 0.01 toward the eye) and the calm deck (`cloudFlatField`: two broad octaves, the finer dropped toward the horizon by `cloudFlatFine`), which the scene thresholds and lights |
| `lit`     | `CLOUD_LIT` 1     | the deck lit by the sky, seen from below: `skyClouds` (domain-warped fbm; the sun on the flanks facing it, silver linings, gold and pink undersides round sunset, moonlight), rgb and coverage                                                                                      |
| `shadows` | `CLOUD_SHADOWS` 2 | its shadow on the ground: `skyCloudShadow`, the deck's cover where the sun's ray from a ground point meets it, as the sky shows it there; with `low`, under a deck rain has brought down to `base / low`, for a scene whose sky shows it by squashing the ray's height by `low`     |
| `volume`  | `CLOUD_VOLUME` 3  | a sea of cumulus tops seen from above, ray-marched: `cloudSeaMarch` (terrain marching, secant steps), `cloudSeaTop` (the relief and the normal), `cloudSeaShadow` (Beer-Lambert light through the domes), `cloudPhase`, `cloudBillow`                                               |

The shared parts own what the cloud is and how light gets through it: the deck's plane and drift,
its fields, the march and the self-shadowing. The scene owns its numbers (cover, height, the
shadow's darkness), its light (the clouds scene's rig of sky samples, the train's moonlit body), how
it greys and lowers the deck under rain, and what stands in front.

**Projected size.** The lit deck's octaves fade to their mean once finer than ~3 cells, the calm
deck drops its finer octave toward the horizon, and the sea's relief fades with the cell's
footprint and is then not worked out at all: far cloud costs little, and resolved cloud is bit for
bit the full-detail picture.

| Scene                                                 | Tier                                                                    | Uses                                                                                                                                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clouds`                                              | volume                                                                  | the sea below the window (`CloudSea`: its drift, `K_cover`, the boil, `K_altitude`'s drop, amplitude 0.45); its thunderheads take `cloudBillow` and `cloudPhase`                         |
| `autumn`                                              | shadows                                                                 | `skyCloudShadow` from its sky's deck, 300 m up, where each pixel's sight line meets the park (`K_shadows`, off by default)                                                               |
| `country`                                             | shadows while its `shadows` knob is on (`featuresFor`), lit while off   | `skyClouds` by day, by night the calm deck (`cloudDeckPoint`, `cloudFlatFine`, `cloudFlatField`) lit by the moon; `skyCloudShadow` with its rain's `low` on every point of the land      |
| `meadow`                                              | shadows while its `shadows` knob is on (`worldFeatures`), lit while off | the world's deck (`worldSky`) under its own overcast tint; its shadows (`worldSunlit`) on the field and the tree line where each ray meets them, the hills 1500 m off and the near grass |
| `shore`                                               | shadows while its `shadows` knob is on (`worldFeatures`), lit while off | the world's deck (`worldSky`) under its rain sky, mirrored (`worldMirrorSky`) in the sea and wet sand; its shadows (`worldSunlit`) on the sand and sea, dimming the sun and its glitter  |
| `dunes`                                               | shadows while its `shadows` knob is on (`worldFeatures`), lit while off | the world's deck (`worldSky`, greyed by `dunesOvercast`; none overhead); its shadows (`worldSunlit`) on the sand and the M, cast from the deck over the eye at rest, aerial or overhead  |
| `bees`                                                | shadows while its `shadows` knob is on (`worldFeatures`), lit while off | the world's deck (`worldSky`) behind the world's painted cumulus; both their shadows (`worldSunlit`) by day on the garden where each ray meets it and on the hills 1200 m off            |
| `train`                                               | flat                                                                    | `cloudDeckPoint` with the train's run under the deck, `cloudFlatField` lit as the night line's own deck                                                                                  |
| `falls`, `frost`, `island`, `lake`, `sill`, `skyward` | lit (none selected)                                                     | `skyClouds` over their own sky, greyed and lowered under rain each its own way                                                                                                           |

**Painted cumulus** (the world's, `WORLD_CUMULUS`, "World layers"): bees' authored lobed towers and
their drifting ground shadows, a picture-book style rather than a deck, are an opt-in part of the
shared world any adopter turns on with its `cumulus` knob (on in bees, off elsewhere). They stand in
front of the deck on the view's tangent plane, sink and grey into it as rain or snow closes it, and
their shadows multiply into `worldSunlit`; they draw on no cloud tier.

Not unified, on purpose:

- `island`'s far cumulus are toon billboards on the horizon, its ground shadows a lattice of puffs
  cut per cell to match them (its dome's deck is the lit tier).
- `delta` is seen from orbit: its puffs and their offset shadows are one top-down field.
- Rain overcasts drawn as a tint or a flat grey sheet over the scene's own sky (`lanterns`,
  `meadow`, `shore`, `sill`, `garden`) have no cloud field to share; the canopy's deck is the canopy
  component's (`canopy.ts`), the giant planet's cloud bands the planet's (`planetClouds`).
- The clouds scene's thunderheads, wisps and contrails are authored towers and passage vapour, not a
  deck. Scenes that lower the lit deck under rain (`falls`, `sill`, `country`) squash the ray
  before `skyClouds` each by their own amount; a shared helper would only rename a `normalize`.

### Weather in the world

Rain and snow belong to the scene: they come from its sky, fall through its depth, stop at its
surfaces and change them. Never paste them over the frame as a flat layer.

- **The sky justifies it.** With `K_rain` (or `K_snow`) on, the sky is overcast: raise the cloud
  cover passed to `skyClouds` to `weatherOvercast(K_rain, K_snow)` (or `K_clouds` where that is
  more), dim the sun and soften its shadows toward a flat grey ambient (`greyed`), and lower and
  darken the sky as the amount grows. Under distant cloud, near the horizon, hang
  `rainShafts(p, uMotionTime, K_rain, K_wind)`, mixing toward the cloud-base grey: faint in steady
  rain, wall-like in a downpour. Drizzle is a light grey haze over a soft sky.
- **Depth.** For each pixel, take the distance z (metres) to the first opaque surface you shade and
  pass `depth = 1.0 - exp(-z / 30.0)`; open sky and the far horizon are 1. Scale a miniature or
  vast scene's distances to metres first. Rain layers sit at z ≈ 1, 2, 4, 8, 16 and 32 m (snow at
  1, 2.2, 4.8, 10.6 and 23 m), and anything farther is `veil` only. Each drop has its own depth,
  so rain disappears behind a near tree and ends where it meets the ground. Near rain is a few
  long, bright, soft streaks. The 4–8 m layers carry the body of the rain. Far rain is hundreds
  of short, faint, slow streaks: a moving texture over the distance and the sky.
- **Colour.** `col = precipOver(col, air, dropLight, p)`: first the veil, `mix(col, air, p.veil)`,
  which already carries the amount, the distance and the gust curtains; then the drops,
  `mix(col, dropLight, p.cover)`. `air` is the scene's grey (rain) or pale (snow) haze, lit by
  lightning flashes and lamp halos. `cover` is calibrated so the mix crosses a dither level: about
  0.6–0.9 for near and mid streaks, down to ~0.3 far, a quarter less in drizzle. Start from it
  unscaled. Some scenes scale it down (bamboo thins its rain, shore its rain and snow, frost and
  country weigh their snow) so the weather never buries the subject, at the risk of faint streaks
  that no longer cross a level: do that only for such a reason, with `p.cover *= ...` before
  `precipOver` (a world adopter: `worldPrecipThinned`) and a comment saying why.
  - **dropLight.** Rain is seen because every drop refracts the bright sky: use about 1.2 × the
    sky's (or the overcast cloud base's) brightness, plus lamp, neon, lightning and low-sun light
    where they shine. Streaks then read as light lines against darker ground, trees and walls, and
    barely against the bright sky itself, as in life. At night keep a small floor (~0.08) so some
    rain still reads.
  - **Near drops.** Out-of-focus near drops (`p.near`) may get a softer, dimmer light: most rain
    scenes dim it by 15–20%, `dropLight * (1.0 - 0.2 * p.near)`.
  - **No reprocessing.** `cover` is already switched per cell against the dither threshold: never
    blur it, add noise to it, or threshold it again.
- **Shelter.** The scene decides where rain cannot be. Pass the depth of the shelter's edge
  instead of the surface behind it: rain stops at the eave line, and the air under an awning or
  inside a room stays dry. Splashes, puddles and wetness drop to nothing under cover. A camera
  behind glass or under an awning has no drops at arm's length: use `p.cover * (1.0 - p.near)`.
- **Wetness.** `uWeather.x` is how wet the world is. The renderer follows `K_rain` on the scene
  clock: soaked within ~10 s of steady rain (faster when heavier), dry ~75 s after. A scene loaded
  in rain is already wet. Use less of it where a surface is sheltered. Apply
  `wetten(albedo, wet, porous)` to every exposed albedo. Scale highlights and mirrored lights by
  `wetGloss(wet, n.y)`, which gives a sheen on walls and leaves and a mirror on flat ground: streets
  stretch lamps into long reflections. On flat ground `rainPuddles(p.xz, wet)` (p in metres)
  marks pools ~1.5–4 m across: ~3% of the ground after drizzle, ~20% in steady rain, ~26% when
  soaked. Make them full mirrors of the sky and lights with `rainRipples` rings while it rains,
  clearly brighter or darker than the ground around them.
- **Splashes and drips.** Hard, upward-facing ground gets `rainSplashes(p.xz, uFallTime, K_rain)` (p in
  metres) times the drop light. A crown is ~5 cells across where a metre spans 25 cells. Fade it
  out where a metre spans fewer than ~15 cells, and don't use it on water, where `rainRipples`
  belongs. Edges (eaves, leaves, branches, sills, rails) get
  `rainDrips(vec2(along, below), uFallTime, max(K_rain, 0.4 * uWeather.x), spacing)`, keeping the spacing
  at least ~15 cells on screen. To drip from a given tip, lane k drips at
  `(k + 0.3 + 0.4 * hash12(vec2(k, 3.7))) * spacing`.
- **Snow.** `snowFall` works like `rainFall`, from a flurry to a blizzard whiteout; its veil mixes
  toward the snow-lit air. `uWeather.y` is how much snow lies: it settles within ~10–20 s of
  steady snow, faster in a blizzard, and melts over ~90 s, faster in rain. Mix every exposed
  upward-facing surface (roofs, ledges, branches, stones, ground) toward lit snow white by
  `snowCover(n, p.xz, uWeather.y)`, so the land turns white.
- **A tilted camera.** `rainFall` and `snowFall` assume a level camera, paths straight down the
  frame. A camera pitched up or down passes the vanishing point of the fall instead:
  `rainFallSeen` / `snowFallSeen` with `rainVanish(rainFallDir(...))` / `rainVanish(snowFallDir(...))`
  and the camera's own axes, so rain and snow agree (tidepool for rain; skyward looking up, and
  street from a window and island from above looking down, for both, each through one vanishing
  helper of its own, `streetVanish` and `islVanish`; dunes from overhead through the world's
  `worldPrecipSeen`).
- **Intensity.** Amount 0.1 is drizzle (slow faint streaks, mostly veil), 0.4 steady rain, 0.7
  heavy rain with near drops and gust sheets, and 1.0 a downpour: dense sheets sweeping with the
  wind, loud splashes, and visibility falling. Let the sky, the light, the wetness and the splashes
  follow the same scale.
- **Fog.** Fog lies in the scene's air: reckon it along the ray to the first surface (and to the
  far ridges and the horizon's sky, so the land's fog and the sky's meet), thickest where cold air
  pools, and fade what lies behind it toward the fog's own light. Most scenes blend per pixel with
  `fogAmount(K_fog, distance, height)` (above): the distance's share of the far field and the
  height of the point seen over the ground or water, 0 at the bottom of the layer (pass it that way
  round: a 1 there is the layer's thin top). A scene that knows its land integrates instead: the
  countryside's valley fog (`country/fog.ts`) is a bank on the river's level down the valley with
  a mist thinning over it, both integrated in closed form along the straight ray (the bank's soft
  top through its softplus), so the valley whitens while the ridges, trees and roofs rise out of
  it; it burns off by day, glows toward a low sun and dims the lit windows in it.
- **The climate.** Where a scene keeps a season (a knob tagged as the almanac's `season` part,
  `SeasonYear`) and can snow (it has a `snow` knob), the season sets the climate
  (`src/climate.ts`). `SKY_YEAR` is the scene's year position, generated from the season knob's
  tag (0 the start of spring .. 0.75 of winter, wrapping; -1.0 without a season), and
  `climateCold(SKY_YEAR)` how cold it is: 0 from mid-spring to mid-autumn, 1 at midwinter, half at
  the turns of winter. Fall what the cold makes of the knobs, `vec2 f = climatePrecip(K_rain,
K_snow, cold)` (x rain, y snow): the cold's share of the rain falls as snow, and the snow switch
  falls whatever the season, an override the lab marks as out of season. The renderer follows the
  same: `uWeather` wets and settles from what falls, and deep winter lays snow of its own
  (`climateLying(cold)`) into `uWeather.y`, so a winter scene is white without a snowfall. Draw
  winter's lying snow only from `uWeather.y`, never from the season knob directly, so every scene's
  winter agrees.
- **A year that passes.** A scene whose time of year runs on (`bonsai`, `country`) takes a range
  over the whole year, tagged `{ kind: "sky", part: "season", year: { span: [0, 1] } }`, and the
  year's cycle, a feature `year` ("the year passes", its amount minutes per season) tagged
  `{ kind: "sky", part: "year" }`. `SKY_YEAR` carries the date round on `uMotionTime`; a sim
  follows with `yearNow(yearAt(def, k), minutes, frame.motionTime)`. Keep the year continuous. A
  state the scene must stand at exactly on some dates (the countryside's old seasons,
  `COUNTRY_SEASONS` in `country/season.ts`) is a key, eased to the next strictly between them, so
  that at a key every value is computed as it was (a weight of exactly 0 or 1 there: `countryKeys`,
  `countryBlend`). What changes field by field or tree by tree does so on dates of its own (a
  hash): a machine's work as a front across the field, growth in patches, leaves turning and
  falling crown by crown, so the year never turns at once. A moment of the year (the countryside's
  round bales) is a compile-time feature keyed on the date's window, on at any date while the year
  passes; so is a snowfall the climate can make of the rain (`climateCold`, `climatePrecip` in
  `featuresFor`). `countryYear` (`country/year.verify.ts`) checks the countryside's: the passing
  year draws as the date it reaches, midwinter's rain as its snow, winter's lying snow only from
  `uWeather.y`, bare broadleaves and evergreen pines, spring's rapeseed and may, and no step of the
  date that turns the land at once.
- **The cold.** One model of the year's cold (`src/climate.ts`), read two ways off the year's
  distance from midwinter: `climateChill(year)`, a cosine from 0 at midsummer to 1 at midwinter, for
  light and colour that follow the season smoothly (bonsai's lower, cooler winter light), and
  `climateCold(year)`, nil from mid-spring to mid-autumn and full round midwinter, rising wherever
  the chill does, for what falls and lies (bonsai's snow, too, melts slowly only while it would lie).
  Write no cold curve of your own.

### The world clock

One model of where the sky stands, `src/world-clock.ts`: TypeScript for the sims and the lab
(`skyNow`, `skyState`, `timeOfDay`), its GLSL mirror `worldClockGlsl` compiled into every program
by the sky library (`skyAt`, `skyAtWorld`, `skyMoonPhase`, `skyStarFrame`), checked against each
other on the GPU by `worldClock` (`src/world-clock.verify.ts`). A sim or a lab part that needs the
hour, the daylight or the night reads `skyNow` (forest's spirits, the garden's drying, the lab's
"See it at night" and its sky dial); never write a day curve of your own.

- **Staged by default.** The sky is a low-latitude one (15 degrees) facing the equator, the pole
  low behind the viewer: a winter sun's arc (-28 degrees) in front, the K_time warp keeping sunrise
  at .25 and sunset at .75. Every undated scene draws exactly that sky on any date.
- **Dated skies.** A scene whose season sets its climate (`hasClimate`: country, garden) gets
  `SKY_DATE_ANCHOR`, its default date (`skyAnchor`): there its sky is the staged one, and as the
  date moves the sun's declination moves as Earth's does (23.44 degrees either side), the warp
  following its sunrise hour angle so sunrise stays at .25, the staged full moon swinging the other
  way. The sky reads the date in ten-thousandths of a year, so a date the passing year reaches draws
  as the same date set.
- **The moon by its phase.** K_moon 1 is the staged full moon every default draws. A lesser phase
  stands `acos(1 - 2 phase)` from the sun, eastward along its daily circle: its lit share its
  elongation's. A crescent hangs over the sunset, a half moon a quarter of the sky east of the sun.
  The staged full moon stands ~105 degrees from the sun, not opposite it, so from 0.9
  (`MOON_STAGED_FROM`) the moon moves off its elongation onto it (`moonStaging`): its place runs on
  with its phase, never jumping as it reaches full.
- **The stars turn.** With the day cycle on the stars, the constellations and the world's Milky Way
  turn about the pole a sidereal day's turn a day (`sky.starTurn`; look anything fixed among the
  stars up at `skyStarFrame(sky, dir)`); in a dated sky they turn once more a year as the date
  moves. Still, they stand as staged. The planets (`skyGiant`) and the aurora stay staged objects.
- **Haze takes on the dome, not the discs.** `horizonHaze` is `skyDome`: the sun's aureole
  brightens far haze toward it, but no disc paints a bar into distant land.
- **Overcast reaches the horizon.** `skyClouds` fades its deck toward the horizon against crawl;
  past broken cloud (cover 0.6) that fade gives way, and an overcast (1) closes right down to it.

**Stage 2: one sky composer.** Seven outdoor scenes still compose the sky stack `worldSky` owns by
hand, each in its own order: autumn, frost, sill, lanterns, falls, lake and skyward (bees has moved
onto the world, its painted cumulus becoming the world's). The plan is to move them onto the shared
world sky one at a time, each with a bit-diff review of its picture:

1. Frost and sill first: their stacks (dome, stars, aurora, deck, meteors) are closest to
   `worldSky`. Each adopts `worldAt` and `worldSky` (or `worldMirrorSky`), keeping the components
   the table in "Composing components" marks as its own, and drops its `*_METEOR_TRIGGER` wiring
   and private overcast curve for `weatherOvercast` and the `WORLD_DECK_*` shares.
2. Then autumn, falls and skyward, whose differences are a yaw, a cover curve and a deck squash;
   `worldView`'s yaw and unit carry the first, the rest become World fields where two scenes need
   them.
3. Lake and lanterns last, after their private moons and star fields go (the shared moon now
   stands where a crescent reads, beside the dusk): they adopt `skyMoonPhase` and `skyStars`.

The sky state stays the world clock's throughout, so adopting the composer changes only the order
and occlusion of the layers; each scene's default picture changes and is reviewed as it moves. A
later step may upload the clock's per-frame values as uniforms once its GPU mirror has shown the
float32 results agree cell for cell.

### World layers

One world for every outdoor scene: the sky, its weather and what flies in it come from one state,
read from one set of knobs and composed in one order, so the scenes differ only by their camera and
what they put in the world. A setting means the same thing everywhere: rain 0.4 closes the sky as
far, dims the sun as much and falls at the same depths in every scene that adopts it. The GLSL is
`worldGlsl` (`src/shaders/lib/world.ts`, opt-in; it composes `birdsGlsl` and `milkyWayGlsl` itself,
so an adopter does not include them again), the knobs and gates `src/scenes/world.ts`. The adopters
are meadow (the first), shore, dunes and bees.

```glsl
struct World {        // the world now: worldAt, once per pixel, before anything is drawn
  Sky sky;            // clock, sun, moon in its phase; light under the deck (+ aurora glow, lightning flash)
  float time, tm, tf; // time of day 0..1, the motion clock, the fall clock
  float rain, snow, fog, wind;           // the knobs (0 while off or gated out)
  float storm, overcast, heavy, cover;   // max(rain, 0.85 snow); weatherOvercast; heavy rain/snow; K_clouds thickened
  vec3 glow;          // the aurora's light on the land (in sky.ambient)
  float flash, boltAge, boltSeed, meteorAge, meteorSeed;
  float seed;         // the scene's seed for the world's own scenery (the cumulus): 0 from worldAt
};
World worldAt(int meteorSlot, int lightningSlot);
struct WorldView {    // the scene's camera at this pixel: a level pinhole with a shifted lens, or its own ray on it
  vec3 ray, dir;      // viewRay's frame (x right, y up, z ahead); the sky's frame, skyFacing(ray, yaw)
  float yaw;          // camera frame -> sky frame
  vec2 uv;            // the screen point, after any lens shift the scene gives its world
  float aspect, foot; // uRes.x / uRes.y; radians a dither cell spans, 1 / (focal * uRes.y)
  float horizon, focal, eye, unit; // the pinhole (eye in scene units) and scene units per metre
};
WorldView worldView(vec2 uv, float horizon, float focal, float eye, float yaw, float unit);
WorldView worldViewOf(vec3 ray, vec2 uv, float horizon, float focal, float eye, float yaw, float unit); // the scene's own ray
struct WorldSky { vec3 col; vec3 strike; float cloud; };      // cloud: the deck's and the cumulus' alpha
WorldSky worldSky(World w, WorldView v, vec4 meteorField);   // behind everything
float worldSunlit(World w, WorldView v, vec3 at);             // the deck's and the cumulus' shadows: multiply the sun by it
struct WorldFlyway { vec2 depths; vec2 band; vec2 seed; float swoopTo; float enlarge; };
void worldBirds(World w, WorldView v, WorldFlyway f, vec3 haze, float thick, inout vec3 col, inout float z, inout float accent);
void worldFog(World w, WorldView v, vec3 fogCol, float z, inout vec3 col, inout float accent);
void worldPrecip(World w, WorldView v, vec3 air, vec3 dropLight, float z, inout vec3 col, inout float accent);
void worldPrecipSeen(World w, WorldView v, vec3 right, vec3 up, vec3 fwd, vec3 air, vec3 dropLight, float z, inout vec3 col, inout float accent); // a tilted camera
void worldPrecipThinned(World w, WorldView v, vec3 air, vec3 dropLight, float z, vec2 thin, inout vec3 col, inout float accent); // fewer drops and flakes
void worldOver(World w, WorldView v, WorldFlyway f, vec3 haze, float thick, vec3 air, vec3 dropLight, inout vec3 col, inout float z, inout float accent);
WorldView worldMirrorView(WorldView v, vec3 ray, float blur);  // a level mirror at the ground: water, a wet film
WorldSky worldMirrorSky(World w, WorldView m, vec4 meteorField);
void worldBirdsMirrored(World w, WorldView m, WorldFlyway f, vec3 haze, float thick, float still, inout vec3 col);
const float WORLD_FAR;  // 1e4: the distance of open sky
```

- **The world** (`worldAt`). The clock is `timeOfDayM(K_time, K_cycle, uMotionTime)`, the moon takes
  `K_moon` (under `SKY_MOON_PHASE`). Rain and snow close the sky by `weatherOvercast`; the deck's
  cover is `max(K_clouds, overcast)`; `heavy` is `smoothstep(0.35, 0.9, storm)`. Under the deck the
  sun's light fades by 0.88 × overcast, the ambient greys by 0.6 × overcast and darkens by
  0.3 × storm, the twilight fades by 0.7 × overcast; the aurora's glow (behind the deck) and the
  lightning's flash light are added to the ambient. With no weather, `w.sky` is the clear sky
  exactly. Light the scene with `w.sky`; dim or tint it further as the scene needs.
- **The view** (`worldView`, or fill the struct). `ray` is the camera's ray in the shared side-on
  frame, `dir` the same ray in the sky's frame (`yaw`: the turn that takes one to the other), `foot`
  the level of detail for the stars, the aurora and shooting stars. Distances handed to the world
  (`z`) are in the scene's units, `WORLD_FAR` for open sky; `unit` turns metres into them, as
  `BirdCamera.unit` does: rain and snow fall at `weatherDepth(z / unit)`, fog reckons in metres,
  and the deck's shadows are cast from 1000 m up.
- **The order.** `worldSky` first, behind everything: the dome (sun and moon discs), the aurora
  ahead of the camera behind the clouds, the cloud deck, the painted cumulus in front of it, the
  Milky Way and the stars in their gaps, shooting stars (from `meteorField`, `skyAngles` of the
  camera's ray), then the lightning, kept apart in `strike` (the bolt from a cloud base ~12° up to
  the horizon, the flash's glow) so a scene that tints its sky draws `tint(col) + strike`; `cloud`
  is the deck's and the cumulus' alpha along the ray. Then the scene's distance, land and near
  things, keeping `z`, the distance to the first opaque thing in its cell. Then `worldBirds` where a
  bird is nearer than `z` (it takes the cell and `z`), lit by the sky and hazed by
  `exp(-depth * thick)` into the scene's `haze`; anything the scene draws nearer than the birds
  after them; then `worldFog` to `z` and `worldPrecip` to `z` (rain toward the scene's `air` and
  `dropLight`, snow in the sky's and the sun's light), each fading the accent under its veil.
  `worldOver` does the last three at once for a scene with nothing in between.
- **The painted cumulus** (`K_cumulus`, `WORLD_CUMULUS`; bees' picture-book towers, on in bees,
  off by default elsewhere). Six towers of authored ellipse lobes, jittered by their own seed and
  `w.seed` (0 from `worldAt`; bees sets its landscape seed), lit from the outline's normal mixed
  with the mass's facing: the sunward side and the crown cream, the shaded side and the flat base
  blue-grey off the sky high up, a glowing sunward rim, the moon's side silvered. They stand on the
  view's tangent plane (the camera ray's x / z and y / z, so the same angular size in any adopter):
  across a share of the view's half-width at the horizon (at least 0.62), their bases 0.13–0.26 over
  the horizon, in the sky turned by the view's `yaw`; they drift with the wind (0.0035 a second at
  the default wind 0.2), wrapping round a span 1.7 wider than the view, in from the sides as the
  scene arrives (`passageIn`) and on as it leaves; the amount sizes the four big ones (0.65–1.08×)
  and below 0.2 the second last stays away. In fair weather they stand in front of the deck; as
  rain or snow closes it (`w.overcast`) they flatten (to 1 − 0.6 × overcast of their height), sink
  toward the horizon (by 0.5 × overcast) and grey into the deck behind them, gone once it has
  closed. Their shadows join `worldSunlit` (times 1 − 0.72 in shadow): a field painted over the land
  as the eye sees it, as the towers are (a point's x and y over its distance ahead, no steeper than
  45° down), drifting with the wind and fading as the towers sink. They come with the towers,
  whatever `shadows` says (that knob is the deck's).
- **Other cameras.** `worldViewOf` is `worldView` along a ray the scene gives (its camera's frame,
  unit length), for rays bent or turned off the pinhole's own (heat shimmer, a pointer's parallax):
  the sky, the aurora and shooting stars follow the ray; the bolt, the birds, the rain and the snow
  keep to the pinhole's screen at `uv`. A camera that is not level draws the rain and snow with
  `worldPrecipSeen`, given its axes (`right`, `up`, `fwd`) in the frame of a level camera facing the
  same way (x right, along the wind; y up; z ahead): the paths meet where this camera sees the fall
  converge (`rainFallSeen`, `snowFallSeen` through `rainVanish` at the view's focal), below the eye
  looking down, overhead looking up. Level axes draw `worldPrecip`'s picture.
- **Mirrors.** A level mirror at the ground (still water, the sea, a film of water on sand or a
  road) shows the world along the ray it reflects. `worldMirrorView(v, ray, blur)` is that view:
  `ray` in the camera's frame, tilted by the scene's own waves or ripples; its screen point where
  that ray meets the screen (a level mirror's cell below the horizon looks up as far above it); its
  footprint widened by `blur`, the radians the mirror's roughness spreads its image over (0 still).
  `worldMirrorSky` is what the mirror shows there, in `worldSky`'s order: the dome with the moon
  swung behind the viewer (`skyMirror`: draw the moon's path on the water as glitter), the aurora,
  the deck lit by the true moon and the cumulus in front of it, the Milky Way and the stars,
  shooting stars, all at the mirror's
  footprint (a rough one fades the stars to their glow and dims a streak); in `strike`, the bolt
  where the mirror's lookup meets it, as dim, and the flash's glow. `worldBirdsMirrored` lays the
  birds' image over it (`birdFlightsSeen`, mirrored), taking `still`'s share (0..1, how still the
  mirror is). The scene mixes the image into its surface by its own Fresnel and draws the sun's and
  the moon's glitter itself.
- **Thinned drops.** `worldPrecipThinned` is `worldPrecip` with the drops' and flakes' cover scaled
  from `thin.x` far to `thin.y` nearest; the veil and the depths stay the world's. Only for a scene
  whose subject the weather would bury, saying why where it calls it ("Weather in the world").
- **Gating.** `worldFeatures(values)` gives each part's gate, 0 or 1, on wherever its knobs can show
  it; `WORLD_ALL` has them all on. Merge them into the scene's `featuresFor` and `featuresAll`. Each
  part keeps its runtime test of its knob inside the gate, so with a knob off it returns its neutral
  value exactly, compiled in or not (`featuresAll` draws every setting byte for byte as its own
  program). The night's parts compile in only where night can fall (the day cycle on, or the hour
  before sunrise or after sunset: between them the sky's `night` is exactly 0), the birds only
  within their hours.

  | Gate              | On while                                                           | Off: the part gives                  |
  | ----------------- | ------------------------------------------------------------------ | ------------------------------------ |
  | `WORLD_STARS`     | `stars` > 0, night can fall                                        | no stars or constellations           |
  | `WORLD_MILKYWAY`  | `milkyWay` and `stars` > 0, night can fall                         | no band; the stars exactly `K_stars` |
  | `WORLD_METEORS`   | night can fall (its "now" shows one while the knob is off)         | no shooting stars                    |
  | `WORLD_AURORA`    | `aurora` on, night can fall                                        | no curtains, no glow                 |
  | `WORLD_CLOUDS`    | `clouds` > 0, or rain or snow on                                   | cover 0, `cloud` 0                   |
  | `WORLD_SHADOWS`   | `shadows` on and `WORLD_CLOUDS` (with `CLOUD_TIER` at shadows)     | `worldSunlit` 1                      |
  | `WORLD_CUMULUS`   | `cumulus` on                                                       | no towers, no shadows of theirs      |
  | `WORLD_BIRDS`     | `birds` on, the day cycle on or the hour within `WORLD_BIRD_HOURS` | no bird; `z` and the cell unchanged  |
  | `WORLD_RAIN`      | `rain` on                                                          | rain 0, no drops                     |
  | `WORLD_SNOW`      | `snow` on                                                          | snow 0, no flakes                    |
  | `WORLD_FOG`       | `fog` > 0                                                          | no fog                               |
  | `WORLD_LIGHTNING` | always (its "now" strikes while the knob is off)                   | no strike, flash 0                   |
  | `SKY_MOON_PHASE`  | the moon off or short of full (left out, not 0, otherwise)         | the full moon of `skyColor`          |

- **Knobs and defaults** (`worldKnobs(options)`, with `worldGroups` for the headings). The shared
  builders' own keys, labels and help: `time`, `cycle`, `stars`, `milkyWay`, `moon`, `meteors`,
  `constellations` (`skyKnobs`; the scene's planets are `SceneDef.planets`);
  `clouds`, `cumulus` (the world's own: the painted towers, their size), `shadows`, `rain`, `snow`,
  `fog`, `lightning`, `aurora`, then `wind` (`weatherKnobs`, wind in `groups.wind` if given);
  `birds`, `birdKind`, `birdFormation` (`birdKnobs`). The scene gives its hour (`time`), its trigger
  slots (`meteors.trigger`, `lightning`) and its birds (`kind`, `help`), and may change any default.
  The defaults are an ambient world (`WORLD_DEFAULTS`): fair-weather cloud 0.25, stars 0.6, the moon
  full, the Milky Way on at 1 (it shows on dark nights: moonlight washes it out), birds on at 0.35 by
  day; the painted cumulus (size 0.55 once on), shooting stars, the constellations, cloud shadows,
  rain, snow, fog, lightning and the aurora off; wind 0.2.

**Adopting it** (meadow, `meadow/index.ts` and `meadow/shader.ts`):

```ts
...worldKnobs({
  time: 0.72,
  clouds: 0.2, // its own fair-weather cover
  meteors: { trigger: MEADOW_METEOR_TRIGGER },
  lightning: MEADOW_LIGHTNING_TRIGGER,
  birds: { kind: "swallows", help: "..." },
  groups: { wind: "wind" },
}),
// in the SceneDef:
groups: { sky: worldGroups.sky, birds: worldGroups.birds, ... },
featuresFor: (values) => ({ ...worldFeatures(values), MEADOW_HAS_WILDFLOWERS: ... }),
featuresAll: { ...WORLD_ALL, MEADOW_HAS_WILDFLOWERS: 1 },
```

```glsl
${worldGlsl}   // at the top of the scene's GLSL
// ... in the entry:
World world = worldAt(MEADOW_METEOR_SLOT, MEADOW_LIGHTNING_SLOT);
WorldView view = worldView(uv, MEADOW_HORIZON, MEADOW_FOCAL, eye, MEADOW_TURN, 1.0);  // metres
vec3 sun = world.sky.sunColor * worldSunlit(world, view, groundPoint);
float zHit = WORLD_FAR;
WorldSky heaven = worldSky(world, view, MEADOW_METEOR_FIELD);
col = meadowDeck(heaven.col, above, world.overcast, world.storm) + heaven.strike;
// ... the hills, the trees, the sea of grass (zHit: the depth of what the cell sees)
worldBirds(world, view, WorldFlyway(vec2(12.0, 100.0), band, seed, 1.6, 1.5), haze, thick, col, zHit, accent);
// ... the wildflowers, the near grass, the clocks and the seeds, over the birds
worldFog(world, view, air, zHit, col, accent);
worldPrecip(world, view, air, dropLight, zHit, col, accent);
```

A scene provides: its camera (a level pinhole: horizon, focal, eye height, the yaw from its frame
to the sky's, its units per metre; its own ray through `worldViewOf`, and its axes for
`worldPrecipSeen` where it tilts), the distance to the first opaque thing in each cell, its trigger
slots and meteor field, where its birds fly (`WorldFlyway`), its haze and aerial thickness, its rain
air and drop light, the ground points it wants the deck's shadows at, its mirror's ray and
roughness (`worldMirrorView`) and Fresnel, and what it does with the light (`w.sky`, `w.flash`) and
the weather (`uWeather` on its surfaces).

**What stays the scene's.**

- Meadow keeps its overcast tint over the world's deck (`meadowDeck`), its hills, tree line and
  mown M, its rain shafts and gust curtains and the rain's mist over the distance (all inside
  `WORLD_RAIN`), its golden haze, its wet grass and the snow lying on its grass, hills and trees
  (read from `uWeather`, compiled in always, so they dry and melt after the knob is off), its drop
  light, and the ground points of the deck's shadows (the field and the tree line where each ray
  meets them, the hills 1500 m off, the near grass at the eye's feet).
- Shore keeps its storm bank out at sea and the bolts it drops (on the world's strike timing and
  flash; it leaves out `strike`, whose bolt falls from ~12° up, outside the bank) with their image
  in the sea; its rain sky over the world's deck (the grey haze, the light gap on the horizon, the
  rain shafts); its thinned drops (`worldPrecipThinned`, 0.55 far to 0.35 near, so they never bury
  the surf); and the moon's phase compiled in at every setting (`features: { SKY_MOON_PHASE: 1 }`:
  the glitter magnifies the last bits of the moon's direction that the phase code shifts, so a full
  moon's own program would not draw byte for byte as the all-features one).
- Dunes' fog is the desert's dust: the shared `fog` knob drives its own haze (with a hard wind, the
  sandstorm) and it never calls `worldFog`, whose fog assumes an eye near the ground (dunes' eye
  flies ~80 m up, looking 1–4 km out). A grid cell is 5 m (`DUNES_UNIT`, 0.2 cells per metre);
  its view is `worldViewOf` along the ray the heat shimmer bends and the pointer turns; a sandstorm
  raises its copy of the world's overcast before `worldSky`, so the aurora and shooting stars fade
  behind the dust. Overhead it takes the world's light, cloud shadows (cast from the deck over the
  eye at rest), dust, rain and snow, but no sky, clouds, stars, Milky Way, meteors, bolts or birds;
  its rain and snow fall as a camera pitched ~50° down sees them (`worldPrecipSeen`,
  `DUNES_OVERHEAD_PITCH`): straight down, their paths would meet at the frame's middle, where
  `rainFallSeen` cannot tell them apart.
- Bees keeps its warm tint of the world's light (the sun's and the sky's, `BEES_SUN_TINT`,
  `BEES_SKY_TINT`), the moon as its key once the sun has set (`BEES_MOONLIGHT`: the orchard and
  hives throw their shadows by it, and the world's cloud shadows fall only by day), its haze into the
  hills (greyed under the deck) and the hills' distances (500, 1200 and 2500 m) for the weather; the
  points it asks `worldSunlit` for (where each cell's ray meets the garden, and the hills 1200 m
  off), the darker of that and an orchard tree's or a hive's shadow taking the sun; its wet garden
  (`wetten` on every albedo, the lawn's and the things' sheen of the low sky by `wetGloss`) and the
  snow lying on the lawn and the path, the hills' fields, the lavender, the wall's top, the hives'
  roofs and the crowns, read from `uWeather` and compiled in always; its swallows' lanes (8–150 m
  out, over the hills, swooping to 1.2 m), which hide the insects behind them; and the moon's phase
  compiled in at every setting (`features: { SKY_MOON_PHASE: 1 }`), since the moon keys its night
  light and shadows, as shore's glitter does. Its seed (`K_scenerySeed`) re-seeds the world's
  cumulus (`w.seed`).

Not in the world yet: views from straight above (the world's sky and birds are drawn for a level
camera, so dunes' overhead view has neither); a scene that needs them keeps its own for those parts.

## Simulations (`sim`)

When a scene needs state (particles, a height field, ink, a growing crystal, the pointer's wake),
give it a `sim: (gl) => SceneSim`. Each frame the renderer calls `frame(SimFrame)` (dt, time,
motionTime, motion, now, budget, size, knob values, raw params, triggers, fired, pointer, parallax,
passage) and binds the returned textures as `uSim0..uSim3` (`uSimOn` says which are set).
`parallax` is the shader's `uPointer`: a sim casting the pointer through a camera the shader turns
with it turns it too. Simulation catch-up is capped at 0.1 s per frame; the FPS footer measures
uncapped frame delivery. Wall time comes from the frame, never from `performance.now()`: `now` is
the frame's timestamp (ms) for debounces, upload rates and the time between frames, and `budget`
the milliseconds budgeted work (a warm-up, a build, a paint) may block this frame, handed to
`runBudgeted` (a scene may raise it for a first build); HeadlessSim gives its own clock and an
Infinity budget, so a test's warm-up ends in its first frame. Step motion on a `FixedStep`
(`clock.ts`) at a fixed h, with each step sampling its clock at its own moment, and draw between
the last two steps by its `alpha` (a GPU solver's fields through `FieldBetween`, `between.ts`), so
a seed plays the same at 60 and 144 Hz.
A sim with more to hand over than four slots packs it into one texture read with `texelFetch`
(which no filter touches), a linear filter left for the one field read with `texture`: bonsai's
field rows under its tables, the countryside's records atlas (`country/atlas.ts`: the terrain's
records, the murmuration's density field beside them and the verges' plants above, each part only
while it is on).
Reseeding a stateful scene must reset its associated interaction history as well as its geometry:
Frost starts a fresh pane with no old warmth, melt mask, finger stroke, or active mark trace, even
when the seed changes while paused.

Read knobs through a `KnobReader` (`src/params.ts`): `new KnobReader("<scene>", params, keys)`
throws a KnobError at once for a missing key; then `value(frame, key)` is the knob as the shader
sees it, `amount(frame, key)` a feature's amount even while it is off, `on(frame, key)` whether a
feature is switched on (for one whose amount may be 0 while on), `initial(key)` its default
(for constructors), `pick(frame, key, list, fallback)` a choice's item, and `trigger(key)` its
trigger slot. `frame.fired[slot]` is true on the one frame after a "now" press stamped that slot:
several presses between two frames give one edge, a sim's first frame gives none, and re-entering
a scene builds a fresh sim that never replays an old press. Sims keep no copy of the stamps.

Helpers in `src/sims/` (each file's header has the full API and a usage example):

- `DataTexture` (`texture.ts`): r8/rg8/rgba8/r16f/rg16f/rgba16f from typed arrays (rows bottom to
  top), whole (`upload`) or only the rectangle that changed (`uploadRegion(data, x, y, w, h)`, read
  in place from the whole array: the harmonograph's ink, the Chladni plate's sand), or
  `uploadImage(canvas)` for an rgba8 texture drawn with Canvas 2D (top row = uv.y 1).
- `TrailField` (`trail.ts`): where the pointer has been, fading; for stirring and melting.
- `VerletSystem` and `PointTexture` (`verlet.ts`): 3D XPBD chains, nets and orb webs (compliance
  in physical units, so a thread is as stiff at any substep; an undamped swing keeps its energy),
  with impulses and nearest-point queries, stepped by the caller's FixedStep and packed into a
  texture for `texelFetch` (kelp, dew, the mobile).
- `springStep` (`spring.ts`): the damped spring every sim eases a swinging value with (plants,
  meadow, bamboo, the fireflies' lantern, ferro's pool and spikes, the prism let go, the sand
  table's ball), one step on a fixed h.
- `HeightField` (`heightfield.ts`): stamps, grooves and rakes with side ridges, angle-of-repose
  slumping, smoothing, upload to r16f (garden, sand table).
- `marchHeight` and `sampleRepeat` (`heightray.ts`): a ray against a height field on the CPU with a
  shader's own march numbers, so a click lands on the ground drawn under the pointer (dunes).
- `AgeField` and `dryingPace` (`agefield.ts`): when each spot was last disturbed, on a clock the
  scene drives (a drying clock that hurries in sun and wind, stops in rain), for r16f (garden).
- `grainAt`, `FINE_SAND`, `SAND` and `GRIT` (`granular.ts`): grains of one size between fine sand,
  the dry sand the scenes were tuned on and grit, for a grain-size knob: diameter, angle of repose
  (`talus`), the grip a shaken surface must overcome and its spread, the hop and the pace (chladni).
- `materialAt` (`material.ts`): the convention for a material knob, a 0..1 `range` moving a
  substance between named materials, 0.5 the reference bit for bit and each property moving
  geometrically between the ends (lava's wax body; `granular.ts` follows it).
- `GpuCompute` (`gpu.ts`): float render targets, ping-pong grids, fullscreen passes and point
  scatters for GPU simulations (petri, physarum, delta). `create` returns undefined without float
  render targets: the scene must then draw a still picture instead. It leaves the GL state the
  renderer expects (framebuffer unbound, blending off, the renderer's vertex array bound).
- `FluidSim` (`fluid.ts`): 2D stable fluids on `GpuCompute`, incompressible at every scale (a
  warm-started multigrid pressure solve), with MacCormack dye, vorticity, walls, a GLSL force
  snippet, an obstacle SDF, splats and `advect` for extra fields (incense, film, pearl).
- `FieldBetween` (`between.ts`): a GPU solver's field drawn between its last two steps, as a CPU
  sim draws by `FixedStep.alpha`: `keep` copies the field before a frame's last step and `show`
  mixes the copy and the field by `alpha` into a texture for the shader (incense's smoke and its
  velocity, pearl's flakes and dye).
- `ArrivalField` (`front.ts`): when a front spreading from one point through a field of speeds
  reaches each texel, on the GPU (least time along rays from the source, then a few relaxing
  sweeps), so `T <= t` is where it has been: film's burst rim racing through thin film and crawling
  through thick.
- `ShallowWater` and `stillWater` (`shallow.ts`): shallow water over a bed on `GpuCompute` (a
  well-balanced finite volume scheme: HLL fluxes over a hydrostatic reconstruction, outflows limited
  to what a cell holds) that runs downhill, sloshes, shoals and breaks, its bores at their true speed
  and depth; driven by a GLSL forcing snippet (a sea, a wave maker) and a source snippet (a river's
  stage, a held sea, evaporation), over its own bed or the caller's (a bed the delta erodes),
  carrying the scene's tracers (foam, wetness) through a carry snippet, with splats and a `surface`
  texture of depth, slope and caustic focus for the shader (tidepool, delta); `stillWater` opens a
  layout settled, every pool full to its spill point (tidepool); its `LevelHeap` (cells by level)
  serves other priority floods.
- `TerrainBuilder`, `generateTerrain`, `packTerrain` (`terrain.ts`) and `terrainGlsl`
  (`shaders/lib/terrain.ts`): a whole landscape on one square map (metres, deterministic per seed),
  built in units a frame's budget spreads (`runBudgeted`): a valley laid across a vantage's view in
  fractal and ridged value noise, carved by implicit stream-power erosion over a priority-flood
  drainage with multiple-flow areas and slumped to the angle of repose (`HeightField.relax`); the
  main river traced down the drainage tree, given meanders and a width from its catchment, its level
  never rising downstream and level across its bed, banks and a floodplain; streams; settlements
  scored for flatness, water, distance and a line of sight (`marchHeight`) on the land before the
  river is carved and against its course, so the river's size moves none; roads as least-cost paths
  (A\*, 16 directions) over a spanning tree of them with a shortcut and a way out, one bridge at the
  narrowest crossing, each road's profile cut and fill under `TERRAIN_ROAD_MAX_SLOPE` and its bed cut
  into the ground; buildings on terraces along the roads; woodland suitability; field parcels
  (those in the water dropped, each drawing from hashes of its place) stretched along the contours
  or roads, each with its clear core (the widest disc clear of its border, water, roads, streams,
  yards and lone trees: a herd's ground); lone trees on hedges and banks; the roads resampled
  evenly for walkers and carts (`terrainWays`). `packTerrain` lays it into four textures (ground
  and water level with slopes; road and stream signed distances, woodland, yards; the nearest two
  parcels, the first's high byte keeping a bit for the land model's pine flag; records of sites,
  buildings, settlements, the bridge, the eye, cores, ways and way points), which `terrainGlsl`
  reads: `terrainGround`, `terrainCover`, `terrainParcel` (exact field borders between texels, and
  the neighbour's id), `terrainCore`, `terrainBuilding`, `terrainPlace`, `terrainBridge`,
  `terrainEye`, `terrainWay` and `terrainWayAt` (a point by arc length along a road, always on it)
  (country); `LandModel` and `packLand` (`landuse.ts`): every parcel's one use from relative
  shares, priced so that a share's change converts only that use's marginal parcels, written into
  the records, the woods' canopy and their species (`LAND_PINE_FLAG`); `repackLand` rewrites only
  what a new allocation moves and reports the rows of each texture it changed (country).
- `grayScottRegimes`, `grayScottAlong` and `grayScottGlsl` (`grayscott.ts`): Gray–Scott
  reaction–diffusion's curated Pearson classes (feed, kill, what grows), an eased loop through them,
  and the reaction step for a `GpuCompute` pass (petri). Seed a dish at the first regime's levels
  and ease it over: most classes starve a fresh seed.
- `FishGroup`, `FishTexture` and `fishGlsl` (`fish.ts`): fish that swim the way they face and never
  slide (follow a moving point, gather at one, flee, wander, school, keep personal space, soft
  walls) for a species' speeds and turning, packed for the shader; GLSL to read their poses and draw
  them from above with a koi coat or side-on (pond, kelp). The scene supplies the water and light.
  Species: `KOI` (pond), `BLENNY` with `FISH_BLENNY` (the tide pool's rock pool fish).
- `RootedPlants`, `PlantTexture`, `writePlantRecords`, `plantClimate` (`plants.ts`): the plant
  component (see "Rooted plants" above): persistent plants rooted at the scene's sites, organs on
  springs under wind, gust fronts or current, a growth clock, the year, and a detail tier per organ
  from its projected size; records for `plantsGlsl`. `PlantSheet` (`plantsheet.ts`): the same
  organs rasterised on the GPU into a mipmapped RGBA8 sheet from a sprite atlas, for hundreds of
  organs (pond).
- `GpuReadback` (`readback.ts`): a small float target copied back to the CPU behind a fence and
  picked up a frame or two later, without stalling (the tide pool's flow for its plants and fish).
- `BuildSlot`, `BuildKind` (`build.ts`): pure CPU builds on one module worker (`src/build-worker.ts`
  lists every kind) with their typed arrays handed back by transfer: the countryside's terrain and
  land, frost's crystal field, the dew web respun for a new shape, the slime mould's fresh dish, the
  pond's sheets. One slot per sim, asked every frame: the newest request wins (a superseded build
  is dropped on the worker and never lands), the scene draws what it last adopted meanwhile, and a
  result is byte for byte the page's (the same code; `build-worker.test.ts`). Without a worker, and
  for a frame of Infinity budget (HeadlessSim, checks), the build runs on the page in slices. A
  kind's result must own its arrays (copy what its builder keeps for reuse); state classes hand
  themselves over as plain arrays (`VerletSystem.state`/`from`, `LandModel.data`,
  `FlowNetwork.state`, `Random.state`).
- `mulberry32` and `Random` (`random.ts`): the seeded generator, bit-exact with the scenes' copies
  so a seed keeps its arrangement; `Random` adds `range`, `int`, `pick`, `wait` (the gap to a
  Poisson process's next event: street's arrivals) and `gauss` (roughly normal from three draws:
  lake's crack walks) and re-seeds in place.
  Import it rather than carrying a copy (ferro's xorshift is deliberate: its pours depend on it).
- `clamp`, `lerp`, `smoothstep`, `fract`, `hash31` (`math.ts`): import them rather than a local copy;
  `glslHash12` and `glslHash22`: common.ts's hashes in float32 steps, for a sim that must place
  things where its shader hashes them (pond's koi loops, falls' ferns, the tide pool's holdfasts);
  `hypot2` and `hypot3`: V8's `Math.hypot` (Chrome's) bit for bit in any engine, for a seeded
  layout that must come out the same in every browser (each engine rounds `Math.hypot` its own
  way): country's terrain, land use, chalk M and verges.
- `valueNoise` and `fbm` (`noise.ts`): seeded value noise on the CPU for laying out terrain, coasts
  and beds before a sim starts (tidepool, delta, the forest's mist, lake's snow, pearl's pour); not
  the shader's noise. Import them rather than a local copy: a copy that hashed `hash31(i, j, salt)`
  is `valueNoise(x, y, salt - 1)` bit for bit.
- `LevelCamera` (`camera.ts`): world ↔ screen for the level side-on camera (horizon, eye height,
  focal): move things in the world and project them, so receding slows them across the frame and
  draws them to the horizon; `groundDrop` / `groundDepth` map ground depth to the screen height
  below the horizon and back (meadow's seeds, bees' insects and their targets, fireflies' near
  lights, lake's crack and snow fields).
- `ElasticPan` and `rubberBand` (`pan.ts`): a picture the pointer drags about, tethered to its home:
  it follows the hand within an envelope, meets a rubber band's resistance past it, and drifts home
  when let go (fractal).
- `FixedStep` and `runBudgeted` (`clock.ts`): a fixed-step accumulator (`advance` returns the steps
  due; `alpha`, `lag(i)`), and warm-ups counted in steps, which a time budget only spreads over
  frames, so the opening picture never depends on the machine's speed. Sims step on one and draw
  between their last two steps by `alpha`; a few draw ahead of the last step by
  `pending` instead, along its motion (fish, the forest's motes and stag, the harmonograph's pen,
  which must stay over the ink its step laid). A solver whose step follows a knob counts in steps
  (`new FixedStep(1, max)` advanced by seconds / step: ripple's tanks).
- `pendulumStretch`, `pendulumAngle`, `pendulumFadingSwings` and `pendulumGlsl` (`pendulum.ts`): a
  pendulum swinging beyond the small-angle approximation, the same maths in TS and GLSL (pendula's
  real pendulums).
- `toHalf` and `splitHalf` (`half.ts`): a number as two half floats (hi + lo) for a 16f texture,
  decoded in GLSL by `unsplitHalfGlsl`.
- `BinLists` (`bins.ts`): per-bin lists of the segments and points that reach each square bin of
  the frame, for a shader that walks only its cell's list (dew); a list grows by pages of
  `BIN_PAGE` entries, so a dense patch never drops one. Read in GLSL with `binListsGlsl`.
- `SpeckMap` and `followCell` (`specks.ts`): creatures a cell or a few across drawn into an rg8 map,
  one per dither cell with its depth, the nearest winning the cell whatever the plotting order, so
  the shader hides each behind only what stands in front of it; `upload(texture)` sends only the
  8 × 8-cell tiles whose cells were plotted or cleared since the last one (a few KB a frame for the
  bees' 80-odd specks, not the 1 MB map); `followCell` keeps a hovering speck from flickering
  between two cells (bees). Not for a fixed slot per lattice cell (fireflies), a list the shader
  walks (lanterns), or per-tile lists sorted nearest first (street).
- `isShy`, `facing`, `atEase` and `stepShrink` (`temperament.ts`): how a creature takes the pointer
  coming near, curious ones turning to look and shy ones (a share of the population) shrinking away
  and coming back out a while after it has gone (forest's kodama).
- `separateDiscs` (`discs.ts`): after an integration step, moves apart bodies that touch as discs on
  a plane and have sunk into one another past a given share, a limited distance per step, coincident
  ones included; for soft-contact crowds (lanterns).
- `HeadlessSim` and `HeadlessGl` (`headless.ts`): the one harness for sim regressions. `HeadlessGl`
  is a stand-in context that takes a sim's `DataTexture` calls and keeps each texture's size and its
  data as uploaded, sub-rectangles included (anything else throws, naming the call); `HeadlessSim`
  drives a scene's real sim on it (or on a real context) with frames built as the renderer builds
  them: knobs over their defaults, "now" presses by knob, pointer, passage.
  `step(frame).upload(slot)` is what the shader would sample.
  Tests use it rather than a stand-in context of their own (dew, fractal, sand table, prism...).
- `Errand` (`errand.ts`): a kerbside errand's choreography (a vehicle pulls in, hazards on, a porter
  carries loads to a door in trips, climbs back in, the vehicle leaves); the scene drives and walks
  them and reports arrivals (street's late delivery).
- `gustPulse`, `gustPulseGlsl`, `GustTrain`, `windSign`, `gustWait`, `windNoise` (`wind.ts`): the
  lab's wind conventions (K_wind -1..1, gusts blowing with it), the gust pulse garden and autumn use
  (garden's maple sways with its GLSL twin; its woods and border take it as a front through the plant
  component's `wind`), a seeded gust scheduler with "now", and smooth eddy noise (mobile).
- `FlutterPlates` (`flutter.ts`): falling leaves and petals as rigid plates that flutter or tumble
  (Andersen, Pesavento & Wang's quasi-steady model, fixed midpoint steps), carried by the scene's air
  onto the scene's floor, then eased flat; per-slot state in typed arrays the scene seeds in its own
  draw order, and each plate's frame for packing (autumn, garden).
- `Litter` (`litter.ts`): things lying on the ground in a two-layer lattice (leaves, petals,
  needles), at most one item a cell, each fading toward a goal rather than popping in or out:
  deposits where a plate comes to rest, takes for a gust to lift, and tending (autumn's carpet).
- `FuelBed` (`fuel.ts`): a wood fire's fuel burning down: logs that catch from the bed, char, slump
  in steps and crumble to embers, a coal bed fed by them, and someone who tends it or lets it go
  out; stepped on the motion clock, it says how big the flames are, how the coals glow, how much it
  smokes and when sparks burst (campfire).
- `Mobile`, `designMobile`, `MobileTexture`, `mobileGlsl` (`mobile.ts`): a balanced hanging mobile on
  `VerletSystem` with plates and balls, arms hung from a parent's end or loop, drag, contacts and
  motors that hold an arm's rate (`drive`), and GLSL tracing its plates, balls, wires and links and
  the shadows they throw from a round lamp (mobile's solar system).
- `Boids` and `boidRules` (`boids.ts`): topological boids in 3D for flocks and schools of a few
  thousand: separation, cohesion and alignment with each boid's K nearest, found through a spatial
  hash with a bounded search (refreshed by turns), plus cruise, level flight, a home to wheel over,
  a threat, wind and noise, and startles relayed through the neighbours as a wave. Deterministic
  for a seed; the rules are one mutable object the caller sets each step (the murmuration's
  emergent flight).

Outside `src/sims/`: `src/mark.ts` is the Manifold M for TS (`MARK_VERTICES`, `markVertex`,
`segmentDistance`, `markDistance`) and the source of the GLSL one (`markGlsl`), so a stamped M and
a drawn M cannot drift; `src/shaders/glsl.ts` writes GLSL from TS: `glslFloat` (an exact literal,
tiny constants included), `glslVec3` (from `"#rrggbb"` or a triple) and `glslPick(knob, cases,
fallback)` (a palette table of `if (K_<knob> < i.5) return ...;` lines). The rest serve one scene
each: `src/botany.ts` and `src/decor.ts` paint the pond's plant atlas (the sprites `PlantSheet`
cuts out) and its canopy sheet, on the build worker (`src/sheet.ts`), and `src/constellations.ts`
sends the constellation figures as `common`'s `uCon*` uniforms (orbit's, and the night sky's
constellations that `skyStars` draws).

Keep simulations cheap (a few ms per frame at most) and scale step counts with `dt * motion`.
Sims must be deterministic for a given seed knob and survive `dt = 0` (paused) and resizes. A layout
a resize must rebuild waits for the new shape to rest first (garden's re-layout, frost's regrowth,
dew's respin) and builds it off the page where it can (`build.ts`), and keeps what it can: frost
seeds each site's draws by where it stands, counted in from its own side of the pane, so a resize
keeps its pattern.

Knob keys share the URL with the lab's own settings, so a knob may not be called `accent`,
`scene`, `mode`, `dither`, `color`, `pixel`, `levels`, `motion`, `instance`, `mouse`, `view`,
`dim`, `blur`, `transitions`, `overlap`, `weave`, `blend` or `slowmo`, nor take the keys of the lab's session tools, `compare`, `tour`
and `dwell` (`state.ts` refuses to load such a scene).

## Art direction

- Everything is seen through a dither at 2–4 CSS px per cell. Bold, readable shapes beat fine
  detail; features thinner than ~2 cells shimmer as they move. Avoid per-frame random noise in
  colours (it reads as flicker); animate with smooth time functions instead. A cell covers whole
  device pixels (`src/display.ts`): `pixel` CSS px rounded to them (3 device px for 2 at 125 %
  scaling), since a cell 2.5 device px wide would show as columns of 2 and 3 and bend the dither's
  tone.
- Calm by default: a landing page sits on top. Slow, continuous motion; occasional events.
- Night-friendly dark palette, rich in full colour (`look: { color: "full", levels: 4 }` is the
  usual default), still legible in two-tone accent mode.
- A Manifold landmark: one standalone element that stands out but belongs to the scene (the pond
  has a carved stone M). Off or subtle by default, in its own `manifold` group.
- Every effect is a knob with plain-language help; occasional events get a "now" trigger.
- Performance: one full-screen pass at ~960×540 cells must hold 60 fps on an integrated GPU. Keep
  loops short (≤ 32 iterations in the common path), no nested loops over many items. The renderer
  holds every stage to that budget (`CELL_BUDGET`: a larger one, a 4K screen or a 1440p one at
  pixel 2, gets coarser cells), draws at most 60 frames a second whatever the display, and none
  while the picture stands still (see "Time and motion"). The GPU timing page (below) measures it
  on a real device.

## Correctness checks

Run `bun concepts/landing/verify.ts` from the repository root with system Chromium available
(`MANIFOLD_CHROMIUM` can select its binary); name checks to run only those
(`bun concepts/landing/verify.ts frostSky pondKoi`). Each check runs on a freshly loaded page, so
it inherits nothing from the others, and has a deadline of its own: three times the seconds it last
took (`scripts/verify-timings.ts`), never under 180 s, or `LANDING_CHECK_SECONDS` for every check
when that is set (it is started in the page and reports back when done, so no browser protocol
call waits on it). A check whose renderer crashes or is killed (earlyoom picks renderers first)
fails at once with `renderer crashed`, not at the deadline. The run prints
`PASS  <name> (<seconds> s)` per check, then the results as JSON keyed by check name, and stops at
the first failure (a throw, the deadline or a crash) with `FAIL  <name>` and a non-zero exit.

- `--shard i/n` runs the `i`th of `n` disjoint shares of the checks, balanced by their recorded
  seconds: longest first, each to the share with the least so far, so the shares differ by at most
  the longest check; a check without a record weighs the median one.
- `LANDING_SCENES=a,b` keeps only the checks that cover those scenes, and runs the passage speed
  check on them alone (unset or `*`: all). A check imported from `src/scenes/<id>/` covers `<id>`,
  the scene directories its scene files import, and every scene those files name
  (`sceneDefs.<id>` or `"<id>"`); one that walks every scene (`sceneIds`,
  `Object.values(sceneDefs)`), or any check from outside a scene's directory, covers them all
  (`scripts/verify-plan.ts`).
- `--record` rewrites `scripts/verify-timings.ts` with the seconds of the checks that passed (and
  drops checks no longer registered); run it, without a scene scope, after adding or speeding up a
  check and commit the file.

Chromium ends with the run, however it ends, and takes its profile with it. The isolated browser
exercises actual WebGL output: Forest's sky phase across motion changes, inherited GPU blending
and preserving resize, Frost's warmth/trace reset while paused and after resume, the shared sky
components' outputs (stars, the moon's phase, aurora, meteors) and their coupling in Frost's
picture (`frost/sky.verify.ts`), the canopy weather (`forest/canopy.verify.ts`), uncapped FPS,
and saved-frame dissolve sampling across larger, smaller, aspect-changed, and unchanged render
sizes. Software WebGL is deliberate; this check is not a real-device performance qualification.

`src/runtime.verify.ts` adds the renderer's runtime: under reduced motion a press and a trigger
age in real time while the clocks stand still (Dunes' streak clears after release; paused, ages
hold); a simulation that throws while starting or drawing, and a shader that does not build (its
program built in the background, the scene on screen going on meanwhile), keep the frame loop
scheduled, report the failure and recover by retry or by another scene; uniforms are sent only
when they change, including a look change made while another scene drew; and the Lab never
applies a setup while it is being built. `src/display.verify.ts` adds the display:
`contextRestore`, a lost context draws nothing while the frame loop goes on, and once the browser
restores it the scene enters again and draws; `frameGovernor`, a moving scene on a 120 Hz display
draws at most 60 frames a second, and paused or at motion 0 the picture stops issuing draws once
the change has played out, until input wakes it (`src/display.test.ts` and `src/governor.test.ts`
check the cells on whole device pixels at 125 %, the budget and the pacing without a browser).
Checks that drive frames by hand start the renderer unpaced (`start({ paced: false })`) and run
frames, a little real time apart, until it is no longer `waiting` for a scene's program.

`src/features.verify.ts` covers knob-keyed features through the renderer, taking its context for a
GPU's or a software rasteriser's whatever renders the check. No change waits on a build (no status,
log, uniform location or use of a program before its completion or fence was seen).
`sceneFeatures`, software: nothing is built ahead; a gated knob builds its own program in the
background and switches to it once built, the old frame holding until then; several gated knobs at
once build once; past four sets the least recently drawn program is freed. `featureToggles`, GPU,
for every scene with `featuresFor` (country, meadow, shore, dunes, bees, orbit): the plain page
builds only its own program; after the first gated change, which builds the all-features program in
the background, no change builds a program; with changes expected that program is built ahead at
rest, draws one frame without changing it, and the first change switches to it at once.
`worldFeaturesAll` (every scene with `featuresFor` but the countryside: meadow, shore, dunes, bees,
orbit), GPU: the all-features program draws every gated setting, dithered and as source, byte for
byte as the setting's own (drawn on a renderer taken for a software rasteriser's that enters at the
same starting setting, settles and switches the same way, so the sims share their history).
`countryFeaturesAll` (`src/scenes/country/features.verify.ts`) checks the same of the countryside
over its land directly, each distinct program compiled once.

`src/lab/inspector.verify.ts` (`labInspector`) lays the lab's Controls view out under `lab.css` and
draws no WebGL: folded groups and closed controls take no focus (`inert`), and a group folding with
the focus in it hands it to its header; under the lens a change behind a switch that is off shows
dormant beside the switches it waits on, its "changed" dot whole under the pointer, and a `when` two
levels up closes its grandchildren; a sync that changes nothing writes nothing (a MutationObserver
over country's, pond's and dunes' views, plain, under the lens and under a search); in a night with
an aurora, drawn in three layers, a click picks a planet and switches the aurora and the Milky Way
under the layers over them.

The shared components have checks of their own:

- The giant planet (`campfire/planet.verify.ts`, `planet`): its ring geometry agrees between the
  line of sight, the plane and the shadow on the planet; its level of detail leaves resolved belts
  bit for bit and merges far city lights into blocks; and Campfire's composed moons, aurora, lights
  and day cycle show only where the planet does, with a moon behind it hidden.
- Orbital motion (`orbit/kepler.verify.ts`, `orbitKepler`), read back from the GLSL: the shared
  moons' rates keep Kepler's third law (rate² × distance³ one constant across them), and Orbit's
  captured meteor falls on a decaying orbit whose rate rises as distance^-1.5 all the way down, its
  speed with it.
- The water's tiers (`island/water.verify.ts`, `waterTiers`): detail too fine to draw is skipped
  without changing a value (each wave train and the caustic net against its unskipped form), the
  cellular net draws its seams where they span a cell and only its mean where they do not, the
  mirror, the glitter, the flow and the caustic light behave, and each tier's functions exist from
  that tier up while each adopter compiles at the tier it selects and not one lower.
- The clouds' tiers (`clouds/tiers.verify.ts`, `cloudTiers`): each tier's functions exist from that
  tier up (the lit deck also without `CLOUD_TIER`), each adopter needs its tier, the deck's shadow
  over the eye is the cloud the sky shows over the sun, and Autumn's cloud shadows only darken,
  move with the deck and are gone at night.
- The Milky Way (`campfire/milkyway.verify.ts`, `milkyWay`): the band stays on the galactic plane
  and above the horizon and crowds the stars into it, and its knob brightens Campfire's and the
  lake's nights without reaching Campfire's ground.
- The star density knob where it replaced a fixed density (`shore/stars.verify.ts`, `starsKnob`):
  over the cloud sea, the murmuration and the shore it starts at the old density, and more stars
  light the night more.
- The constellations and the planets (`src/night-sky.verify.ts`). `nightSky`: at a clear midnight
  `skyStars`, both overloads, lights every figure star and the middle of every figure line (the
  lines as strong as their amount, the stars not fading with them); they still show at a coarse
  footprint; by day and with no stars nothing; and the knobs off, in a program with every gate on,
  draw exactly what a program without them draws (`src/shaders/index.test.ts` holds every scene's
  knob to off at its defaults, its gate out of the default program). `nightPlanets`: in aurora and
  island, two planets of different kinds show where their placements put them (the left one further
  left), together as each alone does; an orbiting planet drifts left with the motion clock and,
  half a circuit on, has set, the sky byte for byte the empty list's.

CI runs these checks (gate group `landing-webgl`, four jobs `landing-webgl (1/4)` to `(4/4)`, one
`--shard` each) and the lab's TypeScript and unit tests (`landing-concept`) for every pull request
that changes `concepts/landing/` or a source the lab imports, other than its documentation and
thumbnails, and on every full run (each push to `main`, each manual dispatch). A pull request that
changes only scene directories (and documentation) runs only the checks covering those scenes and
the scenes whose files import theirs (the planner's `landingScenes`); full runs cover every scene.
`bun scripts/gate.ts --only landing-webgl [--shard i/4]` or `--only landing-concept` runs the same
slice locally.

To add a check, write `<topic>.verify.ts` in the scene's folder exporting a function that takes a
`WebGL2RenderingContext`, throws on a regression and returns what it measured as plain JSON data,
then register it in `concepts/landing/verify-browser.ts` with one import and one
`["<name>", verifyTopic],` line at the end of `checks`. The context is the check's own (a vertex
array bound, the canvas at its default size): size the canvas for what it reads back, and restore
in a `finally` any global or shared definition it patches (`window.requestAnimationFrame`, a
scene's `glsl` or `sim`). Name each scene the check draws as `sceneDefs.<id>` (or import from its
directory), so a run scoped to that scene keeps the check. Keep each check well under the deadline
in software WebGL on a busy machine (split a slower one into several entries) and record its
seconds with `--record`.

### Pixel identity (`scripts/ab.ts`)

`bun concepts/landing/scripts/ab.ts [--base <rev>] [setting...]` shows whether a change alters
what the lab draws. Each setting is drawn from this working tree and from the base revision
(default `HEAD`, so the uncommitted edits; `--base $(git merge-base HEAD origin/main)` for a
branch), each tree built as `serve.ts` builds a commit, both in one software-WebGL Chromium, with
the clocks frozen as a reduced-motion visitor sees the page, until the picture has held still for
1.5 s with no sheet still painting; then the two pictures are compared cell for cell. A setting is a
page query (`"scene=country&time=0.3"`) or a bare scene id; by default every scene at its defaults,
dithered and `view=source`, and `--presets` adds the committed presets. A scene whose generated GLSL
(default and all-features programs) and every file its page loads (index.html and its imports,
short of other scenes' directories) are byte for byte the same in both trees is skipped (`--all`
draws it anyway), so a change confined to one scene draws that scene only. It prints `SAME`,
`DIFFERS`, `SKIPPED`, `FAILED` (no still picture within `--seconds`, default 120, or a scene that
failed to draw), `ADDED` or `REMOVED` per setting, writes `<slug>.base.png`, `<slug>.head.png` and
`<slug>.diff.png` (differing cells bright, the rest dimmed) for each difference and `report.json`
to `--out` (default `/tmp/landing-ab`), and exits 1 when anything differs or failed. `--size WxH`
sets the page in CSS pixels (default 384x240, 192×120 cells at the default pixel size). Only the
canvas is compared: settings that act on the page around it (`dim`, `blur`, `mode`) draw the same
cells. Use it to show that a refactor leaves the default renders pixel-identical, rather than
keeping a copy of the old code in a check.

### GPU timing (`bench.html`)

The verify suite runs in software, so it says nothing of a real GPU. `bench.html` beside the lab
(`http://127.0.0.1:7920/bench.html` from `serve.ts`, committed or `--dev`; `/@<sha>/bench.html`
for a commit; the same paths on the public origin) times each scene at its defaults on the device
that opens it: its program's compile and link, then, once it is on screen and warm, its frames on
a canvas of `cells` (default 960x540, the budget above): GPU time per frame from
`EXT_disjoint_timer_query_webgl2` when the browser has it, else the time between animation frames,
and the main-thread time of each, with medians, 95th percentiles and ms per million cells. Beside
them it reports the renderer string, the context's uniform and texture limits, its fragment
precisions and extensions, and per program the uniform vectors it uses (each scalar, vector and
matrix row counted as one). Query keys: `scenes=a,b` (default all), `cells=WxH`, `frames` (120),
`warmup` (30) and `auto=1` to start at once. The report is JSON to copy or download; the page
sends nothing anywhere.
