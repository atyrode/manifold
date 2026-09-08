import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  enrollMachine,
  startAgent,
  startServer,
  type TestAgent,
  type TestServer,
} from "../src/index.ts";
import { e2eFailure, stopProcesses } from "./helpers.ts";

const FAKE_OWNER_KEY = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const FAKE_PORT = 43_129;

test("startServer parses a fake bun ready line and stop terminates the child", async () => {
  const root = await mkdtemp("/tmp/manifold-testkit-self-");
  const binDir = `${root}/bin`;
  const dataDir = `${root}/data`;
  let server: TestServer | null = null;
  const inheritedManifoldValue = process.env.MANIFOLD_INHERITED_TEST;
  process.env.MANIFOLD_INHERITED_TEST = "must-not-leak";
  try {
    await mkdir(binDir, { recursive: true });
    const fakeBun = `${binDir}/bun`;
    const expression =
      'console.log(`inherited=${process.env.MANIFOLD_INHERITED_TEST ?? "<unset>"}`);' +
      'console.log(`explicit=${process.env.MANIFOLD_EXPLICIT_TEST ?? "<unset>"}`);' +
      `console.log("manifold ready url=http://127.0.0.1:${FAKE_PORT}/#key=${FAKE_OWNER_KEY}");` +
      // The fake child must remain alive until stop() proves SIGTERM waiting; no application
      // event exists to await because this is intentionally only a process-lifecycle fixture.
      "await Bun.sleep(60000)";
    await writeFile(fakeBun, `#!/bin/sh\nexec "${process.execPath}" -e '${expression}'\n`, "utf8");
    await chmod(fakeBun, 0o755);

    server = await startServer({
      dataDir,
      port: 0,
      ownerKey: FAKE_OWNER_KEY,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        MANIFOLD_EXPLICIT_TEST: "kept",
      },
    });
    expect(server.url).toBe(`http://127.0.0.1:${FAKE_PORT}/#key=${FAKE_OWNER_KEY}`);
    expect(server.port).toBe(FAKE_PORT);
    expect(server.ownerKey).toBe(FAKE_OWNER_KEY);
    expect(server.httpUrl).toBe(`http://127.0.0.1:${FAKE_PORT}`);
    expect(server.wsUrl).toBe(`ws://127.0.0.1:${FAKE_PORT}/ws/session`);
    expect(server.dataDir).toBe(dataDir);
    expect(server.output.stdout).toContain("inherited=<unset>");
    expect(server.output.stdout).toContain("explicit=kept");

    await server.stop();
    expect(typeof (await server.proc.exited)).toBe("number");
  } catch (error) {
    throw e2eFailure(error, [server]);
  } finally {
    if (inheritedManifoldValue === undefined) delete process.env.MANIFOLD_INHERITED_TEST;
    else process.env.MANIFOLD_INHERITED_TEST = inheritedManifoldValue;
    await stopProcesses([server]);
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

test("startAgent preserves spawn and wait errors when Bun returns no pipe streams", async () => {
  // Scope the Bun.spawn replacement to a disposable process, not the e2e runner.
  // This exercises the public fixture without introducing a production spawn seam.
  const source = `
    import { strict as assert } from "node:assert";
    import { existsSync } from "node:fs";
    import { dirname } from "node:path";
    import { spyOn } from "bun:test";
    import { startAgent } from ${JSON.stringify(new URL("../src/spawn.ts", import.meta.url).pathname)};
    const options = {
      serverUrl: "http://127.0.0.1:43129/#key=${FAKE_OWNER_KEY}",
      machineToken: "unused",
    };
    for (const mode of ["exit", "wait-error", "throw", "missing-live-pipes"]) {
      const original = new Error("original " + mode + " failure");
      const ended = Promise.withResolvers();
      let socketDir;
      const fake = {
        pid: 12345, exitCode: mode === "exit" ? 1 : null, signalCode: null,
        stdout: undefined, stderr: undefined,
        exited: ended.promise,
        kill() { fake.exitCode = 143; ended.resolve(143); },
      };
      const spawn = spyOn(Bun, "spawn").mockImplementation((_command, config) => {
        socketDir = dirname(config.env.MANIFOLD_TERMINAL_HOST_SOCKET);
        if (mode === "throw") throw original;
        if (mode === "wait-error") {
          config.onExit(fake, null, null, original);
          ended.reject(original);
        } else if (mode === "exit") ended.resolve(1);
        return fake;
      });
      try {
        await assert.rejects(startAgent(options), (error) => {
          assert(!error.message.includes("getReader"), error.message);
          if (mode === "exit") assert(error.message.includes("code=1"), error.message);
          if (mode === "exit" || mode === "missing-live-pipes") {
            assert(error.message.includes('stdout pipe unavailable'), error.message);
            assert(error.message.includes('stderr pipe unavailable'), error.message);
          }
          if (mode === "wait-error" || mode === "throw") {
            assert(error.message.includes(original.message), error.message);
            assert.equal(error.cause.cause, original);
          }
          return true;
        });
        assert(socketDir);
        assert.equal(existsSync(socketDir), false, "failed start leaked its socket directory");
      } finally {
        spawn.mockRestore();
      }
    }
  `;
  const child = Bun.spawn([process.execPath, "-e", source], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}, 10_000);

test("startServer reports both final output tails when a child exits before readiness", async () => {
  const root = await mkdtemp("/tmp/manifold-testkit-failed-start-");
  try {
    const fakeBun = `${root}/bun`;
    await writeFile(
      fakeBun,
      "#!/bin/sh\nprintf 'startup stdout tail'\nprintf 'startup stderr reason' >&2\nexit 37\n",
    );
    await chmod(fakeBun, 0o755);
    await expect(
      startServer({
        dataDir: `${root}/data`,
        env: { PATH: root },
      }),
    ).rejects.toThrow(/37[\s\S]*startup stdout tail[\s\S]*startup stderr reason/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

test("restartTransport reports replacement failure and retains the owned host", async () => {
  const root = await mkdtemp("/tmp/manifold-testkit-failed-restart-");
  let server: TestServer | null = null;
  let agent: TestAgent | null = null;
  try {
    const fakeBun = `${root}/bun`;
    await writeFile(fakeBun, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
    await chmod(fakeBun, 0o755);
    server = await startServer({ dataDir: `${root}/data` });
    const { machineToken } = await enrollMachine(server, "failed-restart");
    agent = await startAgent({
      serverUrl: server.url,
      machineToken,
      name: "failed-restart",
      env: { PATH: `${root}:${process.env.PATH ?? ""}` },
    });
    const host = agent.host;
    const oldTransport = agent.proc;
    await writeFile(fakeBun, "#!/bin/sh\nprintf 'replacement startup reason' >&2\nexit 37\n");
    await expect(agent.restartTransport()).rejects.toThrow(/37[\s\S]*replacement startup reason/);
    expect(oldTransport.exitCode !== null || oldTransport.signalCode !== null).toBe(true);
    expect(agent.proc.exitCode).toBe(37);
    expect(host.exitCode).toBeNull();
    await agent.stop();
    expect(host.exitCode !== null || host.signalCode !== null).toBe(true);
  } finally {
    await stopProcesses([agent, server]);
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
