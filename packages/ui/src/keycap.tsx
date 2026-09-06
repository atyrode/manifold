import type { ReactElement } from "react";

/**
 * THE keycap: one key, drawn as a key.
 *
 * The binding editor drew this shape and its own stylesheet said so — "this seat draws the one
 * keycap in the product" — which stopped being true the moment a second surface printed the
 * composed key table (a command list, a menu, a tooltip). The composed table is the ENGINE's
 * read (`host.assembly.bindings`), so ANY plugin may print a row, and a shape every printer
 * needs is stdlib rather than one tenant's private drawing (invariant 14).
 *
 * The WORDS on the cap are not decided here. A keystroke's grammar (`Mod+k`) and which mark
 * `Mod` wears on this keyboard are the engine's — `keyCapLabel` in `@manifold/plugin/hooks`
 * reads them once — so the design system draws a label it is handed and knows nothing about
 * key tables. That is the layer boundary: `@manifold/ui` never imports the engine.
 */
export interface KeyCapProps {
  /** The words the cap wears — `keyCapLabel(binding.key)` for a composed binding. */
  readonly label: string;
  /** Marks a stroke this principal rebound, so the cap can say so without a second element. */
  readonly overridden?: boolean;
}

export function KeyCap({ label, overridden = false }: KeyCapProps): ReactElement {
  return (
    <kbd className="keycap" data-keycap-overridden={overridden}>
      {label}
    </kbd>
  );
}
