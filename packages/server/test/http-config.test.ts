import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { MAX_HTTP_BODY_BYTES, parseJsonBody } from "../src/http.ts";
import { startServer } from "../src/main.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "manifold-server-test-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("bounded HTTP request bodies", () => {
  test("an oversized body without content-length is rejected while streaming", async () => {
    const request = new Request("http://localhost/api/pads", {
      method: "POST",
      body: JSON.stringify({ payload: "x".repeat(MAX_HTTP_BODY_BYTES) }),
    });
    expect(request.headers.get("content-length")).toBeNull();

    await expect(parseJsonBody(request)).rejects.toThrow("request body is too large");
  });
});

describe("server bind policy", () => {
  test("defaults to loopback and honors an explicit MANIFOLD_BIND", () => {
    const cwd = temporaryDirectory();
    const common = {
      MANIFOLD_PORT: "0",
      MANIFOLD_DATA_DIR: "data",
      MANIFOLD_OWNER_KEY: "f".repeat(64),
      MANIFOLD_SPAWN_AGENT: "0",
    };

    expect(loadConfig(common, cwd).hostname).toBe("127.0.0.1");
    expect(loadConfig({ ...common, MANIFOLD_BIND: "::1" }, cwd).hostname).toBe("::1");
  });

  test("local machine name defaults, trims, and rejects empty", () => {
    const cwd = temporaryDirectory();
    const common = {
      MANIFOLD_PORT: "0",
      MANIFOLD_DATA_DIR: "data",
      MANIFOLD_OWNER_KEY: "f".repeat(64),
      MANIFOLD_SPAWN_AGENT: "0",
    };

    expect(loadConfig(common, cwd).localMachineName).toBe("local");
    expect(loadConfig({ ...common, MANIFOLD_MACHINE_NAME: "  hub  " }, cwd).localMachineName).toBe(
      "hub",
    );
    expect(() => loadConfig({ ...common, MANIFOLD_MACHINE_NAME: "  " }, cwd)).toThrow(
      "MANIFOLD_MACHINE_NAME must not be empty",
    );
  });

  test("the boot announce embeds the owner key only on explicit opt-in", () => {
    const cwd = temporaryDirectory();
    const common = {
      MANIFOLD_PORT: "0",
      MANIFOLD_DATA_DIR: "data",
      MANIFOLD_OWNER_KEY: "f".repeat(64),
      MANIFOLD_SPAWN_AGENT: "0",
    };

    expect(loadConfig(common, cwd).announceKey).toBe(false);
    expect(loadConfig({ ...common, MANIFOLD_ANNOUNCE_KEY: "0" }, cwd).announceKey).toBe(false);
    expect(loadConfig({ ...common, MANIFOLD_ANNOUNCE_KEY: "1" }, cwd).announceKey).toBe(true);
  });

  test("the real Bun listener appears only on 127.0.0.1 in ss", async () => {
    const cwd = temporaryDirectory();
    const config = loadConfig(
      {
        MANIFOLD_PORT: "0",
        MANIFOLD_DATA_DIR: "data",
        MANIFOLD_OWNER_KEY: "1".repeat(64),
        MANIFOLD_SPAWN_AGENT: "0",
      },
      cwd,
    );
    const running = startServer({ config, announce: false });
    try {
      const result = Bun.spawnSync(["ss", "-tlnp"]);
      expect(result.exitCode).toBe(0);
      const output = result.stdout.toString();
      const listener = output
        .split("\n")
        .find((line) => line.includes(`127.0.0.1:${running.port}`));
      expect(listener).toBeDefined();
      expect(listener).not.toContain(`0.0.0.0:${running.port}`);
    } finally {
      await running.stop();
    }
  });
});
