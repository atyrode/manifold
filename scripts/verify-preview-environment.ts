#!/usr/bin/env bun
/** Real preview migration and browser smoke check; never targets an operator deployment. */
import {
  appendFileSync,
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:net";
import { isDeepStrictEqual } from "node:util";
import {
  ActionOutcomeSchema,
  ContainerResponseSchema,
  MachinesResponseSchema,
  TerminalsResponseSchema,
} from "../packages/protocol/src/index.ts";
import { SessionClient, base64ToText } from "../packages/sdk/src/index.ts";
import { Browser } from "./cdp.ts";
import { reserveLoopbackPort, sleep, until } from "./gate-lib.ts";

const args = process.argv.slice(2);
if (
  args.some((arg) => arg !== "--measure-storage" && arg !== "--integrated") ||
  new Set(args).size !== args.length
) {
  throw new Error(
    "usage: bun scripts/verify-preview-environment.ts [--measure-storage] [--integrated]",
  );
}
const integrated = args.includes("--integrated");
const measureStorage = args.includes("--measure-storage");
const repo = resolve(import.meta.dir, "..");
const started = Date.now();
const directory = mkdtempSync(join(tmpdir(), "manifold-preview-environment-"));
chmodSync(directory, 0o700);
const evidence = mkdtempSync(
  join(process.env["RUNNER_TEMP"] ?? tmpdir(), "preview-environment-artifacts-"),
);
chmodSync(evidence, 0o700);
const home = join(directory, "home");
const deployment = join(directory, "deployment");
const tooling = join(directory, "tooling");
const originRepo = join(directory, "origin.git");
const fixtureRepo = join(directory, "fixture");
const shims = join(directory, "host-services");
for (const path of [home, deployment, tooling, shims, join(home, ".docker")])
  mkdirSync(path, { recursive: true, mode: 0o700 });
const secrets = new Set<string>();
const clients = new Set<SessionClient>();
const ownedImages = new Set<string>();
const ownedTopologyVolumes = new Set<string>();
const ownedTopologyNetworks = new Set<string>();
const processes = new Set<Bun.Subprocess>();
const metrics: Record<string, unknown> = { integrated, measureStorage, artifacts: evidence };
const reports: { name: string; elapsedMs: number }[] = [];
let browser: Browser | null = null;
let number = "";
let ownsProject = false;
let port = 0;
let origin = "";
let revision = "";
let builder = "";
let dockerSocket = "";
let ownerKey = "";
let canvasId = "";
let machineId = "";
let originalTerminalId = "";
let sceneId = "";
let expectedScene: unknown;
let appUid = 1000;
let expectedBuild = "";
const baseIdentity: Record<string, string> = {};
let identityDigests = "";
let active = false;
let cleanupPromise: Promise<void> | undefined;
let commandTail = "";
let env: Record<string, string> = {};
const project = () => (integrated ? `manifold-dev-${number}` : `manifold-pr-${number}`);
const baseImage = () => (integrated ? `${project()}:base` : `manifold-pr-pr-${number}:base`);
const finalImage = () => (integrated ? `${project()}:local` : `manifold-pr-pr-${number}:local`);
const volume = () => `${project()}_manifold-data`;
const checkout = () => (integrated ? fixtureRepo : join(deployment, "checkouts", `pr-${number}`));
const machineName = () => (integrated ? "dev-hub" : `pr-${number}`);
const developmentOverlay = join(tooling, "fixture-development.yaml");
const pinPath = join(tooling, "environment-image.txt");
const adapterPath = join(tooling, "Dockerfile.environment");

function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function redact(text: string): string {
  for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
  return text.replace(/(#key=|Bearer\s+)[^\s"'<>]+/gi, "$1[redacted]");
}
interface CommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
  timeoutMs?: number;
  allowFailure?: boolean;
  confidential?: boolean;
}
async function command(
  argv: string[],
  options: CommandOptions = {},
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(argv, {
    cwd: options.cwd ?? directory,
    env: options.env ?? env,
    stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  processes.add(proc);
  const stop = (signal: NodeJS.Signals): void => {
    if (proc.exitCode !== null) return;
    try {
      process.kill(-proc.pid, signal);
    } catch {
      proc.kill(signal);
    }
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop("SIGTERM");
  }, options.timeoutMs ?? 60_000);
  const killTimer = setTimeout(() => stop("SIGKILL"), (options.timeoutMs ?? 60_000) + 5_000);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (!options.confidential)
      commandTail = redact(`${argv[0]} ${argv[1] ?? ""}:\n${out}\n${err}`).slice(-24_000);
    if (timedOut)
      throw new Error(`${argv[0]} ${argv[1] ?? ""} exceeded its bounded execution deadline`);
    if (code !== 0 && !options.allowFailure)
      throw new Error(
        `${argv[0]} ${argv[1] ?? ""} failed (${code})${options.confidential ? "" : `\n${commandTail}`}`,
      );
    return { code, out, err };
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    processes.delete(proc);
  }
}
const docker = (args: string[], options: CommandOptions = {}) =>
  command(["docker", ...args], options);
async function step(name: string, run: () => Promise<void>): Promise<void> {
  console.log(`RUN   ${name}`);
  const start = Date.now();
  await run();
  reports.push({ name, elapsedMs: Date.now() - start });
  console.log(`PASS  ${name} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
}
function composeEnv(image: string): Record<string, string> {
  return {
    ...env,
    ...baseIdentity,
    COMPOSE_PROJECT_NAME: project(),
    COMPOSE_FILE: integrated
      ? `${join(checkout(), "compose.yaml")}:${developmentOverlay}:${join(tooling, "compose.development.yaml")}`
      : `${join(checkout(), "compose.yaml")}:${join(tooling, "compose.preview.yaml")}`,
    MANIFOLD_DOMAIN: integrated ? "preview.preview.invalid" : `${number}.preview.invalid`,
    PREVIEW_PORT: String(port),
    PREVIEW_MACHINE: machineName(),
    PREVIEW_IMAGE: image,
  };
}
const compose = (image: string, args: string[], options: CommandOptions = {}) =>
  docker(["compose", "--env-file", "/dev/null", ...args], {
    cwd: checkout(),
    ...options,
    env: { ...composeEnv(image), ...options.env },
  });
async function containerId(): Promise<string> {
  const ids = (
    await docker([
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${project()}`,
      "--filter",
      "label=com.docker.compose.service=manifold",
    ])
  ).out
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  requireThat(ids.length === 1, "fixture must own exactly one manifold service container");
  return ids[0]!;
}
async function inspectContainer(): Promise<{
  Id: string;
  State: { Status: string; StartedAt: string; Health?: { Status: string } };
  Image: string;
  SizeRw?: number;
}> {
  return JSON.parse(
    (
      await docker([
        "inspect",
        "--size",
        await containerId(),
        "--format",
        '{"Id":{{json .Id}},"State":{"Status":{{json .State.Status}},"StartedAt":{{json .State.StartedAt}},"Health":{"Status":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}},"Image":{{json .Image}},"SizeRw":{{json .SizeRw}}}',
      ])
    ).out,
  );
}
async function health(): Promise<{ build: string; ok: boolean }> {
  const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(3_000) });
  requireThat(response.ok, `healthz returned HTTP ${response.status}`);
  return (await response.json()) as { build: string; ok: boolean };
}
async function ready(): Promise<void> {
  await until(
    async () => {
      try {
        const result = await health();
        return result.ok && result.build === expectedBuild;
      } catch {
        return false;
      }
    },
    150_000,
    "matching preview healthz within 150 seconds",
  );
  const inspect = await inspectContainer();
  const elapsedMs = Date.now() - Date.parse(inspect.State.StartedAt);
  requireThat(
    elapsedMs <= 150_000,
    "new preview exceeded its 150-second activation/readiness contract",
  );
  metrics["readinessMs"] ??= [] as number[];
  (metrics["readinessMs"] as number[]).push(elapsedMs);
}
async function rememberImages(): Promise<void> {
  for (const image of [baseImage(), finalImage()]) {
    const result = await docker(["image", "inspect", image, "--format", "{{.Id}}"], {
      allowFailure: true,
    });
    if (result.code === 0) ownedImages.add(result.out.trim());
  }
}
async function up(
  options: CommandOptions = {},
): Promise<{ code: number; out: string; err: string }> {
  active = true;
  const argv = integrated
    ? ["bash", join(tooling, "deploy-dev.sh"), revision]
    : ["bash", join(tooling, "preview.sh"), "up", number, revision];
  const result = await command(argv, {
    timeoutMs: 18 * 60_000,
    ...options,
  });
  await rememberImages();
  return result;
}
async function execBun(source: string, confidential = false): Promise<string> {
  return (
    await docker(["exec", "--user", `${appUid}:${appUid}`, "-i", await containerId(), "bun", "-"], {
      input: source,
      confidential,
    })
  ).out.trim();
}
async function acquireIdentity(dataDir = "/data"): Promise<void> {
  ownerKey = await execBun(
    `console.log((await Bun.file(${JSON.stringify(`${dataDir}/owner.key`)}).text()).trim())`,
    true,
  );
  requireThat(/^[0-9a-f]{64}$/.test(ownerKey), "fixture app did not generate an owner key");
  secrets.add(ownerKey);
}
async function digests(): Promise<string> {
  return execBun(
    `import { createHash } from 'node:crypto';
const files = ['/data/owner.key', '/data/preview-identity.key', '/data/agent.token'];
console.log(JSON.stringify(await Promise.all(files.map(async p => createHash('sha256').update(new Uint8Array(await Bun.file(p).arrayBuffer())).digest('hex')))));`,
    true,
  );
}
async function act(name: string, args: unknown): Promise<unknown> {
  const response = await fetch(`${origin}/api/actions/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(20_000),
  });
  requireThat(response.ok, `action ${name}: HTTP ${response.status}`);
  const result = ActionOutcomeSchema.parse(await response.json());
  requireThat(result.ok, `action ${name} refused`);
  return result.result;
}
async function session(id: string): Promise<SessionClient> {
  const client = new SessionClient({
    url: `${origin.replace(/^http/, "ws")}/ws/session`,
    containerId: id,
    token: ownerKey,
    reconnect: false,
  });
  clients.add(client);
  await Promise.race([
    client.connect(),
    sleep(20_000).then(() => {
      throw new Error("SDK connection timed out");
    }),
  ]);
  return client;
}
function closeClients(): void {
  for (const client of clients) client.close();
  clients.clear();
}
async function onlineMachine(): Promise<string> {
  let id = "";
  await until(
    async () => {
      const { machines } = MachinesResponseSchema.parse(await act("core.machines.list", {}));
      id = machines.find((machine) => machine.name === machineName() && machine.online)?.id ?? "";
      return id !== "";
    },
    30_000,
    "numbered preview machine online",
  );
  return id;
}
async function terminals() {
  return TerminalsResponseSchema.parse(await act("core.terminals.listAll", {})).terminals;
}
async function terminalProbe(id: string, homeId: string, label: string): Promise<void> {
  const client = await session(homeId);
  let received = "";
  client.on("terminal_output", (message) => {
    received = (received + base64ToText(message.data)).slice(-64_000);
  });
  client.on("terminal_snapshot", (message) => {
    received = (received + base64ToText(message.data)).slice(-64_000);
  });
  client.attachTerminal(id);
  client.takeTerminal(id);
  await sleep(500);
  // The full marker never occurs in the echoed command: only executed printf produces it.
  const marker = `${label}-${crypto.randomUUID()}`;
  client.sendTerminalInput(id, `printf '%s%s\\n' '${marker.slice(0, 12)}' '${marker.slice(12)}'\r`);
  await until(() => received.includes(marker), 15_000, `${label} live PTY command output`);
  client.close();
  clients.delete(client);
}
async function newTerminalProbe(label: string): Promise<{ id: string; homeId: string }> {
  const canvas = await session(canvasId);
  const terminal = await canvas.openTerminal({
    elementId: crypto.randomUUID(),
    cols: 100,
    rows: 30,
    machineId,
  });
  await terminalProbe(terminal.id, terminal.containerId, label);
  canvas.close();
  clients.delete(canvas);
  return { id: terminal.id, homeId: terminal.containerId };
}
async function processOwners(uid: number): Promise<void> {
  const result = JSON.parse(
    await execBun(`import { readdirSync, readFileSync, statSync } from 'node:fs';
const processes = readdirSync('/proc').filter(p => /^\\d+$/.test(p)).flatMap(pid => {
  try { const args = readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\\0');
    if (!args.includes('packages/server/src/main.ts') && !args.includes('packages/agent/src/main.ts')) return [];
    const status = readFileSync('/proc/' + pid + '/status', 'utf8');
    return [{ kind: args.includes('packages/server/src/main.ts') ? 'hub' : args.includes('--terminal-host') ? 'host' : 'transport', uid: Number(status.match(/^Uid:\\s+(\\d+)/m)[1]), gid: Number(status.match(/^Gid:\\s+(\\d+)/m)[1]) }];
  } catch { return []; }
});
console.log(JSON.stringify({ processes, socket: statSync('/data/terminal-host/host.sock').isSocket() }));`),
  ) as { processes: { kind: string; uid: number; gid: number }[]; socket: boolean };
  for (const kind of ["hub", "host", "transport"]) {
    const matches = result.processes.filter((process) => process.kind === kind);
    requireThat(
      matches.length === 1 && matches[0]!.uid === uid && matches[0]!.gid === uid,
      `${kind} must run exactly once as ${uid}:${uid}`,
    );
  }
  requireThat(result.socket, "real terminal-host socket was not reclaimed");
}
async function sceneSurvives(): Promise<void> {
  requireThat(
    (await digests()) === identityDigests,
    "owner, preview identity, or agent enrollment changed across deployment",
  );
  requireThat((await onlineMachine()) === machineId, "numbered preview machine identity changed");
  const canvas = await session(canvasId);
  await until(() => canvas.elements.has(sceneId), 10_000, "persisted scene element restored");
  requireThat(
    isDeepStrictEqual(canvas.elements.get(sceneId), expectedScene),
    "persisted scene content changed",
  );
  canvas.close();
  clients.delete(canvas);
  const rows = await terminals();
  requireThat(
    !rows.some((terminal) => terminal.id === originalTerminalId),
    "redeployment retained an old terminal that cannot survive container replacement",
  );
}
async function assertDataWrites(): Promise<void> {
  const name = `developer-write-${crypto.randomUUID()}`;
  const made = ContainerResponseSchema.parse(
    await act("core.index.createContainer", { name }),
  ).container;
  const reread = ContainerResponseSchema.parse(
    await act("core.index.readContainer", { containerId: made.id }),
  ).container;
  requireThat(reread.name === name, "developer server did not persist a real action");
  const ownership = JSON.parse(
    await execBun(`import { lstatSync, readdirSync } from 'node:fs';
let wrong = 0; const walk = p => { const s = lstatSync(p); if (s.uid !== 1000 || s.gid !== 1000) wrong++; if (s.isDirectory()) for (const name of readdirSync(p)) walk(p + '/' + name); };
walk('/data'); console.log(JSON.stringify({ wrong }));`),
  ) as { wrong: number };
  requireThat(
    ownership.wrong === 0,
    "persistent /data contains non-developer ownership after migration",
  );
}

interface DiskUsage {
  LayersSize: number;
  Images: {
    Id: string;
    Size: number;
    SharedSize: number;
    Containers: number;
    RepoTags: string[] | null;
  }[];
  Volumes: { Name: string; UsageData: { Size: number; RefCount: number } }[];
  BuildCache: { ID: string; Size: number; InUse: boolean; Shared: boolean }[];
}
async function diskUsage(): Promise<DiskUsage> {
  const disk = JSON.parse(
    (
      await command([
        "curl",
        "--fail",
        "--silent",
        "--show-error",
        "--max-time",
        "60",
        "--unix-socket",
        dockerSocket,
        "http://localhost/system/df",
      ])
    ).out,
  ) as DiskUsage;
  // Docker reports null rather than [] when a collection has no entries.
  disk.Images ??= [];
  disk.Volumes ??= [];
  disk.BuildCache ??= [];
  return disk;
}
async function storage(label: string): Promise<DiskUsage> {
  const disk = await diskUsage();
  const images = disk.Images.filter(
    (image) =>
      image.RepoTags?.some((tag) => [baseImage(), finalImage()].includes(tag)) ||
      ownedImages.has(image.Id),
  );
  const filesystem = statfsSync(directory);
  metrics[label] = {
    daemonLayersBytes: disk.LayersSize,
    daemonBuildCacheBytes: disk.BuildCache.reduce((sum, row) => sum + row.Size, 0),
    ownedImages: images.map((image) => ({
      id: image.Id,
      tags: image.RepoTags,
      sizeBytes: image.Size,
      sharedBytes: image.SharedSize,
      uniqueBytes: image.Size - image.SharedSize,
    })),
    ownedVolumeBytes: disk.Volumes.filter((row) => row.Name === volume()).map((row) => ({
      name: row.Name,
      bytes: row.UsageData.Size,
    })),
    ownedContainerWritableBytes: active ? (await inspectContainer()).SizeRw : 0,
    fixtureFilesystemFreeBytes: Number(filesystem.bavail) * Number(filesystem.bsize),
  };
  return disk;
}
async function freeRange(): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = 12_000 + Math.floor(Math.random() * 42_000);
    const sockets: Server[] = [];
    try {
      for (const value of [candidate, candidate + 1, candidate + 1000, candidate + 1001]) {
        const socket = createServer();
        sockets.push(socket);
        await new Promise<void>((resolve, reject) => {
          socket.once("error", reject);
          socket.listen(value, "127.0.0.1", resolve);
        });
      }
      return candidate;
    } catch {
      /* A collision belongs to another process; try another entire range. */
    } finally {
      for (const socket of sockets) if (socket.listening) socket.close();
    }
  }
  throw new Error("could not allocate a free preview/inspector port range");
}
async function fixtureRevision(marker: string): Promise<string> {
  // Only this private repository gets synthetic objects. No commits, refs, or worktrees in
  // the caller's checkout are touched; its unchanged old-style Dockerfile stays authoritative.
  await command(["git", "checkout", "--detach", revision || "HEAD"], { cwd: fixtureRepo });
  writeFileSync(join(fixtureRepo, ".preview-environment-fixture"), marker + "\n");
  await command(["git", "add", ".preview-environment-fixture"], { cwd: fixtureRepo });
  const tree = (await command(["git", "write-tree"], { cwd: fixtureRepo })).out.trim();
  const parent = (await command(["git", "rev-parse", "HEAD"], { cwd: fixtureRepo })).out.trim();
  const sha = (
    await command(["git", "commit-tree", tree, "-p", parent], {
      cwd: fixtureRepo,
      input: `preview environment fixture ${marker}\n`,
    })
  ).out.trim();
  await command(["git", "update-ref", `refs/heads/fixture-${marker}`, sha], { cwd: originRepo });
  await command(["git", "checkout", "--detach", sha], { cwd: fixtureRepo });
  return sha;
}
async function setup(): Promise<void> {
  for (const binary of ["bun", "docker", "git", "bash", "flock", "curl", "jq"])
    requireThat(Bun.which(binary) !== null, `missing runtime prerequisite: ${binary}`);
  if (!integrated) Browser.detect();
  const hostEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const endpoint = (
    await command(
      ["docker", "context", "inspect", "--format", '{{(index .Endpoints "docker").Host}}'],
      { env: hostEnv },
    )
  ).out.trim();
  const selectedEndpoint = process.env["DOCKER_HOST"] ?? endpoint;
  requireThat(
    selectedEndpoint.startsWith("unix:///"),
    "fixture requires a local Unix-socket Docker daemon, never a remote deployment",
  );
  dockerSocket = selectedEndpoint.slice("unix://".length);
  env = {
    PATH: `${shims}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local/state"),
    LANG: "C.UTF-8",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    CLICOLOR_FORCE: "1",
    DOCKER_HOST: selectedEndpoint,
    DOCKER_CONFIG: join(home, ".docker"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Preview environment fixture",
    GIT_AUTHOR_EMAIL: "preview@invalid",
    GIT_COMMITTER_NAME: "Preview environment fixture",
    GIT_COMMITTER_EMAIL: "preview@invalid",
    PREVIEW_HOME: deployment,
    PREVIEW_DEV_CHECKOUT: fixtureRepo,
    PREVIEW_DOMAIN: "preview.invalid",
    PREVIEW_ROUTER_PORT: String(reserveLoopbackPort()),
    PREVIEW_DEV_PORT: String(reserveLoopbackPort()),
  };
  await docker(["info", "--format", "{{.OSType}}"]);
  await docker(["compose", "version"]);
  requireThat(
    /^Driver:\s+docker$/m.test((await docker(["buildx", "inspect"])).out),
    "fixture requires the docker Buildx driver before its deliberate incompatible-builder case",
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = String(1_000_000_000 + Math.floor(Math.random() * 8_000_000_000));
    number = candidate;
    const containers = (
      await docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project()}`])
    ).out.trim();
    const volumes = (
      await docker(["volume", "ls", "-q", "--filter", `name=^${project()}_`])
    ).out.trim();
    const networks = (
      await docker([
        "network",
        "ls",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${project()}`,
      ])
    ).out.trim();
    const images = (await docker(["image", "ls", "-q", baseImage().split(":")[0]!])).out.trim();
    const legacyImages = integrated
      ? ""
      : (await docker(["image", "ls", "-q", `manifold-pr-${number}`])).out.trim();
    if (!containers && !volumes && !networks && !images && !legacyImages) {
      ownsProject = true;
      break;
    }
    number = "";
  }
  requireThat(number !== "", "unable to reserve a collision-free numeric preview identity");
  port = await freeRange();
  origin = `http://127.0.0.1:${port}`;
  env["PREVIEW_PORT_RANGE"] = `${port}-${port + 1}`;
  if (integrated) {
    env["PREVIEW_DEV_PORT"] = String(port);
    env["PREVIEW_DEV_URL"] = origin;
    env["MANIFOLD_DEV_SERVICE_OWNER_MACHINE_ID"] = `fixture-native-${number}`;
    env["MANIFOLD_DEV_SPAWN_AGENT"] = "0";
    env["COMPOSE_PROJECT_NAME"] = project();
    env["COMPOSE_FILE"] = `${join(fixtureRepo, "compose.yaml")}:${developmentOverlay}`;
    // The real host overlay's shape, scoped to this run's private project and port.
    // Docker, activation, protocol probes and lifecycle actions remain real.
    writeFileSync(
      developmentOverlay,
      `services:
  manifold:
    ports:
      - "127.0.0.1:${port}:7777"
    environment:
      MANIFOLD_MACHINE_NAME: dev-hub
  caddy:
    profiles: [bundled-proxy]
`,
    );
  }
  for (const shim of ["caddy", "systemctl"]) {
    const path = join(shims, shim);
    writeFileSync(
      path,
      "#!/bin/sh\n# The fixture never controls the operator's fixed host router service.\nexit 0\n",
      { mode: 0o700 },
    );
  }
  for (const name of [
    "preview.sh",
    "common.sh",
    "environment.sh",
    "deploy-dev.sh",
    "retained-server-only.ts",
    "compose.development.yaml",
    "caddy.sh",
    "compose.preview.yaml",
    "Dockerfile.environment",
    "environment-image.txt",
    "terminal-lifecycle.ts",
  ]) {
    cpSync(join(repo, "infra/previews", name), join(tooling, name));
  }
  if (!integrated) {
    const pin = readFileSync(pinPath, "utf8");
    requireThat(
      /^[^\s@]+@sha256:[0-9a-f]{64}\n?$/.test(pin),
      "fixture requires the real public digest pin in infra/previews/environment-image.txt",
    );
    metrics["environmentImage"] = pin.trim();
  }
  metrics["project"] = project();
  await command(["git", "clone", "--bare", "--no-hardlinks", repo, originRepo]);
  await command(["git", "clone", "--no-hardlinks", originRepo, fixtureRepo]);
  // Share private object storage only, so commit-tree's objects are immediately fetchable
  // from the private local origin without any push (and cannot enter the source checkout).
  writeFileSync(
    join(originRepo, "objects/info/alternates"),
    join(fixtureRepo, ".git/objects") + "\n",
  );
  revision = await fixtureRevision(crypto.randomUUID());
  const output = (
    await command(["bun", "scripts/build-identity.ts", "--env"], { cwd: fixtureRepo })
  ).out;
  for (const line of output.trim().split("\n")) {
    const match = /^export (MANIFOLD_(?:VERSION|BUILD|CHANNEL))=(.*)$/.exec(line);
    requireThat(match, "build-identity emitted an invalid environment row");
    baseIdentity[match[1]!] = match[2]!;
  }
  baseIdentity["MANIFOLD_CHANNEL"] = "development";
  expectedBuild = baseIdentity["MANIFOLD_BUILD"]!;
  metrics["revision"] = revision;
  metrics["build"] = expectedBuild;
}

