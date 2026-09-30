import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compilePlugin } from "@manifold/plugin-kit/pack";
import {
  PLUGIN_BUNDLE_WEB_WORKER_FILE,
  PluginBundleSchema,
  PluginManifestSchema,
} from "@manifold/protocol";

/** The same guest runs as page React and a real compiled portable Worker. */
const guest = `
function Intake({host, input, onResult}) {
  const [read, setRead] = useState("unread");
  const value = input?.value ?? {};
  const file = input?.files[0];
  if ("token" in host || "token" in host.client) throw new Error("credential escaped");
  const finish = result => onResult?.(result);
  return createElement(Stack, null,
    createElement(Text, {"data-testid":"owner"}, value.label ?? "owner"),
    file && createElement(Button, {onClick: async () => {
      try { setRead(new TextDecoder().decode(await host.localFiles.read(file.handle, 0, file.bytes))); }
      catch (error) { setRead(error.reason ?? "refused"); }
    }}, "Read selection"),
    file && createElement(Text, {"data-testid":"read"}, read),
    createElement(Button, {onClick: async () => {
      await host.client.action("example.lifetime.wait", {label:value.label ?? "owner"});
      finish({state:"completed"});
    }}, "Hold completion"),
    createElement(Button, {onClick: () => finish({state:"cancelled"})}, "Cancel intake"),
    createElement(Button, {onClick: () => finish({state:"completed"})}, "Complete intake"),
    value.next?.length ? createElement(BorrowedPanel, {
      panelId:"example.lifetime." + value.next[0],
      input:{label:value.next[0], next:value.next.slice(1)},
      onResult:finish,
    }) : null);
}
`;

