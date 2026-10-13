import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  canonicalJobJson,
  HARDENED_CONTRACT_MINIMUM,
  InstalledPluginsSnapshotSchema,
  PluginBundleSchema,
  PluginReplacementSetSchema,
  PluginsResponseSchema,
  type InstalledPluginsSnapshot,
  type PluginRoster,
} from "../packages/protocol/src/index.ts";
import {
  openDatabase,
  prospectiveGrant,
  receiveReplacementSet,
  replacementRefusals,
  replacementSetSha256,
  ServerStore,
  sha256Hex,
} from "../packages/server/src/index.ts";

/** A staged crossing as the gate carries it: the set, its exact bytes and the target commit. */
export const CandidateReplacementSchema = z.strictObject({
  set: PluginReplacementSetSchema,
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  /** Original bundle bytes by pinned sha256, canonical base64. */
  bundles: z.record(z.string().regex(/^[a-f0-9]{64}$/), z.base64()),
});
export type CandidateReplacement = z.infer<typeof CandidateReplacementSchema>;
export const CandidateInputSchema = z.strictObject({
  snapshot: InstalledPluginsSnapshotSchema,
  replacement: CandidateReplacementSchema.optional(),
});

export function restoreInstalledSnapshot(
  snapshot: InstalledPluginsSnapshot,
  dataDir: string,
): void {
  // An exclusive new directory also rules out preexisting symlink parents and live databases.
  const parsed = InstalledPluginsSnapshotSchema.parse(snapshot);
  mkdirSync(dataDir, { mode: 0o700 });
  const store = new ServerStore(openDatabase(join(dataDir, "manifold.db")));
  try {
    for (const { row, bytes, enabled } of parsed.plugins) {
      const decoded = Buffer.from(bytes, "base64");
      if (sha256Hex(decoded) !== row.sha256) {
        throw new Error(
          `${row.pluginId}: pinned bundle hash mismatch; repack with the current plugin SDK (minimum hardened contract ${HARDENED_CONTRACT_MINIMUM})`,
        );
      }
      const bundlePath = join(dataDir, row.bundlePath);
      mkdirSync(join(dataDir, "plugins", row.pluginId), { recursive: true });
      writeFileSync(bundlePath, decoded, { flag: "wx", mode: 0o600 });
      store.putPluginInstall({
        pluginId: row.pluginId,
        sha256: row.sha256,
        source: bundlePath,
        bundlePath,
        grantedCaps: row.grantedCaps,
        installedBy: row.installedBy,
        installedAt: row.installedAt,
        actions: row.actions,
        ...(row.hardened === undefined ? {} : { hardened: row.hardened }),
        ...(row.builtAgainst === undefined ? {} : { builtAgainst: row.builtAgainst }),
        ...(row.mode === undefined ? {} : { mode: row.mode }),
      });
      store.setPluginEnabled(row.pluginId, enabled, "installed-bundles", row.installedAt);
    }
    store.setDeveloperMode(parsed.developerMode);
  } finally {
    store.close();
  }
}

/**
 * Every inventory member must be present and healthy, including rows disabled on the source.
 * A crossing names the digest each replaced row must now carry; every other row keeps its own.
 */
export function installedBundleFailures(
  snapshot: InstalledPluginsSnapshot,
  roster: PluginRoster,
  replaced: ReadonlyMap<string, string> = new Map(),
): string[] {
  const entries = new Map(roster.map((entry) => [entry.manifest.id, entry]));
  const failures: string[] = [];
  for (const { row } of snapshot.plugins) {
    const entry = entries.get(row.pluginId);
    const reason = !entry
      ? "missing from candidate roster"
      : entry.held
        ? `held: ${entry.held.reason}`
        : entry.install?.sha256 !== (replaced.get(row.pluginId) ?? row.sha256)
          ? replaced.has(row.pluginId)
            ? "staged replacement was not installed"
            : "candidate pin differs from exported install"
          : (entry.install.refusal ?? (entry.lifecycle === "ok" ? undefined : entry.lifecycle));
    if (reason) {
      failures.push(
        `${row.pluginId}: ${reason}; repack with the current plugin SDK (minimum hardened contract ${entry?.held?.minimum ?? HARDENED_CONTRACT_MINIMUM})`,
      );
    }
  }
  return failures;
}

