import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AnyActionDef } from "@manifold/plugin";
import { compilePlugin, type CompiledPlugin } from "@manifold/plugin-kit/pack";
import {
  HARDENED_CONTRACT_VERSION,
  PluginManifestSchema,
  type PluginBundle,
} from "@manifold/protocol";
import { z } from "zod";
import type { ServerPluginDef } from "./plugin-host.ts";
import { extractBundle, parseBundle, PLUGIN_BUNDLE_SUFFIX } from "./plugin-installs.ts";
import { sha256Hex } from "./stores.ts";

/**
 * TRUSTED FIRST-PARTY HARDENING (ADR 0053 §7, issue #259).
 *
 * The distribution may run one of its OWN registered plugins behind the same isolate boundary
 * an installer can choose for a stranger's. Selection is the operator's
 * (`MANIFOLD_HARDENED_PLUGINS`), never a request's, and it authorizes nothing an installation
 * could not: the build compiles this checkout's registered source through the one plugin
 * compiler, binds the artifact to the registered definition by id, manifest and published
 * doors, and hands it to the ordinary supervisor. No install row, install provenance or
 * reserved-namespace admission is involved, so the `core.`/`engine.` upload refusals stand.
 *
 * Every failure is fail-closed and names the plugin: an unknown id, an id this build has no
 * source recipe for, a compile error or a binding mismatch stops the boot rather than running
 * the plugin in-realm instead.
 */

/**
 * Where one first-party plugin's source is, as the composition root names it. Only the
 * composition root may name plugin source (REGISTRY.md §Foundation), so a recipe never
 * arrives from configuration or a request.
 */
export interface HardenedSourceRecipe {
  /** The plugin package directory: relative entries and shared modules resolve from here. */
  readonly pluginDir: string;
  /** The module that starts the server guest over the plugin's own definition. */
  readonly server: string;
  /** The module whose default export is the plugin's portable web definition. */
  readonly web: string;
}

/** One compiled first-party definition: the exact artifact bytes, parsed, and their pin. */
export interface TrustedBuild {
  readonly bytes: Uint8Array;
  readonly bundle: PluginBundle;
  readonly sha256: string;
}

/** Under the data dir: `first-party/<id>/<sha256>/`, never an installation's directory. */
const FIRST_PARTY_DIR = "first-party";

/** Where a build-time artifact of one id lives in an artifact directory. */
export function trustedArtifactFile(dir: string, id: string): string {
  return join(dir, `${id}${PLUGIN_BUNDLE_SUFFIX}`);
}

/**
 * Resolves every selected id, in order, to an artifact bound to its registered definition.
 *
 * A source checkout (development, the Docker hub) compiles the recipe here with the one plugin
 * compiler. A packaged hub that carries no source tree (the Nix `bun build --compile` binary)
 * names `artifacts`: the directory its OWN build wrote with the same compiler over the same
 * recipes (`scripts/build-first-party.ts`), shipped beside the binary. Either way the artifact
 * must bind to this binary's registered definition, and an id with no registration, recipe or
 * artifact fails by name.
 */
