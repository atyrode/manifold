declare module "virtual:manifold-plugin-development" {
  export interface DevelopmentWebModule {
    readonly default: import("./plugin-host.tsx").WebPluginDef;
    mountStyles(): () => void;
    subscribe(listener: (definition: import("./plugin-host.tsx").WebPluginDef | null) => void): () => void;
  }

  export interface DevelopmentSource {
    readonly id: string;
    readonly manifest: import("@manifold/protocol").PluginManifest;
    load(): Promise<DevelopmentWebModule>;
  }

  export const sources: readonly DevelopmentSource[];
}
