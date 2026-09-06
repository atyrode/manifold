import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  ActionOutcomeSchema,
  PluginsResponseSchema,
  type ActionOutcome,
  type PluginRoster,
} from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import {
  callAction,
  connect,
  createContainer,
  mintToken,
  ownerAction,
  ownerFetch,
  startServer,
  waitFor,
  type TestServer,
} from "../src/index.ts";
import { closeClients, e2eFailure, stopProcesses } from "./helpers.ts";

/**
 * AN UNPACKED PLUGIN, END TO END (ADR 0025 §4, #257): a tiny React plugin written INTO a real hub
 * through `engine.plugins.author`, built by the hub's own kit in the hub's own process, and
 * announced to a view that was already joined — the roster frame that makes the shell import
 * the panel — then edited, which moves the pin the shell remounts on. Around it, the switch:
 * off, the door refuses by name and an unpacked row refuses enable by the same name.
 *
 * The browser is the SDK client here: what a joined view receives is the `plugins` frame, and
 * what it imports on it is `/api/plugins/<id>/web.js` at the frame's pin. Both are asserted; the
 * mount itself is the web loader's contract (`packages/web/src/plugin-host.tsx`).
 */

const PLUGIN_ID = "example.unpacked";
const PANEL = "hello";

function manifest(version: string): string {
  return JSON.stringify({
    id: PLUGIN_ID,
    version,
    title: "Unpacked hello",
    description: "authored on this instance by the e2e suite",
    capabilities: [],
    contributes: {
      panels: [{ id: PANEL, title: "Hello" }],
      sections: [],
      elements: [],
      tools: [],
      events: [],
    },
    entry: { web: "web.js" },
  });
}

/** JSX in the entry itself, the authoring door's shape: `pack` reads `web.tsx`. */
function webTsx(greeting: string): string {
  return `
    import { useState } from "react";
    export function Hello() {
      const [count, setCount] = useState(0);
      return (
        <button type="button" onClick={() => setCount(count + 1)}>
          ${greeting} {count}
        </button>
      );
    }
    export default { id: ${JSON.stringify(PLUGIN_ID)}, panels: { ${PANEL}: Hello } };
  `;
}

function author(server: TestServer, files: Record<string, string | null>): Promise<ActionOutcome> {
  return callAction(server, server.ownerKey, "engine.plugins.author", { id: PLUGIN_ID, files });
}

/** Authors and reads the pin the door answered — the install result plus the built bytes' hash. */
async function authored(
  server: TestServer,
  files: Record<string, string | null>,
): Promise<{ version: string; sha256: string }> {
  const outcome = ActionOutcomeSchema.parse(await author(server, files));
  if (!outcome.ok) throw new Error(`engine.plugins.author refused: ${outcome.denial.message}`);
  const result = outcome.result;
  if (
    typeof result !== "object" ||
    result === null ||
    !("version" in result) ||
    !("sha256" in result) ||
    typeof result.version !== "string" ||
    typeof result.sha256 !== "string"
  ) {
    throw new Error(`engine.plugins.author answered no pin: ${JSON.stringify(result)}`);
  }
  return { version: result.version, sha256: result.sha256 };
}

/** What a joined view has heard last: the roster and the switch that rode beside it. */
interface Heard {
  roster: PluginRoster;
  developerMode: boolean;
}

function listen(client: SessionClient): Heard {
  const heard: Heard = { roster: [], developerMode: false };
  client.onPlugins((roster, developerMode) => {
    heard.roster = roster;
    heard.developerMode = developerMode;
  });
  return heard;
}

async function webModule(server: TestServer): Promise<Response> {
  return fetch(new URL(`/api/plugins/${PLUGIN_ID}/web.js`, server.httpUrl), {
    headers: { authorization: `Bearer ${server.ownerKey}` },
  });
}

