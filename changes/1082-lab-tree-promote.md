---
section: Added
issue: 1082
---

The landing lab's Presets view is a tree by composer (ADR 0062 D9 as amended): the interior's baseline room, then each of its variants with its committed presets and the ones saved in this browser under it; the outdoor and overhead scenes stand at the top until their baselines land, and the standalone scenes on a shelf of their own. Committed presets are tagged "committed" instead of "baseline" (D16). A variant's "Compare with baseline" opens the A/B slots with the baseline room as A. A room's saved or committed preset that loads as itself can be promoted to a curated variant of its own (D15): the lab shows and copies the variant's entry for `src/composer/interior-variants.ts`, checked to draw as the preset does, and `bun concepts/landing/scripts/promote.ts <query>` writes it, gives it a compile budget, removes the committed preset and regenerates the scene docs. A promoted variant is a scene like any other, without a folder; `ab.ts` takes a `<head>~<base>` pair to check it draws as its query did.
