// bun concepts/landing/verify.ts [--shard i/n] [--record] [check...] — isolated Chromium, actual
// shaders/renderer/simulations. Runs every check registered in verify-browser.ts (or only the named
// ones), each on a freshly loaded page so no check inherits another's state. A check is started in
// the page and reports through a page binding when done, so it is bounded by its own deadline
// rather than the driver's per-call one: three times the seconds it last took
// (scripts/verify-timings.ts), never under 180 s, or LANDING_CHECK_SECONDS for every check when
// that is set. A check whose renderer crashes or is killed fails at once, not at that deadline.
//   --shard i/n          runs the ith of n disjoint shares of the checks, balanced by those
//                        recorded seconds (CI runs four);
//   LANDING_SCENES=a,b   keeps only the checks that cover those scenes (scripts/verify-plan.ts),
//                        and runs the passage speed check on them alone; unset or * keeps all;
//   --record             rewrites scripts/verify-timings.ts with the seconds of the checks that
//                        pass (of whole checks: not with LANDING_SCENES or LANDING_PASSAGE_SCENES).
// A line per check goes to stderr, the merged results to stdout as JSON; the run stops at the
// first failure and exits non-zero, naming it.
import { readFileSync } from "node:fs";
import { Browser } from "../../scripts/cdp.ts";
import {
  checkScenes,
  deadlineSeconds,
  parseScenes,
  parseShard,
  shardChecks,
  timingsModule,
  type Shard,
} from "./scripts/verify-plan.ts";
import { recordedSeconds } from "./scripts/verify-timings.ts";
import { sceneIds } from "./src/scenes/index.ts";

const BINDING = "landingCheckDone";
const here = new URL(".", import.meta.url).pathname;

const args = process.argv.slice(2);
let shard: Shard | undefined;
let record = false;
const requested: string[] = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index] ?? "";
  if (arg === "--shard") {
    index += 1;
    shard = parseShard(args[index] ?? "");
  } else if (arg === "--record") record = true;
  else requested.push(arg);
}
const everyCheck = process.env.LANDING_CHECK_SECONDS;
const fixedSeconds = everyCheck === undefined ? undefined : Number(everyCheck);
if (fixedSeconds !== undefined && !(Number.isFinite(fixedSeconds) && fixedSeconds > 0)) {
  throw new Error(`LANDING_CHECK_SECONDS must be a positive number of seconds, not ${everyCheck}`);
}
const scenes = parseScenes(process.env.LANDING_SCENES, sceneIds);
// LANDING_PASSAGE_SCENES=a,b limits the passage speed check to those scenes while tuning them.
const passageScenes = process.env.LANDING_PASSAGE_SCENES ?? scenes?.join(",") ?? "";
if (record && passageScenes !== "") {
  throw new Error("--record times whole checks: unset LANDING_SCENES and LANDING_PASSAGE_SCENES");
}

/** What verify-browser.ts `run` reports through the binding. */
interface Outcome {
  readonly result?: unknown;
  readonly error?: string;
}

const build = await Bun.build({
  entrypoints: [`${here}verify-browser.ts`],
  target: "browser",
  define: { LANDING_PASSAGE_SCENES: JSON.stringify(passageScenes) },
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

/** Starts the named check on the current page and waits for its report, up to `seconds`. */
async function runCheck(name: string, seconds: number): Promise<Outcome> {
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
  const unknown = requested.filter((name) => !registered.includes(name));
  if (unknown.length > 0) {
    throw new Error(`No check named ${unknown.join(", ")}; registered: ${registered.join(", ")}`);
  }
  let names = requested.length > 0 ? requested : registered;
  if (scenes !== undefined) {
    const covered = checkScenes(
      readFileSync(`${here}verify-browser.ts`, "utf8"),
      (path) => {
        try {
          return readFileSync(`${here}${path}`, "utf8");
        } catch {
          return undefined;
        }
      },
      sceneIds,
    );
    names = names.filter((name) => {
      const covers = covered.get(name);
      return covers === undefined || scenes.some((id) => covers.has(id));
    });
  }
  if (shard !== undefined) names = shardChecks(names, recordedSeconds, shard);
  if (scenes !== undefined || shard !== undefined) {
    const scope = [
      ...(scenes === undefined ? [] : [`covering ${scenes.join(",")}`]),
      ...(shard === undefined ? [] : [`shard ${shard.index}/${shard.count}`]),
    ];
    console.error(`verify: ${names.length} of ${registered.length} checks (${scope.join(", ")})`);
  }
  const results: Record<string, unknown> = {};
  const passed: Record<string, number> = {};
  let failure: string | undefined;
  for (const name of names) {
    await browser.reload();
    browser.drainMessages();
    const started = performance.now();
    const took = (): string => `${((performance.now() - started) / 1000).toFixed(1)} s`;
    let outcome: Outcome;
    try {
      outcome = await runCheck(name, fixedSeconds ?? deadlineSeconds(name, recordedSeconds));
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : String(error) };
    }
    if (outcome.error !== undefined) {
      const said = browser.drainMessages().map(({ level, text }) => `\n  page ${level}: ${text}`);
      failure = `${name} (${took()}): ${outcome.error}${said.join("")}`;
      break;
    }
    results[name] = outcome.result;
    passed[name] = (performance.now() - started) / 1000;
    console.error(`PASS  ${name} (${took()})`);
  }
  console.log(JSON.stringify(results, null, 2));
  if (record) {
    const kept = Object.entries(recordedSeconds).filter(([name]) => registered.includes(name));
    await Bun.write(
      `${here}scripts/verify-timings.ts`,
      timingsModule({ ...Object.fromEntries(kept), ...passed }),
    );
    console.error(`verify: recorded ${Object.keys(passed).length} checks' seconds`);
  }
  if (failure !== undefined) {
    console.error(`FAIL  ${failure}`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  await server.stop(true);
}
