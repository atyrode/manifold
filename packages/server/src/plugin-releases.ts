import {
  MAX_PLUGIN_CHANGELOG_BYTES,
  MAX_PLUGIN_UPDATE_FAMILY,
  PluginIdSchema,
  PluginReleaseFeedSchema,
  PluginReleaseSourceSchema,
  type PluginReleaseArtifact,
} from "@manifold/protocol";
import { PLUGIN_BUNDLE_CHANGELOG_FILE } from "@manifold/plugin-kit/pack";
import { z } from "zod";
import {
  InstallRefusal,
  PLUGIN_BUNDLE_SUFFIX,
  readArtifact,
  type VerifiedPluginArtifact,
} from "./plugin-installs.ts";

/**
 * WHERE A NEWER RELEASE IS FOUND, and what its publisher says about it (#238). Discovery is
 * metadata only: a declared feed or GitHub's latest release names artifacts by URL and PIN,
 * and nothing here fetches, parses or runs a candidate bundle — the coordinator inspects each
 * artifact through the ordinary pinned reader and takes what a candidate IS from the verified
 * bundle's own manifest. Every byte here arrives through `readArtifact`, so a feed, a GitHub
 * API answer and an external changelog meet the same HTTPS public-destination policy and
 * drop-box rule a bundle does, under bounds far below a bundle's.
 */

/** A feed, or GitHub's release document, is a short list of pins: never a bundle-sized read. */
export const MAX_RELEASE_FEED_BYTES = 256 * 1024;

export interface PluginMetadataRequest {
  /** Resolves a drop-box path source exactly as an install does. */
  readonly dataDir: string;
  readonly signal?: AbortSignal;
  /** Injected for tests; destination policy still runs before this seam. */
  readonly fetchImpl?: typeof fetch;
}

export interface PluginReleaseRequest extends PluginMetadataRequest {
  /** The installed family root the release is for, and so the root artifact's id. */
  readonly id: string;
  /** The root's declared `manifest.releases`. */
  readonly source: string;
}

export interface DiscoveredPluginRelease {
  /**
   * The publisher's label for its preferred feed entry, or null from GitHub, whose tag names
   * no bundle: only a verified bundle's own manifest says which version a candidate is.
   */
  readonly version: string | null;
  /** The root first, then its declared family members; each id once, every pin lowercase. */
  readonly artifacts: readonly PluginReleaseArtifact[];
}

export interface PluginChangelog {
  readonly text: string;
  /** `CHANGELOG.md` for the packed member, else the manifest's declared link. */
  readonly source: string;
}

/**
 * Unpinned metadata through the one artifact reader, its refusal named for what was being read.
 * Never `devPaths`: a location a publisher declared reaches only as far as the operator's
 * default, whatever the operator's own installs may.
 */
