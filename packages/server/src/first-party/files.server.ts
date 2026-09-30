import { defineServerPlugin } from "@manifold/plugin-kit/server";
import { filesActions, filesManifest } from "@manifold-plugin/files";
import {
  filesByteCarriers,
  filesHandlers,
  filesLifecycle,
  filesMigrations,
  filesProbeReady,
  filesReclaimReferences,
  filesReconcileNativeTransfers,
  filesPendingNativeTransfers,
} from "@manifold-plugin/files/server";

defineServerPlugin({
  manifest: filesManifest,
  actions: filesActions,
  handlers: filesHandlers,
  lifecycle: filesLifecycle,
  migrations: filesMigrations,
  byteCarriers: filesByteCarriers,
  probeReady: filesProbeReady,
  reclaimReferences: filesReclaimReferences,
  reconcileNativeTransfers: filesReconcileNativeTransfers,
  pendingNativeTransfers: filesPendingNativeTransfers,
});
