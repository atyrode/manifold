import { defineServerAction, defineServerPlugin, type GuestCtx } from "@manifold/plugin-kit/server";
import { PluginManifestSchema } from "@manifold/protocol";
import { z } from "zod";
import manifestJson from "./manifest.json";

/*
  THE REFERENCE ISOLATED PLUGIN, server half. One door, `acme.counter.bump`: reads its own
  storage, refuses on domain grounds, writes, emits. Every engine-touching call is awaited —
  each one crosses the process boundary as a `call` frame the host answers.
 */

const COUNT_KEY = "count";

const bump = defineServerAction({
  name: "bump",
  title: "Bump the counter",
  caps: ["containers:read"],
  input: z.strictObject({ by: z.number().int().min(1).max(100).default(1) }),
  result: z.strictObject({ count: z.number().int() }),
});

export const handlers = {
  async bump(
    ctx: GuestCtx,
    args: { by: number },
  ): Promise<{ count: number } | { refused: string }> {
    const current = Number((await ctx.storage.get(COUNT_KEY)) ?? "0");
    const count = current + args.by;
    if (count > 1_000) return { refused: "the counter stops at one thousand" };
    await ctx.storage.set(COUNT_KEY, String(count));
    ctx.emit({ kind: "plugin", pluginId: ctx.pluginId }, "counter_bumped", { count });
    return { count };
  },
};

defineServerPlugin({
  manifest: PluginManifestSchema.parse(manifestJson),
  actions: [bump],
  handlers,
  lifecycle: {
    async onEnable(ctx) {
      if ((await ctx.storage.get(COUNT_KEY)) === null) await ctx.storage.set(COUNT_KEY, "0");
    },
  },
});
