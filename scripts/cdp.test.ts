import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { settles } from "./gate-lib.ts";

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

test("a Chromium that exits before answering fails launch at once, with its stderr", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "manifold-cdp-early-exit-"));
  try {
    const chromium = join(fixture, "chromium");
    writeFileSync(chromium, `#!/bin/sh\necho "chromium fixture refused to start" >&2\nexit 3\n`, {
      mode: 0o755,
    });
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
    // The pipe closing ends the launch with the browser's own diagnostics, well inside this
    // test's bound rather than at the 60 s launch deadline.
    expect(stdout).toContain("chromium exited with code 3");
    expect(stdout).toContain("chromium fixture refused to start");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 20_000);

test("a driver killed mid-run leaves no Chromium, private bus or profile behind", async () => {
  const cdp = pathToFileURL(join(import.meta.dir, "cdp.ts")).href;
  const driver = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { Browser } from ${JSON.stringify(cdp)};
const browser = new Browser();
await browser.launch();
await browser.goto("data:text/html,alive");
console.log("launched");
await Promise.withResolvers().promise;`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const processes = (): { pid: number; ppid: number; zombie: boolean; args: string }[] =>
    Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,stat=,args="])
      .stdout.toString()
      .split("\n")
      .flatMap((line) => {
        const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (row === null) return [];
        const [, pid, ppid, stat, args] = row;
        const zombie = stat?.startsWith("Z") ?? false;
        return [{ pid: Number(pid), ppid: Number(ppid), zombie, args: args ?? "" }];
      });
  try {
    let said = "";
    for await (const chunk of driver.stdout) {
      said += new TextDecoder().decode(chunk);
      if (said.includes("launched")) break;
    }
    expect(said).toContain("launched");
    const table = processes();
    // Everything the driver started: the private bus, the supervisor, Chromium and its helpers.
    const launched: typeof table = [];
    const parents = [driver.pid];
    for (let parent = parents.pop(); parent !== undefined; parent = parents.pop()) {
      for (const row of table) {
        if (row.ppid !== parent) continue;
        launched.push(row);
        parents.push(row.pid);
      }
    }
    const commandLines = launched.map((row) => row.args).join("\n");
    const profile = /--user-data-dir=(\S+)/.exec(commandLines)?.[1];
    const busSocket = /--address=unix:path=(\S+)/.exec(commandLines)?.[1];
    expect(profile).toBeDefined();
    expect(existsSync(profile ?? "")).toBe(true);
    expect(driver.exitCode).toBeNull();

    // What a harness timeout does: nothing in the driver gets to run.
    driver.kill("SIGKILL");
    await driver.exited;
    const leftovers = (): string[] => {
      const alive = new Set(processes().flatMap((row) => (row.zombie ? [] : [row.pid])));
      const paths = [profile, busSocket].filter((path) => path !== undefined);
      return [
        ...launched.flatMap((row) => (alive.has(row.pid) ? [row.args] : [])),
        ...paths.filter((path) => existsSync(path)),
      ];
    };
    // Polled: the supervisor and Chromium are nobody's children here, so there is no exit to await.
    await settles(() => leftovers().length === 0, 20_000);
    expect(leftovers()).toEqual([]);
  } finally {
    if (driver.exitCode === null) driver.kill("SIGKILL");
    await driver.exited;
  }
}, 60_000);

test("a renderer killed while the driver waits fails the page at once, not at a deadline", async () => {
  const cdp = pathToFileURL(join(import.meta.dir, "cdp.ts")).href;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { Browser, PageLostError } from ${JSON.stringify(cdp)};
const browser = new Browser();
const outcome = (error) => (error instanceof PageLostError ? "PageLostError: " : "other: ") + error.message;
try {
  await browser.launch();
  await browser.goto("data:text/html,busy");
  // The page stops answering, as while a long check runs; a command is left waiting on it.
  await browser.send("Runtime.evaluate", { expression: "setTimeout(() => { for (;;); })" });
  const waiting = browser.evaluate("1").then(() => "answered", outcome);
  // As earlyoom does: SIGTERM to the renderers, from outside the browser.
  const info = await browser.send("SystemInfo.getProcessInfo", {}, false);
  for (const entry of info.result.processInfo) if (entry.type === "renderer") process.kill(entry.id, "SIGTERM");
  console.log("lost " + (await browser.lost.then(() => "resolved", outcome)));
  console.log("waiting " + (await waiting));
  console.log("later " + (await browser.evaluate("1").then(() => "answered", outcome)));
} finally { await browser.close(); }`,
    ],
    // Below the driver's 30 s command deadline: a loss noticed only by a timeout fails this.
    { stdout: "pipe", stderr: "pipe", timeout: 25_000, killSignal: "SIGKILL" },
  );
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("lost PageLostError: renderer crashed");
  expect(stdout).toContain("waiting PageLostError: cdp Runtime.evaluate: renderer crashed");
  expect(stdout).toContain("later PageLostError: cdp Runtime.evaluate: renderer crashed");
}, 40_000);

test("a browser relaunched after its page was lost drives a page of its own", async () => {
  const cdp = pathToFileURL(join(import.meta.dir, "cdp.ts")).href;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { Browser, PageLostError } from ${JSON.stringify(cdp)};
const browser = new Browser();
try {
  await browser.launch();
  await browser.goto("data:text/html,first");
  const info = await browser.send("SystemInfo.getProcessInfo", {}, false);
  for (const entry of info.result.processInfo) if (entry.type === "renderer") process.kill(entry.id, "SIGTERM");
  console.log("lost " + (await browser.lost.then(() => "resolved", (error) => error instanceof PageLostError)));
  await browser.relaunch();
  await browser.goto("data:text/html,second");
  console.log("page " + (await browser.evaluate("document.body.textContent")));
  console.log("product " + browser.product);
} finally { await browser.close(); }`,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 50_000, killSignal: "SIGKILL" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  expect(stdout).toContain("lost true");
  expect(stdout).toContain("page second");
  expect(stdout).toMatch(/product \S+\/\d+\./);
}, 60_000);
