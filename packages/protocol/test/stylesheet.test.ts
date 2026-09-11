import { describe, expect, test } from "bun:test";
import { cssRules, everyCompound, pluginRootClass, unscopedRule } from "@manifold/protocol";

/**
 * S13 AT LOAD (ADR 0025 §7, #258): the one selector walk the gate and the hub share, read the
 * way the hub reads it — against a plugin's own root class. Every edge the gate's fixtures
 * handle in the tree (comments, strings, nested at-rules, keyframes, functional pseudos) is
 * pinned here so the two readers cannot drift — and so is the DIALECT (#410): a form the walk
 * cannot ownership-check is refused by name, because the verdict it could not compute is the
 * one an author would have read as permission.
 */

const ID = "acme.counter";
const ROOT = ".plugin-acme_counter";

describe("pluginRootClass", () => {
  test("every id has one root and no two ids share it", () => {
    expect(pluginRootClass(ID)).toBe("plugin-acme_counter");
    expect(pluginRootClass("acme.counter.parts")).toBe("plugin-acme_counter_parts");
    // A segment may carry `-` but never `_`, so `acme.counter-x` and `acme.counter` cannot meet.
    expect(pluginRootClass("acme.counter-x")).toBe("plugin-acme_counter-x");
  });
});

describe("cssRules", () => {
  test("reads selector lists through comments, strings and at-rule nesting, and reports what it cannot read", () => {
    const rules = cssRules(`
      /* a { comment } */
      ${ROOT} { content: "}"; }
      @media (max-width: 40rem) {
        ${ROOT} .a, ${ROOT} .b { color: red }
      }
      @keyframes spin { from { opacity: 0 } to { opacity: 1 } }
      @font-face { font-family: x }
    `);
    expect(rules).toEqual([
      { kind: "style", selectors: [ROOT], line: 3 },
      { kind: "style", selectors: [`${ROOT} .a`, `${ROOT} .b`], line: 5 },
      { kind: "style", selectors: [".spin"], line: 7 },
      // Before #410 this at-rule left the parser as NOTHING, and nothing is what every reader
      // downstream could only read as "admitted".
      { kind: "unreadable", reason: "outside_dialect", form: "@font-face", line: 8 },
    ]);
  });

  test("everyCompound reaches into functional pseudos", () => {
    expect(everyCompound(`${ROOT} > .a:is(.b .c, .d):not(.e)`)).toEqual([
      ROOT,
      ".a:is(.b .c, .d):not(.e)",
      ".b",
      ".c",
      ".d",
      ".e",
    ]);
  });
});

describe("unscopedRule", () => {
  test("a sheet rooted at the plugin's class, its parts included, passes", () => {
    expect(
      unscopedRule(
        `
          ${ROOT} { color: red }
          ${ROOT}__title, ${ROOT}.is-open > .sidebar-row { font-weight: 600 }
          ${ROOT} :is(.sidebar-section-title, .terminal-frame) { color: inherit }
          @media (prefers-color-scheme: dark) { ${ROOT} .terminal { color: white } }
          @keyframes plugin-acme_counter__pulse { from { opacity: 0 } to { opacity: 1 } }
        `,
        ID,
      ),
    ).toBeNull();
  });

  test("a shell family as the leftmost compound is refused, naming the selector and line", () => {
    expect(
      unscopedRule(`${ROOT} { color: red }\n.sidebar-section-title { color: red }`, ID),
    ).toEqual({ line: 2, selector: ".sidebar-section-title", reason: "outside_root" });
    // The root written to the RIGHT does not make the rule the plugin's: the shell's subtree
    // is what the selector reaches into.
    expect(unscopedRule(`.sidebar ${ROOT} { color: red }`, ID)?.reason).toBe("outside_root");
  });

  test("a classless rule is refused outright", () => {
    expect(unscopedRule(`body { margin: 0 }`, ID)).toEqual({
      line: 1,
      selector: "body",
      reason: "classless",
    });
    expect(unscopedRule(`:root { --x: 1 }`, ID)?.reason).toBe("classless");
    expect(unscopedRule(`[data-drop-denial] { outline: 0 }`, ID)?.reason).toBe("classless");
  });

  test("a shell family wrapped in :is() or :where() is still the shell's", () => {
    expect(unscopedRule(`:is(.sidebar-section-title) { color: red }`, ID)?.reason).toBe(
      "outside_root",
    );
    expect(unscopedRule(`:where(.terminal-frame) ${ROOT} { color: red }`, ID)?.reason).toBe(
      "outside_root",
    );
  });

  test("another plugin's root, a keyframes name and a cousin id are not this plugin's", () => {
    expect(unscopedRule(`.plugin-acme_counter_parts { color: red }`, ID)?.reason).toBe(
      "outside_root",
    );
    expect(unscopedRule(`.plugin-acme_counter-x { color: red }`, ID)?.reason).toBe("outside_root");
    expect(unscopedRule(`@keyframes spin { from { opacity: 0 } }`, ID)).toEqual({
      line: 1,
      selector: ".spin",
      reason: "outside_root",
    });
  });
});

