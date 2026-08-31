/**
 * WHERE THE SESSION SOCKET IS. One answer, because every renderer that joins a room dials
 * the same door and a second derivation is a second answer to "which instance is this"
 * (invariant 14).
 *
 * Derived from the page's own origin rather than configured, which is the browser baseline:
 * the lens is served by the instance it looks at. AXIOMS §Foundation law's portable-lens rule
 * makes the instance configurable eventually — when it is, this function is the ONE place
 * that changes, which is the whole reason it exists as a function rather than as a template
 * literal at four call sites.
 */
export function sessionUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws/session`;
}
