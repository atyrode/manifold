// GLSL helpers: TS → GLSL literal emitters, the `glsl` template tag every GLSL source is written
// with, and the shared modules programs are assembled from.
//
//   glslFloat(x)                       a float literal that reads back as x: the shortest decimal that
//                                      round-trips, ".0" added to whole numbers, exponent form where
//                                      JS uses it (5e-7, 1e+21). Never cut to a fixed number of places
//                                      (`toFixed(4)` turns anything below 5e-5 into 0.0).
//   glslVec3("#rrggbb")                a CSS hex colour as a vec3 of display-sRGB channels 0..1 (the
//                                      pipeline works in display sRGB, as the canvas does)
//   glslVec3([r, g, b])                three numbers as a vec3 of glslFloat literals
//   glslPick(knob, cases, fallback?)   a choice knob's table: `if (K_<knob> < i.5) return <case i>;`
//                                      per case, then `return <fallback>;` when given
//
// Usage (a palette knob whose choices are 0, 1, 2, ...):
//   const inks = palettes.map((palette) => glslVec3(palette.ink));
//   export const sceneGlsl = glsl`
//   const float SCENE_EDGE = ${glslFloat(SCENE_EDGE)};
//   vec3 sceneInk() {
//   ${glslPick("palette", inks, "vec3(0.0)")}
//   }
//   `;
//
// The tag: write every GLSL template literal as glsl`...`. It gives the GLSL without its comments
// and indentation (compactGlsl), line breaks kept, so the comments document the source and cost the
// page nothing: the site build (scripts/glsl-plugin.ts) strips them from the bundle ahead of time.
//
// Modules: a shared library is a GlslModule (glslModule below): its GLSL, the names it defines at its
// top level (`provides`, read from the GLSL itself) and the modules it calls into (`requires`, each
// always or only under a compile-time feature). A program holds exactly the modules its scene's GLSL
// names, with what they require, each once, ahead of the code that calls them (shaders/lib/index.ts
// `modulesFor`): a scene never pastes a library's GLSL into its own.

/** A number or colour with no GLSL literal (non-finite, out of float range, not "#rrggbb"). */
export class GlslError extends Error {}

/** Largest finite float32: beyond it a highp float overflows. */
const FLOAT_MAX = 3.4028234663852886e38;
/** Smallest normal float32: below it a GPU may flush the constant to 0. */
const FLOAT_MIN = 1.1754943508222875e-38;

/** A GLSL float literal that reads back as `x` (see the header). Throws GlslError for 0 < |x| < 2^-126, |x| > float max, NaN. */
export function glslFloat(x: number): string {
  const size = Math.abs(x);
  if (!(size <= FLOAT_MAX) || (size > 0 && size < FLOAT_MIN))
    throw new GlslError(`glslFloat: ${x} has no exact highp float literal`);
  if (Object.is(x, -0)) return "-0.0";
  const text = String(x);
  return /[.e]/.test(text) ? text : `${text}.0`;
}

/**
 * A vec3 literal. A "#rrggbb" colour writes each 8-bit channel c as (c / 255).toFixed(4): four places
 * keep all 256 levels apart (round(v * 255) gives c back) and match the literals scenes already emit.
 * A tuple writes each number with glslFloat.
 */