test("a plugin authored on the instance reaches a joined view, remounts on edit, and obeys the switch", async () => {
  const servers: TestServer[] = [];
  const clients: SessionClient[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const authoredDir = join(server.dataDir, "authored", PLUGIN_ID);
    const rowOf = (heard: Heard) => heard.roster.find((entry) => entry.manifest.id === PLUGIN_ID);

    // OFF by default: the door refuses by name and writes nothing.
    const listing = await ownerFetch(server, "/api/plugins", {
      responseSchema: PluginsResponseSchema,
    });
    expect(listing.developerMode).toBe(false);
    expect(await author(server, { "manifest.json": manifest("1.0.0") })).toEqual({
      ok: false,
      denial: { rule: "refused", message: `developer_mode_off: ${PLUGIN_ID}` },
    });
    expect(existsSync(authoredDir)).toBe(false);

    // A second view, joined BEFORE anything is authored, hears the switch and then the row.
    const container = await createContainer(server, "unpacked");
    const viewer = await mintToken(server, {
      principal: { kind: "human", name: "Viewer", color: "#d13f62" },
      caps: ["containers:read"],
      containerId: container.id,
    });
    const view = await connect(server, { containerId: container.id, token: viewer.token });
    clients.push(view);
    const heard = listen(view);
    await ownerAction(server, "engine.plugins.setDeveloperMode", { on: true });
    await waitFor(() => heard.developerMode, 5_000, 20);

    // Authoring: the hub builds `web.tsx` with the kit and the row lands as `mode: "unpacked"`.
    const first = await authored(server, {
      "manifest.json": manifest("1.0.0"),
      "web.tsx": webTsx("hello"),
    });
    expect(first.version).toBe("1.0.0");
    await waitFor(() => rowOf(heard)?.install?.sha256 === first.sha256, 15_000, 20);
    const row = rowOf(heard);
    expect(row?.enabled).toBe(true);
    expect(row?.install?.mode).toBe("unpacked");
    expect(row?.install?.hardened).toBe(false);
    expect(row?.manifest.contributes.panels.map((panel) => panel.id)).toEqual([PANEL]);
    // What the joined view imports on that frame: the built member at the frame's pin, JSX
    // compiled, React taken from the shell's shared registry rather than carried.
    const served = await webModule(server);
    expect(served.status).toBe(200);
    expect(served.headers.get("etag")).toBe(`"${first.sha256}"`);
    const firstModule = await served.text();
    expect(firstModule).toContain("hello");
    expect(firstModule).toContain('Symbol.for("manifold.shared")');
    expect(firstModule).not.toMatch(/function useState\(/);

    // An edit: one file, the row replaced live at a new pin — the frame the shell remounts on.
    const second = await authored(server, { "web.tsx": webTsx("bonjour") });
    expect(second.sha256).not.toBe(first.sha256);
    await waitFor(() => rowOf(heard)?.install?.sha256 === second.sha256, 15_000, 20);
    expect(rowOf(heard)?.enabled).toBe(true);
    const reserved = await webModule(server);
    expect(reserved.headers.get("etag")).toBe(`"${second.sha256}"`);
    expect(await reserved.text()).toContain("bonjour");

    // A broken edit is refused by name and the working row stands at its pin.
    const broken = await author(server, { "web.tsx": "export default { id: " });
    expect(broken.ok).toBe(false);
    if (!broken.ok) {
      expect(broken.denial.rule).toBe("refused");
      expect(broken.denial.message).toStartWith("artifact_invalid:");
    }
    expect((await webModule(server)).headers.get("etag")).toBe(`"${second.sha256}"`);

    // OFF again: the running unpacked row is disabled first, then marked; enable refuses by name.
    await ownerAction(server, "engine.plugins.setDeveloperMode", { on: false });
    await waitFor(() => !heard.developerMode, 5_000, 20);
    const dark = rowOf(heard);
    expect(dark?.enabled).toBe(false);
    expect(dark?.refusal).toBe("developer_mode_off");
    expect((await webModule(server)).status).toBe(404);
    expect(
      await callAction(server, server.ownerKey, "engine.plugins.setEnabled", {
        id: PLUGIN_ID,
        enabled: true,
      }),
    ).toEqual({
      ok: false,
      denial: { rule: "refused", message: `developer_mode_off: ${PLUGIN_ID}` },
    });

    // The row leaves through the same door every install does; the directory is the author's.
    expect(await ownerAction(server, "engine.plugins.uninstall", { id: PLUGIN_ID })).toEqual({});
    expect(existsSync(join(server.dataDir, "plugins", PLUGIN_ID))).toBe(false);
    expect(existsSync(authoredDir)).toBe(true);
  } catch (error) {
    throw e2eFailure(error, servers);
  } finally {
    closeClients(clients);
    try {
      await stopProcesses(servers);
    } finally {
      for (const server of servers) rmSync(server.dataDir, { recursive: true, force: true });
    }
  }
});
