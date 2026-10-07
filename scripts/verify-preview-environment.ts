#!/usr/bin/env bun
/** Real preview migration and browser smoke check; never targets an operator deployment. */
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statfsSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { Y } from "../packages/scene/src/index.ts";
import { retainedProcessAdmission, retainedProcessRefusal } from "./retained-process-holds.ts";
import {
  ActionOutcomeSchema,
  canonicalJobJson,
  ContainerResponseSchema,
  IndexResponseSchema,
  JOB_OWNER_PROTOCOL_VERSION,
  JobDeploymentReviewSchema,
  JobDescriptionSchema,
  MachineEnrollResponseSchema,
  MachinesResponseSchema,
  PLUGIN_BUNDLE_PROTOCOL_COMPAT_VERSIONS,
  PluginBundleSchema,
  PluginReplacementSetSchema,
  PluginsResponseSchema,
  PROTOCOL_VERSION,
  ServerToAgentMessageSchema,
  TerminalsResponseSchema,
  type JobCommand,
  type JobOwner,
  type PluginManifest,
  type PluginReplacementSet,
} from "../packages/protocol/src/index.ts";
import { BUILT_AGAINST_PROTOCOL } from "../packages/plugin-kit/src/pack.ts";
import { SessionClient, base64ToText } from "../packages/sdk/src/index.ts";
import { deriveBuildIdentity } from "./build-identity.ts";
import { openDatabase } from "../packages/server/src/db.ts";
import { Browser } from "./cdp.ts";
import { reserveLoopbackPort, sleep, until } from "./gate-lib.ts";

const args = process.argv.slice(2);
if (
  args.some(
    (arg) => arg !== "--measure-storage" && arg !== "--integrated" && arg !== "--crossing",
  ) ||
  new Set(args).size !== args.length ||
  (args.includes("--integrated") && args.includes("--crossing"))
) {
  throw new Error(
    "usage: bun scripts/verify-preview-environment.ts [--measure-storage] [--integrated | --crossing]",
  );
}
/** A staged bundle crossing (#1068), rehearsed through the integrated fixture's real receiver. */
const crossing = args.includes("--crossing");
const integrated = crossing || args.includes("--integrated");
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
const tooling = join(directory, "installed", "infra", "previews");
const originRepo = join(directory, "origin.git");
const fixtureRepo = join(directory, "fixture");
const shims = join(directory, "host-services");
const hostileIdentityMarker = join(directory, "hostile-build-identity-ran");
const seededContainerId = `seeded-${crypto.randomUUID()}`;
const seededFolderId = `seeded-folder-${crypto.randomUUID()}`;
const seededOwnerKey = randomBytes(32).toString("hex");
const seededBearer = randomBytes(32).toString("hex");
const seededSigningKey = "development-preview-signing-sentinel";
const seededAgentToken = "development-agent-token-sentinel";
for (const path of [home, deployment, tooling, shims, join(home, ".docker")])
  mkdirSync(path, { recursive: true, mode: 0o700 });
