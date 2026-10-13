import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  canonicalJobJson,
  InstalledPluginsSnapshotSchema,
  PluginReplacementSetSchema,
  type InstalledCrossing,
  type InstalledPluginsSnapshot,
  type PluginReplacementSet,
} from "../packages/protocol/src/index.ts";
import { invokeAction } from "../packages/sdk/src/index.ts";
import { readArtifact } from "../packages/server/src/index.ts";

const EXPORT_DOOR = "engine.plugins.exportInstalled";

/** A staged crossing (#1068) as the candidate receives it: set, target commit and exact bytes. */
export interface GateReplacement {
  readonly set: PluginReplacementSet;
  readonly setSha256: string;
  readonly revision: string;
  readonly bundles: Readonly<Record<string, string>>;
}

/** `crossings` also exports the journaled staged crossings a manual rollback refuses (#1068). */
export async function fetchInstalledSnapshot(
  origin: string,
  token: string,
  bootstrapGate = false,
  summaryPath = process.env.GITHUB_STEP_SUMMARY,
  crossings = false,
): Promise<InstalledPluginsSnapshot | null> {
  const url = new URL(origin);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(
      "installed-bundles requires an origin without credentials, path, query or fragment",
    );
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  ) {
    throw new Error("installed-bundles requires HTTPS except for a disposable loopback server");
  }
  if (!token)
    throw new Error(
      "INSTALLED_BUNDLES_TOKEN must contain a configured root-authorized export credential",
    );
  const options = {
    origin: url.origin,
    token,
    timeoutMs: 60_000,
    maxResponseBytes: 512 * 1024 * 1024,
  };
  let { outcome, traceId } = await invokeAction(
    options,
    EXPORT_DOOR,
    crossings ? { crossings } : {},
  );
  // A hub predating the crossing journal refuses the argument: it journals no crossing.
  if (crossings && !outcome.ok && outcome.denial.rule === "invalid_args")
    ({ outcome, traceId } = await invokeAction(options, EXPORT_DOOR, {}));
  if (!outcome.ok) {
    if (bootstrapGate && outcome.denial.rule === "unknown_action") {
      const reason = `${EXPORT_DOOR} returned unknown_action`;
      console.warn(
        `::warning::installed-bundles bootstrap for ${url.origin}: ${reason}; the installed inventory was not checked for this one-time deployment`,
      );
      if (summaryPath) {
        appendFileSync(
          summaryPath,
          `### Installed-bundles bootstrap\n\n- Target: ${url.origin}\n- Reason: ${reason}\n- Explicit bootstrap_gate=true: installed inventory verification skipped for this one-time deployment to a target predating the export door.\n\n`,
        );
      }
      return null;
    }
    throw new Error(
      `${EXPORT_DOOR} refused: ${outcome.denial.message} (trace ${traceId ?? "unavailable"})`,
    );
  }
  const snapshot = InstalledPluginsSnapshotSchema.parse(outcome.result);
  console.log(
    `${EXPORT_DOOR}: ${snapshot.plugins.length} installed bundle(s), trace ${traceId ?? "unavailable"}`,
  );
  return snapshot;
}

/**
 * Fetches each staged member from its published HTTPS address and checks its pin here, so the
 * network-less candidate only ever sees bytes this job already proved. It reads through the
 * install door's own artifact reader, the policy host staging applies: HTTPS to an ordinary
 * public address at every redirect hop, and the artifact cap enforced while the body streams.
 * The set's identity is the sha256 of its canonical JSON: the same digest the host receiver
 * must find staged.
 */
export async function fetchReplacement(
  input: unknown,
  revision: string,
  fetchImpl?: typeof fetch,
): Promise<GateReplacement> {
  if (!/^[0-9a-f]{40}$/.test(revision))
    throw new Error("a staged replacement needs the exact target commit");
  const set = PluginReplacementSetSchema.parse(input);
  const bundles: Record<string, string> = {};
  for (const member of set.members) {
    let bytes: Uint8Array;
    try {
      bytes = await readArtifact({
        source: member.url,
        // Consulted only for path sources, which a set's HTTPS member never is.
        dataDir: tmpdir(),
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
      });
    } catch (error) {
      throw new Error(
        `${member.pluginId}: ${member.url}: ${error instanceof Error ? error.message : "unreadable"}`,
      );
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== member.sha256)
      throw new Error(
        `${member.pluginId}: ${member.url} hashes to ${sha256}, not ${member.sha256}`,
      );
    bundles[member.sha256] = Buffer.from(bytes).toString("base64");
  }
  const setSha256 = createHash("sha256").update(canonicalJobJson(set)).digest("hex");
  return { set, setSha256, revision, bundles };
}

/**
 * A MANUAL ROLLBACK ACROSS A STAGED CROSSING (#1068) refuses here, before anything stops. The
 * crossing is forward-only: only the automatic recovery of the run that applied it restores its
 * bundles, and recovery after a completed crossing is a forward deployment. `contains` is the
 * host's own ancestry rule; every journaled crossing the target does not contain is named.
 */
export function rollbackRefusal(
  crossings: readonly InstalledCrossing[],
  target: string,
  contains: (revision: string) => boolean,
): string | null {
  const behind = crossings
    .filter((crossing) => !contains(crossing.revision))
    .map(({ revision, setSha256 }) => `${revision} (set ${setSha256})`);
  if (behind.length === 0) return null;
  return `rollback to ${target} refused: the running instance journals staged crossing ${behind.join(", ")}, which the target does not contain; recovery after a completed crossing is a forward deployment`;
}

