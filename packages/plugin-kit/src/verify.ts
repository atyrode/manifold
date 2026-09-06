#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatch, ownerAction, roster, type Hub } from "./hub.ts";
import {
  BundleError,
  exitWith,
  familyOrder,
  inspectBundle,
  installBundle,
  type BundleFacts,
} from "./install.ts";

/**
 * `verify` — packed bundles against a REAL engine, from a checkout of manifold (issue #319).
 *
 *     bun run --cwd packages/plugin-kit verify <bundle>...
 *
 * Every author repository's own tests drive a fake host; this is the one command that proves
 * the artifact the release will ship actually composes. It spawns this checkout's server the
 * way the testkit's `startServer` does — a temporary data dir, a fixed owner key, a free port,
 * `MANIFOLD_PLUGIN_DEV_PATHS=1` so the bundle installs from where it lies — installs the
 * bundles parents first, and for each one asserts three things: the roster row is on and its
 * lifecycle is not a failure, and every door the row publishes ANSWERS when knocked with `{}`
 * as the owner. Any answer but `unavailable` will do: `invalid_args` and `refused` come from
 * the plugin's own code in its own process, which is the fact being checked; `unavailable` is
 * the runner saying that process is gone or mute. Then it uninstalls with `purge` in reverse.
 *
 * The first failure exits non-zero naming the bundle, the row or the door. One JSON line per
 * bundle on success. `@manifold/testkit` is private, so the thin spawn is repeated here rather
 * than imported: an author repository reaches this file and nothing behind it.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SERVER_ENTRY = "packages/server/src/main.ts";
const READY_LINE = /manifold ready url=(https?:\/\/[^\s"']+)/;
/**
 * A throwaway hub's key: it never outlives the command and opens nothing but the server this
 * process spawned on a loopback port, so it may be a constant (the testkit's is the same one).
 */
const OWNER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // gitleaks:allow
const READY_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;
const OUTPUT_LINE_LIMIT = 200;

export interface VerifyReport {
  readonly bundle: string;
  readonly id: string;
  readonly sha256: string;
  /** Every door the row published, each with the rung it answered (`ok` for a result). */
  readonly doors: Readonly<Record<string, string>>;
}

/** A named failure: the command exits on the first one, and the test reads its fields. */
export class VerifyFailure extends Error {
  readonly bundle: string;

  constructor(bundle: string, detail: string) {
    super(`${bundle}: ${detail}`);
    this.name = "VerifyFailure";
    this.bundle = bundle;
  }
}

export interface SpawnedServer extends Hub {
  readonly dataDir: string;
  /** Recent stdout/stderr, for the sentence a failure prints; bounded so it cannot grow. */
  readonly output: readonly string[];
  stop(): Promise<void>;
}

/** Whether this file sits inside a manifold checkout whose server it can spawn. */
export function canSpawnServer(): boolean {
  return Bun.file(join(REPO_ROOT, SERVER_ENTRY)).size > 0;
}

/**
 * Spawns `packages/server/src/main.ts` isolated from the parent's MANIFOLD_* environment and
 * resolves once the contract ready line names the port. `MANIFOLD_ANNOUNCE_KEY=1` is what
 * puts the key in that line; stdout here is an in-memory ring, never a persisted log.
 */
