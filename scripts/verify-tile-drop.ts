/**
 * manifold tile-drop regression gate.
 *
 * Guards the leaf-addressed drop pipeline and its live split preview at the RENDERED
 * boundary. One root cause produced three operator-reported defects — a drop onto a
 * composition was addressed as a canvas ELEMENT instead of a node of a tile tree, and
 * the preview was a rectangle painted over the target instead of the layout that would
 * result. The rounds pin the fixes:
 *
 *   1. DEPTH REACHED — dropping onto the lower half of leaf B of `A | B` produces
 *      `A | (B/C)`: the aimed LEAF splits, never the root.
 *   2. ROOT RING — the outer band of the tile area still targets the root, producing a
 *      root-level split above the existing tree.
 *   3. HIGHLIGHT EQUALS OUTCOME — the slot rect painted before release equals the
 *      newcomer's leaf rect after the commit, within 4px.
 *   4. CHROME EXCLUDED — on a canvas widget the drop geometry measures the tile AREA,
 *      so an aim just below `.flow-portal__strip` resolves at the area's top, not
 *      offset by the strip height.
 *   5. PANES REALLY MOVE — during the hover a pre-existing pane wears a non-identity
 *      transform while its terminal's LAYOUT box is untouched and no `terminal_resize`
 *      frame reaches the wire (transform-not-reflow is the safety property).
 *   6. FIVE ZONES ON A NESTED TILE — leaf B of `A | (B/C)` answers all four bands and
 *      center for a tile carry (swap at center), a seatless carry replaces at center,
 *      and the displaced terminal survives in a fresh home of its own.
 *   7. REMOUNT PROBE — a pane that merely gains a sibling keeps its xterm DOM across
 *      the commit (the Step-10 decision: a changed stamp means the commit remounts).
 *
 * Self-contained: builds the web bundle to a temp dir, spawns its own server + agent,
 * cleans up. Env: MANIFOLD_CHROMIUM (else system chromium).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MachinesResponseSchema,
  ROOT_TILE_ID,
  TerminalsResponseSchema,
  type TerminalSummary,
  type TileLayout,
} from "../packages/protocol/src/index.ts";
import { SessionClient } from "../packages/sdk/src/index.ts";
import { resolveWebDist } from "./gate-dist.ts";
import { Browser, sleep, until } from "./cdp.ts";

const repoRoot = join(import.meta.dir, "..");
const { distDir, cleanup: cleanupDist } = resolveWebDist("manifold-tile-");
const dataDir = mkdtempSync(join(tmpdir(), "manifold-tile-data-"));
const port = 43200 + Math.floor(Math.random() * 2000);
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
let canvasClient: SessionClient | null = null;
let viewClient: SessionClient | null = null;

function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  if (!ok) failures.push(`${name}: ${detail}`);
}

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Polls a rendered condition and ANSWERS instead of throwing, so a miss reads as FAIL. */
async function settles(probe: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() > deadline) return false;
    await sleep(200);
  }
}

