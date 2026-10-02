/**
 * manifold terminal-selection regression gate.
 *
 * Guards the xterm pointer-coordinate boundary inside a scaled canvas node:
 * with any ancestor CSS transform (canvas zoom ≠ 1), xterm's mouse→cell
 * math in `getCoords` divides post-transform `getBoundingClientRect()` offsets by
 * unscaled cell dimensions, so painted selection drifts downward proportionally to
 * distance from the terminal origin ("the more down I go, the greater the offset").
 *
 * The gate drives a REAL browser drag over known rows at zoom 1 (baseline) and at
 * canvas zoom ≈ 1.2. Default selection stays painted without touching the clipboard;
 * opting in through plugin settings copies and clears only after release. Selection
 * must never clear mid-drag, and its painted row must match the pointer at every zoom.
 *
 * Issue #878 adds an explicitly selected renderer, not a new terminal/PTY. After
 * the unchanged DOM gesture proofs, this gate checks real SwiftShader pixels,
 * Unicode selection, renderer retirement, context-loss/refusal fallback, and
 * retained history/input. Software-only evidence is not native GPU performance.
 *
 * Self-contained: builds the web bundle to a temp dir, spawns its own server + agent,
 * cleans up. Env: MANIFOLD_CHROMIUM (else system chromium).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingRefId } from "../packages/plugin/src/index.ts";
import { ActionOutcomeSchema, ContainerResponseSchema } from "../packages/protocol/src/index.ts";
import { resolveWebDist } from "./gate-dist.ts";
import { Browser } from "./cdp.ts";
import { ownerKeyOf, reserveLoopbackPort, teardownServer, until } from "./gate-lib.ts";

const repoRoot = join(import.meta.dir, "..");
const { distDir, cleanup: cleanupDist } = resolveWebDist("manifold-sel-");
const dataDir = mkdtempSync(join(tmpdir(), "manifold-sel-data-"));
const port = reserveLoopbackPort();
const origin = `http://127.0.0.1:${String(port)}`;

const server = Bun.spawn(["bun", "packages/server/src/main.ts"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    MANIFOLD_PORT: String(port),
    MANIFOLD_DATA_DIR: dataDir,
    MANIFOLD_WEB_DIST: distDir,
    MANIFOLD_SPAWN_AGENT: "1",
  },
  // Server boot log prints the owner-key URL: NEVER inherit it into gate logs
  // (secrets discipline, docs/CONTRACTS.md §Data and credential boundaries).
  stdout: "ignore",
  stderr: "inherit",
});

const failures: string[] = [];
let browser: Browser | null = null;
let wheelFixtureStarted = false;
const rendererWire = { opened: 0, closed: 0, attached: 0, detached: 0, snapshots: 0 };
const rendererScripts = new Set<string>();
const rendererFinished = new Set<string>();

try {
  await until(
    async () => {
      try {
        return (await fetch(`${origin}/healthz`)).ok;
      } catch {
        return false;
      }
    },
    20_000,
    "local server healthz",
  );
  const ownerKey = await ownerKeyOf(dataDir);
  const httpHeaders = { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" };

  const created = await fetch(`${origin}/api/actions/core.index.createContainer`, {
    method: "POST",
    headers: httpHeaders,
    body: JSON.stringify({ name: "terminal-selection-gate" }),
  });
  const outcome = ActionOutcomeSchema.parse(await created.json());
  if (!outcome.ok) throw new Error(`createContainer refused: ${outcome.denial.message}`);
  const containerId = ContainerResponseSchema.parse(outcome.result).container.id;

  browser = new Browser();
  await browser.launch({ softwareWebgl: true });
  await browser.send("Network.enable", {});
  browser.on("Network.webSocketCreated", () => rendererWire.opened++);
  browser.on("Network.webSocketClosed", () => rendererWire.closed++);
  for (const [event, direction] of [
    ["Network.webSocketFrameSent", "out"],
    ["Network.webSocketFrameReceived", "in"],
  ] as const) {
    browser.on(event, (params) => {
      const response = params["response"] as { payloadData?: string; opcode?: number } | undefined;
      if (response?.opcode !== 1 || response.payloadData === undefined) return;
      let message: { type?: string };
      try {
        message = JSON.parse(response.payloadData) as { type?: string };
      } catch {
        return;
      }
      if (message === null || typeof message !== "object") return;
      if (direction === "out" && message.type === "terminal_attach") rendererWire.attached++;
      if (direction === "out" && message.type === "terminal_detach") rendererWire.detached++;
      if (direction === "in" && message.type === "terminal_snapshot") rendererWire.snapshots++;
    });
  }
  browser.on("Network.requestWillBeSent", (params) => {
    const request = params["request"] as { url?: string } | undefined;
    if (params["type"] === "Script" && request?.url !== undefined) rendererScripts.add(request.url);
  });
  browser.on("Network.loadingFinished", (params) => {
    if (typeof params["requestId"] === "string") rendererFinished.add(params["requestId"]);
  });
  await browser.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      const proof = window.__terminalWebglProof = {
        attempts: 0, refused: 0, refuse: false, refuseShaders: false,
        shaderRefusals: 0, contexts: []
      };
      HTMLCanvasElement.prototype.getContext = function(kind, ...args) {
        const webgl = kind === 'webgl2' || kind === 'webgl' || kind === 'experimental-webgl';
        if (webgl) {
          proof.attempts++;
          if (proof.refuse) { proof.refused++; return null; }
        }
        const context = Reflect.apply(original, this, [kind, ...args]);
        if (webgl && context && !proof.contexts.some(entry => entry.gl === context))
          proof.contexts.push({ canvas: this, gl: context });
        return context;
      };
      const shaderParameter = WebGL2RenderingContext.prototype.getShaderParameter;
      WebGL2RenderingContext.prototype.getShaderParameter = function(shader, parameter) {
        if (proof.refuseShaders && parameter === this.COMPILE_STATUS) {
          proof.shaderRefusals++;
          return false;
        }
        return Reflect.apply(shaderParameter, this, [shader, parameter]);
      };
    })()`,
  });
  await browser.send("Browser.grantPermissions", {
    origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  await browser.goto(`${origin}/#key=${ownerKey}`);
  await browser.evaluate("localStorage.setItem('manifold:debug', '1')");
  if (await browser.evaluate<boolean>("document.querySelector('input') !== null")) {
    await browser.typeInto("input", "sel-gate");
    await browser.clickTestId("identity-enter");
  }
  await browser.goto(`${origin}/p/${containerId}`);
  await until(
    () => browser!.evaluate<boolean>("window.__manifold !== undefined"),
    20_000,
    "debug probe installed",
  );

  // Create a terminal directly from an online machine row in the sidebar.
  await browser.evaluate(
    "document.querySelector('[data-testid=machines-section] button[aria-expanded]').click()",
  );
  await until(
    () =>
      browser!.evaluate<boolean>(
        "document.querySelector('[aria-label^=\"New terminal on \"]') !== null",
      ),
    20_000,
    "online machine terminal action",
  );
  await browser.evaluate("document.querySelector('[aria-label^=\"New terminal on \"]').click()");
  await until(
    () => browser!.evaluate<boolean>("document.querySelector('.xterm-rows') !== null"),
    20_000,
    "xterm rendered",
  );
  if (
    !(await browser.evaluate<boolean>(`(() => {
      const host = document.querySelector('.xterm-host');
      const toggle = document.querySelector('[data-testid="terminal-renderer-toggle"]');
      return host?.dataset.terminalRenderer === 'dom'
        && toggle?.getAttribute('aria-pressed') === 'false'
        && window.__terminalWebglProof.attempts === 0;
    })()`))
  ) {
    throw new Error("a fresh device must use DOM without attempting a WebGL context");
  }
  // DOM-rendered rows can lie below the browser's viewport: native-scale terminals
  // are no longer shrunk into their portal. Move the canvas only when measured
  // clipping proves it necessary; never substitute easier rows for the fixed probes.
  async function revealScreen(): Promise<void> {
    const pan = await browser!.evaluate<{
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      screen: { left: number; top: number; right: number; bottom: number };
      visible: { left: number; top: number; right: number; bottom: number };
    } | null>(`(() => {
      const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
      const canvas = document.querySelector('.canvas').getBoundingClientRect();
      const visible = {
        left: Math.max(0, canvas.left) + 20,
        top: Math.max(0, canvas.top) + 20,
        right: Math.min(innerWidth, canvas.right) - 20,
        bottom: Math.min(innerHeight, canvas.bottom) - 20,
      };
      if (screen.width > visible.right - visible.left || screen.height > visible.bottom - visible.top)
        throw new Error('the native terminal does not fit the selection gate viewport');
      const deltaX = screen.left < visible.left || screen.right > visible.right
        ? (screen.left + screen.right - visible.left - visible.right) / 2 : 0;
      const deltaY = screen.top < visible.top || screen.bottom > visible.bottom
        ? (screen.top + screen.bottom - visible.top - visible.bottom) / 2 : 0;
      if (deltaX === 0 && deltaY === 0) return null;
      for (const x of [visible.left, visible.right]) {
        for (const y of [visible.top, visible.bottom]) {
          if (!document.elementFromPoint(x, y)?.matches('.react-flow__pane')) continue;
          return {
            x, y, deltaX, deltaY,
            screen: { left: screen.left, top: screen.top, right: screen.right, bottom: screen.bottom },
            visible,
          };
        }
      }
      throw new Error('no exposed canvas point for revealing the clipped terminal');
    })()`);
    if (pan === null) return;
    console.log("revealing clipped terminal:", JSON.stringify(pan));
    await browser!.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: pan.x,
      y: pan.y,
      // Canvas uses React Flow's default panOnScrollSpeed of 0.5.
      deltaX: pan.deltaX / 0.5,
      deltaY: pan.deltaY / 0.5,
    });
    await until(
      () =>
        browser!.evaluate<boolean>(`(() => {
          const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
          return screen.left >= ${pan.visible.left} && screen.top >= ${pan.visible.top}
            && screen.right <= ${pan.visible.right} && screen.bottom <= ${pan.visible.bottom};
        })()`),
      20_000,
      "terminal screen inside the visible canvas after pan",
    );
  }

  // Activate the embed (click-to-focus model), then focus xterm itself.
  await browser.evaluate(`(() => {
    const r = document.querySelector('.terminal-frame').getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const o = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  })()`);
  await until(
    () =>
      browser!.evaluate<boolean>(
        "document.querySelector('.portal--engaged .terminal-idle-veil:not(.terminal-idle-veil--on)') !== null",
      ),
    20_000,
    "terminal occupant socket activated",
  );
  const screenBox = await browser.evaluate<{ x: number; y: number }>(
    "(() => { const s = document.querySelector('.xterm-screen').getBoundingClientRect(); return { x: s.x + s.width / 2, y: s.y + s.height / 2 }; })()",
  );
  // Real CDP click to give the hidden textarea focus, then load known content.
  await browser.drag([screenBox], 30);
  await until(
    () =>
      browser!.evaluate<boolean>(
        "document.activeElement?.matches('.xterm-helper-textarea') === true",
      ),
    20_000,
    "xterm textarea focused",
  );
  const completionNonce = crypto.randomUUID();
  const completionSentinel = `TERMINAL-SELECTION-COMPLETE-${completionNonce}`;
  await browser.typeText(
    `clear; seq 1 40 | sed 's/.*/ROW-& selection clipboard target/'; printf '%s%s\\n' 'TERMINAL-SELECTION-COMPLETE-' '${completionNonce}'`,
  );
  await browser.typeText("\r");
  await until(
    () =>
      browser!.evaluate<boolean>(
        `(() => {
          const painted = document.querySelector('.xterm-rows').textContent || '';
          return painted.includes('ROW-40 selection clipboard target') &&
            painted.includes(${JSON.stringify(completionSentinel)});
        })()`,
      ),
    20_000,
    "known terminal output through row 40 and explicit completion sentinel painted",
  );
  await revealScreen();

  async function setGesturePreference(setting: string, value: boolean): Promise<void> {
    await browser!.clickTestId("plugin-manager-open");
    await until(
      () =>
        browser!.evaluate<boolean>(
          "document.querySelector('[data-plugin=\"core.terminals\"]') !== null",
        ),
      3000,
      "terminal plugin settings available",
    );
    await browser!.evaluate(
      'document.querySelector(\'[data-plugin="core.terminals"] [data-testid="plugin-manager-row-open"]\').click()',
    );
    const selector = `[data-setting="${settingRefId("core.terminals", setting)}"]`;
    await until(
      () =>
        browser!.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}) !== null`),
      3000,
      `declared ${setting} preference`,
    );
    const checked = await browser!.evaluate<string>(
      `document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-checked')`,
    );
    if (checked !== String(value)) {
      await browser!.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    }
    await until(
      () =>
        browser!.evaluate<boolean>(
          `(() => { const toggle = document.querySelector(${JSON.stringify(selector)}); return toggle?.getAttribute('aria-checked') === ${JSON.stringify(String(value))} && !toggle.disabled; })()`,
        ),
      3000,
      `${setting} preference committed`,
    );
    await browser!.evaluate(
      "document.querySelector('[aria-label=\"Close the plugin manager\"]').click()",
    );
    await browser!.evaluate("document.querySelector('.xterm-helper-textarea').focus()");
  }

  async function dragAndPaint(
    rowIndex: number,
    autoCopy: boolean,
  ): Promise<{
    draggedOn: string;
    paintedRows: string[];
    zoom: number;
    copied: string;
    cleared: boolean;
  }> {
    const info = await browser!.evaluate<{ top: number; h: number; text: string }[]>(
      "[...document.querySelector('.xterm-rows').querySelectorAll(':scope > div')].map(d => { const r = d.getBoundingClientRect(); return { top: r.top, h: r.height, text: d.textContent.trim() }; })",
    );
    const row = info[rowIndex];
    if (row === undefined) throw new Error(`row index ${rowIndex} not rendered`);
    const sx = await browser!.evaluate<number>(
      "document.querySelector('.xterm-screen').getBoundingClientRect().x + 2",
    );
    const yc = row.top + row.h * 0.5;
    const hits = await browser!.evaluate<boolean>(
      `(() => {
        const screen = document.querySelector('.xterm-screen');
        return ${JSON.stringify([350, 280, 210, 140, 0])}.every(offset => {
          const hit = document.elementFromPoint(${sx} + offset, ${yc});
          return hit !== null && screen.contains(hit);
        });
      })()`,
    );
    if (!hits)
      throw new Error(`row ${rowIndex} ("${row.text}") is not pointer-reachable at y=${yc}`);
    // Clear the preceding selection through real input, so old paint cannot satisfy
    // this drag's readiness check. Keep geometry assertions separate from readiness:
    // painting the wrong row must still fail, not wait for a more convenient result.
    await browser!.drag([{ x: sx + 250, y: yc }], 40);
    await until(
      () =>
        browser!.evaluate<boolean>(
          "(document.querySelector('.xterm-selection')?.childElementCount ?? 0) === 0",
        ),
      20_000,
      `previous selection cleared before row ${rowIndex}`,
    );
    await browser!.evaluate("navigator.clipboard.writeText('selection gate sentinel')");
    await browser!.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: sx + 350,
      y: yc,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    for (const offset of [280, 210, 140, 0]) {
      await browser!.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: sx + offset,
        y: yc,
        button: "left",
        buttons: 1,
      });
      await Bun.sleep(40);
    }
    await until(
      () =>
        browser!.evaluate<boolean>(
          "[...(document.querySelector('.xterm-selection')?.children ?? [])].some(band => { const rect = band.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; })",
        ),
      20_000,
      `selection paint after dragging row ${rowIndex} ("${row.text}")`,
    );
    const bands = await browser!.evaluate<{ top: number; bottom: number }[]>(
      "[...(document.querySelector('.xterm-selection') ?? { children: [] }).children].map(d => { const b = d.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; })",
    );
    const painted = info
      .map((r) => ({ text: r.text, y: r.top + r.h * 0.5 }))
      .filter((r) => bands.some((b) => r.y >= b.top && r.y <= b.bottom))
      .map((r) => r.text);
    const zoom = await browser!.evaluate<number>("window.__manifold.viewport().zoom");
    const duringDrag = await browser!.evaluate<string>("navigator.clipboard.readText()");
    if (duringDrag !== "selection gate sentinel")
      throw new Error("clipboard changed before selection drag completed");
    await browser!.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: sx,
      y: yc,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    if (autoCopy) {
      await until(
        () =>
          browser!.evaluate<boolean>(
            "navigator.clipboard.readText().then(text => text !== 'selection gate sentinel')",
          ),
        3000,
        "completed selection copied to clipboard",
      );
    } else {
      await Bun.sleep(150);
    }
    const copied = await browser!.evaluate<string>("navigator.clipboard.readText()");
    await Bun.sleep(100);
    const cleared = await browser!.evaluate<boolean>(
      "(document.querySelector('.xterm-selection')?.children.length ?? 0) === 0",
    );
    return { draggedOn: row.text, paintedRows: painted, zoom, copied, cleared };
  }

  async function assertRow(name: string, rowIndex: number, autoCopy: boolean): Promise<void> {
    const result = await dragAndPaint(rowIndex, autoCopy);
    const ok =
      result.paintedRows.length === 1 &&
      result.paintedRows[0] === result.draggedOn &&
      result.copied === (autoCopy ? result.draggedOn : "selection gate sentinel") &&
      result.cleared === autoCopy;
    const detail = `dragged on rendered row #${rowIndex} ("${result.draggedOn}") at zoom ${result.zoom.toFixed(2)}, painted [${result.paintedRows.join(", ")}], copied ${JSON.stringify(result.copied)}, cleared ${result.cleared}`;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
    if (!ok) failures.push(`${name}: ${detail}`);
  }

  // Baseline at zoom 1: must always pass.
  const baselineZoom = await browser.evaluate<number>("window.__manifold.viewport().zoom");
  if (Math.abs(baselineZoom - 1) >= 0.06)
    throw new Error(`baseline canvas zoom is not 1 (got ${baselineZoom})`);
  for (const rowIndex of [2, 12, 24])
    await assertRow("default selection stays highlighted without copying", rowIndex, false);
  await setGesturePreference("copy-on-select", true);

  // Zoom through the canvas's real pinch interaction: trackpad pinches arrive as
  // ctrl+wheel (modifiers bit 2), which is the only wheel gesture that zooms now —
  // plain two-finger scroll pans (Excalidraw convention).
  const zoomPoint = await browser.evaluate<{ readonly x: number; readonly y: number }>(
    `(() => {
      const rect = document.querySelector('.canvas').getBoundingClientRect();
      return { x: rect.right - 80, y: rect.bottom - 80 };
    })()`,
  );
  for (let i = 0; i < 10; i++) {
    const z = await browser.evaluate<number>("window.__manifold.viewport().zoom");
    if (z >= 1.15 && z <= 1.3) break;
    await browser.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...zoomPoint,
      modifiers: 2,
      deltaX: 0,
      deltaY: z > 1.3 ? 80 : -80,
    });
    await until(
      () =>
        browser!.evaluate<boolean>(`window.__manifold.viewport().zoom ${z > 1.3 ? "<" : ">"} ${z}`),
      20_000,
      `canvas zoom ${z > 1.3 ? "decreased" : "increased"} from ${z} after pinch`,
    );
  }
  const zoomNow = await browser.evaluate<number>("window.__manifold.viewport().zoom");
  if (zoomNow < 1.1 || zoomNow > 1.35)
    throw new Error(`could not reach zoom ~1.2 (got ${zoomNow})`);
  console.log(
    "scale diagnostics:",
    await browser.evaluate<string>(
      `(() => {
        const s = document.querySelector('.xterm-screen');
        const r = s.getBoundingClientRect();
        const chain = [];
        let el = s;
        while (el && el !== document.body) {
          const t = getComputedStyle(el).transform;
          if (t && t !== 'none') chain.push({ cls: String(el.className).slice(0,60), t });
          el = el.parentElement;
        }
        return JSON.stringify({ rectW: +r.width.toFixed(2), layoutW: s.clientWidth, ratioX: +(r.width/s.clientWidth).toFixed(4), rectH: +r.height.toFixed(2), layoutH: s.clientHeight, ratioY: +(r.height/s.clientHeight).toFixed(4), chain });
      })()`,
    ),
  );

  await revealScreen();

  // THE REGRESSION: drift grows with distance from the terminal origin.
  for (const rowIndex of [2, 8, 14, 20])
    await assertRow(`opt-in copy selects the dragged row on zoomed canvas`, rowIndex, true);

  // Restore baseline sanity after zooming back out through the same real input path.
  for (let i = 0; i < 12; i++) {
    const z = await browser.evaluate<number>("window.__manifold.viewport().zoom");
    if (Math.abs(z - 1) < 0.06) break;
    await browser.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...zoomPoint,
      modifiers: 2,
      deltaX: 0,
      deltaY: z > 1 ? 80 : -80,
    });
    await until(
      () =>
        browser!.evaluate<boolean>(`window.__manifold.viewport().zoom ${z > 1 ? "<" : ">"} ${z}`),
      20_000,
      `canvas zoom ${z > 1 ? "decreased" : "increased"} from ${z} while restoring baseline`,
    );
  }
  const restoredZoom = await browser.evaluate<number>("window.__manifold.viewport().zoom");
  if (Math.abs(restoredZoom - 1) >= 0.06)
    throw new Error(`could not restore canvas zoom to 1 (got ${restoredZoom})`);
  await revealScreen();
  await assertRow("opt-in copy after zoom restored to 1", 12, true);
  await setGesturePreference("copy-on-select", false);
  await assertRow("disabling automatic copy preserves selection again", 12, false);

  // URL activation is intentionally modified-click only: ordinary clicks keep
  // terminal focus/selection semantics, while Ctrl+click opens an external tab.
  await browser.typeText("printf '\\nhttps://example.com/manifold-terminal-link\\n'");
  await browser.typeText("\r");
  await until(
    () =>
      browser!.evaluate<boolean>(
        "[...document.querySelector('.xterm-rows').children].some(row => row.textContent.trim() === 'https://example.com/manifold-terminal-link')",
      ),
    3000,
    "terminal URL rendered",
  );
  const linkPoint = await browser.evaluate<{ x: number; y: number }>(`(() => {
    window.__terminalOpenedUrl = null;
    window.open = (url, target, features) => {
      window.__terminalOpenedUrl = { url: String(url), target, features };
      return null;
    };
    const wanted = 'https://example.com/manifold-terminal-link';
    const row = [...document.querySelector('.xterm-rows').children]
      .find(candidate => candidate.textContent.trim() === wanted);
    if (!row) throw new Error('terminal URL row disappeared');
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const index = node.data.indexOf(wanted);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index + 4);
      range.setEnd(node, index + 5);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    throw new Error('terminal URL text node disappeared');
  })()`);
  await browser.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    ...linkPoint,
    button: "none",
    buttons: 0,
  });
  await Bun.sleep(200);
  await browser.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...linkPoint,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await browser.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...linkPoint,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  if ((await browser.evaluate("window.__terminalOpenedUrl")) !== null) {
    failures.push("plain terminal URL click unexpectedly opened a tab");
  }
  await browser.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...linkPoint,
    modifiers: 2,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await browser.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...linkPoint,
    modifiers: 2,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  const opened = await browser.evaluate<{
    url: string;
    target: string;
    features: string;
  } | null>("window.__terminalOpenedUrl");
  if (
    opened?.url !== "https://example.com/manifold-terminal-link" ||
    opened.target !== "_blank" ||
    opened.features !== "noopener,noreferrer"
  ) {
    failures.push(`Ctrl+click terminal URL activation mismatch: ${JSON.stringify(opened)}`);
  } else {
    console.log("PASS  Ctrl+click opens terminal URLs in an isolated external tab");
  }

  // The other terminal mount site must consume the same principal preferences.
  await browser.evaluate(
    "document.querySelector('[aria-label=\"Expand terminal to full view\"]').click()",
  );
  await until(
    () =>
      browser!.evaluate<boolean>(
        "document.querySelector('[aria-label=\"Shrink view\"]') !== null && document.querySelector('.xterm-rows')?.textContent.includes('https://example.com/manifold-terminal-link') === true",
      ),
    20_000,
    "fullscreen terminal replayed the existing session",
  );

  // Read the real browser clipboard with a real right click, then observe PTY
  // output that cannot be confused with the echoed command itself.
  await browser.evaluate(`navigator.clipboard.writeText("printf 'PASTE-%s\\\\n' ARRIVED")`);
  const pastePoint = await browser.evaluate<{ x: number; y: number }>(
    "(() => { const r = document.querySelector('.xterm-screen').getBoundingClientRect(); return { x: r.x + 80, y: r.y + 40 }; })()",
  );
  await browser.evaluate(`document.addEventListener('contextmenu', event => {
    if (event.target instanceof Element && event.target.closest('.xterm-host'))
      queueMicrotask(() => { window.__terminalContextMenuPrevented = event.defaultPrevented; });
  }, true)`);
  await browser.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...pastePoint,
    button: "right",
    buttons: 2,
    clickCount: 1,
  });
  await browser.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...pastePoint,
    button: "right",
    buttons: 0,
    clickCount: 1,
  });
  await Bun.sleep(150);
  if (
    await browser.evaluate<boolean>(
      "document.querySelector('.xterm-rows').textContent.includes(\"printf 'PASTE-%s\") || window.__terminalContextMenuPrevented !== false",
    )
  ) {
    throw new Error("default right-click pasted text or suppressed the normal context menu");
  }
  console.log("PASS  default right-click preserves the context menu without pasting");
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await setGesturePreference("paste-on-right-click", true);
  await browser.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...pastePoint,
    button: "right",
    buttons: 2,
    clickCount: 1,
  });
  await browser.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...pastePoint,
    button: "right",
    buttons: 0,
    clickCount: 1,
  });
  await until(
    () =>
      browser!.evaluate<boolean>(
        "document.querySelector('.xterm-rows').textContent.includes(\"printf 'PASTE-%s\")",
      ),
    3000,
    "right-click clipboard text reaches the terminal",
  );
  await browser.typeText("\r");
  await until(
    () =>
      browser!.evaluate<boolean>(
        "[...document.querySelector('.xterm-rows').children].some(row => row.textContent.trim() === 'PASTE-ARRIVED')",
      ),
    3000,
    "pasted command executes through PTY input",
  );
  console.log("PASS  right-click reads the clipboard and pastes through PTY input");
  await browser.evaluate("document.querySelector('[aria-label=\"Shrink view\"]').click()");
  await until(
    () =>
      browser!.evaluate<boolean>(
        "document.querySelector('.canvas') !== null && document.querySelector('.xterm-rows') !== null",
      ),
    20_000,
    "return from fullscreen to canvas",
  );

  // A trackpad's two-finger travel is an ordinary pixel wheel with both deltas.
  // Hovering an unengaged terminal must not hand that event to xterm's scrollbar.
  // Snapshot replay and authoritative resizing can change row text without scrolling.
  // The visible scrollbar distinguishes that repaint from leaving the bottom boundary.
  const scrollbackBottomGap = () =>
    browser!.evaluate<number | null>(`(() => {
      const slider=document.querySelector('.xterm .scrollbar.vertical .slider');
      if(slider===null)return null;
      const thumb=slider.getBoundingClientRect(),track=slider.parentElement.getBoundingClientRect();
      if(thumb.height<=0||track.height-thumb.height<=1)return null;
      return track.bottom-thumb.bottom;
    })()`);
  const viewport = () =>
    browser!.evaluate<{ scrollX: number; scrollY: number; zoom: number }>(
      "window.__manifold.viewport()",
    );
  const terminalPoint = () =>
    browser!.evaluate<{ x: number; y: number }>(`(() => {
    const r=document.querySelector('.xterm-screen').getBoundingClientRect();
    const canvas=document.querySelector('.canvas').getBoundingClientRect();
    const left=Math.max(r.left,canvas.left,0)+20,right=Math.min(r.right,canvas.right,innerWidth)-20;
    const top=Math.max(r.top,canvas.top,0)+20,bottom=Math.min(r.bottom,canvas.bottom,innerHeight)-20;
    if(right<=left||bottom<=top)throw new Error('terminal has no visible wheel target');
    return {x:(left+right)/2,y:(top+bottom)/2};
  })()`);

  // Focus is not input readiness: returning to canvas creates a spectator, and a
  // click focuses xterm before the occupant join finishes. typeText only awaits
  // browser key dispatch; it cannot acknowledge the terminal's read-only guard.
  // Wait for the existing engaged/active signals before sending any seed bytes,
  // and for the replayed prompt and fitted row geometry before counting screens.
  wheelFixtureStarted = true;
  await browser.drag([await terminalPoint()], 30);
  await until(
    () =>
      browser!.evaluate<boolean>(`(() => {
        const host = document.querySelector('.portal--engaged .xterm-host:not(.xterm-host--inactive)');
        if (!host?.contains(document.activeElement)
          || !document.activeElement?.matches('.xterm-helper-textarea')) return false;
        const rows = host.querySelector('.xterm-rows');
        const screen = host.querySelector('.xterm-screen');
        if (!rows?.firstElementChild || !screen) return false;
        const text = [...rows.children].map(row => row.textContent.trim());
        const pasted = text.indexOf('PASTE-ARRIVED');
        const remaining = host.getBoundingClientRect().height - screen.getBoundingClientRect().height;
        const rowHeight = rows.firstElementChild.getBoundingClientRect().height;
        return pasted >= 0 && text.slice(pasted + 1).some(row => row.length > 0)
          && rowHeight > 0 && remaining >= -1 && remaining < rowHeight;
      })()`),
    5000,
    "canvas occupant input, replayed shell prompt and fitted terminal rows ready",
  );
  // Three fitted screens create fresh history; the output row and returned prompt
  // below prove the seed finished before either wheel boundary is exercised.
  const wheelRowCount = await browser.evaluate<number>(
    "document.querySelector('.xterm-rows').childElementCount * 3",
  );
  // A per-seed marker cannot be satisfied by snapshot replay or command echo:
  // sed expands '&' to the row number only in the command's actual output.
  const wheelMarker = `WHEEL-${crypto.randomUUID().slice(0, 8)}`;
  await browser.typeText(
    `clear; seq 1 ${wheelRowCount} | sed 's/.*/${wheelMarker}-& scrollback target/'`,
  );
  await browser.typeText("\r");
  await until(
    () =>
      browser!.evaluate<boolean>(`(() => {
        const rows = [...document.querySelector('.xterm-rows').children].map(row => row.textContent.trim());
        const last = rows.indexOf('${wheelMarker}-${wheelRowCount} scrollback target');
        return last >= 0 && rows.slice(last + 1).some(text => text.length > 0);
      })()`),
    5000,
    "fresh wheel scrollback output and returned shell prompt painted",
  );
  const blankPoint = await browser.evaluate<{ x: number; y: number }>(`(() => {
    const r=document.querySelector('.canvas').getBoundingClientRect();
    for(let y=r.bottom-30;y>r.top+30;y-=40)for(let x=r.right-30;x>r.left+30;x-=40){
      if(document.elementFromPoint(x,y)?.matches('.react-flow__pane'))return {x,y};
    }
    throw new Error('no blank canvas point');
  })()`);
  for (const type of ["mousePressed", "mouseReleased"])
    await browser.send("Input.dispatchMouseEvent", {
      type,
      ...blankPoint,
      button: "left",
      clickCount: 1,
    });
  await until(
    () =>
      browser!.evaluate<boolean>(
        "document.querySelector('.portal--engaged,.portal--engaging') === null",
      ),
    5000,
    "blank-canvas click disengages terminal",
  );
  await until(
    async () => {
      const gap = await scrollbackBottomGap();
      return gap !== null && Math.abs(gap) < 1;
    },
    5000,
    "terminal rendered at a nonempty scrollback bottom",
  );
  const beforeTravel = await viewport();
  await browser.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    ...(await terminalPoint()),
    deltaX: 45,
    deltaY: -60,
  });
  await browser.evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  await until(
    async () => {
      const v = await viewport();
      return v.scrollX !== beforeTravel.scrollX || v.scrollY !== beforeTravel.scrollY;
    },
    5000,
    "trackpad travel over inactive terminal",
  );
  let afterTravelGap: number | null = null;
  await until(
    async () => {
      afterTravelGap = await scrollbackBottomGap();
      return afterTravelGap !== null;
    },
    5000,
    "terminal scrollback rendered after canvas travel",
  );
  const afterTravel = await viewport();
  if (Math.abs(afterTravel.zoom - beforeTravel.zoom) > 0.001)
    throw new Error("inactive trackpad travel zoomed canvas");
  if (afterTravelGap === null || Math.abs(afterTravelGap) >= 1)
    throw new Error(
      `inactive trackpad travel moved terminal scrollback (${String(afterTravelGap)}px from bottom)`,
    );
  console.log("PASS  trackpad pan crosses inactive terminal without changing its scrollback");
  await browser.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    ...(await terminalPoint()),
    modifiers: 2,
    deltaX: 0,
    deltaY: -40,
  });
  await until(
    async () => (await viewport()).zoom > afterTravel.zoom,
    5000,
    "pinch over inactive terminal",
  );
  console.log("PASS  pinch over inactive terminal reaches canvas zoom");
  for (const type of ["mousePressed", "mouseReleased"])
    await browser.send("Input.dispatchMouseEvent", {
      type,
      ...(await terminalPoint()),
      button: "left",
      clickCount: 1,
    });
  await until(
    () =>
      browser!.evaluate<boolean>(
        "document.activeElement?.matches('.xterm-helper-textarea') === true",
      ),
    5000,
    "single click engages terminal keyboard",
  );
  // Pinch animation can continue after its first visible zoom change and focus.
  // Measure the next gesture only after that preceding gesture has settled.
  let previousViewport = await viewport();
  let stableFrames = 0;
  await until(
    async () => {
      const current = await viewport();
      stableFrames =
        JSON.stringify(current) === JSON.stringify(previousViewport) ? stableFrames + 1 : 0;
      previousViewport = current;
      return stableFrames >= 3;
    },
    5000,
    "preceding pinch animation settled",
  );
  await until(
    async () => {
      const gap = await scrollbackBottomGap();
      return gap !== null && Math.abs(gap) < 1;
    },
    5000,
    "engaged terminal starts at the scrollback bottom",
  );
  const beforeScroll = await viewport();
  await browser.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    ...(await terminalPoint()),
    deltaX: 0,
    deltaY: -120,
  });
  await until(
    async () => {
      const gap = await scrollbackBottomGap();
      return gap !== null && gap >= 1;
    },
    5000,
    "engaged terminal scrollback",
  );
  const afterScroll = await viewport();
  if (
    afterScroll.scrollX !== beforeScroll.scrollX ||
    afterScroll.scrollY !== beforeScroll.scrollY ||
    afterScroll.zoom !== beforeScroll.zoom
  )
    throw new Error("engaged terminal scrollback moved the canvas");
  console.log("PASS  engaged terminal keeps ordinary scrollback without panning canvas");

  // Renderer changes happen only after every existing DOM assertion above.
  // Observers retain genuine platform contexts; only fresh refusal documents
  // alter a platform result. No Terminal, addon, PTY or input API is replaced.
  if (
    !(await browser.evaluate<boolean>(`document.querySelector('.xterm-host')?.dataset.terminalRenderer === 'dom'
      && document.querySelector('[data-testid="terminal-renderer-toggle"]')?.getAttribute('aria-pressed') === 'false'
      && window.__terminalWebglProof.attempts === 0`))
  ) {
    throw new Error("the unchanged DOM selection/lifecycle branch attempted WebGL");
  }
  console.log(
    "PASS  all original selection, clipboard, scaled-view and wheel cases use default DOM",
  );

  async function rendererZoom(scaled: boolean): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const zoom = (await viewport()).zoom;
      if (scaled ? zoom >= 1.15 && zoom <= 1.3 : Math.abs(zoom - 1) < 0.06) {
        await revealScreen();
        return;
      }
      const decrease = zoom > (scaled ? 1.3 : 1);
      await browser!.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        ...(await terminalPoint()),
        modifiers: 2,
        deltaX: 0,
        deltaY: decrease ? 80 : -80,
      });
      await until(
        async () => {
          const next = (await viewport()).zoom;
          return decrease ? next < zoom : next > zoom;
        },
        20_000,
        "renderer witness canvas zoom changes through real pinch",
      );
    }
    throw new Error(`renderer witness did not reach ${scaled ? "scaled" : "baseline"} canvas zoom`);
  }

  const rendererRows = () =>
    browser!.evaluate<string[]>(
      "[...document.querySelector('.xterm-rows').children].map(row => row.textContent.trimEnd())",
    );
  async function rendererState(
    state: "dom" | "webgl" | "fallback",
    optedIn: boolean,
  ): Promise<void> {
    await until(
      () =>
        browser!
          .evaluate<boolean>(`document.querySelector('.xterm-host')?.dataset.terminalRenderer === ${JSON.stringify(state)}
          && document.querySelector('[data-testid="terminal-renderer-toggle"]')?.getAttribute('aria-pressed') === ${JSON.stringify(String(optedIn))}`),
      20_000,
      `actual terminal host uses ${state} with device opt-in ${String(optedIn)}`,
    );
  }
  async function rendererFocus(): Promise<void> {
    const point = await browser!.evaluate<{ x: number; y: number }>(`(() => {
      const screen = document.querySelector('.xterm-screen'), box = screen.getBoundingClientRect();
      const canvas = document.querySelector('.canvas')?.getBoundingClientRect();
      const left = Math.max(box.left, canvas?.left ?? 0, 0), right = Math.min(box.right, canvas?.right ?? innerWidth, innerWidth);
      const top = Math.max(box.top, canvas?.top ?? 0, 0), bottom = Math.min(box.bottom, canvas?.bottom ?? innerHeight, innerHeight);
      if (right - left < 40 || bottom - top < 40) throw new Error('renderer has no visible input target');
      return { x: (left + right) / 2, y: (top + bottom) / 2 };
    })()`);
    await browser!.drag([point], 30);
    await until(
      () =>
        browser!.evaluate<boolean>(`(() => {
          const host = document.querySelector('.xterm-host:not(.xterm-host--inactive)');
          return host?.contains(document.activeElement)
            && document.activeElement?.matches('.xterm-helper-textarea') === true
            && host.closest('.terminal-frame')?.querySelector('.terminal-idle-veil--on') === null;
        })()`),
      20_000,
      "renderer witness occupant and real input ready",
    );
  }
  async function rendererScroll(edge: "top" | "bottom"): Promise<void> {
    await browser!.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...(await terminalPoint()),
      deltaX: 0,
      deltaY: edge === "top" ? -100_000 : 100_000,
    });
    await until(
      () =>
        browser!.evaluate<boolean>(`(() => {
          const slider = document.querySelector('.xterm .scrollbar.vertical .slider');
          if (!slider) return false;
          const thumb = slider.getBoundingClientRect(), track = slider.parentElement.getBoundingClientRect();
          return thumb.height > 0 && track.height - thumb.height > 1
            && Math.abs(${edge === "top" ? "thumb.top - track.top" : "track.bottom - thumb.bottom"}) < 1;
        })()`),
      20_000,
      `renderer witness scrollback reaches ${edge} through real wheel input`,
    );
    await browser!.evaluate(
      "(() => { const { promise, resolve } = Promise.withResolvers(); requestAnimationFrame(() => requestAnimationFrame(resolve)); return promise; })()",
    );
  }
  async function rendererBuffer(): Promise<{ current: string[]; history: string[][] }> {
    await rendererScroll("bottom");
    const current = await rendererRows();
    await rendererScroll("top");
    const history: string[][] = [];
    for (let page = 0; page < 512; page++) {
      history.push(await rendererRows());
      const gap = await scrollbackBottomGap();
      if (gap === null) throw new Error("renderer witness lost its scrollback scrollbar");
      if (Math.abs(gap) < 1) {
        if (JSON.stringify(await rendererRows()) !== JSON.stringify(current))
          throw new Error("traversing renderer history changed the current screen");
        return { current, history };
      }
      await browser!.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        ...(await terminalPoint()),
        deltaX: 0,
        deltaY: await browser!.evaluate<number>(
          "document.querySelector('.xterm-screen').getBoundingClientRect().height / 2",
        ),
      });
      await browser!.evaluate(
        "(() => { const { promise, resolve } = Promise.withResolvers(); requestAnimationFrame(() => requestAnimationFrame(resolve)); return promise; })()",
      );
    }
    throw new Error("renderer witness history traversal did not reach the current screen");
  }
  async function rendererMount(): Promise<void> {
    await browser!.evaluate(`(() => {
      const host = document.querySelector('.xterm-host');
      window.__terminalRendererMount = {
        host, xterm: host.querySelector('.xterm'), textarea: host.querySelector('.xterm-helper-textarea'),
        canvases: host.querySelectorAll('.xterm-screen > canvas').length,
        notices: [...document.querySelectorAll('.notice-layer .notice')]
      };
    })()`);
  }
  async function rendererInPlace(beforeWire: string, label: string): Promise<void> {
    if (
      !(await browser!.evaluate<boolean>(`(() => {
        const previous = window.__terminalRendererMount, host = document.querySelector('.xterm-host');
        return previous.host === host && previous.xterm === host?.querySelector('.xterm')
          && previous.textarea === host?.querySelector('.xterm-helper-textarea');
      })()`)) ||
      JSON.stringify(rendererWire) !== beforeWire
    ) {
      throw new Error(`${label} replaced xterm/input or reconnected/replayed the PTY`);
    }
  }
  async function rendererNotice(): Promise<void> {
    await until(
      () =>
        browser!
          .evaluate<boolean>(`[...document.querySelectorAll('.notice-layer .notice')].some(notice => {
          const box = notice.getBoundingClientRect(), style = getComputedStyle(notice);
          return !window.__terminalRendererMount.notices.includes(notice)
            && ['status', 'alert'].includes(notice.getAttribute('role'))
            && notice.querySelector('.notice-message')?.textContent.trim()
            && style.visibility === 'visible' && Number(style.opacity) > 0
            && box.width > 0 && box.height > 0 && box.top >= 0 && box.bottom <= innerHeight;
        })`),
      3000,
      "renderer fallback is visible in the existing notice surface",
    );
  }
  async function rendererPixels(
    label: string,
    row?: { index: number; count: number },
  ): Promise<{ blueGlyphs: number; selection: number; area: number }> {
    const clip = await browser!.evaluate<{
      x: number;
      y: number;
      width: number;
      height: number;
    }>(`(() => {
      const screen = document.querySelector('.xterm-screen'), box = screen.getBoundingClientRect();
      if (box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight)
        throw new Error('renderer pixel witness is clipped');
      const index = ${row?.index ?? 0}, count = ${row?.count ?? 1};
      return { x: box.x, y: box.y + box.height * index / count,
        width: box.width, height: ${row === undefined ? "box.height" : "box.height / count"} };
    })()`);
    const shot = await browser!.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      clip: { ...clip, scale: 1 },
    });
    const data = shot.result?.["data"];
    if (shot.error !== undefined || typeof data !== "string")
      throw new Error(`${label}: compositor screenshot failed`);
    // Decode the compositor's PNG, not the canvas drawing buffer (which may
    // legitimately clear after presentation). Colored glyphs and selection
    // bands have separate witnesses; a merely nonempty canvas never passes.
    const pixels = await browser!.evaluate<{
      blueGlyphs: number;
      selection: number;
      area: number;
    }>(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(data)}), value => value.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
      bitmap.close();
      let blueGlyphs = 0, selection = 0;
      for (let index = 0; index < image.data.length; index += 4) {
        const red = image.data[index], green = image.data[index + 1], blue = image.data[index + 2];
        if (blue > 150 && blue > red + 70 && blue > green + 40) blueGlyphs++;
        if (blue > 60 && blue < 160 && blue > red + 30 && blue > green + 25) selection++;
      }
      return { blueGlyphs, selection, area: image.width * image.height };
    })()`);
    console.log(`renderer pixels (${label}):`, JSON.stringify(pixels));
    return pixels;
  }

  await rendererZoom(false);
  await rendererFocus();
  const rendererNonce = crypto.randomUUID().slice(0, 8);
  const historyPrefix = `GPU-${rendererNonce}`;
  const header = `${historyPrefix} BLUE 0123456789`;
  const unicode = "BOX ┌─┐ WIDE 界 COMBINING é";
  const rendererComplete = `GPU-COMPLETE-${rendererNonce}`;
  const historyCount = (await rendererRows()).length * 3;
  await browser.typeText(
    `clear; renderer_pty=$$; seq 1 ${historyCount} | sed 's/.*/${historyPrefix}-& history/'; printf '\\033[38;2;0;120;255m%s\\033[0m\\n%s\\nPTY-${rendererNonce}-BASE %s\\n%s%s\\n' '${header}' '${unicode}' "$renderer_pty" 'GPU-COMPLETE-' '${rendererNonce}'`,
  );
  await browser.typeText("\r");
  await until(
    async () => {
      const rows = await rendererRows(),
        complete = rows.indexOf(rendererComplete);
      return (
        rows.includes(header) &&
        rows.includes(unicode) &&
        complete >= 0 &&
        rows.slice(complete + 1).some((text) => text.trim().length > 0)
      );
    },
    20_000,
    "fresh renderer history, colored Unicode screen and returned PTY prompt painted",
  );
  const initialBuffer = await rendererBuffer();
  const historyFixtures = Array.from(
    { length: historyCount },
    (_, index) => `${historyPrefix}-${index + 1} history`,
  );
  if (!historyFixtures.every((line) => initialBuffer.history.some((page) => page.includes(line))))
    throw new Error("fresh renderer fixture did not paint every known history row");
  const pidRow = initialBuffer.current.find((line) =>
    line.startsWith(`PTY-${rendererNonce}-BASE `),
  );
  const pid = pidRow?.slice(`PTY-${rendererNonce}-BASE `.length);
  if (pid === undefined || !/^[1-9][0-9]*$/.test(pid))
    throw new Error("real shell did not return its renderer fixture PID");
  if ((await rendererPixels("initial DOM blue header")).blueGlyphs < 50)
    throw new Error("DOM renderer did not visibly paint the known blue header");
  await rendererMount();
  const scriptsBeforeOptIn = new Set(rendererScripts);
  const beforeOptInWire = JSON.stringify(rendererWire);
  await browser.clickTestId("terminal-renderer-toggle");
  await until(
    () =>
      browser!.evaluate<boolean>(
        "['webgl', 'fallback'].includes(document.querySelector('.xterm-host')?.dataset.terminalRenderer)",
      ),
    20_000,
    "explicit renderer opt-in settles on actual WebGL or usable fallback",
  );
  const deferredRendererScripts = new Set(
    [...rendererScripts].filter((url) => !scriptsBeforeOptIn.has(url)),
  );
  if (deferredRendererScripts.size === 0)
    throw new Error(
      "explicit opt-in did not lazily fetch its renderer module from the fresh DOM document",
    );
  await rendererInPlace(beforeOptInWire, "explicit renderer opt-in");

  async function rendererLive(): Promise<void> {
    const driver = await browser!.evaluate<{ browser: string; renderer: string }>(`(() => {
      const host = document.querySelector('.xterm-host');
      const live = window.__terminalWebglProof.contexts.filter(entry =>
        entry.canvas.isConnected && host.contains(entry.canvas) && !entry.gl.isContextLost());
      if (live.length !== 1) throw new Error('WebGL state has no single genuine live terminal canvas');
      if (host.querySelector('.xterm-rows'))
        throw new Error('DOM rows remain under the supposed WebGL surface; pixels would not prove GPU rendering');
      window.__terminalRendererLive = live[0];
      const debug = live[0].gl.getExtension('WEBGL_debug_renderer_info');
      return { browser: navigator.userAgent, renderer: String(live[0].gl.getParameter(
        debug ? debug.UNMASKED_RENDERER_WEBGL : live[0].gl.RENDERER)) };
    })()`);
    console.log(
      "renderer platform (software-only requested; no native performance claim):",
      JSON.stringify(driver),
    );
    await until(
      async () => (await rendererPixels("actual WebGL blue header")).blueGlyphs >= 50,
      3000,
      "real terminal WebGL canvas visibly paints the known colored text",
    );
  }
  async function rendererSelect(
    rowIndex: number,
    rowCount: number,
    autoCopy: boolean,
  ): Promise<void> {
    const point = await browser!.evaluate<{ x: number; y: number }>(`(() => {
      const screen = document.querySelector('.xterm-screen'), box = screen.getBoundingClientRect();
      const y = box.y + box.height * (${rowIndex} + 0.5) / ${rowCount};
      for (const offset of [2, 140, 280, 352])
        if (!screen.contains(document.elementFromPoint(box.x + offset, y)))
          throw new Error('WebGL Unicode row is not pointer-reachable');
      return { x: box.x + 2, y };
    })()`);
    await browser!.drag([{ x: point.x + 250, y: point.y }], 40);
    await browser!.evaluate("navigator.clipboard.writeText('renderer selection sentinel')");
    await browser!.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x + 350,
      y: point.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    for (const offset of [280, 210, 140, 0]) {
      await browser!.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x + offset,
        y: point.y,
        button: "left",
        buttons: 1,
      });
      await Bun.sleep(40);
    }
    let held = { blueGlyphs: 0, selection: 0, area: 0 };
    await until(
      async () => {
        held = await rendererPixels("WebGL held Unicode selection", {
          index: rowIndex,
          count: rowCount,
        });
        return held.area > 0 && held.selection > held.area * 0.08;
      },
      20_000,
      "WebGL visibly paints selection on the dragged Unicode row",
    );
    if (
      (await browser!.evaluate<string>("navigator.clipboard.readText()")) !==
      "renderer selection sentinel"
    )
      throw new Error("WebGL selection copied before the real drag was released");
    await browser!.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...point,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await until(
      async () => {
        const copied = await browser!.evaluate<string>("navigator.clipboard.readText()");
        const painted = await rendererPixels("WebGL released Unicode selection", {
          index: rowIndex,
          count: rowCount,
        });
        return (
          copied === (autoCopy ? unicode : "renderer selection sentinel") &&
          (autoCopy
            ? painted.selection < held.selection / 3
            : painted.selection > painted.area * 0.08)
        );
      },
      3000,
      autoCopy
        ? "WebGL Unicode copies exactly and clears after release"
        : "WebGL default selection remains without copying",
    );
  }
  async function rendererInput(label: string): Promise<void> {
    await rendererFocus();
    const marker = `PTY-${rendererNonce}-${label}`;
    await browser!.typeText(`printf '%s %s\\n' '${marker}' "$renderer_pty"`);
    await browser!.typeText("\r");
    await until(
      async () => (await rendererRows()).includes(`${marker} ${pid}`),
      20_000,
      `${label}: real input produces fresh output from the same shell`,
    );
  }

  if (
    await browser.evaluate<boolean>(
      "document.querySelector('.xterm-host')?.dataset.terminalRenderer === 'webgl'",
    )
  ) {
    await rendererState("webgl", true);
    await rendererLive();
    if ((await browser.evaluate<number>("window.__terminalWebglProof.attempts")) !== 1)
      throw new Error("one explicit opt-in attempted more than one WebGL context");
    const unicodeRow = initialBuffer.current.indexOf(unicode),
      rowCount = initialBuffer.current.length;
    await rendererSelect(unicodeRow, rowCount, false);
    await setGesturePreference("copy-on-select", true);
    await rendererSelect(unicodeRow, rowCount, true);
    await rendererZoom(true);
    await rendererSelect(unicodeRow, rowCount, true);
    await rendererZoom(false);
    await setGesturePreference("copy-on-select", false);
    console.log(
      "PASS  genuine software WebGL paints and selects/copies exact box, wide and combining Unicode at baseline/scaled zoom",
    );

    const dimensions = await browser.evaluate<{ width: number; height: number }>(
      "({ width: window.__terminalRendererLive.canvas.width, height: window.__terminalRendererLive.canvas.height })",
    );
    await browser.evaluate(
      "document.querySelector('[aria-label=\"Increase terminal font size\"]').click()",
    );
    await until(
      () =>
        browser!
          .evaluate<boolean>(`window.__terminalRendererLive.canvas.width !== ${dimensions.width}
          || window.__terminalRendererLive.canvas.height !== ${dimensions.height}`),
      20_000,
      "font control resizes the real WebGL surface through authoritative terminal geometry",
    );
    if ((await rendererPixels("resized WebGL blue header")).blueGlyphs < 50)
      throw new Error("resized WebGL surface lost the colored current-screen witness");
    await browser.evaluate(
      "document.querySelector('[aria-label=\"Decrease terminal font size\"]').click()",
    );
    await until(
      () =>
        browser!
          .evaluate<boolean>(`window.__terminalRendererLive.canvas.width === ${dimensions.width}
          && window.__terminalRendererLive.canvas.height === ${dimensions.height}`),
      20_000,
      "WebGL terminal geometry returns after the font resize",
    );

    const beforeDisableWire = JSON.stringify(rendererWire);
    await browser.clickTestId("terminal-renderer-toggle");
    await rendererState("dom", false);
    await rendererInPlace(beforeDisableWire, "disabling WebGL");
    if (
      !(await browser.evaluate<boolean>(
        "!window.__terminalRendererLive.canvas.isConnected && window.__terminalRendererLive.gl.isContextLost()",
      ))
    )
      throw new Error("disabling WebGL did not detach and immediately retire its genuine context");
    const beforeLossBuffer = await rendererBuffer();
    await rendererMount();
    const beforeLossWire = JSON.stringify(rendererWire);
    await browser.clickTestId("terminal-renderer-toggle");
    await rendererState("webgl", true);
    await rendererLive();
    const lossAttempts = await browser.evaluate<number>("window.__terminalWebglProof.attempts");
    await browser.evaluate(`(() => {
      const live = window.__terminalRendererLive;
      const extension = live.gl.getExtension('WEBGL_lose_context');
      if (!extension) throw new Error('the real terminal canvas cannot inject context loss');
      extension.loseContext();
    })()`);
    await rendererState("fallback", true);
    await rendererNotice();
    await rendererInPlace(beforeLossWire, "forced real WebGL context loss");
    if (
      !(await browser.evaluate<boolean>(`(() => {
      const live = window.__terminalRendererLive, mount = window.__terminalRendererMount;
      return !live.canvas.isConnected && live.gl.isContextLost()
        && mount.host.querySelectorAll('.xterm-screen > canvas').length === mount.canvases;
    })()`))
    )
      throw new Error("context-loss fallback left renderer canvases or a live context behind");
    if (JSON.stringify(await rendererBuffer()) !== JSON.stringify(beforeLossBuffer))
      throw new Error("forced context loss changed the current screen or traversable history");
    if ((await rendererPixels("context-loss DOM fallback blue header")).blueGlyphs < 50)
      throw new Error("context loss restored DOM bookkeeping without visible terminal paint");
    await rendererInput("LOSS");
    if ((await browser.evaluate<number>("window.__terminalWebglProof.attempts")) !== lossAttempts)
      throw new Error("context-loss fallback retried WebGL without a new explicit opt-in");
    console.log(
      "PASS  WEBGL_lose_context restores visible DOM, identical history/current screen and same usable PTY/input without reconnect",
    );

    // An explicit off→on is the retry. A new mount inherits the device choice,
    // but must retire the old canvas/context rather than leaking GPU ownership.
    await browser.clickTestId("terminal-renderer-toggle");
    await rendererState("dom", false);
    await browser.clickTestId("terminal-renderer-toggle");
    await rendererState("webgl", true);
    await rendererLive();
    await browser.evaluate("window.__terminalRendererRetiring = window.__terminalRendererLive");
    await browser.evaluate(
      "document.querySelector('[aria-label=\"Expand terminal to full view\"]').click()",
    );
    await until(
      () =>
        browser!.evaluate<boolean>(
          "document.querySelector('[aria-label=\"Shrink view\"]') !== null",
        ),
      20_000,
      "renderer opt-in remounts in the existing fullscreen lifecycle",
    );
    await rendererState("webgl", true);
    await rendererFocus();
    await rendererLive();
    if (
      !(await browser.evaluate<boolean>(
        "!window.__terminalRendererRetiring.canvas.isConnected && window.__terminalRendererRetiring.gl.isContextLost()",
      ))
    )
      throw new Error("fullscreen remount retained the disposed canvas or its WebGL context");
    await browser.clickTestId("terminal-renderer-toggle");
    await rendererState("dom", false);
    await rendererInput("REMOUNT");
    await browser.evaluate("document.querySelector('[aria-label=\"Shrink view\"]').click()");
    await until(
      () =>
        browser!.evaluate<boolean>(
          "document.querySelector('.canvas') !== null && document.querySelector('.xterm-rows') !== null",
        ),
      20_000,
      "renderer opt-out survives the return from fullscreen",
    );
    await rendererState("dom", false);
    if (
      !(await browser.evaluate<boolean>(
        "window.__terminalWebglProof.contexts.every(entry => !entry.canvas.isConnected && entry.gl.isContextLost())",
      ))
    )
      throw new Error("renderer toggle/remount churn left an owned canvas or live WebGL context");
    console.log(
      "PASS  explicit retry and fullscreen/canvas remount share the local preference and retire all disposed contexts",
    );
  } else {
    await rendererState("fallback", true);
    await rendererNotice();
    if (JSON.stringify(await rendererBuffer()) !== JSON.stringify(initialBuffer))
      throw new Error("unsupported WebGL initialization lost the current screen or history");
    await rendererInput("UNSUPPORTED");
    failures.push(
      "software-only WebGL unavailable: real canvas, Unicode pixel selection and forced context-loss cases were NOT EXERCISED",
    );
    console.error(
      "UNSUPPORTED  actual software-only browser refused WebGL; usable DOM fallback proved, not native GPU performance",
    );
    await browser.clickTestId("terminal-renderer-toggle");
    await rendererState("dom", false);
  }

  async function rendererFreshDom(label: string): Promise<void> {
    await browser!.reload();
    await until(
      () =>
        browser!.evaluate<boolean>(
          "document.querySelector('.canvas') !== null && document.querySelector('.xterm-rows') !== null",
        ),
      20_000,
      `${label}: fresh document replays the existing terminal in DOM`,
    );
    await rendererState("dom", false);
    await revealScreen();
    await rendererFocus();
    const marker = `PTY-${rendererNonce}-${label}`;
    // Refresh only the visible witnesses, never the process or its history.
    // The retained shell variable must still equal the original real PID.
    await browser!.typeText(
      `printf '\\033[38;2;0;120;255m%s\\033[0m\\n%s\\n%s %s\\n' '${header}' '${unicode}' '${marker}' "$renderer_pty"`,
    );
    await browser!.typeText("\r");
    await until(
      async () => {
        const rows = await rendererRows(),
          complete = rows.indexOf(`${marker} ${pid}`);
        return (
          rows.includes(header) &&
          rows.includes(unicode) &&
          complete >= 0 &&
          rows.slice(complete + 1).some((text) => text.trim().length > 0)
        );
      },
      20_000,
      `${label}: same shell returns fresh colored Unicode output and its prompt`,
    );
    if ((await browser!.evaluate<number>("window.__terminalWebglProof.attempts")) !== 0)
      throw new Error(
        `${label}: a fresh DOM document tried to acquire WebGL before explicit opt-in`,
      );
  }

  // Early platform refusal is separate from shader failure after acquiring a
  // genuine context. Inject each in a new document, not into production APIs.
  for (const refusal of ["context", "shader"] as const) {
    const injection = await browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__terminalWebglProof.${refusal === "context" ? "refuse" : "refuseShaders"} = true;`,
    });
    const identifier = injection.result?.["identifier"];
    if (injection.error !== undefined || typeof identifier !== "string")
      throw new Error(`could not install fresh ${refusal} platform refusal`);
    try {
      await rendererFreshDom(refusal.toUpperCase());
      const beforeRefusalBuffer = await rendererBuffer();
      await rendererMount();
      const beforeRefusalWire = JSON.stringify(rendererWire);
      await browser.clickTestId("terminal-renderer-toggle");
      await rendererState("fallback", true);
      await rendererNotice();
      await rendererInPlace(beforeRefusalWire, `${refusal} initialization refusal`);
      const ownership = await browser.evaluate<{
        attempts: number;
        refused: number;
        shaderRefusals: number;
        acquired: number;
        retired: boolean;
      }>(`(() => {
        const proof = window.__terminalWebglProof, mount = window.__terminalRendererMount;
        return {
          attempts: proof.attempts, refused: proof.refused, shaderRefusals: proof.shaderRefusals,
          acquired: proof.contexts.length,
          retired: proof.contexts.every(entry => !entry.canvas.isConnected && entry.gl.isContextLost())
            && mount.host.querySelectorAll('.xterm-screen > canvas').length === mount.canvases
        };
      })()`);
      if (
        ownership.attempts !== 1 ||
        !ownership.retired ||
        (refusal === "context"
          ? ownership.refused !== 1 || ownership.acquired !== 0
          : ownership.shaderRefusals < 1 || ownership.acquired !== 1)
      ) {
        throw new Error(
          `${refusal} initialization refusal leaked ownership or retried: ${JSON.stringify(ownership)}`,
        );
      }
      if (JSON.stringify(await rendererBuffer()) !== JSON.stringify(beforeRefusalBuffer))
        throw new Error(
          `${refusal} initialization refusal changed the current screen or complete traversable history`,
        );
      await until(
        async () =>
          (await rendererPixels(`${refusal} refusal visible DOM blue header`)).blueGlyphs >= 50,
        3000,
        `${refusal} refusal restores actual DOM paint, not just readable buffer text`,
      );
      await rendererInput(refusal.toUpperCase());
      if ((await browser.evaluate<number>("window.__terminalWebglProof.attempts")) !== 1)
        throw new Error(`${refusal} fallback retried WebGL while accepting ordinary PTY output`);
      await browser.clickTestId("terminal-renderer-toggle");
      await rendererState("dom", false);
      if (refusal === "context") {
        await rendererMount();
        const beforeRetryBuffer = await rendererBuffer();
        const beforeRetryWire = JSON.stringify(rendererWire);
        await browser.clickTestId("terminal-renderer-toggle");
        await rendererState("fallback", true);
        await rendererInPlace(beforeRetryWire, "explicit retry after context refusal");
        if (
          (await browser.evaluate<number>("window.__terminalWebglProof.attempts")) !== 2 ||
          JSON.stringify(await rendererBuffer()) !== JSON.stringify(beforeRetryBuffer)
        )
          throw new Error(
            "off→on did not make exactly one fresh refusal attempt with the same screen/history",
          );
        await browser.clickTestId("terminal-renderer-toggle");
        await rendererState("dom", false);
      }
      console.log(
        `PASS  fresh ${refusal} refusal keeps visible DOM/current/history/input, one attempt and fully retired renderer ownership`,
      );
    } finally {
      await browser.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    }
  }

  // Hold the actual lazily discovered script requests, never guessed asset
  // names or a mocked import/addon. This makes late import cancellation
  // deterministic on both disable and disposal of the existing mount.
  const heldRendererRequests = new Map<string, string>();
  const fetchFailures: string[] = [];
  const stopPausing = browser.on("Fetch.requestPaused", (params) => {
    const request = params["request"] as { url?: string } | undefined;
    const requestId = params["requestId"],
      networkId = params["networkId"];
    if (typeof requestId !== "string") {
      fetchFailures.push("paused script request has no CDP identity");
      return;
    }
    if (request?.url !== undefined && deferredRendererScripts.has(request.url)) {
      if (typeof networkId !== "string") {
        fetchFailures.push("paused renderer request has no network completion identity");
      } else {
        rendererFinished.delete(networkId);
        heldRendererRequests.set(requestId, networkId);
        return;
      }
    }
    void browser!
      .send("Fetch.continueRequest", { requestId })
      .then((frame) => {
        if (frame.error !== undefined)
          fetchFailures.push("could not continue an unrelated script request");
      })
      .catch(() => fetchFailures.push("unrelated script continuation failed"));
  });
  async function releaseRendererRequests(): Promise<void> {
    const deadline = Date.now() + 20_000;
    do {
      const requests = [...heldRendererRequests];
      for (const [requestId] of requests) {
        heldRendererRequests.delete(requestId);
        const continued = await browser!.send("Fetch.continueRequest", { requestId });
        if (continued.error !== undefined)
          throw new Error("could not release the actual renderer script");
      }
      await until(
        () => requests.every(([, networkId]) => rendererFinished.has(networkId)),
        Math.max(1, deadline - Date.now()),
        "released actual renderer module bytes finish loading",
      );
      await browser!.evaluate(
        "(() => { const { promise, resolve } = Promise.withResolvers(); requestAnimationFrame(() => requestAnimationFrame(resolve)); return promise; })()",
      );
      if (heldRendererRequests.size === 0) return;
    } while (Date.now() < deadline);
    throw new Error("released renderer imports still have paused dependent modules");
  }
  try {
    await browser.send("Network.setCacheDisabled", { cacheDisabled: true });
    const interception = await browser.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", resourceType: "Script", requestStage: "Request" }],
    });
    if (interception.error !== undefined) throw new Error("could not pause real renderer imports");
    await rendererFreshDom("PENDING-DISABLE");
    const beforePendingBuffer = await rendererBuffer();
    await rendererMount();
    const beforePendingWire = JSON.stringify(rendererWire);
    await browser.clickTestId("terminal-renderer-toggle");
    await until(
      async () =>
        heldRendererRequests.size > 0 &&
        (await browser!.evaluate<boolean>(
          "document.querySelector('.xterm-host')?.dataset.terminalRenderer === 'loading'",
        )),
      20_000,
      "first renderer import is actually pending at the browser network boundary",
    );
    await browser.clickTestId("terminal-renderer-toggle");
    await rendererState("dom", false);
    await releaseRendererRequests();
    await rendererState("dom", false);
    await rendererInPlace(beforePendingWire, "disable while the real renderer import is pending");
    if (
      (await browser.evaluate<number>("window.__terminalWebglProof.attempts")) !== 0 ||
      JSON.stringify(await rendererBuffer()) !== JSON.stringify(beforePendingBuffer)
    ) {
      throw new Error(
        "late import completion installed WebGL or altered the disabled DOM buffer/history",
      );
    }
    if ((await rendererPixels("disabled pending import DOM witness")).blueGlyphs < 50)
      throw new Error("cancelling a pending renderer import lost actual DOM paint");
    console.log(
      "PASS  disabling a genuinely pending renderer import prevents late installation without replacing xterm/PTY/history",
    );

    await rendererFreshDom("PENDING-REMOUNT");
    await rendererMount();
    await browser.evaluate(
      "window.__terminalRendererDisposedMount = window.__terminalRendererMount",
    );
    await browser.clickTestId("terminal-renderer-toggle");
    await until(
      async () =>
        heldRendererRequests.size > 0 &&
        (await browser!.evaluate<boolean>(
          "document.querySelector('.xterm-host')?.dataset.terminalRenderer === 'loading'",
        )),
      20_000,
      "renderer import is pending before the existing fullscreen remount",
    );
    await browser.evaluate(
      "document.querySelector('[aria-label=\"Expand terminal to full view\"]').click()",
    );
    await until(
      () =>
        browser!.evaluate<boolean>(`document.querySelector('[aria-label="Shrink view"]') !== null
        && !window.__terminalRendererDisposedMount.host.isConnected
        && document.querySelector('.xterm-host')?.dataset.terminalRenderer === 'loading'`),
      20_000,
      "old terminal mount is disposed while the new mount still awaits the real import",
    );
    await rendererFocus();
    await releaseRendererRequests();
    await rendererState("webgl", true);
    await rendererLive();
    if (
      !(await browser.evaluate<boolean>(`(() => {
      const proof = window.__terminalWebglProof, previous = window.__terminalRendererDisposedMount;
      return proof.attempts === 1 && !previous.host.isConnected
        && proof.contexts.every(entry => entry.canvas.isConnected || entry.gl.isContextLost())
        && !previous.host.contains(window.__terminalRendererLive.canvas);
    })()`))
    )
      throw new Error("a disposed mount installed a stale addon when its pending import completed");
    await browser.clickTestId("terminal-renderer-toggle");
    await rendererState("dom", false);
    await rendererInput("PENDING-REMOUNT");
    await browser.evaluate("document.querySelector('[aria-label=\"Shrink view\"]').click()");
    await until(
      () =>
        browser!.evaluate<boolean>(
          "document.querySelector('.canvas') !== null && document.querySelector('.xterm-rows') !== null",
        ),
      20_000,
      "pending-import remount returns through the existing canvas lifecycle",
    );
    await rendererState("dom", false);
    await revealScreen();
    await rendererFocus();
    const finalBuffer = await rendererBuffer();
    if (
      !historyFixtures.every((line) => finalBuffer.history.some((page) => page.includes(line))) ||
      !(await browser.evaluate<boolean>(
        "window.__terminalWebglProof.contexts.every(entry => !entry.canvas.isConnected && entry.gl.isContextLost())",
      ))
    )
      throw new Error("pending-import remount lost history or leaked renderer contexts");
    if (fetchFailures.length > 0) throw new Error(fetchFailures.join("; "));
    console.log(
      "PASS  disposal cancels the old pending import; only the new mount installs, PTY/history stay usable and all owned contexts retire",
    );
  } finally {
    for (const requestId of heldRendererRequests.keys())
      await browser.send("Fetch.continueRequest", { requestId });
    stopPausing();
    await browser.send("Fetch.disable", {});
    await browser.send("Network.setCacheDisabled", { cacheDisabled: false });
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  if (wheelFixtureStarted && browser !== null) {
    const diagnostic = await browser.evaluate(`(() => {
      const host = document.querySelector('.xterm-host');
      const screen = host?.querySelector('.xterm-screen');
      const rows = host?.querySelector('.xterm-rows');
      return {
        portal: host?.closest('.portal')?.className,
        host: host?.className,
        focused: host?.contains(document.activeElement),
        hostHeight: host?.getBoundingClientRect().height,
        screenHeight: screen?.getBoundingClientRect().height,
        rowCount: rows?.childElementCount,
        lastRows: [...(rows?.children ?? [])].slice(-6).map(row => row.textContent.slice(0, 160)),
      };
    })()`);
    console.error("wheel fixture state:", JSON.stringify(diagnostic));
  }
} finally {
  await browser?.close();
  await teardownServer(server, dataDir);
  cleanupDist();
}

console.log(
  failures.length === 0
    ? "\nterminal-selection gate: GREEN"
    : `\nterminal-selection gate: RED\n${failures.map((f) => ` - ${f}`).join("\n")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
