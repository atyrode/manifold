/**
 * manifold BUDGET gate — what an idle workspace is allowed to cost.
 *
 * Every other gate asks whether a boundary is clean. This one asks what the product SPENDS
 * when nobody is touching it, which is the failure mode no boundary check can see: a canvas
 * that renders correctly, denies correctly and addresses correctly can still peg a core and
 * hammer five doors a second, and nothing in the tree said "no" until an operator did.
 *
 * It exists because that is exactly what happened. Wave F shipped a canvas whose route
 * context was rebuilt every render, which re-ran the effect that publishes workspace state
 * back into the shell, which re-rendered the shell — a closed loop that ran at whatever rate
 * the main thread allowed (measured: ~600 React commits and 24s of script time per 30s of
 * "idle"), while the shell and the index section each opened their own timers onto the same
 * three doors (232 requests a minute from ONE tab looking at ONE canvas). Both were invisible
 * to a green gate.
 *
 * The budget is DECLARED, in REGISTRY.md's fenced `budgets` block, and read from there rather
 * than restated here — a threshold with two statements is a threshold that drifts, and the
 * numbers are the kind a human negotiates in a diff. RED names the resource and the rate.
 *
 * Shape: real server, real agent, real chromium, a real canvas holding a live terminal, notes
 * and strokes. Boot, settle, then watch. Self-contained; env: MANIFOLD_CHROMIUM.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionOutcomeSchema, type SceneElement } from "../packages/protocol/src/index.ts";
import { SessionClient } from "../packages/sdk/src/index.ts";
import { resolveWebDist } from "./gate-dist.ts";
import { Browser, sleep, until } from "./cdp.ts";

const repoRoot = join(import.meta.dir, "..");

/** One declared ceiling. `resource` is a poll key or an endpoint path; `perMin` is the cap. */
interface NetworkBudget {
  readonly resource: string;
  readonly perMin: number;
  readonly why: string;
}

/** The main-thread half of the same table: what an open canvas may spend doing nothing. */
interface IdleBudget {
  readonly commitsPerSec: number;
  readonly scriptMsPer30s: number;
  readonly longTasks: number;
  readonly longTaskMaxMs: number;
  readonly socketFramesPerMin: number;
  readonly why: string;
}

interface Budgets {
  readonly network: readonly NetworkBudget[];
  readonly idleCanvas: IdleBudget;
  readonly totalRequestsPerMin: number;
}

/**
 * Reads the ONE statement of the budget. A fenced `budgets` block in REGISTRY.md, found by
 * its key rather than by position, so the registry can be reordered without silently
 * disarming the gate — an absent block is RED, never an empty table that passes everything.
 */
function readBudgets(): Budgets {
  const registry = readFileSync(join(repoRoot, "REGISTRY.md"), "utf8");
  for (const match of registry.matchAll(/```json\n([\s\S]*?)\n```/g)) {
    const body = match[1];
    if (body === undefined || !body.includes('"budgets"')) continue;
    const parsed = JSON.parse(body) as { budgets: Budgets };
    return parsed.budgets;
  }
  throw new Error("REGISTRY.md carries no fenced `budgets` block");
}

const budgets = readBudgets();
const { distDir, cleanup: cleanupDist } = resolveWebDist("manifold-budget-");
const dataDir = mkdtempSync(join(tmpdir(), "manifold-budget-data-"));
const port = 45200 + Math.floor(Math.random() * 2000);
const origin = `http://127.0.0.1:${String(port)}`;
const ownerKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const server = Bun.spawn(["bun", "packages/server/src/main.ts"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    MANIFOLD_PORT: String(port),
    MANIFOLD_DATA_DIR: dataDir,
    MANIFOLD_WEB_DIST: distDir,
    MANIFOLD_OWNER_KEY: ownerKey,
    MANIFOLD_SPAWN_AGENT: "1",
  },
  stdout: "ignore",
  stderr: "inherit",
});

const failures: string[] = [];
let browser: Browser | null = null;
let seeder: SessionClient | null = null;

function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  if (!ok) failures.push(`${name}: ${detail}`);
}

