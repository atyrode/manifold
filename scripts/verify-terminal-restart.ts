/**
 * Real titlebar restart regression: cwd publication, destructive confirmation, exited
 * recovery, stable terminal/leaf identity, and a clean replacement byte stream.
 * Uses the shared gate bundle when MANIFOLD_GATE_DIST is set; otherwise builds its own.
 * MANIFOLD_RESTART_SCREENSHOT optionally retains the final rendered browser screenshot.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionOutcomeSchema,
  ContainerResponseSchema,
  TerminalsResponseSchema,
  type TerminalSummary,
} from "../packages/protocol/src/index.ts";
import { SessionClient } from "../packages/sdk/src/index.ts";
import { Browser } from "./cdp.ts";
import { resolveWebDist } from "./gate-dist.ts";
import { ownerKeyOf, reserveLoopbackPort, sleep, teardownServer, until } from "./gate-lib.ts";

const repoRoot = join(import.meta.dir, "..");
const { distDir, cleanup: cleanupDist } = resolveWebDist("manifold-restart-");
const dataDir = mkdtempSync(join(tmpdir(), "manifold-restart-data-"));
const directory = join(dataDir, "restart-directory");
mkdirSync(directory);
const origin = `http://127.0.0.1:${String(reserveLoopbackPort())}`;
const server = Bun.spawn(["bun", "packages/server/src/main.ts"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    MANIFOLD_PORT: new URL(origin).port,
    MANIFOLD_DATA_DIR: dataDir,
    MANIFOLD_WEB_DIST: distDir,
    MANIFOLD_SPAWN_AGENT: "1",
    SHELL: Bun.which("bash") ?? "/bin/sh",
  },
  // The fresh server's boot log contains an owner credential, never gate output.
  stdout: "ignore",
  stderr: "inherit",
});
let browser: Browser | null = null;
let observer: SessionClient | null = null;
let failed = false;

try {
  await until(
    async () => {
      try {
        return (await fetch(`${origin}/healthz`)).ok;
      } catch {
        return false;
      }
    },
    20_000,
    "restart fixture server",
  );
  const ownerKey = await ownerKeyOf(dataDir);
  const action = async (name: string, args: unknown): Promise<unknown> => {
    const response = await fetch(`${origin}/api/actions/${name}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const outcome = ActionOutcomeSchema.parse(await response.json());
    if (!outcome.ok) throw new Error(`${name}: ${outcome.denial.message}`);
    return outcome.result;
  };
  const list = async (): Promise<readonly TerminalSummary[]> =>
    TerminalsResponseSchema.parse(await action("core.terminals.listAll", {})).terminals;
  const containerId = ContainerResponseSchema.parse(
    await action("core.index.createContainer", {
      name: "restart-browser",
      discipline: "composition",
    }),
  ).container.id;

  browser = new Browser();
  await browser.launch({ incognito: true });
  const target = browser;
  await target.goto(`${origin}/#key=${ownerKey}`);
  const hasIdentity = "localStorage.getItem('manifold.identity') !== null";
  await until(
    () =>
      target.evaluate<boolean>(
        `document.querySelector('#identity-name') !== null || ${hasIdentity}`,
      ),
    20_000,
    "restart browser identity form",
  );
  if (!(await target.evaluate<boolean>(hasIdentity))) {
    await target.typeInto("#identity-name", "restart-browser");
    await target.clickTestId("identity-enter");
    await until(() => target.evaluate<boolean>(hasIdentity), 20_000, "restart browser identity");
  }
  await target.goto(`${origin}/p/${containerId}`);

  // Use actual pointer clicks: a hidden or covered control must fail, not receive a
  // synthetic DOM click that bypasses its titlebar's hit-testing and focus behavior.
  const click = async (selector: string): Promise<void> => {
    const point = await target.evaluate<{ x: number; y: number } | null>(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement) || element.matches(':disabled')) return null;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
    })()`);
    assert.ok(point, `enabled visible control: ${selector}`);
    await target.drag([point], 30);
  };
  await until(
    () =>
      target.evaluate<boolean>(
        "document.querySelector('[data-testid=machines-section] button[aria-expanded]') !== null",
      ),
    20_000,
    "machine sidebar",
  );
  if (
    await target.evaluate<boolean>(
      "document.querySelector('[data-testid=machines-section] button[aria-expanded]')?.getAttribute('aria-expanded') === 'false'",
    )
  ) {
    await click("[data-testid=machines-section] button[aria-expanded]");
  }
  await until(
    () =>
      target.evaluate<boolean>(
        "document.querySelector('[data-action=\"core.terminals.open\"]') !== null",
      ),
    20_000,
    "online machine",
  );
  await click('[data-action="core.terminals.open"]');
  await until(
    () => target.evaluate<boolean>("document.querySelector('.xterm-rows') !== null"),
    20_000,
    "new terminal rendered",
  );
  await until(
    async () => (await list()).some((terminal) => terminal.homeId === containerId),
    10_000,
    "terminal identity",
  );
  const original = (await list()).find((terminal) => terminal.homeId === containerId);
  assert.ok(original);
  await action("core.terminals.rename", { terminalId: original.id, name: "restart-proof" });

  observer = new SessionClient({
    url: `${origin.replace(/^http/, "ws")}/ws/session`,
    containerId,
    token: ownerKey,
    spectator: true,
    reconnect: false,
  });
  await observer.connect();
  const layout = observer.layout();
  assert.ok(layout);
  let restarts = 0;
  observer.on("terminal_event", (event) => {
    if (event.terminalId === original.id && event.kind === "restarted") restarts++;
  });
  await target.evaluate("void (window.__restartFrame = document.querySelector('.terminal-frame'))");
  const command = async (text: string): Promise<void> => {
    await click(".xterm-host");
    await target.typeText(text);
    await target.typeText("\r");
  };
  const screenContains = (text: string): Promise<boolean> =>
    target.evaluate<boolean>(
      `(document.querySelector('.xterm-rows')?.textContent ?? '').includes(${JSON.stringify(text)})`,
    );
  await command(`cd '${directory}'; printf '\\n%s%s\\n' BEFORE_RESTART_ MARKER`);
  await until(() => screenContains("BEFORE_RESTART_MARKER"), 10_000, "pre-restart output");
  await until(
    async () => (await list()).find((terminal) => terminal.id === original.id)?.cwd === directory,
    10_000,
    "owner cwd publication",
  );
  const directoryVisible = (): Promise<boolean> =>
    target.evaluate<boolean>(`(() => {
    const title = document.querySelector('.terminal-titlebar .terminal-cwd');
    const row = document.querySelector('.index-terminal-cwd');
    return title?.textContent === 'restart-directory' && title.getAttribute('title') === ${JSON.stringify(directory)}
      && row?.textContent === 'restart-directory' && row.getAttribute('title') === ${JSON.stringify(directory)};
  })()`);
  await until(
    directoryVisible,
    10_000,
    "cwd basename and full-path tooltips in titlebar and index",
  );

  const restartControl = '.terminal-titlebar [data-action="core.terminals.restart"]';
  await click(restartControl);
  await until(
    () =>
      target.evaluate<boolean>(
        `document.querySelector(${JSON.stringify(restartControl)})?.getAttribute('data-confirming') === 'true'`,
      ),
    2_000,
    "running restart confirmation",
  );
  await sleep(250);
  assert.equal(restarts, 0, "first press must not restart the live process");
  assert.equal(await screenContains("BEFORE_RESTART_MARKER"), true);
  await click(restartControl);
  await until(() => restarts === 1, 10_000, "confirmed running restart");
  await until(
    async () => !(await screenContains("BEFORE_RESTART_MARKER")),
    10_000,
    "old byte stream cleared",
  );
  await command("printf '\\n%s%s\\n' RUNNING_RESTART_ READY; pwd");
  await until(
    () => screenContains("RUNNING_RESTART_READY"),
    10_000,
    "replacement PTY accepts browser input",
  );
  await until(() => screenContains(directory), 10_000, "replacement PTY working directory");

  await command("exit 7");
  await until(
    () => target.evaluate<boolean>("document.querySelector('.terminal-exited') !== null"),
    10_000,
    "retained nonzero exit",
  );
  await click(restartControl);
  await until(() => restarts === 2, 10_000, "exited restart needs one press");
  await until(
    () => target.evaluate<boolean>("document.querySelector('.terminal-exited') === null"),
    10_000,
    "exited tile becomes live",
  );
  await command("printf '\\n%s%s\\n' EXITED_RESTART_ READY; pwd");
  await until(
    () => screenContains("EXITED_RESTART_READY"),
    10_000,
    "reattached exited viewer accepts input",
  );
  await until(() => screenContains(directory), 10_000, "exited restart retained cwd");
  assert.equal(
    await screenContains("RUNNING_RESTART_READY"),
    false,
    "restart discards prior output",
  );
  assert.equal(await directoryVisible(), true);
  const final = (await list()).find((terminal) => terminal.id === original.id);
  assert.ok(final);
  assert.equal(final.homeId, original.homeId);
  assert.equal(final.name, "restart-proof");
  assert.equal(final.status, "running");
  assert.equal(final.cwd, directory);
  assert.deepEqual(observer.layout(), layout, "same terminal leaf, home and layout");
  assert.equal(
    await target.evaluate<boolean>(
      "window.__restartFrame === document.querySelector('.terminal-frame')",
    ),
    true,
    "same mounted terminal tile across both restarts",
  );
  const screenshot = process.env["MANIFOLD_RESTART_SCREENSHOT"];
  if (screenshot !== undefined) {
    const frame = await target.send("Page.captureScreenshot", { format: "png" });
    const data = frame.result?.["data"];
    assert.ok(typeof data === "string");
    await Bun.write(screenshot, Buffer.from(data, "base64"));
  }
  console.log(
    "terminal-restart browser: GREEN (running confirmation, exited recovery, cwd, same tile, fresh output)",
  );
} catch (error: unknown) {
  failed = true;
  console.error(
    `terminal-restart browser: RED: ${error instanceof Error ? error.message : String(error)}`,
  );
} finally {
  observer?.close();
  await browser?.close();
  await teardownServer(server, dataDir);
  cleanupDist();
}
process.exit(failed ? 1 : 0);
