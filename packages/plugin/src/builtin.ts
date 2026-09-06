import {
  CAPS,
  CapSchema,
  ENGINE_NAMESPACE_PREFIX,
  LocalNameSchema,
  MAX_PLUGIN_BUNDLE_FILES,
  PluginBundleFileSchema,
  PluginIdSchema,
  PluginPurgeResultSchema,
  SettingValueSchema,
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
export const ENGINE_INSTALL_ACTION = `${ENGINE_PLUGINS_ID}.install`;
export const ENGINE_UNINSTALL_ACTION = `${ENGINE_PLUGINS_ID}.uninstall`;
export const ENGINE_SET_DEVELOPER_MODE_ACTION = `${ENGINE_PLUGINS_ID}.setDeveloperMode`;
export const ENGINE_AUTHOR_ACTION = `${ENGINE_PLUGINS_ID}.author`;

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
export const ENGINE_INSTALLED_EVENT = "plugin_installed";
export const ENGINE_UNINSTALLED_EVENT = "plugin_uninstalled";
export const ENGINE_DEVELOPER_MODE_EVENT = "developer_mode_changed";

/**
 * What an INSTALL door asks for (ADR 0016 §8 stage 2): the artifact by location and by the
 * hash of its exact bytes, optionally a wider grant than the default, and consent to replace
 * an id already installed at another hash. Root only (`caps: ["*"]`), because a bundle is a
 * stranger's code and `plugins:manage` was granted to switch rows on and off, not to admit
 * new ones.
 */
export const PluginInstallRequestSchema = z.strictObject({
  /** An `https://` URL, or an absolute path the server permits (docs/CONTRACTS.md). */
  source: z.string().min(1).max(2048),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  /** Widens the default grant; every member must be within the manifest's declared caps. */
  grant: CapSchema.array().max(CAPS.length).optional(),
  /** Consent to upgrade an id already installed at a different hash; it must be disabled. */
  replace: z.boolean().optional(),
  /** Optional process/Worker isolation; absent means the full in-realm engine API. */
  hardened: z.boolean().optional(),
});
export type PluginInstallRequest = z.infer<typeof PluginInstallRequestSchema>;

export const PluginInstallResultSchema = z.strictObject({
  id: PluginIdSchema,
  version: z.string(),
  grantedCaps: CapSchema.array(),
});
export type PluginInstallResult = z.infer<typeof PluginInstallResultSchema>;

/**
 * What the AUTHORING door asks for (ADR 0025 §4): a plugin id and the files to write into its
 * unpacked directory, `<data>/authored/<id>/`. Names are the bundle's flat member grammar
 * (`PluginBundleFileSchema`: one segment, no leading dot), so nothing can climb out of the
 * directory; a `null` value REMOVES that file. Every other file the directory holds stays —
 * one door and one file write is the point, and an edit is one entry. The hub rebuilds the
 * directory the moment the write lands and installs the result through the ONE install path,
 * so the answer is the row as the roster now shows it: the pin of the bytes it built.
 */
export const PluginAuthorRequestSchema = z.strictObject({
  id: PluginIdSchema,
  files: z
    .record(
      PluginBundleFileSchema,
      z
        .string()
        .max(1024 * 1024)
        .nullable(),
    )
    .refine((files) => Object.keys(files).length <= MAX_PLUGIN_BUNDLE_FILES, {
      message: `at most ${String(MAX_PLUGIN_BUNDLE_FILES)} files`,
    }),
});
export type PluginAuthorRequest = z.infer<typeof PluginAuthorRequestSchema>;

export const PluginAuthorResultSchema = PluginInstallResultSchema.extend({
  sha256: z.string().length(64),
});
export type PluginAuthorResult = z.infer<typeof PluginAuthorResultSchema>;

export const enginePluginsManifest: PluginManifest = {
  id: ENGINE_PLUGINS_ID,
  version: "1.0.0",
  title: "Plugin engine",
  description:
    "The engine's own administration doors: workspace-global enablement, the purge verb that destroys a disabled plugin's data, the install and uninstall doors that admit or remove a stranger's bundle, and the developer-mode and authoring doors that admit a plugin written on this instance.",
  capabilities: ["plugins:manage", "*"],
  contributes: {
    panels: [],
    sections: [],
    elements: [],
    tools: [],
    events: [
      { id: "plugin_setting_changed", title: "Workspace plugin setting changed" },
      { id: ENGINE_ENABLED_EVENT, title: "Plugin enabled" },
      { id: ENGINE_DISABLED_EVENT, title: "Plugin disabled" },
      { id: ENGINE_PURGED_EVENT, title: "Plugin data purged" },
      { id: ENGINE_INSTALLED_EVENT, title: "Plugin installed" },
      { id: ENGINE_UNINSTALLED_EVENT, title: "Plugin uninstalled" },
      { id: ENGINE_DEVELOPER_MODE_EVENT, title: "Developer mode changed" },
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
 * `setSetting` arbitrates declared values before composition. Principal values need no
 * capability; workspace values require `plugins:manage` and emit `plugin_setting_changed`.
 * The engine owns the door because the sidebar consumes settings before any plugin draws,
 * and no plugin may own another plugin's preferences.
 *
 * `value: null` RETRACTS the opinion — the ref leaves the map and the row reads its manifest's
 * default again. One door rather than a `resetSetting` sibling, because "I have no opinion" is
 * a value this map can express and a second door would be a second way to write one map.
 *
 * Workspace notifications invalidate the same settings read for every connected principal.
 *
 * `install` and `uninstall` (ADR 0016 §8 stage 2) are ROOT-ONLY, and the asymmetry with the
 * three doors above is the point: `plugins:manage` lets a principal decide which of the
 * plugins THIS BUILD SHIPS are on, while installing admits code nobody in this build wrote. A
 * manager token that could install would be a manager token that could run anything, which is
 * `*` by another name — so the door says `*` and nothing narrower. Both answer refusals as
 * `{ refused: "<PLUGIN_INSTALL_REFUSALS member>: detail" }`, class first, so a client switches
 * on the prefix exactly as it does for the toggle refusals. Uninstall requires the row
 * disabled (`still_enabled`) and never destroys the plugin's storage on its own: while that
 * storage holds rows it refuses `storage_retained` unless `purge: true` is passed, and then it
 * purges first — the purge door's own path, the same `plugin_purged` event — and uninstalls
 * second (#233). Destruction is `purge`, whichever door it is asked through.
 *
 * `setDeveloperMode` and `author` (ADR 0025 §4) are root-only for the same reason: a
 * directory the hub rebuilds and loads is code nobody in this build wrote, admitted by
 * whoever holds the instance. The switch is one workspace-global meta row, published beside
 * the roster (`developerMode`) so agents and humans read the same value; off, every unpacked
 * row refuses enable as `developer_mode_off` and `author` refuses by the same name. Turning it
 * off switches every enabled unpacked row off through `setEnabled` — the one door, each traced
 * — before the switch flips, so no unpacked code runs while the switch reads off.
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
    title: "Set a declared plugin setting",
    caps: [],
    input: z.strictObject({
      plugin: PluginIdSchema,
      setting: LocalNameSchema,
      value: SettingValueSchema.nullable(),
    }),
    result: z.strictObject({}),
  }),
  defineAction({
    name: "install",
    title: "Install a plugin from a bundle",
    caps: ["*"],
    input: PluginInstallRequestSchema,
    result: PluginInstallResultSchema,
  }),
  defineAction({
    name: "uninstall",
    title: "Uninstall a disabled plugin's bundle",
    caps: ["*"],
    input: z.strictObject({
      id: PluginIdSchema,
      /** Consent to purge the plugin's stored data first; without it, retained data refuses. */
      purge: z.boolean().optional(),
    }),
    result: z.strictObject({}),
  }),
  defineAction({
    name: "setDeveloperMode",
    title: "Admit or refuse plugins authored on this instance",
    caps: ["*"],
    input: z.strictObject({ on: z.boolean() }),
    result: z.strictObject({}),
  }),
  defineAction({
    name: "author",
    title: "Write a plugin's files on this instance and load it",
    caps: ["*"],
    input: PluginAuthorRequestSchema,
    result: PluginAuthorResultSchema,
  }),
];
