/**
 * manifold multi-client convergence gate.
 *
 * The bug class this guards: the browser-canvas↔SDK projection layer losing, reverting,
 * or silently not-sending edits while every wire-level test stays green. It drives TWO
 * real browsers through real pointer gestures against a throwaway local server and asserts,
 * after quiescence, the strongest invariant the system claims:
 *
 *   A.canvas ≡ A.sdkScene ≡ server canonical ≡ B.sdkScene ≡ B.canvas
 *
 * compared by version stamp AND geometry (stamp-only comparison cannot distinguish a
 * converged-but-truncated scene from a correct one). Every round also asserts its own
 * EFFECT — element-count delta and per-element stamp change — so a silently no-op
 * gesture fails the round instead of passing it vacuously.
 *
 * Requires the debug seam (localStorage "manifold:debug" = "1"; packages/web/src/debug-seam.ts).
 * Self-contained: builds the web bundle to a temp dir, spawns its own server, cleans up
 * even on failure.
 *
 * Usage:  bun scripts/verify-convergence.ts            # or: bun run verify:convergence
 * Env:    MANIFOLD_CHROMIUM (else system chromium)
 *
 * Exit 0 only if every round converges with its expected effect.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionClient } from "../packages/sdk/src/index.ts";
import type { SceneElement } from "../packages/protocol/src/index.ts";
import { Browser, sleep, until } from "./cdp.ts";

function debugPortIsAvailable(port: number): boolean {
  try {
    const probe = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { data() {} },
    });
    probe.stop(true);
    return true;
  } catch {
    return false;
  }
}

function availableDebugPorts(): readonly [number, number] {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const first = 9400 + Math.floor(Math.random() * 200);
    const second = first + 200 + Math.floor(Math.random() * 200);
    if (debugPortIsAvailable(first) && debugPortIsAvailable(second)) return [first, second];
  }
  throw new Error("could not find two available Chromium debug ports");
}

const repoRoot = join(import.meta.dir, "..");
const distDir = mkdtempSync(join(tmpdir(), "manifold-conv-dist-"));
const dataDir = mkdtempSync(join(tmpdir(), "manifold-conv-data-"));
const [debugPortA, debugPortB] = availableDebugPorts();
let origin = "";

console.log("building web bundle...");
const build = Bun.spawnSync(["bunx", "vite", "build", "--outDir", distDir, "--emptyOutDir"], {
  cwd: join(repoRoot, "packages/web"),
  stdout: "pipe",
  stderr: "pipe",
});
if (build.exitCode !== 0) {
  console.error(build.stderr.toString());
  throw new Error("web build failed");
}

const server = Bun.spawn(["bun", "packages/server/src/main.ts"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    MANIFOLD_PORT: "0",
    MANIFOLD_DATA_DIR: dataDir,
    MANIFOLD_WEB_DIST: distDir,
    MANIFOLD_SPAWN_AGENT: "0",
  },
  stdout: "pipe",
  stderr: "inherit",
});

async function serverOriginFromReadyLine(): Promise<string> {
  const reader = server.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffered += decoder.decode(chunk.value, { stream: true });
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const readyUrl = /manifold ready url=(https?:\/\/[^\s"']+)/.exec(line)?.[1];
      if (readyUrl !== undefined) return new URL(readyUrl).origin;
    }
  }
  throw new Error("server exited before emitting its ready URL");
}

async function stopServer(): Promise<void> {
  if (server.exitCode === null) server.kill("SIGTERM");
  const stopped = await Promise.race([
    server.exited.then(() => true),
    Bun.sleep(5_000).then(() => false),
  ]);
  if (!stopped && server.exitCode === null) server.kill("SIGKILL");
  await server.exited;
}

const browserA = new Browser();
const browserB = new Browser();
const failures: string[] = [];
let observer: SessionClient | null = null;

interface Snapshot {
  readonly id: string;
  readonly version: number;
  readonly versionNonce: number;
  readonly isDeleted: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Viewport {
  readonly scrollX: number;
  readonly scrollY: number;
  readonly zoom: number;
  readonly offsetLeft: number;
  readonly offsetTop: number;
}

try {
  origin = await Promise.race([
    serverOriginFromReadyLine(),
    Bun.sleep(20_000).then(() => {
      throw new Error("server readiness timed out after 20000ms");
    }),
  ]);
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
    body: JSON.stringify({ name: "convergence-gate" }),
  });
  const padId = ((await created.json()) as { pad: { id: string } }).pad.id;

  // ---------------------------------------------------------------- clients

  async function openPad(
    browser: Browser,
    debugPort: number,
    name: string,
    color?: string,
  ): Promise<void> {
    await browser.launch(debugPort);
    await browser.goto(`${origin}/#key=${ownerKey}`);
    await browser.evaluate("localStorage.setItem('manifold:debug', '1')");
    if (await browser.evaluate<boolean>("document.querySelector('input') !== null")) {
      await browser.typeInto("input", name);
      if (color !== undefined) {
        const selected = await browser.evaluate<boolean>(
          `(() => { const swatch = document.querySelector(${JSON.stringify(`[aria-label="Use color ${color}"]`)});
            if (!(swatch instanceof HTMLButtonElement)) return false; swatch.click(); return true; })()`,
        );
        if (!selected) throw new Error(`${name}: identity color ${color} not found`);
      }
      await browser.clickText("Enter manifold");
    }
    await browser.goto(`${origin}/p/${padId}`);
    await until(
      () =>
        browser.evaluate<boolean>(
          "(document.querySelector('[data-testid=connection-state]')?.textContent ?? '').toLowerCase() === 'open'",
        ),
      20_000,
      `${name}: session open`,
    );
    await until(
      () => browser.evaluate<boolean>("window.__manifold !== undefined"),
      10_000,
      `${name}: debug seam installed`,
    );
  }

  const cursorColor = "#e03131";
  await openPad(browserA, debugPortA, "convA", cursorColor);
  await openPad(browserB, debugPortB, "convB");

  // ------------------------------------------------ presence & status chrome

  if (await browserA.evaluate<boolean>("document.querySelector('.UserList') !== null")) {
    throw new Error("convA: stock UserList rendered despite UIOptions.userList=false");
  }
  console.log("PASS  stock UserList suppressed");
  await until(
    () =>
      browserA.evaluate<boolean>(
        "document.querySelectorAll('.presence-wrapper .presence-avatar').length === 2",
      ),
    10_000,
    "convA: presence island shows self + convB",
  );
  console.log("PASS  presence island shows both principals");
  if (
    !(await browserA.evaluate<boolean>(
      "(document.querySelector('.pad-sidebar .workspace-status [data-testid=connection-state]')?.textContent ?? '').toLowerCase() === 'open'",
    ))
  ) {
    throw new Error("convA: sidebar workspace status missing or not open");
  }
  console.log("PASS  sidebar workspace status is live");

  const changelogOpened = await browserA.evaluate<boolean>(
    `(() => {
      const button = document.querySelector('.pad-sidebar-version');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`,
  );
  if (!changelogOpened) throw new Error("convA: web version button missing");
  await until(
    () =>
      browserA.evaluate<boolean>(
        "document.querySelector('.web-changelog-dialog')?.hasAttribute('open') === true",
      ),
    5_000,
    "convA: changelog dialog open",
  );
  const changelogValid = await browserA.evaluate<boolean>(
    `(() => {
      const dialog = document.querySelector('.web-changelog-dialog');
      const label = document.querySelector('.pad-sidebar-version')?.textContent ?? '';
      return dialog?.getAttribute('aria-labelledby') === 'web-changelog-title'
        && label.startsWith('v') && label.includes(' · ')
        && dialog.querySelectorAll('.web-changelog-releases li').length > 0;
    })()`,
  );
  if (!changelogValid) throw new Error("convA: changelog dialog content or build label invalid");
  await browserA.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await browserA.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await until(
    () =>
      browserA.evaluate<boolean>(
        "document.querySelector('.web-changelog-dialog') === null && document.activeElement?.classList.contains('pad-sidebar-version') === true",
      ),
    5_000,
    "convA: changelog closes and restores focus",
  );
  console.log("PASS  web build label opens an accessible changelog and Escape restores focus");

  const identityBeforeRefresh = await browserA.evaluate<string>(
    "localStorage.getItem('manifold.identity') ?? ''",
  );
  await browserA.goto(`${origin}/p/${padId}`);
  await until(
    () =>
      browserA.evaluate<boolean>(
        "(document.querySelector('[data-testid=connection-state]')?.textContent ?? '').toLowerCase() === 'open'",
      ),
    20_000,
    "convA: session reopened after refresh",
  );
  const identityAfterRefresh = await browserA.evaluate<string>(
    "localStorage.getItem('manifold.identity') ?? ''",
  );
  if (identityAfterRefresh !== identityBeforeRefresh) {
    throw new Error("convA: persisted principal changed across page refresh");
  }
  await browserA.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 620, y: 360 });
  await until(
    () =>
      browserB.evaluate<boolean>(
        `(() => {
          const cursor = document.querySelector(${JSON.stringify(`[data-cursor-color="${cursorColor}"]`)});
          if (!(cursor instanceof HTMLElement)) return false;
          const rect = cursor.getBoundingClientRect();
          const style = getComputedStyle(cursor);
          return rect.width > 0 && rect.height > 0
            && style.display !== "none" && style.visibility !== "hidden"
            && style.color === "rgb(224, 49, 49)";
        })()`,
      ),
    5_000,
    "convA: chosen identity color rendered on convB cursor after refresh",
  );
  console.log("PASS  refresh preserves principal and chosen cursor color");

  const sdk = new SessionClient({
    url: `${origin.replace(/^http/, "ws")}/ws/session`,
    padId,
    token: ownerKey,
    reconnect: false,
  });
  observer = sdk;
  await sdk.connect();

  // ---------------------------------------------------------------- views & invariant

  /** id → "version:nonce:x:y" — geometry included so converged-but-truncated states differ. */
  type ViewMap = Map<string, string>;

  const stampNumber = (value: unknown): string =>
    typeof value === "number" ? value.toFixed(1) : "0";

  function toViewMap(snapshots: readonly Snapshot[]): ViewMap {
    const map: ViewMap = new Map();
    for (const s of snapshots) {
      map.set(
        s.id,
        `${String(s.version)}:${String(s.versionNonce)}:${s.x.toFixed(1)}:${s.y.toFixed(1)}`,
      );
    }
    return map;
  }

  function canonicalView(): ViewMap {
    const map: ViewMap = new Map();
    for (const el of sdk.scene.values()) {
      map.set(
        el.id,
        `${String(el.version)}:${String(el.versionNonce)}:${stampNumber(el["x"])}:${stampNumber(el["y"])}`,
      );
    }
    return map;
  }

  async function view(browser: Browser, which: "canvas" | "scene"): Promise<ViewMap> {
    const snapshots = await browser.evaluate<readonly Snapshot[]>(`window.__manifold.${which}()`);
    return toViewMap(snapshots);
  }

  function diffMaps(label: string, expected: ViewMap, actual: ViewMap): string[] {
    const lines: string[] = [];
    for (const [id, stamp] of expected) {
      const other = actual.get(id);
      if (other === undefined) lines.push(`${label}: missing ${id} (canonical ${stamp})`);
      else if (other !== stamp) lines.push(`${label}: ${id} at ${other}, canonical ${stamp}`);
    }
    for (const id of actual.keys()) {
      if (!expected.has(id)) lines.push(`${label}: extra ${id} not in canonical`);
    }
    return lines;
  }

  function mapsEqual(a: ViewMap, b: ViewMap): boolean {
    if (a.size !== b.size) return false;
    for (const [id, stamp] of a) if (b.get(id) !== stamp) return false;
    return true;
  }

  interface RoundEffect {
    /** Exact number of NEW canonical elements this round must create. */
    readonly adds: number;
    /** Ids whose canonical stamp (version or geometry) must have advanced. */
    readonly changes?: readonly string[];
  }

  /**
   * Runs one round: capture canonical before-state, perform gestures, wait for five-view
   * convergence, then assert the round's declared effect. Probe errors surface in the
   * failure output instead of being reported as stale diffs.
   */
  async function round(name: string, effect: RoundEffect, act: () => Promise<void>): Promise<void> {
    const before = canonicalView();
    let lastDiff: string[] = [];
    try {
      await act();
      await until(
        async () => {
          const canonical = canonicalView();
          const views: [string, ViewMap][] = [
            ["A.canvas", await view(browserA, "canvas")],
            ["A.scene", await view(browserA, "scene")],
            ["B.scene", await view(browserB, "scene")],
            ["B.canvas", await view(browserB, "canvas")],
          ];
          lastDiff = views.flatMap(([label, m]) =>
            mapsEqual(m, canonical) ? [] : diffMaps(label, canonical, m),
          );
          for (const [browser, label] of [
            [browserA, "A"],
            [browserB, "B"],
          ] as const) {
            const pending = await browser.evaluate<readonly string[]>(
              "window.__manifold.pending()",
            );
            if (pending.length > 0) lastDiff.push(`${label}.pending: ${pending.join(",")}`);
          }
          // Effect assertions: a silently no-op gesture must fail, not pass vacuously.
          const canonicalNow = canonicalView();
          if (canonicalNow.size !== before.size + effect.adds) {
            lastDiff.push(
              `effect: expected ${String(before.size + effect.adds)} canonical elements, have ${String(canonicalNow.size)}`,
            );
          }
          for (const id of effect.changes ?? []) {
            if (canonicalNow.get(id) === before.get(id)) {
              lastDiff.push(`effect: ${id} canonical stamp did not advance`);
            }
          }
          return lastDiff.length === 0;
        },
        12_000,
        "five-view convergence with declared effect",
      );
      console.log(`PASS  ${name} — converged, ${String(canonicalView().size)} elements canonical`);
    } catch (error) {
      failures.push(name);
      console.log(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`);
      for (const line of lastDiff) console.log(`        ${line}`);
    }
  }

  // ---------------------------------------------------------------- rounds

  console.log(`convergence rounds against ${origin} pad ${padId}`);
  const canvasLeftA = await browserA.evaluate<number>(
    "document.querySelector('.pad-browser-canvas')?.getBoundingClientRect().left ?? 0",
  );

  const terminalElement = (id: string, x: number, y: number): SceneElement => ({
    id,
    type: "terminal",
    sessionId: `convergence-${id}`,
    x,
    y,
    width: 480,
    height: 320,
    zIndex: 0,
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    isDeleted: false,
  });
  const moveFlowNode = async (
    browser: Browser,
    elementId: string,
    dx: number,
    dy: number,
  ): Promise<void> => {
    const start = await browser.evaluate<{ readonly x: number; readonly y: number } | null>(
      `(() => {
          const titlebar = document.querySelector(
            ${JSON.stringify(`.react-flow__node[data-id="${elementId}"] .terminal-titlebar`)},
          );
          if (!(titlebar instanceof HTMLElement)) return null;
          const rect = titlebar.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return null;
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()`,
    );
    if (start === null) throw new Error(`terminal ${elementId} has no rendered drag handle`);
    const steps = 20;
    await browser.drag(
      Array.from({ length: steps + 1 }, (_, index) => ({
        x: start.x + (dx * index) / steps,
        y: start.y + (dy * index) / steps,
      })),
      15,
    );
  };

  const first = terminalElement(crypto.randomUUID(), 280, 180);
  await round("F1 SDK seed projects into both canvases", { adds: 1 }, async () => {
    sdk.updateScene([first]);
  });
  await round("F2 browser A drags a terminal", { adds: 0, changes: [first.id] }, () =>
    moveFlowNode(browserA, first.id, 150, 90),
  );

  const second = terminalElement(crypto.randomUUID(), 900, 420);
  await round("F3 second SDK seed projects into both canvases", { adds: 1 }, async () => {
    sdk.updateScene([second]);
  });
  await round(
    "F4 concurrent browser moves converge",
    { adds: 0, changes: [first.id, second.id] },
    async () => {
      await Promise.all([
        moveFlowNode(browserA, second.id, -90, 120),
        moveFlowNode(browserB, first.id, 110, -70),
      ]);
    },
  );
  await round(
    "F5 frozen tab resumes to canonical geometry",
    { adds: 0, changes: [first.id] },
    async () => {
      await browserB.setLifecycle("frozen");
      await moveFlowNode(browserA, first.id, 80, 60);
      await sleep(500);
      await browserB.setLifecycle("active");
    },
  );

  const cursorFrames: { readonly x: number; readonly y: number }[] = [];
  const offCursor = sdk.on("cursor", (message) => {
    cursorFrames.push({ x: message.x, y: message.y });
  });
  const viewportBefore = await browserA.evaluate<Viewport>("window.__manifold.viewport()");
  const panStart = { x: canvasLeftA + 700, y: 650 };
  await browserA.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...panStart });
  await browserA.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...panStart,
    button: "middle",
    buttons: 4,
  });
  for (let index = 1; index <= 14; index += 1) {
    await browserA.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: panStart.x - index * 10,
      y: panStart.y - index * 6,
      button: "middle",
      buttons: 4,
    });
    await sleep(15);
  }
  await browserA.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: panStart.x - 140,
    y: panStart.y - 84,
    button: "middle",
  });
  await sleep(300);
  const viewportAfter = await browserA.evaluate<Viewport>("window.__manifold.viewport()");
  offCursor();
  if (
    Math.abs(viewportAfter.scrollX - viewportBefore.scrollX) < 50 ||
    Math.abs(viewportAfter.scrollY - viewportBefore.scrollY) < 30
  ) {
    throw new Error("Flow viewport did not move under a real middle-button pan");
  }
  if (cursorFrames.length < 3) {
    throw new Error(`Flow pan emitted only ${String(cursorFrames.length)} cursor frames`);
  }
  console.log("PASS  F6 viewport pan and cursor transport cross the browser boundary");
} finally {
  // ---------------------------------------------------------------- teardown
  await browserA.close().catch(() => undefined);
  await browserB.close().catch(() => undefined);
  observer?.close();
  await stopServer();
  rmSync(distDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.log(`\nFAILED rounds: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nall convergence rounds passed");
