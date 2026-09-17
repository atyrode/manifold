import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Agent } from "@manifold/protocol";
import {
  AccessBrowser,
  admittedRun,
  at,
  agent,
  credentials,
  inspection,
  inventory,
  nativeService,
  nativeServiceDescription,
} from "./web-fixture.ts";

const ui = new AccessBrowser();
beforeAll(() => ui.start(), 60_000);
beforeEach(() => ui.reset(), 60_000);
afterEach(() => {
  expect(ui.browser.drainMessages().filter((message) => message.level === "error")).toEqual([]);
});
afterAll(() => ui.close());

test("Agent state controls distinguish reusable, disabled and permanently retired profiles", async () => {
  const states: readonly Agent[] = [
    agent,
    { ...agent, agentId: "working", name: "Working agent", state: "running", activeRuns: 2 },
    { ...agent, agentId: "disabled", name: "Disabled agent", state: "disabled" },
    { ...agent, agentId: "retired", name: "Retired agent", state: "retired", activeRuns: 1 },
  ];
  await ui.boot(states);
  await ui.text("idle");
  await ui.text("running");
  await ui.text("disabled");
  await ui.text("retired");
  await ui.text("2 active runs");
  await ui.detail(states[2]);
  await ui.text("Enable");
  expect(
    await ui.browser.evaluate<boolean>(
      `document.querySelector('[data-action="core.access.createRun"]').disabled`,
    ),
  ).toBe(true);
  await ui.detail(states[3]);
  await ui.text("Retired permanently");
  expect(
    await ui.browser.evaluate<boolean>(
      `document.querySelector('[data-action="core.access.createRun"]') === null`,
    ),
  ).toBe(true);
  expect(
    await ui.browser.evaluate<boolean>(
      `document.querySelector('[data-action="core.access.enableAgent"]') === null`,
    ),
  ).toBe(true);
  await ui.detail(agent);
  await ui.text("Disable");
  await ui.click("Retire");
  await ui.text("Confirm retire");
  expect(
    await ui.browser.evaluate<boolean>(
      'window.accessFixture.requests.some(request => request.action === "core.access.retireAgent")',
    ),
  ).toBe(false);
  await ui.click("Confirm retire");
  await ui.outcome("core.access.retireAgent", {
    ok: false,
    denial: { rule: "refused", message: "Sponsor authority was withdrawn" },
  });
  await ui.text("Sponsor authority was withdrawn");
  await ui.text("Disable");
}, 60_000);

test("human and legacy Sessions remain logins while linked Agent principals expose native cross-links", async () => {
  await ui.reset("sessions");
  await ui.answer("core.access.listCredentials", credentials);
  await ui.answer("core.access.listAgents", {
    agents: [agent],
    truncated: false,
    canRegister: true,
  });
  await ui.answer("core.access.listRuns", inventory);
  await ui.text("Human reader");
  expect(
    await ui.browser.evaluate<string>(
      'document.querySelector("[data-principal=human-one]").innerText',
    ),
  ).toContain("No Agent linked");
  await ui.click("1 inactive identity");
  expect(
    await ui.browser.evaluate<string>(
      'document.querySelector("[data-principal=legacy-agent]").innerText',
    ),
  ).toContain("No Agent linked");
  await ui.click("Open Agent Review agent");
  await ui.click("Open run run-one");
  expect(await ui.browser.evaluate<string[]>("window.accessFixture.navigations")).toEqual([
    "manifold://agent/profile-one",
    "manifold://run/run-one",
  ]);
  await ui.click("Withdraw every credential of Human reader");
  expect(
    await ui.browser.evaluate<boolean>(
      'window.accessFixture.requests.some(request => request.action === "core.access.revoke")',
    ),
  ).toBe(false);
  await ui.click("Confirm withdrawing every credential of Human reader");
  await ui.outcome("core.access.revoke", {
    ok: false,
    denial: { rule: "forbidden", message: "Credential withdrawal is not authorized" },
  });
  await ui.text("Credential withdrawal is not authorized");
  await ui.click("Withdraw every credential of Review agent");
  await ui.click("Confirm withdrawing every credential of Review agent");
  await ui.outcome("core.access.revoke", {
    ok: false,
    denial: { rule: "forbidden", message: "Agent credential withdrawal is not authorized" },
  });
  await ui.text("Agent credential withdrawal is not authorized");
}, 60_000);

