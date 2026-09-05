/**
 * THE ISOLATION RUNNER, BROWSER HALF (ADR 0016 §1 stage 1). Three pieces and one seam:
 * `WorkerHost` supervises one installed plugin's `Worker` and serves its `call` frames from
 * the panel's real host ref; `VocabularyRenderer` paints the protocol's closed component
 * vocabulary; `isolatedPanel` is the component the composition resolves for a panel whose
 * plugin arrived through `install` rather than through `WEB_PLUGIN_DEFS`. The registry's join
 * (`plugin-host.tsx`, `buildBrowserAssembly`) is the only consumer of that last name.
 */
export { isolatedPanel } from "./isolated-panel.tsx";
export { VocabularyRenderer, type VocabularyRendererProps } from "./vocabulary.tsx";
export {
  WORKER_GRACE_MS,
  WorkerHost,
  WorkerRegistry,
  webModulePath,
  type WorkerFactory,
  type WorkerHostDeps,
  type WorkerLease,
  type WorkerLike,
  type WorkerRegistryOptions,
} from "./worker-host.ts";
