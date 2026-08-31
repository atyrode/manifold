/**
 * manifold public-origin verification gate.
 *
 * Localhost success proves nothing about a public deployment: TLS, the CDN/proxy hop,
 * WebSocket upgrades through that hop, and origin behaviour are only exercised from
 * outside. This script drives the PUBLIC origin end to end — a real browser (system
 * chromium over CDP, no extra dependency), real public WebSockets, real PTYs.
 *
 * Usage:  bun scripts/verify-public.ts <origin>    # or MANIFOLD_ORIGIN
 * Env:    MANIFOLD_ORIGIN (when no argv origin), MANIFOLD_OWNER_KEY (else ./data/owner.key),
 *         MANIFOLD_CHROMIUM, MANIFOLD_PEER_ORIGIN (optional co-hosted origin that must
 *         keep working; the step is skipped when unset)
 *
 * Exit 0 only if every check passes.
 */
import {
  ActionOutcomeSchema,
  ContainerResponseSchema,
  TerminalsResponseSchema,
  type TerminalSummary,
} from "../packages/protocol/src/index.ts";
import { SessionClient, base64ToText } from "../packages/sdk/src/index.ts";
import { Browser, sleep, until } from "./cdp.ts";

const originInput = process.argv[2] ?? process.env["MANIFOLD_ORIGIN"] ?? "";
if (originInput === "") {
  throw new Error("pass the public origin as argv or MANIFOLD_ORIGIN; there is no default");
}
const origin = originInput.replace(/\/$/, "");
const wsOrigin = origin.replace(/^http/, "ws");
// Optional: another vhost on the same host/proxy that a manifold deploy must
// not take down. Deployment-specific, so never defaulted.
const peerOrigin = process.env["MANIFOLD_PEER_ORIGIN"] ?? "";
const ownerKey =
  process.env["MANIFOLD_OWNER_KEY"] ?? (await Bun.file("data/owner.key").text()).trim();
if (!/^[0-9a-f]{64}$/.test(ownerKey)) throw new Error("owner key missing or malformed");

const httpHeaders = { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" };
const marker = `PUBLIC_${Date.now().toString(36).toUpperCase()}`;
const results: { name: string; ok: boolean; detail: string }[] = [];

/**
 * THE terminal index, through its door (`core.terminals.listAll`). The public gate reads it to
 * find the composition a terminal lives in, because a canvas portal only ever names the home.
 */
async function listTerminals(): Promise<readonly TerminalSummary[]> {
  const res = await fetch(`${origin}/api/actions/core.terminals.listAll`, {
    method: "POST",
    headers: httpHeaders,
    body: "{}",
  });
  if (!res.ok) throw new Error(`terminal listing failed: ${res.status}`);
  const outcome = ActionOutcomeSchema.parse(await res.json());
  if (!outcome.ok) throw new Error(`terminal index refused: ${outcome.denial.message}`);
  return TerminalsResponseSchema.parse(outcome.result).terminals;
}

/** Every run creates a container on the PRODUCTION origin; never leave it behind. */
async function cleanupContainer(): Promise<void> {
  if (containerId === "") return;
  try {
    const res = await fetch(`${origin}/api/actions/core.index.deleteContainer`, {
      method: "POST",
      headers: httpHeaders,
      body: JSON.stringify({ containerId }),
    });
    if (!res.ok) console.log(`WARN  evt=verify_container_cleanup_failed status=${res.status}`);
  } catch (error) {
    // A failed cleanup must not mask the gate verdict — but never hide it either.
    console.log(
      `WARN  evt=verify_container_cleanup_failed ${error instanceof Error ? error.message : "error"}`,
    );
  }
}

async function step(name: string, run: () => Promise<string>): Promise<void> {
  try {
    const detail = await run();
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name}${detail === "" ? "" : ` — ${detail}`}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    console.log(`FAIL  ${name} — ${detail}`);
  }
}

// (sleep/until/Browser live in scripts/cdp.ts, shared with verify-convergence.ts)

function newViewer(containerId: string): SessionClient {
  return new SessionClient({
    url: `${wsOrigin}/ws/session`,
    containerId,
    token: ownerKey,
    reconnect: false,
  });
}

// ---------------------------------------------------------------- checks

