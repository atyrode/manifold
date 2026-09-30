import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PLUGIN_BUNDLE_WEB_WORKER_FILE, PluginBundleSchema } from "@manifold/protocol";
import { compilePlugin } from "@manifold/plugin-kit/pack";
import { Browser } from "../../../../scripts/cdp.ts";
import { until } from "../../../../scripts/gate-lib.ts";
import { machinesManifest } from "@manifold-plugin/machines";

const browser = new Browser();
let scratch = "";
let server: Bun.Server<undefined> | undefined;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "manifold-machine-confirmation-"));
  const plugin = resolve(import.meta.dir, "../..");
  const compiled = await compilePlugin(scratch, {
    source: {
      manifest: { ...machinesManifest, entry: { web: "web.js", worker: true } },
      web: Bun.resolveSync("@manifold-plugin/machines/portable", plugin),
    },
  });
  const bundle = PluginBundleSchema.parse(JSON.parse(new TextDecoder().decode(compiled.bytes)));
  const workerSource = Buffer.from(bundle.files[PLUGIN_BUNDLE_WEB_WORKER_FILE]!, "base64");
  const entry = join(scratch, "fixture.js");
  const output = join(scratch, "dist");
  await Bun.write(
    entry,
    `
    import { createElement } from ${JSON.stringify(Bun.resolveSync("react", plugin))};
    import { createRoot } from ${JSON.stringify(Bun.resolveSync("react-dom/client", plugin))};
    import { flushSync } from ${JSON.stringify(Bun.resolveSync("react-dom", plugin))};
    import { MachinesSection } from ${JSON.stringify(Bun.resolveSync("@manifold-plugin/machines/web", plugin))};
    import { VocabularyRenderer } from ${JSON.stringify(resolve(import.meta.dir, "./vocabulary.tsx"))};

    const params = new URL(location.href).searchParams;
    const hardened = params.get("mode") === "worker";
    const revoked = params.get("revoked") === "true";
    const root = createRoot(document.getElementById("root"));
    const outside = document.getElementById("outside");
    const principal = { id: "viewer", kind: "human", name: "Viewer", color: "#74c0fc" };
    const context = { principal, caps: ["machines:mint"], containerId: null,
      workspaceCaps: ["machines:mint"], workspaceEvents: false,
      topics: { index: [], terminals: [], attendance: [], machines: [] },
      status: "open", hidden: false, canAuthor: false };
    let machines = [{ id: "machine-one", name: "Review machine", online: !revoked,
      revoked, terminalExecution: "unconfined", color: "#74c0fc" }];
    const actions = [], errors = [], held = [], barriers = [];
    let hold = false, worker = null, finish = null, closed = false;
    const init = { t: "init", pluginId: "core.machines", principal,
      caps: context.caps, containerId: null };
    const selector = '[data-testid="machine-' + (revoked ? "forget" : "revoke") + '"]';
    const settle = () => {
      if (!worker) return Promise.resolve();
      const barrier = Promise.withResolvers();
      barriers.push(barrier.resolve);
      // The ready reply is a FIFO fence after prior events, not a timed guess.
      worker.postMessage(init);
      return barrier.promise;
    };
    const act = (action, args) => {
      if (action === "core.machines.listHostViews") return Promise.resolve({ ok: true, result: { revision: 0, hosts: [] } });
      actions.push({ action, args });
      const pending = Promise.withResolvers();
      finish = () => {
        machines = action === "core.machines.forget" ? [] : machines.map(machine => ({ ...machine, revoked: true, online: false }));
        pending.resolve({ ok: true, result: {} });
        finish = null;
      };
      return pending.promise;
    };
    const paint = tree => flushSync(() => root.render(createElement(VocabularyRenderer, {
      tree, kind: "section",
      onEvent: (event, payload) => worker.postMessage({ t: "event", instance: "machines", event, payload }),
    })));
    if (hardened) {
      worker = new Worker("/worker.js", { type: "module" });
      worker.addEventListener("error", event => errors.push(event.message));
      let mounted = false;
      worker.addEventListener("message", ({ data: frame }) => {
        if (frame.t === "ready") {
          if (mounted) barriers.shift()?.();
          else {
            mounted = true;
            worker.postMessage({ t: "mount", instance: "machines", panel: "machines", kind: "section", context });
          }
        } else if (frame.t === "render") {
          if (hold) held.push(frame.tree);
          else paint(frame.tree);
        } else if (frame.t === "call") {
          const reply = result => worker.postMessage({ t: "reply", id: frame.id, ok: true, result });
          if (frame.method === "machines") reply(machines);
          else if (frame.method === "action") void act(...frame.args).then(reply);
          else errors.push("Unexpected host call: " + frame.method);
        } else if (frame.t === "fault") errors.push(frame.error);
      });
      worker.postMessage(init);
    } else {
      const client = { selfCaps: () => context.caps, machines: async () => machines,
        workspaceCaps: () => context.workspaceCaps, workspaceEventsAvailable: () => false,
        onAuthorityChange: () => () => {}, syncSubscriptions: async () => true,
        status: "open", on: () => () => {}, subscribe: () => () => {}, action: act };
      const host = { ...context, client, authoring: null, navigate: () => {} };
      flushSync(() => root.render(createElement(MachinesSection, { host })));
    }
    window.machineConfirmation = {
      actions, errors,
      get heldPaints() { return held.length; },
      begin() {
        hold = hardened;
        const control = document.querySelector(selector);
        control.focus();
        flushSync(() => control.click());
      },
      async leaveAndDeliver() {
        // The page still has the unarmed frame here. Real focus departure must be
        // reported even though the armed frame is waiting at the delivery gate.
        outside.focus();
        const departed = document.activeElement === outside;
        await settle();
        hold = false;
        for (const tree of held.splice(0)) paint(tree);
        return departed;
      },
      async press() {
        const control = document.querySelector(selector);
        control.focus();
        flushSync(() => control.click());
        await settle();
      },
      complete() {
        if (!finish) throw new Error("No confirmed administration to complete");
        finish();
      },
      async close() {
        if (closed) return;
        closed = true;
        root.unmount();
        if (worker) {
          worker.postMessage({ t: "unmount", instance: "machines" });
          await settle();
          worker.terminate();
          worker = null;
        }
      },
    };
  `,
  );
  const build = await Bun.build({ entrypoints: [entry], target: "browser", outdir: output });
  if (!build.success)
    throw new Error(
      `Machine confirmation fixture build failed: ${build.logs.map(String).join("\n")}`,
    );
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/worker.js")
        return new Response(workerSource, { headers: { "Content-Type": "text/javascript" } });
      if (path === "/fixture.js")
        return new Response(Bun.file(join(output, "fixture.js")), {
          headers: { "Content-Type": "text/javascript" },
        });
      return new Response(
        '<!doctype html><meta charset="utf-8"><style>body{background:#171b20;color:#dee2e6;font-family:sans-serif}#root{width:340px}</style><div id="root"></div><button id="outside">Leave confirmation</button><script type="module" src="/fixture.js"></script>',
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  await browser.launch({ incognito: true });
}, 60_000);

