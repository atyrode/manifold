import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  ISOLATE_MAX_ARTIFACT_BYTES,
  PLUGIN_BUNDLE_STYLES_FILE,
  PluginBundleSchema,
  unscopedRule,
  type PluginBundle,
  type PluginInstallRefusal,
} from "@manifold/protocol";
import { sha256Hex, type PluginInstallRow } from "./stores.ts";

/**
 * THE ARTIFACT'S JOURNEY (ADR 0016 §8 stage 2, #152): from a URL or a path to a verified,
 * extracted bundle on disk — and back off it. Everything here is the install door's hands;
 * the door's verdicts (namespace, replace, grant) stay in the host, which owns the roster.
 *
 * Fail-closed at every step (R8). The bytes are hashed BEFORE they are parsed and NOTHING is
 * written before the hash equals the pin the installer gave: a mismatch leaves no file behind
 * to wonder about. At boot the stored file is re-hashed and re-extracted from the verified
 * bundle, so an edited `server.js` beside it is overwritten rather than run — the bundle is
 * the one artifact of record, and the extracted files are a cache of it.
 */

/** Under the data dir: where a bare path source is accepted from (an operator's drop box). */
export const PLUGIN_UPLOADS_DIR = "plugin-uploads";
/**
 * Under the data dir: `authored/<id>/` holds the files an unpacked plugin is built from and
 * `authored/.build/<id>.manifold-plugin.json` is what the hub packed them into (ADR 0025 §4)
 * — the second box a path source is accepted from, because the rebuild loop installs through
 * the same door with the same reader as an operator's drop.
 */
export const AUTHORED_DIR = "authored";
export const AUTHORED_BUILD_DIR = ".build";
/** Under the data dir: `plugins/<id>/<sha256>.manifold-plugin.json` beside `plugins/<id>/<sha256>/`. */
export const PLUGINS_DIR = "plugins";
export const PLUGIN_BUNDLE_SUFFIX = ".manifold-plugin.json";
/** One artifact fetch's bound: a registry that does not answer is a refusal, never a hang. */
export const ARTIFACT_FETCH_TIMEOUT_MS = 30_000;

/**
 * A refused install, as a class from `PLUGIN_INSTALL_REFUSALS` and its detail. The message is
 * the door's wire wording, `<class>: <detail>`, so a caller that throws this needs no second
 * formatting step to answer `{ refused }`.
 */
export class InstallRefusal extends Error {
  constructor(
    readonly reason: PluginInstallRefusal,
    readonly detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "InstallRefusal";
  }
}

export interface ArtifactRequest {
  /** An `https://` URL, or an absolute path. */
  readonly source: string;
  /** The pin, lowercase hex: the sha256 of the artifact's exact bytes. */
  readonly sha256: string;
  readonly dataDir: string;
  /** Injected for tests; the door fetches with the runtime's `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /**
   * `MANIFOLD_PLUGIN_DEV_PATHS=1`: accept an absolute path anywhere on this host rather than
   * only under `<dataDir>/plugin-uploads/`. A development convenience, off by default, because
   * "install the file at this path" is a read of any file root can name.
   */
  readonly devPaths?: boolean;
  /**
   * The door's own verdicts, asked ONCE the bundle is parsed and BEFORE anything is written:
   * a namespace squat, an id already installed. Returning a refusal writes nothing.
   */
  readonly admit?: (bundle: PluginBundle) => InstallRefusal | null;
}

/** A bundle the door admitted: parsed, pinned, and on disk. */
export interface InstalledArtifact {
  readonly bundle: PluginBundle;
  readonly sha256: string;
  readonly bundlePath: string;
  /** The directory holding every member of `bundle.files`, one file per member. */
  readonly dir: string;
}

/** Where an install lands, decided by id and hash alone so the layout is a function. */
export function installLayout(
  dataDir: string,
  pluginId: string,
  sha256: string,
): { readonly bundlePath: string; readonly dir: string } {
  const home = resolve(dataDir, PLUGINS_DIR, pluginId);
  return { bundlePath: join(home, `${sha256}${PLUGIN_BUNDLE_SUFFIX}`), dir: join(home, sha256) };
}

function tooLarge(bytes: number): InstallRefusal {
  return new InstallRefusal(
    "artifact_unreadable",
    `artifact is ${String(bytes)} bytes, over the ${String(ISOLATE_MAX_ARTIFACT_BYTES)}-byte cap`,
  );
}

