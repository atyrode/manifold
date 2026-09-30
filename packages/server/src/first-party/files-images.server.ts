import { defineServerPlugin } from "@manifold/plugin-kit/server";
import { filesImagesActions, filesImagesManifest } from "@manifold-plugin/files/images";
import { filesImagesHandlers } from "@manifold-plugin/files/images/server";

defineServerPlugin({
  manifest: filesImagesManifest,
  actions: filesImagesActions,
  handlers: filesImagesHandlers,
});
