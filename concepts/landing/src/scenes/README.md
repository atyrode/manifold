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
"Composing components") + shared `libs` + generated knob defines + the scene's `glsl` + the
dithering `main`. The entry returns a `Shade`:

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
`uMotionTime` (the motion clock, below), `uPointer` (smoothed -1..1 parallax, 0 when the pointer is
not followed), `uMouse` (raw pointer: xy in uv, z = button held, w = scene time of the last press),
`uBg` (the page background), `uParams[]`, `uTriggers[]`, `sinceTrigger(slot)`, `uSim0..uSim3` +
`uSimOn` (textures from the scene's sim), `uWeather` (x: how wet the world is, y: how much snow
lies, both 0..1; see "Weather in the world"), `hash12`, `vnoise`, `fbm`, `rotate`, `rotateAbout`,
`segmentDistance`, `markDistance` (the Manifold M in mark units: x in [-0.47, 0.47], y in
[-0.5, 0.5]), `starfield`, `threshold`, `LUMA`, `TAU`, and (`[...]` marks an overload):

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
vec3 vnoiseD(vec2 p);                                 // vnoise with its gradient (x value, yz d/dp)
vec2 vnoise1(float x, float seed);                    // 1D value noise 0..1 and d/dx
float fbm3(vec2 p);                                   // three octaves of vnoise, 0..1
vec2 fbmLod(vec2 p, float foot, int octaves);         // fbm whose octaves fade to their mean below ~4 cells: x noise, y detail kept; foot = a cell in p units

float smoothfall(float a, float b, float x);          // 1 at x <= b .. 0 at x >= a: write this, never smoothstep with edge0 > edge1
float softFill(float d, float aa);                    // 1 - smoothstep(-aa, aa, d): an SDF's inside, soft
float bell(float x);                                  // exp(-x * x)
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
hours after a few minutes). Never write `t * uMotion` in new code; `uMotion` alone is for
amplitudes. The sky uses `timeOfDayM(K_time, K_cycle, uMotionTime)` in every scene; CPU
day/night decisions use the same `frame.motionTime / 240` phase. Other library functions with a
`tm` or `motionTime` parameter take `uMotionTime`; those that take `t` still scale it themselves.
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

### Entrances and exits

Switching scenes (or first loading the page) is a passage, not a cut. The outgoing scene plays its
exit, drawn with its own settings. Its last frame is then kept, and the incoming scene, built afresh
with a new sim, dissolves out of it over 0.9 s, cell by cell in ordered-dither order, the middle
first. The entrance's clock starts on its second frame, because the first one is spent compiling the
program and shows only the old frame. Every scene gets the dissolve for free.
The saved frame is sampled in normalized stage coordinates with nearest filtering, so changing the
viewport or pixel size during the dissolve stretches the whole saved image rather than fetching
outside it.

Every scene makes the passage its own, in the world rather than by fading:

- Set `passage: { enter, exit }` (seconds, about 2–3.2 in and 1–1.8 out) on its `SceneDef`, from a
  constant the shader also reads (through `glslFloat`) when it needs seconds.