async function ownerAction(name: string, args: unknown): Promise<unknown> {
  const response = await fetch(`${origin}/api/actions/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const outcome = ActionOutcomeSchema.parse(await response.json());
  if (!outcome.ok) throw new Error(`${name} refused: ${outcome.denial.message}`);
  return outcome.result;
}

/**
 * A canvas worth measuring: a LIVE terminal (the expensive occupant — an attached xterm and
 * a room socket), plus notes and strokes so the projection has real payloads to carry. An
 * empty canvas would pass a budget that a real one blows.
 */
async function seedCanvas(): Promise<string> {
  const created = (await ownerAction("core.index.createContainer", {
    name: "budget",
    discipline: "canvas",
  })) as { container: { id: string } };
  const containerId = created.container.id;

  const client = new SessionClient({
    url: `ws://127.0.0.1:${String(port)}/ws/session`,
    containerId,
    token: ownerKey,
  });
  seeder = client;
  await client.connect();
  const terminal = await client.openTerminal({ elementId: "budget-terminal", cols: 80, rows: 24 });
  await sleep(800);
  client.transact((tx) => {
    tx.create({
      id: "budget-terminal",
      type: "portal",
      containerId: terminal.containerId,
      x: 80,
      y: 80,
      width: 720,
      height: 480,
      zIndex: tx.nextZIndex(),
    } as SceneElement);
    for (let i = 0; i < 6; i += 1) {
      tx.create(
        {
          id: `budget-note-${String(i)}`,
          type: "text",
          x: 80 + (i % 3) * 300,
          y: 900 + Math.floor(i / 3) * 120,
          width: 240,
          height: 48,
          zIndex: tx.nextZIndex(),
          text: `note ${String(i)}`,
          color: "#f8f9fa",
          fontSize: 20,
        } as SceneElement,
        ["text"],
      );
      const points: number[] = [];
      for (let p = 0; p < 600; p += 1) points.push(1200 + i * 40 + Math.sin(p / 9) * 180, 200 + p);
      tx.create({
        id: `budget-draw-${String(i)}`,
        type: "draw",
        x: 1000 + i * 40,
        y: 200,
        width: 400,
        height: 640,
        zIndex: tx.nextZIndex(),
        points,
        color: "#8ce99a",
        strokeWidth: 3,
      } as SceneElement);
    }
  });
  await sleep(1000);
  client.close();
  seeder = null;
  return containerId;
}

/** One request as the network layer saw it, reduced to the resource it names. */
interface Observation {
  readonly resource: string;
  readonly bytes: number;
}

/**
 * Classifies a request the way the budget table names things: an action by its action name,
 * anything else by its path. Bundle and asset fetches are boot traffic, not idle traffic, and
 * the window starts after settling — but they are excluded by name too, so a late-loading
 * asset cannot be mistaken for a poller.
 */
