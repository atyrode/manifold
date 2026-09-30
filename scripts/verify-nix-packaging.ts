#!/usr/bin/env bun
/** Verify native Nix outputs without a workspace install or a live machine owner. */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { ownerKeyOf, sleep } from "./gate-lib.ts";

const repoRoot = resolve(import.meta.dir, "..");
if (process.argv.length !== 2) {
  throw new Error("usage: bun scripts/verify-nix-packaging.ts");
}
const nix = Bun.which("nix");
if (nix === null) throw new Error("Nix is required to verify native packaging");

const interrupted = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => interrupted.abort(new Error(`Nix packaging interrupted (${signal})`)));
}

async function stop(proc: Bun.Subprocess): Promise<void> {
  if (proc.exitCode === null) proc.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }, 5_000);
  try {
    await proc.exited;
  } finally {
    clearTimeout(timer);
  }
}

async function command(
  argv: string[],
  timeoutMs: number,
  cwd = repoRoot,
  env: Record<string, string | undefined> = process.env,
  expectedExitCode = 0,
): Promise<string> {
  interrupted.signal.throwIfAborted();
  const proc = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  let timedOut = false;
  const kill = () => proc.kill("SIGKILL");
  interrupted.signal.addEventListener("abort", kill, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  try {
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    interrupted.signal.throwIfAborted();
    if (timedOut) throw new Error(`${argv[0]} exceeded its ${timeoutMs / 1000}s deadline`);
    if (code !== expectedExitCode)
      throw new Error(`${argv[0]} ${argv[1] ?? ""} exited ${code}; expected ${expectedExitCode}`);
    return out.trim();
  } finally {
    clearTimeout(timer);
    interrupted.signal.removeEventListener("abort", kill);
    await stop(proc);
  }
}

const system = await command(
  [nix, "eval", "--raw", "--impure", "--expr", "builtins.currentSystem"],
  30_000,
);
if (!/^(x86_64|aarch64)-(linux|darwin)$/.test(system)) {
  throw new Error(`Unsupported native Nix system: ${system}`);
}
const nativeCpu =
  process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch;
if (system !== `${nativeCpu}-${process.platform}`) {
  throw new Error(`Nix system ${system} does not match this process's native platform`);
}
const expectedSystem = process.env["MANIFOLD_NIX_SYSTEM"];
if (expectedSystem !== undefined && expectedSystem !== system) {
  throw new Error(
    `MANIFOLD_NIX_SYSTEM=${expectedSystem} does not match native Nix system ${system}`,
  );
}

async function build(name: string, rebuild = false): Promise<string> {
  console.log(`Nix packaging: ${system} ${name}${rebuild ? " --rebuild" : ""}`);
  const output = await command(
    [
      nix!,
      "build",
      "--no-link",
      "--print-build-logs",
      "--print-out-paths",
      ...(rebuild ? ["--rebuild"] : []),
      `.#packages.${system}.${name}`,
    ],
    10 * 60_000,
  );
  if (!isAbsolute(output) || output.includes("\n")) {
    throw new Error(`Nix did not report exactly one output path for ${name}`);
  }
  console.log(`Nix packaging: ${name} output ${output}`);
  return output;
}

const deps = await build("bun-deps");
if ((await build("bun-deps", true)) !== deps) {
  throw new Error("Nix dependency rebuild returned a different output path");
}
console.log(
  `Nix packaging: native dependency NAR ${await command([nix, "hash", "path", deps], 30_000)}`,
);
const agentOutput = await build("manifold-agent");
const serverOutput = await build("manifold-server");
const clientOutput = await build("manifold");
const bunOutput = await build("bun-runtime");
const manifest: unknown = JSON.parse(
  readFileSync(join(repoRoot, "packages/web/package.json"), "utf8"),
);
if (
  typeof manifest !== "object" ||
  manifest === null ||
  !("version" in manifest) ||
  typeof manifest.version !== "string"
) {
  throw new Error("Web package manifest does not declare the expected package version");
}
const version = manifest.version;

/*
  THE HARDENED SELECTIONS UNDER PROOF: Machines and Files have packaged first-party recipes.
  Their doors are each plugin's own declarations and the toggle is the engine's. This verifier
  installs no workspace dependency, so it cannot import them: the live roster must publish each
  door before it is called, and a renamed door fails as unpublished rather than as a guess.
*/
const MACHINES = "core.machines";
const LIST = `${MACHINES}.list`;
const ENROLL = `${MACHINES}.enroll`;
const REVOKE = `${MACHINES}.revoke`;
const FORGET = `${MACHINES}.forget`;
const ENGINE_PLUGINS = "engine.plugins";
const SET_ENABLED = `${ENGINE_PLUGINS}.setEnabled`;
const WORKER_ROUTE = `/api/plugins/${MACHINES}/web.worker.js`;
const FILES = "core.files";
const COLLECTION = { kind: "plugin", pluginId: FILES };
const FILE_DOORS = [
  "beginUpload",
  "completeUpload",
  "inspectUpload",
  "inspect",
  "openRead",
  "list",
];
/** Above the isolate dispatch deadline (10s): a hung child answers `unavailable`, not a timeout. */
const REQUEST_DEADLINE_MS = 15_000;
/** Beyond any installed web asset or plugin member; nothing a hub answers buffers unbounded. */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
/** One log line, or a refused boot's whole captured stream. */
const MAX_LOG_CHARS = 64_000;

const root = realpathSync(mkdtempSync(join(tmpdir(), "manifold-nix-packaging-")));
const cwd = join(root, "cwd");
const home = join(root, "home");
const temporary = join(root, "tmp");
const emptyPath = join(root, "bin");
// The wrappers must supply their own runtime inputs, not inherit an operator's
// credentials, source paths, native-owner settings or configuration directories.
const env = { HOME: home, TMPDIR: temporary, PATH: emptyPath, LANG: "C", LC_ALL: "C" };
const hubBinary = join(serverOutput, "bin/manifold-server");
/** Every packaged hub this proof boots: loopback, port 0, no local agent, no key in its log. */
const hubSettings = {
  ...env,
  MANIFOLD_BIND: "127.0.0.1",
  MANIFOLD_PORT: "0",
  MANIFOLD_SPAWN_AGENT: "0",
  MANIFOLD_ANNOUNCE_KEY: "0",
};
const requests = new AbortController();
let sandbox: readonly string[] = [];

/**
 * Runtime proof sees the output closure, never build inputs. Linux starts with an empty mount
 * namespace; macOS denies checkout, build sources and every node_modules tree with Seatbelt.
 * A fresh HOME and disabled auto-install also prohibit a warm Bun dependency-cache fallback.
 */
async function coldSandbox(): Promise<readonly string[]> {
  writeFileSync(join(root, "bunfig.toml"), '[install]\nauto = "disable"\n', { mode: 0o600 });
  if (process.platform === "darwin") {
    const profile = join(root, "cold.sb");
    writeFileSync(
      profile,
      [
        "(version 1)",
        "(allow default)",
        `(deny file-read* (subpath ${JSON.stringify(realpathSync(repoRoot))})`,
        `  (subpath ${JSON.stringify(deps)}) (subpath "/build")`,
        '  (regex #"(^|/)node_modules(/|$)") (regex #"^/nix/store/[^/]+-source(/|$)"))',
        "(deny network-outbound)",
        '(allow network-outbound (remote ip "localhost:*"))',
      ].join("\n"),
      { mode: 0o600 },
    );
    return ["/usr/bin/sandbox-exec", "-f", profile];
  }
  const bwrap = await command(
    [
      nix!,
      "build",
      "--no-link",
      "--print-out-paths",
      "--inputs-from",
      ".",
      `nixpkgs#legacyPackages.${system}.bubblewrap`,
    ],
    10 * 60_000,
  );
  if (!isAbsolute(bwrap) || bwrap.includes("\n"))
    throw new Error("Nix did not report one bubblewrap output");
  const closure = (
    await command(
      [nix!, "path-info", "--recursive", agentOutput, serverOutput, clientOutput, bunOutput],
      30_000,
    )
  ).split("\n");
  if (
    closure.some(
      (path) => !/^\/nix\/store\/[^/]+$/.test(path) || path === deps || path.endsWith("-source"),
    )
  )
    throw new Error("Packaged runtime closure includes a source or dependency fallback");
  return [
    join(bwrap, "bin/bwrap"),
    "--die-with-parent",
    "--new-session",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    ...closure.flatMap((path) => ["--ro-bind", path, path]),
    "--bind",
    root,
    root,
    "--chdir",
    cwd,
    "--",
  ];
}

/** The same denial must hold for the interpreter used by packaged hardened children. */
async function sourceFallbackAbsent(): Promise<void> {
  const inputs = [join(repoRoot, "package.json"), join(deps, "node_modules/sharp/package.json")];
  if (inputs.some((path) => !existsSync(path)))
    throw new Error("Cold package denial probe does not name actual build inputs");
  await command(
    [
      ...sandbox,
      join(bunOutput, "bin/bun"),
      "--no-install",
      "--eval",
      `
    const { readFileSync } = require("node:fs");
    for (const path of ${JSON.stringify(inputs)}) {
      let readable = false;
      try { readFileSync(path); readable = true; } catch {}
      if (readable) throw new Error("Cold package can read a source/dependency fallback");
    }
  `,
    ],
    30_000,
    cwd,
    env,
  );
}

/** One disposable loopback hub from the package, and the isolate children its own log named. */
interface Hub {
  readonly label: string;
  readonly dataDir: string;
  readonly proc: Bun.Subprocess<"ignore", "pipe", "inherit">;
  readonly output: Promise<void>;
  readonly children: { readonly plugin: string; readonly pid: number }[];
  readonly reaped: Set<number>;
}

/** A booted hub's loopback origin and a credential that same hub generated or minted. */
interface Fixture {
  readonly origin: string;
  readonly key: string;
}

/** The artifact the package ships for the selection: its pin and the halves a hub must use. */
interface Shipped {
  readonly pin: string;
  readonly server: Buffer;
  readonly worker: Buffer;
  readonly files: ReadonlyMap<string, Buffer>;
}

interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

type Outcome =
  { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly rule: string };

const hubs = new Set<Hub>();

/**
 * One member of a parsed JSON object, or undefined for anything else; narrowed by the caller.
 * This verifier runs without a workspace install, so it has no schema validator to parse with.
 */
function member(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** A JSON answer, parsed without ever quoting it: an enrolment's answer carries a credential. */
function parsed(body: Buffer, what: string): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error(`${what} did not answer JSON`);
  }
}

