import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentRunInspection, CredentialsResponse } from "@manifold/protocol";
import { Browser } from "../../../scripts/cdp.ts";
import { until } from "../../../scripts/gate-lib.ts";

// The existing component-browser convention: real React DOM and system Chromium, with
// deterministic action responses. No server, credentials, new renderer or production seam.
const browser = new Browser();
let scratch = "";
let server: Bun.Server<undefined> | undefined;
const at = 1_700_000_000_000;
const traceId = "9007199254740993";
const nativeTraceId = "9007199254740997";
const credentials: CredentialsResponse = {
  principals: [
    {
      principal: { id: "agent-one", kind: "agent", name: "Review agent", color: "#91a7ff" },
      createdAt: at,
      sessions: [{ id: "agent-session", createdAt: at, caps: ["space:read"] }],
    },
    {
      principal: { id: "human-one", kind: "human", name: "Human reader", color: "#74c0fc" },
      createdAt: at,
      sessions: [{ id: "human-session", createdAt: at, caps: ["space:read"] }],
    },
    {
      principal: { id: "legacy-agent", kind: "agent", name: "Legacy agent", color: "#91a7ff" },
      createdAt: at,
      sessions: [],
    },
  ],
};
const inspection: AgentRunInspection = {
  availability: "available",
  observedAt: at + 2_000,
  run: {
    id: "run-one",
    principalId: "agent-one",
    name: "Review agent",
    state: "cleanup_failed",
    rootRunId: "run-root",
    parentRunId: "run-root",
    sponsorPrincipalId: "sponsor-one",
    authorizationPath: "principal",
    purpose: "Review the retained lifecycle facts",
    taskRef: "issue:557",
    target: "manifold://container/review",
    reach: "subtree",
    caps: ["space:read"],
    createdAt: at,
    expiresAt: at + 1_000,
    renewals: 0,
    depth: 1,
    maxDepth: 4,
    maxDescendants: 32,
    policyRevision: "policy-current",
    acknowledgedPolicyRevision: "policy-old",
    policyAcknowledgedAt: at,
    cleanup: {
      ownerPrincipalId: "sponsor-one",
      revokedCredentials: 1,
      revokedGrants: 1,
      finishedAt: null,
      status: "failed",
    },
  },
  lineage: [
    { id: "run-root", principalId: "root-agent", name: "Parent run", state: "expired" },
    { id: "run-one", principalId: "agent-one", name: "Review agent", state: "cleanup_failed" },
  ],
  lineageComplete: false,
  credentials: [{ createdAt: at, expiresAt: at + 1_000, revokedAt: at + 500, state: "revoked", grant: null }],
  connections: [{ connectionId: "connection-one", state: "closed_or_unavailable", firstObservedAt: at, lastObservedAt: null }],
  traces: [{
    traceId,
    at,
    actor: "agent-one",
    action: "core.space.list",
    authority: "space:read",
    targets: ["manifold://container/review"],
    outcome: null,
    settlement: "pending_or_crashed",
    connectionId: "connection-one",
    origin: "connection",
    agentDeclaration: "Checking the retained workspace facts",
  }],
  nextBeforeTraceId: "9007199254740991",
  requestedTrace: "not_requested",
  history: "retained_only",
  jobs: [{
    jobId: "job-one",
    machineId: "machine-one",
    pluginId: "native.review",
    operationId: "check",
    installationRevision: "installation-one",
    artifactSha256: "0".repeat(64),
    state: "exited",
    createdAt: at,
    startedAt: at + 100,
    finishedAt: at + 200,
    exitCode: 1,
    traceId: nativeTraceId,
    origin: "retained",
    parentJobId: null,
    terminalId: "terminal-one",
    ownerState: "unconfirmed",
  }],
  terminals: [],
  nativeTruncated: true,
};

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "manifold-run-inspector-"));
  const plugin = resolve(import.meta.dir, "../../plugin");
  const entry = join(scratch, "fixture.js");
  const output = join(scratch, "dist");
  // Resolve the already-declared React peers of the existing browser-fixture owner.
  await Bun.write(entry, `
    import { createElement } from ${JSON.stringify(Bun.resolveSync("react", plugin))};
    import { createRoot } from ${JSON.stringify(Bun.resolveSync("react-dom/client", plugin))};
    import { SessionsSection } from ${JSON.stringify(resolve(import.meta.dir, "../../plugins/access/src/web.tsx"))};
    const requests = [];
    const pending = new Map();
    const navigations = [];
    const root = createRoot(document.getElementById("root"));
    const host = {
      principal: { id: "viewer", kind: "human", name: "Viewer", color: "#74c0fc" },
      client: {
        selfCaps: () => ["*"],
        action: (action, args) => {
          const { promise, resolve } = Promise.withResolvers();
          const id = requests.length;
          requests.push({ id, action, args });
          pending.set(id, resolve);
          return promise;
        },
      },
      navigate: uri => navigations.push(uri),
    };
    window.inspectorFixture = {
      requests,
      navigations,
      answer: (id, outcome) => {
        const resolve = pending.get(id);
        if (!resolve) throw new Error("No pending action " + id);
        pending.delete(id);
        resolve(outcome);
      },
    };
    root.render(createElement(SessionsSection, { host }));
  `);
  const build = Bun.spawn(["bun", "build", entry, "--target=browser", "--outdir", output], {
    cwd: plugin,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ]);
  if (code !== 0) throw new Error(`Fixture build failed (${String(code)}): ${stdout}\n${stderr}`);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture.js" || path === "/fixture.css") {
        return new Response(Bun.file(join(output, path.slice(1))), {
          headers: { "Content-Type": path.endsWith(".css") ? "text/css" : "text/javascript" },
        });
      }
      return new Response(
        '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="root" style="width:340px"></div><script type="module" src="/fixture.js"></script>',
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  await browser.launch({ incognito: true });
}, 60_000);

