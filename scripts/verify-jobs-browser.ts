#!/usr/bin/env bun
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  JobDescriptionSchema,
  JobEventSchema,
  JobRequestSchema,
  JobResultSchema,
  JobStateSchema,
  PublicJobSchema,
  formatManifoldUri,
} from "../packages/protocol/src/index.ts";
import type { SessionClient } from "../packages/sdk/src/index.ts";
import { Browser } from "./cdp.ts";
import { resolveWebDist } from "./gate-dist.ts";
import {
  connect,
  createContainer,
  mintToken,
  ownerAction,
  startServer,
  waitFor,
  type TestAgent,
  type TestServer,
} from "../packages/testkit/src/index.ts";
import {
  provisionRuntime,
  type RuntimeFixture,
} from "../packages/testkit/fixtures/runtime/provision.ts";
import { browserProxy, type BrowserProxy } from "../packages/testkit/fixtures/runtime/proxy.ts";
import {
  PLUGIN,
  OPERATION,
  LOCATION,
  limits,
} from "../packages/testkit/fixtures/runtime/shared.ts";

const HELP = `verify:jobs:browser — actual installed plugin, real Chromium, real Linux jobs.
Run only in a disposable manifold-jobs-* systemd unit with Delegate=cpu memory pids.
Required: MANIFOLD_TEST_UNIT=<unit without .service>, MANIFOLD_TEST_BWRAP=<absolute bubblewrap>,
MANIFOLD_TEST_STATIC_BUSYBOX=<absolute STATIC BusyBox>, writable delegated cgroup v2,
unprivileged user/mount/PID namespaces, bun install, Chromium (MANIFOLD_CHROMIUM override).
Optional MANIFOLD_GATE_DIST reuses an existing web bundle; otherwise the command builds one.
Optional MANIFOLD_RUNTIME_PROOF_DIR retains synthetic screenshots and the final JSON evidence.
The launcher moves only processes in its exact named disposable unit to a supervisor child,
then delegates a private workloads child. Never run in the caller's ordinary cgroup.
Example inside that unit: bun run verify:jobs:browser
Includes native Plugins machine installation, explicit consent, declared-input jobs and screenshots,
then the complete installed-worker job and 1200-frame stream acceptance.
Missing prerequisites or any unexercised core acceptance FAIL with nonzero exit; no skips.
All identities, artifacts, workspace data, agents, browser storage and hub are run-owned.
No production endpoint, external executable download, provider or private transcript is used.`;
if (process.argv.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}

const Job = z.object({
  jobId: z.string(),
  machineId: z.string(),
  operationId: z.string(),
  pluginId: z.string(),
  state: JobStateSchema,
  result: JobResultSchema.nullable(),
});
const View = z.object({
  target: z.string(),
  job: z.string(),
  outcome: z.unknown(),
  actions: z.number(),
  epoch: z.string(),
  seq: z.number(),
  status: z.string(),
  snapshots: z.number(),
  gaps: z.number(),
  resets: z.number(),
  errors: z.number(),
  maxSnapshot: z.number(),
  frames: z.number(),
  firstAt: z.number(),
  lastAt: z.number(),
});
const Describe = z.object({
  connected: z.boolean(),
  installation: z.object({ ready: z.boolean() }).nullable(),
});
async function view(browser: Browser) {
  const value = await browser.evaluate<unknown>(`(() => {
    const node = [...document.querySelectorAll('.mf-vocab-text')].find(el => el.textContent?.startsWith('Runtime proof '));
    return node ? JSON.parse(node.textContent.slice('Runtime proof '.length)) : null;
  })()`);
  return View.parse(value);
}
async function click(browser: Browser, text: string) {
  assert(
    await browser.evaluate<boolean>(`(() => {
    const button = [...document.querySelectorAll('button')].find(el => el.textContent === ${JSON.stringify(text)});
    if (!button || button.disabled) return false; button.click(); return true;
  })()`),
    `fixture button unavailable: ${text}`,
  );
}
async function field(browser: Browser, label: string, value: string) {
  assert(
    await browser.evaluate<boolean>(`(() => {
    const label = [...document.querySelectorAll('.mf-vocab-input__field')].find(el => el.querySelector('span')?.textContent === ${JSON.stringify(label)});
    const input = label?.querySelector('input'); if (!input) return false; input.focus(); input.select(); return true;
  })()`),
    `fixture field unavailable: ${label}`,
  );
  await browser.send("Input.insertText", { text: value });
  await browser.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
  });
  await browser.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
  });
  await waitFor(
    async () => {
      const state = await view(browser);
      return (label === "Target machine" ? state.target : state.job) === value;
    },
    5000,
    20,
  );
}
async function browserJob(browser: Browser, id: string, action = "Run bounded job") {
  await field(browser, "Job identity", id);
  const actions = (await view(browser)).actions;
  await click(browser, action);
  return waitFor(
    async () => {
      const state = await view(browser);
      if (state.actions <= actions) return false;
      const outcome = z
        .object({ ok: z.boolean(), result: z.unknown().optional() })
        .safeParse(state.outcome);
      if (!outcome.success || !outcome.data.ok) return false;
      const job = Job.safeParse(outcome.data.result);
      return job.success && job.data.jobId === id ? job.data : false;
    },
    10_000,
    20,
  );
}