export async function serveHostLifetimes(): Promise<{
  readonly origin: string;
  close(): Promise<void>;
}> {
  const scratch = mkdtempSync(join(tmpdir(), "manifold-host-lifetimes-"));
  let server: Bun.Server<undefined> | undefined;
  try {
    const author = join(scratch, "web.js");
    await Bun.write(
      author,
      `import {createElement,useState} from "react";
      import {Stack,Text,Button,BorrowedPanel} from "@manifold/ui";
      ${guest}
      export default {id:"example.lifetime",panels:{a:Intake,b:Intake,c:Intake,d:Intake,e:Intake}};`,
    );
    const compiled = await compilePlugin(scratch, {
      source: {
        manifest: PluginManifestSchema.parse({
          id: "example.lifetime",
          title: "Host lifetime fixture",
          version: "1.0.0",
          description: "Committed browser custody fixture",
          capabilities: [],
          contributes: {
            panels: ["a", "b", "c", "d", "e"].map((id) => ({ id, title: id })),
          },
          entry: { web: "web.js", worker: true },
        }),
        web: author,
      },
    });
    const bundle = PluginBundleSchema.parse(JSON.parse(new TextDecoder().decode(compiled.bytes)));
    const worker = Buffer.from(bundle.files[PLUGIN_BUNDLE_WEB_WORKER_FILE]!, "base64");
    const entry = join(scratch, "fixture.js");
    const output = join(scratch, "dist");
    await Bun.write(
      entry,
      `
      import {createElement,useState,useLayoutEffect,StrictMode,Suspense} from ${JSON.stringify(Bun.resolveSync("react", import.meta.dir))};
      import {createRoot} from ${JSON.stringify(Bun.resolveSync("react-dom/client", import.meta.dir))};
      import {flushSync} from ${JSON.stringify(Bun.resolveSync("react-dom", import.meta.dir))};
      import {Stack,Text,Button,BorrowedPanel} from ${JSON.stringify(Bun.resolveSync("@manifold/ui", import.meta.dir))};
      import {ProjectionProvider,ProjectionScopeProvider} from ${JSON.stringify(Bun.resolveSync("@manifold/plugin/hooks", import.meta.dir))};
      import {MountedByteSurface,byteContribution} from ${JSON.stringify(resolve(import.meta.dir, "../byte-surface.tsx"))};
      import {isolatedPanel} from ${JSON.stringify(resolve(import.meta.dir, "isolated-panel.tsx"))};
      import {LocalFileStore} from ${JSON.stringify(resolve(import.meta.dir, "../local-files.ts"))};
      import {usePortableElementEdit} from ${JSON.stringify(resolve(import.meta.dir, "../portable-element-edit.ts"))};
      ${guest}
      const captures = [], results = [], pending = [], edits = [];
      const originalCapture = LocalFileStore.prototype.capture;
      LocalFileStore.prototype.capture = function(files) {
        const descriptors = originalCapture.call(this, files);
        for (const descriptor of descriptors) captures.push({store:this,descriptor});
        return descriptors;
      };
      const principal = {id:"viewer",kind:"human",name:"Viewer",color:"#ffffff"};
      function client() {
        const elements = new Map([["image",{id:"image",type:"example.lifetime.image",file:"source"}]]);
        return {status:"open",epoch:"epoch-one",spectator:false,sceneWriteAllowed:true,elements,
          selfCaps:()=>[],on:()=>()=>{},
          action:(_name,args)=>{const deferred=Promise.withResolvers();pending.push({resolve:deferred.resolve,label:args.label});return deferred.promise;},
          transact:run=>run({patch:(id,data)=>{elements.set(id,{...elements.get(id),...data});return true;}})};
      }
      const initialHost = () => ({client:client(),principal,containerId:"container-one",token:crypto.randomUUID(),authoring:null,
        topics:{index:[],terminals:[],attendance:[],machines:[]},navigate:()=>{},assembly:{panels:new Map(),sections:[]}});
      const fileInput = () => ({value:{label:"selection"},files:[new File(["private selection"],"selection.txt",{type:"text/plain"})]});
      let root, host, originalHost, input, mode, scenario, generation=0, visible=true, branch=true, probeElement, suspended=false, layoutVersion=0, strict=true, layoutSetups=0;
      const never = Promise.withResolvers().promise;
      function Suspender() { throw never; }
      function EditProbe() {
        const edit = usePortableElementEdit(probeElement);
        useLayoutEffect(()=>{edits.push(edit);},[edit]);
        return createElement(Text,null,edit.writable ? "Element writable" : "Element read only");
      }
      function LayoutCompletion({onResult,attempt}) {
        useLayoutEffect(()=>{layoutSetups++;onResult({state:"completed"});},[attempt,onResult]);
        return createElement(Text,null,"Completed during layout");
      }
      function LayoutIntake({arg,onResult}) {
        return arg.complete
          ? createElement(LayoutCompletion,{onResult,attempt:arg.complete})
          : createElement(Text,null,"Waiting for layout completion");
      }
      const boundary = ({children}) => children;
      function render() {
        const adapted = mode === "worker" ? isolatedPanel("example.lifetime","a",true) : byteContribution(Intake,true);
        const registry = {revision:generation,ErrorBoundary:boundary,Placeholder:({name})=>createElement(Text,null,name),
          panel:id=>({enabled:true,title:id,Component:mode === "worker" ? isolatedPanel("example.lifetime",id.split(".").at(-1),true) : byteContribution(Intake,true)})};
        let child;
        if (!visible) child = createElement(Text,null,"Unmounted");
        else if (scenario === "selection") child = createElement(adapted,{host,input,onResult:result=>results.push(result)});
        else if (scenario === "edit") child = createElement(ProjectionScopeProvider,{value:{host,client:host.client,locationPath:null}},createElement(EditProbe));
        else if (scenario === "layout") {
          const callbackVersion = layoutVersion;
          child = createElement(byteContribution(LayoutIntake,true),{
            host,input,arg:{complete:layoutVersion},
            onResult:result=>results.push({...result,callbackVersion}),
          });
        }
        else child = createElement(MountedByteSurface,{host},()=>createElement(Stack,null,
          branch && createElement(BorrowedPanel,{key:"chain",panelId:"example.lifetime.a",input:{label:"a",next:scenario === "cycle" ? ["a"] : ["b","c","d","e"]},onResult:result=>results.push(result)}),
          scenario === "budget" && createElement(BorrowedPanel,{key:"sibling",panelId:"example.lifetime.e",input:{label:"sibling"},onResult:result=>results.push(result)})));
        if (suspended) child = createElement(Suspense,{fallback:createElement(Text,null,"Suspended")},child,createElement(Suspender));
        const tree = createElement(ProjectionProvider,{value:registry},child);
        flushSync(()=>root.render(strict ? createElement(StrictMode,null,tree) : tree));
      }
      window.fixture = {
        mount(nextMode,nextScenario="selection",nextStrict=true) {
          if(root) flushSync(()=>root.unmount());
          root=createRoot(document.getElementById("root"));
          mode=nextMode;scenario=nextScenario;host=originalHost=initialHost();input=fileInput();visible=true;branch=true;suspended=false;
          probeElement={id:"image",data:{file:"source"}};layoutVersion=layoutSetups=0;strict=nextStrict;results.length=pending.length=captures.length=edits.length=0;render();
        },
        recompose() { host={...host};generation++;render(); },
        completeInLayout() { layoutVersion++;host={...host};generation++;render(); },
        layoutSetups() { return layoutSetups; },
        restoreHost() { host=originalHost;render(); },
        change(field) {
          if(field === "input") input=fileInput();
          else if(field === "client") host={...host,client:client()};
          else if(field === "principal") host={...host,principal:{...principal,id:"replacement"}};
          else if(field === "container") host={...host,containerId:"container-two"};
          else host={...host,token:crypto.randomUUID()};
          render();
        },
        branch(value) { branch=value;render(); },
        unmount() { visible=false;render(); },
        completePending() { for(const entry of pending.splice(0)) entry.resolve({ok:true,result:{}}); },
        counts() { return {results:[...results],pending:pending.length,captures:captures.length,owners:[...document.querySelectorAll('[data-testid="owner"]')].map(node=>node.textContent)}; },
        async custody() { return Promise.all(captures.map(async({store,descriptor})=>{
          try{return new TextDecoder().decode(await store.read(descriptor.handle,0,descriptor.bytes));}
          catch(error){return error.reason;}
        })); },
        async editRetirement(field) {
          const previous=edits.at(-1);
          if(field === "element") {
            probeElement={id:"image",data:{file:"replacement"}};
            host.client.elements.set("image",{id:"image",type:"example.lifetime.image",file:"replacement"});render();
            probeElement={id:"image",data:{file:"source"}};
            host.client.elements.set("image",{id:"image",type:"example.lifetime.image",file:"source"});render();
          }
          else if(field === "unmount") this.unmount();
          else this.change(field);
          let refused=false;
          try{await previous.patch({file:"late"});}catch{refused=true;}
          return {refused,source:host.client.elements.get("image").file};
        },
        async edit() { await edits.at(-1).patch({file:"edited"});return host.client.elements.get("image").file; },
        speculative() { if(root) flushSync(()=>root.unmount());root=createRoot(document.getElementById("root"));mode="page";scenario="selection";host=initialHost();input=fileInput();visible=true;suspended=true;captures.length=0;render();return captures.length; },
        close() {if(root) flushSync(()=>root.unmount());root=null;},
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
        if (path.startsWith("/api/plugins/example.lifetime/"))
          return new Response(worker, { headers: { "Content-Type": "text/javascript" } });
        if (path === "/fixture.js" || path === "/fixture.css")
          return new Response(Bun.file(join(output, path.slice(1))), {
            headers: { "Content-Type": path.endsWith(".css") ? "text/css" : "text/javascript" },
          });
        return new Response(
          '<!doctype html><meta charset="utf-8"><title>Host lifetime fixture</title><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
    const held = server;
    return {
      origin: `http://127.0.0.1:${String(held.port)}`,
      async close() {
        await held.stop(true);
        rmSync(scratch, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await server?.stop(true);
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}
