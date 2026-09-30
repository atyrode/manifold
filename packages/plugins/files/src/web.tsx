import type { PortablePanelProps, PortableSectionProps } from "@manifold/plugin";
import { formatManifoldUri, type PluginOwnedRef } from "@manifold/protocol";
import { Button, Cluster, Empty, Stack, Text } from "@manifold/ui";
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { z } from "zod";
import { ListFilesResultSchema, type FileDescriptor } from "./contract.ts";
import { fileAction, fileFailure } from "./browser-actions.ts";
import { FileDetails } from "./library-details.tsx";
import { NativeFileTransfer } from "./native-ui.tsx";
import { FileUpload } from "./upload-ui.tsx";
export { FileIntakePanel } from "./intake-ui.tsx";

/** One portable React source: the page and packed Worker paint the same vocabulary tree. */
export function FilesPanel({ host }: PortablePanelProps): ReactElement {
  const [scope, setScope] = useState({ client: host.client, localFiles: host.localFiles, principal: host.principal.id, generation: 0 });
  if (scope.client !== host.client || scope.localFiles !== host.localFiles || scope.principal !== host.principal.id) {
    setScope({ client: host.client, localFiles: host.localFiles, principal: host.principal.id, generation: scope.generation + 1 });
    return <Text>Closing the previous Files session…</Text>;
  }
  return <FilesLibrary key={scope.generation} host={host} />;
}

function FilesLibrary({ host }: PortableSectionProps): ReactElement {
  const [page, setPage] = useState<z.output<typeof ListFilesResultSchema> | null>(null);
  const [cursor, setCursor] = useState<PluginOwnedRef | undefined>(undefined);
  const [previous, setPrevious] = useState<(PluginOwnedRef | undefined)[]>([]);
  const [selected, setSelected] = useState<PluginOwnedRef | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [download, setDownload] = useState(false);
  const [deliveryFile, setDeliveryFile] = useState<FileDescriptor | null>(null);
  const pending = useRef(false);
  const generation = useRef(0);

  const load = async (after?: PluginOwnedRef, history: (PluginOwnedRef | undefined)[] = []): Promise<void> => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setFailure(null); setPage(null);
    const current = generation.current;
    try {
      const value = await fileAction(host, "list", { ...(after ? { after } : {}), limit: 32 }, ListFilesResultSchema);
      if (generation.current === current) { setPage(value); setCursor(after); setPrevious(history); }
    } catch (error) { if (generation.current === current) setFailure(fileFailure(error)); }
    finally { if (generation.current === current) { pending.current = false; setBusy(false); } }
  };
  useEffect(() => {
    generation.current += 1; pending.current = false;
    setSelected(null); setCursor(undefined); setPrevious([]); setDownload(false);
    void load();
    return () => { generation.current += 1; };
  }, [host.client]);

  return <Stack gap="0.9rem">
    <Text strong>Files</Text>
    <Text wrap tone="muted">Private immutable files, explicit named sharing, and deliberate machine transfers. A reference is not read authority. Existing administrator powers still apply.</Text>
    <FileUpload key={host.principal.id} host={host} onPublished={(ref) => setSelected(ref)} onSaved={() => { void load(); }} />
    <Stack gap="0.4rem">
      <Text strong>Authorized library — at most 32 files per page</Text>
      <Text wrap tone="muted">Only files readable by this credential are returned. No hidden totals, unauthorised positions or inferred audience are shown.</Text>
      <Cluster gap="0.4rem">
        <Button disabled={busy} data-action="core.files.list" onClick={() => { void load(); }}>Refresh first page</Button>
        <Button disabled={busy || previous.length === 0} data-action="core.files.list" onClick={() => {
          void load(previous.at(-1), previous.slice(0, -1));
        }}>Previous page</Button>
        <Button disabled={busy || !page?.next} data-action="core.files.list" onClick={() => {
          if (page?.next) void load(page.next, [...previous.slice(-31), cursor]);
        }}>Next page</Button>
      </Cluster>
      {failure ? <Text wrap tone="danger" role="alert">{failure} If a cursor lost authority, refresh the first page.</Text> : null}
      {busy ? <Text role="status">Reading authorized library…</Text> : null}
      {page?.files.length === 0 ? <Empty>No readable files in this page</Empty> : null}
      {page?.files.map((file) => <Stack key={file.ref.fileId} gap="0.15rem">
        <Text strong wrap>{file.name}</Text>
        <Text wrap tone="muted">{file.bytes} bytes · {file.image ? "validated image" : "opaque file"}</Text>
        <Button data-action="core.files.inspect" onClick={() => setSelected(file.ref)}>Inspect file, audience and actions</Button>
      </Stack>)}
    </Stack>
    {selected ? <Stack gap="0.5rem">
      <Text wrap mono>Selected {formatManifoldUri(selected)}</Text>
      <FileDetails key={formatManifoldUri(selected)} host={host} reference={selected} onDeleted={() => { void load(); }}
        onDeliver={(file) => setDeliveryFile(file)} deliveryActive={deliveryFile !== null} />
    </Stack> : <Text wrap tone="muted">Select a file to inspect, prepare a browser read, review exact sharing, deliver, or logically delete.</Text>}
    {deliveryFile ? <NativeFileTransfer host={host} file={deliveryFile} onClose={() => setDeliveryFile(null)} /> : null}
    <Button disabled={download} onClick={() => setDownload(true)}>Review machine-to-browser download (no library retention)</Button>
    {download ? <NativeFileTransfer host={host} /> : null}
  </Stack>;
}

export function FilesSection({ host }: PortableSectionProps): ReactElement {
  return <FilesPanel host={host} />;
}