async function requests(count: number): Promise<readonly { action: string; args: unknown }[]> {
  await until(
    () => browser.evaluate<boolean>(`window.inspectorFixture?.requests.length === ${String(count)}`),
    5_000,
    `${String(count)} action requests`,
  );
  return browser.evaluate("window.inspectorFixture.requests");
}

async function answer(id: number, result: unknown): Promise<void> {
  await browser.evaluate(`window.inspectorFixture.answer(${String(id)}, ${JSON.stringify({ ok: true, result })})`);
  await browser.evaluate(`(() => {
    const frame = Promise.withResolvers();
    requestAnimationFrame(() => requestAnimationFrame(() => frame.resolve()));
    return frame.promise;
  })()`);
}

async function visibleText(expected: string): Promise<void> {
  await until(
    () => browser.evaluate<boolean>(`document.body.innerText.includes(${JSON.stringify(expected)})`),
    5_000,
    `visible ${expected}`,
  );
}

async function clickButton(label: string): Promise<void> {
  const clicked = await browser.evaluate<boolean>(`(() => {
    const button = [...document.querySelectorAll("button")].find(button =>
      button.checkVisibility() && (button.getAttribute("aria-label") === ${JSON.stringify(label)} || button.textContent.trim().startsWith(${JSON.stringify(label)}))
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
  expect(clicked).toBe(true);
}

beforeEach(async () => {
  if (server === undefined) throw new Error("Fixture server did not start");
  await browser.goto(`http://127.0.0.1:${String(server.port)}/`);
  await requests(1);
  await answer(0, credentials);
  await visibleText("Human reader");
});

afterEach(() => {
  expect(browser.drainMessages().filter((message) => message.level === "error")).toEqual([]);
});

afterAll(async () => {
  await browser.close();
  await server?.stop(true);
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
});

