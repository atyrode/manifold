import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  GrantSchema,
  InstanceServiceDescriptionSchema,
  JobDescriptionSchema,
  JobEventSchema,
  MachineHalfSchema,
  PluginBundleSchema,
  PublicJobSchema,
  formatManifoldUri,
  type Cap,
  type MachineHalf,
  type ManifoldRef,
  type ServicePolicy,
} from "@manifold/protocol";
import {
  callAction,
  enrollMachine,
  mintToken,
  ownerAction,
  startAgent,
  startServer,
  waitFor,
  type TestAgent,
  type TestServer,
} from "../src/index.ts";
import { e2eFailure, stopProcesses } from "./helpers.ts";

const REPO = resolve(import.meta.dir, "../../..");
const PROVIDER = "fixture.instance-provider";
const CONSUMER = "fixture.instance-consumer";
const SERVICE = `${PROVIDER}.broker`;
const OPERATION = `${CONSUMER}.read`;
const SERVE = `${PROVIDER}.serve`;
const LOCATION = `${PROVIDER}.state`;
const limits = {
  timeoutMs: 30000,
  memoryBytes: 128 * 1024 * 1024,
  processes: 32,
  outputBytes: 4096,
};
const required = [
  "MANIFOLD_TEST_BWRAP",
  "MANIFOLD_TEST_STATIC_BUSYBOX",
  "MANIFOLD_TEST_CGROUP",
  "MANIFOLD_TEST_INSTANCE_SERVICE",
];
const realBackend = process.platform === "linux" && required.every((name) => process.env[name]);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// This proof installs real immutable bundles and uses only public doors and authenticated
// machine transports. Its two owners have disjoint state and delegated workload trees.
test.skipIf(!realBackend)(
  "instance services survive hub and transport replacement and route only current cross-owner authority",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "manifold-instance-e2e-"));
    let server: TestServer | undefined;
    const agents: TestAgent[] = [];
    const owners: Bun.Subprocess[] = [];
    try {
      server = await startServer({
        dataDir: join(root, "hub"),
        env: { MANIFOLD_PLUGIN_DEV_PATHS: "1" },
      });
      const hub = () => server!;
      const describe = async (machineId: string, pluginId: string) =>
        JobDescriptionSchema.parse(
          await ownerAction(hub(), "engine.jobs.describe", { machineId, pluginId }),
        );
      const instance = async () =>
        InstanceServiceDescriptionSchema.parse(
          await ownerAction(hub(), "engine.services.describeInstance", { serviceId: SERVICE }),
        );
      const bundle = async (
        pluginId: string,
        bytes: Buffer,
        operation: MachineHalf["operations"],
        locations: MachineHalf["locations"] = {},
      ) => {
        const artifactSha256 = sha256(bytes);
        const machine = MachineHalfSchema.parse({
          requiresResourceBindings: true,
          artifacts: {
            [`linux-${process.arch}`]: {
              bundleFile: "worker",
              sha256: artifactSha256,
              entrySha256: artifactSha256,
              format: "raw",
              entry: ["fixture"],
              maxBytes: bytes.length,
              maxExpandedBytes: bytes.length,
              maxMembers: 1,
            },
          },
          locations,
          operations: operation,
        });
        const payload = Buffer.from(
          JSON.stringify(
            PluginBundleSchema.parse({
              format: 1,
              manifest: {
                id: pluginId,
                version: "1.0.0",
                title: "Instance service proof",
                description: "Private offline native proof",
                capabilities: [],
                contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
                entry: {},
                machine,
              },
              files: { worker: bytes.toString("base64") },
            }),
          ),
        );
        const path = join(root, `${pluginId}.json`);
        writeFileSync(path, payload, { mode: 0o600 });
        await ownerAction(hub(), "engine.plugins.install", {
          source: path,
          sha256: sha256(payload),
          hardened: true,
        });
        return { pluginId, machine, artifactSha256 };
      };
      const provider = await bundle(
        PROVIDER,
        readFileSync(process.env.MANIFOLD_TEST_INSTANCE_SERVICE!),
        {
          [SERVE]: {
            argv: [],
            input: {},
            runtimeTools: [],
            providesService: true,
            environment: { FIXED_SERVICE_SETTING: "reviewed" },
            inputFiles: { serviceBearer: { generated: "service-bearer" } },
            locations: [{ locationId: LOCATION, access: "write" }],
            outputs: [],
            network: "host",
            limits,
            stdin: false,
          },
        },
        {
          [LOCATION]: {
            anchor: "state",
            managed: true,
            components: ["service"],
            revision: "1",
            kind: "directory",
            guestPath: "/home/job/service-state",
          },
        },
      );
      const consumer = await bundle(
        CONSUMER,
        Buffer.from(
          [
            "#!/bin/busybox sh",
            "set -eu",
            "config=$(/bin/busybox cat /inputs/proxy)",
            'url=${config#*\'"url":"\'}',
            "url=${url%%'\"'*}",
            'bearer=${config#*\'"bearer":"\'}',
            "bearer=${bearer%%'\"'*}",
            '/bin/busybox wget -qO- --header "Authorization: Bearer $bearer" "$url/snapshot"',
            "",
          ].join("\n"),
        ),
        {
          [OPERATION]: {
            argv: [],
            input: {},
            runtimeTools: ["busybox"],
            inputFiles: {
              proxy: {
                literal: '{"url":"","bearer":""}',
                jsonValues: [
                  { path: ["url"], serviceId: SERVICE, value: "url" },
                  { path: ["bearer"], serviceId: SERVICE, value: "bearer" },
                ],
              },
            },
            services: [{ serviceId: SERVICE, revision: "1", operationIds: ["snapshot"] }],
            locations: [],
            outputs: [],
            network: "host",
            limits,
            stdin: false,
          },
        },
      );
      const provision = async (name: string, pluginId: string) => {
        const enrollment = await enrollMachine(hub(), name);
        const machineId = enrollment.machineId;
        const control = join(root, name);
        const state = join(control, "state");
        mkdirSync(state, { recursive: true, mode: 0o700 });
        const group = join(realpathSync(process.env.MANIFOLD_TEST_CGROUP!), name);
        mkdirSync(group);
        writeFileSync(join(group, "cgroup.subtree_control"), "+cpu +memory +pids");
        const { admissionPublicKey } = await describe(machineId, pluginId);
        const config = join(control, "owner.json");
        const socket = join(control, "owner.sock");
        writeFileSync(
          config,
          JSON.stringify({
            machineId,
            admissionPublicKey,
            stateDirectory: state,
            delegatedCgroup: group,
            bubblewrap: realpathSync(process.env.MANIFOLD_TEST_BWRAP!),
            protectedDirectories: [control],
            anchors: {},
            artifactOrigins: ["https://example.invalid"],
            runtimeTools: {
              busybox: [
                {
                  source: realpathSync(process.env.MANIFOLD_TEST_STATIC_BUSYBOX!),
                  target: "/bin/busybox",
                  kind: "file",
                },
              ],
            },
          }),
          { mode: 0o600 },
        );
        const owner = Bun.spawn(
          [process.execPath, "packages/agent/src/main.ts", "--terminal-host"],
          {
            cwd: REPO,
            env: {
              ...process.env,
              MANIFOLD_JOB_OWNER_SOCKET: socket,
              MANIFOLD_JOB_OWNER_CONFIG: config,
              MANIFOLD_TERMINAL_HOST_SOCKET: `${socket}.terminal`,
            },
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          },
        );
        owners.push(owner);
        await waitFor(
          () => {
            if (owner.exitCode !== null)
              throw new Error(`native service owner exited ${owner.exitCode}`);
            return existsSync(socket) && existsSync(`${socket}.terminal`);
          },
          20000,
          20,
        );
        const agent = await startAgent({
          serverUrl: hub().url,
          machineToken: enrollment.machineToken,
          name,
          env: { MANIFOLD_JOB_OWNER_SOCKET: socket },
          existingHost: { process: owner, socketPath: `${socket}.terminal` },
        });
        agents.push(agent);
        return { machineId, agent };
      };
      const source = await provision("source", PROVIDER);
      const sink = await provision("sink", CONSUMER);
      const install = async (machineId: string, plugin: typeof provider) => {
        const description = await describe(machineId, plugin.pluginId);
        if (!description.resources) throw new Error("missing proved native resources");
        const { tools, services } = description.resources;
        const resourceBindings = {
          tools: plugin.pluginId === CONSUMER ? { busybox: tools.busybox! } : {},
          services: plugin.pluginId === CONSUMER ? { [SERVICE]: services[SERVICE]! } : {},
          anchors: {},
        };
        await ownerAction(hub(), "engine.jobs.install", {
          machineId,
          pluginId: plugin.pluginId,
          machine: plugin.machine,
          installationRevision: `binding-${sha256(Buffer.from(JSON.stringify(resourceBindings)))}`,
          artifactSha256: plugin.artifactSha256,
          resourceBindings,
        });
        return await waitFor(
          async () => {
            const current = await describe(machineId, plugin.pluginId);
            return current.installation?.ready ? current : false;
          },
          20000,
          20,
        );
      };
      const consent = async (
        machineId: string,
        pluginId: string,
        cap: Cap,
        node: ManifoldRef,
        enabled = true,
      ) => {
        const current = await describe(machineId, pluginId);
        await ownerAction(hub(), "engine.jobs.consent", {
          machineId,
          pluginId,
          installationRevision: current.installation!.revision,
          artifactSha256: current.installation!.artifactSha256,
          cap,
          node: formatManifoldUri(node),
          enabled,
        });
      };
      const providerOperation = {
        kind: "operation" as const,
        machineId: source.machineId,
        operationId: SERVE,
      };
      const readerOperation = {
        kind: "operation" as const,
        machineId: sink.machineId,
        operationId: OPERATION,
      };
      const sourceInstallation = await install(source.machineId, provider);
      await consent(source.machineId, PROVIDER, "machines:run", providerOperation);
      await consent(source.machineId, PROVIDER, "network:host", providerOperation);
      await consent(source.machineId, PROVIDER, "jobs:read", providerOperation);
      await consent(source.machineId, PROVIDER, "locations:write", {
        kind: "location",
        machineId: source.machineId,
        locationId: LOCATION,
      });
      const policy: ServicePolicy = {
        serviceId: SERVICE,
        revision: "1",
        maxConcurrent: 2,
        runtime: {
          scope: "instance",
          pluginId: PROVIDER,
          operationId: SERVE,
          installationRevision: sourceInstallation.installation!.revision,
          artifactSha256: provider.artifactSha256,
          resourceBindingDigest: sourceInstallation.operations![SERVE]!.resourceBindingDigest,
          input: {},
        },
        operations: {
          snapshot: {
            kind: "http-proxy",
            method: "GET",
            path: "/snapshot",
            request: { kind: "none" },
            response: {
              kind: "stream",
              disclosure: "full",
              contentTypes: ["application/json"],
              headers: [],
            },
            timeoutMs: 5000,
            maxRequestBytes: 1024,
            maxResponseBytes: 4096,
          },
        },
      };
      const configured = InstanceServiceDescriptionSchema.parse(
        await ownerAction(hub(), "engine.services.configureInstance", {
          serviceId: SERVICE,
          expectedRevision: null,
          machineId: source.machineId,
          policy,
          enabled: true,
        }),
      );
      const ready = (reconnecting = false) =>
        waitFor(
          async () => {
            const state = await instance();
            if (!reconnecting && state.state === "unavailable")
              throw new Error(`instance service unavailable: ${state.reason}`);
            return state.state === "ready" ? state : false;
          },
          20000,
          20,
        ).catch(async (error) => {
          throw new Error(
            `instance readiness failed: ${JSON.stringify(await instance())}; runs: ${JSON.stringify(
              await ownerAction(hub(), "engine.jobs.listRuns", {
                machineId: source.machineId,
                pluginId: PROVIDER,
                limit: 2,
              }),
            )}`,
            { cause: error },
          );
        });
      await ready();
      await install(sink.machineId, consumer);
      await consent(sink.machineId, CONSUMER, "machines:run", readerOperation);
      await consent(sink.machineId, CONSUMER, "network:host", readerOperation);
      await consent(sink.machineId, CONSUMER, "jobs:read", readerOperation);
      const caller = await mintToken(hub(), {
        principal: { name: "scoped consumer", kind: "agent" },
        caps: ["machines:run", "network:host", "services:invoke", "jobs:read"],
      });
      const execute = async (jobId: string) => {
        const outcome = await callAction(hub(), caller.token, "engine.jobs.execute", {
          jobId,
          machineId: sink.machineId,
          pluginId: CONSUMER,
          operationId: OPERATION,
          input: {},
          outputs: [],
          limits,
        });
        if (!outcome.ok) throw new Error(`consumer action refused: ${outcome.denial.message}`);
        return PublicJobSchema.parse(outcome.result);
      };
      const run = async (jobId: string, allowed = true, starts = 1) => {
        const initial = await execute(jobId);
        if (initial.state === "refused")
          throw new Error(`consumer admission refused: ${JSON.stringify(initial.result)}`);
        const node = {
          kind: "job" as const,
          machineId: sink.machineId,
          operationId: OPERATION,
          jobId,
        };
        const completed = await waitFor(
          async () => {
            const current = PublicJobSchema.parse(
              await ownerAction(hub(), "engine.jobs.status", { node }),
            );
            if (["refused", "interrupted", "cancelled"].includes(current.state))
              throw new Error(`consumer failed: ${JSON.stringify(current.result)}`);
            return current.state === "exited" ? current : false;
          },
          20000,
          20,
        );
        if (allowed) expect(completed.result!.exitCode).toBe(0);
        else expect(completed.result!.exitCode).not.toBe(0);
        const stdout = completed.result!.outputs.find((output) => output.name === "stdout")!;
        const output = JobEventSchema.parse(
          await ownerAction(hub(), "engine.jobs.output", {
            node: { ...node, kind: "output", outputId: stdout.outputId },
            offset: 0,
            maxBytes: limits.outputBytes,
          }),
        );
        if (output.type !== "output") throw new Error("missing consumer output");
        const body = Buffer.from(output.data, "base64").toString();
        if (allowed) expect(JSON.parse(body)).toEqual({ starts, setting: "reviewed" });
        else expect(body).toBe("");
      };
      await run("cross-owner");
      source.agent.proc.kill("SIGKILL");
      await source.agent.proc.exited;
      await waitFor(async () => !(await describe(source.machineId, PROVIDER)).connected, 10000, 20);
      // An unrelated authority change while the transport is absent is not evidence
      // that this retained owner's resources or its scoped service authority changed.
      await mintToken(hub(), {
        principal: { name: "unrelated observer", kind: "agent" },
        caps: ["containers:read"],
      });
      await source.agent.restartTransport("SIGKILL");
      await ready(true);
      await run("transport-recovered");
      const port = hub().port;
      const dataDir = hub().dataDir;
      await hub().stop("SIGKILL");
      server = await startServer({ dataDir, port, env: { MANIFOLD_PLUGIN_DEV_PATHS: "1" } });
      await ready(true);
      await waitFor(
        async () => (await describe(sink.machineId, CONSUMER)).installation?.ready === true,
        20000,
        20,
      );
      expect((await instance()).configuration!.revision).toBe(configured.configuration!.revision);
      await run("hub-recovered");
      const denial = GrantSchema.parse(
        await ownerAction(hub(), "core.access.grant", {
          principal: { kind: "principal", id: caller.principal.id },
          caps: ["services:invoke"],
          effect: "deny",
          reach: "node",
          node: formatManifoldUri({
            kind: "service",
            machineId: source.machineId,
            serviceId: SERVICE,
            operationId: "snapshot",
          }),
        }),
      );
      await run("revoked-consumer", false);
      expect((await instance()).state).toBe("ready");
      const disabling = InstanceServiceDescriptionSchema.parse(
        await ownerAction(hub(), "engine.services.configureInstance", {
          serviceId: SERVICE,
          expectedRevision: configured.configuration!.revision,
          machineId: source.machineId,
          policy,
          enabled: false,
        }),
      );
      expect(disabling.state).toBe("stopping");
      const stopped = await waitFor(async () => {
        const current = await instance();
        return current.state === "stopped" ? current : false;
      }, 20000, 20);
      const replaced = InstanceServiceDescriptionSchema.parse(
        await ownerAction(hub(), "engine.services.configureInstance", {
          serviceId: SERVICE,
          expectedRevision: stopped.configuration!.revision,
          machineId: source.machineId,
          policy,
          enabled: true,
        }),
      );
      await ready(true);
      await ownerAction(hub(), "core.access.revokeGrant", { grantId: denial.id });
      const stale = await callAction(hub(), caller.token, "engine.jobs.execute", {
        jobId: "old-resource-binding",
        machineId: sink.machineId,
        pluginId: CONSUMER,
        operationId: OPERATION,
        input: {},
        outputs: [],
        limits,
      });
      expect(stale.ok).toBe(false);
      await install(sink.machineId, consumer);
      for (const cap of ["machines:run", "network:host", "jobs:read"] as const)
        await consent(sink.machineId, CONSUMER, cap, readerOperation);
      await run("registry-replaced", true, 2);
      await ownerAction(hub(), "engine.services.configureInstance", {
        serviceId: SERVICE,
        expectedRevision: replaced.configuration!.revision,
        machineId: source.machineId,
        policy,
        enabled: false,
      });
      await waitFor(async () => (await instance()).state === "stopped", 20000, 20);
    } catch (error) {
      throw e2eFailure(error, [server, ...agents]);
    } finally {
      try {
        await stopProcesses(agents);
      } finally {
        for (const owner of owners) {
          if (owner.exitCode === null) owner.kill("SIGTERM");
          // Real child reaping needs bounded wall time; a fake clock cannot terminate a Linux process.
          if (
            !(await Promise.race([
              owner.exited.then(() => true),
              Bun.sleep(5000).then(() => false),
            ]))
          )
            owner.kill("SIGKILL");
          await owner.exited;
        }
        try {
          await stopProcesses([server]);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  },
  120000,
);
