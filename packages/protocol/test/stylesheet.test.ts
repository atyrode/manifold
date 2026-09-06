import { describe, expect, test } from "bun:test";
import { cssRules, everyCompound, pluginRootClass, unscopedRule } from "@manifold/protocol";

/**
 * S13 AT LOAD (ADR 0025 §7, #258): the one selector walk the gate and the hub share, read the
 * way the hub reads it — against a plugin's own root class. Every edge the gate's fixtures
 * handle in the tree (comments, strings, nested at-rules, keyframes, functional pseudos) is
 * pinned here so the two readers cannot drift.
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
  test("reads selector lists through comments, strings and one level of at-rule nesting", () => {
    const rules = cssRules(`
      /* a { comment } */
      ${ROOT} { content: "}"; }
      @media (max-width: 40rem) {
        ${ROOT} .a, ${ROOT} .b { color: red }
      }
      @keyframes spin { from { opacity: 0 } to { opacity: 1 } }
      @font-face { font-family: x }
    `);
    expect(rules.map((rule) => rule.selectors)).toEqual([
      [ROOT],
      [`${ROOT} .a`, `${ROOT} .b`],
      [".spin"],
    ]);
    expect(rules.map((rule) => rule.line)).toEqual([3, 5, 7]);
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
