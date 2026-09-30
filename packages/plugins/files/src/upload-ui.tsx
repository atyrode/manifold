import type { PortableHostServices } from "@manifold/plugin";
import { formatManifoldUri, type LocalFileDescriptor, type PluginOwnedRef } from "@manifold/protocol";
import { Button, Cluster, FileInput, Stack, Text } from "@manifold/ui";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import type { FileDescriptor } from "./contract.ts";
import { FileUploadController } from "./upload.ts";

export interface FileUploadProps {
  readonly host: PortableHostServices;
  readonly purpose?: "file" | "image" | undefined;
  readonly label?: string | undefined;
  readonly initialSelection?: LocalFileDescriptor | undefined;
  readonly onClose?: (() => void) | undefined;
  readonly onPublished?: ((ref: PluginOwnedRef) => void) | undefined;
  readonly onSaved?: ((file: FileDescriptor) => void) | undefined;
}

/** Shared image/library intake. Only the explicit Save gesture crosses the action door. */
export function FileUpload(props: FileUploadProps): ReactElement {
  const { host, purpose } = props;
  const [scope, setScope] = useState({ client: host.client, localFiles: host.localFiles, principal: host.principal.id, purpose, selection: props.initialSelection?.handle, generation: 0 });
  if (scope.client !== host.client || scope.localFiles !== host.localFiles || scope.principal !== host.principal.id || scope.purpose !== purpose || scope.selection !== props.initialSelection?.handle) {
    setScope({ client: host.client, localFiles: host.localFiles, principal: host.principal.id, purpose, selection: props.initialSelection?.handle, generation: scope.generation + 1 });
    return <Text>Closing the previous local selection…</Text>;
  }
  return <FileUploadIntake key={scope.generation} {...props} />;
}

function FileUploadIntake({ host, purpose = "file", label = "Choose, drop or explicitly save clipboard files", initialSelection, onClose, onPublished, onSaved }: FileUploadProps): ReactElement {
  const [controller, setController] = useState<FileUploadController | null>(null);
  const [opaque, setOpaque] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useLayoutEffect(() => () => controller?.dispose(), [controller]);

  const choose = (files: readonly LocalFileDescriptor[]): void => {
    // A late picker event must not replace an in-flight immutable intent.
    if (controller) {
      for (const file of files) void host.localFiles.release(file.handle).catch(() => setFailure("Could not release an unused local selection."));
      return;
    }
    const selected = files[0];
    for (const file of files.slice(1)) void host.localFiles.release(file.handle).catch(() => setFailure("Could not release an unused local selection."));
    if (!selected) return;
    try {
      setController(new FileUploadController(host, selected, opaque ? "file" : purpose));
      setFailure(null);
    } catch {
      void host.localFiles.release(selected.handle).catch(() => setFailure("Could not release the refused local selection."));
      setFailure("This selection exceeds the bounded file intake or has invalid metadata. Nothing was saved.");
    }
  };
  useEffect(() => {
    if (initialSelection) choose([initialSelection]);
  }, [initialSelection?.handle]);

  return <Stack gap="0.5rem">
    <Text strong>{purpose === "image" && !opaque ? "Save a private image" : "Save a private file"}</Text>
    <Text wrap tone="muted">Only the creator is selected for access. Named sharing is a separate deliberate decision after saving; existing administrator authority is unchanged.</Text>
    <Text wrap tone="muted">At most 16 MiB per file, one 256 KiB chunk in flight. Uploads expire after 60 seconds without accepted progress or 15 minutes total. Leaving closes local selection, not a published file.</Text>
    {failure ? <Text tone="danger" wrap role="alert">{failure}</Text> : null}
    {controller ? <UploadSelection controller={controller} purpose={opaque ? "file" : purpose}
      onPublished={onPublished} onSaved={onSaved}
      onClear={() => { setController(null); if (initialSelection) onClose?.(); }}
      onChooseOpaque={() => { setOpaque(true); setController(null); }} /> : <>
      {!initialSelection ? <FileInput label={label} accept={purpose === "image" && !opaque ? "images" : "files"} multiple={false} clipboard onChange={choose} /> : null}
      {purpose === "image" ? <Button onClick={() => setOpaque(!opaque)}>{opaque ? "Choose an image instead" : "Choose an opaque file instead (no image attachment)"}</Button> : null}
      <Text wrap>Selection remains local and pending until you confirm Save. Clipboard-only terminal paste does not save a file here.</Text>
    </>}
  </Stack>;
}

