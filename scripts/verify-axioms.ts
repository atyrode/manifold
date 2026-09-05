/**
 * manifold axioms gate — the constitution made falsifiable.
 *
 * `AXIOMS.md` swears that everything above the floor is a plugin (A1), that every capability
 * is reachable identically by a browser and an SDK (A2), and that the boundary between the
 * two is a machine-readable registry rather than a promise (D10). `REGISTRY.md` is where those
 * registries live — enforcement data, amended in the same commit as the code it indexes. A
 * document nobody can violate silently is the only kind worth writing, so this script reads
 * those registries and holds the tree to them — in BOTH directions, so an unrecorded crossing
 * fails here rather than in review.
 *
 * The static half (S1-S17) runs against the source tree with the TypeScript parser, never a
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
 *   S17 hosting neutrality: no shipped file names a hosting provider (ADR 0022)
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
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import {
  AssemblyError,
  assembleRoster,
  FLOOR_ELEMENT_PAYLOADS,
  ITEM_NOUNS,
  composeDefaultLayout,
  ENGINE_PLUGINS_ID,
  ENGINE_SET_ENABLED_ACTION,
  enginePluginsActions,
  enginePluginsManifest,
  panelRefId,
  type Assembly,
} from "../packages/plugin/src/index.ts";
import { INDEX_RESOURCE, type PolledFeedReport } from "../packages/plugin/src/polled-resource.ts";
import {
  ActionOutcomeSchema,
  ActionSummarySchema,
  CORE_NAMESPACE_PREFIX,
  ITEM_KINDS,
  LOG_EVENTS,
  LayoutResponseSchema,
  MachinesResponseSchema,
  ContainerResponseSchema,
  IndexResponseSchema,
  PluginRosterSchema,
  PluginsResponseSchema,
  ResolveResponseSchema,
  SceneElementSchema,
  TokenGrantSchema,
  formatManifoldUri,
  validateTileLayout,
  type LogEvent,
  type ManifoldRef,
  type ServerEvent,
  type TileLayout,
  type TokenGrant,
} from "../packages/protocol/src/index.ts";
import { SERVER_PLUGIN_DEFS, SHIPPED_PLUGIN_IDS } from "../packages/server/src/assembly.ts";
import { SessionClient } from "../packages/sdk/src/index.ts";
import { resolveWebDist } from "./gate-dist.ts";
import { Browser } from "./cdp.ts";
import { checkInto, ownerKeyOf, settles, sleep, teardownServer, until } from "./gate-lib.ts";

const repoRoot = join(import.meta.dir, "..");
const failures: string[] = [];

const check = checkInto(failures);

/**
 * OPENS THE PLUGIN MANAGER, because the ledger is a MODAL now (issue #91): the rail's row is
 * only the opener, so every rung that reads a plugin row has to press it first.
 *
 * Idempotent and addressed by contract — it presses `plugin-manager-open` only when the dialog
 * is not already OPEN, and answers whether it is. Openness is read off the `<dialog>` rather
 * than off the listing's presence: a closed dialog keeps its subtree in the DOM, so "the row
 * exists" is not the same question as "a reader can see it". Keyed off declared test ids rather
 * than button copy, which is the §Gate-contracts rule that made this a function instead of a
 * click pasted into four rungs.
 */
async function openPluginManager(): Promise<boolean> {
  return await settles(
    () =>
      browser!.evaluate<boolean>(
        `(() => {
          const card = document.querySelector('[data-testid="plugin-manager-modal"]');
          const dialog = card === null ? null : card.closest('dialog');
          if (dialog instanceof HTMLDialogElement && dialog.open) return true;
          const opener = document.querySelector('[data-testid="plugin-manager-open"]');
          if (opener instanceof HTMLElement) opener.click();
          return false;
        })()`,
      ),
    10_000,
  );
}

/**
 * And closes it, the way a reader does: a pointer press on the backdrop. Never
 * `HTMLDialogElement.close()` — that shuts the element while the component still believes it is
 * open, and the next press on the opener would then be a no-op against unchanged state.
 */
