// The program shaker. A scene's fragment program is assembled whole: the common preamble, every
// shared library and the scene's GLSL (shaders/index.ts `assembleFragment`). Most of that text is
// shut out by the scene's feature defines or never called from `main`. `shakeGlsl` hands the driver
// only what the program can reach, as the driver would see it after its own preprocessing, so the
// program draws the same, with fewer functions to parse and compile:
//
// 1. Comments go; every newline stays, so a line of the result is the line of the source it came
//    from, and a compile error's line number (renderer annotate) points at the same code in both.
// 2. The conditionals are resolved with the program's own defines, as the driver's preprocessor
//    resolves them: what they shut out goes, and so do the `#if` lines.
// 3. The program is cut into top-level items: functions and their prototypes, structs, constants,
//    globals, uniforms, `#define`s. An item is kept if `main` reaches it by name: through a call, a
//    type, a constructor, a constant's or a global's initialiser or a macro's body. Every item of a
//    reached name is kept: all the overloads of a function and its prototype, all the definitions
//    of a macro. A name that something merely mentions (a local of the same name, a struct member
//    declared with it) keeps it too: the shaker keeps too much, never too little. The kept items
//    stay in source order.
//
// Precision statements, `#version`, `#extension` and `#pragma` always stay. Uniforms nothing reads go
// as well: such a uniform is inactive in the program either way, so its location is null either way.

/** A program the shaker cannot read: an unbalanced conditional, an `#if` it cannot evaluate. */
export class GlslShakeError extends Error {}

/** A top-level piece of the program: a declaration or definition, or a preprocessor directive. */
interface Unit {
  /** Names it declares or defines. */
  readonly names: readonly string[];
  /** Names it mentions: identifiers, except those after a `.` (members, swizzles, methods). */
  readonly refs: Iterable<string>;
}

/** A declaration or definition: its text is `code.slice(start, end)`. */
interface Item extends Unit {
  readonly start: number;
  readonly end: number;
}

/** A directive the shaker keeps on its own line: a `#define` or `#undef`, or one always kept. */
interface Directive extends Unit {
  readonly line: number;
  readonly text: string;
}

/** A macro: its body and whether it takes arguments. */
interface Macro {
  readonly body: string;
  readonly functionLike: boolean;
}

/** The names a macro body mentions: identifiers, except members and swizzles and within numbers. */
const MENTION = /(?<![.\w])[A-Za-z_]\w*/g;

/** Comments removed, each newline kept: a block comment within a line becomes one space. */
function stripComments(source: string): string {
  return source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (comment) => {
    if (comment.startsWith("//")) return "";
    const lineBreaks = comment.replace(/[^\n]/g, "");
    return lineBreaks === "" ? " " : lineBreaks;
  });
}

/** `text` reduced to its newlines. */
function newlines(text: string): string {
  let count = 0;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) count++;
  return "\n".repeat(count);
}

/** A token of a `#if` expression: a number, an identifier or an operator (or a parenthesis). */
const EXPRESSION_TOKEN = /\s*(?:(\d\w*)|([A-Za-z_]\w*)|(&&|\|\||<<|>>|[<>=!]=|[-+*/%<>&^|!~()]))/y;

/**
 * The binary operators of a `#if` expression: each one's precedence (higher binds tighter) and
 * value, on C's integers (a comparison or a logical operator gives 0 or 1).
 */
const BINARY: Readonly<Record<string, readonly [number, (a: number, b: number) => number]>> = {
  "||": [1, (a, b) => Number(a !== 0 || b !== 0)],
  "&&": [2, (a, b) => Number(a !== 0 && b !== 0)],
  "|": [3, (a, b) => a | b],
  "^": [4, (a, b) => a ^ b],
  "&": [5, (a, b) => a & b],
  "==": [6, (a, b) => Number(a === b)],
  "!=": [6, (a, b) => Number(a !== b)],
  "<": [7, (a, b) => Number(a < b)],
  ">": [7, (a, b) => Number(a > b)],
  "<=": [7, (a, b) => Number(a <= b)],
  ">=": [7, (a, b) => Number(a >= b)],
  "<<": [8, (a, b) => a << b],
  ">>": [8, (a, b) => a >> b],
  "+": [9, (a, b) => a + b],
  "-": [9, (a, b) => a - b],
  "*": [10, (a, b) => a * b],
  "/": [10, (a, b) => Math.trunc(a / b)],
  "%": [10, (a, b) => a % b],
};

