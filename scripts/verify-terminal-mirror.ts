/**
 * manifold terminal-mirror regression gate.
 *
 * Guards the mirrored-terminal contract at the RENDERED boundary: two native
 * terminal records can bind the same PTY, producing two live viewports. The
 * regression this pins: the SDK sent `terminal_attach` only on the 0→1 refcount
 * transition, so a view subscribing after the first snapshot never received
 * screen state and rendered as an empty "zombie" that ignored live output.
 *
 * Asserted end to end in a REAL browser:
 *   1. the clone renders screen state that existed BEFORE it was created;
 *   2. live output mirrors to both views;
 *   3. after a reload both views render (no mount-race zombie);
 *   4. closing one mirror leaves the other live and typeable (PTY survives).
 *
 * The second mirror is created through the production SDK. Canvas gesture policy
 * is separate from the attach/refcount contract under test.
 *
 * Self-contained: builds the web bundle to a temp dir, spawns its own server +
 * agent, cleans up. Env: MANIFOLD_CHROMIUM (else system chromium).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionClient } from "../packages/sdk/src/index.ts";
import { Browser, sleep, until } from "./cdp.ts";

const repoRoot = join(import.meta.dir, "..");
const distDir = join(mkdtempSync(join(tmpdir(), "manifold-mir-")), "dist");
const dataDir = mkdtempSync(join(tmpdir(), "manifold-mir-data-"));
const port = 41000 + Math.floor(Math.random() * 2000);
const origin = `http://127.0.0.1:${String(port)}`;

const build = Bun.spawnSync(["bunx", "vite", "build", "--outDir", distDir, "--emptyOutDir"], {
  cwd: join(repoRoot, "packages", "web"),
  stdout: "ignore",
  stderr: "inherit",
});
if (!build.success) throw new Error("web build failed");

const server = Bun.spawn(["bun", "packages/server/src/main.ts"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    MANIFOLD_PORT: String(port),
    MANIFOLD_DATA_DIR: dataDir,
    MANIFOLD_WEB_DIST: distDir,
    MANIFOLD_SPAWN_AGENT: "1",
  },
  // Server boot log prints the owner-key URL: NEVER inherit it into gate logs
  // (secrets discipline, AGENTS invariant 6).
  stdout: "ignore",
  stderr: "inherit",
});

const failures: string[] = [];
let browser: Browser | null = null;
let observer: SessionClient | null = null;

function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  if (!ok) failures.push(`${name}: ${detail}`);
}

try {
  await until(
    async () => {
      try {
        return (await fetch(`${origin}/healthz`)).ok;
      } catch {
        return false;
      }
    },
    20_000,
    "local server healthz",
  );
  const ownerKey = (await Bun.file(join(dataDir, "owner.key")).text()).trim();
  const httpHeaders = { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" };

  const created = await fetch(`${origin}/api/pads`, {
    method: "POST",
    headers: httpHeaders,
    body: JSON.stringify({ name: "terminal-mirror-gate" }),
  });
  const padId = ((await created.json()) as { pad: { id: string } }).pad.id;

  browser = new Browser();
  await browser.launch(9345);
  await browser.goto(`${origin}/#key=${ownerKey}`);
  if (await browser.evaluate<boolean>("document.querySelector('input') !== null")) {
    await browser.typeInto("input", "mirror-gate");
    await browser.clickText("Enter manifold");
  }
  await browser.goto(`${origin}/p/${padId}`);
  await until(
    () => browser!.evaluate<boolean>("document.querySelector('.react-flow') !== null"),
    20_000,
    "canvas mounted",
  );

  await until(
    () =>
      browser!.evaluate<boolean>(
        "document.querySelector('[data-testid=machines-section] > summary') !== null",
      ),
    20_000,
    "sidebar machine section",
  );

  // Create a terminal directly from an online machine row in the sidebar.
  await browser.evaluate(
    "document.querySelector('[data-testid=machines-section] > summary').click()",
  );
  await until(
    () =>
      browser!.evaluate<boolean>(
        "document.querySelector('[aria-label^=\"New terminal on \"]') !== null",
      ),
    20_000,
    "online machine terminal action",
  );
  await browser.evaluate("document.querySelector('[aria-label^=\"New terminal on \"]').click()");
  await until(
    () => browser!.evaluate<boolean>("document.querySelector('.xterm-rows') !== null"),
    20_000,
    "xterm rendered",
  );
  await sleep(600);

  const center = () =>
    browser!.evaluate<{ x: number; y: number }>(
      "(() => { const b = document.querySelector('.manifold-terminal').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()",
    );
  const showing = (marker: string) =>
    browser!.evaluate<boolean[]>(
      `[...document.querySelectorAll('.manifold-terminal')].map(t => (t.querySelector('.xterm-rows')?.textContent || '').includes('${marker}'))`,
    );
  const termCount = () =>
    browser!.evaluate<number>("document.querySelectorAll('.manifold-terminal').length");

  // Screen state that must exist BEFORE the clone is born.
  const c0 = await center();
  await browser.drag([c0], 30); // click-to-focus
  await sleep(500);
  await browser.typeText("clear; echo PRE_CLONE_STATE");
  await browser.typeText("\r");
  await until(
    async () => (await showing("PRE_CLONE_STATE"))[0] === true,
    8_000,
    "marker rendered before clone",
  );

  // Create a second native canvas record bound to the same live PTY through the SDK.
  observer = new SessionClient({
    url: `${origin.replace(/^http/, "ws")}/ws/session`,
    padId,
    token: ownerKey,
    reconnect: false,
  });
  await observer.connect();
  await until(() => observer!.scene.size === 1, 10_000, "terminal visible to mirror client");
  const source = [...observer.scene.values()][0];
  if (source === undefined) throw new Error("source terminal missing from canonical scene");
  const clone = {
    ...source,
    id: crypto.randomUUID(),
    x: (typeof source["x"] === "number" ? source["x"] : 0) + 120,
    y: (typeof source["y"] === "number" ? source["y"] : 0) + 80,
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
  };
  observer.updateScene([clone]);
  await until(async () => (await termCount()) === 2, 10_000, "SDK update produced a mirror");
  await sleep(1200);

  // 1. The clone must render PRE-EXISTING screen state (the zombie regression).
  const pre = await showing("PRE_CLONE_STATE");
  check(
    "clone renders pre-existing screen state",
    pre.length === 2 && pre.every(Boolean),
    `views showing marker: [${pre.join(", ")}]`,
  );

  // 2. Live output mirrors to both views.
  const first = await browser.evaluate<{ x: number; y: number }>(
    "(() => { const b = document.querySelectorAll('.manifold-terminal')[0].getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()",
  );
  await browser.drag([first], 30);
  await sleep(500);
  await browser.typeText("echo LIVE_MIRROR_OK");
  await browser.typeText("\r");
  await sleep(1000);
  const live = await showing("LIVE_MIRROR_OK");
  check(
    "live output mirrors to both views",
    live.length === 2 && live.every(Boolean),
    `views showing marker: [${live.join(", ")}]`,
  );

  // 3. Reload: both views must render (mount-race zombie).
  await browser.goto(`${origin}/p/${padId}`);
  await until(
    () =>
      browser!.evaluate<boolean>(
        "document.querySelectorAll('.manifold-terminal').length === 2 && document.querySelectorAll('.xterm-rows').length === 2",
      ),
    25_000,
    "both terminals re-rendered after reload",
  );
  await sleep(1500);
  const reloaded = await showing("LIVE_MIRROR_OK");
  check(
    "both views render after reload",
    reloaded.length === 2 && reloaded.every(Boolean),
    `views showing marker: [${reloaded.join(", ")}]`,
  );

  // 4. Closing one mirror leaves the other live and typeable.
  const cloneClosed = await browser.evaluate<boolean>(
    `(() => {
      const button = document.querySelector(
        ${JSON.stringify(`.react-flow__node[data-id="${clone.id}"] .terminal-ctl--close`)},
      );
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`,
  );
  if (!cloneClosed) throw new Error("clone node has no close button");
  await until(async () => (await termCount()) === 1, 10_000, "mirror closed");
  await sleep(600);
  const survivorState = await browser.evaluate<boolean>(
    "(document.querySelector('.xterm-rows')?.textContent || '').includes('LIVE_MIRROR_OK')",
  );
  const cs = await center();
  await browser.drag([cs], 30);
  await sleep(500);
  await browser.typeText("echo SURVIVOR_ALIVE");
  await browser.typeText("\r");
  await sleep(1000);
  const survivorTypes = await browser.evaluate<boolean>(
    "(document.querySelector('.xterm-rows')?.textContent || '').includes('SURVIVOR_ALIVE')",
  );
  const exitedStrip = await browser.evaluate<boolean>(
    "document.querySelector('.terminal-exited') !== null",
  );
  check(
    "closing one mirror leaves the other live",
    survivorState && survivorTypes && !exitedStrip,
    `state=${String(survivorState)} typeable=${String(survivorTypes)} exitedStrip=${String(exitedStrip)}`,
  );
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await browser?.close();
  observer?.close();
  server.kill();
  rmSync(distDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(
  failures.length === 0
    ? "\nterminal-mirror gate: GREEN"
    : `\nterminal-mirror gate: RED\n${failures.map((f) => ` - ${f}`).join("\n")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
