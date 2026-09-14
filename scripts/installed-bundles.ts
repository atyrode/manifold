import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InstalledPluginsSnapshotSchema,
  type InstalledPluginsSnapshot,
} from "../packages/protocol/src/index.ts";
import { discoverActions, invokeAction } from "../packages/sdk/src/index.ts";

const EXPORT_DOOR = "engine.plugins.exportInstalled";

export async function fetchInstalledSnapshot(
  origin: string,
  token: string,
): Promise<InstalledPluginsSnapshot> {
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
  const protocol = await discoverActions(options);
  if (!protocol.actions.some((action) => action.name === EXPORT_DOOR)) {
    throw new Error(
      `${EXPORT_DOOR} is unavailable on the running instance; deploy the export-door prerequisite before using this gate (an absent export is never an empty inventory)`,
    );
  }
  const { outcome, traceId } = await invokeAction(options, EXPORT_DOOR, {});
  if (!outcome.ok)
    throw new Error(
      `${EXPORT_DOOR} refused: ${outcome.denial.message} (trace ${traceId ?? "unavailable"})`,
    );
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
  const root = mkdtempSync(join(tmpdir(), "manifold-installed-export-"));
  const name = `manifold-installed-bundles-${crypto.randomUUID()}`;
  const path = join(root, "snapshot.json");
  writeFileSync(path, JSON.stringify(parsed), { mode: 0o600 });
  let timedOut = false;
  try {
    // No production volume, network, owner key, installer credential, or Docker socket is
    // visible to the candidate. Its own script and loader come from this exact image.
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
        "--mount",
        `type=bind,src=${path},dst=/snapshot.json,readonly`,
        "--entrypoint",
        "bun",
        image,
        "scripts/installed-bundles-candidate.ts",
        "/snapshot.json",
      ],
      { stdout: "inherit", stderr: "inherit" },
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
    // releases any runner children before the temporary export is deleted.
    const cleanup = Bun.spawn(["docker", "rm", "--force", name], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const detail = await new Response(cleanup.stderr).text();
    const code = await cleanup.exited;
    rmSync(root, { recursive: true, force: true });
    if (code !== 0 && !detail.includes("No such container"))
      throw new Error("installed-bundles candidate container cleanup failed");
  }
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
    await runInstalledBundleGate(image, await fetchInstalledSnapshot(origin, token));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "installed-bundles failed");
    process.exitCode = 1;
  }
}
