import {
  defineServerAction,
  defineServerPlugin,
  type GuestStreamProducer,
} from "@manifold/plugin-kit/server";
import { PluginManifestSchema } from "@manifold/protocol";
import { z } from "zod";
import manifest from "./manifest.json";

let running: GuestStreamProducer | undefined;
let sequence = 0;
const start = defineServerAction({
  name: "start",
  title: "Start real-time frames",
  caps: ["containers:write"],
  input: z.strictObject({}),
  result: z.strictObject({ epoch: z.string() }),
});
const pressure = defineServerAction({
  name: "pressure",
  title: "Exercise a bounded slow consumer",
  caps: ["containers:write"],
  input: z.strictObject({}),
  result: z.strictObject({ lastSeq: z.number().int() }),
});
async function produce(producer: GuestStreamProducer): Promise<void> {
  const started = Date.now();
  try {
    for (let frame = 1; frame <= 1200 && running === producer; frame++) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.max(0, started + frame * 50 - Date.now())),
      );
      if (running !== producer) break;
      await producer.publish({ frame: ++sequence, ink: "runtime-frame-not-for-event-journal" });
    }
  } finally {
    if (running === producer) running = undefined;
    await producer.close();
  }
}
defineServerPlugin({
  manifest: PluginManifestSchema.parse(manifest),
  actions: [start, pressure],
  handlers: {
    async start(ctx) {
      if (running) return { refused: "producer already running" };
      const producer = await ctx.streams.open("fixture.runtime.frames", {
        kind: "plugin",
        pluginId: "fixture.runtime",
      });
      running = producer;
      sequence = 0;
      void produce(producer).catch(() => console.error("runtime fixture producer failed"));
      return { epoch: producer.epoch };
    },
    async pressure() {
      const producer = running;
      if (!producer) return { refused: "producer unavailable" };
      // Fixed total work and fixed payload: no unbounded producer or user-controlled amplification.
      const ink = "runtime-frame-not-for-event-journal" + "x".repeat(15900);
      for (let index = 0; index < 4096 && running === producer; index++) {
        await producer.publish({ frame: ++sequence, ink });
      }
      return { lastSeq: sequence };
    },
  },
  lifecycle: {
    async onDisable() {
      const producer = running;
      running = undefined;
      await producer?.close();
    },
  },
});
