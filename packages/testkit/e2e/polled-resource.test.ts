import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Browser } from "../../../scripts/cdp.ts";
import { sleep, until } from "../../../scripts/gate-lib.ts";
import type { FeedRead } from "../../plugin/test/fixtures/polled-resource-contract.ts";

// Real React DOM and the SDK hook, driven through the existing system-Chromium harness.
// No workspace server, production test seam, or additional renderer dependency is involved.
const browser = new Browser();
let scratch = "";
let server: Bun.Server<undefined> | undefined;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "manifold-feed-ownership-"));
  const plugin = resolve(import.meta.dir, "../../plugin");
  const bundle = join(scratch, "fixture.js");
  // Like the installed-plugin e2e fixture, bundle in a separate process so Bun's isolated
  // linker resolves this entry's React peers from its own package rather than the test runner.
  const build = Bun.spawn(
    ["bun", "build", "test/fixtures/polled-resource.tsx", "--target=browser", "--outfile", bundle],
    { cwd: plugin, stdout: "pipe", stderr: "pipe" },
  );
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
      if (new URL(request.url).pathname === "/fixture.js") {
        return new Response(Bun.file(bundle), { headers: { "Content-Type": "text/javascript" } });
      }
      return new Response(
        '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/fixture.js"></script>',
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  await browser.launch({ incognito: true });
}, 60_000);

async function openFixture(initialStatus = "open"): Promise<void> {
  if (server === undefined) throw new Error("Fixture server did not start");
  await browser.goto(`http://127.0.0.1:${String(server.port)}/?initialStatus=${initialStatus}`);
  await until(
    () => browser.evaluate<boolean>('document.querySelectorAll("[data-reader]").length === 2'),
    5_000,
    "two mounted hook consumers",
  );
}

beforeEach(() => openFixture());

afterEach(() => {
  expect(browser.drainMessages().filter((message) => message.level === "error")).toEqual([]);
});

afterAll(async () => {
  await browser.close();
  await server?.stop(true);
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
});

async function reads(count: number): Promise<readonly FeedRead[]> {
  await until(
    () =>
      browser.evaluate<boolean>(`window.polledResourceFixture.requests.length >= ${String(count)}`),
    5_000,
    `feed request ${String(count)}`,
  );
  const result = await browser.evaluate<readonly FeedRead[]>(
    "window.polledResourceFixture.requests",
  );
  expect(result).toHaveLength(count);
  return result;
}

async function text(testId: string, expected: string): Promise<void> {
  const expression = `document.querySelector(${JSON.stringify(`[data-testid="${testId}"]`)})?.textContent`;
  await until(
    () => browser.evaluate<string>(expression).then((value) => value === expected),
    5_000,
    `${testId} shows ${expected}`,
  );
  expect(await browser.evaluate<string>(expression)).toBe(expected);
}

async function answer(id: number, value: string): Promise<void> {
  await browser.evaluate(
    `window.polledResourceFixture.resolve(${String(id)}, ${JSON.stringify(value)})`,
  );
}

