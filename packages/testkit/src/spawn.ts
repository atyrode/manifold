import {
  ActionOutcomeSchema,
  ContainersResponseSchema,
  CreateContainerRequestSchema,
  HealthResponseSchema,
  HttpErrorSchema,
  MachineEnrollResponseSchema,
  MachinesResponseSchema,
  MintTokenRequestSchema,
  AttendanceResponseSchema,
  ContainerResponseSchema,
  ContainerTerminalsResponseSchema,
  DialSchema,
  DialTicketSchema,
  RevokeResultSchema,
  ShareGrantSchema,
  ShareInventorySchema,
  TerminalsResponseSchema,
  TokenGrantSchema,
  type ActionOutcome,
  type Cap,
  type Dial,
  type DialTicket,
  type HttpError,
  type MintTokenRequest,
  type Container,
  type ContainerTerminalSummary,
  type ShareGrant,
  type ShareInventory,
  type TerminalSummary,
  type TokenGrant,
} from "@manifold/protocol";
import { SessionClient } from "@manifold/sdk";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const READY_LINE = /manifold ready url=(https?:\/\/[^\s"']+)/;
const OWNER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const READY_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;
const HTTP_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 15_000;
const OUTPUT_LINE_LIMIT = 200;

type SpawnedProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;
type StopSignal = Parameters<SpawnedProcess["kill"]>[0];

/** Captured child output is bounded so failed e2e assertions stay useful without leaking memory. */
export interface ProcessOutput {
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

/** The live server fixture exposes both authenticated bootstrap data and canonical endpoints. */
export interface TestServer {
  readonly url: string;
  readonly port: number;
  readonly ownerKey: string;
  readonly httpUrl: string;
  readonly wsUrl: string;
  readonly dataDir: string;
  readonly proc: SpawnedProcess;
  readonly output: ProcessOutput;
  stop(signal?: StopSignal): Promise<void>;
}

/** A separately spawned machine agent is stopped explicitly so test failures cannot leak PTYs. */
export interface TestAgent {
  readonly machineId: string;
  readonly name: string | undefined;
  readonly proc: SpawnedProcess;
  readonly output: ProcessOutput;
  stop(signal?: StopSignal): Promise<void>;
}

/** Server startup options keep every test isolated while still allowing fixed-port restart checks. */
export interface StartServerOptions {
  readonly dataDir?: string;
  readonly port?: number;
  readonly ownerKey?: string;
  readonly spawnAgent?: boolean;
  readonly env?: Readonly<Record<string, string>>;
}

/** Agent startup options deliberately take the pre-authenticated ready URL for readiness polling. */
export interface StartAgentOptions {
  readonly serverUrl: string;
  readonly machineToken: string;
  readonly name?: string;
  readonly env?: Readonly<Record<string, string>>;
}

/** Resume hints let a fresh SDK instance exercise the documented returning-client join path. */
export interface ConnectOptions {
  readonly containerId: string;
  readonly token: string;
  readonly lastEpoch?: string;
  readonly lastRev?: number;
  readonly reconnect?: boolean;
  /** Joins as a read-only watcher: no roster entry, no presence, no vote in the bubble rule. */
  readonly spectator?: boolean;
}

/** A protocol parser is supplied per endpoint so ownerFetch never returns unchecked JSON. */
export interface ResponseSchema<T> {
  parse(input: unknown): T;
}

/** Explicit schemas support endpoints whose route cannot identify one response envelope. */
export interface OwnerFetchOptions<T = unknown> extends RequestInit {
  readonly responseSchema?: ResponseSchema<T>;
}

const RESPONSE_SCHEMA_BY_REQUEST: Record<string, ResponseSchema<unknown>> = {
  "GET /healthz": HealthResponseSchema,
  "GET /api/attendance": AttendanceResponseSchema,
  /*
    No terminal route is listed here any more: the INDEX is `core.terminals.listAll` and the
    per-container listing is `core.terminals.listByContainer`, both reached through `ownerAction`
    like every other door. The gestures that used to be endpoints (`expand`, `pin`) went the
    same way earlier, as destinations of the placement door.
   */
  /** The containment graph: what each container holds and what it points at. */
  "GET /api/containers": ContainersResponseSchema,
};

function defaultResponseSchema(path: string, method: string): ResponseSchema<unknown> | undefined {
  const pathname = new URL(path, "http://manifold.test").pathname;
  const exact = RESPONSE_SCHEMA_BY_REQUEST[`${method} ${pathname}`];
  if (exact !== undefined) return exact;
  // The one container route left, and a read: create, rename and delete are `core.views` actions.
  if (method === "GET" && /^\/api\/containers\/[^/]+$/.test(pathname))
    return ContainerResponseSchema;
  return undefined;
}

/** A typed HTTP failure preserves the protocol code for capability-boundary assertions. */
export class HttpResponseError extends Error {
  readonly status: number;
  readonly code: HttpError["error"]["code"];

  constructor(status: number, body: HttpError) {
    super(`${body.error.code}: ${body.error.message}`);
    this.name = "HttpResponseError";
    this.status = status;
    this.code = body.error.code;
  }
}

class LineRing {
  readonly lines: string[] = [];

  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > OUTPUT_LINE_LIMIT) {
      this.lines.splice(0, this.lines.length - OUTPUT_LINE_LIMIT);
    }
  }
}

interface ReadyInfo {
  readonly url: string;
  readonly port: number;
  readonly ownerKey: string;
  readonly httpUrl: string;
  readonly wsUrl: string;
}

function formatOutput(output: ProcessOutput): string {
  const stdout = output.stdout.length === 0 ? "<empty>" : output.stdout.join("\n");
  const stderr = output.stderr.length === 0 ? "<empty>" : output.stderr.join("\n");
  return `stdout tail:\n${stdout}\nstderr tail:\n${stderr}`;
}

function parseReadyLine(line: string): ReadyInfo | null {
  const match = READY_LINE.exec(line);
  const rawUrl = match?.[1];
  if (rawUrl === undefined) return null;

  const parsed = new URL(rawUrl);
  const ownerKey = new URLSearchParams(parsed.hash.slice(1)).get("key");
  if (ownerKey === null || !/^[0-9a-f]{64}$/i.test(ownerKey)) {
    throw new Error("server ready URL is missing a hex-64 #key fragment");
  }
  const defaultPort = parsed.protocol === "https:" ? 443 : 80;
  const port = parsed.port === "" ? defaultPort : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`server ready URL contains an invalid port: ${parsed.port}`);
  }

  const http = new URL(parsed.origin);
  const ws = new URL("/ws/session", http);
  ws.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return {
    url: parsed.toString(),
    port,
    ownerKey,
    httpUrl: http.toString().replace(/\/$/, ""),
    wsUrl: ws.toString(),
  };
}

