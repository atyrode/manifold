import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  HealthResponseSchema,
  InstanceServiceDescriptionSchema,
  InstanceServicesDescriptionSchema,
  JobDescriptionSchema,
  MachinesResponseSchema,
  PluginsResponseSchema,
  type ActionProtocol,
  type ActionSummary,
  type PluginRosterEntry,
} from "../packages/protocol/src/index.ts";
import {
  ActionHttpError,
  discoverActions,
  invokeAction,
  type ActionHttpOptions,
} from "../packages/sdk/src/index.ts";

export const VERIFY_LIVE_DEADLINE_MS = 5 * 60_000;
const id = z.string().min(1).max(512);
const installationSchema = z.strictObject({
  machineId: id,
  pluginId: id,
  revision: id,
  enabled: z.boolean(),
  ready: z.boolean(),
});
const serviceSchema = z.strictObject({
  serviceId: id,
  machineId: id.nullable(),
  pluginId: id.nullable(),
  enabled: z.boolean(),
  state: InstanceServiceDescriptionSchema.shape.state,
});
/** Deliberately projected: no manifests, policies, source, env, credentials or bundle bytes. */
export const LiveSnapshotSchema = z.strictObject({
  format: z.literal(1),
  origin: z.string().url(),
  build: id,
  capturedAt: z.number().int().nonnegative(),
  machines: z.array(id),
  installations: z.array(installationSchema),
  services: z.array(serviceSchema),
  plugins: z.array(
    z.strictObject({ pluginId: id, enabled: z.boolean(), readDoor: id.nullable() }),
  ),
});
export type LiveSnapshot = z.infer<typeof LiveSnapshotSchema>;
export interface LiveTarget {
  origin: string;
  token: string;
}
export interface LivePollOptions {
  /** May shorten the deadline for a caller, never extend the five-minute ceiling. */
  timeoutMs?: number;
  intervalMs?: number;
  requestTimeoutMs?: number;
  onDivergence?: (failure: LiveVerificationError) => void;
}
export class LiveVerificationError extends Error {
  constructor(
    readonly item: string,
    readonly detail: string,
  ) {
    super(`${item}: ${detail}`);
    this.name = "LiveVerificationError";
  }
}
function fail(item: string, detail: string): never {
  throw new LiveVerificationError(item, detail);
}
function targetOptions(target: LiveTarget): LiveTarget {
  let url: URL;
  try {
    url = new URL(target.origin);
  } catch {
    return fail("credentials", "VERIFY_LIVE_ORIGIN must be an origin");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
    fail(
      "credentials",
      "VERIFY_LIVE_ORIGIN must not contain credentials, a path, query or fragment",
    );
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    fail("credentials", "VERIFY_LIVE_ORIGIN requires HTTPS except on disposable loopback servers");
  if (!target.token.trim()) fail("credentials", "VERIFY_LIVE_TOKEN requires root authority");
  return { origin: url.origin, token: target.token };
}
function bounded(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0)
    fail("deadline", "timeouts must be positive and finite");
  return Math.min(Math.ceil(value), maximum);
}
class Reader {
  readonly target: LiveTarget;
  readonly end: number;
  readonly signal: AbortSignal;
  readonly requestTimeoutMs: number;
  readonly resolved = new Set<string>();
  constructor(target: LiveTarget, options: LivePollOptions) {
    this.target = targetOptions(target);
    const timeout = bounded(options.timeoutMs, VERIFY_LIVE_DEADLINE_MS, VERIFY_LIVE_DEADLINE_MS);
    this.end = performance.now() + timeout;
    this.signal = AbortSignal.timeout(timeout);
    this.requestTimeoutMs = bounded(options.requestTimeoutMs, 10_000, VERIFY_LIVE_DEADLINE_MS);
  }
  remaining(): number {
    return Math.max(0, this.end - performance.now());
  }
  options(item: string): ActionHttpOptions {
    if (!this.remaining()) fail(item, "whole verification deadline exhausted");
    return {
      ...this.target,
      signal: this.signal,
      timeoutMs: Math.max(1, Math.ceil(Math.min(this.requestTimeoutMs, this.remaining()))),
      maxResponseBytes: 16 * 1024 * 1024,
    };
  }
  async guard<T>(item: string, read: () => Promise<T>): Promise<T> {
    try {
      const result = await read();
      this.resolved.add(item);
      return result;
    } catch (error) {
      if (error instanceof LiveVerificationError) throw error;
      // Never echo a server's arbitrary error body, schema input or fetch URL with credentials.
      if (!this.remaining() || this.signal.aborted)
        fail(item, "whole verification deadline exhausted");
      if (error instanceof ActionHttpError)
        fail(item, `HTTP/action response failed (${error.status})`);
      fail(item, "request failed, timed out, or returned invalid inventory");
    }
  }
  async json<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return this.guard(path, async () => {
      const options = this.options(path);
      const response = await fetch(`${this.target.origin}${path}`, {
        headers: { authorization: `Bearer ${this.target.token}`, accept: "application/json" },
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(options.timeoutMs!)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        fail(path, `HTTP ${response.status}`);
      }
      const reader = response.body?.getReader();
      if (!reader) fail(path, "missing JSON inventory");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > options.maxResponseBytes!) fail(path, "inventory exceeds response limit");
          chunks.push(chunk.value);
        }
        return schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    });
  }
  async protocol(): Promise<ActionProtocol> {
    return this.guard("/api/protocol", () => discoverActions(this.options("/api/protocol")));
  }
  async action<T>(name: string, args: unknown, schema: z.ZodType<T>, item = name): Promise<T> {
    return this.guard(item, async () => {
      const { outcome } = await invokeAction(this.options(item), name, args);
      if (!outcome.ok) fail(item, `${name} refused (${outcome.denial.rule})`);
      return schema.parse(outcome.result);
    });
  }
  async build(): Promise<string> {
    const health = await this.json("/healthz", HealthResponseSchema);
    if (!health.build) fail("/healthz", "missing build identity");
    return health.build;
  }
}
function declared(protocol: ActionProtocol, name: string): ActionSummary {
  const action = protocol.actions.find((candidate) => candidate.name === name);
  if (!action) fail(name, "missing declared door");
  return action;
}
function inputAccepts(action: ActionSummary, args: unknown): boolean {
  try {
    return z.fromJSONSchema(action.input).safeParse(args).success;
  } catch {
    return false;
  }
}
function readOnly(action: ActionSummary): boolean {
  const localName = action.name.slice(action.name.lastIndexOf(".") + 1);
  // No effect annotation exists in ActionSummary. Require BOTH a read verb and only read
  // capabilities, not a suggestive name on a write/root/delegating door. Never invent IDs.
  return (
    /^(?:read|list|get|describe|status)(?:$|[A-Z_])/.test(localName) &&
    action.caps.length > 0 &&
    action.caps.every((cap) => cap.endsWith(":read")) &&
    (action.delegates ?? []).every((cap) => cap.endsWith(":read")) &&
    (action.requirements ?? []).every((requirement) => requirement.cap.endsWith(":read")) &&
    !action.cleanup &&
    (!action.runAccess || action.runAccess === "inspect")
  );
}
/**
 * The one read door a plugin can be probed through without arguments, or null when it declares
 * none. Not every plugin has an argument-less read (babel's doors all take a target), and a
 * deploy must not be refused for that: such a plugin is verified by its roster row instead.
 * A door that exists but takes required input is never guessed at.
 */
