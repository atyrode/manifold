import { appendFileSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";

export const MANDATORY_CHECKS = ["build", "types", "style", "smoke", "targeted"] as const;
export const EXTRA_CHECKS = [
  "trace",
  "unit",
  "e2e-rest",
  "e2e-preview-recovery",
  "convergence",
  "terminal-selection",
  "terminal-mirror",
  "tile-drop",
  "budgets",
  "pwa",
  "axioms",
  "runtime-jobs",
  "runtime-browser",
  "preview-environment",
  "nix",
] as const;
export const ALL_CHECKS = [...MANDATORY_CHECKS, ...EXTRA_CHECKS] as const;

export type CheckId = (typeof ALL_CHECKS)[number];
export interface CiPlan {
  readonly version: 1;
  readonly base: string;
  readonly head: string;
  readonly risk: "standard" | "high" | "unknown";
  readonly changedFiles: readonly string[];
  readonly reasons: readonly string[];
  readonly checks: readonly CheckId[];
  readonly unitPaths: readonly string[];
}

export interface Change {
  readonly status: string;
  readonly path: string;
  readonly oldPath?: string;
}
export interface DependencyGraph {
  readonly importers: ReadonlyMap<string, ReadonlySet<string>>;
  readonly holes: readonly string[];
  readonly directImporters?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly provenanceImporters?: ReadonlyMap<string, ReadonlySet<string>>;
}
interface PlannerOptions {
  readonly base?: string;
  readonly head?: string;
  readonly full: boolean;
  readonly includeWorkingTree: boolean;
}

const repoRoot = resolve(import.meta.dir, "..");
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const FULL_PATH =
  /^(?:\.github\/|scripts\/|patches\/)|(?:^|\/)(?:package\.json|bun\.lockb?|tsconfig(?:\.[^/]*)?\.json|[^/]+\.config\.[cm]?[jt]s)$/;
const NORMATIVE = /^(?:AGENTS\.md|AXIOMS\.md|REGISTRY\.md|docs\/CONTRACTS\.md)$/;
const DOC_STYLE = /\.(?:md|txt|png|jpe?g|svg|ico)$/i;
const CSS = /\.(?:css|scss)$/i;
const KNOWN_SOURCE_ROOT =
  /^packages\/(?:(?:protocol|ui|plugin|plugin-kit|scene|sdk|server|agent|testkit|web)\/|plugins\/(?:shell|plugin-manager|terminals|presence|machines|index|notes|uri|access|events|debug|brand|keys|canvas|compositions|arrange|commands)\/)/;
const DEPLOYMENT_ROOT =
  /^scripts\/(?:ci-|gate|release|promote|install-runtime-ci|verify-runtime|verify-preview-environment)/;

const BOUNDARIES: readonly {
  readonly name: string;
  readonly pattern: RegExp;
  readonly checks: readonly CheckId[];
}[] = [
  {
    name: "authorization boundary",
    pattern:
      /^packages\/server\/src\/(?:auth|http|session-ws|machine-ws|service-doors|machine-doors|migrate-grants)\.ts$|^packages\/plugins\/access\/src\/server\.ts$|^packages\/web\/src\/(?:api|http)\.ts$|^packages\/web\/src\/identity\.tsx$|^packages\/sdk\/src\/(?:action-http|action-runner|action-runner-main)\.ts$|^packages\/server\/test\/(?:auth|grant-parity|identity-posture|access-door|machine-grants)\.test\.ts$/i,
    checks: ["trace", "unit", "e2e-rest", "axioms"],
  },
  {
    name: "persistence boundary",
    pattern:
      /^packages\/server\/src\/(?:db|stores|room|plugin-database|job-store|instance-service-store|migrate-[^/]+)\.ts$|^packages\/server\/(?:src|test)\/(?:db|stores|room|plugin-database|job-store|instance-service-store)[^/]*\.test\.ts$/i,
    checks: ["unit", "e2e-rest", "e2e-preview-recovery", "convergence", "axioms"],
  },
  {
    name: "execution boundary",
    pattern:
      /^packages\/(?:agent|server)\/src\/(?:.*(?:job|terminal|isolate|spawn|plugin-host|runtime).*)$|^packages\/sdk\/src\/(?:action-runner|action-runner-main)\.ts$|^packages\/plugins\/(?:terminals|shell|plugin-manager)\/src\/server\.ts$|^packages\/(?:agent|server)\/(?:src|test)\/[^/]*(?:job|terminal|isolate|spawn|runtime)[^/]*\.test\.ts$/i,
    checks: [
      "trace",
      "unit",
      "e2e-rest",
      "terminal-selection",
      "terminal-mirror",
      "tile-drop",
      "runtime-jobs",
      "runtime-browser",
      "preview-environment",
    ],
  },
];

function fail(message: string): never {
  throw new Error(`ci-plan: ${message}`);
}

async function git(args: readonly string[], cwd = repoRoot): Promise<Uint8Array> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    fail(`git ${args[0] ?? "command"} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  return stdout;
}

async function textGit(args: readonly string[], cwd = repoRoot): Promise<string> {
  return new TextDecoder().decode(await git(args, cwd)).trim();
}

async function revision(value: string): Promise<string> {
  if (value.length === 0 || value.startsWith("-"))
    fail(`invalid git revision ${JSON.stringify(value)}`);
  return await textGit(["rev-parse", "--verify", `${value}^{commit}`]);
}

async function requireAnalyzedCheckout(base: string, head: string): Promise<void> {
  const checkout = await revision("HEAD");
  if (checkout === head) return;
  const secondParent = Bun.spawn(["git", "rev-parse", "--verify", "HEAD^2"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "ignore",
  });
  const [second, secondExit] = await Promise.all([
    new Response(secondParent.stdout).text(),
    secondParent.exited,
  ]);
  if (secondExit !== 0 || second.trim() !== head) {
    fail(
      `--head ${head} is not the analyzed checkout; check out that revision or its GitHub PR merge commit`,
    );
  }
  const first = await revision("HEAD^1");
  const ancestry = Bun.spawn(["git", "merge-base", "--is-ancestor", base, first], {
    cwd: repoRoot,
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await ancestry.exited) !== 0) {
    fail(`--base ${base} is not an ancestor of the checked-out PR merge base ${first}`);
  }
}

function parseNameStatus(bytes: Uint8Array): Change[] {
  const fields = new TextDecoder().decode(bytes).split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes: Change[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const first = fields[index++];
    if (status === undefined || first === undefined || !/^[ACDMRTUXB][0-9]*$/.test(status)) {
      fail("git diff returned malformed name-status evidence");
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      const second = fields[index++];
      if (second === undefined) fail("git diff returned an incomplete rename/copy record");
      changes.push({ status, oldPath: first, path: second });
    } else {
      changes.push({ status, path: first });
    }
  }
  return changes;
}

function mergeChanges(changes: readonly Change[]): Change[] {
  const byPath = new Map<string, Change>();
  for (const change of changes) byPath.set(change.path, change);
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function changed(options: PlannerOptions, base: string, head: string): Promise<Change[]> {
  const committed = parseNameStatus(
    await git(["diff", "--name-status", "-z", "--find-renames", base, head, "--"]),
  );
  if (!options.includeWorkingTree) return mergeChanges(committed);
  const dirty = parseNameStatus(
    await git(["diff", "--name-status", "-z", "--find-renames", "HEAD", "--"]),
  );
  const untracked = new TextDecoder()
    .decode(await git(["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean)
    .map((path): Change => ({ status: "A", path }));
  return mergeChanges([...committed, ...dirty, ...untracked]);
}

function repoPath(filename: string): string | null {
  let actual = filename;
  try {
    actual = realpathSync(filename);
  } catch {
    // A missing source is handled before graph construction. Compiler library files are ignored.
  }
  const path = relative(repoRoot, actual).split(sep).join("/");
  return path === ".." || path.startsWith("../") || isAbsolute(path) ? null : path;
}

async function sourceFiles(): Promise<string[]> {
  const tracked = new TextDecoder()
    .decode(
      await git([
        "ls-files",
        "-z",
        "--",
        "*.ts",
        "*.tsx",
        "*.mts",
        "*.cts",
        "*.js",
        "*.jsx",
        "*.mjs",
        "*.cjs",
      ]),
    )
    .split("\0")
    .filter(Boolean);
  return tracked.filter((path) => existsSync(resolve(repoRoot, path))).sort();
}
async function prepareGeneratedSources(): Promise<void> {
  const child = Bun.spawn(["bun", "scripts/generate-web-changelog.ts"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    fail(`generated source preparation failed: ${(stderr || stdout).trim() || `exit ${exitCode}`}`);
  }
}

async function workspaceModulePaths(): Promise<ReadonlyMap<string, string>> {
  const manifests = new TextDecoder()
    .decode(
      await git([
        "ls-files",
        "-z",
        "--",
        "packages/*/package.json",
        "packages/plugins/*/package.json",
      ]),
    )
    .split("\0")
    .filter(Boolean);
  const modules = new Map<string, string>();
  for (const manifest of manifests) {
    const text = ts.sys.readFile(resolve(repoRoot, manifest));
    if (text === undefined) continue;
    const parsed = JSON.parse(text) as {
      readonly name?: unknown;
      readonly exports?: unknown;
    };
    if (typeof parsed.name !== "string") continue;
    const root = resolve(repoRoot, manifest, "..");
    if (typeof parsed.exports === "string") {
      modules.set(parsed.name, resolve(root, parsed.exports));
      continue;
    }
    if (typeof parsed.exports !== "object" || parsed.exports === null) continue;
    for (const [subpath, target] of Object.entries(parsed.exports)) {
      if (typeof target !== "string" || (subpath !== "." && !subpath.startsWith("./"))) continue;
      modules.set(
        subpath === "." ? parsed.name : `${parsed.name}/${subpath.slice(2)}`,
        resolve(root, target),
      );
    }
  }
  return modules;
}
export async function buildDependencyGraph(): Promise<DependencyGraph> {
  const roots = await sourceFiles();
  const workspaceModules = await workspaceModulePaths();
  const options: ts.CompilerOptions = {
    allowImportingTsExtensions: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    target: ts.ScriptTarget.ES2024,
  };
  const resolutionCache = ts.createModuleResolutionCache(repoRoot, (path) => path, options);
  const sources = new Map<string, ts.SourceFile>();
  for (const path of roots) {
    const filename = resolve(repoRoot, path);
    const text = ts.sys.readFile(filename);
    if (text === undefined) continue;
    sources.set(path, ts.createSourceFile(filename, text, ts.ScriptTarget.ES2024, true));
  }
  const importers = new Map<string, Set<string>>();
  const directImporters = new Map<string, Set<string>>();
  const provenanceImporters = new Map<string, Set<string>>();
  const holes = new Set<string>();
  const addEdge = (graph: Map<string, Set<string>>, dependency: string, importer: string): void => {
    const dependents = graph.get(dependency) ?? new Set<string>();
    dependents.add(importer);
    graph.set(dependency, dependents);
  };
  const resolveImport = (specifier: string, source: ts.SourceFile): string | null => {
    const resolvedFile =
      workspaceModules.get(specifier) ??
      ts.resolveModuleName(specifier, source.fileName, options, ts.sys, resolutionCache)
        .resolvedModule?.resolvedFileName;
    if (resolvedFile === undefined) return null;
    const dependency = repoPath(resolvedFile);
    return dependency === null || dependency.startsWith("node_modules/") ? null : dependency;
  };
  const sourceAt = (path: string): ts.SourceFile | undefined => {
    const existing = sources.get(path);
    if (existing !== undefined) return existing;
    const filename = resolve(repoRoot, path);
    const text = ts.sys.readFile(filename);
    if (text === undefined) return undefined;
    const parsed = ts.createSourceFile(filename, text, ts.ScriptTarget.ES2024, true);
    sources.set(path, parsed);
    return parsed;
  };

  const bindingCache = new Map<string, ReadonlySet<string> | null>();
  const bindingModuleCache = new Map<string, ReadonlySet<string>>();
  const nonCacheableBindings = new Set<string>();
  const bindingDependencies = (
    modulePath: string,
    exportedName: string,
    seen = new Set<string>(),
  ): ReadonlySet<string> | null => {
    const key = `${modulePath}\u0000${exportedName}`;
    if (seen.has(key)) {
      for (const active of seen) nonCacheableBindings.add(active);
      return new Set();
    }
    if (bindingCache.has(key)) return bindingCache.get(key) ?? null;
    const usedModules = new Set<string>();
    const finish = (result: ReadonlySet<string> | null): ReadonlySet<string> | null => {
      seen.delete(key);
      if (!nonCacheableBindings.has(key) || seen.size === 0) {
        bindingCache.set(key, result);
        nonCacheableBindings.delete(key);
      }
      bindingModuleCache.set(key, usedModules);
      return result;
    };
    seen.add(key);
    const source = sourceAt(modulePath);
    if (source === undefined) return finish(null);
    const imports = new Map<
      string,
      { readonly dependency: string; readonly importedName: string | null }
    >();
    const declarations = new Map<string, ts.Node>();
    let exported: ts.Node | undefined;
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const dependency = resolveImport(statement.moduleSpecifier.text, source);
        const clause = statement.importClause;
        if (dependency === null) continue;
        if (clause === undefined) {
          usedModules.add(dependency);
          continue;
        }
        if (clause.name !== undefined) {
          imports.set(clause.name.text, { dependency, importedName: "default" });
        }
        if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            imports.set(element.name.text, {
              dependency,
              importedName: (element.propertyName ?? element.name).text,
            });
          }
        }
        if (clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
          imports.set(clause.namedBindings.name.text, {
            dependency,
            importedName: null,
          });
        }
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name))
            declarations.set(declaration.name.text, declaration);
        }
      } else if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          ts.isEnumDeclaration(statement)) &&
        statement.name !== undefined
      ) {
        declarations.set(statement.name.text, statement);
      }
      const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
      if (
        modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true &&
        ((ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(
            (declaration) =>
              ts.isIdentifier(declaration.name) && declaration.name.text === exportedName,
          )) ||
          ((ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement) ||
            ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement) ||
            ts.isEnumDeclaration(statement)) &&
            statement.name?.text === exportedName))
      ) {
        exported = statement;
      }
      if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
        if (ts.isNamespaceExport(statement.exportClause)) {
          if (statement.exportClause.name.text !== exportedName) continue;
          if (
            statement.moduleSpecifier === undefined ||
            !ts.isStringLiteral(statement.moduleSpecifier)
          ) {
            return finish(null);
          }
          const dependency = resolveImport(statement.moduleSpecifier.text, source);
          if (dependency !== null) usedModules.add(dependency);
          return finish(dependency === null ? new Set() : new Set([dependency]));
        }
        const element = statement.exportClause.elements.find(
          (candidate) => candidate.name.text === exportedName,
        );
        if (element === undefined) continue;
        if (
          statement.moduleSpecifier !== undefined &&
          ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          const dependency = resolveImport(statement.moduleSpecifier.text, source);
          if (dependency === null) return finish(new Set());
          usedModules.add(dependency);
          const nestedName = (element.propertyName ?? element.name).text;
          const nested = bindingDependencies(dependency, nestedName, seen);
          for (const used of bindingModuleCache.get(`${dependency}\u0000${nestedName}`) ?? []) {
            usedModules.add(used);
          }
          if (nested === null) return finish(null);
          return finish(new Set([dependency, ...nested]));
        }
        exported = declarations.get((element.propertyName ?? element.name).text);
      }
    }
    if (exported === undefined) {
      for (const statement of source.statements) {
        if (
          !ts.isExportDeclaration(statement) ||
          statement.exportClause !== undefined ||
          statement.moduleSpecifier === undefined ||
          !ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          continue;
        }
        const dependency = resolveImport(statement.moduleSpecifier.text, source);
        if (dependency === null) continue;
        usedModules.add(dependency);
        const nested = bindingDependencies(dependency, exportedName, seen);
        for (const used of bindingModuleCache.get(`${dependency}\u0000${exportedName}`) ?? []) {
          usedModules.add(used);
        }
        if (nested !== null) return finish(new Set([dependency, ...nested]));
      }
      return finish(null);
    }
    const dependencies = new Set<string>();
    let complete = true;
    const localSeen = new Set<ts.Node>();
    const visit = (node: ts.Node): void => {
      if (localSeen.has(node)) return;
      localSeen.add(node);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const dependency = resolveImport(node.arguments[0].text, source);
        if (dependency !== null) usedModules.add(dependency);
      }
      if (ts.isIdentifier(node)) {
        const imported = imports.get(node.text);
        if (imported !== undefined) {
          usedModules.add(imported.dependency);
          if (imported.importedName !== null) {
            const nested = bindingDependencies(imported.dependency, imported.importedName, seen);
            for (const used of bindingModuleCache.get(
              `${imported.dependency}\u0000${imported.importedName}`,
            ) ?? []) {
              usedModules.add(used);
            }
            if (nested === null) complete = false;
            else for (const dependency of nested) dependencies.add(dependency);
          }
          return;
        }
        const local = declarations.get(node.text);
        if (local !== undefined && local !== node) {
          visit(local);
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(exported);
    return finish(complete ? dependencies : null);
  };

  for (const [from, source] of sources) {
    const staticSpecifiers = new Set<string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const specifier = statement.moduleSpecifier.text;
      staticSpecifiers.add(specifier);
      const dependency = resolveImport(specifier, source);
      if (dependency === null) {
        const hasAssetExtension =
          /\.[a-z0-9]+(?:\?.*)?$/i.test(specifier) && !SOURCE.test(specifier);
        if (
          (specifier.startsWith(".") ||
            specifier.startsWith("@manifold") ||
            specifier.startsWith("@manifold-plugin")) &&
          !hasAssetExtension
        ) {
          holes.add(`${from} -> ${specifier}`);
        }
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        addEdge(directImporters, dependency, from);
        if (statement.importClause?.name !== undefined) {
          addEdge(importers, dependency, from);
        }
        for (const element of bindings.elements) {
          const importedName = (element.propertyName ?? element.name).text;
          const semantic = bindingDependencies(dependency, importedName);
          if (semantic === null) {
            holes.add(`${from} -> ${specifier}#${importedName}`);
            continue;
          }
          for (const semanticDependency of semantic) {
            addEdge(importers, semanticDependency, from);
          }
          for (const usedModule of bindingModuleCache.get(`${dependency}\u0000${importedName}`) ??
            []) {
            addEdge(provenanceImporters, usedModule, from);
          }
        }
      } else {
        addEdge(importers, dependency, from);
      }
    }
    for (const imported of ts.preProcessFile(source.text, true, true).importedFiles) {
      if (staticSpecifiers.has(imported.fileName)) continue;
      const dependency = resolveImport(imported.fileName, source);
      if (dependency !== null) {
        addEdge(importers, dependency, from);
        continue;
      }
      const hasAssetExtension =
        /\.[a-z0-9]+(?:\?.*)?$/i.test(imported.fileName) && !SOURCE.test(imported.fileName);
      if (
        (imported.fileName.startsWith(".") ||
          imported.fileName.startsWith("@manifold") ||
          imported.fileName.startsWith("@manifold-plugin")) &&
        !hasAssetExtension
      ) {
        holes.add(`${from} -> ${imported.fileName}`);
      }
    }
  }
  return { importers, directImporters, provenanceImporters, holes: [...holes].sort() };
}
function impactedPaths(
  changedFiles: readonly string[],
  graph: DependencyGraph,
): {
  readonly paths: ReadonlySet<string>;
  readonly via: ReadonlyMap<string, string>;
} {
  const paths = new Set(changedFiles.filter((path) => SOURCE.test(path)));
  const initial = new Set(paths);
  const queue = [...paths];
  const via = new Map<string, string>();
  for (let index = 0; index < queue.length; index += 1) {
    const dependency = queue[index];
    if (dependency === undefined) continue;
    const importers = [
      ...(graph.importers.get(dependency) ?? []),
      ...(initial.has(dependency) ? (graph.directImporters?.get(dependency) ?? []) : []),
      ...(initial.has(dependency) ? (graph.provenanceImporters?.get(dependency) ?? []) : []),
    ];
    for (const importer of importers) {
      if (paths.has(importer)) continue;
      paths.add(importer);
      via.set(importer, dependency);
      queue.push(importer);
    }
  }
  return { paths, via };
}

