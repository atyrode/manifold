// The overhead's variants (ADR 0062 "Baselines and variants", D14): every scene seen from above over
// the overhead baseline (overhead.ts), each in its folder with code of its own, keyed by scene id,
// the baseline's own scene (`patch`) first. None is promoted (D15: promotion is the interior's).
import { deltaVariant } from "../scenes/delta/index.ts";
import { patchVariant } from "../scenes/patch/index.ts";
import { pondVariant } from "../scenes/pond/index.ts";
import { rippleVariant } from "../scenes/ripple/index.ts";
import { sandtableVariant } from "../scenes/sandtable/index.ts";
import { tidepoolVariant } from "../scenes/tidepool/index.ts";
import type { OverheadVariant } from "./types.ts";

/** The scenes seen from above stored as variants, by scene id: the baseline's own scene (`patch`) first. */
export const overheadVariants = {
  patch: patchVariant,
  pond: pondVariant,
  ripple: rippleVariant,
  tidepool: tidepoolVariant,
  sandtable: sandtableVariant,
  delta: deltaVariant,
} as const satisfies Readonly<Record<string, OverheadVariant>>;