async function installPanel(browser: Browser) {
  assert(
    await browser.evaluate<boolean>(`(async () => {
    const identity = JSON.parse(localStorage.getItem('manifold.identity'));
    const headers = { Authorization: 'Bearer ' + identity.token, 'Content-Type': 'application/json' };
    const { layout } = await (await fetch('/api/layout', { headers })).json();
    layout.root.children.push('runtime-proof'); layout.root.ratios.push(1);
    layout['runtime-proof'] = { id: 'runtime-proof', dir: null, ratios: [], children: [], ref: { kind: 'panel', panelId: '${PLUGIN}.proof' } };
    return (await (await fetch('/api/actions/core.space.setLayout', { method: 'POST', headers, body: JSON.stringify({ layout }) })).json()).ok;
  })()`),
    "fixture panel layout was refused",
  );
}

async function screenshot(browser: Browser, name: string) {
  const directory = process.env.MANIFOLD_RUNTIME_PROOF_DIR;
  const capture = await browser.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const data = z.string().min(1).parse(capture.result?.["data"]);
  if (directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, `${name}.png`), Buffer.from(data, "base64"), { mode: 0o600 });
  }
}

const nativeStarts = ["native-result", "native-cancel"];
const nativeRuntime = '[data-testid="plugin-manager-machine-runtime"]';
async function nativeClick(browser: Browser, selector: string) {
  await waitFor(
    () =>
      browser.evaluate<boolean>(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!(element instanceof HTMLElement) || element.matches(':disabled')) return false;
        element.scrollIntoView({ block: 'center' }); element.click(); return true;
      })()`),
    10_000,
    20,
  );
}
async function nativeSelect(browser: Browser, label: string, value: string) {
  await waitFor(
    () =>
      browser.evaluate<boolean>(`(() => {
        const element = document.querySelector('select[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']');
        if (!(element instanceof HTMLSelectElement) || element.disabled ||
            ![...element.options].some(option => option.value === ${JSON.stringify(value)} && !option.disabled)) return false;
        element.scrollIntoView({ block: 'center' });
        element.value = ${JSON.stringify(value)};
        element.dispatchEvent(new Event('change', { bubbles: true })); return true;
      })()`),
    10_000,
    20,
  );
}
async function nativeScreenshot(browser: Browser, selector: string, name: string) {
  assert(
    await browser.evaluate<boolean>(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) return false;
      element.scrollIntoView({ block: 'center' });
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0;
    })()`),
    `native screenshot surface unavailable: ${selector}`,
  );
  await screenshot(browser, name);
}

