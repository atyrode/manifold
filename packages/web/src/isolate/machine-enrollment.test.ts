import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PLUGIN_BUNDLE_WEB_WORKER_FILE, PluginBundleSchema } from "@manifold/protocol";
import { compilePlugin } from "@manifold/plugin-kit/pack";
import { machinesManifest } from "@manifold-plugin/machines";
import { Browser } from "../../../../scripts/cdp.ts";
import { until } from "../../../../scripts/gate-lib.ts";

const browser = new Browser();
let scratch = "";
let server: Bun.Server<undefined> | undefined;
const credentialSelector = '[data-testid="shell-account-credential"] input';

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "manifold-machine-enrollment-"));
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
    import { WorkerHost } from ${JSON.stringify(resolve(import.meta.dir, "./worker-host.ts"))};

    const hardened = new URL(location.href).searchParams.get("mode") === "worker";
    const root = createRoot(document.getElementById("root"));
    const principal = { id: "fixture-viewer", kind: "human", name: "Fixture viewer", color: "#74c0fc" };
    const adminCaps = ["machines:mint"];
    const machines = [{ id: "fixture-machine", name: "Existing enrollment", online: true, terminalExecution: "unconfined" }];
    const noCaps = [];
    const errors = [];
    let workerHost = null, pending = null, pause = false, closed = false;
    const makeHost = () => {
      const authorityListeners = new Set(), statusListeners = new Set();
      const state = { caps: adminCaps, status: "open", authorityListeners, statusListeners };
      const client = {
        get status() { return state.status; },
        selfCaps: () => adminCaps,
        workspaceCaps: () => state.status === "open" ? state.caps : noCaps,
        workspaceEventsAvailable: () => false,
        onAuthorityChange: callback => { authorityListeners.add(callback); return () => authorityListeners.delete(callback); },
        on: (event, callback) => { if (event === "status") statusListeners.add(callback); return () => statusListeners.delete(callback); },
        subscribe: () => () => {}, syncSubscriptions: async () => true,
        machines: async () => machines,
        action: async (action, args) => {
          if (action === "core.machines.listHostViews") return { ok: true, result: { revision: 0, hosts: [] } };
          if (action !== "core.machines.enroll") throw new Error("Unexpected fixture action");
          const result = { ok: true, result: { machine: { id: "new-fixture-machine", name: args.name }, machineToken: "one-time-fixture-credential" } };
          if (!pause) return result;
          const deferred = Promise.withResolvers();
          pending = () => { deferred.resolve(result); pending = null; };
          return deferred.promise;
        },
      };
      return { state, host: { principal, caps: adminCaps, containerId: null, topics: { index: [], terminals: [], attendance: [], machines: [] }, client, authoring: null, navigate: () => {} } };
    };
    let current = makeHost();
    const paint = () => flushSync(() => root.render(createElement(MachinesSection, { host: current.host })));
    if (hardened) {
      workerHost = new WorkerHost({ pluginId: "core.machines", principal, caps: adminCaps, containerId: null,
        host: current.host, portableWorker: true, workerFactory: () => new Worker("/worker.js", { type: "module" }) });
      workerHost.mount("machines", "machines", tree => flushSync(() => root.render(createElement(VocabularyRenderer, {
        tree, kind: "section", onEvent: (event, payload) => workerHost.event("machines", event, payload),
      }))), error => errors.push(error), { kind: "section" });
      workerHost.start();
    } else paint();
    window.fleetEnrollment = {
      errors,
      get pending() { return pending !== null; },
      pause() { pause = true; },
      complete() { if (!pending) throw new Error("No pending enrollment"); pending(); },
      authority(caps, status = "open") {
        const previous = current.state.status;
        current.state.caps = caps;
        current.state.status = status;
        flushSync(() => {
          for (const listener of [...current.state.authorityListeners]) listener();
          if (previous !== status) for (const listener of [...current.state.statusListeners]) listener(status);
        });
      },
      replaceClient() {
        current = makeHost();
        if (workerHost) workerHost.update("machines", current.host);
        else paint();
      },
      close() {
        if (closed) return;
        closed = true;
        root.unmount();
        workerHost?.stop();
      },
    };
  `,
  );
  const build = await Bun.build({ entrypoints: [entry], target: "browser", outdir: output });
  if (!build.success)
    throw new Error(`Enrollment fixture build failed: ${build.logs.map(String).join("\n")}`);
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
        '<!doctype html><meta charset="utf-8"><style>body{background:#171b20;color:#dee2e6;font-family:sans-serif}#root{width:340px}</style><div id="root"></div><script type="module" src="/fixture.js"></script>',
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  await browser.launch({ incognito: true });
}, 60_000);

afterEach(async () => {
  await browser.evaluate<void>("window.fleetEnrollment?.close()");
  expect(await browser.evaluate<string[]>("window.fleetEnrollment?.errors ?? []")).toEqual([]);
  expect(browser.drainMessages().filter((message) => message.level === "error")).toEqual([]);
});
afterAll(async () => {
  await browser.close();
  await server?.stop(true);
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
});

async function open(mode: "native" | "worker"): Promise<void> {
  if (!server) throw new Error("Enrollment fixture did not start");
  await browser.evaluate<void>("window.fleetEnrollment?.close()");
  await browser.send("Page.navigate", {
    url: `http://127.0.0.1:${String(server.port)}/?mode=${mode}`,
  });
  await until(
    () =>
      browser.evaluate<boolean>(
        'window.fleetEnrollment !== undefined && [...document.querySelectorAll("button")].some(button => button.textContent === "Enroll shell account")',
      ),
    5_000,
    "enrollment setup",
  );
  await browser.evaluate<void>(
    '[...document.querySelectorAll("button")].find(button => button.textContent === "Enroll shell account").click()',
  );
  await until(
    () => browser.evaluate<boolean>('document.querySelector("input:not([readonly])") !== null'),
    5_000,
    "enrollment name",
  );
  await browser.evaluate<void>('document.querySelector("input:not([readonly])").focus()');
  await browser.typeText("Fresh fixture enrollment");
  await until(
    () =>
      browser.evaluate<boolean>(
        'document.querySelector("[data-action=\\"core.machines.enroll\\"]:not([aria-expanded])")?.disabled === false',
      ),
    5_000,
    "enrollment admission",
  );
}
async function enroll(): Promise<void> {
  await browser.evaluate<void>(
    'document.querySelector("[data-action=\\"core.machines.enroll\\"]:not([aria-expanded])").click()',
  );
}
async function reveal(): Promise<void> {
  await until(
    () =>
      browser.evaluate<boolean>(
        `document.querySelector(${JSON.stringify(credentialSelector)})?.value === "one-time-fixture-credential"`,
      ),
    5_000,
    "one-time credential",
  );
}
async function absent(): Promise<void> {
  await until(
    () =>
      browser.evaluate<boolean>(
        `document.querySelector(${JSON.stringify(credentialSelector)}) === null`,
      ),
    5_000,
    "credential subtree retired",
  );
}

