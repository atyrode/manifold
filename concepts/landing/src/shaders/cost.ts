// What a fragment program costs to compile, estimated without a driver: GLSL ES has no real calls,
// so every compiler inlines the whole call tree under `main`, and a program costs about what that
// tree comes to. The estimate runs the preprocessor over the program (glslActive, whole), then counts
// each function's tokens and adds, at every call site, its callee's own inlined count: a function
// called from three places counts three times, a loop's body once. Overloads count as their largest.
//
// It ranks the scenes' programs as `spirv-opt` times their compile (Spearman 0.987 over 49 default
// programs, the branch audit's G3b-4; raw source length gives 0.885), but it is no timing: loops
// unrolled by the compiler weigh more than their tokens. Good for a budget (shaders/cost.test.ts),
// not for fine ranking.

import { glslActive } from "./glsl.ts";

/** A function as written: its name, its own tokens, and the name before every `(` in its body. */
interface Definition {
  readonly tokens: number;
  readonly calls: readonly string[];
}

/** One function's share of the inlined program. */
export interface InlinedShare {
  readonly name: string;
  /** How many times inlining `main` copies its body. */
  readonly copies: number;
  /** Those copies' own tokens, not counting what they call. */
  readonly tokens: number;
}

export interface InlinedCost {
  /** Tokens `main` comes to with every call inlined. */
  readonly tokens: number;
  /** Every function `main` reaches, the largest share first: where a budget's tokens go. */
  readonly blame: readonly InlinedShare[];
}

const HEADER =
  /(^|[;}\n])\s*(?:highp\s+|mediump\s+|lowp\s+)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(([^()]*)\)\s*\{/g;
const KEYWORDS = new Set(["if", "for", "while", "switch", "return", "else"]);

/** Every function definition of preprocessed, comment-free GLSL, by name (overloads together). */
function definitions(code: string): Map<string, Definition[]> {
  const found = new Map<string, Definition[]>();
  HEADER.lastIndex = 0;
  for (let match = HEADER.exec(code); match; match = HEADER.exec(code)) {
    const [, , type = "", name = ""] = match;
    let depth = 1;
    let at = HEADER.lastIndex;
    for (; at < code.length && depth > 0; at++) {
      if (code[at] === "{") depth++;
      else if (code[at] === "}") depth--;
    }
    const body = code.slice(HEADER.lastIndex, at - 1);
    HEADER.lastIndex = at;
    if (KEYWORDS.has(type)) continue;
    const definition = {
      tokens: (body.match(/[A-Za-z_]\w*|\d+\.?\d*|[^\s\w]/g) ?? []).length,
      calls: [...body.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map((call) => call[1] ?? ""),
    };
    found.set(name, [...(found.get(name) ?? []), definition]);
  }
  return found;
}

/** The inlined size of a whole fragment program (as fragmentSourceFor gives it) under `main`. */
export function inlinedCost(program: string): InlinedCost {
  const code = glslActive(program, {}, true)
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n");
  const defined = definitions(code);
  // Each name's largest overload, and what it comes to inlined (GLSL forbids recursion; a cycle
  // counts nothing past its first turn).
  const largest = new Map<string, { definition: Definition; inlined: number }>();
  const open = new Set<string>();
  const inlined = (name: string): number => {
    const known = largest.get(name);
    if (known !== undefined) return known.inlined;
    const overloads = defined.get(name);
    if (overloads === undefined || open.has(name)) return 0;
    open.add(name);
    let best: { definition: Definition; inlined: number } | undefined;
    for (const definition of overloads) {
      const size = definition.calls.reduce((sum, call) => sum + inlined(call), definition.tokens);
      if (best === undefined || size > best.inlined) best = { definition, inlined: size };
    }
    open.delete(name);
    if (best !== undefined) largest.set(name, best);
    return best?.inlined ?? 0;
  };
  const tokens = inlined("main");
  // Copies of each body: main's one, passed down the call tree in an order where every caller comes
  // before its callees (the reverse of the order the sizes finished in).
  const order = [...largest.keys()].reverse();
  const copies = new Map<string, number>([["main", 1]]);
  for (const name of order) {
    const times = copies.get(name) ?? 0;
    for (const call of largest.get(name)?.definition.calls ?? []) {
      if (largest.has(call)) copies.set(call, (copies.get(call) ?? 0) + times);
    }
  }
  const blame = order
    .map((name) => {
      const times = copies.get(name) ?? 0;
      return { name, copies: times, tokens: times * (largest.get(name)?.definition.tokens ?? 0) };
    })
    .filter((share) => share.copies > 0)
    .sort((a, b) => b.tokens - a.tokens);
  return { tokens, blame };
}
