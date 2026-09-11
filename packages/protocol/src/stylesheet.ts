/**
 * THE SELECTOR WALK, shared by the gate and the hub (ADR 0025 §7, #258; docs/CONTRACTS.md §One authoritative implementation).
 *
 * `verify:axioms` S13 reads every stylesheet in the tree against §Lexicon's `cssFamilies` and
 * refuses a family painted by anyone but its one owner. A stylesheet that is not in the tree —
 * an installed bundle's, an unpacked directory's — never meets that check, so the hub applies
 * the same rule at load with the one owner it can know: the plugin itself, under its own root
 * class. Both readers walk selectors with THIS module; the gate maps anchors to registry rows,
 * the hub compares them to the root. One parser, so what "the leftmost compound" means cannot
 * drift between the two.
 *
 * This is ink ownership, not security (`AXIOMS.md`): a mod has the full engine API and could
 * write any style it likes from code. The rule makes a second writer for a shell family
 * impossible BY CONSTRUCTION in the one artifact that is declarative — a sheet — rather than by
 * review, which is what S13 does for `core.*` in the tree.
 *
 * THE DIALECT (#410). A form this walk cannot read is REFUSED BY NAME, never skipped: a checker
 * that waves a construct through has answered "admitted" for it, and the answer it had no way
 * to compute is the one an author reads as permission. What it reads is a style rule's selector
 * list, a `@keyframes` name, and the four GROUPING at-rules — `@media`, `@supports`,
 * `@container`, `@layer` — whose preludes carry no selector and whose bodies are rule lists it
 * descends. Every other at-rule form comes back `outside_dialect` with the text as written:
 * `@scope`, whose scoping root, `to` limit and implicit `:scope` relativity all change what
 * "the leftmost compound" means, so a foreign selector inside it would otherwise be read
 * against nothing; `@import`, whose bytes this walk never saw and the hub never hashed; and
 * every global-name form — `@font-face`, `@property`, `@counter-style`, `@page`, `@charset`,
 * `@namespace`, the statement `@layer a, b;` — which mints a name with no root to hang it from.
 * A rule nested inside a rule is `nested_rule`: `&` may sit anywhere in a nested selector, so
 * `.plugin-x { .sidebar & { … } }` is exactly the `.sidebar .plugin-x` this rule refuses when
 * written flat, and a walk that judges one selector list cannot judge a relative one. Nothing
 * is lost that the dialect cannot say: a scoped or nested rule is a descendant selector from
 * the plugin's own root, which the walk does read. Widening the dialect later widens the door
 * without moving it — a form that becomes readable becomes admissible, and nothing already
 * admitted turns.
 *
 * A `@keyframes` name is owned and a `@layer` name is not, and the asymmetry is real: an
 * animation is REFERENCED by name from `animation`, so a plugin minting `terminal-blink` writes
 * the shell's vocabulary, while a layer only orders declarations that already exist — and by
 * this rule every declaration in the sheet is the plugin's own.
 *
 * No dependency (docs/CONTRACTS.md §Dependency decisions): CSS has a small enough grammar for a selector list that a hand
 * walk over parentheses, brackets, quotes and comments is the whole parser.
 */

const CSS_COMMENTS = /\/\*[\s\S]*?\*\//g;
const FUNCTIONAL_PSEUDO = /:(?:is|not|where|has)\(([^()]*)\)/g;
const FIRST_CLASS = /\.(-?[_a-zA-Z][-\w]*)/;
const COMBINATORS = " \t\n>+~";
const KEYFRAMES = "@keyframes";
/** The grouping at-rules whose body is a rule list, so the walk reads through them (§DIALECT). */
const GROUPING = /^@(?:media|supports|container|layer)\b/;
/** Whitespace and comments before a form's first real character, for the line it opens on. */
const LEADING_TRIVIA = /^(?:\s|\/\*[\s\S]*?\*\/)*/;