function UploadSelection({ controller, purpose, onPublished, onSaved, onClear, onChooseOpaque }: {
  controller: FileUploadController;
  purpose: "file" | "image";
  onPublished: FileUploadProps["onPublished"];
  onSaved: FileUploadProps["onSaved"];
  onClear: () => void;
  onChooseOpaque: () => void;
}): ReactElement {
  const callbacks = useRef({ onPublished, onSaved });
  callbacks.current = { onPublished, onSaved };
  const published = useRef<string | null>(null);
  const described = useRef<string | null>(null);
  const subscribe = useRef((notify: () => void) => controller.subscribe(() => {
    const snapshot = controller.getSnapshot();
    // This synchronous notification happens at the actual publication receipt, before inspect.
    if (snapshot.savedRef && published.current !== snapshot.savedRef.fileId) {
      published.current = snapshot.savedRef.fileId;
      callbacks.current.onPublished?.(snapshot.savedRef);
    }
    if (snapshot.file && described.current !== snapshot.file.ref.fileId) {
      described.current = snapshot.file.ref.fileId;
      callbacks.current.onSaved?.(snapshot.file);
    }
    notify();
  })).current;
  const state = useSyncExternalStore(subscribe, controller.getSnapshot, controller.getSnapshot);
  const terminal = state.phase === "cancelled" || state.phase === "saved" ||
    (state.phase === "refused" && state.transfer !== null && ["failed", "expired", "deleted"].includes(state.transfer.state));
  const localOnly = !state.busy && !state.transfer && !state.savedRef &&
    (state.phase === "refused" || state.phase === "outcome_unknown");
  return <Stack gap="0.4rem">
    <Text strong wrap>{state.selection.name || "file"}</Text>
    <Text wrap>{state.selection.bytes} bytes · {purpose === "image" ? "Validated static image requested" : "Opaque file; no preview promised"}</Text>
    <Text wrap role="status">{state.phase === "pending" ? "Locally pending — not saved or shared" : state.phase === "saved" ? "Saved privately in the library" : state.phase} · {state.transfer?.offset ?? 0}/{state.selection.bytes} bytes acknowledged</Text>
    {state.transfer ? <Text wrap tone="muted">Transfer {state.transfer.transferId}. Reported expiry: {new Date(state.transfer.expiresAt).toLocaleString()}.</Text> : null}
    <Text wrap tone="muted">Exact request: {state.requestId}</Text>
    {state.savedRef ? <Text wrap mono>{formatManifoldUri(state.savedRef)}</Text> : null}
    {state.reason ? <Text wrap tone={state.phase === "saved" ? "muted" : "danger"} role="alert">{state.reason}</Text> : null}
    {purpose === "image" && state.phase === "refused" ? <Text wrap>Image intake refused; see the exact reason above. No automatic conversion or opaque-file publication occurs. Reconcile or cancel this attempt before deliberately choosing opaque intake.</Text> : null}
    {localOnly ? <Text wrap>No upload acknowledgement was received. You may discard this local selection without retrying. This does not confirm server cancellation; any unconfirmed incomplete reservation expires without publication.</Text> : null}
    <Cluster gap="0.4rem">
      {!terminal ? <Button disabled={state.busy} data-action="core.files.beginUpload" onClick={() => { void controller.save(); }}>{state.phase === "pending" ? "Save file" : "Retry exact Save request"}</Button> : null}
      {state.transfer || state.savedRef ? <Button disabled={state.busy} data-action={state.savedRef ? "core.files.inspect" : "core.files.inspectUpload"} onClick={() => { void controller.reconcile(); }}>Reconcile without publishing</Button> : null}
      {!terminal ? <Button data-action="core.files.cancelUpload" onClick={() => { void controller.cancel(); }}>Cancel and discard incomplete upload</Button> : null}
      {terminal ? <Button disabled={state.busy} onClick={onClear}>Choose another file</Button> : null}
      {localOnly ? <Button onClick={onClear}>Discard local selection and choose another</Button> : null}
      {purpose === "image" && terminal && !state.savedRef ? <Button disabled={state.busy} onClick={onChooseOpaque}>Choose opaque intake instead</Button> : null}
    </Cluster>
  </Stack>;
}