test("Sessions pause and resume the same principal without destructive confirmation", async () => {
  await ui.reset("sessions");
  await ui.answer("core.access.listCredentials", credentials);
  await ui.answer("core.access.listAgents", {
    agents: [agent],
    truncated: false,
    canRegister: true,
  });
  await ui.answer("core.access.listRuns", inventory);

  await ui.click("Pause access for Human reader");
  await ui.outcome("core.access.pause", {
    ok: true,
    result: { principalId: "human-one", pausedAt: at + 1_000 },
  });
  await ui.answer("core.access.listCredentials", {
    principals: credentials.principals.map((row) =>
      row.principal.id === "human-one" ? { ...row, pausedAt: at + 1_000 } : row,
    ),
  });
  await ui.answer("core.access.listAgents", {
    agents: [agent],
    truncated: false,
    canRegister: true,
  });
  await ui.answer("core.access.listRuns", inventory);
  expect(
    await ui.browser.evaluate<string>(
      'document.querySelector("[data-principal=human-one]").innerText',
    ),
  ).toContain("access paused");
  await ui.text("Resume access");

  await ui.click("Resume access for Human reader");
  await ui.outcome("core.access.resume", {
    ok: true,
    result: { principalId: "human-one", pausedAt: null },
  });
  await ui.answer("core.access.listCredentials", credentials);
  await ui.answer("core.access.listAgents", {
    agents: [agent],
    truncated: false,
    canRegister: true,
  });
  await ui.answer("core.access.listRuns", inventory);
  expect(
    await ui.browser.evaluate<string>(
      'document.querySelector("[data-principal=human-one]").innerText',
    ),
  ).not.toContain("access paused");
  await ui.text("Pause access");
}, 60_000);

test("native service Sessions identify their owner, open their plugin and never expose Agent or revoke controls", async () => {
  await ui.reset("sessions");
  await ui.answer("core.access.listCredentials", {
    principals: [nativeService, ...credentials.principals],
  });
  // A stale Agent index must not turn a service back into an Agent session.
  await ui.answer("core.access.listAgents", {
    agents: [
      agent,
      { ...agent, agentId: "service-profile", principalId: "service-one", name: "Not an Agent" },
    ],
    truncated: false,
    canRegister: true,
  });
  await ui.answer("core.access.listRuns", inventory);
  await ui.text("Native service · native.accounts.broker · owned by machine-one");
  await ui.answer("engine.services.describeInstance", nativeServiceDescription);
  await ui.text("Native service · native.accounts.broker · owned by Preview hub");
  const serviceText = await ui.browser.evaluate<string>(
    'document.querySelector("[data-principal=service-one]").innerText',
  );
  expect(serviceText).toContain("Plugins");
  expect(serviceText).not.toContain("Agent");
  expect(serviceText).not.toContain("Run");
  expect(
    await ui.browser.evaluate<string[]>(
      '[...document.querySelectorAll("[data-principal=service-one] button")].map(button => button.getAttribute("aria-label"))',
    ),
  ).toEqual([
    "Open native service native.accounts.broker in Plugins",
    "Pause access for Accounts broker",
  ]);
  expect(
    await ui.browser.evaluate<string[]>(
      '[...document.querySelectorAll("[data-action=\\"core.access.revoke\\"]")].map(button => button.closest("[data-principal]").dataset.principal)',
    ),
  ).toEqual(["agent-one", "human-one"]);
  await ui.screenshot("sessions-native-service");
  await ui.click("Open native service native.accounts.broker in Plugins");
  await ui.click("Open Agent Review agent");
  await ui.click("Open run run-one");
  expect(await ui.browser.evaluate<string[]>("window.accessFixture.navigations")).toEqual([
    "manifold://plugin/native.accounts",
    "manifold://agent/profile-one",
    "manifold://run/run-one",
  ]);
  expect(
    await ui.browser.evaluate<boolean>(
      'window.accessFixture.requests.some(request => request.action === "core.access.revoke")',
    ),
  ).toBe(false);
}, 60_000);

