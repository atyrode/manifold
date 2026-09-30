declare module "virtual:manifold-plugin-development" {
  import type { PluginManifest } from "@manifold/protocol";
  import type { WebPluginDef } from "@manifold/web/plugin-host";

  export interface DevelopmentWebModule {
    readonly default: WebPluginDef | null | undefined;
    mountStyles(): () => void;
    subscribe(listener: (definition: WebPluginDef | null | undefined) => void): () => void;
  }

  export interface DevelopmentSource {
    readonly id: string;
    readonly manifest: PluginManifest;
    load(): Promise<DevelopmentWebModule>;
  }

  export const sources: readonly DevelopmentSource[];
}
