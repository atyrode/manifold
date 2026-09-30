import {
  defineServerAction,
  type GuestByteCarrierCtx,
  type GuestByteCarrierHandler,
  type GuestCtx,
} from "@manifold/plugin-kit/server";
import {
  ByteImageSourceSchema,
  ByteTransferError,
  type ByteCarrierRequest,
  type ByteImageSource,
} from "@manifold/protocol";
import { z } from "zod";

// A 48 × 24 checkerboard, served as real authenticated bytes rather than a data URL.
const raster = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAADAAAAAYCAYAAAC8/X7cAAAAVklEQVR4nO3PMQ0AIBAEwZeEEkoEowEttOCALygWki2u3OQmRi3rtNnbcXQf9AEB9AEB9AEB9IFrwOsHs14A3QugewF0/z/g9YNZL4DuBdC9ALr/HrAB/msUNV5a01YAAAAASUVORK5CYII=",
  "base64",
);
const leases = new Map<
  string,
  { readonly principalId: string; readonly credentialBinding: string; readonly expiresAt: number }
>();

export const rasterActions = [
  defineServerAction({
    name: "openRaster",
    title: "Open the reference raster",
    caps: ["containers:read"],
    input: z.strictObject({}),
    result: ByteImageSourceSchema,
  }),
  defineServerAction({
    name: "cancelRaster",
    title: "Cancel the reference raster read",
    caps: ["containers:read"],
    cleanup: true,
    input: z.strictObject({ transferId: z.string().uuid() }),
    result: z.strictObject({}),
  }),
];

export const rasterHandlers = {
  openRaster(ctx: GuestCtx): ByteImageSource | { refused: string } {
    for (const [id, lease] of leases) if (lease.expiresAt <= ctx.now()) leases.delete(id);
    if (leases.size >= 8) return { refused: "the reference raster has eight active readers" };
    const transferId = crypto.randomUUID();
    leases.set(transferId, {
      principalId: ctx.principal.id,
      credentialBinding: ctx.credentialBinding,
      expiresAt: ctx.now() + 60_000,
    });
    return {
      pluginId: ctx.pluginId,
      carrierId: "raster",
      transferId,
      ref: { kind: "plugin", pluginId: ctx.pluginId },
      bytes: raster.length,
      sha256: "6fc5d2536b2ce9802b13b301ac5bee0fb80ceab9e50e6bda5720198ed65bc2a7",
      mediaType: "image/png",
    };
  },
  cancelRaster(
    ctx: GuestCtx,
    args: { transferId: string },
  ): Record<string, never> | { refused: string } {
    const lease = leases.get(args.transferId);
    if (lease !== undefined) {
      if (
        lease.principalId !== ctx.principal.id ||
        lease.credentialBinding !== ctx.credentialBinding
      )
        return { refused: "the reference raster belongs to another reader" };
      leases.delete(args.transferId);
    }
    return {};
  },
};

function admission(ctx: GuestByteCarrierCtx, request: ByteCarrierRequest): number {
  ctx.assertCurrent();
  const lease = leases.get(request.transferId);
  if (
    lease === undefined ||
    lease.principalId !== ctx.principal.id ||
    lease.credentialBinding !== ctx.credentialBinding ||
    request.ref.kind !== "plugin" ||
    request.ref.pluginId !== ctx.pluginId ||
    request.offset + request.length > raster.length
  )
    throw new ByteTransferError("unavailable");
  if (lease.expiresAt <= ctx.now()) {
    leases.delete(request.transferId);
    throw new ByteTransferError("expired");
  }
  return lease.expiresAt;
}

export const rasterCarrier: GuestByteCarrierHandler = {
  direction: "outgoing",
  async authorize(ctx, request) {
    return { expiresAt: admission(ctx, request) };
  },
  async read(ctx, request) {
    const expiresAt = admission(ctx, request);
    return {
      offset: request.offset,
      data: raster.subarray(request.offset, request.offset + request.length),
      eof: request.offset + request.length === raster.length,
      leaseMs: Math.min(15_000, expiresAt - ctx.now()),
    };
  },
};

export function closeRasterReaders(): void {
  leases.clear();
}
