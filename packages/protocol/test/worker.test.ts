import { expect, test } from "bun:test";
import { ServiceReadySchema, ServiceReadyResultSchema, WorkerContextSchema } from "../src/worker.ts";

test("readiness names a port and correlation only, never authority or an endpoint", () => {
  const ready = { type: "service_ready", requestId: "ready-1", port: 4321 };
  expect(ServiceReadySchema.safeParse(ready).success).toBe(true);
  for (const port of [0, 65536, 1.5, "4321"])
    expect(ServiceReadySchema.safeParse({ ...ready, port }).success).toBe(false);
  for (const field of ["serviceId", "jobId", "principalId", "host", "url", "revision", "grant"])
    expect(ServiceReadySchema.safeParse({ ...ready, [field]: "injected" }).success).toBe(false);
  expect(ServiceReadySchema.safeParse({ type: "service_ready", port: 4321 }).success).toBe(false);
});

test("readiness acknowledgment requires a correlation and bounded named refusal, not raw owner diagnostics", () => {
  expect(ServiceReadyResultSchema.safeParse({ type: "service_ready_result", requestId: "ready-1", ok: true }).success).toBe(true);
  expect(ServiceReadyResultSchema.safeParse({ type: "service_ready_result", requestId: "ready-1", ok: false, refusal: "service_unavailable" }).success).toBe(true);
  for (const response of [
    { type: "service_ready_result", ok: true },
    { type: "service_ready_result", requestId: "ready-1", ok: false },
    { type: "service_ready_result", requestId: "ready-1", ok: true, grant: "injected" },
    { type: "service_ready_result", requestId: "ready-1", ok: false, refusal: "private owner exception" },
  ]) expect(ServiceReadyResultSchema.safeParse(response).success).toBe(false);
});

test("context locations are strict unique owner-resolved descriptors with bounded native paths", () => {
  const location = { locationId: "workspace", guestPath: "/locations/workspace", access: "write" };
  expect(WorkerContextSchema.safeParse({ type: "context", locations: [location] }).success).toBe(true);
  for (const locations of [
    [location, location],
    [{ ...location, access: "admin" }],
    [{ ...location, guestPath: "relative" }],
    [{ ...location, guestPath: "/private\0path" }],
    [{ ...location, guestPath: `/${"a".repeat(4096)}` }],
    [{ ...location, authority: "injected" }],
    Array.from({ length: 33 }, (_, i) => ({ ...location, locationId: `location-${i}` })),
  ]) expect(WorkerContextSchema.safeParse({ type: "context", locations }).success).toBe(false);
});
