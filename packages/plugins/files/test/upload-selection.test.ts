import { expect, test } from "bun:test";
import type { PortableHostServices } from "@manifold/plugin";
import { FileUploadController } from "../src/upload.ts";

test("local selection followed by Cancel never begins retention and cannot later be saved", async () => {
  const released: string[] = [];
  let effects = 0;
  const host = {
    localFiles: {
      read: async () => {
        effects += 1;
        throw new Error("Unexpected local read");
      },
      release: async (handle: string) => {
        released.push(handle);
      },
    },
    client: {
      action: async () => {
        effects += 1;
        throw new Error("Unexpected retention action");
      },
    },
  } as unknown as PortableHostServices;
  const controller = new FileUploadController(
    host,
    {
      handle: "local-selection",
      name: "dropped.bin",
      mediaType: "application/octet-stream",
      bytes: 12,
    },
    "file",
  );
  expect(controller.getSnapshot().phase).toBe("pending");
  await controller.cancel();
  expect(controller.getSnapshot().phase).toBe("cancelled");
  expect(controller.getSnapshot().savedRef).toBeNull();
  expect(await controller.save()).toBeNull();
  expect(effects).toBe(0);
  expect(released).toEqual(["local-selection"]);
  controller.dispose();
});

test("discarding a refused local intent releases custody and cannot resume it through a new selection", async () => {
  const released: string[] = [];
  const requests: string[] = [];
  const host = {
    localFiles: {
      read: async () => {
        throw new Error("Refused selection must not read bytes");
      },
      release: async (handle: string) => {
        released.push(handle);
      },
    },
    client: {
      action: async (_door: string, input: unknown) => {
        if (
          typeof input !== "object" ||
          input === null ||
          !("requestId" in input) ||
          typeof input.requestId !== "string"
        )
          throw new Error("Expected upload intent");
        requests.push(input.requestId);
        return { ok: false, denial: { rule: "refused", message: "expired" } };
      },
    },
  } as unknown as PortableHostServices;
  const old = new FileUploadController(
    host,
    { handle: "old", name: "old.bin", mediaType: "", bytes: 12 },
    "file",
  );
  await old.save();
  expect(old.getSnapshot()).toMatchObject({
    phase: "refused",
    transfer: null,
    savedRef: null,
    busy: false,
  });
  old.dispose();
  const next = new FileUploadController(
    host,
    { handle: "next", name: "next.bin", mediaType: "", bytes: 12 },
    "file",
  );
  expect(next.getSnapshot().requestId).not.toBe(old.getSnapshot().requestId);
  expect(released).toEqual(["old"]);
  expect(await old.save()).toBeNull();
  expect(requests).toEqual([old.getSnapshot().requestId]);
  expect(next.getSnapshot()).toMatchObject({ phase: "pending", transfer: null, savedRef: null });
  next.dispose();
  expect(released).toEqual(["old", "next"]);
});

test("retiring a selection ignores a late begin refusal while the replacement remains pending", async () => {
  const refusal = Promise.withResolvers<{ ok: false; denial: { rule: string; message: string } }>();
  const released: string[] = [];
  const host = {
    localFiles: {
      read: async () => {
        throw new Error("Retired selection must not read bytes");
      },
      release: async (handle: string) => {
        released.push(handle);
      },
    },
    client: { action: () => refusal.promise },
  } as unknown as PortableHostServices;
  const old = new FileUploadController(
    host,
    { handle: "retired", name: "old.bin", mediaType: "", bytes: 12 },
    "file",
  );
  const pending = old.save();
  old.dispose();
  const next = new FileUploadController(
    host,
    { handle: "replacement", name: "new.bin", mediaType: "", bytes: 12 },
    "file",
  );
  let notifications = 0;
  old.subscribe(() => {
    notifications += 1;
  });
  refusal.resolve({ ok: false, denial: { rule: "refused", message: "expired" } });
  await pending;
  expect(notifications).toBe(0);
  expect(released).toEqual(["retired"]);
  expect(next.getSnapshot()).toMatchObject({
    phase: "pending",
    transfer: null,
    savedRef: null,
    reason: null,
  });
  next.dispose();
});