export async function compileTrustedBuilds(
  ids: readonly string[],
  defs: readonly ServerPluginDef[],
  recipes: ReadonlyMap<string, () => HardenedSourceRecipe>,
  artifacts?: string,
): Promise<readonly TrustedBuild[]> {
  const builds: TrustedBuild[] = [];
  for (const id of ids) {
    const def = defs.find((candidate) => candidate.manifest.id === id);
    if (def === undefined)
      throw new Error(`MANIFOLD_HARDENED_PLUGINS: "${id}" is not a plugin this build registers`);
    const resolveRecipe = recipes.get(id);
    if (resolveRecipe === undefined)
      throw new Error(`MANIFOLD_HARDENED_PLUGINS: "${id}" has no hardened source recipe`);
    let compiled: CompiledPlugin;
    try {
      if (artifacts === undefined) {
        const recipe = resolveRecipe();
        compiled = await compilePlugin(recipe.pluginDir, {
          source: { manifest: def.manifest, server: recipe.server, web: recipe.web },
        });
      } else {
        const bytes = readFileSync(trustedArtifactFile(artifacts, id));
        compiled = { bytes, sha256: sha256Hex(bytes) };
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${id}: hardened build failed: ${detail}`, { cause: error });
    }
    const build = {
      bytes: compiled.bytes,
      bundle: parseBundle(compiled.bytes),
      sha256: compiled.sha256,
    };
    assertTrustedBinding(def, build);
    builds.push(build);
  }
  return builds;
}

/**
 * The artifact must BE the registered definition: the same id and the byte-for-byte parsed
 * manifest, a server half to supervise, the current contract, and — when it has a web half —
 * the portable Worker entry a hardened browser runs. A definition carrying element payload
 * schemas cannot cross: those schemas are host-side code and would silently stop policing.
 */
export function assertTrustedBinding(def: ServerPluginDef, build: TrustedBuild): void {
  const { manifest } = build.bundle;
  const id = def.manifest.id;
  const refuse = (why: string): never => {
    throw new Error(`${id}: hardened build refused: ${why}`);
  };
  // Through JSON, as the artifact carried it: an absent optional and an `undefined` one agree.
  const registered: unknown = JSON.parse(JSON.stringify(PluginManifestSchema.parse(def.manifest)));
  if (!isDeepStrictEqual(manifest, registered))
    refuse("its manifest is not the registered manifest");
  if (build.bundle.hardenedContract !== HARDENED_CONTRACT_VERSION)
    refuse(`it is not hardened contract ${String(HARDENED_CONTRACT_VERSION)}`);
  if (manifest.entry.server !== true) refuse("it has no server half to supervise");
  if (manifest.entry.web !== undefined && manifest.entry.worker !== true)
    refuse("its web half has no portable Worker entry");
  if (Object.keys(def.elements ?? {}).length > 0)
    refuse("element payload schemas cannot run outside the host");
}

/**
 * The loaded child must publish exactly the registered doors: the same names in the same
 * order, the same caller capabilities, delegates, scope, cleanup carve-out, requirements,
 * trace policy, run access and projections, and the same input and result JSON Schema the
 * roster publishes. A guest cannot widen or narrow the authority its definition declares.
 */
export function assertLoadedBinding(def: ServerPluginDef, loaded: ServerPluginDef): void {
  const published = (action: AnyActionDef): Record<string, unknown> => ({
    name: action.name,
    title: action.title,
    caps: action.caps,
    delegates: action.delegates ?? [],
    scope: action.scope ?? "workspace",
    requirements: action.requirements ?? [],
    trace: action.trace ?? null,
    cleanup: action.cleanup === true,
    runAccess: action.runAccess ?? null,
    agentJustification: action.agentJustification ?? null,
    resultProjection: action.resultProjection ?? null,
    input: z.toJSONSchema(action.input, { io: "input" }),
    result: z.toJSONSchema(action.result, { io: "output" }),
  });
  if (
    !isDeepStrictEqual(def.actions.map(published), loaded.actions.map(published)) ||
    (def.harness === undefined) !== (loaded.harness === undefined)
  )
    throw new Error(
      `${def.manifest.id}: hardened build refused: its doors are not the registered doors`,
    );
}

/**
 * Extracts a trusted build under its own id-and-pin directory, replacing any earlier build of
 * that id: the tree is a cache of the artifact this process compiled, never an input.
 */
export function extractTrustedBuild(dataDir: string, build: TrustedBuild): string {
  const home = join(dataDir, FIRST_PARTY_DIR, build.bundle.manifest.id);
  rmSync(home, { recursive: true, force: true });
  const dir = join(home, build.sha256);
  extractBundle(build.bundle, dir);
  return dir;
}