test("an agent name opens the safe run snapshot and expandable native trace references", async () => {
  await browser.evaluate('document.querySelector(\'[aria-label="Inspect agent run for Review agent"]\').focus()');
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  expect((await requests(2))[1]).toMatchObject({
    action: "core.access.inspectAgentRun",
    args: { principalId: "agent-one" },
  });
  await visibleText("Loading agent run");
  await answer(1, inspection);
  await visibleText("Purpose declaration");
  await visibleText("Review the retained lifecycle facts");
  await visibleText("Sponsor");
  await visibleText("sponsor-one");
  await visibleText("Task reference");
  await visibleText("issue:557");
  await visibleText("cleanup_failed");
  await visibleText("Retained-only history");
  await visibleText(`Trace ${traceId}`);
  await visibleText("pending_or_crashed");
  expect(await browser.evaluate(`(() => {
    const button = document.querySelector('[aria-label="Inspect agent run for Review agent"]');
    return button.getAttribute("aria-expanded") === "true" &&
      document.getElementById(button.getAttribute("aria-controls"))?.getAttribute("aria-label") === "Agent run inspection";
  })()`)).toBe(true);

  await clickButton(`Trace ${traceId}`);
  expect((await requests(3))[2]).toMatchObject({
    action: "core.access.inspectAgentRun",
    args: { runId: "run-one", traceId },
  });
  await answer(2, { ...inspection, requestedTrace: "available" });
  await visibleText("Agent declaration");
  await visibleText("Checking the retained workspace facts");

  await clickButton("Jobs · 1");
  await visibleText("unconfirmed");
  await clickButton(`Trace ${nativeTraceId}`);
  expect((await requests(4))[3]).toMatchObject({
    action: "core.access.inspectAgentRun",
    args: { runId: "run-one", traceId: nativeTraceId },
  });
  await answer(3, { ...inspection, traces: [], requestedTrace: "unavailable" });
  await visibleText(`Trace ${nativeTraceId} is unavailable in retained history`);
  await clickButton("Open manifold://terminal/terminal-one");
  expect(await browser.evaluate("window.inspectorFixture.navigations")).toEqual(["manifold://terminal/terminal-one"]);

  await clickButton("Run lineage · 2");
  await clickButton("Inspect run Parent run");
  expect((await requests(5))[4]).toMatchObject({
    action: "core.access.inspectAgentRun",
    args: { runId: "run-root" },
  });
  await answer(4, { availability: "origin_unavailable", principalId: "root-agent" });
  await visibleText("Origin unavailable");
  expect(await browser.evaluate('document.body.innerText.includes("Review the retained lifecycle facts")')).toBe(false);
}, 60_000);

test("human names remain inert and their existing two-press withdrawal is unchanged", async () => {
  expect(await browser.evaluate(`(() => {
    const name = document.querySelector('[data-principal="human-one"] .credential-name strong');
    name.click();
    return name.closest("button") === null;
  })()`)).toBe(true);
  expect(await browser.evaluate('document.querySelector(".credential-inspection")')).toBeNull();
  expect(await browser.evaluate("window.inspectorFixture.requests.length")).toBe(1);
  await clickButton("Withdraw every credential of Human reader");
  await until(
    () => browser.evaluate<boolean>('document.querySelector(\'[aria-label="Confirm withdrawing every credential of Human reader"]\') !== null'),
    5_000,
    "human withdrawal confirmation",
  );
  expect(await browser.evaluate("window.inspectorFixture.requests.length")).toBe(1);
  await clickButton("Confirm withdrawing every credential of Human reader");
  expect((await requests(2))[1]).toMatchObject({
    action: "core.access.revoke",
    args: { principalId: "human-one" },
  });
}, 60_000);

test("changing the inspected identity discards a late response from the previous run", async () => {
  await clickButton("Inspect agent run for Review agent");
  await requests(2);
  await clickButton("1 inactive identity");
  await clickButton("Inspect agent run for Legacy agent");
  expect((await requests(3))[2]).toMatchObject({ args: { principalId: "legacy-agent" } });
  await answer(2, { availability: "origin_unavailable", principalId: "legacy-agent" });
  await visibleText("Origin unavailable");
  await answer(1, inspection);
  expect(await browser.evaluate('document.body.innerText.includes("Review the retained lifecycle facts")')).toBe(false);
}, 60_000);
