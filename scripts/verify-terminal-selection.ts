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
  // (secrets discipline, AGENTS invariant 6).
  stdout: "ignore",
  stderr: "inherit",
});

const failures: string[] = [];
let browser: Browser | null = null;

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
  await browser.launch();
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
        "document.querySelector('.terminal-idle-veil:not(.terminal-idle-veil--on)') !== null",
      ),
    20_000,
    "terminal activated",
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
  await browser.typeText("clear; seq 1 40 | sed 's/.*/ROW-& selection clipboard target/'");
  await browser.typeText("\r");
  await until(
    () =>
      browser!.evaluate<boolean>(
        "(() => { const rows = [...document.querySelector('.xterm-rows').children].map(row => row.textContent.trim()); const last = rows.indexOf('ROW-40 selection clipboard target'); return last >= 0 && rows.slice(last + 1).some(text => text.length > 0); })()",
      ),
    20_000,
    "known terminal output through row 40 and returned shell prompt painted",
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
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
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
