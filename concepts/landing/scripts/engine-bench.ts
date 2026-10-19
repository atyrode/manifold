// bun concepts/landing/scripts/engine-bench.ts [--cells WxH] [--frames N] [--warmup N] [--hold S]
//                                             [--shots DIR] [--still] [--source] [--whole] [doc...]
//
// The engine's starter documents (src/engine/docs.ts) timed in headless Chromium with software
// WebGL (SwiftShader), as the lab's checks and a machine without a GPU draw them: each on the GPU
// timing page (bench.html, its dev-only `canvas:<doc>` entries) loaded afresh, every frame waiting
// for its draw (`sync=1`), at the landing's cell budget unless --cells says otherwise. A doc is its
// title in kebab case (`lava-room`); none names every one. A line per doc: its program's compile
// and link, a frame's main-thread time with its draw, the GPU's time for each draw (a strip while
// the renderer draws the picture in strips, src/strips.ts), the strips and a whole picture's GPU
// time; --whole draws every picture whole (`strips=off`), to time it so. --hold keeps each drawing
// that many seconds once warm (a lost context fails it). --shots writes each doc's picture as its
// run ends to DIR/<doc>.png; --still stands the motion clock and --source shows the source rather
// than its dither, to compare pictures across builds. The reports go to
// /tmp/landing-engine-bench.json; the run exits 1 when a doc fails to draw.
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { Browser, PageLostError } from "../../../scripts/cdp.ts";
import bench from "../bench.html";
import { canvasDocs, exampleDocs } from "../src/engine/docs.ts";

class EngineBenchError extends Error {}

const WINDOW = { width: 1440, height: 900 } as const;
/** How long a doc may take, past its hold: SwiftShader compiles a large program for tens of seconds. */
const DOC_SECONDS = 240;
const REPORT = "/tmp/landing-engine-bench.json";

function usage(message: string): never {
  console.error(
    `engine-bench: ${message}\nusage: bun concepts/landing/scripts/engine-bench.ts [--cells WxH] ` +
      "[--frames N] [--warmup N] [--hold S] [--shots DIR] [--still] [--source] [--whole] [doc...]",
  );
  process.exit(2);
}

const slugs = [...canvasDocs, ...exampleDocs].map((doc) =>
  doc.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
);
const options = { cells: "960x540", frames: "12", warmup: "3", hold: "0", shots: "" };
let still = false;
let source = false;
let whole = false;
const docs: string[] = [];
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index] ?? "";
  if (arg === "--still") still = true;
  else if (arg === "--source") source = true;
  else if (arg === "--whole") whole = true;
  else if (arg.startsWith("--")) {
    const key = arg.slice(2);
    const value = args[(index += 1)];
    if (!(key in options) || value === undefined) usage(`bad option ${arg}`);
    options[key as keyof typeof options] = value;
  } else if (slugs.includes(arg)) docs.push(arg);
  else usage(`no starter doc ${arg} (${slugs.join(", ")})`);
}
if (!/^\d+x\d+$/.test(options.cells)) usage("--cells takes WxH");
// The page's form takes no fewer (an invalid form never submits).
if (!(Number(options.frames) >= 10)) usage("--frames takes 10 or more");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  development: { hmr: false },
  routes: { "/bench.html": bench },
});
const browser = new Browser();

const spread = z.object({ median: z.number(), p95: z.number() }).nullable();
/** What the script reads of the page's report (src/bench.ts SceneReport). */
const Report = z.object({
  scenes: z.array(
    z.object({
      cells: z.string(),
      compileMs: z.number().nullable(),
      linkMs: z.number().nullable(),
      frames: z.number(),
      cpuMs: spread,
      gpuMs: spread,
      strips: z.number().nullable(),
      pictureMs: z.number().nullable(),
      error: z.string().optional(),
    }),
  ),
});

