# Writing a scene

A scene is one folder, `src/scenes/<id>/`, whose `index.ts` exports a `SceneDef` (see `types.ts`).
The registry `src/scenes/index.ts` lists scenes in lab order. Everything a scene needs is in its
folder; shared pieces live in `src/shaders/common.ts`, `src/shaders/lib/` and `src/shaders/*.ts`
(GLSL), `src/scenes/atmosphere.ts` (shared knobs, page themes), `src/scenes/plants.ts` and
`src/scenes/planet.ts` (the plant component's and the giant planet's knobs), `src/params.ts` (knob
builders, `KnobReader`), `src/sims/` (simulation helpers, CPU and GPU), `src/mark.ts` (the
Manifold M) and `src/shaders/glsl.ts` (GLSL literals from TS).

```
src/scenes/<id>/index.ts      SceneDef: id, title, blurb, accent, look, params, groups, passage,
                              theme, features, planets, and code: () => import("./code.ts")
src/scenes/<id>/code.ts       SceneCode, loaded on demand: glsl, entry, sim
src/scenes/<id>/constants.ts  triggers, passages, choice lists index.ts shares with shader.ts/sim.ts
src/scenes/<id>/shader.ts     export const <id>Glsl = `...` defining Shade scene<Id>(vec2 uv, vec2 cell, float t)
src/scenes/<id>/sim.ts        optional SimFactory (CPU or GPU simulation feeding textures)
src/scenes/<id>/build.ts      optional BuildKind the build worker runs for the sim (src/sims/build.ts)
```

The page loads the registry's `SceneDef`s at once and a scene's code (its `code.ts`, a chunk of its
own) only once the scene is needed: `loadScene(id)` in `src/scenes/index.ts`, which the renderer's
program cache calls before it builds a scene's program (a passage's incoming scene too), the page
for the scene it opens on and, at idle, for the scenes `[` and `]` step to, and the tour for its
next step. So `index.ts` never imports `shader.ts` or `sim.ts`: what both halves need lives in
`constants.ts`. Tools, tests and checks that need a scene's GLSL or sim await `loadScene(id)` (or
`loadScenes()`), e.g. `new HeadlessSim(await loadScene("pond"))`.

## The shader

Each scene compiles to its own program: `common` + its library `features` (`#define`s, see
"Composing components") + generated knob defines and `SKY_YEAR` (see "The climate") + shared `libs`
\+ the scene's `glsl` + the dithering `main` (`assembleFragment` in `src/shaders/index.ts`). The knob
defines come ahead of the libraries so a library may test an opt-in shared knob with
`#ifdef K_<key>`; libraries read no other knob. The driver gets that program shaken
(`fragmentSourceFor`, `src/shaders/shake.ts`): its `#if`s resolved with its own defines, its comments
gone and only the functions, structs, constants, globals, uniforms and `#define`s that `main` reaches
by name, every overload of a reached name kept. Each line stays where it was (removed text leaves its
newlines), so a compile error's line number points at the same code in both. Nothing is listed by
hand: a scene that calls a library function gets it. The entry returns a `Shade`:

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
-1..1 parallax, 0 when the pointer is not followed), `uPrincipals[MAX_PRINCIPALS]` (everyone
present, the visitor first, then the cast's agents: xy in uv, z = button held, w = scene time of
the last press), `uPrincipalCount`, `principalMotion(i)` (velocity, uv/s), `uBg` (the page background), `uParams` (the knobs, four a
row: read them as `K_<key>`), `uTriggers[]`,
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

The entry's `t` is `uTime`, the scene clock: it stands still while paused, and counts from the
scene's own start. A scene's clocks start at 0 as it is created, and through a passage the leaving
and the incoming scene each keep their own, so the float32 clocks stay as small as the scene is
young however long the page is open. A scene picked with "keep the world", or flipped to in an A/B
comparison, takes over the clocks of the one it replaces, so the world's hours, year and stars go
on where they stood. Anything that moves at the lab's motion pace reads `uMotionTime` (a sim:
`frame.motionTime`): the renderer sums each frame's scene-clock step times `uMotion`, from the
same origin as `uTime`. It equals `t * uMotion` while the slider stands still, and moving the
slider changes the pace instead of jumping every phase, as `t * uMotion` does (with the day cycle
on, by
hours after a few minutes). Never write `t * uMotion`, or divide a clock by `uMotion` (only
`meteorAge` and `lightningAge` do, through the sky's one event scheduler `skyEventAge`, to give a
sub-second flash its real-time pace); `uMotion` alone is for amplitudes. Nor multiply a rate knob
(a pace, a speed, a period: `ParamDef.rate`) into a clock, which jumps the picture as the knob moves
by all the time run at the old pace: the renderer integrates each one frame by frame on the motion
clock into a wrapped phase (`src/rate-phase.ts`), which the shader reads as `PHASE_<key>` and a sim
as `frame.phases[key]`; a feature's stands at 0 while it is off. The sky uses
`timeOfDayM(K_time, skyDays())` in every scene, `skyDays()` the days its day cycle (`K_cycle`) has
run; CPU day/night decisions use `timeOfDay(time, frame.phases.cycle)`. Library functions take the
clocks they run on: a `tm` or `motionTime` parameter takes `uMotionTime` (or the scene's own motion
clock), a `tf` parameter `uFallTime`, the fall clock: each scene-clock step times
min(1, 2.5 × motion), for what gravity drives (falling rain, splashes, rings, drips), so rain keeps
real time above motion 0.4 and still stops at 0, and never jumps either. A "now" response that
plays at the motion's pace, as the scene's own events on `uMotionTime` do, keys on
`sinceTriggerM(slot)`: the motion seconds since the press (`uMotionTime - uMotionTriggers[slot]`,
huge while idle; a sim: `frame.motionTime - frame.motionTriggers[slot]`). It stands still with the
motion clock, so under reduced motion such a response holds its first frame.
`main` already stills `shimmer` with the motion: don't multiply it by `uMotion` again.

Under reduced motion (the system's setting, followed as it changes) the scene holds still but
interactions still end. The scene clock and the motion clock stand still, sims get `dt` 0, weather
sits where it leads, the parallax rests (`uPointer` eases back to 0) and there are no passages.
A press over the page or a "now" trigger is stamped on a clock that keeps real time, and reaches
the shader (`uPrincipals[0].w`, `uTriggers`) and sims (`frame.triggers`) moved back by as much, so
`t - uPrincipals[0].w`, `sinceTrigger(slot)` and `frame.time - frame.triggers[slot]` count real seconds
since it happened. Key a press's or a trigger's response to that age and bound it, so it plays
once and settles (Dunes' pouring streak fades 0.6 s after the press, and is held only while the
button is down); anything driven by `t` or `uMotionTime` stays put. Sims see the press and release
edges and `fired`, but no time, so their response is one still step. Paused, every age holds.

Frames come every n-th refresh of the display, n whole, so each stays up as long as the last
(`src/governor.ts`, which measures the refresh rate from the frames the browser gives). A moving
picture draws at the full rate, the even divisor of the refresh rate nearest 60 frames a second
(60 at 60, 120 and 240 Hz; 75 at 75 Hz, 45 at 90, 72 at 144, 55 at 165), at rest too. The lab's
"At rest" setting (`&rest=half`; `full` is the default) lets it rest at half that, or at the
divisor nearest 30 where that is faster (30 frames a second at 60, 90, 120 and 240 Hz), whenever
no input lasts (the pointer, a key or the wheel, over the page or the lab: `SETTLE_SECONDS`, 5 s),
no press's or trigger's response plays (`RESPONSE_SECONDS`, 20 s) and no passage or entrance runs.
So nothing may move by the frame: step on `dt` (a sim on its `FixedStep`), or
key motion to a clock.

A picture that stands still is not redrawn. Paused, under reduced motion or at motion 0, the page
draws while something is on its way (an entrance, a passage, a program building, the parallax
easing to the pointer, a sim whose `ready()` is false) and for a while after each change or input
(`SETTLE_SECONDS`, 5 s; after the pointer merely moves or leaves, `POINTER_SECONDS`, 0.25 s, enough
to draw it where it now is; after a press, its release or a "now" trigger while the interaction
clock runs, `RESPONSE_SECONDS`, 20 s: `src/governor.ts`), then stops until the next. Bound a
response to that, and a sim that works on over frames at `dt` 0 (a budgeted rebuild, a build on
the build worker) reports `ready()` false until it is done, or its picture can stop half-way.

### Entrances and exits

Switching scenes (or first loading the page) is a passage, not a cut. The outgoing scene first
idles on while the incoming scene gets ready: its program builds in the background and is drawn
once off to the side (many drivers finish compiling a program at its first draw and hold the GPU
up while they do), then the incoming scene itself is created and runs ahead off screen, its sim
stepping with `dt` 0 and `enter` 0 and drawing one cell, until the sim reports `ready()` (a sim
that builds its world over several frames or on the build worker: the countryside's land, frost's
first field, dew's first web, the bonsai's tree, the dry garden's layout, the forest's warm-up, the
slime mould's first dish, the pond's plant sheets; at most 3 s). Any pause
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
frame. Every scene gets the blend for free. On first load the bare page (its background colour)
shows while the program builds and then while the scene's sim builds what it shows (until
`ready()`, at most 3 s, as a passage runs the incoming scene ahead), and the scene then appears
out of it cell by cell, its world in place, each cell at its own Bayer threshold (the `fade`
pattern), over 0.8 s whatever the blend's length and pattern (`REVEAL`, `src/renderer.ts`): every
cell crisp at full resolution from the first, never a picture scaled up. With passages off, under
reduced motion or at motion 0 the first scene is simply there once its program is built, a switch
is a cut, and so is a retry: the scene on screen goes on as it last drew until the next one's
program is built in the background, and then the next one is there. A context the browser
restores after losing it starts over as on first load: the bare page while it is lost and while
the scene builds again, then the same reveal. Nothing ever waits for a build.
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
  - `bun concepts/landing/verify.ts passageSpeeds1 passageSpeeds2 passageSpeeds3 passageSpeeds4`
    (a quarter of the scenes each) measures it on the real renderer at motion 0: the picture
    change over the last steps of the exit and the first steps of the entrance as a share of the
    passage's fastest step (`LANDING_SCENES=a,b` limits it to some scenes).
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
and 0 while off). `uParams` packs the knobs four a row (`vec4 uParams[MAX_PARAMS / 4]`), so knob i
is the constant swizzle `uParams[i / 4].xyzw[i % 4]` and goes up with `uniform4fv` (a GPU check
builds the array with `packParams`); never index `uParams` by hand. Keys are camelCase letters.

URL keys are this build's: a link, a preset and the lab's history are read in the keys of the build
that opens them, and a key it does not know is ignored (see "Links and the URL schema" below). A
knob that changes its key or kind (a share of 0..100 that became a feature would read 30 as its
switch: on, at the default share) needs the committed presets (`src/presets.ts`) that set it
rewritten in the knobs that now say it (the share on its `-amount`), their `commit` moved to a
build that has them. `src/presets.test.ts` holds every committed preset to loading as itself: only
its scene's keys and the lab's, each value as its knob reads it, and the whole query as the lab
writes it (`canonicalSetup`), which is how the Presets view lights the preset just loaded.

Shared knobs come from `src/scenes/atmosphere.ts`: `skyKnobs({ time })` gives `K_time`, `K_cycle`;
`weatherKnobs({...})` gives `K_rain`, `K_snow`, `K_fog`, `K_wind`, `K_lightning`, `K_aurora`
as requested. The rest are opt-in sky components (see "Composing components"), each given the value
the scene draws with as its default: `skyKnobs({ stars: 0.6 })` adds `K_stars` (density for
`skyStars`, 0 none .. 1 a dark-site sky), `skyKnobs({ milkyWay: { on: true } })` adds `K_milkyWay`
(the band's brightness for `milkyWay`, 1 as the component draws it, up to 2; 0 while switched off,
off unless `on`), `skyKnobs({ moon: 1 })` adds `K_moon` (the moon's phase for `skyMoonPhase` through
a lunation: waxing up to 1 full, waning past it to 1.95; 0 while switched off: no moon), `skyKnobs({ meteors: { trigger: 1 } })` adds `K_meteors` (shooting
stars for `meteorAge`, off by default, "now" on that slot), `skyKnobs({ constellations: true })`
adds `K_constellations` (the figures' lines, 0.05 a trace .. 1 clear stick figures; 0 while switched
off: no figures; off at 0.4; `skyStars` draws them itself, so only a scene whose stars come from it
takes them) and with it `K_join` (the agents' star-joining: the figures they join a night, 1..6, on
at 6; see "Principals and chores"), `weatherKnobs({ clouds: 0.3 })` adds
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
`readSetup` (`src/state.ts`), which reads them in this build's keys: the lab's settings
(`defaults`), the scene's knobs (a feature's amount under `<key>-amount`) and its lists. Each value
is read as its knob reads it (clamped, a switch rounded, a choice it lacks at its default), and a
key the build does not know is ignored and never written back.

The schema is this build's alone: it carries no version, and the lab keeps no migrations or scene
aliases (no backward compatibility, operator decision 2026-10-17). A key renamed or a scene removed
leaves a link that names it reading as the current keys say. A setup made on an older build replays
exactly on that build, `/@<sha>/?<query>`, as the Presets view's arrow does for each preset.

A setup naming a scene this build lacks opens the default scene with its lab settings, and the lab
says so in one line over the scene until another scene is on screen. A tour names scenes only; a
step naming no scene of this build is dropped.

**Lists.** A list of items, each a set of knob-like values (the night sky's planets,
`src/scenes/planets.ts`), lives beside the knobs as one key per list (`planets=`): packed
(`encodePlanets`, base64url varints), last in the query and absent while the list is empty. As one
key a list goes wherever keys go: minimal links, undo steps, presets, the `a.`/`b.` prefix and
`setupDifferences` (the list is one difference). The lab edits the list decoded (`readPlanets`) and
writes it back whole (`encodePlanets`), and the shader takes it as uniforms beside `uParams`
(`planetUniforms`), so items cost no knob slots. A new list follows the same pattern under a key of
its own that no knob of its scenes may take (`state.ts` checks `planets`).

### Lab widgets

