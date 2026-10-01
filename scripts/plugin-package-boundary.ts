import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PluginManifestSchema } from "../packages/protocol/src/index.ts";

const publicApis: Readonly<Record<string, true>> = {
  "@manifold/protocol": true,
  "@manifold/scene": true,
  "@manifold/sdk": true,
  "@manifold/plugin": true,
  "@manifold/plugin/hooks": true,
  "@manifold/plugin/ui": true,
  "@manifold/ui": true,
};
const authorApis: Readonly<Record<string, true>> = {
  "@manifold/plugin-kit": true,
  "@manifold/plugin-kit/server": true,
  "@manifold/plugin-kit/web": true,
};
const authorTestTools: Readonly<Record<string, true>> = {
  "@manifold/plugin-kit/pack": true,
  "@manifold/plugin-kit/hub": true,
  "@manifold/plugin-kit/install": true,
};

/** The import consumer's mode matters: a parent/part contract is still platform-free. */
export function pluginApiImportAllowed(
  specifier: string,
  consumer: { authored: boolean; contract: boolean; test: boolean },
): boolean {
  if (consumer.contract) {
    return (
      specifier === "@manifold/protocol" ||
      specifier === "@manifold/scene" ||
      specifier === "@manifold/sdk" ||
      specifier === "@manifold/plugin"
    );
  }
  return (
    publicApis[specifier] === true ||
    (consumer.authored &&
      (authorApis[specifier] === true || (consumer.test && authorTestTools[specifier] === true)))
  );
}

export type PluginPackageProblem =
  | "missing_manifest"
  | "unregistered_manifest"
  | "invalid_authored_manifest"
  | "reserved_authored_identity"
  | "default_composed_authored_identity"
  | "duplicate_authored_identity"
  | "mixed_manifest_classes"
  | "missing_authored_server"
  | "missing_authored_web";

/** Consume an ordinary package directory and declarations discovered by the gate's AST walk.
 * No package-id/path exemptions: manifest.json is the existing pack author's declaration. */
export function classifyPluginPackage(
  directory: string,
  declaredIds: readonly string[],
  composedIds: ReadonlySet<string>,
  priorOptionalIds: ReadonlySet<string>,
): { optional: boolean; ids: readonly string[]; problems: PluginPackageProblem[] } {
  const manifestPath = join(directory, "manifest.json");
  if (!existsSync(manifestPath)) {
    const problems: PluginPackageProblem[] = [];
    if (declaredIds.length === 0) problems.push("missing_manifest");
    if (declaredIds.some((id) => !composedIds.has(id))) problems.push("unregistered_manifest");
    return { optional: false, ids: declaredIds, problems };
  }
  try {
    const manifest = PluginManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    const problems: PluginPackageProblem[] = [];
    if (manifest.id.startsWith("core.") || manifest.id.startsWith("engine."))
      problems.push("reserved_authored_identity");
    if (composedIds.has(manifest.id)) problems.push("default_composed_authored_identity");
    if (priorOptionalIds.has(manifest.id)) problems.push("duplicate_authored_identity");
    if (declaredIds.length !== 0) problems.push("mixed_manifest_classes");
    if (
      manifest.entry?.server &&
      !statSync(join(directory, "server.ts"), { throwIfNoEntry: false })?.isFile()
    )
      problems.push("missing_authored_server");
    if (
      manifest.entry?.web &&
      !statSync(join(directory, "web.tsx"), { throwIfNoEntry: false })?.isFile() &&
      !statSync(join(directory, "web.ts"), { throwIfNoEntry: false })?.isFile()
    )
      problems.push("missing_authored_web");
    return { optional: true, ids: [manifest.id], problems };
  } catch {
    return { optional: true, ids: [], problems: ["invalid_authored_manifest"] };
  }
}
