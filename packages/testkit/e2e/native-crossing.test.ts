import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  canonicalJobJson,
  formatManifoldUri,
  JobDescriptionSchema,
  MachineHalfSchema,
  MAX_JOB_INSTALL_FRAME_BYTES,
  PluginBundleSchema,
  PROTOCOL_VERSION,
  PublicJobSchema,
  type Cap,
} from "@manifold/protocol";
import {
  enrollMachine,
  ownerAction,
  startAgent,
  startServer,
  waitFor,
  type TestAgent,
  type TestServer,
} from "../src/index.ts";
import { e2eFailure, stopProcesses } from "./helpers.ts";

const REPO = resolve(import.meta.dir, "../../..");
const PLUGIN = "fixture.crossing";
const OPERATION = `${PLUGIN}.run`;
/** An owner seat drops once its outbound queue passes two install frames. */
const OWNER_SEAT_QUEUE_BYTES = 2 * MAX_JOB_INSTALL_FRAME_BYTES;
const required = ["MANIFOLD_TEST_BWRAP", "MANIFOLD_TEST_STATIC_BUSYBOX", "MANIFOLD_TEST_CGROUP"];
const realBackend =
  process.platform === "linux" && required.every((name) => Boolean(process.env[name]));
// A deployed release can stand in for this tree's agent: point either root at its checkout, with
// its dependencies installed, to rerun this proof against the owner or transport it ships.
const ownerRoot = process.env.MANIFOLD_TEST_OWNER_ROOT ?? REPO;
const transportRoot = process.env.MANIFOLD_TEST_TRANSPORT_ROOT ?? REPO;

