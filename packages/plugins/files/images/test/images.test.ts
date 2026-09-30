import { describe, expect, test } from "bun:test";
import { createSceneDoc, patchElement, readElement, writeElement } from "@manifold/scene";
import { ByteImageCropSchema, elementPayload, type ActionOutcome, type SceneElement } from "@manifold/protocol";
import { ImageAttachmentController } from "../src/attachment.ts";
import { FileImageElementSchema, FULL_IMAGE_CROP, imageCrop, imageCropPatch } from "../src/index.ts";

const ref = { kind: "file", fileId: "saved-image" } as const;
const descriptor = {
  ref, home: { kind: "root" }, ownerId: "creator", name: "image.png", declaredMediaType: "image/png",
  mediaType: "image/png", bytes: 200, sha256: "a".repeat(64), createdAt: 1,
  image: { mediaType: "image/png", width: 640, height: 480 },
};

function host(action: (door: string, input: unknown) => Promise<ActionOutcome>) {
  return { client: { action } };
}

describe("retained image attachment intent", () => {
  test("publication survives immediate metadata access loss and retries the same element", async () => {
    let readable = false;
    const attached: string[] = [];
    const controller = new ImageAttachmentController(host(async (door, input) => {
      if (door === "core.files.inspect") return readable
        ? { ok: true, result: descriptor }
        : { ok: false, denial: { rule: "forbidden", message: "reference_unavailable" } };
      const args = input as { elementId: string };
      attached.push(args.elementId);
      return { ok: true, result: { ref: { kind: "element", containerId: "canvas", elementId: args.elementId }, created: true } };
    }), ref, "canvas", { x: 20, y: 30 }, true);
    const elementId = controller.elementId;
    await controller.attach();
    expect(controller.getSnapshot()).toMatchObject({ phase: "refused", reason: "reference_unavailable" });
    expect(controller.published).toBe(true);
    expect(controller.ref).toEqual(ref);
    expect(attached).toEqual([]);
    readable = true;
    await controller.attach();
    expect(controller.getSnapshot().phase).toBe("attached");
    expect(attached).toEqual([elementId]);
    controller.dispose();
  });

  test("lost attachment acknowledgement cannot create another reference or reset moved geometry", async () => {
    const elements = new Map<string, { x: number }>();
    let loseReceipt = true;
    const controller = new ImageAttachmentController(host(async (door, input) => {
      if (door === "core.files.inspect") return { ok: true, result: descriptor };
      const args = input as { elementId: string; x: number };
      const created = !elements.has(args.elementId);
      if (created) elements.set(args.elementId, { x: args.x });
      if (loseReceipt) { loseReceipt = false; throw new Error("connection lost after commit"); }
      return { ok: true, result: { ref: { kind: "element", containerId: "canvas", elementId: args.elementId }, created } };
    }), ref, "canvas", { x: 20, y: 30 }, true);
    await controller.attach();
    expect(controller.getSnapshot().phase).toBe("refused");
    elements.get(controller.elementId)!.x = 400;
    await controller.attach();
    expect(controller.getSnapshot()).toMatchObject({ phase: "attached", result: { created: false } });
    expect([...elements.entries()]).toEqual([[controller.elementId, { x: 400 }]]);
    controller.dispose();
  });

  test("unmount while inspecting cannot author a late image", async () => {
    const gate = Promise.withResolvers<ActionOutcome>();
    let attaches = 0;
    const controller = new ImageAttachmentController(host(async (door) => {
      if (door === "core.files.inspect") return gate.promise;
      attaches += 1;
      throw new Error("unexpected late attach");
    }), ref, "canvas", { x: 0, y: 0 }, true);
    const pending = controller.attach();
    controller.dispose();
    gate.resolve({ ok: true, result: descriptor });
    await pending;
    expect(attaches).toBe(0);
  });
});

describe("ordinary image crop payload", () => {
  test("rejects empty, nonfinite, microscopic and out-of-image rectangles", () => {
    for (const crop of [
      { ...FULL_IMAGE_CROP, width: 0 }, { ...FULL_IMAGE_CROP, height: Number.MIN_VALUE },
      { ...FULL_IMAGE_CROP, x: -0.1 }, { ...FULL_IMAGE_CROP, x: 0.1 },
      { ...FULL_IMAGE_CROP, y: NaN }, { ...FULL_IMAGE_CROP, width: Infinity },
    ]) {
      expect(ByteImageCropSchema.safeParse(crop).success).toBe(false);
      expect(FileImageElementSchema.safeParse({ file: "manifold://file/saved-image", ...imageCropPatch(crop) }).success).toBe(false);
    }
  });

  test("crop is a flat document edit on only one independent reference", () => {
    const doc = createSceneDoc();
    try {
      const first: SceneElement = {
        id: "first", type: "file_image", x: 10, y: 20, width: 200, height: 100, zIndex: 0,
        file: "manifold://file/saved-image", ...imageCropPatch(FULL_IMAGE_CROP),
      };
      writeElement(doc, first, null);
      writeElement(doc, { ...first, id: "second", x: 300 }, null);
      const crop = { x: 0.25, y: 0, width: 0.5, height: 1 };
      expect(patchElement(doc, "first", imageCropPatch(crop), null)).toBe(true);
      const edited = readElement(doc, "first")!;
      const payload = FileImageElementSchema.parse(elementPayload(edited));
      expect(imageCrop(payload)).toEqual(crop);
      expect(edited).toMatchObject({ file: first.file, x: 10, y: 20, width: 200, height: 100 });
      expect(imageCrop(FileImageElementSchema.parse(elementPayload(readElement(doc, "second")!)))).toEqual(FULL_IMAGE_CROP);
    } finally { doc.destroy(); }
  });
});