/**
 * The bytes at `source`. `https://` only over the network — a bundle is code, and code fetched
 * in the clear is code somebody on the path chose — and paths only from the uploads drop box
 * unless dev paths are on. Both bounded by `ISOLATE_MAX_ARTIFACT_BYTES` before the whole body
 * is held in memory.
 */
export async function readArtifact(request: ArtifactRequest): Promise<Uint8Array> {
  if (request.source.startsWith("https://")) return fetchArtifact(request);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(request.source)) {
    throw new InstallRefusal("artifact_unreadable", "only https:// sources are fetched");
  }
  return readArtifactFile(request);
}

async function fetchArtifact(request: ArtifactRequest): Promise<Uint8Array> {
  const fetchImpl = request.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(request.source, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(ARTIFACT_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "fetch failed";
    throw new InstallRefusal("artifact_unreadable", detail);
  }
  if (!response.ok) {
    throw new InstallRefusal("artifact_unreadable", `HTTP ${String(response.status)}`);
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > ISOLATE_MAX_ARTIFACT_BYTES) {
    throw tooLarge(Number(declared));
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new InstallRefusal("artifact_unreadable", "empty response");
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > ISOLATE_MAX_ARTIFACT_BYTES) {
        await reader.cancel();
        throw tooLarge(received);
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof InstallRefusal) throw error;
    const detail = error instanceof Error ? error.message : "read failed";
    throw new InstallRefusal("artifact_unreadable", detail);
  }
  return Buffer.concat(chunks, received);
}

function readArtifactFile(request: ArtifactRequest): Uint8Array {
  if (!isAbsolute(request.source)) {
    throw new InstallRefusal("artifact_unreadable", "a path source must be absolute");
  }
  let path: string;
  try {
    // The REAL path, so a symlink dropped into the uploads box cannot point out of it.
    path = realpathSync(request.source);
  } catch {
    throw new InstallRefusal("artifact_unreadable", "no readable file at that path");
  }
  if (request.devPaths !== true) {
    const uploads = resolve(request.dataDir, PLUGIN_UPLOADS_DIR);
    const inside = [uploads, resolve(request.dataDir, AUTHORED_DIR)].some((box) => {
      let real: string;
      try {
        real = realpathSync(box);
      } catch {
        real = box;
      }
      return path.startsWith(`${real}${sep}`);
    });
    if (!inside) {
      throw new InstallRefusal(
        "artifact_unreadable",
        `path sources are accepted only under ${uploads}${sep} (or with MANIFOLD_PLUGIN_DEV_PATHS=1)`,
      );
    }
  }
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error("not a file");
    size = stat.size;
  } catch {
    throw new InstallRefusal("artifact_unreadable", "no readable file at that path");
  }
  if (size > ISOLATE_MAX_ARTIFACT_BYTES) throw tooLarge(size);
  return readFileSync(path);
}

/** The bytes as a bundle, or `artifact_invalid` naming the first zod path that failed. */
export function parseBundle(bytes: Uint8Array): PluginBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new InstallRefusal("artifact_invalid", "artifact is not JSON");
  }
  const parsed = PluginBundleSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"} ${issue.message}`)
    .join("; ");
  throw new InstallRefusal("artifact_invalid", detail);
}

/**
 * S13 AT LOAD (ADR 0025 §7, #258): a bundle that declares `entry.styles` is admitted only if
 * every selector of its `styles.css` is rooted at the plugin's own class, by the one walk the
 * gate reads the tree with (`@manifold/protocol` `unscopedRule`). The refusal names the first
 * selector and its line, which is what an author fixes. A sheet nobody declared is not read:
 * the loader never fetches it either.
 */
export function stylesheetRefusal(bundle: PluginBundle): InstallRefusal | null {
  if (bundle.manifest.entry.styles !== true) return null;
  const encoded = bundle.files[PLUGIN_BUNDLE_STYLES_FILE] ?? "";
  const offender = unscopedRule(
    Buffer.from(encoded, "base64").toString("utf8"),
    bundle.manifest.id,
  );
  if (offender === null) return null;
  return new InstallRefusal(
    "stylesheet_unscoped",
    `${PLUGIN_BUNDLE_STYLES_FILE}:${String(offender.line)} ${offender.reason === "classless" ? "a rule with no class reaches every node" : "the leftmost compound is not this plugin's root class"} (${offender.selector})`,
  );
}

