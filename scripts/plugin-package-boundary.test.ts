import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPluginPackage, pluginApiImportAllowed } from "./plugin-package-boundary.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "manifold-package-boundary-"));
  const manifest = {
    id: "example.optional",
    version: "1.0.0",
    title: "Optional author fixture",
    description: "Disposable source-classification consumer.",
    capabilities: [],
    contributes: {},
    entry: { server: true },
  };
  writeFileSync(join(directory, "server.ts"), "export {};\n");
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "@manifold-plugin/fixture",
      private: true,
      type: "module",
      exports: { ".": "./server.ts" },
    }),
  );
  return {
    directory,
    manifest,
    authored(value: unknown = manifest) {
      writeFileSync(join(directory, "manifest.json"), JSON.stringify(value));
    },
    close() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const composed = new Set(["core.fixture", "core.fixture.part"]);

test("a real author-channel directory stays opt-in while shipped declarations require composition", () => {
  const f = fixture();
  try {
    expect(classifyPluginPackage(f.directory, [...composed], composed, new Set())).toEqual({
      optional: false,
      ids: [...composed],
      problems: [],
    });
    expect(classifyPluginPackage(f.directory, [], composed, new Set())).toEqual({
      optional: false,
      ids: [],
      problems: ["missing_manifest"],
    });
    expect(classifyPluginPackage(f.directory, ["core.unregistered"], composed, new Set())).toEqual({
      optional: false,
      ids: ["core.unregistered"],
      problems: ["unregistered_manifest"],
    });
    f.authored();
    expect(classifyPluginPackage(f.directory, [], composed, new Set())).toEqual({
      optional: true,
      ids: [f.manifest.id],
      problems: [],
    });
  } finally {
    f.close();
  }
});

test("adding manifest.json cannot exempt a shipped package or default-compose an authored one", () => {
  const f = fixture();
  try {
    f.authored();
    expect(
      classifyPluginPackage(f.directory, ["core.fixture"], composed, new Set()).problems,
    ).toEqual(["mixed_manifest_classes"]);
    expect(
      classifyPluginPackage(f.directory, [], new Set([...composed, f.manifest.id]), new Set())
        .problems,
    ).toEqual(["default_composed_authored_identity"]);
    expect(
      classifyPluginPackage(f.directory, [], composed, new Set([f.manifest.id])).problems,
    ).toEqual(["duplicate_authored_identity"]);
    f.authored({ ...f.manifest, id: "core.optional" });
    expect(classifyPluginPackage(f.directory, [], composed, new Set()).problems).toEqual([
      "reserved_authored_identity",
    ]);
  } finally {
    f.close();
  }
});

test("optional classification requires a valid author manifest and its declared source entries", () => {
  const f = fixture();
  try {
    f.authored({ ...f.manifest, entry: { server: true, web: "web.js" } });
    expect(classifyPluginPackage(f.directory, [], composed, new Set()).problems).toEqual([
      "missing_authored_web",
    ]);
    writeFileSync(join(f.directory, "web.tsx"), "export {};\n");
    expect(classifyPluginPackage(f.directory, [], composed, new Set()).problems).toEqual([]);
    rmSync(join(f.directory, "web.tsx"));
    writeFileSync(join(f.directory, "web.ts"), "export {};\n");
    expect(classifyPluginPackage(f.directory, [], composed, new Set()).problems).toEqual([]);
    rmSync(join(f.directory, "server.ts"));
    expect(classifyPluginPackage(f.directory, [], composed, new Set()).problems).toEqual([
      "missing_authored_server",
    ]);
    f.authored({ ...f.manifest, origin: "https://not-an-author-manifest.invalid" });
    expect(classifyPluginPackage(f.directory, [], composed, new Set()).problems).toEqual([
      "invalid_authored_manifest",
    ]);
    writeFileSync(join(f.directory, "manifest.json"), "{");
    expect(classifyPluginPackage(f.directory, [], composed, new Set()).problems).toEqual([
      "invalid_authored_manifest",
    ]);
  } finally {
    f.close();
  }
});

test("author API admission does not broaden production internals, test tooling, or parent contracts", () => {
  const production = { authored: true, contract: false, test: false };
  const testConsumer = { authored: true, contract: false, test: true };
  const contract = { authored: true, contract: true, test: true };
  const shipped = { authored: false, contract: false, test: false };
  const shippedTest = { authored: false, contract: false, test: true };
  for (const specifier of [
    "@manifold/plugin-kit",
    "@manifold/plugin-kit/server",
    "@manifold/plugin-kit/web",
  ]) {
    expect(pluginApiImportAllowed(specifier, production)).toBe(true);
    expect(pluginApiImportAllowed(specifier, contract)).toBe(false);
    expect(pluginApiImportAllowed(specifier, shipped)).toBe(false);
    expect(pluginApiImportAllowed(specifier, shippedTest)).toBe(false);
  }
  for (const specifier of [
    "@manifold/plugin-kit/pack",
    "@manifold/plugin-kit/hub",
    "@manifold/plugin-kit/install",
  ]) {
    expect(pluginApiImportAllowed(specifier, testConsumer)).toBe(true);
    expect(pluginApiImportAllowed(specifier, production)).toBe(false);
    expect(pluginApiImportAllowed(specifier, contract)).toBe(false);
    expect(pluginApiImportAllowed(specifier, shipped)).toBe(false);
    expect(pluginApiImportAllowed(specifier, shippedTest)).toBe(false);
  }
  for (const specifier of [
    "@manifold/server",
    "@manifold/agent",
    "@manifold/web",
    "@manifold/plugin-kit/src/server.ts",
  ]) {
    expect(pluginApiImportAllowed(specifier, production)).toBe(false);
    expect(pluginApiImportAllowed(specifier, testConsumer)).toBe(false);
  }
  for (const specifier of [
    "@manifold/protocol",
    "@manifold/scene",
    "@manifold/sdk",
    "@manifold/plugin",
  ]) {
    expect(pluginApiImportAllowed(specifier, production)).toBe(true);
    expect(pluginApiImportAllowed(specifier, contract)).toBe(true);
    expect(pluginApiImportAllowed(specifier, shipped)).toBe(true);
  }
  for (const specifier of ["@manifold/plugin/hooks", "@manifold/plugin/ui", "@manifold/ui"]) {
    expect(pluginApiImportAllowed(specifier, production)).toBe(true);
    expect(pluginApiImportAllowed(specifier, contract)).toBe(false);
    expect(pluginApiImportAllowed(specifier, shipped)).toBe(true);
  }
});
