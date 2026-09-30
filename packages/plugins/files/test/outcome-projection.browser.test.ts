import { expect, test } from "bun:test";
import type { Browser } from "../../../../scripts/cdp.ts";
import { until } from "../../../../scripts/gate-lib.ts";
import {
  checkpoint,
  click,
  reviewDelivery,
  withOutcomeProjection,
} from "./outcome-projection.browser-fixture.ts";

async function nativeState(browser: Browser) {
  await checkpoint(browser);
  return browser.evaluate<{
    unknown: boolean;
    reset: boolean;
    commit: boolean;
    text: string;
    begins: { requestId: string }[];
    receipts: { requestId: string }[];
  }>(`({
    unknown: document.body.innerText.includes("Outcome unknown."),
    reset: [...document.querySelectorAll("button")].some(button => button.textContent === "Review a new deliberate operation" && !button.disabled),
    commit: [...document.querySelectorAll("button")].some(button => button.textContent === "Confirm exclusive placement" && !button.disabled),
    text: document.body.innerText,
    begins: fixture.log.filter(row => row[0] === "beginDelivery").map(row => row[1]),
    receipts: fixture.log.filter(row => row[0] === "receiptNative").map(row => row[1]),
  })`);
}

test("later source or authority denials retain an ambiguous begin until terminal evidence", async () => {
  for (const terminal of ["completed", "cancelled", "failed", "expired", "refused"]) {
    await withOutcomeProjection(async (browser) => {
      await reviewDelivery(browser);
      await browser.evaluate('fixture.hold("beginDelivery")');
      await click(browser, "Deliver to machine");
      await until(
        () => browser.evaluate<boolean>('fixture.waiting("beginDelivery")'),
        5_000,
        "withheld begin acknowledgement",
      );
      await browser.evaluate('fixture.release("beginDelivery")');
      const ambiguous = await nativeState(browser);
      expect(ambiguous.unknown).toBe(true);
      expect(ambiguous.reset).toBe(false);
      const request = ambiguous.begins[0];
      expect(request).toBeDefined();
      for (const mode of ["source-deleted", "denied"]) {
        await browser.evaluate(`fixture.mode("begin", ${JSON.stringify(mode)})`);
        await click(browser, "Retry exact begin request");
        const denied = await nativeState(browser);
        expect(denied.unknown).toBe(true);
        expect(denied.reset).toBe(false);
        expect(denied.begins.at(-1)).toEqual(request);
        expect(denied.text).toContain(`Exact request ${request?.requestId};`);
      }
      for (const state of ["outcome_unknown", "denied"]) {
        await browser.evaluate(`fixture.mode("receipt", ${JSON.stringify(state)})`);
        await click(browser, "Reconcile terminal evidence only");
        const pending = await nativeState(browser);
        expect(pending.unknown).toBe(true);
        expect(pending.reset).toBe(false);
        expect(pending.receipts.at(-1)).toEqual({ requestId: request?.requestId });
      }
      await browser.evaluate(`fixture.mode("receipt", ${JSON.stringify(terminal)})`);
      await click(browser, "Reconcile terminal evidence only");
      const reconciled = await nativeState(browser);
      expect(reconciled.unknown).toBe(false);
      expect(reconciled.reset).toBe(true);
      expect(reconciled.text).toContain(`Exact request ${request?.requestId};`);
      await click(browser, "Review a new deliberate operation");
      expect((await nativeState(browser)).text).not.toContain("Exact request ");
    });
  }
}, 60_000);