function classify(url: string, body: string | null): string | null {
  const path = new URL(url).pathname;
  if (path.startsWith("/assets/") || path === "/" || path.endsWith(".ico")) return null;
  if (!path.startsWith("/api/")) return null;
  if (path.startsWith("/api/actions")) {
    const named = path.replace("/api/actions/", "");
    if (named !== "" && named !== "/api/actions") return named;
    try {
      return String((JSON.parse(body ?? "{}") as { name?: string }).name ?? "unknown-action");
    } catch {
      return "unknown-action";
    }
  }
  return path;
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
    30_000,
    "server health",
  );

  const containerId = await seedCanvas();

  browser = new Browser();
  await browser.launch(9366 + Math.floor(Math.random() * 200));

  /*
    Instrumentation is installed BEFORE any application script runs: React commits are counted
    through the devtools hook (React only reports them to a hook that existed at inject time),
    and long tasks through an observer that must predate the work it measures.
  */
  await browser.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const w = window;
      w.__budgetCommits = 0;
      w.__budgetLongTasks = [];
      if (!w.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
        w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
          renderers: new Map(),
          supportsFiber: true,
          inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id; },
          onCommitFiberRoot() { w.__budgetCommits += 1; },
          onCommitFiberUnmount() {},
          onPostCommitFiberRoot() {},
          checkDCE() {},
          isDisabled: false,
        };
      }
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) w.__budgetLongTasks.push(entry.duration);
        }).observe({ entryTypes: ['longtask'] });
      } catch {}
    })();`,
  });
  await browser.send("Network.enable", {});

  const observations: Observation[] = [];
  const pending = new Map<string, { url: string; body: string | null }>();
  let socketFrames = 0;
  let watching = false;
  browser.on("Network.requestWillBeSent", (params) => {
    const request = params["request"] as { url: string; postData?: string };
    pending.set(String(params["requestId"]), { url: request.url, body: request.postData ?? null });
  });
  browser.on("Network.loadingFinished", (params) => {
    const seen = pending.get(String(params["requestId"]));
    pending.delete(String(params["requestId"]));
    if (!watching || seen === undefined) return;
    const resource = classify(seen.url, seen.body);
    if (resource !== null) {
      observations.push({ resource, bytes: Number(params["encodedDataLength"] ?? 0) });
    }
  });
  const countFrame = (): void => {
    if (watching) socketFrames += 1;
  };
  browser.on("Network.webSocketFrameReceived", countFrame);
  browser.on("Network.webSocketFrameSent", countFrame);

  await browser.goto(`${origin}/#key=${ownerKey}`);
  await browser.typeInto('input[name="name"], input', "budget");
  await browser.clickTestId("identity-enter");
  await browser.goto(`${origin}/p/${encodeURIComponent(containerId)}`);
  const page = browser;
  await until(
    async () =>
      (await page.evaluate<number>(`document.querySelectorAll('.react-flow__node').length`)) >= 13,
    30_000,
    "canvas nodes painted",
  );
  // Settle: boot fetches, the first poll of every feed, and the terminal's attach and
  // snapshot all land here. What the budget governs is the STEADY state after that.
  await sleep(8_000);

  const WINDOW_MS = 60_000;
  await browser.evaluate(
    `(() => { window.__budgetCommits = 0; window.__budgetLongTasks.length = 0; return 1; })()`,
  );
  watching = true;
  const started = Date.now();
  await sleep(WINDOW_MS);
  watching = false;
  const elapsedMin = (Date.now() - started) / 60_000;

  const tally = new Map<string, number>();
  for (const observation of observations) {
    tally.set(observation.resource, (tally.get(observation.resource) ?? 0) + 1);
  }
  const rate = (resource: string): number => Math.round((tally.get(resource) ?? 0) / elapsedMin);

  console.log(`\nidle window: ${(elapsedMin * 60).toFixed(1)}s, one tab, one open canvas\n`);

  const declared = new Set(budgets.network.map((row) => row.resource));
  for (const row of budgets.network) {
    const measured = rate(row.resource);
    check(
      `budget ${row.resource}`,
      measured <= row.perMin,
      `${String(measured)}/min against a ceiling of ${String(row.perMin)}/min`,
    );
  }
  /*
    An UNDECLARED door polled at idle is RED on sight. That is the half that catches the next
    duplicate poller: a component that opens its own timer onto a resource nobody budgeted
    does not merely exceed a number, it escapes the table — and a table you can escape is not
    a budget.
  */
  for (const [resource, count] of tally) {
    if (declared.has(resource)) continue;
    check(
      `budget undeclared ${resource}`,
      false,
      `${String(Math.round(count / elapsedMin))}/min at idle with no row in REGISTRY.md \`budgets\``,
    );
  }

  const totalPerMin = Math.round(observations.length / elapsedMin);
  check(
    "budget total requests",
    totalPerMin <= budgets.totalRequestsPerMin,
    `${String(totalPerMin)}/min against a ceiling of ${String(budgets.totalRequestsPerMin)}/min`,
  );

  const commits = await browser.evaluate<number>(`window.__budgetCommits`);
  const longTasks = await browser.evaluate<number[]>(`window.__budgetLongTasks.slice()`);
  const commitsPerSec = commits / (elapsedMin * 60);
  const longTaskMax = longTasks.length === 0 ? 0 : Math.max(...longTasks);

  check(
    "budget idle re-renders",
    commitsPerSec <= budgets.idleCanvas.commitsPerSec,
    `${commitsPerSec.toFixed(2)} React commits/s against a ceiling of ${String(budgets.idleCanvas.commitsPerSec)}/s`,
  );
  check(
    "budget idle long tasks",
    longTasks.length <= budgets.idleCanvas.longTasks &&
      longTaskMax <= budgets.idleCanvas.longTaskMaxMs,
    `${String(longTasks.length)} long tasks, longest ${longTaskMax.toFixed(0)}ms, against ${String(budgets.idleCanvas.longTasks)} and ${String(budgets.idleCanvas.longTaskMaxMs)}ms`,
  );
  check(
    "budget idle socket frames",
    socketFrames / elapsedMin <= budgets.idleCanvas.socketFramesPerMin,
    `${String(Math.round(socketFrames / elapsedMin))} frames/min against a ceiling of ${String(budgets.idleCanvas.socketFramesPerMin)}/min`,
  );

  /*
    A backgrounded tab spends NOTHING. This is the one budget with a hard zero, because a
    workspace nobody is looking at has no reason to ask anything — and because "we poll" is a
    ratified interim only for as long as it stops when the operator looks away.
  */
  observations.length = 0;
  watching = true;
  await browser.setLifecycle("frozen");
  await sleep(10_000);
  watching = false;
  const hiddenRequests = observations.length;
  await browser.setLifecycle("active");
  check(
    "budget hidden tab",
    hiddenRequests === 0,
    `${String(hiddenRequests)} requests over 10s with the tab backgrounded (ceiling 0)`,
  );
} catch (reason) {
  failures.push(`gate error: ${reason instanceof Error ? reason.message : String(reason)}`);
  if (browser !== null) {
    for (const message of browser.drainMessages().slice(-20)) {
      console.log(`  page ${message.kind}/${message.level}: ${message.text}`);
    }
  }
} finally {
  (seeder as SessionClient | null)?.close();
  await browser?.close();
  server.kill();
  await server.exited;
  rmSync(dataDir, { recursive: true, force: true });
  cleanupDist();
}

console.log(
  failures.length === 0
    ? "\nverify:budgets GREEN"
    : `\nverify:budgets RED\n${failures.map((line) => ` - ${line}`).join("\n")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
