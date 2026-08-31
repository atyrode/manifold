/**
 * The engine's platform-free half: composition, contracts, the default workspace. Anything
 * React lives behind `@manifold/plugin/hooks` instead, because the SERVER composes through
 * this same entry and must never pull a browser hook (or a DOM lib) into its type graph.
 */
export { defineAction, type ActionDef, type AnyActionDef } from "./action.ts";
export {
  ENGINE_PLUGINS_ID,
  ENGINE_PURGE_ACTION,
  ENGINE_SET_ENABLED_ACTION,
  enginePluginsActions,
  enginePluginsManifest,
} from "./builtin.ts";
export {
  CompositionError,
  composeRoster,
  type Composition,
  type CompositionAction,
  type CompositionElement,
  type CompositionEnv,
  type CompositionPanel,
  type CompositionSection,
  type CompositionTool,
  type PluginAttribution,
  type PluginDef,
  type PluginStoredData,
} from "./compose.ts";
export {
  LIFECYCLE_TIMEOUT_MS,
  runHook,
  type CompositionChangedHook,
  type CompositionDelta,
  type HookOutcome,
  type LifecycleCtx,
  type LifecycleHook,
  type PluginLifecycle,
} from "./lifecycle.ts";
export {
  DATA_VERSION_KEY,
  MAX_STORAGE_VALUE_BYTES,
  MIGRATION_KEY_PREFIX,
  PLUGIN_STORAGE_KEY_PATTERN,
  PluginStorageError,
  RESERVED_KEY_PREFIX,
  assertStorageKey,
  assertStorageValue,
  compareDataVersion,
  formatDataVersion,
  parseDataVersion,
  planDataMigration,
  type DataPlan,
  type PluginMigration,
  type PluginStorage,
  type PluginStorageAdmin,
} from "./storage.ts";
export { DEFAULT_WORKSPACE_LAYOUT } from "./layout.ts";
export {
  buildPadTree,
  projectPadTreeMove,
  samePadTreeItems,
  treeItemId,
  type PadTreeMove,
  type PadTreeNode,
} from "./pad-tree.ts";
export {
  type CompositionFacet,
  type HostServices,
  type PadAuthoringHandle,
  type PadViewportHandle,
  type PanelProps,
  type PlaceOutcome,
  type SectionProps,
  type SessionHandle,
} from "./host.ts";