export function glslVec3(colour: string | readonly [number, number, number]): string {
  if (typeof colour !== "string")
    return `vec3(${glslFloat(colour[0])}, ${glslFloat(colour[1])}, ${glslFloat(colour[2])})`;
  if (!/^#[0-9a-f]{6}$/i.test(colour))
    throw new GlslError(`glslVec3: '${colour}' is not a #rrggbb colour`);
  const value = Number.parseInt(colour.slice(1), 16);
  const channel = (c: number): string => (c / 255).toFixed(4);
  return `vec3(${channel((value >> 16) & 255)}, ${channel((value >> 8) & 255)}, ${channel(value & 255)})`;
}

/**
 * The body of a function returning a choice knob's entry: `  if (K_<knob> < i.5) return <cases[i]>;`
 * per case, one per line, then `  return <fallback>;` when given. Case i stands for the choice value
 * i, so the knob's values must run 0, 1, 2, ... in the order of `cases`.
 */
export function glslPick(knob: string, cases: readonly string[], fallback?: string): string {
  const lines = cases.map((value, i) => `  if (K_${knob} < ${i}.5) return ${value};`);
  if (fallback !== undefined) lines.push(`  return ${fallback};`);
  return lines.join("\n");
}

/**
 * `text` without its comments, each line without its indentation and trailing blanks, its line breaks
 * kept (a comment's own too): a compile error's line number still finds its line. A block comment
 * within a line leaves a space, so the tokens either side stay apart. Idempotent.
 */
export function compactGlsl(text: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const slash = text.indexOf("/", at);
    if (slash < 0) {
      out += text.slice(at);
      break;
    }
    const next = text[slash + 1];
    if (next === "/") {
      out += text.slice(at, slash);
      const end = text.indexOf("\n", slash);
      at = end < 0 ? text.length : end;
    } else if (next === "*") {
      out += text.slice(at, slash);
      const end = text.indexOf("*/", slash + 2);
      if (end < 0) throw new GlslError(`unterminated block comment: ${text.slice(slash, slash + 60)}`);
      const breaks = text.slice(slash, end).split("\n").length - 1;
      out += breaks > 0 ? "\n".repeat(breaks) : " ";
      at = end + 2;
    } else {
      out += text.slice(at, slash + 1);
      at = slash + 1;
    }
  }
  return out
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
}

/**
 * The template tag of every GLSL source: the template as written, interpolations in place, through
 * compactGlsl. It is the authority on what a program holds; the site build applies it to the
 * template's own text ahead of time (scripts/glsl-plugin.ts), which leaves that unchanged.
 */
export function glsl(strings: TemplateStringsArray, ...values: readonly (string | number)[]): string {
  let text = strings[0] ?? "";
  values.forEach((value, index) => {
    text += String(value) + (strings[index + 1] ?? "");
  });
  return compactGlsl(text);
}

/** A number, an identifier (with the `.` before it when it names a member or a swizzle) or a mark. */
const TOKEN = /[0-9][\w.]*|(\.\s*)?([A-Za-z_]\w*)|\S/g;

/**
 * The identifiers `source` names outside its comments, in code and in preprocessor lines alike, not
 * counting members and swizzles (`.x`, `sky.sun`): every name it may need a definition of.
 */
export function glslIdentifiers(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of compactGlsl(source).matchAll(TOKEN)) {
    if (match[1] === undefined && match[2] !== undefined) names.add(match[2]);
  }
  return names;
}

/** A preprocessor value: a number, or undefined where it depends on what this text cannot see. */
type Known = number | undefined;

/** What the text so far has defined: a macro's body, or null for a function-like macro. */
interface Scope {
  readonly features: GlslFeatures;
  readonly macros: Map<string, string | null>;
  /** Macros defined or undefined under a conditional this text could not decide: unknown. */
  readonly doubtful: Set<string>;
  /** The text is the whole program: a name it has not defined is undefined, not unknown. */
  readonly whole: boolean;
}

const CONDITION_TOKEN =
  /\s*(0x[0-9a-fA-F]+|\d+|[A-Za-z_]\w*|&&|\|\||<<|>>|<=|>=|==|!=|[-+*/%<>&^|!~()])/y;

/** The binary operators of a `#if` condition, loosest first. */
const LEVELS: readonly (readonly string[])[] = [
  ["||"],
  ["&&"],
  ["|"],
  ["^"],
  ["&"],
  ["==", "!="],
  ["<", ">", "<=", ">="],
  ["<<", ">>"],
  ["+", "-"],
  ["*", "/", "%"],
];

