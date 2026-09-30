import { defineAction } from "@manifold/plugin/action";
import {
  ByteImageCropSchema,
  PluginOwnedRefSchema,
  ReferenceAttachmentResultSchema,
  formatManifoldUri,
  parseManifoldUri,
  type ByteImageCrop,
  type PluginManifest,
} from "@manifold/protocol";
import { z } from "zod";

export const FILES_IMAGES_ID = "core.files.images";
export const FULL_IMAGE_CROP = { x: 0, y: 0, width: 1, height: 1 } as const;
export const FileImageElementSchema = z
  .strictObject({
    file: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => {
        const ref = parseManifoldUri(value);
        return ref?.kind === "file" && formatManifoldUri(ref) === value;
      }, "image source must be a canonical file reference"),
    cropX: z.number().finite(),
    cropY: z.number().finite(),
    cropWidth: z.number().finite(),
    cropHeight: z.number().finite(),
  })
  .refine((data) => ByteImageCropSchema.safeParse(imageCrop(data)).success, "invalid image crop");
export function imageCrop(data: {
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
}): ByteImageCrop {
  return { x: data.cropX, y: data.cropY, width: data.cropWidth, height: data.cropHeight };
}
/** Element payloads are flat scalars; all four fields change in one document transaction. */
export function imageCropPatch(crop: ByteImageCrop): {
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
} {
  return { cropX: crop.x, cropY: crop.y, cropWidth: crop.width, cropHeight: crop.height };
}
export const filesImagesElements = { file_image: FileImageElementSchema };
export const AttachFileImageInputSchema = z.strictObject({
  ref: PluginOwnedRefSchema,
  target: z.strictObject({ kind: z.literal("container"), containerId: z.string().min(1).max(128) }),
  elementId: z.string().min(1).max(128),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive().max(8192),
  height: z.number().finite().positive().max(8192),
  zIndex: z.number().int().default(0),
  crop: ByteImageCropSchema.default(FULL_IMAGE_CROP),
});
export type AttachFileImageInput = z.input<typeof AttachFileImageInputSchema>;
export const filesImagesActions = [
  defineAction({
    name: "attach",
    title: "Attach a readable saved image to this canvas",
    trace: "opaque",
    caps: ["scenes:write"],
    requirements: [{ cap: "scenes:write", target: ["target"] }],
    input: AttachFileImageInputSchema,
    result: ReferenceAttachmentResultSchema,
  }),
] as const;

export const filesImagesManifest: PluginManifest = {
  id: FILES_IMAGES_ID,
  version: "1.0.0",
  defaultEnabled: false,
  title: "Canvas images",
  description: "Independent file references with ordinary canvas arrangement and cropping.",
  capabilities: ["scenes:write"],
  dependencies: {
    "core.files": {
      type: "required",
      reason: "images reference private immutable files and use their owner's lifecycle",
    },
    "core.canvas": {
      type: "required",
      reason: "the image representation and insertion tool belong to the canvas",
    },
  },
  contributes: {
    panels: [{ id: "insert", title: "Insert image" }],
    sections: [],
    tools: [{ id: "image", title: "Image", toolbar: "canvas", panel: "insert" }],
    elements: [
      {
        type: "file_image",
        title: "Image",
        presentation: { canvas: "body", composition: "body" },
        placement: { groups: ["canvas_item"], guards: [], homed: "on_claim" },
      },
    ],
    events: [],
  },
  entry: { server: true, web: "web.js", worker: true },
};
