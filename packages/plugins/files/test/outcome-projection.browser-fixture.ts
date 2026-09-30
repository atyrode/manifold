import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Browser } from "../../../../scripts/cdp.ts";
import { until } from "../../../../scripts/gate-lib.ts";

/** Actual React components; only the host action/byte-renderer responses are controlled. */
export async function withOutcomeProjection(
  run: (browser: Browser) => Promise<void>,
): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "manifold-outcome-projection-"));
  const browser = new Browser();
  let server: Bun.Server<undefined> | undefined;
  try {
    const entry = join(scratch, "fixture.tsx");
    await Bun.write(
      entry,
      `
      import { createRoot } from ${JSON.stringify(Bun.resolveSync("react-dom/client", resolve(import.meta.dir, "../../../web")))};
      import { flushSync } from ${JSON.stringify(Bun.resolveSync("react-dom", resolve(import.meta.dir, "../../../web")))};
      import { StrictMode, useLayoutEffect } from ${JSON.stringify(Bun.resolveSync("react", resolve(import.meta.dir, "../../../web")))};
      import { ByteRendererProvider } from ${JSON.stringify(resolve(import.meta.dir, "../../../ui/src/index.ts"))};
      import { NativeFileTransfer } from ${JSON.stringify(resolve(import.meta.dir, "../src/native-ui.tsx"))};
      import { FileImage } from ${JSON.stringify(resolve(import.meta.dir, "../images/src/web.tsx"))};
      import { formatManifoldUri } from ${JSON.stringify(resolve(import.meta.dir, "../../../protocol/src/index.ts"))};
      const root = createRoot(document.getElementById("root"));
      const log = [];
      const waits = new Map();
      let mounts = 0;
      let view = "native";
      let shown = true;
      let strict = false;
      let held = null;
      let beginMode = "lost";
      let commitMode = "lost";
      let inspectMode = "receiving";
      let receiptState = "outcome_unknown";
      let readSequence = 0;
      const ref = { kind: "file", fileId: "source-file" };
      const file = { ref, home: { kind: "root" }, ownerId: "owner", name: "source.png",
        declaredMediaType: "image/png", mediaType: "image/png", bytes: 1,
        sha256: "a".repeat(64), createdAt: 1,
        image: { mediaType: "image/png", width: 1, height: 1 } };
      const transfer = (transferId, kind, state) => ({ transferId, ref, kind, state, bytes: 1,
        offset: 1, sequence: 1, chunkBytes: 262144, createdAt: 1,
        expiresAt: Date.now() + 60000, reason: null });
      const native = state => ({ transfer: transfer("delivery", "delivery", state), native: null });
      async function outcome(mode) {
        if (mode === "lost") throw new Error("withheld acknowledgement");
        if (mode === "denied") return { ok: false, denial: { rule: "forbidden", message: "revoked" } };
        if (mode === "source-deleted") return { ok: true, result: { refused: "reference_unavailable" } };
        return { ok: true, result: native(mode) };
      }
      const host = {
        principal: { id: "owner" }, containerId: "home", localFiles: {},
        client: {
          machines: async () => [{ id: "machine", name: "Machine", online: true, revoked: false }],
          action: async (door, args) => {
            const name = door.split(".").at(-1);
            log.push([name, args]);
            if (name === held) {
              const gate = Promise.withResolvers();
              waits.set(name, gate.resolve);
              await gate.promise;
            }
            if (name === "describeMachine") return { ok: true, result: {
              machineId: "machine", installationRevision: "install", artifactSha256: "b".repeat(64),
              ownerId: "owner", ownerGeneration: 1,
              locations: [{ locationId: "location", locationRevision: "revision", access: ["create-child"], available: true }],
            } };
            if (name === "beginDelivery") return outcome(beginMode);
            if (name === "commitDelivery") return outcome(commitMode);
            if (name === "inspectDelivery") return outcome(inspectMode);
            if (name === "receiptNative") return receiptState === "denied"
              ? { ok: false, denial: { rule: "forbidden", message: "revoked" } }
              : { ok: true, result: { requestId: args.requestId, state: receiptState } };
            if (name === "openRead") return { ok: true, result: {
              file, transfer: transfer("read-" + ++readSequence, "read", "reading"),
            } };
            if (name === "cancelRead") return { ok: true, result: transfer(args.transferId, "read", "cancelled") };
            throw new Error("Unexpected action " + name);
          },
        },
      };
      const services = {
        project(source, observer) {
          log.push(["project", source.transferId]);
          const raster = document.createElement("canvas");
          raster.width = raster.height = 1;
          const context = raster.getContext("2d");
          context.fillStyle = source.transferId === "read-1" ? "#b31b1b" : "#135fbe";
          context.fillRect(0, 0, 1, 1);
          observer.ready(raster.toDataURL("image/png"), Date.now() + 60000);
          return { close() { log.push(["close", source.transferId]); }, recheck() {}, refuse(reason) { throw new Error(reason); } };
        },
      };
      function Probe() {
        useLayoutEffect(() => { mounts++; }, []);
        return null;
      }
      function render() {
        const child = shown ? <><Probe />{view === "native"
          ? <NativeFileTransfer host={host} file={file} />
          : <ByteRendererProvider services={services}><div style={{ width: 200, height: 200 }}>
              <FileImage host={host} data={{ file: formatManifoldUri(ref), cropX: 0, cropY: 0, cropWidth: 1, cropHeight: 1 }} edit={{ writable: false }} />
            </div></ByteRendererProvider>}</> : null;
        flushSync(() => root.render(strict ? <StrictMode>{child}</StrictMode> : child));
      }
      window.fixture = {
        log,
        get mounts() { return mounts; },
        mount(nextView, replay = false) { view = nextView; strict = replay; shown = true; render(); },
        mode(name, value) {
          if (name === "begin") beginMode = value;
          if (name === "commit") commitMode = value;
          if (name === "inspect") inspectMode = value;
          if (name === "receipt") receiptState = value;
        },
        hold(name) { held = name; },
        waiting(name) { return waits.has(name); },
        release(name) { held = null; waits.get(name)?.(); waits.delete(name); },
        remove() { shown = false; render(); },
        cleanup() { flushSync(() => root.unmount()); },
      };
      `,
    );
    const bundle = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      define: { "process.env.NODE_ENV": JSON.stringify("development") },
      outdir: join(scratch, "dist"),
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
    if (!bundle.success) throw new Error(bundle.logs.map(String).join("\n"));
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
      () => browser.evaluate<boolean>("window.fixture !== undefined"),
      5_000,
      "outcome projection fixture",
    );
    await run(browser);
    await browser.evaluate("fixture.cleanup()");
    const errors = browser.drainMessages().filter((message) => message.kind === "exception");
    if (errors.length) throw new Error(JSON.stringify(errors));
  } finally {
    try {
      await browser.close();
    } finally {
      await server?.stop(true);
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

export async function click(browser: Browser, label: string): Promise<void> {
  await browser.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll("button")).find(button => button.textContent === ${JSON.stringify(label)});
    if (!button || button.disabled) throw new Error("Missing enabled button: " + ${JSON.stringify(label)});
    button.click();
  })()`);
}

export async function checkpoint(browser: Browser): Promise<void> {
  await browser.evaluate(`(() => {
    const frame = Promise.withResolvers();
    requestAnimationFrame(() => requestAnimationFrame(frame.resolve));
    return frame.promise;
  })()`);
}

export async function reviewDelivery(browser: Browser): Promise<void> {
  await browser.evaluate('fixture.mount("native")');
  await until(
    () => browser.evaluate<boolean>('document.querySelector("select")?.options.length === 2'),
    5_000,
    "online machine",
  );
  await browser.evaluate(`(() => {
    const select = document.querySelector("select");
    select.value = "machine";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await click(browser, "Review installed pins and consent");
  await until(
    () => browser.evaluate<boolean>('document.querySelectorAll("select").length === 2'),
    5_000,
    "reviewed location",
  );
  await browser.evaluate(`(() => {
    const select = document.querySelectorAll("select")[1];
    select.value = "location";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const input = document.querySelector("input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "copy.png");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await checkpoint(browser);
}
