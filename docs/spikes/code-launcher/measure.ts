/*
  ┌──────────────────────────────────────────────────────────────────────────────────────┐
  │  DISPOSABLE SPIKE MEASUREMENT — evidence for issue #160. NOT A GATE SCRIPT.          │
  │  Not wired into package.json. See ../code-launcher.md for what the numbers mean.    │
  └──────────────────────────────────────────────────────────────────────────────────────┘

    MANIFOLD_DATA_DIR=/tmp/manifold-spike-data MANIFOLD_PORT=7799 bun docs/spikes/code-launcher/measure.ts

  Drives a LOCAL server (never a remote hub) through `@manifold/sdk` exactly the way a
  third-party launcher plugin would have to, and writes `measurements.json` beside this file.
  The owner key is read from `<data>/owner.key` and never printed. Every terminal opened here
  is killed on the way out.
*/

// Relative imports, as the s126 spike does: workspace packages are linked only into the
// packages that depend on them, and this directory is not one.
import { SessionClient } from "../../../packages/sdk/src/index.ts";
import { tileIdForRef } from "../../../packages/scene/src/index.ts";
import {
  ActionOutcomeSchema,
  ContainerResponseSchema,
  MachinesResponseSchema,
  TerminalsResponseSchema,
  type ActionOutcome,
  type TerminalInfo,
  type TileLayout,
} from "../../../packages/protocol/src/index.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const DATA_DIR = process.env["MANIFOLD_DATA_DIR"] ?? "/tmp/manifold-spike-data";
const PORT = process.env["MANIFOLD_PORT"] ?? "7799";
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws/session`;
const OWNER_KEY = readFileSync(resolve(DATA_DIR, "owner.key"), "utf8").trim();
const TRIALS = Number(process.env["SPIKE_TRIALS"] ?? "10");

const findings: Record<string, unknown> = {};
const opened: { client: SessionClient; terminalId: string }[] = [];

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve: done } = Promise.withResolvers<void>();
  setTimeout(done, ms);
  return promise;
};
const now = (): number => performance.now();

async function action(name: string, args: unknown): Promise<ActionOutcome> {
  const response = await fetch(`${HTTP}/api/actions/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${OWNER_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  return ActionOutcomeSchema.parse(await response.json());
}

async function createContainer(
  name: string,
  discipline: "canvas" | "composition",
): Promise<string> {
  const outcome = await action("core.index.createContainer", { name, discipline });
  if (!outcome.ok) throw new Error(`createContainer refused: ${JSON.stringify(outcome.denial)}`);
  return ContainerResponseSchema.parse(outcome.result).container.id;
}

async function connect(containerId: string): Promise<SessionClient> {
  const client = new SessionClient({ url: WS, containerId, token: OWNER_KEY, reconnect: false });
  await client.connect();
  return client;
}

/** One terminal's decoded byte stream, snapshot and outputs concatenated in arrival order. */
interface Capture {
  text: string;
  frames: number;
  firstFrameAt: number | null;
  lastFrameAt: number | null;
  stop(): void;
}

function capture(client: SessionClient, terminalId: string): Capture {
  const cap: Capture = {
    text: "",
    frames: 0,
    firstFrameAt: null,
    lastFrameAt: null,
    stop() {
      offSnap();
      offOut();
    },
  };
  const take = (data: string): void => {
    const bytes = Buffer.from(data, "base64");
    if (bytes.byteLength === 0) return;
    cap.frames += 1;
    if (cap.firstFrameAt === null) cap.firstFrameAt = now();
    cap.lastFrameAt = now();
    cap.text += bytes.toString("utf8");
  };
  const offSnap = client.on("terminal_snapshot", (m) => {
    if (m.terminalId === terminalId) take(m.data);
  });
  const offOut = client.on("terminal_output", (m) => {
    if (m.terminalId === terminalId) take(m.data);
  });
  return cap;
}

async function waitForText(cap: Capture, needle: string, timeoutMs: number): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (cap.text.includes(needle)) return true;
    await sleep(10);
  }
  return false;
}

