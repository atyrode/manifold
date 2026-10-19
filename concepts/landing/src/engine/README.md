# The engine

One world in metres, one free camera, and objects placed anywhere in it (#1082 item E1). It
replaces the three composers (`src/composer`: a room, a land, a patch, each with a camera fixed per
scene and layers painted for that camera) scene by scene: a scene moves over once its rebuild as a
document looks as good or better, and its old code is then deleted.

- **The world** is y up, metres, the ground near y = 0. A room is walls placed in it; a view from
  above is the camera looking down. Any kind can stand in any setup; a kind's `exclusive` group
  allows one of its group (one ground), and `max` caps how many.
- **A setup is a document** (`EngineDoc`, `types.ts`): the camera, the World's knobs, the placed
  objects with their transforms and options. The lab edits it; the browser keeps saved documents;
  curated scenes ship as documents. No URL query carries it.
- **Everything is true 3D.** Far scenery is modelled too, with detail by distance; fog, rain, snow
  and wind are fields in the world, so they occlude, settle and blow as they would.

## A frame

1. The camera's ray through the cell (`EngineCamera`: eye, yaw, pitch, vertical field of view).
2. Every placed object of every kind in the document: the ray into the object's frame (its `at`,
   `yaw`, `scale` inverted), a slab test against its bounds, then its kind's hit test. The nearest
   hit wins: a `Hit` with its distance, normal, material and the object's index.
3. Nothing hit: the World's sky in the ray's direction (`worldSky`, stars, clouds, sun and moon).
4. A hit is shaded once, by the shared shader: the World's key (sun or moon) times its visibility
   (a shadow ray against the objects that cast), the sky's ambient, the lights placed objects emit
   (`localLight`), wet and snow cover from the World on surfaces that face up; a mirror-like
   material (water, glass) traces one reflected ray; a see-through one (a window's glass) carries
   the ray on past it and shows what lies behind, tinted (compiled in only where a kind has one).
5. The air between the eye and the hit: height fog integrated along the ray, rain and snow as
   particles in world space along it (hidden behind the hit), lightning's flash.
6. The result is a `Shade` for the dither pass (`src/shaders/main.ts`), unchanged.

## Kinds

A kind is a manifest (`KindDef`) and its code (`KindCode`), in `src/engine/kinds/<id>/`. Its GLSL,
every name prefixed with its id, works in the object's own frame (origin at its base centre, +y up,
+z its forward, metres at scale 1) and implements the core's hit contract (`src/engine/glsl.ts`
documents it). Its options are knobs (`ParamDef`) read per instance from the instance texture, so a
slider never builds a program; an option listed in `compiled` selects code and is part of the program
key. A kind may emit light, cast shadows, and run a sim whose state it reads back per instance: its
`KindCode.sim` runs one sim per placed object on the CPU, keyed by the object's id (it lives through
moves and edits, a new object's warms up first, a removed one's is dropped), all on fixed steps of the
motion clock, into its block of the state texture (`src/engine/state.ts`), which its GLSL reads as
`<id>State(o, x, y)`. The lava lamp's wax is one (`src/engine/kinds/lavaLamp`).

## Programs

A program is the set of kinds a document holds, their compiled options, and the instance count of
each rounded up to a bucket; moving, turning, scaling or tuning an object only uploads data. The
shaker (`src/shaders/shake.ts`) and the program cache (`src/program-cache.ts`) are the composers'.

## The lab

The lab shows what the document holds: the outliner lists its objects, the palette adds a kind (a
refused one says why), a click in the picture selects the object under it, a drag moves it across
whatever surface lies under the pointer, and the inspector shows the selected object's transform and
its kind's options alone, beside the camera, the World and the look.
