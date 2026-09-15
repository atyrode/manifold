import { appendFileSync } from "node:fs";
import {
  InstalledPluginsSnapshotSchema,
  type InstalledPluginsSnapshot,
} from "../packages/protocol/src/index.ts";
import { invokeAction } from "../packages/sdk/src/index.ts";

const EXPORT_DOOR = "engine.plugins.exportInstalled";

export async function fetchInstalledSnapshot(
  origin: string,
  token: string,
  bootstrapGate = false,
  summaryPath = process.env.GITHUB_STEP_SUMMARY,
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
  const { outcome, traceId } = await invokeAction(options, EXPORT_DOOR, {});
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

export async function runInstalledBundleGate(
  image: string,
  snapshot: InstalledPluginsSnapshot,
): Promise<void> {
  if (!image || image.startsWith("-")) throw new Error("a candidate image reference is required");
  const parsed = InstalledPluginsSnapshotSchema.parse(snapshot);
  const name = `manifold-installed-bundles-${crypto.randomUUID()}`;
  let timedOut = false;
  let cleanupFailed = false;
  try {
    // Stdin crosses host/container identities without exposing a snapshot file. No production
    // volume, network, owner key, installer credential, or Docker socket reaches the candidate.
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
      { stdin: Buffer.from(JSON.stringify(parsed)), stdout: "inherit", stderr: "inherit" },
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
        "usage: INSTALLED_BUNDLES_ORIGIN=... INSTALLED_BUNDLES_TOKEN=... bun scripts/installed-bundles.ts IMAGE",
      );
    const snapshot = await fetchInstalledSnapshot(
      origin,
      token,
      process.env.INSTALLED_BUNDLES_BOOTSTRAP_GATE === "true",
    );
    if (snapshot !== null) await runInstalledBundleGate(image, snapshot);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `bootstrap_required=${snapshot === null}\n`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "installed-bundles failed");
    process.exitCode = 1;
  }
}
