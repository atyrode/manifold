import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  ClientMessageSchema,
  ServerMessageSchema,
  ContainersResponseSchema,
  CredentialsResponseV2Schema,
  MANIFOLD_ROOT_URI,
  TokenGrantV2Schema,
  formatManifoldUri,
  type AskableCap,
  type AuthorityScope,
} from "@manifold/protocol";
import { discoverActions, invokeAction, type SessionClient } from "@manifold/sdk";
import { Browser } from "../../../scripts/cdp.ts";
import { resolveWebDist } from "../../../scripts/gate-dist.ts";
import {
  connect,
  ownerAction,
  createContainer,
  enrollMachine,
  isMachineOnline,
  listTerminals,
  startAgent,
  startServer,
  waitFor,
  type TestAgent,
  type TestServer,
} from "../src/index.ts";
import { attachedCapture, closeClients, openTerminalAt, type TerminalCapture } from "./helpers.ts";

/** Trusted pointer events exercise the same disclosure and account controls as a human. */
async function click(browser: Browser, selector: string): Promise<void> {
  const point = await browser.evaluate<{ x: number; y: number } | null>(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement) || element.matches(':disabled') || !element.checkVisibility()) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  if (point === null) throw new Error(`No enabled fleet control: ${selector}`);
  await browser.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    ...point,
  });
  await browser.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    ...point,
  });
}

async function visible(browser: Browser, selector: string): Promise<boolean> {
  return browser.evaluate<boolean>(
    `document.querySelector(${JSON.stringify(selector)})?.checkVisibility() === true`,
  );
}

async function rowPresent(browser: Browser, marker: string): Promise<boolean> {
  return browser.evaluate<boolean>(
    `Array.from(document.querySelectorAll('.xterm-rows > div')).some(row => row.textContent.trim() === ${JSON.stringify(marker)})`,
  );
}

async function terminalCommand(browser: Browser, command: string): Promise<void> {
  await browser.evaluate("document.querySelector('.xterm-helper-textarea').focus()");
  await browser.send("Input.insertText", { text: command });
  await browser.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    text: "\r",
  });
  await browser.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
}

/** Wait for the portal's occupant snapshot, not its already-painted spectator preview. */
function writableSnapshots(browser: Browser) {
  const occupantChannels = new Set<string>();
  const terminals = new Map<string, number>();
  const offSent = browser.on("Network.webSocketFrameSent", (params) => {
    const response = params["response"];
    if (
      response === null ||
      typeof response !== "object" ||
      !("payloadData" in response) ||
      typeof response.payloadData !== "string"
    )
      return;
    const parsed = ClientMessageSchema.safeParse(JSON.parse(response.payloadData));
    if (!parsed.success) return;
    const frame = parsed.data;
    const channel = `${String(params["requestId"])}:${"ch" in frame ? frame.ch : ""}`;
    if (frame.type === "join" && frame.spectator !== true) occupantChannels.add(channel);
    if (frame.type === "leave") occupantChannels.delete(channel);
  });
  const offReceived = browser.on("Network.webSocketFrameReceived", (params) => {
    const response = params["response"];
    if (
      response === null ||
      typeof response !== "object" ||
      !("payloadData" in response) ||
      typeof response.payloadData !== "string"
    )
      return;
    const parsed = ServerMessageSchema.safeParse(JSON.parse(response.payloadData));
    if (!parsed.success || parsed.data.type !== "terminal_snapshot") return;
    const frame = parsed.data;
    if (occupantChannels.has(`${String(params["requestId"])}:${frame.ch}`))
      terminals.set(frame.terminalId, (terminals.get(frame.terminalId) ?? 0) + 1);
  });
  return {
    terminals,
    dispose: () => {
      offSent();
      offReceived();
    },
  };
}

async function engageTerminal(
  browser: Browser,
  writable: ReturnType<typeof writableSnapshots>,
  terminalId: string,
): Promise<void> {
  const inactive = await visible(browser, ".xterm-host--inactive");
  const previous = writable.terminals.get(terminalId) ?? 0;
  await click(browser, ".xterm-host");
  await waitFor(
    () => (writable.terminals.get(terminalId) ?? 0) > (inactive ? previous : 0),
    10_000,
    50,
  );
  await browser.evaluate(
    "(() => { const {promise,resolve}=Promise.withResolvers(); requestAnimationFrame(()=>requestAnimationFrame(resolve)); return promise; })()",
  );
}

