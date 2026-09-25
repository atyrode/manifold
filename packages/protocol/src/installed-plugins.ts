import { z } from "zod";
import { ISOLATE_MAX_ARTIFACT_BYTES } from "./isolate.ts";
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

/** Standard base64's value for each ASCII code, -1 outside its alphabet. */
const BASE64_SEXTETS = new Int8Array(128).fill(-1);
for (let sextet = 0; sextet < 64; sextet++) {
  BASE64_SEXTETS[
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".charCodeAt(sextet)
  ] = sextet;
}

/**
 * Canonical padded base64 (RFC 4648 §4, zero pad bits per §3.5) of at most `maxBytes` bytes,
 * decided in one pass. A whole-string pattern such as `^(?:[A-Za-z0-9+/]{4})*…$` stops matching
 * valid input of 8 MiB and more in JavaScriptCore (#844), below the artifact cap.
 */
function isCanonicalBase64(value: string, maxBytes: number): boolean {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if ((value.length / 4) * 3 - padding > maxBytes) return false;
  const end = value.length - padding;
  for (let index = 0; index < end; index++) {
    const code = value.charCodeAt(index);
    if (code > 0x7f || BASE64_SEXTETS[code]! < 0) return false;
  }
  // The last data character's unused low bits, four before "==" and two before "=", are zero.
  return (
    padding === 0 ||
    (BASE64_SEXTETS[value.charCodeAt(end - 1)]! & (padding === 2 ? 0x0f : 0x03)) === 0
  );
}

/** An explicit empty inventory is valid; a missing door or malformed response never is. */
export const InstalledPluginsSnapshotSchema = z.strictObject({
  format: z.literal(1),
  developerMode: z.boolean(),
  plugins: z
    .array(
      z.strictObject({
        row: InstalledPluginRowSchema,
        enabled: z.boolean(),
        /** Original file bytes, not reserialized bundle JSON, within the export's artifact cap. */
        bytes: z.string().refine((bytes) => isCanonicalBase64(bytes, ISOLATE_MAX_ARTIFACT_BYTES), {
          message: "bundle bytes must be canonical base64 within the artifact cap",
        }),
      }),
    )
    .refine((plugins) => new Set(plugins.map(({ row }) => row.pluginId)).size === plugins.length, {
      message: "duplicate installed plugin",
    }),
});
export type InstalledPluginsSnapshot = z.infer<typeof InstalledPluginsSnapshotSchema>;
