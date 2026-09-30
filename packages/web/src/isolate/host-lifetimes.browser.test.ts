import { expect, test } from "bun:test";
import { Browser } from "../../../../scripts/cdp.ts";
import { serveHostLifetimes } from "./host-lifetimes.fixture.ts";

// A real Worker commits asynchronously; observe that browser boundary rather than fake its clock.
async function until(browser: Browser, condition: string): Promise<void> {
  await browser.evaluate(`(async () => {
    const end = Date.now() + 5000;
    while (!(${condition})) {
      if (Date.now() > end) throw new Error("lifetime fixture condition timeout: " + document.body.textContent);
      const delay = Promise.withResolvers(); setTimeout(delay.resolve, 10); await delay.promise;
    }
  })()`);
}

async function press(browser: Browser, label: string): Promise<void> {
  const match = `Array.from(document.querySelectorAll("button")).find(button => button.textContent === ${JSON.stringify(label)})`;
  await until(browser, `${match} !== undefined`);
  await browser.evaluate(`${match}.click()`);
}

interface Counts {
  readonly results: readonly { readonly state: string }[];
  readonly pending: number;
  readonly owners: readonly string[];
}

test("committed page and Worker intakes fence selection and results across retirement", async () => {
  const fixture = await serveHostLifetimes();
  const browser = new Browser();
  try {
    await browser.launch({ incognito: true });
    await browser.goto(fixture.origin);
    expect(await browser.evaluate<number>("window.fixture.speculative()")).toBe(0);
    expect(await browser.evaluate<string>("document.body.textContent")).toContain("Suspended");
    for (const mode of ["page", "worker"]) {
      await browser.evaluate(`window.fixture.mount(${JSON.stringify(mode)})`);
      await press(browser, "Read selection");
      await until(browser, 'document.querySelector(\'[data-testid="read"]\')?.textContent === "private selection"');
      await press(browser, "Hold completion");
      await until(browser, "window.fixture.counts().pending === 1");
      await browser.evaluate("window.fixture.recompose()");
      await press(browser, "Cancel intake");
      await until(browser, "window.fixture.counts().results.length === 1");
      await browser.evaluate("window.fixture.recompose()");
      await browser.evaluate("window.fixture.completePending()");
      await press(browser, "Complete intake");
      expect((await browser.evaluate<Counts>("window.fixture.counts()")).results).toEqual([
        { state: "cancelled" },
      ]);
      for (const field of ["token", "container", "principal", "client", "input", "unmount"]) {
        await browser.evaluate(`window.fixture.mount(${JSON.stringify(mode)})`);
        await press(browser, "Read selection");
        await until(browser, 'document.querySelector(\'[data-testid="read"]\')?.textContent === "private selection"');
        await press(browser, "Hold completion");
        await until(browser, "window.fixture.counts().pending === 1");
        await browser.evaluate(
          field === "unmount"
            ? "window.fixture.unmount()"
            : `window.fixture.change(${JSON.stringify(field)})`,
        );
        if (field !== "input" && field !== "unmount")
          await browser.evaluate("window.fixture.restoreHost()");
        await browser.evaluate("window.fixture.completePending()");
        const custody = await browser.evaluate<string[]>("window.fixture.custody()");
        // StrictMode may acquire more than once, but only the current input can retain custody.
        expect(custody.slice(0, -1).every((result) => result === "unavailable")).toBe(true);
        expect(custody.at(-1)).toBe(field === "input" ? "private selection" : "unavailable");
        expect((await browser.evaluate<Counts>("window.fixture.counts()")).results).toEqual([]);
        if (field === "input") {
          await press(browser, "Complete intake");
          await until(browser, "window.fixture.counts().results.length === 1");
          expect((await browser.evaluate<Counts>("window.fixture.counts()")).results).toEqual([
            { state: "completed" },
          ]);
        }
      }
    }
    await browser.evaluate("window.fixture.close()");
  } finally {
    await browser.close();
    await fixture.close();
  }
}, 60_000);