async function killAll(): Promise<void> {
  // Through the DOOR, not the channel: a canvas-born terminal's channel is its home
  // composition, which this script never joined, so `client.killTerminal` would be refused.
  for (const { terminalId } of opened) await action("core.terminals.kill", { terminalId });
}

// ─── (a) the roster ───────────────────────────────────────────────────────────────────────────

const machinesOutcome = await action("core.machines.list", {});
if (!machinesOutcome.ok) throw new Error("core.machines.list refused");
const machines = MachinesResponseSchema.parse(machinesOutcome.result).machines;
const machine = ((): (typeof machines)[number] => {
  const online = machines.find((m) => m.online);
  if (online === undefined) throw new Error("no online machine — is the local agent up?");
  return online;
})();
findings["a_machines"] = {
  count: machines.length,
  rowKeys: Object.keys(machines[0] ?? {}).sort(),
  sample: { ...machines[0], id: "<uuid>" },
};

// ─── (b) env + cwd inside a tile-placed terminal ───────────────────────────────────────────────

{
  const containerId = await createContainer("spike-b", "composition");
  const client = await connect(containerId);
  const t0 = now();
  const terminal: TerminalInfo = await client.openTerminal({
    elementId: crypto.randomUUID(),
    placement: "tile",
    cwd: "/tmp",
    machineId: machine.id,
    cols: 100,
    rows: 30,
  });
  const openMs = now() - t0;
  opened.push({ client, terminalId: terminal.id });
  const tileId = tileIdForRef(client.layout(), { kind: "terminal", terminalId: terminal.id });
  const cap = capture(client, terminal.id);
  client.attachTerminal(terminal.id);
  const gotFirst = await waitForText(cap, "", 10_000);
  // Names only: MANIFOLD_TOKEN's VALUE is a grant and must not land in this file.
  await sleep(1500); // let the shell finish its rc files before typing (measured in (c))
  client.sendTerminalInput(
    terminal.id,
    "echo SPIKE_B_BEGIN; printf 'PWD=%s\\n' \"$PWD\"; env | sed -n 's/^\\(MANIFOLD_[A-Z_]*\\)=.*/\\1/p' | sort; printf 'SHELL=%s\\n' \"$SHELL\"; printf 'TERM=%s\\n' \"$TERM\"; echo SPIKE_B_END\n",
  );
  const done = await waitForText(cap, "SPIKE_B_END\r\n", 10_000);
  const block = cap.text.slice(
    cap.text.lastIndexOf("SPIKE_B_BEGIN\r\n") + "SPIKE_B_BEGIN\r\n".length,
    cap.text.lastIndexOf("SPIKE_B_END"),
  );
  const lines = block.split("\r\n").filter((l) => l.length > 0);
  findings["b_env_cwd"] = {
    openRoundTripMs: Math.round(openMs),
    terminalStatus: terminal.status,
    terminalHomeIsThisContainer: terminal.containerId === containerId,
    serverAuthoredTileId: tileId,
    attachedFirstFrame: gotFirst,
    commandCompleted: done,
    pwd: lines.find((l) => l.startsWith("PWD="))?.slice(4) ?? null,
    cwdHonoured: lines.includes("PWD=/tmp"),
    manifoldEnvKeys: lines.filter((l) => l.startsWith("MANIFOLD_")),
    shell: lines.find((l) => l.startsWith("SHELL="))?.slice(6) ?? null,
    term: lines.find((l) => l.startsWith("TERM="))?.slice(5) ?? null,
    terminalInfoKeys: Object.keys(terminal).sort(),
  };
  cap.stop();
  // Also: what does the HTTP action door `core.terminals.open` actually do?
  const before = await action("core.terminals.listAll", {});
  const authorize = await action("core.terminals.open", {
    containerId,
    elementId: crypto.randomUUID(),
    cols: 80,
    rows: 24,
    machineId: machine.id,
    placement: "tile",
  });
  await sleep(500);
  const after = await action("core.terminals.listAll", {});
  const count = (o: ActionOutcome): number =>
    o.ok ? TerminalsResponseSchema.parse(o.result).terminals.length : -1;
  findings["b_http_open_action"] = {
    outcome: authorize,
    terminalsBefore: count(before),
    terminalsAfter: count(after),
    createdATerminal: count(after) > count(before),
  };
}

