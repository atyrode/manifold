import "./styles.css";
import type { WebBinding } from "@manifold/plugin";
import { toggleArranging } from "@manifold/plugin/ui";
import { arrangeManifest } from "./index.ts";

export { ArrangeOverlay } from "./arrange-overlay.tsx";

/**
 * `core.arrange`'s browser half: the one key the F8 editor answers to.
 *
 * The row is a DECLARATION — key, label, scope — and the handler is the vantage store's own
 * toggle, exactly as `core.shell`'s row was before this plugin took it over: the mode is
 * presence (`vantage.arranging`), so nothing here holds a second copy of "is this device
 * arranging" (invariant 14). Escape-to-exit is still deliberately NOT a row — the mode's own
 * overlay owns Escape's one-level pop while it is mounted, and a table row would claim the
 * key against every dialog too.
 */
export const ARRANGE_BINDINGS: readonly WebBinding[] = [
  {
    id: `${arrangeManifest.id}.arrange`,
    key: "F8",
    label: "Arrange mode",
    when: "always",
    run: toggleArranging,
  },
];
