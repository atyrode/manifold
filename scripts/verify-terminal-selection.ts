/**
 * manifold terminal-selection regression gate.
 *
 * Guards the xterm pointer-coordinate boundary inside Excalidraw's scaled embeddable
 * container: with any ancestor CSS transform (canvas zoom ≠ 1), xterm's mouse→cell
 * math in `getCoords` divides post-transform `getBoundingClientRect()` offsets by
 * unscaled cell dimensions, so painted selection drifts downward proportionally to
 * distance from the terminal origin ("the more down I go, the greater the offset").
 *
 * The gate drives a REAL browser drag over known rows at zoom 1 (baseline) and at
 * canvas zoom ≈ 1.2, then reads the PAINTED `.xterm-selection` layer (what the user
 * sees) and asserts the dragged row is exactly what got highlighted. It must fail on
 * unpatched @xterm/xterm and pass after the fix.
 *
 * Self-contained: builds the web bundle to a temp dir, spawns its own server + agent,
 * cleans up. Env: MANIFOLD_CHROMIUM (else system chromium).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser, sleep, until } from "./cdp.ts";

const repoRoot = join(import.meta.dir, "..");
const distDir = join(mkdtempSync(join(tmpdir(), "manifold-sel-")), "dist");
const dataDir = mkdtempSync(join(tmpdir(), "manifold-sel-data-"));
const port = 39000 + Math.floor(Math.random() * 2000);
const origin = `http://127.0.0.1:${String(port)}`;

const build = Bun.spawnSync(["bunx", "vite", "build", "--outDir", distDir, "--emptyOutDir"], {
  cwd: join(repoRoot, "packages", "web"),
  stdout: "ignore",
  stderr: "inherit",
});
if (!build.success) throw new Error("web build failed");

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
  const ownerKey = (await Bun.file(join(dataDir, "owner.key")).text()).trim();
  const httpHeaders = { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" };

  const created = await fetch(`${origin}/api/pads`, {
    method: "POST",
    headers: httpHeaders,
    body: JSON.stringify({ name: "terminal-selection-gate" }),
  });
  const padId = ((await created.json()) as { pad: { id: string } }).pad.id;

  browser = new Browser();
  await browser.launch(9340);
  await browser.goto(`${origin}/#key=${ownerKey}`);
  await browser.evaluate("localStorage.setItem('manifold:debug', '1')");
  if (await browser.evaluate<boolean>("document.querySelector('input') !== null")) {
    await browser.typeInto("input", "sel-gate");
    await browser.clickText("Enter manifold");
  }
  await browser.goto(`${origin}/p/${padId}`);
  await until(
    () => browser!.evaluate<boolean>("window.__manifold !== undefined"),
    20_000,
    "debug seam installed",
  );

  // Create a terminal directly from an online machine row in the sidebar.
  await browser.evaluate(
    "document.querySelector('[data-testid=machines-section] > summary').click()",
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
  // Activate the embed (click-to-focus model), then focus xterm itself.
  await browser.evaluate(`(() => {
    const r = document.querySelector('.manifold-terminal').getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const o = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  })()`);
  await sleep(600);
  const screenBox = await browser.evaluate<{ x: number; y: number }>(
    "(() => { const s = document.querySelector('.xterm-screen').getBoundingClientRect(); return { x: s.x + s.width / 2, y: s.y + s.height / 2 }; })()",
  );
  // Real CDP click to give the hidden textarea focus, then load known content.
  await browser.drag([screenBox], 30);
  await sleep(300);
  await browser.typeText("clear; seq 1 40");
  await browser.typeText("\r");
  await sleep(1200);

  async function dragAndPaint(rowIndex: number): Promise<{
    draggedOn: string;
    paintedRows: string[];
    zoom: number;
  }> {
    const info = await browser!.evaluate<{ top: number; h: number; text: string }[]>(
      "[...document.querySelector('.xterm-rows').querySelectorAll(':scope > div')].map(d => { const r = d.getBoundingClientRect(); return { top: r.top, h: r.height, text: d.textContent.trim() }; })",
    );
    const row = info[rowIndex];
    if (row === undefined) throw new Error(`row index ${rowIndex} not rendered`);
    const sx = await browser!.evaluate<number>(
      "document.querySelector('.xterm-screen').getBoundingClientRect().x + 40",
    );
    const yc = row.top + row.h * 0.5;
    await browser!.drag(
      [
        { x: sx + 250, y: yc },
        { x: sx + 200, y: yc },
        { x: sx + 150, y: yc },
        { x: sx + 100, y: yc },
        { x: sx + 60, y: yc },
      ],
      40,
    );
    await sleep(300);
    const bands = await browser!.evaluate<{ top: number; bottom: number }[]>(
      "[...(document.querySelector('.xterm-selection') ?? { children: [] }).children].map(d => { const b = d.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; })",
    );
    const painted = info
      .map((r) => ({ text: r.text, y: r.top + r.h * 0.5 }))
      .filter((r) => bands.some((b) => r.y >= b.top && r.y <= b.bottom))
      .map((r) => r.text);
    const zoom = await browser!.evaluate<number>("window.__manifold.viewport().zoom");
    return { draggedOn: row.text, paintedRows: painted, zoom };
  }

  async function assertRow(name: string, rowIndex: number): Promise<void> {
    const result = await dragAndPaint(rowIndex);
    const ok = result.paintedRows.length === 1 && result.paintedRows[0] === result.draggedOn;
    const detail = `dragged on rendered row #${rowIndex} ("${result.draggedOn}") at zoom ${result.zoom.toFixed(2)}, painted [${result.paintedRows.join(", ")}]`;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
    if (!ok) failures.push(`${name}: ${detail}`);
  }

  // Baseline at zoom 1: must always pass.
  for (const rowIndex of [2, 12, 24]) await assertRow(`zoom 1 selects the dragged row`, rowIndex);

  // Zoom the canvas to ~1.2 via Excalidraw's own zoom control.
  for (let i = 0; i < 10; i++) {
    const z = await browser.evaluate<number>("window.__manifold.viewport().zoom");
    if (z >= 1.15 && z <= 1.3) break;
    await browser.evaluate(
      `(() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || '').includes(${z > 1.3 ? "'Zoom out'" : "'Zoom in'"})); b && b.click(); })()`,
    );
    await sleep(350);
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

  // THE REGRESSION: drift grows with distance from the terminal origin.
  for (const rowIndex of [2, 8, 14, 20])
    await assertRow(`zoomed canvas selects the dragged row`, rowIndex);

  // Restore baseline sanity after zooming back out.
  for (let i = 0; i < 12; i++) {
    const z = await browser.evaluate<number>("window.__manifold.viewport().zoom");
    if (Math.abs(z - 1) < 0.06) break;
    await browser.evaluate(
      `(() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || '').includes(${z > 1 ? "'Zoom out'" : "'Zoom in'"})); b && b.click(); })()`,
    );
    await sleep(350);
  }
  await assertRow("zoom restored to 1 selects the dragged row", 12);

  // ---- fork-gate regressions (docs/decisions/0005: re-derived per-element gates) ----

  // Excalidraw binds keydown on its container div (no handleKeyboardGlobally),
  // so keys must be focused + dispatched there, not on document.body.
  const pressKey = (key: string): Promise<unknown> =>
    browser!.evaluate(`(() => {
      const target = document.querySelector('.excalidraw-container') ?? document.body;
      if (target instanceof HTMLElement) target.focus();
      for (const type of ["keydown", "keyup"])
        target.dispatchEvent(new KeyboardEvent(type, { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
    })()`);
  const check = (name: string, ok: boolean, detail: string): void => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
    if (!ok) failures.push(`${name}: ${detail}`);
  };

  // 1. Hover hint: deactivate the embed, hover the terminal center, and assert the
  //    "Click to interact" pill never renders — the fork skips it for
  //    fullInteractionTarget elements (on stock it would appear now that the CSS
  //    override is gone).
  await pressKey("Escape");
  await sleep(300);
  await browser.evaluate(`(() => {
    const r = document.querySelector('.manifold-terminal').getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const el = document.elementFromPoint(cx, cy);
    const o = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
    el.dispatchEvent(new PointerEvent('pointermove', o));
    el.dispatchEvent(new MouseEvent('mouseover', o));
  })()`);
  await sleep(400);
  check(
    "hint suppressed",
    await browser.evaluate<boolean>(
      "document.querySelector('.excalidraw__embeddable-hint') === null",
    ),
    "no .excalidraw__embeddable-hint while hovering a fullInteractionTarget terminal",
  );

  // 2. Style panel gated per-element: box-select the terminal (drag from empty
  //    canvas above-left to below-right of its frame), prove the selection took
  //    (an arrow nudge moves the only live element — readable via the debug seam),
  //    then assert the panel is absent for the terminals-only selection.
  const frame = await browser.evaluate<{ x: number; y: number; w: number; h: number }>(
    "(() => { const r = document.querySelector('.manifold-terminal').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()",
  );
  await browser.drag(
    [
      { x: frame.x - 40, y: frame.y - 40 },
      { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 },
      { x: frame.x + frame.w + 40, y: frame.y + frame.h + 40 },
    ],
    40,
  );
  await sleep(400);
  const liveX = (): Promise<number> =>
    browser!.evaluate<number>("window.__manifold.canvas().filter(e => !e.isDeleted)[0].x");
  const xBefore = await liveX();
  await pressKey("ArrowRight");
  await sleep(250);
  const xAfter = await liveX();
  check(
    "box-select took",
    xAfter !== xBefore,
    `arrow nudge moved the selected terminal (x ${String(xBefore)} -> ${String(xAfter)})`,
  );
  await pressKey("ArrowLeft");
  await sleep(250);
  check(
    "panel gated per-element",
    await browser.evaluate<boolean>("document.querySelector('.selected-shape-actions') === null"),
    "no .selected-shape-actions while only showShapeActions:false terminals are selected",
  );

  // 3. Panel still exists for real shapes — proves the gate is per-element, not
  //    global. Draw a rectangle on empty canvas below the terminal, assert the
  //    panel renders for it, then delete it so it never reaches other assertions.
  await pressKey("Escape");
  await sleep(200);
  const usedToolbar = await browser.evaluate<boolean>(`(() => {
    const b = document.querySelector('[data-testid="toolbar-rectangle"]');
    if (b instanceof HTMLElement) { b.click(); return true; }
    for (const type of ["keydown", "keyup"])
      document.body.dispatchEvent(new KeyboardEvent(type, { key: "r", bubbles: true, cancelable: true }));
    return false;
  })()`);
  await sleep(300);
  await browser.drag(
    [
      { x: frame.x, y: frame.y + frame.h + 50 },
      { x: frame.x + 60, y: frame.y + frame.h + 90 },
      { x: frame.x + 120, y: frame.y + frame.h + 130 },
    ],
    40,
  );
  await sleep(400);
  check(
    "panel exists for shapes",
    await browser.evaluate<boolean>("document.querySelector('.selected-shape-actions') !== null"),
    `style panel renders for a drawn rectangle (tool via ${usedToolbar ? "toolbar" : "keyboard 'r'"})`,
  );
  await pressKey("Delete");
  await sleep(250);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await browser?.close();
  server.kill();
  rmSync(distDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(
  failures.length === 0
    ? "\nterminal-selection gate: GREEN"
    : `\nterminal-selection gate: RED\n${failures.map((f) => ` - ${f}`).join("\n")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