function dependencyReason(
  path: string,
  changedFiles: ReadonlySet<string>,
  via: ReadonlyMap<string, string>,
): string {
  const chain = [path];
  let cursor = path;
  while (!changedFiles.has(cursor)) {
    const next = via.get(cursor);
    if (next === undefined) break;
    chain.push(next);
    cursor = next;
  }
  return chain.reverse().join(" -> ");
}

function packagePath(path: string): string | null {
  const plugin = /^(packages\/plugins\/[^/]+)\//.exec(path)?.[1];
  if (plugin !== undefined) return plugin;
  return /^(packages\/[^/]+)\//.exec(path)?.[1] ?? null;
}

function orderedChecks(selected: ReadonlySet<CheckId>): CheckId[] {
  return ALL_CHECKS.filter((check) => selected.has(check));
}

function fullPlan(
  base: string,
  head: string,
  files: readonly string[],
  reason: string,
  risk: "high" | "unknown",
): CiPlan {
  return {
    version: 1,
    base,
    head,
    risk,
    changedFiles: [...files].sort(),
    reasons: [reason],
    checks: [...ALL_CHECKS],
    unitPaths: ["packages/protocol/test"],
  };
}

export function planFromEvidence(input: {
  readonly base: string;
  readonly head: string;
  readonly changes: readonly Change[];
  readonly graph: DependencyGraph;
  readonly availableSources?: ReadonlySet<string>;
}): CiPlan {
  const changedFiles = input.changes.map((change) => change.path).sort();
  if (
    input.changes.some((change) => change.status.startsWith("D") || change.status.startsWith("R"))
  ) {
    return fullPlan(
      input.base,
      input.head,
      changedFiles,
      "deleted or renamed input makes dependency evidence incomplete",
      "unknown",
    );
  }
  const fullPath = changedFiles.find((path) => FULL_PATH.test(path) || NORMATIVE.test(path));
  if (fullPath !== undefined) {
    return fullPlan(
      input.base,
      input.head,
      changedFiles,
      `${fullPath} changes CI, toolchain, registry, or normative policy`,
      "high",
    );
  }
  const unknown = changedFiles.find(
    (path) => !SOURCE.test(path) && !CSS.test(path) && !DOC_STYLE.test(path),
  );
  if (unknown !== undefined) {
    return fullPlan(input.base, input.head, changedFiles, `unknown path ${unknown}`, "unknown");
  }
  const missingSource = changedFiles.find(
    (path) =>
      SOURCE.test(path) &&
      !(input.availableSources?.has(path) ?? existsSync(resolve(repoRoot, path))),
  );
  const unknownSource = changedFiles.find(
    (path) => SOURCE.test(path) && !KNOWN_SOURCE_ROOT.test(path),
  );
  if (unknownSource !== undefined) {
    return fullPlan(
      input.base,
      input.head,
      changedFiles,
      `unknown source root ${unknownSource}`,
      "unknown",
    );
  }
  if (missingSource !== undefined) {
    return fullPlan(
      input.base,
      input.head,
      changedFiles,
      `source input is unavailable: ${missingSource}`,
      "unknown",
    );
  }
  if (input.graph.holes.length > 0) {
    return fullPlan(
      input.base,
      input.head,
      changedFiles,
      `dependency graph is incomplete: ${input.graph.holes[0]}`,
      "unknown",
    );
  }
  const impact = impactedPaths(changedFiles, input.graph);
  const selected = new Set<CheckId>(MANDATORY_CHECKS);
  const reasons: string[] = [];
  const changedSet = new Set(changedFiles);
  let risk: CiPlan["risk"] = "standard";
  const impactedDeployment = [...impact.paths].sort().find((path) => DEPLOYMENT_ROOT.test(path));
  if (impactedDeployment !== undefined && !changedSet.has(impactedDeployment)) {
    return fullPlan(
      input.base,
      input.head,
      changedFiles,
      `deployment dependency: ${dependencyReason(impactedDeployment, changedSet, impact.via)}`,
      "high",
    );
  }

  const riskPaths = [...impact.paths]
    .filter((path) => !TEST.test(path) || changedSet.has(path))
    .sort();
  for (const boundary of BOUNDARIES) {
    const hit = riskPaths.find((path) => boundary.pattern.test(path));
    if (hit === undefined) continue;
    risk = "high";
    for (const check of boundary.checks) selected.add(check);
    reasons.push(`${boundary.name}: ${dependencyReason(hit, changedSet, impact.via)}`);
  }
  if (changedFiles.some((path) => path.startsWith("packages/server/"))) {
    selected.add("unit");
    selected.add("e2e-rest");
  }
  if (changedFiles.some((path) => /^packages\/(?:protocol|scene|sdk)\//.test(path))) {
    selected.add("unit");
    selected.add("e2e-rest");
    selected.add("convergence");
  }
  if (changedFiles.some((path) => /^packages\/web\/(?:sw\.js|vite\.config\.ts)$/.test(path))) {
    selected.add("pwa");
    selected.add("budgets");
    reasons.push("web delivery boundary changed");
  }
  if (risk === "standard") {
    reasons.push(
      changedFiles.length === 0
        ? "no changed paths; mandatory baseline remains required"
        : changedFiles.every((path) => DOC_STYLE.test(path))
          ? "documentation/style-only change; mandatory baseline remains required"
          : "affected source stays outside irreversible boundaries",
    );
  }

  const unitPaths = new Set<string>();
  for (const path of [...impact.paths].sort()) {
    if (TEST.test(path)) unitPaths.add(path);
  }
  for (const path of changedFiles) {
    if (TEST.test(path)) {
      unitPaths.add(path);
      continue;
    }
    const packageRoot = packagePath(path);
    if (packageRoot !== null && (SOURCE.test(path) || CSS.test(path))) {
      unitPaths.add(packageRoot);
    }
  }
  if (unitPaths.size === 0) unitPaths.add("packages/protocol/test");
  return {
    version: 1,
    base: input.base,
    head: input.head,
    risk,
    changedFiles,
    reasons: [...new Set(reasons)].sort(),
    checks: orderedChecks(selected),
    unitPaths: [...unitPaths].sort(),
  };
}

export async function createPlan(options: PlannerOptions): Promise<CiPlan> {
  const head = await revision(options.head ?? "HEAD");
  let base: string;
  if (options.base !== undefined) base = await revision(options.base);
  else if (options.full) base = head;
  else {
    await revision("origin/main");
    base = await textGit(["merge-base", "origin/main", head]);
    if (base === "") fail("origin/main and HEAD have no merge base");
  }
  if (options.full) {
    return fullPlan(base, head, [], "full verification was explicitly requested", "high");
  }

  await requireAnalyzedCheckout(base, head);
  const changes = await changed(options, base, head);
  const changedFiles = changes.map((change) => change.path);
  const graphIndependent =
    changes.some((change) => change.status.startsWith("D") || change.status.startsWith("R")) ||
    changedFiles.some((path) => FULL_PATH.test(path) || NORMATIVE.test(path)) ||
    changedFiles.some((path) => !SOURCE.test(path) && !CSS.test(path) && !DOC_STYLE.test(path)) ||
    changedFiles.some((path) => SOURCE.test(path) && !KNOWN_SOURCE_ROOT.test(path)) ||
    changedFiles.some((path) => SOURCE.test(path) && !existsSync(resolve(repoRoot, path))) ||
    changedFiles.every((path) => !SOURCE.test(path));
  if (graphIndependent) {
    return planFromEvidence({
      base,
      head,
      changes,
      graph: { importers: new Map(), holes: [] },
    });
  }
  await prepareGeneratedSources();
  const graph = await buildDependencyGraph();
  return planFromEvidence({ base, head, changes, graph });
}
interface CliOptions extends PlannerOptions {
  readonly json: boolean;
  readonly githubOutput: boolean;
  readonly run: boolean;
  readonly runTargeted: boolean;
  readonly unitPathsJson?: string;
}

function usage(message: string): never {
  console.error(
    `ci-plan: ${message}\nusage: bun scripts/ci-plan.ts [--base <git-rev>] [--head <git-rev>] [--full] [--json | --github-output | --run | --run-targeted [--unit-paths-json <json>]]`,
  );
  process.exit(2);
}

function parseArgs(argv: readonly string[]): CliOptions {
  let base: string | undefined;
  let head: string | undefined;
  let unitPathsJson: string | undefined;
  let full = false;
  let json = false;
  let githubOutput = false;
  let run = false;
  let runTargeted = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--base" || argument === "--head") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-"))
        usage(`${argument} requires a git revision`);
      if (argument === "--base") {
        if (base !== undefined) usage("--base may be specified only once");
        base = value;
      } else {
        if (head !== undefined) usage("--head may be specified only once");
        head = value;
      }
      index += 1;
    } else if (argument === "--full") full = true;
    else if (argument === "--json") json = true;
    else if (argument === "--github-output") githubOutput = true;
    else if (argument === "--run") run = true;
    else if (argument === "--run-targeted") runTargeted = true;
    else if (argument === "--unit-paths-json") {
      if (unitPathsJson !== undefined) usage("--unit-paths-json may be specified only once");
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--"))
        usage("--unit-paths-json requires a JSON array");
      unitPathsJson = value;
      index += 1;
    } else usage(`unknown argument ${JSON.stringify(argument)}`);
  }
  const modes = [json, githubOutput, run, runTargeted].filter(Boolean).length;
  if (modes > 1) usage("choose only one output or run mode");
  if (
    unitPathsJson !== undefined &&
    (!runTargeted ||
      base !== undefined ||
      head !== undefined ||
      full ||
      json ||
      githubOutput ||
      run)
  ) {
    usage("--unit-paths-json is internal to standalone --run-targeted");
  }
  return {
    ...(base === undefined ? {} : { base }),
    ...(head === undefined ? {} : { head }),
    ...(unitPathsJson === undefined ? {} : { unitPathsJson }),
    full,
    includeWorkingTree: base === undefined && head === undefined,
    json,
    githubOutput,
    run,
    runTargeted,
  };
}
function summary(plan: CiPlan): string {
  return [
    `CI plan: ${plan.risk} risk`,
    `base: ${plan.base}`,
    `head: ${plan.head}`,
    `checks: ${plan.checks.join(", ")}`,
    `targeted: ${plan.unitPaths.join(", ")}`,
    ...plan.reasons.map((reason) => `reason: ${reason}`),
  ].join("\n");
}

