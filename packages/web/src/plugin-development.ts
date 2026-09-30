import type { PluginRoster, PluginRosterEntry } from "@manifold/protocol";
import { sources } from "virtual:manifold-plugin-development";
import type { DevelopmentSource, DevelopmentWebModule } from "virtual:manifold-plugin-development";
import { mountPluginStylesheet, pluginManifestKey } from "./plugin-host.tsx";
import type { LoadedWebPlugin, WebPluginDef } from "./plugin-host.tsx";

export interface PluginDevelopmentLoader {
  reconcile(): void;
  dispose(): void;
}

interface SourceLease {
  readonly source: DevelopmentSource;
  readonly held: LoadedWebPlugin;
  readonly manifestKey: string;
  readonly claims: string;
  active: boolean;
  unsubscribe: (() => void) | null;
}

function eligible(row: PluginRosterEntry | undefined): row is PluginRosterEntry {
  return (
    row !== undefined &&
    row.enabled &&
    row.install !== undefined &&
    row.hardened !== true &&
    row.held === undefined &&
    row.install.refusal === undefined &&
    row.manifest.entry?.web !== undefined
  );
}

/** Projection and keyboard claims have no manifest row; their packed declarations stay admitted. */
function registrationClaims(definition: WebPluginDef): string {
  return JSON.stringify({
    renderers: Object.keys(definition.renderers ?? {}).sort(),
    overlays: Object.keys(definition.overlays ?? {}).sort(),
    workspaceOverlays: Object.keys(definition.workspaceOverlays ?? {}).sort(),
    terminals: definition.terminals !== undefined,
    bindings: (definition.bindings ?? [])
      .map(({ id, key, label, when }) => ({ id, key, label, when: when ?? "always" }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  });
}

/** Imported only in a Vite development build, after the authenticated assembly owns a baseline. */
export function createPluginDevelopmentLoader(
  loaded: Map<string, LoadedWebPlugin>,
  getRoster: () => PluginRoster,
  publish: () => void,
): PluginDevelopmentLoader {
  const leases = new Map<string, SourceLease>();
  const cancelled = new WeakSet<DevelopmentSource>();
  let disposed = false;

  const currentRow = (id: string): PluginRosterEntry | undefined =>
    getRoster().find((row) => row.manifest.id === id);

  const current = (lease: SourceLease): boolean => {
    const row = currentRow(lease.source.id);
    return (
      !disposed &&
      leases.get(lease.source.id) === lease &&
      sources.includes(lease.source) &&
      loaded.get(lease.source.id) === lease.held &&
      eligible(row) &&
      row.install!.sha256 === lease.held.sha256 &&
      pluginManifestKey(row.manifest) === lease.manifestKey &&
      pluginManifestKey(lease.source.manifest) === lease.manifestKey
    );
  };

  const cancel = (lease: SourceLease): void => {
    const id = lease.source.id;
    if (leases.get(id) !== lease) return;
    leases.delete(id);
    cancelled.add(lease.source);
    lease.unsubscribe?.();
    lease.unsubscribe = null;
    if (!lease.active) return;
    lease.active = false;
    lease.held.unmountStyles?.();
    lease.held.unmountStyles = null;
    lease.held.def = lease.held.packedDef;
    const row = currentRow(id);
    if (
      !disposed &&
      loaded.get(id) === lease.held &&
      eligible(row) &&
      row.install!.sha256 === lease.held.sha256
    ) {
      if (lease.held.packedCss !== null) {
        lease.held.unmountStyles = mountPluginStylesheet<HTMLStyleElement>(
          id,
          lease.held.packedCss,
          document,
        );
      }
      publish();
    }
  };

  const validDefinition = (lease: SourceLease, definition: WebPluginDef): boolean => {
    if (definition?.id !== lease.source.id) {
      console.error("evt=plugin_source_invalid_id", lease.source.id);
      return false;
    }
    if (registrationClaims(definition) !== lease.claims) {
      console.error("evt=plugin_source_installation_required", lease.source.id);
      return false;
    }
    return true;
  };

  const activate = (lease: SourceLease, module: DevelopmentWebModule): void => {
    if (!current(lease)) {
      cancel(lease);
      return;
    }
    try {
      const unsubscribe = module.subscribe((definition) => {
        if (leases.get(lease.source.id) !== lease) return;
        if (!current(lease) || definition === null) {
          cancel(lease);
          return;
        }
        // A bridge subscribes before loading its graph, so first-import errors remain recoverable.
        if (definition === undefined) return;
        if (!validDefinition(lease, definition)) {
          cancel(lease);
          return;
        }
        if (!lease.active) {
          lease.held.unmountStyles?.();
          lease.held.unmountStyles = null;
          lease.active = true;
          lease.held.unmountStyles = module.mountStyles();
        }
        lease.held.def = definition;
        publish();
      });
      // subscribe reports an already stopped module synchronously; never retain that listener.
      if (leases.get(lease.source.id) === lease) {
        lease.unsubscribe = unsubscribe;
        publish();
      } else {
        unsubscribe();
      }
    } catch (reason: unknown) {
      cancel(lease);
      console.error("evt=plugin_source_activation_failed", lease.source.id, reason);
    }
  };

  return {
    reconcile(): void {
      if (disposed) return;
      for (const lease of leases.values()) {
        if (!current(lease)) cancel(lease);
      }
      for (const source of sources) {
        if (cancelled.has(source) || leases.has(source.id)) continue;
        const row = currentRow(source.id);
        const held = loaded.get(source.id);
        if (!eligible(row) || held === undefined || row.install!.sha256 !== held.sha256) continue;
        const key = pluginManifestKey(source.manifest);
        if (key === null || key !== pluginManifestKey(row.manifest) || key !== held.manifestKey) {
          continue;
        }
        const lease: SourceLease = {
          source,
          held,
          manifestKey: key,
          claims: registrationClaims(held.packedDef),
          active: false,
          unsubscribe: null,
        };
        leases.set(source.id, lease);
        void source.load().then(
          (module) => activate(lease, module),
          (reason: unknown) => {
            if (leases.get(source.id) !== lease) return;
            cancel(lease);
            console.error("evt=plugin_source_import_failed", source.id, reason);
          },
        );
      }
    },
    dispose(): void {
      disposed = true;
      for (const lease of leases.values()) cancel(lease);
    },
  };
}
