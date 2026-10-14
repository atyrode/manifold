// bun concepts/landing/verify.ts — isolated Chromium, actual shaders/renderer/simulations.
import { Browser } from "../../scripts/cdp.ts";

const build = await Bun.build({
  entrypoints: [new URL("./verify-browser.ts", import.meta.url).pathname],
  target: "browser",
});
if (!build.success || !build.outputs[0]) throw new Error(build.logs.map(String).join("\n"));
const bundle = await build.outputs[0].text();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    return new URL(request.url).pathname === "/checks.js"
      ? new Response(bundle, { headers: { "content-type": "text/javascript" } })
      : new Response("<!doctype html><title>Landing regressions</title>", {
          headers: { "content-type": "text/html" },
        });
  },
});
const browser = new Browser();
try {
  await browser.launch({ softwareWebgl: true });
  await browser.goto(String(server.url));
  const result = await browser.evaluate<unknown>(
    'import("/checks.js").then(module => module.verify())',
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  await server.stop(true);
}
