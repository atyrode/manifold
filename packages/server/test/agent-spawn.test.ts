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

function fixture(readCmdline: AgentSpawnDeps["readCmdline"], localMachineName = "local") {
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
    localMachineName,
    announceKey: false,
    pluginDevPaths: false,
    identity: { version: "0.0.0", build: "0.0.0", channel: "development" },
  };
  const store = testStore();
  const auth = new AuthService(store, config.ownerKey, new FakeRuntime());
  const spawned: number[] = [];
  const spawnedEnvs: Record<string, string>[] = [];
  const spawnedCommands: string[][] = [];
  const deps: AgentSpawnDeps = {
    platform: "linux",
    pid: 4242,
    readCmdline,
    processExists: () => true,
    spawn: (command, options) => {
      const pid = 9000 + spawned.length;
      spawned.push(pid);
      spawnedEnvs.push({ ...options.env });
      spawnedCommands.push([...command]);
      return { pid, unref() {} };
    },
  };
  const logger: Logger = { info() {}, warn() {}, error() {} };
  return { config, store, auth, spawned, spawnedEnvs, spawnedCommands, deps, logger };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("local agent spawn ownership", () => {
  test("a recycled non-agent PID does not suppress spawning either half", () => {
    const value = fixture(() => "bun test packages/server/test/agent-spawn.test.ts");
    writeFileSync(join(value.config.dataDir, "agent.pid"), `${process.pid}\n`);
    writeFileSync(join(value.config.dataDir, "terminal-host.pid"), `${process.pid}\n`);

    const lease = spawnLocalAgent(
      value.config,
      7777,
      value.auth,
      value.store,
      value.logger,
      value.deps,
    );

    // The host is started first, with the flag and only the socket; the transport gets the
    // same socket beside its dial config and never a flag of its own.
    expect(value.spawned).toEqual([9000, 9001]);
    expect(value.spawnedCommands[0]).toEqual([
      "bun",
      "packages/agent/src/main.ts",
      "--terminal-host",
    ]);
    expect(value.spawnedCommands[1]).toEqual(["bun", "packages/agent/src/main.ts"]);
    const socketPath = join(value.config.dataDir, "terminal-host", "host.sock");
    expect(value.spawnedEnvs[0]?.["MANIFOLD_TERMINAL_HOST_SOCKET"]).toBe(socketPath);
    expect(value.spawnedEnvs[0]?.["MANIFOLD_MACHINE_TOKEN"]).toBeUndefined();
    expect(value.spawnedEnvs[1]?.["MANIFOLD_TERMINAL_HOST_SOCKET"]).toBe(socketPath);
    expect(value.spawnedEnvs[1]?.["MANIFOLD_MACHINE_TOKEN"]).toBeDefined();
    expect(lease?.terminalHostPid).toBe(9000);
    expect(lease?.pid).toBe(9001);
    lease?.release();
    value.store.close();
  });

  test("a genuine live transport PID is reused while a missing host is started", () => {
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

    expect(value.spawned).toEqual([9000]);
    expect(value.spawnedCommands[0]).toContain("--terminal-host");
    expect(lease?.pid).toBe(8123);
    expect(lease?.terminalHostPid).toBe(9000);
    lease?.release();
    value.store.close();
  });

  test("a live host is reused by name and never restarted for a transport restart", () => {
    // The host pid file must name a HOST: the same entry without the flag is a transport, and
    // a transport that recorded itself as the host would otherwise mask a missing owner.
    const value = fixture((pid) =>
      pid === 8100
        ? "bun\0packages/agent/src/main.ts\0--terminal-host\0"
        : "bun\0packages/agent/src/main.ts\0",
    );
    writeFileSync(join(value.config.dataDir, "terminal-host.pid"), "8100\n");

    const first = spawnLocalAgent(
      value.config,
      7777,
      value.auth,
      value.store,
      value.logger,
      value.deps,
    );
    expect(value.spawned).toEqual([9000]); // only the transport
    expect(value.spawnedCommands[0]).toEqual(["bun", "packages/agent/src/main.ts"]);
    expect(first?.terminalHostPid).toBe(8100);
    first?.release();

    // A transport recorded in the host's file is not a host.
    writeFileSync(join(value.config.dataDir, "terminal-host.pid"), "8123\n");
    const second = spawnLocalAgent(
      value.config,
      7777,
      value.auth,
      value.store,
      value.logger,
      value.deps,
    );
    expect(value.spawned).toEqual([9000, 9001]);
    expect(value.spawnedCommands[1]).toContain("--terminal-host");
    expect(second?.terminalHostPid).toBe(9001);
    expect(second?.pid).toBe(9000); // 9000's cmdline is a transport's, so it is reused
    second?.release();
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

    expect(value.spawned).toEqual([9000, 9001]);
    expect(lease?.pid).toBe(9001);
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

    expect(value.spawned).toEqual([9000, 9001]);
    expect(first?.pid).toBe(9001);
    expect(second).toBeNull();
    expect(existsSync(join(value.config.dataDir, "agent.lock"))).toBe(true);

    first?.release();
    expect(existsSync(join(value.config.dataDir, "agent.lock"))).toBe(false);
    value.store.close();
  });

  test("a lock recording our own pid is stale (container PID-namespace reuse)", () => {
    // Unclean container death: the volume keeps agent.lock with pid 1, and the
    // restarted server is pid 1 again with the SAME server cmdline — the
    // liveness check alone would wrongly conclude another server holds it.
    const value = fixture(() => "bun\0packages/server/src/main.ts\0");
    writeFileSync(join(value.config.dataDir, "agent.lock"), `${value.deps.pid}\n`);

    const lease = spawnLocalAgent(
      value.config,
      7777,
      value.auth,
      value.store,
      value.logger,
      value.deps,
    );

    expect(value.spawned).toEqual([9000, 9001]);
    expect(lease?.pid).toBe(9001);
    lease?.release();
    expect(existsSync(join(value.config.dataDir, "agent.lock"))).toBe(false);
    value.store.close();
  });
});

