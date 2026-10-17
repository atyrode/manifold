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
//                        and the checks that walk scenes (`walk`, src/verify/kit.ts) walk those
//                        alone, weighed in the shards by that share of their seconds; unset or *
//                        keeps all;
//   --record             rewrites scripts/verify-timings.ts with the seconds of the checks that
//                        pass (of whole checks: not with LANDING_SCENES).
// A line per check goes to stderr, the merged results to stdout as JSON. A failing check does not
// stop the run: every check runs and the failures are listed at the end, with a non-zero exit. A
// page lost meanwhile (its renderer killed or crashed) fails the check it was running, and so does a
// check past its deadline (its page may still run it); either way the browser is relaunched for the
// checks after it. No check is run again. Under GitHub Actions (GITHUB_STEP_SUMMARY) the run adds a
// table of every check's seconds, deadline and outcome, and the browser's version, to the summary.
import { appendFileSync, readFileSync } from "node:fs";
import { Browser, PageLostError } from "../../scripts/cdp.ts";
import {
  checkScenes,
  deadlineSeconds,
  parseScenes,
  parseShard,
  scopedWeights,
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
if (record && scenes !== undefined) {
  throw new Error("--record times whole checks: unset LANDING_SCENES");
}

/** What verify-browser.ts `run` reports through the binding. */
interface Outcome {
  readonly result?: unknown;
  readonly error?: string;
}

/** A check that ran past its deadline: its page may be running it still. */
class CheckOverrun extends Error {}

/** One check's line in the run's summary. */
interface Row {
  readonly name: string;
  readonly seconds: number;
  readonly deadline: number;
  readonly outcome: "PASS" | "FAIL" | "LOST" | "OVERRAN";
}

const build = await Bun.build({
  entrypoints: [`${here}verify-browser.ts`],
  target: "browser",
  define: { LANDING_SCENES: JSON.stringify(scenes?.join(",") ?? "") },
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

/** Opens the checks' page in a browser just launched, with the binding checks report through. */
async function openChecks(): Promise<void> {
  // Bindings added without a context reach every page loaded afterwards, reloads included.
  const bound = await browser.send("Runtime.addBinding", { name: BINDING });
  if (bound.error !== undefined) throw new Error(`cdp Runtime.addBinding: ${bound.error.message}`);
  await browser.goto(String(server.url));
}

/** Starts the named check on the current page and waits for its report, up to `seconds`. */
async function runCheck(name: string, seconds: number): Promise<Outcome> {
  const reported = Promise.withResolvers<string>();
  const unsubscribe = browser.on("Runtime.bindingCalled", (params) => {
    if (params["name"] === BINDING) reported.resolve(String(params["payload"]));
  });
  const timer = setTimeout(() => {
    reported.reject(new CheckOverrun(`check ${name} did not finish within ${seconds} s`));
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

/** The run's checks as a markdown table, with the browser and the scope they ran in. */
function summary(rows: readonly Row[], scope: string): string {
  const failed = rows.filter((row) => row.outcome !== "PASS").length;
  const lines = rows.map(
    (row) => `| ${row.name} | ${row.seconds.toFixed(1)} | ${row.deadline} | ${row.outcome} |`,
  );
  return [
    `### Landing WebGL checks${scope === "" ? "" : ` (${scope})`}`,
    "",
    `${browser.product}: ${rows.length} checks, ${failed} failed`,
    "",
    "| Check | Seconds | Deadline | Outcome |",
    "| --- | ---: | ---: | --- |",
    ...lines,
    "",
    "",
  ].join("\n");
}

const rows: Row[] = [];
let scope = "";
try {
  await browser.launch({ softwareWebgl: true });
  await openChecks();
  console.error(`verify: ${browser.product}`);
  // Each check's name and, for one that walks scenes, the scenes it walks in a run of every scene.
  const registry = await browser.evaluate<[string, string[] | null][]>(
    'import("/checks.js").then(module => module.checks.map(([name, check]) => [name, check.scenes ?? null]))',
  );
  const registered = registry.map(([name]) => name);
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
  if (shard !== undefined) {
    const walks = Object.fromEntries(
      registry.flatMap(([name, walked]) => (walked === null ? [] : [[name, walked] as const])),
    );
    const weights = scenes === undefined ? {} : scopedWeights(walks, recordedSeconds, scenes);
    names = shardChecks(names, recordedSeconds, shard, weights);
  }
  scope = [
    ...(scenes === undefined ? [] : [`covering ${scenes.join(",")}`]),
    ...(shard === undefined ? [] : [`shard ${shard.index}/${shard.count}`]),
  ].join(", ");
  if (scope !== "")
    console.error(`verify: ${names.length} of ${registered.length} checks (${scope})`);
  const results: Record<string, unknown> = {};
  const passed: Record<string, number> = {};
  const failures: string[] = [];
  for (const name of names) {
    const deadline = fixedSeconds ?? deadlineSeconds(name, recordedSeconds);
    const started = performance.now();
    let outcome: Outcome;
    let gone: Row["outcome"] | undefined;
    try {
      await browser.reload();
      browser.drainMessages();
      outcome = await runCheck(name, deadline);
    } catch (error) {
      if (error instanceof PageLostError) gone = "LOST";
      else if (error instanceof CheckOverrun) gone = "OVERRAN";
      outcome = { error: error instanceof Error ? error.message : String(error) };
    }
    const seconds = (performance.now() - started) / 1000;
    const took = `${seconds.toFixed(1)} s`;
    if (outcome.error === undefined) {
      results[name] = outcome.result;
      passed[name] = seconds;
      rows.push({ name, seconds, deadline, outcome: "PASS" });
      console.error(`PASS  ${name} (${took})`);
      continue;
    }
    const said = browser.drainMessages().map(({ level, text }) => `\n  page ${level}: ${text}`);
    const failure = `${name} (${took}): ${outcome.error}${said.join("")}`;
    failures.push(failure);
    rows.push({ name, seconds, deadline, outcome: gone ?? "FAIL" });
    console.error(`FAIL  ${failure}`);
    if (gone !== undefined) {
      // A page that is gone, or may still be running the check, takes the browser with it; the
      // check is not run again.
      console.error(`verify: relaunching the browser for the checks after ${name}`);
      await browser.relaunch();
      await openChecks();
    }
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
  if (failures.length > 0) {
    console.error(
      `verify: ${failures.length} of ${names.length} checks failed\n` +
        failures.map((failure) => `FAIL  ${failure}`).join("\n"),
    );
    process.exitCode = 1;
  }
} finally {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile !== undefined && summaryFile !== "" && rows.length > 0)
    appendFileSync(summaryFile, summary(rows, scope));
  await browser.close();
  await server.stop(true);
}