for (const mode of ["native", "worker"] as const) {
  test(`${mode}: actual administration loss clears a revealed credential, temporary unknown authority does not`, async () => {
    await open(mode);
    await enroll();
    await reveal();
    await browser.evaluate<void>('window.fleetEnrollment.authority([], "connecting")');
    await absent();
    await browser.evaluate<void>('window.fleetEnrollment.authority(["machines:mint"])');
    await reveal();
    await browser.evaluate<void>("window.fleetEnrollment.authority([])");
    await absent();
    await browser.evaluate<void>('window.fleetEnrollment.authority(["machines:mint"])');
    await until(
      () =>
        browser.evaluate<boolean>(
          '[...document.querySelectorAll("button")].some(button => button.textContent === "Enroll shell account")',
        ),
      5_000,
      "administration restored",
    );
    expect(
      await browser.evaluate<boolean>(
        `document.querySelector(${JSON.stringify(credentialSelector)}) === null`,
      ),
    ).toBe(true);
  }, 60_000);

  test(`${mode}: replacing an identically authorized client retires both current and delayed credential reveals`, async () => {
    await open(mode);
    await enroll();
    await reveal();
    await browser.evaluate<void>("window.fleetEnrollment.replaceClient()");
    await absent();
    await open(mode);
    await browser.evaluate<void>("window.fleetEnrollment.pause()");
    await enroll();
    await until(
      () => browser.evaluate<boolean>("window.fleetEnrollment.pending"),
      5_000,
      "enrollment held at response boundary",
    );
    await browser.evaluate<void>(
      "window.fleetEnrollment.replaceClient(); window.fleetEnrollment.complete()",
    );
    await until(
      () =>
        browser.evaluate<boolean>(
          '[...document.querySelectorAll("button")].some(button => button.textContent === "Enroll shell account")',
        ),
      5_000,
      "successor client view",
    );
    expect(
      await browser.evaluate<boolean>(
        `document.querySelector(${JSON.stringify(credentialSelector)}) === null`,
      ),
    ).toBe(true);
  }, 60_000);
}