/** An integer literal of a `#if` expression (decimal, octal or hex, maybe unsigned). */
function integer(text: string, line: number): number {
  const digits = text.replace(/[uU]$/, "");
  const value = /^0[xX][0-9a-fA-F]+$/.test(digits)
    ? Number.parseInt(digits.slice(2), 16)
    : /^0[0-7]*$/.test(digits)
      ? Number.parseInt(digits, 8)
      : /^[1-9]\d*$/.test(digits)
        ? Number.parseInt(digits, 10)
        : Number.NaN;
  if (Number.isNaN(value))
    throw new GlslShakeError(`line ${line + 1}: '${text}' is not an integer in #if`);
  return value;
}

/**
 * The tokens of a `#if` expression: `defined` resolved and the macros expanded (recursively, a
 * macro not within its own expansion), so that only integers and operators are left. GLSL ES
 * leaves an identifier that is not a macro an error, and so does this.
 */
function expressionTokens(
  text: string,
  macros: ReadonlyMap<string, Macro>,
  line: number,
  expanding: ReadonlySet<string> = new Set(),
): string[] {
  const raw: string[] = [];
  for (let at = 0; text.slice(at).trim() !== ""; at = EXPRESSION_TOKEN.lastIndex) {
    EXPRESSION_TOKEN.lastIndex = at;
    const m = EXPRESSION_TOKEN.exec(text);
    if (m === null)
      throw new GlslShakeError(`line ${line + 1}: cannot read #if expression '${text.trim()}'`);
    raw.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i] ?? "";
    if (token === "defined") {
      const paren = raw[i + 1] === "(";
      const name = raw[paren ? i + 2 : i + 1];
      if (name === undefined || !/^[A-Za-z_]\w*$/.test(name) || (paren && raw[i + 3] !== ")"))
        throw new GlslShakeError(`line ${line + 1}: malformed defined in #if`);
      out.push(macros.has(name) ? "1" : "0");
      i += paren ? 3 : 1;
    } else if (/^[A-Za-z_]/.test(token)) {
      const macro = macros.get(token);
      if (macro === undefined || expanding.has(token))
        throw new GlslShakeError(`line ${line + 1}: '${token}' is not a macro, in #if`);
      if (macro.functionLike)
        throw new GlslShakeError(
          `line ${line + 1}: function-like macro '${token}' in #if is not supported`,
        );
      out.push(...expressionTokens(macro.body, macros, line, new Set([...expanding, token])));
    } else {
      out.push(token);
    }
  }
  return out;
}

/** The value of a `#if` / `#elif` expression: C's integer arithmetic, as GLSL ES has it. */
function evaluate(text: string, macros: ReadonlyMap<string, Macro>, line: number): boolean {
  const tokens = expressionTokens(text, macros, line);
  let at = 0;
  const fail = (): never => {
    throw new GlslShakeError(`line ${line + 1}: cannot evaluate #if '${text.trim()}'`);
  };
  const unary = (): number => {
    const token = tokens[at++];
    if (token === undefined) return fail();
    if (token === "(") {
      const value = binary(1);
      if (tokens[at++] !== ")") fail();
      return value;
    }
    if (token === "+") return unary();
    if (token === "-") return -unary();
    if (token === "~") return ~unary();
    if (token === "!") return unary() === 0 ? 1 : 0;
    if (/^\d/.test(token)) return integer(token, line);
    return fail();
  };
  const binary = (min: number): number => {
    let left = unary();
    for (;;) {
      const op = tokens[at];
      const operator = op === undefined ? undefined : BINARY[op];
      if (operator === undefined || operator[0] < min) return left;
      at++;
      const right = binary(operator[0] + 1);
      if ((op === "/" || op === "%") && right === 0)
        throw new GlslShakeError(`line ${line + 1}: division by zero in #if`);
      left = operator[1](left, right);
    }
  };
  const value = binary(1);
  if (at !== tokens.length) fail();
  return value !== 0;
}

