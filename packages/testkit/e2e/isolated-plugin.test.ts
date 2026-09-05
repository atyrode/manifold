import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActionOutcomeSchema,
  PluginsResponseSchema,
  type ActionOutcome,
  type PluginRosterEntry,
} from "@manifold/protocol";
import { callAction, ownerFetch, startServer, type TestServer } from "../src/index.ts";
import { e2eFailure, stopProcesses } from "./helpers.ts";

/**
 * AN INSTALLED PLUGIN, END TO END (ADR 0016 §8 stage 1): the kit's reference plugin is packed
 * into the one artifact the install door reads, admitted through `engine.plugins.install` on a
 * REAL server, and its server half answers from its OWN process — storage persisting across
 * dispatches, both guest-graded rungs (`invalid_args`, `refused`) arriving through the host's
 * ladder — before it is refused, restarted, tampered with and uninstalled.
 *
 * Packing runs the kit's `pack` as a real second process rather than `Bun.build` in-process:
 * under `bun test` from the repository root the in-process build cannot resolve the isolated
 * linker's per-package `node_modules` (see `packages/plugin-kit/test/pack.test.ts`).
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const KIT = join(REPO_ROOT, "packages/plugin-kit");
const SAMPLE = join(KIT, "test/fixtures/sample");
const PLUGIN_ID = "acme.counter";
const BUMP = `${PLUGIN_ID}.bump`;
const BUNDLE_NAME = `${PLUGIN_ID}.manifold-plugin.json`;
/** The fixture's own domain limit: `bump` refuses once the count would pass one thousand. */
const COUNTER_CEILING = 1_000;
/** `bump`'s largest legal step, from the fixture's `input` schema. */
const MAX_STEP = 100;
/** Path sources anywhere on the host: the door's development opt-in (`docs/PLUGINS.md` §7). */
const DEV_PATHS = { MANIFOLD_PLUGIN_DEV_PATHS: "1" } as const;

let packDir = "";
let bundlePath = "";
let sha256 = "";

beforeAll(async () => {
  packDir = mkdtempSync(join(tmpdir(), "manifold-isolated-plugin-"));
  bundlePath = join(packDir, BUNDLE_NAME);
  const pack = Bun.spawn(["bun", join(KIT, "src/pack.ts"), SAMPLE, "--out", bundlePath], {
    cwd: KIT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(pack.stdout).text(),
    new Response(pack.stderr).text(),
    pack.exited,
  ]);
  if (code !== 0) throw new Error(`pack exited ${String(code)}: ${stderr}`);
  const printed: unknown = JSON.parse(stdout);
  if (
    typeof printed !== "object" ||
    printed === null ||
    !("sha256" in printed) ||
    typeof printed.sha256 !== "string"
  ) {
    throw new Error(`pack printed no sha256: ${stdout}`);
  }
  sha256 = printed.sha256;
});

afterAll(() => {
  rmSync(packDir, { recursive: true, force: true });
});

async function roster(server: TestServer): Promise<readonly PluginRosterEntry[]> {
  return (await ownerFetch(server, "/api/plugins", { responseSchema: PluginsResponseSchema }))
    .plugins;
}

async function rosterRow(server: TestServer): Promise<PluginRosterEntry | undefined> {
  return (await roster(server)).find((entry) => entry.manifest.id === PLUGIN_ID);
}

function install(server: TestServer, source: string, pin: string): Promise<ActionOutcome> {
  return callAction(server, server.ownerKey, "engine.plugins.install", { source, sha256: pin });
}

function bump(server: TestServer, args: unknown): Promise<ActionOutcome> {
  return callAction(server, server.ownerKey, BUMP, args);
}

/** The count a successful bump answered with; throws on any denial so a test reads one number. */
async function bumpedTo(server: TestServer, by?: number): Promise<number> {
  const outcome = await bump(server, by === undefined ? {} : { by });
  if (!outcome.ok) throw new Error(`${BUMP} refused: ${outcome.denial.message}`);
  const result = outcome.result;
  if (typeof result !== "object" || result === null || !("count" in result)) {
    throw new Error(`${BUMP} answered no count: ${JSON.stringify(result)}`);
  }
  return Number(result.count);
}

function uninstall(server: TestServer, purge = false): Promise<ActionOutcome> {
  return callAction(server, server.ownerKey, "engine.plugins.uninstall", {
    id: PLUGIN_ID,
    ...(purge ? { purge: true } : {}),
  });
}

async function webModule(server: TestServer): Promise<Response> {
  return fetch(new URL(`/api/plugins/${PLUGIN_ID}/web.js`, server.httpUrl), {
    headers: { authorization: `Bearer ${server.ownerKey}` },
  });
}

/** `<data>/plugins/<id>`: the plugin's home on disk, where its pinned bundle and members live. */
function installHome(server: TestServer): string {
  return join(server.dataDir, "plugins", PLUGIN_ID);
}

