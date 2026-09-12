import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerAction, roster } from "../src/hub.ts";
import { BundleOrderError, familyOrder, installBundle } from "../src/install.ts";
import { canSpawnServer, startServer } from "../src/verify.ts";

test("family ordering preserves depth/id order and input identities for independent bundles", () => {
  const bundles = [
    { id: "example.zeta.part.deep" },
    { id: "example.alpha.part" },
    { id: "example.zeta" },
    { id: "example.alpha" },
    { id: "example.zeta.part" },
  ];
  const original = [...bundles];
  const expected = [bundles[3]!, bundles[2]!, bundles[1]!, bundles[4]!, bundles[0]!];
  expect(familyOrder(bundles)).toEqual(expected);
  expect(familyOrder([...bundles].reverse())).toEqual(expected);
  expect(bundles).toEqual(original);
  for (const [index, bundle] of familyOrder(bundles).entries()) {
    expect(bundle).toBe(expected[index]!);
  }
});

test("required parts precede an earlier-sorting client without disturbing ready bundle priority", () => {
  const bundles = [
    {
      id: "example.client",
      requiredDependencies: ["example.zeta", "example.zeta.part", "example.zeta.part"],
    },
    { id: "example.independent" },
    { id: "example.zeta.part" },
    { id: "example.zeta" },
    { id: "example.zeta.unrelated" },
  ];
  const expected = [
    "example.independent",
    "example.zeta",
    "example.zeta.part",
    "example.client",
    "example.zeta.unrelated",
  ];
  expect(familyOrder(bundles).map((bundle) => bundle.id)).toEqual(expected);
  expect(familyOrder([...bundles].reverse()).map((bundle) => bundle.id)).toEqual(expected);
});

test("missing external dependencies are neither supplied nor treated as batch failures", () => {
  const bundles = [
    { id: "example.zeta" },
    { id: "example.client", requiredDependencies: ["outside.missing"] },
  ];
  expect(familyOrder(bundles).map((bundle) => bundle.id)).toEqual([
    "example.client",
    "example.zeta",
  ]);
});

test("duplicate input identities refuse the whole ordering", () => {
  let refusal: unknown;
  try {
    familyOrder([{ id: "example.valid" }, { id: "example.same" }, { id: "example.same" }]);
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(BundleOrderError);
  expect(refusal).toMatchObject({ reason: "duplicate", ids: ["example.same"] });
});

test("cycles through required dependencies, namespace parents and self references refuse", () => {
  const cases = [
    [
      { id: "example.a", requiredDependencies: ["example.z"] },
      { id: "example.z", requiredDependencies: ["example.a"] },
    ],
    [
      { id: "example.parent", requiredDependencies: ["example.parent.part"] },
      { id: "example.parent.part" },
    ],
    [{ id: "example.self", requiredDependencies: ["example.self"] }],
  ];
  for (const bundles of cases) {
    let refusal: unknown;
    try {
      familyOrder([{ id: "example.independent" }, ...bundles]);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(BundleOrderError);
    expect(refusal).toMatchObject({ reason: "cycle", ids: bundles.map((bundle) => bundle.id) });
  }
});

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
        await Bun.write(
          source,
          JSON.stringify({
            format: 1,
            manifest: {
              id,
              version,
              title: "Retained",
              description: "Installer continuity regression",
              capabilities: [],
              contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
              entry: { web: "web.js" },
              ...(missing ? { dependencies: { "example.absent": { type: "required" } } } : {}),
            },
            files: {
              "web.js": Buffer.from(`export const version = ${JSON.stringify(version)};`).toString(
                "base64",
              ),
            },
          }),
        );
        return source;
      };
      const first = await bundle("1.0.0");
      const initial = await installBundle({ source: first, hub: server });
      expect(initial.outcome).toBe("installed");
      await ownerAction(server, "engine.plugins.setEnabled", { id, enabled: false });
      const disabled = (await roster(server)).find((row) => row.manifest.id === id)!;
      const broken = await bundle("9.0.0", true);
      await expect(installBundle({ source: broken, hub: server })).rejects.toThrow(
        "artifact_invalid",
      );
      expect((await roster(server)).find((row) => row.manifest.id === id)).toEqual(disabled);
      const second = await bundle("2.0.0");
      const replacement = await installBundle({ source: second, hub: server });
      expect(replacement.outcome).toBe("replaced");
      expect((await roster(server)).find((row) => row.manifest.id === id)).toMatchObject({
        enabled: false,
        manifest: { version: "2.0.0" },
        install: { sha256: replacement.sha256 },
      });
      await expect(
        installBundle({ source: first, sha256: replacement.sha256, hub: server }),
      ).rejects.toThrow("not the pinned");
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
