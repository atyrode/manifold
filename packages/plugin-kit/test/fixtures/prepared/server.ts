import { z } from "zod";
import { ManifoldRefSchema, PluginManifestSchema } from "@manifold/protocol";
import { defineServerPlugin } from "../../../src/server.ts";
import manifest from "./manifest.json";

defineServerPlugin({
  manifest: PluginManifestSchema.parse(manifest),
  actions: [
    {
      name: "open",
      title: "Open",
      caps: ["containers:read"],
      requirements: [{ cap: "containers:read", target: ["target"] }],
      input: z.strictObject({ target: ManifoldRefSchema }),
      result: z.null(),
    },
  ],
  prepareActions: {
    open: {
      caps: ["machines:read"],
      prepare: async (_ctx, args: { target: { kind: "container"; containerId: string } }) => ({
        args,
        targets: [args.target],
        additionalRequirements: [
          { cap: "machines:read", node: "manifold://machine/exact", reach: "node" },
        ],
      }),
    },
  },
  handlers: {
    open: async (ctx) => {
      await ctx.storage.set("effect", "written");
      return null;
    },
  },
});