/** A form outside the dialect, named for what is wrong with it rather than for its syntax. */
type UnreadableForm = "outside_dialect" | "nested_rule";

/**
 * What the walk found. A `style` rule is a selector list and the line its block opens on, for a
 * refusal that names a place. An `unreadable` form is a construct outside §DIALECT, carried out
 * of the parser with the text as written: reporting it is the whole of #410, because a form
 * dropped here is a form every reader silently admits.
 */
export type CssRule =
  | { readonly kind: "style"; readonly selectors: readonly string[]; readonly line: number }
  | {
      readonly kind: "unreadable";
      readonly reason: UnreadableForm;
      readonly form: string;
      readonly line: number;
    };

/**
 * The root class a plugin's ink hangs from: `.plugin-<id with each "." as "_">` —
 * `acme.counter` → `plugin-acme_counter`. `_` because a segment may contain `-` but never `_`
 * under `PLUGIN_ID_PATTERN`, so two ids never share a root and no root is a prefix of another
 * at a `-` seam that both could claim.
 */
export function pluginRootClass(pluginId: string): string {
  return `plugin-${pluginId.replaceAll(".", "_")}`;
}

/**
 * The seam under which a plugin names the PARTS of its root — `.plugin-acme_counter__title`.
 * Two underscores never occur in any root (segments are non-empty, so separators never touch),
 * which is what makes a part unambiguous without a descendant combinator.
 */
export const PLUGIN_ROOT_PART_SEAM = "__";

