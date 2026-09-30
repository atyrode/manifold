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

export class PluginRefreshError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "PluginRefreshError";
  }
}
