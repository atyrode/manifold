/**
 * manifold multi-client convergence gate.
 *
 * The bug class this guards: the Excalidraw↔SDK projection layer losing or reverting
 * edits while every wire-level test stays green. It drives TWO real browsers through
 * real pointer gestures against a throwaway local server and asserts the strongest
 * invariant the system claims: after quiescence, five views are identical —
 *
 *   A.canvas ≡ A.sdkScene ≡ server canonical ≡ B.sdkScene ≡ B.canvas
 *
 * Requires the debug seam (localStorage "manifold:debug" = "1"; packages/web/src/debug-seam.ts).
 * Self-contained: builds the web bundle to a temp dir, spawns its own server, cleans up.
 *
 * Usage:  bun scripts/verify-convergence.ts            # or: bun run verify:convergence
 * Env:    MANIFOLD_CHROMIUM (else system chromium)
 *
 * Exit 0 only if every round converges.
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

const browserA = new Browser();
const browserB = new Browser();

async function openPad(browser: Browser, port9: number, name: string): Promise<void> {
  await browser.launch(port9);
  await browser.goto(`${origin}/#key=${ownerKey}`);
  await browser.evaluate("localStorage.setItem('manifold:debug', '1')");
  if (await browser.evaluate<boolean>("document.querySelector('input') !== null")) {
    await browser.typeInto("input", name);
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

await openPad(browserA, 9451, "convA");
await openPad(browserB, 9452, "convB");

const observer = new SessionClient({
  url: `${origin.replace(/^http/, "ws")}/ws/session`,
  padId,
  token: ownerKey,
  reconnect: false,
});
await observer.connect();

// ---------------------------------------------------------------- views & invariant

type VersionMap = Map<string, string>;

function toVersionMap(snapshots: readonly Snapshot[]): VersionMap {
  const map: VersionMap = new Map();
  for (const s of snapshots) map.set(s.id, `${String(s.version)}:${String(s.versionNonce)}`);
  return map;
}

function canonicalMap(): VersionMap {
  const map: VersionMap = new Map();
  for (const el of observer.scene.values()) {
    map.set(el.id, `${String(el.version)}:${String(el.versionNonce)}`);
  }
  return map;
}

async function view(browser: Browser, which: "canvas" | "scene"): Promise<VersionMap> {
  const snapshots = await browser.evaluate<readonly Snapshot[]>(`window.__manifold.${which}()`);
  return toVersionMap(snapshots);
}

function diffMaps(label: string, expected: VersionMap, actual: VersionMap): string[] {
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

function mapsEqual(a: VersionMap, b: VersionMap): boolean {
  if (a.size !== b.size) return false;
  for (const [id, stamp] of a) if (b.get(id) !== stamp) return false;
  return true;
}

const failures: string[] = [];

async function assertConverged(round: string): Promise<void> {
  let lastDiff: string[] = [];
  try {
    await until(
      async () => {
        const canonical = canonicalMap();
        const views: [string, VersionMap][] = [
          ["A.canvas", await view(browserA, "canvas")],
          ["A.scene", await view(browserA, "scene")],
          ["B.scene", await view(browserB, "scene")],
          ["B.canvas", await view(browserB, "canvas")],
        ];
        lastDiff = views.flatMap(([label, m]) =>
          mapsEqual(m, canonical) ? [] : diffMaps(label, canonical, m),
        );
        const pendingA = await browserA.evaluate<readonly string[]>("window.__manifold.pending()");
        const pendingB = await browserB.evaluate<readonly string[]>("window.__manifold.pending()");
        if (pendingA.length > 0) lastDiff.push(`A.pending: ${pendingA.join(",")}`);
        if (pendingB.length > 0) lastDiff.push(`B.pending: ${pendingB.join(",")}`);
        return lastDiff.length === 0;
      },
      12_000,
      "five-view convergence",
    );
    console.log(`PASS  ${round} — converged, ${String(canonicalMap().size)} elements canonical`);
  } catch {
    failures.push(round);
    console.log(`FAIL  ${round} — divergence after quiescence:`);
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

/** Screen-space center of an element as this browser currently projects it. */
async function centerOf(browser: Browser, elementId: string): Promise<{ x: number; y: number }> {
  const found = await browser.evaluate<{ snap: Snapshot; vp: Viewport } | null>(
    `(() => { const el = window.__manifold.canvas().find((e) => e.id === ${JSON.stringify(elementId)});
      const vp = window.__manifold.viewport();
      return el && vp ? { snap: el, vp } : null; })()`,
  );
  if (found === null) throw new Error(`element ${elementId} not on canvas`);
  const { snap, vp } = found;
  return {
    x: (snap.x + snap.width / 2 + vp.scrollX) * vp.zoom + vp.offsetLeft,
    y: (snap.y + snap.height / 2 + vp.scrollY) * vp.zoom + vp.offsetTop,
  };
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

async function moveElement(
  browser: Browser,
  elementId: string,
  dx: number,
  dy: number,
): Promise<void> {
  await selectTool(browser, "selection");
  const from = await centerOf(browser, elementId);
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

// R1: solo stroke.
await freedraw(browserA, 300, 250);
await assertConverged("R1 solo stroke");

// R2: concurrent strokes from both clients in distinct regions.
await Promise.all([freedraw(browserA, 300, 500), freedraw(browserB, 800, 250)]);
await assertConverged("R2 concurrent strokes");

// R3: A creates a rectangle, then concurrently A moves it while B draws.
await selectTool(browserA, "rectangle");
await browserA.drag(
  [
    { x: 900, y: 550 },
    { x: 1040, y: 640 },
  ],
  30,
);
await assertConverged("R3a rectangle created");
const rect = [...observer.scene.values()].find((el) => el["type"] === "rectangle");
if (rect === undefined) throw new Error("rectangle not in canonical scene");
await Promise.all([moveElement(browserA, rect.id, -180, -120), freedraw(browserB, 500, 650)]);
await assertConverged("R3b concurrent move and stroke");

// R4: B frozen (suspended tab) while A edits; B resumes and must converge.
await browserB.setLifecycle("frozen");
await freedraw(browserA, 1050, 300);
await moveElement(browserA, rect.id, 60, 90);
await sleep(1500);
await browserB.setLifecycle("active");
await assertConverged("R4 frozen tab resume");

// R5: cross moves — A and B move DIFFERENT elements concurrently.
const strokes = [...observer.scene.values()].filter((el) => el["type"] === "freedraw");
const strokeForB = strokes[0];
if (strokeForB === undefined) throw new Error("no freedraw stroke in canonical scene");
await Promise.all([
  moveElement(browserA, rect.id, -40, 100),
  moveElement(browserB, strokeForB.id, 120, -60),
]);
await assertConverged("R5 concurrent cross moves");

// R6: rapid-fire strokes back to back from A.
await freedraw(browserA, 250, 700);
await freedraw(browserA, 550, 720);
await freedraw(browserA, 850, 700);
await assertConverged("R6 rapid-fire strokes");

// R7: THE aliasing regression — B moves an element it received from A (painted from the
// canonical scene, i.e. the exact object-aliasing hazard). The move MUST take effect
// locally (asserted as a precondition, so the round cannot no-op) and then reach every
// other view. Pre-clone-fix this diverges: B's canvas AND B's SDK scene advance together
// in place, reconcile sees an idempotent duplicate, and nothing is ever sent.
{
  /** Reads the rectangle's geometry as B's LIVE canvas currently shows it. */
  const rectOnB = (): Promise<{ x: number; y: number } | null> =>
    browserB.evaluate<{ x: number; y: number } | null>(
      `(() => { const el = window.__manifold.canvas().find((e) => e.id === ${JSON.stringify(rect.id)});
        return el ? { x: el.x, y: el.y } : null; })()`,
    );
  const before = await rectOnB();
  if (before === null) throw new Error("rectangle never reached B's canvas");
  await moveElementByEdge(browserB, rect.id, 150, 80);
  await until(
    async () => {
      const now = await rectOnB();
      return now !== null && (now.x !== before.x || now.y !== before.y);
    },
    8_000,
    "B's local canvas actually moved the rectangle (gesture must not no-op)",
  );
  await assertConverged("R7 aliased move (B moves A's element)");
}

// ---------------------------------------------------------------- teardown

await browserA.close();
await browserB.close();
observer.close();
server.kill();
rmSync(distDir, { recursive: true, force: true });
rmSync(dataDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.log(`\nFAILED rounds: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nall convergence rounds passed");