/**
 * The program with its conditionals resolved: `code` holds each line, blank where a conditional
 * shuts it out or a directive stood; `directives` the `#define`s and `#undef`s in force and the
 * directives always kept, each on its line.
 */
function preprocess(text: string): { code: string; directives: Directive[] } {
  const lines = text.split("\n");
  const code: string[] = [];
  const directives: Directive[] = [];
  const macros = new Map<string, Macro>();
  const open: { outer: boolean; taken: boolean; sawElse: boolean; line: number }[] = [];
  let active = true;
  lines.forEach((source, line) => {
    const m = /^\s*#\s*(\w*)(.*)$/.exec(source);
    if (m === null) {
      code.push(active ? source : "");
      return;
    }
    code.push("");
    const word = m[1] ?? "";
    const rest = m[2] ?? "";
    const top = open.at(-1);
    switch (word) {
      case "if":
      case "ifdef":
      case "ifndef": {
        const name = rest.trim();
        const on =
          active &&
          (word === "if" ? evaluate(rest, macros, line) : macros.has(name) === (word === "ifdef"));
        open.push({ outer: active, taken: on, sawElse: false, line });
        active = on;
        return;
      }
      case "elif":
      case "else": {
        if (top === undefined || top.sawElse)
          throw new GlslShakeError(`line ${line + 1}: #${word} without its #if`);
        const on = top.outer && !top.taken && (word === "else" || evaluate(rest, macros, line));
        top.taken ||= on;
        top.sawElse = word === "else";
        active = on;
        return;
      }
      case "endif":
        if (top === undefined) throw new GlslShakeError(`line ${line + 1}: #endif without its #if`);
        open.pop();
        active = top.outer;
        return;
    }
    if (!active || word === "") return;
    const text = source.trimEnd();
    if (word === "define") {
      const define = /^\s+([A-Za-z_]\w*)(\([^)]*\))?(.*)$/.exec(rest);
      if (define === null) throw new GlslShakeError(`line ${line + 1}: malformed #define`);
      const name = define[1] ?? "";
      const body = (define[3] ?? "").trim();
      // A pasted name (a ## b) is mentioned by no token: the shaker could not see it is used.
      if (body.includes("##"))
        throw new GlslShakeError(`line ${line + 1}: token pasting (##) is not supported`);
      macros.set(name, { body, functionLike: define[2] !== undefined });
      directives.push({ line, text, names: [name], refs: body.match(MENTION) ?? [] });
    } else if (word === "undef") {
      const name = rest.trim();
      macros.delete(name);
      directives.push({ line, text, names: [name], refs: [] });
    } else {
      // #version, #extension, #pragma, #line, #error: kept as they are.
      directives.push({ line, text, names: [], refs: [] });
    }
  });
  const unclosed = open.at(-1);
  if (unclosed !== undefined)
    throw new GlslShakeError(`line ${unclosed.line + 1}: #if without its #endif`);
  return { code: code.join("\n"), directives };
}

/** Whether a character code may continue an identifier: a letter, a digit or `_`. */
function identifierPart(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95;
}

/**
 * The tokens of `code` that the shaker reads, with where each starts and ends: identifiers, the
 * punctuation `{ } ( ) [ ] ; , .` and `=` (an assignment's or initialiser's, not part of an
 * operator). Numbers, with their points, exponents and suffixes, and other operators are passed
 * over, so a number's point is never taken for a member's.
 */
