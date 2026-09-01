import { keystrokeLabel } from "../bindings.ts";
import type { ReactElement } from "react";

/**
 * THE keycap: one keystroke, drawn as a key.
 *
 * The binding editor drew this shape and its own stylesheet said so — "this seat draws the one
 * keycap in the product" — which stopped being true the moment a second surface printed the
 * composed key table (a command list, a menu, a tooltip). The composed table is the ENGINE's
 * read (`host.assembly.bindings`), so ANY plugin may print a row, and a shape every printer
 * needs is stdlib rather than one tenant's private drawing (invariant 14).
 *
 * WHICH MARK `Mod` WEARS is decided here and asked once. The grammar is platform-free — the
 * server composes through `bindings.ts`, so `keystrokeLabel` takes the answer as an argument —
 * and the QUESTION is browser-only, which is exactly the boundary this subpath exists to hold.
 * Every caller gets one answer; nobody sniffs a user agent twice.
 */
const APPLE =
  typeof navigator !== "undefined" && /^(mac|iphone|ipad|ipod)/i.test(navigator.platform);

/**
 * A keystroke as THIS keyboard reads it — the platform-bound half of `keystrokeLabel`, for the
 * callers that need the words without the box (a sentence, a title attribute, a `<small>`
 * naming the key a row was rebound away from).
 */
export function keyCapLabel(stroke: string): string {
  return keystrokeLabel(stroke, APPLE);
}

export interface KeyCapProps {
  /** A keystroke in the registry's grammar (`F8`, `Mod+k`) — a `ComposedBinding.key`. */
  readonly stroke: string;
  /** Marks a stroke this principal rebound, so the cap can say so without a second element. */
  readonly overridden?: boolean;
}

export function KeyCap({ stroke, overridden = false }: KeyCapProps): ReactElement {
  return (
    <kbd className="keycap" data-keycap-overridden={overridden}>
      {keyCapLabel(stroke)}
    </kbd>
  );
}
