// The promoted variants' code, loaded the first time one is needed (SceneDef.code): each assembled
// from the code of every layer its rig offers (composer/code.ts), as a room in its folder is.
import { composedCode } from "../../composer/code.ts";
import { INTERIOR_CODE } from "../../composer/interior-code.ts";
import type { SceneCode } from "../types.ts";
import { promotedComposed } from "./scenes.ts";

/** Promoted variant `id`'s code. */
export function promotedCode(id: string): SceneCode {
  const composed = promotedComposed[id];
  if (composed === undefined) throw new Error(`no promoted variant ${id}`);
  return composedCode(composed, INTERIOR_CODE);
}
