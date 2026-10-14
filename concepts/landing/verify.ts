// bun concepts/landing/verify.ts [check...] — isolated Chromium, actual shaders/renderer/simulations.
// Runs every check registered in verify-browser.ts (or only the named ones), each in its own
// evaluation on a freshly loaded page, so no check inherits another's state or shares the driver's
// per-call deadline. A line per check goes to stderr, the merged results to stdout as JSON; the run
// stops at the first failure and exits non-zero, naming it.
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
  const registered = await browser.evaluate<string[]>(
    'import("/checks.js").then(module => module.checks.map(([name]) => name))',
  );
  const twice = registered.filter((name, index) => registered.indexOf(name) !== index);
  if (twice.length > 0) throw new Error(`Checks registered twice: ${twice.join(", ")}`);
  const requested = process.argv.slice(2);
  const unknown = requested.filter((name) => !registered.includes(name));
  if (unknown.length > 0) {
    throw new Error(`No check named ${unknown.join(", ")}; registered: ${registered.join(", ")}`);
  }
  const results: Record<string, unknown> = {};
  let failure: string | undefined;
  for (const name of requested.length > 0 ? requested : registered) {
    await browser.reload();
    browser.drainMessages();
    const started = performance.now();
    const took = (): string => `${((performance.now() - started) / 1000).toFixed(1)} s`;
    try {
      results[name] = await browser.evaluate<unknown>(
        `import("/checks.js").then(module => module.run(${JSON.stringify(name)}))`,
      );
    } catch (error) {
      const said = browser.drainMessages().map(({ level, text }) => `\n  page ${level}: ${text}`);
      const reason = error instanceof Error ? error.message : String(error);
      failure = `${name} (${took()}): ${reason}${said.join("")}`;
      break;
    }
    console.error(`PASS  ${name} (${took()})`);
  }
  console.log(JSON.stringify(results, null, 2));
  if (failure !== undefined) {
    console.error(`FAIL  ${failure}`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  await server.stop(true);
}
