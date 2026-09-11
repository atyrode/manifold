/**
 * Minimal Chrome DevTools Protocol driver, shared by every verify-*.ts gate that drives a
 * real browser and by bench-sync.ts. System chromium, no extra dependency.
 *
 * Timing lives in `gate-lib.ts` with the rest of the gate bootstrap; this file is the driver
 * and nothing else.
 */
import { rmSync } from "node:fs";
import { reserveLoopbackPort, sleep, until } from "./gate-lib.ts";

interface CdpFrame {
  id?: number;
  /** Set on EVENTS rather than command replies; the two arrive on one socket. */
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * One message the PAGE produced: a console call, an uncaught exception, or a browser log
 * entry. A gate that only reads the DOM cannot tell a handler that never ran from a
 * handler that threw, so every driver captures these and a failing assertion dumps them.
 */
export interface PageMessage {
  readonly kind: "console" | "exception" | "log";
  readonly level: string;
  readonly text: string;
}

/**
 * One MIME payload a drag SOURCE sealed onto a gesture, as the browser itself recorded it.
 * Returned by {@link Browser.dragAndDrop} so a gate can assert on what the source put there
 * rather than on something the gate constructed and handed back to itself.
 */
export interface DragPayload {
  readonly mimeType: string;
  readonly data: string;
}

/** Bounded so a chatty page cannot grow the driver without limit across a long gate. */
const MAX_PAGE_MESSAGES = 500;
const MAX_PAGE_MESSAGE_CHARS = 2_000;

/**
 * What a navigation is allowed to cost before {@link Browser.goto} answers on a parsed
 * document alone, and before it gives up entirely.
 *
 * The floor is the fixed sleep this replaced, kept as the answer of last resort: below it
 * the driver waits for the real thing (the document it ASKED for, loaded), past it it is no
 * slower than the sleep ever was. Only a document that never finishes parsing reaches the
 * ceiling, and that is a broken page rather than a slow one — 30s is also what one CDP
 * command is given in {@link Browser.send}, so nothing here outlives the socket's own patience.
 */
const NAVIGATION_FLOOR_MS = 1_500;
const NAVIGATION_CEILING_MS = 30_000;

/**
 * What the rendered-frame waits after a click and after typing are allowed to cost. Each is
 * the fixed sleep it replaced, so the worst case is exactly the old behaviour and the normal
 * case is two animation frames.
 */
const CLICK_RENDER_CEILING_MS = 600;
const TYPE_RENDER_CEILING_MS = 300;

/** Renders one CDP `Runtime.RemoteObject` as the text a reader wants in a dump. */
function describeRemoteObject(value: unknown): string {
  if (typeof value !== "object" || value === null) return String(value);
  const object = value as {
    type?: string;
    value?: unknown;
    description?: string;
    unserializableValue?: string;
  };
  if (object.value !== undefined) {
    return typeof object.value === "string" ? object.value : JSON.stringify(object.value);
  }
  return object.description ?? object.unserializableValue ?? object.type ?? "?";
}

/** Just enough CDP to navigate, evaluate, click, type, and drive real pointer gestures. */
export class Browser {
  private socket: WebSocket | null = null;
  private proc: Bun.Subprocess | null = null;
  private transientProfile: string | null = null;
  private nextId = 1;
  /** DevTools protocol session (a CDP connection — canon "session", never a PTY). */
  private sessionId = "";
  private readonly pending = new Map<number, (frame: CdpFrame) => void>();
  private readonly messages: PageMessage[] = [];
  /**
   * Extra CDP events a caller asked for, beyond the three {@link capture} files by default.
   *
   * The budget gate is the reason this exists: what it measures — requests by resource,
   * socket frames — is only observable as a STREAM of protocol events, and reading it out of
   * the page instead would mean instrumenting `fetch` and `WebSocket` in the very code under
   * measurement. The driver already owns the socket; it just never let anyone listen.
   */
  private readonly listeners = new Map<string, ((params: Record<string, unknown>) => void)[]>();

