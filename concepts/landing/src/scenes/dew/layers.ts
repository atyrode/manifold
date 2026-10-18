// The Dew preset's layers (ADR 0062 Phase 2c): their manifests, which load without their code
// (shader.ts, sim.ts). Both are drawn through the macro rig alone (DEW_RIG): the web is laid out in
// the frame half a metre off and the meadow behind it out of focus, so another rig is not offered
// them, and no layer of another scene is offered this one (a guest stood on the floor would be drawn
// sharp in a picture with nothing sharp behind the web).
//   bokeh  backdrop: what lies far out of focus behind the web, `backdrop` (a dawn meadow with a hazy
//          hedge, soft bokeh from the low sun on the dew and mist over the grass tops; the same in
//          deep shadow; or thick dawn mist), under the World's sky seen out of focus (its dome and
//          light at the hour, greyed under rain or snow, its lightning's flash), wet in the World's
//          rain and white under its lying snow; the air the World's fog and drops take. The camera
//          keeps the low sun beyond the frame's right edge, so the World's view turns with it
//          (dewBegin). Its grass tops close the floor: none of it shows.
//   web    dressing, the subject: the orb web between two grass stems (sim.ts: a Verlet net in the
//          breeze, its big drops creeping, merging and falling; a row of the records atlas and two
//          field slots), the beads and drops as little lenses holding the meadow upside down, the
//          wasp spider at the hub and her M. It hangs in front of the bokeh and its drops hold it,
//          so it needs it.
// What each draws is at the top of shader.ts, how the web lives at the top of sim.ts. Keys kept from
// the scene: breeze (its "now" a gust on the web), dew, dof, spider, backdrop; `webSeed` became the
// composer's `seed`, the M `webMark` (bees' apiary holds `mark`), `time` and `cycle` the World's.
import type { CameraRange, LayerDef } from "../../composer/types.ts";
import { choice, feature, range, toggle } from "../../params.ts";
import { DEW_DATA, DEW_RIG } from "./constants.ts";

/** The macro rig, and no other. */
const MACRO: CameraRange = {
  eye: [DEW_RIG.eye, DEW_RIG.eye],
  horizon: [DEW_RIG.horizon, DEW_RIG.horizon],
  focal: [DEW_RIG.focal, DEW_RIG.focal],
  pitch: [DEW_RIG.pitch, DEW_RIG.pitch],
};

export const bokehLayer: LayerDef = {
  id: "bokeh",
  title: "Out of focus",
  composers: ["outdoor"],
  role: "backdrop",
  bands: ["far", "middle"],
  space: { anchors: [], claims: [] },
  camera: MACRO,
  switch: toggle(
    "layers",
    "bokeh",
    "out of focus",
    false,
    "What lies behind the web, far out of focus: a dawn meadow with a hazy hedge under the sky, soft bokeh from the low sun on the dew and mist over the grass tops.",
    { icon: "fields" },
  ),
  params: [
    choice(
      "bokeh",
      "backdrop",
      "backdrop",
      [
        { label: "meadow", value: 0 },
        { label: "dark", value: 1 },
        { label: "misty", value: 2 },
      ],
      0,
      "What lies behind, far out of focus: a dawn meadow with a hazy hedge, soft bokeh from the low sun on the dew, and mist over the grass tops; the same in deep shadow; or thick dawn mist.",
    ),
  ],
  groups: {
    bokeh: { title: "Backdrop", blurb: "What lies behind the web, far out of focus." },
  },
  passes: { begin: "bokehBegin", far: "bokehFar" },
};

export const webLayer: LayerDef = {
  id: "web",
  title: "Orb web",
  composers: ["outdoor"],
  role: "dressing",
  subject: true,
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: MACRO,
  switch: toggle(
    "layers",
    "web",
    "orb web",
    false,
    "An orb web up close, strung with dew between two grass stems, glinting as it breathes in the breeze; the wasp spider at its hub. Click a thread to pluck it; drag to strum.",
    { icon: "web" },
  ),
  params: [
    range(
      "web",
      "breeze",
      "breeze",
      0.35,
      "How hard the breeze presses on the web. Still air to the left; to the right the web billows and ripples out of its plane and the grass stems nod. Now: a gust, shaking a few heavy drops loose.",
    ),
    range(
      "web",
      "dew",
      "dew",
      0.6,
      "How heavy the dew lies. Left: a dry web with its silk catching the light. Right: every thread strung with beads, and big drops gathering, creeping down the threads, running together and falling.",
    ),
    range(
      "web",
      "dof",
      "depth of field",
      0.5,
      "How shallow the focus is. The camera stays focused on the hub; threads and drops that swing toward you or away soften and fade, like silk through a macro lens.",
    ),
    toggle(
      "web",
      "spider",
      "spider",
      true,
      "The wasp spider (an Argiope) resting head down at the hub, her abdomen banded yellow and black, her legs held in pairs in an X, a zig-zag ribbon of silk above and below her. Once in a while she shifts a leg.",
    ),
    feature(
      "manifold",
      "webMark",
      "M stabilimentum",
      false,
      "size",
      0.5,
      "Garden spiders weave a band of zig-zag silk across the hub, the stabilimentum, usually a cross or a line. This one weaves an M in place of her usual zig-zag ribbon, and sits at its heart.",
    ),
  ],
  groups: {
    web: {
      title: "Web",
      blurb:
        "The breeze, the dew and the focus, and the spider at the hub. Click a thread to pluck it; drag to strum.",
    },
    manifold: { title: "Manifold mark", blurb: "The spider's own landmark, woven into the hub." },
  },
  triggers: ["breeze"],
  mark: "webMark",
  requires: ["bokeh"],
  data: DEW_DATA.web,
  passes: { front: "webFront" },
};
