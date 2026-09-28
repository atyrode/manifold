import type { AnyActionDef, PluginStorage } from "@manifold/plugin";
import { defineServerPlugin, type GuestCtx } from "@manifold/plugin-kit/server";
import type { PluginManifest } from "@manifold/protocol";
import { z } from "zod";
import type { ActionCtx, ServerPluginDef } from "../../src/plugin-host.ts";

/** The probe forwards opaque bridge answers; both synchronous and remote ports fit. */
interface ProbeCtx {
  readonly storage: Pick<PluginStorage, "get" | "set">;
  readonly identity: {
    enrollMachine(name: string): unknown;
    rotateMachineToken(machineId: string): unknown;
  };
  readonly machines: {
    inventory(): unknown;
  };
}

const manifest: PluginManifest = {
  id: "test.portablefleet",
  version: "1.0.0",
  title: "Portable fleet probe",
  description: "Exercises real child authority and retained trusted-child lifecycle.",
  // A wildcard is withheld by default, so installation must explicitly grant the tested slice.
  capabilities: ["*"],
  contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
  dataVersion: { major: 1, minor: 0 },
  entry: { server: true },
};

const repositoryInput = z.strictObject({
  machineId: z.string(),
  path: z.string(),
  wait: z.boolean().optional(),
});
type RepositoryArgs = z.infer<typeof repositoryInput>;

async function repositoryBarrier(ctx: Pick<ProbeCtx, "storage">, args: RepositoryArgs) {
  if (!args.wait) return;
  await ctx.storage.set("repository-entered", "yes");
  // The parent releases durable state over IPC; its fake clock cannot drive this child.
  while ((await ctx.storage.get("repository-release")) !== "yes") await Bun.sleep(1);
}

async function nativeRepository(ctx: ActionCtx, args: RepositoryArgs) {
  await repositoryBarrier(ctx, args);
  return ctx.machines.repository(args.machineId, args.path);
}

async function guestRepository(ctx: GuestCtx, args: RepositoryArgs) {
  await repositoryBarrier(ctx, args);
  return ctx.machines.repository({ machineId: args.machineId, path: args.path });
}

const actions: readonly AnyActionDef[] = [
  {
    name: "bareRepository",
    title: "Undeclared repository read",
    caps: [],
    input: repositoryInput,
    result: z.unknown(),
  },
  {
    name: "repository",
    title: "Delegated repository read",
    caps: [],
    delegates: ["machines:read"],
    scope: "container",
    input: repositoryInput,
    result: z.unknown(),
  },
  {
    name: "bare",
    title: "Undeclared enrollment",
    caps: [],
    input: z.strictObject({ name: z.string() }),
    result: z.unknown(),
  },
  {
    name: "enroll",
    title: "Declared enrollment",
    caps: ["machines:mint"],
    scope: "container",
    input: z.strictObject({ name: z.string() }),
    result: z.unknown(),
  },
  {
    name: "inventory",
    title: "Inventory",
    caps: ["containers:read"],
    scope: "container",
    input: z.strictObject({}),
    result: z.unknown(),
  },
  {
    name: "delayedRotate",
    title: "Delayed rotation",
    caps: ["machines:mint"],
    input: z.strictObject({ machineId: z.string() }),
    result: z.unknown(),
  },
  {
    name: "cleanup",
    title: "Read retained state",
    caps: [],
    cleanup: true,
    input: z.strictObject({}),
    result: z.strictObject({ pid: z.number().int().positive(), marker: z.string().nullable() }),
  },
];

export const portableFleetProbe = {
  manifest,
  actions,
  handlers: {
    bareRepository: nativeRepository,
    repository: nativeRepository,
    bare: async (ctx: ProbeCtx, args: { name: string }) =>
      await ctx.identity.enrollMachine(args.name),
    enroll: async (ctx: ProbeCtx, args: { name: string }) =>
      await ctx.identity.enrollMachine(args.name),
    inventory: async (ctx: ProbeCtx) => await ctx.machines.inventory(),
    delayedRotate: async (ctx: ProbeCtx, args: { machineId: string }) => {
      await ctx.storage.set("entered", "yes");
      // The parent releases durable state over real IPC; its fake clock cannot drive this process.
      while ((await ctx.storage.get("release")) !== "yes") await Bun.sleep(1);
      return await ctx.identity.rotateMachineToken(args.machineId);
    },
    cleanup: async (ctx: ProbeCtx) => ({
      pid: process.pid,
      marker: await ctx.storage.get("marker"),
    }),
  },
} satisfies ServerPluginDef;

// Each public surface keeps its own call shape: native takes two arguments, guest one query.
defineServerPlugin({
  ...portableFleetProbe,
  handlers: {
    ...portableFleetProbe.handlers,
    bareRepository: guestRepository,
    repository: guestRepository,
  },
});
