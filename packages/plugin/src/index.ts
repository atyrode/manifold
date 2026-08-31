/**
 * The engine's platform-free half: composition, contracts, the default workspace. Anything
 * that names React or a DOM type lives behind a subpath instead — `@manifold/plugin/hooks`
 * for browser plane mechanism, `@manifold/plugin/ui` for the plugin-facing standard library —
 * because the SERVER composes through this same entry and must never pull a browser hook (or
 * a DOM lib) into its type graph.
 */
export { defineAction, type ActionDef, type AnyActionDef } from "./action.ts";
export {
  ENGINE_PLUGINS_ID,
  ENGINE_PURGE_ACTION,
  ENGINE_SET_ENABLED_ACTION,
  enginePluginsActions,
  enginePluginsManifest,
} from "./builtin.ts";
export { ITEM_NOUNS, itemNoun, itemNounPhrase } from "./item-noun.ts";
export {
  AssemblyError,
  assembleRoster,
  panelRefId,
  rosterElementTraits,
  type Assembly,
  type AssemblyAction,
  type AssemblyElement,
  type AssemblyEnv,
  type AssemblyPanel,
  type AssemblySection,
  type AssemblyTool,
  type PluginAttribution,
  type PluginDef,
  type PluginStoredData,
} from "./assemble.ts";
export {
  FLOOR_ELEMENT_PAYLOADS,
  elementPayloadGuard,
  elementPayloadRefusal,
  type ElementPayloadRefusal,
} from "./element-payload.ts";
export {
  LIFECYCLE_TIMEOUT_MS,
  runHook,
  type AssemblyChangedHook,
  type AssemblyDelta,
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
export { workspaceLayout, type WorkspacePanels } from "./layout.ts";
export {
  buildIndexTree,
  projectIndexMove,
  sameIndexEntries,
  treeItemId,
  type IndexMove,
  type IndexBranch,
} from "./index-tree.ts";
export {
  lastSpotlight,
  recordSpotlight,
  type AssemblyFacet,
  type ElementDocument,
  type ElementHost,
  type ElementProps,
  type ElementTx,
  type HostServices,
  type AuthoringHandle,
  type ViewportHandle,
  type PanelProps,
  type PlaceOutcome,
  type SectionProps,
  type SessionHandle,
} from "./host.ts";