async function collectLines(
  stream: ReadableStream<Uint8Array>,
  ring: LineRing,
  onLine?: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffered += decoder.decode(chunk.value, { stream: true });
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      ring.push(line);
      onLine?.(line);
    }
  }
  buffered += decoder.decode();
  if (buffered !== "") {
    ring.push(buffered);
    onLine?.(buffered);
  }
}

function mergedEnvironment(
  extra: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("MANIFOLD_")) env[key] = value;
  }
  if (extra !== undefined) Object.assign(env, extra);
  return env;
}

function spawnPiped(command: string[], env: Record<string, string>): SpawnedProcess {
  return Bun.spawn(command, {
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function createStop(proc: SpawnedProcess): (signal?: StopSignal) => Promise<void> {
  let exitObserved = false;
  let stopRequested = false;
  void proc.exited.then(() => {
    exitObserved = true;
  });
  return async (signal?: StopSignal): Promise<void> => {
    if (exitObserved || proc.exitCode !== null || stopRequested) {
      await proc.exited;
      return;
    }
    stopRequested = true;
    proc.kill(signal ?? "SIGTERM");
    const exited = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(STOP_TIMEOUT_MS).then(() => false),
    ]);
    if (!exited && !exitObserved) proc.kill("SIGKILL");
    await proc.exited;
  };
}

function captureProcess(
  proc: SpawnedProcess,
  onStdoutLine?: (line: string) => void,
): ProcessOutput {
  const stdout = new LineRing();
  const stderr = new LineRing();
  void collectLines(proc.stdout, stdout, onStdoutLine).catch((error: unknown) => {
    stdout.push(`output capture failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  void collectLines(proc.stderr, stderr).catch((error: unknown) => {
    stderr.push(`output capture failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  return { stdout: stdout.lines, stderr: stderr.lines };
}

function serverFromReadyUrl(serverUrl: string): Pick<TestServer, "httpUrl" | "ownerKey"> {
  const parsed = parseReadyLine(`manifold ready url=${serverUrl}`);
  if (parsed === null) throw new Error("invalid pre-authenticated server URL");
  return { httpUrl: parsed.httpUrl, ownerKey: parsed.ownerKey };
}

/**
 * Polls without sleeping past its deadline. The resolver seam keeps callers deterministic
 * and avoids hand-written Promise constructors throughout the e2e suites.
 */
export function waitFor<T>(
  predicate: () => T | false | null | undefined | Promise<T | false | null | undefined>,
  timeoutMs: number,
  intervalMs: number,
): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const deadline = Date.now() + timeoutMs;

  const check = async (): Promise<void> => {
    try {
      const result = await predicate();
      if (result !== false && result !== null && result !== undefined) {
        resolve(result);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`condition not met within ${timeoutMs}ms`));
        return;
      }
      setTimeout(() => void check(), Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    } catch (error) {
      reject(error);
    }
  };

  void check();
  return promise;
}

/** Spawns the real server entry and resolves only after its contract ready line is parsed. */
export async function startServer(options: StartServerOptions = {}): Promise<TestServer> {
  const port = options.port ?? 0;
  const dataDir = options.dataDir ?? (await mkdtemp("/tmp/manifold-test-"));
  const configuredOwnerKey = options.ownerKey ?? OWNER_KEY;
  if (!/^[0-9a-f]{64}$/i.test(configuredOwnerKey)) {
    throw new Error("ownerKey must be hex-64");
  }

  const env = mergedEnvironment(options.env);
  env.MANIFOLD_PORT = String(port);
  env.MANIFOLD_DATA_DIR = dataDir;
  env.MANIFOLD_OWNER_KEY = configuredOwnerKey;
  env.MANIFOLD_SPAWN_AGENT = (options.spawnAgent ?? false) ? "1" : "0";
  // Tests bootstrap by parsing the pre-authed ready line; stdout here is an
  // in-memory capture, not a persisted log stream, so opting in is safe.
  env.MANIFOLD_ANNOUNCE_KEY = "1";
  if (port !== 0) env.MANIFOLD_PUBLIC_URL = `http://localhost:${port}`;

  const proc = spawnPiped(["bun", "packages/server/src/main.ts"], env);
  const stop = createStop(proc);
  const { promise: ready, resolve, reject } = Promise.withResolvers<ReadyInfo>();
  let settled = false;
  const output = captureProcess(proc, (line) => {
    if (settled) return;
    try {
      const info = parseReadyLine(line);
      if (info !== null) {
        settled = true;
        resolve(info);
      }
    } catch (error) {
      settled = true;
      reject(error);
    }
  });
  void proc.exited.then((exitCode) => {
    if (!settled) {
      settled = true;
      reject(new Error(`server exited before readiness with code ${exitCode}`));
    }
  });

  let info: ReadyInfo;
  try {
    info = await Promise.race([
      ready,
      Bun.sleep(READY_TIMEOUT_MS).then(() => {
        throw new Error(`server readiness timed out after ${READY_TIMEOUT_MS}ms`);
      }),
    ]);
    if (info.ownerKey !== configuredOwnerKey) {
      throw new Error("server ready owner key does not match MANIFOLD_OWNER_KEY");
    }
  } catch (error) {
    await stop();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n${formatOutput(output)}`, { cause: error });
  }

  return {
    ...info,
    dataDir,
    proc,
    output,
    stop,
  };
}

/**
 * Adds owner authorization and parses every JSON response at the boundary with its
 * protocol-owned schema; known routes infer their envelope when `init` is omitted.
 */
export function ownerFetch<T>(
  server: Pick<TestServer, "httpUrl" | "ownerKey">,
  path: string,
  init: OwnerFetchOptions<T> & { readonly responseSchema: ResponseSchema<T> },
): Promise<T>;
export function ownerFetch(
  server: Pick<TestServer, "httpUrl" | "ownerKey">,
  path: string,
  init?: OwnerFetchOptions,
): Promise<unknown>;
export async function ownerFetch(
  server: Pick<TestServer, "httpUrl" | "ownerKey">,
  path: string,
  init: OwnerFetchOptions = {},
): Promise<unknown> {
  const { responseSchema, ...requestInit } = init;
  const headers = new Headers(requestInit.headers);
  headers.set("authorization", `Bearer ${server.ownerKey}`);
  headers.set("accept", "application/json");
  const method = requestInit.method?.toUpperCase() ?? "GET";
  const signal = requestInit.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS);
  const response = await fetch(new URL(path, server.httpUrl), {
    ...requestInit,
    headers,
    signal,
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new Error(`HTTP ${response.status} returned non-JSON`, { cause: error });
  }
  if (!response.ok) {
    throw new HttpResponseError(response.status, HttpErrorSchema.parse(body));
  }
  const schema = responseSchema ?? defaultResponseSchema(path, method);
  if (schema === undefined) {
    throw new Error(`ownerFetch needs a responseSchema for ${method} ${path}`);
  }
  return schema.parse(body);
}

/**
 * Invokes an action as any principal and returns the OUTCOME. The action door answers 200
 * for a denial too, so a refusal is data here exactly as it is on the wire: a case asserting
 * "this token may not" reads `outcome.denial.rule` instead of catching a status.
 */
export async function callAction(
  server: Pick<TestServer, "httpUrl">,
  token: string,
  name: string,
  args: unknown,
): Promise<ActionOutcome> {
  const response = await fetch(
    new URL(`/api/actions/${encodeURIComponent(name)}`, server.httpUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    },
  );
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new Error(`HTTP ${response.status} returned non-JSON`, { cause: error });
  }
  if (!response.ok) throw new HttpResponseError(response.status, HttpErrorSchema.parse(body));
  return ActionOutcomeSchema.parse(body);
}

/** Invokes an action as the owner and returns its result, throwing the denial's message. */
export async function ownerAction(
  server: Pick<TestServer, "httpUrl" | "ownerKey">,
  name: string,
  args: unknown,
): Promise<unknown> {
  const outcome = await callAction(server, server.ownerKey, name, args);
  if (!outcome.ok) throw new Error(`${name} refused: ${outcome.denial.message}`);
  return outcome.result;
}

/**
 * Mints a grant through the owner boundary and validates both request and response schemas.
 * `core.access.mint` replaced `POST /api/tokens`; the helper's shape is unchanged, so
 * every fixture that needs an attenuated identity is unaffected by where the door lives.
 */
export async function mintToken(
  server: TestServer,
  request: MintTokenRequest,
): Promise<TokenGrant> {
  const body = MintTokenRequestSchema.parse(request);
  return TokenGrantSchema.parse(await ownerAction(server, "core.access.mint", body));
}

/**
 * Enrolls an agent machine once, preserving the one-time raw machine token for its process.
 * `core.machines.enroll` replaced `POST /api/machines`; the helper's shape is unchanged.
 */
export async function enrollMachine(
  server: TestServer,
  name: string,
): Promise<{ machineId: string; machineToken: string }> {
  if (name.length === 0 || name.length > 64) throw new Error("machine name must be 1-64 chars");
  const response = MachineEnrollResponseSchema.parse(
    await ownerAction(server, "core.machines.enroll", { name }),
  );
  if (response.machineToken === undefined) {
    throw new Error(`machine ${JSON.stringify(name)} was already enrolled; no token minted`);
  }
  return { machineId: response.machine.id, machineToken: response.machineToken };
}

/**
 * Creates a container through the owner boundary and returns only its protocol-validated
 * record. `core.index.createContainer` replaced `POST /api/containers`; the helper's shape is unchanged,
 * so every fixture that needs a container is unaffected by where the door lives.
 */
export async function createContainer(
  server: TestServer,
  name: string,
  discipline?: "canvas" | "composition",
): Promise<Container> {
  const request = CreateContainerRequestSchema.parse({
    name,
    ...(discipline === undefined ? {} : { discipline }),
  });
  return ContainerResponseSchema.parse(
    await ownerAction(server, "core.index.createContainer", request),
  ).container;
}

/** Every container the caller can see (`core.index.listContainers`), in index order. */
export async function listContainers(server: TestServer): Promise<readonly Container[]> {
  return ContainersResponseSchema.parse(await ownerAction(server, "core.index.listContainers", {}))
    .containers;
}

/** Reads one container by id (`core.index.readContainer`). */
export async function getContainer(server: TestServer, containerId: string): Promise<Container> {
  return ContainerResponseSchema.parse(
    await ownerAction(server, "core.index.readContainer", { containerId }),
  ).container;
}

/** Retires a container and everything that pointed at it (`core.index.deleteContainer`). */
export async function deleteContainer(server: TestServer, containerId: string): Promise<void> {
  await ownerAction(server, "core.index.deleteContainer", { containerId });
}

/**
 * THE terminal index (`core.terminals.listAll`): every terminal, with the composition it lives
 * in and whether anything references that home. Here rather than duplicated per suite,
 * because three e2e files were asking the same question three ways.
 */
export async function listTerminals(server: TestServer): Promise<readonly TerminalSummary[]> {
  return TerminalsResponseSchema.parse(await ownerAction(server, "core.terminals.listAll", {}))
    .terminals;
}

/** Terminals by the container each is homed in (`core.terminals.listByContainer`). */
export async function listTerminalsByContainer(
  server: TestServer,
): Promise<readonly ContainerTerminalSummary[]> {
  return ContainerTerminalsResponseSchema.parse(
    await ownerAction(server, "core.terminals.listByContainer", {}),
  ).terminals;
}

/** Connects the one shared SDK client and optionally seeds documented resume hints. */
export async function connect(server: TestServer, options: ConnectOptions): Promise<SessionClient> {
  const client = new SessionClient({
    url: server.wsUrl,
    containerId: options.containerId,
    token: options.token,
    ...(options.reconnect !== undefined ? { reconnect: options.reconnect } : {}),
    ...(options.spectator === true ? { spectator: true } : {}),
  });
  if (options.lastEpoch !== undefined || options.lastRev !== undefined) {
    if (options.lastEpoch === undefined || options.lastRev === undefined) {
      throw new Error("lastEpoch and lastRev must be provided together");
    }
    client.epoch = options.lastEpoch;
    client.rev = options.lastRev;
  }
  try {
    await Promise.race([
      client.connect(),
      Bun.sleep(CONNECT_TIMEOUT_MS).then(() => {
        throw new Error(`terminal connect timed out after ${CONNECT_TIMEOUT_MS}ms`);
      }),
    ]);
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

/** Spawns the real agent entry and waits until the owner-visible machine record is online. */
export async function startAgent(options: StartAgentOptions): Promise<TestAgent> {
  const server = serverFromReadyUrl(options.serverUrl);
  const env = mergedEnvironment(options.env);
  env.MANIFOLD_SERVER_URL = server.httpUrl;
  env.MANIFOLD_MACHINE_TOKEN = options.machineToken;
  if (options.name === undefined) delete env.MANIFOLD_MACHINE_NAME;
  else env.MANIFOLD_MACHINE_NAME = options.name;

  const proc = spawnPiped(["bun", "packages/agent/src/main.ts"], env);
  const output = captureProcess(proc);
  const stop = createStop(proc);
  try {
    const machineId = await waitFor(
      async () => {
        if (proc.exitCode !== null) {
          throw new Error(`agent exited before readiness with code ${proc.exitCode}`);
        }
        const body = MachinesResponseSchema.parse(
          await ownerAction(server, "core.machines.list", {}),
        );
        const machine = body.machines.find(
          (candidate) =>
            candidate.online && (options.name === undefined || candidate.name === options.name),
        );
        return machine?.id;
      },
      READY_TIMEOUT_MS,
      100,
    );
    return {
      machineId,
      name: options.name,
      proc,
      output,
      stop,
    };
  } catch (error) {
    await stop();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n${formatOutput(output)}`, { cause: error });
  }
}

/**
 * TWO real instances, spawned together, for the one class of claim a single process cannot
 * make: that a share crosses a genuine trust boundary.
 *
 * The owner keys are DIFFERENT on purpose, and it is the fixture's whole point. Every other
 * multi-process helper here reuses `OWNER_KEY` because the processes are halves of one
 * instance; two instances sharing an owner key would authenticate at each other's doors
 * before any share existed, and every assertion downstream would pass for the wrong reason.
 * A guest that can already open the host's container proves nothing about sharing.
 */
export interface InstancePair {
  readonly host: TestServer;
  readonly guest: TestServer;
  stop(signal?: StopSignal): Promise<void>;
}

/** Per-side overrides; both sides otherwise take the ordinary isolated-server defaults. */
export interface SpawnInstancePairOptions {
  readonly host?: StartServerOptions;
  readonly guest?: StartServerOptions;
}

const HOST_OWNER_KEY = "11111111111111111111111111111111111111111111111111111111111111a1";
const GUEST_OWNER_KEY = "22222222222222222222222222222222222222222222222222222222222222b2";

/** Spawns a host and a guest instance concurrently; a failure on either side stops both. */
export async function spawnInstancePair(
  options: SpawnInstancePairOptions = {},
): Promise<InstancePair> {
  const started = await Promise.allSettled([
    startServer({ ownerKey: HOST_OWNER_KEY, ...options.host }),
    startServer({ ownerKey: GUEST_OWNER_KEY, ...options.guest }),
  ]);
  const live = started.filter(
    (result): result is PromiseFulfilledResult<TestServer> => result.status === "fulfilled",
  );
  if (live.length < started.length) {
    await Promise.allSettled(live.map((result) => result.value.stop()));
    const failure = started.find((result) => result.status === "rejected");
    throw failure?.status === "rejected"
      ? new Error(`instance pair failed to start: ${String(failure.reason)}`, {
          cause: failure.reason,
        })
      : new Error("instance pair failed to start");
  }
  const [host, guest] = live.map((result) => result.value) as [TestServer, TestServer];
  return {
    host,
    guest,
    async stop(signal?: StopSignal): Promise<void> {
      await Promise.allSettled([guest.stop(signal), host.stop(signal)]);
    },
  };
}

/**
 * The instance origin a server declares and a share is minted for. It is derived from the
 * ready URL and from nothing else, because `MANIFOLD_PUBLIC_URL` is the ONE door onto "how
 * this instance is addressed" — a fixture that invented a second spelling would be testing
 * a configuration the product does not have.
 */
export function instanceOrigin(server: Pick<TestServer, "httpUrl">): string {
  return new URL(server.httpUrl).origin;
}

/** Mints a share on the HOST for the guest's origin and returns the one-time raw token. */
export async function mintShare(
  host: TestServer,
  guest: Pick<TestServer, "httpUrl">,
  containerId: string,
  caps: readonly Cap[],
): Promise<ShareGrant> {
  return ShareGrantSchema.parse(
    await ownerAction(host, "core.access.mintShare", {
      node: { kind: "container", containerId },
      caps,
      origin: instanceOrigin(guest),
    }),
  );
}

/**
 * Dials the host from the GUEST and waits until the control link reports itself live. The
 * door answers as soon as the row exists, so the wait is on the socket rather than on the
 * call — a dial that returned before its `welcome` would make every downstream assertion
 * race the handshake.
 */
export async function dialShare(
  guest: TestServer,
  host: Pick<TestServer, "httpUrl">,
  token: string,
): Promise<Dial> {
  const dialed = DialSchema.parse(
    await ownerAction(guest, "core.access.dialShare", {
      origin: instanceOrigin(host),
      token,
    }),
  );
  return await waitFor(
    async () => {
      const { dials } = ShareInventorySchema.parse(
        await ownerAction(guest, "core.access.listShares", {}),
      );
      const current = dials.find((candidate) => candidate.id === dialed.id);
      return current?.status === "live" ? current : false;
    },
    READY_TIMEOUT_MS,
    50,
  );
}

/** The guest's own door: turns a dial into a host ticket THIS principal may project with. */
export async function openDial(
  server: TestServer,
  token: string,
  dialId: string,
): Promise<DialTicket> {
  const outcome = await callAction(server, token, "core.access.openDial", { dialId });
  if (!outcome.ok) throw new Error(`openDial refused: ${outcome.denial.message}`);
  return DialTicketSchema.parse(outcome.result);
}

/** Every share this instance hands out and every dial it holds, in one answer. */
export async function listShares(server: TestServer): Promise<ShareInventory> {
  return ShareInventorySchema.parse(await ownerAction(server, "core.access.listShares", {}));
}

/** Revokes a share at the host and answers how many guest identities it severed. */
export async function revokeShare(host: TestServer, shareId: string): Promise<number> {
  const { revoked } = RevokeResultSchema.parse(
    await ownerAction(host, "core.access.revokeShare", { shareId }),
  );
  return revoked;
}

/** Returns true only when the enrolled machine is owner-visible as online after reconnect. */
export async function isMachineOnline(server: TestServer, machineId: string): Promise<boolean> {
  const { machines } = MachinesResponseSchema.parse(
    await ownerAction(server, "core.machines.list", {}),
  );
  return machines.some((machine) => machine.id === machineId && machine.online);
}
