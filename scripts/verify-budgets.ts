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
 *
 * WAVE 2 (ADR 0012). The `network` ceilings are all ZERO now: the five feeds subscribe on the
 * session channel instead of running timers, so a steady workspace asks nothing. A table of
 * zeroes is the easiest table in the world to pass by breaking the feature, so the zero is not
 * measured alone — before the window this gate reads the feeds' own report seam and requires
 * each declared row to have a LIVE, subscription-backed feed with an initial read behind it and
 * no armed timer. A dead feed and a subscribed one are both silent on the network; only the feed
 * can tell them apart, so it is asked.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PolledFeedReport as FeedReport } from "../packages/plugin/src/polled-resource.ts";
import { ActionOutcomeSchema, type SceneElement } from "../packages/protocol/src/index.ts";
import { SessionClient } from "../packages/sdk/src/index.ts";
import { resolveWebDist } from "./gate-dist.ts";
import { Browser } from "./cdp.ts";
import { checkInto, reserveLoopbackPort, sleep, teardownServer, until } from "./gate-lib.ts";

const repoRoot = join(import.meta.dir, "..");

/**
 * One declared ceiling. `resource` is what the NETWORK layer sees — an action name or an
 * endpoint path — and `feed` is what the browser calls the same collection in the feed
 * vocabulary (`packages/plugin/src/polled-resource.ts`). The two spellings differ for exactly
 * one row (`/api/attendance` is fetched by the `attendance` feed), which is why the join is
 * declared in the registry rather than guessed from the string.
 */
interface NetworkBudget {
  readonly resource: string;
  readonly feed: string;
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
const port = reserveLoopbackPort();
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

const check = checkInto(failures);

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

  /*
    The canvas under measurement holds a LIVE terminal, and a terminal needs a machine. The
    spawned agent dials in a moment after the server answers `healthz`, so opening one straight
    after the health probe is a race the gate lost intermittently ("no unambiguous online
    machine") — the roster is the thing to wait on, not the port.
  */
  await until(
    async () => {
      const { machines } = (await ownerAction("core.machines.list", {})) as {
        machines: readonly { online: boolean }[];
      };
      return machines.some((machine) => machine.online);
    },
    30_000,
    "local agent online",
  );

  const containerId = await seedCanvas();

  browser = new Browser();
  await browser.launch();

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
  /*
    The feed report seam rides the same opt-in flag as the canvas probe. Set BEFORE the identity
    gate is crossed, so the flag is already in place when the shell mounts and the first feed is
    created — the seam is installed once, by whichever feed comes first.
  */
  await browser.evaluate("localStorage.setItem('manifold:debug', '1')");
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
  /*
    Settle: boot fetches, each feed's ONE initial read (plus its catch-up read if the socket
    reached open after the mount read), and the terminal's attach and snapshot all land here.
    What the budget governs is the STEADY state after that, which is now zero.
  */
  await sleep(8_000);

  /*
    THE ZERO'S POSITIVE CONTROL, taken before the window rather than after: a feed that died
    reads zero exactly like a feed that subscribed, so the table's collapse to zero is only
    meaningful if every declared row still has a live feed behind it. `mode: "events"` and a
    null interval are the same statement said twice on purpose — the first is the feed's own
    verdict, the second is the absence of the machinery that would make it false.
  */
  /*
    The seam's absence ANSWERS instead of throwing. A pre-swap bundle has no feed report at
    all, and a gate that aborts there reports one opaque timeout instead of the five rows and
    the five rates that say what actually regressed.
  */
  const seamDeadline = Date.now() + 20_000;
  let seam = false;
  while (!seam && Date.now() < seamDeadline) {
    seam = await page.evaluate<boolean>("window.__manifoldFeeds !== undefined");
    if (!seam) await sleep(250);
  }
  const feedReport = async (): Promise<readonly FeedReport[]> =>
    seam ? await page.evaluate<readonly FeedReport[]>("window.__manifoldFeeds()") : [];
  /*
    A feed's key is `<resource>|<restartKey>`, because a feed partitioned by route is a
    different feed (the attendance answer is per container). The budget names the RESOURCE, so
    the join is on the head of the key, and where a resource has several partitions the one
    with subscribers is the one under measurement.
  */
  const resourceOf = (key: string): string => key.split("|")[0] ?? key;
  const pick = (report: readonly FeedReport[], resource: string): FeedReport | undefined => {
    const partitions = report.filter((feed) => resourceOf(feed.key) === resource);
    return partitions.find((feed) => feed.subscribers > 0) ?? partitions[0];
  };
  const settled = await feedReport();
  const timersAtStart = new Map(settled.map((feed) => [feed.key, feed.reads.timer]));
  for (const row of budgets.network) {
    const feed = pick(settled, row.feed);
    const subscribed =
      feed !== undefined &&
      feed.mode === "events" &&
      feed.live &&
      feed.intervalMs === null &&
      feed.topics.length > 0 &&
      feed.reads.initial >= 1;
    check(
      `budget ${row.resource} is subscribed`,
      subscribed,
      feed === undefined
        ? seam
          ? `no live feed named "${row.feed}" on an open canvas — a zero row with no feed behind it is a corpse, not a budget`
          : "the page installs no feed report seam: this tree's feeds are not subscription-backed"
        : `mode ${feed.mode}, live ${String(feed.live)}, ${String(feed.subscribers)} subscriber(s), topics [${feed.topics.join(", ")}], interval ${String(feed.intervalMs)}, reads ${JSON.stringify(feed.reads)}`,
    );
  }

