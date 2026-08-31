/**
 * manifold axioms gate — the constitution made falsifiable.
 *
 * `AXIOMS.md` swears that everything above the floor is a plugin (A1), that every capability
 * is reachable identically by a browser and an SDK (A2), and that the boundary between the
 * two is a machine-readable registry rather than a promise (D10). A document nobody can
 * violate silently is the only kind worth writing, so this script reads those registries and
 * holds the tree to them — in BOTH directions, so an unrecorded crossing fails here rather
 * than in review.
 *
 * The static half (S1-S8) runs against the source tree with the TypeScript parser, never a
 * regex over source (D14): imports, storage keys, action markers and route literals are AST
 * facts, and a regex that "mostly works" on them is a gate that mostly holds.
 *
 *   S1 both assembly files assemble, and the default workspace names panels that exist
 *   S2 import boundary: floor imports no plugin; a plugin imports only the four engine packages
 *   S3 every localStorage key is in the device-local register
 *   S4 every `data-action` literal names a composed action
 *   S5 every plugin package is registered, and every composed plugin has a package
 *   S6 registry liveness: every floor glob still matches a file
 *   S7 route allowlist: no bespoke feature route grew beside the action door
 *   S8 every scene element type is a floor kind or a composed contribution
 *
 * The browser half (R1-R8) runs a real server and a real Chromium against the built bundle,
 * because the axioms are claims about a LIVE workspace: parity between the two doors, hot
 * enable/disable with no reload, the shell as a composition, observable view presence, and
 * the denial ladder end to end.
 *
 * Self-contained: builds the web bundle to a temp dir (or shares the gate's), spawns its own
 * server + agent on an ephemeral port, restores every plugin it toggled, cleans up.
 * Env: MANIFOLD_CHROMIUM (else system chromium), MANIFOLD_GATE_DIST (shared bundle).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import {
  AssemblyError,
  assembleRoster,
  ITEM_NOUNS,
  DEFAULT_WORKSPACE_LAYOUT,
  ENGINE_PLUGINS_ID,
  ENGINE_SET_ENABLED_ACTION,
  enginePluginsActions,
  enginePluginsManifest,
  type Assembly,
} from "../packages/plugin/src/index.ts";
import {
  ActionOutcomeSchema,
  ActionSummarySchema,
  ITEM_KINDS,
  LayoutResponseSchema,
  MachinesResponseSchema,
  ContainerResponseSchema,
  PluginRosterSchema,
  PluginsResponseSchema,
  ResolveResponseSchema,
  SceneElementSchema,
  TokenGrantSchema,
  formatManifoldUri,
  type TokenGrant,
} from "../packages/protocol/src/index.ts";
import { SERVER_PLUGIN_DEFS } from "../packages/server/src/assembly.ts";
import { SessionClient } from "../packages/sdk/src/index.ts";
import { resolveWebDist } from "./gate-dist.ts";
import { Browser, sleep, until } from "./cdp.ts";

const repoRoot = join(import.meta.dir, "..");
const failures: string[] = [];

function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  if (!ok) failures.push(`${name}: ${detail}`);
}

/** Polls a rendered condition and ANSWERS instead of throwing, so a miss reads as FAIL. */
async function settles(probe: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() > deadline) return false;
    await sleep(200);
  }
}

const list = (values: Iterable<string>): string => {
  const all = [...values];
  return all.length === 0 ? "none" : all.join(", ");
};

// ─────────────────────────────────────────────────────────── the registries

interface FloorRow {
  readonly glob: string;
  readonly why: string;
}

interface DeviceLocalRow {
  readonly key: string;
  /** True when the register entry licenses a FAMILY (`manifold:viewport:<containerId>`). */
  readonly prefix: boolean;
  readonly why: string;
}

/** A registry row is only a row when it carries its reason: an unjustified glob is not law. */
function justified(row: unknown, field: string): string | null {
  if (row === null || typeof row !== "object") return null;
  if (!("why" in row) || typeof row.why !== "string" || row.why === "") return null;
  if (!(field in row)) return null;
  const value: unknown = Reflect.get(row, field);
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The fenced JSON in `AXIOMS.md`. Read from the document rather than imported from a module
 * because the registry's HOME is the constitution — a TypeScript copy would be a second door
 * onto "where does the boundary run", and D10's whole point is that there is exactly one.
 * A row missing its `why` is discarded here, which makes an unjustified entry fail the check
 * that reads the registry instead of quietly widening the floor.
 */
function axiomRegistries(): {
  readonly floor: readonly FloorRow[];
  readonly deviceLocal: readonly DeviceLocalRow[];
} {
  const text = readFileSync(join(repoRoot, "AXIOMS.md"), "utf8");
  const floor: FloorRow[] = [];
  const deviceLocal: DeviceLocalRow[] = [];
  const fence = /```json\n([\s\S]*?)\n```/g;
  for (;;) {
    const block = fence.exec(text);
    if (block === null) break;
    const parsed: unknown = JSON.parse(block[1] ?? "");
    if (parsed === null || typeof parsed !== "object") continue;
    if ("floor" in parsed && Array.isArray(parsed.floor)) {
      for (const row of parsed.floor) {
        const glob = justified(row, "glob");
        if (glob !== null) floor.push({ glob, why: String(Reflect.get(row as object, "why")) });
      }
    }
    if (!("deviceLocal" in parsed) || !Array.isArray(parsed.deviceLocal)) continue;
    for (const row of parsed.deviceLocal) {
      const key = justified(row, "key");
      if (key === null) continue;
      deviceLocal.push({
        key,
        prefix: Reflect.get(row as object, "prefix") === true,
        why: String(Reflect.get(row as object, "why")),
      });
    }
  }
  if (floor.length === 0) throw new Error("AXIOMS.md carries no fenced `floor` registry");
  if (deviceLocal.length === 0) {
    throw new Error("AXIOMS.md carries no fenced `deviceLocal` register");
  }
  return { floor, deviceLocal };
}

// ─────────────────────────────────────────────────────────── source scanning

const SOURCE = /\.tsx?$/;
const TEST_SOURCE = /\.test\.tsx?$/;

/** Repo-relative source paths a glob matches, tests excluded (they are governed by subject). */
function sourcesMatching(glob: string): readonly string[] {
  const found: string[] = [];
  for (const hit of new Bun.Glob(glob).scanSync({ cwd: repoRoot, onlyFiles: true })) {
    const path = hit.split("\\").join("/");
    if (SOURCE.test(path) && !TEST_SOURCE.test(path)) found.push(path);
  }
  return found.sort();
}

const sourceCache = new Map<string, ts.SourceFile>();

function parsed(path: string): ts.SourceFile {
  const cached = sourceCache.get(path);
  if (cached !== undefined) return cached;
  const text = readFileSync(join(repoRoot, path), "utf8");
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  sourceCache.set(path, file);
  return file;
}

function lineOf(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => {
    walk(child, visit);
  });
}

/** Every module this file names: static imports, re-exports, and dynamic `import()`. */
function moduleSpecifiers(
  path: string,
): readonly { readonly text: string; readonly line: number }[] {
  const file = parsed(path);
  const specifiers: { text: string; line: number }[] = [];
  walk(file, (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push({ text: node.moduleSpecifier.text, line: lineOf(file, node) });
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push({ text: node.arguments[0].text, line: lineOf(file, node) });
    }
  });
  return specifiers;
}

/** Top-level `const NAME = "literal"` bindings, so a key referenced by name still resolves. */
function stringConstants(file: ts.SourceFile): ReadonlyMap<string, string> {
  const constants = new Map<string, string>();
  walk(file, (node) => {
    if (!ts.isVariableDeclaration(node)) return;
    if (!ts.isIdentifier(node.name) || node.initializer === undefined) return;
    if (ts.isStringLiteral(node.initializer)) constants.set(node.name.text, node.initializer.text);
  });
  return constants;
}

/**
 * The literal a storage-key expression carries: the string itself, the constant it names, or
 * the fixed HEAD of a template (`manifold:viewport:${containerId}` is the registered prefix plus an
 * id, and the register is what says the prefix form is allowed).
 */
function keyLiteral(node: ts.Expression, constants: ReadonlyMap<string, string>): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return constants.get(node.text) ?? null;
  if (ts.isTemplateExpression(node)) {
    const head = node.head.text;
    if (head !== "") return head;
    // `${KEY_PREFIX}${id}`: the prefix is the first span's expression, not the head.
    const first = node.templateSpans[0]?.expression;
    if (first !== undefined && ts.isIdentifier(first)) return constants.get(first.text) ?? null;
  }
  return null;
}

// ─────────────────────────────────────────────────────────── the assembly