/** The page's state: whether the run has ended, its status line and its report. */
async function state(): Promise<{ ended: boolean; status: string; report: string } | undefined> {
  return await browser
    .evaluate<{ ended: boolean; status: string; report: string }>(
      `({ ended: document.querySelector("#run").disabled === false,
          status: document.querySelector("#status").textContent ?? "",
          report: document.querySelector("#report").value })`,
    )
    .catch((error: unknown) => {
      // A page busy in a long synchronous call answers late: ask again.
      if (error instanceof PageLostError) throw error;
      return undefined;
    });
}

const reports: unknown[] = [];
let failed = false;
try {
  await browser.launch({ softwareWebgl: true });
  const metrics = await browser.send("Emulation.setDeviceMetricsOverride", {
    ...WINDOW,
    deviceScaleFactor: 1,
    mobile: false,
  });
  if (metrics.error !== undefined) throw new EngineBenchError(metrics.error.message);
  // The stage at its size in the window's corner, for --shots.
  const style = await browser.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "#stage-box { transform: none !important; }";
      document.head.append(style);
    });`,
  });
  if (style.error !== undefined) throw new EngineBenchError(style.error.message);
  if (options.shots !== "") await mkdir(options.shots, { recursive: true });
  const hold = Number(options.hold);
  for (const doc of docs.length > 0 ? docs : slugs) {
    const query = new URLSearchParams({
      scenes: `canvas:${doc}`,
      cells: options.cells,
      frames: options.frames,
      warmup: options.warmup,
      sync: "1",
      auto: "1",
      ...(hold > 0 ? { hold: String(hold) } : {}),
      ...(still ? { still: "1" } : {}),
      ...(source ? { view: "source" } : {}),
      ...(whole ? { strips: "off" } : {}),
    });
    await browser.goto(`${String(server.url)}bench.html?${String(query)}`);
    const started = performance.now();
    let ended: { status: string; report: string } | undefined;
    while (ended === undefined) {
      if (performance.now() - started > (DOC_SECONDS + hold) * 1000)
        throw new EngineBenchError(`${doc}: no result within ${DOC_SECONDS + hold} s`);
      await Bun.sleep(2000);
      const now = await state();
      if (now?.ended === true && now.status !== "") ended = now;
    }
    const report = Report.parse(JSON.parse(ended.report));
    reports.push(report);
    const row = report.scenes[0];
    if (row === undefined) {
      failed = true;
      console.log(`${doc}: ${ended.status}`);
      continue;
    }
    if (row.error !== undefined) failed = true;
    console.log(
      [
        doc.padEnd(12),
        row.cells.padStart(8),
        `compile ${String(row.compileMs ?? "-").padStart(8)} ms`,
        `link ${String(row.linkMs ?? "-").padStart(8)} ms`,
        `draw ${String(row.cpuMs?.median ?? "-").padStart(8)} ms`,
        `p95 ${String(row.cpuMs?.p95 ?? "-").padStart(8)} ms`,
        `gpu ${String(row.gpuMs?.median ?? "-").padStart(8)} ms`,
        `strips ${String(row.strips ?? "-").padStart(2)}`,
        `picture ${String(row.pictureMs ?? "-").padStart(8)} ms`,
        `${String(row.frames)} frames`,
        row.error ?? "",
      ].join("  "),
    );
    if (options.shots !== "") {
      const box = await browser.evaluate<{ x: number; y: number; width: number; height: number }>(
        `(() => { const r = document.querySelector("#stage").getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
      );
      const shot = await browser.send("Page.captureScreenshot", {
        format: "png",
        clip: { ...box, scale: 1 },
      });
      const data = shot.result?.["data"];
      if (shot.error !== undefined || typeof data !== "string")
        throw new EngineBenchError(`${doc}: no screenshot`);
      await Bun.write(`${options.shots}/${doc}.png`, Buffer.from(data, "base64"));
    }
  }
} finally {
  await Bun.write(REPORT, JSON.stringify(reports, null, 2));
  await browser.close();
  await server.stop(true);
}
console.log(`reports: ${REPORT}`);
if (failed) process.exit(1);
