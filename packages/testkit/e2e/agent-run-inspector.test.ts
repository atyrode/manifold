import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  AccessBrowser,
  agent,
  inspection,
  scheduledJobUri,
} from "../../plugins/access/test/web-fixture.ts";

const ui = new AccessBrowser();
beforeAll(() => ui.start(), 60_000);
beforeEach(async () => {
  await ui.reset();
  await ui.boot();
}, 60_000);
afterEach(() => {
  expect(ui.browser.drainMessages().filter((message) => message.level === "error")).toEqual([]);
});
afterAll(() => ui.close());

test("Agents lead to delegated run trees, safe snapshots and native trace references", async () => {
  await ui.detail();
  expect(
    await ui.browser.evaluate<boolean>(
      `document.querySelector('[aria-label="Inspect run run-one"]').closest("ul").parentElement.closest("li").querySelector('[aria-label="Inspect run run-root"]') !== null`,
    ),
  ).toBe(true);
  await ui.text("3 actions · 1 refusals");
  await ui.click("Inspect run run-one");
  await ui.answer("core.access.inspectRun", inspection);
  await ui.text(agent.purpose);
  await ui.text("conversation-one");
  await ui.text("review-model");
  await ui.text("cleanup_failed");
  await ui.text("pending_or_crashed");
  await ui.click("Trace 9007199254740993");
  await ui.answer("core.access.inspectRun", { ...inspection, requestedTrace: "available" });
  await ui.text("Checking retained workspace facts");
  expect(
    await ui.browser.evaluate<boolean>(
      `[...document.querySelectorAll("button,a")].some(node => node.getAttribute("aria-label") === ${JSON.stringify(`Open ${scheduledJobUri}`)})`,
    ),
  ).toBe(false);
  await ui.click("Jobs · 1");
  await ui.text("unconfirmed");
  await ui.click("Trace 9007199254740997");
  await ui.answer("core.access.inspectRun", {
    ...inspection,
    traces: [],
    requestedTrace: "unavailable",
  });
  await ui.text("Its outcome is not known");
  await ui.click("Open manifold://terminal/terminal-one");
  expect(await ui.browser.evaluate<string[]>("window.accessFixture.navigations")).toEqual([
    "manifold://terminal/terminal-one",
  ]);
  await ui.click("Run lineage · 2");
  await ui.click("Inspect run Parent run");
  await ui.outcome("core.access.inspectRun", {
    ok: false,
    denial: { rule: "refused", message: "Run inspection unavailable" },
  });
  await ui.text("Run inspection unavailable");
  expect(
    await ui.browser.evaluate<string>(
      `document.querySelector('[aria-label="Run inspection"]').innerText`,
    ),
  ).not.toContain("conversation-one");
}, 60_000);

test("changing runs discards a late snapshot and renders the exact refusal of the new request", async () => {
  await ui.detail();
  await ui.click("Inspect run run-one");
  await ui.click("Inspect run run-root");
  const pending = await ui.browser.evaluate<readonly { id: number; args: { runId: string } }[]>(
    'window.accessFixture.pending().filter(request => request.action === "core.access.inspectRun")',
  );
  const root = pending.find((request) => request.args.runId === "run-root");
  const previous = pending.find((request) => request.args.runId === "run-one");
  if (root === undefined || previous === undefined)
    throw new Error("Run reads were not dispatched");
  await ui.browser.evaluate<void>(
    `window.accessFixture.answer(${String(root.id)}, { ok: false, denial: { rule: "refused", message: "Run history is not available to this principal" } })`,
  );
  await ui.text("Run history is not available to this principal");
  await ui.browser.evaluate<void>(
    `window.accessFixture.answer(${String(previous.id)}, ${JSON.stringify({ ok: true, result: inspection })})`,
  );
  expect(
    await ui.browser.evaluate<string>(
      `document.querySelector('[aria-label="Run inspection"]').innerText`,
    ),
  ).not.toContain("conversation-one");
}, 60_000);

test("run notifications refresh activity without closing the open inspection", async () => {
  await ui.detail();
  await ui.click("Inspect run run-one");
  await ui.answer("core.access.inspectRun", inspection);
  await ui.click("Jobs · 1");
  await ui.text("unconfirmed");
  await ui.browser.evaluate<void>("window.accessFixture.emitAccess()");
  await ui.answer("core.access.inspectRun", {
    ...inspection,
    run: { ...inspection.run, activity: "done" },
  });
  await ui.text("done");
  expect(
    await ui.browser.evaluate<string>(
      `document.querySelector('[aria-label="Run inspection"]').innerText`,
    ),
  ).toContain("unconfirmed");
}, 60_000);
