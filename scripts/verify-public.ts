/**
 * manifold public-origin verification gate.
 *
 * Localhost success proves nothing about a public deployment: TLS, the CDN/proxy hop,
 * WebSocket upgrades through that hop, and origin behaviour are only exercised from
 * outside. This script drives the PUBLIC origin end to end — a real browser (system
 * chromium over CDP, no extra dependency), real public WebSockets, real PTYs.
 *
 * Usage:  bun scripts/verify-public.ts [origin]     # default https://manifold.tyrode.dev
 * Env:    MANIFOLD_OWNER_KEY (else ./data/owner.key), MANIFOLD_CHROMIUM,
 *         MANIFOLD_PEER_ORIGIN (co-hosted origin that must keep working)
 *
 * Exit 0 only if every check passes.
 */
import { SessionClient, base64ToText } from "../packages/sdk/src/index.ts";

const origin = (process.argv[2] ?? "https://manifold.tyrode.dev").replace(/\/$/, "");
const wsOrigin = origin.replace(/^http/, "ws");
const peerOrigin = process.env["MANIFOLD_PEER_ORIGIN"] ?? "https://pad.ws";
const ownerKey =
  process.env["MANIFOLD_OWNER_KEY"] ?? (await Bun.file("data/owner.key").text()).trim();
if (!/^[0-9a-f]{64}$/.test(ownerKey)) throw new Error("owner key missing or malformed");

const httpHeaders = { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" };
const marker = `PUBLIC_${Date.now().toString(36).toUpperCase()}`;
const results: { name: string; ok: boolean; detail: string }[] = [];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

/** Polls an async predicate until it returns true, or throws after timeoutMs. */
async function until(probe: () => Promise<boolean> | boolean, ms: number, what: string) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

// ---------------------------------------------------------------- minimal CDP browser

interface CdpFrame {
  id?: number;
  result?: Record<string, unknown>;
}

/** Just enough Chrome DevTools Protocol to navigate, evaluate, click and type. */
class Browser {
  private socket: WebSocket | null = null;
  private proc: Bun.Subprocess | null = null;
  private nextId = 1;
  private sessionId = "";
  private readonly pending = new Map<number, (frame: CdpFrame) => void>();

  static detect(): string {
    const explicit = process.env["MANIFOLD_CHROMIUM"];
    if (explicit !== undefined && explicit !== "") return explicit;
    for (const candidate of ["chromium", "chromium-browser", "google-chrome", "chrome"]) {
      const found = Bun.which(candidate);
      if (found !== null) return found;
    }
    throw new Error("no chromium binary found (set MANIFOLD_CHROMIUM)");
  }

  async launch(port = 9333): Promise<void> {
    this.proc = Bun.spawn(
      [
        Browser.detect(),
        "--headless=new",
        `--remote-debugging-port=${String(port)}`,
        `--user-data-dir=/tmp/manifold-verify-${String(Date.now())}`,
        "--no-first-run",
        "--no-sandbox",
        "--disable-gpu",
        "--window-size=1440,900",
        "about:blank",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );

    let endpoint = "";
    await until(
      async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${String(port)}/json/version`);
          const body = (await res.json()) as { webSocketDebuggerUrl?: string };
          endpoint = body.webSocketDebuggerUrl ?? "";
          return endpoint !== "";
        } catch {
          return false;
        }
      },
      20_000,
      "chromium devtools endpoint",
    );

    const socket = new WebSocket(endpoint);
    this.socket = socket;
    const opened = Promise.withResolvers<void>();
    socket.onopen = () => opened.resolve();
    socket.onerror = () => opened.reject(new Error("cdp socket failed"));
    await opened.promise;
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      const frame = JSON.parse(event.data) as CdpFrame;
      if (frame.id === undefined) return;
      this.pending.get(frame.id)?.(frame);
      this.pending.delete(frame.id);
    };

    const target = await this.send("Target.createTarget", { url: "about:blank" }, false);
    const targetId = String(target.result?.["targetId"]);
    const attached = await this.send("Target.attachToTarget", { targetId, flatten: true }, false);
    this.sessionId = String(attached.result?.["sessionId"]);
    await this.send("Page.enable", {});
    await this.send("Runtime.enable", {});
  }

  async send(
    method: string,
    params: Record<string, unknown>,
    withSession = true,
  ): Promise<CdpFrame> {
    const socket = this.socket;
    if (socket === null) throw new Error("browser not launched");
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<CdpFrame>();
    this.pending.set(id, resolve);
    const frame: Record<string, unknown> = { id, method, params };
    if (withSession && this.sessionId !== "") frame["sessionId"] = this.sessionId;
    socket.send(JSON.stringify(frame));
    const timer = setTimeout(() => reject(new Error(`cdp ${method} timed out`)), 30_000);
    return await promise.finally(() => clearTimeout(timer));
  }

  async goto(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
    await sleep(1500);
  }

  async evaluate<T>(expression: string): Promise<T> {
    const frame = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const value = (frame.result?.["result"] as { value?: T } | undefined)?.value;
    return value as T;
  }

  /**
   * Clicks via the DOM rather than synthetic mouse coordinates: Excalidraw's menus and
   * dialogs move under headless layout, and a coordinate click that lands a pixel off
   * silently does nothing. A DOM click is what the app's own handlers listen for.
   */
  async clickText(text: string): Promise<void> {
    const clicked = await this.evaluate<boolean>(
      `(() => { const t = ${JSON.stringify(text)};
        const nodes = [...document.querySelectorAll('button, [role=button]')];
        const hit = nodes.find((n) => (n.textContent ?? '').trim().includes(t));
        if (!hit || hit.disabled) return false; hit.click(); return true; })()`,
    );
    if (!clicked) throw new Error(`no enabled element containing ${JSON.stringify(text)}`);
    await sleep(600);
  }

  /**
   * Types into a focused element with real key events. Setting `input.value` directly
   * does NOT drive React's onChange (React reads the value through its own descriptor), so
   * the submit button would stay disabled — that is precisely what broke this gate's
   * first run against the public origin.
   */
  async typeInto(selector: string, text: string): Promise<void> {
    const focused = await this.evaluate<boolean>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return true; })()`,
    );
    if (!focused) throw new Error(`no element to type into: ${selector}`);
    await this.typeText(text);
    await sleep(300);
  }

  async typeText(text: string): Promise<void> {
    for (const char of text) {
      const key = char === "\n" ? "\r" : char;
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", text: key });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", text: key });
    }
  }

  async close(): Promise<void> {
    this.socket?.close();
    this.proc?.kill();
  }
}

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