/** The same bytes with one flipped, written beside the original: the pin no longer holds. */
async function tamperedCopy(from: string, to: string): Promise<void> {
  const bytes = new Uint8Array(await Bun.file(from).arrayBuffer());
  const at = Math.floor(bytes.length / 2);
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  await Bun.write(to, bytes);
}

/** Stops every server, then removes the data dirs they wrote — a restart pair shares one. */
async function stopServers(servers: readonly TestServer[]): Promise<void> {
  try {
    await stopProcesses(servers);
  } finally {
    for (const server of servers) rmSync(server.dataDir, { recursive: true, force: true });
  }
}

test("an installed plugin composes, answers its door from its own process, and uninstalls", async () => {
  const servers: TestServer[] = [];
  try {
    const server = await startServer({ env: DEV_PATHS });
    servers.push(server);

    const admitted = await install(server, bundlePath, sha256);
    expect(admitted).toEqual({
      ok: true,
      result: { id: PLUGIN_ID, version: "1.0.0", grantedCaps: ["containers:read"] },
    });

    /*
      The roster row: a `plugin` row like any assembled one, carrying the one block no
      first-party row has. A fresh install is ON — the enablement set is a DISABLED set, and a
      new id is not in it — and its lifecycle is plain `ok` (absent) once the child has answered
      `load`, which the door awaits before it returns.
    */
    const row = await rosterRow(server);
    expect(row).toBeDefined();
    expect(row?.source).toBe("plugin");
    expect(row?.enabled).toBe(true);
    expect(row?.lifecycle).toBeUndefined();
    expect(row?.install).toEqual({
      sha256,
      source: bundlePath,
      grantedCaps: ["containers:read"],
      installedBy: expect.any(String),
      installedAt: expect.any(Number),
    });
    expect(row?.actions.map((action) => action.name)).toEqual([BUMP]);
    expect(row?.manifest.entry).toEqual({ server: true, web: "web.js" });

    // Storage is the child's only memory and it lives on the host: the second answer carries
    // the first, proving the `storage.set` call crossed the boundary and landed.
    expect(await bumpedTo(server)).toBe(1);
    expect(await bumpedTo(server)).toBe(2);

    // The argument rung is graded IN THE CHILD against the fixture's own zod, and arrives
    // through the host's ladder under the engine's own rule name.
    const badArgs = await bump(server, { by: 0 });
    expect(badArgs.ok).toBe(false);
    if (!badArgs.ok) expect(badArgs.denial.rule).toBe("invalid_args");
    const strayKey = await bump(server, { by: 1, loud: true });
    expect(strayKey.ok).toBe(false);
    if (!strayKey.ok) expect(strayKey.denial.rule).toBe("invalid_args");

    // The handler's own `{ refused }`: walk the count to the fixture's ceiling and step over it.
    let count = 2;
    while (count + MAX_STEP <= COUNTER_CEILING) count = await bumpedTo(server, MAX_STEP);
    const overCeiling = await bump(server, { by: MAX_STEP });
    expect(overCeiling).toEqual({
      ok: false,
      denial: { rule: "refused", message: "the counter stops at one thousand" },
    });
    // A refusal is not a commit: the count is where the last success left it.
    expect(await bumpedTo(server, 1)).toBe(count + 1);

    // The web half is served for an installed, enabled plugin, tagged with the install's pin.
    const served = await webModule(server);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toStartWith("text/javascript");
    expect(served.headers.get("cache-control")).toBe("no-store");
    expect(served.headers.get("etag")).toBe(`"${sha256}"`);
    expect(await served.text()).toContain(PLUGIN_ID);

    // Removing running code is refused by name; disabled, the row and its files both go, and
    // the web half stops being served — while the plugin's storage is NOT this door's to touch.
    const stillOn = await uninstall(server);
    expect(stillOn.ok).toBe(false);
    if (!stillOn.ok) {
      expect(stillOn.denial.rule).toBe("refused");
      expect(stillOn.denial.message).toStartWith("still_enabled:");
    }
    const switchedOff = await callAction(server, server.ownerKey, "engine.plugins.setEnabled", {
      id: PLUGIN_ID,
      enabled: false,
    });
    expect(switchedOff.ok).toBe(true);
    expect((await webModule(server)).status).toBe(404);
    const disabledDoor = await bump(server, {});
    expect(disabledDoor.ok).toBe(false);
    if (!disabledDoor.ok) expect(disabledDoor.denial.rule).toBe("plugin_disabled");
    expect(existsSync(installHome(server))).toBe(true);
    // The row is off but its storage is not empty: uninstall refuses by name (#233, option c)
    // and leaves everything in place; `purge: true` consents, purges first, then uninstalls.
    const retained = await uninstall(server);
    expect(retained.ok).toBe(false);
    if (!retained.ok) {
      expect(retained.denial.rule).toBe("refused");
      expect(retained.denial.message).toStartWith("storage_retained:");
    }
    expect(existsSync(installHome(server))).toBe(true);
    expect(await uninstall(server, true)).toEqual({ ok: true, result: {} });
    expect(await rosterRow(server)).toBeUndefined();
    expect(existsSync(installHome(server))).toBe(false);
    expect((await webModule(server)).status).toBe(404);
    const gone = await bump(server, {});
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.denial.rule).toBe("unknown_action");

    // Uninstall forgets the code AND the switch: a reinstall of the same id is a fresh row, on
    // by default like a first install, and - because this uninstall purged - counting from zero.
    expect((await install(server, bundlePath, sha256)).ok).toBe(true);
    expect((await rosterRow(server))?.enabled).toBe(true);
    expect(await bumpedTo(server, 1)).toBe(1);
  } catch (error) {
    throw e2eFailure(error, servers);
  } finally {
    await stopServers(servers);
  }
});