async function runCommand(
  command: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<void> {
  console.log(`ci-plan: run ${command.join(" ")}`);
  const child = Bun.spawn([...command], {
    cwd: repoRoot,
    env: { ...process.env, ...environment },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) fail(`${command.join(" ")} exited ${exitCode}`);
}

function validatedUnitPaths(value: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("--unit-paths-json must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 256) {
    fail("--unit-paths-json must be a nonempty array of at most 256 paths");
  }
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const candidate of parsed) {
    if (
      typeof candidate !== "string" ||
      candidate.length > 512 ||
      !/^(?:packages|scripts)\//.test(candidate) ||
      candidate.includes("\\") ||
      candidate
        .split("/")
        .some((component) => component === "" || component === "." || component === "..")
    ) {
      fail(`unsafe targeted test path ${JSON.stringify(candidate)}`);
    }
    const packageRoot = /^packages\/(?:plugins\/[^/]+|[^/]+)$/.test(candidate);
    const packageTests = /^packages\/(?:plugins\/[^/]+|[^/]+)\/test$/.test(candidate);
    if (!packageRoot && !packageTests && !TEST.test(candidate)) {
      fail(`targeted path is not a package or runnable test: ${candidate}`);
    }
    const absolute = resolve(repoRoot, candidate);
    if (!existsSync(absolute) || repoPath(realpathSync(absolute)) !== candidate) {
      fail(`targeted test path does not exist in this checkout: ${candidate}`);
    }
    if (seen.has(candidate)) fail(`duplicate targeted test path: ${candidate}`);
    seen.add(candidate);
    paths.push(candidate);
  }
  return paths;
}

async function runTargeted(unitPaths: readonly string[]): Promise<void> {
  await runCommand(["bun", "test", ...unitPaths]);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.unitPathsJson !== undefined) {
    await runTargeted(validatedUnitPaths(options.unitPathsJson));
    return;
  }
  const plan = await createPlan(options);
  if (options.runTargeted) {
    await runTargeted(plan.unitPaths);
    return;
  }
  if (options.run) {
    const parent = mkdtempSync(resolve(tmpdir(), "manifold-ci-plan-"));
    const dist = resolve(parent, "dist");
    try {
      for (const group of ["build", "types", "style", "smoke"] as const) {
        await runCommand(["bun", "scripts/gate.ts", "--only", group], {
          MANIFOLD_GATE_DIST: dist,
        });
      }
      await runTargeted(plan.unitPaths);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
    const extras = plan.checks.filter((check) =>
      EXTRA_CHECKS.includes(check as (typeof EXTRA_CHECKS)[number]),
    );
    if (extras.length > 0) console.log(`ci-plan: CI additionally requires ${extras.join(", ")}`);
    return;
  }
  if (options.githubOutput) {
    const output = process.env["GITHUB_OUTPUT"];
    const stepSummary = process.env["GITHUB_STEP_SUMMARY"];
    if (output === undefined || stepSummary === undefined)
      fail("--github-output requires GITHUB_OUTPUT and GITHUB_STEP_SUMMARY");
    appendFileSync(
      output,
      `checks=${JSON.stringify(plan.checks)}\nrisk=${plan.risk}\nunitPaths=${JSON.stringify(plan.unitPaths)}\n`,
    );
    appendFileSync(stepSummary, `## CI impact plan\n\n${summary(plan).replaceAll("\n", "  \n")}\n`);
    return;
  }
  console.log(options.json ? JSON.stringify(plan) : summary(plan));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