/**
 * What the operator reviews before the switch, and why a member cannot cross: the same
 * `replacementRefusals` the candidate hub applies at boot, against the exported incumbents.
 * Stored plugin data is not exported, so the hub repeats the data-major rule against it. A set
 * every member of which already serves its staged digest is a completed crossing; the hub would
 * only discard it, so the request is refused here before anything stops.
 */
export function crossingReview(
  snapshot: InstalledPluginsSnapshot,
  replacement: CandidateReplacement,
): { readonly lines: string[]; readonly refusals: string[] } {
  const incumbents = new Map(snapshot.plugins.map((plugin) => [plugin.row.pluginId, plugin]));
  if (
    replacement.set.members.every(
      (member) => incumbents.get(member.pluginId)?.row.sha256 === member.sha256,
    )
  )
    return {
      lines: [],
      refusals: [
        `staged set ${replacementSetSha256(replacement.set)} is already installed; deploy without replacement_set`,
      ],
    };
  const lines: string[] = [];
  const refusals: string[] = [];
  for (const member of replacement.set.members) {
    const bytes = replacement.bundles[member.sha256];
    if (bytes === undefined || sha256Hex(Buffer.from(bytes, "base64")) !== member.sha256) {
      refusals.push(`${member.pluginId}: staged bytes do not hash to ${member.sha256}`);
      continue;
    }
    const candidate = PluginBundleSchema.parse(JSON.parse(Buffer.from(bytes, "base64").toString()));
    const exported = incumbents.get(member.pluginId);
    const incumbent =
      exported === undefined
        ? undefined
        : {
            row: exported.row,
            bundle: PluginBundleSchema.parse(
              JSON.parse(Buffer.from(exported.bytes, "base64").toString()),
            ),
          };
    refusals.push(...replacementRefusals(member, candidate, incumbent, null));
    if (incumbent === undefined) continue;
    const grants = prospectiveGrant(incumbent, candidate.manifest.capabilities);
    const removed = incumbent.row.grantedCaps.filter((cap) => !grants.includes(cap));
    lines.push(
      `crossing ${member.pluginId}: ${incumbent.bundle.manifest.version} ${incumbent.row.sha256.slice(0, 12)} -> ${candidate.manifest.version} ${member.sha256.slice(0, 12)}; grants ${removed.length === 0 ? "kept" : `narrowed (no longer declared: ${removed.join(", ")})`}; native ${member.nativeReview ? "REVIEW: its native installations are disabled until the deployment review admits the new declaration" : "unchanged"}`,
    );
  }
  return { lines, refusals };
}