let assembly: Assembly | null = null;
try {
  /*
    The engine's own builtin row is registered by the HOST, not by `assembly.ts` — so the
    vocabulary this script compares against the live server has to include it, or every
    check that says "/api/protocol equals the composition" would fail on the enablement door
    itself.
  */
  assembly = assembleRoster(
    [...SERVER_PLUGIN_DEFS, { manifest: enginePluginsManifest, actions: enginePluginsActions }],
    new Set(),
    { builtins: new Set([ENGINE_PLUGINS_ID]) },
  );
  check("S1 server assembly", true, `${String(assembly.roster.length)} plugins composed`);
} catch (error) {
  const detail = error instanceof AssemblyError ? error.problems.join(" | ") : String(error);
  check("S1 server assembly", false, detail);
}

const composed: Assembly = assembly ?? assembleRoster([], new Set<string>());
const actionNames = new Set(composed.actions.keys());
const pluginIds = new Set(composed.roster.map((entry) => entry.manifest.id));
const elementTypes = new Set(composed.elements.keys());

/**
 * The web registration file, read rather than imported. Importing it pulls React, React Flow
 * and the whole renderer into this process — modules whose import-time work keeps the event
 * loop alive and would hang a script that only wants to know which ids are attached. The
 * facts wanted here are syntactic anyway: which plugin id each entry registers, and which
 * panel and section keys it attaches to it.
 */
interface WebRegistration {
  readonly id: string;
  readonly panels: readonly string[];
  readonly sections: readonly string[];
  readonly source: string;
}

function registrationFromObject(
  literal: ts.ObjectLiteralExpression,
  source: string,
): WebRegistration | null {
  let id: string | null = null;
  const panels: string[] = [];
  const sections: string[] = [];
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = ts.isIdentifier(property.name)
      ? property.name.text
      : ts.isStringLiteral(property.name)
        ? property.name.text
        : null;
    if (name === "id" && ts.isStringLiteral(property.initializer)) {
      id = property.initializer.text;
      continue;
    }
    if (name !== "panels" && name !== "sections") continue;
    if (!ts.isObjectLiteralExpression(property.initializer)) continue;
    for (const contribution of property.initializer.properties) {
      if (!ts.isPropertyAssignment(contribution) && !ts.isShorthandPropertyAssignment(contribution))
        continue;
      const key = ts.isIdentifier(contribution.name)
        ? contribution.name.text
        : ts.isStringLiteral(contribution.name)
          ? contribution.name.text
          : null;
      if (key === null) continue;
      (name === "panels" ? panels : sections).push(key);
    }
  }
  return id === null ? null : { id, panels, sections, source };
}

/** Follows `drawWebPlugin` back to `@manifold-plugin/draw/web` and reads the object there. */
function resolveExportedRegistration(file: ts.SourceFile, name: string): WebRegistration | null {
  let specifier: string | null = null;
  walk(file, (node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    const bindings = node.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) return;
    for (const element of bindings.elements) {
      if (element.name.text === name) specifier = node.moduleSpecifier.text;
    }
  });
  if (specifier === null) return null;
  const path = resolvePackageEntry(specifier);
  if (path === null) return null;
  const target = parsed(path);
  let found: WebRegistration | null = null;
  walk(target, (node) => {
    if (found !== null) return;
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
    if (node.name.text !== name || node.initializer === undefined) return;
    if (ts.isObjectLiteralExpression(node.initializer)) {
      found = registrationFromObject(node.initializer, path);
    }
  });
  return found;
}

interface PluginPackage {
  readonly dir: string;
  readonly name: string;
  readonly exports: Readonly<Record<string, string>>;
}

function pluginPackages(): readonly PluginPackage[] {
  const packages: PluginPackage[] = [];
  for (const manifestPath of new Bun.Glob("packages/plugins/*/package.json").scanSync({
    cwd: repoRoot,
    onlyFiles: true,
  })) {
    const path = manifestPath.split("\\").join("/");
    const json: unknown = JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
    const name = String(Reflect.get(json as object, "name"));
    const rawExports = Reflect.get(json as object, "exports");
    const exportMap: Record<string, string> = {};
    if (rawExports !== null && typeof rawExports === "object") {
      for (const [key, value] of Object.entries(rawExports)) {
        if (typeof value === "string") exportMap[key] = value;
      }
    }
    packages.push({ dir: dirname(path), name, exports: exportMap });
  }
  return packages.sort((a, b) => (a.dir < b.dir ? -1 : 1));
}

const PLUGIN_PACKAGES = pluginPackages();

/** `@manifold-plugin/draw/web` → `packages/plugins/draw/src/web.tsx`, via the exports map. */
function resolvePackageEntry(specifier: string): string | null {
  const match = /^(@manifold-plugin\/[a-z-]+)(\/.+)?$/.exec(specifier);
  if (match === null) return null;
  const owner = PLUGIN_PACKAGES.find((candidate) => candidate.name === match[1]);
  if (owner === undefined) return null;
  const entry = owner.exports[match[2] === undefined ? "." : `.${match[2]}`];
  if (entry === undefined) return null;
  return `${owner.dir}/${entry.replace(/^\.\//, "")}`;
}

// ─────────────────────────────────────────────────────────── S1: assembly

const WEB_COMPOSITION = "packages/web/src/assembly.ts";
const SERVER_COMPOSITION = "packages/server/src/assembly.ts";

const webRegistrations: WebRegistration[] = [];
{
  const file = parsed(WEB_COMPOSITION);
  let defs: ts.ArrayLiteralExpression | null = null;
  walk(file, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
    if (node.name.text !== "WEB_PLUGIN_DEFS" || node.initializer === undefined) return;
    if (ts.isArrayLiteralExpression(node.initializer)) defs = node.initializer;
  });
  const entries: readonly ts.Expression[] =
    defs === null ? [] : (defs as ts.ArrayLiteralExpression).elements;
  for (const entry of entries) {
    const registration = ts.isObjectLiteralExpression(entry)
      ? registrationFromObject(entry, WEB_COMPOSITION)
      : ts.isIdentifier(entry)
        ? resolveExportedRegistration(file, entry.text)
        : null;
    if (registration === null) {
      check("S1 web assembly", false, `unreadable WEB_PLUGIN_DEFS entry ${entry.getText(file)}`);
      continue;
    }
    webRegistrations.push(registration);
  }
  const unknown = webRegistrations.filter((entry) => !pluginIds.has(entry.id));
  check(
    "S1 web assembly",
    entries.length > 0 && unknown.length === 0,
    unknown.length === 0
      ? `${String(webRegistrations.length)} web registrations, every id in the roster`
      : `web registers ids nothing composed: ${list(unknown.map((entry) => entry.id))}`,
  );

  const orphanContributions: string[] = [];
  for (const registration of webRegistrations) {
    for (const panel of registration.panels) {
      if (!composed.panels.has(`${registration.id}.${panel}`)) {
        orphanContributions.push(`panel ${registration.id}.${panel}`);
      }
    }
    for (const section of registration.sections) {
      const declared = composed.sections.some(
        (candidate) => candidate.plugin === registration.id && candidate.id === section,
      );
      if (!declared) orphanContributions.push(`section ${registration.id}.${section}`);
    }
  }
  check(
    "S1 web attachments",
    orphanContributions.length === 0,
    orphanContributions.length === 0
      ? "every attached component answers a declared contribution"
      : `attached to nothing declared: ${list(orphanContributions)}`,
  );
}

{
  const missing: string[] = [];
  for (const node of Object.values(DEFAULT_WORKSPACE_LAYOUT)) {
    const ref = node.ref;
    if (ref === null || ref.kind !== "panel") continue;
    if (!composed.panels.has(ref.panelId)) missing.push(ref.panelId);
  }
  check(
    "S1 default workspace",
    missing.length === 0,
    missing.length === 0
      ? "every default panel leaf resolves in the composition"
      : `default layout names panels nothing composed: ${list(missing)}`,
  );
}

// ─────────────────────────────────────────────────────────── S2: import boundary

const registries = axiomRegistries();
const floorFiles = new Set<string>();
const emptyGlobs: string[] = [];
for (const row of registries.floor) {
  const matched = sourcesMatching(row.glob);
  // A glob may legitimately match only non-source files (a stylesheet); liveness (S6) asks
  // whether ANYTHING is there, so it counts raw matches while the boundary walk takes source.
  const anything = [...new Bun.Glob(row.glob).scanSync({ cwd: repoRoot, onlyFiles: true })];
  if (anything.length === 0) emptyGlobs.push(row.glob);
  for (const path of matched) floorFiles.add(path);
}

