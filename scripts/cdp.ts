/**
 * Minimal Chrome DevTools Protocol driver shared by the verification gates
 * (verify-public.ts, verify-convergence.ts). System chromium, no extra dependency.
 */

export const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Polls an async predicate until it returns true, or throws after ms. */
export async function until(
  probe: () => Promise<boolean> | boolean,
  ms: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

interface CdpFrame {
  id?: number;
  result?: Record<string, unknown>;
}

/** Just enough CDP to navigate, evaluate, click, type, and drive real pointer gestures. */
export class Browser {
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
    const binary = Browser.detect();
    // GitHub's ubuntu-24.04 image 20260823.283 exports a malformed
    // DBUS_SESSION_BUS_ADDRESS; chromium retries the bus for tens of seconds
    // before its devtools endpoint accepts connections (issue #44). Strip the
    // bus addresses — headless verification needs no DBus.
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (name === "DBUS_SESSION_BUS_ADDRESS" || name === "DBUS_SYSTEM_BUS_ADDRESS") continue;
      if (value !== undefined) env[name] = value;
    }
    const proc = Bun.spawn(
      [
        binary,
        "--headless=new",
        `--remote-debugging-port=${String(port)}`,
        `--user-data-dir=/tmp/manifold-verify-${String(port)}-${String(Date.now())}`,
        "--no-first-run",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--window-size=1440,900",
        "about:blank",
      ],
      { stdout: "ignore", stderr: "pipe", env },
    );
    this.proc = proc;

    // Keep a bounded stderr tail: launch failures on CI runners are
    // undiagnosable without it (issue #44).
    let stderrTail = "";
    void (async () => {
      const decoder = new TextDecoder();
      const reader = proc.stderr.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        stderrTail = (stderrTail + decoder.decode(chunk.value)).slice(-4096);
      }
    })();
    const diagnostics = (): string =>
      `${binary} (devtools port ${String(port)})${stderrTail === "" ? "" : `\nchromium stderr tail:\n${stderrTail}`}`;

    let endpoint = "";
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (proc.exitCode !== null) {
        throw new Error(
          `chromium exited with code ${String(proc.exitCode)} before its devtools endpoint came up: ${diagnostics()}`,
        );
      }
      try {
        const res = await fetch(`http://127.0.0.1:${String(port)}/json/version`);
        const body = (await res.json()) as { webSocketDebuggerUrl?: string };
        endpoint = body.webSocketDebuggerUrl ?? "";
        if (endpoint !== "") break;
      } catch {
        // devtools endpoint not accepting connections yet
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for chromium devtools endpoint: ${diagnostics()}`);
      }
      await sleep(150);
    }

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
   * Clicks via the DOM rather than synthetic coordinates because menus and dialogs move
   * under headless layout, and a coordinate click that lands a pixel off silently does nothing.
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

  /** Drives one continuous drag with real CDP mouse events — DOM-synthesized events cannot reproduce a gesture. */
  async drag(points: readonly { x: number; y: number }[], stepMs: number): Promise<void> {
    const first = points[0];
    if (first === undefined) return;
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: first.x, y: first.y });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: first.x,
      y: first.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    for (const point of points.slice(1)) {
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 1,
      });
      await sleep(stepMs);
    }
    const last = points[points.length - 1] ?? first;
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: last.x,
      y: last.y,
      button: "left",
      clickCount: 1,
    });
  }

  /** Emulates tab lifecycle (e.g. "frozen" ≈ hidden/suspended tab, "active" to resume). */
  async setLifecycle(state: "frozen" | "active"): Promise<void> {
    await this.send("Page.setWebLifecycleState", { state });
  }

  async close(): Promise<void> {
    this.socket?.close();
    this.proc?.kill();
  }
}
