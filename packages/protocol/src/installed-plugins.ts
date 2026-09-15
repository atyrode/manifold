import { z } from "zod";
import {
  ActionSummarySchema,
  AuthoredCapSchema,
  PluginIdSchema,
  PluginInstallModeSchema,
} from "./plugin.ts";

/** Configured intent for every installed artifact, independent of runtime assembly holds. */
export const InstalledPluginStatesSchema = z.strictObject({
  plugins: z
    .array(
      z.strictObject({
        pluginId: PluginIdSchema,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        enabled: z.boolean(),
      }),
    )
    .refine((plugins) => new Set(plugins.map(({ pluginId }) => pluginId)).size === plugins.length, {
      message: "duplicate installed plugin",
    }),
});
export type InstalledPluginStates = z.infer<typeof InstalledPluginStatesSchema>;

/** Only pinned bundle members are portable: never an installer credential or source URL. */
export const InstalledPluginRowSchema = z
  .strictObject({
    pluginId: PluginIdSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    source: z.string(),
    grantedCaps: AuthoredCapSchema.array(),
    installedBy: z.string().min(1).max(128),
    installedAt: z.number().int().nonnegative(),
    bundlePath: z.string(),
    actions: ActionSummarySchema.array(),
    hardened: z.boolean().optional(),
    builtAgainst: z.record(z.string(), z.string()).optional(),
    mode: PluginInstallModeSchema.optional(),
  })
  .refine(
    (row) => {
      const path = `plugins/${row.pluginId}/${row.sha256}.manifold-plugin.json`;
      return row.bundlePath === path && row.source === path;
    },
    { message: "installed bundle paths must name the pinned relative bundle" },
  );
export type InstalledPluginRow = z.infer<typeof InstalledPluginRowSchema>;

/** An explicit empty inventory is valid; a missing door or malformed response never is. */
export const InstalledPluginsSnapshotSchema = z.strictObject({
  format: z.literal(1),
  developerMode: z.boolean(),
  plugins: z
    .array(
      z.strictObject({
        row: InstalledPluginRowSchema,
        enabled: z.boolean(),
        /** Original file bytes, not reserialized bundle JSON. */
        bytes: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
      }),
    )
    .refine((plugins) => new Set(plugins.map(({ row }) => row.pluginId)).size === plugins.length, {
      message: "duplicate installed plugin",
    }),
});
export type InstalledPluginsSnapshot = z.infer<typeof InstalledPluginsSnapshotSchema>;
