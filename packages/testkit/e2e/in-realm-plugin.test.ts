import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../../../scripts/cdp.ts";
import { resolveWebDist } from "../../../scripts/gate-dist.ts";
import { createContainer, ownerAction, startServer, waitFor } from "../src/index.ts";

// Real DOM boundary: a roster received by an already-open second browser must load React.
test("in-realm install appears in a second open browser; disable drops it and re-enable reloads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "manifold-in-realm-"));
  const dist = resolveWebDist("manifold-in-realm-web-");
  const server = await startServer({
    env: {
      MANIFOLD_PLUGIN_DEV_PATHS: "1",
      MANIFOLD_WEB_DIST: dist.distDir,
    },
  });
  const first = new Browser();
  const second = new Browser();
  try {
    // Exercise the author's CLI; Bun.test's isolated linker cannot build Yjs in-process.
    const file = join(dir, "counter.json");
    const pack = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "../../plugin-kit/src/pack.ts"),
        join(import.meta.dir, "../../plugin-kit/test/fixtures/in-realm"),
        "--out",
        file,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(pack.stdout).text(),
      new Response(pack.stderr).text(),
      pack.exited,
    ]);
    if (exit !== 0) throw new Error(`pack failed: ${stderr}`);
    const packed = JSON.parse(stdout) as { file: string; sha256: string };
    await first.launch();
    await second.launch();
    await first.goto(`${server.httpUrl}/#key=${server.ownerKey}`);
    await second.goto(`${server.httpUrl}/#key=${server.ownerKey}`);
    await first.typeInto("#identity-name", "loader-first");
    await first.clickTestId("identity-enter");
    await second.typeInto("#identity-name", "loader-second");
    await second.clickTestId("identity-enter");
    await waitFor(
      () => second.evaluate<boolean>("document.querySelector('#identity-name') === null"),
      10_000, 50,
    );
    const container = await createContainer(server, "Loader test");
    // Reserve the panel in this principal's layout before installation, as a missing-plugin
    // placeholder. Installation must replace it in-place, not require navigation or rejoin.
    expect(await second.evaluate<boolean>(`(async () => {
      const identity = JSON.parse(localStorage.getItem("manifold.identity"));
      const headers = { Authorization: "Bearer " + identity.token, "Content-Type": "application/json" };
      const { layout } = await (await fetch("/api/layout", { headers })).json();
      const root = layout.root;
      root.children.push("loader-counter");
      root.ratios.push(1);
      layout["loader-counter"] = { id: "loader-counter", dir: null, ratios: [], children: [],
        ref: { kind: "panel", panelId: "example.counter.counter" } };
      return (await (await fetch("/api/actions/core.space.setLayout", {
        method: "POST", headers, body: JSON.stringify({ layout }),
      })).json()).ok;
    })()`)).toBe(true);
    await first.goto(`${server.httpUrl}/p/${container.id}`);
    await second.goto(`${server.httpUrl}/p/${container.id}`);
    await second.evaluate("globalThis.__inRealmNoReload = 'open-before-install'");
    const visible = () =>
      second.evaluate<boolean>("document.querySelector('[data-testid=in-realm-counter]') !== null");
    expect(await visible()).toBe(false);
    await ownerAction(server, "engine.plugins.install", {
      source: packed.file,
      sha256: packed.sha256,
      hardened: false,
    });
    await waitFor(visible, 15_000, 50);
    expect(await second.evaluate("globalThis.__inRealmNoReload")).toBe("open-before-install");
    await ownerAction(server, "engine.plugins.setEnabled", {
      id: "example.counter",
      enabled: false,
    });
    await waitFor(async () => !(await visible()), 10_000, 50);
    await ownerAction(server, "engine.plugins.setEnabled", {
      id: "example.counter",
      enabled: true,
    });
    await waitFor(visible, 10_000, 50);
    expect(await second.evaluate("globalThis.__inRealmNoReload")).toBe("open-before-install");
  } catch (error) {
    console.error(await second.evaluate("document.body.innerText"), second.drainMessages());
    throw error;
  } finally {
    await first.close();
    await second.close();
    await server.stop();
    rmSync(server.dataDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    dist.cleanup();
  }
}, 120_000);
