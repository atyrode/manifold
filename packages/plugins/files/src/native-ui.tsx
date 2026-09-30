import type { PortableHostServices } from "@manifold/plugin";
import {
  NativeTransferDescriptionSchema,
  type MachineSummary,
  type NativeTransferDescription,
  type NativeTransferReceipt,
} from "@manifold/protocol";
import { Button, ByteDownload, Cluster, Input, Select, Stack, Text } from "@manifold/ui";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { z } from "zod";
import {
  BeginFileDeliverySchema,
  BeginFileDownloadSchema,
  createFileRequestId,
  FileNativeResultSchema,
  FileNativeReceiptSchema,
  FILES_ID,
  type FileDescriptor,
} from "./contract.ts";
import {
  fileAction,
  fileFailure,
  FilesActionError,
  type FileActionName,
} from "./browser-actions.ts";
import { verifiedDeliveryReceipt } from "./delivery-receipt.ts";

type Delivery = z.output<typeof BeginFileDeliverySchema>;
type Download = z.output<typeof BeginFileDownloadSchema>;
type NativeResult = z.output<typeof FileNativeResultSchema>;

/** No shell, filesystem browser, automatic continuation or replacement request. */
export function NativeFileTransfer({
  host,
  file,
  onClose,
  suggestedMachineId,
  renderDelivered,
}: {
  host: PortableHostServices;
  file?: FileDescriptor | undefined;
  onClose?: (() => void) | undefined;
  suggestedMachineId?: string | undefined;
  renderDelivered?: ((receipt: NativeTransferReceipt) => ReactNode) | undefined;
}): ReactElement {
  const delivery = file !== undefined;
  const [machines, setMachines] = useState<readonly MachineSummary[]>([]);
  const [machineId, setMachineId] = useState<string | null>(null);
  const [description, setDescription] = useState<NativeTransferDescription | null>(null);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [intent, setIntent] = useState<Delivery | Download | null>(null);
  const [result, setResult] = useState<NativeResult | null>(null);
  const [receipt, setReceipt] = useState<z.output<typeof FileNativeReceiptSchema> | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [commitAttempted, setCommitAttempted] = useState(false);
  const [browserStatus, setBrowserStatus] = useState<string | null>(null);
  const gate = useRef(false);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const operate = async (work: () => Promise<void>): Promise<void> => {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await work();
    } catch (error) {
      if (mounted.current) {
        setFailure(fileFailure(error));
        // A later denial says nothing about an earlier unacknowledged effect.
        // Only an authoritative result or receipt can reconcile that uncertainty.
        setUncertain((prior) => prior || !(error instanceof FilesActionError) || error.uncertain);
      }
    } finally {
      gate.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const refreshMachines = (): void => {
    void operate(async () => {
      const rows = await host.client.machines();
      if (mounted.current) setMachines(rows);
    });
  };
  useEffect(() => {
    let live = true;
    void host.client.machines().then(
      (rows) => {
        if (live) setMachines(rows);
      },
      () => {
        if (live) setFailure("Machine roster unavailable. Refresh before selecting a destination.");
      },
    );
    return () => {
      live = false;
    };
  }, [host.client]);

  const selectedMachine = machines.find(
    (machine) => machine.id === machineId && machine.online && !machine.revoked,
  );
  const location = description?.locations.find((row) => row.locationId === locationId);
  const requiredAccess = delivery ? "create-child" : "read";
  const describe = (): void => {
    if (!machineId || !selectedMachine || intent) return;
    setDescription(null);
    setLocationId(null);
    void operate(async () => {
      const review = await fileAction(
        host,
        "describeMachine",
        { machine: { kind: "machine", machineId } },
        NativeTransferDescriptionSchema,
      );
      if (mounted.current) {
        setDescription(review);
        setUncertain(false);
      }
    });
  };
  const begin = (): void => {
    void operate(async () => {
      let request = intent;
      if (!request) {
        if (
          !description ||
          !location?.available ||
          !location.access.includes(requiredAccess) ||
          !selectedMachine
        ) {
          throw new FilesActionError(
            "Select an online machine and an available reviewed location.",
          );
        }
        const common = {
          requestId: createFileRequestId(),
          machine: { kind: "machine" as const, machineId: description.machineId },
          location: {
            kind: "location" as const,
            machineId: description.machineId,
            locationId: location.locationId,
          },
          installationRevision: description.installationRevision,
          artifactSha256: description.artifactSha256,
          locationId: location.locationId,
          locationRevision: location.locationRevision,
        };
        const parsed = file
          ? BeginFileDeliverySchema.safeParse({ ...common, ref: file.ref, filename: name })
          : BeginFileDownloadSchema.safeParse({ ...common, relativePath: name.split("/") });
        if (!parsed.success)
          throw new FilesActionError(
            delivery
              ? "Enter one exact filename, not a path. No overwrite or automatic suffix is allowed."
              : "Enter an exact relative path of regular filename components. Absolute paths, empty components and traversal are refused.",
          );
        request = parsed.data;
        setIntent(request);
      }
      const next = await fileAction(
        host,
        delivery ? "beginDelivery" : "beginDownload",
        request,
        FileNativeResultSchema,
      );
      if (mounted.current) {
        setResult(next);
        setReceipt(null);
        setUncertain(false);
      }
    });
  };
  const continuation = (action: FileActionName): void => {
    if (!intent || !result) return;
    if (action === "commitDelivery") setCommitAttempted(true);
    const args = {
      machine: intent.machine,
      location: intent.location,
      transferId: result.transfer.transferId,
      ...("ref" in intent ? { ref: intent.ref } : {}),
    };
    void operate(async () => {
      const next = await fileAction(host, action, args, FileNativeResultSchema);
      if (mounted.current) {
        setResult(next);
        setReceipt(null);
        setUncertain(false);
      }
    });
  };
  const reconcileReceipt = (): void => {
    if (!intent) return;
    void operate(async () => {
      const next = await fileAction(
        host,
        "receiptNative",
        { requestId: intent.requestId },
        FileNativeReceiptSchema,
      );
      if (mounted.current) {
        setReceipt(next);
        setUncertain(next.state === "outcome_unknown");
      }
    });
  };
  const state = receipt?.state ?? result?.transfer.state;
  const terminal =
    state !== undefined &&
    ["completed", "cancelled", "failed", "expired", "refused"].includes(state);
  const unknown = uncertain || state === "outcome_unknown" || state === "publishing";
  const canAdvance =
    !terminal &&
    result?.transfer.state === "receiving" &&
    result.transfer.offset < result.transfer.bytes &&
    !unknown &&
    !commitAttempted;
  const canCommit =
    !terminal &&
    result !== null &&
    result.transfer.offset === result.transfer.bytes &&
    ["receiving", "verifying"].includes(result.transfer.state) &&
    !unknown &&
    !commitAttempted;
  const native = result?.native;
  const snapshotReady =
    !delivery &&
    !failure &&
    !unknown &&
    native?.state === "ready" &&
    native.sha256 !== undefined &&
    native.receipt !== undefined &&
    result?.transfer.state === "reading";
  const verified =
    !failure && !unknown && state === "completed" && file && intent && "ref" in intent && result
      ? verifiedDeliveryReceipt(file, intent, result)
      : null;

  return (
    <Stack gap="0.5rem">
      <Text strong>
        {delivery ? "Deliver an independent machine copy" : "Download an exact machine file"}
      </Text>
      {file ? (
        <Text wrap>
          Source {file.name} · {file.bytes} bytes. Delivery remains visible if library selection
          changes or this source is deleted.
        </Text>
      ) : null}
      <Text wrap tone="muted">
        {delivery
          ? "Exclusive named-child creation in a reviewed managed location only. No overwrite, automatic suffix, shell or automatic terminal insertion. A committed remote copy is independent of library deletion."
          : "A stable regular-file snapshot under a separately approved read root. No filesystem browsing and no implicit library retention. Unsupported or changing sources refuse."}
      </Text>
      {delivery ? (
        <Text wrap tone="muted">
          Managed roots are private to the native owner's OS UID. The application normally needs the
          same UID to access this path. Machine enrollment and PTY control do not prove application
          access. No mode or ownership change is performed; a differently privileged application
          requires a separately reviewed destination policy.
        </Text>
      ) : null}
      {suggestedMachineId ? (
        <Text wrap tone="muted">
          Terminal owner suggestion: {suggestedMachineId}. Choose the actual enrolled destination
          below. Nested SSH does not change this authority or prove where the application runs.
        </Text>
      ) : null}
      <Cluster gap="0.4rem">
        <Select
          label="Known online machine"
          value={machineId}
          disabled={busy || intent !== null}
          options={machines
            .filter((machine) => machine.online && !machine.revoked)
            .map((machine) => ({ value: machine.id, label: `${machine.name} (${machine.id})` }))}
          onChange={(value) => {
            setMachineId(value);
            setDescription(null);
            setLocationId(null);
          }}
        />
        <Button disabled={busy || intent !== null} onClick={refreshMachines}>
          Refresh machines
        </Button>
        <Button
          disabled={busy || intent !== null || !selectedMachine}
          data-action="core.files.describeMachine"
          onClick={describe}
        >
          Review installed pins and consent
        </Button>
      </Cluster>
      {description ? (
        <Stack gap="0.25rem">
          <Text wrap mono>
            Machine {description.machineId} · owner {description.ownerId} generation{" "}
            {description.ownerGeneration}
          </Text>
          <Text wrap mono>
            Installation revision {description.installationRevision}
          </Text>
          <Text wrap mono>
            Reviewed artifact SHA-256 {description.artifactSha256}
          </Text>
          <Select
            label={delivery ? "Exclusive create-child location" : "Approved read-root location"}
            value={locationId}
            disabled={busy || intent !== null}
            options={description.locations
              .filter((row) => row.access.includes(requiredAccess))
              .map((row) => ({
                value: row.locationId,
                label: `${row.locationId} · revision ${row.locationRevision} · ${row.available ? "available" : (row.reason ?? "unavailable")}`,
              }))}
            onChange={setLocationId}
          />
          {location ? (
            <Text wrap>
              {location.available
                ? "Reviewed location available; current authority and consent are rechecked for every continuation."
                : `Location refused: ${location.reason ?? "unavailable"}.`}{" "}
              Manage consent in the existing plugin manager, not here.
            </Text>
          ) : null}
          {description.locations.filter(
            (row) => row.access.includes(requiredAccess) && row.available,
          ).length === 0 ? (
            <Text wrap tone="danger">
              This machine has no approved available destination for this operation. Select another
              enrolled machine or review consent in the plugin manager; no path can be invented.
            </Text>
          ) : null}
          <Input
            label={
              delivery ? "Exact exclusive filename" : "Exact relative path below this read root"
            }
            value={name}
            disabled={busy || intent !== null}
            mono
            onChange={setName}
          />
          {name ? (
            <Text wrap>
              Review: {description.machineId} / {locationId ?? "no location"} / {name}
            </Text>
          ) : null}
        </Stack>
      ) : (
        <Text wrap tone="muted">
          Review is required. Missing installation, consent, owner support or location binding will
          be shown as a refusal.
        </Text>
      )}
      {intent ? (
        <Text wrap mono>
          Exact request {intent.requestId}; location {intent.locationId} revision{" "}
          {intent.locationRevision}. Pins and path remain immutable for retries.
        </Text>
      ) : null}
      {result ? (
        <>
          <Text wrap role="status">
            {state} · {result.transfer.offset}/{result.transfer.bytes} bytes acknowledged · transfer{" "}
            {result.transfer.transferId}
          </Text>
          <Text wrap tone="muted">
            Reported transfer expiry: {new Date(result.transfer.expiresAt).toLocaleString()}. Expiry
            never proves placement or deletion.
          </Text>
          {result.transfer.reason || native?.reason ? (
            <Text wrap tone="danger">
              {native?.reason ?? result.transfer.reason}
            </Text>
          ) : null}
        </>
      ) : null}
      {unknown ? (
        <Text wrap tone="danger" role="alert">
          Outcome unknown. Do not create a replacement, retry commit, infer success from expiry, or
          remove a possible destination. Reconcile this exact operation.
        </Text>
      ) : null}
      {failure ? (
        <Text wrap tone="danger" role="alert">
          {failure}
        </Text>
      ) : null}
      {verified ? (
        <Stack gap="0.25rem">
          <Text wrap role="status">
            file delivered; application consumption unknown
          </Text>
          <Text wrap mono>
            {verified.path}
          </Text>
          <Text wrap mono>
            Actual machine {verified.machineId} · location {verified.locationId} revision{" "}
            {verified.locationRevision} · owner {verified.ownerId} generation{" "}
            {verified.ownerGeneration}
          </Text>
          <Text wrap mono>
            {verified.bytes} bytes · SHA-256 {verified.sha256}
          </Text>
          {renderDelivered?.(verified)}
        </Stack>
      ) : null}
      {receipt ? (
        <Text wrap>
          Credential-bound terminal evidence: {receipt.state}. This status-only receipt discloses no
          destination or file metadata.
        </Text>
      ) : null}
      <Cluster gap="0.4rem">
        {!result && !terminal ? (
          <Button
            disabled={
              busy || (!intent && (!location?.available || !selectedMachine || name.length === 0))
            }
            data-action={delivery ? "core.files.beginDelivery" : "core.files.beginDownload"}
            onClick={begin}
          >
            {intent
              ? "Retry exact begin request"
              : delivery
                ? "Deliver to machine"
                : "Prepare reviewed snapshot"}
          </Button>
        ) : null}
        {canAdvance ? (
          <Button
            disabled={busy}
            data-action="core.files.advanceDelivery"
            onClick={() => continuation("advanceDelivery")}
          >
            Send next bounded chunk
          </Button>
        ) : null}
        {canCommit ? (
          <Button
            disabled={busy}
            data-action="core.files.commitDelivery"
            onClick={() => continuation("commitDelivery")}
          >
            Confirm exclusive placement
          </Button>
        ) : null}
        {result ? (
          <Button
            disabled={busy}
            data-action={delivery ? "core.files.inspectDelivery" : "core.files.inspectDownload"}
            onClick={() => continuation(delivery ? "inspectDelivery" : "inspectDownload")}
          >
            Reconcile exact transfer
          </Button>
        ) : null}
        {intent ? (
          <Button
            disabled={busy}
            data-action="core.files.receiptNative"
            onClick={reconcileReceipt}
          >
            Reconcile terminal evidence only
          </Button>
        ) : null}
        {result && !terminal && !unknown ? (
          <Button
            disabled={busy}
            data-action={delivery ? "core.files.cancelDelivery" : "core.files.cancelDownload"}
            onClick={() => continuation(delivery ? "cancelDelivery" : "cancelDownload")}
          >
            {delivery ? "Cancel incomplete delivery" : "Release snapshot"}
          </Button>
        ) : null}
        {(terminal && !unknown) || (!result && intent && failure && !uncertain) ? (
          <Button
            disabled={busy}
            onClick={() => {
              setIntent(null);
              setResult(null);
              setReceipt(null);
              setDescription(null);
              setLocationId(null);
              setCommitAttempted(false);
              setBrowserStatus(null);
              setFailure(null);
              setUncertain(false);
            }}
          >
            Review a new deliberate operation
          </Button>
        ) : null}
        {onClose && !unknown && (!intent || terminal) ? (
          <Button disabled={busy} onClick={onClose}>
            Close delivery review
          </Button>
        ) : null}
      </Cluster>
      {snapshotReady && result && native?.sha256 ? (
        <ByteDownload
          label="Download verified machine snapshot"
          filename={name.split("/").at(-1) || "file"}
          source={{
            pluginId: FILES_ID,
            carrierId: "download",
            transferId: result.transfer.transferId,
            ref: result.transfer.ref,
            bytes: native.bytes,
            sha256: native.sha256,
          }}
          disabled={busy}
          onChange={(status) =>
            setBrowserStatus(
              status.state === "downloading"
                ? `${status.received}/${status.total} bytes received`
                : status.state === "complete"
                  ? "Verified bytes delivered to the browser. A user save is not observable; no library file was created."
                  : `Download unavailable: ${status.reason}`,
            )
          }
        />
      ) : null}
      {browserStatus ? (
        <Text wrap role="status">
          {browserStatus}
        </Text>
      ) : null}
    </Stack>
  );
}
