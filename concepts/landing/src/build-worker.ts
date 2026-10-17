// Worker entry: runs the page's pure CPU builds off its thread (sims/build.ts). One job per slot,
// the newest: a build for a slot drops the one before it. The slots' jobs take turns a slice at a
// time, and the worker turns to its messages every SLICE_MS, so a superseded build stops at its next
// slice. Each result goes back with its typed arrays transferred.

import { countryBuild } from "./scenes/country/build.ts";
import { dewSpin } from "./scenes/dew/sim.ts";
import { frostGrowth } from "./scenes/frost/sim.ts";
import { physarumDish } from "./scenes/physarum/sim.ts";
import { sheetPaint } from "./sheet.ts";
import {
  type Build,
  type Builder,
  type BuildKind,
  type BuildMessage,
  type BuildReply,
  transferables,
} from "./sims/build.ts";

/**
 * Every kind of build, by name. The page sends each kind only its own requests (BuildSlot), so
 * here, at the boundary, requests and results are unknown.
 */
const KINDS: Readonly<Record<string, BuildKind<unknown, unknown>>> = Object.fromEntries(
  [sheetPaint, countryBuild, frostGrowth, dewSpin, physarumDish].map((kind) => [kind.name, kind]),
);

/** Milliseconds of building between looks at the messages. */
const SLICE_MS = 8;

/** The parts of the worker scope this entry uses (the page's DOM lib has no worker types). */
interface Scope {
  onmessage: ((event: MessageEvent<BuildMessage>) => void) | null;
  postMessage(message: BuildReply, transfer: Transferable[]): void;
}

const scope = globalThis as unknown as Scope;

/** Per slot: its builder (what it keeps between builds), and its build in progress. */
const builders = new Map<number, { kind: string; builder: Builder<unknown, unknown> }>();
const jobs = new Map<number, { id: number; steps: Build<unknown> }>();

/** A task of its own to come back to the jobs after the messages (no timer clamping). */
const tick = new MessageChannel();
let scheduled = false;

function schedule(): void {
  if (scheduled || jobs.size === 0) return;
  scheduled = true;
  tick.port2.postMessage(0);
}

tick.port1.onmessage = () => {
  scheduled = false;
  const until = performance.now() + SLICE_MS;
  while (jobs.size > 0 && performance.now() < until) {
    for (const [slot, job] of jobs) {
      let step: IteratorResult<unknown, unknown>;
      try {
        step = job.steps.next();
      } catch (error: unknown) {
        jobs.delete(slot);
        const reason = error instanceof Error ? (error.stack ?? error.message) : String(error);
        scope.postMessage({ slot, id: job.id, error: reason }, []);
        continue;
      }
      if (step.done) jobs.delete(slot);
      if (step.done || step.value !== undefined)
        scope.postMessage(
          { slot, id: job.id, result: step.value, done: step.done === true },
          transferables(step.value),
        );
    }
  }
  schedule();
};

scope.onmessage = (event) => {
  const message = event.data;
  switch (message.type) {
    case "build": {
      let held = builders.get(message.slot);
      if (held?.kind !== message.kind) {
        const kind = KINDS[message.kind];
        if (!kind) throw new Error(`landing: no build kind ${message.kind}`);
        held = { kind: message.kind, builder: kind.builder() };
        builders.set(message.slot, held);
      }
      jobs.set(message.slot, { id: message.id, steps: held.builder.build(message.request) });
      schedule();
      return;
    }
    case "cancel":
      jobs.delete(message.slot);
      return;
    case "release":
      jobs.delete(message.slot);
      builders.delete(message.slot);
      return;
    default: {
      const unreachable: never = message;
      throw new Error(`landing: unknown build message ${String(unreachable)}`);
    }
  }
};
