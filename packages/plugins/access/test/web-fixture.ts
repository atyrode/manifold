import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatManifoldUri } from "@manifold/protocol";
import type {
  ActionOutcome,
  Agent,
  AgentRun,
  InspectRunResult,
  CredentialsResponse,
} from "@manifold/protocol";
import { Browser } from "../../../../scripts/cdp.ts";
import { until } from "../../../../scripts/gate-lib.ts";

export const at = 1_700_000_000_000;
const scheduledJobId = `schedule-${"a".repeat(64)}`;
export const scheduledJobUri = formatManifoldUri({
  kind: "job",
  jobId: scheduledJobId,
  machineId: "machine-one",
  operationId: "check",
});
export const agent: Agent = {
  agentId: "profile-one",
  principalId: "agent-one",
  sponsorPrincipalId: "viewer",
  name: "Review agent",
  purpose: "Review the retained lifecycle facts",
  harness: "external",
  grant: {
    caps: ["containers:read"],
    targets: ["manifold://container/review"],
    reach: "subtree",
    maxRunLifetimeMs: 3_600_000,
    delegation: { maxDepth: 2, maxDescendants: 4 },
    expiresAt: at + 86_400_000,
  },
  context: { instructions: "Review the change without publishing it", profile: {} },
  state: "idle",
  activeRuns: 0,
  createdAt: at,
  updatedAt: at,
};
export const credentials: CredentialsResponse = {
  principals: [
    {
      principal: { id: "agent-one", kind: "agent", name: "Review agent", color: "#91a7ff" },
      createdAt: at,
      sessions: [{ id: "agent-session", createdAt: at, caps: ["containers:read"] }],
    },
    {
      principal: { id: "human-one", kind: "human", name: "Human reader", color: "#74c0fc" },
      createdAt: at,
      sessions: [{ id: "human-session", createdAt: at, caps: ["containers:read"] }],
    },
    {
      principal: { id: "legacy-agent", kind: "agent", name: "Legacy agent", color: "#91a7ff" },
      createdAt: at,
      sessions: [],
    },
  ],
};
export const inspection: InspectRunResult = {
  availability: "available",
  observedAt: at + 2_000,
  run: {
    id: "run-one",
    agentId: agent.agentId,
    principalId: agent.principalId,
    name: agent.name,
    state: "cleanup_failed",
    activity: "blocked",
    model: { provider: "local", model: "review-model" },
    session: { harness: "external", sessionId: "conversation-one", machineId: "machine-one" },
    rootRunId: "run-root",
    parentRunId: "run-root",
    sponsorPrincipalId: "viewer",
    authorizationPath: "principal",
    purpose: agent.purpose,
    taskRef: "issue:578",
    target: "manifold://container/review",
    reach: "subtree",
    caps: ["containers:read"],
    createdAt: at,
    expiresAt: at + 60_000,
    renewals: 0,
    depth: 1,
    maxDepth: 2,
    maxDescendants: 4,
    policyRevision: "policy-current",
    acknowledgedPolicyRevision: "policy-old",
    policyAcknowledgedAt: at,
    cleanup: {
      ownerPrincipalId: "viewer",
      revokedCredentials: 1,
      revokedGrants: 1,
      finishedAt: null,
      status: "failed",
    },
  },
  lineage: [
    {
      id: "run-root",
      agentId: agent.agentId,
      principalId: agent.principalId,
      name: "Parent run",
      state: "expired",
      activity: "done",
      session: null,
    },
    {
      id: "run-one",
      agentId: agent.agentId,
      principalId: agent.principalId,
      name: agent.name,
      state: "cleanup_failed",
      activity: "blocked",
      session: null,
    },
  ],
  lineageComplete: false,
  credentials: [
    { createdAt: at, expiresAt: at + 1_000, revokedAt: at + 500, state: "revoked", grant: null },
  ],
  connections: [
    {
      connectionId: "connection-one",
      state: "closed_or_unavailable",
      firstObservedAt: at,
      lastObservedAt: null,
    },
  ],
  traces: [
    {
      traceId: "9007199254740993",
      at,
      actor: "agent-one",
      action: "core.space.list",
      authority: "space:read",
      targets: ["manifold://container/review", scheduledJobUri],
      outcome: null,
      settlement: "pending_or_crashed",
      connectionId: "connection-one",
      origin: "connection",
      agentDeclaration: "Checking retained workspace facts",
    },
  ],
  nextBeforeTraceId: "9007199254740991",
  requestedTrace: "not_requested",
  history: "retained_only",
  jobs: [
    {
      jobId: scheduledJobId,
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
      traceId: "9007199254740997",
      origin: "retained",
      parentJobId: null,
      terminalId: "terminal-one",
      ownerState: "unconfirmed",
    },
  ],
  terminals: [],
  nativeTruncated: true,
};
export const inventory = {
  observedAt: at,
  truncated: false,
  runs: [
    {
      id: "run-root",
      agentId: agent.agentId,
      principalId: agent.principalId,
      name: "Parent run",
      state: "expired",
      activity: "done",
      session: null,
      purpose: agent.purpose,
      createdAt: at - 1_000,
      expiresAt: at,
      parentRunId: null,
      actionCount: 2,
      refusalCount: 0,
    },
    {
      id: "run-one",
      agentId: agent.agentId,
      principalId: agent.principalId,
      name: agent.name,
      state: "active",
      activity: "blocked",
      session: inspection.run.session,
      model: inspection.run.model,
      purpose: agent.purpose,
      createdAt: at,
      expiresAt: at + 60_000,
      parentRunId: "run-root",
      actionCount: 3,
      refusalCount: 1,
    },
  ],
};

