/**
 * Minimal Chrome DevTools Protocol driver, shared by every verify-*.ts gate that drives a
 * real browser and by bench-sync.ts. System chromium, no extra dependency.
 *
 * Gate polling timing lives in `gate-lib.ts` with the rest of the gate bootstrap; this file is
 * the driver and owns bounded protocol-operation deadlines.
 */
import { existsSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { sleep } from "./gate-lib.ts";

interface CdpFrame {
  id?: number;
  /** Set on EVENTS rather than command replies; the two arrive on one pipe. */
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
 * Chromium answers its first command only once its busy main thread gets to it. Hosted runners
 * have been measured taking ~44s just to come up while D-Bus calls stall that thread (#837), so
 * this bound exists to end an infinite wait with diagnostics, not to fail a slow-but-progressing
 * launch.
 */
const LAUNCH_MS = 60_000;
const COMMAND_MS = 30_000;

/**
 * Chromium's parent: a POSIX shell in a session of its own, given the profile, the private bus's
 * pid and socket (empty without one), then Chromium's command line. Chromium quits when the
 * driver's end of its DevTools pipe closes, and that happens however the driver ends: `close()`,
 * an uncaught error, SIGINT, SIGTERM, or a harness timeout's SIGKILL. The shell then stops the
 * private bus (only while that pid is still the daemon on this launch's socket) and removes the
 * profile and the socket, so nothing a launch made outlives its driver. Its own session keeps
 * signals sent to the driver's process group (a terminal's ^C, `timeout`) from killing it before
 * it has cleaned up.
 */
const SUPERVISOR = `profile=$1 bus=$2 socket=$3
shift 3
"$@"
status=$?
if [ -n "$bus" ] && grep -qF -- "$socket" "/proc/$bus/cmdline" 2>/dev/null; then kill "$bus"; fi
rm -rf -- "$profile"
if [ -n "$socket" ]; then rm -f -- "$socket"; fi
exit "$status"`;

/** The last launch's stamp, so two browsers launched within one millisecond differ. */
let lastLaunch = 0;

/** `<pid>-<ms>`, unique to one launch on this machine: names its profile and its bus socket. */
function launchStamp(): string {
  lastLaunch = Math.max(Date.now(), lastLaunch + 1);
  return `${String(process.pid)}-${String(lastLaunch)}`;
}

/**
 * A rejection that may come before anyone waits for it, handled up front: a page lost while
 * nothing raced {@link Browser.lost} must not end the process as an unhandled rejection.
 */
function lossSignal(): PromiseWithResolvers<never> {
  const signal = Promise.withResolvers<never>();
  void signal.promise.catch(() => {});
  return signal;
}

/**
 * The page a {@link Browser} drives is gone: its renderer crashed or was killed, it detached, or
 * Chromium exited. {@link Browser.lost} rejects with it and so does every command from then on,
 * so a caller can tell a dead page from a busy one.
 */
export class PageLostError extends Error {
  override readonly name = "PageLostError";
}

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
  /** The driver's ends of Chromium's DevTools pipe: commands to its fd 3, frames from its fd 4. */
  private toBrowser: Socket | null = null;
  private fromBrowser: Socket | null = null;
  /** The supervisor shell ({@link SUPERVISOR}), Chromium's parent. */
  private proc: Bun.Subprocess | null = null;
  private privateBus: Bun.Subprocess | null = null;
  private privateBusSocket: string | null = null;
  private profile: string | null = null;
  /** Set by {@link close}: the pipe closing then is no loss. */
  private closing = false;
  /** Why the page is gone, once it is (see {@link lost}). */
  private lostReason: string | null = null;
  private lostSignal = lossSignal();
  private nextId = 1;
  /** DevTools protocol session (a CDP connection — canon "session", never a PTY). */
  private sessionId = "";
  private readonly pending = new Map<
    number,
    { readonly method: string; readonly reply: PromiseWithResolvers<CdpFrame> }
  >();
  private readonly messages: PageMessage[] = [];
  /**
   * Extra CDP events a caller asked for, beyond the three {@link capture} files by default.
   *
   * The budget gate is the reason this exists: what it measures — requests by resource,
   * socket frames — is only observable as a STREAM of protocol events, and reading it out of
   * the page instead would mean instrumenting `fetch` and `WebSocket` in the very code under
   * measurement. The driver already owns the pipe; it just never let anyone listen.
   */
  private readonly listeners = new Map<string, ((params: Record<string, unknown>) => void)[]>();

  /**
   * Subscribes to one CDP event by method name. Handlers run in registration order.
   * Returns an idempotent callback that removes this subscription.
   */
  on(method: string, handler: (params: Record<string, unknown>) => void): () => void {
    const existing = this.listeners.get(method);
    if (existing === undefined) this.listeners.set(method, [handler]);
    else existing.push(handler);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const handlers = this.listeners.get(method);
      if (handlers === undefined) return;
      const index = handlers.indexOf(handler);
      if (index === -1) return;
      if (handlers.length === 1) this.listeners.delete(method);
      else {
        this.listeners.set(method, [...handlers.slice(0, index), ...handlers.slice(index + 1)]);
      }
    };
  }

  /**
   * Never resolves; rejects with a {@link PageLostError} once the page is gone: its renderer
   * crashed or was killed (earlyoom picks renderers first), it detached, or Chromium exited.
   * Commands fail at once from then on by themselves; a caller waiting for anything else (a page
   * binding, an event) races this, so a dead page fails it at once rather than at its deadline.
   */
  get lost(): Promise<never> {
    return this.lostSignal.promise;
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
   * Chromium's D-Bus client auto-launches a session bus when no usable address exists. That
   * fork/exec path has stalled headless startup on hosted Linux, while an invalid address is
   * retried by current Chromium. Give each browser a real, disposable bus instead; Chromium's
   * supervisor stops it once Chromium has exited, so it does not outlive a killed driver either.
   */
  private async startPrivateBus(stamp: string): Promise<string | null> {
    if (process.platform !== "linux") return null;
    const daemon = Bun.which("dbus-daemon");
    if (daemon === null) throw new Error("no dbus-daemon available for isolated Chromium launch");

    const socket = `/tmp/manifold-verify-dbus-${stamp}`;
    rmSync(socket, { force: true });
    const bus = Bun.spawn(
      [daemon, "--session", "--nofork", "--nopidfile", `--address=unix:path=${socket}`],
      { stdout: "ignore", stderr: "pipe" },
    );
    this.privateBus = bus;
    this.privateBusSocket = socket;
    const stderr = new Response(bus.stderr).text();
    const deadline = Date.now() + 2_000;
    try {
      while (!existsSync(socket)) {
        if (bus.exitCode !== null) {
          throw new Error(
            `dbus-daemon exited with code ${String(bus.exitCode)} before its private socket came up: ${(
              await stderr
            ).slice(-4096)}`,
          );
        }
        if (Date.now() > deadline) {
          throw new Error("timed out waiting for dbus-daemon private socket");
        }
        await sleep(10);
      }
      return `unix:path=${socket}`;
    } catch (error) {
      await this.closePrivateBus();
      throw error;
    }
  }

  private async closePrivateBus(): Promise<void> {
    const bus = this.privateBus;
    this.privateBus = null;
    if (bus !== null && bus.exitCode === null) {
      bus.kill();
      const timer = setTimeout(() => bus.kill("SIGKILL"), 5_000);
      try {
        await bus.exited;
      } finally {
        clearTimeout(timer);
      }
    }
    if (this.privateBusSocket !== null) {
      rmSync(this.privateBusSocket, { force: true });
      this.privateBusSocket = null;
    }
  }

  /**
   * Spawns a headless Chromium driven over `--remote-debugging-pipe` rather than a devtools port:
   * there is no port for two checkouts to collide on (#198) and no endpoint to probe for
   * readiness (#835). Chromium quits when the driver's end of the pipe closes, so it cannot
   * outlive the driver, and its supervisor ({@link SUPERVISOR}) then removes the profile.
   */
  async launch(
    options: { readonly incognito?: boolean; readonly softwareWebgl?: boolean } = {},
  ): Promise<void> {
    const binary = Browser.detect();
    const stamp = launchStamp();
    const busAddress = await this.startPrivateBus(stamp);
    // Do not inherit runner buses or give Chromium an invalid endpoint. A private D-Bus daemon
    // prevents libdbus auto-launch while letting its clients fail missing-service requests
    // normally. Non-Linux launchers retain the previous non-connectable sentinel.
    const env = {
      ...process.env,
      DBUS_SESSION_BUS_ADDRESS: busAddress ?? "unix:path=/dev/null",
      DBUS_SYSTEM_BUS_ADDRESS: busAddress ?? "unix:path=/dev/null",
    };
    const profile = `/tmp/manifold-verify-${stamp}`;
    this.profile = profile;
    this.closing = false;
    this.lostReason = null;
    this.lostSignal = lossSignal();
    const proc = Bun.spawn(
      [
        "/bin/sh",
        "-c",
        SUPERVISOR,
        "sh",
        profile,
        this.privateBus === null ? "" : String(this.privateBus.pid),
        this.privateBusSocket ?? "",
        binary,
        "--headless=new",
        "--remote-debugging-pipe",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-sandbox",
        ...(options.softwareWebgl
          ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
          : ["--disable-gpu"]),
        "--disable-dev-shm-usage",
        "--window-size=1440,900",
        "about:blank",
      ],
      { detached: true, stdio: ["ignore", "ignore", "pipe", "socket-fd", "socket-fd"], env },
    );
    this.proc = proc;

    // Keep a bounded stderr tail: launch failures on CI runners are
    // undiagnosable without it (issue #44).
    let stderrTail = "";
    const stderrDrained = (async () => {
      const decoder = new TextDecoder();
      const reader = proc.stderr.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        stderrTail = (stderrTail + decoder.decode(chunk.value)).slice(-4096);
      }
    })();
    const launched = Date.now();
    const diagnostics = (): string =>
      `${binary} (profile ${profile}, ${String(Date.now() - launched)}ms after launch)${stderrTail === "" ? "" : `\nchromium stderr tail:\n${stderrTail}`}`;

    const [, , , commandFd, frameFd] = proc.stdio;
    if (typeof commandFd !== "number" || typeof frameFd !== "number") {
      throw new Error(`no devtools pipe was opened for chromium: ${diagnostics()}`);
    }
    // Bun adopts inherited sockets through connect({fd}), not new Socket({fd}).
    // node:net's declarations do not yet include this Bun overload.
    const adopt = connect as unknown as (options: { readonly fd: number }) => Socket;
    const toBrowser = adopt({ fd: commandFd });
    const fromBrowser = adopt({ fd: frameFd });
    this.toBrowser = toBrowser;
    this.fromBrowser = fromBrowser;
    // A write racing Chromium's exit fails on the socket; the close below says why.
    toBrowser.on("error", () => {});
    fromBrowser.on("error", () => {});
    // Each frame is one JSON text ended by a NUL. The utf8 encoding hands over text whole even
    // where a chunk splits a character.
    let partial = "";
    fromBrowser.setEncoding("utf8");
    fromBrowser.on("data", (data: string | Buffer) => {
      const chunk = data.toString();
      let start = 0;
      for (let end = chunk.indexOf("\0"); end !== -1; end = chunk.indexOf("\0", start)) {
        this.dispatch(JSON.parse(partial + chunk.slice(start, end)) as CdpFrame);
        partial = "";
        start = end + 1;
      }
      partial += chunk.slice(start);
    });
    // The pipe closes only when Chromium has gone. Unless close() did that, it is a loss: wait
    // briefly for the exit code and the last of stderr, which say why.
    fromBrowser.once("close", () => {
      if (this.closing) return;
      void Promise.race([Promise.all([proc.exited, stderrDrained]), sleep(2_000)]).then(() => {
        const code = proc.exitCode === null ? "" : ` with code ${String(proc.exitCode)}`;
        this.lose(`chromium exited${code}: ${diagnostics()}`);
      });
    });

    try {
      await this.command("Browser.getVersion", {}, false, LAUNCH_MS);
    } catch (error) {
      // A timeout says nothing on its own; an exit (stderr included) or close() says why.
      if (this.lostReason !== null || this.closing) throw error;
      throw new Error(`timed out waiting for chromium's devtools pipe: ${diagnostics()}`);
    }

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
    // A renderer that crashes or is killed (earlyoom picks renderers first) is reported only
    // through Inspector; without it the page would just stop answering.
    await this.send("Inspector.enable", {});
  }

  async send(
    method: string,
    params: Record<string, unknown>,
    withSession = true,
  ): Promise<CdpFrame> {
    return await this.command(method, params, withSession, COMMAND_MS);
  }

  private async command(
    method: string,
    params: Record<string, unknown>,
    withSession: boolean,
    ms: number,
  ): Promise<CdpFrame> {
    const pipe = this.toBrowser;
    if (pipe === null) throw new Error(this.closing ? "browser closed" : "browser not launched");
    if (this.lostReason !== null) throw new PageLostError(`cdp ${method}: ${this.lostReason}`);
    const id = this.nextId++;
    const reply = Promise.withResolvers<CdpFrame>();
    this.pending.set(id, { method, reply });
    const frame: Record<string, unknown> = { id, method, params };
    if (withSession && this.sessionId !== "") frame["sessionId"] = this.sessionId;
    pipe.write(`${JSON.stringify(frame)}\0`);
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reply.reject(new Error(`cdp ${method} timed out`));
    }, ms);
    return await reply.promise.finally(() => clearTimeout(timer));
  }

  /** Hands a command's reply to its waiter, and an event to {@link capture} and {@link watch}. */
  private dispatch(frame: CdpFrame): void {
    // Events carry a method and no id; command replies carry an id and no method.
    if (frame.id === undefined) {
      this.capture(frame);
      this.watch(frame);
      return;
    }
    this.pending.get(frame.id)?.reply.resolve(frame);
    this.pending.delete(frame.id);
  }

  /** Turns the events that say the page is gone into a {@link lose loss}. */
  private watch(frame: CdpFrame): void {
    const params = frame.params ?? {};
    if (frame.method === "Inspector.targetCrashed") {
      this.lose(
        "renderer crashed or was killed (earlyoom picks renderers first; see journalctl and dmesg)",
      );
    } else if (frame.method === "Inspector.detached") {
      this.lose(`page detached: ${String(params["reason"] ?? "no reason given")}`);
    } else if (
      frame.method === "Target.detachedFromTarget" &&
      params["sessionId"] === this.sessionId
    ) {
      this.lose("page detached from its devtools session");
    }
  }

  /**
   * Records, once, why the page is gone: {@link lost} rejects with it, and so does every command
   * in flight and every later one, instead of each waiting out its own deadline.
   */
  private lose(reason: string): void {
    if (this.lostReason !== null || this.closing) return;
    this.lostReason = reason;
    this.lostSignal.reject(new PageLostError(reason));
    for (const { method, reply } of this.pending.values()) {
      reply.reject(new PageLostError(`cdp ${method}: ${reason}`));
    }
    this.pending.clear();
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

  async goto(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
    await sleep(1500);
  }

  /**
   * Reloads the current page and waits until Chromium reports that the new document loaded.
   * The event subscription is installed before the command so a fast load cannot race it.
   */
  async reload(): Promise<void> {
    const loaded = Promise.withResolvers<void>();
    let unsubscribe = (): void => {};
    unsubscribe = this.on("Page.loadEventFired", () => {
      unsubscribe();
      loaded.resolve();
    });
    const timer = setTimeout(
      () => loaded.reject(new Error("timed out waiting for Page.loadEventFired after Page.reload")),
      30_000,
    );
    try {
      const reload = this.send("Page.reload", {}).then((frame) => {
        if (frame.error !== undefined) {
          throw new Error(`CDP Page.reload failed: ${frame.error.message}`);
        }
      });
      await Promise.all([reload, loaded.promise]);
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
  }

  async evaluate<T>(expression: string): Promise<T> {
    // CDP's awaitPromise callback is weak. Retain the returned remote object until
    // awaiting/serialization finishes, then release the exact evaluation group.
    const objectGroup = `manifold-evaluation-${String(this.nextId)}`;
    let frame = await this.send("Runtime.evaluate", {
      expression,
      objectGroup,
      returnByValue: false,
      awaitPromise: false,
    });
    const result = frame.result?.["result"];
    const remote = typeof result === "object" && result !== null ? result : null;
    const objectId =
      remote !== null && "objectId" in remote && typeof remote.objectId === "string"
        ? remote.objectId
        : null;
    const isPromise = remote !== null && "subtype" in remote && remote.subtype === "promise";
    try {
      if (
        objectId !== null &&
        frame.result?.["exceptionDetails"] === undefined &&
        frame.error === undefined
      ) {
        frame = await this.send(
          isPromise ? "Runtime.awaitPromise" : "Runtime.callFunctionOn",
          isPromise
            ? { promiseObjectId: objectId, returnByValue: true }
            : { objectId, functionDeclaration: "function() { return this; }", returnByValue: true },
        );
      }
      if (frame.error !== undefined)
        throw new Error(`CDP evaluation failed: ${frame.error.message}`);
      const exception = frame.result?.["exceptionDetails"];
      if (exception !== undefined) {
        const details = typeof exception === "object" && exception !== null ? exception : null;
        const fault = details !== null && "exception" in details ? details.exception : undefined;
        const text =
          details !== null && "text" in details && typeof details.text === "string"
            ? details.text
            : "unknown exception";
        throw new Error(
          `Page evaluation failed: ${fault === undefined ? text : describeRemoteObject(fault)}`,
        );
      }
      const response = frame.result?.["result"];
      const value =
        typeof response === "object" && response !== null && "value" in response
          ? response.value
          : undefined;
      // Callers supply the type of their JavaScript expression; CDP returns unknown.
      const typedValue = value as T;
      return typedValue;
    } finally {
      if (objectId !== null) await this.send("Runtime.releaseObjectGroup", { objectGroup });
    }
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
      // The first over paints the preview. If it replaces the element under the pointer,
      // Chromium spends the next over delivering enter/leave to the new target; that target
      // still needs its own over to accept the carry before release. Keep these native
      // frames at the same point, like a hand resting over the preview, rather than dropping
      // against the acceptance of a DOM element the preview has already replaced.
      for (const type of ["dragEnter", "dragOver", "dragOver", "dragOver", "drop"]) {
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
    this.closing = true;
    for (const { method, reply } of this.pending.values()) {
      reply.reject(new Error(`cdp ${method}: browser closed`));
    }
    this.pending.clear();
    // Chromium quits when its end of the pipe closes, as it does when the driver dies without
    // getting here; its supervisor then removes the profile.
    this.toBrowser?.destroy();
    this.fromBrowser?.destroy();
    this.toBrowser = null;
    this.fromBrowser = null;
    const proc = this.proc;
    // The private bus must outlive its Chromium client. Stopping it first can
    // abort a still-running browser and keep the page's sockets alive during
    // the core dump, including for ordinary non-incognito launches.
    if (proc !== null) {
      // The supervisor leads its own process group, so this reaches Chromium and its helpers.
      const timer = setTimeout(() => {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          // the group has just exited
        }
      }, 5_000);
      try {
        await proc.exited;
      } finally {
        clearTimeout(timer);
      }
    }
    if (this.profile !== null) {
      rmSync(this.profile, { recursive: true, force: true });
      this.profile = null;
    }
    await this.closePrivateBus();
  }
}