async function screen(): Promise<string> {
  return browser!.evaluate<string>(
    "[...document.querySelectorAll('.xterm-rows')].map(el => el.innerText).join('\\n')",
  );
}
async function capture(name: string): Promise<void> {
  if (browser === null) return;
  const text = await screen();
  writeFileSync(join(evidence, `${name}.txt`), redact(text));
  const frame = await browser.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const data = frame.result?.["data"];
  requireThat(typeof data === "string", "Chromium did not return screenshot data");
  writeFileSync(join(evidence, `${name}.png`), Buffer.from(data, "base64"));
}
const virtualKeys: Record<string, number> = {
  Enter: 13,
  Escape: 27,
  ArrowDown: 40,
  ArrowRight: 39,
  KeyV: 86,
};
async function key(key: string, code: string, modifiers = 0): Promise<void> {
  const windowsVirtualKeyCode = virtualKeys[code];
  await browser!.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    modifiers,
    windowsVirtualKeyCode,
  });
  await browser!.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    modifiers,
    windowsVirtualKeyCode,
  });
}
async function focusTerminal(): Promise<void> {
  await browser!.evaluate(
    "(() => { const t = document.querySelector('.xterm-screen'); if (!t) throw new Error('no terminal screen'); for (const type of ['pointerdown','pointerup','click']) t.dispatchEvent(new (type === 'click' ? MouseEvent : PointerEvent)(type, {bubbles:true})); document.querySelector('.xterm-helper-textarea')?.focus(); })()",
  );
  await until(
    () =>
      browser!.evaluate<boolean>(
        "document.activeElement?.matches('.xterm-helper-textarea') === true",
      ),
    10_000,
    "native terminal keyboard focus",
  );
}
async function paste(text: string): Promise<void> {
  // Real browser clipboard + native keyboard paste, not synthetic ClipboardEvent or SDK input.
  await browser!.evaluate(`navigator.clipboard.writeText(${JSON.stringify(text)})`);
  await key("V", "KeyV", 2 | 8);
}
async function shellCommand(text: string, expected: string): Promise<void> {
  await focusTerminal();
  await paste(text);
  await key("Enter", "Enter");
  await until(
    async () => (await screen()).includes(expected),
    30_000,
    "browser shell command output",
  );
}
async function browserProof(): Promise<void> {
  browser = new Browser();
  // Incognito isolates the app's real localStorage and #key admission in Chromium memory.
  // No fake storage implementation, HTTP headers, or provider credentials are introduced.
  await browser.launch({ incognito: true });
  const targetInfo = await browser.send("Target.getTargetInfo", {});
  const browserContextId = (
    targetInfo.result?.["targetInfo"] as { browserContextId?: string } | undefined
  )?.browserContextId;
  requireThat(browserContextId, "fixture browser is not isolated in an incognito context");
  await browser.send("Browser.grantPermissions", {
    origin,
    browserContextId,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  await browser.send("Emulation.setDeviceMetricsOverride", {
    width: 1920,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await browser.goto(`${origin}/#key=${ownerKey}`);
  await until(
    () =>
      browser!.evaluate<boolean>("document.querySelector('[data-testid=identity-enter]') !== null"),
    20_000,
    "native fixture identity entry",
  );
  await browser.typeInto("input", `environment-${number}`);
  await browser.clickTestId("identity-enter");
  await until(
    () => browser!.evaluate<boolean>("localStorage.getItem('manifold.identity') !== null"),
    20_000,
    "native fixture identity admitted",
  );
  secrets.add(
    await browser.evaluate<string>("JSON.parse(localStorage.getItem('manifold.identity')).token"),
  );
  await browser.goto(`${origin}/p/${canvasId}`);
  await until(
    () =>
      browser!.evaluate<boolean>(
        "document.querySelector('[data-testid=machines-section] button[aria-expanded]') !== null",
      ),
    20_000,
    "machine sidebar",
  );
  await browser.evaluate(
    "(() => { const b = document.querySelector('[data-testid=machines-section] button[aria-expanded]'); if (b.getAttribute('aria-expanded') !== 'true') b.click(); })()",
  );
  const selector = `[aria-label="New terminal on ${machineName()}"]`;
  await until(
    () =>
      browser!.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}) !== null`),
    30_000,
    "numbered preview terminal button",
  );
  const before = new Set((await terminals()).map((terminal) => terminal.id));
  await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await until(
    () => browser!.evaluate<boolean>("document.querySelector('.xterm-rows') !== null"),
    30_000,
    "new browser terminal",
  );
  const opened = (await terminals()).find(
    (terminal) => !before.has(terminal.id) && terminal.status === "running",
  );
  requireThat(opened, "browser terminal button did not open a real session");
  await browser.goto(`${origin}/p/${opened.homeId}`);
  await until(
    () => browser!.evaluate<boolean>("document.querySelector('.xterm-rows') !== null"),
    20_000,
    "routed native terminal",
  );
  const shellMarker = `SHELL-${crypto.randomUUID()}`;
  await shellCommand(
    `printf '%s%s:%s:%s:%s:%s\\n' '${shellMarker.slice(0, 6)}' '${shellMarker.slice(6)}' "$(id -u)" "$(id -g)" "$ZSH_VERSION" "$HOME"`,
    `${shellMarker}:1000:1000:`,
  );
  requireThat(
    new RegExp(`${shellMarker}:1000:1000:[^:\\s]+:/home/developer`).test(await screen()),
    "browser terminal is not the configured developer zsh",
  );
  await shellCommand(
    "mkdir -p /workspace/preview-fixture; cd /workspace/preview-fixture; git init -q; printf '%s%s\\n' READY -GIT",
    "READY-GIT",
  );
  await capture("shell");
  const pasteMarker = `PASTE-${crypto.randomUUID()}`;
  await shellCommand(
    `printf '%s%s\\n' '${pasteMarker.slice(0, 6)}' '${pasteMarker.slice(6)}'`,
    pasteMarker,
  );
  await capture("shell-paste");
  await focusTerminal();
  // A welcome border can paint while OMP still owns a cooked prepaint prompt.
  // Wait for the application's actual paste-protocol opt-in, not that border.
  const observer = await session(opened.homeId);
  let pasteReady = false;
  let modeTail = "";
  const observeMode = (data: string): void => {
    modeTail += base64ToText(data);
    const enabled = modeTail.lastIndexOf("\u001b[?5522h");
    const disabled = modeTail.lastIndexOf("\u001b[?5522l");
    if (enabled !== -1 || disabled !== -1) pasteReady = enabled > disabled;
    modeTail = modeTail.slice(-16);
  };
  observer.on("terminal_output", (message) => observeMode(message.data));
  observer.on("terminal_snapshot", (message) => observeMode(message.data));
  observer.attachTerminal(opened.id);
  // Exercise the editor, not the upstream provider/setup wizard. Use OMP's supported
  // per-launch switch rather than manufacturing configuration or authentication state.
  // OMP 18.1.13/18.1.14's bare-launch fast prepaint misses enhanced-paste startup.
  // This explicit ephemeral compatibility launch bypasses that upstream bug; it is
  // not evidence that bare `omp` works before the upstream correction is released.
  await browser.typeText(
    "env -u NO_COLOR -u CI OMP_SKIP_SETUP=1 CLICOLOR_FORCE=1 COLORTERM=truecolor TERM=xterm-256color omp --no-session --no-extensions\r",
  );
  await until(
    async () => pasteReady && /(?:^|\n)╰─/.test(await screen()),
    90_000,
    "OMP native editor ready for an unsubmitted draft",
  );
  observer.close();
  clients.delete(observer);
  const draft = `preview-draft-${crypto.randomUUID()}-café界\nsecond-line-λ`;
  await paste(draft);
  const draftVisible = async () => {
    const text = await screen();
    return draft.split("\n").every((line) => text.includes(line));
  };
  await until(draftVisible, 20_000, "our Unicode multiline draft painted without submission");
  await capture("omp-draft");
  const pasteImage = async (number: number): Promise<void> => {
    await focusTerminal();
    await browser!.evaluate(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 128; canvas.height = 64;
      const context = canvas.getContext('2d');
      context.fillStyle = '#d020a0'; context.fillRect(0, 0, 64, 64);
      context.fillStyle = '#20b060'; context.fillRect(64, 0, 64, 64);
      const {promise, resolve} = Promise.withResolvers();
      canvas.toBlob(resolve, 'image/png');
      const blob = await promise;
      if (!blob) throw new Error('could not create clipboard PNG');
      await navigator.clipboard.write([new ClipboardItem({'image/png': blob})]);
    })()`);
    await key("V", "KeyV", 2 | 8);
    await until(
      async () => (await screen()).includes(`#${number}`) && (await draftVisible()),
      20_000,
      `OMP stages image attachment ${number} without submitting our draft`,
    );
  };
  await pasteImage(1);
  await capture("omp-image-paste");
  // Use Index's real rows to leave the terminal for an empty canvas, then reattach.
  // Root navigation restores the last room, so it would not actually detach this viewer.
  const indexCanvas = ContainerResponseSchema.parse(
    await act("core.index.createContainer", { name: `index-visit-${number}` }),
  ).container.id;
  const indexRow = `[data-tree-id="${indexCanvas}"] [aria-label^="Open "]`;
  await until(
    () =>
      browser!.evaluate<boolean>(`document.querySelector(${JSON.stringify(indexRow)}) !== null`),
    10_000,
    "Index lists the other canvas",
  );
  await browser.evaluate(`document.querySelector(${JSON.stringify(indexRow)}).click()`);
  await until(
    () => browser!.evaluate<boolean>("document.querySelector('.xterm-rows') === null"),
    10_000,
    "Index navigation detached the terminal viewer",
  );
  await capture("index");
  const terminalRow = `[data-tree-id="${canvasId}"] [aria-label^="Open "]`;
  await until(
    () =>
      browser!.evaluate<boolean>(`document.querySelector(${JSON.stringify(terminalRow)}) !== null`),
    10_000,
    "Index lists the canvas containing the terminal",
  );
  await browser.evaluate(`document.querySelector(${JSON.stringify(terminalRow)}).click()`);
  await until(draftVisible, 20_000, "same Unicode draft replayed after Index reattachment");
  requireThat(
    (await terminals()).some(
      (terminal) =>
        terminal.id === opened.id &&
        terminal.homeId === opened.homeId &&
        terminal.status === "running",
    ),
    "Index reattachment replaced the terminal session",
  );
  await browser.evaluate(
    `document.querySelector('[aria-label="Expand terminal to full view"]').click()`,
  );
  await until(draftVisible, 20_000, "reattached draft visible in expanded terminal");
  await capture("omp-reattached");
  await pasteImage(2);
  await capture("omp-image-paste-reattached");
  await browser.goto(`${origin}/p/${indexCanvas}`);
  await until(
    () => browser!.evaluate<boolean>("document.querySelector('.xterm-rows') === null"),
    10_000,
    "empty canvas ready for Code's independent terminal",
  );
  // OMP keeps its unsubmitted draft. Code gets a separate terminal through the same UI;
  // this contract must not depend on another application's quit-confirmation timing.
  await browser.evaluate(
    "(() => { const b = document.querySelector('[data-testid=machines-section] button[aria-expanded]'); if (b.getAttribute('aria-expanded') !== 'true') b.click(); })()",
  );
  const beforeCode = new Set((await terminals()).map((terminal) => terminal.id));
  await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  let codeHome = "";
  await until(
    async () => {
      codeHome =
        (await terminals()).find(
          (terminal) => !beforeCode.has(terminal.id) && terminal.status === "running",
        )?.homeId ?? "";
      return codeHome !== "";
    },
    30_000,
    "Code's separate native terminal",
  );
  await browser.goto(`${origin}/p/${codeHome}`);
  await until(
    () => browser!.evaluate<boolean>("document.querySelector('.xterm-rows') !== null"),
    20_000,
    "Code terminal rendered",
  );
  await shellCommand("cd /workspace/preview-fixture; printf '%s%s\\n' CODE -SHELL", "CODE-SHELL");
  await browser.typeText(
    "env -u NO_COLOR -u CI CLICOLOR_FORCE=1 COLORTERM=truecolor TERM=xterm-256color code\r",
  );
  await until(
    async () => /\bmodel\s+/.test(await screen()),
    60_000,
    "Code's real model dial rendered",
  );
  await key("ArrowDown", "ArrowDown");
  const selectedDial = (text: string): string | undefined =>
    text
      .split("\n")
      .map((row) => row.split("│", 1)[0]!.trim())
      .find((control) => control.includes("▸") && /\bmodel\s+/.test(control));
  await until(
    async () => selectedDial(await screen()) !== undefined,
    15_000,
    "Code model dial focused",
  );
  const previous = selectedDial(await screen());
  await capture("code-before");
  await key("ArrowRight", "ArrowRight");
  await until(
    async () => {
      const value = selectedDial(await screen());
      return value !== undefined && value !== previous;
    },
    15_000,
    "Code dial changes its displayed value",
  );
  await capture("code-after");
  await browser.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(1000);
  await capture("code-compact");
  requireThat(
    !(await screen()).includes("\ufffd"),
    "terminal rendered a Unicode replacement glyph",
  );
  await browser.close();
  browser = null;
}

async function preserveLive(
  name: string,
  mutate: () => Promise<void>,
  restore: () => Promise<void>,
  expectedError?: string,
): Promise<void> {
  const terminal =
    !integrated || machineId !== "" ? await newTerminalProbe(`before-${name}`) : null;
  const before = await inspectContainer();
  try {
    await mutate();
    const result = await up({ allowFailure: true, timeoutMs: 6 * 60_000 });
    requireThat(result.code !== 0, `${name} unexpectedly deployed`);
    if (expectedError)
      requireThat(
        (result.out + result.err).includes(expectedError),
        `${name} did not reach its intended refusal`,
      );
    const after = await inspectContainer();
    requireThat(
      after.Id === before.Id &&
        after.State.StartedAt === before.State.StartedAt &&
        after.State.Status === "running",
      `${name} stopped or replaced the previous container`,
    );
    requireThat((await health()).build === expectedBuild, `${name} damaged the old HTTP service`);
    await until(
      async () => (await inspectContainer()).State.Health?.Status === "healthy",
      40_000,
      `${name} old container remains healthy`,
    );
    if (terminal) await terminalProbe(terminal.id, terminal.homeId, `after-${name}`);
  } finally {
    await restore();
  }
}
function cleanup(): Promise<void> {
  return (cleanupPromise ??= teardown());
}
async function teardown(): Promise<void> {
  const running = [...processes];
  for (const proc of running) {
    if (proc.exitCode === null)
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        proc.kill("SIGTERM");
      }
  }
  if (running.length > 0) {
    await Promise.race([Promise.all(running.map((proc) => proc.exited)), sleep(5000)]);
    for (const proc of running) {
      if (proc.exitCode === null)
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          proc.kill("SIGKILL");
        }
    }
    await Promise.all(running.map((proc) => proc.exited));
  }
  closeClients();
  await browser?.close();
  browser = null;
  const failures: string[] = [];
  if (ownsProject) {
    // Exact project labels are a fallback for partially failed up/down, never a global prune.
    for (const [kind, query, removal] of [
      [
        "container",
        ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project()}`],
        ["rm", "-f", "-v"],
      ],
      [
        "network",
        [
          "network",
          "ls",
          "-q",
          "--no-trunc",
          "--filter",
          `label=com.docker.compose.project=${project()}`,
        ],
        ["network", "rm"],
      ],
      ["volume", ["volume", "ls", "-q", "--filter", `name=^${project()}_`], ["volume", "rm"]],
    ] as const) {
      const found = await docker([...query], { allowFailure: true });
      if (found.code !== 0) {
        failures.push(`could not list owned ${kind}`);
        continue;
      }
      const owned = new Set([
        ...found.out.trim().split(/\s+/).filter(Boolean),
        ...(kind === "volume"
          ? ownedTopologyVolumes
          : kind === "network"
            ? ownedTopologyNetworks
            : []),
      ]);
      for (const id of owned) {
        if ((await docker([...removal, id], { allowFailure: true })).code !== 0)
          failures.push(`could not remove owned ${kind} ${id}`);
      }
    }
    for (const tag of [
      baseImage(),
      finalImage(),
      ...(integrated ? [] : [`manifold-pr-${number}:local`]),
    ])
      await docker(["image", "rm", tag], { allowFailure: true });
    for (const image of ownedImages) {
      const found = await docker(["image", "inspect", image, "--format", "{{json .RepoTags}}"], {
        allowFailure: true,
      });
      if (found.code !== 0) continue;
      // Do not remove an image another consumer has tagged while this fixture was running.
      const tags = JSON.parse(found.out) as string[] | null;
      if (!tags || tags.length === 0) await docker(["image", "rm", image], { allowFailure: true });
    }
  }
  if (
    builder !== "" &&
    (await docker(["buildx", "rm", "--force", builder], { allowFailure: true })).code !== 0
  )
    failures.push(`could not remove owned Buildx builder ${builder}`);
  rmSync(directory, { recursive: true, force: true });
  requireThat(failures.length === 0, failures.join("; "));
}
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    interrupted = true;
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
let failure: unknown;
try {
  await step("private fixture prerequisites and local Git origin", setup);
  const initialStorage = await storage("before");
  if (integrated) {
    await step("retained server-only hub replacement preserves data and ownership", async () => {
      appUid = 0;
      await compose(finalImage(), ["up", "-d", "--build", "--no-deps", "manifold"], {
        timeoutMs: 18 * 60_000,
      });
      active = true;
      await rememberImages();
      await ready();
      await acquireIdentity();
      const made = ContainerResponseSchema.parse(
        await act("core.index.createContainer", { name: `retained-${number}` }),
      ).container;
      const retainedState = `import { statSync, chownSync } from 'node:fs';
import { createHash } from 'node:crypto';
const marker = '/data/retained-ownership';
if (!await Bun.file(marker).exists()) {
  await Bun.write(marker, 'retained'); chownSync(marker, 1234, 2345);
}
console.log(JSON.stringify({
  uid: statSync(marker).uid, gid: statSync(marker).gid,
  key: createHash('sha256').update(await Bun.file('/data/owner.key').text()).digest('hex'),
  identity: createHash('sha256').update(await Bun.file('/data/preview-identity.key').text()).digest('hex')
}));`;
      const before = await execBun(retainedState, true);
      const networks = (
        await docker([
          "inspect",
          await containerId(),
          "--format",
          "{{json .NetworkSettings.Networks}}",
        ])
      ).out;
      // A shared hub must not consult the disposable image pin or lifecycle program.
      rmSync(pinPath);
      rmSync(join(tooling, "terminal-lifecycle.ts"));
      await up();
      await ready();
      requireThat(
        (await execBun(retainedState, true)) === before,
        "retained identity or file ownership changed",
      );
      const reread = ContainerResponseSchema.parse(
        await act("core.index.readContainer", { containerId: made.id }),
      ).container;
      requireThat(reread.name === made.name, "retained canvas data changed");
      const afterNetworks = (
        await docker([
          "inspect",
          await containerId(),
          "--format",
          "{{json .NetworkSettings.Networks}}",
        ])
      ).out;
      requireThat(
        Object.keys(JSON.parse(networks)).join() === Object.keys(JSON.parse(afterNetworks)).join(),
        "retained network selection changed",
      );
      const machines = MachinesResponseSchema.parse(await act("core.machines.list", {})).machines;
      requireThat(
        !machines.some((machine) => machine.online),
        "server-only image spawned a local execution owner",
      );
      await preserveLive(
        "missing-native-owner",
        async () => {
          delete env["MANIFOLD_DEV_SERVICE_OWNER_MACHINE_ID"];
        },
        async () => {
          env["MANIFOLD_DEV_SERVICE_OWNER_MACHINE_ID"] = `fixture-native-${number}`;
        },
      );
      await preserveLive(
        "local-agent-forbidden",
        async () => {
          env["MANIFOLD_DEV_SPAWN_AGENT"] = "1";
        },
        async () => {
          env["MANIFOLD_DEV_SPAWN_AGENT"] = "0";
        },
      );
    });
    // Each actual overlay is used only to create this verifier's incumbent. The
    // deployment callback still resolves the ordinary desired retained stack.
    // Track auxiliary resource identities explicitly as well as labeling them for
    // project cleanup, including partial Compose failures.
    for (const scenario of [
      {
        name: "actual retained volume differs while expected volume still exists",
        actual: `volumes:\n  manifold-data:\n    name: ${project()}_wrong-data\n    external: true\n`,
        volume: `${project()}_wrong-data`,
      },
      {
        name: "actual retained subpath differs within the expected named volume",
        actual:
          "services:\n  manifold:\n    volumes:\n      - type: volume\n        source: manifold-data\n        target: /data\n        volume:\n          subpath: fixture-other-root\n",
        actualSubpath: true,
      },
      {
        name: "actual retained machine differs from desired dev-hub",
        actual:
          "services:\n  manifold:\n    environment:\n      MANIFOLD_MACHINE_NAME: other-hub\n",
      },
      {
        name: "actual retained selected network differs from desired network",
        actual: `networks:\n  default:\n    name: ${project()}_actual-other\n    external: true\n`,
        network: `${project()}_actual-other`,
      },
      {
        name: "actual retained data root uses the container writable layer",
        actual:
          "services:\n  manifold:\n    environment:\n      MANIFOLD_DATA_DIR: /app/other-data\n",
        dataDir: "/app/other-data",
      },
      {
        name: "desired retained network differs from actual selected network",
        desiredNetwork: true,
      },
      {
        name: "desired retained subpath differs within the actual named volume",
        desiredSubpath: true,
      },
      {
        name: "desired base data root overrides the image persisted root",
        desiredDataRoot: "base",
      },
      {
        name: "desired final Compose merge overrides the persisted root",
        desiredDataRoot: "final",
      },
    ]) {
      await step(scenario.name, async () => {
        const actualOverlay = join(tooling, "fixture-incumbent-topology.yaml");
        const finalOverlay = join(tooling, "compose.development.yaml");
        const baseConfig = readFileSync(developmentOverlay, "utf8");
        const finalConfig = readFileSync(finalOverlay, "utf8");
        const dataDir = scenario.dataDir ?? "/data";
        const restoreDesired = async (): Promise<void> => {
          writeFileSync(developmentOverlay, baseConfig);
          writeFileSync(finalOverlay, finalConfig);
        };
        try {
          for (const [kind, name, owned] of [
            ["volume", scenario.volume, ownedTopologyVolumes],
            ["network", scenario.network, ownedTopologyNetworks],
          ] as const) {
            if (!name) continue;
            const exists = await docker([kind, "inspect", name], {
              allowFailure: true,
              confidential: true,
            });
            requireThat(exists.code !== 0, `refusing to adopt an existing fixture ${kind}`);
            const created = await docker([
              kind,
              "create",
              "--label",
              `com.docker.compose.project=${project()}`,
              name,
            ]);
            owned.add(created.out.trim());
          }
          if (scenario.actual) {
            if (scenario.actualSubpath)
              await execBun(
                "import { mkdirSync } from 'node:fs'; mkdirSync('/data/fixture-other-root', { recursive: true });",
              );
            writeFileSync(actualOverlay, scenario.actual);
            await compose(finalImage(), ["up", "-d", "--no-build", "--no-deps", "manifold"], {
              env: { COMPOSE_FILE: `${composeEnv(finalImage())["COMPOSE_FILE"]}:${actualOverlay}` },
            });
            await ready();
            await acquireIdentity(dataDir);
          }
          // The wrong actual volume must not reduce to the already-covered
          // missing desired volume case.
          await docker(["volume", "inspect", volume(), "--format", "{{.Name}}"]);
          const made = ContainerResponseSchema.parse(
            await act("core.index.createContainer", { name: `topology-${crypto.randomUUID()}` }),
          ).container;
          const marker = `${dataDir}/topology-preservation`;
          await execBun(
            `await Bun.write(${JSON.stringify(marker)}, ${JSON.stringify(crypto.randomUUID())});`,
          );
          // Only fixture-owned keys are hashed; neither key material nor the
          // database is emitted. PID1 starttime proves the actual process survives.
          const state = `import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = ${JSON.stringify(dataDir)};
const marker = ${JSON.stringify(marker)};
const stat = readFileSync('/proc/1/stat', 'utf8');
console.log(JSON.stringify({
  start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
  uid: statSync(marker).uid, gid: statSync(marker).gid,
  marker: readFileSync(marker, 'utf8'),
  keys: ['owner.key', 'preview-identity.key'].map(name =>
    createHash('sha256').update(readFileSync(root + '/' + name)).digest('hex'))
}));`;
          const before = await execBun(state, true);
          await preserveLive(
            scenario.name,
            async () => {
              if (scenario.desiredSubpath) {
                await execBun(
                  "import { mkdirSync } from 'node:fs'; mkdirSync('/data/fixture-desired-root', { recursive: true });",
                );
                writeFileSync(
                  finalOverlay,
                  finalConfig.replace(
                    "    environment:",
                    "    volumes:\n      - type: volume\n        source: manifold-data\n        target: /data\n        volume:\n          subpath: fixture-desired-root\n    environment:",
                  ),
                );
              }
              if (scenario.desiredNetwork)
                writeFileSync(
                  developmentOverlay,
                  `${baseConfig}\nnetworks:\n  default:\n    name: ${project()}_desired-other\n`,
                );
              if (scenario.desiredDataRoot === "base")
                writeFileSync(
                  developmentOverlay,
                  baseConfig.replace(
                    "MANIFOLD_MACHINE_NAME: dev-hub",
                    "MANIFOLD_MACHINE_NAME: dev-hub\n      MANIFOLD_DATA_DIR: /app/other-data",
                  ),
                );
              if (scenario.desiredDataRoot === "final")
                writeFileSync(
                  finalOverlay,
                  finalConfig.replace(
                    'MANIFOLD_SPAWN_AGENT: "0"',
                    'MANIFOLD_SPAWN_AGENT: "0"\n      MANIFOLD_DATA_DIR: /app/other-data',
                  ),
                );
            },
            restoreDesired,
            scenario.desiredDataRoot || scenario.desiredSubpath
              ? "HOLD: retained replacement requires supported final topology and /data data root"
              : "HOLD: retained incumbent topology or /data data root does not match the replacement",
          );
          requireThat(
            (await execBun(state, true)) === before,
            `${scenario.name} changed the incumbent process, identity, data or ownership`,
          );
          const reread = ContainerResponseSchema.parse(
            await act("core.index.readContainer", { containerId: made.id }),
          ).container;
          requireThat(reread.name === made.name, `${scenario.name} changed retained canvas data`);
        } finally {
          await restoreDesired();
          if (scenario.actual) {
            // Fixture repair, never the deployment helper: the held mismatched
            // incumbent has already been checked intact before this replacement.
            await compose(finalImage(), ["up", "-d", "--no-build", "--no-deps", "manifold"]);
            await ready();
            await acquireIdentity();
          }
        }
      });
    }
    await step(
      "retained replacement holds a real incumbent execution owner and live work",
      async () => {
        // Reproduce the old default-spawning deployment, independently of the desired
        // server-only overlay that deploy-dev resolves. Null removes the inherited
        // replacement setting; the old image defaults to a local execution owner.
        const oldOverlay = join(tooling, "fixture-old-owner.yaml");
        writeFileSync(
          oldOverlay,
          `services:
  manifold:
    environment:
      MANIFOLD_SPAWN_AGENT: null
      MANIFOLD_SERVICE_OWNER_MACHINE_ID: null
`,
        );
        await compose(finalImage(), ["up", "-d", "--no-build", "--no-deps", "manifold"], {
          env: { COMPOSE_FILE: `${composeEnv(finalImage())["COMPOSE_FILE"]}:${oldOverlay}` },
        });
        await ready();
        await acquireIdentity();
        machineId = await onlineMachine();
        await processOwners(0);
        canvasId = ContainerResponseSchema.parse(
          await act("core.index.createContainer", { name: `retained-live-${number}` }),
        ).container.id;
        const work = await newTerminalProbe("retained-owner-before");
        const ownerProcesses = `import { readdirSync, readFileSync } from 'node:fs';
const rows = readdirSync('/proc').filter(pid => /^\\d+$/.test(pid)).flatMap(pid => {
  const args = readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\\0');
  if (!args.includes('packages/agent/src/main.ts')) return [];
  const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
  return [{ pid, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] }];
});
console.log(JSON.stringify(rows.sort((a, b) => Number(a.pid) - Number(b.pid))));`;
        const beforeOwners = await execBun(ownerProcesses);
        // Only the one-off Compose call used oldOverlay. up() still requests the
        // ordinary retained server-only replacement (MANIFOLD_DEV_SPAWN_AGENT=0).
        await preserveLive(
          "actual-incumbent-owner",
          async () => {},
          async () => {},
          "HOLD: retained incumbent is owning or has unsupported spawn configuration",
        );
        requireThat(
          (await execBun(ownerProcesses)) === beforeOwners,
          "retained refusal restarted the real local execution owner",
        );
        requireThat(
          (await onlineMachine()) === machineId,
          "retained refusal changed the execution owner identity",
        );
        await processOwners(0);
        requireThat(
          (await terminals()).some((terminal) => terminal.id === work.id),
          "retained refusal removed live work",
        );
        await terminalProbe(work.id, work.homeId, "retained-owner-after");
      },
    );
  } else {
    await step("fresh development volume and unchanged PR artifact", async () => {
      await up();
      await ready();
      await acquireIdentity();
      await processOwners(1000);
      canvasId = ContainerResponseSchema.parse(
        await act("core.index.createContainer", { name: `fresh-${number}` }),
      ).container.id;
      machineId = await onlineMachine();
      await newTerminalProbe("fresh-developer");
      await assertDataWrites();
      const labels = JSON.parse(
        (await docker(["image", "inspect", finalImage(), "--format", "{{json .Config.Labels}}"]))
          .out,
      ) as Record<string, string>;
      const pin = readFileSync(pinPath, "utf8").trim();
      requireThat(
        labels["org.opencontainers.image.revision"] === revision,
        "derived image revision does not identify the PR checkout",
      );
      requireThat(
        labels["org.opencontainers.image.base.name"] === pin &&
          labels["org.opencontainers.image.base.digest"] === pin.split("@")[1],
        "derived OCI base provenance does not identify the independent environment digest",
      );
      closeClients();
      await compose(finalImage(), ["down", "-v"]);
      active = false;
    });
    await step("real root hub, root agents, scene and SDK terminal before migration", async () => {
      appUid = 0;
      await compose(baseImage(), ["up", "-d", "--no-build", "manifold"]);
      active = true;
      await ready();
      await acquireIdentity();
      machineId = await onlineMachine();
      canvasId = ContainerResponseSchema.parse(
        await act("core.index.createContainer", { name: `migration-${number}` }),
      ).container.id;
      const canvas = await session(canvasId);
      sceneId = crypto.randomUUID();
      const element = {
        id: sceneId,
        type: "draw",
        x: 120,
        y: 120,
        width: 240,
        height: 180,
        zIndex: 1,
        points: [0, 0, 40, 60, 120, 30, 200, 140],
        strokeWidth: 3,
        color: "#e03131",
      };
      const saved = Promise.withResolvers<void>();
      const off = canvas.on("saved", () => saved.resolve());
      canvas.transact((tx) => tx.create(element));
      await Promise.race([
        saved.promise,
        sleep(10_000).then(() => {
          throw new Error("root scene write not acknowledged");
        }),
      ]);
      off();
      expectedScene = canvas.elements.get(sceneId);
      const terminal = await newTerminalProbe("root-migration");
      originalTerminalId = terminal.id;
      await processOwners(0);
      identityDigests = await digests();
      closeClients();
    });
    await step("same-volume root to UID1000 migration and persistent server writes", async () => {
      appUid = 1000;
      await up();
      await ready();
      await processOwners(1000);
      await sceneSurvives();
      await newTerminalProbe("migrated-developer");
      await assertDataWrites();
    });
    await step("native browser shell, OMP draft, Code dial and Index reattachment", browserProof);
    await step("stop/start preserves home; actual recreation resets home, not data", async () => {
      const marker = `home-${crypto.randomUUID()}`;
      await execBun(
        `await Bun.write('/home/developer/.preview-home-marker', ${JSON.stringify(marker)});`,
      );
      closeClients();
      await compose(finalImage(), ["exec", "-T", "manifold", "bun", "-", "retire"], {
        input: readFileSync(join(tooling, "terminal-lifecycle.ts"), "utf8"),
      });
      await compose(finalImage(), ["stop", "manifold"]);
      await compose(finalImage(), ["start", "manifold"]);
      await ready();
      await compose(finalImage(), ["exec", "-T", "manifold", "bun", "-", "resume"], {
        input: readFileSync(join(tooling, "terminal-lifecycle.ts"), "utf8"),
      });
      requireThat(
        (await execBun(
          "console.log(await Bun.file('/home/developer/.preview-home-marker').text())",
        )) === marker,
        "stop/start discarded the same container's home",
      );
      await sceneSurvives();
      await processOwners(1000);
      const before = await containerId();
      await compose(finalImage(), ["stop", "manifold"]);
      await compose(finalImage(), ["rm", "-f", "manifold"]);
      await up();
      await ready();
      requireThat((await containerId()) !== before, "recreation reused the original container");
      requireThat(
        (await execBun(
          "console.log(await Bun.file('/home/developer/.preview-home-marker').exists())",
        )) === "false",
        "new container inherited the disposable home",
      );
      await sceneSurvives();
      await newTerminalProbe("recreated-developer");
      await assertDataWrites();
    });
  }
  if (integrated) {
    await step("misdirected integrated machine refuses before touching the live hub", async () => {
      const overlay = readFileSync(developmentOverlay, "utf8");
      await preserveLive(
        "wrong-development-machine",
        async () => {
          writeFileSync(
            developmentOverlay,
            overlay.replace("MANIFOLD_MACHINE_NAME: dev-hub", "MANIFOLD_MACHINE_NAME: other-hub"),
          );
        },
        async () => {
          writeFileSync(developmentOverlay, overlay);
        },
        "integrated deployment requires the existing dev-hub",
      );
    });
    await step("shared integrated data volume refuses before live mutation", async () => {
      const overlay = readFileSync(developmentOverlay, "utf8");
      await preserveLive(
        "shared-development-volume",
        async () => {
          writeFileSync(
            developmentOverlay,
            `${overlay}\nvolumes:\n  manifold-data:\n    name: not-owned-by-${project()}\n`,
          );
        },
        async () => {
          writeFileSync(developmentOverlay, overlay);
        },
        "integrated deployment requires its project-owned manifold-data volume",
      );
    });
  } else {
    const goodPin = readFileSync(pinPath, "utf8");
    for (const malformed of [
      "",
      "development:latest\n",
      goodPin + "extra\n",
      goodPin.trim() + " \n",
    ]) {
      await step("malformed pin refuses without touching the live preview", () =>
        preserveLive(
          "malformed-pin",
          async () => {
            writeFileSync(pinPath, malformed);
          },
          async () => {
            writeFileSync(pinPath, goodPin);
          },
          "preview: expected a digest-pinned development image",
        ),
      );
    }
    await step("missing pin refuses before stop", () =>
      preserveLive(
        "missing-pin",
        async () => {
          rmSync(pinPath);
        },
        async () => {
          writeFileSync(pinPath, goodPin);
        },
        "preview: expected a digest-pinned development image",
      ),
    );
    await step("nonexistent digest fails a real build before stop", () =>
      preserveLive(
        "nonexistent-pin",
        async () => {
          writeFileSync(
            pinPath,
            goodPin.replace(/sha256:[0-9a-f]{64}/, `sha256:${"0".repeat(64)}`),
          );
        },
        async () => {
          writeFileSync(pinPath, goodPin);
        },
      ),
    );
    await step(
      "owned incompatible Buildx builder selected only in fixture environment",
      async () => {
        const candidate = `preview-environment-${crypto.randomUUID()}`;
        requireThat(
          (await docker(["buildx", "inspect", candidate], { allowFailure: true })).code !== 0,
          "generated Buildx builder name is already owned",
        );
        await docker(["buildx", "create", "--name", candidate, "--driver", "docker-container"]);
        builder = candidate;
        await preserveLive(
          "incompatible-builder",
          async () => {
            env["BUILDX_BUILDER"] = builder;
          },
          async () => {
            delete env["BUILDX_BUILDER"];
          },
          "preview: development image composition requires the docker Buildx driver",
        );
        await docker(["buildx", "rm", "--force", builder]);
        builder = "";
      },
    );
    await step("real failing derived protocol import refuses before stop", async () => {
      const adapter = readFileSync(adapterPath, "utf8");
      await preserveLive(
        "protocol-probe",
        async () => {
          writeFileSync(
            adapterPath,
            adapter +
              "\nRUN printf 'throw new Error(\"fixture-derived-protocol-probe\");\\n' > /app/packages/protocol/src/index.ts\n",
          );
        },
        async () => {
          writeFileSync(adapterPath, adapter);
        },
        "fixture-derived-protocol-probe",
      );
    });
    await step("restored public pin redeploys successfully", async () => {
      closeClients();
      await up();
      await ready();
      await processOwners(1000);
      await sceneSurvives();
      await newTerminalProbe("restored-good-image");
    });
    const firstStorage = await storage("oneBase");
    if (measureStorage) {
      await step("second distinct PR app base and measured incremental storage", async () => {
        const oldBase = (
          await docker(["image", "inspect", baseImage(), "--format", "{{.Id}}"])
        ).out.trim();
        revision = await fixtureRevision(crypto.randomUUID());
        const output = (
          await command(["bun", "scripts/build-identity.ts", "--env"], { cwd: fixtureRepo })
        ).out;
        for (const line of output.trim().split("\n")) {
          const match = /^export (MANIFOLD_(?:VERSION|BUILD|CHANNEL))=(.*)$/.exec(line);
          requireThat(match, "invalid second build identity");
          baseIdentity[match[1]!] = match[2]!;
        }
        baseIdentity["MANIFOLD_CHANNEL"] = "development";
        expectedBuild = baseIdentity["MANIFOLD_BUILD"]!;
        await up();
        await ready();
        await sceneSurvives();
        await newTerminalProbe("second-app-base");
        requireThat(
          (await docker(["image", "inspect", baseImage(), "--format", "{{.Id}}"])).out.trim() !==
            oldBase,
          "measurement did not build a distinct application base",
        );
        const secondStorage = await storage("twoBases");
        metrics["secondBaseIncrementalDaemonLayerBytes"] =
          secondStorage.LayersSize - firstStorage.LayersSize;
        metrics["secondBaseIncrementalDaemonBuildCacheBytes"] =
          secondStorage.BuildCache.reduce((sum, row) => sum + row.Size, 0) -
          firstStorage.BuildCache.reduce((sum, row) => sum + row.Size, 0);
      });
    }
    metrics["oneBaseIncrementalDaemonLayerBytes"] =
      firstStorage.LayersSize - initialStorage.LayersSize;
    await step("missing-pin down removes only fixture project, volume and app tags", async () => {
      closeClients();
      rmSync(pinPath);
      await command(["bash", join(tooling, "preview.sh"), "down", number], { timeoutMs: 120_000 });
      active = false;
      requireThat(
        (
          await docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project()}`])
        ).out.trim() === "",
        "down retained a fixture container",
      );
      requireThat(
        (await docker(["volume", "inspect", volume()], { allowFailure: true })).code !== 0,
        "down retained the data volume",
      );
      for (const image of [baseImage(), finalImage()])
        requireThat(
          (await docker(["image", "inspect", image], { allowFailure: true })).code !== 0,
          `down retained ${image}`,
        );
      requireThat(
        !readFileSync(join(deployment, "registry"), "utf8")
          .split("\n")
          .some((row) => row.startsWith(number + " ")),
        "down retained fixture registry entry",
      );
    });
  }
} catch (error) {
  failure = error;
  try {
    await capture("failure");
  } catch {
    /* Keep the original failure when Chromium has already exited. */
  }
  if (browser)
    writeFileSync(
      join(evidence, "browser-errors.txt"),
      redact(JSON.stringify(browser.drainMessages(), null, 2)),
    );
  writeFileSync(join(evidence, "command-tail.txt"), redact(commandTail));
  if (active) {
    try {
      writeFileSync(
        join(evidence, "container-logs.txt"),
        redact(
          (await docker(["logs", "--tail", "150", await containerId()], { confidential: true }))
            .out,
        ),
      );
    } catch {
      /* Partial deployment need not have a container yet. */
    }
  }
} finally {
  if (!interrupted) {
    try {
      await cleanup();
    } catch (error) {
      failure ??= error;
    }
    metrics["elapsedMs"] = Date.now() - started;
    metrics["steps"] = reports;
    metrics["ok"] = failure === undefined;
    writeFileSync(join(evidence, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n");
    const summary = `## Preview development environment\n\n${failure === undefined ? "PASS" : "FAIL"} — ${((Date.now() - started) / 1000).toFixed(1)} seconds.\n\n${integrated ? "Nonsecret evidence" : "Screenshots and nonsecret evidence"}: \`${evidence}\`.\n\nStorage values are Docker Engine measurements in bytes. Per-image shared/unique sizes and owned volume/container writable bytes are explicit; daemon layer/cache deltas may include concurrent daemon users and are not claimed as exclusively owned. No shared cache or environment-image pruning is performed.\n\n\`\`\`json\n${JSON.stringify(metrics, null, 2)}\n\`\`\`\n`;
    const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
    if (summaryPath) appendFileSync(summaryPath, summary);
    console.log(summary);
  }
}
if (failure !== undefined) {
  console.error(
    `preview-environment: FAIL\n${redact(failure instanceof Error ? failure.message : String(failure))}`,
  );
  process.exitCode = 1;
} else
  console.log(
    integrated
      ? "preview-environment: PASS (retained server-only topology and state preservation)"
      : "preview-environment: PASS (screenshots require visual inspection)",
  );
