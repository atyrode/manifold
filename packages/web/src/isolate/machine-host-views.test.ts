import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Browser } from "../../../../scripts/cdp.ts";
import { until } from "../../../../scripts/gate-lib.ts";

const browser = new Browser();
let scratch = "";
let server: Bun.Server<undefined> | undefined;
const hostId = "11111111-1111-4111-8111-111111111111";
const grouping = `[data-testid="host-view-${hostId}"]`;
const editor = '[data-testid="host-view-editor"]';
const save = `${editor} [data-action="core.machines.setHostView"]`;
const initialHost = {
  id: hostId,
  name: "Initial host",
  members: [{ machineId: "fixture-account", accountLabel: "Initial account" }],
};

// Real MachinesSection + shared resource store + React DOM. Deferred reads/mutations and
// a virtual feed clock choose the ordering; neither wall-clock sleeps nor remounts heal it.
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "manifold-host-views-"));
  const plugin = resolve(import.meta.dir, "../..");
  const entry = join(scratch, "fixture.js");
  const output = join(scratch, "dist");
  await Bun.write(
    entry,
    `
    import { createElement } from ${JSON.stringify(Bun.resolveSync("react", plugin))};
    import { createRoot } from ${JSON.stringify(Bun.resolveSync("react-dom/client", plugin))};
    import { flushSync } from ${JSON.stringify(Bun.resolveSync("react-dom", plugin))};
    import { MachinesSection } from ${JSON.stringify(Bun.resolveSync("@manifold-plugin/machines/web", plugin))};
    import { polledFeedReport, resetPolledResources } from ${JSON.stringify(resolve(import.meta.dir, "../../../plugin/src/polled-resource.ts"))};
    import { HostViewsSchema } from ${JSON.stringify(resolve(import.meta.dir, "../../../plugins/machines/src/host-views.ts"))};

    const timers = new Map();
    let now = 0, nextTimer = -1;
    const realTimeout = globalThis.setTimeout.bind(globalThis);
    const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
    const realInterval = globalThis.setInterval.bind(globalThis);
    const realClearInterval = globalThis.clearInterval.bind(globalThis);
    const schedule = (fn, ms, every) => {
      const id = nextTimer--;
      timers.set(id, { at: now + ms, fn, every });
      return id;
    };
    globalThis.setTimeout = (fn, ms, ...args) =>
      ms === 50 || ms === 250 ? schedule(() => fn(...args), ms, null) : realTimeout(fn, ms, ...args);
    globalThis.setInterval = (fn, ms, ...args) =>
      ms === 2000 ? schedule(() => fn(...args), ms, ms) : realInterval(fn, ms, ...args);
    globalThis.clearTimeout = id => { if (!timers.delete(id)) realClearTimeout(id); };
    globalThis.clearInterval = id => { if (!timers.delete(id)) realClearInterval(id); };
    const drain = async () => {
      for (let tick = 0; tick < 16; tick++) await Promise.resolve();
      const turn = Promise.withResolvers();
      realTimeout(turn.resolve, 0);
      await turn.promise;
    };
    const advance = async ms => {
      const target = now + ms;
      for (;;) {
        let selected = null;
        for (const [id, task] of timers) {
          if (task.at <= target && (selected === null || task.at < selected[1].at)) selected = [id, task];
        }
        if (selected === null) break;
        const [id, task] = selected;
        now = task.at;
        if (task.every === null) timers.delete(id);
        else task.at += task.every;
        flushSync(task.fn);
        await drain();
      }
      now = target;
      await drain();
    };
    const root = createRoot(document.getElementById("root"));
    const topic = { kind: "plugin", pluginId: "core.machines" };
    const caps = ["machines:mint", "containers:read"];
    const subscriptions = new Set();
    const reads = [], mutations = [];
    let registry = { revision: 1, hosts: [${JSON.stringify(initialHost)}] };
    let events = 0, fences = 0;
    const client = {
      status: "open", selfCaps: () => caps, workspaceCaps: () => caps,
      workspaceEventsAvailable: () => true,
      onAuthorityChange: () => () => {}, on: () => () => {},
      subscribe: (topics, handler) => { subscriptions.add(handler); return () => subscriptions.delete(handler); },
      syncSubscriptions: async () => { fences++; return true; },
      machines: async () => [{ id: "fixture-account", name: "Ordinary enrollment", online: true, terminalExecution: "unconfined" }],
      action: (action, args) => {
        const deferred = Promise.withResolvers();
        if (action === "core.machines.listHostViews") reads.push({ deferred, snapshot: registry });
        else if (action === "core.machines.setHostView") mutations.push({ deferred, args });
        else throw new Error("Unexpected host-view action");
        return deferred.promise;
      },
    };
    const host = { principal: { id: "viewer", kind: "human", name: "Viewer", color: "#74c0fc" },
      caps, containerId: null, topics: { index: [], terminals: [], attendance: [], machines: [topic] },
      client, authoring: null, navigate: () => {} };
    flushSync(() => root.render(createElement(MachinesSection, { host })));
    let originalRail = null, observer = null, resurrected = false;
    window.hostViewsFixture = {
      advance,
      get readCount() { return reads.length; },
      get mutationCount() { return mutations.length; },
      get resurrected() { return resurrected; },
      activity: () => ({ events, fences }),
      feed: () => polledFeedReport().find(feed => feed.key.startsWith("core.machines.listHostViews|")),
      rememberRail() { originalRail = document.querySelector('[data-testid="machines-rail"]'); },
      sameRail: () => originalRail !== null && originalRail === document.querySelector('[data-testid="machines-rail"]'),
      async answer(index) {
        const read = reads[index];
        if (!read) throw new Error("Missing pending grouping read");
        read.deferred.resolve({ ok: true, result: read.snapshot });
        await drain();
      },
      async fail(index) {
        reads[index].deferred.reject(new Error("Transient grouping read failure"));
        await drain();
      },
      commit(value) {
        registry = HostViewsSchema.parse(value);
        events++;
        for (const handler of [...subscriptions]) handler({ type: "event", topic, plugin: "core.machines", kind: "host_views_changed", at: 0, actor: null, payload: { revision: registry.revision } });
      },
      async completeMutation(result) {
        const pending = mutations.at(-1);
        if (!pending) throw new Error("No pending grouping mutation");
        pending.deferred.resolve({ ok: true, result });
        await drain();
      },
      watchRemoval() {
        observer = new MutationObserver(() => {
          if (document.querySelector(${JSON.stringify(grouping)}) !== null) resurrected = true;
        });
        observer.observe(document.getElementById("root"), { childList: true, subtree: true });
      },
      close() { observer?.disconnect(); root.unmount(); resetPolledResources(); },
    };
  `,
  );
  const build = await Bun.build({ entrypoints: [entry], target: "browser", outdir: output });
  if (!build.success)
    throw new Error(`Host-view fixture build failed: ${build.logs.map(String).join("\n")}`);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/fixture.js")
        return new Response(Bun.file(join(output, "fixture.js")), {
          headers: { "Content-Type": "text/javascript" },
        });
      return new Response(
        '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/fixture.js"></script>',
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  await browser.launch({ incognito: true });
}, 60_000);

