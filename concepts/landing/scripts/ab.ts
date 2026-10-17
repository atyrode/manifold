// bun concepts/landing/scripts/ab.ts [--base <rev>] [--out <dir>] [--size WxH] [--seconds N]
//                                   [--presets] [--all] [setting...]
//
// Whether the lab still draws what it drew: each setting renders from this working tree (head) and
// from the base revision (default HEAD: the uncommitted edits), each tree built as serve.ts builds
// a commit, in one software-WebGL Chromium, with the clocks frozen (prefers-reduced-motion, as a
// reduced-motion visitor sees the page) until the picture holds still; then the two pictures'
// pixels are compared. A setting is a page query (`scene=country&time=0.3`) or a bare scene id; by
// default every scene at its defaults, dithered and `view=source`, and --presets adds every
// committed preset.
//
// A scene whose generated GLSL (its default and all-features programs) and every file its page
// loads (index.html and its imports, short of other scenes' directories) are byte for byte the same
// in both trees cannot draw differently, so it is skipped unless --all. Each differing setting gets
// <slug>.base.png, <slug>.head.png and <slug>.diff.png (differing cells bright, the rest dimmed) in
// --out (default /tmp/landing-ab), beside report.json. A line per setting goes to stdout; the run
// exits 1 when a setting differs, fails to draw or never holds still.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { deflateSync } from "node:zlib";
import { Browser } from "../../../scripts/cdp.ts";
import { presets } from "../src/presets.ts";
import { buildSite, extractTree } from "./site.ts";

class AbError extends Error {}

const here = new URL("..", import.meta.url).pathname;
const repo = join(here, "..", "..");
const BINDING = "landingAbDone";
/**
 * A picture is taken once its pixels have held for this long, with no request to a worker (the
 * pond's sheets) unanswered and none answered meanwhile, or once nothing redraws it.
 */
const STILL_MS = 1500;
/** The scene list, which imports every scene: what it leads to in other scenes is theirs alone. */
const ROSTER = "src/scenes/index.ts";
const SCENE_DIR = /^src\/scenes\/([a-z][a-z0-9]*)\//;

function usage(message: string): never {
  console.error(
    `ab: ${message}\nusage: bun concepts/landing/scripts/ab.ts [--base <rev>] [--out <dir>] ` +
      "[--size WxH] [--seconds N] [--presets] [--all] [setting...]",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
let baseRev = "HEAD";
let out = "/tmp/landing-ab";
let size = "384x240";
let seconds = 120;
let withPresets = false;
let everything = false;
const asked: string[] = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index] ?? "";
  const value = (): string => {
    index += 1;
    const next = args[index];
    if (next === undefined || next.startsWith("--")) usage(`${arg} needs a value`);
    return next;
  };
  if (arg === "--base") baseRev = value();
  else if (arg === "--out") out = value();
  else if (arg === "--size") size = value();
  else if (arg === "--seconds") seconds = Number(value());
  else if (arg === "--presets") withPresets = true;
  else if (arg === "--all") everything = true;
  else if (arg.startsWith("--")) usage(`unknown option ${arg}`);
  else asked.push(arg.includes("=") ? arg : `scene=${arg}`);
}
const [width = 0, height = 0] = size.split("x").map(Number);
if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0))
  usage(`--size takes WxH in CSS pixels, not ${size}`);
if (!(seconds > 0)) usage("--seconds takes a positive number");

async function git(...gitArgs: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repo, ...gitArgs], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new AbError(`git ${gitArgs.join(" ")}: ${stderr.trim()}`);
  return stdout.trim();
}

/** A lab tree (a concepts/landing directory): its scenes, and its files by path, each read once. */
class Tree {
  readonly root: string;
  readonly scenes: readonly string[];
  readonly #files = new Map<string, Buffer | undefined>();
  readonly #imports = new Map<string, readonly string[]>();
  readonly #transpiler = new Bun.Transpiler({ loader: "ts" });

