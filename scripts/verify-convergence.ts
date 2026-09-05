/**
 * manifold multi-client convergence gate.
 *
 * The bug class this guards: the browser-canvas↔SDK projection layer losing, reverting,
 * or silently not-sending edits while every wire-level test stays green. It drives TWO
 * real browsers through real pointer gestures against a throwaway local server and asserts,
 * after quiescence, the strongest invariant the system claims:
 *
 *   A.canvas ≡ A.sdkScene ≡ server canonical ≡ B.sdkScene ≡ B.canvas
 *
 * compared by version stamp AND geometry (stamp-only comparison cannot distinguish a
 * converged-but-truncated scene from a correct one). Every round also asserts its own
 * EFFECT — element-count delta and per-element stamp change — so a silently no-op
 * gesture fails the round instead of passing it vacuously.
 *
 * The canvas objects it drags are REAL terminals. A terminal lives in a solo composition
 * and a canvas references it as a `portal` onto that composition, which renders
 * element-chrome-first (`.portal--mono`): the terminal's own titlebar IS the node's
 * bar and its drag handle. So the gate seeds by opening PTYs over the wire and authoring
 * the portal exactly as `canvas-view`'s `createTerminal` does — a fabricated portal onto
 * a container that does not exist would render a dead card and prove nothing about the
 * chrome every gesture below actually grabs.
 *
 * Requires the debug probe (localStorage "manifold:debug" = "1"; packages/plugin/src/debug-probe.ts).
 * Self-contained: builds the web bundle to a temp dir, spawns its own server, cleans up
 * even on failure.
 *
 * Usage:  bun scripts/verify-convergence.ts            # or: bun run verify:convergence
 * Env:    MANIFOLD_CHROMIUM (else system chromium)
 *
 * Exit 0 only if every round converges with its expected effect.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionClient } from "../packages/sdk/src/index.ts";
import {
  ActionOutcomeSchema,
  ContainerResponseSchema,
  MachinesResponseSchema,
  elementNumbers,
  elementPayloadDigest,
  elementString,
  type SceneElement,
} from "../packages/protocol/src/index.ts";
import { resolveWebDist } from "./gate-dist.ts";
import { Browser } from "./cdp.ts";
import { ownerKeyOf, sleep, teardownServer, until } from "./gate-lib.ts";

const repoRoot = join(import.meta.dir, "..");
const { distDir, cleanup: cleanupDist } = resolveWebDist("manifold-conv-");
const dataDir = mkdtempSync(join(tmpdir(), "manifold-conv-data-"));
let origin = "";

const server = Bun.spawn(["bun", "packages/server/src/main.ts"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    MANIFOLD_PORT: "0",
    MANIFOLD_DATA_DIR: dataDir,
    MANIFOLD_WEB_DIST: distDir,
    // A canvas terminal is a REAL terminal: the gate seeds its portals by opening
    // PTYs over the wire, so it needs a machine to open them on.
    MANIFOLD_SPAWN_AGENT: "1",
  },
  stdout: "pipe",
  stderr: "inherit",
});

async function serverOriginFromReadyLine(): Promise<string> {
  const reader = server.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffered += decoder.decode(chunk.value, { stream: true });
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const readyUrl = /manifold ready url=(https?:\/\/[^\s"']+)/.exec(line)?.[1];
      if (readyUrl !== undefined) return new URL(readyUrl).origin;
    }
  }
  throw new Error("server exited before emitting its ready URL");
}

const browserA = new Browser();
const browserB = new Browser();
const failures: string[] = [];
let observer: SessionClient | null = null;

interface Snapshot {
  readonly id: string;
  readonly type: SceneElement["type"];
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly zIndex: number;
  /**
   * The payload as one comparable string. The SAME digest the browser probe reports
   * (`elementPayloadDigest`), because the two sides of this comparison must not each
   * invent a fingerprint (ADR 0013 §16).
   */
  readonly extra: string;
}

interface Viewport {
  readonly scrollX: number;
  readonly scrollY: number;
  readonly zoom: number;
  readonly offsetLeft: number;
  readonly offsetTop: number;
}

/** Measured paint order of the presence layer against the scene's highest node band. */
interface PaintProbe {
  readonly state: string;
  readonly presenceZ?: number;
  readonly nodeZ?: number;
}

/** Measured state of a remote cursor inside a composition's presence overlay. */
interface ViewCursorProbe {
  readonly state: "no-body" | "no-layer" | "no-cursor" | "measured";
  /** Every cursor painted in the overlay, whichever principal owns it. */
  readonly count?: number;
  /** Arrow tip as a fraction of the tile area — the composition wire coordinate space. */
  readonly fx?: number;
  readonly fy?: number;
  readonly width?: number;
  readonly height?: number;
  readonly inside?: boolean;
  readonly visible?: boolean;
  /** The overlay covers the whole tile area, so a fraction means the same tile for all. */
  readonly layerFills?: boolean;
}

