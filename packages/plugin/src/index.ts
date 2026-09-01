/**
 * The engine's platform-free half: composition, contracts, the default workspace. Anything
 * that names React or a DOM type lives behind a subpath instead — `@manifold/plugin/hooks`
 * for browser plane mechanism, `@manifold/plugin/ui` for the plugin-facing standard library —
 * because the SERVER composes through this same entry and must never pull a browser hook (or
 * a DOM lib) into its type graph.
 */
export { defineAction, type ActionDef, type AnyActionDef } from "./action.ts";
export {
  bindingRebindRefusal,
  composeBindings,
  effectiveBindings,
  type BindingDef,
  type BindingKeyRow,
  type BindingScope,
  type BindingSource,
  type ComposedBinding,
  type WebBinding,
} from "./bindings.ts";
export {
  ENGINE_DISABLED_EVENT,
  ENGINE_ENABLED_EVENT,
  ENGINE_PLUGINS_ID,
  ENGINE_PURGED_EVENT,
  ENGINE_PURGE_ACTION,
  ENGINE_SET_ENABLED_ACTION,
  ENGINE_SET_SETTING_ACTION,
  enginePluginsActions,
  enginePluginsManifest,
} from "./builtin.ts";
export { emissionRefusal, emitterMayEmit, type EmitEvent } from "./emit.ts";
export { ITEM_NOUNS, itemNoun, itemNounPhrase } from "./item-noun.ts";
export {
  AssemblyError,
  assembleRoster,
  claim,
  panelRefId,
  reportDuplicates,
  rosterElementTraits,
  type Assembly,
  type AssemblyAction,
  type AssemblyEvent,
  type AssemblyElement,
  type AssemblyEnv,
  type AssemblyPanel,
  type AssemblySection,
  type AssemblySetting,
  type AssemblyTool,
  type Claims,
  type PluginAttribution,
  type PluginDef,
  type PluginStoredData,
} from "./assemble.ts";
export {
  composeSettings,
  settingRefId,
  settingValue,
  settingWriteRefusal,
  visibleSections,
  type ComposedSetting,
} from "./settings.ts";
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
export {
  DEFAULT_LAYOUT_CONDITIONS,
  DEFAULT_LAYOUT_NOTICES,
  composeDefaultLayout,
  type DefaultLayout,
  type DefaultLayoutCondition,
} from "./default-layout.ts";
export {
  UNPAINTED_EXTENT,
  arrangedSections,
  clusteredSections,
  panelSections,
  projectSectionArrangement,
  releasedSectionArrangement,
  sectionArrangementOf,
  withPanelSections,
  type SectionCluster,
  type SectionProjection,
  type SectionRelease,
} from "./layout.ts";
export { releasedTileLayout, tradedSeats, type TileRelease } from "./tile-release.ts";
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
  type ComposedPanel,
  type ComposedSection,
  type ElementDocument,
  type ElementHost,
  type ElementProps,
  type ElementTx,
  type FeedTopics,
  type HostServices,
  type AuthoringHandle,
  type TileGeometryHandle,
  type ViewportHandle,
  type PanelProps,
  type PlaceOutcome,
  type SectionProps,
  type SessionHandle,
  type SessionStatus,
} from "./host.ts";
