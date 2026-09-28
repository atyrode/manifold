import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    const worker = join(scratch, "worker.js");
    const output = join(scratch, "dist");
    await Bun.write(
      worker,
      `
      import { createElement, Fragment } from ${JSON.stringify(Bun.resolveSync("react", import.meta.dir))};
      import { FrameModeProvider, Input, Text } from ${JSON.stringify(Bun.resolveSync("@manifold/ui/frames", import.meta.dir))};
      import { createUiRoot } from ${JSON.stringify(resolve(import.meta.dir, "../../../plugin-kit/src/frame-root.ts"))};
      let pending;
      const calls = [];
      const root = createUiRoot({
        commit: tree => postMessage({ id: pending, tree }),
        fault: error => postMessage({ id: pending, error: String(error) }),
        report: error => postMessage({ id: pending, error: String(error) }),
      });
      function Form({ before, after, visible = true, value = "server" }) {
        return createElement(Fragment, null,
          before ? createElement(Text, { key: "before", "data-testid": "before" }, "Before") : null,
          visible ? createElement(Input, {
            key: "field", label: "Name", value,
            onChange: edited => calls.push(edited),
          }) : null,
          after ? createElement(Text, { key: "after", "data-testid": "after" }, "After") : null);
      }
      onmessage = ({ data }) => {
        if (data.op === "render") {
          pending = data.id;
          root.render(createElement(FrameModeProvider, null, createElement(Form, data.props)));
        } else if (data.op === "event") {
          const refusal = root.event(data.event, data.payload);
          postMessage({ id: data.id, refusal, calls });
        } else {
          postMessage({ id: data.id, calls });
        }
      };
      `,
    );
    await Bun.write(
      entry,
      `
      import { createElement } from ${JSON.stringify(Bun.resolveSync("react", import.meta.dir))};
      import { createRoot } from ${JSON.stringify(Bun.resolveSync("react-dom/client", import.meta.dir))};
      import { flushSync } from ${JSON.stringify(Bun.resolveSync("react-dom", import.meta.dir))};
      import { VocabularyRenderer } from ${JSON.stringify(resolve(import.meta.dir, "vocabulary.tsx"))};
      const worker = new Worker("/worker.js", { type: "module" });
      const root = createRoot(document.getElementById("root"));
      const pending = new Map();
      let nextId = 0, inputEvent;
      worker.onmessage = ({ data }) => {
        const request = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) request.reject(new Error(data.error));
        else request.resolve(data);
      };
      function ask(message) {
        const id = ++nextId;
        const deferred = Promise.withResolvers();
        pending.set(id, deferred);
        worker.postMessage({ ...message, id });
        return deferred.promise;
      }
      function fieldEvent(node) {
        if (node.type === "input") return node.event;
        if (node.type === "box") return node.children.map(fieldEvent).find(Boolean);
      }
      window.frameFixture = {
        async paint(props) {
          const { tree } = await ask({ op: "render", props });
          inputEvent = fieldEvent(tree);
          flushSync(() => root.render(createElement(VocabularyRenderer, {
            tree,
            onEvent: (event, payload) => { void ask({ op: "event", event, payload }); },
          })));
        },
        inputEvent: () => inputEvent,
        deliver: (event, payload) => ask({ op: "event", event, payload }),
        calls: async () => (await ask({ op: "calls" })).calls,
        close: () => { worker.terminate(); root.unmount(); },
      };
      `,
    );
    const build = await Bun.build({
      entrypoints: [entry, worker],
      target: "browser",
      outdir: output,
    });
    if (!build.success) throw new Error(build.logs.map(String).join("\n"));
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/fixture.js" || path === "/worker.js") {
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
      await browser.evaluate("document.querySelector('input') === null && !originalInput.isConnected"),
    ).toBe(true);
    const callsBeforeRetired = await browser.evaluate<string[]>("window.frameFixture.calls()");
    const retired = await browser.evaluate<{ refusal: string; calls: string[] }>(
      `window.frameFixture.deliver(${JSON.stringify(originalEvent)}, "retired edit")`,
    );
    expect(retired.refusal).not.toBeNull();
    expect(retired.calls).toEqual(callsBeforeRetired);
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
    expect(browser.drainMessages().filter((message) => message.level === "error")).toEqual([]);
  } finally {
    await browser.close();
    await server?.stop(true);
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);