test("retargeting the first shared reader keeps both destinations and committed callbacks independent", async () => {
  expect(await reads(1)).toEqual([{ id: 1, reader: "first", destination: "A", revision: 0 }]);
  await browser.typeInto('[aria-label="first draft"]', "unfinished editor");
  await browser.clickTestId("first-retarget");
  expect((await reads(2))[1]).toEqual({ id: 2, reader: "first", destination: "B", revision: 0 });
  await text("first-value", "loading:B");
  await text("second-value", "loading:A");

  // A's request was issued by the reader now displaying B. It still belongs to A, and
  // neither its data nor its success callback may land in that departing reader.
  await answer(1, "old-flight");
  await text("second-value", "A:old-flight");
  await text("first-value", "loading:B");
  await text("second-accepted", "1");
  await text("first-accepted", "0");
  await answer(2, "initial");
  await text("first-value", "B:initial");
  await sleep(100);
  await reads(2); // A's second initial subscriber must not have queued another request.

  await browser.clickTestId("second-revision");
  await browser.clickTestId("second-refresh");
  expect((await reads(3))[2]).toEqual({ id: 3, reader: "second", destination: "A", revision: 1 });
  await answer(3, "fresh");
  await text("second-value", "A:fresh");
  await text("first-value", "B:initial");
  await text("second-status", "ok:A:1");

  // The new callback and socket arrive in the SAME React commit. Rebinding must use that
  // callback without a subscription restart or a stale passive-effect read.
  await browser.clickTestId("first-rebind");
  expect((await reads(4))[3]).toEqual({ id: 4, reader: "first", destination: "B", revision: 1 });
  await answer(4, "rebound");
  await text("first-value", "B:rebound");
  expect(
    await browser.evaluate<[string, number][]>("window.polledResourceFixture.subscriptions()"),
  ).toEqual([
    ["A:0", 1],
    ["B:1", 1],
  ]);
  await browser.evaluate('window.polledResourceFixture.event("B:0")');
  await sleep(100);
  await reads(4);

  // B's current hold must not hold A after the ownership handoff.
  await browser.clickTestId("first-holding");
  await browser.evaluate(
    'window.polledResourceFixture.event("A:0"); window.polledResourceFixture.event("B:1")',
  );
  expect((await reads(5))[4]).toEqual({ id: 5, reader: "second", destination: "A", revision: 1 });
  await answer(5, "event");
  await text("second-value", "A:event");
  await text("first-value", "B:rebound");
  await browser.clickTestId("first-holding");
  expect((await reads(6))[5]).toEqual({ id: 6, reader: "first", destination: "B", revision: 1 });
  await answer(6, "live");
  await text("first-value", "B:live");

  // Equality is late-bound too. Suppressing a changed value still reports an accepted
  // response, and an equal response after a failure must report recovery.
  await browser.clickTestId("first-equal");
  await browser.clickTestId("first-refresh");
  await reads(7);
  await answer(7, "equal-by-policy");
  await text("first-accepted", "4");
  await text("first-value", "B:live");
  await browser.clickTestId("first-refresh");
  await reads(8);
  await browser.evaluate("window.polledResourceFixture.reject(8)");
  await text("first-status", "error:B:1");
  await text("second-status", "ok:A:1");
  await text("first-value", "B:live");
  await text("second-value", "A:event");
  await browser.clickTestId("first-refresh");
  await reads(9);
  await answer(9, "live");
  await text("first-status", "ok:B:1");
  await text("first-accepted", "5");
  await browser.clickTestId("first-equal");
  await browser.clickTestId("first-refresh");
  await reads(10);
  await answer(10, "different");
  await text("first-value", "B:different");
  await text("second-value", "A:event");
  expect(
    await browser.evaluate<string>(
      'document.querySelector("[aria-label=\\"first draft\\"]").value',
    ),
  ).toBe("unfinished editor");
  await sleep(100);
  await reads(10);
}, 60_000);

test("a quiet new live binding catches mutations missed by pending snapshots", async () => {
  await openFixture("connecting");
  await reads(1);
  await browser.typeInto('[aria-label="second draft"]', "keep this draft");
  await browser.clickTestId("second-enabled");
  await browser.clickTestId("second-rebind");
  // The initial request has already captured A:initial. This mutation emits no event, and
  // the joining reader's different, already-open door cannot replay what it missed.
  await browser.evaluate('window.polledResourceFixture.mutate("A", "between-bindings")');
  await browser.clickTestId("second-enabled");
  await reads(1);
  await browser.evaluate("window.polledResourceFixture.resolve(1)");
  await text("first-value", "A:initial");
  await text("second-value", "A:initial");
  await reads(2);

  // Change a live binding again while its catch-up is pending. Completing that read must
  // neither clear the newer gap nor pretend its older snapshot covers the new subscription.
  await browser.evaluate('window.polledResourceFixture.mutate("A", "during-catch-up")');
  await browser.clickTestId("second-rebind");
  await reads(2);
  await browser.evaluate("window.polledResourceFixture.resolve(2)");
  await text("first-value", "A:between-bindings");
  await text("second-value", "A:between-bindings");
  await reads(3);
  await browser.evaluate("window.polledResourceFixture.resolve(3)");
  await text("first-value", "A:during-catch-up");
  await text("second-value", "A:during-catch-up");
  await text("first-accepted", "3");
  await text("second-accepted", "3");
  expect(
    await browser.evaluate<string>(
      'document.querySelector("[aria-label=\\"second draft\\"]").value',
    ),
  ).toBe("keep this draft");
  await sleep(100);
  await reads(3);
}, 60_000);