/** `a op b` for a binary operator; `&&` and `||` decide where one side alone settles them. */
function apply(op: string, a: Known, b: Known): Known {
  if (op === "&&") {
    if (a === 0 || b === 0) return 0;
    return a === undefined || b === undefined ? undefined : 1;
  }
  if (op === "||") {
    if ((a !== undefined && a !== 0) || (b !== undefined && b !== 0)) return 1;
    return a === undefined || b === undefined ? undefined : 0;
  }
  if (a === undefined || b === undefined) return undefined;
  switch (op) {
    case "|":
      return a | b;
    case "^":
      return a ^ b;
    case "&":
      return a & b;
    case "==":
      return Number(a === b);
    case "!=":
      return Number(a !== b);
    case "<":
      return Number(a < b);
    case ">":
      return Number(a > b);
    case "<=":
      return Number(a <= b);
    case ">=":
      return Number(a >= b);
    case "<<":
      return a << b;
    case ">>":
      return a >> b;
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return b === 0 ? undefined : Math.trunc(a / b);
    default:
      return b === 0 ? undefined : a % b;
  }
}

/** Whether `name` is defined at this point: 1, 0, or undefined when another part may define it. */
function definedIn(scope: Scope, name: string): Known {
  if (scope.doubtful.has(name)) return undefined;
  if (scope.features[name] !== undefined || scope.macros.has(name)) return 1;
  return scope.whole ? 0 : undefined;
}

/**
 * The value of a `#if` condition: features and the macros defined so far are known (a macro's body
 * evaluated in turn). In part of a program any other name is unknown, as is `defined` of it (another
 * part may define it), and the unknown spreads except where `&&` or `||` settles it regardless.
 */
function condition(text: string, scope: Scope, depth = 0): Known {
  const tokens: string[] = [];
  let end = 0;
  CONDITION_TOKEN.lastIndex = 0;
  for (let match = CONDITION_TOKEN.exec(text); match; match = CONDITION_TOKEN.exec(text)) {
    tokens.push(match[1] ?? "");
    end = CONDITION_TOKEN.lastIndex;
  }
  if (depth > 16 || text.slice(end).trim() !== "") return undefined;
  let at = 0;
  const unary = (): Known => {
    const token = tokens[at++];
    if (token === undefined) return undefined;
    if (token === "(") {
      const inner = binary(0);
      if (tokens[at] === ")") at++;
      return inner;
    }
    if (token === "defined") {
      const parens = tokens[at] === "(";
      if (parens) at++;
      const macro = tokens[at++] ?? "";
      if (parens && tokens[at] === ")") at++;
      return definedIn(scope, macro);
    }
    if (token === "!" || token === "-" || token === "+" || token === "~") {
      const value = unary();
      if (value === undefined) return undefined;
      if (token === "!") return Number(value === 0);
      return token === "-" ? -value : token === "~" ? ~value : value;
    }
    if (/^(0x[0-9a-fA-F]+|\d+)$/.test(token)) return Number(token);
    const feature = scope.features[token];
    if (feature !== undefined) return feature;
    const body = scope.doubtful.has(token) ? null : scope.macros.get(token);
    if (typeof body === "string") return condition(body, scope, depth + 1);
    return scope.whole && body === undefined ? 0 : undefined;
  };
  const binary = (level: number): Known => {
    const ops = LEVELS[level];
    if (ops === undefined) return unary();
    let value = binary(level + 1);
    for (let op = tokens[at]; op !== undefined && ops.includes(op); op = tokens[at]) {
      at++;
      value = apply(op, value, binary(level + 1));
    }
    return value;
  };
  const value = binary(0);
  return at === tokens.length ? value : undefined;
}

/**
 * `source` (compacted) with the lines its preprocessor conditionals certainly leave out blanked, for
 * a program defining `features` ahead of it. Of part of a program (`whole` false: a scene's GLSL,
 * with modules ahead of it), a conditional counts as false only when the features and the macros
 * `source` itself defines before it make it so; one it cannot decide (on a macro another part
 * defines) is kept, so nothing the compiler would compile is lost. Of a whole program, every
 * conditional is decided. Directive lines in kept stretches stay; line breaks are kept.
 */
