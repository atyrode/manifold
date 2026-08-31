import {
  ENGINE_NAMESPACE_PREFIX,
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
 * handed to `composeRoster` as `env.builtins`, so "builtin" stays a fact about who
 * registered a row rather than a claim a manifest could make about itself — and a second
 * list that could disagree with the first never exists (invariant 14).
 */

export const ENGINE_SET_ENABLED_ACTION = `${ENGINE_PLUGINS_ID}.setEnabled`;
export const ENGINE_PURGE_ACTION = `${ENGINE_PLUGINS_ID}.purge`;

export const enginePluginsManifest: PluginManifest = {
  id: ENGINE_PLUGINS_ID,
  version: "1.0.0",
  title: "Plugin engine",
  description:
    "The engine's own administration doors: workspace-global enablement, and the purge verb that destroys a disabled plugin's data.",
  capabilities: ["plugins:manage"],
  contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
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
];
