import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AuthoredPlugins, authoredLayout, type AuthoredHost } from "../src/authored.ts";
import { silentLogger } from "../src/log.ts";

test("an authored pack that outlives its host cannot replace the successor's bundle", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "manifold-authored-retirement-"));
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const id = "vendor.retired";
  const { dir, bundle } = authoredLayout(dataDir, id);
  const installed: string[] = [];
  const host: AuthoredHost = {
    developerMode: () => true,
    unpackedRow: () => null,
    async installUnpacked(_id, source, sha256) {
      installed.push(readFileSync(source, "utf8"));
      return { id, version: "1.0.0", sha256, grantedCaps: [] };
    },
  };
  const previous = new AuthoredPlugins(dataDir, host, silentLogger, async (_dir, output) => {
    entered.resolve();
    await resume.promise;
    writeFileSync(output, "old bundle");
    return { sha256: "1".repeat(64) };
  });
  const successor = new AuthoredPlugins(dataDir, host, silentLogger, async (_dir, output) => {
    writeFileSync(output, "successor bundle");
    return { sha256: "2".repeat(64) };
  });
  let pending: ReturnType<AuthoredPlugins["rebuild"]> | undefined;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), "{}");
    pending = previous.rebuild(id, "fixture", null);
    await entered.promise;
    previous.close();
    await successor.rebuild(id, "fixture", null);
    resume.resolve();
    expect(await pending).toHaveProperty("refused");
    expect(readFileSync(bundle, "utf8")).toBe("successor bundle");
    expect(installed).toEqual(["successor bundle"]);
    expect(readdirSync(dirname(bundle))).toEqual([bundle.split("/").at(-1)!]);
    await expect(previous.rebuild(id, "fixture", null)).rejects.toThrow();
    expect(readFileSync(bundle, "utf8")).toBe("successor bundle");
  } finally {
    resume.resolve();
    await pending?.catch(() => {});
    previous.close();
    successor.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
