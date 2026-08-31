/**
 * manifold terminal-mirror regression gate.
 *
 * Guards the mirrored-terminal contract at the RENDERED boundary: two canvas
 * references can portal onto the same terminal's home composition, producing two
 * live viewports over one PTY. The regression this pins: the SDK sent
 * `terminal_attach` only on the 0→1 refcount transition, so a view subscribing
 * after the first snapshot never received screen state and rendered as an empty
 * "zombie" that ignored live output.
 *
 * Asserted end to end in REAL browsers — two of them, because the composition contract
 * is about what a COLLABORATOR sees and only a second rendered canvas can prove that:
 *   1. the clone renders screen state that existed BEFORE it was created;
 *   2. live output mirrors to both views;
 *   3. after a reload both views render (no mount-race zombie);
 *   4. the mono portal's chrome is a real POINTER ref — the terminal's own titlebar is
 *      the node's bar and drag handle, and its controls are clickable without JavaScript
 *      reaching past `pointer-events`;
 *   5. unplacing one mirror removes only that REFERENCE: the other view stays live and
 *      typeable, because a reference is not the terminal and the terminal never left
 *      the composition it lives in;
 *   6. unplacing the LAST reference leaves the terminal alive and UNPLACED, and the index
 *      resurfaces it as a top-level row (the INDEX VISIBILITY RULE: top level is homes
 *      and the homeless);
 *   7. a canvas snapped into a tile renders its live canvas, not a name card;
 *   8. composition by drag: holding a terminal over another morphs the target into
 *      container chrome with a snap preview, the release births ONE composition named
 *      after both refs over the target's geometry, both terminals render LIVE inside
 *      the resulting portal, ENTERING it navigates to its own renderer with screen state
 *      intact, and dragging a tile back out onto the canvas re-homes that terminal into a
 *      fresh solo composition which the canvas portals at the drop point, while the source
 *      composition keeps the item it still holds.
 *
 * The second mirror is created through the production SDK. Canvas gesture policy
 * is separate from the attach/refcount contract under test.
 *
 * Self-contained: builds the web bundle to a temp dir, spawns its own server +
 * agent, cleans up. Env: MANIFOLD_CHROMIUM (else system chromium).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionOutcomeSchema,
  ContainerResponseSchema,
  ContainersResponseSchema,
  TerminalsResponseSchema,
  type SceneElement,
  type TerminalSummary,
} from "../packages/protocol/src/index.ts";
import { SessionClient } from "../packages/sdk/src/index.ts";
import { resolveWebDist } from "./gate-dist.ts";
import { Browser, sleep, until } from "./cdp.ts";

const repoRoot = join(import.meta.dir, "..");
const { distDir, cleanup: cleanupDist } = resolveWebDist("manifold-mir-");
const dataDir = mkdtempSync(join(tmpdir(), "manifold-mir-data-"));
const port = 41000 + Math.floor(Math.random() * 2000);
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
/** The collaborator: a second real browser parked on the origin canvas. */
let watcher: Browser | null = null;
let observer: SessionClient | null = null;
let embedded: SessionClient | null = null;
let composed: SessionClient | null = null;

function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  if (!ok) failures.push(`${name}: ${detail}`);
}

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Polls a rendered condition and ANSWERS instead of throwing, so a miss reads as FAIL. */
async function settles(probe: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() > deadline) return false;
    await sleep(200);
  }
}

const nodeRect = (target: Browser, elementId: string): Promise<Rect | null> =>
  target.evaluate<Rect | null>(
    `(() => {
      const node = document.querySelector('.react-flow__node[data-id="${elementId}"]');
      if (node === null) return null;
      const box = node.getBoundingClientRect();
      return { left: box.left, top: box.top, width: box.width, height: box.height };
    })()`,
  );

const rectDrift = (a: Rect | null, b: Rect | null): number =>
  a === null || b === null
    ? Number.POSITIVE_INFINITY
    : Math.max(
        Math.abs(a.left - b.left),
        Math.abs(a.top - b.top),
        Math.abs(a.width - b.width),
        Math.abs(a.height - b.height),
      );

