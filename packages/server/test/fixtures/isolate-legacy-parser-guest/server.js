import { z } from "zod";
import { ManifoldRefSchema } from "@manifold/protocol";
import { defineServerPlugin } from "../../../../plugin-kit/src/server.ts";

const ready = Promise.withResolvers();
const finish = Promise.withResolvers();
let captured;
let descendant;
let attempts = Promise.resolve([]);
let handled = 0;
const manifest = {
  id: "test.legacyparser",
  version: "1.0.0",
  title: "Legacy parser guest",
  description: "",
  capabilities: ["containers:read", "machines:mint", "jobs:cancel"],
  contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
  entry: { server: true },
};

async function rejected(effect) {
  try {
    await effect();
    return false;
  } catch {
    return true;
  }
}

function effects(ctx, key, text) {
  return Promise.all([
    rejected(() => ctx.storage.set(key, text)),
    rejected(() => ctx.identity.enrollMachine(key)),
    rejected(() =>
      ctx.jobs.cancel({ kind: "job", machineId: "machine", operationId: "operation", jobId: key }),
    ),
  ]);
}

function parse(args) {
  if (args.mode === "direct") attempts = effects(captured, args.key, "forbidden");
  if (args.mode === "microtask")
    attempts = Promise.resolve().then(() => effects(captured, args.key, "forbidden"));
  if (args.mode === "descendant") {
    descendant = Promise.withResolvers();
    attempts = descendant.promise.then(() => effects(captured, args.key, "forbidden"));
  }
  return { ...args, text: `${args.text}!` };
}

const input = z.strictObject({
  mode: z.enum(["direct", "microtask", "descendant", "pure"]),
  key: z.string(),
  text: z.string(),
  target: ManifoldRefSchema,
});
const result = z.strictObject({ text: z.string(), blocked: z.boolean().array() });
const execute = async (ctx, args) => {
  handled += 1;
  return { text: args.text, blocked: await effects(ctx, args.key, args.text) };
};

defineServerPlugin({
  manifest,
  actions: [
    {
      name: "hold",
      title: "Hold",
      caps: manifest.capabilities,
      input: z.null(),
      result: z.null(),
    },
    { name: "ready", title: "Ready", caps: [], input: z.null(), result: z.null() },
    { name: "finish", title: "Finish", caps: [], input: z.null(), result: z.null() },
    {
      name: "checkpoint",
      title: "Checkpoint",
      caps: [],
      input: z.null(),
      result: z.strictObject({ handled: z.number(), blocked: z.boolean().array() }),
    },
    ...[
      ["transform", input.transform(parse)],
      ["preprocess", z.preprocess(parse, input)],
    ].map(([name, schema]) => ({
      name,
      title: name,
      caps: manifest.capabilities,
      requirements: [{ cap: "containers:read", target: ["target"] }],
      input: schema,
      result,
    })),
  ],
  handlers: {
    hold: async (ctx) => {
      captured = ctx;
      ready.resolve();
      await finish.promise;
      await ctx.storage.set("retained-after-review", "admitted");
      return null;
    },
    ready: async () => {
      await ready.promise;
      return null;
    },
    checkpoint: async () => {
      descendant?.resolve();
      return { handled, blocked: await attempts };
    },
    finish: async () => {
      finish.resolve();
      return null;
    },
    transform: execute,
    preprocess: execute,
  },
});
