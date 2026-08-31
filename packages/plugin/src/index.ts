/**
 * The engine's platform-free half: composition, contracts, the default workspace. Anything
 * React lives behind `@manifold/plugin/hooks` instead, because the SERVER composes through
 * this same entry and must never pull a browser hook (or a DOM lib) into its type graph.
 */
export { defineAction, type ActionDef, type AnyActionDef } from "./action.ts";
export {
  CompositionError,
  composeRoster,
  type Composition,
  type CompositionAction,
  type CompositionElement,
  type CompositionPanel,
  type CompositionSection,
  type CompositionTool,
  type PluginDef,
} from "./compose.ts";
export { DEFAULT_WORKSPACE_LAYOUT } from "./layout.ts";
export {
  type HostServices,
  type PadViewportHandle,
  type PanelProps,
  type PlaceOutcome,
  type SectionProps,
  type SessionHandle,
} from "./host.ts";