{
  const offenders: string[] = [];
  for (const path of [...floorFiles].sort()) {
    if (path === WEB_COMPOSITION || path === SERVER_COMPOSITION) continue;
    for (const specifier of moduleSpecifiers(path)) {
      if (specifier.text.startsWith("@manifold-plugin/")) {
        offenders.push(`${path}:${String(specifier.line)} imports ${specifier.text}`);
      }
    }
  }
  check(
    "S2 floor imports no plugin",
    offenders.length === 0,
    offenders.length === 0
      ? `${String(floorFiles.size)} floor sources import no @manifold-plugin/*`
      : list(offenders),
  );
}

{
  /**
   * The four packages a plugin may name, plus the engine's two browser subpaths — `/hooks`
   * (plane mechanism: carry, drop, element host, polling) and `/ui` (the plugin-facing
   * standard library: glyphs, titlebar, the notice consumer half, view state). See
   * AXIOMS §Plugin layer.
   */
  const ENGINE: Readonly<Record<string, true>> = {
    "@manifold/protocol": true,
    "@manifold/scene": true,
    "@manifold/sdk": true,
    "@manifold/plugin": true,
    "@manifold/plugin/hooks": true,
    "@manifold/plugin/ui": true,
  };
  const offenders: string[] = [];
  let scanned = 0;
  for (const owner of PLUGIN_PACKAGES) {
    for (const path of sourcesMatching(`${owner.dir}/src/**`)) {
      scanned += 1;
      for (const specifier of moduleSpecifiers(path)) {
        const text = specifier.text;
        if (text.startsWith("@manifold-plugin/") && !text.startsWith(`${owner.name}/`)) {
          offenders.push(`${path}:${String(specifier.line)} reaches into ${text}`);
          continue;
        }
        if (text.startsWith("@manifold/") && ENGINE[text] !== true) {
          offenders.push(`${path}:${String(specifier.line)} imports ${text}`);
        }
      }
    }
  }
  check(
    "S2 plugins import only the engine",
    offenders.length === 0,
    offenders.length === 0
      ? `${String(scanned)} plugin sources import only protocol/scene/sdk/plugin`
      : list(offenders),
  );
}

// ─────────────────────────────────────────────────────────── S3: device-local register

{
  const registered = registries.deviceLocal;
  const isRegistered = (key: string): boolean =>
    registered.some((row) => (row.prefix ? key.startsWith(row.key) : key === row.key));

  const observed = new Map<string, string>();
  const noteKey = (key: string, where: string): void => {
    if (!observed.has(key)) observed.set(key, where);
  };
  const storageSources = [
    ...sourcesMatching("packages/web/src/**"),
    ...PLUGIN_PACKAGES.flatMap((owner) => sourcesMatching(`${owner.dir}/src/**`)),
  ];
  for (const path of storageSources) {
    const file = parsed(path);
    const constants = stringConstants(file);
    const usesStorage = file.text.includes("localStorage");
    walk(file, (node) => {
      /*
        Two harvests, because a key can be written two ways and both are real state. The
        CALL harvest is exact: whatever `getItem`/`setItem`/`removeItem` is handed, resolved
        through this file's own constants. The CONVENTION harvest catches the key BUILDERS —
        `manifold:viewport:${containerId}` never touches a storage call in its own module — by
        taking every `manifold.`/`manifold:` literal as a candidate. `manifold://` is an
        ADDRESS, not a key, and is the one prefix excluded.
      */
      if (
        usesStorage &&
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const method = node.expression.name.text;
        const first = node.arguments[0];
        if (
          (method === "getItem" || method === "setItem" || method === "removeItem") &&
          first !== undefined
        ) {
          const key = keyLiteral(first, constants);
          if (key !== null) noteKey(key, `${path}:${String(lineOf(file, node))}`);
        }
      }
      const literal = ts.isStringLiteral(node)
        ? node.text
        : ts.isNoSubstitutionTemplateLiteral(node)
          ? node.text
          : ts.isTemplateHead(node)
            ? node.text
            : null;
      if (literal === null) return;
      if (!/^manifold[.:]/.test(literal) || literal.startsWith("manifold://")) return;
      noteKey(literal, `${path}:${String(lineOf(file, node))}`);
    });
  }

  const unregistered = [...observed]
    .filter(([key]) => !isRegistered(key))
    .map(([key, where]) => `${key} (${where})`);
  check(
    "S3 device-local register",
    unregistered.length === 0,
    unregistered.length === 0
      ? `${String(observed.size)} device-local keys, all registered`
      : `unregistered keys: ${list(unregistered)}`,
  );
}

// ─────────────────────────────────────────────────────────── S4: data-action markers

{
  const markers = new Map<string, string>();
  const sources = [
    ...sourcesMatching("packages/web/src/**"),
    ...PLUGIN_PACKAGES.flatMap((owner) => sourcesMatching(`${owner.dir}/src/**`)),
  ];
  for (const path of sources) {
    const file = parsed(path);
    walk(file, (node) => {
      const where = `${path}:${String(lineOf(file, node))}`;
      if (
        ts.isJsxAttribute(node) &&
        node.name.getText(file) === "data-action" &&
        node.initializer !== undefined &&
        ts.isStringLiteral(node.initializer)
      ) {
        markers.set(node.initializer.text, where);
        return;
      }
      if (!ts.isPropertyAssignment(node)) return;
      const name = ts.isStringLiteral(node.name) ? node.name.text : null;
      if (name !== "data-action" || !ts.isStringLiteral(node.initializer)) return;
      markers.set(node.initializer.text, where);
    });
  }
  const unknown = [...markers]
    .filter(([name]) => !actionNames.has(name))
    .map(([name, where]) => `${name} (${where})`);
  check(
    "S4 data-action markers",
    markers.size > 0 && unknown.length === 0,
    unknown.length === 0
      ? `${String(markers.size)} marked affordances, every one a composed action`
      : `markers naming nothing composed: ${list(unknown)}`,
  );
}

// ─────────────────────────────────────────────────────────── S5: plugin packages

{
  const problems: string[] = [];
  const declaredByPackage = new Map<string, string[]>();
  for (const owner of PLUGIN_PACKAGES) {
    const dirName = owner.dir.slice("packages/plugins/".length);
    if (owner.name !== `@manifold-plugin/${dirName}`) {
      problems.push(`${owner.dir} is published as ${owner.name}`);
    }
    for (const [key, entry] of Object.entries(owner.exports)) {
      const path = join(repoRoot, owner.dir, entry);
      let exists = false;
      try {
        exists = statSync(path).isFile();
      } catch {
        exists = false;
      }
      if (!exists) problems.push(`${owner.name} exports ${key} → missing ${entry}`);
    }
    /*
      A package's manifests are read from its source, so "registered" means the id the
      package DECLARES is an id the server composed — not merely that some file mentions it.
    */
    const declared: string[] = [];
    for (const path of sourcesMatching(`${owner.dir}/src/**`)) {
      const file = parsed(path);
      walk(file, (node) => {
        if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
        if (!/Manifest$/.test(node.name.text) || node.initializer === undefined) return;
        if (!ts.isObjectLiteralExpression(node.initializer)) return;
        for (const property of node.initializer.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          if (property.name.getText(file) !== "id") continue;
          if (ts.isStringLiteral(property.initializer)) declared.push(property.initializer.text);
        }
      });
    }
    if (declared.length === 0) problems.push(`${owner.name} declares no manifest`);
    for (const id of declared) {
      if (!pluginIds.has(id)) problems.push(`${owner.name} declares ${id}, which nothing composed`);
    }
    declaredByPackage.set(owner.name, declared);
  }
  const packaged = new Set([...declaredByPackage.values()].flat());
  for (const id of pluginIds) {
    // A builtin row is the ENGINE's, so it has no `packages/plugins/*` directory to map back
    // to — and must not: administration of the composition is not a member of it.
    if (composed.builtin(id)) continue;
    if (!packaged.has(id)) problems.push(`composed ${id} maps back to no packages/plugins/* dir`);
  }
  check(
    "S5 plugin packages",
    problems.length === 0,
    problems.length === 0
      ? `${String(PLUGIN_PACKAGES.length)} packages declare all ${String(pluginIds.size)} composed ids, and nothing else`
      : list(problems),
  );
}

// ─────────────────────────────────────────────────────────── S6: registry liveness

check(
  "S6 registry liveness",
  emptyGlobs.length === 0,
  emptyGlobs.length === 0
    ? `${String(registries.floor.length)} floor globs, every one matching`
    : `floor globs matching nothing: ${list(emptyGlobs)}`,
);

// ─────────────────────────────────────────────────────────── S7: route allowlist

/**
 * Every path the HTTP door answers, as the tree stands. This list is the deliberate half of
 * the check: a new feature route must be ADDED here in the same change that adds it to the
 * server and to `docs/CONTRACTS.md`, which is precisely the friction the action door exists
 * to make unnecessary. A bespoke route that slips in without that edit fails the gate.
 */
