import type { PortableHostServices } from "@manifold/plugin";
import {
  formatManifoldUri, ReferenceTerminalReceiptSchema, RestrictedAudiencePageSchema,
  RestrictedGrantResultSchema, RestrictedGrantViewSchema,
  type PluginOwnedRef, type ReferenceGrantRequest, type RestrictedAudiencePage,
  type RestrictedGrantView,
} from "@manifold/protocol";
import { Button, ByteDownload, Cluster, Input, Stack, Text } from "@manifold/ui";
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { z } from "zod";
import { createFileRequestId, FILE_READ, FILES_ID, FileDescriptorSchema, FileTransferSchema, OpenFileReadResultSchema, type FileDescriptor } from "./contract.ts";
import { fileAction, fileFailure } from "./browser-actions.ts";

export function FileDetails({ host, reference, onDeleted, onDeliver, deliveryActive }: {
  host: PortableHostServices;
  reference: PluginOwnedRef;
  onDeleted: () => void;
  onDeliver: (file: FileDescriptor) => void;
  deliveryActive: boolean;
}): ReactElement {
  const [file, setFile] = useState<FileDescriptor | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [deleteAttempted, setDeleteAttempted] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [readIntent, setReadIntent] = useState<string | null>(null);
  const [read, setRead] = useState<z.output<typeof OpenFileReadResultSchema> | null>(null);
  const [readClosed, setReadClosed] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState<string | null>(null);
  const gate = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    void fileAction(host, "inspect", { ref: reference }, FileDescriptorSchema).then(
      (value) => { if (live.current) setFile(value); },
      (error: unknown) => { if (live.current) setFailure(fileFailure(error)); },
    );
    return () => { live.current = false; };
  }, [host, reference]);
  const work = async (run: () => Promise<void>): Promise<void> => {
    if (gate.current) return;
    gate.current = true; setBusy(true); setFailure(null);
    try { await run(); }
    catch (error) { if (live.current) setFailure(fileFailure(error)); }
    finally { gate.current = false; if (live.current) setBusy(false); }
  };
  const inspect = (): void => {
    setFile(null); setRead(null);
    void work(async () => {
      const value = await fileAction(host, "inspect", { ref: reference }, FileDescriptorSchema);
      if (live.current) setFile(value);
    });
  };
  const prepare = (): void => {
    void work(async () => {
      const requestId = readIntent ?? createFileRequestId();
      setReadIntent(requestId);
      const value = await fileAction(host, "openRead", { ref: reference, requestId }, OpenFileReadResultSchema);
      if (live.current) { setRead(value); setReadClosed(false); setFile(value.file); }
    });
  };
  const closeRead = (): void => {
    if (!read) return;
    void work(async () => {
      const transfer = await fileAction(host, "cancelRead", { ref: reference, transferId: read.transfer.transferId }, FileTransferSchema);
      if (live.current) {
        setRead({ ...read, transfer });
        setReadClosed(["cancelled", "expired", "failed"].includes(transfer.state));
        setDownloadStatus(`Read is ${transfer.state}. Previously delivered bytes are not erased.`);
      }
    });
  };
  const remove = (reconcile: boolean): void => {
    void work(async () => {
      if (!reconcile) setDeleteAttempted(true);
      const receipt = await fileAction(host, reconcile ? "receipt" : "delete", { ref: reference }, ReferenceTerminalReceiptSchema);
      if (!live.current) return;
      if (receipt.state !== "deleted") { setFailure(`Terminal receipt is ${receipt.state}, not deleted.`); return; }
      setDeleted(true); setFile(null); setRead(null); setArmed(false); onDeleted();
    });
  };
  if (deleted) return <Stack gap="0.4rem">
    <Text wrap role="status">Logical deletion confirmed. Future file reads and projections are unavailable. Canvas references/history and independent machine/browser copies were not removed. This is not secure erasure of backups.</Text>
    <Text wrap mono>{formatManifoldUri(reference)}</Text>
  </Stack>;

  return <Stack gap="0.7rem">
    <Text strong>Authorized file inspection</Text>
    <Text wrap mono>{formatManifoldUri(reference)}</Text>
    <Button disabled={busy} data-action="core.files.inspect" onClick={inspect}>Refresh authorized metadata</Button>
    {failure ? <Text wrap tone="danger" role="alert">{failure}</Text> : null}
    {file ? <>
      <Text strong wrap>{file.name}</Text>
      <Text wrap>{file.bytes} bytes · {file.mediaType} · owner {file.ownerId} · created {new Date(file.createdAt).toLocaleString()}</Text>
      <Text wrap mono>SHA-256 {file.sha256}</Text>
      <Text wrap>{file.image ? `Validated static image: ${file.image.width} × ${file.image.height}, ${file.image.mediaType}` : "Opaque file. No image preview is claimed."}</Text>
      <Stack gap="0.35rem">
        <Text strong>Authenticated browser download</Text>
        <Text wrap tone="muted">Prepare an authorized read, then explicitly download verified bytes. Preparing alone does not save anything in the browser.</Text>
        <Cluster gap="0.4rem">
          {!readClosed ? <Button disabled={busy} data-action="core.files.openRead" onClick={prepare}>{readIntent ? "Retry exact read preparation" : "Prepare file download"}</Button> : <Button disabled={busy} onClick={() => { setReadIntent(null); setRead(null); setReadClosed(false); setDownloadStatus(null); }}>Choose a new read operation</Button>}
          {read && !readClosed ? <Button disabled={busy} data-action="core.files.cancelRead" onClick={closeRead}>Close this read</Button> : null}
        </Cluster>
        {read && !readClosed && read.transfer.state === "reading" && !failure ? <ByteDownload label="Download verified file bytes" filename={read.file.name}
          source={{ pluginId: FILES_ID, carrierId: "read", transferId: read.transfer.transferId, ref: read.file.ref, bytes: read.file.bytes, sha256: read.file.sha256 }}
          disabled={busy} onChange={(status) => setDownloadStatus(status.state === "downloading" ? `${status.received}/${status.total} bytes received` : status.state === "complete" ? "Verified bytes delivered to the browser. Whether the user saved them is not observable." : `Download unavailable: ${status.reason}. Close/reconcile this read before choosing a new one.`)} /> : null}
        {read ? <Text wrap tone="muted">Read state {read.transfer.state}; transfer {read.transfer.transferId}; reported expiry {new Date(read.transfer.expiresAt).toLocaleString()}.</Text> : null}
        {downloadStatus ? <Text wrap role="status">{downloadStatus}</Text> : null}
      </Stack>
      <FileAudience host={host} reference={reference} />
      <Button disabled={deliveryActive} onClick={() => onDeliver(file)}>Review delivery to a machine</Button>
    </> : <Text wrap tone="muted">No currently authorized metadata is displayed. Refresh to retry; an unavailable file is not evidence that it never existed.</Text>}
    <Stack gap="0.35rem">
      <Text strong>Logical deletion is separate from removing a reference</Text>
      <Text wrap>Removing a canvas reference leaves this library file and other references intact. Logical deletion makes future reads unavailable everywhere, but does not erase downloaded bytes, independent machine copies, scene history or backups.</Text>
      {armed ? <Text wrap tone="danger" role="alert">Confirm destructive logical deletion of this exact file. This cannot be undone by restoring a canvas reference.</Text> : null}
      <Cluster gap="0.4rem">
        <Button disabled={busy} tone="danger" data-action="core.files.delete" onClick={() => { if (armed) remove(false); else setArmed(true); }}>{armed ? "Confirm logical deletion" : "Review logical deletion"}</Button>
        {armed ? <Button disabled={busy} onClick={() => setArmed(false)}>Keep file</Button> : null}
        {deleteAttempted ? <Button disabled={busy} data-action="core.files.receipt" onClick={() => remove(true)}>Reconcile deletion receipt</Button> : null}
      </Cluster>
      {deleteAttempted && !deleted ? <Text wrap tone="muted">A failed/lost acknowledgement does not prove deletion failed. Reconcile the original credential's terminal receipt; do not infer success.</Text> : null}
    </Stack>
  </Stack>;
}

