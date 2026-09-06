import { keystrokeLabel } from "./bindings.ts";

/**
 * WHICH MARK `Mod` WEARS is decided here and asked once. The grammar is platform-free — the
 * server composes through `bindings.ts`, so `keystrokeLabel` takes the answer as an argument —
 * and the QUESTION is browser-only, which is exactly the boundary `@manifold/plugin/hooks`
 * exists to hold. Every caller gets one answer; nobody sniffs a user agent twice. The box the
 * words sit in is the design system's (`KeyCap`, `@manifold/ui`), which takes the label and
 * knows nothing about key tables.
 */
const APPLE =
  typeof navigator !== "undefined" && /^(mac|iphone|ipad|ipod)/i.test(navigator.platform);

/**
 * A keystroke as THIS keyboard reads it — the platform-bound half of `keystrokeLabel`, for a
 * `<KeyCap label={…}>` and for the callers that need the words without the box (a sentence, a
 * title attribute, a `<small>` naming the key a row was rebound away from).
 */
export function keyCapLabel(stroke: string): string {
  return keystrokeLabel(stroke, APPLE);
}