/** Splits on commas / combinators that are not inside `(…)` or `[…]`. */
export function splitTop(text: string, breaks: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (depth === 0 && breaks.includes(ch)) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/** The class a compound is ABOUT, ignoring the ones that merely qualify it. */
export function anchorOf(compound: string): string | null {
  return FIRST_CLASS.exec(compound.replace(FUNCTIONAL_PSEUDO, ""))?.[1] ?? null;
}

/** Every compound a selector mentions, the arguments of functional pseudos included. */
export function everyCompound(selector: string): readonly string[] {
  const found: string[] = [];
  for (const compound of splitTop(selector, COMBINATORS)) {
    found.push(compound);
    for (;;) {
      const inner = FUNCTIONAL_PSEUDO.exec(compound);
      if (inner === null) break;
      for (const one of splitTop(inner[1] ?? "", ",")) {
        found.push(...splitTop(one, COMBINATORS));
      }
    }
  }
  return found;
}

/**
 * Selector lists, `@keyframes` names and every form outside §DIALECT, at-rule nesting followed.
 * A keyframes name is reported as its own pseudo-selector so the animation vocabulary is owned
 * too — a plugin cannot mint `@keyframes terminal-blink` in somebody else's file, or in its own.
 */
export function cssRules(text: string): readonly CssRule[] {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (index: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  const rules: CssRule[] = [];
  const scan = (from: number, to: number): void => {
    let start = from;
    let depth = 0;
    let preludeEnd = -1;
    let nested = false;
    let quote = "";
    let inComment = false;
    /**
     * A block's prelude decides what the block IS: descended, named, or refused. `end` is where
     * its body stops — the closing brace, or the region's end when the author never wrote one,
     * which is where CSS's own parser closes an open block and therefore where it still paints.
     */
    const closeBlock = (end: number): void => {
      const prelude = text.slice(start, preludeEnd).replace(CSS_COMMENTS, "").trim();
      const line = lineAt(preludeEnd);
      if (GROUPING.test(prelude)) {
        scan(preludeEnd + 1, end);
        return;
      }
      if (prelude.startsWith(KEYFRAMES)) {
        const name = prelude.slice(KEYFRAMES.length).trim();
        rules.push({ kind: "style", selectors: [`.${name}`], line });
        return;
      }
      if (prelude.startsWith("@")) {
        rules.push({ kind: "unreadable", reason: "outside_dialect", form: prelude, line });
        return;
      }
      rules.push({ kind: "style", selectors: splitTop(prelude, ","), line });
      // The prelude is still judged on its own: a nested rule ADDS a refusal, it does not
      // replace the one the outer selector list already earns.
      if (nested) rules.push({ kind: "unreadable", reason: "nested_rule", form: prelude, line });
    };
    /** An at-rule with no block ends at `;` — or, per CSS's own parser, at the end of input. */
    const closeStatement = (end: number): void => {
      const raw = text.slice(start, end);
      const form = raw.replace(CSS_COMMENTS, "").trim();
      if (!form.startsWith("@")) return;
      const line = lineAt(start + (LEADING_TRIVIA.exec(raw)?.[0].length ?? 0));
      rules.push({ kind: "unreadable", reason: "outside_dialect", form, line });
    };
    for (let i = from; i < to; i++) {
      const ch = text[i];
      if (inComment) {
        if (ch === "*" && text[i + 1] === "/") {
          inComment = false;
          i++;
        }
        continue;
      }
      if (quote !== "") {
        if (ch === "\\") i++;
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === "/" && text[i + 1] === "*") {
        inComment = true;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === "{") {
        if (depth === 0) {
          preludeEnd = i;
          nested = false;
        } else nested = true;
        depth++;
        continue;
      }
      if (ch === "}") {
        // A brace with nothing open is the parse error CSS discards; leaving depth at zero is
        // what stops the next block's prelude from being read from the wrong place.
        if (depth === 0) {
          start = i + 1;
          continue;
        }
        depth--;
        if (depth > 0) continue;
        closeBlock(i);
        start = i + 1;
        continue;
      }
      if (ch === ";" && depth === 0) {
        closeStatement(i);
        start = i + 1;
      }
    }
    if (depth > 0) closeBlock(to);
    else closeStatement(to);
  };
  scan(0, text.length);
  return rules;
}

/** The first rule of a plugin's sheet the rule below does not admit, and why. */
export interface UnscopedRule {
  readonly line: number;
  /** The offending selector — or, for a form outside §DIALECT, that form as written. */
  readonly selector: string;
  readonly reason: "classless" | "outside_root" | UnreadableForm;
}

/**
 * THE RULE AT LOAD (ADR 0025 §7): every selector in a plugin's sheet is admitted only if its
 * leftmost compound anchors on the plugin's own root — `.plugin-<id>` itself, or a part of it
 * under `__` — and a rule with no class at all is refused outright, because `body` and the
 * element defaults reach every node in the document. Compounds to the RIGHT are the plugin's
 * subtree and stay its own business, exactly as S13 reads ownership in the tree: the leftmost
 * family is the one whose removal makes the rule dead, and here that is always the plugin.
 *
 * A form outside §DIALECT is refused by ITS name (`outside_dialect`, `nested_rule`) rather than
 * measured against the root: there is no leftmost compound to read, and admitting what cannot
 * be read is how `@scope` and `@import` laundered a foreign selector before #410.
 *
 * Returns the first offender with the line its block opens on, or null when the whole sheet
 * is the plugin's; a refusal that names one selector is what an author fixes.
 */
export function unscopedRule(text: string, pluginId: string): UnscopedRule | null {
  const root = pluginRootClass(pluginId);
  const part = `${root}${PLUGIN_ROOT_PART_SEAM}`;
  for (const rule of cssRules(text)) {
    if (rule.kind === "unreadable") {
      return { line: rule.line, selector: rule.form, reason: rule.reason };
    }
    for (const selector of rule.selectors) {
      if (!everyCompound(selector).some((compound) => anchorOf(compound) !== null)) {
        return { line: rule.line, selector, reason: "classless" };
      }
      const leftmost = anchorOf(splitTop(selector, COMBINATORS)[0] ?? "");
      if (leftmost === null || (leftmost !== root && !leftmost.startsWith(part))) {
        return { line: rule.line, selector, reason: "outside_root" };
      }
    }
  }
  return null;
}
