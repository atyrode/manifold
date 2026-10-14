// Pendulum wave: a row of pendulums of slowly increasing length, hung from a beam over a dark table.
// In one cycle pendulum n makes N0 + n swings, so they start in line, drift into travelling waves, a
// double helix and apparent chaos, and come back into line. The swing is analytic (exact small-angle
// motion, or real pendulums' wider, slower swing), so there is no simulation: shader.ts traces the
// beam, bobs, threads, shadows and trails per pixel.
import { choice, counts, feature, range, toggle, type ParamDef } from "../../params.ts";
import type { SceneDef } from "../types.ts";
import { PENDULA_PASSAGE, pendulaBeams, pendulaCameras, pendulaGlsl } from "./shader.ts";

const params: readonly ParamDef[] = [
  choice("wave", "count", "pendulums", counts(15, 18, 21, 24), 18, "How many pendulums hang in the row. Each is a little shorter than the one before, so each swings a little faster: one more swing per cycle."),
  range("wave", "cycle", "cycle", 100, "Seconds for the whole pattern to run its course and the row to line up again. Short: the waves rush past. Long: a slow, unhurried unfolding.", { min: 40, max: 240, step: 5 }),
  range("wave", "swing", "swing", 0.5, "How far the pendulums are drawn back. A small swing keeps the row tidy; a wide one makes the waves and the helix broad."),
  toggle("wave", "release", "gentle re-release", true, "The swing runs down a little each cycle. On: every third time the row lines up it is given a gentle push and the swing recovers. Off: it swings forever at the same height."),
  choice("wave", "physics", "physics", [{ label: "ideal", value: 0 }, { label: "real", value: 1 }], 0, "Ideal: every pendulum swings exactly as a small swing does, so the row lines up again on the dot. Real: a board draws every bob back as far as the longest one swings, so the shorter ones swing wider, and a wide swing takes a little longer than a small one, as with real pendulums. The row slips off its schedule and only roughly lines up again: about a quarter of a swing out at the smallest swing, a whole swing or more from the middle up."),
  choice("view", "camera", "camera", pendulaCameras.map((camera, value) => ({ label: camera.label, value })), 1, "Side: low and nearly end-on, the waves running into the depth. 3/4: the soft corner view. Top: looking straight down, where the waves and the double helix read as plain curves."),
  feature("view", "trail", "trails", false, "length", 0.5, "Each bob leaves the faint arc of where it has just been, a few dotted strokes that fade behind it, so the direction of every swing shows."),
  choice("metal", "material", "bobs", [{ label: "brass", value: 0 }, { label: "steel", value: 1 }, { label: "anodised", value: 2 }], 0, "Polished brass, polished steel, or anodised aluminium in a pale hue that changes along the row, which helps the eye follow a single wave."),
  choice("metal", "beam", "beam", pendulaBeams.map((beam, value) => ({ label: beam.label, value })), 0, "The beam and its two posts: oak, dark walnut, or polished brass."),
  range("light", "lamp", "lamp", 0.5, "The brightness of the one lamp over the table: how warm the pool of light is, how bright the highlights and how dark the shadows."),
  feature("manifold", "mark", "M light", false, "size", 0.5, "A lamp throws the Manifold M in gold light across the studio floor, high on the right. It glows quietly, and swells as the pendulums come back into line."),
];

export const pendulaScene: SceneDef = {
  id: "pendula",
  title: "Pendulum wave",
  blurb: "A row of pendulums drifting through waves and back into line.",
  accent: "#e8b04a",
  look: { color: "full", levels: 5 },
  params,
  groups: {
    wave: { title: "Wave", blurb: "How many pendulums, how long the pattern takes to come round, how far they swing, and whether they swing ideally or as real ones do." },
    view: { title: "View", blurb: "Where you stand, and the arcs the bobs leave." },
    metal: { title: "Metal", blurb: "What the bobs, the beam and its posts are made of." },
    light: { title: "Light", blurb: "The lamp over the table." },
    manifold: { title: "Manifold mark", blurb: "The M, in light on the floor." },
  },
  glsl: pendulaGlsl,
  passage: PENDULA_PASSAGE,
  entry: "scenePendula",
};