  constructor(root: string) {
    this.root = root;
    this.scenes = readdirSync(join(root, "src", "scenes"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(root, "src", "scenes", name, "index.ts")));
  }

  file(path: string): Buffer | undefined {
    if (!this.#files.has(path)) {
      const at = join(this.root, path);
      this.#files.set(path, existsSync(at) ? readFileSync(at) : undefined);
    }
    return this.#files.get(path);
  }

  /** What `path` loads: a page's scripts and styles, a module's imports. */
  imports(path: string): readonly string[] {
    const known = this.#imports.get(path);
    if (known !== undefined) return known;
    const text = this.file(path)?.toString("utf8") ?? "";
    const specifiers = path.endsWith(".html")
      ? [...text.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((match) => match[1] ?? "")
      : /\.[cm]?[jt]sx?$/.test(path)
        ? this.#transpiler.scanImports(text).map((entry) => entry.path)
        : [];
    const found = specifiers
      .filter((specifier) => specifier.startsWith("."))
      .map((specifier) => normalize(join(dirname(path), specifier)));
    this.#imports.set(path, found);
    return found;
  }

  /** Every file the page loads to draw `scene`: the scene list leads only into its directory. */
  inputs(scene: string): ReadonlySet<string> {
    const seen = new Set<string>();
    // The build worker's entry; trees before it had the sheet worker's.
    const queue = ["index.html", "src/build-worker.ts", "src/sheet-worker.ts"];
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      if (seen.has(path)) continue;
      seen.add(path);
      for (const target of this.imports(path)) {
        const dir = SCENE_DIR.exec(target)?.[1];
        if (path !== ROSTER || dir === undefined || dir === scene) queue.push(target);
      }
    }
    return seen;
  }
}

/** What GLSL generation needs of a tree's shader and scene modules. */
interface ShaderModule {
  fragmentSourceFor(scene: unknown, features?: unknown): string;
  sceneFeaturesAll?(scene: unknown): unknown;
}
interface SceneModule {
  readonly sceneDefs: Readonly<Record<string, unknown>>;
}

/** Each scene's default and all-features fragment sources as `tree` generates them. */
async function glslOf(tree: Tree): Promise<ReadonlyMap<string, string>> {
  const sources = new Map<string, string>();
  try {
    // The base tree is extracted to a temporary directory, so its modules are named at run time.
    const shaders = (await import(join(tree.root, "src/shaders/index.ts"))) as ShaderModule;
    const scenes = (await import(join(tree.root, "src/scenes/index.ts"))) as SceneModule;
    for (const [id, def] of Object.entries(scenes.sceneDefs)) {
      try {
        const all = shaders.sceneFeaturesAll?.(def);
        const allSource = all === undefined ? "" : shaders.fragmentSourceFor(def, all);
        sources.set(id, `${shaders.fragmentSourceFor(def)}\0${allSource}`);
      } catch {
        // Left out: a scene whose source does not generate is rendered, not taken as unchanged.
      }
    }
  } catch (error: unknown) {
    console.error(`ab: ${tree.root} generates no GLSL (${String(error)}); rendering its scenes`);
  }
  return sources;
}

/** Why `scene` must be rendered, or undefined when nothing it is drawn from changed. */
function changed(
  scene: string,
  trees: { readonly base: Tree; readonly head: Tree },
  glsl: { readonly base: ReadonlyMap<string, string>; readonly head: ReadonlyMap<string, string> },
): string | undefined {
  const { base, head } = trees;
  const paths = new Set([...base.inputs(scene), ...head.inputs(scene)]);
  const differ = [...paths].filter((path) => {
    const [before, after] = [base.file(path), head.file(path)];
    return before === undefined || after === undefined ? before !== after : !before.equals(after);
  });
  if (differ.length > 3) return `${differ.slice(0, 3).join(", ")} and ${differ.length - 3} more`;
  if (differ.length > 0) return differ.join(", ");
  const [before, after] = [glsl.base.get(scene), glsl.head.get(scene)];
  return before === undefined || before !== after ? "its generated GLSL" : undefined;
}

