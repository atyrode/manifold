import type { PluginActionContext, PluginReferenceContext } from "@manifold/plugin";
import { FileDescriptorSchema, FILES_ID } from "@manifold-plugin/files/contract";
import { formatManifoldUri, type ReferenceAttachmentResult } from "@manifold/protocol";
import { AttachFileImageInputSchema, imageCropPatch, type AttachFileImageInput } from "./index.ts";

export interface FilesImagesContext {
  readonly actions: PluginActionContext;
  readonly references: Pick<PluginReferenceContext, "attach">;
}

export const filesImagesHandlers = {
  async attach(ctx: FilesImagesContext, input: AttachFileImageInput): Promise<ReferenceAttachmentResult> {
    const args = AttachFileImageInputSchema.parse(input);
    // The parent door runs with the original caller. The child authors no foreign capability.
    const file = FileDescriptorSchema.parse(await ctx.actions.call({
      plugin: FILES_ID, action: "inspect", input: { ref: args.ref },
    }));
    if (file.image === null) throw new Error("unsupported_image: this file is not a validated static image");
    // Readiness, current caller read, exact scene authority, discipline and child schema
    // are rechecked by the host at its canonical document commit, after the inspect await.
    return ctx.references.attach({
      ref: args.ref, target: args.target, discipline: "canvas", referenceProperty: "file",
      element: {
        id: args.elementId, type: "file_image", x: args.x, y: args.y,
        width: args.width, height: args.height, zIndex: args.zIndex,
        file: formatManifoldUri(args.ref), ...imageCropPatch(args.crop),
      },
    });
  },
};
