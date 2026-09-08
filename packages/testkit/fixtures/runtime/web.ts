import { ui } from "@manifold/plugin-kit";
import {
  definePanel,
  defineWebPlugin,
  type GuestHost,
  type GuestStreamHandle,
  type PanelEvent,
} from "@manifold/plugin-kit/web";
import { z } from "zod";
import { PLUGIN, OPERATION, limits } from "./shared.ts";

const Progress = z.object({
  epoch: z.string(),
  seq: z.number(),
  status: z.string(),
  snapshots: z.number(),
  gaps: z.number(),
  resets: z.number(),
  errors: z.number(),
  maxSnapshot: z.number(),
  frames: z.number(),
  firstAt: z.number(),
  lastAt: z.number(),
});
type Progress = z.infer<typeof Progress>;
const initial = (): Progress => ({
  epoch: "",
  seq: 0,
  status: "idle",
  snapshots: 0,
  gaps: 0,
  resets: 0,
  errors: 0,
  maxSnapshot: 0,
  frames: 0,
  firstAt: 0,
  lastAt: 0,
});
interface State {
  machine: string;
  job: string;
  outcome: unknown;
  actions: number;
  progress: Progress;
}
let handle: GuestStreamHandle | undefined;
let off: (() => void) | undefined;
let emit: ((event: PanelEvent) => void) | undefined;
let progress = initial();
function open(host: GuestHost, mode: "fresh" | "resume" | "stale"): void {
  const cursor = progress.epoch
    ? { epoch: progress.epoch, seq: mode === "stale" ? 0 : progress.seq }
    : undefined;
  off?.();
  handle?.close();
  if (mode === "fresh") progress = initial();
  handle = host.openStream({
    kind: `${PLUGIN}.frames`,
    node: { kind: "plugin", pluginId: PLUGIN },
    ...(mode !== "fresh" && cursor ? { cursor } : {}),
  });
  const mine = handle;
  off = mine.on((message) => {
    if (message.type === "stream_snapshot") {
      for (let i = 1; i < message.frames.length; i++) {
        if (message.frames[i]!.seq !== message.frames[i - 1]!.seq + 1) progress.errors++;
      }
      if (progress.epoch === message.epoch && message.lastSeq < progress.seq && mode !== "stale")
        progress.errors++;
      progress.epoch = message.epoch;
      progress.seq = message.lastSeq;
      progress.snapshots++;
      progress.maxSnapshot = Math.max(progress.maxSnapshot, message.frames.length);
    } else if (message.type === "stream_frame") {
      if (message.epoch !== progress.epoch || message.seq !== progress.seq + 1) progress.errors++;
      progress.seq = message.seq;
      progress.frames++;
      progress.firstAt ||= Date.now();
      progress.lastAt = Date.now();
    } else if (message.type === "stream_gap") {
      progress.gaps++;
      progress.seq = message.toSeq;
    } else if (message.type === "stream_reset") {
      progress.resets++;
      progress.epoch = message.epoch;
      progress.seq = 0;
    }
    progress.status = mine.status;
    emit?.({ event: "progress", payload: { ...progress } });
  });
}
const proof = definePanel<State>({
  init: () => ({ machine: "", job: "once", outcome: null, actions: 0, progress: initial() }),
  view: (state) =>
    ui.box({ direction: "column", gap: 2 }, [
      ui.heading("Governed runtime acceptance", 2),
      ui.input("machine", state.machine, { label: "Target machine" }),
      ui.input("job", state.job, { label: "Job identity" }),
      ui.button("Run bounded job", "run", { action: "engine.jobs.execute" }),
      ui.button("Refresh job", "status", { action: "engine.jobs.status" }),
      ui.button("Cancel job", "cancel", { action: "engine.jobs.cancel" }),
      ui.button("Start sixty seconds", "start", { action: `${PLUGIN}.start` }),
      ui.button("Open stream", "open"),
      ui.button("Reconnect stream", "resume"),
      ui.button("Retained window", "stale"),
      ui.button("Pause consumer", "pause"),
      ui.text(
        `Runtime proof ${JSON.stringify({ target: state.machine, job: state.job, outcome: state.outcome, actions: state.actions, ...state.progress })}`,
        { wrap: true, mono: true },
      ),
    ]),
  async update(state, event, host) {
    if (event.event === "machine" || event.event === "job")
      return { ...state, [event.event]: String(event.payload) };
    if (event.event === "progress") return { ...state, progress: Progress.parse(event.payload) };
    if (event.event === "open" || event.event === "resume" || event.event === "stale") {
      open(host, event.event === "open" ? "fresh" : event.event);
      return state;
    }
    if (event.event === "pause") {
      off?.();
      handle?.close();
      return state;
    }
    if (event.event === "start")
      return {
        ...state,
        actions: state.actions + 1,
        outcome: await host.action(`${PLUGIN}.start`, {}),
      };
    const node = {
      kind: "job",
      machineId: state.machine,
      operationId: OPERATION,
      jobId: state.job,
    };
    if (event.event === "run")
      return {
        ...state,
        actions: state.actions + 1,
        outcome: await host.action("engine.jobs.execute", {
          machineId: state.machine,
          pluginId: PLUGIN,
          operationId: OPERATION,
          jobId: state.job,
          input: { label: state.job },
          outputs: [],
          limits,
        }),
      };
    if (event.event === "status" || event.event === "cancel")
      return {
        ...state,
        actions: state.actions + 1,
        outcome: await host.action(`engine.jobs.${event.event}`, { node }),
      };
    return state;
  },
  subscribe(_host, callback) {
    emit = callback;
    return () => {
      off?.();
      handle?.close();
      emit = undefined;
    };
  },
});
defineWebPlugin({ id: PLUGIN, panels: { proof } });
