/**
 * Isolated published-engine replay, not Manifold transport or physical-paint latency.
 * Run: bun scripts/bench-terminal-engines.ts [--keep-artifacts]
 * Downloads exact integrity-pinned npm archives without invoking an installer/lifecycle.
 * Source contracts: https://unpkg.com/ghostty-web@0.4.0/dist/index.d.ts
 * https://github.com/coder/ghostty-web/blob/9e4e126d89ac3537d2b2ebec075849851566de9f/lib/terminal.ts
 * https://github.com/xtermjs/xterm.js/tree/f447274f430fd22513f6adbf9862d19524471c04
 */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Browser } from "./cdp.ts";
import { sleep } from "./gate-lib.ts";

const PACKAGES = [
  {
    name: "@xterm/xterm",
    version: "6.0.0",
    directory: "xterm",
    entry: "lib/xterm.mjs",
    integrity:
      "sha512-TQwDdQGtwwDt+2cgKDLn0IRaSxYu1tSUjgKarSDkUM0ZNiSRXFpjxEsvc/Zgc5kq5omJ+V0a8/kIM2WD3sMOYg==",
  },
  {
    name: "@xterm/addon-webgl",
    version: "0.19.0",
    directory: "webgl",
    entry: "lib/addon-webgl.mjs",
    integrity:
      "sha512-b3fMOsyLVuCeNJWxolACEUED0vm7qC0cy4wRvf3oURSzDTYVQiGPhTnhWZwIHdvC48Y+oLhvYXnY4XDXPoJo6A==",
  },
  {
    name: "ghostty-web",
    version: "0.4.0",
    directory: "ghostty",
    entry: "dist/ghostty-web.js",
    integrity:
      "sha512-0puDBik2qapbD/QQBW9o5ZHfXnZBqZWx/ctBiVtKZ6ZLds4NYb+wZuw1cRLXZk9zYovIQ908z3rvFhexAvc5Hg==",
  },
] as const;
const FONT_SHA256 = "d02ced77185cd23a3fdaaeba0bdc47c59fc8d03059dad2802742e6962c11dcc6";
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const describe = (error: unknown): string =>
  String(error instanceof Error ? error.message : error).slice(0, 2000);