// ─── (c) the keystroke race ────────────────────────────────────────────────────────────────────
//
// Three moments to type at: right after `terminal_opened` resolves; after the first non-empty
// snapshot/output frame; after the LINE EDITOR says it is reading (`ESC[?2004h`, bracketed
// paste on — emitted by zsh's ZLE and bash's readline when the prompt is live — or, failing
// that, a trailing prompt glyph). The typed line is `echo <marker>_"OK"` so the RESULT
// (`<marker>_OK`) can never be mistaken for the kernel's echo of the keystrokes.

type RaceMode = "immediate" | "after_first_frame" | "after_line_editor";

interface RaceTrial {
  mode: RaceMode;
  msToFirstFrame: number | null;
  msToLineEditor: number | null;
  msInputSent: number;
  resultSeen: boolean;
  msToResult: number | null;
  /** The kernel echoed the keystrokes before the shell had drawn any prompt (cooked-mode echo). */
  echoBeforePrompt: boolean;
  /** The typed line is painted twice: once by the tty, once by the line editor's redraw. */
  doubleEcho: boolean;
}

/**
 * The one shell-independent "you may type now" signal the bytes carry: bracketed-paste ON,
 * which zsh's ZLE and bash's readline emit as they start reading a line. Without it (plain
 * `sh`), fall back to a prompt glyph at the tail after 400 ms of silence — silence matters,
 * because zsh prints an inverse `%` end-of-line marker BEFORE its rc files run, and a glyph
 * test alone fires on that.
 */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const LINE_EDITOR_READY = `${ESC}[?2004h`;
