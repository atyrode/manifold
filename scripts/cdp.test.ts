import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("headless Chromium never contacts an inherited runner bus", async () => {
  let connections = 0;
  const bus = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        connections += 1;
        socket.end();
      },
      data() {},
    },
  });
  const cdp = pathToFileURL(join(import.meta.dir, "cdp.ts")).href;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { Browser } from ${JSON.stringify(cdp)};
const browser = new Browser();
let closing;
const close = () => (closing ??= browser.close());
process.once("SIGTERM", () => {
  void close().finally(() => process.exit(124));
});
try {
  await browser.launch({ incognito: true });
  await browser.goto("data:text/html,<button data-testid='probe' onclick='this.textContent=42'>start</button>");
  await browser.clickTestId("probe");
  if (await browser.evaluate("document.querySelector('button').textContent") !== "42") {
    throw new Error("browser did not deliver the click");
  }
} finally { await close(); }`,
    ],
    {
      env: {
        ...process.env,
        DBUS_SESSION_BUS_ADDRESS: `tcp:host=127.0.0.1,port=${String(bus.port)}`,
        DBUS_SYSTEM_BUS_ADDRESS: `tcp:host=127.0.0.1,port=${String(bus.port)}`,
      },
      stdout: "ignore",
      stderr: "pipe",
      timeout: 60_000,
      killSignal: "SIGTERM",
    },
  );
  try {
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(connections).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    bus.stop(true);
  }
}, 70_000);

test("a devtools probe that is accepted but never answered cannot outlive launch", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "manifold-cdp-stalled-probe-"));
  try {
    const devtools = join(fixture, "devtools.ts");
    writeFileSync(
      devtools,
      `const flag = process.argv.find((arg) => arg.startsWith("--remote-debugging-port="));
const port = Number(flag?.split("=")[1]);
let probes = 0;
Bun.serve({
  hostname: "127.0.0.1",
  port,
  // A browser endpoint has no server idle timeout that would rescue a stalled probe.
  idleTimeout: 0,
  fetch(request) {
    if (new URL(request.url).pathname !== "/json/version") {
      return new Response("no devtools socket", { status: 503 });
    }
    probes += 1;
    if (probes === 1) {
      console.error("devtools fixture held its first probe open");
      return new Promise<Response>(() => {});
    }
    return Response.json({
      webSocketDebuggerUrl: "ws://127.0.0.1:" + String(port) + "/devtools/browser/fixture",
    });
  },
});
`,
    );
    const chromium = join(fixture, "chromium");
    writeFileSync(
      chromium,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(devtools)} "$@"\n`,
      { mode: 0o755 },
    );
    const cdp = pathToFileURL(join(import.meta.dir, "cdp.ts")).href;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { Browser } from ${JSON.stringify(cdp)};
const browser = new Browser();
try { await browser.launch({ incognito: true }); console.log("launched"); }
catch (error) { console.log(String(error)); }
finally { await browser.close(); }`,
      ],
      { env: { ...process.env, MANIFOLD_CHROMIUM: chromium }, stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(exitCode).toBe(0);
    // The launch moved past the stalled probe to the advertised socket, whose refusal is
    // reported with the browser's own diagnostics instead of an unexplained test timeout.
    expect(stdout).toMatch(/cdp socket (failed|closed before opening)/);
    expect(stdout).toContain("devtools fixture held its first probe open");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 20_000);