const ROUTE_ALLOWLIST: readonly string[] = [
  "/api",
  "/api/actions/:name",
  "/api/containers",
  "/api/introspect",
  "/api/layout",
  "/api/attendance",
  "/api/containers/:id/tiles/:id",
  "/api/plugins",
  "/api/protocol",
  "/api/resolve",
  "/healthz",
  "/ws",
];

{
  const routes = new Set<string>();
  const file = parsed("packages/server/src/http.ts");
  const isPathname = (node: ts.Expression): boolean => /pathname$/.test(node.getText(file));
  walk(file, (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    ) {
      if (isPathname(node.left) && ts.isStringLiteral(node.right)) routes.add(node.right.text);
      if (isPathname(node.right) && ts.isStringLiteral(node.left)) routes.add(node.left.text);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "startsWith" &&
      isPathname(node.expression.expression) &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      routes.add(node.arguments[0].text);
      return;
    }
    if (!ts.isRegularExpressionLiteral(node)) return;
    // `/^\/api\/containers\/([^/]+)$/` → `/api/containers/:id`: the SHAPE is the route, and naming the
    // captures `:id` keeps the allowlist readable instead of a wall of escapes.
    const source = node.text.replace(/^\/|\/[a-z]*$/g, "");
    if (!source.startsWith("^\\/api")) return;
    routes.add(
      source
        .replace(/^\^/, "")
        .replace(/\$$/, "")
        .replace(/\\\//g, "/")
        .replace(/\(\[\^\/\]\+\)/g, ":id"),
    );
  });
  // The action door is the one route whose capture is a NAME rather than an id.
  if (routes.delete("/api/actions/:id")) routes.add("/api/actions/:name");
  const added = [...routes].filter((route) => !ROUTE_ALLOWLIST.includes(route)).sort();
  const gone = ROUTE_ALLOWLIST.filter((route) => !routes.has(route)).sort();
  check(
    "S7 route allowlist",
    added.length === 0 && gone.length === 0,
    added.length === 0 && gone.length === 0
      ? `${String(routes.size)} HTTP routes, exactly the allowlist`
      : `unlisted: ${list(added)}; listed but absent: ${list(gone)}`,
  );
}

// ─────────────────────────────────────────────────────────── S8: element vocabulary

{
  /** What the ENGINE renders itself (`FLOOR_NODE_TYPES`, canvas-view.tsx). */
  const FLOOR_ELEMENT_KINDS: Readonly<Record<string, true>> = { portal: true, text: true };
  const wireTypes = SceneElementSchema.options.map((option) => String(option.shape.type.value));
  const stray = wireTypes.filter(
    (type) => FLOOR_ELEMENT_KINDS[type] !== true && !elementTypes.has(type),
  );
  check(
    "S8 element vocabulary",
    stray.length === 0,
    stray.length === 0
      ? `${list(wireTypes)} ⊆ floor {${list(Object.keys(FLOOR_ELEMENT_KINDS))}} ∪ composed {${list(elementTypes)}}`
      : `wire element types nobody owns: ${list(stray)}`,
  );
}

/** `z.literal("…")` / `z.enum([...])` arguments: the closed wire vocabularies. */
function isVocabularyArgument(node: ts.StringLiteralLike): boolean {
  const call =
    node.parent.kind === ts.SyntaxKind.ArrayLiteralExpression ? node.parent.parent : node.parent;
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return false;
  const method = call.expression.name.text;
  return method === "literal" || method === "enum";
}

/** `className="…"` and `data-*="…"`, in JSX and in `{ className: "…" }` alike. */
function isMarkupValue(node: ts.StringLiteralLike): boolean {
  const parent = node.parent;
  if (ts.isJsxAttribute(parent)) {
    const name = parent.name.getText(parent.getSourceFile());
    return name === "className" || name.startsWith("data-");
  }
  if (
    ts.isJsxExpression(parent) &&
    parent.parent !== undefined &&
    ts.isJsxAttribute(parent.parent)
  ) {
    const name = parent.parent.name.getText(parent.getSourceFile());
    return name === "className" || name.startsWith("data-");
  }
  return false;
}

// ─────────────────────────────────────────────── S11: the lexicon, S12: one label vocabulary

/**
 * ONE WORD PER CONCEPT, ONE CONCEPT PER WORD (AGENTS invariant 15).
 *
 * Vocabulary is a TOKEN property, which is why this check reads tokens instead of following
 * edges the way S2 must: a banned synonym is banned wherever it appears, with no context that
 * redeems it except a declared `allow` row. So a scanner over words is not an approximation
 * of the rule — it IS the rule, and the registry in `AXIOMS.md` §Lexicon is its statute.
 *
 * SUBJECTS ARE NARROW, deliberately: identifiers, the four literal classes S4/S7 already
 * isolate (property keys, `z.literal`/`z.enum` arguments, `className`/`data-*` values, `/api/`
 * paths), CSS selector tokens, Markdown ATX headings, and file and directory names. Plain
 * string literals and comment bodies are NOT subjects. That boundary is what keeps the
 * allowlist from rotting into a blanket: live migration code necessarily writes `ALTER TABLE
 * pads` as SQL text and the generated changelog quotes a released `widget`, and licensing
 * those through an exemption would license the same words in an identifier beside them.
 */
interface LexiconAllow {
  readonly kind: "exactIdent" | "importSpecifier" | "declaration" | "glob";
  readonly idents: readonly string[];
  readonly specifier: string;
  readonly declaration: { readonly file: string; readonly name: string } | null;
  readonly glob: string;
  readonly why: string;
  /** Liveness: an exemption that stops being needed stops being permitted. */
  suppressed: number;
}

interface LexiconRow {
  readonly term: string;
  readonly means: string;
  readonly banned: readonly string[];
  readonly allow: readonly LexiconAllow[];
}

function lexiconAllow(raw: unknown): LexiconAllow | null {
  if (raw === null || typeof raw !== "object") return null;
  const why = "why" in raw && typeof raw.why === "string" ? raw.why : "";
  if (why === "") return null;
  const base = {
    idents: [] as string[],
    specifier: "",
    declaration: null,
    glob: "",
    why,
    suppressed: 0,
  };
  const exact: unknown = Reflect.get(raw, "exactIdent");
  if (Array.isArray(exact)) {
    return { ...base, kind: "exactIdent", idents: exact.map((name) => String(name)) };
  }
  const specifier: unknown = Reflect.get(raw, "importSpecifier");
  if (typeof specifier === "string") return { ...base, kind: "importSpecifier", specifier };
  const declaration: unknown = Reflect.get(raw, "declaration");
  if (declaration !== null && typeof declaration === "object") {
    const file: unknown = Reflect.get(declaration, "file");
    const name: unknown = Reflect.get(declaration, "name");
    if (typeof file === "string" && typeof name === "string") {
      return { ...base, kind: "declaration", declaration: { file, name } };
    }
  }
  const glob: unknown = Reflect.get(raw, "glob");
  if (typeof glob === "string") return { ...base, kind: "glob", glob };
  return null;
}

function lexiconRegistry(): readonly LexiconRow[] {
  const text = readFileSync(join(repoRoot, "AXIOMS.md"), "utf8");
  const rows: LexiconRow[] = [];
  const fence = /```json\n([\s\S]*?)\n```/g;
  for (;;) {
    const block = fence.exec(text);
    if (block === null) break;
    const parsedBlock: unknown = JSON.parse(block[1] ?? "");
    if (parsedBlock === null || typeof parsedBlock !== "object") continue;
    if (!("lexicon" in parsedBlock) || !Array.isArray(parsedBlock.lexicon)) continue;
    for (const raw of parsedBlock.lexicon) {
      if (raw === null || typeof raw !== "object") continue;
      const term: unknown = Reflect.get(raw, "term");
      const means: unknown = Reflect.get(raw, "means");
      if (typeof term !== "string" || term === "" || typeof means !== "string" || means === "") {
        continue;
      }
      const banned: unknown = Reflect.get(raw, "banned");
      const allow: unknown = Reflect.get(raw, "allow");
      rows.push({
        term,
        means,
        banned: Array.isArray(banned) ? banned.map((word) => String(word).toLowerCase()) : [],
        allow: (Array.isArray(allow) ? allow : [])
          .map(lexiconAllow)
          .filter((row): row is LexiconAllow => row !== null),
      });
    }
  }
  if (rows.length === 0) throw new Error("AXIOMS.md carries no fenced `lexicon` registry");
  return rows;
}

/**
 * Word-level, never substring: `padding` is one word and survives, `padStart` is two and is
 * caught (then exempted by name). Trailing digits split so a `pad1` fixture cannot hide.
 */