// Installed in every page before its own scripts. The page's animation frames run only when
// `__landingAb` drives them, each from a real one, and a frame's pixels are read back in the same
// task, right after it drew to the screen; a frame that draws nothing leaves the picture as it was.
// Messages to and from workers are counted: a request in flight still changes the picture.
const PAGE_HOOK = `(() => {
  const nativeFrame = window.requestAnimationFrame.bind(window);
  let queue = [];
  let nextId = 1;
  window.requestAnimationFrame = (callback) => {
    queue.push({ id: nextId, callback });
    return nextId++;
  };
  window.cancelAnimationFrame = (id) => {
    queue = queue.filter((entry) => entry.id !== id);
  };
  let stage = null;
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
    const context = getContext.call(this, kind, ...rest);
    if (kind === "webgl2" && this.id === "stage" && context !== null) stage = context;
    return context;
  };
  let unanswered = 0;
  let answered = 0;
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", () => {
        unanswered -= 1;
        answered = performance.now();
      });
    }
    postMessage(...args) {
      unanswered += 1;
      return super.postMessage(...args);
    }
  };
  const toScreen = new WeakMap();
  let presented = false;
  const proto = WebGL2RenderingContext.prototype;
  const bindFramebuffer = proto.bindFramebuffer;
  proto.bindFramebuffer = function (target, framebuffer) {
    if (target !== this.READ_FRAMEBUFFER) toScreen.set(this, framebuffer === null);
    return bindFramebuffer.call(this, target, framebuffer);
  };
  const draws = ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced"];
  for (const name of [...draws, "drawRangeElements"]) {
    const draw = proto[name];
    proto[name] = function (...args) {
      if (this === stage && toScreen.get(this) !== false) presented = true;
      return draw.apply(this, args);
    };
  }
  const hash = (bytes) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i += 1) h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0;
    return h.toString(16).padStart(8, "0");
  };
  const base64 = (bytes) => {
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(text);
  };
  window.__landingAb = async ({ stillMs, deadlineMs }) => {
    const started = performance.now();
    let last = "";
    let pixels = null;
    let width = 0;
    let height = 0;
    let frames = 0;
    let since = started;
    for (;;) {
      const now = await new Promise((resolve) => nativeFrame(resolve));
      const due = queue;
      queue = [];
      presented = false;
      for (const { callback } of due) {
        try {
          callback(now);
        } catch (error) {
          console.error("evt=landing.ab.frame_failed", error);
        }
      }
      if (presented && stage !== null) {
        const gl = stage;
        width = gl.drawingBufferWidth;
        height = gl.drawingBufferHeight;
        const bytes = new Uint8Array(width * height * 4);
        const reading = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, reading);
        frames += 1;
        const next = hash(bytes);
        if (next !== last) since = performance.now();
        last = next;
        pixels = bytes;
      }
      const ms = performance.now() - started;
      const quiet = unanswered <= 0 && performance.now() - answered >= stillMs;
      const settled = frames > 0 && quiet && performance.now() - since >= stillMs;
      if (settled || ms > deadlineMs) {
        const status = settled ? "settled" : frames === 0 ? "blank" : "moving";
        const data = pixels === null ? "" : base64(pixels);
        return { status, hash: last, width, height, frames, ms, pixels: data };
      }
    }
  };
})();`;

/** A page's picture as it reported it, and what the page said meanwhile that means it failed. */
interface Shot {
  readonly status: "settled" | "blank" | "moving" | "failed";
  readonly hash: string;
  readonly width: number;
  readonly height: number;
  /** Frames that drew to the screen. */
  readonly frames: number;
  readonly ms: number;
  /** The picture's RGBA bytes, rows bottom up as readPixels gives them, in base64. */
  readonly pixels: string;
  readonly error?: string;
  readonly failures?: readonly string[];
}

