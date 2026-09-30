import { NativeTransferError, type PluginNativeTransferContext } from "@manifold/plugin";
import {
  NativeTransferBeginPutArgsSchema,
  NativeTransferBeginReadArgsSchema,
  NativeTransferDescribeArgsSchema,
  NativeTransferPutChunkArgsSchema,
  NativeTransferReadChunkArgsSchema,
  NativeTransferContinuationArgsSchema,
  NativeTransferReasonSchema,
  NativeTransferRecoverAdmissionArgsSchema,
} from "@manifold/protocol";
import { ServiceError, type AuthContext } from "./auth.ts";
import type { NativeTransferGuard, NativeTransferService } from "./native-transfer-service.ts";
import { ZodError } from "zod";

/** The real native channel, bound to host authority, never caller-supplied identity overrides. */
export function nativeTransferContext(
  service: () => NativeTransferService,
  auth: AuthContext,
  pluginId: string,
  guard: NativeTransferGuard,
): PluginNativeTransferContext {
  const caller = { auth, pluginId, guard };
  const invoke = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof NativeTransferError) {
        const known = NativeTransferReasonSchema.safeParse(error.reason);
        throw new NativeTransferError(known.success ? known.data : "native_transfer_unavailable");
      }
      if (error instanceof ZodError) throw new NativeTransferError("transfer_invalid_request");
      const reason =
        error instanceof ServiceError ? NativeTransferReasonSchema.safeParse(error.message) : null;
      if (reason?.success) throw new NativeTransferError(reason.data);
      throw new NativeTransferError("native_transfer_unavailable");
    }
  };
  return {
    describe: (args) =>
      invoke(() =>
        service().describe(caller, NativeTransferDescribeArgsSchema.parse(args).machineId),
      ),
    beginPut: (args) =>
      invoke(() =>
        service().begin(caller, { mode: "put", ...NativeTransferBeginPutArgsSchema.parse(args) }),
      ),
    putChunk: (args) =>
      invoke(() => service().putChunk(caller, NativeTransferPutChunkArgsSchema.parse(args))),
    commitPut: (args) =>
      invoke(() =>
        service().commitPut(caller, NativeTransferContinuationArgsSchema.parse(args).transferId),
      ),
    beginRead: (args) =>
      invoke(() =>
        service().begin(caller, { mode: "read", ...NativeTransferBeginReadArgsSchema.parse(args) }),
      ),
    readChunk: (args) =>
      invoke(() => service().readChunk(caller, NativeTransferReadChunkArgsSchema.parse(args))),
    cancel: (args) =>
      invoke(() =>
        service().cancel(caller, NativeTransferContinuationArgsSchema.parse(args).transferId),
      ),
    status: (args) =>
      invoke(() =>
        service().status(caller, NativeTransferContinuationArgsSchema.parse(args).transferId),
      ),
    receipt: (args) =>
      invoke(() =>
        service().receipt(caller, NativeTransferContinuationArgsSchema.parse(args).transferId),
      ),
    recoverAdmission: (args) =>
      invoke(() =>
        service().recoverAdmission(caller, NativeTransferRecoverAdmissionArgsSchema.parse(args)),
      ),
  };
}

/** A binary carrier cannot prepare, publish or cancel a transfer by forging a method name. */
export function readNativeTransferContext(
  service: () => NativeTransferService,
  auth: AuthContext,
  pluginId: string,
  guard: NativeTransferGuard,
): Pick<PluginNativeTransferContext, "readChunk" | "status"> {
  const bound = nativeTransferContext(service, auth, pluginId, guard);
  return { readChunk: bound.readChunk, status: bound.status };
}