export async function startServer(): Promise<SpawnedServer> {
  const dataDir = await mkdtemp(join(tmpdir(), "manifold-verify-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("MANIFOLD_")) env[key] = value;
  }
  Object.assign(env, {
    MANIFOLD_PORT: "0",
    MANIFOLD_DATA_DIR: dataDir,
    MANIFOLD_OWNER_KEY: OWNER_KEY,
    MANIFOLD_SPAWN_AGENT: "0",
    MANIFOLD_ANNOUNCE_KEY: "1",
    MANIFOLD_PLUGIN_DEV_PATHS: "1",
  });
  const proc = Bun.spawn(["bun", SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const output: string[] = [];
  const { promise: ready, resolve, reject } = Promise.withResolvers<string>();
  const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of stream) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        output.push(line);
        if (output.length > OUTPUT_LINE_LIMIT) output.splice(0, output.length - OUTPUT_LINE_LIMIT);
        const url = READY_LINE.exec(line)?.[1];
        if (url !== undefined) resolve(url);
      }
    }
  };
  void collect(proc.stdout);
  void collect(proc.stderr);
  void proc.exited.then((code) => {
    reject(new Error(`server exited before readiness with code ${String(code)}`));
  });

  const stop = async (): Promise<void> => {
    if (proc.exitCode === null) {
      proc.kill("SIGTERM");
      const exited = await Promise.race([
        proc.exited.then(() => true),
        Bun.sleep(STOP_TIMEOUT_MS).then(() => false),
      ]);
      if (!exited) proc.kill("SIGKILL");
      await proc.exited;
    }
    await rm(dataDir, { recursive: true, force: true });
  };

  let readyUrl: string;
  try {
    readyUrl = await Promise.race([
      ready,
      Bun.sleep(READY_TIMEOUT_MS).then(() => {
        throw new Error(`server readiness timed out after ${String(READY_TIMEOUT_MS)}ms`);
      }),
    ]);
  } catch (error) {
    await stop();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n${output.join("\n")}`, { cause: error });
  }
  // The announced key is stripped from the origin and compared, never carried further: a
  // server that did not take the configured key is not the server this command started.
  const announced = new URLSearchParams(new URL(readyUrl).hash.slice(1)).get("key");
  if (announced !== OWNER_KEY) {
    await stop();
    throw new Error("server ready line does not carry the configured owner key");
  }
  return { url: new URL(readyUrl).origin, ownerKey: OWNER_KEY, dataDir, output, stop };
}

async function verifyOne(hub: Hub, facts: BundleFacts, bundle: string): Promise<VerifyReport> {
  await installBundle({ source: facts.source, hub, sha256: facts.sha256 });
  const row = (await roster(hub)).find((entry) => entry.manifest.id === facts.id);
  if (row === undefined)
    throw new VerifyFailure(bundle, `row ${facts.id} is not on the roster after install`);
  if (!row.enabled) throw new VerifyFailure(bundle, `row ${facts.id} is not enabled`);
  // `enable_failed` is a bundle refused at boot; `isolate_crashed` is its process gone past the
  // crash budget. Both are the row saying it cannot serve, which is exactly what this proves.
  if (row.lifecycle === "enable_failed" || row.lifecycle === "isolate_crashed") {
    const refusal = row.install?.refusal === undefined ? "" : ` (${row.install.refusal})`;
    throw new VerifyFailure(bundle, `row ${facts.id} is ${row.lifecycle}${refusal}`);
  }
  const doors: Record<string, string> = {};
  for (const action of row.actions) {
    const outcome = await dispatch(hub, hub.ownerKey, action.name, {});
    if (!outcome.ok && outcome.denial.rule === "unavailable") {
      throw new VerifyFailure(
        bundle,
        `door ${action.name} is unavailable: ${outcome.denial.message}`,
      );
    }
    doors[action.name] = outcome.ok ? "ok" : outcome.denial.rule;
  }
  return { bundle, id: facts.id, sha256: facts.sha256, doors };
}

/**
 * Installs, checks and removes every bundle on a server of its own. Reports arrive through
 * `onReport` as each bundle passes, so a run that fails on the third still printed two.
 */
export async function verifyBundles(
  bundles: readonly string[],
  onReport: (report: VerifyReport) => void = () => {},
): Promise<VerifyReport[]> {
  if (bundles.length === 0) throw new Error("verify needs at least one bundle");
  const inspected = await Promise.all(
    bundles.map(async (bundle) => {
      try {
        return { bundle, facts: await inspectBundle(bundle) };
      } catch (error) {
        const detail =
          error instanceof BundleError
            ? error.detail
            : error instanceof Error
              ? error.message
              : String(error);
        throw new VerifyFailure(bundle, detail);
      }
    }),
  );
  const ordered = familyOrder(inspected.map((entry) => ({ id: entry.facts.id, ...entry })));
  const hub = await startServer();
  const reports: VerifyReport[] = [];
  const installed: typeof ordered = [];
  try {
    for (const entry of ordered) {
      installed.push(entry);
      const report = await verifyOne(hub, entry.facts, entry.bundle);
      reports.push(report);
      onReport(report);
    }
    // Reverse: a part must be gone before its parent may be switched off and removed.
    for (const entry of [...installed].reverse()) {
      try {
        await ownerAction(hub, "engine.plugins.setEnabled", { id: entry.id, enabled: false });
        await ownerAction(hub, "engine.plugins.uninstall", { id: entry.id, purge: true });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new VerifyFailure(entry.bundle, `uninstall of ${entry.id}: ${detail}`);
      }
    }
  } catch (error) {
    if (error instanceof VerifyFailure) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    const at = installed.at(-1)?.bundle ?? bundles[0] ?? "";
    throw new VerifyFailure(at, detail);
  } finally {
    await hub.stop();
  }
  return reports;
}

if (import.meta.main) {
  const bundles = process.argv.slice(2);
  if (bundles.length === 0 || bundles.some((word) => word.startsWith("--"))) {
    console.error("usage: manifold-verify <bundle>...");
    process.exit(2);
  }
  try {
    await verifyBundles(bundles, (report) => {
      console.log(JSON.stringify(report));
    });
  } catch (error) {
    exitWith("verify", error);
  }
}
