import { z } from "zod";
import { MachineOperationSchema } from "./jobs.ts";
import { SERVICE_FRAME_BYTES, ServiceCallSchema } from "./services.ts";

export const WORKER_CONTEXT_FD_ENV = "MANIFOLD_JOB_CONTEXT_FD";
export const WORKER_FRAME_BYTES = SERVICE_FRAME_BYTES;
export const WORKER_QUEUE_BYTES = 256 * 1024;
export const WORKER_MAX_PENDING = 32;

const location = MachineOperationSchema.shape.locations.element;
/** Owner-resolved locations, not worker-selected paths or resource grants. */
export const WorkerLocationSchema = z.strictObject({
  locationId: location.shape.locationId,
  guestPath: z
    .string()
    .min(1)
    .max(4096)
    .startsWith("/")
    .refine((path) => !path.includes("\0")),
  access: location.shape.access,
});
export const WorkerContextSchema = z
  .strictObject({
    type: z.literal("context"),
    locations: z
      .array(WorkerLocationSchema)
      .max(32)
      .refine(
        (locations) =>
          new Set(locations.map((entry) => entry.locationId)).size === locations.length,
      ),
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length + 1 <= WORKER_FRAME_BYTES,
  );

/** Readiness is a request to the owner, never a worker's grant of authority. */
export const ServiceReadySchema = z.strictObject({
  type: z.literal("service_ready"),
  requestId: ServiceCallSchema.shape.requestId,
  port: z.number().int().min(1).max(65535),
});
export const ServiceReadyRefusalSchema = z.enum([
  "service_unavailable",
  "service_ready_duplicate",
  "service_closed",
]);
export const ServiceReadyResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    type: z.literal("service_ready_result"),
    requestId: ServiceCallSchema.shape.requestId,
    ok: z.literal(true),
  }),
  z.strictObject({
    type: z.literal("service_ready_result"),
    requestId: ServiceCallSchema.shape.requestId,
    ok: z.literal(false),
    refusal: ServiceReadyRefusalSchema,
  }),
]);

export type WorkerLocation = z.infer<typeof WorkerLocationSchema>;
export type WorkerContextFrame = z.infer<typeof WorkerContextSchema>;
export type ServiceReady = z.infer<typeof ServiceReadySchema>;
export type ServiceReadyResult = z.infer<typeof ServiceReadyResultSchema>;
export type ServiceReadyRefusal = z.infer<typeof ServiceReadyRefusalSchema>;
