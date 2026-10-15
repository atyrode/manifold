# Writing a scene

A scene is one folder, `src/scenes/<id>/`, whose `index.ts` exports a `SceneDef` (see `types.ts`).
The registry `src/scenes/index.ts` lists scenes in lab order. Everything a scene needs is in its
folder; shared pieces live in `src/shaders/common.ts` and `src/shaders/lib/` (GLSL),
`src/scenes/atmosphere.ts` (shared knobs, page themes), `src/params.ts` (knob builders,
`KnobReader`), `src/sims/` (simulation helpers, CPU and GPU), `src/mark.ts` (the Manifold M) and
`src/shaders/glsl.ts` (GLSL literals from TS).

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
- Things move into place, enter or leave the frame, a camera settles, a process starts up. Some examples:
  - The border plants of `pond` close in from the edges as the koi swim into view.
  - `country` tilts down from the sky onto the valley.
  - `chladni` strews sand on a still plate that then starts singing; on exit the plate tilts and the sand slides off.
  - `sill`'s cat hops up onto the sill.
  - `train` comes out of a tunnel.
  - `shanshui` unrolls its scroll.
  - `ferro` raises its spikes out of a flat pool.
  Light changes are at most an accent.
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
`skyStars`, 0 none .. 1 a dark-site sky), `skyKnobs({ moon: 1 })` adds `K_moon` (the moon's phase for
`skyMoonPhase`, 1 full, 0 while switched off: no moon), `skyKnobs({ meteors: { trigger: 1 } })` adds
`K_meteors` (shooting stars for `meteorAge`, off by default, "now" on that slot), and
`weatherKnobs({ clouds: 0.3 })` adds `K_clouds` (fair-weather cover 0..1, which rain and snow
thicken). A scene with a night of its own (an hour knob, a painted sky) takes the components without
the clock from `skyComponentKnobs({ meteors, group })`. Use `atmosphereGroups.sky` / `.weather` for
their lab headings, `.skyNight` for a sky group that also holds components.

A knob with `trigger: n` gets a "now" button that stamps `uTriggers[n]` with the scene clock;
read it with `sinceTrigger(n)` (huge while idle) in GLSL and `frame.fired[n]` in a sim. Use slots
0..7; lightning takes the slot you give `weatherKnobs`.

### Page theme

The copy sits on the scene, so a light scene needs the paper theme (dark copy). Decide it once, in
`theme`, from the knobs: `skyTheme(params, { from, to, rainBelow, when })` is paper on a still
daylight clock (day cycle off, `from < K_time < to`, default 0.33..0.67, rain below `rainBelow`,
and `when(values)`); `paletteTheme(params, key, (index, values) => ...)` is paper for some options
of a choice or toggle (a palette, a backdrop). Both throw a KnobError as the scene loads if a knob
they read is missing (or the palette knob is another kind). The shader never repeats the test:
`pagePaper()` reads the page background, and `inkOf` follows it.

### Shared libraries (`src/shaders/lib/`)

Coordinates: `viewRay` gives x right, y up, z into the scene.

