// bun concepts/landing/verify.ts [check...] — isolated Chromium, actual shaders/renderer/simulations.
// Runs every check registered in verify-browser.ts (or only the named ones), each on a freshly
// loaded page so no check inherits another's state. A check is started in the page and reports
// through a page binding when done, so it is bounded by its own deadline (LANDING_CHECK_SECONDS,
// default 180) rather than the driver's per-call one; a check whose renderer crashes or is killed
// fails at once, not at that deadline. A line per check goes to stderr, the merged results to
// stdout as JSON; the run stops at the first failure and exits non-zero, naming it.
import { Browser } from "../../scripts/cdp.ts";

const BINDING = "landingCheckDone";
const seconds = Number(process.env.LANDING_CHECK_SECONDS ?? 180);
if (!Number.isFinite(seconds) || seconds <= 0) {
  throw new Error(`LANDING_CHECK_SECONDS must be a positive number of seconds, not ${seconds}`);
}

/** What verify-browser.ts `run` reports through the binding. */
interface Outcome {
  readonly result?: unknown;
  readonly error?: string;
}

const build = await Bun.build({
  entrypoints: [new URL("./verify-browser.ts", import.meta.url).pathname],
  target: "browser",
  // LANDING_PASSAGE_SCENES=a,b limits the passage speed check to those scenes while tuning them.
  define: {
    LANDING_PASSAGE_SCENES: JSON.stringify(process.env.LANDING_PASSAGE_SCENES ?? ""),
  },
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

/** Starts the named check on the current page and waits for its report, up to the deadline. */
async function runCheck(name: string): Promise<Outcome> {
  const reported = Promise.withResolvers<string>();
  const unsubscribe = browser.on("Runtime.bindingCalled", (params) => {
    if (params["name"] === BINDING) reported.resolve(String(params["payload"]));
  });
  const timer = setTimeout(() => {
    reported.reject(new Error(`check ${name} did not finish within ${seconds} s`));
  }, seconds * 1000);
  try {
    // Not browser.evaluate, and started in a later task: the page answers no protocol call while a
    // check runs, so this call must have answered before the check begins.
    const started = await browser.send("Runtime.evaluate", {
      expression: `setTimeout(() => import("/checks.js").then(
        (module) => module.run(${JSON.stringify(name)}, ${BINDING}),
        (error) => ${BINDING}(JSON.stringify({ error: String(error?.stack ?? error) })),
      ))`,
      returnByValue: true,
    });
    if (started.error !== undefined)
      throw new Error(`cdp Runtime.evaluate: ${started.error.message}`);
    // verify-browser.ts `run` reports exactly this shape. A page that dies meanwhile (earlyoom
    // kills renderers first) never reports, so its loss ends the wait.
    return JSON.parse(await Promise.race([reported.promise, browser.lost])) as Outcome;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

try {
  await browser.launch({ softwareWebgl: true });
  // Bindings added without a context reach every page loaded afterwards, reloads included.
  const bound = await browser.send("Runtime.addBinding", { name: BINDING });
  if (bound.error !== undefined) throw new Error(`cdp Runtime.addBinding: ${bound.error.message}`);
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
    let outcome: Outcome;
    try {
      outcome = await runCheck(name);
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : String(error) };
    }
    if (outcome.error !== undefined) {
      const said = browser.drainMessages().map(({ level, text }) => `\n  page ${level}: ${text}`);
      failure = `${name} (${took()}): ${outcome.error}${said.join("")}`;
      break;
    }
    results[name] = outcome.result;
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