async function nativeProof(browser: Browser, hub: TestServer, runtime: RuntimeFixture) {
  const describe = async () =>
    JobDescriptionSchema.parse(
      await ownerAction(hub, "engine.jobs.describe", {
        machineId: runtime.machineId,
        pluginId: PLUGIN,
      }),
    );
  const before = await describe();
  assert(before.connected);
  const target = `linux-${process.arch}`;
  assert(before.platforms.includes(target), "native owner has not proved the declared target");
  await browser.clickTestId("plugin-manager-open");
  await nativeClick(browser, `[data-plugin="${PLUGIN}"] [data-testid="plugin-manager-row-open"]`);
  await nativeSelect(browser, "Machine for plugin operations", runtime.machineId);
  await nativeSelect(browser, "Declared artifact target", target);
  await nativeScreenshot(
    browser,
    `${nativeRuntime} [data-action="engine.jobs.install"]`,
    "native-machine-install",
  );
  await nativeClick(browser, `${nativeRuntime} [data-action="engine.jobs.install"]`);
  const installed = await waitFor(
    async () => {
      const observed = await describe();
      const installation = observed.installation;
      return observed.connected &&
        installation?.ready &&
        installation.enabled &&
        !installation.purgeRequested &&
        installation.revision !== before.installation?.revision
        ? observed
        : false;
    },
    20_000,
    20,
  );
  const installation = installed.installation;
  assert(installation);
  assert.equal(installation.artifactSha256, runtime.artifactSha256);
  const operationNode = formatManifoldUri({
    kind: "operation",
    machineId: runtime.machineId,
    operationId: OPERATION,
  });
  const locationNode = formatManifoldUri({
    kind: "location",
    machineId: runtime.machineId,
    locationId: LOCATION,
  });
  const rights = [
    { node: operationNode, cap: "machines:run" },
    { node: operationNode, cap: "jobs:read" },
    { node: operationNode, cap: "jobs:cancel" },
    { node: locationNode, cap: "locations:write" },
  ] as const;
  assert(!installed.consents.some((row) => row.enabled), "reinstallation inherited stale consent");
  await nativeClick(browser, `${nativeRuntime} [data-action="engine.jobs.describe"]`);
  const run = `${nativeRuntime} button[data-action="engine.jobs.execute"][data-operation="${OPERATION}"]`;
  await waitFor(
    () =>
      browser.evaluate<boolean>(
        `document.querySelector(${JSON.stringify(run)})?.disabled === true`,
      ),
    5000,
    20,
  );
  for (const right of rights) {
    await nativeClick(
      browser,
      `${nativeRuntime} button[aria-label=${JSON.stringify(`Approve ${right.cap} on ${right.node}`)}]`,
    );
    await waitFor(
      async () =>
        (await describe()).consents.some(
          (row) => row.node === right.node && row.cap === right.cap && row.enabled,
        ),
      5000,
      20,
    );
  }
  const approved = await describe();
  const requester = await browser.evaluate<string>(
    "JSON.parse(localStorage.getItem('manifold.identity')).principal.id",
  );
  const jobs: z.infer<typeof PublicJobSchema>[] = [];
  for (const label of nativeStarts) {
    const input = `${nativeRuntime} input[aria-label="${OPERATION} label"]`;
    await waitFor(
      () =>
        browser.evaluate<boolean>(
          `document.querySelector(${JSON.stringify(input)})?.disabled === false`,
        ),
      5000,
      20,
    );
    assert(
      await browser.evaluate<boolean>(`(() => {
      const input = document.querySelector(${JSON.stringify(input)});
      if (!(input instanceof HTMLInputElement)) return false;
      input.focus(); input.select(); return true;
    })()`),
    );
    await browser.send("Input.insertText", { text: label });
    await nativeScreenshot(browser, input, `native-declared-input-${label}`);
    await nativeClick(browser, run);
    const jobId = await waitFor(
      async () => {
        const selected = await browser.evaluate<unknown>(
          "document.querySelector('select[aria-label=\"Requested job\"]')?.value",
        );
        return typeof selected === "string" &&
          selected.length > 0 &&
          !jobs.some((job) => job.jobId === selected)
          ? selected
          : false;
      },
      10_000,
      20,
    );
    const status = async () =>
      PublicJobSchema.parse(
        await ownerAction(hub, "engine.jobs.status", {
          node: { kind: "job", machineId: runtime.machineId, operationId: OPERATION, jobId },
        }),
      );
    await waitFor(() => runtime.starts().includes(label), 20_000, 20);
    if (label === "native-result") runtime.release(label);
    else
      await nativeClick(
        browser,
        '[data-testid="plugin-manager-job-status"] [data-action="engine.jobs.cancel"]',
      );
    const job = await waitFor(
      async () => {
        const observed = await status();
        return observed.state === (label === "native-result" ? "exited" : "cancelled")
          ? observed
          : false;
      },
      20_000,
      20,
    );
    assert.equal(job.machineId, runtime.machineId);
    assert.equal(job.pluginId, PLUGIN);
    assert.equal(job.operationId, OPERATION);
    assert.equal(job.authority.requester, requester);
    assert.equal(job.authority.origin.kind, "action");
    assert.equal(job.authority.executor?.machineId, runtime.machineId);
    const decision = job.authority.decision;
    assert(decision?.allowed, "native request lacks a persisted allowing decision");
    for (const right of [rights[0], rights[3]]) {
      const consent = approved.consents.find(
        (row) => row.node === right.node && row.cap === right.cap && row.enabled,
      );
      assert(consent);
      assert(
        decision.consents.some(
          (row) =>
            row.node === right.node &&
            row.revision === consent.revision &&
            row.artifactSha256 === installation.artifactSha256,
        ),
        "native admission did not use the reviewed consent",
      );
    }
    const db = new Database(join(hub.dataDir, "manifold.db"), { readonly: true });
    try {
      const stored = db
        .query<
          { request: string; result: string | null; state: string; decision_id: string | null },
          [string]
        >("SELECT request,result,state,decision_id FROM machine_jobs WHERE job_id=?")
        .get(jobId);
      assert(stored, "native form did not persist its job");
      const request = JobRequestSchema.parse(JSON.parse(stored.request));
      assert.equal(request.installationRevision, installation.revision);
      assert.equal(request.artifactSha256, installation.artifactSha256);
      assert.deepEqual(request.input, { label });
      assert.equal(request.credential.principalId, requester);
      assert.equal(request.traceId, job.authority.origin.traceId);
      assert.equal(stored.state, job.state);
      assert.equal(stored.decision_id, decision.decisionId);
      assert.deepEqual(stored.result === null ? null : JSON.parse(stored.result), job.result);
      if (label === "native-result") {
        const result = JobResultSchema.parse(job.result);
        assert.equal(result.exitCode, 7);
        assert.equal(result.requestDigest, request.requestDigest);
        assert.equal(result.ownerId, job.authority.executor?.ownerId);
        assert.equal(result.ownerGeneration, job.authority.executor?.ownerGeneration);
        assert.deepEqual(result.outputs.map((output) => output.name).sort(), ["stderr", "stdout"]);
      }
    } finally {
      db.close();
    }
    await nativeClick(
      browser,
      '[data-testid="plugin-manager-job-status"] [data-action="engine.jobs.status"]',
    );
    const statusSelector = '[data-testid="plugin-manager-job-status"]';
    await waitFor(
      () =>
        browser.evaluate<boolean>(
          `document.querySelector(${JSON.stringify(statusSelector)})?.innerText.includes(${JSON.stringify(job.state)}) === true`,
        ),
      5000,
      20,
    );
    await nativeClick(browser, `${statusSelector} details:not([open]) summary`);
    const displayed = await browser.evaluate<string>(
      `document.querySelector(${JSON.stringify(statusSelector)}).innerText`,
    );
    for (const value of [jobId, requester, decision.decisionId, job.authority.origin.traceId])
      assert(displayed.includes(value), `native status omitted persisted identity ${value}`);
    if (job.result)
      for (const value of [
        job.result.ownerId,
        job.result.requestDigest,
        ...job.result.outputs.map((output) => output.sha256),
      ])
        assert(displayed.includes(value), `native status omitted persisted result ${value}`);
    await nativeScreenshot(browser, statusSelector, `native-status-${label}`);
    jobs.push(job);
  }
  assert.deepEqual(runtime.starts(), nativeStarts, "native controls started unexpected executions");
  console.log(
    "PASS native Plugins UI: proved target, exact installation, explicit consent, declared input, persisted result/authority, cancellation",
  );
  return { target, installation, jobs };
}

