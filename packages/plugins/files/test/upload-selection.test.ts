import { expect, test } from "bun:test";
import type { PortableHostServices } from "@manifold/plugin";
import { FileUploadController } from "../src/upload.ts";

test("local selection followed by Cancel never begins retention and cannot later be saved", async () => {
  const released: string[] = [];
  let effects = 0;
  const host = {
    localFiles: {
      read: async () => { effects += 1; throw new Error("Unexpected local read"); },
      release: async (handle: string) => { released.push(handle); },
    },
    client: { action: async () => { effects += 1; throw new Error("Unexpected retention action"); } },
  } as unknown as PortableHostServices;
  const controller = new FileUploadController(host, { handle: "local-selection", name: "dropped.bin", mediaType: "application/octet-stream", bytes: 12 }, "file");
  expect(controller.getSnapshot().phase).toBe("pending");
  await controller.cancel();
  expect(controller.getSnapshot().phase).toBe("cancelled");
  expect(controller.getSnapshot().savedRef).toBeNull();
  expect(await controller.save()).toBeNull();
  expect(effects).toBe(0);
  expect(released).toEqual(["local-selection"]);
  controller.dispose();
});
