import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  formatManifoldUri,
  JobEventSchema,
  JobDescriptionSchema,
  JobResultSchema,
  PublicJobSchema,
  MachineHalfSchema,
  PluginBundleSchema,
  type Cap,
  type ManifoldRef,
} from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import {
  connect,
  createContainer,
  enrollMachine,
  isMachineOnline,
  ownerAction,
  startAgent,
  startServer,
  waitFor,
  type TestAgent,
  type TestServer,
} from "../src/index.ts";
import { e2eFailure, stopProcesses } from "./helpers.ts";

const REPO = resolve(import.meta.dir, "../../..");
const PLUGIN = "fixture.jobs";
const OPERATION = `${PLUGIN}.run`;
const LOCATION = `${PLUGIN}.witness`;

const required = [
  "MANIFOLD_TEST_BWRAP",
  "MANIFOLD_TEST_STATIC_BUSYBOX",
  "MANIFOLD_TEST_CGROUP",
] as const;
const realBackend =
  process.platform === "linux" && required.every((name) => Boolean(process.env[name]));

// The ordinary cross-platform gate skips unavailable Linux fixtures. Mandatory verify:jobs
// provisions a private delegated unit and hard-fails missing prerequisites before running this.
// Run alone within that unit: no service/owner objects, forged messages, journal seeds or network overrides.
test.skipIf(!realBackend)(
  "real machine jobs enforce consent, execute once across transport replacement, and fence queued revocation",
  async () => {
    const bubblewrap = realpathSync(process.env.MANIFOLD_TEST_BWRAP!);
    const busybox = realpathSync(process.env.MANIFOLD_TEST_STATIC_BUSYBOX!);
    const delegatedCgroup = realpathSync(process.env.MANIFOLD_TEST_CGROUP!);
    const root = mkdtempSync(join(tmpdir(), "manifold-jobs-e2e-"));
    const control = join(root, "control");
    const state = join(control, "state");
    const workspace = join(root, "workspace");
    const witness = join(workspace, "witness");
    for (const path of [control, state, join(state, "artifacts"), workspace, witness])
      mkdirSync(path, { mode: 0o700 });
    const socket = join(control, "owner.sock");
    const config = join(control, "owner.json");
    const startsPath = join(witness, "starts");
    const starts = () =>
      existsSync(startsPath) ? readFileSync(startsPath, "utf8").trimEnd().split("\n") : [];
    let server: TestServer | undefined;
    let agent: TestAgent | undefined;
    let owner: Bun.Subprocess<"ignore", "ignore", "ignore"> | undefined;
    let client: SessionClient | undefined;
    try {
      server = await startServer({
        dataDir: join(control, "hub"),
        env: { MANIFOLD_PLUGIN_DEV_PATHS: "1" },
      });
      const hub = server;
      const container = await createContainer(hub, "Job acceptance");
      const sdk = await connect(hub, { containerId: container.id, token: hub.ownerKey });
      client = sdk;
      const enrollment = await enrollMachine(hub, "jobs-acceptance");
      const machineId = enrollment.machineId;
      const limits = {
        timeoutMs: 30_000,
        memoryBytes: 128 * 1024 * 1024,
        processes: 32,
        outputBytes: 1024,
      };
      // The witness is a separately consented writable location, not a runtime test seam.
      // Every actual executable start appends before doing anything else; the parent owns the gate.
      const executable = Buffer.from(
        [
          "#!/bin/busybox sh",
          'printf "%s\\n" "$1" >> /home/job/witness/starts',
          "while test ! -f /home/job/witness/release; do /bin/busybox sleep 0.02; done",
          'printf \'{"kind":"fixture.result/1","value":42}\\n\'',
          "printf diagnostic >&2",
          "exit 7",
          "",
        ].join("\n"),
      );
      const sha256 = createHash("sha256").update(executable).digest("hex");
      writeFileSync(join(state, "artifacts", `${sha256}-${sha256}`), executable, { mode: 0o500 });
      const machine = MachineHalfSchema.parse({
        artifacts: {
          [`linux-${process.arch}`]: {
            url: "https://example.invalid/fixture",
            sha256,
            format: "raw",
            entry: ["fixture"],
            entrySha256: sha256,
            maxBytes: executable.length,
            maxExpandedBytes: executable.length,
            maxMembers: 1,
          },
        },
        locations: {
          [LOCATION]: {
            anchor: "data",
            components: ["witness"],
            revision: "r1",
            kind: "directory",
            guestPath: "/home/job/witness",
          },
        },
        operations: {
          [OPERATION]: {
            argv: [{ input: "label" }],
            input: { label: { type: "string", required: true, maxLength: 64 } },
            runtimeTools: ["busybox"],
            locations: [{ locationId: LOCATION, access: "write" }],
            outputs: [],
            network: "none",
            limits,
            stdin: false,
          },
        },
      });
      // Install a real pinned plugin manifest before its machine half: the hub requires equality
      // with a loaded declaration. This web-only module is never loaded by a browser.
      const bundle = Buffer.from(
        JSON.stringify(
          PluginBundleSchema.parse({
            format: 1,
            manifest: {
              id: PLUGIN,
              version: "1.0.0",
              title: "Job acceptance",
              description: "Private offline fixture",
              capabilities: [],
              contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
              entry: { web: "web.js" },
              machine,
            },
            files: {
              "web.js": Buffer.from(
                `export default { id: ${JSON.stringify(PLUGIN)}, panels: {} };`,
              ).toString("base64"),
            },
          }),
        ),
      );
      const bundlePath = join(control, "fixture.json");
      writeFileSync(bundlePath, bundle, { mode: 0o600 });
      await ownerAction(hub, "engine.plugins.install", {
        source: bundlePath,
        sha256: createHash("sha256").update(bundle).digest("hex"),
        hardened: true,
      });
      const installation = {
        machineId,
        pluginId: PLUGIN,
        installationRevision: "r1",
        artifactSha256: sha256,
      };
      await ownerAction(hub, "engine.jobs.install", { ...installation, machine });
      const operation: ManifoldRef = { kind: "operation", machineId, operationId: OPERATION };
      const location: ManifoldRef = { kind: "location", machineId, locationId: LOCATION };
      const consent = async (cap: Cap, enabled: boolean, node: ManifoldRef = operation) => {
        await ownerAction(hub, "engine.jobs.consent", {
          ...installation,
          cap,
          enabled,
          node: formatManifoldUri(node),
        });
      };
      const execute = async (jobId: string) => {
        const outcome = await sdk.action("engine.jobs.execute", {
          jobId,
          machineId,
          pluginId: PLUGIN,
          operationId: OPERATION,
          input: { label: jobId },
          outputs: [],
          limits,
        });
        if (!outcome.ok) throw new Error(`job action refused: ${outcome.denial.message}`);
        return PublicJobSchema.parse(outcome.result);
      };
      const node = (jobId: string) => ({
        kind: "job" as const,
        machineId,
        operationId: OPERATION,
        jobId,
      });
      const status = async (jobId: string) =>
        PublicJobSchema.parse(await ownerAction(hub, "engine.jobs.status", { node: node(jobId) }));
      await consent("jobs:read", true);
      await consent("locations:write", true, location);
      expect((await execute("denied")).state).toBe("refused");
      expect(starts()).toEqual([]);

      // Queue while the enrolled machine is offline, revoke, THEN start the real owner/channel.
      // No races or sleeps decide whether revocation wins the pre-start boundary.
      await consent("machines:run", true);
      expect((await execute("revoked-before-start")).state).toBe("queued");
      await consent("machines:run", false);
      expect((await status("revoked-before-start")).state).toBe("queued");
      expect(starts()).toEqual([]);

      // Bootstrap the remote owner's verifier through ordinary authenticated inspection.
      const { admissionPublicKey } = JobDescriptionSchema.parse(
        await ownerAction(hub, "engine.jobs.describe", { machineId, pluginId: PLUGIN }),
      );
      writeFileSync(
        config,
        JSON.stringify({
          machineId,
          admissionPublicKey,
          stateDirectory: state,
          delegatedCgroup,
          bubblewrap,
          protectedDirectories: [control],
          anchors: { data: workspace },
          runtimeTools: { busybox: [{ source: busybox, target: "/bin/busybox", kind: "file" }] },
          artifactOrigins: ["https://example.invalid"],
        }),
        { mode: 0o600 },
      );
      owner = Bun.spawn([process.execPath, "packages/agent/src/main.ts", "--job-owner"], {
        cwd: REPO,
        env: {
          ...process.env,
          MANIFOLD_JOB_OWNER_SOCKET: socket,
          MANIFOLD_JOB_OWNER_CONFIG: config,
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      const child = owner;
      await waitFor(
        () => {
          if (child.exitCode !== null)
            throw new Error(`real job owner exited before readiness: ${child.exitCode}`);
          return existsSync(socket);
        },
        20_000,
        20,
      );
      agent = await startAgent({
        serverUrl: hub.url,
        machineToken: enrollment.machineToken,
        name: "jobs-acceptance",
        env: { MANIFOLD_JOB_OWNER_SOCKET: socket },
      });
      expect(agent.machineId).toBe(machineId);
      await waitFor(
        async () => (await status("revoked-before-start")).state === "refused",
        20_000,
        20,
      );
      expect(starts()).toEqual([]);
      // Re-enable cannot resurrect either permanently refused identity.
      await consent("machines:run", true);
      await execute("once");
      await waitFor(() => starts().includes("once"), 20_000, 20);
      expect(starts()).toEqual(["once"]);
      expect((await status("denied")).state).toBe("refused");
      expect((await status("revoked-before-start")).state).toBe("refused");

      // Deliver the same action identity again while the executable waits, then replace only
      // transport with SIGKILL. The job owner and workload must survive without a second start.
      await execute("once");
      await agent.restartTransport("SIGKILL");
      await waitFor(() => isMachineOnline(hub, machineId), 10_000, 20);
      await execute("once");
      expect(starts()).toEqual(["once"]);
      writeFileSync(join(witness, "release"), "release", { mode: 0o600 });
      const completed = await waitFor(
        async () => {
          const job = await status("once");
          if (job.state === "exited") return job;
          if (["refused", "interrupted", "cancelled"].includes(job.state))
            throw new Error(`real job failed: ${JSON.stringify(job.result)}`);
          return false;
        },
        20_000,
        20,
      );
      const result = JobResultSchema.parse(completed.result);
      expect(result.exitCode).toBe(7);
      expect(result.usage!.outputBytes).toBeLessThanOrEqual(limits.outputBytes);
      const readOutput = async (name: "stdout" | "stderr") => {
        const output = result.outputs.find((value) => value.name === name);
        if (!output) throw new Error(`missing sealed ${name}`);
        const chunks: Buffer[] = [];
        let offset = 0;
        for (let index = 0; index < 128; index++) {
          const event = JobEventSchema.parse(
            await ownerAction(hub, "engine.jobs.output", {
              node: { ...node("once"), kind: "output", outputId: output.outputId },
              offset,
              maxBytes: 8,
            }),
          );
          if (event.type !== "output") throw new Error(`unexpected output response: ${event.type}`);
          expect(event.jobId).toBe("once");
          expect(event.outputId).toBe(output.outputId);
          const bytes = Buffer.from(event.data, "base64");
          expect(bytes.length).toBeLessThanOrEqual(8);
          chunks.push(bytes);
          offset += bytes.length;
          expect(offset).toBeLessThanOrEqual(limits.outputBytes);
          if (event.eof) {
            const all = Buffer.concat(chunks);
            expect(all.length).toBe(output.bytes);
            expect(createHash("sha256").update(all).digest("hex")).toBe(output.sha256);
            return all.toString("utf8");
          }
          if (!bytes.length) throw new Error("output read made no progress");
        }
        throw new Error("bounded output read did not reach EOF");
      };
      const payload = z
        .strictObject({ kind: z.literal("fixture.result/1"), value: z.number().int() })
        .parse(JSON.parse(await readOutput("stdout")));
      expect(payload.value).toBe(42);
      expect(await readOutput("stderr")).toBe("diagnostic");
      expect((await execute("once")).result).toEqual(result);
      await agent.restartTransport("SIGKILL");
      expect((await status("once")).result).toEqual(result);
      expect(starts()).toEqual(["once"]);
    } catch (error) {
      throw e2eFailure(error, [server, agent]);
    } finally {
      client?.close();
      try {
        await stopProcesses([agent]);
      } finally {
        try {
          if (owner && owner.exitCode === null) {
            owner.kill("SIGTERM");
            // A real supervised process needs a bounded grace period; fake time cannot reap it.
            const exited = await Promise.race([
              owner.exited.then(() => true),
              Bun.sleep(5000).then(() => false),
            ]);
            if (!exited) {
              owner.kill("SIGKILL");
              await owner.exited;
            }
          }
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
  120_000,
);