function delegatedRoot(): string {
  const unit = process.env.MANIFOLD_TEST_UNIT;
  if (
    process.platform !== "linux" ||
    !unit ||
    !/^manifold-jobs-[A-Za-z0-9_.-]+$/.test(unit) ||
    !process.env.MANIFOLD_TEST_BWRAP ||
    !process.env.MANIFOLD_TEST_STATIC_BUSYBOX
  ) {
    throw new Error(`UNVERIFIED: Linux backend prerequisites missing.\n${HELP}`);
  }
  Browser.detect();
  for (const name of ["MANIFOLD_TEST_BWRAP", "MANIFOLD_TEST_STATIC_BUSYBOX"] as const) {
    assert(existsSync(process.env[name]!), `UNVERIFIED: ${name} does not exist`);
  }
  const membership = readFileSync("/proc/self/cgroup", "utf8")
    .split("\n")
    .find((line) => line.startsWith("0::"))
    ?.slice(3);
  assert(
    membership?.endsWith(`/${unit}.service`),
    "UNVERIFIED: refusing a cgroup outside the exact disposable unit",
  );
  const root = `/sys/fs/cgroup${membership}`;
  const controllers = readFileSync(`${root}/cgroup.controllers`, "utf8").trim().split(/\s+/);
  assert(
    ["cpu", "memory", "pids"].every((name) => controllers.includes(name)),
    "UNVERIFIED: cpu/memory/pids not delegated",
  );
  mkdirSync(`${root}/supervisor`);
  for (const pid of readFileSync(`${root}/cgroup.procs`, "utf8").trim().split(/\s+/))
    if (pid) writeFileSync(`${root}/supervisor/cgroup.procs`, pid);
  writeFileSync(`${root}/cgroup.subtree_control`, "+cpu +memory +pids");
  mkdirSync(`${root}/workloads`);
  writeFileSync(`${root}/workloads/cgroup.subtree_control`, "+cpu +memory +pids");
  return `${root}/workloads`;
}