afterEach(async () => {
  await browser.evaluate<void>("window.machineConfirmation?.close()");
  expect(await browser.evaluate<string[]>("window.machineConfirmation?.errors ?? []")).toEqual([]);
  expect(browser.drainMessages().filter((message) => message.level === "error")).toEqual([]);
});

afterAll(async () => {
  await browser.close();
  await server?.stop(true);
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
});

for (const mode of ["worker", "native"] as const) {
  for (const revoked of [false, true]) {
    const verb = revoked ? "forget" : "withdraw";
    test(`${mode}: leaving ${verb} before armed paint requires a fresh two-press confirmation`, async () => {
      if (!server) throw new Error("Machine confirmation fixture did not start");
      await browser.send("Page.navigate", {
        url: `http://127.0.0.1:${String(server.port)}/?mode=${mode}&revoked=${String(revoked)}`,
      });
      const selector = `[data-testid="machine-${revoked ? "forget" : "revoke"}"]`;
      await until(
        () =>
          browser.evaluate<boolean>(
            `location.search === "?mode=${mode}&revoked=${String(revoked)}" && window.machineConfirmation !== undefined && document.querySelector(${JSON.stringify(selector)}) !== null`,
          ),
        5_000,
        `${mode} machine control`,
      );
      await browser.evaluate<void>("window.machineConfirmation.begin()");
      if (mode === "worker") {
        await until(
          () => browser.evaluate<boolean>("window.machineConfirmation.heldPaints > 0"),
          5_000,
          "armed paint held behind delivery gate",
        );
      }
      expect(await browser.evaluate<boolean>("window.machineConfirmation.leaveAndDeliver()")).toBe(
        true,
      );
      await browser.evaluate<void>("window.machineConfirmation.press()");
      // This is the destructive-effect boundary: the later click only arms, even
      // when the first blur happened while the page still showed the old frame.
      expect(await browser.evaluate<unknown[]>("window.machineConfirmation.actions")).toEqual([]);
      await browser.evaluate<void>("window.machineConfirmation.press()");
      const expected = [
        {
          action: revoked ? "core.machines.forget" : "core.machines.revoke",
          args: { machineId: "machine-one" },
        },
      ];
      expect(await browser.evaluate<unknown[]>("window.machineConfirmation.actions")).toEqual(
        expected,
      );
      expect(
        await browser.evaluate<boolean>(
          `document.querySelector(${JSON.stringify(selector)}).disabled`,
        ),
      ).toBe(true);
      await browser.evaluate<void>("window.machineConfirmation.press()");
      expect(await browser.evaluate<unknown[]>("window.machineConfirmation.actions")).toEqual(
        expected,
      );
      await browser.evaluate<void>("window.machineConfirmation.complete()");
      await until(
        () =>
          browser.evaluate<boolean>(
            revoked
              ? 'document.querySelector("[data-testid=machines-rail] button") === null'
              : 'document.querySelector("[data-testid=machine-forget]") !== null',
          ),
        5_000,
        `${verb} reflected by refreshed machine inventory`,
      );
    }, 60_000);
  }
}