/** Why a picture is no proof either way, or undefined for a still one. */
function trouble(shot: Omit<Shot, "pixels">): string | undefined {
  switch (shot.status) {
    case "settled":
      return undefined;
    case "moving":
      return `never held still within ${seconds} s`;
    case "blank":
      return `drew nothing within ${seconds} s`;
    case "failed":
      return `failed: ${[shot.error ?? "", ...(shot.failures ?? [])].filter(Boolean).join("; ")}`;
    default: {
      const status: never = shot.status;
      return `reported ${String(status)}`;
    }
  }
}

const browser = new Browser();

async function open(url: string): Promise<void> {
  const loaded = Promise.withResolvers<void>();
  const unsubscribe = browser.on("Page.loadEventFired", () => loaded.resolve());
  const timer = setTimeout(() => loaded.reject(new AbError(`${url} did not load`)), 60_000);
  try {
    const sent = await browser.send("Page.navigate", { url });
    if (sent.error !== undefined) throw new AbError(`cdp Page.navigate: ${sent.error.message}`);
    await Promise.race([loaded.promise, browser.lost]);
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

/** Loads `url`, drives its frames until its picture holds still, and takes the picture. */
async function shoot(url: string): Promise<Shot> {
  browser.drainMessages();
  await open(url);
  const reported = Promise.withResolvers<string>();
  const unsubscribe = browser.on("Runtime.bindingCalled", (params) => {
    if (params["name"] === BINDING) reported.resolve(String(params["payload"]));
  });
  const backstop = seconds + 60;
  const timer = setTimeout(
    () => reported.reject(new AbError(`${url} answered nothing within ${backstop} s`)),
    backstop * 1000,
  );
  try {
    const options = JSON.stringify({ stillMs: STILL_MS, deadlineMs: seconds * 1000 });
    // Started in a later task, as verify.ts starts a check: the page answers no protocol call
    // while a program builds.
    const started = await browser.send("Runtime.evaluate", {
      expression: `setTimeout(() => window.__landingAb(${options}).then(
        (shot) => ${BINDING}(JSON.stringify(shot)),
        (error) => ${BINDING}(JSON.stringify({ status: "failed", error: String(error?.stack ?? error) })),
      ))`,
      returnByValue: true,
    });
    if (started.error !== undefined)
      throw new AbError(`cdp Runtime.evaluate: ${started.error.message}`);
    const shot = JSON.parse(await Promise.race([reported.promise, browser.lost])) as Shot;
    const failed = /evt=landing\.(?:renderer\.(?:scene_failed|unavailable)|ab\.frame_failed)/;
    const failures = browser
      .drainMessages()
      .map(({ text }) => text)
      .filter((text) => failed.test(text));
    return failures.length > 0 ? { ...shot, status: "failed", failures } : shot;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** An RGBA PNG of `rgba`, whose rows run bottom up as readPixels gives them. */
function png(pictureWidth: number, pictureHeight: number, rgba: Uint8Array): Uint8Array {
  const stride = pictureWidth * 4;
  const raw = new Uint8Array((stride + 1) * pictureHeight);
  for (let y = 0; y < pictureHeight; y += 1) {
    const row = rgba.subarray((pictureHeight - 1 - y) * stride, (pictureHeight - y) * stride);
    raw.set(row, y * (stride + 1) + 1);
  }
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const bytes = new Uint8Array(12 + data.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, data.length);
    bytes.set(new TextEncoder().encode(type), 4);
    bytes.set(data, 8);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(4, 8 + data.length)) {
      crc = (CRC[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
    }
    view.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0);
    return bytes;
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, pictureWidth);
  new DataView(header.buffer).setUint32(4, pictureHeight);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const file = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    file.set(part, at);
    at += part.length;
  }
  return file;
}

/** Where two same-sized pictures differ: how many cells, their bounds, and a picture of them. */
function diff(
  pictureWidth: number,
  before: Uint8Array,
  after: Uint8Array,
): { readonly cells: number; readonly box: string; readonly image: Uint8Array } {
  const rowsUp = after.length / 4 / pictureWidth;
  const image = new Uint8Array(after.length);
  let cells = 0;
  let [left, right, top, bottom] = [Infinity, -Infinity, Infinity, -Infinity];
  for (let at = 0; at < after.length; at += 4) {
    const same = [0, 1, 2, 3].every((channel) => before[at + channel] === after[at + channel]);
    const luma = ((after[at] ?? 0) + (after[at + 1] ?? 0) + (after[at + 2] ?? 0)) / 3;
    const grey = Math.round(luma * 0.3);
    image.set(same ? [grey, grey, grey, 255] : [255, 0, 170, 255], at);
    if (same) continue;
    cells += 1;
    // readPixels rows run bottom up; the bounds are in picture rows, top down.
    const x = (at / 4) % pictureWidth;
    const y = rowsUp - 1 - Math.floor(at / 4 / pictureWidth);
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  return { cells, box: `x ${left}-${right}, y ${top}-${bottom}`, image };
}

type Outcome = "same" | "differs" | "skipped" | "failed" | "added" | "removed";

interface Render {
  readonly setting: string;
  readonly outcome: Outcome;
  readonly reason: string;
  readonly base?: Omit<Shot, "pixels">;
  readonly head?: Omit<Shot, "pixels">;
  readonly files?: readonly string[];
}

const work = await mkdtemp(join(tmpdir(), "landing-ab-"));
const stops: (() => Promise<void>)[] = [];
try {
  const sha = await git("rev-parse", "--verify", "--quiet", `${baseRev}^{commit}`).catch(() =>
    usage(`no commit ${baseRev}`),
  );
  await mkdir(join(work, "tree"), { recursive: true });
  const trees = {
    base: new Tree(await extractTree(repo, sha, join(work, "tree"))),
    head: new Tree(here),
  };
  const settings =
    asked.length > 0
      ? asked
      : [...new Set([...trees.head.scenes, ...trees.base.scenes])].flatMap((id) => [
          `scene=${id}`,
          `scene=${id}&view=source`,
        ]);
  if (withPresets) settings.push(...presets.map((preset) => preset.query));
  const glsl = { base: await glslOf(trees.base), head: await glslOf(trees.head) };

  const renders: Render[] = [];
  const report = (render: Render): void => {
    renders.push(render);
    console.log(`${render.outcome.toUpperCase().padEnd(8)}${render.setting}: ${render.reason}`);
  };
  const todo: { readonly setting: string; readonly reason: string }[] = [];
  for (const setting of settings) {
    const scene = new URLSearchParams(setting).get("scene");
    const inBase = scene !== null && trees.base.scenes.includes(scene);
    const inHead = scene !== null && trees.head.scenes.includes(scene);
    if (scene === null || (!inBase && !inHead)) todo.push({ setting, reason: "no scene named" });
    else if (!inBase) report({ setting, outcome: "added", reason: "new: nothing to compare" });
    else if (!inHead) report({ setting, outcome: "removed", reason: "no longer a scene" });
    else {
      const why = everything ? "--all" : changed(scene, trees, glsl);
      if (why === undefined)
        report({ setting, outcome: "skipped", reason: "its GLSL and page inputs are unchanged" });
      else todo.push({ setting, reason: `changed: ${why}` });
    }
  }

  if (todo.length > 0) {
    const sites = { base: join(work, "base"), head: join(work, "head") };
    await buildSite(trees.base.root, sites.base, "/");
    await buildSite(trees.head.root, sites.head, "/");
    // Two origins, so nothing one tree's page stores reaches the other's.
    const origin = (dist: string): string => {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname.slice(1) || "index.html";
          const file = Bun.file(join(dist, path));
          const hidden = path.split("/").some((part) => part === ".." || part.startsWith("."));
          return !hidden && (await file.exists())
            ? new Response(file)
            : new Response("not found", { status: 404 });
        },
      });
      stops.push(() => server.stop(true));
      return String(server.url);
    };
    const urls = { base: origin(sites.base), head: origin(sites.head) };
    await mkdir(out, { recursive: true });
    await browser.launch({ softwareWebgl: true });
    const reducedMotion = [{ name: "prefers-reduced-motion", value: "reduce" }];
    // One CSS pixel per device pixel on a desktop page, as the headless verify runs draw.
    const metrics = { width, height, deviceScaleFactor: 1, mobile: false };
    for (const [method, params] of [
      ["Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HOOK }],
      ["Runtime.addBinding", { name: BINDING }],
      ["Emulation.setEmulatedMedia", { features: reducedMotion }],
      ["Emulation.setDeviceMetricsOverride", metrics],
    ] as const) {
      const reply = await browser.send(method, params);
      if (reply.error !== undefined) throw new AbError(`cdp ${method}: ${reply.error.message}`);
    }
    for (const { setting, reason } of todo) {
      const { pixels: beforePixels, ...before } = await shoot(`${urls.base}?${setting}`);
      const { pixels: afterPixels, ...after } = await shoot(`${urls.head}?${setting}`);
      const shots = { base: before, head: after };
      const problems = (["base", "head"] as const).flatMap((side) => {
        const problem = trouble(shots[side]);
        return problem === undefined ? [] : [`${side} ${problem}`];
      });
      if (problems.length > 0) {
        report({ setting, outcome: "failed", reason: problems.join("; "), ...shots });
        continue;
      }
      const sized = before.width === after.width && before.height === after.height;
      if (sized && before.hash === after.hash) {
        const took = `${(before.ms / 1000).toFixed(1)} s + ${(after.ms / 1000).toFixed(1)} s`;
        report({ setting, outcome: "same", reason: `${reason} (${took})`, ...shots });
        continue;
      }
      const slug = setting.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const file = (kind: string): string => join(out, `${slug}.${kind}.png`);
      const beforeBytes = Buffer.from(beforePixels, "base64");
      const afterBytes = Buffer.from(afterPixels, "base64");
      await Bun.write(file("base"), png(before.width, before.height, beforeBytes));
      await Bun.write(file("head"), png(after.width, after.height, afterBytes));
      const files = [file("base"), file("head")];
      let what = `${before.width}x${before.height} cells became ${after.width}x${after.height}`;
      if (sized) {
        const changes = diff(after.width, beforeBytes, afterBytes);
        await Bun.write(file("diff"), png(after.width, after.height, changes.image));
        files.push(file("diff"));
        what = `${changes.cells} of ${after.width * after.height} cells differ (${changes.box})`;
      }
      const where = `${what}: ${files.join(" ")}`;
      report({ setting, outcome: "differs", reason: where, ...shots, files });
    }
  }
  await mkdir(out, { recursive: true });
  const summary = join(out, "report.json");
  await Bun.write(summary, JSON.stringify({ base: { rev: baseRev, sha }, size, renders }, null, 2));
  const count = (outcome: Outcome): number =>
    renders.filter((render) => render.outcome === outcome).length;
  console.log(
    `ab: ${count("same")} same, ${count("differs")} differ, ${count("failed")} failed, ` +
      `${count("skipped")} unchanged and skipped, ${count("added")} added, ` +
      `${count("removed")} removed (${summary})`,
  );
  if (count("differs") + count("failed") > 0) process.exitCode = 1;
} catch (error: unknown) {
  // A renderer killed under memory pressure ends the run: Browser cannot reopen its page.
  console.error(`ab: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  for (const stop of stops) await stop();
  await rm(work, { recursive: true, force: true });
}
