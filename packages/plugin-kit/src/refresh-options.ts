/** Pure CLI facts stay usable without the checkout-only frontend toolchain. */
export const PLUGIN_REFRESH_DESCRIPTION = {
  command: "manifold-dev <plugins-root> --fast-refresh --hub <origin> [--port <0..65535>]",
  mode: "frontend-source",
  binding: "127.0.0.1",
  authority: "existing browser identity, lens, session and installed-plugin admission",
  prerequisites: [
    "Manifold source checkout containing packages/web and its installed Vite toolchain; not a standalone published kit frontend",
    "development environment (NODE_ENV must not be production)",
    "existing explicit web.tsx or web.ts entry and validated matching installed manifest",
    "plugin installed, enabled and in-realm on the chosen hub",
    "ordinary browser sign-in admitted for this frontend; preview audience rules are unchanged",
  ],
  lifetime: "process-local; close(), SIGINT or SIGTERM removes source leases and closes Vite",
  changes: {
    web: "Vite HMR and React Refresh; compatible component and CSS edits retain mounted state",
    installation:
      "manifest, backend, native and dependency edits cancel the source until an explicit restart after installation",
  },
  credentials: "does not read an owner key or install/update a bundle",
  fallback:
    "authenticated packed definition and CSS retained by the browser before source admission",
} as const;

export const PLUGIN_WORKSHOP_DESCRIPTION = {
  command: "manifold-dev <plugins-root> --workshop --hub <origin> [--port <0..65535>] [--build-module <module>] [--deliver path|docker:<container>] [--owner-key-file <path>]",
  mode: "frontend-and-backend",
  binding: "127.0.0.1",
  authority: "explicit owner installation authority through the existing supported owner-key resolver; browser sign-in and installed-source admission remain separate",
  credentials: "reads only the supported owner-key file or delivery container; never mints, migrates or logs credentials",
  prerequisites: [
    ...PLUGIN_REFRESH_DESCRIPTION.prerequisites,
    "an existing matching in-realm installation for every discovered manifest",
    "same installed manifests, action declarations, dependency stamps and native members",
    "hub engine.plugins.install advertises the replacement-only retainInstallation pin argument",
  ],
  buildModule: "optional author-owned module exporting async pack(outputDir), using the normal full-family compiler before any install; compilation timeout is 60 seconds",
  changes: {
    frontend: "actual Vite HMR and compatible React Refresh; frontend-only saves never install bundles",
    backend: "compiler-observed transitive server inputs compile the entire family, replace only changed pins while retaining exact incumbent installation consent, then restart source transport for fresh installed-row admission",
    refused: "manifest, action/lifecycle authority, package/compiler configuration, dependency and native changes require explicit pack/verify/install review and workshop restart",
    failedBuild: "no family member is installed after a compiler failure; the existing backend keeps running and correction resumes",
  },
  proxy: "MANIFOLD_DEV_HOST retains the existing exact allowed host and TLS wss HMR configuration; no browser audience changes",
  readiness: "listening source transport only, not browser admission",
  lifetime: "SIGINT/SIGTERM waits for the serialized active cycle and closes only this workshop's watchers, source frontend, preparation children and temporary directory; an author callback has 5 seconds to finish after interruption, otherwise API rejects with compiler cleanup unconfirmed rather than claiming complete",
  fallback: PLUGIN_REFRESH_DESCRIPTION.fallback,
} as const;

export class PluginRefreshError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "PluginRefreshError";
  }
}
