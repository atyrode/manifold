/**
 * THE ISOLATION RUNNER, BROWSER HALF. WorkerHost supervises either installed or first-party
 * hardened code and serves mounted calls through their live host. VocabularyRenderer paints
 * the shared UI primitives. Panels, sections and elements share the mounted-instance lifecycle;
 * buildBrowserAssembly selects execution mode from the server's effective roster fact.
 */
export { isolatedElement, isolatedPanel, isolatedSection } from "./isolated-panel.tsx";
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