- Read `passageIn()` and `passageOut()` in GLSL, or `frame.passage.enter` and `.exit` in a sim.
  - `passageIn()` runs linearly 0→1 over `enter` and then stays 1.
  - `passageOut()` is 0 until the scene leaves, then 0→1 over `exit`.
  - Ease them yourself.
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
  the warm-up (physarum's `GrowthClock`), so a slow first frame doesn't use up the entrance.
- Put the readable part after ~0.5 s, which the dissolve half covers.
- At rest (`passageIn() == 1`, `passageOut() == 0`) the scene must be exactly what it was: gate
  every change, and keep the sim's prewarm and random draws as they were.

Passages run in real time whatever the motion. The lab's Motion section switches them off (`&transitions=off`)
and replays the current scene's exit and entrance with "now". They are skipped at motion 0 and under
reduced motion.

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

Shared knobs come from `src/scenes/atmosphere.ts`: `skyKnobs({ time })` gives `K_time`, `K_cycle`;
`weatherKnobs({...})` gives `K_rain`, `K_snow`, `K_fog`, `K_wind`, `K_lightning`, `K_aurora`
as requested. The rest are opt-in sky components (see "Composing components"), each given the value
the scene draws with as its default: `skyKnobs({ stars: 0.6 })` adds `K_stars` (density for
`skyStars`, 0 none .. 1 a dark-site sky), `skyKnobs({ milkyWay: { on: true } })` adds `K_milkyWay`
(the band's brightness for `milkyWay`, 1 as the component draws it, up to 2; 0 while switched off,
off unless `on`), `skyKnobs({ moon: 1 })` adds `K_moon` (the moon's phase for `skyMoonPhase`, 1 full,
0 while switched off: no moon), `skyKnobs({ meteors: { trigger: 1 } })` adds `K_meteors` (shooting
stars for `meteorAge`, off by default, "now" on that slot), `weatherKnobs({ clouds: 0.3 })` adds
`K_clouds` (fair-weather cover 0..1, which rain and snow thicken) and `weatherKnobs({ shadows: true })`
adds `K_shadows` (how dark the cloud deck's shadows fall, for `skyCloudShadow`: 0.6 while on, off
unless `on: { shadows: true }`). A scene with a night of its own (an hour knob, a painted sky) takes
the components without the clock from `skyComponentKnobs({ stars, milkyWay, moon, meteors, group })`.
Use `atmosphereGroups.sky` / `.weather` for their lab headings, `.skyNight` for a sky group that
also holds components.

Birds come with their library: `birdKnobs({ kind: "gulls", help })` from `src/shaders/lib/birds.ts`
adds `K_birds` (how often a flight passes, off by default), `K_birdKind` (the species, the GLSL
`BIRD_*` kind; -1 "mixed" where the scene offers its own mix) and `K_birdFormation` (the formation
plus one, 0 the species' own), with `birdsGroup` as their heading (see "Birds" below). The plant
component's knobs come from `plantKnobs` (`src/scenes/plants.ts`, see "Rooted plants") and the giant
planet's from `planetKnobs` (`src/scenes/planet.ts`, see "The giant planet").

A knob with `trigger: n` gets a "now" button (a lightning bolt, whatever the knob's kind) that stamps
`uTriggers[n]` with the scene clock; read it with `sinceTrigger(n)` (huge while idle) in GLSL and
`frame.fired[n]` in a sim. Use slots 0..7; lightning takes the slot you give `weatherKnobs`. The lab's
transport lists every "now" of the scene as well.

### Lab widgets

The lab (`src/lab.ts`, `src/lab/`) is one floating inspector and a transport bar over the scene.
The inspector has three views, picked by the icons in its header: Scenes (every scene's thumbnail,
shelved by family), Presets (saved setups) and Controls (the scene's groups, then Look, Motion and
Page); a rail beside each view jumps between its families, preset groups or control groups. The
scene's name in the header and in the transport bar opens the Scenes view. Controls lay a group out
from its knobs' metadata, never from scene ids: a switch (toggle or feature) is an icon chip whose
amount opens under the chips while it is on, and ranges, choices and seeds are rows. A knob names a
purpose-built widget with `widget` (`Widget` in `src/params.ts`); widgets only change how the lab
draws the knob, never its URL keys, values, reset, shuffle or presets:

- `{ kind: "mix", mix, part, swatch }` on range or feature knobs of one group: one stacked bar of
  relative weights named `mix`, each knob a segment while it is in (country's land use). A range is
  in while above zero; a feature is in while on, its amount the weight (the shader reads 0 while
  off), and gets an on/off chip over the bar that keeps its amount while off. Make a part that may be
  left out a feature with `min: 0`, `max: 100`, `step: 1`; a drag or key that takes it to zero
  switches it off.
- `{ kind: "sky", part }`: the sky dial. `skyKnobs` sets it on `time`, `cycle` and `moon`; the dial
  stands where a group holds a `time` part.
- `{ kind: "direction" }` on a range from below 0 to above 0: a vector pad, min to the left
  (`weatherKnobs`' wind, kelp's and delta's currents).
- `{ kind: "compass", strength }` on a heading (a turn 0..1 counter-clockwise from the right): a
  vector pad whose length is knob `strength`, a range or a feature's amount (pond's current).
- `{ kind: "position", y, screen? }` on the across range of a point whose height is range `y`: one
  XY pad; `screen` gives the values where the frame's edges lie when the point may leave it.

Icons come from `src/lab/icons.ts`, one line set: a knob's `icon` (or a group's `Blurb.icon`) picks
one, otherwise the first word of its key or label that names one does.

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
struct Sky { vec3 sun; vec3 moon; float day; float twilight; float night; vec3 sunColor; vec3 ambient; vec3 moonColor; }; // + float moonPhase with SKY_MOON_PHASE
Sky skyAt(float tod);                                     // sun rises on the right, crosses high, sets on the left; moon opposite
vec3 viewRay(vec2 uv, float aspect, float horizon, float fov); // side-on camera, horizon at screen height `horizon`
vec3 skyColor(Sky sky, vec3 dir);                         // gradient, sunset glow, sun and moon discs (no stars)
float skyStars(Sky sky, vec3 dir, float density);         // stars faded by daylight, stable per direction
float skyStars(Sky sky, vec3 dir, float density, float foot); // the same with a level of detail: foot = radians a dither cell spans
float skyStarFade(Sky sky, vec3 dir);                     // where stars show at all: night, height, away from the moon's disc and glare
vec3 skyStarLight(Sky sky, vec3 dir, float density);      // skyStars tinted SKY_STAR_TINT (cool white), to add to the sky
vec3 skyFacing(vec3 dir, float yaw);                      // turn a direction about +y (+x toward +z): a camera looking off-axis
Sky skyFacing(Sky sky, float yaw);                        // the sun and moon turned with it
Sky skyMirror(Sky sky);                                   // moon swung behind the viewer, for reflections
vec3 horizonHaze(Sky sky, vec3 dir, float lift);          // the sky just above the horizon in dir's heading (lift 0..0.04)
float skyMoonCover(Sky sky, vec3 dir);                    // 0..1 the moon's disc (unlit part too) over dir: hide what lies behind it
vec2 skyAngles(vec3 dir);                                 // (bearing from straight ahead, elevation) in radians: a flat frame on the dome
// With SKY_MOON_PHASE (SceneDef.features):
Sky skyMoonPhase(Sky sky, float phase);                   // K_moon: 1 full (unchanged) .. 0 no moon; disc, halo, moonColor, ambient follow
float skyMoonPhaseLight(float phase);                     // the moon's light at a phase relative to full (0.32 half, 0.11 a quarter)

// Clouds in tiers (clouds.ts), each only in a scene whose SceneDef.features CLOUD_TIER reaches it, the
// lit deck where it selects none (see "Clouds"):
// CLOUD_FLAT, in every program
vec2 cloudDeckPoint(vec3 dir, vec2 travel, float tm, float wind); // where dir meets the deck (cloud-base heights), drifted on tm; travel: the eye's own way under it
float cloudFlatField(vec2 p, float fine);                 // the calm deck: two broad octaves 0..1, the finer kept by fine
float cloudFlatFine(vec3 dir);                            // how much of the finer octave a view along dir keeps (none toward the horizon)
// CLOUD_LIT (and without CLOUD_TIER)
vec4 skyClouds(Sky sky, vec3 dir, float t, float cover, float wind); // the lit deck seen from below: rgb, alpha
float skyCloudField(vec2 p, float foot, float t);         // its density at a deck point, octaves faded to their mean below ~3 cells
// CLOUD_SHADOWS
float skyCloudShadow(Sky sky, vec3 ground, float base, float t, float cover, float wind); // 0..1 its shadow at ground (eye-relative), the deck base above the eye
float skyCloudShadow(Sky sky, vec3 ground, float base, float low, float t, float cover, float wind); // the same under a deck rain brought down to base / low
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
Precip rainFall(vec2 uv, float aspect, float t, float amount, float wind, float depth); // level camera: paths straight down the frame
// A camera pitched up or down: the drops' paths meet at the vanishing point of their fall direction.
// right/up/fwd: camera axes in the world; focal in screen heights (ray = fwd*focal + right*x + up*y,
// x, y about the frame's centre). Shift vanish.y by -lens * vanish.z for a lens-shifted frame.
vec3 rainFallDir(float amount, float wind);               // the drops' world direction (terminal speed 4..9 m/s, wind drift)
vec3 rainVanish(vec3 dir, vec3 right, vec3 up, vec3 fwd, float focal);
Precip rainFallSeen(vec2 uv, float aspect, float t, float amount, float wind, float depth, vec3 vanish);
float weatherRainClock(float t);                          // real time for gravity-driven things once motion > 0.4
Precip snowFall(vec2 uv, float aspect, float t, float amount, float wind, float depth);
vec3 snowFallDir(float amount, float wind);               // the flakes' world direction, for rainVanish
Precip snowFallSeen(vec2 uv, float aspect, float t, float amount, float wind, float depth, vec3 vanish); // tilted camera: flakes stream out of (or into) the vanishing point; vanish.z = 0 is snowFall
vec3 precipOver(vec3 col, vec3 air, vec3 dropLight, Precip p); // the veil toward air, then the drops toward dropLight (see below)

// Surfaces (p in the scene's own ground units, roughly metres; scale freely):
float rainSplashes(vec2 p, float t, float amount);        // 0 or the light of brief splash crowns on hard upward-facing ground
vec3 rainRipples(vec2 p, float t, float amount);          // rings on water or puddles: xy normal tilt, z ring light (p in ring cells)
float rainPuddles(vec2 p, float wet);                     // 0..1 where water pools on flat ground as wet (uWeather.x) rises
vec3 wetten(vec3 albedo, float wet, float porous);        // wet albedo: darker, richer; porous 0 stone/metal/glass .. 1 soil/wood/cloth
float wetGloss(float wet, float up);                      // 0..1 extra specular/reflection; up = normal.y (flat ground pools and mirrors)
float rainDrips(vec2 p, float t, float amount, float width); // drops gathering and falling from an edge: p.x along it, p.y down; width = drip spacing
float snowCover(vec3 n, vec2 p, float lying);             // 0..1 snow on a surface with normal n (y up), lying = uWeather.y
vec3 glassDrops(vec2 uv, float aspect, float t, float amount); // rain on a pane: xy refraction offset, z drop coverage
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
// WATER_FLOW
vec2 waterDrift(vec2 p, vec2 current, float tm);          // where to evaluate a pattern a steady current (velocity) has carried to p
vec4 waterFlow(vec2 p, vec2 current, float tm, float period, out float weight); // a current that varies: mix(at xy, at zw, weight)
// WATER_CAUSTICS (caustics.ts)
vec2 causticRipples(vec2 p, float tm, vec2 wind, float scale, float steep, float pace, float foot, out vec3 hessian); // five trains with curvature
float causticJacobian(vec3 hessian, float d);             // det(I + d H): d = 0.25 x depth for water
float waterCaustic(vec3 hessian, float depth, float focus, float soft); // light on the bed vs still water, times a sim's focus
float causticCells(vec2 x, float t, float foot);           // the stylised cellular net 0..1 (seams where the cells meet), x in net cells

float lightningAge(float t, float rate, int slot, out float seed); // seconds since the latest strike (random at `rate`, or the trigger)
float lightningBolt(vec2 p, vec2 top, vec2 ground, float seed, float age); // forked bolt glow at p (aspect-corrected units)
float lightningFlash(float age);                               // sky-wide flash 0..1

// Aurora (AURORA_CURTAINS feature: curtains, default 3). tm: uMotionTime; foot: radians a dither cell spans.
vec3 auroraM(vec3 dir, float tm, float strength, float foot);   // curtains of light for a view ray, to add to the night sky
vec3 auroraGlow(float tm, float strength);                       // its light on the land, to add to ambient (times auroraSeen)
float auroraSeen(Sky sky, float cloud);                          // night and open sky: multiply the curtains and their glow by it
vec3 aurora(vec3 dir, float t, float strength);                  // auroraM on t * uMotion at full detail, for scenes with their own clocks

// Shooting stars: when, and the streak in the scene's own flat sky frame (skyAngles for a dome).
float meteorAge(float tm, float rate, int slot, out float seed); // seconds since the latest one (random at `rate` while motion > 0, or slot's "now")
float meteorStreak(vec2 q, vec4 field, float age, float seed, float foot); // 0..1 coverage; starts in field (xy corner, zw size)
const vec3 METEOR_TINT;                                          // the streak's cool white, times hardEdge(coverage)

// Weather under a closed canopy (canopy.ts; bamboo, forest). The scene keeps its tint, fill, shelter, rays and mist.
struct CanopyWeather { Sky sky; float rain; float overcast; float cloud; vec2 keySide; float slant; };
CanopyWeather canopyWeather(Sky clear, float rain);       // the sky under the rain's cloud (sun and moon gone from rain 0.25, ambient
                                                          // toward the deck's grey), overcast 0..1, the deck's luminance, the key
                                                          // light's level heading (x, z) and its shafts' slant from straight down
vec3 canopyRaySources(vec3 base, float spread, float seed, float aspect, float tm, float slant); // screen x of three shafts at the top
float canopyGap(vec2 p, float wind, float seed, vec3 raySrc); // 0 under the leaves .. 1 open overhead (always under a shaft), leaning with the wind
vec3 canopyGapSky(CanopyWeather w, vec3 washed, vec3 dir, float stars, vec2 p, float wind, float seed, float deck);
                                                          // the sky in a gap: the scene's washed sky, stars while clear, the rain deck (gain deck) with shafts

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

| String          | File                           | Composed by                                                           | See                                  |
| --------------- | ------------------------------ | --------------------------------------------------------------------- | ------------------------------------ |
| `birdsGlsl`     | `src/shaders/lib/birds.ts`     | aurora, country, falls, lake, lanterns, meadow, skyward, swell, train | "Birds"                              |
| `milkyWayGlsl`  | `src/shaders/lib/milkyway.ts`  | campfire, lake                                                        | the Milky Way row below              |
| `plantsGlsl`    | `src/shaders/lib/plants.ts`    | falls, fireflies, garden, pond, tidepool                              | "Rooted plants"                      |
| `planetGlsl`    | `src/shaders/lib/planet.ts`    | orbit, campfire, mobile                                               | "The giant planet"                   |
| `figuresGlsl`   | `src/shaders/lib/figures.ts`   | country                                                               | "Figures, livestock and buildings"   |
| `livestockGlsl` | `src/shaders/lib/livestock.ts` | country                                                               | "Figures, livestock and buildings"   |
| `buildingsGlsl` | `src/shaders/buildings.ts`     | country                                                               | "Figures, livestock and buildings"   |
| `terrainGlsl`   | `src/shaders/lib/terrain.ts`   | country                                                               | `TerrainBuilder` under "Simulations" |
| `fieldsGlsl`    | `src/shaders/lib/fields.ts`    | country                                                               | the fields row below                 |
| `treesGlsl`     | `src/shaders/lib/trees.ts`     | country                                                               | the trees row below                  |

- **Fields** (`fieldsGlsl`): `fieldHold` and `fieldRows` (row profiles that settle to their mean
  where the dither cannot hold them) and `fieldFlowerMaterial` (meadow, lavender and sunflower
  materials): the countryside's flower parcels, whose use the land model (`src/sims/landuse.ts`)
  decides.
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
`COUNTRY_ALL`: roads and tracks, rain, snow, fog, pine woods, flower fields, herds, walkers and carts,
birds, lit windows, chimney smoke, the chalk M, the clouds' shadows tier and the moon's
phase; `countryFeaturesAll` checks each gated setting) and `meadow` (its wildflowers).

A scene enters with the program for its setting, so the plain page draws its lean program and
builds no other. On a GPU a knob change that needs another feature set builds none either:
building a program can stall the browser's GPU process, and every frame of the page with it, for
as long as the driver compiles. The change draws with a program the scene entered with for exactly
that set, else with the scene's all-features program. That one is built once per page, in the
background, and never waited for: the renderer asks KHR_parallel_shader_compile's completion
status or, without that extension, a fence set after the link. Once built it draws one frame, so a
driver that compiles at the first draw does it then. While the lab is open
(`DitherRenderer.expectChanges`) it is built ahead once the scene has arrived; otherwise the first
such change starts it, and the program on screen goes on drawing the settings it drew last until
it is built. A software rasteriser (a renderer string naming SwiftShader, llvmpipe, softpipe or
WARP) never uses it: there every gate's code would run in every frame (the countryside's frames
5-10x slower under SwiftShader) and it takes some 20 s to compile, a setting's own program 2-5 s.
There a change builds the setting's own program in the background in the same way, never waited
for, keeping up to four per scene (the least recently drawn freed). Rules:

- Gate each part on a superset of where its knobs show it (`x > 0` for `K_x > 0.0`), and keep the
  shader's own runtime test inside the gate: the all-features program draws by it.
- Define each gate 0 or 1 every time and test it with `#if` (a library feature tested with
  `#ifdef` is left out instead).
- Leave in anything a "now" button can show while its knob is off.
- Check that the default picture is bit for bit what it was.
- Give `featuresAll` every gate and tier `featuresFor` can select. `src/features.verify.ts` checks
  that it covers each knob's turn and, through the renderer, that it draws every gated setting
  byte for byte as the setting's own program (`featuresAll`), that no change waits for a build or
  builds a program after the first (`featureToggles`), and how the programs take over
  (`sceneFeatures`).
- Checks that draw many settings with one program compile with every gate on (`country`'s
  `COUNTRY_ALL`).

**Level of detail.** One component can be a hero subject or a far decoration. A function with a
`foot` parameter takes the size of one dither cell at that point, in its own units. For sky
directions that is radians: about the vertical field of view over `uRes.y`. Raise it where the scene
blurs, as Frost does behind thick frost. Detail finer than a cell or two fades to its area mean, as
`fbmLod` does with octaves:

- a star layer whose grid falls under ~1.25 cells becomes a faint glow;
- the aurora's finest rays become an even glow;
- a meteor's core stays about a cell wide.

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
| Milky Way      | `skyKnobs({ milkyWay })` (`skyComponentKnobs` without the clock): `K_milkyWay`                                       | opt-in `milkyWayGlsl`                   | `milkyWay(dir, band)` radiance (times the scene's tint, `K_milkyWay`, `K_stars` and night), `milkyWayStars(density, band)` the stars crowding into it; the band's pole is the scene's (`MILKY_WAY_BAND`)                                                                             |
| Moon           | `skyKnobs({ moon })`: `K_moon`                                                                                       | `SKY_MOON_PHASE`                        | `skyMoonPhase(sky, K_moon)`: the disc and halo in `skyColor`, the light in `sky.moonColor` and `sky.ambient`, the glare in `skyStars`; `skyMoonCover(sky, dir)` coverage                                                                                                             |
| Aurora         | `weatherKnobs({ aurora })`: `K_aurora`                                                                               | `AURORA_CURTAINS` (3)                   | `auroraM(dir, tm, strength, foot)` radiance, `auroraGlow(tm, strength)` light, `auroraSeen(sky, cloud)` visibility                                                                                                                                                                   |
| Canopy weather | `weatherKnobs({ rain, wind })`: `K_rain`, `K_wind`; the scene's seed knob                                            |                                         | `canopyWeather(sky, K_rain)` light (the sky under the rain's cloud, the deck's brightness, the key's side and slant); `canopyRaySources`, `canopyGap(p, wind, seed, raySrc)` coverage (where the rain pours in); `canopyGapSky(w, washed, dir, stars, p, wind, seed, deck)` radiance |
| Water          | the scene's own (`K_wind` and its water knobs)                                                                       | `WATER_TIER` (tiers, see "Water")       | slope and unresolved variance (`rippleSpectrum`, `windRipples`), mirror ray and Fresnel (`waterMirror`), drifted points (`waterDrift`, `waterFlow`), light on the bed (`waterCaustic`, the cellular net `causticCells`)                                                              |
| Clouds         | `weatherKnobs({ clouds, shadows })`: `K_clouds`, `K_shadows`; the scene's own (the cloud sea's cover, height, drift) | `CLOUD_TIER` (tiers, see "Clouds")      | the deck's plane and calm field (`cloudDeckPoint`, `cloudFlatField`), the lit deck (`skyClouds`) rgb and coverage, its shadow (`skyCloudShadow`) light on materials, the sea of tops (`cloudSeaMarch`, `cloudSeaTop`, `cloudSeaShadow`) distance, normal and light                   |
| Meteors        | `skyKnobs({ meteors: { trigger } })` (`skyComponentKnobs` without the clock): `K_meteors`                            |                                         | `meteorAge(tm, rate, slot, seed)` schedule, `meteorStreak(q, field, age, seed, foot)` coverage in the scene's frame (`skyAngles(dir)` on a dome, screen heights for a flat backdrop), `METEOR_TINT`                                                                                  |
| Birds          | `birdKnobs({ kind })` (`shaders/lib/birds.ts`): `K_birds`, `K_birdKind`, `K_birdFormation`                           | opt-in `birdsGlsl`                      | `birdFlights(p, sky, cam, tm, pxl)` coverage, depth and albedo (`BirdHit`); `birdFlightsSeen(..., true)` the image in still water; `birdBelowHit` from below                                                                                                                         |
| Rooted plants  | `plantKnobs({ group, season, growth, gusts })` (`src/scenes/plants.ts`), read by the sim only                        | opt-in `plantsGlsl`, `PLANT_DETAIL` (2) | organs on springs (`RootedPlants`) packed as records (`PlantTexture`, `plantOrgan`) for shared shapes drawn per fragment (`plantFrond`, `plantArc`, `plantPoint`), or rasterised into a sheet the scene samples (`PlantSheet`, `plantSheetGlsl`); see "Rooted plants"                |
| Giant planet   | `planetKnobs({ prefix, clouds, storms, aurora, lights, daycycle, moons, ring })` (`src/scenes/planet.ts`)            | opt-in `planetGlsl`                     | a hero composes the parts (`planetBelts`, `planetClouds`, `planetAurora`, `planetCityLights`, `planetRingBands`, `planetMoonDisc`...) as coverage and light; a decoration draws the whole giant over an RGB sky (`planetOver`); see "The giant planet"                               |

