#!/usr/bin/env bun
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  JobDeploymentApplyArgsSchema,
  JobDeploymentDescriptionSchema,
  JobDeploymentListResultSchema,
  JobDeploymentRequestSchema,
  JobDeploymentSchema,
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
Includes native Plugins install-only and exact-operation deployment review/apply, stale evidence,
offline pending and refused evidence, saved progress, declared-input jobs and 1200 frames.
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
  await nativeSelectControl(browser, `select[aria-label=${JSON.stringify(label)}]`, value);
}
async function nativeSelectControl(browser: Browser, selector: string, value: string) {
  await waitFor(
    () =>
      browser.evaluate<boolean>(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!(element instanceof HTMLSelectElement) || element.matches(':disabled') ||
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

async function openNativeHistory(browser: Browser, machineId: string) {
  await nativeClick(browser, '[data-testid="plugin-manager-open"]');
  await nativeClick(browser, `[data-plugin="${PLUGIN}"] [data-testid="plugin-manager-row-open"]`);
  await nativeSelect(browser, "Machine for plugin operations", machineId);
}

async function historyContains(
  browser: Browser,
  jobs: readonly z.infer<typeof PublicJobSchema>[],
  present = true,
) {
  return browser.evaluate<boolean>(`(() => {
    const options = [...(document.querySelector('select[aria-label="Operation run"]')?.options ?? [])];
    return ${JSON.stringify(jobs.map((job) => job.jobId))}.every(id => options.some(option => option.value === id) === ${present});
  })()`);
}

async function nativeDeploymentReady(browser: Browser, deploymentId: string, machineId: string) {
  const saved = `${nativeRuntime} [data-deployment=${JSON.stringify(deploymentId)}]`;
  const destination = `${saved} [aria-label="Current destination progress"] [data-machine=${JSON.stringify(machineId)}]`;
  return browser.evaluate<boolean>(`(() => {
    const row = document.querySelector(${JSON.stringify(destination)});
    const progress = row?.querySelector('[role="status"]');
    return row?.getAttribute('data-state') === 'ready' && !!progress?.textContent?.trim();
  })()`);
}

async function nativeDeploymentState(
  browser: Browser,
  deploymentId: string,
  machineId: string,
  state: z.infer<typeof JobDeploymentSchema>["targets"][number]["state"],
  reason: string,
) {
  const row = `${nativeRuntime} [data-deployment=${JSON.stringify(deploymentId)}] [aria-label="Current destination progress"] [data-machine=${JSON.stringify(machineId)}]`;
  await waitFor(
    () =>
      browser.evaluate<boolean>(`(() => {
      const row = document.querySelector(${JSON.stringify(row)});
      return row?.getAttribute('data-state') === ${JSON.stringify(state)} &&
        row?.getAttribute('data-reason') === ${JSON.stringify(reason)} &&
        !!row.querySelector('[role="status"]')?.textContent?.trim();
    })()`),
    10_000,
    20,
  );
  return row;
}

async function nativePreparationHierarchy(
  browser: Browser,
  name: string,
  panel = `${nativeRuntime} [aria-label="Server-reviewed preparation"]`,
  evidenceSelector: string | null = null,
) {
  assert(
    await browser.evaluate<boolean>(`(() => {
    const panel = document.querySelector(${JSON.stringify(panel)});
    const body = panel?.querySelector('.plugin-manager-runtime-review-body, .plugin-manager-runtime-saved-body');
    if (!(panel instanceof HTMLElement) || !(body instanceof HTMLElement)) return false;
    panel.scrollIntoView({ block: 'nearest' });
    const controls = [
      panel.querySelector('.plugin-manager-runtime-review-heading h5'),
      panel.querySelector('.plugin-manager-runtime-review-heading [role="status"]'),
      panel.querySelector('.plugin-manager-runtime-review-heading [data-action]'),
    ];
    const visible = element => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.top < 0 || rect.bottom > innerHeight ||
          rect.left < 0 || rect.right > innerWidth || element.scrollWidth > element.clientWidth + 1) return false;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), clip = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY) &&
            (rect.top < clip.top - 1 || rect.bottom > clip.bottom + 1)) return false;
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX) &&
            (rect.left < clip.left - 1 || rect.right > clip.right + 1)) return false;
      }
      return true;
    };
    const top = controls.map(element => element?.getBoundingClientRect().top);
    body.scrollTop = body.scrollHeight;
    const stable = controls.every((element, index) => visible(element) &&
      element.getBoundingClientRect().top === top[index]);
    body.scrollTop = 0;
    const evidence = ${JSON.stringify(evidenceSelector)} === null ? null : body.querySelector(${JSON.stringify(evidenceSelector)});
    if (${JSON.stringify(evidenceSelector)} !== null && !(evidence instanceof HTMLElement)) return false;
    if (evidence) body.scrollTop = evidence.getBoundingClientRect().top - body.getBoundingClientRect().top;
    return stable && panel.scrollWidth <= panel.clientWidth + 1;
  })()`),
    "preparation heading, status or primary action clipped or moved while evidence scrolled",
  );
  await screenshot(browser, name);
}

async function nativeUnprovedDeployment(browser: Browser, hub: TestServer, machineId: string) {
  const before = JobDeploymentListResultSchema.parse(
    await ownerAction(hub, "engine.jobs.listDeployments", { pluginId: PLUGIN, limit: 100 }),
  );
  const url = await browser.evaluate<string>("location.href");
  await openNativeHistory(browser, machineId);
  await nativeClick(browser, `${nativeRuntime} input[data-machine=${JSON.stringify(machineId)}]`);
  await nativeSelectControl(
    browser,
    `${nativeRuntime} select[data-machine=${JSON.stringify(machineId)}]`,
    `linux-${process.arch}`,
  );
  await nativeClick(browser, `${nativeRuntime} [data-action="engine.jobs.reviewDeployment"]`);
  const refused = `${nativeRuntime} [aria-label="Server-reviewed preparation"] [data-machine=${JSON.stringify(machineId)}][data-approvable="false"]`;
  await waitFor(
    () =>
      browser.evaluate<boolean>(`document.querySelector(${JSON.stringify(refused)})?.querySelector('[data-reason="owner_identity_unproved"]') != null &&
      document.querySelector(${JSON.stringify(`${nativeRuntime} [data-action="engine.jobs.applyDeployment"]`)})?.disabled === true`),
    10_000,
    20,
  );
  await nativePreparationHierarchy(browser, "native-unsupported-deployment-review");
  assert.deepEqual(
    JobDeploymentListResultSchema.parse(
      await ownerAction(hub, "engine.jobs.listDeployments", { pluginId: PLUGIN, limit: 100 }),
    ),
    before,
    "unproved transport review saved a deployment",
  );
  await browser.goto(url);
  await field(browser, "Target machine", machineId);
  return { machineId, approvable: false, reason: "owner_identity_unproved" };
}

async function nativeProof(
  browser: Browser,
  observer: Browser,
  hub: TestServer,
  runtime: RuntimeFixture,
  setConnected: (connected: boolean) => Promise<void>,
) {
  const initialJournal = new Database(join(hub.dataDir, "manifold.db"), { readonly: true });
  let initialJobs: { job_id: string }[];
  try {
    initialJobs = initialJournal
      .query<{ job_id: string }, []>("SELECT job_id FROM machine_jobs ORDER BY job_id")
      .all();
  } finally {
    initialJournal.close();
  }
  // Observe real public requests without replacing the browser's transport or responses.
  const deploymentCalls: { action: string; body: string | undefined }[] = [];
  const executionCalls: string[] = [];
  browser.on("Network.requestWillBeSent", (params) => {
    const request = params["request"] as { url: string; method: string; postData?: string };
    const action = new URL(request.url).pathname;
    if (request.method === "POST" && action === "/api/actions/engine.jobs.execute")
      executionCalls.push(action);
    if (
      request.method === "POST" &&
      (action === "/api/actions/engine.jobs.reviewDeployment" ||
        action === "/api/actions/engine.jobs.applyDeployment")
    )
      deploymentCalls.push({ action, body: request.postData });
  });
  await browser.send("Network.enable", {});
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
  const destination = `${nativeRuntime} input[type="checkbox"][data-machine=${JSON.stringify(runtime.machineId)}]`;
  const operationChoices = `${nativeRuntime} input[type="checkbox"][data-operation]`;
  await waitFor(
    () =>
      browser.evaluate<boolean>(`document.querySelector(${JSON.stringify(destination)}) !== null`),
    10_000,
    20,
  );
  assert.deepEqual(
    await browser.evaluate<string[]>(
      `[...document.querySelectorAll(${JSON.stringify(`${nativeRuntime} input[type="checkbox"][data-machine]:checked`)})].map(input => input.dataset.machine)`,
    ),
    [],
    "opening machine inspection selected a deployment destination",
  );
  assert.deepEqual(
    await browser.evaluate<string[]>(
      `[...document.querySelectorAll(${JSON.stringify(operationChoices)})].filter(input => input.checked).map(input => input.dataset.operation)`,
    ),
    [],
    "opening preparation implicitly selected operation consent",
  );
  assert(
    await browser.evaluate<boolean>(
      `[...document.querySelectorAll(${JSON.stringify(operationChoices)})].some(input => input.dataset.operation === ${JSON.stringify(OPERATION)} && !input.matches(':disabled'))`,
    ),
    "declared operation is not independently selectable for consent",
  );
  await nativeClick(browser, destination);
  await nativeSelectControl(
    browser,
    `${nativeRuntime} select[data-machine=${JSON.stringify(runtime.machineId)}]`,
    target,
  );
  const reviewButton = `${nativeRuntime} [data-action="engine.jobs.reviewDeployment"]`;
  const applyButton = `${nativeRuntime} [data-action="engine.jobs.applyDeployment"]`;
  const reviewedRenderer = `${nativeRuntime} [aria-label="Server-reviewed preparation"]`;
  const reviewDraft = async (approvable = true) => {
    const index = deploymentCalls.length;
    const previousDigest = await browser.evaluate<string | null>(
      `document.querySelector(${JSON.stringify(reviewedRenderer)})?.dataset.reviewDigest ?? null`,
    );
    await nativeClick(browser, reviewButton);
    await waitFor(
      () =>
        browser.evaluate<boolean>(`document.querySelector(${JSON.stringify(reviewedRenderer)}) != null &&
        document.querySelector(${JSON.stringify(reviewedRenderer)}).dataset.reviewDigest !== ${JSON.stringify(previousDigest)} &&
        document.querySelector(${JSON.stringify(applyButton)})?.disabled === ${!approvable}`),
      10_000,
      20,
    );
    await waitFor(
      () =>
        browser.evaluate<boolean>(
          `document.activeElement === document.querySelector(${JSON.stringify(reviewedRenderer)})`,
        ),
      5000,
      20,
    );
    assert.equal(
      deploymentCalls.length,
      index + 1,
      "review implicitly applied or retried preparation",
    );
    assert.equal(deploymentCalls[index]!.action, "/api/actions/engine.jobs.reviewDeployment");
    return JobDeploymentRequestSchema.parse(JSON.parse(deploymentCalls[index]!.body!));
  };
  const readDeployment = async (deploymentId: string) =>
    JobDeploymentSchema.parse(
      await ownerAction(hub, "engine.jobs.readDeployment", { deploymentId }),
    );
  const listDeployments = async () =>
    JobDeploymentListResultSchema.parse(
      await ownerAction(hub, "engine.jobs.listDeployments", { pluginId: PLUGIN, limit: 100 }),
    );
  const displayedDigest = async () => {
    const digest = await browser.evaluate<string>(
      `document.querySelector(${JSON.stringify(reviewedRenderer)}).dataset.reviewDigest`,
    );
    assert.match(digest, /^[a-f0-9]{64}$/);
    return digest;
  };
  const displayedRights = () =>
    browser.evaluate<{ node: string; cap: string; approved: boolean; revision: string | null }[]>(
      `[...document.querySelectorAll(${JSON.stringify(`${reviewedRenderer} [data-cap][data-node]`)})].map(row => ({
      node: row.dataset.node, cap: row.dataset.cap, approved: row.dataset.approved === 'true', revision: row.dataset.revision || null
    }))`,
    );
  const applyReview = async (request: z.infer<typeof JobDeploymentRequestSchema>) => {
    const index = deploymentCalls.length;
    const digest = await displayedDigest();
    await nativeClick(browser, applyButton);
    await waitFor(() => deploymentCalls.length === index + 1, 10_000, 20);
    assert.equal(deploymentCalls[index]!.action, "/api/actions/engine.jobs.applyDeployment");
    const approval = JobDeploymentApplyArgsSchema.parse(JSON.parse(deploymentCalls[index]!.body!));
    assert.deepEqual(
      approval,
      { request, reviewDigest: digest },
      "apply widened the reviewed scope or changed its digest",
    );
    return approval;
  };
  // Bootstrap installation has no promoted resource bindings. Offline transport cannot
  // turn that absence into approval of future native resources.
  await setConnected(false);
  const missingRequest = await reviewDraft(false);
  const refusedTarget = `${reviewedRenderer} [data-machine=${JSON.stringify(runtime.machineId)}][data-approvable="false"]`;
  assert(
    await browser.evaluate<boolean>(
      `document.querySelector(${JSON.stringify(refusedTarget)})?.querySelector('[data-reason="resource_evidence_unknown"]') != null`,
    ),
    "missing native resource evidence did not refuse the actual reviewed destination",
  );
  assert(
    !(await listDeployments()).deployments.some(
      (row) => row.deploymentId === missingRequest.deploymentId,
    ),
  );
  assert.deepEqual((await describe()).consents, before.consents);
  await nativePreparationHierarchy(browser, "native-missing-resource-review");
  await setConnected(true);
  const reviewRequest = await reviewDraft();
  assert.equal(reviewRequest.pluginId, PLUGIN);
  assert.deepEqual(reviewRequest.targets, [{ machineId: runtime.machineId, platform: target }]);
  assert.deepEqual(
    reviewRequest.operationIds,
    [],
    "install-only review requested execution consent",
  );
  const reviewedText = await browser.evaluate<string>(
    `document.querySelector(${JSON.stringify(reviewedRenderer)}).textContent`,
  );
  for (const value of [
    reviewRequest.deploymentId,
    runtime.machineId,
    target,
    runtime.artifactSha256,
  ])
    assert(
      reviewedText.includes(value),
      `native review omitted exact destination evidence ${value}`,
    );
  const afterReview = await describe();
  assert.deepEqual(
    afterReview.installation,
    before.installation,
    "review changed the installation",
  );
  assert.deepEqual(afterReview.consents, before.consents, "review changed consent");
  const reviewedDeployments = JobDeploymentListResultSchema.parse(
    await ownerAction(hub, "engine.jobs.listDeployments", { pluginId: PLUGIN, limit: 100 }),
  );
  assert(
    !reviewedDeployments.deployments.some((row) => row.deploymentId === reviewRequest.deploymentId),
    "review saved approval without the separate apply gesture",
  );
  assert.deepEqual(runtime.starts(), [], "review started an operation");
  await nativePreparationHierarchy(browser, "native-machine-review");
  await nativeScreenshot(
    browser,
    `${reviewedRenderer} .plugin-manager-runtime-review-heading`,
    "native-machine-install",
  );
  const approval = await applyReview(reviewRequest);
  assert(
    reviewedText.includes(approval.reviewDigest),
    "apply used a digest not inspectable in review",
  );
  const saved = await waitFor(
    async () => {
      const result = JobDeploymentListResultSchema.parse(
        await ownerAction(hub, "engine.jobs.listDeployments", { pluginId: PLUGIN, limit: 100 }),
      );
      return (
        result.deployments.find((row) => row.deploymentId === reviewRequest.deploymentId) ?? false
      );
    },
    10_000,
    20,
  );
  assert.equal(saved.pluginId, PLUGIN);
  assert.deepEqual(saved.review.request, reviewRequest);
  assert.equal(saved.review.reviewDigest, approval.reviewDigest);
  assert(saved.review.approvable);
  assert.equal(saved.review.targets.length, 1);
  const reviewedTarget = saved.review.targets[0]!;
  assert.equal(reviewedTarget.machineId, runtime.machineId);
  assert.equal(reviewedTarget.platform, target);
  assert.equal(reviewedTarget.artifactSha256, runtime.artifactSha256);
  assert.equal(reviewedTarget.expectedInstallationRevision, before.installation?.revision);
  assert.deepEqual(reviewedTarget.consents, [], "install-only approval granted native rights");
  // The bootstrap fixture has no resource pins; this approval must replace it with reviewed pins.
  assert.notEqual(reviewedTarget.installationRevision, before.installation?.revision);
  for (const value of [
    saved.review.declarationSha256,
    reviewedTarget.installationRevision,
    ...reviewedTarget.resources.map((resource) => resource.sha256),
  ]) {
    assert(value, "approvable native review omitted a declaration, installation or resource pin");
    assert(reviewedText.includes(value), `native review omitted approved pin ${value}`);
  }
  const installed = await waitFor(
    async () => {
      const observed = await describe();
      const installation = observed.installation;
      return observed.connected &&
        installation?.ready &&
        installation.enabled &&
        !installation.purgeRequested &&
        installation.revision === reviewedTarget.installationRevision
        ? observed
        : false;
    },
    20_000,
    20,
  );
  const installation = installed.installation;
  assert(installation);
  assert.equal(installation.artifactSha256, runtime.artifactSha256);
  assert.deepEqual(installation.resourceBindings ?? null, reviewedTarget.resourceBindings);
  const deployment = await waitFor(
    async () => {
      const observed = JobDeploymentSchema.parse(
        await ownerAction(hub, "engine.jobs.readDeployment", { deploymentId: saved.deploymentId }),
      );
      return observed.targets.length === 1 &&
        observed.targets[0]?.machineId === runtime.machineId &&
        observed.targets[0].connected &&
        observed.targets[0].state === "ready"
        ? observed
        : false;
    },
    20_000,
    20,
  );
  const savedRenderer = `${nativeRuntime} [data-deployment=${JSON.stringify(deployment.deploymentId)}]`;
  await nativeClick(browser, `${savedRenderer} [data-action="engine.jobs.readDeployment"]`);
  await waitFor(
    () => nativeDeploymentReady(browser, deployment.deploymentId, runtime.machineId),
    5000,
    20,
  );
  await nativePreparationHierarchy(browser, "native-saved-deployment", savedRenderer);
  assert.deepEqual(runtime.starts(), [], "install-only preparation started an operation");
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
  const approveRun = `${nativeRuntime} button[aria-label=${JSON.stringify(`Approve machines:run on ${operationNode}`)}]`;
  await waitFor(
    () =>
      browser.evaluate<boolean>(`(() => {
      const button = document.querySelector(${JSON.stringify(approveRun)});
      return button instanceof HTMLButtonElement && !button.matches(':disabled');
    })()`),
    5000,
    20,
  );
  const retainedDescription = JobDeploymentDescriptionSchema.parse(
    await ownerAction(hub, "engine.jobs.describeDeployment", {
      machineId: runtime.machineId,
      pluginId: PLUGIN,
    }),
  );
  assert.deepEqual(retainedDescription.installation, {
    revision: installation.revision,
    artifactSha256: installation.artifactSha256,
    machine: deployment.review.machine,
  });
  assert.equal(retainedDescription.deployment?.deploymentId, deployment.deploymentId);
  assert.equal(retainedDescription.deployment?.state, "ready");
  const retainedDeclaration = await waitFor(
    () =>
      browser.evaluate<string | false>(`(() => {
      for (const pre of document.querySelectorAll(${JSON.stringify(`${nativeRuntime} details pre`)})) {
        const value = JSON.parse(pre.textContent);
        if (!value.machine || !Object.hasOwn(value, 'resourceBindings')) continue;
        const details = pre.closest('details');
        if (!details.open) details.querySelector('summary').click();
        return pre.textContent;
      }
      return false;
    })()`),
    5000,
    20,
  );
  assert.deepEqual(
    JSON.parse(retainedDeclaration),
    {
      machine: deployment.review.machine,
      resourceBindings: installation.resourceBindings ?? null,
    },
    "machine inspector did not retain the approved declaration and resource pins",
  );
  const run = `${nativeRuntime} button[data-action="engine.jobs.execute"][data-operation="${OPERATION}"]`;
  await waitFor(
    () =>
      browser.evaluate<boolean>(
        `document.querySelector(${JSON.stringify(run)})?.disabled === true`,
      ),
    5000,
    20,
  );
  // Review exactly one operation while offline: a saved pending deployment is not
  // installation acknowledgement, a consent grant, or a queued execution.
  await setConnected(false);
  await nativeClick(browser, `${nativeRuntime} input[data-operation=${JSON.stringify(OPERATION)}]`);
  const offlineBefore = await describe();
  const pendingRequest = await reviewDraft();
  assert.deepEqual(pendingRequest.operationIds, [OPERATION]);
  assert.deepEqual(pendingRequest.targets, reviewRequest.targets);
  const pendingRights = await displayedRights();
  await applyReview(pendingRequest);
  const pendingDeployment = await waitFor(
    async () => {
      const row = (await listDeployments()).deployments.find(
        (row) => row.deploymentId === pendingRequest.deploymentId,
      );
      return row?.targets[0]?.state === "pending" ? row : false;
    },
    10_000,
    20,
  );
  assert.equal(pendingDeployment.targets[0]!.reason, "owner_offline");
  assert.equal(pendingDeployment.targets[0]!.connected, false);
  assert.deepEqual(
    pendingDeployment.review.targets[0]!.consents,
    pendingRights,
    "offline saved approval changed the displayed permission revisions",
  );
  assert.deepEqual(
    (await describe()).consents,
    offlineBefore.consents,
    "offline approval granted consent",
  );
  await nativeDeploymentState(
    browser,
    pendingRequest.deploymentId,
    runtime.machineId,
    "pending",
    "owner_offline",
  );
  const pendingRenderer = `${nativeRuntime} [data-deployment=${JSON.stringify(pendingRequest.deploymentId)}]`;
  await nativePreparationHierarchy(browser, "native-offline-pending-deployment", pendingRenderer);
  const callsBeforeReconnect = deploymentCalls.length;
  await runtime.consent("machines:run", false);
  const fencedConsents = (await describe()).consents;
  const needsReview = await waitFor(
    async () => {
      const row = await readDeployment(pendingRequest.deploymentId);
      return row.targets[0]?.state === "needs_review" ? row : false;
    },
    10_000,
    20,
  );
  await setConnected(true);
  for (let refresh = 0; refresh < 2; refresh++) {
    await nativeClick(browser, `${pendingRenderer} [data-action="engine.jobs.readDeployment"]`);
    await nativeDeploymentState(
      browser,
      pendingRequest.deploymentId,
      runtime.machineId,
      "needs_review",
      needsReview.targets[0]!.reason!,
    );
    assert.equal(
      (await readDeployment(pendingRequest.deploymentId)).targets[0]!.state,
      "needs_review",
    );
    assert.deepEqual(
      (await describe()).consents,
      fencedConsents,
      "reconnect or refresh repaired fenced consent",
    );
  }
  assert.equal(
    deploymentCalls.length,
    callsBeforeReconnect,
    "refused evidence triggered an implicit review/apply retry",
  );
  await nativePreparationHierarchy(browser, "native-needs-review-deployment", pendingRenderer);
  assert.deepEqual(runtime.starts(), [], "pending preparation started an operation");

  const staleRequest = await reviewDraft();
  assert.deepEqual(staleRequest.operationIds, [OPERATION]);
  const staleDigest = await displayedDigest();
  const staleRights = await displayedRights();
  const expectedRights = [...rights, { node: operationNode, cap: "operations:invoke" }].sort(
    (a, b) => a.node.localeCompare(b.node) || a.cap.localeCompare(b.cap),
  );
  assert.deepEqual(
    staleRights.map(({ node, cap }) => ({ node, cap })),
    expectedRights,
  );
  assert.equal(deployment.review.machine.operations[OPERATION]!.network, "none");
  assert(
    !staleRights.some((right) => right.cap === "network:host"),
    "network:none requested host networking",
  );
  assert(
    !staleRights.some((right) => right.cap === "jobs:input"),
    "closed stdin requested input permission",
  );
  await nativePreparationHierarchy(browser, "native-exact-operation-review");
  await runtime.consent("machines:run", false);
  const changedEvidence = await describe();
  const changedRun = changedEvidence.consents.find(
    (row) => row.node === operationNode && row.cap === "machines:run",
  );
  assert(changedRun && !changedRun.enabled);
  assert.notEqual(
    changedRun.revision,
    staleRights.find((row) => row.cap === "machines:run")!.revision,
  );
  const beforeStaleApply = await listDeployments();
  await applyReview(staleRequest);
  await waitFor(
    () =>
      browser.evaluate<boolean>(
        `document.querySelector(${JSON.stringify(`${nativeRuntime} .plugin-manager-runtime-preparation > [role="alert"]`)}) !== null`,
      ),
    10_000,
    20,
  );
  assert.deepEqual(
    await listDeployments(),
    beforeStaleApply,
    "stale apply saved or altered deployment approval",
  );
  const afterStaleApply = await describe();
  assert.deepEqual(
    afterStaleApply.installation,
    changedEvidence.installation,
    "stale apply changed installation",
  );
  assert.deepEqual(
    afterStaleApply.consents,
    changedEvidence.consents,
    "stale apply changed consent",
  );
  assert.deepEqual(
    await browser.evaluate<string[]>(
      `[...document.querySelectorAll(${JSON.stringify(`${nativeRuntime} input[data-machine]:checked`)})].map(input => input.dataset.machine)`,
    ),
    [runtime.machineId],
    "stale apply lost the destination draft",
  );
  assert.equal(
    await browser.evaluate<string>(
      `document.querySelector(${JSON.stringify(`${nativeRuntime} select[data-machine=${JSON.stringify(runtime.machineId)}]`)}).value`,
    ),
    target,
    "stale apply lost the typed platform selection",
  );
  assert.deepEqual(
    await browser.evaluate<string[]>(
      `[...document.querySelectorAll(${JSON.stringify(`${nativeRuntime} input[data-operation]:checked`)})].map(input => input.dataset.operation)`,
    ),
    [OPERATION],
    "stale apply lost or widened the operation draft",
  );
  assert(
    await browser.evaluate<boolean>(
      `document.querySelector(${JSON.stringify(applyButton)}).disabled`,
    ),
  );
  await nativePreparationHierarchy(browser, "native-stale-review-preserved");
  const freshRequest = await reviewDraft();
  assert.deepEqual(freshRequest.targets, staleRequest.targets);
  assert.deepEqual(freshRequest.operationIds, staleRequest.operationIds);
  const freshDigest = await displayedDigest();
  assert.notEqual(freshDigest, staleDigest, "rereview reused a stale digest");
  const freshRights = await displayedRights();
  assert.deepEqual(
    freshRights.map(({ node, cap }) => ({ node, cap })),
    expectedRights,
  );
  assert.equal(
    freshRights.find((row) => row.cap === "machines:run")!.revision,
    changedRun.revision,
    "rereview did not pin the changed native consent revision",
  );
  await nativeClick(browser, `${reviewedRenderer} [data-machine] details:not([open]) summary`);
  await nativePreparationHierarchy(
    browser,
    "native-rereview-current-pins",
    reviewedRenderer,
    "[data-machine] details[open]",
  );
  await applyReview(freshRequest);
  const operationDeployment = await waitFor(
    async () => {
      const row = (await listDeployments()).deployments.find(
        (row) => row.deploymentId === freshRequest.deploymentId,
      );
      return row?.targets[0]?.state === "ready" ? row : false;
    },
    20_000,
    20,
  );
  assert.deepEqual(operationDeployment.review.request, freshRequest);
  assert.equal(operationDeployment.review.reviewDigest, freshDigest);
  assert.deepEqual(
    operationDeployment.review.targets[0]!.consents,
    freshRights,
    "saved operation approval changed the reviewed rights or revisions",
  );
  assert.equal(
    operationDeployment.review.targets[0]!.expectedInstallationRevision,
    installation.revision,
  );
  assert.equal(operationDeployment.review.targets[0]!.installationRevision, installation.revision);
  const scoped = await describe();
  assert.deepEqual(
    scoped.consents
      .filter((row) => row.enabled)
      .map(({ node, cap }) => ({ node, cap }))
      .sort((a, b) => a.node.localeCompare(b.node) || a.cap.localeCompare(b.cap)),
    expectedRights,
    "operation approval granted anything beyond the exact expanded permissions",
  );
  assert.equal(scoped.installation?.revision, installation.revision);
  assert.equal(scoped.installation?.artifactSha256, installation.artifactSha256);
  for (const right of freshRights) {
    const consent = scoped.consents.find((row) => row.node === right.node && row.cap === right.cap);
    assert(consent?.enabled, `reviewed permission not applied: ${right.cap} on ${right.node}`);
    if (right.approved)
      assert.equal(consent.revision, right.revision, "current consent was needlessly replaced");
    else
      assert.notEqual(
        consent.revision,
        right.revision,
        "new approval retained the old consent revision",
      );
  }
  await nativeDeploymentState(browser, freshRequest.deploymentId, runtime.machineId, "ready", "");
  await nativePreparationHierarchy(
    browser,
    "native-exact-operation-prepared",
    `${nativeRuntime} [data-deployment=${JSON.stringify(freshRequest.deploymentId)}]`,
  );
  assert.deepEqual(
    runtime.starts(),
    [],
    "operation consent approval executed without a run gesture",
  );
  assert.deepEqual(executionCalls, [], "deployment review/apply submitted an execution");
  const preparedJournal = new Database(join(hub.dataDir, "manifold.db"), { readonly: true });
  try {
    assert.deepEqual(
      preparedJournal
        .query<{ job_id: string }, []>("SELECT job_id FROM machine_jobs ORDER BY job_id")
        .all(),
      initialJobs,
      "deployment preparation persisted a job without an execution gesture",
    );
  } finally {
    preparedJournal.close();
  }
  const approved = await describe();
  const requester = await browser.evaluate<string>(
    "JSON.parse(localStorage.getItem('manifold.identity')).principal.id",
  );
  assert.equal(deployment.approvedBy, requester, "saved approval lost the browser operator");
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
    const priorJobs = await browser.evaluate<string[]>(
      "[...(document.querySelector('select[aria-label=\"Operation run\"]')?.options ?? [])].map(option => option.value)",
    );
    await nativeClick(browser, run);
    const jobId = await waitFor(
      async () => {
        const selected = await browser.evaluate<unknown>(
          "document.querySelector('select[aria-label=\"Operation run\"]')?.value",
        );
        return typeof selected === "string" && selected.length > 0 && !priorJobs.includes(selected)
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
    await waitFor(() => historyContains(observer, jobs), 5000, 20);
  }
  const pageUrl = await browser.evaluate<string>("location.href");
  await browser.goto(pageUrl);
  await openNativeHistory(browser, runtime.machineId);
  await nativeClick(browser, `${nativeRuntime} [data-action="engine.jobs.listDeployments"]`);
  await nativeSelectControl(
    browser,
    `${nativeRuntime} .plugin-manager-runtime-history select`,
    deployment.deploymentId,
  );
  await waitFor(
    () => nativeDeploymentReady(browser, deployment.deploymentId, runtime.machineId),
    5000,
    20,
  );
  const recoveredDeployment = JobDeploymentSchema.parse(
    await ownerAction(hub, "engine.jobs.readDeployment", { deploymentId: deployment.deploymentId }),
  );
  assert.deepEqual(
    recoveredDeployment.review,
    deployment.review,
    "reload lost the saved reviewed scope",
  );
  await nativePreparationHierarchy(browser, "native-recovered-deployment", savedRenderer);
  await waitFor(() => historyContains(browser, jobs), 5000, 20);
  const retained = jobs[0]!;
  await nativeSelect(browser, "Operation run", retained.jobId);
  const statusSelector = '[data-testid="plugin-manager-job-status"]';
  await waitFor(
    () =>
      browser.evaluate<boolean>(
        `document.querySelector(${JSON.stringify(statusSelector)})?.innerText.includes(${JSON.stringify(retained.state)}) === true`,
      ),
    5000,
    20,
  );
  await nativeScreenshot(browser, statusSelector, "native-recovered-history");
  await nativeScreenshot(observer, '[aria-label="Operation run history"]', "native-shared-history");
  await nativeClick(
    browser,
    `${nativeRuntime} button[aria-label=${JSON.stringify(`Revoke jobs:read on ${operationNode}`)}]`,
  );
  await waitFor(() => historyContains(observer, jobs, false), 5000, 20);
  await waitFor(
    () =>
      browser.evaluate<boolean>(
        `document.querySelector(${JSON.stringify(statusSelector)})?.innerText.includes(${JSON.stringify(retained.result!.requestDigest)}) === false`,
      ),
    5000,
    20,
  );
  await nativeClick(
    browser,
    `${nativeRuntime} button[aria-label=${JSON.stringify(`Approve jobs:read on ${operationNode}`)}]`,
  );
  await waitFor(() => historyContains(observer, jobs), 5000, 20);
  await waitFor(() => historyContains(browser, jobs), 5000, 20);
  assert.deepEqual(runtime.starts(), nativeStarts, "native controls started unexpected executions");
  console.log(
    "PASS native Plugins UI: refused missing evidence, install-only approval, offline pending deployment, durable needs-review, stale apply saved nothing and retained draft, fresh exact-operation consent revisions without execution, retained declaration, persisted result/authority, cancellation, reload recovery, shared history",
  );
  return {
    target,
    installation,
    deployment,
    operationDeployment,
    pendingDeployment,
    needsReview,
    missingRequest,
    staleRequest,
    freshRequest,
    staleDigest,
    freshDigest,
    staleRights,
    freshRights,
    jobs,
  };
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
    await waitFor(
      () => browser.evaluate<boolean>("document.querySelector('#identity-name') !== null"),
      10_000,
      50,
    );
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
    const unsupportedDeployment = await nativeUnprovedDeployment(browser, hub, runtime.machineId);
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
    const observationGrant = await mintToken(hub, {
      principal: { kind: "human", name: "runtime-job-observer", color: "#446688" },
      caps: ["containers:read", "jobs:read"],
    });
    grants.push(observationGrant.principal.id);
    const observer = new Browser();
    browsers.push(observer);
    await observer.launch({ incognito: true });
    await observer.goto(hub.httpUrl);
    await observer.evaluate(
      `localStorage.setItem('manifold.identity', ${JSON.stringify(JSON.stringify({ token: observationGrant.token, principal: observationGrant.principal }))})`,
    );
    await observer.goto(`${hub.httpUrl}/p/${container.id}`);
    await openNativeHistory(observer, runtime.machineId);
    const native = await nativeProof(browser, observer, hub, runtime, async (connected) => {
      if (connected) {
        assert.equal(agent, undefined, "native reconnect already has a transport");
        agent = await runtime.startAgent();
        await waitFor(
          async () => {
            const state = await describe();
            return state.connected && state.installation?.ready;
          },
          20_000,
          20,
        );
      } else {
        assert(agent, "native disconnect has no transport");
        await agent.stop();
        agent = undefined;
        await waitFor(async () => !(await describe()).connected, 10_000, 20);
      }
    });
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
            native: { ...native, unsupportedDeployment },
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
    for (const [index, browser] of browsers.entries()) {
      try {
        await screenshot(browser, `failure-browser-${index}`);
        console.error(
          "Runtime browser failure state:",
          await browser.evaluate(
            "({ready:document.readyState,rootChildren:document.querySelector('#root')?.childElementCount,identity:document.querySelector('#identity-name')!==null,offline:document.querySelector('[data-testid=lens-offline]')?.textContent,skew:document.querySelector('[data-testid=lens-skew]')?.textContent})",
          ),
        );
      } catch {
        console.error("Runtime browser failure state unavailable");
      }
    }
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
