import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Agent } from "@manifold/protocol";
import {
  AccessBrowser,
  admittedRun,
  agent,
  credentials,
  inspection,
  inventory,
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
