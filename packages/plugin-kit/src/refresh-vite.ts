import type { Plugin } from "vite";

export const PLUGIN_DEVELOPMENT_REGISTRY = "virtual:manifold-plugin-development";
export const PLUGIN_DEVELOPMENT_ACTIVE = "manifold-plugin-development-active";

/** Normal builds and ordinary Vite development have an inert, empty registry. */
export function pluginDevelopment(): Plugin {
  let active = false;
  return {
    name: "manifold-plugin-development-inactive",
    configResolved(config) {
      active =
        config.command === "serve" &&
        config.plugins.some((plugin) => plugin.name === PLUGIN_DEVELOPMENT_ACTIVE);
    },
    resolveId(id) {
      if (!active && id === PLUGIN_DEVELOPMENT_REGISTRY) return `\0${PLUGIN_DEVELOPMENT_REGISTRY}`;
    },
    load(id) {
      if (!active && id === `\0${PLUGIN_DEVELOPMENT_REGISTRY}`) return "export const sources = [];";
    },
  };
}