const LEXICON_WORD = /[A-Z]+(?![a-z])|[A-Z][a-z]*|[a-z]+|[0-9]+/g;
function lexiconWords(subject: string): readonly string[] {
  return (subject.match(LEXICON_WORD) ?? []).map((word) => word.toLowerCase());
}

/** Vendor CSS is recognized by prefix rather than by exemption — C16's distinction, mechanized. */
const VENDOR_SELECTOR = /^(react-flow__|xterm)/;

interface LexiconSubject {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  /** The declaration this subject sits inside, for the `declaration` allow selector. */
  readonly declaration: string;
}

function scanTree(dir: string, out: string[]): void {
  for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) scanTree(path, out);
    else out.push(path);
  }
}

{
  const lexicon = lexiconRegistry();
  const bannedBy = new Map<string, string>();
  const contradictions: string[] = [];
  for (const row of lexicon) {
    for (const word of row.banned) bannedBy.set(word, row.term);
  }
  for (const row of lexicon) {
    if (bannedBy.has(row.term.toLowerCase())) contradictions.push(row.term);
  }

  const files: string[] = [];
  for (const root of ["packages", "scripts"]) scanTree(root, files);
  const docs: string[] = [];
  scanTree("docs", docs);
  for (const doc of [...docs, "AXIOMS.md", "AGENTS.md", "CHANGELOG.md", "README.md"]) {
    if (doc.endsWith(".md")) files.push(doc);
  }

  const subjects: LexiconSubject[] = [];
  const termsSeen = new Set<string>();
  const noteTerms = (text: string): void => {
    for (const word of lexiconWords(text)) termsSeen.add(word);
  };

  for (const path of files) {
    // FILE AND DIRECTORY NAMES are subjects: `pad-browser.tsx` is a claim about the concept.
    for (const segment of path.split("/")) {
      subjects.push({ path, line: 0, text: segment.replace(/\.[a-z]+$/, ""), declaration: "" });
    }
    if (path.endsWith(".css")) {
      const text = readFileSync(join(repoRoot, path), "utf8");
      const lines = text.split("\n");
      lines.forEach((lineText, index) => {
        for (const hit of lineText.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
          const selector = hit[1] ?? "";
          if (VENDOR_SELECTOR.test(selector)) continue;
          subjects.push({ path, line: index + 1, text: selector, declaration: "" });
        }
      });
      noteTerms(text);
      continue;
    }
    if (path.endsWith(".md")) {
      const text = readFileSync(join(repoRoot, path), "utf8");
      text.split("\n").forEach((lineText, index) => {
        const heading = /^#{1,6}\s+(.*)$/.exec(lineText);
        if (heading !== null) {
          subjects.push({ path, line: index + 1, text: heading[1] ?? "", declaration: "" });
        }
      });
      noteTerms(text);
      continue;
    }
    if (!SOURCE.test(path)) continue;
    const file = parsed(path);
    noteTerms(file.getFullText());
    let declaration = "";
    const enclosing: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        enclosing.push(node.name.text);
        declaration = node.name.text;
      }
      if (ts.isIdentifier(node)) {
        subjects.push({ path, line: lineOf(file, node), text: node.text, declaration });
      } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const parent = node.parent;
        const classified =
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          isVocabularyArgument(node) ||
          isMarkupValue(node) ||
          node.text.startsWith("/api/");
        if (classified) {
          subjects.push({ path, line: lineOf(file, node), text: node.text, declaration });
        }
      }
      ts.forEachChild(node, visit);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        enclosing.pop();
        declaration = enclosing[enclosing.length - 1] ?? "";
      }
    };
    visit(file);
  }

  const globCache = new Map<string, ReadonlySet<string>>();
  const globMatches = (glob: string): ReadonlySet<string> => {
    const cached = globCache.get(glob);
    if (cached !== undefined) return cached;
    const matched = new Set<string>();
    for (const hit of new Bun.Glob(glob).scanSync({ cwd: repoRoot, onlyFiles: true })) {
      matched.add(hit.split("\\").join("/"));
    }
    globCache.set(glob, matched);
    return matched;
  };
  const importsCache = new Map<string, ReadonlySet<string>>();
  const importsOf = (path: string): ReadonlySet<string> => {
    const cached = importsCache.get(path);
    if (cached !== undefined) return cached;
    const names = new Set(moduleSpecifiers(path).map((entry) => entry.text));
    importsCache.set(path, names);
    return names;
  };

  const violations: string[] = [];
  for (const subject of subjects) {
    for (const word of lexiconWords(subject.text)) {
      const term = bannedBy.get(word);
      if (term === undefined) continue;
      const row = lexicon.find((candidate) => candidate.term === term);
      const exemption = row?.allow.find((allow) => {
        if (allow.kind === "exactIdent") return allow.idents.includes(subject.text);
        if (allow.kind === "importSpecifier") {
          return SOURCE.test(subject.path) && importsOf(subject.path).has(allow.specifier);
        }
        if (allow.kind === "declaration") {
          return (
            subject.path === allow.declaration?.file &&
            subject.declaration === allow.declaration.name
          );
        }
        return globMatches(allow.glob).has(subject.path);
      });
      if (exemption !== undefined) {
        exemption.suppressed += 1;
        continue;
      }
      violations.push(
        `${subject.path}:${String(subject.line)} ${subject.text} — "${word}" is banned; use "${term}"`,
      );
    }
  }

  const stale = lexicon.flatMap((row) =>
    row.allow
      .filter((allow) => allow.suppressed === 0)
      .map(
        (allow) =>
          `${row.term}/${allow.kind}:${allow.idents.join(",")}${allow.glob}${allow.specifier}${allow.declaration?.name ?? ""}`,
      ),
  );
  const unused = lexicon
    .map((row) => row.term)
    .filter((term) => !lexiconWords(term).every((word) => termsSeen.has(word)));

  check(
    "S11 lexicon",
    violations.length === 0,
    violations.length === 0
      ? `${String(subjects.length)} subjects across ${String(files.length)} files carry none of the ${String(bannedBy.size)} banned words`
      : `${String(violations.length)} banned words: ${violations.slice(0, 20).join(" | ")}`,
  );
  check(
    "S11 lexicon allow liveness",
    stale.length === 0,
    stale.length === 0
      ? `every allow row suppresses a real occurrence`
      : `allow rows suppressing nothing — delete them: ${list(stale)}`,
  );
  check(
    "S11 lexicon totality",
    unused.length === 0 && contradictions.length === 0,
    unused.length === 0 && contradictions.length === 0
      ? `${String(lexicon.length)} terms, each live in the tree and none in another row's banned set`
      : `terms nobody uses: ${list(unused)}; terms banned by another row: ${list(contradictions)}`,
  );
}

/**
 * ONE LABEL VOCABULARY (§0's three disagreeing tables, made structurally impossible).
 *
 * `ITEM_NOUNS` is the only map in the tree from an item kind to a display noun. Its keys must
 * be exactly `ITEM_KINDS`, each value must be the key's own canonical word, and no SECOND
 * kind→word table may exist: any other object literal keyed by three or more item kinds whose
 * values are all string literals is a rival vocabulary, which is how `pad: "view"` and
 * `pad: "canvas"` and `"canvas-pad": "A canvas"` came to ship in one build.
 */
{
  const kinds = Object.keys(ITEM_KINDS).sort();
  const nouns = Object.keys(ITEM_NOUNS).sort();
  const misnamed = Object.entries(ITEM_NOUNS).filter(([kind, noun]) => noun !== kind);
  check(
    "S12 one label vocabulary",
    nouns.join() === kinds.join() && misnamed.length === 0,
    nouns.join() === kinds.join() && misnamed.length === 0
      ? `ITEM_NOUNS names exactly ${list(kinds)}, each by its own canonical word`
      : `keys ${list(nouns)} ≠ ITEM_KINDS ${list(kinds)}; off-canon values: ${list(misnamed.map(([kind, noun]) => `${kind}→${noun}`))}`,
  );

  const kindSet = new Set<string>([...kinds, ...elementTypes]);
  const rivals: string[] = [];
  const sources: string[] = [];
  for (const root of ["packages", "scripts"]) scanTree(root, sources);
  for (const path of sources) {
    /*
      The protocol is the ALGEBRA's home, and its kind→op tables (`CANVAS_OPS`) are wire
      vocabulary rather than words a person reads — mapping a kind to `"portal"` is a rule,
      not a label. Display tables live above the wire, which is exactly where the three that
      disagreed lived, so that is where this looks.
    */
    if (!SOURCE.test(path) || path.startsWith("packages/protocol/src/")) continue;
    if (path === "packages/plugin/src/item-noun.ts") continue;
    const file = parsed(path);
    walk(file, (node) => {
      if (!ts.isObjectLiteralExpression(node) || node.properties.length < 3) return;
      const entries = node.properties.filter(ts.isPropertyAssignment);
      if (entries.length !== node.properties.length) return;
      const keys = entries.map((entry) =>
        ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name) ? entry.name.text : "",
      );
      if (!keys.every((key) => kindSet.has(key))) return;
      if (!entries.every((entry) => ts.isStringLiteral(entry.initializer))) return;
      rivals.push(`${path}:${String(lineOf(file, node))}`);
    });
  }
  check(
    "S12 no rival label table",
    rivals.length === 0,
    rivals.length === 0
      ? `no second kind→noun map beside ITEM_NOUNS`
      : `rival label vocabularies: ${list(rivals)}`,
  );
}