describe("configurable local machine name", () => {
  test("a custom name enrolls the machine and reaches the child env", () => {
    const value = fixture(() => "not-an-agent", "hub");

    const lease = spawnLocalAgent(
      value.config,
      7777,
      value.auth,
      value.store,
      value.logger,
      value.deps,
    );

    expect(value.store.getMachineByName("hub")).not.toBeNull();
    expect(value.store.getMachineByName("local")).toBeNull();
    expect(value.spawnedEnvs[1]?.["MANIFOLD_MACHINE_NAME"]).toBe("hub");
    lease?.release();
    value.store.close();
  });

  test("a second boot under the same name rotates instead of duplicating", () => {
    const value = fixture(() => "not-an-agent", "hub");
    const first = spawnLocalAgent(
      value.config,
      7777,
      value.auth,
      value.store,
      value.logger,
      value.deps,
    );
    first?.release();
    // A stale token file from another machine identity must not be honored.
    writeFileSync(join(value.config.dataDir, "agent.token"), "not-a-valid-token\n");

    const second = spawnLocalAgent(
      value.config,
      7777,
      value.auth,
      value.store,
      value.logger,
      value.deps,
    );

    expect(value.store.listMachines().filter((machine) => machine.name === "hub")).toHaveLength(1);
    expect(value.spawnedEnvs).toHaveLength(4); // host + transport, twice
    second?.release();
    value.store.close();
  });

  test("a valid saved token keeps its machine identity when the configured name changes", () => {
    const value = fixture(() => "not-an-agent");
    const first = spawnLocalAgent(
      value.config,
      7777,
      value.auth,
      value.store,
      value.logger,
      value.deps,
    );
    first?.release();

    // Same data dir, new configured name: the saved token wins at spawn time
    // (the documented seed-strips-agent.token edge in docs/SELF-HOST.md).
    value.config.localMachineName = "hub";
    const second = spawnLocalAgent(
      value.config,
      7777,
      value.auth,
      value.store,
      value.logger,
      value.deps,
    );

    expect(value.store.getMachineByName("local")).not.toBeNull();
    expect(value.store.getMachineByName("hub")).toBeNull();
    expect(value.spawnedEnvs[3]?.["MANIFOLD_MACHINE_NAME"]).toBe("hub");
    second?.release();
    value.store.close();
  });
});
