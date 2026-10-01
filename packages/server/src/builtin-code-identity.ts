import { createHash } from "node:crypto";
import { createReadStream, existsSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sourceEntries = ["assembly.ts", "plugin-host.ts"].map((name) =>
  fileURLToPath(new URL(name, import.meta.url)),
);
let admittedCodeIdentity: Promise<string> | undefined;
const builtins = new Set(builtinModules);

/** Exact source dependency bytes, independent of git/deployment labels and checkout location. */
export async function sourceCodeIdentity(entries: readonly string[], root: string): Promise<string> {
  const files = new Map<string, string>();
  const seen = new Set<string>();
  const scan = async (candidate: string): Promise<void> => {
    const file = realpathSync(candidate);
    if (seen.has(file)) return;
    seen.add(file);
    const extension = extname(file);
    const loader = extension === ".tsx" ? "tsx" : extension === ".jsx" ? "jsx"
      : extension === ".ts" || extension === ".mts" || extension === ".cts" ? "ts"
      : extension === ".js" || extension === ".mjs" || extension === ".cjs" ? "js" : null;
    const hash = createHash("sha256");
    if (loader === null) {
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      files.set(relative(root, file), hash.digest("hex"));
      return;
    }
    const source = await Bun.file(file).text();
    hash.update(source);
    files.set(relative(root, file), hash.digest("hex"));
    for (const imported of new Bun.Transpiler({ loader }).scanImports(source)) {
      if (imported.path.startsWith("node:") || imported.path.startsWith("bun:") || imported.path === "bun" || builtins.has(imported.path)) continue;
      let dependency: string;
      try {
        dependency = Bun.resolveSync(imported.path, dirname(file));
      } catch (error) {
        throw new Error(`builtin code dependency unavailable: ${imported.path} from ${relative(root, file)}`, { cause: error });
      }
      if (dependency.startsWith("node:") || dependency.startsWith("bun:") || dependency === "bun" || builtins.has(dependency)) continue;
      await scan(dependency);
    }
  };
  for (const entry of entries) await scan(resolve(entry));
  const hash = createHash("sha256").update(`source\0${Bun.version}\0`);
  for (const [file, digest] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    hash.update(JSON.stringify([file, digest]));
  return hash.digest("hex");
}

/** One immutable admission identity per process; compiled hubs hash their actual executable. */
export function builtinCodeIdentity(): Promise<string> {
  return admittedCodeIdentity ??= (async () => {
    if (!import.meta.url.includes("/$bunfs/") && !import.meta.url.includes("/~BUN/")) {
      if (!sourceEntries.every((file) => existsSync(file)))
        throw new Error("builtin source entry unavailable");
      return sourceCodeIdentity(sourceEntries, sourceRoot);
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(process.execPath)) hash.update(chunk);
    return hash.digest("hex");
  })();
}