test("inactive service Sessions retain their machine identity when Plugins inspection is refused", async () => {
  await ui.reset("sessions");
  await ui.answer("core.access.listCredentials", {
    principals: [{ ...nativeService, sessions: [] }],
  });
  await ui.answer("core.access.listAgents", { agents: [], truncated: false, canRegister: true });
  await ui.answer("core.access.listRuns", { ...inventory, runs: [] });
  await ui.text("No live credentials");
  expect(
    await ui.browser.evaluate<boolean>(
      '!document.querySelector("[data-principal=service-one]").checkVisibility()',
    ),
  ).toBe(true);
  await ui.click("1 inactive identity");
  await ui.outcome("engine.services.describeInstance", {
    ok: false,
    denial: { rule: "forbidden", message: "Service inspection is not authorized" },
  });
  await ui.text("Native service · native.accounts.broker · owned by machine-one");
  await ui.text("Service inspection is not authorized");
  const serviceText = await ui.browser.evaluate<string>(
    'document.querySelector("[data-principal=service-one]").innerText',
  );
  expect(serviceText).not.toContain("Agent");
  expect(serviceText).not.toContain("Run");
  expect(
    await ui.browser.evaluate<number>(
      'document.querySelector("[data-principal=service-one]").querySelectorAll("button").length',
    ),
  ).toBe(0);
}, 60_000);

test("replacement viewers cannot see retained privileged rows or late inspection replies", async () => {
  await ui.boot();
  await ui.detail();
  await ui.click("Inspect run run-one");
  await ui.browser.evaluate<void>(
    'window.accessFixture.replaceViewer("unrelated", ["containers:read"])',
  );
  expect(await ui.browser.evaluate<string>("document.body.innerText")).not.toContain(agent.purpose);
  await ui.outcome("core.access.listAgents", {
    ok: false,
    denial: { rule: "refused", message: "Agent history is unavailable to this principal" },
  });
  await ui.text("Agent history is unavailable to this principal");
  await ui.answer("core.access.inspectRun", inspection);
  expect(await ui.browser.evaluate<string>("document.body.innerText")).not.toContain(agent.purpose);
  expect(
    await ui.browser.evaluate<boolean>(
      `document.querySelector('[data-action="core.access.registerAgent"]') === null`,
    ),
  ).toBe(true);
}, 60_000);

test("a refused harness launch stays visible with explicit cancellation instead of admitting another run", async () => {
  await ui.boot();
  await ui.detail();
  await ui.browser.typeInto(".credential-agent-field input", "machine-one");
  await ui.click("Start run");
  await ui.answer("core.access.createRun", { run: admittedRun });
  await ui.outcome("core.access.launchRun", {
    ok: false,
    denial: { rule: "refused", message: "Harness host is offline" },
  });
  await ui.text("Harness host is offline");
  await ui.text("admitted-run");
  expect(
    await ui.browser.evaluate<boolean>(
      `document.querySelector('[data-action="core.access.createRun"]').disabled`,
    ),
  ).toBe(true);
  await ui.click("Cancel unconfirmed run");
  await ui.outcome("core.access.finishAgentRun", {
    ok: false,
    denial: { rule: "refused", message: "Run cleanup could not be confirmed" },
  });
  await ui.text("Run cleanup could not be confirmed");
  await ui.text("Cancel unconfirmed run");
  expect(await ui.browser.evaluate<number>("window.accessFixture.terminals.length")).toBe(0);
}, 60_000);

