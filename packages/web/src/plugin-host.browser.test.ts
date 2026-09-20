import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PluginRoster, ServerEvent } from "@manifold/protocol";
import { Browser } from "../../../scripts/cdp.ts";
import { until } from "../../../scripts/gate-lib.ts";

const roster: PluginRoster = [
  {
    manifest: {
      id: "acme.feed",
      title: "Feed",
      version: "1.0.0",
      description: "",
      capabilities: [],
      contributes: {
        panels: [],
        sections: [{ id: "feed", title: "Feed", order: 0, setting: "visible" }],
        elements: [],
        tools: [],
        events: [],
        settings: [{ id: "visible", title: "Visible", kind: "boolean", default: true }],
      },
    },
    enabled: true,
    source: "plugin",
    actions: [],
  },
];

test("settings only refetch for their owner, not a foreign same-kind event on the same topic", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "manifold-settings-origin-"));
  const browser = new Browser();
  let server: Bun.Server<undefined> | undefined;
  try {
    const entry = join(scratch, "fixture.js");
    const output = join(scratch, "dist");
    await Bun.write(
      entry,
      `
      import { createElement, useEffect } from ${JSON.stringify(Bun.resolveSync("react", import.meta.dir))};
      import { createRoot } from ${JSON.stringify(Bun.resolveSync("react-dom/client", import.meta.dir))};
      import { flushSync } from ${JSON.stringify(Bun.resolveSync("react-dom", import.meta.dir))};
      import { AssemblyProvider, useAssembly, useAttachPluginsClient } from ${JSON.stringify(resolve(import.meta.dir, "plugin-host.tsx"))};
      const listeners = new Set();
      const client = {
        onPlugins: () => () => {},
        on: () => () => {},
        subscribe: (_topics, handler) => { listeners.add(handler); return () => listeners.delete(handler); },
      };
      let visible = true, reads = 0;
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (url, init) => {
        const path = new URL(String(url), location.href).pathname;
        if (path === "/api/plugins") return Response.json({ plugins: ${JSON.stringify(roster)} });
        if (path === "/api/bindings") return Response.json({ overrides: {} });
        if (path === "/api/settings") {
          reads += 1;
          return Response.json({ values: { "acme.feed.visible": visible } });
        }
        return originalFetch(url, init);
      };
      function Feed() {
        const assembly = useAssembly();
        const attach = useAttachPluginsClient();
        useEffect(() => attach(client), [attach]);
        return createElement("output", null, assembly.sections.map(section => section.title).join(", ") || "No sections");
      }
      window.settingsFixture = {
        reads: () => reads,
        setVisible: value => { visible = value; },
        emit: event => flushSync(() => { for (const listener of listeners) listener(event); }),
      };
      const identity = { token: "fixture", principal: { id: "viewer", kind: "human", name: "Viewer", color: "#74c0fc" } };
      createRoot(document.getElementById("root")).render(createElement(AssemblyProvider, { identity }, createElement(Feed)));
      `,
    );
    const build = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      outdir: output,
      define: { "import.meta.env": "{}" },
    });
    if (!build.success) throw new Error(build.logs.map(String).join("\n"));
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/fixture.js") {
          return new Response(Bun.file(join(output, "fixture.js")), {
            headers: { "Content-Type": "text/javascript" },
          });
        }
        return new Response(
          '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/fixture.js"></script>',
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
    await browser.launch({ incognito: true });
    await browser.goto(`http://127.0.0.1:${String(server.port)}/`);
    await until(
      () => browser.evaluate<boolean>('document.querySelector("output")?.textContent === "Feed"'),
      5_000,
      "the visible feed section",
    );
    const initialReads = await browser.evaluate<number>("window.settingsFixture.reads()");
    await browser.evaluate<void>("window.settingsFixture.setVisible(false)");
    const event: ServerEvent = {
      type: "event",
      topic: { kind: "plugin", pluginId: "engine.plugins" },
      plugin: "acme.foreign",
      kind: "plugin_setting_changed",
      actor: null,
      at: 1,
      payload: {},
    };
    await browser.evaluate<void>(`window.settingsFixture.emit(${JSON.stringify(event)})`);
    await browser.evaluate<void>(
      "(() => { const frame = Promise.withResolvers(); requestAnimationFrame(() => requestAnimationFrame(frame.resolve)); return frame.promise; })()",
    );
    expect(await browser.evaluate<number>("window.settingsFixture.reads()")).toBe(initialReads);
    expect(await browser.evaluate<string>('document.querySelector("output").textContent')).toBe(
      "Feed",
    );

    await browser.evaluate<void>(
      `window.settingsFixture.emit(${JSON.stringify({ ...event, plugin: "engine.plugins" })})`,
    );
    await until(
      () =>
        browser.evaluate<boolean>(
          'document.querySelector("output")?.textContent === "No sections"',
        ),
      5_000,
      "the owner event removing the hidden section",
    );
    expect(await browser.evaluate<number>("window.settingsFixture.reads()")).toBe(initialReads + 1);
    expect(browser.drainMessages().filter((message) => message.level === "error")).toEqual([]);
  } finally {
    await browser.close();
    await server?.stop(true);
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);

