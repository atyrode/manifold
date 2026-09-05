/**
 * manifold PWA gate — installability, the offline shell, and origin configurability.
 *
 * The three claims of the App-shells near milestone (`AXIOMS.md` §Roadmap, issue #109), each
 * asserted the only way it can honestly be asserted: by asking a real browser rather than by
 * reading the files back.
 *
 *   1. INSTALLABLE. Chromium's own installability verdict (`Page.getInstallabilityErrors`) and
 *      its own reading of the web app manifest (`Page.getAppManifest`) must both come back
 *      clean, with the shell worker CONTROLLING the page. A manifest that parses is not an
 *      install prompt.
 *   2. OFFLINE SHELL, and nothing more. With the network cut the chrome still paints and the
 *      disconnected condition is NAMED on screen — and `/api` is still refused, because a lens
 *      that served stale scene state from a cache would be lying about what it knows. A stale
 *      cached bundle in front of a newer instance is REFUSED, in both directions, rather than
 *      reconnecting forever (`AGENTS.md` invariant 10). A foreign shell generation is swept on
 *      activation, so a deploy cannot leave a browser pinned to an old lens.
 *   3. PORTABLE. A lens served by instance A is pointed at instance B with one query
 *      parameter, and then talks to B — HTTP and WebSocket both, cross-origin, with A's
 *      credential untouched beside B's. Two servers, one bundle, no second client.
 *
 * Self-contained: builds the web bundle to a temp dir (or shares the orchestrator's),
 * spawns TWO servers with separate data dirs, cleans up. Env: MANIFOLD_CHROMIUM.
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionOutcomeSchema,
  ContainerResponseSchema,
  PROTOCOL_VERSION,
} from "../packages/protocol/src/index.ts";
import { resolveWebDist } from "./gate-dist.ts";
import { Browser } from "./cdp.ts";
import { ownerKeyOf, reserveLoopbackPort, sleep, teardownServer, until } from "./gate-lib.ts";

const repoRoot = join(import.meta.dir, "..");
const { distDir, cleanup: cleanupDist } = resolveWebDist("manifold-pwa-");
const dataDirA = mkdtempSync(join(tmpdir(), "manifold-pwa-a-"));
const dataDirB = mkdtempSync(join(tmpdir(), "manifold-pwa-b-"));
const portA = reserveLoopbackPort();
const portB = reserveLoopbackPort();
const originA = `http://127.0.0.1:${String(portA)}`;
const originB = `http://127.0.0.1:${String(portB)}`;

/*
  Both instances serve a COPY of the build. This gate is the one that simulates a deploy — it
  rewrites the worker the server hands out — and the orchestrator shares one dist between every
  gate, so mutating it in place would corrupt a sibling's run.
*/
const serveDir = join(mkdtempSync(join(tmpdir(), "manifold-pwa-serve-")), "dist");
cpSync(distDir, serveDir, { recursive: true });

function spawnInstance(port: number, dataDir: string): Bun.Subprocess {
  return Bun.spawn(["bun", "packages/server/src/main.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MANIFOLD_PORT: String(port),
      MANIFOLD_DATA_DIR: dataDir,
      MANIFOLD_WEB_DIST: serveDir,
      MANIFOLD_SPAWN_AGENT: "0",
    },
    // The boot line prints the owner-key URL: never inherit it into gate logs (invariant 6).
    stdout: "ignore",
    stderr: "inherit",
  });
}

const serverA = spawnInstance(portA, dataDirA);
const serverB = spawnInstance(portB, dataDirB);

const failures: string[] = [];
let browser: Browser | null = null;

