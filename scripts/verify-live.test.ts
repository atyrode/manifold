import { expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  HealthResponseSchema,
  InstanceServiceDescriptionSchema,
  InstanceServicesDescriptionSchema,
  JobDeploymentListArgsSchema,
  JobDescriptionSchema,
  MachinesResponseSchema,
  PROTOCOL_VERSION,
  type ActionSummary,
  type InstanceServiceDescription,
  type PluginRosterEntry,
} from "../packages/protocol/src/index.ts";
import {
  LiveVerificationError,
  pollLive,
  readLiveSnapshot,
  snapshotLive,
  type LiveTarget,
} from "./verify-live.ts";

const machineId = "fixture-owner";
const pluginId = "example.live";
const serviceId = "example.live.broker";
const hash = "a".repeat(64);
function action(
  name: string,
  caps: ActionSummary["caps"],
  input: z.ZodType,
  result: z.ZodType,
): ActionSummary {
  return {
    name,
    title: name,
    caps,
    scope: "workspace",
    input: z.toJSONSchema(input),
    result: z.toJSONSchema(result),
  };
}
/** A loopback HTTP action plane, not an invocation mock. Mutations below model a receiver switch. */
export function liveFixture(beforeRequest?: () => void) {
  const state = {
    build: "1.0.0",
    revision: "deployment-before",
    installationReady: true,
    installationEnabled: true,
    serviceState: "ready" as InstanceServiceDescription["state"],
    serviceEnabled: true,
    serviceReason: null as string | null,
    serviceConnected: true,
    servicePluginId: pluginId,
    serviceMachineId: machineId,
    pluginPresent: true,
    readDoorPresent: true,
    readDoorCaps: [`${pluginId}:read`] as ActionSummary["caps"],
    readDoorRequiredInput: false,
    pluginEnabled: true,
    pluginHeld: null as PluginRosterEntry["held"] | null,
    pluginLifecycle: "ok" as NonNullable<PluginRosterEntry["lifecycle"]>,
    servicesMissing: false,
    machineDoorPresent: true,
    invalidInventory: false,
    authorized: true,
    root: true,
    stallPath: "",
    recoverAfterDescriptions: 0,
    descriptions: 0,
    readFailure: false,
    malformedReadResult: false,
    writes: 0,
  };
  const owner = { machineId, name: "Fixture owner", online: true };
  const service = (): InstanceServiceDescription => ({
    serviceId,
    owner: { ...owner, machineId: state.serviceMachineId },
    defaultOwner: owner,
    configuration: {
      revision: "service-before",
      pluginId: state.servicePluginId,
      enabled: state.serviceEnabled,
      policySha256: hash,
    },
    connected: state.serviceConnected,
    state: state.serviceState,
    reason: state.serviceState === "ready" ? null : (state.serviceReason ?? "cancelled"),
  });
  const readAction = () =>
    action(
      `${pluginId}.read`,
      state.readDoorCaps,
      state.readDoorRequiredInput ? z.strictObject({ resourceId: z.string() }) : z.strictObject({}),
      z.strictObject({ ready: z.boolean() }),
    );
  const declarations = () => [
    action(
      "engine.jobs.describe",
      [],
      z.strictObject({ machineId: z.string(), pluginId: z.string() }),
      JobDescriptionSchema,
    ),
    action("engine.jobs.listDeployments", ["*"], JobDeploymentListArgsSchema, z.strictObject({})),
    action(
      "engine.services.listInstances",
      [],
      z.strictObject({}),
      InstanceServicesDescriptionSchema,
    ),
    action(
      "engine.services.describeInstance",
      [],
      z.strictObject({ serviceId: z.string() }),
      InstanceServiceDescriptionSchema,
    ),
    // A plugin's similarly shaped result is not the authoritative enrolled-machine inventory.
    action(
      "example.inventory.list",
      ["containers:read"],
      z.strictObject({}),
      MachinesResponseSchema,
    ),
    ...(state.machineDoorPresent
      ? [
          action(
            "core.machines.list",
            ["containers:read"],
            z.strictObject({}),
            MachinesResponseSchema,
          ),
        ]
      : []),
    action(`${pluginId}.erase`, [`${pluginId}:write`], z.strictObject({}), z.strictObject({})),
    ...(state.readDoorPresent ? [readAction()] : []),
  ];
  const plugin = (): PluginRosterEntry => ({
    manifest: {
      id: pluginId,
      version: "1.0.0",
      title: "Live fixture",
      description: "Native parity proof",
      capabilities: [`${pluginId}:read`, `${pluginId}:write`],
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
    },
    enabled: state.pluginEnabled,
    source: "plugin",
    lifecycle: state.pluginLifecycle,
    ...(state.pluginHeld ? { held: state.pluginHeld } : {}),
    actions: declarations().filter((door) => door.name.startsWith(`${pluginId}.`)),
    install: {
      sha256: hash,
      source: "https://secret.invalid/private-source",
      grantedCaps: [],
      installedBy: "owner",
      installedAt: 1,
    },
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      beforeRequest?.();
      const path = new URL(request.url).pathname;
      if (state.stallPath === path) return new Promise<Response>(() => {});
      if (!state.authorized || request.headers.get("authorization") !== "Bearer fixture-root")
        return Response.json(
          { error: { code: "unauthorized", message: "must not echo fixture-root" } },
          { status: 401 },
        );
      if (path === "/healthz")
        return Response.json(
          HealthResponseSchema.parse({
            ok: true,
            version: "1.0.0",
            protocolVersion: PROTOCOL_VERSION,
            build: state.build,
          }),
        );
      if (path === "/api/protocol")
        return Response.json({ protocolVersion: PROTOCOL_VERSION, actions: declarations() });
      if (path === "/api/plugins")
        return Response.json({ plugins: state.pluginPresent ? [plugin()] : [] });
      const door = decodeURIComponent(path.slice("/api/actions/".length));
      if (!path.startsWith("/api/actions/") || request.method !== "POST")
        return new Response(null, { status: 404 });
      const definition = declarations().find((candidate) => candidate.name === door);
      const args: unknown = await request.json();
      if (!definition)
        return Response.json({
          ok: false,
          denial: { rule: "unknown_action", message: "unknown door" },
        });
      if (!z.fromJSONSchema(definition.input).safeParse(args).success)
        return Response.json({
          ok: false,
          denial: { rule: "invalid_args", message: "invalid arguments" },
        });
      if (door === "engine.jobs.listDeployments" && !state.root)
        return Response.json({
          ok: false,
          denial: { rule: "forbidden", message: "root required" },
        });
      let result: unknown;
      switch (door) {
        case "engine.jobs.listDeployments":
          result = {};
          break;
        case "example.inventory.list":
          result = { machines: [] };
          break;
        case "core.machines.list":
          result = state.invalidInventory
            ? {}
            : { machines: [{ id: machineId, name: "Fixture owner", online: true }] };
          break;
        case "engine.services.listInstances":
          result = { defaultOwner: owner, services: state.servicesMissing ? [] : [service()] };
          break;
        case "engine.services.describeInstance":
          state.descriptions++;
          if (
            state.recoverAfterDescriptions &&
            state.descriptions >= state.recoverAfterDescriptions
          )
            state.serviceState = "ready";
          result = service();
          break;
        case "engine.jobs.describe":
          result = {
            machineId,
            pluginId,
            admissionPublicKey: "-----BEGIN PUBLIC KEY-----fixture",
            connected: true,
            platforms: [],
            installation: {
              revision: state.revision,
              artifactSha256: hash,
              enabled: state.installationEnabled,
              ready: state.installationReady,
              purgeRequested: false,
            },
            retainedInstallations: [],
            consents: [],
          };
          break;
        case `${pluginId}.read`:
          if (state.readFailure || !state.pluginEnabled)
            return Response.json({
              ok: false,
              denial: { rule: "plugin_disabled", message: "read unavailable" },
            });
          result = { ready: state.malformedReadResult ? "not-a-boolean" : true };
          break;
        default:
          state.writes++;
          result = {};
      }
      return Response.json({ ok: true, result }, { headers: { "x-manifold-trace-id": "1" } });
    },
  });
  return {
    state,
    server,
    target: { origin: server.url.origin, token: "fixture-root" },
    close: () => server.stop(true),
  };
}
const shortPoll = { timeoutMs: 150, intervalMs: 10, requestTimeoutMs: 50 };
async function divergence(
  fixture: { target: LiveTarget; state: { build: string } },
  mutate: () => void,
) {
  const before = await snapshotLive(fixture.target);
  mutate();
  fixture.state.build = "1.1.0";
  try {
    await pollLive(fixture.target, before, "1.1.0", shortPoll);
    throw new Error("unhealthy candidate was accepted");
  } catch (error) {
    expect(error).toBeInstanceOf(LiveVerificationError);
    return error as LiveVerificationError;
  }
}

