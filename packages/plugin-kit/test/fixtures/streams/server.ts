import {
  defineServerAction,
  defineServerPlugin,
  type GuestCtx,
  type GuestStreamProducer,
} from "@manifold/plugin-kit/server";
import { PluginManifestSchema } from "@manifold/protocol";
import { z } from "zod";
import manifestJson from "./manifest.json";

const running = new Map<string, GuestStreamProducer>();
const start = defineServerAction({
  name: "start",
  title: "Start sixty seconds of continuous frames",
  caps: ["containers:write"],
  input: z.strictObject({ containerId: z.string().min(1) }),
  result: z.strictObject({ epoch: z.string(), frames: z.literal(1200) }),
});

async function produce(containerId: string, producer: GuestStreamProducer): Promise<void> {
  const started = Date.now();
  try {
    for (let frame = 1; frame <= 1200 && running.get(containerId) === producer; frame += 1) {
      // Actual wall-clock cadence, not fake clocks or a burst masquerading as a stream.
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.max(0, started + frame * 50 - Date.now())),
      );
      if (running.get(containerId) !== producer) break;
      await producer.publish({ frame, ink: "stream-only-ink-not-a-journal-event" });
    }
  } finally {
    if (running.get(containerId) === producer) running.delete(containerId);
    await producer.close();
  }
}

defineServerPlugin({
  manifest: PluginManifestSchema.parse(manifestJson),
  actions: [start],
  handlers: {
    async start(ctx: GuestCtx, args: { containerId: string }) {
      if (running.has(args.containerId)) return { refused: "stream already running" };
      const producer = await ctx.streams.open("example.streams.frames", {
        kind: "plugin",
        pluginId: "example.streams",
      });
      running.set(args.containerId, producer);
      void produce(args.containerId, producer).catch((error: unknown) =>
        console.error("stream fixture producer failed", error),
      );
      return { epoch: producer.epoch, frames: 1200 as const };
    },
  },
  lifecycle: {
    async onDisable() {
      const producers = [...running.values()];
      running.clear();
      await Promise.all(producers.map((producer) => producer.close()));
    },
  },
});
