// Ferrofluid: a pool of black magnetic fluid in a shallow dish over a magnet. Past a threshold field
// the Rosensweig instability stands the surface up in a hexagonal crown of spikes; the field
// breathes, so the crown rises out of a mirror-smooth pool, holds, and sinks back. The pool is seven
// blobs on damped springs that slosh after the magnet (the pointer), and the spikes' heights and lean
// follow its field (sim.ts); the shader traces the spiky surface cell by cell across the lattice and
// lights it as a black mirror in a studio of softboxes (shader.ts).
import { choice, feature, range, seed, toggle, type ParamDef } from "../../params.ts";
import type { SceneDef } from "../types.ts";
import { ferroGels, ferroGlsl } from "./shader.ts";
import { ferroSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  range("magnet", "strength", "field strength", 0.6, "How strong the magnet is at the top of each breath. Weak: a few spikes in the middle. Strong: a crown over the whole pool, taller and drawn in tighter."),
  feature("magnet", "breath", "breathing", true, "speed", 0.5, "The field swells and fades: spikes rise from the middle into a crown, hold, and sink back into a mirror-smooth pool. Off: the field holds and the crown stands."),
  range("magnet", "drift", "drift", 0.35, "The magnet wanders slowly under the dish while the pointer is away; the pool follows it, sloshing a little."),
  toggle("magnet", "follow", "pointer magnet", true, "The magnet follows your pointer: the pool slides after it with a slosh and the spikes gather above it. Hold the button to press the magnet closer and the crown surges."),
  range("fluid", "size", "pool size", 0.5, "How much ferrofluid is in the dish."),
  range("fluid", "spacing", "spike scale", 0.5, "How far apart the spikes stand: many small ones to the left, fewer and larger to the right."),
  range("fluid", "sharpness", "sharpness", 0.6, "Left: low, rounded cones. Right: tall needles on flared feet."),
  seed("fluid", "pour", "pour", "How the fluid was poured: the gentle lumps in the pool's outline and the path the magnet drifts along."),
  choice("studio", "view", "view", [{ label: "above", value: 0 }, { label: "three-quarter", value: 1 }], 1, "Three-quarter: low over the dish, the crown's back row standing black against the softbox mirrored in the black glass. Above: straight down, the ring light mirrored in the black pool and each spike a star of highlights."),
  choice("studio", "gel", "coloured light", ferroGels.map((gel, value) => ({ label: gel.label, value })), 1, "The studio light on the right is gelled: its colour runs down one flank of every spike and round the dish's lip. White: a plain studio."),
  range("studio", "lights", "lights", 0.6, "How bright the studio lights mirrored in the fluid are; low leaves a black pool drawn by a few crisp highlights."),
  feature("manifold", "mark", "M of magnets", false, "how often", 0.3, "Magnets laid out in an M under the dish: now and then a breath raises the spikes along the M instead of the crown, then lets them sink. More often: every breath.", { trigger: 0 }),
];

export const ferroScene: SceneDef = {
  id: "ferro",
  title: "Ferrofluid",
  blurb: "Black magnetic fluid in a dish, breathing a crown of spikes in and out of a mirror.",
  accent: "#ff6a2b",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    magnet: { title: "Magnet", blurb: "The magnet under the dish: how strong it is, how its field breathes, and whether it follows your pointer." },
    fluid: { title: "Ferrofluid", blurb: "How much fluid is in the dish and the shape of the spikes it stands up in." },
    studio: { title: "Studio", blurb: "Where you look from and the lights mirrored in the black fluid." },
    manifold: { title: "Manifold mark", blurb: "Magnets in an M under the dish, standing the spikes up along its strokes." },
  },
  glsl: ferroGlsl,
  entry: "sceneFerro",
  sim: ferroSim(params),
};
