import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { startServer, type TestServer } from "../src/index.ts";
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
