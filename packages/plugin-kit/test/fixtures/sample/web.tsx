import type { PortablePanelProps } from "@manifold/plugin";
import { defineWebPlugin } from "@manifold/plugin-kit/web";
import {
  Badge,
  Button,
  Code,
  ControlIcon,
  Divider,
  Empty,
  Heading,
  Input,
  List,
  Select,
  Spinner,
  Stack,
  Text,
  Toggle,
} from "@manifold/ui";
import { useEffect, useState, type ReactElement } from "react";
import { z } from "zod";

/*
  THE REFERENCE PORTABLE PLUGIN, web half. One panel, `counter`, written as ordinary React
  over `@manifold/ui` — every kind of the closed vocabulary appears below on purpose — that
  dispatches `example.counter.bump` through the host when the button fires. The same source
  runs in-realm linked to the shell, or in the plugin's Worker under the kit's frame renderer,
  where its state, its timer effect and its host call keep exactly their React meaning.
*/

const BumpResult = z.object({ count: z.number().int() });

const STEPS = [
  { value: "1", label: "by one" },
  { value: "5", label: "by five" },
] as const;

function Counter({ host }: PortablePanelProps): ReactElement {
  const [count, setCount] = useState<number | null>(null);
  const [step, setStep] = useState("1");
  const [note, setNote] = useState("");
  const [loud, setLoud] = useState(false);
  const [denial, setDenial] = useState<string | null>(null);
  const [ticks, setTicks] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTicks((value) => value + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  const bump = async (): Promise<void> => {
    const outcome = await host.client.action("example.counter.bump", { by: Number(step) });
    if (!outcome.ok) {
      setDenial(outcome.denial.message);
      return;
    }
    setCount(BumpResult.parse(outcome.result).count);
    setDenial(null);
  };

  return (
    <Stack gap="0.5rem">
      <Heading level={2}>Counter</Heading>
      <Text tone="muted">Hello, {host.principal.name}.</Text>
      <Divider />
      {count === null ? (
        <Spinner label="Waiting for the first bump" />
      ) : (
        <Badge tone={loud ? "accent" : "neutral"}>count {count}</Badge>
      )}
      <Select label="Step" value={step} options={STEPS} onChange={setStep} />
      <Input label="Note" placeholder="why this bump?" value={note} onChange={setNote} />
      <Toggle label="Loud" value={loud} onChange={setLoud} />
      <Button tone="accent" data-action="example.counter.bump" onClick={() => void bump()}>
        Bump
      </Button>
      {denial === null ? <Empty>No refusal yet.</Empty> : <Text tone="danger">{denial}</Text>}
      <Code>{JSON.stringify({ ticks }, null, 2)}</Code>
      <List items={[{ key: "ticks", primary: "Ticks", secondary: String(ticks) }]} />
      <ControlIcon kind="add" size={14} />
    </Stack>
  );
}

export default defineWebPlugin({ id: "example.counter", panels: { counter: Counter } });
