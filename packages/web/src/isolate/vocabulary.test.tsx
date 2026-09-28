import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compilePlugin } from "@manifold/plugin-kit/pack";
import {
  PLUGIN_BUNDLE_WEB_WORKER_FILE,
  PluginBundleSchema,
  PluginManifestSchema,
} from "@manifold/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { Browser } from "../../../../scripts/cdp.ts";
import { VocabularyRenderer } from "./vocabulary.tsx";

test("text reaches the DOM as text, never as markup", () => {
  const hostile = renderToStaticMarkup(
    <VocabularyRenderer
      tree={{ type: "text", text: '<img src=x onerror="alert(1)">' }}
      onEvent={() => {}}
    />,
  );
  expect(hostile).not.toContain("<img");
  expect(hostile).toContain("&lt;img");
});

test("a keyed Worker field keeps its DOM, focus and pending edit as root siblings change", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "manifold-frame-root-"));
  const browser = new Browser();
  let server: Bun.Server<undefined> | undefined;
  try {
    const entry = join(scratch, "fixture.js");
    const author = join(scratch, "web.js");
    const output = join(scratch, "dist");
    await Bun.write(
      author,
      `
      import { createElement, Fragment } from "react";
      import { Input, Text } from "@manifold/ui";
      import { defineWebPlugin } from ${JSON.stringify(Bun.resolveSync("@manifold/plugin-kit/web", import.meta.dir))};
      function Form({ arg = {}, host }) {
        const { before, after, visible = true, value = "server" } = arg;
        return createElement(Fragment, null,
          before ? createElement(Text, { key: "before", "data-testid": "before" }, "Before") : null,
          visible ? createElement(Input, {
            key: "field", label: "Name", value,
            onChange: edited => { void host.client.action("example.frame.edit", { value: edited }); },
          }) : null,
          after ? createElement(Text, { key: "after", "data-testid": "after" }, "After") : null);
      }
      export default defineWebPlugin({ id: "example.frame", panels: { main: Form } });
      `,
    );
    const compiled = await compilePlugin(scratch, {
      source: {
        manifest: PluginManifestSchema.parse({
          id: "example.frame",
          title: "Root identity fixture",
          version: "1.0.0",
          description: "Exercises keyed root fields through the packed portable Worker.",
          capabilities: [],
          contributes: { panels: [{ id: "main", title: "Form" }] },
          entry: { web: "web.js", worker: true },
        }),
        web: author,
      },
    });
    const bundle = PluginBundleSchema.parse(JSON.parse(new TextDecoder().decode(compiled.bytes)));
    const workerSource = Buffer.from(bundle.files[PLUGIN_BUNDLE_WEB_WORKER_FILE]!, "base64");
    await Bun.write(
      entry,
      `
      import { createElement } from ${JSON.stringify(Bun.resolveSync("react", import.meta.dir))};
      import { createRoot } from ${JSON.stringify(Bun.resolveSync("react-dom/client", import.meta.dir))};
      import { flushSync } from ${JSON.stringify(Bun.resolveSync("react-dom", import.meta.dir))};
      import { VocabularyRenderer } from ${JSON.stringify(resolve(import.meta.dir, "vocabulary.tsx"))};
      const worker = new Worker("/worker.js", { type: "module" });
      const root = createRoot(document.getElementById("root"));
      const principal = { id: "viewer", kind: "human", name: "Viewer", color: "#74c0fc" };
      const context = {
        principal, caps: [], containerId: null,
        topics: { index: [], terminals: [], attendance: [], machines: [] },
        status: "open", hidden: false, canAuthor: false,
      };
      const init = { t: "init", pluginId: "example.frame", principal, caps: [], containerId: null };
      const calls = [], barriers = [], errors = [];
      let mounted = false, inputEvent, pendingPaint;
      worker.addEventListener("error", event => errors.push(event.message));
      worker.onmessage = ({ data: frame }) => {
        if (frame.t === "ready") barriers.shift()?.();
        else if (frame.t === "render") {
          inputEvent = fieldEvent(frame.tree);
          flushSync(() => root.render(createElement(VocabularyRenderer, {
            tree: frame.tree,
            onEvent: (event, payload) => worker.postMessage({ t: "event", instance: "form", event, payload }),
          })));
          pendingPaint?.resolve();
          pendingPaint = null;
        } else if (frame.t === "call") {
          if (frame.method === "action" && frame.args[0] === "example.frame.edit") {
            calls.push(frame.args[1].value);
            worker.postMessage({ t: "reply", id: frame.id, ok: true, result: { ok: true, result: {} } });
          } else errors.push("Unexpected host call: " + frame.method);
        } else if (frame.t === "fault") {
          errors.push(frame.error);
          pendingPaint?.reject(new Error(frame.error));
          pendingPaint = null;
        }
      };
      async function settle() {
        const barrier = Promise.withResolvers();
        barriers.push(barrier.resolve);
        // A ready reply fences all preceding event effects over the real Worker port.
        worker.postMessage(init);
        await barrier.promise;
        if (errors.length) throw new Error(errors.join("; "));
      }
      function fieldEvent(node) {
        if (node.type === "input") return node.event;
        if (node.type === "box") return node.children.map(fieldEvent).find(Boolean);
      }
      window.frameFixture = {
        async paint(props) {
          await settle();
          const painted = Promise.withResolvers();
          pendingPaint = painted;
          worker.postMessage(mounted
            ? { t: "context", instance: "form", context, arg: props }
            : { t: "mount", instance: "form", panel: "main", kind: "panel", context, arg: props });
          mounted = true;
          await painted.promise;
        },
        inputEvent: () => inputEvent,
        async deliver(event, payload) {
          worker.postMessage({ t: "event", instance: "form", event, payload });
          await settle();
          return calls.slice();
        },
        calls: async () => { await settle(); return calls.slice(); },
        async close() {
          worker.postMessage({ t: "unmount", instance: "form" });
          await settle();
          root.unmount();
          worker.terminate();
        },
      };
      `,
    );
    const build = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      outdir: output,
    });
    if (!build.success) throw new Error(build.logs.map(String).join("\n"));
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/worker.js") {
          return new Response(workerSource, { headers: { "Content-Type": "text/javascript" } });
        }
        if (path === "/fixture.js") {
          return new Response(Bun.file(join(output, path.slice(1))), {
            headers: { "Content-Type": "text/javascript" },
          });
        }
        return new Response(
          '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/fixture.js"></script>',
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
    await browser.launch({ incognito: true });
    await browser.goto(`http://127.0.0.1:${String(server.port)}/`);
    await browser.evaluate<void>("window.frameFixture.paint({})");
    const originalEvent = await browser.evaluate<string>("window.frameFixture.inputEvent()");
    await browser.evaluate<void>(`
      window.originalInput = document.querySelector("input");
      window.originalInput.focus();
      window.originalInput.select();
    `);
    await browser.typeText("draft");
    expect(await browser.evaluate<string[]>("window.frameFixture.calls()")).toEqual([
      "d",
      "dr",
      "dra",
      "draf",
      "draft",
    ]);
    await browser.evaluate<void>("window.originalInput.setSelectionRange(1, 4)");
    for (const [before, after] of [
      [false, true],
      [true, true],
      [true, false],
      [false, false],
      [true, false],
      [false, true],
      [false, false],
    ]) {
      await browser.evaluate<void>(
        `window.frameFixture.paint(${JSON.stringify({ before, after, value: "stale owner value" })})`,
      );
      expect(
        await browser.evaluate(`
          ({
            same: document.querySelector("input") === window.originalInput,
            focused: document.activeElement === window.originalInput,
            value: document.querySelector("input").value,
            selection: [window.originalInput.selectionStart, window.originalInput.selectionEnd],
            before: document.querySelector('[data-testid="before"]') !== null,
            after: document.querySelector('[data-testid="after"]') !== null,
          })
        `),
      ).toEqual({
        same: true,
        focused: true,
        value: "draft",
        selection: [1, 4],
        before,
        after,
      });
    }
    await browser.evaluate<void>("window.frameFixture.paint({ visible: false })");
    expect(
      await browser.evaluate(
        "document.querySelector('input') === null && !originalInput.isConnected",
      ),
    ).toBe(true);
    const callsBeforeRetired = await browser.evaluate<string[]>("window.frameFixture.calls()");
    const callsAfterRetired = await browser.evaluate<string[]>(
      `window.frameFixture.deliver(${JSON.stringify(originalEvent)}, "retired edit")`,
    );
    expect(callsAfterRetired).toEqual(callsBeforeRetired);
    await browser.evaluate<void>("window.frameFixture.paint({ value: 'returned' })");
    expect(await browser.evaluate<string>("window.frameFixture.inputEvent()")).not.toBe(
      originalEvent,
    );
    expect(
      await browser.evaluate(
        "document.querySelector('input') !== originalInput && document.querySelector('input').value === 'returned'",
      ),
    ).toBe(true);
    await browser.typeInto("input", "!");
    expect((await browser.evaluate<string[]>("window.frameFixture.calls()")).at(-1)).toBe(
      "returned!",
    );
    await browser.evaluate<void>("window.frameFixture.close()");
  } finally {
    await browser.close();
    await server?.stop(true);
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);