test("authoritative active recovery replaces an unknown receipt without enabling replacement or commit replay", async () => {
  await withOutcomeProjection(async (browser) => {
    await reviewDelivery(browser);
    await click(browser, "Deliver to machine");
    expect((await nativeState(browser)).unknown).toBe(true);
    await click(browser, "Reconcile terminal evidence only");
    expect((await nativeState(browser)).unknown).toBe(true);
    await browser.evaluate('fixture.mode("begin", "receiving")');
    await click(browser, "Retry exact begin request");
    const active = await nativeState(browser);
    expect(active.unknown).toBe(false);
    expect(active.reset).toBe(false);
    expect(active.commit).toBe(true);
    expect(active.begins[1]).toEqual(active.begins[0]);
    await click(browser, "Confirm exclusive placement");
    expect((await nativeState(browser)).unknown).toBe(true);
    await browser.evaluate('fixture.mode("inspect", "denied")');
    await click(browser, "Reconcile exact transfer");
    const denied = await nativeState(browser);
    expect(denied.unknown).toBe(true);
    expect(denied.reset).toBe(false);
    expect(denied.commit).toBe(false);
    await browser.evaluate('fixture.mode("inspect", "receiving")');
    await click(browser, "Reconcile exact transfer");
    const recovered = await nativeState(browser);
    expect(recovered.unknown).toBe(false);
    expect(recovered.reset).toBe(false);
    expect(recovered.commit).toBe(false);
    await browser.evaluate('fixture.mode("inspect", "cancelled")');
    await click(browser, "Reconcile exact transfer");
    const terminal = await nativeState(browser);
    expect(terminal.unknown).toBe(false);
    expect(terminal.reset).toBe(true);
    expect(
      await browser.evaluate<number>(
        'fixture.log.filter(row => row[0] === "commitDelivery").length',
      ),
    ).toBe(1);
  });
}, 60_000);

test("retired queued image effects acquire nothing while the active successor waits for release", async () => {
  for (const remove of [true, false]) {
    await withOutcomeProjection(async (browser) => {
      await browser.evaluate('fixture.mount("image", true)');
      await until(
        () => browser.evaluate<boolean>('fixture.log.some(row => row[0] === "project")'),
        5_000,
        "StrictMode image projection",
      );
      expect(await browser.evaluate<number>("fixture.mounts")).toBe(2);
      expect(
        await browser.evaluate<number>('fixture.log.filter(row => row[0] === "openRead").length'),
      ).toBe(1);
      await browser.evaluate('fixture.hold("cancelRead")');
      await click(browser, "Reopen image source");
      await until(
        () => browser.evaluate<boolean>('fixture.waiting("cancelRead")'),
        5_000,
        "predecessor release",
      );
      await click(browser, "Reopen image source");
      await checkpoint(browser);
      expect(await browser.evaluate<number>('document.querySelectorAll("img").length')).toBe(0);
      expect(
        await browser.evaluate<number>('fixture.log.filter(row => row[0] === "openRead").length'),
      ).toBe(1);
      if (remove) await browser.evaluate("fixture.remove()");
      await browser.evaluate('fixture.release("cancelRead")');
      await checkpoint(browser);
      expect(
        await browser.evaluate<unknown[]>(
          'Array.from(new Set(fixture.log.filter(row => row[0] === "project").map(row => row[1])))',
        ),
      ).toEqual(remove ? ["read-1"] : ["read-1", "read-2"]);
      expect(
        await browser.evaluate<number>('fixture.log.filter(row => row[0] === "openRead").length'),
      ).toBe(remove ? 1 : 2);
      await browser.evaluate("fixture.remove()");
      await checkpoint(browser);
      expect(
        await browser.evaluate<unknown[]>(
          'fixture.log.filter(row => row[0] === "cancelRead").map(row => row[1].transferId)',
        ),
      ).toEqual(remove ? ["read-1"] : ["read-1", "read-2"]);
    });
  }
}, 60_000);

test("an already dispatched image open is released once without stale publication after removal", async () => {
  await withOutcomeProjection(async (browser) => {
    await browser.evaluate('fixture.hold("openRead"); fixture.mount("image", true)');
    await until(
      () => browser.evaluate<boolean>('fixture.waiting("openRead")'),
      5_000,
      "withheld read acquisition",
    );
    await browser.evaluate('fixture.remove(); fixture.release("openRead")');
    await checkpoint(browser);
    expect(
      await browser.evaluate<unknown[]>(
        'fixture.log.filter(row => row[0] === "project" || row[0] === "cancelRead").map(row => [row[0], row[1].transferId])',
      ),
    ).toEqual([["cancelRead", "read-1"]]);
    expect(await browser.evaluate<string>("document.body.innerText")).toBe("");
  });
}, 60_000);
