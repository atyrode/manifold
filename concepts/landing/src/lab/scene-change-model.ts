// How the lab changes scene (lab.ts #setScene), apart from the setup it builds: a scene picked by
// hand (the Scenes view, `[` `]`, "Next scene") opens under the world of the one left while "keep
// the world" is on, and always where both are the same baseline's (ADR 0062, Amendments, "D9,
// again": the baseline and its variants, tree-model.ts `shareBaseline`), whose pictures then blend
// in a plain crossfade instead of playing their exit and entrance (DitherRenderer.update). A tour,
// or its own advance, brings its own world and plays the passage.
import type { SceneId } from "../scenes/index.ts";
import { shareBaseline } from "./tree-model.ts";

/** Who changed the scene: the operator, a tour stepped by hand, or a playing tour's own advance. */
export type SceneChangeBy = "hand" | "tour" | "advance";

/**
 * What a change of scene does with the world: `keepWorld` opens the next scene under the world of
 * the one left (its World knobs, planets and clocks); `crossfade` blends the two pictures.
 */
export interface SceneChange {
  keepWorld: boolean;
  crossfade: boolean;
}

/** The change from `from` to `to` made `by` someone, "keep the world" being `keepWorld`. */
export function sceneChange(
  from: SceneId,
  to: SceneId,
  by: SceneChangeBy,
  keepWorld: boolean,
): SceneChange {
  const crossfade = by === "hand" && from !== to && shareBaseline(from, to);
  return { keepWorld: crossfade || (by === "hand" && keepWorld), crossfade };
}