test("CLI snapshots only safe inventory, reads it back, and verifies the switched build", async () => {
  const fixture = liveFixture();
  const root = mkdtempSync(join(tmpdir(), "verify-live-"));
  const path = join(root, "snapshot.json");
  const summary = join(root, "summary");
  const outputPath = join(root, "outputs");
  const run = async (args: string[], bootstrapGate = false) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "verify-live.ts"), ...args], {
      env: {
        ...process.env,
        VERIFY_LIVE_ORIGIN: fixture.target.origin,
        VERIFY_LIVE_TOKEN: fixture.target.token,
        VERIFY_LIVE_BOOTSTRAP_GATE: String(bootstrapGate),
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summary,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, output: stdout + stderr };
  };
  try {
    expect((await run(["snapshot", path])).code).toBe(0);
    const before = readLiveSnapshot(path);
    expect(before.build).toBe("1.0.0");
    expect(before.installations).toEqual([
      { machineId, pluginId, revision: "deployment-before", enabled: true, ready: true },
    ]);
    expect(readFileSync(path, "utf8")).not.toMatch(
      /fixture-root|private-source|admissionPublicKey|policySha256/,
    );
    fixture.state.build = "1.1.0<em>\n::error::untrusted";
    expect((await run(["verify", path, fixture.state.build])).code).toBe(0);
    expect(readFileSync(summary, "utf8")).toContain("&lt;em&gt;");
    expect(readFileSync(summary, "utf8")).not.toContain("<em>");
    fixture.state.readDoorPresent = false;
    fixture.state.pluginHeld = { reason: "repack_required", minimum: 2 };
    fixture.state.serviceState = "unavailable";
    fixture.state.serviceReason = "plugin_held";
    const maintenance = await run(["verify", path, fixture.state.build], true);
    expect(maintenance.code).toBe(0);
    expect(maintenance.output).not.toContain(fixture.target.token);
    expect(readFileSync(outputPath, "utf8")).toMatch(/maintenance_required=true\n$/);
    fixture.state.pluginHeld = null;
    fixture.state.readDoorPresent = true;
    fixture.state.serviceState = "ready";
    expect((await run(["verify", path, fixture.state.build])).code).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toMatch(/maintenance_required=false\n$/);
    expect(fixture.state.writes).toBe(0);
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-ready enabled service fails with its exact identity ahead of generic plugin checks", async () => {
  const fixture = liveFixture();
  try {
    const error = await divergence(fixture, () => {
      fixture.state.serviceState = "unavailable";
      fixture.state.readDoorPresent = false;
    });
    expect(error.item).toContain(serviceId);
    expect(error.item).toContain(machineId);
    expect(error.detail).toContain("unavailable");
  } finally {
    await fixture.close();
  }
});