/** One assertion, recorded rather than thrown, so a red gate reports every failing claim. */
function assert(what: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok   ${what}`);
    return;
  }
  failures.push(detail === "" ? what : `${what} — ${detail}`);
  console.log(`  FAIL ${what}${detail === "" ? "" : ` — ${detail}`}`);
}

async function createContainer(origin: string, ownerKey: string, name: string): Promise<string> {
  const response = await fetch(`${origin}/api/actions/core.index.createContainer`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const outcome = ActionOutcomeSchema.parse(await response.json());
  if (!outcome.ok) throw new Error(`createContainer refused: ${outcome.denial.message}`);
  return ContainerResponseSchema.parse(outcome.result).container.id;
}

/** Crosses the identity gate if it is standing; a device that already holds a grant has none. */
async function enterIdentity(driver: Browser, name: string): Promise<void> {
  if (!(await driver.evaluate<boolean>("document.querySelector('input') !== null"))) return;
  await driver.typeInto("input", name);
  await driver.clickTestId("identity-enter");
  await sleep(1200);
}

async function seenTestId(driver: Browser, testid: string): Promise<boolean> {
  return await driver.evaluate<boolean>(
    `document.querySelector('[data-testid=${testid}]') !== null`,
  );
}

try {
  for (const [origin, label] of [
    [originA, "instance A"],
    [originB, "instance B"],
  ] as const) {
    await until(
      async () => {
        try {
          return (await fetch(`${origin}/healthz`)).ok;
        } catch {
          return false;
        }
      },
      20_000,
      `${label} healthz`,
    );
  }

  const ownerA = await ownerKeyOf(dataDirA);
  const ownerB = await ownerKeyOf(dataDirB);
  const nameA = "pwa-gate-here";
  const nameB = "pwa-gate-elsewhere";
  await createContainer(originA, ownerA, nameA);
  await createContainer(originB, ownerB, nameB);

  browser = new Browser();
  await browser.launch();
  const driver = browser;

  // ───────────────────────────────────────────────────────────── 1. installability
  console.log("\n1. installability");
  await driver.goto(`${originA}/#key=${ownerA}`);
  await enterIdentity(driver, "pwa-gate");

  const manifest = await driver.send("Page.getAppManifest", {});
  const manifestErrors = (manifest.result?.["errors"] ?? []) as { message?: string }[];
  const manifestText = String(manifest.result?.["data"] ?? "");
  assert(
    "the browser reads the web app manifest without errors",
    manifestErrors.length === 0,
    manifestErrors.map((entry) => entry.message ?? "?").join("; "),
  );
  const declared = manifestText === "" ? {} : (JSON.parse(manifestText) as Record<string, unknown>);
  assert("the manifest names the app", declared["name"] === "manifold");
  assert("the manifest declares a standalone display mode", declared["display"] === "standalone");
  assert(
    "the manifest ships an icon set",
    Array.isArray(declared["icons"]) && declared["icons"].length > 0,
  );
  assert(
    "nothing in the manifest names an instance",
    !manifestText.includes("127.0.0.1") && !manifestText.includes(originA),
    manifestText,
  );

  await until(
    async () => await driver.evaluate<boolean>("navigator.serviceWorker.controller !== null"),
    20_000,
    "the shell worker to control the page",
  );
  assert("the shell worker controls the page", true);

  const installability = await driver.send("Page.getInstallabilityErrors", {});
  const installErrors = (installability.result?.["installabilityErrors"] ?? []) as {
    errorId?: string;
  }[];
  assert(
    "chromium reports the app as installable",
    installErrors.length === 0,
    installErrors.map((entry) => entry.errorId ?? "?").join("; "),
  );

  const shellCaches = await driver.evaluate<string[]>(
    "caches.keys().then((names) => names.filter((name) => name.startsWith('manifold-shell-')))",
  );
  assert(
    "the shell is cached under exactly one build-keyed generation",
    shellCaches.length === 1 && /^manifold-shell-.+-[0-9a-f]{8}$/.test(shellCaches[0] ?? ""),
    shellCaches.join(", "),
  );
  const cachedShell = await driver.evaluate<boolean>(
    `caches.open(${JSON.stringify(shellCaches[0] ?? "")})
       .then((cache) => cache.match('/index.html'))
       .then((hit) => hit !== undefined)`,
  );
  assert("the cached generation holds the shell document", cachedShell);

  // ─────────────────────────────────────────── 2. a deploy cannot pin a browser
  console.log("\n2. deploy and handover");
  const generations = async (): Promise<string[]> =>
    await driver.evaluate<string[]>(
      "caches.keys().then((names) => names.filter((name) => name.startsWith('manifold-shell-')))",
    );
  /*
    A DEPLOY, done the way one actually reaches a browser: the worker the instance serves has
    different bytes, so the browser installs a second generation beside the running one. Only the
    served COPY is rewritten — the shared build the orchestrator hands every gate is never touched.
  */
  const workerPath = join(serveDir, "sw.js");
  const deployed = "deployed-cafe1234";
  await Bun.write(
    workerPath,
    (await Bun.file(workerPath).text()).replace(/"build":"([^"]+)"/, `"build":"${deployed}"`),
  );
  await driver.goto(`${originA}/`);
  await until(async () => await seenTestId(driver, "lens-update"), 20_000, "the update offer");
  assert("a deploy is offered to a live page rather than swapped under it", true);
  const bothGenerations = await generations();
  assert(
    "the running generation survives beside the new one until the human accepts",
    bothGenerations.length === 2 && bothGenerations.includes(`manifold-shell-${deployed}`),
    bothGenerations.join(", "),
  );
  await driver.evaluate(
    "(document.querySelector('[data-testid=lens-update] button').click(), null)",
  );
  await sleep(3500);
  assert("accepting the update clears the offer", !(await seenTestId(driver, "lens-update")));
  const swept = await generations();
  assert(
    "and sweeps every older generation, so no browser stays pinned to an old lens",
    swept.length === 1 && swept[0] === `manifold-shell-${deployed}`,
    swept.join(", "),
  );

  // ───────────────────────────────────────────────────────────── 3. offline shell
  console.log("\n3. offline shell");
  await driver.send("Network.enable", {});
  await driver.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  await driver.goto(`${originA}/`);
  await sleep(1500);
  // The title is `manifold`, or `manifold · development` when the gate's own build is one (it is:
  // a checkout past a tag is the development channel, `scripts/build-identity.ts`).
  assert(
    "the shell paints with no network",
    await driver.evaluate<boolean>(
      "/^manifold( · development)?$/.test(document.title) && document.getElementById('root').childElementCount > 0",
    ),
  );
  assert("the disconnected condition is named on screen", await seenTestId(driver, "lens-offline"));
  assert(
    "the named condition says which instance is unreachable",
    (
      await driver.evaluate<string>(
        "document.querySelector('[data-testid=lens-offline]').textContent",
      )
    ).includes(originA),
  );
  assert(
    "a door is never answered from the cache",
    (await driver.evaluate<string>(
      "fetch('/api/plugins').then(() => 'answered').catch(() => 'refused')",
    )) === "refused",
  );
  await driver.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });

  // ─────────────────────────────────────────────────────── 4. protocol skew refusal
  console.log("\n4. protocol skew");
  for (const [drift, heading, action] of [
    [1, "This app is out of date", "Reload manifold"],
    [-1, "This instance is out of date", "Check again"],
  ] as const) {
    const injected = await driver.send("Page.addScriptToEvaluateOnNewDocument", {
      // The INSTANCE is what drifts here, so the instance's answer is what the gate rewrites:
      // the client under test keeps its own compiled-in PROTOCOL_VERSION.
      source: `(() => {
        const real = window.fetch;
        window.fetch = async (input, init) => {
          const response = await real(input, init);
          const url = typeof input === 'string' ? input : input.url;
          if (!url.includes('/healthz')) return response;
          const body = await response.json();
          body.protocolVersion = ${String(PROTOCOL_VERSION + drift)};
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        };
      })()`,
    });
    await driver.goto(`${originA}/`);
    await until(async () => await seenTestId(driver, "lens-skew"), 15_000, "the skew refusal");
    const card = await driver.evaluate<string>(
      "document.querySelector('[data-testid=lens-skew]').textContent",
    );
    assert(
      `skew ${drift > 0 ? "behind" : "ahead"} names the direction`,
      card.includes(heading),
      card,
    );
    assert(
      `skew ${drift > 0 ? "behind" : "ahead"} offers the path that can actually help`,
      (await driver.evaluate<string>(
        "document.querySelector('[data-testid=lens-skew-action]').textContent",
      )) === action,
    );
    assert(
      "a refused lens does not paint the workspace",
      !(await seenTestId(driver, "connection-status")),
    );
    await driver.send("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: String(injected.result?.["identifier"]),
    });
  }

  // ──────────────────────────────────────────────────── 5. origin configurability
  console.log("\n5. origin configurability");
  await driver.goto(`${originA}/`);
  await sleep(1000);
  const grantHere = await driver.evaluate<string>(
    "localStorage.getItem('manifold.identity') ?? ''",
  );
  assert("this device holds a grant from the instance that served it", grantHere !== "");

  await driver.goto(`${originA}/?instance=${encodeURIComponent(originB)}#key=${ownerB}`);
  await sleep(1200);
  assert(
    "the chosen instance is remembered on this device",
    (await driver.evaluate<string>("localStorage.getItem('manifold:instance') ?? ''")) === originB,
  );
  assert(
    "the one-shot carrier is consumed, not left in the URL",
    (await driver.evaluate<string>("location.search + location.hash")) === "",
  );
  assert(
    "looking elsewhere is a named, visible condition",
    await seenTestId(driver, "lens-instance"),
  );
  await enterIdentity(driver, "pwa-gate-elsewhere");
  assert(
    "the foreign instance's grant is kept beside the local one, never over it",
    (await driver.evaluate<string>("localStorage.getItem('manifold.identity') ?? ''")) ===
      grantHere &&
      (await driver.evaluate<string>(
        `localStorage.getItem('manifold.identity@${originB}') ?? ''`,
      )) !== "",
  );
  await until(
    async () =>
      await driver.evaluate<boolean>(
        `document.body.textContent.includes(${JSON.stringify(nameB)})`,
      ),
    25_000,
    "the foreign instance's own index",
  );
  assert("the lens reads the instance it was pointed at", true);
  assert(
    "and nothing from the instance that merely served the bundle",
    !(await driver.evaluate<boolean>(
      `document.body.textContent.includes(${JSON.stringify(nameA)})`,
    )),
  );
  assert(
    "the session socket followed the lens across origins",
    (await driver.evaluate<string>(
      "document.querySelector('[data-testid=connection-state]')?.textContent ?? ''",
    )) === "Open",
  );

  await driver.evaluate(
    "(document.querySelector('[data-testid=lens-instance] button').click(), null)",
  );
  await sleep(1500);
  assert(
    "the way home forgets the choice",
    (await driver.evaluate<string>("localStorage.getItem('manifold:instance') ?? ''")) === "",
  );
  assert("and the lens is looking here again", !(await seenTestId(driver, "lens-instance")));
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  const said = browser?.drainMessages() ?? [];
  for (const message of said.slice(-25)) {
    console.log(`  page ${message.kind}/${message.level}: ${message.text}`);
  }
} finally {
  await browser?.close();
  await Promise.all([teardownServer(serverA, dataDirA), teardownServer(serverB, dataDirB)]);
  cleanupDist();
  rmSync(join(serveDir, ".."), { recursive: true, force: true });
}

console.log(
  failures.length === 0
    ? "\npwa gate: GREEN"
    : `\npwa gate: RED\n${failures.map((entry) => ` - ${entry}`).join("\n")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
