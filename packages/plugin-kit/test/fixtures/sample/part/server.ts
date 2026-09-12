import { defineServerAction, defineServerPlugin, type GuestCtx } from "@manifold/plugin-kit/server";
import { PluginManifestSchema } from "@manifold/protocol";
import { z } from "zod";
import manifestJson from "./manifest.json";

const snapshot = defineServerAction({
  name: "snapshot",
  title: "Record counter availability",
  caps: [],
  input: z.strictObject({}),
  result: z.strictObject({ version: z.string() }),
});

defineServerPlugin({
  manifest: PluginManifestSchema.parse(manifestJson),
  actions: [snapshot],
  handlers: {
    async snapshot(ctx: GuestCtx) {
      const parent = (await ctx.host.roster()).find((row) => row.manifest.id === "example.counter");
      if (!parent?.enabled) return { refused: "the counter is unavailable" };
      const result = { version: parent.manifest.version };
      await ctx.storage.set("lastSnapshot", JSON.stringify(result));
      return result;
    },
  },
});
