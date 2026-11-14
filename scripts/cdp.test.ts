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
let phase = "launch";
const close = () => (closing ??= browser.close());
process.once("SIGTERM", () => {
  console.error("cdp-probe-timeout:" + phase);
  void close().finally(() => process.exit(124));
});
try {
  await browser.launch({ incognito: true });
  phase = "navigate";
  await browser.goto("data:text/html,<button data-testid='probe' onclick='this.textContent=42'>start</button>");
  phase = "click";
  await browser.clickTestId("probe");
  phase = "evaluate";
  if (await browser.evaluate("document.querySelector('button').textContent") !== "42") {
    throw new Error("browser did not deliver the click");
  }
} finally { phase = "close"; await close(); }`,
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
    expect(exitCode, stderr).toBe(0);
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

test.each(["invalid JSON", "unexpected fields"])(
  "an early Chromium exit retains bounded startup and readiness evidence: %s",
  async (responseKind) => {
    const fixture = mkdtempSync(join(tmpdir(), "manifold-cdp-startup-evidence-"));
    let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    try {
      const devtools = join(fixture, "devtools.ts");
      const response =
        responseKind === "invalid JSON"
          ? 'new Response("fixture-response-secret", { status: 503 })'
          : 'Response.json({ Browser: "fixture-response-secret", "Protocol-Version": "fixture-response-secret" }, { status: 503 })';
      writeFileSync(
        devtools,
        `const port = Number(process.argv.find((arg) => arg.startsWith("--remote-debugging-port="))?.split("=")[1]);
if (!Number.isInteger(port)) process.exit(91);
// Parent fake clocks cannot govern this executable; this timer is a safety bound, not a wait.
setTimeout(() => process.exit(29), 4_000);
await Bun.write(Bun.stdout, "fixture stdout first\\nhttps://invalid.example/?token=fixture-url-secret\\n" +
  "startup filler\\n".repeat(16_384) + "fixture stdout last\\n");
await Bun.write(Bun.stderr, "fixture stderr first\\n+ browser --api-key=fixture-command-secret\\n" +
  "MANIFOLD_FIXTURE_SECRET=fixture-env-secret\\n" +
  "native chrome object_path=/org/freedesktop/DBus exit_code=7\\n" + "startup filler\\n".repeat(16_384) +
  "fixture stderr last\\n");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch() {
    // Exit only once the failing HTTP response has actually been written and closed.
    setImmediate(() => { void server.stop().then(() => process.exit(29)); });
    return ${response};
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
      child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { Browser } from ${JSON.stringify(cdp)};
const browser = new Browser();
let closing;
const close = () => (closing ??= browser.close());
process.once("SIGTERM", () => { void close().finally(() => process.exit(124)); });
try { await browser.launch({ incognito: true }); console.log("unexpected launch"); }
catch (error) { console.log(String(error)); }
finally { await close(); }`,
        ],
        {
          env: {
            ...process.env,
            MANIFOLD_CHROMIUM: chromium,
            MANIFOLD_CDP_TEST_PRIVATE: "fixture-inherited-secret",
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
          killSignal: "SIGTERM",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
      expect(stdout).toContain(
        "chromium exited with code 29 before its devtools endpoint came up:",
      );
      expect(stdout).toMatch(/chromium pid=\d+ exitCode=29 signal=not observed/);
      if (process.platform === "linux")
        expect(stdout).toMatch(/private bus: pid=\d+ exitCode=not observed/);
      else expect(stdout).toContain("private bus: not present");
      expect(stdout).toContain("last /json/version response: HTTP 503");
      if (responseKind === "invalid JSON") {
        expect(stdout).toContain("last readiness probe: SyntaxError:");
        expect(stdout).toContain("invalid JSON response (body omitted)");
      } else {
        expect(stdout).toContain("Browser=string present");
        expect(stdout).toContain("Protocol-Version=string present");
        expect(stdout).toContain("last readiness probe: response without a debugger endpoint");
      }
      for (const marker of ["stdout first", "stdout last", "stderr first", "stderr last"]) {
        expect(stdout).toContain(`fixture ${marker}`);
      }
      expect(stdout).toContain("native chrome object_path=/org/freedesktop/DBus exit_code=7");
      expect(stdout.length).toBeLessThan(20_000);
      for (const secret of ["url", "command", "env", "inherited", "response"]) {
        expect(stdout).not.toContain(`fixture-${secret}-secret`);
      }
    } finally {
      if (child !== undefined) {
        if (child.exitCode === null) child.kill("SIGTERM");
        await child.exited;
      }
      rmSync(fixture, { recursive: true, force: true });
    }
  },
  20_000,
);
