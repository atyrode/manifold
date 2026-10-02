import { z } from "zod";
import { ManifoldRefSchema } from "@manifold/protocol";
import { defineServerPlugin } from "../../../../plugin-kit/src/server.ts";

const target = { kind: "container", containerId: "approved" };
let captured;
let retainedPreparation;
const manifest = {
  id: "test.preparationguest",
  version: "1.0.0",
  title: "Preparation guest",
  description: "",
  capabilities: ["containers:read", "machines:read"],
  contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
  entry: { server: true },
};
defineServerPlugin({
  manifest,
  actions: [
    { name: "capture", title: "Capture", caps: [], input: z.null(), result: z.null() },
    {
      name: "open",
      title: "Open",
      caps: ["containers:read"],
      requirements: [{ cap: "containers:read", target: ["target"] }],
      input: z.strictObject({
        target: ManifoldRefSchema,
        secret: z.string(),
        mode: z.string(),
        machineId: z.string().optional(),
      }),
      result: z.strictObject({ machineId: z.string(), preparationClosed: z.boolean() }),
    },
  ],
  prepareActions: {
    open: {
      caps: ["machines:read"],
      prepare: async (ctx, args) => {
        retainedPreparation = ctx;
        if (args.mode === "mutate") {
          try {
            await captured.storage.set("preparation-effect", "forbidden");
          } catch {
            // The retained mutable context must refuse effects during preparation.
          }
        }
        const destination = await ctx.terminals.resolveMachine({});
        return {
          args: { ...args, machineId: destination.machineId, secret: "normalized-child-secret" },
          targets: [target],
          additionalRequirements: [
            {
              cap: "machines:read",
              node: `manifold://machine/${destination.machineId}`,
              reach: "node",
            },
          ],
        };
      },
    },
  },
  handlers: {
    capture: async (ctx) => {
      captured = ctx;
      return null;
    },
    open: async (ctx, args) => {
      let preparationClosed = false;
      try {
        await retainedPreparation.terminals.resolveMachine({});
      } catch {
        preparationClosed = true;
      }
      if (args.secret !== "normalized-child-secret")
        throw new Error("lost child-owned normalization");
      await ctx.storage.set("handler-effect", args.machineId);
      return { machineId: args.machineId, preparationClosed };
    },
  },
});