test("registration discloses the one-time runner credential and hides it irreversibly", async () => {
  await ui.boot();
  await ui.click("Register");
  await ui.browser.evaluate<void>(
    `(() => { const form = document.querySelector('form[aria-label="Register Agent"]'); form.querySelector('input[name=name]').value = 'Handoff agent'; form.querySelector('input[name=name]').dispatchEvent(new Event('input', { bubbles: true })); form.querySelector('textarea[name=purpose]').value = 'Run the maintenance review loop'; form.querySelector('textarea[name=purpose]').dispatchEvent(new Event('input', { bubbles: true })); form.querySelector('textarea[name=caps]').value = 'containers:read'; form.querySelector('textarea[name=caps]').dispatchEvent(new Event('input', { bubbles: true })); form.querySelector('textarea[name=targets]').value = 'manifold://container/review'; form.querySelector('textarea[name=targets]').dispatchEvent(new Event('input', { bubbles: true })); form.querySelector('input[name=expires]').value = '2030-01-01T00:00'; form.querySelector('input[name=expires]').dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await ui.click("Register Agent");
  await ui.answer("core.access.registerAgent", {
    agent: { ...agent, agentId: "handed-off", name: "Handoff agent" },
    credential: { token: "runner-token-once", expiresAt: at + 3_600_000 },
    created: true,
  });
  await ui.text("Runner credential for Handoff agent");
  expect(
    await ui.browser.evaluate<string>(
      'document.querySelector("[data-testid=agent-credential-token]").value',
    ),
  ).toBe("runner-token-once");
  expect(
    await ui.browser.evaluate<boolean>(
      'document.querySelector("[data-action=\\"core.access.registerAgent\\"]") === null',
    ),
  ).toBe(true);
  await ui.browser.evaluate<void>(
    `Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } })`,
  );
  await ui.click("Copy");
  await ui.text("Clipboard access failed.");
  await ui.screenshot("registration-credential-handoff");
  await ui.click("Hide credential");
  expect(
    await ui.browser.evaluate<boolean>(
      'document.querySelector("[data-testid=agent-credential]") === null',
    ),
  ).toBe(true);
  expect(
    await ui.browser.evaluate<boolean>(
      'document.querySelector("[data-action=\\"core.access.registerAgent\\"]") === null',
    ),
  ).toBe(false);
}, 60_000);

test("a repeat registration without a credential keeps the Agent view credential-free", async () => {
  await ui.boot();
  await ui.click("Register");
  await ui.browser.evaluate<void>(
    `(() => { const form = document.querySelector('form[aria-label="Register Agent"]'); form.querySelector('input[name=name]').value = 'Repeat agent'; form.querySelector('input[name=name]').dispatchEvent(new Event('input', { bubbles: true })); form.querySelector('textarea[name=purpose]').value = 'Already registered'; form.querySelector('textarea[name=purpose]').dispatchEvent(new Event('input', { bubbles: true })); form.querySelector('textarea[name=caps]').value = 'containers:read'; form.querySelector('textarea[name=caps]').dispatchEvent(new Event('input', { bubbles: true })); form.querySelector('textarea[name=targets]').value = 'manifold://container/review'; form.querySelector('textarea[name=targets]').dispatchEvent(new Event('input', { bubbles: true })); form.querySelector('input[name=expires]').value = '2030-01-01T00:00'; form.querySelector('input[name=expires]').dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await ui.click("Register Agent");
  await ui.answer("core.access.registerAgent", {
    agent: { ...agent, agentId: "handed-off", name: "Repeat agent" },
    created: false,
  });
  await ui.answer("core.access.listAgents", {
    agents: [{ ...agent, agentId: "handed-off", name: "Repeat agent" }],
    truncated: false,
    canRegister: true,
  });
  await ui.text("Repeat agent");
  expect(
    await ui.browser.evaluate<boolean>(
      'document.querySelector("[data-testid=agent-credential]") === null',
    ),
  ).toBe(true);
}, 60_000);

test("workspace authority hints govern profile controls without a joined room", async () => {
  await ui.boot();
  await ui.browser.evaluate<void>("window.accessFixture.leaveRoom()");
  await ui.boot();
  await ui.click("Register");
  await ui.text("Harness profile (JSON)");
  await ui.detail();
  await ui.text("Disable");
  expect(
    await ui.browser.evaluate<boolean>(
      `document.querySelector('[data-action="core.access.createRun"]').disabled`,
    ),
  ).toBe(true);
  await ui.browser.evaluate<void>("window.accessFixture.emitAccess()");
  await ui.answer("core.access.listAgents", {
    agents: [agent],
    truncated: false,
    canRegister: false,
  });
  await ui.answer("core.access.getAgent", { agent, canManage: false });
  await ui.text("Only the sponsor can manage this Agent.");
  expect(
    await ui.browser.evaluate<boolean>(
      `document.querySelector('form[aria-label="Register Agent"]') === null &&
       document.querySelector('[data-action="core.access.disableAgent"]') === null`,
    ),
  ).toBe(true);
}, 60_000);