function tokenize(code: string): { tokens: string[]; starts: number[]; ends: number[] } {
  const tokens: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const n = code.length;
  for (let i = 0; i < n;) {
    const c = code.charCodeAt(i);
    if (c <= 32) {
      i++;
      continue;
    }
    const digit = c >= 48 && c <= 57;
    if (!digit && identifierPart(c)) {
      let j = i + 1;
      while (j < n && identifierPart(code.charCodeAt(j))) j++;
      tokens.push(code.slice(i, j));
      starts.push(i);
      ends.push(j);
      i = j;
    } else if (
      digit ||
      (c === 46 && code.charCodeAt(i + 1) >= 48 && code.charCodeAt(i + 1) <= 57)
    ) {
      // A number: hex digits and a suffix; or digits, a point, an exponent (with its sign), a suffix.
      const hex = c === 48 && (code.charCodeAt(i + 1) | 32) === 120;
      let j = i + (hex ? 2 : 1);
      for (; j < n; j++) {
        const d = code.charCodeAt(j);
        const signed = (d === 43 || d === 45) && !hex && (code.charCodeAt(j - 1) | 32) === 101;
        if (!identifierPart(d) && !(d === 46 && !hex) && !signed) break;
      }
      i = j;
    } else {
      const char = code.charAt(i);
      if ("{}()[];,.".includes(char)) {
        tokens.push(char);
        starts.push(i);
        ends.push(i + 1);
      } else if (char === "=") {
        // `==` is skipped whole; `+=`, `<=`, `!=` and the like by the character before.
        if (code.charAt(i + 1) === "=") i++;
        else if (i === 0 || !"<>!=+-*/%&|^".includes(code.charAt(i - 1))) {
          tokens.push(char);
          starts.push(i);
          ends.push(i + 1);
        }
      }
      i++;
    }
  }
  return { tokens, starts, ends };
}

/** The name a declarator declares: its last identifier outside brackets ahead of any `=`. */
function declared(tokens: readonly string[]): string | undefined {
  let depth = 0;
  let name: string | undefined;
  for (const token of tokens) {
    if (token === "(" || token === "[") depth++;
    else if (token === ")" || token === "]") depth--;
    else if (depth === 0 && token === "=") break;
    else if (depth === 0 && /^[A-Za-z_]/.test(token)) name = token;
  }
  return name;
}

/** The names a declaration declares: one per declarator, the declarators split at top-level commas. */
function declarators(tokens: readonly string[]): string[] {
  const names: string[] = [];
  let depth = 0;
  let from = 0;
  tokens.forEach((token, i) => {
    if (token === "(" || token === "[") depth++;
    else if (token === ")" || token === "]") depth--;
    else if (depth === 0 && token === ",") {
      const name = declared(tokens.slice(from, i));
      if (name !== undefined) names.push(name);
      from = i + 1;
    }
  });
  const name = declared(tokens.slice(from));
  if (name !== undefined) names.push(name);
  return names;
}

/**
 * The names a top-level item declares, from its tokens (without the closing `;`): a function's or
 * prototype's name, a struct's name and its declarators, an interface block's instance (or its
 * members, without one), or a declaration's declarators.
 */
function declaredNames(tokens: readonly string[]): string[] {
  if (tokens[0] === "precision") return [];
  // A function: an identifier, not `layout`, then `(`, with no `=` or `{` ahead of it (outside the
  // brackets of an array return type).
  let brackets = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "[") brackets++;
    else if (token === "]") brackets--;
    else if (brackets > 0) continue;
    else if (token === "=" || token === "{") break;
    else if (token === "(") {
      const name = tokens[i - 1];
      if (name !== undefined && name !== "layout" && /^[A-Za-z_]/.test(name)) return [name];
      break;
    }
  }
  const open = tokens.indexOf("{");
  if (open < 0) return declarators(tokens);
  const close = tokens.lastIndexOf("}");
  const after = declarators(tokens.slice(close + 1));
  const struct = tokens.indexOf("struct");
  if (struct >= 0 && struct < open) {
    const name = tokens[struct + 1];
    return name !== undefined && name !== "{" ? [name, ...after] : after;
  }
  if (after.length > 0) return after;
  // An interface block without an instance name: its members are global names.
  const members: string[] = [];
  let from = open + 1;
  for (let i = from; i < close; i++)
    if (tokens[i] === ";") {
      members.push(...declarators(tokens.slice(from, i)));
      from = i + 1;
    }
  return members;
}

