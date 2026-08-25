/**
 * manifold terminal-mirror regression gate.
 *
 * Guards the cloned-terminal contract at the RENDERED boundary: duplicating a
 * terminal element (alt+drag) creates a MIRROR — same PTY, two viewports. The
 * regression this pins: the SDK sent `terminal_attach` only on the 0→1 refcount
 * transition, so a view subscribing after the first snapshot (a fresh clone, or
 * the mount-race loser after refresh) never received screen state and rendered
 * as an empty "zombie" that ignored all live output.
 *
 * Asserted end to end in a REAL browser:
 *   1. the clone renders screen state that existed BEFORE it was created;
 *   2. live output mirrors to both views;
 *   3. after a reload both views render (no mount-race zombie);
 *   4. closing one mirror leaves the other live and typeable (PTY survives).
 *
 * The clone gesture here targets an IDLE (deactivated) terminal — the native
 * Excalidraw alt+drag path. Alt+drag on an ACTIVATED terminal is a separate,
 * still-open gesture-entry issue (#20) and is deliberately not covered.
 *
 * Self-contained: builds the web bundle to a temp dir, spawns its own server +
 * agent, cleans up. Env: MANIFOLD_CHROMIUM (else system chromium).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    () => browser!.evaluate<boolean>("document.querySelector('.excalidraw') !== null"),
    20_000,
    "canvas mounted",
  );

  // Create a terminal through the app's own menu flow.
  await browser.evaluate("document.querySelector('.main-menu-trigger').click()");
  await sleep(400);
  await browser.clickText("New terminal");
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

  // Deactivate: click a point on EMPTY canvas derived from real geometry (a
  // hard-coded corner can fall outside the headless viewport or on an overlay).
  const empty = await browser.evaluate<{ x: number; y: number }>(
    "(() => { const b = document.querySelector('.manifold-terminal').getBoundingClientRect(); return { x: Math.max(20, b.x - 80), y: Math.max(20, b.y - 80) }; })()",
  );
  await browser.drag([empty], 30);
  await sleep(400);
  const deactivated = await browser.evaluate<boolean>(
    "document.activeElement?.closest('.manifold-terminal') === null || document.activeElement?.closest('.manifold-terminal') === undefined",
  );
  if (!deactivated) throw new Error("terminal still focused after empty-canvas click");
  const start = await center();
  const CDP_ALT = 1;
  await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x, y: start.y });
  await browser.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: start.x,
    y: start.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
    modifiers: CDP_ALT,
  });
  for (let i = 1; i <= 8; i++) {
    await browser.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: start.x + i * 35,
      y: start.y + i * 22,
      buttons: 1,
      modifiers: CDP_ALT,
    });
    await sleep(30);
  }
  await browser.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: start.x + 280,
    y: start.y + 176,
    button: "left",
    buttons: 0,
    clickCount: 1,
    modifiers: CDP_ALT,
  });
  await until(async () => (await termCount()) === 2, 10_000, "alt+drag produced a clone");
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
  const closeBtn = await browser.evaluate<{ x: number; y: number } | null>(
    "(() => { const t = [...document.querySelectorAll('.manifold-terminal')][1]; const b = [...t.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || '').includes('Close')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()",
  );
  if (closeBtn === null) throw new Error("clone has no close button");
  await browser.drag([closeBtn], 30);
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
