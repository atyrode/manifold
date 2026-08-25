/**
 * manifold multi-client convergence gate.
 *
 * The bug class this guards: the Excalidraw↔SDK projection layer losing, reverting, or
 * silently not-sending edits while every wire-level test stays green. It drives TWO real
 * browsers through real pointer gestures against a throwaway local server and asserts,
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
import { Browser, sleep, until } from "./cdp.ts";

const repoRoot = join(import.meta.dir, "..");
const distDir = mkdtempSync(join(tmpdir(), "manifold-conv-dist-"));
const dataDir = mkdtempSync(join(tmpdir(), "manifold-conv-data-"));
const port = 39000 + Math.floor(Math.random() * 2000);
const debugPortA = 9400 + Math.floor(Math.random() * 200);
const debugPortB = debugPortA + 200 + Math.floor(Math.random() * 200);
const origin = `http://127.0.0.1:${String(port)}`;

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
    MANIFOLD_PORT: String(port),
    MANIFOLD_DATA_DIR: dataDir,
    MANIFOLD_WEB_DIST: distDir,
    MANIFOLD_SPAWN_AGENT: "0",
  },
  stdout: "ignore",
  stderr: "inherit",
});

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
          "(document.querySelector('[data-testid=connection-state]')?.textContent ?? '') === 'open'",
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
    () => browserA.evaluate<boolean>("document.querySelectorAll('.presence-avatar').length === 2"),
    10_000,
    "convA: presence island shows self + convB",
  );
  console.log("PASS  presence island shows both principals");
  if (
    !(await browserA.evaluate<boolean>(
      "(document.querySelector('.status-island [data-testid=connection-state]')?.textContent ?? '') === 'open'",
    ))
  ) {
    throw new Error("convA: status island missing or not open");
  }
  console.log("PASS  status island live in the top-right cluster");

  const identityBeforeRefresh = await browserA.evaluate<string>(
    "localStorage.getItem('manifold.identity') ?? ''",
  );
  await browserA.goto(`${origin}/p/${padId}`);
  await until(
    () =>
      browserA.evaluate<boolean>(
        "(document.querySelector('[data-testid=connection-state]')?.textContent ?? '') === 'open'",
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
          const target = [224, 49, 49];
          for (const canvas of document.querySelectorAll('canvas')) {
            const rect = canvas.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const context = canvas.getContext('2d');
            if (context === null) continue;
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            const left = Math.max(0, Math.floor((620 - rect.left - 45) * scaleX));
            const top = Math.max(0, Math.floor((360 - rect.top - 45) * scaleY));
            const width = Math.min(canvas.width - left, Math.ceil(90 * scaleX));
            const height = Math.min(canvas.height - top, Math.ceil(90 * scaleY));
            if (width <= 0 || height <= 0) continue;
            const pixels = context.getImageData(left, top, width, height).data;
            for (let i = 0; i < pixels.length; i += 4) {
              if (
                Math.abs(pixels[i] - target[0]) <= 2 &&
                Math.abs(pixels[i + 1] - target[1]) <= 2 &&
                Math.abs(pixels[i + 2] - target[2]) <= 2 &&
                pixels[i + 3] > 200
              ) return true;
            }
          }
          return false;
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

  // ---------------------------------------------------------------- gestures

  async function selectTool(browser: Browser, tool: string): Promise<void> {
    const clicked = await browser.evaluate<boolean>(
      `(() => { const b = document.querySelector('[data-testid=toolbar-${tool}]'); if (!b) return false; b.click(); return true; })()`,
    );
    if (!clicked) throw new Error(`toolbar-${tool} not found`);
    await sleep(200);
  }

  function strokePoints(x0: number, y0: number, dx: number, dy: number, n: number) {
    return Array.from({ length: n }, (_, i) => ({
      x: x0 + (dx * i) / n,
      y: y0 + (dy * i) / n + Math.round(Math.sin(i / 3) * 30),
    }));
  }

  async function freedraw(browser: Browser, x0: number, y0: number): Promise<void> {
    await selectTool(browser, "freedraw");
    await browser.drag(strokePoints(x0, y0, 260, 120, 30), 15);
  }

  /** Screen-space point on the TOP EDGE of an element — transparent-fill shapes only hit-test on their stroke. */
  async function edgeOf(browser: Browser, elementId: string): Promise<{ x: number; y: number }> {
    const found = await browser.evaluate<{ snap: Snapshot; vp: Viewport } | null>(
      `(() => { const el = window.__manifold.canvas().find((e) => e.id === ${JSON.stringify(elementId)});
        const vp = window.__manifold.viewport();
        return el && vp ? { snap: el, vp } : null; })()`,
    );
    if (found === null) throw new Error(`element ${elementId} not on canvas`);
    const { snap, vp } = found;
    return {
      x: (snap.x + snap.width / 2 + vp.scrollX) * vp.zoom + vp.offsetLeft,
      y: (snap.y + vp.scrollY) * vp.zoom + vp.offsetTop,
    };
  }

  async function moveElementByEdge(
    browser: Browser,
    elementId: string,
    dx: number,
    dy: number,
  ): Promise<void> {
    await selectTool(browser, "selection");
    const from = await edgeOf(browser, elementId);
    const steps = 20;
    await browser.drag(
      Array.from({ length: steps + 1 }, (_, i) => ({
        x: from.x + (dx * i) / steps,
        y: from.y + (dy * i) / steps,
      })),
      15,
    );
  }

  // ---------------------------------------------------------------- rounds

  console.log(`convergence rounds against ${origin} pad ${padId}`);

  await round("R1 solo stroke", { adds: 1 }, () => freedraw(browserA, 300, 250));

  await round("R2 concurrent strokes", { adds: 2 }, async () => {
    await Promise.all([freedraw(browserA, 300, 500), freedraw(browserB, 800, 250)]);
  });

  await round("R3a rectangle created", { adds: 1 }, async () => {
    await selectTool(browserA, "rectangle");
    await browserA.drag(
      [
        { x: 900, y: 550 },
        { x: 1040, y: 640 },
      ],
      30,
    );
  });
  const rect = [...sdk.scene.values()].find((el) => el["type"] === "rectangle");
  if (rect === undefined) throw new Error("rectangle not in canonical scene");

  await round("R3b concurrent move and stroke", { adds: 1, changes: [rect.id] }, async () => {
    await Promise.all([
      moveElementByEdge(browserA, rect.id, -180, -120),
      freedraw(browserB, 500, 650),
    ]);
  });

  await round("R4 frozen tab resume", { adds: 1, changes: [rect.id] }, async () => {
    await browserB.setLifecycle("frozen");
    await freedraw(browserA, 1050, 300);
    await moveElementByEdge(browserA, rect.id, 60, 90);
    await sleep(1500);
    await browserB.setLifecycle("active");
  });

  // A second rectangle, created by B: rect1 is aliased on B, rect2 is aliased on A, so the
  // cross-move exercises the aliasing hazard in BOTH directions with a reliably
  // hit-testable gesture (edge drags; freedraw bounding-box edges miss the actual path —
  // the hardened effect assertion caught exactly that as a silent no-op).
  await round("R5a second rectangle by B", { adds: 1 }, async () => {
    await selectTool(browserB, "rectangle");
    // Clear of the left properties island (visible while a shape tool is active) and of
    // every prior round's strokes.
    await browserB.drag(
      [
        { x: 620, y: 130 },
        { x: 760, y: 210 },
      ],
      30,
    );
  });
  const rect2 = [...sdk.scene.values()].find(
    (el) => el["type"] === "rectangle" && el.id !== rect.id,
  );
  if (rect2 === undefined) throw new Error("second rectangle not in canonical scene");

  await round(
    "R5b bidirectional aliased cross moves",
    { adds: 0, changes: [rect.id, rect2.id] },
    async () => {
      await Promise.all([
        moveElementByEdge(browserA, rect2.id, -40, 100),
        moveElementByEdge(browserB, rect.id, 120, -60),
      ]);
    },
  );

  await round("R6 rapid-fire strokes", { adds: 3 }, async () => {
    await freedraw(browserA, 250, 700);
    await freedraw(browserA, 550, 720);
    await freedraw(browserA, 850, 700);
  });

  // R7: THE aliasing regression — B moves an element it received from A (painted from the
  // canonical scene, i.e. the exact object-aliasing hazard). Pre-clone-fix this diverges:
  // B's canvas AND B's SDK scene advance together in place, reconcile sees an idempotent
  // duplicate, and nothing is ever sent. The `changes` effect assertion doubles as the
  // no-op guard: if the gesture misses, rect's canonical stamp cannot advance.
  await round("R7 aliased move (B moves A's element)", { adds: 0, changes: [rect.id] }, () =>
    moveElementByEdge(browserB, rect.id, 150, 80),
  );

  // R8: pan-cursor stability — a panning user's broadcast cursor (scene coords) must
  // stay anchored to the grabbed scene point (Excalidraw's own emissions drift on stale
  // scroll and replay the pointerdown coords at release; manifold recomputes from the
  // physical pointer + committed camera). Asserts: pan really scrolled the viewport,
  // pan-window samples hold the grab point, no consecutive jump anywhere (teleport was
  // ~an entire pan delta), and a known post-pan move lands with the expected delta.
  {
    const name = "R8 pan cursor stays anchored, no release teleport";
    interface CursorSample {
      readonly x: number;
      readonly y: number;
      readonly connId: string;
    }
    const rawCursorLog: CursorSample[] = [];
    const offCursor = sdk.on("cursor", (msg) =>
      rawCursorLog.push({ x: msg.x, y: msg.y, connId: msg.connId }),
    );
    const mouse = (
      type: string,
      x: number,
      y: number,
      button?: string,
      buttons?: number,
    ): Promise<unknown> =>
      browserA.send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        ...(button === undefined ? {} : { button }),
        ...(buttons === undefined ? {} : { buttons }),
      });
    try {
      const scrollBefore = await browserA.evaluate<number>("window.__manifold.viewport().scrollX");
      // Approach: plain move to the grab spot.
      for (let i = 0; i <= 10; i++) {
        await mouse("mouseMoved", 400 + i * 10, 360);
        await sleep(15);
      }
      await sleep(200);
      const grabRawIndex = rawCursorLog.length;
      // Middle-drag pan: screen -160,-80.
      await mouse("mousePressed", 500, 360, "middle", 4);
      for (let i = 1; i <= 16; i++) {
        await mouse("mouseMoved", 500 - i * 10, 360 - i * 5, "middle", 4);
        await sleep(15);
      }
      await mouse("mouseReleased", 340, 280, "middle");
      await sleep(250);
      const panEndRawIndex = rawCursorLog.length;
      // Post-pan plain move: +100px screen X at zoom 1 => +100 scene X.
      for (let i = 0; i <= 10; i++) {
        await mouse("mouseMoved", 340 + i * 10, 280);
        await sleep(15);
      }
      await sleep(250);
      // Wheel-pan leg: no pointer motion at all — pre-fix, ZERO cursor frames are
      // emitted here (Excalidraw's wheel handler never calls savePointer), so the
      // remote cursor froze and jumped on the next move. Post-fix the onScrollChange
      // re-anchor emits frames that keep the cursor under the physical pointer.
      const wheelStartRawIndex = rawCursorLog.length;
      const vpBeforeWheel = await browserA.evaluate<{
        scrollX: number;
        scrollY: number;
        zoom: number;
      }>("window.__manifold.viewport()");
      for (let i = 0; i < 8; i++) {
        await browserA.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: 440,
          y: 280,
          deltaX: 0,
          deltaY: 40,
        });
        await sleep(60);
      }
      await sleep(300);
      const vpAfterWheel = await browserA.evaluate<{
        scrollX: number;
        scrollY: number;
        zoom: number;
      }>("window.__manifold.viewport()");

      const scrollAfter = await browserA.evaluate<number>("window.__manifold.viewport().scrollX");
      const failuresHere: string[] = [];
      // A's connection id: the approach phase is A's exclusive activity, so its samples
      // identify A even though both browsers share one principal. Require stability.
      const approach = rawCursorLog.slice(0, grabRawIndex);
      const tally = new Map<string, number>();
      for (const sample of approach) tally.set(sample.connId, (tally.get(sample.connId) ?? 0) + 1);
      const [aConn = "", dominantCount = 0] =
        [...tally.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
      if (aConn === "" || dominantCount < 5 || dominantCount < approach.length * 0.8) {
        failuresHere.push(
          `no stable A cursor stream before pan (${String(dominantCount)}/${String(approach.length)} samples for dominant connection)`,
        );
      }
      const countBefore = (rawIndex: number): number =>
        rawCursorLog.slice(0, rawIndex).filter((s) => s.connId === aConn).length;
      const cursorLog = rawCursorLog.filter((s) => s.connId === aConn);
      const grabIndex = countBefore(grabRawIndex);
      const panEndIndex = countBefore(panEndRawIndex);
      const grab = cursorLog[grabIndex - 1];
      if (Math.abs(scrollAfter - scrollBefore) < 100) {
        failuresHere.push(
          `pan did not scroll the viewport (dScrollX=${String(scrollAfter - scrollBefore)})`,
        );
      }
      if (grab === undefined || cursorLog.length - panEndIndex < 3) {
        failuresHere.push("insufficient cursor samples around the pan");
      } else {
        for (const sample of cursorLog.slice(grabIndex, panEndIndex)) {
          const deviation = Math.hypot(sample.x - grab.x, sample.y - grab.y);
          if (deviation > 40) {
            failuresHere.push(
              `pan-window sample drifted ${deviation.toFixed(0)}px off the grab point`,
            );
            break;
          }
        }
        for (let i = grabIndex; i < cursorLog.length; i++) {
          const prev = cursorLog[i - 1];
          const next = cursorLog[i];
          if (prev === undefined || next === undefined) continue;
          const jump = Math.hypot(next.x - prev.x, next.y - prev.y);
          if (jump > 60) {
            failuresHere.push(`cursor teleported ${jump.toFixed(0)}px between consecutive frames`);
            break;
          }
        }
        // Post-pan window ends where the wheel leg begins — separate windows so wheel
        // motion is never attributed to the post-pan move.
        const wheelStartIndex = countBefore(wheelStartRawIndex);
        const postPanLast = cursorLog[wheelStartIndex - 1];
        const preMove = cursorLog[panEndIndex - 1] ?? grab;
        if (postPanLast !== undefined && Math.abs(postPanLast.x - preMove.x - 100) > 30) {
          failuresHere.push(
            `post-pan move landed ${(postPanLast.x - preMove.x).toFixed(0)}px, expected ~100px`,
          );
        }
        // Wheel leg: camera must actually have moved, re-anchor frames must exist with
        // no pointer motion, and the cursor must track the MEASURED camera delta
        // (scene delta = -scroll delta at constant zoom).
        const dScrollY = vpAfterWheel.scrollY - vpBeforeWheel.scrollY;
        const wheelSamples = cursorLog.slice(wheelStartIndex);
        const wheelLast = wheelSamples[wheelSamples.length - 1];
        if (Math.abs(dScrollY) < 100 || Math.abs(vpAfterWheel.zoom - vpBeforeWheel.zoom) > 0.001) {
          failuresHere.push(
            `wheel leg did not scroll as expected (dScrollY=${dScrollY.toFixed(0)})`,
          );
        } else if (
          wheelSamples.length < 2 ||
          wheelLast === undefined ||
          postPanLast === undefined
        ) {
          failuresHere.push(
            `no cursor re-anchor frames during wheel pan (${String(wheelSamples.length)} samples) — frozen-cursor regression`,
          );
        } else if (Math.abs(wheelLast.y - postPanLast.y - -dScrollY) > 60) {
          failuresHere.push(
            `wheel-pan cursor did not track the camera: moved ${(wheelLast.y - postPanLast.y).toFixed(0)}px, camera implies ${(-dScrollY).toFixed(0)}px`,
          );
        }
      }
      if (failuresHere.length > 0) {
        failures.push(name);
        console.log(`FAIL  ${name}`);
        for (const line of failuresHere) console.log(`        ${line}`);
      } else {
        console.log(
          `PASS  ${name} — ${String(cursorLog.length - grabIndex)} samples, anchored within 40px`,
        );
      }
    } finally {
      offCursor();
    }
  }
} finally {
  // ---------------------------------------------------------------- teardown
  await browserA.close().catch(() => undefined);
  await browserB.close().catch(() => undefined);
  observer?.close();
  server.kill();
  rmSync(distDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.log(`\nFAILED rounds: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nall convergence rounds passed");