const panelRoster: PluginRoster = [
  { id: "acme.off", title: "Offline notebook", enabled: false },
  { id: "acme.remote", title: "Remote notebook", enabled: true },
].map<PluginRoster[number]>(({ id, title, enabled }) => ({
  manifest: {
    id,
    title,
    version: "1.0.0",
    description: "",
    capabilities: [],
    contributes: {
      panels: [{ id: "home", title: "Notebook" }],
      sections: [],
      elements: [],
      tools: [],
      events: [],
      settings: [],
    },
  },
  enabled,
  source: "plugin",
  actions: [],
}));

async function withRosterFixture(run: (browser: Browser) => Promise<void>): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "manifold-roster-startup-"));
  const browser = new Browser();
  let server: Bun.Server<undefined> | undefined;
  try {
    const entry = join(scratch, "fixture.js");
    const output = join(scratch, "dist");
    await Bun.write(
      entry,
      `
      import { createElement, useEffect, useState } from ${JSON.stringify(Bun.resolveSync("react", import.meta.dir))};
      import { createRoot } from ${JSON.stringify(Bun.resolveSync("react-dom/client", import.meta.dir))};
      import { flushSync } from ${JSON.stringify(Bun.resolveSync("react-dom", import.meta.dir))};
      import {
        AssemblyProvider, RosterGate, HostServicesProvider, PanelOutlet,
        useAttachPluginsClient,
      } from ${JSON.stringify(resolve(import.meta.dir, "plugin-host.tsx"))};
      const requests = [], listeners = new Set();
      const client = {
        onPlugins: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        on: () => () => {},
        subscribe: () => () => {},
      };
      const originalFetch = window.fetch.bind(window);
      window.fetch = (url, init) => {
        const path = new URL(String(url), location.href).pathname;
        if (path === "/api/plugins") {
          const deferred = Promise.withResolvers();
          // Deliberately deliver even after cancellation: late transport completion must not
          // outrank the live snapshot that already made the workspace authoritative.
          requests.push(deferred);
          return deferred.promise;
        }
        if (path === "/api/bindings") return Promise.resolve(Response.json({ overrides: {} }));
        if (path === "/api/settings") return Promise.resolve(Response.json({ values: {} }));
        return originalFetch(url, init);
      };
      function LiveAttachment() {
        const attach = useAttachPluginsClient();
        useEffect(() => attach(client), [attach]);
        return null;
      }
      function Workspace() {
        const [panels, setPanels] = useState(["acme.off.home", "acme.remote.home"]);
        return createElement("section", { "data-workspace": "" },
          panels.map(panelId => createElement("article", { key: panelId, "data-panel": panelId },
            createElement(PanelOutlet, {
              panelId, tileId: panelId,
              onRemove: () => setPanels(current => current.filter(id => id !== panelId)),
            }))));
      }
      const paint = () => {
        const frame = Promise.withResolvers();
        requestAnimationFrame(() => requestAnimationFrame(frame.resolve));
        return frame.promise;
      };
      window.rosterFixture = {
        requests: () => requests.length,
        attached: () => listeners.size > 0,
        respond: async (index, plugins, status = 200) => {
          const response = Response.json({ plugins }, { status });
          // Keep body decoding in the same microtask turn as the controlled fetch, then wait
          // for React to paint; no network or timer can race the late-response assertions.
          const body = await response.json();
          response.json = () => Promise.resolve(body);
          requests[index].resolve(response);
          await paint();
        },
        reject: async index => {
          requests[index].reject(new TypeError("Network unavailable"));
          await paint();
        },
        emit: (plugins, developerMode = false) => flushSync(() => {
          for (const listener of listeners) listener(plugins, developerMode);
        }),
      };
      const identity = { token: "fixture", principal: { id: "viewer", kind: "human", name: "Viewer", color: "#74c0fc" } };
      const root = createRoot(document.getElementById("root"));
      const renderIdentity = currentIdentity => root.render(
        createElement(AssemblyProvider, { identity: currentIdentity },
          createElement(LiveAttachment),
          createElement(RosterGate, null,
            // Placeholder branches never call host services, but consume the real context.
            createElement(HostServicesProvider, { value: {} }, createElement(Workspace)))));
      window.rosterFixture.changeIdentity = token =>
        flushSync(() => renderIdentity({ ...identity, token }));
      renderIdentity(identity);
      `,
    );
    const build = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      outdir: output,
      define: { "import.meta.env": "{}" },
    });
    if (!build.success) throw new Error(build.logs.map(String).join("\n"));
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/fixture.js") {
          return new Response(Bun.file(join(output, "fixture.js")), {
            headers: { "Content-Type": "text/javascript" },
          });
        }
        return new Response(
          '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/fixture.js"></script>',
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
    await browser.launch({ incognito: true });
    await browser.goto(`http://127.0.0.1:${String(server.port)}/`);
    await until(
      () =>
        browser.evaluate<boolean>(
          "window.rosterFixture?.requests() === 1 && window.rosterFixture.attached()",
        ),
      5_000,
      "the held initial roster request and independently mounted live attachment",
    );
    await run(browser);
    expect(browser.drainMessages().filter((message) => message.kind === "exception")).toEqual([]);
  } finally {
    await browser.close();
    await server?.stop(true);
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function expectRosterGate(browser: Browser, state: "pending" | "failed"): Promise<void> {
  const role = state === "pending" ? "status" : "alert";
  await until(
    () =>
      browser.evaluate<boolean>(
        `(() => {
          const gate = document.querySelector('[data-roster-state="${state}"]');
          return gate !== null && (gate.matches('[role="${role}"]') ||
            gate.querySelector('[role="${role}"]') !== null);
        })()`,
      ),
    5_000,
    `the ${state} roster gate`,
  );
  expect(
    await browser.evaluate<boolean>(
      'document.querySelector("[data-workspace], [data-plugin-state], .plugin-placeholder__remove") === null',
    ),
  ).toBe(true);
}

async function expectNamedPanels(browser: Browser): Promise<void> {
  await until(
    () =>
      browser.evaluate<boolean>(
        'document.querySelector(\'[data-panel="acme.off.home"] [data-plugin-state="disabled"]\') !== null && document.querySelector(\'[data-panel="acme.remote.home"] [data-plugin-state="unavailable"]\') !== null',
      ),
    5_000,
    "the authoritative disabled and unavailable panels",
  );
  expect(
    await browser.evaluate<string[]>(
      'Array.from(document.querySelectorAll(".plugin-placeholder__name"), node => node.textContent)',
    ),
  ).toEqual(["Offline notebook", "Remote notebook"]);
  expect(
    await browser.evaluate<boolean>('document.querySelector("[data-roster-state]") === null'),
  ).toBe(true);
}

test("pending roster hides removable placeholders until HTTP authority names the panels", async () => {
  await withRosterFixture(async (browser) => {
    await expectRosterGate(browser, "pending");
    await browser.evaluate<void>(`window.rosterFixture.respond(0, ${JSON.stringify(panelRoster)})`);
    await expectNamedPanels(browser);
  });
}, 60_000);

test("failed roster offers an actual retry that stays neutral until its response succeeds", async () => {
  await withRosterFixture(async (browser) => {
    await browser.evaluate<void>("window.rosterFixture.respond(0, [], 503)");
    await expectRosterGate(browser, "failed");
    expect(
      await browser.evaluate<boolean>(`(() => {
        const button = document.querySelector('[data-roster-state="failed"] button');
        if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
        button.click();
        return true;
      })()`),
    ).toBe(true);
    await until(
      () => browser.evaluate<boolean>("window.rosterFixture.requests() === 2"),
      5_000,
      "the retry requesting a fresh roster",
    );
    await expectRosterGate(browser, "pending");
    await browser.evaluate<void>(`window.rosterFixture.respond(1, ${JSON.stringify(panelRoster)})`);
    await expectNamedPanels(browser);
  });
}, 60_000);

test("an authoritative empty HTTP roster exposes genuinely unknown panels that can be removed", async () => {
  await withRosterFixture(async (browser) => {
    await browser.evaluate<void>("window.rosterFixture.respond(0, [])");
    await until(
      () =>
        browser.evaluate<boolean>(
          "document.querySelectorAll('[data-plugin-state=\"unknown\"]').length === 2",
        ),
      5_000,
      "unknown panels after an authoritative empty roster",
    );
    expect(
      await browser.evaluate<boolean>('document.querySelector("[data-roster-state]") === null'),
    ).toBe(true);
    expect(
      await browser.evaluate<string[]>(
        'Array.from(document.querySelectorAll(".plugin-placeholder__name"), node => node.textContent)',
      ),
    ).toEqual(["acme.off.home", "acme.remote.home"]);
    await browser.evaluate<void>(
      "document.querySelector('[data-panel=\"acme.off.home\"] .plugin-placeholder__remove').click()",
    );
    await until(
      () =>
        browser.evaluate<boolean>(
          'document.querySelector(\'[data-panel="acme.off.home"]\') === null && document.querySelector(\'[data-panel="acme.remote.home"] [data-plugin-state="unknown"]\') !== null',
        ),
      5_000,
      "removal of only the selected unknown panel",
    );
  });
}, 60_000);

test("a live empty roster recovers a failed HTTP load without leaving the gate pending", async () => {
  await withRosterFixture(async (browser) => {
    await browser.evaluate<void>("window.rosterFixture.respond(0, [], 503)");
    await expectRosterGate(browser, "failed");
    await browser.evaluate<void>("window.rosterFixture.emit([])");
    await until(
      () =>
        browser.evaluate<boolean>(
          'document.querySelector("[data-roster-state]") === null && document.querySelectorAll(\'[data-plugin-state="unknown"]\').length === 2',
        ),
      5_000,
      "the live authoritative empty roster releasing the failed gate",
    );
  });
}, 60_000);

for (const completion of ["success", "rejection"] as const) {
  test(`live roster authority survives a late initial HTTP ${completion}`, async () => {
    await withRosterFixture(async (browser) => {
      await expectRosterGate(browser, "pending");
      await browser.evaluate<void>(
        `window.rosterFixture.emit(${JSON.stringify(panelRoster)}, true)`,
      );
      await expectNamedPanels(browser);
      await browser.evaluate<void>(
        completion === "success"
          ? "window.rosterFixture.respond(0, [])"
          : "window.rosterFixture.reject(0)",
      );
      await expectNamedPanels(browser);
    });
  }, 60_000);
}

test("a replacement credential cannot reuse ready metadata or accept the previous boot response", async () => {
  await withRosterFixture(async (browser) => {
    await browser.evaluate<void>(`window.rosterFixture.emit(${JSON.stringify(panelRoster)})`);
    await expectNamedPanels(browser);
    // Keep the same React root and public provider: production must own the reset, not setup.
    await browser.evaluate<void>('window.rosterFixture.changeIdentity("replacement")');
    await expectRosterGate(browser, "pending");
    await until(
      () => browser.evaluate<boolean>("window.rosterFixture.requests() === 2"),
      5_000,
      "the replacement credential's own roster request",
    );
    await browser.evaluate<void>("window.rosterFixture.respond(0, [])");
    await expectRosterGate(browser, "pending");
    await browser.evaluate<void>(`window.rosterFixture.respond(1, ${JSON.stringify(panelRoster)})`);
    await expectNamedPanels(browser);
  });
}, 60_000);