async function main() {
  const cgroup = delegatedRoot();
  const root = mkdtempSync(join(tmpdir(), "manifold-jobs-browser-"));
  const browsers: Browser[] = [];
  const clients: SessionClient[] = [];
  const grants: string[] = [];
  let server: TestServer | undefined;
  let agent: TestAgent | undefined;
  let owner: Bun.Subprocess<"ignore", "ignore", "ignore"> | undefined;
  let proxy: BrowserProxy | undefined;
  let dist: { readonly distDir: string; cleanup(): void } | undefined;
  let failure: { error: unknown } | undefined;
  const cleanupErrors: unknown[] = [];
  const cleanup = async (action: () => unknown) => {
    try {
      await action();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  try {
    dist = resolveWebDist("manifold-jobs-browser-web-");
    server = await startServer({
      dataDir: join(root, "hub"),
      spawnAgent: false,
      env: { MANIFOLD_PLUGIN_DEV_PATHS: "1", MANIFOLD_WEB_DIST: dist.distDir },
    });
    const hub = server;
    const runtime = await provisionRuntime(hub, root, cgroup);
    const container = await createContainer(hub, "Governed runtime browser acceptance");
    proxy = await browserProxy(hub.port);
    const origin = proxy.url;
    const browser = new Browser();
    browsers.push(browser);
    await browser.launch();
    await browser.goto(`${origin}/#key=${hub.ownerKey}`);
    await browser.typeInto("#identity-name", "runtime-proof-owner");
    await browser.clickTestId("identity-enter");
    await waitFor(
      () => browser.evaluate<boolean>("document.querySelector('#identity-name') === null"),
      10_000,
      50,
    );
    grants.push(
      await browser.evaluate<string>(
        "JSON.parse(localStorage.getItem('manifold.identity')).principal.id",
      ),
    );
    await installPanel(browser);
    await browser.goto(`${origin}/p/${container.id}`);
    await waitFor(
      () =>
        browser.evaluate<boolean>(
          "document.body.innerText.includes('Governed runtime acceptance')",
        ),
      15_000,
      50,
    );
    await field(browser, "Target machine", runtime.machineId);
    const describe = async () =>
      Describe.parse(
        await ownerAction(hub, "engine.jobs.describe", {
          machineId: runtime.machineId,
          pluginId: PLUGIN,
        }),
      );
    const node = (jobId: string) => ({
      kind: "job" as const,
      machineId: runtime.machineId,
      operationId: OPERATION,
      jobId,
    });
    const status = async (jobId: string) =>
      Job.parse(await ownerAction(hub, "engine.jobs.status", { node: node(jobId) }));
    await runtime.consent("machines:run", true);
    await runtime.consent("jobs:read", true);
    await runtime.consent("jobs:cancel", true);
    await runtime.consent("locations:write", true, true);

    assert.equal((await describe()).connected, false);
    assert.equal((await browserJob(browser, "offline")).state, "queued");
    await click(browser, "Cancel job");
    await waitFor(async () => (await status("offline")).state === "cancelled", 5000, 20);
    assert.deepEqual(runtime.starts(), []);
    // An online machine transport without a job owner is explicitly NOT a supported backend.
    agent = await runtime.startAgent();
    assert.equal((await describe()).connected, false);
    assert.equal((await browserJob(browser, "unsupported")).state, "queued");
    await click(browser, "Cancel job");
    await waitFor(async () => (await status("unsupported")).state === "cancelled", 5000, 20);
    assert.deepEqual(runtime.starts(), []);
    await agent.stop();
    agent = undefined;
    owner = await runtime.startOwner();
    agent = await runtime.startAgent();
    assert.equal(agent.machineId, runtime.machineId);
    await waitFor(
      async () => {
        const state = await describe();
        return state.connected && state.installation?.ready;
      },
      20_000,
      20,
    );
    const native = await nativeProof(browser, hub, runtime);
    await browser.goto(`${origin}/p/${container.id}`);
    await waitFor(
      () => browser.evaluate<boolean>("document.body.innerText.includes('Runtime proof ')"),
      15_000,
      20,
    );
    await field(browser, "Target machine", runtime.machineId);
    await runtime.consent("locations:write", false, true);
    assert.equal((await browserJob(browser, "denied-resource")).state, "refused");
    assert.deepEqual(runtime.starts(), nativeStarts);
    await runtime.consent("locations:write", true, true);

    const viewer = await mintToken(hub, {
      principal: { kind: "human", name: "runtime-denied-actor", color: "#336699" },
      caps: ["containers:read", "containers:write"],
    });
    grants.push(viewer.principal.id);
    const other = new Browser();
    browsers.push(other);
    await other.launch();
    await other.goto(hub.httpUrl);
    // A real attenuated grant, minted at the public owner door, uses the normal persisted identity shape.
    await other.evaluate(
      `localStorage.setItem('manifold.identity', ${JSON.stringify(JSON.stringify({ token: viewer.token, principal: viewer.principal }))})`,
    );
    await installPanel(other);
    await other.goto(`${hub.httpUrl}/p/${container.id}`);
    await waitFor(
      () =>
        other.evaluate<boolean>("document.body.innerText.includes('Governed runtime acceptance')"),
      15_000,
      50,
    );
    await field(other, "Target machine", runtime.machineId);
    await field(other, "Job identity", "denied-actor");
    await click(other, "Run bounded job");
    await waitFor(
      async () => {
        const outcome = z
          .object({ ok: z.boolean(), result: z.unknown().optional() })
          .safeParse((await view(other)).outcome);
        if (!outcome.success) return false;
        if (!outcome.data.ok) return true;
        const job = Job.safeParse(outcome.data.result);
        return job.success && job.data.state === "refused";
      },
      5000,
      20,
    );
    assert.deepEqual(
      runtime.starts(),
      nativeStarts,
      "denied browser actor/resource started an executable",
    );

    await browserJob(browser, "once");
    await waitFor(() => runtime.starts().includes("once"), 20_000, 20);
    assert.equal((await view(browser)).target, runtime.machineId);
    await browserJob(browser, "once");
    await agent.restartTransport("SIGKILL");
    await waitFor(async () => (await describe()).connected, 15_000, 20);
    await browserJob(browser, "once");
    assert.deepEqual(
      runtime.starts(),
      [...nativeStarts, "once"],
      "duplicate/reconnect restarted the executable",
    );
    runtime.release("once");
    const completed = await waitFor(
      async () => {
        const job = await status("once");
        if (job.state === "exited") return job;
        assert(
          !["refused", "cancelled", "interrupted"].includes(job.state),
          `real job failed: ${job.state}`,
        );
        return false;
      },
      20_000,
      20,
    );
    const result = JobResultSchema.parse(completed.result);
    assert.equal(result.exitCode, 7);
    assert(result.usage && result.usage.outputBytes <= limits.outputBytes);
    for (const name of ["stdout", "stderr"] as const) {
      const output = result.outputs.find((value) => value.name === name);
      assert(output, `missing sealed ${name}`);
      const chunks: Buffer[] = [];
      let offset = 0;
      for (let count = 0; count < 128; count++) {
        const event = JobEventSchema.parse(
          await ownerAction(hub, "engine.jobs.output", {
            node: { ...node("once"), kind: "output", outputId: output.outputId },
            offset,
            maxBytes: 8,
          }),
        );
        assert.equal(event.type, "output");
        if (event.type !== "output") throw new Error("output response required");
        assert.equal(event.jobId, "once");
        assert.equal(event.outputId, output.outputId);
        const bytes = Buffer.from(event.data, "base64");
        assert(bytes.length <= 8);
        offset += bytes.length;
        chunks.push(bytes);
        assert(offset <= limits.outputBytes);
        if (event.eof) break;
        assert(bytes.length > 0, "output made no progress");
        assert(count < 127, "output never reached EOF");
      }
      const bytes = Buffer.concat(chunks);
      assert.equal(bytes.length, output.bytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), output.sha256);
      if (name === "stdout")
        assert.deepEqual(JSON.parse(bytes.toString()), {
          kind: "runtime.result/1",
          value: 42,
          pty: false,
        });
      else assert.equal(bytes.toString(), "diagnostic");
    }
    await click(browser, "Refresh job");
    await waitFor(
      async () => {
        const outcome = z.object({ result: Job }).safeParse((await view(browser)).outcome);
        return outcome.success && outcome.data.result.state === "exited";
      },
      5000,
      20,
    );
    assert.deepEqual((await browserJob(browser, "once")).result, result);
    await screenshot(browser, "runtime-job-result");
    await browserJob(browser, "cancel");
    await waitFor(() => runtime.starts().includes("cancel"), 20_000, 20);
    await click(browser, "Cancel job");
    await waitFor(async () => (await status("cancel")).state === "cancelled", 10_000, 20);
    await agent.restartTransport("SIGKILL");
    assert.equal((await status("cancel")).state, "cancelled");
    assert.deepEqual(runtime.starts(), [...nativeStarts, "once", "cancel"]);
    console.log(
      "PASS browser jobs: target, non-PTY result, denied actor/resource, cancel, offline/unsupported, duplicate/reconnect",
    );

    // Establish a precise journal interval before any stream starts. Read-only SQL is a
    // completeness check, not a fixture seed; an API page limit cannot hide older frame rows.
    const db = new Database(join(hub.dataDir, "manifold.db"), { readonly: true });
    let journalStart: number;
    try {
      journalStart = db
        .query<{ id: number }, []>("SELECT coalesce(max(id),0) AS id FROM events")
        .get()!.id;
    } finally {
      db.close();
    }
    await click(browser, "Start sixty seconds");
    await waitFor(
      async () =>
        z
          .object({ ok: z.literal(true), result: z.object({ epoch: z.string() }) })
          .safeParse((await view(browser)).outcome).success,
      5000,
      20,
    );
    const startedAt = Date.now();
    await click(browser, "Open stream");
    await click(other, "Open stream");
    await waitFor(
      async () => (await view(browser)).seq >= 60 && (await view(other)).seq >= 60,
      10_000,
      20,
    );
    const before = await view(browser);
    await click(browser, "Reconnect stream");
    await waitFor(async () => (await view(browser)).snapshots > before.snapshots, 5000, 20);
    assert.equal((await view(browser)).epoch, before.epoch);
    assert((await view(browser)).seq >= before.seq);
    assert.equal((await view(browser)).gaps, 0);
    const reader = await mintToken(hub, {
      principal: { kind: "human", name: "runtime-stream-denied", color: "#993366" },
      caps: ["containers:read"],
    });
    grants.push(reader.principal.id);
    const deniedClient = await connect(hub, { containerId: container.id, token: reader.token });
    clients.push(deniedClient);
    const denied = deniedClient.openStream({
      kind: `${PLUGIN}.frames`,
      node: { kind: "plugin", pluginId: PLUGIN },
    });
    await waitFor(() => denied.status === "refused", 5000, 20);
    assert.equal(denied.snapshot, null);
    assert.equal(denied.cursor, undefined);
    denied.close();
    const revokedAt = (await view(other)).seq;
    // HTTP revocation can finish before already-sent socket frames arrive. Wait for the
    // exact stream-bearing socket to close, then reject traffic from any reconnect too.
    let revokedFrames = 0;
    let streamSocketId: string | undefined;
    let streamSocketClosed = false;
    await other.send("Network.enable", {});
    other.on("Network.webSocketFrameReceived", (params) => {
      const response = params.response as { payloadData?: string } | undefined;
      if (
        !response?.payloadData?.includes('"type":"stream_frame"') ||
        typeof params.requestId !== "string"
      )
        return;
      if (streamSocketClosed) revokedFrames++;
      else streamSocketId = params.requestId;
    });
    other.on("Network.webSocketClosed", (params) => {
      if (streamSocketId !== undefined && params.requestId === streamSocketId)
        streamSocketClosed = true;
    });
    await waitFor(() => streamSocketId !== undefined, 5000, 20);
    await ownerAction(hub, "core.access.revoke", { principalId: viewer.principal.id });
    await waitFor(() => streamSocketClosed, 5000, 20);
    await waitFor(async () => (await view(browser)).seq >= revokedAt + 40, 5000, 20);
    assert.equal(revokedFrames, 0, "revoked browser still receives stream frames");
    await waitFor(async () => (await view(browser)).status === "closed", 75_000, 20);
    const continuous = await view(browser);
    assert.equal(continuous.seq, 1200);
    assert.equal(continuous.epoch, before.epoch);
    assert.equal(continuous.errors, 0);
    assert.equal(continuous.gaps, 0);
    assert(continuous.maxSnapshot <= 20);
    assert(
      Date.now() - startedAt >= 59_000 && continuous.lastAt - continuous.firstAt >= 59_000,
      "producer did not run at real 20fps for sixty seconds",
    );
    await screenshot(browser, "runtime-contiguous-stream");
    const evidenceDirectory = process.env.MANIFOLD_RUNTIME_PROOF_DIR;
    if (evidenceDirectory)
      writeFileSync(
        join(evidenceDirectory, "continuous.json"),
        JSON.stringify(continuous, null, 2),
        { mode: 0o600 },
      );

    // A second real epoch exercises retention, transport backpressure, and disable/re-enable.
    await click(browser, "Start sixty seconds");
    await waitFor(
      async () => {
        const outcome = z
          .object({ ok: z.literal(true), result: z.object({ epoch: z.string() }) })
          .safeParse((await view(browser)).outcome);
        return outcome.success && outcome.data.result.epoch !== continuous.epoch;
      },
      5000,
      20,
    );
    await click(browser, "Reconnect stream");
    await waitFor(async () => (await view(browser)).resets > continuous.resets, 5000, 20);
    await waitFor(async () => (await view(browser)).seq > 40, 5000, 20);
    const retained = await view(browser);
    await click(browser, "Retained window");
    await waitFor(
      async () =>
        (await view(browser)).gaps > retained.gaps &&
        (await view(browser)).snapshots > retained.snapshots,
      5000,
      20,
    );
    assert((await view(browser)).maxSnapshot <= 20);
    const upgrades = proxy.upgrades;
    const snapshots = (await view(browser)).snapshots;
    const prePressureGaps = (await view(browser)).gaps;
    proxy.stall();
    const pressured = z
      .object({ lastSeq: z.number() })
      .parse(await ownerAction(hub, `${PLUGIN}.pressure`, {}));
    assert(pressured.lastSeq >= 4096);
    assert(proxy.bufferedBytes <= 1024 * 1024, "fault proxy itself accumulated an unbounded queue");
    proxy.resume();
    await waitFor(() => proxy!.upgrades > upgrades, 15_000, 20);
    await waitFor(
      async () => {
        const state = await view(browser);
        return state.snapshots > snapshots && state.seq >= pressured.lastSeq;
      },
      15_000,
      20,
    );
    const recovered = await view(browser);
    assert(recovered.maxSnapshot <= 20);
    assert(
      recovered.gaps > prePressureGaps,
      "slow consumer recovered without a new explicit retained-window gap",
    );
    assert.equal(recovered.errors, 0, "slow consumer silently lost sequence continuity");
    await ownerAction(hub, "engine.plugins.setEnabled", { id: PLUGIN, enabled: false });
    await waitFor(
      () => browser.evaluate<boolean>("!document.body.innerText.includes('Runtime proof ')"),
      10_000,
      20,
    );
    await ownerAction(hub, "engine.plugins.setEnabled", { id: PLUGIN, enabled: true });
    await waitFor(
      () => browser.evaluate<boolean>("document.body.innerText.includes('Runtime proof ')"),
      15_000,
      20,
    );
    await click(browser, "Start sixty seconds");
    await waitFor(
      async () =>
        z
          .object({ ok: z.literal(true), result: z.object({ epoch: z.string() }) })
          .safeParse((await view(browser)).outcome).success,
      5000,
      20,
    );
    await click(browser, "Open stream");
    await waitFor(async () => (await view(browser)).seq > 0, 5000, 20);
    assert.notEqual(
      (await view(browser)).epoch,
      recovered.epoch,
      "disable/re-enable reused the producer epoch",
    );
    await screenshot(browser, "runtime-reenabled-stream");
    await ownerAction(hub, "engine.plugins.setEnabled", { id: PLUGIN, enabled: false });
    const journal = new Database(join(hub.dataDir, "manifold.db"), { readonly: true });
    try {
      const rows = journal
        .query<{ type: string; payload: string }, [number]>(
          "SELECT type,payload FROM events WHERE id > ?",
        )
        .all(journalStart);
      assert(
        !rows.some(
          (row) =>
            row.type.startsWith("stream_") ||
            row.type === `${PLUGIN}.frames` ||
            row.payload.includes("runtime-frame-not-for-event-journal"),
        ),
        "per-frame event-journal rows persisted",
      );
      assert(rows.length < 100, "stream delivery generated per-frame journal traffic");
    } finally {
      journal.close();
    }
    if (evidenceDirectory)
      writeFileSync(
        join(evidenceDirectory, "result.json"),
        JSON.stringify(
          {
            jobs: {
              machineId: runtime.machineId,
              starts: runtime.starts(),
              exitCode: result.exitCode,
              pty: false,
            },
            native,
            continuous,
            recovery: recovered,
            frameJournalRows: 0,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    console.log(
      "PASS browser streams: 1200 contiguous frames/60s, watermark reconnect, retention gap/reset, revoked delivery, bounded slow consumer, disable epoch, zero frame journal rows",
    );
  } catch (error) {
    failure = { error };
  } finally {
    for (const client of clients) await cleanup(() => client.close());
    for (const browser of browsers) {
      await cleanup(() => browser.evaluate("localStorage.clear(); sessionStorage.clear()"));
      await cleanup(() => browser.close());
    }
    const hub = server;
    if (hub)
      for (const principalId of grants)
        await cleanup(() => ownerAction(hub, "core.access.revoke", { principalId }));
    await cleanup(() => proxy?.close());
    await cleanup(() => agent?.stop());
    await cleanup(async () => {
      if (owner && owner.exitCode === null) {
        owner.kill("SIGTERM");
        if (
          !(await Promise.race([owner.exited.then(() => true), Bun.sleep(5000).then(() => false)]))
        ) {
          owner.kill("SIGKILL");
          await owner.exited;
        }
      }
    });
    await cleanup(() => server?.stop());
    await cleanup(() => rmSync(root, { recursive: true, force: true }));
    await cleanup(() => dist?.cleanup());
  }
  if (failure) {
    if (cleanupErrors.length)
      throw new AggregateError(
        [failure.error, ...cleanupErrors],
        "runtime browser proof failed; run-owned cleanup also failed",
        { cause: failure.error },
      );
    throw failure.error;
  }
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, "run-owned runtime cleanup failed");
}
await main();