function readDoor(plugin: PluginRosterEntry, protocol: ActionProtocol): ActionSummary | null {
  const candidates = protocol.actions
    .filter(
      (action) =>
        action.name.startsWith(`${plugin.manifest.id}.`) &&
        plugin.actions.some(
          (rosterAction) => rosterAction.name === action.name && readOnly(rosterAction),
        ) &&
        readOnly(action) &&
        inputAccepts(action, {}),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  return candidates[0] ?? null;
}
/** Roster facts that must hold for a plugin the verifier cannot probe through a door. */
function rosterHealthy(plugin: PluginRosterEntry, item: string): void {
  if (plugin.held) fail(item, `held: ${plugin.held.reason}`);
  if (plugin.lifecycle !== undefined && plugin.lifecycle !== "ok")
    fail(item, `lifecycle ${plugin.lifecycle}`);
}
function unique<T>(rows: T[], key: (row: T) => string, item: string): void {
  if (new Set(rows.map(key)).size !== rows.length) fail(item, "duplicate inventory identity");
}
async function discovery(reader: Reader, before?: LiveSnapshot) {
  const protocol = await reader.protocol();
  const { plugins } = await reader.json("/api/plugins", PluginsResponseSchema);
  if (!plugins.length)
    fail(
      before?.plugins[0] ? `plugin ${before.plugins[0].pluginId}` : "/api/plugins",
      "missing plugin inventory",
    );
  unique(plugins, (plugin) => plugin.manifest.id, "/api/plugins");
  for (const name of [
    "engine.jobs.describe",
    "engine.services.listInstances",
    "engine.services.describeInstance",
  ])
    declared(protocol, name);
  // listInstances is authority-filtered. Prove root before trusting an empty inventory,
  // using an existing root-only read and a discovered plugin identity, never bundle export.
  const rootDoor = declared(protocol, "engine.jobs.listDeployments");
  if (!rootDoor.caps.includes("*")) fail(rootDoor.name, "root-only declaration missing");
  const rootArgs = { pluginId: plugins[0]!.manifest.id, limit: 1 };
  if (!inputAccepts(rootDoor, rootArgs))
    fail(rootDoor.name, "root read input contract unavailable");
  await reader.action(rootDoor.name, rootArgs, z.unknown(), "credentials/root inventory");
  const machineDoor = declared(protocol, "core.machines.list");
  if (!readOnly(machineDoor) || !inputAccepts(machineDoor, {}))
    fail(machineDoor.name, "machine listing read contract unavailable");
  const { machines } = await reader.action(machineDoor.name, {}, MachinesResponseSchema);
  unique(machines, (machine) => machine.id, "machines");
  return { protocol, plugins, machines };
}
async function services(reader: Reader): Promise<LiveSnapshot["services"]> {
  const inventory = await reader.action(
    "engine.services.listInstances",
    {},
    InstanceServicesDescriptionSchema,
  );
  unique(inventory.services, (service) => service.serviceId, "instance services");
  const result: LiveSnapshot["services"] = [];
  for (const row of inventory.services) {
    const description = await reader.action(
      "engine.services.describeInstance",
      { serviceId: row.serviceId },
      InstanceServiceDescriptionSchema,
      `service ${row.serviceId}`,
    );
    if (description.serviceId !== row.serviceId)
      fail(`service ${row.serviceId}`, "description identity mismatch");
    result.push({
      serviceId: row.serviceId,
      machineId: description.owner?.machineId ?? null,
      pluginId: description.configuration?.pluginId ?? null,
      enabled: description.configuration?.enabled ?? false,
      state: description.state,
    });
  }
  return result;
}
/** Snapshot only safe, explicit inventory. Missing doors are not an empty target. */
export async function snapshotLive(
  target: LiveTarget,
  options: LivePollOptions = {},
): Promise<LiveSnapshot> {
  const reader = new Reader(target, options);
  const build = await reader.build();
  const { protocol, plugins, machines } = await discovery(reader);
  const installations: LiveSnapshot["installations"] = [];
  for (const machine of machines) {
    for (const plugin of plugins) {
      if (plugin.source !== "plugin") continue;
      const args = { machineId: machine.id, pluginId: plugin.manifest.id };
      const item = `installation ${args.machineId}/${args.pluginId}`;
      const description = await reader.action(
        "engine.jobs.describe",
        args,
        JobDescriptionSchema,
        item,
      );
      if (description.machineId !== args.machineId || description.pluginId !== args.pluginId)
        fail(item, "description identity mismatch");
      if (description.installation) {
        const { revision, enabled, ready } = description.installation;
        installations.push({ ...args, revision, enabled, ready });
      }
    }
  }
  const instances = await services(reader);
  const installed = plugins
    .filter((plugin) => plugin.install !== undefined)
    .map((plugin) => ({
      pluginId: plugin.manifest.id,
      enabled: plugin.enabled,
      readDoor: readDoor(plugin, protocol)?.name ?? null,
    }));
  if ((await reader.build()) !== build) fail("/healthz", "build changed during snapshot");
  return LiveSnapshotSchema.parse({
    format: 1,
    origin: reader.target.origin,
    build,
    capturedAt: Date.now(),
    machines: machines.map((machine) => machine.id),
    installations,
    services: instances,
    plugins: installed,
  });
}
export function readLiveSnapshot(path: string): LiveSnapshot {
  try {
    const snapshot = LiveSnapshotSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    unique(snapshot.machines, (machine) => machine, "snapshot machines");
    unique(snapshot.services, (service) => service.serviceId, "snapshot services");
    unique(snapshot.plugins, (plugin) => plugin.pluginId, "snapshot plugins");
    unique(
      snapshot.installations,
      (row) => JSON.stringify([row.machineId, row.pluginId]),
      "snapshot installations",
    );
    return snapshot;
  } catch (error) {
    if (error instanceof LiveVerificationError) throw error;
    return fail("snapshot", "missing or invalid safe state snapshot");
  }
}
async function parity(reader: Reader, before: LiveSnapshot, expectedBuild: string): Promise<void> {
  const build = await reader.build();
  if (build !== expectedBuild)
    fail("/healthz build", `expected ${expectedBuild}; observed ${build}`);
  reader.resolved.add("/healthz build");
  const { protocol, plugins, machines } = await discovery(reader, before);
  const currentServices = await services(reader);
  // Native workload failures precede generic plugin checks so the first failure is actionable.
  for (const service of before.services.filter((row) => row.enabled)) {
    const item = `service ${service.serviceId} (machine ${service.machineId ?? "unknown"}, plugin ${service.pluginId ?? "unknown"})`;
    const current = currentServices.find((row) => row.serviceId === service.serviceId);
    if (!current) fail(item, "missing from instance inventory");
    if (!current.enabled) fail(item, "was enabled; observed disabled");
    if (current.state !== "ready") fail(item, `expected ready; observed ${current.state}`);
    reader.resolved.add(item);
  }
  for (const installation of before.installations.filter((row) => row.ready)) {
    const { machineId, pluginId } = installation;
    const item = `installation ${machineId}/${pluginId}`;
    if (!machines.some((row) => row.id === machineId)) fail(item, "machine missing from inventory");
    if (!plugins.some((row) => row.manifest.id === pluginId))
      fail(item, "plugin missing from roster");
    const description = await reader.action(
      "engine.jobs.describe",
      { machineId, pluginId },
      JobDescriptionSchema,
      item,
    );
    if (description.machineId !== machineId || description.pluginId !== pluginId)
      fail(item, "description identity mismatch");
    const current = description.installation;
    if (!current) fail(item, "installation missing");
    if (current.revision !== installation.revision)
      fail(
        item,
        `revision changed; expected ${installation.revision}; observed ${current.revision}`,
      );
    if (current.enabled !== installation.enabled)
      fail(
        item,
        `enablement changed; expected ${installation.enabled}; observed ${current.enabled}`,
      );
    if (!current.ready) fail(item, "expected ready; observed not ready");
  }
  for (const plugin of before.plugins) {
    if (!plugins.some((row) => row.manifest.id === plugin.pluginId && row.install !== undefined))
      fail(`plugin ${plugin.pluginId}`, "missing installed plugin from roster");
  }
  for (const plugin of plugins.filter((row) => row.install !== undefined)) {
    const door = readDoor(plugin, protocol);
    const previous = before.plugins.find((row) => row.pluginId === plugin.manifest.id);
    if (previous && previous.enabled !== plugin.enabled)
      fail(
        `plugin ${plugin.manifest.id}`,
        `enablement changed; expected ${previous.enabled}; observed ${plugin.enabled}`,
      );
    if (door === null) {
      rosterHealthy(plugin, `plugin ${plugin.manifest.id} roster`);
      reader.resolved.add(`plugin ${plugin.manifest.id}`);
      continue;
    }
    const item = `plugin ${plugin.manifest.id} read door ${door.name}`;
    let resultSchema: z.ZodType;
    try {
      resultSchema = z.fromJSONSchema(door.result);
    } catch {
      fail(item, "declared result schema is unsupported");
    }
    await reader.action(door.name, {}, resultSchema, item);
    reader.resolved.add(`plugin ${plugin.manifest.id}`);
  }
  const finalBuild = await reader.build();
  if (finalBuild !== expectedBuild)
    fail("/healthz build", `expected ${expectedBuild}; observed ${finalBuild}`);
}
/** One monotonic deadline includes discovery, all SDK calls, body reads and retry sleeps. */
export async function pollLive(
  target: LiveTarget,
  before: LiveSnapshot,
  expectedBuild: string,
  options: LivePollOptions = {},
): Promise<void> {
  const reader = new Reader(target, options);
  if (before.origin !== reader.target.origin)
    fail("snapshot", "target origin does not match snapshot");
  if (!expectedBuild.trim()) fail("/healthz build", "expected build is required");
  const interval = bounded(options.intervalMs, 2_000, VERIFY_LIVE_DEADLINE_MS);
  let last: LiveVerificationError | undefined;
  while (reader.remaining() > 0) {
    reader.resolved.clear();
    try {
      await parity(reader, before, expectedBuild);
      if (!reader.remaining()) fail("deadline", "whole verification deadline exhausted");
      return;
    } catch (error) {
      if (!(error instanceof LiveVerificationError)) throw error;
      // A partial last pass must not hide the latest proved divergence behind a timer
      // expiring on an earlier discovery request. Retire that diagnosis once it passes.
      if (
        error.detail === "whole verification deadline exhausted" &&
        last &&
        !reader.resolved.has(last.item)
      )
        break;
      if (last?.message !== error.message) options.onDivergence?.(error);
      last = error;
    }
    if (reader.remaining()) await Bun.sleep(Math.min(interval, reader.remaining()));
  }
  throw last ?? new LiveVerificationError("deadline", "whole verification deadline exhausted");
}
function safeText(value: string, token: string): string {
  return value.replaceAll(token || "\u0000", "[redacted]").replace(/\p{Cc}/gu, " ");
}
function report(message: string, token: string, failed: boolean): void {
  const safe = safeText(message, token);
  // Prefix prevents payloads from becoming workflow commands; HTML text escapes summary markup.
  console[failed ? "error" : "log"](`verify-live: ${safe}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const escaped = safe.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `<pre>${escaped}</pre>\n`);
  }
}
if (import.meta.main) {
  const target = {
    origin: process.env.VERIFY_LIVE_ORIGIN ?? "",
    token: process.env.VERIFY_LIVE_TOKEN ?? "",
  };
  try {
    const [command, path, expectedBuild, ...extra] = process.argv.slice(2);
    if (
      !path ||
      extra.length ||
      (command !== "snapshot" && command !== "verify") ||
      (command === "snapshot" ? expectedBuild !== undefined : !expectedBuild)
    )
      fail("usage", "bun scripts/verify-live.ts snapshot PATH | verify PATH EXPECTED_BUILD");
    if (command === "snapshot") {
      const snapshot = await snapshotLive(target);
      writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      report(
        `snapshot build ${snapshot.build}: ${snapshot.installations.length} installations, ${snapshot.services.length} services, ${snapshot.plugins.length} installed plugins`,
        target.token,
        false,
      );
    } else {
      const before = readLiveSnapshot(path);
      await pollLive(target, before, expectedBuild!, {
        onDivergence: (failure) => report(failure.message, target.token, true),
      });
      report(
        `verified build ${expectedBuild}: live native state and installed read doors are ready`,
        target.token,
        false,
      );
    }
  } catch (error) {
    report(
      error instanceof LiveVerificationError
        ? error.message
        : "verification failed (local I/O or invalid response)",
      target.token,
      true,
    );
    process.exitCode = 1;
  }
}
