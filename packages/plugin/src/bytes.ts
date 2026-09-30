import type {
  ByteAdmission,
  ByteCarrierRequest,
  ByteReadChunk,
  ByteWriteReceipt,
  PluginOwnedRef,
  Principal,
  PublishedReferenceIdentity,
} from "@manifold/protocol";
import type { PluginDatabase } from "./database.ts";
import type { PluginNativeTransferContext } from "./runtime.ts";

/** Request-owned authority; none of the action, grant or publication mutation slices exist. */
export interface ByteCarrierContext {
  readonly pluginId: string;
  readonly principal: Principal;
  readonly credentialBinding: string;
  readonly signal: AbortSignal;
  readonly database?: PluginDatabase;
  readonly nativeTransfers: Pick<PluginNativeTransferContext, "readChunk" | "status">;
  now(): number;
  /** Check the local request lease; every host effect and response separately checks live authority. */
  assertCurrent(): void;
  /** Read-only publication/ready-identity check at this request's declared exact target. */
  requirePublished(ref: PluginOwnedRef): Promise<PublishedReferenceIdentity>;
}

export type ByteCarrierHandler =
  | {
      readonly direction: "incoming";
      /** Prove original scope before bytes; return its idle/absolute deadline to narrow host admission. */
      authorize(context: ByteCarrierContext, request: ByteCarrierRequest): Promise<ByteAdmission>;
      write(
        context: ByteCarrierContext,
        request: ByteCarrierRequest,
        data: Uint8Array,
      ): Promise<ByteWriteReceipt>;
    }
  | {
      readonly direction: "outgoing";
      authorize(context: ByteCarrierContext, request: ByteCarrierRequest): Promise<ByteAdmission>;
      read(context: ByteCarrierContext, request: ByteCarrierRequest): Promise<ByteReadChunk>;
    };
