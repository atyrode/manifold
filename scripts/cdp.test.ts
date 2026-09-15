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
