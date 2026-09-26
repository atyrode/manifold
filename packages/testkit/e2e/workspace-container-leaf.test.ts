import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { TerminalInfoSchema, type TileLayout } from "@manifold/protocol";
import { Browser } from "../../../scripts/cdp.ts";
import { resolveWebDist } from "../../../scripts/gate-dist.ts";
import {
  callAction,
  createContainer,
  enrollMachine,
  startAgent,
  startServer,
  waitFor,
  type TestAgent,
  type TestServer,
} from "../src/index.ts";
import { e2eFailure, stopProcesses } from "./helpers.ts";

/**
 * A WORKSPACE CONTAINER LEAF IS A ROOT MOUNT, NOT THE ROUTE (issue #201). A canvas shown
 * inline beside a panel paints its own content exactly as the routed canvas would — a
 * terminal placed on it is a LIVE portal, not the "open it to work inside" card a canvas
 * nested inside another container draws — while leaving every routed-only control to the
 * route: its titlebar offers Remove from the workspace, never delete-for-everyone.
 */
test("an inline workspace canvas paints a placed terminal live without claiming the route", async () => {
  const dist = resolveWebDist("manifold-workspace-leaf-web-");
  const processes: (TestServer | TestAgent)[] = [];
  const browser = new Browser();
  let server: TestServer | null = null;
  try {
    server = await startServer({ env: { MANIFOLD_WEB_DIST: dist.distDir } });
    processes.push(server);
    const enrolled = await enrollMachine(server, "workspace-leaf-agent");
    processes.push(
      await startAgent({
        serverUrl: server.url,
        machineToken: enrolled.machineToken,
        name: "workspace-leaf-agent",
      }),
    );
    const container = await createContainer(server, "Board", "canvas");

    await browser.launch({ incognito: true });
    await browser.goto(`${server.httpUrl}/#key=${server.ownerKey}`);
    await waitFor(
      () => browser.evaluate<boolean>("document.querySelector('#identity-name') !== null"),
      15_000,
      50,
    );
    await browser.typeInto("#identity-name", "workspace-leaf");
    await browser.clickTestId("identity-enter");
    await waitFor(
      () => browser.evaluate<boolean>("localStorage.getItem('manifold.identity') !== null"),
      15_000,
      50,
    );
    const viewer = await browser.evaluate<string>(
      "JSON.parse(localStorage.getItem('manifold.identity')).token",
    );
    const act = async (name: string, args: unknown): Promise<unknown> => {
      const outcome = await callAction(server!, viewer, name, args);
      if (!outcome.ok) throw new Error(`${name}: ${outcome.denial.message}`);
      return outcome.result;
    };

    const layout: TileLayout = {
      root: { id: "root", dir: "row", ratios: [0.3, 0.7], children: ["rail", "view"], ref: null },
      rail: {
        id: "rail",
        dir: null,
        ratios: [],
        children: [],
        ref: { kind: "panel", panelId: "core.shell.sidebar" },
      },
      view: {
        id: "view",
        dir: null,
        ratios: [],
        children: [],
        ref: { kind: "container", containerId: container.id },
      },
    };
    await act("core.space.setLayout", { layout });
    const created = (await act("core.terminals.create", {
      containerId: container.id,
      elementId: crypto.randomUUID(),
      cols: 80,
      rows: 24,
    })) as { terminal: unknown };
    const terminal = TerminalInfoSchema.parse(created.terminal);
    await act("core.space.place", {
      ref: { kind: "terminal", terminalId: terminal.id },
      destination: { kind: "canvas", containerId: container.id, x: 40, y: 40 },
    });

    await browser.goto(`${server.httpUrl}/`);
    const inline = JSON.stringify(`[data-workspace-container="${container.id}"]`);
    // Live: the portal dials its composition and paints the shell, rather than the card a
    // canvas nested one container deep draws.
    await waitFor(
      () =>
        browser.evaluate<boolean>(
          `document.querySelector(${inline})?.querySelector('.react-flow__node-portal .xterm-rows') != null`,
        ),
      20_000,
      50,
    );
    expect(
      await browser.evaluate<{ remove: boolean; deleteForEveryone: boolean }>(`(() => {
        const leaf = document.querySelector(${inline});
        return {
          remove: leaf.querySelector('[aria-label="Remove Board from the workspace"]') !== null,
          deleteForEveryone: leaf.querySelector('[aria-label="Delete canvas Board"]') !== null,
        };
      })()`),
    ).toEqual({ remove: true, deleteForEveryone: false });
  } catch (error) {
    throw e2eFailure(error, processes);
  } finally {
    await browser.close();
    await stopProcesses(processes);
    if (server !== null) rmSync(server.dataDir, { recursive: true, force: true });
    dist.cleanup();
  }
}, 120_000);
