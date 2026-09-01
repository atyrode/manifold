import { normalizeInstanceOrigin } from "@manifold/protocol";

/**
 * WHICH INSTANCE THIS LENS LOOKS AT. One answer, because every door a renderer dials — the
 * session socket, the action door, the boot reads — has to name the same server, and a second
 * derivation is a second answer to "which instance is this" (invariant 14).
 *
 * The default is the page's own origin, which is the browser baseline: a lens served by an
 * instance looks at that instance. What AXIOMS §The portable lens forbids is the ASSUMPTION —
 * "a lens that can only look at its own birthplace is not a lens" — so the origin is a
 * CHOICE the device can make, carried by `?instance=<url>` and remembered in this device's
 * memory (`REGISTRY.md` §Device-local register: `manifold:instance`). An installed app is
 * pointed at another instance by opening it with that query once; no rebuild, no second
 * client, and nothing about the app itself branches on the answer.
 *
 * The origin is resolved ONCE per page and then frozen ({@link instanceOrigin}), because half
 * a page talking to one instance while the other half talks to another is not a state any
 * reconciliation can describe. Changing the choice takes a reload, which is exactly what
 * `?instance=` does.
 *
 * NOT ADR 0014. That decision is about shares — a node on ANOTHER instance reached from this
 * one, addressed by `(origin, containerId)`. This is about which instance the lens itself is a
 * lens onto. They are neighbours, and they share the one normalizer deliberately: an origin
 * two parts of the system spell differently is an origin that never matches.
 */

/** This device's memory of the instance it was pointed at; absent means "the one that served me". */
const INSTANCE_STORAGE = "manifold:instance";

/** The one-shot carrier: `?instance=https://other.example` chooses, `?instance=` goes home. */
const INSTANCE_PARAM = "instance";

/**
 * The pure decision, so the rule is testable without a browser: given the origin that served
 * the page, what this device remembers, and what the URL asks for, name the instance and the
 * memory that should stand afterwards.
 *
 * `memory: null` means the device should remember NOTHING — which is both the ordinary case
 * and the answer for a lens explicitly pointed home, so a stale key can never outlive the
 * choice it recorded. A malformed ask falls through to the memory rather than destroying it,
 * and a malformed MEMORY is dropped: the served origin is the one fallback that always exists.
 */
export function chooseInstance(
  served: string,
  stored: string | null,
  asked: string | null,
): { readonly origin: string; readonly memory: string | null } {
  if (asked !== null) {
    if (asked === "") return { origin: served, memory: null };
    const chosen = normalizeInstanceOrigin(asked);
    if (chosen !== null) return { origin: chosen, memory: chosen === served ? null : chosen };
  }
  const remembered = stored === null ? null : normalizeInstanceOrigin(stored);
  if (remembered === null) return { origin: served, memory: null };
  return { origin: remembered, memory: remembered === served ? null : remembered };
}

/** Frozen after the first read: one page, one instance. */
let resolved: string | null = null;

function storedInstance(): string | null {
  try {
    return window.localStorage.getItem(INSTANCE_STORAGE);
  } catch {
    return null;
  }
}

function rememberInstance(memory: string | null): void {
  try {
    if (memory === null) window.localStorage.removeItem(INSTANCE_STORAGE);
    else window.localStorage.setItem(INSTANCE_STORAGE, memory);
  } catch {
    /*
      A device that refuses storage still gets the lens it asked for — the origin is already
      decided — it just cannot remember it past this page. Optional by construction, like every
      other device-local memory.
    */
  }
}

/**
 * Takes `?instance=` out of the URL the way the owner key is taken out of the fragment: the
 * carrier is one-shot, so it is consumed before React renders and the URL is left clean. A
 * query that survived would be re-applied on every deep link and would travel in any copied
 * address, which is how a device ends up pointed somewhere it was never deliberately pointed.
 */
function consumeAsked(): string | null {
  const params = new URLSearchParams(window.location.search);
  const asked = params.get(INSTANCE_PARAM);
  if (asked === null) return null;
  params.delete(INSTANCE_PARAM);
  const search = params.size === 0 ? "" : `?${params.toString()}`;
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${search}${window.location.hash}`,
  );
  return asked;
}

/**
 * The instance every door dials, as a normalized absolute origin with no trailing slash.
 * Resolved on first use and frozen for the page's life.
 */
export function instanceOrigin(): string {
  if (resolved !== null) return resolved;
  const decision = chooseInstance(window.location.origin, storedInstance(), consumeAsked());
  rememberInstance(decision.memory);
  resolved = decision.origin;
  return resolved;
}

/**
 * Whether this lens is pointed somewhere other than the instance that served it. Read by the
 * floor to SAY so — a device looking at a foreign instance is a fact a human is owed, not a
 * behavioural branch: every door works identically either way.
 */
export function isForeignInstance(): boolean {
  return instanceOrigin() !== window.location.origin;
}

/** One absolute URL for a path on the instance, e.g. `instanceUrl("/api/layout")`. */
export function instanceUrl(path: string): string {
  return `${instanceOrigin()}${path}`;
}

/** WHERE THE TERMINAL SOCKET IS — the instance's own `ws(s)` session door, one derivation. */
export function sessionUrl(): string {
  const origin = instanceOrigin();
  return `${origin.startsWith("https:") ? "wss:" : "ws:"}//${origin.slice(origin.indexOf("//") + 2)}/ws/session`;
}