  /** Subscribes to one CDP event by method name. Handlers run in registration order. */
  on(method: string, handler: (params: Record<string, unknown>) => void): void {
    const existing = this.listeners.get(method);
    if (existing === undefined) this.listeners.set(method, [handler]);
    else existing.push(handler);
  }

  static detect(): string {
    const explicit = process.env["MANIFOLD_CHROMIUM"];
    if (explicit !== undefined && explicit !== "") return explicit;
    for (const candidate of ["chromium", "chromium-browser", "google-chrome", "chrome"]) {
      const found = Bun.which(candidate);
      if (found !== null) return found;
    }
    throw new Error("no chromium binary found (set MANIFOLD_CHROMIUM)");
  }

  /**
   * Spawns a headless Chromium on a devtools port the kernel just confirmed free
   * ({@link reserveLoopbackPort}). No caller picks the port: the fixed per-gate bands and
   * the random picks that preceded this collided the moment two checkouts ran the gate at
   * once, and the driver is the one place that turns a port into a Chromium flag (#198).
   */
  async launch(options: { readonly incognito?: boolean } = {}): Promise<void> {
    const binary = Browser.detect();
    const port = reserveLoopbackPort();
    // GitHub's ubuntu-24.04 image 20260823.283 exports a malformed
    // DBUS_TERMINAL_BUS_ADDRESS; chromium retries the bus for tens of seconds
    // before its devtools endpoint accepts connections (issue #44). Strip the
    // bus addresses — headless verification needs no DBus.
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (name === "DBUS_TERMINAL_BUS_ADDRESS" || name === "DBUS_SYSTEM_BUS_ADDRESS") continue;
      if (value !== undefined) env[name] = value;
    }
    const profile = `/tmp/manifold-verify-${String(port)}-${String(Date.now())}`;
    this.transientProfile = options.incognito ? profile : null;
    const proc = Bun.spawn(
      [
        binary,
        "--headless=new",
        `--remote-debugging-port=${String(port)}`,
        `--user-data-dir=${profile}`,
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
      // Events carry a method and no id; command replies carry an id and no method.
      if (frame.id === undefined) {
        this.capture(frame);
        return;
      }
      this.pending.get(frame.id)?.(frame);
      this.pending.delete(frame.id);
    };

    // A disposable verifier may handle admission credentials that must stay in memory.
    // Use Chromium's actual off-the-record storage, not a replacement localStorage.
    const context = options.incognito
      ? await this.send("Target.createBrowserContext", { disposeOnDetach: true }, false)
      : null;
    const browserContextId = context?.result?.["browserContextId"];
    if (options.incognito && typeof browserContextId !== "string") {
      throw new Error("Chromium did not create an incognito browser context");
    }
    const target = await this.send(
      "Target.createTarget",
      { url: "about:blank", ...(browserContextId === undefined ? {} : { browserContextId }) },
      false,
    );
    const targetId = String(target.result?.["targetId"]);
    const attached = await this.send("Target.attachToTarget", { targetId, flatten: true }, false);
    this.sessionId = String(attached.result?.["sessionId"]);
    await this.send("Page.enable", {});
    await this.send("Runtime.enable", {});
    // Browser-side log entries (blocked requests, failed websockets, CSP refusals) are
    // invisible to `Runtime` yet are exactly what a silent transport failure looks like.
    await this.send("Log.enable", {});
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

  /**
   * Files one CDP event into the page-message buffer. Only the three that say something
   * a DOM read cannot: what the page LOGGED, what it THREW, and what the browser itself
   * complained about.
   */
  private capture(frame: CdpFrame): void {
    const params = frame.params ?? {};
    for (const handler of this.listeners.get(frame.method ?? "") ?? []) handler(params);
    switch (frame.method) {
      case "Runtime.consoleAPICalled": {
        const args = params["args"];
        this.record(
          "console",
          String(params["type"] ?? "log"),
          (Array.isArray(args) ? args : []).map(describeRemoteObject).join(" "),
        );
        return;
      }
      case "Runtime.exceptionThrown": {
        const details = params["exceptionDetails"] as
          { text?: string; exception?: unknown; url?: string; lineNumber?: number } | undefined;
        const thrown = details?.exception;
        const where =
          details?.url === undefined
            ? ""
            : ` (${details.url}:${String((details.lineNumber ?? 0) + 1)})`;
        this.record(
          "exception",
          "error",
          `${details?.text ?? "uncaught"}${
            thrown === undefined ? "" : `: ${describeRemoteObject(thrown)}`
          }${where}`,
        );
        return;
      }
      case "Log.entryAdded": {
        const entry = params["entry"] as
          { level?: string; text?: string; url?: string } | undefined;
        this.record(
          "log",
          String(entry?.level ?? "info"),
          `${entry?.text ?? ""}${entry?.url === undefined ? "" : ` (${entry.url})`}`,
        );
        return;
      }
      default:
        return;
    }
  }

  private record(kind: PageMessage["kind"], level: string, text: string): void {
    this.messages.push({ kind, level, text: text.slice(0, MAX_PAGE_MESSAGE_CHARS) });
    const overflow = this.messages.length - MAX_PAGE_MESSAGES;
    if (overflow > 0) this.messages.splice(0, overflow);
  }

  /**
   * Hands over everything the page has said since the last drain and forgets it, so a
   * failing assertion reports the window it owns instead of the whole run.
   */
  drainMessages(): readonly PageMessage[] {
    return this.messages.splice(0, this.messages.length);
  }

  /**
   * The loader id of the document the main frame last COMMITTED, as Chromium reported it.
   *
   * `Page.navigate` answers when a navigation STARTS, not when it lands, so a `readyState`
   * read taken straight after it can still be answered by the page being navigated AWAY
   * from — and "complete" from the outgoing document is the one answer that must never count
   * as arrival. The commit is the moment the answers start coming from the document asked for.
   */
  private committedLoaderId = "";
  /** {@link on} has no unsubscribe, so the commit listener is registered once, not per goto. */
  private commitListening = false;

  /**
   * Resolves once the page has produced two animation frames, or at `ceilingMs`.
   *
   * Two and not one: the first frame is the one the browser was already going to draw, the
   * second is the one that shows the work the event just queued — a React render scheduled
   * while the event was dispatched has committed by the time the second callback runs. That
   * is the condition the fixed sleeps after a click and after typing were standing in for,
   * and it costs about two frames (~32ms) rather than the tenths of a second they charged.
   *
   * Bounded and SILENT at the ceiling instead of throwing, because a page that produces no
   * frames at all (frozen lifecycle, script execution disabled) never runs the callback, and
   * for those the ceiling is precisely the fixed wait this replaced: never worse than before,
   * never a new way to fail. A rejection is swallowed for the same reason — a click that
   * navigates destroys the execution context under the evaluation, and a sleep tolerated that.
   */
  private async renderSettled(ceilingMs: number): Promise<void> {
    const painted = this.evaluate<boolean>(
      `(() => { const { promise, resolve } = Promise.withResolvers();
        requestAnimationFrame(() => requestAnimationFrame(() => { resolve(true); }));
        return promise; })()`,
    ).catch(() => false);
    await Promise.race([painted, sleep(ceilingMs)]);
  }

  /**
   * Navigates, and returns when the page is THERE: the document asked for has committed and
   * has finished loading.
   *
   * This was a flat `sleep(1500)`, which is a bound on nothing real. A local page is ready in
   * a fraction of it, and a slow page is not ready at the end of it either — which is why
   * every caller polls for its own condition afterwards regardless. So the wait was pure dead
   * time on every navigation, and the browser gates navigate constantly (`verify-pwa.ts`
   * alone spent ~21s of a ~40s run inside it).
   */
  async goto(url: string): Promise<void> {
    if (!this.commitListening) {
      this.on("Page.frameNavigated", (params) => {
        const frame = params["frame"];
        if (frame === null || typeof frame !== "object") return;
        // Subframes commit too, and a subframe's loader is never this navigation's.
        if (Reflect.get(frame, "parentId") !== undefined) return;
        this.committedLoaderId = String(Reflect.get(frame, "loaderId") ?? "");
      });
      this.commitListening = true;
    }
    const navigated = await this.send("Page.navigate", { url });
    const loaderId = navigated.result?.["loaderId"];
    // No loader means no new document: a fragment-only change is a SAME-document navigation,
    // it fires no load of any kind, and waiting for one would hang every `#key=` re-entry.
    // What it can still do is re-render, so it is given frames and nothing else.
    if (typeof loaderId !== "string" || loaderId === "") {
      await this.renderSettled(NAVIGATION_FLOOR_MS);
      return;
    }
    const startedAt = Date.now();
    await until(
      async () => {
        let state: string;
        try {
          state = await this.evaluate<string>("document.readyState");
        } catch {
          // A read that lands in the commit seam finds no execution context, which is an
          // answer about neither document. Ask again — but never charge a page that will not
          // answer at all more than the floor the fixed sleep already charged it.
          return Date.now() - startedAt >= NAVIGATION_FLOOR_MS;
        }
        if (state === "complete" && this.committedLoaderId === loaderId) return true;
        if (state === "loading") return false;
        // Parsed, but either still loading subresources or still on the outgoing document
        // (an aborted navigation commits nothing): that is what the old sleep settled for.
        return Date.now() - startedAt >= NAVIGATION_FLOOR_MS;
      },
      NAVIGATION_CEILING_MS,
      `${url} to commit and finish parsing`,
    );
  }

  async evaluate<T>(expression: string): Promise<T> {
    const frame = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (frame.error !== undefined) throw new Error(`CDP evaluation failed: ${frame.error.message}`);
    const exception = frame.result?.["exceptionDetails"] as
      { text?: string; exception?: unknown } | undefined;
    if (exception !== undefined) {
      throw new Error(
        `Page evaluation failed: ${
          exception.exception === undefined
            ? (exception.text ?? "unknown exception")
            : describeRemoteObject(exception.exception)
        }`,
      );
    }
    const value = (frame.result?.["result"] as { value?: T } | undefined)?.value;
    return value as T;
  }

  /**
   * Clicks a DECLARED gate contract, via the DOM rather than synthetic coordinates:
   * menus and dialogs move under headless layout, and a coordinate click that lands a
   * pixel off silently does nothing. The key is a `data-testid` because that is a
   * declared contract (REGISTRY.md `gateContracts`, S15) whereas button copy is not — the
   * label this replaced became "Creating identity…" the instant it was pressed.
   */
  async clickTestId(testid: string): Promise<void> {
    const clicked = await this.evaluate<boolean>(
      `(() => { const hit = document.querySelector('[data-testid=' + ${JSON.stringify(
        JSON.stringify(testid),
      )} + ']');
        if (!(hit instanceof HTMLElement) || hit.matches(':disabled')) return false;
        hit.click(); return true; })()`,
    );
    if (!clicked) throw new Error(`no enabled element with data-testid ${JSON.stringify(testid)}`);
    // The click is dispatched; what a caller is actually waiting on is the page having
    // RENDERED its answer to it. `sleep(600)` was a guess at that — one a re-render either
    // beat by half a second or, when the page was busy, did not satisfy anyway.
    await this.renderSettled(CLICK_RENDER_CEILING_MS);
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
    // As with the click: the keystrokes are already acknowledged by the renderer when
    // `typeText` returns, so all that remains is the render they provoked — React's onChange
    // enabling the submit button, most often — which is a frame pair, not a flat 300ms.
    await this.renderSettled(TYPE_RENDER_CEILING_MS);
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

  /**
   * Waiting for the payload of the drag currently being intercepted, or null between drags.
   * One field rather than one listener per gesture: {@link on} has no unsubscribe, so
   * registering per call would leave every finished gesture still listening.
   */
  private dragIntercept: ((data: Record<string, unknown>) => void) | null = null;
  private dragInterceptListening = false;

  /**
   * Drives one HTML5 DRAG-AND-DROP gesture: press on `from`, carry towards `to`, drop there.
   *
   * {@link drag} cannot do this, and not for want of frames. `Input.dispatchMouseEvent`
   * drives the POINTER; native drag-and-drop is a second, browser-level gesture, and Chromium
   * hands it to the platform's own drag loop rather than turning it into `dragover` and `drop`
   * on the page — so a pointer drag out of a `draggable` element fires `dragstart` and then
   * nothing ever reaches any target, and a gate written with `drag` reads "the layout did not
   * change" and calls the product broken. `Input.setInterceptDrags` is the door: with it
   * enabled Chromium performs no native drag and reports the sealed payload back to the driver
   * as `Input.dragIntercepted`, and `Input.dispatchDragEvent` plays that payload into the page
   * as the real event sequence.
   *
   * The press and the carry stay a REAL pointer gesture, so the element's own `draggable` and
   * its own `dragstart` handler are what produce the payload this returns — the driver never
   * builds a DataTransfer of its own, which is what makes the returned items evidence about
   * the source rather than an echo of the gate's own input.
   */
  async dragAndDrop(
    from: { x: number; y: number },
    to: { x: number; y: number },
    stepMs = 30,
  ): Promise<readonly DragPayload[]> {
    if (!this.dragInterceptListening) {
      this.on("Input.dragIntercepted", (params) => {
        const data = params["data"];
        if (data === null || typeof data !== "object") return;
        this.dragIntercept?.(data as Record<string, unknown>);
      });
      this.dragInterceptListening = true;
    }
    const sealed = Promise.withResolvers<Record<string, unknown>>();
    this.dragIntercept = sealed.resolve;
    await this.send("Input.setInterceptDrags", { enabled: true });
    try {
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
      await this.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: from.x,
        y: from.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      /* A drag begins only once the pointer has actually TRAVELLED, so the first half of the
         carry is walked frame by frame — the same threshold a hand crosses — instead of
         teleported to the target, which Chromium reads as a press and a jump and no drag. */
      for (let step = 1; step <= 6; step += 1) {
        await this.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: from.x + ((to.x - from.x) * step) / 12,
          y: from.y + ((to.y - from.y) * step) / 12,
          button: "left",
          buttons: 1,
        });
        await sleep(stepMs);
      }
      const data = await Promise.race([sealed.promise, sleep(5_000).then(() => null)]);
      if (data === null) {
        throw new Error(
          `no drag started at (${String(from.x)}, ${String(from.y)}): nothing under the pointer is a drag source`,
        );
      }
      // dragEnter arms the target, dragOver is the frame it resolves its aim on, drop commits.
      for (const type of ["dragEnter", "dragOver", "drop"]) {
        await this.send("Input.dispatchDragEvent", { type, x: to.x, y: to.y, data });
        await sleep(stepMs);
      }
      const items: DragPayload[] = [];
      const raw: unknown = data["items"];
      for (const item of Array.isArray(raw) ? (raw as readonly unknown[]) : []) {
        if (item === null || typeof item !== "object") continue;
        items.push({
          mimeType: String(Reflect.get(item, "mimeType") ?? ""),
          data: String(Reflect.get(item, "data") ?? ""),
        });
      }
      return items;
    } finally {
      /* The release is what ends the gesture for the page (`dragend`), and interception goes
         off again so every pointer drag after this one behaves as it always did. */
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: to.x,
        y: to.y,
        button: "left",
        clickCount: 1,
      });
      this.dragIntercept = null;
      await this.send("Input.setInterceptDrags", { enabled: false });
    }
  }

  /** Emulates tab lifecycle (e.g. "frozen" ≈ hidden/suspended tab, "active" to resume). */
  async setLifecycle(state: "frozen" | "active"): Promise<void> {
    await this.send("Page.setWebLifecycleState", { state });
  }

  async close(): Promise<void> {
    this.socket?.close();
    this.proc?.kill();
    if (this.transientProfile !== null) {
      const proc = this.proc;
      if (proc !== null) {
        const timer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
        try {
          await proc.exited;
        } finally {
          clearTimeout(timer);
        }
      }
      rmSync(this.transientProfile, { recursive: true, force: true });
      this.transientProfile = null;
    }
  }
}
