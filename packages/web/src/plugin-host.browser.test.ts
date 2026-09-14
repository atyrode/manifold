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
