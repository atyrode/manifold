import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("headless Chromium does not inherit runner DBus addresses", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "manifold-cdp-environment-"));
  try {
    const chromium = join(fixture, "chromium");
    writeFileSync(
      chromium,
      `#!/bin/sh
if [ "\${DBUS_SESSION_BUS_ADDRESS+x}" = x ]; then exit 91; fi
if [ "\${DBUS_SYSTEM_BUS_ADDRESS+x}" = x ]; then exit 92; fi
if [ "\${MANIFOLD_CDP_TEST_SENTINEL:-}" != preserved ]; then exit 93; fi
exit 23
`,
      { mode: 0o755 },
    );
    const cdp = pathToFileURL(join(import.meta.dir, "cdp.ts")).href;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { Browser } from ${JSON.stringify(cdp)};
const browser = new Browser();
try { await browser.launch({ incognito: true }); }
catch (error) { console.log(String(error)); }
finally { await browser.close(); }`,
      ],
      {
        env: {
          ...process.env,
          MANIFOLD_CHROMIUM: chromium,
          MANIFOLD_CDP_TEST_SENTINEL: "preserved",
          DBUS_SESSION_BUS_ADDRESS: "malformed:runner-session",
          DBUS_SYSTEM_BUS_ADDRESS: "malformed:runner-system",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("chromium exited with code 23");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

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