/** The program's top-level items, in order, from its preprocessed code. */
function items(code: string): Item[] {
  const out: Item[] = [];
  const { tokens, starts, ends } = tokenize(code);
  let from = 0;
  let depth = 0;
  let paren = 0;
  let body = false;
  const end = (last: number): void => {
    const own = tokens.slice(from, last + 1);
    const refs = new Set<string>();
    own.forEach((token, i) => {
      if (identifierPart(token.charCodeAt(0)) && own[i - 1] !== ".") refs.add(token);
    });
    const head = own.at(-1) === ";" ? own.slice(0, -1) : own;
    out.push({
      start: starts[from] ?? 0,
      end: ends[last] ?? 0,
      names: declaredNames(head),
      refs,
    });
    from = last + 1;
  };
  tokens.forEach((token, i) => {
    if (token === "(" || token === "[") paren++;
    else if (token === ")" || token === "]") paren--;
    else if (token === "{") {
      if (depth === 0) body = tokens[i - 1] === ")";
      depth++;
    } else if (token === "}") {
      depth--;
      if (depth < 0) {
        const line = newlines(code.slice(0, starts[i] ?? 0)).length + 1;
        throw new GlslShakeError(`line ${line}: unbalanced '}'`);
      }
      if (depth === 0 && body) end(i);
    } else if (token === ";" && depth === 0 && paren === 0) end(i);
  });
  if (from < tokens.length) {
    const line = newlines(code.slice(0, starts[from] ?? 0)).length + 1;
    throw new GlslShakeError(`line ${line}: unterminated declaration`);
  }
  return out;
}

/**
 * `source` with only what `roots` (default: `main`) reach, comments stripped and conditionals
 * resolved, line for line: line n of the result is code from line n of `source` or blank. Throws
 * GlslShakeError for a program it cannot read, or one that defines none of `roots`.
 */
export function shakeGlsl(source: string, roots: readonly string[] = ["main"]): string {
  const { code, directives } = preprocess(stripComments(source));
  const parts = items(code);
  const units: Unit[] = [...parts, ...directives];
  const byName = new Map<string, Unit[]>();
  for (const unit of units)
    for (const name of unit.names) {
      const named = byName.get(name);
      if (named === undefined) byName.set(name, [unit]);
      else named.push(unit);
    }
  const queue: Unit[] = roots.flatMap((root) => byName.get(root) ?? []);
  if (queue.length === 0)
    throw new GlslShakeError(`the program defines none of ${roots.join(", ")}`);
  // Always kept: what declares no name (precision statements) and directives other than #define
  // and #undef.
  for (const unit of units) if (unit.names.length === 0) queue.push(unit);
  const kept = new Set<Unit>();
  for (let unit = queue.pop(); unit !== undefined; unit = queue.pop()) {
    if (kept.has(unit)) continue;
    kept.add(unit);
    for (const ref of unit.refs)
      for (const named of byName.get(ref) ?? []) if (!kept.has(named)) queue.push(named);
  }
  let text = "";
  let at = 0;
  for (const item of parts) {
    text += newlines(code.slice(at, item.start));
    const own = code.slice(item.start, item.end);
    text += kept.has(item) ? own : newlines(own);
    at = item.end;
  }
  text += newlines(code.slice(at));
  const lines = text.split("\n");
  for (const directive of directives)
    if (kept.has(directive)) lines[directive.line] = directive.text;
  return lines.map((line) => line.trimEnd()).join("\n");
}