The lab (`src/lab.ts`, `src/lab/`) is one menu over the scene in two presentations, a lab
preference (`presentation` in `src/lab/prefs.ts`): expanded, a floating inspector panel, and
compact, a bar along the bottom edge. The inspector has three views, picked by the icons in its
header: Scenes (every scene's thumbnail, shelved by family), Presets (saved setups) and Controls (the
scene's groups, then Look, Motion and Page); a rail beside each view jumps between its families,
preset groups or control groups. The scene's name in the header opens the Scenes view, and the
header's last icons minimise the lab to the bar and hide it. The Scenes and Presets views follow the
setup only while on screen, and the Controls view only while the open lab shows it (in the panel
or the bar's Find popover) or lends one of its sections to the bar (below); otherwise it keeps only
the lens's counts, which light the bar's chips, and catches up as it comes back.

The Global groups are the one home of the page-wide settings. Look holds everything that decides
how the picture reaches the screen: the view, the dither pattern, the colour, the accent (its value
the readout), the tones, the cell size (in halves of a CSS pixel: the display draws a cell in whole
device pixels, so a half tells on a high-density screen) and the dim and blur behind the page (in
hundredths). Motion holds the amount of motion (in hundredths), following the mouse and the scene
transitions with their replay and tuning. Page holds the page on top and the private instance's
name. Pausing the clock is the tools' play button (`p`) alone.

The compact bar (`src/lab/menu.ts`, rules in `menu-model.ts`) is the same menu laid flat: the Find
chip (a magnifier at its head) opens the whole Controls view, its search, lens and rail, in a
popover with the keyboard in its search; the scene's chip (its dot and name) opens the Scenes view,
a Presets chip the presets, then one chip per Controls section in the Controls order (the World
shelf, the scene's groups, Global), its icon and title as the rail and the headings pick them. A
chip is lit while its section differs from its defaults, as the lens counts it, and a section with
a master switch shows it on or off. A chip opens a popover (`src/lab/popover.ts`) holding the
panel's own element, lent while it is open (`Inspector.lend`, `borrow` in `src/lab/dom.ts`), never
a copy: one set of controls, one set of syncs. A section shows open and whole there, under its own
heading with its recipes and dice (the search and the lens wait while a section is lent; the
popover carries the section's name as a heading for assistive technology), in a popover as wide as
the inspector, at most most of the screen tall and scrolling; on a narrow screen a popover is a
sheet the full width of the screen, standing on the bar. While the chips do not all fit with their
titles they go icon-only together, the title their tooltip and name, and then the strip scrolls (a
wheel over it too): every section stays one press away, in one order, where a "more" chip would
hide the rest behind a popover of popovers. The fit is measured, never decided by scene. The chips
are one tab stop (the arrow keys, Home and End move along them); Escape closes a popover and hands
the keyboard back to its chip, and a popover's controls are in the tab order only while it is
open, after the bar or panel its button stands on. The bar docks top or bottom or floats like any
panel, and "expand" takes the lab back to the panel.

Both presentations carry one row of tools, in the panel's foot or on the bar: play or pause, undo,
redo and shuffle; A and B while a comparison runs; the tour's place while it plays; and "⋯", a
popover with the setup's and the session's tools: reset, the link and the explanations, then every
"now" of the scene, the A/B comparison, the tour, the shortcuts and the build's status. Undo and
redo name the step they take ("Undo: crops, dither"). A step is what a person did
(`src/lab/history-model.ts`): a commit to the same URL keys as the step before it, within a second
of that step's last commit, grows that step (a held arrow key, a run of clicks on one control), and
a playing tour's own advances are one step, so one undo goes back to where it began. `[` and `]`
step through the scenes in the Scenes view's order (`sceneOrder` in `src/lab/families.ts`), as the
tour's picker and its "All" do. `l` hides the whole lab, and `/` opens the panel at the control
search: from the bar for this session only (the bar stays the preference), until Escape in the
search or the lab closes.

The lab's look (`src/lab.css`): one dark palette with an amber accent that marks only what is on,
picked or changed; labels in the page's sans, numbers, keys and eyebrows in its mono; three radii
(panels and popovers, chips and fields, buttons and segments), sunk wells for fields and segment
rows, and two speeds of motion (quick for colour, calm for what moves or opens, all of it off under
reduced motion). A choice of a few is a row of segments, a radio group (`segments` in
`src/lab/controls.ts`). Text stays at 4.5:1 or more against the panel.

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
  change, or under a search only the changes the search shows ("Reset these"; rules in
  `src/lab/lens-model.ts` and `shownChanges` in `src/lab/availability-model.ts`). A control holds
  the knobs its element, or the widget round it, lists in `data-keys`: the inspector's `place` tags
  a widget with its knob's keys, so tag one that holds several knobs with all of theirs.
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
float timeOfDayM(float time, float days);                 // K_time carried on by skyDays() -> 0..1 (0 midnight, .25 sunrise, .5 noon, .75 sunset)
float skyDays();                                          // the days the day cycle has run: its rate phase PHASE_cycle, 0 without one or while off
float skyDaysAt(float cycle, float at);                   // the same as they stood at the earlier motion clock at, taken back at pace cycle (K_cycle)
struct Sky { vec3 sun; vec3 moon; float day; float twilight; float night; vec3 sunColor; vec3 ambient; vec3 moonColor; float starTurn; }; // + float moonPhase with SKY_MOON_PHASE
Sky skyAt(float tod);                                     // the world clock's sky: sun rises on the right, crosses high, sets on the left; the staged full moon (no lower than a soft floor that keeps it rising); dated by SKY_YEAR in a dated sky; stars turned by the day cycle
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
float skyEventAge(float tm, float window, float chance, int lookback, vec4 salt, int slot, out float seed); // the sky's random events' scheduler (meteorAge, lightningAge): real seconds since the latest
// With SKY_MOON_PHASE (SceneDef.features):
Sky skyMoonPhase(Sky sky, float phase);                   // K_moon: 1 full (unchanged); below it waxing (lit share phase) east of the sun, above it waning (lit share 2 - phase) west of it, 0 or 2 no moon; a partial moon stands acos(1 - 2 lit) from the sun, moving onto the full moon above 0.9 lit; disc, halo, moonColor, ambient follow
float skyMoonPhaseLight(float lit);                       // the moon's light at a lit share relative to full, the measured lunar curve (0.09 half, 0.026 a quarter)
// With the scene's K_constellations (skyComponentKnobs({ constellations })), both skyStars overloads
// also draw, over the field and only while the knob is on (never at density 0), in a program that
// compiles them in (the library gate SKY_FIGURES, see "Knob-keyed features"): six figures fixed on
// the dome 13-42 degrees up, from 37 degrees left to 50 right of ahead (clear of the full moon at
// midnight); their stars brighter than the field's, the stick lines at K_constellations (0.05 a
// trace .. 1 clear); faded as the stars (skyStarFade); sized in dither cells (foot; 1 / uRes.y
// radians without it), so they show at any cell size.
// With the scene's planets (SceneDef.planets, the library gate SKY_PLANETS while its list holds
// any; without it the sky as it was):
vec3 skyGiant(Sky sky, vec3 col, vec3 dir, float foot, float clear); // the sky's planets over col (the sky up to its stars), the fixed ones turning with the stars; see "The sky's planets"

// Clouds in tiers (clouds.ts), each only in a scene whose SceneDef.features CLOUD_TIER reaches it, the
// lit deck where it selects none (see "Clouds"):
// CLOUD_FLAT, in every program
vec2 cloudDeckDrift(float wind);                          // the deck's drift a second along its frame: 0.09 x wind sideways, creeping 0.01 toward the eye
vec2 cloudDeckPoint(vec3 dir, vec2 travel, float tm, vec2 drift); // where dir meets the deck (cloud-base heights), drifted on tm; travel: the eye's own way under it
vec2 cloudDeckPoint(vec3 dir, vec2 travel, float tm, float wind); // the same drifting with wind in the sky's frame
float cloudFlatField(vec2 p, float fine);                 // the calm deck: two broad octaves 0..1, the finer kept by fine
float cloudFlatFine(vec3 dir);                            // how much of the finer octave a view along dir keeps (none toward the horizon)
// CLOUD_LIT (and without CLOUD_TIER)
vec4 skyClouds(Sky sky, vec3 dir, float tm, float cover, vec2 drift); // the lit deck seen from below: rgb, alpha; lit across from whichever of the sun and the moon lights it more
vec4 skyClouds(Sky sky, vec3 dir, float tm, float cover, float wind); // the same drifting with wind in the sky's frame
float skyCloudField(vec2 p, float foot, float tm);        // its density at a deck point, octaves faded to their mean below ~3 cells
// CLOUD_SHADOWS
float skyCloudShadow(Sky sky, vec3 ground, float base, float tm, float cover, float wind); // 0..1 its shadow at ground (eye-relative), the deck base above the eye
float skyCloudShadow(Sky sky, vec3 ground, float base, float low, float tm, float cover, float wind); // the same under a deck rain brought down to base / low
float skyCloudShadow(Sky sky, vec3 ground, float base, float low, float tm, float cover, vec2 drift); // the same drifting by drift (cloudDeckDrift turned into the sky's frame)
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
float waterMasking(float c, float s2);                    // Smith's share of a rough surface's facets seen (or lit) at cosine c: 1 face on, 0 behind
float waterGlint(vec3 n, vec3 view, vec3 light, float s2, float exposure); // a light's glitter 0..1 of its colour: Cox & Munk with Fresnel and masking, saturating
// WATER_FLOW
vec2 waterDrift(vec2 p, vec2 current, float tm);          // where to evaluate a pattern a steady current (velocity) has carried to p
// WATER_CAUSTICS (caustics.ts)
vec2 causticRipples(vec2 p, float tm, vec2 wind, float scale, float steep, float pace, float foot, out vec3 hessian); // five trains with curvature
float causticJacobian(vec3 hessian, float d);             // det(I + d H): d = 0.25 x depth for water
float waterCaustic(vec3 hessian, float depth, float focus, float soft); // light on the bed vs still water, times a sim's focus
float causticCells(vec2 x, float t, float foot);           // the stylised cellular net 0..1 (seams where the cells meet), x in net cells

float lightningAge(float tm, float rate, int slot, out float seed); // real seconds since the latest strike (random at `rate` on tm, or the trigger): skyEventAge
float lightningBolt(vec2 p, vec2 top, vec2 ground, float seed, float age); // forked bolt glow at p (aspect-corrected units)
float lightningFlash(float age);                               // sky-wide flash 0..1

// Aurora (AURORA_CURTAINS feature: curtains, default 3). tm: uMotionTime; foot: radians a dither cell spans.
vec3 auroraM(vec3 dir, float tm, float strength, float foot);   // curtains of light for a view ray, to add to the night sky
vec3 auroraGlow(float tm, float strength);                       // its light on the land, to add to ambient (times auroraSeen)
float auroraSeen(Sky sky, float cloud);                          // night and open sky: multiply the curtains and their glow by it
vec3 auroraCurtains(vec3 dir, float tm, float strength, float keep); // keep 1: full detail, for scenes with their own motion clock (lake's surge) or detail

// Shooting stars: when, and the streak in the scene's own flat sky frame (skyAngles for a dome).
float meteorAge(float tm, float rate, int slot, out float seed); // seconds since the latest one (random at `rate` while motion > 0, or slot's "now"): skyEventAge
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
float milkyWay(vec3 dir, float height, MilkyWayBand band); // its brightness 0..~1.3: dir where the band is fixed (skyStarFrame of the view ray), height the view ray's own y, 0 below the horizon and off the plane
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

| String            | File                           | Composed by                                                                    | See                                  |
| ----------------- | ------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------ |
| `worldGlsl`       | `src/shaders/lib/world.ts`     | meadow, shore, dunes, bees, swell (it composes `birdsGlsl` and `milkyWayGlsl`) | "World layers"                       |
| `birdsGlsl`       | `src/shaders/lib/birds.ts`     | country, falls, lake, lanterns, skyward, train; the world's                    | "Birds"                              |
| `milkyWayGlsl`    | `src/shaders/lib/milkyway.ts`  | campfire, lake; the world's                                                    | the Milky Way row below              |
| `canopyGroveGlsl` | `src/shaders/lib/canopy.ts`    | bamboo, forest                                                                 | "Shared libraries" (the canopy)      |
| `plantsGlsl`      | `src/shaders/lib/plants.ts`    | falls, fireflies, garden, pond, tidepool                                       | "Rooted plants"                      |
| `planetGlsl`      | `src/shaders/lib/planet.ts`    | orbit, campfire, mobile; `skyGiant` behind its gate (`SKY_PLANETS`)            | "The giant planet"                   |
| `figuresGlsl`     | `src/shaders/lib/figures.ts`   | country                                                                        | "Figures, livestock and buildings"   |
| `livestockGlsl`   | `src/shaders/lib/livestock.ts` | country                                                                        | "Figures, livestock and buildings"   |
| `buildingsGlsl`   | `src/shaders/buildings.ts`     | country                                                                        | "Figures, livestock and buildings"   |
| `terrainGlsl`     | `src/shaders/lib/terrain.ts`   | country                                                                        | `TerrainBuilder` under "Simulations" |
| `fieldsGlsl`      | `src/shaders/lib/fields.ts`    | country                                                                        | the fields row below                 |
| `treesGlsl`       | `src/shaders/lib/trees.ts`     | country                                                                        | the trees row below                  |

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
(the world's gates alone), `orbit` (`orbitFeatures` and `ORBIT_ALL`: the
figures in its stars, the planet's aurora and city lights, the M's lights, the moons and the ring
system, all off at its defaults; its storms, shooting stars and captured meteors stay in, as a
"now" shows them, and so do the cloud decks the storms flash in), `lake` (`lakeFeatures`: the
fjord, `LAKE_FJORD`, while it is the place, and the slow drapes, `LAKE_DRAPES`, while they are on)
and `pendula` (`pendulaFeatures` and `PENDULA_ALL`: real pendulums, `PENDULA_REAL`, with
`pendulumGlsl`; the trails, `PENDULA_TRAIL`; the M, `PENDULA_MARK`; all off at its defaults, so
its default program swings every bob as a small swing).

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
(`SceneShaderError`) or shake (`GlslShakeError`: an `#if` the shaker cannot evaluate, unbalanced
braces or conditionals) fails as one whose program does not compile. Rules:

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

| Component      | Controls                                                                                                             | Features                                | Outputs                                                                                                                                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stars          | `skyKnobs({ stars })`: `K_stars`                                                                                     |                                         | `skyStars(sky, dir, density, foot)` coverage, `SKY_STAR_TINT`; `skyStarFade`                                                                                                                                                                                                         |
| Milky Way      | `skyKnobs({ milkyWay })` (`skyComponentKnobs` without the clock): `K_milkyWay`                                       | opt-in `milkyWayGlsl`                   | `milkyWay(dir, height, band)` radiance (times the scene's tint, `K_milkyWay`, `K_stars` and night), `milkyWayStars(density, band)` the stars crowding into it; the band's pole is the scene's (`MILKY_WAY_BAND`)                                                                     |
| Moon           | `skyKnobs({ moon })`: `K_moon`                                                                                       | `SKY_MOON_PHASE`                        | `skyMoonPhase(sky, K_moon)`: the disc and halo in `skyColor`, the light in `sky.moonColor` and `sky.ambient`, the glare in `skyStars`; `skyMoonCover(sky, dir)` coverage                                                                                                             |
| Aurora         | `weatherKnobs({ aurora })`: `K_aurora`                                                                               | `AURORA_CURTAINS` (3)                   | `auroraM(dir, tm, strength, foot)` radiance, `auroraGlow(tm, strength)` light, `auroraSeen(sky, cloud)` visibility                                                                                                                                                                   |
| Canopy weather | `weatherKnobs({ rain, wind })`: `K_rain`, `K_wind`; the scene's seed knob                                            |                                         | `canopyWeather(sky, K_rain)` light (the sky under the rain's cloud, the deck's brightness, the key's side and slant); `canopyRaySources`, `canopyGap(p, wind, seed, raySrc)` coverage (where the rain pours in); `canopyGapSky(w, washed, dir, stars, p, wind, seed, deck)` radiance |
| Water          | the scene's own (`K_wind` and its water knobs)                                                                       | `WATER_TIER` (tiers, see "Water")       | slope and unresolved variance (`rippleSpectrum`, `windRipples`), mirror ray and Fresnel (`waterMirror`), drifted points (`waterDrift`), light on the bed (`waterCaustic`, the cellular net `causticCells`)                                                                           |
| Clouds         | `weatherKnobs({ clouds, shadows })`: `K_clouds`, `K_shadows`; the scene's own (the cloud sea's cover, height, drift) | `CLOUD_TIER` (tiers, see "Clouds")      | the deck's plane and calm field (`cloudDeckPoint`, `cloudFlatField`), the lit deck (`skyClouds`) rgb and coverage, its shadow (`skyCloudShadow`) light on materials, the sea of tops (`cloudSeaMarch`, `cloudSeaTop`, `cloudSeaShadow`) distance, normal and light                   |
| Meteors        | `skyKnobs({ meteors: { trigger } })` (`skyComponentKnobs` without the clock): `K_meteors`                            |                                         | `meteorAge(tm, rate, slot, seed)` schedule, `meteorStreak(q, field, age, seed, foot)` coverage in the scene's frame (`skyAngles(dir)` on a dome, screen heights for a flat backdrop), `METEOR_TINT`                                                                                  |
| Constellations | `skyKnobs({ constellations: true })` (`skyComponentKnobs` without the clock): `K_constellations`, off at 0.4         | the library gate `SKY_FIGURES`          | inside `skyStars`' coverage, no call of its own: the figures of `constellations.ts` (its `uCon*` uniforms, all but the Manifold mark) fixed on the dome, their stars brighter than the field's, the lines at `K_constellations`; faded as the stars (`skyStarFade`)                  |
| Birds          | `birdKnobs({ kind })` (`shaders/lib/birds.ts`): `K_birds`, `K_birdKind`, `K_birdFormation`                           | opt-in `birdsGlsl`                      | `birdFlights(p, sky, cam, tm, pxl)` coverage, depth and albedo (`BirdHit`); `birdFlightsSeen(..., true)` the image in still water; `birdBelowHit` from below                                                                                                                         |
| Rooted plants  | `plantKnobs({ group, season, growth, gusts })` (`src/scenes/plants.ts`), read by the sim only                        | opt-in `plantsGlsl`, `PLANT_DETAIL` (2) | organs on springs (`RootedPlants`) packed as records (`PlantTexture`, `plantOrgan`) for shared shapes drawn per fragment (`plantFrond`, `plantArc`, `plantPoint`), or rasterised into a sheet the scene samples (`PlantSheet`, `plantSheetGlsl`); see "Rooted plants"                |
| Giant planet   | `planetKnobs({ prefix, clouds, storms, aurora, lights, daycycle, moons, ring })` (`src/scenes/planet.ts`)            | opt-in `planetGlsl`                     | a hero composes the parts (`planetBelts`, `planetClouds`, `planetAurora`, `planetCityLights`, `planetRingBands`, `planetMoonDisc`...) as coverage and light; a decoration draws the whole giant over an RGB sky (`planetOver`); see "The giant planet"                               |

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
Sky sky = skyMoonPhase(skyAt(timeOfDayM(K_time, skyDays())), K_moon);
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

| Scene              | Sky seen                                                         | Stars                                       | Moon                                                                              | Aurora                                                            | Meteors                                                                              |
| ------------------ | ---------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `train`            | through the window                                               | knob 0.75                                   | knob (phase) + night glow                                                         | knob (`auroraCurtains`, full detail)                              | own: `K_meteors`, trigger 5, window and tunnel                                       |
| `frost`            | through the window (the world's sky, softened by the frost)      | knob 0.5 (cabin ×1.7, `World.stars`)        | knob (phase)                                                                      | knob, behind the snow cloud                                       | knob, trigger 1                                                                      |
| `autumn`           | over the park, under the canopy (the world's sky)                | knob 0.5                                    | knob (phase; keys the night light)                                                | knob, behind the clouds                                           | knob, trigger 2                                                                      |
| `bees`             | over the valley (the world's sky, "World layers")                | knob 0.6 + the world's Milky Way (knob, on) | knob (phase at every setting; keys the night light)                               | knob, behind the clouds and the cumulus                           | knob, trigger 0                                                                      |
| `dunes`            | over the dune sea (the world's sky; none overhead)               | knob 1 + the world's Milky Way (knob, on)   | knob (phase; keys the sand's light)                                               | knob, behind the clouds and the dust                              | knob, trigger 0, behind the clouds and the dust                                      |
| `falls`            | above the cliff (the world's sky, half turned)                   | knob 0.45                                   | knob (phase)                                                                      | knob, its arc lifted over the rim (`auroraLift`)                  | knob, trigger 0, falling behind the rim                                              |
| `garden`           | the haze over the wall (the horizon is the frame's top edge)     | —                                           | knob (phase; keys the night light)                                                | —                                                                 | —                                                                                    |
| `lanterns`         | over the river, mirrored (the world's sky)                       | knob 0.55, mirrored (its low sky shows few) | full (the world's; rises out of frame on the right)                               | knob, mirrored                                                    | knob, trigger 2, mirrored                                                            |
| `meadow`           | over the meadow (the world's sky, "World layers")                | knob 0.6 + the world's Milky Way (knob, on) | knob (phase)                                                                      | knob, behind the clouds                                           | knob, trigger 2                                                                      |
| `shore`            | over the sea and mirrored in it and the wet sand (the world's)   | knob 0.6 + the world's Milky Way (knob, on) | knob (phase, compiled in at every setting; moonrise)                              | knob, behind the clouds, mirrored                                 | knob, trigger 2, mirrored                                                            |
| `sill`             | over the city (the world's sky, softened by the glass)           | knob 0.5                                    | knob (phase)                                                                      | knob, light through the window                                    | knob, trigger 3, behind the clouds                                                   |
| `skyward`          | a strip between roofs (the world's sky, looking up)              | knob 0.3                                    | knob (phase)                                                                      | — (looking up: the curtains hang toward the horizon, out of view) | knob, trigger 0, camera frame                                                        |
| `bamboo`, `forest` | canopy gaps                                                      | knob 0.5                                    | knob (phase; the gaps and the night rays)                                         | —                                                                 | —                                                                                    |
| `street`           | in reflections only                                              | knob 0.55 (window glass)                    | knob (phase; the windows and wet street)                                          | —                                                                 | —                                                                                    |
| `lake`             | over the ice or the fjord, mirrored                              | own `K_stars` + shared Milky Way (knob)     | own phase, fixed bearing (right; over the fjord left)                             | knob (`auroraCurtains`, substorm clock) or own `drapes`           | knob, trigger 3, mirrored                                                            |
| `swell`            | over the sea and mirrored in it (the world's sky)                | knob 0.6 + the world's Milky Way (knob, on) | knob (phase, compiled in at every setting; moonrise, large through its long lens) | knob, behind the clouds, mirrored                                 | knob, trigger 0, mirrored in the waves                                               |
| `clouds` †         | above the cloud sea                                              | knob 0.75                                   | own bearing, drawn by `skyColor`                                                  | knob (`auroraCurtains`, full detail)                              | open                                                                                 |
| `country`          | over the valley                                                  | knob 0.5                                    | knob (phase; `SKY_MOON_PHASE` compiled in only below full)                        | open                                                              | open                                                                                 |
| `flock` †          | the subject over a skyline (only the dome mirrored in its water) | knob 0.45                                   | full                                                                              | open                                                              | open                                                                                 |
| `island` †         | round the island                                                 | knob 0.6                                    | full                                                                              | open                                                              | open                                                                                 |
| `campfire` †       | above the pines                                                  | knob 0.8 + shared Milky Way (knob)          | — (the giant planet replaces it)                                                  | open                                                              | own: `K_shooting`, trigger 0, under the planet                                       |
| `kelp`             | Snell's window                                                   | —                                           | full, refracted                                                                   | —                                                                 | —                                                                                    |
| `tidepool`         | the sky in the pools' mirror                                     | —                                           | full, mirrored                                                                    | —                                                                 | —                                                                                    |
| `dew`              | out-of-focus dawn backdrop                                       | —                                           | —                                                                                 | —                                                                 | —                                                                                    |
| `bonsai`           | none (its light only)                                            | —                                           | —                                                                                 | —                                                                 | —                                                                                    |
| `orbit`            | its own sky                                                      | own                                         | own                                                                               | —                                                                 | own (captured meteors)                                                               |
| `fireflies`        | its own moonless sky over the mangroves                          | own                                         | — (moonless)                                                                      | —                                                                 | knob (`skyComponentKnobs`), trigger 2, over the hills behind the trees, not mirrored |

`lake` keeps a night of its own over both its places (the frozen lake and, `setting` 1, the fjord
that was the `aurora` scene): its own `K_stars` knob sets the shared stars (`skyStarLight`) on it,
its `hour` knob the night itself. Its aurora is the shared curtains on the sim's substorm clock
(over the ice with a second, higher tap that rough ice smears), or with `drapes` its own slow drapes
(the fjord's: ribbons laid out by direction as the fjord's camera sees them, with `activity` and a
`corona` on its own trigger, 4), which the substorms brighten and quicken too; over the fjord the
moon stands low on the left and the M is a curtain folded high in the sky.

The constellations come with `skyStars`, so every scene whose stars it draws, directly, through
`skyStarLight` or through the canopy's (`canopyGapSky`) or the world's sky, has the knob: every
**knob** in the Stars column above, and `lake` for the shared stars on its own night. How much of
them shows is the view's: `lake` (on the ice), `frost`, `campfire` and `sill` three or four;
`country` (a strip of sky some 15 degrees deep) little; `street` only its window glass. `orbit` and
`fireflies` draw stars of their own and have none (orbit keeps a `constellations` toggle of its
own).

Planets can hang in every such sky that has room for them: `autumn`, `bees`, `clouds`, `country`,
`dunes`, `falls` (in its strip of sky over the cliff, behind the cloud deck), `flock`, `frost`,
`island`, `lake` (over both its places), `lanterns`, `meadow`, `shore`, `sill`, `skyward`, `swell` and
`train` (see "The sky's planets"). `campfire` keeps its own giant; `bamboo` and `forest` see only
gaps in the canopy and `street` only reflections, so none of them takes them.

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
flight is a few clear marks rather than flicker. The buzzard, at least 10 cells to the rooks' 6,
reads apart from them in a still frame: soaring above the eye with its wings held up in a V, it
shows their undersides side-on as from below (`birdUnderwing`: pale toward the tips, the tips
themselves dark), the more the steeper the eye looks up at it.

| Scene      | Birds                                                                                                           | Default                  | Hidden by                                                          | Mirrored in       |
| ---------- | --------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------ | ----------------- |
| `country`  | `birdFlights` through its level pinhole (metres), `birdKnobs` (mixed: rooks, gulls, swallows...)                | off, mixed               | land, crowns, buildings, figures, by depth                         | —                 |
| `skyward`  | `birdBelowHit` on the scene's own paths (pigeons wheeling over the street, swifts looping above); `birds` range | 0.5, pigeons and swifts  | anything nearer along the ray                                      | —                 |
| `meadow`   | the world's (`worldBirds`, `worldKnobs`)                                                                        | on 0.35 by day, swallows | the sea of grass by depth; the near blades and clocks              | —                 |
| `shore`    | the world's (`worldBirds`, `worldKnobs`); its image `worldBirdsMirrored`                                        | on 0.35 by day, gulls    | the surf by depth (a skimming gull dips behind a nearer breaker)   | the wet sand      |
| `dunes`    | the world's (`worldBirds`, `worldKnobs`); none overhead                                                         | on 0.35 by day, buzzard  | the dunes and the M by depth; hazed by the dust                    | —                 |
| `bees`     | the world's (`worldBirds`, `worldKnobs`); a bird hides the insects behind it                                    | on 0.35 by day, swallows | the orchard, the wall, the hives and the near flowers by depth     | —                 |
| `falls`    | `birdFlights` (`fallsBirds`), `birdKnobs`                                                                       | off, swifts              | cliff, rim trees and slot walls by depth; spray and the near bank  | —                 |
| `swell`    | the world's (`worldBirds`, `worldKnobs`)                                                                        | on 0.35 by day, gulls    | the sea by depth (crests, with relief), the boats and the headland | —                 |
| `lake`     | `birdFlights` in `lakeBeyond` and over the fjord in `lakeFjFar`, `birdKnobs`                                    | off, geese               | the cabin and the grove; the fjord's near bank                     | ice or fjord      |
| `lanterns` | `birdFlights`, `birdKnobs`                                                                                      | off, geese               | (nearer than the far bank)                                         | the rippled river |
| `train`    | `birdFlights`, `birdKnobs` (the `line` choice sets the mix)                                                     | off, mixed               | the line's land and structures (the scene's)                       | —                 |

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
  among the stars (`across`, `up`: where it stands while the stars stand as staged; it turns with
  them as the day cycle runs or a dated sky's date moves) or, with `orbit` on, the path it orbits
  our world on: a daily circle of the
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
  a format mark (1), the count, then per planet how many of its values differ from their defaults
  and each as a field id (its place among the planet's values, in `planetDefs` order, a feature's
  amount after its switch) and its value in whole steps of its knob (zigzag for a sign). Values
  sit on their steps' grid, so a list round-trips exactly; a malformed value (another mark, bad
  base64url, cut short, trailing bytes) is no planets, an out-of-range value is clamped, past the
  cap the first eight stay; nothing throws. How a list lives beside the knobs: "Links and the URL
  schema".
- **In the shader** the list is uniforms beside `uParams` (`planetUniforms`): `uPlanets`, five
  vec4 rows per planet (its path's circle, so a fixed planet is its direction and an orbiting one
  moves with `uMotionTime` alone; its radius; its switches packed, `SKY_PLANET_FLAGS`; its dress)
  and `uPlanetCount`, at most `SKY_PLANET_CAP` (8, the drawn maximum; the lab adds none past it),
  the smaller first so they draw back to front. Editing a planet sends uniforms and never builds a
  program; only the first planet and the last one's going change the program (the gate). A cheap
  bound finds the planets that reach a pixel, and only those are drawn, in a loop whose turns are
  those planets, so eight planets cost little more than one. Under SwiftShader (320 x 200 cells,
  midnight) the aurora scene's frame (measured before it became the lake's fjord) took some 57 ms
  without planets, 225 ms with one and 258 ms with eight, its program 1.9 s to build without the
  gate and 4.8 s with it; country's 108, 187 and 323 ms, 4.0 and 6.1 s. A sky without planets
  compiles none of it. The palettes are a chain of branches, not a const table: SwiftShader builds
  a dynamically indexed const array afresh in every pixel.

The library maps each planet onto the scene's sky directions: `dir` is the direction the scene
gives `skyStars` (so a fixed planet stands among the stars as they do: it moves with them under a
pointer's parallax and turns with them about the pole by `sky.starTurn`, the inverse of
`skyStarFrame`, while an orbiting one keeps its own circle), each planet seen square-on round its
centre (a gnomonic view), upright to the horizon, `foot` the
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
horizon; in a mirror (`worldMirrorSky`) they take the mirror's sky, whose moon is swung away, so no
undrawn moon cuts them. Campfire keeps its own planet, placed in its frame low over the pines, with
`giantKnobs({ group, on, help })` for its existing knobs; orbit is its own hero.

#### Water

Water is one component in tiers, cheapest first, each including the ones below it. A scene selects
the highest it draws, `features: { WATER_TIER: WATER_TIERS.mirror }` (`WATER_TIERS` from
`shaders/lib/water.ts`), and only that much is compiled into its program: calling a function of a
higher tier fails to compile. The tiers compose the water parts that already exist rather than
repeating them:

| Tier       | `WATER_TIER`       | What the scene gets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flat`     | `WATER_FLAT` 0     | nothing shared: its own tint, its sky mirrored flat if it likes                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ripples`  | `WATER_RIPPLES` 1  | wind ripples: `rippleSpectrum` over its own trains (surface.ts, in every program), or the breeze's cat's-paws, `windRipples`, with the screen-space mirror shift `windMirror` (`shaders/windWater.ts`)                                                                                                                                                                                                                                                                                                                     |
| `mirror`   | `WATER_MIRROR` 2   | reflections: `waterMirror`, the rippled normal, reflected ray and Fresnel; the scene looks its own sky and scenery up along the ray. A light's glitter, `waterGlint`: Cox & Munk's glitter radiance (a Beckmann slope density on the variance the cells do not draw, Fresnel, Smith's masking) times the light's exposure, saturating to 0..1 of its colour. `waterFacets`: single facets flashing in it for a second or two on a grid fixed to the water (9 x 4 cells wherever it lies), to multiply a path's exposure by |
| `flow`     | `WATER_FLOW` 3     | currents: `waterDrift` carries a pattern on a steady current                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `caustics` | `WATER_CAUSTICS` 4 | the bed lit through the surface: `causticRipples`' net (`shaders/caustics.ts`) and `waterCaustic`, which multiplies it by a simulated surface's own focus (`ShallowWater.surface`, `sims/shallow.ts`); or, for water with no spectrum of its own, the stylised cellular net `causticCells` (seams where a wandering lattice's cells meet)                                                                                                                                                                                  |

The shared parts own the physics: ripple trains with deep-water dispersion and their LEAN split
between drawn slope and unresolved variance, the cat's-paws, the mirror's normal and Fresnel, the
glitter's radiance, the advection, the caustic Jacobians. The scene owns its numbers (its spectrum,
its current, its knobs, the roughness finer than its trains that it adds to their variance for the
glitter, one exposure per light), the rain rings it adds to the slope, what it mirrors and how it
keeps the reflected ray above its horizon, its body colour, foam, sparkle and lights. GLSL code
that draws its water more than one way tests the tier: `#if WATER_TIER >= WATER_MIRROR`.

**Glitter.** `waterGlint` is physically based: a path's brightness follows from the light's height,
the view and the roughness, not from gains at the call site. A low sun or moon lays a long path
that brightens toward the horizon, where Fresnel and foreshortening pile up; a high one a short,
faint one; a rougher sea a wider, dimmer one. Each light carries one exposure (its radiance times
its solid angle, in the scene's units of brightness; a lamp's intensity over its squared distance
to the water, so its path fades away from it), and the result saturates (1 - exp(-exposure ·
radiance)) so a brighter light widens the path's solid core instead of burning through the dither.
Scenes set each exposure so the path at their default hour matches its old look at half its
height, and lay a wider sheen as a share of the same light on a rougher scale (the sea's broad
tail of slopes).

**Projected size.** Every tier takes `foot` and fades its detail to the area mean once a cell
outgrows it: a ripple train is drawn from `lod.x` to `lod.y` cells per wavelength (7..14 or 8..16)
and below that is only the variance that roughens the mirror; the caustic net fades from 12 to 6
cells, and the cellular net's seams (0.06 of a net cell) from one cell to half a cell, to its area
mean. A train or seam faded out is not worked out at all, so far or small water costs little more
than the flat tier whatever tier the scene selects, and resolved water is bit for bit the
full-detail picture. Pick the tier for what the water shows at its largest: a river a few cells
wide far off takes `ripples`, open water seen close takes `mirror` or `flow`, a pool seen from
above `caustics`.

| Scene      | Tier               | Uses                                                                                                                                                                                                                                                                                                                               |
| ---------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `country`  | ripples, else flat | `windRipples` on the river while `K_ripples` is up (`K_wind`): the cat's-paws tilt its reflected ray, their finer ripples jitter it cell by cell                                                                                                                                                                                   |
| `island`   | mirror             | `rippleSpectrum` (a `RippleTable`: four hand-placed trains, their slopes following the wind), `waterMirror`, `waterGlint` for the sun, the moon and the lantern                                                                                                                                                                    |
| `shore`    | mirror             | `rippleSpectrum` (a `RippleFan`: four trains by the golden angle, scaled by the wind), `waterMirror`, `waterGlint` for the moon and the sun, on the sea and the wet sand                                                                                                                                                           |
| `swell`    | mirror             | two Gerstner swells and three of wind sea (sharpened to the trochoid's crests, breaking white past a wave's steepness), `rippleSpectrum` (a `RippleFan` of chop) raised and turned by the wind, `waterMirror` into `worldMirrorSky`, `waterGlint` with `waterFacets` for the moon, the sun, the lighthouse and the boats' lanterns |
| `lake`     | mirror             | `waterGlint`: the moon's and window's paths down the black ice and over the fjord; the fjord's `windRipples`, `windMirror` (`K_ripples`, `K_wind`)                                                                                                                                                                                 |
| `lanterns` | flow               | `rippleSpectrum` (a `RippleFan`: five trains rocking about the current), `waterDrift` downstream, `waterMirror`                                                                                                                                                                                                                    |
| `tidepool` | caustics           | `causticRipples`, `waterCaustic` with `ShallowWater`'s focus; seen from above, it mirrors the sky its own way                                                                                                                                                                                                                      |
| `pond`     | caustics           | two layers of `causticCells` on the floor, carried by the current (`waterDrift`); `waterGlint` for the sun; its drop rings are its own                                                                                                                                                                                             |

The rest of the lab's water is still drawn its own way: `falls`, `fireflies`, `bamboo`, `forest`,
`kelp`, `delta`, `ripple`.

#### Clouds

Clouds are one component in tiers too, cheapest first, each including the ones below it: one cloud
deck that the scenes compose rather than each drawing its own. A scene selects the highest tier it
draws, `features: { CLOUD_TIER: CLOUD_TIERS.shadows }` (`CLOUD_TIERS` from `shaders/lib/clouds.ts`);
a scene that selects none gets the lit deck, as every sky had before the tiers, so `skyClouds` needs
no feature. Calling a function of a higher tier fails to compile.

| Tier      | `CLOUD_TIER`      | What the scene gets                                                                                                                                                                                                                                                                                   |
| --------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flat`    | `CLOUD_FLAT` 0    | the deck's plane and drift (`cloudDeckDrift`, `cloudDeckPoint`: 0.09 cloud-base heights a second with the wind, creeping 0.01 toward the eye) and the calm deck (`cloudFlatField`: two broad octaves, the finer dropped toward the horizon by `cloudFlatFine`), which the scene thresholds and lights |
| `lit`     | `CLOUD_LIT` 1     | the deck lit by the sky, seen from below: `skyClouds` (domain-warped fbm; the sun on the flanks facing it, silver linings, gold and pink undersides round sunset, moonlight), rgb and coverage                                                                                                        |
| `shadows` | `CLOUD_SHADOWS` 2 | its shadow on the ground: `skyCloudShadow`, the deck's cover where the sun's ray from a ground point meets it, as the sky shows it there; with `low`, under a deck rain has brought down to `base / low`, for a scene whose sky shows it by squashing the ray's height by `low`                       |
| `volume`  | `CLOUD_VOLUME` 3  | a sea of cumulus tops seen from above, ray-marched: `cloudSeaMarch` (terrain marching, secant steps), `cloudSeaTop` (the relief and the normal), `cloudSeaShadow` (Beer-Lambert light through the domes), `cloudPhase`, `cloudBillow`                                                                 |

The shared parts own what the cloud is and how light gets through it: the deck's plane and drift,
its fields, the march and the self-shadowing. The scene owns its numbers (cover, height, the
shadow's darkness), its light (the clouds scene's rig of sky samples, the train's moonlit body), how
it greys and lowers the deck under rain, and what stands in front.

**Projected size.** The lit deck's octaves fade to their mean once finer than ~3 cells, the calm
deck drops its finer octave toward the horizon, and the sea's relief fades with the cell's
footprint and is then not worked out at all: far cloud costs little, and resolved cloud is bit for
bit the full-detail picture.

| Scene                                           | Tier                                                                    | Uses                                                                                                                                                                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clouds`                                        | volume                                                                  | the sea below the window (`CloudSea`: its drift, `K_cover`, the boil, `K_altitude`'s drop, amplitude 0.45); its thunderheads take `cloudBillow` and `cloudPhase`                                                           |
| `autumn`                                        | shadows (`worldGates`)                                                  | the world's deck (`worldSky`), greyed by the rain; `skyCloudShadow` from it, 300 m up, where each pixel's sight line meets the park (`K_shadows`, off by default)                                                          |
| `country`                                       | shadows while its `shadows` knob is on (`featuresFor`), lit while off   | `skyClouds` by day, by night the calm deck (`cloudDeckPoint`, `cloudFlatFine`, `cloudFlatField`) lit by the moon; `skyCloudShadow` with its rain's `low` on every point of the land                                        |
| `meadow`                                        | shadows while its `shadows` knob is on (`worldFeatures`), lit while off | the world's deck (`worldSky`) under its own overcast tint; its shadows (`worldSunlit`) on the field and the tree line where each ray meets them, the hills 1500 m off and the near grass                                   |
| `shore`                                         | shadows while its `shadows` knob is on (`worldFeatures`), lit while off | the world's deck (`worldSky`) under its rain sky, mirrored (`worldMirrorSky`) in the sea and wet sand; its shadows (`worldSunlit`) on the sand and sea, dimming the sun and its glitter                                    |
| `dunes`                                         | shadows while its `shadows` knob is on (`worldFeatures`), lit while off | the world's deck (`worldSky`, its gaps greyed by the world and its deck by `worldGrey` too; none overhead); its shadows (`worldSunlit`) on the sand and the M, cast from the deck over the eye at rest, aerial or overhead |
| `bees`                                          | shadows while its `shadows` knob is on (`worldFeatures`), lit while off | the world's deck (`worldSky`) behind the world's painted cumulus; both their shadows (`worldSunlit`) by day on the garden where each ray meets it and on the hills 1200 m off                                              |
| `train`                                         | flat                                                                    | `cloudDeckPoint` with the train's run under the deck, `cloudFlatField` lit as the night line's own deck                                                                                                                    |
| `falls`, `frost`, `lanterns`, `sill`, `skyward` | lit (`worldGates`)                                                      | the world's deck (`worldSky`; `worldMirrorSky` in lanterns' river), its fair cover (`World.cover`) and nearness (`World.low`) staged, tinted over `WorldSky.cloud`                                                         |
| `island`, `lake`                                | lit (none selected)                                                     | `skyClouds` over their own sky, greyed and lowered under rain each its own way                                                                                                                                             |

**Painted cumulus** (the world's, `WORLD_CUMULUS`, "World layers"): bees' authored lobed towers and
their drifting ground shadows, a picture-book style rather than a deck, are an opt-in part of the
shared world any adopter turns on with its `cumulus` knob (on in bees, off elsewhere). They stand in
front of the deck on the view's tangent plane, sink and grey into it as rain or snow closes it, and
their shadows multiply into `worldSunlit`; they draw on no cloud tier.

Not unified, on purpose:

- `island`'s far cumulus are toon billboards on the horizon, its ground shadows a lattice of puffs
  cut per cell to match them (its dome's deck is the lit tier).
- `delta` is seen from orbit: its puffs and their offset shadows are one top-down field.
- Rain tints over the world's deck (`lanterns`, `meadow`, `shore`, `sill`) and `garden`'s flat
  grey sheet are each scene's tint, not a deck; the canopy's deck is the canopy component's
  (`canopy.ts`), the giant planet's cloud bands the planet's (`planetClouds`).
- The clouds scene's thunderheads, wisps and contrails are authored towers and passage vapour, not a
  deck. Scenes whose deck comes down under rain set `World.low` (`falls`, `sill`: 1 +
  `WORLD_DECK_LOW` × storm); `country` squashes its own ray before `skyClouds`.

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
  `{ kind: "sky", part: "year" }`, a rate knob at `YEAR_CYCLE_RATE`: the renderer integrates its
  pace into the years it has run (`PHASE_year`), so moving it never jumps the date. `SKY_YEAR`
  carries the date round by them; a sim follows with `yearNow(yearAt(def, k), frame.phases.year)`.
  Keep the year continuous. A
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
  light and colour that follow the season smoothly (bonsai's cooler winter light; its sun stands
  lower by its dated sky), and
  `climateCold(year)`, nil from mid-spring to mid-autumn and full round midwinter, rising wherever
  the chill does, for what falls and lies (bonsai's snow, too, melts slowly only while it would lie).
  Write no cold curve of your own.

### The world clock

One model of where the sky stands, `src/world-clock.ts`: TypeScript for the sims and the lab
(`skyNow`, `skyState`, `timeOfDay`), its GLSL mirror `worldClockGlsl` compiled into every program
by the sky library (`skyAt`, `skyAtWorld`, `skyMoonPhase`, `skyStarFrame`), checked against each
other on the GPU by `worldClock` (`src/world-clock.verify.ts`). A sim or a lab part that needs the
hour, the daylight or the night reads `skyNow` (forest's spirits, the garden's drying, the bees'
hives shutting at dusk and their glow-worms lighting after it, the lab's "See it at night" and its sky dial);
never write a day curve of your own.

- **Staged by default.** The sky is a low-latitude one (15 degrees) facing the equator, the pole
  low behind the viewer: a winter sun's arc (-28 degrees) in front, the K_time warp keeping sunrise
  at .25 and sunset at .75. Every undated scene draws exactly that sky on any date.
- **The day cycle is a phase.** `K_cycle` is a rate knob (`DAY_CYCLE_RATE`): the renderer
  integrates its pace into the days it has run (`skyDays()`, a sim's `frame.phases.cycle`), wrapped
  at a year of `YEAR_DAYS` (365) days, whole days for the hour and whole turns for the stars. So
  moving the pace never jumps the sun or the stars, and switching the cycle on starts it from the
  hour on the knob, as the lab's dial shows it.
- **Dated skies.** Every scene that keeps a season (a season knob whose default is a time of year:
  autumn, bonsai, country, falls, garden and tidepool draw a sky with it; pond has none) gets
  `SKY_DATE_ANCHOR`, its own default
  date (`skyAnchor`): there its sky is the staged one, and as the date moves the sun's declination
  moves by Earth's change since that date (23.44 degrees either side of the equinoxes'), the warp
  following its sunrise hour angle so sunrise stays at .25: a higher, longer arc in the same twelve
  hours by summer. The staged full moon swings the other way, eased onto a soft floor 3.8 degrees
  below -64.17 (`fullMoonDeclination`; the knee is the countryside's lowest, so its dates stand as
  they did) so it still clears the horizon, low and golden, on a garden's summer night. Each scene is
  staged at its own default date, so one date stands each scene's sun where its own staging puts
  it: a passage cutting between two dated scenes on one date shows two suns. The climate stays the
  climate's (`hasClimate`: a season and a snow knob). The sky reads the date in ten-thousandths of a
  year, so a date the passing year reaches draws as the same date set.
- **The moon by its phase.** K_moon runs through a lunation: 1 is the staged full moon every
  default draws; below it the moon waxes, its lit share K_moon, above it wanes, its lit share
  2 - K_moon (the shared knob reaches 1.95). A lesser phase stands `acos(1 - 2 lit)` from the sun
  along its daily circle, east of it while it waxes and west of it while it wanes. A waxing crescent
  hangs over the sunset and a first quarter a quarter of the sky east of the sun; a waning gibbous
  moon rises late in the evening, the last quarter round midnight, and a waning crescent comes up
  just before the sun. The staged full moon stands ~105 degrees from the sun, not opposite it, so
  from a lit share of 0.9 (`MOON_STAGED_FROM`) either side of full the moon moves off its
  elongation onto it (`moonStaging`): its place runs on with its phase, never jumping as it passes
  full. Its light on the land, the moonlit sky round it and its halo follow the measured lunar
  phase curve (`moonPhaseLight`, Allen's: a half moon gives 0.09 of the full moon's light, a
  quarter 0.026), while its disc is drawn lit by its share.
- **The stars turn.** With the day cycle on the stars, the constellations, the world's Milky Way
  and the sky's fixed planets turn about the pole a sidereal day's turn a day (`sky.starTurn`; look
  anything fixed among the stars up at `skyStarFrame(sky, dir)`, and take how high it stands from
  `dir` itself, as `milkyWay(dir, height, band)` does); in a dated sky they turn once more a year as
  the date moves. Still, they stand as staged. The aurora stays a staged object.
- **Haze takes on the dome, not the discs.** `horizonHaze` is `skyDome`: the sun's aureole
  brightens far haze toward it, but no disc paints a bar into distant land.
- **Overcast reaches the horizon.** `skyClouds` fades its deck toward the horizon against crawl;
  past broken cloud (cover 0.6) that fade gives way, and an overcast (1) closes right down to it.

**Stage 2: one sky composer.** The outdoor scenes with sky and weather knobs of their own compose
their sky through the world too: autumn, frost, sill, falls, skyward and lanterns draw `worldSky`
(lanterns `worldMirrorSky` in its river as well) from `worldAt`, light their land with `World.sky`
and close their sky by `weatherOvercast` and the `WORLD_DECK_*` shares; none keeps a dome, an
overcast curve, a moon, a star field or a meteor schedule of its own. They keep their knobs
(`skyKnobs`, `weatherKnobs`) and compile in, at every setting, each part those knobs can show
(`worldGates`; their own birds stay theirs, `WORLD_BIRDS` 0). What stays theirs is staging and
tint, each through a parameter of the world's:

- the view: its yaw (falls half turned from the sun, lanterns 20 degrees toward the sunset,
  skyward's street half round from the sky), its own ray where the camera is not the level pinhole
  (autumn's widened frame, skyward looking up), a footprint widened by what blurs it
  (frost's frost, sill's wet glass) or by a rough mirror (lanterns' river);
- the deck's fair cover where the scene has no clouds knob (`World.cover`: frost and falls 0.3,
  closing from there with the overcast) and how near it stands (`World.low`: sill and falls
  1 + `WORLD_DECK_LOW` × storm, skyward 1/1.9 so a few cloud bodies fit its strip of sky); the
  wind is the world's, turned into the sky's frame by the view's yaw (`worldDeckDrift`), so a view
  turned half round (falls, skyward) sees its deck drift the way its rain slants;
- the stars' density (`World.stars`: ×1.7 over frost's woods) and falls' aurora, lifted over its rim
  (`WorldView.auroraLift`);
- each one's tint over `WorldSky.col` where `WorldSky.cloud` says the deck is (frost's town glow
  and, as it snows, its snow cloud's pink round sunset, `FROST_DUSK`; sill's and skyward's city
  glow, falls' grey, lanterns' warm river grey, autumn's cool grey), what the overcast makes of the
  deck's gaps beyond the world's grey (`worldGrey`, which every adopter's gaps take: frost lights
  them with its cloud by the overcast's share; sill and skyward fill them with their own deck), and
  of its light: the moon
  hidden by the deck as the sun is (`WORLD_DECK_SUN`) where the scene keys its light by it.

The moon is the world's in its phase everywhere. Lanterns, with no moon knob, has the staged full
moon, which rises out of its narrow dusk frame on the right (no shared crescent can stand in that
frame at dusk: a young moon stands 18 degrees or more over the sunset, above it); its own crescent
fixed in the frame and its sparse screen stars are gone, the world's stars drawing its sky and its
river, though in a strip of sky no higher than 13 degrees their fade toward the horizon leaves few.
The planets stand in the sky's frame, so lanterns' and skyward's placement pads turn with their
views. Lake moves together with aurora, its moon and stars with it.

The sky state stays the world clock's throughout. A later step may upload the clock's per-frame
values as uniforms once its GPU mirror has shown the float32 results agree cell for cell.

### World layers

One world for every outdoor scene: the sky, its weather and what flies in it come from one state,
read from one set of knobs and composed in one order, so the scenes differ only by their camera and
what they put in the world. A setting means the same thing everywhere: rain 0.4 closes the sky as
far, dims the sun as much and falls at the same depths in every scene that adopts it. The GLSL is
`worldGlsl` (`src/shaders/lib/world.ts`, opt-in; it composes `birdsGlsl` and `milkyWayGlsl` itself,
so an adopter does not include them again), the knobs and gates `src/scenes/world.ts`. The adopters
are meadow (the first), shore, dunes, bees and swell with the world's knobs (`worldKnobs`), and with
sky and weather knobs of their own (`worldGates`, "Stage 2" under "The world clock") autumn, falls,
frost, lanterns, sill and skyward.

```glsl
struct World {        // the world now: worldAt, once per pixel, before anything is drawn
  Sky sky;            // clock, sun, moon in its phase; light under the deck (+ aurora glow, lightning flash)
  float time, tm, tf; // time of day 0..1, the motion clock, the fall clock
  float year, chill, cold;               // the date (SKY_YEAR, -1 none); climateChill, climateCold of it
  float rain, snow;   // what falls: the knobs (0 while off or gated out), the cold's share of the rain as snow where the season sets the climate
  float wet, lying;   // uWeather: how wet the ground is, how much snow lies on it
  float fog, wind;    // K_fog; K_wind -1..1 left to right in the camera's frame
  float storm, overcast, heavy, cover;   // max(rain, 0.85 snow); weatherOvercast; heavy rain/snow; K_clouds thickened (the overcast's alone without K_clouds)
  float low, stars;   // the deck's nearness (1; the scene may set it); the stars' density (K_stars; the scene may scale it)
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
  float auroraLift;   // 0; how much higher the aurora's arc stands (falls' rim)
};
WorldView worldView(vec2 uv, float horizon, float focal, float eye, float yaw, float unit);
WorldView worldViewOf(vec3 ray, vec2 uv, float horizon, float focal, float eye, float yaw, float unit); // the scene's own ray
vec2 worldDeckDrift(World w, WorldView v);                    // the camera's wind on the deck, turned into the sky's frame by the view's yaw
vec3 worldGrey(World w, vec3 col, float open);                // the grey day: col greyed and darkened under rain or snow, by open (1 open sky, 0 behind the deck)
float worldFogAt(World w, float metres, float height);        // the world's fog over metres to a point height metres up
struct WorldSky { vec3 col; vec3 strike; float cloud; };      // cloud: the deck's and the cumulus' alpha
WorldSky worldSky(World w, WorldView v, vec4 meteorField);   // behind everything; what its cloud leaves open greyed by worldGrey
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

- **The world** (`worldAt`). The clock is `timeOfDayM(K_time, skyDays())`, the moon takes `K_moon`
  (under `SKY_MOON_PHASE`). The date is `SKY_YEAR`, its `chill` and `cold` the climate's. Where the
  season sets the climate (a season and a snow knob: `#ifdef K_snow` and `SKY_YEAR`), the rain and
  snow are what falls, `climatePrecip(K_rain, K_snow, cold)`, so a winter's rain snows (and
  `worldFeatures(values, true)`, which `worldGates` passes for such a scene, compiles the snow in
  with the rain); without a season the cold is 0 and they are the knobs exactly. `wet` and `lying`
  are `uWeather`: draw wet and lying snow from them, never from the knobs. Rain and snow close the
  sky by `weatherOvercast`; the deck's
  cover is `max(K_clouds, overcast)` (the overcast alone in a scene with no clouds knob, which sets
  its own fair cover); `heavy` is `smoothstep(0.35, 0.9, storm)`. Under the deck the sun's light
  fades by 0.88 × overcast, the ambient greys by 0.6 × overcast and darkens by 0.3 × storm, the
  twilight fades by 0.7 × overcast; the aurora's glow (behind the deck) and the lightning's flash
  light are added to the ambient. With no weather, `w.sky` is the clear sky exactly. Light the
  scene with `w.sky`; dim or tint it further as the scene needs. Its staging is the scene's to set
  before `worldSky`: `low` (1; above 1 brings the deck nearer, so it looms larger and reaches nearer
  the horizon, for its shadows too: 1 + `WORLD_DECK_LOW` × storm where rain brings it down; below 1
  fits more of it into a narrow strip of sky), `stars` (`K_stars`, scaled for the scene's own sky)
  and `cover`.
- **The view** (`worldView`, or fill the struct). `ray` is the camera's ray in the shared side-on
  frame, `dir` the same ray in the sky's frame (`yaw`: the turn that takes one to the other), `foot`
  the level of detail for the stars, the aurora and shooting stars. Distances handed to the world
  (`z`) are in the scene's units, `WORLD_FAR` for open sky; `unit` turns metres into them, as
  `BirdCamera.unit` does: rain and snow fall at `weatherDepth(z / unit)`, fog reckons in metres,
  and the deck's shadows are cast from 1000 m up. `auroraLift` (0) raises the aurora's arc for a
  view that sees the sky only high over a rim: each ray's slope is looked up that much lower.
- **The order.** `worldSky` first, behind everything: the dome (sun and moon discs), the aurora
  ahead of the camera behind the clouds, the cloud deck, the painted cumulus in front of it, the
  Milky Way, the stars and the sky's planets in their gaps, shooting stars (from `meteorField`,
  `skyAngles` of the camera's ray), all that the cloud leaves open greyed under rain or snow
  (`worldGrey`), then the lightning, kept apart in `strike` (the bolt from a cloud base ~12° up to
  the horizon, the flash's glow) so a scene that tints its sky draws `tint(col) + strike`; `cloud`
  is the deck's and the cumulus' alpha along the ray. Then the scene's distance, land and near
  things, keeping `z`, the distance to the first opaque thing in its cell. Then `worldBirds` where a
  bird is nearer than `z` (it takes the cell and `z`), lit by the sky and hazed by
  `exp(-depth * thick)` into the scene's `haze`; anything the scene draws nearer than the birds
  after them; then `worldFog` to `z` and `worldPrecip` to `z` (rain toward the scene's `air` and
  `dropLight`, snow in the sky's and the sun's light), each fading the accent under its veil.
  `worldOver` does the last three at once for a scene with nothing in between.
- **One wind.** `K_wind` is the camera's: left to right across the view, as the knob's help says.
  It slants the rain and the snow and drifts the cumulus and their shadows along the camera's x,
  and the deck the same way: `worldDeckDrift` turns the deck's drift (`cloudDeckDrift`: sideways
  with the wind, creeping toward the eye) into the sky's frame by the view's `yaw`, for the deck,
  its shadows (`worldSunlit`) and the mirror alike. A scene never flips `w.wind` for its view.
- **One grey day.** Under rain or snow `worldSky` and `worldMirrorSky` grey and darken what their
  deck leaves open as the light under the deck is (`worldGrey(w, col, open)`: 0.6 × the overcast of
  what falls, 0.3 × the storm, times `open`), so the gaps read as thinner cloud, never clear blue.
  Exactly the sky in dry weather. A haze a scene takes off the dome (`horizonHaze`) takes
  `worldGrey(w, haze, 1.0)`; a scene that greys its deck too gives it the deck's alpha (dunes,
  meadow), and keeps only what it adds beyond (meadow's cooler grey, darker overhead; shore's own
  cloud base by the overcast). It follows what falls, not a scene's own closing of `w.overcast`
  (dunes' sandstorm).
- **One fog.** `worldFogAt(w, metres, height)` is the world's fog in metres (`fogAmount` over
  `1 - exp(-metres / 60)`, thinning up through the 40 m layer); `worldFog` lays it to `z`. A scene
  with geometry of its own reckons its fog through it rather than a normalisation of its own.
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
  the deck lit by the true moon and the cumulus in front of it, the Milky Way and the stars, the
  sky's planets (under the mirror's sky, so no undrawn moon cuts them), shooting stars, greyed as
  the sky is, all at the mirror's
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
  within their hours. A scene with sky and weather knobs of its own (`skyKnobs`, `weatherKnobs`)
  takes `worldGates(params)` as its `features` instead: every part its knobs can show compiled in
  at every setting (lightning only with a lightning knob, the moon's phase only with a moon knob),
  each still neutral while its knob is off; it sets a part it draws its own way to 0 over them (its
  own birds: `WORLD_BIRDS`).

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
col = meadowDeck(worldGrey(world, heaven.col, heaven.cloud), above, world.overcast, world.storm) + heaven.strike;
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

- Meadow greys the world's deck as the world greys its gaps (`worldGrey` by the deck's alpha) and
  keeps what its overcast adds beyond (`meadowDeck`: a cooler, lifted grey, darker overhead), its
  hills, tree line and
  mown M, its rain shafts and gust curtains and the rain's mist over the distance (all inside
  `WORLD_RAIN`), its golden haze, its wet grass and the snow lying on its grass, hills and trees
  (read from `uWeather`, compiled in always, so they dry and melt after the knob is off), its drop
  light, and the ground points of the deck's shadows (the field and the tree line where each ray
  meets them, the hills 1500 m off, the near grass at the eye's feet).
- Shore keeps its storm bank out at sea and the bolts it drops (on the world's strike timing and
  flash; it leaves out `strike`, whose bolt falls from ~12° up, outside the bank) with their image
  in the sea; its rain sky over the world's deck and grey gaps (its own cloud base closing over by
  the overcast, the light gap on the horizon, the rain shafts); its thinned drops (`worldPrecipThinned`, 0.55 far to 0.35 near, so they never bury
  the surf); and the moon's phase compiled in at every setting (`features: { SKY_MOON_PHASE: 1 }`:
  the glitter magnifies the last bits of the moon's direction that the phase code shifts, so a full
  moon's own program would not draw byte for byte as the all-features one).
- Swell keeps its long lens (a focal of 2: the full moon large over the sea), its frame turned
  toward moonrise (`SWELL_FACING`), and its scale: a camera height, some 15 m, is the scene's unit
  (`unit` 1/15). The world's wind raises and turns its wind sea and chop and roughens the glitter
  (Cox & Munk's variance grows with it); the sea mirrors the world's sky through `worldMirrorView`
  (blurred by its slopes), and cloud along the mirrored ray hides the moon's path. Under rain or
  snow it dulls the world's deck toward the rain's grey (its narrow strip of sky draws the deck's
  moonlit edges out into bands), and hangs `rainShafts` out at sea. The lighthouse's beams are its
  own (lit cones scattering in the world's fog, rain and snow) and are drawn after `worldFog`, the
  lamp's glow through the fog after them; the moon's phase is compiled in at every setting, as in
  shore.
- Dunes' fog is the desert's dust: the shared `fog` knob drives its own haze (with a hard wind, the
  sandstorm) and it never calls `worldFog`, whose fog assumes an eye near the ground (dunes' eye
  flies ~80 m up, looking 1–4 km out). A grid cell is 5 m (`DUNES_UNIT`, 0.2 cells per metre);
  its view is `worldViewOf` along the ray the heat shimmer bends and the pointer turns; a sandstorm
  raises its copy of the world's overcast before `worldSky`, so the aurora and shooting stars fade
  behind the dust (the world's grey day follows what falls, so the dust does not grey the sky). Overhead it takes the world's light, cloud shadows (cast from the deck over the
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
  (`wetten` on every albedo, as one matrix set once per cell, the lawn's and the things' sheen of the
  low sky by `wetGloss`) and the snow lying on the lawn and the path, the hills' fields, the
  lavender, the wall's top, the hives' roofs and the crowns, read from `uWeather` and compiled in
  always; its swallows' lanes (8–150 m out, over the hills, swooping to 1.2 m), which hide the
  insects behind them; its insects, lit by the world's light where they are drawn (their colours as
  seen in its default afternoon, `BEES_SPECK_DAY`; the glow-worms' and fireflies' lights their own)
  and drawn before the haze, the fog and the rain and snow, at their own depth; and the moon's phase
  compiled in at every setting (`features: { SKY_MOON_PHASE: 1 }`), since the moon keys its night
  light and shadows, as shore's glitter does. Its seed (`K_scenerySeed`) re-seeds the world's
  cumulus (`w.seed`).

Not in the world yet: views from straight above (the world's sky and birds are drawn for a level
camera, so dunes' overhead view has neither); a scene that needs them keeps its own for those parts.

## Simulations (`sim`)

When a scene needs state (particles, a height field, ink, a growing crystal, the pointer's wake),
give it a `sim: (gl) => SceneSim`. Each frame the renderer calls `frame(SimFrame)` (dt, time,
motionTime, motion, now, budget, size, knob values, raw params, triggers, fired, pointer (the
visitor), principals (everyone present: the visitor, then the cast's agents; see "Principals"),
parallax,
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
a seed plays the same at 60 and 144 Hz. Draw the sim's chance on those steps too, never once a
frame (a draw a frame, or a chance of `dt`, plays differently at each frame rate): what is drawn
a frame or an event at a time takes a stream of its own (bamboo's leaves, apart from its gusts),
and a layer stepped on a clock of its own steps in time with what it rides on (dew's drops, each
step between the web's substeps at its own moment). `src/sims/frame-rate.test.ts` holds every sim
that runs headless to it: run from the same first frame at 60 and at 144 Hz, each texture it hands
the shader agrees within 1 % of its range after 1 s and 2 s. Its table lists the sims on the GPU
(browser only) and the textures exempt, each with its reason (what is stepped or uploaded once a
frame); fix the sim rather than add an exemption.
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
  top; a 16f texture from float32 values or from the half floats' own bits, `halfBits`, which go up
  as HALF_FLOAT at half the bytes), whole (`upload`) or only the rectangle that changed
  (`uploadRegion(data, x, y, w, h)`, read in place from the whole array), or `uploadImage(canvas)`
  for an rgba8 texture drawn with Canvas 2D (top row = uv.y 1). `DirtyRegion` keeps what changed
  since the last upload, one rectangle or one per tile (bands of rows, small squares), marked as
  the sim writes and sent by `flush`: the harmonograph's ink and the Chladni plate's sand (in bands),
  the flock's density, the bees' specks (in 8 × 8 squares), the countryside's cover.
- `TrailField` (`trail.ts`): where the pointer has been, fading; for stirring and melting. A
  `stroke` lays ink per unit of path (a pass leaves its `strength` along its middle, at any speed
  and frame rate), a `hold` a rate's worth of it at one point (a pointer held still).
- `VerletSystem` and `PointTexture` (`verlet.ts`): 3D XPBD chains, nets and orb webs (compliance
  in physical units, so a thread is as stiff at any substep; a slow swing keeps its energy at a
  short substep, while faster modes and compliant ringing lose about ω²h/2 a second of the solver's
  own, halved by halving the substep), with impulses and nearest-point queries, stepped by the
  caller's FixedStep and packed into a texture for `texelFetch` (kelp, dew, the mobile).
- `springStep` (`spring.ts`): the damped spring every sim eases a swinging value with (plants,
  meadow, bamboo, the fireflies' lantern, ferro's pool and spikes, the prism let go, the sand
  table's ball), the exact step on a fixed h: stable at any ω h, ringing and dying at the tuned
  rates; springs each with an ω of their own (the plants' organs) keep `springCoefficients` and
  step by `springStepBy`.
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
  velocity, pearl's flakes and dye, the soap film's thickness and cover).
- `ArrivalField` (`front.ts`): when a front spreading from one point through a field of speeds
  reaches each texel, on the GPU (least time along rays from the source, then a few relaxing
  sweeps), so `T <= t` is where it has been: film's burst rim racing through thin film and crawling
  through thick.
- `ShallowWater` and `stillWater` (`shallow.ts`): shallow water over a bed on `GpuCompute` (a
  well-balanced finite volume scheme: HLL fluxes over a hydrostatic reconstruction, outflows limited
  to what a cell holds; first order, or at `order: 2` MUSCL–Hancock, whose waves keep their height
  as they travel) that runs downhill, sloshes, shoals and breaks, its bores at their true speed
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
  buildings, settlements, the bridge, the eye, the map's highest ground or water, cores, ways and
  way points), which `terrainGlsl` reads: `terrainGround`, `terrainCover`, `terrainParcel` (exact
  field borders between texels, and the neighbour's id), `terrainCore`, `terrainBuilding`,
  `terrainPlace`, `terrainBridge`, `terrainEye`, `terrainTop` (no rising ray above it meets the
  land), `terrainWay` and `terrainWayAt` (a point by arc length along a road, always on it)
  (country); `LandModel` and `packLand` (`landuse.ts`): every parcel's one use from relative
  shares, priced so that a share's change converts only that use's marginal parcels, written into
  the records, the woods' canopy and their species (`LAND_PINE_FLAG`); `repackLand` rewrites only
  what a new allocation moves and reports the rows of each texture it changed (country). A builder
  given an earlier one of the same land and river (`TerrainBuilder.riverKey`) keeps the carved
  river and what is made of it alone (the settlements' sites, the woods' patches, the parcel sites
  and their cells by the bare metric), as `landGround` keeps the land model's weights and ranks: a
  settlement or road switched rebuilds in about a quarter of a fresh build's time.
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
  land, frost's crystal field, dew's web (the first, and for a new seed or shape), the bonsai's tree
  drawn into its maps, the dry garden's layout, the forest's warm-up, the slime mould's fresh dish,
  the pond's sheets. A scene's kind and the code it runs live in the scene's own `build.ts` (the
  pond's in `sheet.ts`), which never imports its `sim.ts`, so the worker carries no scene's sim; the
  sim imports the kind and whatever of the build it shares (dew's `DewWeb`, the forest's
  `ForestLife`). One slot per sim, asked every frame: the newest request wins (a superseded build is
  dropped on the worker and never lands), the scene draws what it last adopted meanwhile, and a
  result is byte for byte the page's (the same code; `build-worker.test.ts`). Without a worker, and
  for a frame of Infinity budget (HeadlessSim, checks), the build runs on the page in slices. A
  kind's result must own its arrays (copy what its builder keeps for reuse); state classes hand
  themselves over as plain arrays (`VerletSystem.state`/`from`, `LandModel.data`,
  `FlowNetwork.state`, `Random.state`, `TreeMaps.state`, the forest's `ForestLife.state`).
- `mulberry32` and `Random` (`random.ts`): the seeded generator, bit-exact with the scenes' copies
  so a seed keeps its arrangement; `Random` adds `range`, `int`, `pick`, `wait` (the gap to a
  Poisson process's next event: street's arrivals) and `gauss` (roughly normal from three draws:
  lake's crack walks) and re-seeds in place.
  Import it rather than carrying a copy (ferro's xorshift is deliberate: its pours depend on it).
- `clamp`, `lerp`, `smoothstep`, `fract`, `hash31` (`math.ts`): import them rather than a local copy;
  `approach(x, to, dt, tau)` and `easeFactor(dt, tau)`: the exponential ease `x + (to - x) · (1 - exp(-dt / tau))`
  (a lag, a smoothing, a fade) and its factor for a loop that eases many values at once, so no sim
  writes the `1 - Math.exp(-dt / tau)` out again;
  `glslHash12` and `glslHash22`: common.ts's hashes in float32 steps, for a sim that must place
  things where its shader hashes them (pond's koi loops, falls' ferns, the tide pool's holdfasts);
  `hypot2`, `hypot3` and `atan2`: V8's `Math.hypot` and `Math.atan2` (Chrome's) bit for bit in any
  engine, for a seeded layout that must come out the same in every browser (each engine rounds
  them its own way): country's terrain, land use, chalk M, verges and fog floor.
  `country/engines.test.ts` builds three landscapes in JavaScriptCore (bun) and V8 (node, skipped
  without one) and compares every part, so another `Math` call that rounds apart there shows.
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
- `Settle` (`clock.ts`): the relayout debounce for a sim whose layout comes from knobs: `due(want, frame.now)` is true
  at the first frame and then once a changed key has rested `ms` (delta, dunes, garden, tidepool); `lay(key)` records
  the layout made, `laid` is the one on show.
- `FixedStep` and `runBudgeted` (`clock.ts`): a fixed-step accumulator (`advance` returns the steps
  due, each falling due 5 % of a step early, so a 60 Hz display's jittered frames run exactly one
  1/60 step each; `alpha`, `lag(i)`), and warm-ups counted in steps, which a time budget only
  spreads over frames, so the opening picture never depends on the machine's speed. Sims step on one
  and draw between their last two steps by `alpha`; a few draw ahead of the last step by
  `pending` instead, along its motion (fish, the forest's motes and stag, dew's drops, the harmonograph's pen,
  which must stay over the ink its step laid). A solver whose step follows a knob counts in steps
  (`new FixedStep(1, max)` advanced by seconds / step: ripple's tanks).
- `pendulumStretch`, `pendulumAngle`, `pendulumFadingSwings` and `pendulumGlsl` (`pendulum.ts`): a
  pendulum swinging beyond the small-angle approximation, the same maths in TS and GLSL (pendula's
  real pendulums).
- `toHalf` and `splitHalf` (`half.ts`): a number as two half floats (hi + lo) for a 16f texture,
  decoded in GLSL by `unsplitHalfGlsl`. `halfBits` and `halfValue`: a number as the binary16 bit
  pattern GL makes of a float32 upload (ties to even), and back, for a field kept as halves beside
  its float32 copy and uploaded as half floats, at half the bytes (chladni's sand).
- `BinLists` (`bins.ts`): per-bin lists of the segments and points that reach each square bin of
  the frame, for a shader that walks only its cell's list (dew); a list grows by pages of
  `BIN_PAGE` entries, so a dense patch never drops one. Read in GLSL with `binListsGlsl`.
- `SpeckMap` and `followCell` (`specks.ts`): creatures a cell or a few across drawn into an rg8 map,
  one per dither cell with its depth, the nearest winning the cell whatever the plotting order, so
  the shader hides each behind only what stands in front of it; `upload(texture)` sends only the
  cells whose bytes differ from those it last sent, by 8 × 8-cell tiles (a `DirtyRegion`), so a
  speck cleared and plotted again where it was sends nothing (the bees at 960 × 540 cells: about 20
  rectangles and 3 KB a frame for the default garden, 50 to 70 and 7 to 24 KB for 200 bees and a
  swarm, not the 1 MB map); `followCell` keeps a hovering speck from flickering
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
  data as uploaded, sub-rectangles and half-float bits included (anything else throws, naming the
  call); `HeadlessSim` drives a scene's real sim on it (or on a real context) with frames built as
  the renderer builds them: knobs over their defaults, "now" presses by knob, pointer, passage.
  `step(frame).upload(slot)` is what the shader would sample. Where the runtime has no
  OffscreenCanvas (bun) it stands in `HeadlessCanvas`, which keeps its size and draws nothing, for a
  sim that paints with Canvas 2D (marble).
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
- `Mobile`, `MobileTexture`, `mobileGlsl` (`mobile.ts`): a balanced hanging mobile on
  `VerletSystem` with balls, arms hung from a parent's end or loop, drag, contacts and motors that
  hold an arm's rate (`drive`), its constraint passes growing with its arms, and GLSL tracing its
  balls, wires and links and the shadows they throw from a round lamp (mobile's solar system).
- `Boids` and `boidRules` (`boids.ts`): topological boids in 3D for flocks and schools of a few
  thousand: separation, cohesion and alignment with each boid's K nearest, found through a spatial
  hash with a bounded search (refreshed by turns), plus cruise, level flight, a home to wheel over,
  a threat (about a point, or along a line such as a predator's line of sight, pushing across it),
  wind and noise, and startles relayed through the neighbours as a wave. Deterministic for a seed;
  the rules are one mutable object the caller sets each step (the murmuration's emergent flight).

Outside `src/sims/`: `src/mark.ts` is the Manifold M for TS (`MARK_VERTICES`, `markVertex`,
`segmentDistance`, `markDistance`) and the source of the GLSL one (`markGlsl`), so a stamped M and
a drawn M cannot drift; `src/shaders/glsl.ts` writes GLSL from TS: `glslFloat` (an exact literal,
tiny constants included), `glslVec3` (from `"#rrggbb"` or a triple) and `glslPick(knob, cases,
fallback)` (a palette table of `if (K_<knob> < i.5) return ...;` lines); `src/constellations.ts`
sends the constellation figures as `common`'s `uCon*` uniforms (orbit's, and the night sky's
constellations that `skyStars` draws; brightness four stars and lines two to a `vec4`, read with
`conBright(i)` and `conLine(i)`). A module only one scene uses lives in that scene's directory:
the pond's `botany.ts` and `atlas.ts` paint its plant atlas (the sprites `PlantSheet` cuts out) and
its canopy sheet, on the build worker (`sheet.ts`).

Keep simulations cheap (a few ms per frame at most) and scale step counts with `dt * motion`.
Sims must be deterministic for a given seed knob and survive `dt = 0` (paused) and resizes. A layout
a resize must rebuild waits for the new shape to rest first (garden's re-layout, frost's regrowth,
dew's respin) and builds it off the page where it can (its `build.ts`), and keeps what it can: frost
seeds each site's draws by where it stands, counted in from its own side of the pane, so a resize
keeps its pattern.

Knob keys share the URL with the lab's own settings, so a knob may not be called `accent`,
`scene`, `mode`, `dither`, `color`, `pixel`, `levels`, `motion`, `instance`, `mouse`, `agents`,
`rest`, `view`, `dim`, `blur`, `transitions`, `overlap`, `weave`, `blend` or `slowmo`, nor take the keys of the lab's session tools, `compare`, `tour`
and `dwell` (`state.ts` refuses to load such a scene).

## Composers

**Status: design only.** This section comes from ADR 0062
(`docs/decisions/0062-world-composers.md`, proposed), for #1082 item U1. Nothing in it exists yet:
it is the contract the phases build, and it turns into a description of the code as each phase
lands. The ADR keeps the reasoning, the measurements, the phases, the per-scene risks and the
decisions still open (D1–D12).

Most outdoor scenes show the same thing: a camera on the ground at eye level, something in front
of it, a landscape behind, the sky above. A **composer** makes that shared: one camera rig, one
site (the floor everything stands on), one light, one weather and one order of composition. On top
of it stack **layers**, each a module from a scene. Three composers cover the roster:

| Composer   | Rig                                                                                                                                                                                            | Site                                                                                                                                                                                                | Scenes, by phase                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outdoor`  | A pinhole on the ground: eye height, turn (the yaw to the sky's frame), horizon, focal, pitch, a lens shift for passages, and `minAspect` (narrower frames are laid out this wide and cropped) | The floor plane y = 0, in metres in the rig's frame (x right, z ahead), of one floor kind (earth, lawn, gravel, sand, rock, moss, ice, snowfield, water, asphalt) unless a ground layer replaces it | 1: meadow, bees. 2: shore, autumn, falls, lanterns, dunes, campfire, fireflies, forest, bamboo, garden, lake, country, street, skyward, flock, swell, dew |
| `interior` | A pinhole in a room box, with a window on the back wall; rays through the window continue as an `outdoor` rig                                                                                  | Floor, walls and ceiling, with their kinds; one ledge across the front (sill, counter, table, sideboard, stand); the window's glass                                                                 | 3: sill, lava, bar, train, bonsai, mobile, incense, frost, clouds, harmonograph                                                                           |
| `overhead` | A patch seen straight down, at so many metres per screen height; a `tilt` feature and an `orbit` range, both steady                                                                            | A bed (a height field in metres), water over it from a layer's sim, and a material at each point                                                                                                    | 4: pond, ripple, sandtable, tidepool, delta, island, and garden and dunes from above                                                                      |

Fractal, hyperbolic, orbit and shanshui stay scenes of their own. The matter shelf and kelp are
open (ADR 0062, D7).

A preset fixes its rig, as compile-time constants, so a preset's own layers draw as their scene
drew them. Passages move the rig at run time, as they move the cameras today: meadow's drop,
autumn's lens shift, forest's dolly. The World ("World layers") is in every composition: it is
the layer every stack has. Everything the World asks of a scene (the camera, the depth of what
each cell shows, the haze, the air, the drop light) the composer now provides.

### Layers

A layer lives in its origin scene's folder (meadow's `grass` in `scenes/meadow/`). Its composer's
registry lists every layer in **canonical order**: the order layers are placed in and paint in.

```ts
interface LayerDef {
  id: string; // camelCase: the layer's switch key, and the prefix of its qualified keys
  composers: readonly ComposerId[]; // "outdoor" | "interior" | "overhead"
  role: "backdrop" | "ground" | "dressing" | "cover" | "life" | "chore";
  subject?: boolean; // a dressing that holds the front band
  bands: readonly ("far" | "middle" | "front")[]; // beyond ~60 m, 6–60 m, within ~6 m
  space: { anchors: readonly Anchor[]; claims: readonly Claim[] }; // metres, from the anchor
  camera: { eye?: Span; pitch?: Span; scale?: Span }; // the rigs it can be drawn through
  display?: { scale: number }; // a declared readability cheat: the apiary's hives at 1.5
  switch: ParamDef; // steady: a toggle, or the feature knob it grew from (meadow's dandelions)
  params: readonly ParamDef[]; // hung on the switch with `when` by the composer
  groups: Readonly<Record<string, Blurb>>;
  triggers?: readonly string[]; // named "now" slots: the composer numbers them
  lights?: readonly LayerLight[]; // position from the anchor, reach, GLSL colour function
  glsl: string; // functions and consts prefixed with the id
  passes: LayerPasses; // the GLSL names of its passes (below)
  features?: Readonly<Record<string, number>>; // its own gates, prefixed with its id
  featuresFor?: (values: Readonly<Record<string, number>>) => Readonly<Record<string, number>>;
  featuresAll?: Readonly<Record<string, number>>;
  sim?: (gl: WebGL2RenderingContext) => LayerSim;
  excludes?: readonly { layer: string; why: string }[];
  suppresses?: readonly { gate: string; why: string }[]; // another layer's gate it turns off
  requires?: readonly string[]; // a chore's host
}
```

A layer's cost (shaken KB, uniform vectors, sim textures, SwiftShader milliseconds, each a margin
over the composer's base) is never written by hand. `scripts/layer-costs.ts` writes it to
`src/compose/costs.json`, and a check fails while that file is stale.

| Role     | How many                                           | Examples                                                            |
| -------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| backdrop | exactly 1; another swaps it                        | meadow's downs, bees' hillside, campfire's pines, the sea, the city |
| ground   | at most 1; without one, the plain floor            | bees' lawn, garden's gravel, shore's beach, lake's ice, a river     |
| dressing | any number; at most 2 `subject`s in the front band | the apiary, the campfire, the maple, the water clock, the cat       |
| cover    | any number                                         | meadow's grass, wildflowers, leaf litter, moss                      |
| life     | any number                                         | bees' insects, the fireflies' swarm, the koi, a murmuration         |
| chore    | any number, each with its host on                  | leaf raking, cairns, sand raking, star-joining                      |

A layer's GLSL reads only:

- the common uniforms;
- `K_<key>` for its own knobs and the composer's;
- the `Ctx` its passes are given;
- the composer's functions;
- its own data, through accessors the assembler generates.

It never reads another layer's knobs or `uSimN`. It also obeys these rules:

- **Units.** It draws in metres in the rig's frame.
- **Order.** It keeps its parts in the order its scene painted them.
- **Weather.** Its materials go through `wetten`, `wetGloss` and `snowCover` with `uWeather`.
- **Wind.** Its sway reads `gustAt(xz, tm)`.
- **Passages.** It times its entrance and exit by `layerIn(id)` and `layerOut(id)`: the scene's
  passage, or the layer's own when it is turned on or off mid-scene. At rest `layerIn` is 1 and
  `layerOut` 0, and the layer draws exactly as it would with no passage at all.
- **The M.** Its Manifold M, if it has one, is one knob in its `manifold` group. The composer keeps
  at most one M on.
- **Bounds.** Each pass begins with `if (!<id>InView(x)) return;`, the screen bounds of its
  claims, so on a GPU it costs little outside them.

### Space

A **claim** is a disc, a box with a turn, or a strip along points with a half width, in metres
from the layer's anchor. It has one of three kinds:

| Kind        | Others' exclusive or clearing claims   | Covers inside                                                       | Examples                                                 |
| ----------- | -------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------- |
| `exclusive` | may not overlap it                     | none                                                                | the hives on their stands, the campfire's ring, the wall |
| `clears`    | may stand at its edge, not in its core | thin to nothing, feathered over ~0.3 m; it may set the floor's kind | the campfire's clearing, a path, a bench's patch         |
| `shared`    | may overlap it                         | grow in by their `overgrowth`                                       | bees' flower drifts under meadow's grass                 |

A claim may also cast a key-light `shadow` (a height and a radius) on the floor and on covers,
give `shelter` (0..1: the share of precipitation and lying snow kept off beneath it), or
`keepOut` life.

**Placement.** A pure solver places the layers. Its only inputs are the preset (rig and home
layers) and the set of layers on: never the window's aspect or another knob. It places the home
layers first, then the guests, each group in canonical order. Each layer takes its first anchor
that meets all of these:

- its exclusive and clearing claims overlap none already placed;
- the front band holds at most two subjects;
- every `mustShow` claim lies in the rig's view at the preset's `minAspect`.

A layer with no such anchor is **refused**. The lab dims it and names the layer holding the space;
a link that turns it on drops it, with a one-line notice. A later layer never moves an earlier
one. So when two layers want the foreground, the preset's own layer keeps its place (else the
earlier in canonical order does), and the other steps aside or back to its next anchor, or is
refused.

Placement is a function of what a program is built for, so the claims and anchors are
compile-time constants of the program: at most 12 claims, and no uniforms. The sims get the same
placement through `LayerFrame.ground`. Anchors are part of a layer's meaning: changing a shipped
one takes a step of the URL schema, as a knob that changes meaning does.

**Relations between layers:**

- `excludes`: two layers never on together. The lab turns the other off; a link keeps the first in
  canonical order.
- `suppresses`: turns off another layer's gate while both are on. `grass` suppresses
  `LAWN_BLADES`, so the front holds one sea of grass.
- `requires`: a chore's host.
- A second backdrop or ground swaps for the first.
- A layer whose `camera` range does not admit the preset's rig is not offered at all.

### Compositing

The composer generates the entry function. Layers contribute passes, using the composer's GLSL
(`src/shaders/lib/compose.ts`):

```glsl
struct Cell { vec3 col; float z; float accent; };  // z: metres to what the cell shows (WORLD_FAR: open sky)
struct Light { vec3 sun; vec3 amb; vec3 key; float keyUp; bool moonKey; };
struct Ctx { World w; WorldView v; vec3 ray; vec2 p; float foot; Light light; float tm; float tf; };
void cellPut(inout Cell c, vec4 rgba, float z);   // opaque: where z < c.z, over by rgba.a; takes z once a >= 0.5
void cellVeil(inout Cell c, vec4 rgba, float z);  // translucent: where z < c.z, over by rgba.a; keeps c.z
float coverAllowed(vec2 xz);                      // 0 in exclusive and clearing cores, the overgrowth in shared ones, else 1
float casterShadow(vec2 xz);                      // the claims' key-light shadows on the floor, 1 lit
vec3 localLight(vec3 p, vec3 n);                  // the on layers' lights, at most 8
float gustAt(vec2 xz, float tm);                  // the one gust field (meadow's, promoted), with a CPU twin

// A layer's passes, each optional:
void <id>Sky(Ctx x, inout vec3 sky);              // backdrop: its staging over the World's deck
void <id>Ground(Ctx x, GroundHit g, inout Cell c);// ground layer: the floor where the ray meets it
void <id>Far(Ctx x, inout Cell c);    void <id>FarVeil(Ctx x, inout Cell c);
void <id>Middle(Ctx x, inout Cell c); void <id>MiddleVeil(Ctx x, inout Cell c);
void <id>Front(Ctx x, inout Cell c);  void <id>FrontVeil(Ctx x, inout Cell c);
float <id>Height(vec2 xz);                        // overhead: its share of the bed's height
```

The generated entry runs in this order:

1. The World now, the rig's ray, the light.
2. The sky (`worldSky`, then the backdrop's `Sky`); `c.z` starts at `WORLD_FAR`.
3. The floor, or the ground layer, where the ray meets the site, with claims, caster shadows,
   cloud shadows, wetness and snow.
4. Each band, far to front: every on layer's opaque pass in canonical order, then its veils.
5. `worldBirds`.
6. The local lights' glow, added to the air and the drop light.
7. `worldFog`, then `worldPrecip` (thinned under shelter), at `c.z`.
8. The shared speck map, against `c.z`.
9. The principals' cursors.
10. `shadeOf` with the preset's ink gain and gamma.

Opaque passes need no order: edges are cut per cell ("Hard edges"), so coverage is 0 or 1 and the
depth test decides. Soft alpha (fringes, glows, smoke) is why there are bands and a canonical
order. Because each layer keeps its own internal order, a preset with only its home layers draws
as its scene did.

### Light, scale and weather

- **Light.** The World's sky, times the preset's grade: the sun's and the sky's tints, an ambient
  floor, and the moon as key once the sun has set (bees' model). Every layer is lit alike.
- **Local lights.** Declared by layers and summed by `localLight`; at most 8 in a composition.
  They cast no shadows from one layer onto another.
- **The air.** The backdrop owns it: the haze colour toward each bearing, the forward scatter
  round the sun, the sky staging (meadow's golden haze and `meadowDeck` belong to `downs`).
- **Scale.** Metres everywhere; a cell spans `z / (focal · uRes.y)` metres at depth z. A cheat is
  declared in `display.scale`, and claims are sized as the layer is drawn. Each layer declares its
  scales, so the `overhead` composer refuses a pond beside a delta.
- **Weather.** The World's knobs only, applied once at the composed depth. Every layer's materials
  read `uWeather`, and `composerWeather` checks it. One wind direction (`K_wind`) and one gust
  field (`gusts`, `gustRate` and their "now" are the composer's knobs).

### Scene presets and keys

Every ported scene keeps its id, card, thumbnail, family, tour step and links. Its `SceneDef` is
generated from a **scene preset**:

```ts
interface ScenePreset {
  id: SceneId;
  composer: ComposerId;
  title: string;
  blurb: string;
  accent: string;
  look?: SceneLook;
  theme?: SceneTheme;
  passage?: { enter: number; exit: number };
  planets?: SkyPlanets;
  rig: Rig; // compile-time: horizon, focal, eye, turn, minAspect... (or the room, or the patch)
  grade: Grade; // sun and sky tints, ambient floor, moon key, ink gain and gamma
  layers: readonly string[]; // home layers, on by default
  values: Readonly<Record<string, number>>; // where it departs from its layers' defaults
}
```

`composeScene(preset)` returns the `SceneDef`:

- **`params`**: the composer's knobs (the World's, `gusts`, `gustRate`, `seed`, and `season` where
  a layer has a year), then every offered layer's switch (on for home layers), then every offered
  layer's knobs, each with `when` on its switch. An offered layer is one whose `camera` admits the
  rig.
- **`glslFor(features)`**: replaces `glsl`. It returns the prelude, the GLSL of only the layers on
  in that feature set, and the generated entry.
- **`featuresFor`**: the World's gates, `LAYER_<ID>` for each placed layer, and each on layer's own
  gates.
- **`featuresAllFor(values)`**: replaces `featuresAll`, with every gate of the layers on in
  `values`.
- **`structural`**: the layer switches.
- **`sim`**: a composed sim.

A committed preset (`src/presets.ts`) is still a saved setup of a scene, e.g. "Bees · overgrown
meadow": `scene=bees&grass=1&wildflowers=1` plus its values.

**Keys** are unique per composer, checked both ways:

- every key a committed preset names resolves;
- every knob is reachable.

A port keeps its scene's keys wherever they are unique in the composer. A key that collides with
one already taken is qualified as `<layerId><Key>` (country's `wildflowers` becomes
`valleyWildflowers`). A layer's switch is its id. Keys that move to the composer (the seeds onto
`seed`; `gusts` onto the shared field) are renamed too. The pilot:

| Scene  | Keys                                                                                                          | Layer                                        | Becomes   |
| ------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --------- |
| meadow | `grassHeight`, `grassDensity`                                                                                 | `grass`                                      | unchanged |
| meadow | `dandelions` (and `-amount`), `wildflowers` (and `-amount`)                                                   | `dandelions`, `wildflowers` (their switches) | unchanged |
| meadow | `haze`, `mown` (and `-amount`)                                                                                | `downs`                                      | unchanged |
| meadow | `gusts` (and `-amount`), `gustRate`                                                                           | the composer                                 | unchanged |
| meadow | `meadowSeed`                                                                                                  | the composer                                 | `seed`    |
| bees   | `bees`, `swarm`, `butterflies`, `bumblebees`, `hoverflies`, `dragonflies`, `fireflies` (and their `-amount`s) | `insects`                                    | unchanged |
| bees   | `flowers`, `lantern` (and `-amount`), `fairyLights`, `mark` (and `-amount`)                                   | `apiary`                                     | unchanged |
| bees   | `scenerySeed`                                                                                                 | the composer                                 | `seed`    |
| both   | the World's keys                                                                                              | the World                                    | unchanged |

New keys: the switches `downs`, `grass`, `hillside`, `lawn`, `apiary` and `insects`; `seed`; and
`grass`'s `overgrowth`.

**Old links** are not carried over (no backward compatibility, operator decision 2026-10-17): a
port adds no URL steps or aliases, and a setup made before it replays on its own build
(`/@<sha>/`). Garden's and dunes' `camera=1` views become scene ids of their own, `gardenabove` and
`dunesabove`. Committed presets that set a renamed key are rewritten, their `commit` moved to the
porting build.

**The A/B plan of every port:**

1. Before the port, record the scene's witness set: its defaults (dithered and `view=source`), its
   committed presets, and one witness per knob group (night, rain, snow, each gate on).
2. After the port, run `scripts/ab.ts --base <pre-port revision>` over them.
3. A witness passes if it is `SAME`, or if it differs by at most 0.5 % of cells at defaults or 2 %
   on the other witnesses, with each difference attributed in the PR to a named shared change and
   its diff image inspected (`ab.ts` gains a `--tolerance` report; whether tolerance is allowed is
   the operator's call, D3).
4. A structural difference fails at any share: a part missing, moved or lit differently.
5. Regenerate the thumbnail only where the defaults differ.

### Programs and cost

**A layer turn is structural.** It builds the new layer set's own program in the background, on
every renderer, while the old picture keeps drawing. The layer enters once the program is on
screen. While the lab is open, the set's all-features program is then built aside.

**A knob turn inside a set** follows "Knob-keyed features" with the set's all-features program.

**A set's key is order-free:** its `LAYER_*` gates in name order.

**Knobs are laid out per program.** A program defines `K_<key>` only for the composer's knobs and
its on layers' knobs, packed into `uParams`, and carries the index map the renderer uploads
through. `MAX_PARAMS` splits into a scene's knob list (512, CPU only) and one program's (128).

No composer-wide all-features program is ever built. The second audit's shaker measures one for
the 15 outdoor scenes at 868 KB, against the countryside's 213 KB, which already takes 20 s under
SwiftShader.

**Off is free.** An off layer is absent from the source, an off gate is absent after `#if`, and the
function shaker removes what nothing reaches.

**On adds.** Under SwiftShader a stack costs its base plus the sum of its on layers. On a GPU each
layer's cost is weighed by the share of cells inside its bounds.

| Budget                                       | Limit                                             |
| -------------------------------------------- | ------------------------------------------------- |
| Layers on (the World not counted)            | 8                                                 |
| Front subjects                               | 2                                                 |
| Shaken program at a preset's defaults        | 160 KB                                            |
| Shaken all-features program of a layer set   | 256 KB (the pilot mix: about 204 KB)              |
| Fragment uniform vectors                     | 224 (`glsl:check`)                                |
| Knobs one program reads                      | 128                                               |
| Trigger slots                                | 32                                                |
| Sim textures                                 | 8                                                 |
| Sim CPU time, whole stack, headless          | 4 ms a frame                                      |
| SwiftShader frame, 320×200                   | a preset: at most 1.15× its scene before the port |
| GPU frame, 960×540, reference integrated GPU | 16.7 ms (`bench.html`, which gains `layers=`)     |

The lab sums the layers' costs into a stack meter and dims any layer that would break a budget. A
link over the cap keeps layers in canonical order up to it.

**Checks:**

- **Static (glslang):** every preset and committed mix, every layer alone over its composer's
  base, and every compatible pair with a changed layer.
- **Browser:**
  - the all-features programs against every knob turn, as `worldFeaturesAll` does;
  - `composerDepth`: with alpha rounded, reversed opaque order draws the same cells;
  - `composerClaims`: no cover in an exclusive or clearing core;
  - `composerWeather`: wetness and lying snow change every on layer;
  - `layerToggles`: a layer turn never waits for a build;
  - `passageSpeeds` per preset.

### Sims in a composition

The renderer sees one sim, the composed sim. It gives each on layer's sim a `LayerFrame`:

```ts
interface LayerSim {
  frame(frame: LayerFrame): void; // writes into its rows, its specks and its fields
  ready?(): boolean;
  dispose(): void;
}
interface LayerFrame extends SimFrame {
  // params and values: its own knobs under their short keys, rewritten in place (no allocation)
  rig: LevelCamera; // or the room's or the patch's twin
  ground: LayerGround; // placed claims, coverAllowed, the floor at a point, its own anchor
  gusts: GustField; // gustAt's CPU twin
  records: RecordRows; // its rows of the records atlas
  specks: SpeckWriter; // its codes in the shared speck map
  fields: readonly FieldSlot[]; // its dedicated textures
  principals: readonly PrincipalHit[]; // see below
}
```

| Slot | Texture                                                | Shared how                                                                                                                              |
| ---- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | the speck map: rg8 at frame size, nearest (`SpeckMap`) | one map; each layer has a range of codes; one depth step (bees' quarter metre), so every speck hides behind every layer's nearer things |
| 1    | the records atlas: `rgba16f`, nearest, 512 wide        | rows per layer; `PlantTexture`'s `rowBase` writes there; an `rg16f` record takes two channels                                           |
| 2–7  | fields: any format and filter                          | one each: height fields, a pointer's wake, a GPU solver's output                                                                        |

**Allocation** is a pure function of the layer set **on screen**:

- rows and slots go by canonical order;
- `SimFrame.features` tells the composed sim which program the frame draws with;
- a layer switched on but not yet on screen is built and run ahead at `dt` 0, as an incoming
  scene's sim is during a passage;
- when the new program arrives, the allocation switches within that frame;
- a layer's GLSL reads through the accessors the assembler generates (`<id>Record(x, y)`,
  `<id>Field0()`, `<id>SimOn()`), never `uSimN`.

**Budgets and readiness.** Budgeted work goes down the layers in canonical order. `ready()` is true
when every layer on screen is ready. Layer sims keep the frame-rate contract: a `FixedStep`, and
chance drawn on steps. GPU solvers keep their own passes and hand their output to a field slot.

### Layers in the lab

- **The Layers section.** Each switch carries `{ kind: "layer", role }` (`Widget`). The switches
  gather into one Layers section after the World shelf, as the `night` parts make the Night sky
  section:
  - a row per role, with a chip per offered layer: on, off, refused (dimmed, with its reason) or
    over budget (dimmed, with the meter);
  - a "+" listing the role's offered layers, with their thumbnails and costs.
- **Layer sections.** A layer's groups carry `Blurb.layer`. They stand under their layer's heading
  after the Layers section, in role order, and show while it is on. A change left dormant on an
  off layer still counts under the lens and comes back with the layer.
- **Starting points.** The Scenes view's cards are the scene presets. "Reset what changed"
  returns to the preset, layers included.
- **Shuffle and undo.** Shuffle never turns a layer (switches are steady). Undo and redo take layer
  turns like any knob.
- **The compact bar,** in order: the World chips; a Layers chip, lit while the set differs from
  the preset's; one chip per on layer (its icon, and a popover with all its sections); then
  Global. Fitting is as before.

### Principals and chores

Principals (I-20) are a renderer concept today (`src/principals.ts`): the visitor is principal 0,
then up to `MAX_AGENTS` (3) agents of a scripted cast, set by the lab's `agents` setting (Motion
group, default 0). The cast wanders, goes to the points a scene's sim declares
(`SceneSim.interest`), pauses, presses briefly and moves on, deterministic from the scene's seed
knob and its motion clock; it is a `PresenceSource`, so live presence (I-23) replaces only the
source. Sims get `SimFrame.principals` and react to all of them where many hands are natural (a
wave source, a breath, a lure), keeping `pointer` for what follows one hand. GLSL gets
`uPrincipals[4]` (4 vectors), `uPrincipalCount` (1) and, for the cursors, `uPrincipalMotion[2]`
(2): 7 of the 8 allotted. The agents' cursors (a soft ring of the accent with a short wisp) are
drawn by `main` over every scene behind the gate `PRINCIPAL_CURSORS` (only while there are
agents; on in every all-features set); humans and agents differ by motion alone (I-40). In the
composers the composed sim will add each principal's point in the site through the rig and the
claim and layer under it (`uPrincipalGround[4]`), and the composer draws every cursor last.

A sim keeps per-hand state in arrays of `MAX_PRINCIPALS`, by a principal's place in the list (its
press, its drag, its last point), so hands never steal each other's gesture. Where one tool can
be held at a time (ripple's dipper, marbling's stylus, the slime mould's salt, the petri dish's
brush), the visitor holds it and the others' taps do what a tap does there (a pebble, a drop of
ink, an oat flake, a drop); where the scene has one controller or one view (the street's lights,
fractal's and hyperbolic's drag, the prism, the ferrofluid's magnet, the lava lamp's hand), the
visitor alone acts, and the sim says so where it reads `pointer`. `interest(aspect)` names where
a press does something: the bamboo basin and grove, the bonsai's pads, the bar's counter, the
Chladni plate's quarters, the web round dew's hub, the lake's open ice, the lantern river, the
marbling tray, the mobile's balls, the petri dish, the slime mould's dish, the tide pool's basin
and the harmonograph's open margins.

A **chore** is a layer that `requires` its host and acts through affordances the host's sim
exposes:

- **Leaf raking**: autumn's litter, `rake(path, width)`; gusts scatter the piles.
- **Cairns**: shore's beach, `place(stone, on)` on a small stacking sim; the surf topples them.
- **Garden chores**: the apiary, `plant(drift, row)` and `weed(drift)`; the weeds come back.
- **Star-joining**: the World's constellations, `join(a, b)`; dawn fades the figure.
- **Sand raking**: the sand table or the gravel, `groove(path, tines)`; the ball and the weather
  erase it.
- **The shared table**: the harmonograph's sheet, `pen(path)`. Live in the scene today: every
  principal's tap lets a small damped pendulum plotter go there (its frequencies detuned by a hash
  of whose hand and when), a drag draws freehand in the same nib; while hands work the sheet
  (`SHARE_LINGER` after the last ink) its ink fades and a finished figure is swung again on the
  same sheet instead of sliding it away. Nobody's hand on it: the sheet lives as before.

The host owns the state and nature's undo; the chore owns the plan and the tool. Chores are
deterministic for the seed and stand still at motion 0. Principal 0 may do the same chore with the
pointer.

Built ahead of the composers, in the scenes' own sims, each a feature knob on by default that acts
only through the cast's agents (so a page without agents draws as before), with `interest` points
for the cast and its own headless test:

- **Leaf raking** (autumn, knob `rake`): `Litter.rake` (`src/sims/litter.ts`) drags a stroke's band
  into a `LitterPile`, heaped under its top once its cells are full; a pile takes six strokes along
  the path, and a gust lifts it away.
- **Sand raking** (sand table, knob `rake`, the ball's table): an agent's press takes the rake up
  and `HeightField.rake` combs its run between two sites; a drag on the sand rakes too (a press on
  the ball still leads it). The ball's drawings and erase spirals groom it away.
- **Cairns** (shore, knob `cairns`): `src/sims/stack.ts` stacks stones as rigid boxes with
  friction; agents carry pebbles to sites on the wet sand, and the swash (mirrored from the shader
  in `shore/beach.ts`) of the bigger waves knocks them down. No tide.
- **Star-joining** (every scene with the shared constellations, knob `join` beside them, how many
  figures a night; it acts while they are on): no sim state, but a schedule of the world clock and
  the motion clock (`src/constellations.ts`). From nightfall the agents take the night's figures in
  turn, starting one further on each night; `skyFigures` (`shaders/lib/sky.ts`, in a program with
  `PRINCIPAL_CURSORS`) grows each line behind a cursor of the sky's own at the tip, in the stars'
  frame, and draws the figures whole while there are no agents. `skyJoinAway`, the schedule's CPU
  twin, takes the agents up in the sky off the page (`Pose.inside` false: no hand in the scene,
  `uPrincipals` off the page) where the renderer asks the cast. The lines stand until dawn fades
  them with the stars.

### Porting a scene

1. Record the witness set (above) at the revision before the port.
2. Cut the scene into layers along its knob groups, by role. Give each a manifest, anchors and
   claims in metres. Turn screen-placed parts into world points through the rig, as bees' sim
   already does with `LevelCamera`.
3. Move the camera constants into the preset's rig, the light tints into its grade, and the haze
   and sky staging into its backdrop.
4. Replace the scene's own gusts, rain, fog and seed with the composer's, and note each picture
   this changes for the A/B.
5. Route sim textures into the records atlas, the speck map or field slots, and the GLSL's reads
   through the generated accessors.
6. Keep each key that is still unique. Qualify the colliding ones, and rewrite the committed
   presets that set them.
7. Run the A/B plan, regenerate the layer costs, and check the budgets.
8. Add at least one committed mix with a layer of another scene, checked by `composerClaims` and
   `composerWeather`.
9. Replace the scene's "what stays the scene's" prose with a comment at the top of each layer's
   file.

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
  holds every stage to that budget (`CELL_BUDGET`, with 25 % to spare before cells coarsen: a
  larger stage, a 4K screen or a 1440p one at pixel 2, gets coarser cells), draws every n-th
  refresh, nearest 60 frames a second (75 at 75 Hz, 72 at 144; about half that at rest where the lab's
  `rest` says half), and none while the picture stands still (see "Time and motion"). The GPU timing page (below)
  measures it on a real device.

## Correctness checks

Run `bun concepts/landing/verify.ts` from the repository root with system Chromium available
(`MANIFOLD_CHROMIUM` can select its binary); name checks to run only those
(`bun concepts/landing/verify.ts frostSky pondKoi`). Each check runs on a freshly loaded page, so
it inherits nothing from the others, and has a deadline of its own: three times the seconds it last
took (`scripts/verify-timings.ts`), never under 180 s, or `LANDING_CHECK_SECONDS` for every check
when that is set (it is started in the page and reports back when done, so no browser protocol
call waits on it). A check whose renderer crashes or is killed (earlyoom picks renderers first)
fails at once with `renderer crashed`, not at the deadline. The run prints the browser's version,
`PASS  <name> (<seconds> s)` or `FAIL  <name>` per check as it ends, then the results as JSON keyed
by check name. A failure (a throw, the deadline or a crash) does not stop the run: every check runs,
the failures are listed again at the end and the exit is non-zero. A lost page, and a check past its
deadline (its page may still be running it), fail that check and relaunch the browser for the
checks after it; no check is run again. Under GitHub Actions the run adds a table of each check's
seconds, deadline and outcome, with the browser's version, to the job summary.

- `--shard i/n` runs the `i`th of `n` disjoint shares of the checks, balanced by their recorded
  seconds: longest first, each to the share with the least so far, so the shares differ by at most
  the longest check; a check without a record weighs the median one.
- `LANDING_SCENES=a,b` keeps only the checks that cover those scenes (unset or `*`: all). A check
  imported from `src/scenes/<id>/` covers `<id>`, the scene directories its scene files import, and
  every scene those files name (`sceneDefs.<id>` or `"<id>"`); one that walks every scene
  (`sceneIds`, `Object.values(sceneDefs)`), or any check from outside a scene's directory, covers
  them all (`scripts/verify-plan.ts`). The checks that walk the scenes one by one (`walk` in
  `src/verify/kit.ts`: `passageSpeeds1`..`4`, `motionClocksAll1`..`4`, `featureToggles`,
  `worldFeaturesAll`, `sceneFeatures`, `nightPlanets`) walk only those in scope, and the shards
  weigh each by its record times the share of its scenes in scope.
- `--record` rewrites `scripts/verify-timings.ts` with the seconds of the checks that passed (and
  drops checks no longer registered); run it, without a scene scope, after adding or speeding up a
  check and commit the file. `scripts/verify-plan.test.ts` fails while a registered check has no
  record, or a record no check.

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
`contextRestore`, on the pond, nothing but the page's background shows until the scene's first
frame, which shows nothing else either, its clock at 0, nor until its plant atlas is painted; the
scene then appears out of the bare page cell by cell, on every frame the cells the reveal holds
back exactly the background and the rest the pond, out of nothing but the blank texel on the
uLeaving unit, none held back within the reveal's 0.8 s; a lost context draws nothing while the
frame loop goes on, and once the browser restores it the scene appears again the same way and
draws, its plant atlas painted anew (no frame binds a texture made before the loss, as the sheet
the pond kept from its last visit would be);
`frameGovernor`, a moving scene on a 120 Hz display draws 60 frames a second at rest, or with `rest=half` 30
and 60 from the first frame after input until it has played out, and paused or at motion 0 the picture stops
issuing draws once the change has played out, until input wakes it, a pointer that moves nothing
for a moment only (`src/display.test.ts` and `src/governor.test.ts` check the cells on whole device
pixels at 125 %, the budget and its slack, the frame divisors, the pacing through jitter and
dropped frames and the rest rate without a browser).
Checks that drive frames by hand start the renderer unpaced (`start({ paced: false })`) and run
frames, a little real time apart, until it is no longer `waiting` for a scene's program.

`src/features.verify.ts` covers knob-keyed features through the renderer, taking its context for a
GPU's or a software rasteriser's whatever renders the check. No change waits on a build (no status,
log, uniform location or use of a program before its completion or fence was seen).
`sceneFeatures`, software: nothing is built ahead; a gated knob builds its own program in the
background and switches to it once built, the old frame holding until then; several gated knobs at
once build once; past four sets the least recently drawn program is freed. `featureToggles`, GPU,
for every scene with `featuresFor` (country, meadow, shore, dunes, bees, orbit, lake, pendula): the
plain page builds only its own program; after the first gated change, which builds the
all-features program in the background, no change builds a program; with changes expected that
program is built ahead at rest, draws one frame without changing it, and the first change switches
to it at once. `worldFeaturesAll` (every scene with `featuresFor` but the countryside: meadow,
shore, dunes, bees, orbit, lake, pendula), GPU: the all-features program draws every gated
setting, dithered and as source, byte for byte as the setting's own (drawn on a renderer taken for
a software rasteriser's that enters at the same starting setting, settles and switches the same
way, so the sims share their history).
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
- The water's tiers (`shaders/lib/water.verify.ts`, `waterTiers`): detail too fine to draw is skipped
  without changing a value (each wave train and the caustic net against its unskipped form), the
  cellular net draws its seams where they span a cell and only its mean where they do not, the
  mirror, the glitter and the caustic light behave, and each tier's functions exist from
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
  knob to off at its defaults, its gate out of the default program). `nightPlanets`: over the
  lake's fjord (`LAKE_FJORD`) and the island, two planets of different kinds show
  where their placements put them (the left one further left), together as each alone does; an
  orbiting planet drifts left with the motion clock and, half a circuit on, has set, the sky byte
  for byte the empty list's.

CI runs these checks (gate group `landing-webgl`, four jobs `landing-webgl (1/4)` to `(4/4)`, one
`--shard` each, on a shallow checkout with Bun alone and a pinned Chrome for Testing,
`.github/actions/landing-chromium`) and the lab's TypeScript, unit tests and GLSL check
(`landing-concept`: `scripts/glsl-check.ts` through glslang, with node for the countryside's V8
build) for every pull request that changes `concepts/landing/` or a source the lab imports, other
than its documentation and thumbnails, and on every full run (each push to `main`, each manual
dispatch). A pull request that changes only scene directories (and documentation) runs only the
checks covering those scenes and the scenes whose files import theirs (the planner's
`landingScenes`), the checks that walk the scenes on those alone; full runs cover every scene.
`bun scripts/gate.ts --only landing-webgl [--shard i/4]` or `--only landing-concept` runs the same
slice locally. A pull request that changes the lab also gets an advisory, never required, A/B
render of a canary set of scenes and their knob turns against its merge base
(`.github/workflows/landing-ab.yml`, `scripts/ab.ts --turns`), its report and the pictures that
differ uploaded for review.

To add a check, write `<topic>.verify.ts` in the scene's folder exporting a function that takes a
`WebGL2RenderingContext`, throws on a regression and returns what it measured as plain JSON data,
then register it in `concepts/landing/verify-browser.ts` with one import and one
`["<name>", verifyTopic],` line at the end of `checks`. The context is the check's own (a vertex
array bound, the canvas at its default size): size the canvas for what it reads back, and restore
in a `finally` any global or shared definition it patches (`window.requestAnimationFrame`, a
scene's `glsl` or `sim`). Name each scene the check draws as `sceneDefs.<id>` (or import from its
directory), so a run scoped to that scene keeps the check; a check that walks scenes one by one
wraps itself in `walk(scenes, check)` so a scoped run walks those in scope alone.
`src/verify/kit.ts` holds what checks share: `check`, `link` (a program from a fragment source),
`readBytes`, `drawFloats` (a float target's read-back), `stage` (a canvas for a renderer of its
own), `holdFrames` (rAF held for frames run by hand), `pause`, `until`, `labSettings`, `walk` and
`LAKE_FJORD` (the lake's knobs for its fjord under the slow drapes).
Keep each check well under the deadline in software WebGL on a busy machine (split a slower one
into several entries) and record its seconds with `--record`.

### Pixel identity (`scripts/ab.ts`)

`bun concepts/landing/scripts/ab.ts [--base <rev>] [setting...]` shows whether a change alters
what the lab draws. Each setting is drawn from this working tree and from the base revision
(default `HEAD`, so the uncommitted edits; `--base $(git merge-base HEAD origin/main)` for a
branch), each tree built as `serve.ts` builds a commit, both in one software-WebGL Chromium, with
the clocks frozen as a reduced-motion visitor sees the page, until the picture has held still for
1.5 s with no sheet still painting; then the two pictures are compared cell for cell. A setting is a
page query (`"scene=country&time=0.3"`) or a bare scene id; by default every scene at its defaults,
dithered and `view=source`, `--presets` adds the committed presets, and `--turns` adds, dithered,
each gated knob turn (`src/knob-turns.ts`) of every knob-keyed scene among the settings. A scene whose generated GLSL
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

### Compile budget and glslang (`src/shaders/shake.test.ts`, `scripts/glsl-check.ts`)

`src/shaders/shake.test.ts` holds every scene's shaken default and all-features programs to a
ceiling of characters, about 10% above their size when it was last set (`BUDGET`), and prints each
program's assembled and shaken size. A scene past its ceiling has grown what the driver compiles:
find what it pulled in, or raise the ceiling on purpose. The same test holds the shaken programs to
their lines (each line of code where the assembled program has it) and to shaking to themselves.

`bun concepts/landing/scripts/glsl-check.ts [scene...]` compiles and links those programs with the
vertex shader under Khronos's reference compiler, `glslangValidator` (GLSL ES 3.00), and counts
each one's fragment uniform vectors from glslang's reflection of the uniforms it uses: an element
of up to four components a row, a matrix a row per column, samplers none. It fails on any error and
on a program over 224, the `MAX_FRAGMENT_UNIFORM_VECTORS` WebGL 2 guarantees, since a driver may
give every array element a row of its own (hence `uParams` and the constellation tables packed into
`vec4`s). The binary is the system's (nixpkgs `glslang`, apt `glslang-tools`, or
`GLSLANG_VALIDATOR`); without it the check skips, except under CI, where it fails.

### GPU timing (`bench.html`)

The verify suite runs in software, so it says nothing of a real GPU. `bench.html` beside the lab
(`http://127.0.0.1:7920/bench.html` from `serve.ts`, committed or `--dev`; `/@<sha>/bench.html`
for a commit; the same paths on the public origin) times each scene at its defaults on the device
that opens it: its program's compile and link, then, once it is on screen and warm, its frames on
a canvas of `cells` (default 960x540, the budget above), one cell per device pixel at any device
pixel ratio, drawn unpaced (as fast as the display takes them): GPU time per frame from
`EXT_disjoint_timer_query_webgl2` when the browser has it, else the time between drawn frames,
and the main-thread time of each, with medians, 95th percentiles and ms per million cells. A grid
past the budget is coarsened to it, as on the landing, unless `budget=off`. Beside them it reports
the renderer string, the context's uniform and texture limits, its fragment precisions and
extensions, per program the uniform vectors it uses (each scalar, vector and matrix row counted as
one), and the cells the landing itself draws in that window. Query keys: `scenes=a,b` (default
all), `cells=WxH`, `frames` (120), `warmup` (30), `budget=off` and `auto=1` to start at once. The
report is JSON to copy or download; the page sends nothing anywhere.
