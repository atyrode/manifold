import {
  ENGINE_NAMESPACE_PREFIX,
  LocalNameSchema,
  PluginIdSchema,
  PluginPurgeResultSchema,
  type PluginManifest,
} from "@manifold/protocol";
import { z } from "zod";
import { defineAction, type AnyActionDef } from "./action.ts";

/**
 * THE ENGINE'S OWN DOORS — enablement and purge, published as a BUILTIN roster row.
 *
 * Administration of the composition cannot live inside the composition. A plugin owning
 * `setEnabled` can be disabled, and the moment it is, the door that would re-enable it
 * answers `plugin_disabled` to everyone including root: the workspace's composition freezes
 * short of editing SQLite by hand. The previous shape "solved" that with `essential: true`
 * on the plugin manager — a plugin made permanently undisableable to protect a mechanism
 * that should never have been in a plugin at all (ADR 0013 §11).
 *
 * So the door moves into the engine, and is published exactly like any other: same manifest
 * shape, same JSON-Schema vocabulary in `GET /api/protocol`, same roster row in
 * `GET /api/plugins`, same denial ladder. `source: "builtin"` is the ONLY difference a
 * reader sees, and it says one thing: this row has no toggle, because the thing that would
 * toggle it is itself.
 *
 * `core.plugins` keeps what it always should have owned — the manager UI — and becomes an
 * ordinary, disableable plugin. Losing it costs a section, not the ability to administer:
 * the door stays reachable over the API to any principal holding `plugins:manage`, and a
 * substitute manager UI can be enabled in its place.
 */
export const ENGINE_PLUGINS_ID = `${ENGINE_NAMESPACE_PREFIX}plugins`;

/*
 * There is deliberately no exported "builtin ids" table. The set of builtin rows is DERIVED
 * from the definitions the engine registers (`ENGINE_BUILTIN_DEFS` in the server host) and
 * handed to `assembleRoster` as `env.builtins`, so "builtin" stays a fact about who
 * registered a row rather than a claim a manifest could make about itself — and a second
 * list that could disagree with the first never exists (invariant 14).
 */

export const ENGINE_SET_ENABLED_ACTION = `${ENGINE_PLUGINS_ID}.setEnabled`;
export const ENGINE_PURGE_ACTION = `${ENGINE_PLUGINS_ID}.purge`;
export const ENGINE_SET_SETTING_ACTION = `${ENGINE_PLUGINS_ID}.setSetting`;

/**
 * THE ENGINE DOOR'S EVENT KINDS (ADR 0012). The enablement door is the one door the engine
 * owns outright, so it is the one place the engine declares a vocabulary of its own; every
 * other kind belongs to the plugin that owns the concept, and the floor door that commits the
 * change emits under THAT plugin's id. A manifest titled "Plugin engine" declaring
 * `terminal_exited` would be a category error — and, since a kind is claimed globally, it
 * would also lock the terminals plugin out of its own word.
 *
 * Three kinds, one per outcome the door has: a roster row turned on, turned off, or had its
 * data destroyed. They are the reason the plugin-manager section can stop polling the roster:
 * the `plugins` frame already pushes the new roster, and these say WHO did it and to WHAT.
 */
export const ENGINE_ENABLED_EVENT = "plugin_enabled";
export const ENGINE_DISABLED_EVENT = "plugin_disabled";
export const ENGINE_PURGED_EVENT = "plugin_purged";

export const enginePluginsManifest: PluginManifest = {
  id: ENGINE_PLUGINS_ID,
  version: "1.0.0",
  title: "Plugin engine",
  description:
    "The engine's own administration doors: workspace-global enablement, and the purge verb that destroys a disabled plugin's data.",
  capabilities: ["plugins:manage"],
  contributes: {
    panels: [],
    sections: [],
    elements: [],
    tools: [],
    events: [
      { id: ENGINE_ENABLED_EVENT, title: "Plugin enabled" },
      { id: ENGINE_DISABLED_EVENT, title: "Plugin disabled" },
      { id: ENGINE_PURGED_EVENT, title: "Plugin data purged" },
    ],
  },
};

/**
 * `setEnabled` is workspace-GLOBAL and hot: one principal with `plugins:manage` changes what
 * every principal's client composes, and the new roster is pushed rather than polled, so
 * nobody reloads to see it (D4).
 *
 * `purge` is the ONLY destructive verb. A disable retains everything (residual mechanism
 * `retain`), which is why destruction had to become a separate, explicitly named door rather
 * than a side effect nobody consented to; and it refuses while the plugin is still enabled,
 * because erasing the data of code that is currently running is not a state anyone asked
 * for. The refusal is `still_enabled`, and the remedy is one visible step: disable, then
 * purge.
 *
 * `setSetting` is the odd one out on this row, and deliberately so. THE OTHER TWO CHANGE THE
 * WORKSPACE; this one changes the CALLER — a value stored against their principal, over a
 * declaration some other plugin made. It is the engine's for the reason enablement is, applied
 * to the litmus a pillar is admitted by (AXIOMS.md §Foundation law):
 *
 *   BOOTSTRAP CIRCULARITY. The sidebar drops a row whose setting reads false before any plugin
 *     has drawn, so the values are composition input. A plugin owning the write door could be
 *     disabled, and then every OTHER plugin's preferences would be frozen — including the one
 *     that hid a row the reader now wants back. That is exactly the trap `setEnabled` was
 *     moved out of `core.plugins` to escape (ADR 0013 §11).
 *   NEUTRALITY. The door names no plugin and no preference: it takes a declaration's address
 *     and a value, over a vocabulary every manifest may extend. `core.plugins` renders the
 *     panes, and rendering them is precisely why it must not own the writes — a manager is one
 *     UI for a mechanism, and a stranger's manager gets the same door.
 *   ARBITRATION. The write is refused unless the assembly says that declaration exists
 *     (`settingWriteRefusal`), which is state no single plugin can see and the caller cannot be
 *     trusted to have read.
 *
 * So it is NOT the `core.keys` precedent, and the difference is worth naming: a key binding is
 * registration data `core.keys` itself composes and publishes — its own concept, its own door.
 * A setting is every OTHER plugin's concept, and the engine is the only party with no favourite
 * among them.
 *
 * `value: null` RETRACTS the opinion — the ref leaves the map and the row reads its manifest's
 * default again. One door rather than a `resetSetting` sibling, because "I have no opinion" is
 * a value this map can express and a second door would be a second way to write one map.
 *
 * It carries NO capability and emits NO event, and those are the same fact twice: nothing here
 * is anybody else's business. A preference is stored against the caller's own principal, so
 * there is no authority to grade beyond being someone, and broadcasting it would tell every
 * peer in the workspace which rows a reader keeps in their rail.
 */
export const enginePluginsActions: readonly AnyActionDef[] = [
  defineAction({
    name: "setEnabled",
    title: "Enable or disable a plugin",
    caps: ["plugins:manage"],
    input: z.strictObject({ id: PluginIdSchema, enabled: z.boolean() }),
    result: z.strictObject({}),
  }),
  defineAction({
    name: "purge",
    title: "Destroy a disabled plugin's stored data",
    caps: ["plugins:manage"],
    input: z.strictObject({ id: PluginIdSchema }),
    result: PluginPurgeResultSchema,
  }),
  defineAction({
    name: "setSetting",
    title: "Set one of your plugin settings",
    caps: [],
    input: z.strictObject({
      plugin: PluginIdSchema,
      setting: LocalNameSchema,
      value: z.boolean().nullable(),
    }),
    result: z.strictObject({}),
  }),
];