async function waitFor(expression: string, label: string): Promise<void> {
  await until(() => browser.evaluate<boolean>(expression), 5_000, label);
}
async function click(text: string): Promise<void> {
  const clicked = await browser.evaluate<boolean>(`(() => {
    const control = [...document.querySelectorAll("button")].find(button => button.textContent === ${JSON.stringify(text)});
    if (!control || control.disabled) return false;
    control.click(); return true;
  })()`);
  expect(clicked).toBe(true);
}
async function draft(): Promise<void> {
  await click("Edit grouping");
  await waitFor(`document.querySelector(${JSON.stringify(editor)}) !== null`, "private editor");
  await browser.evaluate(`document.querySelector(${JSON.stringify(`${editor} input`)}).select()`);
  await browser.typeInto(`${editor} input`, "Private draft");
}
async function values(): Promise<string[]> {
  return browser.evaluate<string[]>(
    `Array.from(document.querySelectorAll(${JSON.stringify(`${editor} input`)}), input => input.value)`,
  );
}
async function commit(revision: number, hosts: readonly unknown[]): Promise<void> {
  await browser.evaluate(`window.hostViewsFixture.commit(${JSON.stringify({ revision, hosts })})`);
  await browser.evaluate("window.hostViewsFixture.advance(50)");
}
async function readCount(count: number): Promise<void> {
  await waitFor(`window.hostViewsFixture.readCount === ${count}`, `grouping read ${count}`);
}

beforeEach(async () => {
  if (!server) throw new Error("Host-view fixture did not start");
  await browser.goto(`http://127.0.0.1:${String(server.port)}/`);
  await waitFor("window.hostViewsFixture?.readCount === 1", "initial grouping read");
  await browser.evaluate("window.hostViewsFixture.answer(0)");
  await waitFor(`document.querySelector(${JSON.stringify(grouping)}) !== null`, "initial grouping");
  await browser.evaluate("window.hostViewsFixture.rememberRail()");
});
afterEach(async () => {
  await browser.evaluate("window.hostViewsFixture?.close()");
  expect(browser.drainMessages().filter((message) => message.level === "error")).toEqual([]);
});
afterAll(async () => {
  await browser.close();
  await server?.stop(true);
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
});

