import type { HostServices, PanelProps } from "@manifold/plugin";
import { useProjection } from "@manifold/plugin/hooks";
import { formatManifoldUri, NativeTransferReceiptSchema, PluginOwnedRefSchema, type NativeTransferReceipt } from "@manifold/protocol";
import { Button, Cluster, Stack, Text } from "@manifold/ui";
import { useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { z } from "zod";
import { insertTerminalFilePath, terminalPathIsLiteral } from "./terminal-file-path.ts";

const IntakeResultSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("cancelled"), savedRef: PluginOwnedRefSchema.nullable() }),
  z.strictObject({ state: z.literal("delivered"), receipt: NativeTransferReceiptSchema }),
]);

/** The Files owner's registered panel owns byte custody and the entire Save/Deliver flow. */
export function TerminalFileIntake({ host, file, suggestedMachineId, send, onClose }: {
  host: HostServices;
  file: File;
  suggestedMachineId: string | undefined;
  send: (text: string) => boolean;
  onClose: () => void;
}): ReactElement {
  const projection = useProjection();
  const owner = projection.panel("core.files.intake");
  const Intake = owner?.enabled ? owner.Component : null;
  const input = useMemo(() => ({
    files: [file],
    value: { flow: "deliver", ...(suggestedMachineId ? { suggestedMachineId } : {}) },
  }), [file, suggestedMachineId]);
  const [receipt, setReceipt] = useState<NativeTransferReceipt | null>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const receive: NonNullable<PanelProps["onResult"]> = (value) => {
    if (!mounted.current) return;
    const result = IntakeResultSchema.safeParse(value);
    if (!result.success || (result.data.state === "delivered" && result.data.receipt.mode !== "put")) {
      setFailure("File review returned an unverified result. No terminal input was sent.");
      return;
    }
    if (result.data.state === "delivered") setReceipt(result.data.receipt);
    else setClosed(result.data.savedRef
      ? `Saved independently in Files: ${formatManifoldUri(result.data.savedRef)}. Closing or cancelling delivery does not delete that file.`
      : "File review closed without a confirmed publication. If Save was in progress, its outcome is unconfirmed; closing is not proof that nothing was saved. Check Files before starting another upload.");
  };
  if (receipt) return <Stack gap="0.5rem">
    <Text wrap>Verified independent machine copy. The source file remains in Files. Application consumption remains unknown.</Text>
    <Text wrap mono>{receipt.path}</Text>
    <DeliveredPath key={receipt.transferId} path={receipt.path} send={(text) => mounted.current && send(text)} />
    <Button onClick={onClose}>Close file review</Button>
  </Stack>;
  if (closed) return <Stack gap="0.5rem">
    <Text wrap role="status">{closed}</Text>
    <Button onClick={onClose}>Close file review</Button>
  </Stack>;
  return <Stack gap="0.5rem">
    {failure ? <Text wrap role="alert">{failure}</Text> : null}
    {Intake ? <Intake host={host} input={input} onResult={receive} /> : <>
      <Text wrap role="alert">Files intake is unavailable. No file was handed to a destination and no terminal input was sent. There is no shell or clipboard fallback.</Text>
      <Button onClick={onClose}>Close file review</Button>
    </>}
  </Stack>;
}

function DeliveredPath({ path, send }: { path: string; send: (text: string) => boolean }): ReactElement {
  const [preview, setPreview] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const current = useRef(true);
  useLayoutEffect(() => { current.current = true; return () => { current.current = false; }; }, []);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(path);
      if (current.current) setStatus("Actual destination path copied. Application consumption remains unknown.");
    } catch {
      if (current.current) setStatus("Clipboard write unavailable. Select and copy the displayed path; no terminal input was sent.");
    }
  };
  return <Stack gap="0.4rem">
    <Text wrap>Copying the actual path is the safe default. Insertion is literal text only, with no Enter, shell command or quoting; the application may interpret that text.</Text>
    <Cluster gap="0.4rem">
      <Button onClick={() => { void copy(); }}>Copy actual destination path</Button>
      <Button disabled={!terminalPathIsLiteral(path)} onClick={() => setPreview(true)}>Review literal path insertion</Button>
    </Cluster>
    {!terminalPathIsLiteral(path) ? <Text wrap tone="danger">Path insertion refused: the actual path contains control characters.</Text> : null}
    {preview ? <Stack gap="0.3rem">
      <Text wrap>Exactly this plaintext will be sent (no surrounding quotes or newline):</Text>
      <pre className="terminal-file-path">{path}</pre>
      <Cluster gap="0.4rem">
        <Button onClick={() => {
          const inserted = current.current && insertTerminalFilePath(path, send);
          setStatus(inserted ? "Literal path sent; no Enter was sent. Application consumption remains unknown." : "Insertion refused: current terminal write/control authority is required.");
          setPreview(false);
        }}>Insert exactly this path — no Enter</Button>
        <Button onClick={() => setPreview(false)}>Cancel insertion</Button>
      </Cluster>
    </Stack> : null}
    {status ? <Text wrap role="status">{status}</Text> : null}
  </Stack>;
}
