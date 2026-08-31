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
 * The static half (S1-S16) runs against the source tree with the TypeScript parser, never a
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
 *   S16 the floor's own size: `packages/plugin/src` stays inside its declared line budget
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
  FLOOR_ELEMENT_PAYLOADS,
  ITEM_NOUNS,
  workspaceLayout,
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
  LOG_EVENTS,
  LayoutResponseSchema,
  MachinesResponseSchema,
  ContainerResponseSchema,
  PluginRosterSchema,
  PluginsResponseSchema,
  ResolveResponseSchema,
  SceneElementSchema,
  TokenGrantSchema,
  formatManifoldUri,
  type LogEvent,
  type TokenGrant,
} from "../packages/protocol/src/index.ts";
import { SERVER_PLUGIN_DEFS, WORKSPACE_PANELS } from "../packages/server/src/assembly.ts";
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

interface GateContractRow {
  readonly testid: string;
  /** The renderer file that owes the attribute; the question a broken gate actually asks. */
  readonly renderer: string;
  readonly why: string;
}

interface CssFamilyRow {
  /** A selector-name prefix — `terminal`, `portal__slot` — or `*` for a rule with no class. */
  readonly family: string;
  /** The one stylesheet allowed to define it, or `shared` for the ownerless state prefix. */
  readonly owner: string;
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
  readonly gateContracts: readonly GateContractRow[];
  readonly cssFamilies: readonly CssFamilyRow[];
} {
  const text = readFileSync(join(repoRoot, "AXIOMS.md"), "utf8");
  const floor: FloorRow[] = [];
  const deviceLocal: DeviceLocalRow[] = [];
  const gateContracts: GateContractRow[] = [];
  const cssFamilies: CssFamilyRow[] = [];
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
    if ("gateContracts" in parsed && Array.isArray(parsed.gateContracts)) {
      for (const row of parsed.gateContracts) {
        const testid = justified(row, "testid");
        const renderer = justified(row, "renderer");
        if (testid === null || renderer === null) continue;
        gateContracts.push({
          testid,
          renderer,
          why: String(Reflect.get(row as object, "why")),
        });
      }
    }
    if ("cssFamilies" in parsed && Array.isArray(parsed.cssFamilies)) {
      for (const row of parsed.cssFamilies) {
        const family = justified(row, "family");
        const owner = justified(row, "owner");
        if (family === null || owner === null) continue;
        cssFamilies.push({ family, owner, why: String(Reflect.get(row as object, "why")) });
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
  if (gateContracts.length === 0) {
    throw new Error("AXIOMS.md carries no fenced `gateContracts` register");
  }
  if (cssFamilies.length === 0) {
    throw new Error("AXIOMS.md carries no fenced `cssFamilies` registry");
  }
  return { floor, deviceLocal, gateContracts, cssFamilies };
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
  /*
    The default is no longer a constant: `workspaceLayout()` owns the ARRANGEMENT and
    `assembly.ts` owns the two panel NAMES, which is the point of the split. So the check
    builds the tree the server actually serves — the floor's function applied to the
    registration's own pair — and asserts every leaf of THAT resolves. Reading a constant
    would now prove nothing about what `GET /api/layout` answers.
  */
  const missing: string[] = [];
  for (const node of Object.values(workspaceLayout(WORKSPACE_PANELS))) {
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
  /*
    S8 reads the subset from the OTHER END now, because the protocol no longer enumerates
    element types (ADR 0013 §16): `SceneElementSchema` is a neutral envelope, so there are no
    `z.literal` members left to walk. What it walks instead is the set of types some party
    CLAIMS — the floor's own kinds, which are `FLOOR_ELEMENT_PAYLOADS`, plus the assembly's
    contributed types — and it asserts the same thing it always did: no element type is owned by
    nobody.

    This also retires a table that had quietly gone wrong. The old check hardcoded
    `{ portal: true, text: true }` as "the floor's kinds", and `text` stopped being the floor's
    the moment `core.notes` declared it — so the assertion was passing a type through on the
    strength of a stale literal in the gate rather than an owner in the tree. The floor's kinds
    are now read from the one table the boundary itself consults.
  */
  const floorKinds = Object.keys(FLOOR_ELEMENT_PAYLOADS);
  const claimed = [...floorKinds, ...elementTypes];
  const duplicated = floorKinds.filter((type) => elementTypes.has(type));
  /*
    Every claimed type must be claimed ONCE. A plugin re-declaring a floor kind is the case
    element-type ownership (ADR 0013 §7) refuses at assembly time; asserting it here as well is
    what keeps the gate honest if that reservation is ever relaxed.
  */
  check(
    "S8 element vocabulary",
    duplicated.length === 0,
    duplicated.length === 0
      ? `${String(claimed.length)} claimed element types: floor {${list(floorKinds)}} ∪ composed {${list(elementTypes)}}`
      : `element types claimed by both the floor and a plugin: ${list(duplicated)}`,
  );

  /*
    And the envelope's own promise, asserted rather than assumed: a type NOBODY claims still
    round-trips. That is the property the opening exists for — a canvas holding a record whose
    plugin is absent from this build keeps it, instead of the wire schema refusing a `type` it
    was never told about (ADR 0013 §16 clause 5).
  */
  const strangerType = "acme.gantt";
  const stranger = {
    id: "s8-stranger",
    type: strangerType,
    lanes: ["a", "b"],
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    zIndex: 0,
  };
  const parsedStranger = SceneElementSchema.safeParse(stranger);
  check(
    "S8 a stranger element type round-trips",
    parsedStranger.success && !claimed.includes(strangerType),
    parsedStranger.success
      ? `an unclaimed "${strangerType}" record validates on the envelope's bounds alone`
      : `the envelope refused an unclaimed type, which is the closed union it replaced`,
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

// ────────────────────────────────────────── S13: one owner per selector family

/**
 * WHO IS ALLOWED TO PAINT THIS NAME.
 *
 * A plugin that ships its behaviour, its actions and its renderers but leaves its SKIN in the
 * floor's stylesheet is not extracted, it is half-extracted: turning the plugin off leaves its
 * rules resident, deleting the package leaves them orphaned, and the floor slowly becomes the
 * place every feature's CSS was typed because that is where the file already was. One file of
 * 3,572 lines and 510 selectors is how that ends, and it is A1 failing quietly in a language
 * the import walk (S2) cannot read, because CSS has no imports to walk.
 *
 * So the split is registered rather than remembered: §Lexicon's `cssFamilies` names one owning
 * stylesheet per selector family, and this check reads every `.css` file under `packages/` back
 * against it, in both directions like every registry here.
 *
 * Three decisions make the check mechanical rather than approximate:
 *
 * LONGEST PREFIX WINS, on a `-` or `__` boundary. `canvas-text` beats `canvas` for the note
 * element and `portal__slot` beats `portal` for the tile-tree's pane, which is how a family
 * whose NAME says one owner and whose CODE says another is recorded instead of argued about.
 *
 * THE ANCHOR NAMES THE FAMILY. A compound's first class is the thing being styled; classes
 * written beside it qualify it. `.status-dot.open` is the `status` family in its open state,
 * never an `open` family — which is what keeps the state vocabulary out of the registry, and
 * why exactly one row carries `owner: "shared"`.
 *
 * OWNERSHIP FOLLOWS THE SCOPE. A rule belongs to the owner of the LEFTMOST family in each of
 * its selectors, because that is the subtree it reaches into and therefore the code whose
 * removal makes the rule dead: `.portal--mono .terminal-frame` is the canvas plugin's rule
 * about a terminal and it leaves when portals leave. Compounds to the right — including the
 * ones inside `:is()`, `:not()`, `:where()` and `:has()` — are context: checked for
 * REGISTRATION, so no new family can hide in a descendant, never for ownership.
 *
 * A rule with no class anywhere is the `*` row's: the reset and the element defaults reach
 * every node in the document, so they are the floor's and a plugin restyling `body` is RED.
 */
{
  const SHARED = "shared";
  const CSS_COMMENTS = /\/\*[\s\S]*?\*\//g;
  const FUNCTIONAL_PSEUDO = /:(?:is|not|where|has)\(([^()]*)\)/g;
  const FIRST_CLASS = /\.(-?[_a-zA-Z][-\w]*)/;

  const owners = new Map<string, string>(
    registries.cssFamilies.map((row) => [row.family, row.owner]),
  );

  /** The longest registered prefix of a class name, cut only at a `-`/`__` seam. */
  const familyOf = (cls: string): string | null => {
    for (let cut = cls.length; cut > 0; cut--) {
      const seam = cut === cls.length || cls[cut] === "-" || cls[cut] === "_";
      if (!seam) continue;
      const candidate = cls.slice(0, cut);
      if (owners.has(candidate)) return candidate;
    }
    return null;
  };

  /** Splits on commas / combinators that are not inside `(…)` or `[…]`. */
  const splitTop = (text: string, breaks: string): readonly string[] => {
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
  };

  /** The class a compound is ABOUT, ignoring the ones that merely qualify it. */
  const anchorOf = (compound: string): string | null =>
    FIRST_CLASS.exec(compound.replace(FUNCTIONAL_PSEUDO, ""))?.[1] ?? null;

  /** Every compound a selector mentions, the arguments of functional pseudos included. */
  const everyCompound = (selector: string): readonly string[] => {
    const found: string[] = [];
    for (const compound of splitTop(selector, " \t\n>+~")) {
      found.push(compound);
      for (;;) {
        const inner = FUNCTIONAL_PSEUDO.exec(compound);
        if (inner === null) break;
        for (const one of splitTop(inner[1] ?? "", ",")) {
          found.push(...splitTop(one, " \t\n>+~"));
        }
      }
    }
    return found;
  };

  interface CssRule {
    readonly selectors: readonly string[];
    readonly line: number;
  }

  /**
   * Selector lists and `@keyframes` names, one level of at-rule nesting followed. A keyframes
   * name is reported as its own pseudo-selector so the animation vocabulary is owned too — a
   * plugin cannot mint `@keyframes terminal-blink` in somebody else's file either.
   */
  const cssRules = (text: string): readonly CssRule[] => {
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
          } else if (prelude.startsWith("@keyframes")) {
            rules.push({ selectors: [`.${prelude.slice("@keyframes".length).trim()}`], line });
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
  };

  const stylesheets: string[] = [];
  for (const hit of new Bun.Glob("packages/**/*.css").scanSync({
    cwd: repoRoot,
    onlyFiles: true,
  })) {
    const path = hit.split("\\").join("/");
    if (path.includes("node_modules/") || path.includes("dist/")) continue;
    stylesheets.push(path);
  }
  stylesheets.sort();

  const unregistered: string[] = [];
  const misowned: string[] = [];
  const defined = new Set<string>();
  let ruleCount = 0;

  for (const path of stylesheets) {
    for (const rule of cssRules(readFileSync(join(repoRoot, path), "utf8"))) {
      ruleCount++;
      const where = `${path}:${String(rule.line)}`;
      let classed = false;
      for (const selector of rule.selectors) {
        let scope: string | null = null;
        for (const compound of everyCompound(selector)) {
          const anchor = anchorOf(compound);
          if (anchor === null) continue;
          classed = true;
          const family = familyOf(anchor);
          if (family === null) {
            unregistered.push(`${where} .${anchor} (${selector})`);
            continue;
          }
          /*
            Liveness is "this row suppresses a real occurrence", not "this row is a scope
            root": `react-flow` is only ever written to the RIGHT of `.canvas`, and a vendor
            vocabulary nobody anchors on is still a vocabulary exactly one sheet may dress.
          */
          if (owners.get(family) === path) defined.add(family);
          if (scope === null && owners.get(family) !== SHARED) scope = family;
        }
        if (scope === null) continue;
        const owner = owners.get(scope) ?? "";
        if (owner !== path) misowned.push(`${where} ${scope} belongs to ${owner} (${selector})`);
      }
      if (classed) continue;
      const floorSheet = owners.get("*") ?? "";
      if (floorSheet === path) defined.add("*");
      else {
        misowned.push(
          `${where} a rule with no class belongs to ${floorSheet} (${rule.selectors.join(", ")})`,
        );
      }
    }
  }

  check(
    "S13 css ownership",
    unregistered.length === 0 && misowned.length === 0,
    unregistered.length === 0 && misowned.length === 0
      ? `${String(ruleCount)} rules across ${String(stylesheets.length)} stylesheets, every family painted by the one owner ${String(owners.size)} registry rows name`
      : `unregistered families: ${list(unregistered)}; painted outside their owner: ${list(misowned)}`,
  );

  const sheets = new Set(stylesheets);
  const stale = registries.cssFamilies
    .filter((row) => row.owner !== SHARED && !defined.has(row.family))
    .map((row) =>
      sheets.has(row.owner)
        ? `${row.family} (nothing in ${row.owner})`
        : `${row.family} (no ${row.owner})`,
    );
  /*
    The shared row earns its place the same way, but it cannot be "defined" anywhere: `is-*`
    is only ever a qualifier, so liveness asks whether any stylesheet writes one at all.
  */
  const unusedShared = registries.cssFamilies
    .filter(
      (row) =>
        row.owner === SHARED &&
        !stylesheets.some((path) =>
          readFileSync(join(repoRoot, path), "utf8").includes(`.${row.family}-`),
        ),
    )
    .map((row) => `${row.family} (shared, unused)`);

  check(
    "S13 css family liveness",
    stale.length === 0 && unusedShared.length === 0,
    stale.length === 0 && unusedShared.length === 0
      ? `${String(registries.cssFamilies.length)} rows, every one defining rules in the stylesheet it names`
      : `stale rows: ${list([...stale, ...unusedShared])}`,
  );
}

/**
 * THE OPERATIONAL LOG VOCABULARY (`evt`), producers and consumers measured against one list.
 *
 * `LOG_EVENTS` closes the vocabulary and `LogEvent` makes a producer typo a compile error, so
 * this check exists for the half a type cannot reach: the e2e gates match these names INSIDE
 * RAW STDOUT (`line.includes('"evt":"exited"')`), which is a string to the compiler and a
 * contract to the reader. Before the union, the agent spelled the same concept `shutdown_error`
 * while the server spelled it `shutdown_failed`, and a rename on either side would have left an
 * e2e assertion matching a name nothing emits — a gate that passes by never looking.
 *
 * Both directions, like every registry here. A literal outside the union fails; a member with
 * no live producer fails too, because a name nobody emits is a stale row and an e2e that waits
 * for one would hang until its timeout and blame the feature.
 */
{
  const vocabulary = new Set<string>(LOG_EVENTS);
  const LEVELS = new Set(["info", "warn", "error"]);
  const produced: { readonly where: string; readonly evt: string }[] = [];

  const producerFiles: string[] = [];
  for (const root of ["packages/server/src", "packages/agent/src"]) scanTree(root, producerFiles);
  for (const path of producerFiles) {
    if (!SOURCE.test(path) || TEST_SOURCE.test(path)) continue;
    const file = parsed(path);
    walk(file, (node) => {
      /*
        `evt: "starting"` — the agent's entry point writes records straight to its sink rather
        than through a logger object, so the property assignment is the producer there.
       */
      if (ts.isPropertyAssignment(node)) {
        const key =
          ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : "";
        if (key === "evt" && ts.isStringLiteralLike(node.initializer)) {
          produced.push({
            where: `${path}:${String(lineOf(file, node))}`,
            evt: node.initializer.text,
          });
        }
        return;
      }
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      const method = node.expression.name.text;
      const [first, second] = node.arguments;
      /*
        `logger.warn("machine_rejected", …)`, matched on the METHOD rather than on the
        receiver's name. `console` is a different stream and excluded; anything else calling
        `.info/.warn/.error` with a string literal in these two packages is treated as a
        producer on purpose. Today there are exactly three receivers — `logger`,
        `this.logger`, `createLogger(defaultRuntime)` — so this over-catches nothing; and if
        it ever over-catches, it fails LOUDLY naming a file and line, whereas keying on a
        variable's name would let a logger held under another name rot silently. Same trade as
        S4: sound first, and coverage ratchets up.
       */
      if (LEVELS.has(method) && node.expression.expression.getText(file) !== "console") {
        if (first !== undefined && ts.isStringLiteralLike(first)) {
          produced.push({ where: `${path}:${String(lineOf(file, node))}`, evt: first.text });
        }
        return;
      }
      // `this.log("info", "welcome", …)`: the agent's own two-argument spelling.
      if (method !== "log") return;
      if (first === undefined || !ts.isStringLiteralLike(first) || !LEVELS.has(first.text)) return;
      if (second !== undefined && ts.isStringLiteralLike(second)) {
        produced.push({ where: `${path}:${String(lineOf(file, node))}`, evt: second.text });
      }
    });
  }

  /*
    The consumer half. Read through the PARSER, over string and template tokens only: a gate's
    matcher is a LITERAL, and prose is not. This file's own rationale above quotes
    `"evt":"exited"` in a comment, and a text scan would count the explanation as an assertion —
    inflating the number a reader trusts and, worse, letting a comment "satisfy" the check.
    Template tokens are included because a matcher built with backticks is just as load-bearing.
   */
  const JSONL_EVT = /"evt"\s*:\s*"([A-Za-z0-9_]+)"/g;
  const consumed: { readonly where: string; readonly evt: string }[] = [];
  const consumerFiles: string[] = [];
  for (const root of ["packages/testkit", "scripts"]) scanTree(root, consumerFiles);
  for (const path of consumerFiles) {
    if (!SOURCE.test(path)) continue;
    const file = parsed(path);
    walk(file, (node) => {
      if (!ts.isStringLiteralLike(node) && !ts.isTemplateLiteralToken(node)) return;
      for (const hit of node.getText(file).matchAll(JSONL_EVT)) {
        consumed.push({ where: `${path}:${String(lineOf(file, node))}`, evt: hit[1] ?? "" });
      }
    });
  }

  const strayProducers = produced.filter((row) => !vocabulary.has(row.evt));
  const strayConsumers = consumed.filter((row) => !vocabulary.has(row.evt));
  const emitted = new Set(produced.map((row) => row.evt));
  const unemitted = [...vocabulary].filter((evt) => !emitted.has(evt));

  check(
    "S14 log vocabulary",
    strayProducers.length === 0 && strayConsumers.length === 0,
    strayProducers.length === 0 && strayConsumers.length === 0
      ? `${String(produced.length)} producers and ${String(consumed.length)} stdout matchers all name one of the ${String(vocabulary.size)} declared events`
      : `outside LOG_EVENTS — producers: ${list(strayProducers.map((row) => `${row.where} ${row.evt}`))}; stdout matchers: ${list(strayConsumers.map((row) => `${row.where} ${row.evt}`))}`,
  );
  check(
    "S14 log vocabulary liveness",
    unemitted.length === 0,
    unemitted.length === 0
      ? `every declared event has a live producer`
      : `declared but emitted nowhere — delete them or emit them: ${list(unemitted)}`,
  );
}

/**
 * GATE CONTRACTS: the DOM strings a gate depends on, declared (§Gate contracts).
 *
 * A browser gate reaches the product through `document.querySelector`, so every string it
 * hands over is a join with no compiler between the two sides. Two of them were rotten. One was
 * plain button copy — `clickText("Enter manifold")`, against a label that becomes
 * "Creating identity…" the instant it is pressed. The other was a `data-testid` templated from
 * a plugin MANIFEST id, so renaming a section id broke three gates with no failing typecheck
 * and no failing unit test, only a browser assertion that stopped finding its element.
 *
 * Three directions. A queried test-id with no row is an undeclared contract; a row whose
 * renderer does not paint the attribute is a lie about who owes it; a row nobody queries is
 * stale, and stale rows fail here exactly as they do in S6 and S11. Templated attributes match
 * by SHAPE, so `toolbar-${item.id}` answers for every tool a plugin contributes and the
 * register stays small while the vocabulary stays open.
 */
{
  const contracts = registries.gateContracts;
  /*
    Read through the parser, over literal tokens only, for the same reason S14's consumer half
    is: a query is a LITERAL a gate hands to the DOM, and the prose above describing one is not
    a contract. `clickTestId(…)` is covered as well as the raw selector, so routing a click
    through the helper is not a way out of the register.
   */
  const QUERIED = /\[data-testid\s*=\s*(?:"([^"\]]+)"|'([^'\]]+)'|([A-Za-z0-9_-]+))\]/g;
  const queried: { readonly where: string; readonly testid: string }[] = [];
  for (const entry of readdirSync(join(repoRoot, "scripts"), { withFileTypes: true })) {
    if (!entry.isFile() || !SOURCE.test(entry.name)) continue;
    const path = `scripts/${entry.name}`;
    const file = parsed(path);
    walk(file, (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const [first] = node.arguments;
        if (
          node.expression.name.text === "clickTestId" &&
          first !== undefined &&
          ts.isStringLiteralLike(first)
        ) {
          queried.push({ where: `${path}:${String(lineOf(file, node))}`, testid: first.text });
        }
        return;
      }
      if (!ts.isStringLiteralLike(node) && !ts.isTemplateLiteralToken(node)) return;
      for (const hit of node.getText(file).matchAll(QUERIED)) {
        const testid = hit[1] ?? hit[2] ?? hit[3] ?? "";
        if (testid !== "") queried.push({ where: `${path}:${String(lineOf(file, node))}`, testid });
      }
    });
  }

  /** A `data-testid` a renderer paints, as a pattern: a literal exactly, a template by shape. */
  const attributePattern = (value: ts.JsxAttributeValue): RegExp | null => {
    const quoted = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (ts.isStringLiteral(value)) return new RegExp(`^${quoted(value.text)}$`);
    if (!ts.isJsxExpression(value) || value.expression === undefined) return null;
    const inner = value.expression;
    if (ts.isStringLiteralLike(inner)) return new RegExp(`^${quoted(inner.text)}$`);
    /*
      A test-id computed from a bare identifier cannot be verified from the source, and a
      contract nobody can verify is not one. Answering null makes the ROW fail with a message
      naming its renderer, and the fix is to inline the template rather than widen the check.
     */
    if (!ts.isTemplateExpression(inner)) return null;
    let source = `^${quoted(inner.head.text)}`;
    for (const span of inner.templateSpans) source += `[^\\s]+${quoted(span.literal.text)}`;
    return new RegExp(`${source}$`);
  };

  const declared: { readonly path: string; readonly pattern: RegExp }[] = [];
  const markup: string[] = [];
  scanTree("packages", markup);
  for (const path of markup) {
    if (!path.endsWith(".tsx")) continue;
    const file = parsed(path);
    walk(file, (node) => {
      if (!ts.isJsxAttribute(node) || node.name.getText(file) !== "data-testid") return;
      if (node.initializer === undefined) return;
      const pattern = attributePattern(node.initializer);
      if (pattern !== null) declared.push({ path, pattern });
    });
  }

  const byTestid = new Map(contracts.map((row) => [row.testid, row]));
  const undeclared = queried.filter((row) => !byTestid.has(row.testid));
  const unpainted = contracts.filter(
    (row) => !declared.some((hit) => hit.path === row.renderer && hit.pattern.test(row.testid)),
  );
  const queriedIds = new Set(queried.map((row) => row.testid));
  const stale = contracts.filter((row) => !queriedIds.has(row.testid));
  /*
    Copy-keyed clicks, found through the PARSER rather than the text: this very file documents
    `clickText` in the comment above, and a text scan would flag its own rationale. A call
    expression is unambiguous, and `cdp.ts`'s method DECLARATION is not one — so the helper may
    keep existing while no gate is permitted to reach for it.
   */
  const copyKeyed: string[] = [];
  for (const entry of readdirSync(join(repoRoot, "scripts"), { withFileTypes: true })) {
    if (!entry.isFile() || !SOURCE.test(entry.name)) continue;
    const path = `scripts/${entry.name}`;
    const file = parsed(path);
    walk(file, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      if (node.expression.name.text !== "clickText") return;
      copyKeyed.push(`${path}:${String(lineOf(file, node))}`);
    });
  }

  check(
    "S15 gate contracts declared",
    undeclared.length === 0,
    undeclared.length === 0
      ? `${String(queried.length)} test-id queries across scripts/ name one of the ${String(contracts.length)} declared contracts`
      : `queried but undeclared — add a §Gate-contracts row: ${list(undeclared.map((row) => `${row.where} ${row.testid}`))}`,
  );
  check(
    "S15 gate contracts painted",
    unpainted.length === 0,
    unpainted.length === 0
      ? `every contract resolves to a live data-testid in its declared renderer`
      : `rows whose renderer paints no matching data-testid: ${list(unpainted.map((row) => `${row.testid} → ${row.renderer}`))}`,
  );
  check(
    "S15 gate contracts liveness",
    stale.length === 0 && copyKeyed.length === 0,
    stale.length === 0 && copyKeyed.length === 0
      ? `no stale rows, and no gate keys an assertion off button copy`
      : `rows nobody queries: ${list(stale.map((row) => row.testid))}; copy-keyed clicks — use clickTestId against a declared contract: ${list(copyKeyed)}`,
  );
}

// ────────────────────────────────────────── S16: the floor's own size, as a number

/**
 * THE FLOOR HAS A BUDGET, and the budget is the only thing that makes "keep the engine small"
 * a claim instead of a preference.
 *
 * Every other static check here asks whether a boundary is CLEAN. None of them notices the
 * failure mode that actually threatens A1, which is the engine getting bigger one defensible
 * commit at a time. `packages/plugin/src` is where that happens first: it is the one package
 * every plugin imports, so a helper put there is instantly reachable by everything and never
 * has to justify itself to a second party the way a plugin's own module does. The litmus test
 * (§Foundation law) governs each ADDITION and cannot see the aggregate; a number can.
 *
 * SOURCE ONLY, tests excluded, because `sourcesMatching` already draws that line and a test is
 * evidence about the floor rather than part of it — a budget that counted tests would price
 * proving the engine the same as growing it.
 *
 * Two thresholds, and the gap between them is the point. The WARN line is a line printed and
 * nothing else: it is where a reviewer should be asking which of these modules is really
 * plugin territory, and a gate that failed there would be a gate that blocks the wave doing
 * the extraction. The RED line is where the number stops being a signal and becomes the
 * finding — an engine that size is no longer small enough for a stranger's agent to read
 * before it starts (A3), whatever each individual file's litmus verdict said. Raising either
 * threshold is a change to this file, which means it is a change somebody has to defend in a
 * diff; that is the whole enforcement mechanism.
 */
const PLUGIN_SRC_WARN_LINES = 9_000;
const PLUGIN_SRC_MAX_LINES = 12_000;

{
  const files = sourcesMatching("packages/plugin/src/**");
  let total = 0;
  let largest = { path: "", lines: 0 };
  for (const path of files) {
    const lines = readFileSync(join(repoRoot, path), "utf8").split("\n").length;
    total += lines;
    if (lines > largest.lines) largest = { path, lines };
  }
  if (total >= PLUGIN_SRC_WARN_LINES) {
    console.log(
      `WARN  S16 floor budget: packages/plugin/src is ${String(total)} lines, past the ${String(PLUGIN_SRC_WARN_LINES)} review line (RED at ${String(PLUGIN_SRC_MAX_LINES)}). Largest: ${largest.path} (${String(largest.lines)}). Ask which of these modules is plugin territory.`,
    );
  }
  check(
    "S16 floor budget",
    total <= PLUGIN_SRC_MAX_LINES,
    total <= PLUGIN_SRC_MAX_LINES
      ? `packages/plugin/src is ${String(total)} lines across ${String(files.length)} source files (warn ${String(PLUGIN_SRC_WARN_LINES)}, red ${String(PLUGIN_SRC_MAX_LINES)}); largest ${largest.path} (${String(largest.lines)})`
      : `packages/plugin/src is ${String(total)} lines, over the ${String(PLUGIN_SRC_MAX_LINES)}-line ceiling: the engine has grown past what a stranger's agent can read before starting (A3). Extract plugin territory or defend a new ceiling in scripts/verify-axioms.ts`,
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
/**
 * The one `evt` this gate reads out of the stream, typed rather than spelled inline: the
 * literal is a join with the server's logger, so it belongs to `LogEvent` and not to a
 * string. S14 guards the literals no type can reach; this one it needn't, because the
 * compiler already does.
 */
const ACTION_EVT: LogEvent = "action";
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
        if (Reflect.get(record as object, "evt") !== ACTION_EVT) continue;
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

  /**
   * The plugin manager's OWN toggle, addressed by the contract that names it.
   *
   * A2 says a gesture in the browser and a call from an SDK land on the same door, and a gate
   * that only ever dispatched proved the SDK half twice. This presses the button a human
   * presses: the section root and the enablement affordance are both declared gate contracts,
   * and the row is picked out by the plugin id the manager already paints beside them, so
   * nothing here is keyed off button copy.
   */
  const managerToggle = (id: string): string =>
    `[data-testid="plugin-manager"] [data-plugin="${id}"] [data-testid="plugin-manager-toggle"]`;

  /**
   * Flips a plugin by PRESSING that button, and answers whether the workspace agreed.
   *
   * The roster is server-owned: the button dispatches and the new roster arrives on the
   * connection frame, so the proof a press landed is the row reporting the new state rather
   * than the click returning. `disabledHere` is kept in step either way, or the restore pass
   * would leave a plugin off after a click-driven disable.
   */
  const pressToggle = async (id: string, becomes: boolean): Promise<boolean> => {
    const selector = JSON.stringify(managerToggle(id));
    const pressed = await browser!.evaluate<boolean>(
      `(() => { const hit = document.querySelector(${selector});
        if (!(hit instanceof HTMLElement) || hit.matches(':disabled')) return false;
        hit.click(); return true; })()`,
    );
    if (!pressed) return false;
    const landed = await settles(
      () =>
        browser!.evaluate<boolean>(
          `document.querySelector(${selector})?.getAttribute('aria-checked') === ${JSON.stringify(
            String(becomes),
          )}`,
        ),
      10_000,
    );
    if (landed) {
      if (becomes) disabledHere.delete(id);
      else disabledHere.add(id);
    }
    return landed;
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
    await browser.clickTestId("identity-enter");
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
      JSON.stringify(workspaceLayout(WORKSPACE_PANELS)["root"]?.ratios);
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
    /*
      THE BUTTON, NOT THE DOOR BEHIND IT. This leg used to dispatch
      `engine.plugins.setEnabled` over HTTP and then assert the canvas went inert, which
      proved the door twice and the UI never — a manager whose toggle had stopped being wired
      to that door would have passed. So the disable is a real press on the plugin manager's
      own affordance, and the re-enable below stays a direct dispatch: A2's claim is that both
      paths land on the SAME door, and a gate can only say that by exercising both.
     */
    await until(
      () =>
        browser!.evaluate<boolean>(
          `document.querySelector('[data-testid="plugin-manager"] [data-plugin="core.draw"]') !== null`,
        ),
      20_000,
      "the plugin manager listing core.draw",
    );
    const drawGone = await pressToggle("core.draw", false);
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
      "R3 core.draw off, by the manager's own button",
      drawGone && inert,
      drawGone && inert
        ? "one press on the plugin manager: tool button gone and the existing stroke reads as a named placeholder, no reload"
        : drawGone
          ? "the press landed but the canvas did not go inert"
          : "the plugin manager's toggle did not turn core.draw off",
    );

    // The direct-dispatch half, deliberately kept: the same plugin comes back through the
    // API door, and the manager's own row must agree without anyone reloading it.
    const drawBack = await setEnabled("core.draw", true);
    const rowAgrees = await settles(
      () =>
        browser!.evaluate<boolean>(
          `document.querySelector(${JSON.stringify(managerToggle("core.draw"))})?.getAttribute('aria-checked') === 'true'`,
        ),
      10_000,
    );
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
      "R3 core.draw back on, by the API door",
      drawBack && restored && rowAgrees,
      restored && rowAgrees
        ? "tool and ink both return live, and the manager's row reports the API's change"
        : restored
          ? "the canvas came back but the manager's row did not follow"
          : "the canvas stayed inert after re-enabling",
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
