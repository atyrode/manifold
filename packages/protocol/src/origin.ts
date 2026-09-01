import { z } from "zod";

/**
 * WHICH INSTANCE — the one identity vocabulary for "a manifold instance", shared by the
 * principal that belongs to one (`Principal.origin`) and by the cross-instance frames that
 * name one (`instance.ts`). It lives in its own module because both of those import it and
 * neither may import the other: a principal knows nothing about sharing, and the instance
 * channel carries principals.
 */

/**
 * How long an origin may be. Origins land in a principal on every attendance row, so the bound
 * is the same order as the other identity strings rather than a URL's theoretical maximum.
 */
export const MAX_INSTANCE_ORIGIN_LENGTH = 256;

/**
 * The one joiner for instance identity: an absolute `http(s)` URL with no credentials, no path,
 * no query and no fragment becomes its canonical origin (lowercased scheme and host, default
 * port dropped, no trailing slash). Anything else is `null` — a refusal rather than a guess,
 * because an origin two instances spell differently is an origin that never matches.
 *
 * A path-mounted deployment (`https://example.com/manifold`) is deliberately refused rather than
 * silently truncated to its origin: sharing to one would address the wrong instance, and the
 * honest fix is a reverse proxy on its own host name.
 */
export function normalizeInstanceOrigin(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  return url.origin.length <= MAX_INSTANCE_ORIGIN_LENGTH ? url.origin : null;
}

/**
 * An instance as one normalized absolute base URL — `https://manifold.example`, never a
 * hostname, an opaque id or a key. The reasoning is ADR 0014 §4: a guest has to dial a URL
 * anyway, so the URL is the identity that is already load-bearing, and an opaque id would need
 * a directory to resolve it.
 *
 * The schema accepts only the ALREADY-NORMALIZED form, which is what makes the host's
 * origin-mismatch check (close 4401) a real comparison rather than a string-equality accident
 * between `http://A:80/` and `http://a`. One normalizer, both ends.
 */
export const InstanceOriginSchema = z
  .string()
  .min(1)
  .max(MAX_INSTANCE_ORIGIN_LENGTH)
  .refine((value) => normalizeInstanceOrigin(value) === value, {
    message: "origin must be a normalized absolute http(s) base URL",
  });
export type InstanceOrigin = z.infer<typeof InstanceOriginSchema>;
