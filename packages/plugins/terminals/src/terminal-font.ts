/** Plugin-owned, self-hosted font; the face is declared in styles.css. */
export const TERMINAL_FONT_FAMILY = '"Manifold Terminal Mono"';
export const TERMINAL_FONT_SIZE = 13;

export type TerminalFontState =
  | { readonly status: "loading" }
  | { readonly status: "ready" }
  | { readonly status: "failed"; readonly error: Error };

let state: TerminalFontState = { status: "loading" };
let attempt = 0;
const listeners = new Set<() => void>();

export function getTerminalFontState(): TerminalFontState {
  return state;
}

export function subscribeTerminalFont(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(next: TerminalFontState): void {
  state = next;
  for (const listener of listeners) listener();
}

function isTerminalFamily(family: string): boolean {
  return (
    family.replace(/^(['"])(.*)\1$/, "$2").toLowerCase() ===
    TERMINAL_FONT_FAMILY.slice(1, -1).toLowerCase()
  );
}

/** CSS-connected errored faces cannot be reloaded without recreating their rule. */
function resetFailedFaces(): void {
  const failed = new Set<FontFace>();
  document.fonts.forEach((face) => {
    if (isTerminalFamily(face.family) && face.status === "error") failed.add(face);
  });
  if (failed.size === 0) return;

  const resetRules = (parent: CSSStyleSheet | CSSGroupingRule): void => {
    let rules: CSSRuleList;
    try {
      rules = parent.cssRules;
    } catch (error) {
      // Foreign sheets may be unreadable; do not suppress mutation or other CSSOM failures.
      if (error instanceof DOMException && error.name === "SecurityError") return;
      throw error;
    }
    for (let index = 0; index < rules.length && failed.size > 0; index++) {
      const rule = rules[index];
      if (rule instanceof CSSFontFaceRule) {
        const style = rule.style;
        if (!isTerminalFamily(style.getPropertyValue("font-family"))) continue;
        for (const face of failed) {
          if (
            face.style !== (style.getPropertyValue("font-style") || "normal") ||
            face.weight !== (style.getPropertyValue("font-weight") || "normal") ||
            face.stretch !== (style.getPropertyValue("font-stretch") || "normal") ||
            face.unicodeRange.replace(/\s/g, "").toLowerCase() !==
              (style.getPropertyValue("unicode-range") || "U+0-10FFFF")
                .replace(/\s/g, "")
                .toLowerCase()
          ) {
            continue;
          }
          // Keep the original source, descriptors, cascade position and stylesheet base URL.
          const cssText = rule.cssText;
          parent.deleteRule(index);
          parent.insertRule(cssText, index);
          failed.delete(face);
          break;
        }
      } else if (rule instanceof CSSImportRule && rule.styleSheet) {
        resetRules(rule.styleSheet);
      } else if (rule instanceof CSSGroupingRule) {
        resetRules(rule);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    if (failed.size === 0) break;
    resetRules(sheet);
  }
  if (failed.size > 0) {
    throw new Error("Could not reset the bundled terminal font's stylesheet rule.");
  }
}

function startAttempt(retry: boolean): void {
  const current = ++attempt;
  if (state.status !== "loading") publish({ status: "loading" });

  const finish = (next: TerminalFontState): void => {
    // A timed-out native load can settle after another attempt has started.
    if (current !== attempt || state.status !== "loading") return;
    window.clearTimeout(timeout);
    publish(next);
  };
  const timeout = window.setTimeout(() => {
    finish({
      status: "failed",
      error: new Error("Terminal font did not load within 15 seconds. Retry to try again."),
    });
  }, 15_000);

  try {
    // Leave a still-loading face alone: another fonts.load joins its native request.
    if (retry) resetFailedFaces();
    void document.fonts
      .load(
        `${TERMINAL_FONT_SIZE}px ${TERMINAL_FONT_FAMILY}`,
        "M\ue0b0\uf120\uf013\uf417\uea60\u{f0004}",
      )
      .then(
        (faces) => {
          if (faces.length === 0 || faces.some((face) => face.status !== "loaded")) {
            finish({
              status: "failed",
              error: new Error("Bundled terminal font is unavailable. Retry to try again."),
            });
            return;
          }
          finish({ status: "ready" });
        },
        (cause: unknown) => {
          finish({
            status: "failed",
            error: new Error("Could not load the bundled terminal font. Retry to try again.", {
              cause,
            }),
          });
        },
      );
  } catch (cause) {
    finish({
      status: "failed",
      error:
        cause instanceof Error
          ? cause
          : new Error("Could not load the bundled terminal font.", { cause }),
    });
  }
}

/** Start once on demand; warm mounts synchronously retain the shared ready or failed state. */
export function loadTerminalFont(): void {
  if (attempt === 0) startAttempt(false);
}

/** Only an explicit retry leaves failed state; concurrent callers join the same attempt. */
export function retryTerminalFont(): void {
  if (state.status === "failed") startAttempt(true);
}
