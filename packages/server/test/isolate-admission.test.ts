import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type { PluginManifest } from "@manifold/protocol";
import { IsolateDenial } from "../src/isolate/contract.ts";
import { IsolateSupervisor } from "../src/isolate/supervisor.ts";
import { silentLogger } from "../src/log.ts";
import type { ActionCtx } from "../src/plugin-host.ts";
import { FakeRuntime, testStore } from "./helpers.ts";

const manifest: PluginManifest = {
  id: "test.admissionguest",
  version: "1.0.0",
  title: "Admission adversary",
  description: "",
  capabilities: [],
  contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
  entry: { server: true },
};

test("an isolated process cannot write or claim success before host admission, even after a refusal", async () => {
  const runtime = new FakeRuntime();
  const store = testStore();
  const supervisor = new IsolateSupervisor({ logger: silentLogger, runtime });
  const storage = store.pluginStorage(manifest.id);
  const principal = { id: "fixture", kind: "agent" as const, name: "Fixture", color: "#123456" };
  let allowed = false;
  const declarationRefusal = new Error("agent declaration required");
  const ctx = {
    traceId: 1,
    principal,
    auth: { principal, caps: [], isRoot: false, containerScope: null, allows: () => false },
    containerScope: null,
    storage,
    now: () => runtime.now(),
    admitPrepared: () => {
      if (!allowed) throw declarationRefusal;
    },
    emit: () => {
      throw new Error("fixture declares no emissions");
    },
  } as unknown as ActionCtx;
  try {
    const { def } = await supervisor.load({
      pluginId: manifest.id,
      manifest,
      dir: resolve(import.meta.dir, "fixtures/isolate-admission-guest"),
    });
    const invoke = def.handlers.write;
    if (invoke === undefined) throw new Error("fixture has no handler");
    await expect(
      invoke(ctx, { key: "before-prepare", prepare: false } as never),
    ).rejects.toBeInstanceOf(IsolateDenial);
    await expect(invoke(ctx, { key: "after-refusal" } as never)).rejects.toBe(declarationRefusal);
    allowed = true;
    await invoke(ctx, { key: "admitted" } as never);
    // The accepted round-trip drains the preceding malicious calls on this same child channel.
    expect(await storage.get("before-prepare")).toBeNull();
    expect(await storage.get("after-refusal")).toBeNull();
    expect(await storage.get("admitted")).toBe("written");
  } finally {
    await supervisor.close();
    store.close();
  }
});