/*
  THE PROTOCOL-57 CROSSING LOOP (#1068). A staged crossing that acknowledges a changed native
  declaration disables that plugin's native installation, and the hub tells the owner. Every owner
  release so far answers a disable by replaying each retained job of the plugin as an event
  prefixed by its full identity, synchronously: once that burst passes the seat's queue, the owner
  drops the seat, the transport closes 4011 and re-dials, and a hub that re-sends the disable on
  every proof repeats it forever. The owner is never proved and its natives stay unavailable.
  This proof sizes the owner's advertised inventory and its retained jobs past that queue, crosses
  exactly as the deployment does, and requires the owner proved and kept proved after the switch.
*/
test.skipIf(!realBackend)(
  "[real-linux] a native crossing keeps a replaying owner proved after the switch",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "manifold-crossing-e2e-"));
    const control = join(root, "control");
    const credentials = join(root, "credentials");
    for (const path of [control, join(control, "state"), credentials, join(root, "runtime")])
      mkdirSync(path, { mode: 0o700 });
    const dataDir = join(control, "hub");
    const socket = join(control, "owner.sock");
    const config = join(control, "owner.json");
    let server: TestServer | undefined;
    let agent: TestAgent | undefined;
    let owner: Bun.Subprocess<"ignore", "ignore", "ignore"> | undefined;
    const startOwner = async () => {
      const child = Bun.spawn(
        [process.execPath, join(ownerRoot, "packages/agent/src/main.ts"), "--terminal-host"],
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
      owner = child;
      await waitFor(
        () => {
          if (child.exitCode !== null) throw new Error(`job owner exited ${child.exitCode}`);
          return existsSync(socket) && existsSync(`${socket}.terminal`);
        },
        20_000,
        20,
      );
      return child;
    };
    try {
      server = await startServer({ dataDir, env: { MANIFOLD_PLUGIN_DEV_PATHS: "1" } });
      const enrollment = await enrollMachine(server, "crossing");
      const machineId = enrollment.machineId;
      const executable = Buffer.from("#!/bin/busybox sh\nexit 0\n");
      const sha256 = createHash("sha256").update(executable).digest("hex");
      const limits = { timeoutMs: 30_000, memoryBytes: 64 << 20, processes: 8, outputBytes: 1024 };
      const machine = (timeoutMs: number) =>
        MachineHalfSchema.parse({
          artifacts: {
            [`linux-${process.arch}`]: {
              bundleFile: "worker",
              sha256,
              format: "raw",
              entry: ["fixture"],
              entrySha256: sha256,
              maxBytes: executable.length,
              maxExpandedBytes: executable.length,
              maxMembers: 1,
            },
          },
          locations: {},
          operations: {
            [OPERATION]: {
              argv: [{ literal: "run" }],
              input: {},
              runtimeTools: ["busybox"],
              locations: [],
              outputs: [],
              network: "none",
              limits: { ...limits, timeoutMs },
              stdin: false,
            },
          },
        });
      const bundle = (timeoutMs: number, builtAgainst?: Record<string, string>) =>
        Buffer.from(
          JSON.stringify(
            PluginBundleSchema.parse({
              format: 1,
              hardenedContract: 2,
              ...(builtAgainst ? { builtAgainst } : {}),
              manifest: {
                id: PLUGIN,
                version: "1.0.0",
                title: "Crossing fixture",
                description: "Private offline fixture",
                capabilities: [],
                contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
                entry: { web: "web.js" },
                machine: machine(timeoutMs),
              },
              files: {
                worker: executable.toString("base64"),
                "web.js": Buffer.from(
                  `export default { id: ${JSON.stringify(PLUGIN)}, panels: {} };`,
                ).toString("base64"),
              },
            }),
          ),
        );
      const installed = bundle(30_000);
      writeFileSync(join(control, "fixture.json"), installed, { mode: 0o600 });
      await ownerAction(server, "engine.plugins.install", {
        source: join(control, "fixture.json"),
        sha256: createHash("sha256").update(installed).digest("hex"),
        hardened: true,
      });
      const installation = {
        machineId,
        pluginId: PLUGIN,
        installationRevision: "r1",
        artifactSha256: sha256,
      };
      await ownerAction(server, "engine.jobs.install", {
        ...installation,
        machine: machine(30_000),
      });
      const node = formatManifoldUri({ kind: "operation", machineId, operationId: OPERATION });
      for (const cap of ["machines:run", "jobs:read"] satisfies Cap[])
        await ownerAction(server, "engine.jobs.consent", {
          ...installation,
          cap,
          enabled: true,
          node,
        });
      const describe = async () =>
        JobDescriptionSchema.parse(
          await ownerAction(server!, "engine.jobs.describe", { machineId, pluginId: PLUGIN }),
        );
      const { admissionPublicKey } = await describe();
      // Size the identity every owner event carries the way a real node grows it: through its
      // configured credential references, within the owner's 64 KiB configuration bound.
      const serviceCredentials: Record<string, { source: string; origins: string[] }> = {};
      for (let index = 0; index < 64; index++) {
        const ref = `crossing.credential-${index}`;
        writeFileSync(join(credentials, ref), "credential", { mode: 0o600 });
        serviceCredentials[ref] = {
          source: join(credentials, ref),
          origins: Array.from(
            { length: 4 },
            (_, origin) =>
              `https://${[0, 1, 2].map((label) => `c${index}o${origin}l${label}`.padEnd(63, "x")).join(".")}.invalid`,
          ),
        };
      }
      const configuration = JSON.stringify({
        machineId,
        admissionPublicKey,
        stateDirectory: join(control, "state"),
        delegatedCgroup: realpathSync(process.env.MANIFOLD_TEST_CGROUP!),
        bubblewrap: realpathSync(process.env.MANIFOLD_TEST_BWRAP!),
        protectedDirectories: [control],
        anchors: { runtime: join(root, "runtime") },
        runtimeTools: {
          busybox: [
            {
              source: realpathSync(process.env.MANIFOLD_TEST_STATIC_BUSYBOX!),
              target: "/bin/busybox",
              kind: "file",
            },
          ],
        },
        artifactOrigins: ["https://example.invalid"],
        serviceCredentials,
      });
      expect(Buffer.byteLength(configuration)).toBeLessThanOrEqual(65536);
      writeFileSync(config, configuration, { mode: 0o600 });
      const attach = async (host: Bun.Subprocess) => {
        agent = await startAgent({
          serverUrl: server!.url,
          machineToken: enrollment.machineToken,
          name: "crossing",
          env: { MANIFOLD_JOB_OWNER_SOCKET: socket },
          existingHost: { process: host, socketPath: `${socket}.terminal` },
          agentRoot: transportRoot,
        });
        // A transport before #1067 re-proves a restarted owner only from a later hello (#1050).
        for (let attempt = 0; ; attempt++) {
          try {
            await waitFor(async () => (await describe()).connected, 5_000, 100);
            return agent;
          } catch (error) {
            if (attempt === 3) throw error;
            await agent.restartTransport();
          }
        }
      };
      await attach(await startOwner());
      const inventory = await waitFor(
        async () => {
          const { resources } = await describe();
          return resources?.credentialReferences?.length === 64 && resources;
        },
        20_000,
        100,
      );
      // Enough settled jobs that one replay of them passes the owner seat's queue.
      const retained = Math.ceil(
        (OWNER_SEAT_QUEUE_BYTES + (4 << 20)) / Buffer.byteLength(JSON.stringify(inventory)),
      );
      expect(retained).toBeLessThanOrEqual(1000);
      for (let first = 0; first < retained; first += 32)
        await Promise.all(
          Array.from({ length: Math.min(32, retained - first) }, async (_, offset) => {
            const jobId = `retained-${first + offset}`;
            await ownerAction(server!, "engine.jobs.execute", {
              jobId,
              machineId,
              pluginId: PLUGIN,
              operationId: OPERATION,
              input: {},
              outputs: [],
              limits,
            });
            await waitFor(
              async () => {
                const { state } = PublicJobSchema.parse(
                  await ownerAction(server!, "engine.jobs.status", {
                    node: { kind: "job", machineId, operationId: OPERATION, jobId },
                  }),
                );
                if (state === "refused" || state === "interrupted" || state === "cancelled")
                  throw new Error(`${jobId} ${state}`);
                return state === "exited";
              },
              60_000,
              25,
            );
          }),
        );
      // Restarting the owner makes those jobs an earlier generation's: retained, never forgotten.
      await stopProcesses([agent]);
      agent = undefined;
      owner?.kill("SIGTERM");
      await owner?.exited;
      await attach(await startOwner());

      // The crossing, as the deployment runs it: the staged set received into the stopped hub's
      // data, then the switch. Its changed declaration is acknowledged for native review.
      const replacement = bundle(20_000, { "manifold:protocol": String(PROTOCOL_VERSION) });
      const replacementSha256 = createHash("sha256").update(replacement).digest("hex");
      const set = canonicalJobJson({
        format: 1,
        members: [
          {
            pluginId: PLUGIN,
            sha256: replacementSha256,
            url: `https://example.invalid/${PLUGIN}.manifold-plugin.json`,
            nativeReview: true,
          },
        ],
      });
      const staged = join(root, "staged");
      mkdirSync(staged, { mode: 0o700 });
      writeFileSync(join(staged, "set.json"), set, { mode: 0o600 });
      writeFileSync(join(staged, `${replacementSha256}.manifold-plugin.json`), replacement, {
        mode: 0o600,
      });
      const port = server.port;
      await server.stop();
      const receive = Bun.spawn(
        [
          process.execPath,
          "scripts/bundle-replacement.ts",
          "receive",
          staged,
          createHash("sha256").update(set).digest("hex"),
          "c".repeat(40),
          dataDir,
        ],
        { cwd: REPO, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
      );
      if ((await receive.exited) !== 0)
        throw new Error(`receive failed: ${await new Response(receive.stderr).text()}`);
      const switched = Date.now();
      server = await startServer({ dataDir, port, env: { MANIFOLD_PLUGIN_DEV_PATHS: "1" } });
      expect(
        server.output.stdout.some(
          (line) =>
            line.includes('"evt":"plugin_replacement_applied"') &&
            line.includes(`"nativeReview":["${PLUGIN}"]`),
        ),
      ).toBe(true);

      // The crossing's disable may cost an owner that still replays one seat; it must then be
      // proved again and stay proved. Real processes re-dial on their own clocks, so staying
      // proved is observed over real time.
      let provedSince: number | null = null;
      await waitFor(
        async () => {
          if (!(await describe()).connected) provedSince = null;
          else provedSince ??= Date.now();
          return provedSince !== null && Date.now() - provedSince >= 10_000;
        },
        45_000,
        200,
      );
      expect((await describe()).installation).toMatchObject({ revision: "r1", enabled: false });
      // At most the one replay the crossing's disable costs an owner that still replays.
      const seatLosses = agent!.output.stdout.filter(
        (line) =>
          line.includes('"reason":"job owner unavailable"') &&
          Number(/"ts":(\d+)/.exec(line)?.[1]) >= switched,
      );
      expect(seatLosses.length).toBeLessThanOrEqual(1);
    } catch (error) {
      throw e2eFailure(error, [server, agent]);
    } finally {
      try {
        await stopProcesses([agent]);
      } finally {
        try {
          owner?.kill("SIGTERM");
          await owner?.exited;
        } finally {
          try {
            await stopProcesses([server]);
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        }
      }
    }
  },
  180_000,
);