/**
 * Decodes every member into `dir`, one file per member. Names are flat by schema
 * (`PLUGIN_BUNDLE_FILE_PATTERN`), so `join` cannot leave the directory. Existing files are
 * overwritten: at boot this is what makes the extracted tree a cache of the verified bundle
 * rather than a second artifact somebody could edit.
 */
export function extractBundle(bundle: PluginBundle, dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, encoded] of Object.entries(bundle.files)) {
    writeFileSync(join(dir, name), Buffer.from(encoded, "base64"), { mode: 0o600 });
  }
}

/**
 * Fetch, pin, parse, admit, write — in that order, and the order is the contract: a hash
 * mismatch or a refused bundle writes nothing. The pin is compared on the EXACT bytes read,
 * never on a re-serialization. The host's verdict (namespace, replace) comes before the
 * sheet's, so a squat is named as a squat.
 */
export async function installArtifact(request: ArtifactRequest): Promise<InstalledArtifact> {
  const bytes = await readArtifact(request);
  const sha256 = sha256Hex(bytes);
  if (sha256 !== request.sha256) {
    throw new InstallRefusal("hash_mismatch", `artifact hashes to ${sha256}`);
  }
  const bundle = parseBundle(bytes);
  const refusal = request.admit?.(bundle) ?? stylesheetRefusal(bundle);
  if (refusal !== null) throw refusal;
  const { bundlePath, dir } = installLayout(request.dataDir, bundle.manifest.id, sha256);
  mkdirSync(dirname(bundlePath), { recursive: true, mode: 0o700 });
  writeFileSync(bundlePath, bytes, { mode: 0o600 });
  extractBundle(bundle, dir);
  return { bundle, sha256, bundlePath, dir };
}

export type BundleVerdict =
  | { readonly ok: true; readonly bundle: PluginBundle; readonly dir: string }
  | { readonly ok: false; readonly refusal: PluginInstallRefusal; readonly detail: string };

/**
 * BOOT RE-VERIFICATION (R8). The stored file is re-hashed against the row's pin, re-parsed, and
 * re-extracted; any failure is a verdict the host puts on the roster (`enable_failed`,
 * `install.refusal`) and never loads. A bundle whose manifest names a different id than the
 * row is refused too: the row is the installer's consent and the manifest may not move it.
 * The sheet meets its rule again here, so a row admitted before the rule existed — or under a
 * looser one — is refused fail-closed rather than painted.
 */
export function verifyInstalledBundle(row: PluginInstallRow): BundleVerdict {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(row.bundlePath);
  } catch {
    return { ok: false, refusal: "artifact_unreadable", detail: `no bundle at ${row.bundlePath}` };
  }
  const sha256 = sha256Hex(bytes);
  if (sha256 !== row.sha256) {
    return { ok: false, refusal: "hash_mismatch", detail: `bundle hashes to ${sha256}` };
  }
  let bundle: PluginBundle;
  try {
    bundle = parseBundle(bytes);
  } catch (error) {
    if (error instanceof InstallRefusal) {
      return { ok: false, refusal: error.reason, detail: error.detail };
    }
    throw error;
  }
  if (bundle.manifest.id !== row.pluginId) {
    return {
      ok: false,
      refusal: "artifact_invalid",
      detail: `bundle manifest is "${bundle.manifest.id}", the install is "${row.pluginId}"`,
    };
  }
  const unscoped = stylesheetRefusal(bundle);
  if (unscoped !== null) return { ok: false, refusal: unscoped.reason, detail: unscoped.detail };
  const dir = row.bundlePath.slice(0, -PLUGIN_BUNDLE_SUFFIX.length);
  extractBundle(bundle, dir);
  return { ok: true, bundle, dir };
}

/**
 * Deletes one install's files: the bundle and its extracted directory, then the plugin's home
 * when nothing else is left in it. The row and the plugin's storage are not this function's:
 * the row is the store's, and storage is `purge`'s.
 */
export function removeInstall(row: Pick<PluginInstallRow, "bundlePath">): void {
  const dir = row.bundlePath.slice(0, -PLUGIN_BUNDLE_SUFFIX.length);
  rmSync(dir, { recursive: true, force: true });
  rmSync(row.bundlePath, { force: true });
  const home = dirname(row.bundlePath);
  if (existsSync(home) && readdirSync(home).length === 0) rmSync(home, { recursive: true });
}
