/*
  ┌──────────────────────────────────────────────────────────────────────────────────────┐
  │  DISPOSABLE SPIKE RUNNER — issue #126. NOT A GATE SCRIPT. NOT WIRED INTO package.json│
  │  Delete this whole directory once ADR 0021 is decided. See ./README.md.               │
  └──────────────────────────────────────────────────────────────────────────────────────┘

    bun docs/spikes/s126-dockview/run.ts [--keep]

  Bundles `harness.tsx`, serves it, drives it through the repository's own CDP client
  (`scripts/cdp.ts` — the one `verify-tile-drop.ts` uses), runs the six probes and prints
  the findings as JSON. Screenshots land beside this file as `shot-*.png` and are read back
  through vision, which is what makes the "can it host our leaves" answer visual rather
  than merely numeric.
*/

import { Browser } from "../../../scripts/cdp.ts";

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = new URL("../../../", import.meta.url).pathname;
const PORT = 9426;

/** One react instance for the whole bundle: the spike dir and `packages/plugin` both
 *  import react, and two copies would break hooks across the boundary. Every react
 *  specifier is pinned to the copy `packages/plugin` resolves, which is also the copy
 *  `packages/web` ships. */
const REACT_ALIASES: Record<string, string> = {
  react: Bun.resolveSync("react", `${ROOT}packages/plugin/src`),
  "react/jsx-runtime": Bun.resolveSync("react/jsx-runtime", `${ROOT}packages/plugin/src`),
  "react/jsx-dev-runtime": Bun.resolveSync("react/jsx-dev-runtime", `${ROOT}packages/plugin/src`),
  "react-dom": Bun.resolveSync("react-dom", `${ROOT}packages/plugin/src`),
  "react-dom/client": Bun.resolveSync("react-dom/client", `${ROOT}packages/plugin/src`),
};

const build = await Bun.build({
  entrypoints: [`${HERE}harness.tsx`],
  target: "browser",
  format: "esm",
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    {
      name: "single-react",
      setup(builder) {
        builder.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) => {
          const alias = REACT_ALIASES[args.path];
          return alias === undefined ? undefined : { path: alias };
        });
      },
    },
  ],
});

if (!build.success) {
  for (const log of build.logs) console.error(String(log));
  process.exit(1);
}
const bundle = await build.outputs[0]?.text();
if (bundle === undefined) throw new Error("no bundle output");
console.log(`bundle: ${String(Math.round(bundle.length / 1024))} KB`);

const FILES: Record<string, { readonly path: string; readonly type: string }> = {
  "/": { path: `${HERE}index.html`, type: "text/html" },
  "/harness.css": { path: `${HERE}harness.css`, type: "text/css" },
  "/dockview.css": {
    path: `${HERE}node_modules/dockview/dist/styles/dockview.css`,
    type: "text/css",
  },
  // The REAL application skin, so the control is the control.
  "/plugin.css": { path: `${ROOT}packages/plugin/src/ui/styles.css`, type: "text/css" },
};

const server = Bun.serve({
  port: PORT,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/bundle.js") {
      return new Response(bundle, { headers: { "content-type": "text/javascript" } });
    }
    const file = FILES[path];
    if (file === undefined) return new Response("not found", { status: 404 });
    return new Response(Bun.file(file.path), { headers: { "content-type": file.type } });
  },
});

const browser = new Browser();
const findings: Record<string, unknown> = {};

async function probe(name: string, expression: string): Promise<void> {
  const value = await browser.evaluate<unknown>(
    `JSON.stringify((() => { const api = window.__SPIKE__; if (!api) return { error: "no api" }; return ${expression}; })())`,
  );
  findings[name] = typeof value === "string" ? JSON.parse(value) : value;
}

async function shot(name: string): Promise<void> {
  const reply = await browser.send("Page.captureScreenshot", { format: "png" });
  const data = reply.result?.["data"];
  if (typeof data !== "string") throw new Error(`no screenshot data for ${name}`);
  await Bun.write(`${HERE}shot-${name}.png`, Buffer.from(data, "base64"));
  console.log(`shot: docs/spikes/s126-dockview/shot-${name}.png`);
}

try {
  await browser.launch();
  await browser.send("Emulation.setDeviceMetricsOverride", {
    width: 2790,
    height: 640,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await browser.goto(`http://127.0.0.1:${String(PORT)}/`);

  // Baseline: both renderers up, four live leaves each.
  await probe("baselineOurs", "api.leaves('ours')");
  await probe("baselineDockview", "api.leaves('dockview')");
  await probe("addressability", "api.addressability()");
  await probe("remotePreview", "api.remotePreview()");
  await probe("zones", "api.zones()");
  await probe("rail", "api.rail()");
  await probe("dockOverlay", "api.dockOverlay()");
  await shot("1-baseline");

  // Probe 4 before the structural edits, so the trees are still comparable.
  await probe("resize900", "api.resize(900)");
  await probe("resize560", "api.resize(560)");
  await probe("resizeBack", "api.resize(900)");
  await shot("2-resized");

  /*
    THE KILL CRITERION, PAINTED. A collaborator's carry with no local pointer: the same
    `PaneShift` set written as transforms into both DOMs, plus the landing slot. Screenshot
    it, then undo it so the structural probes below see untouched trees.
  */
  await probe("paintFlip", "api.paintFlip()");
  await Bun.sleep(300);
  await shot("4-collaborator-preview");
  await probe("clearFlip", "api.clearFlip()");
  await Bun.sleep(200);

  // Probe 1: the same structural edit on each side, then who survived.
  await probe("splitOurs", "api.splitOurs()");
  await Bun.sleep(400);
  await probe("afterSplitOurs", "api.leaves('ours')");
  await probe("splitDockview", "api.splitDockview()");
  await Bun.sleep(400);
  await probe("afterSplitDockview", "api.leaves('dockview')");
  await probe("disposed", "api.disposed()");
  await shot("3-after-split");

  // Probe 3: the FLIP.
  await probe("flip", "api.flip()");

  const messages = browser.drainMessages().filter((message) => message.kind !== "log");
  findings["pageErrors"] = messages
    .filter((message) => message.kind === "exception" || message.level === "error")
    .map((message) => message.text)
    .slice(0, 20);

  await Bun.write(`${HERE}findings.json`, `${JSON.stringify(findings, null, 2)}\n`);
  console.log(JSON.stringify(findings, null, 2));
} finally {
  if (!process.argv.includes("--keep")) {
    await browser.close();
    await server.stop(true);
  }
}