let containerId = "";
let terminalId = "";
// Constructed eagerly (cheap; launch() happens inside its step) so the outer
// finally can always close it — close() is a no-op before launch.
const browser = new Browser();

try {
  await step("public origin serves healthz over TLS", async () => {
    const res = await fetch(`${origin}/healthz`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = (await res.json()) as { ok?: boolean; protocolVersion?: number };
    if (body.ok !== true) throw new Error("unexpected body");
    return `protocolVersion=${String(body.protocolVersion)}`;
  });

  await step("anonymous access denied through public origin", async () => {
    const res = await fetch(`${origin}/api/containers`);
    if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
    return "401 without credentials";
  });

  await step("owner creates a container through public origin", async () => {
    const res = await fetch(`${origin}/api/actions/core.index.createContainer`, {
      method: "POST",
      headers: httpHeaders,
      body: JSON.stringify({ name: `public-verify ${new Date().toISOString()}` }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const outcome = ActionOutcomeSchema.parse(await res.json());
    if (!outcome.ok) throw new Error(`createContainer refused: ${outcome.denial.message}`);
    containerId = ContainerResponseSchema.parse(outcome.result).container.id;
    return `container ${containerId}`;
  });

  await step("real browser renders the canvas over the public origin", async () => {
    await browser.launch();
    // Fresh profile per run, and a real cross-document load so the app bootstraps the
    // #key fragment (a fragment-only change would be a same-document navigation).
    await browser.goto(`${origin}/#key=${ownerKey}`);
    // Enable the read-only debug probe so later steps can assert what the drawer's OWN
    // canvas holds — canonical-only assertions cannot see a canvas-side revert.
    await browser.evaluate("localStorage.setItem('manifold:debug', '1')");
    if (await browser.evaluate<boolean>("document.querySelector('input') !== null")) {
      await browser.typeInto("input", "verify");
      await browser.clickText("Enter manifold");
    }
    await browser.goto(`${origin}/p/${containerId}`);
    await until(
      () => browser.evaluate<boolean>("document.querySelector('.react-flow') !== null"),
      20_000,
      "React Flow mount",
    );
    await until(
      () =>
        browser.evaluate<boolean>(
          "(document.querySelector('[data-testid=connection-state]')?.textContent ?? '').toLowerCase() === 'open'",
        ),
      20_000,
      "terminal open through public origin",
    );
    await until(
      () => browser.evaluate<boolean>("window.__manifold !== undefined"),
      10_000,
      "debug probe installed (manifold:debug flag)",
    );
    const path = await browser.evaluate<string>("location.pathname");
    if (path !== `/p/${containerId}`) throw new Error(`expected /p/${containerId}, on ${path}`);
    return `canvas mounted at ${path}, terminal open, probe active`;
  });

  await step("embedded terminal opens and runs a command in the browser", async () => {
    await browser.evaluate(
      "document.querySelector('[data-testid=machines-section] > summary').click()",
    );
    await until(
      () =>
        browser.evaluate<boolean>(
          "document.querySelector('[aria-label^=\"New terminal on \"]') !== null",
        ),
      30_000,
      "online machine terminal action",
    );
    await browser.evaluate("document.querySelector('[aria-label^=\"New terminal on \"]').click()");
    await until(
      () => browser.evaluate<boolean>("document.querySelector('.xterm') !== null"),
      30_000,
      "xterm mount",
    );
    // Focus = engage: a real user's click both focuses xterm and escalates the mono
    // portal to an occupant channel on the terminal's home composition. Synthetic
    // pointer events alone never produce a click, so dispatch one explicitly.
    await browser.evaluate(
      "(() => { const t = document.querySelector('.xterm-screen') ?? document.querySelector('.xterm'); for (const type of ['pointerdown', 'pointerup', 'click']) t?.dispatchEvent(new (type === 'click' ? MouseEvent : PointerEvent)(type, { bubbles: true })); document.querySelector('.xterm-helper-textarea')?.focus(); })()",
    );
    await sleep(400);
    await browser.typeText(`printf '${marker}_BROWSER\\n'\n`);
    await until(
      () =>
        browser.evaluate<boolean>(
          `(document.querySelector('.xterm-rows')?.innerText ?? '').includes('${marker}_BROWSER')`,
        ),
      25_000,
      "terminal output rendered in xterm",
    );
    return "terminal rendered command output in a real browser";
  });

  await step("two simultaneous public WebSocket viewers share one terminal", async () => {
    // Terminals live in their HOME composition, never in a canvas: find the home over
    // HTTP, then both viewers hold a channel on it — the same thing the portal does.
    const listed = await listTerminals();
    const running = listed.find((terminal) => terminal.status === "running");
    if (running === undefined)
      throw new Error("no running terminal visible over the public origin");
    terminalId = running.id;
    const viewerA = newViewer(running.homeId);
    const viewerB = newViewer(running.homeId);
    await viewerA.connect();
    await viewerB.connect();
    const seenA: string[] = [];
    const seenB: string[] = [];
    for (const [viewer, sink] of [
      [viewerA, seenA],
      [viewerB, seenB],
    ] as const) {
      viewer.on("terminal_output", (m) => sink.push(base64ToText(m.data)));
      viewer.on("terminal_snapshot", (m) => sink.push(base64ToText(m.data)));
    }
    viewerA.attachTerminal(terminalId);
    viewerB.attachTerminal(terminalId);
    await sleep(1500);
    viewerA.takeTerminal(terminalId);
    await sleep(600);
    viewerA.sendTerminalInput(terminalId, `printf '${marker}_TWOVIEW\\n'\n`);
    await until(() => seenA.join("").includes(`${marker}_TWOVIEW`), 20_000, "viewer A output");
    await until(() => seenB.join("").includes(`${marker}_TWOVIEW`), 20_000, "viewer B output");
    viewerA.close();
    viewerB.close();
    return "both public viewers observed the same bytes on one terminal";
  });

  await step("terminal survives all viewers disconnecting", async () => {
    await sleep(2500);
    const survivor = (await listTerminals()).find((terminal) => terminal.id === terminalId);
    if (survivor === undefined || survivor.status !== "running") {
      throw new Error("terminal did not survive viewer disconnect");
    }
    const rejoin = newViewer(survivor.homeId);
    await rejoin.connect();
    const terminal = rejoin.terminals.get(terminalId);
    if (terminal === undefined || terminal.status !== "running") {
      throw new Error("terminal did not survive viewer disconnect");
    }
    const seen: string[] = [];
    rejoin.on("terminal_snapshot", (m) => seen.push(base64ToText(m.data)));
    rejoin.on("terminal_output", (m) => seen.push(base64ToText(m.data)));
    rejoin.attachTerminal(terminalId);
    await until(
      () => seen.join("").includes(`${marker}_TWOVIEW`),
      20_000,
      "prior output replayed after reattach",
    );
    rejoin.close();
    return "terminal alive and replayed prior output after all viewers left";
  });

  await step("scene persists across a public-origin reconnect", async () => {
    const client = newViewer(containerId);
    await client.connect();
    const before = client.elements.size;
    client.transact((tx) => {
      tx.create({
        id: `verify-${marker}`,
        type: "portal",
        containerId: `verify-container-${marker}`,
        x: 40,
        y: 40,
        width: 120,
        height: 80,
        zIndex: 0,
      });
    });
    await until(() => client.elements.has(`verify-${marker}`), 10_000, "scene accepted");
    client.close();
    await sleep(2500);
    const after = newViewer(containerId);
    await after.connect();
    const present = after.elements.has(`verify-${marker}`);
    const size = after.elements.size;
    after.close();
    if (!present) throw new Error("element missing after reconnect");
    return `scene ${before} -> ${size}, element persisted`;
  });

  if (peerOrigin !== "") {
    await step("co-hosted origin still serves (no collateral damage)", async () => {
      const res = await fetch(peerOrigin, { redirect: "manual" });
      if (res.status >= 500) throw new Error(`${peerOrigin} returned ${res.status}`);
      return `${peerOrigin} -> ${res.status}`;
    });
  }
} finally {
  // Structural guarantee: once the container exists, no exit path may leave it behind
  // on the production origin — cleanup runs on success, failure, and throw alike.
  await browser.close().catch(() => console.log("WARN  evt=verify_browser_close_failed"));
  await cleanupContainer();
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed against ${origin}`,
);
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