test("old completions cannot cross a last-reader teardown or replace a new generation of the same key", async () => {
  await reads(1);
  await browser.clickTestId("first-retarget");
  await reads(2);
  await browser.clickTestId("second-retarget");
  await reads(2); // Joining B while its first request is pending remains one request.
  await browser.clickTestId("first-retarget");
  expect((await reads(3))[2]).toEqual({ id: 3, reader: "first", destination: "A", revision: 0 });

  // A has no surviving original readers. Re-entering A creates a new generation, while
  // B's pending read remains valid even though the component that issued it returned to A.
  await answer(1, "obsolete");
  await sleep(100);
  await text("first-value", "loading:A");
  await text("first-accepted", "0");
  await text("second-value", "loading:B");
  await text("second-accepted", "0");
  await answer(2, "surviving");
  await text("second-value", "B:surviving");
  await text("first-value", "loading:A");
  await answer(3, "replacement");
  await text("first-value", "A:replacement");
  await sleep(100);
  await reads(3);

  await browser.clickTestId("second-refresh");
  expect((await reads(4))[3]).toEqual({ id: 4, reader: "second", destination: "B", revision: 0 });
  await browser.clickTestId("first-refresh");
  expect((await reads(5))[4]).toEqual({ id: 5, reader: "first", destination: "A", revision: 0 });
  await browser.clickTestId("first-enabled");
  await browser.clickTestId("second-enabled");
  expect(
    await browser.evaluate<[string, number][]>("window.polledResourceFixture.subscriptions()"),
  ).toEqual([]);
  await answer(4, "after-teardown");
  await browser.evaluate("window.polledResourceFixture.reject(5)");
  await sleep(100);
  await text("first-status", "ok:A:0");
  await text("second-status", "ok:B:0");
  await text("first-accepted", "1");
  await text("second-accepted", "1");
  await browser.evaluate(
    'window.polledResourceFixture.event("A:0"); window.polledResourceFixture.event("B:0")',
  );
  await sleep(100);
  await reads(5);
}, 60_000);

for (const initialOnline of [false, true]) {
  test(`mounted machine readers lose ${initialOnline ? "online" : "offline"} confirmation on disable and catch up on re-enable`, async () => {
    if (server === undefined) throw new Error("Fixture server did not start");
    await browser.goto(
      `http://127.0.0.1:${String(server.port)}/?scenario=machines&initialOnline=${String(initialOnline)}`,
    );
    await until(
      () =>
        browser.evaluate<boolean>(
          'document.querySelectorAll("[data-inventory-reader]").length === 3',
        ),
      5_000,
      "mounted canvas, composition and fleet readers",
    );
    await browser.evaluate(
      'window.retainedInventoryReaders = [...document.querySelectorAll("[data-inventory-reader]")]; undefined',
    );
    const request = async (count: number, enabled: boolean, online: boolean): Promise<void> => {
      await until(
        () =>
          browser.evaluate<boolean>(
            `window.inventoryFeedFixture.requests.length >= ${String(count)}`,
          ),
        5_000,
        `machine inventory read ${String(count)}`,
      );
      const requests = await browser.evaluate<
        readonly { id: number; enabled: boolean; online: boolean }[]
      >("window.inventoryFeedFixture.requests");
      expect(requests).toHaveLength(count);
      expect(requests[count - 1]).toEqual({ id: count, enabled, online });
    };
    const inventory = async (value: string, failure: string, mode: string): Promise<void> => {
      for (const name of ["canvas", "composition", "fleet"]) {
        await text(`${name}-inventory`, value);
        await text(`${name}-failure`, failure);
      }
      expect(
        await browser.evaluate<{ mode: string; subscribers: number }>(
          `(() => {
            const { mode, subscribers } = window.inventoryFeedFixture.report()[0];
            return { mode, subscribers };
          })()`,
        ),
      ).toEqual({ mode, subscribers: 3 });
      expect(
        await browser.evaluate<boolean>(
          `window.retainedInventoryReaders.every((node, index) =>
            node === document.querySelectorAll("[data-inventory-reader]")[index])`,
        ),
      ).toBe(true);
    };

    await request(1, true, initialOnline);
    await browser.evaluate("window.inventoryFeedFixture.finish(1)");
    await inventory(initialOnline ? "online" : "offline", "readable", "events");

    // Only the roster topic changes. The machine's own declarations still exist, and all
    // readers stay mounted: a last-reader cache eviction cannot hide stale confirmation.
    await browser.evaluate("window.inventoryFeedFixture.setEnabled(false)");
    await request(2, false, initialOnline);
    await browser.evaluate("window.inventoryFeedFixture.finish(2)");
    await inventory("UNKNOWN", "plugin_disabled", "timer");

    // Reality changes behind the ordinary refused door. No reader may turn the refusal
    // into a successful empty list or keep the earlier online/offline determination.
    await browser.evaluate(`window.inventoryFeedFixture.setOnline(${String(!initialOnline)})`);
    await request(3, false, !initialOnline);
    await browser.evaluate("window.inventoryFeedFixture.finish(3)");
    await inventory("UNKNOWN", "plugin_disabled", "timer");

    await browser.evaluate("window.inventoryFeedFixture.setEnabled(true)");
    await request(4, true, !initialOnline);
    // Eligibility and a live socket alone cannot retire polling or republish old rows.
    await inventory("UNKNOWN", "plugin_disabled", "timer");
    await browser.evaluate("window.inventoryFeedFixture.finish(4)");
    await inventory(initialOnline ? "offline" : "online", "readable", "events");
    await sleep(100);
    await request(4, true, !initialOnline);
  }, 60_000);
}
