import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginManifest } from "@manifold/protocol";
import { discoverPlugins } from "../src/dev.ts";
import { BundleOrderError } from "../src/install.ts";

async function manifest(
  root: string,
  directory: string,
  id: string,
  dependencies: PluginManifest["dependencies"] = {},
): Promise<void> {
  await Bun.write(
    join(root, directory, "manifest.json"),
    JSON.stringify({
      id,
      version: "1.0.0",
      title: "Discovery fixture",
      description: "Manifest relationships determine delivery, not directory names.",
      capabilities: [],
      contributes: {},
      dependencies,
    }),
  );
}

test("dev discovery retains required metadata and orders a client after another family's parts", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-kit-discovery-"));
  try {
    await manifest(root, "a-client", "example.alpha", {
      "example.zeta": { type: "required" },
      "example.zeta.part": { type: "required" },
    });
    await manifest(root, "z-provider", "example.zeta", {
      "example.alpha": { type: "optional" },
    });
    await manifest(root, "z-provider/part", "example.zeta.part", {
      "example.zeta": { type: "required" },
      "example.alpha": { type: "incompatible" },
    });
    await manifest(root, "b-independent", "example.beta");
    const discovered = await discoverPlugins(root);
    expect(discovered.map((plugin) => plugin.id)).toEqual([
      "example.beta",
      "example.zeta",
      "example.zeta.part",
      "example.alpha",
    ]);
    expect(discovered.find((plugin) => plugin.id === "example.alpha")).toMatchObject({
      dir: join(root, "a-client"),
      requiredDependencies: ["example.zeta", "example.zeta.part"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dev discovery rejects duplicate ids across different source directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-kit-duplicate-"));
  try {
    await manifest(root, "a-valid", "example.valid");
    await manifest(root, "b-first", "example.duplicate");
    await manifest(root, "c-second", "example.duplicate");
    let refusal: unknown;
    try {
      await discoverPlugins(root);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(BundleOrderError);
    expect(refusal).toMatchObject({ reason: "duplicate", ids: ["example.duplicate"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dev discovery rejects a required cycle before returning an installable batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-kit-cycle-"));
  try {
    await manifest(root, "a-valid", "example.valid");
    await manifest(root, "parent", "example.zeta", {
      "example.zeta.part": { type: "required" },
    });
    await manifest(root, "parent/part", "example.zeta.part", {
      "example.zeta": { type: "required" },
    });
    let refusal: unknown;
    try {
      await discoverPlugins(root);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(BundleOrderError);
    expect(refusal).toMatchObject({
      reason: "cycle",
      ids: ["example.zeta", "example.zeta.part"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
