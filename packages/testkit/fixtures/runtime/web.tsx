import type { PortablePanelProps, StreamHandle } from "@manifold/plugin";
import { defineWebPlugin } from "@manifold/plugin-kit/web";
import { Button, Heading, Input, Stack, Text } from "@manifold/ui";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { PLUGIN, OPERATION, limits } from "./shared.ts";

interface Progress {
  epoch: string;
  seq: number;
  status: string;
  snapshots: number;
  gaps: number;
  resets: number;
  errors: number;
  maxSnapshot: number;
  frames: number;
  firstAt: number;
  lastAt: number;
}
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

function Proof({ host }: PortablePanelProps): ReactElement {
  const [machine, setMachine] = useState("");
  const [job, setJob] = useState("once");
  const [outcome, setOutcome] = useState<unknown>(null);
  const [actions, setActions] = useState(0);
  const [progress, setProgress] = useState(initial);
  /** The continuity tally survives reconnects; only a fresh open starts it over. */
  const tally = useRef(initial());
  const stream = useRef<{ readonly handle: StreamHandle; readonly off: () => void } | null>(null);

  const pause = useCallback(() => {
    stream.current?.off();
    stream.current?.handle.close();
    stream.current = null;
  }, []);
  useEffect(() => pause, [pause]);

  const open = (mode: "fresh" | "resume" | "stale"): void => {
    const previous = tally.current;
    const cursor = previous.epoch
      ? { epoch: previous.epoch, seq: mode === "stale" ? 0 : previous.seq }
      : undefined;
    pause();
    if (mode === "fresh") tally.current = initial();
    const handle = host.client.openStream({
      kind: `${PLUGIN}.frames`,
      node: { kind: "plugin", pluginId: PLUGIN },
      ...(mode !== "fresh" && cursor ? { cursor } : {}),
    });
    const off = handle.on((message) => {
      const current = tally.current;
      if (message.type === "stream_snapshot") {
        for (let i = 1; i < message.frames.length; i++) {
          if (message.frames[i]!.seq !== message.frames[i - 1]!.seq + 1) current.errors++;
        }
        if (current.epoch === message.epoch && message.lastSeq < current.seq && mode !== "stale")
          current.errors++;
        current.epoch = message.epoch;
        current.seq = message.lastSeq;
        current.snapshots++;
        current.maxSnapshot = Math.max(current.maxSnapshot, message.frames.length);
      } else if (message.type === "stream_frame") {
        if (message.epoch !== current.epoch || message.seq !== current.seq + 1) current.errors++;
        current.seq = message.seq;
        current.frames++;
        current.firstAt ||= Date.now();
        current.lastAt = Date.now();
      } else if (message.type === "stream_gap") {
        current.gaps++;
        current.seq = message.toSeq;
      } else if (message.type === "stream_reset") {
        current.resets++;
        current.epoch = message.epoch;
        current.seq = 0;
      }
      current.status = handle.status;
      setProgress({ ...current });
    });
    stream.current = { handle, off };
  };

  const act = async (name: string, args: unknown): Promise<void> => {
    const result = await host.client.action(name, args);
    setActions((count) => count + 1);
    setOutcome(result);
  };
  const node = { kind: "job", machineId: machine, operationId: OPERATION, jobId: job };

  return (
    <Stack gap="0.5rem">
      <Heading level={2}>Governed runtime acceptance</Heading>
      <Input label="Target machine" value={machine} onChange={setMachine} />
      <Input label="Job identity" value={job} onChange={setJob} />
      <Button
        data-action="engine.jobs.execute"
        onClick={() =>
          void act("engine.jobs.execute", {
            machineId: machine,
            pluginId: PLUGIN,
            operationId: OPERATION,
            jobId: job,
            input: { label: job },
            outputs: [],
            limits,
          })
        }
      >
        Run bounded job
      </Button>
      <Button
        data-action="engine.jobs.status"
        onClick={() => void act("engine.jobs.status", { node })}
      >
        Refresh job
      </Button>
      <Button
        data-action="engine.jobs.cancel"
        onClick={() => void act("engine.jobs.cancel", { node })}
      >
        Cancel job
      </Button>
      <Button data-action={`${PLUGIN}.start`} onClick={() => void act(`${PLUGIN}.start`, {})}>
        Start sixty seconds
      </Button>
      <Button onClick={() => open("fresh")}>Open stream</Button>
      <Button onClick={() => open("resume")}>Reconnect stream</Button>
      <Button onClick={() => open("stale")}>Retained window</Button>
      <Button onClick={pause}>Pause consumer</Button>
      <Text wrap mono>
        {`Runtime proof ${JSON.stringify({ target: machine, job, outcome, actions, ...progress })}`}
      </Text>
    </Stack>
  );
}

export default defineWebPlugin({ id: PLUGIN, panels: { proof: Proof } });
