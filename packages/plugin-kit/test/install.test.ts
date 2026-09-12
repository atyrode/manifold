import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerAction, roster } from "../src/hub.ts";
import { installBundle } from "../src/install.ts";
import { canSpawnServer, startServer } from "../src/verify.ts";

// Build-free bundles against the actual engine, not a toggle-call mock. Native ownership
// continuity is covered alongside PluginHost and JobService in the server suite.
test.skipIf(!canSpawnServer())(
  "install preserves an operator-disabled row on success, refusal and pinned-byte mismatch",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-kit-install-"));
    const server = await startServer().catch((error: unknown) => {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    });
    const id = "example.retained";
    try {
      const bundle = async (version: string, missing = false) => {
        const source = join(dir, `${version}.manifold-plugin.json`);
        await Bun.write(source, JSON.stringify({
          format: 1,
          manifest: {
            id, version, title: "Retained", description: "Installer continuity regression",
            capabilities: [], contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
            entry: { web: "web.js" },
            ...(missing ? { dependencies: { "example.absent": { type: "required" } } } : {}),
          },
          files: { "web.js": Buffer.from(`export const version = ${JSON.stringify(version)};`).toString("base64") },
        }));
        return source;
      };
      const first = await bundle("1.0.0");
      const initial = await installBundle({ source: first, hub: server });
      expect(initial.outcome).toBe("installed");
      await ownerAction(server, "engine.plugins.setEnabled", { id, enabled: false });
      const disabled = (await roster(server)).find((row) => row.manifest.id === id)!;
      const broken = await bundle("9.0.0", true);
      await expect(installBundle({ source: broken, hub: server })).rejects.toThrow("artifact_invalid");
      expect((await roster(server)).find((row) => row.manifest.id === id)).toEqual(disabled);
      const second = await bundle("2.0.0");
      const replacement = await installBundle({ source: second, hub: server });
      expect(replacement.outcome).toBe("replaced");
      expect((await roster(server)).find((row) => row.manifest.id === id)).toMatchObject({
        enabled: false, manifest: { version: "2.0.0" }, install: { sha256: replacement.sha256 },
      });
      await expect(installBundle({ source: first, sha256: replacement.sha256, hub: server })).rejects.toThrow("not the pinned");
      expect((await roster(server)).find((row) => row.manifest.id === id)?.enabled).toBe(false);
      await ownerAction(server, "engine.plugins.setEnabled", { id, enabled: true });
      const module = await fetch(`${server.url}/api/plugins/${id}/web.js`, {
        headers: { authorization: `Bearer ${server.ownerKey}` },
      });
      expect(module.status).toBe(200);
      expect(await module.text()).toBe('export const version = "2.0.0";');
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  90_000,
);