async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}: exceeded ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "error" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${url}: missing response body`);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 16 * 1024 * 1024) throw new Error(`${url}: exceeds 16MiB download cap`);
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

// This function is transpiled by Bun, serialized into the sandbox entry, then bundled.
// Its types describe only the pinned APIs this experiment actually exercises.
interface Disposable {
  dispose(): void;
}
interface ReplayTerminal extends Disposable {
  cols: number;
  rows: number;
  textarea?: HTMLTextAreaElement;
  buffer: {
    active: {
      length: number;
      getLine(index: number): { translateToString(trim?: boolean): string } | undefined;
    };
  };
  options: Record<string, unknown>;
  open(host: HTMLElement): void;
  resize(cols: number, rows: number): void;
  write(bytes: Uint8Array, callback?: () => void): void;
  focus(): void;
  onData(callback: (data: string) => void): Disposable;
  loadAddon(addon: Disposable): void;
}
interface ReplayAddon extends Disposable {
  onContextLoss(callback: () => void): Disposable;
}
interface PageApi {
  setup(kind: string): Promise<unknown>;
  grid(cols: number, rows: number): Promise<unknown>;
  finish(): Promise<unknown>;
}
function replayPage(
  Xterm: new (options: Record<string, unknown>) => ReplayTerminal,
  Webgl: new () => ReplayAddon,
  GhostTerminal: new (options: Record<string, unknown>) => ReplayTerminal,
  Ghostty: { load(path: string): Promise<unknown> },
): void {
  const state = window as unknown as { engineReplay: PageApi };
  const host = document.getElementById("terminal")!;
  let terminal: ReplayTerminal | undefined;
  let addon: ReplayAddon | undefined;
  let kind = "";
  let contexts: { canvas: HTMLCanvasElement; context: RenderingContext; type: string }[] = [];
  const hooks = new Set<string>();
  const encoder = new TextEncoder();
  const timeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
    let timer = 0;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => reject(new Error(`${label}: 4000ms timeout`)), 4000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const raf = async (): Promise<number> => {
    const start = performance.now();
    await timeout(
      new Promise<void>((done) => requestAnimationFrame(() => done())),
      "RAF scheduling proxy",
    );
    return performance.now() - start;
  };
  const renderer = (): unknown => ({
    domRows: host.querySelectorAll(".xterm-rows > div").length,
    attachedContexts: contexts
      .filter((item) => host.contains(item.canvas))
      .map((item) => ({
        type: item.type,
        width: item.canvas.width,
        height: item.canvas.height,
        contextLost:
          item.context instanceof WebGL2RenderingContext ? item.context.isContextLost() : null,
      })),
  });
  const write = async (bytes: Uint8Array): Promise<unknown> => {
    if (!terminal) throw new Error("terminal not open");
    const start = performance.now();
    let returned = false;
    let synchronous = false;
    const completion = new Promise<number>((done) =>
      terminal!.write(bytes, () => {
        synchronous = !returned;
        done(performance.now() - start);
      }),
    );
    const callReturnMs = performance.now() - start;
    returned = true;
    const writeCallbackMs = await timeout(completion, "documented write callback");
    return { writeCallbackMs, callReturnMs, synchronousCallback: synchronous };
  };
  const visible = (): string[] => {
    const buffer = terminal!.buffer.active;
    // Both pinned public buffers index scrollback before the screen. Do not use
    // baseY here: ghostty-web's compatibility baseY has different semantics.
    return Array.from(
      { length: terminal!.rows },
      (_, row) =>
        buffer
          .getLine(Math.max(0, buffer.length - terminal!.rows) + row)
          ?.translateToString(true) ?? "",
    );
  };
  state.engineReplay = {
    async setup(requested) {
      kind = requested;
      contexts = [];
      hooks.clear();
      const font = new FontFace("Manifold Engine Replay", "url(/font.woff2)");
      await timeout(font.load(), "pinned font load");
      (document.fonts as FontFaceSet & Pick<Set<FontFace>, "add">).add(font);
      await document.fonts.ready;
      const options: Record<string, unknown> = {
        cols: 80,
        rows: 24,
        scrollback: 2000,
        fontFamily: "Manifold Engine Replay",
        fontSize: 14,
        cursorBlink: false,
        allowProposedApi: true,
        theme: { foreground: "#d8dee9", background: "#0b0d10", cursor: "#d8dee9" },
      };
      if (kind === "ghostty-canvas2d")
        options["ghostty"] = await timeout(Ghostty.load("/ghostty-vt.wasm"), "Ghostty WASM load");
      const originalContext = HTMLCanvasElement.prototype.getContext;
      const originalListener = EventTarget.prototype.addEventListener;
      // Setup-only observation; no instrumentation in the timed write path.
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        ...args: Parameters<typeof originalContext>
      ) {
        const context = Reflect.apply(originalContext, this, args) as RenderingContext | null;
        if (context && !contexts.some((item) => item.context === context))
          contexts.push({ canvas: this, context, type: args[0] });
        return context;
      } as typeof originalContext;
      EventTarget.prototype.addEventListener = function (
        this: EventTarget,
        ...args: Parameters<typeof originalListener>
      ) {
        if (args[0].startsWith("composition") || args[0] === "beforeinput" || args[0] === "input")
          hooks.add(args[0]);
        Reflect.apply(originalListener, this, args);
      };
      try {
        terminal = new (kind === "ghostty-canvas2d" ? GhostTerminal : Xterm)(options);
        terminal.open(host);
        if (kind === "xterm-webgl2") {
          addon = new Webgl();
          terminal.loadAddon(addon);
        }
      } finally {
        HTMLCanvasElement.prototype.getContext = originalContext;
        EventTarget.prototype.addEventListener = originalListener;
      }
      const activeGl = contexts.find(
        (item) => host.contains(item.canvas) && item.context instanceof WebGL2RenderingContext,
      );
      if (kind === "xterm-webgl2" && !activeGl)
        throw new Error(
          "WebGL2 feature refused: no attached WebGL2 renderer; fallback is not measured under WebGL label",
        );
      if (
        kind === "ghostty-canvas2d" &&
        !contexts.some((item) => host.contains(item.canvas) && item.type === "2d")
      )
        throw new Error("No attached Canvas2D renderer observed");
      if (kind === "xterm-dom" && host.querySelectorAll(".xterm-rows").length === 0)
        throw new Error("No xterm DOM renderer observed");
      let gpu: unknown = null;
      if (activeGl) {
        const gl = activeGl.context as WebGL2RenderingContext;
        const debug = gl.getExtension("WEBGL_debug_renderer_info");
        gpu = {
          version: gl.getParameter(gl.VERSION),
          vendor: gl.getParameter(gl.VENDOR),
          renderer: gl.getParameter(gl.RENDERER),
          unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
          unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
        };
      }
      const data: string[] = [];
      const subscription = terminal.onData((value) => {
        if (data.length < 8) data.push(value.slice(0, 64));
      });
      terminal.focus();
      const target = terminal.textarea ?? host;
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowUp",
          code: "ArrowUp",
          keyCode: 38,
          bubbles: true,
          cancelable: true,
        }),
      );
      subscription.dispose();
      return {
        renderer: renderer(),
        gpu,
        fontStatus: font.status,
        boundary: {
          syntheticArrowUpOnData: data,
          expectedArrowUpObserved: data.includes("\u001b[A"),
          keyScope: "synthetic DOM key event only, not native keyboard or PTY",
          textareaPresent: !!terminal.textarea,
          registeredInputHooks: [...hooks],
          accessibilityAttributes: Array.from(
            host.querySelectorAll("[role], [aria-label], [aria-live]"),
          )
            .slice(0, 12)
            .map((element) => ({
              role: element.getAttribute("role"),
              label: element.getAttribute("aria-label"),
              live: element.getAttribute("aria-live"),
            })),
          hostRole: host.getAttribute("role"),
          screenReaderModeOptionPresent: "screenReaderMode" in terminal.options,
          imeBehavior: "not tested; hook registration is introspection only",
          accessibilityBehavior: "not tested with assistive technology",
        },
      };
    },
    async grid(cols, rows) {
      if (!terminal) throw new Error("terminal not open");
      terminal.resize(cols, rows);
      const samples: unknown[] = [];
      for (let trial = 0; trial < 3; trial++) {
        const marker = `ENGINE-END-${cols}x${rows}-${trial}`;
        let text = "\u001b[0m\u001b[H\u001b[2J";
        for (let line = 0; line < 240; line++)
          text += `row-${String(line).padStart(3, "0")} \u001b[38;2;90;180;240mcolor\u001b[0m plain\r\n`;
        text += `\u001b[H\u001b[2J\u001b[1;1H${marker}\u001b[2;1HREDRAW-OLD\u001b[2;1HREDRAW-OK!\u001b[3;1Hwide: 界 combining: e\u0301\u001b[4;1H\u001b[1;4mstyled\u001b[0m`;
        const bytes = encoder.encode(text);
        if (bytes.length > 32768) throw new Error("corpus exceeds 32KiB bound");
        const timing = await write(bytes);
        const lines = visible();
        const correctness = {
          marker: lines[0] === marker,
          cursorRedraw: lines[1] === "REDRAW-OK!",
          wideCombining: lines[2] === "wide: 界 combining: e\u0301",
          firstFourPublicBufferLines: lines.slice(0, 4),
          bufferLength: terminal.buffer.active.length,
          scrollbackLines: Math.max(0, terminal.buffer.active.length - rows),
        };
        samples.push({
          trial,
          bytes: bytes.length,
          timing,
          correctness,
          rafScheduleProxyMs: await raf(),
        });
      }
      return {
        cols,
        rows,
        samples,
        renderer: renderer(),
        completion:
          kind === "ghostty-canvas2d"
            ? "ghostty-web 0.4.0 writes synchronously to WASM then schedules its callback with requestAnimationFrame; callback time includes scheduling, not parser-only time or physical paint"
            : "xterm 6.0.0 write callback follows queued parser processing; not render completion or physical paint",
        correctnessScope: "public buffer assertions, not pixel/glyph-shaping proof",
      };
    },
    async finish() {
      let contextLoss: unknown = { attempted: false, reason: "not a WebGL run" };
      try {
        const entry = contexts.find(
          (item) => host.contains(item.canvas) && item.context instanceof WebGL2RenderingContext,
        );
        if (kind === "xterm-webgl2" && addon && entry) {
          const gl = entry.context as WebGL2RenderingContext;
          const extension = gl.getExtension("WEBGL_lose_context");
          if (extension) {
            const activeAddon = addon;
            let listener: Disposable | undefined;
            try {
              const loss = new Promise<void>((done) => {
                listener = activeAddon.onContextLoss(() => {
                  activeAddon.dispose();
                  addon = undefined;
                  done();
                });
              });
              extension.loseContext();
              await timeout(loss, "addon onContextLoss");
              const timing = await write(encoder.encode("\u001b[1;1H\u001b[2KAFTER-CONTEXT-LOSS"));
              await raf();
              contextLoss = {
                attempted: true,
                callbackObserved: true,
                policy:
                  "experiment explicitly disposes addon on its public context-loss event; not automatic recovery",
                originalContextLost: gl.isContextLost(),
                fallbackDomRows: host.querySelectorAll(".xterm-rows > div").length,
                marker: visible()[0] === "AFTER-CONTEXT-LOSS",
                timing,
                renderer: renderer(),
              };
            } finally {
              listener?.dispose();
            }
          } else contextLoss = { attempted: false, reason: "WEBGL_lose_context unavailable" };
        }
        return { contextLoss };
      } finally {
        terminal?.dispose();
        terminal = undefined;
        addon = undefined;
        host.replaceChildren();
        for (const attribute of [
          "role",
          "aria-label",
          "aria-multiline",
          "contenteditable",
          "tabindex",
        ])
          host.removeAttribute(attribute);
      }
    },
  };
}

// Dedicated CDP lifecycle rather than Browser.launch(): the shared driver forces
// --disable-gpu and does not own/remove its profile. Never alter that shared helper.
class IsolatedBrowser {
  proc: Bun.Subprocess | undefined;
  socket: WebSocket | undefined;
  sessionId = "";
  nextId = 0;
  pending = new Map<
    number,
    { resolve(value: Record<string, unknown>): void; reject(error: Error): void }
  >();
  messages: string[] = [];
  async launch(profile: string): Promise<void> {
    this.proc = Bun.spawn(
      [
        Browser.detect(),
        "--headless=new",
        "--no-sandbox",
        "--no-first-run",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--window-size=1600,1000",
        "about:blank",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    let endpoint = "";
    const deadline = Date.now() + 25_000;
    while (!endpoint && Date.now() < deadline) {
      if (this.proc.exitCode !== null) throw new Error(`Chromium exited ${this.proc.exitCode}`);
      const file = Bun.file(join(profile, "DevToolsActivePort"));
      if (await file.exists()) {
        const [port, path] = (await file.text()).trim().split("\n");
        if (port && path) endpoint = `ws://127.0.0.1:${port}${path}`;
      }
      if (!endpoint) await sleep(50);
    }
    if (!endpoint) throw new Error("Chromium DevToolsActivePort not ready after 25000ms");
    const socket = new WebSocket(endpoint);
    this.socket = socket;
    await bounded(
      new Promise<void>((done, reject) => {
        socket.onopen = () => done();
        socket.onerror = () => reject(new Error("CDP socket open failed"));
      }),
      5000,
      "CDP open",
    );
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      const frame = JSON.parse(event.data) as {
        id?: number;
        result?: Record<string, unknown>;
        error?: { message?: string };
        method?: string;
        params?: unknown;
      };
      if (frame.id !== undefined) {
        const pending = this.pending.get(frame.id);
        if (frame.error) pending?.reject(new Error(frame.error.message ?? "CDP error"));
        else pending?.resolve(frame.result ?? {});
        this.pending.delete(frame.id);
      } else if (frame.method === "Runtime.exceptionThrown" && this.messages.length < 20)
        this.messages.push(JSON.stringify(frame.params).slice(0, 1500));
    };
    const target = await this.send("Target.createTarget", { url: "about:blank" });
    const session = await this.send("Target.attachToTarget", {
      targetId: target["targetId"],
      flatten: true,
    });
    this.sessionId = String(session["sessionId"]);
    await this.send("Runtime.enable");
    await this.send("Page.enable");
  }
  async send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    try {
      return await bounded(
        new Promise<Record<string, unknown>>((resolve, reject) => {
          this.pending.set(id, { resolve, reject });
          this.socket!.send(
            JSON.stringify({
              id,
              method,
              params,
              ...(this.sessionId ? { sessionId: this.sessionId } : {}),
            }),
          );
        }),
        15_000,
        `CDP ${method}`,
      );
    } finally {
      this.pending.delete(id);
    }
  }
  async evaluate(expression: string): Promise<unknown> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result["exceptionDetails"])
      throw new Error(JSON.stringify(result["exceptionDetails"]).slice(0, 2000));
    return (result["result"] as { value?: unknown } | undefined)?.value;
  }
  async close(): Promise<void> {
    this.socket?.close();
    if (this.proc) {
      this.proc.kill();
      try {
        await bounded(this.proc.exited, 5000, "Chromium exit");
      } catch {
        this.proc.kill("SIGKILL");
        await bounded(this.proc.exited, 5000, "Chromium kill");
      }
    }
  }
}

async function main(): Promise<void> {
  const keep = process.argv.includes("--keep-artifacts");
  const sandbox = await mkdtemp(join(tmpdir(), "manifold-engine-replay-"));
  const browser = new IsolatedBrowser();
  let server: Bun.Server<undefined> | undefined;
  const report: Record<string, unknown> = {
    schema: 1,
    experiment: "isolated-published-browser-engine-replay",
    source: PACKAGES.map((item) => `https://registry.npmjs.org/${item.name}/${item.version}`),
    implementationSources: [
      "https://github.com/coder/ghostty-web/blob/9e4e126d89ac3537d2b2ebec075849851566de9f/lib/terminal.ts",
      "https://unpkg.com/ghostty-web@0.4.0/dist/index.d.ts",
      "https://github.com/xtermjs/xterm.js/tree/f447274f430fd22513f6adbf9862d19524471c04/addons/addon-webgl",
    ],
    environment: {
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      chromium: null,
      gpuMode: "--disable-gpu; explicitly nonrepresentative software/headless experiment",
      physicalPaintMeasured: false,
    },
    callbackCaveat:
      "ghostty-web 0.4.0 lib/terminal.ts:534-574 writes synchronously to WASM, then requestAnimationFrame(callback); its callback timing must not be compared as parser-only latency against xterm's queued parser callback.",
    workload: {
      grids: [
        [80, 24],
        [132, 40],
      ],
      trialsPerGrid: 3,
      maxBytesPerTrial: 32768,
      scrollback: 2000,
      transport:
        "none: no Manifold, PTY, network stream, native Ghostty or production terminal touched",
      input:
        "deterministic UTF-8 bytes; 240 colored scrolling lines then cursor redraw, wide and combining text",
      units: { timing: "milliseconds", payload: "UTF-8 bytes" },
    },
    dependencies: [],
    engines: [],
    errors: [],
    limitations: [
      "Write callbacks and RAF scheduling are not physical paint or identical parser-only spans.",
      "Sequential isolated engine runs, not a concurrent throughput comparison; no warmup or statistical significance claim.",
      "Canvas2D/WASM ghostty-web is not native Ghostty GPU renderer parity.",
      "Pinned xterm and WebGL addon share upstream commit f447274f430fd22513f6adbf9862d19524471c04.",
      "Public buffer text is checked; combining/wide glyph pixels, native IME and assistive technology behavior are not verified.",
      "SRI verification uses hardcoded npm publish integrity, not a publisher-signature/provenance attestation verification.",
    ],
  };
  const errors = report["errors"] as string[];
  try {
    for (const spec of PACKAGES) {
      const basename = spec.name.split("/").at(-1)!;
      const url = `https://registry.npmjs.org/${spec.name}/-/${basename}-${spec.version}.tgz`;
      const bytes = await download(url);
      const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
      if (integrity !== spec.integrity)
        throw new Error(`${spec.name}@${spec.version}: pinned npm integrity mismatch`);
      const archive = join(sandbox, `${spec.directory}.tgz`);
      const destination = join(sandbox, spec.directory);
      await mkdir(destination);
      await Bun.write(archive, bytes);
      const extract = Bun.spawn(
        [
          "tar",
          "-xzf",
          archive,
          "--strip-components=1",
          "--no-same-owner",
          "--no-same-permissions",
          "-C",
          destination,
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      try {
        const stderr = new Response(extract.stderr).text();
        const code = await bounded(extract.exited, 10_000, `extract ${spec.name}`);
        if (code !== 0)
          throw new Error(`extract ${spec.name}: ${code}: ${(await stderr).slice(0, 1500)}`);
      } finally {
        if (extract.exitCode === null) {
          extract.kill("SIGKILL");
          await extract.exited;
        }
      }
      const manifest = (await Bun.file(join(destination, "package.json")).json()) as {
        name?: string;
        version?: string;
      };
      if (manifest.name !== spec.name || manifest.version !== spec.version)
        throw new Error(`${spec.name}: actual manifest mismatch`);
      (report["dependencies"] as unknown[]).push({
        name: manifest.name,
        version: manifest.version,
        url,
        integrity,
        sha256: sha256(bytes),
        archiveBytes: bytes.byteLength,
        installScriptsRun: false,
      });
    }
    const fontPath = resolve(
      import.meta.dir,
      "../packages/plugins/terminals/src/fonts/manifold-terminal-mono.woff2",
    );
    const fontBytes = new Uint8Array(await Bun.file(fontPath).arrayBuffer());
    if (sha256(fontBytes) !== FONT_SHA256)
      throw new Error(
        "Manifold font differs from pinned SHA-256; update research pin deliberately",
      );
    report["font"] = {
      source: "packages/plugins/terminals/src/fonts/manifold-terminal-mono.woff2",
      sha256: FONT_SHA256,
      bytes: fontBytes.length,
    };
    await copyFile(fontPath, join(sandbox, "font.woff2"));
    await copyFile(join(sandbox, "ghostty/ghostty-vt.wasm"), join(sandbox, "ghostty-vt.wasm"));
    const wasm = new Uint8Array(await Bun.file(join(sandbox, "ghostty-vt.wasm")).arrayBuffer());
    report["wasm"] = {
      bytes: wasm.length,
      sha256: sha256(wasm),
      source: "ghostty-web@0.4.0 integrity-verified archive",
    };
    const entry = join(sandbox, "replay.ts");
    await Bun.write(
      entry,
      `import {Terminal as Xterm} from ${JSON.stringify(join(sandbox, "xterm/lib/xterm.mjs"))};\nimport {WebglAddon} from ${JSON.stringify(join(sandbox, "webgl/lib/addon-webgl.mjs"))};\nimport {Terminal as GhostTerminal, Ghostty} from ${JSON.stringify(join(sandbox, "ghostty/dist/ghostty-web.js"))};\n(${replayPage.toString()})(Xterm, WebglAddon, GhostTerminal, Ghostty);\n`,
    );
    const build = await bounded(
      Bun.build({
        entrypoints: [entry],
        outdir: join(sandbox, "page"),
        target: "browser",
        format: "esm",
        minify: false,
      }),
      20_000,
      "isolated Bun bundle",
    );
    if (!build.success) throw new Error(build.logs.map(String).join("\n").slice(0, 2000));
    const bundle = build.outputs.find((output) => output.path.endsWith(".js"));
    if (!bundle) throw new Error("Bun produced no JavaScript entry");
    const bundleBytes = new Uint8Array(await bundle.arrayBuffer());
    report["bundle"] = { bytes: bundleBytes.length, sha256: sha256(bundleBytes) };
    const html =
      '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/xterm.css"><style>body{background:#0b0d10;color:#d8dee9;margin:16px}#terminal{position:relative;width:1500px;height:940px}</style><div id="terminal"></div><script type="module" src="/replay.js"></script>';
    const assets: Record<string, { path: string; type: string }> = {
      "/replay.js": { path: bundle.path, type: "text/javascript" },
      "/font.woff2": { path: join(sandbox, "font.woff2"), type: "font/woff2" },
      "/xterm.css": { path: join(sandbox, "xterm/css/xterm.css"), type: "text/css" },
      "/ghostty-vt.wasm": { path: join(sandbox, "ghostty-vt.wasm"), type: "application/wasm" },
    };
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/") return new Response(html, { headers: { "Content-Type": "text/html" } });
        const asset = Object.hasOwn(assets, path) ? assets[path] : undefined;
        return asset
          ? new Response(Bun.file(asset.path), { headers: { "Content-Type": asset.type } })
          : new Response("Not found", { status: 404 });
      },
    });
    await browser.launch(join(sandbox, "chromium-profile"));
    (report["environment"] as Record<string, unknown>)["chromium"] =
      await browser.send("Browser.getVersion");
    for (const kind of ["xterm-dom", "xterm-webgl2", "ghostty-canvas2d"]) {
      const engine: Record<string, unknown> = { kind, grids: [], errors: [] };
      (report["engines"] as unknown[]).push(engine);
      try {
        // Fresh document also removes all engine-owned listeners, WASM and font state.
        await browser.send("Page.navigate", {
          url: `http://127.0.0.1:${server.port}/?engine=${kind}`,
        });
        const deadline = Date.now() + 10_000;
        let ready = false;
        while (Date.now() < deadline) {
          ready =
            (await browser.evaluate(
              `location.search === ${JSON.stringify(`?engine=${kind}`)} && typeof window.engineReplay !== 'undefined'`,
            )) === true;
          if (ready) break;
          await sleep(50);
        }
        if (!ready) throw new Error("isolated bundle not ready after 10000ms");
        engine["setup"] = await browser.evaluate(
          `window.engineReplay.setup(${JSON.stringify(kind)})`,
        );
        for (const [cols, rows] of [
          [80, 24],
          [132, 40],
        ]) {
          (engine["grids"] as unknown[]).push(
            await browser.evaluate(`window.engineReplay.grid(${cols},${rows})`),
          );
          if (keep) {
            const screenshot = await browser.send("Page.captureScreenshot", { format: "png" });
            await Bun.write(
              join(sandbox, `${kind}-${cols}x${rows}.png`),
              Buffer.from(String(screenshot["data"]), "base64"),
            );
          }
        }
      } catch (error) {
        (engine["errors"] as string[]).push(describe(error));
      } finally {
        try {
          engine["teardown"] = await browser.evaluate("window.engineReplay?.finish()");
        } catch (error) {
          (engine["errors"] as string[]).push(`teardown: ${describe(error)}`);
        }
      }
    }
    report["pageExceptions"] = browser.messages;
  } catch (error) {
    errors.push(describe(error));
  } finally {
    try {
      await browser.close();
    } catch (error) {
      errors.push(`browser cleanup: ${describe(error)}`);
    }
    try {
      await server?.stop(true);
    } catch (error) {
      errors.push(`server cleanup: ${describe(error)}`);
    }
    // Profiles are never retained, even when keeping experiment screenshots/bundles.
    try {
      await rm(join(sandbox, "chromium-profile"), { recursive: true, force: true });
      if (keep) {
        report["artifactDirectory"] = sandbox;
        await Bun.write(join(sandbox, "report.json"), JSON.stringify(report, null, 2));
      } else await rm(sandbox, { recursive: true, force: true });
    } catch (error) {
      errors.push(`file cleanup: ${describe(error)}`);
    }
    console.log(JSON.stringify(report, null, 2));
  }
}
await main();
