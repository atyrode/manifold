import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_BUNDLE_CHANGELOG_FILE } from "@manifold/plugin-kit/pack";
import {
  MAX_PLUGIN_CHANGELOG_BYTES,
  PluginBundleSchema,
  type PluginManifest,
} from "@manifold/protocol";
import {
  InstallRefusal,
  PLUGIN_UPLOADS_DIR,
  type VerifiedPluginArtifact,
} from "../src/plugin-installs.ts";
import {
  MAX_RELEASE_FEED_BYTES,
  discoverPluginRelease,
  readPluginChangelog,
  releaseFromGitHub,
} from "../src/plugin-releases.ts";

/**
 * RELEASE DISCOVERY IS METADATA, pinned and bounded (#238). What these cases defend: publisher
 * order rather than a version guess picks the release, a remote document cannot aim a review
 * at the operator's drop box, a GitHub asset without GitHub's own digest has no pin, and a
 * changelog is the candidate's packed words first and a visible refusal when its link fails.
 */

const ROOT = "vendor.sample";
const MANIFEST: PluginManifest = {
  id: ROOT,
  version: "2.0.0",
  title: "Sample",
  description: "a candidate",
  capabilities: [],
  contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
  entry: { web: "web.js" },
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "manifold-releases-"));
  dirs.push(dir);
  mkdirSync(join(dir, PLUGIN_UPLOADS_DIR), { recursive: true });
  return dir;
}

/** Answers every request with `body` and records the URL each one reached. */
function serve(body: string | Uint8Array, asked: string[] = []): typeof fetch {
  return Object.assign(
    (input: string | URL | Request): Promise<Response> => {
      asked.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(
        new Response(typeof body === "string" ? body : Uint8Array.from(body).buffer),
      );
    },
    { preconnect: fetch.preconnect },
  );
}

