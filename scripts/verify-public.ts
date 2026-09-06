/**
 * manifold public-origin verification gate.
 *
 * Localhost success proves nothing about a public deployment: TLS, the CDN/proxy hop,
 * WebSocket upgrades through that hop, and origin behaviour are only exercised from
 * outside. This script drives the PUBLIC workspace with target-origin credentials —
 * a real browser (system chromium over CDP, no extra dependency), real public WebSockets,
 * real PTYs. It does not exercise production-to-preview sign-in or transient auth documents.
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
  CredentialsResponseSchema,
  RevokeResultSchema,
  TerminalsResponseSchema,
  type PrincipalCredentials,
  type TerminalSummary,
} from "../packages/protocol/src/index.ts";
import { SessionClient, base64ToText } from "../packages/sdk/src/index.ts";
import { Browser } from "./cdp.ts";
import { ownerKeyOf, sleep, until } from "./gate-lib.ts";

const originInput = process.argv[2] ?? process.env["MANIFOLD_ORIGIN"] ?? "";
if (originInput === "") {
  throw new Error("pass the public origin as argv or MANIFOLD_ORIGIN; there is no default");
}
const origin = originInput.replace(/\/$/, "");
const wsOrigin = origin.replace(/^http/, "ws");
// Optional: another vhost on the same host/proxy that a manifold deploy must
// not take down. Deployment-specific, so never defaulted.
const peerOrigin = process.env["MANIFOLD_PEER_ORIGIN"] ?? "";
const ownerKey = process.env["MANIFOLD_OWNER_KEY"] ?? (await ownerKeyOf("data"));
if (!/^[0-9a-f]{64}$/.test(ownerKey)) throw new Error("owner key missing or malformed");

const httpHeaders = { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" };
const marker = `PUBLIC_${Date.now().toString(36).toUpperCase()}`;
const results: { name: string; ok: boolean; detail: string }[] = [];

/**
 * The name the browser step enters at the identity gate. It walks the HUMAN gate on purpose —
 * that flow is one of the things this gate proves — so the principal it mints is `kind: human`
 * with a 14-day credential, and the deal for keeping it human is that this run revokes it
 * before exiting (issue #140; the rule is in docs/CONTRACTS.md §Identity).
 */
const VERIFY_NAME = "verify";
const TEARDOWN_STEP = "verify principal revoked on teardown";

