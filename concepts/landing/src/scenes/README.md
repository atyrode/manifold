# Writing a scene

A scene is one folder, `src/scenes/<id>/`, whose `index.ts` exports a `SceneDef` (see `types.ts`).
The registry `src/scenes/index.ts` lists scenes in lab order. Everything a scene needs is in its
folder; shared pieces live in `src/shaders/lib/` (GLSL), `src/scenes/atmosphere.ts` (knobs) and
`src/sims/` (simulation helpers, CPU and GPU).

```
src/scenes/<id>/index.ts    SceneDef: title, blurb, accent, look, params, groups, glsl, entry, sim
src/scenes/<id>/shader.ts   export const <id>Glsl = `...` defining Shade scene<Id>(vec2 uv, vec2 cell, float t)
src/scenes/<id>/sim.ts      optional SimFactory (CPU or GPU simulation feeding textures)
```

## The shader

Each scene compiles to its own program: `common` + shared `libs` + generated knob defines + the
scene's `glsl` + the dithering `main`. The entry returns a `Shade`:

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
scene's accent colour (the Manifold landmark, bioluminescence, a neon sign...).

Available in GLSL (from `common`): `uRes`, `uTime`, `uMotion` (0..1, multiply animation speeds by
it), `uPointer` (smoothed -1..1 parallax, 0 when the pointer is not followed), `uMouse` (raw
pointer: xy in uv, z = button held, w = scene time of the last press), `uParams[]`, `uTriggers[]`,
`sinceTrigger(slot)`, `uSim0..uSim3` + `uSimOn` (textures from the scene's sim), `hash12`,
`vnoise`, `fbm`, `rotate`, `rotateAbout`, `segmentDistance`, `markDistance` (the Manifold M in
mark units: x in [-0.47, 0.47], y in [-0.5, 0.5]), `starfield`, `LUMA`, `TAU`.

### Knobs

Declare knobs with the builders in `src/params.ts` (`range`, `toggle`, `feature`, `choice`, `seed`,
`counts`). Each knob gets a define: `K_<key>` reads its value (a feature reads its amount while on
and 0 while off). Never index `uParams` by hand in new scenes. Keys are camelCase letters.

Shared knobs come from `src/scenes/atmosphere.ts`: `skyKnobs()` gives `K_time`, `K_cycle`;
`weatherKnobs({...})` gives `K_rain`, `K_snow`, `K_fog`, `K_wind`, `K_lightning`, `K_aurora`
as requested. Use `atmosphereGroups.sky` / `.weather` for their lab headings.

A knob with `trigger: n` gets a "now" button that stamps `uTriggers[n]` with the scene clock;
read it with `sinceTrigger(n)` (huge while idle). Use slots 0..7; lightning takes the slot you give
`weatherKnobs`.

### Shared libraries (`src/shaders/lib/`)

Coordinates: `viewRay` gives x right, y up, z into the scene.

```glsl
float timeOfDay(float time, float cycle, float t);       // K_time, K_cycle -> 0..1 (0 midnight, .25 sunrise, .5 noon, .75 sunset)
struct Sky { vec3 sun; vec3 moon; float day; float twilight; float night; vec3 sunColor; vec3 ambient; vec3 moonColor; };
Sky skyAt(float tod);                                     // sun rises on the right, crosses high, sets on the left; moon opposite
vec3 viewRay(vec2 uv, float aspect, float horizon, float fov); // side-on camera, horizon at screen height `horizon`
vec3 skyColor(Sky sky, vec3 dir);                         // gradient, sunset glow, sun and moon discs (no stars)
float skyStars(Sky sky, vec3 dir, float density);         // stars faded by daylight, stable per direction
vec4 skyClouds(Sky sky, vec3 dir, float t, float cover, float wind); // a cloud deck seen from below: rgb, alpha

float rainStreaks(vec2 uv, float aspect, float t, float amount, float wind); // 0..1 coverage, several depth layers
float snowFlakes(vec2 uv, float aspect, float t, float amount, float wind);  // 0..1 coverage
vec3 glassDrops(vec2 uv, float aspect, float t, float amount);  // rain on a pane: xy refraction offset, z drop coverage
vec3 rainRipples(vec2 p, float t, float amount);                // rings on a wet surface: xy normal tilt, z ring light
float fogAmount(float fog, float distance, float height);      // 0..1 of fog colour to mix in (distance 0 near..1 far)

float lightningAge(float t, float rate, int slot, out float seed); // seconds since the latest strike (random at `rate`, or the trigger)
float lightningBolt(vec2 p, vec2 top, vec2 ground, float seed, float age); // forked bolt glow at p (aspect-corrected units)
float lightningFlash(float age);                               // sky-wide flash 0..1

vec3 aurora(vec3 dir, float t, float strength);                // curtains of light for a view ray, to add to the night sky
```

Name scene-local GLSL functions with the scene id as a prefix (`dunesHeight`, `sillCat`) so they can
never collide with common or library functions.

## Simulations (`sim`)

When a scene needs state (particles, a height field, ink, a growing crystal, the pointer's wake),
give it a `sim: (gl) => SceneSim`. Each frame the renderer calls `frame(SimFrame)` (dt, time,
motion, size, knob values, raw params, triggers, pointer) and binds the returned textures as
`uSim0..uSim3` (`uSimOn` says which are set). Helpers in `src/sims/` (each file's header has the
full API and a usage example):

- `DataTexture` (`texture.ts`): r8/rg8/rgba8/r16f/rg16f/rgba16f from typed arrays (rows bottom to
  top), or `uploadImage(canvas)` for an rgba8 texture drawn with Canvas 2D (top row = uv.y 1).
- `TrailField` (`trail.ts`): where the pointer has been, fading; for stirring and melting.
- `VerletSystem` and `PointTexture` (`verlet.ts`): 3D position-based Verlet chains, nets and orb
  webs with impulses and nearest-point queries, packed into a texture for `texelFetch` (kelp, dew).
- `HeightField` (`heightfield.ts`): stamps, grooves and rakes with side ridges, angle-of-repose
  slumping, smoothing, upload to r16f (garden, sand table).
- `GpuCompute` (`gpu.ts`): float render targets, ping-pong grids, fullscreen passes and point
  scatters for GPU simulations (petri, physarum, delta). `create` returns undefined without float
  render targets: the scene must then draw a still picture instead. It leaves the GL state the
  renderer expects (framebuffer unbound, blending off, the renderer's vertex array bound).
- `FluidSim` (`fluid.ts`): 2D stable fluids on `GpuCompute` with MacCormack dye, vorticity, walls,
  a GLSL force snippet, an obstacle SDF, splats and `advect` for extra fields (incense, film, pearl).

Keep simulations cheap (a few ms per frame at most) and scale step counts with `dt * motion`.
Sims must be deterministic for a given seed knob and survive `dt = 0` (paused) and resizes.

Knob keys share the URL with the lab's own settings, so a knob may not be called `accent`,
`scene`, `mode`, `dither`, `color`, `pixel`, `levels`, `motion`, `instance`, `mouse`, `view`,
`dim` or `blur` (`state.ts` refuses to load such a scene).

Moving hard edges flicker under the dither when a soft edge steps each colour channel at its own
moment. Compare the edge's coverage with the cell's own `threshold(cell)` so a passing edge flips
each cell once (`bambooHard`, `shanSolid`, `dewRamp` are examples), and keep `shimmer` off anything
large: the page re-rolls it several times a second.

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
