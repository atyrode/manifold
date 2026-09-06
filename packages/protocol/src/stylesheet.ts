/**
 * THE SELECTOR WALK, shared by the gate and the hub (ADR 0025 §7, #258; invariant 14).
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
 * No dependency (invariant 8): CSS has a small enough grammar for a selector list that a hand
 * walk over parentheses, brackets, quotes and comments is the whole parser.
 */

const CSS_COMMENTS = /\/\*[\s\S]*?\*\//g;
const FUNCTIONAL_PSEUDO = /:(?:is|not|where|has)\(([^()]*)\)/g;
const FIRST_CLASS = /\.(-?[_a-zA-Z][-\w]*)/;
const COMBINATORS = " \t\n>+~";
const KEYFRAMES = "@keyframes";

/** A rule's selector list and the line its block opens on, for a refusal that names a place. */
export interface CssRule {
  readonly selectors: readonly string[];
  readonly line: number;
}

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
 * Selector lists and `@keyframes` names, one level of at-rule nesting followed. A keyframes
 * name is reported as its own pseudo-selector so the animation vocabulary is owned too — a
 * plugin cannot mint `@keyframes terminal-blink` in somebody else's file, or in its own.
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
    let quote = "";
    let inComment = false;
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
        if (depth === 0) preludeEnd = i;
        depth++;
        continue;
      }
      if (ch === "}") {
        depth--;
        if (depth > 0) continue;
        const prelude = text.slice(start, preludeEnd).replace(CSS_COMMENTS, "").trim();
        const line = lineAt(preludeEnd);
        if (/^@(?:media|supports|container|layer)\b/.test(prelude)) {
          scan(preludeEnd + 1, i);
        } else if (prelude.startsWith(KEYFRAMES)) {
          rules.push({ selectors: [`.${prelude.slice(KEYFRAMES.length).trim()}`], line });
        } else if (!prelude.startsWith("@")) {
          rules.push({ selectors: splitTop(prelude, ","), line });
        }
        start = i + 1;
        continue;
      }
      if (ch === ";" && depth === 0) start = i + 1;
    }
  };
  scan(0, text.length);
  return rules;
}

/** The first rule of a plugin's sheet that reaches outside its root, and why. */
export interface UnscopedRule {
  readonly line: number;
  readonly selector: string;
  readonly reason: "classless" | "outside_root";
}

/**
 * THE RULE AT LOAD (ADR 0025 §7): every selector in a plugin's sheet is admitted only if its
 * leftmost compound anchors on the plugin's own root — `.plugin-<id>` itself, or a part of it
 * under `__` — and a rule with no class at all is refused outright, because `body` and the
 * element defaults reach every node in the document. Compounds to the RIGHT are the plugin's
 * subtree and stay its own business, exactly as S13 reads ownership in the tree: the leftmost
 * family is the one whose removal makes the rule dead, and here that is always the plugin.
 *
 * Returns the first offender with the line its block opens on, or null when the whole sheet
 * is the plugin's; a refusal that names one selector is what an author fixes.
 */
export function unscopedRule(text: string, pluginId: string): UnscopedRule | null {
  const root = pluginRootClass(pluginId);
  const part = `${root}${PLUGIN_ROOT_PART_SEAM}`;
  for (const rule of cssRules(text)) {
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