// ═══════════════════════════════════════════════════════════ the browser half

const { distDir, cleanup: cleanupDist } = resolveWebDist("manifold-axi-");
const dataDir = mkdtempSync(join(tmpdir(), "manifold-axi-data-"));

const server = Bun.spawn(["bun", "packages/server/src/main.ts"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    // Ephemeral: the origin comes back on the ready line, so two gates never race a port.
    MANIFOLD_PORT: "0",
    MANIFOLD_DATA_DIR: dataDir,
    MANIFOLD_WEB_DIST: distDir,
    MANIFOLD_SPAWN_AGENT: "1",
  },
  // Piped, never echoed: the boot line carries the owner key (secrets discipline, AGENTS
  // invariant 6). The stream is read for the origin and for the one-line-per-dispatch action
  // log, which is how R4 counts a gesture's commits exactly rather than approximately.
  stdout: "pipe",
  stderr: "inherit",
});

interface ActionLogLine {
  readonly name: string;
  readonly outcome: string;
}

const actionLog: ActionLogLine[] = [];
let origin = "";

/** Reads the server's JSONL forever: the ready URL once, then every action it dispatches. */
async function consumeServerLog(): Promise<void> {
  const reader = server.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffered += decoder.decode(chunk.value, { stream: true });
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const readyUrl = /manifold ready url=(https?:\/\/[^\s"']+)/.exec(line)?.[1];
      if (readyUrl !== undefined && origin === "") origin = new URL(readyUrl).origin;
      if (!line.startsWith("{")) continue;
      try {
        const record: unknown = JSON.parse(line);
        if (Reflect.get(record as object, "evt") !== "action") continue;
        actionLog.push({
          name: String(Reflect.get(record as object, "name")),
          outcome: String(Reflect.get(record as object, "outcome")),
        });
      } catch {
        // A non-JSON line is boot chrome; the gate cares only about the structured stream.
      }
    }
  }
}

async function stopServer(): Promise<void> {
  if (server.exitCode === null) server.kill("SIGTERM");
  const stopped = await Promise.race([
    server.exited.then(() => true),
    Bun.sleep(5_000).then(() => false),
  ]);
  if (!stopped && server.exitCode === null) server.kill("SIGKILL");
  await server.exited;
}

function debugPortIsAvailable(port: number): boolean {
  try {
    const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    probe.stop(true);
    return true;
  } catch {
    return false;
  }
}

function availableDebugPort(): number {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    // Clear of every other gate's band (9340-9378 fixed, 9400-10000 for convergence's pair).
    const candidate = 10_100 + Math.floor(Math.random() * 300);
    if (debugPortIsAvailable(candidate)) return candidate;
  }
  throw new Error("could not find an available Chromium debug port");
}

let browser: Browser | null = null;
let canvasClient: SessionClient | null = null;
let terminalClient: SessionClient | null = null;
/** Plugins this run switched off, so the finally can put the workspace back as it found it. */
const disabledHere = new Set<string>();