try {
  origin = await Promise.race([
    serverOriginFromReadyLine(),
    Bun.sleep(20_000).then(() => {
      throw new Error("server readiness timed out after 20000ms");
    }),
  ]);
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

  // `core.index.createContainer` replaced `POST /api/containers`: the index owns its own doors, and a
  // denial is data inside the outcome envelope rather than a status.
  const created = await fetch(`${origin}/api/actions/core.index.createContainer`, {
    method: "POST",
    headers: httpHeaders,
    body: JSON.stringify({ name: "convergence-gate" }),
  });
  const createdOutcome = ActionOutcomeSchema.parse(await created.json());
  if (!createdOutcome.ok)
    throw new Error(`createContainer refused: ${createdOutcome.denial.message}`);
  const containerId = ContainerResponseSchema.parse(createdOutcome.result).container.id;

  // ---------------------------------------------------------------- clients

  async function openContainer(browser: Browser, name: string, color?: string): Promise<void> {
    await browser.launch();
    await browser.goto(`${origin}/#key=${ownerKey}`);
    await browser.evaluate("localStorage.setItem('manifold:debug', '1')");
    if (await browser.evaluate<boolean>("document.querySelector('input') !== null")) {
      await browser.typeInto("input", name);
      if (color !== undefined) {
        const selected = await browser.evaluate<boolean>(
          `(() => { const swatch = document.querySelector(${JSON.stringify(`[aria-label="Use color ${color}"]`)});
            if (!(swatch instanceof HTMLButtonElement)) return false; swatch.click(); return true; })()`,
        );
        if (!selected) throw new Error(`${name}: identity color ${color} not found`);
      }
      await browser.clickTestId("identity-enter");
    }
    await browser.goto(`${origin}/p/${containerId}`);
    await until(
      () =>
        browser.evaluate<boolean>(
          "(document.querySelector('[data-testid=connection-state]')?.textContent ?? '').toLowerCase() === 'open'",
        ),
      20_000,
      `${name}: terminal open`,
    );
    await until(
      () => browser.evaluate<boolean>("window.__manifold !== undefined"),
      10_000,
      `${name}: debug probe installed`,
    );
  }

  const cursorColor = "#e03131";
  await openContainer(browserA, "convA", cursorColor);
  await openContainer(browserB, "convB");

  // ------------------------------------------------ presence & status chrome

  if (await browserA.evaluate<boolean>("document.querySelector('.UserList') !== null")) {
    throw new Error("convA: stock UserList rendered despite UIOptions.userList=false");
  }
  console.log("PASS  stock UserList suppressed");
  await until(
    () =>
      browserA.evaluate<boolean>(
        "document.querySelectorAll('.presence-wrapper .presence-avatar').length === 2",
      ),
    10_000,
    "convA: presence island shows self + convB",
  );
  console.log("PASS  presence island shows both principals");
  if (
    !(await browserA.evaluate<boolean>(
      "(document.querySelector('.sidebar .sidebar-status [data-testid=connection-state]')?.textContent ?? '').toLowerCase() === 'open'",
    ))
  ) {
    throw new Error("convA: sidebar workspace status missing or not open");
  }
  console.log("PASS  sidebar workspace status is live");

  const changelogOpened = await browserA.evaluate<boolean>(
    `(() => {
      const button = document.querySelector('.sidebar-version');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`,
  );
  if (!changelogOpened) throw new Error("convA: web version button missing");
  await until(
    () =>
      browserA.evaluate<boolean>(
        "document.querySelector('.web-changelog-dialog')?.hasAttribute('open') === true",
      ),
    5_000,
    "convA: changelog dialog open",
  );
  // The rev line prints the build `/healthz` answers — one derivation, two surfaces — so the
  // assertion reads the instance rather than pinning the label's grammar.
  const health = (await (await fetch(`${origin}/healthz`)).json()) as { build?: unknown };
  if (typeof health.build !== "string") throw new Error("convA: /healthz names no build");
  const changelogValid = await browserA.evaluate<boolean>(
    `(() => {
      const dialog = document.querySelector('.web-changelog-dialog');
      const label = document.querySelector('.sidebar-version')?.textContent ?? '';
      return dialog?.getAttribute('aria-labelledby') === 'web-changelog-title'
        && label.includes(${JSON.stringify(`v${health.build}`)})
        && dialog.querySelectorAll('.web-changelog-releases li').length > 0;
    })()`,
  );
  if (!changelogValid) throw new Error("convA: changelog dialog content or build label invalid");
  await browserA.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await browserA.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await until(
    () =>
      browserA.evaluate<boolean>(
        "document.querySelector('.web-changelog-dialog') === null && document.activeElement?.classList.contains('sidebar-version') === true",
      ),
    5_000,
    "convA: changelog closes and restores focus",
  );
  console.log("PASS  web build label opens an accessible changelog and Escape restores focus");

  const identityBeforeRefresh = await browserA.evaluate<string>(
    "localStorage.getItem('manifold.identity') ?? ''",
  );
  await browserA.goto(`${origin}/p/${containerId}`);
  await until(
    () =>
      browserA.evaluate<boolean>(
        "(document.querySelector('[data-testid=connection-state]')?.textContent ?? '').toLowerCase() === 'open'",
      ),
    20_000,
    "convA: terminal reopened after refresh",
  );
  const identityAfterRefresh = await browserA.evaluate<string>(
    "localStorage.getItem('manifold.identity') ?? ''",
  );
  if (identityAfterRefresh !== identityBeforeRefresh) {
    throw new Error("convA: persisted principal changed across page refresh");
  }
  await browserA.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 620, y: 360 });
  await until(
    () =>
      browserB.evaluate<boolean>(
        `(() => {
          const cursor = document.querySelector(${JSON.stringify(`[data-cursor-color="${cursorColor}"]`)});
          if (!(cursor instanceof HTMLElement)) return false;
          const rect = cursor.getBoundingClientRect();
          const style = getComputedStyle(cursor);
          return rect.width > 0 && rect.height > 0
            && style.display !== "none" && style.visibility !== "hidden"
            && style.color === "rgb(224, 49, 49)";
        })()`,
      ),
    5_000,
    "convA: chosen identity color rendered on convB cursor after refresh",
  );
  console.log("PASS  refresh preserves principal and chosen cursor color");

  const sdk = new SessionClient({
    url: `${origin.replace(/^http/, "ws")}/ws/session`,
    containerId,
    token: ownerKey,
    reconnect: false,
  });
  observer = sdk;
  await sdk.connect();

  // ---------------------------------------------------------------- views & invariant

  /** id → full mutation stamp; every persisted element field exercised by this gate contributes. */
  type ViewMap = Map<string, string>;

  function snapshotStamp(snapshot: Snapshot): string {
    return `${snapshot.type}:${snapshot.x.toFixed(1)}:${snapshot.y.toFixed(1)}:${snapshot.width.toFixed(1)}:${snapshot.height.toFixed(1)}:${String(snapshot.zIndex)}:${String(snapshot.extra)}`;
  }

  function toViewMap(snapshots: readonly Snapshot[]): ViewMap {
    return new Map(snapshots.map((snapshot) => [snapshot.id, snapshotStamp(snapshot)]));
  }

  function canonicalView(): ViewMap {
    const map: ViewMap = new Map();
    for (const element of sdk.elements.values()) {
      // Neutral over element kinds, and identical to what the browser probe reports, so
      // the five views are compared by one fingerprint rather than three per-kind guesses
      // that the engine has no business knowing (ADR 0013 §16).
      map.set(
        element.id,
        `${element.type}:${element.x.toFixed(1)}:${element.y.toFixed(1)}:${element.width.toFixed(1)}:${element.height.toFixed(1)}:${String(element.zIndex)}:${elementPayloadDigest(element)}`,
      );
    }
    return map;
  }

  async function view(browser: Browser, which: "canvas" | "scene"): Promise<ViewMap> {
    const snapshots = await browser.evaluate<readonly Snapshot[]>(`window.__manifold.${which}()`);
    return toViewMap(snapshots);
  }

  function diffMaps(label: string, expected: ViewMap, actual: ViewMap): string[] {
    const lines: string[] = [];
    for (const [id, stamp] of expected) {
      const other = actual.get(id);
      if (other === undefined) lines.push(`${label}: missing ${id} (canonical ${stamp})`);
      else if (other !== stamp) lines.push(`${label}: ${id} at ${other}, canonical ${stamp}`);
    }
    for (const id of actual.keys()) {
      if (!expected.has(id)) lines.push(`${label}: extra ${id} not in canonical`);
    }
    return lines;
  }

  function mapsEqual(a: ViewMap, b: ViewMap): boolean {
    if (a.size !== b.size) return false;
    for (const [id, stamp] of a) if (b.get(id) !== stamp) return false;
    return true;
  }

  interface RoundEffect {
    /** Exact number of NEW canonical elements this round must create. */
    readonly adds: number;
    /** Ids whose canonical stamp (version or geometry) must have advanced. */
    readonly changes?: readonly string[];
  }

  /**
   * What a browser was DOING when a round failed. A five-view diff says the views
   * disagree; it never says why, and the two answers a stuck gesture needs — did the
   * page throw, and does React Flow still think a pointer is down — are invisible to
   * every DOM read the assertions make. Draining the console buffer here is also what
   * keeps the dump scoped to the failing round.
   */
  interface BrowserForensics {
    readonly outbox: number;
    readonly rev: number;
    readonly epoch: number;
    readonly connection: string;
    /** Node ids React Flow is mid-drag on: non-empty means a pointer is still held. */
    readonly dragging: readonly string[];
    readonly gestures: readonly { readonly elementId: string; readonly connId: string }[];
  }

  const FORENSICS = `(() => {
      const probe = window.__manifold;
      const status = document.querySelector('[data-testid="connection-status"]');
      return {
        outbox: probe.outbox(),
        rev: probe.rev(),
        epoch: probe.epoch(),
        connection: status === null ? "no status ref" : (status.getAttribute("title") ?? ""),
        dragging: [...document.querySelectorAll(".react-flow__node.dragging")].map(
          (node) => node.getAttribute("data-id") ?? "?",
        ),
        gestures: probe.gestures(),
      };
    })()`;

  async function dumpForensics(name: string): Promise<void> {
    for (const [browser, label] of [
      [browserA, "A"],
      [browserB, "B"],
    ] as const) {
      try {
        const state = await browser.evaluate<BrowserForensics>(FORENSICS);
        console.log(
          `        ${label}: outbox=${String(state.outbox)} rev=${String(state.rev)} epoch=${String(
            state.epoch,
          )} ${state.connection}`,
        );
        console.log(
          `        ${label}: dragging=[${state.dragging.join(",")}] gestures=${JSON.stringify(
            state.gestures,
          )}`,
        );
      } catch (error) {
        console.log(
          `        ${label}: forensics probe failed — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      for (const message of browser.drainMessages()) {
        console.log(`        ${label}.${message.kind}/${message.level}: ${message.text}`);
      }
    }
    console.log(`        (forensics for ${name})`);
  }

  /**
   * Runs one round: capture canonical before-state, perform gestures, wait for five-view
   * convergence, then assert the round's declared effect. Probe errors ref in the
   * failure output instead of being reported as stale diffs.
   */
  async function round(name: string, effect: RoundEffect, act: () => Promise<void>): Promise<void> {
    const before = canonicalView();
    let lastDiff: string[] = [];
    try {
      await act();
      await until(
        async () => {
          const canonical = canonicalView();
          const views: [string, ViewMap][] = [
            ["A.canvas", await view(browserA, "canvas")],
            ["A.scene", await view(browserA, "scene")],
            ["B.scene", await view(browserB, "scene")],
            ["B.canvas", await view(browserB, "canvas")],
          ];
          lastDiff = views.flatMap(([label, m]) =>
            mapsEqual(m, canonical) ? [] : diffMaps(label, canonical, m),
          );
          for (const [browser, label] of [
            [browserA, "A"],
            [browserB, "B"],
          ] as const) {
            const outbox = await browser.evaluate<number>("window.__manifold.outbox()");
            if (outbox > 0) lastDiff.push(`${label}.outbox: ${String(outbox)}`);
          }
          // Effect assertions: a silently no-op gesture must fail, not pass vacuously.
          const canonicalNow = canonicalView();
          if (canonicalNow.size !== before.size + effect.adds) {
            lastDiff.push(
              `effect: expected ${String(before.size + effect.adds)} canonical elements, have ${String(canonicalNow.size)}`,
            );
          }
          for (const id of effect.changes ?? []) {
            if (canonicalNow.get(id) === before.get(id)) {
              lastDiff.push(`effect: ${id} canonical stamp did not advance`);
            }
          }
          return lastDiff.length === 0;
        },
        30_000,
        "five-view convergence with declared effect",
      );
      console.log(`PASS  ${name} — converged, ${String(canonicalView().size)} elements canonical`);
    } catch (error) {
      failures.push(name);
      console.log(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`);
      for (const line of lastDiff) console.log(`        ${line}`);
      await dumpForensics(name);
    }
  }

  // ---------------------------------------------------------------- rounds

  console.log(`convergence rounds against ${origin} container ${containerId}`);
  const canvasLeftA = await browserA.evaluate<number>(
    "document.querySelector('.workspace-canvas')?.getBoundingClientRect().left ?? 0",
  );

  /**
   * A machine to open PTYs on. The gate spawns the bundled local agent, which registers
   * a moment after the server is listening.
   */
  let machineId = "";
  await until(
    async () => {
      const outcome = ActionOutcomeSchema.parse(
        await (
          await fetch(`${origin}/api/actions/core.machines.list`, {
            method: "POST",
            headers: httpHeaders,
            body: "{}",
          })
        ).json(),
      );
      if (!outcome.ok) throw new Error(`machines list refused: ${outcome.denial.message}`);
      const listed = MachinesResponseSchema.parse(outcome.result);
      machineId = listed.machines.find((machine) => machine.online)?.id ?? "";
      return machineId !== "";
    },
    30_000,
    "an online machine to open terminals on",
  );

  /**
   * Opens one REAL terminal and returns the canvas reference its opener owes — a portal
   * onto the solo composition `terminal_open` just created, under the id the open
   * correlated on. These are the two steps `createTerminal` in `canvas-view.tsx` takes,
   * split so the round measures only the second: the PTY and its home already exist when
   * the round starts, so what converges is the AUTHORING, not the spawn latency.
   *
   * The element it describes is the round's subject: every gesture below grabs the
   * mono-portal chrome this reference makes the canvas render.
   */
  const terminalPortal = async (x: number, y: number): Promise<SceneElement> => {
    const elementId = crypto.randomUUID();
    const terminal = await sdk.openTerminal({ elementId, cols: 80, rows: 24, machineId });
    return {
      id: elementId,
      type: "portal",
      containerId: terminal.containerId,
      x,
      y,
      width: 480,
      height: 320,
      zIndex: 0,
    };
  };
  const moveFlowNode = async (
    browser: Browser,
    elementId: string,
    dx: number,
    dy: number,
    liveRemote?: Browser,
  ): Promise<void> => {
    const start = await browser.evaluate<{
      readonly pointerX: number;
      readonly pointerY: number;
      readonly nodeX: number;
      readonly nodeY: number;
      /** What the pointer would actually hit there, and how that ref advertises itself. */
      readonly handleOwned: boolean;
      readonly cursor: string;
    } | null>(
      /*
        A canvas terminal is a MONO PORTAL, so its drag handle is the terminal's own
        titlebar inside the portal frame — the scoped selector is the point: it fails
        loudly if the arity rule stops resolving and the node falls back to composition
        chrome. The grab lands at a quarter width, clear of the controls on the right.

        `handleOwned`/`cursor` are asserted because `.terminal-titlebar` is
        `pointer-events: none` by default (it floats over the xterm ref): a bar that
        renders but does not take the pointer is exactly how canvas terminals silently
        became undraggable while every synthetic-click assertion stayed green.
      */
      `(() => {
          const node = document.querySelector(
            ${JSON.stringify(`.react-flow__node[data-id="${elementId}"]`)},
          );
          const titlebar = node?.querySelector(".portal--mono .terminal-titlebar");
          if (!(node instanceof HTMLElement) || !(titlebar instanceof HTMLElement)) return null;
          const nodeRect = node.getBoundingClientRect();
          const titlebarRect = titlebar.getBoundingClientRect();
          if (titlebarRect.width <= 0 || titlebarRect.height <= 0) return null;
          const pointerX = titlebarRect.left + titlebarRect.width / 4;
          const pointerY = titlebarRect.top + titlebarRect.height / 2;
          const hit = document.elementFromPoint(pointerX, pointerY);
          return {
            pointerX,
            pointerY,
            nodeX: nodeRect.left,
            nodeY: nodeRect.top,
            handleOwned: hit instanceof Element && titlebar.contains(hit),
            cursor: hit === null ? "none" : getComputedStyle(hit).cursor,
          };
        })()`,
    );
    if (start === null) {
      throw new Error(`terminal ${elementId} renders no mono-portal titlebar to grab`);
    }
    if (!start.handleOwned || start.cursor !== "grab") {
      throw new Error(
        `terminal ${elementId} titlebar is not a grabbable pointer target (owned=${String(
          start.handleOwned,
        )} cursor=${start.cursor})`,
      );
    }
    const remoteBefore =
      liveRemote === undefined
        ? null
        : await liveRemote.evaluate<Snapshot | null>(
            `window.__manifold.canvas().find((element) => element.id === ${JSON.stringify(elementId)}) ?? null`,
          );
    const steps = 20;
    await browser.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: start.pointerX,
      y: start.pointerY,
    });
    await browser.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: start.pointerX,
      y: start.pointerY,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    /*
      Everything between the press and the release runs under a `finally` that always
      releases the button. Not a softened assertion — every throw below still throws, and
      the ordering probe still measures the node BEFORE the release. It is a containment
      rule: a round that fails mid-gesture used to leave chromium holding a real mouse
      button down, so React Flow stayed in a live drag and every LATER round's pointer
      events kept dragging THAT node. One failure reported four, and the three false ones
      named the wrong element.
    */
    let duringDrag: { readonly x: number; readonly y: number } | null = null;
    try {
      for (let index = 1; index <= steps; index += 1) {
        await browser.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: start.pointerX + (dx * index) / steps,
          y: start.pointerY + (dy * index) / steps,
          button: "left",
          buttons: 1,
        });
        await sleep(15);
      }
      if (liveRemote !== undefined) {
        if (remoteBefore === null) throw new Error(`remote terminal ${elementId} was not rendered`);
        await until(
          async () => {
            const remote = await liveRemote.evaluate<Snapshot | null>(
              `window.__manifold.canvas().find((element) => element.id === ${JSON.stringify(elementId)}) ?? null`,
            );
            const gestures = await liveRemote.evaluate<readonly { readonly elementId: string }[]>(
              "window.__manifold.gestures()",
            );
            return (
              remote !== null &&
              Math.abs(remote.x - remoteBefore.x) >= Math.abs(dx) * 0.5 &&
              Math.abs(remote.y - remoteBefore.y) >= Math.abs(dy) * 0.5 &&
              gestures.some((gesture) => gesture.elementId === elementId)
            );
          },
          15_000,
          `remote terminal ${elementId} to move before pointer release`,
        );
      }
      duringDrag = await browser.evaluate<{ readonly x: number; readonly y: number } | null>(
        `(() => {
          const node = document.querySelector(
            ${JSON.stringify(`.react-flow__node[data-id="${elementId}"]`)},
          );
          if (!(node instanceof HTMLElement)) return null;
          const rect = node.getBoundingClientRect();
          return { x: rect.left, y: rect.top };
        })()`,
      );
    } finally {
      await browser.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: start.pointerX + dx,
        y: start.pointerY + dy,
        button: "left",
        clickCount: 1,
      });
    }
    if (
      duringDrag === null ||
      Math.abs(duringDrag.x - start.nodeX) < Math.abs(dx) * 0.5 ||
      Math.abs(duringDrag.y - start.nodeY) < Math.abs(dy) * 0.5
    ) {
      throw new Error(
        `terminal ${elementId} in browser ${browser === browserA ? "A" : "B"} moved ${
          duringDrag === null
            ? "no rendered node"
            : `${(duringDrag.x - start.nodeX).toFixed(1)},${(duringDrag.y - start.nodeY).toFixed(1)}`
        } before release; expected ${String(dx)},${String(dy)}`,
      );
    }
  };

  const panePoint = async (
    browser: Browser,
    xRatio: number,
    yRatio: number,
  ): Promise<{ readonly x: number; readonly y: number }> =>
    await browser.evaluate(
      `(() => {
        const pane = document.querySelector(".react-flow__pane");
        if (!(pane instanceof HTMLElement)) throw new Error("React Flow pane missing");
        const rect = pane.getBoundingClientRect();
        const candidates = [
          [${String(xRatio)}, ${String(yRatio)}],
          ...[0.15, 0.3, 0.45, 0.6, 0.75, 0.9].flatMap((y) =>
            [0.15, 0.3, 0.45, 0.6, 0.75, 0.9].map((x) => [x, y])),
        ];
        for (const [xRatio, yRatio] of candidates) {
          const point = { x: rect.left + rect.width * xRatio, y: rect.top + rect.height * yRatio };
          if (document.elementFromPoint(point.x, point.y) === pane) return point;
        }
        throw new Error("no empty React Flow pane point found");
      })()`,
    );

  const clickAt = async (
    browser: Browser,
    point: { readonly x: number; readonly y: number },
    clickCount: number,
  ): Promise<void> => {
    await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    for (let count = 1; count <= clickCount; count += 1) {
      await browser.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...point,
        button: "left",
        buttons: 1,
        clickCount: count,
      });
      await browser.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...point,
        button: "left",
        clickCount: count,
      });
    }
  };

  const pressKey = async (
    browser: Browser,
    key: string,
    code: string,
    modifiers = 0,
  ): Promise<void> => {
    await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers });
    await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
  };

  const first = await terminalPortal(280, 180);
  await round("F1 terminal reference projects into both canvases", { adds: 1 }, async () => {
    sdk.transact((tx) => tx.create(first));
  });
  await round(
    "F2 live remote drag reaches B before A releases",
    { adds: 0, changes: [first.id] },
    () => moveFlowNode(browserA, first.id, 150, 90, browserB),
  );

  const second = await terminalPortal(900, 420);
  await round("F3 second terminal reference projects into both canvases", { adds: 1 }, async () => {
    sdk.transact((tx) => tx.create(second));
  });
  await round(
    "F4 concurrent browser moves converge",
    { adds: 0, changes: [first.id, second.id] },
    async () => {
      await Promise.all([
        moveFlowNode(browserA, second.id, -90, 120),
        moveFlowNode(browserB, first.id, 110, -70),
      ]);
    },
  );
  await round(
    "F5 frozen tab resumes to canonical geometry",
    { adds: 0, changes: [first.id] },
    async () => {
      await browserB.setLifecycle("frozen");
      try {
        await moveFlowNode(browserA, first.id, 80, 60);
        await sleep(500);
      } finally {
        // A tab left frozen never resyncs, so every LATER round would fail on B for a
        // reason that has nothing to do with it. The thaw is not part of the contract.
        await browserB.setLifecycle("active");
      }
    },
  );

  const cursorFrames: { readonly x: number; readonly y: number }[] = [];
  const offCursor = sdk.on("cursor", (message) => {
    cursorFrames.push({ x: message.x, y: message.y });
  });
  const viewportBefore = await browserA.evaluate<Viewport>("window.__manifold.viewport()");
  const panStart = { x: canvasLeftA + 700, y: 650 };
  await browserA.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...panStart });
  await browserA.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...panStart,
    button: "middle",
    buttons: 4,
  });
  for (let index = 1; index <= 14; index += 1) {
    await browserA.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: panStart.x - index * 10,
      y: panStart.y - index * 6,
      button: "middle",
      buttons: 4,
    });
    await sleep(15);
  }
  await browserA.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: panStart.x - 140,
    y: panStart.y - 84,
    button: "middle",
  });
  await sleep(300);
  const viewportAfter = await browserA.evaluate<Viewport>("window.__manifold.viewport()");
  offCursor();
  if (
    Math.abs(viewportAfter.scrollX - viewportBefore.scrollX) < 50 ||
    Math.abs(viewportAfter.scrollY - viewportBefore.scrollY) < 30
  ) {
    throw new Error("Flow viewport did not move under a real middle-button pan");
  }
  if (cursorFrames.length < 3) {
    throw new Error(`Flow pan emitted only ${String(cursorFrames.length)} cursor frames`);
  }
  console.log("PASS  F6 viewport pan and cursor transport cross the browser boundary");

  // Presence is worthless when the canvas paints scene content over it. Element
  // bands grow with every creation (`nextZIndex`), so the presence layer has to
  // sit above the highest one; fixtures pinned at zIndex 0 are exactly why raised
  // terminals could hide every remote cursor, selection and live stroke unnoticed.
  await round(
    "F6b raising a terminal keeps both canvases converged",
    {
      adds: 0,
      changes: [second.id],
    },
    async () => {
      sdk.transact((tx) => {
        tx.patch(second.id, { zIndex: tx.nextZIndex() });
      });
    },
  );

  try {
    const stacked = sdk.elements.get(second.id);
    if (stacked === undefined) throw new Error("raised terminal missing from the canonical scene");
    if (stacked.zIndex <= 0) {
      throw new Error(`raised terminal landed in band ${String(stacked.zIndex)}, expected above 0`);
    }
    // Park B's pointer far away so the only cursor over the target is the SDK's.
    await browserB.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...(await panePoint(browserB, 0.1, 0.9)),
    });
    const center = { x: stacked.x + stacked.width / 2, y: stacked.y + stacked.height / 2 };
    const nodeSelector = JSON.stringify(`.react-flow__node[data-id="${second.id}"]`);
    const paintProbe = `(() => {
      const node = document.querySelector(${nodeSelector});
      if (!(node instanceof HTMLElement)) return { state: "no-node" };
      const box = node.getBoundingClientRect();
      const marker = [...document.querySelectorAll(".remote-cursor")].find((cursor) => {
        const rect = cursor.getBoundingClientRect();
        return (
          rect.left >= box.left - 2 &&
          rect.left <= box.right + 2 &&
          rect.top >= box.top - 2 &&
          rect.top <= box.bottom + 2
        );
      });
      if (marker === undefined) return { state: "no-cursor-over-node" };
      const viewport = document.querySelector(".react-flow__viewport");
      // Paint order is decided by the nearest ancestor-or-self carrying a numeric
      // z-index inside the viewport's stacking context.
      let presenceZ = 0;
      for (let element = marker; element !== null && element !== viewport; element = element.parentElement) {
        const band = Number.parseInt(getComputedStyle(element).zIndex, 10);
        if (Number.isFinite(band)) { presenceZ = band; break; }
      }
      const nodeZ = [...document.querySelectorAll(".react-flow__node")].reduce(
        (max, element) => Math.max(max, Number.parseInt(getComputedStyle(element).zIndex, 10) || 0),
        0,
      );
      return { state: "measured", presenceZ, nodeZ };
    })()`;
    // Cursors are ephemeral and interpolated: keep the frame alive across the probe.
    const cursorBeat = setInterval(() => {
      sdk.sendCursor(center.x, center.y);
    }, 100);
    try {
      await until(
        async () => (await browserA.evaluate<PaintProbe>(paintProbe)).state === "measured",
        5_000,
        "remote cursor rendered over the raised terminal",
      );
      const paint = await browserA.evaluate<PaintProbe>(paintProbe);
      if ((paint.presenceZ ?? 0) <= (paint.nodeZ ?? 0)) {
        throw new Error(
          `presence layer paints at z=${String(paint.presenceZ)}, under scene nodes at z=${String(paint.nodeZ)}`,
        );
      }
      console.log(
        `PASS  F6b remote cursor paints above raised scene nodes — presence z=${String(paint.presenceZ)} over node z=${String(paint.nodeZ)}`,
      );
    } finally {
      clearInterval(cursorBeat);
    }
  } catch (error) {
    failures.push("F6b presence paint order");
    console.log(
      `FAIL  F6b remote cursor paints above raised scene nodes — ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const drawCountBefore = [...sdk.elements.values()].filter(
    (element) => element.type === "draw",
  ).length;
  await round("F7 live remote stroke renders before pointer release", { adds: 1 }, async () => {
    const drawClicked = await browserA.evaluate<boolean>(
      `(() => {
        const button = document.querySelector('[data-testid="toolbar-draw"]');
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`,
    );
    if (!drawClicked) throw new Error("draw tool button was unavailable");
    await until(
      () =>
        browserA.evaluate<boolean>(
          `document.querySelector('[data-testid="toolbar-draw"]')?.getAttribute("aria-pressed") === "true"`,
        ),
      2_000,
      "draw tool activation",
    );
    const start = await panePoint(browserA, 0.55, 0.72);
    const points = Array.from({ length: 14 }, (_value, index) => ({
      x: start.x + index * 12,
      y: start.y + Math.sin(index / 2) * 24,
    }));
    const firstPoint = points[0];
    if (firstPoint === undefined) throw new Error("draw path was empty");
    await browserA.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: firstPoint.x,
      y: firstPoint.y,
    });
    await browserA.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: firstPoint.x,
      y: firstPoint.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    try {
      for (const point of points.slice(1)) {
        await browserA.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: point.x,
          y: point.y,
          button: "left",
          buttons: 1,
        });
        await sleep(20);
      }
      await until(
        () =>
          browserB.evaluate<boolean>(
            `(() => {
              const path = document.querySelector(".stroke-preview[data-gesture-element] path");
              return path instanceof SVGPathElement && (path.getAttribute("d") ?? "").includes("L");
            })()`,
          ),
        5_000,
        "browser B remote stroke preview before pointer release",
      );
    } finally {
      const last = points.at(-1) ?? firstPoint;
      await browserA.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: last.x,
        y: last.y,
        button: "left",
        clickCount: 1,
      });
    }
    await until(
      () =>
        [...sdk.elements.values()].filter((element) => element.type === "draw").length ===
        drawCountBefore + 1,
      5_000,
      "persisted draw element",
    );
    const draw = [...sdk.elements.values()].find((element) => element.type === "draw");
    const drawPoints = draw === undefined ? null : elementNumbers(draw, "points");
    if (drawPoints === null || drawPoints.length < 4) {
      throw new Error("persisted draw element has fewer than four point values");
    }
    const selectActive = await browserA.evaluate<boolean>(
      `document.querySelector('[data-testid="toolbar-select"]')?.getAttribute("aria-pressed") === "true"`,
    );
    if (!selectActive) throw new Error("draw completion did not restore the select tool");
  });

  const textCountBefore = [...sdk.elements.values()].filter(
    (element) => element.type === "text",
  ).length;
  await round(
    "F8a double-click creates exactly one collaborative text node",
    { adds: 1 },
    async () => {
      const point = await panePoint(browserA, 0.72, 0.24);
      await clickAt(browserA, point, 2);
      await until(
        () =>
          [...sdk.elements.values()].filter((element) => element.type === "text").length ===
          textCountBefore + 1,
        5_000,
        "one text element from a double-click",
      );
      // Canonical convergence lands before the canvas repaints; wait for the node,
      // then let the click settle so a second node from one double-click still fails.
      const renderedTextNodes = `document.querySelectorAll(".react-flow__node-text").length`;
      await until(
        async () => (await browserA.evaluate<number>(renderedTextNodes)) === textCountBefore + 1,
        5_000,
        "exactly one rendered text node",
      );
      await sleep(300);
      const renderedCount = await browserA.evaluate<number>(renderedTextNodes);
      if (renderedCount !== textCountBefore + 1) {
        throw new Error(
          `double-click rendered ${String(renderedCount - textCountBefore)} text nodes`,
        );
      }
      await until(
        () =>
          browserA.evaluate<boolean>(
            `document.querySelector(".canvas-text__editor") instanceof HTMLTextAreaElement`,
          ),
        5_000,
        "browser A text editor",
      );
    },
  );

  const textElement = [...sdk.elements.values()].find((element) => element.type === "text");
  if (textElement?.type !== "text") {
    failures.push("F8 collaborative text typing");
    console.log("FAIL  F8 collaborative text typing — text setup did not produce an element");
  } else {
    await round(
      "F8 collaborative Y.Text typing is live and convergent",
      { adds: 0, changes: [textElement.id] },
      async () => {
        const focusedA = await browserA.evaluate<boolean>(
          `(() => {
            const editor = document.querySelector(".canvas-text__editor");
            if (!(editor instanceof HTMLTextAreaElement)) return false;
            editor.focus();
            editor.setSelectionRange(editor.value.length, editor.value.length);
            return true;
          })()`,
        );
        if (!focusedA) throw new Error("browser A text editor lost focus");
        await browserA.typeText("hello");
        await until(
          () =>
            browserB.evaluate<boolean>(
              `(() => {
                const text = document.querySelector(".canvas-text");
                return text instanceof HTMLElement && (text.textContent ?? "").includes("hello");
              })()`,
            ),
          5_000,
          "browser B live hello text",
        );
        const textCenter = await browserB.evaluate<{ readonly x: number; readonly y: number }>(
          `(() => {
            const node = document.querySelector(${JSON.stringify(
              `.react-flow__node[data-id="${textElement.id}"]`,
            )});
            if (!(node instanceof HTMLElement)) throw new Error("text node missing in browser B");
            const rect = node.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          })()`,
        );
        await clickAt(browserB, textCenter, 2);
        await until(
          () =>
            browserB.evaluate<boolean>(
              `document.querySelector(".canvas-text__editor") instanceof HTMLTextAreaElement`,
            ),
          5_000,
          "browser B text editor",
        );
        await browserB.evaluate(
          `(() => {
            const editor = document.querySelector(".canvas-text__editor");
            if (!(editor instanceof HTMLTextAreaElement)) return;
            editor.focus();
            editor.setSelectionRange(editor.value.length, editor.value.length);
          })()`,
        );
        await browserB.typeText(" world");
        await until(
          () => {
            const current = sdk.elements.get(textElement.id);
            const text = current === undefined ? null : elementString(current, "text");
            return text !== null && text.includes("hello") && text.includes(" world");
          },
          5_000,
          "merged Y.Text content",
        );
        for (const browser of [browserA, browserB]) {
          await until(
            () =>
              browser.evaluate<boolean>(
                `(() => {
                  const node = document.querySelector(${JSON.stringify(
                    `.react-flow__node[data-id="${textElement.id}"]`,
                  )});
                  const value =
                    node?.querySelector("textarea") instanceof HTMLTextAreaElement
                      ? node.querySelector("textarea").value
                      : node?.textContent ?? "";
                  return value.includes("hello") && value.includes(" world");
                })()`,
              ),
            5_000,
            "live merged text in both browsers",
          );
        }
        await pressKey(browserA, "Escape", "Escape");
        await pressKey(browserB, "Escape", "Escape");
      },
    );

    try {
      const textCenter = await browserA.evaluate<{ readonly x: number; readonly y: number }>(
        `(() => {
          const node = document.querySelector(${JSON.stringify(
            `.react-flow__node[data-id="${textElement.id}"]`,
          )});
          if (!(node instanceof HTMLElement)) throw new Error("text node missing before delete");
          const rect = node.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()`,
      );
      await clickAt(browserA, textCenter, 1);
      await until(
        () =>
          browserA.evaluate<boolean>(
            `document.querySelector(${JSON.stringify(
              `.react-flow__node[data-id="${textElement.id}"]`,
            )})?.classList.contains("selected") === true`,
          ),
        5_000,
        "text selection before delete",
      );
      await browserA.evaluate(`document.querySelector(".canvas")?.focus()`);
      await pressKey(browserA, "Delete", "Delete");
      await until(
        async () =>
          !sdk.elements.has(textElement.id) &&
          !(await browserA.evaluate<readonly Snapshot[]>("window.__manifold.canvas()")).some(
            (element) => element.id === textElement.id,
          ) &&
          !(await browserB.evaluate<readonly Snapshot[]>("window.__manifold.canvas()")).some(
            (element) => element.id === textElement.id,
          ),
        5_000,
        "text deletion in both browsers",
      );
      await browserA.evaluate(`document.querySelector(".canvas")?.focus()`);
      await pressKey(browserA, "z", "KeyZ", 2);
      await until(
        async () =>
          sdk.elements.get(textElement.id)?.type === "text" &&
          (await browserA.evaluate<readonly Snapshot[]>("window.__manifold.canvas()")).some(
            (element) => element.id === textElement.id,
          ) &&
          (await browserB.evaluate<readonly Snapshot[]>("window.__manifold.canvas()")).some(
            (element) => element.id === textElement.id,
          ),
        8_000,
        "text restoration after undo",
      );
      console.log("PASS  F9 delete and undo restore the text on both browsers");
    } catch (error) {
      failures.push("F9 delete and undo");
      console.log(
        `FAIL  F9 delete and undo — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // A canvas terminal resizes from its border like a desktop window: hovering the frame
  // edge arms the OS resize cursor with no prior selection, and the drag has to reach both
  // the canonical scene and the other browser. The frame is the PORTAL's — resize is
  // canvas-item chrome, so it belongs to the node, not to the terminal painted inside it.
  const resizeTarget = sdk.elements.get(second.id);
  if (resizeTarget === undefined) {
    failures.push("F10 border resize");
    console.log("FAIL  F10 terminal resizes from its border — target terminal missing");
  } else {
    const edgeSelector = JSON.stringify(`.react-flow__node[data-id="${second.id}"]`);
    await round(
      "F10 terminal resizes from its border without selecting first",
      { adds: 0, changes: [second.id] },
      async () => {
        // Higher-band ink from F7 may cross this terminal's border and correctly own the
        // pointer there, so park the terminal in clear space before probing its frame.
        sdk.transact((tx) => {
          tx.patch(second.id, { x: 300, y: 360 });
        });
        await until(
          () =>
            browserA.evaluate<boolean>(
              `(() => {
                const node = document.querySelector(${edgeSelector});
                if (!(node instanceof HTMLElement)) return false;
                const transform = node.style.transform;
                return transform.includes("300px") && transform.includes("360px");
              })()`,
            ),
          5_000,
          "terminal rendered at its parked position",
        );
        // Clear any selection so the grab zone cannot be credited to selection handles.
        await clickAt(browserA, await panePoint(browserA, 0.5, 0.86), 1);
        await sleep(200);
        const borders = await browserA.evaluate<{
          readonly selected: boolean;
          readonly cursors: Readonly<Record<string, string>>;
          readonly hits: Readonly<Record<string, string>>;
        }>(
          `(() => {
            const node = document.querySelector(${edgeSelector});
            if (!(node instanceof HTMLElement)) throw new Error("terminal node missing");
            const rect = node.getBoundingClientRect();
            const midX = rect.left + rect.width / 2;
            const midY = rect.top + rect.height / 2;
            const points = {
              left: [rect.left + 1, midY],
              right: [rect.right - 1, midY],
              top: [midX, rect.top + 1],
              bottom: [midX, rect.bottom - 1],
              topLeft: [rect.left + 2, rect.top + 2],
              topRight: [rect.right - 2, rect.top + 2],
              bottomLeft: [rect.left + 2, rect.bottom - 2],
              bottomRight: [rect.right - 2, rect.bottom - 2],
            };
            const cursors = {};
            const hits = {};
            for (const [name, [x, y]] of Object.entries(points)) {
              const hit = document.elementFromPoint(x, y);
              cursors[name] = hit === null ? "none" : getComputedStyle(hit).cursor;
              hits[name] = hit === null ? "none" : hit.tagName + "." + String(hit.className).slice(0, 80);
            }
            return { selected: node.classList.contains("selected"), cursors, hits };
          })()`,
        );
        if (borders.selected) throw new Error("terminal was already selected before the hover");
        const wanted: Readonly<Record<string, string>> = {
          left: "ew-resize",
          right: "ew-resize",
          top: "ns-resize",
          bottom: "ns-resize",
          topLeft: "nwse-resize",
          bottomRight: "nwse-resize",
          topRight: "nesw-resize",
          bottomLeft: "nesw-resize",
        };
        for (const [name, expected] of Object.entries(wanted)) {
          if (borders.cursors[name] !== expected) {
            throw new Error(
              `border ${name} shows cursor ${String(borders.cursors[name])} on ${String(
                borders.hits[name],
              )}, expected ${expected}`,
            );
          }
        }
        // Deselection re-renders the node: wait for the grab zone, then drive the drag
        // from the control's own centre so the press cannot land a pixel off it.
        await until(
          () =>
            browserA.evaluate<boolean>(
              `document.querySelector(${edgeSelector})?.querySelector(".portal-resize-edge.right") !== null`,
            ),
          5_000,
          "right border grab zone",
        );
        const grab = await browserA.evaluate<{
          readonly x: number;
          readonly y: number;
          readonly width: number;
        }>(
          `(() => {
            const node = document.querySelector(${edgeSelector});
            const handle = node.querySelector(".portal-resize-edge.right");
            const rect = handle.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width };
          })()`,
        );
        if (grab.width < 4) {
          throw new Error(`border grab zone is only ${grab.width.toFixed(1)}px wide`);
        }
        // Hover first: the press has to land on an element the pointer already occupies.
        await browserA.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: grab.x,
          y: grab.y,
        });
        await sleep(120);
        await browserA.drag(
          [
            { x: grab.x, y: grab.y },
            { x: grab.x + 20, y: grab.y },
            { x: grab.x + 60, y: grab.y },
            { x: grab.x + 100, y: grab.y },
            { x: grab.x + 130, y: grab.y },
          ],
          30,
        );
        try {
          await until(
            () => (sdk.elements.get(second.id)?.width ?? 0) > resizeTarget.width + 60,
            5_000,
            "canonical width after the border drag",
          );
        } catch (error) {
          const rendered = await browserA.evaluate<number>(
            `(() => {
              const node = document.querySelector(${edgeSelector});
              return node instanceof HTMLElement ? node.getBoundingClientRect().width : -1;
            })()`,
          );
          throw new Error(
            `${error instanceof Error ? error.message : String(error)} (canonical=${String(
              sdk.elements.get(second.id)?.width,
            )} rendered=${rendered.toFixed(1)} started=${String(resizeTarget.width)})`,
          );
        }
      },
    );
  }

  // Text and ink keep the classic contract: no handles until the element is selected,
  // then the bounding box resizes it. Only terminals grab by their border.
  const textIdsBefore = new Set(
    [...sdk.elements.values()].filter((element) => element.type === "text").map((el) => el.id),
  );
  // Created through the canvas so the node is guaranteed inside the browser viewport:
  // an SDK-seeded element can land off-screen, where synthetic clicks hit nothing.
  await round("F11a double-click seeds a text node on screen", { adds: 1 }, async () => {
    await clickAt(browserA, await panePoint(browserA, 0.3, 0.62), 2);
    await until(
      () =>
        [...sdk.elements.values()].some(
          (element) => element.type === "text" && !textIdsBefore.has(element.id),
        ),
      5_000,
      "text element from the double-click",
    );
    // Empty text is deleted on blur, so the editor must actually receive the keystrokes.
    await until(
      () =>
        browserA.evaluate<boolean>(
          `(() => {
            const editor = document.querySelector(".canvas-text__editor");
            if (!(editor instanceof HTMLTextAreaElement)) return false;
            editor.focus();
            return document.activeElement === editor;
          })()`,
        ),
      5_000,
      "focused text editor",
    );
    await browserA.typeText("resize me");
    await until(
      () =>
        browserA.evaluate<boolean>(
          `document.querySelector(".canvas-text__editor")?.value === "resize me"`,
        ),
      5_000,
      "typed text in the editor",
    );
    await pressKey(browserA, "Escape", "Escape");
    await sleep(200);
  });

  const boxId =
    [...sdk.elements.values()].find(
      (element) => element.type === "text" && !textIdsBefore.has(element.id),
    )?.id ?? "";
  const boxSelector = JSON.stringify(`.react-flow__node[data-id="${boxId}"]`);
  const handleSelector = JSON.stringify(
    `.react-flow__node[data-id="${boxId}"] .react-flow__resize-control.handle.bottom.right`,
  );

  const textTarget = sdk.elements.get(boxId);
  if (textTarget === undefined) {
    failures.push("F11 text bounding-box resize");
    console.log("FAIL  F11 text resizes from its selection box — seeded element missing");
  } else {
    await round(
      "F11 text resizes from its selection box after selection",
      { adds: 0, changes: [boxId] },
      async () => {
        await until(
          () => browserA.evaluate<boolean>(`document.querySelector(${boxSelector}) !== null`),
          5_000,
          "text node rendered on A",
        );
        // Creation leaves the new node selected; the contract under test starts unselected.
        await clickAt(browserA, await panePoint(browserA, 0.5, 0.86), 1);
        await sleep(250);
        const unselectedHandles = await browserA.evaluate<number>(
          `document.querySelectorAll(${handleSelector}).length`,
        );
        if (unselectedHandles !== 0) {
          throw new Error(
            `unselected text node already shows ${String(unselectedHandles)} handles`,
          );
        }
        const center = await browserA.evaluate<{ readonly x: number; readonly y: number }>(
          `(() => {
            const node = document.querySelector(${boxSelector});
            const rect = node.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          })()`,
        );
        await clickAt(browserA, center, 1);
        try {
          await until(
            () => browserA.evaluate<boolean>(`document.querySelector(${handleSelector}) !== null`),
            5_000,
            "bounding-box handles after selection",
          );
        } catch (error) {
          const state = await browserA.evaluate<string>(
            `(() => {
              const node = document.querySelector(${boxSelector});
              const rect = node.getBoundingClientRect();
              return JSON.stringify({
                selected: node.className,
                rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
                clicked: [Math.round(${String(center.x)}), Math.round(${String(center.y)})],
                controls: node.querySelectorAll(".react-flow__resize-control").length,
                inner: node.innerHTML.slice(0, 120),
              });
            })()`,
          );
          throw new Error(`${error instanceof Error ? error.message : String(error)} ${state}`);
        }
        const handle = await browserA.evaluate<{ readonly x: number; readonly y: number }>(
          `(() => {
            const control = document.querySelector(${handleSelector});
            const rect = control.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          })()`,
        );
        await browserA.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: handle.x,
          y: handle.y,
        });
        await sleep(120);
        await browserA.drag(
          [
            { x: handle.x, y: handle.y },
            { x: handle.x + 30, y: handle.y + 20 },
            { x: handle.x + 70, y: handle.y + 45 },
            { x: handle.x + 110, y: handle.y + 70 },
          ],
          30,
        );
        await until(
          () => {
            const element = sdk.elements.get(boxId);
            return (
              element !== undefined &&
              element.width > textTarget.width + 50 &&
              element.height > textTarget.height + 30
            );
          },
          5_000,
          "canonical text geometry after the handle drag",
        );
      },
    );
  }

  // Freehand ink shares the text contract, and its box carries a viewBox so resizing
  // scales the stroke instead of growing an empty frame around it.
  const inkElement = [...sdk.elements.values()].find((element) => element.type === "draw");
  if (inkElement === undefined) {
    failures.push("F11b draw bounding-box resize");
    console.log("FAIL  F11b freehand resizes from its selection box — no stroke on the canvas");
  } else {
    const inkSelector = JSON.stringify(`.react-flow__node[data-id="${inkElement.id}"]`);
    const inkHandle = JSON.stringify(
      `.react-flow__node[data-id="${inkElement.id}"] .react-flow__resize-control.handle.bottom.right`,
    );
    await round(
      "F11b freehand resizes from its selection box and scales its ink",
      { adds: 0, changes: [inkElement.id] },
      async () => {
        await clickAt(browserA, await panePoint(browserA, 0.5, 0.86), 1);
        await sleep(250);
        if (
          (await browserA.evaluate<number>(`document.querySelectorAll(${inkHandle}).length`)) !== 0
        ) {
          throw new Error("unselected stroke already shows bounding-box handles");
        }
        // Click the ink itself: the stroke is the only hit target inside its box.
        const onStroke = await browserA.evaluate<{
          readonly x: number;
          readonly y: number;
          readonly inkWidth: number;
        }>(
          `(() => {
            const path = document.querySelector(${inkSelector}).querySelector("path");
            const point = path.getPointAtLength(path.getTotalLength() / 2);
            const ctm = path.getScreenCTM();
            return {
              x: ctm.a * point.x + ctm.c * point.y + ctm.e,
              y: ctm.b * point.x + ctm.d * point.y + ctm.f,
              inkWidth: path.getBoundingClientRect().width,
            };
          })()`,
        );
        await clickAt(browserA, { x: onStroke.x, y: onStroke.y }, 1);
        await until(
          () => browserA.evaluate<boolean>(`document.querySelector(${inkHandle}) !== null`),
          5_000,
          "bounding-box handles on the selected stroke",
        );
        const handle = await browserA.evaluate<{ readonly x: number; readonly y: number }>(
          `(() => {
            const control = document.querySelector(${inkHandle});
            const rect = control.getBoundingClientRect();
            const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            const hit = document.elementFromPoint(point.x, point.y);
            if (hit === null || !control.contains(hit)) {
              throw new Error("selected stroke resize handle is covered by " +
                (hit === null ? "no hit target" : hit.tagName + "." + hit.getAttribute("class")));
            }
            return point;
          })()`,
        );
        await browserA.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: handle.x,
          y: handle.y,
        });
        await sleep(120);
        await browserA.drag(
          [
            { x: handle.x, y: handle.y },
            { x: handle.x + 40, y: handle.y + 30 },
            { x: handle.x + 90, y: handle.y + 65 },
            { x: handle.x + 140, y: handle.y + 100 },
          ],
          30,
        );
        await until(
          () => {
            const element = sdk.elements.get(inkElement.id);
            return element !== undefined && element.width > inkElement.width + 60;
          },
          5_000,
          "canonical stroke geometry after the handle drag",
        );
        const inkAfter = await browserA.evaluate<number>(
          `document.querySelector(${inkSelector}).querySelector("path").getBoundingClientRect().width`,
        );
        if (inkAfter < onStroke.inkWidth + 40) {
          throw new Error(
            `stroke did not scale with its box: ink ${onStroke.inkWidth.toFixed(1)} -> ${inkAfter.toFixed(1)}`,
          );
        }
      },
    );
  }

  // Presence is a renderer-level contract, not a canvas feature. A composition has no
  // React Flow viewport to ride, so its cursors paint on an absolutely-positioned
  // `.composition-presence-layer` over the tile area and travel the wire as view-root
  // FRACTIONS: tile ratios are shared CRDT state, so a fraction resolves to the same
  // tile for every viewer. This round runs LAST — it navigates both browsers off the
  // canvas container, then kills browser B to prove a departed tab's cursor is pruned.
  //
  // convB sends and convA receives, not the other way round: F5 froze convB's tab, and
  // a page thawed out of `Page.setWebLifecycleState("frozen")` stays
  // `visibilityState: "hidden"` for the rest of the terminal, so its
  // requestAnimationFrame never fires again (measured; `Page.bringToFront` does not
  // revive it). Sending is event-driven and works in a hidden page, but a receiver
  // needs the animation frame to ease a cursor toward each new position, so the
  // live-motion assertions have to watch the browser that was never frozen.
  try {
    const viewResponse = await fetch(`${origin}/api/actions/core.index.createContainer`, {
      method: "POST",
      headers: httpHeaders,
      body: JSON.stringify({ name: "convergence-view", discipline: "composition" }),
    });
    if (!viewResponse.ok) {
      throw new Error(`composition creation failed with ${String(viewResponse.status)}`);
    }
    const viewOutcome = ActionOutcomeSchema.parse(await viewResponse.json());
    if (!viewOutcome.ok) throw new Error(`createContainer refused: ${viewOutcome.denial.message}`);
    const containerId = ContainerResponseSchema.parse(viewOutcome.result).container.id;

    // Parked on the sidebar, outside the tile area: the receiver must not emit cursors
    // of its own, or the sender's own overlay could no longer prove the absence of a
    // self-echo. Layout-driven synthetic pointer moves never reach `.composition-body`.
    await browserA.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 40, y: 420 });

    const openView = async (browser: Browser, label: string): Promise<void> => {
      await browser.goto(`${origin}/p/${containerId}`);
      // A composition route mounts no canvas, so neither the debug probe nor the sidebar
      // connection chip exists here: the rendered root leaf is the readiness signal.
      await until(
        () =>
          browser.evaluate<boolean>(
            "document.querySelector('.composition-view .composition-body .composition-leaf') !== null",
          ),
        20_000,
        `${label}: composition rendered`,
      );
    };
    await openView(browserA, "convA");
    await openView(browserB, "convB");

    // The paint resolves its color from the roster, so the round asserts the sender's
    // own stored identity color rather than a hard-coded one.
    const senderColor = await browserB.evaluate<string>(
      `(() => {
        const raw = localStorage.getItem("manifold.identity");
        if (raw === null) throw new Error("convB has no stored identity");
        const color = JSON.parse(raw).principal.color;
        if (typeof color !== "string" || color === "") {
          throw new Error("convB identity carries no color");
        }
        return color;
      })()`,
    );

    /** A pointer position at a fraction of the browser's own tile area. */
    const tileAreaPoint = async (
      browser: Browser,
      fx: number,
      fy: number,
    ): Promise<{ readonly x: number; readonly y: number }> =>
      await browser.evaluate(
        `(() => {
          const body = document.querySelector(".composition-body");
          if (!(body instanceof HTMLElement)) throw new Error("tile area missing");
          const box = body.getBoundingClientRect();
          return {
            x: box.left + box.width * ${String(fx)},
            y: box.top + box.height * ${String(fy)},
          };
        })()`,
      );

    /** Sweeps a real pointer across the tile area, ending on the target fraction. */
    const sweepTileArea = async (
      browser: Browser,
      from: readonly [number, number],
      to: readonly [number, number],
    ): Promise<void> => {
      const steps = 12;
      for (let index = 0; index <= steps; index += 1) {
        const point = await tileAreaPoint(
          browser,
          from[0] + ((to[0] - from[0]) * index) / steps,
          from[1] + ((to[1] - from[1]) * index) / steps,
        );
        await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
        await sleep(20);
      }
    };

    // One expression serves both browsers: on convA it proves the remote cursor arrived,
    // on convB that the sender never paints its own echo.
    const viewCursor = `(() => {
      const body = document.querySelector(".composition-body");
      if (!(body instanceof HTMLElement)) return { state: "no-body" };
      const box = body.getBoundingClientRect();
      const layer = document.querySelector(".composition-presence-layer");
      if (!(layer instanceof HTMLElement)) return { state: "no-layer" };
      const painted = [...layer.querySelectorAll(".remote-cursor")];
      const count = painted.length;
      const cursor = painted.find(
        (node) => node.getAttribute("data-cursor-color") === ${JSON.stringify(senderColor)},
      );
      if (!(cursor instanceof HTMLElement)) return { state: "no-cursor", count };
      const rect = cursor.getBoundingClientRect();
      const style = getComputedStyle(cursor);
      const layerBox = layer.getBoundingClientRect();
      return {
        state: "measured",
        count,
        // The label span trails the arrow, so only the tip locates the pointer.
        fx: (rect.left - box.left) / box.width,
        fy: (rect.top - box.top) / box.height,
        width: rect.width,
        height: rect.height,
        // Containment is asserted on the tip alone: the overlay is deliberately
        // unclipped, so a label near the right edge spills past the tile area.
        inside:
          rect.left >= box.left - 2 &&
          rect.left <= box.right + 2 &&
          rect.top >= box.top - 2 &&
          rect.top <= box.bottom + 2,
        visible: style.display !== "none" && style.visibility !== "hidden",
        layerFills:
          Math.abs(layerBox.left - box.left) <= 2 &&
          Math.abs(layerBox.top - box.top) <= 2 &&
          Math.abs(layerBox.width - box.width) <= 2 &&
          Math.abs(layerBox.height - box.height) <= 2,
      };
    })()`;

    const firstTarget: readonly [number, number] = [0.34, 0.4];
    const secondTarget: readonly [number, number] = [0.74, 0.72];
    // A wrong coordinate space is what this tolerance catches: raw client pixels clamp
    // to [0,1] and pin the arrow in a corner, flow coordinates land it out of bounds.
    const tolerance = 0.12;

    await sweepTileArea(browserB, [0.16, 0.24], firstTarget);
    await until(
      async () => {
        const probe = await browserA.evaluate<ViewCursorProbe>(viewCursor);
        return (
          probe.state === "measured" &&
          probe.inside === true &&
          probe.visible === true &&
          (probe.width ?? 0) > 0 &&
          (probe.height ?? 0) > 0 &&
          Math.abs((probe.fx ?? -1) - firstTarget[0]) <= tolerance &&
          Math.abs((probe.fy ?? -1) - firstTarget[1]) <= tolerance
        );
      },
      8_000,
      "convA: convB's cursor painted at its pointer fraction in the composition overlay",
    );
    const arrived = await browserA.evaluate<ViewCursorProbe>(viewCursor);
    if (arrived.layerFills !== true) {
      throw new Error("the composition presence overlay does not cover its view root");
    }

    await sweepTileArea(browserB, firstTarget, secondTarget);
    await until(
      async () => {
        const probe = await browserA.evaluate<ViewCursorProbe>(viewCursor);
        if (probe.state !== "measured" || probe.inside !== true) return false;
        return (
          Math.abs((probe.fx ?? -1) - secondTarget[0]) <= tolerance &&
          Math.abs((probe.fy ?? -1) - secondTarget[1]) <= tolerance
        );
      },
      8_000,
      "convA: composition cursor tracks convB's pointer across the tile area",
    );
    const tracked = await browserA.evaluate<ViewCursorProbe>(viewCursor);

    // convA's pointer never entered the tile area, so convB's overlay must be empty:
    // anything painted there is convB's own frame echoed back into its own paint.
    const selfEcho = await browserB.evaluate<ViewCursorProbe>(viewCursor);
    if (selfEcho.state === "measured") {
      throw new Error(
        `convB paints its own cursor back at fraction ${(selfEcho.fx ?? -1).toFixed(3)},${(selfEcho.fy ?? -1).toFixed(3)}`,
      );
    }
    if ((selfEcho.count ?? 0) !== 0) {
      throw new Error(
        `convB overlay shows ${String(selfEcho.count)} cursors though only convB moved its pointer`,
      );
    }

    // Killing the tab is the abrupt departure the roster prune has to survive; the
    // remaining viewer must retire the cursor instead of keeping a ghost arrow.
    await browserB.close();
    await until(
      async () => (await browserA.evaluate<ViewCursorProbe>(viewCursor)).state !== "measured",
      15_000,
      "convA: the departed tab's cursor retired from the overlay",
    );
    console.log(
      `PASS  F12 composition cursors converge on the presence overlay — tracked from ${(arrived.fx ?? -1).toFixed(3)},${(arrived.fy ?? -1).toFixed(3)} to ${(tracked.fx ?? -1).toFixed(3)},${(tracked.fy ?? -1).toFixed(3)}, no self-echo, pruned on tab close`,
    );
  } catch (error) {
    failures.push("F12 composition cursor convergence");
    console.log(
      `FAIL  F12 composition cursors converge on the presence overlay — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
} finally {
  // ---------------------------------------------------------------- teardown
  await browserA.close().catch(() => undefined);
  await browserB.close().catch(() => undefined);
  observer?.close();
  await teardownServer(server, dataDir);
  cleanupDist();
}

if (failures.length > 0) {
  console.log(`\nFAILED rounds: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nall convergence rounds passed");