const READY_SENTINEL = "\uE000";
const PROMPT_TAIL = /(?:[$%#>➜]\s*)$/;
const QUIET_MS = 400;
const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const stripAnsi = (s: string): string =>
  s.replaceAll(LINE_EDITOR_READY, READY_SENTINEL).replace(OSC, "").replace(CSI, "");
const lineEditorReady = (cap: Capture): boolean =>
  cap.text.includes(LINE_EDITOR_READY) ||
  (cap.lastFrameAt !== null &&
    now() - cap.lastFrameAt > QUIET_MS &&
    PROMPT_TAIL.test(stripAnsi(cap.text).trimEnd()));

async function waitUntil(fn: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (fn()) return true;
    await sleep(5);
  }
  return false;
}

async function raceTrial(client: SessionClient, mode: RaceMode, n: number): Promise<RaceTrial> {
  const marker = `RACE_${n}_${mode}`;
  const typed = `echo ${marker}_"OK"`;
  const result = `${marker}_OK`;
  const t0 = now();
  // The capture cannot attach before the id exists; the attach's snapshot carries every byte
  // the PTY emitted before it (the no-gap invariant), so nothing is missed.
  const terminal = await client.openTerminal({
    elementId: crypto.randomUUID(),
    placement: "tile",
    machineId: machine.id,
    cols: 100,
    rows: 30,
  });
  opened.push({ client, terminalId: terminal.id });
  const cap = capture(client, terminal.id);
  client.attachTerminal(terminal.id);
  let msToLineEditor: number | null = null;
  if (mode === "after_first_frame") {
    await waitUntil(() => cap.frames > 0, 10_000);
  } else if (mode === "after_line_editor") {
    if (await waitUntil(() => lineEditorReady(cap), 10_000)) msToLineEditor = now() - t0;
  }
  client.sendTerminalInput(terminal.id, `${typed}\n`);
  const msInputSent = now() - t0;
  const seen = await waitForText(cap, result, 8_000);
  const msToResult = seen ? now() - t0 : null;
  if (msToLineEditor === null) {
    // Measured after the fact for the two eager modes: when did the editor come up anyway?
    await waitUntil(() => lineEditorReady(cap), 8_000);
  }
  // OSC title sequences (oh-my-zsh puts the command line in the window title) and colour
  // redraws are stripped first, so "the typed line appears" means it was PAINTED as text.
  const plain = stripAnsi(cap.text);
  const firstEcho = plain.indexOf(typed);
  const firstEditor = plain.indexOf(READY_SENTINEL);
  const echoBeforePrompt = firstEcho !== -1 && (firstEditor === -1 || firstEcho < firstEditor);
  const doubleEcho = firstEcho !== -1 && plain.indexOf(typed, firstEcho + 1) !== -1;
  cap.stop();
  return {
    mode,
    msToFirstFrame: cap.firstFrameAt === null ? null : Math.round(cap.firstFrameAt - t0),
    msToLineEditor: msToLineEditor === null ? null : Math.round(msToLineEditor),
    msInputSent: Math.round(msInputSent),
    resultSeen: seen,
    msToResult: msToResult === null ? null : Math.round(msToResult),
    echoBeforePrompt,
    doubleEcho,
  };
}

{
  const containerId = await createContainer("spike-c", "composition");
  const client = await connect(containerId);
  const trials: RaceTrial[] = [];
  const modes: RaceMode[] = ["immediate", "after_first_frame", "after_line_editor"];
  for (const mode of modes) {
    for (let i = 1; i <= TRIALS; i++) trials.push(await raceTrial(client, mode, i));
  }
  const ms = (xs: (number | null)[]): number[] => xs.filter((x): x is number => x !== null);
  const stats = (xs: number[]): Record<string, number> | null =>
    xs.length === 0
      ? null
      : {
          min: Math.min(...xs),
          max: Math.max(...xs),
          median: [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0,
        };
  const summarize = (mode: RaceMode): Record<string, unknown> => {
    const rows = trials.filter((t) => t.mode === mode);
    return {
      trials: rows.length,
      resultSeen: rows.filter((t) => t.resultSeen).length,
      lost: rows.filter((t) => !t.resultSeen).length,
      echoBeforePrompt: rows.filter((t) => t.echoBeforePrompt).length,
      doubleEcho: rows.filter((t) => t.doubleEcho).length,
      firstFrameMs: stats(ms(rows.map((t) => t.msToFirstFrame))),
      lineEditorReadyMs: stats(ms(rows.map((t) => t.msToLineEditor))),
      inputSentMs: stats(rows.map((t) => t.msInputSent)),
      resultMs: stats(ms(rows.map((t) => t.msToResult))),
    };
  };
  findings["c_keystroke_race"] = {
    immediate: summarize("immediate"),
    afterFirstFrame: summarize("after_first_frame"),
    afterLineEditor: summarize("after_line_editor"),
    trials,
  };
}

// ─── (d) canvas-born terminal, then core.space.place into a composition ────────────────────────

{
  const canvasId = await createContainer("spike-d-canvas", "canvas");
  const compositionId = await createContainer("spike-d-composition", "composition");
  const canvas = await connect(canvasId);
  const composition = await connect(compositionId);
  const rt: Record<string, unknown>[] = [];
  const t0 = now();
  const terminal = await canvas.openTerminal({
    elementId: crypto.randomUUID(),
    machineId: machine.id,
    cols: 80,
    rows: 24,
  });
  rt.push({ step: "terminal_open (no placement, canvas channel)", ms: Math.round(now() - t0) });
  opened.push({ client: canvas, terminalId: terminal.id });
  const bornInto = terminal.containerId;
  /** Where the terminal's HOME is and how many composition leaves reference it, after a step. */
  const observe = async (): Promise<Record<string, unknown>> => {
    await sleep(150);
    const all = await action("core.terminals.listAll", {});
    const row = all.ok
      ? TerminalsResponseSchema.parse(all.result).terminals.find((t) => t.id === terminal.id)
      : undefined;
    const leaves = Object.values(composition.layout() ?? {}).filter(
      (tile) => tile.ref?.kind === "terminal" && tile.ref.terminalId === terminal.id,
    ).length;
    const home =
      row === undefined
        ? "gone"
        : row.homeId === compositionId
          ? "spike-d-composition"
          : row.homeId === bornInto
            ? "its solo composition"
            : "elsewhere";
    return {
      home,
      unplaced: row?.unplaced ?? null,
      leavesInComposition: leaves,
      canvasElements: canvas.elements.size,
    };
  };
  const step = async (
    label: string,
    args: unknown,
  ): Promise<{
    step: string;
    ms: number;
    outcome: ActionOutcome;
    after: Record<string, unknown>;
  }> => {
    const t = now();
    const outcome = await action("core.space.place", args);
    const ms = Math.round(now() - t);
    return { step: label, ms, outcome, after: await observe() };
  };
  const ref = { kind: "terminal", terminalId: terminal.id };
  const tileDest = { kind: "tile", containerId: compositionId, targetTileId: null, edge: null };
  const afterOpen = await observe();
  const steps = [
    await step("place → tile in composition", { ref, destination: tileDest }),
    await step("place again, same destination", { ref, destination: tileDest }),
    await step("place → canvas portal", {
      ref,
      destination: { kind: "canvas", containerId: canvasId, x: 100, y: 100 },
    }),
    await step("place → unknown container", {
      ref,
      destination: { ...tileDest, containerId: "does-not-exist" },
    }),
    await step("place unknown terminal", {
      ref: { kind: "terminal", terminalId: "ts_ghost" },
      destination: tileDest,
    }),
    await step("place → unplaced", { ref, destination: { kind: "unplaced" } }),
  ];
  findings["d_canvas_open_then_place"] = {
    openMs: rt[0]?.["ms"],
    bornInto: bornInto === canvasId ? "the canvas itself" : "a fresh solo composition",
    afterOpen,
    steps,
  };
  composition.close();
}

// ─── (e) a terminal leaf in the WORKSPACE tile tree ────────────────────────────────────────────

{
  const anyTerminal = opened[0]?.terminalId ?? "ts_x";
  const compositionId = await createContainer("spike-e-target", "composition");
  const layoutWith = (leaf: TileLayout[string]["ref"]): TileLayout => ({
    root: { id: "root", dir: "row", ratios: [0.22, 0.78], children: ["a", "b"], ref: null },
    a: {
      id: "a",
      dir: null,
      ratios: [],
      children: [],
      ref: { kind: "panel", panelId: "core.shell.sidebar" },
    },
    b: { id: "b", dir: null, ratios: [], children: [], ref: leaf },
  });
  const terminalLeaf = await action("core.space.setLayout", {
    layout: layoutWith({ kind: "terminal", terminalId: anyTerminal }),
  });
  const containerLeaf = await action("core.space.setLayout", {
    layout: layoutWith({ kind: "container", containerId: compositionId }),
  });
  const textLeaf = await action("core.space.setLayout", {
    layout: layoutWith({ kind: "text", elementId: "el_x" }),
  });
  const unknownPanel = await action("core.space.setLayout", {
    layout: layoutWith({ kind: "panel", panelId: "code.launcher-spike.launcher" }),
  });
  // Restore: the shell's own default (sidebar | container-view) so the browser run is clean.
  const restore = await action("core.space.setLayout", {
    layout: layoutWith({ kind: "panel", panelId: "core.shell.container-view" }),
  });
  findings["e_workspace_tree"] = {
    terminalLeaf,
    containerLeaf,
    textLeaf,
    unknownPanelLeafAccepted: unknownPanel,
    restored: restore.ok,
  };
}

await killAll();
await sleep(300);
for (const { client } of opened) client.close();
findings["meta"] = {
  measuredAt: new Date().toISOString(),
  bun: Bun.version,
  server: HTTP,
  trials: TRIALS,
};
await Bun.write(resolve(HERE, "measurements.json"), `${JSON.stringify(findings, null, 2)}\n`);
console.log(JSON.stringify(findings, null, 2));
process.exit(0);