const elementRect = (target: Browser, selector: string): Promise<Rect | null> =>
  target.evaluate<Rect | null>(
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (node === null) return null;
      const box = node.getBoundingClientRect();
      return { left: box.left, top: box.top, width: box.width, height: box.height };
    })()`,
  );

/** One mid-drag observation: the slot, the written pane transforms, and a custom extra. */
interface HoverSample {
  readonly present: boolean;
  readonly rect: Rect | null;
  readonly className: string;
  readonly transforms: Record<string, string>;
  readonly extra: unknown;
}

interface DragSequenceOutcome {
  readonly ok: boolean;
  /** The drop target claimed the release (`preventDefault`); false when aborted. */
  readonly accepted: boolean;
  readonly samples: readonly (HoverSample | null)[];
}

/**
 * One HTML5 drag visiting several hover stops, sampling the preview after each, then
 * releasing at the last stop or aborting. Chromium's drag controller is not reachable
 * through CDP mouse input under `--headless=new`, so the gesture is dispatched as real
 * DragEvents sharing ONE DataTransfer — the payload still comes from the application's
 * own `dragstart` handler, so the envelope contract stays under test.
 */
async function dragSequence(
  target: Browser,
  source: string,
  area: string,
  stops: readonly {
    readonly selector: string;
    readonly fx: number;
    readonly fy: number;
    readonly holdMs: number;
  }[],
  release: boolean,
  extraJs = "() => null",
): Promise<DragSequenceOutcome> {
  return await target.evaluate<DragSequenceOutcome>(
    `(async () => {
      const from = document.querySelector(${JSON.stringify(source)});
      if (from === null) return { ok: false, accepted: false, samples: [] };
      const transfer = new DataTransfer();
      const fire = (node, type, x, y) => {
        const event = new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          dataTransfer: transfer,
          clientX: x,
          clientY: y,
        });
        node.dispatchEvent(event);
        return event;
      };
      const wait = (ms) => {
        const gate = Promise.withResolvers();
        setTimeout(gate.resolve, ms);
        return gate.promise;
      };
      const grab = from.getBoundingClientRect();
      fire(from, 'dragstart', grab.left + 4, grab.top + 4);
      const samples = [];
      let last = null;
      let lastNode = null;
      for (const stop of ${JSON.stringify(stops)}) {
        const onto = document.querySelector(stop.selector);
        if (onto === null) { samples.push(null); continue; }
        /*
          Zones resolve in the AREA's stable geometry while the FLIP has visually moved
          the panes — the vacated space is exactly where the slot paints — so hover
          coordinates must come from the UNTRANSFORMED boxes, the way a pointer's
          position is judged by the app. A previous stop's transforms are lifted for
          the measurement (transitions suppressed, or the rect reads a mid-flight
          animation value) and restored verbatim.
        */
        const lifted = [];
        for (let el = onto; el !== null && el !== document.body; el = el.parentElement) {
          if (el.hasAttribute('data-tile-id') && el.style.transform !== '') {
            lifted.push([el, el.style.transform]);
            el.style.transition = 'none';
            el.style.transform = 'none';
          }
        }
        const box = onto.getBoundingClientRect();
        for (const [el, transform] of lifted) {
          el.style.transform = transform;
          el.style.transition = '';
        }
        const x = box.left + box.width * stop.fx;
        const y = box.top + box.height * stop.fy;
        fire(onto, 'dragenter', x, y);
        fire(onto, 'dragover', x, y);
        await wait(stop.holdMs);
        fire(onto, 'dragover', x, y);
        await wait(80);
        const areaEl = document.querySelector(${JSON.stringify(area)});
        const slot = areaEl === null ? null : areaEl.querySelector('.tile-preview');
        const rect = slot === null ? null : (() => {
          const b = slot.getBoundingClientRect();
          return { left: b.left, top: b.top, width: b.width, height: b.height };
        })();
        const transforms = {};
        if (areaEl !== null) {
          for (const el of areaEl.querySelectorAll('[data-tile-id]')) {
            if (el.style.transform !== '') transforms[el.getAttribute('data-tile-id')] = el.style.transform;
          }
        }
        samples.push({
          present: slot !== null,
          rect,
          className: slot === null ? '' : slot.className,
          transforms,
          extra: (${extraJs})(),
        });
        last = { x, y };
        lastNode = onto;
      }
      let accepted = false;
      if (${String(release)} && lastNode !== null && last !== null) {
        const released = fire(lastNode, 'drop', last.x, last.y);
        accepted = released.defaultPrevented;
      }
      fire(from, 'dragend', last === null ? 0 : last.x, last === null ? 0 : last.y);
      return { ok: true, accepted, samples };
    })()`,
  );
}

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

  const listTerminals = async (): Promise<readonly TerminalSummary[]> =>
    TerminalsResponseSchema.parse(
      await (await fetch(`${origin}/api/terminals`, { headers: httpHeaders })).json(),
    ).terminals;
  const nameTerminal = async (terminalId: string, name: string): Promise<void> => {
    const renamed = await fetch(`${origin}/api/terminals/${terminalId}`, {
      method: "PATCH",
      headers: httpHeaders,
      body: JSON.stringify({ name }),
    });
    if (!renamed.ok) throw new Error(`could not name the terminal ${name}`);
  };
  const place = async (surface: unknown, destination: unknown): Promise<Response> =>
    await fetch(`${origin}/api/place`, {
      method: "POST",
      headers: httpHeaders,
      body: JSON.stringify({ surface, destination }),
    });

  const created = await fetch(`${origin}/api/pads`, {
    method: "POST",
    headers: httpHeaders,
    body: JSON.stringify({ name: "tile-drop-gate" }),
  });
  const canvasPadId = ((await created.json()) as { pad: { id: string } }).pad.id;

  // The local agent must be enrolled and online before a terminal can be born.
  let machineId = "";
  await until(
    async () => {
      const machines = MachinesResponseSchema.parse(
        await (await fetch(`${origin}/api/machines`, { headers: httpHeaders })).json(),
      ).machines;
      machineId = machines.find((machine) => machine.online)?.id ?? "";
      return machineId !== "";
    },
    30_000,
    "local agent online",
  );

  canvasClient = new SessionClient({
    url: `${origin.replace(/^http/, "ws")}/ws/session`,
    padId: canvasPadId,
    token: ownerKey,
  });
  await canvasClient.connect();

  /** A terminal born through the SDK; nothing is authored, so it starts UNPLACED. */
  const bornTerminal = async (name: string): Promise<{ id: string; homeId: string }> => {
    const session = await canvasClient!.openTerminal({
      elementId: crypto.randomUUID(),
      cols: 80,
      rows: 24,
      machineId,
    });
    await nameTerminal(session.id, name);
    return { id: session.id, homeId: session.padId };
  };

  const termA = await bornTerminal("gate-A");
  const termB = await bornTerminal("gate-B");
  const termC = await bornTerminal("gate-C");
  const viewId = termA.homeId;

  // `A | B`: terminal B merges into A's home, absorbing B's own.
  const merged = await place(
    { kind: "terminal", sessionId: termB.id },
    { kind: "tile", padId: viewId, targetTileId: ROOT_TILE_ID, edge: "right" },
  );
  if (!merged.ok) throw new Error("could not merge B into A's composition");

  viewClient = new SessionClient({
    url: `${origin.replace(/^http/, "ws")}/ws/session`,
    padId: viewId,
    token: ownerKey,
  });
  await viewClient.connect();
  const layoutNow = (): TileLayout => viewClient?.layout() ?? {};
  const leafOf = (sessionId: string): string =>
    Object.values(layoutNow()).find(
      (node) =>
        node.dir === null &&
        node.surface?.kind === "terminal" &&
        node.surface.sessionId === sessionId,
    )?.id ?? "";
  await until(() => leafOf(termB.id) !== "", 10_000, "merged layout visible to SDK");
  const leafA = leafOf(termA.id);
  const leafB = leafOf(termB.id);

  browser = new Browser();
  await browser.launch(9377);
  await browser.goto(`${origin}/#key=${ownerKey}`);
  if (await browser.evaluate<boolean>("document.querySelector('input') !== null")) {
    await browser.typeInto("input", "tile-drop-gate");
    await browser.clickText("Enter manifold");
  }
  await browser.goto(`${origin}/p/${viewId}`);
  await until(
    () => browser!.evaluate<boolean>("document.querySelectorAll('.tiled-leaf').length === 2"),
    20_000,
    "composition route mounted with two leaves",
  );
  await until(
    () =>
      browser!.evaluate<boolean>(
        `document.querySelector('.pad-tree-item[data-tree-id="${termC.homeId}"] .session-state') !== null`,
      ),
    20_000,
    "terminal C's sidebar row",
  );
  // Both terminals must have a live xterm before the remount probe can stamp them.
  await until(
    () =>
      browser!.evaluate<boolean>(`document.querySelectorAll('.tiled-leaf .xterm').length === 2`),
    20_000,
    "both terminals rendered",
  );

  /* ── Rounds 1 + 3 + 5 + 7 ride one gesture: C dropped on the lower half of B ── */

  // Round 5's spy and round 7's stamp go in before the gesture.
  await browser.evaluate(
    `(() => {
      window.__resizeFrames = [];
      const original = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === 'string' && data.includes('terminal_resize')) {
          window.__resizeFrames.push(data);
        }
        return original.call(this, data);
      };
      const keeper = document.querySelector('[data-tile-id="${leafB}"] .xterm');
      if (keeper !== null) keeper.setAttribute('data-mount-probe', 'keep-b');
      return null;
    })()`,
  );

  const drop1 = await dragSequence(
    browser,
    `.pad-tree-item[data-tree-id="${termC.homeId}"]`,
    ".tile-area",
    [{ selector: `[data-tile-id="${leafB}"]`, fx: 0.5, fy: 0.85, holdMs: 250 }],
    true,
    `() => {
      const pane = document.querySelector('[data-tile-id="${leafB}"] .xterm');
      return {
        resizeFrames: window.__resizeFrames.length,
        paneW: pane === null ? -1 : pane.offsetWidth,
        paneH: pane === null ? -1 : pane.offsetHeight,
      };
    }`,
  );
  const hover1 = drop1.samples[0] ?? null;
  check("gesture accepted", drop1.ok && drop1.accepted, "C released on B's lower half");

  const settled1 = await settles(() => {
    const layout = layoutNow();
    return leafOf(termC.id) !== "" && Object.values(layout).length > 3;
  }, 10_000);
  check("commit lands", settled1, "layout gained C's leaf");
  const layout1 = layoutNow();
  const leafC = leafOf(termC.id);
  const parentOf = (layout: TileLayout, tileId: string): string =>
    Object.values(layout).find((node) => node.children.includes(tileId))?.id ?? "";
  const wrapper = parentOf(layout1, leafB);
  check(
    "depth reached",
    wrapper !== "" &&
      wrapper !== ROOT_TILE_ID &&
      layout1[wrapper]?.dir === "column" &&
      (layout1[wrapper]?.children.join(",") ?? "") === `${leafB},${leafC}` &&
      layout1[ROOT_TILE_ID]?.children.length === 2,
    `B's parent ${wrapper} is a column of [B, C] and the root still has two children (defect 3)`,
  );

  const paneC = await elementRect(browser, `[data-tile-id="${leafC}"]`);
  const slotDrift =
    hover1?.rect == null || paneC === null
      ? Number.POSITIVE_INFINITY
      : Math.max(
          Math.abs(hover1.rect.left - paneC.left),
          Math.abs(hover1.rect.top - paneC.top),
          Math.abs(hover1.rect.width - paneC.width),
          Math.abs(hover1.rect.height - paneC.height),
        );
  check(
    "highlight equals outcome",
    slotDrift <= 4,
    `slot rect vs C's landed leaf drift ${slotDrift.toFixed(1)}px (≤4; defect 1)`,
  );

  const extras1 = (hover1?.extra ?? null) as {
    resizeFrames: number;
    paneW: number;
    paneH: number;
  } | null;
  const shifted = hover1?.transforms[leafB] ?? "";
  const paneBBefore = await browser.evaluate<{ w: number; h: number } | null>(
    `(() => {
      const pane = document.querySelector('[data-tile-id="${leafB}"] .xterm');
      return pane === null ? null : { w: pane.offsetWidth, h: pane.offsetHeight };
    })()`,
  );
  void paneBBefore;
  check(
    "panes really move",
    shifted !== "" && shifted.includes("translate") && shifted.includes("scale"),
    `B's pane wore ${shifted === "" ? "no transform" : shifted} during the hover`,
  );
  check(
    "transform, not reflow",
    extras1 !== null && extras1.resizeFrames === 0 && extras1.paneW > 0,
    `terminal layout box ${String(extras1?.paneW)}×${String(extras1?.paneH)} with ${String(extras1?.resizeFrames)} terminal_resize frames mid-hover`,
  );

  const probe = await browser.evaluate<string>(
    `document.querySelector('[data-tile-id="${leafB}"] .xterm')?.getAttribute('data-mount-probe') ?? ''`,
  );
  check(
    "no remount on commit",
    probe === "keep-b",
    probe === "keep-b"
      ? "the pre-existing pane kept its xterm DOM across the split"
      : "the split REMOUNTED the pre-existing pane's xterm (Step 10 fix required)",
  );

  /* ── Round 6: five zones on nested leaf B of `A | (B/C)` ── */

  const zones = await dragSequence(
    browser,
    `[data-tile-id="${leafA}"] .tiled-leaf__grip`,
    ".tile-area",
    [
      { selector: `[data-tile-id="${leafB}"]`, fx: 0.08, fy: 0.5, holdMs: 120 },
      { selector: `[data-tile-id="${leafB}"]`, fx: 0.92, fy: 0.5, holdMs: 120 },
      { selector: `[data-tile-id="${leafB}"]`, fx: 0.5, fy: 0.14, holdMs: 120 },
      { selector: `[data-tile-id="${leafB}"]`, fx: 0.5, fy: 0.86, holdMs: 120 },
      { selector: `[data-tile-id="${leafB}"]`, fx: 0.5, fy: 0.5, holdMs: 120 },
      // The carry's own leaf answers nothing: the slot idles instead of lying.
      { selector: `[data-tile-id="${leafA}"]`, fx: 0.5, fy: 0.5, holdMs: 120 },
    ],
    false,
  );
  const zoneSamples = zones.samples;
  const edgeSamples = zoneSamples.slice(0, 4);
  const centerSample = zoneSamples[4] ?? null;
  const ownLeafSample = zoneSamples[5] ?? null;
  check(
    "four bands place",
    zones.ok &&
      edgeSamples.every(
        (sample) =>
          sample !== null &&
          sample.present &&
          !sample.className.includes("is-swap") &&
          !sample.className.includes("is-denied") &&
          !sample.className.includes("is-idle"),
      ),
    "all four bands of nested leaf B painted a live place slot for a tile carry",
  );
  check(
    "center swaps for a tile carry",
    centerSample !== null && centerSample.present && centerSample.className.includes("is-swap"),
    `center slot classes: ${centerSample?.className ?? "absent"}`,
  );
  check(
    "own leaf offers nothing",
    ownLeafSample !== null &&
      (!ownLeafSample.present || ownLeafSample.className.includes("is-idle")),
    "every zone over the carry's own leaf resolves to null",
  );
  const layoutAfterAbort = layoutNow();
  check(
    "abort mutates nothing",
    JSON.stringify(layoutAfterAbort) === JSON.stringify(layout1),
    "the aborted tile carry left the layout untouched",
  );

  // The seatless half: a sidebar terminal on B's center replaces, re-homing B.
  const termD = await bornTerminal("gate-D");
  await until(
    () =>
      browser!.evaluate<boolean>(
        `document.querySelector('.pad-tree-item[data-tree-id="${termD.homeId}"] .session-state') !== null`,
      ),
    20_000,
    "terminal D's sidebar row",
  );
  const replaceDrop = await dragSequence(
    browser,
    `.pad-tree-item[data-tree-id="${termD.homeId}"]`,
    ".tile-area",
    [{ selector: `[data-tile-id="${leafB}"]`, fx: 0.5, fy: 0.5, holdMs: 250 }],
    true,
  );
  const replaceSample = replaceDrop.samples[0] ?? null;
  check(
    "center replaces for a seatless carry",
    replaceSample !== null &&
      replaceSample.present &&
      replaceSample.className.includes("is-replace"),
    `center slot classes for a sidebar carry: ${replaceSample?.className ?? "absent"}`,
  );
  const replaced = await settles(
    () => layoutNow()[leafB]?.surface?.kind === "terminal" && leafOf(termD.id) === leafB,
    10_000,
  );
  check("replace re-seats the leaf", replaced, "D took B's exact leaf");
  const terminalsAfterReplace = await listTerminals();
  const rowB = terminalsAfterReplace.find((terminal) => terminal.id === termB.id) ?? null;
  check(
    "displaced terminal survives",
    rowB !== null && rowB.homeId !== viewId,
    rowB === null
      ? "terminal B vanished from the index"
      : `B lives on, re-homed into ${rowB.homeId}`,
  );

  /* ── Round 2: the root ring ── */

  const homeBAfter = rowB?.homeId ?? "";
  await until(
    () =>
      browser!.evaluate<boolean>(
        `document.querySelector('.pad-tree-item[data-tree-id="${homeBAfter}"] .session-state') !== null`,
      ),
    20_000,
    "displaced B's sidebar row",
  );
  const ringDrop = await dragSequence(
    browser,
    `.pad-tree-item[data-tree-id="${homeBAfter}"]`,
    ".tile-area",
    [{ selector: ".tile-area", fx: 0.5, fy: 0.985, holdMs: 250 }],
    true,
  );
  const ringSample = ringDrop.samples[0] ?? null;
  const areaRect = await elementRect(browser, ".tile-area");
  const ringSlotFullWidth =
    ringSample?.rect != null &&
    areaRect !== null &&
    Math.abs(ringSample.rect.width - areaRect.width) <= 4 &&
    ringSample.rect.top > areaRect.top + areaRect.height * 0.4;
  check(
    "root ring previews a root split",
    ringSlotFullWidth,
    "the outer band painted a full-width bottom slot",
  );
  const rootSplit = await settles(() => {
    const layout = layoutNow();
    const root = layout[ROOT_TILE_ID];
    return (
      root?.dir === "column" &&
      root.children.length === 2 &&
      layout[root.children[0] ?? ""]?.dir === "row" &&
      leafOf(termB.id) === root.children[1]
    );
  }, 10_000);
  check(
    "root ring lands a root split",
    rootSplit,
    rootSplit
      ? "the root became a column whose first child is the old row split and second is B"
      : `unexpected layout ${JSON.stringify(layoutNow())}`,
  );

  /* ── Round 4: chrome excluded on a canvas widget ── */

  const portaled = await place(
    { kind: "pad", padId: viewId },
    { kind: "canvas", padId: canvasPadId, x: 160, y: 120 },
  );
  const portalBody = (await portaled.json()) as { elementId?: string };
  const widgetElementId = portalBody.elementId ?? "";
  check("widget authored", portaled.ok && widgetElementId !== "", "portal onto the composition");

  await browser.goto(`${origin}/p/${canvasPadId}`);
  const widgetSelector = `.react-flow__node[data-id="${widgetElementId}"]`;
  await until(
    () =>
      browser!.evaluate<boolean>(
        `document.querySelector('${widgetSelector} .tile-area [data-tile-id]') !== null`,
      ),
    20_000,
    "widget mounted with its live tree",
  );
  const termE = await bornTerminal("gate-E");
  await until(
    () =>
      browser!.evaluate<boolean>(
        `document.querySelector('.pad-tree-item[data-tree-id="${termE.homeId}"] .session-state') !== null`,
      ),
    20_000,
    "terminal E's sidebar row",
  );
  const widgetHover = await dragSequence(
    browser,
    `.pad-tree-item[data-tree-id="${termE.homeId}"]`,
    `${widgetSelector} .tile-area`,
    // Just below the strip: inside the top leaf's band, outside the root ring.
    [{ selector: `${widgetSelector} .flow-portal__viewport`, fx: 0.3, fy: 0.1, holdMs: 400 }],
    false,
  );
  const widgetSample = widgetHover.samples[0] ?? null;
  const viewportRect = await elementRect(browser, `${widgetSelector} .flow-portal__viewport`);
  const widgetAreaRect = await elementRect(browser, `${widgetSelector} .tile-area`);
  const stripRect = await elementRect(browser, `${widgetSelector} .flow-portal__strip`);
  const topAligned =
    widgetSample?.rect != null &&
    viewportRect !== null &&
    widgetAreaRect !== null &&
    Math.abs(widgetSample.rect.top - viewportRect.top) <= 2 &&
    Math.abs(widgetAreaRect.top - viewportRect.top) <= 2 &&
    (stripRect === null || widgetSample.rect.top >= stripRect.top + stripRect.height - 2);
  check(
    "chrome excluded",
    topAligned,
    `slot top ${String(widgetSample?.rect?.top)} vs viewport top ${String(viewportRect?.top)} — the strip no longer skews the zones (defect 2)`,
  );

  /* ── Flat inserts (#60): dividers are drop targets, same-axis edges join the row ── */

  await browser.goto(`${origin}/p/${viewId}`);
  await until(
    () => browser!.evaluate<boolean>("document.querySelector('.tile-area') !== null"),
    20_000,
    "route remounted for flat-insert rounds",
  );
  const termF = await bornTerminal("gate-F");
  await until(
    () =>
      browser!.evaluate<boolean>(
        `document.querySelector('.pad-tree-item[data-tree-id="${termF.homeId}"] .session-state') !== null`,
      ),
    20_000,
    "terminal F's sidebar row",
  );
  // The root is a column of [old row, B]; its horizontal seam sits at half height.
  const rootBefore = layoutNow()[ROOT_TILE_ID];
  const seamDrop = await dragSequence(
    browser,
    `.pad-tree-item[data-tree-id="${termF.homeId}"]`,
    ".tile-area",
    [{ selector: ".tile-area", fx: 0.5, fy: 0.5, holdMs: 250 }],
    true,
  );
  check(
    "seam previews an insert between",
    seamDrop.ok && (seamDrop.samples[0]?.present ?? false),
    "the divider painted a live slot between its two siblings",
  );
  const seamLanded = await settles(() => {
    const root = layoutNow()[ROOT_TILE_ID];
    return (
      root?.dir === "column" && root.children.length === 3 && leafOf(termF.id) === root.children[1]
    );
  }, 10_000);
  check(
    "seam drop lands a flat sibling",
    seamLanded && rootBefore?.children.length === 2,
    `the root column went ${String(rootBefore?.children.length)} -> 3 children with F in the middle — no wrapper split`,
  );
  // The seam drop is the BETWEEN gesture on the wire: both neighbors ceded a third.
  const seamRatios = layoutNow()[ROOT_TILE_ID]?.ratios ?? [];
  check(
    "seam drop wedges with thirds",
    seamRatios.length === 3 && seamRatios.every((ratio) => Math.abs(ratio - 1 / 3) < 1e-6),
    `root ratios ${JSON.stringify(seamRatios)} after the seam drop — both neighbors ceded (#60)`,
  );

  const termG = await bornTerminal("gate-G");
  await until(
    () =>
      browser!.evaluate<boolean>(
        `document.querySelector('.pad-tree-item[data-tree-id="${termG.homeId}"] .session-state') !== null`,
      ),
    20_000,
    "terminal G's sidebar row",
  );
  const leafBNow = leafOf(termB.id);
  const bandDrop = await dragSequence(
    browser,
    `.pad-tree-item[data-tree-id="${termG.homeId}"]`,
    ".tile-area",
    // B's bottom band runs the parent column's own axis: it joins the row, not nests.
    [{ selector: `[data-tile-id="${leafBNow}"]`, fx: 0.5, fy: 0.9, holdMs: 250 }],
    true,
  );
  const bandLanded = await settles(() => {
    const root = layoutNow()[ROOT_TILE_ID];
    return (
      root?.dir === "column" && root.children.length === 4 && leafOf(termG.id) === root.children[3]
    );
  }, 10_000);
  check(
    "same-axis band joins the row flat",
    bandDrop.ok && bandLanded,
    "B's bottom band appended a FOURTH column sibling instead of nesting a two-way split",
  );

  /*
    Ratios are RELATIVE and a removal from an N-wide split legitimately leaves their
    sum below 1. Flexbox only distributes ALL free space when grow factors reach 1,
    so an unnormalized renderer paints a dead band where the missing fraction was —
    the operator-reported ghost black square. The renderer normalizes; this pins it.
  */
  viewClient?.setTileRatios(ROOT_TILE_ID, [0.1, 0.1, 0.1, 0.1]);
  await sleep(800);
  const fill = await browser.evaluate<{ root: number; last: number } | null>(
    `(() => {
      const root = document.querySelector('.tile-area [data-tile-id="root"]');
      if (root === null) return null;
      const panes = [...root.children].filter((el) => el.hasAttribute('data-tile-id'));
      const lastPane = panes[panes.length - 1];
      if (lastPane === undefined) return null;
      return {
        root: root.getBoundingClientRect().bottom,
        last: lastPane.getBoundingClientRect().bottom,
      };
    })()`,
  );
  check(
    "a ratio sum below 1 still fills the area",
    fill !== null && Math.abs(fill.root - fill.last) <= 4,
    `last pane bottom ${String(fill?.last)} vs area bottom ${String(fill?.root)} after ratios [0.1 × 4] — no ghost band`,
  );
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  viewClient?.close();
  canvasClient?.close();
  await browser?.close();
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
  cleanupDist();
}

console.log(
  failures.length === 0
    ? "\ntile-drop gate: GREEN"
    : `\ntile-drop gate: RED\n${failures.map((f) => ` - ${f}`).join("\n")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
