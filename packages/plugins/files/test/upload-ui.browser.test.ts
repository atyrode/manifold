import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Browser } from "../../../../scripts/cdp.ts";
import { until } from "../../../../scripts/gate-lib.ts";

/** Real React subscriptions and commits; the action boundary is deliberately held by the test. */
async function withUpload(run: (browser: Browser) => Promise<void>): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "manifold-upload-lifetime-"));
  const browser = new Browser();
  let server: Bun.Server<undefined> | undefined;
  try {
    const entry = join(scratch, "fixture.tsx");
    await Bun.write(
      entry,
      `
      import { createRoot } from ${JSON.stringify(Bun.resolveSync("react-dom/client", resolve(import.meta.dir, "../../../web")))};
      import { flushSync } from ${JSON.stringify(Bun.resolveSync("react-dom", resolve(import.meta.dir, "../../../web")))};
      import { StrictMode, Suspense, startTransition, useLayoutEffect } from ${JSON.stringify(Bun.resolveSync("react", resolve(import.meta.dir, "../../../web")))};
      import { FileUpload } from ${JSON.stringify(resolve(import.meta.dir, "../src/upload-ui.tsx"))};
      import { LocalFileStore } from ${JSON.stringify(resolve(import.meta.dir, "../../../web/src/local-files.ts"))};
      import { FileUploadController } from ${JSON.stringify(resolve(import.meta.dir, "../src/upload.ts"))};
      const root = createRoot(document.getElementById("root"));
      const log = [];
      const waits = new Map();
      let mounts = 0;
      const custody = new LocalFileStore();
      function select(name) {
        return custody.capture([new File([new Uint8Array([42])], name, { type: "image/png" })])[0];
      }
      let held = "completeUpload";
      let mode = "ok";
      let callback = 0;
      let blocked = false;
      const suspended = Promise.withResolvers();
      let selection = select("first.png");
      const firstHandle = selection.handle;
      const containerId = "first-home";
      const ref = { kind: "file", fileId: "saved-file" };
      const file = { ref, home: { kind: "root" }, ownerId: "owner", name: "first.png",
        declaredMediaType: "image/png", mediaType: "image/png", bytes: 1,
        sha256: "a".repeat(64), createdAt: 1, image: null };
      const transfer = { transferId: "upload", ref: { kind: "plugin", pluginId: "core.files" },
        kind: "upload", state: "receiving", bytes: 1, offset: 0, sequence: 0,
        chunkBytes: 262144, createdAt: 1, expiresAt: Date.now() + 60000, reason: null };
      const host = {
        principal: { id: "owner" }, containerId,
        localFiles: {
          read: (...args) => custody.read(...args),
          release: async handle => { await custody.release(handle); log.push(["release", handle]); },
        },
        client: { action: async (door) => {
          const name = door.split(".").at(-1);
          log.push(["action", name]);
          if (name === held) {
            log.push(["waiting", name]);
            const gate = Promise.withResolvers();
            waits.set(name, gate.resolve);
            await gate.promise;
          }
          if (name === "beginUpload") {
            if (mode === "unknown") throw new Error("lost acknowledgement");
            if (mode === "refused") return { ok: false, denial: { rule: "forbidden", message: "refused" } };
            return { ok: true, result: transfer };
          }
          if (name === "inspectUpload") return { ok: true, result: transfer };
          if (name === "completeUpload") return { ok: true, result: { ref } };
          if (name === "inspect") return { ok: true, result: file };
          throw new Error("Unexpected action " + name);
        }, writeByteChunk: async (_plugin, _carrier, request, data) => {
          log.push(["chunk", Array.from(data)]);
          transfer.offset += data.length;
          transfer.sequence++;
          return { offset: transfer.offset, sequence: request.sequence, acceptedBytes: data.length };
        } },
      };
      function StrictProbe() {
        useLayoutEffect(() => { mounts++; }, []);
        return null;
      }
      function Block() {
        if (blocked) {
          log.push(["suspended", callback]);
          throw suspended.promise;
        }
        return null;
      }
      function render(speculative = false) {
        const version = callback;
        const commit = () => root.render(<StrictMode><StrictProbe /><Suspense fallback="Waiting for speculative render">
          <FileUpload host={host} initialSelection={selection}
            onPublished={ref => log.push(["published", version, ref.fileId])}
            onSaved={file => log.push(["saved", version, file.ref.fileId])} />
          <Block />
        </Suspense></StrictMode>);
        if (speculative) startTransition(commit);
        else flushSync(commit);
      }
      window.upload = {
        log, render, firstHandle,
        get mounts() { return mounts; },
        async readable(handle = firstHandle) {
          try { return Array.from(await custody.read(handle, 0, 1)); }
          catch { return null; }
        },
        async retiredEntryPoints() {
          const descriptor = select("retired.png");
          const controller = new FileUploadController(host, descriptor, "file");
          const offset = log.length;
          controller.mount()();
          await Promise.all([controller.save(), controller.reconcile(), controller.cancel()]);
          const release = controller.mount();
          await Promise.all([controller.save(), controller.reconcile(), controller.cancel()]);
          release();
          return { handle: descriptor.handle, events: log.slice(offset),
            readable: await this.readable(descriptor.handle) };
        },
        callback() { blocked = false; callback++; render(); },
        speculative() { blocked = true; callback++; render(true); },
        hold(name) { held = name; },
        release(name) { held = null; waits.get(name)?.(); waits.delete(name); },
        replace() { selection = select("next.png"); render(); },
        home() { host.containerId = "next-home"; render(); },
        mode(value) { mode = value; held = null; },
        close() { flushSync(() => root.unmount()); },
        cleanup() { flushSync(() => root.unmount()); custody.close(); },
      };
      render();
      window.firstPaint = document.body.innerText;
      `,
    );
    const build = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      define: { "process.env.NODE_ENV": JSON.stringify("development") },
      outdir: join(scratch, "dist"),
      // The generated entry lives outside the workspace, but uses its one React runtime.
      plugins: [
        {
          name: "fixture-react",
          setup(builder) {
            builder.onResolve({ filter: /^react(?:\/.*)?$/ }, ({ path }) => ({
              path: Bun.resolveSync(path, resolve(import.meta.dir, "../../../web")),
            }));
          },
        },
      ],
    });
    if (!build.success) throw new Error(build.logs.map(String).join("\n"));
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/fixture.js")
          return new Response(Bun.file(join(scratch, "dist/fixture.js")), {
            headers: { "Content-Type": "text/javascript" },
          });
        return new Response(
          '<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>',
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
    await browser.launch({ incognito: true });
    await browser.goto(`http://127.0.0.1:${String(server.port)}/`);
    await until(
      () => browser.evaluate<boolean>("window.upload !== undefined"),
      5_000,
      "upload fixture",
    );
    await run(browser);
    await browser.evaluate("upload.cleanup()");
    expect(browser.drainMessages().filter((message) => message.kind === "exception")).toEqual([]);
  } finally {
    try {
      await browser.close();
    } finally {
      await server?.stop(true);
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

async function click(browser: Browser, label: string): Promise<void> {
  await browser.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll("button")).find(button => button.textContent === ${JSON.stringify(label)});
    if (!button || button.disabled) throw new Error("Missing enabled button");
    button.click();
  })()`);
}

async function waiting(browser: Browser, door: string): Promise<void> {
  await until(
    () =>
      browser.evaluate<boolean>(
        `upload.log.some(row => row[0] === "waiting" && row[1] === ${JSON.stringify(door)})`,
      ),
    5_000,
    `held ${door}`,
  );
}

test("initial intake publishes before inspect, once, to the latest committed callbacks", async () => {
  await withUpload(async (browser) => {
    expect(await browser.evaluate<number>("upload.mounts")).toBe(2);
    expect(await browser.evaluate<string>("window.firstPaint")).toContain("first.png");
    expect(await browser.evaluate<string>("window.firstPaint")).toContain("Locally pending");
    expect(await browser.evaluate<unknown[]>("upload.log")).toEqual([]);
    expect(await browser.evaluate<number[]>("upload.readable()")).toEqual([42]);
    await click(browser, "Save file");
    await waiting(browser, "completeUpload");
    expect(
      await browser.evaluate<unknown[]>("upload.log.filter(row => row[0] === 'chunk')"),
    ).toEqual([["chunk", [42]]]);
    await browser.evaluate("upload.callback(); upload.speculative()");
    await until(
      () => browser.evaluate<boolean>("upload.log.some(row => row[0] === 'suspended')"),
      5_000,
      "uncommitted callback render",
    );
    await browser.evaluate('upload.release("completeUpload"); upload.hold("inspect")');
    await waiting(browser, "inspect");
    expect(
      await browser.evaluate<unknown[]>(
        "upload.log.filter(row => row[0] === 'published' || row[0] === 'saved')",
      ),
    ).toEqual([["published", 1, "saved-file"]]);
    await browser.evaluate('upload.callback(); upload.release("inspect")');
    await until(
      () => browser.evaluate<boolean>("upload.log.some(row => row[0] === 'saved')"),
      5_000,
      "described file",
    );
    await click(browser, "Reconcile without publishing");
    await until(
      () => browser.evaluate<boolean>("!document.querySelector('button').disabled"),
      5_000,
      "reconcile settled",
    );
    expect(
      await browser.evaluate<unknown[]>(
        "upload.log.filter(row => row[0] === 'published' || row[0] === 'saved')",
      ),
    ).toEqual([
      ["published", 1, "saved-file"],
      ["saved", 3, "saved-file"],
    ]);
  });
}, 60_000);

test("late publication cannot enter a replacement selection or a different home", async () => {
  for (const retire of ["replace", "home", "close"]) {
    await withUpload(async (browser) => {
      await click(browser, "Save file");
      await waiting(browser, "completeUpload");
      await browser.evaluate(`upload.${retire}(); upload.release("completeUpload")`);
      // Observe a browser rendering checkpoint after the held response's microtasks, not a delay.
      await browser.evaluate(`(() => {
        const frame = Promise.withResolvers();
        requestAnimationFrame(frame.resolve);
        return frame.promise;
      })()`);
      expect(
        await browser.evaluate<unknown[]>(
          "upload.log.filter(row => row[0] === 'published' || row[0] === 'saved')",
        ),
      ).toEqual([]);
      expect(
        await browser.evaluate<unknown[]>("upload.log.filter(row => row[0] === 'release')"),
      ).toEqual([["release", await browser.evaluate<string>("upload.firstHandle")]]);
      expect(await browser.evaluate<boolean>("upload.log.some(row => row[1] === 'inspect')")).toBe(
        false,
      );
      if (retire !== "close")
        expect(await browser.evaluate<string>("document.body.innerText")).toContain(
          "Locally pending",
        );
    });
  }
}, 60_000);

test("refused and unacknowledged begin allow local discard without a cancellation claim", async () => {
  for (const mode of ["unknown", "refused"]) {
    await withUpload(async (browser) => {
      await browser.evaluate(`upload.mode(${JSON.stringify(mode)})`);
      await click(browser, "Save file");
      await until(
        () =>
          browser.evaluate<boolean>(
            "document.body.innerText.includes('Discard local selection and choose another')",
          ),
        5_000,
        "local discard",
      );
      await click(browser, "Discard local selection and choose another");
      await browser.evaluate("upload.replace()");
      expect(await browser.evaluate<string>("document.body.innerText")).toContain("next.png");
      expect(await browser.evaluate<string>("document.body.innerText")).toContain(
        "Locally pending",
      );
      expect(
        await browser.evaluate<unknown[]>("upload.log.filter(row => row[0] === 'action')"),
      ).toEqual([["action", "beginUpload"]]);
      expect(
        await browser.evaluate<unknown[]>("upload.log.filter(row => row[0] === 'release')"),
      ).toEqual([["release", await browser.evaluate<string>("upload.firstHandle")]]);
    });
  }
}, 60_000);

test("mount cleanup stops action entry points before the custody checkpoint and cannot revive them", async () => {
  await withUpload(async (browser) => {
    const result = await browser.evaluate<{
      handle: string;
      events: unknown[];
      readable: number[] | null;
    }>("upload.retiredEntryPoints()");
    expect(result.events).toEqual([["release", result.handle]]);
    expect(result.readable).toBeNull();
  });
}, 60_000);

test("retiring a held begin under StrictMode cannot continue with local bytes or publication", async () => {
  await withUpload(async (browser) => {
    await browser.evaluate('upload.hold("beginUpload")');
    await click(browser, "Save file");
    await waiting(browser, "beginUpload");
    await browser.evaluate('upload.close(); upload.release("beginUpload")');
    expect(await browser.evaluate<number[] | null>("upload.readable()")).toBeNull();
    await browser.evaluate(`(() => {
      const frame = Promise.withResolvers();
      requestAnimationFrame(frame.resolve);
      return frame.promise;
    })()`);
    expect(
      await browser.evaluate<unknown[]>("upload.log.filter(row => row[0] === 'action')"),
    ).toEqual([["action", "beginUpload"]]);
    expect(
      await browser.evaluate<unknown[]>("upload.log.filter(row => row[0] === 'chunk')"),
    ).toEqual([]);
    expect(
      await browser.evaluate<unknown[]>(
        "upload.log.filter(row => row[0] === 'published' || row[0] === 'saved')",
      ),
    ).toEqual([]);
  });
}, 60_000);