export const admittedRun: AgentRun = {
  id: "admitted-run",
  agentId: agent.agentId,
  session: null,
  activity: "unknown",
  principal: { id: agent.principalId, kind: "agent", name: agent.name, color: "#91a7ff" },
  rootRunId: "admitted-run",
  parentRunId: null,
  authorizedByPrincipalId: "viewer",
  authorizationPath: "principal",
  authorizationCredential: {
    tokenId: null,
    grantId: null,
    caps: ["agents:delegate"],
    containerScope: null,
  },
  purpose: agent.purpose,
  target: "manifold://container/review",
  reach: "subtree",
  caps: ["containers:read"],
  createdAt: at,
  expiresAt: at + 60_000,
  renewals: 0,
  maxDepth: 2,
  maxDescendants: 4,
  depth: 0,
  cleanupOwnerPrincipalId: "viewer",
  state: "pending_policy",
  policyRevision: "a".repeat(64),
  cleanup: { revokedCredentials: 0, revokedGrants: 0 },
};

/** The established real-React/system-Chromium seam, shared by rendering and inspection cases. */
export class AccessBrowser {
  readonly browser = new Browser();
  private scratch = "";
  private server: Bun.Server<undefined> | undefined;

  async start(): Promise<void> {
    this.scratch = mkdtempSync(join(tmpdir(), "manifold-agents-web-"));
    const plugin = resolve(import.meta.dir, "../../../plugin");
    const entry = join(this.scratch, "fixture.js");
    const output = join(this.scratch, "dist");
    await Bun.write(
      entry,
      `
      import { createElement } from ${JSON.stringify(Bun.resolveSync("react", plugin))};
      import { createRoot } from ${JSON.stringify(Bun.resolveSync("react-dom/client", plugin))};
      import { flushSync } from ${JSON.stringify(Bun.resolveSync("react-dom", plugin))};
      import { AgentsSection, SessionsSection } from ${JSON.stringify(resolve(import.meta.dir, "../src/web.tsx"))};
      import { parseManifoldUri } from ${JSON.stringify(Bun.resolveSync("@manifold/protocol", plugin))};
      import ${JSON.stringify(resolve(import.meta.dir, "../../../ui/src/styles.css"))};
      const root = createRoot(document.getElementById("root"));
      const requests = [], pending = new Map(), navigations = [], terminals = [], eventListeners = new Set();
      const client = caps => ({ selfCaps: () => caps, status: "open", on: () => () => {},
        subscribe: (_topics, listener) => { eventListeners.add(listener); return () => eventListeners.delete(listener); },
        action: (action, args) => {
        const { promise, resolve } = Promise.withResolvers();
        const id = requests.length; requests.push({ id, action, args }); pending.set(id, resolve); return promise;
      }, openTerminal: async options => { terminals.push(options); return { id: "opened-terminal" }; } });
      let host = { principal: { id: "viewer", kind: "human", name: "Viewer", color: "#74c0fc" }, client: client(["*"]), requestedRef: null, containerId: "review", navigate: uri => { navigations.push(uri); host = { ...host, requestedRef: parseManifoldUri(uri) }; render(); } };
      let surface = new URL(location.href).searchParams.get("surface") ?? "agents";
      const render = () => root.render(createElement(surface === "sessions" ? SessionsSection : AgentsSection, { host }));
      window.accessFixture = { requests, navigations, terminals,
        mount: value => { surface = value; render(); },
        replaceViewer: (id, caps) => { host = { ...host, principal: { ...host.principal, id }, client: client(caps) }; flushSync(render); },
        leaveRoom: () => { host = { ...host, containerId: null, client: client([]) }; flushSync(render); },
        answer: (id, outcome) => { const resolve = pending.get(id); if (!resolve) throw new Error("No pending action " + id); pending.delete(id); resolve(outcome); },
        pending: () => requests.filter(request => pending.has(request.id)),
        emitAccess: () => { for (const listener of eventListeners) listener({ pluginId: "core.access", kind: "run_changed", payload: {} }); },
      };
      render();
    `,
    );
    const build = await Bun.build({ entrypoints: [entry], target: "browser", outdir: output });
    if (!build.success)
      throw new Error(`Access fixture build failed: ${build.logs.map(String).join("\n")}`);
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/fixture.js" || path === "/fixture.css")
          return new Response(Bun.file(join(output, path.slice(1))), {
            headers: { "Content-Type": path.endsWith(".css") ? "text/css" : "text/javascript" },
          });
        return new Response(
          '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>body{background:#171b20;color:#dee2e6;font-family:sans-serif}#root{width:340px}</style><div id="root"></div><script type="module" src="/fixture.js"></script>',
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
    await this.browser.launch({ incognito: true });
  }

  async reset(surface: "agents" | "sessions" = "agents"): Promise<void> {
    if (this.server === undefined) throw new Error("Access fixture did not start");
    await this.browser.goto(`http://127.0.0.1:${String(this.server.port)}/?surface=${surface}`);
    await until(
      () => this.browser.evaluate<boolean>("window.accessFixture !== undefined"),
      5_000,
      "Access mount",
    );
  }

  async answer(action: string, result: unknown): Promise<void> {
    await this.outcome(action, { ok: true, result });
  }

  async outcome(action: string, outcome: ActionOutcome): Promise<void> {
    await until(
      () =>
        this.browser.evaluate<boolean>(
          `window.accessFixture.pending().some(request => request.action === ${JSON.stringify(action)})`,
        ),
      5_000,
      action,
    );
    await this.browser.evaluate<void>(
      `(() => { const request = window.accessFixture.pending().find(request => request.action === ${JSON.stringify(action)}); window.accessFixture.answer(request.id, ${JSON.stringify(outcome)}); })()`,
    );
    await this.browser.evaluate<void>(
      "(() => { const frame = Promise.withResolvers(); requestAnimationFrame(() => requestAnimationFrame(frame.resolve)); return frame.promise; })()",
    );
  }

  async boot(agents: readonly Agent[] = [agent]): Promise<void> {
    await this.answer("core.access.listAgents", { agents, truncated: false, canRegister: true });
    await this.answer("core.access.listRuns", inventory);
    await this.answer("core.access.listHarnesses", {
      harnesses: [
        { id: "external", title: "External runner", profileSchema: {}, sessionRef: "typed" },
      ],
    });
  }

  async text(value: string): Promise<void> {
    await until(
      () =>
        this.browser.evaluate<boolean>(
          `document.body.innerText.includes(${JSON.stringify(value)})`,
        ),
      5_000,
      `visible ${value}`,
    );
  }

  async click(label: string): Promise<void> {
    const found = await this.browser.evaluate<boolean>(
      `(() => { const button = [...document.querySelectorAll("button")].find(button => button.checkVisibility() && (button.getAttribute("aria-label") === ${JSON.stringify(label)} || button.textContent.trim().startsWith(${JSON.stringify(label)}))); if (!button) return false; button.click(); return true; })()`,
    );
    if (!found) throw new Error(`Visible button unavailable: ${label}`);
  }

  async detail(value: Agent = agent): Promise<void> {
    await this.click(value.name);
    await this.answer("core.access.getAgent", { agent: value, canManage: true });
    await this.answer("core.access.listRuns", inventory);
  }

  async close(): Promise<void> {
    await this.browser.close();
    await this.server?.stop(true);
    if (this.scratch !== "") rmSync(this.scratch, { recursive: true, force: true });
  }
}