const secrets = new Set<string>();
const clients = new Set<SessionClient>();
const ownedImages = new Set<string>();
const ownedTopologyVolumes = new Set<string>();
const ownedTopologyNetworks = new Set<string>();
const processes = new Set<Bun.Subprocess>();
const metrics: Record<string, unknown> = {
  integrated,
  crossing,
  measureStorage,
  artifacts: evidence,
};
const reports: { name: string; elapsedMs: number }[] = [];
let browser: Browser | null = null;
let peerBrowser: Browser | null = null;
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
let originalTerminalHomeId = "";
let refusedMachineId = "";
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
      commandTail = (
        commandTail +
        redact(
          `\n${new Date().toISOString()} ${argv[0]} ${argv[1] ?? ""} (${code}):\n${out}\n${err}`,
        )
      ).slice(-24_000);
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
      : join(tooling, "compose.preview.yaml"),
    MANIFOLD_DOMAIN: integrated ? "preview.preview.invalid" : `${number}.preview.invalid`,
    PREVIEW_PORT: String(port),
    PREVIEW_MACHINE: machineName(),
    PREVIEW_IMAGE: image,
  };
}
const compose = (image: string, args: string[], options: CommandOptions = {}) =>
  docker(["compose", "--env-file", "/dev/null", ...args], {
    cwd: integrated ? checkout() : tooling,
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
  State: {
    Status: string;
    StartedAt: string;
    FinishedAt: string;
    ExitCode: number;
    OOMKilled: boolean;
    Health?: { Status: string };
  };
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
        '{"Id":{{json .Id}},"State":{"Status":{{json .State.Status}},"StartedAt":{{json .State.StartedAt}},"FinishedAt":{{json .State.FinishedAt}},"ExitCode":{{json .State.ExitCode}},"OOMKilled":{{json .State.OOMKilled}},"Health":{"Status":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}},"Image":{{json .Image}},"SizeRw":{{json .SizeRw}}}',
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
  let lastObservation = "healthz unavailable";
  try {
    await until(
      async () => {
        try {
          const result = await health();
          lastObservation = `healthz ok=${String(result.ok)} build=${result.build}`;
          return result.ok && result.build === expectedBuild;
        } catch (error) {
          lastObservation = `healthz unavailable (${error instanceof Error ? redact(error.message) : "unknown error"})`;
          return false;
        }
      },
      150_000,
      "matching preview healthz within 150 seconds",
    );
  } catch (error) {
    let container = "container inspection unavailable";
    try {
      const inspect = await inspectContainer();
      container = `container status=${inspect.State.Status} health=${inspect.State.Health?.Status ?? "none"}`;
    } catch {
      // A missing container must not replace the original readiness timeout.
    }
    throw new Error(
      `timed out waiting for matching preview healthz within 150 seconds; ${lastObservation}; ${container}`,
      { cause: error },
    );
  }
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
  const images = integrated
    ? [finalImage(), `${project()}:candidate`]
    : [baseImage(), finalImage()];
  for (const image of images) {
    const result = await docker(["image", "inspect", image, "--format", "{{.Id}}"], {
      allowFailure: true,
    });
    if (result.code === 0) ownedImages.add(result.out.trim());
  }
}
/**
 * One receiver request. `last` is its optional final argument: a forward crossing's staged set
 * digest, or a manual rollback's restore plan.
 */
async function up(
  options: CommandOptions = {},
  rollbackFrom?: string,
  last?: string,
): Promise<{ code: number; out: string; err: string }> {
  active = true;
  const argv = integrated
    ? ["bash", join(tooling, "receiver.sh")]
    : ["bash", join(tooling, "preview.sh"), "up", number, revision];
  const requestOptions: CommandOptions = { timeoutMs: 18 * 60_000, ...options };
  if (integrated) {
    requestOptions.env = {
      ...(options.env ?? env),
      SSH_ORIGINAL_COMMAND: [
        ...(rollbackFrom === undefined
          ? ["dev", revision]
          : ["dev-rollback", rollbackFrom, revision]),
        ...(last === undefined ? [] : [last]),
      ].join(" "),
    };
  }
  const result = await command(argv, requestOptions);
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
  if (!result.ok) throw new Error(`action ${name} refused: ${JSON.stringify(result.denial)}`);
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
async function createRefusedMachine(): Promise<void> {
  const enrolled = MachineEnrollResponseSchema.parse(
    await act("core.machines.enroll", { name: `stale-pr-${number}` }),
  );
  requireThat(enrolled.machineToken !== undefined, "refusal fixture did not mint a machine token");
  secrets.add(enrolled.machineToken);
  refusedMachineId = enrolled.machine.id;
  const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/ws/machine`);
  const closed = Promise.withResolvers<CloseEvent>();
  socket.addEventListener("open", () => {
    socket.send(
      JSON.stringify({
        type: "hello",
        token: enrolled.machineToken,
        name: enrolled.machine.name,
        agentVersion: "refusal-fixture",
        protocolVersion: 1,
        terminals: [],
      }),
    );
  });
  socket.addEventListener("close", (event) => closed.resolve(event), { once: true });
  const event = await Promise.race([
    closed.promise,
    sleep(20_000).then(() => {
      socket.close();
      throw new Error("machine refusal fixture timed out");
    }),
  ]);
  requireThat(event.code === 4409, "stale preview node did not receive protocol refusal");
  await until(
    async () =>
      MachinesResponseSchema.parse(await act("core.machines.list", {})).machines.some(
        (machine) => machine.id === refusedMachineId && machine.lastRefusal?.code === 4409,
      ),
    10_000,
    "machine refusal published to the roster",
  );
}
async function assertDeploymentProbeClean(): Promise<void> {
  const items = IndexResponseSchema.parse(await act("core.index.read", {})).items;
  requireThat(
    !items.some(
      (item) =>
        item.kind === "container" && item.container.name.startsWith("preview-deployment-probe-"),
    ),
    "deployment verification left its disposable canvas behind",
  );
}
async function terminalProbe(id: string, homeId: string, label: string): Promise<void> {
  const client = await session(homeId);
  let received = "";
  client.on("terminal_output", (message) => {
    if (message.terminalId !== id || message.viewportId !== "sdk") return;
    received = (received + base64ToText(message.data)).slice(-64_000);
    client.ackTerminal(id, "sdk", message.deliveryId, message.deliverySeq);
  });
  client.on("terminal_snapshot", (message) => {
    if (message.terminalId !== id || message.viewportId !== "sdk") return;
    received = (received + base64ToText(message.data)).slice(-64_000);
    client.ackTerminal(id, "sdk", message.deliveryId, message.deliverySeq);
  });
  client.on("terminal_geometry", (message) => {
    if (message.terminalId !== id || message.viewportId !== "sdk") return;
    client.ackTerminal(id, "sdk", message.deliveryId, message.deliverySeq);
  });
  client.attachTerminal(id, "sdk");
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
  // Synthetic revisions stay inside the private fixture repository. The caller's
  // source and refs are never changed, including when testing an unsafe image recipe.
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
async function fixtureChild(parent: string, marker: string, treeOf = parent): Promise<string> {
  // Create a new commit object over TREEOF's application tree, by default the parent's own.
  // Objects and refs remain in this run's private repositories; source and main are untouched.
  const tree = (
    await command(["git", "rev-parse", `${treeOf}^{tree}`], { cwd: fixtureRepo })
  ).out.trim();
  const sha = (
    await command(["git", "commit-tree", tree, "-p", parent], {
      cwd: fixtureRepo,
      input: `preview deployment ordering fixture ${marker}\n`,
    })
  ).out.trim();
  await command(["git", "update-ref", `refs/heads/fixture-order-${marker}`, sha], {
    cwd: originRepo,
  });
  return sha;
}
async function setup(): Promise<void> {
  for (const binary of ["bun", "docker", "git", "bash", "flock", "curl", "jq", "tar"])
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
  if (!integrated) {
    const seedRoot = join(directory, "seed-source");
    const seedData = join(seedRoot, "data");
    const seedArchive = join(directory, "development-seed.tgz");
    mkdirSync(seedData, { recursive: true, mode: 0o700 });
    const seedDatabase = openDatabase(join(seedData, "manifold.db"));
    const bearerHash = createHash("sha256").update(seededBearer).digest("hex");
    seedDatabase.exec(`
      INSERT INTO container_folders(id,name,created_at,parent_folder_id,sort_order)
        VALUES ('${seededFolderId}','Representative folder',1,NULL,0);
      INSERT INTO containers(id,name,created_at,sort_order,folder_id,discipline)
        VALUES ('${seededContainerId}','Representative seed',2,0,'${seededFolderId}','canvas');
      INSERT INTO principals(id,kind,name,color,created_at,origin)
        VALUES ('seed-development-human','human','Development human','#000000',3,NULL);
      INSERT INTO grants(id,principal_kind,principal_id,node,caps,effect,reach,created_by,created_at)
        VALUES ('seed-development-grant','principal','seed-development-human','manifold://','["*"]','allow','subtree','owner',3);
      INSERT INTO tokens(id,hash,principal_id,minted_by,caps,container_id,created_at,revoked_at,grant_id,expires_at)
        VALUES ('seed-development-token','${bearerHash}','seed-development-human','owner','["*"]',NULL,3,NULL,'seed-development-grant',NULL);
      INSERT INTO dials(id,origin,secret,ref,caps,title,dialed_at,revoked_at)
        VALUES ('seed-development-dial','https://host.invalid','development-dial-secret','manifold://container/${seededContainerId}','[]','Development dial',3,NULL);
      INSERT INTO meta(key,value) VALUES ('jobs:signing-key','development-job-signing-secret');
    `);
    const representativeDoc = new Y.Doc();
    const representativeUpdate = Y.encodeStateAsUpdate(representativeDoc);
    representativeDoc.destroy();
    seedDatabase
      .query<void, [string, string, number, number, string, Uint8Array]>(
        "INSERT INTO scene_docs(container_id,epoch,rev,ts,hash,doc) VALUES (?,?,?,?,?,?)",
      )
      .run(
        seededContainerId,
        "representative-epoch",
        1,
        4,
        createHash("sha256").update(representativeUpdate).digest("hex"),
        representativeUpdate,
      );
    seedDatabase.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    seedDatabase.close();
    writeFileSync(join(seedData, "owner.key"), seededOwnerKey, { mode: 0o600 });
    writeFileSync(join(seedData, "preview-identity.key"), seededSigningKey, { mode: 0o600 });
    writeFileSync(join(seedData, "agent.token"), seededAgentToken, { mode: 0o600 });
    writeFileSync(join(seedData, "development-only.secret"), "must-not-cross", { mode: 0o600 });
    await command(["tar", "czf", seedArchive, "-C", seedRoot, "data"]);
    env["PREVIEW_SEED"] = seedArchive;
    for (const secret of [seededOwnerKey, seededBearer, seededSigningKey, seededAgentToken])
      secrets.add(secret);
  }
  writeFileSync(join(deployment, "env"), "", { mode: 0o600 });
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
    "receiver.sh",
    "common.sh",
    "environment.sh",
    "deploy-dev.sh",
    "deployment-order.sh",
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
  cpSync(join(repo, "Dockerfile"), resolve(tooling, "../../Dockerfile"));
  const trustedScripts = resolve(tooling, "../..", "scripts");
  mkdirSync(trustedScripts, { recursive: true, mode: 0o700 });
  cpSync(join(repo, "scripts", "build-identity.ts"), join(trustedScripts, "build-identity.ts"));
  cpSync(join(repo, "scripts", "preview-seed.ts"), join(trustedScripts, "preview-seed.ts"));
  // deploy-dev.sh verifies a staged replacement set with the installed checkout's own sources,
  // as the host's full tooling checkout does; they are read, never changed.
  cpSync(
    join(repo, "scripts", "bundle-replacement.ts"),
    join(trustedScripts, "bundle-replacement.ts"),
  );
  symlinkSync(join(repo, "packages"), resolve(tooling, "../..", "packages"));
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
  const initialIdentity = deriveBuildIdentity(fixtureRepo, revision);
  baseIdentity["MANIFOLD_VERSION"] = initialIdentity.version;
  baseIdentity["MANIFOLD_BUILD"] = initialIdentity.build;
  baseIdentity["MANIFOLD_CHANNEL"] = "development";
  expectedBuild = initialIdentity.build;
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
  requireThat(refusedMachineId !== "", "refused preview node fixture is absent");
  await until(
    () =>
      browser!.evaluate<boolean>(
        "document.body.innerText.includes('Admission refused (4409)') && document.body.innerText.includes('protocol mismatch; update this node to the hub build')",
      ),
    20_000,
    "machine roster renders the actionable admission refusal",
  );
  await capture("machine-admission-refusal");
  await act("core.machines.revoke", { machineId: refusedMachineId });
  await act("core.machines.forget", { machineId: refusedMachineId });
  refusedMachineId = "";
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
  peerBrowser = new Browser();
  await peerBrowser.launch({ incognito: true });
  await peerBrowser.goto(`${origin}/#key=${ownerKey}`);
  await until(
    () =>
      peerBrowser!.evaluate<boolean>(
        "document.querySelector('[data-testid=identity-enter]') !== null",
      ),
    20_000,
    "second browser identity entry",
  );
  await peerBrowser.typeInto("input", `second-viewer-${number}`);
  await peerBrowser.clickTestId("identity-enter");
  await until(
    () => peerBrowser!.evaluate<boolean>("localStorage.getItem('manifold.identity') !== null"),
    20_000,
    "second browser identity admitted",
  );
  secrets.add(
    await peerBrowser.evaluate<string>(
      "JSON.parse(localStorage.getItem('manifold.identity')).token",
    ),
  );
  await peerBrowser.goto(`${origin}/p/${opened.homeId}`);
  await until(
    () =>
      peerBrowser!.evaluate<boolean>(
        `document.querySelector('.xterm-rows')?.innerText.includes(${JSON.stringify(shellMarker)}) === true`,
      ),
    20_000,
    "second browser observes the same terminal output",
  );
  const peerFrame = await peerBrowser.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const peerData = peerFrame.result?.["data"];
  requireThat(typeof peerData === "string", "second Chromium did not return screenshot data");
  writeFileSync(join(evidence, "two-browser-terminal.png"), Buffer.from(peerData, "base64"));
  await peerBrowser.close();
  peerBrowser = null;
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
  observer.on("terminal_output", (message) => {
    if (message.terminalId !== opened.id || message.viewportId !== "sdk") return;
    observeMode(message.data);
    observer.ackTerminal(opened.id, "sdk", message.deliveryId, message.deliverySeq);
  });
  observer.on("terminal_snapshot", (message) => {
    if (message.terminalId !== opened.id || message.viewportId !== "sdk") return;
    observeMode(message.data);
    observer.ackTerminal(opened.id, "sdk", message.deliveryId, message.deliverySeq);
  });
  observer.on("terminal_geometry", (message) => {
    if (message.terminalId !== opened.id || message.viewportId !== "sdk") return;
    observer.ackTerminal(opened.id, "sdk", message.deliveryId, message.deliverySeq);
  });
  observer.attachTerminal(opened.id, "sdk");
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
  await browser.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(1000);
  await until(draftVisible, 10_000, "OMP draft preserved in compact terminal");
  await capture("omp-compact");
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

/*
  A STAGED CROSSING (#1068), rehearsed through the integrated fixture's real receiver grammar,
  Docker volume steps and retained data volume (`--crossing`). The incumbent is a hub of the
  earlier protocol: the same application, its bundle window the earlier stamp alone. It serves a
  closure built for that protocol: a hardened server plugin with stored data, and a machine-half
  plugin whose native deployment a proved owner admitted through the real review door. Fixture
  plugins and a fixture owner only: no workload runs, no artifact URL is fetched, and the only keys
  are this run's own.
*/
const CROSSING_COUNTER = "example.counter";
const CROSSING_NATIVE = "example.native";
const CROSSING_OPERATION = `${CROSSING_NATIVE}.serve`;
/** A plugin-storage key no transition may touch, beside the count the plugin itself keeps. */
const CROSSING_SENTINEL = "crossing-sentinel";
/** A capability the install door withholds by default: only an explicit grant confers it. */
const CROSSING_WITHHELD_CAP = "tokens:mint";
const BUNDLE_SUFFIX = ".manifold-plugin.json";
const CROSSING_JOURNAL = "/data/plugin-replacement/journal.json";
const CrossingRowSchema = z.looseObject({
  pluginId: z.string(),
  sha256: z.string(),
  grantedCaps: z.array(z.string()),
  installedBy: z.string(),
  installer: z.unknown().optional(),
  hardened: z.boolean(),
  bundlePath: z.string(),
  builtAgainst: z.record(z.string(), z.string()).optional(),
});
type CrossingRow = z.infer<typeof CrossingRowSchema>;
const CrossingInstallationSchema = z.strictObject({
  machineId: z.string(),
  pluginId: z.string(),
  revision: z.string(),
  artifact: z.string(),
});
type CrossingInstallation = z.infer<typeof CrossingInstallationSchema>;
const CrossingRecordSchema = z.looseObject({
  setSha256: z.string(),
  revision: z.string(),
  phase: z.string().optional(),
  members: z.array(
    z.looseObject({ sha256: z.string(), previous: z.unknown(), nativeReview: z.boolean() }),
  ),
  disabledInstallations: z.array(CrossingInstallationSchema),
});
const CrossingStateSchema = z.strictObject({
  rows: z.array(CrossingRowSchema),
  /** Each probed bundle path's sha256, or null where no file exists. */
  files: z.record(z.string(), z.string().nullable()),
  native: z
    .strictObject({
      revision: z.string(),
      artifact: z.string(),
      enabled: z.number(),
      ready: z.number(),
      purge_requested: z.number(),
    })
    .nullable(),
  consents: z.array(z.unknown()),
  journal: z.array(CrossingRecordSchema).nullable(),
  staged: z.boolean(),
  storage: z.record(
    z.string(),
    z.strictObject({ count: z.string().nullable(), sentinel: z.string().nullable() }),
  ),
});
type CrossingState = z.infer<typeof CrossingStateSchema>;
const CounterSchema = z.object({ count: z.number() });

/**
 * A machine half alone, whose one URL artifact no owner ever fetches. It declares one capability
 * the door withholds by default, so its installer's grant is an authority decision of its own.
 */
function nativeFixture(version: string, artifact: string): PluginManifest {
  return {
    id: CROSSING_NATIVE,
    version,
    title: "Crossing native fixture",
    description: "A machine half alone: a crossing that changes it stops its native installation.",
    capabilities: [CROSSING_WITHHELD_CAP],
    entry: {},
    contributes: {
      settings: [],
      panels: [],
      seats: [],
      sections: [],
      elements: [],
      tools: [],
      events: [],
    },
    machine: {
      artifacts: {
        "linux-x64": {
          url: "https://artifacts.invalid/example-native-worker",
          sha256: artifact,
          entrySha256: artifact,
          format: "raw",
          entry: ["worker"],
          maxBytes: 4096,
          maxExpandedBytes: 4096,
          maxMembers: 1,
        },
      },
      operations: {
        [CROSSING_OPERATION]: {
          argv: [],
          input: {},
          runtimeTools: [],
          locations: [],
          outputs: [],
          network: "none",
          providesService: true,
          stdin: false,
          limits: { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 },
        },
      },
      locations: {},
    },
  };
}
async function packFixture(dir: string, out: string): Promise<{ bytes: Buffer; sha256: string }> {
  const packed = await command(
    ["bun", join(repo, "packages/plugin-kit/src/pack.ts"), dir, "--out", out],
    { cwd: join(repo, "packages/plugin-kit"), timeoutMs: 120_000 },
  );
  const bytes = readFileSync(out);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  requireThat(
    z.object({ sha256: z.string() }).parse(JSON.parse(packed.out)).sha256 === sha256,
    "plugin pack reported a digest its bundle does not have",
  );
  return { bytes, sha256 };
}
/**
 * The same bundle stamped for `protocol` and serialized with `indent`: an earlier SDK's build
 * when the stamp is one this hub no longer admits, otherwise a distinct digest of identical
 * content, which is all a stacked crossing needs.
 */
function bundleVariant(bytes: Buffer, protocol: string, indent = 0): Buffer {
  const bundle = PluginBundleSchema.parse(JSON.parse(bytes.toString("utf8")));
  return Buffer.from(
    JSON.stringify(
      { ...bundle, builtAgainst: { ...bundle.builtAgainst, [BUILT_AGAINST_PROTOCOL]: protocol } },
      null,
      indent,
    ),
  );
}
/**
 * The disposable one-shot that gives each plugin's storage a sentinel beside the data the plugin
 * keeps itself, written over the stopped volume in the incumbent's image.
 */
function pluginDataSentinels(sentinels: Readonly<Record<string, string>>): string {
  return `import { openDatabase, ServerStore } from "./packages/server/src/index.ts";
const store = new ServerStore(openDatabase("/data/manifold.db"));
try {
  for (const [pluginId, sentinel] of Object.entries(${JSON.stringify(sentinels)}))
    await store.pluginStorage(pluginId).set(${JSON.stringify(CROSSING_SENTINEL)}, sentinel);
} finally {
  store.close();
}
`;
}
/**
 * A disposable, network-less fixture container of IMAGE over the retained volume. It is labelled
 * for this run's cleanup but never as the `manifold` service, a label a Compose-built image would
 * otherwise lend it: deploy-dev.sh requires exactly one such container, its incumbent.
 */
function fixtureVolumeRun(
  image: string,
  entrypoint: string,
  args: readonly string[],
  options: CommandOptions = {},
) {
  return docker(
    [
      "run",
      "--rm",
      ...(options.input === undefined ? [] : ["-i"]),
      "--network",
      "none",
      "--security-opt",
      "no-new-privileges",
      "--label",
      `com.docker.compose.project=${project()}`,
      "--label",
      "com.docker.compose.service=crossing-fixture",
      "--mount",
      `type=volume,src=${volume()},dst=/data`,
      "--entrypoint",
      entrypoint,
      image,
      ...args,
    ],
    { timeoutMs: 120_000, ...options },
  );
}
/** A Bun script in a fixture container of IMAGE, as deploy-dev.sh runs its own volume steps. */
async function volumeScript(image: string, source: string): Promise<string> {
  return (await fixtureVolumeRun(image, "bun", ["-"], { input: source })).out.trim();
}
/** The crossing as the retained volume holds it, read without writing. */
async function crossingState(
  paths: readonly string[],
  machineId: string,
  run: (source: string) => Promise<string> = (source) => execBun(source),
): Promise<CrossingState> {
  return CrossingStateSchema.parse(
    JSON.parse(
      await run(`import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { ServerStore } from "./packages/server/src/index.ts";
const ids = ${JSON.stringify([CROSSING_COUNTER, CROSSING_NATIVE])};
const paths = ${JSON.stringify(paths)};
const journal = ${JSON.stringify(CROSSING_JOURNAL)};
const store = new ServerStore(new Database("/data/manifold.db", { readonly: true }));
try {
  const storage = {};
  for (const id of ids)
    storage[id] = {
      count: (await store.pluginStorage(id).get("count")) ?? null,
      sentinel: (await store.pluginStorage(id).get(${JSON.stringify(CROSSING_SENTINEL)})) ?? null,
    };
  console.log(JSON.stringify({
    rows: store.pluginInstalls().filter((row) => ids.includes(row.pluginId)),
    files: Object.fromEntries(paths.map((path) => [path, existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null])),
    native: store.db
      .query("SELECT revision,artifact,enabled,ready,purge_requested FROM machine_job_installs WHERE machine_id=? AND plugin_id=?")
      .get(${JSON.stringify(machineId)}, ${JSON.stringify(CROSSING_NATIVE)}),
    consents: store.db
      .query("SELECT * FROM machine_job_consents WHERE machine_id=? AND plugin_id=? ORDER BY installation_revision,node,cap")
      .all(${JSON.stringify(machineId)}, ${JSON.stringify(CROSSING_NATIVE)}),
    journal: existsSync(journal) ? JSON.parse(readFileSync(journal, "utf8")) : null,
    staged: existsSync("/data/plugin-replacement/staged"),
    storage,
  }));
} finally {
  store.close();
}`),
    ),
  );
}
/**
 * CRASH-POINT INJECTION without a test hook. Once CONDITION holds over the retained volume, a FIFO
 * takes the journal's next-write path, so the real code path's next journal write blocks in
 * open(2) at exactly that point; `awaitBlockedWriter` proves it is there before a kill lands.
 */
async function plantJournalFifo(image: string, condition: string): Promise<void> {
  await fixtureVolumeRun(
    image,
    "/bin/sh",
    ["-c", `until ${condition}; do sleep 0.01; done; mkfifo ${CROSSING_JOURNAL}.next`],
    { timeoutMs: 20 * 60_000 },
  );
}
async function removeJournalFifo(image: string): Promise<void> {
  await fixtureVolumeRun(image, "/bin/rm", ["-f", `${CROSSING_JOURNAL}.next`]);
}
/** Waits until CONTAINER's process running PROGRAM blocks opening the planted FIFO. */
async function awaitBlockedWriter(container: string, program: string): Promise<void> {
  await until(
    async () =>
      (
        await docker(
          [
            "exec",
            container,
            "/bin/sh",
            "-c",
            `for p in /proc/[0-9]*; do if tr '\\0' ' ' <"$p/cmdline" 2>/dev/null | grep -q "$1" && [ "$(cat "$p/wchan" 2>/dev/null)" = wait_for_partner ]; then echo blocked; fi; done`,
            "blocked-writer",
            program,
          ],
          { allowFailure: true },
        )
      ).out.includes("blocked"),
    120_000,
    `${program} blocked at the planted journal write`,
  );
}
/** A staged set: its digest, its members, and the set file verify-live reads. */
interface StagedSet {
  readonly sha256: string;
  readonly set: PluginReplacementSet;
  readonly file: string;
}
/**
 * TEST-ONLY STAGER. `bundle-replacement.ts stage` fetches each member over HTTPS through the
 * artifact egress policy, which admits only ordinary public unicast destinations at every hop and
 * at the connected peer (packages/server/src/artifact-https.ts), so no loopback server can serve
 * it. This writes the layout `stage` produces from the packed bytes instead: the canonical set under
 * its digest beside each member's exact bytes. deploy-dev.sh verifies it with the installed
 * tooling's `verify`, and the candidate re-verifies it on receipt, exactly as on the host.
 */
function stageSet(
  members: readonly { pluginId: string; bytes: Buffer; nativeReview?: true }[],
): StagedSet {
  const set = PluginReplacementSetSchema.parse({
    format: 1,
    members: members.map(({ pluginId, bytes, nativeReview }) => ({
      pluginId,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      url: `https://plugins.invalid/${pluginId}${BUNDLE_SUFFIX}`,
      ...(nativeReview === undefined ? {} : { nativeReview }),
    })),
  });
  const text = canonicalJobJson(set);
  const sha256 = createHash("sha256").update(text).digest("hex");
  const staged = join(deployment, "bundle-replacements", sha256);
  if (!existsSync(staged)) {
    mkdirSync(staged, { recursive: true, mode: 0o700 });
    writeFileSync(join(staged, "set.json"), text, { mode: 0o600 });
    for (const [index, member] of set.members.entries())
      writeFileSync(join(staged, `${member.sha256}${BUNDLE_SUFFIX}`), members[index]!.bytes, {
        mode: 0o600,
      });
  }
  const file = join(directory, `replacement-set-${sha256}.json`);
  writeFileSync(file, text, { mode: 0o600 });
  return { sha256, set, file };
}
/**
 * A proved native owner on the real machine socket: it answers the owner challenge with its own
 * key, reports each enabled installation installed unless it withholds readiness, and keeps a
 * managed-store sentinel that only a purge command may delete, as a real owner's retained state.
 * It runs no workload.
 */
class NativeOwner {
  readonly commands: Extract<JobCommand, { type: "install" }>[] = [];
  proofs = 0;
  /** False while the owner withholds its installed reports, as an owner not yet ready does. */
  acknowledges = true;
  private socket: WebSocket | null = null;
  private stopped = false;
  private readonly key = generateKeyPairSync("ed25519");
  readonly owner: JobOwner;
  constructor(
    readonly machineId: string,
    private readonly token: string,
    private readonly name: string,
    readonly store: string,
  ) {
    this.owner = {
      protocolVersion: JOB_OWNER_PROTOCOL_VERSION,
      ownerId: `crossing-owner-${number}`,
      publicKey: this.key.publicKey.export({ type: "spki", format: "pem" }).toString(),
      generation: 1,
      platforms: ["linux-x64"],
      inventoryDigest: "0".repeat(64),
      resources: { tools: {}, services: {}, anchors: {}, serviceDefinitions: {} },
    };
  }
  connect(): void {
    if (this.stopped) return;
    const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/ws/machine`);
    this.socket = socket;
    socket.addEventListener("open", () =>
      socket.send(
        JSON.stringify({
          type: "hello",
          token: this.token,
          name: this.name,
          agentVersion: "crossing-fixture",
          protocolVersion: PROTOCOL_VERSION,
          terminals: [],
          jobOwner: this.owner,
        }),
      ),
    );
    socket.addEventListener("message", (event) => this.receive(socket, String(event.data)));
    // A hub replacement closes the socket; the owner redials the successor like a real agent.
    socket.addEventListener("close", () => {
      if (this.socket === socket && !this.stopped) setTimeout(() => this.connect(), 1_000);
    });
  }
  private receive(socket: WebSocket, data: string): void {
    const message = ServerToAgentMessageSchema.parse(JSON.parse(data));
    if (message.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
    if (message.type !== "job_command") return;
    const command = message.command;
    if (command.type === "owner_challenge") {
      const proof = {
        nonce: command.nonce,
        serverEpoch: command.serverEpoch,
        machineId: command.machineId,
        owner: this.owner,
      };
      socket.send(
        JSON.stringify({
          type: "job_event",
          event: {
            type: "owner_proof",
            ...proof,
            signature: sign(
              null,
              Buffer.from(canonicalJobJson(proof)),
              this.key.privateKey,
            ).toString("base64"),
          },
        }),
      );
    } else if (command.type === "drain") this.proofs += 1;
    else if (command.type === "install") {
      this.commands.push(command);
      if (command.action === "purge") rmSync(join(this.store, "broker.store"), { force: true });
      if (command.action === undefined && this.acknowledges)
        socket.send(
          JSON.stringify({
            type: "job_event",
            event: {
              type: "installed",
              pluginId: command.pluginId,
              installationRevision: command.installationRevision,
              artifactSha256: command.artifactSha256,
            },
          }),
        );
    }
  }
  async proved(count: number): Promise<void> {
    await until(() => this.proofs >= count, 60_000, `native owner proof ${count}`);
  }
  close(): void {
    this.stopped = true;
    this.socket?.close();
  }
}
let nativeOwner: NativeOwner | null = null;
/** `scripts/verify-live.ts` exactly as the deployment workflow runs it, against this run's hub. */
async function verifyLive(
  args: readonly string[],
  replacementSet?: string,
): Promise<{ code: number; out: string; maintenance: string | null }> {
  const output = join(directory, `verify-live-${crypto.randomUUID()}.out`);
  writeFileSync(output, "", { mode: 0o600 });
  const result = await command(["bun", join(repo, "scripts/verify-live.ts"), ...args], {
    cwd: repo,
    env: {
      ...env,
      VERIFY_LIVE_ORIGIN: origin,
      VERIFY_LIVE_TOKEN: ownerKey,
      GITHUB_OUTPUT: output,
      ...(replacementSet === undefined ? {} : { VERIFY_LIVE_REPLACEMENT_SET: replacementSet }),
    },
    timeoutMs: 6 * 60_000,
    allowFailure: true,
  });
  return {
    code: result.code,
    out: `${result.out}${result.err}`,
    maintenance: /^maintenance_required=(\w+)$/m.exec(readFileSync(output, "utf8"))?.[1] ?? null,
  };
}
/** The manual rollback's installed-bundles gate: the restore plan the switch must name. */
async function rollbackGate(image: string, target: string): Promise<{ plan: string; out: string }> {
  const output = join(directory, `installed-bundles-${crypto.randomUUID()}.out`);
  writeFileSync(output, "", { mode: 0o600 });
  const result = await command(["bun", join(repo, "scripts/installed-bundles.ts"), image], {
    cwd: repo,
    env: {
      ...env,
      INSTALLED_BUNDLES_ORIGIN: origin,
      INSTALLED_BUNDLES_TOKEN: ownerKey,
      INSTALLED_BUNDLES_ROLLBACK_REPOSITORY: fixtureRepo,
      INSTALLED_BUNDLES_REVISION: target,
      GITHUB_OUTPUT: output,
    },
    timeoutMs: 6 * 60_000,
  });
  const plan = /^restore_plan=([0-9a-f]{64}|none)$/m.exec(readFileSync(output, "utf8"))?.[1];
  requireThat(plan !== undefined, "the rollback gate named no restore plan");
  return { plan, out: `${result.out}${result.err}` };
}
async function pluginRoster() {
  const response = await fetch(`${origin}/api/plugins`, {
    headers: { authorization: `Bearer ${ownerKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  requireThat(response.ok, `plugin roster: HTTP ${response.status}`);
  return PluginsResponseSchema.parse(await response.json()).plugins;
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
  nativeOwner?.close();
  nativeOwner = null;
  await browser?.close();
  browser = null;
  await peerBrowser?.close();
  peerBrowser = null;
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
    const tags = integrated
      ? [finalImage(), `${project()}:candidate`]
      : [baseImage(), finalImage(), `manifold-pr-${number}:local`];
    for (const tag of tags) {
      const found = await docker(["image", "ls", "--quiet", "--filter", `reference=${tag}`], {
        allowFailure: true,
      });
      if (found.code !== 0) failures.push(`could not inspect owned image tag ${tag}`);
      else if (
        found.out.trim() !== "" &&
        (await docker(["image", "rm", tag], { allowFailure: true })).code !== 0
      ) {
        failures.push(`could not remove owned image tag ${tag}`);
      }
    }
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
  if (crossing) {
    const fixtures = join(directory, "crossing-fixtures");
    const nativeSource = join(fixtures, "native");
    /** The replacement set's native build, its declaration changed. */
    const nativeNextFile = join(fixtures, `native-2.0.0${BUNDLE_SUFFIX}`);
    const ownerStore = join(directory, "native-owner-store");
    const brokerStore = join(ownerStore, "broker.store");
    mkdirSync(nativeSource, { recursive: true, mode: 0o700 });
    mkdirSync(ownerStore, { recursive: true, mode: 0o700 });
    // The newest earlier wire revision whose bundles this hub no longer admits.
    let earlierStamp = PROTOCOL_VERSION - 1;
    while (PLUGIN_BUNDLE_PROTOCOL_COMPAT_VERSIONS.has(String(earlierStamp))) earlierStamp -= 1;
    const receipts: Record<string, unknown> = { earlierStamp: String(earlierStamp) };
    metrics["crossing"] = receipts;
    // The earlier hub: this application with its bundle window narrowed to the earlier stamp, as
    // the deployed hub of the earlier protocol admits its own closure and no later build. Every
    // later revision is this application unchanged.
    const application = revision;
    const windowFile = join(fixtureRepo, "packages/protocol/src/version.ts");
    const bundleWindow =
      /(PLUGIN_BUNDLE_PROTOCOL_COMPAT_VERSIONS: ReadonlySet<string> = new Set\()\[[^\]]*\]\)/;
    const windowSource = readFileSync(windowFile, "utf8");
    requireThat(
      bundleWindow.test(windowSource),
      "the fixture cannot find the bundle protocol window it narrows for the earlier hub",
    );
    writeFileSync(
      windowFile,
      windowSource.replace(bundleWindow, `$1[${JSON.stringify(String(earlierStamp))}])`),
    );
    await command(["git", "add", "packages/protocol/src/version.ts"], { cwd: fixtureRepo });
    const r0 = await fixtureRevision(`earlier-hub-${crypto.randomUUID()}`);
    const earlierIdentity = deriveBuildIdentity(fixtureRepo, r0);
    baseIdentity["MANIFOLD_VERSION"] = earlierIdentity.version;
    baseIdentity["MANIFOLD_BUILD"] = earlierIdentity.build;
    revision = r0;
    expectedBuild = earlierIdentity.build;
    const r2 = await fixtureChild(r0, `crossing-${crypto.randomUUID()}`, application);
    const r3 = await fixtureChild(r2, `stacked-${crypto.randomUUID()}`);
    const images = new Map<string, string>();
    const deployTo = (target: string): void => {
      revision = target;
      expectedBuild = deriveBuildIdentity(fixtureRepo, target).build;
    };
    const served = async (): Promise<void> => {
      images.set(revision, (await inspectContainer()).Image);
    };
    const owner = (): NativeOwner => {
      requireThat(nativeOwner !== null, "the native owner fixture is not connected");
      return nativeOwner;
    };
    const describeNative = async () =>
      JobDescriptionSchema.parse(
        await act("engine.jobs.describe", {
          machineId: owner().machineId,
          pluginId: CROSSING_NATIVE,
        }),
      ).installation;
    const sentinels: Record<string, string> = {
      [CROSSING_COUNTER]: randomBytes(16).toString("hex"),
      [CROSSING_NATIVE]: randomBytes(16).toString("hex"),
    };
    const ownerSentinel = randomBytes(64);
    const snapshot = join(directory, "verify-live-before.json");
    let counter: { bytes: Buffer; sha256: string } = { bytes: Buffer.alloc(0), sha256: "" };
    let primary: StagedSet | undefined;
    /** The plan the stacked crossings' restore was proved under: stale once that restore ran. */
    let stackedPlan = "";
    let seeded: CrossingRow[] = [];
    let crossedRows: CrossingRow[] = [];
    let consents: unknown[] = [];
    let approved: CrossingInstallation = {
      machineId: "",
      pluginId: "",
      revision: "",
      artifact: "",
    };
    const bundleFile = (pluginId: string, sha256: string): string =>
      `/data/plugins/${pluginId}/${sha256}${BUNDLE_SUFFIX}`;
    const primaryMember = (pluginId: string) => {
      const member = primary?.set.members.find((candidate) => candidate.pluginId === pluginId);
      requireThat(member !== undefined, `${pluginId} is not a member of the primary set`);
      return member;
    };
    const state = (paths: readonly string[] = []) =>
      crossingState(
        [
          ...seeded.map((row) => row.bundlePath),
          ...crossedRows.map((row) => row.bundlePath),
          ...paths,
        ],
        owner().machineId,
      );
    /** Plugin data, the owner-managed store and its install history admit no purge, ever. */
    const dataRetained = (current: CrossingState, label: string): void => {
      for (const pluginId of [CROSSING_COUNTER, CROSSING_NATIVE])
        requireThat(
          current.storage[pluginId]?.sentinel === sentinels[pluginId],
          `${label}: ${pluginId} plugin data changed`,
        );
      requireThat(current.native?.purge_requested === 0, `${label}: native purge requested`);
      requireThat(
        !owner().commands.some((command) => command.action === "purge") &&
          existsSync(brokerStore) &&
          readFileSync(brokerStore).equals(ownerSentinel),
        `${label}: the owner-managed store was purged or changed`,
      );
    };
    const nativeAt = (
      current: CrossingState,
      expected: { enabled: number; ready?: number },
      label: string,
    ): void =>
      requireThat(
        current.native?.revision === approved.revision &&
          current.native.artifact === approved.artifact &&
          current.native.enabled === expected.enabled &&
          (expected.ready === undefined || current.native.ready === expected.ready) &&
          isDeepStrictEqual(current.consents, consents),
        `${label}: native installation ${JSON.stringify(current.native)} is not the approved revision with enabled=${expected.enabled}${expected.ready === undefined ? "" : ` ready=${expected.ready}`} and its consents`,
      );
    const containerLogs = async (): Promise<string> =>
      (await docker(["logs", await containerId()], { confidential: true })).out;

    await step(
      "crossing: the earlier hub serves its protocol closure beside its reviewed native deployment",
      async () => {
        appUid = 0;
        await compose(finalImage(), ["up", "-d", "--build", "--no-deps", "manifold"], {
          timeoutMs: 18 * 60_000,
        });
        active = true;
        await rememberImages();
        await ready();
        await acquireIdentity();
        await served();
        const enrolled = MachineEnrollResponseSchema.parse(
          await act("core.machines.enroll", { name: `crossing-owner-${number}` }),
        );
        requireThat(enrolled.machineToken !== undefined, "owner fixture minted no machine token");
        secrets.add(enrolled.machineToken);
        writeFileSync(brokerStore, ownerSentinel, { mode: 0o600 });
        nativeOwner = new NativeOwner(
          enrolled.machine.id,
          enrolled.machineToken,
          enrolled.machine.name,
          ownerStore,
        );
        // Every later deployment names this enrolled machine as its explicit native owner.
        env["MANIFOLD_DEV_SERVICE_OWNER_MACHINE_ID"] = enrolled.machine.id;
        owner().connect();
        await owner().proved(1);
        const counterFile = join(fixtures, `counter${BUNDLE_SUFFIX}`);
        counter = await packFixture(
          join(repo, "packages/plugin-kit/test/fixtures/sample"),
          counterFile,
        );
        writeFileSync(
          join(nativeSource, "manifest.json"),
          JSON.stringify(nativeFixture("1.0.0", "a".repeat(64))),
        );
        const native = await packFixture(
          nativeSource,
          join(fixtures, `native-1.0.0${BUNDLE_SUFFIX}`),
        );
        const uploads = "/data/plugin-uploads";
        await execBun(
          `import { mkdirSync } from "node:fs"; mkdirSync(${JSON.stringify(uploads)}, { recursive: true, mode: 0o700 });`,
        );
        // The real install door writes each row of the earlier SDK's builds: grants, installer
        // lineage and hardening. The native fixture's installer grants its withheld capability.
        for (const [build, grant] of [
          [counter, undefined],
          [native, [CROSSING_WITHHELD_CAP]],
        ] as const) {
          const bytes = bundleVariant(build.bytes, String(earlierStamp));
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          const file = join(fixtures, `${sha256}${BUNDLE_SUFFIX}`);
          writeFileSync(file, bytes, { mode: 0o600 });
          const upload = `${uploads}/${sha256}${BUNDLE_SUFFIX}`;
          await docker(["cp", file, `${await containerId()}:${upload}`]);
          await act("engine.plugins.install", {
            source: upload,
            sha256,
            hardened: true,
            ...(grant === undefined ? {} : { grant }),
          });
        }
        // The real review door admits the native deployment on the proved owner.
        const request = {
          deploymentId: `crossing-${number}`,
          pluginId: CROSSING_NATIVE,
          targets: [{ machineId: owner().machineId }],
          operationIds: [CROSSING_OPERATION],
        };
        const review = JobDeploymentReviewSchema.parse(
          await act("engine.jobs.reviewDeployment", request),
        );
        await act("engine.jobs.applyDeployment", { request, reviewDigest: review.reviewDigest });
        await until(
          async () => (await describeNative())?.ready === true,
          30_000,
          "the reviewed native deployment ready on its owner",
        );
        const installed = await describeNative();
        requireThat(installed !== null, "the reviewed native installation is missing");
        approved = {
          machineId: owner().machineId,
          pluginId: CROSSING_NATIVE,
          revision: installed.revision,
          artifact: installed.artifactSha256,
        };
        requireThat(
          CounterSchema.parse(await act(`${CROSSING_COUNTER}.bump`, { by: 41 })).count === 41,
          "the counter fixture did not answer on the incumbent",
        );
        // Plugin-storage sentinels go in over the stopped volume, in the incumbent's image. The
        // owner then withholds readiness: an enabled provider not ready before the switch.
        const incumbent = await inspectContainer();
        await docker(["stop", "--time", "120", incumbent.Id], { timeoutMs: 180_000 });
        await volumeScript(incumbent.Image, pluginDataSentinels(sentinels));
        owner().acknowledges = false;
        await docker(["start", incumbent.Id]);
        await ready();
        await owner().proved(2);
        seeded = (await state()).rows;
        const roster = await pluginRoster();
        for (const pluginId of [CROSSING_COUNTER, CROSSING_NATIVE]) {
          const row = seeded.find((candidate) => candidate.pluginId === pluginId);
          const entry = roster.find((candidate) => candidate.manifest.id === pluginId);
          requireThat(
            row?.builtAgainst?.[BUILT_AGAINST_PROTOCOL] === String(earlierStamp) &&
              entry?.held === undefined &&
              entry?.install?.sha256 === row.sha256,
            `${pluginId}: the earlier hub does not serve its protocol ${earlierStamp} build`,
          );
        }
        const closure = await state();
        consents = closure.consents;
        requireThat(consents.length > 0, "the native review recorded no consents");
        nativeAt(closure, { enabled: 1, ready: 0 }, "earlier closure");
        requireThat(
          seeded.every((row) => closure.files[row.bundlePath] === row.sha256) &&
            seeded
              .find((row) => row.pluginId === CROSSING_NATIVE)
              ?.grantedCaps.includes(CROSSING_WITHHELD_CAP) === true &&
            closure.storage[CROSSING_COUNTER]?.count === "41" &&
            closure.journal === null,
          "the earlier closure lost its bundles, grant or plugin data, or already holds a crossing",
        );
        dataRetained(closure, "earlier closure");
        const before = await verifyLive(["snapshot", snapshot]);
        requireThat(before.code === 0, `verify-live snapshot failed:\n${redact(before.out)}`);
        receipts["closure"] = {
          revision: r0,
          rows: seeded.map(({ pluginId, sha256, grantedCaps }) => ({
            pluginId,
            sha256,
            grantedCaps,
          })),
          native: approved,
          consents: consents.length,
          snapshot: redact(before.out.trim()),
        };
      },
    );
    await step(
      "crossing: a set leaving a held bundle unreplaced is refused without mutation, then the automatic rollback restores the incumbent",
      async () => {
        const refused = stageSet([{ pluginId: CROSSING_COUNTER, bytes: counter.bytes }]);
        deployTo(r2);
        const forward = await up({}, undefined, refused.sha256);
        const received = `received set ${refused.sha256} for ${r2}`;
        requireThat(
          forward.out.includes(received),
          "the receiver did not hand over the refused set",
        );
        await ready();
        await served();
        const refusal = (await containerLogs())
          .split("\n")
          .find((line) => line.includes('"evt":"plugin_replacement_refused"'));
        requireThat(
          refusal?.includes(CROSSING_NATIVE) && refusal.includes("no replacement staged"),
          "the candidate did not refuse a set that leaves a held bundle unreplaced",
        );
        const held = await state();
        requireThat(
          isDeepStrictEqual(held.rows, seeded) && held.journal === null,
          "a refused crossing changed an installed row or journaled itself",
        );
        nativeAt(held, { enabled: 1 }, "refused crossing");
        dataRetained(held, "refused crossing");
        // The workflow's automatic recovery: the three-argument rollback no gate precedes.
        deployTo(r0);
        await up({}, r2);
        await ready();
        const restored = await state();
        requireThat(
          isDeepStrictEqual(restored.rows, seeded) && restored.journal === null && !restored.staged,
          "the automatic rollback did not leave the earlier closure intact and unstaged",
        );
        nativeAt(restored, { enabled: 1 }, "automatic rollback");
        dataRetained(restored, "automatic rollback");
        receipts["refused"] = {
          set: refused.sha256,
          receipt: received,
          refusal: redact(refusal ?? ""),
          rollback: `dev-rollback ${r2} ${r0}`,
        };
      },
    );
    await step(
      "crossing: killed between its bundle commit and native completion, the crossing resumes on restart",
      async () => {
        writeFileSync(
          join(nativeSource, "manifest.json"),
          JSON.stringify(nativeFixture("2.0.0", "b".repeat(64))),
        );
        const next = await packFixture(nativeSource, nativeNextFile);
        primary = stageSet([
          { pluginId: CROSSING_COUNTER, bytes: counter.bytes },
          { pluginId: CROSSING_NATIVE, bytes: next.bytes, nativeReview: true },
        ]);
        const set = primary;
        const helper = images.get(r0)!;
        deployTo(r2);
        const deploying = up({}, undefined, set.sha256);
        // The candidate's prepared record is its first durable journal write; the next one
        // follows the bundle commit.
        await Promise.race([
          plantJournalFifo(
            helper,
            `[ -f ${CROSSING_JOURNAL} ] && [ ! -e ${CROSSING_JOURNAL}.next ]`,
          ),
          deploying.then(() => {
            throw new Error("the crossing completed before its interruption point");
          }),
        ]);
        const candidate = await containerId();
        await awaitBlockedWriter(candidate, "packages/server/src/main.ts");
        const midway = await state();
        requireThat(
          set.set.members.every(
            (member) =>
              midway.rows.find((row) => row.pluginId === member.pluginId)?.sha256 === member.sha256,
          ) &&
            midway.journal?.length === 1 &&
            midway.journal[0]?.phase === "prepared" &&
            midway.staged,
          `the interruption did not land between the bundle commit and native completion: ${JSON.stringify(midway.journal)}`,
        );
        nativeAt(midway, { enabled: 1 }, "interrupted crossing");
        const killedAt = (await inspectContainer()).State.StartedAt;
        await removeJournalFifo(helper);
        await docker(["kill", candidate]);
        await until(
          async () => (await inspectContainer()).State.Status !== "running",
          30_000,
          "the killed candidate stopped",
        );
        await docker(["start", candidate]);
        const forward = await deploying;
        const received = `received set ${set.sha256} for ${r2}`;
        requireThat(
          forward.out.includes(received),
          "the receiver did not hand over the staged set",
        );
        await ready();
        await served();
        requireThat(
          (await inspectContainer()).State.StartedAt !== killedAt,
          "the candidate was not restarted after its kill",
        );
        const applied = (await containerLogs())
          .split("\n")
          .find((line) => line.includes('"evt":"plugin_replacement_applied"'));
        requireThat(applied !== undefined, "the resumed candidate did not report the crossing");
        const roster = await pluginRoster();
        const holds = roster.filter((entry) => entry.held !== undefined);
        requireThat(
          holds.length === 0,
          `the crossed hub holds ${holds.map((entry) => entry.manifest.id).join(", ")}`,
        );
        for (const member of set.set.members)
          requireThat(
            roster.find((entry) => entry.manifest.id === member.pluginId)?.install?.sha256 ===
              member.sha256,
            `${member.pluginId}: the installed digest is not the staged member's`,
          );
        const crossed = await state();
        for (const row of seeded) {
          const now = crossed.rows.find((candidate) => candidate.pluginId === row.pluginId);
          requireThat(
            now?.sha256 === primaryMember(row.pluginId).sha256 &&
              now.builtAgainst?.[BUILT_AGAINST_PROTOCOL] === String(PROTOCOL_VERSION),
            `${row.pluginId}: the row does not name the staged build`,
          );
          requireThat(
            isDeepStrictEqual(
              [now.grantedCaps, now.installedBy, now.installer, now.hardened],
              [row.grantedCaps, row.installedBy, row.installer, row.hardened],
            ),
            `${row.pluginId}: grants, installer lineage or hardening changed`,
          );
          requireThat(
            crossed.files[row.bundlePath] === row.sha256,
            `${row.pluginId}: the earlier build's bytes were not retained for rollback`,
          );
        }
        nativeAt(crossed, { enabled: 0 }, "crossing");
        const record = crossed.journal?.length === 1 ? crossed.journal[0] : undefined;
        requireThat(
          record?.setSha256 === set.sha256 &&
            record.revision === r2 &&
            record.phase === "completed" &&
            isDeepStrictEqual(
              record.members.map(({ sha256, previous, nativeReview }) => ({
                sha256,
                previous,
                nativeReview,
              })),
              set.set.members.map((member) => ({
                sha256: member.sha256,
                previous: seeded.find((row) => row.pluginId === member.pluginId),
                nativeReview: member.nativeReview === true,
              })),
            ) &&
            isDeepStrictEqual(record.disabledInstallations, [approved]),
          `the journal does not record exactly this completed crossing: ${JSON.stringify(crossed.journal)}`,
        );
        requireThat(!crossed.staged, "the candidate left the staged set behind");
        dataRetained(crossed, "crossing");
        await owner().proved(4);
        requireThat(
          owner().commands.some(
            (command) =>
              command.pluginId === CROSSING_NATIVE &&
              command.installationRevision === approved.revision &&
              command.action === "disable",
          ),
          "the owner was never told to stop the approved native revision",
        );
        requireThat(
          CounterSchema.parse(await act(`${CROSSING_COUNTER}.bump`, { by: 1 })).count === 42,
          "the crossed counter lost its stored count",
        );
        crossedRows = crossed.rows;
        // The enabled provider was not ready in the pre-switch snapshot, its owner withholding
        // readiness: the owner pin must still wait for its native review.
        const verified = await verifyLive(["verify", snapshot, expectedBuild], set.file);
        requireThat(
          verified.code === 0 &&
            verified.maintenance === "true" &&
            verified.out.includes(`installation ${approved.machineId}/${CROSSING_NATIVE}`),
          `verify-live released the owner pin while the crossed provider awaits its native review:\n${redact(verified.out)}`,
        );
        owner().acknowledges = true;
        receipts["forward"] = {
          revision: r2,
          set: set.sha256,
          members: set.set.members,
          receipt: received,
          interrupted: {
            journal: midway.journal,
            rows: midway.rows.map(({ pluginId, sha256 }) => ({ pluginId, sha256 })),
          },
          applied: redact(applied),
          native: crossed.native,
          verifyLive: redact(verified.out.trim()),
        };
      },
    );
    await step("crossing: two further crossings stack in the journal", async () => {
      const third = stageSet([
        {
          pluginId: CROSSING_COUNTER,
          bytes: bundleVariant(counter.bytes, String(PROTOCOL_VERSION), 1),
        },
      ]);
      deployTo(r3);
      await up({}, undefined, third.sha256);
      await ready();
      await served();
      const fourth = stageSet([
        {
          pluginId: CROSSING_COUNTER,
          bytes: bundleVariant(counter.bytes, String(PROTOCOL_VERSION), 2),
        },
      ]);
      await up({}, undefined, fourth.sha256);
      await ready();
      const stacked = await state();
      requireThat(
        stacked.rows.find((row) => row.pluginId === CROSSING_COUNTER)?.sha256 ===
          fourth.set.members[0]!.sha256 &&
          isDeepStrictEqual(
            stacked.journal?.map(({ setSha256, revision, phase }) => [setSha256, revision, phase]),
            [
              [primary!.sha256, r2, "completed"],
              [third.sha256, r3, "completed"],
              [fourth.sha256, r3, "completed"],
            ],
          ),
        `the stacked crossings are not journaled oldest first: ${JSON.stringify(stacked.journal)}`,
      );
      nativeAt(stacked, { enabled: 0 }, "stacked crossings");
      dataRetained(stacked, "stacked crossings");
      receipts["stacked"] = {
        revisions: [r3, r3],
        sets: [third.sha256, fourth.sha256],
        counter: [third.set.members[0]!.sha256, fourth.set.members[0]!.sha256],
      };
    });
    await step(
      "crossing: a manual rollback killed between its restore commit and journal completion converges on retry",
      async () => {
        const stackedFiles = (await state())
          .journal!.slice(1)
          .map((record) => bundleFile(CROSSING_COUNTER, record.members[0]!.sha256));
        const gate = await rollbackGate(images.get(r2)!, r2);
        requireThat(gate.plan !== "none", "the rollback gate projected no restore");
        stackedPlan = gate.plan;
        const incumbent = await inspectContainer();
        // A steady hub writes no journal: the next journal write is the restore's truncation,
        // after its one SQLite transaction committed.
        await plantJournalFifo(incumbent.Image, "true");
        deployTo(r2);
        const rolling = up({ allowFailure: true }, r3, gate.plan);
        let oneShot = "";
        await until(
          async () => {
            oneShot =
              (
                await docker([
                  "ps",
                  "--no-trunc",
                  "--filter",
                  `label=com.docker.compose.project=${project()}`,
                  "--format",
                  "{{.ID}} {{.Command}}",
                ])
              ).out
                .split("\n")
                .find((line) => line.includes("bundle-replacement.ts restore"))
                ?.split(" ")[0] ?? "";
            return oneShot !== "";
          },
          15 * 60_000,
          "the restore one-shot started",
        );
        await awaitBlockedWriter(oneShot, "bundle-replacement.ts");
        const midway = await crossingState([...stackedFiles], owner().machineId, (source) =>
          volumeScript(incumbent.Image, source),
        );
        requireThat(
          isDeepStrictEqual(midway.rows, crossedRows) && midway.journal?.length === 3,
          `the interruption did not land between the restore commit and journal completion: ${JSON.stringify(midway.journal?.map((record) => record.revision))}`,
        );
        await removeJournalFifo(incumbent.Image);
        await docker(["kill", oneShot], { allowFailure: true });
        const interrupted = await rolling;
        requireThat(
          interrupted.code !== 0 &&
            `${interrupted.out}${interrupted.err}`.includes("plugin transition refused"),
          "a killed restore did not hold the rollback",
        );
        // deploy-dev.sh restarted its incumbent over the committed restore.
        deployTo(r3);
        await ready();
        const retry = await rollbackGate(images.get(r2)!, r2);
        deployTo(r2);
        const rolledBack = await up({}, r3, retry.plan);
        await ready();
        await served();
        const converged = await state(stackedFiles);
        requireThat(
          isDeepStrictEqual(converged.rows, crossedRows) &&
            isDeepStrictEqual(
              converged.journal?.map(({ setSha256, revision }) => [setSha256, revision]),
              [[primary!.sha256, r2]],
            ) &&
            stackedFiles.every((path) => converged.files[path] === null) &&
            crossedRows.every((row) => converged.files[row.bundlePath] === row.sha256) &&
            !converged.staged,
          `the retried rollback did not converge on the first crossing: ${JSON.stringify(converged.journal)}`,
        );
        nativeAt(converged, { enabled: 0 }, "converged rollback");
        dataRetained(converged, "converged rollback");
        receipts["interruptedRestore"] = {
          gate: redact(gate.out.trim()),
          plan: gate.plan,
          interrupted: redact(
            `${interrupted.out}${interrupted.err}`.trim().split("\n").slice(-3).join("\n"),
          ),
          retryPlan: retry.plan,
          restored: redact(
            rolledBack.out
              .split("\n")
              .filter((line) => line.includes("restored"))
              .join("\n"),
          ),
        };
      },
    );
    await step(
      "crossing: a manual rollback restores the earlier closure with the outgoing image",
      async () => {
        // A plan proved for another restore binds nothing here: the host refuses it before any
        // row moves, and deploy-dev.sh restarts the incumbent unchanged.
        const serving = (await inspectContainer()).Image;
        const unrestored = await state();
        deployTo(r0);
        const stale = await up({ allowFailure: true, timeoutMs: 6 * 60_000 }, r2, stackedPlan);
        const staleText = `${stale.out}${stale.err}`;
        requireThat(
          stale.code !== 0 &&
            staleText.includes(
              `restore plan ${stackedPlan} is not the journaled crossings ${r2}; restore refused`,
            ),
          `a rollback naming a stale restore plan did not refuse:\n${redact(staleText.slice(-2_000))}`,
        );
        deployTo(r2);
        await ready();
        const kept = await state();
        requireThat(
          (await inspectContainer()).Image === serving &&
            isDeepStrictEqual(kept.rows, unrestored.rows) &&
            isDeepStrictEqual(kept.journal, unrestored.journal) &&
            isDeepStrictEqual(kept.files, unrestored.files),
          "a refused stale plan changed the incumbent, its rows, journal or files",
        );
        nativeAt(kept, { enabled: 0 }, "stale restore plan");
        dataRetained(kept, "stale restore plan");
        const gate = await rollbackGate(images.get(r0)!, r0);
        requireThat(gate.plan !== stackedPlan, "the rollback gate re-proved the stale plan");
        deployTo(r0);
        const rolledBack = await up({}, r2, gate.plan);
        await ready();
        const restored = await state();
        requireThat(
          isDeepStrictEqual(restored.rows, seeded) &&
            seeded.every((row) => restored.files[row.bundlePath] === row.sha256) &&
            crossedRows.every((row) => restored.files[row.bundlePath] === null) &&
            restored.journal === null &&
            !restored.staged &&
            restored.storage[CROSSING_COUNTER]?.count === "42",
          "the manual rollback did not restore the earlier rows, files and plugin data",
        );
        nativeAt(restored, { enabled: 1 }, "manual rollback");
        dataRetained(restored, "manual rollback");
        // The earlier hub serves the restored closure with its data, and the approval the
        // crossing disabled is live again on its owner.
        const roster = await pluginRoster();
        for (const row of seeded) {
          const entry = roster.find((candidate) => candidate.manifest.id === row.pluginId);
          requireThat(
            entry?.held === undefined && entry?.install?.sha256 === row.sha256,
            `${row.pluginId}: the earlier hub does not serve the restored digest`,
          );
        }
        requireThat(
          CounterSchema.parse(await act(`${CROSSING_COUNTER}.bump`, { by: 1 })).count === 43,
          "the restored counter lost its stored count",
        );
        await until(
          async () => {
            const installation = await describeNative();
            return (
              installation?.revision === approved.revision &&
              installation.enabled &&
              installation.ready
            );
          },
          30_000,
          "the restored native approval ready on its owner again",
        );
        receipts["rollback"] = {
          staleRefusal: redact(
            staleText
              .split("\n")
              .filter((line) => line.includes("restore refused"))
              .join("\n"),
          ),
          gate: redact(gate.out.trim()),
          plan: gate.plan,
          restored: redact(
            rolledBack.out
              .split("\n")
              .filter((line) => line.includes("restored"))
              .join("\n"),
          ),
          native: restored.native,
        };
      },
    );
    await step(
      "crossing: a same-digest reinstall after a crossing makes its rollback refuse",
      async () => {
        const set = primary!;
        deployTo(r2);
        await up({}, undefined, set.sha256);
        await ready();
        await served();
        const crossed = await state();
        requireThat(
          crossed.journal?.length === 1 && crossed.journal[0]?.phase === "completed",
          "the repeated crossing did not complete",
        );
        nativeAt(crossed, { enabled: 0 }, "repeated crossing");
        // An authority decision after the crossing: the same digest, reinstalled through the real
        // door with replacement consent and the default grant, which withdraws the withheld
        // capability the crossing kept. Restoring the earlier row would grant it again.
        const nativeMember = primaryMember(CROSSING_NATIVE);
        const upload = `/data/plugin-uploads/${nativeMember.sha256}${BUNDLE_SUFFIX}`;
        await docker(["cp", nativeNextFile, `${await containerId()}:${upload}`]);
        const kept = crossed.rows.find((row) => row.pluginId === CROSSING_NATIVE);
        requireThat(
          kept?.grantedCaps.includes(CROSSING_WITHHELD_CAP) === true,
          "the crossing did not keep the native fixture's granted capability",
        );
        await act("engine.plugins.install", {
          source: upload,
          sha256: nativeMember.sha256,
          hardened: true,
          replace: true,
        });
        const decided = await state();
        const nativeRow = decided.rows.find((row) => row.pluginId === CROSSING_NATIVE);
        requireThat(
          nativeRow?.sha256 === nativeMember.sha256 &&
            !nativeRow.grantedCaps.includes(CROSSING_WITHHELD_CAP),
          "the same-digest reinstall did not withdraw the granted capability",
        );
        const serving = (await inspectContainer()).Image;
        // The gate proves only the closure a restore yields; the host's exact-row check refuses
        // both the gated manual rollback and the automatic recovery no gate precedes.
        const gate = await rollbackGate(images.get(r0)!, r0);
        requireThat(gate.plan !== "none", "the rollback gate projected no restore");
        const refusals: Record<string, string> = {};
        for (const [label, plan] of [
          [`dev-rollback ${r2} ${r0} ${gate.plan}`, gate.plan],
          [`dev-rollback ${r2} ${r0}`, undefined],
        ] as const) {
          deployTo(r0);
          const refused = await up({ allowFailure: true, timeoutMs: 6 * 60_000 }, r2, plan);
          const text = `${refused.out}${refused.err}`;
          requireThat(
            refused.code !== 0 &&
              text.includes(
                `${CROSSING_NATIVE}: the installed row changed since crossing ${r2}; restore refused`,
              ),
            `${label} over a later authority decision did not refuse:\n${redact(text.slice(-2_000))}`,
          );
          deployTo(r2);
          await ready();
          const after = await state();
          requireThat(
            (await inspectContainer()).Image === serving &&
              isDeepStrictEqual(after.rows, decided.rows) &&
              isDeepStrictEqual(after.journal, decided.journal) &&
              isDeepStrictEqual(after.files, decided.files),
            `${label}: a refused restore changed the incumbent, its rows, journal or files`,
          );
          nativeAt(after, { enabled: 0 }, `${label} refused`);
          dataRetained(after, `${label} refused`);
          refusals[label] = redact(
            text
              .split("\n")
              .filter((line) => line.includes("restore refused") || line.includes("HOLD"))
              .join("\n"),
          );
        }
        receipts["authorityChange"] = {
          revision: r2,
          grant: { crossed: kept.grantedCaps, decided: nativeRow.grantedCaps },
          plan: gate.plan,
          refusals,
        };
      },
    );
    await step(
      "crossing: replaying the applied set after the native review changes nothing",
      async () => {
        const request = {
          deploymentId: `crossing-review-${number}`,
          pluginId: CROSSING_NATIVE,
          targets: [{ machineId: owner().machineId }],
          operationIds: [CROSSING_OPERATION],
        };
        const review = JobDeploymentReviewSchema.parse(
          await act("engine.jobs.reviewDeployment", request),
        );
        await act("engine.jobs.applyDeployment", { request, reviewDigest: review.reviewDigest });
        await until(
          async () => {
            const installation = await describeNative();
            return (
              installation?.revision !== approved.revision &&
              installation?.enabled === true &&
              installation.ready
            );
          },
          30_000,
          "the reviewed replacement declaration ready on its owner",
        );
        const reviewed = (await describeNative())!;
        requireThat(
          reviewed.artifactSha256 === "b".repeat(64),
          "the review did not admit the replacement's native declaration",
        );
        const before = await state();
        const commands = owner().commands.length;
        const proofs = owner().proofs;
        deployTo(r2);
        await up({}, undefined, primary!.sha256);
        await ready();
        await owner().proved(proofs + 1);
        const replayed = (await containerLogs())
          .split("\n")
          .find((line) => line.includes('"evt":"plugin_replacement_replayed"'));
        requireThat(
          replayed?.includes(primary!.sha256) && replayed.includes(r2),
          "the candidate did not recognize the replayed set",
        );
        await until(
          async () => (await describeNative())?.ready === true,
          30_000,
          "the reviewed native installation ready again after the replay",
        );
        const after = await state();
        const installation = await describeNative();
        requireThat(
          isDeepStrictEqual(after.rows, before.rows) &&
            isDeepStrictEqual(after.journal, before.journal) &&
            !after.staged &&
            installation?.revision === reviewed.revision &&
            installation.enabled &&
            !owner()
              .commands.slice(commands)
              .some((command) => command.action !== undefined),
          "replaying the applied set changed a row, the journal or the reviewed native installation",
        );
        dataRetained(after, "replay");
        receipts["replay"] = {
          reviewed: { revision: reviewed.revision, artifact: reviewed.artifactSha256 },
          replayed: redact(replayed ?? ""),
        };
      },
    );
  } else if (integrated) {
    await step("retained server-only hub replacement preserves data and ownership", async () => {
      appUid = 0;
      await compose(finalImage(), ["up", "-d", "--build", "--no-deps", "manifold"], {
        timeoutMs: 18 * 60_000,
      });
      active = true;
      await rememberImages();
      await ready();
      await acquireIdentity();
      const pluginId = "example.counter";
      const bumpAction = `${pluginId}.bump`;
      const bundleName = `${pluginId}.manifold-plugin.json`;
      const bundlePath = join(directory, bundleName);
      const packed = await command(
        [
          "bun",
          join(repo, "packages/plugin-kit/src/pack.ts"),
          join(repo, "packages/plugin-kit/test/fixtures/sample"),
          "--out",
          bundlePath,
        ],
        { cwd: join(repo, "packages/plugin-kit"), timeoutMs: 120_000 },
      );
      const pluginSha256 = String(Reflect.get(JSON.parse(packed.out) as object, "sha256"));
      requireThat(/^[a-f0-9]{64}$/.test(pluginSha256), "plugin pack returned an invalid digest");
      const uploadDir = "/data/plugin-uploads";
      const uploadedBundle = `${uploadDir}/${bundleName}`;
      await execBun(
        `import { mkdirSync } from "node:fs"; mkdirSync(${JSON.stringify(uploadDir)}, { recursive: true, mode: 0o700 });`,
      );
      await docker(["cp", bundlePath, `${await containerId()}:${uploadedBundle}`]);
      await act("engine.plugins.install", {
        source: uploadedBundle,
        sha256: pluginSha256,
        hardened: true,
      });
      const counter = async (): Promise<number> => {
        const result = await act(bumpAction, { by: 1 });
        return Number(Reflect.get(result as object, "count"));
      };
      requireThat(
        (await counter()) === 1,
        "installed server plugin did not answer before replacement",
      );
      // The successful dispatch leaves the hub-owned isolate live for ten minutes. Replacement
      // must recognize that exact child as restartable rather than waiting for idle eviction.
      const incumbentId = (await inspectContainer()).Id;
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
      // Gate a short-lived shell on a FIFO so its parent exits before it can.
      // PID1 must inherit and retain the actual zombie; no mocked /proc or killed process.
      const zombieFifo = `/tmp/retained-zombie-${number}`;
      const zombiePid = (
        await docker([
          "exec",
          "--user",
          `${appUid}:${appUid}`,
          incumbentId,
          "/bin/sh",
          "-c",
          'mkfifo "$1" || exit 1; (read -r release < "$1") </dev/null >/dev/null 2>&1 & printf "%s\\n" "$!"',
          "retained-zombie",
          zombieFifo,
        ])
      ).out.trim();
      requireThat(/^[1-9]\d*$/.test(zombiePid) && zombiePid !== "1", "invalid orphan fixture PID");
      const zombieState = `import { readFileSync } from "node:fs";
const stat = readFileSync("/proc/${zombiePid}/stat", "utf8");
const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
console.log([fields[0], fields[1], fields[19], readFileSync("/proc/${zombiePid}/cmdline").length, fields[17]].join(" "));`;
      const orphan = (await execBun(zombieState)).split(" ");
      requireThat(
        orphan[0] !== "Z" && orphan[1] === "1" && /^\d+$/.test(orphan[2] ?? ""),
        "FIFO-gated child was not inherited alive by PID1",
      );
      await execBun(`import { writeFileSync, unlinkSync } from "node:fs";
writeFileSync(${JSON.stringify(zombieFifo)}, "exit\\n");
unlinkSync(${JSON.stringify(zombieFifo)});`);
      const terminalState = `Z 1 ${orphan[2]} 0 1`;
      await until(
        async () => {
          const observed = await execBun(zombieState);
          requireThat(
            observed.split(" ")[2] === orphan[2],
            "orphan fixture PID was reused before terminal state Z",
          );
          return observed === terminalState;
        },
        10_000,
        "the orphaned shell to reach single-threaded kernel state Z under PID1 with an empty cmdline",
      );
      const proof = await docker(["exec", "-i", incumbentId, "bun", "--no-env-file", "-"], {
        input: readFileSync(join(tooling, "retained-server-only.ts"), "utf8"),
        allowFailure: true,
      });
      // The same vocabulary `environment.sh` reads, for the same reason: reporting a probe that
      // never ran, a probe that answered out of vocabulary and a probe that read every process
      // and refused as one "refused the live plugin isolate and observed zombie" sentence put
      // back, at this layer, the collapse #741 removed inside the probe (#738).
      const admission = retainedProcessAdmission(proof.code, proof.out.trim());
      requireThat(admission.admitted, retainedProcessRefusal(proof.code, proof.out.trim()));
      // A denied read the kernel then proved had exited is ADMITTED (#762), and an admission
      // that recorded nothing made that handling invisible in CI: this run and a run where the
      // condition never arose looked identical. The count is the same bounded integer a refusal
      // carries, so it is reported here rather than inferred from fixtures.
      if (admission.denied > 0) metrics["retainedDeniedReadsAdmitted"] = admission.denied;
      requireThat(
        (await execBun(zombieState)) === terminalState,
        "the zombie disappeared or changed identity during the retained process proof",
      );
      // This zombie is synthetic and belongs to THIS step. Cumulative metrics are reported
      // with every failure, and an unqualified name here read as the refusing predicate of a
      // later step's HOLD once already.
      metrics["retainedZombieFixture"] = {
        pid: Number(zombiePid),
        state: "Z",
        ppid: 1,
        threads: 1,
        starttime: orphan[2],
      };
      await up();
      await ready();
      requireThat(
        (await inspectContainer()).Id !== incumbentId,
        "retained deployment did not replace the incumbent with a live plugin isolate and zombie",
      );
      requireThat(
        (await counter()) === 2,
        "installed server plugin did not restart with preserved storage after replacement",
      );
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
    await step(
      "development ordering refuses stale state and permits explicit rollback",
      async () => {
        const original = revision;
        const installedCheckout = (
          await command(["git", "rev-parse", "HEAD"], { cwd: fixtureRepo })
        ).out.trim();
        const forward = await fixtureChild(original, `forward-${crypto.randomUUID()}`);
        const staleExpectation = await fixtureChild(original, `stale-${crypto.randomUUID()}`);
        revision = forward;
        expectedBuild = deriveBuildIdentity(fixtureRepo, revision).build;
        await up();
        await ready();

        const incumbent = await inspectContainer();
        revision = original;
        const backward = await up({ allowFailure: true, timeoutMs: 6 * 60_000 });
        requireThat(backward.code === 2, "normal deployment did not refuse a stale target");
        let after = await inspectContainer();
        requireThat(
          after.Id === incumbent.Id &&
            after.State.StartedAt === incumbent.State.StartedAt &&
            after.State.Status === "running",
          "stale normal deployment mutated the incumbent",
        );

        const staleRollback = await up(
          { allowFailure: true, timeoutMs: 6 * 60_000 },
          staleExpectation,
        );
        requireThat(
          staleRollback.code === 2,
          "rollback did not enforce its incumbent compare-and-swap",
        );
        after = await inspectContainer();
        requireThat(
          after.Id === incumbent.Id &&
            after.State.StartedAt === incumbent.State.StartedAt &&
            after.State.Status === "running",
          "stale rollback expectation mutated the incumbent",
        );
        requireThat(
          (await health()).build === expectedBuild,
          "refused ordering requests damaged the incumbent HTTP service",
        );
        requireThat(
          (await command(["git", "rev-parse", "HEAD"], { cwd: fixtureRepo })).out.trim() ===
            installedCheckout,
          "refused deployment changed the installed receiver checkout",
        );
        // The installed checkout remains fixed across both refusals. A same-target
        // retry still follows the incumbent image label rather than checkout HEAD.
        revision = forward;
        await up({}, staleExpectation);
        await ready();

        revision = original;
        expectedBuild = deriveBuildIdentity(fixtureRepo, revision).build;
        await up({}, forward);
        await ready();
        requireThat(
          (await command(["git", "rev-parse", "HEAD"], { cwd: fixtureRepo })).out.trim() ===
            installedCheckout,
          "rollback changed the installed receiver checkout",
        );
      },
    );
    await step("a stopped failed candidate remains the deployment authority", async () => {
      const original = revision;
      const candidate = await fixtureChild(original, `failed-${crypto.randomUUID()}`);
      const previous = await inspectContainer();
      const fastClock = join(shims, "sleep");
      revision = candidate;
      expectedBuild = deriveBuildIdentity(fixtureRepo, revision).build;
      // Only accelerate host polling. Docker activation and all failed HTTP
      // requests stay real, against this run's loopback server and private data.
      writeFileSync(fastClock, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      try {
        const failed = await up({
          allowFailure: true,
          env: { ...env, PREVIEW_DEV_URL: `${origin}/unconfirmed-activation` },
        });
        requireThat(failed.code !== 0, "unconfirmed activation unexpectedly succeeded");
      } finally {
        rmSync(fastClock);
      }
      const retained = await inspectContainer();
      requireThat(retained.Id !== previous.Id, "failed activation never created its candidate");
      requireThat(
        (
          await docker([
            "image",
            "inspect",
            retained.Image,
            "--format",
            '{{index .Config.Labels "org.opencontainers.image.revision"}}',
          ])
        ).out.trim() === candidate,
        "failed candidate lost its immutable application provenance",
      );
      await docker(["stop", retained.Id]);
      revision = original;
      const stale = await up({ allowFailure: true });
      requireThat(stale.code === 2, "a stopped newer candidate allowed an ordinary rollback");
      const unchanged = await inspectContainer();
      requireThat(
        unchanged.Id === retained.Id &&
          unchanged.Image === retained.Image &&
          unchanged.State.Status === "exited",
        "refused deployment replaced or restarted the stopped candidate",
      );
      // Existing retained-process safety still requires a running incumbent.
      // Recover this run-owned container explicitly; deployment must not bypass that hold.
      await docker(["start", retained.Id]);
      await ready();
      // The failed candidate was referenced only by :candidate. Retrying it
      // must pin that actual image before the candidate build tag is reused.
      revision = candidate;
      await up();
      await ready();
      revision = original;
      expectedBuild = deriveBuildIdentity(fixtureRepo, revision).build;
      await up({}, candidate);
      await ready();
    });
    for (const [name, override] of [
      [
        "candidate-owner-command",
        '    command: ["bun", "packages/agent/src/main.ts", "--terminal-host"]\n',
      ],
      [
        "candidate-entrypoint",
        '    entrypoint: ["/bin/sh", "-c", "touch /data/unsafe-candidate"]\n',
      ],
      [
        "candidate-stock-entrypoint-without-command",
        '    entrypoint: ["/usr/local/bin/docker-entrypoint.sh"]\n',
      ],
      ["candidate-workdir", "    working_dir: /data\n"],
      ["candidate-shared-pid", "    pid: host\n"],
      [
        "candidate-bun-loader",
        '    environment:\n      BUN_OPTIONS: "--preload=/data/loader.ts"\n',
      ],
      ["candidate-shell-loader", "    environment:\n      BASH_ENV: /data/loader.sh\n"],
      ["candidate-native-loader", "    environment:\n      LD_PRELOAD: /data/loader.so\n"],
      ["candidate-home-loader", "    environment:\n      HOME: /data\n"],
      ["candidate-null-data-root", "    environment:\n      MANIFOLD_DATA_DIR: null\n"],
      [
        "candidate-healthcheck",
        '    healthcheck:\n      test: ["CMD-SHELL", "touch /data/unsafe-candidate"]\n',
      ],
      ["candidate-owner-key", `    environment:\n      MANIFOLD_OWNER_KEY: "${"a".repeat(64)}"\n`],
    ] as const) {
      await step(`${name} refuses before incumbent mutation`, async () => {
        await preserveLive(
          name,
          async () => {
            // A separate real Compose override, not a mocked deployment boundary.
            const unsafeOverlay = join(tooling, "fixture-unsafe-candidate.yaml");
            writeFileSync(unsafeOverlay, `services:\n  manifold:\n${override}`);
            env["COMPOSE_FILE"] += `:${unsafeOverlay}`;
          },
          async () => {
            env["COMPOSE_FILE"] = `${join(fixtureRepo, "compose.yaml")}:${developmentOverlay}`;
            rmSync(join(tooling, "fixture-unsafe-candidate.yaml"), { force: true });
          },
        );
      });
    }
    for (const alternateContext of [false, true]) {
      await step("unreviewed build source refuses before incumbent mutation", async () => {
        const base = (
          await docker(["image", "inspect", "--format", "{{.Id}}", finalImage()])
        ).out.trim();
        const baseTag = `${project()}:candidate-base`;
        const recipe = join(tooling, "Dockerfile.unreviewed");
        const overlay = join(tooling, "fixture-unreviewed-build.yaml");
        await docker(["image", "tag", base, baseTag]);
        const rewrite = `const path = "/app/packages/server/src/main.ts";
await Bun.write(path, ${JSON.stringify('await Bun.write("/data/unsafe-candidate", "unreviewed");\n')} + await Bun.file(path).text());`;
        await preserveLive(
          "unreviewed-build-source",
          async () => {
            writeFileSync(
              recipe,
              `FROM ${baseTag}\nRUN ${JSON.stringify(["bun", "-e", rewrite])}\n`,
            );
            writeFileSync(
              overlay,
              `services:\n  manifold:\n    build:\n${
                alternateContext
                  ? `      context: ${tooling}\n      dockerfile: Dockerfile.unreviewed`
                  : `      dockerfile: ${recipe}`
              }\n`,
            );
            env["COMPOSE_FILE"] += `:${overlay}`;
          },
          async () => {
            env["COMPOSE_FILE"] = `${join(fixtureRepo, "compose.yaml")}:${developmentOverlay}`;
            rmSync(recipe, { force: true });
            rmSync(overlay, { force: true });
            await docker(["image", "rm", baseTag]);
          },
        );
        requireThat(
          (await execBun('console.log(await Bun.file("/data/unsafe-candidate").exists())')) ===
            "false",
          "unreviewed source executed against the retained volume",
        );
      });
    }
    for (const [name, instruction] of [
      ["candidate-image-command", 'CMD ["bun", "packages/agent/src/main.ts", "--terminal-host"]'],
      ["candidate-image-loader", "ENV BASH_ENV=/data/loader.sh"],
      ["candidate-image-owner-key", `ENV MANIFOLD_OWNER_KEY=${"b".repeat(64)}`],
      ["candidate-image-healthcheck", "HEALTHCHECK CMD touch /data/unsafe-candidate"],
    ] as const) {
      await step(`${name} refuses unsafe image defaults before incumbent mutation`, async () => {
        const baseRevision = revision;
        const dockerfile = join(fixtureRepo, "Dockerfile");
        const supportedRecipe = readFileSync(dockerfile, "utf8");
        const incumbent = await inspectContainer();
        await preserveLive(
          name,
          async () => {
            writeFileSync(dockerfile, `${supportedRecipe}\n${instruction}\n`);
            await command(["git", "add", "Dockerfile"], { cwd: fixtureRepo });
            revision = await fixtureRevision(name);
          },
          async () => {
            revision = baseRevision;
            await command(["git", "checkout", "--detach", revision], { cwd: fixtureRepo });
          },
        );
        // Restoring reviewed source must replace the container. A rebuild may
        // produce a new image digest, so compare against this deployment's image.
        await up();
        await ready();
        const restored = await inspectContainer();
        requireThat(restored.Id !== incumbent.Id, `${name} reused the stopped incumbent`);
        const reviewedImage = (
          await docker(["image", "inspect", finalImage(), "--format", "{{.Id}}"])
        ).out.trim();
        requireThat(
          restored.Image === reviewedImage,
          `${name} did not activate the reviewed image`,
        );
      });
    }
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
    writeFileSync(
      join(fixtureRepo, "compose.yaml"),
      `services:
  manifold:
    build:
      context: .
      dockerfile: Dockerfile
    privileged: true
    volumes:
      - /:/host:rw
  hostile:
    image: alpine
    privileged: true
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`,
    );
    writeFileSync(join(fixtureRepo, "Dockerfile"), "FROM scratch\nRUN false\n");
    const identityPath = join(fixtureRepo, "scripts", "build-identity.ts");
    const identitySource = readFileSync(identityPath, "utf8");
    const hostileIdentityMain = `if (import.meta.main) {\n  await Bun.write(${JSON.stringify(hostileIdentityMarker)}, "executed");\n  process.exit(92);\n}\n`;
    writeFileSync(identityPath, identitySource.replace("\n", `\n${hostileIdentityMain}`));
    await command(["git", "add", "compose.yaml", "Dockerfile", "scripts/build-identity.ts"], {
      cwd: fixtureRepo,
    });
    revision = await fixtureRevision(`hostile-${crypto.randomUUID()}`);
    expectedBuild = deriveBuildIdentity(fixtureRepo, revision).build;
    baseIdentity["MANIFOLD_BUILD"] = expectedBuild;
    metrics["hostileRevision"] = revision;
    await step(
      "stable tooling contains hostile PR inputs and sanitizes representative seed",
      async () => {
        const deploymentResult = await up();
        requireThat(
          `${deploymentResult.out}\n${deploymentResult.err}`.includes(
            "stable preview boundary: using trusted standalone Compose topology",
          ) &&
            `${deploymentResult.out}\n${deploymentResult.err}`.includes(
              "stable preview boundary: building exact source with the trusted Dockerfile",
            ),
          "deployment did not receipt both stable tooling substitutions",
        );
        requireThat(
          `${deploymentResult.out}\n${deploymentResult.err}`.includes(
            "seeded representative containers, container_folders and scene_docs; preview authority is fresh",
          ),
          "deployment did not receipt the representative seed allowlist",
        );
        requireThat(
          !existsSync(hostileIdentityMarker),
          "the PR-controlled build identity script executed on the host",
        );
        const ids = (
          await docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project()}`])
        ).out
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        requireThat(ids.length === 1, "hostile PR Compose added a service to the stable topology");
        const boundary = JSON.parse(
          (
            await docker([
              "inspect",
              await containerId(),
              "--format",
              '{"HostConfig":{{json .HostConfig}},"Mounts":{{json .Mounts}}}',
            ])
          ).out,
        ) as {
          HostConfig: { Privileged: boolean };
          Mounts: { Destination: string; Name?: string; RW: boolean; Type: string }[];
        };
        requireThat(
          boundary.HostConfig.Privileged === false,
          "hostile PR Compose acquired privileged authority",
        );
        requireThat(
          boundary.Mounts.length === 1 &&
            boundary.Mounts[0]?.Type === "volume" &&
            boundary.Mounts[0].Name === volume() &&
            boundary.Mounts[0].Destination === "/data" &&
            boundary.Mounts[0].RW,
          "stable topology mounted anything other than the named writable data volume",
        );
        await ready();
        await acquireIdentity();
        requireThat(ownerKey !== seededOwnerKey, "seeded preview reused the development owner key");
        for (const credential of [seededOwnerKey, seededBearer]) {
          const refused = await fetch(`${origin}/api/actions/core.index.read`, {
            method: "POST",
            headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
            body: "{}",
            signal: AbortSignal.timeout(20_000),
          });
          requireThat(
            refused.status === 401,
            "a reusable development credential opened the preview",
          );
        }
        const seededItems = IndexResponseSchema.parse(await act("core.index.read", {})).items;
        requireThat(
          seededItems.some(
            (item) =>
              item.kind === "container" &&
              item.container.id === seededContainerId &&
              item.container.name === "Representative seed",
          ),
          "allowlisted representative container data did not survive seeding",
        );
        await session(seededContainerId);
        const seedFiles = JSON.parse(
          await execBun(
            `const text = async p => (await Bun.file(p).text()).trim();
console.log(JSON.stringify({
  signingFresh: await text('/data/preview-identity.key') !== ${JSON.stringify(seededSigningKey)},
  agentFresh: await text('/data/agent.token') !== ${JSON.stringify(seededAgentToken)},
  arbitraryAbsent: !(await Bun.file('/data/development-only.secret').exists())
}));`,
            true,
          ),
        ) as { signingFresh: boolean; agentFresh: boolean; arbitraryAbsent: boolean };
        requireThat(
          seedFiles.signingFresh && seedFiles.agentFresh && seedFiles.arbitraryAbsent,
          "seeded preview retained development signing, agent or adjacent file authority",
        );
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
      },
    );
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
      originalTerminalHomeId = terminal.homeId;
      await processOwners(0);
      identityDigests = await digests();
      closeClients();
    });
    await step("retained preview work blocks replacement without disruption", async () => {
      const before = await inspectContainer();
      const result = await up({ allowFailure: true, timeoutMs: 18 * 60_000 });
      requireThat(result.code !== 0, "preview replacement destroyed retained terminal work");
      requireThat(
        `${result.out}\n${result.err}`.includes("HOLD: preview node") &&
          `${result.out}\n${result.err}`.includes(
            "close or migrate them before changing this preview",
          ),
        "occupied preview replacement did not return its actionable hold",
      );
      const after = await inspectContainer();
      requireThat(
        after.Id === before.Id &&
          after.State.StartedAt === before.State.StartedAt &&
          after.State.Status === "running",
        "occupied preview replacement changed the incumbent container",
      );
      await terminalProbe(originalTerminalId, originalTerminalHomeId, "retained-after-refusal");
      requireThat((await onlineMachine()) === machineId, "replacement hold left admission closed");
    });
    await step("explicitly emptied preview replaces and preserves workspace data", async () => {
      await act("core.terminals.kill", { terminalId: originalTerminalId });
      await until(
        async () => !(await terminals()).some((terminal) => terminal.id === originalTerminalId),
        20_000,
        "operator-cleared preview terminal",
      );
      appUid = 1000;
      await up();
      await ready();
      await processOwners(1000);
      await sceneSurvives();
      await assertDeploymentProbeClean();
      requireThat((await terminals()).length === 0, "deployment terminal probe was not cleaned up");
      await newTerminalProbe("migrated-developer");
      await assertDataWrites();
      await createRefusedMachine();
    });
    await step("native browser shell, OMP draft and Index reattachment", browserProof);
    await step("same-SHA request verifies without replacing retained terminal work", async () => {
      const marker = `home-${crypto.randomUUID()}`;
      await execBun(
        `await Bun.write('/home/developer/.preview-home-marker', ${JSON.stringify(marker)});`,
      );
      const before = await inspectContainer();
      const retained = (await terminals()).filter((terminal) => terminal.status === "running");
      requireThat(retained.length > 0, "same-SHA proof requires retained terminal work");
      closeClients();
      const result = await up();
      requireThat(
        `${result.out}\n${result.err}`.includes(
          `already runs exact healthy revision ${revision}; verifying without replacement`,
        ),
        "same-SHA request did not take the verified no-replacement path",
      );
      const after = await inspectContainer();
      requireThat(
        after.Id === before.Id && after.State.StartedAt === before.State.StartedAt,
        "same-SHA request replaced the incumbent container",
      );
      const current = await terminals();
      requireThat(
        retained.every((expected) =>
          current.some((terminal) => terminal.id === expected.id && terminal.status === "running"),
        ),
        "same-SHA request removed retained terminal work",
      );
      requireThat(
        current.length === retained.length,
        "same-SHA verification left a disposable terminal behind",
      );
      await assertDeploymentProbeClean();
      await terminalProbe(retained[0]!.id, retained[0]!.homeId, "same-sha-retained");
      requireThat(
        (await execBun(
          "console.log(await Bun.file('/home/developer/.preview-home-marker').text())",
        )) === marker,
        "same-SHA request discarded the disposable home",
      );

      for (const terminal of current) await act("core.terminals.kill", { terminalId: terminal.id });
      await until(
        async () => (await terminals()).length === 0,
        30_000,
        "explicitly emptied preview terminal inventory",
      );
      await compose(finalImage(), ["exec", "-T", "manifold", "bun", "-", "prepare"], {
        input: readFileSync(join(tooling, "terminal-lifecycle.ts"), "utf8"),
      });
      await compose(finalImage(), ["stop", "manifold"]);
      // Engine 28 wakes stop waiters before checkpointing its container-list replica.
      // Inspect acquires that lock so Compose cannot misread stale running state.
      const stopped = await inspectContainer();
      requireThat(stopped.State.Status === "exited", "the stopped container has completed exit");
      metrics["stoppedContainer"] = stopped.State;
      await compose(finalImage(), ["start", "manifold"]);
      await ready();
      await compose(finalImage(), ["exec", "-T", "manifold", "bun", "-", "verify"], {
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

      const beforeRecreation = await containerId();
      await compose(finalImage(), ["stop", "manifold"]);
      await compose(finalImage(), ["rm", "-f", "manifold"]);
      await up();
      await ready();
      requireThat(
        (await containerId()) !== beforeRecreation,
        "explicit empty recreation reused the original container",
      );
      requireThat(
        (await execBun(
          "console.log(await Bun.file('/home/developer/.preview-home-marker').exists())",
        )) === "false",
        "new container inherited the disposable home",
      );
      await sceneSurvives();
      await assertDeploymentProbeClean();
      await newTerminalProbe("recreated-developer");
      await assertDataWrites();
    });
  }
  if (integrated && !crossing) {
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
  } else if (!integrated) {
    const goodPin = readFileSync(pinPath, "utf8");
    const safeRevision = revision;
    const malformedIdentityRevision = await fixtureChild(
      safeRevision,
      `malformed-identity-${crypto.randomUUID()}`,
    );
    await command(["git", "tag", "vbad;identity", malformedIdentityRevision], {
      cwd: originRepo,
    });
    await step("malformed inert identity refuses before touching the live preview", () =>
      preserveLive(
        "malformed-identity",
        async () => {
          revision = malformedIdentityRevision;
        },
        async () => {
          revision = safeRevision;
        },
        "preview: malformed inert build identity",
      ),
    );
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
    const buildRequiredRevision = await fixtureChild(
      safeRevision,
      `build-required-${crypto.randomUUID()}`,
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
            revision = buildRequiredRevision;
          },
          async () => {
            delete env["BUILDX_BUILDER"];
            revision = safeRevision;
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
          revision = buildRequiredRevision;
          writeFileSync(
            adapterPath,
            adapter +
              "\nRUN printf 'throw new Error(\"fixture-derived-protocol-probe\");\\n' > /app/packages/protocol/src/index.ts\n",
          );
        },
        async () => {
          revision = safeRevision;
          writeFileSync(adapterPath, adapter);
        },
        "fixture-derived-protocol-probe",
      );
    });
    await step("restored tooling deploys an explicitly emptied revision", async () => {
      closeClients();
      for (const terminal of await terminals())
        await act("core.terminals.kill", { terminalId: terminal.id });
      await until(
        async () => (await terminals()).length === 0,
        30_000,
        "restored-tooling replacement inventory empty",
      );
      revision = buildRequiredRevision;
      expectedBuild = deriveBuildIdentity(fixtureRepo, revision).build;
      await up();
      await ready();
      await processOwners(1000);
      await sceneSurvives();
      await assertDeploymentProbeClean();
      await newTerminalProbe("restored-good-image");
    });
    const firstStorage = await storage("oneBase");
    if (measureStorage) {
      await step("second distinct PR app base and measured incremental storage", async () => {
        closeClients();
        for (const terminal of await terminals())
          await act("core.terminals.kill", { terminalId: terminal.id });
        await until(
          async () => (await terminals()).length === 0,
          30_000,
          "measured replacement inventory empty",
        );
        const oldBase = (
          await docker(["image", "inspect", baseImage(), "--format", "{{.Id}}"])
        ).out.trim();
        revision = await fixtureRevision(crypto.randomUUID());
        const secondIdentity = deriveBuildIdentity(fixtureRepo, revision);
        baseIdentity["MANIFOLD_VERSION"] = secondIdentity.version;
        baseIdentity["MANIFOLD_BUILD"] = secondIdentity.build;
        baseIdentity["MANIFOLD_CHANNEL"] = "development";
        expectedBuild = secondIdentity.build;
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
    await step(
      "removal holds retained work, then removes an explicitly empty preview",
      async () => {
        closeClients();
        const retained = (await terminals()).find((terminal) => terminal.status === "running");
        requireThat(retained !== undefined, "removal hold proof requires retained terminal work");
        const before = await inspectContainer();
        const held = await command(["bash", join(tooling, "preview.sh"), "down", number], {
          timeoutMs: 120_000,
          allowFailure: true,
        });
        requireThat(held.code !== 0, "preview removal destroyed retained terminal work");
        requireThat(
          `${held.out}\n${held.err}`.includes("HOLD: preview node") &&
            `${held.out}\n${held.err}`.includes(
              "close or migrate them before changing this preview",
            ),
          "occupied preview removal did not return its actionable hold",
        );
        const after = await inspectContainer();
        requireThat(
          after.Id === before.Id &&
            after.State.StartedAt === before.State.StartedAt &&
            after.State.Status === "running",
          "occupied preview removal changed the incumbent container",
        );
        await terminalProbe(retained.id, retained.homeId, "retained-after-removal-refusal");
        for (const terminal of await terminals())
          await act("core.terminals.kill", { terminalId: terminal.id });
        await until(
          async () => (await terminals()).length === 0,
          30_000,
          "preview removal inventory empty",
        );
        rmSync(pinPath);
        await command(["bash", join(tooling, "preview.sh"), "down", number], {
          timeoutMs: 120_000,
        });
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
      },
    );
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
      const id = await containerId();
      const logs = await docker(["logs", "--tail", "150", id], { confidential: true });
      writeFileSync(
        join(evidence, "container-logs.txt"),
        redact(`stdout:\n${logs.out}\nstderr:\n${logs.err}`),
      );
      writeFileSync(
        join(evidence, "container-inspect.json"),
        JSON.stringify(await inspectContainer(), null, 2) + "\n",
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
    crossing
      ? "preview-environment: PASS (staged bundle crossing, interruption and rollback through the integrated receiver)"
      : integrated
        ? "preview-environment: PASS (retained server-only topology and state preservation)"
        : "preview-environment: PASS (screenshots require visual inspection)",
  );