/**
 * THE DIALECT (#410). Every case here returned NULL before the walk reported the forms it
 * cannot read — "admitted", for a construct nothing had checked. The grouping four are the
 * other half of the same claim: they must keep DESCENDING, or refusing the unreadable would
 * have bought correctness by refusing the whole vocabulary.
 */
describe("unscopedRule: the declarative dialect", () => {
  test("@scope cannot launder a foreign selector, in its prelude or in its body", () => {
    expect(unscopedRule(`@scope (${ROOT}) { .sidebar-row { color: red } }`, ID)).toEqual({
      line: 1,
      selector: `@scope (${ROOT})`,
      reason: "outside_dialect",
    });
    expect(unscopedRule(`@scope (.sidebar) { ${ROOT} { color: red } }`, ID)?.reason).toBe(
      "outside_dialect",
    );
    // Rootless `@scope` scopes to the document, which is every node there is.
    expect(unscopedRule(`@scope { .sidebar-row { color: red } }`, ID)?.reason).toBe(
      "outside_dialect",
    );
    expect(unscopedRule(`@scope (${ROOT}) to (.x) { ${ROOT}__t { color: red } }`, ID)?.reason).toBe(
      "outside_dialect",
    );
  });

  test("@import is refused by name, with its semicolon or at end of input", () => {
    expect(unscopedRule(`@import url("https://example.test/x.css");`, ID)).toEqual({
      line: 1,
      selector: `@import url("https://example.test/x.css")`,
      reason: "outside_dialect",
    });
    // CSS ends a blockless at-rule at end of input too, so a missing `;` still imports.
    expect(unscopedRule(`${ROOT} { color: red }\n@import "x.css"`, ID)).toEqual({
      line: 2,
      selector: `@import "x.css"`,
      reason: "outside_dialect",
    });
  });

  test("a global-name form, and an at-rule nobody has heard of, refuse rather than skip", () => {
    for (const form of [
      "@font-face { font-family: x }",
      `@property --x { syntax: "*"; inherits: false }`,
      "@counter-style thumbs { system: cyclic }",
      `@charset "utf-8";`,
      "@namespace svg url(http://www.w3.org/2000/svg);",
      "@layer a, b;",
      "@page { margin: 0 }",
      "@frobnicate { .sidebar-row { color: red } }",
    ]) {
      expect(unscopedRule(`${ROOT} { color: red }\n${form}`, ID)).toEqual({
        line: 2,
        selector: form.replace(/\s*[;{].*$/s, ""),
        reason: "outside_dialect",
      });
    }
  });

  test("the grouping four still descend: foreign inside refuses, the plugin's own passes", () => {
    for (const grouping of [
      "@media print",
      "@supports (display: grid)",
      "@container (min-width: 1px)",
      "@layer base",
    ]) {
      expect(unscopedRule(`${grouping} { .sidebar-row { color: red } }`, ID)).toEqual({
        line: 1,
        selector: ".sidebar-row",
        reason: "outside_root",
      });
      expect(unscopedRule(`${grouping} { ${ROOT}__title { color: red } }`, ID)).toBeNull();
    }
    // Nesting them stays one walk, and the innermost selector is still the one judged.
    expect(unscopedRule(`@layer base { @media print { ${ROOT} { color: red } } }`, ID)).toBeNull();
    expect(
      unscopedRule(`@layer base { @media print { .sidebar-row { color: red } } }`, ID)?.reason,
    ).toBe("outside_root");
  });

  test("a rule nested inside a rule is refused: `&` is how a flat refusal gets laundered", () => {
    // `.sidebar ${ROOT}` is refused written flat, so nesting may not be a second way to say it.
    expect(unscopedRule(`${ROOT} { .sidebar & { color: red } }`, ID)).toEqual({
      line: 1,
      selector: ROOT,
      reason: "nested_rule",
    });
    expect(unscopedRule(`${ROOT} { @media print { color: red } }`, ID)?.reason).toBe("nested_rule");
    // The outer selector list is judged FIRST, so a foreign parent is still named as one.
    expect(unscopedRule(`.sidebar { ${ROOT} { color: red } }`, ID)?.reason).toBe("outside_root");
    // A `@keyframes` step block is not a nested rule: it is the form's own body.
    expect(unscopedRule(`@keyframes ${ROOT.slice(1)}__p { from { opacity: 0 } }`, ID)).toBeNull();
  });

  test("a block the author never closed still paints, so it is still read", () => {
    expect(unscopedRule(`${ROOT} { color: red }\n.sidebar-row { color: red`, ID)).toEqual({
      line: 2,
      selector: ".sidebar-row",
      reason: "outside_root",
    });
  });
});
