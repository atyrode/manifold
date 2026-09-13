import { defineServerAction, defineServerPlugin, type GuestCtx } from "@manifold/plugin-kit/server";
import { PluginManifestSchema } from "@manifold/protocol";
import { z } from "zod";
import manifestJson from "./manifest.json";

const check = defineServerAction({
  name: "check",
  title: "Check counter availability",
  caps: [],
  input: z.strictObject({}),
  result: z.strictObject({ ready: z.literal(true) }),
});

defineServerPlugin({
  manifest: PluginManifestSchema.parse(manifestJson),
  actions: [check],
  handlers: {
    async check(ctx: GuestCtx) {
      if (
        !(await ctx.host.enabled("example.counter")) ||
        !(await ctx.host.enabled("example.counter.part"))
      ) {
        return { refused: "the counter and its availability part must both be enabled" };
      }
      return { ready: true };
    },
  },
});