/** One dispatch through the action door as the owner: the result, or the denial as an error. */
async function act(name: string, args: unknown): Promise<unknown> {
  const res = await fetch(`${origin}/api/actions/${name}`, {
    method: "POST",
    headers: httpHeaders,
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${name} failed: ${res.status}`);
  const outcome = ActionOutcomeSchema.parse(await res.json());
  if (!outcome.ok) throw new Error(`${name} refused: ${outcome.denial.message}`);
  return outcome.result;
}

/**
 * THE terminal index, through its door (`core.terminals.listAll`). The public gate reads it to
 * find the composition a terminal lives in, because a canvas portal only ever names the home.
 */
async function listTerminals(): Promise<readonly TerminalSummary[]> {
  return TerminalsResponseSchema.parse(await act("core.terminals.listAll", {})).terminals;
}

/** Every principal and its live credentials, through `core.access.listCredentials`. */
async function listCredentials(): Promise<readonly PrincipalCredentials[]> {
  return CredentialsResponseSchema.parse(await act("core.access.listCredentials", {})).principals;
}

/**
 * The identity the browser step minted by walking the human gate, once it has — read off the
 * grant the browser stored, which is exact. `gateSubmitted` is the weaker fact that survives a
 * browser dying between the click and that read: a principal may exist that this run never
 * learned the id of, and the census taken before the click is what lets teardown name it.
 */
let verifyPrincipalId = "";
let gateSubmitted = false;
let verifyPrincipalsBefore: ReadonlySet<string> = new Set();

/**
 * Revokes the principal this run minted on the PRODUCTION origin, and proves it: after the door
 * answers, the credential list must show no live session for it. Runs as a recorded step so a
 * run that could not clean up after itself is a red run, not a green one with sediment.
 */
async function revokeVerifyPrincipal(): Promise<string> {
  if (!gateSubmitted) return "gate not walked, no principal minted";
  const ids =
    verifyPrincipalId !== ""
      ? [verifyPrincipalId]
      : (await listCredentials())
          .filter(
            (row) =>
              row.principal.name === VERIFY_NAME && !verifyPrincipalsBefore.has(row.principal.id),
          )
          .map((row) => row.principal.id);
  if (ids.length === 0)
    return "gate submitted, no new 'verify' principal found — nothing to revoke";
  let revoked = 0;
  for (const principalId of ids) {
    revoked += RevokeResultSchema.parse(await act("core.access.revoke", { principalId })).revoked;
  }
  const live = (await listCredentials()).filter(
    (row) => ids.includes(row.principal.id) && row.sessions.length > 0,
  );
  if (live.length > 0) {
    throw new Error(
      `${String(live.length)} '${VERIFY_NAME}' principal(s) still hold live credentials`,
    );
  }
  return `${String(revoked)} credential(s) revoked for principal ${ids.join(", ")}`;
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

console.log(
  "SCOPE authentication: target-origin owner-key entry and local human first-visit gate; " +
    "production-to-preview sign-in and transient authentication documents are NOT exercised.",
);

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
    const created = await act("core.index.createContainer", {
      name: `public-verify ${new Date().toISOString()}`,
    });
    containerId = ContainerResponseSchema.parse(created).container.id;
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
      // The census BEFORE the click is what lets teardown name this run's principal even if
      // the browser dies before the stored grant can be read.
      verifyPrincipalsBefore = new Set(
        (await listCredentials())
          .filter((row) => row.principal.name === VERIFY_NAME)
          .map((row) => row.principal.id),
      );
      await browser.typeInto("input", VERIFY_NAME);
      gateSubmitted = true;
      await browser.clickTestId("identity-enter");
      await until(
        () => browser.evaluate<boolean>("localStorage.getItem('manifold.identity') !== null"),
        10_000,
        "identity grant stored",
      );
      // Only the id: the stored grant carries this device's TOKEN and must never leave the page.
      verifyPrincipalId = await browser.evaluate<string>(
        "JSON.parse(localStorage.getItem('manifold.identity')).principal.id",
      );
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
      "document.querySelector('[data-testid=machines-section] button[aria-expanded]').click()",
    );
    await until(
      () =>
        browser.evaluate<boolean>(
          "document.querySelector('[aria-label^=\"New terminal on \"]') !== null",
        ),
      30_000,
      "online machine terminal action",
    );
    // The census BEFORE the click names the terminal this run spawns, by difference. A real
    // workspace's first running row is routinely a stale one — a machine whose agent never
    // dialed back, so the hub cannot know its PTYs died — and aiming the viewer steps at it
    // times them out on data the browser step just passed on.
    const before = new Set((await listTerminals()).map((terminal) => terminal.id));
    await browser.evaluate("document.querySelector('[aria-label^=\"New terminal on \"]').click()");
    await until(
      () => browser.evaluate<boolean>("document.querySelector('.xterm') !== null"),
      30_000,
      "xterm mount",
    );
    const spawned = (await listTerminals())
      .filter((terminal) => terminal.status === "running" && !before.has(terminal.id))
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (spawned === undefined) throw new Error("the terminal the browser opened is not listed");
    terminalId = spawned.id;
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
    return `terminal ${terminalId} rendered command output in a real browser`;
  });

  await step("two simultaneous public WebSocket viewers share one terminal", async () => {
    // Terminals live in their HOME composition, never in a canvas: find the home over
    // HTTP, then both viewers hold a channel on it — the same thing the portal does.
    const running = (await listTerminals()).find((terminal) => terminal.id === terminalId);
    if (running === undefined || running.status !== "running") {
      throw new Error("the terminal the browser opened is not running over the public origin");
    }
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
  // Structural guarantee: once the container exists, no exit path may leave it behind on
  // the production origin, and neither may the principal the gate minted — both run on
  // success, failure, and throw alike. The browser goes first so the grant it holds is
  // never in use when its token dies.
  await browser.close().catch(() => console.log("WARN  evt=verify_browser_close_failed"));
  await cleanupContainer();
  await step(TEARDOWN_STEP, revokeVerifyPrincipal);
}

const failed = results.filter((r) => !r.ok);
const teardown = results.find((r) => r.name === TEARDOWN_STEP);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed against ${origin}` +
    `\nprincipal teardown: ${teardown === undefined ? "did not run" : `${teardown.ok ? "ok" : "FAILED"} — ${teardown.detail}`}`,
);
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
