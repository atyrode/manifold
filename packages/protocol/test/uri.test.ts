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
  { ref: { kind: "terminal", terminalId: "s1" }, uri: "manifold://terminal/s1" },
  { ref: { kind: "container", containerId: "p1" }, uri: "manifold://container/p1" },
  {
    ref: { kind: "element", containerId: "p1", elementId: "el-1" },
    uri: "manifold://container/p1/element/el-1",
  },
  {
    ref: { kind: "tile", containerId: "p1", tileId: "root" },
    uri: "manifold://container/p1/tile/root",
  },
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
      const uri = formatManifoldUri({ kind: "container", containerId: id });
      expect(uri.startsWith(`${MANIFOLD_URI_SCHEME}container/`)).toBe(true);
      // Encoded on the wire — the raw character never appears as structure.
      expect(uri.slice(`${MANIFOLD_URI_SCHEME}container/`.length)).not.toContain("/");
      expect(parseManifoldUri(uri)).toEqual({ kind: "container", containerId: id });
    }
    // The two-level forms percent-encode BOTH segments, so a nested id is just as safe.
    const nested = formatManifoldUri({ kind: "element", containerId: "a/b", elementId: "c/d" });
    expect(nested).toBe("manifold://container/a%2Fb/element/c%2Fd");
    expect(parseManifoldUri(nested)).toEqual({
      kind: "element",
      containerId: "a/b",
      elementId: "c/d",
    });
  });

  test("an id that LOOKS like an escape survives, because encoding is applied once", () => {
    /*
      The nastiest confusion this algebra can suffer: an id whose own text is `%2F`. If
      formatting emitted it raw, parsing would decode it back to `/` and silently address a
      DIFFERENT node — the one place where a bijection failure is invisible rather than an
      error. Double-encoding on the way out and single-decoding on the way in is what keeps
      the two id spaces separate.
     */
    const literal = formatManifoldUri({ kind: "container", containerId: "a%2Fb" });
    expect(literal).toBe("manifold://container/a%252Fb");
    expect(parseManifoldUri(literal)).toEqual({ kind: "container", containerId: "a%2Fb" });

    // And the two are genuinely distinguishable, which is the whole claim.
    const slash = formatManifoldUri({ kind: "container", containerId: "a/b" });
    expect(slash).not.toBe(literal);
    expect(parseManifoldUri(slash)).toEqual({ kind: "container", containerId: "a/b" });
  });

  test("anything this workspace cannot address is refused, never guessed", () => {
    const refused = [
      // Foreign schemes, including the ones a browser would happily hand over.
      "https://example.com/container/p1",
      "manifold:/container/p1",
      "manifold:container/p1",
      "MANIFOLD://container/p1",
      "container/p1",
      "",
      // Known scheme, unknown node type.
      "manifold://browser/https%3A%2F%2Fexample.com",
      "manifold://container",
      // The retired head is refused like any other unknown node type.
      "manifold://pad/p1",
      // Right head, wrong shape: empty, missing and surplus segments.
      "manifold://container/",
      "manifold://container//element/el-1",
      "manifold://container/p1/element",
      "manifold://container/p1/element/el-1/extra",
      "manifold://container/p1/leaf/root",
      "manifold://terminal/s1/element/el-1",
      // A malformed escape is a refusal rather than a literal.
      "manifold://container/%zz",
    ];
    for (const text of refused) expect(parseManifoldUri(text)).toBeNull();
  });

  test("a segment longer than an id can be is refused, never truncated", () => {
    const limit = 128;
    const ok = "p".repeat(limit);
    const over = "p".repeat(limit + 1);

    expect(parseManifoldUri(`${MANIFOLD_URI_SCHEME}container/${ok}`)).toEqual({
      kind: "container",
      containerId: ok,
    });
    /*
      One character further is not "a long container id", it is a DIFFERENT address. A parser
      that truncated to fit would hand back `manifold://container/<first 128>` — an id that
      may well exist and belong to somebody else — so the bound is a refusal at the parse
      door, the same answer `RefIdSchema` gives at the schema door.
     */
    expect(parseManifoldUri(`${MANIFOLD_URI_SCHEME}container/${over}`)).toBeNull();
    // The bound is on the DECODED segment, so escapes buy no extra room: 129 encoded slashes
    // are 387 characters on the wire and one over the limit as an id.
    expect(
      parseManifoldUri(`${MANIFOLD_URI_SCHEME}container/${"%2F".repeat(limit + 1)}`),
    ).toBeNull();
    // Both segments of a two-level form are bounded, not just the head.
    expect(parseManifoldUri(`${MANIFOLD_URI_SCHEME}container/${ok}/element/${over}`)).toBeNull();

    // And the same limit holds on the struct side, or the bijection breaks in one direction:
    // a ref that validates but formats into text the parser refuses is a node the workspace
    // can write down and never read back.
    expect(ManifoldRefSchema.safeParse({ kind: "container", containerId: ok }).success).toBe(true);
    expect(ManifoldRefSchema.safeParse({ kind: "container", containerId: over }).success).toBe(
      false,
    );
    expect(
      ManifoldRefSchema.safeParse({ kind: "element", containerId: ok, elementId: over }).success,
    ).toBe(false);
  });

  test("a heavily-escaped id well inside the bound is ACCEPTED, wire length notwithstanding", () => {
    // The complement of the case above, and the reason it matters: bounding the raw TEXT
    // instead of the decoded id would also refuse this address, which is legal in the struct
    // form — a workspace that can hold a node it cannot write down. 100 slashes are 300
    // characters of wire text and a 100-character id.
    const escapeHeavy = "/".repeat(100);
    const uri = formatManifoldUri({ kind: "container", containerId: escapeHeavy });

    expect(uri.length).toBeGreaterThan(300);
    expect(parseManifoldUri(uri)).toEqual({ kind: "container", containerId: escapeHeavy });
    expect(
      ManifoldRefSchema.safeParse({ kind: "container", containerId: escapeHeavy }).success,
    ).toBe(true);
  });
});