/** `git merge-base --is-ancestor`, as deploy-dev.sh decides which crossings a target contains. */
export function containedIn(repository: string, target: string): (revision: string) => boolean {
  return (revision) => {
    const { exitCode, stderr } = Bun.spawnSync(
      ["git", "-C", repository, "merge-base", "--is-ancestor", revision, target],
      { stdout: "ignore", stderr: "pipe" },
    );
    if (exitCode !== 0 && exitCode !== 1)
      throw new Error(
        `cannot order journaled crossing ${revision} against ${target}: ${stderr.toString().trim()}`,
      );
    return exitCode === 0;
  };
}

export async function runInstalledBundleGate(
  image: string,
  snapshot: InstalledPluginsSnapshot,
  replacement?: GateReplacement,
): Promise<void> {
  if (!image || image.startsWith("-")) throw new Error("a candidate image reference is required");
  const { format, developerMode, plugins } = InstalledPluginsSnapshotSchema.parse(snapshot);
  const parsed = { format, developerMode, plugins };
  const name = `manifold-installed-bundles-${crypto.randomUUID()}`;
  let timedOut = false;
  let cleanupFailed = false;
  try {
    // Stdin crosses host/container identities without exposing a snapshot file. No production
    // volume, network, owner key, installer credential, or Docker socket reaches the candidate.
    // A bare snapshot is what every candidate, including one built before crossings, reads.
    const input =
      replacement === undefined
        ? parsed
        : {
            snapshot: parsed,
            replacement: {
              set: replacement.set,
              revision: replacement.revision,
              bundles: replacement.bundles,
            },
          };
    const child = Bun.spawn(
      [
        "docker",
        "run",
        "--name",
        name,
        "--rm",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--interactive",
        "--entrypoint",
        "bun",
        image,
        "scripts/installed-bundles-candidate.ts",
      ],
      { stdin: Buffer.from(JSON.stringify(input)), stdout: "inherit", stderr: "inherit" },
    );
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 180_000);
    let code: number;
    try {
      code = await child.exited;
    } finally {
      clearTimeout(deadline);
    }
    if (timedOut || code !== 0) {
      const names =
        parsed.plugins.map(({ row }) => row.pluginId).join(", ") || "explicitly empty inventory";
      throw new Error(
        `installed-bundles candidate ${timedOut ? "timed out" : `exited ${code}`} (${names}); inspect candidate refusal and repack named bundles with its minimum supported SDK/contract`,
      );
    }
  } finally {
    // Also handles timeout/cancellation of docker's client; removing our unique container
    // releases any runner children before this attempt finishes.
    const cleanup = Bun.spawn(["docker", "rm", "--force", name], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const detail = await new Response(cleanup.stderr).text();
    const code = await cleanup.exited;
    cleanupFailed = code !== 0 && !detail.includes("No such container");
  }
  if (cleanupFailed) throw new Error("installed-bundles candidate container cleanup failed");
}

if (import.meta.main) {
  try {
    const image = process.argv[2];
    const origin = process.env.INSTALLED_BUNDLES_ORIGIN;
    const token = process.env.INSTALLED_BUNDLES_TOKEN;
    if (!image || !origin || !token)
      throw new Error(
        "usage: INSTALLED_BUNDLES_ORIGIN=... INSTALLED_BUNDLES_TOKEN=... [INSTALLED_BUNDLES_REVISION=SHA [INSTALLED_BUNDLES_REPLACEMENT_SET=SET.json | INSTALLED_BUNDLES_ROLLBACK_REPOSITORY=GIT_DIR]] bun scripts/installed-bundles.ts IMAGE",
      );
    const bootstrap = process.env.INSTALLED_BUNDLES_BOOTSTRAP_GATE === "true";
    const setPath = process.env.INSTALLED_BUNDLES_REPLACEMENT_SET ?? "";
    const rollbackRepository = process.env.INSTALLED_BUNDLES_ROLLBACK_REPOSITORY ?? "";
    const revision = process.env.INSTALLED_BUNDLES_REVISION ?? "";
    if (setPath && bootstrap)
      throw new Error("a staged replacement needs the export door; it cannot use bootstrap_gate");
    if (setPath && rollbackRepository) throw new Error("a rollback stages no replacement set");
    if (rollbackRepository && !/^[0-9a-f]{40}$/.test(revision))
      throw new Error("a rollback gate needs the exact target commit");
    const replacement = setPath
      ? await fetchReplacement(JSON.parse(readFileSync(setPath, "utf8")), revision)
      : undefined;
    const exported = await fetchInstalledSnapshot(
      origin,
      token,
      bootstrap,
      process.env.GITHUB_STEP_SUMMARY,
      rollbackRepository !== "",
    );
    // A target predating the export door predates the journal too: it has no crossing to refuse.
    if (rollbackRepository && exported !== null) {
      const refusal = rollbackRefusal(
        exported.crossings ?? [],
        revision,
        containedIn(rollbackRepository, revision),
      );
      if (refusal !== null) throw new Error(refusal);
    }
    if (exported !== null) await runInstalledBundleGate(image, exported, replacement);
    if (replacement !== undefined && process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Staged crossing\n\nSet <code>${replacement.setSha256}</code> for <code>${replacement.revision}</code> passed the candidate.\n\n| Plugin | Replacement sha256 | Native |\n| --- | --- | --- |\n${replacement.set.members
          .map(
            (member) =>
              `| <code>${member.pluginId}</code> | <code>${member.sha256}</code> | ${member.nativeReview ? "disabled until deployment review" : "unchanged"} |`,
          )
          .join("\n")}\n\n`,
      );
    }
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `bootstrap_required=${exported === null}\nreplacement_set=${replacement?.setSha256 ?? ""}\n`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "installed-bundles failed");
    process.exitCode = 1;
  }
}
