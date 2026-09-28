import type { AnyActionDef, PluginStorage } from "@manifold/plugin";
import { defineServerPlugin } from "@manifold/plugin-kit/server";
import type { PluginManifest } from "@manifold/protocol";
import { z } from "zod";
import type { ServerPluginDef } from "../../src/plugin-host.ts";

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

const actions: readonly AnyActionDef[] = [
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

// Inert when imported by the native test; the same declaration serves the compiled child.
defineServerPlugin(portableFleetProbe);
