import "../src/shared-modules.ts";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packPlugin } from "@manifold/plugin-kit/pack";
import type { PluginManifest } from "@manifold/protocol";
import { AuthService } from "../src/auth.ts";
import { IsolateSupervisor } from "../src/isolate/supervisor.ts";
import { silentLogger } from "../src/log.ts";
import { PLUGIN_UPLOADS_DIR } from "../src/plugin-installs.ts";
import { RoomManager } from "../src/room.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore, testTileTrees } from "./helpers.ts";

const OWNER_KEY = "e".repeat(64);
const PLUGIN_ID = "test.hardened-preparation-refusal";

test("a real hardened preparer refusal remains refused during review before handler admission", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "manifold-hardened-preparation-refusal-"));
  const runtime = new FakeRuntime();
  const store = testStore();
  const auth = new AuthService(store, OWNER_KEY, runtime);
  const owner = auth.authenticate(OWNER_KEY);
  const clock = new FakeClock(runtime);
  const rooms = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
  const broker = new TerminalBroker(
    store,
    auth,
    rooms,
    runtime,
    clock,
    silentLogger,
    () => "http://localhost:7777",
    testTileTrees,
  );
  const runner = new IsolateSupervisor({ logger: silentLogger, runtime });
  let host: Awaited<ReturnType<typeof testPluginHost>> | undefined;
  try {
    mkdirSync(join(dataDir, PLUGIN_UPLOADS_DIR));
    host = await testPluginHost(store, auth, rooms, broker, runtime, {
      isolates: { runner, dataDir },
    });
    const manifest: PluginManifest = {
      id: PLUGIN_ID,
      version: "1.0.0",
      title: "Hardened preparation refusal",
      description: "",
      capabilities: [],
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
      entry: { server: true },
    };
    const authorDir = join(dataDir, "author");
    mkdirSync(authorDir);
    writeFileSync(join(authorDir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(
      join(authorDir, "server.ts"),
      `
import { z } from ${JSON.stringify(fileURLToPath(import.meta.resolve("zod")))};
import { defineServerAction, defineServerPlugin } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@manifold/plugin-kit/server")))};
const manifest = ${JSON.stringify(manifest)};
const definition = {
  manifest,
  actions: [defineServerAction({
    name: "review", title: "Review", caps: [], input: z.strictObject({}),
    result: z.strictObject({ unexpected: z.literal(true) }),
  })],
  prepareActions: {
    review: {
      caps: [],
      async prepare() { throw new Error("preparer review refused"); },
    },
  },
  handlers: {
    async review(ctx) {
      await ctx.storage.set("handler-effect", "reached");
      return { unexpected: true };
    },
  },
};
defineServerPlugin(definition);
export default definition;
`,
    );
    const packed = await packPlugin(
      authorDir,
      join(dataDir, PLUGIN_UPLOADS_DIR, "review-refusal.manifold-plugin.json"),
    );
    await host.install(
      { source: packed.file, sha256: packed.sha256, grant: [], hardened: false },
      owner.principal.id,
      auth.credentialReference(owner),
    );

    expect(await host.prepareActionInput(owner, `${PLUGIN_ID}.review`, {})).toMatchObject({
      ok: false,
      denial: { rule: "refused", message: "preparer review refused" },
    });
    expect(await store.pluginStorage(PLUGIN_ID).get("handler-effect")).toBeNull();
  } finally {
    host?.close();
    await runner.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