Bamboo and Forest compose the canopy weather under their leaves, each with its own tint on the
washed sky, deck gain (1.3, 1.25), shelter (half, 45% of the rain under the leaves) and ray bases.

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
vec4 cloud = skyClouds(sky, dir, t, cover, K_wind);
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

| Scene              | Sky seen                                                         | Stars                                            | Moon                                                       | Aurora                                                            | Meteors                                                                              |
| ------------------ | ---------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `train`            | through the window                                               | knob 0.75                                        | knob (phase) + night glow                                  | knob (`aurora()`)                                                 | own: `K_meteors`, trigger 5, window and tunnel                                       |
| `frost`            | through the window                                               | knob 0.5 (cabin ×1.7)                            | knob (phase)                                               | knob                                                              | knob, trigger 1                                                                      |
| `autumn`           | over the park, under the canopy                                  | knob 0.5                                         | knob (phase; keys the night light)                         | knob, behind the clouds                                           | knob, trigger 2                                                                      |
| `bees`             | over the valley                                                  | knob 0.6                                         | knob (phase)                                               | knob, behind the cumulus                                          | knob, trigger 0, screen frame                                                        |
| `dunes`            | over the dune sea                                                | knob 1 (×1.3)                                    | knob (phase; keys the sand's light)                        | knob, under the dust                                              | knob, trigger 0                                                                      |
| `falls`            | above the cliff                                                  | knob 0.45                                        | knob (phase)                                               | knob, its arc lifted over the rim                                 | knob, trigger 0, falling behind the rim                                              |
| `garden`           | the haze over the wall (the horizon is the frame's top edge)     | —                                                | knob (phase; keys the night light)                         | —                                                                 | —                                                                                    |
| `lanterns`         | over the river, mirrored                                         | knob 0.55 (+ own sparse stars, thinned below it) | own young crescent, fixed in the frame                     | knob, mirrored                                                    | knob, trigger 2, mirrored                                                            |
| `meadow`           | over the meadow                                                  | knob 0.6                                         | knob (phase)                                               | knob, behind the clouds                                           | knob, trigger 2                                                                      |
| `sill`             | over the city                                                    | knob 0.5                                         | knob (phase)                                               | knob, light through the window                                    | knob, trigger 3                                                                      |
| `skyward`          | a strip between roofs                                            | knob 0.3                                         | knob (phase)                                               | — (looking up: the curtains hang toward the horizon, out of view) | knob, trigger 0, camera frame                                                        |
| `bamboo`, `forest` | canopy gaps                                                      | knob 0.5                                         | knob (phase; the gaps and the night rays)                  | —                                                                 | —                                                                                    |
| `street`           | in reflections only                                              | knob 0.55 (window glass)                         | knob (phase; the windows and wet street)                   | —                                                                 | —                                                                                    |
| `lake`             | over the ice, mirrored                                           | own `K_stars` + shared Milky Way (knob)          | own phase, fixed bearing                                   | knob (`aurora()` on the sim's substorm clock, rough-ice tap)      | knob, trigger 3, mirrored                                                            |
| `aurora`           | the subject, mirrored in the fjord                               | own `K_stars` on a fixed night                   | own crescent                                               | own curtains                                                      | knob, trigger 1, mirrored                                                            |
| `swell`            | over the sea                                                     | own (`starfield`, `K_stars`)                     | own disc (`K_moon` sizes it) and glitter path              | —                                                                 | knob, trigger 0, screen frame, glints in the waves                                   |
| `clouds` †         | above the cloud sea                                              | knob 0.75                                        | own bearing, drawn by `skyColor`                           | knob (`aurora()`, scene clock)                                    | open                                                                                 |
| `country`          | over the valley                                                  | knob 0.5                                         | knob (phase; `SKY_MOON_PHASE` compiled in only below full) | open                                                              | open                                                                                 |
| `flock` †          | the subject over a skyline (only the dome mirrored in its water) | knob 0.45                                        | full                                                       | open                                                              | open                                                                                 |
| `island` †         | round the island                                                 | knob 0.6                                         | full                                                       | open                                                              | open                                                                                 |
| `shore` †          | over the sea, in wet sand                                        | knob 0.6 (sky and wet sand)                      | full (moonrise)                                            | open                                                              | open                                                                                 |
| `campfire` †       | above the pines                                                  | knob 0.8 + shared Milky Way (knob)               | — (the giant planet replaces it)                           | open                                                              | own: `K_shooting`, trigger 0, under the planet                                       |
| `kelp`             | Snell's window                                                   | —                                                | full, refracted                                            | —                                                                 | —                                                                                    |
| `tidepool`         | the sky in the pools' mirror                                     | —                                                | full, mirrored                                             | —                                                                 | —                                                                                    |
| `dew`              | out-of-focus dawn backdrop                                       | —                                                | —                                                          | —                                                                 | —                                                                                    |
| `bonsai`           | none (its light only)                                            | —                                                | —                                                          | —                                                                 | —                                                                                    |
| `orbit`            | its own sky                                                      | own                                              | own                                                        | —                                                                 | own (captured meteors)                                                               |
| `fireflies`        | its own moonless sky over the mangroves                          | own                                              | — (moonless)                                               | —                                                                 | knob (`skyComponentKnobs`), trigger 2, over the hills behind the trees, not mirrored |

`aurora` and `lake` keep a night of their own: their own `K_stars` knob sets the shared stars
(`skyStarLight`) on it.

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

| Scene      | Birds                                                                                                           | Default                 | Hidden by                                                         | Mirrored in       |
| ---------- | --------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------- | ----------------- |
| `country`  | `birdFlights` through its level pinhole (metres), `birdKnobs` (mixed: rooks, gulls, swallows...)                | off, mixed              | land, crowns, buildings, figures, by depth                        | —                 |
| `skyward`  | `birdBelowHit` on the scene's own paths (pigeons wheeling over the street, swifts looping above); `birds` range | 0.5, pigeons and swifts | anything nearer along the ray                                     | —                 |
| `meadow`   | `birdFlights`, `birdKnobs`                                                                                      | off, swallows           | the sea of grass by depth; the near blades and clocks             | —                 |
| `falls`    | `birdFlights` (`fallsBirds`), `birdKnobs`                                                                       | off, swifts             | cliff, rim trees and slot walls by depth; spray and the near bank | —                 |
| `swell`    | `birdFlights`, `birdKnobs`                                                                                      | off, gulls              | the sea by depth (crests, with relief)                            | —                 |
| `aurora`   | `birdFlights` in `aurFar`, `birdKnobs`                                                                          | off, geese              | the near bank and birches                                         | the fjord         |
| `lake`     | `birdFlights` in `lakeBeyond`, `birdKnobs`                                                                      | off, geese              | the cabin and the point's grove                                   | the black ice     |
| `lanterns` | `birdFlights`, `birdKnobs`                                                                                      | off, geese              | (nearer than the far bank)                                        | the rippled river |
| `train`    | `birdFlights`, `birdKnobs` (the `line` choice sets the mix)                                                     | off, mixed              | the line's land and structures (the scene's)                      | —                 |

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
  in its own frame, after the scene's own rows); `plantPoint` (GLSL) finds a point along a posed
  organ (a swaying stem's tip).
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
  own gust field, compiled in only while on). Next: meadow's near grass and dandelion stems (on
  their own springs), kelp (stipes stay on Verlet).

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
PlanetMoon planetMoon(int i, PlanetRing frame);                  // moon 0..2 of a family orbiting near the plane `frame`
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

Another sky adds it in a few lines, its own foreground drawn after:

```glsl
PlanetLook look = planetGiant(vec2(-0.4, 0.75), 0.12, normalize(vec3(-0.6, 0.4, 0.7)));
look.visible = sky.night;
look.moons = K_planetMoons;                                     // from planetKnobs({ prefix: "planet", moons: true })
col = planetOver(col, p, 1.0 / uRes.y, look, uMotionTime, uTime);
```

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
| `mirror`   | `WATER_MIRROR` 2   | reflections: `waterMirror`, the rippled normal, reflected ray and Fresnel; the scene looks its own sky and scenery up along the ray                                                                                                                                                                                                       |
| `flow`     | `WATER_FLOW` 3     | currents: `waterDrift` carries a pattern on a steady current, `waterFlow` on one that varies from place to place (two copies, evaluated twice)                                                                                                                                                                                            |
| `caustics` | `WATER_CAUSTICS` 4 | the bed lit through the surface: `causticRipples`' net (`shaders/caustics.ts`) and `waterCaustic`, which multiplies it by a simulated surface's own focus (`ShallowWater.surface`, `sims/shallow.ts`); or, for water with no spectrum of its own, the stylised cellular net `causticCells` (seams where a wandering lattice's cells meet) |

The shared parts own the physics: ripple trains with deep-water dispersion and their LEAN split
between drawn slope and unresolved variance, the cat's-paws, the mirror's normal and Fresnel, the
advection, the caustic Jacobians. The scene owns its numbers (its spectrum, its current, its
knobs), the rain rings it adds to the slope, what it mirrors and how it keeps the reflected ray
above its horizon, its body colour, foam, glitter and lights. GLSL code that draws its water more
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

| Scene      | Tier                 | Uses                                                                                                                                                       |
| ---------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aurora`   | ripples              | `windRipples`, `windMirror` on the fjord (`K_ripples`, `K_wind`)                                                                                           |
| `country`  | flat (none selected) | its own value-noise shimmer on the river; wind ripples are a later module's                                                                                |
| `island`   | mirror               | `rippleSpectrum` (a `RippleTable`: four hand-placed trains), `waterMirror`                                                                                 |
| `shore`    | mirror               | `rippleSpectrum` (a `RippleFan`: four trains by the golden angle, scaled by the wind), `waterMirror`                                                       |
| `lanterns` | flow                 | `rippleSpectrum` (a `RippleFan`: five trains rocking about the current), `waterDrift` downstream, `waterMirror`                                            |
| `tidepool` | caustics             | `causticRipples`, `waterCaustic` with `ShallowWater`'s focus; seen from above, it mirrors the sky its own way                                              |
| `pond`     | caustics             | two layers of `causticCells` on the floor, light where their seams cross, carried by the current (`waterDrift`); its drop rings and refraction are its own |

The rest of the lab's water is still drawn its own way: `lake`, `swell`, `falls`, `fireflies`,
`bamboo`, `forest`, `kelp`, `delta`, `ripple`.

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

| Scene                                                                    | Tier                                                                  | Uses                                                                                                                                                                                |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clouds`                                                                 | volume                                                                | the sea below the window (`CloudSea`: its drift, `K_cover`, the boil, `K_altitude`'s drop, amplitude 0.45); its thunderheads take `cloudBillow` and `cloudPhase`                    |
| `autumn`                                                                 | shadows                                                               | `skyCloudShadow` from its sky's deck, 300 m up, where each pixel's sight line meets the park (`K_shadows`, off by default)                                                          |
| `country`                                                                | shadows while its `shadows` knob is on (`featuresFor`), lit while off | `skyClouds` by day, by night the calm deck (`cloudDeckPoint`, `cloudFlatFine`, `cloudFlatField`) lit by the moon; `skyCloudShadow` with its rain's `low` on every point of the land |
| `train`                                                                  | flat                                                                  | `cloudDeckPoint` with the train's run under the deck, `cloudFlatField` lit as the night line's own deck                                                                             |
| `falls`, `frost`, `island`, `lake`, `meadow`, `shore`, `sill`, `skyward` | lit (none selected)                                                   | `skyClouds` over their own sky, greyed and lowered under rain each its own way                                                                                                      |

Not unified, on purpose:

- `bees`' cumulus are authored lobed billboards with drifting ground shadows of their own, a
  picture-book style rather than a deck; `island`'s far cumulus are toon billboards on the horizon,
  its ground shadows a lattice of puffs cut per cell to match them (its dome's deck is the lit tier).
- `delta` is seen from orbit: its puffs and their offset shadows are one top-down field.
- Rain overcasts drawn as a tint or a flat grey sheet over the scene's own sky (`lanterns`,
  `meadow`, `sill`, `garden`) have no cloud field to share; the canopy's deck is the canopy
  component's (`canopy.ts`), the giant planet's cloud bands the planet's (`planetClouds`).
- The clouds scene's thunderheads, wisps and contrails are authored towers and passage vapour, not a
  deck. Scenes that lower the lit deck under rain (`falls`, `sill`, `shore`, `country`) squash the
  ray before `skyClouds` each by their own amount; a shared helper would only rename a `normalize`.

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
  unscaled. Some scenes scale it down (bamboo and shore thin their rain, frost and country weigh
  their snow) so the weather never buries the subject, at the risk of faint streaks that no longer
  cross a level: do that only for such a reason, with `p.cover *= ...` before `precipOver` and a
  comment saying why.
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
- **Splashes and drips.** Hard, upward-facing ground gets `rainSplashes(p.xz, t, K_rain)` (p in
  metres) times the drop light. A crown is ~5 cells across where a metre spans 25 cells. Fade it
  out where a metre spans fewer than ~15 cells, and don't use it on water, where `rainRipples`
  belongs. Edges (eaves, leaves, branches, sills, rails) get
  `rainDrips(vec2(along, below), t, max(K_rain, 0.4 * uWeather.x), spacing)`, keeping the spacing
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
  helper of its own, `streetVanish` and `islVanish`).
- **Intensity.** Amount 0.1 is drizzle (slow faint streaks, mostly veil), 0.4 steady rain, 0.7
  heavy rain with near drops and gust sheets, and 1.0 a downpour: dense sheets sweeping with the
  wind, loud splashes, and visibility falling. Let the sky, the light, the wetness and the splashes
  follow the same scale.

## Simulations (`sim`)

When a scene needs state (particles, a height field, ink, a growing crystal, the pointer's wake),
give it a `sim: (gl) => SceneSim`. Each frame the renderer calls `frame(SimFrame)` (dt, time,
motionTime, motion, size, knob values, raw params, triggers, fired, pointer, parallax, passage) and
binds the returned textures as `uSim0..uSim3` (`uSimOn` says which are set). `parallax` is the
shader's `uPointer`: a sim casting the pointer through a camera the shader turns with it turns it too.
Simulation catch-up is capped at 0.1 s per frame; the FPS footer measures uncapped frame delivery.
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
  top), or `uploadImage(canvas)` for an rgba8 texture drawn with Canvas 2D (top row = uv.y 1).
- `TrailField` (`trail.ts`): where the pointer has been, fading; for stirring and melting.
- `VerletSystem` and `PointTexture` (`verlet.ts`): 3D position-based Verlet chains, nets and orb
  webs with impulses and nearest-point queries, packed into a texture for `texelFetch` (kelp, dew).
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
- `FluidSim` (`fluid.ts`): 2D stable fluids on `GpuCompute` with MacCormack dye, vorticity, walls,
  a GLSL force snippet, an obstacle SDF, splats and `advect` for extra fields (incense, film, pearl).
- `ArrivalField` (`front.ts`): when a front spreading from one point through a field of speeds
  reaches each texel, on the GPU (least time along rays from the source, then a few relaxing
  sweeps), so `T <= t` is where it has been: film's burst rim racing through thin film and crawling
  through thick.
- `ShallowWater` and `stillWater` (`shallow.ts`): shallow water over a bed on `GpuCompute` (virtual
  pipes, local inertial flow) that runs downhill, sloshes, shoals and breaks, driven by a GLSL
  forcing snippet (a sea, a wave maker), carrying the scene's tracers (foam, wetness) through a carry
  snippet, with splats and a `surface` texture of depth, slope and caustic focus for the shader;
  `stillWater` opens a layout settled, every pool full to its spill point (tidepool); its `LevelHeap`
  (cells by level) serves other priority floods.
- `TerrainBuilder`, `generateTerrain`, `packTerrain` (`terrain.ts`) and `terrainGlsl`
  (`shaders/lib/terrain.ts`): a whole landscape on one square map (metres, deterministic per seed),
  built in units a frame's budget spreads (`runBudgeted`): a valley laid across a vantage's view in
  fractal and ridged value noise, carved by implicit stream-power erosion over a priority-flood
  drainage with multiple-flow areas and slumped to the angle of repose (`HeightField.relax`); the
  main river traced down the drainage tree, given meanders and a width from its catchment, its level
  never rising downstream and level across its bed, banks and a floodplain; streams; settlements
  scored for flatness, water, distance and a line of sight (`marchHeight`); roads as least-cost paths
  (A\*, 16 directions) over a spanning tree of them with a shortcut and a way out, one bridge at the
  narrowest crossing, each road's profile cut and fill under `TERRAIN_ROAD_MAX_SLOPE` and its bed cut
  into the ground; buildings on terraces along the roads; woodland suitability; field parcels
  stretched along the contours or roads, each with its clear core (the widest disc clear of its
  border, water, roads, streams, yards and lone trees: a herd's ground); lone trees on hedges and
  banks; the roads resampled evenly for walkers and carts (`terrainWays`). `packTerrain` lays it
  into four textures (ground and water level with slopes; road and stream signed distances,
  woodland, yards; the nearest two parcels; records of sites, buildings, settlements, the bridge,
  the eye, cores, ways and way points), which `terrainGlsl` reads: `terrainGround`, `terrainCover`,
  `terrainParcel` (exact field borders between texels, and the neighbour's id), `terrainCore`,
  `terrainBuilding`, `terrainPlace`, `terrainBridge`, `terrainEye`, `terrainWay` and
  `terrainWayAt` (a point by arc length along a road, always on it) (country); `LandModel` and
  `packLand` (`landuse.ts`): every parcel's one use from relative shares, priced so that a share's
  change converts only that use's marginal parcels, written into the records and the woods' canopy
  (country).
- `grayScottRegimes`, `grayScottAlong` and `grayScottGlsl` (`grayscott.ts`): Gray–Scott
  reaction–diffusion's curated Pearson classes (feed, kill, what grows), an eased loop through them,
  and the reaction step for a `GpuCompute` pass (petri). Seed a dish at the first regime's levels
  and ease it over: most classes starve a fresh seed.
- `FishGroup`, `FishTexture` and `fishGlsl` (`fish.ts`): fish that swim the way they face and never
  slide (follow a moving point, gather at one, flee, wander, school, keep personal space, soft
  walls) for a species' speeds and turning, packed for the shader; GLSL to read their poses and draw
  them from above with a koi coat or side-on (pond, kelp). The scene supplies the water and light.
  Species: `KOI` (pond), `BLENNY` with `FISH_BLENNY` (the tide pool's rock pool fish).
- `RootedPlants`, `PlantTexture`, `plantClimate` (`plants.ts`): the plant component (see "Rooted
  plants" above): persistent plants rooted at the scene's sites, organs on springs under wind, gust
  fronts or current, a growth clock, the year, and a detail tier per organ from its projected size;
  records for `plantsGlsl`. `PlantSheet` (`plantsheet.ts`): the same organs rasterised on the GPU
  into a mipmapped RGBA8 sheet from a sprite atlas, for hundreds of organs (pond).
- `GpuReadback` (`readback.ts`): a small float target copied back to the CPU behind a fence and
  picked up a frame or two later, without stalling (the tide pool's flow for its plants and fish).
- `mulberry32` and `Random` (`random.ts`): the seeded generator, bit-exact with the scenes' copies
  so a seed keeps its arrangement; `Random` adds `range`, `int`, `pick`, `wait` (the gap to a
  Poisson process's next event: street's arrivals) and `gauss` (roughly normal from three draws:
  lake's crack walks) and re-seeds in place.
  Import it rather than carrying a copy (ferro's xorshift is deliberate: its pours depend on it).
- `clamp`, `lerp`, `smoothstep`, `fract`, `hash31` (`math.ts`): import them rather than a local copy;
  `glslHash12` and `glslHash22`: common.ts's hashes in float32 steps, for a sim that must place
  things where its shader hashes them (pond's koi loops, falls' ferns, the tide pool's holdfasts).
- `valueNoise` and `fbm` (`noise.ts`): seeded value noise on the CPU for laying out terrain, coasts
  and beds before a sim starts, bit for bit the delta's own; not the shader's noise (tidepool).
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
  frames, so the opening picture never depends on the machine's speed.
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
  the shader hides each behind only what stands in front of it; `followCell` keeps a hovering speck
  from flickering between two cells (bees). Not for a fixed slot per lattice cell (fireflies), a
  list the shader walks (lanterns), or per-tile lists sorted nearest first (street).
- `isShy`, `facing`, `atEase` and `stepShrink` (`temperament.ts`): how a creature takes the pointer
  coming near, curious ones turning to look and shy ones (a share of the population) shrinking away
  and coming back out a while after it has gone (forest's kodama).
- `separateDiscs` (`discs.ts`): after an integration step, moves apart bodies that touch as discs on
  a plane and have sunk into one another past a given share, a limited distance per step, coincident
  ones included; for soft-contact crowds (lanterns).
- `HeadlessSim` and `HeadlessGl` (`headless.ts`): the one harness for sim regressions. `HeadlessGl`
  is a stand-in context that takes a sim's `DataTexture` calls and keeps each texture's size and last
  upload (anything else throws, naming the call); `HeadlessSim` drives a scene's real sim on it (or
  on a real context) with frames built as the renderer builds them: knobs over their defaults, "now"
  presses by knob, pointer, passage. `step(frame).upload(slot)` is what the shader would sample.
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
cuts out) and its canopy sheet, on a worker (`src/sheet.ts`), and `src/constellations.ts` sends
orbit's constellation figures as `common`'s `uCon*` uniforms.

Keep simulations cheap (a few ms per frame at most) and scale step counts with `dt * motion`.
Sims must be deterministic for a given seed knob and survive `dt = 0` (paused) and resizes.

Knob keys share the URL with the lab's own settings, so a knob may not be called `accent`,
`scene`, `mode`, `dither`, `color`, `pixel`, `levels`, `motion`, `instance`, `mouse`, `view`,
`dim`, `blur` or `transitions`, nor take the keys of the lab's session tools, `compare`, `tour`
and `dwell` (`state.ts` refuses to load such a scene).

## Art direction

- Everything is seen through a dither at 2–4 CSS px per cell. Bold, readable shapes beat fine
  detail; features thinner than ~2 cells shimmer as they move. Avoid per-frame random noise in
  colours (it reads as flicker); animate with smooth time functions instead.
- Calm by default: a landing page sits on top. Slow, continuous motion; occasional events.
- Night-friendly dark palette, rich in full colour (`look: { color: "full", levels: 4 }` is the
  usual default), still legible in two-tone accent mode.
- A Manifold landmark: one standalone element that stands out but belongs to the scene (the pond
  has a carved stone M). Off or subtle by default, in its own `manifold` group.
- Every effect is a knob with plain-language help; occasional events get a "now" trigger.
- Performance: one full-screen pass at ~960×540 cells must hold 60 fps on an integrated GPU. Keep
  loops short (≤ 32 iterations in the common path), no nested loops over many items.

## Correctness checks

Run `bun concepts/landing/verify.ts` from the repository root with system Chromium available
(`MANIFOLD_CHROMIUM` can select its binary); name checks to run only those
(`bun concepts/landing/verify.ts frostSky pondKoi`). Each check runs on a freshly loaded page, so
it inherits nothing from the others, and has a deadline of its own: 180 s, or
`LANDING_CHECK_SECONDS` (it is started in the page and reports back when done, so no browser
protocol call waits on it). The run prints `PASS  <name> (<seconds> s)` per check, then the
results as JSON keyed by check name, and stops at the first failure (a throw or the deadline) with
`FAIL  <name>` and a non-zero exit. The isolated browser exercises actual WebGL output: Forest's
sky phase across motion changes, inherited GPU blending and preserving resize, Frost's
warmth/trace reset while paused and after resume, the shared sky components' outputs (stars, the
moon's phase, aurora, meteors) and their coupling in Frost's picture (`frost/sky.verify.ts`), the
canopy weather (`forest/canopy.verify.ts`), uncapped FPS, and saved-frame dissolve sampling across
larger, smaller, aspect-changed, and unchanged render sizes. Software WebGL is deliberate; this
check is not a real-device performance qualification.

`src/runtime.verify.ts` adds the renderer's runtime: under reduced motion a press and a trigger
age in real time while the clocks stand still (Dunes' streak clears after release; paused, ages
hold); a simulation that throws while starting or drawing, and a shader that does not build, keep
the frame loop scheduled, report the failure and recover by retry or by another scene; uniforms are
sent only when they change, including a look change made while another scene drew; and the Lab
never applies a setup while it is being built. `src/features.verify.ts` covers knob-keyed features
through the renderer, taking its context for a GPU's or a software rasteriser's whatever renders
the check. No change waits on a build (no status, log, uniform location or use of a program before
its completion or fence was seen). `sceneFeatures`, software: nothing is built ahead; a gated knob
builds its own program in the background and switches to it once built, the old frame holding until
then; several gated knobs at once build once; past four sets the least recently drawn program is
freed. `featureToggles`, GPU, for the countryside and the meadow: the plain page builds only its
own program; after the first gated change, which builds the all-features program in the
background, no change builds a program; with changes expected that program is built ahead at rest,
draws one frame without changing it, and the first change switches to it at once. `featuresAll`,
GPU: that program draws every gated setting, dithered and as source, byte for byte as the
setting's own.

The shared components have checks of their own:

- The giant planet (`campfire/planet.verify.ts`, `planet`): its ring geometry agrees between the
  line of sight, the plane and the shadow on the planet; its level of detail leaves resolved belts
  bit for bit and merges far city lights into blocks; and Campfire's composed moons, aurora, lights
  and day cycle show only where the planet does, with a moon behind it hidden.
- The water's tiers (`island/water.verify.ts`, `waterTiers`): the spectra of the three open-water
  scenes and the pond's cellular net are bit for bit what those scenes drew before they shared
  them, detail too fine to draw is skipped without changing a value, the mirror, the flow and the
  caustic light behave, and each tier's functions exist from that tier up while each adopter
  compiles at the tier it selects and not one lower.
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

CI runs these checks (gate group `landing-webgl`) and the lab's TypeScript and unit tests
(`landing-concept`) for every pull request that changes `concepts/landing/` or a source the lab
imports, and on every full run (each push to `main`, each manual dispatch).
`bun scripts/gate.ts --only landing-webgl` or `--only landing-concept` runs the same slice locally.

To add a check, write `<topic>.verify.ts` in the scene's folder exporting a function that takes a
`WebGL2RenderingContext`, throws on a regression and returns what it measured as plain JSON data,
then register it in `concepts/landing/verify-browser.ts` with one import and one
`["<name>", verifyTopic],` line at the end of `checks`. The context is the check's own (a vertex
array bound, the canvas at its default size): size the canvas for what it reads back, and restore
in a `finally` any global or shared definition it patches (`window.requestAnimationFrame`, a
scene's `glsl` or `sim`). Keep each check well under the deadline in software WebGL on a busy
machine; split a slower one into several entries.
