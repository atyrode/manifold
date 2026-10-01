import { describe, expect, test } from "bun:test";
import { defineAction } from "@manifold/plugin";
import { z } from "zod";
import type { ActionPreparationDef, PreparedRequirement } from "@manifold/protocol";
import { AuthService } from "../src/auth.ts";
import { RoomManager } from "../src/room.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { silentLogger } from "../src/log.ts";
import type { ServerPluginDef } from "../src/plugin-host.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore, testTileTrees } from "./helpers.ts";

async function fixture(preparation: ActionPreparationDef) {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const auth = new AuthService(store, "a".repeat(64), runtime);
  const owner = auth.authenticate("a".repeat(64));
  const rooms = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
  const broker = new TerminalBroker(store, auth, rooms, runtime, clock, silentLogger, () => "http://localhost:7777", testTileTrees);
  let effects = 0;
  const def: ServerPluginDef = {
    manifest: {
      id: "test.prepare", version: "1.0.0", title: "Prepare", description: "",
      capabilities: ["containers:read", "machines:shell"],
      contributes: { panels: [], sections: [], elements: [], tools: [] },
    },
    actions: [defineAction({
      name: "apply", title: "Apply", caps: ["containers:read"],
      requirements: [{ cap: "containers:read", target: ["container"] }], scope: "container",
      input: z.strictObject({ container: z.string().trim().min(1), value: z.number().int().min(0).max(10) }),
      result: z.strictObject({ value: z.number() }),
    })],
    prepareActions: { apply: preparation },
    handlers: { apply: async (_ctx, args: { value: number }) => { effects++; return { value: args.value }; } },
  };
  const host = await testPluginHost(store, auth, rooms, broker, runtime, { settingsPlugins: [def] });
  return { runtime, store, auth, owner, host, effects: () => effects, close: () => { host.close(); store.close(); } };
}

const shell: PreparedRequirement = { cap: "machines:shell", node: "manifold://machine/M1", reach: "node" };

describe("pure action preparation", () => {
  test("the real parser normalizes before preparation and validates again before effects", async () => {
    const f = await fixture({ caps: [], prepare: async (_ctx, args: { container: string; value: number }) => {
      expect(args.container).toBe("C");
      return { args: { ...args, value: 11 }, targets: [{ kind: "container", containerId: args.container }] };
    } });
    try {
      expect(await f.host.dispatch(f.owner, "test.prepare.apply", { container: " C ", value: 1 })).toMatchObject({ ok: false, denial: { rule: "invalid_args" } });
      expect(f.effects()).toBe(0);
    } finally { f.close(); }
  });

  test("preparation receives no effect authority and review never calls a handler", async () => {
    const f = await fixture({ caps: ["machines:shell"], prepare: async (ctx, args: { container: string; value: number }) => {
      for (const key of ["storage", "database", "identity", "actions", "streams", "jobs", "emit", "newId", "broker", "credential"])
        expect(Object.hasOwn(ctx, key)).toBe(false);
      return { args: { ...args, value: 2 }, targets: [{ kind: "container", containerId: args.container }], additionalRequirements: [shell] };
    } });
    try {
      const token = f.auth.mintTokenV2({ principal: { kind: "human", name: "reviewer" }, scope: [], expiresAt: f.runtime.now() + 60_000 }, f.owner);
      const result = await f.host.prepareActionInput(f.auth.authenticate(token.token), "test.prepare.apply", { container: "C", value: 1 });
      expect(result).toMatchObject({ ok: true, result: { targets: [{ kind: "container", containerId: "C" }], additionalRequirements: [shell] } });
      expect(f.effects()).toBe(0);
      expect(f.store.listTerminals()).toEqual([]);
    } finally { f.close(); }
  });

  test("a fixed container leg and additional exact machine leg remain conjunctive", async () => {
    const f = await fixture({ caps: ["machines:shell"], prepare: async (_ctx, args: { container: string; value: number }) => ({
      args, targets: [{ kind: "container", containerId: args.container }], additionalRequirements: [shell],
    }) });
    try {
      f.store.createContainer({ id: "C", name: "C", discipline: "composition", createdAt: f.runtime.now() });
      const request = { principal: { kind: "human" as const, name: "automation" }, expiresAt: f.runtime.now() + 60_000 };
      const placement = { target: "manifold://container/C", reach: "subtree" as const, caps: ["containers:read" as const] };
      const machine = { target: "manifold://machine/M1", reach: "node" as const, caps: ["machines:shell" as const] };
      const onlyC = f.auth.mintTokenV2({ ...request, scope: [placement], containerId: "C" }, f.owner);
      const both = f.auth.mintTokenV2({ ...request, scope: [placement, machine], containerId: "C" }, f.owner);
      expect(await f.host.dispatch(f.auth.authenticate(onlyC.token), "test.prepare.apply", { container: "C", value: 1 })).toMatchObject({ ok: false, denial: { rule: "forbidden" } });
      expect(f.effects()).toBe(0);
      expect(await f.host.dispatch(f.auth.authenticate(both.token), "test.prepare.apply", { container: "C", value: 1 })).toEqual({ ok: true, result: { value: 1 } });
      expect(f.effects()).toBe(1);
    } finally { f.close(); }
  });

  test.each(["ceiling", "fixed count"])("%s violation cannot execute", async (violation) => {
    const f = await fixture({ caps: [], prepare: async (_ctx, args) => ({
      args, targets: violation === "fixed count" ? [] : [{ kind: "container", containerId: "C" }],
      additionalRequirements: violation === "ceiling" ? [shell] : [],
    }) });
    try {
      expect(await f.host.dispatch(f.owner, "test.prepare.apply", { container: "C", value: 1 })).toMatchObject({ ok: false, denial: { rule: "invalid_args" } });
      expect(f.effects()).toBe(0);
    } finally { f.close(); }
  });
});
