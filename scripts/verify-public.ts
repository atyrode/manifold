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

/** Every run creates a pad on the PRODUCTION origin; never leave it behind. */
async function cleanupPad(): Promise<void> {
  if (padId === "") return;
  try {
    const res = await fetch(`${origin}/api/pads/${encodeURIComponent(padId)}`, {
      method: "DELETE",
      headers: httpHeaders,
    });
    if (!res.ok) console.log(`WARN  evt=verify_pad_cleanup_failed status=${res.status}`);
  } catch (error) {
    // A failed cleanup must not mask the gate verdict — but never hide it either.
    console.log(
      `WARN  evt=verify_pad_cleanup_failed ${error instanceof Error ? error.message : "error"}`,
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

function newViewer(padId: string): SessionClient {
  return new SessionClient({
    url: `${wsOrigin}/ws/session`,
    padId,
    token: ownerKey,
    reconnect: false,
  });
}

// ---------------------------------------------------------------- checks

let padId = "";
let sessionId = "";
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
    const res = await fetch(`${origin}/api/pads`);
    if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
    return "401 without credentials";
  });

  await step("owner creates a pad through public origin", async () => {
    const res = await fetch(`${origin}/api/pads`, {
      method: "POST",
      headers: httpHeaders,
      body: JSON.stringify({ name: `public-verify ${new Date().toISOString()}` }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    padId = ((await res.json()) as { pad: { id: string } }).pad.id;
    return `pad ${padId}`;
  });

  await step("real browser renders the canvas over the public origin", async () => {
    await browser.launch();
    // Fresh profile per run, and a real cross-document load so the app bootstraps the
    // #key fragment (a fragment-only change would be a same-document navigation).
    await browser.goto(`${origin}/#key=${ownerKey}`);
    // Enable the read-only debug seam so later steps can assert what the drawer's OWN
    // canvas holds — canonical-only assertions cannot see a canvas-side revert.
    await browser.evaluate("localStorage.setItem('manifold:debug', '1')");
    if (await browser.evaluate<boolean>("document.querySelector('input') !== null")) {
      await browser.typeInto("input", "verify");
      await browser.clickText("Enter manifold");
    }
    await browser.goto(`${origin}/p/${padId}`);
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
      "session open through public origin",
    );
    await until(
      () => browser.evaluate<boolean>("window.__manifold !== undefined"),
      10_000,
      "debug seam installed (manifold:debug flag)",
    );
    const path = await browser.evaluate<string>("location.pathname");
    if (path !== `/p/${padId}`) throw new Error(`expected /p/${padId}, on ${path}`);
    return `canvas mounted at ${path}, session open, seam active`;
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
    // Focus xterm's hidden textarea: that is where keystrokes actually land.
    await browser.evaluate(
      "(() => { const t = document.querySelector('.xterm-screen') ?? document.querySelector('.xterm'); t?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); t?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); document.querySelector('.xterm-helper-textarea')?.focus(); })()",
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
    const viewerA = newViewer(padId);
    const viewerB = newViewer(padId);
    await viewerA.connect();
    await viewerB.connect();
    const running = [...viewerA.sessions.values()].find((s) => s.status === "running");
    if (running === undefined) throw new Error("no running session visible over the public origin");
    sessionId = running.id;
    const seenA: string[] = [];
    const seenB: string[] = [];
    for (const [viewer, sink] of [
      [viewerA, seenA],
      [viewerB, seenB],
    ] as const) {
      viewer.on("terminal_output", (m) => sink.push(base64ToText(m.data)));
      viewer.on("terminal_snapshot", (m) => sink.push(base64ToText(m.data)));
    }
    viewerA.attachTerminal(sessionId);
    viewerB.attachTerminal(sessionId);
    await sleep(1500);
    viewerA.takeTerminal(sessionId);
    await sleep(600);
    viewerA.sendTerminalInput(sessionId, `printf '${marker}_TWOVIEW\\n'\n`);
    await until(() => seenA.join("").includes(`${marker}_TWOVIEW`), 20_000, "viewer A output");
    await until(() => seenB.join("").includes(`${marker}_TWOVIEW`), 20_000, "viewer B output");
    viewerA.close();
    viewerB.close();
    return "both public viewers observed the same bytes on one session";
  });

  await step("terminal session survives all viewers disconnecting", async () => {
    await sleep(2500);
    const rejoin = newViewer(padId);
    await rejoin.connect();
    const session = rejoin.sessions.get(sessionId);
    if (session === undefined || session.status !== "running") {
      throw new Error("session did not survive viewer disconnect");
    }
    const seen: string[] = [];
    rejoin.on("terminal_snapshot", (m) => seen.push(base64ToText(m.data)));
    rejoin.on("terminal_output", (m) => seen.push(base64ToText(m.data)));
    rejoin.attachTerminal(sessionId);
    await until(
      () => seen.join("").includes(`${marker}_TWOVIEW`),
      20_000,
      "prior output replayed after reattach",
    );
    rejoin.close();
    return "session alive and replayed prior output after all viewers left";
  });

  await step("scene persists across a public-origin reconnect", async () => {
    const client = newViewer(padId);
    await client.connect();
    const before = client.scene.size;
    client.updateScene([
      {
        id: `verify-${marker}`,
        type: "terminal",
        sessionId: `verify-session-${marker}`,
        x: 40,
        y: 40,
        width: 120,
        height: 80,
        zIndex: 0,
        version: 1,
        versionNonce: 11,
        isDeleted: false,
      },
    ]);
    await until(() => client.rev > 0, 10_000, "scene accepted");
    client.close();
    await sleep(2500);
    const after = newViewer(padId);
    await after.connect();
    const present = after.scene.has(`verify-${marker}`);
    const size = after.scene.size;
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
  // Structural guarantee: once the pad exists, no exit path may leave it behind
  // on the production origin — cleanup runs on success, failure, and throw alike.
  await browser.close().catch(() => console.log("WARN  evt=verify_browser_close_failed"));
  await cleanupPad();
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed against ${origin}`,
);
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