/** Races smoke work against the hub exiting or its output closing under it. */
async function during<T>(hub: Hub, work: Promise<T>): Promise<T> {
  const value = await Promise.race([
    work,
    hub.proc.exited.then((code): never => {
      throw new Error(`Packaged ${hub.label} server exited during smoke (${code})`);
    }),
    hub.output.then((): never => {
      throw new Error(`Packaged ${hub.label} server output closed during smoke`);
    }),
  ]);
  if (hub.proc.exitCode !== null)
    throw new Error(`Packaged ${hub.label} server exited during smoke (${hub.proc.exitCode})`);
  return value;
}

/** Starts the packaged hub on fresh data with no inherited operator configuration. */
async function boot(
  label: string,
  selection: Readonly<Record<string, string>> = {},
): Promise<{ readonly hub: Hub; readonly origin: string }> {
  interrupted.signal.throwIfAborted();
  const dataDir = join(root, `${label}-data`);
  const coldHome = join(root, `${label}-home`);
  mkdirSync(coldHome, { mode: 0o700 });
  const proc = Bun.spawn([...sandbox, hubBinary], {
    cwd,
    env: { ...hubSettings, HOME: coldHome, MANIFOLD_DATA_DIR: dataDir, ...selection },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const ready = Promise.withResolvers<string>();
  const children: { readonly plugin: string; readonly pid: number }[] = [];
  const reaped = new Set<number>();
  const stdout = proc.stdout;
  const output = (async () => {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffered += decoder.decode(chunk.value, { stream: true });
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? "";
        if (buffered.length > MAX_LOG_CHARS)
          throw new Error(`Packaged ${label} server emitted an oversized log line`);
        for (const line of lines) {
          // The JSONL log is read, never echoed. Only the supervisor's own spawn and exit
          // records are kept, so a child is named by the hub that ran it, never guessed at.
          if (line.startsWith("{")) {
            let record: unknown;
            try {
              record = JSON.parse(line);
            } catch {
              continue;
            }
            const evt = member(record, "evt");
            const plugin = member(record, "plugin");
            const pid = member(record, "pid");
            if (typeof plugin !== "string" || typeof pid !== "number" || !Number.isSafeInteger(pid))
              continue;
            if (evt === "isolate_spawned" && pid > 0) children.push({ plugin, pid });
            else if (evt === "isolate_exited") reaped.add(pid);
            continue;
          }
          const address = /^manifold ready url=(\S+)$/.exec(line)?.[1];
          if (address === undefined) continue;
          const url = new URL(address);
          if (
            url.protocol !== "http:" ||
            !["localhost", "127.0.0.1"].includes(url.hostname) ||
            url.port === "" ||
            url.port === "0" ||
            url.username !== "" ||
            url.password !== "" ||
            url.hash !== "" ||
            url.search !== ""
          )
            throw new Error(`Packaged ${label} server announced an unexpected readiness URL`);
          url.hostname = "127.0.0.1";
          ready.resolve(url.origin);
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();
  const hub: Hub = { label, dataDir, proc, output, children, reaped };
  hubs.add(hub);
  const interrupt = () => ready.reject(interrupted.signal.reason);
  interrupted.signal.addEventListener("abort", interrupt, { once: true });
  const timer = setTimeout(
    () => ready.reject(new Error(`Packaged ${label} server readiness exceeded 30s`)),
    30_000,
  );
  try {
    return { hub, origin: await during(hub, ready.promise) };
  } finally {
    clearTimeout(timer);
    interrupted.signal.removeEventListener("abort", interrupt);
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Stops one hub, then accounts for every isolate child its log named. Only a child the hub did
 * not report exited is ever probed: it gets five seconds to go on its own, then is killed and
 * reported, so a proof never ends with a hardened plugin still running.
 */
async function close(hub: Hub): Promise<void> {
  if (!hubs.delete(hub)) return;
  let failure: unknown;
  try {
    await stop(hub.proc);
    await hub.output;
  } catch (error) {
    failure = error;
  }
  const leaked: number[] = [];
  for (const { pid } of hub.children) {
    if (hub.reaped.has(pid)) continue;
    const deadline = Date.now() + 5_000;
    while (alive(pid) && Date.now() < deadline) await sleep(100);
    if (!alive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      continue;
    }
    leaked.push(pid);
  }
  if (leaked.length > 0) {
    const leak = new Error(
      `Packaged ${hub.label} server left isolate children running (${leaked.join(", ")})`,
    );
    throw failure === undefined
      ? leak
      : new AggregateError([failure, leak], `Packaged ${hub.label} server did not stop cleanly`);
  }
  if (failure !== undefined) throw failure;
}

/** A child's whole stream as text, refused past the bound rather than buffered. */
async function bounded(stream: ReadableStream<Uint8Array>, what: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    if (text.length > MAX_LOG_CHARS)
      throw new Error(`${what} exceeded ${MAX_LOG_CHARS} characters`);
  }
  return text + decoder.decode();
}

/**
 * A selection this package cannot run hardened must stop the start by name before any child or
 * listener exists: never a silent in-realm start of the plugin the operator named.
 */
async function refusal(label: string, selector: string, reason: string): Promise<void> {
  interrupted.signal.throwIfAborted();
  const proc = Bun.spawn([...sandbox, hubBinary], {
    cwd,
    env: {
      ...hubSettings,
      MANIFOLD_DATA_DIR: join(root, `${label}-data`),
      MANIFOLD_HARDENED_PLUGINS: selector,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const kill = () => proc.kill("SIGKILL");
  interrupted.signal.addEventListener("abort", kill, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, 30_000);
  try {
    // Captured, bounded and never echoed: even a refused boot's log is this fixture's own.
    const [out, err, code] = await Promise.all([
      bounded(proc.stdout, `Packaged ${label} server output`),
      bounded(proc.stderr, `Packaged ${label} server error output`),
      proc.exited,
    ]);
    interrupted.signal.throwIfAborted();
    const named = `MANIFOLD_HARDENED_PLUGINS=${selector}`;
    if (/^manifold ready /m.test(out) || out.includes('"evt":"isolate_spawned"'))
      throw new Error(`Packaged server started with ${named} instead of refusing it`);
    if (timedOut) throw new Error(`Packaged server did not refuse ${named} within 30s`);
    if (code === 0 || !err.includes(reason))
      throw new Error(`Packaged server did not refuse ${named} by name`);
  } finally {
    clearTimeout(timer);
    interrupted.signal.removeEventListener("abort", kill);
    await stop(proc);
  }
}

/*
  node:http goes directly to the announced loopback listener, irrespective of inherited HTTP
  proxy settings. Nothing follows a redirect, and a path that would resolve to any other origin
  is refused before a request exists. A credential may only come from the SAME fresh fixture's
  hub: its generated owner key or a token minted through that owner's action. Kept in memory
  after readiness, sent only as a bearer header to that hub's own origin, never logged or quoted
  in an error, and deleted with the fixture. Nothing is read from an
  operator's environment, home, checkout or any other instance.
*/
async function exchange(
  origin: string,
  pathname: string,
  options: { readonly key?: string; readonly json?: unknown; readonly bytes?: Buffer } = {},
): Promise<Answer> {
  const target = new URL(pathname, origin);
  if (target.origin !== origin)
    throw new Error(`Packaged server path ${pathname} leaves its loopback origin`);
  const body =
    options.bytes ??
    (options.json === undefined ? undefined : Buffer.from(JSON.stringify(options.json)));
  const { promise, resolve: resolveAnswer, reject } = Promise.withResolvers<Answer>();
  const req = httpRequest(
    target,
    {
      method: body === undefined ? "GET" : "POST",
      agent: false,
      headers: {
        ...(options.key === undefined ? {} : { authorization: `Bearer ${options.key}` }),
        ...(body === undefined
          ? {}
          : {
              "content-type":
                options.bytes === undefined ? "application/json" : "application/octet-stream",
              "content-length": body.length,
            }),
      },
      signal: AbortSignal.any([
        interrupted.signal,
        requests.signal,
        AbortSignal.timeout(REQUEST_DEADLINE_MS),
      ]),
    },
    (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("error", reject);
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes <= MAX_RESPONSE_BYTES) {
          chunks.push(chunk);
          return;
        }
        response.destroy();
        reject(new Error(`Packaged server ${pathname} answered over ${MAX_RESPONSE_BYTES} bytes`));
      });
      response.on("end", () =>
        resolveAnswer({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }),
      );
    },
  );
  req.on("error", reject);
  req.end(body);
  return promise;
}

async function request(origin: string, pathname: string, key?: string): Promise<Buffer> {
  const answer = await exchange(origin, pathname, key === undefined ? {} : { key });
  if (answer.status !== 200)
    throw new Error(`Packaged server ${pathname} returned HTTP ${answer.status}`);
  return answer.body;
}

/** The owner key a hub this proof just booted generated in its own fresh data directory. */
async function ownerKey(hub: Hub): Promise<string> {
  const key = await ownerKeyOf(hub.dataDir);
  if (!/^[0-9a-f]{64}$/.test(key))
    throw new Error(`Packaged ${hub.label} server did not generate a fixture owner key`);
  return key;
}

async function health(origin: string): Promise<void> {
  const body = parsed(await request(origin, "/healthz"), "Packaged server health");
  if (member(body, "ok") !== true || member(body, "version") !== version)
    throw new Error(`Packaged server health did not report ok and version ${version}`);
}

/** The published roster, every row by plugin id. */
async function roster(at: Fixture): Promise<ReadonlyMap<string, unknown>> {
  const plugins = member(
    parsed(await request(at.origin, "/api/plugins", at.key), "Packaged server roster"),
    "plugins",
  );
  if (!Array.isArray(plugins)) throw new Error("Packaged server roster is not a plugin list");
  const entries: readonly unknown[] = plugins;
  const rows = new Map<string, unknown>();
  for (const row of entries) {
    const id = member(member(row, "manifest"), "id");
    if (typeof id !== "string") throw new Error("Packaged server roster has a row with no id");
    rows.set(id, row);
  }
  return rows;
}

/** The fully qualified doors one roster row publishes. */
function doors(row: unknown): readonly unknown[] {
  const actions = member(row, "actions");
  return Array.isArray(actions) ? actions.map((action: unknown) => member(action, "name")) : [];
}

/**
 * `core.machines` as the roster must publish it: in the given state and effective execution,
 * with no install row, hold or failed transition, publishing its doors — and the only plugin
 * that runs hardened is the one selected.
 */
function requireMachines(
  rows: ReadonlyMap<string, unknown>,
  enabled: boolean,
  hardened: boolean,
): void {
  const row = rows.get(MACHINES);
  const lifecycle = member(row, "lifecycle");
  const published = doors(row);
  if (
    row === undefined ||
    member(row, "enabled") !== enabled ||
    (member(row, "hardened") === true) !== hardened ||
    member(row, "install") !== undefined ||
    member(row, "held") !== undefined ||
    (lifecycle !== undefined && lifecycle !== "ok") ||
    [LIST, ENROLL, REVOKE, FORGET].some((door) => !published.includes(door))
  )
    throw new Error(
      `Packaged server roster does not publish ${MACHINES} ${enabled ? "enabled" : "disabled"}` +
        ` and ${hardened ? "hardened" : "in-realm"} with its doors`,
    );
  const effective = [...rows].filter(([, entry]) => member(entry, "hardened") === true);
  if (effective.length !== (hardened ? 1 : 0))
    throw new Error("Packaged server runs a plugin hardened that nobody selected");
}

/** One door through the action route, answered as the ladder answered it. */
async function act(at: Fixture, name: string, input: unknown): Promise<Outcome> {
  const answer = await exchange(at.origin, `/api/actions/${name}`, { key: at.key, json: input });
  if (answer.status !== 200)
    throw new Error(`Packaged server ${name} returned HTTP ${answer.status}`);
  const outcome = parsed(answer.body, `Packaged server ${name}`);
  if (member(outcome, "ok") === true) return { ok: true, result: member(outcome, "result") };
  const rule = member(member(outcome, "denial"), "rule");
  if (member(outcome, "ok") === false && typeof rule === "string") return { ok: false, rule };
  throw new Error(`Packaged server ${name} did not answer an action outcome`);
}

async function granted(at: Fixture, name: string, input: unknown): Promise<unknown> {
  const outcome = await act(at, name, input);
  if (!outcome.ok) throw new Error(`Packaged server refused ${name} (${outcome.rule})`);
  return outcome.result;
}

async function denied(at: Fixture, name: string, input: unknown, rule: string): Promise<void> {
  const outcome = await act(at, name, input);
  const answered = outcome.ok ? "a result" : outcome.rule;
  if (answered !== rule)
    throw new Error(`Packaged server answered ${name} with ${answered}, not ${rule}`);
}

/** A new machine's id. Its minted credential is checked present and dropped, never kept. */
async function enroll(at: Fixture, name: string): Promise<string> {
  const result = await granted(at, ENROLL, { name });
  const machine = member(result, "machine");
  const id = member(machine, "id");
  const minted = member(result, "machineToken");
  if (
    typeof id !== "string" ||
    id === "" ||
    member(machine, "name") !== name ||
    typeof minted !== "string" ||
    minted === ""
  )
    throw new Error(`Packaged server ${ENROLL} did not mint a new machine`);
  return id;
}

/** The fleet inventory, every machine by id. */
async function inventory(at: Fixture): Promise<ReadonlyMap<string, unknown>> {
  const machines = member(await granted(at, LIST, {}), "machines");
  if (!Array.isArray(machines)) throw new Error(`Packaged server ${LIST} answered no inventory`);
  const entries: readonly unknown[] = machines;
  const byId = new Map<string, unknown>();
  for (const machine of entries) {
    const id = member(machine, "id");
    if (typeof id !== "string") throw new Error(`Packaged server ${LIST} named a machine no id`);
    byId.set(id, machine);
  }
  return byId;
}

async function revoke(at: Fixture, machineId: string): Promise<void> {
  if (member(await granted(at, REVOKE, { machineId }), "revoked") !== 1)
    throw new Error(`Packaged server ${REVOKE} did not withdraw the enrolled credential`);
}

/** A door whose declared result is `{}` (`forget`, the engine toggle): anything else is drift. */
async function emptyResult(at: Fixture, name: string, input: unknown): Promise<void> {
  const result = await granted(at, name, input);
  if (
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result) ||
    Object.keys(result).length !== 0
  )
    throw new Error(`Packaged server ${name} did not answer its empty result`);
}

async function workerServed(at: Fixture, shipped: Shipped, plugin = MACHINES): Promise<void> {
  const answer = await exchange(at.origin, `/api/plugins/${plugin}/web.worker.js`, { key: at.key });
  if (
    answer.status !== 200 ||
    answer.headers.etag !== `"${shipped.pin}"` ||
    answer.headers["cache-control"] !== "no-store" ||
    !(answer.headers["content-type"] ?? "").startsWith("text/javascript") ||
    !answer.body.equals(shipped.worker)
  )
    throw new Error(`Packaged hardened server did not serve the ${plugin} Worker it ships`);
}

async function workerAbsent(at: Fixture, why: string): Promise<void> {
  if ((await exchange(at.origin, WORKER_ROUTE, { key: at.key })).status !== 404)
    throw new Error(`Packaged server served a ${MACHINES} Worker ${why}`);
}

/** The package's own build-time artifact for the selection; absent is a packaging defect. */
function shippedArtifact(plugin = MACHINES): Shipped {
  const file = join(serverOutput, "share/manifold/first-party", `${plugin}.manifold-plugin.json`);
  if (!existsSync(file)) throw new Error(`Packaged server ships no ${plugin} first-party artifact`);
  const bytes = readFileSync(file);
  if (bytes.length > 64 * 1024 * 1024)
    throw new Error(`Packaged ${plugin} artifact exceeds the signed-code ceiling`);
  const artifact = parsed(bytes, `Packaged ${plugin} artifact`);
  const declared = member(artifact, "manifest");
  const files = member(artifact, "files");
  const server = member(files, "server.js");
  const worker = member(files, "web.worker.js");
  if (
    member(declared, "id") !== plugin ||
    member(member(declared, "entry"), "worker") !== true ||
    typeof files !== "object" ||
    files === null ||
    Array.isArray(files) ||
    typeof server !== "string" ||
    server === "" ||
    typeof worker !== "string" ||
    worker === ""
  )
    throw new Error(`Packaged ${plugin} artifact carries no server half and portable Worker`);
  const members = new Map<string, Buffer>();
  let extractedBytes = 0;
  for (const [name, value] of Object.entries(files)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || typeof value !== "string")
      throw new Error(`Packaged ${plugin} artifact has a non-flat member`);
    const content = Buffer.from(value, "base64");
    extractedBytes += content.length;
    if (extractedBytes > 64 * 1024 * 1024)
      throw new Error(`Packaged ${plugin} artifact exceeds the extraction ceiling`);
    members.set(name, content);
  }
  console.log(
    `Nix packaging: ${plugin} artifact ${bytes.length} bytes, extracted ${extractedBytes} bytes`,
  );
  return {
    pin: createHash("sha256").update(bytes).digest("hex"),
    server: Buffer.from(server, "base64"),
    worker: Buffer.from(worker, "base64"),
    files: members,
  };
}

/** No selection: the prior package smoke, and proof that nothing ran hardened unasked. */
async function inRealmSmoke(hub: Hub, origin: string): Promise<void> {
  await health(origin);
  const webDist = join(serverOutput, "share/manifold/web");
  const html = (await request(origin, "/")).toString("utf8");
  if (!html.includes("<html") || html !== readFileSync(join(webDist, "index.html"), "utf8")) {
    throw new Error("Packaged server did not serve its installed web HTML");
  }
  const reference = /<script\b[^>]*\bsrc=["']([^"']+)["']/i.exec(html)?.[1];
  if (reference === undefined) throw new Error("Packaged web HTML has no built script asset");
  const asset = new URL(reference, origin);
  const assetPath = resolve(webDist, `.${decodeURIComponent(asset.pathname)}`);
  if (asset.origin !== origin || !assetPath.startsWith(join(webDist, "assets") + sep)) {
    throw new Error("Packaged web script does not reference a local built asset");
  }
  const bytes = await request(origin, asset.pathname);
  if (bytes.length === 0 || !bytes.equals(readFileSync(assetPath))) {
    throw new Error("Packaged server did not serve its referenced built asset");
  }

  const at: Fixture = { origin, key: await ownerKey(hub) };
  requireMachines(await roster(at), true, false);
  if (hub.children.length > 0 || existsSync(join(hub.dataDir, "first-party")))
    throw new Error("Packaged server supervised a plugin nobody selected");
  await workerAbsent(at, "nobody selected");
}

/**
 * `MANIFOLD_HARDENED_PLUGINS=core.machines`: the wrapper's artifact, bound and run in a child
 * the hub supervises, its Worker served under the artifact's pin, and the fleet doors answered
 * through that child — including across a disable, where only the cleanup door stays open.
 */
async function hardenedSmoke(hub: Hub, origin: string, shipped: Shipped): Promise<void> {
  if (hub.children.length === 0 || hub.children.some(({ plugin }) => plugin !== MACHINES))
    throw new Error(`Packaged hardened server did not supervise a ${MACHINES} child`);
  await health(origin);
  // The child runs what was extracted from the artifact the package ships, under its pin.
  const extracted = join(hub.dataDir, "first-party", MACHINES);
  const pins = existsSync(extracted) ? readdirSync(extracted) : [];
  if (
    pins.length !== 1 ||
    pins[0] !== shipped.pin ||
    !readFileSync(join(extracted, shipped.pin, "server.js")).equals(shipped.server)
  )
    throw new Error(`Packaged hardened server did not run the ${MACHINES} artifact it ships`);
  if ((await exchange(origin, WORKER_ROUTE)).status !== 401)
    throw new Error(`Packaged hardened server served its ${MACHINES} Worker unauthenticated`);

  const at: Fixture = { origin, key: await ownerKey(hub) };
  const rows = await roster(at);
  requireMachines(rows, true, true);
  if (!doors(rows.get(ENGINE_PLUGINS)).includes(SET_ENABLED))
    throw new Error(`Packaged server roster does not publish ${SET_ENABLED}`);
  await workerServed(at, shipped);

  // Enrol, inventory, withdraw and forget, each answered by the supervised child.
  const baseline = [...(await inventory(at)).keys()];
  const alpha = await enroll(at, "packaged-alpha");
  const listed = (await inventory(at)).get(alpha);
  if (
    member(listed, "name") !== "packaged-alpha" ||
    member(listed, "online") !== false ||
    member(listed, "revoked") !== undefined
  )
    throw new Error(`Packaged server ${LIST} does not show the machine it enrolled`);
  await revoke(at, alpha);
  if (member((await inventory(at)).get(alpha), "revoked") !== true)
    throw new Error(`Packaged server ${LIST} does not show the machine revoked`);
  await emptyResult(at, FORGET, { machineId: alpha });
  if ((await inventory(at)).has(alpha))
    throw new Error(`Packaged server ${LIST} still shows the machine it forgot`);

  // Disabled: no Worker and no ordinary door, yet withdrawal stays reachable as cleanup.
  const beta = await enroll(at, "packaged-beta");
  await emptyResult(at, SET_ENABLED, { id: MACHINES, enabled: false });
  requireMachines(await roster(at), false, true);
  await workerAbsent(at, "while it is disabled");
  await denied(at, ENROLL, { name: "packaged-late" }, "plugin_disabled");
  await denied(at, LIST, {}, "plugin_disabled");
  await denied(at, FORGET, { machineId: beta }, "plugin_disabled");
  await revoke(at, beta);
  await emptyResult(at, SET_ENABLED, { id: MACHINES, enabled: true });
  requireMachines(await roster(at), true, true);
  await workerServed(at, shipped);
  await emptyResult(at, FORGET, { machineId: beta });
  const remaining = [...(await inventory(at)).keys()];
  if (remaining.length !== baseline.length || remaining.some((id) => !baseline.includes(id)))
    throw new Error(`Packaged server ${LIST} does not return to the fixture's own inventory`);
}

/** Genuine RGB pixels compressed with zlib; no decoder or workspace dependency in the runner. */
function imageFixture(width = 7, height = 5, corrupt = false): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length);
    bytes.write(type, 4, 4, "latin1");
    data.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(5 * (1 + 7 * 3), 112);
  for (let y = 0; y < 5; y++) pixels[y * 22] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    // Valid framing/CRC but invalid compressed pixels must not pass a metadata-only decoder.
    chunk("IDAT", corrupt ? Buffer.from("not a zlib stream") : deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function bytePath(carrier: string, transferId: string, ref: string, bytes: number): string {
  const query = new URLSearchParams({
    transferId,
    ref,
    offset: "0",
    sequence: "0",
    length: String(bytes),
  });
  return `/api/bytes/${FILES}/${carrier}?${query}`;
}

async function uploadImage(at: Fixture, bytes: Buffer): Promise<string> {
  const started = await granted(at, `${FILES}.beginUpload`, {
    collection: COLLECTION,
    requestId: `${Date.now()}_${randomUUID()}`,
    name: "cold-image.png",
    declaredMediaType: "image/png",
    bytes: bytes.length,
    expectedSha256: createHash("sha256").update(bytes).digest("hex"),
    purpose: "image",
  });
  const id = member(started, "transferId");
  if (typeof id !== "string" || member(started, "state") !== "receiving")
    throw new Error("Packaged Files did not reserve an image upload");
  const answer = await exchange(
    at.origin,
    bytePath("upload", id, `manifold://plugin/${FILES}`, bytes.length),
    { key: at.key, bytes },
  );
  const receipt = parsed(answer.body, "Packaged Files byte receipt");
  if (
    answer.status !== 200 ||
    answer.headers["cache-control"] !== "no-store" ||
    member(receipt, "offset") !== bytes.length ||
    member(receipt, "sequence") !== 0 ||
    member(receipt, "acceptedBytes") !== bytes.length
  )
    throw new Error("Packaged Files did not acknowledge its actual image bytes");
  return id;
}

/** Both the compiled in-realm decoder and the extracted hardened owner must do real work cold. */
async function filesSmoke(hub: Hub, origin: string, shipped?: Shipped): Promise<void> {
  const owner: Fixture = { origin, key: await ownerKey(hub) };
  await emptyResult(owner, SET_ENABLED, { id: FILES, enabled: true });
  const rows = await roster(owner);
  const row = rows.get(FILES);
  const hardened = shipped !== undefined;
  const selected = [...rows].filter(([, entry]) => member(entry, "hardened") === true);
  if (
    member(row, "enabled") !== true ||
    (member(row, "hardened") === true) !== hardened ||
    member(row, "held") !== undefined ||
    member(row, "install") !== undefined ||
    FILE_DOORS.some((door) => !doors(row).includes(`${FILES}.${door}`)) ||
    selected.length !== (hardened ? 1 : 0) ||
    hub.children.some(({ plugin }) => plugin !== FILES) ||
    hub.children.length > 0 !== hardened
  )
    throw new Error("Packaged Files did not publish the selected execution and doors");
  if (shipped !== undefined) {
    const extracted = join(hub.dataDir, "first-party", FILES, shipped.pin);
    if (!existsSync(extracted) || readdirSync(extracted).length !== shipped.files.size)
      throw new Error("Packaged Files did not extract exactly its signed flat members");
    for (const [name, bytes] of shipped.files) {
      if (!readFileSync(join(extracted, name)).equals(bytes))
        throw new Error(`Packaged Files changed its signed ${name} member`);
    }
    await workerServed(owner, shipped, FILES);
  }
  if (
    ["core.access.mint", "core.access.grant"].some(
      (name) => !doors(rows.get("core.access")).includes(name),
    )
  )
    throw new Error("Packaged server did not publish the fixture's access doors");
  const uploader = await granted(owner, "core.access.mint", {
    principal: { name: "Cold package image uploader" },
    caps: ["containers:read"],
  });
  const principalId = member(member(uploader, "principal"), "id");
  const token = member(uploader, "token");
  if (typeof principalId !== "string" || typeof token !== "string" || token === "")
    throw new Error("Packaged server did not mint the fixture's uploader");
  await granted(owner, "core.access.grant", {
    principal: { kind: "principal", id: principalId },
    node: `manifold://plugin/${FILES}`,
    caps: [`${FILES}:create`],
    effect: "allow",
    reach: "node",
  });
  const at: Fixture = { origin, key: token };
  const bytes = imageFixture();
  const transferId = await uploadImage(at, bytes);
  const published = await granted(at, `${FILES}.completeUpload`, {
    collection: COLLECTION,
    transferId,
  });
  const ref = member(published, "ref");
  const fileId = member(ref, "fileId");
  if (member(ref, "kind") !== "file" || typeof fileId !== "string")
    throw new Error("Packaged Files did not publish the decoded image");
  const descriptor = await granted(at, `${FILES}.inspect`, { ref });
  const image = member(descriptor, "image");
  if (
    member(image, "width") !== 7 ||
    member(image, "height") !== 5 ||
    member(image, "mediaType") !== "image/png" ||
    member(descriptor, "bytes") !== bytes.length ||
    member(descriptor, "sha256") !== createHash("sha256").update(bytes).digest("hex")
  )
    throw new Error("Packaged Files did not validate the complete image raster");
  const opened = await granted(at, `${FILES}.openRead`, {
    ref,
    requestId: `${Date.now()}_${randomUUID()}`,
  });
  const readId = member(member(opened, "transfer"), "transferId");
  if (typeof readId !== "string")
    throw new Error("Packaged Files did not open the published bytes");
  const received = await exchange(
    origin,
    bytePath("read", readId, `manifold://file/${fileId}`, bytes.length),
    { key: at.key },
  );
  if (
    received.status !== 200 ||
    received.headers["cache-control"] !== "no-store" ||
    !received.body.equals(bytes)
  )
    throw new Error("Packaged Files did not preserve the original uploaded image bytes");

  for (const [input, reason] of [
    [imageFixture(7, 5, true), "invalid_image"],
    [imageFixture(8193, 1), "image_too_large"],
    [imageFixture(2049, 2048), "image_too_large"],
  ] as const) {
    const rejectedId = await uploadImage(at, input);
    await denied(
      at,
      `${FILES}.completeUpload`,
      {
        collection: COLLECTION,
        transferId: rejectedId,
      },
      "refused",
    );
    const receipt = await granted(at, `${FILES}.inspectUpload`, {
      collection: COLLECTION,
      transferId: rejectedId,
    });
    if (member(receipt, "state") !== "failed" || member(receipt, "reason") !== reason)
      throw new Error(`Packaged Files did not durably refuse ${reason}`);
  }
  const listed = member(await granted(at, `${FILES}.list`, {}), "files");
  if (
    !Array.isArray(listed) ||
    listed.length !== 1 ||
    member(member(listed[0], "ref"), "fileId") !== fileId
  )
    throw new Error("Packaged Files published a rejected image or lost the valid publication");
  console.log(
    `Nix packaging: cold ${hardened ? "hardened" : "compiled"} Files decoded, published and read ${bytes.length} original bytes; corrupt pixels, dimension and pixel bounds refused`,
  );
}

try {
  chmodSync(root, 0o700);
  for (const path of [cwd, home, temporary, emptyPath]) mkdirSync(path, { mode: 0o700 });
  sandbox = await coldSandbox();
  await sourceFallbackAbsent();
  await command(
    [...sandbox, join(agentOutput, "bin/manifold-agent"), "--maintenance", "--help"],
    30_000,
    cwd,
    env,
  );
  await command([...sandbox, join(clientOutput, "bin/manifold"), "context"], 30_000, cwd, env, 1);
  const diagnosis: unknown = JSON.parse(
    await command([...sandbox, join(clientOutput, "bin/manifold"), "doctor"], 30_000, cwd, env, 1),
  );
  if (
    typeof diagnosis !== "object" ||
    diagnosis === null ||
    !("diagnostic" in diagnosis) ||
    typeof diagnosis.diagnostic !== "object" ||
    diagnosis.diagnostic === null ||
    !("code" in diagnosis.diagnostic) ||
    diagnosis.diagnostic.code !== "missing_binding"
  )
    throw new Error("Packaged terminal client did not refuse an absent terminal binding");

  const inRealm = await boot("in-realm");
  await during(inRealm.hub, inRealmSmoke(inRealm.hub, inRealm.origin));
  await during(inRealm.hub, filesSmoke(inRealm.hub, inRealm.origin));
  await close(inRealm.hub);

  const shipped = shippedArtifact();
  const hardened = await boot("hardened", {
    MANIFOLD_HARDENED_PLUGINS: MACHINES,
    // Artifact identity belongs to this package, not a value inherited from another build.
    MANIFOLD_FIRST_PARTY_ARTIFACTS: join(root, "not-the-packaged-artifacts"),
  });
  await during(hardened.hub, hardenedSmoke(hardened.hub, hardened.origin, shipped));
  await close(hardened.hub);

  const filesArtifact = shippedArtifact(FILES);
  const files = await boot("files-hardened", {
    MANIFOLD_HARDENED_PLUGINS: FILES,
    MANIFOLD_FIRST_PARTY_ARTIFACTS: join(root, "not-the-packaged-artifacts"),
  });
  await during(files.hub, filesSmoke(files.hub, files.origin, filesArtifact));
  await close(files.hub);

  await refusal("unsupported", "core.terminals", '"core.terminals" has no hardened source recipe');
  await refusal("unknown", "core.nothing", '"core.nothing" is not a plugin this build registers');
  console.log(
    `PASS  Nix packaging: ${system}, dependency rebuild, compiled agent and terminal client, hub ${version}, packaged web and asset, hardened ${MACHINES} artifact, Worker and lifecycle, cold compiled/hardened Files image publication and decoder bounds without source/dependency fallback, selector refusals`,
  );
} finally {
  requests.abort();
  try {
    for (const hub of [...hubs]) {
      try {
        await close(hub);
      } catch (error) {
        // Reported without masking whatever stopped the proof first.
        console.error(
          `Nix packaging cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