```glsl
float timeOfDayM(float time, float cycle, float motionTime); // K_time, K_cycle, uMotionTime -> 0..1 (0 midnight, .25 sunrise, .5 noon, .75 sunset)
struct Sky { vec3 sun; vec3 moon; float day; float twilight; float night; vec3 sunColor; vec3 ambient; vec3 moonColor; }; // + float moonPhase with SKY_MOON_PHASE
Sky skyAt(float tod);                                     // sun rises on the right, crosses high, sets on the left; moon opposite
vec3 viewRay(vec2 uv, float aspect, float horizon, float fov); // side-on camera, horizon at screen height `horizon`
vec3 skyColor(Sky sky, vec3 dir);                         // gradient, sunset glow, sun and moon discs (no stars)
float skyStars(Sky sky, vec3 dir, float density);         // stars faded by daylight, stable per direction
float skyStars(Sky sky, vec3 dir, float density, float foot); // the same with a level of detail: foot = radians a dither cell spans
float skyStarFade(Sky sky, vec3 dir);                     // where stars show at all: night, height, away from the moon's disc and glare
vec4 skyClouds(Sky sky, vec3 dir, float t, float cover, float wind); // a cloud deck seen from below: rgb, alpha
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
                                                          // one wind-ripple train, LEAN-filtered: sum them; xy slope, z slope variance too fine to draw

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

1. **Controls.** A knob builder in `atmosphere.ts` (`skyKnobs`, `weatherKnobs`) with shared keys,
   labels and help, so they ride the URL, reset, shuffle and presets like any knob. Optional
   components are opt-in and start at the value the scene already draws with, or off, so adopting
   one never changes the default picture. Give a scene a knob only if its shader reads it.
2. **Capabilities.** `SceneDef.features` puts `#define NAME n` ahead of the libraries. A capability
   no scene selects is not in its program. A function a scene never calls costs nothing anyway, so
   features are for what changes a function every scene calls (the moon's phase inside `skyColor`)
   or for a cheaper tier of a costly loop (`AURORA_CURTAINS`). A scene that reads a component's knob
   without selecting its feature fails to compile (`skyMoonPhase` does not exist), never silently.
3. **Outputs.** GLSL functions in `src/shaders/lib/` that return explicit values:
   - *coverage* 0..1: multiply it by the scene's own occlusion, then cut moving edges with `hardEdge`;
   - *radiance*: light added to the sky before the scene draws what stands in front of it;
   - *light on materials*: added into the scene's own lighting;
   - *visibility*: what hides the component (night, cloud).

   They read only the common uniforms (clocks, triggers). Everything that belongs to the scene is a
   parameter: directions, footprints, fields and trigger slots.

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

| Component | Controls | Features | Outputs |
|---|---|---|---|
| Stars | `skyKnobs({ stars })`: `K_stars` | | `skyStars(sky, dir, density, foot)` coverage, `SKY_STAR_TINT`; `skyStarFade` |
| Moon | `skyKnobs({ moon })`: `K_moon` | `SKY_MOON_PHASE` | `skyMoonPhase(sky, K_moon)`: the disc and halo in `skyColor`, the light in `sky.moonColor` and `sky.ambient`, the glare in `skyStars`; `skyMoonCover(sky, dir)` coverage |
| Aurora | `weatherKnobs({ aurora })`: `K_aurora` | `AURORA_CURTAINS` (3) | `auroraM(dir, tm, strength, foot)` radiance, `auroraGlow(tm, strength)` light, `auroraSeen(sky, cloud)` visibility |
| Meteors | `skyKnobs({ meteors: { trigger } })` (`skyComponentKnobs` without the clock): `K_meteors` | | `meteorAge(tm, rate, slot, seed)` schedule, `meteorStreak(q, field, age, seed, foot)` coverage in the scene's frame (`skyAngles(dir)` on a dome, screen heights for a flat backdrop), `METEOR_TINT` |

Frost composes all four in the sky through its window (`frost/index.ts`, `frost/shader.ts`):

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
**own**: a scene-specific version kept on purpose. **—**: not applicable, no knob. Rows marked † are
scenes owned elsewhere this round, left as they were (their **open** cells: an open night sky where
the component could be composed).

| Scene | Sky seen | Stars | Moon | Aurora | Meteors |
|---|---|---|---|---|---|
| `frost` | through the window | knob 0.5 (cabin ×1.7) | knob (phase) | knob | knob, trigger 1 |
| `autumn` | over the park, under the canopy | knob 0.5 | knob (phase; keys the night light) | knob, behind the clouds | knob, trigger 2 |
| `bees` | over the valley | knob 0.6 | knob (phase) | knob, behind the cumulus | knob, trigger 0, screen frame |
| `dunes` | over the dune sea | knob 1 (×1.3) | knob (phase; keys the sand's light) | knob, under the dust | knob, trigger 0 |
| `falls` | above the cliff | knob 0.45 | knob (phase) | knob, its arc lifted over the rim | knob, trigger 0, falling behind the rim |
| `garden` | the haze over the wall (the horizon is the frame's top edge) | — | knob (phase; keys the night light) | — | — |
| `lanterns` | over the river, mirrored | knob 0.55 (+ own sparse stars, thinned below it) | own young crescent, fixed in the frame | knob, mirrored | knob, trigger 2, mirrored |
| `meadow` | over the meadow | knob 0.6 | knob (phase) | knob, behind the clouds | knob, trigger 2 |
| `sill` | over the city | knob 0.5 | knob (phase) | knob, light through the window | knob, trigger 3 |
| `skyward` | a strip between roofs | knob 0.3 | knob (phase) | — (looking up: the curtains hang toward the horizon, out of view) | knob, trigger 0, camera frame |
| `bamboo`, `forest` | canopy gaps | knob 0.5 | knob (phase; the gaps and the night rays) | — | — |
| `street` | in reflections only | knob 0.55 (window glass) | knob (phase; the windows and wet street) | — | — |
| `lake` | over the ice, mirrored | own `K_stars` + Milky Way | own phase, fixed bearing | knob (`aurora()` on the sim's substorm clock, rough-ice tap) | knob, trigger 3, mirrored |
| `aurora` | the subject | own `K_stars` on a fixed night | own crescent | own curtains | open |
| `clouds` † | above the cloud sea | fixed 0.75 | own bearing, drawn by `skyColor` | knob (`aurora()`, scene clock) | open |
| `country` † | over the valley | fixed 0.4 | full | open | open |
| `flock` † | the subject, mirrored in water | fixed 0.45 | full | open | open |
| `island` † | round the island | knob 0.6 | full | open | open |
| `shore` † | over the sea, in wet sand | fixed 0.6 | full (moonrise) | open | open |
| `train` † | through the window | fixed 0.75 | full + night glow | knob (`aurora()`) | own: `K_meteors`, trigger 5, window and tunnel |
| `campfire` † | above the pines | knob 0.8 + own Milky Way | — (the giant planet replaces it) | open | own: `K_shooting`, trigger 0, under the planet |
| `kelp` † | Snell's window | — | full, refracted | — | — |
| `tidepool` | the sky in the pools' mirror | — | full, mirrored | — | — |
| `dew` | out-of-focus dawn backdrop | — | — | — | — |
| `bonsai` | none (its light only) | — | — | — | — |
| `orbit` †, `swell`, `fireflies` | their own skies | own | own (`fireflies`: moonless) | — | own (`orbit`'s captured meteors); `swell`, `fireflies`: open |

The rest have no sky: `bar`, `chladni`, `delta`, `ferro`, `film`, `fractal`, `harmonograph`,
`hyperbolic`, `incense`, `lava`, `marble`, `pearl`, `pendula`, `petri`, `physarum`, `pond`,
`prism`, `ripple`, `sandtable`, `shanshui`.

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
sees it, `amount(frame, key)` a feature's amount even while it is off, `initial(key)` its default
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
- `GpuCompute` (`gpu.ts`): float render targets, ping-pong grids, fullscreen passes and point
  scatters for GPU simulations (petri, physarum, delta). `create` returns undefined without float
  render targets: the scene must then draw a still picture instead. It leaves the GL state the
  renderer expects (framebuffer unbound, blending off, the renderer's vertex array bound).
- `FluidSim` (`fluid.ts`): 2D stable fluids on `GpuCompute` with MacCormack dye, vorticity, walls,
  a GLSL force snippet, an obstacle SDF, splats and `advect` for extra fields (incense, film, pearl).
- `mulberry32` and `Random` (`random.ts`): the seeded generator, bit-exact with the scenes' copies
  so a seed keeps its arrangement; `Random` adds `range`, `int` and `pick`.
- `clamp`, `lerp`, `smoothstep`, `fract`, `hash31` (`math.ts`).
- `LevelCamera` (`camera.ts`): world ↔ screen for the level side-on camera (horizon, eye height,
  focal): move things in the world and project them, so receding slows them across the frame and
  draws them to the horizon (meadow's seeds).
- `FixedStep` and `runBudgeted` (`clock.ts`): a fixed-step accumulator (`advance` returns the steps
  due; `alpha`, `lag(i)`), and warm-ups counted in steps, which a time budget only spreads over
  frames, so the opening picture never depends on the machine's speed.
- `toHalf` and `splitHalf` (`half.ts`): a number as two half floats (hi + lo) for a 16f texture,
  decoded in GLSL by `unsplitHalfGlsl`.
- `BinLists` (`bins.ts`): per-bin lists of the segments and points that reach each square bin of
  the frame, for a shader that walks only its cell's list (dew); a list grows by pages of
  `BIN_PAGE` entries, so a dense patch never drops one. Read in GLSL with `binListsGlsl`.
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
- `gustPulse`, `GustTrain`, `windSign`, `windNoise` (`wind.ts`): the lab's wind conventions (K_wind
  -1..1, gusts blowing with it), the gust pulse garden and autumn use, a seeded gust scheduler with
  "now", and smooth eddy noise (mobile).
- `Mobile`, `designMobile`, `MobileTexture`, `mobileGlsl` (`mobile.ts`): a balanced hanging mobile on
  `VerletSystem` with plate drag and contacts, and GLSL tracing its plates, wires and links and the
  shadows they throw from a round lamp (mobile).

Outside `src/sims/`: `src/mark.ts` is the Manifold M for TS (`MARK_VERTICES`, `markVertex`,
`segmentDistance`, `markDistance`) and the source of the GLSL one (`markGlsl`), so a stamped M and
a drawn M cannot drift; `src/shaders/glsl.ts` writes GLSL from TS: `glslFloat` (an exact literal,
tiny constants included), `glslVec3` (from `"#rrggbb"` or a triple) and `glslPick(knob, cases,
fallback)` (a palette table of `if (K_<knob> < i.5) return ...;` lines).

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
(`MANIFOLD_CHROMIUM` can select its binary). The isolated browser exercises actual WebGL output:
Forest's sky phase across motion changes, inherited GPU blending and preserving resize, Frost's
warmth/trace reset while paused and after resume, the shared sky components' outputs (stars,
the moon's phase, aurora, meteors) and their coupling in Frost's picture (`frost/sky.verify.ts`),
uncapped FPS, and saved-frame dissolve sampling across larger, smaller, aspect-changed, and
unchanged render sizes. Software WebGL is deliberate;
this check is not a real-device performance qualification.

`src/runtime.verify.ts` adds the renderer's runtime: under reduced motion a press and a trigger
age in real time while the clocks stand still (Dunes' streak clears after release; paused, ages
hold); a simulation that throws while starting or drawing, and a shader that does not build, keep
the frame loop scheduled, report the failure and recover by retry or by another scene; uniforms are
sent only when they change, including a look change made while another scene drew; and the Lab
never applies a setup while it is being built.
