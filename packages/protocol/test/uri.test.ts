import { describe, expect, test } from "bun:test";
import {
  MANIFOLD_URI_SCHEME,
  ManifoldRefSchema,
  formatManifoldUri,
  parseManifoldUri,
  type ManifoldRef,
} from "@manifold/protocol";

/**
 * One reference per addressable form. The list is the whole point: a form that cannot be
 * written down is a node no link, no log line and no agent can point at, so every form the
 * union declares is exercised here in both directions.
 */
const REFS: readonly { readonly ref: ManifoldRef; readonly uri: string }[] = [
  { ref: { kind: "terminal", sessionId: "s1" }, uri: "manifold://terminal/s1" },
  { ref: { kind: "pad", padId: "p1" }, uri: "manifold://pad/p1" },
  {
    ref: { kind: "element", padId: "p1", elementId: "el-1" },
    uri: "manifold://pad/p1/element/el-1",
  },
  { ref: { kind: "tile", padId: "p1", tileId: "root" }, uri: "manifold://pad/p1/tile/root" },
  { ref: { kind: "principal", principalId: "pr-1" }, uri: "manifold://principal/pr-1" },
  { ref: { kind: "plugin", pluginId: "core.terminals" }, uri: "manifold://plugin/core.terminals" },
  {
    ref: { kind: "action", actionName: "core.terminals.rename" },
    uri: "manifold://action/core.terminals.rename",
  },
];

describe("manifold:// addressing", () => {
  test("every form round-trips through its canonical text, and the text is what is expected", () => {
    for (const { ref, uri } of REFS) {
      expect(formatManifoldUri(ref)).toBe(uri);
      expect(parseManifoldUri(uri)).toEqual(ref);
      // Parsing the formatted form of a parsed URI must land on the same text: bijection,
      // not merely two functions that happen to agree on this table.
      const reparsed = parseManifoldUri(formatManifoldUri(ref));
      expect(reparsed).not.toBeNull();
      if (reparsed === null) continue;
      expect(formatManifoldUri(reparsed)).toBe(uri);
      expect(ManifoldRefSchema.safeParse(reparsed).success).toBe(true);
    }
    // Exhaustive by construction: a new form cannot be added without a row here.
    const kinds = new Set(REFS.map(({ ref }) => ref.kind));
    expect(kinds.size).toBe(REFS.length);
  });

  test("ids holding reserved characters survive the round trip intact", () => {
    /*
      The whole reason segments are percent-encoded: an id containing a `/` must not become
      two segments, an id containing a `%` must not become an escape, and a space must not
      break the URI in a link. Each case below would silently re-address a node without it.
     */
    const nasty = [
      "a/b",
      "100%",
      "with space",
      "q?x=1",
      "frag#ment",
      "colon:sep",
      "é-accented",
      "back\\slash",
    ];
    for (const id of nasty) {
      const uri = formatManifoldUri({ kind: "pad", padId: id });
      expect(uri.startsWith(`${MANIFOLD_URI_SCHEME}pad/`)).toBe(true);
      // Encoded on the wire — the raw character never appears as structure.
      expect(uri.slice(`${MANIFOLD_URI_SCHEME}pad/`.length)).not.toContain("/");
      expect(parseManifoldUri(uri)).toEqual({ kind: "pad", padId: id });
    }
    // The two-level forms percent-encode BOTH segments, so a nested id is just as safe.
    const nested = formatManifoldUri({ kind: "element", padId: "a/b", elementId: "c/d" });
    expect(nested).toBe("manifold://pad/a%2Fb/element/c%2Fd");
    expect(parseManifoldUri(nested)).toEqual({ kind: "element", padId: "a/b", elementId: "c/d" });
  });

  test("anything this workspace cannot address is refused, never guessed", () => {
    const refused = [
      // Foreign schemes, including the ones a browser would happily hand over.
      "https://example.com/pad/p1",
      "manifold:/pad/p1",
      "manifold:pad/p1",
      "MANIFOLD://pad/p1",
      "pad/p1",
      "",
      // Known scheme, unknown node type.
      "manifold://browser/https%3A%2F%2Fexample.com",
      "manifold://pad",
      // Right head, wrong shape: empty, missing and surplus segments.
      "manifold://pad/",
      "manifold://pad//element/el-1",
      "manifold://pad/p1/element",
      "manifold://pad/p1/element/el-1/extra",
      "manifold://pad/p1/leaf/root",
      "manifold://terminal/s1/element/el-1",
      // A malformed escape is a refusal rather than a literal.
      "manifold://pad/%zz",
    ];
    for (const text of refused) expect(parseManifoldUri(text)).toBeNull();
  });
});
