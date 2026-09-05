/** Plugin-owned, self-hosted font; the face is declared in styles.css. */
export const TERMINAL_FONT_FAMILY = '"Manifold Terminal Mono"';
export const TERMINAL_FONT_SIZE = 13;

let readiness: Promise<void> | undefined;

/** Share one load across terminal copies; never measure or attach using a fallback face. */
export function loadTerminalFont(): Promise<void> {
  readiness ??= new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error("Terminal font did not load within 15 seconds. Reload to try again."));
    }, 15_000);
    void document.fonts
      .load(
        `${TERMINAL_FONT_SIZE}px ${TERMINAL_FONT_FAMILY}`,
        "M\ue0b0\uf120\uf013\uf417\uea60\u{f0004}",
      )
      .then(
        (faces) => {
          window.clearTimeout(timeout);
          if (faces.length === 0 || faces.some((face) => face.status !== "loaded")) {
            reject(new Error("Bundled terminal font is unavailable. Reload to try again."));
            return;
          }
          resolve();
        },
        () => {
          window.clearTimeout(timeout);
          reject(new Error("Could not load the bundled terminal font. Reload to try again."));
        },
      );
  });
  return readiness;
}
