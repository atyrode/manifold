import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
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
async function click(browser: Browser, selector: string, text?: string): Promise<void> {
  const point = await browser.evaluate<{ x: number; y: number } | null>(`(() => {
    let element = document.querySelector(${JSON.stringify(selector)});
    if (${JSON.stringify(text ?? null)} !== null) {
      element = null;
      for (const candidate of document.querySelectorAll(${JSON.stringify(selector)})) {
        if (candidate.textContent.trim() === ${JSON.stringify(text ?? null)}) {
          element = candidate;
          break;
        }
      }
    }
    if (!(element instanceof HTMLElement) || element.matches(':disabled') || !element.checkVisibility()) return null;
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const { promise, resolve } = Promise.withResolvers();
    let previous = null;
    let frame = 0;
    let measurement = 0;
    const finish = (point) => {
      clearTimeout(timeout);
      cancelAnimationFrame(frame);
      clearTimeout(measurement);
      resolve(point);
    };
    const timeout = setTimeout(() => finish(null), 10_000);
    const nextFrame = () => {
      // RAF precedes layout/paint; sample in the following task, not mid-frame.
      frame = requestAnimationFrame(() => {
        measurement = setTimeout(sample, 0);
      });
    };
    const sample = () => {
      if (!element.isConnected || element.matches(':disabled') || !element.checkVisibility()) {
        finish(null);
        return;
      }
      const rect = element.getBoundingClientRect();
      const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      const hit = document.elementFromPoint(point.x, point.y);
      const hittable = hit !== null && element.contains(hit);
      if (hittable && previous !== null &&
          rect.x === previous.x && rect.y === previous.y &&
          rect.width === previous.width && rect.height === previous.height) {
        finish(point);
        return;
      }
      previous = hittable ? rect : null;
      nextFrame();
    };
    nextFrame();
    return promise;
  })()`);
  if (point === null) throw new Error(`No stable enabled fleet control: ${selector}`);
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

/**
 * A click makes the host active at once, but an engaging portal still paints its read-only
 * spectator until the occupant join replays. Typing also waits for that writable occupant.
 */
async function engageTerminal(browser: Browser, occupantReady: () => boolean): Promise<void> {
  await click(browser, ".terminal-frame");
  await waitFor(
    async () =>
      occupantReady() && (await visible(browser, ".xterm-host:not(.xterm-host--inactive)")),
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

async function waitForOpenConnection(browser: Browser, discipline: string): Promise<void> {
  const expression =
    discipline === "canvas"
      ? 'document.querySelector(\'[data-testid="connection-state"]\')?.textContent === "Open"'
      : 'document.querySelector(".composition-status.is-open") !== null';
  await waitFor(() => browser.evaluate<boolean>(expression), 15_000, 50);
}

for (const hardened of [false, true]) {
  test(`bare-core ${hardened ? "packed" : "native"} account launch and mounted fleet continuity`, async () => {
    const dist = resolveWebDist("manifold-core-fleet-web-");
    const browser = new Browser();
    const sessionChannels = new Map<
      string,
      { readonly containerId: string; readonly spectator: boolean }
    >();
    const readyContainers = new Set<string>();
    /** The channel that last attached each terminal, and whether it has published since. */
    const terminalViews = new Map<string, { readonly channel: string; published: boolean }>();
    // Only a writable controller publishes a non-null viewport, and only after its current
    // snapshot replay; focus, an active host and the null clearance prove neither.
    const occupantReady = (terminalId: string): boolean => {
      const view = terminalViews.get(terminalId);
      return (
        view !== undefined &&
        view.published &&
        sessionChannels.get(view.channel)?.spectator === false
      );
    };
    const terminalWire: {
      direction: "sent" | "received";
      type: string;
      channel: string | null;
      terminalId: string | null;
      encodedCharacters: number | null;
      seq: number | null;
    }[] = [];
    const observeTerminalWire = (
      direction: "sent" | "received",
      message: Record<string, unknown>,
    ): void => {
      if (typeof message.type !== "string" || !message.type.startsWith("terminal_")) return;
      terminalWire.push({
        direction,
        type: message.type,
        channel: typeof message.ch === "string" ? message.ch : null,
        terminalId: typeof message.terminalId === "string" ? message.terminalId : null,
        encodedCharacters: typeof message.data === "string" ? message.data.length : null,
        seq: typeof message.seq === "number" ? message.seq : null,
      });
      if (terminalWire.length > 32) terminalWire.shift();
    };
    let server: TestServer | undefined;
    const agents: TestAgent[] = [];
    const serverEnv = {
      MANIFOLD_WEB_DIST: dist.distDir,
      MANIFOLD_HARDENED_PLUGINS: hardened ? "core.machines" : "",
    };
    try {
      server = await startServer({ env: serverEnv });
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
      browser.on("Network.webSocketFrameSent", (params) => {
        const response = params["response"] as
          { payloadData?: string; opcode?: number } | undefined;
        if (response?.opcode !== 1 || response.payloadData === undefined) return;
        try {
          const message = JSON.parse(response.payloadData) as {
            readonly ch?: unknown;
            readonly containerId?: unknown;
            readonly spectator?: unknown;
            readonly terminalId?: unknown;
            readonly type?: unknown;
            readonly viewport?: unknown;
          };
          observeTerminalWire("sent", message);
          if (typeof message.ch === "string") {
            if (message.type === "leave") sessionChannels.delete(message.ch);
            const terminalId = typeof message.terminalId === "string" ? message.terminalId : null;
            const view = terminalId === null ? undefined : terminalViews.get(terminalId);
            if (message.type === "terminal_attach" && terminalId !== null)
              terminalViews.set(terminalId, { channel: message.ch, published: false });
            if (
              message.type === "terminal_detach" &&
              terminalId !== null &&
              view?.channel === message.ch
            )
              terminalViews.delete(terminalId);
            if (
              message.type === "terminal_resize" &&
              typeof message.viewport === "object" &&
              message.viewport !== null &&
              view?.channel === message.ch
            )
              view.published = true;
          }
          if (
            message.type !== "join" ||
            typeof message.ch !== "string" ||
            typeof message.containerId !== "string"
          )
            return;
          const spectator = message.spectator === true;
          sessionChannels.set(message.ch, { containerId: message.containerId, spectator });
          if (!spectator) readyContainers.delete(message.containerId);
        } catch {
          // Non-JSON websocket frames are outside the session protocol.
        }
      });
      browser.on("Network.webSocketFrameReceived", (params) => {
        const response = params["response"] as
          { payloadData?: string; opcode?: number } | undefined;
        if (response?.opcode !== 1 || response.payloadData === undefined) return;
        try {
          const message = JSON.parse(response.payloadData) as {
            readonly ch?: unknown;
            readonly type?: unknown;
          };
          observeTerminalWire("received", message);
          if (
            (message.type !== "init" && message.type !== "resync") ||
            typeof message.ch !== "string"
          )
            return;
          const channel = sessionChannels.get(message.ch);
          if (channel !== undefined && !channel.spectator) readyContainers.add(channel.containerId);
        } catch {
          // Non-JSON websocket frames are outside the session protocol.
        }
      });
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

      // Another administrator wins while the first browser owns a private draft.
      // Registry catch-up must neither erase that draft nor silently rebase its CAS.
      await browser.goto(`${hub.httpUrl}/p/${canvas.id}`);
      await openSidebar(browser);
      const groupingId = crypto.randomUUID();
      const originalHost = {
        id: groupingId,
        name: "Original grouping",
        members: [{ machineId: alpha.machineId, accountLabel: "Original account" }],
      };
      await ownerAction(hub, "core.machines.setHostView", {
        expectedRevision: 0,
        host: originalHost,
      });
      const grouping = `[data-testid="host-view-${groupingId}"]`;
      const editor = '[data-testid="host-view-editor"]';
      const editorButtons = `${editor} button`;
      const nameInput = `${editor} input`;
      const save = `${editor} button[data-action="core.machines.setHostView"]`;
      const values = (): Promise<string[]> =>
        browser.evaluate<string[]>(
          `Array.from(document.querySelectorAll(${JSON.stringify(`${editor} input`)}), input => input.value)`,
        );
      await waitFor(() => visible(browser, grouping), 10_000, 50);
      await click(browser, `${grouping} button`, "Edit grouping");
      await waitFor(() => visible(browser, editor), 10_000, 50);
      await browser.evaluate(`document.querySelector(${JSON.stringify(nameInput)}).select()`);
      await browser.typeInto(nameInput, "Unsaved grouping draft");
      const winningHost = {
        ...originalHost,
        name: "Winning grouping",
        members: [{ machineId: alpha.machineId, accountLabel: "Winning account" }],
      };
      await ownerAction(hub, "core.machines.setHostView", {
        expectedRevision: 1,
        host: winningHost,
      });
      await waitFor(
        () =>
          browser.evaluate<boolean>(
            `document.querySelector(${JSON.stringify(save)})?.disabled === true`,
          ),
        10_000,
        50,
      );
      expect(await values()).toEqual(["Unsaved grouping draft", "Original account"]);
      await hub.stop();
      sessionChannels.clear();
      readyContainers.clear();
      terminalViews.clear();
      await waitFor(async () => !(await visible(browser, editor)), 10_000, 50);
      server = await startServer({
        dataDir: hub.dataDir,
        port: hub.port,
        ownerKey: hub.ownerKey,
        env: serverEnv,
      });
      // A restarted hub begins with no live channel. Wait for beta's fresh owner and the
      // browser's canvas occupant before asking native preparation to bind runtime facts.
      await waitFor(() => isMachineOnline(hub, beta.machineId), 15_000, 50);
      await waitFor(() => readyContainers.has(canvas.id), 15_000, 50);
      await waitForOpenConnection(browser, "canvas");
      await waitFor(
        () =>
          browser.evaluate<boolean>(
            `document.querySelector(${JSON.stringify(save)})?.disabled === true`,
          ),
        15_000,
        50,
      );
      expect(await values()).toEqual(["Unsaved grouping draft", "Original account"]);
      await click(browser, editorButtons, "Reload current grouping");
      await waitFor(
        async () => {
          const current = await values();
          return current[0] === "Winning grouping" && current[1] === "Winning account";
        },
        10_000,
        50,
      );
      expect(await values()).toEqual(["Winning grouping", "Winning account"]);
      await browser.evaluate(`document.querySelector(${JSON.stringify(nameInput)}).select()`);
      await browser.typeInto(nameInput, "Reviewed grouping");
      await click(browser, save);
      await waitFor(async () => !(await visible(browser, editor)), 10_000, 50);
      expect(await ownerAction(hub, "core.machines.listHostViews", {})).toEqual({
        revision: 3,
        hosts: [{ ...winningHost, name: "Reviewed grouping" }],
      });
      await click(browser, `${grouping} button`, "Edit grouping");
      await waitFor(() => visible(browser, editor), 10_000, 50);
      await ownerAction(hub, "core.machines.removeHostView", {
        expectedRevision: 3,
        hostId: groupingId,
      });
      await waitFor(
        () =>
          browser.evaluate<boolean>(
            `document.querySelector(${JSON.stringify(save)})?.disabled === true`,
          ),
        10_000,
        50,
      );
      expect(await values()).toEqual(["Reviewed grouping", "Winning account"]);
      await click(browser, editorButtons, "Close removed grouping");
      await waitFor(async () => !(await visible(browser, editor)), 10_000, 50);
      expect(await ownerAction(hub, "core.machines.listHostViews", {})).toEqual({
        revision: 4,
        hosts: [],
      });

      for (const container of [canvas, composition]) {
        const existing = new Set((await listTerminals(hub)).map((terminal) => terminal.id));
        sessionChannels.clear();
        readyContainers.clear();
        terminalViews.clear();
        await browser.goto(`${hub.httpUrl}/p/${container.id}`);
        await waitFor(() => readyContainers.has(container.id), 15_000, 50);
        await openSidebar(browser);
        await waitForOpenConnection(browser, container.discipline);
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
        const terminalId = terminal.id;
        await engageTerminal(browser, () => occupantReady(terminalId));
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
        await engageTerminal(browser, () => occupantReady(terminalId));
        const collapsed = `${marker}-COLLAPSED`;
        await terminalCommand(browser, `printf '%s%s\\n' '${marker}-' 'COLLAPSED'`);
        try {
          await waitFor(() => rowPresent(browser, collapsed), 10_000, 50);
        } catch (error) {
          const page = await browser.evaluate<unknown>(`(() => {
            const frame = document.querySelector(".terminal-frame");
            const helper = frame?.querySelector(".xterm-helper-textarea");
            const key = Object.keys(frame ?? {}).find(key => key.startsWith("__reactFiber$"));
            let fiber = key ? frame[key] : null;
            const clients = [];
            for (let i = 0; fiber && i < 40; i++, fiber = fiber.return) {
              const props = fiber.memoizedProps;
              const client = props?.client;
              if (!client || typeof client.sendTerminalInput !== "function") continue;
              const terminal = client.terminals.get(props.terminalId);
              clients.push({ status: client.status, chrome: props.chrome, active: props.active,
                terminalStatus: terminal?.status,
                controller: client.self !== null && terminal?.controllerId === client.self.id });
            }
            return { clients, focused: document.activeElement === helper,
              helperDisabled: helper?.disabled,
              engaged: frame?.closest(".portal")?.classList.contains("portal--engaged") ?? false,
              hostClass: frame?.querySelector(".xterm-host")?.className,
              rows: Array.from(frame?.querySelectorAll(".xterm-rows > div") ?? []).map(row => ({
                characters: row.textContent.length,
                original: row.textContent.trim() === ${JSON.stringify(marker)},
                collapsed: row.textContent.trim() === ${JSON.stringify(collapsed)},
                suffix: row.textContent.includes("COLLAPSED"),
              })) };
          })()`);
          throw new Error(
            `fleet sidebar-collapse input facts: ${JSON.stringify({ terminalWire, page })}`,
            { cause: error },
          );
        }
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