export function glslActive(source: string, features: GlslFeatures = {}, whole = false): string {
  const scope: Scope = { features, macros: new Map(), doubtful: new Set(), whole };
  // Per open conditional: whether its current branch is kept, and certainly taken; whether an earlier
  // branch certainly was, or might have been; whether the stretch around it is kept.
  const stack: { kept: boolean; sure: boolean; settled: boolean; doubt: boolean; outer: boolean }[] =
    [];
  const live = (): boolean => stack.every((level) => level.kept);
  return compactGlsl(source)
    .split("\n")
    .map((line) => {
      const directive = /^#\s*(\w+)\s*(.*)$/.exec(line);
      if (directive === null) return live() ? line : "";
      const [, word = "", rest = ""] = directive;
      const top = stack.at(-1);
      if (word === "if" || word === "ifdef" || word === "ifndef") {
        const outer = live();
        const defined = definedIn(scope, rest.trim());
        const known =
          word === "if"
            ? condition(rest, scope)
            : defined === undefined || word === "ifdef"
              ? defined
              : 1 - defined;
        const sure = known !== undefined && known !== 0;
        stack.push({ kept: known !== 0, sure, settled: sure, doubt: known === undefined, outer });
        return outer ? line : "";
      }
      if (word === "elif" && top !== undefined) {
        const known = top.settled ? 0 : condition(rest, scope);
        top.kept = known !== 0;
        top.sure = known !== undefined && known !== 0 && !top.doubt;
        top.settled ||= known !== undefined && known !== 0;
        top.doubt ||= known === undefined;
        return top.outer ? line : "";
      }
      if (word === "else" && top !== undefined) {
        top.kept = !top.settled;
        top.sure = !top.settled && !top.doubt;
        return top.outer ? line : "";
      }
      if (word === "endif") {
        stack.pop();
        return live() ? line : "";
      }
      if (!live()) return "";
      const macro = /^([A-Za-z_]\w*)(\()?\s*(.*)$/.exec(rest);
      const name = macro?.[1];
      if ((word === "define" || word === "undef") && name !== undefined) {
        if (!stack.every((level) => level.sure)) scope.doubtful.add(name);
        else {
          scope.doubtful.delete(name);
          if (word === "undef") scope.macros.delete(name);
          else scope.macros.set(name, macro?.[2] === undefined ? (macro?.[3] ?? "") : null);
        }
      }
      return line;
    })
    .join("\n");
}

const IDENTIFIER = /^[A-Za-z_]\w*$/;

/** The tokens of `statement` with a leading `layout(...)` qualifier left out. */
function withoutLayout(statement: readonly string[]): readonly string[] {
  if (statement[0] !== "layout" || statement[1] !== "(") return statement;
  let depth = 0;
  for (let at = 1; at < statement.length; at++) {
    if (statement[at] === "(") depth++;
    else if (statement[at] === ")" && --depth === 0) return statement.slice(at + 1);
  }
  return statement;
}

/** The declarators of a top-level declaration, split at its commas outside brackets and parentheses. */
function declarators(statement: readonly string[]): string[][] {
  const parts: string[][] = [[]];
  let depth = 0;
  for (const token of statement) {
    if (token === "(" || token === "[") depth++;
    else if (token === ")" || token === "]") depth--;
    if (token === "," && depth === 0) parts.push([]);
    else parts.at(-1)?.push(token);
  }
  return parts;
}

/** The names a top-level statement ending in `;` defines: its variables and constants. */
function declared(statement: readonly string[], names: Set<string>): void {
  const tokens = withoutLayout(statement);
  if (tokens.length === 0 || tokens[0] === "precision") return;
  const [first, ...rest] = declarators(tokens);
  if (first === undefined) return;
  const assign = first.indexOf("=");
  const head = assign < 0 ? first : first.slice(0, assign);
  // A prototype, `float f(float x);`, declares a function defined elsewhere.
  if (assign < 0 && head.includes("(")) return;
  const bracket = head.indexOf("[");
  const name = (bracket < 0 ? head : head.slice(0, bracket)).at(-1);
  if (name !== undefined && IDENTIFIER.test(name)) names.add(name);
  for (const part of rest) {
    if (part[0] !== undefined && IDENTIFIER.test(part[0])) names.add(part[0]);
  }
}

/**
 * The names `source` defines at its top level: functions (not their prototypes), structs, constants,
 * globals and macros, in code inside preprocessor conditionals too.
 */
export function glslDefinitions(source: string): Set<string> {
  const names = new Set<string>();
  const code = compactGlsl(source)
    .split("\n")
    .map((line) => {
      if (!line.startsWith("#")) return line;
      const macro = /^#\s*define\s+([A-Za-z_]\w*)/.exec(line)?.[1];
      if (macro !== undefined) names.add(macro);
      return "";
    })
    .join("\n");
  let depth = 0;
  let statement: string[] = [];
  let struct = false;
  for (const [token] of code.matchAll(TOKEN)) {
    const bare = token.replace(/^\.\s*/, ".");
    if (depth > 0) {
      if (bare === "{") depth++;
      else if (bare === "}") depth--;
      continue;
    }
    if (bare === "{") {
      depth = 1;
      if (statement[0] === "struct") {
        const name = statement[1];
        if (name !== undefined && IDENTIFIER.test(name)) names.add(name);
        struct = true;
        statement = [];
        continue;
      }
      const tokens = withoutLayout(statement);
      const call = tokens.indexOf("(");
      const name = call > 0 ? tokens[call - 1] : undefined;
      if (name !== undefined && IDENTIFIER.test(name)) names.add(name);
      statement = [];
      continue;
    }
    if (bare === ";") {
      // After a struct's body: the variables it declares, if any.
      if (struct) {
        for (const part of declarators(statement)) {
          if (part[0] !== undefined && IDENTIFIER.test(part[0])) names.add(part[0]);
        }
      } else declared(statement, names);
      statement = [];
      struct = false;
      continue;
    }
    statement.push(bare);
  }
  return names;
}

/** Compile-time features as `#define NAME n` gives them (SceneDef.features). */
export type GlslFeatures = Readonly<Record<string, number>>;

/** A module another one calls into: always, or only in a program whose features pass `when`. */
export interface GlslRequirement {
  readonly module: GlslModule;
  /** Present when the caller reaches the module only behind an `#if` on these features. */
  readonly when?: (features: GlslFeatures) => boolean;
}

/**
 * A requirement's `when` for gates the caller tests with `#if NAME` (or `#if A || B`): any of the
 * features set and not 0.
 */
export function whenFeature(...names: readonly string[]): (features: GlslFeatures) => boolean {
  return (features) => names.some((name) => (features[name] ?? 0) !== 0);
}

/** A shared GLSL library (see the header). */
export interface GlslModule {
  /** Its name, for messages. */
  readonly name: string;
  readonly source: string;
  /** The modules it calls into: each goes ahead of it in a program that holds it. */
  readonly requires: readonly GlslRequirement[];
  /** The names it defines at its top level (glslDefinitions), read on first use. */
  readonly provides: ReadonlySet<string>;
}

class Module implements GlslModule {
  readonly name: string;
  readonly source: string;
  readonly requires: readonly GlslRequirement[];
  #provides: ReadonlySet<string> | undefined;

  constructor(name: string, source: string, requires: readonly GlslRequirement[]) {
    this.name = name;
    this.source = source;
    this.requires = requires;
  }

  get provides(): ReadonlySet<string> {
    this.#provides ??= glslDefinitions(this.source);
    return this.#provides;
  }
}

/**
 * A shared module: `source`, which calls into `requires` (a module, always; a GlslRequirement, under
 * its features) and into the common preamble, nothing else.
 */
export function glslModule(
  name: string,
  source: string,
  requires: readonly (GlslModule | GlslRequirement)[] = [],
): GlslModule {
  return new Module(
    name,
    source,
    requires.map((need) => ("module" in need ? need : { module: need })),
  );
}
