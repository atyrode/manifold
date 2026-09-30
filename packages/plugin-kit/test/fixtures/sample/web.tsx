import type { PortablePanelProps } from "@manifold/plugin";
import { defineWebPlugin } from "@manifold/plugin-kit/web";
import {
  ByteDownloadSourceSchema,
  ByteImageSourceSchema,
  type ByteImageSource,
  type LocalFileDescriptor,
} from "@manifold/protocol";
import {
  Badge,
  BorrowedPanel,
  ByteDownload,
  ByteImage,
  Button,
  Code,
  ControlIcon,
  Divider,
  Empty,
  FileInput,
  Heading,
  Input,
  List,
  Select,
  Spinner,
  Stack,
  Text,
  Toggle,
} from "@manifold/ui";
import { useEffect, useRef, useState, type ReactElement } from "react";
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
  const [selection, setSelection] = useState("No local files inspected.");
  const [rasterClosed, setRasterClosed] = useState(false);

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

  const inspectFiles = async (files: readonly LocalFileDescriptor[]): Promise<void> => {
    setSelection(files.map((file) => `${file.name}: ${file.bytes} bytes`).join(", "));
    try {
      await Promise.all(files.map((file) => host.localFiles.release(file.handle)));
    } catch (error) {
      setDenial(`Could not release the local selection: ${String(error)}`);
    }
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
      <FileInput
        label="Inspect local files"
        multiple
        onChange={(files) => void inspectFiles(files)}
      />
      <Text>{selection}</Text>
      {rasterClosed ? (
        <Text>The borrowed raster reader was closed.</Text>
      ) : (
        <BorrowedPanel
          panelId="example.counter.raster"
          input={{ title: "Reference raster" }}
          onResult={() => setRasterClosed(true)}
        />
      )}
    </Stack>
  );
}

/** The host mounts this second Worker panel and owns its one-shot result and byte custody. */
function Raster({ host, input, onResult }: PortablePanelProps): ReactElement {
  const [source, setSource] = useState<ByteImageSource | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const closing = useRef(false);
  const cancelled = useRef<string | null>(null);
  const title = z.object({ title: z.string() }).safeParse(input?.value);
  useEffect(() => {
    let active = true;
    let opened: ByteImageSource | null = null;
    const close = async (value: ByteImageSource): Promise<void> => {
      try {
        const result = await host.client.action("example.counter.cancelRaster", {
          transferId: value.transferId,
        });
        if (!result.ok) console.warn(`Raster close refused: ${result.denial.message}`);
      } catch (error) {
        console.warn(`Raster close failed: ${String(error)}`);
      }
    };
    void host.client.action("example.counter.openRaster", {}).then(
      (outcome) => {
        if (!outcome.ok) {
          if (active) setFailure(outcome.denial.message);
          return;
        }
        const parsed = ByteImageSourceSchema.safeParse(outcome.result);
        if (!parsed.success) {
          if (active) setFailure("Invalid raster read descriptor.");
          return;
        }
        opened = parsed.data;
        if (active) setSource(opened);
        else void close(opened);
      },
      (error: unknown) => {
        if (active) setFailure(String(error));
      },
    );
    return () => {
      active = false;
      if (opened !== null && cancelled.current !== opened.transferId) void close(opened);
    };
  }, [host.client]);
  const finish = async (): Promise<void> => {
    if (source === null || closing.current) return;
    closing.current = true;
    try {
      // Complete the authority-bearing close before the result retires this Worker's mount.
      const outcome = await host.client.action("example.counter.cancelRaster", {
        transferId: source.transferId,
      });
      if (!outcome.ok) {
        setFailure(outcome.denial.message);
        return;
      }
      cancelled.current = source.transferId;
      onResult?.({ closed: true });
    } catch (error) {
      setFailure(`Could not close the raster reader: ${String(error)}`);
    } finally {
      closing.current = false;
    }
  };
  return (
    <Stack gap="0.5rem">
      <Text>{title.success ? title.data.title : "Reference raster"}</Text>
      {failure !== null ? <Text tone="danger">{failure}</Text> : null}
      {source === null ? (
        <Text>Opening authenticated raster bytes.</Text>
      ) : (
        <>
          <ByteImage label="Reference checkerboard" source={source} />
          <ByteDownload
            label="Download reference raster"
            filename="reference-raster.png"
            source={ByteDownloadSourceSchema.parse({
              pluginId: source.pluginId,
              carrierId: source.carrierId,
              transferId: source.transferId,
              ref: source.ref,
              bytes: source.bytes,
              sha256: source.sha256,
            })}
          />
        </>
      )}
      <Button disabled={source === null} onClick={() => void finish()}>
        Close raster reader
      </Button>
    </Stack>
  );
}

export default defineWebPlugin({
  id: "example.counter",
  panels: { counter: Counter, raster: Raster },
});
