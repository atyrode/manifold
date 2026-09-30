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
import { Browser } from "../../../../scripts/cdp.ts";

/** Runs actual DOM controls, FileReader, worker transfers and browser raster decoding. */
test("byte renderers keep page/worker custody, static decode and revocation semantics identical", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "manifold-byte-renderer-"));
  const browser = new Browser();
  let server: Bun.Server<undefined> | undefined;
  const component = `
    function Intake({host, arg}) {
      const [selection, selected] = useState(null);
      const [result, resultOf] = useState("No read");
      if ("token" in host || "token" in host.client) throw new Error("portable credential leak");
      async function read(cancel) {
        const controller = new AbortController();
        try {
          const pending = host.localFiles.read(selection.handle, 0, selection.bytes, {signal: controller.signal});
          if (cancel) controller.abort();
          const data = await pending;
          const hash = await crypto.subtle.digest("SHA-256", data);
          resultOf(Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join(""));
        } catch (error) { resultOf(error.reason || "failed"); }
      }
      return createElement(Stack, null,
        createElement(FileInput, {label:"Private intake", multiple:true, clipboard:true, onChange: files => selected(files[0])}),
        createElement(Button, {disabled: !selection, onClick: () => void read(false)}, "Read selected"),
        createElement(Button, {disabled: !selection, onClick: () => void read(true)}, "Cancel read"),
        createElement(Button, {disabled: !selection, onClick: async () => { await host.localFiles.release(selection.handle); resultOf("released"); }}, "Release selected"),
        createElement(Text, {"data-testid":"read-result"}, result),
        createElement(ByteImage, {label:"Private raster", source:arg.source}));
    }
  `;
  try {
    const author = join(scratch, "web.js");
    await Bun.write(
      author,
      `import {createElement,useState} from "react";
      import {Stack,Text,Button,FileInput,ByteImage} from "@manifold/ui";
      ${component}
      export default {id:"example.bytes",panels:{main:Intake}};`,
    );
    const compiled = await compilePlugin(scratch, {
      source: {
        manifest: PluginManifestSchema.parse({
          id: "example.bytes",
          title: "Byte custody",
          version: "1.0.0",
          description: "Byte resource boundary fixture",
          capabilities: [],
          contributes: { panels: [{ id: "main", title: "Intake" }] },
          entry: { web: "web.js", worker: true },
        }),
        web: author,
      },
    });
    const bundle = PluginBundleSchema.parse(JSON.parse(new TextDecoder().decode(compiled.bytes)));
    const workerSource = Buffer.from(bundle.files[PLUGIN_BUNDLE_WEB_WORKER_FILE]!, "base64");
    const entry = join(scratch, "fixture.js");
    const output = join(scratch, "dist");
    await Bun.write(
      entry,
      `
      import {createElement,useState} from ${JSON.stringify(Bun.resolveSync("react", import.meta.dir))};
      import {createRoot} from ${JSON.stringify(Bun.resolveSync("react-dom/client", import.meta.dir))};
      import {flushSync} from ${JSON.stringify(Bun.resolveSync("react-dom", import.meta.dir))};
      import {Stack,Text,Button,FileInput,ByteImage,ByteRendererProvider} from ${JSON.stringify(Bun.resolveSync("@manifold/ui", import.meta.dir))};
      import {ByteTransferError} from ${JSON.stringify(Bun.resolveSync("@manifold/protocol", import.meta.dir))};
      import {WorkerHost} from ${JSON.stringify(resolve(import.meta.dir, "worker-host.ts"))};
      import {VocabularyRenderer} from ${JSON.stringify(resolve(import.meta.dir, "vocabulary.tsx"))};
      import {MountedByteResources,byteContribution} from ${JSON.stringify(resolve(import.meta.dir, "../byte-renderer.tsx"))};
      import {LocalFileStore} from ${JSON.stringify(resolve(import.meta.dir, "../local-files.ts"))};
      ${component}
      let root, worker, resources, refused = false;
      const principal = {id:"viewer",kind:"human",name:"Viewer",color:"#ffffff"};
      const statusListeners = new Set();
      const revoked = [];
      const originalRevoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = url => { revoked.push(url); originalRevoke(url); };
      async function mount(mode, mediaType) {
        close(); refused = false;
        let bytes;
        if (mediaType === "image/gif") bytes = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), c => c.charCodeAt(0));
        else {
          const canvas = document.createElement("canvas"); canvas.width = 3; canvas.height = 2;
          canvas.getContext("2d").fillRect(0,0,3,2);
          const encoded = Promise.withResolvers();
          canvas.toBlob(encoded.resolve, mediaType);
          const blob = await encoded.promise;
          bytes = new Uint8Array(await blob.arrayBuffer());
        }
        const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)), b => b.toString(16).padStart(2,"0")).join("");
        const source = {pluginId:"example.files",carrierId:"read",transferId:"read-one",ref:{kind:"file",fileId:"file-one"},bytes:bytes.length,sha256,mediaType};
        const client = {status:"open",selfCaps:()=>[],on:(_,listener)=>{statusListeners.add(listener);return()=>statusListeners.delete(listener)},
          readByteChunk:async(_plugin,_carrier,request,signal)=>{
            if(refused) throw new ByteTransferError("unavailable");
            if(signal?.aborted) throw new ByteTransferError("cancelled");
            return {offset:request.offset,data:bytes.slice(request.offset,request.offset+request.length),eof:request.offset+request.length===bytes.length,leaseMs:15000};
          }};
        const host = {client,principal,containerId:null,token:"not-for-guests",authoring:null,topics:{index:[],terminals:[],attendance:[],machines:[]},navigate:()=>{}};
        root = createRoot(document.getElementById("root"));
        if(mode === "page") {
          const Adapted = byteContribution(Intake,true);
          flushSync(()=>root.render(createElement(Adapted,{host,arg:{source}})));
        } else {
          resources = new MountedByteResources(client);
          worker = new WorkerHost({pluginId:"example.bytes",principal,caps:[],containerId:null,host,portableWorker:true,workerFactory:()=>new Worker("/worker.js",{type:"module"})});
          worker.mount("one","main",tree=>flushSync(()=>root.render(createElement(ByteRendererProvider,{services:resources.services},createElement(VocabularyRenderer,{tree,onEvent:(event,payload)=>worker.event("one",event,payload)})))),error=>{document.getElementById("root").textContent=error},{host,arg:{source},resources});
          worker.start();
        }
        await until(()=>document.querySelector("img") !== null);
        return {width:document.querySelector("img").naturalWidth,height:document.querySelector("img").naturalHeight};
      }
      async function until(condition) {
        const end = Date.now()+5000;
        while(!condition()) {
          if(Date.now()>end) throw new Error("fixture condition timeout: "+document.body.textContent);
          const delay = Promise.withResolvers(); setTimeout(delay.resolve,10); await delay.promise;
        }
      }
      function close() { if(root) flushSync(()=>root.unmount()); worker?.stop(); resources?.close(); root=worker=resources=null; }
      window.fixture = {mount,close,
        selectionReady: () => until(()=>!Array.from(document.querySelectorAll("button")).find(button=>button.textContent==="Read selected").disabled),
        closeReady() {
          const image=document.querySelector("img"), url=image.src; close();
          return {removed:!image.isConnected,revoked:revoked.includes(url)};
        },
        async drop() {
          const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array([1,2,3])],"local.bin",{type:"application/octet-stream"}));
          document.querySelector("fieldset").dispatchEvent(new DragEvent("drop",{bubbles:true,dataTransfer:transfer}));
          await until(()=>!Array.from(document.querySelectorAll("button")).find(button=>button.textContent==="Read selected").disabled);
        },
        internalCarry() {
          const transfer = new DataTransfer();
          transfer.setData("application/x-manifold-item", JSON.stringify({kind:"structure",type:"spacer"}));
          return ["dragover","drop"].map(type =>
            document.querySelector("fieldset").dispatchEvent(
              new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:transfer})));
        },
        async press(label, expected) {
          Array.from(document.querySelectorAll("button")).find(button=>button.textContent===label).click();
          await until(()=>document.querySelector('[data-testid="read-result"]').textContent===expected);
          return document.querySelector('[data-testid="read-result"]').textContent;
        },
        async revoke() {
          const image = document.querySelector("img"), url = image.src;
          refused = true; window.dispatchEvent(new Event("focus"));
          const removedSynchronously = !image.isConnected;
          await until(()=>document.body.textContent.includes("Private raster unavailable: unavailable"));
          return {removedSynchronously,revoked:revoked.includes(url),images:document.querySelectorAll("img").length};
        },
        async custody() {
          const one = new LocalFileStore(), two = new LocalFileStore();
          try {
            const file = new File([new Uint8Array([1,2,3])], "local.bin");
            const [descriptor] = one.capture([file]);
            const foreign = await two.read(descriptor.handle,0,3).catch(error=>error.reason);
            const oversized = await one.read(descriptor.handle,0,262145).catch(error=>error.reason);
            const pending = one.read(descriptor.handle,0,3).catch(error=>error.reason);
            one.close();
            const cancelled = await pending;
            const retired = await one.read(descriptor.handle,0,3).catch(error=>error.reason);
            two.capture([file,file,file,file]);
            let capacity;
            try { two.capture([file]); } catch(error) { capacity=error.reason; }
            return {foreign,oversized,cancelled,retired,capacity};
          } finally { one.close(); two.close(); }
        },
      };
    `,
    );
    const build = await Bun.build({ entrypoints: [entry], target: "browser", outdir: output });
    if (!build.success) throw new Error(build.logs.map(String).join("\n"));
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/worker.js")
          return new Response(workerSource, { headers: { "Content-Type": "text/javascript" } });
        if (path === "/fixture.js" || path === "/fixture.css")
          return new Response(Bun.file(join(output, path.slice(1))), {
            headers: { "Content-Type": path.endsWith(".css") ? "text/css" : "text/javascript" },
          });
        return new Response(
          '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
          {
            headers: { "Content-Type": "text/html" },
          },
        );
      },
    });
    await browser.launch({ incognito: true });
    await browser.goto(`http://127.0.0.1:${String(server.port)}/`);
    expect(
      await browser.evaluate<{
        foreign: string;
        oversized: string;
        cancelled: string;
        retired: string;
        capacity: string;
      }>("window.fixture.custody()"),
    ).toEqual({
      foreign: "unavailable",
      oversized: "invalid",
      cancelled: "cancelled",
      retired: "unavailable",
      capacity: "busy",
    });
    const hash = Buffer.from(
      await crypto.subtle.digest("SHA-256", new Uint8Array([1, 2, 3])),
    ).toString("hex");
    const selectedPath = join(scratch, "selected.bin");
    await Bun.write(selectedPath, new Uint8Array([1, 2, 3]));
    for (const mode of ["page", "worker"]) {
      for (const mediaType of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
        expect(
          await browser.evaluate<{ width: number; height: number }>(
            `window.fixture.mount(${JSON.stringify(mode)},${JSON.stringify(mediaType)})`,
          ),
        ).toEqual(mediaType === "image/gif" ? { width: 1, height: 1 } : { width: 3, height: 2 });
        if (mediaType === "image/png") {
          expect(await browser.evaluate<boolean[]>("window.fixture.internalCarry()")).toEqual([
            true,
            true,
          ]);
          const selected = await browser.send("Runtime.evaluate", {
            expression: 'document.querySelector("input[type=file]")',
          });
          const objectId = (selected.result?.["result"] as { objectId?: string } | undefined)
            ?.objectId;
          if (objectId === undefined) throw new Error("file picker did not mount");
          const chosen = await browser.send("DOM.setFileInputFiles", {
            objectId,
            files: [selectedPath],
          });
          if (chosen.error !== undefined) throw new Error(chosen.error.message);
          await browser.evaluate("window.fixture.selectionReady()");
        } else await browser.evaluate("window.fixture.drop()");
        expect(
          await browser.evaluate<string>(
            `window.fixture.press("Read selected",${JSON.stringify(hash)})`,
          ),
        ).toBe(hash);
        expect(
          await browser.evaluate<string>('window.fixture.press("Cancel read","cancelled")'),
        ).toBe("cancelled");
        await browser.evaluate('window.fixture.press("Release selected","released")');
        expect(
          await browser.evaluate<string>('window.fixture.press("Read selected","unavailable")'),
        ).toBe("unavailable");
        expect(
          await browser.evaluate<{
            removedSynchronously: boolean;
            revoked: boolean;
            images: number;
          }>("window.fixture.revoke()"),
        ).toEqual({ removedSynchronously: true, revoked: true, images: 0 });
      }
      await browser.evaluate(`window.fixture.mount(${JSON.stringify(mode)},"image/png")`);
      expect(
        await browser.evaluate<{ removed: boolean; revoked: boolean }>(
          "window.fixture.closeReady()",
        ),
      ).toEqual({ removed: true, revoked: true });
    }
    await browser.evaluate("window.fixture.close()");
  } finally {
    await browser.close();
    await server?.stop(true);
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);