async function closePluginManager(): Promise<void> {
  await browser!.evaluate(
    `(() => {
      const card = document.querySelector('[data-testid="plugin-manager-modal"]');
      const dialog = card === null ? null : card.closest('dialog');
      if (dialog instanceof HTMLDialogElement && dialog.open) {
        dialog.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      }
      return null;
    })()`,
  );
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

/**
 * One pillar of the foundation (§Pillar inventory). `verdict` carries the row's reason exactly
 * as `why` does elsewhere, so a pillar asserted without one is discarded here — and the floor
 * files it would have owned then fall out of S9 as unowned rather than being quietly blessed.
 */
interface PillarRow {
  readonly id: string;
  readonly globs: readonly string[];
  readonly verdict: string;
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
 * The fenced JSON in `REGISTRY.md`. Read from the document rather than imported from a module
 * because the registry's HOME is the document beside the constitution — a TypeScript copy would
 * be a second door onto "where does the boundary run", and D10's whole point is that there is
 * exactly one. The law those rows enforce is `AXIOMS.md`; the rows themselves move with the
 * code they index, which is why they are not in it.
 * A row missing its `why` is discarded here, which makes an unjustified entry fail the check
 * that reads the registry instead of quietly widening the floor.
 */
function axiomRegistries(): {
  readonly floor: readonly FloorRow[];
  readonly pillars: readonly PillarRow[];
  readonly deviceLocal: readonly DeviceLocalRow[];
  readonly gateContracts: readonly GateContractRow[];
  readonly cssFamilies: readonly CssFamilyRow[];
} {
  const text = readFileSync(join(repoRoot, "REGISTRY.md"), "utf8");
  const floor: FloorRow[] = [];
  const pillars: PillarRow[] = [];
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
    if ("pillars" in parsed && Array.isArray(parsed.pillars)) {
      for (const row of parsed.pillars) {
        if (row === null || typeof row !== "object") continue;
        const id: unknown = Reflect.get(row, "id");
        const verdict: unknown = Reflect.get(row, "verdict");
        const globs: unknown = Reflect.get(row, "globs");
        // A pillar's reason is its `verdict`, which is what `why` is everywhere else: a row
        // that asserts ownership without stating the litmus finding is not law and is dropped,
        // so the files it would have owned surface as unowned in S9.
        if (typeof id !== "string" || id === "") continue;
        if (typeof verdict !== "string" || verdict === "") continue;
        if (!Array.isArray(globs) || globs.length === 0) continue;
        const owned = globs.filter(
          (glob): glob is string => typeof glob === "string" && glob !== "",
        );
        if (owned.length !== globs.length) continue;
        pillars.push({ id, globs: owned, verdict });
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
  if (floor.length === 0) throw new Error("REGISTRY.md carries no fenced `floor` registry");
  if (deviceLocal.length === 0) {
    throw new Error("REGISTRY.md carries no fenced `deviceLocal` register");
  }
  if (gateContracts.length === 0) {
    throw new Error("REGISTRY.md carries no fenced `gateContracts` register");
  }
  if (cssFamilies.length === 0) {
    throw new Error("REGISTRY.md carries no fenced `cssFamilies` registry");
  }
  if (pillars.length === 0) throw new Error("REGISTRY.md carries no fenced `pillars` inventory");
  return { floor, pillars, deviceLocal, gateContracts, cssFamilies };
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

    `distribution` is the `core.` reservation, composed exactly as `main.ts` composes it: the
    shipped ids derived from the registration table. Passing it here is what makes S1 a real
    exercise of the reservation rather than a composition that happens to avoid it.
  */
  assembly = assembleRoster(
    [...SERVER_PLUGIN_DEFS, { manifest: enginePluginsManifest, actions: enginePluginsActions }],
    new Set(),
    { builtins: new Set([ENGINE_PLUGINS_ID]), distribution: SHIPPED_PLUGIN_IDS },
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

  /*
    THE `core.` RESERVATION, read across the two registration files that define the shipped
    distribution. The runtime half is `assembleRoster` refusing a manifest under `core.` that
    `SHIPPED_PLUGIN_IDS` does not carry (composed above). This is the other half: the web file
    claims ids too, and it holds no copy of the set — so a web registration under `core.` whose
    id the server table never shipped is the one way the two files could disagree about who
    inhabits the namespace. Derived from both files, never from a third list (invariant 14).
  */
  const squatters = webRegistrations
    .filter((entry) => entry.id.startsWith(CORE_NAMESPACE_PREFIX))
    .filter((entry) => !SHIPPED_PLUGIN_IDS.has(entry.id));
  check(
    "S1 core reservation",
    squatters.length === 0,
    squatters.length === 0
      ? `every web-registered "${CORE_NAMESPACE_PREFIX}" id is one the shipped distribution registers`
      : `web claims reserved ids the distribution never shipped: ${list(squatters.map((entry) => entry.id))}`,
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
    The default is COMPOSED, not a constant and no longer a floor arrangement filled with two
    names either: the enabled roster's own declared seats are the whole input (ADR 0017 S17-B).
    So the check composes the tree the server actually serves from the roster this script
    already built, and asserts every leaf of THAT resolves — plus that the composition
    is a tree the layout door may serve at all, since an invalid default would be a 500 on
    `GET /api/layout` for every principal who has never arranged a workspace.
  */
  const seeded = composeDefaultLayout(composed.roster);
  const missing: string[] = [];
  for (const node of Object.values(seeded.layout)) {
    const ref = node.ref;
    if (ref === null || ref.kind !== "panel") continue;
    if (!composed.panels.has(ref.panelId)) missing.push(ref.panelId);
  }
  const seatedOk =
    missing.length === 0 && seeded.condition === "seated" && validateTileLayout(seeded.layout);
  check(
    "S1 default workspace",
    seatedOk,
    seatedOk
      ? `the roster's declared seats compose a valid default tree whose ${String(Object.keys(seeded.layout).length - 1)} panel leaves all resolve`
      : missing.length > 0
        ? `default layout names panels nothing composed: ${list(missing)}`
        : `composition is ${seeded.condition} and ${validateTileLayout(seeded.layout) ? "valid" : "INVALID"}`,
  );
}

// ─────────────────────────────────────────────────────────── S2: import boundary

const registries = axiomRegistries();
const floorFiles = new Set<string>();
/**
 * Every FILE the floor registry claims — stylesheets included, tests excluded. The import walk
 * wants source; S9 asks which pillar owns each floor file, and `packages/web/src/styles.css` is
 * as much a floor file as `main.tsx` is (§Foundation names both, and the pillar inventory claims
 * both by name).
 */
const floorPaths = new Set<string>();
const emptyGlobs: string[] = [];
for (const row of registries.floor) {
  const matched = sourcesMatching(row.glob);
  // A glob may legitimately match only non-source files (a stylesheet); liveness (S6) asks
  // whether ANYTHING is there, so it counts raw matches while the boundary walk takes source.
  const anything = [...new Bun.Glob(row.glob).scanSync({ cwd: repoRoot, onlyFiles: true })];
  if (anything.length === 0) emptyGlobs.push(row.glob);
  for (const path of matched) floorFiles.add(path);
  for (const hit of anything) {
    const path = hit.split("\\").join("/");
    if (!TEST_SOURCE.test(path)) floorPaths.add(path);
  }
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
   * `REGISTRY.md` §Plugin layer.
   */
  const ENGINE: Readonly<Record<string, true>> = {
    "@manifold/protocol": true,
    "@manifold/scene": true,
    "@manifold/sdk": true,
    "@manifold/plugin": true,
    "@manifold/plugin/hooks": true,
    "@manifold/plugin/ui": true,
  };
  /**
   * A DRAWING IS NOT A DEPENDENCY A PLUGIN MAY NAME. `@manifold/plugin/ui` is THE icon
   * vocabulary's one door (`ControlIcon`, `ItemIcon`), and the whole value of that door is
   * that re-drawing the set is a change to one file: a plugin that imports `lucide-react`
   * itself owns a mark that stops moving when the set moves, and re-types the wrapper's four
   * props for the privilege. #116 found three packages doing it — `core.pluginManager` even
   * re-drew `discard`, a kind the vocabulary already maps — so the sweep is a check rather
   * than a memory. The floor's `packages/plugin/src/ui/icons.tsx` is not scanned here and is
   * the one place the name may appear.
   */
  const DRAWINGS = "lucide-react";
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
        if (text === DRAWINGS || text.startsWith(`${DRAWINGS}/`)) {
          offenders.push(
            `${path}:${String(specifier.line)} imports ${text}; ask @manifold/plugin/ui for a kind`,
          );
        }
      }
    }
  }
  check(
    "S2 plugins import only the engine",
    offenders.length === 0,
    offenders.length === 0
      ? `${String(scanned)} plugin sources import only protocol/scene/sdk/plugin, and no drawing`
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
  "/api/bindings",
  "/api/settings",
  "/api/attendance",
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

// ────────────────────────────────────── S9: pillar exhaustiveness

/**
 * EVERY FLOOR FILE HAS AN OWNER.
 *
 * `AXIOMS.md` §Foundation law says the foundation is a small set of PILLARS, each admitted by
 * the litmus test — not "the code we did not convert". The floor registry is the file-level
 * view of that claim, and until this check existed the two halves could disagree in silence: a
 * file could be floor with no pillar answering for it. That is exactly how
 * `packages/web/src/stroke.ts` happened — plugin-domain geometry sitting in the floor tree,
 * inside no pillar, therefore invisible to the import walk and to registry liveness alike.
 *
 * The rule the registry states, mechanized: a floor file falls inside exactly ONE pillar's
 * globs; where two pillars overlap the MOST SPECIFIC glob owns the file (longest literal prefix
 * wins, which is why `packages/server/src/placement.ts` belongs to `placement-algebra` and not
 * to the `packages/server/src/*.ts` neighbourhood around it); and two pillars claiming one file
 * at EQUAL specificity is itself an error, because then the registry does not say who answers.
 *
 * An unmatched file is RED and is NAMED. There is no exception list and there must not be one:
 * §Foundation law admits no third state between floor and plugin territory, so the way a file
 * leaves the unmatched set is by moving into its plugin or by a pillar claiming it in the same
 * commit — never by the gate being taught to tolerate it.
 */
{
  /** How specific a glob is: the literal head before its first wildcard. */
  const specificity = (glob: string): number => {
    const wildcard = glob.search(/[*?[{]/);
    return wildcard === -1 ? glob.length : wildcard;
  };

  interface Claim {
    readonly pillar: string;
    readonly glob: string;
    readonly specificity: number;
  }
  const claims = new Map<string, Claim[]>();
  const deadGlobs: string[] = [];
  for (const pillar of registries.pillars) {
    for (const glob of pillar.globs) {
      let reached = 0;
      for (const hit of new Bun.Glob(glob).scanSync({ cwd: repoRoot, onlyFiles: true })) {
        const path = hit.split("\\").join("/");
        if (!floorPaths.has(path)) continue;
        reached += 1;
        const bucket = claims.get(path);
        const claim: Claim = { pillar: pillar.id, glob, specificity: specificity(glob) };
        if (bucket === undefined) claims.set(path, [claim]);
        else bucket.push(claim);
      }
      /*
        A pillar glob claiming no floor file is either a stale row or a pillar reaching outside
        the floor registry, and both are the S6 failure wearing the other registry's clothes.
        The gate-and-registries pillar is the deliberate exception the law itself names: the
        constitution and this script are that pillar's subject and carry no floor row, because
        §Foundation puts `scripts/` outside floor and plugin territory alike.
      */
      if (reached === 0 && pillar.id !== "gate-and-registries") {
        deadGlobs.push(`${pillar.id} claims ${glob}, which matches no floor file`);
      }
    }
  }

  const unowned: string[] = [];
  const contested: string[] = [];
  const byPillar = new Map<string, number>();
  for (const path of [...floorPaths].sort()) {
    const bucket = claims.get(path) ?? [];
    if (bucket.length === 0) {
      unowned.push(path);
      continue;
    }
    const best = Math.max(...bucket.map((claim) => claim.specificity));
    const winners = bucket.filter((claim) => claim.specificity === best);
    const owners = new Set(winners.map((claim) => claim.pillar));
    if (owners.size > 1) {
      contested.push(
        `${path} is claimed at equal specificity by ${list(owners)} (${list(
          winners.map((claim) => claim.glob),
        )})`,
      );
      continue;
    }
    const owner = winners[0]?.pillar ?? "";
    byPillar.set(owner, (byPillar.get(owner) ?? 0) + 1);
  }

  const faults = [...unowned.map((path) => `${path} falls inside no pillar`), ...contested];
  check(
    "S9 pillar exhaustiveness",
    faults.length === 0 && deadGlobs.length === 0,
    faults.length === 0 && deadGlobs.length === 0
      ? `${String(floorPaths.size)} floor files, each owned by exactly one of ${String(
          registries.pillars.length,
        )} pillars: ${[...byPillar]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([pillar, owned]) => `${pillar} ${String(owned)}`)
          .join(", ")}`
      : list([...faults, ...deadGlobs]),
  );
}

// ────────────────────────────────────── S10: the residual carve-out, published

/**
 * THE ONE CARVE-OUT FROM THE DISABLE RULE, WRITTEN DOWN WHERE A DIFF WILL SHOW IT.
 *
 * `cleanup: true` is the action plane's whole residual mechanism (ADR 0013 §9, `REGISTRY.md`
 * §Disable semantics): the door stays dispatchable while its plugin is off, so an administrator
 * turning a plugin off can never lock anybody out of removing what it created (D12). It is a
 * carve-out from a rule, and an open-ended carve-out is an open-ended hole — so the obligation
 * both records place on this gate is PUBLICATION: the list is printed, and growth of it is a
 * line in a gate diff and a question in review rather than a discovery months later.
 *
 * Publication alone cannot go RED, so the two things that make the list mean what it says are
 * asserted beside it:
 *
 *   A cleanup door is a REMOVAL door. The verb is the claim — `kill`, `revoke`,
 *   `deleteContainer` — and the script's verb list is the deliberate half, exactly as S7's
 *   route allowlist is. `core.terminals` already makes this ruling by hand in a comment
 *   ("claiming a lease is administration, not tidying up: NOT `cleanup`"); this is that ruling
 *   mechanized, so the next author cannot widen removal into administration by adding a flag.
 *
 *   A cleanup door belongs to a PLUGIN. An engine door publishes `source: "builtin"` and has no
 *   toggle at all (`builtin` is a named refusal class), so a residual from a disable it can
 *   never suffer is a contradiction, not a carve-out.
 */
const REMOVAL_VERBS: readonly string[] = [
  "clear",
  "close",
  "delete",
  "discard",
  "kill",
  "purge",
  "remove",
  "revoke",
  "unplace",
];

{
  const builtins = new Set(
    composed.roster.filter((entry) => entry.source === "builtin").map((entry) => entry.manifest.id),
  );
  const published: string[] = [];
  const faults: string[] = [];
  for (const [name, action] of [...composed.actions].sort(([a], [b]) => a.localeCompare(b))) {
    if (action.def.cleanup !== true) continue;
    published.push(name);
    const verb = action.def.name;
    if (!REMOVAL_VERBS.some((removal) => verb.toLowerCase().startsWith(removal))) {
      faults.push(
        `${name} declares cleanup: true but its verb is not removal (${list(REMOVAL_VERBS)})`,
      );
    }
    if (builtins.has(action.plugin.id)) {
      faults.push(
        `${name} declares cleanup: true on ${action.plugin.id}, an engine door with no toggle`,
      );
    }
  }
  check(
    "S10 residual carve-out",
    faults.length === 0,
    faults.length === 0
      ? `${String(published.length)} cleanup actions survive a disable: ${list(published)}`
      : list(faults),
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
 * of the rule — it IS the rule, and the registry in `REGISTRY.md` §Lexicon is its statute
 * (the law it serves is `AXIOMS.md` §Lexicon law).
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
  const text = readFileSync(join(repoRoot, "REGISTRY.md"), "utf8");
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
  if (rows.length === 0) throw new Error("REGISTRY.md carries no fenced `lexicon` registry");
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
  for (const doc of [
    ...docs,
    "AXIOMS.md",
    "REGISTRY.md",
    "AGENTS.md",
    "CHANGELOG.md",
    "README.md",
  ]) {
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
 *
 * RED RAISED 12,000 → 12,500 on 2026-09-01 (issue #133), and this is the defence. What crossed
 * the line was `settings.ts`: per-principal preference composition, which passes the litmus on
 * all three criteria — the sidebar drops a row before any plugin draws (bootstrap
 * circularity), the module names no plugin and no preference (neutrality), and it refuses a
 * write the assembly does not declare (arbitration). The alternative to the raise was to put
 * that composition inside `core.plugins`, which is the exact trap `setEnabled` was moved out of
 * a plugin to escape. So the engine grew by ONE module and 51 lines past the ceiling, on
 * purpose, and the number moves by the smallest amount that admits it rather than to a round
 * new headroom: the next module to cross this line gets the same argument or it does not land.
 * The WARN line does NOT move — it has been a live signal since well before this wave, and
 * silencing it would trade the review this budget exists to provoke for a green run.
 *
 * RED RAISED 12,500 → 12,700 on 2026-09-05 (ADR 0016 stage 1, #187 and #196), and this is the
 * defence. ADR 0016 T4 predicted it: "the runner's client half … lands in `packages/plugin/src`,
 * which is already past the 9,000-line WARN … this ADR predicts the defence will be needed in
 * stage 1 and does not pre-approve it." What crossed the line is not the runner (that lands in
 * `packages/web/src/isolate` and `packages/plugin-kit`, outside this budget, on purpose) but two
 * things the ADR itself obliges the engine to say: `storage.ts` records the reversal of its
 * synchronous ruling (§4, R3, T2) instead of silently changing shape, and `SessionHandle` gains
 * the terminal verbs plus the room-pipe registration a panel needs to open a terminal without
 * ever holding `host.token` (#196; ADR 0016 §3 withdraws that token from isolated plugins, so the
 * handle IS the arbitration boundary — neutrality: it names no plugin; bootstrap: the renderers
 * publish the pipe before any panel draws). Together about 170 lines. The number again moves by
 * the smallest amount that admits them; the WARN line does not move. Written by an agent on the
 * operator's direction while the operator slept: this raise is REVIEWABLE — reject it by
 * extracting plugin territory (tile-geometry.ts at 962 lines is the first candidate) instead.
 */
const PLUGIN_SRC_WARN_LINES = 9_000;
const PLUGIN_SRC_MAX_LINES = 12_700;

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

// ────────────────────────────────────────── S17: hosting neutrality

/**
 * MANIFOLD IS SELF-HOSTED SOFTWARE and the operator's instance is one deployment of it
 * (ADR 0022). Everything a self-hoster ships or runs stays provider-neutral: env names are
 * MANIFOLD_*, replication speaks S3, the image is the one any checkout builds. Exactly ONE
 * file may name a provider — the operator's own deployment workflow — so that "Clever is
 * how the operator hosts it" never becomes "manifold runs on Clever".
 *
 * A text scan, not the parser, on purpose: the subjects are a Dockerfile, YAML, shell and
 * workflow files with no AST here, and a provider NAME is a token with no structure to read.
 * The pattern is the provider's names and its env prefix, not the English adjective. This
 * file is a subject too, so every alternative is spelled with an optional separator: the
 * pattern's own source then names nothing the pattern matches.
 */
const HOSTING_PROVIDER_NOUNS = /clever[- ]?cloud|clever[- ]?apps|clever[- ]?tools|\bCC_[A-Z]/i;
const OPERATOR_DEPLOYMENT_FILE = ".github/workflows/deploy-hub.yml";

{
  const subjects = ["Dockerfile", "compose.yaml", "flake.nix"];
  for (const glob of ["infra/**", "packages/**", "scripts/**", ".github/workflows/**"]) {
    for (const hit of new Bun.Glob(glob).scanSync({ cwd: repoRoot, onlyFiles: true })) {
      const path = hit.split("\\").join("/");
      if (path.includes("/node_modules/") || path.includes("/dist/")) continue;
      if (path === OPERATOR_DEPLOYMENT_FILE) continue;
      subjects.push(path);
    }
  }
  const tainted = subjects.filter((path) =>
    HOSTING_PROVIDER_NOUNS.test(readFileSync(join(repoRoot, path), "utf8")),
  );
  check(
    "S17 hosting neutrality",
    tainted.length === 0,
    tainted.length === 0
      ? `${String(subjects.length)} shipped files name no hosting provider; only ${OPERATOR_DEPLOYMENT_FILE} may`
      : `a hosting provider is named outside the operator's deployment workflow (ADR 0022): ${list(tainted)}`,
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
/**
 * The second one, for the same reason: R10's negative rung needs to know a subscription was
 * REFUSED rather than merely unmatched, and the plane deliberately sends no refusal frame — a
 * per-topic answer would make the event plane a permission oracle. The refusal is therefore
 * only ever observable in the log, which is where the self-description obligation puts it.
 */
const SUBSCRIBE_FORBIDDEN_EVT: LogEvent = "session_subscribe_forbidden";
interface SubscribeRefusal {
  readonly principal: string;
  readonly topics: number;
}
const subscribeRefusals: SubscribeRefusal[] = [];
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
        const evt: unknown = Reflect.get(record as object, "evt");
        if (evt === SUBSCRIBE_FORBIDDEN_EVT) {
          subscribeRefusals.push({
            principal: String(Reflect.get(record as object, "principal")),
            topics: Number(Reflect.get(record as object, "topics")),
          });
          continue;
        }
        if (evt !== ACTION_EVT) continue;
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

  const ownerKey = await ownerKeyOf(dataDir);

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
    // The ledger is a modal: the row a human presses is behind the opener, so the gate opens it
    // exactly as they would (`openPluginManager`).
    if (!(await openPluginManager())) return false;
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
  await browser.launch();
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
    /*
      The door writes the spotlight into the FIRST shared room by container id (sorted), to the
      target's first connection there (room.ts `sharedContainerIds` / `writeSpotlight`). The
      viewer's previous page — R2's terminal container — stays a member of that room until the
      server processes its socket close, and on a loaded runner that lags the new page's join by
      seconds; when the terminal container's id sorts first, the spotlight lands on a connection
      that no longer has a page (#172: green locally, RED once on CI, re-run green). So the
      precondition is OBSERVED rather than assumed: the SDK peer still in the old room sees the
      viewer gone before the focus is dispatched.
    */
    const leaveWaitStarted = Date.now();
    const viewerLeft = await settles(
      () => terminalClient!.attendance.get(viewerPrincipalId) === undefined,
      10_000,
    );
    const leaveLagMs = Date.now() - leaveWaitStarted;
    if (!viewerLeft) {
      // The evidence, then the named failure (#172): what the peer still sees in the old room.
      console.log(
        `INFO  R5 precondition: the terminal room still lists the viewer after ${String(leaveLagMs)}ms: ${JSON.stringify(
          [...terminalClient!.attendance.values()].map((row) => ({
            principal: row.principal.id,
            name: row.principal.name,
            vantage: row.payload.vantage ?? null,
          })),
        )}`,
      );
      throw new Error("timed out waiting for viewer left the terminal room");
    }
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
          ? `the target's viewport centered on the named node (the old room released the viewer ${String(leaveLagMs)}ms after the new page was already painting)`
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
      JSON.stringify(composeDefaultLayout(composed.roster).layout["root"]?.ratios);
    check(
      "R4 layouts are per principal",
      untouched,
      untouched
        ? "a second principal still reads the default tree"
        : "one principal's drag moved another's workspace",
    );

    /*
      ARMING A MODE IS NOT AN EDIT. F8 publishes `vantage.arranging` and the workspace becomes
      a thing you can rearrange — but nothing has been rearranged yet, and a reader who pressed
      the key to LOOK at their arrangement must not have it move under them first. Every
      affordance the mode adds is therefore out of flow, and this is the assertion that keeps
      it that way: the same boxes, to the pixel, before and during.

      Two rects, one per leg of the tree: a sidebar row (the arrangement the sidebar panel
      holds inside itself) and the container view's content host (the arrangement the workspace
      holds). A regression in either — a bar that takes a row of the frame, a grabbable floor
      applied to a row instead of to its grip — moves one of them.
    */
    const boxes = (): Promise<string> =>
      browser!.evaluate<string>(
        `(() => {
          const box = (selector) => {
            const node = document.querySelector(selector);
            if (node === null) return null;
            const rect = node.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height].map((n) => Math.round(n * 100) / 100);
          };
          return JSON.stringify({
            row: box('.sidebar-sections > *'),
            view: box('.workspace-pane:last-child > .tile-content-host'),
            tree: box('.workspace > [data-tile-id]'),
          });
        })()`,
      );
    const pressF8 = async (): Promise<void> => {
      for (const type of ["rawKeyDown", "keyUp"]) {
        await browser!.send("Input.dispatchKeyEvent", {
          type,
          key: "F8",
          code: "F8",
          windowsVirtualKeyCode: 119,
          nativeVirtualKeyCode: 119,
        });
      }
      await sleep(400);
    };
    const restBoxes = await boxes();
    await pressF8();
    const armed = await browser.evaluate<boolean>(
      `document.querySelector('.workspace')?.classList.contains('is-arranging') === true`,
    );
    const armedBoxes = await boxes();
    await pressF8();
    const leftMode = await browser.evaluate<boolean>(
      `document.querySelector('.workspace')?.classList.contains('is-arranging') === false`,
    );
    check(
      "R4 arming arrange mode moves nothing",
      armed && leftMode && armedBoxes === restBoxes,
      !armed
        ? "F8 did not arm the mode, so the claim was never tested"
        : !leftMode
          ? "F8 armed the mode and would not leave it"
          : armedBoxes === restBoxes
            ? `sidebar row and container-view content hold their rects across F8: ${restBoxes}`
            : `arming reflowed the frame — at rest ${restBoxes}, armed ${armedBoxes}`,
    );

    /*
      THE F8 EDITOR, DRIVEN (issue #89, reworked for the palette in #104). The check above
      proves arming COSTS nothing; these prove the mode then does something, through the only
      surface a reader has — the floating toolbar `core.arrange` paints into the workspace
      overlay slot.

      Four claims, none of them reachable without a browser. The chrome is OVERLAY-ONLY: the
      wireframe exists while the mode is armed and at no other time, so its count reads zero,
      then positive, then zero again across two F8s. The toolbar is a DEVICE-LOCAL object:
      dragged elsewhere it is still there after a reload, which is the only way to tell a
      remembered position from a re-centred one. A grip TAP selects rather than nudging, which
      is what the 6px threshold is for and what a synthetic press-and-release would break
      first. And one gesture commits ONCE — the same trailing-debounce claim the divider drag
      makes above, made again for every button that survived and for every drag out of the
      palette that replaced one, because a handful of verbs wired into one optimistic-local
      write path is a handful of chances to write twice, or not at all.
    */
    interface ArrangeChrome {
      readonly toolbar: { readonly centreX: number; readonly bottomGap: number } | null;
      readonly viewportCentreX: number;
      readonly wireframes: number;
      readonly dimmed: number;
      readonly toolsEnabled: number;
      readonly toolsDisabled: number;
      /** Palette sources a reader could still drag out — the mode's other half. */
      readonly palette: number;
      readonly selected: number;
    }
    /**
     * Everything the mode paints, in one read: the bar's box, its two kinds of row, the
     * wireframe and the selection. Buttons and palette sources are counted APART because
     * they answer differently to scope — an operation on the whole arrangement goes quiet
     * inside a panel's own rows while a carry source does not (issue #104).
     */
    const arrangeChrome = (): Promise<ArrangeChrome> =>
      browser!.evaluate<ArrangeChrome>(
        `(() => {
          const bar = document.querySelector('.arrange-toolbar');
          const box = bar === null ? null : bar.getBoundingClientRect();
          const tools = Array.from(document.querySelectorAll('.arrange-toolbar-button'));
          const palette = Array.from(document.querySelectorAll('.arrange-palette-item'));
          return {
            toolbar:
              box === null
                ? null
                : { centreX: box.left + box.width / 2, bottomGap: window.innerHeight - box.bottom },
            viewportCentreX: window.innerWidth / 2,
            wireframes: document.querySelectorAll(
              '.arrange-wireframe-outline, .arrange-wireframe-spacer',
            ).length,
            dimmed: document.querySelectorAll(
              '.arrange-wireframe-outline.is-out-of-scope, .arrange-wireframe-spacer.is-out-of-scope',
            ).length,
            toolsEnabled: tools.filter((tool) => !tool.disabled).length,
            toolsDisabled: tools.filter((tool) => tool.disabled).length,
            palette: palette.filter((item) => !item.disabled).length,
            selected: document.querySelectorAll('.arrange-grip.is-selected').length,
          };
        })()`,
      );

    const atRest = await arrangeChrome();
    await pressF8();
    const armedChrome = await arrangeChrome();
    const toolbarPainted = await browser.evaluate<boolean>(
      `document.querySelector('[data-testid="toolbar-reset"]') !== null`,
    );
    await pressF8();
    const leftChrome = await arrangeChrome();
    const bottomCentre =
      armedChrome.toolbar !== null &&
      Math.abs(armedChrome.toolbar.centreX - armedChrome.viewportCentreX) <= 2 &&
      armedChrome.toolbar.bottomGap > 4 &&
      armedChrome.toolbar.bottomGap < 64;
    const overlayOnly =
      atRest.wireframes === 0 &&
      atRest.toolbar === null &&
      armedChrome.wireframes > 0 &&
      leftChrome.wireframes === 0 &&
      leftChrome.toolbar === null;
    check(
      "R4 the arrange toolbar and its wireframe belong to the mode",
      toolbarPainted && bottomCentre && overlayOnly,
      !toolbarPainted
        ? "F8 armed the mode and painted no toolbar"
        : !bottomCentre
          ? `the toolbar did not park bottom-centre: centre ${String(Math.round(armedChrome.toolbar?.centreX ?? -1))} against a viewport centre of ${String(Math.round(armedChrome.viewportCentreX))}, ${String(Math.round(armedChrome.toolbar?.bottomGap ?? -1))}px off the bottom`
          : overlayOnly
            ? `bottom-centre toolbar, and ${String(armedChrome.wireframes)} wireframe boxes that exist only while armed (0 → ${String(armedChrome.wireframes)} → 0)`
            : `the wireframe is not overlay-only: ${String(atRest.wireframes)} boxes at rest, ${String(armedChrome.wireframes)} armed, ${String(leftChrome.wireframes)} after leaving`,
    );

    /*
      WHERE THIS DEVICE PARKED IT, across a reload. The offset is the one thing about this
      plugin that is device-local (REGISTRY.md §Device-local register:
      `manifold:arrange-toolbar-position`), and a position that only survives inside one page
      is not memory — so the bar is dragged, the page reloaded, and the bar asked where it is.
    */
    await pressF8();
    const handleAt = (): Promise<{ x: number; y: number } | null> =>
      browser!.evaluate<{ x: number; y: number } | null>(
        `(() => {
           const grip = document.querySelector('.arrange-toolbar-handle');
           if (grip === null) return null;
           const box = grip.getBoundingClientRect();
           return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
         })()`,
      );
    const handle = await handleAt();
    if (handle !== null) {
      await browser.drag(
        [handle, { x: handle.x - 40, y: handle.y - 30 }, { x: handle.x - 90, y: handle.y - 70 }],
        30,
      );
    }
    await sleep(300);
    const parked = await arrangeChrome();
    const stored = await browser.evaluate<string | null>(
      `window.localStorage.getItem('manifold:arrange-toolbar-position')`,
    );
    await browser.goto(`${origin}/p/${canvasContainerId}`);
    await until(
      () => browser!.evaluate<boolean>(`document.querySelector('.react-flow') !== null`),
      20_000,
      "the canvas back after the toolbar-memory reload",
    );
    await pressF8();
    const remembered = await arrangeChrome();
    const dragged =
      parked.toolbar !== null && Math.abs(parked.toolbar.centreX - parked.viewportCentreX) > 40;
    const persisted =
      dragged &&
      stored !== null &&
      remembered.toolbar !== null &&
      Math.abs(remembered.toolbar.centreX - (parked.toolbar?.centreX ?? 0)) <= 2;
    check(
      "R4 the arrange toolbar parks where this device left it",
      persisted,
      !dragged
        ? "the toolbar did not move under a drag on its handle, so its memory was never tested"
        : persisted
          ? `dragged to x=${String(Math.round(parked.toolbar?.centreX ?? -1))} and still there after a reload, off ${stored ?? "nothing"}`
          : `dragged to x=${String(Math.round(parked.toolbar?.centreX ?? -1))}, came back at x=${String(Math.round(remembered.toolbar?.centreX ?? -1))} with ${stored ?? "no stored offset"}`,
    );
    /* Put it back under the centre and forget the key: a parked toolbar is this check's
       artefact, not a starting condition the checks after it should inherit. */
    const parkedHandle = await handleAt();
    if (parkedHandle !== null) {
      await browser.drag(
        [
          parkedHandle,
          { x: parkedHandle.x + 45, y: parkedHandle.y + 35 },
          { x: parkedHandle.x + 90, y: parkedHandle.y + 70 },
        ],
        30,
      );
    }
    await browser.evaluate(
      `(window.localStorage.removeItem('manifold:arrange-toolbar-position'), null)`,
    );

    /*
      EVERY SURVIVING TOOL, ONCE. `changed` is read off the SERVER's tree rather than off the
      DOM, so a tool that repainted optimistically and never committed fails here; `commits`
      counts the dispatches the server logged, so a tool that committed twice fails too.
      Equalize goes first, while the divider drag above still has the root's ratios skewed —
      a tool that refuses (`aim_unchanged`) rather than committing a no-op would otherwise
      read as a tool that never wrote.

      The three verbs that used to sit beside it are GONE as buttons (issue #104): Stack row,
      Stack column and Spacer are palette DRAG SOURCES now and are exercised as drags below,
      and Swap went with the pair selection it was the only consumer of.
    */
    interface ToolPress {
      readonly pressed: boolean;
      readonly changed: boolean;
      readonly commits: number;
    }
    const commitCount = (): number =>
      actionLog.filter((entry) => entry.name === "core.space.setLayout").length;
    const treeNow = async (): Promise<string> =>
      JSON.stringify(LayoutResponseSchema.parse(await getJson("/api/layout", viewer.token)).layout);
    const pressTool = async (selector: string): Promise<ToolPress> => {
      const was = await treeNow();
      const before = commitCount();
      const pressed = await browser!.evaluate<boolean>(
        `(() => { const hit = document.querySelector(${JSON.stringify(selector)});
           if (!(hit instanceof HTMLElement) || hit.matches(':disabled')) return false;
           hit.click(); return true; })()`,
      );
      const changed = pressed && (await settles(async () => (await treeNow()) !== was, 8_000));
      // The write is a TRAILING debounce: a second dispatch would land inside this window.
      await sleep(1_200);
      return { pressed, changed, commits: commitCount() - before };
    };

    const equalize = await pressTool('[data-testid="toolbar-equalize"]');

    /*
      THE PALETTE, DRAGGED (issue #104). A palette item is not a button that runs a verb on
      the root — it is a carry SOURCE whose payload is NEW STRUCTURE, and the tree it authors
      is decided by where the reader let go. So the commit-once claim the buttons used to make
      does not go away with them; it MOVES from the press to the release, and this is where it
      is made: one gesture, one `core.space.setLayout`.

      Nothing but a real browser reaches this. The payload is sealed by the source's own
      `dragstart` onto a DataTransfer, the destination is resolved from the pointer by the same
      zone kernel every other carry uses, and the write is the same trailing debounce — three
      places for one gesture to become two writes, or none.
    */
    /* Selector in, not a bare id: S15 reads gate contracts off the `[data-testid="…"]` LITERAL
       a script hands the DOM, so a helper that assembled one from a fragment would drag these
       three ids out of the register without anybody noticing. */
    const paletteAt = (selector: string): Promise<{ x: number; y: number } | null> =>
      browser!.evaluate<{ x: number; y: number } | null>(
        `(() => {
           const item = document.querySelector(${JSON.stringify(selector)});
           if (item === null) return null;
           const box = item.getBoundingClientRect();
           return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
         })()`,
      );
    /* The right-hand EDGE band of the last workspace pane: a centre aim on a leaf means
       "trade places with what is there", which is not a thing a structure can do. */
    const treeEdge = (): Promise<{ x: number; y: number } | null> =>
      browser!.evaluate<{ x: number; y: number } | null>(
        `(() => {
           const pane = document.querySelector('.workspace-pane:last-child');
           if (pane === null) return null;
           const box = pane.getBoundingClientRect();
           return { x: box.left + box.width * 0.9, y: box.top + box.height * 0.5 };
         })()`,
      );
    const spacersIn = (layout: TileLayout): number =>
      Object.values(layout).filter((tile) => tile.ref?.kind === "spacer").length;

    const beforeSpacer = LayoutResponseSchema.parse(
      await getJson("/api/layout", viewer.token),
    ).layout;
    const spacerSource = await paletteAt('[data-testid="palette-spacer"]');
    const spacerTarget = await treeEdge();
    const beforeSpacerCommits = commitCount();
    const sealed =
      spacerSource === null || spacerTarget === null
        ? []
        : await browser.dragAndDrop(spacerSource, spacerTarget);
    const seatedSpacer = await settles(async () => {
      const now = LayoutResponseSchema.parse(await getJson("/api/layout", viewer.token)).layout;
      return spacersIn(now) === spacersIn(beforeSpacer) + 1;
    }, 8_000);
    // The trailing debounce again: a second dispatch for one release lands inside this window.
    await sleep(1_500);
    const spacerCommits = commitCount() - beforeSpacerCommits;
    const carriedStructure = sealed.some(
      (payload) =>
        payload.mimeType === "application/x-manifold-item" && payload.data.includes("structure"),
    );
    check(
      "R4 a palette drag commits once at release",
      carriedStructure && seatedSpacer && spacerCommits === 1,
      spacerSource === null
        ? "the armed toolbar painted no palette to drag out of"
        : spacerTarget === null
          ? "no workspace pane to drop a structure into"
          : !carriedStructure
            ? `the palette item started a drag carrying ${sealed.map((payload) => payload.mimeType).join(", ") || "nothing"} — the source sealed no structure`
            : carriedStructure && seatedSpacer && spacerCommits === 1
              ? `one drag out of the palette seated a spacer leaf on one core.space.setLayout`
              : `the spacer ${seatedSpacer ? "landed" : "never landed"} after ${String(spacerCommits)} core.space.setLayout dispatch(es) for one release`,
    );

    /* A spacer is a TILE, not a margin: the frame paints a leaf for it and the wireframe
       outlines that leaf, which is the whole of what the `{kind:'spacer'}` ref buys. */
    const spacerPaint = await browser.evaluate<{ tile: number; frame: number }>(
      `({
         tile: document.querySelectorAll('.workspace-tile-spacer').length,
         frame: document.querySelectorAll('.arrange-wireframe-spacer').length,
       })`,
    );
    check(
      "R4 a spacer is a tile of the reader's own",
      seatedSpacer && spacerPaint.tile === 1 && spacerPaint.frame === 1,
      seatedSpacer
        ? `the dropped spacer seated ${String(spacerPaint.tile)} spacer leaf/leaves, wireframed ${String(spacerPaint.frame)}`
        : "the spacer never landed, so nothing was painted to look at",
    );

    /*
      BOTH STACKS, AND WHAT AN EMPTY ONE COSTS. Dropping a Stack out of the palette authors a
      split holding two VACANT seats — a shape that never existed before this issue, and one
      that would be a permanent hole in the frame if it took its share of the axis like any
      other pane. So the tree publishes vacancy (`is-vacant`) and the stylesheet gives it ZERO
      extent unless the reader is arranging or mid-carry: an empty seat is a target while you
      are aiming at it and an invisible nothing the rest of the time. Only a browser can say
      which, because the claim is about a painted box.
    */
    const rowSource = await paletteAt('[data-testid="palette-stack-row"]');
    const columnSource = await paletteAt('[data-testid="palette-stack-column"]');
    const stackTarget = await treeEdge();
    const sealedRow =
      rowSource === null || stackTarget === null
        ? []
        : await browser.dragAndDrop(rowSource, stackTarget);
    const columnTarget = await treeEdge();
    const sealedColumn =
      columnSource === null || columnTarget === null
        ? []
        : await browser.dragAndDrop(columnSource, columnTarget);
    /* TWO SOURCES, TWO DIRECTIONS. A palette whose items differ only in their label would
       pass every check that reads the tree afterwards, because a split is a split — so the
       thing asserted is the payload each SOURCE sealed, which is the only place the two rows
       are distinguishable before either has landed. */
    const payloadOf = (sealed: readonly { data: string }[]): string =>
      sealed.map((item) => item.data).join(" ");
    const twoDirections =
      payloadOf(sealedRow).includes(`"dir":"row"`) &&
      payloadOf(sealedColumn).includes(`"dir":"column"`);
    check(
      "R4 the palette's two stacks carry two directions",
      twoDirections,
      twoDirections
        ? "Stack row and Stack column sealed a row split and a column split out of the same palette"
        : `the two stack sources sealed ${payloadOf(sealedRow) || "nothing"} and ${payloadOf(sealedColumn) || "nothing"} — two labels over one carry`,
    );
    const vacantBox = (): Promise<{ count: number; extent: number }> =>
      browser!.evaluate<{ count: number; extent: number }>(
        `(() => {
           const panes = Array.from(document.querySelectorAll('.workspace-pane.is-vacant'));
           return {
             count: panes.length,
             extent: panes.reduce((most, pane) => {
               const box = pane.getBoundingClientRect();
               return Math.max(most, box.width, box.height);
             }, 0),
           };
         })()`,
      );
    const seatedSplit = await settles(async () => (await vacantBox()).count > 0, 8_000);
    await sleep(1_500);
    const vacantArmed = await vacantBox();
    await pressF8();
    const vacantDisarmed = await vacantBox();
    await pressF8();
    const stayedFlat = seatedSplit && vacantArmed.extent > 1 && vacantDisarmed.extent < 1;
    check(
      "R4 an empty split holds no room until the mode is armed",
      stayedFlat,
      !seatedSplit
        ? "dropping a Stack row seated no vacant pane, so the claim was never tested"
        : stayedFlat
          ? `${String(vacantArmed.count)} vacant seat(s) ${String(Math.round(vacantArmed.extent))}px across while armed, ${String(Math.round(vacantDisarmed.extent))}px disarmed`
          : `a vacant seat measured ${String(Math.round(vacantArmed.extent))}px armed and ${String(Math.round(vacantDisarmed.extent))}px disarmed — an empty split is taking room off a reader who is not arranging`,
    );

    /*
      THE PALETTE TAKES BACK WHAT IT GAVE (issue #148). One rule, both directions: the palette
      is where structure comes from and where it goes back to. Three claims, each about a
      gesture only a real browser can make:

        the ROUND TRIP: a Stack row dragged out and dropped back on the palette leaves the
          tree byte-identical and writes nothing — and the palette SAID "cancel" while the item
          was over it, which is the affordance the operator reported missing;
        the RETURN: the spacer seated above, picked up by its own grip and released on the
          palette, is gone on ONE core.space.setLayout — with the palette saying "remove" on
          the way, and the pointer loop that carried it being the panel grips' own;
        the KEY: a fresh spacer, tapped and Deleted, goes the same way through the same
          function, and the Remove tool's precondition is PAINTED — disabled with a panel
          selected, enabled with a structure selected — so "Remove never means Shelf" is a fact
          a reader can see rather than a refusal somebody has to trigger.

      The palette's state is read off `data-carry` BY THE PAGE, during the gesture, into a
      recorder the rung installs first: a drag is one atomic sequence to the driver, so a
      claim about what was painted MID-carry has to be made by the page as the carry crosses.
    */
    const paletteCarryRecorder = (): Promise<null> =>
      browser!.evaluate<null>(
        `(() => {
           const palette = document.querySelector('[data-testid="arrange-palette"]');
           window.__paletteCarries = [];
           const note = () => { const carry = palette?.dataset.carry ?? null;
             if (carry !== null && !window.__paletteCarries.includes(carry)) window.__paletteCarries.push(carry); };
           window.addEventListener('dragover', note, true);
           window.addEventListener('pointermove', note, true);
           return null;
         })()`,
      );
    const paletteCarriesSeen = (): Promise<readonly string[]> =>
      browser!.evaluate<readonly string[]>(`window.__paletteCarries ?? []`);
    const paletteCentre = await paletteAt('[data-testid="arrange-palette"]');
    const roundTripBefore = await treeNow();
    const roundTripCommits = commitCount();
    await paletteCarryRecorder();
    const roundTripSource = await paletteAt('[data-testid="palette-stack-row"]');
    if (roundTripSource !== null && paletteCentre !== null) {
      await browser.dragAndDrop(roundTripSource, paletteCentre);
    }
    await sleep(1_500);
    const roundTripAfter = await treeNow();
    const roundTripSaid = await paletteCarriesSeen();
    const roundTripped =
      roundTripSource !== null &&
      paletteCentre !== null &&
      roundTripAfter === roundTripBefore &&
      commitCount() === roundTripCommits &&
      roundTripSaid.includes("cancel");
    check(
      "R4 the palette takes a fresh item back and says so",
      roundTripped,
      roundTripSource === null || paletteCentre === null
        ? "no palette to drag out of or drop back on: the round trip was never attempted"
        : roundTripped
          ? `a Stack row dragged out and dropped back on the palette left the tree byte-identical on ${String(commitCount() - roundTripCommits)} write(s); the palette painted data-carry=${roundTripSaid.join("/")} on the way`
          : `dropped back on the palette: tree ${roundTripAfter === roundTripBefore ? "identical" : "CHANGED"}, ${String(commitCount() - roundTripCommits)} write(s), palette painted [${roundTripSaid.join(", ")}] where "cancel" was owed`,
    );

    /* The spacer the rung above seated, by its own grip: `data-tile-id` is the tree's own id. */
    const spacerLeafId = (): Promise<string | null> =>
      browser!.evaluate<string | null>(
        `(() => { const grip = Array.from(document.querySelectorAll('.arrange-grip'))
             .find((g) => g.getAttribute('aria-label') === 'Pick up the Spacer');
           return grip?.dataset.tileId ?? null; })()`,
      );
    const gripCentre = (tileId: string): Promise<{ x: number; y: number } | null> =>
      browser!.evaluate<{ x: number; y: number } | null>(
        `(() => { const grip = document.querySelector('[data-tile-id=' + ${JSON.stringify(
          JSON.stringify(tileId),
        )} + '].arrange-grip, [data-tile-id=' + ${JSON.stringify(JSON.stringify(tileId))} + '].arrange-grip-handle');
           if (grip === null) return null;
           const box = grip.getBoundingClientRect();
           return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`,
      );
    const carriedSpacer = await spacerLeafId();
    const spacerGrip = carriedSpacer === null ? null : await gripCentre(carriedSpacer);
    const returnCommits = commitCount();
    await paletteCarryRecorder();
    if (spacerGrip !== null && paletteCentre !== null) {
      await browser.drag(
        Array.from({ length: 13 }, (_unused, step) => ({
          x: spacerGrip.x + ((paletteCentre.x - spacerGrip.x) * step) / 12,
          y: spacerGrip.y + ((paletteCentre.y - spacerGrip.y) * step) / 12,
        })),
        30,
      );
    }
    const spacerReturned = await settles(async () => {
      const now = LayoutResponseSchema.parse(await getJson("/api/layout", viewer.token)).layout;
      return spacersIn(now) === spacersIn(beforeSpacer);
    }, 8_000);
    await sleep(1_500);
    const returnWrites = commitCount() - returnCommits;
    const returnSaid = await paletteCarriesSeen();
    const returned = spacerReturned && returnWrites === 1 && returnSaid.includes("remove");
    check(
      "R4 a placed structure dropped on the palette is removed on one write",
      returned,
      spacerGrip === null
        ? "the seated spacer painted no grip of its own, so it could not be picked up"
        : returned
          ? `the spacer's grip released on the palette took the spacer out on one core.space.setLayout, and the palette painted data-carry=${returnSaid.join("/")} while it was in hand`
          : `the spacer ${spacerReturned ? "went" : "STAYED"} after ${String(returnWrites)} write(s); the palette painted [${returnSaid.join(", ")}] where "remove" was owed`,
    );

    /* The key and the tool: a fresh spacer, a panel tapped first so the precondition is read
       in both states, then Delete on the structure. */
    const keySource = await paletteAt('[data-testid="palette-spacer"]');
    const keyTarget = await treeEdge();
    if (keySource !== null && keyTarget !== null) await browser.dragAndDrop(keySource, keyTarget);
    const keySeated = await settles(async () => (await spacerLeafId()) !== null, 8_000);
    await sleep(1_500);
    const removeDisabled = (): Promise<boolean | null> =>
      browser!.evaluate<boolean | null>(
        `document.querySelector('[data-testid="toolbar-remove"]')?.disabled ?? null`,
      );
    const tapAt = async (at: { x: number; y: number } | null): Promise<boolean> => {
      if (at === null) return false;
      await browser!.drag([at], 0);
      await sleep(300);
      return true;
    };
    const panelTapped = await tapAt(
      await gripCentre(
        (await browser.evaluate<string | null>(
          `document.querySelector('.arrange-grip[data-panel-id]')?.dataset.tileId ?? null`,
        )) ?? "",
      ),
    );
    const withPanel = await removeDisabled();
    const keySpacer = await spacerLeafId();
    const spacerTapped = await tapAt(keySpacer === null ? null : await gripCentre(keySpacer));
    const withStructure = await removeDisabled();
    const deleteCommits = commitCount();
    for (const type of ["rawKeyDown", "keyUp"]) {
      await browser.send("Input.dispatchKeyEvent", {
        type,
        key: "Delete",
        code: "Delete",
        windowsVirtualKeyCode: 46,
        nativeVirtualKeyCode: 46,
      });
    }
    const deleted = await settles(async () => (await spacerLeafId()) === null, 8_000);
    await sleep(1_500);
    const deleteWrites = commitCount() - deleteCommits;
    const keyed =
      keySeated &&
      panelTapped &&
      spacerTapped &&
      withPanel === true &&
      withStructure === false &&
      deleted &&
      deleteWrites === 1;
    check(
      "R4 Delete removes the selected structure, and Remove lights up only for one",
      keyed,
      !keySeated
        ? "no spacer could be seated for the key to act on"
        : !panelTapped || !spacerTapped
          ? "a grip could not be tapped, so no selection was ever made"
          : keyed
            ? `Remove read disabled=${String(withPanel)} with a panel selected and disabled=${String(withStructure)} with the spacer selected; Delete took the spacer out on one core.space.setLayout`
            : `Remove read disabled=${String(withPanel)}/${String(withStructure)} (panel/structure) where true/false was owed; Delete ${deleted ? "removed" : "did NOT remove"} the spacer on ${String(deleteWrites)} write(s)`,
    );

    /*
      TAP VERSUS DRAG, under a real pointer. Selection is Shelf's precondition and a tap is how
      it is expressed, so a press-and-release that travelled zero pixels must select and must
      NOT be read as a one-pixel move — a threshold that failed open would rearrange the
      workspace every time somebody aimed at a panel.

      ONE seat at a time since issue #104: Swap was the only verb that ever wanted a pair, so a
      tap on a second grip MOVES the selection rather than joining it, and a second tap on the
      same grip clears it. Three states, read off the live DOM — and across all of them not one
      layout write, because selecting is not arranging.
    */
    const sidebarPanel = panelRefId("core.shell", "sidebar");
    const containerViewPanel = panelRefId("core.shell", "container-view");
    const tapGrip = async (selector: string): Promise<boolean> => {
      const at = await browser!.evaluate<{ x: number; y: number } | null>(
        `(() => { const grip = document.querySelector(${JSON.stringify(selector)});
           if (grip === null) return null;
           const box = grip.getBoundingClientRect();
           return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`,
      );
      if (at === null) return false;
      await browser!.drag([at], 0);
      await sleep(250);
      return true;
    };
    const selectedSeats = async (): Promise<number> => {
      await sleep(400);
      return (await arrangeChrome()).selected;
    };
    const sidebarGrip = `.arrange-grip[data-panel-id="${sidebarPanel}"]`;
    const viewGrip = `.arrange-grip[data-panel-id="${containerViewPanel}"]`;
    const beforeTaps = commitCount();
    const reached = await tapGrip(sidebarGrip);
    const afterFirst = await selectedSeats();
    const toggled = await tapGrip(sidebarGrip);
    const afterToggle = await selectedSeats();
    const movedSeat = (await tapGrip(sidebarGrip)) && (await tapGrip(viewGrip));
    const afterMove = await selectedSeats();
    const tapCommits = commitCount() - beforeTaps;
    const tapped = reached && toggled && movedSeat;
    const selects = tapped && afterFirst === 1 && afterToggle === 0 && afterMove === 1;
    check(
      "R4 a grip tap selects and rearranges nothing",
      selects && tapCommits === 0,
      !tapped
        ? "no panel grip to tap: the mode painted no grabbable seats"
        : selects && tapCommits === 0
          ? "a tap takes one seat, a second tap on it gives it back, a tap elsewhere moves it — and not one layout write between them"
          : `taps left ${String(afterFirst)}/${String(afterToggle)}/${String(afterMove)} seats selected where 1/0/1 was owed, and made ${String(tapCommits)} layout write(s) a tap should never have made`,
    );

    /* The seat the taps above left selected IS Shelf's argument, so nothing is re-tapped here:
       a check that set up its own precondition would be proving its own setup. */
    const shelf = await pressTool('[data-testid="toolbar-shelf"]');
    const reseat = await pressTool('[data-testid="arrange-shelf-item"]');
    const reset = await pressTool('[data-testid="toolbar-reset"]');
    const presses = [
      { what: "Equalize", press: equalize },
      { what: "Shelf", press: shelf },
      { what: "Re-seat", press: reseat },
      { what: "Reset", press: reset },
    ];
    const misbehaved = presses.filter(
      (row) => !row.press.pressed || !row.press.changed || row.press.commits !== 1,
    );
    check(
      "R4 every arrange tool commits exactly once",
      afterMove === 1 && misbehaved.length === 0,
      afterMove !== 1
        ? "the shelf tool's one-seat selection could not be made, so Shelf was never pressed honestly"
        : misbehaved.length === 0
          ? `${String(presses.length)} presses — ${presses.map((row) => row.what).join(", ")} — one core.space.setLayout each`
          : `not exactly one commit: ${list(
              misbehaved.map(
                (row) =>
                  `${row.what} (${row.press.pressed ? "pressed" : "NOT pressed"}, tree ${
                    row.press.changed ? "changed" : "UNCHANGED"
                  }, ${String(row.press.commits)} dispatch(es))`,
              ),
            )}`,
    );
    await pressF8();
    /* Reset put the composed default back; the canvas is remounting behind it, and the checks
       after this one read that canvas. */
    await until(
      () => browser!.evaluate<boolean>(`document.querySelector('.react-flow') !== null`),
      20_000,
      "the canvas back after Reset",
    );

    /*
      ARRANGING A ROW IS ONE DECISION PER BOUNDARY, and nothing but a browser can say so.

      Issue #94 was three faults compounding inside one gesture, none of them visible to a
      unit test: the hit test asked "which box is the pointer in", which has no hysteresis and
      swaps a row straight back; the live preview ANIMATED, and an animating row reports its
      transform from `getBoundingClientRect`, so the gesture measured rows in flight; and the
      reorder re-inserts the grabbed node, which releases its pointer capture, so the drag
      deadended one row from where it started. The order the operator saw therefore rang and
      then stopped, and every one of those causes needs a real pointer over a real stack.

      So the assertion is about the PATH, not just the destination: sample the painted order
      after every frame, and require the sequence of orders to be strictly progressive — an
      order the stack has already left must never come back. A destination-only check passes
      on a gesture that flickered its way there, which is exactly the bug.
    */
    /* DIRECT children, deliberately, and it stayed that way through issue #104: the rail's
       arrangement is a tree now, so the descendant form would also collect the rows inside a
       `.sidebar-cluster` wrapper and inside any `.sidebar-split` a reader dropped — which are
       not the boundaries this gesture crosses. These checks arrange the rail's TOP level, and
       `>` is how the subject stays that. The transport is unchanged: the grip is a pointer
       source with its own capture, never an HTML5 drag source, so the raw mouse events below
       are still the gesture a hand makes. */
    const railOrder = (): Promise<readonly string[]> =>
      browser!.evaluate<readonly string[]>(
        `Array.from(document.querySelectorAll('.sidebar-sections > [data-section-id]'), (row) => row.dataset.sectionId)`,
      );
    const railBoxes = (): Promise<readonly { id: string; top: number; bottom: number }[]> =>
      browser!.evaluate(
        `Array.from(document.querySelectorAll('.sidebar-sections > [data-section-id]'), (row) => {
           const box = row.getBoundingClientRect();
           return { id: row.dataset.sectionId, top: box.top, bottom: box.bottom };
         })`,
      );
    /** One pointer gesture down the rail, collapsed to the orders it actually passed through. */
    const railDrag = async (x: number, path: readonly number[]): Promise<readonly string[]> => {
      const start = path[0] ?? 0;
      const seen: string[] = [(await railOrder()).join(" ")];
      await browser!.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: start });
      await browser!.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y: start,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      for (const y of path.slice(1)) {
        await browser!.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y,
          button: "left",
          buttons: 1,
        });
        await sleep(20);
        const now = (await railOrder()).join(" ");
        if (seen.at(-1) !== now) seen.push(now);
      }
      await browser!.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y: path.at(-1) ?? start,
        button: "left",
        clickCount: 1,
      });
      await sleep(400);
      return seen;
    };

    const restore = LayoutResponseSchema.parse(await getJson("/api/layout", viewer.token)).layout;
    /* The scope control is named after the panel that declared an arrangement, not after a
       word this script knows: the ref is spelled the one way a panel ref is ever spelled. */
    await pressF8();
    await browser.evaluate(
      `document.querySelector('.arrange-scope[data-panel-id="${sidebarPanel}"]')?.click()`,
    );
    await sleep(400);

    /*
      ZOOMED IN, the workspace's own OPERATIONS go quiet. Every one of them acts on the ROOT
      split, and none of them means anything while the reader is standing inside a panel's
      private arrangement — so they are disabled rather than left to refuse one by one, and the
      workspace containers they would have acted on dim behind the arrangement in hand.

      The PALETTE does not go quiet, and that asymmetry is the point of the rework (issue
      #104): an operation on the whole workspace tree is meaningless here, while a structure
      you drag lands wherever you drop it — including in the rows you are standing in. A
      palette greyed out with the buttons would be the easy mistake, and it would silently
      remove one of the three destinations a palette carry has.
    */
    const scoped = await arrangeChrome();
    const scopedRight =
      scoped.toolsDisabled > 0 &&
      scoped.toolsEnabled === 0 &&
      scoped.palette > 0 &&
      scoped.wireframes > 0 &&
      scoped.dimmed === scoped.wireframes;
    check(
      "R4 zooming into a panel's arrangement disarms the workspace's own tools",
      scopedRight,
      scoped.toolsEnabled > 0
        ? `${String(scoped.toolsEnabled)} root tool(s) still pressable from inside a panel's arrangement`
        : scoped.palette === 0
          ? "the palette went quiet with the buttons: a scoped reader can no longer drag structure into the rows they are standing in"
          : scoped.wireframes === 0
            ? "no wireframe at all while scoped in, so nothing was dimmed or left lit to read"
            : scopedRight
              ? `${String(scoped.toolsDisabled)} root tools disabled with all ${String(scoped.palette)} palette sources still live, and all ${String(scoped.wireframes)} workspace containers dimmed out of scope`
              : `${String(scoped.dimmed)} of ${String(scoped.wireframes)} wireframe boxes dimmed: the scope crumb says one thing and the paint another`,
    );
    await sleep(400);

    /*
      GLYPHLESS, and asserted on the live DOM rather than on the source: the row's TINT is the
      whole affordance now, so a grip that draws anything at all is the regression. The same
      query proves the grips exist, which is what makes the drag below a test of arranging
      rather than a test of clicking on nothing.
    */
    const grips = await browser.evaluate<{ count: number; drawn: number }>(
      `(() => {
         const all = Array.from(document.querySelectorAll('.sidebar-section-grip'));
         return { count: all.length, drawn: all.filter((g) => g.childElementCount > 0).length };
       })()`,
    );
    check(
      "R4 arrange grips are glyphless",
      grips.count >= 3 && grips.drawn === 0,
      grips.count < 3
        ? `only ${String(grips.count)} grabbable rows: the arrangement never opened`
        : grips.drawn === 0
          ? `${String(grips.count)} grabbable rows, none drawing chrome of its own`
          : `${String(grips.drawn)} of ${String(grips.count)} grips still draw a glyph`,
    );

    const laid = await railBoxes();
    const held = laid[1];
    const aim = laid[4];
    const x = 60;
    const across =
      held === undefined || aim === undefined
        ? []
        : await railDrag(
            x,
            Array.from({ length: 41 }, (_unused, step) => {
              const from = (held.top + held.bottom) / 2;
              return from + ((aim.bottom - 4 - from) * step) / 40;
            }),
          );
    /* Three rows crossed, so three orders after the one it started in — and no order twice. */
    const settled = (await railOrder()).join(" ");
    const wanted =
      held === undefined || aim === undefined
        ? ""
        : (() => {
            const ids = laid.map((row) => row.id);
            const next = ids.filter((id) => id !== held.id);
            next.splice(next.indexOf(aim.id) + 1, 0, held.id);
            return next.join(" ");
          })();
    const progressive = new Set(across).size === across.length;
    check(
      "R4 a drag across three rows lands where the pointer did, with no flip-back",
      across.length === 4 && progressive && settled === wanted,
      across.length !== 4
        ? `the drag passed through ${String(across.length)} orders, not the four a three-row crossing makes:\n      ${across.join("\n      ")}`
        : !progressive
          ? `the stack returned to an order it had already left — it fought its own reflow:\n      ${across.join("\n      ")}`
          : settled === wanted
            ? `${held?.id ?? "?"} walked past three rows into ${aim?.id ?? "?"}'s seat, one order per boundary`
            : `landed on "${settled}", not the pointer's "${wanted}"`,
    );

    /*
      THE SLOW HAND, which is the case a destination-only assertion cannot reach: hold a row
      over the boundary below it and rock across it three times. Each crossing is one decision,
      so six orders — a stack whose swap slides its own neighbour back under the pointer counts
      them by the frame instead, and never comes home.
    */
    const rocked = await railBoxes();
    const pivot = rocked[1];
    const neighbour = rocked[2];
    const rock =
      pivot === undefined || neighbour === undefined
        ? []
        : await railDrag(x, [
            (pivot.top + pivot.bottom) / 2,
            ...[0, 1, 2].flatMap(() => [
              (neighbour.top + neighbour.bottom) / 2 + 10,
              (neighbour.top + neighbour.bottom) / 2 + 10,
              pivot.top + 2,
              pivot.top + 2,
            ]),
          ]);
    check(
      "R4 a slow hand over one boundary crosses it once each way",
      rock.length === 7 && rock[0] === rock.at(-1),
      rock.length === 7 && rock[0] === rock.at(-1)
        ? "three passes over one boundary: six reorders, and the stack ends where it began"
        : `three passes produced ${String(rock.length - 1)} reorders (six expected) and ended ${
            rock[0] === rock.at(-1) ? "home" : "somewhere else"
          }`,
    );

    /*
      AND WITHOUT A POINTER AT ALL. A glyphless row still has to announce itself and answer
      the arrow keys — the whole reason the grip on a plain row stayed a labelled `<button>`
      when its icon went. Focus one by its label, press once, and the stack moves one seat.
    */
    const beforeNudge = await railOrder();
    const focused = await browser.evaluate<string | null>(
      `(() => {
         const grip = document.querySelector('.sidebar-plain > .sidebar-section-grip[aria-label]');
         if (!(grip instanceof HTMLElement)) return null;
         grip.focus();
         return grip.getAttribute('aria-label');
       })()`,
    );
    for (const type of ["rawKeyDown", "keyUp"]) {
      await browser.send("Input.dispatchKeyEvent", {
        type,
        key: "ArrowDown",
        code: "ArrowDown",
        windowsVirtualKeyCode: 40,
        nativeVirtualKeyCode: 40,
      });
    }
    await sleep(600);
    const afterNudge = await railOrder();
    const nudged =
      focused !== null &&
      afterNudge.join(" ") !== beforeNudge.join(" ") &&
      [...afterNudge].sort().join(" ") === [...beforeNudge].sort().join(" ");
    check(
      "R4 a glyphless row still announces itself and nudges",
      nudged,
      focused === null
        ? "no labelled grab surface on any plain row: the tab stop went with the glyph"
        : nudged
          ? `"${focused}" took the arrow key and the stack moved one seat`
          : `"${focused}" was focused and ArrowDown moved nothing`,
    );

    /*
      THE PALETTE LANDS IN THE RAIL, AND THE STACK IT LEAVES BEHIND FILLS UP (issues #104,
      #124). This is the operator's headline for the whole rework — "drop a stack between two
      rows, then drag rows into it" — and issue #124 is what happens when a gate asserts that
      a band RESOLVED instead of asserting WHICH PIXEL it resolved from.

      WHY THE OLD RUNGS WERE GREEN AGAINST A BROKEN SURFACE, in one paragraph, because it is
      the whole lesson. They aimed at coordinates DERIVED FROM THE TREE rather than at the
      pixels a reader aims at: the seat's centre, then `memberBox.right - 6` while the split
      held exactly ONE member. A lone member spans its whole split, and the rail resolved every
      pointer against the RAIL's box rather than the split's — so with one member the two
      geometries coincided closely enough that the trailing band still overlapped the row, and
      the rung passed. The instant a SECOND member existed the same arithmetic put both members'
      bands a third of a rail-width to the right of where they were painted (a split arranged
      into first place reserves the collapse control's width), so a reader aiming at the visible
      join got `center`, which the rail refuses in silence: no third occupant, no reorder,
      nothing. The old rungs never asked for a third occupant and never reordered inside a
      split, so nothing they asserted was false — they simply stopped one rung short of every
      gesture that was broken, and a conjunction of two true facts read as a working feature.
      The rewrite below aims ONLY at painted boxes a reader can see, and it keeps going: fill,
      pair, reorder, add a third, and drop on the middle of a row where there is no boundary
      at all.
    */
    interface RailSeat {
      readonly id: string;
      readonly top: number;
      readonly bottom: number;
      readonly left: number;
      readonly right: number;
    }
    const railSeats = (): Promise<readonly RailSeat[]> =>
      browser!.evaluate<readonly RailSeat[]>(
        `Array.from(document.querySelectorAll('.sidebar-sections > [data-section-id]'), (row) => {
           const box = row.getBoundingClientRect();
           return {
             id: row.dataset.sectionId,
             top: box.top,
             bottom: box.bottom,
             left: box.left,
             right: box.right,
           };
         })`,
      );
    interface RailSplit {
      readonly dir: string;
      readonly vacant: boolean;
      readonly seats: number;
      readonly members: number;
      /** The rows this split sits BETWEEN, which is the whole of "where it landed". */
      readonly before: string;
      readonly after: string;
      /** Every member's own painted box, in order: what a reader can actually aim at. */
      readonly memberBoxes: readonly {
        readonly id: string;
        readonly x: number;
        readonly y: number;
        readonly left: number;
        readonly right: number;
        readonly top: number;
        readonly bottom: number;
      }[];
      readonly seatBox: { readonly x: number; readonly y: number } | null;
    }
    const railSplits = (): Promise<readonly RailSplit[]> =>
      browser!.evaluate<readonly RailSplit[]>(
        `Array.from(document.querySelectorAll('.sidebar-sections .sidebar-split'), (split) => {
           const seat = split.querySelector('.sidebar-split-seat');
           const boxOf = (node) => {
             if (node === null) return null;
             const box = node.getBoundingClientRect();
             return {
               id: node.dataset.sectionId ?? '',
               x: box.left + box.width / 2, y: box.top + box.height / 2,
               left: box.left, right: box.right, top: box.top, bottom: box.bottom,
             };
           };
           return {
             dir: split.dataset.dir ?? '',
             vacant: split.dataset.vacant === 'true',
             seats: split.querySelectorAll('.sidebar-split-seat').length,
             members: split.querySelectorAll('[data-section-id]').length,
             before: split.previousElementSibling?.dataset?.sectionId ?? '',
             after: split.nextElementSibling?.dataset?.sectionId ?? '',
             memberBoxes: Array.from(split.querySelectorAll('[data-section-id]'), boxOf),
             seatBox: boxOf(seat),
           };
         })`,
      );
    /** The arrangement the rail is PAINTING, as one line, for a failure that has to be read. */
    const railPaint = (): Promise<string> =>
      browser!.evaluate<string>(
        `(() => {
           const describe = (node) => {
             if (node.classList.contains('sidebar-split')) {
               // The seat and the split's own grip are chrome, not rows: the description is the arrangement.
               const kids = Array.from(node.children).filter((k) => !k.classList.contains('sidebar-split-seat') && !k.classList.contains('sidebar-split-grip'));
               return '[' + node.dataset.dir + (node.dataset.vacant === 'true' ? ' vacant' : '')
                 + ' ' + kids.map(describe).join(' ') + ']';
             }
             if (node.dataset.sectionCluster !== undefined) {
               return '(' + Array.from(node.children).map(describe).join(' ') + ')';
             }
             return node.dataset.sectionId ?? node.className;
           };
           return Array.from(document.querySelector('.sidebar-sections').children).map(describe).join(' ');
         })()`,
      );
    /* Interpolated because the rail resolves its aim PER FRAME: a press and a jump gives the
       kernel one sample of a gesture that had no path, which is not the gesture a hand makes. */
    const grabTo = async (
      from: { x: number; y: number },
      to: { x: number; y: number },
    ): Promise<void> => {
      await browser!.drag(
        Array.from({ length: 17 }, (_unused, step) => ({
          x: from.x + ((to.x - from.x) * step) / 16,
          y: from.y + ((to.y - from.y) * step) / 16,
        })),
        25,
      );
      await sleep(600);
    };
    /** The grab surface of one row, wherever in the rail it currently sits. */
    const railGrip = (id: string): Promise<{ x: number; y: number } | null> =>
      browser!.evaluate<{ x: number; y: number } | null>(
        `(() => {
           const grip = document.querySelector('[data-section-id=' + ${JSON.stringify(
             JSON.stringify(id),
           )} + '] .sidebar-section-grip');
           if (grip === null) return null;
           const box = grip.getBoundingClientRect();
           return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
         })()`,
      );
    /** Carries the FIRST top-level row to one painted point, and answers which row that was. */
    const carryTopRow = async (to: { x: number; y: number }): Promise<string> => {
      const id = (await railSeats())[0]?.id ?? "";
      const grip = id === "" ? null : await railGrip(id);
      if (grip === null) return "";
      await grabTo(grip, to);
      return id;
    };

    const flatRail = await railSeats();
    const above = flatRail[1];
    const below = flatRail[2];
    /* A ROW split, because the rail's own stack is a column: the direction a reader drops is
       the direction its members will run in, and only the cross-axis one reads as "beside". */
    const railPalette = await paletteAt('[data-testid="palette-stack-row"]');
    const railGap =
      above === undefined || below === undefined
        ? null
        : { x: (above.left + above.right) / 2, y: (above.bottom + below.top) / 2 };
    if (railPalette !== null && railGap !== null) {
      await browser.dragAndDrop(railPalette, railGap);
    }
    const nested = await settles(async () => (await railSplits()).length > 0, 8_000);
    await sleep(1_500);
    const landed = (await railSplits())[0] ?? null;
    const wedged =
      nested &&
      landed !== null &&
      landed.dir === "row" &&
      landed.vacant &&
      landed.seats === 1 &&
      landed.members === 0 &&
      landed.before === above?.id &&
      landed.after === below?.id;
    check(
      "R4 a palette drop nests the rail's own rows",
      wedged,
      railPalette === null || railGap === null
        ? "no palette source or fewer than three rail rows: the rail drop was never attempted"
        : !nested
          ? "the rail took the palette drag and authored no split: `.sidebar-sections` claimed the drop and nothing came of it"
          : wedged
            ? `a vacant ${landed?.dir ?? "?"} split with one seat sits between "${landed?.before ?? "?"}" and "${landed?.after ?? "?"}", exactly where the pointer let go`
            : `the split landed as dir="${landed?.dir ?? "?"}" vacant=${String(landed?.vacant)} with ${String(landed?.seats)} seat(s) and ${String(landed?.members)} member(s), between "${landed?.before ?? "?"}" and "${landed?.after ?? "?"}" rather than between "${above?.id ?? "?"}" and "${below?.id ?? "?"}"`,
    );

    /*
      AND IT FILLS UP, FROM THE PIXELS THE ROWS ARE DRAWN ON. Four rungs, in the order a
      reader performs them, each aimed at a box read off the DOM in the state the previous rung
      left behind — never at a coordinate derived from the tree:

        the SEAT: the dashed rectangle an empty split paints, aimed at its centre;
        the PAIR: the lone member's own visible trailing edge, which is the join;
        the REORDER: the lead member carried onto the TRAILING member's own trailing edge, which
          has to mean "past it" — the one gesture that proves the split's interior is
          addressable rather than merely enterable;
        the THIRD: another row onto the last member's own trailing edge, because "one occupant
          at most" was the operator's report and two is not evidence against it.
    */
    const seatAim = landed?.seatBox ?? null;
    if (seatAim !== null) await carryTopRow(seatAim);
    const tookOne = await settles(async () => ((await railSplits())[0]?.members ?? 0) === 1, 8_000);
    await sleep(1_000);
    const withOne = (await railSplits())[0] ?? null;
    const lone = withOne?.memberBoxes[0] ?? null;
    if (lone !== null) await carryTopRow({ x: lone.right - 6, y: lone.y });
    const tookTwo = await settles(async () => ((await railSplits())[0]?.members ?? 0) === 2, 8_000);
    await sleep(1_000);
    const paired = (await railSplits())[0] ?? null;
    const pairOrder = (paired?.memberBoxes ?? []).map((member) => member.id).join(" ");
    const trailing = paired?.memberBoxes[1] ?? null;
    const leading = paired?.memberBoxes[0] ?? null;
    if (leading !== null && trailing !== null) {
      const grip = await railGrip(leading.id);
      if (grip !== null) await grabTo(grip, { x: trailing.right - 6, y: trailing.y });
    }
    const swapped = await settles(async () => {
      const now = (await railSplits())[0]?.memberBoxes ?? [];
      return now.length === 2 && now.map((member) => member.id).join(" ") !== pairOrder;
    }, 8_000);
    await sleep(1_000);
    const reordered = (await railSplits())[0] ?? null;
    const last = reordered?.memberBoxes.at(-1) ?? null;
    if (last !== null) await carryTopRow({ x: last.right - 6, y: last.y });
    const tookThree = await settles(
      async () => ((await railSplits())[0]?.members ?? 0) === 3,
      8_000,
    );
    await sleep(1_000);
    const trio = (await railSplits())[0] ?? null;
    const abreast =
      trio !== null &&
      trio.memberBoxes.length === 3 &&
      trio.memberBoxes.every(
        (member, index) => index === 0 || member.left >= (trio.memberBoxes[index - 1]?.right ?? 0),
      );
    const filled = tookOne && tookTwo && swapped && tookThree && abreast && trio?.dir === "row";
    check(
      "R4 a rail split fills, pairs, reorders and takes a third from its own painted edges",
      filled,
      seatAim === null
        ? "the dropped split painted no seat, so nothing could be aimed into it"
        : !tookOne
          ? `the seat refused the first row: the split still holds ${String(withOne?.members ?? 0)} member(s) — rail is "${await railPaint()}"`
          : !tookTwo
            ? `the lone member's own visible trailing edge would not take a second row: ${String(paired?.members ?? 0)} member(s) after aiming at x=${String(Math.round((lone?.right ?? 0) - 6))} on a row painted ${String(Math.round(lone?.left ?? 0))}..${String(Math.round(lone?.right ?? 0))} — rail is "${await railPaint()}"`
            : !swapped
              ? `two members abreast cannot be REORDERED: carrying "${leading?.id ?? "?"}" onto "${trailing?.id ?? "?"}"'s own trailing edge (x=${String(Math.round((trailing?.right ?? 0) - 6))} of a row painted ${String(Math.round(trailing?.left ?? 0))}..${String(Math.round(trailing?.right ?? 0))}) left the order at "${pairOrder}" — the split's bands are not over the split's rows`
              : !tookThree
                ? `the occupied split refused a THIRD row at the last member's own trailing edge: ${String(trio?.members ?? 0)} member(s) — rail is "${await railPaint()}"`
                : filled
                  ? `seat took one, its visible edge took a second, the pair reordered to "${(reordered?.memberBoxes ?? []).map((member) => member.id).join(" ")}", and a third joined abreast: "${await railPaint()}"`
                  : `three members in a dir="${trio?.dir ?? "?"}" split but not side by side: ${(trio?.memberBoxes ?? []).map((member) => `${member.id} ${String(Math.round(member.left))}..${String(Math.round(member.right))}`).join(", ")}`,
    );

    /*
      AND EVERY PIXEL OF THE RAIL MEANS SOMETHING. The rail projects its cross axis away — a
      26 px row's left and right bands would otherwise cover half the sidebar — so the kernel's
      `center` zone is not a small square inside a pane here, it is the middle HALF of every
      row in the stack. The rail refuses a centre release (there is no trade in a stack), and
      unfolded that made half of the surface a silent dead zone: a structure dropped on the
      middle of a row produced no arrangement, no notice and no explanation, which is most of
      what "stacking often doesn't apply" was.

      One drop, on the exact centre of the TALLEST row, because a palette carry is a single
      resolved point rather than a path: whatever it commits, it commits from that pixel alone.
    */
    const beforeCentre = await railPaint();
    const centreRows = await railSeats();
    const tallest = centreRows.reduce<RailSeat | null>(
      (best, seat) =>
        best === null || seat.bottom - seat.top > best.bottom - best.top ? seat : best,
      null,
    );
    /* Counted BEFORE the drop and indexed by nothing: this rail already holds the split the
       rungs above filled, so "a split appeared" is a change in how many VACANT ones there are. */
    const vacantBefore = (await railSplits()).filter((split) => split.vacant).length;
    const centrePalette = await paletteAt('[data-testid="palette-stack-row"]');
    if (tallest !== null && centrePalette !== null) {
      await browser.dragAndDrop(centrePalette, {
        x: (tallest.left + tallest.right) / 2,
        y: (tallest.top + tallest.bottom) / 2,
      });
    }
    const tookCentre = await settles(
      async () => (await railSplits()).filter((split) => split.vacant).length > vacantBefore,
      8_000,
    );
    await sleep(1_200);
    const centreSplit = (await railSplits()).find((split) => split.vacant) ?? null;
    const besideIt =
      tookCentre &&
      centreSplit !== null &&
      (centreSplit.before === tallest?.id || centreSplit.after === tallest?.id);
    check(
      "R4 the middle of a rail row takes a palette drop",
      besideIt,
      tallest === null || centrePalette === null
        ? "no rail rows or no palette source: the middle of a row was never aimed at"
        : !tookCentre
          ? `a stack dropped on the exact middle of "${tallest.id}" (${String(Math.round(tallest.bottom - tallest.top))} px tall) authored nothing: the rail was "${beforeCentre}" before and "${await railPaint()}" after, so the middle half of every row is a silent dead zone`
          : besideIt
            ? `a stack dropped on the middle of "${tallest.id}" landed beside it, between "${centreSplit?.before ?? ""}" and "${centreSplit?.after ?? ""}"`
            : `the drop authored a split, but nowhere near the row it was aimed at: between "${centreSplit?.before ?? ""}" and "${centreSplit?.after ?? ""}" rather than beside "${tallest.id}"`,
    );

    /*
      THE OTHER DIRECTION, because the palette carries two and the rail only ever proved one.
      A COLUMN split in a column rail nests rows one under the other inside one slot of the
      stack — a different tree from the flat order it looks like, and the only way to tell them
      apart is that the members share an x and stack in y.
    */
    const columnRows = await railSeats();
    const columnAbove = columnRows[1];
    const columnBelow = columnRows[2];
    const columnPalette = await paletteAt('[data-testid="palette-stack-column"]');
    if (columnPalette !== null && columnAbove !== undefined && columnBelow !== undefined) {
      await browser.dragAndDrop(columnPalette, {
        x: (columnAbove.left + columnAbove.right) / 2,
        y: (columnAbove.bottom + columnBelow.top) / 2,
      });
    }
    /* By DIRECTION, never by index: the rail carries the row split the rungs above authored,
       and which of the two comes first in the DOM is a fact about where the pointer let go. */
    const columnOf = async (): Promise<RailSplit | null> =>
      (await railSplits()).find((split) => split.dir === "column") ?? null;
    const columnLanded = await settles(async () => (await columnOf()) !== null, 8_000);
    await sleep(1_200);
    const columnSeat = (await columnOf())?.seatBox ?? null;
    if (columnSeat !== null) await carryTopRow(columnSeat);
    const columnOne = await settles(async () => ((await columnOf())?.members ?? 0) === 1, 8_000);
    await sleep(1_000);
    const columnMember = (await columnOf())?.memberBoxes[0] ?? null;
    if (columnMember !== null) {
      await carryTopRow({ x: columnMember.x, y: columnMember.bottom - 4 });
    }
    const columnTwo = await settles(async () => ((await columnOf())?.members ?? 0) === 2, 8_000);
    await sleep(1_000);
    const columnSplit = await columnOf();
    const oneUnderTheOther =
      columnSplit !== null &&
      columnSplit.memberBoxes.length === 2 &&
      (columnSplit.memberBoxes[1]?.top ?? 0) >= (columnSplit.memberBoxes[0]?.bottom ?? 0);
    const columnWorks = columnLanded && columnOne && columnTwo && oneUnderTheOther;
    check(
      "R4 the palette's Stack column nests the rail the other way",
      columnWorks,
      columnPalette === null
        ? "the armed toolbar painted no Stack column to drag out of"
        : !columnLanded
          ? `dropping a Stack column between two rows authored no column split: the rail is "${await railPaint()}"`
          : !columnOne
            ? `the column split's seat refused the first row: the rail is "${await railPaint()}"`
            : !columnTwo
              ? `the column split would not take a second row under the first: ${String(columnSplit?.members ?? 0)} member(s) — rail is "${await railPaint()}"`
              : columnWorks
                ? `two rows stacked one under the other inside one slot of the rail: "${await railPaint()}"`
                : `two members in a column split that are not stacked: ${(columnSplit?.memberBoxes ?? []).map((member) => `${member.id} y ${String(Math.round(member.top))}..${String(Math.round(member.bottom))}`).join(", ")}`,
    );

    /*
      AND THE ONE STRUCTURE THE RAIL REFUSES SAYS SO. A spacer holds ratios open, and a stack
      of rows has none for an inert leaf to hold — so it is refused, and refused OUT LOUD,
      because a silent no-op is exactly the failure the two rungs above exist to catch.
    */
    const railBeforeSpacer = await railPaint();
    const spacerPalette = await paletteAt('[data-testid="palette-spacer"]');
    const spacerRows = await railSeats();
    const spacerAbove = spacerRows[0];
    const spacerBelow = spacerRows[1];
    if (spacerPalette !== null && spacerAbove !== undefined && spacerBelow !== undefined) {
      await browser.dragAndDrop(spacerPalette, {
        x: (spacerAbove.left + spacerAbove.right) / 2,
        y: (spacerAbove.bottom + spacerBelow.top) / 2,
      });
    }
    const said = await settles(
      () =>
        browser!.evaluate<boolean>(
          `Array.from(document.querySelectorAll('[class*="notice"]'), (n) => n.textContent ?? '')
             .some((text) => text.includes('spacer'))`,
        ),
      8_000,
    );
    await sleep(600);
    const railAfterSpacer = await railPaint();
    const refusedAloud = said && railAfterSpacer === railBeforeSpacer;
    check(
      "R4 a spacer dropped in the rail is refused out loud",
      refusedAloud,
      spacerPalette === null
        ? "the armed toolbar painted no spacer to drag out of"
        : !said
          ? "a spacer dropped between two rows raised no notice: the refusal is a silent no-op"
          : refusedAloud
            ? "the rail said why a spacer has nothing to hold open, and arranged nothing"
            : `the refusal was announced and the arrangement changed anyway: "${railBeforeSpacer}" became "${railAfterSpacer}"`,
    );

    /*
      AND AN OCCUPIED STACK KEEPS THE ROOM ITS MEMBERS NEED, WHATEVER HEIGHT THE RAIL HAS
      (issue #143). Every rung above this one was green while the surface was broken, and this
      is the rung that was missing: they all ran in a 900 px window, where the rail has slack,
      and the defect only shows once the rail is asked for more rows than it has room for.

      A stack that zeroed its own `min-height` was the ONE row in the rail that could be
      squeezed below what it holds — a plain row keeps the automatic minimum a flex item is born
      with, an open section declares a floor — and a stack does not clip, so its members went on
      painting where the rail had already laid the next row. The operator saw the row below drawn
      straight over the stack's occupant, and the same zero left the stack with no band for the
      drop descent to land in, so nothing could be dragged in either.

      So the window is SQUEEZED for this one reading, which is the only state the claim lives
      in, and every split the rungs above authored is measured at once: the rail is carrying a
      vacant one, a pair and a trio, which is occupancy 0, 2 and 3 in one frame. Ink, not boxes
      — a crushed member reports a crushed BOX and paints at its natural size regardless, so a
      box-only reading is exactly how this shipped.
    */
    interface StackRoom {
      readonly dir: string;
      readonly members: number;
      readonly height: number;
      /** How far the deepest thing the stack paints falls past the stack's own bottom. */
      readonly spill: number;
      /** How far the next top-level row reaches back UP over what the stack paints. */
      readonly overlap: number;
      readonly nextId: string;
    }
    const stackRoom = (): Promise<readonly StackRoom[]> =>
      browser!.evaluate<readonly StackRoom[]>(
        `Array.from(document.querySelectorAll('.sidebar-sections .sidebar-split'), (split) => {
           const box = split.getBoundingClientRect();
           const ink = Array.from(split.querySelectorAll('*')).reduce((low, node) => {
             const rect = node.getBoundingClientRect();
             return rect.height > 0 ? Math.max(low, rect.bottom) : low;
           }, box.top);
           let unit = split;
           while (unit.parentElement !== null && !unit.parentElement.classList.contains('sidebar-sections')) {
             unit = unit.parentElement;
           }
           const next = unit.nextElementSibling;
           return {
             dir: split.dataset.dir ?? '',
             members: split.querySelectorAll('[data-section-id]').length,
             height: box.height,
             spill: ink - box.bottom,
             overlap: next === null ? 0 : ink - next.getBoundingClientRect().top,
             nextId: next === null ? '' : (next.dataset.sectionId ?? next.className),
           };
         })`,
      );
    await browser.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 460,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(1_000);
    const squeezed = await stackRoom();
    await browser.send("Emulation.clearDeviceMetricsOverride", {});
    await sleep(600);
    /* One pixel of slack for subpixel layout; the defect measured tens. */
    const crushed = squeezed.filter((stack) => stack.spill > 1 || stack.overlap > 1);
    const occupancies = [...new Set(squeezed.map((stack) => stack.members))].sort();
    const heldRoom = squeezed.length > 0 && crushed.length === 0 && occupancies.includes(0);
    check(
      "R4 an occupied rail stack keeps its members' room in a rail with none to spare",
      heldRoom,
      squeezed.length === 0
        ? "no split left in the rail to squeeze: the claim was never tested"
        : !occupancies.includes(0)
          ? `no VACANT stack among ${String(squeezed.length)} — the empty case is half the claim, since a stack that costs room while empty is the opposite bug`
          : heldRoom
            ? `${String(squeezed.length)} stack(s) at occupancy ${occupancies.join("/")} held their room in a 460 px window: ${squeezed.map((stack) => `${stack.dir}×${String(stack.members)} ${String(Math.round(stack.height))}px`).join(", ")}`
            : `${String(crushed.length)} stack(s) squeezed below what they paint: ${crushed.map((stack) => `${stack.dir}×${String(stack.members)} is ${String(Math.round(stack.height))}px tall, paints ${String(Math.round(stack.spill))}px past its own bottom, and "${stack.nextId}" is drawn ${String(Math.round(stack.overlap))}px over it`).join("; ")}`,
    );

    /*
      AND A RAIL STACK GOES BACK TO THE PALETTE TOO (issue #148): the trio the rungs above
      filled, picked up by the band on its own top edge and released on the palette, DISSOLVES
      — its three rows stay exactly where they were, flat in the rail, in their order, on one
      write. Read off the painted rail before and after rather than off the tree, because "in
      place" is a claim about where a reader sees the rows. The grip is `core.shell`'s and the
      palette is `core.arrange`'s, so this is also the one rung that proves the two plugins hand
      a carry across their boundary at all.
    */
    const trioBefore = await railPaint();
    const trioGrip = await browser.evaluate<{ x: number; y: number; members: string } | null>(
      `(() => {
         const split = Array.from(document.querySelectorAll('.sidebar-sections > .sidebar-split'))
           .find((node) => node.querySelectorAll('[data-section-id]').length === 3);
         const grip = split?.querySelector(':scope > .sidebar-split-grip');
         if (!grip) return null;
         const box = grip.getBoundingClientRect();
         return { x: box.left + box.width / 2, y: box.top + box.height / 2,
           members: Array.from(split.querySelectorAll('[data-section-id]'), (row) => row.dataset.sectionId).join(' ') };
       })()`,
    );
    const trioPalette = await paletteAt('[data-testid="arrange-palette"]');
    const trioCommits = commitCount();
    if (trioGrip !== null && trioPalette !== null) {
      await browser.drag(
        Array.from({ length: 17 }, (_unused, step) => ({
          x: trioGrip.x + ((trioPalette.x - trioGrip.x) * step) / 16,
          y: trioGrip.y + ((trioPalette.y - trioGrip.y) * step) / 16,
        })),
        25,
      );
    }
    const trioDissolved = await settles(
      async () => trioGrip !== null && !(await railPaint()).includes(`[row ${trioGrip.members}]`),
      8_000,
    );
    await sleep(1_500);
    const trioAfter = await railPaint();
    const trioWrites = commitCount() - trioCommits;
    const trioFlat =
      trioGrip !== null &&
      trioDissolved &&
      trioAfter === trioBefore.replace(`[row ${trioGrip.members}]`, trioGrip.members) &&
      trioWrites === 1;
    check(
      "R4 a rail stack dropped on the palette dissolves into its rows in place",
      trioFlat,
      trioGrip === null || trioPalette === null
        ? "no three-row stack with a grip of its own in the rail, or no palette to drop it on"
        : trioFlat
          ? `"[row ${trioGrip.members}]" became "${trioGrip.members}" where it stood, on one core.space.setLayout: "${trioAfter}"`
          : `the rail went from "${trioBefore}" to "${trioAfter}" on ${String(trioWrites)} write(s) — the three rows were owed flat, in order, in the stack's own place`,
    );

    /*
      The arrangement this check made is not this check's to leave behind: later checks read a
      rail whose rows sit where their manifests put them (R3's disable/re-enable, R9's sweep).
      So the tree goes back through the same door the drag committed through.
    */
    await dispatch("core.space.setLayout", { layout: restore }, viewer.token);
    await pressF8();
    await sleep(400);

    /*
      AND THE MODE DIES WITH ITS PLUGIN — the one failure this extraction could have shipped
      invisibly. `core.arrange` publishes `vantage.arranging`, and the FRAME reads that flag to
      blank its own tile content hosts, so an overlay that unmounted with the flag still set
      would leave every pane inert with nothing left on screen to turn it back on. Nothing but
      disabling the plugin MID-MODE can reach it: a typecheck sees two files agreeing, and a
      unit test has no frame to go dead.
    */
    await pressF8();
    const armedIntoDisable = await browser.evaluate<boolean>(
      `document.querySelector('.workspace')?.classList.contains('is-arranging') === true`,
    );
    const wentDark = await pressToggle("core.arrange", false);
    await closePluginManager();
    await sleep(800);
    const handedBack = await browser.evaluate<{
      armed: boolean;
      toolbar: boolean;
      grips: number;
      pointerEvents: string;
      reaches: boolean;
    }>(
      `(() => {
         const workspace = document.querySelector('.workspace');
         const host = document.querySelector('.workspace-pane:last-child > .tile-content-host');
         const box = host === null ? null : host.getBoundingClientRect();
         const hit =
           box === null
             ? null
             : document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
         return {
           armed: workspace?.classList.contains('is-arranging') === true,
           toolbar: document.querySelector('.arrange-toolbar') !== null,
           grips: document.querySelectorAll('.arrange-grip').length,
           pointerEvents: host === null ? 'no host' : getComputedStyle(host).pointerEvents,
           reaches: hit !== null && host !== null && host.contains(hit),
         };
       })()`,
    );
    const gaveItBack =
      wentDark &&
      armedIntoDisable &&
      !handedBack.armed &&
      !handedBack.toolbar &&
      handedBack.grips === 0 &&
      handedBack.pointerEvents === "auto" &&
      handedBack.reaches;
    check(
      "R4 disabling the editor mid-mode hands the workspace back",
      gaveItBack,
      !armedIntoDisable
        ? "the mode would not arm, so disabling it mid-mode was never tested"
        : !wentDark
          ? "the manager would not turn core.arrange off"
          : gaveItBack
            ? "the overlay took the mode with it: no toolbar, no grips, no is-arranging, and the pane under the pointer answers again"
            : `the workspace stayed ${handedBack.armed ? "armed" : "disarmed"} with ${String(handedBack.grips)} grip(s), a ${handedBack.toolbar ? "live" : "gone"} toolbar and pointer-events: ${handedBack.pointerEvents}${handedBack.reaches ? "" : " — and nothing under the pointer"}`,
    );

    const backOn = await pressToggle("core.arrange", true);
    await closePluginManager();
    await sleep(800);
    await pressF8();
    const rearmed = await browser.evaluate<boolean>(
      `document.querySelector('[data-testid="toolbar-reset"]') !== null`,
    );
    check(
      "R4 re-enabling the editor brings its key back with it",
      backOn && rearmed,
      !backOn
        ? "the manager would not turn core.arrange back on"
        : rearmed
          ? "F8 answers again the moment the plugin is back, from the same binding row"
          : "the plugin came back and F8 did not: the binding did not return with it",
    );
    await pressF8();
    await sleep(400);
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
      async () => {
        // The listing lives in the manager's modal, so the wait presses the opener first and
        // then asks for the row: the rung is about the row existing, not about who opened it.
        if (!(await openPluginManager())) return false;
        return await browser!.evaluate<boolean>(
          `document.querySelector('[data-testid="plugin-manager"] [data-plugin="core.draw"]') !== null`,
        );
      },
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
    /*
      D4′: chrome renders ABSENCE. A disabled plugin's SECTION leaves the sidebar entirely —
      no tombstone, no "disabled" body — while the Plugins section (the one ledger) still
      lists the plugin as off. The earlier form of this check asserted a placeholder inside
      a surviving section; that pinned the REJECTED design, and a check that defends
      yesterday's contract is worse than no check.
    */
    const vanished = await settles(
      () =>
        browser!.evaluate<boolean>(
          `document.querySelector('[data-section-id="machines"]') === null`,
        ),
      10_000,
    );
    // The ledger is behind the opener now, so the read presses it: what is under test is that
    // the row still says "off", not where the list is mounted.
    const ledgerOpen = await openPluginManager();
    const ledgered =
      ledgerOpen &&
      (await browser.evaluate<boolean>(
        `(() => {
        const row = document.querySelector('[data-testid="plugin-manager"] [data-plugin="core.machines"] [data-testid="plugin-manager-toggle"]');
        return row instanceof HTMLElement && row.getAttribute("aria-checked") === "false";
      })()`,
      ));
    const on = await setEnabled("core.machines", true);
    /*
      "In its manifest-ordered place" is asserted among the rows of its OWN presentation, and
      that scoping is forced by the rail being fully composed now: the stack holds the brand
      line, three creators, the status line, the key-table door and the identity footer beside
      the three bodies, all carrying `data-section-id`, so an absolute index in the whole stack
      says nothing about ordering and everything about how much chrome happens to be
      contributed. `data-presentation` is the row's resolved presentation, published in the DOM
      beside its owner, so the assertion reads: among the sections WITH bodies, Machines is
      back between Index and Plugins.
    */
    const back = await settles(
      () =>
        browser!.evaluate<boolean>(
          `(() => {
            const bodies = [...document.querySelectorAll('[data-presentation="disclosure"][data-section-id]')]
              .map((el) => el.getAttribute('data-section-id'));
            return bodies.includes('machines') && bodies.indexOf('machines') === 1;
          })()`,
        ),
      10_000,
    );
    check(
      "R3 core.machines section",
      off && vanished && ledgered && on && back,
      vanished && ledgered && back
        ? "the Machines section VANISHES on disable (manager row stays the ledger) and returns to its manifest-ordered place, no reload"
        : `vanished: ${String(vanished)}, ledgered: ${String(ledgered)}, restored in place: ${String(back)}`,
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

  {
    /*
      THE FLOOR'S OWN SEATS, BOTH WAYS (issue #113). Every other rung of R3 asks what happens
      when an ORDINARY plugin goes off. This one asks the question the hot-disable matrix never
      did: what happens to a plugin the FLOOR ITSELF dispatches.

      `packages/web/src/assembly.ts` names five doors on three plugins, and each is a step the
      workspace must complete before anybody can see it — `core.space` writes every principal's
      tile tree, including the pruned commit the engine's own placeholder makes, which is the
      D4 promise that a disabled panel plugin can never brick a layout; `core.index` mints and
      reads the containers a route resolves; `core.access` turns the owner key into an identity,
      the first thing that happens in this app. All three are `essential`, so the answer is
      REFUSAL: an administrator cannot take a door out from under the shell that dispatches it.
      The live roster's flag is asserted beside the refusal, because a manifest field that never
      reached the assembly would refuse nothing and read identically from the outside.

      The SURVIVAL half is the same claim inverted. What the floor names as data it may find
      absent stays ordinary: `FEED_TOPICS` subscribes to `core.machines`'s node, so that seat
      goes off and the workspace keeps painting — rail and canvas both — because a subscription
      to a plugin that is off simply reports nothing. Naming a DOOR is the coupling that needs
      the guarantee; naming a TOPIC is not.
    */
    const roster = PluginsResponseSchema.parse(await getJson("/api/plugins")).plugins;
    const seats = ["core.space", "core.index", "core.access"] as const;
    const broken: string[] = [];
    for (const id of seats) {
      const outcome = ActionOutcomeSchema.parse(
        await dispatch(ENGINE_SET_ENABLED_ACTION, { id, enabled: false }),
      );
      const declared = roster.find((row) => row.manifest.id === id)?.manifest.essential === true;
      if (!declared) broken.push(`${id} is not essential in the live roster`);
      if (outcome.ok) broken.push(`${id} accepted its own disable`);
      else if (outcome.denial.rule !== "refused" || outcome.denial.message !== "essential") {
        broken.push(`${id} answered ${outcome.denial.rule}/${outcome.denial.message}`);
      }
    }
    /*
      "Still painting" is the canvas AND the index row, and it is also the negative rung the
      floor would otherwise fail silently: `EssentialRecovery` replaces the whole workspace
      when any essential seat reads as off, so a canvas on screen is a live assembly whose
      essential seats are all present, not merely a page that did not crash.
    */
    const painting = async (): Promise<boolean> =>
      await browser!.evaluate<boolean>(
        `document.querySelector('.react-flow') !== null && document.querySelector('[data-section-id="index"]') !== null`,
      );
    const ordinaryOff = await setEnabled("core.machines", false);
    const survived = await settles(painting, 10_000);
    const ordinaryBack = await setEnabled("core.machines", true);
    const restored = await settles(painting, 10_000);
    check(
      "R3 floor seats: essential refuse, ordinary survive",
      broken.length === 0 && ordinaryOff && survived && ordinaryBack && restored,
      broken.length === 0
        ? `${list([...seats])} each refuse their own disable as essential; the workspace keeps painting across an ordinary coupling (core.machines) going off and coming back`
        : list(broken),
    );
  }

  // ─────────────────────────────────────────── R9: layout resilience

  {
    /*
      THE LAYOUT SYSTEM'S GATE. The sidebar, the plugin manager and a canvas terminal
      node are recomposed on `@manifold/plugin/ui`'s layout primitives, and the claim that
      recomposition makes is checkable: under ADVERSARIAL content (unbroken 60+ character
      names, eight containers, a three-deep folder chain, a long terminal name) and a
      bounded sweep of sidebar widths, four invariant classes hold in every audited
      subtree —

        overflow-x  nothing VISIBLE paints past a box whose overflow is `visible`
        clip        nothing visible is cut by `overflow: hidden` without a declared
                    `text-overflow: ellipsis`
        escape      no visible descendant leaves the audited root's own box
        overlap     no two statically-flowing siblings paint over each other

      Grounded in what an observer SEES, on purpose: content at effective opacity 0
      (the row actions' hover slide-in, the status pip's radiating ping) paints nothing,
      and a negative-margin stack (presence avatars) is a DECLARED overlap. Text is
      measured with Ranges because bare text in a childless nowrap element never shows
      up as an element box. Proven RED by planting one `min-width: max-content` on the
      index's name span: 7-8 defects per pass at every width.
    */
    const seededNames = [
      "unbroken-adversarial-container-name-".padEnd(72, "x"),
      "W".repeat(68),
      "a".padEnd(64, "b") + "-end",
      "🚀".repeat(24) + "-emoji-heavy-container-name",
      "r9-home",
      "MixedCASE-" + "m".repeat(58),
      "dots.and.dashes-" + "d".repeat(52),
      "final-container-" + "f".repeat(48),
    ];
    const seededIds: string[] = [];
    for (const [slot, name] of seededNames.entries()) {
      const made = ActionOutcomeSchema.parse(
        await dispatch("core.index.createContainer", {
          name,
          discipline: slot % 3 === 0 ? "composition" : "canvas",
        }),
      );
      if (!made.ok) throw new Error(`R9 seed container refused: ${made.denial.message}`);
      seededIds.push(ContainerResponseSchema.parse(made.result).container.id);
    }
    const folderIds: string[] = [];
    let folderParent: string | null = null;
    for (let depth = 0; depth < 3; depth++) {
      const name = `folder-depth-${String(depth)}-`.padEnd(62, "q");
      const made = ActionOutcomeSchema.parse(
        await dispatch("core.index.createFolder", { name, parentId: folderParent }),
      );
      if (!made.ok) throw new Error(`R9 seed folder refused: ${made.denial.message}`);
      const { items } = IndexResponseSchema.parse(made.result);
      const row = items.find((item) => item.kind === "folder" && item.name === name);
      if (row === undefined || row.kind !== "folder") throw new Error("R9 folder not listed");
      folderIds.push(row.id);
      folderParent = row.id;
    }
    for (const [slot, id] of [seededIds[0], seededIds[1]].entries()) {
      const moved = ActionOutcomeSchema.parse(
        await dispatch("core.index.moveEntry", {
          item: { kind: "container", id },
          parentId: folderIds[2],
          index: slot,
        }),
      );
      if (!moved.ok) throw new Error(`R9 seed move refused: ${moved.denial.message}`);
    }
    /* R3's cleanup leg killed the world-setup terminal, so R9 opens its own — which is
       also what puts a LIVE canvas terminal node's chrome on screen for the audit. */
    const r9Terminal = await canvasClient.openTerminal({
      elementId: crypto.randomUUID(),
      cols: 80,
      rows: 24,
      machineId,
    });
    const longRename = ActionOutcomeSchema.parse(
      await dispatch("core.terminals.rename", {
        terminalId: r9Terminal.id,
        name: "terminal-with-an-extremely-long-unbroken-name-".padEnd(78, "t"),
      }),
    );
    if (!longRename.ok) throw new Error(`R9 terminal rename refused: ${longRename.denial.message}`);

    // Expand the folder chain through the section's own device-local memory, then land
    // on the terminal's composition so a canvas terminal node's chrome is on screen.
    await browser.evaluate(
      `localStorage.setItem('manifold:expanded-index-folders', ${JSON.stringify(
        JSON.stringify(folderIds.map((id) => `folder:${id}`)),
      )})`,
    );
    await browser.goto(`${origin}/p/${r9Terminal.containerId}`);
    await until(
      () =>
        browser!.evaluate<boolean>(
          `document.querySelectorAll('[data-testid="sidebar-list"] .index-item').length >= 10`,
        ),
      20_000,
      "R9 seeded rows in the sidebar",
    );
    await until(
      () =>
        browser!.evaluate<boolean>(
          `document.querySelector('.composition-leaf .node-titlebar') !== null`,
        ),
      20_000,
      "R9 terminal node chrome mounted",
    );

    /** One audited subtree, four invariant classes; returns one row per defect. */
    const auditExpression = (rootSelector: string): string => `((rootSelector) => {
      const TOL = 1.5;
      const root = document.querySelector(rootSelector);
      if (root === null) return [{ cls: 'harness', sel: 'no ' + rootSelector, detail: '' }];
      const rootRect = root.getBoundingClientRect();
      const defects = [];
      const describe = (el) => {
        const bits = [];
        let node = el;
        for (let hop = 0; node !== null && node !== root.parentElement && hop < 4; hop++) {
          const cls = typeof node.className === 'string' && node.className !== ''
            ? '.' + node.className.trim().split(/\\s+/).slice(0, 2).join('.')
            : '';
          bits.unshift(node.tagName.toLowerCase() + cls);
          node = node.parentElement;
        }
        return bits.join(' > ');
      };
      const hidden = (el) => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return true;
        const rect = el.getBoundingClientRect();
        return rect.width <= 0 && rect.height <= 0;
      };
      const paintOpacity = (el) => {
        let opacity = 1;
        for (let node = el; node !== null && node !== root.parentElement; node = node.parentElement) {
          opacity *= parseFloat(getComputedStyle(node).opacity || '1');
          if (opacity < 0.05) return 0;
        }
        return opacity;
      };
      const clipRect = (raw, from, stop) => {
        const rect = { left: raw.left, right: raw.right, top: raw.top, bottom: raw.bottom };
        let node = from;
        while (node !== null && node !== stop && node !== root.parentElement) {
          const style = getComputedStyle(node);
          if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
            const clip = node.getBoundingClientRect();
            rect.left = Math.max(rect.left, clip.left);
            rect.right = Math.min(rect.right, clip.right);
            rect.top = Math.max(rect.top, clip.top);
            rect.bottom = Math.min(rect.bottom, clip.bottom);
          }
          node = node.parentElement;
        }
        return rect;
      };
      const paintedBeyond = (el) => {
        const box = el.getBoundingClientRect();
        const past = (rect) => rect.right - box.right > TOL || box.left - rect.left > TOL;
        const range = document.createRange();
        const textPast = (holder) => {
          for (const node of holder.childNodes) {
            if (node.nodeType !== Node.TEXT_NODE || node.textContent.trim() === '') continue;
            range.selectNodeContents(node);
            if (past(clipRect(range.getBoundingClientRect(), holder, el))) return true;
          }
          return false;
        };
        if (paintOpacity(el) > 0 && textPast(el)) return el;
        for (const kid of el.querySelectorAll('*')) {
          if (hidden(kid) || paintOpacity(kid) === 0) continue;
          if (past(clipRect(kid.getBoundingClientRect(), kid.parentElement, el))) return kid;
          if (textPast(kid)) return kid;
        }
        return null;
      };
      for (const el of [root, ...root.querySelectorAll('*')]) {
        if (!(el instanceof HTMLElement) || hidden(el)) continue;
        const style = getComputedStyle(el);
        const over = el.scrollWidth - el.clientWidth;
        if (el.clientWidth > 0 && over > TOL) {
          const beyond = paintedBeyond(el);
          if (beyond !== null && style.overflowX === 'visible') {
            defects.push({ cls: 'overflow-x', sel: describe(el), detail: over + 'px past via ' + describe(beyond) });
          } else if (
            beyond !== null &&
            style.textOverflow !== 'ellipsis' &&
            style.overflowX !== 'auto' &&
            style.overflowX !== 'scroll'
          ) {
            defects.push({ cls: 'clip', sel: describe(el), detail: over + 'px cut, no ellipsis, via ' + describe(beyond) });
          }
        }
        if (el !== root && paintOpacity(el) > 0) {
          const rect = clipRect(el.getBoundingClientRect(), el.parentElement, null);
          if (rect.right - rootRect.right > TOL || rootRect.left - rect.left > TOL) {
            defects.push({ cls: 'escape', sel: describe(el), detail: 'x ' + Math.round(rect.left) + '..' + Math.round(rect.right) + ' outside ' + Math.round(rootRect.left) + '..' + Math.round(rootRect.right) });
          }
        }
        const kids = [...el.children].filter((kid) => {
          if (!(kid instanceof HTMLElement) || hidden(kid) || paintOpacity(kid) === 0) return false;
          const kidStyle = getComputedStyle(kid);
          if (kidStyle.position === 'absolute' || kidStyle.position === 'fixed') return false;
          if (kidStyle.display === 'contents') return false;
          return parseFloat(kidStyle.marginLeft) >= 0 && parseFloat(kidStyle.marginRight) >= 0;
        });
        for (let a = 0; a < kids.length; a++) {
          for (let b = a + 1; b < kids.length; b++) {
            const ra = kids[a].getBoundingClientRect();
            const rb = kids[b].getBoundingClientRect();
            const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
            const y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
            if (x > TOL && y > TOL) {
              defects.push({ cls: 'overlap', sel: describe(kids[a]) + ' × ' + describe(kids[b]), detail: Math.round(x) + '×' + Math.round(y) + 'px' });
            }
          }
        }
      }
      return defects;
    })(${JSON.stringify(rootSelector)})`;

    interface LayoutDefect {
      readonly cls: string;
      readonly sel: string;
      readonly detail: string;
    }
    /* The sidebar pane rides its flex basis, so the sweep drives the SAME knob the
       divider drag writes — presentation only, restored after the last pass. */
    const sweepWidths = [168, 208, 248, 288, 336, 400];
    const auditRoots = [".sidebar", '[data-testid="plugin-manager"]', ".composition-leaf"];
    /*
      The manager's listing is one of the audited roots and it now lives in a MODAL, so the
      sweep opens it and leaves it open for every width: a root that is not mounted answers no
      defects, which would quietly retire a third of this rung.
    */
    const managerAudited = await openPluginManager();
    const broken: string[] = managerAudited
      ? []
      : ["the plugin manager's listing would not open, so its layout went unaudited"];
    let passes = 0;
    for (const width of sweepWidths) {
      await browser.evaluate(
        `(() => {
          const pane = document.querySelector('.workspace-pane:has(> .tile-content-host > .sidebar)');
          if (pane !== null) pane.style.flex = '0 0 ${String(width)}px';
          return null;
        })()`,
      );
      await sleep(150);
      for (const auditRoot of auditRoots) {
        passes += 1;
        const defects = await browser.evaluate<readonly LayoutDefect[]>(auditExpression(auditRoot));
        for (const defect of defects.slice(0, 3)) {
          broken.push(
            `${String(width)}px ${auditRoot} ${defect.cls}: ${defect.sel} (${defect.detail})`,
          );
        }
      }
    }
    await browser.evaluate(
      `(() => {
        const pane = document.querySelector('.workspace-pane:has(> .tile-content-host > .sidebar)');
        if (pane !== null) pane.style.removeProperty('flex');
        return null;
      })()`,
    );
    /*
      And closed again, so the rungs below meet the workspace as they always did: an open modal
      holds focus and swallows keystrokes, which is exactly what R10's plane traffic and the key
      dispatch rungs are about.
    */
    await closePluginManager();
    check(
      "R9 layout resilience",
      broken.length === 0,
      broken.length === 0
        ? `${String(passes)} audits (${String(sweepWidths.length)} widths × ${String(auditRoots.length)} roots) under adversarial content: no undeclared overflow, no clip without ellipsis, no child escapes, no sibling overlap`
        : list(broken),
    );
  }

  // ─────────────────────────────────────────── R10: the plane is live

  /**
   * THE EVENT PLANE, END TO END, WITH A STOPWATCH.
   *
   * A2 says every capability is reachable identically by a human and an agent, and wave 1
   * broke it with a timer: a polled surface tells an agent "the world may have changed up to
   * five seconds ago", so two principals watching one workspace observed two different
   * instants. Wave 2's claim is that they now observe the same one. That claim is only
   * falsifiable with THREE real connections and a clock:
   *
   *   the BROWSER, whose feeds hold subscriptions and whose sidebar is the UI under test;
   *   an SDK peer, subscribed to the same node, which is where the FRAME itself is read;
   *   a third principal, mutating through the HTTP action door — so `actor` names somebody
   *     neither observer could have confused with itself.
   *
   * What makes this more than "the UI updated": the feed's own report seam says HOW it
   * updated. `reads.event` moving while `reads.timer` stays at zero is the difference between
   * a subscription and a poll that happened to be fast, and no DOM assertion can tell them
   * apart. A timer tick anywhere in the window fails this check even if the pixels are right.
   *
   * The negative rung is the admission half. Subscribing is a READ-GRANT question answered by
   * the same authority the resolve door uses, and a collection (`manifold://plugin/<owner>`)
   * has no container above it — so it is in nobody's subtree, and a container-scoped token
   * asking for one is refused. It is refused SILENTLY: no refusal frame, because a per-topic
   * answer would turn the plane into a permission oracle, and no socket close, because the
   * ask is legal to make. "Received nothing" alone would also be true of a subscription that
   * merely never matched, so the refusal is read where the plane actually states it — the
   * structured log.
   */
  {
    const INDEX_TOPIC: ManifoldRef = { kind: "plugin", pluginId: "core.index" };
    const indexUri = formatManifoldUri(INDEX_TOPIC);

    /* Connection two: an SDK peer that asked for the same node the browser's feed asked for. */
    const peer = new SessionClient({
      url: wsUrl,
      containerId: canvasContainerId,
      token: ownerKey,
    });
    await peer.connect();
    const heard: ServerEvent[] = [];
    const releasePeer = peer.subscribe([INDEX_TOPIC], (event) => {
      heard.push(event);
    });

    /* Connection three: a scoped token, whose subscription must be refused and stay silent. */
    const confined = await mint({
      principal: { name: "axiom-confined", kind: "agent" },
      caps: ["containers:read", "containers:write"],
      containerId: canvasContainerId,
    });
    const intruder = new SessionClient({
      url: wsUrl,
      containerId: canvasContainerId,
      token: confined.token,
    });
    await intruder.connect();
    const overheard: ServerEvent[] = [];
    const releaseIntruder = intruder.subscribe([INDEX_TOPIC], (event) => {
      overheard.push(event);
    });
    const refusalsBefore = subscribeRefusals.length;

    /* The mutator: a third principal, so `actor` is somebody's name and not an assumption. */
    const mutator = await mint({
      principal: { name: "axiom-mutator", kind: "agent" },
      caps: ["containers:read", "containers:write"],
    });

    /* The browser back on a container page, with the index section painted and the feeds up. */
    await browser.goto(`${origin}/p/${canvasContainerId}`);
    await until(
      () => browser!.evaluate<boolean>("window.__manifoldFeeds !== undefined"),
      20_000,
      "R10 feed report seam installed",
    );
    /*
      A feed's key is `<resource>|<restartKey>` — a feed partitioned by route is a different
      feed — so the join is on the head, which is the name the budget table and the feed
      vocabulary both use.
    */
    const FEED_REPORT = `window.__manifoldFeeds().filter((feed) => feed.key.split("|")[0] === ${JSON.stringify(INDEX_RESOURCE)})`;
    const indexFeed = async (): Promise<PolledFeedReport | null> =>
      await browser!.evaluate<PolledFeedReport | null>(
        `${FEED_REPORT}.find((feed) => feed.subscribers > 0) ?? ${FEED_REPORT}[0] ?? null`,
      );
    const subscribed = await settles(async () => {
      const feed = await indexFeed();
      return feed !== null && feed.mode === "events" && feed.topics.includes(indexUri);
    }, 20_000);
    const armed = await indexFeed();
    check(
      "R10 the browser subscribes instead of polling",
      subscribed && armed !== null && armed.intervalMs === null && armed.reads.initial >= 1,
      armed === null
        ? `no live ${INDEX_RESOURCE} feed on an open container page`
        : `mode ${armed.mode}, topics ${list(armed.topics)}, interval ${String(armed.intervalMs)}, reads ${JSON.stringify(armed.reads)}`,
    );

    const timersBefore = armed?.reads.timer ?? 0;
    const eventsBefore = armed?.reads.event ?? 0;
    const name = `axiom-plane-${crypto.randomUUID().slice(0, 8)}`;
    const nameLiteral = JSON.stringify(name);
    const painted = `[...document.querySelectorAll('[data-testid="sidebar-list"] .index-item')].some((row) => (row.textContent ?? '').includes(${nameLiteral}))`;
    check(
      "R10 the row is not there yet",
      !(await browser.evaluate<boolean>(painted)),
      `no sidebar row reads "${name}" before anybody creates it`,
    );

    const opened = Date.now();
    const created = ActionOutcomeSchema.parse(
      await dispatch("core.index.createContainer", { name }, mutator.token),
    );
    if (!created.ok) throw new Error(`R10 createContainer refused: ${created.denial.message}`);
    const createdId = ContainerResponseSchema.parse(created.result).container.id;

    const frameArrived = await settles(() => heard.length > 0, 2_000);
    const frame = heard[0];
    const frameRight =
      frameArrived &&
      frame !== undefined &&
      formatManifoldUri(frame.topic) === indexUri &&
      frame.kind === "container_created" &&
      frame.actor === mutator.principal.id;
    check(
      "R10 the event frame arrives",
      frameRight && heard.length === 1,
      frame === undefined
        ? "an SDK peer subscribed to core.index heard nothing when a container was created"
        : `${String(heard.length)} frame(s): topic ${formatManifoldUri(frame.topic)}, kind ${frame.kind}, actor ${String(frame.actor)} (mutator is ${mutator.principal.id})`,
    );

    /*
      ONE SECOND, and the clock starts at the dispatch rather than at the frame: what A2 owes
      an operator is the interval between somebody acting and everybody seeing it, not the
      interval between two pieces of manifold's own plumbing.
    */
    const reflected = await settles(() => browser!.evaluate<boolean>(painted), 1_000);
    const elapsed = Date.now() - opened;
    const after = await indexFeed();
    const noTimerTick = after !== null && after.reads.timer === timersBefore;
    const byEvent = after !== null && after.reads.event > eventsBefore;
    check(
      "R10 the UI reflects it inside a second, on an event",
      reflected && noTimerTick && byEvent,
      after === null
        ? "the index feed vanished mid-check"
        : `painted ${reflected ? "in" : "NOT within"} ${String(elapsed)}ms; reads.event ${String(eventsBefore)} → ${String(after.reads.event)}, reads.timer ${String(timersBefore)} → ${String(after.reads.timer)}`,
    );

    /*
      The negative. The scoped socket asked for the same collection and was refused at the
      subscribe door, so the second mutation reaches it not at all — while the peer that WAS
      admitted hears it, which is what makes this a refusal rather than a dead plane.
    */
    heard.length = 0;
    const renamed = ActionOutcomeSchema.parse(
      await dispatch(
        "core.index.renameContainer",
        { containerId: createdId, name: `${name}-again` },
        mutator.token,
      ),
    );
    if (!renamed.ok) throw new Error(`R10 renameContainer refused: ${renamed.denial.message}`);
    const peerHeardAgain = await settles(() => heard.length > 0, 3_000);
    const refused = subscribeRefusals
      .slice(refusalsBefore)
      .some((refusal) => refusal.principal === confined.principal.id && refusal.topics >= 1);
    check(
      "R10 a scoped token is refused a foreign collection, silently",
      overheard.length === 0 && refused && peerHeardAgain && intruder.status === "open",
      overheard.length > 0
        ? `a token scoped to one container heard ${String(overheard.length)} event(s) on ${indexUri}`
        : refused
          ? `refused at subscribe and logged; socket still ${intruder.status}, and the admitted peer heard ${String(heard.length)} frame(s)`
          : `no ${SUBSCRIBE_FORBIDDEN_EVT} for ${confined.principal.id}: the subscription may have been accepted and merely unmatched`,
    );

    releasePeer();
    releaseIntruder();
    peer.close();
    intruder.close();
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
    const ownerKey = await ownerKeyOf(dataDir);
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
  await teardownServer(server, dataDir);
  cleanupDist();
}

console.log(
  failures.length === 0
    ? "\naxioms gate: GREEN"
    : `\naxioms gate: RED\n${failures.map((failure) => ` - ${failure}`).join("\n")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
