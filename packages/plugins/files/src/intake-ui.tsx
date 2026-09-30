import type { PortablePanelProps } from "@manifold/plugin";
import { canonicalJobJson, type NativeTransferReceipt, type PluginOwnedRef } from "@manifold/protocol";
import { Button, Stack, Text } from "@manifold/ui";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { z } from "zod";
import type { FileDescriptor } from "./contract.ts";
import { FileUpload } from "./upload-ui.tsx";
import { NativeFileTransfer } from "./native-ui.tsx";

const IntakeOptionsSchema = z.strictObject({
  flow: z.enum(["save", "deliver"]),
  purpose: z.enum(["file", "image"]).optional(),
  suggestedMachineId: z.string().min(1).max(128).optional(),
});

/** Borrowed callers mount this owner; they never borrow its controllers or byte custody. */
export function FileIntakePanel(props: PortablePanelProps): ReactElement {
  const { host, input } = props;
  const selection = input?.files[0]?.handle;
  const value = canonicalJobJson(input?.value ?? {});
  const [scope, setScope] = useState({ client: host.client, localFiles: host.localFiles, principal: host.principal.id, selection, value, generation: 0 });
  if (scope.client !== host.client || scope.localFiles !== host.localFiles || scope.principal !== host.principal.id || scope.selection !== selection || scope.value !== value) {
    setScope({ client: host.client, localFiles: host.localFiles, principal: host.principal.id, selection, value, generation: scope.generation + 1 });
    return <Text wrap>Closing the previous file review. Any completed save remains in Files.</Text>;
  }
  return <FileIntakeReview key={scope.generation} {...props} />;
}

function FileIntakeReview({ host, input, onResult }: PortablePanelProps): ReactElement {
  const options = IntakeOptionsSchema.safeParse(input?.value);
  const [saved, setSaved] = useState<FileDescriptor | null>(null);
  const [published, setPublished] = useState<PluginOwnedRef | null>(null);
  const [delivery, setDelivery] = useState(false);
  if (!options.success || (input?.files.length ?? 0) > 1) return <Text wrap role="alert">File intake unavailable: the review request is invalid. Nothing was saved.</Text>;
  const close = (): void => { onResult?.({ state: "cancelled", savedRef: published }); };
  return <Stack gap="0.6rem">
    <Text strong>{options.data.flow === "deliver" ? "Save file, then deliver deliberately" : "Save an independent private file"}</Text>
    <Text wrap tone="muted">Selection remains local until Save. A saved file remains in Files after closing or cancelling delivery. Native MIME paste does not save a library file.</Text>
    {!delivery ? <Button onClick={close}>Close file review</Button> : null}
    {!delivery ? <>
      <FileUpload host={host} purpose={options.data.purpose} initialSelection={input?.files[0]} onClose={close}
        onPublished={(ref) => {
          setPublished(ref);
          if (options.data.flow === "save") onResult?.({ state: "saved", ref });
        }}
        onSaved={setSaved} />
      {published ? <Text wrap>Saved independently in Files. Closing or cancelling delivery does not delete that library file; use its explicit delete action in Files.</Text> : null}
      {saved && options.data.flow === "deliver" ? <>
        <Text wrap>Initial library audience: creator {saved.ownerId} only, subject to existing administrator authority. A machine copy has its own OS access policy.</Text>
        <Button onClick={() => setDelivery(true)}>Review Deliver to machine</Button>
      </> : null}
    </> : saved ? <NativeFileTransfer host={host} file={saved} suggestedMachineId={options.data.suggestedMachineId}
      onClose={close} renderDelivered={(receipt) => <DeliveredResult receipt={receipt} onResult={onResult} />} /> : null}
  </Stack>;
}

function DeliveredResult({ receipt, onResult }: {
  receipt: NativeTransferReceipt;
  onResult: PortablePanelProps["onResult"];
}): ReactElement {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current || !onResult) return;
    sent.current = true;
    onResult({ state: "delivered", receipt });
  }, [receipt, onResult]);
  return <Text wrap role="status">Verified delivery completed. Application consumption remains unknown.</Text>;
}