const browser = new Browser();

await step("real browser renders the canvas over the public origin", async () => {
  await browser.launch();
  // Fresh profile per run, and a real cross-document load so the app bootstraps the
  // #key fragment (a fragment-only change would be a same-document navigation).
  await browser.goto(`${origin}/#key=${ownerKey}`);
  if (await browser.evaluate<boolean>("document.querySelector('input') !== null")) {
    await browser.typeInto("input", "verify");
    await browser.clickText("Enter manifold");
  }
  await browser.goto(`${origin}/p/${padId}`);
  await until(
    () => browser.evaluate<boolean>("document.querySelector('.excalidraw') !== null"),
    20_000,
    "excalidraw mount",
  );
  await until(
    () =>
      browser.evaluate<boolean>(
        "(document.querySelector('[data-testid=connection-state]')?.textContent ?? '') === 'open'",
      ),
    20_000,
    "session open through public origin",
  );
  const path = await browser.evaluate<string>("location.pathname");
  if (path !== `/p/${padId}`) throw new Error(`expected /p/${padId}, on ${path}`);
  return `canvas mounted at ${path}, session open`;
});

await step("embedded terminal opens and runs a command in the browser", async () => {
  await browser.evaluate(
    "(() => { const b = document.querySelector('.dropdown-menu-button'); if (b) b.click(); })()",
  );
  await sleep(500);
  await browser.clickText("New terminal");
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
      type: "rectangle",
      x: 40,
      y: 40,
      width: 120,
      height: 80,
      version: 1,
      versionNonce: 11,
      isDeleted: false,
      index: "a0",
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

await step("co-hosted origin still serves (no collateral damage)", async () => {
  const res = await fetch(peerOrigin, { redirect: "manual" });
  if (res.status >= 500) throw new Error(`${peerOrigin} returned ${res.status}`);
  return `${peerOrigin} -> ${res.status}`;
});

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed against ${origin}`,
);
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