  await browser.send("Performance.enable", {});
  const scriptSeconds = async (): Promise<number> => {
    const frame = await page.send("Performance.getMetrics", {});
    const metrics = (frame.result?.["metrics"] ?? []) as readonly {
      name?: string;
      value?: number;
    }[];
    return metrics.find((metric) => metric.name === "ScriptDuration")?.value ?? 0;
  };
  const scriptAtStart = await scriptSeconds();

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
    THE WAVE'S CLAIM, stated by the feed rather than inferred from a rate: no timer RAN. Zero
    requests could also be a timer that fired and was answered from a cache; the feed counts
    its reads by reason, so a tick is visible even when it costs nothing on the wire. A timer
    beside a live subscription is RED at any rate the table would otherwise admit.
  */
  const afterWindow = await feedReport();
  const ticked: string[] = [];
  for (const row of budgets.network) {
    const feed = pick(afterWindow, row.feed);
    if (feed === undefined) {
      ticked.push(seam ? `${row.feed} vanished during the window` : `${row.feed} has no feed`);
      continue;
    }
    const before = timersAtStart.get(feed.key) ?? 0;
    if (feed.reads.timer !== before) {
      ticked.push(
        `${row.feed} timer reads ${String(before)} → ${String(feed.reads.timer)} (mode ${feed.mode}, interval ${String(feed.intervalMs)})`,
      );
    }
  }
  check(
    "budget no timer ticked",
    ticked.length === 0,
    ticked.length === 0
      ? `${String(budgets.network.length)} subscription-backed feeds, not one timer read in ${(elapsedMin * 60).toFixed(0)}s`
      : ticked.join(", "),
  );

  /*
    Script time, which the table has declared since it was written and nothing measured until
    now. `ScriptDuration` is cumulative seconds of JS execution as the browser accounts for it,
    so the window's spend is a difference — the one number that catches a busy loop cheap enough
    to miss every long-task threshold.
  */
  const scriptMsPer30s =
    ((await scriptSeconds()) - scriptAtStart) * 1000 * (30 / (elapsedMin * 60));
  check(
    "budget idle script time",
    scriptMsPer30s <= budgets.idleCanvas.scriptMsPer30s,
    `${scriptMsPer30s.toFixed(0)}ms of script per 30s against a ceiling of ${String(budgets.idleCanvas.scriptMsPer30s)}ms`,
  );

  /*
    A backgrounded tab spends NOTHING, and always did. The rule used to rest on polling being a
    ratified interim only for as long as it stopped when the operator looked away; with the
    cadence demoted to a reconnect-gap fallback it rests on the weaker and more durable thing —
    a tab nobody is looking at asks nothing. Last, deliberately: returning it to visible fires
    one catch-up read per feed, so every report above is taken before this leg touches the
    lifecycle.
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
  await teardownServer(server, dataDir);
  cleanupDist();
}

console.log(
  failures.length === 0
    ? "\nverify:budgets GREEN"
    : `\nverify:budgets RED\n${failures.map((line) => ` - ${line}`).join("\n")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
