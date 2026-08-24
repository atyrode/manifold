import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnLocalAgent, type AgentSpawnDeps } from "../src/agent-spawn.ts";
import { AuthService } from "../src/auth.ts";
import type { ServerConfig } from "../src/config.ts";
import type { Logger } from "../src/log.ts";
import { FakeRuntime, testStore } from "./helpers.ts";

const temporaryDirectories: string[] = [];

function fixture(readCmdline: AgentSpawnDeps["readCmdline"]) {
  const dataDir = mkdtempSync(join(tmpdir(), "manifold-agent-spawn-test-"));
  temporaryDirectories.push(dataDir);
  const config: ServerConfig = {
    port: 0,
    hostname: "127.0.0.1",
    dataDir,
    ownerKey: "a".repeat(64),
    publicUrl: "http://127.0.0.1:7777",
    publicUrlExplicit: false,
    webDist: join(dataDir, "web"),
    spawnAgent: true,
  };
  const store = testStore();
  const auth = new AuthService(store, config.ownerKey, new FakeRuntime());
  const spawned: number[] = [];
  const deps: AgentSpawnDeps = {
    platform: "linux",
    pid: 4242,
    readCmdline,
    processExists: () => true,
    spawn: () => {
      const pid = 9000 + spawned.length;
      spawned.push(pid);
      return { pid, unref() {} };
    },
  };
  const logger: Logger = { info() {}, warn() {}, error() {} };
  return { config, store, auth, spawned, deps, logger };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("local agent spawn ownership", () => {
  test("a recycled non-agent PID does not suppress spawning", () => {
    const value = fixture(() => "bun test packages/server/test/agent-spawn.test.ts");
    writeFileSync(join(value.config.dataDir, "agent.pid"), `${process.pid}\n`);

    const lease = spawnLocalAgent(
      value.config,
      7777,
      value.auth,
      value.store,
      value.logger,
      value.deps,
    );

    expect(value.spawned).toEqual([9000]);
    expect(lease?.pid).toBe(9000);
    lease?.release();
    value.store.close();
  });

  test("a genuine live agent PID is reused", () => {
    const value = fixture(() => "bun\0packages/agent/src/main.ts\0");
    writeFileSync(join(value.config.dataDir, "agent.pid"), "8123\n");

    const lease = spawnLocalAgent(
      value.config,
      7777,
      value.auth,
      value.store,
      value.logger,
      value.deps,
    );

    expect(value.spawned).toEqual([]);
    expect(lease?.pid).toBe(8123);
    lease?.release();
    value.store.close();
  });

  test("a stale boot lock is replaced", () => {
    const value = fixture(() => "unrelated-process");
    writeFileSync(join(value.config.dataDir, "agent.lock"), "7331\n");

    const lease = spawnLocalAgent(
      value.config,
      7777,
      value.auth,
      value.store,
      value.logger,
      value.deps,
    );

    expect(value.spawned).toEqual([9000]);
    expect(lease?.pid).toBe(9000);
    lease?.release();
    value.store.close();
  });

  test("an exclusive boot lock prevents concurrent agent spawning", () => {
    const value = fixture((pid) =>
      pid === value.deps.pid
        ? "bun\0packages/server/src/main.ts\0"
        : "bun\0packages/agent/src/main.ts\0",
    );
    const first = spawnLocalAgent(
      value.config,
      7777,
      value.auth,
      value.store,
      value.logger,
      value.deps,
    );
    const second = spawnLocalAgent(
      value.config,
      7777,
      value.auth,
      value.store,
      value.logger,
      value.deps,
    );

    expect(value.spawned).toEqual([9000]);
    expect(first?.pid).toBe(9000);
    expect(second).toBeNull();
    expect(existsSync(join(value.config.dataDir, "agent.lock"))).toBe(true);

    first?.release();
    expect(existsSync(join(value.config.dataDir, "agent.lock"))).toBe(false);
    value.store.close();
  });
});
