import { expect, test } from "bun:test";
import { ActionOutcomeSchema, HealthResponseSchema } from "@manifold/protocol";
import type { ConnectionStatus, SessionClient } from "@manifold/sdk";
import {
  connect,
  createContainer,
  enrollMachine,
  isMachineOnline,
  listContainers,
  mintToken,
  startAgent,
  startServer,
  waitFor,
  type TestAgent,
  type TestServer,
} from "../src/index.ts";
import {
  attachedCapture,
  closeClients,
  e2eFailure,
  nextMessage,
  openTerminalAt,
  stopProcesses,
  textElement,
  waitForTerminalText,
  type TerminalCapture,
} from "./helpers.ts";

/*
  THE SINGLE-WRITER HANDOFF (#318), end to end on one disposable data directory and one port:
  a successor is started beside the serving hub, waits on the writer lock without opening the
  database, and becomes the writer only once the predecessor has quiesced and sealed. It runs
  forward (old build -> new build) and back (rollback to the old build), while probes keep
  hitting `/healthz`, a durable action and a browser session, and a real machine keeps a PTY
  producing output. The invariants are asserted; the windows are measured and printed.
*/

const origin = performance.now();
const now = (): number => Math.round(performance.now() - origin);

interface WriterEvent {
  readonly hub: string;
  readonly at: number;
  readonly evt: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

interface HealthSample {
  readonly at: number;
  readonly build: string | null;
}

interface WriteSample {
  readonly at: number;
  readonly name: string;
  readonly outcome: "acknowledged" | "handover" | "unreachable" | "failed";
}

function identity(build: string): Record<string, string> {
  return {
    MANIFOLD_VERSION: "0.0.0",
    MANIFOLD_BUILD: `0.0.0+handoff.${build}`,
    MANIFOLD_CHANNEL: "development",
  };
}

function ticks(text: string): number[] {
  return [...text.matchAll(/TICK_(\d+)\b/g)].map((match) => Number(match[1]));
}

test("a fenced handoff keeps one writer, acknowledged writes, sessions and the PTY across a switch and a rollback", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  const captures: TerminalCapture[] = [];
  const writerEvents: WriterEvent[] = [];
  const health: HealthSample[] = [];
  const writes: WriteSample[] = [];
  const statuses: { at: number; status: ConnectionStatus }[] = [];
  let probing = true;
  const probes: Promise<void>[] = [];

  const observe =
    (hub: string, onEvent?: (event: WriterEvent) => void) =>
    (line: string): void => {
      if (!line.startsWith("{") || !line.includes('"evt":"writer_')) return;
      const record = JSON.parse(line) as Record<string, unknown>;
      const event = { hub, at: now(), evt: String(record["evt"]), fields: record };
      writerEvents.push(event);
      onEvent?.(event);
    };
  const find = (hub: string, evt: string): WriterEvent => {
    const event = writerEvents.find((candidate) => candidate.hub === hub && candidate.evt === evt);
    if (event === undefined) throw new Error(`${hub} never logged ${evt}`);
    return event;
  };

  try {
    const first = await startServer({ env: identity("old"), onStdout: observe("old") });
    servers.push(first);
    const target = { httpUrl: first.httpUrl, ownerKey: first.ownerKey };

    const enrolled = await enrollMachine(first, "handoff-agent");
    const agent = await startAgent({
      serverUrl: first.url,
      machineToken: enrolled.machineToken,
      name: "handoff-agent",
    });
    agents.push(agent);
    const container = await createContainer(first, "handoff canvas");
    const grant = await mintToken(first, {
      principal: { kind: "human", name: "Handoff User", color: "#2f7d6d" },
      caps: ["containers:read", "scenes:write", "terminals:spawn", "terminals:write"],
    });
    const canvas = await connect(first, { containerId: container.id, token: grant.token });
    clients.push(canvas);
    canvas.on("status", (status) => statuses.push({ at: now(), status }));
    const { terminal, homeClient } = await openTerminalAt(canvas, first, {
      elementId: "el-handoff-terminal",
      token: grant.token,
      portalAt: { x: 120, y: 80 },
    });
    clients.push(homeClient);
    const before = await attachedCapture(homeClient, terminal.id);
    captures.push(before);
    homeClient.sendTerminalInput(terminal.id, "printf 'PID_%s\\n' \"$$\"\n");
    await waitForTerminalText(before, "PID_", 10_000);
    const shellPid = /PID_(\d+)/.exec(before.snapshotText + before.outputText)?.[1];
    expect(shellPid).toBeDefined();
    // The PTY keeps producing through both switches; the hub is never in its path to the shell.
    homeClient.sendTerminalInput(
      terminal.id,
      "i=0; while [ $i -lt 100000 ]; do i=$((i+1)); printf 'TICK_%s\\n' \"$i\"; sleep 0.05; done &\n",
    );
    await waitFor(() => ticks(before.snapshotText + before.outputText).length >= 3, 10_000, 20);

    // Continuous probes against the one origin both hubs serve in turn.
    probes.push(
      (async () => {
        while (probing) {
          const at = now();
          let build: string | null = null;
          try {
            const response = await fetch(`${target.httpUrl}/healthz`, {
              signal: AbortSignal.timeout(1_000),
            });
            if (response.ok)
              build = HealthResponseSchema.parse(await response.json()).build ?? null;
          } catch {
            build = null;
          }
          health.push({ at, build });
          await Bun.sleep(20);
        }
      })(),
      (async () => {
        let sequence = 0;
        while (probing) {
          const at = now();
          const name = `probe-${sequence++}`;
          let outcome: WriteSample["outcome"];
          try {
            const response = await fetch(
              `${target.httpUrl}/api/actions/core.index.createContainer`,
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${target.ownerKey}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ name }),
                signal: AbortSignal.timeout(5_000),
              },
            );
            if (response.status === 503) outcome = "handover";
            else if (!response.ok) outcome = "failed";
            else
              outcome = ActionOutcomeSchema.parse(await response.json()).ok
                ? "acknowledged"
                : "failed";
          } catch {
            outcome = "unreachable";
          }
          writes.push({ at, name, outcome });
          await Bun.sleep(40);
        }
      })(),
    );
    await waitFor(
      () => writes.filter((sample) => sample.outcome === "acknowledged").length >= 3,
      10_000,
      20,
    );

    const receipts: Record<string, unknown>[] = [];
    let incumbent = first;
    let incumbentHub = "old";
    for (const [direction, successorHub] of [
      ["forward", "new"],
      ["rollback", "old-again"],
    ] as const) {
      const waiting = Promise.withResolvers<void>();
      const starting = startServer({
        dataDir: first.dataDir,
        port: first.port,
        ownerKey: first.ownerKey,
        env: identity(successorHub),
        onStdout: observe(successorHub, (event) => {
          if (event.evt === "writer_waiting") waiting.resolve();
        }),
      });
      await waiting.promise;
      // The successor has loaded and is blocked on the lock; the incumbent still acknowledges writes.
      const ackedWhileWaiting = writes.filter((sample) => sample.outcome === "acknowledged").length;
      await waitFor(
        () =>
          writes.filter((sample) => sample.outcome === "acknowledged").length > ackedWhileWaiting,
        5_000,
        10,
      );
      expect(
        writerEvents.some((event) => event.hub === successorHub && event.evt === "writer_claimed"),
      ).toBe(false);

      const lastTickBefore = Math.max(...ticks(before.snapshotText + before.outputText));
      const signalledAt = now();
      await incumbent.stop("SIGTERM");
      const exitedAt = now();
      const successor = await starting;
      servers.push(successor);
      const readyAt = now();

      const sealed = find(incumbentHub, "writer_sealed");
      const claimed = find(successorHub, "writer_claimed");
      // One writer at every point: the successor's first commit read the incumbent's last one.
      // Both stamps come from the same host clock, so causality orders them regardless of pipes.
      expect(Number(claimed.fields["ts"])).toBeGreaterThanOrEqual(Number(sealed.fields["ts"]));
      expect(claimed.fields["epoch"]).toBe(Number(sealed.fields["epoch"]) + 1);
      expect(claimed.fields["predecessor"]).toBe("sealed");
      expect(sealed.fields["settled"]).toBe(true);

      await waitFor(() => health.at(-1)?.build === `0.0.0+handoff.${successorHub}`, 10_000, 10);
      const acknowledgedBefore = writes.filter(
        (sample) => sample.outcome === "acknowledged",
      ).length;
      await waitFor(
        () =>
          writes.filter((sample) => sample.outcome === "acknowledged").length > acknowledgedBefore,
        10_000,
        10,
      );
      await waitFor(() => canvas.status === "open", 20_000, 10);
      await waitFor(async () => isMachineOnline(successor, enrolled.machineId), 20_000, 20);
      const machineOnlineAt = now();

      // A browser session resumes and its next edit is durable on the successor.
      const savedRev = canvas.rev + 1;
      const saved = nextMessage(canvas, "saved", 10_000, (message) => message.rev >= savedRev);
      canvas.transact((tx) =>
        tx.create(textElement(`el-after-${direction}`, `after ${direction}`)),
      );
      await saved;

      // The PTY is the same process, still running, and nothing it wrote was lost.
      await waitFor(() => homeClient.terminals.get(terminal.id)?.status === "running", 10_000, 20);
      const after = await attachedCapture(homeClient, terminal.id);
      captures.push(after);
      homeClient.sendTerminalInput(terminal.id, "printf 'PID_%s\\n' \"$$\"\n");
      await waitFor(
        () => [...(after.snapshotText + after.outputText).matchAll(/PID_(\d+)/g)].length >= 2,
        10_000,
        20,
      );
      for (const match of (after.snapshotText + after.outputText).matchAll(/PID_(\d+)/g)) {
        expect(match[1]).toBe(shellPid);
      }
      const seen = [...new Set(ticks(after.snapshotText + after.outputText))].sort((a, b) => a - b);
      expect(seen[0]).toBeLessThanOrEqual(lastTickBefore);
      expect(seen.at(-1)).toBeGreaterThan(lastTickBefore);
      expect(seen.length).toBe(seen.at(-1)! - seen[0]! + 1);

      const predecessorBuild = `0.0.0+handoff.${incumbentHub}`;
      const successorBuild = `0.0.0+handoff.${successorHub}`;
      const lastIncumbentOk = health.filter((sample) => sample.build === predecessorBuild).at(-1)!;
      const firstSuccessorOk = health.find((sample) => sample.build === successorBuild)!;
      // Never both: the incumbent does not answer again once its successor has.
      expect(
        health.some(
          (sample) => sample.build === predecessorBuild && sample.at > firstSuccessorOk.at,
        ),
      ).toBe(false);
      const window = writes.filter(
        (sample) => sample.at >= signalledAt - 1 && sample.at <= readyAt + 5_000,
      );
      const lastAckBefore = writes
        .filter((sample) => sample.outcome === "acknowledged" && sample.at < signalledAt)
        .at(-1)!;
      const firstAckAfter = writes.find(
        (sample) => sample.outcome === "acknowledged" && sample.at > signalledAt,
      )!;
      const disconnected = statuses.find(
        (entry) => entry.status !== "open" && entry.at >= signalledAt,
      );
      const reopened = statuses.find((entry) => entry.status === "open" && entry.at >= signalledAt);
      receipts.push({
        direction,
        epochs: `${String(sealed.fields["epoch"])} sealed -> ${String(claimed.fields["epoch"])} claimed`,
        quiesceMs: sealed.fields["quiesceMs"],
        signalToExitMs: exitedAt - signalledAt,
        sealToClaimMs: Number(claimed.fields["ts"]) - Number(sealed.fields["ts"]),
        signalToSuccessorReadyMs: readyAt - signalledAt,
        healthGapMs: firstSuccessorOk.at - lastIncumbentOk.at,
        writeGapMs: firstAckAfter.at - lastAckBefore.at,
        writesRefusedHandover: window.filter((sample) => sample.outcome === "handover").length,
        writesUnreachable: window.filter((sample) => sample.outcome === "unreachable").length,
        writesFailed: window.filter((sample) => sample.outcome === "failed").length,
        sessionReconnectMs:
          disconnected === undefined || reopened === undefined
            ? null
            : reopened.at - disconnected.at,
        signalToMachineOnlineMs: machineOnlineAt - signalledAt,
        ptyTicksContiguous: `${seen[0]}..${seen.at(-1)}`,
      });
      incumbent = successor;
      incumbentHub = successorHub;
    }

    probing = false;
    await Promise.all(probes);
    // No acknowledged write was lost across either switch.
    const names = new Set((await listContainers(incumbent)).map((entry) => entry.name));
    const acknowledged = writes.filter((sample) => sample.outcome === "acknowledged");
    expect(acknowledged.filter((sample) => !names.has(sample.name))).toEqual([]);
    expect(writes.filter((sample) => sample.outcome === "failed")).toEqual([]);
    console.log(
      `writer handoff receipt: ${JSON.stringify({ acknowledgedWrites: acknowledged.length, receipts })}`,
    );
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    probing = false;
    await Promise.all(probes);
    for (const capture of captures) capture.stop();
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 90_000);