/** A viewport point inside an element's box, in fractions of its own width and height. */
const pointIn = (
  target: Browser,
  selector: string,
  fx: number,
  fy: number,
): Promise<Point | null> =>
  target.evaluate<Point | null>(
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (node === null) return null;
      const box = node.getBoundingClientRect();
      return { x: box.left + box.width * ${String(fx)}, y: box.top + box.height * ${String(fy)} };
    })()`,
  );

/**
 * A held-open pointer gesture. `Browser.drag` releases at the end of its point list, but
 * the compose contract lives MID-drag — the view-chrome morph and its snap preview exist
 * only while the pointer is held over the target — so the phases are driven separately.
 */
async function pressAt(target: Browser, at: Point): Promise<void> {
  await target.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  await target.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: at.x,
    y: at.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
}

async function moveTo(target: Browser, at: Point): Promise<void> {
  await target.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: at.x,
    y: at.y,
    button: "left",
    buttons: 1,
  });
}

async function releaseAt(target: Browser, at: Point): Promise<void> {
  await target.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: at.x,
    y: at.y,
    button: "left",
    clickCount: 1,
  });
}

/**
 * One REAL pointer click. Distinct from `element.click()`, which reaches a listener even
 * through `pointer-events: none` — the difference is exactly how the canvas terminal's
 * titlebar became inert (a mono portal is not a `.canvas-terminal`, and the rules that made
 * the bar take the pointer were scoped to that retired node type) while every
 * synthetic-click assertion in this gate stayed green.
 */
async function clickAt(target: Browser, at: Point): Promise<void> {
  await pressAt(target, at);
  await releaseAt(target, at);
}

interface NativeDragOutcome {
  /** Both ends of the gesture were found in the DOM. */
  readonly ok: boolean;
  /** Mimes the SOURCE authored — the drag payload contract, not this script's guess. */
  readonly types: readonly string[];
  /** The drop target claimed the release (`preventDefault`). */
  readonly accepted: boolean;
}

/**
 * One HTML5 drag. Chromium's drag controller is not reachable through CDP mouse input
 * under `--headless=new`, so the gesture is dispatched as real DragEvents that share ONE
 * DataTransfer. The payload still comes from the application — the source row's own
 * `dragstart` handler writes it — so the mime contract stays under test.
 */
async function nativeDrag(
  target: Browser,
  source: string,
  drop: { readonly selector: string; readonly fx: number; readonly fy: number },
  holdMs = 250,
): Promise<NativeDragOutcome> {
  return await target.evaluate<NativeDragOutcome>(
    `(async () => {
      const from = document.querySelector(${JSON.stringify(source)});
      const onto = document.querySelector(${JSON.stringify(drop.selector)});
      if (from === null || onto === null) return { ok: false, types: [], accepted: false };
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
      const grab = from.getBoundingClientRect();
      fire(from, 'dragstart', grab.left + 4, grab.top + 4);
      const types = [...transfer.types];
      const box = onto.getBoundingClientRect();
      const x = box.left + box.width * ${String(drop.fx)};
      const y = box.top + box.height * ${String(drop.fy)};
      fire(onto, 'dragenter', x, y);
      fire(onto, 'dragover', x, y);
      const hold = Promise.withResolvers();
      setTimeout(hold.resolve, ${String(holdMs)});
      await hold.promise;
      fire(onto, 'dragover', x, y);
      const released = fire(onto, 'drop', x, y);
      fire(from, 'dragend', x, y);
      return { ok: true, types, accepted: released.defaultPrevented };
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

  /**
   * The whole terminal index, which is where "unplaced" is answered from — and a DOOR, like
   * every other read in the wave: `core.terminals.listAll` answers an outcome envelope.
   */
  const listTerminals = async (): Promise<readonly TerminalSummary[]> => {
    const listed = await fetch(`${origin}/api/actions/core.terminals.listAll`, {
      method: "POST",
      headers: httpHeaders,
      body: "{}",
    });
    const outcome = ActionOutcomeSchema.parse(await listed.json());
    if (!outcome.ok) throw new Error(`terminal index refused: ${outcome.denial.message}`);
    return TerminalsResponseSchema.parse(outcome.result).terminals;
  };
  /**
   * A canvas element names the CONTAINER a terminal lives in, never the terminal, so the
   * id `core.terminals.rename` takes is read back from the home index.
   */
  const terminalHomedIn = async (containerId: string): Promise<string> =>
    (await listTerminals()).find((terminal) => terminal.homeId === containerId)?.id ?? "";
  const nameTerminal = async (terminalId: string, name: string): Promise<void> => {
    const renamed = await fetch(`${origin}/api/actions/core.terminals.rename`, {
      method: "POST",
      headers: httpHeaders,
      body: JSON.stringify({ terminalId: terminalId, name }),
    });
    // The action door answers 200 even for a refusal, so the outcome decides, not the status.
    const outcome = ActionOutcomeSchema.parse(await renamed.json());
    if (!outcome.ok) throw new Error(`could not name the terminal ${name}`);
  };

  const createContainer = async (name: string, layout?: "composition"): Promise<string> => {
    const created = await fetch(`${origin}/api/actions/core.index.createContainer`, {
      method: "POST",
      headers: httpHeaders,
      body: JSON.stringify({ name, ...(layout === undefined ? {} : { layout }) }),
    });
    const outcome = ActionOutcomeSchema.parse(await created.json());
    if (!outcome.ok) throw new Error(`createContainer refused: ${outcome.denial.message}`);
    return ContainerResponseSchema.parse(outcome.result).container.id;
  };

  const containerId = await createContainer("terminal-mirror-gate");

  browser = new Browser();
  await browser.launch(9345);
  await browser.goto(`${origin}/#key=${ownerKey}`);
  if (await browser.evaluate<boolean>("document.querySelector('input') !== null")) {
    await browser.typeInto("input", "mirror-gate");
    await browser.clickText("Enter manifold");
  }
  await browser.goto(`${origin}/p/${containerId}`);
  await until(
    () => browser!.evaluate<boolean>("document.querySelector('.react-flow') !== null"),
    20_000,
    "canvas mounted",
  );

  await until(
    () =>
      browser!.evaluate<boolean>(
        "document.querySelector('[data-testid=machines-section] > summary') !== null",
      ),
    20_000,
    "sidebar machine section",
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
  await sleep(600);

  const center = () =>
    browser!.evaluate<{ x: number; y: number }>(
      "(() => { const b = document.querySelector('.terminal-frame').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()",
    );
  const showing = (marker: string) =>
    browser!.evaluate<boolean[]>(
      `[...document.querySelectorAll('.terminal-frame')].map(t => (t.querySelector('.xterm-rows')?.textContent || '').includes('${marker}'))`,
    );
  const termCount = () =>
    browser!.evaluate<number>("document.querySelectorAll('.terminal-frame').length");

  // Screen state that must exist BEFORE the clone is born.
  const c0 = await center();
  await browser.drag([c0], 30); // click-to-focus
  await sleep(500);
  await browser.typeText("clear; echo PRE_CLONE_STATE");
  await browser.typeText("\r");
  await until(
    async () => (await showing("PRE_CLONE_STATE"))[0] === true,
    8_000,
    "marker rendered before clone",
  );

  // Create a second canvas reference onto the same home composition through the SDK.
  // Two portals onto one solo composition are two viewports over one PTY, which is the
  // whole mirror contract: the terminal itself never has more than one home.
  observer = new SessionClient({
    url: `${origin.replace(/^http/, "ws")}/ws/session`,
    containerId,
    token: ownerKey,
    reconnect: false,
  });
  await observer.connect();
  await until(() => observer!.elements.size === 1, 10_000, "terminal visible to mirror client");
  const source = [...observer.elements.values()][0];
  if (source?.type !== "portal") throw new Error("source portal missing from canonical scene");
  const clone = {
    ...source,
    id: crypto.randomUUID(),
    x: source.x + 120,
    y: source.y + 80,
  };
  observer.transact((tx) => tx.create(clone));
  await until(async () => (await termCount()) === 2, 10_000, "SDK update produced a mirror");
  await sleep(1200);

  // 1. The clone must render PRE-EXISTING screen state (the zombie regression).
  const pre = await showing("PRE_CLONE_STATE");
  check(
    "clone renders pre-existing screen state",
    pre.length === 2 && pre.every(Boolean),
    `views showing marker: [${pre.join(", ")}]`,
  );

  // 2. Live output mirrors to both views.
  const first = await browser.evaluate<{ x: number; y: number }>(
    "(() => { const b = document.querySelectorAll('.terminal-frame')[0].getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()",
  );
  await browser.drag([first], 30);
  await sleep(500);
  await browser.typeText("echo LIVE_MIRROR_OK");
  await browser.typeText("\r");
  await sleep(1000);
  const live = await showing("LIVE_MIRROR_OK");
  check(
    "live output mirrors to both views",
    live.length === 2 && live.every(Boolean),
    `views showing marker: [${live.join(", ")}]`,
  );

  // 3. Reload: both views must render (mount-race zombie).
  await browser.goto(`${origin}/p/${containerId}`);
  await until(
    () =>
      browser!.evaluate<boolean>(
        "document.querySelectorAll('.terminal-frame').length === 2 && document.querySelectorAll('.xterm-rows').length === 2",
      ),
    25_000,
    "both terminals re-rendered after reload",
  );
  await sleep(1500);
  const reloaded = await showing("LIVE_MIRROR_OK");
  check(
    "both views render after reload",
    reloaded.length === 2 && reloaded.every(Boolean),
    `views showing marker: [${reloaded.join(", ")}]`,
  );

  // A REAL pointer gesture needs its target on screen, and a terminal is authored at the
  // canvas centre at 720x480 — a pair of them does not fit a 1440x900 window. Both
  // references are normalized through the scene (the canvas honours it like any remote
  // edit) using the pane-relative offset the rendered source node reveals; the viewport is
  // untouched, so screen points and flow points differ only by that offset.
  const mirrorFrame = await browser.evaluate<{
    readonly paneLeft: number;
    readonly paneTop: number;
    readonly nodeLeft: number;
    readonly nodeTop: number;
  } | null>(
    `(() => {
      const pane = document.querySelector('.react-flow__pane');
      const node = document.querySelector('.react-flow__node[data-id="${source.id}"]');
      if (pane === null || node === null) return null;
      const paneBox = pane.getBoundingClientRect();
      const nodeBox = node.getBoundingClientRect();
      return {
        paneLeft: paneBox.left,
        paneTop: paneBox.top,
        nodeLeft: nodeBox.left,
        nodeTop: nodeBox.top,
      };
    })()`,
  );
  if (mirrorFrame === null) throw new Error("the mirror canvas has no pane to measure");
  const mirrorX = (fromPaneLeft: number): number =>
    mirrorFrame.paneLeft + fromPaneLeft - (mirrorFrame.nodeLeft - source.x);
  const mirrorY = (fromPaneTop: number): number =>
    mirrorFrame.paneTop + fromPaneTop - (mirrorFrame.nodeTop - source.y);
  observer.transact((tx) => {
    tx.patch(source.id, { x: mirrorX(40), y: mirrorY(60), width: 460, height: 320 });
    tx.patch(clone.id, { x: mirrorX(540), y: mirrorY(60), width: 460, height: 320 });
  });
  await sleep(1500);

  // 4. The mono portal's chrome is a real POINTER ref. A canvas terminal renders
  //    element-chrome-first: the terminal's own titlebar IS the node's bar, carrying the
  //    node's verbs and acting as its React Flow drag handle. `.terminal-titlebar` is
  //    `pointer-events: none` by default (it floats over the xterm ref), so this is
  //    the assertion that catches a bar which renders but takes no pointer — a state in
  //    which the terminal cannot be dragged and none of its controls can be pressed, and
  //    which every `element.click()` in this file would sail straight through.
  const monoChrome = await browser.evaluate<{
    readonly mono: boolean;
    readonly handleOwned: boolean;
    readonly handleCursor: string;
    readonly unreachable: readonly string[];
  }>(
    `(() => {
      const node = document.querySelector('.react-flow__node[data-id="${clone.id}"]');
      const bar = node?.querySelector('.portal--mono .terminal-titlebar');
      if (!(bar instanceof HTMLElement)) {
        return { mono: false, handleOwned: false, handleCursor: "none", unreachable: [] };
      }
      const box = bar.getBoundingClientRect();
      // A quarter width: clear of the controls on the right, squarely on the drag handle.
      const grabbed = document.elementFromPoint(box.left + box.width / 4, box.top + box.height / 2);
      const unreachable = [];
      for (const control of bar.querySelectorAll('[aria-label]')) {
        const rect = control.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        if (!(hit instanceof Element) || !control.contains(hit)) {
          unreachable.push(control.getAttribute('aria-label'));
        }
      }
      return {
        mono: true,
        handleOwned: grabbed instanceof Element && bar.contains(grabbed),
        handleCursor: grabbed === null ? "none" : getComputedStyle(grabbed).cursor,
        unreachable,
      };
    })()`,
  );
  check(
    "the mono titlebar is the node's own grabbable chrome",
    monoChrome.mono &&
      monoChrome.handleOwned &&
      monoChrome.handleCursor === "grab" &&
      monoChrome.unreachable.length === 0,
    `mono=${String(monoChrome.mono)} handleOwned=${String(monoChrome.handleOwned)} cursor=${
      monoChrome.handleCursor
    } unreachableControls=[${monoChrome.unreachable.join(", ")}]`,
  );

  // 5. Unplacing one mirror removes only that REFERENCE; the other view stays live and
  //    typeable. The close button deliberately KILLS the shared PTY, so removing a copy
  //    is the unplace affordance: it deletes a reference, never the terminal, which goes
  //    on living in the composition that homes it. Pressed with a real pointer, so the
  //    round proves the affordance and not just its handler.
  const unplaceControl = `.react-flow__node[data-id="${clone.id}"] .terminal-titlebar [aria-label="Park terminal to sidebar"]`;
  const unplaceAt = await pointIn(browser, unplaceControl, 0.5, 0.5);
  if (unplaceAt === null) throw new Error("clone node has no unplace control");
  await clickAt(browser, unplaceAt);
  await until(async () => (await termCount()) === 1, 10_000, "mirror unplaced");
  await sleep(600);
  const cloneGone = await browser.evaluate<boolean>(
    `document.querySelector(${JSON.stringify(`.react-flow__node[data-id="${clone.id}"]`)}) === null`,
  );
  const survivingViews = await termCount();
  check(
    "unplacing one mirror removes only that reference",
    cloneGone && survivingViews === 1,
    `cloneNodePresent=${String(!cloneGone)} views=${String(survivingViews)}`,
  );
  const survivorState = await browser.evaluate<boolean>(
    "(document.querySelector('.xterm-rows')?.textContent || '').includes('LIVE_MIRROR_OK')",
  );
  const cs = await center();
  await browser.drag([cs], 30);
  await sleep(500);
  await browser.typeText("echo SURVIVOR_ALIVE");
  await browser.typeText("\r");
  await sleep(1000);
  const survivorTypes = await browser.evaluate<boolean>(
    "(document.querySelector('.xterm-rows')?.textContent || '').includes('SURVIVOR_ALIVE')",
  );
  const exitedStrip = await browser.evaluate<boolean>(
    "document.querySelector('.terminal-exited') !== null",
  );
  check(
    "unplacing one mirror leaves the other live",
    survivorState && survivorTypes && !exitedStrip,
    `state=${String(survivorState)} typeable=${String(survivorTypes)} exitedStrip=${String(exitedStrip)}`,
  );

  // 6. Unplacing the LAST reference. There is no pool to fall into: the terminal goes on
  //    living in the composition that homes it, and "unplaced" is derived — zero portals
  //    point at that home. The INDEX VISIBILITY RULE then says the index must resurface
  //    it: top level is homes and the homeless, and a terminal nothing references is
  //    homeless. A placed terminal's row is deliberately elided from the top level, so
  //    this row appearing is the whole observable difference.
  const soloTerminalId = await terminalHomedIn(source.containerId);
  if (soloTerminalId === "") throw new Error(`no terminal is homed in ${source.containerId}`);
  await nameTerminal(soloTerminalId, "mirror-solo");
  const soloRow = JSON.stringify(`.sidebar-row [aria-label="Open terminal mirror-solo"]`);
  const rowWhilePlaced = await settles(
    () => browser!.evaluate<boolean>(`document.querySelector(${soloRow}) !== null`),
    4_000,
  );
  const lastUnplaceControl = `.react-flow__node[data-id="${source.id}"] .terminal-titlebar [aria-label="Park terminal to sidebar"]`;
  const lastUnplaceAt = await pointIn(browser, lastUnplaceControl, 0.5, 0.5);
  if (lastUnplaceAt === null) throw new Error("the surviving mirror has no unplace control");
  await clickAt(browser, lastUnplaceAt);
  const canvasEmptied = await settles(async () => (await termCount()) === 0, 15_000);
  const unplacedInIndex = await settles(async () => {
    const terminal = (await listTerminals()).find((entry) => entry.id === soloTerminalId);
    return (
      terminal !== undefined &&
      terminal.unplaced &&
      terminal.status === "running" &&
      terminal.homeId === source.containerId
    );
  }, 15_000);
  check(
    "unplacing the last reference leaves the terminal alive in its home",
    canvasEmptied && unplacedInIndex,
    `canvasEmptied=${String(canvasEmptied)} aliveAndUnplaced=${String(unplacedInIndex)}`,
  );
  const rowResurfaced = await settles(
    () => browser!.evaluate<boolean>(`document.querySelector(${soloRow}) !== null`),
    20_000,
  );
  check(
    "the index resurfaces the unplaced terminal at the top level",
    rowResurfaced && !rowWhilePlaced,
    `rowWhilePlaced=${String(rowWhilePlaced)} rowAfterUnplace=${String(rowResurfaced)}`,
  );

  // ------------------------------------------------------------------ composition rounds
  // Shared plumbing for the container rounds. The composition contract is about what a
  // COLLABORATOR sees, so a second real browser joins here: the SDK observer above can
  // read the scene but not the rendered chrome that carries the contract.
  const listContainers = async (): Promise<readonly { id: string; name: string }[]> => {
    // `core.index.listContainers` is the name-bearing listing; /api/containers is the census
    // (structure, not names) and parses with a different schema on purpose.
    const outcome = ActionOutcomeSchema.parse(
      await (
        await fetch(`${origin}/api/actions/core.index.listContainers`, {
          method: "POST",
          headers: httpHeaders,
          body: JSON.stringify({}),
        })
      ).json(),
    );
    if (!outcome.ok) throw new Error(`listContainers refused: ${outcome.denial.message}`);
    return ContainersResponseSchema.parse(outcome.result).containers;
  };
  const containerNameOf = async (id: string): Promise<string> =>
    (await listContainers()).find((container) => container.id === id)?.name ?? "";
  const containerIdNamed = async (name: string): Promise<string> =>
    (await listContainers()).find((container) => container.name === name)?.id ?? "";
  const enterWorkspace = async (target: Browser, displayName: string): Promise<void> => {
    await target.goto(`${origin}/#key=${ownerKey}`);
    if (await target.evaluate<boolean>("document.querySelector('input') !== null")) {
      await target.typeInto("input", displayName);
      await target.clickText("Enter manifold");
    }
  };
  const openCanvas = async (target: Browser, id: string, what: string): Promise<void> => {
    await target.goto(`${origin}/p/${id}`);
    await until(
      () => target.evaluate<boolean>("document.querySelector('.react-flow') !== null"),
      25_000,
      what,
    );
  };
  const clickIn = (target: Browser, selector: string): Promise<boolean> =>
    target.evaluate<boolean>(
      `(() => {
        const button = document.querySelector(${JSON.stringify(selector)});
        if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
        button.click();
        return true;
      })()`,
    );
  const tilesInside = (target: Browser, elementId: string): Promise<number> =>
    target.evaluate<number>(
      `document.querySelectorAll('.react-flow__node[data-id="${elementId}"] .portal__tile').length`,
    );
  // The sidebar's container index labels a composition's row "Open composition <name>". The
  // canvas portal's own maximize button carries the same wording, so a row assertion scopes to
  // `.sidebar-row` — otherwise a portal on screen could satisfy a check about the sidebar.
  const rowFor = (name: string): string =>
    JSON.stringify(`.sidebar-row [aria-label="Open composition ${name}"]`);

  watcher = new Browser();
  await watcher.launch(9346);
  await enterWorkspace(watcher, "mirror-gate-watcher");
  await sleep(1200);

  // 5. A canvas snapped into a tile renders its LIVE canvas: the composition renderer mounts a
  //    real React Flow instance for a container ref, not a name card. Every terminal is
  //    homed in a composition from birth, so the source terminal's own home is the
  //    container this round drops into — no expand step has to manufacture one.
  const embeddedContainerId = await createContainer("mirror-gate-embedded");
  embedded = new SessionClient({
    url: `${origin.replace(/^http/, "ws")}/ws/session`,
    containerId: embeddedContainerId,
    token: ownerKey,
    reconnect: false,
  });
  await embedded.connect();
  embedded.transact((tx) =>
    tx.create({
      id: crypto.randomUUID(),
      type: "text",
      text: "EMBEDDED_CANVAS_LIVE",
      fontSize: 28,
      color: "#e6e9ef",
      x: 60,
      y: 60,
      width: 420,
      height: 90,
      zIndex: tx.nextZIndex(),
    }),
  );
  await sleep(800);
  const mirrorContainerId = source.containerId;
  await browser.goto(`${origin}/p/${mirrorContainerId}`);
  await until(
    () => browser!.evaluate<boolean>("document.querySelector('.composition-leaf') !== null"),
    25_000,
    "the terminal's home composition mounted for the canvas drop",
  );
  await sleep(1500);
  const containerDrop = await nativeDrag(
    browser,
    `.index-item[data-tree-kind="container"][data-tree-id="${embeddedContainerId}"]`,
    { selector: ".composition-leaf", fx: 0.5, fy: 0.9 },
  );
  check(
    "a canvas row drag carries the one item envelope into a tile drop",
    containerDrop.ok &&
      containerDrop.types.includes("application/x-manifold-item") &&
      containerDrop.accepted,
    `types=[${containerDrop.types.join(", ")}] accepted=${String(containerDrop.accepted)}`,
  );
  const liveCanvas = await settles(
    () =>
      browser!.evaluate<boolean>(
        "document.querySelector('.composition-leaf .react-flow') !== null && (document.querySelector('.composition-leaf .canvas-text')?.textContent || '').includes('EMBEDDED_CANVAS_LIVE')",
      ),
    30_000,
  );
  check(
    "a canvas snapped into a tile renders its live canvas",
    liveCanvas,
    `nested react-flow rendering the embedded element: ${String(liveCanvas)}`,
  );
  /*
    An embedded canvas wears its own titlebar, and its maximize is the ONLY way into a container
    that lives inside a composition — before that bar existed the jump was unreachable.
    Pressed with a real pointer, like every other control this gate exercises.
  */
  const containerTileEnter = await pointIn(
    browser,
    `.composition-tile__bar [aria-label="Open canvas mirror-gate-embedded"]`,
    0.5,
    0.5,
  );
  if (containerTileEnter === null) throw new Error("the embedded canvas tile carries no way in");
  await clickAt(browser, containerTileEnter);
  const containerTileJumped = await settles(
    () =>
      browser!.evaluate<boolean>(
        `location.pathname === ${JSON.stringify(`/p/${embeddedContainerId}`)} &&
         document.querySelector('.workspace-canvas .react-flow') !== null`,
      ),
    25_000,
  );
  check(
    "an embedded canvas tile opens the container it holds",
    containerTileJumped,
    `route is the embedded container with its own canvas: ${String(containerTileJumped)}`,
  );

  // 8. Composition by drag, the canvas-side door into a composition: holding one terminal
  //    over another morphs the target into container chrome, the release births ONE
  //    composition absorbing both terminals in the target's own slot, the portal keeps
  //    painting them LIVE, entering it walks into its own renderer, and dragging a tile
  //    back out re-homes that terminal into a fresh solo composition the canvas portals
  //    at the drop point.
  const composeContainerId = await createContainer("mirror-gate-compose");
  composed = new SessionClient({
    url: `${origin.replace(/^http/, "ws")}/ws/session`,
    containerId: composeContainerId,
    token: ownerKey,
    reconnect: false,
  });
  await composed.connect();
  await openCanvas(browser, composeContainerId, "compose canvas mounted");
  for (const ordinal of ["first", "second"] as const) {
    const before = await termCount();
    if (!(await clickIn(browser, '[aria-label^="New terminal on "]'))) {
      throw new Error(`no online machine row for the ${ordinal} compose terminal`);
    }
    await until(
      async () => (await termCount()) === before + 1,
      30_000,
      `${ordinal} compose terminal opened`,
    );
  }
  await until(() => composed!.elements.size === 2, 15_000, "compose elements reached the SDK");
  await sleep(1200);
  const composeElements = [...composed.elements.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const anchor = composeElements[0];
  const mover = composeElements[1];
  if (anchor?.type !== "portal" || mover?.type !== "portal") {
    throw new Error("compose canvas does not hold two terminal portals");
  }
  for (const [element, name] of [
    [anchor, "alpha"],
    [mover, "beta"],
  ] as const) {
    const terminalId = await terminalHomedIn(element.containerId);
    if (terminalId === "") throw new Error(`no terminal is homed in ${element.containerId}`);
    await nameTerminal(terminalId, name);
  }
  // Both terminals are authored at the canvas centre at 720x480, which puts the pair
  // outside a 1440x900 window — a pointer gesture needs both nodes on screen. Their
  // geometry is normalized through the scene (the canvas honours it like any remote
  // edit) using the pane-relative offset the first node reveals; the viewport is
  // untouched, so screen points and flow points still differ only by that offset.
  const paneFrame = await browser.evaluate<{
    paneLeft: number;
    paneTop: number;
    nodeLeft: number;
    nodeTop: number;
  } | null>(
    `(() => {
      const pane = document.querySelector('.react-flow__pane');
      const node = document.querySelector('.react-flow__node[data-id="${anchor.id}"]');
      if (pane === null || node === null) return null;
      const paneBox = pane.getBoundingClientRect();
      const nodeBox = node.getBoundingClientRect();
      return {
        paneLeft: paneBox.left,
        paneTop: paneBox.top,
        nodeLeft: nodeBox.left,
        nodeTop: nodeBox.top,
      };
    })()`,
  );
  if (paneFrame === null) throw new Error("compose canvas has no pane to measure");
  const laidOutX = paneFrame.paneLeft + 40 - (paneFrame.nodeLeft - anchor.x);
  const laidOutY = paneFrame.paneTop + 80 - (paneFrame.nodeTop - anchor.y);
  composed.transact((tx) => {
    tx.patch(anchor.id, { x: laidOutX, y: laidOutY, width: 420, height: 300 });
    tx.patch(mover.id, { x: laidOutX + 480, y: laidOutY, width: 420, height: 300 });
  });
  await sleep(1500);

  /*
    A marker on the anchor's screen BEFORE any composition exists. After the merge the
    portal has to keep painting that same live terminal — a container portal previewing
    its terminals at depth 2 is the contract, and a name card that says "alpha" would
    satisfy every structural assertion below without it.
  */
  const anchorBody = await pointIn(
    browser,
    `.react-flow__node[data-id="${anchor.id}"] .portal__shield`,
    0.5,
    0.5,
  );
  if (anchorBody === null) throw new Error("the anchor terminal has no body to work in");
  await clickAt(browser, anchorBody);
  await sleep(900);
  await browser.typeText("clear; echo COMPOSED_TILE_LIVE");
  await browser.typeText("\r");
  const anchorMarker = `.react-flow__node[data-id="${anchor.id}"] .xterm-rows`;
  await until(
    async () =>
      await browser!.evaluate<boolean>(
        `(document.querySelector(${JSON.stringify(anchorMarker)})?.textContent || '').includes('COMPOSED_TILE_LIVE')`,
      ),
    15_000,
    "the anchor terminal shows its marker before composition",
  );
  // Engagement made the anchor an occupant; the compose gesture must not start from it.
  await clickAt(browser, { x: paneFrame.paneLeft + 30, y: paneFrame.paneTop + 30 });
  await sleep(400);
  const grab = await pointIn(
    browser,
    `.react-flow__node[data-id="${mover.id}"] .terminal-titlebar`,
    0.25,
    0.5,
  );
  const anchorRect = await nodeRect(browser, anchor.id);
  if (grab === null || anchorRect === null) throw new Error("compose nodes are not rendered");
  // The right-hand snap band: the released zone becomes the split edge.
  const zone = {
    x: anchorRect.left + anchorRect.width * 0.85,
    y: anchorRect.top + anchorRect.height * 0.5,
  };
  await pressAt(browser, grab);
  await moveTo(browser, { x: grab.x - 24, y: grab.y + 8 });
  await sleep(80);
  await moveTo(browser, { x: (grab.x + zone.x) / 2, y: (grab.y + zone.y) / 2 });
  await sleep(80);
  await moveTo(browser, zone);
  await sleep(120);
  await moveTo(browser, { x: zone.x + 1, y: zone.y });
  /*
    The armed cue moved with the drop-pipeline cutover: the canvas no longer stamps
    view chrome onto the node (`.flow-node--compose-target`) or paints a flow-space
    half-rect (`.flow-compose-preview`). The armed WIDGET's own overlay resolves the
    zone now — `.tile-area` wears `is-previewing` and the landing slot is a
    `.tile-preview` inside it — so the proof hooks are the portal's.
  */
  const morphed = await settles(
    () =>
      browser!.evaluate<boolean>(
        `document.querySelector('.react-flow__node[data-id="${anchor.id}"] .tile-area.is-previewing') !== null`,
      ),
    6_000,
  );
  const snapPreview = await browser.evaluate<boolean>(
    `document.querySelector('.react-flow__node[data-id="${anchor.id}"] .tile-preview') !== null`,
  );
  check(
    "holding a terminal over another arms the target's live drop preview",
    morphed && snapPreview,
    `previewing=${String(morphed)} slot=${String(snapPreview)}`,
  );
  await releaseAt(browser, { x: zone.x + 1, y: zone.y });

  /*
    The target was ALREADY a portal — every canvas terminal is one — so the birth shows in
    its ARITY, not in the node type: it must stop wearing element-first mono chrome and
    start wearing composition chrome. Asserting `.portal` alone would pass before the
    gesture ran.
  */
  const composedPortal = await settles(
    () =>
      browser!.evaluate<boolean>(
        `(() => {
          const node = document.querySelector('.react-flow__node[data-id="${anchor.id}"]');
          if (node === null) return false;
          return (
            node.querySelector('.portal') !== null &&
            node.querySelector('.portal--mono') === null &&
            node.querySelector('.portal__strip') !== null
          );
        })()`,
      ),
    30_000,
  );
  const composedRect = await nodeRect(browser, anchor.id);
  const composeDrift = rectDrift(anchorRect, composedRect);
  check(
    "the release turns the target into a composition portal in its own slot",
    composedPortal && composeDrift <= 2,
    `composition chrome=${String(composedPortal)} geometry drift=${composeDrift.toFixed(1)}px`,
  );
  const bothInside = await settles(
    async () => (await tilesInside(browser!, anchor.id)) === 2,
    30_000,
  );
  const moverConsumed = await settles(
    () =>
      browser!.evaluate<boolean>(
        `document.querySelector('.react-flow__node[data-id="${mover.id}"]') === null`,
      ),
    30_000,
  );
  check(
    "both terminals render as tiles inside the composed portal",
    bothInside && moverConsumed,
    `tiles=${String(await tilesInside(browser, anchor.id))} dragged element consumed=${String(moverConsumed)}`,
  );
  /*
    Depth-2 live preview: the portal joined a room it did not own a moment ago and is
    painting a terminal it never hosted. The marker predates the assembly, so a tile
    showing it proves the preview replays screen state rather than merely mounting an
    xterm — the zombie regression, one nesting level down.
  */
  const previewLive = await settles(
    () =>
      browser!.evaluate<boolean>(
        `(() => {
          const tiles = document.querySelectorAll(
            '.react-flow__node[data-id="${anchor.id}"] .portal__tile .xterm-rows',
          );
          return (
            tiles.length === 2 &&
            [...tiles].some((rows) => (rows.textContent || '').includes('COMPOSED_TILE_LIVE'))
          );
        })()`,
      ),
    30_000,
  );
  check(
    "the portal previews its terminals live, replaying state that predates it",
    previewLive,
    `two live tiles replaying the pre-composition marker: ${String(previewLive)}`,
  );

  /*
    ENGAGEMENT, the two contracts that make a portal usable rather than decorative.

    The veil says which tile owns the keyboard: at rest every tile is dimmed, and engaging
    one undims exactly that tile. And the escalation from spectator to occupant swaps the
    room socket UNDER the tiles, so the xterm hosts have to survive it — each one is
    stamped here and counted again after engaging AND after leaving, because a rebuilt host
    loses its scrollback and flashes at both ends of the gesture.
  */
  const portalTiles = `.react-flow__node[data-id="${anchor.id}"] .portal__tile`;
  const stamped = await browser.evaluate<number>(
    `(() => {
      const hosts = document.querySelectorAll(${JSON.stringify(`${portalTiles} .xterm`)});
      for (const host of hosts) host.setAttribute('data-gate-mark', '1');
      return hosts.length;
    })()`,
  );
  const veils = (): Promise<{ readonly total: number; readonly dimmed: number }> =>
    browser!.evaluate(
      `(() => {
        const all = [...document.querySelectorAll(${JSON.stringify(`${portalTiles} .terminal-idle-veil`)})];
        return {
          total: all.length,
          dimmed: all.filter((veil) => getComputedStyle(veil).opacity === "1").length,
        };
      })()`,
    );
  const atRest = await veils();
  const engageAt = await pointIn(browser, `${portalTiles} .portal__shield`, 0.5, 0.5);
  if (engageAt === null) throw new Error("the composed portal offers no tile to engage");
  await clickAt(browser, engageAt);
  const engagedVeils = await settles(async () => {
    const state = await veils();
    return state.total === 2 && state.dimmed === 1;
  }, 15_000);
  const afterEngage = await veils();
  check(
    "a portal dims its resting tiles and undims only the engaged one",
    stamped === 2 && atRest.total === 2 && atRest.dimmed === 2 && engagedVeils,
    `atRest=${String(atRest.dimmed)}/${String(atRest.total)} engaged=${String(
      afterEngage.dimmed,
    )}/${String(afterEngage.total)}`,
  );
  const marksWhileEngaged = await browser.evaluate<number>(
    `document.querySelectorAll(${JSON.stringify(`${portalTiles} .xterm[data-gate-mark]`)}).length`,
  );
  // Pressing outside the portal drops occupancy: the socket swaps back the other way.
  await clickAt(browser, { x: paneFrame.paneLeft + 30, y: paneFrame.paneTop + 30 });
  const disengaged = await settles(async () => {
    const state = await veils();
    return state.total === 2 && state.dimmed === 2;
  }, 15_000);
  const marksAfter = await browser.evaluate<number>(
    `document.querySelectorAll(${JSON.stringify(`${portalTiles} .xterm[data-gate-mark]`)}).length`,
  );
  const bufferKept = await browser.evaluate<boolean>(
    `[...document.querySelectorAll(${JSON.stringify(`${portalTiles} .xterm-rows`)})].some(
       (rows) => (rows.textContent || '').includes('COMPOSED_TILE_LIVE'),
     )`,
  );
  check(
    "engaging and leaving a portal keeps the same xterm hosts and their buffers",
    marksWhileEngaged === 2 && marksAfter === 2 && disengaged && bufferKept,
    `marks engaged=${String(marksWhileEngaged)} after=${String(marksAfter)} reveiled=${String(
      disengaged,
    )} scrollback=${String(bufferKept)}`,
  );
  // The composed row is read from a FRESH mount (the tree does not poll).
  await openCanvas(watcher, composeContainerId, "watcher mounted the compose canvas");
  const composedRow = rowFor("alpha + beta");
  const namedRow = await settles(
    () => watcher!.evaluate<boolean>(`document.querySelector(${composedRow}) !== null`),
    25_000,
  );
  check(
    "composition writes a row named after both refs",
    namedRow,
    `row “alpha + beta”: ${String(namedRow)}`,
  );

  /*
    ENTER, which is the whole of what "expand" used to be. Under solo compositions nothing
    is born by entering: the composition already exists, so the verb is navigation to it.
    The gate presses the portal's own maximize control with a real pointer and asserts the
    route, the composition renderer, and the marker still on the terminal's screen — the
    old "the expanded terminal replays its screen state in its tile" contract, re-expressed.
  */
  const enterControl = `.react-flow__node[data-id="${anchor.id}"] .portal__strip [aria-label="Open composition alpha + beta"]`;
  const enterAt = await pointIn(browser, enterControl, 0.5, 0.5);
  if (enterAt === null) throw new Error("the composed portal offers no way in");
  const composedViewIdEntered = await containerIdNamed("alpha + beta");
  if (composedViewIdEntered === "") {
    throw new Error("the composed view is missing from /api/containers");
  }
  await clickAt(browser, enterAt);
  const entered = await settles(
    () =>
      browser!.evaluate<boolean>(
        `location.pathname === ${JSON.stringify(`/p/${composedViewIdEntered}`)} &&
         document.querySelectorAll('.composition-view .composition-leaf .xterm-rows').length === 2`,
      ),
    25_000,
  );
  const enteredMarker = await settles(
    () =>
      browser!.evaluate<boolean>(
        `[...document.querySelectorAll('.composition-view .xterm-rows')].some(
           (rows) => (rows.textContent || '').includes('COMPOSED_TILE_LIVE'),
         )`,
      ),
    25_000,
  );
  check(
    "entering the portal navigates into the composition it points at",
    entered && enteredMarker,
    `route+two tiles=${String(entered)} marker replayed=${String(enteredMarker)}`,
  );
  // Back to the canvas: extraction is a canvas gesture, and the portal must be on screen.
  await openCanvas(browser, composeContainerId, "compose canvas remounted after entering");
  await sleep(1500);

  // Extraction leaves ONE item behind, and a composition that still holds something is
  // never retired — only the one emptied by the move is. The watcher walks into the
  // composed view so the round also proves an occupant is not what keeps it alive.
  const composedViewId = composedViewIdEntered;
  await watcher.goto(`${origin}/p/${composedViewId}`);
  await until(
    () => watcher!.evaluate<boolean>("document.querySelector('.composition-view') !== null"),
    25_000,
    "watcher occupied the composed view",
  );

  const extraction = await nativeDrag(
    browser,
    `.react-flow__node[data-id="${anchor.id}"] .portal__shield`,
    { selector: ".react-flow__pane", fx: 0.2, fy: 0.85 },
  );
  check(
    "a tile drag out of a portal carries the one item envelope onto the canvas",
    extraction.ok &&
      extraction.types.includes("application/x-manifold-item") &&
      extraction.accepted,
    `types=[${extraction.types.join(", ")}] accepted=${String(extraction.accepted)}`,
  );
  /*
    A re-homed terminal comes back as an ELEMENT-FIRST node: a portal onto a FRESH solo
    assembly, wearing the terminal's own chrome. There is no terminal node type to look
    for any more, and mere node-counting would not distinguish this from the move failing:
    the source composition is down to one item and therefore renders element-first too, so
    the canvas legitimately shows two mono portals afterwards. What identifies the
    extraction is a NEW element pointing at a container that is neither the composition it
    left nor either terminal's pre-merge home, with a terminal actually homed there.
  */
  const monoTerminals = (target: Browser): Promise<number> =>
    target.evaluate<number>("document.querySelectorAll('.react-flow__node .portal--mono').length");
  const extractedElement = (): SceneElement | undefined =>
    [...composed!.elements.values()].find(
      (element) => element.id !== anchor.id && element.id !== mover.id,
    );
  const reAuthored = await settles(async () => {
    const extracted = extractedElement();
    if (extracted?.type !== "portal") return false;
    if (
      extracted.containerId === composedViewId ||
      extracted.containerId === anchor.containerId ||
      extracted.containerId === mover.containerId
    ) {
      return false;
    }
    if ((await terminalHomedIn(extracted.containerId)) === "") return false;
    // Rendered, and element-first: both survivors wear the terminal's own chrome now.
    const rendered = await browser!.evaluate<boolean>(
      `document.querySelector('.react-flow__node[data-id="${extracted.id}"] .portal--mono') !== null`,
    );
    return rendered && (await monoTerminals(browser!)) === 2;
  }, 30_000);
  const oneTileLeft = await settles(
    async () => (await tilesInside(browser!, anchor.id)) === 1,
    30_000,
  );
  const extractedAfter = extractedElement();
  check(
    "extraction re-homes the terminal and portals it onto the canvas",
    reAuthored,
    `new element=${extractedAfter?.id ?? "none"} onto container=${
      extractedAfter?.type === "portal" ? extractedAfter.containerId : "n/a"
    } element-first nodes=${String(await monoTerminals(browser))}`,
  );
  check(
    "the source composition keeps the item extraction left behind",
    oneTileLeft,
    `tiles left inside the portal: ${String(await tilesInside(browser, anchor.id))}`,
  );
  const rowPersisted = (await containerNameOf(composedViewId)) === "alpha + beta";
  check(
    "a composition that still holds an item keeps its row",
    rowPersisted,
    `row survives the extraction: ${String(rowPersisted)}`,
  );
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await browser?.close();
  await watcher?.close();
  observer?.close();
  embedded?.close();
  composed?.close();
  server.kill();
  cleanupDist();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(
  failures.length === 0
    ? "\nterminal-mirror gate: GREEN"
    : `\nterminal-mirror gate: RED\n${failures.map((f) => ` - ${f}`).join("\n")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
