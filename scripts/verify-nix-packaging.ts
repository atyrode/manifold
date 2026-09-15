#!/usr/bin/env bun
/** Verify native Nix outputs without a workspace install or a live machine owner. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

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
    if (code !== 0) throw new Error(`${argv[0]} ${argv[1] ?? ""} failed (${code})`);
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
  return output;
}

const deps = await build("bun-deps");
if ((await build("bun-deps", true)) !== deps) {
  throw new Error("Nix dependency rebuild returned a different output path");
}
const agentOutput = await build("manifold-agent");
const serverOutput = await build("manifold-server");
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
const root = mkdtempSync(join(tmpdir(), "manifold-nix-packaging-"));
let server: Bun.Subprocess<"ignore", "pipe", "inherit"> | undefined;
let output: Promise<void> | undefined;
const requests = new AbortController();
const ready = Promise.withResolvers<string>();
let readyTimer: NodeJS.Timeout | undefined;
const interruptSmoke = () => ready.reject(interrupted.signal.reason);

try {
  chmodSync(root, 0o700);
  const cwd = join(root, "cwd");
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  const emptyPath = join(root, "bin");
  for (const path of [cwd, home, temporary, emptyPath]) mkdirSync(path, { mode: 0o700 });
  // The wrappers must supply their own runtime inputs, not inherit an operator's
  // credentials, source paths, native-owner settings or configuration directories.
  const env = { HOME: home, TMPDIR: temporary, PATH: emptyPath, LANG: "C", LC_ALL: "C" };
  await command(
    [join(agentOutput, "bin/manifold-agent"), "--maintenance", "--help"],
    30_000,
    cwd,
    env,
  );

  interrupted.signal.throwIfAborted();
  server = Bun.spawn([join(serverOutput, "bin/manifold-server")], {
    cwd,
    env: {
      ...env,
      MANIFOLD_BIND: "127.0.0.1",
      MANIFOLD_PORT: "0",
      MANIFOLD_DATA_DIR: join(root, "data"),
      MANIFOLD_SPAWN_AGENT: "0",
      MANIFOLD_ANNOUNCE_KEY: "0",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  interrupted.signal.addEventListener("abort", interruptSmoke, { once: true });
  readyTimer = setTimeout(
    () => ready.reject(new Error("Packaged server readiness exceeded 30s")),
    30_000,
  );
  const stdout = server.stdout;
  output = (async () => {
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
        if (buffered.length > 64_000)
          throw new Error("Packaged server emitted an oversized log line");
        for (const line of lines) {
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
            throw new Error("Packaged server announced an unexpected readiness URL");
          url.hostname = "127.0.0.1";
          ready.resolve(url.origin);
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();

  async function smoke(): Promise<void> {
    const origin = await ready.promise;
    clearTimeout(readyTimer);
    // node:http goes directly to this loopback listener, irrespective of inherited
    // HTTP proxy settings. Requests never carry credentials or follow redirects.
    const request = (pathname: string): Promise<Buffer> => {
      const { promise, resolve: resolveBody, reject } = Promise.withResolvers<Buffer>();
      const req = get(
        new URL(pathname, origin),
        {
          agent: false,
          signal: AbortSignal.any([
            interrupted.signal,
            requests.signal,
            AbortSignal.timeout(5_000),
          ]),
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("error", reject);
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            if (response.statusCode !== 200)
              reject(new Error(`Packaged server ${pathname} returned HTTP ${response.statusCode}`));
            else resolveBody(Buffer.concat(chunks));
          });
        },
      );
      req.on("error", reject);
      return promise;
    };
    const health: unknown = JSON.parse((await request("/healthz")).toString("utf8"));
    if (
      typeof health !== "object" ||
      health === null ||
      !("ok" in health) ||
      health.ok !== true ||
      !("version" in health) ||
      health.version !== version
    )
      throw new Error(`Packaged server health did not report ok and version ${version}`);

    const webDist = join(serverOutput, "share/manifold/web");
    const html = (await request("/")).toString("utf8");
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
    const bytes = await request(asset.pathname);
    if (bytes.length === 0 || !bytes.equals(readFileSync(assetPath))) {
      throw new Error("Packaged server did not serve its referenced built asset");
    }
  }

  await Promise.race([
    smoke(),
    server.exited.then((code) => {
      throw new Error(`Packaged server exited during smoke (${code})`);
    }),
    output.then(() => {
      throw new Error("Packaged server output closed during smoke");
    }),
  ]);
  if (server.exitCode !== null)
    throw new Error(`Packaged server exited during smoke (${server.exitCode})`);
  console.log(
    `PASS  Nix packaging: ${system}, dependency rebuild, compiled agent, hub ${version}, packaged web and asset`,
  );
} finally {
  clearTimeout(readyTimer);
  interrupted.signal.removeEventListener("abort", interruptSmoke);
  requests.abort();
  try {
    if (server !== undefined) await stop(server);
    await output;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
