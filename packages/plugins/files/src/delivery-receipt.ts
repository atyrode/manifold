import type { NativeTransferReceipt } from "@manifold/protocol";
import type { z } from "zod";
import {
  FILES_ID,
  type BeginFileDeliverySchema,
  type FileDescriptor,
  type FileNativeResultSchema,
} from "./contract.ts";

/** A status-only reconciliation or prepared candidate never supplies a usable path. */
export function verifiedDeliveryReceipt(
  file: FileDescriptor,
  intent: z.output<typeof BeginFileDeliverySchema>,
  result: z.output<typeof FileNativeResultSchema>,
): NativeTransferReceipt | null {
  const native = result.native;
  const receipt = native?.receipt;
  if (
    result.transfer.kind !== "delivery" ||
    result.transfer.state !== "completed" ||
    result.transfer.ref.kind !== "file" ||
    result.transfer.ref.fileId !== file.ref.fileId ||
    intent.ref.fileId !== file.ref.fileId ||
    native?.state !== "committed" ||
    native.mode !== "put" ||
    !receipt ||
    receipt.mode !== "put" ||
    receipt.transferId !== native.transferId ||
    receipt.pluginId !== FILES_ID ||
    receipt.machineId !== intent.machine.machineId ||
    receipt.requestId !== intent.requestId ||
    receipt.installationRevision !== intent.installationRevision ||
    receipt.artifactSha256 !== intent.artifactSha256 ||
    receipt.locationId !== intent.locationId ||
    receipt.locationRevision !== intent.locationRevision ||
    receipt.bytes !== file.bytes ||
    receipt.sha256 !== file.sha256 ||
    native.bytes !== receipt.bytes ||
    native.sha256 !== receipt.sha256 ||
    result.transfer.bytes !== file.bytes ||
    result.transfer.offset !== file.bytes
  )
    return null;
  return receipt;
}