function FileAudience({ host, reference }: { host: PortableHostServices; reference: PluginOwnedRef }): ReactElement {
  const [page, setPage] = useState<RestrictedAudiencePage | null>(null);
  const [after, setAfter] = useState<string | undefined>(undefined);
  const [principalId, setPrincipalId] = useState("");
  const [retired, setRetired] = useState<RestrictedGrantView | null>(null);
  const [decision, setDecision] = useState<ReferenceGrantRequest | null>(null);
  const [revoke, setRevoke] = useState<RestrictedGrantView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const gate = useRef(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const work = async (run: () => Promise<void>): Promise<void> => {
    if (gate.current) return;
    gate.current = true; setBusy(true); setFailure(null);
    try { await run(); }
    catch (error) { if (live.current) setFailure(fileFailure(error)); }
    finally { gate.current = false; if (live.current) setBusy(false); }
  };
  const load = async (cursor?: string): Promise<void> => {
    setPage(null);
    const value = await fileAction(host, "audience", { ref: reference, ...(cursor ? { after: cursor } : {}), limit: 32 }, RestrictedAudiencePageSchema);
    if (live.current) { setPage(value); setAfter(cursor); }
  };
  const applyShare = (): void => {
    if (!decision) return;
    void work(async () => {
      setPage(null);
      const value = await fileAction(host, "share", decision, RestrictedGrantViewSchema);
      setNotice(`Named read decision ${value.grantId} is ${value.active ? "active" : "retired, not active"}. Effective access with a particular credential is not implied.`);
      setDecision(null); setRetired(null); setPrincipalId("");
      await load(after);
    });
  };
  const applyRevoke = (): void => {
    if (!revoke) return;
    void work(async () => {
      setPage(null);
      const value = await fileAction(host, "unshare", { ref: reference, grantId: revoke.grantId }, RestrictedGrantResultSchema);
      setNotice(`Selected sharing decision revoked. Other administered principal read authority ${value.principalReadAllowed ? "remains" : "was not found"}; credential access was not evaluated. Independent downloaded bytes are unchanged.`);
      setRevoke(null); await load(after);
    });
  };
  return <Stack gap="0.4rem">
    <Text strong>Named read audience</Text>
    <Text wrap tone="muted">Creator-only by default. These are explicit selected read shares, not an assertion of anyone's effective credential access. Creator/administrator rights are not editable here. Retired decisions are not active access.</Text>
    <Cluster gap="0.4rem">
      <Button disabled={busy} data-action="core.files.audience" onClick={() => { void work(() => load()); }}>Review first audience page</Button>
      {page?.next ? <Button disabled={busy} data-action="core.files.audience" onClick={() => { const next = page.next; if (next) void work(() => load(next)); }}>Next audience page</Button> : null}
    </Cluster>
    {page ? <Stack gap="0.25rem">
      {page.shares.length === 0 ? <Text wrap>No named share rows in this authorized page. This is not a total effective-access inventory.</Text> : page.shares.map((share) => <Cluster key={share.grantId} gap="0.4rem">
        <Text wrap>{share.principalId} · {share.active ? "active selected read" : "retired — no selected read"} · {share.grantId}</Text>
        <Button disabled={busy || decision !== null || revoke !== null} onClick={() => {
          if (share.active) { setRevoke(share); setDecision(null); }
          else { setPrincipalId(share.principalId); setRetired(share); setDecision(null); }
        }}>{share.active ? "Review revoke" : "Select deliberate re-share"}</Button>
      </Cluster>)}
    </Stack> : <Text wrap tone="muted">Audience has not been read, or is unavailable. Do not assume that no shares exist.</Text>}
    <Input label="Exact named principal ID (not a class, name or token)" value={principalId} disabled={busy || decision !== null || revoke !== null} mono onChange={(value) => { setPrincipalId(value); setRetired(null); }} />
    {retired ? <Text wrap>Deliberate re-share replaces only retired decision {retired.grantId} for {retired.principalId}.</Text> : <Text wrap tone="muted">A first share uses previousGrantId=null. If this principal already has a retired decision, select that exact audience row; a stale initial decision must conflict, never restore access.</Text>}
    <Button disabled={busy || !page || principalId.length === 0 || principalId.length > 128 || decision !== null || revoke !== null} onClick={() => {
      setDecision({ ref: reference, principalId, caps: [FILE_READ], previousGrantId: retired?.grantId ?? null }); setNotice(null);
    }}>Review exact named read grant</Button>
    {decision ? <Stack gap="0.3rem">
      <Text wrap>Confirm only {decision.principalId} may receive {FILE_READ} on this file. Previous decision: {decision.previousGrantId ?? "none"}. No canvas viewers or classes are added.</Text>
      <Cluster gap="0.4rem">
        <Button disabled={busy} data-action="core.files.share" onClick={applyShare}>Confirm / retry this exact sharing decision</Button>
        <Button disabled={busy} onClick={() => setDecision(null)}>Withdraw this local proposal</Button>
      </Cluster>
    </Stack> : null}
    {revoke ? <Stack gap="0.3rem">
      <Text wrap>Revoke exact selected grant {revoke.grantId} for {revoke.principalId}? Other grants and independent copies remain.</Text>
      <Cluster gap="0.4rem">
        <Button disabled={busy} tone="danger" data-action="core.files.unshare" onClick={applyRevoke}>Confirm / retry exact revocation</Button>
        <Button disabled={busy} onClick={() => setRevoke(null)}>Keep sharing decision</Button>
      </Cluster>
    </Stack> : null}
    {notice ? <Text wrap role="status">{notice}</Text> : null}
    {failure ? <Text wrap tone="danger" role="alert">{failure} Refresh the audience to see canonical active/retired state. Retrying keeps the same decision and retired ID.</Text> : null}
  </Stack>;
}