/** The verifier never imports plugin code into its own process: a clean early exit is failure. */
async function candidateRoster(dataDir: string): Promise<PluginRoster> {
  const ownerKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../packages/server/src/main.ts")],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        PATH: process.env.PATH ?? "",
        MANIFOLD_DATA_DIR: dataDir,
        MANIFOLD_BIND: "127.0.0.1",
        MANIFOLD_PORT: "0",
        MANIFOLD_SPAWN_AGENT: "0",
        MANIFOLD_OWNER_KEY: ownerKey,
        MANIFOLD_ANNOUNCE_KEY: "0",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const ready = Promise.withResolvers<string>();
  const deadline = setTimeout(() => ready.reject(new Error("candidate startup timed out")), 30_000);
  void child.exited.then((code) =>
    ready.reject(new Error(`candidate exited ${String(code)} before completing startup`)),
  );
  const refusals: string[] = [];
  const output = (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of child.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      // Guest logs cannot create an unbounded startup buffer.
      if (buffered.length > 64 * 1024) buffered = buffered.slice(-64 * 1024);
      for (const line of lines) {
        if (line.includes('"evt":"plugin_replacement_refused"')) refusals.push(line);
        const match = /^manifold ready url=(http:\/\/(?:127\.0\.0\.1|localhost):\d+)\s*$/.exec(
          line,
        );
        if (match?.[1] !== undefined) ready.resolve(match[1]);
      }
    }
  })().catch((error: unknown) => {
    ready.reject(error instanceof Error ? error : new Error("candidate output failed"));
  });
  try {
    const origin = await ready.promise;
    clearTimeout(deadline);
    if (refusals.length > 0)
      throw new Error(`candidate refused the staged replacement: ${refusals.join("\n")}`);
    const response = await fetch(`${origin}/api/plugins`, {
      headers: { authorization: `Bearer ${ownerKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`candidate roster HTTP ${String(response.status)}`);
    const roster = PluginsResponseSchema.parse(await response.json()).plugins;
    if (child.exitCode !== null) throw new Error("candidate exited before completing verification");
    return roster;
  } finally {
    clearTimeout(deadline);
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      await child.exited;
      await output;
    } finally {
      clearTimeout(kill);
    }
  }
}

/** Hands a disposable data directory the staged set exactly as the deployment receiver does. */
async function stageCandidateReplacement(
  replacement: CandidateReplacement,
  dataDir: string,
  root: string,
): Promise<void> {
  const source = mkdtempSync(join(root, "staged-"));
  writeFileSync(join(source, "set.json"), canonicalJobJson(replacement.set));
  for (const member of replacement.set.members)
    writeFileSync(
      join(source, `${member.sha256}.manifold-plugin.json`),
      Buffer.from(replacement.bundles[member.sha256]!, "base64"),
    );
  await receiveReplacementSet(
    source,
    dataDir,
    replacementSetSha256(replacement.set),
    replacement.revision,
  );
}

/** Runs in the candidate image; only run-owned data and a freshly generated local key exist. */
export async function checkInstalledCandidate(
  snapshot: InstalledPluginsSnapshot,
  replacement?: CandidateReplacement,
): Promise<void> {
  const parsed = InstalledPluginsSnapshotSchema.parse(snapshot);
  const crossing =
    replacement === undefined ? undefined : CandidateReplacementSchema.parse(replacement);
  const root = mkdtempSync(join(tmpdir(), "manifold-installed-bundles-"));
  try {
    const replaced = new Map(
      crossing?.set.members.map((member) => [member.pluginId, member.sha256]) ?? [],
    );
    if (crossing !== undefined) {
      const review = crossingReview(parsed, crossing);
      for (const line of review.lines) console.log(`installed-bundles: ${line}`);
      if (review.refusals.length > 0) throw new Error(review.refusals.join("\n"));
    }
    for (const phase of ["installed", "all-loadable"] as const) {
      const dataDir = join(root, phase);
      restoreInstalledSnapshot(parsed, dataDir);
      if (phase === "all-loadable") {
        // Boot has no onEnable hooks. This second disposable copy forces disabled in-realm
        // modules through the real loader too, without changing a single source install.
        const store = new ServerStore(openDatabase(join(dataDir, "manifold.db")));
        try {
          for (const { row } of parsed.plugins)
            store.setPluginEnabled(row.pluginId, true, "installed-bundles", row.installedAt);
          store.setDeveloperMode(true);
        } finally {
          store.close();
        }
      }
      if (crossing !== undefined) await stageCandidateReplacement(crossing, dataDir, root);
      const failures = installedBundleFailures(parsed, await candidateRoster(dataDir), replaced);
      if (failures.length > 0) throw new Error(failures.join("\n"));
    }
    console.log(
      crossing === undefined
        ? `installed-bundles: ${parsed.plugins.length} installed bundle(s) passed candidate assembly and loading, including disabled rows`
        : `installed-bundles: ${parsed.plugins.length} installed bundle(s) crossed with staged set ${replacementSetSha256(crossing.set)} (${String(crossing.set.members.length)} replacement(s)) and passed candidate assembly and loading, including disabled rows`,
    );
  } catch (error) {
    const names =
      parsed.plugins.map(({ row }) => row.pluginId).join(", ") || "empty installed inventory";
    throw new Error(
      `installed-bundles refused (${names}); minimum hardened contract ${HARDENED_CONTRACT_MINIMUM}, repack with the current plugin SDK: ${error instanceof Error ? error.message : "candidate boot failed"}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.argv.length !== 2)
    throw new Error("usage: bun scripts/installed-bundles-candidate.ts < INPUT.json");
  try {
    // A bare snapshot, or a snapshot with the staged crossing it boots with.
    const input = z
      .union([
        CandidateInputSchema,
        InstalledPluginsSnapshotSchema.transform((snapshot) => ({ snapshot })),
      ])
      .parse(await Bun.stdin.json());
    await checkInstalledCandidate(
      input.snapshot,
      "replacement" in input ? input.replacement : undefined,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "installed-bundles candidate failed");
    process.exit(1);
  }
}