test("a ready installation cannot change revision or silently lose enablement", async () => {
  const fixture = liveFixture();
  try {
    const before = await snapshotLive(fixture.target);
    fixture.state.revision = "deployment-rekeyed";
    await expect(pollLive(fixture.target, before, fixture.state.build, shortPoll)).rejects.toThrow(
      /installation fixture-owner\/example.live.*revision changed/,
    );
    fixture.state.revision = "deployment-before";
    fixture.state.installationEnabled = false;
    await expect(pollLive(fixture.target, before, fixture.state.build, shortPoll)).rejects.toThrow(
      /installation fixture-owner\/example.live.*enablement changed/,
    );
  } finally {
    await fixture.close();
  }
});

test("poll waits through service recovery and checks ready before returning", async () => {
  const fixture = liveFixture();
  try {
    const before = await snapshotLive(fixture.target);
    fixture.state.serviceState = "starting";
    fixture.state.recoverAfterDescriptions = fixture.state.descriptions + 2;
    await pollLive(fixture.target, before, fixture.state.build, { ...shortPoll, timeoutMs: 1_000 });
    expect(fixture.state).toMatchObject({ serviceState: "ready" });
    expect(fixture.state.writes).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("a disappeared or disabled enabled service never becomes an empty successful inventory", async () => {
  const fixture = liveFixture();
  try {
    const before = await snapshotLive(fixture.target);
    fixture.state.servicesMissing = true;
    await expect(pollLive(fixture.target, before, fixture.state.build, shortPoll)).rejects.toThrow(
      new RegExp(`${serviceId}.*missing`),
    );
    fixture.state.servicesMissing = false;
    fixture.state.serviceEnabled = false;
    await expect(pollLive(fixture.target, before, fixture.state.build, shortPoll)).rejects.toThrow(
      new RegExp(`${serviceId}.*disabled`),
    );
  } finally {
    await fixture.close();
  }
});

test("a plugin without an argument-less read door is verified by its roster, never a guessed door", async () => {
  const fixture = liveFixture();
  try {
    fixture.state.readDoorPresent = false;
    const before = await snapshotLive(fixture.target);
    expect(before.plugins).toEqual([{ pluginId, enabled: true, readDoor: null }]);
    await pollLive(fixture.target, before, fixture.state.build, shortPoll);
    fixture.state.pluginHeld = { reason: "repack_required", minimum: 2 };
    await expect(pollLive(fixture.target, before, fixture.state.build, shortPoll)).rejects.toThrow(
      /plugin example.live roster: held: repack_required/,
    );
    fixture.state.pluginHeld = null;
    fixture.state.pluginLifecycle = "isolate_crashed";
    await expect(pollLive(fixture.target, before, fixture.state.build, shortPoll)).rejects.toThrow(
      /plugin example.live roster: lifecycle isolate_crashed/,
    );
    fixture.state.pluginLifecycle = "ok";
    fixture.state.pluginEnabled = false;
    await expect(pollLive(fixture.target, before, fixture.state.build, shortPoll)).rejects.toThrow(
      /plugin example.live: enablement changed; expected true; observed false/,
    );
    fixture.state.pluginEnabled = true;
    fixture.state.pluginPresent = false;
    await expect(pollLive(fixture.target, before, fixture.state.build, shortPoll)).rejects.toThrow(
      /plugin example.live.*missing plugin inventory/,
    );
    expect(fixture.state.writes).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("maintenance defers only the repack hold and ends only after ordinary health returns", async () => {
  const fixture = liveFixture();
  try {
    const before = await snapshotLive(fixture.target);
    fixture.state.build = "1.1.0";
    fixture.state.readDoorPresent = false;
    fixture.state.pluginHeld = { reason: "repack_required", minimum: 2 };
    fixture.state.serviceState = "unavailable";
    fixture.state.serviceReason = "plugin_held";
    await expect(pollLive(fixture.target, before, "1.1.0", shortPoll)).rejects.toThrow(
      LiveVerificationError,
    );
    expect(
      await pollLive(fixture.target, before, "1.1.0", { ...shortPoll, bootstrapGate: true }),
    ).toEqual({
      heldPlugins: [{ pluginId, minimum: 2 }],
      deferredServices: [serviceId],
    });
    fixture.state.pluginHeld = null;
    fixture.state.readDoorPresent = true;
    await expect(pollLive(fixture.target, before, "1.1.0", shortPoll)).rejects.toThrow(
      LiveVerificationError,
    );
    fixture.state.serviceState = "ready";
    expect(await pollLive(fixture.target, before, "1.1.0", shortPoll)).toEqual({
      heldPlugins: [],
      deferredServices: [],
    });
  } finally {
    await fixture.close();
  }
});

test("maintenance cannot excuse unrelated failures or changed native identities", async () => {
  const fixture = liveFixture();
  const held = {
    build: "1.1.0",
    readDoorPresent: false,
    pluginHeld: { reason: "repack_required", minimum: 2 },
    pluginLifecycle: "ok" as const,
    pluginEnabled: true,
    serviceState: "unavailable" as const,
    serviceReason: "plugin_held",
    serviceEnabled: true,
    serviceConnected: true,
    servicePluginId: pluginId,
    serviceMachineId: machineId,
    installationReady: true,
    installationEnabled: true,
    revision: "deployment-before",
  };
  try {
    const before = await snapshotLive(fixture.target);
    const failures: Partial<typeof fixture.state>[] = [
      { pluginHeld: { reason: "dependency_missing", by: "another.plugin" } },
      { pluginLifecycle: "isolate_crashed" },
      { pluginEnabled: false },
      { serviceReason: "credential_revoked_or_expired" },
      { serviceState: "stopping", serviceReason: "instance_service_stopping" },
      { serviceEnabled: false },
      { serviceConnected: false },
      { servicePluginId: "another.plugin" },
      { serviceMachineId: "another-machine" },
      { installationReady: false },
      { installationEnabled: false },
      { revision: "replacement-installation" },
    ];
    for (const failure of failures) {
      Object.assign(fixture.state, held, failure);
      await expect(
        pollLive(fixture.target, before, "1.1.0", { ...shortPoll, bootstrapGate: true }),
      ).rejects.toBeInstanceOf(LiveVerificationError);
    }
  } finally {
    await fixture.close();
  }
});

test("an installed plugin's successful HTTP reply must satisfy its declared read result", async () => {
  const fixture = liveFixture();
  try {
    const before = await snapshotLive(fixture.target);
    fixture.state.malformedReadResult = true;
    await expect(pollLive(fixture.target, before, fixture.state.build, shortPoll)).rejects.toThrow(
      /plugin example.live read door example.live.read.*invalid inventory/,
    );
  } finally {
    await fixture.close();
  }
});

test("read-looking writes, required resource IDs, and disabled installed plugins cannot bypass probing", async () => {
  const fixture = liveFixture();
  try {
    fixture.state.readDoorCaps = [`${pluginId}:write`];
    expect((await snapshotLive(fixture.target)).plugins[0]?.readDoor).toBeNull();
    fixture.state.readDoorCaps = [`${pluginId}:read`];
    fixture.state.readDoorRequiredInput = true;
    expect((await snapshotLive(fixture.target)).plugins[0]?.readDoor).toBeNull();
    fixture.state.readDoorRequiredInput = false;
    fixture.state.pluginEnabled = false;
    const before = await snapshotLive(fixture.target);
    await expect(pollLive(fixture.target, before, fixture.state.build, shortPoll)).rejects.toThrow(
      /plugin example.live read door example.live.read.*plugin_disabled/,
    );
    expect(fixture.state.writes).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("credentials and malformed or authority-filtered inventory fail closed", async () => {
  const fixture = liveFixture();
  try {
    await expect(snapshotLive({ ...fixture.target, token: "" })).rejects.toThrow(
      /VERIFY_LIVE_TOKEN/,
    );
    fixture.state.authorized = false;
    await expect(snapshotLive(fixture.target)).rejects.toThrow(/HTTP 401/);
    fixture.state.authorized = true;
    fixture.state.root = false;
    await expect(snapshotLive(fixture.target)).rejects.toThrow(
      /credentials\/root inventory.*forbidden/,
    );
    fixture.state.root = true;
    fixture.state.invalidInventory = true;
    await expect(snapshotLive(fixture.target)).rejects.toThrow(
      /core.machines.list.*invalid inventory/,
    );
  } finally {
    await fixture.close();
  }
});

test("an unrelated plugin cannot substitute an empty enrolled-machine inventory", async () => {
  const fixture = liveFixture();
  try {
    const before = await snapshotLive(fixture.target);
    expect(before.installations).toEqual([
      { machineId, pluginId, revision: "deployment-before", enabled: true, ready: true },
    ]);
    fixture.state.machineDoorPresent = false;
    await expect(snapshotLive(fixture.target)).rejects.toThrow(
      /core.machines.list.*missing declared door/,
    );
  } finally {
    await fixture.close();
  }
});

test("one whole deadline bounds hanging HTTP requests, not just time between polls", async () => {
  const fixture = liveFixture();
  try {
    const before = await snapshotLive(fixture.target);
    fixture.state.stallPath = "/api/actions/engine.services.describeInstance";
    const start = performance.now();
    await expect(
      pollLive(fixture.target, before, fixture.state.build, {
        timeoutMs: 100,
        requestTimeoutMs: 60_000,
        intervalMs: 1,
      }),
    ).rejects.toThrow(new RegExp(`${serviceId}.*deadline exhausted`));
    expect(performance.now() - start).toBeLessThan(1_000);
  } finally {
    await fixture.close();
  }
});

test("snapshot reader refuses artifacts with extra sensitive payloads", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-live-unsafe-"));
  try {
    const path = join(root, "snapshot.json");
    writeFileSync(
      path,
      JSON.stringify({
        format: 1,
        origin: "https://example.invalid",
        build: "1.0.0",
        capturedAt: 1,
        machines: [],
        installations: [],
        services: [],
        plugins: [],
        env: { secret: "private" },
      }),
    );
    expect(() => readLiveSnapshot(path)).toThrow(/invalid safe state snapshot/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a resolved startup build mismatch cannot hide the current service divergence", async () => {
  const fixture = liveFixture();
  try {
    const before = await snapshotLive(fixture.target);
    fixture.state.serviceState = "unavailable";
    await expect(
      pollLive(fixture.target, before, "1.1.0", {
        ...shortPoll,
        onDivergence: () => {
          fixture.state.build = "1.1.0";
        },
      }),
    ).rejects.toThrow(new RegExp(`${serviceId}.*unavailable`));
  } finally {
    await fixture.close();
  }
});

test("failed parity triggers the workflow rollback shell through the actual guarded receiver", async () => {
  const root = mkdtempSync(join(tmpdir(), "verify-live-rollback-"));
  const marker = join(root, "restored");
  const fixture = liveFixture(() => {
    if (existsSync(marker)) {
      fixture.state.build = "1.0.0";
      fixture.state.serviceState = "ready";
    }
  });
  try {
    const before = await snapshotLive(fixture.target);
    writeFileSync(join(root, "verify-live.json"), JSON.stringify(before));
    fixture.state.build = "1.1.0";
    fixture.state.serviceState = "unavailable";
    await expect(pollLive(fixture.target, before, fixture.state.build, shortPoll)).rejects.toThrow(
      new RegExp(`${serviceId}.*unavailable`),
    );

    const workflow = z
      .object({
        jobs: z.record(
          z.string(),
          z.object({
            steps: z
              .array(z.object({ name: z.string().optional(), run: z.string().optional() }))
              .optional(),
          }),
        ),
      })
      .parse(
        Bun.YAML.parse(
          readFileSync(join(import.meta.dir, "../.github/workflows/deploy-dev.yml"), "utf8"),
        ),
      );
    const rollback = workflow.jobs["verify-live"]?.steps?.find(
      (step) => step.name === "Restore the previous revision through the guarded receiver",
    );
    if (!rollback?.run) throw new Error("Live verification has no automatic rollback step");
    const bin = join(root, "bin");
    const receiver = join(root, "receiver");
    mkdirSync(bin);
    mkdirSync(receiver);
    for (const file of ["receiver.sh", "common.sh"])
      cpSync(join(import.meta.dir, "../infra/previews", file), join(receiver, file));
    writeFileSync(join(root, "env"), "PREVIEW_DOMAIN=fixture.invalid\n");
    writeFileSync(
      join(bin, "ssh"),
      `#!/usr/bin/env bash
set -euo pipefail
export SSH_ORIGINAL_COMMAND="\${!#}"
exec bash "$FIXTURE_RECEIVER/receiver.sh"
`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(bin, "bun"),
      `#!/usr/bin/env bash
exec "$FIXTURE_BUN" "$@"
`,
      { mode: 0o700 },
    );
    // Provider boundary only: the real receiver must deliver the exact backward-CAS args.
    // An unguarded/incorrect request fails without changing the live application.
    writeFileSync(
      join(receiver, "deploy-dev.sh"),
      `#!/usr/bin/env bash
set -euo pipefail
[[ $# == 3 && $1 == "$PREVIOUS_SHA" && $2 == --rollback-from && $3 == "$SHA" ]]
printf '%s\\n' "$1" > "$FIXTURE_RESTORED"
`,
      { mode: 0o700 },
    );
    const previousSha = "a".repeat(40);
    const child = Bun.spawn(["bash", "-e", "-o", "pipefail", "-c", rollback.run], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SHA: "b".repeat(40),
        PREVIOUS_SHA: previousSha,
        PREVIOUS_BUILD: "1.0.0",
        ROLLBACK: "false",
        DEV_DEPLOY_SSH_KEY: "fixture-only-key",
        DEV_DEPLOY_USER: "fixture",
        DEV_DEPLOY_HOST: "fixture.invalid",
        VERIFY_LIVE_ORIGIN: fixture.target.origin,
        VERIFY_LIVE_TOKEN: fixture.target.token,
        GITHUB_STEP_SUMMARY: join(root, "summary"),
        RUNNER_TEMP: root,
        PREVIEW_HOME: root,
        FIXTURE_RECEIVER: receiver,
        FIXTURE_BUN: process.execPath,
        FIXTURE_RESTORED: marker,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`Rollback shell failed (${code}): ${stdout}${stderr}`);
    expect(readFileSync(marker, "utf8").trim()).toBe(previousSha);
    await pollLive(fixture.target, before, before.build, shortPoll);
    expect(fixture.state).toMatchObject({ serviceState: "ready", build: before.build });
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
