/**
 * `@manifold/plugin-kit` — the authoring kit for an ISOLATED plugin (ADR 0016).
 *
 * The root export is the pure half: the vocabulary builders, the two error classes and every
 * public type. The runtimes live behind their own doors so a bundle carries only the half it
 * runs — `@manifold/plugin-kit/server` (`defineServerPlugin`), `@manifold/plugin-kit/web`
 * (`defineWebPlugin`) — and the commands are `pack` (a directory to an artifact), `install` (an
 * artifact onto a hub), `dev` (pack and install on every change) and `verify` (artifacts against
 * a real spawned engine), each its own file under `src/` (issue #319).
 */
export { HostCallError, IsolateSliceUnavailable } from "./errors.ts";
export {
  ui,
  type BoxOptions,
  type ButtonOptions,
  type InputOptions,
  type SelectOptions,
  type TextOptions,
  type ToggleOptions,
  type UiNodeOf,
} from "./ui.ts";
export type {
  GuestAuth,
  GuestCtx,
  GuestEmit,
  GuestLifecycle,
  GuestLifecycleCtx,
  GuestPlaceOutcome,
  GuestStorage,
  ServerActionDef,
  ServerGuestTransport,
  ServerHandler,
  ServerPluginDef,
} from "./server.ts";
export type {
  GuestHost,
  GuestWebPlaceOutcome,
  OpenTerminalOptions,
  PanelEvent,
  PanelProgram,
  WebGuestPort,
  WebPluginDef,
} from "./web.ts";
export type { PackResult } from "./pack.ts";