test("a bundle that does not hash to its pin is refused and leaves nothing behind", async () => {
  const servers: TestServer[] = [];
  try {
    const server = await startServer({ env: DEV_PATHS });
    servers.push(server);
    const tampered = join(packDir, `tampered.${BUNDLE_NAME}`);
    await tamperedCopy(bundlePath, tampered);

    const refused = await install(server, tampered, sha256);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.denial.rule).toBe("refused");
      expect(refused.denial.message).toStartWith("hash_mismatch:");
    }
    expect(await rosterRow(server)).toBeUndefined();
    expect(existsSync(installHome(server))).toBe(false);
    expect(existsSync(join(server.dataDir, "plugins"))).toBe(false);
  } catch (error) {
    throw e2eFailure(error, servers);
  } finally {
    await stopServers(servers);
  }
});

test("an install survives a restart: the row is re-verified, respawned, and its storage kept", async () => {
  const servers: TestServer[] = [];
  try {
    const first = await startServer({ env: DEV_PATHS });
    servers.push(first);
    expect((await install(first, bundlePath, sha256)).ok).toBe(true);
    expect(await bumpedTo(first, 5)).toBe(5);
    await first.stop("SIGTERM");

    const restarted = await startServer({
      dataDir: first.dataDir,
      ownerKey: first.ownerKey,
      env: DEV_PATHS,
    });
    servers.push(restarted);
    const row = await rosterRow(restarted);
    expect(row?.enabled).toBe(true);
    expect(row?.lifecycle).toBeUndefined();
    expect(row?.install?.sha256).toBe(sha256);
    expect(row?.install?.refusal).toBeUndefined();
    expect(row?.actions.map((action) => action.name)).toEqual([BUMP]);
    // A fresh child, the same storage: the count continues rather than restarting at zero.
    expect(await bumpedTo(restarted, 1)).toBe(6);
    expect((await webModule(restarted)).status).toBe(200);
  } catch (error) {
    throw e2eFailure(error, servers);
  } finally {
    await stopServers(servers);
  }
});

test("a stored bundle tampered with between boots is refused by name and never loaded", async () => {
  const servers: TestServer[] = [];
  try {
    const first = await startServer({ env: DEV_PATHS });
    servers.push(first);
    expect((await install(first, bundlePath, sha256)).ok).toBe(true);
    await first.stop("SIGTERM");

    const stored = join(installHome(first), `${sha256}.manifold-plugin.json`);
    expect(existsSync(stored)).toBe(true);
    await tamperedCopy(stored, stored);

    const restarted = await startServer({
      dataDir: first.dataDir,
      ownerKey: first.ownerKey,
      env: DEV_PATHS,
    });
    servers.push(restarted);
    /*
      R8, fail-closed: the row stays on the roster so the failure is SEEN, and nothing from the
      file is trusted - not its title, not its code. Its DOORS are still published, from the
      summaries the install row remembered, so a dispatch answers by name at a traced rung
      (`unavailable`, naming the refusal) instead of the untraced `unknown_action`.
    */
    const row = await rosterRow(restarted);
    expect(row?.lifecycle).toBe("enable_failed");
    expect(row?.install?.refusal).toBe("hash_mismatch");
    expect(row?.install?.sha256).toBe(sha256);
    expect(row?.enabled).toBe(true);
    expect(row?.manifest.version).toBe("unverified");
    expect(row?.actions.map((action) => action.name)).toEqual([`${PLUGIN_ID}.bump`]);
    const denied = ActionOutcomeSchema.parse(await bump(restarted, {}));
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.denial.rule).toBe("unavailable");
      expect(denied.denial.message).toContain("hash_mismatch");
    }
    expect((await webModule(restarted)).status).toBe(404);
    // The refused file stays where it was: the row is the installer's consent, and only an
    // uninstall — which needs the row off — may remove it.
    expect(existsSync(stored)).toBe(true);
    expect(readdirSync(installHome(first)).length).toBeGreaterThan(0);
  } catch (error) {
    throw e2eFailure(error, servers);
  } finally {
    await stopServers(servers);
  }
});
