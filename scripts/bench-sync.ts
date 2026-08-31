/**
 * manifold sync smoothness benchmark (local-only; production is never touched).
 *
 * Question it answers: what does the ephemeral gesture cadence actually buy or cost?
 * For each candidate cadence it builds the web client with VITE_GESTURE_SEND_MS injected,
 * spawns a throwaway server, drives a continuous 6s terminal drag in browser A with real
 * pointer events, and measures:
 *
 * - remote effective Hz: distinct position updates/s observed on browser B's canvas
 *   (polled through the debug seam), i.e. what a collaborator's eye actually sees;
 * - inter-update gap p50/p95 on B (visual choppiness);
 * - wire cost: gesture frames/s and JSON payload bytes/s at an SDK observer;
 * - input→remote latency p50/p95: the drag sweeps x monotonically on a known schedule,
 *   so each observed x maps back to its dispatch time (includes ~1-3ms CDP overhead).
 *
 * NOT measured: render CPU on B (needs a tracing session; out of scope here).
 *
 * Usage:  bun scripts/bench-sync.ts [cadenceMs ...]     # default: 80 32 16
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionOutcomeSchema, PadResponseSchema } from "../packages/protocol/src/index.ts";
import { SessionClient } from "../packages/sdk/src/index.ts";
import { Browser, sleep, until } from "./cdp.ts";

const repoRoot = join(import.meta.dir, "..");
const cadences = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => Number.isFinite(n) && n > 0);
const candidates = cadences.length > 0 ? cadences : [80, 32, 16];

const DRAG_SECONDS = 6;
const STEP_MS = 8; // pointer cadence ≈ 125Hz, comfortably above every candidate flush rate

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

interface BenchResult {
  readonly cadenceMs: number;
  readonly remoteHz: number;
  readonly gapP50: number;
  readonly gapP95: number;
  readonly framesPerSec: number;
  readonly kBytesPerSec: number;
  readonly latencyP50: number;
  readonly latencyP95: number;
}

async function benchCadence(cadenceMs: number): Promise<BenchResult> {
  const distDir = mkdtempSync(join(tmpdir(), `manifold-bench-dist-${String(cadenceMs)}-`));
  const dataDir = mkdtempSync(join(tmpdir(), "manifold-bench-data-"));
  const port = 41000 + Math.floor(Math.random() * 2000);
  const origin = `http://127.0.0.1:${String(port)}`;
  const browserA = new Browser();
  const browserB = new Browser();
  let observer: SessionClient | null = null;
  let server: Bun.Subprocess | null = null;

  try {
    const build = Bun.spawnSync(["bunx", "vite", "build", "--outDir", distDir, "--emptyOutDir"], {
      cwd: join(repoRoot, "packages/web"),
      env: { ...process.env, VITE_GESTURE_SEND_MS: String(cadenceMs) },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (build.exitCode !== 0) throw new Error(`web build failed: ${build.stderr.toString()}`);

    server = Bun.spawn(["bun", "packages/server/src/main.ts"], {
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
      "bench server healthz",
    );
    const ownerKey = (await Bun.file(join(dataDir, "owner.key")).text()).trim();
    // `core.views.createPad` replaced `POST /api/pads`: the door answers an ActionOutcome,
    // so the created record arrives inside a validated envelope.
    const created = await fetch(`${origin}/api/actions/core.views.createPad`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
      body: JSON.stringify({ name: `bench-${String(cadenceMs)}ms` }),
    });
    const outcome = ActionOutcomeSchema.parse(await created.json());
    if (!outcome.ok) throw new Error(`createPad refused: ${outcome.denial.message}`);
    const padId = PadResponseSchema.parse(outcome.result).pad.id;

    const debugPort = 9700 + Math.floor(Math.random() * 200);
    for (const [browser, offset, name] of [
      [browserA, 0, "benchA"],
      [browserB, 250, "benchB"],
    ] as const) {
      await browser.launch(debugPort + offset);
      await browser.goto(`${origin}/#key=${ownerKey}`);
      await browser.evaluate("localStorage.setItem('manifold:debug', '1')");
      if (await browser.evaluate<boolean>("document.querySelector('input') !== null")) {
        await browser.typeInto("input", name);
        await browser.clickText("Enter manifold");
      }
      await browser.goto(`${origin}/p/${padId}`);
      await until(
        () => browser.evaluate<boolean>("window.__manifold !== undefined"),
        15_000,
        `${name} seam`,
      );
    }

    const sdk = new SessionClient({
      url: `${origin.replace(/^http/, "ws")}/ws/session`,
      padId,
      token: ownerKey,
      reconnect: false,
    });
    observer = sdk;
    await sdk.connect();

    // Seed one native reference node through the SDK, then drag it through the real
    // renderer. The bench measures gesture throughput, so the portal's target need not
    // resolve — only its geometry travels.
    const nodeId = "bench-terminal";
    sdk.transact((tx) => {
      tx.create({
        id: nodeId,
        type: "portal",
        containerId: "bench-container",
        x: 500,
        y: 400,
        width: 480,
        height: 320,
        zIndex: 0,
      });
    });
    await until(() => sdk.elements.has(nodeId), 10_000, "bench terminal canonical");
    const node = { id: nodeId };
    await until(
      () =>
        browserB.evaluate<boolean>(
          `window.__manifold.canvas().some((e) => e.id === ${JSON.stringify(node.id)})`,
        ),
      10_000,
      "terminal visible on B",
    );

    // Wire counters on the observer.
    let frames = 0;
    let bytes = 0;
    let counting = false;
    const probe = process.env["BENCH_PROBE"] === "1";
    sdk.on("gesture", (msg) => {
      if (!counting || msg.kind !== "move" || msg.phase !== "active") return;
      frames += 1;
      const payloadBytes = JSON.stringify(msg).length;
      bytes += payloadBytes;
      if (probe) {
        console.log(
          `probe t=${performance.now().toFixed(0)} by=${msg.connId.slice(0, 6)} bytes=${String(payloadBytes)}`,
        );
      }
    });

    // B polls its own canvas for the terminal node's live position.
    const samples: { t: number; x: number }[] = [];
    let polling = true;
    const pollLoop = (async () => {
      while (polling) {
        const x = await browserB.evaluate<number | null>(
          `(() => { const el = window.__manifold.canvas().find((e) => e.id === ${JSON.stringify(node.id)});
            return el ? el.x : null; })()`,
        );
        if (x !== null) samples.push({ t: performance.now(), x });
        await sleep(4);
      }
    })();
    // A drags through the terminal's real titlebar handle, exercising the gesture stream.
    const edge = await browserA.evaluate<{ x: number; y: number } | null>(
      `(() => {
        const node = document.querySelector(${JSON.stringify(
          `.react-flow__node[data-id="${node.id}"]`,
        )});
        const titlebar = node?.querySelector(".terminal-titlebar");
        if (!(titlebar instanceof HTMLElement)) return null;
        const rect = titlebar.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`,
    );
    if (edge === null) throw new Error("terminal titlebar drag handle not resolvable on A");
    const startXCanvas = await browserB.evaluate<number>(
      `window.__manifold.canvas().find((e) => e.id === ${JSON.stringify(node.id)}).x`,
    );

    const steps = Math.floor((DRAG_SECONDS * 1000) / STEP_MS);
    const pxPerStep = 700 / steps; // 700px sweep over the whole drag
    const dispatchTimes: number[] = []; // dispatchTimes[i] = when step i (offset i*pxPerStep) was sent
    await browserA.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: edge.x, y: edge.y });
    await browserA.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: edge.x,
      y: edge.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    counting = true;
    const dragStart = performance.now();
    for (let i = 1; i <= steps; i++) {
      await browserA.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: edge.x + i * pxPerStep,
        y: edge.y,
        button: "left",
        buttons: 1,
      });
      dispatchTimes.push(performance.now());
      const targetNext = dragStart + i * STEP_MS;
      const wait = targetNext - performance.now();
      if (wait > 0) await sleep(wait);
    }
    counting = false;
    const dragEnd = performance.now();
    const windowSeconds = (dragEnd - dragStart) / 1000;
    await browserA.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: edge.x + 700,
      y: edge.y,
      button: "left",
      clickCount: 1,
    });
    await sleep(400);
    polling = false;
    await pollLoop;

    // Distinct-position transitions on B during the drag window.
    const transitions: { t: number; x: number }[] = [];
    for (const sample of samples) {
      const last = transitions[transitions.length - 1];
      if (last === undefined || sample.x !== last.x) transitions.push(sample);
    }
    const inWindow = transitions.filter((tr) => tr.t >= dragStart && tr.t <= dragEnd + 200);
    const gaps = inWindow
      .slice(1)
      .map((tr, i) => tr.t - (inWindow[i]?.t ?? tr.t))
      .sort((a, b) => a - b);

    // Latency: observed canvas x → the drag step that produced it → its dispatch time.
    const latencies: number[] = [];
    for (const tr of inWindow) {
      const offset = tr.x - startXCanvas;
      const step = Math.round(offset / pxPerStep);
      const dispatched = dispatchTimes[step - 1];
      if (dispatched !== undefined && tr.t >= dispatched) latencies.push(tr.t - dispatched);
    }
    latencies.sort((a, b) => a - b);

    // Motion-only window (pointer-down through last move; release settles separately).
    if (windowSeconds <= 0) throw new Error("empty measurement window");
    console.log(
      `    window ${windowSeconds.toFixed(1)}s, effective pointer ${(steps / windowSeconds).toFixed(0)}Hz`,
    );
    return {
      cadenceMs,
      remoteHz: inWindow.length / windowSeconds,
      gapP50: percentile(gaps, 50),
      gapP95: percentile(gaps, 95),
      framesPerSec: frames / windowSeconds,
      kBytesPerSec: bytes / windowSeconds / 1024,
      latencyP50: percentile(latencies, 50),
      latencyP95: percentile(latencies, 95),
    };
  } finally {
    await browserA.close().catch(() => undefined);
    await browserB.close().catch(() => undefined);
    observer?.close();
    server?.kill();
    rmSync(distDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

console.log(
  `bench: ${String(DRAG_SECONDS)}s continuous drag, pointer at ${String(1000 / STEP_MS)}Hz`,
);
const results: BenchResult[] = [];
for (const cadence of candidates) {
  console.log(`\n--- cadence ${String(cadence)}ms`);
  results.push(await benchCadence(cadence));
}

console.log("\ncadence | remote Hz | gap p50/p95 ms | frames/s | KiB/s | latency p50/p95 ms");
for (const r of results) {
  console.log(
    `${String(r.cadenceMs).padStart(7)} | ${r.remoteHz.toFixed(1).padStart(9)} | ${r.gapP50.toFixed(0).padStart(6)}/${r.gapP95.toFixed(0).padEnd(7)} | ${r.framesPerSec.toFixed(1).padStart(8)} | ${r.kBytesPerSec.toFixed(1).padStart(5)} | ${r.latencyP50.toFixed(0)}/${r.latencyP95.toFixed(0)}`,
  );
}