async function refusal(run: () => Promise<unknown>): Promise<InstallRefusal> {
  try {
    await run();
  } catch (error) {
    if (error instanceof InstallRefusal) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("discoverPluginRelease", () => {
  test("a feed's first entry is the release, root first and every pin lowercase", async () => {
    const dir = dataDir();
    const source = join(dir, PLUGIN_UPLOADS_DIR, "releases.json");
    writeFileSync(
      source,
      JSON.stringify([
        {
          version: "2.0.0-rc.1",
          url: "https://1.1.1.1/root.manifold-plugin.json",
          sha256: "A".repeat(64),
          family: [
            {
              id: `${ROOT}.extra`,
              url: "https://1.1.1.1/extra.manifold-plugin.json",
              sha256: "B".repeat(64),
            },
          ],
        },
        // Publisher order, not a version comparison: a "higher" label later is not preferred.
        {
          version: "9.9.9",
          url: "https://1.1.1.1/old.manifold-plugin.json",
          sha256: "c".repeat(64),
        },
      ]),
    );
    expect(await discoverPluginRelease({ id: ROOT, source, dataDir: dir })).toEqual({
      version: "2.0.0-rc.1",
      artifacts: [
        { id: ROOT, url: "https://1.1.1.1/root.manifold-plugin.json", sha256: "a".repeat(64) },
        {
          id: `${ROOT}.extra`,
          url: "https://1.1.1.1/extra.manifold-plugin.json",
          sha256: "b".repeat(64),
        },
      ],
    });
  });

  test("a remote feed cannot name a drop-box path, and a feed is read under its own bound", async () => {
    const dir = dataDir();
    const local = [
      {
        version: "2.0.0",
        url: join(dir, PLUGIN_UPLOADS_DIR, "root.manifold-plugin.json"),
        sha256: "a".repeat(64),
      },
    ];
    const remote = await refusal(() =>
      discoverPluginRelease({
        id: ROOT,
        source: "https://1.1.1.1/releases.json",
        dataDir: dir,
        fetchImpl: serve(JSON.stringify(local)),
      }),
    );
    expect(remote.reason).toBe("artifact_invalid");
    expect(remote.detail).toContain("https://");

    const oversized = await refusal(() =>
      discoverPluginRelease({
        id: ROOT,
        source: "https://1.1.1.1/releases.json",
        dataDir: dir,
        fetchImpl: serve(new Uint8Array(MAX_RELEASE_FEED_BYTES + 1)),
      }),
    );
    expect(oversized.reason).toBe("artifact_unreadable");
    expect(oversized.detail).toBe(
      `release feed: artifact is ${String(MAX_RELEASE_FEED_BYTES + 1)} bytes, over the ${String(MAX_RELEASE_FEED_BYTES)}-byte cap`,
    );
  });
});

describe("releaseFromGitHub", () => {
  const digest = `sha256:${"A".repeat(64)}`;
  const asset = (name: string) => ({
    name,
    browser_download_url: `https://github.com/vendor/sample/releases/download/v2/${name}`,
    digest,
    size: 1,
    state: "uploaded",
  });

  test("one asset is the root whatever its name; several are the root's named family", () => {
    expect(releaseFromGitHub(ROOT, { tag_name: "v2", assets: [asset("sample.json")] })).toEqual({
      version: null,
      artifacts: [
        {
          id: ROOT,
          url: "https://github.com/vendor/sample/releases/download/v2/sample.json",
          sha256: "a".repeat(64),
        },
      ],
    });
    const family = releaseFromGitHub(ROOT, {
      assets: [
        asset("SHA256SUMS"),
        asset(`${ROOT}.extra.manifold-plugin.json`),
        asset(`${ROOT}.manifold-plugin.json`),
        asset("vendor.other.manifold-plugin.json"),
      ],
    });
    expect(family.artifacts.map(({ id }) => id)).toEqual([ROOT, `${ROOT}.extra`]);

    const rootless = (() => {
      try {
        return releaseFromGitHub(ROOT, { assets: [asset("a.json"), asset("b.json")] });
      } catch (error) {
        return error;
      }
    })();
    expect(rootless).toBeInstanceOf(InstallRefusal);
  });

  test("an asset without GitHub's sha256 digest is refused, never pinned some other way", () => {
    const name = `${ROOT}.manifold-plugin.json`;
    for (const unpinned of [
      // A document from before GitHub published digests carries no field at all.
      { name, browser_download_url: asset(name).browser_download_url },
      { ...asset(name), digest: null },
      { ...asset(name), digest: `md5:${"a".repeat(32)}` },
      { ...asset(name), digest: `sha256:${"a".repeat(63)}` },
    ]) {
      let thrown: unknown;
      try {
        releaseFromGitHub(ROOT, { assets: [unpinned] });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InstallRefusal);
      expect((thrown as InstallRefusal).reason).toBe("artifact_invalid");
      expect((thrown as InstallRefusal).detail).toContain("digest");
    }
  });
});

describe("readPluginChangelog", () => {
  function candidate(
    files: Record<string, string | Uint8Array>,
    changelog?: string,
  ): VerifiedPluginArtifact {
    const bundle = PluginBundleSchema.parse({
      format: 1,
      hardenedContract: 2,
      manifest: { ...MANIFEST, ...(changelog === undefined ? {} : { links: { changelog } }) },
      files: Object.fromEntries(
        Object.entries({ "web.js": "export {};", ...files }).map(([name, data]) => [
          name,
          Buffer.from(data).toString("base64"),
        ]),
      ),
    });
    return { bundle, bytes: new Uint8Array(), sha256: "a".repeat(64), source: "/candidate" };
  }
  const link = "https://1.1.1.1/CHANGELOG.md";

  test("the packed CHANGELOG.md is the candidate's word, read without a fetch", async () => {
    const asked: string[] = [];
    expect(
      await readPluginChangelog(
        candidate({ [PLUGIN_BUNDLE_CHANGELOG_FILE]: "## 2.0.0\n- faster" }, link),
        { dataDir: dataDir(), fetchImpl: serve("remote notes", asked) },
      ),
    ).toEqual({ text: "## 2.0.0\n- faster", source: PLUGIN_BUNDLE_CHANGELOG_FILE });
    expect(asked).toEqual([]);

    for (const packed of [
      new Uint8Array([0xff, 0xfe, 0x00]),
      "x".repeat(MAX_PLUGIN_CHANGELOG_BYTES + 1),
    ]) {
      const refused = await refusal(() =>
        readPluginChangelog(candidate({ [PLUGIN_BUNDLE_CHANGELOG_FILE]: packed }), {
          dataDir: dataDir(),
        }),
      );
      expect(refused.reason).toBe("artifact_invalid");
    }
  });

  test("a declared link is fetched under the changelog bound and fails visibly; none is null", async () => {
    const dir = dataDir();
    expect(
      await readPluginChangelog(candidate({}, link), {
        dataDir: dir,
        fetchImpl: serve("## 2.0.0"),
      }),
    ).toEqual({ text: "## 2.0.0", source: link });

    const oversized = await refusal(() =>
      readPluginChangelog(candidate({}, link), {
        dataDir: dir,
        fetchImpl: serve("x".repeat(MAX_PLUGIN_CHANGELOG_BYTES + 1)),
      }),
    );
    expect(oversized.detail).toStartWith("changelog: ");

    const gone = await refusal(() =>
      readPluginChangelog(candidate({}, link), {
        dataDir: dir,
        fetchImpl: Object.assign(() => Promise.resolve(new Response("gone", { status: 404 })), {
          preconnect: fetch.preconnect,
        }),
      }),
    );
    expect(gone.detail).toBe("changelog: HTTP 404");

    expect(await readPluginChangelog(candidate({}), { dataDir: dir })).toBeNull();
  });
});