async function openSidebar(browser: Browser): Promise<void> {
  if (await visible(browser, 'button[aria-label="Expand sidebar"]'))
    await click(browser, 'button[aria-label="Expand sidebar"]');
  await waitFor(() => visible(browser, '[data-testid="machines-rail"]'), 10_000, 50);
}

for (const hardened of [false, true]) {
  test(`bare-core ${hardened ? "packed" : "native"} account launch and mounted fleet continuity`, async () => {
    const dist = resolveWebDist("manifold-core-fleet-web-");
    const browser = new Browser();
    const writable = writableSnapshots(browser);
    let server: TestServer | undefined;
    const agents: TestAgent[] = [];
    try {
      server = await startServer({
        env: {
          MANIFOLD_WEB_DIST: dist.distDir,
          MANIFOLD_HARDENED_PLUGINS: hardened ? "core.machines" : "",
        },
      });
      const hub = server;
      const alpha = await enrollMachine(hub, "fleet-account-alpha");
      const beta = await enrollMachine(hub, "fleet-account-beta");
      for (const [name, enrollment] of [
        ["fleet-account-alpha", alpha],
        ["fleet-account-beta", beta],
      ] as const)
        agents.push(
          await startAgent({ serverUrl: hub.url, machineToken: enrollment.machineToken, name }),
        );
      const owner = agents[1]!;
      const ownerPid = owner.host.pid;
      const canvas = await createContainer(hub, "Fleet canvas", "canvas");
      const composition = await createContainer(hub, "Fleet composition", "composition");
      await browser.launch({ incognito: true });
      await browser.send("Network.enable", {});
      await browser.send("Emulation.setDeviceMetricsOverride", {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await browser.goto(`${hub.httpUrl}/#key=${hub.ownerKey}`);
      await waitFor(() => visible(browser, "#identity-name"), 10_000, 50);
      await browser.typeInto("#identity-name", "Fleet browser");
      await browser.clickTestId("identity-enter");
      await waitFor(async () => !(await visible(browser, "#identity-name")), 10_000, 50);

      for (const container of [canvas, composition]) {
        const existing = new Set((await listTerminals(hub)).map((terminal) => terminal.id));
        await browser.goto(`${hub.httpUrl}/p/${container.id}`);
        await openSidebar(browser);
        const selector = 'button[aria-label="New terminal on fleet-account-beta"]';
        await waitFor(
          () =>
            browser.evaluate<boolean>(
              `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el instanceof HTMLButtonElement && !el.disabled && el.checkVisibility(); })()`,
            ),
          10_000,
          50,
        );
        await click(browser, selector);
        await waitFor(
          async () =>
            (await listTerminals(hub)).some(
              (terminal) => !existing.has(terminal.id) && terminal.status === "running",
            ),
          15_000,
          50,
        );
        const terminal = (await listTerminals(hub)).find((entry) => !existing.has(entry.id));
        expect(terminal?.machineId).toBe(beta.machineId);
        if (terminal === undefined) throw new Error("Fleet terminal birth missing");
        expect(
          container.discipline === "composition"
            ? terminal.homeId === container.id
            : terminal.homeId !== container.id,
        ).toBe(true);
        await waitFor(
          () =>
            browser.evaluate<boolean>(
              "document.querySelectorAll('.terminal-frame').length === 1 && document.querySelector('.xterm-helper-textarea') !== null && Array.from(document.querySelectorAll('.xterm-rows > div')).some(row => row.textContent.trim() !== '')",
            ),
          15_000,
          50,
        );
        const marker = `CORE-FLEET-${hardened ? "PACKED" : "NATIVE"}-${container.discipline.toUpperCase()}`;
        await engageTerminal(browser, writable, terminal.id);
        await terminalCommand(
          browser,
          `printf '%s%s\\n' 'CORE-' 'FLEET-${hardened ? "PACKED" : "NATIVE"}-${container.discipline.toUpperCase()}'`,
        );
        await waitFor(() => rowPresent(browser, marker), 10_000, 50);
        // Full sidebar collapse unmounts Machines; hiding its inner disclosure does not.
        await click(browser, 'button[aria-label="Collapse sidebar"]');
        await waitFor(
          async () => !(await visible(browser, '[data-testid="machines-rail"]')),
          10_000,
          50,
        );
        await engageTerminal(browser, writable, terminal.id);
        await browser.evaluate<void>(`(() => {
          const frame = document.querySelector('.terminal-frame');
          const xterm = frame.querySelector('.xterm');
          const helper = frame.querySelector('.xterm-helper-textarea');
          helper.focus();
          globalThis.__fleetProof = {frame, xterm, helper, rows: Array.from(frame.querySelectorAll('.xterm-rows > div')).map(row => row.textContent), focus: document.activeElement};
        })()`);
        const row = await browser.evaluate<{ x: number; y: number; width: number }>(`(() => {
          const row = Array.from(document.querySelectorAll('.xterm-rows > div')).find(row => row.textContent.trim() === ${JSON.stringify(marker)});
          const rect = row.getBoundingClientRect(); return {x:rect.x,y:rect.y,width:rect.width};
        })()`);
        await browser.drag(
          [
            { x: row.x + 2, y: row.y + 5 },
            { x: row.x + Math.min(100, row.width / 2), y: row.y + 5 },
          ],
          50,
        );
        await waitFor(
          () =>
            browser.evaluate<boolean>("document.querySelector('.xterm-selection div') !== null"),
          5_000,
          20,
        );
        await browser.evaluate<void>(
          "globalThis.__fleetProof.selection = Array.from(document.querySelectorAll('.xterm-selection div')).map(el => el.getAttribute('style'))",
        );
        const continuity = () =>
          browser.evaluate<boolean>(`(() => {
          const saved = globalThis.__fleetProof;
          return saved.frame === document.querySelector('.terminal-frame') && saved.xterm === document.querySelector('.xterm') && saved.helper === document.querySelector('.xterm-helper-textarea') && saved.focus === document.activeElement && JSON.stringify(saved.rows) === JSON.stringify(Array.from(saved.frame.querySelectorAll('.xterm-rows > div')).map(row => row.textContent)) && JSON.stringify(saved.selection) === JSON.stringify(Array.from(document.querySelectorAll('.xterm-selection div')).map(el => el.getAttribute('style')));
        })()`);
        const offline = () => visible(browser, ".terminal-frame .terminal-exited");
        for (let transition = 0; transition < 2; transition++) {
          owner.proc.kill("SIGTERM");
          await owner.proc.exited;
          await waitFor(offline, 10_000, 50);
          expect(await continuity()).toBe(true);
          expect(owner.host.pid).toBe(ownerPid);
          expect(owner.host.exitCode).toBeNull();
          await owner.restartTransport();
          await waitFor(() => isMachineOnline(hub, beta.machineId), 15_000, 50);
          await waitFor(async () => !(await offline()), 10_000, 50);
          expect(await continuity()).toBe(true);
        }
        // Same PTY accepts fresh input after both transport replacements.
        const after = `${marker}-AFTER`;
        await terminalCommand(browser, `printf '%s%s\\n' '${marker}-' 'AFTER'`);
        await waitFor(() => rowPresent(browser, after), 10_000, 50);
        expect((await listTerminals(hub)).find((entry) => entry.id === terminal.id)?.status).toBe(
          "running",
        );
      }
      if (hardened)
        expect(
          await browser.evaluate<boolean>(
            "performance.getEntriesByType('resource').some(entry => entry.name.includes('/api/plugins/core.machines/web.worker.js'))",
          ),
        ).toBe(true);
      const faults = browser.drainMessages().filter((message) => message.kind === "exception");
      expect(faults).toEqual([]);
    } finally {
      writable.dispose();
      await browser.close();
      for (const agent of agents) await agent.stop();
      if (server !== undefined) {
        await server.stop();
        rmSync(server.dataDir, { recursive: true, force: true });
      }
      dist.cleanup();
    }
  }, 120_000);
}

test("real scoped SDK and CLI distinguish placement, exact account and lifecycle control", async () => {
  const server = await startServer();
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  const captures: TerminalCapture[] = [];
  try {
    const canvas = await createContainer(server, "Authority canvas", "canvas");
    const composition = await createContainer(server, "Approved composition", "composition");
    const otherComposition = await createContainer(server, "Unapproved composition", "composition");
    const m1 = await enrollMachine(server, "scope-account-one");
    const m2 = await enrollMachine(server, "scope-account-two");
    for (const [name, enrollment] of [
      ["scope-account-one", m1],
      ["scope-account-two", m2],
    ] as const)
      agents.push(
        await startAgent({ serverUrl: server.url, machineToken: enrollment.machineToken, name }),
      );
    const working: AskableCap[] = [
      "containers:read",
      "containers:write",
      "scenes:write",
      "terminals:spawn",
      "terminals:write",
    ];
    const m1Node = formatManifoldUri({ kind: "machine", machineId: m1.machineId });
    const cNode = formatManifoldUri({ kind: "container", containerId: composition.id });
    const mint = async (name: string, scope: AuthorityScope, containerId?: string) => {
      const { outcome, traceId } = await invokeAction(
        { origin: server.httpUrl, token: server.ownerKey },
        "core.access.mintTokenV2",
        {
          principal: { name, kind: "human" },
          scope,
          ...(containerId === undefined ? {} : { containerId }),
          expiresAt: Date.now() + 600_000,
        },
      );
      expect(traceId).not.toBeNull();
      if (!outcome.ok) throw new Error(`V2 fixture issuance refused: ${outcome.denial.rule}`);
      return TokenGrantV2Schema.parse(outcome.result);
    };
    const workspace = await mint("Workspace automation", [
      { target: MANIFOLD_ROOT_URI, reach: "subtree", caps: working },
      { target: m1Node, reach: "node", caps: ["machines:shell"] },
    ]);
    const restricted = await mint(
      "Composition automation",
      [
        { target: cNode, reach: "subtree", caps: working },
        { target: m1Node, reach: "node", caps: ["machines:shell"] },
      ],
      composition.id,
    );
    expect(restricted.containerId).toBe(composition.id);
    const protocol = await discoverActions({ origin: server.httpUrl, token: workspace.token });
    expect(protocol.actions.some((action) => action.name === "core.access.mintTokenV2")).toBe(true);
    const effectInventory = async () => {
      const containers = ContainersResponseSchema.parse(
        await ownerAction(server, "core.index.listContainers", {}),
      );
      const credentials = CredentialsResponseV2Schema.parse(
        await ownerAction(server, "core.access.listCredentialsV2", {}),
      );
      return {
        containers: containers.containers.map((container) => container.id).sort(),
        terminals: (await listTerminals(server)).map((terminal) => terminal.id).sort(),
        credentials: credentials.principals
          .flatMap((principal) => principal.sessions.map((session) => session.id))
          .sort(),
      };
    };
    const refuse = async (
      token: string,
      containerId: string,
      machineId: string,
      placement?: "tile",
    ) => {
      const before = await effectInventory();
      const { outcome, traceId } = await invokeAction(
        { origin: server.httpUrl, token },
        "core.terminals.create",
        {
          containerId,
          machineId,
          elementId: crypto.randomUUID(),
          cols: 80,
          rows: 24,
          ...(placement === undefined ? {} : { placement }),
        },
      );
      expect(outcome.ok).toBe(false);
      expect(traceId).not.toBeNull();
      expect(await effectInventory()).toEqual(before);
    };
    await refuse(workspace.token, composition.id, m2.machineId, "tile");
    await refuse(restricted.token, otherComposition.id, m1.machineId, "tile");
    await refuse(restricted.token, canvas.id, m1.machineId);
    const empty = await mint("No ordinary authority", []);
    await refuse(empty.token, composition.id, m1.machineId, "tile");
    const canvasClient = await connect(server, { containerId: canvas.id, token: workspace.token });
    clients.push(canvasClient);
    const born = await openTerminalAt(canvasClient, server, {
      elementId: "authority-canvas-home",
      token: workspace.token,
      machineId: m1.machineId,
    });
    clients.push(born.homeClient);
    expect(born.terminal.machineId).toBe(m1.machineId);
    expect(born.terminal.containerId).not.toBe(canvas.id);
    const capture = await attachedCapture(born.homeClient, born.terminal.id);
    captures.push(capture);
    born.homeClient.sendTerminalInput(born.terminal.id, "printf '%s%s\\n' 'SCOPE-' 'SDK-OUTPUT'\n");
    await waitFor(() => capture.outputText.includes("SCOPE-SDK-OUTPUT"), 10_000, 20);
    const cClient = await connect(server, { containerId: composition.id, token: restricted.token });
    clients.push(cClient);
    const cTerminal = await cClient.openTerminal({
      elementId: "authority-composition-tile",
      machineId: m1.machineId,
      placement: "tile",
      cols: 80,
      rows: 24,
    });
    expect(cTerminal.machineId).toBe(m1.machineId);
    expect(cTerminal.containerId).toBe(composition.id);
    const cliPath = join(import.meta.dir, "../../plugins/terminals/cli/main.ts");
    const cli = async (args: readonly string[], token: string) => {
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("MANIFOLD_")),
      );
      const proc = Bun.spawn([process.execPath, cliPath, ...args], {
        env: {
          ...environment,
          MANIFOLD_URL: server.httpUrl,
          MANIFOLD_CONTAINER: composition.id,
          MANIFOLD_TOKEN: token,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(stdout + stderr).not.toContain(token);
      return { result: JSON.parse(stdout) as Record<string, unknown>, exit, stderr };
    };
    const automated = await cli(
      [
        "exec",
        "--machine",
        m1.machineId,
        "--",
        "/bin/sh",
        "-c",
        "printf '%s%s\\n' 'CLI-' 'EXACT-M1'",
      ],
      restricted.token,
    );
    expect(automated.exit).toBe(0);
    expect(automated.result["ok"]).toBe(true);
    const output = automated.result["output"] as { data: string; complete: boolean };
    expect(output.complete).toBe(true);
    expect(Buffer.from(output.data, "base64").toString()).toContain("CLI-EXACT-M1");
    await refuse(restricted.token, composition.id, m2.machineId, "tile");
    // Run the actual CLI inside an ordinary PTY: it receives only its injected lifecycle binding.
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const jsonLine = (type: string) =>
      capture.outputText.split(/[\r\n]+/).find((line) => line.startsWith(`{"type":"${type}"`));
    born.homeClient.sendTerminalInput(
      born.terminal.id,
      `${shellQuote(process.execPath)} ${shellQuote(cliPath)} doctor\n`,
    );
    await waitFor(() => jsonLine("doctor") !== undefined, 10_000, 20);
    const doctor = JSON.parse(jsonLine("doctor")!) as Record<string, unknown>;
    expect(doctor["ok"]).toBe(true);
    expect(doctor["remoteShellLaunch"]).toBe("not_probed");
    const beforeLifecycle = await effectInventory();
    born.homeClient.sendTerminalInput(
      born.terminal.id,
      `${shellQuote(process.execPath)} ${shellQuote(cliPath)} exec --machine ${shellQuote(m1.machineId)} -- /bin/true\n`,
    );
    await waitFor(() => jsonLine("exec") !== undefined, 10_000, 20);
    const denied = JSON.parse(jsonLine("exec")!) as { ok: boolean; diagnostic: { code: string } };
    expect(denied.ok).toBe(false);
    expect(denied.diagnostic.code).toBe("shell_spawn_not_delegated");
    expect(await effectInventory()).toEqual(beforeLifecycle);
  } finally {
    for (const capture of captures) capture.stop();
    closeClients(clients);
    for (const agent of agents) await agent.stop();
    await server.stop();
    rmSync(server.dataDir, { recursive: true, force: true });
  }
}, 120_000);
