import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Browser } from "../../../../scripts/cdp.ts";
import { sleep, until } from "../../../../scripts/gate-lib.ts";

type FontResponse = 200 | 503;

interface FontFixture {
  readonly browser: Browser;
  readonly requests: () => number;
  readonly respond: (status: FontResponse) => void;
}

async function withFontFixture(run: (fixture: FontFixture) => Promise<void>): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "manifold-terminal-font-"));
  const browser = new Browser();
  let server: Bun.Server<undefined> | undefined;
  let response: FontResponse | undefined;
  let requests = 0;
  const pending = new Set<(response: Response) => void>();
  const font = Bun.file(resolve(import.meta.dir, "fonts/manifold-terminal-mono.woff2"));
  const fontResponse = (status: FontResponse): Response =>
    new Response(status === 200 ? font : "temporarily unavailable", {
      status,
      headers: { "Content-Type": "font/woff2", "Cache-Control": "no-store" },
    });
  const respond = (status: FontResponse): void => {
    response = status;
    for (const release of pending) release(fontResponse(status));
    pending.clear();
  };
  try {
    const entry = join(scratch, "fixture.js");
    const output = join(scratch, "dist");
    await Bun.write(
      entry,
      `
      import {
        getTerminalFontState, subscribeTerminalFont, loadTerminalFont, retryTerminalFont,
      } from ${JSON.stringify(resolve(import.meta.dir, "terminal-font.ts"))};
      const consumers = new Map();
      const unhandled = [];
      window.addEventListener("unhandledrejection", event => {
        unhandled.push(String(event.reason));
      });
      window.fontFixture = {
        get: getTerminalFontState,
        load: loadTerminalFont,
        retry: retryTerminalFont,
        unhandled,
        mount(id) {
          const output = document.createElement("output");
          output.id = id;
          document.body.append(output);
          const history = [];
          const render = () => {
            const state = getTerminalFontState();
            output.textContent = state.status;
            history.push(state.status);
          };
          render();
          const unsubscribe = subscribeTerminalFont(render);
          consumers.set(id, { history, unsubscribe });
          loadTerminalFont();
          return output.textContent;
        },
        history: id => consumers.get(id).history,
        dispose() {
          for (const consumer of consumers.values()) consumer.unsubscribe();
          consumers.clear();
        },
      };
      `,
    );
    const build = await Bun.build({ entrypoints: [entry], target: "browser", outdir: output });
    if (!build.success) throw new Error(build.logs.map(String).join("\n"));
    // Both a fresh origin and resource path avoid Chromium's decoded-font cache surviving
    // navigation. Serve the production stylesheet unchanged, including its relative font URL.
    const prefix = `/${crypto.randomUUID()}`;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === `${prefix}/fonts/manifold-terminal-mono.woff2`) {
          requests += 1;
          if (response !== undefined) return fontResponse(response);
          const held = Promise.withResolvers<Response>();
          pending.add(held.resolve);
          return held.promise;
        }
        if (path === `${prefix}/styles.css`) {
          return new Response(Bun.file(resolve(import.meta.dir, "styles.css")), {
            headers: { "Content-Type": "text/css", "Cache-Control": "no-store" },
          });
        }
        if (path === `${prefix}/fixture.js`) {
          return new Response(Bun.file(join(output, "fixture.js")), {
            headers: { "Content-Type": "text/javascript", "Cache-Control": "no-store" },
          });
        }
        if (path === `${prefix}/`) {
          return new Response(
            '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><script type="module" src="fixture.js"></script>',
            { headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    await browser.launch({ incognito: true });
    await browser.goto(`http://127.0.0.1:${String(server.port)}${prefix}/`);
    await until(
      () => browser.evaluate<boolean>("window.fontFixture !== undefined"),
      5_000,
      "the native terminal font fixture",
    );
    await run({ browser, requests: () => requests, respond });
    expect(await browser.evaluate<string[]>("window.fontFixture.unhandled")).toEqual([]);
    expect(browser.drainMessages().filter((message) => message.kind === "exception")).toEqual([]);
    await browser.evaluate<void>("window.fontFixture.dispose()");
  } finally {
    // Resolve held HTTP handlers even on an assertion failure; close the owned browser/profile
    // before stopping its loopback server, and always remove the temporary bundle.
    respond(503);
    try {
      await browser.close();
    } finally {
      try {
        await server?.stop(true);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  }
}

async function waitForState(
  browser: Browser,
  status: "ready" | "failed",
  timeout = 5_000,
): Promise<void> {
  await until(
    () => browser.evaluate<boolean>(`window.fontFixture.get().status === ${JSON.stringify(status)}`),
    timeout,
    `terminal font ${status}`,
  );
}

test("native terminal font readiness is shared and warm consumers never regress to loading", async () => {
  await withFontFixture(async ({ browser, requests, respond }) => {
    expect(requests()).toBe(0);
    expect(
      await browser.evaluate<string[]>(
        '[window.fontFixture.mount("first"), window.fontFixture.mount("second")]',
      ),
    ).toEqual(["loading", "loading"]);
    await until(() => requests() === 1, 5_000, "one shared native font request");
    expect(
      await browser.evaluate<boolean>(
        "window.fontFixture.get() === window.fontFixture.get()",
      ),
    ).toBe(true);
    respond(200);
    await waitForState(browser, "ready");
    expect(
      await browser.evaluate<string[]>(
        'Array.from(document.querySelectorAll("output"), output => output.textContent)',
      ),
    ).toEqual(["ready", "ready"]);
    expect(
      await browser.evaluate<boolean>(`(() => {
        const ready = window.fontFixture.get();
        window.fontFixture.load();
        window.fontFixture.retry();
        const mounted = window.fontFixture.mount("warm");
        window.savedReady = ready;
        return mounted === "ready" && window.fontFixture.get() === ready;
      })()`),
    ).toBe(true);
    await sleep(500);
    expect(await browser.evaluate<string[]>('window.fontFixture.history("warm")')).toEqual([
      "ready",
    ]);
    expect(
      await browser.evaluate<boolean>("window.fontFixture.get() === window.savedReady"),
    ).toBe(true);
    expect(requests()).toBe(1);
  });
}, 60_000);

test("a native HTTP font failure stays failed until coalesced explicit retry really refetches", async () => {
  await withFontFixture(async ({ browser, requests, respond }) => {
    await browser.evaluate<void>('window.fontFixture.mount("first")');
    await until(() => requests() === 1, 5_000, "the failing native font request");
    respond(503);
    await waitForState(browser, "failed");
    expect(
      await browser.evaluate<boolean>(
        'Array.from(document.fonts).some(face => face.status === "error")',
      ),
    ).toBe(true);
    respond(200);
    expect(
      await browser.evaluate<boolean>(`(() => {
        const failed = window.fontFixture.get();
        window.savedFailure = failed;
        window.fontFixture.load();
        const mounted = window.fontFixture.mount("later");
        return failed.error instanceof Error && mounted === "failed"
          && window.fontFixture.get() === failed;
      })()`),
    ).toBe(true);
    await sleep(500);
    expect(requests()).toBe(1);
    expect(
      await browser.evaluate<boolean>("window.fontFixture.get() === window.savedFailure"),
    ).toBe(true);
    expect(
      await browser.evaluate<string>(`(() => {
        for (let i = 0; i < 20; i++) window.fontFixture.retry();
        return window.fontFixture.get().status;
      })()`),
    ).toBe("loading");
    await waitForState(browser, "ready");
    expect(requests()).toBe(2);
    expect(
      await browser.evaluate<string[]>(
        'Array.from(document.querySelectorAll("output"), output => output.textContent)',
      ),
    ).toEqual(["ready", "ready"]);
    expect(
      await browser.evaluate<string[]>("Array.from(document.fonts, face => face.status)"),
    ).toEqual(["loaded"]);
  });
}, 60_000);

for (const lateStatus of [200, 503] as const) {
  test(`each native attempt is bounded and late HTTP ${String(lateStatus)} cannot replace timeout failure`, async () => {
    await withFontFixture(async ({ browser, requests, respond }) => {
      await browser.evaluate<void>(
        'window.attemptStarted = performance.now(); window.fontFixture.mount("waiting")',
      );
      await until(() => requests() === 1, 5_000, "the held native font request");
      await waitForState(browser, "failed", 18_000);
      expect(
        await browser.evaluate<number>("performance.now() - window.attemptStarted"),
      ).toBeGreaterThanOrEqual(14_000);
      expect(
        await browser.evaluate<boolean>(
          'Array.from(document.fonts).some(face => face.status === "loading")',
        ),
      ).toBe(true);
      expect(
        await browser.evaluate<string>(`(() => {
          window.attemptStarted = performance.now();
          window.fontFixture.retry();
          window.fontFixture.retry();
          return window.fontFixture.get().status;
        })()`),
      ).toBe("loading");
      // The retry may share the still-running native request, but it owes its own bound.
      await waitForState(browser, "failed", 18_000);
      expect(
        await browser.evaluate<number>("performance.now() - window.attemptStarted"),
      ).toBeGreaterThanOrEqual(14_000);
      await browser.evaluate<void>("window.savedFailure = window.fontFixture.get()");
      respond(lateStatus);
      await until(
        () =>
          browser.evaluate<boolean>(
            `Array.from(document.fonts).some(face => face.status === ${JSON.stringify(lateStatus === 200 ? "loaded" : "error")})`,
          ),
        5_000,
        "the late native font settlement",
      );
      // Allow promise reactions and a paint to run before observing the terminal gate.
      await browser.evaluate<void>(
        "(() => { const frame = Promise.withResolvers(); requestAnimationFrame(() => requestAnimationFrame(frame.resolve)); return frame.promise; })()",
      );
      expect(
        await browser.evaluate<boolean>("window.fontFixture.get() === window.savedFailure"),
      ).toBe(true);
      expect(await browser.evaluate<string>('document.getElementById("waiting").textContent')).toBe(
        "failed",
      );
      const settledRequests = requests();
      respond(200);
      await browser.evaluate<void>("window.fontFixture.load()");
      await sleep(500);
      expect(requests()).toBe(settledRequests);
      expect(
        await browser.evaluate<boolean>("window.fontFixture.get() === window.savedFailure"),
      ).toBe(true);
      await browser.evaluate<void>("window.fontFixture.retry()");
      await waitForState(browser, "ready");
      expect(await browser.evaluate<string>('document.getElementById("waiting").textContent')).toBe(
        "ready",
      );
      expect(requests()).toBe(settledRequests + (lateStatus === 503 ? 1 : 0));
    });
  }, 60_000);
}