try {
  void consumeServerLog().catch(() => {
    // The stream ends when the server does; a torn read is not a gate result.
  });
  await until(() => origin !== "", 30_000, "server ready line");
  await until(
    async () => {
      try {
        return (await fetch(`${origin}/healthz`)).ok;
      } catch {
        return false;
      }
    },
    20_000,
    "local server healthz",
  );

  const ownerKey = (await Bun.file(join(dataDir, "owner.key")).text()).trim();

  const getJson = async (path: string, token = ownerKey): Promise<unknown> =>
    await (
      await fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${token}` } })
    ).json();

  const dispatch = async (name: string, args: unknown, token = ownerKey): Promise<unknown> =>
    await (
      await fetch(`${origin}/api/actions/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(args),
      })
    ).json();

  /** Mints a grant through the access door, which is where minting lives now. */
  const mint = async (request: unknown): Promise<TokenGrant> => {
    const outcome = ActionOutcomeSchema.parse(await dispatch("core.access.mint", request));
    if (!outcome.ok) throw new Error(`mint refused: ${outcome.denial.message}`);
    return TokenGrantSchema.parse(outcome.result);
  };

  const setEnabled = async (id: string, enabled: boolean): Promise<boolean> => {
    const outcome = ActionOutcomeSchema.parse(
      await dispatch(ENGINE_SET_ENABLED_ACTION, { id, enabled }),
    );
    if (outcome.ok) {
      if (enabled) disabledHere.delete(id);
      else disabledHere.add(id);
    }
    return outcome.ok;
  };

  // ─────────────────────────────────────────── R1: the published vocabulary

  {
    /*
      The published document, parsed with the protocol's OWN schemas rather than trusted.
      `ActionSummarySchema` requires `input` and `result` to be JSON Schema objects, which is
      half of R1's claim: a stranger's agent learns every door's argument shape from this
      document or from nowhere.
    */
    const document: unknown = await getJson("/api/protocol");
    if (document === null || typeof document !== "object") {
      throw new Error("GET /api/protocol answered no document");
    }
    const summaries = ActionSummarySchema.array().parse(Reflect.get(document, "actions"));
    const advertised = PluginRosterSchema.parse(Reflect.get(document, "plugins"));
    const published = new Set(summaries.map((action) => action.name));
    const rosterIds = new Set(advertised.map((entry) => entry.manifest.id));
    const sameActions =
      published.size === actionNames.size && [...actionNames].every((name) => published.has(name));
    const samePlugins =
      rosterIds.size === pluginIds.size && [...pluginIds].every((id) => rosterIds.has(id));
    check(
      "R1 /api/protocol vocabulary",
      sameActions && samePlugins,
      sameActions && samePlugins
        ? `${String(published.size)} actions and ${String(rosterIds.size)} plugins, with schemas`
        : `actions ${list(published)} / plugins ${list(rosterIds)}`,
    );

    const roster = PluginsResponseSchema.parse(await getJson("/api/plugins")).plugins;
    const doorIds = new Set(roster.map((entry) => entry.manifest.id));
    check(
      "R1 /api/plugins roster",
      doorIds.size === pluginIds.size && [...pluginIds].every((id) => doorIds.has(id)),
      `${String(roster.length)} roster entries: ${list(doorIds)}`,
    );
  }

  // ─────────────────────────────────────────── world setup

  const createdCanvas = ActionOutcomeSchema.parse(
    await dispatch("core.index.createContainer", { name: "axiom-gate" }),
  );
  if (!createdCanvas.ok)
    throw new Error(`createContainer refused: ${createdCanvas.denial.message}`);
  const canvasContainerId = ContainerResponseSchema.parse(createdCanvas.result).container.id;

  let machineId = "";
  await until(
    async () => {
      const listed = ActionOutcomeSchema.parse(await dispatch("core.machines.list", {}));
      if (!listed.ok) throw new Error(`machines list refused: ${listed.denial.message}`);
      const { machines } = MachinesResponseSchema.parse(listed.result);
      machineId = machines.find((machine) => machine.online)?.id ?? "";
      return machineId !== "";
    },
    30_000,
    "local agent online",
  );

  const wsUrl = `${origin.replace(/^http/, "ws")}/ws/session`;
  canvasClient = new SessionClient({ url: wsUrl, containerId: canvasContainerId, token: ownerKey });
  await canvasClient.connect();

  const terminal = await canvasClient.openTerminal({
    elementId: crypto.randomUUID(),
    cols: 80,
    rows: 24,
    machineId,
  });
  const terminalContainerId = terminal.containerId;
  terminalClient = new SessionClient({
    url: wsUrl,
    containerId: terminalContainerId,
    token: ownerKey,
  });
  await terminalClient.connect();

  /** A stroke authored BEFORE any toggle, so R3 can watch it become a placeholder and return. */
  const strokeId = crypto.randomUUID();
  canvasClient.transact((tx) => {
    tx.create({
      id: strokeId,
      type: "draw",
      x: 120,
      y: 120,
      width: 240,
      height: 180,
      zIndex: 1,
      points: [0, 0, 40, 60, 120, 30, 200, 140],
      strokeWidth: 3,
      color: "#e03131",
    });
  });

  // ─────────────────────────────────────────── the browser

  browser = new Browser();
  await browser.launch(availableDebugPort());
  await browser.goto(`${origin}/#key=${ownerKey}`);
  await browser.evaluate("localStorage.setItem('manifold:debug', '1')");
  if (await browser.evaluate<boolean>("document.querySelector('input') !== null")) {
    await browser.typeInto("input", "axiom-gate");
    await browser.clickText("Enter manifold");
  }
  await browser.goto(`${origin}/p/${terminalContainerId}`);
  /** Only the id: the stored grant carries this device's TOKEN and must never leave the page. */
  const viewerPrincipalId = await browser.evaluate<string>(
    `JSON.parse(localStorage.getItem('manifold.identity')).principal.id`,
  );

  // ─────────────────────────────────────────── R2: parity, both directions

  await until(
    () => browser!.evaluate<boolean>("document.querySelectorAll('.composition-leaf').length === 1"),
    20_000,
    "terminal's composition mounted",
  );

  const titleText = (): Promise<string> =>
    browser!.evaluate<string>(
      `document.querySelector('.composition-leaf .node-titlebar__title')?.textContent ?? ''`,
    );

  {
    const renamed = ActionOutcomeSchema.parse(
      await dispatch("core.terminals.rename", { terminalId: terminal.id, name: "sdk-named" }),
    );
    const landed = await settles(async () => (await titleText()).includes("sdk-named"), 10_000);
    check(
      "R2 SDK → DOM",
      renamed.ok && landed,
      renamed.ok
        ? `titlebar reads "${await titleText()}" with no reload`
        : "the rename action was denied",
    );
  }

  {
    // The browser's own affordance: double-click the title, type, commit. The input carries
    // `data-action="core.terminals.rename"`, so this is the SAME door the SDK just used.
    await browser.evaluate(
      `(() => {
        const title = document.querySelector('.composition-leaf .node-titlebar__title');
        title?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return null;
      })()`,
    );
    const editing = await settles(
      () =>
        browser!.evaluate<boolean>(
          `document.querySelector('.composition-leaf [data-action="core.terminals.rename"]') !== null`,
        ),
      5_000,
    );
    if (editing) {
      // The draft arrives pre-selected, so typing REPLACES it; the commit is a real Enter,
      // which a bare `text: "\r"` never produces — React reads `event.key`, and only a key
      // event carrying the name "Enter" is the gesture a person makes.
      await browser.evaluate(
        `(() => {
          const input = document.querySelector('.composition-leaf [data-action="core.terminals.rename"]');
          input.focus();
          input.select();
          return null;
        })()`,
      );
      await browser.typeText("dom-named");
      for (const type of ["keyDown", "keyUp"] as const) {
        await browser.send("Input.dispatchKeyEvent", {
          type,
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          text: "\r",
        });
      }
    }
    const observed = await settles(
      () => terminalClient?.terminals.get(terminal.id)?.name === "dom-named",
      10_000,
    );
    check(
      "R2 DOM → SDK",
      editing && observed,
      editing
        ? `the SDK observes "${terminalClient.terminals.get(terminal.id)?.name ?? "nothing"}"`
        : "the rename affordance never opened",
    );
  }

  // ─────────────────────────────────────────── R5: view presence and spotlight

  await browser.goto(`${origin}/p/${canvasContainerId}`);
  await until(
    () => browser!.evaluate<boolean>("window.__manifold !== undefined"),
    20_000,
    "canvas probe installed",
  );
  await until(
    () =>
      browser!.evaluate<boolean>(`document.querySelector('[data-testid="toolbar-draw"]') !== null`),
    20_000,
    "draw tool present",
  );

  {
    await browser.evaluate(`document.querySelector('[data-testid="toolbar-draw"]').click(), null`);
    const seen = await settles(
      () => canvasClient?.attendance.get(viewerPrincipalId)?.payload.vantage?.tool === "draw",
      3_000,
    );
    check(
      "R5 view presence",
      seen,
      seen
        ? "an SDK peer reads view.tool === draw within 2s of the pick"
        : "the picked tool never reached the peer's presence",
    );
    // Back to select: a held draw tool turns later pointer work into ink.
    await browser.evaluate(
      `document.querySelector('[data-testid="toolbar-select"]').click(), null`,
    );
  }

  {
    const uri = formatManifoldUri({
      kind: "element",
      containerId: canvasContainerId,
      elementId: strokeId,
    });
    const outcome = ActionOutcomeSchema.parse(
      await dispatch("core.presence.focus", { targetPrincipalId: viewerPrincipalId, uri }),
    );
    const applied = await settles(
      async () =>
        (await browser!.evaluate<string | null>("window.__manifold.lastSpotlight()")) === uri,
      8_000,
    );
    check(
      "R5 spotlight lands",
      outcome.ok && applied,
      outcome.ok
        ? applied
          ? "the target's viewport centered on the named node"
          : "the action succeeded but no client applied it"
        : `focus was denied: ${outcome.ok ? "" : outcome.denial.message}`,
    );

    const scoped = await mint({
      principal: { name: "axiom-scoped", kind: "agent" },
      caps: ["containers:read", "containers:write", "scenes:write"],
      containerId: canvasContainerId,
    });
    const refusedScoped = ActionOutcomeSchema.parse(
      await dispatch(
        "core.presence.focus",
        { targetPrincipalId: viewerPrincipalId, uri },
        scoped.token,
      ),
    );
    const forbidden =
      !refusedScoped.ok &&
      refusedScoped.denial.rule === "forbidden" &&
      refusedScoped.denial.message.includes("scoped tokens");
    check(
      "R5 scoped focus refused",
      forbidden,
      refusedScoped.ok ? "a container-scoped token drove a viewport" : refusedScoped.denial.message,
    );

    // ───────────────────────── R8: the denial ladder, end to end
    const unknown = ActionOutcomeSchema.parse(await dispatch("core.nope.doThing", {}));
    const badArgs = ActionOutcomeSchema.parse(
      await dispatch("core.terminals.rename", { terminalId: terminal.id }),
    );
    const scopedManage = ActionOutcomeSchema.parse(
      await dispatch(ENGINE_SET_ENABLED_ACTION, { id: "core.draw", enabled: false }, scoped.token),
    );
    const essential = ActionOutcomeSchema.parse(
      await dispatch(ENGINE_SET_ENABLED_ACTION, { id: "core.shell", enabled: false }),
    );
    const rungs: readonly (readonly [string, boolean, string])[] = [
      [
        "unknown_action",
        !unknown.ok && unknown.denial.rule === "unknown_action",
        unknown.ok ? "accepted" : unknown.denial.rule,
      ],
      [
        "invalid_args",
        !badArgs.ok && badArgs.denial.rule === "invalid_args",
        badArgs.ok ? "accepted" : badArgs.denial.rule,
      ],
      [
        "forbidden (container scope)",
        !scopedManage.ok &&
          scopedManage.denial.rule === "forbidden" &&
          scopedManage.denial.message.includes("scoped tokens cannot invoke workspace actions"),
        scopedManage.ok ? "accepted" : scopedManage.denial.message,
      ],
      [
        "refused (essential)",
        !essential.ok &&
          essential.denial.rule === "refused" &&
          essential.denial.message === "essential",
        essential.ok ? "accepted" : `${essential.denial.rule}/${essential.denial.message}`,
      ],
    ];
    const broken = rungs.filter(([, ok]) => !ok);
    check(
      "R8 denial ladder",
      broken.length === 0,
      broken.length === 0
        ? "unknown_action, invalid_args, forbidden(scope), refused(essential)"
        : list(broken.map(([rung, , saw]) => `${rung} answered ${saw}`)),
    );
  }

  // ─────────────────────────────────────────── R4: the shell is a composition

  {
    /*
      A layout is PER PRINCIPAL, and the browser is not the owner: it minted its own identity
      at the gate. So the tree this drag edits is read with a token bound to that principal —
      asking as the owner would answer a different workspace and call the drag a no-op.
    */
    const viewer = await mint({
      principalId: viewerPrincipalId,
      caps: ["containers:read", "containers:write", "scenes:write"],
    });
    const before = LayoutResponseSchema.parse(await getJson("/api/layout", viewer.token)).layout;
    const panelLeaves = Object.values(before).filter(
      (node) => node.ref !== null && node.ref.kind === "panel",
    );
    check(
      "R4 workspace panel leaves",
      panelLeaves.length >= 2,
      `${String(panelLeaves.length)} panel leaves in the caller's tree`,
    );

    const divider = await browser.evaluate<{ x: number; y: number } | null>(
      `(() => {
        const seam = document.querySelector('.workspace-divider');
        if (seam === null) return null;
        const box = seam.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      })()`,
    );
    const commitsBefore = actionLog.filter((entry) => entry.name === "core.space.setLayout").length;
    if (divider !== null) {
      const steps = Array.from({ length: 12 }, (_unused, index) => ({
        x: divider.x + 10 * (index + 1),
        y: divider.y,
      }));
      await browser.drag([divider, ...steps], 20);
    }
    // The commit is a trailing debounce on the LAST frame, so the read waits for it to land.
    const moved = await settles(async () => {
      const now = LayoutResponseSchema.parse(await getJson("/api/layout", viewer.token)).layout;
      return JSON.stringify(now["root"]?.ratios) !== JSON.stringify(before["root"]?.ratios);
    }, 8_000);
    await sleep(1_500);
    const commits =
      actionLog.filter((entry) => entry.name === "core.space.setLayout").length - commitsBefore;
    check(
      "R4 divider drag commits once",
      divider !== null && moved && commits === 1,
      divider === null
        ? "no workspace divider in the DOM"
        : `ratios ${moved ? "changed" : "unchanged"} after ${String(commits)} core.space.setLayout dispatch(es)`,
    );

    const other = await mint({
      principal: { name: "axiom-bystander", kind: "human" },
      caps: ["containers:read"],
    });
    const bystander = LayoutResponseSchema.parse(await getJson("/api/layout", other.token)).layout;
    const untouched =
      JSON.stringify(bystander["root"]?.ratios) ===
      JSON.stringify(DEFAULT_WORKSPACE_LAYOUT["root"]?.ratios);
    check(
      "R4 layouts are per principal",
      untouched,
      untouched
        ? "a second principal still reads the default tree"
        : "one principal's drag moved another's workspace",
    );
  }

  // ─────────────────────────────────────────── R7: every marker names an action

  {
    const roster = PluginsResponseSchema.parse(await getJson("/api/plugins")).plugins;
    const live = new Set(roster.flatMap((entry) => entry.actions.map((action) => action.name)));
    const marked = await browser.evaluate<readonly string[]>(
      `Array.from(document.querySelectorAll('[data-action]'), (node) => node.getAttribute('data-action'))`,
    );
    const strays = [...new Set(marked)].filter((name) => !live.has(name));
    check(
      "R7 DOM markers ⊆ roster",
      strays.length === 0,
      strays.length === 0
        ? `${String(marked.length)} marked affordances on the page, all in the roster`
        : `markers naming nothing: ${list(strays)}`,
    );
  }

  // ─────────────────────────────────────────── R6: addressing

  {
    const containerUri = formatManifoldUri({ kind: "container", containerId: canvasContainerId });
    const terminalUri = formatManifoldUri({ kind: "terminal", terminalId: terminal.id });
    const containerResolved = ResolveResponseSchema.parse(
      await getJson(`/api/resolve?uri=${encodeURIComponent(containerUri)}`),
    );
    const terminalResolved = ResolveResponseSchema.parse(
      await getJson(`/api/resolve?uri=${encodeURIComponent(terminalUri)}`),
    );
    check(
      "R6 /api/resolve round-trips",
      containerResolved.exists &&
        containerResolved.uri === containerUri &&
        terminalResolved.exists &&
        terminalResolved.uri === terminalUri,
      `container "${containerResolved.title ?? ""}" and terminal "${terminalResolved.title ?? ""}" both resolve`,
    );

    await browser.goto(`${origin}/uri/${encodeURIComponent(containerUri)}`);
    const landed = await settles(
      async () =>
        (await browser!.evaluate<string>("location.pathname")) === `/p/${canvasContainerId}`,
      10_000,
    );
    check(
      "R6 deep link navigates",
      landed,
      landed
        ? `/uri/<encoded> landed on /p/${canvasContainerId}`
        : `the deep link stopped at ${await browser.evaluate<string>("location.pathname")}`,
    );
  }

  // ─────────────────────────────────────────── R3: hot enable and disable

  await until(
    () => browser!.evaluate<boolean>(`document.querySelector('.react-flow') !== null`),
    20_000,
    "canvas mounted for the toggle round",
  );

  {
    const drawGone = await setEnabled("core.draw", false);
    const inert = await settles(async () => {
      const toolbar = await browser!.evaluate<boolean>(
        `document.querySelector('[data-testid="toolbar-draw"]') === null`,
      );
      const placeheld = await browser!.evaluate<boolean>(
        `document.querySelector('.react-flow__node .plugin-placeholder[data-plugin-state="disabled"]') !== null`,
      );
      return toolbar && placeheld;
    }, 10_000);
    check(
      "R3 core.draw off",
      drawGone && inert,
      inert
        ? "tool button gone and the existing stroke reads as a named placeholder, no reload"
        : "the canvas did not go inert",
    );

    const drawBack = await setEnabled("core.draw", true);
    const restored = await settles(async () => {
      const toolbar = await browser!.evaluate<boolean>(
        `document.querySelector('[data-testid="toolbar-draw"]') !== null`,
      );
      const painted = await browser!.evaluate<boolean>(
        `document.querySelector('.react-flow__node .plugin-placeholder') === null`,
      );
      return toolbar && painted;
    }, 10_000);
    check(
      "R3 core.draw back on",
      drawBack && restored,
      restored ? "tool and ink both return live" : "the canvas stayed inert after re-enabling",
    );
  }

  {
    const off = await setEnabled("core.machines", false);
    const inert = await settles(
      () =>
        browser!.evaluate<boolean>(
          `document.querySelector('[data-section-id="machines"] .plugin-placeholder[data-plugin-state="disabled"]') !== null`,
        ),
      10_000,
    );
    const on = await setEnabled("core.machines", true);
    const back = await settles(
      () =>
        browser!.evaluate<boolean>(
          `document.querySelector('[data-section-id="machines"] .plugin-placeholder') === null`,
        ),
      10_000,
    );
    check(
      "R3 core.machines section",
      off && inert && on && back,
      inert && back
        ? "the Machines section goes inert and returns without a reload"
        : `disabled: ${String(inert)}, restored: ${String(back)}`,
    );
  }

  {
    const off = await setEnabled("core.terminals", false);
    /*
      The refusal's SENTENCE rides the error frame, not the rejection: `openTerminal` rejects
      with the code alone, so the door's own words are read where the server put them.

      And they ARE the door's words now. `terminal_open` dispatches `core.terminals.open`
      before it touches the broker, so a disabled plugin refuses at rung 2 and the transport
      carries that denial back verbatim — the gateway no longer authors a sentence about
      terminals, which is the point of the verb going through the ladder.
    */
    const refusals: string[] = [];
    const offError = canvasClient.on("error", (frame) => {
      refusals.push(frame.message ?? frame.code);
    });
    let creationRefused = false;
    try {
      await canvasClient.openTerminal({
        elementId: crypto.randomUUID(),
        cols: 80,
        rows: 24,
        machineId,
      });
    } catch {
      creationRefused = true;
    }
    offError();
    const renameWhileOff = ActionOutcomeSchema.parse(
      await dispatch("core.terminals.rename", { terminalId: terminal.id, name: "nope" }),
    );
    const killWhileOff = ActionOutcomeSchema.parse(
      await dispatch("core.terminals.kill", { terminalId: terminal.id }),
    );
    const back = await setEnabled("core.terminals", true);
    check(
      "R3 core.terminals off (D12)",
      off &&
        creationRefused &&
        refusals.includes('plugin "core.terminals" is disabled') &&
        !renameWhileOff.ok &&
        renameWhileOff.denial.rule === "plugin_disabled" &&
        killWhileOff.ok &&
        back,
      `creation ${creationRefused ? `refused: "${list(refusals)}"` : "was allowed"}; rename ${renameWhileOff.ok ? "accepted" : renameWhileOff.denial.rule}; kill ${killWhileOff.ok ? "still works" : "refused"}`,
    );
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  /*
    Every toggle put back before the summary. The data dir here is a temp one, but the gate
    is also run by hand against a real workspace during development, and a check that leaves
    `core.draw` off is a check that broke the thing it was inspecting.
  */
  if (disabledHere.size > 0 && origin !== "") {
    const ownerKey = (await Bun.file(join(dataDir, "owner.key")).text()).trim();
    for (const id of disabledHere) {
      try {
        await fetch(`${origin}/api/actions/${ENGINE_SET_ENABLED_ACTION}`, {
          method: "POST",
          headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
          body: JSON.stringify({ id, enabled: true }),
        });
      } catch {
        // A restore that cannot reach the server is a server already gone; nothing to undo.
      }
    }
  }
  canvasClient?.close();
  terminalClient?.close();
  await browser?.close();
  await stopServer();
  rmSync(dataDir, { recursive: true, force: true });
  cleanupDist();
}

console.log(
  failures.length === 0
    ? "\naxioms gate: GREEN"
    : `\naxioms gate: RED\n${failures.map((failure) => ` - ${failure}`).join("\n")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
