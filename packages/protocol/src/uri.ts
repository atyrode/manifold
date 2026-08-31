import { z } from "zod";

/**
 * `manifold://` — the canonical SERIALIZATION of the addressing algebra the rest of the
 * protocol already speaks. Every node the workspace holds has exactly one of these, and
 * each form is bijective with a structured wire reference: a URI is what a human pastes, a
 * link carries, and a log line prints; the struct is what a door consumes. Nothing is
 * addressable here that is not addressable there.
 *
 * The seven forms:
 *   manifold://terminal/<sessionId>
 *   manifold://pad/<padId>
 *   manifold://pad/<padId>/element/<elementId>
 *   manifold://pad/<padId>/tile/<tileId>
 *   manifold://principal/<principalId>
 *   manifold://plugin/<pluginId>
 *   manifold://action/<actionName>
 *
 * An element and a tile are addressed THROUGH their container because neither has an
 * identity outside it — the same reason `TileSurface`'s note form names an element id
 * rather than a cross-document pair.
 */
export const MANIFOLD_URI_SCHEME = "manifold://";

/**
 * Every id is bounded at 128 characters — the same bounded-string discipline as
 * `PluginIdSchema.max(64)` and friends. Server-minted ids are far shorter; the bound
 * exists so a resolver or log line can never be handed an unbounded attacker-chosen blob
 * wearing an address's clothes.
 */
const RefIdSchema = z.string().min(1).max(128);

export const ManifoldRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("terminal"), sessionId: RefIdSchema }),
  z.strictObject({ kind: z.literal("pad"), padId: RefIdSchema }),
  z.strictObject({
    kind: z.literal("element"),
    padId: RefIdSchema,
    elementId: RefIdSchema,
  }),
  z.strictObject({ kind: z.literal("tile"), padId: RefIdSchema, tileId: RefIdSchema }),
  z.strictObject({ kind: z.literal("principal"), principalId: RefIdSchema }),
  z.strictObject({ kind: z.literal("plugin"), pluginId: RefIdSchema }),
  z.strictObject({ kind: z.literal("action"), actionName: RefIdSchema }),
]);
export type ManifoldRef = z.infer<typeof ManifoldRefSchema>;

/**
 * Ids are opaque strings — a pad id is generated, a plugin action name is dotted, and a
 * principal id is whatever a mint chose — so every segment is percent-encoded rather than
 * trusted: an id holding a `/` must not silently become two segments, which is exactly how
 * an address parser turns into a confused deputy.
 */
export function formatManifoldUri(ref: ManifoldRef): string {
  switch (ref.kind) {
    case "terminal":
      return `${MANIFOLD_URI_SCHEME}terminal/${encodeURIComponent(ref.sessionId)}`;
    case "pad":
      return `${MANIFOLD_URI_SCHEME}pad/${encodeURIComponent(ref.padId)}`;
    case "element":
      return `${MANIFOLD_URI_SCHEME}pad/${encodeURIComponent(ref.padId)}/element/${encodeURIComponent(ref.elementId)}`;
    case "tile":
      return `${MANIFOLD_URI_SCHEME}pad/${encodeURIComponent(ref.padId)}/tile/${encodeURIComponent(ref.tileId)}`;
    case "principal":
      return `${MANIFOLD_URI_SCHEME}principal/${encodeURIComponent(ref.principalId)}`;
    case "plugin":
      return `${MANIFOLD_URI_SCHEME}plugin/${encodeURIComponent(ref.pluginId)}`;
    case "action":
      return `${MANIFOLD_URI_SCHEME}action/${encodeURIComponent(ref.actionName)}`;
    default: {
      const exhaustive: never = ref;
      return exhaustive;
    }
  }
}

/**
 * Decodes every segment or refuses the whole URI. A malformed escape (`%zz`) is a refusal
 * rather than a literal, and an empty segment is a refusal too: `manifold://pad/` names
 * nothing, and answering "a pad with an empty id" would push the mistake downstream.
 */
function decodeSegments(path: string): string[] | null {
  const raw = path.split("/");
  const out: string[] = [];
  for (const part of raw) {
    if (part.length === 0) return null;
    try {
      const decoded = decodeURIComponent(part);
      // The RefIdSchema bound, enforced at the parse door too: an address is refused,
      // never truncated, when a segment exceeds what any real id can be.
      if (decoded.length === 0 || decoded.length > 128) return null;
      out.push(decoded);
    } catch {
      return null;
    }
  }
  return out;
}

/**
 * The inverse of {@link formatManifoldUri}: a reference, or null for anything this
 * workspace cannot address. Null covers a foreign scheme, an unknown node type, and a
 * shape that resolves to no form at all — a parser that guessed would invent addresses.
 *
 * The scheme is matched exactly (lowercase): these URIs are generated, not typed, so
 * accepting variants would buy nothing and cost one more thing to keep bijective.
 */
export function parseManifoldUri(text: string): ManifoldRef | null {
  if (!text.startsWith(MANIFOLD_URI_SCHEME)) return null;
  const segments = decodeSegments(text.slice(MANIFOLD_URI_SCHEME.length));
  if (segments === null) return null;
  const [head, first, mid, second] = segments;
  if (head === undefined || first === undefined) return null;

  if (segments.length === 2) {
    switch (head) {
      case "terminal":
        return { kind: "terminal", sessionId: first };
      case "pad":
        return { kind: "pad", padId: first };
      case "principal":
        return { kind: "principal", principalId: first };
      case "plugin":
        return { kind: "plugin", pluginId: first };
      case "action":
        return { kind: "action", actionName: first };
      default:
        return null;
    }
  }

  if (segments.length === 4 && head === "pad" && second !== undefined) {
    if (mid === "element") return { kind: "element", padId: first, elementId: second };
    if (mid === "tile") return { kind: "tile", padId: first, tileId: second };
    return null;
  }

  return null;
}