test("borrowed subtrees share four committed slots and reject cycles in both owners", async () => {
  const fixture = await serveHostLifetimes();
  const browser = new Browser();
  try {
    await browser.launch({ incognito: true });
    await browser.goto(fixture.origin);
    for (const mode of ["page", "worker"]) {
      await browser.evaluate(`window.fixture.mount(${JSON.stringify(mode)}, "budget")`);
      await until(browser, "window.fixture.counts().owners.length === 4");
      expect((await browser.evaluate<Counts>("window.fixture.counts()")).owners).toEqual([
        "a", "b", "c", "sibling",
      ]);
      const completions = 'Array.from(document.querySelectorAll("button")).filter(button => button.textContent === "Complete intake")';
      await browser.evaluate(`${completions}[2].click()`);
      await until(browser, "window.fixture.counts().results.length === 1");
      await browser.evaluate("window.fixture.recompose()");
      await browser.evaluate(`${completions}[2].click(); ${completions}[3].click()`);
      await until(browser, "window.fixture.counts().results.length === 2");
      // The nested intake may answer once; its independent sibling may still answer separately.
      expect((await browser.evaluate<Counts>("window.fixture.counts()")).results).toEqual([
        { state: "completed" },
        { state: "completed" },
      ]);
      await browser.evaluate("window.fixture.branch(false)");
      await until(browser, "window.fixture.counts().owners.length === 1");
      await browser.evaluate("window.fixture.branch(true)");
      await until(browser, "window.fixture.counts().owners.length === 4");
      expect((await browser.evaluate<Counts>("window.fixture.counts()")).owners).toEqual([
        "a", "b", "c", "sibling",
      ]);
      await browser.evaluate(`window.fixture.mount(${JSON.stringify(mode)}, "cycle")`);
      await until(browser, 'document.body.textContent.includes("recursive borrowing")');
      expect((await browser.evaluate<Counts>("window.fixture.counts()")).owners).toEqual(["a"]);
    }
    await browser.evaluate("window.fixture.close()");
  } finally {
    await browser.close();
    await fixture.close();
  }
}, 60_000);

test("retained portable edits cannot act after committed owner or source replacement", async () => {
  const fixture = await serveHostLifetimes();
  const browser = new Browser();
  try {
    await browser.launch({ incognito: true });
    await browser.goto(fixture.origin);
    await browser.evaluate('window.fixture.mount("page", "edit")');
    expect(await browser.evaluate<string>("window.fixture.edit()")).toBe("edited");
    for (const field of ["token", "principal", "container", "client", "element", "unmount"]) {
      await browser.evaluate('window.fixture.mount("page", "edit")');
      expect(
        await browser.evaluate<{ refused: boolean; source: string }>(
          `window.fixture.editRetirement(${JSON.stringify(field)})`,
        ),
      ).toEqual({ refused: true, source: "source" });
    }
    await browser.evaluate("window.fixture.close()");
  } finally {
    await browser.close();
    await fixture.close();
  }
}, 60_000);

test("a recomposed intake delivers layout completion to its current committed callback", async () => {
  const fixture = await serveHostLifetimes();
  const browser = new Browser();
  try {
    await browser.launch({ incognito: true });
    await browser.goto(fixture.origin);
    for (const strict of [false, true]) {
      await browser.evaluate(`window.fixture.mount("page", "layout", ${strict})`);
      expect(await browser.evaluate<string>("document.body.textContent")).toContain(
        "Waiting for layout completion",
      );
      await browser.evaluate("window.fixture.completeInLayout()");
      expect(await browser.evaluate<number>("window.fixture.layoutSetups()")).toBe(strict ? 2 : 1);
      expect((await browser.evaluate<Counts>("window.fixture.counts()")).results).toEqual([
        { state: "completed", callbackVersion: 1 },
      ]);
      await browser.evaluate("window.fixture.completeInLayout()");
      expect((await browser.evaluate<Counts>("window.fixture.counts()")).results).toEqual([
        { state: "completed", callbackVersion: 1 },
      ]);
    }
    await browser.evaluate("window.fixture.close()");
  } finally {
    await browser.close();
    await fixture.close();
  }
}, 60_000);
