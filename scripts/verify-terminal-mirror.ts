/**
 * manifold terminal-mirror regression gate.
 *
 * Guards the mirrored-terminal contract at the RENDERED boundary: two native
 * terminal records can bind the same PTY, producing two live viewports. The
 * regression this pins: the SDK sent `terminal_attach` only on the 0→1 refcount
 * transition, so a view subscribing after the first snapshot never received
 * screen state and rendered as an empty "zombie" that ignored live output.
 *
 * Asserted end to end in REAL browsers — two of them, because the bubble contract is
 * about what a COLLABORATOR sees and only a second rendered canvas can prove that:
 *   1. the clone renders screen state that existed BEFORE it was created;
 *   2. live output mirrors to both views;
 *   3. after a reload both views render (no mount-race zombie);
 *   4. parking one mirror removes only that copy: the other view stays live and
 *      typeable (PTY survives) and the non-last copy never enters the pool;
 *   5. expand is a TRANSMUTATION, not a popover: a view is born around the terminal,
 *      the expander lands in the tiled renderer with its screen state replayed, and
 *      the element it left behind becomes a live view widget in the same slot for the
 *      collaborator — occupant avatar, live preview and all;
 *   6. shrink pops an unsplit bubble EVEN WITH a collaborator watching the widget: it
 *      transmutes back into a plain terminal in the same slot under the watcher, the
 *      session survives, and the transient row is gone;
 *   7. splitting hardens: a tile dropped from the pool makes the view durable, and it
 *      survives shrink as a widget holding both tiles with its sidebar row intact;
 *   8. a canvas snapped into a tile renders its live board, not a name card;
 *   9. composition by drag: holding a terminal over another morphs the target into view
 *      chrome with a snap preview, the release births a hardened view named after both
 *      surfaces over the target's geometry, and dragging a tile back out onto the canvas
 *      re-authors a plain terminal element while the widget keeps its remaining tile for
 *      as long as somebody is really inside the view — a widget preview only watches, so
 *      the leftover one-tile view pops the moment its last true occupant leaves.
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
import { PadResponseSchema, PadsResponseSchema } from "../packages/protocol/src/index.ts";
import { SessionClient } from "../packages/sdk/src/index.ts";
import { Browser, sleep, until } from "./cdp.ts";

const repoRoot = join(import.meta.dir, "..");
const distDir = join(mkdtempSync(join(tmpdir(), "manifold-mir-")), "dist");
const dataDir = mkdtempSync(join(tmpdir(), "manifold-mir-data-"));
const port = 41000 + Math.floor(Math.random() * 2000);
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

  const created = await fetch(`${origin}/api/pads`, {
    method: "POST",
    headers: httpHeaders,
    body: JSON.stringify({ name: "terminal-mirror-gate" }),
  });
  const padId = ((await created.json()) as { pad: { id: string } }).pad.id;

  browser = new Browser();
  await browser.launch(9345);
  await browser.goto(`${origin}/#key=${ownerKey}`);
  if (await browser.evaluate<boolean>("document.querySelector('input') !== null")) {
    await browser.typeInto("input", "mirror-gate");
    await browser.clickText("Enter manifold");
  }
  await browser.goto(`${origin}/p/${padId}`);
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
      "(() => { const b = document.querySelector('.manifold-terminal').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()",
    );
  const showing = (marker: string) =>
    browser!.evaluate<boolean[]>(
      `[...document.querySelectorAll('.manifold-terminal')].map(t => (t.querySelector('.xterm-rows')?.textContent || '').includes('${marker}'))`,
    );
  const termCount = () =>
    browser!.evaluate<number>("document.querySelectorAll('.manifold-terminal').length");

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

  // Create a second native canvas record bound to the same live PTY through the SDK.
  observer = new SessionClient({
    url: `${origin.replace(/^http/, "ws")}/ws/session`,
    padId,
    token: ownerKey,
    reconnect: false,
  });
  await observer.connect();
  await until(() => observer!.elements.size === 1, 10_000, "terminal visible to mirror client");
  const source = [...observer.elements.values()][0];
  if (source?.type !== "terminal") throw new Error("source terminal missing from canonical scene");
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
    "(() => { const b = document.querySelectorAll('.manifold-terminal')[0].getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()",
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
  await browser.goto(`${origin}/p/${padId}`);
  await until(
    () =>
      browser!.evaluate<boolean>(
        "document.querySelectorAll('.manifold-terminal').length === 2 && document.querySelectorAll('.xterm-rows').length === 2",
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

  // 4. Parking one mirror removes only that copy; the other view stays live and typeable.
  //    The close button now deliberately KILLS the shared PTY, so copy removal is the Park
  //    affordance. Parking a non-last copy must NOT enter the workspace pool: the session
  //    stays bound to this pad through the surviving element.
  const cloneParked = await browser.evaluate<boolean>(
    `(() => {
      const button = document.querySelector(
        ${JSON.stringify(`.react-flow__node[data-id="${clone.id}"] [aria-label="Park terminal to sidebar"]`)},
      );
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`,
  );
  if (!cloneParked) throw new Error("clone node has no park button");
  await until(async () => (await termCount()) === 1, 10_000, "mirror parked");
  await sleep(600);
  const cloneGone = await browser.evaluate<boolean>(
    `document.querySelector(${JSON.stringify(`.react-flow__node[data-id="${clone.id}"]`)}) === null`,
  );
  const survivingViews = await termCount();
  check(
    "parking one mirror removes only that copy",
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
    "parking one mirror leaves the other live",
    survivorState && survivorTypes && !exitedStrip,
    `state=${String(survivorState)} typeable=${String(survivorTypes)} exitedStrip=${String(exitedStrip)}`,
  );
  // The sidebar pool refetches on sessions_changed as well as on its poll, and the park round
  // trip plus the typing above is well past both, so an empty pool here is a real negative.
  const pooledRow = await browser.evaluate<boolean>(
    "document.querySelector('.terminal-pool-row') !== null",
  );
  check(
    "parking a non-last copy never enters the pool",
    !pooledRow,
    `sidebar pool rows present: ${String(pooledRow)}`,
  );

  // ---------------------------------------------------------------------- bubble rounds
  // Shared plumbing for the container rounds. The bubble contract is about what a
  // COLLABORATOR sees, so a second real browser joins here: the SDK observer above can
  // read the scene but not the rendered chrome that carries the contract.
  const padNameOf = async (id: string): Promise<string> => {
    const listed = PadsResponseSchema.parse(
      await (await fetch(`${origin}/api/pads`, { headers: httpHeaders })).json(),
    );
    return listed.pads.find((pad) => pad.id === id)?.name ?? "";
  };
  const padIdNamed = async (name: string): Promise<string> => {
    const listed = PadsResponseSchema.parse(
      await (await fetch(`${origin}/api/pads`, { headers: httpHeaders })).json(),
    );
    return listed.pads.find((pad) => pad.name === name)?.id ?? "";
  };
  const createPad = async (name: string): Promise<string> => {
    const created = PadResponseSchema.parse(
      await (
        await fetch(`${origin}/api/pads`, {
          method: "POST",
          headers: httpHeaders,
          body: JSON.stringify({ name }),
        })
      ).json(),
    );
    return created.pad.id;
  };
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
  const routePath = (target: Browser): Promise<string> =>
    target.evaluate<string>("decodeURIComponent(location.pathname)");
  const tilesInside = (target: Browser, elementId: string): Promise<number> =>
    target.evaluate<number>(
      `document.querySelectorAll('.react-flow__node[data-id="${elementId}"] .flow-portal__tile').length`,
    );
  const viewTerminals = (target: Browser): Promise<number> =>
    target.evaluate<number>(
      "document.querySelectorAll('.tiled-pad-view .manifold-terminal').length",
    );
  const expandButton = `.react-flow__node[data-id="${source.id}"] [aria-label="Expand terminal to full view"]`;
  // The sidebar's container index labels a tiled container's row "Open composition <name>". The
  // canvas widget's own maximize button carries the same wording, so a row assertion scopes to
  // `.pad-sidebar-row` — otherwise a widget on screen could satisfy a check about the sidebar.
  const rowFor = (name: string): string =>
    JSON.stringify(`.pad-sidebar-row [aria-label="Open composition ${name}"]`);
  const transientRowFor = (name: string): string =>
    JSON.stringify(`.pad-sidebar-row--transient [aria-label="Open composition ${name}"]`);

  watcher = new Browser();
  await watcher.launch(9346);
  await enterWorkspace(watcher, "mirror-gate-watcher");
  await openCanvas(watcher, padId, "watcher mounted the origin canvas");
  await until(
    () =>
      watcher!.evaluate<boolean>(
        `document.querySelector('.react-flow__node[data-id="${source.id}"] .manifold-terminal') !== null`,
      ),
    25_000,
    "watcher rendered the terminal",
  );
  await sleep(1200);

  // 5. Expand TRANSMUTES: a view is born around the terminal, the expander lands in the
  //    tiled renderer with its screen state replayed, and the canvas element it left
  //    behind becomes a live view widget in the same slot for the collaborator.
  const focus = await pointIn(
    browser,
    `.react-flow__node[data-id="${source.id}"] .xterm-host`,
    0.5,
    0.5,
  );
  if (focus === null) throw new Error("source terminal has no xterm host to focus");
  await browser.drag([focus], 30);
  await sleep(500);
  await browser.typeText("echo BUBBLE_SENTINEL");
  await browser.typeText("\r");
  await until(
    () =>
      browser!.evaluate<boolean>(
        `(document.querySelector('.react-flow__node[data-id="${source.id}"] .xterm-rows')?.textContent || '').includes('BUBBLE_SENTINEL')`,
      ),
    10_000,
    "bubble sentinel rendered before expand",
  );

  const slotBefore = await nodeRect(browser, source.id);
  const watcherSlotBefore = await nodeRect(watcher, source.id);
  if (!(await clickIn(browser, expandButton))) {
    throw new Error("terminal titlebar has no enabled expand button");
  }
  const entered = await settles(
    () => browser!.evaluate<boolean>("document.querySelector('.tiled-pad-view') !== null"),
    20_000,
  );
  const bubbleRoute = await routePath(browser);
  const bubbleId = bubbleRoute.startsWith("/p/") ? bubbleRoute.slice(3) : "";
  // A view that vanished from /api/pads while the expander was still walking into it is
  // the fingerprint of a premature bubble pop, and it reads nothing like a render bug —
  // so both the row and the renderer that actually mounted are reported here.
  const bubbleListed = (await padNameOf(bubbleId)) !== "";
  const renderer = await browser.evaluate<string>(
    `(document.querySelector('.tiled-pad-view') !== null ? 'tiled' : document.querySelector('.react-flow') !== null ? 'canvas' : document.querySelector('.tiled-placeholder') !== null ? 'placeholder' : 'none')`,
  );
  check(
    "expand navigates into the view it was born into",
    entered && bubbleId !== "" && bubbleId !== padId && bubbleListed,
    `renderer=${renderer} route=${bubbleRoute} view row still listed=${String(bubbleListed)}`,
  );
  const replayed = await settles(
    () =>
      browser!.evaluate<boolean>(
        "(document.querySelector('.tiled-pad-view .manifold-terminal .xterm-rows')?.textContent || '').includes('BUBBLE_SENTINEL')",
      ),
    20_000,
  );
  check(
    "the expanded terminal replays its screen state in its tile",
    replayed,
    `sentinel inside the tiled renderer: ${String(replayed)}`,
  );

  const widgetBorn = await settles(
    () =>
      watcher!.evaluate<boolean>(
        `document.querySelector('.react-flow__node[data-id="${source.id}"] .flow-portal') !== null`,
      ),
    25_000,
  );
  const watcherSlotAfter = await nodeRect(watcher, source.id);
  const slotDrift = rectDrift(watcherSlotBefore, watcherSlotAfter);
  check(
    "the collaborator's canvas shows a view widget in the terminal's own slot",
    widgetBorn && slotDrift <= 2,
    `widget=${String(widgetBorn)} geometry drift=${slotDrift.toFixed(1)}px`,
  );
  // Presence polls every 1.5s, so an avatar that never lands is a real negative.
  const occupied = await settles(
    () => watcher!.evaluate<boolean>("document.querySelector('.flow-portal__avatar') !== null"),
    20_000,
  );
  check(
    "the view widget carries the expander as an occupant",
    occupied,
    `occupant avatar rendered: ${String(occupied)}`,
  );
  const previewLive = await settles(
    () =>
      watcher!.evaluate<boolean>(
        "(document.querySelector('.flow-portal .flow-portal__tile .xterm-rows')?.textContent || '').includes('BUBBLE_SENTINEL')",
      ),
    25_000,
  );
  check(
    "the widget previews the live terminal inside the view",
    previewLive,
    `depth-2 preview replayed the sentinel: ${String(previewLive)}`,
  );
  // Both canvases now hold a preview socket into the newborn view: the expander's own left
  // as it navigated in, the collaborator's joined after. Previews join as SPECTATORS, so
  // neither can empty the room — the view the expander is standing in cannot be deleted
  // out from under it, which is exactly the race this line guards.
  const survivedBirth = (await padNameOf(bubbleId)) !== "";
  const stillTiled = await browser.evaluate<boolean>(
    "document.querySelector('.tiled-pad-view .manifold-terminal') !== null",
  );
  check(
    "the newborn view survives both canvases opening previews into it",
    survivedBirth && stillTiled,
    `view row still listed=${String(survivedBirth)} renderer still tiled=${String(stillTiled)}`,
  );

  const bubbleName = await padNameOf(bubbleId);
  const bubbleRow = rowFor(bubbleName);
  const bubbleTransientRow = transientRowFor(bubbleName);
  const transientRow = await settles(
    () => browser!.evaluate<boolean>(`document.querySelector(${bubbleTransientRow}) !== null`),
    20_000,
  );
  check(
    "the bubble gets a transient sidebar row",
    transientRow,
    `transient row for “${bubbleName}”: ${String(transientRow)}`,
  );

  // 6. Shrink pops an unsplit bubble — WITH the collaborator still watching the widget.
  //    Its live preview holds a real socket into the view's room, but a preview joins as a
  //    spectator: it never counts as an occupant, so the last real occupant walking out is
  //    what empties the room. The watcher stays exactly where it is and sees the widget
  //    transmute back under it (a dead browser stays crash-safe: it too stops occupying).
  if (!(await clickIn(browser, '[aria-label="Shrink view"]'))) {
    throw new Error("the tiled renderer has no shrink control");
  }
  await until(
    async () => (await routePath(browser!)) === `/p/${padId}`,
    15_000,
    "shrink returned to the origin canvas",
  );
  const transmutedBack = await settles(
    () =>
      browser!.evaluate<boolean>(
        `document.querySelector('.react-flow__node[data-id="${source.id}"] .flow-terminal') !== null`,
      ),
    25_000,
  );
  const slotAfter = await nodeRect(browser, source.id);
  const shrinkDrift = rectDrift(slotBefore, slotAfter);
  check(
    "shrink transmutes the widget back into a terminal in the same slot",
    transmutedBack && shrinkDrift <= 2,
    `terminal=${String(transmutedBack)} geometry drift=${shrinkDrift.toFixed(1)}px`,
  );
  const sessionSurvived = await settles(
    () =>
      browser!.evaluate<boolean>(
        `(document.querySelector('.react-flow__node[data-id="${source.id}"] .xterm-rows')?.textContent || '').includes('BUBBLE_SENTINEL')`,
      ),
    20_000,
  );
  // Rendered screen text outlives a dead shell, so liveness is asserted separately: the
  // rounds below expand this same session again and would fail with a mystery timeout.
  const stillRunning = await browser.evaluate<boolean>(
    "document.querySelector('.terminal-exited') === null",
  );
  check(
    "the session survives the expand/shrink round trip",
    sessionSurvived && stillRunning,
    `sentinel=${String(sessionSurvived)} shell still running=${String(stillRunning)}`,
  );
  // The watcher never left, so its tab must show the pop happen: the widget it was
  // previewing becomes a plain terminal again, in place, with no remount.
  const watchedPop = await settles(
    () =>
      watcher!.evaluate<boolean>(
        `document.querySelector('.react-flow__node[data-id="${source.id}"] .flow-terminal') !== null &&
         document.querySelector('.react-flow__node[data-id="${source.id}"] .flow-portal') === null`,
      ),
    25_000,
  );
  const watcherSlotPopped = await nodeRect(watcher, source.id);
  const watchedPopDrift = rectDrift(watcherSlotBefore, watcherSlotPopped);
  check(
    "the watching collaborator sees the widget transmute back under it",
    watchedPop && watchedPopDrift <= 2,
    `terminal=${String(watchedPop)} geometry drift=${watchedPopDrift.toFixed(1)}px`,
  );
  // The sidebar tree is fetched per mount rather than polled, so the popped row is read
  // from fresh mounts instead of from the stale lists these tabs are already holding.
  await openCanvas(browser, padId, "origin canvas remounted after the pop");
  await openCanvas(watcher, padId, "watcher remounted after the pop");
  const goneHere = await settles(
    () => browser!.evaluate<boolean>(`document.querySelector(${bubbleRow}) === null`),
    15_000,
  );
  const goneThere = await settles(
    () => watcher!.evaluate<boolean>(`document.querySelector(${bubbleRow}) === null`),
    15_000,
  );
  check(
    "the popped bubble leaves no sidebar row in either browser",
    goneHere && goneThere,
    `expander=${String(goneHere)} watcher=${String(goneThere)}`,
  );

  // 7. Splitting hardens: a pooled terminal dropped into a tile makes the view durable,
  //    and it survives shrink as a widget holding both tiles with its row intact.
  const canvasTerminals = await termCount();
  if (!(await clickIn(browser, '[aria-label^="New terminal on "]'))) {
    throw new Error("no online machine row to open a second terminal from");
  }
  await until(
    async () => (await termCount()) === canvasTerminals + 1,
    30_000,
    "second terminal opened on the canvas",
  );
  await sleep(1000);
  const spareId = await browser.evaluate<string>(
    `([...document.querySelectorAll('.react-flow__node')].map((node) => node.dataset.id).find((id) => id !== '${source.id}') ?? '')`,
  );
  if (spareId === "") throw new Error("second terminal element not found on the canvas");
  if (
    !(await clickIn(
      browser,
      `.react-flow__node[data-id="${spareId}"] [aria-label="Park terminal to sidebar"]`,
    ))
  ) {
    throw new Error("second terminal has no park button");
  }
  await until(
    () => browser!.evaluate<boolean>("document.querySelector('.terminal-pool-row') !== null"),
    25_000,
    "parked terminal reached the pool",
  );
  const pooledId = await browser.evaluate<string>(
    "(document.querySelector('.terminal-pool-row')?.dataset.sessionId ?? '')",
  );
  if (pooledId === "") throw new Error("pool row carries no session id");
  // Let the park's element removal and pool refetch settle: the next gesture expands the
  // OTHER terminal, and a bind/park round trip mid-flight has raced it before.
  await sleep(1500);

  if (!(await clickIn(browser, expandButton))) {
    throw new Error("expand button vanished after the bubble popped");
  }
  await until(
    () => browser!.evaluate<boolean>("document.querySelector('.tiled-leaf') !== null"),
    30_000,
    "second expand entered the tiled renderer",
  );
  const splitRoute = await routePath(browser);
  const splitViewId = splitRoute.slice(3);
  await sleep(1200);
  const poolDrop = await nativeDrag(
    browser,
    `.pad-tree-item[data-tree-kind="terminal"][data-tree-id="${pooledId}"]`,
    { selector: ".tiled-leaf", fx: 0.9, fy: 0.5 },
  );
  check(
    "a pool row drag carries the terminal mime into a tile drop",
    poolDrop.ok && poolDrop.types.includes("application/x-manifold-terminal") && poolDrop.accepted,
    `types=[${poolDrop.types.join(", ")}] accepted=${String(poolDrop.accepted)}`,
  );
  const twoTiles = await settles(async () => (await viewTerminals(browser!)) === 2, 30_000);
  check(
    "the drop splits the view into two live tiles",
    twoTiles,
    `terminals rendered inside the view: ${String(await viewTerminals(browser))}`,
  );
  const hardened = await settles(
    () =>
      browser!.evaluate<boolean>(
        "document.querySelector('.tiled-bubble-chip') === null && document.querySelector('[aria-label^=\"Pin view\"]') === null",
      ),
    20_000,
  );
  check(
    "a second tile hardens the bubble",
    hardened,
    `bubble chip and pin control both gone: ${String(hardened)}`,
  );

  if (!(await clickIn(browser, '[aria-label="Shrink view"]'))) {
    throw new Error("the hardened view has no shrink control");
  }
  await until(
    async () => (await routePath(browser!)) === `/p/${padId}`,
    15_000,
    "shrink left the hardened view",
  );
  const widgetKept = await settles(
    async () => (await tilesInside(browser!, source.id)) === 2,
    25_000,
  );
  check(
    "a split view survives shrink as a widget holding both tiles",
    widgetKept,
    `tiles inside the widget: ${String(await tilesInside(browser, source.id))}`,
  );
  const splitName = await padNameOf(splitViewId);
  const splitRow = rowFor(splitName);
  const splitTransientRow = transientRowFor(splitName);
  await openCanvas(browser, padId, "origin canvas remounted after hardening");
  const rowKept = await settles(
    () =>
      browser!.evaluate<boolean>(
        `document.querySelector(${splitRow}) !== null && document.querySelector(${splitTransientRow}) === null`,
      ),
    20_000,
  );
  check(
    "the hardened view keeps a durable sidebar row",
    rowKept,
    `durable row for “${splitName}”: ${String(rowKept)}`,
  );

  // 8. A canvas snapped into a tile renders its LIVE board: the tiled renderer mounts a
  //    real React Flow instance for a pad surface, not a name card.
  const embeddedPadId = await createPad("mirror-gate-embedded");
  embedded = new SessionClient({
    url: `${origin.replace(/^http/, "ws")}/ws/session`,
    padId: embeddedPadId,
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
  await browser.goto(`${origin}/p/${splitViewId}`);
  await until(
    () => browser!.evaluate<boolean>("document.querySelector('.tiled-leaf') !== null"),
    25_000,
    "hardened view remounted for the canvas drop",
  );
  await sleep(1500);
  const padDrop = await nativeDrag(
    browser,
    `.pad-tree-item[data-tree-kind="pad"][data-tree-id="${embeddedPadId}"]`,
    { selector: ".tiled-leaf", fx: 0.5, fy: 0.9 },
  );
  check(
    "a pad row drag carries the container mime into a tile drop",
    padDrop.ok && padDrop.types.includes("application/x-manifold-container") && padDrop.accepted,
    `types=[${padDrop.types.join(", ")}] accepted=${String(padDrop.accepted)}`,
  );
  const liveBoard = await settles(
    () =>
      browser!.evaluate<boolean>(
        "document.querySelector('.tiled-leaf .react-flow') !== null && (document.querySelector('.tiled-leaf .flow-text')?.textContent || '').includes('EMBEDDED_CANVAS_LIVE')",
      ),
    30_000,
  );
  check(
    "a canvas snapped into a tile renders its live board",
    liveBoard,
    `nested react-flow rendering the embedded element: ${String(liveBoard)}`,
  );

  // 9. Composition by drag, the canvas-side door into a view: holding one terminal over
  //    another morphs the target into view chrome, the release births a hardened view
  //    around both surfaces in the target's own slot, and dragging a tile back out
  //    decomposes it into a plain element again.
  const composePadId = await createPad("mirror-gate-compose");
  composed = new SessionClient({
    url: `${origin.replace(/^http/, "ws")}/ws/session`,
    padId: composePadId,
    token: ownerKey,
    reconnect: false,
  });
  await composed.connect();
  await openCanvas(browser, composePadId, "compose canvas mounted");
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
  if (anchor?.type !== "terminal" || mover?.type !== "terminal") {
    throw new Error("compose canvas does not hold two terminal elements");
  }
  for (const [element, name] of [
    [anchor, "alpha"],
    [mover, "beta"],
  ] as const) {
    const renamed = await fetch(`${origin}/api/terminals/${element.sessionId}`, {
      method: "PATCH",
      headers: httpHeaders,
      body: JSON.stringify({ name }),
    });
    if (!renamed.ok) throw new Error(`could not name the ${name} terminal`);
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
  const morphed = await settles(
    () =>
      browser!.evaluate<boolean>(
        `document.querySelector('.react-flow__node[data-id="${anchor.id}"] .flow-node--compose-target') !== null`,
      ),
    6_000,
  );
  const snapPreview = await browser.evaluate<boolean>(
    "document.querySelector('.flow-compose-preview') !== null",
  );
  check(
    "holding a terminal over another arms view chrome and a snap preview",
    morphed && snapPreview,
    `morph=${String(morphed)} preview=${String(snapPreview)}`,
  );
  await releaseAt(browser, { x: zone.x + 1, y: zone.y });

  const composedWidget = await settles(
    () =>
      browser!.evaluate<boolean>(
        `document.querySelector('.react-flow__node[data-id="${anchor.id}"] .flow-portal') !== null`,
      ),
    30_000,
  );
  const composedRect = await nodeRect(browser, anchor.id);
  const composeDrift = rectDrift(anchorRect, composedRect);
  check(
    "the release births a view widget over the target's geometry",
    composedWidget && composeDrift <= 2,
    `widget=${String(composedWidget)} geometry drift=${composeDrift.toFixed(1)}px`,
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
    "both sessions render as tiles inside the composed widget",
    bothInside && moverConsumed,
    `tiles=${String(await tilesInside(browser, anchor.id))} dragged element consumed=${String(moverConsumed)}`,
  );
  // The composed row is read from a FRESH mount (the tree does not poll).
  await openCanvas(watcher, composePadId, "watcher mounted the compose canvas");
  const composedRow = rowFor("alpha + beta");
  const composedTransientRow = transientRowFor("alpha + beta");
  const namedRow = await settles(
    () =>
      watcher!.evaluate<boolean>(
        `document.querySelector(${composedRow}) !== null && document.querySelector(${composedTransientRow}) === null`,
      ),
    25_000,
  );
  check(
    "composition writes a hardened row named after both surfaces",
    namedRow,
    `durable row “alpha + beta”: ${String(namedRow)}`,
  );

  // Extraction leaves ONE leaf behind, and an unclaimed one-tile view is a bubble: it
  // survives only while somebody is genuinely inside it. The widget's own preview is a
  // SPECTATOR and does not count, so the watcher walks into the view for real — occupancy
  // is the thing being tested here, not the presence of a socket.
  const composedViewId = await padIdNamed("alpha + beta");
  if (composedViewId === "") throw new Error("the composed view is missing from /api/pads");
  await watcher.goto(`${origin}/p/${composedViewId}`);
  await until(
    () => watcher!.evaluate<boolean>("document.querySelector('.tiled-pad-view') !== null"),
    25_000,
    "watcher occupied the composed view",
  );

  const extraction = await nativeDrag(
    browser,
    `.react-flow__node[data-id="${anchor.id}"] .flow-portal__shield`,
    { selector: ".react-flow__pane", fx: 0.2, fy: 0.85 },
  );
  check(
    "a tile drag out of a widget carries the tile mime onto the canvas",
    extraction.ok &&
      extraction.types.includes("application/x-manifold-tile") &&
      extraction.accepted,
    `types=[${extraction.types.join(", ")}] accepted=${String(extraction.accepted)}`,
  );
  const plainTerminals = (target: Browser): Promise<number> =>
    target.evaluate<number>("document.querySelectorAll('.react-flow__node .flow-terminal').length");
  const reAuthored = await settles(async () => (await plainTerminals(browser!)) === 1, 30_000);
  const oneTileLeft = await settles(
    async () => (await tilesInside(browser!, anchor.id)) === 1,
    30_000,
  );
  check(
    "extraction re-authors a plain terminal element on the canvas",
    reAuthored,
    `plain terminal nodes: ${String(await plainTerminals(browser))}`,
  );
  check(
    "the decomposed widget keeps its remaining tile while somebody is inside it",
    oneTileLeft,
    `tiles left inside the widget: ${String(await tilesInside(browser, anchor.id))}`,
  );
  const rowPersisted = (await padNameOf(composedViewId)) === "alpha + beta";
  check(
    "the decomposed view keeps its row while it is still occupied",
    rowPersisted,
    `row survives the extraction: ${String(rowPersisted)}`,
  );

  // The occupant walks out and the leftover single-tile view is a bubble again: it pops,
  // and its widget transmutes back into a plain terminal in the same slot. Only a watcher
  // is left looking at the canvas, which is precisely what may not hold a bubble open.
  await openCanvas(watcher, composePadId, "watcher left the composed view");
  const collapsed = await settles(
    async () =>
      (await plainTerminals(browser!)) === 2 && (await tilesInside(browser!, anchor.id)) === 0,
    30_000,
  );
  const rowGone = (await padNameOf(composedViewId)) === "";
  check(
    "the unclaimed one-tile view pops once its last true occupant leaves",
    collapsed && rowGone,
    `plain terminals=${String(await plainTerminals(browser))} tiles left=${String(await tilesInside(browser, anchor.id))} row gone=${String(rowGone)}`,
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
  rmSync(distDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(
  failures.length === 0
    ? "\nterminal-mirror gate: GREEN"
    : `\nterminal-mirror gate: RED\n${failures.map((f) => ` - ${f}`).join("\n")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
