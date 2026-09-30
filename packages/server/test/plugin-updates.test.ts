import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionOutcomeSchema,
  GOVERNED_CAPS,
  HARDENED_CONTRACT_VERSION,
  PROTOCOL_VERSION,
  PluginUpdateApplyResultSchema,
  PluginUpdateReviewResultSchema,
  PluginsResponseSchema,
  TokenGrantSchema,
  defaultRuntime,
  type PluginManifest,
  type PluginUpdateReview,
} from "@manifold/protocol";
import { BUILT_AGAINST_PROTOCOL } from "@manifold/plugin-kit/pack";
import { loadConfig } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";
import { startServer } from "../src/main.ts";
import { PLUGIN_UPLOADS_DIR } from "../src/plugin-installs.ts";
import { sha256Hex } from "../src/stores.ts";

const OWNER = "d".repeat(64);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "manifold-updates-"));
  let stop: (() => Promise<void>) | undefined = undefined;
  cleanups.push(async () => {
    try {
      await stop?.();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  const config = loadConfig(
    {
      MANIFOLD_PORT: "0",
      MANIFOLD_DATA_DIR: "data",
      MANIFOLD_OWNER_KEY: OWNER,
      MANIFOLD_SPAWN_AGENT: "0",
    },
    cwd,
  );
  const uploads = join(config.dataDir, PLUGIN_UPLOADS_DIR);
  mkdirSync(uploads, { recursive: true });
  let now = 1_800_000_000_000;
  const running = await startServer({
    config,
    logger: silentLogger,
    announce: false,
    runtime: { ...defaultRuntime, now: () => now },
  });
  stop = () => running.stop();
  const raw = (name: string, args: unknown, token = OWNER) =>
    fetch(`${running.publicUrl}/api/actions/${name}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
  const call = async (name: string, args: unknown, token = OWNER): Promise<unknown> => {
    const response = await raw(name, args, token);
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    const outcome = ActionOutcomeSchema.parse(await response.json());
    if (!outcome.ok) throw new Error(outcome.denial.message);
    return outcome.result;
  };
  const source = join(uploads, "releases.json");
  const manifest = (id: string, version: string): PluginManifest => ({
    id,
    version,
    title: id,
    description: "Disposable update regression fixture",
    capabilities: ["containers:read"],
    contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
    entry: { web: "web.js" },
    ...(id === "vendor.updates"
      ? { releases: source }
      : {
          dependencies: { "vendor.updates": { type: "required" } },
        }),
  });
  const bundle = (
    definition: PluginManifest,
    builtAgainst: Record<string, string> | null = {
      [BUILT_AGAINST_PROTOCOL]: String(PROTOCOL_VERSION),
    },
    hardenedContract: number | null = HARDENED_CONTRACT_VERSION,
  ) => {
    const web = `export const revision = ${JSON.stringify(definition.version)};`;
    const bytes = Buffer.from(
      JSON.stringify({
        format: 1,
        ...(hardenedContract === null ? {} : { hardenedContract }),
        manifest: definition,
        ...(builtAgainst === null ? {} : { builtAgainst }),
        files: {
          "web.js": Buffer.from(web).toString("base64"),
          "CHANGELOG.md": Buffer.from(`Notes for ${definition.id} ${definition.version}`).toString(
            "base64",
          ),
        },
      }),
    );
    const path = join(uploads, `${definition.id}-${definition.version}.manifold-plugin.json`);
    writeFileSync(path, bytes);
    return {
      id: definition.id,
      version: definition.version,
      source: path,
      sha256: sha256Hex(bytes),
      web,
    };
  };
  type Artifact = ReturnType<typeof bundle>;
  const feed = (root: Artifact, family: readonly Artifact[] = []) => {
    writeFileSync(
      source,
      JSON.stringify([
        {
          version: root.version,
          url: root.source,
          sha256: root.sha256,
          family: family.map((member) => ({
            id: member.id,
            url: member.source,
            sha256: member.sha256,
          })),
        },
      ]),
    );
  };
  const install = (artifact: Artifact) =>
    call("engine.plugins.install", { source: artifact.source, sha256: artifact.sha256 });
  const roster = async () =>
    PluginsResponseSchema.parse(
      await (
        await fetch(`${running.publicUrl}/api/plugins`, {
          headers: { authorization: `Bearer ${OWNER}` },
        })
      ).json(),
    ).plugins;
  const review = async (id = "vendor.updates", token = OWNER): Promise<PluginUpdateReview> => {
    const result = PluginUpdateReviewResultSchema.parse(
      await call("engine.plugins.reviewUpdate", { id }, token),
    );
    if (result.state !== "review") throw new Error("expected an available candidate");
    return result.review;
  };
  const web = async (id = "vendor.updates") =>
    (
      await fetch(`${running.publicUrl}/api/plugins/${id}/web.js`, {
        headers: { authorization: `Bearer ${OWNER}` },
      })
    ).text();
  return {
    raw,
    call,
    manifest,
    bundle,
    feed,
    install,
    roster,
    review,
    web,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function consent(review: PluginUpdateReview) {
  return review.members
    .filter((member) => member.capabilitiesAdded.length > 0)
    .map((member) => ({ id: member.id, capabilities: member.capabilitiesAdded }));
}

describe("reviewed plugin updates", () => {
  test("whole-family consent preserves withheld authority, disabled members and the reviewed bytes", async () => {
    const f = await fixture();
    const oldRoot = f.bundle({
      ...f.manifest("vendor.updates", "first"),
      capabilities: ["containers:read", "tokens:mint"],
    });
    const oldChild = f.bundle(f.manifest("vendor.updates.child", "first"));
    await f.install(oldRoot);
    await f.install(oldChild);
    await f.call("engine.plugins.setEnabled", { id: oldChild.id, enabled: false });
    const nextRoot = f.bundle({
      ...f.manifest(oldRoot.id, "publisher-preferred"),
      capabilities: ["*"],
    });
    const nextChild = f.bundle(f.manifest(oldChild.id, "second"));
    const addedChild = f.bundle(f.manifest("vendor.updates.extra", "new"));
    f.feed(nextRoot);
    await expect(f.review()).rejects.toThrow("omits installed family member");
    expect(await f.web()).toBe(oldRoot.web);
    f.feed(nextRoot, [nextChild, addedChild]);
    const refusedReview = await f.review(oldChild.id);
    expect(refusedReview.rootId).toBe(oldRoot.id);
    const root = refusedReview.members.find((member) => member.id === oldRoot.id)!;
    expect(root.capabilitiesAdded).toEqual(["*"]);
    expect(root.grantedCaps).toContain("containers:read");
    expect(root.grantedCaps).toContain("machines:mint");
    expect(root.grantedCaps).not.toContain("tokens:mint");
    expect(root.grantedCaps).not.toContain("*");
    expect(root.grantedCaps.some((cap) => GOVERNED_CAPS.includes(cap))).toBe(false);
    expect(refusedReview.members.find((member) => member.id === oldChild.id)?.enabled).toBe(false);
    expect(refusedReview.members.find((member) => member.id === addedChild.id)?.current).toBeNull();
    await expect(
      f.call("engine.plugins.applyUpdate", { digest: refusedReview.digest, consent: [] }),
    ).rejects.toThrow("consent_required");
    expect(await f.web()).toBe(oldRoot.web);
    const approved = await f.review();
    // The publisher's path changes after approval. Apply must use the approved, cached bytes.
    writeFileSync(nextRoot.source, "not the reviewed artifact");
    const applied = PluginUpdateApplyResultSchema.parse(
      await f.call("engine.plugins.applyUpdate", {
        digest: approved.digest,
        consent: consent(approved),
      }),
    );
    expect(applied.installed.find((member) => member.id === oldRoot.id)?.sha256).toBe(
      nextRoot.sha256,
    );
    expect(await f.web()).toBe(nextRoot.web);
    const after = await f.roster();
    expect(after.find((entry) => entry.manifest.id === oldChild.id)).toMatchObject({
      enabled: false,
      manifest: { version: nextChild.version },
    });
    expect(after.find((entry) => entry.manifest.id === addedChild.id)).toMatchObject({
      enabled: true,
      install: { hardened: false },
    });
    expect(after.find((entry) => entry.manifest.id === oldRoot.id)?.install?.grantedCaps).toEqual(
      root.grantedCaps,
    );
  });

  test("a review belongs to its exact credential, and revocation cannot apply the next candidate", async () => {
    const f = await fixture();
    const old = f.bundle(f.manifest("vendor.updates", "one"));
    await f.install(old);
    const second = f.bundle(f.manifest(old.id, "two"));
    f.feed(second);
    const first = TokenGrantSchema.parse(
      await f.call("core.access.createPrincipal", { name: "Updater" }),
    );
    const other = TokenGrantSchema.parse(
      await f.call("core.access.mint", { principalId: first.principal.id, caps: ["*"] }),
    );
    const approved = await f.review(old.id, first.token);
    await expect(
      f.call("engine.plugins.applyUpdate", { digest: approved.digest, consent: [] }, other.token),
    ).rejects.toThrow("different credential");
    expect(await f.web()).toBe(old.web);
    await f.call(
      "engine.plugins.applyUpdate",
      { digest: approved.digest, consent: [] },
      first.token,
    );
    expect(await f.web()).toBe(second.web);
    f.feed(f.bundle(f.manifest(old.id, "three")));
    const revoked = await f.review(old.id, first.token);
    await f.call("core.access.revoke", { principalId: first.principal.id });
    expect(
      (
        await f.raw(
          "engine.plugins.applyUpdate",
          { digest: revoked.digest, consent: [] },
          first.token,
        )
      ).status,
    ).toBe(403);
    expect(await f.web()).toBe(second.web);
  });

  test("changed enablement and the exact expiry boundary invalidate approval without replacing code", async () => {
    const f = await fixture();
    const old = f.bundle(f.manifest("vendor.updates", "one"));
    await f.install(old);
    f.feed(f.bundle(f.manifest(old.id, "two")));
    const stale = await f.review();
    await f.call("engine.plugins.setEnabled", { id: old.id, enabled: false });
    await expect(
      f.call("engine.plugins.applyUpdate", { digest: stale.digest, consent: [] }),
    ).rejects.toThrow("review_stale");
    const expired = await f.review();
    f.advance(expired.expiresAt - expired.createdAt);
    await expect(
      f.call("engine.plugins.applyUpdate", { digest: expired.digest, consent: [] }),
    ).rejects.toThrow("review_expired");
    expect((await f.roster()).find((entry) => entry.manifest.id === old.id)).toMatchObject({
      enabled: false,
      manifest: { version: old.version },
      install: { sha256: old.sha256 },
    });
  });

  test("a machine-only member with unchanged native declarations remains updateable", async () => {
    const f = await fixture();
    const manifest: PluginManifest = {
      ...f.manifest("vendor.updates", "one"),
      entry: {},
      capabilities: ["machines:run"],
      machine: {
        artifacts: {
          "linux-x64": {
            url: "https://example.invalid/worker",
            sha256: "a".repeat(64),
            entrySha256: "a".repeat(64),
            format: "raw",
            entry: ["worker"],
            maxBytes: 16,
            maxExpandedBytes: 16,
            maxMembers: 1,
          },
        },
        locations: {},
        operations: {
          "vendor.updates.run": {
            argv: [],
            input: {},
            runtimeTools: [],
            locations: [],
            outputs: [],
            network: "none",
            limits: { timeoutMs: 1000, memoryBytes: 1024, processes: 1, outputBytes: 1024 },
            stdin: false,
          },
        },
      },
    };
    await f.install(f.bundle(manifest));
    const next = f.bundle({ ...manifest, version: "two" });
    f.feed(next);
    const reviewed = await f.review();
    expect(reviewed.blockers).toEqual([]);
    await f.call("engine.plugins.applyUpdate", { digest: reviewed.digest, consent: [] });
    expect((await f.roster()).find((entry) => entry.manifest.id === manifest.id)).toMatchObject({
      enabled: true,
      manifest: { version: "two", entry: {}, machine: manifest.machine },
      install: { sha256: next.sha256 },
    });
  });

  test("in-realm review blocks an executable contract the shared loader cannot admit", async () => {
    const f = await fixture();
    const old = f.bundle(f.manifest("vendor.updates", "one"));
    await f.install(old);
    const candidate = f.bundle(f.manifest(old.id, "unstamped"), undefined, null);
    f.feed(candidate);
    const blocked = await f.review();
    expect(blocked.blockers.some((blocker) => blocker.reason.startsWith("repack_required:"))).toBe(
      true,
    );
    await expect(
      f.call("engine.plugins.applyUpdate", { digest: blocked.digest, consent: [] }),
    ).rejects.toThrow("update_blocked");
    expect(await f.web()).toBe(old.web);
  });

  test("prior ABI-compatible bundles load but out-of-window stamps and React majors remain blocked", async () => {
    const f = await fixture();
    const old = f.bundle(f.manifest("vendor.updates", "prior-wire"), {
      [BUILT_AGAINST_PROTOCOL]: "47",
    });
    await f.install(old);
    expect((await f.roster()).find((entry) => entry.manifest.id === old.id)).toMatchObject({
      enabled: true,
      install: { sha256: old.sha256, compatibility: { status: "compatible", issues: [] } },
    });
    expect(await f.web()).toBe(old.web);

    for (const [version, builtAgainst] of [
      ["too-old", { [BUILT_AGAINST_PROTOCOL]: "46" }],
      ["future", { [BUILT_AGAINST_PROTOCOL]: String(PROTOCOL_VERSION + 1) }],
      ["noncanonical", { [BUILT_AGAINST_PROTOCOL]: "047" }],
      ["wrong-react", { [BUILT_AGAINST_PROTOCOL]: "47", react: "999.0.0" }],
    ] as const) {
      f.feed(f.bundle(f.manifest(old.id, version), builtAgainst));
      const blocked = await f.review();
      expect(blocked.members[0]?.compatibility.status).toBe("incompatible");
      expect(
        blocked.blockers.some((blocker) => blocker.reason.startsWith("repack_required:")),
      ).toBe(true);
      await expect(
        f.call("engine.plugins.applyUpdate", { digest: blocked.digest, consent: [] }),
      ).rejects.toThrow("update_blocked");
      expect(await f.web()).toBe(old.web);
    }
  });

  test("legacy metadata warns while a known incompatible candidate cannot replace it", async () => {
    const f = await fixture();
    const old = f.bundle(f.manifest("vendor.updates", "legacy"), null);
    await f.install(old);
    const incumbent = (await f.roster()).find((entry) => entry.manifest.id === old.id);
    expect(incumbent).toMatchObject({
      enabled: true,
      install: { compatibility: { status: "unknown" } },
    });
    expect(incumbent?.held).toBeUndefined();
    f.feed(
      f.bundle(f.manifest(old.id, "wrong-wire"), {
        [BUILT_AGAINST_PROTOCOL]: String(PROTOCOL_VERSION + 1),
      }),
    );
    const blocked = await f.review();
    expect(blocked.members[0]?.compatibility.status).toBe("incompatible");
    expect(blocked.blockers.some((blocker) => blocker.reason.startsWith("repack_required:"))).toBe(
      true,
    );
    await expect(
      f.call("engine.plugins.applyUpdate", { digest: blocked.digest, consent: [] }),
    ).rejects.toThrow("update_blocked");
    expect(await f.web()).toBe(old.web);
  });
});