async function readMetadata(
  what: string,
  source: string,
  maxBytes: number,
  request: PluginMetadataRequest,
): Promise<Uint8Array> {
  const { dataDir, signal, fetchImpl } = request;
  try {
    return await readArtifact({
      source,
      dataDir,
      maxBytes,
      ...(signal === undefined ? {} : { signal }),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  } catch (error) {
    if (error instanceof InstallRefusal) {
      throw new InstallRefusal(error.reason, `${what}: ${error.detail}`);
    }
    throw error;
  }
}

function utf8(bytes: Uint8Array, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InstallRefusal("artifact_invalid", `${what} is not UTF-8 text`);
  }
}

function json(bytes: Uint8Array, what: string): unknown {
  const text = utf8(bytes, what);
  try {
    return JSON.parse(text);
  } catch {
    throw new InstallRefusal("artifact_invalid", `${what} is not JSON`);
  }
}

/** The first schema issue, as the one line a publisher fixes. */
function schemaRefusal(what: string, error: z.ZodError): InstallRefusal {
  const [issue] = error.issues;
  const path = issue?.path.map(String).join(".") || "(root)";
  return new InstallRefusal(
    "artifact_invalid",
    `${what}: ${path} ${issue?.message ?? "is not a release"}`,
  );
}

/**
 * One release's artifacts as the coordinator receives them: at most a family's worth, each id
 * once, pins lowercase — and from a remote document https only, so a stranger's feed cannot
 * point the review at a file in the operator's drop box.
 */
function pinned(
  what: string,
  artifacts: readonly PluginReleaseArtifact[],
  remote: boolean,
): PluginReleaseArtifact[] {
  if (artifacts.length > MAX_PLUGIN_UPDATE_FAMILY) {
    throw new InstallRefusal(
      "artifact_invalid",
      `${what} names ${String(artifacts.length)} artifacts, over the ${String(MAX_PLUGIN_UPDATE_FAMILY)}-member family cap`,
    );
  }
  const seen = new Set<string>();
  return artifacts.map(({ id, url, sha256 }) => {
    if (seen.has(id)) {
      throw new InstallRefusal("artifact_invalid", `${what} names ${id} more than once`);
    }
    seen.add(id);
    if (remote && !url.startsWith("https://")) {
      throw new InstallRefusal(
        "artifact_invalid",
        `${what} is remote, so ${id} must be an https:// source`,
      );
    }
    return { id, url, sha256: sha256.toLowerCase() };
  });
}

const GITHUB_RELEASES_PATH =
  /^\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/releases(?:\/latest)?\/?$/;

/** `https://github.com/<owner>/<repo>/releases[/latest]` as its REST latest-release URL. */
function githubLatestRelease(source: string): string | null {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }
  const match = GITHUB_RELEASES_PATH.exec(url.pathname);
  const owner = match?.[1];
  const repo = match?.[2];
  if (owner === undefined || repo === undefined || /^\.+$/.test(repo)) return null;
  return `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
}

/** Only the fields a pin is made from; the rest of GitHub's document is not read. */
const GitHubReleaseSchema = z.object({
  assets: z
    .object({
      name: z.string().min(1).max(255),
      browser_download_url: PluginReleaseSourceSchema,
      digest: z.string().nullable().optional(),
    })
    .array(),
});
type GitHubAsset = z.infer<typeof GitHubReleaseSchema>["assets"][number];

/**
 * GitHub's latest-release document as pinned artifacts. One asset is the root whatever its
 * name; several are a family, each named `<plugin-id>.manifold-plugin.json`, of which the
 * root's own name is required and only the root's descendants are taken — anything else in
 * the release (checksums, other plugins) is not this family's. Every taken asset must carry
 * GitHub's own `sha256:` digest: without one there is nothing to pin, and downloading the
 * bytes to hash them would pin whatever was served, not what was published.
 */
export function releaseFromGitHub(id: string, document: unknown): DiscoveredPluginRelease {
  const what = "GitHub latest release";
  const release = GitHubReleaseSchema.safeParse(document);
  if (!release.success) throw schemaRefusal(what, release.error);
  const { assets } = release.data;
  const chosen: { readonly id: string; readonly asset: GitHubAsset }[] = [];
  const only = assets.length === 1 ? assets[0] : undefined;
  if (only !== undefined) {
    chosen.push({ id, asset: only });
  } else {
    const rootName = `${id}${PLUGIN_BUNDLE_SUFFIX}`;
    const root = assets.find((asset) => asset.name === rootName);
    if (root === undefined) {
      throw new InstallRefusal(
        "artifact_invalid",
        `${what} has ${String(assets.length)} assets and none is named ${rootName}`,
      );
    }
    chosen.push({ id, asset: root });
    for (const asset of assets) {
      if (
        asset === root ||
        !asset.name.startsWith(`${id}.`) ||
        !asset.name.endsWith(PLUGIN_BUNDLE_SUFFIX)
      ) {
        continue;
      }
      const member = asset.name.slice(0, -PLUGIN_BUNDLE_SUFFIX.length);
      if (PluginIdSchema.safeParse(member).success) chosen.push({ id: member, asset });
    }
  }
  const artifacts = chosen.map(({ id: member, asset }) => {
    const digest = /^sha256:([0-9a-fA-F]{64})$/.exec(asset.digest ?? "")?.[1];
    if (digest === undefined) {
      throw new InstallRefusal(
        "artifact_invalid",
        `${what} asset ${JSON.stringify(asset.name)} publishes no sha256 digest to pin`,
      );
    }
    return { id: member, url: asset.browser_download_url, sha256: digest };
  });
  return { version: null, artifacts: pinned(what, artifacts, true) };
}

/**
 * The release a root's `manifest.releases` declares. A `github.com/<owner>/<repo>/releases`
 * page is read through GitHub's latest-release API; any other source is a JSON feed in
 * publisher-preferred order, and its FIRST entry is the release — never a version comparison,
 * because versions are the publisher's opaque labels.
 */
export async function discoverPluginRelease(
  request: PluginReleaseRequest,
): Promise<DiscoveredPluginRelease> {
  const api = githubLatestRelease(request.source);
  if (api !== null) {
    const what = "GitHub latest release";
    const bytes = await readMetadata(what, api, MAX_RELEASE_FEED_BYTES, request);
    return releaseFromGitHub(request.id, json(bytes, what));
  }
  const what = "release feed";
  const bytes = await readMetadata(what, request.source, MAX_RELEASE_FEED_BYTES, request);
  const feed = PluginReleaseFeedSchema.safeParse(json(bytes, what));
  if (!feed.success) throw schemaRefusal(what, feed.error);
  const preferred = feed.data[0]!;
  return {
    version: preferred.version,
    artifacts: pinned(
      what,
      [
        { id: request.id, url: preferred.url, sha256: preferred.sha256 },
        ...(preferred.family ?? []),
      ],
      request.source.startsWith("https://"),
    ),
  };
}

/**
 * What a verified candidate says it changes. The packed `CHANGELOG.md` first — the candidate's
 * own pinned words — else the manifest's `links.changelog`, fetched under the same policy and
 * a changelog's bound; null only when the bundle carries neither. A declared link that fails
 * is a refusal the review shows, never an empty changelog standing in for one. Text is strict
 * UTF-8 either way.
 */
export async function readPluginChangelog(
  artifact: VerifiedPluginArtifact,
  request: PluginMetadataRequest,
): Promise<PluginChangelog | null> {
  const packed = artifact.bundle.files[PLUGIN_BUNDLE_CHANGELOG_FILE];
  if (packed !== undefined) {
    // The encoded length bounds the decoded size, so an oversized member is never decoded.
    const bytes =
      packed.length > 4 * Math.ceil(MAX_PLUGIN_CHANGELOG_BYTES / 3)
        ? null
        : Buffer.from(packed, "base64");
    if (bytes === null || bytes.byteLength > MAX_PLUGIN_CHANGELOG_BYTES) {
      throw new InstallRefusal(
        "artifact_invalid",
        `${PLUGIN_BUNDLE_CHANGELOG_FILE} is over the ${String(MAX_PLUGIN_CHANGELOG_BYTES)}-byte changelog cap`,
      );
    }
    return {
      text: utf8(bytes, PLUGIN_BUNDLE_CHANGELOG_FILE),
      source: PLUGIN_BUNDLE_CHANGELOG_FILE,
    };
  }
  const link = artifact.bundle.manifest.links?.changelog;
  if (link === undefined) return null;
  const bytes = await readMetadata("changelog", link, MAX_PLUGIN_CHANGELOG_BYTES, request);
  return { text: utf8(bytes, "changelog"), source: link };
}
