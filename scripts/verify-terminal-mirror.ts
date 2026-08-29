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
 *   4. expand is a pure view flip: same xterm host node (no remount), screen
 *      state intact, box confined to the canvas area, dblclick shrinks back;
 *   5. parking one mirror removes only that copy: the other view stays live and
 *      typeable (PTY survives) and the non-last copy never enters the pool.
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
  await until(() => observer!.elements.size === 1, 10_000, "terminal visible to mirror client");
  const source = [...observer.elements.values()][0];
  if (source?.type !== "terminal") throw new Error("source terminal missing from canonical scene");
  const clone = {
    ...source,
    id: crypto.randomUUID(),
    x: source.x + 120,
    y: source.y + 80,
  };
  observer.transact((tx) => tx.create(clone));
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

  // 4. Expand is a pure VIEW flip: the same xterm host node is promoted to fill the
  //    canvas area (no remount, no re-snapshot), and a titlebar double-click shrinks it
  //    back to the exact canvas rect it came from.
  const sourceNode = `.react-flow__node[data-id="${source.id}"]`;
  const sourceFrame = JSON.stringify(`${sourceNode} .manifold-terminal`);
  const sourceCenter = await browser.evaluate<{ x: number; y: number }>(
    `(() => { const b = document.querySelector(${sourceFrame}).getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  await browser.drag([sourceCenter], 30);
  await sleep(500);
  await browser.typeText("echo EXPAND_VIEW_OK");
  await browser.typeText("\r");
  await until(
    () =>
      browser!.evaluate<boolean>(
        `(document.querySelector(${sourceFrame}).querySelector('.xterm-rows')?.textContent || '')
          .includes('EXPAND_VIEW_OK')`,
      ),
    8_000,
    "expand sentinel rendered",
  );

  // Stamp the live xterm host and keep a page-scoped reference: a remount would swap the
  // node identity even if the stamped attribute were reproduced.
  const canvasRect = await browser.evaluate<{
    left: number;
    top: number;
    width: number;
    height: number;
  }>(
    `(() => {
      const frame = document.querySelector(${sourceFrame});
      const host = frame.querySelector('.xterm-host');
      host.dataset.probe = 'alive';
      window.__expandProbe = host;
      const b = frame.getBoundingClientRect();
      return { left: b.left, top: b.top, width: b.width, height: b.height };
    })()`,
  );
  const expandClicked = await browser.evaluate<boolean>(
    `(() => {
      const button = document.querySelector(
        ${JSON.stringify(`${sourceNode} [aria-label="Expand terminal to full view"]`)},
      );
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`,
  );
  if (!expandClicked) throw new Error("terminal titlebar has no enabled expand button");
  await until(
    () =>
      browser!.evaluate<boolean>("document.querySelector('.manifold-terminal--expanded') !== null"),
    8_000,
    "terminal expanded",
  );
  await sleep(800);

  const expanded = await browser.evaluate<{
    sameNode: boolean;
    probed: boolean;
    marker: boolean;
    left: number;
    right: number;
    top: number;
    bottom: number;
    viewportWidth: number;
    viewportHeight: number;
    sidebarRight: number;
    shrinkLabel: boolean;
  }>(
    `(() => {
      const frame = document.querySelector(${sourceFrame});
      const host = frame.querySelector('.xterm-host');
      const sidebar = document.querySelector('aside.pad-sidebar');
      const box = frame.getBoundingClientRect();
      return {
        sameNode: host === window.__expandProbe && host.isConnected,
        probed: host.dataset.probe === 'alive',
        marker: (host.querySelector('.xterm-rows')?.textContent || '').includes('EXPAND_VIEW_OK'),
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        sidebarRight: sidebar === null ? -1 : sidebar.getBoundingClientRect().right,
        shrinkLabel:
          frame.querySelector('[aria-label="Shrink terminal to canvas"]') !== null,
      };
    })()`,
  );
  check(
    "expand reuses the same xterm host node",
    expanded.sameNode && expanded.probed,
    `sameNode=${String(expanded.sameNode)} probe=${String(expanded.probed)}`,
  );
  check(
    "expanded view keeps its rendered screen state",
    expanded.marker,
    `marker visible after expand: ${String(expanded.marker)}`,
  );
  check(
    "expanded box starts at the canvas area, not the sidebar",
    expanded.sidebarRight >= 0 && expanded.left >= expanded.sidebarRight - 1,
    `expanded left=${expanded.left.toFixed(1)} sidebar right=${expanded.sidebarRight.toFixed(1)}`,
  );
  check(
    "expanded box fills exactly the canvas column",
    expanded.right <= expanded.viewportWidth + 1 &&
      expanded.right >= expanded.viewportWidth - 1 &&
      expanded.top <= 1 &&
      expanded.bottom >= expanded.viewportHeight - 1,
    `right=${expanded.right.toFixed(1)} viewport=${String(expanded.viewportWidth)} top=${expanded.top.toFixed(1)} bottom=${expanded.bottom.toFixed(1)}/${String(expanded.viewportHeight)}`,
  );
  check(
    "expand control flips to shrink",
    expanded.shrinkLabel,
    `shrink control present: ${String(expanded.shrinkLabel)}`,
  );

  const dblClicked = await browser.evaluate<boolean>(
    `(() => {
      const bar = document.querySelector(${JSON.stringify(`${sourceNode} .terminal-titlebar`)});
      if (bar === null) return false;
      const b = bar.getBoundingClientRect();
      bar.dispatchEvent(
        new MouseEvent('dblclick', {
          bubbles: true,
          cancelable: true,
          view: window,
          detail: 2,
          clientX: b.left + b.width / 2,
          clientY: b.top + b.height / 2,
        }),
      );
      return true;
    })()`,
  );
  if (!dblClicked) throw new Error("expanded terminal has no titlebar to double-click");
  await until(
    () =>
      browser!.evaluate<boolean>("document.querySelector('.manifold-terminal--expanded') === null"),
    8_000,
    "double-click shrank the terminal",
  );
  await sleep(800);
  const shrunk = await browser.evaluate<{
    left: number;
    top: number;
    width: number;
    height: number;
    sameNode: boolean;
  }>(
    `(() => {
      const frame = document.querySelector(${sourceFrame});
      const host = frame.querySelector('.xterm-host');
      const b = frame.getBoundingClientRect();
      return {
        left: b.left,
        top: b.top,
        width: b.width,
        height: b.height,
        sameNode: host === window.__expandProbe && host.isConnected,
      };
    })()`,
  );
  const drift = Math.max(
    Math.abs(shrunk.left - canvasRect.left),
    Math.abs(shrunk.top - canvasRect.top),
    Math.abs(shrunk.width - canvasRect.width),
    Math.abs(shrunk.height - canvasRect.height),
  );
  check(
    "titlebar double-click restores the canvas rect",
    drift <= 2 && shrunk.sameNode,
    `drift=${drift.toFixed(1)}px sameNode=${String(shrunk.sameNode)}`,
  );

  // 5. Parking one mirror removes only that copy; the other view stays live and typeable.
  //    The close button now deliberately KILLS the shared PTY, so copy removal is the Park
  //    affordance. Parking a non-last copy must NOT enter the workspace pool: the session
  //    stays bound to this pad through the surviving element.
  const cloneParked = await browser.evaluate<boolean>(
    `(() => {
      const button = document.querySelector(
        ${JSON.stringify(`.react-flow__node[data-id="${clone.id}"] [aria-label="Park terminal to sidebar"]`)},
      );
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`,
  );
  if (!cloneParked) throw new Error("clone node has no park button");
  await until(async () => (await termCount()) === 1, 10_000, "mirror parked");
  await sleep(600);
  const cloneGone = await browser.evaluate<boolean>(
    `document.querySelector(${JSON.stringify(`.react-flow__node[data-id="${clone.id}"]`)}) === null`,
  );
  const survivingViews = await termCount();
  check(
    "parking one mirror removes only that copy",
    cloneGone && survivingViews === 1,
    `cloneNodePresent=${String(!cloneGone)} views=${String(survivingViews)}`,
  );
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
    "parking one mirror leaves the other live",
    survivorState && survivorTypes && !exitedStrip,
    `state=${String(survivorState)} typeable=${String(survivorTypes)} exitedStrip=${String(exitedStrip)}`,
  );
  // The sidebar pool refetches on sessions_changed as well as on its poll, and the park round
  // trip plus the typing above is well past both, so an empty pool here is a real negative.
  const pooledRow = await browser.evaluate<boolean>(
    "document.querySelector('.terminal-pool-row') !== null",
  );
  check(
    "parking a non-last copy never enters the pool",
    !pooledRow,
    `sidebar pool rows present: ${String(pooledRow)}`,
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