test("an event read failure retries without another event or socket and retains the draft CAS base", async () => {
  await draft();
  const freshHost = { ...initialHost, name: "Fresh host" };
  await commit(2, [freshHost]);
  await readCount(2);
  await browser.evaluate("window.hostViewsFixture.fail(1)");
  await waitFor(
    'document.querySelector("[role=status]") !== null && document.querySelector("[data-testid=host-view-editor]") === null',
    "unavailable grouping with individual enrollments",
  );
  expect(
    await browser.evaluate<boolean>(`document.querySelector(${JSON.stringify(grouping)}) === null`),
  ).toBe(true);
  expect(
    await browser.evaluate<boolean>(
      `document.querySelector(${JSON.stringify('[aria-label="New terminal on Ordinary enrollment"]')}) !== null`,
    ),
  ).toBe(true);
  const activity = await browser.evaluate<unknown>("window.hostViewsFixture.activity()");
  expect(await browser.evaluate<unknown>("window.hostViewsFixture.feed().mode")).toBe("timer");
  await browser.evaluate("window.hostViewsFixture.advance(2000)");
  await readCount(3);
  expect(await browser.evaluate<unknown>("window.hostViewsFixture.activity()")).toEqual(activity);
  expect(
    await browser.evaluate<boolean>(`document.querySelector(${JSON.stringify(grouping)}) === null`),
  ).toBe(true);
  await browser.evaluate("window.hostViewsFixture.answer(2)");
  await waitFor(
    `document.querySelector(${JSON.stringify(grouping)})?.textContent.includes("Fresh host") && document.querySelector(${JSON.stringify(save)})?.disabled === true`,
    "fresh grouping and unre-based draft",
  );
  expect(await values()).toEqual(["Private draft", "Initial account"]);
  expect(await browser.evaluate<boolean>("window.hostViewsFixture.sameRail()")).toBe(true);
  expect(await browser.evaluate<unknown>("window.hostViewsFixture.feed().mode")).toBe("events");
  await browser.evaluate("window.hostViewsFixture.advance(20000)");
  await readCount(3);
  expect(await browser.evaluate<unknown>("window.hostViewsFixture.activity()")).toEqual(activity);
  await click("Reload current grouping");
  expect(await values()).toEqual(["Fresh host", "Initial account"]);
  expect(
    await browser.evaluate<boolean>(`document.querySelector(${JSON.stringify(save)}).disabled`),
  ).toBe(false);
}, 30_000);

test("a delayed successful mutation cannot resurrect a grouping removed by a newer serialized read", async () => {
  await draft();
  await click("Save grouping");
  await waitFor("window.hostViewsFixture.mutationCount === 1", "pending grouping mutation");
  const committed = { ...initialHost, name: "Private draft" };
  await commit(2, [committed]);
  await readCount(2); // Hold the old event read while a later removal earns another read.
  await commit(3, []);
  expect(await browser.evaluate<number>("window.hostViewsFixture.readCount")).toBe(2);
  await browser.evaluate("window.hostViewsFixture.answer(1)");
  await browser.evaluate("window.hostViewsFixture.advance(50)");
  await readCount(3);
  await browser.evaluate("window.hostViewsFixture.answer(2)");
  await waitFor(
    `document.querySelector(${JSON.stringify(grouping)}) === null`,
    "newer removal rendered",
  );
  await browser.evaluate("window.hostViewsFixture.watchRemoval()");
  await browser.evaluate(
    `window.hostViewsFixture.completeMutation(${JSON.stringify({ revision: 2, hosts: [committed] })})`,
  );
  await readCount(4); // Hold post-action refresh so any stale direct publication stays observable.
  await waitFor(
    `document.querySelector(${JSON.stringify(editor)}) === null`,
    "successful editor close",
  );
  expect(
    await browser.evaluate<boolean>(`document.querySelector(${JSON.stringify(grouping)}) === null`),
  ).toBe(true);
  expect(await browser.evaluate<boolean>("window.hostViewsFixture.resurrected")).toBe(false);
  await browser.evaluate("window.hostViewsFixture.answer(3)");
  await browser.evaluate("window.hostViewsFixture.advance(20000)");
  await readCount(4);
  expect(await browser.evaluate<boolean>("window.hostViewsFixture.resurrected")).toBe(false);
  expect(await browser.evaluate<boolean>("window.hostViewsFixture.sameRail()")).toBe(true);
}, 30_000);

test("an unverifiable mutation result leaves the private draft open and reports failure", async () => {
  await draft();
  await click("Save grouping");
  await waitFor("window.hostViewsFixture.mutationCount === 1", "pending grouping mutation");
  await browser.evaluate(
    'window.hostViewsFixture.completeMutation({ revision: 2, hosts: "invalid" })',
  );
  await waitFor('document.querySelector("[role=alert]") !== null', "unverified commit failure");
  expect(await values()).toEqual(["Private draft", "Initial account"]);
  expect(
    await browser.evaluate<boolean>(`document.querySelector(${JSON.stringify(save)}).disabled`),
  ).toBe(false);
  expect(
    await browser.evaluate<boolean>(
      `document.querySelector(${JSON.stringify(grouping)})?.textContent.includes("Initial host")`,
    ),
  ).toBe(true);
}, 30_000);
