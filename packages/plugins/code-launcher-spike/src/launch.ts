import { tileIdForRef } from "@manifold/scene";
import type { SessionClient } from "@manifold/sdk";

/*
  THROWAWAY SPIKE — see ./index.ts. The launch gesture, as the wire lets a third party spell
  it at v0.6.2: open a PTY on the session channel, wait for the SHELL to say it is reading a
  line, type the command. There is no command field on `terminal_open` (protocol/machine.ts
  `create` carries cwd+env only), so keystrokes are the only mechanism, and the readiness
  signal has to be inferred from the byte stream.
*/

/** Five rows of atyrode/code's catalog, hard-coded: enough to drive three dependent dials. */
export interface CatalogRow {
  readonly lane: string;
  readonly model: string;
  readonly thinking: readonly string[];
}

export const CATALOG: readonly CatalogRow[] = [
  { lane: "fast", model: "anthropic/claude-haiku-4.5", thinking: ["minimal", "low"] },
  { lane: "fast", model: "openai/gpt-5-mini", thinking: ["minimal", "low", "medium"] },
  { lane: "balanced", model: "anthropic/claude-sonnet-4.5", thinking: ["low", "medium", "high"] },
  { lane: "balanced", model: "deepseek/deepseek-v3.2", thinking: ["low", "medium"] },
  { lane: "deep", model: "anthropic/claude-opus-4.1", thinking: ["medium", "high", "max"] },
];

export const lanes = (rows: readonly CatalogRow[]): readonly string[] => [
  ...new Set(rows.map((row) => row.lane)),
];
export const modelsFor = (rows: readonly CatalogRow[], lane: string): readonly string[] =>
  rows.filter((row) => row.lane === lane).map((row) => row.model);
export const thinkingFor = (
  rows: readonly CatalogRow[],
  lane: string,
  model: string,
): readonly string[] =>
  rows.find((row) => row.lane === lane && row.model === model)?.thinking ?? [];

/**
 * Bracketed-paste ON is emitted by zsh's ZLE and bash's readline the moment the prompt is live
 * and the editor is reading — the one shell-independent "you may type now" the bytes carry.
 * Absent that (plain `sh`), a prompt glyph at the tail after a quiet interval has to do.
 * Measured in docs/spikes/code-launcher.md §2(c): typing at the FIRST FRAME instead is
 * 30-40 ms too early on this machine and paints the command twice.
 */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
export const LINE_EDITOR_READY = `${ESC}[?2004h`;
const PROMPT_TAIL = /(?:[$%#>➜]\s*)$/;
const QUIET_MS = 400;
const RESIZE_WAIT_MS = 800;
const READY_TIMEOUT_MS = 5_000;
/** OSC (title) sequences, then CSI (colour, cursor, mode) sequences; built from code points, not literals. */
const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");

export const stripAnsi = (s: string): string => s.replace(OSC, "").replace(CSI, "");

export type ReadySignal = "bracketed_paste" | "quiet_prompt" | "timeout";

export interface LaunchPhases {
  readonly openMs: number;
  readonly readyMs: number;
  readonly signal: ReadySignal;
  /** When the composition's viewer refitted the PTY to its tile, or null if it never did. */
  readonly resizedMs: number | null;
  readonly terminalId: string;
  readonly tileId: string | null;
}

export interface LaunchRequest {
  readonly machineId: string;
  readonly cwd: string;
  readonly command: string;
}

const decode = (b64: string): string => {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

/**
 * The gesture, against a client already joined to the TARGET composition. Placement is the
 * server's (`placement: "tile"`), so the leaf the terminal lands in is read back off the
 * layout rather than chosen here.
 */
export async function launchInto(
  client: SessionClient,
  request: LaunchRequest,
  report: (line: string) => void,
): Promise<LaunchPhases> {
  const t0 = performance.now();
  const terminal = await client.openTerminal({
    elementId: crypto.randomUUID(),
    placement: "tile",
    cwd: request.cwd,
    machineId: request.machineId,
    cols: 100,
    rows: 30,
  });
  const openMs = Math.round(performance.now() - t0);
  report(`terminal_opened ${terminal.id.slice(0, 8)}… in ${String(openMs)} ms`);
  const tileId = tileIdForRef(client.layout(), { kind: "terminal", terminalId: terminal.id });

  let text = "";
  let lastFrameAt: number | null = null;
  let resizedAt: number | null = null;
  const off = [
    client.on("terminal_snapshot", (m) => {
      if (m.terminalId !== terminal.id) return;
      text += decode(m.data);
      lastFrameAt = performance.now();
    }),
    client.on("terminal_output", (m) => {
      if (m.terminalId !== terminal.id) return;
      text += decode(m.data);
      lastFrameAt = performance.now();
    }),
    /*
      The opener has to SEND a geometry (`terminal_open` requires cols/rows) but cannot know
      the tile the composition will hand the terminal; the viewer that mounts the tile refits
      it and the shell redraws. A line typed before that refit is repainted at the new width —
      measured as garbled wraps in docs/spikes/code-launcher.md §3 — so typing waits for it
      (bounded), and the wait is reported.
    */
    client.on("terminal_event", (m) => {
      if (m.terminalId === terminal.id && m.kind === "resized") resizedAt ??= performance.now();
    }),
  ];
  client.attachTerminal(terminal.id);

  const { promise, resolve } = Promise.withResolvers<ReadySignal>();
  const started = performance.now();
  const tick = setInterval(() => {
    if (text.includes(LINE_EDITOR_READY)) return resolve("bracketed_paste");
    const quiet = lastFrameAt !== null && performance.now() - lastFrameAt > QUIET_MS;
    if (quiet && PROMPT_TAIL.test(stripAnsi(text).trimEnd())) return resolve("quiet_prompt");
    if (performance.now() - started > READY_TIMEOUT_MS) return resolve("timeout");
  }, 10);
  const signal = await promise;
  clearInterval(tick);
  const readyMs = Math.round(performance.now() - t0);
  report(`shell ready (${signal}) at ${String(readyMs)} ms`);

  const refit = Promise.withResolvers<void>();
  const refitStarted = performance.now();
  const refitTick = setInterval(() => {
    if (resizedAt !== null || performance.now() - refitStarted > RESIZE_WAIT_MS) refit.resolve();
  }, 10);
  await refit.promise;
  clearInterval(refitTick);
  const resizedMs = resizedAt === null ? null : Math.round(resizedAt - t0);
  report(
    resizedMs === null
      ? `no viewer refit within ${String(RESIZE_WAIT_MS)} ms — typing at the opener's geometry`
      : `viewer refitted the tile at ${String(resizedMs)} ms — typing`,
  );

  client.sendTerminalInput(terminal.id, `${request.command}\n`);
  for (const release of off) release();
  client.detachTerminal(terminal.id);
  return { openMs, readyMs, signal, resizedMs, terminalId: terminal.id, tileId };
}
